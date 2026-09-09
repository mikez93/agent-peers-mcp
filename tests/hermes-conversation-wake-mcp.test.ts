import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initDb, registerPeer, sendMessage } from "../broker.ts";
import { HermesConversationBroker, installHermesConversationBrokerSchema } from "../shared/hermes-conversation-broker.ts";
import { HermesConversationAdapter } from "../shared/hermes-conversation-adapter.ts";
import { createHermesConversationMcp } from "../shared/hermes-conversation-mcp.ts";
import {
  HermesConversationWakeCoordinator, installHermesWakeSchema,
  type HermesWakePorts, type WakeCandidate, type WakeRequest,
} from "../shared/hermes-conversation-wake.ts";

test("fixture wake target equals real MCP inbox identity, and admission/read never acknowledges", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-wake-mcp-"));
  const db = initDb(join(root, "broker.db"));
  const home = "/fixture/profile", backend = "77ab3c4a-2e1b-4d4a-a5b4-88009412f721";
  installHermesConversationBrokerSchema(db);
  installHermesWakeSchema(db);
  let sequence = 0;
  const broker = new HermesConversationBroker(db, { profile: "fixture-hermes", adapter_id: "one-adapter",
    cwd: "/fixture", git_root: null, pid: process.pid, inboxRoot: join(root, "inboxes"),
    evidence: context => ({ context, adapter_id: "one-adapter", lifecycle_generation: ++sequence, observed_at: Date.now() }),
    releaseEvidence: () => ({ lifecycle_generation: ++sequence, observed_at: Date.now() }) });
  const adapter = new HermesConversationAdapter({ home, backend_id: backend, inboxRoot: join(root, "inboxes"), broker });
  const server = createHermesConversationMcp(adapter);
  const client = new Client({ name: "fixture-owning-host", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const meta = (id: string) => ({ "hermes/home": home, "hermes/backend_id": backend,
    "hermes/conversation_id": id, "hermes/session_id": id, "hermes/platform": "desktop" });
  const call = (id: string, name = "check_messages", args = {}) => client.callTool({ name, arguments: args, _meta: meta(id) });
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    await call("a", "set_summary", { summary: "status-only A" });
    await call("b", "set_summary", { summary: "status-only B" });
    const rows = db.query<{ peer_id: string; conversation_id: string; generation: number }, []>(
      "SELECT peer_id,conversation_id,generation FROM hermes_conversations ORDER BY conversation_id").all();
    const sender = registerPeer(db, { peer_type: "claude", name: "fixture-sender", pid: process.pid,
      cwd: "/fixture", git_root: null, tty: null, summary: "" });
    const sent = sendMessage(db, { from_id: sender.id, session_token: sender.session_token,
      to_id_or_name: rows[0]!.peer_id, text: "PRIVATE_FOR_A_ONLY" });
    expect(sent.ok).toBe(true);
    const unread = () => db.query<{ acked: number }, [number]>("SELECT acked FROM messages WHERE id=?")
      .get(sent.message_id!)!.acked;
    const targets: WakeCandidate[] = rows.map(row => ({
      peer_id: row.peer_id, binding_generation: row.generation, state: "active",
      context: { home, backend_id: backend, conversation_id: row.conversation_id,
        session_id: row.conversation_id, platform: "desktop" },
      unread_ids: row.conversation_id === "a" ? [sent.message_id!] : [],
    }));
    const admitted: Readonly<WakeRequest>[] = [];
    const ports: HermesWakePorts = {
      async snapshot(c) {
        return { context: c.context, lifecycle_generation: 1, observed_at: Date.now(),
          state: "live", end_reason: null, busy: false, queued: false, compacting: false };
      },
      async current(c) {
        const row = broker.bindings.get(c.peer_id);
        return row?.generation === c.binding_generation && row.state === "active"
          && row.conversation_id === c.context.conversation_id && row.backend_id === c.context.backend_id;
      },
      async admit(request) {
        admitted.push(request);
        return { attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence, context: request.context, state: "accepted" };
      },
      async reconcile(request) { return { attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
        context: request.context, state: "accepted" }; },
    };
    await new HermesConversationWakeCoordinator(db, ports).run(targets);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]!.peer_id).toBe(rows[0]!.peer_id);
    expect(unread()).toBe(0);
    expect(JSON.stringify(await call("b"))).not.toContain("PRIVATE_FOR_A_ONLY");
    // This is a fixture host dispatch, not a real autonomous Hermes turn.
    const wake = admitted[0]!;
    const response = await client.callTool({ name: "check_messages", arguments: {},
      _meta: Object.fromEntries(Object.entries(wake.context).map(([key, value]) => [`hermes/${key}`, value])) });
    expect(JSON.stringify(response)).toContain("PRIVATE_FOR_A_ONLY");
    expect(broker.bindings.get(wake.peer_id)?.conversation_id).toBe(wake.context.conversation_id);
    expect(unread()).toBe(0);
    await call("b");
    expect(unread()).toBe(0);
    await call("a");
    expect(unread()).toBe(1);
  } finally {
    await client.close(); await server.close(); await adapter.stop(); db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("uncertain attempt survives actual SQLite close/reopen without replaying an accepted turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "hermes-wake-reopen-"));
  const path = join(root, "ledger.db");
  let db = new Database(path);
  try {
    installHermesWakeSchema(db);
    const candidate: WakeCandidate = { peer_id: "peer-a", context: { home: "/fixture/profile",
      conversation_id: "a", session_id: "a", platform: "desktop", backend_id: "backend-one" },
    state: "active", binding_generation: 1, unread_ids: [1] };
    let persisted: Readonly<WakeRequest> | undefined;
    const ports: HermesWakePorts = {
      async snapshot(c) { return { context: c.context, lifecycle_generation: 1, observed_at: Date.now(),
        state: "live", end_reason: null, busy: false, queued: false, compacting: false }; },
      async current() { return true; },
      async admit(request) { persisted = request; throw new Error("response lost"); },
      async reconcile(request) {
        if (!persisted) throw new Error("missing prior admission");
        expect(request).toEqual(persisted);
        return { attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence, context: request.context, state: "started" };
      },
    };
    await new HermesConversationWakeCoordinator(db, ports).run([candidate]);
    db.close();
    db = new Database(path);
    installHermesWakeSchema(db);
    ports.admit = async () => { throw new Error("must not replay"); };
    expect((await new HermesConversationWakeCoordinator(db, ports).run([candidate]))[0]!.reason).toBe("started");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
