// v3 broker addressing: find-by-name, chat mail isolation, chat replies,
// remote hook, bounds. Old-client behavior (no chat field) must not change.

import { test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import {
  initDb, registerPeer, listPeers, sendMessage, pollMessages, ackMessages, setPeerSummary,
  configureAddressing, listChats, chatInbox, MAX_POLL_BATCH, MAX_ACK_TOKENS,
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
