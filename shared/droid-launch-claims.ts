// Private, bodyless rendezvous state between the Droid ACP launcher and the
// agent-peers MCP child that Droid starts for the exact ACP session.

import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const IS_POSIX = platform() !== "win32";
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface DroidLaunchClaim {
  claim_id: string;
  cwd: string;
  requested_peer_name: string | null;
  previous_peer_id?: string | null;
  launcher_pid: number;
  session_id: string | null;
  peer_id: string | null;
  peer_name: string | null;
  mcp_pid: number | null;
  status: "starting" | "bound";
  created_at: string;
  updated_at: string;
}

export interface BoundDroidLaunchClaim extends DroidLaunchClaim {
  peer_id: string;
  peer_name: string;
  mcp_pid: number;
  status: "bound";
}

/** Crash residue must not shadow the claim held by the broker's current MCP. */
export function selectDroidClaim(
  claims: readonly BoundDroidLaunchClaim[],
  peer: { id: string; pid: number | null },
  isAlive: (pid: number) => boolean,
): BoundDroidLaunchClaim | undefined {
  const rank = (claim: BoundDroidLaunchClaim): number =>
    (claim.mcp_pid === peer.pid ? 2 : 0)
    + (isAlive(claim.launcher_pid) && isAlive(claim.mcp_pid) && !!claim.session_id ? 1 : 0);
  return claims.filter((claim) => claim.peer_id === peer.id).sort((a, b) =>
    rank(b) - rank(a) || b.updated_at.localeCompare(a.updated_at) || b.claim_id.localeCompare(a.claim_id)
  )[0];
}

export interface DroidSessionState {
  session_id: string;
  cwd: string;
  requested_peer_name: string | null;
  /** Actual broker allocation, including any concurrent-instance suffix. */
  peer_name?: string;
  peer_id?: string;
  updated_at: string;
}

function defaultRootDir(): string {
  return process.env.AGENT_PEERS_DROID_STATE_DIR ?? join(homedir(), ".agent-peers-droid");
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  if (IS_POSIX) await chmod(path, DIR_MODE);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
  if (IS_POSIX) await chmod(tempPath, FILE_MODE);
  await rename(tempPath, path);
}

