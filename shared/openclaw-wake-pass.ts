// shared/openclaw-wake-pass.ts
// One OpenClaw wake pass, run by wake-daemon.ts on every daemon tick after the
// Codex and Hermes passes (bd-b2in.17). Off until an agent id is listed in
//   ~/.agent-peers-openclaw/wake/enabled
// so shipping this code wakes nothing. Deleting the line is the rollback; it
// stops FUTURE wakes only. Work already admitted keeps its own lifecycle in
// OpenClaw (cancel it there with chat.abort if that is ever wanted).
//
// Contract (Marco, AP10809):
//  #1 Never "check idle, then send". Every submission is one chat.send to
//     agent:<id>:main with a per-request queueMode "followup": an idle session
//     starts a turn, a busy one queues it behind the active run without
//     steering or interrupting. The global queue mode is never touched.
//  #2 This is custody, not a cooldown. The submission identity (the
//     idempotencyKey, which OpenClaw uses as the runId) and the intent are
//     fsynced to the ledger before chat.send. Outcomes come only from the
//     acknowledgement or from chat.history inputReceipts for that exact runId
//     in the same sessionId, never from content matching. Anything uncertain
//     is "unknown" and stays so across daemon restart, Gateway restart and
//     lost responses until an operator clears it. While any submission is
//     open (intent/accepted/unknown) nothing new is submitted: not on a
//     timeout, not on new mail. Each unread set is woken at most once.
//  #5 deliver:false on every send; the dedicated agent has no channel either.

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "./broker-client.ts";
import { readSharedSecret } from "./shared-secret.ts";
import {
  enabledAgents, LedgerLockedError, mainSessionKey, OPEN_STATES, openclawDisabled, openclawRoot, readBinding, readLedger,
  tokenHash, withLedgerLock, writeJsonDurable, writeLedger,
  type Submission, type WakeLedger,
} from "./openclaw-state.ts";
import {
  agentShellRefusal, OpenClawCliGateway, resolveOpenClawRuntime,
  type ChatSendAck, type OpenClawGateway,
} from "./openclaw-gateway.ts";
import type { PeerInboxEntry } from "./types.ts";

export interface OpenClawWakeResult {
  agent_id: string;
  state: string;
  detail: string;
  submission_id?: string;
}

const ACK_OK = new Set(["started", "accepted", "in_flight", "ok"]);
const RECONCILE_INTERVAL_MS = 15_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function unreadSignature(peerId: string, ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b).join(",");
  return `sha256:${createHash("sha256").update(`${peerId}:${sorted}`, "utf8").digest("hex")}`;
}

export function buildOpenClawWakeText(kind: "wake" | "bind", token: string, id: string): string {
  const head = kind === "bind"
    ? "[agent-peers bind]\nAn operator is connecting this session to the Agent Peers network."
    : "[agent-peers wake]\nYou have pending agent-peers messages in your local MCP inbox.";
  return `${head}
Call the agent-peers check_messages tool now, yourself, in this session (do not hand it to a sub-agent), with wake="${token}". Treat that tool response as the only authoritative message content and infer nothing from this signal. Answer peers only with agent-peers send_message; this signal has no other recipient. After handling the inbox, call check_messages once more so it is recorded as read, then stop. Wake id: ${id}`;
}

export interface SubmitDeps {
  root: string;
  agentId: string;
  gateway: OpenClawGateway;
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
  /** Re-read the opt-in and kill switch; a reason string means stop. */
  stillAllowed?: () => string | null;
}

/** Why a submission for this agent must not happen now, or null. Read from
 *  disk on every call, so a switch flipped during an await is honored. */
function wakeStop(root: string, agentId: string): string | null {
  if (openclawDisabled(root)) return `the kill switch ${join(root, "disabled")} is engaged`;
  return enabledAgents(root).has(agentId) ? null : `wakes for ${agentId} are switched off (wake/enabled)`;
}
function killStop(root: string): string | null {
  return openclawDisabled(root) ? `the kill switch ${join(root, "disabled")} is engaged` : null;
}

function touch(s: Submission, now: Date, patch: Partial<Submission>): void {
  Object.assign(s, patch, { updated_at: now.toISOString() });
}

/** Submit one wake or bind into agent:<id>:main. The caller holds the ledger
 *  lock and has checked that nothing is open. */
