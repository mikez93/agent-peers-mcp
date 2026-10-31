// Broker-side address resolution (v3).
//
// Lives in the broker so every client, including old processes that loaded
// earlier code, gets find-by-name and chat routing after a broker restart.
// Precedence, most exact first:
//   1. peer UUID
//   2. chat route ID (a stable UUID standing for one Hermes chat)
//   3. exact peer name (case-sensitive, today's behavior)
//   4. case-insensitive exact name among deliverable peers
//   5. persona or leading name tokens ("marco") among deliverable peers
// Several matches never guess: the sender gets the exact names back.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { matchesPersonaQuery, parseAddress, personaOf } from "./peer-address.ts";
import { GENERAL_MAILBOX, type ChatCandidate, type ChatDirectory } from "./chat-directory.ts";

export const CHAT_MAIL_CAPABILITY = "chat-mail";

export interface AddressRow {
  id: string;
  name: string;
  peer_type: string;
  cwd: string | null;
  git_root: string | null;
  persona: string | null;
  capabilities: string | null;
  mailbox_owner: string | null;
  durable: number;
  last_seen: string;
}

export type AddressResolution =
  | { kind: "peer"; row: AddressRow; chatKey: string | null; chatTitle: string | null; notice?: string }
  | { kind: "remote"; host: string; name: string; chat: string | null }
  | { kind: "error"; code: "ambiguous" | "chat_miss" | "invalid"; error: string; candidates?: string[] }
  | { kind: "none" };

export interface RemoteSendRequest {
  db: Database;
  fromId: string;
  fromName: string;
  host: string;
  name: string;
  chat: string | null;
  text: string;
  fromChat: string | null;
  sentAt: string;
}

export interface RemoteSendResult {
  ok: boolean;
  error?: string;
  message_id?: number;
  notice?: string;
  candidates?: string[];
}

export interface AddressingDeps {
  chats?: ChatDirectory;
  isLocalHost?: (host: string) => boolean;
  /** Federation hook: queue a message for another machine. Runs inside the
   *  send transaction, so it must be synchronous (write an outbox row). */
  remote?: (req: RemoteSendRequest) => RemoteSendResult;
  /** Federation hook: a persisted remote UUID (peer or chat route) → its host. */
  remoteRoute?: (id: string) => { host: string; name: string; chat: string | null } | null;
  /** Federation hook: the sender of a relayed message, which has no local row. */
  senderForMessage?: (messageId: number) => {
    from_id: string; from_name: string; from_peer_type: string; from_cwd: string; from_summary: string;
  } | null;
}

const ROW_COLS = "id, name, peer_type, cwd, git_root, persona, capabilities, mailbox_owner, durable, last_seen";

export function defaultIsLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  const full = hostname().toLowerCase();
  const short = full.split(".")[0] ?? full;
  return h === full || h === short || h === "localhost";
}

export function hasCapability(row: { capabilities: string | null }, cap: string): boolean {
  if (!row.capabilities) return false;
  return row.capabilities.split(",").map((c) => c.trim()).includes(cap);
}

/** A stable UUID-shaped ID for one chat, so old clients can reply to it. */
export function chatRouteId(peerName: string, chatKey: string): string {
  const h = createHash("sha256").update(`agent-peers-chat\0${peerName}\0${chatKey}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function recordChatRoute(db: Database, peerName: string, chatKey: string, title: string | null): string {
  const id = chatRouteId(peerName, chatKey);
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO chat_routes (id, peer_name, chat_key, title, created_at, last_used)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = COALESCE(excluded.title, chat_routes.title), last_used = excluded.last_used`,
  ).run(id, peerName, chatKey, title, now, now);
  return id;
}

export function getChatRoute(db: Database, id: string): { peer_name: string; chat_key: string; title: string | null } | null {
  return db.query<{ peer_name: string; chat_key: string; title: string | null }, [string]>(
    "SELECT peer_name, chat_key, title FROM chat_routes WHERE id = ?",
  ).get(id) ?? null;
}

function rowById(db: Database, id: string): AddressRow | null {
  return db.query<AddressRow, [string]>(`SELECT ${ROW_COLS} FROM peers WHERE id = ?`).get(id) ?? null;
}

