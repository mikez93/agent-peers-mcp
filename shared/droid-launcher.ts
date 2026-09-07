// Managed ACP launcher and bodyless wake controller for Factory Droid peers.

import { lstat, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DroidAcpClient,
  spawnDroidAcpTransport,
  type AcpInitializeResult,
  type AcpMcpServer,
} from "./droid-acp-client.ts";
import {
  DroidLaunchClaimStore,
  type BoundDroidLaunchClaim,
} from "./droid-launch-claims.ts";

const IS_POSIX = platform() !== "win32";
const FILE_MODE = 0o600;

export interface DroidLauncherOptions {
  cwd: string;
  /** False only when the CLI supplied no cwd for a resume operation. */
  cwdExplicit?: boolean;
  peerName?: string;
  sessionId?: string;
  droidCommand?: string;
  model?: string;
  reasoningEffort?: string;
  autonomyLevel?: string;
  pollMs: number;
  claimTimeoutMs: number;
}

export class DroidLauncherUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DroidLauncherUsageError";
  }
}

export interface BodylessWakeState {
  pendingCount: number;
  lastMessageId: number | null;
}

export interface DroidWakeMetadataSource {
  read(): Promise<BodylessWakeState>;
}

export interface WakePromptClient {
  readonly isBusy: boolean;
  prompt(sessionId: string, text: string): Promise<unknown>;
}

export interface WakePollResult {
  action: "empty" | "unchanged" | "queued" | "wake";
  marker: string | null;
}

const DEFAULT_WAKE_RETRY_SCHEDULE_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export const DROID_WAKE_PROMPT = `[agent-peers wake]\nPending peer mail is available. Call the agent-peers check_messages tool exactly once; that tool is the only authoritative source of message content. Handle the returned messages normally, then become idle again.`;

export function parseDroidLauncherArgs(argv: string[]): DroidLauncherOptions {
  const args = [...argv];
  const opts: DroidLauncherOptions = {
    cwd: process.cwd(),
    model: process.env.DROID_PEER_MODEL,
    reasoningEffort: process.env.DROID_PEER_REASONING_EFFORT,
    autonomyLevel: process.env.DROID_PEER_AUTONOMY_LEVEL,
    pollMs: 1_000,
    claimTimeoutMs: 15_000,
    cwdExplicit: false,
  };
  const command = args[0];
  if (command === "start") {
    args.shift();
    if (args[0] && !args[0].startsWith("-")) opts.peerName = args.shift();
    if (args[0] && !args[0].startsWith("-")) {
      opts.cwd = args.shift()!;
      opts.cwdExplicit = true;
    }
  } else if (command === "resume") {
    args.shift();
    if (!args[0] || args[0].startsWith("-")) throw new DroidLauncherUsageError("resume requires a Factory session id");
    opts.sessionId = args.shift();
    if (args[0] && !args[0].startsWith("-")) opts.peerName = args.shift();
    if (args[0] && !args[0].startsWith("-")) {
      opts.cwd = args.shift()!;
      opts.cwdExplicit = true;
    }
  } else {
    throw new DroidLauncherUsageError("expected start or resume");
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--cwd" || arg === "-C") {
      opts.cwd = requireValue(args, ++i, arg);
      opts.cwdExplicit = true;
    }
    else if (arg === "--name") opts.peerName = requireValue(args, ++i, arg);
    else if (arg === "--session-id") {
      throw new DroidLauncherUsageError("--session-id is not accepted; use the resume command");
    }
    else if (arg === "--droid") opts.droidCommand = requireValue(args, ++i, arg);
    else if (arg === "--model") opts.model = requireValue(args, ++i, arg);
    else if (arg === "--reasoning-effort") opts.reasoningEffort = requireValue(args, ++i, arg);
    else if (arg === "--autonomy-level") opts.autonomyLevel = requireValue(args, ++i, arg);
    else if (arg === "--poll-ms") opts.pollMs = positiveInt(requireValue(args, ++i, arg), arg);
    else if (arg === "--claim-timeout-ms") opts.claimTimeoutMs = positiveInt(requireValue(args, ++i, arg), arg);
    else throw new DroidLauncherUsageError(`unknown option: ${arg}`);
  }
  opts.cwd = resolve(opts.cwd);
  if (opts.autonomyLevel && /^(low|medium|high)$/.test(opts.autonomyLevel)) {
    opts.autonomyLevel = `auto-${opts.autonomyLevel}`;
  }
  return opts;
}

