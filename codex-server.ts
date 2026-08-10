#!/usr/bin/env bun
// codex-server.ts
// Durable polling MCP stdio server for Codex CLI and Hermes Agent.
// Defaults to peer_type="codex"; hermes-server.ts selects peer_type="hermes".
//
// DELIVERY PIPELINE — two layers with a strict division of labor, driven
// by one invariant: no message is acked to the broker (nor pruned from
// the durable queue) until we have evidence the previous tool-response
// cycle actually completed. That evidence is "Codex called us again."
//
//   Layer 1 — Durable on-disk inbox at ~/.agent-peers-codex/<peer-id>.json
//   ------------------------------------------------------------------
//   Background poll (POLL_INTERVAL_MS) writes newly-leased messages here.
//   This is the authoritative persistence layer: messages survive MCP
//   restart within the 60s reclaim window, and nothing gets pruned until
//   we're sure the model actually saw it. File perms hardened to 0o600
//   (dir 0o700) to match the broker's DB trust boundary (see
//   broker.ts enforceDbFilePerms).
//
//   Layer 2 — Authoritative piggyback [PEER INBOX] on tool call
//   ------------------------------------------------------------------
//   withPiggyback is the ONLY path that surfaces message CONTENT + reply
//   cues to the model. It reads (not consumes) from the durable queue,
//   filters out messages already confirmed delivered, and prepends what's
//   left as a [PEER INBOX] block in the tool response.
//
//   Signal-only preview push (notifications/message)
//   ------------------------------------------------------------------
//   A best-effort MCP log notification fires after each background poll
//   that landed new messages in the queue. It carries ONLY the sender's
//   name + peer_type and a pointer to the next tool call — no body, no
//   reply_action. This gives recent Codex CLI versions a "new message
//   from X arrived, look at your inbox" signal in the live transcript
//   without duplicating the authoritative delivery. It does NOT update
//   any dedupe state — the [PEER INBOX] block (Layer 2) is the one and
//   only "this was shown to the model" trigger.
//
// DEDUPE STATE MACHINE (two sets, confirm-on-next-call):
//
//   - `presentedPendingConfirm` — message_ids included in the CURRENT
//     tool response's [PEER INBOX] block but not yet known-delivered.
//     Populated inside withPiggyback just before return.
//
//   - `seen` — message_ids we're SURE reached the model. Populated at
//     the START of the NEXT tool call (Codex calling us again is the
//     evidence that the previous response cycle landed). Once a message
//     is `seen`, we ack its lease, prune it from the durable queue, and
//     ignore any future re-delivery of the same id.
//
// This splits what was previously a single `seen` set that conflated
// "about to be shown" with "known shown." The earlier code could ack +
// prune a message whose response was aborted before reaching Codex —
// silent loss. The split closes that race: a dropped response leaves the
// message in the durable queue AND outside the `seen` set, so on the
// next tool call (or the next session after a restart) it re-surfaces.
// At-least-once per spec §5.4.
//
// Shutdown: clear timers and exit. Deliberately do NOT flush pendingAcks
// (those messages may not have reached Codex yet — flushing on exit would
// be silent loss). Deliberately do NOT unregister (preserves
// reclaim-by-name). Durable queue stays on disk so a restart within the
// 60s reclaim window picks up exactly where this session left off.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient } from "./shared/broker-client.ts";
import { ensureBroker } from "./shared/ensure-broker.ts";
import { waitForSharedSecret } from "./shared/shared-secret.ts";
import { getGitRoot, getTty } from "./shared/peer-context.ts";
import { getGitBranch, getRecentFiles, generateSummary } from "./shared/summarize.ts";
import { setTabTitle, clearTabTitle, clearTabTitleSync, startTabTitleKeepalive } from "./shared/tab-title.ts";
import { decideWakeLaunchRole, isWakeLaunchEnv, shouldRegisterAsPeer } from "./shared/wake-launch-role.ts";
import { formatInboxBlock, formatInboxPreview } from "./shared/piggyback.ts";
import { CodexInboxStore } from "./shared/codex-inbox.ts";
import { isValidName } from "./shared/names.ts";
import { COLLEAGUE_PROTOCOL } from "./shared/colleague-prompt.ts";
import { planWaitForPeerMessages, waitForFreshPeerMessages as waitForFreshPeerMessagesLoop } from "./shared/wait-for-peer-messages.ts";
import { createAsyncLock } from "./shared/async-lock.ts";
import { HermesNameClaims } from "./shared/hermes-claims.ts";
import { WakeRegistry, hashBrokerSessionToken } from "./shared/wake-registry.ts";
import { WakeLaunchClaimStore, type CompleteWakeLaunchClaim } from "./shared/wake-launch-claims.ts";
import { parentProcessWasLost } from "./shared/process-lifecycle.ts";
import type { PeerId, LeasedMessage, PeerType } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.AGENT_PEERS_HEARTBEAT_MS ?? "15000", 10);
const RUNTIME_PEER_TYPE: PeerType = process.env.AGENT_PEERS_RUNTIME === "hermes" ? "hermes" : "codex";
const RUNTIME_DISPLAY_NAME = RUNTIME_PEER_TYPE === "hermes" ? "Hermes" : "Codex";
const RUNTIME_IS_CODEX = RUNTIME_PEER_TYPE === "codex";
// Hermes surfaces are per-turn processes that are never wakeable, so the
// Codex-grade 5-minute wait is always wrong there: it pins the turn "working"
// and the surface may be torn down before the wait ends. 60s is the ceiling.
const WAIT_FOR_MESSAGES_DEFAULT_MS = RUNTIME_PEER_TYPE === "hermes" ? 60_000 : 300_000;
const WAIT_FOR_MESSAGES_MAX_MS = RUNTIME_PEER_TYPE === "hermes" ? 60_000 : 300_000;
const WAIT_FOR_MESSAGES_POLL_MS = 500;

