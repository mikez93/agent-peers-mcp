#!/usr/bin/env bun
// broker.ts
// HTTP + SQLite daemon for agent-peers-mcp. Runs on localhost:7900.
// Spec: docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md

import { Database } from "bun:sqlite";
import { homedir, hostname } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, openSync, closeSync, writeSync, fsyncSync, linkSync, unlinkSync, existsSync, renameSync, statSync } from "node:fs";
import { validateSecretFilePerms } from "./shared/shared-secret.ts";
import type {
  RegisterRequest, RegisterResponse, Peer,
  ListPeersRequest, SendMessageRequest, SendMessageResponse,
  LeasedMessage, AckMessagesRequest, AckMessagesResponse,
  RenamePeerRequest, RenamePeerResponse,
  ListChatsRequest, ListChatsResponse, ChatInboxEntry, PeerInboxEntry, PeerType,
} from "./shared/types.ts";
import { appendSuffixWithinLimit, generateName, isValidName, NAME_MAX_LEN, NAME_REGEX } from "./shared/names.ts";
import { findConversation, hasConversationSchema, withConversationFence, dormantMailboxNotice, type ConversationOwner } from "./shared/hermes-conversation-fence.ts";
import { parseAddress, personaOf, withPersonaPrefix } from "./shared/peer-address.ts";
import {
  CHAT_MAIL_CAPABILITY, chatRouteId, defaultIsLocalHost, findPeers, hasCapability, mailboxOwnerRow, recordChatRoute, resolveAddress,
  resolvePeerName, resolvePollScope, resolveSenderChat, rowByName,
  type AddressRow, type AddressingDeps, type RemoteSendRequest,
} from "./shared/broker-addressing.ts";
import type { ChatCandidate } from "./shared/chat-directory.ts";
import { FederationService, UNREACHABLE_HOSTS_HEADER, loadFederationConfig, type FederationConfig } from "./shared/federation.ts";
import { HermesChatDirectory } from "./shared/hermes-chat-wake.ts";

export const DEFAULT_DB_PATH = resolve(homedir(), ".agent-peers.db");
export const DEFAULT_SECRET_PATH = resolve(homedir(), ".agent-peers-secret");
export const DEFAULT_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10);
export const STALE_THRESHOLD_MS = 60_000;
export const STALE_RECLAIM_THRESHOLD_MS = 60_000;
export const LEASE_DURATION_MS = 30_000;
// A poll refreshes last_seen only when it is at least this old (see pollMessagesInner).
export const POLL_HEARTBEAT_WRITE_MS = 10_000;
export const GC_INTERVAL_MS = 30_000;
// How long a DURABLE peer's registry row (identity + mailbox) survives without
// a heartbeat. Ephemeral peers are still deleted at STALE_THRESHOLD_MS.
//
// Why this exists: a Hermes agent starts its MCP servers per TURN and tears
// them down afterwards, so it stops heartbeating the moment it finishes
// replying. With a single 60s threshold governing both "hide from discovery"
// and "delete the row", a named agent was deleted from the registry between
// turns — observed 2026-08-08, when marco-hermes sent a message and was
// unaddressable nine minutes later ("unknown peer: marco-hermes"). Worse,
// STALE_RECLAIM_THRESHOLD_MS equalled the GC cutoff, so a row became
// reclaimable and deletable at the same instant; with GC running every 30s AND
// opportunistically inside every listPeers() call, GC essentially always won
// and the reclaim-by-name fast path below was unreachable on a busy network.
// That cost named agents their stable UUID, orphaned their queued mail, and
// let them collide with their own not-yet-collected ghost (the observed
// `ezra-hermes-2`).
//
// Discovery is unaffected: listPeers() still hides anything past
// STALE_THRESHOLD_MS, so a closed tab never lingers as a visible ghost.
export const DURABLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Bound on undelivered messages held for a single durable peer that has not
// come back. Without a cap, a permanently-departed named agent turns its
// mailbox into an unbounded sink. Senders get a clear error rather than a
// silent drop; the backlog stays visible via `bun cli.ts orphaned-messages`.
export const MAX_QUEUED_PER_DURABLE_PEER = 500;
export const SECRET_HEADER = "x-agent-peers-secret";

function nowIso(): string { return new Date().toISOString(); }

/** Normalize client session starts before lexical SQLite ordering. Missing or
 * invalid values return null so INSERT can use broker time and RECLAIM can
 * conservatively preserve the existing lineage. Future values are bounded by
 * broker receipt time so clock error cannot make a peer permanently newest. */
function canonicalStartedAt(value: string | undefined, brokerNow: string): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const brokerMillis = Date.parse(brokerNow);
  return new Date(Math.min(parsed, brokerMillis)).toISOString();
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

function isDefinitelyDeadLocalPid(pid: number | null): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) return false;
  try {
    process.kill(pid!, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

// ----- Schema -----

function chmodIfExists(p: string, mode: number): void {
  try { chmodSync(p, mode); } catch { /* file may not exist yet, or no POSIX perms — best effort */ }
}

// Fail-closed permission check (Codex round-G): after every chmod pass on
// the DB + WAL/SHM sidecars, re-stat and verify owner + mode match what we
// expect. If anything is wrong — wrong uid, world/group readable, not a
// regular file — abort broker startup rather than silently serving with a
// weakened trust boundary. Only runs on POSIX systems; Windows has no mode
// bits to enforce.
function enforceDbFilePerms(path: string, required: string[]): void {
  const hasPosix = typeof (process as unknown as { getuid?: () => number }).getuid === "function";
  if (!hasPosix) return;
  const mine = (process as unknown as { getuid: () => number }).getuid();
  for (const p of required) {
    if (!existsSync(p)) continue; // sidecars may legitimately not exist yet
    const st = statSync(p);
    if (!st.isFile()) {
      throw new Error(`broker: ${p} is not a regular file — refusing to start`);
    }
    if (st.uid !== mine) {
      throw new Error(`broker: ${p} owned by uid ${st.uid}, not current user (${mine}) — refusing to start`);
    }
    const mode = st.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `broker: ${p} has mode ${mode.toString(8)}, expected 0600 (other users can read session tokens or message bodies) — refusing to start`
      );
    }
  }
}

export function initDb(path: string): Database {
  // Tighten umask BEFORE opening SQLite (Codex round-I). SQLite and any
  // checkpoint-driven re-creation of the -wal / -shm sidecars uses the
  // process umask. 0o077 forces every file SQLite touches to default to
  // 0600, which closes the window between runtime WAL recreation and the
  // next 30s chmod-sweep GC tick. The explicit chmod calls below remain
  // as a fail-closed backstop in case a non-default umask was set earlier.
  try { process.umask(0o077); } catch { /* not all runtimes expose umask */ }

  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  // Harden filesystem permissions on the DB + its WAL sidecars. Codex round-E
  // flagged that SQLite creates files with the process umask (typically 022,
  // world-readable), which would expose session_tokens + message bodies to
  // any local user. cli.ts 'messages' / 'rename' treat the DB's file perms
  // as the operator trust boundary, so 0600 enforcement is required.
  chmodIfExists(path, 0o600);
  chmodIfExists(path + "-wal", 0o600);
  chmodIfExists(path + "-shm", 0o600);

  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex', 'hermes', 'droid', 'openclaw')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      session_token TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      started_at    TEXT,
      last_seen     TEXT NOT NULL,
      durable       INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id           TEXT NOT NULL,
      to_id             TEXT NOT NULL,
      text              TEXT NOT NULL,
      sent_at           TEXT NOT NULL,
      acked             INTEGER NOT NULL DEFAULT 0,
      lease_token       TEXT,
      lease_expires_at  TEXT,
      message_uid       TEXT
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_to_acked ON messages(to_id, acked);`);

  // ---- Migrations for upgrades against a pre-existing DB file ----
  // Add columns that newer code requires but the old schema lacks. Use
  // pragma_table_info to detect missing columns, then ALTER TABLE to add them
  // and backfill sensible defaults.

  migrate_peers_add_session_token(db);
  migrate_peers_add_hermes_peer_type(db);
  // MUST stay after the legacy peers migrations above. Both can
  // rebuild the peers table through a shadow-table copy whose column list is
  // written out literally, so either one would silently drop `durable` if it
  // ran afterwards. Adding the column last means those rebuilds never see it.
  // The migration is idempotent, so even if a future rebuild does drop it, the
  // next startup re-adds it and peers re-flag themselves on re-registration.
  migrate_peers_add_durable(db);
  migrate_messages_add_message_uid(db);
  migrate_peers_add_host(db);
  // MUST remain after every migration that can rebuild the peers table from
  // an explicit column list. Existing rows are backfilled from registered_at.
  migrate_peers_add_started_at(db);
  // MUST remain after all column-adding peers migrations. Expanding the CHECK
  // constraint requires a table rebuild; this final migration preserves every
  // column in the current schema instead of resetting newer peer metadata.
  migrate_peers_add_droid_peer_type(db);
  // v3 (2026-10-31). Additive columns and a new table only, so an older
  // broker can still open this DB if we ever roll back.
  migrate_v3_addressing(db);
  // bd-b2in.17 (2026-11-01). MUST stay last. It rebuilds peers from the
  // table's own stored definition, so every column any earlier migration
  // added (v3 persona/capabilities/mailbox_owner included) survives. Older
  // brokers can still open the result: their CHECK probes look for
  // 'hermes' and 'droid', which the expanded constraint still contains.
  migrate_peers_add_openclaw_peer_type(db);

  // Re-enforce 0600 AFTER migration + any CREATE TABLE writes — the initial
  // chmod before schema setup may have no-op'd on nonexistent sidecars, so
  // we harden again here once SQLite has definitely materialized the WAL/
  // SHM files at least once.
  chmodIfExists(path, 0o600);
  chmodIfExists(path + "-wal", 0o600);
  chmodIfExists(path + "-shm", 0o600);

  // Fail-closed validation (Codex round-G): stat and verify every file
  // matches the trust-boundary invariant. A broken chmod, alien owner, or
  // unusual filesystem that ignores mode bits now aborts startup with a
  // clear error instead of quietly serving readable session tokens.
  enforceDbFilePerms(path, [path, path + "-wal", path + "-shm"]);

  return db;
}

function columnExists(db: Database, table: string, column: string): boolean {
  // pragma_table_info() doesn't accept bound parameters reliably across SQLite
  // builds, so we inline the table name with hardening (single-quote escaping).
  // This is only ever called with compile-time-known table names.
  const safe = table.replace(/'/g, "''");
  const rows = db.query<{ name: string }, []>(
    `SELECT name FROM pragma_table_info('${safe}')`
  ).all();
  return rows.some((r) => r.name === column);
}

function migrate_peers_add_session_token(db: Database): void {
  // Wrapped in BEGIN IMMEDIATE so concurrent broker startups serialize the
  // schema check + mutation (code review round-4 fix). Without this, process A
  // can run ALTER TABLE while process B races past the columnExists check and
  // proceeds against a half-migrated DB.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!columnExists(db, "peers", "session_token")) {
      // First-time upgrade from a pre-session_token schema.
      db.exec(`ALTER TABLE peers ADD COLUMN session_token TEXT`);
      // Drop all pre-upgrade peer rows (round-4 fix for "migrated legacy peers
      // can silently receive undeliverable messages"). Pre-upgrade clients
      // don't know the new session_token scheme, so they cannot authenticate.
      // Leaving their rows in place would make them addressable via
      // sendMessage but unpollable — messages would orphan silently. Deleting
      // forces a clean reconnect: clients get "unknown peer" on their next
      // heartbeat/send and re-register. Any in-flight messages for these
      // peers become orphans, observable via cli.ts orphaned-messages.
      const dropped = db.query("DELETE FROM peers").run();
      if ((dropped.changes ?? 0) > 0) {
        console.error(
          `[broker] migration: dropped ${dropped.changes} pre-upgrade peer(s); ` +
          `they will re-register on reconnect. In-flight messages to them are visible ` +
          `via 'bun cli.ts orphaned-messages'.`
        );
      }
    }
    // Self-heal: any row with NULL session_token (e.g. from a crashed partial
    // migration before this transactional logic existed) gets a freshly
    // generated UUID. Always runs, regardless of column-newness.
    const nulls = db.query<{ id: string }, []>(
      "SELECT id FROM peers WHERE session_token IS NULL"
    ).all();
    if (nulls.length > 0) {
      const update = db.query("UPDATE peers SET session_token = ? WHERE id = ?");
      for (const row of nulls) update.run(randomUUID(), row.id);
      console.error(`[broker] migration: self-healed ${nulls.length} NULL session_token(s)`);
    }
    // Normalize schema (code review round-5 fix): ALTER TABLE ADD COLUMN
    // leaves session_token nullable on upgraded DBs even though fresh installs
    // declare it NOT NULL. A future writer that inserts a NULL (e.g. a bug, a
    // manual edit) would re-introduce the silent-orphan class. Rebuild the
    // table to enforce NOT NULL, matching the fresh-install invariant.
    if (isSessionTokenNullable(db)) {
      rebuildPeersTableWithNotNullSessionToken(db);
      console.error(`[broker] migration: rebuilt peers table with NOT NULL session_token`);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

function isSessionTokenNullable(db: Database): boolean {
  // pragma_table_info.notnull is 0 when the column is nullable, 1 when NOT NULL.
  // Alias to a non-reserved name for portability.
  const row = db.query<{ not_null_flag: number }, []>(
    `SELECT "notnull" AS not_null_flag FROM pragma_table_info('peers') WHERE name = 'session_token'`
  ).get();
  return row ? row.not_null_flag === 0 : false;
}

function rebuildPeersTableWithNotNullSessionToken(db: Database): void {
  // Create a shadow table with the desired strict schema, copy only rows that
  // have a non-NULL session_token (defense — callers above already self-healed),
  // drop the old table, rename. All inside the outer BEGIN IMMEDIATE tx, so
  // readers/writers see either the old table or the renamed new table, never
  // an in-between state.
  const preserveStartedAt = columnExists(db, "peers", "started_at");
  const preserveDurable = columnExists(db, "peers", "durable");
  const preserveHost = columnExists(db, "peers", "host");
  const startedAtDefinition = preserveStartedAt ? ",\n      started_at    TEXT" : "";
  const durableDefinition = preserveDurable ? ",\n      durable       INTEGER NOT NULL DEFAULT 0" : "";
  const hostDefinition = preserveHost ? ",\n      host          TEXT" : "";
  db.exec(`
    CREATE TABLE peers_new (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex', 'hermes', 'droid')),
      pid           INTEGER,
      cwd           TEXT,
      git_root      TEXT,
      tty           TEXT,
      summary       TEXT DEFAULT '',
      session_token TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_seen     TEXT NOT NULL${startedAtDefinition}${durableDefinition}${hostDefinition}
    );
  `);
  const startedAtColumn = preserveStartedAt ? ", started_at" : "";
  const durableColumn = preserveDurable ? ", durable" : "";
  const hostColumn = preserveHost ? ", host" : "";
  db.exec(`
    INSERT INTO peers_new (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen${startedAtColumn}${durableColumn}${hostColumn})
    SELECT id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, last_seen${startedAtColumn}${durableColumn}${hostColumn}
    FROM peers
    WHERE session_token IS NOT NULL;
  `);
  db.exec(`DROP TABLE peers;`);
  db.exec(`ALTER TABLE peers_new RENAME TO peers;`);
  // Rebuild the indices that lived on the old table.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);`);
}

