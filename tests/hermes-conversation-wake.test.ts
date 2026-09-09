import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  HermesConversationWakeCoordinator, installHermesWakeSchema,
  type HermesWakePorts, type WakeCandidate, type WakeLifecycle, type WakeReceipt, type WakeRequest,
} from "../shared/hermes-conversation-wake.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function candidate(id = "a"): WakeCandidate {
  return { peer_id: `peer-${id}`, context: { home: "/fixture/home", conversation_id: id,
    session_id: `${id}-segment`, ui_session_id: `${id}-pane`, platform: "desktop",
    backend_id: "77ab3c4a-2e1b-4d4a-a5b4-88009412f721" },
  binding_generation: 1, state: "active", unread_ids: [1] };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture(db = new Database(":memory:")) {
  if (!databases.includes(db)) databases.push(db);
  installHermesWakeSchema(db);
  let now = 100_000;
  const calls: Readonly<WakeRequest>[] = [];
  const host = new Map<string, WakeReceipt>();
  const snapshots = new Map<string, WakeLifecycle>();
  const ports: HermesWakePorts = {
    async snapshot(c) {
      return snapshots.get(c.peer_id) ?? { context: { ...c.context }, lifecycle_generation: 7,
        observed_at: now, state: "live", end_reason: null, busy: false, queued: false, compacting: false };
    },
    async current() { return true; },
    async admit(request) {
      // Fixture models the mandatory host-side atomic deduplication contract.
      const existing = host.get(request.attempt_id);
      if (existing) return existing;
      calls.push(request);
      const receipt: WakeReceipt = { attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
        context: request.context, state: "accepted" };
      host.set(request.attempt_id, receipt);
      return receipt;
    },
    async reconcile(request) {
      return host.get(request.attempt_id) ?? { attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
        context: request.context, state: "absent" };
    },
  };
  const coordinator = () => new HermesConversationWakeCoordinator(db, ports, () => now);
  const complete = (state: WakeReceipt["state"] = "completed") => {
    const request = calls.at(-1)!;
    host.set(request.attempt_id, { attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
      context: request.context, state });
  };
  return { db, ports, snapshots, calls, host, coordinator, complete, advance: (ms: number) => { now += ms; },
    snapshot: async (c: WakeCandidate) => (await ports.snapshot(c, new AbortController().signal))! };
}

test("N identities on one backend: a status-only target has one bodyless exact queued admission", async () => {
  const f = fixture();
  const a = candidate(), b = { ...candidate("b"), unread_ids: [] };
  expect((await f.coordinator().run([a, b])).map(r => r.reason)).toEqual(["accepted", "no_mail"]);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ peer_id: a.peer_id, context: a.context, queued: true, hidden: true, resume: false });
  expect(f.calls[0]!.notice).toContain("check_messages");
  expect(f.calls[0]!.notice).not.toContain("peer-a");
  expect(f.db.query("SELECT state FROM hermes_wake_attempts").all()).toEqual([{ state: "accepted" }]);
});

