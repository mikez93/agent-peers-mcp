#!/usr/bin/env bun
// Hermes Agent adapter. Reuses the durable polling transport while registering
// a first-class Hermes identity and keeping Codex-only wake plumbing disabled.
//
// Kill switches (2026-08-10): an explicit AGENT_PEERS_ENABLED=0 always wins
// (the `??=` below never overrides an existing value), and the flag file
// ~/.agent-peers-hermes/disabled disables every Hermes surface at once — for
// hosts where the operator cannot inject env into the Hermes-managed MCP
// launch. Remove the file and /reload-mcp to rejoin.
//
// AGENT_PEERS_HERMES_ROLE=passive marks a surface that should never take a
// peer identity (e.g. a serve process when the gateway owns the profile's
// name): it runs a zero-tool inert MCP, same as a Codex secondary thread.
// Without it, gateway+serve arbitrate via the name-claim election in
// codex-server.ts — passive is the configuration-level override for hosts
// that CAN distinguish their surfaces.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

process.env.AGENT_PEERS_RUNTIME = "hermes";

const disabledFlag = join(
  process.env.AGENT_PEERS_STATE_DIR
    ?? process.env.AGENT_PEERS_HERMES_STATE_DIR
    ?? join(homedir(), ".agent-peers-hermes"),
  "disabled",
);
if (existsSync(disabledFlag)) {
  console.error(`[agent-peers/hermes] disabled by flag file ${disabledFlag}; running inert`);
  process.env.AGENT_PEERS_ENABLED = "0";
} else if (process.env.AGENT_PEERS_HERMES_ROLE === "passive") {
  console.error("[agent-peers/hermes] AGENT_PEERS_HERMES_ROLE=passive; running inert (no peer identity)");
  process.env.AGENT_PEERS_ENABLED = "0";
} else {
  process.env.AGENT_PEERS_ENABLED ??= "1";
}

await import("./codex-server.ts");

export {};
