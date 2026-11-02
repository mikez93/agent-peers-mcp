// End to end with real openclaw-server.ts processes (bd-b2in.17, Marco's
// AP10809 #3). Two children of one OpenClaw agent start with identical env,
// exactly as OpenClaw's per-agent mcp.servers entry launches them per session
// thread. Neither takes the identity at startup. The one whose Codex thread
// presents main's bind token becomes the single durable peer; the other never
// registers, never draws mail. After main's child is killed, a new child of
// the same thread reclaims the same peer ID and the undelivered mail.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollMessages, registerPeer, sendMessage, startBroker } from "../broker.ts";
import { bindOpenClawAgent, clearOpenClawSubmission } from "../shared/openclaw-wake-pass.ts";
import { readBinding, readLedger } from "../shared/openclaw-state.ts";
import type { OpenClawGateway } from "../shared/openclaw-gateway.ts";

const root = mkdtempSync(join(tmpdir(), "ap-openclaw-e2e-"));
const state = join(root, "state");
const T_MAIN = "0199aaaa-0000-7000-8000-00000000000a";
const T_OTHER = "0199bbbb-0000-7000-8000-00000000000b";
const T_NEW = "0199cccc-0000-7000-8000-00000000000c";
let broker: ReturnType<typeof startBroker>;
let marco: { id: string; session_token: string };
const children: { client: Client; transport: StdioClientTransport }[] = [];

async function spawnChild(extraEnv: Record<string, string> = {}): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", "openclaw-server.ts")],
    cwd: root,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      AGENT_PEERS_PORT: String(broker.server.port),
      AGENT_PEERS_DB: join(root, "peers.db"),
      AGENT_PEERS_SECRET_PATH: join(root, "secret"),
      AGENT_PEERS_STATE_DIR: state,
      AGENT_PEERS_AUTO_SUMMARY: "0",
      AGENT_PEERS_DISABLE_TAB_TITLE: "1",
      AGENT_PEERS_OPENCLAW_AGENT: "peers",
      PEER_NAME: "openclaw-hetzner",
      ...extraEnv,
    },
  });
  const client = new Client({ name: "openclaw-e2e", version: "1.0.0" });
  await client.connect(transport, { timeout: 8000 });
  const child = { client, transport };
  children.push(child);
  return child;
}

async function call(c: { client: Client }, name: string, args: Record<string, unknown>, threadId?: string) {
  const r = await c.client.callTool({ name, arguments: args, ...(threadId ? { _meta: { threadId } } : {}) });
  return { text: (r.content as { text: string }[]).map((x) => x.text).join(""), isError: r.isError === true };
}
const openclawRows = () => broker.db.query<{ id: string; name: string; pid: number }, []>(
  "SELECT id, name, pid FROM peers WHERE peer_type = 'openclaw'").all();

let token = "";
let gateway: OpenClawGateway;
beforeAll(async () => {
  broker = startBroker(0, join(root, "peers.db"), join(root, "secret"), "launchd");
  marco = registerPeer(broker.db, { peer_type: "droid", name: "marco-droid", pid: process.pid, cwd: "/w/ops", git_root: null, tty: null, summary: "", durable: true });
  // The operator's bind, through the real bind path with a stand-in Gateway.
  gateway = {
    describe: async (key) => ({ key, sessionId: "s-1" }),
    chatSend: async (p) => ({ runId: p.idempotencyKey, status: "started" }),
    inputReceipts: async () => [],
  };
  const r = await bindOpenClawAgent({ root: state, agentId: "peers", gateway, newToken: () => (token = "e2e-bind-token") });
  expect(r.state).toBe("submitted");
});

afterAll(async () => {
  for (const c of children) {
    if (c.transport.pid) { try { process.kill(c.transport.pid, "SIGTERM"); } catch { /* gone */ } }
    try { await c.client.close(); } catch { /* gone */ }
  }
  clearInterval(broker.gcTimer);
  broker.server.stop(true);
  broker.db.close();
  rmSync(root, { recursive: true, force: true });
});

test("two children, one mailbox: only the token-proven main thread registers and reads mail", async () => {
  const other = await spawnChild();
  const main = await spawnChild();
  await new Promise((r) => setTimeout(r, 500));
  expect(openclawRows()).toEqual([]); // no first-child-wins

  const unbound = await call(other, "check_messages", {}, T_OTHER);
  expect(unbound).toMatchObject({ isError: true, text: expect.stringContaining("not yet bound") });
  expect(await call(main, "check_messages", {})).toMatchObject({ isError: true, text: expect.stringContaining("_meta.threadId") });
  expect(openclawRows()).toEqual([]);

  const bound = await call(main, "check_messages", { wake: token }, T_MAIN);
  expect(bound.isError).toBe(false);
  const rows = openclawRows();
  expect(rows.map((r) => r.name)).toEqual(["openclaw-hetzner"]);
  expect(await readBinding(state, "peers")).toMatchObject({ thread_id: T_MAIN, peer_id: rows[0]!.id, peer_name: "openclaw-hetzner" });

  expect(sendMessage(broker.db, { from_id: marco.id, session_token: marco.session_token, to_id_or_name: "openclaw-hetzner", text: "hello main" }).ok).toBe(true);
  const stolen = await call(other, "check_messages", { wake: token }, T_OTHER);
  expect(stolen.isError).toBe(true);
  expect(stolen.text).not.toContain("hello main");
  expect((await call(other, "list_peers", { scope: "machine" }, T_OTHER)).isError).toBe(true);

  const seen = await call(main, "check_messages", {}, T_MAIN);
  expect(seen.text).toContain("hello main");
  const sent = await call(main, "send_message", { to_id: "marco-droid", message: "hi from main" }, T_MAIN);
  expect(sent.text).toContain("Message sent");
  const [reply] = pollMessages(broker.db, marco.id, marco.session_token);
  expect(reply).toMatchObject({ from_name: "openclaw-hetzner", from_peer_type: "openclaw", text: "hi from main" });
  expect(openclawRows()).toHaveLength(1);
}, 30_000);

