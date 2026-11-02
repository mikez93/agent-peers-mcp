// Real broker exports, not the transport suite's simplified fake route model.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  initDb, registerPeer, renamePeer, configureAddressing, sendMessage, pollMessages,
  listDirectoryPeers, snapshotSender, deliverRelayed, deliverNotice, listChatsFor, listChatsRouted,
} from "../broker.ts";
import { FederationService, type FederationDeps } from "../shared/federation.ts";
import type { ChatDirectory } from "../shared/chat-directory.ts";
import type { RegisterRequest, RegisterResponse } from "../shared/types.ts";

interface Machine {
  root: string;
  db: Database;
  service: FederationService;
  deps: FederationDeps;
  title: string;
  host: string;
}
const machines: Machine[] = [];
const network = new Map<string, Machine>();
afterEach(async () => {
  configureAddressing({});
  for (const m of machines) { await m.service.stop(); m.db.close(); }
  await Promise.all(machines.splice(0).map(m => rm(m.root, { recursive: true, force: true })));
  network.clear();
});
function bind(m: Machine) {
  const chats: ChatDirectory = {
    resolve(_peer, query) {
      return query === "stable/email-chat" || query.toLowerCase() === m.title.toLowerCase()
        ? { ok: true, chat_key: "stable/email-chat", title: m.title }
        : { ok: false, error: "unknown chat", candidates: [] };
    },
    list: () => [{ chat_key: "stable/email-chat", title: m.title, last_active: null }],
  };
  configureAddressing({ chats, remote: m.service.enqueue, remoteRoute: m.service.remoteRoute,
    senderForMessage: m.service.senderForMessage, isLocalHost: host => host === m.host });
}
function makeMachine(host: string): Machine {
  const root = mkdtempSync(join(tmpdir(), `ap-federation-broker-${host}-`));
  const db = initDb(join(root, "broker.db"));
  const secretPath = join(root, "fleet-secret");
  const localSecretPath = join(root, "local-secret");
  writeFileSync(secretPath, "test-real-broker-fleet-secret-not-real", { mode: 0o600 });
  writeFileSync(localSecretPath, "test-real-broker-local-secret-not-real", { mode: 0o600 });
  const machine = { root, db, host, title: "Email" } as Machine;
  const deps: FederationDeps = {
    db, config: { enabled: true, host, hosts: { alpha: "https://alpha.test", beta: "https://beta.test" },
      secretPath, localSecretPath, retryBaseMs: 1 },
    listLocalPeers: req => listDirectoryPeers(db, req),
    listLocalChats: (peer, req) => { bind(machine); return listChatsFor(db, peer, req); },
    sendLocal: req => { bind(machine); return sendMessage(db, req); },
    snapshotSender: req => { bind(machine); return snapshotSender(db, req); },
    deliverLocal: msg => { bind(machine); return deliverRelayed(db, msg); },
    deliverNotice: msg => deliverNotice(db, msg),
    fetch: (async (url: string | Request | URL, init?: RequestInit) => {
      const request = url instanceof Request ? new Request(url, init) : new Request(String(url), init);
      const target = network.get(new URL(request.url).hostname.split(".")[0]!)!;
      return await target.service.handle(request) ?? new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  machine.deps = deps;
  machine.service = new FederationService(deps);
  machines.push(machine);
  network.set(host, machine);
  return machine;
}
function register(m: Machine, name: string, extras: Partial<RegisterRequest> = {}) {
  return registerPeer(m.db, { name, peer_type: "claude", pid: process.pid,
    cwd: "/synthetic-test-repo", git_root: null, tty: null, summary: "", durable: true, ...extras });
}
function send(m: Machine, from: RegisterResponse, to: string, from_chat?: string) {
  return m.deps.sendLocal({ from_id: from.id, session_token: from.session_token,
    to_id_or_name: to, text: "federation real hook test", from_chat });
}
function poll(m: Machine, who: RegisterResponse, chat?: string) {
  bind(m);
  return pollMessages(m.db, who.id, who.session_token, undefined, chat);
}

test("real remote directory hides stale peers without breaking named durable delivery", async () => {
  const a = makeMachine("alpha"), b = makeMachine("beta");
  const from = register(a, "author");
  register(b, "live-peer", { durable: false });
  const durable = register(b, "valentina-hermes", { peer_type: "hermes", summary: "Waiting" });
  const ephemeral = register(b, "stale-peer", { durable: false });
  b.db.run("UPDATE peers SET last_seen = '2000-01-01T00:00:00.000Z' WHERE id IN (?, ?)", [durable.id, ephemeral.id]);

  for (const query of [undefined, "   "]) {
    const directory = await a.service.directory(query);
    expect(directory.unreachable_hosts).toEqual([]);
    expect(directory.peers.filter(p => p.host === "beta").map(p => p.name)).toEqual(["live-peer@beta"]);
  }
  const named = await a.service.directory("valentina-hermes");
  expect(named.peers).toMatchObject([{ name: "valentina-hermes@beta", summary: "Valentina: Waiting" }]);
  // Bare names resolve through the queried directory; qualified sends validate
  // the exact durable name at the destination. Neither needs a live session.
  for (const target of ["valentina-hermes", "valentina-hermes@beta"]) {
    expect((await a.service.send({ from_id: from.id, session_token: from.session_token,
      to_id_or_name: target, text: "offline durable delivery" })).ok).toBe(true);
  }
  await a.service.tick();
  expect(a.service.status().delivered).toBe(2);
  expect(a.service.status().bounced).toBe(0);
  expect(b.db.query("SELECT to_id, acked FROM messages ORDER BY id").all()).toEqual([
    { to_id: durable.id, acked: 0 }, { to_id: durable.id, acked: 0 },
  ]);
  expect(b.db.query("SELECT last_seen FROM peers WHERE id = ?").get(durable.id))
    .toEqual({ last_seen: "2000-01-01T00:00:00.000Z" });
});

test("real remote chat discovery still resolves an offline durable owner by bare and qualified name", async () => {
  const a = makeMachine("alpha"), b = makeMachine("beta");
  const from = register(a, "author");
  const owner = register(b, "valentina-hermes", { peer_type: "hermes", capabilities: ["chat-mail"] });
  b.db.run("UPDATE peers SET last_seen = '2000-01-01T00:00:00.000Z' WHERE id = ?", [owner.id]);
  expect((await a.service.directory()).peers.filter(p => p.host === "beta")).toEqual([]);
  for (const peer of ["valentina-hermes", "valentina-hermes@beta"]) {
    bind(a);
    const result = await listChatsRouted(a.db, { id: from.id, session_token: from.session_token, peer },
      { service: a.service, config: a.deps.config });
    expect(result).toMatchObject({ ok: true, peer: "valentina-hermes@beta",
      chats: [{ title: "Email", address: "valentina-hermes@beta/stable/email-chat" }] });
  }
  expect(b.db.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
});

test("real old-adapter chat fallback returns a durable warning, exactly once across notice-write recovery", async () => {
  const a = makeMachine("alpha"), b = makeMachine("beta");
  const from = register(a, "author");
  const oldHermes = register(b, "valentina-hermes", { peer_type: "hermes" }); // No chat-mail capability.
  expect(send(a, from, "valentina-hermes@beta/Email").ok).toBe(true);
  const original = a.deps.deliverNotice;
  a.deps.deliverNotice = msg => { original(msg); throw new Error("crash before origin completion commit"); };
  await a.service.tick();
  expect(a.service.status().pending).toBe(1);
  expect(a.db.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 0 });
  expect(b.db.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
  a.deps.deliverNotice = original;
  a.db.run("UPDATE federation_outbox SET next_attempt = 0");
  await a.service.tick();
  expect(a.service.status().delivered).toBe(1);
  const warnings = poll(a, from);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]!.from_name).toBe("agent-peers@beta");
  expect(warnings[0]!.text).toContain("general mailbox");
  expect(warnings[0]!.text).toContain('not to "Email"');
  const received = poll(b, oldHermes);
  expect(received).toHaveLength(1);
  expect(b.db.query("SELECT to_chat, acked FROM messages").get()).toEqual({ to_chat: null, acked: 0 });
  await a.service.tick();
  expect(a.db.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 });
});

test("real chat UUID reply survives peer rename, title rename and federation service restart", async () => {
  const a = makeMachine("alpha"), b = makeMachine("beta");
  const from = register(a, "valentina-hermes", { peer_type: "hermes", capabilities: ["chat-mail"] });
  const other = register(b, "marco");
  expect(send(a, from, "marco@beta", "Email").ok).toBe(true);
  await a.service.tick();
  const received = poll(b, other);
  expect(received).toHaveLength(1);
  const replyId = received[0]!.from_id;
  expect(received[0]!.from_name).toBe("valentina-hermes@alpha/stable/email-chat");
  a.title = "Inbox";
  expect(renamePeer(a.db, { id: from.id, session_token: from.session_token, new_name: "valentina-renamed" }).ok).toBe(true);
  for (const m of [a, b]) { await m.service.stop(); m.service = new FederationService(m.deps); }
  expect(send(b, other, replyId).ok).toBe(true);
  await b.service.tick();
  expect(b.service.status().bounced).toBe(0);
  const replies = poll(a, from, "Inbox");
  expect(replies).toHaveLength(1);
  expect(replies[0]!.to_chat).toBe("stable/email-chat");
});

test("an unresolved sending chat warns immediately instead of pretending replies are chat-scoped", () => {
  const a = makeMachine("alpha"), b = makeMachine("beta");
  const from = register(a, "valentina-hermes", { peer_type: "hermes", capabilities: ["chat-mail"] });
  register(b, "marco");
  const result = send(a, from, "marco@beta", "missing chat");
  expect(result.ok).toBe(true);
  expect(result.notice).toContain("sending chat could not be resolved");
  expect(result.notice).toContain("general mailbox");
});
