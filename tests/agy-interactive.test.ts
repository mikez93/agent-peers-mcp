import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armPrompt, desiredMcpEntry, interactiveSessionId, launchPlan, mcpEntryCurrent, mergePermissionRules, permissionRules, readNotified, waitForNewMail, WAIT_COMMAND } from "../agy-interactive.ts";
import { acquireDroidSession } from "../shared/droid-session-owner.ts";
import { DroidLaunchClaimStore } from "../shared/droid-launch-claims.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test("launchPlan makes a plain interactive chat wakeable and leaves everything else native", () => {
  const mode = ["--model", "gemini-4-neon", "--effort", "high", "--mode", "auto"];
  expect(launchPlan([])).toEqual({ wakeable: true, args: mode, userPrompt: undefined });
  expect(launchPlan(["--model", "gemini-3.8-flash", "-c", "--mode", "plan"])).toEqual({
    wakeable: true, args: ["--model", "gemini-3.8-flash", "-c", "--mode", "plan", "--effort", "high"], userPrompt: undefined,
  });
  expect(launchPlan(["--settings={\"a\":1}", "--conversation", "abc"])).toEqual({
    wakeable: true, args: ["--settings={\"a\":1}", "--conversation", "abc", ...mode], userPrompt: undefined,
  });
  expect(launchPlan(["-i", "fix the tests"])).toEqual({ wakeable: true, args: mode, userPrompt: "fix the tests" });
  expect(launchPlan(["--prompt-interactive=hello there"])).toEqual({ wakeable: true, args: mode, userPrompt: "hello there" });
  expect(launchPlan(["--mode=accept-edits", "--effort", "xhigh"])).toEqual({
    wakeable: true, args: ["--mode=accept-edits", "--effort", "xhigh", "--model", "gemini-4-neon"], userPrompt: undefined,
  });
  for (const native of [["-p", "hi"], ["--print", "hi"], ["--prompt", "hi"], ["--help"], ["-h"], ["--version"],
    ["mcp", "list"], ["models"], ["acp"], ["plugin", "list"], ["some-positional"], ["--model"], ["-i"]]) {
    expect(launchPlan(native)).toEqual({ wakeable: false });
  }
});

test("armPrompt starts the waiter in the background and keeps the user's own prompt", () => {
  const plain = armPrompt();
  expect(plain).toContain(`background task, without waiting for it in this turn: ${WAIT_COMMAND}`);
  expect(plain).toContain("do what its output says");
  expect(plain).toContain("Agent Peers wake is on.");
  const withPrompt = armPrompt("review the diff");
  expect(withPrompt).toContain(WAIT_COMMAND);
  expect(withPrompt.endsWith("Then: review the diff")).toBe(true);
  expect(withPrompt).not.toContain("wake is on");
});

test("setup skips agy mcp add when the stored agent-peers entry already matches", () => {
  const desired = desiredMcpEntry("/bin/bun", "/repo", "/state");
  // The shape agy itself writes, including the user-owned disabled flag.
  const stored = {
    args: ["/repo/agy-server.ts"],
    command: "/bin/bun",
    disabled: true,
    env: { AGENT_PEERS_STATE_DIR: "/state", AGENT_PEERS_AGY_USER_CONFIG: "1" },
  };
  expect(mcpEntryCurrent(stored, desired)).toBe(true);
  expect(mcpEntryCurrent({ ...stored, command: "/other/bun" }, desired)).toBe(false);
  expect(mcpEntryCurrent({ ...stored, env: { AGENT_PEERS_STATE_DIR: "/state" } }, desired)).toBe(false);
  expect(mcpEntryCurrent({ ...stored, env: { ...stored.env, EXTRA: "1" } }, desired)).toBe(false);
  expect(mcpEntryCurrent(undefined, desired)).toBe(false);
});

test("mergePermissionRules adds missing rules once and keeps the user's settings", () => {
  const rules = permissionRules("/repo", "/state");
  expect(rules).toEqual(["command(bun /repo/agy-interactive.ts wait)", "mcp(agent-peers/*)", "read_file(/repo)", "write_file(/state)"]);
  const user = { model: "gemini-4-neon", statusLine: { type: "command" }, permissions: { allow: ["command(git)"], deny: ["command(sudo)"] } };
  const first = mergePermissionRules(user, rules);
  expect(first.changed).toBe(true);
  expect(first.settings).toEqual({
    model: "gemini-4-neon", statusLine: { type: "command" },
    permissions: { allow: ["command(git)", ...rules], deny: ["command(sudo)"] },
  });
  expect(mergePermissionRules(first.settings, rules)).toEqual({ settings: first.settings, changed: false });
  expect(mergePermissionRules({}, rules).settings).toEqual({ permissions: { allow: rules } });
});

