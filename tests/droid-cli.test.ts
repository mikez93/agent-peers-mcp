import { expect, test } from "bun:test";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "wakeable-droid.ts");

async function run(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", entry, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("version flags are bare fast-path output", async () => {
  for (const flag of ["-v", "-V", "--version"]) {
    expect(await run(flag)).toEqual({ exitCode: 0, stdout: "0.1.0\n", stderr: "" });
  }
});

test("help identifies the command and gives complete noninteractive examples", async () => {
  const result = await run("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("bin: ~/.local/bin/droidpeer");
  expect(result.stdout).toContain("droidpeer start reviewer ~/code/service");
  expect(result.stdout).toContain("droidpeer resume <session-id>");
});

test("unknown input is a structured usage error with exit code 2", async () => {
  const result = await run("start", "peer", "/tmp", "unexpected");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("error: unknown option: unexpected");
  expect(result.stdout).toContain("help: droidpeer start");
});
