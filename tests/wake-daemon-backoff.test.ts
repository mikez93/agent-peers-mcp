import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AppServerClient, AppServerThread } from "../shared/app-server-client.ts";
import { runWakePass } from "../shared/wake-daemon.ts";
import type { WakeRegistryEntry } from "../shared/wake-registry.ts";
import type { CodexInboxMetadataState } from "../shared/codex-inbox.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-wake-backoff-"));
  tempDirs.push(dir);
  return dir;
}

function entry(): WakeRegistryEntry {
  const now = "2026-06-18T00:00:00.000Z";
  return {
    peer_id: "peer-1",
    peer_name: "wake-peer",
    cwd: "/repo",
    git_root: "/repo",
    tty: "ttys001",
    thread_id: "thread-1",
    rollout_path: "/rollout.jsonl",
    app_server_url: "ws://127.0.0.1:41037",
    app_server_socket_path: null,
    app_server_pid: process.pid,
    tui_pid: null,
    mcp_pid: process.pid,
    broker_session_token_hash: "sha256:abc",
    status: "ready",
    capabilities: ["app-server-ws"],
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
}

async function writeMetadata(rootDir: string): Promise<void> {
  const value: CodexInboxMetadataState = {
    unread: [{
      id: 10,
      from_id: "sender",
      from_name: "sender-peer",
      from_peer_type: "claude",
      from_cwd: "/other",
      from_summary: "working elsewhere",
      to_id: "peer-1",
      sent_at: "2026-06-18T00:00:00.000Z",
    }],
    updated_at: "2026-06-18T00:00:00.000Z",
  };
  await writeFile(join(rootDir, `${encodeURIComponent("peer-1")}.metadata.json`), JSON.stringify(value, null, 2), "utf8");
}

class MockClient implements AppServerClient {
  startCalls = 0;
  fail = false;
  async listLoadedThreads(): Promise<string[]> { return ["thread-1"]; }
  async readThread(): Promise<AppServerThread> {
    return { id: "thread-1", cwd: "/repo", path: "/rollout.jsonl", status: { type: "idle" } };
  }
  async startWakeTurn(): Promise<{ turnId: string | null }> {
    this.startCalls += 1;
    if (this.fail) throw new Error("app-server refused the turn");
    return { turnId: "turn" };
  }
  close(): void {}
}

test("runWakePass retries a failed wake on the backoff schedule, then abandons at the cap", async () => {
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const client = new MockClient();
  let nowMs = Date.parse("2026-06-18T00:00:00.000Z");
  const opts = {
    rootDir,
    registry: { list: async () => [entry()] },
    appServerClientFactory: () => client,
    backoffScheduleMs: [1_000, 2_000], // => 3 total attempts (initial + 2 retries)
    now: () => new Date(nowMs),
  };
  client.fail = true;

  // Attempt 1 fires immediately.
  expect((await runWakePass(opts))[0]?.reason).toBe("wake_failed");

  // Same unread set, still inside the first backoff window -> no wake.
  nowMs += 500;
  expect((await runWakePass(opts))[0]?.reason).toBe("duplicate_or_cooldown");

  // First backoff (1s) elapsed -> attempt 2.
  nowMs += 600;
  expect((await runWakePass(opts))[0]?.reason).toBe("wake_failed");

  // Inside the second, longer backoff window (2s) -> no wake.
  nowMs += 1_000;
  expect((await runWakePass(opts))[0]?.reason).toBe("duplicate_or_cooldown");

  // Second backoff elapsed -> attempt 3 (the last one).
  nowMs += 1_500;
  expect((await runWakePass(opts))[0]?.reason).toBe("wake_failed");

  // Cap reached: even after a long wait the same set is abandoned, never
  // re-woken. The message is NOT lost — it still surfaces on the session's
  // next tool call; we just stop spending full-context turns on it.
  nowMs += 60_000;
  expect((await runWakePass(opts))[0]?.reason).toBe("max_attempts");
  nowMs += 60_000;
  expect((await runWakePass(opts))[0]?.reason).toBe("max_attempts");

  expect(client.startCalls).toBe(3);
});

test("runWakePass wakes a peer once per unread set; only a new message wakes it again", async () => {
  // Mike, 2026-11-04: wake only for a new inbox message. A turn that handled an
  // FYI and ended without another AP call must not be re-woken for an empty check.
  const rootDir = await makeDir();
  await writeMetadata(rootDir);
  const client = new MockClient();
  let nowMs = Date.parse("2026-06-18T00:00:00.000Z");
  const opts = { rootDir, registry: { list: async () => [entry()] }, appServerClientFactory: () => client, now: () => new Date(nowMs) };

  expect((await runWakePass(opts))[0]?.action).toBe("wake");
  for (const wait of [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]) {
    nowMs += wait + 1_000;
    expect((await runWakePass(opts))[0]?.reason).toBe("already_nudged");
  }
  expect(client.startCalls).toBe(1);

  const value = JSON.parse(await Bun.file(join(rootDir, `${encodeURIComponent("peer-1")}.metadata.json`)).text()) as CodexInboxMetadataState;
  value.unread.push({ ...value.unread[0]!, id: 11 });
  await writeFile(join(rootDir, `${encodeURIComponent("peer-1")}.metadata.json`), JSON.stringify(value), "utf8");
  expect((await runWakePass(opts))[0]?.action).toBe("wake");
  expect(client.startCalls).toBe(2);
});
