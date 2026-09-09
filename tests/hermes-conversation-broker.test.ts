import { afterEach, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import {
  ackMessages, gcOldMessages, getPeer, heartbeatPeer, initDb, listPeers, pollMessages,
  registerPeer, renamePeer, sendMessage, setPeerSummary, unregisterPeer,
} from "../broker.ts";
import { HermesConversationBroker, installHermesConversationBrokerSchema } from "../shared/hermes-conversation-broker.ts";
import { HermesConversationAdapter } from "../shared/hermes-conversation-adapter.ts";
import { parseHermesConversationContext } from "../shared/hermes-conversation-context.ts";
import { disposeConversationOrphan, listConversationOrphans } from "../shared/hermes-conversation-orphans.ts";
import { CodexInboxStore } from "../shared/codex-inbox.ts";

const home = "/fixture/profile";
const backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721";
const roots: string[] = [];
const databases: Database[] = [];
const adapters: HermesConversationAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map(a => a.stop()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true })));
});
function meta(id: string, session = id, backendId = backend) {
  return { "hermes/home": home, "hermes/backend_id": backendId,
    "hermes/conversation_id": id, "hermes/session_id": session, "hermes/platform": "desktop" };
}
function context(id: string, session = id, backendId = backend) {
  return parseHermesConversationContext(meta(id, session, backendId), { home, backend_id: backendId });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hermes-broker-"));
  roots.push(root);
  const db = initDb(join(root, "broker.db"));
  databases.push(db);
  installHermesConversationBrokerSchema(db);
  let sequence = 0;
  const broker = new HermesConversationBroker(db, { profile: "fixture-hermes", adapter_id: "adapter-one",
    cwd: "/fixture", git_root: null, pid: process.pid, inboxRoot: join(root, "inboxes"),
    evidence: ctx => ({ context: ctx, adapter_id: "adapter-one",
      lifecycle_generation: ++sequence, observed_at: Date.now() }),
    releaseEvidence: () => ({ lifecycle_generation: ++sequence, observed_at: Date.now() }),
  });
  const adapter = new HermesConversationAdapter({ home, backend_id: backend, inboxRoot: join(root, "inboxes"), broker });
  adapters.push(adapter);
  const sender = registerPeer(db, { peer_type: "claude", name: "sender", pid: process.pid,
    cwd: "/fixture", git_root: null, tty: null, summary: "legacy sender" });
  const call = (id: string, name = "check_messages", args = {}) => adapter.call({ name, arguments: args, _meta: meta(id) });
  const send = (to: string, text = "private fixture message") => sendMessage(db, {
    from_id: sender.id, session_token: sender.session_token, to_id_or_name: to, text });
  return { db, root, broker, adapter, sender, call, send };
}

test("broker-backed adapter keeps status, inbox, later-call ack, and names private", async () => {
  const f = await fixture();
  await f.call("a", "set_summary", { summary: "task A" });
  await f.call("b", "set_summary", { summary: "task B" });
  const a = await f.broker.bind(context("a"));
  const b = await f.broker.bind(context("b"));
  expect(a.peer_id).not.toBe(b.peer_id);
  expect(getPeer(f.db, a.peer_id)?.summary).toBe("task A");
  expect(getPeer(f.db, b.peer_id)?.summary).toBe("task B");
  const sent = f.send(a.name, "ONLY_A");
  expect(sent.ok).toBe(true);
  expect(JSON.stringify(await f.call("a"))).toContain("ONLY_A");
  expect(JSON.stringify(await f.call("b"))).not.toContain("ONLY_A");
  const unread = () => f.db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?").get(sent.message_id!)!.acked;
  expect(unread()).toBe(0);
  await f.call("a");
  expect(unread()).toBe(1);
  await f.call("a", "rename_peer", { new_name: "only-a" });
  expect(f.broker.bindings.get(a.peer_id)?.name).toBe("only-a");
  expect(f.broker.bindings.get(b.peer_id)?.name).toBe(b.name);
});

