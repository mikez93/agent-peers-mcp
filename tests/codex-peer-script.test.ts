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

const scriptPath = new URL("../bin/codex-peer", import.meta.url).pathname;
const sessionId = "12345678-1234-4abc-8def-1234567890ab";

function runSessionCwd(codexHome: string, ...args: string[]) {
  return spawnSync("/bin/bash", [scriptPath, "session-cwd", ...args], {
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
}

function writeRollout(codexHome: string, id: string, content: string): string {
  const sessions = join(codexHome, "sessions", "2026", "08", "25");
  mkdirSync(sessions, { recursive: true });
  const rollout = join(sessions, `rollout-test-${id}.jsonl`);
  writeFileSync(rollout, content);
  return rollout;
}

test("session-cwd returns only the saved absolute cwd and honors CODEX_HOME", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-peer-session-cwd-"));
  const selectedHome = join(temporaryRoot, "selected");
  const decoyHome = join(temporaryRoot, "decoy");
  const savedCwd = "/Users/mike/www/ai/mike money";
  const sentinel = "token-like-sentinel-must-not-print";
  writeRollout(
    selectedHome,
    sessionId,
    JSON.stringify({
      type: "session_meta",
      payload: { cwd: savedCwd, authorization: sentinel },
    }) + "\n",
  );
  writeRollout(
    decoyHome,
    sessionId,
    JSON.stringify({ type: "session_meta", payload: { cwd: "/decoy" } }) + "\n",
  );

  try {
    const result = runSessionCwd(selectedHome, sessionId);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(savedCwd + "\n");
    expect(result.stderr).toBe("");
    expect(result.stdout + result.stderr).not.toContain(sentinel);
    expect(result.stdout).not.toContain("/decoy");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("session-cwd is read-only and rejects implicit selectors", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-peer-session-cwd-readonly-"));
  const codexHome = join(temporaryRoot, "codex-home");
  const fakeBin = join(temporaryRoot, "bin");
  const launchCapture = join(temporaryRoot, "launched");
  mkdirSync(fakeBin, { recursive: true });
  for (const command of ["codex", "bun"]) {
    const fake = join(fakeBin, command);
    writeFileSync(fake, `#!/bin/sh\ntouch "${launchCapture}"\nexit 99\n`);
    chmodSync(fake, 0o755);
  }
  writeRollout(
    codexHome,
    sessionId,
    JSON.stringify({ type: "session_meta", payload: { cwd: "/valid/path" } }) + "\n",
  );

  try {
    const success = spawnSync("/bin/bash", [scriptPath, "session-cwd", sessionId], {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        PATH: fakeBin + ":" + process.env.PATH,
      },
    });
    expect(success.status).toBe(0);
    expect(existsSync(launchCapture)).toBe(false);

    for (const args of [
      [],
      ["--last"],
      ["named-session"],
      ["not-a-uuid"],
      [sessionId, "extra"],
    ]) {
      const result = runSessionCwd(codexHome, ...args);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("session-cwd fails closed on missing or malformed rollout metadata", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "codex-peer-session-cwd-invalid-"));
  try {
    const missingHome = join(temporaryRoot, "missing");
    const missing = runSessionCwd(missingHome, sessionId);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toBe("");

    const invalidCases = [
      "{not-json}\n",
      JSON.stringify({ type: "other", payload: { cwd: "/ignored" } }) + "\n",
      JSON.stringify({ type: "session_meta", payload: { cwd: null } }) + "\n",
      JSON.stringify({ type: "session_meta", payload: { cwd: "" } }) + "\n",
      JSON.stringify({ type: "session_meta", payload: { cwd: 42 } }) + "\n",
      JSON.stringify({ type: "session_meta", payload: { cwd: "relative/path" } }) + "\n",
    ];
    for (const [index, content] of invalidCases.entries()) {
      const codexHome = join(temporaryRoot, `invalid-${index}`);
      writeRollout(codexHome, sessionId, content);
      const result = runSessionCwd(codexHome, sessionId);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("codex-peer:");
      expect(result.stderr).not.toContain(content.trim());
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
