// End to end: a real hermes-server.ts process reads mail per chat (plan
// acceptance 3, "Isolation"). Chat A's mail is never seen or confirmed by a
// call from chat B or by a chatless call, and replies return to the chat.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAddressing, pollMessages, registerPeer, sendMessage, startBroker } from "../broker.ts";
import type { ChatDirectory, ChatCandidate } from "../shared/chat-directory.ts";

const root = mkdtempSync(join(tmpdir(), "hermes-chat-mail-"));
const EMAIL = "20261029_121224_2b437e";
const ADS = "20261028_100000_aaaaaa";
const CHATS: ChatCandidate[] = [
  { chat_key: EMAIL, title: "email shit", last_active: "2026-10-30T10:00:00Z" },
  { chat_key: ADS, title: "Instagram ads", last_active: "2026-10-29T10:00:00Z" },
];
const chats: ChatDirectory = {
  resolve(_peer, query) {
    const q = query.trim().toLowerCase();
    const hit = CHATS.find((c) => c.chat_key === query.trim() || (c.title ?? "").toLowerCase() === q);
    return hit ? { ok: true, chat_key: hit.chat_key, title: hit.title } : { ok: false, error: `no chat titled "${query}"`, candidates: [] };
  },
  list(_peer, opts) { return CHATS.slice(opts.offset, opts.offset + opts.limit); },
};

let broker: ReturnType<typeof startBroker>;
let client: Client;
let transport: StdioClientTransport;
let marco: { id: string; session_token: string };

beforeAll(async () => {
  broker = startBroker(0, join(root, "peers.db"), join(root, "secret"), "launchd");
  configureAddressing({ chats });
  marco = registerPeer(broker.db, { peer_type: "droid", name: "marco-droid", pid: process.pid, cwd: "/w/ops", git_root: null, tty: null, summary: "", durable: true });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", "hermes-server.ts")],
    cwd: root,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      AGENT_PEERS_ENABLED: "1",
      AGENT_PEERS_PORT: String(broker.server.port),
      AGENT_PEERS_DB: join(root, "peers.db"),
      AGENT_PEERS_SECRET_PATH: join(root, "secret"),
      AGENT_PEERS_STATE_DIR: join(root, "state"),
      AGENT_PEERS_AUTO_SUMMARY: "0",
      AGENT_PEERS_DISABLE_TAB_TITLE: "1",
      PEER_NAME: "valentina-hermes",
    },
  });
  client = new Client({ name: "hermes-chat-mail-test", version: "1.0.0" });
  await client.connect(transport, { timeout: 8000 });
});

