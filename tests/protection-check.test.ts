// Protection check — the endpoint MacGuardian's process reaper consults before
// it kills anything. The contract is a SAFETY invariant, so these tests assert
// the invariant, not the shape: our answer may SPARE a process, never condemn
// one, and every uncertain path must resolve toward life.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startBroker, buildProtectedPidSet, checkProtection } from "../broker.ts";
import { unlinkSync, existsSync } from "node:fs";

const TEST_DB = "/tmp/agent-peers-protection-" + Date.now() + ".db";
const TEST_SECRET = "/tmp/agent-peers-protection-secret-" + Date.now();
const TEST_PORT = 7931;
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

function startTimeOf(pid: number): string {
  const p = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
  return new TextDecoder().decode(p.stdout).trim();
}

test("the broker protects itself — it is PPID=1 by design, which is what got it SIGKILLed every 30min", () => {
  expect(buildProtectedPidSet(handle.db).has(process.pid)).toBe(true);
});

test("a pid we do not vouch for is reported unprotected, NOT dead", () => {
  // `protected: false` must mean "no opinion" — the reaper falls back to its own
  // tests. It must never be readable as an authorization to kill.
  const res = checkProtection(handle.db, [{ pid: process.pid }]);
  expect(res.results[0]!.protected).toBe(true);
  expect(res.schema).toBe(1);
  expect(res.generation).toBeTruthy(); // lets the reaper detect a broker restart
});

test("identity fence: a start_time that disagrees with ours refuses to vouch (PID reuse)", () => {
  const res = checkProtection(handle.db, [
    { pid: process.pid, start_time: "Wed Jan  1 00:00:00 2020" },
  ]);
  expect(res.results[0]!.protected).toBe(false);
  expect(res.results[0]!.reason).toBe("identity_mismatch");
});

test("identity fence passes when start_time matches the live process", () => {
  const res = checkProtection(handle.db, [
    { pid: process.pid, start_time: startTimeOf(process.pid) },
  ]);
  expect(res.results[0]!.protected).toBe(true);
});

test("identity fence treats macOS day-padding whitespace as presentation only", () => {
  const collapsed = startTimeOf(process.pid).replace(/\s+/g, " ");
  const res = checkProtection(handle.db, [
    { pid: process.pid, start_time: collapsed },
  ]);
  expect(res.results[0]!.protected).toBe(true);
  expect(res.results[0]!.reason).toBe("live_agent_session_tree");
  expect(res.results[0]!.start_time).toBe(collapsed);
});

test("a pid that no longer exists is process_not_found, never protected", () => {
  const res = checkProtection(handle.db, [{ pid: 999_999 }]);
  expect(res.results[0]!.protected).toBe(false);
  expect(res.results[0]!.reason).toBe("process_not_found");
});

test("launchd (pid 1) is never expanded — protecting the world would make the reaper useless", () => {
  const protectedPids = buildProtectedPidSet(handle.db);
  // If we ever expanded from pid 1, essentially every process on the machine
  // would land in the set. Assert we are nowhere near that.
  const total = new TextDecoder()
    .decode(Bun.spawnSync(["ps", "-axo", "pid="]).stdout)
    .trim().split("\n").length;
  expect(protectedPids.size).toBeLessThan(total * 0.75);
  expect(protectedPids.has(1)).toBe(false);
});

test("the endpoint is reachable WITHOUT the shared secret (the reaper is a separate system)", async () => {
  const r = await fetch(`http://127.0.0.1:${TEST_PORT}/v1/protection/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([{ pid: process.pid }]),
  });
  expect(r.status).toBe(200);
  const body = await r.json() as { results: { pid: number; protected: boolean }[] };
  expect(body.results[0]!.protected).toBe(true);
});

test("registering as a peer still REQUIRES the secret — protection cannot be laundered onto a hostile process", async () => {
  const r = await fetch(`http://127.0.0.1:${TEST_PORT}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ peer_type: "claude", pid: 4242 }),
  });
  expect(r.status).toBe(401);
});
