// tests/broker-ownership.test.ts
//
// Port-ownership arbitration, verified against real broker subprocesses:
//   1. A client-owner broker that finds the port taken yields with exit 0
//      (the old behavior was a 122-restart EADDRINUSE crash-loop).
//   2. A launchd-owner broker evicts the incumbent (SIGTERM via /health pid)
//      and takes the port.

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const BROKER = new URL("../broker.ts", import.meta.url).pathname;
const PORT = 7949;

function spawnBroker(args: string[], dbPath: string, secretPath: string) {
  return Bun.spawn(["bun", BROKER, ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      AGENT_PEERS_PORT: String(PORT),
      AGENT_PEERS_DB: dbPath,
      AGENT_PEERS_SECRET_PATH: secretPath,
    },
  });
}

async function healthPid(): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(500) });
    const body = (await res.json()) as { pid?: number };
    return typeof body.pid === "number" ? body.pid : null;
  } catch { return null; }
}

async function waitFor(pred: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test("client-owner broker yields with exit 0 when the port is taken; launchd-owner evicts the squatter", async () => {
  const stamp = Date.now();
  const db1 = `/tmp/agent-peers-own-a-${stamp}.db`;
  const db2 = `/tmp/agent-peers-own-b-${stamp}.db`;
  const secret = `/tmp/agent-peers-own-secret-${stamp}`;

  // Incumbent: client-owner broker (the legacy squatter shape).
  const incumbent = spawnBroker([], db1, secret);
  expect(await waitFor(async () => (await healthPid()) !== null, 8000)).toBe(true);
  const incumbentPid = await healthPid();
  expect(incumbentPid).toBe(incumbent.pid);

  // 1. Second client-owner broker must yield with exit 0, not crash-loop.
  const rival = spawnBroker([], db2, secret);
  const rivalExit = await rival.exited;
  expect(rivalExit).toBe(0);
  expect(await healthPid()).toBe(incumbent.pid); // incumbent untouched

  // 2. launchd-owner broker evicts the incumbent and takes the port.
  const launchd = spawnBroker(["--owner=launchd"], db2, secret);
  const evicted = await waitFor(async () => (await healthPid()) === launchd.pid, 10_000);
  expect(evicted).toBe(true);
  const incumbentExit = await incumbent.exited; // SIGTERM → clean exit path
  expect(incumbentExit).toBe(0);

  // The winner reports owner=launchd on /health.
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  const body = (await res.json()) as { owner?: string; epoch?: string };
  expect(body.owner).toBe("launchd");
  expect(typeof body.epoch).toBe("string");

  launchd.kill("SIGTERM");
  await launchd.exited;
}, 30_000);

test("/ready requires the shared secret and reports identity", async () => {
  const stamp = Date.now();
  const db = `/tmp/agent-peers-ready-${stamp}.db`;
  const secretPath = `/tmp/agent-peers-ready-secret-${stamp}`;
  const proc = spawnBroker([], db, secretPath);
  expect(await waitFor(async () => (await healthPid()) === proc.pid, 8000)).toBe(true);

  const unauth = await fetch(`http://127.0.0.1:${PORT}/ready`);
  expect(unauth.status).toBe(401);

  const secret = readFileSync(secretPath, "utf8").trim();
  const auth = await fetch(`http://127.0.0.1:${PORT}/ready`, {
    headers: { "x-agent-peers-secret": secret },
  });
  expect(auth.status).toBe(200);
  const body = (await auth.json()) as { ok: boolean; owner: string; epoch: string; protocol: number; db_id: string };
  expect(body.ok).toBe(true);
  expect(body.owner).toBe("client");
  expect(body.protocol).toBe(1);
  expect(body.db_id.length).toBeGreaterThan(0);

  proc.kill("SIGTERM");
  await proc.exited;
}, 20_000);