test("token plus generation fences every old endpoint, including zero-token ack and unregister", async () => {
  const f = await fixture();
  const a = await f.broker.bind(context("a"));
  f.send(a.peer_id);
  const leases = await f.broker.poll(a);
  const stale = { ...a, generation: a.generation + 1 };
  for (const owner of [undefined, stale]) {
    expect(() => pollMessages(f.db, a.peer_id, a.session_token, owner)).toThrow("stale_conversation_owner");
    expect(() => heartbeatPeer(f.db, a.peer_id, a.session_token, owner)).toThrow("stale_conversation_owner");
    expect(() => setPeerSummary(f.db, a.peer_id, a.session_token, "stolen", owner)).toThrow("stale_conversation_owner");
    expect(() => unregisterPeer(f.db, a.peer_id, a.session_token, owner)).toThrow("stale_conversation_owner");
    expect(() => ackMessages(f.db, { id: a.peer_id, session_token: a.session_token, lease_tokens: [] }, owner)).toThrow("stale_conversation_owner");
    expect(() => renamePeer(f.db, { id: a.peer_id, session_token: a.session_token, new_name: "stolen" }, owner)).toThrow("stale_conversation_owner");
    expect(() => sendMessage(f.db, { from_id: a.peer_id, session_token: a.session_token,
      to_id_or_name: f.sender.id, text: "stolen" }, owner)).toThrow("stale_conversation_owner");
  }
  const b = await f.broker.bind(context("b"));
  const cross = await f.broker.ack(b, leases.map(m => m.lease_token));
  expect(cross.acked).toBe(0);
  expect(cross.results?.[0]?.status).toBe("wrong_session");
  await expect(f.broker.poll({ ...a, session_token: "invalid" })).rejects.toThrow("stale_conversation_owner");
  expect(getPeer(f.db, a.peer_id)?.name).toBe(a.name);
});

test("visible-row collection and backend expiry preserve UUID and reject legacy takeover", async () => {
  const f = await fixture();
  const a = await f.broker.bind(context("a"));
  f.send(a.peer_id);
  f.db.query("DELETE FROM peers WHERE id=?").run(a.peer_id);
  expect(() => registerPeer(f.db, { peer_type: "hermes", prev_id: a.peer_id,
    pid: process.pid, cwd: "/fixture", git_root: null, tty: null, summary: "" })).toThrow("exact_binding");
  const legacy = registerPeer(f.db, { peer_type: "hermes", name: a.name,
    pid: process.pid, cwd: "/fixture", git_root: null, tty: null, summary: "" });
  expect(legacy.name).not.toBe(a.name);
  expect(renamePeer(f.db, { id: legacy.id, session_token: legacy.session_token, new_name: a.name }).ok).toBe(false);
  const recreated = await f.broker.bind(context("a"));
  expect(recreated.peer_id).toBe(a.peer_id);
  expect((await f.broker.poll(recreated)).length).toBe(1);
  f.db.query("UPDATE hermes_conversations SET owner_lease_until=0 WHERE peer_id=?").run(a.peer_id);
  await expect(f.broker.poll(a)).rejects.toThrow("stale_conversation_owner");
  await Bun.sleep(2);
  const resumed = await f.broker.bind(context("a", "compressed-a"));
  expect(resumed.peer_id).toBe(a.peer_id);
  expect(resumed.generation).toBe(a.generation + 1);
  expect(resumed.session_token).not.toBe(a.session_token);
  await expect(f.broker.poll(a)).rejects.toThrow("stale_conversation_owner");
  expect((await f.broker.poll(resumed)).length).toBe(1);
});

test("close retains mail with explicit queued/no-wake notice and hides visible identity", async () => {
  const f = await fixture();
  const a = await f.broker.bind(context("a"));
  await f.broker.release(a, "closed");
  const result = f.send(a.name);
  expect(result.ok).toBe(true);
  expect(result.notice).toContain("will not be woken");
  expect(listPeers(f.db, { scope: "machine", cwd: "/fixture", git_root: null }).some(p => p.id === a.peer_id)).toBe(false);
  await expect(f.broker.poll(a)).rejects.toThrow("stale_conversation_owner");
  await Bun.sleep(2);
  expect((await f.broker.bind(context("a"))).peer_id).toBe(a.peer_id);
});

test("v2 unread has no age expiry and all states enforce 500 explicit refusal", async () => {
  const f = await fixture();
  const a = await f.broker.bind(context("a"));
  const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
  f.db.query("INSERT INTO messages (from_id,to_id,text,sent_at,acked) VALUES (?,?,?,?,0)")
    .run(f.sender.id, a.peer_id, "old pending", old);
  f.db.query("INSERT INTO messages (from_id,to_id,text,sent_at,acked) VALUES (?,?,?,?,1)")
    .run(f.sender.id, a.peer_id, "old receipt", old);
  f.db.query("INSERT INTO messages (from_id,to_id,text,sent_at,acked) VALUES (?,?,?,?,0)")
    .run(f.sender.id, "legacy-gone", "old legacy", old);
  expect(gcOldMessages(f.db)).toBe(2);
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages").get()!.n).toBe(1);
  f.db.transaction(() => {
    for (let i = 0; i < 499; i++) expect(f.send(a.peer_id).ok).toBe(true);
  })();
  expect(f.send(a.peer_id).error).toContain("limit 500");
  await f.broker.release(a, "reaped");
  expect(f.send(a.name).error).toContain("message not queued");
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages").get()!.n).toBe(500);
});

