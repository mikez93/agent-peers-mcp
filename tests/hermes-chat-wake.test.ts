import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HermesChatDirectory, HermesChatWakeDriver, acquireLedgerLock, classifyHermesCliOutput, defaultWakeText, hermesProfileForPeer,
  lineageRoot, lineageTip, type HermesChatWakeLedger, type HermesDesktopAttempt,
} from "../shared/hermes-chat-wake.ts";

// Minimal copy of the Hermes v0.22.5 tables the module reads (hermes_state_common.py).
const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
  last_activity_at REAL, end_reason TEXT, archived INTEGER NOT NULL DEFAULT 0, model_config TEXT
);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, finish_reason TEXT);
CREATE TABLE session_turn_leases (conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL);
CREATE TABLE session_admissions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, admission_id TEXT NOT NULL UNIQUE, target_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','started','unknown','terminal'))
);`;

let root: string;
let hermesHome: string;
let stateDir: string;
let binDir: string;
let argsLog: string;
const PROFILE = "valentina";
const PEER = { name: "valentina-hermes", peer_type: "hermes", cwd: "/Users/mike/www/ai/trophy-master-mind" };
const T0 = 1_761_900_000; // 2026-10-31T09:20Z

function profileDb(): Database {
  const dir = join(hermesHome, "profiles", PROFILE);
  mkdirSync(join(dir, "runtime"), { recursive: true });
  const db = new Database(join(dir, "state.db"));
  db.exec(SCHEMA);
  return db;
}

function addSession(db: Database, id: string, title: string | null, opts: { source?: string; parent?: string | null; startedAt?: number; endReason?: string | null; archived?: number; modelConfig?: string | null; lastActivity?: number | null } = {}) {
  db.run(
    "INSERT INTO sessions (id, source, title, parent_session_id, started_at, last_activity_at, end_reason, archived, model_config) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, opts.source ?? "desktop", title, opts.parent ?? null, opts.startedAt ?? T0, opts.lastActivity ?? null, opts.endReason ?? null, opts.archived ?? 0, opts.modelConfig ?? null],
  );
}

function writeRegistry(entries: Array<{ session_id: string; surface: string; pid: number }>) {
  writeFileSync(join(hermesHome, "profiles", PROFILE, "runtime", "active_sessions.json"), JSON.stringify({ entries }));
}

/** A fake `hermes` that records argv and plays a script: HERMES_FAKE_OUT (text), HERMES_FAKE_EXIT, HERMES_FAKE_SLEEP. */
function installFakeHermes() {
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, "hermes");
  writeFileSync(script, `#!/bin/sh
