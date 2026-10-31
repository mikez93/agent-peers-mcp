import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { platform } from "node:os";
import { dirname } from "node:path";

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (platform() !== "win32") await chmod(path, 0o700);
}

/** Atomic publication, not a read/modify/write lock. Callers still own their
 * serialization. Unique exclusive temp files cannot collide across writers. */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  await ensurePrivateDir(dirname(path));
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const file = await open(tempPath, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(json, "utf8");
      if (platform() !== "win32") await file.chmod(0o600);
    } finally {
      await file.close();
    }
    await rename(tempPath, path);
  } finally {
    if (created) await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
