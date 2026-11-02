// shared/openclaw-state.ts
// Durable state shared by the OpenClaw wake pass (wake-daemon.ts), the
// operator CLI, and the OpenClaw agent-peers child (openclaw-server.ts).
// bd-b2in.17; design and evidence in docs/components/openclaw-peer.md.
//
// Layout under the OpenClaw coordination root (~/.agent-peers-openclaw, or
// AGENT_PEERS_STATE_DIR / AGENT_PEERS_OPENCLAW_STATE_DIR):
//   wake/enabled               one OpenClaw agent id per line; absent = no wakes
//   wake/<agent>.ledger.json   every submission into agent:<agent>:main
//   wake/<agent>.lock          read-modify-write lock for that ledger
//   bindings/<agent>.json      the Codex thread proven to run agent:<agent>:main
//   name-claims/               one live owner per durable peer name
//
// The ledger is the custody record Marco's review asked for (AP10809 #2):
// intent and submission identity are on disk, fsynced, BEFORE chat.send runs,
// and an uncertain submission stays "unknown" until an operator clears it.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { link, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensurePrivateDir } from "./file-state.ts";
import { isProcessAlive } from "./process-liveness.ts";
import { resolveStateDir } from "./state-dir.ts";

export const OPENCLAW_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** A wake token proves the main session for this long after its submission. */
export const WAKE_TOKEN_TTL_MS = 24 * 60 * 60_000;

export function normalizeAgentId(raw: string | undefined | null): string | null {
  const id = (raw ?? "").trim().toLowerCase();
  return OPENCLAW_AGENT_ID.test(id) ? id : null;
}

/** The only session this integration ever submits into (proposal: a
 *  dedicated, channel-unbound agent and its main session). */
export function mainSessionKey(agentId: string): string {
  return `agent:${agentId}:main`;
}

export function openclawRoot(env: NodeJS.ProcessEnv = process.env, rootDir?: string): string {
  return resolveStateDir({ runtime: "openclaw", kind: "coordination", env, rootDir });
}

/** The kill switch: <root>/disabled. While it exists no OpenClaw child serves
 *  mail and no pass or bind submits anything (state and mail stay intact). */
export function openclawDisabled(root: string): boolean {
  return existsSync(join(root, "disabled"));
}

export function enabledAgents(root: string): Set<string> {
  try {
    const text = readFileSync(join(root, "wake", "enabled"), "utf8");
    return new Set(text.split("\n").map((l) => normalizeAgentId(l.replace(/#.*/, ""))).filter((a): a is string => !!a));
  } catch {
    return new Set();
  }
}

export function tokenHash(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Ledger

export type SubmissionState =
  /** Written before chat.send. Seen again only if the daemon died mid-call. */
  | "intent"
  /** The Gateway acknowledged the runId, or custody shows it pending. */
  | "accepted"
  /** We cannot tell whether the Gateway holds it. Never resubmitted. */
  | "unknown"
  /** Custody shows the input became a transcript turn. Terminal. */
  | "consumed"
  /** Custody shows it cancelled before it ran. Terminal. */
  | "cancelled"
  /** An operator decided an accepted/unknown submission needs no more tracking. */
  | "cleared";

export const OPEN_STATES: ReadonlySet<SubmissionState> = new Set(["intent", "accepted", "unknown"]);

export interface Submission {
  /** chat.send idempotencyKey, which OpenClaw also uses as the runId. */
  id: string;
  kind: "wake" | "bind";
  /** Hash of the one-time token in the wake text. The token itself is never
   *  stored: the session's transcript is the only place it exists. */
  token_sha256: string;
  session_key: string;
  /** sessions.describe sessionId observed just before submitting; custody
   *  receipts are scoped to it. */
  session_id: string;
  /** Sorted unread ids that prompted a wake; null for an operator bind. */
  signature: string | null;
  state: SubmissionState;
  created_at: string;
  updated_at: string;
  detail?: string;
  ack?: { status: string; messageSeq?: number };
  cleared_note?: string;
}

export interface WakeLedger {
  version: 1;
  agent_id: string;
  submissions: Submission[];
  /** Set when OpenClaw reports something this integration must never cause
   *  (an interrupted active run). Wakes stay off until an operator clears it. */
  halted?: { reason: string; at: string };
}

export function ledgerPath(root: string, agentId: string): string {
  return join(root, "wake", `${agentId}.ledger.json`);
}

export async function readLedger(root: string, agentId: string): Promise<WakeLedger> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(root, agentId), "utf8")) as WakeLedger;
    if (parsed?.version === 1 && Array.isArray(parsed.submissions)) return parsed;
    throw new Error("unrecognized ledger format");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1, agent_id: agentId, submissions: [] };
    // Fail closed: a corrupt ledger must never read as "nothing outstanding".
    throw new Error(`OpenClaw wake ledger for ${agentId} is unreadable (${e instanceof Error ? e.message : String(e)}); fix or move it aside before any wake`);
  }
}

