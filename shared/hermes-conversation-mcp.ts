import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HERMES_CONVERSATION_TOOLS, type HermesConversationAdapter } from "./hermes-conversation-adapter.ts";

// Not an entry point. The runtime owns activation/containment gates; fixtures
// can attach an in-memory transport without starting a real backend.
export function createHermesConversationMcp(adapter: HermesConversationAdapter): Server {
  const server = new Server({ name: "agent-peers-hermes-conversations", version: "0.1.0" },
    { capabilities: { tools: {} } });
  const properties: Record<string, Record<string, unknown>> = {
    list_peers: { scope: { type: "string", enum: ["machine", "directory", "repo"] },
      peer_type: { type: "string", enum: ["claude", "codex", "hermes", "droid"] } },
    send_message: { to_id: { type: "string" }, message: { type: "string" } },
    set_summary: { summary: { type: "string" } },
    check_messages: {},
    wait_for_peer_messages: { timeout_ms: { type: "number", minimum: 0, maximum: 60_000 }, from: { type: "string" } },
    rename_peer: { new_name: { type: "string" } },
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: HERMES_CONVERSATION_TOOLS.map(name => ({ name,
      description: `${name.replaceAll("_", " ")} for this conversation's private peer identity.`,
      inputSchema: { type: "object" as const, properties: properties[name], additionalProperties: false } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => ({
    ...await adapter.call(request.params, extra.signal),
  }));
  return server;
}
