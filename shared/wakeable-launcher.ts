// shared/wakeable-launcher.ts
// Managed launcher for app-server-backed wakeable Codex TUI sessions.

import { createServer } from "node:net";
import { existsSync, statSync } from "node:fs";

import { CodexAppServerWsClient, type AppServerThread } from "./app-server-client.ts";
import { BoundedLog, createWakeableAppServerLog } from "./bounded-log.ts";
import { WakeLaunchClaimStore } from "./wake-launch-claims.ts";
import { getTty } from "./peer-context.ts";

export interface WakeableLauncherOptions {
  cwd: string;
  port?: number;
  peerName?: string;
  threadId?: string;
  noAltScreen: boolean;
  materialize: boolean;
  extraCodexArgs: string[];
}

export function parseWakeableLauncherArgs(argv: string[]): WakeableLauncherOptions {
  const opts: WakeableLauncherOptions = {
    cwd: process.cwd(),
    noAltScreen: false,
    // Materialize by default: `thread/start` only reserves a rollout path; the
    // rollout JSONL is not written to disk until something forces a persist.
    // `codex resume --remote <threadId>` requires that on-disk rollout to exist,
    // so without materialization a bare `codexpeer` launch fails with "no
    // rollout found for thread id ... (code -32600)". We materialize with
    // `thread/name/set` (no model turn); see setThreadName. `--no-materialize`
    // remains as an experimental opt-out. See
    // .specs/2026-06-18-wakeable-codex-zed-recipe.md and error-patterns.md.
    materialize: true,
    extraCodexArgs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      opts.extraCodexArgs = argv.slice(i + 1);
      break;
    }
    if (arg === "--cwd" || arg === "-C") {
      opts.cwd = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--port") {
      opts.port = Number.parseInt(requireValue(argv, ++i, arg), 10);
      if (!Number.isInteger(opts.port) || opts.port <= 0) throw new Error("--port must be a positive integer");
      continue;
    }
    if (arg === "--name") {
      opts.peerName = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--thread-id") {
      opts.threadId = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === "--alt-screen") {
      opts.noAltScreen = false;
      continue;
    }
    if (arg === "--no-alt-screen") {
      opts.noAltScreen = true;
      continue;
    }
    if (arg === "--materialize") {
      opts.materialize = true;
      continue;
    }
    if (arg === "--no-materialize") {
      opts.materialize = false;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return opts;
}

export function buildCodexResumeArgs(opts: {
  appServerUrl: string;
  appServerPid: number;
  threadId: string;
  rolloutPath: string | null;
  peerName?: string;
  noAltScreen: boolean;
  extraCodexArgs?: string[];
}): string[] {
  return [
    "resume",
    ...buildMcpEnvConfigArgs({
      appServerUrl: opts.appServerUrl,
      appServerPid: opts.appServerPid,
      threadId: opts.threadId,
      rolloutPath: opts.rolloutPath,
      peerName: opts.peerName,
    }),
    "--remote",
    opts.appServerUrl,
    ...(opts.noAltScreen ? ["--no-alt-screen"] : []),
    opts.threadId,
    ...(opts.extraCodexArgs ?? []),
  ];
}

export function buildMcpEnvConfigArgs(opts: {
  appServerUrl: string;
  appServerPid: number;
  threadId: string;
  rolloutPath: string | null;
  peerName?: string;
}): string[] {
  const values: Record<string, string> = {
    AGENT_PEERS_WAKE_ENABLED: "1",
    AGENT_PEERS_WAKE_APP_SERVER_URL: opts.appServerUrl,
    AGENT_PEERS_WAKE_APP_SERVER_PID: String(opts.appServerPid),
    AGENT_PEERS_WAKE_THREAD_ID: opts.threadId,
    ...(opts.rolloutPath ? { AGENT_PEERS_WAKE_ROLLOUT_PATH: opts.rolloutPath } : {}),
    ...(opts.peerName ? { PEER_NAME: opts.peerName } : {}),
  };

  return Object.entries(values).flatMap(([key, value]) => [
    "-c",
    `mcp_servers.agent-peers.env.${key}=${tomlString(value)}`,
  ]);
}

export function buildMcpPeerNameConfigArgs(peerName?: string): string[] {
  return peerName
    ? ["-c", `mcp_servers.agent-peers.env.PEER_NAME=${tomlString(peerName)}`]
    : [];
}

// Config for the VISIBLE resume app-server (phase 2).
//
// AGENT_PEERS_WAKE_LAUNCH marks every agent-peers MCP this app-server spawns as
// belonging to a wakeable launch. The app-server spawns one MCP PER CODEX
// THREAD, and there is no spawn-time signal telling a child which thread owns
// it, so children elect a single root via the launch claim. The flag is what
// lets a child that loses that election tell "I am a secondary thread, go
// inert" from "I am an ordinary codex session with no claim, register
// normally". Without it the two are indistinguishable and gating would remove
// every plain Codex session from the network.
//
// required=true makes Codex await agent-peers initialization before
// Session::spawn/resume completes. That is what makes the election
// deterministic rather than a race: the root thread is constructed first and no
// descendant runtime is auto-opened during resume, so the root always claims
// before any user- or model-spawned secondary can exist. Scoped to THIS
// app-server only — plain `codex` sessions keep agent-peers optional and still
// degrade gracefully if the broker is down.
export function buildResumeMcpConfigArgs(peerName?: string): string[] {
  return [
    ...buildMcpPeerNameConfigArgs(peerName),
    "-c", `mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_LAUNCH=${tomlString("1")}`,
    "-c", "mcp_servers.agent-peers.required=true",
  ];
}

export function buildMaterializeMcpConfigArgs(peerName?: string): string[] {
  // Config for the SHORT-LIVED materialize app-server (phase 1 of the launch).
  // Its only job is to run one setup turn so the rollout exists on disk; its
  // agent-peers MCP must be a no-op so it NEVER registers a broker peer.
  //
  // Why a separate app-server at all: in `--remote` mode the app-server (NOT
  // the thin resume TUI) spawns the agent-peers MCP for every conversation it
  // hosts, using the app-server process's `-c` config. A single shared
  // app-server therefore registers BOTH the materialize and the resume
  // conversation (name + name-2); the message addressed to `name` lands in the
  // materialize twin's inbox while the daemon wakes the resume twin → split
  // delivery. Isolating materialize on its own app-server with agent-peers
  // disabled (AGENT_PEERS_ENABLED=0 → codex-server.ts early-returns: no broker
  // connection, no inbox, zero tools) means that app-server registers nothing;
  // it is killed right after materialize, and the resume app-server then hosts
  // exactly ONE conversation → ONE identity under the canonical name. PEER_NAME
  // is still passed for log/tab clarity even though a disabled MCP never
  // registers under it. See
  // `.specs/2026-06-25-wakeable-codex-peer-delivery-fix-spec.md`.
  const args = ["-c", `mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED=${tomlString("0")}`];
  if (peerName) {
    args.push("-c", `mcp_servers.agent-peers.env.PEER_NAME=${tomlString(peerName)}`);
  }
  return args;
}

export function buildWakeableEnv(opts: {
  baseEnv: NodeJS.ProcessEnv;
  appServerUrl: string;
  appServerPid: number;
  threadId: string;
  rolloutPath: string | null;
  peerName?: string;
}): NodeJS.ProcessEnv {
  return {
    ...opts.baseEnv,
    ...(opts.peerName ? { PEER_NAME: opts.peerName } : {}),
    AGENT_PEERS_WAKE_ENABLED: "1",
    AGENT_PEERS_WAKE_APP_SERVER_URL: opts.appServerUrl,
    AGENT_PEERS_WAKE_APP_SERVER_PID: String(opts.appServerPid),
    AGENT_PEERS_WAKE_THREAD_ID: opts.threadId,
    ...(opts.rolloutPath ? { AGENT_PEERS_WAKE_ROLLOUT_PATH: opts.rolloutPath } : {}),
  };
}

export async function runWakeableLauncher(opts: WakeableLauncherOptions): Promise<number> {
  const appServerLog = createWakeableAppServerLog({
    peerName: opts.peerName,
    cwd: opts.cwd,
  });
  // A fresh launch creates + materializes a new thread. A resume launch first
  // reads the existing on-disk thread through a short-lived peer-disabled
  // app-server, so it adds no setup turn and cannot register a duplicate peer.
  const thread = opts.threadId
    ? await inspectExistingThread(opts, opts.threadId, appServerLog)
    : await materializeThread(opts, appServerLog);
  const launchCwd = thread.cwd || opts.cwd;

  const claimStore = new WakeLaunchClaimStore();
  const claim = await claimStore.create({
    cwd: launchCwd,
    tty: getTty(),
    requestedPeerName: opts.peerName,
  });
  let claimReady = false;

  try {
    // ----------------------------------------------------------------------
    // PHASE 1 — Resolve the thread on a throwaway app-server.
    //
    // Fresh launches create + materialize here because `codex resume --remote`
    // requires an on-disk rollout. Existing-session launches only read and
    // validate the saved thread. Both operations use a SEPARATE, short-lived
    // app-server whose agent-peers MCP is disabled, so phase 1 registers
    // NOTHING. Phase 2 then re-opens the exact thread on the visible app-server.
    // This isolation guarantees a single identity; see
    // buildMaterializeMcpConfigArgs.
    // ----------------------------------------------------------------------
    // PHASE 2 — Resume on a fresh app-server that hosts ONLY the visible
    // session. Its single agent-peers MCP registers under the canonical name
    // and becomes the wake target (matched to this launch's claim by cwd+tty).
    const port = opts.port ?? await allocatePort();
    const appServerUrl = `ws://127.0.0.1:${port}`;
    const appServer = spawnLoggedAppServer([
      "codex",
      ...buildResumeMcpConfigArgs(opts.peerName),
      "app-server",
      "--listen",
      appServerUrl,
    ], {
      // Pin the app-server to the peer's repo. `bin/codex-peer`'s run_bun cd's
      // into the agent-peers-mcp install dir before launching us, so without an
      // explicit cwd the app-server inherits THAT dir instead of the repo. The
      // TUI spawn below also sets cwd: launchCwd; the app-server must match it.
      cwd: launchCwd,
      env: process.env,
    }, appServerLog, "resume");

    try {
      await waitForReadyz(port, appServerLog.path);
      // The claim is the wake-registration channel: the resume MCP finds it by
      // cwd+tty and reads the app-server URL/pid + thread from it. Point it at
      // the RESUME app-server (phase 2) — that is what the wake daemon connects
      // to. (The resume command's own -c env is ignored in --remote mode, where
      // the app-server, not the TUI, spawns the MCP; the claim is authoritative.)
      await claimStore.update(claim.claim_id, {
        app_server_url: appServerUrl,
        app_server_pid: appServer.process.pid,
        thread_id: thread.id,
        rollout_path: thread.path,
        status: "ready",
      });
      claimReady = true;

      const codexArgs = buildCodexResumeArgs({
        appServerUrl,
        appServerPid: appServer.process.pid,
        threadId: thread.id,
        rolloutPath: thread.path,
        peerName: opts.peerName,
        noAltScreen: opts.noAltScreen,
        extraCodexArgs: opts.extraCodexArgs,
      });
      const env = buildWakeableEnv({
        baseEnv: process.env,
        appServerUrl,
        appServerPid: appServer.process.pid,
        threadId: thread.id,
        rolloutPath: thread.path,
        peerName: opts.peerName,
      });

      const tui = Bun.spawn(["codex", ...codexArgs], {
        cwd: launchCwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
      });
      await claimStore.update(claim.claim_id, { tui_pid: tui.pid });
      return await tui.exited;
    } finally {
      await stopLoggedAppServer(appServer);
    }
  } finally {
    if (!claimReady) {
      await claimStore.update(claim.claim_id, { status: "failed" }).catch(() => {});
    }
  }
}

// Phase 1 of the launch: bring up a throwaway agent-peers-disabled app-server,
// create + materialize the thread on it, ensure the rollout is flushed to disk,
// then tear the app-server down. Returns the thread id + rollout path for the
// resume app-server to re-open. Always kills the materialize app-server, even
// on error.
async function materializeThread(
  opts: WakeableLauncherOptions,
  appServerLog: BoundedLog,
): Promise<AppServerThread> {
  const matPort = await allocatePort();
  const matUrl = `ws://127.0.0.1:${matPort}`;
  const matServer = spawnLoggedAppServer([
    "codex",
    ...buildMaterializeMcpConfigArgs(opts.peerName),
    "app-server",
    "--listen",
    matUrl,
  ], {
    cwd: opts.cwd,
    env: process.env,
  }, appServerLog, "materialize");
  try {
    await waitForReadyz(matPort, appServerLog.path);
    const client = new CodexAppServerWsClient(matUrl);
    try {
      const thread = await client.startThread({ cwd: opts.cwd });
      if (opts.materialize) {
        // Naming the thread persists its rollout with no model turn. See
        // CodexAppServerWsClient.setThreadName for why this replaced the old
        // materialize-turn + thread/rollback approach.
        await retryEmptyRolloutRace(() => client.setThreadName(
          thread.id,
          materializeThreadName(opts.peerName, opts.cwd),
        ));
        // The resume app-server can only re-open this thread once its rollout is
        // actually on disk. Wait for a non-empty file before we kill this
        // app-server, to close the cross-app-server flush race.
        await waitForRolloutOnDisk(thread.path);
      }
      return thread;
    } finally {
      client.close();
    }
  } finally {
    await stopLoggedAppServer(matServer);
  }
}

// Read and validate an existing rollout without adding a turn. This mirrors
// the isolated materialize phase: agent-peers is disabled on the temporary
// app-server, so only the final visible resume app-server registers a peer.
async function inspectExistingThread(
  opts: WakeableLauncherOptions,
  threadId: string,
  appServerLog: BoundedLog,
): Promise<AppServerThread> {
  const inspectPort = await allocatePort();
  const inspectUrl = `ws://127.0.0.1:${inspectPort}`;
  const inspectServer = spawnLoggedAppServer([
    "codex",
    ...buildMaterializeMcpConfigArgs(opts.peerName),
    "app-server",
    "--listen",
    inspectUrl,
  ], {
    cwd: opts.cwd,
    env: process.env,
  }, appServerLog, "inspect");
  try {
    await waitForReadyz(inspectPort, appServerLog.path);
    const client = new CodexAppServerWsClient(inspectUrl);
    try {
      const thread = await client.readThread(threadId);
      await waitForRolloutOnDisk(thread.path);
      return thread;
    } finally {
      client.close();
    }
  } finally {
    await stopLoggedAppServer(inspectServer);
  }
}

// The rollout file IS the materialization proof — `codex resume --remote` fails
// with "no rollout found for thread id" without it. Time out loudly rather than
// returning silently, so a materialization failure surfaces here instead of as a
// confusing resume error two phases later.
export async function waitForRolloutOnDisk(path: string | null, timeoutMs = 10_000): Promise<void> {
  if (!path) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (existsSync(path) && statSync(path).size > 0) return;
    } catch { /* keep polling */ }
    await Bun.sleep(100);
  }
  throw new Error(`thread rollout was never written to ${path} within ${timeoutMs}ms`);
}

