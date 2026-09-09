import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { initDb, listPeers, registerPeer, sendMessage } from "../broker.ts";
import { HermesConversationBroker, installHermesConversationBrokerSchema } from "../shared/hermes-conversation-broker.ts";
import { HermesConversationAdapter } from "../shared/hermes-conversation-adapter.ts";
import { parseHermesConversationContext } from "../shared/hermes-conversation-context.ts";
import {
  HermesConversationLifecycleReconciler, lifecycleReleaseState,
  type LifecycleBinding, type LifecycleChange, type LifecycleInventory, type LifecycleObservation, type LifecyclePorts,
} from "../shared/hermes-conversation-lifecycle.ts";

const home = "/fixture/profile", backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721", adapterId = "fixture-adapter";
const dbs: Database[] = [], roots: string[] = [], adapters: HermesConversationAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(a => a.stop()));
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  setSystemTime();
});
function context(id: string, segment = id, backendId = backend) {
  return parseHermesConversationContext({ "hermes/home": home, "hermes/backend_id": backendId,
    "hermes/conversation_id": id, "hermes/session_id": segment, "hermes/platform": "desktop" },
  { home, backend_id: backendId });
}
function observation(id: string, generation = 1): LifecycleObservation {
  return { context: context(id), lifecycle_generation: generation, state: "live", end_reason: null };
}
async function fixture() {
  let clock = Date.now();
  setSystemTime(clock);
  const root = await mkdtemp(join(tmpdir(), "hermes-lifecycle-")); roots.push(root);
  const db = initDb(join(root, "broker.db")); dbs.push(db);
  installHermesConversationBrokerSchema(db);
  db.exec("CREATE TABLE fixture_host_sequences(peer_id TEXT PRIMARY KEY,backend_id TEXT NOT NULL)");
  const evidence = new Map<string, LifecycleObservation>();
  const broker = new HermesConversationBroker(db, { profile: "fixture-hermes", adapter_id: adapterId,
    cwd: "/fixture", git_root: null, pid: process.pid, inboxRoot: join(root, "inboxes"),
    evidence: ctx => {
      const row = evidence.get(ctx.conversation_id)!;
      return { context: ctx, adapter_id: adapterId, lifecycle_generation: row.lifecycle_generation,
        observed_at: clock };
    },
    releaseEvidence: () => { throw new Error("fixture uses atomic terminal fence"); },
  });
  const adapter = new HermesConversationAdapter({ home, backend_id: backend, inboxRoot: join(root, "inboxes"), broker });
  adapters.push(adapter);
  const binding = (id: string): LifecycleBinding => {
    const row = db.query<LifecycleBinding, [string]>("SELECT * FROM hermes_conversations WHERE peer_id=?").get(id)!;
    const provenance = db.query<{ backend_id: string }, [string]>("SELECT backend_id FROM fixture_host_sequences WHERE peer_id=?").get(id);
    return { ...row, sequence_source: provenance?.backend_id === row.backend_id ? "host" : "dispatch" };
  };
  const ports: LifecyclePorts = {
    bindings: () => db.query<{ peer_id: string }, []>("SELECT peer_id FROM hermes_conversations ORDER BY conversation_id")
      .all().map(r => binding(r.peer_id)),
    apply: change => db.transaction(() => {
      if (JSON.stringify(binding(change.expected.peer_id)) !== JSON.stringify(change.expected)) return false;
      if (change.action === "release") {
        broker.bindings.release(change.expected, lifecycleReleaseState(change.observation),
          change.observation.lifecycle_generation, change.observed_at);
        db.query("DELETE FROM peers WHERE id=?").run(change.expected.peer_id);
        db.query("DELETE FROM hermes_conversation_tokens WHERE peer_id=?").run(change.expected.peer_id);
      } else {
        // This fixture proves live-epoch renewal through the real store/listing.
        // Recovery that needs peer/token recreation belongs to bridge acceptance.
        broker.bindings.refresh(change.expected, { context: change.observation.context, adapter_id: change.adapter_id,
          lifecycle_generation: change.observation.lifecycle_generation, observed_at: change.observed_at });
        db.query("UPDATE peers SET last_seen=? WHERE id=?")
          .run(new Date(clock).toISOString(), change.expected.peer_id);
      }
      db.query("INSERT OR REPLACE INTO fixture_host_sequences VALUES (?,?)")
        .run(change.expected.peer_id, change.observation.context.backend_id);
      return true;
    }).immediate(),
  };
  const seed = async (id: string, hostSequence = true) => {
    evidence.set(id, observation(id));
    const owner = await broker.bind(context(id));
    if (hostSequence) db.query("INSERT INTO fixture_host_sequences VALUES (?,?)").run(owner.peer_id, backend);
    await broker.invoke(owner, "set_summary", { summary: `status-${id}` });
    return owner;
  };
  const snapshot = (...observations: LifecycleObservation[]): LifecycleInventory =>
    ({ home, backend_id: backend, observed_at: clock, inventory_complete: true, observations });
  const advance = (ms: number) => { clock += ms; setSystemTime(clock); };
  const visible = () => listPeers(db, { scope: "machine", cwd: "/fixture", git_root: null }).filter(p => p.peer_type === "hermes");
  const reconciler = (backendId = backend) => new HermesConversationLifecycleReconciler(
    { home, backend_id: backendId, adapter_id: adapterId }, ports);
  return { db, broker, adapter, ports, seed, binding, snapshot, advance, visible, reconciler, root };
}

