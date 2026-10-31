// End to end: a real claude-server.ts process, a throwaway broker, and a fake
// Claude Code inbox socket. Proves that a session without the channel is
// woken through the socket, that channel sessions are left alone, and that a
// broken socket degrades to the rewake hook without losing mail.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBroker } from "../broker.ts";
import { createClient } from "../shared/broker-client.ts";

const PORT = 7931;
const dir = mkdtempSync(join(tmpdir(), "ap-claude-e2e-"));
const DB = join(dir, "broker.db");
const SECRET = join(dir, "secret");
const SERVER = join(import.meta.dir, "..", "claude-server.ts");
// The wrapper is named "claude" so the server sees it as its Claude process.
const WRAPPER = join(dir, "claude");
writeFileSync(WRAPPER, `#!/bin/sh\nbun "${SERVER}"\nexit $?\n`);
chmodSync(WRAPPER, 0o755);

let handle: ReturnType<typeof startBroker>;
let client: ReturnType<typeof createClient>;
let sender: { id: string; session_token: string };

beforeAll(async () => {
  handle = startBroker(PORT, DB, SECRET);
  client = createClient(`http://127.0.0.1:${PORT}`, readFileSync(SECRET, "utf8").trim());
  const reg = await client.register({ peer_type: "codex", pid: process.pid, cwd: "/tmp", git_root: null, tty: null, summary: "", name: "e2e-sender" });
  sender = { id: reg.id, session_token: reg.session_token };
});
afterAll(() => {
  clearInterval(handle.gcTimer);
  handle.server.stop(true);
  handle.db.close();
});

function fakeSocket(path: string): { lines: unknown[]; server: Server; ready: Promise<void> } {
  const lines: unknown[] = [];
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => { buf += d.toString(); });
    c.on("end", () => { for (const l of buf.split("\n")) if (l.trim()) lines.push(JSON.parse(l)); });
  });
  const ready = new Promise<void>((r) => server.listen(path, () => r()));
  return { lines, server, ready };
}

function launch(name: string, stateDir: string, socketPath: string, flags: string[] = []) {
  return Bun.spawn(["/bin/sh", WRAPPER, ...flags], {
    stdin: "pipe", stdout: "ignore", stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      AGENT_PEERS_ENABLED: "1", AGENT_PEERS_SPAWN_BROKER: "1",
      AGENT_PEERS_PORT: String(PORT), AGENT_PEERS_DB: DB, AGENT_PEERS_SECRET_PATH: SECRET,
      AGENT_PEERS_STATE_DIR: stateDir, AGENT_PEERS_DISABLE_TAB_TITLE: "1",
      AGENT_PEERS_IDLE_POLL_MS: "200", PEER_NAME: name,
      CLAUDE_CODE_MESSAGING_SOCKET: socketPath, CLAUDE_CODE_MESSAGING_TOKEN: "tok-e2e",
    },
  });
}

async function until<T>(fn: () => T | undefined | null | false, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

function peerRow(name: string) {
  return handle.db.query<{ id: string; pid: number }, [string]>("SELECT id, pid FROM peers WHERE name = ?").get(name);
}

async function send(to: string, text: string) {
  const r = await client.sendMessage({ from_id: sender.id, session_token: sender.session_token, to_id_or_name: to, text });
  expect(r.ok).toBe(true);
  return r.message_id!;
}

test("a session without the channel is woken through its inbox socket", async () => {
  const state = mkdtempSync(join(dir, "s1-"));
  const sockPath = join(state, "inbox.sock");
  const sock = fakeSocket(sockPath);
  await sock.ready;
  const proc = launch("e2e-socket", state, sockPath);
  try {
    const row = await until(() => peerRow("e2e-socket"));
    const marker = join(state, "socket-wake", String(row.pid));
    await until(() => existsSync(marker));
    const id = await send("e2e-socket", "please review the merge");
    await until(() => sock.lines.length >= 2);
    expect(sock.lines[0]).toEqual({ type: "auth", token: "tok-e2e" });
    const wake = sock.lines[1] as { type: string; message: { role: string; content: string } };
    expect(wake.type).toBe("user");
    expect(wake.message.content).toContain(`[Agent Peers] message #${id} from e2e-sender`);
    expect(wake.message.content).toContain("please review the merge");
    // Acked at the broker and kept unread in the durable inbox for check_messages.
    await until(() => handle.db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id = ?").get(id)?.acked === 1);
    const meta = JSON.parse(readFileSync(join(state, `${row.id}.metadata.json`), "utf8"));
    expect(meta.unread.map((m: { id: number }) => m.id)).toContain(id);
    // One wake per message: no repeat on later polls.
    await new Promise((r) => setTimeout(r, 1500));
    expect(sock.lines.length).toBe(2);
    proc.kill("SIGTERM");
    await proc.exited;
    await until(() => !existsSync(marker), 5000);
  } finally {
    proc.kill("SIGKILL");
    sock.server.close();
  }
}, 30000);

test("a channel session keeps the channel and never touches the socket", async () => {
  const state = mkdtempSync(join(dir, "s2-"));
  const sockPath = join(state, "inbox.sock");
  const sock = fakeSocket(sockPath);
  await sock.ready;
  const proc = launch("e2e-channel", state, sockPath, ["--dangerously-load-development-channels", "server:agent-peers"]);
  try {
    const row = await until(() => peerRow("e2e-channel"));
    const id = await send("e2e-channel", "hello channel");
    await until(() => handle.db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id = ?").get(id)?.acked === 1);
    await new Promise((r) => setTimeout(r, 1000));
    expect(sock.lines.length).toBe(0);
    expect(existsSync(join(state, "socket-wake", String(row.pid)))).toBe(false);
  } finally {
    proc.kill("SIGKILL");
    sock.server.close();
  }
}, 30000);

test("a dead socket degrades to the rewake hook and keeps the mail", async () => {
  const state = mkdtempSync(join(dir, "s3-"));
  const proc = launch("e2e-dead-socket", state, join(state, "missing.sock"));
  try {
    const row = await until(() => peerRow("e2e-dead-socket"));
    const marker = join(state, "socket-wake", String(row.pid));
    await until(() => existsSync(marker));
    const id = await send("e2e-dead-socket", "are you there");
    // Five failed attempts, one per poll, then the marker goes away.
    await until(() => !existsSync(marker), 20000);
    const meta = JSON.parse(readFileSync(join(state, `${row.id}.metadata.json`), "utf8"));
    expect(meta.unread.map((m: { id: number }) => m.id)).toContain(id);
    expect(readdirSync(join(state, "socket-wake"))).toEqual([]);
  } finally {
    proc.kill("SIGKILL");
  }
}, 40000);
