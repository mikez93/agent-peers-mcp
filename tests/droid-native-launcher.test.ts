import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNativeDroidLauncher } from "../shared/droid-native-launcher.ts";
import { DroidLaunchClaimStore } from "../shared/droid-launch-claims.ts";
import { acquireDroidSession } from "../shared/droid-session-owner.ts";
import { parseDroidLauncherArgs } from "../shared/droid-launcher.ts";

test("native resume rejects explicit model settings rather than silently ignoring them", async () => {
  const opts = parseDroidLauncherArgs(["--resume", "saved", "--model", "explicit-model"]);
  expect(opts.settingsExplicit).toBe(true);
  await expect(runNativeDroidLauncher(opts, new AbortController().signal)).rejects.toThrow("retains saved model and reasoning settings");
});



test("native resume accepts an explicit autonomy override", () => {
  const opts = parseDroidLauncherArgs(["--resume", "saved", "--autonomy-level", "high"]);
  expect(opts.settingsExplicit).toBeUndefined();
  expect(opts.autonomyLevel).toBe("auto-high");
});

test("native resume reapplies managed High autonomy", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-resume-autonomy-"));
  const stateRoot = join(root, "state");
  const priorRoot = process.env.AGENT_PEERS_DROID_STATE_DIR;
  const priorExpected = process.env.DROID_NATIVE_EXPECT_AUTONOMY;
  process.env.AGENT_PEERS_DROID_STATE_DIR = stateRoot;
  process.env.DROID_NATIVE_EXPECT_AUTONOMY = "high";
  try {
    await new DroidLaunchClaimStore({ rootDir: stateRoot }).saveSession({
      session_id: "saved", cwd: root, requested_peer_name: "test-native",
    });
    const opts = parseDroidLauncherArgs(["--resume", "saved"]);
    opts.droidCommand = join(import.meta.dir, "fixtures/droid-native-agent.ts");
    opts.pollMs = 10;
    opts.claimTimeoutMs = 2000;
    expect(await runNativeDroidLauncher(opts, new AbortController().signal)).toBe(0);
  } finally {
    if (priorRoot === undefined) delete process.env.AGENT_PEERS_DROID_STATE_DIR; else process.env.AGENT_PEERS_DROID_STATE_DIR = priorRoot;
    if (priorExpected === undefined) delete process.env.DROID_NATIVE_EXPECT_AUTONOMY; else process.env.DROID_NATIVE_EXPECT_AUTONOMY = priorExpected;
    await rm(root, { recursive: true, force: true });
  }
});

test("native launcher binds canonical cwd and removes its claim and owned processes on normal exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-launcher-"));
  const prior = process.env.AGENT_PEERS_DROID_STATE_DIR;
  process.env.AGENT_PEERS_DROID_STATE_DIR = join(root, "state");
  try {
    expect(await runNativeDroidLauncher({ cwd: root, droidCommand: join(import.meta.dir, "fixtures/droid-native-agent.ts"),
      pollMs: 10, claimTimeoutMs: 2000 }, new AbortController().signal)).toBe(0);
    expect(await new DroidLaunchClaimStore({ rootDir: join(root, "state") }).listClaims()).toEqual([]);
    expect(await readdir(join(root, "state/session-owners"))).toEqual([]);
  } finally {
    if (prior === undefined) delete process.env.AGENT_PEERS_DROID_STATE_DIR; else process.env.AGENT_PEERS_DROID_STATE_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid daemon IPC retires the launcher and cleans its launch claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-invalid-"));
  const prior = process.env.AGENT_PEERS_DROID_STATE_DIR;
  process.env.AGENT_PEERS_DROID_STATE_DIR = join(root, "state");
  process.env.DROID_NATIVE_TEST_MODE = "malformed";
  try {
    await expect(runNativeDroidLauncher({ cwd: root, droidCommand: join(import.meta.dir, "fixtures/droid-native-agent.ts"),
      pollMs: 10, claimTimeoutMs: 2000 }, new AbortController().signal)).rejects.toThrow("invalid native IPC");
    expect(await new DroidLaunchClaimStore({ rootDir: join(root, "state") }).listClaims()).toEqual([]);
  } finally {
    delete process.env.DROID_NATIVE_TEST_MODE;
    if (prior === undefined) delete process.env.AGENT_PEERS_DROID_STATE_DIR; else process.env.AGENT_PEERS_DROID_STATE_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("resume rejects an older live ACP claim even before that host used session locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-owner-"));
  try {
    const claims = new DroidLaunchClaimStore({ rootDir: root });
    const claim = await claims.createClaim({ cwd: root, launcherPid: process.ppid });
    await claims.setSessionId(claim.claim_id, "already-live");
    await expect(acquireDroidSession(root, "already-live")).rejects.toThrow("live droidpeer owner");
    expect(await readdir(join(root, "session-owners"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an unfinalized legacy live claim blocks resume until its identity is known", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-starting-owner-"));
  try {
    const claims = new DroidLaunchClaimStore({ rootDir: root });
    await claims.createClaim({ cwd: root, launcherPid: process.ppid });
    await expect(acquireDroidSession(root, "resuming-session")).rejects.toThrow("still starting");
    expect(await readdir(join(root, "session-owners"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a recycled legacy launcher PID cannot block exact resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-recycled-owner-"));
  try {
    const claims = new DroidLaunchClaimStore({ rootDir: root });
    const claim = await claims.createClaim({ cwd: root, launcherPid: process.ppid });
    await writeFile(join(root, "claims", `${claim.claim_id}.json`), JSON.stringify({ ...claim,
      session_id: "resuming-session", created_at: "2000-01-01T00:00:00.000Z" }));
    const release = await acquireDroidSession(root, "resuming-session");
    await release();
    expect(await readdir(join(root, "session-owners"))).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