async function readPrivateJson(path: string): Promise<unknown | null> {
  try {
    if (IS_POSIX) {
      const stat = await lstat(path);
      const uid = (process as unknown as { getuid?: () => number }).getuid?.();
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing non-regular state file: ${path}`);
      if (typeof uid === "number" && stat.uid !== uid) throw new Error(`refusing state file not owned by current user: ${path}`);
      if ((stat.mode & 0o777) !== FILE_MODE) throw new Error(`refusing state file with mode ${(stat.mode & 0o777).toString(8)}: ${path}`);
    }
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class DroidLaunchClaimStore {
  private readonly rootDir: string;
  private readonly claimsDir: string;
  private readonly sessionsDir: string;

  constructor(opts: { rootDir?: string } = {}) {
    const root = opts.rootDir ?? defaultRootDir();
    this.rootDir = root;
    this.claimsDir = join(root, "claims");
    this.sessionsDir = join(root, "sessions");
  }

  async createClaim(opts: { cwd: string; requestedPeerName?: string; previousPeerId?: string; launcherPid?: number }): Promise<DroidLaunchClaim> {
    await ensurePrivateDir(this.rootDir);
    const now = new Date().toISOString();
    const claim: DroidLaunchClaim = {
      claim_id: randomUUID(),
      cwd: opts.cwd,
      requested_peer_name: opts.requestedPeerName ?? null,
      previous_peer_id: opts.previousPeerId ?? null,
      launcher_pid: opts.launcherPid ?? process.pid,
      session_id: null,
      peer_id: null,
      peer_name: null,
      mcp_pid: null,
      status: "starting",
      created_at: now,
      updated_at: now,
    };
    await atomicWriteJson(this.claimPath(claim.claim_id), claim);
    return claim;
  }

  async setSessionId(claimId: string, sessionId: string): Promise<void> {
    await this.withClaimUpdate(claimId, async () => {
      const claim = await this.requireClaim(claimId);
      const finalized = {
        ...claim,
        session_id: sessionId,
        updated_at: new Date().toISOString(),
      };
      await atomicWriteJson(this.claimPath(claimId), finalized);
      if (finalized.status === "bound") await this.saveBoundSession(finalized as BoundDroidLaunchClaim);
    });
  }

  async bindClaim(claimId: string, binding: { peerId: string; peerName: string; mcpPid: number; cwd: string }): Promise<BoundDroidLaunchClaim> {
    return this.withClaimUpdate(claimId, () => this.bindClaimInner(claimId, binding));
  }

  private async bindClaimInner(claimId: string, binding: { peerId: string; peerName: string; mcpPid: number; cwd: string }): Promise<BoundDroidLaunchClaim> {
    const claim = await this.requireClaim(claimId);
    if (!binding.peerId || !binding.peerName || !Number.isInteger(binding.mcpPid) || binding.mcpPid <= 0) {
      throw new Error("invalid Droid peer binding");
    }
    if (binding.cwd !== claim.cwd) {
      throw new Error(`Droid launch claim ${claimId} cwd does not match the registered MCP cwd`);
    }
    if (!await this.tryAcquireBinding(claimId, binding.mcpPid)) {
      throw new Error(`Droid launch claim ${claimId} is already bound to another MCP process`);
    }
    if (claim.status === "bound") {
      // A broker restart can evict and re-register this exact MCP process with
      // a new peer id/session token. The claim follows that incarnation change
      // for the lifetime of this launcher claim. A replacement MCP process
      // must use a fresh claim by restarting/resuming the launcher; binding
      // locks deliberately fail closed rather than attempting racy recovery.
      if (claim.mcp_pid !== binding.mcpPid) {
        throw new Error(`Droid launch claim ${claimId} is already bound to another MCP process`);
      }
      if (claim.peer_id === binding.peerId && claim.peer_name === binding.peerName) return claim as BoundDroidLaunchClaim;
      const rebound: BoundDroidLaunchClaim = {
        ...claim,
        peer_id: binding.peerId,
        peer_name: binding.peerName,
        updated_at: new Date().toISOString(),
      } as BoundDroidLaunchClaim;
      await atomicWriteJson(this.claimPath(claimId), rebound);
      if (rebound.session_id) await this.saveBoundSession(rebound);
      return rebound;
    }
    const bound: BoundDroidLaunchClaim = {
      ...claim,
      peer_id: binding.peerId,
      peer_name: binding.peerName,
      mcp_pid: binding.mcpPid,
      status: "bound",
      updated_at: new Date().toISOString(),
    };
    await atomicWriteJson(this.claimPath(claimId), bound);
    if (bound.session_id) await this.saveBoundSession(bound);
    return bound;
  }

  /** Short cross-process critical section for launcher finalization and MCP
   * rebinding. A crashed writer is not stolen: resume creates a fresh claim. */
  private async withClaimUpdate<T>(claimId: string, update: () => Promise<T>): Promise<T> {
    const lock = `${this.claimPath(claimId)}.update-lock`;
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        await writeFile(lock, String(process.pid), { mode: FILE_MODE, flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Droid claim update is locked; restart/resume with a fresh launch claim");
        await Bun.sleep(10);
      }
    }
    try { return await update(); }
    finally { await unlink(lock); }
  }

  private async saveBoundSession(claim: BoundDroidLaunchClaim): Promise<void> {
    await this.saveSession({ session_id: claim.session_id!, cwd: claim.cwd,
      requested_peer_name: claim.requested_peer_name, peer_id: claim.peer_id, peer_name: claim.peer_name });
  }

  async waitForBinding(claimId: string, opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<BoundDroidLaunchClaim> {
    const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
    while (true) {
      opts.signal?.throwIfAborted();
      const claim = await this.readClaim(claimId);
      if (!claim) throw new Error(`Droid launch claim ${claimId} disappeared before binding`);
      if (claim.status === "bound" && claim.peer_id && claim.peer_name && claim.mcp_pid) {
        return claim as BoundDroidLaunchClaim;
      }
      if (Date.now() >= deadline) throw new Error(`Droid MCP did not bind launch claim within ${opts.timeoutMs ?? 15_000}ms`);
      await Bun.sleep(opts.pollMs ?? 50);
    }
  }

  async readClaim(claimId: string): Promise<DroidLaunchClaim | null> {
    validateClaimId(claimId);
    const parsed = await readPrivateJson(this.claimPath(claimId));
    if (!parsed || typeof parsed !== "object") return null;
    const claim = parsed as Partial<DroidLaunchClaim>;
    if (claim.claim_id !== claimId || typeof claim.cwd !== "string" || typeof claim.launcher_pid !== "number") {
      throw new Error(`invalid Droid launch claim: ${claimId}`);
    }
    // Claims are intentionally bodyless and credential-free. Reject a future
    // writer that accidentally tries to expand this trust boundary.
    if ("session_token" in claim || "text" in claim || "message" in claim) {
      throw new Error(`Droid launch claim ${claimId} contains forbidden sensitive fields`);
    }
    return claim as DroidLaunchClaim;
  }

  async removeClaim(claimId: string): Promise<void> {
    validateClaimId(claimId);
    try { await unlink(this.claimPath(claimId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try { await unlink(this.bindingPath(claimId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async listClaims(): Promise<DroidLaunchClaim[]> {
    let names: string[];
    try {
      names = await readdir(this.claimsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const claims = await Promise.all(names
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readClaim(name.slice(0, -".json".length))));
    return claims.filter((claim): claim is DroidLaunchClaim => claim !== null);
  }

  async saveSession(state: Omit<DroidSessionState, "updated_at">): Promise<void> {
    await ensurePrivateDir(this.rootDir);
    await atomicWriteJson(this.sessionPath(state.session_id), {
      ...state,
      updated_at: new Date().toISOString(),
    } satisfies DroidSessionState);
  }

  async readSession(sessionId: string): Promise<DroidSessionState | null> {
    const parsed = await readPrivateJson(this.sessionPath(sessionId));
    if (!parsed || typeof parsed !== "object") return null;
    const state = parsed as Partial<DroidSessionState>;
    if (state.session_id !== sessionId || typeof state.cwd !== "string") {
      throw new Error(`invalid Droid session state for ${sessionId}`);
    }
    return state as DroidSessionState;
  }

  private async requireClaim(claimId: string): Promise<DroidLaunchClaim> {
    const claim = await this.readClaim(claimId);
    if (!claim) throw new Error(`unknown Droid launch claim: ${claimId}`);
    return claim;
  }

  private claimPath(claimId: string): string {
    validateClaimId(claimId);
    return join(this.claimsDir, `${claimId}.json`);
  }

  private bindingPath(claimId: string): string {
    validateClaimId(claimId);
    return join(this.claimsDir, `${claimId}.binding`);
  }

  private async tryAcquireBinding(claimId: string, ownerPid: number): Promise<boolean> {
    await ensurePrivateDir(this.claimsDir);
    const path = this.bindingPath(claimId);
    try {
      await writeFile(path, JSON.stringify({ owner_pid: ownerPid }), {
        encoding: "utf8",
        mode: FILE_MODE,
        flag: "wx",
      });
      return true;
    } catch {
      try {
        const held = JSON.parse(await readFile(path, "utf8")) as { owner_pid?: number };
        return held.owner_pid === ownerPid;
      } catch {
        return false;
      }
    }
  }

  private sessionPath(sessionId: string): string {
    const key = createHash("sha256").update(sessionId, "utf8").digest("hex");
    return join(this.sessionsDir, `${key}.json`);
  }
}

function validateClaimId(claimId: string): void {
  if (!CLAIM_ID.test(claimId)) throw new Error("invalid Droid launch claim id");
}
