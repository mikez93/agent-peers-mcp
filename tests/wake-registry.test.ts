import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";

import {
  WakeRegistry,
  hashBrokerSessionToken,
  type WakeRegistryEntry,
} from "../shared/wake-registry.ts";

const IS_POSIX = platform() !== "win32";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-wake-registry-"));
  tempDirs.push(dir);
  return dir;
}

function entry(overrides: Partial<WakeRegistryEntry> = {}): WakeRegistryEntry {
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
    ...overrides,
  };
}

test("WakeRegistry persists and reloads entries", async () => {
  const rootDir = await makeDir();
  const first = new WakeRegistry({ rootDir });
  await first.init();
  await first.upsert(entry());

  const second = new WakeRegistry({ rootDir });
  await second.init();
  const entries = await second.list();

  expect(entries).toHaveLength(1);
  expect(entries[0]?.peer_id).toBe("peer-1");
  expect(entries[0]?.capabilities).toEqual(["app-server-ws"]);
});

test("WakeRegistry upsert de-duplicates by peer id and thread id", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();

  await registry.upsert(entry({ peer_id: "peer-1", thread_id: "thread-1", peer_name: "old" }));
  await registry.upsert(entry({ peer_id: "peer-1", thread_id: "thread-2", peer_name: "new-peer" }));
  await registry.upsert(entry({ peer_id: "peer-2", thread_id: "thread-2", peer_name: "new-thread" }));

  const entries = await registry.list({ includeStale: true });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.peer_id).toBe("peer-2");
  expect(entries[0]?.thread_id).toBe("thread-2");
});

test("WakeRegistry filters entries with stale pids", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();

  await registry.upsert(entry({ app_server_pid: 99999999 }));

  expect(await registry.list()).toEqual([]);
  const all = await registry.list({ includeStale: true });
  expect(all).toHaveLength(1);
  expect(all[0]?.status).toBe("stale");
});

test("WakeRegistry filters entries with stale socket paths", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();

  await registry.upsert(entry({ app_server_socket_path: join(rootDir, "missing.sock") }));

  expect(await registry.list()).toEqual([]);
  const all = await registry.list({ includeStale: true });
  expect(all).toHaveLength(1);
  expect(all[0]?.status).toBe("stale");
});

test.if(IS_POSIX)("WakeRegistry writes registry file at 0o600 and directory at 0o700", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();
  await registry.upsert(entry());

  const filePath = join(rootDir, "wake-registry.json");
  const fileStat = await stat(filePath);
  expect(fileStat.mode & 0o777).toBe(0o600);

  const dirStat = await stat(rootDir);
  expect(dirStat.mode & 0o777).toBe(0o700);
});

test.if(IS_POSIX)("WakeRegistry refuses to load registry file with too-wide perms", async () => {
  const rootDir = await makeDir();
  const filePath = join(rootDir, "wake-registry.json");
  await writeFile(filePath, JSON.stringify({ entries: [entry()] }), "utf8");
  await chmod(filePath, 0o644);

  const registry = new WakeRegistry({ rootDir });
  await registry.init();
  expect(await registry.list({ includeStale: true })).toEqual([]);
});

test("WakeRegistry.prune removes dead entries past the grace window, keeps live and recently-dead ones", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  await registry.init();
  const t0 = Date.parse("2026-06-18T00:00:00.000Z");

  // Dead (bogus pid) and last seen 60m before "now" -> past the 30m grace.
  await registry.upsert(entry({
    peer_id: "dead-old", thread_id: "t-dead-old",
    app_server_pid: 99999999, last_seen_at: new Date(t0).toISOString(),
  }));
  // Dead but last seen only 20m before "now" -> still inside the grace window.
  await registry.upsert(entry({
    peer_id: "dead-recent", thread_id: "t-dead-recent",
    app_server_pid: 99999999, last_seen_at: new Date(t0 + 40 * 60_000).toISOString(),
  }));
  // Live -> never pruned regardless of age.
  await registry.upsert(entry({
    peer_id: "live", thread_id: "t-live",
    app_server_pid: process.pid, last_seen_at: new Date(t0).toISOString(),
  }));

  const removed = await registry.prune({ deadGraceMs: 30 * 60_000, now: () => new Date(t0 + 60 * 60_000) });
  expect(removed).toBe(1);

  const ids = (await registry.list({ includeStale: true })).map((e) => e.peer_id).sort();
  expect(ids).toEqual(["dead-recent", "live"]);
});

