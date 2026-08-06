import { expect, test } from "bun:test";

import {
  buildCodexResumeArgs,
  buildMaterializeMcpConfigArgs,
  buildMcpEnvConfigArgs,
  buildMcpPeerNameConfigArgs,
  buildResumeMcpConfigArgs,
  buildWakeableEnv,
  isEmptyRolloutRaceError,
  materializeThreadName,
  parseWakeableLauncherArgs,
  waitForRolloutOnDisk,
} from "../shared/wakeable-launcher.ts";

test("parseWakeableLauncherArgs parses launcher flags and passthrough args", () => {
  const opts = parseWakeableLauncherArgs([
    "--cwd", "/repo",
    "--port", "41037",
    "--name", "brisk-bison",
    "--thread-id", "thread-existing",
    "--alt-screen",
    "--materialize",
    "--",
    "--model", "gpt-5",
  ]);

  expect(opts.cwd).toBe("/repo");
  expect(opts.port).toBe(41037);
  expect(opts.peerName).toBe("brisk-bison");
  expect(opts.threadId).toBe("thread-existing");
  expect(opts.noAltScreen).toBe(false);
  expect(opts.materialize).toBe(true);
  expect(opts.extraCodexArgs).toEqual(["--model", "gpt-5"]);
});

test("parseWakeableLauncherArgs materializes by default so bare resume has a rollout", () => {
  const opts = parseWakeableLauncherArgs([]);

  expect(opts.materialize).toBe(true);
  expect(opts.noAltScreen).toBe(false);
});

test("parseWakeableLauncherArgs keeps inline mode as an explicit compatibility option", () => {
  expect(parseWakeableLauncherArgs(["--no-alt-screen"]).noAltScreen).toBe(true);
});

test("the default launch keeps --no-alt-screen out of the visible TUI command", () => {
  const opts = parseWakeableLauncherArgs([]);
  const args = buildCodexResumeArgs({
    appServerUrl: "ws://127.0.0.1:41037",
    appServerPid: 123,
    threadId: "thread-1",
    rolloutPath: "/rollout.jsonl",
    noAltScreen: opts.noAltScreen,
  });

  expect(args).not.toContain("--no-alt-screen");
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
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_ENABLED=\"1\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_URL=\"ws://127.0.0.1:41037\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_APP_SERVER_PID=\"123\"",
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_THREAD_ID=\"thread-1\"",
  ]);
});

test("buildMcpPeerNameConfigArgs targets the app-server MCP child", () => {
  expect(buildMcpPeerNameConfigArgs("wakee2e")).toEqual([
    "-c",
    "mcp_servers.agent-peers.env.PEER_NAME=\"wakee2e\"",
  ]);
  expect(buildMcpPeerNameConfigArgs()).toEqual([]);
});

test("buildMaterializeMcpConfigArgs disables agent-peers on the throwaway materialize app-server", () => {
  // Phase 1's app-server exists only to write the rollout; its agent-peers MCP
  // must be a no-op (AGENT_PEERS_ENABLED=0) so it never registers a broker peer.
  // PEER_NAME is still passed for log/tab clarity. The single-identity guarantee
  // depends on the materialize side registering NOTHING.
  expect(buildMaterializeMcpConfigArgs("wakee2e")).toEqual([
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED=\"0\"",
    "-c",
    "mcp_servers.agent-peers.env.PEER_NAME=\"wakee2e\"",
  ]);
  expect(buildMaterializeMcpConfigArgs()).toEqual([
    "-c",
    "mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED=\"0\"",
  ]);
});

test("two-app-server invariant: materialize side disabled, resume side default-enabled", () => {
  // The crux of the fix: the materialize app-server must NOT register
  // agent-peers (=0), while the resume app-server inherits the config.toml
  // default (=1, so its sole conversation registers as the canonical identity).
  const materialize = buildMaterializeMcpConfigArgs("wakee2e").join(" ");
  const resume = buildMcpPeerNameConfigArgs("wakee2e").join(" ");
  expect(materialize).toContain("AGENT_PEERS_ENABLED=\"0\"");
  expect(resume).not.toContain("AGENT_PEERS_ENABLED");
  expect(resume).toContain("PEER_NAME=\"wakee2e\"");
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

test("waitForRolloutOnDisk fails loudly when the rollout never appears", async () => {
  // Intent: the rollout file IS the materialization proof — `codex resume
  // --remote` fails with "no rollout found for thread id" without it. A silent
  // timeout here would defer that failure to the resume phase, where the error
  // no longer points at the real cause. This must throw, not return.
  await expect(waitForRolloutOnDisk("/nonexistent/rollout.jsonl", 300))
    .rejects.toThrow(/never written/);
});

test("waitForRolloutOnDisk tolerates a thread with no rollout path", async () => {
  // A null path means the app-server did not report one; that is not a
  // materialization failure and must not throw.
  await expect(waitForRolloutOnDisk(null, 300)).resolves.toBeUndefined();
});

test("materializeThreadName prefers the peer name and falls back to the repo dir", () => {
  // The name is user-visible in Codex's thread list, so it should identify the
  // peer rather than leaking launcher internals.
  expect(materializeThreadName("brisk-bison", "/Users/mike/www/ai/repo"))
    .toBe("agent-peers: brisk-bison");
  expect(materializeThreadName(undefined, "/Users/mike/www/ai/repo"))
    .toBe("agent-peers: repo");
  expect(materializeThreadName(undefined, "/Users/mike/www/ai/repo/"))
    .toBe("agent-peers: repo");
});

test("the resume app-server marks its MCPs as a wakeable launch and requires them", () => {
  // Intent: both flags are load-bearing for single-identity election.
  // AGENT_PEERS_WAKE_LAUNCH lets a losing child distinguish "secondary thread"
  // from "ordinary codex session with no claim". required=true makes Codex
  // await agent-peers init before resume completes, so the root deterministically
  // claims before any secondary thread can exist.
  const args = buildResumeMcpConfigArgs("brisk-bison");

  expect(args).toContain(`mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_LAUNCH="1"`);
  expect(args).toContain("mcp_servers.agent-peers.required=true");
  expect(args).toContain(`mcp_servers.agent-peers.env.PEER_NAME="brisk-bison"`);
});

test("the wake-launch marker is set even when no peer name was requested", () => {
  // An unnamed launch still needs election, so the marker must not be
  // conditional on PEER_NAME the way the name arg is.
  const args = buildResumeMcpConfigArgs(undefined);

  expect(args).toContain(`mcp_servers.agent-peers.env.AGENT_PEERS_WAKE_LAUNCH="1"`);
  expect(args).toContain("mcp_servers.agent-peers.required=true");
  expect(args.join(" ")).not.toContain("PEER_NAME");
});

test("the materialize app-server stays fully disabled and is never a wake launch", () => {
  // Phase 1 must register NOTHING. If it inherited the wake-launch marker it
  // would join the election and could steal the claim from the real session.
  const args = buildMaterializeMcpConfigArgs("brisk-bison");

  expect(args).toContain(`mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED="0"`);
  expect(args.join(" ")).not.toContain("AGENT_PEERS_WAKE_LAUNCH");
  expect(args.join(" ")).not.toContain("required=true");
});