export function rowByName(db: Database, name: string): AddressRow | null {
  return db.query<AddressRow, [string]>(`SELECT ${ROW_COLS} FROM peers WHERE name = ?`).get(name) ?? null;
}

function repoLabel(row: AddressRow): string {
  const root = row.git_root || row.cwd || "";
  return root.split("/").filter(Boolean).pop() ?? "";
}

function describe(rows: AddressRow[]): string {
  return rows.map((r) => `${r.name} (${r.peer_type}${repoLabel(r) ? `, ${repoLabel(r)}` : ""})`).join("; ");
}

function deliverableRows(db: Database, staleCutoff: string): AddressRow[] {
  return db.query<AddressRow, [string]>(
    `SELECT ${ROW_COLS} FROM peers WHERE (last_seen >= ? OR durable = 1) ORDER BY name`,
  ).all(staleCutoff);
}

/** Every peer a name query could mean, most exact first (directory lookups). */
export function findPeers(db: Database, query: string, staleCutoff: string): AddressRow[] {
  const exact = rowByName(db, query);
  if (exact) return [exact];
  const q = query.toLowerCase();
  const live = deliverableRows(db, staleCutoff);
  const nocase = live.filter((r) => r.name.toLowerCase() === q);
  if (nocase.length) return nocase;
  return live.filter((r) => matchesPersonaQuery(r.name, q) || personaOf(r) === q);
}

/** Resolve the name part to exactly one peer, or explain why not. */
export function resolvePeerName(db: Database, query: string, staleCutoff: string):
  { row: AddressRow } | { error: string; candidates?: string[] } | null {
  const exact = rowByName(db, query);
  if (exact) return { row: exact };
  const q = query.toLowerCase();
  const live = deliverableRows(db, staleCutoff);
  const nocase = live.filter((r) => r.name.toLowerCase() === q);
  if (nocase.length === 1) return { row: nocase[0]! };
  const matches = nocase.length > 1 ? nocase : live.filter((r) => matchesPersonaQuery(r.name, q) || personaOf(r) === q);
  if (matches.length === 1) return { row: matches[0]! };
  if (matches.length > 1) {
    return {
      error: `"${query}" matches ${matches.length} peers: ${describe(matches)}. Resend to one exact name.`,
      candidates: matches.map((r) => r.name),
    };
  }
  return null;
}

function chatAddress(owner: string, c: ChatCandidate, all: ChatCandidate[]): string {
  const title = c.title?.trim();
  const unique = title && all.filter((o) => (o.title ?? "").trim().toLowerCase() === title.toLowerCase()).length === 1;
  return `${owner}/${unique ? title : c.chat_key}`;
}

/** The peer whose mailbox holds this Hermes chat's mail: the durable owner. */
export function mailboxOwnerRow(db: Database, row: AddressRow): AddressRow {
  if (row.mailbox_owner && row.mailbox_owner !== row.name) {
    const owner = rowByName(db, row.mailbox_owner);
    if (owner && owner.peer_type === row.peer_type) return owner;
  }
  return row;
}

