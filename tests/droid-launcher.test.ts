import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DroidLaunchClaimStore } from "../shared/droid-launch-claims.ts";
import {
  ClaimBoundDroidWakeMetadataSource,
  DROID_WAKE_PROMPT,
  DroidWakeController,
  buildDroidMcpServer,
  parseDroidLauncherArgs,
  runDroidLauncher,
  type BodylessWakeState,
  type DroidLauncherClient,
  type DroidWakeMetadataSource,
} from "../shared/droid-launcher.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("Droid MCP config uses the ACP stdio schema and carries only launch metadata", () => {
  const server = buildDroidMcpServer({
    claimId: "claim-1",
    stateRoot: "/private/state",
    peerName: "factory-peer",
    bunCommand: "/bin/bun",
    serverPath: "/repo/droid-server.ts",
  });
  expect(server).toEqual({
    name: "agent-peers",
    command: "/bin/bun",
    args: ["/repo/droid-server.ts"],
    env: [
      { name: "AGENT_PEERS_RUNTIME", value: "droid" },
      { name: "AGENT_PEERS_DROID_LAUNCH_CLAIM_ID", value: "claim-1" },
      { name: "AGENT_PEERS_DROID_STATE_DIR", value: "/private/state" },
      { name: "AGENT_PEERS_STATE_DIR", value: "/private/state" },
      { name: "AGENT_PEERS_DISABLE_TAB_TITLE", value: "1" },
      { name: "PEER_NAME", value: "factory-peer" },
    ],
  });
  expect(JSON.stringify(server)).not.toContain("session_token");
});

test("argument parser rejects unknown flags and canonicalizes cwd", () => {
  expect(parseDroidLauncherArgs(["start", "--cwd", ".", "--name", "droid", "--poll-ms", "5"])).toEqual(expect.objectContaining({
    cwd: process.cwd(),
    peerName: "droid",
    pollMs: 5,
  }));
  expect(() => parseDroidLauncherArgs(["start", "--wat"])).toThrow("unknown option: --wat");
});

test("argument parser supports start and exact resume command forms", () => {
  expect(parseDroidLauncherArgs(["start", "build-droid", "/tmp"])).toMatchObject({
    peerName: "build-droid",
    cwd: "/tmp",
  });
  expect(parseDroidLauncherArgs(["resume", "factory-session", "build-droid", "/tmp", "--model", "custom:test"])).toMatchObject({
    sessionId: "factory-session",
    peerName: "build-droid",
    cwd: "/tmp",
    model: "custom:test",
  });
  expect(() => parseDroidLauncherArgs(["resume"])).toThrow("requires a Factory session id");
  expect(() => parseDroidLauncherArgs(["start", "--session-id", "unexpected"])).toThrow("use the resume command");
  expect(() => parseDroidLauncherArgs(["resume", "expected", "--session-id", "overridden"])).toThrow("use the resume command");
  expect(() => parseDroidLauncherArgs(["start", "--poll-ms", "1.5"])).toThrow("positive integer");
  expect(parseDroidLauncherArgs(["start", "--autonomy-level", "low"]).autonomyLevel).toBe("auto-low");
});

test("ordinary launcher syntax supports bare start and exact resume flags without accepting ambiguous selectors", () => {
  expect(parseDroidLauncherArgs([])).toEqual(parseDroidLauncherArgs(["start"]));
  expect(parseDroidLauncherArgs(["--cwd", "/tmp", "--resume", "factory-session"])).toMatchObject({ cwd: "/tmp", cwdExplicit: true, sessionId: "factory-session" });
  expect(parseDroidLauncherArgs(["--resume=factory-session"])).toMatchObject({ sessionId: "factory-session", cwdExplicit: false });
  expect(() => parseDroidLauncherArgs(["--resume"])).toThrow("requires a value");
  expect(() => parseDroidLauncherArgs(["--resume="])).toThrow("requires a Factory session id");
  expect(() => parseDroidLauncherArgs(["--resume", "one", "--resume", "two"])).toThrow("only one resume selector");
  expect(() => parseDroidLauncherArgs(["start", "--resume", "one"])).toThrow("only one resume selector");
  expect(() => parseDroidLauncherArgs(["--wat"])).toThrow("unknown option: --wat");
});