test("hashBrokerSessionToken stores only a stable digest", () => {
  const raw = "super-secret-session-token";
  const hashed = hashBrokerSessionToken(raw);

  expect(hashed).toStartWith("sha256:");
  expect(hashed).not.toContain(raw);
  expect(hashed).toBe(hashBrokerSessionToken(raw));
});

test("separate initialized instances reload before every mutation and read", async () => {
  const rootDir = await makeDir();
  const first = new WakeRegistry({ rootDir });
  const second = new WakeRegistry({ rootDir });
  await Promise.all([first.init(), second.init()]);
  await first.upsert(entry());
  expect((await second.list()).map((row) => row.peer_id)).toEqual(["peer-1"]);
  await second.upsert(entry({ peer_id: "peer-2", thread_id: "thread-2" }));
  expect(await first.getByPeerId("peer-2")).not.toBeNull();

  const at = "2026-10-16T00:00:00.000Z";
  await first.markSeen("peer-1", at);
  expect((await second.getByPeerId("peer-1"))?.last_seen_at).toBe(at);
  expect(await first.getByPeerId("peer-2")).not.toBeNull();

  await second.upsert(entry({ peer_id: "dead", thread_id: "dead", app_server_pid: 99999999 }));
  expect(await first.prune({ deadGraceMs: 0, now: () => new Date(at) })).toBe(1);
  expect((await second.list()).map((row) => row.peer_id).sort()).toEqual(["peer-1", "peer-2"]);

  await first.upsert(entry({ peer_id: "peer-3", thread_id: "thread-3" }));
  await second.removeByPeerId("peer-1");
  expect((await first.list()).map((row) => row.peer_id).sort()).toEqual(["peer-2", "peer-3"]);
  await first.removeByPeerId("peer-2");
  expect(await second.getByPeerId("peer-2")).toBeNull();
});

test("separate instances serialize the entire read-modify-persist interval", async () => {
  const rootDir = await makeDir();
  let entered!: () => void;
  let resume!: () => void;
  const persisting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const first = new WakeRegistry({ rootDir, persistState: async (path, state) => {
    entered();
    await gate;
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  } });
  const second = new WakeRegistry({ rootDir });
  await Promise.all([first.init(), second.init()]);
  const write = first.upsert(entry());
  await persisting;
  const otherWrite = second.upsert(entry({ peer_id: "other", thread_id: "other" }));
  try {
    await Bun.sleep(40);
    expect(await readdir(rootDir)).toContain("wake-registry.json.lock");
  } finally {
    resume();
    await Promise.all([write, otherWrite]);
  }
  expect((await first.list()).map((row) => row.peer_id).sort()).toEqual(["other", "peer-1"]);
});

for (const mutation of ["upsert", "remove", "prune", "markSeen"] as const) {
  test(`failed ${mutation} preserves committed rows and releases the lock`, async () => {
    const rootDir = await makeDir();
    const reader = new WakeRegistry({ rootDir });
    await reader.upsert(entry({ app_server_pid: 99999999 }));
    const before = await readFile(join(rootDir, "wake-registry.json"), "utf8");
    const failing = new WakeRegistry({ rootDir, persistState: async () => { throw new Error("disk failure"); } });
    await failing.init();
    await reader.upsert(entry({ peer_id: "other", thread_id: "other" }));
    const committed = await readFile(join(rootDir, "wake-registry.json"), "utf8");
    expect(committed).not.toBe(before);
    const operation = mutation === "upsert" ? failing.upsert(entry({ peer_id: "failed", thread_id: "failed" }))
      : mutation === "remove" ? failing.removeByPeerId("peer-1")
      : mutation === "prune" ? failing.prune({ deadGraceMs: 0, now: () => new Date("2026-10-16") })
      : failing.markSeen("peer-1");
    await expect(operation).rejects.toThrow("disk failure");
    expect(await readFile(join(rootDir, "wake-registry.json"), "utf8")).toBe(committed);
    expect(await failing.list({ includeStale: true })).toHaveLength(2);
    await reader.markSeen("other");
    expect(await readdir(rootDir)).toEqual(["wake-registry.json"]);
  });
}

