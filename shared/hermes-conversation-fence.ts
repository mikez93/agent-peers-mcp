import type { Database } from "bun:sqlite";
import type { ConversationBinding, ConversationOwner } from "./hermes-conversation-bindings.ts";

export function hasConversationSchema(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hermes_conversations'").get();
}

export function findConversation(db: Database, idOrName: string): ConversationBinding | null {
  if (!hasConversationSchema(db)) return null;
  return db.query<ConversationBinding, [string, string]>(
    "SELECT * FROM hermes_conversations WHERE peer_id = ? OR name = ?",
  ).get(idOrName, idOrName);
}

// Every existing broker mutation/read/ack uses this transaction, so neither a
// legacy token-only request nor a callback from an old adapter can bypass v2.
// The schema is installed explicitly by fixtures, never on a normal startup.
export function withConversationFence<T>(db: Database, id: string, token: string,
  owner: ConversationOwner | undefined, action: () => T, lifecycleRelease = false): T {
  return db.transaction(() => {
    const row = findConversation(db, id);
    if (row) {
      const credential = db.query<{ session_token: string; generation: number }, [string]>(
        `SELECT t.session_token, t.generation FROM hermes_conversation_tokens t
         ${lifecycleRelease ? "" : "JOIN peers p ON p.id = t.peer_id AND p.session_token = t.session_token"}
         WHERE t.peer_id = ?`,
      ).get(id);
      if (!owner || owner.peer_id !== id || row.generation !== owner.generation
          || row.backend_id !== owner.backend_id || row.adapter_id !== owner.adapter_id
          || (lifecycleRelease ? !["active", "suspended"].includes(row.state)
            : row.state !== "active" || row.owner_lease_until <= Date.now())
          || credential?.generation !== owner.generation || credential.session_token !== token) {
        throw new Error("stale_conversation_owner");
      }
    } else if (owner) {
      throw new Error("unknown_conversation_owner");
    }
    return action();
  }).immediate();
}
