import type { Peer } from "./types.ts";

export const PEER_SELECTION_REMINDER =
  "For latest/current requests, choose the newest plausible working session unless the user supplied an exact name, ID, or different rule. An empty summary or unfamiliar harness is not a reason to exclude a candidate; state genuine identity ambiguity instead of guessing.";

export function peerStartedAt(peer: Peer): string {
  return peer.started_at ?? peer.registered_at;
}

function compareIsoDesc(a: string, b: string): number {
  return b.localeCompare(a);
}

export function sortPeersNewestFirst(peers: readonly Peer[]): Peer[] {
  return [...peers].sort((a, b) =>
    compareIsoDesc(peerStartedAt(a), peerStartedAt(b))
    || compareIsoDesc(a.registered_at, b.registered_at)
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id)
  );
}

export function formatPeerList(peers: readonly Peer[], scope: string): string {
  const ordered = sortPeersNewestFirst(peers);
  const lines = ordered.map((peer) => [
    `Peer ${peer.name} (${peer.peer_type})`,
    `  Started: ${peerStartedAt(peer)}`,
    `  ID: ${peer.id}`,
    `  CWD: ${peer.cwd}`,
    peer.tty ? `  TTY: ${peer.tty}` : null,
    peer.summary ? `  Summary: ${peer.summary}` : null,
    `  Heartbeat: ${peer.last_seen}`,
  ].filter(Boolean).join("\n"));

  return [
    `Found ${ordered.length} peer(s) (scope: ${scope}). Ordered by working-session start, newest first.`,
    PEER_SELECTION_REMINDER,
    "",
    lines.join("\n\n"),
  ].join("\n");
}
