import { expect, test } from "bun:test";
import { COLLEAGUE_PROTOCOL } from "../shared/colleague-prompt.ts";
import {
  formatPeerList,
  peerStartedAt,
  sortPeersNewestFirst,
} from "../shared/peer-list.ts";
import type { Peer } from "../shared/types.ts";

function peer(overrides: Partial<Peer> & Pick<Peer, "id" | "name">): Peer {
  return {
    id: overrides.id,
    name: overrides.name,
    peer_type: overrides.peer_type ?? "claude",
    pid: overrides.pid ?? 1,
    cwd: overrides.cwd ?? "/repo",
    git_root: overrides.git_root ?? "/repo",
    tty: overrides.tty ?? null,
    summary: overrides.summary ?? "",
    registered_at: overrides.registered_at ?? "2026-01-01T00:00:00.000Z",
    ...(overrides.started_at ? { started_at: overrides.started_at } : {}),
    last_seen: overrides.last_seen ?? "2026-09-01T20:00:00.000Z",
  };
}

test("old-broker payload falls back to registered_at and still sorts newest first", () => {
  const older = peer({ id: "a", name: "older", registered_at: "2026-01-01T00:00:00.000Z" });
  const newer = peer({ id: "b", name: "newer", registered_at: "2026-02-01T00:00:00.000Z" });

  expect(peerStartedAt(newer)).toBe(newer.registered_at);
  expect(sortPeersNewestFirst([older, newer]).map((p) => p.name)).toEqual(["newer", "older"]);
});

test("peer list surfaces Started and Heartbeat even when summary is empty", () => {
  const output = formatPeerList([
    peer({
      id: "new",
      name: "fresh-peer",
      started_at: "2026-09-01T19:59:00.000Z",
      summary: "",
    }),
  ], "repo");

  expect(output).toContain("Ordered by working-session start, newest first");
  expect(output).toContain("Started: 2026-09-01T19:59:00.000Z");
  expect(output).toContain("Heartbeat: 2026-09-01T20:00:00.000Z");
  expect(output).not.toContain("Summary:");
  expect(output).toContain("An empty summary or unfamiliar harness is not a reason to exclude a candidate");
  expect(output).toContain("exact name, ID, or different rule");
});

test("shared colleague protocol states the exact newest-session selection boundaries", () => {
  const compact = COLLEAGUE_PROTOCOL.replace(/\s+/g, " ");
  expect(compact).toContain("choose the newest working session by `Started` unless the user gave another rule");
  expect(compact).toContain("An exact user-supplied name or ID wins over recency");
  expect(compact).toContain("summary is empty or its harness differs");
  expect(compact).toContain("state genuine ambiguity instead of guessing");
});
