#!/usr/bin/env bun
// cli.ts
// Inspection + admin CLI for agent-peers-mcp. Talks to broker on :7900.

import { createClient } from "./shared/broker-client.ts";
import { isValidName, pickAvailablePeerName } from "./shared/names.ts";
import { readSharedSecret } from "./shared/shared-secret.ts";
import { WakeRegistry, hashBrokerSessionToken } from "./shared/wake-registry.ts";
import { WakeLaunchClaimStore } from "./shared/wake-launch-claims.ts";
import { CodexAppServerWsClient, formatThreadStatus } from "./shared/app-server-client.ts";
import type { Peer } from "./shared/types.ts";

// True app-server thread status for a wakeable peer — the GROUND TRUTH the
// operator can trust over the TUI's "working" spinner, which lingers after
// externally-injected (materialize / daemon-wake) turns even though the thread
// has returned to idle (see the delivery-fix spec §6.3). Best-effort and
// bounded: each RPC (connect + one readThread) caps at 3s, so a wedged or
// half-dead app-server costs at most ~6s before we give up and omit the field.
// `wake-status` probes every peer concurrently (Promise.all), so the added
// network I/O bounds the whole command at ~6s regardless of peer count rather
// than summing per peer.
async function probeTrueThreadStatus(
  appServerUrl: string | null | undefined,
  threadId: string | null | undefined,
): Promise<string | null> {
  if (!appServerUrl || !threadId) return null;
  let appClient: CodexAppServerWsClient | null = null;
  try {
    appClient = new CodexAppServerWsClient(appServerUrl, { timeoutMs: 3000 });
    const thread = await appClient.readThread(threadId);
    return formatThreadStatus(thread.status);
  } catch {
    return null;
  } finally {
    try { appClient?.close(); } catch { /* best effort */ }
  }
}

const BROKER_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;

// Read the shared secret. Commands that hit the broker's HTTP API (status,
// peers, send, set-summary) require the secret. Direct-SQLite commands
// (rename, messages, orphaned-messages) and `kill-broker` don't — those are
// gated by OS file permissions on the DB + secret files.
const sharedSecret = readSharedSecret();
const client = createClient(BROKER_URL, sharedSecret ?? "");

interface PeerAuthRow {
  id: string;
  session_token: string;
  name: string;
  peer_type: string;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
}

async function readPeerAuth(target: string): Promise<PeerAuthRow | null> {
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<PeerAuthRow, [string, string]>(
      `SELECT id, session_token, name, peer_type, pid, cwd, git_root, tty
       FROM peers
       WHERE id = ? OR name = ?`
    ).get(target, target) ?? null;
  } finally {
    db.close();
  }
}

async function readUnreadCountsByPeer(): Promise<Map<string, number>> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const rootDir = process.env.AGENT_PEERS_CODEX_STATE_DIR ?? join(homedir(), ".agent-peers-codex");
  const counts = new Map<string, number>();
  let files: string[];
  try {
    files = await readdir(rootDir);
  } catch {
    return counts;
  }

  for (const file of files) {
    if (!file.endsWith(".metadata.json")) continue;
    try {
      const raw = await readFile(join(rootDir, file), "utf8");
      const parsed = JSON.parse(raw) as { unread?: unknown[] };
      const peerId = decodeURIComponent(file.slice(0, -".metadata.json".length));
      counts.set(peerId, Array.isArray(parsed.unread) ? parsed.unread.length : 0);
    } catch {
      /* ignore malformed metadata */
    }
  }
  return counts;
}

async function cmdStatus() {
  const alive = await client.isAlive();
  if (!alive) {
    console.log(`broker: not running on ${BROKER_URL}`);
    process.exit(1);
  }
  console.log(`broker: running on ${BROKER_URL}`);
  await cmdPeers();
  console.log("");
  await cmdWakeStatus();
}

