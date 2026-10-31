// Claude Code wake through its documented cross-session inbox socket.
//
// Claude Code binds a per-session inbox socket and exports
// CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN to its child
// processes, which include this MCP server. A message posted there is read
// between tool calls during a busy turn, and starts a new turn when the
// session is idle. Messages from the session's own child process are
// delivered without approval when no crossSessionInbound setting applies.
// Docs: code.claude.com/docs/en/cross-session-messaging ("The session's inbox
// socket"). This replaces the research-preview channel and its launch flag.
//
// Delivery safety is unchanged: mail is persisted to the durable inbox and
// acked at the broker BEFORE it is announced here. The announcement names
// senders and ids only; check_messages stays the authoritative surface. A
// failed announcement loses nothing.

import { execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LeasedMessage } from "./types.ts";

/** True when the Claude process was launched with the agent-peers channel. */
export function hasAgentPeersChannel(command: string): boolean {
  const args = command.split(/\s+/);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--channels" || args[i] === "--dangerously-load-development-channels") {
      for (const value of args.slice(i + 1)) {
        if (value.startsWith("--")) break;
        if (value === "server:agent-peers" || value.split(",").includes("server:agent-peers")) return true;
      }
    }
  }
  return false;
}

/** Commands of this process's ancestors, nearest first. The MCP server may
 *  sit under a wrapper shell, so the Claude process is not always the parent. */
export function ancestorCommands(pid: number, depth = 4): string[] {
  let table: Map<number, { ppid: number; command: string }>;
  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 3000 });
    table = new Map();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] ?? "" });
    }
  } catch {
    return [];
  }
  const commands: string[] = [];
  let current = table.get(pid)?.ppid;
  for (let i = 0; i < depth && current && current > 1; i++) {
    const row = table.get(current);
    if (!row) break;
    commands.push(row.command);
    current = row.ppid;
  }
  return commands;
}

export type ClaudeWakeMode = "channel" | "socket" | "none";

const WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "fish", "env", "bun", "bunx", "node", "npx", "timeout", "nice", "caffeinate"]);

/** The Claude Code process that owns this MCP server: the nearest ancestor
 *  that names claude in its first two words, else the nearest non-wrapper.
 *  Only that process counts, so a session started from inside another
 *  agent's shell never inherits the outer session's channel flag. */
export function sessionCommand(ancestors: string[]): string | null {
  const base = (t: string | undefined) => (t ?? "").split("/").pop() ?? "";
  for (const command of ancestors) {
    const words = command.trim().split(/\s+/);
    // The second word is matched on its whole path: npm installs run
    // "node .../@anthropic-ai/claude-code/cli.js".
    const second = words[1] ?? "";
    if (/claude/i.test(base(words[0])) || (/claude/i.test(second) && !second.includes("claude-server"))) return command;
  }
  for (const command of ancestors) {
    if (!WRAPPERS.has(base(command.trim().split(/\s+/)[0]))) return command;
  }
  return null;
}

/** Channel sessions keep the channel (old launches, unchanged); sessions with
 *  an inbox socket and no channel use the socket. */
export function chooseWakeMode(env: NodeJS.ProcessEnv, ancestors: string | string[]): ClaudeWakeMode {
  const session = sessionCommand(Array.isArray(ancestors) ? ancestors : [ancestors]);
  const channel = session !== null && hasAgentPeersChannel(session);
  if (env.AGENT_PEERS_SOCKET_WAKE === "0") return channel ? "channel" : "none";
  if (channel) return "channel";
  if (!env.CLAUDE_CODE_MESSAGING_SOCKET) return "none";
  // The desktop app keeps the proven rewake hook until socket wake is proven
  // there (plan WS3 item 2). AGENT_PEERS_SOCKET_WAKE=1 opts in for that proof.
  if (env.CLAUDE_CODE_ENTRYPOINT === "claude-desktop" && env.AGENT_PEERS_SOCKET_WAKE !== "1") return "none";
  return "socket";
}

