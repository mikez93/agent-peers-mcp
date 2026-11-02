import type { PeerType } from "./types.ts";

/** Return one stable start timestamp for a real MCP-backed working session.
 * Hermes and OpenClaw deliberately omit it because their MCP child can be shorter-lived
 * than the durable agent identity it represents. */
export function workingSessionStartedAt(
  peerType: PeerType,
  now: () => Date = () => new Date(),
): string | undefined {
  return peerType === "hermes" || peerType === "openclaw" ? undefined : now().toISOString();
}
