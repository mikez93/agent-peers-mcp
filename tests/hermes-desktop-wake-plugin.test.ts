// Runs the Python unit tests for hermes-plugins/agent-peers-desktop-wake so `bun test` covers
// the in-process Hermes plugin too. Hermes itself is not needed: the tests use a fake ctx.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("hermes desktop wake plugin: python unit tests pass", () => {
  const script = join(import.meta.dir, "python", "test_hermes_desktop_wake.py");
  const run = spawnSync("python3", ["-B", script], { encoding: "utf8", timeout: 60_000 });
  if (run.error) throw run.error;
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stderr).toMatch(/Ran \d+ tests[\s\S]*\nOK/);
});