test("winner death and reconnect: a new child of main's thread reclaims the same peer and its undelivered mail", async () => {
  const before = openclawRows();
  expect(before).toHaveLength(1);
  const main = children[1]!;
  expect(sendMessage(broker.db, { from_id: marco.id, session_token: marco.session_token, to_id_or_name: "openclaw-hetzner", text: "while you were down" }).ok).toBe(true);
  process.kill(main.transport.pid!, "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));

  const reborn = await spawnChild();
  await new Promise((r) => setTimeout(r, 300));
  expect(openclawRows()[0]!.pid).toBe(before[0]!.pid); // nothing registers until a proven call
  const r = await call(reborn, "check_messages", {}, T_MAIN);
  expect(r.isError).toBe(false);
  expect(r.text).toContain("while you were down");
  const after = openclawRows();
  expect(after).toHaveLength(1);
  expect(after[0]!.id).toBe(before[0]!.id);
  expect(after[0]!.pid).toBe(reborn.transport.pid!);
  // The surviving secondary is still off the network.
  expect((await call(children[0]!, "check_messages", {}, T_OTHER)).isError).toBe(true);
}, 30_000);

test("session reset while the old owner's row still looks live: the new main waits, then reclaims the same peer and mail", async () => {
  const before = openclawRows();
  expect(before).toHaveLength(1);
  const oldMain = children[2]!;
  expect(sendMessage(broker.db, { from_id: marco.id, session_token: marco.session_token, to_id_or_name: "openclaw-hetzner", text: "after the reset" }).ok).toBe(true);

  // The operator settles the first bind and binds again: main now runs on a
  // new Codex thread (a session reset).
  const first = (await readLedger(state, "peers")).submissions.find((s) => s.kind === "bind")!;
  expect(await clearOpenClawSubmission(state, "peers", first.id, "e2e: settled")).toContain("cleared");
  let token2 = "";
  expect((await bindOpenClawAgent({ root: state, agentId: "peers", gateway, newToken: () => (token2 = "e2e-bind-token-2") })).state).toBe("submitted");

  // The old owner is gone, but its row still looks live to the broker: its
  // pid is not reaped yet (stand-in: this test's own live pid) and its last
  // heartbeat is recent. Fast reclaim cannot fire.
  process.kill(oldMain.transport.pid!, "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  broker.db.query("UPDATE peers SET pid = ?, last_seen = ? WHERE id = ?").run(process.pid, new Date().toISOString(), before[0]!.id);

  const fresh = await spawnChild({ AGENT_PEERS_OPENCLAW_RECLAIM_WAIT_MS: "20000" });
  const pending = call(fresh, "check_messages", { wake: token2 }, T_NEW);
  // The heartbeat ages past the broker's reclaim cutoff while the call waits.
  await new Promise((r) => setTimeout(r, 1500));
  expect(openclawRows().filter((r) => r.name !== "openclaw-hetzner")).toEqual([]); // no second identity kept
  broker.db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run(new Date(Date.now() - 120_000).toISOString(), before[0]!.id);

  const r = await pending;
  expect(r.isError).toBe(false);
  expect(r.text).toContain("after the reset");
  const after = openclawRows();
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ id: before[0]!.id, name: "openclaw-hetzner", pid: fresh.transport.pid! });
  expect(await readBinding(state, "peers")).toMatchObject({ thread_id: T_NEW, peer_id: before[0]!.id });
  // The old thread is now secondary, and the unrelated thread stays off.
  expect((await call(children[0]!, "check_messages", {}, T_OTHER)).isError).toBe(true);
}, 40_000);

test("AP10842 #2: touching disabled makes a loaded, bound child inert at once; mail stays with the broker and is served after release", async () => {
  const main = children[children.length - 1]!; // the T_NEW owner from the previous test
  const flag = join(state, "disabled");
  writeFileSync(flag, "");
  try {
    expect(sendMessage(broker.db, { from_id: marco.id, session_token: marco.session_token, to_id_or_name: "openclaw-hetzner", text: "sent while disabled" }).ok).toBe(true);
    const r = await call(main, "check_messages", {}, T_NEW);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("switched off");
    expect(r.text).not.toContain("sent while disabled");
    expect((await call(main, "send_message", { to_id: "marco-droid", message: "should not go" }, T_NEW)).isError).toBe(true);
    await new Promise((res) => setTimeout(res, 2500)); // longer than a background poll
    const row = broker.db.query<{ acked: number; lease_token: string | null }, [string]>(
      "SELECT acked, lease_token FROM messages WHERE text = ?").get("sent while disabled");
    expect(row).toEqual({ acked: 0, lease_token: null }); // not drawn by the background poll
  } finally {
    rmSync(flag, { force: true });
  }
  const back = await call(main, "check_messages", {}, T_NEW);
  expect(back.isError).toBe(false);
  expect(back.text).toContain("sent while disabled");
}, 20_000);
