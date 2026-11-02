import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatRouteId } from "../shared/broker-addressing.ts";
import { parseAddress } from "../shared/peer-address.ts";
import {
  FederationService, FEDERATION_HOST_HEADER, FEDERATION_SECRET_HEADER,
  type FederationConfig, type FederationDeps, type FederationEnvelope,
} from "../shared/federation.ts";
import { loadFederationConfig, validateFederationConfig } from "../shared/federation-config.ts";
import type { Peer, SendMessageRequest, SendMessageResponse } from "../shared/types.ts";

const FLEET_SECRET = "test-federation-secret-never-a-real-credential";
const LOCAL_SECRET = "test-local-secret-never-a-real-credential";
const dirs: string[] = [];
const machines: Machine[] = [];
const servers: { stop(close?: boolean): unknown }[] = [];
let clock = 1_800_000_000_000;
let networkCalls = 0;
const network = new Map<string, Machine>();

afterEach(async () => {
  await Promise.all(machines.map(m => m.service.stop()));
  for (const server of servers.splice(0)) server.stop(true);
  for (const machine of machines.splice(0)) machine.db.close();
  network.clear();
  networkCalls = 0;
  clock = 1_800_000_000_000;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
function peer(name: string, peer_type: Peer["peer_type"] = "claude"): Peer {
  const date = new Date(clock).toISOString();
  return { id: randomUUID(), name, peer_type, pid: process.pid, cwd: "/test/repo", git_root: "/test/repo",
    tty: null, summary: "working", registered_at: date, started_at: date, last_seen: date };
}
interface Machine {
  db: Database;
  dbPath: string;
  config: FederationConfig;
  service: FederationService;
  deps: FederationDeps;
  peers: Peer[];
  token: string;
  throwDelivery: boolean;
  throwNotice: boolean;
  rejection: SendMessageResponse | null;
  localResult: SendMessageResponse | null;
  offline: boolean;
  loseResponse: boolean;
  notices: number;
}
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  networkCalls++;
  for (const m of machines) expect(m.db.inTransaction).toBe(false);
  const request = url instanceof Request ? new Request(url, init) : new Request(String(url), init);
  const host = new URL(request.url).hostname.split(".")[0]!;
  const machine = network.get(host);
  if (!machine || machine.offline) throw new Error("test offline");
  const response = await machine.service.handle(request);
  if (machine.loseResponse) {
    machine.loseResponse = false;
    throw new Error("test crash after remote commit");
  }
  return response ?? new Response(null, { status: 404 });
}) as typeof fetch;