async function cmdPeers() {
  const peers = await client.listPeers({
    scope: "machine", cwd: process.cwd(), git_root: null,
  });
  if (peers.length === 0) {
    console.log("(no peers registered)");
    return;
  }
  for (const p of peers) {
    console.log(`${p.name}  (${p.peer_type})  id=${p.id}`);
    console.log(`  cwd=${p.cwd}${p.tty ? `  tty=${p.tty}` : ""}`);
    if (p.summary) console.log(`  summary: ${p.summary}`);
    console.log(`  last_seen=${p.last_seen}`);
  }
}

async function cmdSend(targetNameOrId: string, message: string) {
  // The broker now requires from_id to resolve to a registered, live peer
  // (code review round-1 fix). Register a short-lived operator peer for this
  // send, then unregister it. Name is unique via PID suffix.
  const operatorName = `cli-operator-${process.pid}`;
  const reg = await client.register({
    peer_type: "claude",
    name: operatorName,
    pid: process.pid,
    cwd: process.cwd(),
    git_root: null,
    tty: null,
    summary: "local CLI operator",
  });
  // Code review round-2 fix: do NOT call process.exit() inside the try — that
  // terminates the process before finally runs and leaves the operator peer
  // registered. Capture the exit status, always unregister, then exit.
  let exitCode = 0;
  let sendError: string | null = null;
  let messageId: number | undefined;
  try {
    const res = await client.sendMessage({
      from_id: reg.id, session_token: reg.session_token, to_id_or_name: targetNameOrId, text: message,
    });
    if (!res.ok) {
      sendError = res.error ?? "unknown";
      exitCode = 1;
    } else {
      messageId = res.message_id;
    }
  } finally {
    try {
      await client.unregister({ id: reg.id, session_token: reg.session_token });
    } catch {
      /* best effort */
    }
  }
  if (exitCode !== 0) {
    console.error(`send failed: ${sendError}`);
    process.exit(exitCode);
  }
  console.log(`sent (id=${messageId}, from=${reg.name})`);
}

async function cmdRename(target: string, newName: string) {
  // Read the target peer's session_token from the SQLite file directly — the
  // operator trust boundary is OS file permissions on ~/.agent-peers.db,
  // NOT an unauthenticated HTTP admin endpoint. Round-B audit removed the
  // /admin/rename-peer HTTP endpoint because any local process could have
  // hijacked peer identities.
  const row = await readPeerAuth(target);
  if (!row) {
    console.error(`no peer matching '${target}'`);
    process.exit(1);
  }
  // Call the regular session-authenticated /rename-peer, impersonating the
  // peer with its own token that we just read from the DB.
  const res = await client.renamePeer({
    id: row.id, session_token: row.session_token, new_name: newName,
  });
  if (!res.ok) {
    console.error(`rename failed: ${res.error}`);
    process.exit(1);
  }
  console.log(`renamed ${row.name} -> ${res.name}`);
}

async function cmdRetire(target: string) {
  // Operator-side graceful shutdown: remove the peer from broker discovery and
  // remove any wake registry row for this exact peer id. Message history stays
  // in the broker; inbox files are deliberately left alone.
  const row = await readPeerAuth(target);
  if (!row) {
    const registry = new WakeRegistry();
    await registry.init();
    const entry = (await registry.list({ includeStale: true }))
      .find((candidate) => candidate.peer_id === target || candidate.peer_name === target);
    if (!entry) {
      console.error(`no peer or wake registry entry matching '${target}'`);
      process.exit(1);
    }
    await registry.removeByPeerId(entry.peer_id);
    console.log(`retired stale wake entry ${entry.peer_name} (${entry.peer_id})`);
    console.log("  broker row was already missing");
    return;
  }

  await client.unregister({ id: row.id, session_token: row.session_token });

  const registry = new WakeRegistry();
  await registry.init();
  await registry.removeByPeerId(row.id);

  console.log(`retired ${row.name} (${row.id})`);
  console.log("  removed from broker discovery and wake registry");
  console.log("  message history and local inbox files were preserved");
}

