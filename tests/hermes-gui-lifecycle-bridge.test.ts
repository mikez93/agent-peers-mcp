import { afterEach, expect, setSystemTime, test } from "bun:test";
import { HermesGuiLifecycleBridge, type HermesLifecycleRpc } from "../shared/hermes-gui-lifecycle-bridge.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb, registerPeer, sendMessage } from "../broker.ts";
import { HermesConversationBroker, installHermesConversationBrokerSchema } from "../shared/hermes-conversation-broker.ts";
import { HermesConversationComposition } from "../shared/hermes-conversation-composition.ts";
import type { WakeRequest } from "../shared/hermes-conversation-wake.ts";
import type { HermesConversationContext } from "../shared/hermes-conversation-context.ts";

const home = "/fixture/home", backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721";
const context = (id = "a") => ({ home, backend_id: backend, conversation_id: id,
  session_id: id, ui_session_id: `ui-${id}`, platform: "desktop" });
const nativeContext = (id = "native", platform = "cli") => ({ home, backend_id: backend,
  conversation_id: id, session_id: id, platform });
const live = (id = "a") => ({ ...context(id), state: "live", end_reason: null, lifecycle_generation: 2,
  changed_at: Date.now() + 1, session_ended_at: null, busy: false, queued: false, compacting: false });
const nativeLive = (id = "native", platform = "cli") => ({ ...nativeContext(id, platform), state: "live", end_reason: null,
  lifecycle_generation: 2, changed_at: Date.now() + 1, session_ended_at: null,
  busy: false, queued: false, compacting: false });
