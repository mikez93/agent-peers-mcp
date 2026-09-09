import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HermesConversationAdapter, HERMES_CONVERSATION_TOOLS,
  type ConversationBrokerPort, type ConversationCredential,
} from "../shared/hermes-conversation-adapter.ts";
import { conversationKey } from "../shared/hermes-conversation-context.ts";
import type { LeasedMessage } from "../shared/types.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHermesConversationMcp } from "../shared/hermes-conversation-mcp.ts";

const home = "/fixture/profile";
const backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721";
const roots: string[] = [];
const adapters: HermesConversationAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(a => a.stop()));
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
function meta(id: string, session = id) {
  return { "hermes/home": home, "hermes/backend_id": backend,
    "hermes/conversation_id": id, "hermes/session_id": session, "hermes/platform": "desktop" };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hermes-adapter-"));
  roots.push(root);
  const calls: { id: string; tool: string }[] = [];
  const messages = new Map<string, LeasedMessage[]>();
  const acks: { id: string; tokens: string[] }[] = [];
  const owners = new Map<string, ConversationCredential>();
  const contexts: string[] = [];
  const port: ConversationBrokerPort = {
    async bind(ctx) {
      contexts.push(ctx.session_id);
      const key = conversationKey(ctx);
      let owner = owners.get(key);
      if (!owner) {
        owner = { peer_id: ctx.conversation_id, name: ctx.conversation_id,
          backend_id: backend, adapter_id: "adapter", generation: 1, session_token: key, inbox_root: root };
        owners.set(key, owner);
      }
      return owner;
    },
    async poll(owner) { return messages.get(owner.peer_id) ?? []; },
    async ack(owner, tokens) {
      acks.push({ id: owner.peer_id, tokens });
      messages.set(owner.peer_id, (messages.get(owner.peer_id) ?? []).filter(m => !tokens.includes(m.lease_token)));
      return { ok: true, acked: tokens.length };
    },
    async invoke(owner, tool) { calls.push({ id: owner.peer_id, tool }); return owner.peer_id; },
    async release(owner) { calls.push({ id: owner.peer_id, tool: "release" }); },
  };
  const adapter = new HermesConversationAdapter({ home, backend_id: backend, inboxRoot: root, broker: port });
  adapters.push(adapter);
  const call = (id: string, name = "check_messages", args = {}, signal?: AbortSignal) =>
    adapter.call({ name, arguments: args, _meta: meta(id) }, signal);
  return { adapter, port, call, calls, messages, acks, owners, contexts };
}
function message(id: number, to: string, from = "sender"): LeasedMessage {
  return { id, to_id: to, from_id: from, from_name: from, from_peer_type: "hermes",
    from_cwd: "/fixture", from_summary: "", text: `private-${to}-${id}`, sent_at: new Date().toISOString(),
    lease_token: `lease-${id}` };
}

test("terminal notification during an empty poll cannot park a new waiter afterward", async () => {
  const f = await fixture();
  await f.call("a");
  const owner = [...f.owners.values()][0]!, entered = deferred(), release = deferred();
  f.port.poll = async () => { entered.resolve(); await release.promise; return []; };
  const waiting = f.call("a", "wait_for_peer_messages", { timeout_ms: 60_000 }).catch(error => error as Error);
  await entered.promise;
  const draining = f.adapter.drainFenced(meta("a"), owner);
  release.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.all([waiting, draining]).then(([error]) => error as Error),
      new Promise<Error>(resolve => { timer = setTimeout(() => resolve(new Error("drain_stalled")), 100); }),
    ]);
    expect(result.message).toBe("conversation_closing");
    expect(f.adapter.resources()).toEqual({ identities: 0, calls: 0, waiters: 0, timers: 0, pendingAcks: 0 });
    expect(f.acks).toEqual([]);
  } finally {
    if (timer) clearTimeout(timer);
    await f.adapter.stop();
    await Promise.all([waiting, draining]);
  }
});

test("all six tools select immutable per-call identity, never model arguments", async () => {
  const f = await fixture();
  for (const tool of HERMES_CONVERSATION_TOOLS) {
    await Promise.all(["a", "b"].map(id => f.call(id, tool, { timeout_ms: 0, id: "forged", peer_id: "forged" })));
  }
  expect(f.owners.size).toBe(2);
  for (const tool of ["list_peers", "send_message", "set_summary", "rename_peer"]) {
    expect(f.calls.filter(c => c.tool === tool).map(c => c.id).sort()).toEqual(["a", "b"]);
  }
  expect(f.adapter.resources()).toEqual({ identities: 2, calls: 0, waiters: 0, timers: 0, pendingAcks: 0 });
});