printf '%s\\n' "$@" >> "$HERMES_FAKE_ARGS"
[ -n "$HERMES_FAKE_SLEEP" ] && sleep "$HERMES_FAKE_SLEEP"
[ -n "$HERMES_FAKE_OUT" ] && printf '%s\\n' "$HERMES_FAKE_OUT"
exit "\${HERMES_FAKE_EXIT:-0}"
`);
  chmodSync(script, 0o755);
  return script;
}

function driver(extra: { out?: string; exit?: number; sleep?: string; now?: () => Date; alive?: (pid: number) => boolean; start?: (pid: number) => string | null; backoff?: number[]; deadlineMs?: number } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HERMES_FAKE_ARGS: argsLog };
  if (extra.out !== undefined) env.HERMES_FAKE_OUT = extra.out;
  if (extra.exit !== undefined) env.HERMES_FAKE_EXIT = String(extra.exit);
  if (extra.sleep !== undefined) env.HERMES_FAKE_SLEEP = extra.sleep;
  return new HermesChatWakeDriver({
    hermesHome, stateDir, hermesBin: join(binDir, "hermes"), env, now: extra.now, pidAlive: extra.alive, processStart: extra.start,
    backoffScheduleMs: extra.backoff ?? [1000, 2000], deadlineMs: extra.deadlineMs ?? 60_000,
  });
}

function recordedArgs(): string[][] {
  try {
    return readFileSync(argsLog, "utf8").trimEnd().split("\n").reduce<string[][]>((acc, line) => {
      if (line === "-p") acc.push([]);
      acc[acc.length - 1]?.push(line);
      return acc;
    }, []);
  } catch {
    return [];
  }
}

async function settle(pred: () => boolean | Promise<boolean>, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await pred()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition not met in time");
}

const baseReq = (over: Partial<Parameters<HermesChatWakeDriver["wake"]>[0]> = {}) => ({
  peerName: PEER.name, profile: PROFILE, chatKey: "20261028_100000_aaaaaa", title: "Instagram ads", unread: 2, maxId: 10, ...over,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hermes-chat-wake-"));
  hermesHome = join(root, "hermes");
  stateDir = join(root, "state");
  binDir = join(root, "bin");
  argsLog = join(root, "args.log");
  installFakeHermes();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Directory

test("profile comes from the peer's persona prefix", () => {
  expect(hermesProfileForPeer(PEER)).toBe("valentina");
  expect(hermesProfileForPeer({ name: "ezra-hermes-2", peer_type: "hermes" })).toBe("ezra");
  expect(hermesProfileForPeer({ name: "hermes-abc", peer_type: "hermes" })).toBeNull();
});

test("resolve: exact case-insensitive title, exact id, near-miss candidates, ambiguity", () => {
  const db = profileDb();
  addSession(db, "20261028_100000_aaaaaa", "Instagram ads", { startedAt: T0 - 100 });
  addSession(db, "20261029_121224_2b437e", "Email triage", { startedAt: T0 - 50 });
  addSession(db, "20261029_000000_email1", "Instagram ads", { source: "email", startedAt: T0 }); // messaging row: never addressable
  addSession(db, "20261030_000000_archiv", "Instagram ads old", { archived: 1 });
  addSession(db, "local-cron-tick-000001", "Instagram ads run #3", { source: "oneshot" }); // cron tick: hidden like Hermes's picker
  addSession(db, "20261030_000000_subagt", "Subagent: Instagram ads evidence", { parent: "20261028_100000_aaaaaa", modelConfig: JSON.stringify({ _delegate_from: "20261028_100000_aaaaaa" }) });
  db.close();
  const dir = new HermesChatDirectory({ hermesHome });

  expect(dir.resolve(PEER, "instagram ADS ")).toEqual({ ok: true, chat_key: "20261028_100000_aaaaaa", title: "Instagram ads" });
  expect(dir.resolve(PEER, "20261029_121224_2b437e")).toEqual({ ok: true, chat_key: "20261029_121224_2b437e", title: "Email triage" });

  const miss = dir.resolve(PEER, "Instagram");
  expect(miss.ok).toBe(false);
  if (!miss.ok) {
    expect(miss.error).toContain('no chat titled "Instagram"');
    expect(miss.candidates.map((c) => c.chat_key)).toEqual(["20261028_100000_aaaaaa"]); // archived, email, cron and sub-agent rows excluded
    expect(miss.candidates[0]!.busy).toBe(false);
  }
  expect(dir.resolve(PEER, "general").ok).toBe(false);
  expect(dir.resolve(PEER, "20261030_000000_subagt").ok).toBe(true); // an exact id still resolves a hidden row
  expect(dir.list(PEER, { limit: 10, offset: 0 }).map((c) => c.chat_key)).toEqual(["20261029_121224_2b437e", "20261028_100000_aaaaaa"]);
  expect(dir.resolve({ name: "hermes-xyz", peer_type: "hermes" }, "Instagram ads").ok).toBe(false);

  const db2 = new Database(join(hermesHome, "profiles", PROFILE, "state.db"));
  addSession(db2, "20261031_000000_dupe00", "Instagram ads", { startedAt: T0 + 10 });
  db2.close();
  const dupe = dir.resolve(PEER, "Instagram ads");
  expect(dupe.ok).toBe(false);
  if (!dupe.ok) {
    expect(dupe.error).toContain("2 chats titled");
    expect(dupe.candidates.map((c) => c.chat_key)).toEqual(["20261031_000000_dupe00", "20261028_100000_aaaaaa"]);
  }
});

test("compression lineage collapses to the root key and the tip carries the title", () => {
  const db = profileDb();
  addSession(db, "root00", "Long chat", { startedAt: T0 - 300, endReason: "compression" });
  addSession(db, "seg001", "Long chat", { parent: "root00", startedAt: T0 - 200, endReason: "compression" });
  addSession(db, "tip002", "Long chat (renamed)", { parent: "seg001", startedAt: T0 - 100 });
  addSession(db, "fork03", "Branch", { parent: "root00", startedAt: T0 - 150, modelConfig: JSON.stringify({ _branched_from: "root00" }) });
  expect(lineageRoot(db, "tip002")).toBe("root00");
  expect(lineageRoot(db, "fork03")).toBe("fork03");
  expect(lineageTip(db, "root00")).toBe("tip002");
  db.close();
  const dir = new HermesChatDirectory({ hermesHome });
  expect(dir.resolve(PEER, "tip002")).toEqual({ ok: true, chat_key: "root00", title: "Long chat (renamed)" });
  expect(dir.resolve(PEER, "long chat")).toEqual({ ok: true, chat_key: "root00", title: "Long chat" });
  const keys = dir.list(PEER, { limit: 10, offset: 0 }).map((c) => c.chat_key);
  expect(keys).toEqual(["root00", "fork03"]);
});

test("list is newest first, paged, filtered, and marks chats held open", () => {
  const db = profileDb();
  addSession(db, "a", "Alpha", { startedAt: T0 - 300, lastActivity: T0 - 10 });
  addSession(db, "b", "Beta", { startedAt: T0 - 200 });
  addSession(db, "c", "Gamma alpha", { startedAt: T0 - 100 });
  db.close();
  writeRegistry([{ session_id: "b", surface: "desktop", pid: process.pid }]);
  const dir = new HermesChatDirectory({ hermesHome });
  const all = dir.list(PEER, { limit: 10, offset: 0 });
  expect(all.map((c) => c.chat_key)).toEqual(["a", "c", "b"]);
  expect(all.find((c) => c.chat_key === "b")!.busy).toBe(true);
  expect(all[0]!.last_active).toBe(new Date((T0 - 10) * 1000).toISOString());
  expect(dir.list(PEER, { limit: 1, offset: 1 }).map((c) => c.chat_key)).toEqual(["c"]);
  expect(dir.list(PEER, { query: "ALPHA", limit: 10, offset: 0 }).map((c) => c.chat_key)).toEqual(["a", "c"]);
  expect(dir.list({ name: "hermes-xyz", peer_type: "hermes" }, { limit: 5, offset: 0 })).toEqual([]);
});

// ---------------------------------------------------------------------------
// CLI classification

test("classifyHermesCliOutput: text beats the exit code", () => {
  expect(classifyHermesCliOutput(1, "This chat is open in another Hermes window/terminal.\nDetails: session x opened by desktop 0m ago").verdict).toBe("busy_desktop");
  expect(classifyHermesCliOutput(1, "error: session_already_owned").verdict).toBe("busy_desktop");
  expect(classifyHermesCliOutput(1, "runtime_coordination_required").verdict).toBe("busy_turn");
  expect(classifyHermesCliOutput(3, "Input required; detached without cancelling the turn.").verdict).toBe("input_required");
  expect(classifyHermesCliOutput(1, "Gateway disconnected; turn outcome is unknown").verdict).toBe("unknown");
  expect(classifyHermesCliOutput(1, "No session found matching 'x'").verdict).toBe("not_found");
  expect(classifyHermesCliOutput(0, "Done.").verdict).toBe("done");
  expect(classifyHermesCliOutput(null, "").verdict).toBe("unknown");
  expect(classifyHermesCliOutput(2, "usage: hermes").verdict).toBe("failed");
});

test("wake text names the chat key for check_messages and warns about an interrupted tail", () => {
  expect(defaultWakeText("valentina-hermes", "k1", "Instagram ads", false)).toContain('check_messages with chat="k1"');
  expect(defaultWakeText("valentina-hermes", null, null, false)).toContain("general Agent Peers mailbox");
  expect(defaultWakeText("valentina-hermes", "k1", null, true)).toContain("interrupted before it was answered");
  expect(defaultWakeText("valentina-hermes", "k1", null, false)).toContain("decision only Mike can make");
});

// ---------------------------------------------------------------------------
// Wake driver

test("wake launches hermes chat --resume <root id> -q detached, then settles to done and stays idle", async () => {
  const db = profileDb();
  addSession(db, "20261028_100000_aaaaaa", "Instagram ads");
  db.run("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261028_100000_aaaaaa','assistant','hi',?)", [T0]);
  db.close();
  const d = driver();
  const first = await d.wake(baseReq());
  expect(first.state).toBe("launched");
  expect(first.pid).toBeGreaterThan(0);
  await settle(async () => (await d.reconcile(PROFILE))[0]!.state === "done");

  const args = recordedArgs();
  expect(args).toHaveLength(1);
  expect(args[0]!.slice(0, 6)).toEqual(["-p", PROFILE, "chat", "--resume", "20261028_100000_aaaaaa", "-q"]);
  expect(args[0]![6]).toContain('chat="20261028_100000_aaaaaa"');
  expect(args[0]![6]).not.toContain("interrupted");

  const ledger = (await d.readLedger(PROFILE, "20261028_100000_aaaaaa"))!;
  expect(ledger.handled_max_id).toBe(10);
  expect(ledger.last_launch!.exit_code).toBe(0);
  expect(readFileSync(ledger.last_launch!.log_path, "utf8")).toContain("__HERMES_CHAT_WAKE_EXIT=0");

  // Same mail again: nothing launched. New mail: launched again.
  expect((await d.wake(baseReq())).state).toBe("done");
  expect((await d.wake(baseReq({ maxId: 11 }))).state).toBe("launched");
  await settle(async () => (await d.reconcile(PROFILE))[0]!.state === "done");
  expect(recordedArgs()).toHaveLength(2);
});

test("an interrupted user tail is flagged in the wake text", async () => {
  const db = profileDb();
  addSession(db, "20261028_100000_aaaaaa", "Instagram ads");
  db.run("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261028_100000_aaaaaa','user','do the thing',?)", [T0]);
  db.close();
  const d = driver();
  expect((await d.wake(baseReq())).state).toBe("launched");
  await settle(() => recordedArgs().length === 1);
  expect(recordedArgs()[0]![6]).toContain("interrupted before it was answered");
});

test("a chat held open in Desktop waits without launching and releases on the next tick after close", async () => {
  const db = profileDb();
  addSession(db, "20261028_100000_aaaaaa", "Instagram ads");
  db.close();
  writeRegistry([{ session_id: "20261028_100000_aaaaaa", surface: "desktop", pid: 4242 }]);
  const alive = (pid: number) => pid === 4242;
  const d = driver({ alive });
  const r = await d.wake(baseReq());
  expect(r.state).toBe("waiting_desktop");
  expect(r.detail).toContain("desktop (pid 4242)");
  expect(r.nextAttemptAt).toBeUndefined();
  expect(recordedArgs()).toHaveLength(0);
  // Still waiting on the next tick, no ladder consumed.
  expect((await d.wake(baseReq())).state).toBe("waiting_desktop");
  expect((await d.readLedger(PROFILE, "20261028_100000_aaaaaa"))!.attempts).toBe(0);
  // Chat closed (registry entry removed): the wake lands.
  writeRegistry([]);
  expect((await d.wake(baseReq())).state).toBe("launched");
  // A stale entry whose pid is dead is not a holder.
  writeRegistry([{ session_id: "20261028_100000_aaaaaa", surface: "desktop", pid: 999999 }]);
  await settle(async () => (await d.reconcile(PROFILE))[0]!.state === "done");
  expect((await d.wake(baseReq({ maxId: 11 }))).state).toBe("launched");
});

test("a live turn lease or a pending gateway admission waits every tick; dead-pid leases do not", async () => {
  const db = profileDb();
  addSession(db, "20261028_100000_aaaaaa", "Instagram ads");
  const nowS = Date.now() / 1000;
  db.run("INSERT INTO session_turn_leases VALUES ('20261028_100000_aaaaaa', 'pid=5151:host=studio:turn=t1:platform=desktop', ?, ?)", [nowS, nowS + 300]);
  db.close();
  const d = driver({ alive: (pid) => pid === 5151 });
  const r = await d.wake(baseReq());
  expect(r.state).toBe("waiting_turn");
  expect(r.detail).toContain("pid=5151");

  const dead = driver({ alive: () => false });
  const db2 = new Database(join(hermesHome, "profiles", PROFILE, "state.db"));
  db2.run("INSERT INTO session_admissions (admission_id, target_session_id, status) VALUES ('adm-0001-queued', '20261028_100000_aaaaaa', 'queued')");
  db2.close();
  const g = await dead.wake(baseReq());
  expect(g.state).toBe("waiting_gateway");
  expect(g.detail).toContain("adm-0001");

  const db3 = new Database(join(hermesHome, "profiles", PROFILE, "state.db"));
  db3.run("UPDATE session_admissions SET status = 'terminal'");
  db3.close();
  expect((await dead.wake(baseReq())).state).toBe("launched");
  await settle(() => recordedArgs().length === 1);
});

test("a running attempt is reported, not relaunched, and the deadline stops a hung client", async () => {
  const db = profileDb();
  addSession(db, "20261028_100000_aaaaaa", "Instagram ads");
  db.close();
  let clock = Date.parse("2026-10-31T10:00:00Z");
  const now = () => new Date(clock);
  const d = driver({ sleep: "30", now, deadlineMs: 5_000 });
  const first = await d.wake(baseReq());
  expect(first.state).toBe("launched");
  const again = await d.wake(baseReq({ maxId: 99 }));
  expect(again.state).toBe("running");
  expect(again.pid).toBe(first.pid);
  await settle(() => recordedArgs().length === 1);
  clock += 10_000; // past the deadline
  const after = await d.wake(baseReq());
  // The client was killed with no admission recorded: a failed launch, first rung of the ladder.
  expect(after.state).toBe("cooldown");
  expect(after.nextAttemptAt).toBe(new Date(clock + 1000).toISOString());
  await settle(() => { try { process.kill(first.pid!, 0); return false; } catch { return true; } });
});

test("the gateway ledger decides when the client lost the gateway", async () => {
  const db = profileDb();
  addSession(db, "20261028_100000_aaaaaa", "Instagram ads");
  db.close();
  const d = driver({ out: "Gateway disconnected; turn outcome is unknown", exit: 1 });
  expect((await d.wake(baseReq())).state).toBe("launched");
  await settle(() => recordedArgs().length === 1);
  await Bun.sleep(100);
  // Gateway still running the admitted turn: stay running.
  const db2 = new Database(join(hermesHome, "profiles", PROFILE, "state.db"));
  db2.run("INSERT INTO session_admissions (admission_id, target_session_id, status) VALUES ('adm-wake-0001', '20261028_100000_aaaaaa', 'started')");
  db2.close();
  await settle(async () => (await d.reconcile(PROFILE))[0]!.state === "running");
  expect((await d.wake(baseReq())).state).toBe("running");
  // Turn finished in the gateway: done, mail handled.
  const db3 = new Database(join(hermesHome, "profiles", PROFILE, "state.db"));
  db3.run("UPDATE session_admissions SET status = 'terminal'");
  db3.close();
  const settled = await d.wake(baseReq());
  expect(settled.state).toBe("done");
  expect(settled.detail).toContain("adm-wake terminal");
  expect((await d.readLedger(PROFILE, "20261028_100000_aaaaaa"))!.handled_max_id).toBe(10);
});

test("input required parks the chat until new mail; a failed launch walks the ladder to exhausted", async () => {
  const db = profileDb();
  addSession(db, "20261028_100000_aaaaaa", "Instagram ads");
  db.close();
  const parked = driver({ out: "Input required; detached without cancelling the turn.", exit: 3 });
  expect((await parked.wake(baseReq())).state).toBe("launched");
  await settle(async () => (await parked.reconcile(PROFILE))[0]!.state === "input_required");
  expect((await parked.wake(baseReq())).state).toBe("input_required");
  expect((await parked.wake(baseReq({ maxId: 11 }))).state).toBe("launched"); // new mail re-wakes
  await settle(async () => (await parked.reconcile(PROFILE))[0]!.state === "input_required");

  let clock = Date.parse("2026-10-31T11:00:00Z");
  const now = () => new Date(clock);
  const failing = driver({ out: "boom", exit: 2, now, backoff: [1000, 2000] });
  expect((await failing.wake(baseReq({ chatKey: "20261028_100000_aaaaaa", maxId: 12 }))).state).toBe("launched");
  await settle(async () => (await failing.reconcile(PROFILE))[0]!.state === "cooldown");
  let ledger = (await failing.readLedger(PROFILE, "20261028_100000_aaaaaa"))!;
  expect(ledger.attempts).toBe(1);
  expect(ledger.next_attempt_at).toBe(new Date(clock + 1000).toISOString());
  expect((await failing.wake(baseReq({ maxId: 12 }))).state).toBe("cooldown"); // inside the cooldown
  clock += 1500;
  expect((await failing.wake(baseReq({ maxId: 12 }))).state).toBe("launched");
  await settle(async () => (await failing.reconcile(PROFILE))[0]!.state === "cooldown");
  clock += 2500;
  expect((await failing.wake(baseReq({ maxId: 12 }))).state).toBe("launched");
  await settle(async () => (await failing.reconcile(PROFILE))[0]!.state === "exhausted");
  ledger = (await failing.readLedger(PROFILE, "20261028_100000_aaaaaa"))!;
  expect(ledger.attempts).toBe(3);
  expect((await failing.wake(baseReq({ maxId: 12 }))).state).toBe("exhausted");
  expect((await failing.pending(PROFILE)).map((l) => l.state)).toEqual(["exhausted"]);
  expect((await failing.wake(baseReq({ maxId: 13 }))).state).toBe("launched"); // new mail resets the ladder
});

test("general mailbox uses the profile's Agent Peers chat and creates it when missing", async () => {
  const db = profileDb();
  addSession(db, "20261028_100000_aaaaaa", "Instagram ads");
  db.close();
  const d = driver();
  expect((await d.wake(baseReq({ chatKey: null, title: null }))).state).toBe("launched");
  await settle(() => recordedArgs().length === 1);
  expect(recordedArgs()[0]!.slice(0, 8)).toEqual(["-p", PROFILE, "chat", "--source", "gui", "-c", "Agent Peers", "--create-if-missing"]);
  await settle(async () => (await d.reconcile(PROFILE))[0]!.state === "done");

  const db2 = new Database(join(hermesHome, "profiles", PROFILE, "state.db"));
  addSession(db2, "local-general-1", "Agent Peers", { source: "gui", startedAt: T0 + 5 });
  db2.close();
  expect((await d.wake(baseReq({ chatKey: null, title: null, maxId: 20 }))).state).toBe("launched");
  await settle(() => recordedArgs().length === 2);
  expect(recordedArgs()[1]!.slice(0, 5)).toEqual(["-p", PROFILE, "chat", "--resume", "local-general-1"]);
  expect(recordedArgs()[1]![6]).toContain("general Agent Peers mailbox");
});

test("unknown chat key, cancelled chat, and missing profile", async () => {
  profileDb().close();
  const d = driver();
  const gone = await d.wake(baseReq({ chatKey: "nope" }));
  expect(gone.state).toBe("not_found");
  expect(recordedArgs()).toHaveLength(0);
  await d.cancel(PROFILE, "20261028_100000_aaaaaa");
  expect((await d.wake(baseReq())).state).toBe("cancelled");
  await d.uncancel(PROFILE, "20261028_100000_aaaaaa");
  expect((await d.wake(baseReq())).state).toBe("not_found"); // row never existed in this test db
  const other = await d.wake(baseReq({ profile: "nobody", chatKey: "x" }));
  expect(other.state).toBe("not_found");
  expect(other.detail).toContain('no Hermes state for profile "nobody"');
});

// ---------------------------------------------------------------------------
// Desktop-plugin attempts (hermes-plugins/agent-peers-desktop-wake shares these ledgers)

const HOST = 4242;
const CHAT = "20261028_100000_aaaaaa";
const ATTEMPT = "a1b2c3d4e5f60718";
// Same vector as tests/python/test_hermes_desktop_wake.py LEDGER_VECTOR.
const LEDGER_VECTOR = "ad69ef69c99512d6b0e552be05c19843";

function ledgerFile(): string {
  return join(stateDir, "chat-wake", PROFILE, `${LEDGER_VECTOR}.json`);
}

function writeDesktopLedger(attempt: Partial<HermesDesktopAttempt>, over: Partial<HermesChatWakeLedger> = {}) {
  const now = new Date(T0 * 1000).toISOString();
  const ledger: HermesChatWakeLedger = {
    peer_name: PEER.name, profile: PROFILE, chat_key: CHAT, session_id: CHAT, title: "Instagram ads",
    state: "waiting_desktop", handled_max_id: 0, launched_max_id: 0, attempts: 0, next_attempt_at: null, last_launch: null,
    last_admission_id: null, detail: "desktop wake", updated_at: now,
    desktop_attempt: {
      attempt_id: ATTEMPT, chat_key: CHAT, session_key: CHAT, max_id: 10, host_pid: HOST,
      state: "accepted", created_at: now, accepted_at: now, detail: "queued", ...attempt,
    },
    ...over,
  };
  mkdirSync(join(stateDir, "chat-wake", PROFILE), { recursive: true });
  writeFileSync(ledgerFile(), JSON.stringify(ledger));
}

/** What the plugin's pre_llm_call / post_llm_call hooks write for the wake's own turn. */
function writeEvidence(kind: "started" | "ended", body?: string) {
  const dir = join(stateDir, "chat-wake", PROFILE, "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${ATTEMPT}.${kind}.json`), body ?? JSON.stringify({
    attempt_id: ATTEMPT, kind, turn_id: "t1", session_id: CHAT, pid: HOST, at: new Date(T0 * 1000).toISOString(),
  }));
}

