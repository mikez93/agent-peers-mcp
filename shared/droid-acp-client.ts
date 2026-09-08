// Minimal ACP v1 client for a long-lived, stdio-hosted Factory Droid.
//
// The launcher is deliberately a client, not a terminal scraper: every frame
// is one newline-delimited JSON-RPC message and every turn targets one exact
// ACP session id.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type JsonRpcId = number | string;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface AcpLineTransport {
  readonly closed: Promise<number>;
  writeLine(line: string): Promise<void>;
  readLines(): AsyncIterable<string>;
  close(): void;
}

export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    sessionCapabilities?: { resume?: unknown };
    [key: string]: unknown;
  };
  agentInfo?: { name?: string; title?: string; version?: string };
  authMethods?: unknown[];
}

export interface AcpPromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

export class AcpRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "AcpRpcError";
  }
}

export class DroidAcpClient {
  readonly closed: Promise<number>;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private nextId = 1;
  private promptInFlight = false;
  private initialized = false;
  private readerFailure: Error | null = null;

  constructor(
    private readonly transport: AcpLineTransport,
    private readonly opts: {
      requestTimeoutMs?: number;
      onNotification?: (method: string, params: unknown) => void;
    } = {},
  ) {
    this.closed = transport.closed;
    void this.readLoop();
  }

  get isBusy(): boolean {
    return this.promptInFlight;
  }

  async initialize(): Promise<AcpInitializeResult> {
    if (this.initialized) throw new Error("ACP connection is already initialized");
    const result = await this.request("initialize", {
      protocolVersion: 1,
      // The headless wake client intentionally exposes no terminal, filesystem,
      // auth-terminal, or elicitation surface. Droid receives tools through MCP.
      clientCapabilities: {},
      clientInfo: {
        name: "agent-peers-droid",
        title: "Agent Peers Droid",
        version: "0.1.2",
      },
    }) as AcpInitializeResult;

    if (!result || result.protocolVersion !== 1) {
      throw new Error(`Factory Droid negotiated unsupported ACP protocol ${String(result?.protocolVersion)}`);
    }
    if (!result.agentCapabilities || typeof result.agentCapabilities !== "object") {
      throw new Error("Factory Droid initialize response omitted agentCapabilities");
    }
    this.initialized = true;
    return result;
  }

  async newSession(opts: { cwd: string; mcpServers: AcpMcpServer[] }): Promise<string> {
    this.requireInitialized();
    const result = await this.request("session/new", opts) as { sessionId?: unknown };
    if (typeof result?.sessionId !== "string" || result.sessionId.length === 0) {
      throw new Error("Factory Droid session/new response omitted sessionId");
    }
    return result.sessionId;
  }

  async resumeSession(opts: {
    sessionId: string;
    cwd: string;
    mcpServers: AcpMcpServer[];
    capabilities: AcpInitializeResult["agentCapabilities"];
  }): Promise<string> {
    this.requireInitialized();
    if (opts.capabilities.loadSession !== true) {
      throw new Error("Factory Droid does not advertise ACP loadSession support");
    }
    if (!opts.capabilities.sessionCapabilities?.resume) {
      throw new Error("Factory Droid does not advertise ACP session/resume");
    }
    await this.request("session/resume", {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      mcpServers: opts.mcpServers,
    });
    return opts.sessionId;
  }

  async prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    this.requireInitialized();
    if (this.promptInFlight) throw new Error("Factory Droid ACP session is busy");
    this.promptInFlight = true;
    try {
      return await this.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }, null) as AcpPromptResult;
    } finally {
      this.promptInFlight = false;
    }
  }

  cancel(sessionId: string): Promise<void> {
    return this.notify("session/cancel", { sessionId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    this.requireInitialized();
    await this.request("session/set_config_option", { sessionId, configId, value });
  }

  close(): void {
    this.transport.close();
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("ACP connection has not been initialized");
    if (this.readerFailure) throw this.readerFailure;
  }

  private async request(
    method: string,
    params: unknown,
    timeoutMs: number | null = this.opts.requestTimeoutMs ?? 30_000,
  ): Promise<unknown> {
    if (this.readerFailure) throw this.readerFailure;
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    try {
      await this.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.pending.delete(id);
      throw error;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        response,
        ...(timeoutMs === null ? [] : [new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
        })]),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  private notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: "2.0", method, params });
  }

  private async send(message: unknown): Promise<void> {
    await this.transport.writeLine(JSON.stringify(message));
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const line of this.transport.readLines()) {
        if (!line.trim()) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          throw new Error("Factory Droid emitted a non-JSON ACP stdout line");
        }
        await this.handleMessage(message);
      }
      throw new Error("Factory Droid ACP stdout closed");
    } catch (error) {
      this.readerFailure = error instanceof Error ? error : new Error(String(error));
      for (const pending of this.pending.values()) pending.reject(this.readerFailure);
      this.pending.clear();
      // A broken reader cannot service another wake, even if Droid itself is
      // still running. Terminating the transport also releases the launcher's
      // idle wait on `closed` so it can retire its wakeability claim.
      this.transport.close();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== "object") throw new Error("Factory Droid emitted an invalid ACP message");
    const rpc = message as Partial<JsonRpcResponse & JsonRpcRequest>;
    if (rpc.jsonrpc !== "2.0") throw new Error("Factory Droid emitted an unsupported JSON-RPC version");

    if (rpc.id !== undefined && typeof rpc.method === "string") {
      await this.handleServerRequest(rpc as JsonRpcRequest);
      return;
    }
    if (rpc.id !== undefined) {
      const pending = this.pending.get(rpc.id);
      if (!pending) return;
      if (rpc.error) {
        pending.reject(new AcpRpcError(rpc.error.message || "Factory Droid ACP request failed", rpc.error.code));
      } else {
        pending.resolve(rpc.result);
      }
      return;
    }
    if (typeof rpc.method === "string") this.opts.onNotification?.(rpc.method, rpc.params);
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    // The managed wake path has no human present. Permit only the six local
    // Agent Peers MCP operations that make the collaboration plane work, and
    // only for this invocation. Every filesystem, shell, browser, connector,
    // and unknown tool remains denied; elicitation also fails closed.
    if (request.method === "session/request_permission") {
      const optionId = allowedAgentPeersPermissionOption(request.params);
      await this.send({
        jsonrpc: "2.0",
        id: request.id,
        result: optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    if (request.method === "elicitation/create") {
      await this.send({ jsonrpc: "2.0", id: request.id, result: { action: "decline" } });
      return;
    }
    await this.send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Client method is not available in headless wake mode" },
    });
  }
}

