// End to end: two real broker processes federate over loopback HTTP, each with
// its own home, local secret and database. Covers name@host delivery, replies
// to the exact sender, bare-name discovery, machine-scope listing, remote chat
// lookup, an outage with queued mail, and rollback (federation off keeps
// relayed sender names).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { createClient, expectedDbIdentityHash, SECRET_HEADER } from "../shared/broker-client.ts";
import { readSharedSecret } from "../shared/shared-secret.ts";

const BROKER = join(import.meta.dir, "..", "broker.ts");
const root = mkdtempSync(join(tmpdir(), "fed-int-"));
type Host = "alpha" | "beta";
const PORTS: Record<Host, number> = { alpha: 0, beta: 0 };
const FED_SECRET = "f".repeat(16) + "e".repeat(16) + "d".repeat(16);
const procs: Partial<Record<Host, ReturnType<typeof Bun.spawn>>> = {};

async function allocatePorts() {
  // Concurrent worktrees run this suite too. Hold both ephemeral ports until
  // allocated so they are distinct; authenticated readiness catches bind races.
  const reservations = await Promise.all((["alpha", "beta"] as const).map(async host => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener port");
    PORTS[host] = address.port;
    return server;
  }));
  await Promise.all(reservations.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
}

function home(host: Host) { return join(root, host); }
function setupHome(host: Host) {
  const h = home(host);
  mkdirSync(h, { recursive: true, mode: 0o700 });
  writeFileSync(join(h, ".agent-peers-host"), `${host}\n`);
  writeFileSync(join(h, ".agent-peers-fleet.json"), JSON.stringify({
    alpha: `http://127.0.0.1:${PORTS.alpha}`, beta: `http://127.0.0.1:${PORTS.beta}`,
  }));
  writeFileSync(join(h, ".agent-peers-federation-secret"), FED_SECRET, { mode: 0o600 });
  if (host === "beta") fakeHermes(h);
}

// Ezra's Hermes chats on beta, read by beta's real chat directory
// (profiles/<profile>/state.db). Newest first: taxes, then the two drum chats.
const DRUMS = "20261027_121754_6f5fff";
const HEADS = "20261027_110952_70140e";
const TAXES = "20261030_090000_cccccc";
function fakeHermes(h: string) {
  const dir = join(h, ".hermes", "profiles", "ezra");
  mkdirSync(dir, { recursive: true });
  const st = new Database(join(dir, "state.db"));
  st.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, last_activity_at REAL, end_reason TEXT, archived INTEGER NOT NULL DEFAULT 0, model_config TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);`);
  const add = st.query("INSERT INTO sessions (id, source, title, started_at) VALUES (?, 'desktop', ?, ?)");
  add.run(HEADS, "Plan drum heads and Gurdjieff study site", 1_000);
  add.run(DRUMS, "Plan drum practice before leaving", 2_000);
  add.run(TAXES, "Quarterly taxes", 3_000);
  st.close();
}

async function start(host: Host, federation = true) {
  const h = home(host);
  const child = Bun.spawn([process.execPath, BROKER], {
    stdout: "ignore", stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "", HOME: h,
      AGENT_PEERS_PORT: String(PORTS[host]),
      AGENT_PEERS_DB: join(h, "peers.db"),
      AGENT_PEERS_SECRET_PATH: join(h, "secret"),
      HERMES_HOME: join(h, ".hermes"),
      ...(federation ? { AGENT_PEERS_FEDERATION: "1" } : {}),
    },
  });
  procs[host] = child;
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (child.exitCode !== null) {
      throw new Error(`${host} broker exited ${child.exitCode}: ${await new Response(child.stderr).text()}`);
    }
    const secret = readSharedSecret(join(h, "secret"));
    try {
      if (secret) {
        const response = await fetch(`http://127.0.0.1:${PORTS[host]}/ready`, {
          headers: { [SECRET_HEADER]: secret }, signal: AbortSignal.timeout(500),
        });
        const body = await response.json() as { ok?: boolean; protocol?: number; db_id?: string };
        if (response.ok && body.ok && body.protocol === 1
          && body.db_id === expectedDbIdentityHash(join(h, "peers.db"))) return;
      }
    } catch { /* starting */ }
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
let ezra: { id: string; session_token: string };