function migrate_peers_add_host(db: Database): void {
  // Forward-compat groundwork for the (deferred) cross-machine federation
  // workstream: identity will be (name, host), with `id` as mailbox identity
  // and `session_token` as incarnation. NULL means "this machine" for rows
  // written by pre-host brokers; new registrations fill os.hostname().
  // Schema-only — no routing behavior reads it yet.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!columnExists(db, "peers", "host")) {
      db.exec(`ALTER TABLE peers ADD COLUMN host TEXT`);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

function migrate_peers_add_started_at(db: Database): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!columnExists(db, "peers", "started_at")) {
      // SQLite cannot ADD a NOT NULL column whose default comes from another
      // column, so add nullable then backfill in the same transaction.
      db.exec(`ALTER TABLE peers ADD COLUMN started_at TEXT`);
    }
    db.exec(`UPDATE peers
             SET started_at = registered_at
             WHERE started_at IS NULL OR trim(started_at) = ''`);
    // A prior release created a plain-column index, but discovery orders by
    // COALESCE(started_at, registered_at), so SQLite could not use it. Peer
    // tables are tiny; remove the misleading dead index instead of carrying
    // schema complexity with no operational benefit.
    db.exec(`DROP INDEX IF EXISTS idx_peers_started_at`);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

function migrate_messages_add_message_uid(db: Database): void {
  // Globally unique message identity (2026-08-10). The AUTOINCREMENT integer
  // is broker-local: two machines' brokers both mint id=1, so the moment
  // messages cross machines (deferred federation workstream) integer ids
  // collide. Adding the UID now means every message written from today
  // carries a stable global identity that recovery tooling and any future
  // relay can dedupe on. The integer id remains the local ordering key.
  // Backfill: existing rows get UIDs too, so recovery manifests can reference
  // them uniformly.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!columnExists(db, "messages", "message_uid")) {
      db.exec(`ALTER TABLE messages ADD COLUMN message_uid TEXT`);
    }
    const nulls = db.query<{ id: number }, []>(
      "SELECT id FROM messages WHERE message_uid IS NULL"
    ).all();
    if (nulls.length > 0) {
      const update = db.query("UPDATE messages SET message_uid = ? WHERE id = ?");
      for (const row of nulls) update.run(randomUUID(), row.id);
      console.error(`[broker] migration: backfilled message_uid on ${nulls.length} row(s)`);
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_uid ON messages(message_uid)");
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

function migrate_peers_add_durable(db: Database): void {
  // Wrapped in BEGIN IMMEDIATE for the same reason as the session_token
  // migration: concurrent broker startups must serialize the check + ALTER.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!columnExists(db, "peers", "durable")) {
      // Default 0 — every pre-existing row is treated as ephemeral. That is the
      // conservative direction: it preserves the old delete-at-60s behaviour
      // until a peer re-registers under a requested name and re-flags itself.
      db.exec(`ALTER TABLE peers ADD COLUMN durable INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

function migrate_peers_add_hermes_peer_type(db: Database): void {
  const row = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'peers'"
  ).get();
  if (row?.sql?.includes("'hermes'")) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    rebuildPeersTableWithNotNullSessionToken(db);
    db.exec("COMMIT");
    console.error("[broker] migration: expanded peer_type constraint to include hermes");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

function migrate_peers_add_droid_peer_type(db: Database): void {
  // Unlike the older Hermes rebuild, this migration runs only after durable,
  // host, and started_at have been added. Keep the complete current row shape
  // so upgrading the CHECK constraint cannot reset identity or routing state.
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'peers'"
    ).get();
    if (!row?.sql?.includes("'droid'")) {
      db.exec(`
        CREATE TABLE peers_droid_new (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL UNIQUE,
          peer_type     TEXT NOT NULL CHECK(peer_type IN ('claude', 'codex', 'hermes', 'droid')),
          pid           INTEGER,
          cwd           TEXT,
          git_root      TEXT,
          tty           TEXT,
          summary       TEXT DEFAULT '',
          session_token TEXT NOT NULL,
          registered_at TEXT NOT NULL,
          started_at    TEXT,
          last_seen     TEXT NOT NULL,
          durable       INTEGER NOT NULL DEFAULT 0,
          host          TEXT
        );
        INSERT INTO peers_droid_new
          (id, name, peer_type, pid, cwd, git_root, tty, summary,
           session_token, registered_at, started_at, last_seen, durable, host)
        SELECT id, name, peer_type, pid, cwd, git_root, tty, summary,
               session_token, registered_at, started_at, last_seen, durable, host
        FROM peers;
        DROP TABLE peers;
        ALTER TABLE peers_droid_new RENAME TO peers;
        CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen);
        CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);
      `);
      console.error("[broker] migration: expanded peer_type constraint to include droid");
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

function migrate_v3_addressing(db: Database): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!columnExists(db, "peers", "persona")) db.exec("ALTER TABLE peers ADD COLUMN persona TEXT");
    if (!columnExists(db, "peers", "capabilities")) db.exec("ALTER TABLE peers ADD COLUMN capabilities TEXT");
    if (!columnExists(db, "peers", "mailbox_owner")) db.exec("ALTER TABLE peers ADD COLUMN mailbox_owner TEXT");
    if (!columnExists(db, "messages", "to_chat")) db.exec("ALTER TABLE messages ADD COLUMN to_chat TEXT");
    if (!columnExists(db, "messages", "from_chat")) db.exec("ALTER TABLE messages ADD COLUMN from_chat TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS chat_routes (
      id         TEXT PRIMARY KEY,
      peer_name  TEXT NOT NULL,
      chat_key   TEXT NOT NULL,
      title      TEXT,
      created_at TEXT NOT NULL,
      last_used  TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_messages_to_chat ON messages(to_id, to_chat, acked)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_chat_routes_owner ON chat_routes(peer_name, chat_key)");
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

const PEERS_TYPE_CHECK = /CHECK\s*\(\s*peer_type\s+IN\s*\(([^)]*)\)\s*\)/i;
const PEERS_CREATE_HEAD = /^CREATE TABLE\s+(?:"peers"|'peers'|`peers`|\[peers\]|peers)\s*\(/i;

/** Expand the peer_type CHECK to admit 'openclaw' without naming columns.
 *  The droid rebuild above lists its columns literally, which is safe only
 *  because it runs before v3. This one runs after everything, so it copies
 *  the stored CREATE TABLE text with just the CHECK list changed, copies rows
 *  by the live column list, verifies the count, and recreates the indexes
 *  that existed. Peer IDs, tokens, and every other table are untouched. */
function migrate_peers_add_openclaw_peer_type(db: Database): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.query<{ sql: string | null }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'peers'"
    ).get();
    const sql = row?.sql ?? "";
    if (!sql.includes("'openclaw'")) {
      const check = sql.match(PEERS_TYPE_CHECK);
      if (!check || !PEERS_CREATE_HEAD.test(sql)) {
        throw new Error("peers table definition not recognized; refusing to rebuild it for the openclaw peer type");
      }
      const types = check[1]!.split(",").map((t) => t.trim()).filter(Boolean);
      types.push("'openclaw'");
      const rebuilt = sql
        .replace(PEERS_TYPE_CHECK, `CHECK(peer_type IN (${types.join(", ")}))`)
        .replace(PEERS_CREATE_HEAD, "CREATE TABLE peers_openclaw_new (");
      const columns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('peers')").all()
        .map((c) => `"${c.name.replace(/"/g, '""')}"`).join(", ");
      const indexes = db.query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'peers' AND sql IS NOT NULL"
      ).all();
      const before = db.query<{ n: number }, []>("SELECT count(*) AS n FROM peers").get()!.n;
      db.exec(rebuilt);
      db.exec(`INSERT INTO peers_openclaw_new (${columns}) SELECT ${columns} FROM peers`);
      const after = db.query<{ n: number }, []>("SELECT count(*) AS n FROM peers_openclaw_new").get()!.n;
      if (after !== before) throw new Error(`openclaw peer-type rebuild copied ${after} of ${before} peers; rolled back`);
      db.exec("DROP TABLE peers");
      db.exec("ALTER TABLE peers_openclaw_new RENAME TO peers");
      for (const index of indexes) db.exec(index.sql);
      console.error("[broker] migration: expanded peer_type constraint to include openclaw");
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw e;
  }
}

// ----- v3 addressing configuration -----
// The broker process sets these once at startup; tests set them directly.
let addressingDeps: AddressingDeps = {};
export function configureAddressing(deps: AddressingDeps): void { addressingDeps = deps; }

/** Hard caps so one caller can never make the broker do unbounded work. */
export const MAX_POLL_BATCH = 100;
export const MAX_ACK_TOKENS = 1000;

// ----- Peer CRUD -----

function* nameCandidates(requested: string | undefined): Generator<string> {
  if (requested && isValidName(requested)) {
    yield requested;
    for (let i = 2; i <= 99; i++) {
      yield appendSuffixWithinLimit(requested, String(i));
    }
  }
  for (let i = 0; i < 100; i++) yield generateName();
  for (let i = 2; i <= 999; i++) {
    const candidate = `${generateName()}-${i}`;
    if (candidate.length <= NAME_MAX_LEN) yield candidate;
  }
}

export function registerPeer(db: Database, req: RegisterRequest): RegisterResponse {
  // The whole register — reclaim-or-insert plus prev_id mailbox re-pointing —
  // runs as ONE transaction so a crash can never leave a new row without its
  // migrated mail (or vice versa).
  return db.transaction(() => {
    const res = registerPeerInner(db, req);
    applyV3RegisterFields(db, res.id, req);
    return res;
  })();
}

/** Persona, capabilities and mailbox owner are refreshed on every register,
 *  so a reclaimed row never keeps a previous incarnation's capabilities. */
function applyV3RegisterFields(db: Database, id: string, req: RegisterRequest): void {
  const persona = typeof req.persona === "string" && req.persona.trim() ? req.persona.trim().slice(0, 64) : null;
  const caps = Array.isArray(req.capabilities)
    ? req.capabilities.filter((c) => typeof c === "string" && /^[a-z0-9-]{1,32}$/.test(c)).slice(0, 16).join(",") || null
    : null;
  const owner = typeof req.mailbox_owner === "string" && isValidName(req.mailbox_owner) ? req.mailbox_owner : null;
  db.query("UPDATE peers SET persona = ?, capabilities = ?, mailbox_owner = ? WHERE id = ?").run(persona, caps, owner, id);
}