test("orphan dry-run is read-only; disposal archives broker and registered inbox without ack", async () => {
  const f = await fixture();
  const a = await f.broker.bind(context("a"));
  const id = f.send(a.name, "ORPHAN_BODY").message_id!;
  await f.call("a");
  await f.adapter.release(meta("a"), "orphaned");
  expect(listConversationOrphans(f.db)).toEqual([{ peer_id: a.peer_id, name: a.name, state: "orphaned", unread: 1 }]);
  expect(f.broker.bindings.status().orphaned).toBe(1);
  expect(disposeConversationOrphan(f.db, a.peer_id).action).toBe("would_archive_and_dispose");
  expect(f.db.query("SELECT 1 FROM sqlite_master WHERE name='hermes_conversation_disposals'").get()).toBeNull();
  expect(disposeConversationOrphan(f.db, a.peer_id, true).action).toBe("archived_and_disposed");
  expect(f.db.query("SELECT 1 FROM messages WHERE id=?").get(id)).toBeNull();
  expect(f.db.query<{ text: string }, [number]>("SELECT text FROM hermes_disposed_messages WHERE id=?").get(id)?.text).toBe("ORPHAN_BODY");
  const files = await readdir(join(f.root, "inboxes"));
  expect(files.filter(name => name.includes(".disposed-"))).toHaveLength(2);
  expect(await readFile(join(f.root, "inboxes", files.find(name => name.startsWith(`${a.peer_id}.json`))!), "utf8")).toContain("ORPHAN_BODY");
  expect(disposeConversationOrphan(f.db, a.peer_id, true).action).toBe("already_disposed");
  expect(f.send(a.name).error).toContain("disposed");
  await expect(f.broker.bind(context("a"))).rejects.toThrow("not_resumable");
});

test("failed inbox archival leaves recoverable pending disposal; retry is idempotent", async () => {
  const f = await fixture();
  const a = await f.broker.bind(context("a"));
  const id = f.send(a.name).message_id!;
  await f.call("a");
  await f.adapter.release(meta("a"), "orphaned");
  const path = join(f.root, "inboxes", `${a.peer_id}.json`);
  await chmod(path, 0o644);
  expect(() => disposeConversationOrphan(f.db, a.peer_id, true)).toThrow("unsafe_inbox_file");
  expect(f.db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?").get(id)?.acked).toBe(0);
  expect(f.db.query<{ state: string }, []>("SELECT state FROM hermes_conversation_disposals").get()?.state).toBe("pending");
  expect(f.send(a.name).error).toContain("disposed");
  await chmod(path, 0o600);
  expect(disposeConversationOrphan(f.db, a.peer_id, true).action).toBe("archived_and_disposed");
  expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM hermes_disposed_messages").get()?.n).toBe(1);
});

test("operator CLI validates arguments before access and reports empty/count/status", async () => {
  const f = await fixture();
  const cli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../hermes-conversations-cli.ts"), ...args],
      { stdout: "pipe", stderr: "pipe" });
    return { output: await new Response(child.stdout).text(), code: await child.exited };
  };
  expect((await cli(["dispose", "id", "--oops"])).code).toBe(2);
  expect((await cli(["orphans", "--db", join(f.root, "broker.db")])).output).toContain("count: 0");
  const a = await f.broker.bind(context("a"));
  const inspected = await cli(["inspect", a.peer_id, "--db", join(f.root, "broker.db")]);
  expect(inspected.code).toBe(0);
  expect(inspected.output).toContain(`conversation_id: "a"`);
  expect(inspected.output).toContain(`current_session_id: "a"`);
  expect(inspected.output).toContain(`backend_id: "${backend}"`);
  expect(inspected.output).not.toContain("session_token");
  await f.broker.release(a, "orphaned");
  expect((await cli(["status", "--db", join(f.root, "broker.db")])).output).toContain("orphaned: 1");
  const dry = await cli(["dispose", a.peer_id, "--db", join(f.root, "broker.db")]);
  expect(dry.code).toBe(0);
  expect(dry.output).toContain("would_archive_and_dispose");
  const applied = await cli(["dispose", a.peer_id, "--db", join(f.root, "broker.db"), "--apply"]);
  expect(applied.code).toBe(0);
  expect(applied.output).toContain("archived_and_disposed");
  const repeated = await cli(["dispose", a.peer_id, "--db", join(f.root, "broker.db"), "--apply"]);
  expect(repeated.code).toBe(0);
  expect(repeated.output).toContain("already_disposed");
});

