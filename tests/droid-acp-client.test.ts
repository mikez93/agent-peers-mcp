import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DroidAcpClient,
  spawnDroidAcpTransport,
  type AcpLineTransport,
} from "../shared/droid-acp-client.ts";

class FakeTransport implements AcpLineTransport {
  private resolveClosed!: (code: number) => void;
  readonly closed = new Promise<number>((resolve) => { this.resolveClosed = resolve; });
  readonly written: unknown[] = [];
  closeCount = 0;
  private outputEnded = false;
  private lines: string[] = [];
  private waiters: Array<(value: IteratorResult<string>) => void> = [];

  constructor(private readonly respond: (message: any, transport: FakeTransport) => void) {}

  async writeLine(line: string): Promise<void> {
    expect(line.endsWith("\n")).toBe(false);
    const message = JSON.parse(line);
    this.written.push(message);
    this.respond(message, this);
  }

  push(message: unknown): void {
    this.pushLine(JSON.stringify(message));
  }

  pushLine(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: line, done: false });
    else this.lines.push(line);
  }

  endOutput(): void {
    this.outputEnded = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *readLines(): AsyncIterable<string> {
    while (true) {
      if (this.lines.length > 0) {
        yield this.lines.shift()!;
        continue;
      }
      if (this.outputEnded) return;
      const item = await new Promise<IteratorResult<string>>((resolve) => this.waiters.push(resolve));
      if (item.done) return;
      yield item.value;
    }
  }

  close(): void {
    this.closeCount++;
    this.endOutput();
    this.resolveClosed(1);
  }
}

function responseFor(message: any, result: unknown): unknown {
  return { jsonrpc: "2.0", id: message.id, result };
}

test("ACP client initializes v1, creates a session, and sends newline JSON-RPC prompt content", async () => {
  let promptResolve!: () => void;
  const promptGate = new Promise<void>((resolve) => { promptResolve = resolve; });
  const transport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.push(responseFor(message, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    }));
    if (message.method === "session/new") fake.push(responseFor(message, { sessionId: "session-exact" }));
    if (message.method === "session/prompt") void promptGate.then(() => fake.push(responseFor(message, { stopReason: "end_turn" })));
  });
  const client = new DroidAcpClient(transport);
  await client.initialize();
  const sessionId = await client.newSession({ cwd: "/repo", mcpServers: [] });
  const prompt = client.prompt(sessionId, "bodyless wake");
  expect(client.isBusy).toBe(true);
  promptResolve();
  await prompt;
  expect(client.isBusy).toBe(false);

  expect(transport.written).toEqual([
    expect.objectContaining({ method: "initialize", params: expect.objectContaining({ protocolVersion: 1, clientCapabilities: {} }) }),
    expect.objectContaining({ method: "session/new", params: { cwd: "/repo", mcpServers: [] } }),
    expect.objectContaining({ method: "session/prompt", params: { sessionId: "session-exact", prompt: [{ type: "text", text: "bodyless wake" }] } }),
  ]);
});

test("ACP client resumes only the exact requested session when capability is advertised", async () => {
  const transport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.push(responseFor(message, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    }));
    if (message.method === "session/resume") fake.push(responseFor(message, null));
  });
  const client = new DroidAcpClient(transport);
  const init = await client.initialize();
  expect(await client.resumeSession({
    sessionId: "factory-session-123",
    cwd: "/repo",
    mcpServers: [],
    capabilities: init.agentCapabilities,
  })).toBe("factory-session-123");
  expect(transport.written.at(-1)).toEqual(expect.objectContaining({
    method: "session/resume",
    params: { sessionId: "factory-session-123", cwd: "/repo", mcpServers: [] },
  }));
});

test("headless ACP client allows only the six Agent Peers tools once and fails closed on other requests", async () => {
  const transport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.push(responseFor(message, {
      protocolVersion: 1,
      agentCapabilities: {},
    }));
  });
  const client = new DroidAcpClient(transport);
  await client.initialize();
  const options = [
    { optionId: "once", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always", kind: "allow_always" },
  ];
  const allowed = [
    "list_peers", "send_message", "set_summary", "check_messages",
    "wait_for_peer_messages", "rename_peer",
  ];
  allowed.forEach((tool, index) => transport.push({
    jsonrpc: "2.0", id: 40 + index, method: "session/request_permission",
    params: { toolCall: { title: `agent-peers___${tool}` }, options },
  }));
  transport.push({
    jsonrpc: "2.0", id: 50, method: "session/request_permission",
    params: { toolCall: { title: "Execute" }, options },
  });
  transport.push({ jsonrpc: "2.0", id: 51, method: "elicitation/create", params: {} });
  transport.push({ jsonrpc: "2.0", id: 52, method: "terminal/create", params: {} });
  await Bun.sleep(0);
  expect(transport.written.slice(-9)).toEqual([
    ...allowed.map((_, index) => ({
      jsonrpc: "2.0", id: 40 + index, result: { outcome: { outcome: "selected", optionId: "once" } },
    })),
    { jsonrpc: "2.0", id: 50, result: { outcome: { outcome: "cancelled" } } },
    { jsonrpc: "2.0", id: 51, result: { action: "decline" } },
    { jsonrpc: "2.0", id: 52, error: { code: -32601, message: "Client method is not available in headless wake mode" } },
  ]);
});

