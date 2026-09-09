import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { initDb, registerPeer, sendMessage } from "../broker.ts";
import type { ConversationBinding } from "../shared/hermes-conversation-bindings.ts";

let root: string;
let home: string;
let db: Database;
const backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721";
const connections: { client: Client; transport: StdioClientTransport }[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hermes-runtime-")));
  home = join(root, "profile");
  mkdirSync(home, { mode: 0o700 });
  db = initDb(join(root, "broker.db"));
});
afterEach(async () => {
  for (const { client, transport } of connections.splice(0)) {
    if (transport.pid) { try { process.kill(transport.pid, "SIGTERM"); } catch {} }
    await client.close();
    await transport.close();
  }
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function meta(id: string, session = id) {
  return { "hermes/home": home, "hermes/backend_id": backend, "hermes/conversation_id": id,
    "hermes/session_id": session, "hermes/platform": "desktop" };
}
async function connect(overrides: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(import.meta.dir, "../hermes-server.ts")],
    cwd: root, stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", AGENT_PEERS_ENABLED: "1",
      AGENT_PEERS_HERMES_V2: "1", AGENT_PEERS_HERMES_HOME: home,
      AGENT_PEERS_HERMES_BACKEND_ID: backend, AGENT_PEERS_DB: join(root, "broker.db"),
      AGENT_PEERS_STATE_DIR: join(root, "inboxes"), AGENT_PEERS_CWD: root,
      PEER_NAME: "fixture-hermes", ...overrides },
  });
  const client = new Client({ name: "strict-fixture-host", version: "1" });
  connections.push({ client, transport });
  await client.connect(transport, { timeout: 3_000 });
  return { client, transport };
}
function binding(id: string) {
  return db.query<ConversationBinding, [string]>("SELECT * FROM hermes_conversations WHERE conversation_id=?").get(id)!;
}

