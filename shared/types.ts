// shared/types.ts
// Canonical types used by broker, clients, and CLI.

import type { ChatCandidate } from "./chat-directory.ts";

export type PeerId = string; // UUID v4
export type PeerType = "claude" | "codex" | "hermes" | "droid";
export type PeerName = string; // Validated by shared/names.ts; UUID-shaped names are excluded.

export interface Peer {
  id: PeerId;
  name: PeerName;
  peer_type: PeerType;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  registered_at: string; // ISO timestamp
  /** Start of the real working-session lineage. Optional while old brokers
   * and clients coexist during a rolling upgrade; readers fall back to
   * registered_at. */
  started_at?: string; // canonical UTC ISO timestamp
  last_seen: string; // ISO timestamp
  /** Persona slug (AGENTS.md name) when known. Optional, additive (v3). */
  persona?: string | null;
}

export interface LeasedMessage {
  id: number;
  from_id: PeerId;
  from_name: PeerName;
  from_peer_type: PeerType;
  from_cwd: string;
  from_summary: string;
  to_id: PeerId;
  text: string;
  sent_at: string;
  lease_token: string;
  /** v3 chat mail. The recipient chat (Hermes session ID), when addressed. */
  to_chat?: string | null;
  /** v3 chat mail. The sending chat, when the sender was a Hermes chat. */
  from_chat?: string | null;
}

// ----- Broker API request/response -----

export interface RegisterRequest {
  peer_type: PeerType;
  name?: PeerName;
  pid: number;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  summary: string;
  /** Stable start of this client's real working session. Claude/Codex send
   * one value for the process lifetime. Hermes omits it because its MCP
   * surface can be a temporary child of a longer-lived durable identity. */
  started_at?: string;
  /** Durable retention is now EXPLICIT (2026-08-10): merely requesting a name
   *  no longer reserves it for 7 days (throwaway `hermes mcp test` spawns and
   *  crashed cli-operator peers were squatting names). Servers send true only
   *  for a real long-lived identity (PEER_NAME set and not ephemeral). Absent
   *  → ephemeral, the conservative direction. */
  durable?: boolean;
  /** Id of this client's previous incarnation, if it is re-registering after
   *  eviction. When that row is GONE, the broker atomically re-points its
   *  unacked mail to the new row — the mailbox survives the incarnation
   *  without reusing the session token (which stays the auth boundary). */
  prev_id?: string;
  /** v3: persona slug from the AGENTS.md declaration, for find-by-name. */
  persona?: string | null;
  /** v3: features this client implements, e.g. "chat-mail". Old clients omit
   *  it, and the broker then never stores mail they cannot read. */
  capabilities?: string[];
  /** v3: for a Hermes election loser, the durable mailbox name of its
   *  profile (e.g. "valentina-hermes"), so replies to its chats route there. */
  mailbox_owner?: PeerName;
}

export interface RegisterResponse {
  id: PeerId;
  name: PeerName;
  session_token: string; // opaque per-session auth token; required on peer mutations
}

export interface HeartbeatRequest { id: PeerId; session_token: string; }

// `known` is whether the broker still has a row for this peer (bd-e57.10).
// It is OPTIONAL on purpose: a broker predating this field omits it entirely,
// and a missing `known` must be read as "this broker cannot tell me" — never as
// "you have been evicted". Only an explicit `false` may trigger re-registration.
export interface HeartbeatResponse { ok: boolean; known?: boolean; }

export interface UnregisterRequest { id: PeerId; session_token: string; }

export interface SetSummaryRequest { id: PeerId; session_token: string; summary: string; }

export interface ListPeersRequest {
  scope: "machine" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
  peer_type?: PeerType;
}

export interface SendMessageRequest {
  from_id: PeerId;
  session_token: string;
  to_id_or_name: string;
  text: string;
  /** v3: the sending Hermes chat (title or session ID), so replies return to it. */
  from_chat?: string;
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  message_id?: number;
  /** Queued is not delivered or woken, especially for a saved conversation. */
  notice?: string;
  /** v3: when an address was ambiguous or a chat title missed, the exact
   *  addresses the sender can resend to. */
  candidates?: string[];
  /** v3: machine-readable failure reason. "unknown_peer" lets the broker's
   *  federation layer try other machines; old clients ignore it. */
  code?: "unknown_peer" | "stale_peer" | "mailbox_full" | "ambiguous" | "chat_miss" | "invalid" | "unauthorized";
}

export interface PollMessagesRequest {
  id: PeerId;
  session_token: string;
  /** v3: read one chat's mail (Hermes). "general" reads the general mailbox.
   *  Omitted: the general mailbox only (old clients never see chat mail). */
  chat?: string;
}

export interface PollMessagesResponse {
  messages: LeasedMessage[];
}

export interface AckMessagesRequest {
  id: PeerId;
  session_token: string;
  lease_tokens: string[];
}

export type AckTokenStatus = "acked" | "expired" | "unknown" | "wrong_session";

export interface AckMessagesResponse {
  ok: boolean;
  acked: number;
  /** Count of tokens whose lease expired before the ack arrived — the broker
   *  will re-offer those messages; callers must not treat them as delivered. */
  stale?: number;
  /** Per-token outcomes, present whenever acked < tokens sent. */
  results?: { token: string; status: AckTokenStatus }[];
}

export interface RenamePeerRequest {
  id: PeerId;
  session_token: string;
  new_name: PeerName;
}

export interface RenamePeerResponse {
  ok: boolean;
  error?: string;
  name?: PeerName;
}

// ----- v3 chat discovery and the Hermes chat inbox -----

export interface ListChatsRequest {
  id: string;
  session_token: string;
  peer: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface ListChatsResponse {
  ok: boolean;
  error?: string;
  candidates?: string[];
  peer?: string;
  chats?: (ChatCandidate & { address: string })[];
}

export interface ChatInboxEntry {
  peer_id: string;
  peer_name: string;
  /** Null is the general mailbox, which the profile's "Agent Peers" chat reads. */
  to_chat: string | null;
  title: string | null;
  unread: number;
  leased: number;
  max_id: number;
  oldest_sent_at: string;
}
