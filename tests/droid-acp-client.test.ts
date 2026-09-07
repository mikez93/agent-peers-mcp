import { expect, test } from "bun:test";

import {
  DroidAcpClient,
  type AcpLineTransport,
} from "../shared/droid-acp-client.ts";

class FakeTransport implements AcpLineTransport {
  readonly closed = new Promise<number>(() => {});
  readonly written: unknown[] = [];
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
    const line = JSON.stringify(message);
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: line, done: false });
    else this.lines.push(line);
  }

  async *readLines(): AsyncIterable<string> {
    while (true) {
      if (this.lines.length > 0) {
        yield this.lines.shift()!;
        continue;
      }
      const item = await new Promise<IteratorResult<string>>((resolve) => this.waiters.push(resolve));
      if (item.done) return;
      yield item.value;
    }
  }

  close(): void {}
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