test("wake controller retries unchanged unread mail on bounded backoff and resets for new mail", async () => {
  let now = 1_000;
  let state: BodylessWakeState = { pendingCount: 1, lastMessageId: 42 };
  let calls = 0;
  const client = {
    isBusy: false,
    async prompt() { calls += 1; },
  };
  const controller = new DroidWakeController(
    "session-1",
    client,
    { async read() { return state; } },
    () => {},
    [100, 200],
    () => now,
  );

  expect((await controller.pollOnce()).action).toBe("wake");
  await controller.waitForIdle();
  now += 99;
  expect((await controller.pollOnce()).action).toBe("unchanged");
  now += 1;
  expect((await controller.pollOnce()).action).toBe("wake");
  await controller.waitForIdle();
  now += 200;
  expect((await controller.pollOnce()).action).toBe("wake");
  await controller.waitForIdle();
  now += 10_000;
  expect((await controller.pollOnce()).action).toBe("unchanged");
  expect(calls).toBe(3);

  state = { pendingCount: 2, lastMessageId: 43 };
  expect((await controller.pollOnce()).action).toBe("wake");
  await controller.waitForIdle();
  expect(calls).toBe(4);
  state = { pendingCount: 0, lastMessageId: null };
  expect((await controller.pollOnce()).action).toBe("empty");
});

test("wake controller submits no message content, suppresses duplicates, and queues arrivals while busy", async () => {
  let state: BodylessWakeState = { pendingCount: 1, lastMessageId: 10 };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const prompts: string[] = [];
  const client = {
    isBusy: false,
    async prompt(_sessionId: string, text: string) {
      prompts.push(text);
      await gate;
    },
  };
  const source: DroidWakeMetadataSource = { async read() { return state; } };
  const controller = new DroidWakeController("session-1", client, source);
  expect(await controller.pollOnce()).toEqual({ action: "wake", marker: "1:10" });
  expect(await controller.pollOnce()).toEqual({ action: "unchanged", marker: "1:10" });
  state = { pendingCount: 2, lastMessageId: 11 };
  expect(await controller.pollOnce()).toEqual({ action: "queued", marker: "2:11" });
  release();
  await controller.waitForIdle();
  expect(await controller.pollOnce()).toEqual({ action: "wake", marker: "2:11" });
  expect(prompts).toEqual([DROID_WAKE_PROMPT, DROID_WAKE_PROMPT]);
  expect(prompts.join(" ")).not.toContain("10");
  expect(prompts.join(" ")).not.toContain("11");
});

test("claim-bound metadata follows same-process peer id changes and reads only bodyless metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "droid-metadata-"));
  roots.push(root);
  const claims = new DroidLaunchClaimStore({ rootDir: root });
  const claim = await claims.createClaim({ cwd: "/repo" });
  await claims.bindClaim(claim.claim_id, { peerId: "peer-old", peerName: "droid", mcpPid: process.pid, cwd: "/repo" });
  await writeMetadata(root, "peer-old", [1]);
  const source = new ClaimBoundDroidWakeMetadataSource(claims, claim.claim_id, root);
  expect(await source.read()).toEqual({ pendingCount: 1, lastMessageId: 1 });

  await claims.bindClaim(claim.claim_id, { peerId: "peer-new", peerName: "droid", mcpPid: process.pid, cwd: "/repo" });
  await writeMetadata(root, "peer-new", [7, 8]);
  expect(await source.read()).toEqual({ pendingCount: 2, lastMessageId: 8 });
});