export function resolveAddress(db: Database, raw: string, staleCutoff: string, deps: AddressingDeps = {}): AddressResolution {
  const text = raw.trim();
  if (!text) return { kind: "none" };

  const byId = rowById(db, text);
  if (byId) return { kind: "peer", row: byId, chatKey: null, chatTitle: null };

  const route = getChatRoute(db, text);
  if (route) {
    const owner = rowByName(db, route.peer_name);
    if (!owner) return { kind: "error", code: "invalid", error: `the agent behind chat ${text} (${route.peer_name}) is not registered` };
    if (!hasCapability(owner, CHAT_MAIL_CAPABILITY)) {
      return { kind: "peer", row: owner, chatKey: null, chatTitle: null,
        notice: `${owner.name} has not switched to per-chat mail yet; delivered to its general mailbox` };
    }
    return { kind: "peer", row: owner, chatKey: route.chat_key, chatTitle: route.title };
  }

  const remoteRoute = deps.remoteRoute?.(text);
  if (remoteRoute) return { kind: "remote", host: remoteRoute.host, name: remoteRoute.name, chat: remoteRoute.chat };

  const parsed = parseAddress(text);
  if (!parsed.name) return { kind: "none" };
  if (parsed.host && !(deps.isLocalHost ?? defaultIsLocalHost)(parsed.host)) {
    return { kind: "remote", host: parsed.host, name: parsed.name, chat: parsed.chat };
  }

  const named = resolvePeerName(db, parsed.name, staleCutoff);
  if (!named) return { kind: "none" };
  if ("error" in named) return { kind: "error", code: "ambiguous", error: named.error, candidates: named.candidates };
  const row = named.row;

  if (!parsed.chat) return { kind: "peer", row, chatKey: null, chatTitle: null };

  if (row.peer_type !== "hermes") {
    return { kind: "error", code: "invalid", error: `chat addresses work only for Hermes agents; ${row.name} is a ${row.peer_type} peer. Send to ${row.name} without "/${parsed.chat}".` };
  }
  const owner = mailboxOwnerRow(db, row);
  if (parsed.chat.toLowerCase() === GENERAL_MAILBOX) return { kind: "peer", row: owner, chatKey: null, chatTitle: null };
  if (!deps.chats) {
    return { kind: "error", code: "invalid", error: `chat lookup is not available on this machine; send to ${owner.name} or use its chat ID` };
  }
  const res = deps.chats.resolve(owner, parsed.chat);
  if (!res.ok) {
    const candidates = res.candidates.map((c) => chatAddress(owner.name, c, res.candidates));
    const hint = candidates.length ? ` Closest: ${candidates.map((c) => `"${c}"`).join(", ")}.` : "";
    return { kind: "error", code: "chat_miss", error: `${res.error}${hint} Nothing was sent or woken; resend to an exact chat address.`, candidates };
  }
  if (!hasCapability(owner, CHAT_MAIL_CAPABILITY)) {
    return { kind: "peer", row: owner, chatKey: null, chatTitle: null,
      notice: `${owner.name} has not switched to per-chat mail yet; delivered to its general mailbox, not to "${res.title ?? res.chat_key}"` };
  }
  return { kind: "peer", row: owner, chatKey: res.chat_key, chatTitle: res.title };
}

/** Resolve a sending chat so replies come back to it. Null when unknown. */
export function resolveSenderChat(db: Database, sender: AddressRow, fromChat: string | undefined, deps: AddressingDeps):
  { owner: AddressRow; chatKey: string; title: string | null } | null {
  if (!fromChat || sender.peer_type !== "hermes" || !deps.chats) return null;
  if (fromChat.trim().toLowerCase() === GENERAL_MAILBOX) return null;
  const owner = mailboxOwnerRow(db, sender);
  const route = getChatRoute(db, fromChat.trim());
  if (route && route.peer_name === owner.name) return { owner, chatKey: route.chat_key, title: route.title };
  const res = deps.chats.resolve(owner, fromChat);
  return res.ok ? { owner, chatKey: res.chat_key, title: res.title } : null;
}

/** Which mail a poll may draw. Old clients send no chat: general mail only. */
export type PollScope =
  | { mode: "general"; mailboxId: string }
  | { mode: "chat"; mailboxId: string; chatKey: string }
  | { mode: "none" };

export function resolvePollScope(db: Database, requester: AddressRow, chat: string | undefined, deps: AddressingDeps): PollScope {
  if (chat === undefined || chat === null || chat.trim() === "") return { mode: "general", mailboxId: requester.id };
  const owner = mailboxOwnerRow(db, requester);
  if (chat.trim().toLowerCase() === GENERAL_MAILBOX) return { mode: "general", mailboxId: requester.id };
  const route = getChatRoute(db, chat.trim());
  if (route && route.peer_name === owner.name) return { mode: "chat", mailboxId: owner.id, chatKey: route.chat_key };
  if (!deps.chats) return { mode: "none" };
  const res = deps.chats.resolve(owner, chat);
  return res.ok ? { mode: "chat", mailboxId: owner.id, chatKey: res.chat_key } : { mode: "none" };
}