export function buildDroidMcpServer(opts: {
  claimId: string;
  stateRoot: string;
  peerName?: string;
  bunCommand?: string;
  serverPath?: string;
}): AcpMcpServer {
  const env: Array<{ name: string; value: string }> = [
    { name: "AGENT_PEERS_RUNTIME", value: "droid" },
    { name: "AGENT_PEERS_DROID_LAUNCH_CLAIM_ID", value: opts.claimId },
    { name: "AGENT_PEERS_DROID_STATE_DIR", value: opts.stateRoot },
    { name: "AGENT_PEERS_STATE_DIR", value: opts.stateRoot },
    { name: "AGENT_PEERS_DISABLE_TAB_TITLE", value: "1" },
  ];
  for (const name of [
    "AGENT_PEERS_PORT",
    "AGENT_PEERS_DB",
    "AGENT_PEERS_SECRET_PATH",
    "AGENT_PEERS_SPAWN_BROKER",
  ] as const) {
    const value = process.env[name];
    if (value) env.push({ name, value });
  }
  if (opts.peerName) env.push({ name: "PEER_NAME", value: opts.peerName });
  return {
    name: "agent-peers",
    command: opts.bunCommand ?? process.execPath,
    args: [opts.serverPath ?? fileURLToPath(new URL("../droid-server.ts", import.meta.url))],
    env,
  };
}

export class FileDroidWakeMetadataSource implements DroidWakeMetadataSource {
  private readonly path: string;

  constructor(opts: { stateRoot: string; peerId: string }) {
    // The peer id comes from the exact launch claim binding. encodeURIComponent
    // prevents even a malformed broker id from escaping the state root.
    this.path = join(opts.stateRoot, `${encodeURIComponent(opts.peerId)}.metadata.json`);
  }

  async read(): Promise<BodylessWakeState> {
    try {
      if (IS_POSIX) {
        const stat = await lstat(this.path);
        const uid = (process as unknown as { getuid?: () => number }).getuid?.();
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Droid wake metadata is not a regular file");
        if (typeof uid === "number" && stat.uid !== uid) throw new Error("Droid wake metadata is not owned by current user");
        if ((stat.mode & 0o777) !== FILE_MODE) throw new Error("Droid wake metadata is not private");
      }
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { unread?: Array<{ id?: unknown }> };
      if (!Array.isArray(parsed.unread)) throw new Error("Droid wake metadata has invalid unread state");
      const ids = parsed.unread.map((item) => item.id).filter((id): id is number => Number.isInteger(id));
      return {
        pendingCount: ids.length,
        lastMessageId: ids.length > 0 ? Math.max(...ids) : null,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { pendingCount: 0, lastMessageId: null };
      throw error;
    }
  }

  /** Exposed only for deterministic trust-boundary tests. */
  metadataPath(): string {
    return this.path;
  }
}

/** Resolve the metadata filename from the claim on every poll. The MCP keeps
 * the same PID across broker eviction/re-registration but may receive a new
 * peer id; freezing the initial binding would strand its new mailbox. */
export class ClaimBoundDroidWakeMetadataSource implements DroidWakeMetadataSource {
  private peerId: string | null = null;
  private source: FileDroidWakeMetadataSource | null = null;

  constructor(
    private readonly claims: Pick<DroidLaunchClaimStore, "readClaim">,
    private readonly claimId: string,
    private readonly stateRoot: string,
  ) {}

