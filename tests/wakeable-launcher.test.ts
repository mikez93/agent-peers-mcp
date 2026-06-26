import { expect, test } from "bun:test";

import {
  buildCodexResumeArgs,
  buildMcpEnvConfigArgs,
  buildMcpPeerNameConfigArgs,
  buildWakeableEnv,
  isEmptyRolloutRaceError,
  parseWakeableLauncherArgs,
} from "../shared/wakeable-launcher.ts";

test("parseWakeableLauncherArgs parses launcher flags and passthrough args", () => {
  const opts = parseWakeableLauncherArgs([
    "--cwd", "/repo",
    "--port", "41037",
    "--name", "brisk-bison",
    "--alt-screen",
    "--materialize",
    "--",
    "--model", "gpt-5",
  ]);

  expect(opts.cwd).toBe("/repo");
  expect(opts.port).toBe(41037);
  expect(opts.peerName).toBe("brisk-bison");
  expect(opts.noAltScreen).toBe(false);
  expect(opts.materialize).toBe(true);
  expect(opts.extraCodexArgs).toEqual(["--model", "gpt-5"]);
});

test("parseWakeableLauncherArgs materializes by default so bare resume has a rollout", () => {
  const opts = parseWakeableLauncherArgs([]);

  expect(opts.materialize).toBe(true);
});

test("parseWakeableLauncherArgs honors --no-materialize opt-out", () => {
  const opts = parseWakeableLauncherArgs(["--no-materialize"]);

  expect(opts.materialize).toBe(false);
});

test("buildCodexResumeArgs targets the managed remote thread", () => {
  expect(buildCodexResumeArgs({
    appServerUrl: "ws://127.0.0.1:41037",
    appServerPid: 123,
    threadId: "thread-1",
    rolloutPath: "/rollout.jsonl",
    peerName: "brisk-bison",
    noAltScreen: true,
    extraCodexArgs: ["--model", "gpt-5"],
  })).toEqual([
    "resume",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED=\"1\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_ENABLED=\"1\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_URL=\"ws://127.0.0.1:41037\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_PID=\"123\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_THREAD_ID=\"thread-1\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_ROLLOUT_PATH=\"/rollout.jsonl\"",
    "-c",
    "mcp_servers.agent-peers.env.PEER_NAME=\"brisk-bison\"",
    "--remote",
    "ws://127.0.0.1:41037",
    "--no-alt-screen",
    "thread-1",
    "--model",
    "gpt-5",
  ]);
});

test("buildMcpEnvConfigArgs omits optional values when absent", () => {
  expect(buildMcpEnvConfigArgs({
    appServerUrl: "ws://127.0.0.1:41037",
    appServerPid: 123,
    threadId: "thread-1",
    rolloutPath: null,
  })).toEqual([
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED=\"1\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_ENABLED=\"1\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_URL=\"ws://127.0.0.1:41037\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_PID=\"123\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_THREAD_ID=\"thread-1\"",
  ]);
});

test("buildMcpPeerNameConfigArgs disables agent-peers on the app-server (materialize) MCP", () => {
  // The app-server's materialize conversation must NOT register a second peer:
  // AGENT_PEERS_ENABLED=0 makes that MCP a no-op. PEER_NAME is still passed for
  // log/tab clarity. See .specs/2026-06-25-wakeable-codex-peer-delivery-fix-spec.md §6.1.
  expect(buildMcpPeerNameConfigArgs("wakee2e")).toEqual([
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED=\"0\"",
    "-c",
    "mcp_servers.agent-peers.env.PEER_NAME=\"wakee2e\"",
  ]);
  expect(buildMcpPeerNameConfigArgs()).toEqual([
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED=\"0\"",
  ]);
});

test("single-identity invariant: app-server disables agent-peers, TUI enables it", () => {
  // The crux of the delivery fix: exactly ONE conversation may register a broker
  // peer. The app-server (materialize) path disables agent-peers; the TUI/resume
  // path enables it. If both enabled, delivery splits across two peer-ids.
  const appServer = buildMcpPeerNameConfigArgs("wakee2e").join(" ");
  const tui = buildMcpEnvConfigArgs({
    appServerUrl: "ws://127.0.0.1:41037",
    appServerPid: 123,
    threadId: "thread-1",
    rolloutPath: "/rollout.jsonl",
    peerName: "wakee2e",
  }).join(" ");

  expect(appServer).toContain("AGENT_PEERS_ENABLED=\"0\"");
  expect(appServer).not.toContain("AGENT_PEERS_ENABLED=\"1\"");
  expect(tui).toContain("AGENT_PEERS_ENABLED=\"1\"");
  expect(tui).not.toContain("AGENT_PEERS_ENABLED=\"0\"");
});

test("buildWakeableEnv injects only wake registry hints, not broker secrets", () => {
  const env = buildWakeableEnv({
    baseEnv: { PATH: "/bin", AGENT_PEERS_ENABLED: "1" },
    appServerUrl: "ws://127.0.0.1:41037",
    appServerPid: 123,
    threadId: "thread-1",
    rolloutPath: "/rollout.jsonl",
    peerName: "brisk-bison",
  });

  expect(env.AGENT_PEERS_WAKE_ENABLED).toBe("1");
  expect(env.AGENT_PEERS_WAKE_APP_SERVER_URL).toBe("ws://127.0.0.1:41037");
  expect(env.AGENT_PEERS_WAKE_APP_SERVER_PID).toBe("123");
  expect(env.AGENT_PEERS_WAKE_THREAD_ID).toBe("thread-1");
  expect(env.AGENT_PEERS_WAKE_ROLLOUT_PATH).toBe("/rollout.jsonl");
  expect(env.PEER_NAME).toBe("brisk-bison");
  expect(Object.keys(env).some((key) => key.toLowerCase().includes("session_token"))).toBe(false);
});

test("isEmptyRolloutRaceError matches only the transient app-server empty rollout race", () => {
  expect(isEmptyRolloutRaceError(new Error(
    "thread-store internal error: failed to read thread /tmp/rollout.jsonl: rollout at /tmp/rollout.jsonl is empty",
  ))).toBe(true);
  expect(isEmptyRolloutRaceError(new Error("thread-store internal error: permission denied"))).toBe(false);
  expect(isEmptyRolloutRaceError("rollout at /tmp/rollout.jsonl is empty")).toBe(false);
});