function readLedgerFile(): HermesChatWakeLedger {
  return JSON.parse(readFileSync(ledgerFile(), "utf8")) as HermesChatWakeLedger;
}

function chatDb() {
  const db = profileDb();
  addSession(db, CHAT, "Instagram ads");
  return db;
}

const atT0 = (seconds = 0) => () => new Date((T0 + seconds) * 1000);
const hostOnly = (pid: number) => pid === HOST;

test("the ledger file name for a chat key matches the Python plugin", async () => {
  chatDb().close();
  await driver({ now: atT0(), alive: () => true }).cancel(PROFILE, CHAT);
  expect(readLedgerFile().state).toBe("cancelled");
});

test("an open desktop attempt in a live host blocks the gateway launch, even for newer mail", async () => {
  chatDb().close();
  writeDesktopLedger({});
  writeRegistry([{ session_id: CHAT, surface: "desktop", pid: HOST }]);
  const out = await driver({ now: atT0(3600), alive: hostOnly }).wake(baseReq({ chatKey: CHAT, maxId: 12 }));
  expect(out.state).toBe("waiting_desktop");
  expect(out.detail).toContain("accepted in pid 4242");
  // Closed with the wake still queued: Hermes drops it, and nothing proves that, so unknown.
  writeRegistry([]);
  expect((await driver({ now: atT0(3601), alive: hostOnly }).wake(baseReq({ chatKey: CHAT, maxId: 12 }))).state).toBe("desktop_unknown");
  expect(recordedArgs()).toEqual([]);
});

