import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { initDb, listPeers, registerPeer, sendMessage } from "../broker.ts";
import { HermesConversationBroker, installHermesConversationBrokerSchema } from "../shared/hermes-conversation-broker.ts";
import { HermesConversationComposition, type HermesConversationHostBridge } from "../shared/hermes-conversation-composition.ts";
import type { LifecycleObservation } from "../shared/hermes-conversation-lifecycle.ts";
import type { WakeRequest } from "../shared/hermes-conversation-wake.ts";

const home = "/fixture/home", backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721";
const roots: string[] = [], dbs: Database[] = [], compositions: HermesConversationComposition[] = [];
afterEach(async () => {
  await Promise.all(compositions.splice(0).map(c => c.stop()));
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  setSystemTime();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hermes-composition-")); roots.push(root);
  const db = initDb(join(root, "broker.db")); dbs.push(db);
  installHermesConversationBrokerSchema(db);
  const rows = new Map<string, LifecycleObservation>();
  const admitted: Readonly<WakeRequest>[] = [];
  let closes = 0;
  let ownsBackend = true;
  const host: HermesConversationHostBridge = {
    async observe(context) {
      const row = rows.get(context.conversation_id);
      return row ? { context: row.context, lifecycle_generation: row.lifecycle_generation,
        observed_at: Date.now(), state: row.state === "live" ? "live" : "terminal",
        end_reason: row.end_reason, busy: false, queued: false, compacting: false } : null;
    },
    async inventory() { return { home, backend_id: backend, observed_at: Date.now(),
      inventory_complete: true, observations: [...rows.values()] }; },
    async admit(request) { admitted.push(request); return { ...request, state: "accepted" }; },
    async reconcile(request) { return { ...request, state: "accepted" }; },
    async close() { closes++; },
  };
  const broker = new HermesConversationBroker(db, { profile: "fixture-hermes", adapter_id: "adapter",
    cwd: "/fixture", git_root: null, pid: process.pid, inboxRoot: join(root, "inboxes"),
    evidence: () => { throw new Error("no_dispatch_counter_in_t2"); },
    releaseEvidence: () => { throw new Error("no_release_from_model_call"); } });
  const composition = new HermesConversationComposition(db, broker, host, {
    home, backend_id: backend, adapter_id: "adapter", inboxRoot: join(root, "inboxes"), onTick: () => {}, ownsBackend: () => ownsBackend,
  });
  compositions.push(composition);
  const call = (id: string, name = "check_messages", args = {}) => composition.adapter.call({
    name, arguments: args, _meta: Object.fromEntries(Object.entries(rows.get(id)!.context).map(([k, v]) => [`hermes/${k}`, v])),
  });
  const seed = async (id: string) => {
    rows.set(id, { context: { home, backend_id: backend, conversation_id: id, session_id: id,
      platform: "desktop", ui_session_id: `ui-${id}` }, lifecycle_generation: 1, state: "live", end_reason: null });
    await call(id, "set_summary", { summary: `status-${id}` });
    return db.query<{ peer_id: string }, [string]>(
      "SELECT peer_id FROM hermes_conversations WHERE conversation_id=?").get(id)!.peer_id;
  };
  const sender = registerPeer(db, { peer_type: "claude", pid: process.pid, cwd: "/fixture", git_root: null, tty: null, summary: "" });
  const send = (to: string) => sendMessage(db, { from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: to, text: "PRIVATE_A" }).message_id!;
  const acked = (id: number) => db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?").get(id)!.acked;
  return { db, rows, host, broker, composition, admitted, call, seed, send, acked, closes: () => closes,
    loseClaim: () => { ownsBackend = false; } };
}

test("composition binds from host authority, renews idle status and routes only exact unread owner", async () => {
  const f = await fixture();
  await f.composition.prepare();
  const a = await f.seed("a"), b = await f.seed("b"), id = f.send(a);
  setSystemTime(Date.now() + 30_000);
  await f.composition.tick();
  expect(listPeers(f.db, { scope: "machine", cwd: "/fixture", git_root: null })
    .filter(p => p.peer_type === "hermes").map(p => p.summary).sort()).toEqual(["status-a", "status-b"]);
  expect(f.admitted).toHaveLength(1);
  expect(f.admitted[0]).toMatchObject({ peer_id: a, hidden: true, queued: true, context: { ui_session_id: "ui-a" } });
  expect(JSON.stringify(f.admitted)).not.toContain("PRIVATE_A");
  expect(f.acked(id)).toBe(0);
  expect(JSON.stringify(await f.call("b"))).not.toContain("PRIVATE_A");
  expect(JSON.stringify(await f.call("a"))).toContain("PRIVATE_A");
  expect(f.acked(id)).toBe(0);
  await f.call("a");
  expect(f.acked(id)).toBe(1);
  expect(f.broker.bindings.get(b)!.lifecycle_generation).toBe(1);
});

test("composition rejects dispatch namespace reinterpretation and missing positive ownership", async () => {
  const f = await fixture(), a = await f.seed("a");
  f.db.query("DELETE FROM hermes_lifecycle_sequences WHERE peer_id=?").run(a);
  await expect(f.call("a")).rejects.toThrow("counter_namespace_required");
  f.host.observe = async () => null;
  await expect(f.call("a")).rejects.toThrow("host_not_live");
  expect(f.admitted).toEqual([]);
});

test("startup preparation never admits mail and stop aborts an unresponsive observation", async () => {
  const f = await fixture(), a = await f.seed("a"), id = f.send(a), entered = deferred();
  await f.composition.prepare();
  expect(f.admitted).toEqual([]);
  let signal: AbortSignal | undefined;
  f.host.inventory = async (_ids, input) => {
    signal = input; entered.resolve();
    return new Promise(() => {});
  };
  const pending = f.composition.tick().catch(error => error as Error);
  await entered.promise;
  await f.composition.stop();
  expect(signal!.aborted).toBe(true);
  expect((await pending as Error).message).toBe("host_observation_cancelled");
  expect(f.composition.adapter.resources()).toEqual({ identities: 0, calls: 0, waiters: 0, timers: 0, pendingAcks: 0 });
  expect(f.closes()).toBe(1);
  expect(f.acked(id)).toBe(0);
  await f.composition.stop();
  expect(f.closes()).toBe(1);
});

test("composition terminal transaction drains a blocked tool before considering wake", async () => {
  const f = await fixture(), a = await f.seed("a"), id = f.send(a), entered = deferred(), release = deferred();
  const poll = f.broker.poll.bind(f.broker);
  f.broker.poll = async owner => { const messages = await poll(owner); entered.resolve(); await release.promise; return messages; };
  const call = f.call("a").catch(error => error as Error);
  await entered.promise;
  const row = f.rows.get("a")!;
  setSystemTime(Date.now() + 1);
  f.rows.set("a", { ...row, lifecycle_generation: 2, state: "closed", end_reason: "explicit_close" });
  const tick = f.composition.tick();
  for (let i = 0; i < 20 && f.broker.bindings.get(a)!.state !== "closed"; i++) await Bun.sleep(1);
  expect(f.broker.bindings.get(a)!.state).toBe("closed");
  expect(f.composition.adapter.canWake(row.context)).toBe(false);
  expect(f.admitted).toEqual([]);
  release.resolve();
  await tick;
  expect((await call as Error).message).toBe("conversation_closing");
  expect(f.acked(id)).toBe(0);
});

test("shutdown cancels admission transport but retains uncertain attempt and unread mail", async () => {
  const f = await fixture(), a = await f.seed("a"), id = f.send(a), entered = deferred();
  let signal: AbortSignal | undefined;
  f.host.admit = async (_request, input) => { signal = input; entered.resolve(); return new Promise(() => {}); };
  const tick = f.composition.tick();
  await entered.promise;
  await f.composition.stop(); await tick;
  expect(signal!.aborted).toBe(true);
  expect(f.db.query<{ state: string }, [string]>("SELECT state FROM hermes_wake_attempts WHERE peer_id=?").get(a)!.state)
    .toBe("uncertain");
  expect(f.acked(id)).toBe(0);
});

test("a future or non-boolean complete inventory cannot authorize wake", async () => {
  const f = await fixture(), a = await f.seed("a"); f.send(a);
  const inventory = f.host.inventory.bind(f.host);
  f.host.inventory = async (ids, signal) => ({ ...await inventory(ids, signal), observed_at: Date.now() + 60_000 });
  await f.composition.tick();
  expect(f.admitted).toEqual([]);
  f.host.inventory = async (ids, signal) => ({ ...await inventory(ids, signal), inventory_complete: "yes" as unknown as boolean });
  await f.composition.tick();
  expect(f.admitted).toEqual([]);
});

test("failed lifecycle application cannot be bypassed by a wake snapshot", async () => {
  const f = await fixture(), a = await f.seed("a"); f.send(a);
  f.db.exec(`CREATE TRIGGER reject_composed_renewal BEFORE UPDATE ON hermes_lifecycle_sequences
    BEGIN SELECT RAISE(ABORT, 'fixture lifecycle unavailable'); END`);
  await f.composition.tick();
  expect(f.admitted).toEqual([]);
});

test.each(["suspended", "reaped"] as const)("verified replacement recovers %s ownership without another tool call", async state => {
  const f = await fixture(), a = await f.seed("a"), id = f.send(a);
  const old = f.broker.bindings.get(a)!;
  f.db.query("UPDATE hermes_conversations SET adapter_id='old',state=?,owner_lease_until=0 WHERE peer_id=?").run(state, a);
  if (state === "reaped") {
    const row = f.rows.get("a")!;
    f.rows.set("a", { ...row, lifecycle_generation: 2, state: "reaped", end_reason: "automatic_reap" });
    f.db.query("UPDATE hermes_conversations SET lifecycle_generation=2 WHERE peer_id=?").run(a);
    f.db.query("DELETE FROM peers WHERE id=?").run(a);
    f.db.query("DELETE FROM hermes_conversation_tokens WHERE peer_id=?").run(a);
  }
  setSystemTime(Date.now() + 1);
  await f.composition.prepare();
  expect(f.admitted).toEqual([]);
  expect(f.broker.bindings.get(a)).toMatchObject({
    peer_id: a, adapter_id: "adapter", generation: old.generation + 1,
    state: state === "suspended" ? "active" : "reaped", summary: "status-a",
  });
  await f.composition.tick();
  expect(f.admitted).toHaveLength(1);
  expect(f.admitted[0]).toMatchObject({ peer_id: a, resume: state === "reaped", binding_generation: 2 });
  expect(f.acked(id)).toBe(0);
});

test("lost process claim prevents renewal, replacement and admission", async () => {
  const f = await fixture(), a = await f.seed("a"); f.send(a);
  const before = f.broker.bindings.get(a);
  f.loseClaim();
  await expect(f.composition.tick()).rejects.toThrow("adapter_process_not_owner");
  await expect(f.call("a")).rejects.toThrow("adapter_process_not_owner");
  expect(f.broker.bindings.get(a)).toEqual(before);
  expect(f.admitted).toEqual([]);
});

test("stale handoff evidence for A cannot prevent valid sibling B from recovering", async () => {
  const f = await fixture(), a = await f.seed("a"), b = await f.seed("b"), message = f.send(b);
  f.db.query(`UPDATE hermes_conversations SET adapter_id='old',state='suspended',
    owner_lease_until=0,lifecycle_generation=5`).run();
  for (const [id, generation] of [["a", 4], ["b", 5]] as const) {
    f.rows.set(id, { ...f.rows.get(id)!, lifecycle_generation: generation });
  }
  setSystemTime(Date.now() + 1);
  await f.composition.prepare();
  expect(f.broker.bindings.get(a)).toMatchObject({ state: "suspended", adapter_id: "old" });
  expect(f.broker.bindings.get(b)).toMatchObject({ state: "active", adapter_id: "adapter", generation: 2 });
  await f.composition.tick();
  expect(f.admitted.map(request => request.peer_id)).toEqual([b]);
  expect(f.acked(message)).toBe(0);
});
