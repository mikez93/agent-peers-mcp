// Exact-thread registration for a desktop/SSH app-server's per-thread MCP.
// No resume or endpoint guessing: app-owned stdio hosts simply stay non-wakeable.
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { platform } from "node:os";
import { promisify } from "node:util";
import { CodexAppServerWsClient, type AppServerClient } from "./app-server-client.ts";
import { createAsyncLock } from "./async-lock.ts";
import { hashBrokerSessionToken, WakeRegistry, type WakeRegistryEntry } from "./wake-registry.ts";

const execFileAsync = promisify(execFile);

export function desktopWakeEligible(runtime: string, env: NodeJS.ProcessEnv): boolean {
  return runtime === "codex" && env.AGENT_PEERS_WAKE_ENABLED !== "1"
    && env.AGENT_PEERS_WAKE_ENABLED !== "0" && env.AGENT_PEERS_WAKE_LAUNCH !== "1";
}

export function desktopThreadId(meta: unknown): string | null {
  const value = meta && typeof meta === "object" ? (meta as Record<string, unknown>).threadId : null;
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value : null;
}

export function parentSocketPaths(output: string, parentPid: number): string[] {
  const paths = new Set<string>();
  let owner = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) owner = line === `p${parentPid}`;
    if (owner && line.startsWith("n/")) paths.add(line.slice(1));
  }
  return [...paths];
}

async function listParentSockets(parentPid: number): Promise<string[]> {
  if (platform() !== "darwin" || !Number.isInteger(parentPid) || parentPid <= 1) return [];
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-a", "-p", String(parentPid), "-U", "-Fn"],
      { timeout: 1_000, maxBuffer: 128 * 1024 });
    return parentSocketPaths(stdout, parentPid);
  } catch {
    // lsof exits 1 for no matching sockets. A missing utility/timeout likewise
    // leaves ordinary inbox access available; discovery is attempted only once.
    return [];
  }
}

export interface DesktopWakeBinding {
  threadId: string;
  cwd: string;
  rolloutPath: string | null;
  socketPath: string;
  appServerUrl: string;
  appServerPid: number;
}

interface DiscoveryDeps {
  listSockets?: (pid: number) => Promise<string[]>;
  isSocket?: (path: string) => Promise<boolean>;
  canonicalPath?: (path: string) => Promise<string>;
  clientFactory?: (url: string, timeoutMs: number) => AppServerClient;
}

export async function discoverDesktopWake(
  opts: { threadId: string; parentPid: number; cwd: string },
  deps: DiscoveryDeps = {},
): Promise<DesktopWakeBinding | null> {
  const canonical = deps.canonicalPath ?? realpath;
  const isSocket = deps.isSocket ?? (async path => (await stat(path)).isSocket());
  const sockets = [...new Set(await (deps.listSockets ?? listParentSockets)(opts.parentPid))];
  if (!sockets.length) return null;
  const cwd = await canonical(opts.cwd);
  const matches: DesktopWakeBinding[] = [];
  // One bounded discovery pass, not a retry loop. Never expand to other PIDs.
  const deadline = Date.now() + 3_000;
  for (const socketPath of sockets) {
    if (!socketPath.startsWith("/") || !(await isSocket(socketPath).catch(() => false))) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const appServerUrl = `ws+unix://${socketPath}`;
    // initialize, list, and read each get at most a third of the time left.
    const timeoutMs = Math.max(1, Math.floor(remaining / 3));
    const client = deps.clientFactory?.(appServerUrl, timeoutMs)
      ?? new CodexAppServerWsClient(appServerUrl, { timeoutMs });
    try {
      const loaded = await client.listLoadedThreads();
      if (!loaded.includes(opts.threadId)) continue;
      const thread = await client.readThread(opts.threadId);
      if (thread.id !== opts.threadId || thread.status.type === "notLoaded"
        || await canonical(thread.cwd) !== cwd) continue;
      matches.push({ threadId: thread.id, cwd: thread.cwd, rolloutPath: thread.path,
        socketPath, appServerUrl, appServerPid: opts.parentPid });
    } catch {
      // An unvalidated parent endpoint is not a wake target.
    } finally {
      client.close();
    }
  }
  return matches.length === 1 ? matches[0]! : null;
}

export interface DesktopWakePeer {
  peerId: string;
  peerName: string;
  sessionToken: string;
  gitRoot: string | null;
  tty: string | null;
}

export class CodexDesktopWakeRegistration {
  private readonly lock = createAsyncLock();
  private readonly registry: Pick<WakeRegistry, "upsert" | "removeByPeerId">;
  private threadId: string | null = null;
  private attempted = false;
  private invalid = false;
  private binding: DesktopWakeBinding | null = null;
  private registered: WakeRegistryEntry | null = null;

  constructor(private readonly opts: {
    parentPid: number;
    mcpPid: number;
    cwd: string;
    registry?: Pick<WakeRegistry, "upsert" | "removeByPeerId">;
    discover?: typeof discoverDesktopWake;
    onError?: (error: unknown) => void;
  }) {
    this.registry = opts.registry ?? new WakeRegistry();
  }

  // Call only AFTER delivery.newArrival(): discovery must not move the
  // confirm-on-next-call barrier past an await (including a long wait tool).
  observe(meta: unknown, peer: DesktopWakePeer): Promise<boolean> {
    const threadId = desktopThreadId(meta);
    return this.lock(async () => {
      if (this.invalid) return false;
      if (threadId && this.threadId && threadId !== this.threadId) {
        this.invalid = true;
        this.binding = null;
        try {
          if (this.registered) await this.registry.removeByPeerId(this.registered.peer_id);
        } catch (error) { this.opts.onError?.(error); }
        this.registered = null;
        return false;
      }
      if (!threadId) return this.registered !== null;
      this.threadId = threadId;
      if (!this.attempted) {
        this.attempted = true;
        try {
          this.binding = await (this.opts.discover ?? discoverDesktopWake)({
            threadId, parentPid: this.opts.parentPid, cwd: this.opts.cwd,
          });
        } catch (error) { this.opts.onError?.(error); }
      }
      return this.persist(peer);
    });
  }

  // Broker rejoin and rename reuse the validated endpoint, never rediscover or
  // retarget. An unsupported stdio host has no binding and does no further I/O.
  refresh(peer: DesktopWakePeer): Promise<boolean> {
    return this.lock(() => this.persist(peer));
  }

  private async persist(peer: DesktopWakePeer): Promise<boolean> {
    if (this.invalid || !this.binding) return false;
    const hash = hashBrokerSessionToken(peer.sessionToken);
    if (this.registered?.peer_id === peer.peerId && this.registered.peer_name === peer.peerName
      && this.registered.broker_session_token_hash === hash) return true;
    const now = new Date().toISOString();
    const binding = this.binding;
    const entry: WakeRegistryEntry = {
      peer_id: peer.peerId, peer_name: peer.peerName, cwd: binding.cwd,
      git_root: peer.gitRoot, tty: peer.tty, thread_id: binding.threadId,
      rollout_path: binding.rolloutPath, app_server_url: binding.appServerUrl,
      app_server_socket_path: binding.socketPath, app_server_pid: binding.appServerPid,
      tui_pid: null, mcp_pid: this.opts.mcpPid, broker_session_token_hash: hash,
      status: "ready", capabilities: ["app-server-ws"],
      created_at: this.registered?.created_at ?? now, updated_at: now, last_seen_at: now,
    };
    try {
      await this.registry.upsert(entry);
      this.registered = entry;
      return true;
    } catch (error) {
      this.opts.onError?.(error);
      return false;
    }
  }
}