function makeMachine(host: string, peers: Peer[] = [peer(host)], fetcher = fakeFetch): Machine {
  const root = mkdtempSync(join(tmpdir(), `ap-federation-${host}-`));
  dirs.push(root);
  const dbPath = join(root, "broker.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT, to_chat TEXT, from_id TEXT,
    from_chat TEXT, text TEXT, sent_at TEXT, message_uid TEXT UNIQUE, acked INTEGER NOT NULL DEFAULT 0
  ); CREATE TABLE local_routes (id TEXT PRIMARY KEY, peer_id TEXT, chat TEXT);
  CREATE TABLE peers (id TEXT PRIMARY KEY, name TEXT);`);
  for (const p of peers) db.query("INSERT INTO peers (id, name) VALUES (?, ?)").run(p.id, p.name);
  const config: FederationConfig = { enabled: true, host,
    hosts: { alpha: "https://alpha.test", beta: "https://beta.test", gamma: "https://gamma.test" },
    secretPath: join(root, "federation-secret"), localSecretPath: join(root, "local-secret"),
    retryBaseMs: 10, retryMaxMs: 80, discoveryTimeoutMs: 40, relayTimeoutMs: 100,
  };
  writeFileSync(config.secretPath, FLEET_SECRET, { mode: 0o600 });
  writeFileSync(config.localSecretPath, LOCAL_SECRET, { mode: 0o600 });
  const machine = { db, dbPath, config, peers, token: "session-only-local", throwDelivery: false,
    throwNotice: false, rejection: null, localResult: null, offline: false, loseResponse: false,
    notices: 0 } as Machine;
  const insert = (m: { to_id: string; to_chat: string | null; from_id: string; from_chat?: string | null;
    text: string; sent_at: string; message_uid: string }) => db.query<{ id: number }, [string, string | null, string, string | null, string, string, string]>(
      `INSERT INTO messages (to_id,to_chat,from_id,from_chat,text,sent_at,message_uid) VALUES (?,?,?,?,?,?,?) RETURNING id`,
    ).get(m.to_id, m.to_chat, m.from_id, m.from_chat ?? null, m.text, m.sent_at, m.message_uid)!;
  const deps: FederationDeps = {
    db, config, fetch: fetcher, now: () => clock,
    listLocalPeers: ({ query }) => {
      if (!query) return [...machine.peers];
      const exact = machine.peers.filter(p => p.name === query || p.id === query);
      return exact.length ? exact : machine.peers.filter(p => p.name.toLowerCase() === query.toLowerCase()
        || p.name.toLowerCase().startsWith(`${query.toLowerCase()}-`));
    },
    snapshotSender: req => {
      const p = machine.peers.find(p => p.id === req.fromId)!;
      const chat = p.peer_type === "hermes" ? req.fromChat : null;
      const id = chat ? chatRouteId(p.name, chat) : p.id;
      if (chat) db.query("INSERT OR IGNORE INTO local_routes VALUES (?, ?, ?)").run(id, p.id, chat);
      return { id, peer_id: p.id, name: p.name, peer_type: p.peer_type, cwd: p.cwd, summary: p.summary, chat };
    },
    sendLocal: req => db.transaction((): SendMessageResponse => {
      if (req.session_token !== machine.token) return { ok: false, code: "unauthorized", error: "unauthorized sender" };
      if (machine.localResult) return machine.localResult;
      const remote = machine.service.remoteRoute(req.to_id_or_name);
      const p = remote ?? parseAddress(req.to_id_or_name);
      if (p.host && p.host !== host) return machine.service.enqueue({
        db, fromId: req.from_id, fromName: machine.peers.find(p => p.id === req.from_id)!.name,
        host: p.host, name: p.name, chat: p.chat, text: req.text, fromChat: req.from_chat ?? null,
        sentAt: new Date(clock).toISOString(),
      });
      const target = machine.peers.find(peer => peer.id === req.to_id_or_name || peer.name === p.name);
      if (!target) return { ok: false, code: "unknown_peer", error: "unknown peer" };
      return { ok: true, message_id: insert({ to_id: target.id, to_chat: p.chat, from_id: req.from_id,
        text: req.text, sent_at: new Date(clock).toISOString(), message_uid: randomUUID() }).id };
    })(),
    deliverLocal: msg => {
      if (machine.throwDelivery) throw new Error("test destination crash");
      if (machine.rejection) return machine.rejection;
      const route = db.query<{ peer_id: string; chat: string }, [string]>(
        "SELECT peer_id, chat FROM local_routes WHERE id = ?",
      ).get(msg.to_address);
      const p = parseAddress(msg.to_address);
      const target = machine.peers.find(peer => peer.id === (route?.peer_id ?? p.name) || peer.name === p.name);
      if (!target) return { ok: false, code: "unknown_peer", error: "unknown target" };
      return { ok: true, message_id: insert({ ...msg, to_id: target.id, to_chat: route?.chat ?? p.chat }).id };
    },
    deliverNotice: notice => {
      if (machine.throwNotice) throw new Error("test bounce transaction failure");
      machine.notices++;
      return { message_id: insert(notice).id };
    },
  };
  machine.deps = deps;
  machine.service = new FederationService(deps);
  machines.push(machine);
  network.set(host, machine);
  return machine;
}
function pair() {
  const a = makeMachine("alpha");
  const b = makeMachine("beta");
  delete a.config.hosts.gamma;
  delete b.config.hosts.gamma;
  return [a, b] as const;
}
function request(m: Machine, to: string, from_chat?: string): SendMessageRequest {
  return { from_id: m.peers[0]!.id, session_token: m.token, to_id_or_name: to,
    text: "hello across machines", ...(from_chat ? { from_chat } : {}) };
}
function rows(m: Machine) {
  return m.db.query<{ id: number; to_id: string; to_chat: string | null; from_id: string; from_chat: string | null;
    text: string; message_uid: string; acked: number }, []>("SELECT * FROM messages ORDER BY id").all();
}
function outbox(m: Machine) {
  return m.db.query<{ message_uid: string; envelope: string; status: string; attempts: number; next_attempt: number; last_error: string | null }, []>(
    "SELECT * FROM federation_outbox ORDER BY id",
  ).all();
}
function rawRelay(message: FederationEnvelope, secret = FLEET_SECRET) {
  return new Request("http://127.0.0.1/federation/relay", { method: "POST", headers: {
    [FEDERATION_SECRET_HEADER]: secret, [FEDERATION_HOST_HEADER]: message.origin_host,
  }, body: JSON.stringify(message) });
}
async function restart(m: Machine) {
  await m.service.stop();
  m.service = new FederationService(m.deps);
}

test("explicit remote send queues synchronously; local messaging survives offline hosts", async () => {
  const [a, b] = pair();
  b.offline = true;
  expect(a.deps.sendLocal(request(a, "beta@beta"))).toMatchObject({
    ok: true, message_id: -1, notice: expect.stringContaining("queued"),
  });
  expect(networkCalls).toBe(0);
  expect(await a.service.send(request(a, "alpha"))).toMatchObject({ ok: true });
  await a.service.tick();
  expect(outbox(a)[0]).toMatchObject({ status: "pending", attempts: 1 });
  expect(rows(a)).toHaveLength(1);
  expect(rows(a)[0]!.id).toBe(1); // Outbox receipt -1 never names this local message.
  expect(rows(b)).toHaveLength(0);
  expect(outbox(a)[0]!.envelope).not.toContain(a.token);
  b.offline = false;
  clock += 10;
  await a.service.tick();
  expect(a.service.status()).toEqual({ pending: 0, delivered: 1, bounced: 0 });
  expect(rows(b)[0]).toMatchObject({ to_id: b.peers[0]!.id, acked: 0 });
  expect(b.service.senderForMessage(rows(b)[0]!.id)).toMatchObject({
    from_id: a.peers[0]!.id, from_name: "alpha@alpha", from_peer_type: "claude",
  });
  expect(b.db.query("SELECT count(*) AS n FROM peers").get()).toEqual({ n: 1 });
});

test("remote commit then lost response survives service restart and inserts only once", async () => {
  const [a, b] = pair();
  a.deps.sendLocal(request(a, "beta@beta"));
  b.loseResponse = true;
  await a.service.tick();
  expect(rows(b)).toHaveLength(1);
  expect(a.service.status().pending).toBe(1);
  await restart(a);
  await restart(b);
  clock += 10;
  await a.service.tick();
  expect(a.service.status().delivered).toBe(1);
  expect(rows(b)).toHaveLength(1);
  expect(b.db.query("SELECT count(*) AS n FROM federation_receipts").get()).toEqual({ n: 1 });
  expect(b.service.remoteRoute(a.peers[0]!.id)).toEqual({ host: "alpha", name: a.peers[0]!.id, chat: null });
  expect(b.deps.sendLocal(request(b, a.peers[0]!.id)).ok).toBe(true);
  await b.service.tick();
  expect(rows(a)[0]!.to_id).toBe(a.peers[0]!.id);
});

test("reply to a remote chat UUID survives both federation-service restarts", async () => {
  const a = makeMachine("alpha", [peer("valentina-hermes", "hermes")]);
  const b = makeMachine("beta", [peer("marco")]);
  delete a.config.hosts.gamma;
  delete b.config.hosts.gamma;
  const chat = "stable-chat/id@title";
  a.deps.sendLocal(request(a, "marco@beta", chat));
  await a.service.tick();
  const sender = b.service.senderForMessage(rows(b)[0]!.id)!;
  expect(sender.from_name).toBe(`valentina-hermes@alpha/${chat}`);
  expect(sender.from_id).toBe(chatRouteId("valentina-hermes", chat));
  await restart(a);
  await restart(b);
  b.deps.sendLocal(request(b, sender.from_id));
  await b.service.tick();
  expect(rows(a)[0]).toMatchObject({ to_id: a.peers[0]!.id, to_chat: chat, acked: 0 });
});

test("business rejection bounces candidates once to the originating chat mailbox", async () => {
  const a = makeMachine("alpha", [peer("author", "hermes")]);
  const b = makeMachine("beta", [peer("target", "hermes")]);
  b.rejection = { ok: false, code: "chat_miss", error: "no exact chat", candidates: ["target/email shit", "target/stable/id@key"] };
  a.deps.sendLocal(request(a, "target@beta/email", "sender-chat"));
  await a.service.tick();
  expect(a.service.status().bounced).toBe(1);
  expect(rows(b)).toHaveLength(0);
  expect(rows(a)[0]).toMatchObject({ to_id: a.peers[0]!.id, to_chat: "sender-chat", acked: 0 });
  expect(rows(a)[0]!.text).toContain("target@beta/email shit");
  expect(rows(a)[0]!.text).toContain("target@beta/stable/id@key");
  expect(a.service.senderForMessage(rows(a)[0]!.id)?.from_name).toBe("agent-peers@beta");
  await restart(a);
  clock += 1_000_000;
  await a.service.tick();
  expect(rows(a)).toHaveLength(1);
});

test.each(["unknown_peer", "ambiguous", "chat_miss", "mailbox_full", "stale_peer"] as const)(
  "%s rejection is terminal with a durable bounce, not an infinite relay retry", async code => {
    const [a, b] = pair();
    b.rejection = { ok: false, code, error: `test ${code}` };
    a.deps.sendLocal(request(a, "beta@beta"));
    await a.service.tick();
    expect(a.service.status()).toEqual({ pending: 0, delivered: 0, bounced: 1 });
    expect(rows(a)[0]!.text).toContain(`test ${code}`);
    const calls = networkCalls;
    clock += 1_000_000;
    await a.service.tick();
    expect(networkCalls).toBe(calls);
  },
);

test("failed destination insertion rolls back dedupe and retry recovers", async () => {
  const [a, b] = pair();
  b.throwDelivery = true;
  a.deps.sendLocal(request(a, "beta@beta"));
  await a.service.tick();
  expect(outbox(a)[0]).toMatchObject({ status: "pending", last_error: "federation HTTP 503" });
  expect(b.db.query("SELECT count(*) AS n FROM federation_receipts").get()).toEqual({ n: 0 });
  b.throwDelivery = false;
  clock += 10;
  await a.service.tick();
  expect(rows(b)).toHaveLength(1);
});

test("a failed bounce write rolls back completion and can recover after the sender is evicted", async () => {
  const [a, b] = pair();
  b.rejection = { ok: false, code: "mailbox_full", error: "full" };
  a.deps.sendLocal(request(a, "beta@beta"));
  a.throwNotice = true;
  a.peers.splice(0);
  await a.service.tick();
  expect(a.service.status().pending).toBe(1);
  expect(rows(a)).toHaveLength(0);
  a.throwNotice = false;
  clock += 10;
  await a.service.tick();
  expect(a.service.status().bounced).toBe(1);
  expect(rows(a)).toHaveLength(1);
});

test("fleet credential is separate, reread after repair, and never accepts the local header", async () => {
  const [a, b] = pair();
  writeFileSync(b.config.secretPath, "different-valid-test-secret-at-least-32", { mode: 0o600 });
  a.deps.sendLocal(request(a, "beta@beta"));
  await a.service.tick();
  expect(outbox(a)[0]).toMatchObject({ status: "pending", last_error: "federation HTTP 401" });
  writeFileSync(b.config.secretPath, FLEET_SECRET, { mode: 0o600 });
  clock += 10;
  await a.service.tick();
  expect(rows(b)).toHaveLength(1);
  const message = JSON.parse(outbox(a)[0]!.envelope);
  expect((await b.service.handle(rawRelay(message, LOCAL_SECRET)))!.status).toBe(401);
  const wrongHeader = new Request("http://127.0.0.1/federation/directory", {
    headers: { "x-agent-peers-secret": LOCAL_SECRET, [FEDERATION_HOST_HEADER]: "alpha" },
  });
  expect((await b.service.handle(wrongHeader))!.status).toBe(401);
  expect((await b.service.handle(rawRelay(message, "é".repeat(FLEET_SECRET.length))))!.status).toBe(401);
  writeFileSync(b.config.secretPath, LOCAL_SECRET, { mode: 0o600 });
  expect((await b.service.handle(rawRelay(message, LOCAL_SECRET)))!.status).toBe(401);
});

test("bare names use live discovery, keep local precedence, and revalidate after awaiting", async () => {
  const [a, b] = pair();
  b.peers.push(peer("alpha"));
  expect((await a.service.send(request(a, "alpha"))).ok).toBe(true);
  expect(networkCalls).toBe(0);
  expect((await a.service.send(request(a, "beta"))).ok).toBe(true);
  expect(networkCalls).toBe(1);
  expect(a.service.remoteRoute(b.peers[0]!.id)?.host).toBe("beta");
  await a.service.tick();
  expect(rows(b)).toHaveLength(1);
  const original = a.deps.fetch!;
  a.deps.sendLocal = req => ({ ok: false, code: "unknown_peer", error: "unknown" });
  const custom = new FederationService({ ...a.deps, fetch: (async (...args: Parameters<typeof fetch>) => {
    const response = await original(...args);
    a.deps.sendLocal = () => ({ ok: false, code: "unauthorized", error: "token expired" });
    return response;
  }) as typeof fetch, sendLocal: req => a.deps.sendLocal(req) });
  expect(await custom.send(request(a, "beta"))).toMatchObject({ ok: false, code: "unauthorized" });
  await custom.stop();
});

test("two matching hosts or an unreachable host require explicit qualified addressing", async () => {
  const a = makeMachine("alpha");
  const b = makeMachine("beta", [peer("sam")]);
  const c = makeMachine("gamma", [peer("sam")]);
  expect(await a.service.send(request(a, "sam"))).toMatchObject({
    ok: false, code: "ambiguous", candidates: ["sam@beta", "sam@gamma"],
  });
  c.offline = true;
  expect(await a.service.send(request(a, "sam"))).toMatchObject({
    ok: false, code: "ambiguous", candidates: ["sam@beta"],
    error: expect.stringContaining("gamma"),
  });
  expect(a.deps.sendLocal(request(a, "sam@gamma")).ok).toBe(true);
  expect(outbox(a)).toHaveLength(1);
  expect(rows(b)).toHaveLength(0);
});

test.each(["ambiguous", "chat_miss", "stale_peer", "mailbox_full", "unauthorized", "invalid"] as const)(
  "local %s never falls back to a remote machine", async code => {
    const [a] = pair();
    a.localResult = { ok: false, code, error: code };
    expect(await a.service.send(request(a, "beta"))).toEqual(a.localResult);
    expect(networkCalls).toBe(0);
  },
);

test("explicit names are exact, while remote bare personas discover full names", async () => {
  const [a, b] = pair();
  b.peers[0]!.name = "valentina-work-hermes";
  a.deps.sendLocal(request(a, "valentina@beta"));
  await a.service.tick();
  expect(rows(b)).toHaveLength(0);
  expect(rows(a)[0]!.text).toContain("valentina-work-hermes@beta");
  expect((await a.service.send(request(a, "valentina"))).ok).toBe(true);
  await a.service.tick();
  expect(rows(b)).toHaveLength(1);
});

test("directory is freshly queried, projects safe fields, and persists routes without remote peer rows", async () => {
  const [a, b] = pair();
  (b.peers[0] as Peer & { session_token: string }).session_token = "must-not-leak";
  const result = await a.service.directory();
  expect(result.unreachable_hosts).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
  expect(result.peers.map(p => p.name)).toEqual(["alpha", "beta@beta"]);
  b.peers.splice(0);
  expect((await a.service.directory()).peers.map(p => p.name)).toEqual(["alpha"]);
  expect(a.service.remoteRoute(result.peers[1]!.id)?.host).toBe("beta");
  expect(a.db.query("SELECT count(*) AS n FROM peers").get()).toEqual({ n: 1 });
});

test("duplicate UID with changed content is rejected without a second insert", async () => {
  const [a, b] = pair();
  a.deps.sendLocal(request(a, "beta@beta"));
  await a.service.tick();
  const message = JSON.parse(outbox(a)[0]!.envelope) as FederationEnvelope;
  message.text = "different";
  const response = await b.service.handle(rawRelay(message));
  expect(await response!.json()).toMatchObject({ ok: false, code: "invalid" });
  expect(rows(b)).toHaveLength(1);
  message.target_host = "gamma";
  expect((await b.service.handle(rawRelay(message)))!.status).toBe(400);
});

test("rollback disables remote work without deleting queued mail or blocking local messages", async () => {
  const [a, b] = pair();
  a.deps.sendLocal(request(a, "beta@beta"));
  a.config.enabled = false;
  await a.service.tick();
  expect(networkCalls).toBe(0);
  expect(a.deps.sendLocal(request(a, "beta@beta")).ok).toBe(false);
  expect((await a.service.send(request(a, "alpha"))).ok).toBe(true);
  expect((await a.service.directory()).unreachable_hosts).toEqual([]);
  expect(a.service.status().pending).toBe(1);
  a.config.enabled = true;
  await a.service.tick();
  expect(rows(b)).toHaveLength(1);
});

test("bounded worker retries with a capped delay and coalesces concurrent ticks", async () => {
  const [a, b] = pair();
  b.offline = true;
  for (let n = 0; n < 35; n++) a.deps.sendLocal(request(a, "beta@beta"));
  const one = a.service.tick();
  expect(a.service.tick()).toBe(one);
  await one;
  expect(networkCalls).toBe(32);
  expect(outbox(a).filter(r => r.attempts === 1)).toHaveLength(32);
  for (let n = 0; n < 10; n++) { clock += 100; await a.service.tick(); }
  expect(outbox(a).every(r => r.next_attempt <= clock + 80)).toBe(true);
  expect(a.service.status().pending).toBe(35);
});

test("real loopback HTTP relay times out, then recovers without port 7900 or real secrets", async () => {
  const a = makeMachine("alpha", [peer("alpha")], globalThis.fetch);
  const b = makeMachine("beta", [peer("beta")], globalThis.fetch);
  delete a.config.hosts.gamma;
  delete b.config.hosts.gamma;
  let delay = true;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
    if (delay) await new Promise(resolve => setTimeout(resolve, 120));
    return await b.service.handle(req) ?? new Response(null, { status: 404 });
  } });
  servers.push(server);
  expect(server.port).not.toBe(7900);
  a.config.hosts.beta = `http://127.0.0.1:${server.port}`;
  a.config.relayTimeoutMs = 25;
  a.deps.sendLocal(request(a, "beta@beta"));
  await a.service.tick();
  expect(a.service.status().pending).toBe(1);
  delay = false;
  a.config.relayTimeoutMs = 500;
  clock += 10;
  await a.service.tick();
  expect(a.service.status().delivered).toBe(1);
  expect(rows(b)).toHaveLength(1);
});

