import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPeer, listPeers, registerPeer, startBroker } from "../broker.ts";
import { NAME_MAX_LEN } from "../shared/names.ts";
import type { PeerType } from "../shared/types.ts";

let root: string;
let cwd: string;
let broker: ReturnType<typeof startBroker>;
const connections: Array<{ client: Client; transport: StdioClientTransport }> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "peer-naming-integration-"));
  cwd = join(root, "team-project");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  writeFileSync(join(cwd, "AGENTS.md"), "---\nname: trophy-ceo-valentina\n---\nYou are **Valentina Moretti**, the virtual CEO.\nTalk to Vector and Marco when appropriate.\n");
  // Match production ownership so adapters accept this already-running broker
  // without invoking launchctl or enabling the self-spawn fallback.
  broker = startBroker(0, join(root, "peers.db"), join(root, "secret"), "launchd");
});

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client, transport }) => {
    // Signal first so cleanup does not wait for the SDK's stdin grace period.
    if (transport.pid) {
      try { process.kill(transport.pid, "SIGTERM"); } catch { /* Already exited. */ }
    }
    await client.close();
    await transport.close();
  }));
  clearInterval(broker.gcTimer);
  broker.server.stop(true);
  broker.db.close();
  rmSync(root, { recursive: true, force: true });
});

async function connect(type: PeerType, explicitName?: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", `${type}-server.ts`)],
    cwd,
    stderr: "pipe",
    // Deliberately do not forward session, wake-claim, API-key or Paperclip env.
    env: {
      PATH: process.env.PATH ?? "",
      AGENT_PEERS_ENABLED: "1",
      AGENT_PEERS_PORT: String(broker.server.port),
      AGENT_PEERS_DB: join(root, "peers.db"),
      AGENT_PEERS_SECRET_PATH: join(root, "secret"),
      AGENT_PEERS_STATE_DIR: join(root, `state-${connections.length}`),
      AGENT_PEERS_AUTO_SUMMARY: "0",
      AGENT_PEERS_DISABLE_TAB_TITLE: "1",
      ...(explicitName ? { PEER_NAME: explicitName } : {}),
    },
  });
  const client = new Client({ name: "naming-integration-test", version: "1.0.0" });
  connections.push({ client, transport });
  let diagnostic = "";
  transport.stderr?.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(-3000); });
  try {
    await client.connect(transport, { timeout: 8000 });
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "list_peers")).toBe(true);
  } catch (error) {
    throw new Error(`${type} MCP registration failed: ${String(error)}\n${diagnostic}`);
  }
  const peer = listPeers(broker.db, { scope: "machine", cwd, git_root: cwd })
    .find((row) => row.pid === transport.pid);
  expect(peer).toBeDefined();
  expect(peer!.peer_type).toBe(type);
  return { client, peer: peer! };
}

test("all four real MCP adapters register persona defaults and preserve explicit names", async () => {
  for (const type of ["claude", "codex", "droid", "hermes"] as const) {
    const auto = await connect(type);
    expect(auto.peer.name).toBe(`valentina-team-project-${type}`);
    const explicit = await connect(type, `Existing_${type}_identity`);
    expect(explicit.peer.name).toBe(`Existing_${type}_identity`);
    expect(explicit.peer.id).not.toBe(auto.peer.id);
  }
}, 30_000);

test("concurrent persona instances remain distinct and MCP discovery orders by Started", async () => {
  const older = await connect("codex");
  const newer = await connect("codex");
  const observer = await connect("claude", "observer");
  expect(older.peer.name).toBe("valentina-team-project-codex");
  expect(newer.peer.name).toStartWith("valentina-team-project-codex-");
  expect(newer.peer.id).not.toBe(older.peer.id);
  expect(newer.peer.started_at! > older.peer.started_at!).toBe(true);

  // A fresh heartbeat from the older instance must not masquerade as a new start.
  broker.db.query("UPDATE peers SET last_seen = ? WHERE id = ?").run(new Date().toISOString(), older.peer.id);
  const result = await observer.client.callTool({ name: "list_peers", arguments: { scope: "machine" } });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text").map((part) => part.text).join("\n");
  expect(text).toContain(`Started: ${older.peer.started_at}`);
  expect(text).toContain(`Started: ${newer.peer.started_at}`);
  expect(text.indexOf(`Peer ${newer.peer.name} (`)).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(`Peer ${newer.peer.name} (`)).toBeLessThan(text.indexOf(`Peer ${older.peer.name} (`));
}, 20_000);

test("broker collision at maximum name length keeps persona prefix within the shared bound", () => {
  const name = "valentina-" + "r".repeat(NAME_MAX_LEN - "valentina-".length);
  const request = { peer_type: "droid" as const, pid: process.pid, cwd, git_root: cwd, tty: null, summary: "", name };
  const first = registerPeer(broker.db, request);
  const second = registerPeer(broker.db, request);
  expect(first.name).toBe(name);
  expect(second.name).not.toBe(name);
  expect(second.name).toStartWith("valentina-");
  expect(second.name.length).toBeLessThanOrEqual(NAME_MAX_LEN);
  expect(second.name).toMatch(/-2$/);
  expect(getPeer(broker.db, first.id)?.name).toBe(name);
  expect(getPeer(broker.db, second.id)?.name).toBe(second.name);
});