beforeAll(async () => {
  await allocatePorts();
  setupHome("alpha");
  setupHome("beta");
  await start("alpha");
  await start("beta");
  vector = await reg("alpha", "vector-claude");
  kepler = await reg("beta", "kepler-claude");
  ezra = await api("beta").register({ peer_type: "hermes", name: "ezra-hermes", pid: process.pid, cwd: "/w/beta",
    git_root: null, tty: null, summary: "", durable: true, capabilities: ["chat-mail"] });
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
  const localOnly = await api("alpha").listPeers({ scope: "machine", cwd: "/w/alpha", git_root: null, exclude_id: vector.id, local_only: true });
  expect(localOnly.map((p) => p.name)).not.toContain("kepler-claude@beta");
});

test("list_chats finds a Hermes chat on another machine, read-only, and its address reaches that chat", async () => {
  const me = { id: vector.id, session_token: vector.session_token };
  const found = await api("alpha").listChats({ ...me, peer: "ezra-hermes@beta", query: "drum" });
  expect(found).toMatchObject({ ok: true, peer: "ezra-hermes@beta" });
  expect(found!.chats!.map((c) => [c.title, c.address])).toEqual([
    ["Plan drum practice before leaving", `ezra-hermes@beta/${DRUMS}`],
    ["Plan drum heads and Gurdjieff study site", `ezra-hermes@beta/${HEADS}`],
  ]);
  // Paging runs on the remote machine, newest first.
  const page = await api("alpha").listChats({ ...me, peer: "ezra-hermes@beta", limit: 1, offset: 1 });
  expect(page!.chats!.map((c) => c.chat_key)).toEqual([DRUMS]);
  // A bare name unknown on alpha is looked up on beta, as send_message does.
  const bare = await api("alpha").listChats({ ...me, peer: "ezra", query: "practice" });
  expect(bare).toMatchObject({ ok: true, peer: "ezra-hermes@beta" });
  expect(bare!.chats!.map((c) => c.address)).toEqual([`ezra-hermes@beta/${DRUMS}`]);
  // Listing stored and consumed nothing on beta.
  expect(await api("beta").pollMessages({ ...ezra, chat: DRUMS })).toEqual([]);

  // The listed address is a working send target for exactly that chat.
  expect((await api("alpha").sendMessage({ from_id: vector.id, session_token: vector.session_token,
    to_id_or_name: found!.chats![0]!.address, text: "about the drums" })).ok).toBe(true);
  const [m] = await until(async () => {
    const got = await api("beta").pollMessages({ ...ezra, chat: DRUMS });
    return got.length ? got : null;
  });
  expect(m!.text).toBe("about the drums");
  expect(m!.from_name).toBe("vector-claude@alpha");
  expect(await api("beta").pollMessages({ ...ezra, chat: HEADS })).toEqual([]);
  await api("beta").ackMessages({ ...ezra, lease_tokens: [m!.lease_token] });
}, 30000);

test("remote list_chats errors are clear, and the endpoint needs the fleet secret", async () => {
  const me = { id: vector.id, session_token: vector.session_token };
  expect((await api("alpha").listChats({ ...me, peer: "kepler-claude@beta" }))!.error)
    .toBe("kepler-claude is a claude peer; only Hermes agents have chats (on beta)");
  expect((await api("alpha").listChats({ ...me, peer: "nobody-hermes@beta" }))!.error).toContain("unknown peer");
  expect((await api("alpha").listChats({ ...me, peer: "ezra-hermes@gamma" }))!.error).toBe('unknown remote machine "gamma"');
  expect((await api("alpha").listChats({ ...me, peer: "@beta" }))!.error).toBe("list_chats needs a peer name");
  expect((await api("alpha").listChats({ id: vector.id, session_token: "wrong", peer: "ezra-hermes@beta" }))!.error)
    .toBe("unauthorized or stale caller");
  const url = `http://127.0.0.1:${PORTS.beta}/federation/chats?peer=ezra-hermes`;
  // Beta's own local secret is not the fleet secret.
  const local = await fetch(url, { headers: { [SECRET_HEADER]: readSharedSecret(join(home("beta"), "secret"))!,
    "x-agent-peers-federation-host": "alpha" } });
  expect(local.status).toBe(401);
  const ok = await fetch(url, { headers: { "x-agent-peers-federation-secret": FED_SECRET,
    "x-agent-peers-federation-host": "alpha" } });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { chats: unknown[] }).chats).toHaveLength(3);
});