test("config is opt-in, validates private auth separation and accepts loopback fixtures only over HTTP", () => {
  expect(loadFederationConfig({ HOME: "/does-not-exist" })).toBeNull();
  const [a] = pair();
  expect(() => validateFederationConfig({ ...a.config, secretPath: a.config.localSecretPath })).toThrow("separate");
  expect(() => validateFederationConfig({ ...a.config, hosts: { beta: "http://public.example" } })).toThrow();
  expect(() => validateFederationConfig({ ...a.config, hosts: { beta: "https://user:password@example.test" } })).toThrow();
  expect(() => validateFederationConfig({ ...a.config, hosts: { beta: "http://127.0.0.1:17991" } })).not.toThrow();
});

test("remote chat lookup qualifies addresses and refuses old brokers, bad answers and unknown hosts", async () => {
  const [a, b] = pair();
  // Without listLocalChats the endpoint 404s, exactly like a broker that predates it.
  expect(await a.service.chats("beta", { peer: "ezra-hermes" })).toEqual({
    ok: false, error: "can't list chats on beta: its broker is too old to list chats remotely" });
  let seen: unknown = null;
  b.deps.listLocalChats = (peer, req) => {
    seen = { peer, ...req };
    return peer === "ezra-hermes"
      ? { ok: true, peer: "ezra-hermes", chats: [{ chat_key: "20261027_121754_6f5fff",
        title: "Plan drum practice before leaving", busy: true, address: "ezra-hermes/20261027_121754_6f5fff" }] }
      : { ok: false, error: `unknown peer: ${peer}`, candidates: ["ezra-hermes"] };
  };
  expect(await a.service.chats("BETA", { peer: "ezra-hermes", query: "drum", limit: 5, offset: 0 })).toEqual({
    ok: true, peer: "ezra-hermes@beta", chats: [{ chat_key: "20261027_121754_6f5fff",
      title: "Plan drum practice before leaving", busy: true, address: "ezra-hermes@beta/20261027_121754_6f5fff" }] });
  expect(seen).toEqual({ peer: "ezra-hermes", query: "drum", limit: 5, offset: 0 });
  expect(await a.service.chats("beta", { peer: "ezra" })).toEqual({
    ok: false, error: "unknown peer: ezra (on beta)", candidates: ["ezra-hermes@beta"] });
  // A malformed answer is refused rather than passed on to the model.
  b.deps.listLocalChats = () => ({ ok: true, peer: "ezra-hermes", chats: [{ chat_key: 42 }] }) as never;
  expect((await a.service.chats("beta", { peer: "ezra-hermes" })).error).toBe("invalid chat list from beta");
  // The endpoint is behind the fleet secret like every federation route.
  const forged = await b.service.handle(new Request("http://127.0.0.1/federation/chats?peer=ezra-hermes", {
    headers: { [FEDERATION_SECRET_HEADER]: LOCAL_SECRET, [FEDERATION_HOST_HEADER]: "alpha" } }));
  expect(forged!.status).toBe(401);
  // Unknown or local hosts never reach the network.
  const calls = networkCalls;
  expect((await a.service.chats("gamma", { peer: "x" })).error).toBe('unknown remote machine "gamma"');
  expect((await a.service.chats("alpha", { peer: "x" })).error).toBe('unknown remote machine "alpha"');
  expect(networkCalls).toBe(calls);
  writeFileSync(b.config.secretPath, "a-different-fleet-secret-never-real", { mode: 0o600 });
  expect((await a.service.chats("beta", { peer: "ezra-hermes" })).error)
    .toBe("can't list chats on beta: it refused this machine's federation credentials");
  b.offline = true;
  expect((await a.service.chats("beta", { peer: "ezra-hermes" })).error).toBe("can't list chats on beta: it is unreachable right now");
});