test("adapter accepts a renewed authenticated epoch after lease expiry and can close it", async () => {
  const time = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(time);
  try {
    const f = await fixture();
    await f.call("a", "set_summary", { summary: "persistent status" });
    const owner = await f.broker.bind(context("a"));
    f.send(owner.name, "SURVIVES_EXPIRY");
    await f.call("a");
    clock.mockReturnValue(time + 46_000);
    expect(JSON.stringify(await f.call("a"))).toContain("SURVIVES_EXPIRY");
    expect(f.broker.bindings.get(owner.peer_id)?.generation).toBe(owner.generation + 1);
    expect(f.broker.bindings.get(owner.peer_id)?.summary).toBe("persistent status");
    await f.adapter.release(meta("a"), "closed");
    expect(f.adapter.resources().identities).toBe(0);
  } finally { clock.mockRestore(); }
});

test("60-second wait renews trusted evidence across ownership expiry without acknowledging early", async () => {
  const time = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(time);
  try {
    const f = await fixture();
    let failure: unknown;
    const waiting = f.call("a", "wait_for_peer_messages", { timeout_ms: 60_000 }).catch(error => { failure = error; });
    for (let i = 0; i < 100 && !f.adapter.resources().waiters; i++) await Bun.sleep(1);
    clock.mockReturnValue(time + 46_000);
    f.adapter.tick();
    for (let i = 0; i < 100 && !f.adapter.resources().waiters && !failure; i++) await Bun.sleep(1);
    expect(failure).toBeUndefined();
    expect(f.adapter.resources().waiters).toBe(1);
    clock.mockReturnValue(time + 60_001);
    f.adapter.tick();
    await waiting;
    expect(failure).toBeUndefined();
  } finally { clock.mockRestore(); }
});

test("explicit close can release its still-current expired owner without renewing read access", async () => {
  const time = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(time);
  try {
    const f = await fixture();
    await f.call("a");
    const owner = await f.broker.bind(context("a"));
    clock.mockReturnValue(time + 46_000);
    await expect(f.broker.poll(owner)).rejects.toThrow("stale_conversation_owner");
    f.db.query("DELETE FROM peers WHERE id=?").run(owner.peer_id);
    await f.adapter.release(meta("a"), "closed");
    expect(f.broker.bindings.get(owner.peer_id)?.state).toBe("closed");
    expect(f.adapter.resources().identities).toBe(0);
  } finally { clock.mockRestore(); }
});

test.each(["ack-response", "local-prune"])("ack reconciliation recovers after %s failure", async failure => {
  const f = await fixture();
  const a = await f.broker.bind(context("a"));
  f.send(a.name);
  await f.call("a");
  const realAck = f.broker.ack.bind(f.broker);
  let fail = true;
  const prune = failure === "local-prune"
    ? spyOn(CodexInboxStore.prototype, "removeByIds").mockRejectedValueOnce(new Error("ENOSPC"))
    : undefined;
  if (failure === "ack-response") f.broker.ack = async (owner, tokens) => {
    const result = await realAck(owner, tokens);
    if (fail) { fail = false; throw new Error("lost response"); }
    return result;
  };
  try {
    await expect(f.call("a")).rejects.toThrow();
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages WHERE acked=1").get()?.n)
      .toBe(failure === "ack-response" ? 1 : 0);
    prune?.mockRestore();
    const retried = await f.call("a");
    if (failure === "ack-response") expect(JSON.stringify(retried)).toContain("0/1 acknowledged");
    const inbox = JSON.parse(await readFile(join(f.root, "inboxes", `${a.peer_id}.json`), "utf8"));
    expect(inbox.unread).toEqual([]);
    expect(f.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages WHERE acked=1").get()?.n).toBe(1);
  } finally { prune?.mockRestore(); }
});
