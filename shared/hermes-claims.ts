// shared/hermes-claims.ts
//
// One peer per logical Hermes agent. Per Hermes profile, BOTH the gateway and
// the serve process load hermes-server.ts with the same PEER_NAME (and no
// cwd), so one profile used to register 2-3 peers — the broker's suffix
// ladder disambiguated them into `ezra-hermes`, `-2`, `-3`, and name-addressed
// mail landed on whichever surface registered first after boot.
//
// The fix is the same shape as the Codex wake-launch election
// (wake-launch-claims.ts tryAcquireRoot), but keyed by PEER_NAME instead of
// cwd/tty — Hermes surfaces share a cwd and have no tty, so the Codex key
// cannot distinguish them. Exclusive-create (`wx`) is atomic on POSIX: exactly
// one surface wins no matter how they interleave. The loser registers an
// EPHEMERAL generated name — unlike Codex secondaries it must NOT go inert,
// because the losing surface may be the one the user is currently talking
// through; it can still send, it just never owns the canonical name.
//
// Locks are advisory over process lifetime: a lock whose owner pid is dead is
// reclaimable, and winners release on shutdown so the next turn's surface can
// win.

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function defaultClaimsDir(): string {
  const root = process.env.AGENT_PEERS_STATE_DIR
    ?? process.env.AGENT_PEERS_HERMES_STATE_DIR
    ?? join(homedir(), ".agent-peers-hermes");
  return join(root, "name-claims");
}

function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means "alive but not ours" — still alive.
    return e instanceof Error && "code" in e && (e as { code?: string }).code === "EPERM";
  }
}

/** PID-reuse guard (2026-08-10 review medium): after a reboot, an unrelated
 *  process can be assigned the lock owner's old pid, making a genuinely dead
 *  claim look held forever and stranding the canonical name. A pid only
 *  vouches for the lock if its process STARTED BEFORE the lock was acquired
 *  (2s tolerance — ps lstart has 1s precision). If `ps` can't answer (EPERM'd
 *  zombie, race), fall back to pid-liveness alone — the conservative side. */
function ownerStillHoldsClaim(pid: number | null | undefined, acquiredAt: string | undefined): boolean {
  if (!isProcessAlive(pid)) return false;
  if (!acquiredAt) return true;
  const acquired = Date.parse(acquiredAt);
  if (!Number.isFinite(acquired)) return true;
  try {
    const proc = Bun.spawnSync(["ps", "-p", String(pid), "-o", "lstart="]);
    const started = Date.parse(proc.stdout.toString().trim());
    if (!Number.isFinite(started)) return true;
    return started <= acquired + 2_000;
  } catch {
    return true;
  }
}

function lockPathFor(dir: string, peerName: string): string {
  return join(dir, `${encodeURIComponent(peerName)}.lock`);
}

export class HermesNameClaims {
  constructor(private readonly dir: string = defaultClaimsDir()) {}

  /** Atomically try to become the sole owner of `peerName`. Reclaims locks
   *  held by dead processes. Idempotent for the same ownerPid. */
  async tryAcquire(peerName: string, ownerPid: number): Promise<boolean> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const lockPath = lockPathFor(this.dir, peerName);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeFile(
          lockPath,
          JSON.stringify({ owner_pid: ownerPid, acquired_at: new Date().toISOString() }),
          { encoding: "utf8", mode: FILE_MODE, flag: "wx" },
        );
        return true;
      } catch {
        let held: { owner_pid?: number; acquired_at?: string };
        try {
          held = JSON.parse(await readFile(lockPath, "utf8")) as { owner_pid?: number; acquired_at?: string };
        } catch (e) {
          const gone = e instanceof Error && "code" in e && (e as { code?: string }).code === "ENOENT";
          if (gone) continue; // lock vanished between wx and read — retry wx
          return false; // unreadable/corrupt lock: fail closed
        }
        if (held?.owner_pid === ownerPid) return true;
        if (ownerStillHoldsClaim(held?.owner_pid, held?.acquired_at)) return false;
        // Dead owner. A plain unlink+retry races a concurrent reclaimer:
        // after SIGKILL of the old winner, gateway and serve boot together,
        // both read the dead pid — one unlinks and re-creates via wx, the
        // other then unlinks the FRESH winner's lock, and both win. rename()
        // is the atomic claim on the STALE file: exactly one renamer
        // succeeds; the loser gets ENOENT and loops back to a plain wx
        // attempt against whatever the winner wrote.
        try {
          const tomb = `${lockPath}.reclaim.${ownerPid}.${Date.now()}`;
          await rename(lockPath, tomb);
          await unlink(tomb).catch(() => {});
        } catch { /* lost the reclaim race — loop back to wx */ }
      }
    }
    return false;
  }

  /** Release only if we own it — a loser must never delete the winner's lock. */
  async release(peerName: string, ownerPid: number): Promise<void> {
    const lockPath = lockPathFor(this.dir, peerName);
    try {
      const held = JSON.parse(await readFile(lockPath, "utf8")) as { owner_pid?: number };
      if (held?.owner_pid === ownerPid) await unlink(lockPath);
    } catch { /* already gone or unreadable — nothing to release */ }
  }
}
