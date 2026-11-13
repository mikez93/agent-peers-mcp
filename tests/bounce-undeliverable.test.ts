// Undeliverable-mail bounce (Mike, 2026-11-13).
//
// The failure this guards against: A sends to B, B's row is evicted before B
// reads, and A hears nothing — the send returned ok and the message sits in
// the orphan pool forever. The broker must (1) wait a grace period so a
// re-registering B can reclaim its mail, then (2) ack the original as settled
// and (3) queue a notice to A, if A is still here.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker, registerPeer, sendMessage, gcStalePeers, bounceOrphanedMail,
  listOrphanedMessages, BOUNCE_GRACE_MS, BOUNCE_PREFIX, STALE_THRESHOLD_MS,
} from "../broker.ts";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-bounce-" + Date.now() + ".db";
const TEST_SECRET = "/tmp/agent-peers-bounce-secret-" + Date.now();
const TEST_PORT = 7961;
let handle: ReturnType<typeof startBroker>;

beforeAll(() => { handle = startBroker(TEST_PORT, TEST_DB, TEST_SECRET); });
afterAll(() => {
  handle.server.stop(true);
  clearInterval(handle.gcTimer);
  handle.db.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm", TEST_SECRET]) {
    if (existsSync(f)) unlinkSync(f);
  }
});

function enroll(name: string) {
  return registerPeer(handle.db, { name, peer_type: "claude", cwd: "/tmp" } as any);
}
function evict(id: string) {
  const old = new Date(Date.now() - STALE_THRESHOLD_MS - 5_000).toISOString();
  handle.db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run(old, id);
  gcStalePeers(handle.db);
  expect(handle.db.query("SELECT id FROM peers WHERE id = ?").get(id)).toBeNull();
}
// The sender-liveness check is relative to the sweep's `now`; a test that moves
// the clock forward must move the sender's heartbeat with it, as a live client would.
function heartbeatAt(id: string, at: number) {
  handle.db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run(new Date(at).toISOString(), id);
}
function mailTo(id: string) {
  return handle.db.query<{ id: number; from_id: string; text: string; acked: number }, [string]>(
    "SELECT id, from_id, text, acked FROM messages WHERE to_id = ? ORDER BY id"
  ).all(id);
}

test("unread mail to an evicted peer is bounced to a live sender after the grace period, once", () => {
  const a = enroll("sender-a");
  const b = enroll("recipient-b");
  const sent = sendMessage(handle.db, { from_id: a.id, session_token: a.session_token, to_id_or_name: b.id, text: "hello b, please read" });
  expect(sent.ok).toBe(true);
  const msgId = (sent as any).message_id as number;

  evict(b.id);
  expect(listOrphanedMessages(handle.db).map(m => m.id)).toContain(msgId);

  // Inside the grace period: nothing happens, so a re-registering B can still reclaim it.
  expect(bounceOrphanedMail(handle.db, Date.now())).toBe(0);
  expect(mailTo(a.id)).toHaveLength(0);

  // After the grace period: original acked, one bounce queued to A.
  const later = Date.now() + BOUNCE_GRACE_MS + 1_000;
  heartbeatAt(a.id, later);
  expect(bounceOrphanedMail(handle.db, later)).toBe(1);
  const original = handle.db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id = ?").get(msgId)!;
  expect(original.acked).toBe(1);
  expect(listOrphanedMessages(handle.db).map(m => m.id)).not.toContain(msgId);
  const bounces = mailTo(a.id);
  expect(bounces).toHaveLength(1);
  expect(bounces[0]!.text.startsWith(BOUNCE_PREFIX)).toBe(true);
  expect(bounces[0]!.text).toContain(`#${msgId}`);
  expect(bounces[0]!.text).toContain(b.id);
  expect(bounces[0]!.text).toContain("hello b, please read");
  expect(bounces[0]!.from_id).toBe(b.id);
  expect(bounces[0]!.acked).toBe(0);

  // Idempotent: a second sweep bounces nothing and never bounces a bounce.
  expect(bounceOrphanedMail(handle.db, later + 60_000)).toBe(0);
  expect(mailTo(a.id)).toHaveLength(1);
});

test("a bounce itself is never bounced, even when its recipient is gone", () => {
  const a = enroll("sender-a2");
  const b = enroll("recipient-b2");
  const sent = sendMessage(handle.db, { from_id: a.id, session_token: a.session_token, to_id_or_name: b.id, text: "second" });
  expect(sent.ok).toBe(true);
  evict(b.id);
  const later = Date.now() + BOUNCE_GRACE_MS + 1_000;
  heartbeatAt(a.id, later);
  expect(bounceOrphanedMail(handle.db, later)).toBe(1);
  // Now A leaves too, with the bounce unread.
  evict(a.id);
  expect(bounceOrphanedMail(handle.db, later + 2 * BOUNCE_GRACE_MS)).toBe(0);
});

test("when the sender is gone too, the original is settled and no notice is written", () => {
  const a = enroll("sender-a3");
  const b = enroll("recipient-b3");
  const sent = sendMessage(handle.db, { from_id: a.id, session_token: a.session_token, to_id_or_name: b.id, text: "third" });
  const msgId = (sent as any).message_id as number;
  evict(b.id);
  evict(a.id);
  const later = Date.now() + BOUNCE_GRACE_MS + 1_000;
  expect(bounceOrphanedMail(handle.db, later)).toBe(0);
  const original = handle.db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id = ?").get(msgId)!;
  expect(original.acked).toBe(1);
  expect(mailTo(a.id)).toHaveLength(0);
});
