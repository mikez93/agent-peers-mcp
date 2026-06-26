// shared/wakeable-launcher.ts
// Managed launcher for app-server-backed wakeable Codex TUI sessions.

import { createServer } from "node:net";

import { CodexAppServerWsClient } from "./app-server-client.ts";
import { WakeLaunchClaimStore } from "./wake-launch-claims.ts";
import { getTty } from "./peer-context.ts";

export interface WakeableLauncherOptions {
  cwd: string;
  port?: number;
  peerName?: string;
  noAltScreen: boolean;
  materialize: boolean;
  extraCodexArgs: string[];
}

export function parseWakeableLauncherArgs(argv: string[]): WakeableLauncherOptions {
  const opts: WakeableLauncherOptions = {
    cwd: process.cwd(),
    noAltScreen: true,
    // Materialize by default: `thread/start` only reserves a rollout path; the
    // rollout JSONL is not written to disk until the thread takes its first
    // turn. `codex resume --remote <threadId>` requires that on-disk rollout to
    // exist, so without a setup turn the bare `codexpeer` launch fails with
    // "no rollout found for thread id ... (code -32600)". `--no-materialize`
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
    if (arg === "--alt-screen") {
      opts.noAltScreen = false;
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
    // Own the wakeable agent-peers identity HERE, in the TUI/resume conversation,
    // and own it explicitly rather than inheriting config.toml's default — the
    // app-server spawn now disables agent-peers (AGENT_PEERS_ENABLED=0, see
    // buildMcpPeerNameConfigArgs), so this is the ONE conversation that registers
    // a broker peer. Single identity ⇒ the lease recipient and the check_messages
    // reader are the same peer-id (see .specs/2026-06-25-wakeable-codex-peer-delivery-fix-spec.md §6.1).
    AGENT_PEERS_ENABLED: "1",
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
  // The app-server's own conversation is used ONLY for the materialize turn that
  // writes the rollout to disk — it does not need agent-peers tools. Disabling
  // the MCP here makes the materialize-side instance a no-op
  // (codex-server.ts:614 early-returns when AGENT_PEERS_ENABLED !== "1": no
  // broker connection, no inbox, no poll loop, zero tools), so it does NOT
  // register a second broker peer. Without this, the app-server starts one MCP
  // per conversation and BOTH (materialize + TUI) register — the message is
  // leased into one identity's inbox while the woken turn's check_messages is
  // served by the other, and delivery silently splits. The wakeable identity is
  // owned by the TUI conversation (buildMcpEnvConfigArgs sets
  // AGENT_PEERS_ENABLED=1). PEER_NAME is still passed for log/tab clarity even
  // though a disabled MCP never registers under it.
  const args = [
    "-c",
    `mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED=${tomlString("0")}`,
  ];
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
  const port = opts.port ?? await allocatePort();
  const appServerUrl = `ws://127.0.0.1:${port}`;
  const claimStore = new WakeLaunchClaimStore();
  const claim = await claimStore.create({
    cwd: opts.cwd,
    tty: getTty(),
    requestedPeerName: opts.peerName,
  });
  let claimReady = false;

  const appServer = Bun.spawn([
    "codex",
    ...buildMcpPeerNameConfigArgs(opts.peerName),
    "app-server",
    "--listen",
    appServerUrl,
  ], {
    // Pin the app-server to the peer's repo. `bin/codex-peer`'s run_bun cd's into
    // the agent-peers-mcp install dir before launching us, so without an explicit
    // cwd the app-server inherits THAT dir instead of the repo. In `--remote`
    // mode the in-TUI `/resume` picker is served by the app-server and scopes its
    // session list by the app-server's cwd — so a wrong cwd makes `/resume` list
    // every repo's sessions instead of only this repo's. The TUI spawn below
    // already sets cwd: opts.cwd; the app-server must match it.
    cwd: opts.cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  await claimStore.update(claim.claim_id, {
    app_server_url: appServerUrl,
    app_server_pid: appServer.pid,
  });

  try {
    await waitForReadyz(port);
    const client = new CodexAppServerWsClient(appServerUrl);
    let thread = await client.startThread({ cwd: opts.cwd });
    if (opts.materialize) {
      await retryEmptyRolloutRace(() => client.startWakeTurn({
        threadId: thread.id,
        clientUserMessageId: "agent-peers-wakeable-materialize",
        prompt: "Wakeable Codex session initialized for agent-peers. Reply exactly: WAKEABLE_CODEX_READY. Do not use tools.",
        wakeId: "wakeable-materialize",
        pendingSignature: "materialize",
      }));
      thread = await retryEmptyRolloutRace(() => client.readThread(thread.id));
    }
    await claimStore.update(claim.claim_id, {
      thread_id: thread.id,
      rollout_path: thread.path,
      status: "ready",
    });
    claimReady = true;
    client.close();

    const codexArgs = buildCodexResumeArgs({
      appServerUrl,
      appServerPid: appServer.pid,
      threadId: thread.id,
      rolloutPath: thread.path,
      peerName: opts.peerName,
      noAltScreen: opts.noAltScreen,
      extraCodexArgs: opts.extraCodexArgs,
    });
    const env = buildWakeableEnv({
      baseEnv: process.env,
      appServerUrl,
      appServerPid: appServer.pid,
      threadId: thread.id,
      rolloutPath: thread.path,
      peerName: opts.peerName,
    });

    console.error(`[agent-peers/wakeable] app-server=${appServerUrl} pid=${appServer.pid}`);
    console.error(`[agent-peers/wakeable] thread=${thread.id}`);
    const tui = Bun.spawn(["codex", ...codexArgs], {
      cwd: opts.cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
    });
    await claimStore.update(claim.claim_id, { tui_pid: tui.pid });
    return await tui.exited;
  } finally {
    if (!claimReady) {
      await claimStore.update(claim.claim_id, { status: "failed" }).catch(() => {});
    }
    try { appServer.kill("SIGTERM"); } catch { /* best effort */ }
    await appServer.exited.catch(() => {});
  }
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

async function waitForReadyz(port: number): Promise<void> {
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
  throw new Error(`app-server did not become ready at ${url}`);
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
