import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { initDb } from "../broker.ts";
import { createHermesAttachmentBridge } from "../shared/hermes-runtime-attachment.ts";
import type { HermesGuiLifecycleBridge } from "../shared/hermes-gui-lifecycle-bridge.ts";
import type { WakeRequest } from "../shared/hermes-conversation-wake.ts";

const backend_id = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721";
const attachment_id = "347a20b0-34c9-456b-a0aa-43407b7b3b5f";
let root: string, home: string, path: string;
let server: ReturnType<typeof Bun.serve>;
let descriptor: any;
let requests: any[], sockets: Set<any>;
let handler: (ws: any, request: any) => void;
let fetchMode = "";
let connections: number;
const bridges: HermesGuiLifecycleBridge[] = [];
const clients: Client[] = [];
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "attachment-test-")));
  home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
  path = join(root, "attachment.json");
  chmodSync(root, 0o700);
  requests = []; sockets = new Set(); connections = 0; fetchMode = "";
  handler = (ws, request) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id,
    result: request.method === "gateway.ping" ? { ok: true, home, backend_id }
      : request.method === "session.lifecycle_snapshot" ? snapshot()
      : { attempt_id: request.params.attempt_id, attempt_sequence: request.params.attempt_sequence,
        context: request.params.context.platform === "cli"
          ? { ...request.params.context, ui_session_id: null } : request.params.context,
        state: request.method === "session.wake_admit" ? "accepted" : "started" } }));
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      connections++;
      const url = new URL(req.url);
      // ASGI close4401/4403 before accept is an HTTP403 upgrade refusal.
      if (fetchMode === "auth-refusal" || fetchMode === "attachment-refusal") return new Response(null, { status: 403 });
      if (fetchMode === "redirect") return Response.redirect(`http://127.0.0.1:${server.port}/leaked`, 302);
      if (url.pathname !== "/api/ws" || url.searchParams.get("hermes_attachment") !== attachment_id
          || url.searchParams.get(descriptor.auth.query_parameter) !== descriptor.auth.value) return new Response(null, { status: 403 });
      if (server.upgrade(req, { data: undefined })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message(ws, data) {
        const request = JSON.parse(String(data)); requests.push(request);
        handler(ws, request);
      },
    },
  });
  descriptor = { version: 1, home, backend_id, attachment_id,
    endpoint: `ws://127.0.0.1:${server.port}/api/ws?hermes_attachment=${attachment_id}`,
    auth: { query_parameter: "token", value: "fixture-only-secret-do-not-log" } };
  save();
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const bridge of bridges.splice(0)) await bridge.close();
  await until(() => sockets.size === 0);
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
});
function save() { writeFileSync(path, JSON.stringify(descriptor), { mode: 0o600 }); }
function snapshot() {
  return { home, backend_id, observed_at: Date.now(), inventory_complete: true,
    sessions: [], terminal: [], unknown_runtime_ids: [] };
}
function wakeRequest(): WakeRequest {
  return { attempt_id: "a28d2451-b3dc-4309-9bad-d19a0f17db04", attempt_sequence: 1,
    peer_id: "peer-native", context: { home, backend_id, conversation_id: "native",
      session_id: "native", platform: "cli" }, binding_generation: 2,
    expected_lifecycle_generation: 3, resume: false, queued: true, hidden: true,
    notice: "Check pending mail." };
}
async function connect(signal = new AbortController().signal) {
  const bridge = await createHermesAttachmentBridge(path, { home, backend_id }, signal);
  bridges.push(bridge);
  return bridge;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

test.each(["token", "internal"])("actual loopback %s auth, ping first, snapshot only, descriptor survives close/respawn", async parameter => {
  descriptor.auth.query_parameter = parameter; save();
  const before = readFileSync(path);
  const bridge = await connect();
  expect(requests.map(r => r.method)).toEqual(["gateway.ping"]);
  expect((await bridge.inventory([], new AbortController().signal)).inventory_complete).toBe(true);
  expect(requests[1]).toMatchObject({ method: "session.lifecycle_snapshot", params: { conversation_ids: [] } });
  expect("profile" in requests[1].params).toBe(false);
  await bridge.close(); await bridge.close();
  await until(() => sockets.size === 0);
  expect(readFileSync(path)).toEqual(before);
  await connect();
  expect(requests.map(r => r.method)).toEqual(["gateway.ping", "session.lifecycle_snapshot", "gateway.ping"]);
});

test("actual attachment forwards exact admit/reconcile requests and correlated receipts", async () => {
  const bridge = await connect(), request = wakeRequest();
  expect(await bridge.admit(request, new AbortController().signal)).toMatchObject({ state: "accepted" });
  expect(await bridge.reconcile(request, new AbortController().signal)).toMatchObject({ state: "started" });
  expect(requests.slice(1).map(row => row.method)).toEqual(["session.wake_admit", "session.wake_reconcile"]);
  expect(requests.slice(1).map(row => row.params)).toEqual([request, request]);
  expect(existsSync(path)).toBe(true);
});

test.each(["mode", "parent", "symlink", "hardlink", "directory", "relative", "missing", "oversize", "json", "scope", "backend", "version", "credential"])(
  "refuses invalid %s descriptor before any connection", async kind => {
    if (kind === "mode") chmodSync(path, 0o644);
    if (kind === "parent") chmodSync(root, 0o755);
    if (kind === "symlink") { symlinkSync(path, join(root, "link")); path = join(root, "link"); }
    if (kind === "hardlink") linkSync(path, join(root, "link"));
    if (kind === "directory") path = home;
    if (kind === "relative") path = "attachment.json";
    if (kind === "missing") path = join(root, "missing");
    if (kind === "oversize") writeFileSync(path, " ".repeat(16_385));
    if (kind === "json") writeFileSync(path, "{fixture-secret");
    if (kind === "scope") { descriptor.home += "/other"; save(); }
    if (kind === "backend") { descriptor.backend_id += "bad"; save(); }
    if (kind === "version") { descriptor.version = 2; save(); }
    if (kind === "credential") { descriptor.auth.query_parameter = "password"; save(); }
    await expect(connect()).rejects.toThrow("hermes_attachment_invalid_reference");
    expect(connections).toBe(0);
  });

test.each(["localhost", "127.1", "2130706433", "127.0.0.1.example.com", "192.0.2.1",
  "user@127.0.0.1", "127.000.0.1"])("rejects nonliteral loopback endpoint %s", async host => {
  descriptor.endpoint = `ws://${host}:${server.port}/api/ws?hermes_attachment=${attachment_id}`; save();
  await expect(connect()).rejects.toThrow("invalid_reference"); expect(connections).toBe(0);
});
test.each(["&token=leak", "&hermes_attachment=duplicate", "#fragment", "&extra=1"])("rejects unsafe endpoint suffix %s", async suffix => {
  descriptor.endpoint += suffix; save();
  await expect(connect()).rejects.toThrow("invalid_reference"); expect(connections).toBe(0);
});

test.each(["scope", "auth-refusal", "attachment-refusal", "4036", "malformed", "redirect"])("failed %s handshake closes socket and redacts errors", async mode => {
  fetchMode = mode;
  if (mode === "scope") handler = (ws, r) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { ok: true, home: "wrong", backend_id } }));
  if (mode === "4036") handler = (ws, r) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: 4036, message: descriptor.auth.value } }));
  if (mode === "malformed") handler = ws => ws.send(descriptor.auth.value);
  const error = await connect().then(() => null, error => error as Error);
  expect(error?.message).toBe("hermes_attachment_handshake_failed");
  expect(String(error?.stack)).not.toContain(descriptor.auth.value);
  expect(error?.cause).toBeUndefined();
  await until(() => sockets.size === 0);
  expect(existsSync(path)).toBe(true);
  if (mode === "redirect") expect(connections).toBe(1); // Never follow a credential-bearing redirect.
});

