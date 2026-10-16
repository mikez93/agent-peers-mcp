import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CodexDesktopWakeRegistration, desktopThreadId, desktopWakeEligible,
  discoverDesktopWake, parentSocketPaths, type DesktopWakeBinding, type DesktopWakePeer,
} from "../shared/codex-desktop-wake.ts";
import type { AppServerClient, AppServerThread } from "../shared/app-server-client.ts";
import { hashBrokerSessionToken, type WakeRegistryEntry } from "../shared/wake-registry.ts";
import { DeliveryState } from "../shared/delivery-state.ts";

const A = "01a1469b-5ac5-7d51-ad0d-c45c8fd7c301";
const B = "01a1468e-ffbc-7271-a458-4c257acbf633";
const peer: DesktopWakePeer = { peerId: "peer-a", peerName: "desktop-a", sessionToken: "private-test-token", gitRoot: "/repo", tty: null };
const binding: DesktopWakeBinding = { threadId: A, cwd: "/repo", rolloutPath: null,
  appServerPid: 5682, socketPath: "/parent.sock", appServerUrl: "ws+unix:///parent.sock" };

function fixture() {
  const entries = new Map<string, WakeRegistryEntry>();
  let writes = 0;
  const registry = {
    async upsert(entry: WakeRegistryEntry) {
      writes++;
      for (const [id, prior] of entries) if (prior.thread_id === entry.thread_id) entries.delete(id);
      entries.set(entry.peer_id, entry);
    },
    async removeByPeerId(id: string) { entries.delete(id); },
  };
  return { entries, registry, writes: () => writes };
}

function client(thread: AppServerThread, loaded = [thread.id]) {
  const calls: string[] = [];
  const value: AppServerClient = {
    async listLoadedThreads() { calls.push("loaded"); return loaded; },
    async readThread(id) { calls.push(`read:${id}`); return thread; },
    async startWakeTurn() { throw new Error("discovery must never send a turn"); },
    close() { calls.push("close"); },
  };
  return { value, calls };
}

test("desktop route excludes managed, explicitly disabled, Hermes and Droid launches", () => {
  expect(desktopWakeEligible("codex", {})).toBe(true);
  for (const env of [{ AGENT_PEERS_WAKE_LAUNCH: "1" }, { AGENT_PEERS_WAKE_ENABLED: "1" }, { AGENT_PEERS_WAKE_ENABLED: "0" }]) {
    expect(desktopWakeEligible("codex", env)).toBe(false);
  }
  expect(desktopWakeEligible("hermes", {})).toBe(false);
  expect(desktopWakeEligible("droid", {})).toBe(false);
});

test("identity comes only from host metadata threadId, never argument guesses", () => {
  expect(desktopThreadId({ threadId: A })).toBe(A);
  for (const meta of [undefined, null, {}, { thread_id: A }, { threadId: 123 }, { threadId: "latest" }]) {
    expect(desktopThreadId(meta)).toBeNull();
  }
});

test("lsof parser accepts only exact parent-owned pathname sockets, deduplicated", () => {
  expect(parentSocketPaths("p99\nn/other.sock\np5682\nf3\nn/parent.sock\nn/parent.sock\nn->0xabc\np98\nn/wrong.sock\n", 5682))
    .toEqual(["/parent.sock"]);
});

test("discovery requires loaded exact thread and canonical cwd; active tool call is valid", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-cwd-"));
  const alias = `${root}-alias`;
  await symlink(root, alias);
  try {
    const canonical = await realpath(root);
    const mock = client({ id: A, cwd: canonical, path: null, status: { type: "active", activeFlags: [] } }, [B, A]);
    const seenPids: number[] = [];
    const result = await discoverDesktopWake({ threadId: A, parentPid: 5682, cwd: alias }, {
      listSockets: async pid => { seenPids.push(pid); return ["/parent.sock"]; },
      isSocket: async () => true,
      clientFactory: (url, timeout) => { expect(url).toBe("ws+unix:///parent.sock"); expect(timeout).toBeLessThanOrEqual(1_000); return mock.value; },
    });
    expect(seenPids).toEqual([5682]);
    expect(result).toEqual({ ...binding, cwd: canonical });
    expect(mock.calls).toEqual(["loaded", `read:${A}`, "close"]);
  } finally {
    await rm(alias); await rm(root, { recursive: true });
  }
});