function registerPeerInner(db: Database, req: RegisterRequest): RegisterResponse {
  if (req.prev_id && findConversation(db, req.prev_id)) throw new Error("conversation_mailbox_requires_exact_binding");
  const ts = nowIso();
  const requestedStartedAt = canonicalStartedAt(req.started_at, ts);
  // Every register (fresh or reclaim) issues a new session_token. Reclaim
  // rotates the token so the previous session's client (if it's still alive
  // elsewhere) can no longer act as this peer — the token is the session
  // boundary.
  const session_token = randomUUID();
  const host = hostname();

  // Durable retention is EXPLICIT (2026-08-10). The old rule — "asked for a
  // name, therefore durable" — let every `hermes mcp test` spawn and crashed
  // cli-operator peer reserve a name for 7 days. Absent field → ephemeral.
  const durable = req.durable === true && req.name && isValidName(req.name) ? 1 : 0;

  // Reclaim fast-path: stale peer with matching name AND TYPE → UPDATE in
  // place, preserve UUID. The type guard (2026-08-10) stops a claude process
  // from inheriting `ezra-hermes`'s UUID — and therefore its queued mailbox —
  // just by asking for the name. A name-match with a type mismatch falls
  // through to the suffix ladder instead. A same-host peer whose recorded PID
  // is provably gone may reclaim immediately; this preserves its UUID and
  // queued mailbox across an ordinary process restart without waiting for the
  // stale timer. Live, uninspectable, and remote-host peers remain age-gated.
  if (req.name && isValidName(req.name) && !findConversation(db, req.name)) {
    const cutoff = new Date(Date.now() - STALE_RECLAIM_THRESHOLD_MS).toISOString();
    const existing = db.query<
      { pid: number | null; host: string | null },
      [string, RegisterRequest["peer_type"]]
    >("SELECT pid, host FROM peers WHERE name = ? AND peer_type = ?")
      .get(req.name, req.peer_type);
    // Fast reclaim requires positive proof that the old process belonged to
    // this host. A legacy NULL host is unknown ownership, so it remains
    // subject to the normal stale-age gate even when its PID is absent here.
    const sameHost = existing?.host === host;
    const deadLocalProcess = Boolean(
      sameHost && isDefinitelyDeadLocalPid(existing.pid)
    );
    const reclaim = db.query(
      `UPDATE peers
         SET pid = ?, cwd = ?, git_root = ?, tty = ?, summary = ?,
             session_token = ?, last_seen = ?, durable = ?, host = ?,
             started_at = CASE
               WHEN ? IS NULL THEN COALESCE(started_at, registered_at)
               ELSE ?
             END
       WHERE name = ? AND peer_type = ? AND (last_seen < ? OR ? = 1)`
    ).run(
      req.pid, req.cwd, req.git_root, req.tty, req.summary,
      session_token, ts, durable, host,
      requestedStartedAt, requestedStartedAt,
      req.name, req.peer_type, cutoff,
      deadLocalProcess ? 1 : 0,
    );
    if ((reclaim.changes ?? 0) > 0) {
      const row = db.query<{ id: string }, [string]>("SELECT id FROM peers WHERE name = ?").get(req.name);
      if (row) {
        // Clear any stale leases on undelivered messages for this peer. The
        // previous session died mid-delivery — its lease_tokens are now
        // worthless (the old session_token is gone), so the broker would
        // otherwise hold those messages for up to LEASE_DURATION_MS before
        // re-offering them. Clearing on reclaim makes the new session's
        // first poll return the backlog immediately.
        db.query(
          `UPDATE messages SET lease_token = NULL, lease_expires_at = NULL
           WHERE to_id = ? AND acked = 0`
        ).run(row.id);
        repointOrphanedMail(db, req.prev_id, row.id);
        return { id: row.id, name: req.name, session_token };
      }
    }
  }

  // Fresh INSERT with suffix ladder.
  const id = randomUUID();
  const startedAt = requestedStartedAt ?? ts;
  const insert = db.query(
    `INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token, registered_at, started_at, last_seen, durable, host)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const candidate of nameCandidates(req.name)) {
    if (findConversation(db, candidate)) continue;
    try {
      insert.run(
        id, candidate, req.peer_type, req.pid, req.cwd, req.git_root, req.tty, req.summary,
        session_token, ts, startedAt, ts,
        // Only the peer's OWN requested name is durable. If the suffix ladder
        // had to rename it (a genuine concurrent duplicate — a second live
        // Ezra), the fallback name is not the identity anyone addresses, so it
        // stays ephemeral rather than being retained for a week.
        candidate === req.name ? durable : 0,
        host,
      );
      repointOrphanedMail(db, req.prev_id, id);
      return { id, name: candidate, session_token };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new Error("broker: unable to allocate unique peer name after exhaustive retry");
}

/** Mailbox-follows-the-agent (2026-08-10): when a client re-registers after
 *  eviction and its OLD row is gone, its unacked mail is still addressed to
 *  the dead UUID — permanently unreachable under the old behavior (5,202
 *  orphaned messages accumulated this way). Re-point it to the new
 *  incarnation. Guard: only when the previous row is GONE — never rob a live
 *  peer — and never self-referentially.
 *
 *  ACCEPTED RISK: prev_id is client-asserted with no proof of prior
 *  ownership — the old row is gone, so there is no token left to check
 *  against. Any authenticated peer could claim a dead UUID's unacked mail at
 *  register time. This is the one place mail changes addressee without the
 *  addressee's token, and it is accepted because every client on this broker
 *  is inside the same single-user trust boundary (the shared secret file). */
function repointOrphanedMail(db: Database, prevId: string | undefined, newId: string): void {
  if (!prevId || prevId === newId) return;
  if (findConversation(db, prevId)) throw new Error("conversation_mailbox_requires_exact_binding");
  const prevRow = db.query("SELECT id FROM peers WHERE id = ?").get(prevId);
  if (prevRow) return; // previous incarnation's row still exists — not ours to move
  const moved = db.query(
    `UPDATE messages SET to_id = ?, lease_token = NULL, lease_expires_at = NULL
     WHERE to_id = ? AND acked = 0`
  ).run(newId, prevId);
  if ((moved.changes ?? 0) > 0) {
    console.error(`[broker] re-pointed ${moved.changes} unacked message(s) from dead incarnation ${prevId} to ${newId}`);
  }
}

// NOTE: authPeer() was removed after Codex round-C audit. Every mutating
// operation now binds `session_token` directly in its SQL WHERE clause so
// auth and mutation are one atomic statement — eliminating the TOCTOU
// window that allowed a stale session to mutate a reclaim-rotated peer.

// heartbeat/unregister/setSummary: session_token is folded directly into
// every mutation's WHERE clause so the auth check and the mutation are ONE
// atomic statement. A separate authPeer() pre-check would leave a TOCTOU
// window where a reclaim (which rotates session_token) can happen between
// the check and the mutation, letting an old session mutate the reclaimed
// peer's row. Binding the token in WHERE closes that race.

// Returns whether the broker still KNOWS this peer (bd-e57.10).
//
// An UPDATE matching zero rows is not an error in SQL, so this used to return
// void and the caller was told {ok: true} whether or not the peer still existed.
// If the broker is ever down longer than STALE_THRESHOLD_MS, gcStalePeers
// deletes every peer, and each surviving client would then heartbeat into a
// deleted row — succeeding, silently, forever, while invisible to the network.
// The row count is the only evidence that the heartbeat landed. Report it.
export function heartbeatPeer(db: Database, id: string, session_token: string, owner?: ConversationOwner): boolean {
  return withConversationFence(db, id, session_token, owner, () => heartbeatPeerInner(db, id, session_token));
}
function heartbeatPeerInner(db: Database, id: string, session_token: string): boolean {
  const info = db.query("UPDATE peers SET last_seen = ? WHERE id = ? AND session_token = ?")
    .run(nowIso(), id, session_token);
  return (info.changes ?? 0) > 0;
}

export function unregisterPeer(db: Database, id: string, session_token: string, owner?: ConversationOwner): void {
  withConversationFence(db, id, session_token, owner, () => unregisterPeerInner(db, id, session_token));
}
function unregisterPeerInner(db: Database, id: string, session_token: string): void {
  // Messages stay as orphans (spec §5.1).
  db.query("DELETE FROM peers WHERE id = ? AND session_token = ?")
    .run(id, session_token);
}

export function setPeerSummary(db: Database, id: string, session_token: string, summary: string, owner?: ConversationOwner): void {
  withConversationFence(db, id, session_token, owner, () => {
    setPeerSummaryInner(db, id, session_token, summary);
    if (owner) db.query("UPDATE hermes_conversations SET summary = ?, updated_at = ? WHERE peer_id = ?")
      .run(summary, Date.now(), id);
  });
}
function setPeerSummaryInner(db: Database, id: string, session_token: string, summary: string): void {
  db.query("UPDATE peers SET summary = ?, last_seen = ? WHERE id = ? AND session_token = ?")
    .run(summary, nowIso(), id, session_token);
}

// Both getters deliberately use explicit column projection (NOT `SELECT *`)
// so `session_token` never leaks into a Peer object that could be serialized
// back to a client. authPeer() is the only code path that touches
// session_token, and it does its own narrow query.
const PEER_COLS =
  "id, name, peer_type, pid, cwd, git_root, tty, summary, registered_at, " +
  "COALESCE(started_at, registered_at) AS started_at, last_seen, persona";

export function getPeer(db: Database, id: string): Peer | null {
  const row = db.query<Peer, [string]>(`SELECT ${PEER_COLS} FROM peers WHERE id = ?`).get(id);
  return row ?? null;
}

export function getPeerByName(db: Database, name: string): Peer | null {
  const row = db.query<Peer, [string]>(`SELECT ${PEER_COLS} FROM peers WHERE name = ?`).get(name);
  return row ?? null;
}

// ----- Listing -----

export function listPeers(db: Database, req: ListPeersRequest): Peer[] {
  // NO GC here (2026-08-10 fix for the sleep/wake mass eviction). The
  // `last_seen >= cutoff` predicate below already hides stale rows from
  // discovery, which is all a reader needs; deletion belongs exclusively to
  // the suspend-aware GC timer. The old opportunistic gcStalePeers() call made
  // the first list_peers after a laptop wake race ahead of every frozen
  // client's first heartbeat and purge the entire registry (77 → 9 peers,
  // 2026-07-14).

  const clauses: string[] = [];
  const params: (string | null)[] = [];

  // Always hide stale peers from discovery. Even if timer/opportunistic GC
  // hasn't removed the row yet (it happens <= 30s after heartbeat stops),
  // the `last_seen >= cutoff` predicate filters them out of visible results.
  // This is what closes the "closed the tab but peer still shows up" gap.
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  clauses.push("last_seen >= ?");
  params.push(cutoff);
  if (hasConversationSchema(db)) {
    clauses.push(`NOT EXISTS (SELECT 1 FROM hermes_conversations hc WHERE hc.peer_id = peers.id
      AND (hc.state != 'active' OR hc.owner_lease_until <= ${Date.now()}))`);
  }

  if (req.scope === "directory") {
    clauses.push("cwd = ?");
    params.push(req.cwd);
  } else if (req.scope === "repo") {
    if (req.git_root) {
      clauses.push("git_root = ?");
      params.push(req.git_root);
    } else {
      clauses.push("cwd = ?");
      params.push(req.cwd);
    }
  }
  if (req.exclude_id) {
    clauses.push("id != ?");
    params.push(req.exclude_id);
  }
  if (req.peer_type) {
    clauses.push("peer_type = ?");
    params.push(req.peer_type);
  }

  // CRITICAL: explicit column projection — NEVER `SELECT *`. A prior version
  // used `SELECT *` which leaked `session_token` into the public discovery
  // response, collapsing the entire auth model (anyone who could list peers
  // could impersonate them). Whitelist the safe columns here and keep
  // `session_token` out of every client-facing payload.
  const where = `WHERE ${clauses.join(" AND ")}`;
  const sql = `SELECT id, name, peer_type, pid, cwd, git_root, tty, summary,
                      registered_at,
                      COALESCE(started_at, registered_at) AS started_at,
                      last_seen, persona
               FROM peers ${where}
               ORDER BY COALESCE(started_at, registered_at) DESC,
                        registered_at DESC, name ASC, id ASC`;
  // v3: every status starts with the agent's persona name ("Marco: ..."),
  // computed on read so stored summaries stay exactly what the agent wrote
  // and old clients display it with no code change.
  return db.query<Peer, typeof params>(sql).all(...params).map(withPersonaSummary);
}

export function withPersonaSummary<T extends { name: string; summary: string; cwd?: string | null; git_root?: string | null; persona?: string | null }>(row: T): T {
  return { ...row, summary: withPersonaPrefix(row.summary ?? "", personaOf(row)) };
}

// ----- Send -----

export function sendMessage(db: Database, req: SendMessageRequest, owner?: ConversationOwner): SendMessageResponse {
  return withConversationFence(db, req.from_id, req.session_token, owner, () => sendMessageInner(db, req));
}
function sendMessageInner(db: Database, req: SendMessageRequest): SendMessageResponse {
  // Atomic sender auth + target resolution + liveness check + insert, all in
  // a single transaction so nothing can unregister or re-register between
  // steps and orphan a "successful" message (Codex round-D TOCTOU fix).
  const nowStr = nowIso();
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();

  const tx = db.transaction((): SendMessageResponse => {
    // 1. Sender auth (atomic: id + session_token + live)
    const sender = db.query<{ name: string }, [string, string, string]>(
      "SELECT name FROM peers WHERE id = ? AND session_token = ? AND last_seen >= ?"
    ).get(req.from_id, req.session_token, staleCutoff);
    if (!sender) {
      // Distinguish unauthorized vs stale for a better error message.
      const row = db.query<{ last_seen: string; name: string }, [string, string]>(
        "SELECT last_seen, name FROM peers WHERE id = ? AND session_token = ?"
      ).get(req.from_id, req.session_token);
      if (!row) return { ok: false, code: "unauthorized", error: `unauthorized sender: ${req.from_id}` };
      return { ok: false, code: "unauthorized", error: `sender stale: ${row.name}` };
    }

    const conversation = findConversation(db, req.to_id_or_name);
    if (conversation) {
      if (conversation.state === "disposed") return { ok: false, error: "conversation mailbox disposed" };
      const backlog = db.query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND acked = 0",
      ).get(conversation.peer_id)!.n;
      if (backlog >= MAX_QUEUED_PER_DURABLE_PEER) {
        return { ok: false, error: `conversation mailbox full: ${backlog} undelivered (limit 500); message not queued` };
      }
      const inserted = db.query<{ id: number }, [string, string, string, string, string]>(
        "INSERT INTO messages (from_id, to_id, text, sent_at, message_uid) VALUES (?, ?, ?, ?, ?) RETURNING id",
      ).get(req.from_id, conversation.peer_id, req.text, nowStr, randomUUID())!;
      const state = conversation.state === "active" && conversation.owner_lease_until <= Date.now()
        ? "suspended" : conversation.state;
      return { ok: true, message_id: inserted.id, notice: dormantMailboxNotice(state) };
    }

    // 2. Resolve the address inside this transaction (v3: exact UUID or name
    //    first, then case-insensitive and persona matches, chat routes and
    //    remote machines), then insert against the resolved UUID. The
    //    deliverability rule stays in the same INSERT so nothing can
    //    unregister between the check and the write.
    //
    //    A target is deliverable if it is LIVE, or if it is DURABLE. The
    //    original rule was live-only, to avoid writing a message no one would
    //    ever read. That is still right for an ephemeral peer — a closed tab
    //    never returns, so the message really would orphan. It is wrong for a
    //    named agent: it is merely between turns, and refusing the write turns
    //    "your colleague is idle" into "your colleague does not exist". The
    //    message waits in its mailbox and the reclaim path hands it over on
    //    the peer's next registration.
    const resolution = resolveAddress(db, req.to_id_or_name, staleCutoff, addressingDeps);
    if (resolution.kind === "none") return { ok: false, code: "unknown_peer", error: `unknown peer: ${req.to_id_or_name}` };
    if (resolution.kind === "error") {
      return { ok: false, code: resolution.code, error: resolution.error, ...(resolution.candidates?.length ? { candidates: resolution.candidates } : {}) };
    }
    if (resolution.kind === "remote") {
      if (!addressingDeps.remote) {
        return { ok: false, code: "unknown_peer", error: `unknown machine "${resolution.host}": cross-machine delivery is not enabled on this broker` };
      }
      return addressingDeps.remote({
        db, fromId: req.from_id, fromName: sender.name, host: resolution.host, name: resolution.name,
        chat: resolution.chat, text: req.text, fromChat: req.from_chat ?? null, sentAt: nowStr,
      });
    }
    const target = resolution.row;
    const senderRow = rowByName(db, sender.name);
    const senderChat = senderRow ? resolveSenderChat(db, senderRow, req.from_chat, addressingDeps) : null;
    if (senderChat) recordChatRoute(db, senderChat.owner.name, senderChat.chatKey, senderChat.title);
    if (resolution.chatKey) recordChatRoute(db, target.name, resolution.chatKey, resolution.chatTitle);

    const outcome = insertResolvedMessage(db, {
      fromId: req.from_id, target, text: req.text, sentAt: nowStr, messageUid: randomUUID(),
      toChat: resolution.chatKey, fromChat: senderChat?.chatKey ?? null, staleCutoff,
    });
    if (!outcome.ok) return outcome;
    const exactName = req.to_id_or_name === target.id || req.to_id_or_name === target.name;
    const notices = [
      resolution.notice,
      !exactName ? `delivered to ${target.name}${resolution.chatKey ? `, chat "${resolution.chatTitle ?? resolution.chatKey}"` : ""}` : null,
      req.from_chat && !senderChat ? `could not identify your chat "${req.from_chat}", so replies go to your general mailbox` : null,
    ].filter(Boolean);
    return { ok: true, message_id: outcome.message_id, ...(notices.length ? { notice: notices.join("; ") } : {}) };
  });

  return tx();
}

// ----- v3: shared insertion, relayed delivery, directory -----

/** Insert one message for an already-resolved local target. Deliverability
 *  (live, or durable with room) is checked in the same INSERT, so nothing can
 *  unregister between the check and the write. */
function insertResolvedMessage(db: Database, m: {
  fromId: string; target: AddressRow; text: string; sentAt: string; messageUid: string;
  toChat: string | null; fromChat: string | null; staleCutoff: string;
}): SendMessageResponse {
  const inserted = db.query<
    { id: number },
    [string, string, string, string, string | null, string | null, string, string, string]
  >(
    `INSERT INTO messages (from_id, to_id, text, sent_at, message_uid, to_chat, from_chat)
     SELECT ?, p.id, ?, ?, ?, ?, ?
     FROM peers p
     WHERE p.id = ?
       AND (p.last_seen >= ? OR p.durable = 1)
       AND (
         p.last_seen >= ?
         OR (SELECT COUNT(*) FROM messages m
              WHERE m.to_id = p.id AND m.acked = 0) < ${MAX_QUEUED_PER_DURABLE_PEER}
       )
     RETURNING id`
  ).get(
    m.fromId, m.text, m.sentAt, m.messageUid, m.toChat, m.fromChat,
    m.target.id, m.staleCutoff, m.staleCutoff,
  );
  if (inserted) return { ok: true, message_id: inserted.id };
  const backlog = db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM messages WHERE to_id = ? AND acked = 0"
  ).get(m.target.id);
  if ((backlog?.n ?? 0) >= MAX_QUEUED_PER_DURABLE_PEER) {
    return {
      ok: false, code: "mailbox_full",
      error: `target peer mailbox full: ${m.target.name} ` +
             `(${backlog?.n} undelivered; it has not polled since ${m.target.last_seen})`,
    };
  }
  return { ok: false, code: "stale_peer", error: `target peer stale: ${m.target.name}` };
}

export interface RelayedMessage {
  to_address: string;
  text: string;
  /** The sender's UUID on its own machine (or its chat-route UUID). */
  from_id: string;
  from_chat: string | null;
  message_uid: string;
  sent_at: string;
}

/** Deliver a message relayed from another machine. Resolution is LOCAL ONLY
 *  (any host part is treated as this machine), so a relay can never bounce
 *  between brokers. The federation layer dedupes on message_uid first. */
export function deliverRelayed(db: Database, m: RelayedMessage): SendMessageResponse {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  return db.transaction((): SendMessageResponse => {
    const localDeps: AddressingDeps = { chats: addressingDeps.chats, isLocalHost: () => true };
    const resolution = resolveAddress(db, m.to_address, staleCutoff, localDeps);
    if (resolution.kind === "none" || resolution.kind === "remote") {
      return { ok: false, code: "unknown_peer", error: `unknown peer: ${m.to_address}` };
    }
    if (resolution.kind === "error") {
      return { ok: false, code: resolution.code, error: resolution.error, ...(resolution.candidates?.length ? { candidates: resolution.candidates } : {}) };
    }
    if (resolution.chatKey) recordChatRoute(db, resolution.row.name, resolution.chatKey, resolution.chatTitle);
    const outcome = insertResolvedMessage(db, {
      fromId: m.from_id, target: resolution.row, text: m.text, sentAt: m.sent_at || nowIso(),
      messageUid: m.message_uid, toChat: resolution.chatKey, fromChat: m.from_chat, staleCutoff,
    });
    if (outcome.ok && resolution.notice) return { ...outcome, notice: resolution.notice };
    return outcome;
  })();
}

/** The sender of a message leaving this machine, as the federation layer
 *  stores it. Same shape as FederationSender in shared/federation.ts. */
export interface OutboundSender {
  /** Reply UUID: the peer itself, or the stable chat route for a chat sender. */
  id: string;
  /** Local mailbox owner UUID (the profile's durable peer for a Hermes chat
   *  or election loser), where delivery notices are kept. */
  peer_id: string;
  name: string;
  peer_type: PeerType;
  cwd: string;
  summary: string;
  /** Stable chat key (never the raw title), or null. */
  chat: string | null;
}

/** Federation hook. Runs inside the send transaction, after the sender was
 *  authenticated. Records the sender's chat route so a remote reply to the
 *  chat UUID resolves here. */
export function snapshotSender(db: Database, req: RemoteSendRequest): OutboundSender {
  const row = rowByName(db, req.fromName);
  const peer = getPeer(db, req.fromId);
  if (!row || !peer || row.id !== req.fromId) throw new Error("federation: sender is not registered");
  const chat = resolveSenderChat(db, row, req.fromChat ?? undefined, addressingDeps);
  const routeId = chat ? recordChatRoute(db, chat.owner.name, chat.chatKey, chat.title) : null;
  const owner = mailboxOwnerRow(db, row);
  return {
    id: routeId ?? row.id,
    peer_id: owner.id,
    name: chat ? chat.owner.name : row.name,
    peer_type: row.peer_type as PeerType,
    cwd: peer.cwd,
    summary: withPersonaSummary(peer).summary,
    chat: chat?.chatKey ?? null,
  };
}

/** Federation hook: a delivery notice from the broker itself. Inserted even
 *  when the recipient is stale or its row was collected, so a later
 *  re-registration with prev_id still hands it over. Idempotent on
 *  message_uid. Synchronous; the caller supplies the transaction. */
export function deliverNotice(db: Database, n: {
  to_id: string; to_chat: string | null; from_id: string; text: string; sent_at: string; message_uid: string;
}): { message_id: number } {
  db.query(
    `INSERT INTO messages (from_id, to_id, text, sent_at, message_uid, to_chat)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(message_uid) DO NOTHING`,
  ).run(n.from_id, n.to_id, n.text, n.sent_at, n.message_uid, n.to_chat);
  return { message_id: db.query<{ id: number }, [string]>("SELECT id FROM messages WHERE message_uid = ?").get(n.message_uid)!.id };
}

/** Local directory for other machines: live plus retained durable agents,
 *  persona statuses, never tokens, never a fan-out of its own. */
export function listDirectoryPeers(db: Database, req: { query?: string } = {}): Peer[] {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  const ids = req.query && req.query.trim()
    ? findPeers(db, req.query.trim(), staleCutoff).map((r) => r.id)
    : db.query<{ id: string }, [string]>("SELECT id FROM peers WHERE last_seen >= ? OR durable = 1").all(staleCutoff).map((r) => r.id);
  return ids.map((id) => getPeer(db, id)).filter((p): p is Peer => p !== null).map(withPersonaSummary);
}

// ----- v3: chat discovery and the Hermes chat inbox -----

export type { ListChatsRequest, ListChatsResponse, ChatInboxEntry } from "./shared/types.ts";

export const BROKER_CAPABILITIES = ["persona-names", "chat-mail", "list-chats", "chat-inbox", "bounded-poll", "peer-inbox"];


/** Read-only chat lookup: titles and status, never transcript text. It does
 *  not adopt, wake or consume mail. */
export function listChats(db: Database, req: ListChatsRequest): ListChatsResponse {
  if (!chatListCallerOk(db, req)) return { ok: false, error: "unauthorized or stale caller" };
  return listChatsFor(db, String(req.peer ?? "").split("/")[0]!.trim(), req);
}

function chatListCallerOk(db: Database, req: { id: string; session_token: string }): boolean {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  return Boolean(db.query<{ id: string }, [string, string, string]>(
    "SELECT id FROM peers WHERE id = ? AND session_token = ? AND last_seen >= ?",
  ).get(req.id, req.session_token, staleCutoff));
}

/** The chat lookup itself, without caller authentication. The local route
 *  authenticates the caller first; federation authenticates the machine. */
export function listChatsFor(
  db: Database, peer: string, req: { query?: string; limit?: number; offset?: number },
): ListChatsResponse {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  const named = resolvePeerName(db, peer, staleCutoff);
  if (!named) return { ok: false, error: `unknown peer: ${peer}` };
  if ("error" in named) return { ok: false, error: named.error, candidates: named.candidates };
  if (named.row.peer_type !== "hermes") return { ok: false, error: `${named.row.name} is a ${named.row.peer_type} peer; only Hermes agents have chats` };
  const owner = mailboxOwnerRow(db, named.row);
  if (!addressingDeps.chats) return { ok: false, error: "chat lookup is not available on this machine" };
  const limit = Math.max(1, Math.min(50, Math.floor(Number(req.limit) || 20)));
  const offset = Math.max(0, Math.floor(Number(req.offset) || 0));
  const query = typeof req.query === "string" && req.query.trim() ? req.query.trim().slice(0, 200) : undefined;
  const chats = addressingDeps.chats.list(owner, { query, limit, offset });
  return {
    ok: true,
    peer: owner.name,
    chats: chats.map((c) => ({ ...c, address: `${owner.name}/${c.chat_key}` })),
  };
}

/** The /list-chats route. `peer` may name another machine (name@host); then
 *  the lookup runs on that machine's broker through federation. */
export async function listChatsRouted(
  db: Database, req: ListChatsRequest,
  federation: { service: FederationService; config: FederationConfig } | null,
): Promise<ListChatsResponse> {
  if (!chatListCallerOk(db, req)) return { ok: false, error: "unauthorized or stale caller" };
  const parsed = parseAddress(String(req.peer ?? ""));
  if (!parsed.name) return { ok: false, error: "list_chats needs a peer name" };
  const local = !parsed.host || (federation ? federation.service.isLocalHost(parsed.host) : defaultIsLocalHost(parsed.host));
  const opts = { query: req.query, limit: req.limit, offset: req.offset };
  if (!local) {
    if (!federation) {
      return { ok: false, error: `federation is off on this machine, so chats on ${parsed.host} can't be listed` };
    }
    return federation.service.chats(parsed.host!, { peer: parsed.name, ...opts });
  }
  const here = listChatsFor(db, parsed.name, req);
  // Same rules as a bare-name send: a name unknown here may live on another
  // machine. Exactly one remote Hermes match is listed. Several matches, or a
  // down machine that might hold another one, need an explicit name@host.
  if (here.ok || parsed.host || !federation?.config.enabled || !here.error?.startsWith("unknown peer:")) return here;
  const directory = await federation.service.directory(parsed.name);
  const remotes = directory.peers.filter((p) => !federation.service.isLocalHost(p.host) && p.peer_type === "hermes");
  const names = remotes.map((p) => p.name);
  const down = directory.unreachable_hosts;
  if (down.length && remotes.length <= 1) {
    return { ok: false, error: `Can't resolve "${parsed.name}" while these machines are unreachable: ${down.join(", ")}. Use an explicit name@host.`,
      ...(names.length ? { candidates: names } : {}) };
  }
  if (remotes.length === 1) {
    return federation.service.chats(remotes[0]!.host, { peer: parseAddress(remotes[0]!.name).name, ...opts });
  }
  if (remotes.length > 1) {
    const hosts = [...new Set(remotes.map((p) => p.host))];
    return { ok: false, candidates: names, error: hosts.length === 1
      ? `"${parsed.name}" matches ${remotes.length} Hermes agents on ${hosts[0]}: ${names.join(", ")}. Use one exact name.`
      : `"${parsed.name}" matches Hermes agents on several machines (${hosts.join(", ")}): ${names.join(", ")}. Use one exact name@host.` };
  }
  return here;
}


