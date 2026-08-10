#!/usr/bin/env bun
// claude-server.ts
// MCP stdio server for Claude Code. Registers as peer_type="claude", declares
// claude/channel, pushes inbound messages instantly via channel notifications.
//
// Delivery pipeline: every 1s the polling loop leases any new messages from the
// broker, pushes each via mcp.notification(...), adds successfully-pushed
// message_ids to an in-memory seen-set, and batches the corresponding lease
// tokens for a single /ack-messages call. Re-deliveries (lease expired and
// re-leased) are detected via seen-set and acked without a duplicate push.
//
// Shutdown: on SIGINT/SIGTERM we clear timers and exit without unregistering.
// Leaving the peer row lets a restart with the same PEER_NAME reclaim the UUID
// via broker /register, so undelivered messages keep routing (see spec §5.1).
//
// Dedupe scope: within-session only. Across restart (including reclaim-by-name),
// delivery is at-least-once — see spec §5.4.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createClient, createReadinessProbe } from "./shared/broker-client.ts";
import { ensureBroker } from "./shared/ensure-broker.ts";
import { readSharedSecret, waitForSharedSecret } from "./shared/shared-secret.ts";
import { getGitRoot, getTty } from "./shared/peer-context.ts";
import { getGitBranch, getRecentFiles, generateSummary } from "./shared/summarize.ts";
import { setTabTitle, clearTabTitle, clearTabTitleSync, startTabTitleKeepalive } from "./shared/tab-title.ts";
import { formatInboxBlock } from "./shared/piggyback.ts";
import { recordDelivered, getRecentDelivered } from "./shared/recent-delivered.ts";
import { CodexInboxStore } from "./shared/codex-inbox.ts";
import { DeliveryState } from "./shared/delivery-state.ts";
import { parentProcessWasLost } from "./shared/process-lifecycle.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { isValidName } from "./shared/names.ts";
import { COLLEAGUE_PROTOCOL } from "./shared/colleague-prompt.ts";
import type { PeerId, PeerType } from "./shared/types.ts";

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.AGENT_PEERS_HEARTBEAT_MS ?? "15000", 10);

function log(msg: string) {
  // MCP stdio servers must only use stderr for logging (stdout is the protocol).
  console.error(`[agent-peers/claude] ${msg}`);
}

// The shared secret is only known after the broker has provisioned it, so
// we defer client construction until main() can read the secret file.
let client: ReturnType<typeof createClient>;
// Authenticated readiness: once the shared secret exists, only a broker that
// answers /ready with our secret + protocol counts as alive — a bare /health
// 200 from a squatter must not satisfy startup (2026-08-10 review high #3).
const isBrokerAlive = createReadinessProbe(BROKER_URL, () =>
  readSharedSecret(process.env.AGENT_PEERS_SECRET_PATH ?? undefined),
);

let myId: PeerId | null = null;
let myName: string | null = null;
let mySession: string | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;
// Durable inbox (2026-08-10): claude-server used to ack messages into a
// process-local ring buffer only — a push queued while the session was idle
// died with the process AFTER the broker had already marked it acked, the one
// truly silent loss path on the Claude side. Messages are now persisted here
// BEFORE the channel push, and acked only after the write lands.
let inboxStore: CodexInboxStore | null = null;
const CLAUDE_INBOX_ROOT = process.env.AGENT_PEERS_STATE_DIR ?? join(homedir(), ".agent-peers-claude");
const SEEN_WATERMARK_SLACK = 10_000; // same bound as codex-server's watermark
// Delivery lifecycle for durable entries surfaced via check_messages:
// draw → promote (response fully built) → confirm+remove on the NEXT call.
// See shared/delivery-state.ts. There is NO TTL on unread durable mail.
const delivery = new DeliveryState();

// The recent-delivered ring buffer is the backfill surface for check_messages.
// See shared/recent-delivered.ts for the full rationale. Extracted out of this
// file so the behavior (retention, TTL, cap) is unit-testable in isolation.

