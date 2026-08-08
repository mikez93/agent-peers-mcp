#!/usr/bin/env bun
// Hermes Agent adapter. Reuses the durable polling transport while registering
// a first-class Hermes identity and keeping Codex-only wake plumbing disabled.

process.env.AGENT_PEERS_RUNTIME = "hermes";
process.env.AGENT_PEERS_ENABLED ??= "1";

await import("./codex-server.ts");

export {};