test("open idle status stays listed for ten minutes without another model tool call", async () => {
  const f = await fixture(), a = await f.seed("a"), b = await f.seed("b");
  const sender = registerPeer(f.db, { peer_type: "claude", pid: process.pid, cwd: "/fixture", git_root: null, tty: null, summary: "" });
  const message = sendMessage(f.db, { from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: a.peer_id, text: "still-private" });
  const before = f.db.query("SELECT * FROM messages WHERE id=?").get(message.message_id!);
  for (let i = 0; i < 40; i++) {
    f.advance(15_000);
    expect(f.reconciler().reconcile(f.snapshot(observation("a"), observation("b"))).map(r => r.result))
      .toEqual(["renewed", "renewed"]);
    f.broker.bindings.expire();
    expect(f.visible().map(p => p.summary).sort()).toEqual(["status-a", "status-b"]);
  }
  expect(f.binding(a.peer_id).generation).toBe(1);
  expect(f.binding(b.peer_id).generation).toBe(1);
  expect(f.db.query("SELECT * FROM messages WHERE id=?").get(message.message_id!)).toEqual(before);
  expect(f.adapter.resources().identities).toBe(0);
});

test("missing, incomplete, unknown and old inventories do not invent terminal events or renew forever", async () => {
  const f = await fixture(), a = await f.seed("a"), original = f.snapshot(observation("a"));
  f.advance(30_000);
  expect(f.reconciler().reconcile(original)).toEqual([]);
  expect(f.reconciler().reconcile({ ...f.snapshot(observation("a")), inventory_complete: false })).toEqual([]);
  expect(f.reconciler().reconcile(f.snapshot())[0]!.result).toBe("unknown");
  expect(f.reconciler().reconcile(f.snapshot({ ...observation("a"), state: "unknown" }))[0]!.result).toBe("unknown");
  f.advance(16_000); f.broker.bindings.expire();
  expect(f.binding(a.peer_id).state).toBe("suspended");
  expect(f.visible()).toHaveLength(0);
});

