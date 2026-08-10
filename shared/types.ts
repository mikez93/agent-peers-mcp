// shared/types.ts
// Canonical types used by broker, clients, and CLI.

export type PeerId = string; // UUID v4
export type PeerType = "claude" | "codex" | "hermes";
export type PeerName = string; // 1-32 chars, ^[a-zA-Z0-9_-]+$

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
  last_seen: string; // ISO timestamp
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
}

export interface SendMessageResponse {
  ok: boolean;
  error?: string;
  message_id?: number;
}

export interface PollMessagesRequest { id: PeerId; session_token: string; }

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
