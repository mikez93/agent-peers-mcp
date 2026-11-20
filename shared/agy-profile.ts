// Antigravity (`agy acp`) values for the shared ACP host and launcher.
//
// Everything protocol-shaped lives in droid-acp-client.ts and droid-launcher.ts;
// this file only says what is different about Antigravity. Payload shapes
// below were captured from agy 1.5.13 (ACP server 1.5.13) on 2026-11-20.

import { fileURLToPath } from "node:url";
import type { AcpHostProfile } from "./droid-acp-client.ts";
import {
  DroidLauncherUsageError,
  canonicalCwd,
  type AcpLauncherProfile,
  type DroidLauncherClient,
  type DroidLauncherOptions,
} from "./droid-launcher.ts";
import { isValidName, NAME_MAX_LEN } from "./names.ts";

/** `session/new` configOptions: model ids are base names, effort is separate. */
export const AGY_DEFAULT_MODEL = "gemini-4-neon";
export const AGY_DEFAULT_THINKING = "high";
/** Mike's default (2026-11-20): edits and the commands Antigravity classifies
 * as safe run without asking; anything it still asks about is refused when no
 * one is there to answer. */
export const AGY_DEFAULT_MODE = "auto";
export const AGY_MODES = ["default", "accept-edits", "auto", "plan"] as const;

const AGENT_PEERS_TOOLS = [
  "list_peers",
  "send_message",
  "set_summary",
  "check_messages",
  "wait_for_peer_messages",
  "rename_peer",
];

/** Antigravity names MCP tools `mcp_<server>_<tool>`; the launcher always
 * registers the server as `agent-peers`. Observed request:
 * toolCall { name: "mcp_agent-peers_check_messages",
 *            title: "Run mcp_agent-peers_check_messages", kind: "other" },
 * options [{ optionId: "allow", kind: "allow_once" },
 *          { optionId: "deny",  kind: "reject_once" }]. */
const AGY_AGENT_PEERS_TOOL_NAMES = new Set(AGENT_PEERS_TOOLS.map((tool) => `mcp_agent-peers_${tool}`));

/** The five shared GBrains every fleet harness uses (the fleet overlay adds
 * them to agy's mcp_config.json). agy asks the ACP host before every MCP call
 * even when settings.json allows the server, so the host approves them, as
 * Codex does with default_tools_approval_mode = "approve" (Mike, 2026-11-20). */
const AGY_GBRAIN_SERVERS = new Set(["portfolio", "imekka", "valentina", "ccr", "human-design"].map((brain) => `gbrain-${brain}`));
const AGY_GBRAIN_TOOL = /^mcp_gbrain-(portfolio|imekka|valentina|ccr|human-design)_[A-Za-z0-9_]+$/;

function isAllowedAgyTool(name: string): boolean {
  return AGY_AGENT_PEERS_TOOL_NAMES.has(name) || AGY_GBRAIN_TOOL.test(name);
}

/** Large MCP servers reach the host through agy's generic proxy tool. Observed
 * with GBrain (agy 1.5.13): toolCall { name: "call_mcp_tool", title: "MCP Tool
 * whoami", kind: "execute", rawInput: { ServerName: "gbrain-portfolio",
 * ToolName: "whoami", Arguments: {} } }. The server decides. */
function isAllowedAgyProxyCall(rawInput: unknown): boolean {
  if (!rawInput || typeof rawInput !== "object") return false;
  const { ServerName: server, ToolName: tool } = rawInput as { ServerName?: unknown; ToolName?: unknown };
  if (typeof server !== "string" || typeof tool !== "string" || !/^[A-Za-z0-9_]+$/.test(tool)) return false;
  return AGY_GBRAIN_SERVERS.has(server)
    || (server === "agent-peers" && AGY_AGENT_PEERS_TOOL_NAMES.has(`mcp_agent-peers_${tool}`));
}

/** Allow the Agent Peers tools and the shared GBrain tools, once. Everything
 * else is refused: the headless host has nobody to ask. The tool `name` decides
 * when present; `title` is consulted only when `name` is absent. */