async function cmdRepairWake(target: string) {
  const row = await readPeerAuth(target);
  if (!row) {
    console.error(`no peer matching '${target}'`);
    process.exit(1);
  }
  if (row.peer_type !== "codex") {
    console.error(`peer '${row.name}' is ${row.peer_type}, not codex`);
    process.exit(1);
  }

  const claimStore = new WakeLaunchClaimStore();
  const candidates = await claimStore.listMatchingCandidates({
    cwd: row.cwd,
    tty: row.tty,
    includeConsumed: true,
    requestedPeerName: row.name,
  });
  if (candidates.length === 0) {
    console.error(`no live wake launch claim found for ${row.name} (cwd=${row.cwd}${row.tty ? ` tty=${row.tty}` : ""})`);
    process.exit(1);
  }

  // Ambiguity guard: if two or more *live* sessions with DISTINCT threads match
  // this cwd/tty, we cannot safely tell which one belongs to this peer — wiring
  // the wake pointer to the wrong thread would wake the wrong session. Refuse
  // and tell the operator to retire the stragglers first. (This is the
  // same-repo / null-tty Zed case where cwd+tty alone can't disambiguate.)
  const liveThreads = new Set(candidates.filter((c) => c.live).map((c) => c.thread_id));
  if (liveThreads.size > 1) {
    console.error(`ambiguous wake claims for ${row.name}: ${liveThreads.size} live sessions share cwd=${row.cwd}${row.tty ? ` tty=${row.tty}` : ""}`);
    for (const c of candidates.filter((c) => c.live)) {
      console.error(`  thread=${c.thread_id}  app_server=${c.app_server_url}  app_server_pid=${c.app_server_pid}`);
    }
    console.error("refusing to guess. Retire the session(s) you don't want with `codex-peer retire <name-or-id>`, then retry repair-wake.");
    process.exit(1);
  }

  // Prefer a live candidate; fall back to the newest complete claim.
  const claim = candidates.find((c) => c.live) ?? candidates[0]!;

  const now = new Date().toISOString();
  const registry = new WakeRegistry();
  await registry.init();
  await registry.upsert({
    peer_id: row.id,
    peer_name: row.name,
    cwd: row.cwd,
    git_root: row.git_root,
    tty: row.tty,
    thread_id: claim.thread_id,
    rollout_path: claim.rollout_path,
    app_server_url: claim.app_server_url,
    app_server_socket_path: claim.app_server_socket_path,
    app_server_pid: claim.app_server_pid,
    tui_pid: claim.tui_pid,
    mcp_pid: row.pid,
    broker_session_token_hash: hashBrokerSessionToken(row.session_token),
    status: "ready",
    capabilities: ["app-server-ws"],
    created_at: claim.created_at,
    updated_at: now,
    last_seen_at: now,
  });
  await claimStore.consume(claim.claim_id, row.id).catch(() => {});

  console.log(`repaired wake registry for ${row.name} (${row.id})`);
  console.log(`  thread=${claim.thread_id}`);
  console.log(`  app_server=${claim.app_server_url}`);
}

