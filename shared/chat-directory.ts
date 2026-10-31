// Chat directory: how the broker turns a Hermes chat address into an exact
// chat. The broker depends only on this interface; the Hermes implementation
// (reading each profile's state.db read-only) lives in hermes-chat-wake.ts.
//
// Rules (Mike and Marco, 2026-10-31):
// - Only an exact title (case-insensitive) or an exact session ID matches.
// - A near-miss wakes nothing; it returns candidates for the sender.
// - Looking chats up never adopts, wakes or consumes mail.

export interface ChatCandidate {
  /** Stable chat key: the Hermes session ID at the head of the chat lineage. */
  chat_key: string;
  title: string | null;
  last_active?: string | null;
  busy?: boolean;
  archived?: boolean;
}

export type ChatResolution =
  | { ok: true; chat_key: string; title: string | null }
  | { ok: false; error: string; candidates: ChatCandidate[] };

export interface ChatPeer {
  name: string;
  peer_type: string;
  cwd?: string | null;
  persona?: string | null;
}

export interface ChatDirectory {
  /** Resolve a title, session ID or chat key inside this peer's profile. */
  resolve(peer: ChatPeer, query: string): ChatResolution;
  /** Read-only listing for discovery: newest first, optional title search. */
  list(peer: ChatPeer, opts: { query?: string; limit: number; offset: number }): ChatCandidate[];
}

/** The general mailbox name a Hermes chat uses to read profile-level mail. */
export const GENERAL_MAILBOX = "general";
