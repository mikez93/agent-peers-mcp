import { afterEach, expect, setSystemTime, test } from "bun:test";
import { HermesGuiLifecycleBridge, type HermesLifecycleRpc } from "../shared/hermes-gui-lifecycle-bridge.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb, registerPeer, sendMessage } from "../broker.ts";
import { HermesConversationBroker, installHermesConversationBrokerSchema } from "../shared/hermes-conversation-broker.ts";
import { HermesConversationComposition } from "../shared/hermes-conversation-composition.ts";

const home = "/fixture/home", backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721";
const context = (id = "a") => ({ home, backend_id: backend, conversation_id: id,
  session_id: id, ui_session_id: `ui-${id}`, platform: "desktop" });
const live = (id = "a") => ({ ...context(id), state: "live", end_reason: null, lifecycle_generation: 2,
  changed_at: Date.now() + 1, session_ended_at: null, busy: false, queued: false, compacting: false });
const terminal = (id = "a", reason = "idle_timeout") => ({
  ...context(id), state: reason === "tui_close" ? "closed" : "reaped", end_reason: reason,
  lifecycle_generation: 3, changed_at: Date.now(), session_ended_at: Date.now() / 1000,
});
const snapshot = (sessions: unknown[] = [live()], terminal: unknown[] = []) => ({
  home, backend_id: backend, observed_at: Date.now(), inventory_complete: true,
  unknown_runtime_ids: [] as string[], sessions, terminal,
});
function fixture(reply: (params: { conversation_ids: readonly string[] }) => unknown | Promise<unknown> = () => snapshot()) {
  const calls: { method: string; params: { profile?: string; conversation_ids: readonly string[] }; signal: AbortSignal }[] = [];
  let closes = 0;
  const rpc: HermesLifecycleRpc = {
    async request(method, params, signal) { calls.push({ method, params, signal }); return reply(params); },
    async close() { closes++; },
  };
  const bridge = new HermesGuiLifecycleBridge({ home, backend_id: backend }, rpc, { profile: "ezra" });
  return { bridge, calls, closes: () => closes };
}
afterEach(() => setSystemTime());
const signal = () => new AbortController().signal;

test("exact GUI result uses only frozen snapshot RPC and request-start freshness", async () => {
  const now = Date.now(); setSystemTime(now);
  const f = fixture(() => ({ ...snapshot(), observed_at: now - 100, sessions: [{ ...live(), changed_at: now + 5 }] }));
  expect(await f.bridge.observe(context(), signal())).toMatchObject({
    context: context(), observed_at: now - 100, lifecycle_generation: 2, state: "live", busy: false,
  });
  expect(f.calls[0]).toMatchObject({ method: "session.lifecycle_snapshot", params: { profile: "ezra", conversation_ids: ["a"] } });
  expect(Object.isFrozen(f.calls[0]!.params.conversation_ids)).toBe(true);
  const inventory = await f.bridge.inventory(["a"], signal());
  expect(inventory.observed_at).toBe(now - 100);
  expect(inventory.observations).toHaveLength(1);
});

test.each(["idle_timeout", "lru_evict", "ws_orphan_reap", "tui_close"])("maps only source-proven terminal reason %s", async reason => {
  const f = fixture(() => snapshot([], [terminal("a", reason)]));
  expect(await f.bridge.observe(context(), signal())).toMatchObject({
    state: "terminal", end_reason: reason === "tui_close" ? "explicit_close" : "automatic_reap",
  });
});