async function cmdWakeStatus() {
  const peers = await client.listPeers({
    scope: "machine", cwd: process.cwd(), git_root: null,
  });
  const codexPeers = peers.filter((peer) => peer.peer_type === "codex");

  const registry = new WakeRegistry();
  await registry.init();
  const registryEntries = await registry.list({ includeStale: true });
  const registryByPeerId = new Map(registryEntries.map((entry) => [entry.peer_id, entry]));
  const unreadCounts = await readUnreadCountsByPeer();

  if (codexPeers.length === 0 && registryEntries.length === 0) {
    console.log("wakeable codex: no live Codex peers or wake registry entries");
    return;
  }

  const rows = codexPeers.sort(comparePeers).map((peer) => ({
    peer,
    entry: registryByPeerId.get(peer.id),
    pending: unreadCounts.get(peer.id) ?? 0,
  }));
  const wakeableRows = rows.filter((row) => row.entry?.status === "ready");
  const needsRepairRows = rows.filter((row) =>
    !row.entry && /(?:^|-)codex(?:-\d+)?$/.test(row.peer.name)
  );
  const otherRows = rows.filter((row) =>
    !wakeableRows.includes(row) && !needsRepairRows.includes(row)
  );

  // Probe true app-server thread status for the wakeable rows (concurrent,
  // bounded). This is the ground truth the operator can trust over the TUI's
  // stuck "working" spinner.
  const trueStatusByPeerId = new Map<string, string>();
  await Promise.all(wakeableRows.map(async (row) => {
    const status = await probeTrueThreadStatus(row.entry?.app_server_url, row.entry?.thread_id);
    if (status) trueStatusByPeerId.set(row.peer.id, status);
  }));

  console.log("wakeable Codex sessions:");
  if (wakeableRows.length === 0) {
    console.log("  (none)");
  } else {
    for (const row of wakeableRows) {
      printWakePeer(row.peer, row.entry, row.pending, trueStatusByPeerId.get(row.peer.id));
    }
  }

  if (needsRepairRows.length > 0) {
    console.log("");
    console.log("Codex peers that look like wakeable launches but need repair:");
    for (const row of needsRepairRows) printWakePeer(row.peer, row.entry, row.pending);
  }

  if (otherRows.length > 0) {
    console.log("");
    console.log("Other live Codex peers:");
    for (const row of otherRows) printWakePeer(row.peer, row.entry, row.pending);
  }

  const liveIds = new Set(codexPeers.map((peer) => peer.id));
  const registryOnly = registryEntries.filter((entry) => !liveIds.has(entry.peer_id));
  if (registryOnly.length > 0) {
    console.log("");
    console.log("Stale or registry-only wake entries:");
    for (const entry of registryOnly) {
      const pending = unreadCounts.get(entry.peer_id) ?? 0;
      console.log(`  ${entry.peer_name}  broker=missing  wakeable=${entry.status === "ready" ? "registry-only" : `no (${entry.status})`}  unread=${pending}  id=${entry.peer_id}`);
      console.log(`    cwd=${entry.cwd}${entry.tty ? `  tty=${entry.tty}` : ""}`);
      console.log(`    thread=${entry.thread_id}  app_server_pid=${entry.app_server_pid}  mcp_pid=${entry.mcp_pid}${entry.tui_pid ? `  tui_pid=${entry.tui_pid}` : ""}`);
    }
  }

  if (needsRepairRows.length > 0) {
    console.log("");
    console.log("tip: run codex-peer repair-wake <name-or-id> for any live Codex peer that should be wakeable.");
    console.log("     run codex-peer retire <name-or-id> to remove stale/confusing names from discovery.");
  }
}

function printWakePeer(peer: Peer, entry: Awaited<ReturnType<WakeRegistry["list"]>>[number] | undefined, pending: number, trueStatus?: string): void {
  const wakeable = entry ? (entry.status === "ready" ? "yes" : `no (${entry.status})`) : "no";
  // `thread_status` = true app-server status (idle/active/...) — trust this over
  // the TUI spinner. A long-lived `active` with the peer idle at the prompt is
  // the spinner desync, not a real hang. Named distinctly from the detail line's
  // `thread=<thread_id>` below so the two never read as the same field.
  const threadStatus = trueStatus ? `  thread_status=${trueStatus}` : "";
  console.log(`  ${peer.name}  wakeable=${wakeable}  unread=${pending}${threadStatus}  id=${peer.id}`);
  console.log(`    cwd=${peer.cwd}${peer.tty ? `  tty=${peer.tty}` : ""}`);
  if (entry) {
    console.log(`    thread=${entry.thread_id}  app_server_pid=${entry.app_server_pid}  mcp_pid=${entry.mcp_pid}${entry.tui_pid ? `  tui_pid=${entry.tui_pid}` : ""}`);
  }
  if (peer.summary) console.log(`    summary: ${peer.summary}`);
}

function comparePeers(a: Peer, b: Peer): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

