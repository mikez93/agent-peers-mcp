#!/usr/bin/env bun
// Switchover rehearsal: old code to new code on a copy of a real broker
// database, with old clients kept running across the swap, then a rollback.
// Everything runs on a test port with temp files; the live broker, database,
// secret and inboxes are only read (one consistent snapshot of the database).
//
//   bun scripts/rehearse-switchover.ts --old <old checkout> [--new <new checkout>] [--db <db to snapshot>]
//
// Phases (Claude, Codex, Hermes and Droid adapters, old and new):
//   1. old broker + old clients (+ one new client, to prove new-on-old)
//   2. new broker on the same database; the old clients keep their sessions.
//      Chat-addressed mail to a Hermes owner still on old code lands in its
//      general mailbox, so no chat-tagged mail exists yet.
//   3. new clients next to the old ones; a new Hermes owner with per-chat mail:
//      A/B isolation, old clients replying into a chat, then A/B mail left unread
//   4. post-chat rollback target: a chat-aware broker restart keeps the pending
//      A/B mail isolated (no general poll takes it), then the chats drain it
//   5. old-tree rollback, allowed only once no chat-tagged mail is pending
//      (the runbook's gate), on the migrated database; all clients keep going
// Each phase sends mail in every direction and checks it arrives. Exit code 0
// means every check passed.

import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const OLD = resolve(arg("--old") ?? "");
const NEW = resolve(arg("--new", join(import.meta.dir, ".."))!);
const SOURCE_DB = resolve(arg("--db", join(homedir(), ".agent-peers.db"))!);
const PORT = Number(arg("--port", "7961"));
const KEEP = argv.includes("--keep");
if (!arg("--old")) { console.error("usage: rehearse-switchover.ts --old <old checkout> [--new <dir>] [--db <path>]"); process.exit(2); }

const root = mkdtempSync(join(tmpdir(), "ap-rehearsal-"));
const DB = join(root, "peers.db");
const SECRET = join(root, "secret");
const HOME = join(root, "home");
mkdirSync(HOME, { recursive: true });

// A fake Hermes home with two titled chats per rehearsal profile, read by the
// new broker's chat directory (profiles/<p>/state.db, sessions table).
const HERMES_HOME = join(HOME, ".hermes");
const CHAT_A = "20261101_000000_aaaaaa";
const CHAT_B = "20261101_000000_bbbbbb";
for (const profile of ["rehearsal-new", "rehearsal-old"]) {
  const dir = join(HERMES_HOME, "profiles", profile);
  mkdirSync(dir, { recursive: true });
  const st = new Database(join(dir, "state.db"));
  st.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, last_activity_at REAL, end_reason TEXT, archived INTEGER NOT NULL DEFAULT 0, model_config TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL);`);
  const now = Date.now() / 1000;
  st.query("INSERT INTO sessions (id, source, title, started_at) VALUES (?, 'cli', ?, ?)").run(CHAT_A, "Alpha chat", now);
  st.query("INSERT INTO sessions (id, source, title, started_at) VALUES (?, 'cli', ?, ?)").run(CHAT_B, "Beta chat", now);
  st.close();
}

const checks: { phase: string; name: string; ok: boolean; detail?: string }[] = [];
let phase = "setup";
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ phase, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${phase}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- snapshot the real database (read-only, consistent) ---------------------
function unackedByPeer(path: string): Map<string, number> {
  const db = new Database(path, { readonly: true });
  try {
    return new Map(db.query<{ to_id: string; n: number }, []>("SELECT to_id, COUNT(*) AS n FROM messages WHERE acked = 0 GROUP BY to_id").all().map((r) => [r.to_id, r.n]));
  } finally { db.close(); }
}
{
  const src = new Database(SOURCE_DB, { readonly: true });
  src.exec(`VACUUM INTO '${DB.replace(/'/g, "''")}'`);
  src.close();
}
const before = unackedByPeer(DB);
const peerCount = (() => { const d = new Database(DB, { readonly: true }); const n = d.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM peers").get()!.n; d.close(); return n; })();
console.log(`snapshot: ${SOURCE_DB} -> ${DB} (${peerCount} peers, ${[...before.values()].reduce((a, b) => a + b, 0)} unacked messages)`);

// ---- brokers -------------------------------------------------------------------
let broker: ReturnType<typeof Bun.spawn> | null = null;
async function startBroker(checkout: string) {
  broker = Bun.spawn([process.execPath, join(checkout, "broker.ts")], {
    stdout: "ignore", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME, HERMES_HOME, AGENT_PEERS_PORT: String(PORT), AGENT_PEERS_DB: DB, AGENT_PEERS_SECRET_PATH: SECRET },
  });
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json() as { pid?: number };
      if (h.pid === broker.pid) return Date.now() - started;
    } catch { /* starting */ }
    await Bun.sleep(100);
  }
  throw new Error(`broker from ${checkout} did not start`);
}
async function stopBroker() {
  if (!broker) return;
  broker.kill("SIGTERM");
  await broker.exited;
  broker = null;
}

