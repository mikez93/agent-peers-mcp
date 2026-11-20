#!/usr/bin/env bun
// Antigravity adapter. The agypeer launcher injects this stdio MCP server
// into its `agy acp` session and owns that Antigravity process for the
// lifetime of the session.

process.env.AGENT_PEERS_RUNTIME = "antigravity";
process.env.AGENT_PEERS_ENABLED ??= "1";

await import("./codex-server.ts");

export {};