function log(msg: string) {
  console.error(`[agent-peers/${RUNTIME_PEER_TYPE}] ${msg}`);
}

let client: ReturnType<typeof createClient>;
async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

let myId: PeerId | null = null;
let myName: string | null = null;
let mySession: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
let inboxStore: CodexInboxStore | null = null;
let pollInFlight: Promise<void> | null = null;
// True once this MCP has registered the session in the wake registry, i.e. an
// external wake daemon can start a fresh turn the instant mail arrives. In that
// mode `wait_for_peer_messages` is pointless (and actively harmful — it pins the
// turn "working" for up to 5 minutes, so the session LOOKS hung between peer
// pings). We short-circuit it to a no-op for wakeable sessions; see the
// wait_for_peer_messages handler.
let isWakeableSession = false;

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    // `logging: {}` enables MCP `notifications/message`. Current (v0.120)
    // Codex CLI does NOT surface these to the model — confirmed via the
    // official docs at github.com/openai/codex/docs/config.md which list
    // only `tools` as a supported MCP feature. We keep the capability +
    // keep sending the preview pushes as future-compatible plumbing, but
    // the authoritative delivery channel is the [PEER INBOX] block in
    // tool responses (Codex's only MCP input surface). The prompt above
    // instructs Codex to call `check_messages` at the start of every
    // user turn to keep delivery latency bounded by one user turn
    // instead of "until Codex happens to call an agent-peers tool."
    capabilities: { logging: {}, tools: {} },
    instructions: `${COLLEAGUE_PROTOCOL}

DELIVERY ON THIS SIDE (${RUNTIME_DISPLAY_NAME}) — READ CAREFULLY, THIS IS LOAD-BEARING:

${RUNTIME_IS_CODEX ? "The current Codex CLI does NOT surface mid-task MCP push notifications" : "Do not assume this Hermes session will surface MCP messages while the agent is idle"}
to the model. That means you do not see peer messages the instant they
arrive — you only see them when YOU call an agent-peers tool. A peer
can send you a DM at 10:00; if you don't touch agent-peers until 10:20,
you won't know about it until 10:20. This is a hard constraint of the
Codex runtime, not a bug in this server.

RULE: Call \`check_messages\` as the FIRST thing you do every time the
user sends you a message. It is one cheap tool call. It surfaces any
pending peer inbox as a \`[PEER INBOX]\` block prepended to the
response. Without this habit, peer messages pile up for minutes or
hours before you notice them — and the "colleague" experience
collapses into "broken chat."

Exceptions: you do NOT need to call \`check_messages\` before:
  - calling another agent-peers tool in the same turn (they all surface
    the inbox too — \`list_peers\`, \`send_message\`, \`set_summary\`,
    and \`rename_peer\` all prepend \`[PEER INBOX]\` if there is one)
  - running a long sequence of file-editing / shell tools where you
    have no reason to expect a peer interaction. Even then, call
    \`check_messages\` again at the start of the next user turn.

If the user asks you to stand by for peer collaboration in a NON-wakeable
session, call \`wait_for_peer_messages\` with a bounded timeout. It keeps
this same Codex turn alive until messages arrive or the timeout expires; it
is not the same as waking a fully idle session.

If this is a WAKEABLE Codex session (launched through the transparent
app-server-backed Codex path — an external
daemon starts a fresh turn the instant a peer message arrives), do NOT call
\`wait_for_peer_messages\` to await a reply: just finish your turn and go
idle. The daemon wakes you on arrival. Blocking would only pin this turn
"working" for minutes and make the session look hung. (As a safety net the
server short-circuits \`wait_for_peer_messages\` to return immediately for
wakeable sessions, but the right habit is simply not to call it.)

DELIVERY CHANNELS:

  1. \`[PEER INBOX]\` block prepended to ANY agent-peers tool response.
     This is the AUTHORITATIVE delivery — full message body, sender
     identity, reply instructions. When you see it, apply the REACTIVE
     rules above.

  2. A best-effort MCP \`notifications/message\` log push also fires
     on each background poll tick. Treat the [PEER INBOX] block as the
     authoritative input regardless of whether ${RUNTIME_DISPLAY_NAME}
     surfaces that notification.`,
  },
);