/** Unread Hermes mail grouped by recipient chat, for the wake daemon. Only
 *  chat-capable owners are listed for general mail, so old Hermes processes
 *  keep today's behavior until they restart on new code. */
export function chatInbox(db: Database): ChatInboxEntry[] {
  const now = nowIso();
  const rows = db.query<Omit<ChatInboxEntry, "title">, [string]>(
    `SELECT p.id AS peer_id, p.name AS peer_name, m.to_chat AS to_chat,
            COUNT(*) AS unread,
            SUM(CASE WHEN m.lease_token IS NOT NULL AND m.lease_expires_at >= ? THEN 1 ELSE 0 END) AS leased,
            MAX(m.id) AS max_id, MIN(m.sent_at) AS oldest_sent_at
       FROM messages m JOIN peers p ON p.id = m.to_id
      WHERE m.acked = 0 AND p.peer_type = 'hermes'
        AND (m.to_chat IS NOT NULL OR (',' || COALESCE(p.capabilities, '') || ',') LIKE '%,${CHAT_MAIL_CAPABILITY},%')
      GROUP BY m.to_id, m.to_chat
      ORDER BY MIN(m.id)`,
  ).all(now);
  return rows.map((r) => ({
    ...r,
    title: r.to_chat
      ? db.query<{ title: string | null }, [string, string]>("SELECT title FROM chat_routes WHERE peer_name = ? AND chat_key = ? ORDER BY created_at LIMIT 1").get(r.peer_name, r.to_chat)?.title ?? null
      : null,
  }));
}