test("discovery rejects wrong identity, cwd, unloaded thread, ambiguous endpoints and non-sockets", async () => {
  for (const scenario of ["wrong-id", "wrong-cwd", "not-loaded", "status-not-loaded", "ambiguous", "non-socket"] as const) {
    const mock = client({ id: scenario === "wrong-id" ? B : A,
      cwd: scenario === "wrong-cwd" ? "/other" : "/repo", path: null,
      status: { type: scenario === "status-not-loaded" ? "notLoaded" : "idle" } }, scenario === "not-loaded" ? [B] : [A]);
    const result = await discoverDesktopWake({ threadId: A, parentPid: 5682, cwd: "/repo" }, {
      listSockets: async () => scenario === "ambiguous" ? ["/a.sock", "/b.sock"] : ["/a.sock"],
      isSocket: async () => scenario !== "non-socket",
      canonicalPath: async p => p, clientFactory: () => mock.value,
    });
    expect(result).toBeNull();
    if (scenario === "not-loaded") expect(mock.calls).toEqual(["loaded", "close"]);
    if (scenario === "non-socket") expect(mock.calls).toEqual([]);
  }
});

test("stdio-only parent stays cleanly non-wakeable without repeated discovery or errors", async () => {
  const f = fixture(); let attempts = 0; const errors: unknown[] = [];
  const reg = new CodexDesktopWakeRegistration({ parentPid: 61037, mcpPid: 123, cwd: "/repo", registry: f.registry,
    discover: async opts => {
      attempts++;
      return discoverDesktopWake(opts, { listSockets: async () => [], clientFactory: () => { throw new Error("must not connect"); } });
    }, onError: e => errors.push(e) });
  expect(await reg.observe(undefined, peer)).toBe(false);
  expect(attempts).toBe(0);
  for (let i = 0; i < 3; i++) expect(await reg.observe({ threadId: A }, peer)).toBe(false);
  expect(await reg.refresh({ ...peer, sessionToken: "new" })).toBe(false);
  expect(attempts).toBe(1); expect(errors).toEqual([]); expect(f.writes()).toBe(0);
});

test("registers only after persistence, caches discovery, and refreshes rename/rejoin", async () => {
  const f = fixture(); let attempts = 0;
  const reg = new CodexDesktopWakeRegistration({ parentPid: 5682, mcpPid: 123, cwd: "/repo", registry: f.registry,
    discover: async () => { attempts++; return binding; } });
  expect(await reg.refresh(peer)).toBe(false);
  expect(await reg.observe({ threadId: A }, peer)).toBe(true);
  expect(await reg.observe({ threadId: A }, peer)).toBe(true);
  expect(attempts).toBe(1); expect(f.writes()).toBe(1);
  const first = f.entries.get(peer.peerId)!;
  expect(first).toMatchObject({ thread_id: A, cwd: "/repo", app_server_pid: 5682, mcp_pid: 123,
    tui_pid: null, rollout_path: null, status: "ready", broker_session_token_hash: hashBrokerSessionToken(peer.sessionToken) });
  expect(JSON.stringify(first)).not.toContain(peer.sessionToken);
  expect(await reg.refresh({ ...peer, peerName: "renamed" })).toBe(true);
  expect(f.entries.get(peer.peerId)?.peer_name).toBe("renamed");
  expect(await reg.refresh({ ...peer, peerId: "rejoined", sessionToken: "new-token" })).toBe(true);
  expect(f.entries.size).toBe(1);
  expect(f.entries.get("rejoined")?.broker_session_token_hash).toBe(hashBrokerSessionToken("new-token"));
  expect(attempts).toBe(1);
});