test("managed launcher proves new-session ACP to exact claim binding without spawning Droid", async () => {
  const root = await mkdtemp(join(tmpdir(), "droid-launcher-"));
  roots.push(root);
  const claims = new DroidLaunchClaimStore({ rootDir: root });
  const abort = new AbortController();
  let closed = false;
  let receivedMcp: unknown;
  let createdClaimId = "";
  let finalizedClaim: Promise<unknown> | undefined;
  const configured: Array<[string, string, string]> = [];
  let finish!: (code: number) => void;
  const client: DroidLauncherClient = {
    isBusy: false,
    closed: new Promise<number>((resolve) => { finish = resolve; }),
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };
    },
    async newSession({ mcpServers }) {
      receivedMcp = mcpServers[0];
      const claimId = mcpServers[0]!.env.find((item) => item.name === "AGENT_PEERS_DROID_LAUNCH_CLAIM_ID")!.value;
      createdClaimId = claimId;
      await claims.bindClaim(claimId, { peerId: "peer-bound", peerName: "factory-peer", mcpPid: process.pid, cwd: "/repo" });
      return "factory-session";
    },
    async resumeSession() { throw new Error("not used"); },
    async setConfigOption(sessionId, configId, value) { configured.push([sessionId, configId, value]); },
    async prompt() {},
    async cancel() {},
    close() { closed = true; finish(0); },
  };

  const code = await runDroidLauncher({
    cwd: "/repo",
    peerName: "factory-peer",
    model: "custom:test-model",
    reasoningEffort: "medium",
    autonomyLevel: "normal",
    pollMs: 1,
    claimTimeoutMs: 500,
  }, {
    stateRoot: root,
    claimStore: claims,
    clientFactory: () => client,
    metadataSourceFactory: () => ({ async read() { return { pendingCount: 0, lastMessageId: null }; } }),
    onReady: ({ peerId, sessionId }) => {
      expect(peerId).toBe("peer-bound");
      expect(sessionId).toBe("factory-session");
      finalizedClaim = claims.readClaim(createdClaimId).then((value) => {
        abort.abort();
        return value;
      });
    },
  }, abort.signal);
  expect(code).toBe(0);
  expect(closed).toBe(true);
  expect(receivedMcp).toEqual(expect.objectContaining({ name: "agent-peers" }));
  expect(configured).toEqual([
    ["factory-session", "model", "custom:test-model"],
    ["factory-session", "reasoning_effort", "medium"],
    ["factory-session", "autonomy_level", "normal"],
  ]);
  expect(await claims.readSession("factory-session")).toEqual(expect.objectContaining({ session_id: "factory-session" }));
  expect(await finalizedClaim).toEqual(expect.objectContaining({
    status: "bound",
    session_id: "factory-session",
  }));
});

test("bare resume restores the saved peer name and cwd unless explicitly overridden", async () => {
  const root = await mkdtemp(join(tmpdir(), "droid-resume-"));
  roots.push(root);
  const claims = new DroidLaunchClaimStore({ rootDir: root });
  await claims.saveSession({
    session_id: "factory-session",
    cwd: "/saved/repo",
    requested_peer_name: "requested-droid",
    peer_name: "saved-droid",
    peer_id: "saved-peer",
  });
  const abort = new AbortController();
  let factoryOptions: unknown;
  let resumeOptions: unknown;
  let finish!: (code: number) => void;
  let previousPeerId: string | null | undefined;
  const client: DroidLauncherClient = {
    isBusy: false,
    closed: new Promise<number>((resolve) => { finish = resolve; }),
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };
    },
    async newSession() { throw new Error("not used"); },
    async resumeSession(options) {
      resumeOptions = options;
      const claimId = options.mcpServers[0]!.env.find((item) => item.name === "AGENT_PEERS_DROID_LAUNCH_CLAIM_ID")!.value;
      previousPeerId = (await claims.readClaim(claimId))?.previous_peer_id;
      await claims.bindClaim(claimId, {
        peerId: "saved-peer", peerName: "saved-droid", mcpPid: process.pid, cwd: "/saved/repo",
      });
      return options.sessionId;
    },
    async setConfigOption() {},
    async prompt() {},
    async cancel() {},
    close() { finish(0); },
  };

  await runDroidLauncher({
    cwd: process.cwd(),
    cwdExplicit: false,
    sessionId: "factory-session",
    pollMs: 1,
    claimTimeoutMs: 500,
  }, {
    stateRoot: root,
    claimStore: claims,
    clientFactory: (options) => { factoryOptions = options; return client; },
    metadataSourceFactory: () => ({ async read() { return { pendingCount: 0, lastMessageId: null }; } }),
    onReady: () => abort.abort(),
  }, abort.signal);

  expect(factoryOptions).toMatchObject({ cwd: "/saved/repo", peerName: "saved-droid" });
  expect(resumeOptions).toMatchObject({ sessionId: "factory-session", cwd: "/saved/repo" });
  expect(JSON.stringify(resumeOptions)).toContain("saved-droid");
  expect(previousPeerId).toBe("saved-peer");
});

