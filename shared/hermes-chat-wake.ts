// shared/hermes-chat-wake.ts
// Chat-level Hermes addressing and wake, on stock Hermes only.
//
//   HermesChatDirectory  resolves "valentina-hermes/Instagram ads" to one exact
//                        Hermes session by reading the profile's state.db read-only.
//   wakeHermesChat       opens that chat in the always-on gateway and runs one turn:
//                          hermes -p <profile> chat --resume <session-id> -q "<wake text>"
//                        (the general mailbox uses the profile's "Agent Peers" chat,
//                        created on first use with -c "Agent Peers" --create-if-missing).
//
// Everything here was verified against Hermes v0.22.5 on the Studio
// (kepler-maintainer/KEPLER/receipts/2026-10-31-hermes-wake-evidence/chat-level-path.md,
// sections 7 and 8). The facts that shape the code:
//
// - Hermes resolves titles exactly (no case folding, no substring), so the directory
//   matches case-insensitively here and the wake always passes a session id.
// - A chat Mike has typed into and left open in Desktop holds a slot in
//   ~/.hermes/profiles/<p>/runtime/active_sessions.json; the gateway refuses a wake
//   into it ("This chat is open in another Hermes window/terminal"). The daemon reads
//   that file on every tick and waits; closing the chat releases the wake within one
//   tick. Only launches that actually failed use the 5m/30m/2h ladder.
// - Two executors on one chat are serialized by Hermes's own cross-process turn lease
//   (session_turn_leases); the wake waits behind a live lease instead of racing it.
// - The `-q` client may print "Gateway disconnected; turn outcome is unknown" while the
//   gateway finishes the turn. The durable session_admissions row is the truth; the CLI
//   exit code never is.
// - A Desktop turn killed mid-flight leaves an unanswered user row; the next wake
//   executes it. When the tail of the transcript is a bare user message the wake text
//   says so, so the agent confirms before acting on it.
//
// State is daemon-owned JSON under <stateDir>/chat-wake/<profile>/: one ledger per chat
// and per-attempt CLI logs under logs/. The broker stores no wake state.
//
// A chat open in Hermes Desktop is woken by the in-process plugin
// hermes-plugins/agent-peers-desktop-wake instead. It shares these ledgers: it records a
// desktop_attempt (intent, then accepted or unknown) around ctx.inject_message, and both
// executors take <ledger>.lock for every read-modify-write. While a desktop attempt is open
// this driver never launches. Settlement uses only the plugin's correlated turn-lifecycle
// evidence (its pre_llm_call / post_llm_call hooks, written under <dir>/evidence/); transcript
// rows, absence and timeouts never settle anything (classifyDesktopAttempt, mirrored in the
// plugin). Uncertain or unreadable evidence is "unknown" and blocks every re-wake of that chat
// until an operator runs `cli.ts hermes-desktop-clear`. Cancellation survives settlement.

import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { link, open, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GENERAL_MAILBOX, type ChatCandidate, type ChatDirectory, type ChatPeer, type ChatResolution } from "./chat-directory.ts";
import { atomicWriteJson, ensurePrivateDir } from "./file-state.ts";
import { personaOf } from "./peer-address.ts";

export const GENERAL_CHAT_TITLE = "Agent Peers";
export const DEFAULT_HERMES_CHAT_WAKE_BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
export const DEFAULT_HERMES_CHAT_WAKE_DEADLINE_MS = 30 * 60_000;
// What a human picker shows (hermes_state_sessions._session_filter_where): the local chat sources
// minus INTERNAL_LISTING_SOURCES (kanban, tool, oneshot: cron ticks and workers), minus sub-agent
// runs (a _delegate_from marker), minus compression continuations (collapsed to their root here).
// Branch and reset children stay visible as their own chats. Messaging rows (email, telegram, ...)
// are never chat addresses. An exact id still resolves anything, so mail to a known key is kept.
const ADDRESSABLE_SOURCES = ["cli", "tui", "gui", "desktop", "acp", "local"];
const SOURCE_LIST_SQL = ADDRESSABLE_SOURCES.map((s) => `'${s}'`).join(",");
const LISTABLE_SQL = `source IN (${SOURCE_LIST_SQL}) AND COALESCE(archived, 0) = 0 AND json_extract(model_config, '$._delegate_from') IS NULL`;
const EXIT_MARKER = "__HERMES_CHAT_WAKE_EXIT=";
const LAST_ACTIVE_SQL = "COALESCE(last_activity_at, started_at)";

// ---------------------------------------------------------------------------
// Paths and small helpers

export function hermesProfileHome(hermesHome: string, profile: string): string {
  return profile === "default" ? hermesHome : join(hermesHome, "profiles", profile);
}

function stateDbPath(hermesHome: string, profile: string): string {
  return join(hermesProfileHome(hermesHome, profile), "state.db");
}

function registryPath(hermesHome: string, profile: string): string {
  return join(hermesProfileHome(hermesHome, profile), "runtime", "active_sessions.json");
}

function defaultHermesHome(): string {
  return process.env.HERMES_HOME ?? join(homedir(), ".hermes");
}

function defaultStateDir(): string {
  return process.env.AGENT_PEERS_STATE_DIR ?? process.env.AGENT_PEERS_HERMES_STATE_DIR ?? join(homedir(), ".agent-peers-hermes");
}

