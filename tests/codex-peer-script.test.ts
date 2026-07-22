import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("normal codex-peer startup status is gated behind verbose mode", () => {
  const script = readFileSync(new URL("../bin/codex-peer", import.meta.url), "utf8");
  expect(script).toContain("CODEX_PEER_VERBOSE:-0");
  expect(script).not.toMatch(/printf 'codex-peer: (starting|resuming|network peer name|started background)/);
});