test("abort before dial and during ping never leaks a live attachment", async () => {
  const first = new AbortController(); first.abort();
  await expect(connect(first.signal)).rejects.toThrow("cancelled");
  expect(connections).toBe(0);
  handler = () => {};
  const second = new AbortController(), connecting = connect(second.signal);
  await until(() => requests.length === 1);
  second.abort("fixture-only-secret-do-not-log");
  await expect(connecting).rejects.toThrow("handshake_failed");
  await until(() => sockets.size === 0);
});

test("RPC correlation ignores events/wrong IDs and aborted responses cannot satisfy another call", async () => {
  const bridge = await connect();
  handler = () => {};
  const abort = new AbortController(), a = bridge.inventory(["a"], abort.signal);
  await until(() => requests.length === 2);
  abort.abort();
  expect((await a).inventory_complete).toBe(false);
  const b = bridge.inventory([], new AbortController().signal);
  await until(() => requests.length === 3);
  const ws = [...sockets][0], old = requests[1].id, current = requests[2].id;
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "gateway.ready", params: snapshot() }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: old, result: { bad: true } }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 12345, result: { bad: true } }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: current, result: snapshot() }));
  expect((await b).inventory_complete).toBe(true);
  const pending = bridge.inventory([], new AbortController().signal);
  await until(() => requests.length === 4);
  await bridge.close();
  expect((await pending).inventory_complete).toBe(false);
  expect((await bridge.inventory([], new AbortController().signal)).inventory_complete).toBe(false);
  expect(requests.length).toBe(4);
});

