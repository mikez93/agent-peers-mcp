// shared/wake-launch-role.ts
// Decides whether an agent-peers MCP child should register as a peer.
//
// WHY THIS EXISTS
//
// In codex `--remote` mode the app-server — not the thin resume TUI — spawns
// the agent-peers MCP, and it spawns ONE PER CODEX THREAD, not one per
// app-server. `thread/start`, a cold `thread/resume`, `thread/fork`, a spawned
// subagent and a detached review each create a Session, and each Session
// launches its own stdio MCP child. The app-server also keeps unsubscribed
// threads loaded for 30 minutes, so children accumulate.
//
// Every one of those children previously called broker `register()`
// unconditionally, so ONE `codexpeer` launch produced N addressable peers.
// Observed live: two app-servers each hosting 4 agent-peers MCPs, which is why
// a single terminal accumulated ccr-codex-2 / -3-2-2-2 / -4-2-2 / -5-2-2. The
// downstream damage is worse than cosmetic: a message addressed to the peer's
// name can land in a twin the wake daemon is not watching, so it is never
// delivered and never reported as undelivered.
//
// There is NO spawn-time signal that identifies the owning thread. The stdio
// child gets a cleared environment, and the launcher's
// AGENT_PEERS_WAKE_THREAD_ID is app-server-process config, so it is copied
// IDENTICALLY into every per-thread child. cwd, ppid and tty do not
// disambiguate either. Codex stamps an authoritative `_meta.threadId` on
// `tools/call`, but NOT on the startup `tools/list`, so it cannot gate
// registration without making a peer undiscoverable until it happens to call a
// tool — and this network exists to deliver mail to peers that are doing
// nothing.
//
// So the launcher elects instead: it writes a single-use wake-launch claim, and
// the first child to consume it is the root. Losing children go inert. The
// launcher marks its app-server with AGENT_PEERS_WAKE_LAUNCH=1 so a loser can
// tell "I am a secondary thread of a wakeable launch" (go inert) from "I am an
// ordinary `codex` session that simply has no claim" (register normally) —
// without that flag the two are indistinguishable and gating would silently
// remove every plain Codex session from the network.

export type WakeLaunchRole =
  // Ordinary `codex` session, not launched by codexpeer. Registers as always.
  | "standalone"
  // The wakeable launch's root thread: won the claim, owns the peer identity.
  | "root"
  // A secondary thread inside a wakeable launch (fork, subagent, extra
  // thread). Must expose an MCP so its thread can start, but must NOT take a
  // peer identity, poll, or write to the terminal.
  | "secondary";

export function decideWakeLaunchRole(opts: {
  // AGENT_PEERS_WAKE_LAUNCH === "1": this app-server was started by the
  // wakeable launcher, and every thread it hosts inherits the flag.
  isWakeLaunch: boolean;
  // Whether this child successfully claimed the launch's single wake claim.
  claimedWakeRoot: boolean;
}): WakeLaunchRole {
  if (!opts.isWakeLaunch) return "standalone";
  return opts.claimedWakeRoot ? "root" : "secondary";
}

// Only a secondary suppresses its peer identity. A standalone session has
// always registered without a claim and must keep doing so — that is the
// ordinary `codex` case and the most dangerous thing to break.
export function shouldRegisterAsPeer(role: WakeLaunchRole): boolean {
  return role !== "secondary";
}

export function isWakeLaunchEnv(env: NodeJS.ProcessEnv): boolean {
  return env.AGENT_PEERS_WAKE_LAUNCH === "1";
}
