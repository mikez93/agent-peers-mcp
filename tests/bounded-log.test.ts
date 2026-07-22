import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BoundedLog, createWakeableAppServerLog } from "../shared/bounded-log.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true });
  }
});

test("BoundedLog rotates before the live file exceeds its byte cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-peers-log-"));
  tempDirs.push(dir);
  const path = join(dir, "app-server.log");
  const log = new BoundedLog(path, 12, 2);

  log.append("12345678");
  log.append("abcdefgh");

  expect(readFileSync(path, "utf8")).toBe("abcdefgh");
  expect(readFileSync(`${path}.1`, "utf8")).toBe("12345678");
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("wakeable app-server log uses a stable sanitized peer path", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-peers-log-"));
  tempDirs.push(dir);
  const log = createWakeableAppServerLog({
    cwd: "/repo",
    peerName: "My Peer!",
    env: { HOME: dir, AGENT_PEERS_CODEX_STATE_DIR: dir },
  });

  expect(log.path).toBe(join(dir, "logs", "my-peer-app-server.log"));
});