test("a dead host with no evidence is unknown and never re-woken automatically", async () => {
  chatDb().close();
  writeDesktopLedger({});
  const out = await driver({ now: atT0(5), alive: () => false }).wake(baseReq({ chatKey: CHAT, maxId: 10 }));
  expect(out.state).toBe("desktop_unknown");
  expect(readLedgerFile().desktop_attempt?.state).toBe("unknown");
  expect((await driver({ now: atT0(7200), alive: () => true }).wake(baseReq({ chatKey: CHAT, maxId: 30 }))).state).toBe("desktop_unknown");
  expect(recordedArgs()).toEqual([]);
});

test("only the plugin's end-of-turn evidence settles handled; transcript rows never do", async () => {
  const db = chatDb();
  writeRegistry([{ session_id: CHAT, surface: "desktop", pid: HOST }]);
  db.run("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)", [CHAT, `[agent-peers-wake ${ATTEMPT}] Agent Peers automation`, T0]);
  db.run("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, 'assistant', 'done', ?, 'stop')", [CHAT, T0]);
  db.close();
  writeDesktopLedger({});
  expect((await driver({ now: atT0(5), alive: hostOnly }).wake(baseReq({ chatKey: CHAT, maxId: 10 }))).state).toBe("waiting_desktop");
  writeEvidence("started");
  const running = await driver({ now: atT0(6), alive: hostOnly }).wake(baseReq({ chatKey: CHAT, maxId: 10 }));
  expect(running.detail).toContain("turn started in pid 4242");
  writeEvidence("ended");
  const out = await driver({ now: atT0(10), alive: () => false }).wake(baseReq({ chatKey: CHAT, maxId: 10 }));
  expect(out.state).toBe("done");
  const ledger = readLedgerFile();
  expect(ledger.handled_max_id).toBe(10);
  expect(ledger.launched_max_id).toBe(10);
  expect(ledger.last_desktop_attempt?.outcome).toBe("handled");
  expect(recordedArgs()).toEqual([]);
});

