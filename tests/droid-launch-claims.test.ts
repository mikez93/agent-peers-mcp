import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DroidLaunchClaimStore, selectDroidClaim } from "../shared/droid-launch-claims.ts";

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

test("live broker MCP claim wins over newer crash residue in either directory order", async () => {
  const { store: claims } = await store();
  const live = await claims.createClaim({ cwd: "/repo", launcherPid: 101 });
  await claims.setSessionId(live.claim_id, "session-live");
  const bound = await claims.bindClaim(live.claim_id, { peerId: "peer", peerName: "droid", mcpPid: 102, cwd: "/repo" });
  const stale = { ...bound, claim_id: "stale", launcher_pid: 201, mcp_pid: 202, updated_at: "2999-01-01" };
  const isAlive = (pid: number) => pid === 101 || pid === 102;
  for (const ordered of [[stale, bound], [bound, stale]]) {
    expect(selectDroidClaim(ordered, { id: "peer", pid: 102 }, isAlive)?.claim_id).toBe(live.claim_id);
  }
});

test("rename and broker re-registration update saved actual resume identity", async () => {
  const { store: claims } = await store();
  const claim = await claims.createClaim({ cwd: "/repo", requestedPeerName: "base" });
  await claims.bindClaim(claim.claim_id, { peerId: "old", peerName: "base-2", mcpPid: process.pid, cwd: "/repo" });
  await claims.setSessionId(claim.claim_id, "session");
  await claims.bindClaim(claim.claim_id, { peerId: "new", peerName: "renamed", mcpPid: process.pid, cwd: "/repo" });
  expect(await claims.readSession("session")).toMatchObject({ peer_id: "new", peer_name: "renamed", requested_peer_name: "base" });
});

test("launcher session finalization and MCP rebinding serialize across independent stores", async () => {
  const { root, store: launcher } = await store();
  const mcp = new DroidLaunchClaimStore({ rootDir: root });
  const claim = await launcher.createClaim({ cwd: "/repo", requestedPeerName: "base" });
  await mcp.bindClaim(claim.claim_id, {
    peerId: "peer-old", peerName: "base", mcpPid: process.pid, cwd: "/repo",
  });

  const snapshotRead = deferred<void>();
  const releaseSnapshot = deferred<void>();
  const secondWriterProgress = deferred<"lock-wait" | "claim-read">();
  const retryLock = deferred<void>();
  const launcherRead = launcher.readClaim.bind(launcher);
  let pauseSnapshot = true;
  launcher.readClaim = async (id) => {
    const snapshot = await launcherRead(id);
    if (pauseSnapshot) {
      pauseSnapshot = false;
      expect(snapshot?.peer_id).toBe("peer-old");
      snapshotRead.resolve();
      await releaseSnapshot.promise;
    }
    return snapshot;
  };
  const mcpRead = mcp.readClaim.bind(mcp);
  let secondWriterRead = false;
  mcp.readClaim = async (id) => {
    secondWriterRead = true;
    secondWriterProgress.resolve("claim-read");
    return mcpRead(id);
  };

  const finalizing = launcher.setSessionId(claim.claim_id, "factory-session");
  await snapshotRead.promise;
  // The lock retry is an observable barrier: the second store has attempted
  // the filesystem lock while the first still holds its stale read snapshot.
  // No timing assumption is needed to arrange or prove the interleaving.
  const sleep = spyOn(Bun, "sleep").mockImplementation(() => {
    secondWriterProgress.resolve("lock-wait");
    return retryLock.promise;
  });
  const rebinding = mcp.bindClaim(claim.claim_id, {
    peerId: "peer-new", peerName: "renamed", mcpPid: process.pid, cwd: "/repo",
  });
  try {
    expect(await secondWriterProgress.promise).toBe("lock-wait");
    expect(secondWriterRead).toBe(false);
    releaseSnapshot.resolve();
    await finalizing;
    sleep.mockRestore();
    retryLock.resolve();
    await rebinding;
    expect(await launcher.readClaim(claim.claim_id)).toMatchObject({
      session_id: "factory-session", peer_id: "peer-new", peer_name: "renamed", status: "bound",
    });
    expect(await launcher.readSession("factory-session")).toMatchObject({
      session_id: "factory-session", peer_id: "peer-new", peer_name: "renamed", requested_peer_name: "base",
    });
  } finally {
    sleep.mockRestore();
    releaseSnapshot.resolve();
    retryLock.resolve();
    await Promise.allSettled([finalizing, rebinding]);
  }
});

test("binding after session finalization saves the actual allocated resume identity", async () => {
  const { root, store: launcher } = await store();
  const mcp = new DroidLaunchClaimStore({ rootDir: root });
  const claim = await launcher.createClaim({ cwd: "/repo", requestedPeerName: "base" });
  await launcher.setSessionId(claim.claim_id, "factory-session");
  await mcp.bindClaim(claim.claim_id, {
    peerId: "allocated-peer", peerName: "base-2", mcpPid: process.pid, cwd: "/repo",
  });
  expect(await launcher.readClaim(claim.claim_id)).toMatchObject({
    session_id: "factory-session", peer_id: "allocated-peer", peer_name: "base-2", status: "bound",
  });
  expect(await launcher.readSession("factory-session")).toMatchObject({
    session_id: "factory-session", peer_id: "allocated-peer", peer_name: "base-2", requested_peer_name: "base",
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
