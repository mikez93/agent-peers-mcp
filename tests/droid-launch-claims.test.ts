import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DroidLaunchClaimStore } from "../shared/droid-launch-claims.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function store(): Promise<{ root: string; store: DroidLaunchClaimStore }> {
  const root = await mkdtemp(join(tmpdir(), "droid-claims-"));
  roots.push(root);
  return { root, store: new DroidLaunchClaimStore({ rootDir: root }) };
}

test("claim and session state are private and contain no message bodies or credentials", async () => {
  const fixture = await store();
  const claim = await fixture.store.createClaim({ cwd: "/repo", requestedPeerName: "droid-one", launcherPid: 123 });
  await fixture.store.setSessionId(claim.claim_id, "factory-session");
  await fixture.store.bindClaim(claim.claim_id, { peerId: "peer-1", peerName: "droid-one", mcpPid: process.pid, cwd: "/repo" });
  await fixture.store.saveSession({ session_id: "factory-session", cwd: "/repo", requested_peer_name: "droid-one" });

  expect((await stat(fixture.root)).mode & 0o777).toBe(0o700);
  expect((await stat(join(fixture.root, "claims"))).mode & 0o777).toBe(0o700);
  const claimPath = join(fixture.root, "claims", `${claim.claim_id}.json`);
  expect((await stat(claimPath)).mode & 0o777).toBe(0o600);
  const raw = await readFile(claimPath, "utf8");
  expect(raw).not.toContain("session_token");
  expect(raw).not.toContain("message");
  expect(raw).not.toContain("text");
  expect(await fixture.store.readSession("factory-session")).toEqual(expect.objectContaining({
    session_id: "factory-session",
    cwd: "/repo",
  }));
});

test("same MCP process may rebind after broker re-registration but another process is rejected", async () => {
  const fixture = await store();
  const claim = await fixture.store.createClaim({ cwd: "/repo" });
  await fixture.store.bindClaim(claim.claim_id, { peerId: "old-peer", peerName: "droid", mcpPid: process.pid, cwd: "/repo" });
  const rebound = await fixture.store.bindClaim(claim.claim_id, { peerId: "new-peer", peerName: "droid", mcpPid: process.pid, cwd: "/repo" });
  expect(rebound.peer_id).toBe("new-peer");
  await expect(fixture.store.bindClaim(claim.claim_id, {
    peerId: "attacker",
    peerName: "droid",
    mcpPid: process.ppid,
    cwd: "/repo",
  })).rejects.toThrow("another MCP process");
});

test("concurrent claim binding elects exactly one live MCP process", async () => {
  const fixture = await store();
  const claim = await fixture.store.createClaim({ cwd: "/repo" });
  const results = await Promise.allSettled([
    fixture.store.bindClaim(claim.claim_id, {
      peerId: "peer-a", peerName: "droid-a", mcpPid: process.pid, cwd: "/repo",
    }),
    fixture.store.bindClaim(claim.claim_id, {
      peerId: "peer-b", peerName: "droid-b", mcpPid: process.ppid, cwd: "/repo",
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
});

test("a stale binding fails closed and cannot be concurrently stolen", async () => {
  const fixture = await store();
  const claim = await fixture.store.createClaim({ cwd: "/repo" });
  await fixture.store.bindClaim(claim.claim_id, {
    peerId: "stale-peer", peerName: "stale-droid", mcpPid: 999_999, cwd: "/repo",
  });
  const results = await Promise.allSettled([
    fixture.store.bindClaim(claim.claim_id, {
      peerId: "peer-a", peerName: "droid-a", mcpPid: process.pid, cwd: "/repo",
    }),
    fixture.store.bindClaim(claim.claim_id, {
      peerId: "peer-b", peerName: "droid-b", mcpPid: process.ppid, cwd: "/repo",
    }),
  ]);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect((await fixture.store.readClaim(claim.claim_id))?.peer_id).toBe("stale-peer");
});

test("claim binding rejects an MCP registered from a different cwd", async () => {
  const fixture = await store();
  const claim = await fixture.store.createClaim({ cwd: "/repo" });
  await expect(fixture.store.bindClaim(claim.claim_id, {
    peerId: "peer-1", peerName: "droid", mcpPid: process.pid, cwd: "/other",
  })).rejects.toThrow("cwd does not match");
});

test("waitForBinding observes the exact claim and removeClaim is idempotent", async () => {
  const fixture = await store();
  const claim = await fixture.store.createClaim({ cwd: "/repo" });
  const waiting = fixture.store.waitForBinding(claim.claim_id, { timeoutMs: 500, pollMs: 5 });
  await fixture.store.bindClaim(claim.claim_id, { peerId: "peer-1", peerName: "droid", mcpPid: process.pid, cwd: "/repo" });
  expect((await waiting).peer_id).toBe("peer-1");
  await fixture.store.removeClaim(claim.claim_id);
  await fixture.store.removeClaim(claim.claim_id);
  expect(await fixture.store.readClaim(claim.claim_id)).toBeNull();
});