const TOOLS = [
  {
    name: "list_peers",
    description: "List other AI agent peers on this machine.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: { type: "string" as const, enum: ["machine", "directory", "repo"] },
        peer_type: { type: "string" as const, enum: ["claude", "codex", "hermes"] },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description: "Send a message to a peer (to_id accepts UUID or name).",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const },
        message: { type: "string" as const },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description: "Set a 1-2 sentence summary of current work.",
    inputSchema: {
      type: "object" as const,
      properties: { summary: { type: "string" as const } },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      `Surface peer messages waiting in the inbox. Call this at the START of every user turn — ${RUNTIME_DISPLAY_NAME} receives authoritative message content through an agent-peers tool response. One cheap call.`,
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "wait_for_peer_messages",
    description:
      `Stand by for incoming peer messages for up to timeout_ms, then surface them through the normal [PEER INBOX] tool-response path. This keeps this same ${RUNTIME_DISPLAY_NAME} turn alive; it is not a fully idle wake mechanism. In a wakeable Codex session this returns immediately; otherwise it performs a bounded wait.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        timeout_ms: {
          type: "number" as const,
          minimum: 0,
          maximum: WAIT_FOR_MESSAGES_MAX_MS,
          description: `Maximum time to wait, in milliseconds (default and max: ${WAIT_FOR_MESSAGES_MAX_MS}).`,
        },
        from: {
          type: "string" as const,
          description:
            "Optional sender filter: a peer name or id. The wait completes only when a message " +
            "from THIS sender arrives; unrelated messages still surface in [PEER INBOX] but do " +
            "not end the wait. Without this, the next message from ANY sender ends the wait.",
        },
      },
    },
  },
  {
    name: "rename_peer",
    description: "Rename YOURSELF. 1-32 chars, [a-zA-Z0-9_-].",
    inputSchema: {
      type: "object" as const,
      properties: { new_name: { type: "string" as const } },
      required: ["new_name"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

const MAX_PENDING_ACKS = 500;
const pendingAcks: string[] = [];

// Dedupe state (see top-of-file state-machine comment):
//   - `presentedPendingConfirm`: messages in the CURRENT response's
//     [PEER INBOX] block. Promoted to `seen` at the START of the NEXT call.
//   - `seen`: messages we are SURE reached the model. Only these get their
//     lease acked + are pruned from the durable queue.
const presentedPendingConfirm = new Set<number>();
const seen = new Set<number>();

function enqueueAck(token: string) {
  pendingAcks.push(token);
  if (pendingAcks.length > MAX_PENDING_ACKS) {
    const drop = pendingAcks.length - MAX_PENDING_ACKS;
    pendingAcks.splice(0, drop);
    log(`pendingAcks trimmed: dropped ${drop} oldest token(s); exceeding cap ${MAX_PENDING_ACKS}`);
  }
}

async function waitForFreshPeerMessages(timeoutMs: number, from?: string): Promise<boolean> {
  return waitForFreshPeerMessagesLoop({
    timeoutMs,
    pollIntervalMs: WAIT_FOR_MESSAGES_POLL_MS,
    poll: pollBrokerIntoQueue,
    readUnread: async () => inboxStore ? inboxStore.getUnreadMessages() : [],
    // The sender filter governs only what ENDS the wait. Non-matching mail
    // stays queued and still surfaces in this response's [PEER INBOX] block —
    // it is never consumed by a wait it didn't satisfy (known-issues
    // 2026-08-08 §1: Marco's wait for Kepler ate an unrelated Vector message).
    isFresh: (m) =>
      !seen.has(m.id) &&
      !presentedPendingConfirm.has(m.id) &&
      (!from || m.from_id === from || m.from_name === from),
    onError: (message) => log(`wait_for_peer_messages ${message}`),
  });
}

async function pollBrokerIntoQueue(): Promise<void> {
  if (!myId || !mySession || !inboxStore) return;
  if (pollInFlight) {
    await pollInFlight;
    return;
  }

  pollInFlight = (async () => {
    let leased: LeasedMessage[] = [];
    try {
      leased = await client.pollMessages({ id: myId!, session_token: mySession! });
    } catch (e) {
      log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (leased.length === 0) return;

    // Triage leased messages by dedupe state.
    const freshlyUnread: LeasedMessage[] = [];
    for (const message of leased) {
      if (seen.has(message.id)) {
        // We're certain the model saw this one already (previous tool
        // call's piggyback, confirmed by the call after). The lease just
        // got re-offered because our earlier ack was lost or the lease
        // expired before ack. Close it now — this is safe because the
        // model-delivery evidence is already in hand.
        enqueueAck(message.lease_token);
      } else if (presentedPendingConfirm.has(message.id)) {
        // We drew this into the CURRENT response's [PEER INBOX] block but
        // haven't yet seen the next tool call that would confirm
        // delivery. DO NOT ack (would silently drop if the response was
        // lost). DO NOT re-queue in the durable inbox (would make the
        // piggyback double-surface it within the same call). Just stash
        // the new lease token so next-call confirm-flush closes both old
        // + new leases atomically.
        enqueueAck(message.lease_token);
      } else {
        freshlyUnread.push(message);
      }
    }

    if (freshlyUnread.length === 0) return;

    // Authoritative persistence FIRST — if this fails, we do not push and
    // do not ack; next poll tick retries because the lease will expire at
    // the broker and the message will be re-leased.
    try {
      await inboxStore.queueLeasedMessages(freshlyUnread);
      log(`queued ${freshlyUnread.length} unread peer message(s): ${freshlyUnread.map((msg) => `#${msg.id} from ${msg.from_name}`).join(", ")}`);
    } catch (e) {
      log(`failed to persist unread peer messages: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // Best-effort signal-only preview push. Recent Codex CLI versions
    // surface MCP log notifications into the live transcript — this
    // fires a "heads up, message waiting" nudge so the model can decide
    // whether to interrupt current work or finish first. It carries NO
    // body and NO reply cues; full content + reply_action live in the
    // authoritative [PEER INBOX] block in the next tool response. This
    // split avoids the double-reply risk where the model would see the
    // same message twice (once via log, once via piggyback) and send two
    // replies. Failures are non-fatal — the authoritative path still
    // delivers on the next tool call.
    for (const m of freshlyUnread) {
      try {
        await mcp.notification({
          method: "notifications/message",
          params: {
            level: "info",
            logger: "agent-peers",
            // Intentionally body-free: just the sender's identity + a
            // pointer to where the actual message will appear. No
            // message text. No reply_action. See formatInboxPreview for
            // the rationale and the tests in piggyback.test.ts that
            // guarantee this property.
            data: formatInboxPreview(m),
            _meta: {
              source: "agent-peers",
              signal_only: true,
              message_id: m.id,
              from_id: m.from_id,
              from_name: m.from_name,
              from_peer_type: m.from_peer_type,
              sent_at: m.sent_at,
            },
          },
        });
      } catch (e) {
        log(`preview push failed for msg #${m.id} (non-fatal; tool-call will deliver): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  })();

  try {
    await pollInFlight;
  } finally {
    pollInFlight = null;
  }
}

// Serializes the piggyback read-draw-mark critical section across concurrent
// CallTool requests. Without it, two tools invoked in parallel both run the
// queue read before either marks presentedPendingConfirm — the model sees the
// same message twice in one turn and may reply twice, and both calls enqueue
// the same lease token (bd-21r.3: parallel check_messages + list_peers).
const withPiggybackLock = createAsyncLock();

async function withPiggyback(
  handler: () => Promise<{ text: string; isError?: boolean }>,
  opts: { beforeReadQueue?: () => Promise<void> } = {},
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  if (!myId || !mySession) {
    return {
      content: [{ type: "text", text: "Not registered with broker yet" }],
      isError: true,
    };
  }

  // Pre-draw hook OUTSIDE the lock: wait_for_peer_messages can block for
  // minutes, and holding the lock across it would freeze every other
  // concurrent tool call. The hook only polls the broker into the durable
  // queue and inspects dedupe sets — it never draws or marks, so running it
  // unlocked cannot double-deliver.
  try {
    await opts.beforeReadQueue?.();
  } catch (e) {
    log(`before-read hook failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const fresh = await withPiggybackLock(async () => acquireInboxBatch());

  // Serving-identity delivery breadcrumb (delivery-fix spec §6.4). This is the
  // ONE place a message is handed to the model, so logging the serving identity
  // here makes the wakeable routing bet observable instead of silent. Gated on
  // fresh.length so quiet tool calls stay silent.
  if (fresh.length > 0) {
    const wakeThread = process.env.AGENT_PEERS_WAKE_THREAD_ID;
    log(`delivered ${fresh.length} inbox message(s) as peer=${myName} id=${myId} pid=${process.pid}${wakeThread ? ` wake_thread=${wakeThread}` : ""}`);
  }

  // STEP 4 — Run the tool handler + build the response. Outside the lock:
  // handlers do their own broker I/O and can be slow.
  let toolText = "";
  let toolError: boolean | undefined;
  try {
    const r = await handler();
    toolText = r.text;
    toolError = r.isError;
  } catch (e) {
    toolText = `Tool error: ${e instanceof Error ? e.message : String(e)}`;
    toolError = true;
  }

  const inbox = formatInboxBlock(fresh);
  const finalText = inbox + toolText;
  return { content: [{ type: "text", text: finalText }], isError: toolError };
}

// The locked critical section: ack-flush, confirm-promote, poll, and the
// read-filter-mark draw. Exactly one concurrent tool call can be in here.
async function acquireInboxBatch(): Promise<LeasedMessage[]> {
  // ------------------------------------------------------------------------
  // STEP 1a — Unconditional ack flush.
  //
  // We always attempt to ack every token in pendingAcks, even when
  // presentedPendingConfirm is empty. pollBrokerIntoQueue's seen-branch
  // stashes re-lease tokens for messages we already confirmed delivered
  // — those must be flushed even in tool calls that don't draw any new
  // inbox items, otherwise the broker re-leases the row forever and it
  // never transitions to acked=1 (perpetually-unacked zombie row per
  // codex review PR #2 round 2).
  //
  // Tokens are removed from pendingAcks only on HTTP success; an
  // exception leaves them for the next call to retry. HTTP success with
  // `acked: 0` at the broker (stale tokens) still counts — the next
  // re-lease will land new tokens in pendingAcks via the seen-branch,
  // and this flush will eventually succeed against the current lease.
  if (pendingAcks.length > 0) {
    const toFlush = pendingAcks.slice();
    try {
      const res = await client.ackMessages({
        id: myId!, session_token: mySession!, lease_tokens: toFlush,
      });
      for (const tok of toFlush) {
        const idx = pendingAcks.indexOf(tok);
        if (idx !== -1) pendingAcks.splice(idx, 1);
      }
      // Typed outcomes (no more success-shaped {ok, acked:0} blindness): an
      // expired token means the broker will re-offer that message — expected,
      // the seen-branch will close the re-lease — but it must be VISIBLE.
      if (res.acked < toFlush.length) {
        const stale = res.stale ?? 0;
        const detail = res.results
          ? res.results.filter((r) => r.status !== "acked").map((r) => r.status).join(",")
          : "unreported";
        log(`ack flush: ${res.acked}/${toFlush.length} acked (${stale} expired lease(s); statuses: ${detail}) — broker will re-offer unacked messages`);
      }
    } catch (e) {
      log(`ack flush failed (will retry next call): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------------------
  // STEP 1b — Confirm-promote: items drawn into the PREVIOUS response
  // are now (with Codex calling us again as evidence) known to have
  // reached the model. Prune them from the durable queue and move their
  // ids into `seen`. Pruning can fail independently of the ack above
  // (disk I/O vs broker HTTP); if it does we keep the items in
  // presentedPendingConfirm and retry next call. Partial promotion is
  // not allowed — would re-open the silent-loss window.
  if (presentedPendingConfirm.size > 0) {
    const confirming = [...presentedPendingConfirm];
    try {
      if (inboxStore) await inboxStore.removeByIds(confirming);
      for (const id of confirming) {
        seen.add(id);
        presentedPendingConfirm.delete(id);
      }
    } catch (e) {
      log(`confirm-flush queue-prune failed (will retry next call): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ------------------------------------------------------------------------
  // STEP 2 — Inline poll so we pick up anything that arrived in the last
  // POLL_INTERVAL_MS window. Background loop does the same thing on a
  // timer; calling it here collapses the worst-case "message landed 0.99s
  // before this tool call" tail.
  try {
    await pollBrokerIntoQueue();
  } catch (e) {
    log(`inline poll failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ------------------------------------------------------------------------
  // STEP 3 — Read (do NOT consume) the durable queue. Items stay on disk
  // until the NEXT call's confirm-flush promotes them to `seen` and
  // removes them. A dropped response thus leaves the message in place
  // for re-delivery, fixing the silent-loss race the codex-reviewer bot
  // flagged on PR #2 round 1.
  let queued: LeasedMessage[] = [];
  try {
    queued = inboxStore ? await inboxStore.getUnreadMessages() : [];
  } catch (e) {
    log(`failed to read unread peer messages: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Filter out anything already confirmed delivered (defensive — the
  // durable queue shouldn't contain `seen` ids, but pollBrokerIntoQueue's
  // seen-branch guarantees it) and anything we already drew into an
  // earlier-but-unconfirmed response (presentedPendingConfirm). The
  // latter can happen if the previous call's confirm-flush partially
  // failed above; we want to keep showing the same items until flush
  // succeeds, not start dealing duplicates.
  const fresh: LeasedMessage[] = [];
  for (const m of queued) {
    if (seen.has(m.id)) continue;
    if (presentedPendingConfirm.has(m.id)) {
      // Already showed this in an earlier response whose confirm-flush
      // hasn't completed yet. Skip re-drawing — the earlier presentation
      // is still the one we're waiting to confirm.
      continue;
    }
    fresh.push(m);
  }

  // Mark fresh items as "presented this call, awaiting confirm" and
  // stash their lease tokens for the NEXT call's confirm-flush. This is
  // the single write point where a message transitions from "sitting in
  // queue" to "shown to the model."
  for (const m of fresh) {
    presentedPendingConfirm.add(m.id);
    enqueueAck(m.lease_token);
  }

  // Watermark-prune the `seen` dedupe set (it previously grew forever).
  // Message ids are AUTOINCREMENT-monotonic: anything far below the newest id
  // AND below everything still in the durable queue can never be re-offered
  // in a way this set still needs to dedupe.
  pruneSeenWatermark(queued);

  return fresh;
}

const SEEN_WATERMARK_SLACK = 10_000;

function pruneSeenWatermark(queued: LeasedMessage[]): void {
  if (seen.size === 0) return;
  let maxSeen = 0;
  for (const id of seen) if (id > maxSeen) maxSeen = id;
  let minQueued = Infinity;
  for (const m of queued) if (m.id < minQueued) minQueued = m.id;
  const watermark = Math.min(minQueued, maxSeen - SEEN_WATERMARK_SLACK);
  for (const id of seen) if (id < watermark) seen.delete(id);
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  let waitResult: { didWait: boolean; found: boolean; timeoutMs: number; skippedWakeable?: boolean } | null = null;

  return withPiggyback(async () => {
    switch (name) {
      case "list_peers": {
        const { scope, peer_type } = args as {
          scope: "machine" | "directory" | "repo";
          peer_type?: PeerType;
        };
        const peers = await client.listPeers({
          scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId!, peer_type,
        });
        if (peers.length === 0) {
          return { text: `No other peers found (scope: ${scope}).` };
        }
        const lines = peers.map((p) =>
          [
            `Peer ${p.name} (${p.peer_type})`,
            `  ID: ${p.id}`,
            `  CWD: ${p.cwd}`,
            p.tty ? `  TTY: ${p.tty}` : null,
            p.summary ? `  Summary: ${p.summary}` : null,
            `  Last seen: ${p.last_seen}`,
          ].filter(Boolean).join("\n")
        );
        return { text: `Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}` };
      }

      case "send_message": {
        const { to_id, message } = args as { to_id: string; message: string };
        const res = await client.sendMessage({
          from_id: myId!, session_token: mySession!, to_id_or_name: to_id, text: message,
        });
        if (!res.ok) return { text: `Send failed: ${res.error}`, isError: true };
        return { text: `Message sent (id=${res.message_id}).` };
      }

      case "set_summary": {
        const { summary } = args as { summary: string };
        await client.setSummary({ id: myId!, session_token: mySession!, summary });
        return { text: `Summary set: "${summary}"` };
      }

      case "check_messages": {
        // Piggyback already polled + injected; nothing extra to do.
        return { text: `Checked inbox.` };
      }

      case "wait_for_peer_messages": {
        if (waitResult?.skippedWakeable) {
          // Any messages already in the inbox are surfaced above via [PEER INBOX]
          // (the broker poll ran before this hook). We deliberately did NOT block:
          // this session is registered with the wake daemon, which starts a fresh
          // turn the instant new mail arrives. Blocking here would only freeze the
          // turn "working" for minutes and make the session look hung.
          return {
            text:
              "This is a wakeable session, so wait_for_peer_messages returned immediately " +
              "instead of blocking. You do NOT need to wait for peers: end your turn and go " +
              "idle. The agent-peers wake daemon will start a fresh turn the moment a new peer " +
              "message arrives. (Any messages already waiting are shown above.)",
          };
        }
        if (!waitResult?.didWait) {
          return { text: "wait_for_peer_messages did not run.", isError: true };
        }
        if (waitResult.found) {
          return { text: `Peer message(s) arrived while waiting (${waitResult.timeoutMs}ms timeout).` };
        }
        return { text: `No peer messages arrived within ${waitResult.timeoutMs}ms.` };
      }

      case "rename_peer": {
        const { new_name } = args as { new_name: string };
        if (!isValidName(new_name)) {
          return { text: `Invalid name: must be 1-32 chars, [a-zA-Z0-9_-] only.`, isError: true };
        }
        const res = await client.renamePeer({ id: myId!, session_token: mySession!, new_name });
        if (!res.ok) return { text: `Rename failed: ${res.error}`, isError: true };
        myName = res.name ?? new_name;
        setTabTitle(`peer:${myName}`);
        return { text: `Renamed to ${myName}` };
      }

      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  }, {
    beforeReadQueue: name === "wait_for_peer_messages"
      ? async () => {
          const plan = planWaitForPeerMessages({
            isWakeable: isWakeableSession,
            rawTimeout: (args as { timeout_ms?: unknown } | undefined)?.timeout_ms,
            defaultMs: WAIT_FOR_MESSAGES_DEFAULT_MS,
            maxMs: WAIT_FOR_MESSAGES_MAX_MS,
          });
          // Wakeable sessions get woken on demand by the daemon; blocking here
          // would pin the turn "working" for up to the timeout and make the
          // session look hung. Skip the wait entirely — pending mail is already
          // surfaced by the broker poll that ran before this hook.
          if (plan.kind === "skip-wakeable") {
            log(`wait_for_peer_messages skipped: wakeable session (would have waited ${plan.timeoutMs}ms)`);
            waitResult = { didWait: false, found: false, timeoutMs: plan.timeoutMs, skippedWakeable: true };
            return;
          }
          const from = (args as { from?: unknown } | undefined)?.from;
          const found = await waitForFreshPeerMessages(
            plan.timeoutMs,
            typeof from === "string" && from.length > 0 ? from : undefined,
          );
          waitResult = { didWait: true, found, timeoutMs: plan.timeoutMs };
        }
      : undefined,
  });
});

let wakeRootClaim: CompleteWakeLaunchClaim | null = null;

async function main() {
  const initialParentPid = process.ppid;
  let lifecycleCleanup: (() => Promise<void> | void) | null = null;
  let terminating = false;
  const earlyKillHandler = async () => {
    if (terminating) return;
    terminating = true;
    try {
      if (lifecycleCleanup) await lifecycleCleanup();
    } catch { /* best effort during death */ }
    clearTabTitleSync();
    process.exit(0);
  };
  process.on("SIGINT", earlyKillHandler);
  process.on("SIGTERM", earlyKillHandler);
  process.on("SIGHUP", earlyKillHandler);
  process.on("SIGQUIT", earlyKillHandler);
  process.on("exit", clearTabTitleSync);

  // Bun's stdio transport can remain alive after its app-server parent dies,
  // leaving an orphan that still heartbeats forever. The direct app-server is
  // the MCP session owner: once it reparents to launchd, this session is gone.
  const parentWatch = setInterval(() => {
    if (parentProcessWasLost(initialParentPid, process.ppid)) {
      log(`app-server parent ${initialParentPid} exited; stopping orphaned MCP`);
      void earlyKillHandler();
    }
  }, 1_000);
  lifecycleCleanup = () => clearInterval(parentWatch);

  // Activation gate — matches claude-server. If AGENT_PEERS_ENABLED is not "1",
  // run as a no-op MCP (no broker connection, no tab title). Codex sessions
  // set this via the `env = { "AGENT_PEERS_ENABLED" = "1" }` block in
  // ~/.codex/config.toml.
  if (process.env.AGENT_PEERS_ENABLED !== "1") {
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    await mcp.connect(new StdioServerTransport());
    log("agent-peers disabled (set AGENT_PEERS_ENABLED=1 to activate); idle");
    return;
  }

  // ---- Single-identity election for wakeable launches -------------------
  // The app-server spawns one agent-peers MCP PER CODEX THREAD, and every one
  // of them used to call broker register(), so a single `codexpeer` launch
  // produced N addressable peers (observed: 4 per app-server). Only the child
  // that wins the launcher's single-use claim may take the peer identity; the
  // rest are secondary threads (fork/subagent/extra thread) and go inert.
  //
  // This runs BEFORE setTabTitle/ensureBroker on purpose: a secondary must not
  // write escape sequences to the shared terminal or open a broker connection.
  // See shared/wake-launch-role.ts for why no spawn-time thread id exists.
  const electionCwd = process.cwd();
  const electionTty = getTty();
  const wakeLaunch = RUNTIME_IS_CODEX && isWakeLaunchEnv(process.env);
  if (wakeLaunch) {
    const claimStore = new WakeLaunchClaimStore();
    const claim = await claimStore.findMatching({
      cwd: electionCwd,
      tty: electionTty,
      waitMs: 30_000,
      includeConsumed: true,
    });
    wakeRootClaim = claim && await claimStore.tryAcquireRoot(claim.claim_id, process.pid)
      ? claim
      : null;
  }
  const wakeLaunchRole = decideWakeLaunchRole({
    isWakeLaunch: wakeLaunch,
    claimedWakeRoot: wakeRootClaim !== null,
  });
  if (!shouldRegisterAsPeer(wakeLaunchRole)) {
    // Expose an MCP so the owning thread can still start — with
    // `mcp_servers.agent-peers.required=true` a failed init would block the
    // thread — but take no identity and produce no side effects.
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    await mcp.connect(new StdioServerTransport());
    log("secondary thread of a wakeable launch; not registering a peer identity");
    return;
  }

  // Arm full signal-level title-clear before any setTabTitle() call.
  // Rationale (verified by Codex adversarial review): an unhandled SIGHUP
  // exits with status 129 and does NOT fire the 'exit' event. So we install
  // SIGINT/SIGTERM/SIGHUP/SIGQUIT handlers immediately — not just 'exit' —
  // that sync-clear the title, optionally run whatever deferred cleanup is
  // wired, then exit. This closes the startup window where setTabTitle has
  // already fired but the full lifecycle cleanup isn't wired yet.
  // Write a placeholder title + arm the keepalive BEFORE register() so
  // there's no "node" window between MCP-spawn and peer-registered.
  // The post-register setTabTitle(`peer:${myName}`) overwrites this.
  setTabTitle("peer:starting");
  startTabTitleKeepalive();

  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(isBrokerAlive, brokerScriptUrl);
  const sharedSecret = await waitForSharedSecret();
  client = createClient(BROKER_URL, sharedSecret);

  // Hermes profiles set AGENT_PEERS_CWD in their MCP config; without it a
  // Hermes surface inherits whatever cwd its host process happened to have
  // (observed: `/`, the profile dir, and a workdir — three "identities" for
  // one agent).
  myCwd = process.env.AGENT_PEERS_CWD || process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  // ---- One peer per logical Hermes agent (name-claim election) ----------
  // Gateway and serve both load this server with the same PEER_NAME. Exactly
  // one surface may own that name; the loser keeps full tooling but registers
  // an ephemeral generated name (it may be the surface the user is talking
  // through — it must be able to SEND — it just isn't the address peers use).
  let requestedName: string | undefined = process.env.PEER_NAME;
  let requestDurable = !!requestedName && process.env.AGENT_PEERS_EPHEMERAL !== "1";
  let hermesClaims: HermesNameClaims | null = null;
  let hermesClaimedName: string | null = null;
  if (RUNTIME_PEER_TYPE === "hermes" && requestedName) {
    hermesClaims = new HermesNameClaims();
    if (await hermesClaims.tryAcquire(requestedName, process.pid)) {
      hermesClaimedName = requestedName;
      log(`hermes name-claim won: this surface owns "${requestedName}"`);
    } else {
      log(`hermes name-claim lost: "${requestedName}" is owned by another live surface; registering ephemeral`);
      requestedName = undefined;
      requestDurable = false;
    }
  }

  let initialSummary = "";
  const summaryPromise = (async () => {
    try {
      const [branch, recent_files] = await Promise.all([
        getGitBranch(myCwd),
        getRecentFiles(myCwd),
      ]);
      initialSummary = await generateSummary({
        cwd: myCwd, git_root: myGitRoot, git_branch: branch, recent_files,
      });
    } catch {
      /* non-critical */
    }
  })();
  await Promise.race([summaryPromise, new Promise((r) => setTimeout(r, 3000))]);

  const reg = await client.register({
    peer_type: RUNTIME_PEER_TYPE,
    name: requestedName,
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    durable: requestDurable,
  });
  myId = reg.id;
  myName = reg.name;
  mySession = reg.session_token;
  inboxStore = new CodexInboxStore({ peerId: myId });
  await inboxStore.init();
  if (RUNTIME_IS_CODEX) {
    await registerWakeableSessionIfEnabled({
      peerId: myId,
      peerName: myName,
      sessionToken: mySession,
      cwd: myCwd,
      gitRoot: myGitRoot,
      tty,
    });
  }
  setTabTitle(`peer:${myName}`);
  // Note: keepalive was already armed earlier in main(), before register().
  // The setTabTitle above just updates `lastTitle`; the running keepalive
  // will re-assert the new name on its next tick (≤1s).
  log(`Registered as ${myName} (id=${myId})`);

  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId && mySession) {
        try { await client.setSummary({ id: myId, session_token: mySession, summary: initialSummary }); } catch { /* non-critical */ }
      }
    });
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  let pollStopped = false;
  let pollTickTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleNextPoll = () => {
    if (pollStopped) return;
    pollTickTimer = setTimeout(async () => {
      try { await pollBrokerIntoQueue(); }
      finally { scheduleNextPoll(); }
    }, POLL_INTERVAL_MS);
  };
  scheduleNextPoll();

  // bd-e57.10 — heartbeat, and act on being told we are no longer known.
  //
  // If the broker is down longer than its stale threshold (60s), its GC deletes
  // every peer row. We survive that; our row does not. Before this, the reply
  // was an unconditional {ok: true} and we would go on heartbeating into a
  // deleted row forever — invisible to `list_peers`, unable to receive a single
  // message, and never once told. Now the broker reports whether the write
  // landed, and a `false` means: rejoin under our own name.
  //
  // `known === undefined` is NOT eviction. It means the broker predates the
  // field and cannot answer. Never re-register on silence — only on a "no".
  //
  // inboxStore is deliberately NOT rebuilt: its peerId only names a local file
  // and it never talks to the broker, so keeping it preserves the messages this
  // session has already received but not yet read. The wake registry DOES cross
  // the boundary — it hands the daemon a peerId and session token — so that one
  // must be re-pointed at the new identity or the daemon would wake a ghost.
  let rejoining = false;
  const hb = setInterval(async () => {
    if (!myId || !mySession || rejoining) return;
    try {
      const res = await client.heartbeat({ id: myId, session_token: mySession });
      if (res?.known !== false) return;

      rejoining = true;
      try {
        log(`Broker no longer knows us (id=${myId}) — evicted, most likely a broker outage >60s. Re-registering as ${myName}.`);
        const again = await client.register({
          peer_type: RUNTIME_PEER_TYPE,
          name: myName ?? requestedName,
          pid: process.pid,
          cwd: myCwd,
          git_root: myGitRoot,
          tty,
          summary: initialSummary,
          durable: requestDurable,
          // Mailbox follows the agent: if our old row is gone, the broker
          // re-points our unacked mail to the new incarnation.
          prev_id: myId,
        });
        myId = again.id;
        myName = again.name;
        mySession = again.session_token;
        if (RUNTIME_IS_CODEX) {
          await registerWakeableSessionIfEnabled({
            peerId: myId,
            peerName: myName,
            sessionToken: mySession,
            cwd: myCwd,
            gitRoot: myGitRoot,
            tty,
          });
        }
        log(`Rejoined the network as ${myName} (id=${myId})`);
      } catch (e) {
        // Broker still down, or refusing. Stay evicted and try again next tick —
        // do NOT swallow this the way the old heartbeat did.
        log(`Re-registration failed, still off the network: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        rejoining = false;
      }
    } catch { /* broker unreachable; the next tick retries */ }
  }, HEARTBEAT_INTERVAL_MS);

  // Wire deferred lifecycle cleanup into the earlyKillHandler registered at
  // the top of main(). Intentionally NO pendingAcks flush (spec §5.5) and NO
  // unregister (preserves reclaim-by-name window). Timer cleanup only.
  lifecycleCleanup = async () => {
    clearInterval(parentWatch);
    clearInterval(hb);
    pollStopped = true;
    if (pollTickTimer) clearTimeout(pollTickTimer);
    // Release the hermes name claim so the next surface (next turn's process)
    // can win it. Release is owner-checked; a loser releasing is a no-op.
    if (hermesClaims && hermesClaimedName) {
      try { await hermesClaims.release(hermesClaimedName, process.pid); } catch { /* best effort */ }
    }
  };
  // Note: all signal handlers + 'exit' handler are already armed at the top
  // of main(), before any setTabTitle() call — so a terminal close during
  // startup also clears the title.
}

async function registerWakeableSessionIfEnabled(opts: {
  peerId: PeerId;
  peerName: string;
  sessionToken: string;
  cwd: string;
  gitRoot: string | null;
  tty: string | null;
}): Promise<void> {
  const hints = await resolveWakeRegistrationHints(opts);
  if (!hints) return;

  const appServerPid = hints.app_server_pid;
  if (!Number.isFinite(appServerPid) || appServerPid <= 0) {
    log("wake registry skipped: invalid app-server pid in launch hints");
    return;
  }

  const now = new Date().toISOString();
  const registry = new WakeRegistry();
  await registry.init();
  await registry.upsert({
    peer_id: opts.peerId,
    peer_name: opts.peerName,
    cwd: opts.cwd,
    git_root: opts.gitRoot,
    tty: opts.tty,
    thread_id: hints.thread_id,
    rollout_path: hints.rollout_path,
    app_server_url: hints.app_server_url,
    app_server_socket_path: hints.app_server_socket_path,
    app_server_pid: appServerPid,
    tui_pid: hints.tui_pid,
    mcp_pid: process.pid,
    broker_session_token_hash: hashBrokerSessionToken(opts.sessionToken),
    status: "ready",
    capabilities: ["app-server-ws"],
    created_at: hints.created_at,
    updated_at: now,
    last_seen_at: now,
  });
  if (hints.claim_id !== "env") {
    await new WakeLaunchClaimStore().consume(hints.claim_id, opts.peerId).catch(() => {});
  }
  // This session is now wake-target: the daemon will start a fresh turn on mail
  // arrival, so the model never needs to block in wait_for_peer_messages.
  isWakeableSession = true;
  log(`wake registry updated for thread ${hints.thread_id}`);
}

async function resolveWakeRegistrationHints(opts: {
  cwd: string;
  tty: string | null;
}): Promise<(CompleteWakeLaunchClaim & { claim_id: string }) | null> {
  if (process.env.AGENT_PEERS_WAKE_ENABLED === "1") {
    const threadId = process.env.AGENT_PEERS_WAKE_THREAD_ID;
    const appServerUrl = process.env.AGENT_PEERS_WAKE_APP_SERVER_URL;
    const appServerPid = Number.parseInt(process.env.AGENT_PEERS_WAKE_APP_SERVER_PID ?? "", 10);
    if (!threadId || !appServerUrl || !Number.isFinite(appServerPid) || appServerPid <= 0) {
      log("wake registry skipped: missing AGENT_PEERS_WAKE_THREAD_ID, AGENT_PEERS_WAKE_APP_SERVER_URL, or AGENT_PEERS_WAKE_APP_SERVER_PID");
      return null;
    }
    const now = new Date().toISOString();
    return {
      claim_id: "env",
      cwd: opts.cwd,
      tty: opts.tty,
      requested_peer_name: process.env.PEER_NAME ?? null,
      app_server_url: appServerUrl,
      app_server_pid: appServerPid,
      app_server_socket_path: process.env.AGENT_PEERS_WAKE_APP_SERVER_SOCKET_PATH || null,
      thread_id: threadId,
      rollout_path: process.env.AGENT_PEERS_WAKE_ROLLOUT_PATH || null,
      tui_pid: process.ppid > 0 ? process.ppid : null,
      status: "ready",
      created_at: now,
      updated_at: now,
      consumed_by_peer_id: null,
    };
  }

  // Reuse the claim this child actually won during the election. Re-querying
  // here with includeConsumed:true is what let every sibling child resolve the
  // same claim and write its own wake-registry row.
  return wakeRootClaim;
}

main().catch(async (e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  // Clear any title set before the failure so the shell that inherits the tab
  // doesn't briefly see `peer:<name>` before the 'exit' handler fires.
  clearTabTitleSync();
  // Same rationale as claude-server: pre-connect failure has no active session
  // to preserve, so unregister the row so it doesn't block reclaim.
  if (myId && mySession) {
    try { await client.unregister({ id: myId, session_token: mySession }); } catch { /* best effort */ }
  }
  process.exit(1);
});
