import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { initDb, listPeers, pollMessages, registerPeer, sendMessage } from "../broker.ts";
import { HermesConversationBroker, installHermesConversationBrokerSchema } from "../shared/hermes-conversation-broker.ts";
import { HermesConversationAdapter } from "../shared/hermes-conversation-adapter.ts";
import { HermesConversationLifecyclePort, installHermesLifecyclePortSchema } from "../shared/hermes-conversation-lifecycle-port.ts";
import type { LifecycleObservation } from "../shared/hermes-conversation-lifecycle.ts";
import { CodexInboxStore } from "../shared/codex-inbox.ts";

const home = "/fixture/home", backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721", adapterId = "adapter-one";
const dbs: Database[] = [], roots: string[] = [], adapters: HermesConversationAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(a => a.stop()));
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  setSystemTime();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(onTick?: () => void) {
  let clock = Date.now(); setSystemTime(clock);
  const root = await mkdtemp(join(tmpdir(), "hermes-lifecycle-port-")); roots.push(root);
  const db = initDb(join(root, "broker.db")); dbs.push(db);
  installHermesConversationBrokerSchema(db); installHermesLifecyclePortSchema(db);
  const observations = new Map<string, LifecycleObservation>();
  const broker = new HermesConversationBroker(db, { profile: "fixture-hermes", adapter_id: adapterId,
    cwd: "/fixture", git_root: null, pid: process.pid, inboxRoot: join(root, "inboxes"),
    evidence: context => {
      const row = observations.get(context.conversation_id);
      if (!row || row.state !== "live" || row.context.session_id !== context.session_id) throw new Error("host_not_live");
      return { context, adapter_id: adapterId, lifecycle_generation: row.lifecycle_generation, observed_at: clock };
    },
    releaseEvidence: () => { throw new Error("no double terminal release"); },
  });
  const adapter = new HermesConversationAdapter({ home, backend_id: backend, inboxRoot: join(root, "inboxes"), broker, onTick });
  adapters.push(adapter);
  const lifecycle = () => new HermesConversationLifecyclePort(db, broker, adapter, { home, backend_id: backend, adapter_id: adapterId });
  const meta = (id: string) => Object.fromEntries(Object.entries(observations.get(id)!.context).map(([key, value]) => [`hermes/${key}`, value]));
  const call = (id: string, name = "check_messages", args = {}) => adapter.call({ name, arguments: args, _meta: meta(id) });
  const seed = async (id: string) => {
    observations.set(id, { context: { home, backend_id: backend, conversation_id: id, session_id: id, platform: "desktop" },
      lifecycle_generation: 1, state: "live", end_reason: null });
    await call(id, "set_summary", { summary: `status-${id}` });
    const owner = await broker.bind(observations.get(id)!.context);
    db.query("INSERT INTO hermes_lifecycle_sequences VALUES (?,?)").run(owner.peer_id, backend);
    return owner;
  };
  const advance = (ms: number) => { clock += ms; setSystemTime(clock); };
  const reconcile = (...ids: string[]) => lifecycle().reconcile({ home, backend_id: backend,
    observed_at: clock, inventory_complete: true, observations: ids.map(id => observations.get(id)!) });
  const state = (id: string, value: "live" | "closed" | "reaped") => {
    const old = observations.get(id)!;
    observations.set(id, { ...old, lifecycle_generation: old.lifecycle_generation + 1, state: value,
      end_reason: value === "live" ? null : value === "closed" ? "explicit_close" : "automatic_reap" });
  };
  const sender = registerPeer(db, { peer_type: "claude", pid: process.pid, cwd: "/fixture", git_root: null, tty: null, summary: "" });
  const send = (to: string) => sendMessage(db, { from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: to, text: "PRIVATE_A" }).message_id!;
  const acked = (id: number) => db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?").get(id)!.acked;
  const visible = () => listPeers(db, { scope: "machine", cwd: "/fixture", git_root: null }).filter(p => p.peer_type === "hermes");
  return { db, root, broker, adapter, lifecycle, seed, call, meta, state, advance, reconcile, observations, send, acked, visible };
}

test("expiry recreates collected peer/token with the same UUID, preserving mail and fencing the old epoch", async () => {
  const f = await fixture(), a = await f.seed("a"), message = f.send(a.peer_id);
  expect(JSON.stringify(await f.call("a"))).toContain("PRIVATE_A");
  expect(f.acked(message)).toBe(0);
  f.advance(46_000); f.broker.bindings.expire();
  f.db.query("DELETE FROM peers WHERE id=?").run(a.peer_id);
  f.db.query("DELETE FROM hermes_conversation_tokens WHERE peer_id=?").run(a.peer_id);
  expect((await f.reconcile("a"))[0]!.result).toBe("renewed");
  const binding = f.broker.bindings.get(a.peer_id)!;
  expect(binding.generation).toBe(2);
  expect(f.visible().map(p => [p.id, p.summary])).toEqual([[a.peer_id, "status-a"]]);
  const fresh = await f.broker.bind(f.observations.get("a")!.context);
  expect(fresh.session_token).not.toBe(a.session_token);
  expect(() => pollMessages(f.db, a.peer_id, a.session_token, a)).toThrow("stale_conversation_owner");
  expect(f.acked(message)).toBe(0);
  expect(JSON.stringify(await f.call("a"))).toContain("PRIVATE_A");
  expect(f.acked(message)).toBe(0);
  await f.call("a");
  expect(f.acked(message)).toBe(1);
});