const mcp = new Server(
  { name: "agent-peers", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `${COLLEAGUE_PROTOCOL}

DELIVERY ON THIS SIDE (Claude Code):

There are TWO surfaces for peer messages on your side, and you need
to use both:

  1. LIVE channel push (\`<channel source="agent-peers" ...>\`):
     Messages arrive instantly this way when a peer sends something
     WHILE you are actively in a turn. Treat these the moment you see
     them — apply the REACTIVE rules above (investigate first, reply
     only when substantive, push back on disagreement).

  2. BACKFILL via \`check_messages\`:
     When a peer sends a message while this session is IDLE at the
     prompt, Claude Code queues the channel push — the model doesn't
     see it until the next turn begins, and it may not render
     visibly even then. Calling \`check_messages\` returns a
     [PEER INBOX] block containing recent ring-buffer messages plus
     ALL unread durable mail at any age, so nothing gets lost to
     idle-queue silence. Durable entries are removed only after a
     later call confirms the response reached you.

RULE: Call \`check_messages\` as the FIRST thing you do at the START of
every user turn. This is the same rule Codex uses. It's one cheap
tool call. It surfaces anything that arrived while you were idle.
Without this habit, a peer DM sent while you were at the prompt
waits invisibly until something else happens to trigger a redraw.

Exception: you do NOT need to call \`check_messages\` again within the
same turn — once per turn is enough. If the user sent you a task
right after a peer message arrived mid-task, you've already seen it
via the live channel push, and check_messages will just re-show the
same thing.`,
  },
);

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other AI agent peers on this machine. Returns id, human name, peer_type (claude|codex|hermes), cwd, summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: { type: "string" as const, enum: ["machine", "directory", "repo"] },
        peer_type: { type: "string" as const, enum: ["claude", "codex", "hermes"], description: "optional filter" },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to a peer. to_id accepts either the peer's UUID or their human name (e.g. 'frontend-tab').",
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
    description: "Set a 1-2 sentence summary of your current work (visible to peers).",
    inputSchema: {
      type: "object" as const,
      properties: { summary: { type: "string" as const } },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description:
      "Surface pending peer messages (recent ring buffer + ALL unread durable mail, any age). Call this at the START of every user turn — it is the only reliable way to see messages that arrived while this session was idle at the prompt (Claude Code's channel push silently queues idle deliveries). One cheap call. Without this habit, peer DMs sent while you were idle wait invisibly until something else triggers a redraw.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "rename_peer",
    description:
      "Rename YOURSELF. new_name must be 1-32 chars, matching [a-zA-Z0-9_-]. Names must be unique among active peers.",
    inputSchema: {
      type: "object" as const,
      properties: { new_name: { type: "string" as const } },
      required: ["new_name"],
    },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args } = req.params;
  if (!myId || !mySession) {
    return {
      content: [{ type: "text" as const, text: "Not registered with broker yet" }],
      isError: true,
    };
  }

  // Confirm-on-next-call (same machine as codex-server, shared/delivery-state):
  // durable entries surfaced by an earlier FULLY BUILT check_messages response
  // are removed only now — this call arriving is the evidence that response
  // reached the model. A dropped/aborted response leaves them in the store.
  const confirmable = delivery.confirmable();
  if (confirmable.length > 0 && inboxStore) {
    try {
      await inboxStore.removeByIds(confirmable);
      delivery.markConfirmed(confirmable);
    } catch (e) {
      log(`durable-inbox confirm failed (will retry next call): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  switch (name) {
    case "list_peers": {
      const { scope, peer_type } = args as {
        scope: "machine" | "directory" | "repo";
        peer_type?: PeerType;
      };
      const peers = await client.listPeers({
        scope, cwd: myCwd, git_root: myGitRoot, exclude_id: myId, peer_type,
      });
      if (peers.length === 0) {
        return { content: [{ type: "text" as const, text: `No other peers found (scope: ${scope}).` }] };
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
      return { content: [{ type: "text" as const, text: `Found ${peers.length} peer(s):\n\n${lines.join("\n\n")}` }] };
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      const res = await client.sendMessage({
        from_id: myId, session_token: mySession, to_id_or_name: to_id, text: message,
      });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Send failed: ${res.error}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Message sent (id=${res.message_id}).` }] };
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      await client.setSummary({ id: myId, session_token: mySession, summary });
      return { content: [{ type: "text" as const, text: `Summary set: "${summary}"` }] };
    }

    case "check_messages": {
      // BACKFILL: return whatever the background poll has recorded in the
      // ring buffer. This is Claude's equivalent of Codex's [PEER INBOX]
      // piggyback — the single reliable surface for "what peer messages
      // have I received recently?" We keep the buffer independent of the
      // broker (broker already acked those messages) so the user can
      // always retrieve recent peer activity even when Claude Code's
      // channel push was silently queued (which happens when the
      // session was idle at the prompt).
      //
      // Dedupe is the model's job: each entry includes message_id, and
      // the colleague protocol says "don't re-reply to something you
      // already replied to." So repeated check_messages calls within
      // the 15-min TTL window are safe — they show the same messages,
      // Claude just won't re-respond to ones it already handled.
      // The durable store is authoritative (survives restarts); the ring
      // buffer is the in-process fast path. Union them by message id so a
      // restart cannot hide a message the previous incarnation persisted
      // but never surfaced.
      const recent = [...getRecentDelivered()];
      // Durable unread is included at ANY age — an unread message is an
      // undelivered obligation, and hiding it behind the ring buffer's
      // 15-minute display window was a silent-loss path for sessions idle
      // longer than the TTL (2026-08-10 codex-review high #2). Entries stay
      // in the store until a LATER call confirms this response landed —
      // never removed in the same response that surfaces them (second
      // review: consume-before-return loses mail on a dropped response).
      const callId = crypto.randomUUID();
      const drawnIds: number[] = [];
      try {
        if (inboxStore) {
          const have = new Set(recent.map((m) => m.id));
          for (const m of await inboxStore.getUnreadMessages()) {
            if (delivery.isBlocked(m.id)) continue; // dealt to an in-flight/unconfirmed response
            if (!have.has(m.id)) recent.push(m);
            drawnIds.push(m.id);
          }
          recent.sort((a, b) => a.id - b.id);
        }
      } catch (e) {
        log(`durable-inbox read failed; serving ring buffer only: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (recent.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No peer messages pending (ring buffer covers the last 15 minutes; unread durable mail at any age would appear here). Messages also arrive live mid-turn via the agent-peers channel while you're active — this tool is the fallback for idle-at-prompt arrivals.",
          }],
        };
      }
      delivery.draw(callId, drawnIds);
      const response = {
        content: [{
          type: "text" as const,
          text: formatInboxBlock(recent),
        }],
      };
      if (extra?.signal?.aborted) {
        delivery.rollback(callId); // response won't reach the model; re-deal later
      } else {
        delivery.promote(callId); // removal happens at the NEXT call's confirm
      }
      return response;
    }

    case "rename_peer": {
      const { new_name } = args as { new_name: string };
      if (!isValidName(new_name)) {
        return {
          content: [{ type: "text" as const, text: `Invalid name: must be 1-32 chars, [a-zA-Z0-9_-] only.` }],
          isError: true,
        };
      }
      const res = await client.renamePeer({ id: myId, session_token: mySession, new_name });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Rename failed: ${res.error}` }], isError: true };
      }
      myName = res.name ?? new_name;
      setTabTitle(`peer:${myName}`);
      return { content: [{ type: "text" as const, text: `Renamed to ${myName}` }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  // Activation gate — the MCP is globally registered in ~/.claude.json so every
  // `claude` session spawns this process. If AGENT_PEERS_ENABLED is not "1",
  // we run as a no-op MCP: connect, expose zero tools, don't touch the broker,
  // don't set the terminal title. The `agentpeers` alias sets the env var;
  // plain `claude` doesn't. This prevents the peer network from activating
  // (and renaming your tab) in every unrelated Claude session.
  if (process.env.AGENT_PEERS_ENABLED !== "1") {
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    await mcp.connect(new StdioServerTransport());
    log("agent-peers disabled (set AGENT_PEERS_ENABLED=1 to activate); idle");
    return;
  }

  // Arm the terminal-title cleanup BEFORE any code path that could call
  // setTabTitle. The `exit` handler covers the explicit process.exit() path,
  // but an UNHANDLED SIGHUP (e.g. the user closes the tab during startup,
  // after setTabTitle has fired) terminates with status 129 and does NOT
  // trigger `exit`. So we ALSO install signal handlers immediately, even
  // before the rest of the lifecycle wiring exists. They call a
  // lifecycle-aware cleanup that runs whatever deferred work (timers,
  // pending acks) is ready, then sync-clears the title and exits.
  let lifecycleCleanup: (() => Promise<void> | void) | null = null;
  const earlyKillHandler = async () => {
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

  // Write a placeholder title + arm the keepalive BEFORE register() so
  // there's no "node" window between MCP-spawn and peer-registered.
  // The post-register setTabTitle(`peer:${myName}`) overwrites this
  // placeholder with the real name. Fixes the bug where fresh sessions
  // showed "node" for 3-5s (the time register + generateSummary takes).
  setTabTitle("peer:starting");
  startTabTitleKeepalive();

  const brokerScriptUrl = new URL("./broker.ts", import.meta.url).href;
  await ensureBroker(isBrokerAlive, brokerScriptUrl);
  // Now that the broker is up, read the per-user shared secret it wrote into
  // ~/.agent-peers-secret (file mode 0600) and construct an authenticated
  // HTTP client with it.
  const sharedSecret = await waitForSharedSecret();
  client = createClient(BROKER_URL, sharedSecret);

  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);
  const tty = getTty();

  // Best-effort auto-summary with 3s cap; register may proceed with empty summary.
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
    peer_type: "claude",
    name: process.env.PEER_NAME,
    pid: process.pid,
    cwd: myCwd,
    git_root: myGitRoot,
    tty,
    summary: initialSummary,
    durable: !!process.env.PEER_NAME && process.env.AGENT_PEERS_EPHEMERAL !== "1",
  });
  myId = reg.id;
  myName = reg.name;
  mySession = reg.session_token;
  inboxStore = new CodexInboxStore({ peerId: myId, rootDir: CLAUDE_INBOX_ROOT });
  // init() loads any state a previous incarnation persisted. Without it the
  // store starts empty-but-writable, and the first queueLeasedMessages()
  // atomically overwrites the on-disk file — destroying already-acked mail
  // the durable inbox exists to protect.
  await inboxStore.init();
  setTabTitle(`peer:${myName}`);
  // Note: keepalive was already armed earlier in main(), before register().
  // The setTabTitle above just updates `lastTitle`; the running keepalive
  // will re-assert the new name on its next tick (≤1s).
  log(`Registered as ${myName} (id=${myId})`);

  // Late summary upload if generation took longer than 3s.
  if (!initialSummary) {
    summaryPromise.then(async () => {
      if (initialSummary && myId && mySession) {
        try {
          await client.setSummary({ id: myId, session_token: mySession, summary: initialSummary });
        } catch {
          /* non-critical */
        }
      }
    });
  }

  await mcp.connect(new StdioServerTransport());
  log("MCP connected");

  // In-memory dedupe: message_ids we have already pushed successfully this session.
  // See spec §5.4 for rationale — deterministic dedupe, no model intelligence required.
  const seen = new Set<number>();

  const pollAndPush = async () => {
    if (!myId || !mySession) return;
    try {
      const msgs = await client.pollMessages({ id: myId, session_token: mySession });
      const toAck: string[] = [];
      for (const m of msgs) {
        if (seen.has(m.id)) {
          // Re-delivery after lost ack. Queue the new lease_token so the broker
          // can close the stuck lease, but do NOT push again.
          toAck.push(m.lease_token);
          continue;
        }
        // Durable persistence FIRST. If this write fails we neither push nor
        // ack — the lease expires at the broker and the message re-offers.
        // Acking before any durable record existed is what made a queued-
        // while-idle push die with the process, already-acked and untraceable.
        try {
          await inboxStore?.queueLeasedMessages([m]);
        } catch (e) {
          log(`durable-inbox write failed for msg #${m.id} (will re-lease): ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        // The durable copy exists — the message can no longer be lost, so ack
        // and dedupe regardless of what the (best-effort) push does next.
        // check_messages reads the durable store, so even a session that dies
        // mid-push leaves the message retrievable by the next session.
        seen.add(m.id);
        toAck.push(m.lease_token);
        try {
          // Per the channels reference, `meta` is Record<string, string> —
          // non-string values are silently dropped, and the `source` attribute
          // is auto-generated from the server name (so passing it here would
          // be redundant or conflict with the auto-set value). Stringify the
          // numeric message_id and omit `source`.
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: m.text,
              meta: {
                message_id: String(m.id),
                from_id: m.from_id,
                from_name: m.from_name,
                from_peer_type: m.from_peer_type,
                from_summary: m.from_summary,
                from_cwd: m.from_cwd,
                sent_at: m.sent_at,
              },
            },
          });
          // Ring-buffer record is the fast path for check_messages backfill.
          recordDelivered(m);
          // Visible proof-of-delivery in stderr so a live operator can
          // tell from the log alone whether the push fired. Claude Code's
          // rendering is opaque to us (especially in idle-at-prompt
          // cases), so having a hard "yes, we pushed it" line in
          // stderr is the one debug signal that always works.
          log(`📬 pushed channel msg #${m.id} from ${m.from_name} (${m.from_peer_type}): ${m.text.slice(0, 80)}${m.text.length > 80 ? "…" : ""}`);
        } catch (e) {
          log(`push failed (message persisted; check_messages will surface it): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Watermark prune (same shape as codex-server's pruneSeenWatermark):
      // ids far below the newest are long-acked and can never re-offer, so
      // the dedupe set stays bounded across a long-lived session.
      if (seen.size > 0) {
        const watermark = Math.max(...seen) - SEEN_WATERMARK_SLACK;
        for (const id of seen) if (id < watermark) seen.delete(id);
      }
      // NO TTL prune of unread durable mail (2026-08-10 second review):
      // an unread entry is mail the model has never seen, and the broker
      // already acked it — deleting it on a timer is silent loss, full stop.
      // Entries leave the store ONLY via confirm-on-next-call after a fully
      // built check_messages response, or via the rejoin migration. A dead
      // session's file is archived (never deleted) by `cli.ts gc-inboxes`.
      delivery.pruneConfirmedBelow(delivery.maxConfirmed() - SEEN_WATERMARK_SLACK);
      if (toAck.length > 0 && mySession) {
        try {
          await client.ackMessages({ id: myId, session_token: mySession, lease_tokens: toAck });
        } catch {
          /* next poll picks up remainder */
        }
      }
    } catch (e) {
      log(`poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Self-scheduling loop with re-entrancy guard (code review round-1 fix).
  // Using setInterval would fire a new poll every 1s even if the previous one is
  // still in flight, causing overlapping reads of the same `seen` set and
  // duplicate pushes under slow I/O. This pattern guarantees strictly one
  // in-flight cycle at a time.
  let pushStopped = false;
  let pushTickTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleNextPush = () => {
    if (pushStopped) return;
    pushTickTimer = setTimeout(async () => {
      try { await pollAndPush(); }
      finally { scheduleNextPush(); }
    }, POLL_INTERVAL_MS);
  };
  scheduleNextPush();

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
          peer_type: "claude",
          name: myName ?? process.env.PEER_NAME,
          pid: process.pid,
          cwd: myCwd,
          git_root: myGitRoot,
          tty,
          summary: initialSummary,
          durable: !!process.env.PEER_NAME && process.env.AGENT_PEERS_EPHEMERAL !== "1",
          // Mailbox follows the agent: if our old row is gone, the broker
          // re-points our unacked mail to the new incarnation.
          prev_id: myId,
        });
        const prevStore = inboxStore;
        myId = again.id;
        myName = again.name;
        mySession = again.session_token;
        // The mailbox follows the peer id — rebind the durable store so a
        // re-registration that minted a new UUID doesn't strand the inbox
        // under the dead one, and migrate the old incarnation's unread
        // entries into the new store (they were already acked at the broker,
        // so nothing will ever re-offer them).
        inboxStore = new CodexInboxStore({ peerId: myId, rootDir: CLAUDE_INBOX_ROOT });
        await inboxStore.init();
        if (prevStore) {
          try {
            const carried = await prevStore.getUnreadMessages();
            if (carried.length > 0) {
              await inboxStore.queueLeasedMessages(carried);
              await prevStore.removeByIds(carried.map((m) => m.id));
              log(`Migrated ${carried.length} unread durable message(s) to new incarnation ${myId}`);
            }
          } catch (e) {
            log(`Durable-inbox migration failed (old entries remain on disk): ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        setTabTitle(`peer:${myName}`);
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

  // Wire the deferred lifecycle cleanup into the earlyKillHandler registered
  // at the top of main(). When any fatal signal arrives now, earlyKillHandler
  // will call this to clean up timers + deliberately NOT unregister (to preserve
  // reclaim-by-name), then sync-clear the title, then exit.
  // Orphan-parent watchdog (ported from codex-server): Bun's stdio transport
  // can outlive its Claude Code parent, leaving an MCP that heartbeats a
  // phantom peer forever. Once we reparent to launchd, this session is gone.
  const initialParentPid = process.ppid;
  const parentWatch = setInterval(() => {
    if (parentProcessWasLost(initialParentPid, process.ppid)) {
      log(`claude parent ${initialParentPid} exited; stopping orphaned MCP`);
      void earlyKillHandler();
    }
  }, 1_000);

  lifecycleCleanup = async () => {
    clearInterval(hb);
    clearInterval(parentWatch);
    pushStopped = true;
    if (pushTickTimer) clearTimeout(pushTickTimer);
  };
  // Note: SIGINT / SIGTERM / SIGHUP / SIGQUIT / exit handlers are already
  // registered earlier in main(), before any setTabTitle() call, so terminal
  // close during startup also clears the title.
}

main().catch(async (e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  // Clear any title we may have set before the failure — don't wait for the
  // 'exit' handler (which will also run) to avoid a visible flicker where the
  // user's shell briefly inherits `peer:<name>` before reset.
  clearTabTitleSync();
  // If we registered with the broker but failed BEFORE mcp.connect() or before
  // signal handlers were installed, no active session exists to preserve for
  // reclaim. Unregister explicitly so the row doesn't block same-name reclaim
  // for 60s. Post-connect failures use the signal-handler path (no unregister).
  if (myId && mySession) {
    try { await client.unregister({ id: myId, session_token: mySession }); } catch { /* best effort */ }
  }
  process.exit(1);
});
