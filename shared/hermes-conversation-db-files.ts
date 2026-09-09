import { lstatSync } from "node:fs";

export function validateConversationDbFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    let stat;
    try { stat = lstatSync(path + suffix); }
    catch (error) {
      if (suffix && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("v2_requires_owner_only_database_and_sidecars");
    }
  }
}