test("remote chat lookup names each HTTP failure and checks input before sending", async () => {
  const [a, b] = pair();
  let seen = null as Record<string, unknown> | null;
  b.deps.listLocalChats = (peer, req) => { seen = { peer, ...req }; return { ok: true, peer, chats: [] }; };
  // Trimmed peer and query; null and non-finite values mean "not given", never the text "null".
  await a.service.chats("beta", { peer: "  ezra-hermes ", query: "  drum  ", limit: Number.NaN, offset: 2 });
  expect(seen).toEqual({ peer: "ezra-hermes", query: "drum", limit: undefined, offset: 2 });
  await a.service.chats("beta", { peer: "ezra-hermes", query: null as never, limit: null as never });
  expect(seen).toEqual({ peer: "ezra-hermes", query: undefined, limit: undefined, offset: undefined });
  // What the other side would refuse is refused here, without a network call.
  const calls = networkCalls;
  expect((await a.service.chats("beta", { peer: "ezra-hermes", query: "x".repeat(4097) })).error)
    .toBe("query is too long (at most 4096 characters)");
  expect((await a.service.chats("beta", { peer: "x".repeat(201) })).error)
    .toBe("list_chats needs a peer name of at most 200 characters");
  expect((await a.service.chats("beta", { peer: "   " })).error)
    .toBe("list_chats needs a peer name of at most 200 characters");
  expect(networkCalls).toBe(calls);
  // A remote failure inside the lookup is a 503 with its reason, not "unreachable".
  b.deps.listLocalChats = () => { throw new Error("state.db locked"); };
  expect((await a.service.chats("beta", { peer: "ezra-hermes" })).error)
    .toBe("can't list chats on beta: error on beta (HTTP 503: chat lookup temporarily unavailable)");
  // Other statuses, answered by a stand-in for beta.
  for (const [response, expected] of [
    [Response.json({ error: "invalid chat query" }, { status: 400 }), "bad request: invalid chat query"],
    [new Response("gateway down", { status: 502 }), "error on beta (HTTP 502)"],
    [new Response(null, { status: 403 }), "beta answered HTTP 403"],
  ] as const) {
    const custom = new FederationService({ ...a.deps, fetch: (async () => response) as unknown as typeof fetch });
    expect((await custom.chats("beta", { peer: "ezra-hermes" })).error).toBe(`can't list chats on beta: ${expected}`);
    await custom.stop();
  }
});

