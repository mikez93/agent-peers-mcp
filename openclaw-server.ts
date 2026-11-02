#!/usr/bin/env bun
// OpenClaw adapter (bd-b2in.17). OpenClaw's Codex harness launches this stdio
// MCP server from an mcp.servers entry scoped to one agent
// (codex.agents: ["<agent>"]), one child per session thread. The entry's env
// must carry AGENT_PEERS_OPENCLAW_AGENT=<agent> and PEER_NAME=<name>.
// Only the child proven to run agent:<agent>:main takes the peer identity;
// see shared/openclaw-gate.ts and docs/components/openclaw-peer.md.
//
// Kill switch: an explicit AGENT_PEERS_ENABLED=0 always wins, and the file
// ~/.agent-peers-openclaw/disabled turns every OpenClaw child inert without
// editing OpenClaw config. State and queued mail are untouched either way.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { openclawRoot } from "./shared/openclaw-state.ts";

process.env.AGENT_PEERS_RUNTIME = "openclaw";

const disabledFlag = join(openclawRoot(), "disabled");
if (existsSync(disabledFlag)) {
  console.error(`[agent-peers/openclaw] disabled by flag file ${disabledFlag}; running inert`);
  process.env.AGENT_PEERS_ENABLED = "0";
} else {
  process.env.AGENT_PEERS_ENABLED ??= "1";
}

await import("./codex-server.ts");

export {};