test("explicit close/reap delists only the exact peer and retains unacknowledged mail", async () => {
  const f = await fixture(), a = await f.seed("a"), b = await f.seed("b");
  const sender = registerPeer(f.db, { peer_type: "claude", pid: process.pid, cwd: "/fixture", git_root: null, tty: null, summary: "" });
  const sent = sendMessage(f.db, { from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: a.peer_id, text: "keep-me" });
  f.advance(1);
  const closed: LifecycleObservation = { ...observation("a", 2), state: "closed", end_reason: "explicit_close" };
  expect(f.reconciler().reconcile(f.snapshot(closed, observation("b"))).map(r => r.result)).toEqual(["released", "renewed"]);
  expect(f.visible().map(p => p.id)).toEqual([b.peer_id]);
  expect(f.binding(a.peer_id).state).toBe("closed");
  expect(f.db.query("SELECT acked FROM messages WHERE id=?").get(sent.message_id!)).toEqual({ acked: 0 });
  expect(f.db.query("SELECT 1 FROM hermes_conversation_tokens WHERE peer_id=?").get(a.peer_id)).toBeNull();
  expect(f.reconciler().reconcile(f.snapshot(closed))[0]!.result).toBe("unchanged");
  const reaped: LifecycleObservation = { ...observation("b", 2), state: "reaped", end_reason: "automatic_reap" };
  f.reconciler().reconcile(f.snapshot(reaped));
  expect(f.binding(b.peer_id).state).toBe("reaped");
  expect(f.visible()).toHaveLength(0);
});

test("T1 dispatch counters cannot be interpreted as host lifecycle counters in place", async () => {
  const f = await fixture(), a = await f.seed("a", false);
  expect(f.reconciler().reconcile(f.snapshot(observation("a", 10_000)))[0]!.result).toBe("counter_namespace_required");
  expect(f.binding(a.peer_id).lifecycle_generation).toBe(1);
});

test("ambiguous, wrong-home and wrong-backend observations fail before any change", async () => {
  const f = await fixture(), a = await f.seed("a"), before = f.binding(a.peer_id);
  expect(() => f.reconciler().reconcile(f.snapshot(observation("a"), observation("a", 2)))).toThrow("ambiguous");
  const row = observation("a");
  for (const patch of [{ home: "/other/home" }, { backend_id: "other" }]) {
    expect(() => f.reconciler().reconcile(f.snapshot({ ...row, context: { ...row.context, ...patch } }))).toThrow("owner_mismatch");
  }
  expect(f.binding(a.peer_id)).toEqual(before);
});

test("fresh-looking lower sequence and missing close reason cannot undo current ownership", async () => {
  const f = await fixture(), a = await f.seed("a");
  f.advance(1);
  f.reconciler().reconcile(f.snapshot(observation("a", 3)));
  f.advance(1);
  expect(f.reconciler().reconcile(f.snapshot(observation("a", 2)))[0]!.result).toBe("stale");
  expect(f.reconciler().reconcile(f.snapshot({ ...observation("a", 4), state: "closed", end_reason: null }))[0]!.result).toBe("unknown");
  expect(f.binding(a.peer_id).lifecycle_generation).toBe(3);
});

test("binding change between plan and transaction fences a stale renewal", async () => {
  const f = await fixture(), a = await f.seed("a"), apply = f.ports.apply;
  f.ports.apply = change => {
    f.db.query("UPDATE hermes_conversations SET generation=generation+1 WHERE peer_id=?").run(a.peer_id);
    return apply(change);
  };
  expect(f.reconciler().reconcile(f.snapshot(observation("a", 2)))[0]!.result).toBe("stale");
  expect(f.binding(a.peer_id).lifecycle_generation).toBe(1);
});

test("replaying one fresh snapshot never extends its observation-anchored lease", async () => {
  const f = await fixture(), a = await f.seed("a");
  f.advance(1);
  const snapshot = f.snapshot(observation("a"));
  f.reconciler().reconcile(snapshot);
  const lease = f.binding(a.peer_id).owner_lease_until;
  f.advance(9_000);
  f.reconciler().reconcile(snapshot);
  expect(f.binding(a.peer_id).owner_lease_until).toBe(lease);
  f.advance(1_001);
  expect(f.reconciler().reconcile(snapshot)).toEqual([]);
  expect(f.binding(a.peer_id).owner_lease_until).toBe(lease);
});

