import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PAPERCLIP_AGENT_ENV_MARKERS,
  paperclipAgentMarker,
  paperclipRefusalMessage,
} from "../shared/paperclip-guard.ts";

const REPO = join(import.meta.dir, "..");

describe("paperclipAgentMarker", () => {
  test("returns null for an ordinary peer session", () => {
    expect(paperclipAgentMarker({})).toBeNull();
    expect(paperclipAgentMarker({ AGENT_PEERS_ENABLED: "1", PEER_NAME: "ccr-codex" })).toBeNull();
  });

  test("detects a Paperclip-spawned agent run", () => {
    expect(paperclipAgentMarker({ PAPERCLIP_RUN_ID: "34690f72" })).toBe("PAPERCLIP_RUN_ID");
  });

  test("detects a shell embodied via `paperclipai agent local-cli`", () => {
    expect(paperclipAgentMarker({ PAPERCLIP_AGENT_ID: "69bced1e" })).toBe("PAPERCLIP_AGENT_ID");
  });

  test("blank and whitespace-only markers do not count as set", () => {
    expect(paperclipAgentMarker({ PAPERCLIP_AGENT_ID: "" })).toBeNull();
    expect(paperclipAgentMarker({ PAPERCLIP_RUN_ID: "   " })).toBeNull();
  });

  // A board operator running the CLI legitimately carries these. Blocking them
  // would break the sanctioned escalation path in the `paperclip-ops` skill,
  // where an operator-directed agent configures Paperclip from a peer session.
  test("does NOT block a board operator's environment", () => {
    expect(
      paperclipAgentMarker({
        PAPERCLIP_HOME: "/Users/mike/.paperclip",
        PAPERCLIP_INSTANCE_ID: "default",
        PAPERCLIP_CONFIG: "/Users/mike/.paperclip/instances/default/config.json",
        PAPERCLIP_COMPANY_ID: "534f3264-0e9f-4c62-b437-e300984de5a3",
      }),
    ).toBeNull();
  });

  test("refusal message names the marker that fired", () => {
    for (const marker of PAPERCLIP_AGENT_ENV_MARKERS) {
      expect(paperclipRefusalMessage(marker)).toContain(marker);
    }
  });
});

// These assert INTENT, not shape: the guard is worthless if it runs after the
// AGENT_PEERS_ENABLED check, because then an adapter config that sets the flag
// would put a Paperclip agent back on the network — the exact regression this
// module exists to prevent.
describe("activation-gate ordering", () => {
  for (const server of ["claude-server.ts", "codex-server.ts"]) {
    test(`${server} checks the Paperclip guard before the enable flag`, () => {
      const src = readFileSync(join(REPO, server), "utf8");
      const guardAt = src.indexOf("paperclipAgentMarker()");
      const enableAt = src.indexOf('process.env.AGENT_PEERS_ENABLED !== "1"');

      expect(guardAt).toBeGreaterThan(-1);
      expect(enableAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(enableAt);
    });

    test(`${server} returns without registering when the guard fires`, () => {
      const src = readFileSync(join(REPO, server), "utf8");
      const guardAt = src.indexOf("paperclipAgentMarker()");
      const block = src.slice(guardAt, guardAt + 600);

      // Zero tools exposed, and the function returns before any broker call.
      expect(block).toContain("tools: []");
      expect(block).toContain("return;");
      expect(block).not.toContain("client.register");
    });
  }
});