export function allowedAgyPermissionOption(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = params as {
    toolCall?: { name?: unknown; title?: unknown; rawInput?: unknown };
    options?: Array<{ optionId?: unknown; kind?: unknown }>;
  };
  const name = value.toolCall?.name;
  const title = value.toolCall?.title;
  let recognized = false;
  if (name === "call_mcp_tool") {
    recognized = isAllowedAgyProxyCall(value.toolCall?.rawInput);
  } else if (typeof name === "string") {
    recognized = isAllowedAgyTool(name);
  } else if (typeof title === "string") {
    const bare = title.startsWith("Run ") ? title.slice(4) : title;
    recognized = isAllowedAgyTool(bare);
  }
  if (!recognized) return null;
  const allowOnce = value.options?.find((option) =>
    option.kind === "allow_once" && typeof option.optionId === "string" && option.optionId.length > 0
  );
  return typeof allowOnce?.optionId === "string" ? allowOnce.optionId : null;
}

/** Refuse one call with Antigravity's own reject_once option, so the agent is
 * told "no" and carries on (and can still reply to the sender). Answering
 * `cancelled` instead makes agy cancel the whole turn (observed 2026-11-20:
 * CancelCascadeInvocation after a refused `touch`). Never picks reject_always,
 * which would save a lasting rule. No reject_once option: null, so cancelled. */
export function rejectAgyPermissionOption(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const options = (params as { options?: Array<{ optionId?: unknown; kind?: unknown }> }).options;
  const rejectOnce = options?.find((option) =>
    option.kind === "reject_once" && typeof option.optionId === "string" && option.optionId.length > 0
  );
  return typeof rejectOnce?.optionId === "string" ? rejectOnce.optionId : null;
}

export const AGY_ACP_PROFILE: AcpHostProfile = {
  displayName: "Antigravity",
  clientInfo: { name: "agent-peers-antigravity", title: "Agent Peers Antigravity", version: "0.1.0" },
  command: "agy",
  args: ["acp"],
  permissionOption: allowedAgyPermissionOption,
  rejectOption: rejectAgyPermissionOption,
};

export async function configureAgySession(
  client: Pick<DroidLauncherClient, "setConfigOption" | "setMode">,
  sessionId: string,
  opts: Pick<DroidLauncherOptions, "model" | "thinkingLevel" | "mode" | "sessionId" | "settingsExplicit">,
): Promise<void> {
  // A resumed session keeps its own model unless the caller chose one; a new
  // session gets the defaults. The mode is always set: headless needs it.
  const applyModel = !opts.sessionId || opts.settingsExplicit;
  if (applyModel) {
    await client.setConfigOption(sessionId, "model", opts.model || AGY_DEFAULT_MODEL);
    await client.setConfigOption(sessionId, "thought_level", opts.thinkingLevel || AGY_DEFAULT_THINKING);
  }
  const mode = opts.mode || AGY_DEFAULT_MODE;
  if (client.setMode) await client.setMode(sessionId, mode);
  else await client.setConfigOption(sessionId, "mode", mode);
}

/** SSH session markers that make agy skip the OS credential store. */
export const AGY_SSH_MARKERS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;

/**
 * The environment to start agy with. agy 1.5.13 doesn't try the OS credential
 * store when it sees SSH variables, so on omarchy an agy started from an SSH
 * shell looked signed out while gnome-keyring on the same machine held a valid
 * sign-in; without them it reads it (2026-11-20). Nothing is copied: the
 * keyring still decides access, and macOS still refuses an SSH session its
 * login keychain, so this changes nothing there.
 */
export function agyEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const name of AGY_SSH_MARKERS) delete clean[name];
  return clean;
}

export class AgySignedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgySignedOutError";
  }
}

/** `agy models` exits 1 with "Please sign in to view available models" when
 * this machine has no Antigravity login (observed on the Studio, agy 1.5.12). */
export async function checkAgySignedIn(
  agyCommand = "agy",
  run: (cmd: string[]) => Promise<{ code: number; output: string }> = runForOutput,
): Promise<void> {
  let result: { code: number; output: string };
  try {
    result = await run([agyCommand, "models"]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT|not found/i.test(String(error))) {
      throw new AgySignedOutError(`agy was not found (${agyCommand}); install Antigravity CLI or pass --agy PATH`);
    }
    throw error;
  }
  if (result.code === 0) return;
  if (/sign in/i.test(result.output)) {
    throw new AgySignedOutError("agy can't read its Google sign-in from this session. On a Mac, an SSH session or a sandboxed shell can't open the login keychain, so agy looks signed out even when it isn't; start agypeer from a terminal in the desktop session (an Orca terminal works). If agy is signed out there too, run `agy` once to sign in.");
  }
  const line = result.output.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? `exit ${result.code}`;
  throw new Error(`agy models failed before launch: ${line}`);
}

