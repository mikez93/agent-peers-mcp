// v3 broker addressing: find-by-name, chat mail isolation, chat replies,
// remote hook, bounds. Old-client behavior (no chat field) must not change.

import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import {
  initDb, registerPeer, listPeers, sendMessage, pollMessages, ackMessages, setPeerSummary, renamePeer,
  configureAddressing, listChats, chatInbox, MAX_POLL_BATCH, MAX_ACK_TOKENS,
  deliverRelayed, listDirectoryPeers, snapshotSender, deliverNotice, type OutboundSender, pollMessagesScoped,
  gcOldMessages,
} from "../broker.ts";
import type { ChatDirectory, ChatCandidate } from "../shared/chat-directory.ts";
import { chatRouteId } from "../shared/broker-addressing.ts";
import type { RegisterRequest } from "../shared/types.ts";

let db: Database;
let TEST_DB: string;

// A fake Hermes directory: two Valentina chats with titles.
const CHATS: Record<string, ChatCandidate[]> = {
  "valentina-hermes": [
    { chat_key: "20261029_121224_2b437e", title: "email shit", last_active: "2026-10-30T10:00:00Z" },
    { chat_key: "20261028_100000_aaaaaa", title: "Instagram ads", last_active: "2026-10-29T10:00:00Z" },
  ],
};
const fakeChats: ChatDirectory = {
  resolve(peer, query) {
    const list = CHATS[peer.name] ?? [];
    const q = query.trim().toLowerCase();
    const hit = list.find((c) => c.chat_key === query.trim() || (c.title ?? "").toLowerCase() === q);
    if (hit) return { ok: true, chat_key: hit.chat_key, title: hit.title };
    const near = list.filter((c) => (c.title ?? "").toLowerCase().includes(q));
    return { ok: false, error: `no chat titled "${query}" for ${peer.name}.`, candidates: near };
  },
  list(peer, opts) {
    const list = (CHATS[peer.name] ?? []).filter((c) => !opts.query || (c.title ?? "").toLowerCase().includes(opts.query.toLowerCase()));
    return list.slice(opts.offset, opts.offset + opts.limit);
  },
};