afterAll(async () => {
  if (transport.pid) { try { process.kill(transport.pid, "SIGTERM"); } catch { /* gone */ } }
  await client.close();
  configureAddressing({});
  clearInterval(broker.gcTimer);
  broker.server.stop(true);
  broker.db.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  return (r.content as { text: string }[]).map((c) => c.text).join("");
}
const acked = (text: string) => broker.db.query<{ acked: number }, [string]>("SELECT acked FROM messages WHERE text = ?").get(text)?.acked;

test("registers with per-chat mail and exposes the chat arguments", async () => {
  const row = broker.db.query<{ capabilities: string | null }, [string]>("SELECT capabilities FROM peers WHERE name = ?").get("valentina-hermes");
  expect(row?.capabilities).toContain("chat-mail");
  const tools = (await client.listTools()).tools;
  const check = tools.find((t) => t.name === "check_messages")!;
  expect(Object.keys((check.inputSchema as { properties: object }).properties)).toContain("chat");
  const send = tools.find((t) => t.name === "send_message")!;
  expect(Object.keys((send.inputSchema as { properties: object }).properties)).toContain("from_chat");
  expect(tools.some((t) => t.name === "list_chats")).toBe(true);
});

test("each chat reads and confirms only its own mail", async () => {
  const s = (to: string, text: string) => expect(sendMessage(broker.db, { from_id: marco.id, session_token: marco.session_token, to_id_or_name: to, text }).ok).toBe(true);
  s("valentina-hermes/email shit", "A1 for email");
  s(`valentina-hermes/${ADS}`, "B1 for ads");
  s("valentina-hermes", "G1 general");

  // Chat B by title: sees B1 only.
  const b = await call("check_messages", { chat: "Instagram ads" });
  expect(b).toContain("B1 for ads");
  expect(b).not.toContain("A1 for email");
  expect(b).not.toContain("G1 general");
  expect(acked("B1 for ads")).toBe(0);

  // A second call from chat B (by ID this time) confirms B1, and still never A1.
  const b2 = await call("list_peers", { scope: "machine", chat: ADS });
  expect(b2).not.toContain("A1 for email");
  expect(acked("B1 for ads")).toBe(1);
  expect(acked("A1 for email")).toBe(0);

  // A chatless call reads the general mailbox only.
  const g = await call("check_messages");
  expect(g).toContain("G1 general");
  expect(g).not.toContain("A1 for email");

  // Chat A reads A1, then replies from the chat, which confirms A1.
  const a = await call("check_messages", { chat: EMAIL });
  expect(a).toContain("A1 for email");
  expect(acked("A1 for email")).toBe(0);
  const sent = await call("send_message", { to_id: "marco-droid", message: "re: A1", from_chat: EMAIL });
  expect(sent).toContain("Message sent");
  expect(acked("A1 for email")).toBe(1);

  // Marco sees the reply as coming from that chat, and can answer it directly.
  const [reply] = pollMessages(broker.db, marco.id, marco.session_token);
  expect(reply!.text).toBe("re: A1");
  expect(reply!.from_name).toBe(`valentina-hermes/${EMAIL}`);
  expect(sendMessage(broker.db, { from_id: marco.id, session_token: marco.session_token, to_id_or_name: reply!.from_id, text: "A2 thread reply" }).ok).toBe(true);
  const a2 = await call("check_messages", { chat: "email shit" });
  expect(a2).toContain("A2 thread reply");
}, 30000);

test("an unknown chat reads nothing and says so", async () => {
  const r = await call("check_messages", { chat: "no such chat" });
  expect(r).toContain('No chat "no such chat" was found');
});

test("list_chats returns exact addresses", async () => {
  const r = await call("list_chats", { peer: "valentina" });
  expect(r).toContain(`valentina-hermes/${EMAIL}`);
  expect(r).toContain('"Instagram ads"');
});

test("a member surface keeps its tools, leaves the durable name to the owner and reads its chat's mail", async () => {
  const memberTransport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", "hermes-server.ts")],
    cwd: root,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      AGENT_PEERS_ENABLED: "1",
      AGENT_PEERS_PORT: String(broker.server.port),
      AGENT_PEERS_DB: join(root, "peers.db"),
      AGENT_PEERS_SECRET_PATH: join(root, "secret"),
      AGENT_PEERS_STATE_DIR: join(root, "state-member"),
      AGENT_PEERS_AUTO_SUMMARY: "0",
      AGENT_PEERS_DISABLE_TAB_TITLE: "1",
      PEER_NAME: "valentina-hermes",
      AGENT_PEERS_HERMES_ROLE: "member",
    },
  });
  const member = new Client({ name: "hermes-member-test", version: "1.0.0" });
  await member.connect(memberTransport, { timeout: 8000 });
  try {
    const row = broker.db.query<{ name: string; durable: number; mailbox_owner: string | null; capabilities: string | null }, [number]>(
      "SELECT name, durable, mailbox_owner, capabilities FROM peers WHERE pid = ?").get(memberTransport.pid!);
    expect(row!.name).not.toBe("valentina-hermes");
    expect(row!.durable).toBe(0);
    expect(row!.mailbox_owner).toBe("valentina-hermes");
    expect(row!.capabilities).toContain("chat-mail");
    expect((await member.listTools()).tools.map((t) => t.name)).toContain("send_message");
    expect(sendMessage(broker.db, { from_id: marco.id, session_token: marco.session_token, to_id_or_name: "valentina-hermes/Instagram ads", text: "B2 via member" }).ok).toBe(true);
    const r = await member.callTool({ name: "check_messages", arguments: { chat: ADS } });
    expect((r.content as { text: string }[]).map((c) => c.text).join("")).toContain("B2 via member");
  } finally {
    if (memberTransport.pid) { try { process.kill(memberTransport.pid, "SIGTERM"); } catch { /* gone */ } }
    await member.close();
  }
}, 30000);