test("terminal fence commits before a blocked poll drains; resumed mail is re-offered, never acked by close", async () => {
  const f = await fixture(), a = await f.seed("a"), b = await f.seed("b"), message = f.send(a.peer_id);
  const entered = deferred(), release = deferred(), poll = f.broker.poll.bind(f.broker);
  f.broker.poll = async owner => {
    const messages = await poll(owner);
    if (owner.peer_id === a.peer_id) { entered.resolve(); await release.promise; }
    return messages;
  };
  const call = f.call("a").catch(error => error as Error);
  await entered.promise;
  f.advance(1); f.state("a", "closed");
  let drained = false;
  const close = f.reconcile("a").then(result => { drained = true; return result; });
  expect(f.broker.bindings.get(a.peer_id)!.state).toBe("closed");
  expect(f.visible().map(p => p.id)).toEqual([b.peer_id]);
  expect(f.db.query("SELECT 1 FROM hermes_conversation_tokens WHERE peer_id=?").get(a.peer_id)).toBeNull();
  expect(drained).toBe(false);
  expect(f.acked(message)).toBe(0);
  expect(() => f.call("a")).toThrow("conversation_closing");
  release.resolve();
  expect((await call as Error).message).toContain("conversation_closing");
  expect((await close)[0]!.result).toBe("released");
  expect(f.adapter.resources()).toMatchObject({ identities: 1, calls: 0, waiters: 0, pendingAcks: 0 });
  expect(f.acked(message)).toBe(0);
  const inbox = new CodexInboxStore({ peerId: a.peer_id, rootDir: join(f.root, "inboxes") });
  expect((await inbox.getUnreadMessages()).map(m => m.id)).toContain(message);
  f.broker.poll = poll;
  f.advance(1); f.state("a", "live");
  expect((await f.reconcile("a"))[0]!.result).toBe("renewed");
  expect(JSON.stringify(await f.call("a"))).toContain("PRIVATE_A");
  expect(f.acked(message)).toBe(0);
  await f.call("a");
  expect(f.acked(message)).toBe(1);
});

test("automatic reap wakes parked waiters into cancellation and drains the real adapter slot", async () => {
  const f = await fixture(), a = await f.seed("a"), entered = deferred(), poll = f.broker.poll.bind(f.broker);
  f.broker.poll = async owner => { const result = await poll(owner); entered.resolve(); return result; };
  const waiting = f.call("a", "wait_for_peer_messages", { timeout_ms: 60_000 }).catch(error => error as Error);
  await entered.promise;
  // Let the real adapter finish that empty poll and park its shared-scheduler waiter.
  for (let i = 0; i < 20 && !f.adapter.resources().waiters; i++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.adapter.resources().waiters).toBe(1);
  f.advance(1); f.state("a", "reaped");
  await f.reconcile("a");
  expect((await waiting as Error).message).toContain("conversation_closing");
  expect(f.broker.bindings.get(a.peer_id)!.state).toBe("reaped");
  expect(f.adapter.resources()).toEqual({ identities: 0, calls: 0, waiters: 0, timers: 0, pendingAcks: 0 });
});