/** Unread mail per OpenClaw peer, for the OpenClaw wake pass (bd-b2in.17).
 *  An OpenClaw agent-peers child lives only while its Codex thread is
 *  loaded, so the durable row can hold mail with no process writing an inbox
 *  file. The exact unread ids let the pass wake at most once per unread set. */
export function peerInbox(db: Database, peerType: string, peerIds: unknown = []): PeerInboxEntry[] {
  if (peerType !== "openclaw") return [];
  // Bound ids are matched on messages.to_id directly: an OpenClaw child only
  // heartbeats while its thread is loaded, so the broker can delete a quiet
  // durable row (7 days) while its unacked mail (30 days) still waits. The
  // next registration's prev_id re-points that mail; the wake must still fire.
  const ids = (Array.isArray(peerIds) ? peerIds : [])
    .filter((v): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)).slice(0, 32);
  const rows = db.query<{ peer_id: string; peer_name: string | null; id: number }, string[]>(
    `SELECT m.to_id AS peer_id, p.name AS peer_name, m.id AS id
       FROM messages m LEFT JOIN peers p ON p.id = m.to_id
      WHERE m.acked = 0
        AND (p.peer_type = ?${ids.length ? ` OR m.to_id IN (${ids.map(() => "?").join(", ")})` : ""})
      ORDER BY m.id`,
  ).all(peerType, ...ids);
  const byPeer = new Map<string, PeerInboxEntry>();
  for (const r of rows) {
    const entry = byPeer.get(r.peer_id) ?? { peer_id: r.peer_id, peer_name: r.peer_name, unread_ids: [] };
    if (entry.unread_ids.length < 500) entry.unread_ids.push(r.id);
    byPeer.set(r.peer_id, entry);
  }
  return [...byPeer.values()];
}

// ----- Poll (lease) -----

export function pollMessages(db: Database, id: string, session_token: string, owner?: ConversationOwner, chat?: string): LeasedMessage[] {
  return pollMessagesScoped(db, id, session_token, owner, chat).messages;
}
/** v3: a poll also reports which mailbox it read. For a chat poll, chat_key
 *  is the resolved stable key, so a client can file the mail per chat even
 *  when it named the chat by title or by a later session in its lineage. */
export interface PollScopeReport { scope: "general" | "chat" | "none"; chat_key: string | null }
export function pollMessagesScoped(db: Database, id: string, session_token: string, owner?: ConversationOwner, chat?: string):
  { messages: LeasedMessage[] } & PollScopeReport {
  return withConversationFence(db, id, session_token, owner, () => {
    const report: PollScopeReport = { scope: "none", chat_key: null };
    const messages = pollMessagesInner(db, id, session_token, chat, report);
    return { messages, ...report };
  });
}
function pollMessagesInner(db: Database, id: string, session_token: string, chat: string | undefined, report: PollScopeReport): LeasedMessage[] {
  const now = new Date();
  const nowStr = now.toISOString();
  const leaseUntil = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();

  const tx = db.transaction(() => {
    // Session-token auth — caller must prove peer ownership. If the token
    // doesn't match or the peer is gone we return empty (matches "no
    // messages" semantically, without exposing anyone's mailbox).
    const peerRow = db.query<{ last_seen: string }, [string, string]>(
      "SELECT last_seen FROM peers WHERE id = ? AND session_token = ?"
    ).get(id, session_token);
    if (!peerRow) {
      return [] as LeasedMessage[];
    }
    // Heartbeat, throttled: every session polls about once a second, and an
    // unconditional UPDATE made each empty poll a durable (fsynced) write.
    // last_seen only has to beat STALE_THRESHOLD_MS (60s), so refreshing it
    // when it is POLL_HEARTBEAT_WRITE_MS old keeps rows live with far fewer writes.
    if (Date.parse(peerRow.last_seen) <= now.getTime() - POLL_HEARTBEAT_WRITE_MS) {
      db.query("UPDATE peers SET last_seen = ? WHERE id = ? AND session_token = ?")
        .run(nowStr, id, session_token);
    }

    // v3 mail scope. A poll without a chat (every old client, and every
    // non-Hermes client) draws only general mail, so chat-addressed mail can
    // never be consumed by the wrong conversation. A Hermes chat names
    // itself and draws only its own mail, which lives in the profile's
    // durable owner mailbox.
    const requester = rowByName(db, db.query<{ name: string }, [string]>("SELECT name FROM peers WHERE id = ?").get(id)!.name)!;
    const scope = resolvePollScope(db, requester, chat, addressingDeps);
    report.scope = scope.mode;
    report.chat_key = scope.mode === "chat" ? scope.chatKey : null;
    if (scope.mode === "none") return [] as LeasedMessage[];
    type Row = { id: number; from_id: string; to_id: string; text: string; sent_at: string; to_chat: string | null; from_chat: string | null };
    const rows = scope.mode === "general"
      ? db.query<Row, [string, string]>(
          `SELECT id, from_id, to_id, text, sent_at, to_chat, from_chat
           FROM messages
           WHERE to_id = ? AND to_chat IS NULL AND acked = 0
             AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)
           ORDER BY id ASC LIMIT ${MAX_POLL_BATCH}`
        ).all(scope.mailboxId, nowStr)
      : db.query<Row, [string, string, string]>(
          `SELECT id, from_id, to_id, text, sent_at, to_chat, from_chat
           FROM messages
           WHERE to_id = ? AND to_chat = ? AND acked = 0
             AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)
           ORDER BY id ASC LIMIT ${MAX_POLL_BATCH}`
        ).all(scope.mailboxId, scope.chatKey, nowStr);

    const result: LeasedMessage[] = [];
    for (const row of rows) {
      const lease = randomUUID();
      db.query("UPDATE messages SET lease_token = ?, lease_expires_at = ? WHERE id = ?")
        .run(lease, leaseUntil, row.id);
      const relayed = addressingDeps.senderForMessage?.(row.id) ?? null;
      const sender = relayed ? null : getPeer(db, row.from_id);
      const shown = sender ? withPersonaSummary(sender) : null;
      let fromId = row.from_id;
      let fromName = sender?.name ?? "(gone)";
      let fromSummary = shown?.summary ?? "";
      if (row.from_chat && sender) {
        // Replies must return to the sending chat, including from old
        // clients that reply to from_id or from_name.
        const senderRow = rowByName(db, sender.name);
        const ownerName = senderRow ? mailboxOwnerRow(db, senderRow).name : sender.name;
        const route = db.query<{ id: string; title: string | null }, [string, string]>(
          "SELECT id, title FROM chat_routes WHERE peer_name = ? AND chat_key = ? ORDER BY created_at LIMIT 1",
        ).get(ownerName, row.from_chat);
        fromId = route?.id ?? recordChatRoute(db, ownerName, row.from_chat, null);
        const title = route?.title;
        fromName = `${ownerName}/${row.from_chat}`;
        fromSummary = `chat "${title ?? row.from_chat}" — ${fromSummary}`;
      }
      if (relayed) {
        fromId = relayed.from_id;
        fromName = relayed.from_name;
        fromSummary = relayed.from_summary;
      }
      result.push({
        id: row.id,
        from_id: fromId,
        from_name: fromName,
        from_peer_type: (relayed?.from_peer_type ?? sender?.peer_type ?? "claude") as LeasedMessage["from_peer_type"],
        from_cwd: relayed?.from_cwd ?? sender?.cwd ?? "",
        from_summary: fromSummary,
        to_id: row.to_id,
        text: row.text,
        sent_at: row.sent_at,
        lease_token: lease,
        ...(row.to_chat ? { to_chat: row.to_chat } : {}),
        ...(row.from_chat ? { from_chat: row.from_chat } : {}),
      });
    }
    return result;
  });

  return tx();
}

// ----- Ack -----

