import { join } from "node:path";
import { HermesNameClaims, ownerStillHoldsClaim } from "./hermes-claims.ts";
import { DroidLaunchClaimStore } from "./droid-launch-claims.ts";

// Reuse the tested process-lifetime exclusive-file claim. Both managed paths
// must acquire it before resuming a saved Factory session into a new engine.
export async function acquireDroidSession(root: string, sessionId: string): Promise<() => Promise<void>> {
  const owners = new HermesNameClaims(join(root, "session-owners"));
  if (!await owners.tryAcquire(sessionId, process.pid)) throw new Error("Factory session already has a live droidpeer owner; close that launcher before resuming");
  const release = () => owners.release(sessionId, process.pid);
  try {
    // Older ACP hosts predate this lock. Their live launch claims still count.
    for (const claim of await new DroidLaunchClaimStore({ rootDir: root }).listClaims()) {
      if (claim.launcher_pid === process.pid || (claim.session_id !== null && claim.session_id !== sessionId)) continue;
      if (!ownerStillHoldsClaim(claim.launcher_pid, claim.created_at)) continue;
      if (claim.session_id === null) throw new Error("Another live droidpeer owner is still starting; wait for its session binding or close it before retrying");
      throw new Error("Factory session already has a live droidpeer owner; close that launcher before resuming");
    }
    return release;
  } catch (error) { await release(); throw error; }
}