async function cmdMessages() {
  // Read the SQLite DB directly so OS file permissions remain the trust
  // boundary. The broker deliberately does NOT expose message bodies over an
  // unauthenticated HTTP endpoint (any local process can reach 127.0.0.1).
  // Round-A security fix.
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    const nowStr = new Date().toISOString();
    const total =
      db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages").get()?.c ?? 0;
    const LIMIT = 500;
    type Row = {
      id: number;
      from_id: string;
      from_name: string | null;
      to_id: string;
      to_name: string | null;
      text: string;
      sent_at: string;
      acked: number;
      active_lease: number;
      lease_expires_at: string | null;
    };
    const rows = db.query<Row, [string]>(
      `SELECT m.id, m.from_id, pf.name AS from_name, m.to_id, pt.name AS to_name,
              m.text, m.sent_at, m.acked,
              CASE WHEN m.lease_token IS NOT NULL
                        AND m.lease_expires_at IS NOT NULL
                        AND m.lease_expires_at >= ?
                   THEN 1 ELSE 0 END AS active_lease,
              m.lease_expires_at
       FROM messages m
       LEFT JOIN peers pf ON pf.id = m.from_id
       LEFT JOIN peers pt ON pt.id = m.to_id
       ORDER BY m.id DESC
       LIMIT ${LIMIT}`
    ).all(nowStr);

    if (rows.length === 0) {
      console.log("(no messages in broker)");
      return;
    }
    if (rows.length < total) {
      console.log(`Showing newest ${rows.length} of ${total} message(s) (truncated — use 'sqlite3' directly for the full set):\n`);
    } else {
      console.log(`${rows.length} message(s) in broker (newest first):\n`);
    }
    for (const m of rows) {
      const status = m.acked ? "ACKED" : m.active_lease ? "LEASED" : "PENDING";
      const from = m.from_name ?? `(gone: ${m.from_id.slice(0, 8)}…)`;
      const to = m.to_name ?? `(gone: ${m.to_id.slice(0, 8)}…)`;
      const preview = m.text.length > 80 ? m.text.slice(0, 77) + "..." : m.text;
      console.log(`#${m.id}  ${status}  from=${from}  to=${to}  sent=${m.sent_at}`);
      if (m.active_lease && m.lease_expires_at) console.log(`  lease_expires=${m.lease_expires_at}`);
      console.log(`  ${preview}`);
      console.log("");
    }
  } finally {
    db.close();
  }
}

async function cmdOrphans() {
  // Read the SQLite DB directly — OS file permissions are the trust boundary.
  // Round-B fix: removed the /orphaned-messages HTTP endpoint because it
  // leaked message bodies to any local process on 127.0.0.1.
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  const db = new Database(dbPath, { readonly: true });
  try {
    type Row = { id: number; from_id: string; to_id: string; text: string; sent_at: string };
    const rows = db.query<Row, []>(
      `SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at
       FROM messages m
       LEFT JOIN peers p ON p.id = m.to_id
       WHERE p.id IS NULL AND m.acked = 0
       ORDER BY m.id ASC`
    ).all();
    if (rows.length === 0) {
      console.log("(no orphaned messages)");
      return;
    }
    for (const m of rows) {
      const preview = m.text.length > 80 ? m.text.slice(0, 77) + "..." : m.text;
      console.log(`#${m.id}  from=${m.from_id}  to=${m.to_id}  sent=${m.sent_at}`);
      console.log(`  ${preview}`);
    }
  } finally {
    db.close();
  }
}