beforeEach(() => {
  TEST_DB = `/tmp/agent-peers-v3-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  db = initDb(TEST_DB);
  configureAddressing({ chats: fakeChats });
});
afterEach(() => {
  configureAddressing({});
  db.close();
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
});

function reg(o: Partial<RegisterRequest> & { name: string }) {
  return registerPeer(db, {
    peer_type: "claude", pid: 1, cwd: "/x", git_root: null, tty: null, summary: "", durable: true,
    ...o,
  } as RegisterRequest);
}
const send = (from: { id: string; session_token: string }, to: string, text = "hi", extra: object = {}) =>
  sendMessage(db, { from_id: from.id, session_token: from.session_token, to_id_or_name: to, text, ...extra });

test("statuses carry the persona name exactly once", () => {
  const marco = reg({ name: "marco-imekka-director-ops-droid", peer_type: "droid", git_root: "/w/imekka-director-ops", summary: "Standing by" });
  reg({ name: "kepler-kepler-maintainer-claude", git_root: "/w/kepler-maintainer", summary: "Kepler: verifying" });
  reg({ name: "gurdjieff-claude", git_root: "/w/gurdjieff", summary: "redesign" });
  reg({ name: "quiet-repo-claude", persona: "Massimo", git_root: "/w/art-director", summary: "" });
  const rows = Object.fromEntries(listPeers(db, { scope: "machine", cwd: "/x", git_root: null }).map((r) => [r.name, r.summary]));
  expect(rows["marco-imekka-director-ops-droid"]).toBe("Marco: Standing by");
  expect(rows["kepler-kepler-maintainer-claude"]).toBe("Kepler: verifying");
  expect(rows["gurdjieff-claude"]).toBe("redesign");
  expect(rows["quiet-repo-claude"]).toBe("Massimo: (no status set)");
  // Stored text is untouched.
  setPeerSummary(db, marco.id, marco.session_token, "new work");
  const raw = db.query<{ summary: string }, [string]>("SELECT summary FROM peers WHERE id = ?").get(marco.id)!.summary;
  expect(raw).toBe("new work");
});

test("send by persona, case-insensitive name, and exact name precedence", () => {
  const me = reg({ name: "vector-agentic-coding-resources-claude", git_root: "/w/agentic-coding-resources" });
  const kepler = reg({ name: "kepler-kepler-maintainer-claude", git_root: "/w/kepler-maintainer" });
  const r1 = send(me, "Kepler");
  expect(r1.ok).toBe(true);
  expect(r1.notice).toContain("delivered to kepler-kepler-maintainer-claude");
  expect(pollMessages(db, kepler.id, kepler.session_token).length).toBe(1);

  const exact = reg({ name: "Vector", git_root: "/w/other" });
  const r2 = send(kepler, "Vector");
  expect(r2.ok).toBe(true);
  expect(r2.notice).toBeUndefined();
  expect(pollMessages(db, exact.id, exact.session_token).length).toBe(1);
});

test("ambiguous persona returns candidates and queues nothing", () => {
  const me = reg({ name: "vector-agentic-coding-resources-claude", git_root: "/w/agentic-coding-resources" });
  reg({ name: "marco-imekka-director-ops-droid", peer_type: "droid", git_root: "/w/imekka-director-ops" });
  reg({ name: "marco-hermes", peer_type: "hermes", cwd: "/h/marco" });
  const r = send(me, "marco");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("matches 2 peers");
  expect(r.candidates?.sort()).toEqual(["marco-hermes", "marco-imekka-director-ops-droid"]);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages").get()!.n).toBe(0);
});

test("unknown names still fail the old way", () => {
  const me = reg({ name: "a-b-claude" });
  expect(send(me, "nobody-here").error).toBe("unknown peer: nobody-here");
});

function hermesOwner(caps = ["chat-mail"]) {
  return reg({ name: "valentina-hermes", peer_type: "hermes", cwd: "/h/valentina", capabilities: caps });
}

test("chat mail is isolated: only the named chat draws it", () => {
  const me = reg({ name: "marco-imekka-director-ops-droid", peer_type: "droid", git_root: "/w/imekka-director-ops" });
  const val = hermesOwner();
  const r = send(me, "valentina/Email Shit", "about the promo");
  expect(r.ok).toBe(true);
  expect(send(me, "valentina-hermes", "general note").ok).toBe(true);

  // A chatless poll (old clients, directory calls) sees only general mail.
  const general = pollMessages(db, val.id, val.session_token);
  expect(general.map((m) => m.text)).toEqual(["general note"]);
  // Another chat sees nothing.
  expect(pollMessages(db, val.id, val.session_token, undefined, "Instagram ads")).toEqual([]);
  // An unknown chat never falls back to general.
  expect(pollMessages(db, val.id, val.session_token, undefined, "no such chat")).toEqual([]);
  // The named chat, by title or session ID.
  const mine = pollMessages(db, val.id, val.session_token, undefined, "20261029_121224_2b437e");
  expect(mine.map((m) => m.text)).toEqual(["about the promo"]);
  expect(mine[0]!.to_chat).toBe("20261029_121224_2b437e");
});

test("a near-miss chat title returns candidates and sends nothing", () => {
  const me = reg({ name: "marco-imekka-director-ops-droid", peer_type: "droid", git_root: "/w/imekka-director-ops" });
  hermesOwner();
  const r = send(me, "valentina/email");
  expect(r.ok).toBe(false);
  expect(r.candidates).toEqual(["valentina-hermes/email shit"]);
  expect(r.error).toContain("Nothing was sent or woken");
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages").get()!.n).toBe(0);
});

test("chat addresses are rejected for non-Hermes peers", () => {
  const me = reg({ name: "a-claude" });
  reg({ name: "kepler-kepler-maintainer-claude", git_root: "/w/kepler-maintainer" });
  const r = send(me, "kepler/some chat");
  expect(r.ok).toBe(false);
  expect(r.error).toContain("only for Hermes agents");
});

test("an old Hermes process gets chat mail in its general mailbox, with a notice", () => {
  const me = reg({ name: "a-claude" });
  const val = hermesOwner([]);
  const r = send(me, "valentina/email shit", "x");
  expect(r.ok).toBe(true);
  expect(r.notice).toContain("has not switched to per-chat mail yet");
  expect(pollMessages(db, val.id, val.session_token).map((m) => m.text)).toEqual(["x"]);
});

test("replies from old clients return to the sending chat by from_id or from_name", () => {
  const val = hermesOwner();
  const marco = reg({ name: "marco-imekka-director-ops-droid", peer_type: "droid", git_root: "/w/imekka-director-ops" });
  expect(send(val, "marco-imekka-director-ops-droid", "question", { from_chat: "email shit" }).ok).toBe(true);
  const [got] = pollMessages(db, marco.id, marco.session_token);
  expect(got!.from_name).toBe("valentina-hermes/20261029_121224_2b437e");
  expect(got!.from_id).toBe(chatRouteId("valentina-hermes", "20261029_121224_2b437e"));
  expect(got!.from_summary).toContain('chat "email shit"');

  expect(send(marco, got!.from_id, "answer by id").ok).toBe(true);
  expect(send(marco, got!.from_name, "answer by name").ok).toBe(true);
  expect(pollMessages(db, val.id, val.session_token)).toEqual([]);
  const replies = pollMessages(db, val.id, val.session_token, undefined, "email shit");
  expect(replies.map((m) => m.text)).toEqual(["answer by id", "answer by name"]);
});

test("a Hermes member reads and confirms its own chat's mail in the owner mailbox", () => {
  const val = hermesOwner();
  const member = reg({ name: "valentina-trophy-master-mind-hermes", peer_type: "hermes", cwd: "/h/valentina", durable: false, capabilities: ["chat-mail"], mailbox_owner: "valentina-hermes" });
  const marco = reg({ name: "marco-imekka-director-ops-droid", peer_type: "droid", git_root: "/w/imekka-director-ops" });
  expect(send(marco, "valentina-trophy-master-mind-hermes/email shit", "to the chat").ok).toBe(true);
  // Stored in the owner's mailbox, so the gateway can wake it too.
  expect(db.query<{ to_id: string }, []>("SELECT to_id FROM messages").get()!.to_id).toBe(val.id);
  const leased = pollMessages(db, member.id, member.session_token, undefined, "email shit");
  expect(leased.length).toBe(1);
  const ack = ackMessages(db, { id: member.id, session_token: member.session_token, lease_tokens: [leased[0]!.lease_token] });
  expect(ack.acked).toBe(1);
  // The member never sees the owner's general mail.
  expect(send(marco, "valentina-hermes", "general").ok).toBe(true);
  expect(pollMessages(db, member.id, member.session_token)).toEqual([]);
});

test("chat inbox lists unread Hermes mail per chat for the wake daemon", () => {
  const val = hermesOwner();
  const marco = reg({ name: "marco-imekka-director-ops-droid", peer_type: "droid", git_root: "/w/imekka-director-ops" });
  send(marco, "valentina/email shit", "a");
  send(marco, "valentina/email shit", "b");
  send(marco, "valentina", "c");
  const entries = chatInbox(db);
  const byChat = Object.fromEntries(entries.map((e) => [String(e.to_chat), e]));
  expect(byChat["20261029_121224_2b437e"]!.unread).toBe(2);
  expect(byChat["20261029_121224_2b437e"]!.title).toBe("email shit");
  expect(byChat["null"]!.unread).toBe(1);
  expect(entries.every((e) => e.peer_id === val.id)).toBe(true);
});

test("old Hermes owners are left out of the chat inbox", () => {
  hermesOwner([]);
  const marco = reg({ name: "m-claude" });
  send(marco, "valentina-hermes", "c");
  expect(chatInbox(db)).toEqual([]);
});

test("list-chats is read-only discovery with exact addresses", () => {
  const me = reg({ name: "m-claude" });
  hermesOwner();
  const r = listChats(db, { id: me.id, session_token: me.session_token, peer: "valentina", query: "ads" });
  expect(r.ok).toBe(true);
  expect(r.chats!.map((c) => c.address)).toEqual(["valentina-hermes/20261028_100000_aaaaaa"]);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM messages").get()!.n).toBe(0);
  expect(listChats(db, { id: me.id, session_token: "wrong", peer: "valentina" }).ok).toBe(false);
});

test("remote addresses use the federation hook, or fail clearly without it", () => {
  const me = reg({ name: "m-claude" });
  expect(send(me, "kepler@some-other-box").error).toContain("cross-machine delivery is not enabled");
  const calls: string[] = [];
  configureAddressing({ chats: fakeChats, remote: (r) => { calls.push(`${r.name}@${r.host}`); return { ok: true, notice: "queued" }; } });
  expect(send(me, "kepler@some-other-box").notice).toBe("queued");
  expect(calls).toEqual(["kepler@some-other-box"]);
});

test("polls are bounded and oversized acks are refused", () => {
  const me = reg({ name: "m-claude" });
  const you = reg({ name: "y-claude" });
  for (let i = 0; i < MAX_POLL_BATCH + 5; i++) send(me, "y-claude", `m${i}`);
  expect(pollMessages(db, you.id, you.session_token).length).toBe(MAX_POLL_BATCH);
  expect(() => ackMessages(db, { id: you.id, session_token: you.session_token, lease_tokens: Array(MAX_ACK_TOKENS + 1).fill("x") })).toThrow();
});

test("relayed delivery resolves locally only and shows the remote sender", () => {
  const val = hermesOwner();
  configureAddressing({
    chats: fakeChats,
    senderForMessage: (id) => id > 0 ? { from_id: "remote-uuid-1", from_name: "kepler@mike-macbook", from_peer_type: "claude", from_cwd: "/w/k", from_summary: "Kepler: hi" } : null,
  });
  const r = deliverRelayed(db, { to_address: "valentina@mike-mac-studio/email shit", text: "relayed", from_id: "remote-uuid-1", from_chat: null, message_uid: "uid-1", sent_at: "2026-10-31T00:00:00Z" });
  expect(r.ok).toBe(true);
  const [m] = pollMessages(db, val.id, val.session_token, undefined, "email shit");
  expect(m!.from_name).toBe("kepler@mike-macbook");
  expect(m!.from_id).toBe("remote-uuid-1");
  const miss = deliverRelayed(db, { to_address: "valentina/emai", text: "x", from_id: "r", from_chat: null, message_uid: "uid-2", sent_at: "" });
  expect(miss.code).toBe("chat_miss");
  expect(deliverRelayed(db, { to_address: "nobody", text: "x", from_id: "r", from_chat: null, message_uid: "uid-3", sent_at: "" }).code).toBe("unknown_peer");
});

test("remote UUID routes go to the federation hook before name parsing", () => {
  const me = reg({ name: "m-claude" });
  const seen: string[] = [];
  configureAddressing({
    chats: fakeChats,
    remoteRoute: (id) => id === "11111111-2222-3333-4444-555555555555" ? { host: "studio", name: "ezra-hermes", chat: null } : null,
    remote: (r) => { seen.push(`${r.name}@${r.host}`); return { ok: true, notice: "queued" }; },
  });
  expect(send(me, "11111111-2222-3333-4444-555555555555").ok).toBe(true);
  expect(seen).toEqual(["ezra-hermes@studio"]);
});

test("directory lists live and retained durable agents with persona statuses", () => {
  reg({ name: "marco-imekka-director-ops-droid", peer_type: "droid", git_root: "/w/imekka-director-ops", summary: "x" });
  reg({ name: "marco-hermes", peer_type: "hermes", cwd: "/h/marco" });
  reg({ name: "eph-claude", durable: false });
  // Make the durable Hermes row stale: it must still be listed.
  db.query("UPDATE peers SET last_seen = '2000-01-01T00:00:00.000Z' WHERE name = 'marco-hermes'").run();
  const all = listDirectoryPeers(db).map((p) => p.name).sort();
  expect(all).toEqual(["eph-claude", "marco-hermes", "marco-imekka-director-ops-droid"]);
  expect(listDirectoryPeers(db, { query: "marco" }).map((p) => p.name).sort()).toEqual(["marco-hermes", "marco-imekka-director-ops-droid"]);
  expect(listDirectoryPeers(db, { query: "marco" }).find((p) => p.name.endsWith("droid"))!.summary).toBe("Marco: x");
  expect(JSON.stringify(listDirectoryPeers(db))).not.toContain("session_token");
});

test("unknown names carry a machine-readable code for the federation fallback", () => {
  const me = reg({ name: "m-claude" });
  expect(send(me, "valentina").code).toBe("unknown_peer");
});

test("outbound sender snapshot: chat key, chat route reply UUID, profile mailbox", () => {
  const val = hermesOwner();
  setPeerSummary(db, val.id, val.session_token, "triaging promo email");
  const loser = reg({ name: "valentina-hermes-otter", peer_type: "hermes", cwd: "/h/valentina", capabilities: ["chat-mail"], mailbox_owner: "valentina-hermes", durable: false });
  const snaps: OutboundSender[] = [];
  configureAddressing({ chats: fakeChats, remote: (r) => { snaps.push(snapshotSender(db, r)); return { ok: true, notice: "queued" }; } });

  expect(send(loser, "kepler@studio", "from a chat", { from_chat: "Email Shit" }).ok).toBe(true);
  const s1 = snaps[0]!;
  expect(s1.chat).toBe("20261029_121224_2b437e");
  expect(s1.id).toBe(chatRouteId("valentina-hermes", "20261029_121224_2b437e"));
  expect(s1.peer_id).toBe(val.id);
  expect(s1.name).toBe("valentina-hermes");
  expect(s1.peer_type).toBe("hermes");

  // A remote reply to the chat UUID lands in that chat.
  const back = deliverRelayed(db, { to_address: s1.id, text: "reply to chat", from_id: "remote-1", from_chat: null, message_uid: "uid-r1", sent_at: "2026-10-31T00:00:00Z" });
  expect(back.ok).toBe(true);
  expect(pollMessages(db, val.id, val.session_token, undefined, "email shit").map((m) => m.text)).toEqual(["reply to chat"]);

  // A plain sender: its own UUID, no chat, persona status.
  expect(send(val, "kepler@studio", "plain").ok).toBe(true);
  const s2 = snaps[1]!;
  expect(s2).toMatchObject({ id: val.id, peer_id: val.id, chat: null, name: "valentina-hermes" });
  // The same status the directory shows.
  expect(s2.summary).toBe(listDirectoryPeers(db, { query: "valentina-hermes" }).find((p) => p.id === val.id)!.summary);
  expect(s2.summary).toContain("triaging promo email");
});

test("delivery notices survive a collected recipient row and are idempotent", () => {
  const gone = reg({ name: "m-claude", durable: false });
  db.run("DELETE FROM peers WHERE id = ?", [gone.id]);
  const n = { to_id: gone.id, to_chat: null, from_id: chatRouteId("agent-peers", "system@studio"), text: "Delivery failed", sent_at: "2026-10-31T00:00:00Z", message_uid: "bounce-1" };
  const first = deliverNotice(db, n);
  expect(deliverNotice(db, n).message_id).toBe(first.message_id);
  // Re-registration with prev_id hands the notice over.
  const again = reg({ name: "m-claude", durable: false, prev_id: gone.id });
  expect(pollMessages(db, again.id, again.session_token).map((m) => m.text)).toEqual(["Delivery failed"]);
});

test("chat route UUIDs survive a rename of the owning agent", () => {
  const val = hermesOwner();
  const me = reg({ name: "m-claude" });
  // Valentina's chat writes to me; the poll shows me the chat route UUID.
  expect(send(val, "m-claude", "from email chat", { from_chat: "email shit" }).ok).toBe(true);
  const [m] = pollMessages(db, me.id, me.session_token);
  const routeId = m!.from_id;
  expect(routeId).toBe(chatRouteId("valentina-hermes", "20261029_121224_2b437e"));
  CHATS["valentina-hermes-2"] = CHATS["valentina-hermes"]!;
  expect(renamePeer(db, { id: val.id, session_token: val.session_token, new_name: "valentina-hermes-2" }).ok).toBe(true);
  // A reply to the old UUID, local or relayed, still reaches the same chat.
  expect(send(me, routeId, "local reply").ok).toBe(true);
  expect(deliverRelayed(db, { to_address: routeId, text: "relayed reply", from_id: "r1", from_chat: null, message_uid: "uid-rn", sent_at: "2026-10-31T00:00:00Z" }).ok).toBe(true);
  expect(pollMessages(db, val.id, val.session_token, undefined, "20261029_121224_2b437e").map((x) => x.text)).toEqual(["local reply", "relayed reply"]);
  // New mail from the same chat keeps the original UUID.
  expect(send(val, "m-claude", "again", { from_chat: "email shit" }).ok).toBe(true);
  expect(pollMessages(db, me.id, me.session_token)[0]!.from_id).toBe(routeId);
  delete CHATS["valentina-hermes-2"];
});

test("a chat poll reports the resolved chat key, a general poll reports general", () => {
  const val = hermesOwner();
  expect(pollMessagesScoped(db, val.id, val.session_token, undefined, "Email Shit")).toMatchObject({ scope: "chat", chat_key: "20261029_121224_2b437e" });
  expect(pollMessagesScoped(db, val.id, val.session_token, undefined, "general")).toMatchObject({ scope: "general", chat_key: null });
  expect(pollMessagesScoped(db, val.id, val.session_token, undefined, "no such chat")).toMatchObject({ scope: "none", chat_key: null, messages: [] });
});

test("unread chat mail survives the 30-day cleanup while its owner polls only general", () => {
  // Marco's NO-GO repro: a live chat-mail owner's background loop reads only the
  // general mailbox, so mail to a chat nobody opens exists only at the broker.
  const val = hermesOwner();
  const marco = reg({ name: "marco-imekka-director-ops-droid", peer_type: "droid", git_root: "/w/imekka-director-ops" });
  expect(send(marco, "valentina/email shit", "closed chat mail").ok).toBe(true);
  expect(pollMessages(db, val.id, val.session_token)).toEqual([]);
  expect(send(marco, "valentina-hermes", "old general").ok).toBe(true);
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  db.query("UPDATE messages SET sent_at = ? WHERE text IN ('closed chat mail', 'old general')").run(old);

  // General mail keeps its old expiry (live recipients hold a local copy);
  // chat mail is kept until the chat reads it.
  expect(gcOldMessages(db)).toBe(1);
  expect(chatInbox(db).find((e) => e.to_chat === "20261029_121224_2b437e")?.unread).toBe(1);
  const later = pollMessages(db, val.id, val.session_token, undefined, "email shit");
  expect(later.map((m) => m.text)).toEqual(["closed chat mail"]);
});