for (const key of ["home", "conversation_id", "session_id", "backend_id", "platform", "ui_session_id"] as const) {
  test(`snapshot ${key} mismatch cannot wake a sibling`, async () => {
    const f = fixture(), c = candidate(), row = await f.snapshot(c);
    row.context = { ...row.context, [key]: key === "home" ? "/other/home" : "other" };
    f.snapshots.set(c.peer_id, row);
    expect((await f.coordinator().run([c]))[0]!.reason).toBe("deferred");
    expect(f.calls).toHaveLength(0);
  });
}
for (const field of ["busy", "queued", "compacting"] as const) {
  test(`${field} work defers without altering user queue, then wakes when idle`, async () => {
    const f = fixture(), c = candidate(), row = await f.snapshot(c);
    row[field] = true;
    f.snapshots.set(c.peer_id, row);
    expect((await f.coordinator().run([c]))[0]!.reason).toBe("deferred");
    expect(f.calls).toHaveLength(0);
    row[field] = false;
    expect((await f.coordinator().run([c]))[0]!.reason).toBe("accepted");
  });
}
test("unknown, missing, stale, future and malformed lifecycle evidence abstains", async () => {
  const f = fixture(), c = candidate(), original = await f.snapshot(c);
  for (const patch of [
    { state: "unknown" }, { observed_at: 89_999 }, { observed_at: 100_001 },
    { lifecycle_generation: -1 }, { lifecycle_generation: NaN }, { busy: undefined },
    { state: "terminal", end_reason: null }, { state: "terminal", end_reason: "unknown" },
  ]) {
    f.snapshots.set(c.peer_id, { ...original, ...patch } as WakeLifecycle);
    expect((await f.coordinator().run([c]))[0]!.reason).toBe("deferred");
  }
  f.ports.snapshot = async () => null;
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("deferred");
  f.ports.snapshot = async () => { throw new Error("offline"); };
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("wake_unavailable");
  expect(f.calls).toHaveLength(0);
});
test("closed/deleted/suspended never resurrect, only authoritative automatic reap permits exact resume", async () => {
  const f = fixture(), c = candidate();
  for (const state of ["closed", "orphaned", "disposed", "suspended"] as const) {
    expect((await f.coordinator().run([{ ...c, state }]))[0]!.reason).toBe("deferred");
  }
  const row = { ...await f.snapshot(c), state: "terminal" as const };
  for (const end_reason of ["explicit_close", "deleted", "completed", null]) {
    f.snapshots.set(c.peer_id, { ...row, end_reason });
    expect((await f.coordinator().run([{ ...c, state: "reaped" }]))[0]!.reason).toBe("deferred");
  }
  f.snapshots.set(c.peer_id, { ...row, end_reason: "automatic_reap" });
  expect((await f.coordinator().run([{ ...c, state: "reaped" }]))[0]!.reason).toBe("accepted");
  expect(f.calls[0]).toMatchObject({ resume: true, context: c.context });
});
test("finished cron cannot be restarted through the reap path", async () => {
  const f = fixture(), c = candidate();
  c.context = { ...c.context, platform: "cron" };
  f.snapshots.set(c.peer_id, { ...await f.snapshot(c), state: "terminal", end_reason: "automatic_reap" });
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("deferred");
  expect(f.calls).toHaveLength(0);
});
test("entry snapshot remains immutable across caller mutation and final binding fence", async () => {
  const f = fixture(), c = candidate(), entered = deferred(), release = deferred();
  f.ports.current = async captured => {
    entered.resolve(); await release.promise;
    expect(captured.context.conversation_id).toBe("a");
    expect(captured.unread_ids).toEqual([1]);
    return false;
  };
  const run = f.coordinator().run([c]);
  await entered.promise;
  c.context = candidate("b").context;
  c.unread_ids = [2];
  release.resolve();
  expect((await run)[0]!.reason).toBe("deferred");
  expect(f.calls).toHaveLength(0);
});
test("snapshot that ages out during final binding check is not admitted", async () => {
  const f = fixture();
  f.ports.current = async () => { f.advance(10_001); return true; };
  expect((await f.coordinator().run([candidate()]))[0]!.reason).toBe("deferred");
});
test("lost successful admission reply reconciles after coordinator recreation without a second turn", async () => {
  const f = fixture(), c = candidate(), admit = f.ports.admit;
  f.ports.admit = async (request, signal) => { await admit(request, signal); throw new Error("lost reply"); };
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("wake_unavailable");
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("accepted");
  expect(f.calls).toHaveLength(1);
});
test("uncommitted RPC replays only its persisted attempt ID after authoritative absence", async () => {
  const f = fixture(), c = candidate(), admit = f.ports.admit;
  const attempts: string[] = [];
  f.ports.admit = async request => { attempts.push(request.attempt_id); throw new Error("offline"); };
  await f.coordinator().run([c]);
  f.ports.admit = async (request, signal) => { attempts.push(request.attempt_id); return admit(request, signal); };
  await f.coordinator().run([c]);
  expect(new Set(attempts).size).toBe(1);
  expect(f.calls).toHaveLength(1);
});
test("unknown result blocks retries, and an unresolved old backend cannot be replaced", async () => {
  const f = fixture(), c = candidate();
  f.ports.admit = async () => { throw new Error("offline"); };
  await f.coordinator().run([c]);
  f.ports.reconcile = async request => ({ attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
    context: request.context, state: "unknown" });
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("uncertain");
  f.ports.reconcile = async request => ({ attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
    context: request.context, state: "absent" });
  c.context = { ...c.context, backend_id: "new-backend" };
  c.binding_generation++;
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("unresolved_old_owner");
  expect(f.calls).toHaveLength(0);
});
test("wrong identity receipt cannot promote uncertainty to accepted", async () => {
  const f = fixture(), c = candidate();
  f.ports.admit = async request => ({ attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
    context: candidate("b").context, state: "accepted" });
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("wake_unavailable");
  expect(f.db.query("SELECT state FROM hermes_wake_attempts").get()).toEqual({ state: "uncertain" });
});
test("new mail coalesces while accepted/started; completed retries use persistent 60s/5m/30m limits", async () => {
  const f = fixture(), c = candidate();
  await f.coordinator().run([c]);
  c.unread_ids = [1, 2];
  f.complete("started");
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("started");
  expect(f.calls).toHaveLength(1);
  f.complete();
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("accepted");
  expect(f.calls).toHaveLength(2);
  for (const delay of [60_000, 300_000, 1_800_000]) {
    f.complete();
    expect((await f.coordinator().run([c]))[0]!.reason).toBe("backoff");
    f.advance(delay - 1);
    expect((await f.coordinator().run([c]))[0]!.reason).toBe("backoff");
    f.advance(1);
    expect((await f.coordinator().run([c]))[0]!.reason).toBe("accepted");
  }
  f.complete();
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("wake_exhausted");
  f.advance(100_000_000);
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("wake_exhausted");
  expect(f.calls).toHaveLength(5);
});
test("ack-only shrink does not reset backoff; cancellation suppresses unchanged remaining mail", async () => {
  const f = fixture(), c = { ...candidate(), unread_ids: [1, 2] };
  await f.coordinator().run([c]);
  f.complete();
  c.unread_ids = [2];
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("backoff");
  f.advance(60_000);
  await f.coordinator().run([c]);
  f.complete("cancelled");
  f.advance(100_000_000);
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("cancelled");
  c.unread_ids = [2, 3];
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("accepted");
});
test("concurrent coordinators race one durable claim and host deduplicates its attempt", async () => {
  const f = fixture(), c = candidate();
  await Promise.all([f.coordinator().run([c]), f.coordinator().run([c])]);
  expect(f.calls).toHaveLength(1);
  expect(f.db.query("SELECT COUNT(*) AS n FROM hermes_wake_attempts").get()).toEqual({ n: 1 });
});
test("one stalled target fails independently, and overlapping passes are explicitly refused", async () => {
  const f = fixture(), c = candidate(), enter = deferred(), release = deferred(), coordinator = f.coordinator();
  f.ports.snapshot = async () => { enter.resolve(); await release.promise; throw new Error("offline"); };
  const run = coordinator.run([c]);
  await enter.promise;
  await expect(coordinator.run([c])).rejects.toThrow("wake_pass_running");
  release.resolve();
  expect((await run)[0]!.reason).toBe("wake_unavailable");
});

