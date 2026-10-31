// The list_chats tool, shared by every agent-peers server: read-only lookup
// of a Hermes agent's chats so a sender can address one exactly.

import type { BrokerClient } from "./broker-client.ts";

export const LIST_CHATS_TOOL = {
  name: "list_chats",
  description:
    "List a Hermes agent's chats (titles and status only, never transcript text) so you can address one exactly as name/<chat title or ID>. " +
    "Read-only: it never wakes the agent or reads its mail. Use query to search titles and offset to page back to older chats. " +
    "Only an exact title (any letter case) or chat ID reaches a chat; a near miss returns candidates and sends nothing.",
  inputSchema: {
    type: "object" as const,
    properties: {
      peer: { type: "string" as const, description: "The Hermes agent, e.g. valentina or valentina-hermes." },
      query: { type: "string" as const, description: "Optional title search." },
      limit: { type: "number" as const, minimum: 1, maximum: 50 },
      offset: { type: "number" as const, minimum: 0 },
    },
    required: ["peer"],
  },
};

export async function runListChats(
  client: BrokerClient,
  me: { id: string; session_token: string },
  args: { peer?: unknown; query?: unknown; limit?: unknown; offset?: unknown },
): Promise<{ text: string; isError?: boolean }> {
  const peer = typeof args.peer === "string" ? args.peer.trim() : "";
  if (!peer) return { text: "list_chats needs peer (for example valentina).", isError: true };
  const res = await client.listChats({
    id: me.id, session_token: me.session_token, peer,
    ...(typeof args.query === "string" && args.query.trim() ? { query: args.query.trim() } : {}),
    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
  });
  if (res === null) return { text: "Chat lookup is not available: this machine's broker predates per-chat mail.", isError: true };
  if (!res.ok) {
    const more = res.candidates?.length ? ` Did you mean: ${res.candidates.join(", ")}?` : "";
    return { text: `list_chats failed: ${res.error}.${more}`, isError: true };
  }
  const chats = res.chats ?? [];
  if (chats.length === 0) return { text: `No chats found for ${res.peer}${typeof args.query === "string" && args.query ? ` matching "${args.query}"` : ""}.` };
  const lines = chats.map((c) => {
    const flags = [c.busy ? "busy" : null, c.archived ? "archived" : null].filter(Boolean).join(", ");
    return `- "${c.title ?? "(untitled)"}" → ${c.address}${c.last_active ? ` (last active ${c.last_active})` : ""}${flags ? ` [${flags}]` : ""}`;
  });
  return { text: `Chats for ${res.peer}. Send to the address shown, or to ${res.peer}/<exact title>:\n${lines.join("\n")}` };
}
