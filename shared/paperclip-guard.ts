// Paperclip containment (2026-08-27).
//
// An agent running INSIDE a Paperclip company must never join the agent-peers
// network, in either direction. It must not register with the broker (so no
// peer can list it, message it, or wake it), and it must not receive the peer
// tools (so it cannot message out). Refusing registration is the single choke
// point that achieves both.
//
// WHY
// Paperclip is a control plane. It has its own board, org chart, issue queue,
// approval gates, budget accounting, and audit log, and every agent action is
// attributable to a run. The peer network is the opposite thing on purpose:
// flat, conversational, unlogged, and wakeable by any colleague. An agent that
// lives on both at once has two inboxes, two chains of command, and two sets
// of state that never reconcile — and half its work becomes invisible to the
// board that is supposed to govern it.
//
// This is not hypothetical. On 2026-08-27 CCR ran two "Maren"s simultaneously:
// the Paperclip agent 69bced1e driven through the board API, and a
// hand-launched peer wearing the same persona in the same repo. They
// coordinated with the same colleague about the same task and shared no state.
// Pausing the board agent stopped exactly one of them, which is precisely the
// failure this guard exists to prevent.
//
// The separation used to hold only by accident: the peer MCP self-disables
// unless AGENT_PEERS_ENABLED=1, and Paperclip's adapter happened not to set it.
// One adapter-config edit would have silently removed that protection. This
// module makes it an enforced invariant instead.
//
// DETECTION
// Paperclip mints per-run embodiment env vars for every agent process it
// spawns; the CLI claims the whole PAPERCLIP_ prefix as runtime-owned (see
// `isPaperclipRuntimeEnvKey` in paperclipai). `paperclipai agent local-cli`
// exports the same identity into an ordinary shell so a local session can act
// AS a Paperclip agent. Both cases are "an agent inside Paperclip" and both
// are blocked.
//
// We key ONLY on identity markers. Deliberately NOT included:
//   PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID, PAPERCLIP_CONFIG, PAPERCLIP_COMPANY_ID
// A board OPERATOR legitimately carries those while running the CLI, and
// operators are allowed on the peer network — that is the whole point of the
// escalation path documented in the `paperclip-ops` skill. Agent EMBODIMENT is
// the thing being blocked, not proximity to Paperclip.

export const PAPERCLIP_AGENT_ENV_MARKERS = [
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_RUN_ID",
] as const;

export type PaperclipAgentMarker = (typeof PAPERCLIP_AGENT_ENV_MARKERS)[number];

/**
 * Returns the name of the first Paperclip agent-embodiment env var that is
 * present and non-empty, or null when this process is not a Paperclip agent.
 * Returning the marker name (rather than a boolean) lets the caller log
 * exactly which signal fired, which is the difference between a debuggable
 * refusal and a mystery.
 */
export function paperclipAgentMarker(
  env: Record<string, string | undefined> = process.env,
): PaperclipAgentMarker | null {
  for (const key of PAPERCLIP_AGENT_ENV_MARKERS) {
    if ((env[key] ?? "").trim() !== "") return key;
  }
  return null;
}

/**
 * Operator-facing explanation logged when the guard fires. Kept here so both
 * server entrypoints emit identical wording and there is one place to edit it.
 */
export function paperclipRefusalMessage(marker: PaperclipAgentMarker): string {
  return (
    `agent-peers refused: this session is a Paperclip agent (${marker} is set). ` +
    `Paperclip agents are governed by their company board, org chart and issue ` +
    `queue — not by the peer network — so they never register as peers and ` +
    `cannot be listed, messaged, or woken by one. Coordinate through Paperclip ` +
    `issues and comments instead. If you need this session on the peer network, ` +
    `run it outside Paperclip.`
  );
}