async function cmdKillBroker() {
  let health: { pid?: unknown };
  try {
    const response = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health = await response.json() as { pid?: unknown };
  } catch {
    console.log("broker not running");
    return;
  }

  const pid = health.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 1) {
    throw new Error(`broker health returned an invalid pid: ${String(pid)}`);
  }

  // Do not use `lsof -i :PORT` here: it returns both the listener and every
  // established MCP client connection. The old implementation therefore
  // killed the broker AND every live peer. The broker's own health payload is
  // the authoritative single target.
  try {
    process.kill(pid as number, "SIGTERM");
    console.log(`killed broker pid=${pid}`);
  } catch (e) {
    console.error(`kill broker pid=${pid} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Print a unique, memorable peer name for `base` (read-only). Used by
// bin/codex-peer so a 2nd+ concurrent peer in the same repo auto-gets a funny
// suffix (e.g. <repo>-codex-otter) instead of a positional -2, with no typing.
// Queries the broker for LIVE peer names; if the broker is down or unreachable
// the base is echoed unchanged (the broker's register-time ladder still
// guarantees uniqueness). ONLY the chosen name goes to stdout, so the launcher
// can capture it directly; everything else is silent.
async function cmdSuggestName(base: string) {
  if (!isValidName(base)) {
    // Not our job to sanitize — hand it back; register will reject/ladder it.
    console.log(base);
    return;
  }
  let taken = new Set<string>();
  try {
    if (await client.isAlive()) {
      const peers = await client.listPeers({ scope: "machine", cwd: process.cwd(), git_root: null });
      taken = new Set(peers.map((p) => p.name));
    }
  } catch {
    /* broker unreachable — echo base; register-time ladder is the backstop */
  }
  console.log(pickAvailablePeerName(base, taken));
}

// ---- Inbox observability (2026-08-10, stranded-mail stabilization) --------
// The on-disk inbox dirs (codex, hermes, claude) hold durable copies of
// messages keyed by peer UUID. When a peer id dies (eviction + new-UUID
// re-register before prev_id existed), its inbox file becomes unreachable —
// 24 messages were sitting invisible in ~/.agent-peers-hermes at the time
// this shipped. These commands make every inbox file visible, list stranded
// broker rows the strict orphan view misses, and archive dead inbox files
// without ever deleting bodies.

const INBOX_ROOTS: { runtime: string; env?: string; dirname: string }[] = [
  { runtime: "codex", env: "AGENT_PEERS_CODEX_STATE_DIR", dirname: ".agent-peers-codex" },
  { runtime: "hermes", env: "AGENT_PEERS_HERMES_STATE_DIR", dirname: ".agent-peers-hermes" },
  { runtime: "claude", dirname: ".agent-peers-claude" },
];

interface InboxFileInfo {
  runtime: string;
  path: string;
  peerId: string;
  unread: { id: number; from_name?: string; text?: string; sent_at?: string }[];
  mtimeMs: number;
}

async function readAllInboxFiles(): Promise<InboxFileInfo[]> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const out: InboxFileInfo[] = [];
  const seenDirs = new Set<string>();
  for (const root of INBOX_ROOTS) {
    // Same precedence as the WRITERS (codex-inbox.ts / hermes-server.ts):
    // generic AGENT_PEERS_STATE_DIR beats the runtime-specific var. If the
    // CLI resolved these the other way around, it would inspect a different
    // directory than the servers write and report clean while mail strands.
    const dir = process.env.AGENT_PEERS_STATE_DIR
      || (root.env && process.env[root.env])
      || join(homedir(), root.dirname);
    if (seenDirs.has(dir)) continue; // shared STATE_DIR: scan once
    seenDirs.add(dir);
    let files: string[];
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".json") || file.endsWith(".metadata.json")) continue;
      if (file === "wake-registry.json") continue; // daemon state, not an inbox
      const path = join(dir, file);
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as { unread?: InboxFileInfo["unread"] };
        const st = await stat(path);
        out.push({
          runtime: root.runtime,
          path,
          peerId: decodeURIComponent(file.slice(0, -".json".length)),
          unread: Array.isArray(parsed.unread) ? parsed.unread : [],
          mtimeMs: st.mtimeMs,
        });
      } catch { /* malformed file: skip, never delete */ }
    }
  }
  return out;
}

async function openDbReadonly() {
  const { Database } = await import("bun:sqlite");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");
  const dbPath = process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
  return new Database(dbPath, { readonly: true });
}

async function cmdInboxes(showStranded: boolean) {
  const inboxes = await readAllInboxFiles();
  if (inboxes.length === 0) { console.log("No inbox files found."); return; }
  const db = await openDbReadonly();
  try {
    let strandedTotal = 0;
    for (const box of inboxes.sort((a, b) => b.unread.length - a.unread.length)) {
      const row = db.query<{ name: string; durable: number; last_seen: string }, [string]>(
        "SELECT name, durable, last_seen FROM peers WHERE id = ?"
      ).get(box.peerId);
      const state = row
        ? `${row.name}${row.durable ? " (durable)" : ""} last_seen=${row.last_seen}`
        : "DEAD (no broker row)";
      console.log(`[${box.runtime}] ${box.peerId}  unread=${box.unread.length}  ${state}`);
      if (!row) strandedTotal += box.unread.length;
      if (showStranded && !row && box.unread.length > 0) {
        for (const m of box.unread) {
          console.log(`    #${m.id} from=${m.from_name ?? "?"} sent_at=${m.sent_at ?? "?"}`);
          console.log(`      ${String(m.text ?? "").split("\n").join("\n      ")}`);
        }
      }
    }
    console.log(`\n${strandedTotal} unread message(s) in DEAD inboxes${showStranded ? "" : " (re-run with --stranded for full bodies)"}`);
  } finally { db.close(); }
}