// Thread name used to materialize the rollout. Cosmetic but user-visible in
// Codex's thread list, so prefer the peer's own name over the repo directory.
export function materializeThreadName(peerName: string | undefined, cwd: string): string {
  const fallback = cwd.split("/").filter(Boolean).pop() || "wakeable";
  return `agent-peers: ${peerName || fallback}`;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address && typeof address.port === "number") {
          resolve(address.port);
        } else {
          reject(new Error("failed to allocate port"));
        }
      });
    });
    server.on("error", reject);
  });
}

async function waitForReadyz(port: number, logPath?: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  const url = `http://127.0.0.1:${port}/readyz`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* keep polling */
    }
    await Bun.sleep(100);
  }
  throw new Error(`app-server did not become ready at ${url}${logPath ? `; diagnostics: ${logPath}` : ""}`);
}

function spawnLoggedAppServer(
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  log: BoundedLog,
  phase: string,
) {
  log.append(`\n[${new Date().toISOString()}] ${phase} app-server starting\n`);
  const process = Bun.spawn(command, {
    ...options,
    stdout: "pipe",
    stderr: "pipe",
  });
  const drained = Promise.all([
    pumpProcessOutput(process.stdout, log),
    pumpProcessOutput(process.stderr, log),
  ]);
  return { process, drained };
}

async function stopLoggedAppServer(server: ReturnType<typeof spawnLoggedAppServer>): Promise<void> {
  try { server.process.kill("SIGTERM"); } catch { /* best effort */ }
  await server.process.exited.catch(() => {});
  await server.drained.catch(() => {});
}

async function pumpProcessOutput(stream: ReadableStream<Uint8Array>, log: BoundedLog): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength > 0) log.append(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function isEmptyRolloutRaceError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes("thread-store internal error")
    && error.message.includes("rollout at ")
    && error.message.includes(" is empty");
}

async function retryEmptyRolloutRace<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isEmptyRolloutRaceError(error)) throw error;
      lastError = error;
      await Bun.sleep(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("empty rollout retry failed");
}