test("real v2 stdio registers only after strict metadata and multiplexes private A/B mail", async () => {
  const { client, transport } = await connect();
  expect((await client.listTools()).tools).toHaveLength(6);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM peers").get()!.n).toBe(0);
  await expect(client.callTool({ name: "check_messages" })).rejects.toThrow("session_context_required");
  await expect(client.callTool({ name: "check_messages", _meta: { ...meta("a"), "hermes/home": root } })).rejects.toThrow("mismatch");
  await Promise.all(["a", "b"].map(id => client.callTool({ name: "set_summary", arguments: { summary: `task-${id}` }, _meta: meta(id) })));
  const a = binding("a");
  const b = binding("b");
  expect(a.peer_id).not.toBe(b.peer_id);
  expect(a.summary).toBe("task-a");
  expect(b.summary).toBe("task-b");
  const pids = db.query<{ pid: number }, []>("SELECT DISTINCT pid FROM peers").all();
  expect(pids).toEqual([{ pid: transport.pid! }]);
  const sender = registerPeer(db, { peer_type: "claude", name: "legacy-owner", durable: true,
    pid: process.pid, cwd: root, git_root: null, tty: null, summary: "" });
  const sent = sendMessage(db, { from_id: sender.id, session_token: sender.session_token, to_id_or_name: a.peer_id, text: "PRIVATE_A" });
  expect(sent.ok).toBe(true);
  expect(JSON.stringify(await client.callTool({ name: "check_messages", _meta: meta("b") }))).not.toContain("PRIVATE_A");
  expect(JSON.stringify(await client.callTool({ name: "check_messages", _meta: meta("a") }))).toContain("PRIVATE_A");
  expect(db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?").get(sent.message_id!)!.acked).toBe(0);
  await client.callTool({ name: "check_messages", _meta: meta("b") });
  expect(db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?").get(sent.message_id!)!.acked).toBe(0);
  await client.callTool({ name: "check_messages", _meta: meta("a", "compressed-a") });
  expect(binding("a").peer_id).toBe(a.peer_id);
  expect(binding("a").current_session_id).toBe("compressed-a");
  expect(db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?").get(sent.message_id!)!.acked).toBe(1);
  expect(db.query("SELECT 1 FROM peers WHERE id=?").get(sender.id)).not.toBeNull();
});

test("v2 duplicate MCP child for one backend is inert, not a second identity owner", async () => {
  const first = await connect();
  const second = await connect();
  expect((await first.client.listTools()).tools).toHaveLength(6);
  expect((await second.client.listTools()).tools).toHaveLength(0);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM hermes_adapter_processes").get()!.n).toBe(1);
});

test.each<Record<string, string>>([
  { AGENT_PEERS_ENABLED: "0" },
  { AGENT_PEERS_HERMES_ROLE: "passive" },
  { PAPERCLIP_AGENT_ID: "fixture-company-agent" },
])("v2 containment gates run before DB/schema/config work: %j", async overrides => {
  const { client } = await connect({ ...overrides, AGENT_PEERS_HERMES_BACKEND_ID: "", AGENT_PEERS_DB: "/not/a/database" });
  expect((await client.listTools()).tools).toHaveLength(0);
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name='hermes_conversations'").get()).toBeNull();
});

test("v2 global disabled file wins and malformed host UUID fails closed", async () => {
  mkdirSync(join(root, "inboxes"), { mode: 0o700 });
  writeFileSync(join(root, "inboxes", "disabled"), "", { mode: 0o600 });
  const disabled = await connect({ AGENT_PEERS_HERMES_BACKEND_ID: "" });
  expect((await disabled.client.listTools()).tools).toHaveLength(0);
  await expect(connect({ AGENT_PEERS_STATE_DIR: join(root, "other"), AGENT_PEERS_HERMES_BACKEND_ID: "not-uuid" }))
    .rejects.toThrow();
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name='hermes_conversations'").get()).toBeNull();
});

test("only canonical host-owned profile bridge is accepted, never generic HERMES_HOME", async () => {
  await expect(connect({ AGENT_PEERS_HERMES_HOME: "", HERMES_HOME: home })).rejects.toThrow();
  await expect(connect({ AGENT_PEERS_HERMES_HOME: `${home}/.` })).rejects.toThrow();
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name='hermes_conversations'").get()).toBeNull();
});

test("existing unsafe WAL/SHM permissions refuse v2 before registration", async () => {
  chmodSync(join(root, "broker.db-wal"), 0o644);
  chmodSync(join(root, "broker.db-shm"), 0o644);
  await expect(connect()).rejects.toThrow();
  expect(db.query("SELECT 1 FROM sqlite_master WHERE name='hermes_conversations'").get()).toBeNull();
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM peers").get()!.n).toBe(0);
});

test("redispatched superseded segment cannot reverse compression binding", async () => {
  const { client } = await connect();
  await client.callTool({ name: "check_messages", _meta: meta("a", "before-compression") });
  await client.callTool({ name: "check_messages", _meta: meta("a", "after-compression") });
  await expect(client.callTool({ name: "check_messages", _meta: meta("a", "before-compression") }))
    .rejects.toThrow("superseded_conversation_segment");
  expect(binding("a").current_session_id).toBe("after-compression");
});

test("shutdown during asynchronous startup never connects a transport afterward", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/hermes-runtime-startup-stop.ts")], {
    env: { PATH: process.env.PATH ?? "", AGENT_PEERS_ENABLED: "1",
      AGENT_PEERS_HERMES_HOME: home, AGENT_PEERS_HERMES_BACKEND_ID: backend,
      AGENT_PEERS_DB: join(root, "broker.db"), AGENT_PEERS_STATE_DIR: join(root, "inboxes"),
      AGENT_PEERS_CWD: root },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout).starts).toBe(0);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM hermes_adapter_processes").get()!.n).toBe(0);
});

test("MCP-only SIGKILL/replacement retains UUID and unread mail with one current backend claim", async () => {
  const first = await connect();
  await first.client.callTool({ name: "check_messages", _meta: meta("a") });
  const a = binding("a");
  const sender = registerPeer(db, { peer_type: "claude", pid: process.pid, cwd: root, git_root: null, tty: null, summary: "" });
  sendMessage(db, { from_id: sender.id, session_token: sender.session_token, to_id_or_name: a.peer_id, text: "SURVIVES_MCP_KILL" });
  await first.client.callTool({ name: "check_messages", _meta: meta("a") });
  process.kill(first.transport.pid!, "SIGKILL");
  await first.client.close();
  await first.transport.close();
  const next = await connect();
  expect(JSON.stringify(await next.client.callTool({ name: "check_messages", _meta: meta("a") }))).toContain("SURVIVES_MCP_KILL");
  expect(binding("a").peer_id).toBe(a.peer_id);
  expect(binding("a").generation).toBe(a.generation + 1);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM hermes_adapter_processes").get()!.n).toBe(1);
}, 10_000);
