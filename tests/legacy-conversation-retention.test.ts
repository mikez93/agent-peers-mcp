import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  initDb, registerPeer, renamePeer, sendMessage, pollMessages, ackMessages,
  heartbeatPeer, setPeerSummary, unregisterPeer, gcOldMessages,
} from "../broker.ts";
import { findConversation, hasConversationSchema, type ConversationOwner } from "../shared/hermes-conversation-fence.ts";
import type { RegisterResponse } from "../shared/types.ts";

let root: string, dbPath: string, db: Database;
let legacy: RegisterResponse;
let owner: ConversationOwner;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ap-legacy-retention-"));
  dbPath = join(root, "broker.db");
  db = initDb(dbPath);
  legacy = registerPeer(db, { name: "legacy-hermes-chat", peer_type: "hermes", pid: process.pid,
    cwd: "/synthetic", git_root: null, tty: null, summary: "", durable: true });
  // Old on-disk layout, seeded directly so retention tests do not depend on a
  // deleted runtime or silently recreate it as production code.
  db.exec(`CREATE TABLE hermes_conversations (
    home TEXT NOT NULL, conversation_id TEXT NOT NULL, peer_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE, summary TEXT NOT NULL DEFAULT '', current_session_id TEXT NOT NULL,
    platform TEXT NOT NULL, backend_id TEXT NOT NULL, adapter_id TEXT NOT NULL,
    generation INTEGER NOT NULL, lifecycle_generation INTEGER NOT NULL, state TEXT NOT NULL,
    owner_lease_until INTEGER NOT NULL, observed_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(home, conversation_id)
  );
  CREATE TABLE hermes_conversation_tokens (peer_id TEXT PRIMARY KEY, session_token TEXT, generation INTEGER);
  CREATE TABLE hermes_conversation_segments (peer_id TEXT, session_id TEXT, PRIMARY KEY(peer_id, session_id));`);
  const now = Date.now();
  db.query(`INSERT INTO hermes_conversations
    (home,conversation_id,peer_id,name,current_session_id,platform,backend_id,adapter_id,
     generation,lifecycle_generation,state,owner_lease_until,observed_at,created_at,updated_at)
    VALUES (?,?,?,?,?,'desktop','backend-old','adapter-old',1,1,'active',?,?,?,?)`)
    .run(root, "saved-chat", legacy.id, legacy.name, "saved-session", now + 60_000, now, now, now);
  db.query("INSERT INTO hermes_conversation_tokens VALUES (?,?,1)").run(legacy.id, legacy.session_token);
  db.query("INSERT INTO hermes_conversation_segments VALUES (?,?)").run(legacy.id, "saved-session");
  db.query("INSERT INTO messages (from_id,to_id,text,sent_at,message_uid) VALUES (?,?,?,?,?)")
    .run("historical-sender", legacy.id, "retain this old unread body", "2000-01-01T00:00:00Z", "old-unread-uid");
  owner = { peer_id: legacy.id, generation: 1, backend_id: "backend-old", adapter_id: "adapter-old" };
});
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });

function ordinary(name = "ordinary") {
  return registerPeer(db, { name, peer_type: "claude", pid: process.pid,
    cwd: "/synthetic", git_root: null, tty: null, summary: "", durable: true });
}

test("broker reopen and GC preserve legacy tables, identity, segments and unread bodies", () => {
  const before = db.query("SELECT * FROM hermes_conversations").get();
  db.close();
  db = initDb(dbPath);
  expect(db.query("SELECT * FROM hermes_conversations").get()).toEqual(before);
  expect(db.query("SELECT * FROM hermes_conversation_segments").get())
    .toEqual({ peer_id: legacy.id, session_id: "saved-session" });
  expect(gcOldMessages(db)).toBe(0);
  expect(db.query("SELECT text,acked FROM messages").get())
    .toEqual({ text: "retain this old unread body", acked: 0 });
  expect(findConversation(db, legacy.name)?.peer_id).toBe(legacy.id);
});

