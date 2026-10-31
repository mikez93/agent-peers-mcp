#!/usr/bin/env bun
// wake-daemon.ts
// One-shot wake pass for app-server-backed Codex sessions.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runWakePass } from "./shared/wake-daemon.ts";
import { runHermesWakePass, chatWakeDir } from "./shared/hermes-wake-pass.ts";
import { atomicWriteJson } from "./shared/file-state.ts";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const quietNoop = args.has("--quiet-noop");
const results = await runWakePass();
for (const result of results) {
  if (json) {
    console.log(JSON.stringify(result));
    continue;
  }
  // Daemon mode (--quiet-noop) honors the observation log: only transitions and
  // heartbeats print, so a wedged/busy peer no longer floods the log. The manual
  // `wake` command stays verbose (prints every result) for on-demand debugging.
  if (quietNoop && !result.log) continue;

  const ts = new Date().toISOString();
  const target = `${result.peer_name} (${result.peer_id.slice(0, 8)}…) thread=${result.thread_id}`;
  const note = result.note ? ` — ${result.note}` : "";
  if (result.action === "wake") {
    console.log(`${ts} wake: ${result.reason === "steered" ? "steered" : "nudged"} ${target}${note}`);
  } else {
    console.log(`${ts} wake: skipped ${target} (${result.reason})${note}`);
  }
}
if (!json && !quietNoop && results.length === 0) {
  console.log(`${new Date().toISOString()} wake: no wakeable Codex sessions registered`);
}

// Hermes chats with unread mail (bd-b2in.5). Does nothing until a profile is
// listed in ~/.agent-peers-hermes/chat-wake/enabled. A failure here never
// affects the Codex pass above.
try {
  const hermes = await runHermesWakePass();
  const seenPath = join(chatWakeDir(), "last-logged.json");
  let seen: Record<string, string> = {};
  try { seen = JSON.parse(readFileSync(seenPath, "utf8")); } catch { /* first run */ }
  let changed = false;
  for (const r of hermes) {
    if (json) { console.log(JSON.stringify({ hermes: r })); continue; }
    const key = `${r.peer_name}/${r.chat ?? "general"}`;
    if (quietNoop && seen[key] === r.outcome.state) continue;
    if (seen[key] !== r.outcome.state) { seen[key] = r.outcome.state; changed = true; }
    console.log(`${new Date().toISOString()} hermes: ${r.outcome.state} ${key} — ${r.outcome.detail}`);
  }
  if (changed) await atomicWriteJson(seenPath, seen);
} catch (e) {
  console.log(`${new Date().toISOString()} hermes: wake pass failed: ${e instanceof Error ? e.message : String(e)}`);
}