test("unknown, missing, unsupported reason and native surfaces never invent ownership", async () => {
  for (const reply of [
    snapshot([], [{ conversation_id: "a", state: "unknown" }]), snapshot([], []),
    snapshot([], [terminal("a", "ws_disconnect")]),
    snapshot([], [{ ...terminal(), state: "closed" }]),
    snapshot([], [{ ...terminal("a", "tui_close"), state: "reaped" }]),
  ]) expect(await fixture(() => reply).bridge.observe(context(), signal())).toBeNull();
  const f = fixture();
  expect(await f.bridge.observe({ ...context(), platform: "cli" }, signal())).toBeNull();
  expect(await f.bridge.observe({ ...context(), platform: "cron" }, signal())).toBeNull();
  expect(f.calls).toHaveLength(0);
  const native = fixture(() => snapshot([{ ...live(), platform: "cli" }]));
  expect((await native.bridge.inventory([], signal())).observations[0]!.state).toBe("unknown");
});

test("strict envelope, identity, live and terminal validation fails closed", async () => {
  const malformed = [
    { ...snapshot(), home: "/wrong" }, { ...snapshot(), backend_id: "wrong" },
    { ...snapshot(), observed_at: Date.now() + 60_000 }, { ...snapshot(), observed_at: Date.now() - 20_000 },
    { ...snapshot(), inventory_complete: "yes" }, { ...snapshot(), unknown_runtime_ids: ["locked-runtime"] },
    { ...snapshot(), inventory_complete: false }, { ...snapshot(), sessions: {} },
    snapshot([{ ...live(), busy: 0 }]), snapshot([{ ...live(), lifecycle_generation: 0 }]),
    snapshot([{ ...live(), ui_session_id: undefined }]), snapshot([{ ...live(), session_ended_at: 123 }]),
    snapshot([live(), live()]), snapshot([live()], [terminal()]),
    snapshot([], [{ ...terminal(), session_ended_at: null }]), snapshot([], [{ ...terminal(), busy: false }]),
    snapshot([], [{ conversation_id: "a", state: "unknown", home }]),
    snapshot([], [terminal("unrequested")]), { jsonrpc: "2.0", id: 1, result: snapshot() },
  ];
  for (const data of malformed) {
    const f = fixture(() => data);
    expect(await f.bridge.observe(context(), signal())).toBeNull();
    expect((await f.bridge.inventory(["a"], signal())).inventory_complete).toBe(false);
  }
});

test("observe requires exact segment, platform and UI identity", async () => {
  const f = fixture();
  for (const input of [{ ...context(), session_id: "old" }, { ...context(), ui_session_id: "wrong" }]) {
    expect(await f.bridge.observe(input, signal())).toBeNull();
  }
  const { ui_session_id: _ui, ...native } = context();
  expect(await f.bridge.observe(native, signal())).toBeNull();
});

test("positive activity flags survive translation and canonical home aliases are rejected", async () => {
  const f = fixture(() => snapshot([{ ...live(), busy: true, queued: true, compacting: true }]));
  expect(await f.bridge.observe(context(), signal())).toMatchObject({ busy: true, queued: true, compacting: true });
  const rpc: HermesLifecycleRpc = { async request() { return snapshot(); }, async close() {} };
  expect(() => new HermesGuiLifecycleBridge({ home: `${home}/.`, backend_id: backend }, rpc))
    .toThrow("invalid_session_context:home");
});

test("129 requested roots use two bounded batches, deduplicate live inventory and retain oldest timestamp", async () => {
  const now = Date.now(); setSystemTime(now);
  let count = 0;
  const f = fixture(params => ({ ...snapshot([live("open")], params.conversation_ids.map(id => terminal(id))),
    observed_at: now - 100 + count++ }));
  const ids = Array.from({ length: 129 }, (_, i) => `c${i}`);
  const pending = f.bridge.inventory([...ids, ids[0]!], signal());
  ids.push("mutated");
  const inventory = await pending;
  expect(f.calls.map(call => call.params.conversation_ids.length)).toEqual([128, 1]);
  expect(inventory.inventory_complete).toBe(true);
  expect(inventory.observations).toHaveLength(130);
  expect(inventory.observed_at).toBe(now - 100);
  expect(inventory.observations.filter(row => row.context.conversation_id === "open")).toHaveLength(1);
});

