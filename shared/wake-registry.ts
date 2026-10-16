// shared/wake-registry.ts
// Durable registry for Codex sessions launched in wakeable app-server mode.

import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import type { PeerId, PeerName } from "./types.ts";

export type WakeRegistryStatus = "starting" | "ready" | "stale";

export function hashBrokerSessionToken(sessionToken: string): string {
  return `sha256:${createHash("sha256").update(sessionToken, "utf8").digest("hex")}`;
}

export interface WakeRegistryEntry {
  peer_id: PeerId;
  peer_name: PeerName;
  cwd: string;
  git_root: string | null;
  tty: string | null;
  thread_id: string;
  rollout_path: string | null;
  app_server_url: string;
  app_server_socket_path: string | null;
  app_server_pid: number;
  tui_pid: number | null;
  mcp_pid: number;
  broker_session_token_hash: string;
  status: WakeRegistryStatus;
  capabilities: string[];
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

interface WakeRegistryState {
  entries: WakeRegistryEntry[];
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const IS_POSIX = platform() !== "win32";

function defaultRootDir(): string {
  return join(homedir(), ".agent-peers-codex");
}

async function atomicWriteJson<T>(path: string, value: T): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (IS_POSIX) {
    try { await chmod(dir, DIR_MODE); } catch { /* best effort */ }
  }

  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    await rename(tempPath, path);
  } finally {
    await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

// Only ESRCH proves a dead owner. Unknown/partial records and reused live PIDs
// fail closed; lock age alone never licenses stealing a writer's lock.
async function reclaimDeadLock(lockPath: string): Promise<void> {
  const guardPath = `${lockPath}.reclaim`;
  let guard;
  try {
    guard = await open(guardPath, "wx", FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    // Re-read *after* acquiring the reclaim guard. Rename/unlink based on a
    // prior observation can remove a fresh winner when two reclaimers race.
    let owner: { owner_pid?: number };
    try {
      owner = JSON.parse(await readFile(lockPath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const pid = owner?.owner_pid;
    if (!Number.isInteger(pid) || !pid || pid <= 0) return;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") await unlink(lockPath);
    }
  } finally {
    await guard.close();
    await unlink(guardPath);
  }
  // A crash while holding the reclaim guard deliberately fails closed on
  // future dead-owner recovery rather than introducing recursive lock theft.
}

async function acquireFileLock(filePath: string): Promise<() => Promise<void>> {
  await mkdir(dirname(filePath), { recursive: true, mode: DIR_MODE });
  const lockPath = `${filePath}.lock`;
  const deadline = performance.now() + 2_000;
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx", FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw new Error(`Wake registry lock timed out: ${lockPath}`);
      await reclaimDeadLock(lockPath);
      await Bun.sleep(10);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ owner_pid: process.pid }));
    } catch (error) {
      await handle.close();
      await unlink(lockPath);
      throw error;
    }
    await handle.close();
    return async () => { await unlink(lockPath); };
  }
}