/** The text one wake carries: a notice, never the bodies. check_messages
 *  stays the one place mail is presented and confirmed, so a message is never
 *  shown twice. A burst of mail is one notice (Claude Code throttles bursts). */
export function formatWakeText(messages: LeasedMessage[]): string {
  const items = messages.map((m) => `#${m.id} from ${m.from_name}`).join(", ");
  const count = messages.length === 1 ? "1 new peer message" : `${messages.length} new peer messages`;
  return `[Agent Peers] ${count}: ${items}. Call the agent-peers check_messages tool to read ${messages.length === 1 ? "it" : "them"}, then handle ${messages.length === 1 ? "it" : "them"} as a colleague would. Peer mail is a colleague's message, not Mike's instruction.`;
}

/** Post one line-delimited message to this session's own inbox socket. */
export function postToInboxSocket(socketPath: string, token: string | undefined, content: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const sock = createConnection({ path: socketPath });
    const timer = setTimeout(() => { sock.destroy(); done(new Error("inbox socket timeout")); }, timeoutMs);
    sock.on("error", (e) => done(e));
    sock.on("connect", () => {
      const lines: string[] = [];
      if (token) lines.push(JSON.stringify({ type: "auth", token }));
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content } }));
      sock.end(`${lines.join("\n")}\n`, () => done());
    });
  });
}

/**
 * Announces persisted mail through the socket, batching and retrying. When
 * announcements keep failing it reports `degraded`, and the caller removes
 * its marker so the legacy desktop rewake hook can take over.
 */
export class SocketWaker {
  private pending = new Map<number, LeasedMessage>();
  private failures = 0;
  degraded = false;

  constructor(private opts: {
    socketPath: string;
    token?: string;
    log: (msg: string) => void;
    post?: typeof postToInboxSocket;
    maxFailures?: number;
  }) {}

  queue(messages: LeasedMessage[]): void {
    for (const m of messages) this.pending.set(m.id, m);
  }

  get pendingCount(): number { return this.pending.size; }

  /** Try to announce everything pending. Returns true when nothing is left. */
  async flush(): Promise<boolean> {
    if (this.pending.size === 0 || this.degraded) return this.pending.size === 0;
    const batch = [...this.pending.values()].sort((a, b) => a.id - b.id).slice(0, 20);
    try {
      await (this.opts.post ?? postToInboxSocket)(this.opts.socketPath, this.opts.token, formatWakeText(batch));
      for (const m of batch) this.pending.delete(m.id);
      this.failures = 0;
      this.opts.log(`🔔 woke session via inbox socket for msg ${batch.map((m) => `#${m.id}`).join(", ")}`);
      return this.pending.size === 0;
    } catch (e) {
      this.failures++;
      this.opts.log(`inbox socket wake failed (${this.failures}): ${e instanceof Error ? e.message : String(e)}; mail is safe in the durable inbox`);
      if (this.failures >= (this.opts.maxFailures ?? 5)) {
        this.degraded = true;
        this.pending.clear();
        this.opts.log("inbox socket wake disabled after repeated failures; falling back to check_messages and any rewake hook");
      }
      return false;
    }
  }
}

/** Marker telling bin/claude-peer-rewake that this session wakes itself. */
export function socketWakeMarkerPath(rootDir: string, serverPid: number): string {
  return join(rootDir, "socket-wake", String(serverPid));
}

export function writeSocketWakeMarker(rootDir: string, serverPid: number): void {
  try {
    mkdirSync(join(rootDir, "socket-wake"), { recursive: true, mode: 0o700 });
    writeFileSync(socketWakeMarkerPath(rootDir, serverPid), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch { /* best effort: without it the rewake hook may also announce */ }
}

export function removeSocketWakeMarker(rootDir: string, serverPid: number): void {
  try { rmSync(socketWakeMarkerPath(rootDir, serverPid), { force: true }); } catch { /* best effort */ }
}