const AGENT_PEERS_TOOL_TITLES = new Set([
  "agent-peers___list_peers",
  "agent-peers___send_message",
  "agent-peers___set_summary",
  "agent-peers___check_messages",
  "agent-peers___wait_for_peer_messages",
  "agent-peers___rename_peer",
]);

function allowedAgentPeersPermissionOption(params: unknown): string | null {
  if (!params || typeof params !== "object") return null;
  const value = params as {
    toolCall?: { title?: unknown };
    options?: Array<{ optionId?: unknown; kind?: unknown }>;
  };
  if (typeof value.toolCall?.title !== "string" || !AGENT_PEERS_TOOL_TITLES.has(value.toolCall.title)) return null;
  const allowOnce = value.options?.find((option) =>
    option.kind === "allow_once" && typeof option.optionId === "string" && option.optionId.length > 0
  );
  return typeof allowOnce?.optionId === "string" ? allowOnce.optionId : null;
}

export function spawnDroidAcpTransport(opts: {
  cwd: string;
  droidCommand?: string;
  env?: NodeJS.ProcessEnv;
  onStderr?: (chunk: string) => void;
  shutdownGraceMs?: number;
}): AcpLineTransport {
  const child = spawn(opts.droidCommand ?? "droid", ["exec", "--output-format", "acp"], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new ChildProcessAcpTransport(child, opts.onStderr, opts.shutdownGraceMs);
}

class ChildProcessAcpTransport implements AcpLineTransport {
  readonly closed: Promise<number>;
  private closedByClient = false;
  private exited = false;
  private forceKill: ReturnType<typeof setTimeout> | undefined;
  private processError: Error | undefined;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    onStderr?: (chunk: string) => void,
    private readonly shutdownGraceMs = 2_000,
  ) {
    this.closed = new Promise<number>((resolve) => {
      const finish = (code: number) => {
        this.exited = true;
        if (this.forceKill) clearTimeout(this.forceKill);
        resolve(code);
      };
      child.once("exit", (code, signal) => finish(code ?? (signal ? 1 : 0)));
      child.on("error", (error) => {
        this.processError = error;
        // Failed spawns never emit `exit`. A kill error for an existing child
        // is not proof that it exited; keep waiting for the real exit event.
        if (child.pid === undefined) finish(1);
      });
    });
    // An EPIPE can accompany the write callback's error when Droid exits.
    // Keep it from becoming an uncaught EventEmitter error.
    child.stdin.on("error", (error) => { this.processError = error; });
    if (onStderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => onStderr(chunk));
    } else {
      child.stderr.resume();
    }
  }

  async writeLine(line: string): Promise<void> {
    if (this.processError) throw this.processError;
    if (this.closedByClient || this.exited || this.child.stdin.destroyed) throw new Error("Factory Droid ACP stdin is closed");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${line}\n`, (error) => error ? reject(error) : resolve());
    });
  }

  async *readLines(): AsyncIterable<string> {
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    for await (const line of lines) yield line;
  }

  close(): void {
    if (this.closedByClient) return;
    this.closedByClient = true;
    this.child.stdin.end();
    if (!this.exited && this.child.pid !== undefined) {
      this.child.kill("SIGTERM");
      this.forceKill = setTimeout(() => {
        if (!this.exited) this.child.kill("SIGKILL");
      }, this.shutdownGraceMs);
    }
  }
}