function cloneEntry(entry: WakeRegistryEntry): WakeRegistryEntry {
  return {
    ...entry,
    capabilities: [...entry.capabilities],
  };
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function socketPathExists(path: string | null): Promise<boolean> {
  if (!path) return true;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class WakeRegistry {
  private readonly filePath: string;
  private readonly persistState: (path: string, value: WakeRegistryState) => Promise<void>;
  private state: WakeRegistryState = { entries: [] };
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: {
    rootDir?: string;
    persistState?: (path: string, value: WakeRegistryState) => Promise<void>;
  } = {}) {
    const rootDir = opts.rootDir ?? process.env.AGENT_PEERS_CODEX_STATE_DIR ?? defaultRootDir();
    this.filePath = join(rootDir, "wake-registry.json");
    this.persistState = opts.persistState ?? atomicWriteJson;
  }

  async init(): Promise<void> {
    await this.withLock(async () => {});
  }

  async list(opts: { includeStale?: boolean } = {}): Promise<WakeRegistryEntry[]> {
    return this.withLock(async () => {
      const entries: WakeRegistryEntry[] = [];
      for (const entry of this.state.entries) {
        const live = await this.isLive(entry);
        if (opts.includeStale || live) entries.push(cloneEntry(live ? entry : { ...entry, status: "stale" }));
      }
      return entries.sort((a, b) => a.peer_name.localeCompare(b.peer_name) || a.thread_id.localeCompare(b.thread_id));
    });
  }

  async upsert(entry: WakeRegistryEntry): Promise<void> {
    await this.withLock(async () => {
      const nextEntries = this.state.entries
        .filter((existing) => existing.peer_id !== entry.peer_id && existing.thread_id !== entry.thread_id)
        .map(cloneEntry);
      nextEntries.push(cloneEntry(entry));
      const nextState = { entries: nextEntries.sort((a, b) => a.peer_id.localeCompare(b.peer_id)) };
      await this.persistState(this.filePath, nextState);
      this.state = nextState;
    });
  }

  async removeByPeerId(peerId: PeerId): Promise<void> {
    await this.withLock(async () => {
      const nextState = {
        entries: this.state.entries.filter((entry) => entry.peer_id !== peerId),
      };
      if (nextState.entries.length === this.state.entries.length) return;
      await this.persistState(this.filePath, nextState);
      this.state = nextState;
    });
  }

  // Garbage-collect entries whose processes are dead and that have not been
  // seen for longer than deadGraceMs. The grace window keeps a freshly-died
  // session visible in `peerstatus` for a short while (useful for diagnosis)
  // without letting dead rows accumulate forever. A live session is never
  // pruned regardless of age. Returns the number of rows removed.
  async prune(opts: { deadGraceMs: number; now?: () => Date } = { deadGraceMs: 30 * 60_000 }): Promise<number> {
    const nowMs = (opts.now ?? (() => new Date()))().getTime();
    return this.withLock(async () => {
      const kept: WakeRegistryEntry[] = [];
      for (const entry of this.state.entries) {
        if (await this.isLive(entry)) {
          kept.push(entry);
          continue;
        }
        const lastSeen = Date.parse(entry.last_seen_at);
        const ageMs = Number.isFinite(lastSeen) ? nowMs - lastSeen : Number.POSITIVE_INFINITY;
        if (ageMs <= opts.deadGraceMs) kept.push(entry);
      }
      const removed = this.state.entries.length - kept.length;
      if (removed === 0) return 0;
      const nextState = { entries: kept.map(cloneEntry) };
      await this.persistState(this.filePath, nextState);
      this.state = nextState;
      return removed;
    });
  }

  async getByPeerId(peerId: PeerId): Promise<WakeRegistryEntry | null> {
    return this.withLock(async () => {
      const entry = this.state.entries.find((candidate) => candidate.peer_id === peerId);
      return entry ? cloneEntry(entry) : null;
    });
  }

  async markSeen(peerId: PeerId, at = new Date().toISOString()): Promise<void> {
    await this.withLock(async () => {
      const nextEntries = this.state.entries.map((entry) =>
        entry.peer_id === peerId
          ? { ...entry, last_seen_at: at, updated_at: at, status: "ready" as const }
          : cloneEntry(entry)
      );
      await this.persistState(this.filePath, { entries: nextEntries });
      this.state = { entries: nextEntries };
    });
  }

  private async isLive(entry: WakeRegistryEntry): Promise<boolean> {
    if (!isProcessAlive(entry.app_server_pid)) return false;
    if (!isProcessAlive(entry.mcp_pid)) return false;
    if (entry.tui_pid !== null && !isProcessAlive(entry.tui_pid)) return false;
    if (!(await socketPathExists(entry.app_server_socket_path))) return false;
    return true;
  }

  private async readStateFromDisk(): Promise<WakeRegistryState> {
    try {
      if (IS_POSIX) {
        const st = await stat(this.filePath);
        if (!st.isFile()) return { entries: [] };
        const mine = (process as unknown as { getuid?: () => number }).getuid?.();
        if (typeof mine === "number" && st.uid !== mine) return { entries: [] };
        if ((st.mode & 0o777) !== FILE_MODE) return { entries: [] };
      }

      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WakeRegistryState>;
      if (!Array.isArray(parsed.entries)) return { entries: [] };
      return { entries: parsed.entries.map((entry) => cloneEntry(entry as WakeRegistryEntry)) };
    } catch {
      return { entries: [] };
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const releaseFileLock = await acquireFileLock(this.filePath);
      try {
        // All readers and mutations use the latest committed snapshot. Never
        // persist a cached instance snapshot over another process's rows.
        this.state = await this.readStateFromDisk();
        return await fn();
      } finally {
        await releaseFileLock();
      }
    } finally {
      release();
    }
  }
}