test("conflicting metadata invalidates the old registration permanently, never retargets", async () => {
  const f = fixture(); let attempts = 0;
  const reg = new CodexDesktopWakeRegistration({ parentPid: 5682, mcpPid: 123, cwd: "/repo", registry: f.registry,
    discover: async () => { attempts++; return binding; } });
  await reg.observe({ threadId: A }, peer);
  expect(await reg.observe({ threadId: B }, peer)).toBe(false);
  expect(f.entries.size).toBe(0);
  expect(await reg.observe({ threadId: A }, peer)).toBe(false);
  expect(await reg.refresh(peer)).toBe(false);
  expect(attempts).toBe(1);
});

test("same-cwd sibling MCPs register different exact threads", async () => {
  const f = fixture();
  const make = (id: string) => new CodexDesktopWakeRegistration({ parentPid: 5682, mcpPid: id === A ? 123 : 124,
    cwd: "/repo", registry: f.registry, discover: async opts => ({ ...binding, threadId: opts.threadId }) });
  await Promise.all([make(A).observe({ threadId: A }, peer), make(B).observe({ threadId: B }, { ...peer, peerId: "peer-b" })]);
  expect([...f.entries.values()].map(e => e.thread_id).sort()).toEqual([A, B].sort());
});

test("a failed registry write never reports readiness or fails ordinary tool handling", async () => {
  const errors: unknown[] = [];
  const reg = new CodexDesktopWakeRegistration({ parentPid: 5682, mcpPid: 123, cwd: "/repo",
    discover: async () => binding, onError: e => errors.push(e),
    registry: { upsert: async () => { throw new Error("disk full"); }, removeByPeerId: async () => {} } });
  expect(await reg.observe({ threadId: A }, peer)).toBe(false);
  expect(errors).toHaveLength(1);
});

test("BARRIER: awaiting desktop discovery cannot confirm a response built after arrival", async () => {
  const delivery = new DeliveryState();
  const f = fixture();
  let finish!: (value: DesktopWakeBinding) => void;
  const discovery = new Promise<DesktopWakeBinding>(resolve => { finish = resolve; });
  const reg = new CodexDesktopWakeRegistration({ parentPid: 5682, mcpPid: 123, cwd: "/repo", registry: f.registry,
    discover: async () => discovery });
  delivery.draw("previous-call", [7]);
  const arrival = delivery.newArrival(); // same order as withPiggyback + beforeReadQueue
  const waiting = reg.observe({ threadId: A }, peer);
  delivery.promote("previous-call");
  finish(binding);
  expect(await waiting).toBe(true);
  expect(delivery.confirmable(arrival)).toEqual([]);
  expect(delivery.confirmable(delivery.newArrival())).toEqual([7]);
});

test.skipIf(platform() !== "darwin")("real lsof and native Unix RPC discover only this process's exact thread", async () => {
  const root = await mkdtemp("/tmp/ap-desktop-discovery-");
  const socket = join(root, "app.sock");
  const cwd = await realpath(root);
  const requests: string[] = [];
  const server = Bun.serve({ unix: socket,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response("upgrade required", { status: 400 }); },
    websocket: { message(ws, raw) {
      const { id, method, params } = JSON.parse(String(raw));
      requests.push(method);
      const result = method === "thread/loaded/list" ? { data: [A] }
        : method === "thread/read" ? { thread: { id: params.threadId, cwd, path: null, status: { type: "idle" } } } : {};
      ws.send(JSON.stringify({ id, result }));
    } },
  });
  try {
    const result = await discoverDesktopWake({ threadId: A, parentPid: process.pid, cwd: root });
    expect(result).toMatchObject({ threadId: A, cwd, appServerPid: process.pid, rolloutPath: null });
    expect(join(await realpath(dirname(result!.socketPath)), basename(result!.socketPath)))
      .toBe(join(cwd, "app.sock"));
    expect(requests).toEqual(["initialize", "thread/loaded/list", "thread/read"]);
    expect(await discoverDesktopWake({ threadId: B, parentPid: process.pid, cwd: root })).toBeNull();
    // PID1 is not this test's parent-owned endpoint; never scan globally.
    expect(await discoverDesktopWake({ threadId: A, parentPid: 1, cwd: root })).toBeNull();
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
});