test("unreadable evidence, an unreadable registry, or a reused host pid is unknown", async () => {
  chatDb().close();
  writeRegistry([{ session_id: CHAT, surface: "desktop", pid: HOST }]);
  writeDesktopLedger({});
  writeEvidence("started", "{not json");
  expect((await driver({ now: atT0(5), alive: hostOnly }).wake(baseReq({ chatKey: CHAT }))).state).toBe("desktop_unknown");
  rmSync(join(stateDir, "chat-wake", PROFILE, "evidence"), { recursive: true });
  writeDesktopLedger({});
  writeFileSync(join(hermesHome, "profiles", PROFILE, "runtime", "active_sessions.json"), "{broken");
  expect((await driver({ now: atT0(5), alive: hostOnly }).wake(baseReq({ chatKey: CHAT }))).state).toBe("desktop_unknown");
  writeRegistry([{ session_id: CHAT, surface: "desktop", pid: HOST }]);
  writeDesktopLedger({ host_start: "Sat Nov  1 09:00:00 2026" });
  expect((await driver({ now: atT0(5), alive: hostOnly, start: () => "Sat Nov  1 09:00:00 2026" }).wake(baseReq({ chatKey: CHAT }))).state).toBe("waiting_desktop");
  expect((await driver({ now: atT0(5), alive: hostOnly, start: () => "Sat Nov  1 11:00:00 2026" }).wake(baseReq({ chatKey: CHAT }))).state).toBe("desktop_unknown");
  expect(recordedArgs()).toEqual([]);
});

