import { expect, test } from "bun:test";
import { workingSessionStartedAt } from "../shared/session-start.ts";

const FIXED = new Date("2026-09-02T06:30:00.000Z");

test("Claude and Codex stamp the real MCP-backed working session", () => {
  expect(workingSessionStartedAt("claude", () => FIXED)).toBe(FIXED.toISOString());
  expect(workingSessionStartedAt("codex", () => FIXED)).toBe(FIXED.toISOString());
});

test("Hermes omits temporary MCP helper start so durable lineage is preserved", () => {
  expect(workingSessionStartedAt("hermes", () => FIXED)).toBeUndefined();
});