test("ACP client rejects a non-v1 handshake and missing resume capability", async () => {
  const bad = new FakeTransport((message, fake) => fake.push(responseFor(message, {
    protocolVersion: 2,
    agentCapabilities: {},
  })));
  await expect(new DroidAcpClient(bad).initialize()).rejects.toThrow("unsupported ACP protocol 2");

  const transport = new FakeTransport((message, fake) => fake.push(responseFor(message, {
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  })));
  const client = new DroidAcpClient(transport);
  const init = await client.initialize();
  await expect(client.resumeSession({
    sessionId: "s",
    cwd: "/repo",
    mcpServers: [],
    capabilities: init.agentCapabilities,
  })).rejects.toThrow("does not advertise ACP session/resume");
});

test("malformed ACP stdout while idle closes the transport and prevents future prompts", async () => {
  const transport = new FakeTransport((message, fake) => fake.push(responseFor(message, {
    protocolVersion: 1, agentCapabilities: {},
  })));
  const client = new DroidAcpClient(transport);
  await client.initialize();
  transport.pushLine("unexpected stdout banner");
  expect(await client.closed).toBe(1);
  expect(transport.closeCount).toBe(1);
  await expect(client.prompt("session", "wake")).rejects.toThrow("non-JSON ACP stdout");
  expect(transport.written).toHaveLength(1);
});

test("terminal ACP reader failure rejects an unbounded in-flight prompt and closes the transport", async () => {
  const transport = new FakeTransport((message, fake) => {
    if (message.method === "initialize") fake.push(responseFor(message, {
      protocolVersion: 1, agentCapabilities: {},
    }));
  });
  const client = new DroidAcpClient(transport);
  await client.initialize();
  const prompt = client.prompt("session", "wake");
  const outcome = prompt.then(() => null, (error: Error) => error);
  transport.pushLine("{");
  expect((await outcome)?.message).toContain("non-JSON ACP stdout");
  await client.closed;
  expect(client.isBusy).toBe(false);
  expect(transport.closeCount).toBe(1);
});

test("ACP stdout EOF retires an otherwise idle transport", async () => {
  const transport = new FakeTransport((message, fake) => fake.push(responseFor(message, {
    protocolVersion: 1, agentCapabilities: {},
  })));
  const client = new DroidAcpClient(transport);
  await client.initialize();
  transport.endOutput();
  await client.closed;
  expect(transport.closeCount).toBe(1);
  await expect(client.prompt("session", "wake")).rejects.toThrow("ACP stdout closed");
});

test("transport close kills a real SIGTERM-ignoring child and repeated close preserves the deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "droid-acp-shutdown-"));
  const command = join(dir, "droid-fixture");
  writeFileSync(command, `#!${process.execPath}
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
process.stderr.write(String(process.pid) + "\\n");
`, { mode: 0o700 });
  let ready!: (pid: number) => void;
  const started = new Promise<number>((resolve) => { ready = resolve; });
  const transport = spawnDroidAcpTransport({
    cwd: dir,
    droidCommand: command,
    shutdownGraceMs: 50,
    onStderr: (chunk) => ready(Number(chunk.trim())),
  });
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pid = await Promise.race([
      started,
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error("test child did not become ready")), 2_000);
      }),
    ]);
    clearTimeout(startupTimer);
    expect(Number.isInteger(pid)).toBe(true);
    transport.close();
    transport.close();
    expect(await transport.closed).toBe(1);
    // `closed` must mean the process actually exited, not merely that a signal
    // was sent. Otherwise launcher process.exit can strand the Droid child.
    expect(() => process.kill(pid, 0)).toThrow();
    transport.close();
    await expect(transport.writeLine("{}")).rejects.toThrow();
  } finally {
    clearTimeout(startupTimer);
    transport.close();
    await transport.closed;
    rmSync(dir, { recursive: true, force: true });
  }
}, 5_000);

test("failed child spawn deterministically settles closed and rejects ACP initialization", async () => {
  const transport = spawnDroidAcpTransport({
    cwd: tmpdir(),
    droidCommand: `/missing-droid-command-${process.pid}`,
  });
  const client = new DroidAcpClient(transport);
  const rejected = expect(client.initialize()).rejects.toThrow();
  expect(await client.closed).toBe(1);
  await rejected;
  client.close();
  client.close();
}, 5_000);