test("a stale intent is unknown, blocks new mail, shows as pending, and only an operator clears it", async () => {
  chatDb().close();
  writeDesktopLedger({ state: "intent", accepted_at: null });
  writeRegistry([{ session_id: CHAT, surface: "desktop", pid: HOST }]);
  const d = driver({ now: atT0(120), alive: hostOnly });
  expect((await d.wake(baseReq({ chatKey: CHAT, maxId: 20 }))).state).toBe("desktop_unknown");
  expect((await d.pending(PROFILE)).map((l) => l.state)).toEqual(["desktop_unknown"]);
  writeRegistry([]);
  expect((await d.wake(baseReq({ chatKey: CHAT, maxId: 25 }))).state).toBe("desktop_unknown");
  expect(recordedArgs()).toEqual([]);
  const cleared = await d.clearDesktop(PROFILE, CHAT);
  expect(cleared?.last_desktop_attempt?.outcome).toBe("cleared");
  expect((await d.wake(baseReq({ chatKey: CHAT, maxId: 25 }))).state).toBe("launched");
});

test("clearDesktop --handled records the reviewed mail as handled", async () => {
  chatDb().close();
  writeDesktopLedger({ state: "unknown" }, { state: "desktop_unknown" });
  const d = driver({ now: atT0(5), alive: hostOnly });
  const cleared = await d.clearDesktop(PROFILE, CHAT, true);
  expect(cleared?.state).toBe("done");
  expect(cleared?.handled_max_id).toBe(10);
  expect((await d.wake(baseReq({ chatKey: CHAT, maxId: 10 }))).state).toBe("done");
  expect(recordedArgs()).toEqual([]);
});