// ---- clients --------------------------------------------------------------------
interface Agent { label: string; name: string; client: Client; transport: StdioClientTransport; chatArg: boolean }
const agents: Agent[] = [];
async function launch(label: string, checkout: string, runtime: "claude" | "codex" | "hermes" | "droid", name: string): Promise<Agent> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(checkout, `${runtime}-server.ts`)],
    cwd: root,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "", HOME,
      AGENT_PEERS_ENABLED: "1", AGENT_PEERS_SPAWN_BROKER: "1",
      AGENT_PEERS_PORT: String(PORT), AGENT_PEERS_DB: DB, AGENT_PEERS_SECRET_PATH: SECRET,
      AGENT_PEERS_STATE_DIR: join(root, `state-${label}`),
      AGENT_PEERS_AUTO_SUMMARY: "0", AGENT_PEERS_DISABLE_TAB_TITLE: "1",
      AGENT_PEERS_IDLE_POLL_MS: "300",
      PEER_NAME: name,
      // Live Hermes profiles run with V2 off; match them.
      ...(runtime === "hermes" ? { AGENT_PEERS_HERMES_V2: "0", HERMES_HOME } : {}),
    },
  });
  const client = new Client({ name: `rehearsal-${label}`, version: "1.0.0" });
  await client.connect(transport, { timeout: 15000 });
  const tools = (await client.listTools()).tools;
  const check = tools.find((t) => t.name === "check_messages");
  const agent = { label, name, client, transport, chatArg: !!(check?.inputSchema as { properties?: Record<string, unknown> })?.properties?.chat };
  agents.push(agent);
  return agent;
}
async function call(a: Agent, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await a.client.callTool({ name, arguments: args });
  return (r.content as { text?: string }[]).map((c) => c.text ?? "").join("");
}

let seq = 0;
async function exchange(from: Agent, to: Agent) {
  const token = `rehearsal-${phase}-${from.label}-to-${to.label}-${++seq}`;
  const sent = await call(from, "send_message", { to_id: to.name, message: token });
  if (!sent.includes("Message sent")) { check(`${from.label} -> ${to.label} send`, false, sent.slice(0, 200)); return; }
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const inbox = await call(to, "check_messages");
    if (inbox.includes(token)) { check(`${from.label} -> ${to.label}`, true); return; }
    await Bun.sleep(400);
  }
  check(`${from.label} -> ${to.label}`, false, "not delivered within 15 s");
}
async function allPairs(list: Agent[]) {
  for (const a of list) for (const b of list) if (a !== b) await exchange(a, b);
}
async function listsPeers(a: Agent, expectNames: string[]) {
  const out = await call(a, "list_peers", { scope: "machine" });
  const missing = expectNames.filter((n) => n !== a.name && !out.includes(n));
  check(`${a.label} list_peers sees the others`, missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : undefined);
}
function heartbeatsLanded(names: string[], since: number) {
  const db = new Database(DB, { readonly: true });
  try {
    for (const n of names) {
      const row = db.query<{ last_seen: string }, [string]>("SELECT last_seen FROM peers WHERE name = ?").get(n);
      check(`${n} still registered and live`, !!row && Date.parse(row.last_seen) >= since, row ? `last_seen ${row.last_seen}` : "row missing");
    }
  } finally { db.close(); }
}
function preexistingMailIntact() {
  const after = unackedByPeer(DB);
  const lost = [...before].filter(([id, n]) => (after.get(id) ?? 0) < n);
  check("pre-existing unacked mail intact", lost.length === 0, lost.length ? `${lost.length} mailbox(es) shrank` : `${before.size} mailboxes unchanged`);
}

function row(text: string) {
  const db = new Database(DB, { readonly: true });
  try {
    return db.query<{ acked: number; to_chat: string | null }, [string]>("SELECT acked, to_chat FROM messages WHERE text = ?").get(text);
  } finally { db.close(); }
}
/** The runbook's old-tree rollback gate: unread chat-tagged mail must be zero. */
function pendingChatMail(): number {
  const db = new Database(DB, { readonly: true });
  try {
    return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM messages WHERE acked = 0 AND to_chat IS NOT NULL").get()!.n;
  } finally { db.close(); }
}
async function sendOk(from: Agent, to: string, message: string, extra: Record<string, unknown> = {}) {
  const r = await call(from, "send_message", { to_id: to, message, ...extra });
  check(`${from.label} sends "${message}" to ${to}`, r.includes("Message sent"), r.includes("Message sent") ? undefined : r.slice(0, 200));
}
async function inboxShows(a: Agent, args: Record<string, unknown>, want: string[], never: string[], what: string) {
  const out = await call(a, "check_messages", args);
  const missing = want.filter((t) => !out.includes(t));
  const leaked = never.filter((t) => out.includes(t));
  check(what, missing.length === 0 && leaked.length === 0,
    [missing.length ? `missing ${missing.join(", ")}` : "", leaked.length ? `leaked ${leaked.join(", ")}` : ""].filter(Boolean).join("; ") || undefined);
  return out;
}