async function runForOutput(cmd: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: agyEnv() });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, output: `${stdout}\n${stderr}` };
  } finally {
    clearTimeout(timer);
  }
}

export const AGY_LAUNCHER_PROFILE: AcpLauncherProfile = {
  runtime: "antigravity",
  harness: "antigravity",
  host: AGY_ACP_PROFILE,
  executable: (opts) => opts.agyCommand,
  claimEnvName: "AGENT_PEERS_LAUNCH_CLAIM_ID",
  stateEnvName: "AGENT_PEERS_ANTIGRAVITY_STATE_DIR",
  serverPath: fileURLToPath(new URL("../agy-server.ts", import.meta.url)),
  configureSession: configureAgySession,
  preflight: (opts) => checkAgySignedIn(opts.agyCommand ?? "agy"),
  shareMcpEnvWithHost: true,
  hostEnvOmit: AGY_SSH_MARKERS,
};

/** `agypeer [start [name] [cwd]] | agypeer resume <session-id> [name] [cwd]`. */
export function parseAgyLauncherArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): DroidLauncherOptions {
  const args = [...argv];
  const opts: DroidLauncherOptions = {
    headless: true,
    cwd: process.cwd(),
    cwdExplicit: false,
    model: env.AGY_PEER_MODEL || undefined,
    thinkingLevel: env.AGY_PEER_THINKING || undefined,
    mode: env.AGY_PEER_MODE || AGY_DEFAULT_MODE,
    pollMs: 1_000,
    claimTimeoutMs: 15_000,
  };
  const command = args[0];
  if (command === undefined || command.startsWith("-") || command === "start") {
    if (command === "start") args.shift();
    if (args[0] && !args[0].startsWith("-")) opts.peerName = args.shift();
    if (args[0] && !args[0].startsWith("-")) { opts.cwd = args.shift()!; opts.cwdExplicit = true; }
  } else if (command === "resume") {
    args.shift();
    if (!args[0] || args[0].startsWith("-")) throw new DroidLauncherUsageError("resume requires an Antigravity session id");
    opts.sessionId = args.shift();
    if (args[0] && !args[0].startsWith("-")) opts.peerName = args.shift();
    if (args[0] && !args[0].startsWith("-")) { opts.cwd = args.shift()!; opts.cwdExplicit = true; }
  } else {
    throw new DroidLauncherUsageError("expected start or resume");
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--cwd" || arg === "-C") { opts.cwd = requireValue(args, ++i, arg); opts.cwdExplicit = true; }
    else if (arg === "--name") opts.peerName = requireValue(args, ++i, arg);
    else if (arg === "--agy") opts.agyCommand = requireValue(args, ++i, arg);
    else if (arg === "--model") { opts.model = requireValue(args, ++i, arg); opts.settingsExplicit = true; }
    else if (arg === "--thinking") { opts.thinkingLevel = requireValue(args, ++i, arg); opts.settingsExplicit = true; }
    else if (arg === "--mode") opts.mode = requireValue(args, ++i, arg);
    else if (arg === "--poll-ms") opts.pollMs = positiveInt(requireValue(args, ++i, arg), arg);
    else if (arg === "--claim-timeout-ms") opts.claimTimeoutMs = positiveInt(requireValue(args, ++i, arg), arg);
    else throw new DroidLauncherUsageError(`unknown option: ${arg}`);
  }
  opts.cwd = canonicalCwd(opts.cwd);
  if (opts.peerName && !isValidName(opts.peerName)) {
    throw new DroidLauncherUsageError(`peer name must be 1-${NAME_MAX_LEN} letters, digits, underscores or hyphens, and cannot be a UUID`);
  }
  if (!(AGY_MODES as readonly string[]).includes(opts.mode!)) {
    throw new DroidLauncherUsageError(`--mode must be one of ${AGY_MODES.join("|")}`);
  }
  return opts;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new DroidLauncherUsageError(`${flag} requires a value`);
  return value;
}

function positiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new DroidLauncherUsageError(`${flag} must be a positive integer`);
  return Number(raw);
}