test("changed live inventory or failed later batch discards the entire aggregate", async () => {
  const ids = Array.from({ length: 129 }, (_, i) => `c${i}`);
  for (const mode of ["change", "error", "stale"]) {
    const now = Date.now(); setSystemTime(now);
    let count = 0;
    const f = fixture(params => {
      count++;
      if (count === 2 && mode === "error") throw { code: 5036 };
      if (count === 2 && mode === "stale") setSystemTime(now + 11_000);
      return { ...snapshot([{ ...live("open"), busy: mode === "change" && count === 2 }],
        params.conversation_ids.map(id => terminal(id))), observed_at: now };
    });
    expect(await f.bridge.inventory(ids, signal())).toMatchObject({ inventory_complete: false, observations: [] });
  }
});

test.each([4004, 5036])("RPC error %i yields unknown, never retries another method", async code => {
  const f = fixture(() => { throw { code }; });
  expect(await f.bridge.observe(context(), signal())).toBeNull();
  expect(f.calls.map(row => row.method)).toEqual(["session.lifecycle_snapshot"]);
});

test("abort and close settle stalled requests, propagate cancellation and never admit", async () => {
  const f = fixture(() => new Promise(() => {})), controller = new AbortController();
  const pending = f.bridge.inventory(["a"], controller.signal);
  controller.abort();
  expect((await pending).inventory_complete).toBe(false);
  expect(f.calls[0]!.signal.aborted).toBe(true);
  const second = f.bridge.observe(context(), signal());
  await f.bridge.close();
  expect(await second).toBeNull();
  await f.bridge.close();
  expect(f.closes()).toBe(1);
  await expect(f.bridge.admit()).rejects.toThrow("host_admission_unavailable");
  await expect(f.bridge.reconcile()).rejects.toThrow("host_receipt_unavailable");
});

test("translator composes with actual broker/adapter but cannot admit or acknowledge a turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "gui-bridge-composition-")), db = initDb(join(root, "broker.db"));
  installHermesConversationBrokerSchema(db);
  const f = fixture();
  const broker = new HermesConversationBroker(db, {
    profile: "fixture-hermes", adapter_id: "one", cwd: root, git_root: null, pid: process.pid, inboxRoot: root,
    evidence: () => { throw new Error("T1 fallback forbidden"); },
    releaseEvidence: () => { throw new Error("no model release"); },
  });
  const composition = new HermesConversationComposition(db, broker, f.bridge, {
    home, backend_id: backend, adapter_id: "one", inboxRoot: root, ownsBackend: () => true, onTick: () => {},
  });
  try {
    await composition.prepare();
    await composition.adapter.call({ name: "set_summary", arguments: { summary: "GUI A" },
      _meta: Object.fromEntries(Object.entries(context()).map(([key, value]) => [`hermes/${key}`, value])) });
    const binding = db.query<{ peer_id: string; lifecycle_generation: number }, []>(
      "SELECT peer_id,lifecycle_generation FROM hermes_conversations").get()!;
    expect(binding.lifecycle_generation).toBe(2);
    const sender = registerPeer(db, { peer_type: "claude", pid: process.pid, cwd: root, git_root: null, tty: null, summary: "" });
    const message = sendMessage(db, { from_id: sender.id, session_token: sender.session_token,
      to_id_or_name: binding.peer_id, text: "PRIVATE_GUI_A" }).message_id!;
    await composition.tick();
    expect(f.calls.every(call => call.method === "session.lifecycle_snapshot")).toBe(true);
    expect(JSON.stringify(f.calls.map(call => call.params))).not.toContain("PRIVATE_GUI_A");
    expect(db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?").get(message)!.acked).toBe(0);
    // Unsupported admission remains uncertain, never fabricated accepted/absent.
    expect(db.query<{ state: string }, []>("SELECT state FROM hermes_wake_attempts").get()!.state).toBe("uncertain");
  } finally { await composition.stop(); db.close(); await rm(root, { recursive: true, force: true }); }
});