export function ackMessages(db: Database, req: AckMessagesRequest, owner?: ConversationOwner): AckMessagesResponse {
  return withConversationFence(db, req.id, req.session_token, owner, () => ackMessagesInner(db, req));
}
function ackMessagesInner(db: Database, req: AckMessagesRequest): AckMessagesResponse {
  if (req.lease_tokens.length === 0) return { ok: true, acked: 0, stale: 0, results: [] };
  if (req.lease_tokens.length > MAX_ACK_TOKENS) throw new Error(`too many lease tokens in one ack (${req.lease_tokens.length} > ${MAX_ACK_TOKENS})`);
  const now = nowIso();
  // Atomic auth via subquery: the UPDATE only affects messages whose to_id
  // belongs to a peer row with the matching session_token. No separate
  // pre-check → no TOCTOU window across reclaim-rotation.
  const placeholders = req.lease_tokens.map(() => "?").join(",");
  const sql = `UPDATE messages SET acked = 1, lease_token = NULL, lease_expires_at = NULL
               WHERE lease_token IN (${placeholders})
                 AND to_id IN (
                   SELECT id FROM peers WHERE id = ? AND session_token = ?
                   UNION
                   -- v3: a Hermes member may confirm its own chat's mail,
                   -- which lives in the profile owner's mailbox.
                   SELECT o.id FROM peers r JOIN peers o ON o.name = r.mailbox_owner AND o.peer_type = r.peer_type
                    WHERE r.id = ? AND r.session_token = ?
                 )
                 AND acked = 0
                 AND lease_expires_at IS NOT NULL
                 AND lease_expires_at >= ?`;
  // Snapshot which submitted tokens exist BEFORE the UPDATE clears them —
  // afterwards a token cleared by this call and a token that never existed
  // both read back as no-row, and "never existed" must report `unknown`,
  // not `acked`. One transaction so no third party interleaves.
  const ackTx = db.transaction(() => {
    const existing = new Set(
      db.query<{ lease_token: string }, string[]>(
        `SELECT lease_token FROM messages WHERE lease_token IN (${placeholders})`
      ).all(...req.lease_tokens).map((r) => r.lease_token),
    );
    const info = db.query(sql).run(...req.lease_tokens, req.id, req.session_token, req.id, req.session_token, now);
    return { existing, changes: info.changes ?? 0 };
  });
  const { existing, changes: acked } = ackTx();

  // Typed per-token outcomes (2026-08-10, kills the success-shaped
  // `{ok:true, acked:0}` blind spot): a caller that acked fewer tokens than it
  // sent can now tell WHY. `expired` means the lease outlived the caller's
  // tool cycle and the broker will re-offer the message — the caller should
  // expect a re-delivery, not assume the ack landed.
  let stale = 0;
  let results: NonNullable<AckMessagesResponse["results"]> | undefined;
  if (acked < req.lease_tokens.length) {
    results = req.lease_tokens.map((token) => {
      if (!existing.has(token)) return { token, status: "unknown" as const };
      const row = db.query<{ acked: number; lease_expires_at: string | null; to_id: string }, [string]>(
        "SELECT acked, lease_expires_at, to_id FROM messages WHERE lease_token = ?"
      ).get(token);
      // Existed pre-UPDATE, no longer holds the token → this call acked it.
      if (!row) return { token, status: "acked" as const };
      if (row.acked === 1) return { token, status: "acked" as const };
      const owner = db.query<{ id: string; mailbox_owner: string | null; peer_type: string }, [string, string]>(
        "SELECT id, mailbox_owner, peer_type FROM peers WHERE id = ? AND session_token = ?"
      ).get(req.id, req.session_token);
      const ownerMailbox = owner?.mailbox_owner
        ? db.query<{ id: string }, [string, string]>("SELECT id FROM peers WHERE name = ? AND peer_type = ?").get(owner.mailbox_owner, owner.peer_type)?.id
        : undefined;
      if (!owner || (row.to_id !== owner.id && row.to_id !== ownerMailbox)) return { token, status: "wrong_session" as const };
      if (row.lease_expires_at !== null && row.lease_expires_at < now) {
        return { token, status: "expired" as const };
      }
      return { token, status: "unknown" as const };
    });
    stale = results.filter((r) => r.status === "expired").length;
  }
  return { ok: true, acked, stale, results };
}

// ----- Rename -----

export function renamePeer(db: Database, req: RenamePeerRequest, owner?: ConversationOwner): RenamePeerResponse {
  return withConversationFence(db, req.id, req.session_token, owner, () => {
    const reservation = findConversation(db, req.new_name);
    if (reservation && reservation.peer_id !== req.id) return { ok: false, error: "name reserved by conversation" };
    const result = renamePeerInner(db, req);
    if (owner && result.ok) {
      db.query("UPDATE hermes_conversations SET name = ?, updated_at = ? WHERE peer_id = ?")
        .run(result.name!, Date.now(), req.id);
    }
    return result;
  });
}
function renamePeerInner(db: Database, req: RenamePeerRequest): RenamePeerResponse {
  if (!isValidName(req.new_name)) return { ok: false, error: "invalid name" };
  // Atomic auth + rename: session_token is bound in the WHERE, so a
  // reclaim-rotated row is unchangeable by a stale session. Zero changes
  // means either the peer_id is unknown OR the session_token is wrong;
  // we return "unauthorized rename" in both cases (no auth-vs-enumeration
  // leak).
  try {
    return db.transaction((): RenamePeerResponse => {
      const before = db.query<{ name: string }, [string, string]>(
        "SELECT name FROM peers WHERE id = ? AND session_token = ?",
      ).get(req.id, req.session_token);
      const info = db.query(
        "UPDATE peers SET name = ?, last_seen = ? WHERE id = ? AND session_token = ?"
      ).run(req.new_name, nowIso(), req.id, req.session_token);
      if (!before || (info.changes ?? 0) === 0) return { ok: false, error: "unauthorized rename" };
      if (before.name !== req.new_name) {
        // v3: chat routes and member links follow the agent. Route UUIDs are
        // kept, so replies to chats addressed before the rename still land.
        db.query("UPDATE chat_routes SET peer_name = ? WHERE peer_name = ?").run(req.new_name, before.name);
        db.query("UPDATE peers SET mailbox_owner = ? WHERE mailbox_owner = ?").run(req.new_name, before.name);
      }
      return { ok: true, name: req.new_name };
    })();
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: "name taken" };
    throw e;
  }
}

// NOTE: there is no broker-side "admin rename" function. cli.ts 'rename'
// reads the target peer's session_token directly from the SQLite file
// (SELECT id, session_token FROM peers WHERE id=? OR name=?) and then calls
// the regular session-authenticated /rename-peer. The OS file permissions on
// ~/.agent-peers.db are the operator trust boundary — only the user who owns
// the file can run the CLI's admin rename.

// ----- GC -----

export function gcStalePeers(db: Database): number {
  // Two-tier retention. Ephemeral peers (generated names — session tabs) are
  // deleted as soon as they go stale, which is what keeps a closed tab from
  // lingering. Durable peers (named agents) keep their row, and therefore
  // their UUID and their undelivered mail, until DURABLE_RETENTION_MS.
  //
  // Deleting a durable peer at the staleness cutoff is what broke cross-agent
  // messaging: a Hermes agent stops heartbeating between turns, so it was
  // erased from the registry within 60s of finishing a reply and every message
  // to it then failed with "unknown peer".
  const now = Date.now();
  const staleCutoff = new Date(now - STALE_THRESHOLD_MS).toISOString();
  const durableCutoff = new Date(now - DURABLE_RETENTION_MS).toISOString();
  const info = db.query(
    `DELETE FROM peers
      WHERE (durable = 0 AND last_seen < ?)
         OR (durable = 1 AND last_seen < ?)`
  ).run(staleCutoff, durableCutoff);
  return info.changes ?? 0;
}

// Message-history retention. Acked rows are receipts; keep them 7 days for
// recovery reconciliation, then prune. Unacked rows follow durable-peer
// retention (7 days) — past that the recipient is gone for good and the row
// is only reachable via the orphan/stranded tooling, which snapshots before
// this runs (Phase-0 census + cli.ts stranded-messages).
export const MESSAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** True when a GC tick observed far more wall-clock than its own interval —
 *  the machine slept. Deleting on that tick would evict the entire registry
 *  before any frozen client's heartbeat could land. */
export function shouldSkipGcSweep(elapsedMs: number): boolean {
  return elapsedMs > GC_INTERVAL_MS * 3;
}

export const UNACKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function gcOldMessages(db: Database): number {
  // Acked mail is done — 7 days is plenty for forensics. UNACKED mail is a
  // delivery obligation: it may be addressed to a durable peer with a broken
  // ack pipeline, so it gets a much longer window (30d) instead of riding
  // the same cutoff. It still expires eventually — mail to a UUID nobody
  // will ever reclaim must not accumulate forever (5,202 orphans did).
  const ackedCutoff = new Date(Date.now() - MESSAGE_RETENTION_MS).toISOString();
  const unackedCutoff = new Date(Date.now() - UNACKED_RETENTION_MS).toISOString();
  const conversationExemption = hasConversationSchema(db)
    ? " AND NOT EXISTS (SELECT 1 FROM hermes_conversations hc WHERE hc.peer_id = messages.to_id)"
    : "";
  // Unread chat mail never expires here. A Hermes owner's background loop reads
  // only its general mailbox, so mail to a chat nobody has opened exists only
  // in this table until that chat reads it.
  const chatExemption = columnExists(db, "messages", "to_chat") ? " AND to_chat IS NULL" : "";
  const info = db.query(
    `DELETE FROM messages WHERE (acked = 1 AND sent_at < ?) OR (acked = 0 AND sent_at < ?${conversationExemption}${chatExemption})`
  ).run(ackedCutoff, unackedCutoff);
  return info.changes ?? 0;
}

// ----- Protection check (consumed by MacGuardian's process reaper) -----
//
// Contract with mac-os-system-expert/guardians: this endpoint is a POSITIVE
// signal ONLY. Its answer may SPARE a process; it may never condemn one.
// A pid's absence here is not evidence of death — the reaper falls back to its
// own (weaker) tests. If the broker is unreachable the reaper reaps nothing in
// the classes that depend on us. Rationale: an LLM agent waiting on a model
// response sits at ~0% CPU, so no CPU/idleness heuristic can distinguish live
// work from a corpse. Only an authoritative registry can.
//
// PROTECTION_GENERATION lets the reaper detect a broker restart between its
// classify-time query and its pre-signal re-query, and bail rather than act on
// a lease issued by a previous instance.
export const PROTECTION_GENERATION = randomUUID();
export const PROTECTION_SCHEMA = 1;
export const PROTECTION_LEASE_MS = 15_000;
const PROTECTION_MAX_ENTRIES = 512;

export interface ProtectionQueryEntry {
  pid: number;
  start_time?: string | null;
}

/** Canonical `ps` start-time identity. macOS pads single-digit month days with
 *  an extra space; callers may already have collapsed that presentation-only
 *  whitespace. Normalize every whitespace run on both sides before comparing. */
function canonicalStartTime(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** One `ps` snapshot of every process's start time. Replaces the old
 *  per-entry `ps -o lstart= -p <pid>` (one subprocess spawn per queried pid,
 *  up to PROTECTION_MAX_ENTRIES+1 spawns per request — a local-DoS lever on an
 *  unauthenticated endpoint). An empty map means inspection failed, which must
 *  read as "we can see nothing", never "everything is gone". */
function readStartTimeTable(): Map<number, string> {
  const startOf = new Map<number, string>();
  try {
    const p = Bun.spawnSync(["ps", "-axo", "pid=,lstart="]);
    if (p.exitCode !== 0) return startOf;
    for (const line of new TextDecoder().decode(p.stdout).split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m?.[1] || !m[2]) continue;
      startOf.set(parseInt(m[1], 10), canonicalStartTime(m[2]));
    }
  } catch { /* fall through with empty map */ }
  return startOf;
}

interface ProcTable {
  parentOf: Map<number, number>;
  commandOf: Map<number, string>;
  childrenOf: Map<number, number[]>;
}

/** One snapshot of the live process table. An empty table means inspection
 *  failed, which must mean "we vouch for nothing" — never "everything is dead". */
function readProcTable(): ProcTable {
  const parentOf = new Map<number, number>();
  const commandOf = new Map<number, string>();
  const childrenOf = new Map<number, number[]>();
  try {
    const p = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]);
    if (p.exitCode !== 0) return { parentOf, commandOf, childrenOf };
    for (const line of new TextDecoder().decode(p.stdout).split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m?.[1] || !m[2] || !m[3]) continue;
      const pid = parseInt(m[1], 10);
      const ppid = parseInt(m[2], 10);
      parentOf.set(pid, ppid);
      commandOf.set(pid, m[3]);
      const kids = childrenOf.get(ppid);
      if (kids) kids.push(pid); else childrenOf.set(ppid, [pid]);
    }
  } catch { /* fall through with empty maps */ }
  return { parentOf, commandOf, childrenOf };
}

/** A GUI application process (ChatGPT.app, Zed.app, cmux.app, …). */
function isGuiApp(command: string | undefined): boolean {
  return command !== undefined && /\.app\/Contents\/MacOS\//.test(command);
}

/** Live agent-peers MCP servers. Each one's PARENT is its agent host — either a
 *  GUI app (ChatGPT/Zed/cmux) or, for headless sessions, a bare claude/codex
 *  process whose own parent is launchd or sshd. */
function findAgentMcpServers(table: ProcTable): number[] {
  const pids: number[] = [];
  for (const [pid, command] of table.commandOf) {
    if (/agent-peers-mcp\/(claude|codex|hermes|droid|openclaw)-server\.ts/.test(command)) pids.push(pid);
  }
  return pids;
}

/**
 * The set of pids that belong to live agent work, and therefore must never be
 * reaped. Anchors come from TWO independent sources, unioned:
 *
 *   1. The peers registry (authoritative, but gcStalePeers() deletes any peer
 *      that has not heartbeated in STALE_THRESHOLD_MS).
 *   2. Direct discovery of live agent-peers MCP servers in the process table.
 *
 * Source 2 exists precisely because source 1 can expire. A session that is
 * thinking for twenty minutes may stop heartbeating while being entirely
 * alive; if the registry were our only anchor we would silently stop vouching
 * for it, which is the "idle looks dead" bug in a new costume. A process that
 * EXISTS is alive by definition — that inference is sound in a way that
 * inferring death from idleness never was.
 *
 * From each anchor we protect the MCP server and its agent host. We expand the
 * host's whole subtree ONLY for headless hosts. A GUI host is deliberately not
 * expanded: ChatGPT.app is the direct parent of ~200 MCP servers, so expanding
 * it would sweep in hundreds of unrelated processes to say something the
 * reaper's own `.app`-ancestor test already says. The gap worth closing is the
 * headless session — launched from launchd, sshd, or a bare shell — which has
 * no `.app` above it and is therefore invisible to that test. That is where the
 * broker knows something the reaper cannot infer.
 */