test("bounded handshake without ready or ping response closes its socket", async () => {
  handler = () => {};
  const started = Date.now();
  await expect(connect()).rejects.toThrow("handshake_failed");
  expect(Date.now() - started).toBeLessThan(8_000);
  await until(() => sockets.size === 0);
}, 10_000);

test("post-handshake snapshot deadline settles without closing or acknowledging a chat", async () => {
  const bridge = await connect();
  handler = () => {};
  const started = Date.now();
  expect((await bridge.inventory([], new AbortController().signal)).inventory_complete).toBe(false);
  expect(Date.now() - started).toBeLessThan(8_000);
  expect(requests.map(r => r.method)).toEqual(["gateway.ping", "session.lifecycle_snapshot"]);
  expect(existsSync(path)).toBe(true);
}, 10_000);

test.each(["rpc", "oversize"])("unavailable %s snapshot cannot fabricate lifecycle authority", async kind => {
  const bridge = await connect();
  handler = (ws, r) => {
    if (kind === "rpc") ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: 5036, message: descriptor.auth.value } }));
    else ws.send(" ".repeat(4_194_305));
  };
  expect((await bridge.inventory([], new AbortController().signal)).inventory_complete).toBe(false);
  expect(existsSync(path)).toBe(true);
});

test("remote socket loss settles pending snapshot without fabricating authority", async () => {
  // A separate disposable process avoids Bun1.3.14's server-side close counter
  // bug (pendingWebSockets remains1 and stop() never resolves after ws.close).
  const child = Bun.spawn([process.execPath, "-e", `
    const server = Bun.serve({ hostname:"127.0.0.1",port:0,
      fetch(req,s) { if(s.upgrade(req)) return; return new Response(null,{status:403}); },
      websocket:{ message(ws,raw) { const r=JSON.parse(String(raw));
        if(r.method==="gateway.ping") ws.send(JSON.stringify({jsonrpc:"2.0",id:r.id,
          result:{ok:true,home:process.env.FIXTURE_HOME,backend_id:process.env.FIXTURE_BACKEND}}));
        else process.exit(0);
      }} });
    console.log(server.port);
  `], { env: { FIXTURE_HOME: home, FIXTURE_BACKEND: backend_id }, stdout: "pipe", stderr: "ignore" });
  try {
    const reader = child.stdout.getReader();
    const chunk = await reader.read(); reader.releaseLock();
    const port = Number(new TextDecoder().decode(chunk.value).trim());
    expect(port).toBeGreaterThan(0);
    descriptor.endpoint = `ws://127.0.0.1:${port}/api/ws?hermes_attachment=${attachment_id}`; save();
    const bridge = await connect();
    expect((await bridge.inventory([], new AbortController().signal)).inventory_complete).toBe(false);
    expect(await child.exited).toBe(0);
    expect(existsSync(path)).toBe(true);
  } finally { if (child.exitCode === null) child.kill(); await child.exited; }
});

