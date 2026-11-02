// bd-b2in.17, Marco's AP10809 correction #4: adding the openclaw peer type
// rebuilds the peers table for its CHECK constraint. The rebuild must be
// lossless (peer IDs, tokens, v3 columns, durable retention) and must leave
// inbox, outbox, routes, receipts and chat partitions exactly as they were.
// The "previous release" DB below is built the way that release's migrations
// leave it: the droid rebuild (literal column list, RENAME TO peers), then the
// v3 ALTER TABLE ADD COLUMNs and chat_routes, then the federation tables.

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAddressing, initDb, peerInbox, pollMessages, pollMessagesScoped, registerPeer } from "../broker.ts";
import type { ChatDirectory } from "../shared/chat-directory.ts";

const ADS = "20261028_100000_aaaaaa";
const chats: ChatDirectory = {
  resolve(_peer, query) {
    return query.trim() === ADS || query.trim().toLowerCase() === "instagram ads"
      ? { ok: true, chat_key: ADS, title: "Instagram ads" } : { ok: false, error: "no such chat", candidates: [] };
  },
  list() { return [{ chat_key: ADS, title: "Instagram ads", last_active: "2026-10-29T10:00:00Z" }]; },
};

let TEST_DB = "";
afterEach(() => {
  configureAddressing({});
  for (const p of [TEST_DB, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (p && existsSync(p)) unlinkSync(p);
});

const TABLES = ["peers", "messages", "chat_routes", "federation_outbox", "federation_receipts", "federation_routes", "federation_senders"];

function snapshot(db: Database): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = db.query(`SELECT * FROM ${t} ORDER BY rowid`).all();
  return out;
}

function buildPreviousReleaseDb(path: string): void {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
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
    ALTER TABLE peers_droid_new RENAME TO peers;
    CREATE INDEX IF NOT EXISTS idx_peers_last_seen ON peers(last_seen);
    CREATE INDEX IF NOT EXISTS idx_peers_name ON peers(name);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
      text TEXT NOT NULL, sent_at TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT, lease_expires_at TEXT, message_uid TEXT
    );
    CREATE INDEX idx_messages_to_acked ON messages(to_id, acked);
    CREATE UNIQUE INDEX idx_messages_uid ON messages(message_uid);
    ALTER TABLE peers ADD COLUMN persona TEXT;
    ALTER TABLE peers ADD COLUMN capabilities TEXT;
    ALTER TABLE peers ADD COLUMN mailbox_owner TEXT;
    ALTER TABLE messages ADD COLUMN to_chat TEXT;
    ALTER TABLE messages ADD COLUMN from_chat TEXT;
    CREATE TABLE chat_routes (id TEXT PRIMARY KEY, peer_name TEXT NOT NULL, chat_key TEXT NOT NULL,
      title TEXT, created_at TEXT NOT NULL, last_used TEXT NOT NULL);
    CREATE INDEX idx_messages_to_chat ON messages(to_id, to_chat, acked);
    CREATE INDEX idx_chat_routes_owner ON chat_routes(peer_name, chat_key);
    CREATE TABLE federation_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_uid TEXT NOT NULL UNIQUE,
      host TEXT NOT NULL, envelope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER);
    CREATE TABLE federation_receipts (message_uid TEXT PRIMARY KEY, origin_host TEXT NOT NULL,
      digest TEXT NOT NULL, response TEXT NOT NULL);
    CREATE TABLE federation_routes (id TEXT NOT NULL, host TEXT NOT NULL, PRIMARY KEY(id, host));
    CREATE TABLE federation_senders (message_id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL);
  `);
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
  const peer = db.query(`INSERT INTO peers (id, name, peer_type, pid, cwd, git_root, tty, summary, session_token,
    registered_at, started_at, last_seen, durable, host, persona, capabilities, mailbox_owner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  peer.run("11111111-1111-4111-8111-111111111111", "vector-claude", "claude", process.pid, "/w/a", "/w/a", "/dev/ttys001", "busy",
    "tok-claude", old, old, now, 0, "studio", "vector", null, null);
  peer.run("22222222-2222-4222-8222-222222222222", "valentina-hermes", "hermes", 4242, "/w/h", null, null, "",
    "tok-hermes", old, old, old, 1, "studio", "valentina", "chat-mail", null);
  peer.run("33333333-3333-4333-8333-333333333333", "member-hermes-x1", "hermes", 4343, "/w/h", null, null, "",
    "tok-member", now, now, now, 0, "studio", "valentina", "chat-mail", "valentina-hermes");
  peer.run("44444444-4444-4444-8444-444444444444", "marco-droid", "droid", 4444, "/w/ops", null, null, "ops",
    "tok-droid", old, old, now, 1, "hetzner-box-01", "marco", null, null);
  peer.run("55555555-5555-4555-8555-555555555555", "kepler-codex", "codex", 4545, "/w/k", "/w/k", null, "",
    "tok-codex", now, now, now, 1, null, null, null, null);
  const msg = db.query(`INSERT INTO messages (from_id, to_id, text, sent_at, acked, lease_token, lease_expires_at, message_uid, to_chat, from_chat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  msg.run("44444444-4444-4444-8444-444444444444", "11111111-1111-4111-8111-111111111111", "unread for vector", now, 0, null, null, "uid-1", null, null);
  msg.run("44444444-4444-4444-8444-444444444444", "11111111-1111-4111-8111-111111111111", "leased for vector", now, 0, "lease-x",
    new Date(Date.now() + 60_000).toISOString(), "uid-2", null, null);
  msg.run("11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444", "acked for marco", old, 1, "lease-old", old, "uid-3", null, null);
  msg.run("44444444-4444-4444-8444-444444444444", "22222222-2222-4222-8222-222222222222", "chat mail for ads", now, 0, null, null, "uid-4",
    "20261028_100000_aaaaaa", null);
  msg.run("44444444-4444-4444-8444-444444444444", "22222222-2222-4222-8222-222222222222", "general hermes mail", now, 0, null, null, "uid-5", null, null);
  db.query("INSERT INTO chat_routes VALUES (?, ?, ?, ?, ?, ?)").run("route-1", "valentina-hermes", "20261028_100000_aaaaaa", "Instagram ads", old, now);
  db.query(`INSERT INTO federation_outbox (message_uid, host, envelope, status, attempts, next_attempt, last_error, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("uid-out-1", "macbook", "{\"x\":1}", "pending", 3, 99, "federation HTTP 503", 1, null);
  db.query("INSERT INTO federation_receipts VALUES (?, ?, ?, ?)").run("uid-in-1", "macbook", "digest", "{\"ok\":true}");
  db.query("INSERT INTO federation_routes VALUES (?, ?)").run("66666666-6666-4666-8666-666666666666", "macbook");
  db.query("INSERT INTO federation_senders VALUES (?, ?)").run(1, "{\"from_name\":\"x@macbook\"}");
  db.close();
}

test("openclaw migration is lossless across every table and keeps old brokers' probes satisfied", () => {
  TEST_DB = join(tmpdir(), `ap-openclaw-migration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  buildPreviousReleaseDb(TEST_DB);
  const pre = new Database(TEST_DB);
  const before = snapshot(pre);
  const columnsBefore = pre.query<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }, []>(
    "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('peers')").all();
  pre.close();

  const db = initDb(TEST_DB);
  try {
    expect(snapshot(db)).toEqual(before);
    expect(db.query("SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('peers')").all()).toEqual(columnsBefore);
    const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'peers'").get()!.sql;
    // Older brokers probe for these literals and skip their own rebuilds.
    for (const t of ["'claude'", "'codex'", "'hermes'", "'droid'", "'openclaw'"]) expect(sql).toContain(t);
    const indexes = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'peers' AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name);
    expect(indexes).toEqual(["idx_peers_last_seen", "idx_peers_name"]);

    // Same IDs and tokens still read their own mail, including the chat partition.
    const general = pollMessages(db, "11111111-1111-4111-8111-111111111111", "tok-claude").map((m) => m.text);
    expect(general).toContain("unread for vector");
    configureAddressing({ chats });
    const chat = pollMessagesScoped(db, "22222222-2222-4222-8222-222222222222", "tok-hermes", undefined, "Instagram ads");
    expect(chat.messages.map((m) => m.text)).toEqual(["chat mail for ads"]);

    // The new type registers; anything else still violates the constraint.
    const oc = registerPeer(db, { peer_type: "openclaw", name: "openclaw-hetzner", pid: process.pid, cwd: "/w/oc",
      git_root: null, tty: null, summary: "", durable: true });
    expect(db.query<{ peer_type: string; durable: number }, [string]>("SELECT peer_type, durable FROM peers WHERE id = ?").get(oc.id))
      .toEqual({ peer_type: "openclaw", durable: 1 });
    expect(() => db.query("INSERT INTO peers (id, name, peer_type, session_token, registered_at, last_seen) VALUES ('x', 'x', 'bogus', 't', 'n', 'n')").run())
      .toThrow(/CHECK constraint failed/);
  } finally {
    db.close();
  }

  // Idempotent: a second open changes nothing.
  const again = initDb(TEST_DB);
  try {
    const sqlA = again.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'peers'").get()!.sql;
    expect(sqlA.match(/'openclaw'/g)?.length).toBe(1);
  } finally {
    again.close();
  }
});

test("a fresh install accepts openclaw and the migration is a no-op there", () => {
  TEST_DB = join(tmpdir(), `ap-openclaw-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = initDb(TEST_DB);
  try {
    const sql = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name = 'peers'").get()!.sql;
    expect(sql.match(/'openclaw'/g)?.length).toBe(1);
    const a = registerPeer(db, { peer_type: "openclaw", name: "oc-a", pid: process.pid, cwd: "/", git_root: null, tty: null, summary: "", durable: true });
    const b = registerPeer(db, { peer_type: "claude", name: "cc-b", pid: process.pid, cwd: "/", git_root: null, tty: null, summary: "" });
    db.query("INSERT INTO messages (from_id, to_id, text, sent_at, message_uid) VALUES (?, ?, 'x', ?, 'u1'), (?, ?, 'y', ?, 'u2')")
      .run(b.id, a.id, new Date().toISOString(), b.id, b.id, new Date().toISOString());
    // /peer-inbox lists only openclaw peers' unacked mail.
    expect(peerInbox(db, "openclaw")).toEqual([{ peer_id: a.id, peer_name: "oc-a", unread_ids: [1] }]);
    expect(peerInbox(db, "claude")).toEqual([]);
  } finally {
    db.close();
  }
});