function hashId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isoFromEpoch(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

/** The Hermes profile a peer row stands for: `valentina-hermes` reads valentina's state.db. */
export function hermesProfileForPeer(peer: ChatPeer): string | null {
  // Durable Hermes names are "<profile>-hermes" (PEER_NAME in each profile's
  // MCP config), which is exact; the persona is only a fallback.
  const named = /^([a-z0-9][a-z0-9_-]*)-hermes$/i.exec(peer.name);
  if (named) return named[1]!.toLowerCase();
  return personaOf(peer);
}

function openReadOnly(path: string): Database | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    return db;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lineage: a compressed chat is a chain of session rows; the root id is the chat key

interface SessionRow {
  id: string;
  title: string | null;
  source: string;
  parent_session_id: string | null;
  end_reason: string | null;
  archived: number | null;
  model_config: string | null;
  last_active: number | null;
}

const ROW_SQL = `id, title, source, parent_session_id, end_reason, archived, model_config, ${LAST_ACTIVE_SQL} AS last_active`;

function getRow(db: Database, id: string): SessionRow | null {
  return db.query(`SELECT ${ROW_SQL} FROM sessions WHERE id = ?`).get(id) as SessionRow | null;
}

/** Same rule as hermes_state_messages._is_explicit_fork_child_row: a fork marker pointing at the parent. */
function isForkChild(row: SessionRow): boolean {
  if (row.source === "tool") return true;
  if (!row.model_config) return false;
  let cfg: unknown;
  try { cfg = JSON.parse(row.model_config); } catch { return false; }
  if (!cfg || typeof cfg !== "object") return false;
  const c = cfg as Record<string, unknown>;
  const markers = [c._branched_from, c._delegate_from, c._reset_from];
  return row.parent_session_id ? markers.includes(row.parent_session_id) : markers.some((m) => m != null);
}

function isCompressionChild(db: Database, row: SessionRow): boolean {
  if (!row.parent_session_id || isForkChild(row)) return false;
  const parent = getRow(db, row.parent_session_id);
  return parent?.end_reason === "compression";
}

/** Compression-lineage root of a session (the chat key; the gateway projects it to the tip on resume). */
export function lineageRoot(db: Database, sessionId: string): string {
  let row = getRow(db, sessionId);
  if (!row) return sessionId;
  const seen = new Set([row.id]);
  while (isCompressionChild(db, row)) {
    const parent = getRow(db, row.parent_session_id!);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    row = parent;
  }
  return row.id;
}

/** Tip of the lineage: where new messages land. */
export function lineageTip(db: Database, rootId: string): string {
  let current = getRow(db, rootId);
  const seen = new Set<string>();
  while (current && current.end_reason === "compression" && !seen.has(current.id)) {
    seen.add(current.id);
    const children = db.query(`SELECT ${ROW_SQL} FROM sessions WHERE parent_session_id = ? ORDER BY started_at ASC`).all(current.id) as SessionRow[];
    const next = children.find((child) => !isForkChild(child));
    if (!next) break;
    current = next;
  }
  return current?.id ?? rootId;
}

/** Every stored session of a chat, root to tip (compression continuations only). */
export function lineageIds(db: Database, rootId: string): string[] {
  const ids = [rootId];
  let current = getRow(db, rootId);
  const seen = new Set<string>([rootId]);
  while (current && current.end_reason === "compression") {
    const children = db.query(`SELECT ${ROW_SQL} FROM sessions WHERE parent_session_id = ? ORDER BY started_at ASC`).all(current.id) as SessionRow[];
    const next = children.find((child) => !isForkChild(child));
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    ids.push(next.id);
    current = next;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Registry: who holds the chat open right now

interface RegistryEntry { session_id?: string; surface?: string; pid?: number | string; started_at?: string }

function readRegistry(hermesHome: string, profile: string): RegistryEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(hermesHome, profile), "utf8")) as { entries?: RegistryEntry[] } | RegistryEntry[];
    return Array.isArray(parsed) ? parsed : parsed.entries ?? [];
  } catch {
    return [];
  }
}