test("deferred retry replacements preserve the five-minute next backoff", async () => {
  const f = fixture(), c = candidate(), admit = f.ports.admit;
  await f.coordinator().run([c]);
  f.complete();
  await f.coordinator().run([c]);
  f.advance(60_000);
  f.ports.admit = async request => ({ attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
    context: request.context, state: "deferred" });
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("deferred");
  f.ports.admit = admit;
  await f.coordinator().run([c]);
  f.complete();
  await f.coordinator().run([c]);
  f.advance(60_000);
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("backoff");
  f.advance(240_000);
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("accepted");
});

test("a second target is admitted while the first snapshot is still stalled", async () => {
  const f = fixture(), first = candidate(), second = candidate("b"), blocked = deferred(), visited = deferred();
  const snapshot = f.ports.snapshot;
  f.ports.snapshot = async (c, signal) => {
    if (c.peer_id === first.peer_id) await blocked.promise;
    else visited.resolve();
    return snapshot(c, signal);
  };
  const run = f.coordinator().run([first, second]);
  const outcome = await Promise.race([visited.promise.then(() => "visited"),
    new Promise<string>(resolve => setTimeout(() => resolve("blocked"), 20))]);
  blocked.resolve();
  await run;
  expect(outcome).toBe("visited");
});

test("shared pass deadline settles a stuck port and later passes can run", async () => {
  const f = fixture(), c = candidate(), snapshot = f.ports.snapshot;
  let portSignal: AbortSignal | undefined;
  f.ports.snapshot = async (_candidate, signal) => { portSignal = signal; return new Promise(() => {}); };
  const coordinator = new HermesConversationWakeCoordinator(f.db, f.ports, Date.now, 10);
  expect((await coordinator.run([c]))[0]!.reason).toBe("wake_unavailable");
  expect(portSignal?.aborted).toBe(true);
  f.ports.snapshot = async (c, signal) => ({ ...await snapshot(c, signal)!, observed_at: Date.now() }) as WakeLifecycle;
  expect((await coordinator.run([c]))[0]!.reason).toBe("accepted");
});

