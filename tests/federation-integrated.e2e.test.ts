// End to end: two real broker processes federate over loopback HTTP, each with
// its own home, local secret and database. Covers name@host delivery, replies
// to the exact sender, bare-name discovery, machine-scope listing, an outage
// with queued mail, and rollback (federation off keeps relayed sender names).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, SECRET_HEADER } from "../shared/broker-client.ts";
import { readSharedSecret } from "../shared/shared-secret.ts";

const BROKER = join(import.meta.dir, "..", "broker.ts");
const root = mkdtempSync(join(tmpdir(), "fed-int-"));
const PORTS = { alpha: 7941, beta: 7942 } as const;
type Host = keyof typeof PORTS;
const FED_SECRET = "f".repeat(16) + "e".repeat(16) + "d".repeat(16);
const procs: Partial<Record<Host, ReturnType<typeof Bun.spawn>>> = {};

function home(host: Host) { return join(root, host); }
function setupHome(host: Host) {
  const h = home(host);
  mkdirSync(h, { recursive: true, mode: 0o700 });
  writeFileSync(join(h, ".agent-peers-host"), `${host}\n`);
  writeFileSync(join(h, ".agent-peers-fleet.json"), JSON.stringify({
    alpha: `http://127.0.0.1:${PORTS.alpha}`, beta: `http://127.0.0.1:${PORTS.beta}`,
  }));
  writeFileSync(join(h, ".agent-peers-federation-secret"), FED_SECRET, { mode: 0o600 });
}

async function start(host: Host, federation = true) {
  const h = home(host);
  procs[host] = Bun.spawn(["bun", BROKER], {
    stdout: "ignore", stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "", HOME: h,
      AGENT_PEERS_PORT: String(PORTS[host]),
      AGENT_PEERS_DB: join(h, "peers.db"),
      AGENT_PEERS_SECRET_PATH: join(h, "secret"),
      ...(federation ? { AGENT_PEERS_FEDERATION: "1" } : {}),
    },
  });
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${PORTS[host]}/health`)).ok) return; } catch { /* starting */ }
    await Bun.sleep(100);
  }
  throw new Error(`${host} broker did not start`);
}
async function stop(host: Host) {
  const p = procs[host];
  if (!p) return;
  p.kill("SIGTERM");
  await p.exited;
  delete procs[host];
}
function api(host: Host) {
  return createClient(`http://127.0.0.1:${PORTS[host]}`, () => readSharedSecret(join(home(host), "secret")));
}
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(150);
  }
  throw new Error("timed out");
}
const reg = (host: Host, name: string, peer_type: "claude" | "codex" = "claude") => api(host).register({
  peer_type, name, pid: process.pid, cwd: `/w/${host}`, git_root: null, tty: null, summary: `${name} at work`, durable: true,
});

let vector: { id: string; session_token: string };
let kepler: { id: string; session_token: string };

beforeAll(async () => {
  setupHome("alpha");
  setupHome("beta");
  await start("alpha");
  await start("beta");
  vector = await reg("alpha", "vector-claude");
  kepler = await reg("beta", "kepler-claude");
}, 30000);

afterAll(async () => {
  await stop("alpha");
  await stop("beta");
  rmSync(root, { recursive: true, force: true });
});

test("ready advertises federation and protocol stays 1", async () => {
  const secret = readSharedSecret(join(home("alpha"), "secret"))!;
  const body = await (await fetch(`http://127.0.0.1:${PORTS.alpha}/ready`, { headers: { [SECRET_HEADER]: secret } })).json() as { protocol: number; capabilities: string[] };
  expect(body.protocol).toBe(1);
  expect(body.capabilities).toContain("federation");
});

test("name@host delivers once, and a reply by from_id reaches the exact sender", async () => {
  const sent = await api("alpha").sendMessage({ from_id: vector.id, session_token: vector.session_token, to_id_or_name: "kepler-claude@beta", text: "hello from alpha" });
  expect(sent.ok).toBe(true);
  expect(sent.message_id!).toBeLessThan(0); // outbox receipt, never an inbox id
  const [m] = await until(async () => {
    const got = await api("beta").pollMessages({ id: kepler.id, session_token: kepler.session_token });
    return got.length ? got : null;
  });
  expect(m!.text).toBe("hello from alpha");
  expect(m!.from_name).toBe("vector-claude@alpha");
  await api("beta").ackMessages({ id: kepler.id, session_token: kepler.session_token, lease_tokens: [m!.lease_token] });

  expect((await api("beta").sendMessage({ from_id: kepler.id, session_token: kepler.session_token, to_id_or_name: m!.from_id, text: "reply to vector" })).ok).toBe(true);
  const [r] = await until(async () => {
    const got = await api("alpha").pollMessages({ id: vector.id, session_token: vector.session_token });
    return got.length ? got : null;
  });
  expect(r!.text).toBe("reply to vector");
  expect(r!.from_name).toBe("kepler-claude@beta");
  await api("alpha").ackMessages({ id: vector.id, session_token: vector.session_token, lease_tokens: [r!.lease_token] });
}, 30000);