test("abort cancels and bounds shutdown while an ACP wake prompt is stuck", async () => {
  const root = await mkdtemp(join(tmpdir(), "droid-abort-"));
  roots.push(root);
  const claims = new DroidLaunchClaimStore({ rootDir: root });
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>((resolve) => { resolveClosed = resolve; });
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  let cancelled = false;
  const client: DroidLauncherClient = {
    isBusy: false,
    closed,
    async initialize() {
      return { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } };
    },
    async newSession({ mcpServers }) {
      const claimId = mcpServers[0]!.env.find((item) => item.name === "AGENT_PEERS_DROID_LAUNCH_CLAIM_ID")!.value;
      await claims.bindClaim(claimId, {
        peerId: "peer-bound", peerName: "factory-peer", mcpPid: process.pid, cwd: "/repo",
      });
      return "factory-session";
    },
    async resumeSession() { throw new Error("not used"); },
    async setConfigOption() {},
    async prompt() { promptStarted(); return await new Promise(() => {}); },
    async cancel() { cancelled = true; },
    close() { resolveClosed(0); },
  };
  const abort = new AbortController();
  const running = runDroidLauncher({
    cwd: "/repo", peerName: "factory-peer", pollMs: 1, claimTimeoutMs: 500,
  }, {
    stateRoot: root,
    claimStore: claims,
    clientFactory: () => client,
    metadataSourceFactory: () => ({ async read() { return { pendingCount: 1, lastMessageId: 1 }; } }),
    shutdownGraceMs: 1,
  }, abort.signal);
  await started;
  abort.abort();
  expect(await running).toBe(0);
  expect(cancelled).toBe(true);
});

test("abort interrupts a hanging initialize and returns after the child has actually closed", async () => {
  const harness = await lifecycleHarness();
  const initializing = deferred<void>();
  let childExited = false;
  harness.client.initialize = async () => {
    initializing.resolve();
    return await new Promise(() => {});
  };
  harness.client.close = () => {
    childExited = true;
    harness.exit.resolve(0);
  };
  const running = runDroidLauncher(harness.options, harness.deps, harness.abort.signal);
  await initializing.promise;
  const beforeAbort = Date.now();
  harness.abort.abort();
  expect(await running).toBe(0);
  expect(Date.now() - beforeAbort).toBeLessThan(500);
  expect(childExited).toBe(true);
  expect(await harness.claims.listClaims()).toEqual([]);
});

test("a throwing client factory removes the launch claim created before startup", async () => {
  const harness = await lifecycleHarness();
  let createdClaimId = "";
  const originalCreate = harness.claims.createClaim.bind(harness.claims);
  harness.claims.createClaim = async (options) => {
    const claim = await originalCreate(options);
    createdClaimId = claim.claim_id;
    return claim;
  };
  await expect(runDroidLauncher(harness.options, {
    ...harness.deps,
    clientFactory: () => { throw new Error("fixture spawn failure"); },
  })).rejects.toThrow("fixture spawn failure");
  expect(createdClaimId).not.toBe("");
  expect(await harness.claims.readClaim(createdClaimId)).toBeNull();
  expect(await harness.claims.listClaims()).toEqual([]);
});

