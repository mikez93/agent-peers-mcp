#!/usr/bin/env bun
// Wake support for Mike's interactive `agy` (the normal Antigravity chat).
//
// Antigravity gives outside programs no way to start a turn in an open chat,
// but an idle chat wakes itself when a background task it started finishes
// (verified 2026-11-20). So each interactive session keeps `wait` running as a
// background task: it exits when new Agent Peers mail arrives, Antigravity
// wakes the agent, the agent reads its mail and starts `wait` again.
//
//   launch [agy args...]   what the `agy` shell function runs: claim, start agy
//                          with the claim id and an arming first prompt,
//                          release the claim when agy exits. Subcommands,
//                          -p/--print, --help and --version run native agy.
//   wait                   block until new mail, then print the wake note
//   setup                  register the user-level agent-peers MCP entry and
//                          the permission rules (idempotent; run by the fleet)
//   claim | release <id>   the launch-claim steps on their own (debugging)
//
// `launch` exports the claim id as AGENT_PEERS_LAUNCH_CLAIM_ID to agy; the
// agent-peers MCP server (agy-server.ts) and the background waiter inherit it,
// so the server binds its peer id to the claim and the waiter watches that
// peer's mailbox.

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DroidLaunchClaimStore } from "./shared/droid-launch-claims.ts";
import { FileDroidWakeMetadataSource } from "./shared/droid-launcher.ts";
import { atomicWriteJson } from "./shared/file-state.ts";
import { resolveStateDir } from "./shared/state-dir.ts";

export const CLAIM_ENV = "AGENT_PEERS_LAUNCH_CLAIM_ID";
const BIND_TIMEOUT_MS = 120_000;
const REPO_ROOT = dirname(import.meta.path);
export const WAIT_COMMAND = `bun ${join(REPO_ROOT, "agy-interactive.ts")} wait`;

export function agyStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateDir({ runtime: "antigravity", kind: "coordination", env });
}

// ---------- wait ----------

/** The last message id this claim's waiter already reported, so one unread
 * message can never wake the agent twice. */
export async function readNotified(stateRoot: string, claimId: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(notifiedPath(stateRoot, claimId), "utf8")) as { last_message_id?: unknown };
    return Number.isInteger(value.last_message_id) ? value.last_message_id as number : null;
  } catch {
    return null;
  }
}

function notifiedPath(stateRoot: string, claimId: string): string {
  return join(stateRoot, "notified", `${encodeURIComponent(claimId)}.json`);
}

export function wakeMessage(pending: number, rearmCommand: string = WAIT_COMMAND): string {
  return [
    `Agent Peers: ${pending} new message(s) waiting.`,
    "Call the agent-peers check_messages tool now and handle them.",
    `Then start the mail waiter again as a background task: ${rearmCommand}`,
  ].join("\n");
}

export interface WaitOptions {
  claimId: string;
  stateRoot: string;
  rearmCommand?: string;
  pollMs?: number;
  bindTimeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/** Resolves with the wake note when mail newer than the last report arrives,
 * or null when the session's claim is gone (agy exited). */
export async function waitForNewMail(opts: WaitOptions): Promise<string | null> {
  const claims = new DroidLaunchClaimStore({ rootDir: opts.stateRoot, runtime: "antigravity" });
  const binding = await claims.waitForBinding(opts.claimId, {
    timeoutMs: opts.bindTimeoutMs ?? BIND_TIMEOUT_MS,
    signal: opts.signal,
  });
  const source = new FileDroidWakeMetadataSource({ stateRoot: opts.stateRoot, peerId: binding.peer_id });
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  while (!opts.signal?.aborted) {
    if (!(await claims.readClaim(opts.claimId))) return null;
    const state = await source.read();
    const notified = await readNotified(opts.stateRoot, opts.claimId);
    if (state.lastMessageId !== null && (notified === null || state.lastMessageId > notified)) {
      await atomicWriteJson(notifiedPath(opts.stateRoot, opts.claimId), {
        last_message_id: state.lastMessageId,
        updated_at: new Date().toISOString(),
      });
      return wakeMessage(state.pendingCount, opts.rearmCommand);
    }
    await sleep(opts.pollMs ?? 1000);
  }
  return null;
}

// ---------- launch ----------

const AGY_SUBCOMMANDS = new Set([
  "acp", "agent", "agents", "changelog", "help", "install", "mcp", "mic-serve", "models", "plugin", "plugins",
]);
const NATIVE_FLAGS = new Set(["-p", "--print", "--prompt", "-h", "--help", "-v", "-V", "--version"]);
const VALUE_FLAGS = new Set([
  "--add-dir", "--agent", "--conversation", "--effort", "--input-format", "--json-schema", "--log-file",
  "--mode", "--model", "--output-format", "--print-timeout", "--project", "--settings",
]);
const PROMPT_FLAGS = new Set(["-i", "--prompt-interactive"]);

export type LaunchPlan =
  | { wakeable: false }
  | { wakeable: true; args: string[]; userPrompt?: string };

/** A plain interactive chat (optionally with -i, --continue, --model ...) is
 * made wakeable; anything else runs native agy unchanged. */
export function launchPlan(argv: string[]): LaunchPlan {
  const args: string[] = [];
  let userPrompt: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg] : [arg, undefined];
    if (NATIVE_FLAGS.has(name)) return { wakeable: false };
    if (PROMPT_FLAGS.has(name)) {
      const value = inline !== undefined ? inline.slice(inline.indexOf("=") + 1) : argv[++index];
      if (value === undefined) return { wakeable: false };
      userPrompt = value;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      args.push(arg);
      if (inline === undefined) {
        const value = argv[++index];
        if (value === undefined) return { wakeable: false };
        args.push(value);
      }
      continue;
    }
    if (!arg.startsWith("-")) return { wakeable: false }; // subcommand or unknown positional
    args.push(arg);
  }
  return { wakeable: true, args, userPrompt };
}

