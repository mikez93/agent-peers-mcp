#!/usr/bin/env bun
// Factory Droid adapter. The wakeable launcher injects this stdio MCP server
// into its ACP session and owns the corresponding Droid process for the
// lifetime of that session.

process.env.AGENT_PEERS_RUNTIME = "droid";
process.env.AGENT_PEERS_ENABLED ??= "1";

await import("./codex-server.ts");

export {};
