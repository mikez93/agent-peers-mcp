// One Hermes chat-wake pass, run by wake-daemon.ts on every daemon tick next
// to the Codex pass. It asks the broker which Hermes chats have unread mail
// and hands each to Kepler's driver (shared/hermes-chat-wake.ts), which owns
// adoption, busy checks, retries and outcomes.
//
// Rollout is per profile: only profiles listed in the enable file are woken,
// so shipping this code wakes nothing until a profile is switched on.
//   ~/.agent-peers-hermes/chat-wake/enabled   one profile per line, # comments
// Removing a line (or the file) is the rollback. Mail stays queued.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "./broker-client.ts";
import { readSharedSecret } from "./shared-secret.ts";
import { resolveStateDir } from "./state-dir.ts";
import { hermesProfileForPeer, wakeHermesChat, type HermesChatWakeOutcome } from "./hermes-chat-wake.ts";
import type { ChatInboxEntry } from "./types.ts";

export interface HermesWakeResult {
  peer_name: string;
  profile: string;
  chat: string | null;
  outcome: HermesChatWakeOutcome;
}

/** States worth a log line in daemon mode; the rest repeat every tick. */
export const LOGGED_STATES = new Set(["launched", "done", "exhausted", "input_required", "not_found", "no_profile", "cancelled"]);

export function chatWakeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStateDir({ runtime: "hermes", kind: "coordination", env }), "chat-wake");
}

export function enabledProfiles(env: NodeJS.ProcessEnv = process.env): Set<string> {
  try {
    const text = readFileSync(join(chatWakeDir(env), "enabled"), "utf8");
    return new Set(text.split("\n").map((l) => l.replace(/#.*/, "").trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function defaultHermesBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_PEERS_HERMES_BIN) return env.AGENT_PEERS_HERMES_BIN;
  // launchd gives the daemon a bare PATH, so prefer the installed binary.
  const local = join(env.HOME ?? homedir(), ".local", "bin", "hermes");
  return existsSync(local) ? local : "hermes";
}

export async function runHermesWakePass(opts: {
  env?: NodeJS.ProcessEnv;
  inbox?: () => Promise<ChatInboxEntry[] | null>;
  wake?: typeof wakeHermesChat;
} = {}): Promise<HermesWakeResult[]> {
  const env = opts.env ?? process.env;
  const enabled = enabledProfiles(env);
  if (enabled.size === 0) return [];
  const inbox = opts.inbox ?? (() => {
    const port = env.AGENT_PEERS_PORT ?? "7900";
    const secretPath = env.AGENT_PEERS_SECRET_PATH || undefined;
    return createClient(`http://127.0.0.1:${port}`, () => readSharedSecret(secretPath), { timeoutMs: 5000 }).chatInbox();
  });
  const entries = await inbox();
  if (!entries) return []; // broker predates the chat inbox
  const wake = opts.wake ?? wakeHermesChat;
  const hermesBin = defaultHermesBin(env);
  const results: HermesWakeResult[] = [];
  for (const e of entries) {
    const profile = hermesProfileForPeer({ name: e.peer_name, peer_type: "hermes" });
    if (!profile || !enabled.has(profile)) continue;
    try {
      const outcome = await wake(
        { peerName: e.peer_name, profile, chatKey: e.to_chat, title: e.title, unread: e.unread, maxId: e.max_id },
        { hermesBin, env, stateDir: resolveStateDir({ runtime: "hermes", kind: "coordination", env }) },
      );
      results.push({ peer_name: e.peer_name, profile, chat: e.to_chat, outcome });
    } catch (err) {
      results.push({ peer_name: e.peer_name, profile, chat: e.to_chat, outcome: { state: "exhausted", detail: `driver error: ${err instanceof Error ? err.message : String(err)}` } as HermesChatWakeOutcome });
    }
  }
  return results;
}