export function interactiveSessionId(claimId: string): string {
  return `agy-interactive:${claimId}`;
}

export function armPrompt(userPrompt?: string, waitCommand: string = WAIT_COMMAND): string {
  const first = `Start the Agent Peers mail waiter as a background task, without waiting for it in this turn: ${waitCommand}\nWhenever it finishes later, do what its output says.`;
  return userPrompt
    ? `${first}\n\nThen: ${userPrompt}`
    : `${first}\nThen end your turn with one short line: Agent Peers wake is on.`;
}

async function runAgy(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = Bun.spawn(["agy", ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  // The terminal delivers Ctrl-C to agy itself; this wrapper only waits.
  const ignore = () => {};
  const forward = (signal: NodeJS.Signals) => () => { try { child.kill(signal); } catch {} };
  process.on("SIGINT", ignore);
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGHUP", forward("SIGHUP"));
  return await child.exited;
}

async function launch(argv: string[]): Promise<number> {
  const plan = launchPlan(argv);
  if (!plan.wakeable) return runAgy(argv, process.env);
  const stateRoot = agyStateRoot();
  const claims = new DroidLaunchClaimStore({ rootDir: stateRoot, runtime: "antigravity" });
  const claim = await claims.createClaim({ cwd: realpathSync(process.cwd()), launcherPid: process.pid });
  // agypeer's startup check treats a live claim with no session id as another
  // launcher still starting, and refuses to run. Mark this one as an
  // interactive session so agypeer passes it by.
  const sessionId = interactiveSessionId(claim.claim_id);
  try {
    await claims.setSessionId(claim.claim_id, sessionId);
    return await runAgy([...plan.args, "-i", armPrompt(plan.userPrompt)], { ...process.env, [CLAIM_ENV]: claim.claim_id });
  } finally {
    await claims.removeClaim(claim.claim_id).catch(() => {});
    await claims.removeSession(sessionId).catch(() => {});
  }
}

// ---------- setup ----------

export function permissionRules(repoRoot: string = REPO_ROOT, stateRoot: string = agyStateRoot()): string[] {
  return [
    `command(${`bun ${join(repoRoot, "agy-interactive.ts")} wait`})`,
    "mcp(agent-peers/*)",
    // Lets the waiter run inside Antigravity's terminal sandbox, which otherwise
    // sees only the workspace and temp dirs (its first try failed there).
    `read_file(${repoRoot})`,
    `write_file(${stateRoot})`,
  ];
}

/** Adds any missing rules to permissions.allow, keeping everything else. */
export function mergePermissionRules(settings: Record<string, unknown>, rules: string[]): { settings: Record<string, unknown>; changed: boolean } {
  const permissions = (settings.permissions && typeof settings.permissions === "object" ? settings.permissions : {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((item): item is string => typeof item === "string") : [];
  const missing = rules.filter((rule) => !allow.includes(rule));
  if (missing.length === 0) return { settings, changed: false };
  return { settings: { ...settings, permissions: { ...permissions, allow: [...allow, ...missing] } }, changed: true };
}

async function setup(): Promise<number> {
  const stateRoot = agyStateRoot();
  const add = Bun.spawnSync(["agy", "mcp", "add",
    "--env", `AGENT_PEERS_STATE_DIR=${stateRoot}`,
    "--env", "AGENT_PEERS_AGY_USER_CONFIG=1",
    "agent-peers", process.execPath, join(REPO_ROOT, "agy-server.ts")], { stdout: "pipe", stderr: "pipe" });
  if (add.exitCode !== 0) {
    console.log(`agy setup: agy mcp add failed: ${add.stderr.toString().trim() || add.stdout.toString().trim()}`);
    return 1;
  }
  const settingsPath = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  let current: Record<string, unknown> = {};
  try {
    const text = await readFile(settingsPath, "utf8");
    if (text.trim()) current = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.log(`agy setup: cannot read ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  const merged = mergePermissionRules(current, permissionRules(REPO_ROOT, stateRoot));
  if (merged.changed) await Bun.write(settingsPath, `${JSON.stringify(merged.settings, null, 2)}\n`);
  console.log(`agy setup: agent-peers MCP entry current; permission rules ${merged.changed ? "added" : "already present"}`);
  return 0;
}

// ---------- entry ----------

async function main(argv: string[]): Promise<number> {
  const stateRoot = agyStateRoot();
  const claims = new DroidLaunchClaimStore({ rootDir: stateRoot, runtime: "antigravity" });
  switch (argv[0]) {
    case "launch":
      return launch(argv.slice(1));
    case "wait": {
      const claimId = process.env[CLAIM_ENV];
      if (!claimId) {
        console.log(`agy mail waiter: ${CLAIM_ENV} is not set; this agy session was not started by the agent-peers agy launcher, so it cannot be woken.`);
        return 2;
      }
      const message = await waitForNewMail({ claimId, stateRoot });
      if (message) console.log(message);
      return 0;
    }
    case "setup":
      return setup();
    case "claim": {
      const claim = await claims.createClaim({ cwd: realpathSync(process.cwd()), launcherPid: process.ppid });
      console.log(claim.claim_id);
      return 0;
    }
    case "release":
      if (!argv[1]) { console.log("usage: agy-interactive.ts release <claim-id>"); return 2; }
      await claims.removeClaim(argv[1]);
      return 0;
    default:
      console.log("usage: agy-interactive.ts launch [agy args...] | wait | setup | claim | release <claim-id>");
      return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
