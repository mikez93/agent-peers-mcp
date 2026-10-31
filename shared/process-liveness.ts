/** Only ESRCH proves a valid PID is gone. EPERM (and an unavailable probe)
 * must not let a competing wake process steal a live owner's claim. */
export function isProcessAlive(
  pid: number | null | undefined,
  probe: (pid: number, signal: 0) => unknown = process.kill,
): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}