export function buildProtectedPidSet(db: Database): Set<number> {
  const protectedPids = new Set<number>();
  const table = readProcTable();
  const { parentOf, commandOf, childrenOf } = table;
  if (parentOf.size === 0) return protectedPids; // inspection failed: vouch for nothing

  const alive = (pid: number) => parentOf.has(pid);

  // The broker itself. It is PPID=1 by design (a LaunchAgent), which is exactly
  // what made the old reaper misread it as an orphan and SIGKILL it every 30
  // minutes for weeks.
  if (alive(process.pid)) protectedPids.add(process.pid);

  const anchors = new Set<number>(findAgentMcpServers(table));
  try {
    for (const row of db.query("SELECT pid FROM peers WHERE pid IS NOT NULL").all() as { pid: number }[]) {
      if (Number.isInteger(row.pid) && alive(row.pid)) anchors.add(row.pid);
    }
  } catch { /* registry unreadable: fall back to process-table anchors only */ }

  for (const anchor of anchors) {
    protectedPids.add(anchor);

    // The agent host is the MCP server's parent. Never expand from pid 0/1:
    // launchd's subtree is the whole machine, and "protect everything" would
    // make the reaper useless rather than safe.
    const host = parentOf.get(anchor);
    if (host === undefined || host <= 1) continue;
    protectedPids.add(host);

    if (isGuiApp(commandOf.get(host))) continue; // already covered by the .app test

    const stack = [...(childrenOf.get(host) ?? [])];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (protectedPids.has(pid)) continue;
      protectedPids.add(pid);
      for (const kid of childrenOf.get(pid) ?? []) stack.push(kid);
    }
  }

  return protectedPids;
}

export function checkProtection(db: Database, entries: ProtectionQueryEntry[]) {
  const protectedPids = buildProtectedPidSet(db);
  const leaseUntil = new Date(Date.now() + PROTECTION_LEASE_MS).toISOString();
  // Exactly one start-time snapshot per request, shared by every entry.
  const startTimeOf = readStartTimeTable();

  const results = entries.slice(0, PROTECTION_MAX_ENTRIES).map((entry) => {
    const pid = Number(entry.pid);
    const observedStart =
      Number.isInteger(pid) && pid > 0 ? (startTimeOf.get(pid) ?? null) : null;

    if (observedStart === null) {
      // Gone between the caller's snapshot and now. We cannot vouch for a pid
      // we cannot see. Not a condemnation — just an absence of protection.
      return { pid, protected: false, reason: "process_not_found", start_time: null };
    }
    // Identity fence against PID reuse: if the caller's start_time disagrees
    // with ours, the pid it classified is NOT the pid we are looking at.
    if (entry.start_time && canonicalStartTime(entry.start_time) !== observedStart) {
      return { pid, protected: false, reason: "identity_mismatch", start_time: observedStart };
    }
    const isProtected = protectedPids.has(pid);
    return {
      pid,
      protected: isProtected,
      reason: isProtected ? "live_agent_session_tree" : "not_registered",
      start_time: observedStart,
    };
  });

  return {
    schema: PROTECTION_SCHEMA,
    generation: PROTECTION_GENERATION,
    generated_at: nowIso(),
    lease_until: leaseUntil,
    protected_count: protectedPids.size,
    results,
  };
}

// ----- Orphans -----

export interface OrphanMessage {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
}

export function listOrphanedMessages(db: Database): OrphanMessage[] {
  return db.query<OrphanMessage, []>(
    `SELECT m.id, m.from_id, m.to_id, m.text, m.sent_at
     FROM messages m
     LEFT JOIN peers p ON p.id = m.to_id
     WHERE p.id IS NULL AND m.acked = 0
     ORDER BY m.id ASC`
  ).all();
}

// Diagnostic view of every row in messages (acked + unacked), enriched with
// sender/recipient names so a user can answer "did Claude's message actually
// reach Codex's mailbox?" without guessing. Used by `cli.ts messages`.
//
// Status semantics exposed to the CLI so operators can read them at a glance:
//   - acked=1                      → ACKED (delivered + acknowledged)
//   - acked=0, active lease        → LEASED (currently in a recipient's poll
//                                    buffer, lease still valid)
//   - acked=0, no/expired lease    → PENDING (ready to be picked up on next poll)
export interface InspectMessage {
  id: number;
  from_id: string;
  from_name: string | null;
  to_id: string;
  to_name: string | null;
  text: string;
  sent_at: string;
  acked: number;
  active_lease: number;   // 1 iff lease_token present AND lease_expires_at >= now()
  lease_expires_at: string | null;
}

export function listAllMessages(
  db: Database,
  opts: { limit?: number; order?: "DESC" | "ASC" } = {},
): { messages: InspectMessage[]; truncated: boolean; total_rows: number } {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 500;
  const order = opts.order === "ASC" ? "ASC" : "DESC";
  const nowStr = nowIso();
  const total = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM messages").get()?.c ?? 0;
  const rows = db.query<InspectMessage, [string]>(
    `SELECT m.id,
            m.from_id,
            pf.name AS from_name,
            m.to_id,
            pt.name AS to_name,
            m.text,
            m.sent_at,
            m.acked,
            CASE
              WHEN m.lease_token IS NOT NULL
                   AND m.lease_expires_at IS NOT NULL
                   AND m.lease_expires_at >= ?
              THEN 1 ELSE 0
            END AS active_lease,
            m.lease_expires_at
     FROM messages m
     LEFT JOIN peers pf ON pf.id = m.from_id
     LEFT JOIN peers pt ON pt.id = m.to_id
     ORDER BY m.id ${order}
     LIMIT ${limit}`
  ).all(nowStr);
  return { messages: rows, truncated: rows.length < total, total_rows: total };
}

// ----- HTTP -----

async function readJson<T>(req: Request): Promise<T> {
  return (await req.json()) as T;
}

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

// Per-user shared secret. Generated on first broker startup, written to
// ~/.agent-peers-secret with mode 0600 so only the owning OS user can read
// it. Every broker HTTP request must carry the secret in the
// X-Agent-Peers-Secret header; /health is the sole exception (liveness
// probe). This closes the "any local process can enumerate peers / inject
// messages" gap that mere localhost binding does not solve on shared or
// multi-user hosts.
export function ensureSharedSecret(path: string): string {
  // Crash-safe atomic provisioning (Codex round-E fix for "ensureSharedSecret
  // bricks startup after a crash between create and write"):
  //
  //   1. If path already exists, validate its perms (same checks as client),
  //      then check content length. If valid and length >= 32, reuse it.
  //      If the file exists but is short/empty (partial-write from a crashed
  //      earlier broker), refuse to act — throw with a clear recovery
  //      instruction. Auto-repair would race with concurrent brokers.
  //   2. Otherwise, write the secret to a PID-suffixed temp file, fsync it,
  //      chmod 0600, then attempt an atomic linkSync to the final path.
  //      link() succeeds only if the final path does NOT exist — two
  //      concurrent brokers racing here both tmpfile-write, only one wins
  //      the link, the loser reads the winner's content.
  //   3. After link, unlink the temp file. If link failed with EEXIST,
  //      someone else got there — delete our temp, read whatever they wrote.

  // Fast path: validated existing file
  if (existsSync(path)) {
    validateSecretFilePerms(path);
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
    throw new Error(
      `broker: shared-secret file at ${path} exists but is too short (${existing.length} chars) — likely a partial write from a crashed broker. ` +
      `To recover: stop all brokers, delete ${path}, and restart.`
    );
  }

  const secret = randomUUID() + randomUUID().replace(/-/g, "");
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;

  // Write secret to unique temp path, fsync, chmod 0600.
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, secret + "\n");
    try { fsyncSync(fd); } catch { /* best effort on fs that doesn't support fsync */ }
  } finally {
    closeSync(fd);
  }
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }

  // Try atomic link: succeeds only if `path` doesn't exist yet. This gives
  // us exclusive-create semantics without the torn-write window of O_EXCL.
  // On filesystems without hard-link support (FAT/exFAT/some network fs)
  // linkSync fails with ENOTSUP/EPERM — fall back to openSync('wx') on the
  // target path (Codex round-F fix). That's still race-safe because O_EXCL
  // is atomic; the only property we lose is crash-resilience against torn
  // writes. Rare + non-fatal.
  let linked = false;
  try {
    linkSync(tmp, path);
    linked = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/EEXIST/.test(msg)) {
      // Someone else linked first. Fall through to read their content.
    } else if (/ENOTSUP|EPERM|EOPNOTSUPP/i.test(msg)) {
      // Hard links not supported on this filesystem — fall back to an
      // atomic rename publish. The tmp file already has fully-written,
      // fsync'd content. renameSync atomically replaces the target (or
      // creates it if absent); the target is never visible in a partial
      // state, so a crash in the middle of this fallback cannot leave a
      // short/empty file at `path` (Codex round-G fix).
      //
      // Check existsSync(path) first to avoid clobbering a concurrent
      // broker's already-published secret. Race remains possible (exists
      // → rename is not atomic), but that race is exceedingly narrow on
      // the already-rare class of filesystems this fallback targets.
      if (!existsSync(path)) {
        try {
          renameSync(tmp, path);
          linked = true;
        } catch (e2: unknown) {
          const msg2 = e2 instanceof Error ? e2.message : String(e2);
          // If rename failed because path appeared in the race window,
          // treat as EEXIST and fall through to read.
          if (!/EEXIST|ENOTEMPTY/.test(msg2)) {
            try { unlinkSync(tmp); } catch { /* best effort */ }
            throw e2;
          }
        }
      }
      // else: someone else already published. Fall through to read their
      // content and unlink our tmp below.
    } else {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
  }
  try { unlinkSync(tmp); } catch { /* best effort */ }

  if (linked) {
    // Verify our write survived the link.
    const back = readFileSync(path, "utf8").trim();
    if (back === secret) return secret;
    // If something else wrote after us (shouldn't happen with link), fall through
  }

  // Read whoever won the link-race (or us, post-hoc).
  validateSecretFilePerms(path);
  const persisted = readFileSync(path, "utf8").trim();
  if (persisted.length < 32) {
    throw new Error(`broker: shared-secret file at ${path} is too short after link — unrecoverable`);
  }
  return persisted;
}

// One value per broker process. Lets clients (and the reaper, via
// PROTECTION_GENERATION) distinguish "the broker restarted underneath me" from
// "I was evicted for cause". Surfaced on /health, /ready, and (Phase 2)
// register/heartbeat responses.
export const BROKER_EPOCH = randomUUID();

export type BrokerOwner = "launchd" | "systemd" | "client";
/** launchd on macOS, systemd --user on Linux: the service manager that owns the port. */
export function isServiceOwner(owner: BrokerOwner): boolean {
  return owner === "launchd" || owner === "systemd";
}

// Sliding-window throttle for the unauthenticated protection endpoint: its
// answer can only spare processes, so a 429 is always safe for the caller
// (the reaper treats any non-200 as "broker unusable" and reaps nothing in
// broker-dependent classes). 4 requests per 10s is ~10× the scheduled
// reaper's real cadence.
const PROTECTION_THROTTLE_MAX = 4;
const PROTECTION_THROTTLE_WINDOW_MS = 10_000;
const protectionRequestTimes: number[] = [];

function protectionThrottled(now: number): boolean {
  while (protectionRequestTimes.length > 0 && now - protectionRequestTimes[0]! > PROTECTION_THROTTLE_WINDOW_MS) {
    protectionRequestTimes.shift();
  }
  if (protectionRequestTimes.length >= PROTECTION_THROTTLE_MAX) return true;
  protectionRequestTimes.push(now);
  return false;
}

/** Short non-secret identity for the DB this broker serves — lets a client
 *  detect "a broker answered, but it is not serving the DB I expect". */
function dbIdentityHash(dbPath: string): string {
  return Bun.hash(resolve(dbPath)).toString(16).slice(0, 12);
}

/** Federation is off unless AGENT_PEERS_FEDERATION=1 and its config files are
 *  valid. A missing or broken config logs and leaves local service untouched.
 *  With federation off, relayed mail already stored keeps its sender names. */
