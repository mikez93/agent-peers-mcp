#!/usr/bin/env bun
// Switchover rehearsal: old code to new code on a copy of a real broker
// database, with old clients kept running across the swap, then a rollback.
// Everything runs on a test port with temp files; the live broker, database,
// secret and inboxes are only read (one consistent snapshot of the database).
//
//   bun scripts/rehearse-switchover.ts --old <old checkout> [--new <new checkout>] [--db <db to snapshot>]
//
// Phases:
//   1. old broker + old clients (+ one new client, to prove new-on-old)
//   2. new broker on the same database; the old clients keep their sessions
//   3. new clients next to the old ones
//   4. rollback: old broker on the migrated database, all clients keep going
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
    env: { PATH: process.env.PATH ?? "", HOME, AGENT_PEERS_PORT: String(PORT), AGENT_PEERS_DB: DB, AGENT_PEERS_SECRET_PATH: SECRET },
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
async function launch(label: string, checkout: string, runtime: "claude" | "codex" | "hermes", name: string): Promise<Agent> {
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

const t0 = Date.now();
try {
  // 1. old world
  phase = "1-old";
  console.log(`\nold startup: ${await startBroker(OLD)} ms`);
  const oc = await launch("old-claude", OLD, "claude", "rehearsal-old-claude");
  const ox = await launch("old-codex", OLD, "codex", "rehearsal-old-codex");
  const oh = await launch("old-hermes", OLD, "hermes", "rehearsal-old-hermes");
  const nOnOld = await launch("new-claude-on-old", NEW, "claude", "rehearsal-new-on-old");
  await allPairs([oc, ox, oh, nOnOld]);
  await listsPeers(oc, [ox.name, oh.name, nOnOld.name]);
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
  heartbeatsLanded([oc.name, ox.name, oh.name, nOnOld.name], swapStart);
  await allPairs([oc, ox, oh, nOnOld]);
  await listsPeers(ox, [oc.name, oh.name]);

  // 3. new clients beside the old ones
  phase = "3-mixed";
  const nc = await launch("new-claude", NEW, "claude", "rehearsal-new-claude");
  const nx = await launch("new-codex", NEW, "codex", "rehearsal-new-codex");
  const nh = await launch("new-hermes", NEW, "hermes", "rehearsal-new-hermes");
  check("new Hermes exposes the chat argument", nh.chatArg);
  await allPairs([oc, ox, oh, nc, nx, nh]);

  // 4. rollback: old broker on the migrated database
  phase = "4-rollback";
  const rbStart = Date.now();
  await stopBroker();
  console.log(`\nrollback startup: ${await startBroker(OLD)} ms`);
  preexistingMailIntact();
  await Bun.sleep(17000);
  heartbeatsLanded([oc.name, ox.name, oh.name, nc.name, nx.name, nh.name], rbStart);
  await allPairs([oc, ox, oh, nc, nx, nh]);
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