  async read(): Promise<BodylessWakeState> {
    const claim = await this.claims.readClaim(this.claimId);
    if (!claim || claim.status !== "bound" || !claim.peer_id) {
      throw new Error("Droid launch claim lost its bound peer");
    }
    if (claim.peer_id !== this.peerId) {
      this.peerId = claim.peer_id;
      this.source = new FileDroidWakeMetadataSource({ stateRoot: this.stateRoot, peerId: claim.peer_id });
    }
    return this.source!.read();
  }
}

export class DroidWakeController {
  private trackedMarker: string | null = null;
  private attempts = 0;
  private lastAttemptAtMs = 0;
  private inFlight: Promise<unknown> | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly client: WakePromptClient,
    private readonly source: DroidWakeMetadataSource,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly retryScheduleMs: number[] = DEFAULT_WAKE_RETRY_SCHEDULE_MS,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async pollOnce(): Promise<WakePollResult> {
    const state = await this.source.read();
    if (state.pendingCount === 0 || state.lastMessageId === null) {
      this.trackedMarker = null;
      this.attempts = 0;
      this.lastAttemptAtMs = 0;
      return { action: "empty", marker: null };
    }
    const marker = `${state.pendingCount}:${state.lastMessageId}`;
    const markerChanged = marker !== this.trackedMarker;
    if (markerChanged) {
      this.trackedMarker = marker;
      this.attempts = 0;
      this.lastAttemptAtMs = 0;
    }
    if (this.client.isBusy || this.inFlight) {
      return { action: markerChanged ? "queued" : "unchanged", marker };
    }

    const maxAttempts = this.retryScheduleMs.length + 1;
    if (this.attempts >= maxAttempts) return { action: "unchanged", marker };
    if (this.attempts > 0) {
      const requiredDelay = this.retryScheduleMs[this.attempts - 1]
        ?? this.retryScheduleMs.at(-1)
        ?? DEFAULT_WAKE_RETRY_SCHEDULE_MS[0]!;
      if (this.nowMs() - this.lastAttemptAtMs < requiredDelay) {
        return { action: "unchanged", marker };
      }
    }

    this.attempts += 1;
    this.lastAttemptAtMs = this.nowMs();
    this.inFlight = this.client.prompt(this.sessionId, DROID_WAKE_PROMPT);
    void this.inFlight.catch((error) => {
      // The same unread set remains authoritative and will be retried on the
      // bounded schedule. New mail changes the marker and wakes immediately.
      this.onError(error);
    }).finally(() => {
      this.inFlight = null;
    });
    return { action: "wake", marker };
  }

