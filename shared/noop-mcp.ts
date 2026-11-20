// A stdio MCP server that offers no tools. Used when the fleet's user-level
// `agent-peers` entry loads in an agy process that must stay off the network.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function serveNoTools(name: string): Promise<void> {
  const server = new Server({ name, version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  await server.connect(new StdioServerTransport());
}