test("atomic replacement uses unique temporary files and cleans up on rename failure", async () => {
  const rootDir = await makeDir();
  const registry = new WakeRegistry({ rootDir });
  const filePath = join(rootDir, "wake-registry.json");
  // A legacy fixed-name temp must never be overwritten or consumed.
  await writeFile(`${filePath}.tmp`, "sentinel");
  await registry.upsert(entry());
  expect(await readFile(`${filePath}.tmp`, "utf8")).toBe("sentinel");
  await rm(filePath);
  await mkdir(filePath);
  await expect(registry.upsert(entry())).rejects.toThrow();
  expect((await readdir(rootDir)).sort()).toEqual(["wake-registry.json", "wake-registry.json.tmp"]);
  await rm(filePath, { recursive: true });
  await registry.upsert(entry());
  expect(await registry.list()).toHaveLength(1);
});

test("live and malformed owner locks time out without being stolen, then allow retry", async () => {
  const rootDir = await makeDir();
  const lockPath = join(rootDir, "wake-registry.json.lock");
  const registry = new WakeRegistry({ rootDir });
  for (const contents of [JSON.stringify({ owner_pid: process.pid }), "partial"]) {
    await writeFile(lockPath, contents, { mode: 0o600 });
    const start = performance.now();
    await expect(registry.upsert(entry())).rejects.toThrow("lock timed out");
    expect(performance.now() - start).toBeLessThan(3_500);
    expect(await readFile(lockPath, "utf8")).toBe(contents);
  }
  await rm(lockPath);
  await registry.upsert(entry());
  expect(await registry.list()).toHaveLength(1);
}, 10_000);

test("real processes concurrently reclaim a dead owner and preserve all writers' rows", async () => {
  const rootDir = await makeDir();
  // Obtain a genuinely exited PID rather than assuming a particular PID is dead.
  const dead = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "pipe" });
  expect(await dead.exited).toBe(0);
  await writeFile(join(rootDir, "wake-registry.json.lock"), JSON.stringify({ owner_pid: dead.pid }), { mode: 0o600 });
  const moduleUrl = new URL("../shared/wake-registry.ts", import.meta.url).href;
  const workers = Array.from({ length: 6 }, (_, worker) => {
    const source = `
      import { WakeRegistry } from ${JSON.stringify(moduleUrl)};
      const registry = new WakeRegistry({ rootDir: ${JSON.stringify(rootDir)} });
      console.log("ready");
      await Bun.stdin.text();
      await registry.init();
      const base = ${JSON.stringify(entry())};
      for (let i = 0; i < 12; i++) {
        const id = ${JSON.stringify(`worker-${worker}-`)} + i;
        await registry.upsert({ ...base, peer_id: id, thread_id: id });
        await registry.markSeen(id, "2026-10-16T00:00:00.000Z");
        const temporary = id + "-temporary";
        await registry.upsert({ ...base, peer_id: temporary, thread_id: temporary });
        await registry.removeByPeerId(temporary);
        await registry.prune({ deadGraceMs: 0 });
      }
    `;
    return Bun.spawn([process.execPath, "--eval", source], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  });
  try {
    await Promise.all(workers.map(async (worker) => {
      const ready = await worker.stdout.getReader().read();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");
    }));
    for (const worker of workers) worker.stdin.end();
    const results = await Promise.all(workers.map(async (worker) => ({
      code: await worker.exited, error: await new Response(worker.stderr).text(),
    })));
    expect(results).toEqual(workers.map(() => ({ code: 0, error: "" })));
    const registry = new WakeRegistry({ rootDir });
    const rows = await registry.list();
    expect(rows.map((row) => row.peer_id).sort()).toEqual(
      Array.from({ length: 6 }, (_, worker) => Array.from({ length: 12 }, (_, i) => `worker-${worker}-${i}`)).flat().sort(),
    );
    expect(rows.every((row) => row.last_seen_at === "2026-10-16T00:00:00.000Z")).toBe(true);
    expect(await readdir(rootDir)).toEqual(["wake-registry.json"]);
  } finally {
    for (const worker of workers) if (worker.exitCode === null) worker.kill();
    await Promise.all(workers.map((worker) => worker.exited));
  }
}, 20_000);
