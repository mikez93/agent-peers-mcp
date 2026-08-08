import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const children: Bun.Subprocess[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("kill-broker terminates only the health-reported listener, not connected clients", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-peers-kill-broker-"));
  tempDirs.push(dir);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const repo = resolve(import.meta.dir, "..");
  const broker = Bun.spawn([
    "bun", "-e",
    `import { startBroker } from ${JSON.stringify(join(repo, "broker.ts"))}; startBroker(${port}, ${JSON.stringify(join(dir, "broker.db"))}, ${JSON.stringify(join(dir, "secret"))});`,
  ], { cwd: repo, stdout: "ignore", stderr: "ignore" });
  children.push(broker);

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) break;
    } catch { /* starting */ }
    await Bun.sleep(50);
  }

  const connectedClient = Bun.spawn([
    "bun", "-e",
    `const socket = await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); await Bun.sleep(30000); socket.end();`,
  ], { stdout: "ignore", stderr: "ignore" });
  children.push(connectedClient);
  await Bun.sleep(100);

  const command = Bun.spawn(["bun", "cli.ts", "kill-broker"], {
    cwd: repo,
    env: { ...process.env, AGENT_PEERS_PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(command.stdout).text();
  expect(await command.exited).toBe(0);
  expect(output).toContain(`killed broker pid=${broker.pid}`);

  await Bun.sleep(100);
  expect(await broker.exited).toBe(0);
  expect(() => process.kill(connectedClient.pid, 0)).not.toThrow();
  expect(() => process.kill(broker.pid, 0)).toThrow();
});