function startFederation(db: Database): { service: FederationService; config: FederationConfig } | null {
  let config: FederationConfig | null = null;
  try {
    config = loadFederationConfig();
  } catch (e) {
    console.error(`[broker] federation config unusable, federation stays off: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!config) {
    const stored = storedFederationSenders(db);
    if (stored && !addressingDeps.senderForMessage) configureAddressing({ ...addressingDeps, senderForMessage: stored });
    return null;
  }
  let service: FederationService;
  try {
    service = new FederationService({
      db, config,
      listLocalPeers: (r) => listDirectoryPeers(db, r),
      listLocalChats: (peer, r) => listChatsFor(db, peer, r),
      sendLocal: (r) => sendMessage(db, r),
      snapshotSender: (r) => snapshotSender(db, r),
      deliverLocal: (m) => deliverRelayed(db, m),
      deliverNotice: (n) => deliverNotice(db, n),
    });
  } catch (e) {
    console.error(`[broker] federation failed to start, federation stays off: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  configureAddressing({
    ...addressingDeps,
    isLocalHost: service.isLocalHost,
    remote: service.enqueue,
    remoteRoute: service.remoteRoute,
    senderForMessage: service.senderForMessage,
  });
  service.start();
  console.error(`[broker] federation on as ${config.host}; peers: ${Object.keys(config.hosts).join(", ")}`);
  return { service, config };
}

function storedFederationSenders(db: Database): AddressingDeps["senderForMessage"] {
  const table = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'federation_senders'").get();
  if (!table) return undefined;
  const q = db.query<{ snapshot: string }, [number]>("SELECT snapshot FROM federation_senders WHERE message_id = ?");
  return (id) => {
    const row = q.get(id);
    if (!row) return null;
    try { return JSON.parse(row.snapshot); } catch { return null; }
  };
}

export function startBroker(
  port: number,
  dbPath: string,
  secretPath = DEFAULT_SECRET_PATH,
  owner: BrokerOwner = "client",
) {
  const db = initDb(dbPath);
  const sharedSecret = ensureSharedSecret(secretPath);
  const federation = startFederation(db);

  // Suspend-aware GC. When the machine sleeps, every client's heartbeat timer
  // freezes along with ours; on wake, wall-clock has jumped and every row
  // looks stale at once. A tick that observes far more elapsed time than its
  // own interval is the post-wake tick — deleting on it would evict the whole
  // registry (77 → 9 peers, 2026-07-14). Grant exactly one grace sweep so the
  // clients' 15s heartbeats can land first. A monotonic clock would NOT fix
  // this: the elapsed gap is real; what's false is the inference of death.
  let lastGcTick = Date.now();
  const gcTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastGcTick;
    lastGcTick = now;
    if (shouldSkipGcSweep(elapsed)) {
      console.error(`[broker] suspend detected (${Math.round(elapsed / 1000)}s since last GC tick, interval ${GC_INTERVAL_MS / 1000}s); granting one grace sweep`);
    } else {
      try { gcStalePeers(db); } catch (e) { console.error("[broker] GC error:", e); }
      try { gcOldMessages(db); } catch (e) { console.error("[broker] message GC error:", e); }
    }
    // Re-enforce 0600 on WAL/SHM sidecars — SQLite may recreate them on
    // checkpoint, and they'd come back with default umask-controlled perms.
    // We also set umask(0o077) at startup so freshly created sidecars start
    // at 0600, but the chmod sweep is a belt-and-suspenders backstop.
    chmodIfExists(dbPath + "-wal", 0o600);
    chmodIfExists(dbPath + "-shm", 0o600);
    // Fail-closed verification on every tick (Codex round-I): if any sidecar
    // has drifted off 0600 or off the correct owner, crash the broker with
    // a clear error rather than keep serving with readable session tokens.
    try {
      enforceDbFilePerms(dbPath, [dbPath, dbPath + "-wal", dbPath + "-shm"]);
    } catch (e) {
      console.error("[broker] FATAL: DB file permissions drifted during runtime:", e);
      process.exit(1);
    }
  }, GC_INTERVAL_MS);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (req.method === "GET" && url.pathname === "/health") {
          // Unauthenticated liveness only. epoch/owner are non-secret and let
          // the eviction path and diagnostics identify the responder.
          return json({ ok: true, pid: process.pid, epoch: BROKER_EPOCH, owner });
        }
        if (req.method === "GET" && url.pathname === "/ready") {
          // Authenticated readiness: a client that can read the shared secret
          // can verify it is talking to a compatible broker serving the
          // expected DB, not just "something answering on the port".
          const presented = req.headers.get(SECRET_HEADER);
          if (presented !== sharedSecret) {
            return json({ error: "missing or invalid " + SECRET_HEADER }, { status: 401 });
          }
          return json({
            ok: true,
            pid: process.pid,
            epoch: BROKER_EPOCH,
            owner,
            protocol: 1,
            db_id: dbIdentityHash(dbPath),
            // v3: features are advertised, never signalled by bumping
            // `protocol`, which old clients compare for equality.
            capabilities: federation ? [...BROKER_CAPABILITIES, "federation"] : BROKER_CAPABILITIES,
          });
        }
        // Federation routes carry their own secret and host check, and use
        // GET for health and directory, so they run before the POST rule and
        // the local secret gate. Nothing else is reachable with that secret.
        if (federation && url.pathname.startsWith("/federation/")) {
          const handled = await federation.service.handle(req);
          if (handled) return handled;
        }
        if (req.method !== "POST") return json({ error: "method not allowed" }, { status: 405 });

        // Deliberately OUTSIDE the shared-secret gate. The reaper runs as a
        // separate system (mac-os-system-expert) and requiring the secret would
        // widen that secret's trust boundary to another codebase for no gain:
        // this endpoint only reveals which pids belong to live agent sessions —
        // information any local process can already derive from `ps` — and its
        // answer can only SPARE a process, never condemn one. Registering as a
        // peer (the only way to get into the protected set) still requires the
        // secret, so this cannot be used to launder protection onto a hostile
        // process.
        if (url.pathname === "/v1/protection/check") {
          if (protectionThrottled(Date.now())) {
            // Safe by contract: the caller treats any non-200 as "broker
            // unusable" and spares everything in broker-dependent classes.
            return json({ error: "throttled" }, { status: 429 });
          }
          const body = await readJson<{ entries?: ProtectionQueryEntry[] } | ProtectionQueryEntry[]>(req);
          const entries = Array.isArray(body) ? body : (body?.entries ?? []);
          return json(checkProtection(db, entries));
        }

        // Shared-secret gate for every non-/health request.
        const presented = req.headers.get(SECRET_HEADER);
        if (presented !== sharedSecret) {
          return json({ error: "missing or invalid " + SECRET_HEADER }, { status: 401 });
        }

        switch (url.pathname) {
          // register/heartbeat carry the broker epoch so a client seeing
          // `known: false` can distinguish "broker restarted under me — just
          // re-register" from "I was evicted for cause" (log-only for now).
          case "/register":      return json({ ...registerPeer(db, await readJson(req)), epoch: BROKER_EPOCH });
          case "/heartbeat":     { const b = await readJson<{ id: string; session_token: string }>(req); return json({ ok: true, known: heartbeatPeer(db, b.id, b.session_token), epoch: BROKER_EPOCH }); }
          case "/unregister":    { const b = await readJson<{ id: string; session_token: string }>(req); unregisterPeer(db, b.id, b.session_token); return json({ ok: true }); }
          case "/set-summary":   { const b = await readJson<{ id: string; session_token: string; summary: string }>(req); setPeerSummary(db, b.id, b.session_token, b.summary); return json({ ok: true }); }
          case "/list-peers": {
            const b = await readJson<ListPeersRequest>(req);
            const local = listPeers(db, b);
            // Machine scope also lists the other machines, live (about 1.5 s
            // per unreachable host). Still a bare array for old clients; the
            // unreachable hosts travel in a header.
            if (!federation || b.scope !== "machine" || b.local_only) return json(local);
            const dir = await federation.service.directory();
            const remote = dir.peers.filter((p) => p.host !== federation.config.host && (!b.peer_type || p.peer_type === b.peer_type));
            return json([...local, ...remote], dir.unreachable_hosts.length
              ? { headers: { [UNREACHABLE_HOSTS_HEADER]: dir.unreachable_hosts.join(",") } } : undefined);
          }
          // An unknown bare name may live on another machine. The service
          // tries the local send first and asks the other brokers only on
          // unknown_peer, outside any transaction.
          case "/send-message":  { const b = await readJson<SendMessageRequest>(req); return json(federation ? await federation.service.send(b) : sendMessage(db, b)); }
          case "/poll-messages": {
            const b = await readJson<{ id: string; session_token: string; chat?: string }>(req);
            if (typeof b.chat !== "string") return json({ messages: pollMessages(db, b.id, b.session_token) });
            return json(pollMessagesScoped(db, b.id, b.session_token, undefined, b.chat));
          }
          case "/list-chats":    return json(await listChatsRouted(db, await readJson(req), federation));
          case "/chat-inbox":    return json({ entries: chatInbox(db) });
          case "/peer-inbox":    { const b = await readJson<{ peer_type?: string; peer_ids?: unknown }>(req); return json({ entries: peerInbox(db, String(b.peer_type ?? ""), b.peer_ids) }); }
          case "/ack-messages":  return json(ackMessages(db, await readJson(req)));
          case "/rename-peer":   return json(renamePeer(db, await readJson(req)));
          // No /admin/rename-peer over HTTP — arbitrary local processes could
          // hijack any peer's name. cli.ts 'rename' reads the target peer's
          // session_token from SQLite directly (file perms = trust boundary)
          // and then calls the normal session-authenticated /rename-peer.
          // No /orphaned-messages over HTTP — exposing bodies over localhost
          // leaks peer traffic. cli.ts 'orphaned-messages' opens SQLite readonly.
          // No /all-messages endpoint — same reasoning.
          default: return json({ error: "not found" }, { status: 404 });
        }
      } catch (e) {
        console.error("[broker] request error:", e);
        return json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    },
  });

  const cleanup = async () => {
    clearInterval(gcTimer);
    server.stop(true);
    try { await federation?.service.stop(); } catch { /* exiting anyway */ }
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  // Auto-spawned brokers inherit the spawning session's controlling TTY
  // (Bun.spawn has no detached/setsid). Closing that terminal tab delivers
  // SIGHUP, whose default action killed the broker for the whole machine
  // (observed 2026-07-06). The broker has no terminal to hang up from —
  // ignore it and stay up for the sessions that outlive the spawner.
  process.on("SIGHUP", () => {});

  console.error(`[broker] listening on http://127.0.0.1:${port}, db=${dbPath}, pid=${process.pid}, owner=${owner}, epoch=${BROKER_EPOCH}`);
  return { server, db, gcTimer, federation: federation?.service ?? null };
}

function isAddrInUse(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""}` : String(e);
  return /EADDRINUSE|address already in use/i.test(msg);
}

/** Production entry: bind with ownership arbitration.
 *
 *  launchd owner: launchd is the sole legitimate owner of the port. If a rogue
 *  broker (a legacy client-spawned one) holds it, identify it via /health,
 *  SIGTERM it, wait for the port to free, and retry — up to 3 attempts.
 *
 *  client owner (legacy spawn path / manual `bun broker.ts`): EADDRINUSE means
 *  somebody else already serves this machine. Yield with exit 0 — never
 *  crash-loop, never fight. */
async function startBrokerMain(owner: BrokerOwner): Promise<void> {
  // v3: Hermes chat addresses resolve against each profile's state.db, read
  // only. Installed here, not in startBroker, so tests stay hermetic.
  if (!addressingDeps.chats) configureAddressing({ ...addressingDeps, chats: new HermesChatDirectory() });
  const port = DEFAULT_PORT;
  const dbPath = process.env.AGENT_PEERS_DB || DEFAULT_DB_PATH;
  const secretPath = process.env.AGENT_PEERS_SECRET_PATH || DEFAULT_SECRET_PATH;
  // The eviction target comes from lsof — the pid that ACTUALLY holds the
  // listening socket — never from the squatter's own /health response, which
  // is unauthenticated and could name an arbitrary same-user victim
  // (2026-08-10 review high #4). We still SIGTERM a given pid at most once:
  // if the port is busy again afterwards, someone new owns it.
  const alreadySignaled = new Set<number>();
  const portListenerPid = (): number | null => {
    const candidate = (raw: string | undefined): number | null => {
      const pid = parseInt(raw ?? "", 10);
      return Number.isInteger(pid) && pid > 1 && pid !== process.pid ? pid : null;
    };
    try {
      const proc = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
      const found = candidate(proc.stdout.toString().trim().split("\n")[0]);
      if (found !== null) return found;
    } catch { /* lsof missing (Arch): fall through to ss */ }
    try {
      // Linux without lsof: `ss -Hltnp 'sport = :PORT'` prints users:(("bun",pid=123,fd=9)).
      const proc = Bun.spawnSync(["ss", "-Hltnp", `sport = :${port}`]);
      return candidate(/pid=(\d+)/.exec(proc.stdout.toString())?.[1]);
    } catch {
      return null;
    }
  };
  // 4 bind attempts for 3 evictions: the final eviction deserves a final
  // bind attempt, otherwise a successful eviction on the last loop is wasted.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      startBroker(port, dbPath, secretPath, owner);
      return;
    } catch (e) {
      if (!isAddrInUse(e)) throw e;
      if (!isServiceOwner(owner)) {
        console.error(`[broker] port ${port} already served and owner=${owner}; yielding to the incumbent (exit 0)`);
        process.exit(0);
      }
      if (attempt === 4) break;
      // service owner: evict whoever actually holds the listening socket.
      const squatterPid = portListenerPid();
      if (squatterPid === null || alreadySignaled.has(squatterPid)) {
        console.error(`[broker] attempt ${attempt}: port ${port} busy, no NEW evictable listener via lsof; retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      alreadySignaled.add(squatterPid);
      console.error(`[broker] owner=${owner} evicting rogue broker pid=${squatterPid} from port ${port}`);
      try { process.kill(squatterPid, "SIGTERM"); } catch { /* already gone */ }
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        try { process.kill(squatterPid, 0); } catch { break; } // ESRCH → dead
      }
    }
  }
  console.error(`[broker] FATAL: could not acquire port ${port} after 4 attempts`);
  process.exit(1);
}

// Re-exports for consumers.
export { NAME_REGEX, NAME_MAX_LEN, isValidName };

if (import.meta.main) {
  const owner: BrokerOwner = process.argv.includes("--owner=launchd") ? "launchd"
    : process.argv.includes("--owner=systemd") ? "systemd" : "client";
  await startBrokerMain(owner);
}
