// Kepler9777/9779: host-issued private reference, never port/token discovery.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { HermesGuiLifecycleBridge, type HermesLifecycleRpc } from "./hermes-gui-lifecycle-bridge.ts";

type Scope = Readonly<{ home: string; backend_id: string }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (reason: string) => new Error(`hermes_attachment_${reason}`);

function authenticatedUrl(path: string, scope: Scope): URL {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path) || realpathSync(path) !== path) throw fail("path");
    const parent = dirname(path), directory = lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!()
        || (directory.mode & 0o7777) !== 0o700 || realpathSync(parent) !== parent) throw fail("parent");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd), named = lstatSync(path), afterParent = lstatSync(parent);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!()
        || (stat.mode & 0o7777) !== 0o600 || stat.size < 1 || stat.size > 16_384
        || named.isSymbolicLink() || named.ino !== stat.ino || named.dev !== stat.dev
        || directory.ino !== afterParent.ino || directory.dev !== afterParent.dev) throw fail("file");
    const buffer = Buffer.alloc(16_385);
    let length = 0, read = 0;
    do { read = readSync(fd, buffer, length, buffer.length - length, null); length += read; }
    while (read && length < buffer.length);
    if (length !== stat.size) throw fail("size");
    const value = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (!value || value.version !== 1 || value.home !== scope.home || value.backend_id !== scope.backend_id
        || !UUID.test(value.attachment_id) || typeof value.endpoint !== "string"
        || !value.auth || !["token", "internal"].includes(value.auth.query_parameter)
        || typeof value.auth.value !== "string" || !value.auth.value || value.auth.value.length > 8192
        || /[\x00-\x1f\x7f]/.test(value.auth.value)) throw fail("descriptor");
    // Validate the literal spelling before URL normalization can turn aliases
    // such as 127.1 or integer IPv4 into an apparently trusted loopback address.
    const match = /^ws:\/\/(\[::1\]|[0-9.]+):([1-9][0-9]{0,4})\/api\/ws\?hermes_attachment=([0-9a-f-]+)$/.exec(value.endpoint);
    if (!match || Number(match[2]) > 65535 || match[3] !== value.attachment_id
        || match[1] !== "[::1]" && !(isIP(match[1]!) === 4 && match[1]!.startsWith("127."))) throw fail("endpoint");
    const url = new URL(value.endpoint);
    url.searchParams.set(value.auth.query_parameter, value.auth.value);
    return url;
  } catch {
    // Filesystem/JSON/URL errors may contain private paths or descriptor text.
    throw fail("invalid_reference");
  } finally { if (fd !== undefined) closeSync(fd); }
}

class AttachmentRpc implements HermesLifecycleRpc {
  private ws?: WebSocket;
  private stopped = false;
  private nextId = 1;
  private pending = new Map<number, (error?: Error, value?: unknown) => void>();
  private connecting?: (error?: Error) => void;

  async connect(url: URL, scope: Scope, signal: AbortSignal): Promise<void> {
    try {
      if (signal.aborted || this.stopped) throw fail("cancelled");
      await new Promise<void>((resolve, reject) => {
        const abort = () => finish(fail("cancelled"));
        const timer = setTimeout(() => finish(fail("connect_timeout")), 5_000);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          this.connecting = undefined;
          error ? reject(error) : resolve();
        };
        this.connecting = finish;
        signal.addEventListener("abort", abort, { once: true });
        // Do not reuse Codex's client: its error messages include the URL.
        try {
          const ws = this.ws = new WebSocket(url);
          ws.addEventListener("open", () => this.connecting?.(), { once: true });
          ws.addEventListener("error", () => this.disconnect(fail("connection_failed")));
          ws.addEventListener("close", () => this.disconnect(fail("connection_closed")));
          ws.addEventListener("message", event => this.message(event.data));
        } catch { finish(fail("connection_failed")); }
      });
      const ping = await this.call("gateway.ping", {}, signal) as Record<string, unknown> | null;
      if (!ping || ping.ok !== true || ping.home !== scope.home || ping.backend_id !== scope.backend_id) {
        throw fail("scope_mismatch");
      }
      if (signal.aborted || this.stopped) throw fail("cancelled");
    } catch {
      await this.close();
      throw fail("handshake_failed");
    }
  }

  private disconnect(error: Error): void {
    this.stopped = true;
    this.connecting?.(error);
    for (const finish of [...this.pending.values()]) finish(error);
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }

  private message(raw: unknown): void {
    try {
      if (typeof raw !== "string" || Buffer.byteLength(raw) > 4_194_304) throw fail("response");
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0") throw fail("response");
      if (!("id" in value)) return; // Never interpret global notifications as results.
      if (!Number.isSafeInteger(value.id)) throw fail("response");
      const finish = this.pending.get(value.id);
      if (!finish) return; // Aborted/late/unknown IDs cannot satisfy another call.
      if (("result" in value) === ("error" in value)) throw fail("response");
      if ("error" in value) {
        const code = value.error?.code;
        finish(fail(Number.isSafeInteger(code) ? `rpc_${code}` : "rpc_error"));
      } else finish(undefined, value.result);
    } catch { this.disconnect(fail("invalid_response")); }
  }

  private call(method: string, params: object, signal: AbortSignal): Promise<unknown> {
    if (this.stopped || signal.aborted || this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(fail("unavailable"));
    if (this.pending.size >= 128) return Promise.reject(fail("request_capacity"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => finish(fail("cancelled"));
      const timer = setTimeout(() => finish(fail("request_timeout")), 5_000);
      const finish = (error?: Error, value?: unknown) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve(value);
      };
      this.pending.set(id, finish);
      signal.addEventListener("abort", abort, { once: true });
      try { this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch { finish(fail("send_failed")); }
    });
  }

  request(method: "session.lifecycle_snapshot",
    params: Readonly<{ profile?: string; conversation_ids: readonly string[] }>, signal: AbortSignal): Promise<unknown> {
    if (method !== "session.lifecycle_snapshot" || params.profile !== undefined) return Promise.reject(fail("scope_refused"));
    return this.call(method, { conversation_ids: params.conversation_ids }, signal);
  }

  async close(): Promise<void> {
    if (!this.stopped || this.ws) this.disconnect(fail("closed"));
  }
}

export async function createHermesAttachmentBridge(path: string, scope: Scope, signal: AbortSignal): Promise<HermesGuiLifecycleBridge> {
  if (signal.aborted) throw fail("cancelled");
  scope = Object.freeze({ ...scope });
  const url = authenticatedUrl(path, scope);
  const rpc = new AttachmentRpc();
  // One deadline covers both the actual connection and first ping, no ready event.
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 5_000);
  try {
    await rpc.connect(url, scope, controller.signal);
    if (signal.aborted) { await rpc.close(); throw fail("cancelled"); }
    return new HermesGuiLifecycleBridge(scope, rpc);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