async function cmdStrandedMessages() {
  // The strict orphan view (orphaned-messages) requires the recipient row to
  // be GONE. A durable row that never comes back holds its mail invisibly for
  // 7 days — this shows unacked mail whose recipient exists but hasn't been
  // seen in 24h.
  const db = await openDbReadonly();
  try {
    type Row = { id: number; message_uid: string | null; to_id: string; from_id: string | null; name: string; last_seen: string; from_name: string | null; text: string; sent_at: string };
    // A pre-migration DB (broker never ran the new code) has no message_uid
    // column, and this read-only CLI must not crash on it — recovery tooling
    // is exactly what gets pointed at old snapshots.
    const hasUid = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM pragma_table_info('messages') WHERE name = 'message_uid'"
    ).get()!.n > 0;
    const uidCol = hasUid ? "m.message_uid" : "NULL AS message_uid";
    const rows = db.query<Row, [string]>(
      `SELECT m.id, ${uidCol}, m.to_id, m.from_id, p.name, p.last_seen, pf.name AS from_name, m.text, m.sent_at
       FROM messages m
       JOIN peers p ON p.id = m.to_id
       LEFT JOIN peers pf ON pf.id = m.from_id
       WHERE m.acked = 0 AND p.last_seen < ?
       ORDER BY m.id ASC`
    ).all(new Date(Date.now() - 24 * 3600_000).toISOString());
    if (rows.length === 0) { console.log("No stranded messages (unacked mail to peers idle >24h)."); return; }
    for (const r of rows) {
      console.log(`#${r.id} uid=${r.message_uid ?? "-"} to=${r.name} (idle since ${r.last_seen}) from=${r.from_name ?? r.from_id ?? "(unknown)"}`);
      console.log(`  sent_at=${r.sent_at}`);
      console.log(`  ${r.text.split("\n").join("\n  ")}`);
    }
    console.log(`\n${rows.length} stranded message(s).`);
  } finally { db.close(); }
}

