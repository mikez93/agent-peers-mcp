import { expect, test } from "bun:test";

import { parentProcessWasLost } from "../shared/process-lifecycle.ts";

test("an MCP exits only when a real original parent reparents to launchd", () => {
  expect(parentProcessWasLost(42, 1)).toBe(true);
  expect(parentProcessWasLost(42, 99)).toBe(false);
  expect(parentProcessWasLost(1, 1)).toBe(false);
});