async function submitLocked(deps: SubmitDeps, ledger: WakeLedger, kind: "wake" | "bind", signature: string | null): Promise<OpenClawWakeResult> {
  const now = deps.now ?? (() => new Date());
  const key = mainSessionKey(deps.agentId);
  let row;
  try {
    row = await deps.gateway.describe(key, deps.agentId);
  } catch (e) {
    return { agent_id: deps.agentId, state: "gateway_unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
  // Never create the session: the wake must land in the existing main session.
  if (!row || row.key !== key || !row.sessionId) {
    return { agent_id: deps.agentId, state: "no_main_session", detail: `${key} does not exist on this Gateway; nothing submitted` };
  }
  // Recheck after the awaits above, immediately before custody begins.
  const stop = deps.stillAllowed?.();
  if (stop) return { agent_id: deps.agentId, state: "opted_out", detail: `${stop}; nothing submitted` };
  const id = deps.newId?.() ?? `agent-peers-${kind}-${randomUUID()}`;
  const token = deps.newToken?.() ?? randomUUID();
  const created = now();
  const sub: Submission = {
    id, kind, token_sha256: tokenHash(token), session_key: key, session_id: row.sessionId,
    signature, state: "intent", created_at: created.toISOString(), updated_at: created.toISOString(),
  };
  ledger.submissions.push(sub);
  await writeLedger(deps.root, ledger); // custody first: durable before the send

  // Last check before the send. Nothing has left this process yet, so the
  // intent can be withdrawn with certainty.
  const late = deps.stillAllowed?.();
  if (late) {
    touch(sub, now(), { state: "cancelled", detail: `withdrawn before chat.send: ${late}; nothing was sent` });
    await writeLedger(deps.root, ledger);
    return { agent_id: deps.agentId, state: "opted_out", detail: `${late}; nothing submitted`, submission_id: id };
  }

  let ack: ChatSendAck;
  try {
    ack = await deps.gateway.chatSend({
      sessionKey: key, agentId: deps.agentId, message: buildOpenClawWakeText(kind, token, id),
      queueMode: "followup", deliver: false, idempotencyKey: id,
    });
  } catch (e) {
    touch(sub, now(), { state: "unknown", detail: `chat.send did not confirm (${e instanceof Error ? e.message : String(e)}); not resubmitted` });
    await writeLedger(deps.root, ledger);
    return { agent_id: deps.agentId, state: "unknown", detail: sub.detail!, submission_id: id };
  }
  if (ack.runId === id && typeof ack.status === "string" && ACK_OK.has(ack.status)) {
    touch(sub, now(), { state: "accepted", ack: { status: ack.status, ...(typeof ack.messageSeq === "number" ? { messageSeq: ack.messageSeq } : {}) },
      detail: "acknowledged by the Gateway; waiting for custody to show it consumed" });
  } else {
    touch(sub, now(), { state: "unknown", detail: `unexpected chat.send acknowledgement (${JSON.stringify(ack).slice(0, 200)}); not resubmitted` });
  }
  if (ack.interruptedActiveRun === true) {
    // followup must never interrupt. If OpenClaw says it did, stop all wakes.
    ledger.halted = { reason: "OpenClaw reported interruptedActiveRun for a followup submission", at: now().toISOString() };
  }
  await writeLedger(deps.root, ledger);
  return { agent_id: deps.agentId, state: sub.state === "accepted" ? "submitted" : "unknown", detail: sub.detail!, submission_id: id };
}

/** Move open submissions forward using custody evidence only. */
async function reconcileLocked(deps: SubmitDeps, ledger: WakeLedger): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  let changed = false;
  for (const s of ledger.submissions) {
    if (s.state === "intent") {
      // We died between writing the intent and recording chat.send's result.
      touch(s, now(), { state: "unknown", detail: "the daemon stopped before chat.send's result was recorded; not resubmitted" });
      changed = true;
    }
  }
  const open = ledger.submissions.filter((s) => s.state === "accepted" || s.state === "unknown");
  if (open.length === 0) return changed;
  const key = mainSessionKey(deps.agentId);
  const row = await deps.gateway.describe(key, deps.agentId); // throws: caller reports, ledger unchanged
  const current = row?.sessionId ?? null;
  const same = open.filter((s) => s.session_id === current);
  for (const s of open) {
    if (s.session_id === current) continue;
    if (s.state === "accepted" || !s.detail?.startsWith("the session changed")) {
      touch(s, now(), { state: "unknown", detail: `the session changed since submission (${current ? "new sessionId" : "session missing"}); its custody can no longer be read` });
      changed = true;
    }
  }
  if (same.length === 0) return changed;
  const receipts = await deps.gateway.inputReceipts(key, deps.agentId, same.map((s) => s.id));
  for (const s of same) {
    const r = receipts.find((x) => x.runId === s.id);
    if (r?.state === "consumed") {
      touch(s, now(), { state: "consumed", detail: `consumed by transcript event ${r.consumedByEventId}` });
      changed = true;
    } else if (r?.state === "pending" && r.cancelled) {
      touch(s, now(), { state: "cancelled", detail: "cancelled in OpenClaw before it ran" });
      changed = true;
    } else if (r?.state === "pending") {
      const detail = r.queued ? "accepted; queued behind the active run" : "accepted; pending in OpenClaw custody";
      if (s.state !== "accepted" || s.detail !== detail) { touch(s, now(), { state: "accepted", detail }); changed = true; }
    } else if (s.state === "accepted") {
      touch(s, now(), { state: "unknown", detail: "acknowledged earlier but OpenClaw shows no custody receipt for it; not resubmitted" });
      changed = true;
    } else if (!s.detail?.includes("no custody receipt")) {
      touch(s, now(), { detail: `${s.detail ?? "unknown"}; OpenClaw shows no custody receipt for it` });
      changed = true;
    }
  }
  return changed;
}

function prune(ledger: WakeLedger, now: Date): boolean {
  const before = ledger.submissions.length;
  ledger.submissions = ledger.submissions.filter((s) =>
    OPEN_STATES.has(s.state) || now.getTime() - Date.parse(s.updated_at) < TERMINAL_RETENTION_MS);
  return ledger.submissions.length !== before;
}

function openSummary(ledger: WakeLedger): Submission | null {
  return ledger.submissions.find((s) => OPEN_STATES.has(s.state)) ?? null;
}

async function lastReconciled(root: string, agentId: string): Promise<number> {
  try { return Number(JSON.parse(await readFile(join(root, "wake", `${agentId}.reconciled.json`), "utf8")).at) || 0; }
  catch { return 0; }
}

export interface WakePassOptions {
  env?: NodeJS.ProcessEnv;
  root?: string;
  now?: () => Date;
  gateway?: OpenClawGateway;
  peerInbox?: (boundPeerIds: string[]) => Promise<PeerInboxEntry[] | null>;
  newId?: () => string;
  newToken?: () => string;
}

export async function runOpenClawWakePass(opts: WakePassOptions = {}): Promise<OpenClawWakeResult[]> {
  const env = opts.env ?? process.env;
  const root = opts.root ?? openclawRoot(env);
  if (openclawDisabled(root)) return []; // kill switch: no broker or Gateway calls
  const agents = enabledAgents(root);
  if (agents.size === 0) return []; // shipped, not switched on: no broker or Gateway calls
  const now = opts.now ?? (() => new Date());
  let gateway = opts.gateway;
  const results: OpenClawWakeResult[] = [];
  let inboxCache: PeerInboxEntry[] | null | undefined;
  const inbox = async () => {
    if (inboxCache !== undefined) return inboxCache;
    const bound: string[] = [];
    for (const id of agents) {
      const peerId = (await readBinding(root, id))?.peer_id;
      if (peerId) bound.push(peerId);
    }
    const fetcher = opts.peerInbox ?? ((ids: string[]) => {
      const port = env.AGENT_PEERS_PORT ?? "7900";
      const secretPath = env.AGENT_PEERS_SECRET_PATH || undefined;
      return createClient(`http://127.0.0.1:${port}`, () => readSharedSecret(secretPath), { timeoutMs: 5000 }).peerInbox("openclaw", ids);
    });
    inboxCache = await fetcher(bound);
    return inboxCache;
  };

  for (const agentId of agents) {
    try {
      const stillAllowed = () => wakeStop(root, agentId);
      results.push(await withLedgerLock(root, agentId, async () => {
        const off = stillAllowed();
        if (off) return { agent_id: agentId, state: "opted_out", detail: off };
        const ledger = await readLedger(root, agentId);
        if (!gateway) {
          const shell = agentShellRefusal(env);
          if (shell) return { agent_id: agentId, state: "agent_shell", detail: shell };
          const runtime = resolveOpenClawRuntime(env);
          if (!runtime.nodeBinDir) return { agent_id: agentId, state: "node_unsupported", detail: runtime.problem! };
          gateway = new OpenClawCliGateway({ runtime, env });
        }
        const deps: SubmitDeps = { root, agentId, gateway, now, newId: opts.newId, newToken: opts.newToken, stillAllowed };
        let changed = prune(ledger, now());
        const hasOpen = ledger.submissions.some((s) => OPEN_STATES.has(s.state));
        const recheck = ledger.submissions.some((s) => s.state === "intent")
          || now().getTime() - await lastReconciled(root, agentId) >= RECONCILE_INTERVAL_MS;
        if (hasOpen && recheck) {
          try {
            changed = (await reconcileLocked(deps, ledger)) || changed;
            await writeJsonDurable(join(root, "wake", `${agentId}.reconciled.json`), { at: now().getTime() });
          } catch (e) {
            if (changed) await writeLedger(root, ledger);
            const pending = openSummary(ledger);
            return { agent_id: agentId, state: "gateway_unreachable",
              detail: `could not read custody (${e instanceof Error ? e.message : String(e)}); ${pending ? `${pending.id} stays ${pending.state}` : "nothing open"}` };
          }
        }
        if (changed) await writeLedger(root, ledger);

        if (ledger.halted) return { agent_id: agentId, state: "halted", detail: `${ledger.halted.reason}; clear with \`bun cli.ts openclaw clear ${agentId} halt\`` };
        const pending = openSummary(ledger);
        if (pending) {
          return { agent_id: agentId, state: pending.state === "unknown" ? "blocked_unknown" : "waiting", submission_id: pending.id,
            detail: pending.state === "unknown"
              ? `${pending.detail ?? "outcome unknown"}. No new wake until an operator clears it: bun cli.ts openclaw clear ${agentId} ${pending.id}`
              : pending.detail ?? "accepted; waiting for it to run" };
        }
        const binding = await readBinding(root, agentId);
        if (!binding?.peer_id) {
          return { agent_id: agentId, state: "unbound", detail: `no proven main-session binding with a registered peer; run \`bun cli.ts openclaw bind ${agentId}\`` };
        }
        const entries = await inbox();
        const offNow = stillAllowed();
        if (offNow) return { agent_id: agentId, state: "opted_out", detail: `${offNow}; nothing submitted` };
        if (!entries) return { agent_id: agentId, state: "broker_too_old", detail: "the broker has no /peer-inbox; upgrade it" };
        // By id first; by name if the child rejoined under a new UUID after a
        // broker eviction (names are unique per broker).
        const entry = entries.find((e) => e.peer_id === binding.peer_id)
          ?? entries.find((e) => !!binding.peer_name && e.peer_name === binding.peer_name);
        if (!entry || entry.unread_ids.length === 0) return { agent_id: agentId, state: "idle", detail: "no unread mail" };
        const signature = unreadSignature(entry.peer_id, entry.unread_ids);
        const woken = ledger.submissions.find((s) => s.signature === signature);
        if (woken) {
          return { agent_id: agentId, state: "already_woken", submission_id: woken.id,
            detail: `already woken once (${woken.id}) for these ${entry.unread_ids.length} unread message(s); waits for new mail, a tool call, or \`bun cli.ts openclaw rearm ${agentId} ${woken.id}\`` };
        }
        return submitLocked(deps, ledger, "wake", signature);
      }, 2_000));
    } catch (e) {
      results.push({ agent_id: agentId, state: e instanceof LedgerLockedError ? "locked" : "error", detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/** Operator bind: one bodyless submission whose token lets main's child prove
 *  its Codex thread. Same custody and at-most-one-open rule as a wake. */
export async function bindOpenClawAgent(opts: { root: string; agentId: string; gateway?: OpenClawGateway; env?: NodeJS.ProcessEnv;
  now?: () => Date; newId?: () => string; newToken?: () => string }): Promise<OpenClawWakeResult> {
  return withLedgerLock(opts.root, opts.agentId, async () => {
    const killed = killStop(opts.root);
    if (killed) return { agent_id: opts.agentId, state: "disabled", detail: `${killed}; nothing submitted` };
    const ledger = await readLedger(opts.root, opts.agentId);
    if (ledger.halted) return { agent_id: opts.agentId, state: "halted", detail: `${ledger.halted.reason}; clear with \`bun cli.ts openclaw clear ${opts.agentId} halt\` first` };
    const gateway = opts.gateway ?? cliGateway(opts.env);
    if (typeof gateway === "string") return { agent_id: opts.agentId, state: "refused", detail: gateway };
    const deps: SubmitDeps = { root: opts.root, agentId: opts.agentId, gateway, now: opts.now, newId: opts.newId, newToken: opts.newToken,
      stillAllowed: () => killStop(opts.root) };
    let pending = openSummary(ledger);
    if (pending) {
      // Wakes may be off (runbook step 5), so no pass has read custody yet.
      try {
        if (await reconcileLocked(deps, ledger)) await writeLedger(opts.root, ledger);
      } catch (e) {
        return { agent_id: opts.agentId, state: "gateway_unreachable", submission_id: pending.id,
          detail: `could not read custody (${e instanceof Error ? e.message : String(e)}); ${pending.id} stays ${pending.state}` };
      }
      pending = openSummary(ledger);
    }
    if (pending) return { agent_id: opts.agentId, state: "blocked_open", submission_id: pending.id, detail: `${pending.id} is still ${pending.state}; clear or wait for it first` };
    return submitLocked(deps, ledger, "bind", null);
  });
}

/** Operator decision: stop tracking an open submission, or lift a halt.
 *  It does not cancel anything inside OpenClaw. */
export async function clearOpenClawSubmission(root: string, agentId: string, target: string, note: string, now: () => Date = () => new Date()): Promise<string> {
  return withLedgerLock(root, agentId, async () => {
    const ledger = await readLedger(root, agentId);
    if (target === "halt") {
      if (!ledger.halted) return "not halted";
      delete ledger.halted;
      await writeLedger(root, ledger);
      return "halt cleared; future wakes allowed";
    }
    const sub = ledger.submissions.find((s) => s.id === target);
    if (!sub) throw new Error(`no submission ${target} for ${agentId}`);
    if (!OPEN_STATES.has(sub.state)) return `${target} is already ${sub.state}`;
    touch(sub, now(), { state: "cleared", cleared_note: note || "cleared by operator" });
    await writeLedger(root, ledger);
    return `${target} cleared (was open); it is not cancelled in OpenClaw`;
  });
}

/** Operator decision: allow one more wake for the unread set a finished
 *  submission already woke (its turn ran but never read the inbox). Only a
 *  terminal submission can be re-armed, and nothing is sent here; the next
 *  pass submits one new wake if that mail is still unread. */
export async function rearmOpenClawWake(root: string, agentId: string, target: string, note: string, now: () => Date = () => new Date()): Promise<string> {
  return withLedgerLock(root, agentId, async () => {
    const ledger = await readLedger(root, agentId);
    const sub = ledger.submissions.find((s) => s.id === target);
    if (!sub) throw new Error(`no submission ${target} for ${agentId}`);
    if (OPEN_STATES.has(sub.state)) return `${target} is still ${sub.state}; clear it first if you are sure it will not run`;
    if (!sub.signature) return `${target} carries no unread set; nothing to re-arm`;
    touch(sub, now(), { signature: null, cleared_note: note || "re-armed by operator" });
    await writeLedger(root, ledger);
    return `${target} re-armed; the next pass may wake ${agentId} once more for that mail`;
  });
}

/** The real Gateway for operator commands, or why it cannot be used. */
function cliGateway(env?: NodeJS.ProcessEnv): OpenClawGateway | string {
  const shell = agentShellRefusal(env ?? process.env);
  if (shell) return shell;
  const runtime = resolveOpenClawRuntime(env);
  return runtime.nodeBinDir ? new OpenClawCliGateway({ runtime, env }) : runtime.problem!;
}

/** Operator reconciliation (status): read custody for open submissions even
 *  while wakes are off, so a bind can settle without enabling wakes. Reads
 *  sessions.describe and chat.history only; submits nothing. */
export async function reconcileOpenClawAgent(opts: { root: string; agentId: string; gateway?: OpenClawGateway; env?: NodeJS.ProcessEnv;
  now?: () => Date }): Promise<string | null> {
  return withLedgerLock(opts.root, opts.agentId, async () => {
    const ledger = await readLedger(opts.root, opts.agentId);
    if (!openSummary(ledger)) return null;
    const gateway = opts.gateway ?? cliGateway(opts.env);
    if (typeof gateway === "string") return gateway;
    try {
      if (await reconcileLocked({ root: opts.root, agentId: opts.agentId, gateway, now: opts.now }, ledger)) await writeLedger(opts.root, ledger);
      return null;
    } catch (e) {
      return `could not read custody: ${e instanceof Error ? e.message : String(e)}`;
    }
  });
}