async function boundClaim() {
  const root = await mkdtemp(join(tmpdir(), "agy-iw-"));
  roots.push(root);
  const claims = new DroidLaunchClaimStore({ rootDir: root, runtime: "antigravity" });
  const claim = await claims.createClaim({ cwd: "/repo" });
  await claims.bindClaim(claim.claim_id, { peerId: "peer-1", peerName: "orion-repo-antigravity", mcpPid: process.pid, cwd: "/repo" });
  const writeUnread = async (ids: number[]) => {
    const path = join(root, "peer-1.metadata.json");
    await writeFile(path, JSON.stringify({ unread: ids.map((id) => ({ id })) }));
    await chmod(path, 0o600);
  };
  return { root, claims, claimId: claim.claim_id, writeUnread };
}

test("waiter reports new mail once, stays quiet on the same message, and reports a newer one", async () => {
  const { root, claimId, writeUnread } = await boundClaim();
  await writeUnread([4, 5]);
  const first = await waitForNewMail({ claimId, stateRoot: root, pollMs: 1 });
  expect(first).toContain("Agent Peers: 2 new message(s) waiting.");
  expect(first).toContain("check_messages");
  expect(first).toContain(`Then start the mail waiter again as a background task: ${WAIT_COMMAND}`);
  expect(await readNotified(root, claimId)).toBe(5);

  // Same unread mail (the agent hasn't acknowledged it yet): no second wake.
  const abort = new AbortController();
  let polls = 0;
  const quiet = await waitForNewMail({ claimId, stateRoot: root, pollMs: 1, signal: abort.signal,
    sleep: async () => { if (++polls >= 5) abort.abort(); } });
  expect(quiet).toBeNull();
  expect(polls).toBe(5);

  // A newer message wakes again.
  let wrote = false;
  const second = await waitForNewMail({ claimId, stateRoot: root, pollMs: 1,
    sleep: async () => { if (!wrote) { wrote = true; await writeUnread([5, 7]); } } });
  expect(second).toContain("2 new message(s)");
  expect(await readNotified(root, claimId)).toBe(7);
});

test("waiter follows the claim when a broker re-registration gives the MCP child a new peer id", async () => {
  const { root, claims, claimId } = await boundClaim();
  let rebound = false;
  const result = await waitForNewMail({ claimId, stateRoot: root, pollMs: 1,
    sleep: async () => {
      if (rebound) return;
      rebound = true;
      await claims.bindClaim(claimId, { peerId: "peer-2", peerName: "orion-repo-antigravity", mcpPid: process.pid, cwd: "/repo" });
      const path = join(root, "peer-2.metadata.json");
      await writeFile(path, JSON.stringify({ unread: [{ id: 11 }] }));
      await chmod(path, 0o600);
    } });
  expect(result).toContain("1 new message(s)");
  expect(await readNotified(root, claimId)).toBe(11);
});

test("waiter stays quiet with an empty mailbox and exits quietly once agy's claim is released", async () => {
  const { root, claims, claimId } = await boundClaim();
  let polls = 0;
  const result = await waitForNewMail({ claimId, stateRoot: root, pollMs: 1,
    sleep: async () => { if (++polls === 3) await claims.removeClaim(claimId); } });
  expect(result).toBeNull();
  expect(polls).toBe(3);
});

test("a live interactive agy claim doesn't stop agypeer from starting", async () => {
  const root = await mkdtemp(join(tmpdir(), "agy-owner-"));
  roots.push(root);
  const claims = new DroidLaunchClaimStore({ rootDir: root, runtime: "antigravity" });
  // A live launcher other than this process (the test runner's parent).
  const claim = await claims.createClaim({ cwd: "/repo", launcherPid: process.ppid });
  await expect(acquireDroidSession(root, "agy-session-1")).rejects.toThrow("still starting");
  await claims.setSessionId(claim.claim_id, interactiveSessionId(claim.claim_id));
  const release = await acquireDroidSession(root, "agy-session-1");
  await release();
});

test("the fleet's user-level agy entry offers no tools and stays off the network without a launch claim", async () => {
  const env: Record<string, string> = { ...process.env as Record<string, string>, AGENT_PEERS_AGY_USER_CONFIG: "1",
    AGENT_PEERS_PORT: "1", AGENT_PEERS_FEDERATION: "" };
  delete env.AGENT_PEERS_LAUNCH_CLAIM_ID;
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "agy-server.ts")], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const send = (message: unknown) => { proc.stdin.write(`${JSON.stringify(message)}\n`); };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const reader = proc.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 10_000;
  while (!text.includes("\"id\":2") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  proc.kill();
  const listed = text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === 2);
  expect(listed?.result?.tools).toEqual([]);
});