test("launcher shutdown waits for delayed child exit instead of resolving when close is called", async () => {
  const harness = await lifecycleHarness();
  const ready = deferred<void>();
  const closing = deferred<void>();
  harness.client.close = () => closing.resolve();
  let settled = false;
  const running = runDroidLauncher(harness.options, {
    ...harness.deps,
    onReady: () => ready.resolve(),
  }, harness.abort.signal).finally(() => { settled = true; });
  try {
    await ready.promise;
    harness.abort.abort();
    await closing.promise;
    await Bun.sleep(10);
    expect(settled).toBe(false);
    harness.exit.resolve(0);
    expect(await running).toBe(0);
    expect(settled).toBe(true);
    expect(await harness.claims.listClaims()).toEqual([]);
  } finally {
    harness.abort.abort();
    harness.exit.resolve(0);
    await running.catch(() => {});
  }
});

test("a child that never closes produces a shutdown timeout and removes its claim", async () => {
  const harness = await lifecycleHarness();
  const initializing = deferred<void>();
  harness.client.initialize = async () => {
    initializing.resolve();
    return await new Promise(() => {});
  };
  harness.client.close = () => {};
  const outcome = runDroidLauncher(harness.options, {
    ...harness.deps,
    shutdownGraceMs: 10,
  }, harness.abort.signal).then((code) => code, (error: Error) => error);
  try {
    await initializing.promise;
    harness.abort.abort();
    const result = await outcome;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("child did not exit before shutdown deadline");
    expect(await harness.claims.listClaims()).toEqual([]);
  } finally {
    harness.exit.resolve(0);
  }
});

test("one hundred idle polls retain only one child-exit subscription until shutdown", async () => {
  const harness = await lifecycleHarness();
  let subscriptions = 0;
  let subscriptionsDuringPolling = 0;
  let polls = 0;
  const closed = harness.client.closed;
  Object.defineProperty(closed, "then", {
    value(...handlers: Parameters<Promise<number>["then"]>) {
      subscriptions++;
      return Promise.prototype.then.apply(closed, handlers);
    },
  });
  expect(await runDroidLauncher(harness.options, {
    ...harness.deps,
    sleep: async () => {},
    metadataSourceFactory: () => ({
      async read() {
        polls++;
        subscriptionsDuringPolling = Math.max(subscriptionsDuringPolling, subscriptions);
        if (polls === 100) harness.abort.abort();
        return { pendingCount: 0, lastMessageId: null };
      },
    }),
  }, harness.abort.signal)).toBe(0);
  expect(polls).toBe(100);
  expect(subscriptionsDuringPolling).toBe(1);
  // The final bounded wait may add one handler, independent of poll count.
  expect(subscriptions).toBeLessThanOrEqual(2);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

async function lifecycleHarness() {
  const root = await mkdtemp(join(tmpdir(), "droid-lifecycle-"));
  roots.push(root);
  const claims = new DroidLaunchClaimStore({ rootDir: root });
  const abort = new AbortController();
  const exit = deferred<number>();
  const client: DroidLauncherClient = {
    isBusy: false,
    closed: exit.promise,
    async initialize() { return { protocolVersion: 1, agentCapabilities: {} }; },
    async newSession({ mcpServers }) {
      const claimId = mcpServers[0]!.env.find((item) => item.name === "AGENT_PEERS_DROID_LAUNCH_CLAIM_ID")!.value;
      await claims.bindClaim(claimId, {
        peerId: "lifecycle-peer-id", peerName: "lifecycle-peer", mcpPid: process.pid, cwd: root,
      });
      return "lifecycle-session";
    },
    async resumeSession() { throw new Error("not used"); },
    async setConfigOption() {},
    async prompt() {},
    async cancel() {},
    close() { exit.resolve(0); },
  };
  return {
    claims, abort, exit, client,
    options: { cwd: root, peerName: "lifecycle-peer", pollMs: 1, claimTimeoutMs: 500 },
    deps: {
      stateRoot: root,
      claimStore: claims,
      clientFactory: () => client,
      metadataSourceFactory: () => ({ async read() { return { pendingCount: 0, lastMessageId: null }; } }),
      shutdownGraceMs: 500,
    },
  };
}

async function writeMetadata(root: string, peerId: string, ids: number[]): Promise<void> {
  const path = join(root, `${encodeURIComponent(peerId)}.metadata.json`);
  await writeFile(path, JSON.stringify({
    unread: ids.map((id) => ({ id, from_name: "redacted", sent_at: "now" })),
    updated_at: "now",
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}