test.each([false, true])("legacy reservations survive ordinary registration/rename (visible peer missing=%s)", missing => {
  if (missing) db.query("DELETE FROM peers WHERE id=?").run(legacy.id);
  const other = ordinary(legacy.name);
  expect(other.id).not.toBe(legacy.id);
  expect(other.name).not.toBe(legacy.name);
  expect(renamePeer(db, { id: other.id, session_token: other.session_token, new_name: legacy.name }))
    .toEqual({ ok: false, error: "name reserved by conversation" });
  expect(() => registerPeer(db, { name: "replacement", peer_type: "hermes", pid: process.pid,
    cwd: "/synthetic", git_root: null, tty: null, summary: "", prev_id: legacy.id }))
    .toThrow("conversation_mailbox_requires_exact_binding");
  expect(gcOldMessages(db)).toBe(0);
  expect(db.query("SELECT text FROM messages WHERE to_id=?").get(legacy.id))
    .toEqual({ text: "retain this old unread body" });
});

test("all reachable legacy operations retain owner fencing; valid loaded callers can still poll and ack", () => {
  const other = ordinary();
  const calls = [
    () => heartbeatPeer(db, legacy.id, legacy.session_token),
    () => unregisterPeer(db, legacy.id, legacy.session_token),
    () => setPeerSummary(db, legacy.id, legacy.session_token, "stolen"),
    () => sendMessage(db, { from_id: legacy.id, session_token: legacy.session_token, to_id_or_name: other.id, text: "stolen" }),
    () => pollMessages(db, legacy.id, legacy.session_token),
    () => ackMessages(db, { id: legacy.id, session_token: legacy.session_token, lease_tokens: [] }),
    () => renamePeer(db, { id: legacy.id, session_token: legacy.session_token, new_name: "stolen" }),
  ];
  for (const call of calls) expect(call).toThrow("stale_conversation_owner");
  expect(() => pollMessages(db, legacy.id, legacy.session_token, { ...owner, generation: 2 }))
    .toThrow("stale_conversation_owner");
  const messages = pollMessages(db, legacy.id, legacy.session_token, owner);
  expect(messages.map(m => m.text)).toEqual(["retain this old unread body"]);
  expect(db.query("SELECT acked FROM messages").get()).toEqual({ acked: 0 });
  expect(ackMessages(db, { id: legacy.id, session_token: legacy.session_token,
    lease_tokens: [messages[0]!.lease_token] }, owner).acked).toBe(1);
});

test("dormant legacy destinations still queue honestly without waking or creating a new identity", () => {
  const from = ordinary();
  db.query("UPDATE hermes_conversations SET state='closed' WHERE peer_id=?").run(legacy.id);
  const result = sendMessage(db, { from_id: from.id, session_token: from.session_token,
    to_id_or_name: legacy.name, text: "later message" });
  expect(result.ok).toBe(true);
  expect(result.notice).toBe("queued to dormant mailbox; recipient closed, will not be woken");
  expect(db.query("SELECT count(*) AS n FROM messages WHERE to_id=?").get(legacy.id)).toEqual({ n: 2 });
});

test("ordinary fresh broker databases do not install the retired schema", () => {
  const fresh = initDb(join(root, "fresh.db"));
  try { expect(hasConversationSchema(fresh)).toBe(false); } finally { fresh.close(); }
});

test.each(["explicit-disable", "disabled-file", "passive"] as const)(
  "an obsolete V2 flag preserves the %s startup gate", async gate => {
  if (gate === "disabled-file") {
    mkdirSync(join(root, "state"), { mode: 0o700 });
    writeFileSync(join(root, "state", "disabled"), "", { mode: 0o600 });
  }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(import.meta.dir, "..", "hermes-server.ts")], stderr: "pipe",
    env: { HOME: root, PATH: process.env.PATH ?? "", AGENT_PEERS_HERMES_V2: "1",
      AGENT_PEERS_ENABLED: gate === "explicit-disable" ? "0" : "1",
      AGENT_PEERS_HERMES_ROLE: gate === "passive" ? "passive" : "",
      AGENT_PEERS_PORT: "17992", AGENT_PEERS_DB: join(root, "unused.db"),
      AGENT_PEERS_STATE_DIR: join(root, "state") } });
  const client = new Client({ name: "v2-retirement-test", version: "1.0" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toEqual([]);
  } finally { await client.close(); }
});