test("admission timeout preserves uncertainty; late receipt cannot mutate a newer reconciliation", async () => {
  const f = fixture(), c = candidate(), block = deferred(), entered = deferred(), admit = f.ports.admit;
  const controller = new AbortController();
  f.ports.admit = async (request, signal) => {
    const receipt = await admit(request, signal);
    entered.resolve();
    await block.promise;
    return receipt;
  };
  const run = f.coordinator().run([c], controller.signal);
  await entered.promise;
  controller.abort();
  expect((await run)[0]!.reason).toBe("wake_unavailable");
  expect(f.db.query("SELECT state FROM hermes_wake_attempts").get()).toEqual({ state: "uncertain" });
  f.complete("cancelled");
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("cancelled");
  block.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.db.query("SELECT state FROM hermes_wake_attempts").get()).toEqual({ state: "cancelled" });
  expect(f.calls).toHaveLength(1);
});

test("monotonic attempt sequence survives cancellation, new mail, backend replacement and coordinator recreation", async () => {
  const f = fixture(), c = candidate();
  await f.coordinator().run([c]);
  expect(f.calls[0]!.attempt_sequence).toBe(1);
  f.complete("cancelled");
  await f.coordinator().run([c]);
  c.unread_ids = [1, 2];
  c.context = { ...c.context, backend_id: "replacement-backend" };
  c.binding_generation++;
  await f.coordinator().run([c]);
  expect(f.calls[1]!.attempt_sequence).toBe(2);
  f.complete();
  await f.coordinator().run([c]);
  f.advance(60_000);
  await f.coordinator().run([c]);
  expect(f.calls[2]!.attempt_sequence).toBe(3);
  expect(f.db.query("SELECT COUNT(*) AS n FROM hermes_wake_attempts").get()).toEqual({ n: 1 });
});

test("replayed uncertainty retains its sequence and wrong-sequence receipt is not evidence", async () => {
  const f = fixture(), c = candidate(), attempts: Readonly<WakeRequest>[] = [];
  f.ports.admit = async request => { attempts.push(request); throw new Error("offline"); };
  await f.coordinator().run([c]);
  await f.coordinator().run([c]);
  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toEqual(attempts[1]!);
  f.ports.reconcile = async request => ({ attempt_id: request.attempt_id, attempt_sequence: 99,
    context: request.context, state: "completed" });
  expect((await f.coordinator().run([c]))[0]!.reason).toBe("wake_unavailable");
  expect(f.db.query("SELECT state FROM hermes_wake_attempts").get()).toEqual({ state: "uncertain" });
});
