// Opt-in T1 bootstrap. First strict MCP metadata is dispatch authority only,
// NOT a claim that T2 host lifecycle events or autonomous wake are available.
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HermesConversationAdapter } from "./hermes-conversation-adapter.ts";
import { HermesConversationBroker, installHermesConversationBrokerSchema } from "./hermes-conversation-broker.ts";
import { createHermesConversationMcp } from "./hermes-conversation-mcp.ts";
import { ownerStillHoldsClaim } from "./hermes-claims.ts";
import { paperclipAgentMarker } from "./paperclip-guard.ts";
import { getGitRoot } from "./peer-context.ts";
import { canonicalProfileHome, type HermesConversationContext } from "./hermes-conversation-context.ts";
import { validateConversationDbFiles } from "./hermes-conversation-db-files.ts";

export async function startHermesConversationRuntime(options: { resolveGitRoot?: typeof getGitRoot } = {}): Promise<void> {
  const env = Object.freeze({ ...process.env });
  const stateRoot = env.AGENT_PEERS_STATE_DIR ?? env.AGENT_PEERS_HERMES_STATE_DIR ?? join(homedir(), ".agent-peers-hermes");
  let db: Database | undefined;
  let adapter: HermesConversationAdapter | undefined;
  let server: Server | undefined;
  let ownedBackend: string | undefined;
  const adapterId = randomUUID();
  const parent = process.ppid;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, onEnd);
      await adapter?.stop();
      const backendId = ownedBackend;
      if (db && backendId) db.transaction(() => {
        db!.query(`UPDATE hermes_conversations SET state='suspended',owner_lease_until=0,updated_at=?
          WHERE backend_id=? AND adapter_id=? AND state='active'`).run(Date.now(), backendId, adapterId);
        db!.query("DELETE FROM hermes_adapter_processes WHERE backend_id=? AND adapter_id=?")
          .run(backendId, adapterId);
      }).immediate();
      await server?.close();
      db?.close();
      db = undefined;
    })();
    return closing;
  };
  const onEnd = () => { void close().catch(() => { process.exitCode = 1; }); };
  process.stdin.once("end", onEnd);
  process.stdin.once("error", onEnd);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, onEnd);
  const inert = async () => {
    server = new Server({ name: "agent-peers-hermes-inert", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    await server.connect(new StdioServerTransport());
  };
  try {
    // Embodiment/disable gates precede config validation, DB access and schema.
    if (paperclipAgentMarker(env) || env.AGENT_PEERS_ENABLED !== "1"
        || env.AGENT_PEERS_HERMES_ROLE === "passive" || existsSync(join(stateRoot, "disabled"))) {
      await inert();
      return;
    }
    const homeValue = env.AGENT_PEERS_HERMES_HOME;
    const backend = env.AGENT_PEERS_HERMES_BACKEND_ID;
    if (!homeValue || !isAbsolute(homeValue) || !backend) throw new Error("v2_requires_profile_home_and_host_backend_id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(backend)) {
      throw new Error("invalid_hermes_backend_id");
    }
    const home = canonicalProfileHome(homeValue);
    if (realpathSync(home) !== home) throw new Error("v2_requires_canonical_host_profile_home");
    const cwd = env.AGENT_PEERS_CWD ?? process.cwd();
    if (!isAbsolute(cwd) || !isAbsolute(stateRoot)) throw new Error("v2_paths_must_be_absolute");
    const dbPath = env.AGENT_PEERS_DB ?? join(homedir(), ".agent-peers.db");
    if (!isAbsolute(dbPath)) throw new Error("v2_database_path_must_be_absolute");
    validateConversationDbFiles(dbPath);
    process.umask(0o077);
    // Same local OS-user database boundary as the operator CLI. This does not
    // start/restart a broker or accept unauthenticated remote evidence.
    db = new Database(dbPath, { readwrite: true, create: false });
    validateConversationDbFiles(dbPath);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    db.query("SELECT id FROM peers LIMIT 1").get();
    installHermesConversationBrokerSchema(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hermes_adapter_processes (
      backend_id TEXT PRIMARY KEY, adapter_id TEXT NOT NULL, pid INTEGER NOT NULL,
      acquired_at TEXT NOT NULL, home TEXT NOT NULL, observation INTEGER NOT NULL DEFAULT 0
    )`);
    const claimed = db.transaction(() => {
      const old = db!.query<{ pid: number; acquired_at: string; home: string; adapter_id: string }, [string]>(
        "SELECT pid,acquired_at,home,adapter_id FROM hermes_adapter_processes WHERE backend_id=?",
      ).get(backend);
      if (old && ownerStillHoldsClaim(old.pid, old.acquired_at)) return false;
      if (old) {
        if (old.home !== home) throw new Error("backend_profile_mismatch");
        db!.query(`UPDATE hermes_conversations SET state='suspended',owner_lease_until=0,updated_at=?
          WHERE backend_id=? AND adapter_id=? AND state='active'`).run(Date.now(), backend, old.adapter_id);
      }
      db!.query(`INSERT INTO hermes_adapter_processes (backend_id,adapter_id,pid,acquired_at,home) VALUES (?,?,?,?,?)
        ON CONFLICT(backend_id) DO UPDATE SET adapter_id=excluded.adapter_id,pid=excluded.pid,
        acquired_at=excluded.acquired_at,home=excluded.home`)
        .run(backend, adapterId, process.pid, new Date().toISOString(), home);
      return true;
    }).immediate();
    if (!claimed) {
      db.close();
      db = undefined;
      await inert();
      return;
    }
    ownedBackend = backend;
    const gitRoot = await (options.resolveGitRoot ?? getGitRoot)(cwd);
    if (closing) { await closing; return; }
    // Monotonic adapter observation order, not a fabricated host lifecycle
    // sequence. It advances only on strict tool calls. No close/reap inference.
    const observations = new WeakMap<Readonly<HermesConversationContext>, number>();
    const broker = new HermesConversationBroker(db, {
      profile: env.PEER_NAME ?? "hermes", adapter_id: adapterId, pid: process.pid,
      cwd, git_root: gitRoot, inboxRoot: stateRoot,
      evidence: context => {
        const requestSequence = observations.get(context);
        if (requestSequence === undefined) throw new Error("unobserved_dispatch_context");
        const current = db!.query<{ current_session_id: string; lifecycle_generation: number }, [string, string]>(
          "SELECT current_session_id,lifecycle_generation FROM hermes_conversations WHERE home=? AND conversation_id=?",
        ).get(context.home, context.conversation_id);
        // A delayed old-segment call must not undo a newer compression. Calls
        // still using the current segment may renew their lease while waiting.
        const generation = current?.current_session_id === context.session_id
          ? Math.max(requestSequence, current.lifecycle_generation) : requestSequence;
        return { context, adapter_id: adapterId, lifecycle_generation: generation, observed_at: Date.now() };
      },
      releaseEvidence: () => { throw new Error("host_lifecycle_unavailable_in_t1"); },
    });
    adapter = new HermesConversationAdapter({
      home, backend_id: backend, inboxRoot: stateRoot, broker,
      onRequest: context => {
        const row = db!.query<{ observation: number }, [string, string]>(`UPDATE hermes_adapter_processes SET
          observation = MAX(observation, COALESCE((SELECT MAX(lifecycle_generation) FROM hermes_conversations
            WHERE backend_id=hermes_adapter_processes.backend_id),0)) + 1
          WHERE backend_id=? AND adapter_id=? RETURNING observation`).get(backend, adapterId);
        if (!row) throw new Error("adapter_process_not_owner");
        observations.set(context, row.observation);
      },
      onTick: () => {
        if (process.ppid !== parent) { onEnd(); return; }
        validateConversationDbFiles(dbPath);
        broker.bindings.expire();
        adapter?.evictExpired(owner => {
          const binding = broker.bindings.get(owner.peer_id);
          return !binding || binding.state !== "active" || binding.generation !== owner.generation;
        });
      },
    });
    server = createHermesConversationMcp(adapter);
    await server.connect(new StdioServerTransport());
    if (closing) { await closing; return; }
    adapter.start();
  } catch (error) {
    await close();
    throw error;
  }
}
