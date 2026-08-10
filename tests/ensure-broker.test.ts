// tests/ensure-broker.test.ts
//
// The ownership contract: clients never spawn the broker in production. They
// ask launchd (kickstart) and wait. Self-spawn survives only behind
// AGENT_PEERS_SPAWN_BROKER=1 / allowSpawn, and pins the child env so a
// client's AGENT_PEERS_DB or PEER_NAME can never leak into a machine-global
// broker (the root cause of the 2026-08 crash-loop: a Hermes MCP child owned
// port 7900 with its spawner's env).

import { test, expect } from "bun:test";
import { ensureBroker } from "../shared/ensure-broker.ts";

const SCRIPT_URL = new URL("./fixtures/echo-env-broker.ts", import.meta.url).href;

test("alive broker: returns immediately, no kickstart, no spawn", async () => {
  let kicked = 0;
  await ensureBroker(async () => true, SCRIPT_URL, {
    kickstart: async () => { kicked++; },
  });
  expect(kicked).toBe(0);
});

test("dead broker, no spawn flag: kickstarts and resolves once alive", async () => {
  let kicked = 0;
  let aliveAfterKick = false;
  await ensureBroker(
    async () => aliveAfterKick,
    SCRIPT_URL,
    {
      kickstart: async () => { kicked++; aliveAfterKick = true; },
      timeoutMs: 2000,
      pollMs: 50,
      allowSpawn: false,
    },
  );
  expect(kicked).toBe(1);
});

test("dead broker, kickstart no-op, no spawn: throws naming launchd and the escape hatch", async () => {
  let err: Error | null = null;
  try {
    await ensureBroker(async () => false, SCRIPT_URL, {
      kickstart: async () => {},
      timeoutMs: 400,
      pollMs: 50,
      allowSpawn: false,
    });
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  expect(err!.message).toContain("com.mike.agent-peers-broker");
  expect(err!.message).toContain("AGENT_PEERS_SPAWN_BROKER");
});

test("allowSpawn: spawns with pinned env — session vars never reach the child", async () => {
  // The fixture script writes its observed env to the file named by argv[2]…
  // except spawn args aren't passed by ensureBroker, so the fixture uses a
  // well-known path derived from PATH-safe env. Instead: the fixture writes to
  // AGENT_PEERS_TEST_OUT if set — which is a session var, so under the pinned
  // env it must NOT be set. We verify the pinning by the file NOT appearing,
  // and separately verify spawn happened via the alive flip the fixture
  // performs (it serves /health on AGENT_PEERS_PORT).
  const port = 7947;
  process.env.AGENT_PEERS_PORT = String(port);
  process.env.AGENT_PEERS_DB = "/tmp/should-never-leak.db";
  process.env.PEER_NAME = "should-never-leak";
  process.env.AGENT_PEERS_TEST_OUT = `/tmp/ensure-broker-leak-${Date.now()}.json`;
  const leakPath = process.env.AGENT_PEERS_TEST_OUT;

  const isAlive = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(300) });
      return res.ok;
    } catch { return false; }
  };

  try {
    await ensureBroker(isAlive, SCRIPT_URL, { allowSpawn: true, timeoutMs: 5000, pollMs: 100 });
    expect(await isAlive()).toBe(true);
    // Pinned env: the fixture only writes the leak file when it can see
    // AGENT_PEERS_TEST_OUT — a session var outside the pin list.
    expect(await Bun.file(leakPath).exists()).toBe(false);
    // Tell the fixture to exit.
    await fetch(`http://127.0.0.1:${port}/shutdown`).catch(() => {});
  } finally {
    delete process.env.AGENT_PEERS_DB;
    delete process.env.PEER_NAME;
    delete process.env.AGENT_PEERS_TEST_OUT;
    delete process.env.AGENT_PEERS_PORT;
  }
});
