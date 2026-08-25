import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("normal codex-peer startup status is gated behind verbose mode", () => {
  const script = readFileSync(new URL("../bin/codex-peer", import.meta.url), "utf8");
  expect(script).toContain("CODEX_PEER_VERBOSE:-0");
  expect(script).not.toMatch(/printf 'codex-peer: (starting|resuming|network peer name|started background)/);
});

test("background wake daemon starts without any brain-router role token", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-peer-daemon-env-"));
  const fakeRoot = join(temporaryRoot, "agent-peers-mcp");
  const stateDirectory = join(temporaryRoot, "state");
  const capturePath = join(temporaryRoot, "daemon-environment.txt");
  const fakeLauncher = join(fakeRoot, "bin", "codex-peer");
  mkdirSync(join(fakeRoot, "bin"), { recursive: true });
  writeFileSync(
    fakeLauncher,
    `#!/usr/bin/env bash
env | awk -F= '/^BRAIN_ROUTER_TOKEN_/ { print $1 }' > "$DAEMON_ENV_CAPTURE"
sleep 30
`,
  );
  chmodSync(fakeLauncher, 0o755);

  let daemonPid: number | undefined;
  try {
    const result = spawnSync(
      "/bin/bash",
      [new URL("../bin/codex-peer", import.meta.url).pathname, "ensure-daemon"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_PEERS_MCP_DIR: fakeRoot,
          AGENT_PEERS_CODEX_STATE_DIR: stateDirectory,
          DAEMON_ENV_CAPTURE: capturePath,
          BRAIN_ROUTER_TOKEN_VECTOR: "vector-test-secret",
          BRAIN_ROUTER_TOKEN_FUTURE_ROLE: "future-test-secret",
        },
      },
    );
    expect(result.status).toBe(0);

    for (let attempt = 0; attempt < 40 && !existsSync(capturePath); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(existsSync(capturePath)).toBe(true);
    expect(readFileSync(capturePath, "utf8")).toBe("");

    const pidPath = join(stateDirectory, "wake-daemon.pid");
    daemonPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
  } finally {
    if (daemonPid && Number.isFinite(daemonPid)) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // The fake daemon may have already exited after a failed assertion.
      }
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