  async waitForIdle(): Promise<void> {
    await this.inFlight?.catch(() => {});
  }
}

export interface DroidLauncherDependencies {
  stateRoot?: string;
  claimStore?: DroidLaunchClaimStore;
  clientFactory?: (opts: DroidLauncherOptions) => DroidLauncherClient;
  metadataSourceFactory?: (binding: BoundDroidLaunchClaim, stateRoot: string) => DroidWakeMetadataSource;
  mcpServerFactory?: (claimId: string, stateRoot: string, peerName?: string) => AcpMcpServer;
  sleep?: (ms: number) => Promise<void>;
  shutdownGraceMs?: number;
  onReady?: (state: { peerId: string; peerName: string; sessionId: string }) => void;
  onWakeError?: (error: unknown) => void;
}

export interface DroidLauncherClient extends WakePromptClient {
  readonly closed: Promise<number>;
  initialize(): Promise<AcpInitializeResult>;
  newSession(opts: { cwd: string; mcpServers: AcpMcpServer[] }): Promise<string>;
  resumeSession(opts: {
    sessionId: string;
    cwd: string;
    mcpServers: AcpMcpServer[];
    capabilities: AcpInitializeResult["agentCapabilities"];
  }): Promise<string>;
  setConfigOption(sessionId: string, configId: string, value: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  close(): void;
}

export async function runDroidLauncher(
  opts: DroidLauncherOptions,
  deps: DroidLauncherDependencies = {},
  signal?: AbortSignal,
): Promise<number> {
  const stateRoot = deps.stateRoot ?? process.env.AGENT_PEERS_DROID_STATE_DIR ?? join(homedir(), ".agent-peers-droid");
  const claims = deps.claimStore ?? new DroidLaunchClaimStore({ rootDir: stateRoot });
  const saved = opts.sessionId ? await claims.readSession(opts.sessionId) : null;
  const effectiveOpts: DroidLauncherOptions = {
    ...opts,
    cwd: opts.sessionId && opts.cwdExplicit === false && saved ? saved.cwd : opts.cwd,
    peerName: opts.peerName ?? saved?.requested_peer_name ?? undefined,
  };
  const claim = await claims.createClaim({ cwd: effectiveOpts.cwd, requestedPeerName: effectiveOpts.peerName });
  const client = deps.clientFactory?.(effectiveOpts) ?? new DroidAcpClient(spawnDroidAcpTransport({
    cwd: effectiveOpts.cwd,
    droidCommand: effectiveOpts.droidCommand,
    onStderr: (chunk) => process.stderr.write(chunk),
  }));
  let sessionId: string | null = null;
  let abortHandler: (() => void) | null = null;

  try {
    const initialized = await client.initialize();
    const mcpServer = deps.mcpServerFactory?.(claim.claim_id, stateRoot, effectiveOpts.peerName)
      ?? buildDroidMcpServer({ claimId: claim.claim_id, stateRoot, peerName: effectiveOpts.peerName });
    sessionId = effectiveOpts.sessionId
      ? await resumeExactSession(client, initialized, effectiveOpts.sessionId, effectiveOpts.cwd, [mcpServer])
      : await client.newSession({ cwd: effectiveOpts.cwd, mcpServers: [mcpServer] });
    await configureDroidSession(client, sessionId, effectiveOpts);
    const binding = await claims.waitForBinding(claim.claim_id, { timeoutMs: effectiveOpts.claimTimeoutMs });
    // The MCP child can bind during session/new or session/resume. Finalize
    // the session id only after observing that completed write so the two
    // cross-process claim updates can never overwrite one another.
    await claims.setSessionId(claim.claim_id, sessionId);
    await claims.saveSession({ session_id: sessionId, cwd: effectiveOpts.cwd, requested_peer_name: effectiveOpts.peerName ?? null });
    deps.onReady?.({ peerId: binding.peer_id, peerName: binding.peer_name, sessionId });
    const source = deps.metadataSourceFactory?.(binding, stateRoot)
      ?? new ClaimBoundDroidWakeMetadataSource(claims, claim.claim_id, stateRoot);
    const controller = new DroidWakeController(sessionId, client, source, deps.onWakeError);
    const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));

    abortHandler = () => {
      void client.cancel(sessionId!).catch(() => {});
      client.close();
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    if (signal?.aborted) abortHandler();

    while (!signal?.aborted) {
      await controller.pollOnce();
      const outcome = await Promise.race([
        sleep(effectiveOpts.pollMs).then(() => null),
        client.closed.then((code) => ({ code })),
      ]);
      if (outcome) {
        await Promise.race([controller.waitForIdle(), sleep(deps.shutdownGraceMs ?? 2_000)]);
        return outcome.code;
      }
    }
    await Promise.race([controller.waitForIdle(), sleep(deps.shutdownGraceMs ?? 2_000)]);
    return 0;
  } finally {
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    client.close();
    await claims.removeClaim(claim.claim_id);
  }
}

async function configureDroidSession(
  client: Pick<DroidLauncherClient, "setConfigOption">,
  sessionId: string,
  opts: Pick<DroidLauncherOptions, "model" | "reasoningEffort" | "autonomyLevel">,
): Promise<void> {
  if (opts.model) await client.setConfigOption(sessionId, "model", opts.model);
  if (opts.reasoningEffort) await client.setConfigOption(sessionId, "reasoning_effort", opts.reasoningEffort);
  if (opts.autonomyLevel) await client.setConfigOption(sessionId, "autonomy_level", opts.autonomyLevel);
}

async function resumeExactSession(
  client: DroidLauncherClient,
  capabilities: AcpInitializeResult,
  sessionId: string,
  cwd: string,
  mcpServers: AcpMcpServer[],
): Promise<string> {
  return client.resumeSession({
    sessionId,
    cwd,
    mcpServers,
    capabilities: capabilities.agentCapabilities,
  });
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new DroidLauncherUsageError(`${flag} requires a value`);
  return value;
}

function positiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new DroidLauncherUsageError(`${flag} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new DroidLauncherUsageError(`${flag} must be a positive integer`);
  return value;
}
