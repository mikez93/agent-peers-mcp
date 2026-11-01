// Regressions for Marco's AP10806 review of 4e5fd81 (driver side). Uses only exports that
// 4e5fd81 also had, so this file runs unchanged against that commit (red) and this one (green).
// Finding 5 (opt-in recheck) is plugin-only: tests/python/test_hermes_desktop_wake.py Ap10806Regressions.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HermesChatWakeDriver, acquireLedgerLock, classifyDesktopAttempt, type HermesChatWakeLedger, type HermesDesktopAttempt,
} from "../shared/hermes-chat-wake.ts";

const PROFILE = "valentina";
const CHAT = "20261028_100000_aaaaaa";
const LEDGER_VECTOR = "ad69ef69c99512d6b0e552be05c19843";
const HOST = 4242;
const ATTEMPT = "a1b2c3d4e5f60718";
const T0 = 1_761_900_000;

let root: string;
let hermesHome: string;
let stateDir: string;
let argsLog: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "desktop-wake-regress-"));
  hermesHome = join(root, "hermes");
  stateDir = join(root, "state");
  argsLog = join(root, "args.log");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ledgerFile = () => join(stateDir, "chat-wake", PROFILE, `${LEDGER_VECTOR}.json`);

function attempt(over: Partial<HermesDesktopAttempt> = {}): HermesDesktopAttempt {
  const at = new Date(T0 * 1000).toISOString();
  return { attempt_id: ATTEMPT, chat_key: CHAT, session_key: CHAT, max_id: 10, host_pid: HOST, state: "accepted", created_at: at, accepted_at: at, detail: "", ...over };
}

function writeLedger(over: Partial<HermesChatWakeLedger> = {}, att: Partial<HermesDesktopAttempt> = {}) {
  const ledger: HermesChatWakeLedger = {
    peer_name: `${PROFILE}-hermes`, profile: PROFILE, chat_key: CHAT, session_id: CHAT, title: "t", state: "waiting_desktop",
    handled_max_id: 0, launched_max_id: 0, attempts: 0, next_attempt_at: null, last_launch: null, last_admission_id: null,
    detail: "", updated_at: new Date(T0 * 1000).toISOString(), desktop_attempt: attempt(att), ...over,
  };
  mkdirSync(join(stateDir, "chat-wake", PROFILE), { recursive: true });
  writeFileSync(ledgerFile(), JSON.stringify(ledger));
}

const readLedger = () => JSON.parse(readFileSync(ledgerFile(), "utf8")) as HermesChatWakeLedger;

function chatDb(): Database {
  const dir = join(hermesHome, "profiles", PROFILE);
  mkdirSync(join(dir, "runtime"), { recursive: true });
  writeFileSync(join(dir, "runtime", "active_sessions.json"), JSON.stringify({ entries: [{ session_id: CHAT, surface: "desktop", pid: HOST }] }));
  const db = new Database(join(dir, "state.db"));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, parent_session_id TEXT, started_at REAL NOT NULL,
    last_activity_at REAL, end_reason TEXT, archived INTEGER NOT NULL DEFAULT 0, model_config TEXT);
  CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, finish_reason TEXT);
  CREATE TABLE session_turn_leases (conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL, expires_at REAL NOT NULL);
  CREATE TABLE session_admissions (seq INTEGER PRIMARY KEY AUTOINCREMENT, admission_id TEXT NOT NULL UNIQUE, target_session_id TEXT NOT NULL, status TEXT NOT NULL);`);
  db.run("INSERT INTO sessions (id, source, title, started_at) VALUES (?, 'desktop', 't', ?)", [CHAT, T0]);
  return db;
}

function driver(alive: (pid: number) => boolean, seconds = 5) {
  return new HermesChatWakeDriver({
    hermesHome, stateDir, hermesBin: "/usr/bin/false", env: { ...process.env, HERMES_FAKE_ARGS: argsLog },
    now: () => new Date((T0 + seconds) * 1000), pidAlive: alive, backoffScheduleMs: [1000], deadlineMs: 60_000,
  });
}

const req = (maxId = 10) => ({ peerName: `${PROFILE}-hermes`, profile: PROFILE, chatKey: CHAT, title: "t", unread: 1, maxId });

test("AP10806-1: provisional verification rows are not the wake's turn ending", async () => {
  for (const reason of ["verification_required", "verify_hook_continue"]) {
    const db = chatDb();
    db.run("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)", [CHAT, `[agent-peers-wake ${ATTEMPT}] Agent Peers automation`, T0]);
    db.run("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, 'assistant', 'still verifying', ?, ?)", [CHAT, T0, reason]);
    db.close();
    writeLedger();
    const out = await driver((pid) => pid === HOST).wake(req());
    expect(out.state).not.toBe("done");
    expect(readLedger().handled_max_id).toBe(0);
    expect(readLedger().desktop_attempt).not.toBeNull();
    rmSync(hermesHome, { recursive: true, force: true });
  }
});

test("AP10806-2: unavailable evidence with a dead host is unknown, not lost, and does not re-wake", async () => {
  expect(classifyDesktopAttempt(null, attempt({ state: "unknown" }), false, false, Date.now())).toBe("unknown");
  writeLedger({}, { state: "unknown" }); // no state.db for the profile at all
  const out = await driver(() => false).wake(req());
  expect(out.state).toBe("desktop_unknown");
  expect(readLedger().desktop_attempt).not.toBeNull();
  expect(existsSync(argsLog)).toBe(false);
});

test("AP10806-3: a lock without a complete owner record is not taken over", async () => {
  const ledger = join(root, "chat.json");
  writeFileSync(`${ledger}.lock`, ""); // the state between another owner's create and its write
  expect(await acquireLedgerLock(ledger, 0)).toBeNull();
  expect(existsSync(`${ledger}.lock`)).toBe(true);
});

test("AP10806-3: a live holder is never reaped on age", async () => {
  const ledger = join(root, "chat.json");
  writeFileSync(`${ledger}.lock`, `${process.pid} ${Date.now() - 31_000}`);
  expect(await acquireLedgerLock(ledger, 0)).toBeNull();
  writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: process.pid, token: "someone-else" }));
  expect(await acquireLedgerLock(ledger, 0)).toBeNull();
});

test("AP10806-3: release removes only its own lock", async () => {
  const ledger = join(root, "chat.json");
  const release = await acquireLedgerLock(ledger, 0);
  expect(release).not.toBeNull();
  writeFileSync(`${ledger}.lock`, JSON.stringify({ pid: process.pid, token: "successor" }));
  await release!();
  expect(existsSync(`${ledger}.lock`)).toBe(true);
});

test("AP10806-4: settlement keeps an operator's cancel", async () => {
  chatDb().close();
  writeLedger({ state: "cancelled" });
  const [settled] = await driver(() => false).reconcile(PROFILE);
  expect(settled?.state).toBe("cancelled");
  expect(readLedger().state).toBe("cancelled");
});