// bd-b2in.17 (Marco AP10809 #4). Mixed-version brokers during the openclaw
// rollout: a new broker accepts an openclaw sender, and an old broker's
// refusal (its PEER_TYPES lacks "openclaw", so envelopeFrom returns null and
// it answers HTTP 400) reaches the sender as an explicit bounce, not an
// endless "queued" retry.
test("a broker that knows openclaw accepts mail from an openclaw sender", async () => {
  const a = makeMachine("alpha", [peer("openclaw-hetzner", "openclaw")]);
  const b = makeMachine("beta");
  delete a.config.hosts.gamma; delete b.config.hosts.gamma;
  expect(a.deps.sendLocal(request(a, "beta@beta"))).toMatchObject({ ok: true });
  await a.service.tick();
  expect(a.service.status()).toEqual({ pending: 0, delivered: 1, bounced: 0 });
  expect(b.service.senderForMessage(rows(b)[0]!.id)).toMatchObject({ from_name: "openclaw-hetzner@alpha", from_peer_type: "openclaw" });
});

test("an older broker's refusal of an openclaw sender is an explicit bounce to that sender", async () => {
  const OLD_TYPES = ["claude", "codex", "hermes", "droid"];
  const oldBroker = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = url instanceof Request ? new Request(url, init) : new Request(String(url), init);
    if (new URL(req.url).pathname === "/federation/relay") {
      const body = await req.clone().json() as { sender?: { peer_type?: string } };
      if (!OLD_TYPES.includes(body.sender?.peer_type ?? "")) {
        return Response.json({ error: "invalid federation envelope" }, { status: 400 });
      }
    }
    return fakeFetch(req);
  }) as typeof fetch;
  const a = makeMachine("alpha", [peer("openclaw-hetzner", "openclaw")], oldBroker);
  const b = makeMachine("beta");
  delete a.config.hosts.gamma; delete b.config.hosts.gamma;
  expect(a.deps.sendLocal(request(a, "beta@beta"))).toMatchObject({ ok: true, notice: expect.stringContaining("queued") });
  await a.service.tick();
  expect(a.service.status()).toEqual({ pending: 0, delivered: 0, bounced: 1 });
  expect(rows(b)).toHaveLength(0);
  const notice = rows(a).find((m) => m.to_id === a.peers[0]!.id)!;
  expect(notice.text).toContain("Delivery failed to beta@beta");
  expect(notice.text).toContain("HTTP 400: invalid federation envelope");
  expect(notice.text).toContain('"openclaw" peer type');
  expect(notice.text).toContain("Nothing was delivered");
  expect(outbox(a)[0]).toMatchObject({ status: "bounced" });
  // Retrying is pointless: no further network attempt after the bounce.
  const calls = networkCalls;
  clock += 10_000;
  await a.service.tick();
  expect(networkCalls).toBe(calls);
});

test("a 400 for an unreadable payload (slow or cut upload) stays on the retry path", async () => {
  let refusals = 1;
  const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = url instanceof Request ? new Request(url, init) : new Request(String(url), init);
    if (new URL(req.url).pathname === "/federation/relay" && refusals > 0) {
      refusals -= 1;
      return Response.json({ error: "invalid federation payload" }, { status: 400 });
    }
    return fakeFetch(req);
  }) as typeof fetch;
  const a = makeMachine("alpha", [peer("codex-a", "codex")], flaky);
  const b = makeMachine("beta");
  delete a.config.hosts.gamma; delete b.config.hosts.gamma;
  expect(a.deps.sendLocal(request(a, "beta@beta"))).toMatchObject({ ok: true });
  await a.service.tick();
  expect(a.service.status()).toEqual({ pending: 1, delivered: 0, bounced: 0 });
  expect(rows(a).filter((m) => m.to_id === a.peers[0]!.id)).toHaveLength(0); // no failure notice
  clock += 60_000;
  await a.service.tick();
  expect(a.service.status()).toEqual({ pending: 0, delivered: 1, bounced: 0 });
  expect(rows(b)).toHaveLength(1);
});
