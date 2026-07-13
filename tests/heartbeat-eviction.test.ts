// bd-e57.10 — a heartbeat from an EVICTED peer must not silently succeed.
//
// The failure this guards against: if the broker is down for more than
// STALE_THRESHOLD_MS (60s) — a crash, a hang, an OS update — gcStalePeers
// DELETES every peer row on the next sweep. The clients survive that fine; they
// keep heartbeating. But `heartbeatPeer` is a bare UPDATE, and an UPDATE that
// matches zero rows is not an error in SQL. So each agent goes on heartbeating
// into a row that no longer exists, receiving {ok: true} forever, while being
// completely invisible to `list_peers` and unable to receive a message.
//
// This is the house shape one more time: a total failure wearing the costume of
// success. The fix is not to make the UPDATE throw — it is to make the broker
// TELL the client what it actually did, and for the client to act on being told.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, heartbeatPeer, registerPeer, gcStalePeers } from "../broker.ts";
import { unlinkSync, existsSync, readFileSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-hb-evict-" + Date.now() + ".db";
const TEST_SECRET = "/tmp/agent-peers-hb-evict-secret-" + Date.now();
const TEST_PORT = 7933;
let handle: ReturnType<typeof startBroker>;
let secret: string;

beforeAll(() => {
  handle = startBroker(TEST_PORT, TEST_DB, TEST_SECRET);
  secret = readFileSync(TEST_SECRET, "utf8").trim();
});
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

test("a live peer's heartbeat is acknowledged as KNOWN", () => {
  const me = enroll("hb-live");
  expect(heartbeatPeer(handle.db, me.id, me.session_token)).toBe(true);
});

test("THE BUG: a heartbeat from an evicted peer must report NOT-known, not silent success", () => {
  const me = enroll("hb-evicted");

  // Simulate the real sequence: the broker was down >60s, so on its next sweep
  // gcStalePeers deletes this peer. We backdate last_seen rather than sleeping.
  handle.db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), me.id);
  expect(gcStalePeers(handle.db)).toBeGreaterThan(0);

  // The client has NO idea. It heartbeats exactly as before, with credentials
  // that were valid sixty seconds ago. Before the fix this returned undefined
  // (void) and the route answered {ok: true} — forever.
  expect(heartbeatPeer(handle.db, me.id, me.session_token)).toBe(false);
});

test("a heartbeat with a rotated session_token reports NOT-known (the reclaim path rotates it)", () => {
  const me = enroll("hb-rotated");
  handle.db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), me.id);

  // Same name re-registers: the reclaim fast-path UPDATEs in place, preserves
  // the UUID, and rotates the session_token. Anything still holding the OLD
  // token is now a ghost — and must be told so.
  const reclaimed = enroll("hb-rotated");
  expect(reclaimed.id).toBe(me.id);
  expect(reclaimed.session_token).not.toBe(me.session_token);

  expect(heartbeatPeer(handle.db, me.id, me.session_token)).toBe(false);
  expect(heartbeatPeer(handle.db, reclaimed.id, reclaimed.session_token)).toBe(true);
});

test("the /heartbeat route surfaces known:false over HTTP — this is what the client acts on", async () => {
  const me = enroll("hb-http");
  const hb = (body: unknown) => fetch(`http://127.0.0.1:${TEST_PORT}/heartbeat`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-peers-secret": secret },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  expect(await hb({ id: me.id, session_token: me.session_token }))
    .toEqual({ ok: true, known: true });

  handle.db.query("DELETE FROM peers WHERE id = ?").run(me.id);

  // The whole bug, in one assertion: the broker used to say {ok: true} here.
  expect(await hb({ id: me.id, session_token: me.session_token }))
    .toEqual({ ok: true, known: false });
});

test("RECOVERY: an evicted peer that re-registers under its own name gets back on the network", () => {
  const me = enroll("hb-recovers");
  handle.db.query("DELETE FROM peers WHERE id = ?").run(me.id);
  expect(heartbeatPeer(handle.db, me.id, me.session_token)).toBe(false);

  // This is exactly what the client does on known:false. The row is GONE (not
  // merely stale), so reclaim can't preserve the UUID — we get a fresh id. That
  // is acceptable and it is the point: peers are addressed by NAME, and the name
  // is free again precisely because the row was deleted.
  const again = enroll("hb-recovers");
  expect(again.name).toBe("hb-recovers");
  expect(heartbeatPeer(handle.db, again.id, again.session_token)).toBe(true);

  const rows = handle.db.query("SELECT id FROM peers WHERE name = ?").all("hb-recovers");
  expect(rows.length).toBe(1); // one live peer under that name, not a duplicate
});