test.each(["missing-reference", "cancel-ping", "disabled"])("standard launcher %s does not fall back or leak a claim", async mode => {
  const db = initDb(join(root, "broker.db"));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(import.meta.dir, "../hermes-server.ts")], cwd: root, stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", AGENT_PEERS_ENABLED: mode === "disabled" ? "0" : "1",
      AGENT_PEERS_HERMES_V2: "1", AGENT_PEERS_HERMES_HOME: home, AGENT_PEERS_HERMES_BACKEND_ID: backend_id,
      AGENT_PEERS_HERMES_ATTACHMENT: mode === "cancel-ping" ? path : join(root, "missing"),
      AGENT_PEERS_DB: join(root, "broker.db"), AGENT_PEERS_STATE_DIR: join(root, "inboxes"), AGENT_PEERS_CWD: root },
  });
  const client = new Client({ name: "attachment-startup-fixture", version: "1" }); clients.push(client);
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  handler = () => {};
  try {
    // Observe rejection from launch time so cancellation never becomes an
    // unhandled rejection while we wait for the first actual ping.
    const connected = client.connect(transport, { timeout: 5_000 }).then(() => true, () => false);
    if (mode === "cancel-ping") {
      await until(() => requests.length === 1);
      process.kill(transport.pid!, "SIGTERM");
    }
    expect(await connected).toBe(mode === "disabled");
    if (mode === "disabled") {
      expect((await client.listTools()).tools).toEqual([]);
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name='hermes_adapter_processes'").get()).toBeNull();
    } else {
      expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM hermes_adapter_processes").get()!.n).toBe(0);
    }
    expect(connections).toBe(mode === "cancel-ping" ? 1 : 0);
    expect(existsSync(path)).toBe(true);
  } finally {
    await client.close(); await transport.close(); db.close();
    expect(stderr).not.toContain(descriptor.auth.value);
    expect(stderr).not.toContain(descriptor.endpoint);
  }
});

test("real standard stdio launcher consumes attachment after gates, no synthetic bridge injection", async () => {
  const db = initDb(join(root, "broker.db"));
  try {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [join(import.meta.dir, "../hermes-server.ts")], cwd: root, stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", AGENT_PEERS_ENABLED: "1", AGENT_PEERS_HERMES_V2: "1",
        AGENT_PEERS_HERMES_HOME: home, AGENT_PEERS_HERMES_BACKEND_ID: backend_id,
        AGENT_PEERS_HERMES_ATTACHMENT: path, AGENT_PEERS_DB: join(root, "broker.db"),
        AGENT_PEERS_STATE_DIR: join(root, "inboxes"), AGENT_PEERS_CWD: root },
    });
    const client = new Client({ name: "attachment-fixture", version: "1" }); clients.push(client);
    await client.connect(transport, { timeout: 5_000 });
    expect((await client.listTools()).tools.length).toBe(6);
    expect(requests.slice(0, 2).map(r => r.method)).toEqual(["gateway.ping", "session.lifecycle_snapshot"]);
    await client.close(); await transport.close();
    await until(() => sockets.size === 0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM hermes_adapter_processes").get()!.n).toBe(0);
    expect(existsSync(path)).toBe(true);
  } finally { db.close(); }
});