/** Atomic and fsynced: the intent must survive a crash or power loss that
 *  happens after chat.send has left the process. */
export async function writeJsonDurable(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await ensurePrivateDir(dir);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(tempPath, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2), "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(tempPath, path);
  } catch (e) {
    await unlink(tempPath).catch(() => {});
    throw e;
  }
  try {
    const d = await open(dir, "r");
    try { await d.sync(); } finally { await d.close(); }
  } catch { /* directory fsync is unsupported on some filesystems */ }
}

export async function writeLedger(root: string, ledger: WakeLedger): Promise<void> {
  await writeJsonDurable(ledgerPath(root, ledger.agent_id), ledger);
}

export function ledgerLockPath(root: string, agentId: string): string {
  return join(root, "wake", `${agentId}.lock`);
}

export class LedgerLockedError extends Error {}

/** Who holds the lock, for status and errors; null when it is free. Names a
 *  dead holder so the manual clearance below is visible. */
export async function ledgerLockDetail(root: string, agentId: string): Promise<string | null> {
  let raw: string;
  try { raw = await readFile(ledgerLockPath(root, agentId), "utf8"); } catch { return null; }
  let pid = Number.NaN;
  try { pid = Number((JSON.parse(raw) as { pid?: unknown }).pid); } catch { /* unreadable */ }
  return Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)
    ? `wake ledger lock for ${agentId} is held by dead pid ${pid}; see "Clearing a dead lock" in docs/components/openclaw-peer.md`
    : `wake ledger lock for ${agentId} is held by ${Number.isInteger(pid) ? `pid ${pid}` : "an unreadable owner"}; next tick`;
}

/** Serialize ledger read-modify-write between the daemon and the CLI.
 *  Same rule as the Hermes Desktop lock (2d47fe1, Marco AP10817/AP10842):
 *  the lock only ever appears complete (a private temp file link()ed into
 *  place, which fails if one exists); acquire fails closed whenever it
 *  exists, whatever its content and whether its holder is alive. Nothing
 *  reaps it, because a reaper racing a fresh owner can leave two owners and
 *  two submissions. A crashed holder's lock blocks only its agent until an
 *  operator clears it. Release removes the lock only while it still carries
 *  this owner's token. */
export async function withLedgerLock<T>(root: string, agentId: string, fn: () => Promise<T>, waitMs = 10_000): Promise<T> {
  const lockPath = ledgerLockPath(root, agentId);
  await ensurePrivateDir(dirname(lockPath));
  const body = JSON.stringify({ pid: process.pid, token: randomUUID(), at: new Date().toISOString() });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const tmp = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, body, { mode: 0o600, flag: "wx" });
    let acquired = false;
    try {
      await link(tmp, lockPath);
      acquired = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    } finally {
      await unlink(tmp).catch(() => {});
    }
    if (acquired) break;
    if (Date.now() >= deadline) {
      throw new LedgerLockedError(await ledgerLockDetail(root, agentId) ?? `wake ledger lock for ${agentId} is busy; next tick`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    return await fn();
  } finally {
    const current = await readFile(lockPath, "utf8").catch(() => null);
    if (current === body) await unlink(lockPath).catch(() => {});
  }
}

/** A token proves "this call came from a turn that read agent:<id>:main's
 *  input" only while its submission exists and has not been withdrawn. */
export function findSubmissionByToken(ledger: WakeLedger, token: string, now: Date = new Date()): Submission | null {
  const hash = tokenHash(token);
  const sub = ledger.submissions.find((s) => s.token_sha256 === hash);
  if (!sub || sub.state === "cancelled" || sub.state === "cleared") return null;
  const age = now.getTime() - Date.parse(sub.created_at);
  return Number.isFinite(age) && age >= 0 && age <= WAKE_TOKEN_TTL_MS ? sub : null;
}

// ---------------------------------------------------------------------------
// Binding

export interface OpenClawBinding {
  version: 1;
  agent_id: string;
  session_key: string;
  /** The OpenClaw sessionId recorded on the proving submission. */
  session_id: string;
  /** Codex thread id (MCP tools/call _meta.threadId) proven to run main. */
  thread_id: string;
  /** Submission whose token proved it, and that submission's created_at:
   *  only a strictly newer submission's token may move the binding. */
  proven_by: string;
  proven_at_submission?: string;
  proven_at: string;
  peer_name?: string;
  peer_id?: string;
}

export function bindingPath(root: string, agentId: string): string {
  return join(root, "bindings", `${agentId}.json`);
}

export async function readBinding(root: string, agentId: string): Promise<OpenClawBinding | null> {
  try {
    const parsed = JSON.parse(await readFile(bindingPath(root, agentId), "utf8")) as OpenClawBinding;
    return parsed?.version === 1 && typeof parsed.thread_id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeBinding(root: string, binding: OpenClawBinding): Promise<void> {
  await writeJsonDurable(bindingPath(root, binding.agent_id), binding);
}