const t0 = Date.now();
try {
  // 1. old world
  phase = "1-old";
  console.log(`\nold startup: ${await startBroker(OLD)} ms`);
  const oc = await launch("old-claude", OLD, "claude", "rehearsal-old-claude");
  const ox = await launch("old-codex", OLD, "codex", "rehearsal-old-codex");
  const oh = await launch("old-hermes", OLD, "hermes", "rehearsal-old-hermes");
  const od = await launch("old-droid", OLD, "droid", "rehearsal-old-droid");
  const nOnOld = await launch("new-claude-on-old", NEW, "claude", "rehearsal-new-on-old");
  const oldWorld = [oc, ox, oh, od, nOnOld];
  await allPairs(oldWorld);
  await listsPeers(oc, [ox.name, oh.name, od.name, nOnOld.name]);
  const chatsOnOld = await call(nOnOld, "list_chats", { peer: "rehearsal-old-hermes" });
  check("new client tolerates an old broker without chat lookup", chatsOnOld.includes("not available"), chatsOnOld.slice(0, 120));

  // 2. swap the broker; old clients keep their sessions
  phase = "2-new-broker";
  const swapStart = Date.now();
  await stopBroker();
  const startMs = await startBroker(NEW);
  console.log(`\nswap: broker down ${Date.now() - swapStart} ms (new startup ${startMs} ms)`);
  {
    const db = new Database(DB, { readonly: true });
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().map((c) => c.name);
    check("v3 migration applied", cols.includes("to_chat") && cols.includes("from_chat"));
    db.close();
  }
  preexistingMailIntact();
  await Bun.sleep(17000); // one client heartbeat cycle (15 s)
  heartbeatsLanded(oldWorld.map((a) => a.name), swapStart);
  await allPairs(oldWorld);
  await listsPeers(ox, [oc.name, oh.name, od.name]);
  // Before a Hermes owner reloads (step C), chat-addressed mail goes to its
  // general mailbox with a notice, so the database holds no chat-tagged rows.
  await sendOk(ox, `${oh.name}/Alpha chat`, "prechat-to-old-hermes");
  check("chat address to a not-yet-reloaded owner is stored as general mail", row("prechat-to-old-hermes")?.to_chat === null);
  {
    const end = Date.now() + 15000; let seen = false;
    while (!seen && Date.now() < end) { seen = (await call(oh, "check_messages")).includes("prechat-to-old-hermes"); if (!seen) await Bun.sleep(400); }
    check("the old Hermes owner receives it", seen);
  }
  check("no chat-tagged mail before step C, so old-tree rollback is safe here", pendingChatMail() === 0);

  // 3. new clients beside the old ones
  phase = "3-mixed";
  const nc = await launch("new-claude", NEW, "claude", "rehearsal-new-claude");
  const nx = await launch("new-codex", NEW, "codex", "rehearsal-new-codex");
  const nh = await launch("new-hermes", NEW, "hermes", "rehearsal-new-hermes");
  const nd = await launch("new-droid", NEW, "droid", "rehearsal-new-droid");
  check("new Hermes exposes the chat argument", nh.chatArg);
  {
    const d = new Database(DB, { readonly: true });
    const caps = d.query<{ capabilities: string | null }, [string]>("SELECT capabilities FROM peers WHERE name = ?").get(nh.name)?.capabilities ?? "";
    d.close();
    check("new Hermes owner registered with per-chat mail", caps.includes("chat-mail"), caps);
  }
  const everyone = [oc, ox, oh, od, nc, nx, nh, nd];
  await allPairs(everyone);

  // Chat isolation with old and new senders.
  await sendOk(ox, `${nh.name}/Alpha chat`, "A1-from-old-codex");
  await sendOk(od, `${nh.name}/${CHAT_B}`, "B1-from-old-droid");
  await sendOk(oc, nh.name, "G1-from-old-claude");
  check("chat mail is tagged with its chat", row("A1-from-old-codex")?.to_chat === CHAT_A && row("B1-from-old-droid")?.to_chat === CHAT_B);
  await inboxShows(nh, { chat: "Alpha chat" }, ["A1-from-old-codex"], ["B1-from-old-droid", "G1-from-old-claude"], "chat A reads only chat A mail");
  await inboxShows(nh, { chat: CHAT_B }, ["B1-from-old-droid"], ["A1-from-old-codex", "G1-from-old-claude"], "chat B reads only chat B mail");
  await inboxShows(nh, {}, ["G1-from-old-claude"], ["A1-from-old-codex", "B1-from-old-droid"], "a chatless call reads only general mail");
  await call(nh, "list_peers", { scope: "machine", chat: "Alpha chat" });
  await call(nh, "list_peers", { scope: "machine", chat: "Beta chat" });
  await call(nh, "list_peers", { scope: "machine" });
  check("each partition confirms only its own mail on its next call",
    row("A1-from-old-codex")?.acked === 1 && row("B1-from-old-droid")?.acked === 1 && row("G1-from-old-claude")?.acked === 1);

  // A reply from chat A reaches an old client, whose answer returns to chat A.
  await sendOk(nh, ox.name, "from-alpha-to-old-codex", { from_chat: "Alpha chat" });
  {
    const end = Date.now() + 15000; let out = "";
    while (!out.includes("from-alpha-to-old-codex") && Date.now() < end) { out = await call(ox, "check_messages"); if (!out.includes("from-alpha-to-old-codex")) await Bun.sleep(400); }
    check("old client sees the chat as the sender", out.includes(`${nh.name}/${CHAT_A}`));
  }
  await sendOk(ox, `${nh.name}/${CHAT_A}`, "reply-into-alpha");
  await inboxShows(nh, { chat: CHAT_A }, ["reply-into-alpha"], [], "the old client's reply lands in chat A");
  await call(nh, "list_peers", { scope: "machine", chat: CHAT_A });

  // Leave chat mail unread for the rollback phases.
  await sendOk(nx, `${nh.name}/Alpha chat`, "A2-pending");
  await sendOk(nd, `${nh.name}/Beta chat`, "B2-pending");
  check("pending chat mail closes the old-tree rollback gate", pendingChatMail() === 2, `pending ${pendingChatMail()}`);

  // 4. post-chat rollback target: restart on a chat-aware broker
  phase = "4-chat-aware-restart";
  const caStart = Date.now();
  await stopBroker();
  console.log(`\nchat-aware restart: ${await startBroker(NEW)} ms`);
  preexistingMailIntact();
  await Bun.sleep(17000); // heartbeats, and several background general polls by the Hermes owner
  heartbeatsLanded(everyone.map((a) => a.name), caStart);
  check("pending chat mail kept its chats across the restart",
    row("A2-pending")?.to_chat === CHAT_A && row("A2-pending")?.acked === 0 && row("B2-pending")?.to_chat === CHAT_B && row("B2-pending")?.acked === 0);
  await inboxShows(nh, {}, [], ["A2-pending", "B2-pending"], "the owner's general poll does not take pending chat mail");
  await inboxShows(nh, { chat: "Beta chat" }, ["B2-pending"], ["A2-pending"], "chat B drains only its own pending mail");
  await inboxShows(nh, { chat: "Alpha chat" }, ["A2-pending"], ["B2-pending"], "chat A drains only its own pending mail");
  await call(nh, "list_peers", { scope: "machine", chat: "Beta chat" });
  await call(nh, "list_peers", { scope: "machine", chat: "Alpha chat" });
  check("drained: old-tree rollback gate open", pendingChatMail() === 0, `pending ${pendingChatMail()}`);
  await allPairs(everyone);

  // 5. old-tree rollback: old broker on the migrated database, gate open
  phase = "5-old-tree-rollback";
  const rbStart = Date.now();
  await stopBroker();
  console.log(`\nrollback startup: ${await startBroker(OLD)} ms`);
  preexistingMailIntact();
  await Bun.sleep(17000);
  heartbeatsLanded(everyone.map((a) => a.name), rbStart);
  await allPairs(everyone);
} catch (e) {
  check("rehearsal ran to completion", false, e instanceof Error ? e.message : String(e));
} finally {
  for (const a of agents) {
    if (a.transport.pid) { try { process.kill(a.transport.pid, "SIGTERM"); } catch { /* gone */ } }
    try { await a.client.close(); } catch { /* gone */ }
  }
  await stopBroker();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed in ${Math.round((Date.now() - t0) / 1000)} s${failed.length ? `; FAILED: ${failed.map((f) => `[${f.phase}] ${f.name}`).join("; ")}` : ""}`);
  if (!KEEP) rmSync(root, { recursive: true, force: true }); else console.log(`kept ${root}`);
  process.exit(failed.length ? 1 : 0);
}