/** Registry entries; [] when the file is absent; null when it exists but cannot be read. */
function readRegistryStrict(hermesHome: string, profile: string): RegistryEntry[] | null {
  let text: string;
  try {
    text = readFileSync(registryPath(hermesHome, profile), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  try {
    const parsed = JSON.parse(text) as { entries?: RegistryEntry[] } | RegistryEntry[];
    const entries = Array.isArray(parsed) ? parsed : parsed.entries;
    return Array.isArray(entries) ? entries : null;
  } catch {
    return null;
  }
}

/** Whether process `pid` holds the slot of any of `sessionIds`; null when the registry is unreadable. */
export function registryHeldBy(hermesHome: string, profile: string, sessionIds: string[], pid: number): boolean | null {
  const entries = readRegistryStrict(hermesHome, profile);
  if (entries === null) return null;
  const wanted = new Set(sessionIds);
  return entries.some((e) => wanted.has(String(e.session_id ?? "")) && Number(e.pid) === pid);
}

/** The live holder of a chat's active-session slot, or null. A dead pid is a stale entry, not a holder. */
export function registryHolder(hermesHome: string, profile: string, sessionId: string, alive: (pid: number) => boolean = pidAlive): string | null {
  for (const entry of readRegistry(hermesHome, profile)) {
    if (String(entry.session_id ?? "") !== sessionId) continue;
    const pid = Number(entry.pid);
    if (!Number.isInteger(pid) || alive(pid)) return `${entry.surface ?? "another surface"}${Number.isInteger(pid) ? ` (pid ${pid})` : ""}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Directory

export interface HermesChatDirectoryOptions {
  hermesHome?: string;
  profileForPeer?: (peer: ChatPeer) => string | null;
}

export class HermesChatDirectory implements ChatDirectory {
  private readonly hermesHome: string;
  private readonly profileForPeer: (peer: ChatPeer) => string | null;

  constructor(opts: HermesChatDirectoryOptions = {}) {
    this.hermesHome = opts.hermesHome ?? defaultHermesHome();
    this.profileForPeer = opts.profileForPeer ?? hermesProfileForPeer;
  }

  resolve(peer: ChatPeer, query: string): ChatResolution {
    const profile = this.profileForPeer(peer);
    if (!profile) return { ok: false, error: `${peer.name} is not a Hermes profile peer; it has no chats to address.`, candidates: [] };
    const db = openReadOnly(stateDbPath(this.hermesHome, profile));
    if (!db) return { ok: false, error: `no Hermes state for profile "${profile}" on this machine.`, candidates: [] };
    try {
      return resolveInProfile(db, profile, query, (id) => registryHolder(this.hermesHome, profile, id) !== null);
    } finally {
      db.close();
    }
  }

  list(peer: ChatPeer, opts: { query?: string; limit: number; offset: number }): ChatCandidate[] {
    const profile = this.profileForPeer(peer);
    if (!profile) return [];
    const db = openReadOnly(stateDbPath(this.hermesHome, profile));
    if (!db) return [];
    try {
      const q = (opts.query ?? "").trim().toLowerCase();
      const rows = db.query(
        `SELECT ${ROW_SQL} FROM sessions WHERE ${LISTABLE_SQL}`
        + (q ? " AND title IS NOT NULL AND instr(lower(title), ?) > 0" : "")
        + ` ORDER BY ${LAST_ACTIVE_SQL} DESC`,
      ).all(...(q ? [q] : [])) as SessionRow[];
      const out: ChatCandidate[] = [];
      const seen = new Set<string>();
      let skipped = 0;
      for (const row of rows) {
        const root = lineageRoot(db, row.id);
        if (seen.has(root)) continue;
        seen.add(root);
        if (skipped < opts.offset) { skipped++; continue; }
        out.push(candidate(row, root, registryHolder(this.hermesHome, profile, root) !== null));
        if (out.length >= opts.limit) break;
      }
      return out;
    } finally {
      db.close();
    }
  }
}

function candidate(row: SessionRow, root: string, busy: boolean): ChatCandidate {
  return { chat_key: root, title: row.title, last_active: isoFromEpoch(row.last_active), busy, archived: Boolean(row.archived) };
}

/**
 * Exact session id or chat key first (archived rows still resolve by id: mail to a known key is
 * never dropped), then an exact case-insensitive trimmed title among live addressable chats. One
 * match resolves; several are ambiguous; none returns up to five substring near-misses, newest first.
 */
export function resolveInProfile(db: Database, profile: string, query: string, busyOf: (root: string) => boolean = () => false): ChatResolution {
  const wanted = query.trim();
  if (!wanted) return { ok: false, error: `empty chat address for ${profile}.`, candidates: [] };
  if (wanted.toLowerCase() === GENERAL_MAILBOX) {
    return { ok: false, error: `"${GENERAL_MAILBOX}" is the profile mailbox, not a chat; send to the peer without a chat.`, candidates: [] };
  }
  const byId = getRow(db, wanted);
  if (byId) {
    const root = lineageRoot(db, byId.id);
    return { ok: true, chat_key: root, title: (getRow(db, lineageTip(db, root)) ?? byId).title };
  }
  const exact = db.query(
    `SELECT ${ROW_SQL} FROM sessions WHERE title IS NOT NULL AND lower(trim(title)) = lower(?) `
    + `AND ${LISTABLE_SQL} ORDER BY ${LAST_ACTIVE_SQL} DESC`,
  ).all(wanted) as SessionRow[];
  const roots = new Map<string, SessionRow>();
  for (const row of exact) {
    const root = lineageRoot(db, row.id);
    if (!roots.has(root)) roots.set(root, row);
  }
  if (roots.size === 1) {
    const [root, row] = [...roots.entries()][0]!;
    return { ok: true, chat_key: root, title: row.title };
  }
  if (roots.size > 1) {
    const candidates = [...roots.entries()].map(([root, row]) => candidate(row, root, busyOf(root)));
    return { ok: false, error: `${profile} has ${roots.size} chats titled "${wanted}"; use the chat ID.`, candidates };
  }
  const near = db.query(
    `SELECT ${ROW_SQL} FROM sessions WHERE title IS NOT NULL AND instr(lower(title), lower(?)) > 0 `
    + `AND ${LISTABLE_SQL} ORDER BY ${LAST_ACTIVE_SQL} DESC LIMIT 40`,
  ).all(wanted) as SessionRow[];
  const nearRoots = new Map<string, SessionRow>();
  for (const row of near) {
    const root = lineageRoot(db, row.id);
    if (!nearRoots.has(root)) nearRoots.set(root, row);
    if (nearRoots.size === 5) break;
  }
  const candidates = [...nearRoots.entries()].map(([root, row]) => candidate(row, root, busyOf(root)));
  return { ok: false, error: `no chat titled "${wanted}" for ${profile}.`, candidates };
}

// ---------------------------------------------------------------------------
// Wake ledger

export type HermesChatWakeState =
  | "launched"         // this call started a hermes turn
  | "running"          // an earlier attempt is still in flight
  | "done"             // the latest mail (max_id) has been handled by a completed turn
  | "waiting_desktop"  // chat open in Desktop or a terminal, or a desktop wake is open; re-checked every tick
  | "desktop_unknown"  // a desktop-plugin wake may or may not have run; no re-wake until resolved
  | "waiting_turn"     // another executor holds the turn lease; re-checked every tick
  | "waiting_gateway"  // the gateway already holds work for this chat; re-checked every tick
  | "cooldown"         // a launch failed; next attempt at nextAttemptAt
  | "input_required"   // the turn parked on a question or approval; no re-wake until new mail
  | "exhausted"        // ladder spent for this mail; visible pending status
  | "cancelled"        // an operator stopped wakes for this chat
  | "not_found"        // chat key no longer exists in state.db
  | "no_profile";      // peer name does not map to a Hermes profile

export interface HermesChatWakeLaunch {
  pid: number;
  started_at: string;
  deadline_at: string;
  log_path: string;
  admission_seq_before: number;
  max_id: number;
  exit_code?: number | null;
}

export interface HermesChatWakeLedger {
  peer_name: string;
  profile: string;
  chat_key: string | null;      // null = general mailbox
  session_id: string | null;    // resolved session; null until the general chat exists
  title: string | null;
  state: HermesChatWakeState;
  handled_max_id: number;       // mail up to this id reached a completed turn
  launched_max_id: number;      // mail up to this id was in a launched turn
  attempts: number;             // failed launches on the current mail
  next_attempt_at: string | null;
  last_launch: HermesChatWakeLaunch | null;
  last_admission_id: string | null;
  detail: string;
  updated_at: string;
  /** Open wake by the in-process Desktop plugin; while set, this driver never launches. */
  desktop_attempt?: HermesDesktopAttempt | null;
  last_desktop_attempt?: HermesDesktopAttemptRecord | null;
}

export type HermesDesktopAttemptState = "intent" | "accepted" | "unknown";

/** Written by the plugin before ctx.inject_message ("intent") and after it returned True
 *  ("accepted": queued in the open chat, not handled). Same JSON in Python and TypeScript. */
export interface HermesDesktopAttempt {
  attempt_id: string;
  chat_key: string;
  session_key: string;   // the stored session id the Desktop backend hosts (its registry entry)
  max_id: number;        // broker mail up to this id is what the wake covers
  host_pid: number;      // the Desktop backend process whose in-memory queue holds the wake
  host_start?: string | null; // `ps -o lstart=` of host_pid when the attempt was made (pid-reuse guard)
  state: HermesDesktopAttemptState;
  created_at: string;
  accepted_at: string | null;
  detail: string;
}

export interface HermesDesktopAttemptRecord extends HermesDesktopAttempt {
  outcome: "handled" | "not_submitted" | "cleared" | "cleared_handled";
  resolved_at: string;
}

/** handled: the plugin saw the end of the wake's own turn. running: it saw that turn start and the
 *  host is alive. pending: accepted (or just written) in a live host that still holds the chat.
 *  unknown: anything else; it blocks every re-wake of the chat until an operator clears it. */
export type HermesDesktopVerdict = "handled" | "running" | "pending" | "unknown";

/** One lifecycle event the plugin's hook recorded for the wake's own turn. */
export interface HermesDesktopEvidenceEvent {
  attempt_id: string;
  kind: "started" | "ended";
  turn_id: string | null;
  session_id: string;
  pid: number;
  at: string;
}

export interface HermesDesktopEvidence {
  started: HermesDesktopEvidenceEvent | null;
  ended: HermesDesktopEvidenceEvent | null;
}

/** How long a just-written intent (the plugin's own call in flight) counts as pending. */
export const DESKTOP_INTENT_PENDING_MS = 60_000;

export interface HermesChatWakeRequest {
  peerName: string;
  profile: string;
  chatKey: string | null;
  title: string | null;
  unread: number;
  maxId: number;
  wakeText?: string;
}

export interface HermesChatWakeOutcome {
  state: HermesChatWakeState;
  detail: string;
  nextAttemptAt?: string;
  sessionId?: string | null;
  pid?: number;
}

export interface HermesChatWakeOptions {
  hermesHome?: string;
  stateDir?: string;
  hermesBin?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  backoffScheduleMs?: number[];
  deadlineMs?: number;
  pidAlive?: (pid: number) => boolean;
  /** Start-time probe for the pid-reuse guard on desktop hosts (tests inject one). */
  processStart?: (pid: number) => string | null;
  /** Title of the chat that reads the profile's general mailbox. */
  generalChatTitle?: string;
}

export function defaultWakeText(peerName: string, chatKey: string | null, title: string | null, interruptedTail: boolean): string {
  const where = chatKey ? `the chat "${title ?? chatKey}" (chat ${chatKey})` : `your general Agent Peers mailbox`;
  const chatArg = chatKey ? ` with chat="${chatKey}"` : "";
  const warning = interruptedTail
    ? " Note: the last message in this chat is a user message whose turn was interrupted before it was answered; confirm with Mike before acting on it."
    : "";
  // Verified 2026-10-31: on a -q turn the clarify tool is answered headless ("no user available,
  // use your own judgment") and approvals are off on every fleet profile, so a question for Mike
  // never parks the turn. The agent must therefore hand it back instead of deciding.
  return `Agent Peers: ${peerName} has unread peer mail addressed to ${where}. Call check_messages${chatArg}, handle what it returns, and reply with send_message from this chat. If handling it needs a decision only Mike can make, do not decide it yourself: tell the peer Mike must be asked, and leave the question in this chat for him.${warning}`;
}

function ledgerName(chatKey: string | null): string {
  return `${hashId(chatKey ?? GENERAL_MAILBOX)}.json`;
}

function emptyLedger(req: HermesChatWakeRequest, now: Date): HermesChatWakeLedger {
  return {
    peer_name: req.peerName, profile: req.profile, chat_key: req.chatKey, session_id: null, title: req.title,
    state: "done", handled_max_id: 0, launched_max_id: 0, attempts: 0, next_attempt_at: null, last_launch: null,
    last_admission_id: null, detail: "new", updated_at: now.toISOString(),
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Desktop-plugin attempts (same rules as hermes-plugins/agent-peers-desktop-wake)

export function desktopEvidencePath(stateDir: string, profile: string, attemptId: string, kind: "started" | "ended"): string {
  return join(stateDir, "chat-wake", profile, "evidence", `${attemptId}.${kind}.json`);
}

/** The plugin's recorded events for an attempt; null when evidence exists but cannot be read. */
export function readDesktopEvidence(stateDir: string, profile: string, attemptId: string): HermesDesktopEvidence | null {
  const out: HermesDesktopEvidence = { started: null, ended: null };
  for (const kind of ["started", "ended"] as const) {
    let text: string;
    try {
      text = readFileSync(desktopEvidencePath(stateDir, profile, attemptId, kind), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    try {
      const value = JSON.parse(text) as HermesDesktopEvidenceEvent;
      if (!value || value.attempt_id !== attemptId) return null;
      out[kind] = value;
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * Settle a desktop attempt from positive, correlated evidence only (Kepler §20 as amended,
 * AP10808; Marco AP10806). "ended" is written by the plugin's post_llm_call hook, only when
 * that turn's own prompt carries this attempt's marker. It means the wake's turn ended, not that
 * it succeeded or persisted: Hermes also fires post_llm_call on failed turns (bd-b2in.22, before
 * D). Transcript rows,
 * finish_reason, absence of evidence, a closed chat and timeouts settle nothing: whatever is not
 * proven is pending (still plausibly queued) or unknown (operator adjudication).
 */
export function classifyDesktopAttempt(
  evidence: HermesDesktopEvidence | null, attempt: HermesDesktopAttempt, hostAlive: boolean, heldByHost: boolean | null, nowMs: number,
): HermesDesktopVerdict {
  if (evidence === null) return "unknown";
  if (evidence.ended) return "handled";
  if (evidence.started) return hostAlive ? "running" : "unknown";
  if (attempt.state === "unknown" || !hostAlive) return "unknown";
  if (attempt.state === "intent") return nowMs - Date.parse(attempt.created_at) <= DESKTOP_INTENT_PENDING_MS ? "pending" : "unknown";
  if (heldByHost === null) return "unknown";
  return heldByHost ? "pending" : "unknown";
}

/** Apply a verdict in place; returns the state and detail to save. A cancelled ledger stays cancelled. */
export function applyDesktopVerdict(ledger: HermesChatWakeLedger, verdict: HermesDesktopVerdict, now: Date): [HermesChatWakeState, string] {
  const attempt = ledger.desktop_attempt!;
  const id = attempt.attempt_id.slice(0, 8);
  let result: [HermesChatWakeState, string];
  switch (verdict) {
    case "handled":
      // The desktop turn counts as the launch for this mail, so the gateway path's
      // "already handled" check (launched_max_id) sees it too.
      ledger.handled_max_id = Math.max(ledger.handled_max_id, attempt.max_id);
      ledger.launched_max_id = Math.max(ledger.launched_max_id, attempt.max_id);
      ledger.attempts = 0;
      ledger.next_attempt_at = null;
      ledger.last_desktop_attempt = { ...attempt, outcome: "handled", resolved_at: now.toISOString() };
      ledger.desktop_attempt = null;
      result = ["done", `desktop wake ${id} reached the end of its own turn`];
      break;
    case "unknown":
      attempt.state = "unknown";
      result = ["desktop_unknown", `desktop wake ${id} outcome unknown; no re-wake until cli.ts hermes-desktop-clear`];
      break;
    case "running":
      result = ["waiting_desktop", `desktop wake ${id} turn started in pid ${attempt.host_pid}`];
      break;
    default:
      result = ["waiting_desktop", `desktop wake ${id} is ${attempt.state} in pid ${attempt.host_pid}`];
  }
  if (ledger.state === "cancelled") return ["cancelled", `wakes stopped by operator; ${result[1]}`];
  return result;
}

/** Status for a held ledger lock; names a dead holder so the manual clearance is visible. */
async function lockedDetail(ledgerPath: string): Promise<string> {
  let pid = Number.NaN;
  try { pid = Number((JSON.parse(await readFile(`${ledgerPath}.lock`, "utf8")) as { pid?: unknown }).pid); } catch { /* unreadable */ }
  return Number.isInteger(pid) && !pidAlive(pid)
    ? `ledger lock held by dead pid ${pid}; see "Clearing a dead lock" in docs/components/hermes-desktop-wake.md`
    : "ledger locked by another executor; next tick";
}

/** `ps -o lstart=` for pid, whitespace-normalized; null when unavailable. Same string as the plugin. */
export function processStartTime(pid: number): string | null {
  try {
    const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
    const out = String(run.stdout ?? "").trim().split(/\s+/).join(" ");
    return run.status === 0 && out ? out : null;
  } catch {
    return null;
  }
}

let selfStartCache: string | null | undefined;
function selfStart(): string | null {
  if (selfStartCache === undefined) selfStartCache = processStartTime(process.pid);
  return selfStartCache;
}

/**
 * Exclusive lock beside a ledger, shared with the Python plugin. <ledger>.lock holds
 * {"pid","start","token"} and only ever appears complete: the owner writes a private temp file
 * and link()s it into place, which fails if a lock exists. Acquire fails closed whenever the lock
 * exists, whatever its content and whether or not its holder is alive. Nothing reaps it, because
 * a reaper racing a fresh owner can leave two owners (Marco AP10817); a crashed holder's lock
 * blocks only its chat until an operator clears it (docs/components/hermes-desktop-wake.md).
 * The release removes the lock only while it still carries our token.
 * Returns the release function, or null when the lock stayed held past the wait.
 */
export async function acquireLedgerLock(ledgerPath: string, waitMs = 2000): Promise<(() => Promise<void>) | null> {
  const lockPath = `${ledgerPath}.lock`;
  await ensurePrivateDir(dirname(lockPath));
  const body = JSON.stringify({ pid: process.pid, start: selfStart(), token: randomUUID() });
  const until = Date.now() + waitMs;
  for (;;) {
    const tmp = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, body, { mode: 0o600, flag: "wx" });
    let acquired = false;
    try {
      await link(tmp, lockPath);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
    if (acquired) {
      return async () => {
        const current = await readFile(lockPath, "utf8").catch(() => null);
        if (current === body) await unlink(lockPath).catch(() => undefined);
      };
    }
    if (Date.now() >= until) return null;
    await Bun.sleep(25);
  }
}

// ---------------------------------------------------------------------------
// CLI outcome classification

export type HermesCliVerdict = "done" | "busy_desktop" | "busy_turn" | "input_required" | "unknown" | "not_found" | "failed";

/** Map the `hermes chat -q` transcript and exit code to a verdict. Text wins over the exit code. */
export function classifyHermesCliOutput(exitCode: number | null, output: string): { verdict: HermesCliVerdict; reason: string } {
  const text = output.replace(/\s+/g, " ");
  if (/open in another Hermes window|session_already_owned|opened by [a-z:_-]+ \d+[smhd]? ago/i.test(text)) return { verdict: "busy_desktop", reason: "chat open elsewhere" };
  if (/runtime_coordination_required|Another Hermes process is using this session/i.test(text)) return { verdict: "busy_turn", reason: "turn lease held" };
  if (/Input required; detached without cancelling/i.test(text)) return { verdict: "input_required", reason: "turn is waiting for input" };
  if (/Unknown execution blocks this session/i.test(text)) return { verdict: "input_required", reason: "unknown execution needs discard" };
  if (/Gateway disconnected; turn outcome is unknown/i.test(text)) return { verdict: "unknown", reason: "client lost the gateway" };
  if (/No session found matching/i.test(text)) return { verdict: "not_found", reason: "session not found" };
  if (exitCode === 0) return { verdict: "done", reason: "turn complete" };
  if (exitCode === null) return { verdict: "unknown", reason: "no exit code recorded" };
  return { verdict: "failed", reason: `hermes exited ${exitCode}` };
}

// ---------------------------------------------------------------------------
// Driver

export class HermesChatWakeDriver {
  private readonly hermesHome: string;
  private readonly stateDir: string;
  private readonly hermesBin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly schedule: number[];
  private readonly deadlineMs: number;
  private readonly alive: (pid: number) => boolean;
  private readonly startOf: (pid: number) => string | null;
  private readonly generalChatTitle: string;
  private readonly children = new Map<number, { exitCode: number | null; done: boolean }>();

  constructor(opts: HermesChatWakeOptions = {}) {
    this.hermesHome = opts.hermesHome ?? defaultHermesHome();
    this.stateDir = opts.stateDir ?? defaultStateDir();
    this.hermesBin = opts.hermesBin ?? "hermes";
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.schedule = opts.backoffScheduleMs?.length ? opts.backoffScheduleMs : DEFAULT_HERMES_CHAT_WAKE_BACKOFF_MS;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_HERMES_CHAT_WAKE_DEADLINE_MS;
    this.alive = opts.pidAlive ?? pidAlive;
    this.startOf = opts.processStart ?? processStartTime;
    this.generalChatTitle = opts.generalChatTitle ?? GENERAL_CHAT_TITLE;
  }

  private dir(profile: string): string { return join(this.stateDir, "chat-wake", profile); }
  private ledgerPath(profile: string, chatKey: string | null): string { return join(this.dir(profile), ledgerName(chatKey)); }

  async readLedger(profile: string, chatKey: string | null): Promise<HermesChatWakeLedger | null> {
    return readJson<HermesChatWakeLedger>(this.ledgerPath(profile, chatKey));
  }

  async listLedgers(profile: string): Promise<HermesChatWakeLedger[]> {
    let names: string[];
    try { names = await readdir(this.dir(profile)); } catch { return []; }
    const out: HermesChatWakeLedger[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const value = await readJson<HermesChatWakeLedger>(join(this.dir(profile), name));
      if (value && typeof value.peer_name === "string") out.push(value);
    }
    return out;
  }

  private async save(ledger: HermesChatWakeLedger, state: HermesChatWakeState, detail: string): Promise<HermesChatWakeLedger> {
    ledger.state = state;
    ledger.detail = detail;
    ledger.updated_at = this.now().toISOString();
    await atomicWriteJson(this.ledgerPath(ledger.profile, ledger.chat_key), ledger);
    return ledger;
  }

  private outcome(ledger: HermesChatWakeLedger): HermesChatWakeOutcome {
    const out: HermesChatWakeOutcome = { state: ledger.state, detail: ledger.detail, sessionId: ledger.session_id };
    if (ledger.next_attempt_at) out.nextAttemptAt = ledger.next_attempt_at;
    if (ledger.state === "running" || ledger.state === "launched") out.pid = ledger.last_launch?.pid;
    return out;
  }

  /** One daemon tick for one chat-inbox entry. Idempotent: call it as often as the daemon polls. */
  async wake(req: HermesChatWakeRequest): Promise<HermesChatWakeOutcome> {
    const release = await acquireLedgerLock(this.ledgerPath(req.profile, req.chatKey));
    if (!release) {
      const held = await this.readLedger(req.profile, req.chatKey);
      return { state: held?.state ?? "running", detail: await lockedDetail(this.ledgerPath(req.profile, req.chatKey)), sessionId: held?.session_id ?? null };
    }
    try {
      return await this.wakeLocked(req);
    } finally {
      await release();
    }
  }

  private async wakeLocked(req: HermesChatWakeRequest): Promise<HermesChatWakeOutcome> {
    const now = this.now();
    let ledger = (await this.readLedger(req.profile, req.chatKey)) ?? emptyLedger(req, now);
    if (req.title) ledger.title = req.title;
    if (ledger.state === "cancelled") return this.outcome(ledger);

    ledger = await this.reconcileLedger(ledger);
    if (ledger.state === "running") return this.outcome(ledger);

    // An open desktop-plugin wake owns this chat's mail until evidence settles it.
    ledger = await this.reconcileDesktop(ledger);
    if (ledger.desktop_attempt) return this.outcome(ledger);

    // New mail since the last launch resets the ladder and clears terminal states.
    if (req.maxId > ledger.launched_max_id) {
      ledger.attempts = 0;
      ledger.next_attempt_at = null;
      if (["exhausted", "input_required", "cooldown", "not_found"].includes(ledger.state)) ledger.state = "done";
    } else {
      if (ledger.state === "done" && ledger.handled_max_id >= req.maxId) return this.outcome(ledger);
      if (ledger.state === "input_required" || ledger.state === "exhausted" || ledger.state === "not_found") return this.outcome(ledger);
      if (ledger.state === "cooldown" && ledger.next_attempt_at && Date.parse(ledger.next_attempt_at) > now.getTime()) return this.outcome(ledger);
    }
    if (req.unread <= 0) return this.outcome(await this.save(ledger, "done", "no unread mail"));

    // Resolve the chat. The general mailbox is the profile's "Agent Peers" chat, created if missing.
    const db = openReadOnly(stateDbPath(this.hermesHome, req.profile));
    let sessionId: string | null = null;
    let createTitle: string | null = null;
    let interruptedTail = false;
    if (req.chatKey) {
      if (!db) return this.outcome(await this.save(ledger, "not_found", `no Hermes state for profile "${req.profile}"`));
      const row = getRow(db, req.chatKey);
      if (!row) { db.close(); return this.outcome(await this.save(ledger, "not_found", `chat ${req.chatKey} no longer exists in ${req.profile}'s state.db`)); }
      sessionId = lineageRoot(db, row.id);
    } else if (db) {
      const res = resolveInProfile(db, req.profile, this.generalChatTitle);
      if (res.ok) sessionId = res.chat_key;
      else if (res.candidates.length > 1) sessionId = res.candidates[0]!.chat_key; // several "Agent Peers" chats: newest wins
      else createTitle = this.generalChatTitle;
    } else {
      createTitle = this.generalChatTitle;
    }
    ledger.session_id = sessionId;
    if (db && sessionId) {
      const tip = lineageTip(db, sessionId);
      const last = db.query("SELECT role FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(tip) as { role: string } | null;
      interruptedTail = last?.role === "user";
      ledger.title = (getRow(db, tip) ?? getRow(db, sessionId))?.title ?? ledger.title;
    }

    // Busy checks, re-evaluated every tick (no ladder): Desktop slot, foreign turn lease, gateway work.
    if (sessionId) {
      const holder = registryHolder(this.hermesHome, req.profile, sessionId, this.alive);
      if (holder) { db?.close(); return this.outcome(await this.save(ledger, "waiting_desktop", `open in ${holder}; closing the chat releases the wake`)); }
      if (db) {
        const lease = db.query("SELECT holder, expires_at FROM session_turn_leases WHERE conversation_id = ?").get(sessionId) as { holder: string; expires_at: number } | null;
        if (lease && Number(lease.expires_at) > now.getTime() / 1000) {
          const pid = Number(/pid=(\d+)/.exec(lease.holder)?.[1]);
          if (!Number.isInteger(pid) || this.alive(pid)) { db.close(); return this.outcome(await this.save(ledger, "waiting_turn", `turn lease held by ${lease.holder}`)); }
        }
        const pending = db.query("SELECT admission_id, status FROM session_admissions WHERE target_session_id = ? AND status != 'terminal' ORDER BY seq DESC LIMIT 1")
          .get(sessionId) as { admission_id: string; status: string } | null;
        if (pending) { db.close(); return this.outcome(await this.save(ledger, "waiting_gateway", `gateway admission ${pending.admission_id.slice(0, 8)} is ${pending.status}`)); }
      }
    }
    const seqBefore = db && sessionId ? this.admissionSeq(db, sessionId) : 0;
    db?.close();

    const wakeText = req.wakeText ?? defaultWakeText(req.peerName, req.chatKey, ledger.title, interruptedTail);
    try {
      const launch = await this.launch(req.profile, sessionId, createTitle, wakeText, seqBefore, req.maxId);
      ledger.last_launch = launch;
      ledger.launched_max_id = req.maxId;
      ledger.next_attempt_at = null;
      const detail = sessionId ? `hermes chat --resume ${sessionId} -q (pid ${launch.pid})` : `creating "${createTitle}" (pid ${launch.pid})`;
      return this.outcome(await this.save(ledger, "launched", detail));
    } catch (error) {
      return this.failed(ledger, `launch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Settle in-flight attempts for a profile; call once per daemon pass before or after wake(). */
  async reconcile(profile: string): Promise<HermesChatWakeLedger[]> {
    const out: HermesChatWakeLedger[] = [];
    for (const listed of await this.listLedgers(profile)) {
      const settled = await this.locked(profile, listed.chat_key, async (ledger) => {
        if (!ledger) return null;
        return this.reconcileDesktop(await this.reconcileLedger(ledger));
      });
      out.push(settled ?? listed);
    }
    return out;
  }

  /** Chats whose mail is parked, for the daemon's visible pending status. */
  async pending(profile: string): Promise<HermesChatWakeLedger[]> {
    return (await this.reconcile(profile)).filter((l) => ["waiting_desktop", "desktop_unknown", "waiting_turn", "waiting_gateway", "cooldown", "input_required", "exhausted"].includes(l.state));
  }

  async cancel(profile: string, chatKey: string | null, peerName = `${profile}-hermes`): Promise<void> {
    await this.locked(profile, chatKey, async (found) => {
      const ledger = found ?? emptyLedger({ peerName, profile, chatKey, title: null, unread: 0, maxId: 0 }, this.now());
      return this.save(ledger, "cancelled", "wakes stopped by operator");
    }, true);
  }

  async uncancel(profile: string, chatKey: string | null): Promise<void> {
    await this.locked(profile, chatKey, async (ledger) => (ledger?.state === "cancelled" ? this.save(ledger, "done", "wakes re-enabled by operator") : ledger), true);
  }

  /**
   * Operator resolution of a desktop wake. `handled` records that the reviewed wake did reach a
   * turn (its mail is not re-woken); otherwise the next tick may wake the chat again.
   */
  async clearDesktop(profile: string, chatKey: string | null, handled = false): Promise<HermesChatWakeLedger | null> {
    return this.locked(profile, chatKey, async (ledger) => {
      if (!ledger?.desktop_attempt) return ledger;
      const attempt = ledger.desktop_attempt;
      if (handled) {
        ledger.handled_max_id = Math.max(ledger.handled_max_id, attempt.max_id);
        ledger.launched_max_id = Math.max(ledger.launched_max_id, attempt.max_id);
      }
      ledger.last_desktop_attempt = { ...attempt, outcome: handled ? "cleared_handled" : "cleared", resolved_at: this.now().toISOString() };
      ledger.desktop_attempt = null;
      const detail = `desktop wake ${attempt.attempt_id.slice(0, 8)} cleared by operator${handled ? " as handled" : ""}`;
      if (ledger.state === "cancelled") return this.save(ledger, "cancelled", `wakes stopped by operator; ${detail}`);
      return this.save(ledger, handled ? "done" : "waiting_desktop", detail);
    }, true);
  }

  // -- internals -----------------------------------------------------------

  /** Run fn on the freshly read ledger under its lock. Null when the lock stayed busy (or must=true throws). */
  private async locked<T>(profile: string, chatKey: string | null, fn: (ledger: HermesChatWakeLedger | null) => Promise<T>, must = false): Promise<T | null> {
    const release = await acquireLedgerLock(this.ledgerPath(profile, chatKey));
    if (!release) {
      if (must) throw new Error(`ledger for ${profile}/${chatKey ?? GENERAL_MAILBOX} is locked by another executor`);
      return null;
    }
    try {
      return await fn(await this.readLedger(profile, chatKey));
    } finally {
      await release();
    }
  }

  private hostAlive(attempt: HermesDesktopAttempt): boolean {
    if (!this.alive(attempt.host_pid)) return false;
    if (!attempt.host_start) return true;
    const current = this.startOf(attempt.host_pid);
    return current === null || current === attempt.host_start;
  }

  private async reconcileDesktop(ledger: HermesChatWakeLedger): Promise<HermesChatWakeLedger> {
    const attempt = ledger.desktop_attempt;
    if (!attempt) return ledger;
    const db = openReadOnly(stateDbPath(this.hermesHome, ledger.profile));
    let ids: string[];
    try {
      ids = db ? lineageIds(db, lineageRoot(db, attempt.chat_key)) : [attempt.chat_key];
    } finally {
      db?.close();
    }
    if (!ids.includes(attempt.session_key)) ids.push(attempt.session_key);
    const verdict = classifyDesktopAttempt(
      readDesktopEvidence(this.stateDir, ledger.profile, attempt.attempt_id), attempt, this.hostAlive(attempt),
      registryHeldBy(this.hermesHome, ledger.profile, ids, attempt.host_pid), this.now().getTime(),
    );
    const [state, detail] = applyDesktopVerdict(ledger, verdict, this.now());
    return this.save(ledger, state, detail);
  }

  private admissionSeq(db: Database, sessionId: string): number {
    try {
      const row = db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM session_admissions WHERE target_session_id = ?").get(sessionId) as { seq: number } | null;
      return Number(row?.seq ?? 0);
    } catch {
      return 0;
    }
  }

  private admissionsAfter(profile: string, sessionId: string | null, seq: number): Array<{ admission_id: string; status: string }> {
    if (!sessionId) return [];
    const db = openReadOnly(stateDbPath(this.hermesHome, profile));
    if (!db) return [];
    try {
      return db.query("SELECT admission_id, status FROM session_admissions WHERE target_session_id = ? AND seq > ? ORDER BY seq")
        .all(sessionId, seq) as Array<{ admission_id: string; status: string }>;
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  private async launch(profile: string, sessionId: string | null, createTitle: string | null, wakeText: string, seqBefore: number, maxId: number): Promise<HermesChatWakeLaunch> {
    const logsDir = join(this.dir(profile), "logs");
    await ensurePrivateDir(logsDir);
    const started = this.now();
    const logPath = join(logsDir, `${hashId(sessionId ?? createTitle ?? GENERAL_MAILBOX).slice(0, 12)}-${started.toISOString().replace(/[:.]/g, "-")}.log`);
    const logHandle = await open(logPath, "a", 0o600);
    // The target is passed as arguments, never interpolated. The shell wrapper appends the exit
    // code to the log, so a daemon restarted mid-attempt can still classify from the file alone.
    const target = sessionId ? ["--resume", sessionId] : ["--source", "gui", "-c", createTitle!, "--create-if-missing"];
    const script = `"$0" "$@" </dev/null; code=$?; printf '\\n${EXIT_MARKER}%s\\n' "$code"; exit "$code"`;
    const child = spawn("sh", ["-c", script, this.hermesBin, "-p", profile, "chat", ...target, "-q", wakeText], {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: { ...this.env, HERMES_HOME: this.hermesHome },
    });
    await logHandle.close();
    if (!child.pid) throw new Error("hermes did not start");
    const record = { exitCode: null as number | null, done: false };
    this.children.set(child.pid, record);
    child.on("exit", (code) => { record.exitCode = code; record.done = true; });
    child.on("error", () => { record.done = true; });
    child.unref();
    return {
      pid: child.pid, started_at: started.toISOString(), deadline_at: new Date(started.getTime() + this.deadlineMs).toISOString(),
      log_path: logPath, admission_seq_before: seqBefore, max_id: maxId,
    };
  }

  private async failed(ledger: HermesChatWakeLedger, detail: string): Promise<HermesChatWakeOutcome> {
    ledger.attempts += 1;
    const delay = this.schedule[ledger.attempts - 1];
    if (delay === undefined) {
      ledger.next_attempt_at = null;
      return this.outcome(await this.save(ledger, "exhausted", `${detail}; ${ledger.attempts} attempts, waiting for new mail`));
    }
    ledger.next_attempt_at = new Date(this.now().getTime() + delay).toISOString();
    return this.outcome(await this.save(ledger, "cooldown", `${detail}; retry ${ledger.attempts + 1} at ${ledger.next_attempt_at}`));
  }

  private async reconcileLedger(ledger: HermesChatWakeLedger): Promise<HermesChatWakeLedger> {
    if ((ledger.state !== "launched" && ledger.state !== "running") || !ledger.last_launch) return ledger;
    const launch = ledger.last_launch;
    const tracked = this.children.get(launch.pid);
    const alive = tracked ? !tracked.done : this.alive(launch.pid);
    const now = this.now().getTime();
    if (alive && now < Date.parse(launch.deadline_at)) {
      return ledger.state === "running" ? ledger : this.save(ledger, "running", ledger.detail);
    }
    if (alive) {
      // Past the wall-clock deadline: stop the client. The gateway keeps any admitted turn.
      try { process.kill(-launch.pid, "SIGTERM"); } catch { try { process.kill(launch.pid, "SIGTERM"); } catch { /* gone */ } }
    }
    const output = await readFile(launch.log_path, "utf8").catch(() => "");
    const marker = new RegExp(`${EXIT_MARKER}(\\d+)`).exec(output);
    const exitCode = marker ? Number(marker[1]) : tracked?.exitCode ?? null;
    launch.exit_code = exitCode;
    this.children.delete(launch.pid);
    let { verdict, reason } = classifyHermesCliOutput(exitCode, output);
    if (alive) { verdict = "unknown"; reason = "client deadline reached"; }

    if (!ledger.session_id && verdict !== "done") {
      // The general chat was being created; find it now so admissions can be checked.
      const db = openReadOnly(stateDbPath(this.hermesHome, ledger.profile));
      if (db) {
        const res = resolveInProfile(db, ledger.profile, this.generalChatTitle);
        ledger.session_id = res.ok ? res.chat_key : res.candidates[0]?.chat_key ?? null;
        db.close();
      }
    }
    // The durable admission row decides when the client could not.
    const admissions = this.admissionsAfter(ledger.profile, ledger.session_id, launch.admission_seq_before);
    const latest = admissions[admissions.length - 1];
    if (latest) ledger.last_admission_id = latest.admission_id;
    if (verdict === "unknown" || verdict === "failed") {
      if (latest && admissions.some((a) => a.status !== "terminal")) {
        return this.save(ledger, "running", `client gone; gateway still running admission ${latest.admission_id.slice(0, 8)}`);
      }
      if (latest) { verdict = "done"; reason = `admission ${latest.admission_id.slice(0, 8)} terminal`; }
    }

    switch (verdict) {
      case "done":
        ledger.handled_max_id = Math.max(ledger.handled_max_id, launch.max_id);
        ledger.attempts = 0;
        ledger.next_attempt_at = null;
        return this.save(ledger, "done", reason);
      case "input_required":
        ledger.next_attempt_at = null;
        return this.save(ledger, "input_required", `${reason}; Mike must answer in the chat before the next wake`);
      case "busy_desktop":
        return this.save(ledger, "waiting_desktop", `${reason} (raced with the launch); re-checking every tick`);
      case "busy_turn":
        return this.save(ledger, "waiting_turn", `${reason} (raced with the launch); re-checking every tick`);
      case "not_found":
        return this.save(ledger, "not_found", reason);
      default:
        await this.failed(ledger, reason);
        return ledger;
    }
  }
}

let defaultDriver: HermesChatWakeDriver | null = null;

/** The wake daemon's entry point: one call per chat-inbox entry per tick. */
export async function wakeHermesChat(req: HermesChatWakeRequest, opts?: HermesChatWakeOptions): Promise<HermesChatWakeOutcome> {
  if (!req.profile) return { state: "no_profile", detail: `${req.peerName} does not map to a Hermes profile` };
  if (opts) return new HermesChatWakeDriver(opts).wake(req);
  defaultDriver ??= new HermesChatWakeDriver();
  return defaultDriver.wake(req);
}