test("a bare name unknown locally is found on the other machine", async () => {
  const sent = await api("alpha").sendMessage({ from_id: vector.id, session_token: vector.session_token, to_id_or_name: "kepler-claude", text: "bare name" });
  expect(sent.ok).toBe(true);
  const got = await until(async () => {
    const msgs = await api("beta").pollMessages({ id: kepler.id, session_token: kepler.session_token });
    return msgs.find((x) => x.text === "bare name") ? msgs : null;
  });
  await api("beta").ackMessages({ id: kepler.id, session_token: kepler.session_token, lease_tokens: got.map((x) => x.lease_token) });
}, 30000);

test("machine scope lists the other machine's peers, still as a bare array", async () => {
  const peers = await api("alpha").listPeers({ scope: "machine", cwd: "/w/alpha", git_root: null, exclude_id: vector.id });
  expect(Array.isArray(peers)).toBe(true);
  expect(peers.map((p) => p.name)).toContain("kepler-claude@beta");
  const repo = await api("alpha").listPeers({ scope: "repo", cwd: "/w/alpha", git_root: null, exclude_id: vector.id });
  expect(repo.map((p) => p.name)).not.toContain("kepler-claude@beta");
});

test("an outage queues mail, reports the host, and delivers once on recovery", async () => {
  await stop("beta");
  const res = await fetch(`http://127.0.0.1:${PORTS.alpha}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SECRET_HEADER]: readSharedSecret(join(home("alpha"), "secret"))! },
    body: JSON.stringify({ scope: "machine", cwd: "/w/alpha", git_root: null }),
  });
  expect(res.headers.get("x-agent-peers-unreachable-hosts")).toBe("beta");
  const sent = await api("alpha").sendMessage({ from_id: vector.id, session_token: vector.session_token, to_id_or_name: "kepler-claude@beta", text: "sent during outage" });
  expect(sent.ok).toBe(true);
  // Local mail keeps working during the outage.
  const local = await reg("alpha", "local-codex", "codex");
  expect((await api("alpha").sendMessage({ from_id: vector.id, session_token: vector.session_token, to_id_or_name: "local-codex", text: "local" })).ok).toBe(true);
  expect((await api("alpha").pollMessages({ id: local.id, session_token: local.session_token })).length).toBe(1);

  await start("beta");
  // A real client keeps its session across a broker restart (same database).
  const got = await until(async () => {
    const msgs = await api("beta").pollMessages({ id: kepler.id, session_token: kepler.session_token });
    return msgs.some((x) => x.text === "sent during outage") ? msgs : null;
  }, 20000);
  expect(got.filter((x) => x.text === "sent during outage").length).toBe(1);
  // Unacked here on purpose: the rollback test reads it after a restart.
}, 60000);

test("rollback: federation off keeps relayed senders and local service", async () => {
  // Kepler writes to Vector, then alpha restarts with federation off.
  expect((await api("beta").sendMessage({ from_id: kepler.id, session_token: kepler.session_token, to_id_or_name: "vector-claude@alpha", text: "before rollback" })).ok).toBe(true);
  const relayed = await until(async () => {
    const msgs = await api("alpha").pollMessages({ id: vector.id, session_token: vector.session_token });
    return msgs.find((x) => x.text === "before rollback") ?? null;
  });
  expect(relayed.from_name).toBe("kepler-claude@beta");
  await stop("alpha");
  await start("alpha", false);
  // The lease from before the restart expires after 30 s; read it straight
  // from the database instead of waiting, through the same sender lookup.
  const again = await until(async () => {
    const msgs = await api("alpha").pollMessages({ id: vector.id, session_token: vector.session_token });
    return msgs.find((x) => x.text === "before rollback") ?? null;
  }, 45000);
  expect(again.from_name).toBe("kepler-claude@beta");
  const sent = await api("alpha").sendMessage({ from_id: vector.id, session_token: vector.session_token, to_id_or_name: "kepler-claude@beta", text: "after rollback" });
  expect(sent.ok).toBe(false);
  expect(sent.error).toContain("not enabled");
}, 90000);
