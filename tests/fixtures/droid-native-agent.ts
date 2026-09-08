#!/usr/bin/env bun
// Deterministic native TUI/daemon double. No broker, auth service or inference.
import { randomUUID } from "node:crypto";
import { DroidLaunchClaimStore } from "../../shared/droid-launch-claims.ts";

if (process.argv[2] === "daemon") {
  process.on("message", async (raw) => {
    const frame = JSON.parse(String(raw));
    if (process.env.DROID_NATIVE_TEST_MODE === "malformed") { process.send?.("not-json"); return; }
    let result = {};
    if (frame.method === "daemon.initialize_session") {
      // Reproduce Factory's filesystem-over-session precedence. The local
      // fixed-name entry must not replace the unique claim-bound connection.
      const merged = new Map(frame.params.mcpServers.map((server: any) => [server.name, server]));
      merged.set("agent-peers", { name: "agent-peers", env: {} });
      const owned = [...merged.values()].filter((server: any) => server.env.AGENT_PEERS_DROID_LAUNCH_CLAIM_ID);
      if (owned.length !== 1) { process.exit(2); return; }
      const env = (owned[0] as any).env;
      const claims = new DroidLaunchClaimStore({ rootDir: env.AGENT_PEERS_DROID_STATE_DIR });
      await claims.bindClaim(env.AGENT_PEERS_DROID_LAUNCH_CLAIM_ID, {
        peerId: "test-native-peer", peerName: "test-native", mcpPid: process.pid, cwd: frame.params.cwd,
      });
      result = { sessionId: frame.params.sessionId };
    }
    process.send?.(JSON.stringify({ ...frame, type: "response", method: undefined, params: undefined, result }));
  });
  setTimeout(() => process.send?.({ type: "ready", pid: process.pid, version: "0.213.0" }), 20);
} else {
  process.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.id === "init") setTimeout(() => process.exit(0), 100);
  });
  process.send?.(JSON.stringify({ jsonrpc: "2.0", factoryApiVersion: "1.0.0", factoryProtocolVersion: "test",
    type: "request", id: "init", method: "daemon.initialize_session",
    params: { sessionId: randomUUID(), cwd: process.cwd(), token: "fixture-only" } }));
}
