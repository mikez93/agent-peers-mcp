// tests/phase2-delivery-gc.test.ts
//
// Phase 2 (delivery + GC correctness) regression coverage:
//   - listPeers no longer deletes stale rows (sleep/wake mass-eviction fix)
//   - shouldSkipGcSweep grace predicate (clock-jump coverage)
//   - gcOldMessages retention
//   - typed ack results: acked / expired / unknown / wrong_session
//   - message_uid: minted on send, backfilled by migration, unique
//   - async lock serializes concurrent critical sections (piggyback mutex)

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  startBroker, registerPeer, listPeers, sendMessage, pollMessages, ackMessages,
  gcOldMessages, shouldSkipGcSweep, GC_INTERVAL_MS, initDb,
} from "../broker.ts";
import { createAsyncLock } from "../shared/async-lock.ts";
import { existsSync, unlinkSync } from "node:fs";

const TEST_DB = `/tmp/agent-peers-phase2-${Date.now()}.db`;
const TEST_SECRET = `/tmp/agent-peers-phase2-secret-${Date.now()}`;
const TEST_PORT = 7951;
let handle: ReturnType<typeof startBroker>;

beforeAll(() => {
  handle = startBroker(TEST_PORT, TEST_DB, TEST_SECRET);
});
afterAll(() => {
  clearInterval(handle.gcTimer);
  handle.server.stop(true);
  handle.db.close();
  for (const p of [TEST_DB, TEST_SECRET]) if (existsSync(p)) unlinkSync(p);
});

function enroll(name?: string) {
  return registerPeer(handle.db, {
    peer_type: "claude", name, pid: process.pid, cwd: "/tmp", git_root: null, tty: null, summary: "",
  });
}

test("listPeers hides stale rows but does NOT delete them", () => {
  const p = enroll();
  handle.db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), p.id);

  const visible = listPeers(handle.db, { scope: "machine", cwd: "/tmp", git_root: null, exclude_id: "none" });
  expect(visible.some((x) => x.id === p.id)).toBe(false);

  // The row must still exist — deletion is the suspend-aware timer's job only.
  const row = handle.db.query("SELECT id FROM peers WHERE id = ?").get(p.id);
  expect(row).not.toBeNull();
});

test("shouldSkipGcSweep: grants grace exactly when the tick slept through its interval", () => {
  expect(shouldSkipGcSweep(GC_INTERVAL_MS)).toBe(false);
  expect(shouldSkipGcSweep(GC_INTERVAL_MS * 2)).toBe(false);
  expect(shouldSkipGcSweep(GC_INTERVAL_MS * 3 + 1)).toBe(true);
  expect(shouldSkipGcSweep(8 * 60 * 60 * 1000)).toBe(true); // overnight sleep
});

test("gcOldMessages prunes rows past retention, keeps recent ones", () => {
  const a = enroll();
  const b = enroll();
  const send = sendMessage(handle.db, {
    from_id: a.id, session_token: a.session_token, to_id_or_name: b.id, text: "recent",
  });
  expect(send.ok).toBe(true);
  // Fabricate an ancient acked row and an ancient unacked row.
  handle.db.query(
    "INSERT INTO messages (from_id, to_id, text, sent_at, acked, message_uid) VALUES (?, ?, 'old-acked', ?, 1, ?)"
  ).run(a.id, b.id, new Date(Date.now() - 8 * 24 * 3600_000).toISOString(), crypto.randomUUID());
  handle.db.query(
    "INSERT INTO messages (from_id, to_id, text, sent_at, acked, message_uid) VALUES (?, ?, 'old-unacked', ?, 0, ?)"
  ).run(a.id, b.id, new Date(Date.now() - 9 * 24 * 3600_000).toISOString(), crypto.randomUUID());

  const pruned = gcOldMessages(handle.db);
  expect(pruned).toBe(2);
  const texts = handle.db.query<{ text: string }, []>("SELECT text FROM messages").all().map((r) => r.text);
  expect(texts).toContain("recent");
  expect(texts).not.toContain("old-acked");
  expect(texts).not.toContain("old-unacked");
});

