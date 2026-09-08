import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";

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
    expect(await run(flag)).toEqual({ exitCode: 0, stdout: "0.2.0\n", stderr: "" });
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
  expect(result.stdout).toContain("help: droidpeer");
});

test("bare and native-style resume invocations reach the intended ACP session method", async () => {
  const root = await mkdtemp(join(tmpdir(), "droid-cli-syntax-"));
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const fixture = join(import.meta.dir, "fixtures", "droid-cli-syntax-agent.ts");
  await symlink(fixture, join(root, "droid"));
  try {
    for (const [executable, args, expected] of [
      [entry, [], "session/new:new"],
      [entry, ["--resume", sessionId], `session/resume:${sessionId}`],
      [entry, ["-r", sessionId], `session/resume:${sessionId}`],
      [entry, ["resume", sessionId], `session/resume:${sessionId}`],
      [join(import.meta.dir, "..", "bin", "droid-peer"), ["--resume", sessionId], `session/resume:${sessionId}`],
    ] as Array<[string, string[], string]>) {
      const command = executable === entry ? [process.execPath, entry, ...args] : ["bash", executable, ...args];
      const child = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe", env: {
        PATH: `${root}:${process.env.PATH ?? ""}`,
        AGENT_PEERS_DROID_STATE_DIR: join(root, "state"),
      } });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1); // The fixture deliberately fails at session dispatch.
      expect(stdout).toContain(`TEST_SESSION:${expected}`);
      expect(stdout).not.toContain("expected start or resume");
      expect(stderr).toBe("");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
