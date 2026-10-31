import { homedir } from "node:os";
import { join } from "node:path";

export type StateRuntime = "codex" | "hermes" | "droid" | "claude";

/** One resolver, two existing layouts. Inbox readers follow inbox writers;
 * coordination files stay where old running launchers hold their locks. Moving
 * those locks during a rolling upgrade would elect a second session owner. */
export function resolveStateDir(opts: {
  runtime?: StateRuntime;
  kind?: "inbox" | "coordination";
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = opts.env ?? process.env;
  const selected = env.AGENT_PEERS_RUNTIME;
  const runtime = opts.runtime
    ?? (selected === "hermes" || selected === "droid" ? selected : "codex");
  const inbox = opts.kind !== "coordination";
  return opts.rootDir
    ?? (inbox || runtime === "hermes" || runtime === "claude" ? env.AGENT_PEERS_STATE_DIR : undefined)
    ?? (runtime === "claude" ? undefined : env[`AGENT_PEERS_${runtime.toUpperCase()}_STATE_DIR`])
    ?? (inbox && (runtime === "hermes" || runtime === "droid") ? env.AGENT_PEERS_CODEX_STATE_DIR : undefined)
    ?? join(env.HOME ?? homedir(), `.agent-peers-${runtime}`);
}
