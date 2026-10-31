import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson } from "../shared/file-state.ts";
import { isProcessAlive } from "../shared/process-liveness.ts";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "ap-file-state-"));
  dirs.push(dir);
  return dir;
}

test("concurrent atomic JSON publishers use separate private temp files", async () => {
  const dir = await tempDir();
  const path = join(dir, "state.json");
  await writeFile(`${path}.tmp`, "old crash residue", { mode: 0o600 });
  const values = Array.from({ length: 64 }, (_, id) => ({ id, body: String(id).repeat(20_000) }));
  await Promise.all(values.map((value) => atomicWriteJson(path, value)));
  const result = JSON.parse(await readFile(path, "utf8"));
  expect(result).toEqual(values[result.id]);
  expect(await readFile(`${path}.tmp`, "utf8")).toBe("old crash residue");
  expect((await readdir(dir)).sort()).toEqual(["state.json", "state.json.tmp"]);
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  }
});

test("failed atomic publication cleans its own temp file and preserves existing state", async () => {
  const dir = await tempDir();
  const path = join(dir, "state.json");
  await atomicWriteJson(path, { retained: true });
  const cyclic: any = {};
  cyclic.self = cyclic;
  await expect(atomicWriteJson(path, cyclic)).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ retained: true });
  await mkdir(join(dir, "target-directory"));
  await expect(atomicWriteJson(join(dir, "target-directory"), {})).rejects.toThrow();
  expect((await readdir(dir)).sort()).toEqual(["state.json", "target-directory"]);
});

test("PID liveness distinguishes dead owners from permission errors", () => {
  const fail = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(42, fail("ESRCH"))).toBe(false);
  expect(isProcessAlive(42, fail("EPERM"))).toBe(true);
  expect(isProcessAlive(42, fail("EIO"))).toBe(true);
  for (const pid of [null, undefined, 0, -1, NaN, Infinity, 1.5]) {
    expect(isProcessAlive(pid, () => { throw new Error("must not probe invalid PID"); })).toBe(false);
  }
});
