import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decideWakeLaunchRole, isWakeLaunchEnv, shouldRegisterAsPeer } from "../shared/wake-launch-role.ts";
import { WakeLaunchClaimStore } from "../shared/wake-launch-claims.ts";

const dirs: string[] = [];
function tempStore(): WakeLaunchClaimStore {
  const root = mkdtempSync(join(tmpdir(), "agent-peers-role-"));
  dirs.push(root);
  return new WakeLaunchClaimStore({ rootDir: root });
}
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

test("an ordinary codex session still registers even with no claim", () => {
  // The single most dangerous regression: plain `codex` sessions have never had
  // a wake-launch claim. If the gate treated "no claim" as "go inert", every
  // non-codexpeer session would silently vanish from the network.
  const role = decideWakeLaunchRole({ isWakeLaunch: false, claimedWakeRoot: false });
  expect(role).toBe("standalone");
  expect(shouldRegisterAsPeer(role)).toBe(true);
});

test("the claim winner is the root and takes the peer identity", () => {
  const role = decideWakeLaunchRole({ isWakeLaunch: true, claimedWakeRoot: true });
  expect(role).toBe("root");
  expect(shouldRegisterAsPeer(role)).toBe(true);
});

test("a losing child in a wakeable launch goes inert", () => {
  // This is the duplicate-peer fix: secondary threads (fork/subagent/extra
  // thread) must not become separately addressable peers.
  const role = decideWakeLaunchRole({ isWakeLaunch: true, claimedWakeRoot: false });
  expect(role).toBe("secondary");
  expect(shouldRegisterAsPeer(role)).toBe(false);
});

test("isWakeLaunchEnv only trips on an exact opt-in", () => {
  expect(isWakeLaunchEnv({ AGENT_PEERS_WAKE_LAUNCH: "1" })).toBe(true);
  expect(isWakeLaunchEnv({ AGENT_PEERS_WAKE_LAUNCH: "0" })).toBe(false);
  expect(isWakeLaunchEnv({ AGENT_PEERS_WAKE_LAUNCH: "true" })).toBe(false);
  expect(isWakeLaunchEnv({})).toBe(false);
});

test("exactly one concurrent child wins tryAcquireRoot", async () => {
  // Intent: `consume()` is a read-modify-write and cannot arbitrate this — two
  // per-thread MCP children can both observe the claim as unconsumed. Exclusive
  // create must produce exactly one winner regardless of interleaving.
  //
  // The contenders must be LIVE processes. Racing invented pids passes
  // vacuously for the wrong reason: every contender finds a lock owned by a
  // dead pid and legitimately reclaims it, so all five "win". Real MCP children
  // are alive, so the test spawns real ones.
  const store = tempStore();
  const claim = await store.create({ cwd: "/repo", tty: "ttys001" });

  const holders = Array.from({ length: 4 }, () =>
    Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" }));
  try {
    const pids = [process.pid, ...holders.map((h) => h.pid)];
    const results = await Promise.all(pids.map((pid) => store.tryAcquireRoot(claim.claim_id, pid)));
    expect(results.filter(Boolean).length).toBe(1);
  } finally {
    for (const h of holders) { try { h.kill("SIGKILL"); } catch { /* best effort */ } }
    await Promise.all(holders.map((h) => h.exited.catch(() => {})));
  }
});

test("tryAcquireRoot is idempotent for the child that already holds it", async () => {
  // A retry by the winner must not demote it to secondary.
  const store = tempStore();
  const claim = await store.create({ cwd: "/repo", tty: "ttys001" });
  expect(await store.tryAcquireRoot(claim.claim_id, process.pid)).toBe(true);
  expect(await store.tryAcquireRoot(claim.claim_id, process.pid)).toBe(true);
});

test("a lock held by a dead process is reclaimable", async () => {
  // Otherwise a crashed root would strand the launch: no child could ever claim
  // the identity again and the peer would be permanently unaddressable.
  const store = tempStore();
  const claim = await store.create({ cwd: "/repo", tty: "ttys001" });
  // PID 2^22 is above the macOS/Linux pid_max ceiling, so it cannot be alive.
  expect(await store.tryAcquireRoot(claim.claim_id, 4_194_304)).toBe(true);
  expect(await store.tryAcquireRoot(claim.claim_id, process.pid)).toBe(true);
});

test("removing a claim clears its root lock", async () => {
  const store = tempStore();
  const claim = await store.create({ cwd: "/repo", tty: "ttys001" });
  await store.tryAcquireRoot(claim.claim_id, 4_194_304);
  await store.remove(claim.claim_id);
  // Lock is gone, so a fresh child can claim without the dead-pid reclaim path.
  expect(await store.tryAcquireRoot(claim.claim_id, process.pid)).toBe(true);
});
