#!/usr/bin/env bun
// Antigravity adapter. Two launchers use it:
// - agypeer injects it into its headless `agy acp` session, with a launch claim.
// - The fleet registers it in Antigravity's user MCP config with
//   AGENT_PEERS_AGY_USER_CONFIG=1, for interactive `agy` started through
//   `agy-interactive.ts launch`, which exports a launch claim to agy.
// That user-level entry also loads in every other agy process (agypeer's
// `agy acp`, one-off `agy -p`, `command agy`). Without a claim, those stay off
// the network: the server offers no tools and registers no peer.

process.env.AGENT_PEERS_RUNTIME = "antigravity";
process.env.AGENT_PEERS_ENABLED ??= "1";

if (process.env.AGENT_PEERS_AGY_USER_CONFIG === "1" && !process.env.AGENT_PEERS_LAUNCH_CLAIM_ID) {
  const { serveNoTools } = await import("./shared/noop-mcp.ts");
  await serveNoTools("agent-peers");
} else {
  await import("./codex-server.ts");
}

export {};
