import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "wakeable-agy.ts");
const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function run(args: string[], env: Record<string, string> = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", entry, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("version flags are bare fast-path output", async () => {
  for (const flag of ["-v", "-V", "--version"]) {
    expect(await run([flag])).toEqual({ exitCode: 0, stdout: "0.1.0\n", stderr: "" });
  }
});

test("help names the command, its defaults, the auto-mode caveat and complete examples", async () => {
  const result = await run(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("bin: ~/.local/bin/agypeer");
  expect(result.stdout).toContain("usage: agypeer [start [peer-name] [cwd]]");
  expect(result.stdout).toContain("agypeer resume <session-id>");
  expect(result.stdout).toContain("default: gemini-4-neon");
  expect(result.stdout).toContain("default: accept-edits");
  expect(result.stdout).toContain("asks before running commands");
  expect(result.stdout).toContain("agypeer start reviewer ~/code/service --thinking medium");
});

test("unknown input and bad modes are structured usage errors with exit code 2", async () => {
  const extra = await run(["start", "peer", "/tmp", "unexpected"]);
  expect(extra.exitCode).toBe(2);
  expect(extra.stdout).toContain("error: unknown option: unexpected");
  expect(extra.stdout).toContain("help: agypeer");
  const mode = await run(["--mode", "yolo"]);
  expect(mode.exitCode).toBe(2);
  expect(mode.stdout).toContain("error: --mode must be one of default|accept-edits|auto|plan");
});

test("a signed-out agy stops before launch with the sign-in instruction and no usage noise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-cli-"));
  temps.push(dir);
  const fake = join(dir, "agy");
  // The exact output agy 1.5.12 prints on the signed-out Studio.
  await writeFile(fake, "#!/bin/sh\necho 'Fetching available models...'\necho 'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.' >&2\nexit 1\n", { mode: 0o755 });
  const result = await run(["start", "probe", dir, "--agy", fake], { HOME: dir });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("error: Antigravity is signed out on this machine; run `agy` once in a terminal to sign in, then retry");
  expect(result.stdout).not.toContain("help:");
});
