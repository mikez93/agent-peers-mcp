import { existsSync } from "node:fs";
import { join } from "node:path";
import { CodexInboxStore } from "../../shared/codex-inbox.ts";
import { WakeRegistry } from "../../shared/wake-registry.ts";
import { WakeLaunchClaimStore } from "../../shared/wake-launch-claims.ts";
import { runWakePass } from "../../shared/wake-daemon.ts";
import { createWakeableAppServerLog } from "../../shared/bounded-log.ts";
import { buildResumeMcpConfigArgs } from "../../shared/wakeable-launcher.ts";

const now = new Date().toISOString();
const inbox = new CodexInboxStore({ peerId: "target" });
await inbox.queueLeasedMessages([{ id: 1, from_id: "sender", from_name: "sender", from_peer_type: "claude",
  from_cwd: "/repo", from_summary: "", to_id: "target", text: "private message", sent_at: now, lease_token: "test" }]);
const registry = new WakeRegistry();
const currentEntry = { peer_id: "target", peer_name: "target", cwd: "/repo", git_root: "/repo", tty: null,
  thread_id: "thread", rollout_path: null, app_server_url: "ws://127.0.0.1:1", app_server_socket_path: null,
  app_server_pid: process.pid, tui_pid: null, mcp_pid: process.pid, broker_session_token_hash: "sha256:test",
  status: "ready" as const, capabilities: ["app-server-ws"], created_at: now, updated_at: now, last_seen_at: now };
await registry.upsert(currentEntry);
const oldInbox = new CodexInboxStore({ peerId: "old-target", rootDir: process.env.AGENT_PEERS_CODEX_STATE_DIR });
await oldInbox.queueLeasedMessages([{ id: 2, from_id: "sender", from_name: "sender", from_peer_type: "claude",
  from_cwd: "/repo", from_summary: "", to_id: "old-target", text: "old child message", sent_at: now, lease_token: "test-2" }]);
await registry.upsert({ ...currentEntry, peer_id: "old-target", peer_name: "old-target", thread_id: "old-thread" });
const claim = await new WakeLaunchClaimStore().create({ cwd: "/repo", tty: null });
await new WakeLaunchClaimStore().update(claim.claim_id, { app_server_url: "ws://127.0.0.1:1",
  app_server_pid: process.pid, thread_id: "thread", status: "ready" });
const childEnv: NodeJS.ProcessEnv = { HOME: process.env.HOME };
for (const arg of buildResumeMcpConfigArgs()) {
  const match = /^mcp_servers\.agent-peers\.env\.([^=]+)=(.*)$/.exec(arg);
  if (match) childEnv[match[1]!] = JSON.parse(match[2]!);
}
const child = Bun.spawn([process.execPath, join(import.meta.dir, "state-dir-child.ts")], {
  env: childEnv, stdout: "pipe", stderr: "pipe",
});
const [childOut, childErr, childCode] = await Promise.all([
  new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
]);
if (childCode || childErr) throw new Error(`filtered child failed: ${childErr}`);
const childResult = JSON.parse(childOut);
const results = await runWakePass({ appServerClientFactory: () => ({
  listLoadedThreads: async () => ["thread", "old-thread"],
  readThread: async (id) => ({ id, cwd: "/repo", path: null, status: { type: "idle" } }),
  startWakeTurn: async () => ({ turnId: "test-turn" }),
  activeTurnId: async () => null,
  steerWakeTurn: async () => ({ turnId: null }),
  close() {},
}) });
const log = createWakeableAppServerLog({ cwd: "/repo", peerName: "target" });
console.log(JSON.stringify({ action: results.find((item) => item.peer_id === "target")?.action,
  oldAction: results.find((item) => item.peer_id === "old-target")?.action,
  oldUnread: (await oldInbox.getUnreadMessages()).length,
  unread: (await new CodexInboxStore({ peerId: "target" }).getUnreadMessages()).length,
  claims: (await new WakeLaunchClaimStore().list()).length,
  legacyExists: existsSync(process.env.AGENT_PEERS_CODEX_STATE_DIR!),
  logRootMatches: log.path === join(process.env.AGENT_PEERS_CODEX_STATE_DIR!, "logs", "target-app-server.log"),
  childMatched: childResult.claimId === claim.claim_id && childResult.unread === 1 }));