test("ackMessages reports typed per-token outcomes", () => {
  const a = enroll();
  const b = enroll();
  sendMessage(handle.db, { from_id: a.id, session_token: a.session_token, to_id_or_name: b.id, text: "m1" });
  const leased = pollMessages(handle.db, b.id, b.session_token);
  expect(leased.length).toBe(1);
  const goodToken = leased[0]!.lease_token;

  // Expire the lease behind the client's back.
  handle.db.query("UPDATE messages SET lease_expires_at = ? WHERE lease_token = ?")
    .run(new Date(Date.now() - 1000).toISOString(), goodToken);

  const res = ackMessages(handle.db, {
    id: b.id, session_token: b.session_token,
    lease_tokens: [goodToken, "no-such-token"],
  });
  expect(res.ok).toBe(true);
  expect(res.acked).toBe(0);
  expect(res.stale).toBe(1);
  const byToken = new Map(res.results!.map((r) => [r.token, r.status]));
  expect(byToken.get(goodToken)).toBe("expired");
  expect(byToken.get("no-such-token")).toBe("acked"); // untraceable token: cleared-or-never-existed

  // wrong_session: someone else's live lease.
  sendMessage(handle.db, { from_id: a.id, session_token: a.session_token, to_id_or_name: b.id, text: "m2" });
  const leased2 = pollMessages(handle.db, b.id, b.session_token);
  const stolen = leased2.find((m) => m.text === "m2")!.lease_token;
  const thief = enroll();
  const res2 = ackMessages(handle.db, {
    id: thief.id, session_token: thief.session_token, lease_tokens: [stolen],
  });
  expect(res2.acked).toBe(0);
  expect(res2.results!.find((r) => r.token === stolen)!.status).toBe("wrong_session");
});

test("message_uid: minted on send, unique, and backfilled by migration", () => {
  const a = enroll();
  const b = enroll();
  sendMessage(handle.db, { from_id: a.id, session_token: a.session_token, to_id_or_name: b.id, text: "uid-check" });
  const row = handle.db.query<{ message_uid: string | null }, []>(
    "SELECT message_uid FROM messages WHERE text = 'uid-check'"
  ).get();
  expect(row?.message_uid).toBeTruthy();
  expect(row!.message_uid!.length).toBeGreaterThanOrEqual(32);

  // Backfill: a legacy DB without the column gets it added + populated.
  const legacyPath = `/tmp/agent-peers-uid-legacy-${Date.now()}.db`;
  const legacy = new Database(legacyPath);
  legacy.exec(`
    CREATE TABLE peers (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, peer_type TEXT NOT NULL,
      pid INTEGER, cwd TEXT, git_root TEXT, tty TEXT, summary TEXT, session_token TEXT NOT NULL,
      registered_at TEXT NOT NULL, last_seen TEXT NOT NULL, durable INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL,
      to_id TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT NOT NULL,
      acked INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_expires_at TEXT);
    INSERT INTO messages (from_id, to_id, text, sent_at) VALUES ('x', 'y', 'legacy-row', '2026-08-01T00:00:00Z');
  `);
  legacy.close();
  const migrated = initDb(legacyPath);
  const legacyRow = migrated.query<{ message_uid: string | null }, []>(
    "SELECT message_uid FROM messages WHERE text = 'legacy-row'"
  ).get();
  expect(legacyRow?.message_uid).toBeTruthy();
  migrated.close();
  unlinkSync(legacyPath);
});

test("async lock: concurrent critical sections never interleave (piggyback mutex property)", async () => {
  const withLock = createAsyncLock();
  const events: string[] = [];
  const critical = (tag: string, delayMs: number) => withLock(async () => {
    events.push(`${tag}:enter`);
    await new Promise((r) => setTimeout(r, delayMs));
    events.push(`${tag}:exit`);
    return tag;
  });
  // Fire both "in parallel" — the exact shape of the bd-21r.3 batched call.
  const [r1, r2] = await Promise.all([critical("a", 30), critical("b", 5)]);
  expect(r1).toBe("a");
  expect(r2).toBe("b");
  expect(events).toEqual(["a:enter", "a:exit", "b:enter", "b:exit"]);
});