const terminal = (id = "a", reason = "idle_timeout") => ({
  ...context(id), state: reason === "tui_close" ? "closed" : "reaped", end_reason: reason,
  lifecycle_generation: 3, changed_at: Date.now(), session_ended_at: Date.now() / 1000,
});
const snapshot = (sessions: unknown[] = [live()], terminal: unknown[] = []) => ({
  home, backend_id: backend, observed_at: Date.now(), inventory_complete: true,
  unknown_runtime_ids: [] as string[], sessions, terminal,
});
function fixture(reply: (method: string, params: any) => unknown | Promise<unknown> = () => snapshot()) {
  const calls: { method: string; params: any; signal: AbortSignal }[] = [];
  let closes = 0;
  const rpc: HermesLifecycleRpc = {
    async request(method, params, signal) { calls.push({ method, params, signal }); return reply(method, params); },
    async close() { closes++; },
  };
  const bridge = new HermesGuiLifecycleBridge({ home, backend_id: backend }, rpc, { profile: "ezra" });
  return { bridge, calls, closes: () => closes };
}
function wakeRequest(input: HermesConversationContext = context()): WakeRequest {
  return { attempt_id: "347a20b0-34c9-456b-a0aa-43407b7b3b5f", attempt_sequence: 1,
    peer_id: "peer-a", context: input, binding_generation: 2, expected_lifecycle_generation: 2,
    resume: false, queued: true, hidden: true, notice: "Check pending mail." };
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

test("unknown, missing and unsupported reasons never invent ownership", async () => {
  for (const reply of [
    snapshot([], [{ conversation_id: "a", state: "unknown" }]), snapshot([], []),
    snapshot([], [terminal("a", "ws_disconnect")]),
    snapshot([], [{ ...terminal(), state: "closed" }]),
    snapshot([], [{ ...terminal("a", "tui_close"), state: "reaped" }]),
  ]) expect(await fixture(() => reply).bridge.observe(context(), signal())).toBeNull();
});

test("mixed GUI and native rows preserve optional UI identity and positive ownership", async () => {
  const tui = { ...live("tui"), platform: "tui" };
  const cron = nativeLive("cron", "cron");
  const f = fixture(() => snapshot([live(), tui, nativeLive(), cron]));
  const inventory = await f.bridge.inventory([], signal());
  expect(inventory.observations.map(row => row.context)).toEqual([
    context(), { ...context("tui"), platform: "tui" }, nativeContext(), nativeContext("cron", "cron"),
  ]);
  expect(inventory.observations.map(row => row.state)).toEqual(["live", "live", "live", "live"]);
  expect(await f.bridge.observe(nativeContext(), signal())).toMatchObject({
    context: nativeContext(), state: "live", lifecycle_generation: 2,
  });
  expect(await f.bridge.observe(nativeContext("cron", "cron"), signal())).toMatchObject({
    context: nativeContext("cron", "cron"), state: "live",
  });
});

test("native CLI close is explicit; UI and native shapes cannot borrow each other's identity", async () => {
  const { ui_session_id: _ignored, ...terminalFields } = terminal("native", "cli_close");
  const closed = { ...terminalFields, ...nativeContext(), state: "closed" };
  expect(await fixture(() => snapshot([], [closed])).bridge.observe(nativeContext(), signal()))
    .toMatchObject({ state: "terminal", end_reason: "explicit_close" });
  for (const row of [{ ...nativeLive(), ui_session_id: "invented" }, { ...live(), ui_session_id: undefined }]) {
    expect((await fixture(() => snapshot([row])).bridge.inventory([], signal())).inventory_complete).toBe(false);
  }
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
  const f = fixture((_method, params) => ({ ...snapshot([live("open")], params.conversation_ids.map((id: string) => terminal(id))),
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
    const f = fixture((_method, params) => {
      count++;
      if (count === 2 && mode === "error") throw { code: 5036 };
      if (count === 2 && mode === "stale") setSystemTime(now + 11_000);
      return { ...snapshot([{ ...live("open"), busy: mode === "change" && count === 2 }],
        params.conversation_ids.map((id: string) => terminal(id))), observed_at: now };
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
  await expect(f.bridge.admit(wakeRequest(), signal())).rejects.toThrow();
  await expect(f.bridge.reconcile(wakeRequest(), signal())).rejects.toThrow();
});

test("wake admit and reconcile forward the exact request and reject mismatched receipts", async () => {
  const request = wakeRequest();
  const f = fixture((method, params) => method === "session.lifecycle_snapshot" ? snapshot()
    : { attempt_id: params.attempt_id, attempt_sequence: params.attempt_sequence,
      context: params.context, state: method === "session.wake_admit" ? "accepted" : "started" });
  expect(await f.bridge.admit(request, signal())).toMatchObject({ state: "accepted", attempt_id: request.attempt_id });
  expect(await f.bridge.reconcile(request, signal())).toMatchObject({ state: "started", attempt_id: request.attempt_id });
  expect(f.calls.map(row => row.method)).toEqual(["session.wake_admit", "session.wake_reconcile"]);
  expect(f.calls.map(row => row.params)).toEqual([request, request]);
  const mismatched = fixture((_method, params) => ({ attempt_id: params.attempt_id,
    attempt_sequence: params.attempt_sequence + 1, context: params.context, state: "accepted" }));
  await expect(mismatched.bridge.admit(request, signal())).rejects.toThrow("wake_receipt_mismatch");
});

test("native host null UI receipt normalizes to the exact omitted-UI MCP context", async () => {
  const request = wakeRequest(nativeContext());
  const f = fixture((_method, params) => ({ attempt_id: params.attempt_id,
    attempt_sequence: params.attempt_sequence, context: { ...params.context, ui_session_id: null },
    state: "accepted" }));
  expect(await f.bridge.admit(request, signal())).toEqual({
    attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
    context: request.context, state: "accepted",
  });
});

test("wake request and receipt validation cannot retarget or add hidden fields", async () => {
  const good = wakeRequest();
  for (const value of [
    { ...good, attempt_sequence: 0 }, { ...good, hidden: false },
    { ...good, context: { ...good.context, ui_session_id: "borrowed" } },
    { ...good, context: { ...good.context, extra: "retarget" } },
    { ...good, extra: "hidden" },
  ]) await expect(fixture().bridge.admit(value as WakeRequest, signal())).rejects.toThrow();
  for (const result of [
    { attempt_id: good.attempt_id, attempt_sequence: good.attempt_sequence, context: good.context, state: "invented" },
    { attempt_id: good.attempt_id, attempt_sequence: good.attempt_sequence, context: { ...good.context, extra: "hidden" }, state: "accepted" },
    { attempt_id: good.attempt_id, attempt_sequence: good.attempt_sequence, context: good.context, state: "accepted", extra: true },
  ]) {
    const f = fixture(() => result);
    await expect(f.bridge.admit(good, signal())).rejects.toThrow("wake_receipt_mismatch");
  }
});

test("aborted wake RPC rejects, fences its late receipt and leaves a later call independent", async () => {
  let finish: ((value: unknown) => void) | undefined;
  const f = fixture((method, params) => method === "session.lifecycle_snapshot" ? snapshot()
    : new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(), pending = f.bridge.admit(wakeRequest(), controller.signal);
  while (!finish) await Bun.sleep(1);
  controller.abort();
  await expect(pending).rejects.toThrow();
  finish!({ attempt_id: wakeRequest().attempt_id, attempt_sequence: 1, context: wakeRequest().context, state: "accepted" });
  const later = { ...wakeRequest(), attempt_sequence: 2 };
  const second = f.bridge.reconcile(later, signal());
  while (f.calls.length < 2) await Bun.sleep(1);
  finish!({ attempt_id: later.attempt_id, attempt_sequence: 2, context: later.context, state: "absent" });
  expect(await second).toMatchObject({ state: "absent", attempt_sequence: 2 });
});

test("translator composes with actual broker/adapter and forwards bodyless wake without acknowledging mail", async () => {
  const root = await mkdtemp(join(tmpdir(), "gui-bridge-composition-")), db = initDb(join(root, "broker.db"));
  installHermesConversationBrokerSchema(db);
  const f = fixture((method, params) => {
    if (method === "session.lifecycle_snapshot") return snapshot();
    return { attempt_id: params.attempt_id, attempt_sequence: params.attempt_sequence,
      context: params.context, state: method === "session.wake_admit" ? "accepted" : "started" };
  });
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
    expect(f.calls.map(call => call.method)).toContain("session.wake_admit");
    expect(JSON.stringify(f.calls.map(call => call.params))).not.toContain("PRIVATE_GUI_A");
    expect(db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?").get(message)!.acked).toBe(0);
    expect(db.query<{ state: string }, []>("SELECT state FROM hermes_wake_attempts").get()!.state).toBe("accepted");
  } finally { await composition.stop(); db.close(); await rm(root, { recursive: true, force: true }); }
});