test("entry freezes the entire observation set before binding callbacks can mutate it", async () => {
  const f = await fixture(), a = await f.seed("a"), b = await f.seed("b");
  const rows = [observation("a"), observation("b")], bindings = f.ports.bindings;
  f.ports.bindings = () => {
    rows[1]!.state = "closed";
    rows[1]!.end_reason = "explicit_close";
    return bindings();
  };
  expect(f.reconciler().reconcile(f.snapshot(...rows)).map(r => r.result)).toEqual(["renewed", "renewed"]);
  expect(f.binding(a.peer_id).state).toBe("active");
  expect(f.binding(b.peer_id).state).toBe("active");
});

test("expiry during a pass prevents a later sibling renewal", async () => {
  const f = await fixture();
  await f.seed("a"); await f.seed("b");
  const apply = f.ports.apply;
  f.ports.apply = change => { const result = apply(change); f.advance(10_001); return result; };
  expect(f.reconciler().reconcile(f.snapshot(observation("a"), observation("b"))).map(r => r.result))
    .toEqual(["renewed", "stale"]);
});

test("new backend counter namespace cannot steal a live lease or assert another backend's close", async () => {
  const f = await fixture(), a = await f.seed("a", false);
  const nextBackend = "9cf0eb15-0b56-4555-8c1e-a20206a1a5be";
  const row = { ...observation("a"), context: context("a", "a", nextBackend) };
  const snapshot = { ...f.snapshot(row), backend_id: nextBackend };
  const reconciler = f.reconciler(nextBackend);
  expect(reconciler.reconcile(snapshot)[0]!.result).toBe("stale");
  f.advance(46_000);
  f.broker.bindings.expire();
  const proposed: LifecycleChange[] = [];
  f.ports.apply = change => { proposed.push(change); return true; };
  expect(reconciler.reconcile({ ...f.snapshot(row), backend_id: nextBackend })[0]!.result).toBe("renewed");
  expect(proposed[0]!.expected.peer_id).toBe(a.peer_id);
  expect(proposed[0]!.expected.sequence_source).toBe("dispatch");
  expect(proposed[0]!.observation.lifecycle_generation).toBe(1);
  expect(reconciler.reconcile({ ...f.snapshot({ ...row, state: "closed", end_reason: "explicit_close" }),
    backend_id: nextBackend })[0]!.result).toBe("stale");
});

test("finished cron releases instead of acquiring a wakeable reaped state", async () => {
  const f = await fixture(), a = await f.seed("a");
  f.db.query("UPDATE hermes_conversations SET platform='cron' WHERE peer_id=?").run(a.peer_id);
  const row = { ...observation("a", 2), context: { ...context("a"), platform: "cron" } };
  expect(f.reconciler().reconcile(f.snapshot({ ...row, state: "reaped", end_reason: "automatic_reap" }))[0]!.result).toBe("unknown");
  expect(f.reconciler().reconcile(f.snapshot({ ...row, state: "closed", end_reason: "run_completed" }))[0]!.result).toBe("released");
  expect(f.binding(a.peer_id).state).toBe("closed");
});

test("a failed apply is unavailable, and retired compression segments cannot roll backward", async () => {
  const f = await fixture(), a = await f.seed("a");
  const next = { ...observation("a", 2), context: context("a", "compressed") };
  f.advance(1);
  expect(f.reconciler().reconcile(f.snapshot(next))[0]!.result).toBe("renewed");
  f.advance(1);
  expect(f.reconciler().reconcile(f.snapshot(observation("a", 3)))[0]!.result).toBe("unavailable");
  expect(f.binding(a.peer_id).current_session_id).toBe("compressed");
  expect(f.binding(a.peer_id).lifecycle_generation).toBe(2);
});