test("cancellation survives settlement and operator clear", async () => {
  chatDb().close();
  writeDesktopLedger({}, { state: "cancelled" });
  const d = driver({ now: atT0(5), alive: () => false });
  expect((await d.reconcile(PROFILE)).map((l) => l.state)).toEqual(["cancelled"]);
  writeEvidence("ended");
  const [settled] = await d.reconcile(PROFILE);
  expect(settled?.state).toBe("cancelled");
  expect(settled?.last_desktop_attempt?.outcome).toBe("handled");
  writeDesktopLedger({ attempt_id: "ffffffffffffffff" }, { state: "cancelled" });
  expect((await d.clearDesktop(PROFILE, CHAT))?.state).toBe("cancelled");
  expect((await d.wake(baseReq({ chatKey: CHAT, maxId: 50 }))).state).toBe("cancelled");
  expect(recordedArgs()).toEqual([]);
});

test("the ledger lock: live and unparseable holders are kept; a dead holder's lock is broken", async () => {
  chatDb().close();
  mkdirSync(join(stateDir, "chat-wake", PROFILE), { recursive: true });
  const lock = `${ledgerFile()}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, start: null, token: "other" }));
  const busy = await new HermesChatWakeDriver({ hermesHome, stateDir, hermesBin: join(binDir, "hermes"), env: { ...process.env, HERMES_FAKE_ARGS: argsLog } })
    .wake(baseReq({ chatKey: CHAT }));
  expect(busy.detail).toContain("ledger locked");
  writeFileSync(lock, "");
  expect(await acquireLedgerLock(ledgerFile(), 0)).toBeNull();
  writeFileSync(lock, JSON.stringify({ pid: 999_999, start: null, token: "dead" }));
  const release = await acquireLedgerLock(ledgerFile(), 100);
  expect(release).not.toBeNull();
  await release!();
  expect(existsSync(lock)).toBe(false);
  expect(recordedArgs()).toEqual([]);
  expect((await driver({ now: atT0(), alive: () => true }).wake(baseReq({ chatKey: CHAT }))).state).toBe("launched");
});

test("the ledger lock is shared with the Python plugin", async () => {
  const ledger = join(root, "shared.json");
  const plugin = join(import.meta.dir, "..", "hermes-plugins", "agent-peers-desktop-wake", "__init__.py");
  const py = (code: string) => spawn("python3", ["-B", "-c", `
import importlib.util, sys, time
spec = importlib.util.spec_from_file_location("dw", sys.argv[1]); dw = importlib.util.module_from_spec(spec); spec.loader.exec_module(dw)
from pathlib import Path
${code}`, plugin, ledger], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = (child: ReturnType<typeof py>) => {
    let out = "";
    child.stdout!.on("data", (b) => { out += String(b); });
    return () => out;
  };
  // Python holds it: TypeScript must wait; when Python exits without releasing, the dead holder is reaped.
  const holder = py(`r = dw.acquire_lock(Path(sys.argv[2]), wait=0); print("held" if r else "busy", flush=True); time.sleep(1.2)`);
  const holderOut = lines(holder);
  await settle(() => holderOut().includes("held"));
  expect(await acquireLedgerLock(ledger, 0)).toBeNull();
  await new Promise((r) => holder.on("exit", r));
  const release = await acquireLedgerLock(ledger, 200);
  expect(release).not.toBeNull();
  // TypeScript holds it: Python is refused.
  const probe = py(`print("held" if dw.acquire_lock(Path(sys.argv[2]), wait=0) else "busy", flush=True)`);
  const probeOut = lines(probe);
  await new Promise((r) => probe.on("exit", r));
  expect(probeOut().trim()).toBe("busy");
  await release!();
});