test("actual MCP envelope carries _meta for all six tools; missing context is refused", async () => {
  const f = await fixture();
  const server = createHermesConversationMcp(f.adapter);
  const client = new Client({ name: "fixture-host", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual([...HERMES_CONVERSATION_TOOLS]);
    await expect(client.callTool({ name: "check_messages" })).rejects.toThrow("session_context_required");
    for (const name of HERMES_CONVERSATION_TOOLS) {
      await client.callTool({ name, arguments: { timeout_ms: 0 }, _meta: meta("mcp-a") });
      await client.callTool({ name, arguments: { timeout_ms: 0 }, _meta: meta("mcp-b") });
    }
    expect(f.owners.size).toBe(2);
    expect(f.calls.map(c => c.id)).toEqual(["mcp-a", "mcp-b", "mcp-a", "mcp-b", "mcp-a", "mcp-b", "mcp-a", "mcp-b"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("missing/mismatched metadata fails before binding; compression retains K, branch does not", async () => {
  const f = await fixture();
  expect(() => f.adapter.call({ name: "check_messages", arguments: meta("a") })).toThrow("session_context_required");
  expect(() => f.adapter.call({ name: "check_messages", _meta: { ...meta("a"), "hermes/backend_id": "other" } })).toThrow("mismatch");
  expect(f.owners.size).toBe(0);
  const mutable = meta("a");
  const first = f.adapter.call({ name: "check_messages", _meta: mutable });
  mutable["hermes/conversation_id"] = "b";
  mutable["hermes/session_id"] = "b";
  await first;
  await f.adapter.call({ name: "check_messages", _meta: meta("a", "compressed-a") });
  await f.call("branch-a");
  expect(f.owners.size).toBe(2);
  expect(f.contexts).toEqual(["a", "a", "compressed-a", "compressed-a", "branch-a", "branch-a"]);
});

test("private inbox: sibling calls cannot present or acknowledge another conversation", async () => {
  const f = await fixture();
  f.messages.set("a", [message(1, "a")]);
  f.messages.set("b", [message(2, "b")]);
  expect(JSON.stringify(await f.call("a"))).toContain("private-a-1");
  expect(f.acks).toEqual([]);
  const b = JSON.stringify(await f.call("b"));
  expect(b).toContain("private-b-2");
  expect(b).not.toContain("private-a-1");
  expect(f.acks).toEqual([]);
  await f.call("a", "list_peers");
  expect(f.acks).toEqual([{ id: "a", tokens: ["lease-1"] }]);
});

test("BARRIER: earlier concurrent arrival cannot confirm a later promoted response", async () => {
  const f = await fixture();
  f.messages.set("a", [message(1, "a")]);
  const entered = deferred();
  const release = deferred();
  f.port.invoke = async () => { entered.resolve(); await release.promise; return "done"; };
  const first = f.call("a", "set_summary");
  await entered.promise;
  await f.call("a");
  expect(f.acks).toEqual([]);
  release.resolve();
  await first;
  await f.call("b");
  expect(f.acks).toEqual([]);
  await f.call("a");
  expect(f.acks).toHaveLength(1);
});

test("BARRIER: wait arriving before promote cannot confirm after a delayed wake", async () => {
  const f = await fixture();
  f.messages.set("a", [message(1, "a")]);
  const entered = deferred();
  const release = deferred();
  f.port.invoke = async () => { entered.resolve(); await release.promise; return "done"; };
  const first = f.call("a", "set_summary");
  await entered.promise;
  const waiting = f.call("a", "wait_for_peer_messages", { timeout_ms: 1_000, from: "trigger" });
  for (let n = 0; n < 100 && !f.adapter.resources().waiters; n++) await Bun.sleep(1);
  expect(f.adapter.resources().waiters).toBe(1);
  release.resolve();
  await first;
  f.messages.get("a")!.push(message(2, "a", "trigger"));
  f.adapter.tick();
  await waiting;
  expect(f.acks).toEqual([]);
  await f.call("a");
  expect(f.acks[0]?.tokens).toEqual(["lease-1", "lease-2"]);
});

test("abort rolls presentation back and cross-conversation leases fail closed", async () => {
  const f = await fixture();
  f.messages.set("a", [message(1, "a")]);
  const entered = deferred();
  const release = deferred();
  f.port.invoke = async () => { entered.resolve(); await release.promise; return "done"; };
  const controller = new AbortController();
  const first = f.call("a", "set_summary", {}, controller.signal);
  const rejected = first.catch(error => error);
  await entered.promise;
  controller.abort();
  release.resolve();
  expect(await rejected).toBeInstanceOf(Error);
  expect(JSON.stringify(await f.call("a"))).toContain("private-a-1");
  expect(f.acks).toEqual([]);
  f.messages.set("b", [message(3, "a")]);
  await expect(f.call("b")).rejects.toThrow("cross_conversation_mail_refused");
});

test("filtered waits leave other senders unread and cleanup never acknowledges", async () => {
  const f = await fixture();
  f.messages.set("a", [message(1, "a", "one"), message(2, "a", "two")]);
  const result = JSON.stringify(await f.call("a", "wait_for_peer_messages", { timeout_ms: 0, from: "one" }));
  expect(result).toContain("private-a-1");
  expect(result).not.toContain("private-a-2");
  await f.adapter.release(meta("a"), "reaped");
  expect(f.acks).toEqual([]);
  expect(f.adapter.resources().identities).toBe(0);
  expect(JSON.stringify(await f.call("a"))).toContain("private-a-2");
});

test("concurrent release and shutdown share request drainage instead of losing a resolver", async () => {
  const f = await fixture();
  const entered = deferred();
  const unblock = deferred();
  const bind = f.port.bind;
  f.port.bind = async ctx => { entered.resolve(); await unblock.promise; return bind(ctx); };
  const running = f.call("a").catch(() => {});
  await entered.promise;
  const release = f.adapter.release(meta("a"), "closed");
  const stop = f.adapter.stop();
  unblock.resolve();
  const drained = await Promise.race([Promise.all([running, release, stop]).then(() => true), Bun.sleep(100).then(() => false)]);
  expect(drained).toBe(true);
  expect(f.adapter.resources()).toEqual({ identities: 0, calls: 0, waiters: 0, timers: 0, pendingAcks: 0 });
});