async function cmdGcInboxes(apply: boolean, minAgeDays: number) {
  const { rename } = await import("node:fs/promises");
  const inboxes = await readAllInboxFiles();
  const db = await openDbReadonly();
  const cutoff = Date.now() - minAgeDays * 24 * 3600_000;
  let candidates = 0;
  let tooRecent = 0;
  try {
    for (const box of inboxes) {
      const row = db.query("SELECT id FROM peers WHERE id = ?").get(box.peerId);
      if (row) continue;                 // live or retained peer: keep
      if (box.mtimeMs > cutoff) {        // too recent: keep (may be mid-write)
        tooRecent++;
        continue;
      }
      candidates++;
      if (apply) {
        // Archive, never delete — bodies stay recoverable.
        // Timestamped suffix: a bare `.archived` would clobber a previous
        // archive of the same peer-UUID inbox, silently destroying bodies —
        // the one thing this command promises never to do.
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await rename(box.path, `${box.path}.archived-${stamp}`);
        try { await rename(box.path.replace(/\.json$/, ".metadata.json"), `${box.path.replace(/\.json$/, ".metadata.json")}.archived-${stamp}`); } catch { /* no metadata file */ }
        console.log(`archived ${box.path} (unread=${box.unread.length})`);
      } else {
        console.log(`would archive ${box.path} (unread=${box.unread.length}, mtime age ${(Math.round((Date.now() - box.mtimeMs) / 86_400_000))}d)`);
      }
    }
  } finally { db.close(); }
  console.log(apply
    ? `archived ${candidates} dead inbox file(s).`
    : `${candidates} dead inbox file(s) would be archived. Re-run with --apply to archive.`);
  if (tooRecent > 0) {
    // Silent caps read as "covered everything" — say what was skipped and why.
    console.log(`${tooRecent} DEAD inbox file(s) skipped: mtime newer than ${minAgeDays}d (may be mid-write). If verified dead, re-run with --min-age-days 0.`);
  }
}

const [, , sub, ...rest] = process.argv;
switch (sub) {
  case "status":
    await cmdStatus();
    break;
  case "peers":
    await cmdPeers();
    break;
  case "wake-status":
  case "live":
    await cmdWakeStatus();
    break;
  case "send":
    if (rest.length < 2) {
      console.error("usage: cli.ts send <name-or-id> <message>");
      process.exit(2);
    }
    await cmdSend(rest[0]!, rest.slice(1).join(" "));
    break;
  case "rename":
    if (rest.length !== 2) {
      console.error("usage: cli.ts rename <name-or-id> <new-name>");
      process.exit(2);
    }
    await cmdRename(rest[0]!, rest[1]!);
    break;
  case "retire":
  case "unregister":
    if (rest.length !== 1) {
      console.error("usage: cli.ts retire <name-or-id>");
      process.exit(2);
    }
    await cmdRetire(rest[0]!);
    break;
  case "repair-wake":
  case "attach-wake":
    if (rest.length !== 1) {
      console.error("usage: cli.ts repair-wake <name-or-id>");
      process.exit(2);
    }
    await cmdRepairWake(rest[0]!);
    break;
  case "suggest-name":
    if (rest.length !== 1) {
      console.error("usage: cli.ts suggest-name <base>");
      process.exit(2);
    }
    await cmdSuggestName(rest[0]!);
    break;
  case "messages":
    await cmdMessages();
    break;
  case "orphaned-messages":
    await cmdOrphans();
    break;
  case "kill-broker":
    await cmdKillBroker();
    break;
  case "inboxes":
    await cmdInboxes(rest.includes("--stranded"));
    break;
  case "stranded-messages":
    await cmdStrandedMessages();
    break;
  case "gc-inboxes": {
    const ageIdx = rest.indexOf("--min-age-days");
    const minAge = ageIdx !== -1 ? parseFloat(rest[ageIdx + 1] ?? "7") : 7;
    await cmdGcInboxes(rest.includes("--apply"), Number.isFinite(minAge) ? minAge : 7);
    break;
  }
  default:
    console.log(`usage:
  bun cli.ts status
  bun cli.ts peers
  bun cli.ts wake-status
  bun cli.ts send <name-or-id> <message>
  bun cli.ts rename <name-or-id> <new-name>
  bun cli.ts retire <name-or-id>
  bun cli.ts repair-wake <name-or-id>
  bun cli.ts suggest-name <base>
  bun cli.ts messages
  bun cli.ts orphaned-messages
  bun cli.ts inboxes [--stranded]
  bun cli.ts stranded-messages
  bun cli.ts gc-inboxes [--apply] [--min-age-days N]
  bun cli.ts kill-broker`);
    process.exit(sub ? 2 : 0);
}