test("an outage queues mail, reports the host, and delivers once on recovery", async () => {
  await stop("beta");
  const res = await fetch(`http://127.0.0.1:${PORTS.alpha}/list-peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [SECRET_HEADER]: readSharedSecret(join(home("alpha"), "secret"))! },
    body: JSON.stringify({ scope: "machine", cwd: "/w/alpha", git_root: null }),
  });
  expect(res.headers.get("x-agent-peers-unreachable-hosts")).toBe("beta");
  // A chat lookup on the down machine fails fast and says why.
  const t0 = Date.now();
  expect((await api("alpha").listChats({ id: vector.id, session_token: vector.session_token, peer: "ezra-hermes@beta" }))!.error)
    .toBe("can't list chats on beta: it is unreachable right now");
  expect((await api("alpha").listChats({ id: vector.id, session_token: vector.session_token, peer: "ezra" }))!.error)
    .toBe("unknown peer: ezra (not checked: beta unreachable)");
  expect(Date.now() - t0).toBeLessThan(5000);
  // Launch-time name suggestion never waits on a down host.
  const t = Date.now();
  await api("alpha").listPeers({ scope: "machine", cwd: "/w/alpha", git_root: null, local_only: true });
  expect(Date.now() - t).toBeLessThan(500);
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
  // With federation off, chat lookup stays local and says so.
  expect((await api("alpha").listChats({ id: vector.id, session_token: vector.session_token, peer: "ezra-hermes@beta" }))!.error)
    .toContain("federation");
  expect((await api("alpha").listChats({ id: vector.id, session_token: vector.session_token, peer: "ezra" }))!.error)
    .toBe("unknown peer: ezra");
}, 90000);

test("SIGTERM aborts an active relay before closing the DB and pending mail recovers", async () => {
  await stop("alpha");
  await start("alpha"); // Re-enable after the preceding rollback test.
  await stop("beta");
  let admitted = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const slow = Bun.serve({ hostname: "127.0.0.1", port: PORTS.beta, fetch: async req => {
    if (new URL(req.url).pathname === "/federation/relay") {
      await req.text();
      admitted = true;
      await held;
    }
    return Response.json({ error: "synthetic unavailable relay" }, { status: 503 });
  } });
  const text = "survives shutdown during active relay";
  try {
    await api("alpha").heartbeat({ id: vector.id, session_token: vector.session_token });
    const sent = await api("alpha").sendMessage({ from_id: vector.id, session_token: vector.session_token,
      to_id_or_name: "kepler-claude@beta", text });
    expect(sent.ok).toBe(true);
    await until(async () => admitted, 5000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      // Less than the normal 2 s relay timeout: shutdown must actively abort it.
      await Promise.race([stop("alpha"), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("in-flight relay was not aborted on shutdown")), 1500);
      })]);
    } finally { if (deadline) clearTimeout(deadline); }
    const db = new Database(join(home("alpha"), "peers.db"), { readonly: true });
    try {
      expect(db.query("SELECT status FROM federation_outbox WHERE id=?").get(-sent.message_id!))
        .toEqual({ status: "pending" });
    } finally { db.close(); }
  } finally {
    release();
    slow.stop(true);
  }
  await start("beta");
  await start("alpha");
  const mail = await until(async () => {
    const messages = await api("beta").pollMessages({ id: kepler.id, session_token: kepler.session_token });
    return messages.find(message => message.text === text) ?? null;
  });
  expect(mail.from_id).toBe(vector.id);
}, 30000);