test("a database failure rolls binding, visible peer and provenance back together", async () => {
  const f = await fixture(), a = await f.seed("a");
  const before = f.broker.bindings.get(a.peer_id);
  const token = f.db.query("SELECT * FROM hermes_conversation_tokens WHERE peer_id=?").get(a.peer_id);
  const provenance = f.db.query("SELECT * FROM hermes_lifecycle_sequences WHERE peer_id=?").get(a.peer_id);
  f.db.exec(`CREATE TRIGGER reject_provenance BEFORE UPDATE ON hermes_lifecycle_sequences
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  f.advance(1); f.state("a", "closed");
  expect((await f.reconcile("a"))[0]!.result).toBe("unavailable");
  expect(f.broker.bindings.get(a.peer_id)).toEqual(before);
  expect(f.visible().map(p => p.id)).toEqual([a.peer_id]);
  expect(f.db.query("SELECT * FROM hermes_conversation_tokens WHERE peer_id=?").get(a.peer_id)).toEqual(token);
  expect(f.db.query("SELECT * FROM hermes_lifecycle_sequences WHERE peer_id=?").get(a.peer_id)).toEqual(provenance);
  expect(f.adapter.resources().identities).toBe(1);
});

test("failed recovery rolls back newly recreated peer/token and leaves unread mail intact", async () => {
  const f = await fixture(), a = await f.seed("a"), message = f.send(a.peer_id);
  f.advance(46_000); f.broker.bindings.expire();
  f.db.query("DELETE FROM peers WHERE id=?").run(a.peer_id);
  f.db.query("DELETE FROM hermes_conversation_tokens WHERE peer_id=?").run(a.peer_id);
  const before = f.broker.bindings.get(a.peer_id);
  const provenance = f.db.query("SELECT * FROM hermes_lifecycle_sequences WHERE peer_id=?").get(a.peer_id);
  f.db.exec(`CREATE TRIGGER reject_recovery BEFORE UPDATE ON hermes_lifecycle_sequences
    BEGIN SELECT RAISE(ABORT, 'fixture recovery failure'); END`);
  expect((await f.reconcile("a"))[0]!.result).toBe("unavailable");
  expect(f.broker.bindings.get(a.peer_id)).toEqual(before);
  expect(f.visible()).toEqual([]);
  expect(f.db.query("SELECT * FROM hermes_conversation_tokens WHERE peer_id=?").get(a.peer_id)).toBeNull();
  expect(f.db.query("SELECT * FROM hermes_lifecycle_sequences WHERE peer_id=?").get(a.peer_id)).toEqual(provenance);
  expect(f.acked(message)).toBe(0);
});

test("binding epoch changed after inventory read cannot be released by a stale plan", async () => {
  const f = await fixture(), a = await f.seed("a");
  const get = f.broker.bindings.get.bind(f.broker.bindings);
  const spy = spyOn(f.broker.bindings, "get").mockImplementationOnce(id => {
    const row = get(id);
    f.db.query("UPDATE hermes_conversations SET generation=generation+1 WHERE peer_id=?").run(id);
    return row;
  });
  try {
    f.advance(1); f.state("a", "closed");
    expect((await f.reconcile("a"))[0]!.result).toBe("stale");
    expect(get(a.peer_id)!.state).toBe("active");
    expect(f.visible().map(p => p.id)).toEqual([a.peer_id]);
    expect(f.adapter.resources().identities).toBe(1);
  } finally { spy.mockRestore(); }
});

test("an old terminal drain cannot evict a resumed adapter epoch", async () => {
  const f = await fixture(), a = await f.seed("a");
  f.advance(46_000); f.broker.bindings.expire();
  await f.reconcile("a");
  await f.call("a");
  await f.adapter.drainFenced(f.meta("a"), a);
  expect(f.adapter.resources().identities).toBe(1);
  expect(f.broker.bindings.get(a.peer_id)!.generation).toBe(2);
  expect(JSON.stringify(await f.call("a"))).toContain("Checked inbox");
});

test("fresh resume during old-call drainage survives the old close completing", async () => {
  const f = await fixture(), a = await f.seed("a"), message = f.send(a.peer_id);
  const entered = deferred(), release = deferred(), poll = f.broker.poll.bind(f.broker);
  f.broker.poll = async owner => { const messages = await poll(owner); entered.resolve(); await release.promise; return messages; };
  const call = f.call("a").catch(error => error as Error);
  await entered.promise;
  f.advance(1); f.state("a", "closed");
  const close = f.reconcile("a");
  f.advance(1); f.state("a", "live");
  expect((await f.reconcile("a"))[0]!.result).toBe("renewed");
  expect(f.broker.bindings.get(a.peer_id)!.generation).toBe(2);
  release.resolve();
  await call; await close;
  expect(f.broker.bindings.get(a.peer_id)!.state).toBe("active");
  expect(f.visible().map(p => p.id)).toEqual([a.peer_id]);
  f.broker.poll = poll;
  expect(JSON.stringify(await f.call("a"))).toContain("PRIVATE_A");
  expect(f.acked(message)).toBe(0);
});

test("terminal local cleanup does not depend on a failing maintenance tick", async () => {
  let ticks = 0;
  const f = await fixture(() => { ticks++; throw new Error("maintenance_unavailable"); });
  const a = await f.seed("a"), message = f.send(a.peer_id);
  f.advance(1); f.state("a", "closed");
  expect((await f.reconcile("a"))[0]!.result).toBe("released");
  expect(ticks).toBe(0);
  expect(f.adapter.resources().identities).toBe(0);
  expect(f.acked(message)).toBe(0);
  f.advance(1); f.state("a", "live");
  await f.reconcile("a");
  expect(JSON.stringify(await f.call("a"))).toContain("PRIVATE_A");
  expect(f.acked(message)).toBe(0);
});

test("failed postcommit drainage retries even when terminal evidence is unchanged", async () => {
  const f = await fixture(), a = await f.seed("a"), message = f.send(a.peer_id), port = f.lifecycle();
  const reconcile = () => port.reconcile({ home, backend_id: backend, observed_at: Date.now(),
    inventory_complete: true, observations: [f.observations.get("a")!] });
  const spy = spyOn(f.adapter, "drainFenced").mockRejectedValueOnce(new Error("drain_unavailable"));
  try {
    f.advance(1); f.state("a", "closed");
    await expect(reconcile()).rejects.toThrow("drain_unavailable");
    const terminal = f.broker.bindings.get(a.peer_id);
    expect(terminal!.state).toBe("closed");
    expect((await reconcile())[0]!.result).toBe("unchanged");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(f.broker.bindings.get(a.peer_id)).toEqual(terminal);
    expect(f.adapter.resources().identities).toBe(0);
    expect(f.acked(message)).toBe(0);
    await reconcile();
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); }
});
