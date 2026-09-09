// Explicit v2 integration. No HTTP route accepts caller-asserted lifecycle
// evidence; the opt-in runtime supplies strict dispatch observations in T1.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import {
  ackMessages, listPeers, pollMessages, renamePeer, sendMessage, setPeerSummary,
} from "../broker.ts";
import {
  HermesConversationBindings, installHermesConversationSchema,
  type ConversationOwner, type LiveConversationEvidence,
} from "./hermes-conversation-bindings.ts";
import type {
  ConversationBrokerPort, ConversationCredential, HermesConversationTool,
} from "./hermes-conversation-adapter.ts";
import { conversationKey, type HermesConversationContext } from "./hermes-conversation-context.ts";
import { withConversationFence } from "./hermes-conversation-fence.ts";
import type { PeerType } from "./types.ts";

export function installHermesConversationBrokerSchema(db: Database): void {
  installHermesConversationSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS hermes_conversation_tokens (
    peer_id TEXT PRIMARY KEY REFERENCES hermes_conversations(peer_id),
    generation INTEGER NOT NULL,
    session_token TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS hermes_conversation_inboxes (
    peer_id TEXT NOT NULL REFERENCES hermes_conversations(peer_id),
    root TEXT NOT NULL,
    PRIMARY KEY(peer_id,root)
  )`);
}

export class HermesConversationBroker implements ConversationBrokerPort {
  readonly bindings: HermesConversationBindings;
  constructor(private readonly db: Database, private readonly options: {
    profile: string;
    adapter_id: string;
    cwd: string;
    git_root: string | null;
    pid: number;
    inboxRoot: string;
    evidence: (context: Readonly<HermesConversationContext>) => LiveConversationEvidence;
    releaseEvidence: (owner: ConversationOwner) => { lifecycle_generation: number; observed_at: number };
  }) {
    if (!isAbsolute(options.inboxRoot)) throw new Error("absolute_inbox_root_required");
    this.options = Object.freeze({ ...options });
    this.bindings = new HermesConversationBindings(db);
  }

  async bind(context: Readonly<HermesConversationContext>): Promise<ConversationCredential> {
    // The caller owns the authority seam: synthetic lifecycle fixtures or
    // strict runtime dispatch observations, never model identity arguments.
    const evidence = structuredClone(this.options.evidence(context));
    if (conversationKey(evidence.context) !== conversationKey(context)
        || evidence.context.session_id !== context.session_id
        || evidence.context.backend_id !== context.backend_id
        || evidence.context.platform !== context.platform
        || evidence.adapter_id !== this.options.adapter_id) {
      throw new Error("host_evidence_context_mismatch");
    }
    return this.db.transaction(() => {
      const binding = this.bindings.claim(evidence, this.options.profile);
      this.db.query("INSERT OR IGNORE INTO hermes_conversation_inboxes (peer_id,root) VALUES (?,?)")
        .run(binding.peer_id, this.options.inboxRoot);
      const old = this.db.query<{ generation: number; session_token: string }, [string]>(
        "SELECT generation, session_token FROM hermes_conversation_tokens WHERE peer_id = ?",
      ).get(binding.peer_id);
      const token = old?.generation === binding.generation ? old.session_token : randomUUID();
      this.db.query(`INSERT INTO hermes_conversation_tokens (peer_id,generation,session_token) VALUES (?,?,?)
        ON CONFLICT(peer_id) DO UPDATE SET generation=excluded.generation, session_token=excluded.session_token`)
        .run(binding.peer_id, binding.generation, token);
      const now = new Date().toISOString();
      this.db.query(`INSERT INTO peers
        (id,name,peer_type,pid,cwd,git_root,tty,summary,session_token,registered_at,started_at,last_seen,durable,host)
        VALUES (?,?,'hermes',?,?,?,NULL,?,?,?,?,?,0,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, pid=excluded.pid,cwd=excluded.cwd,
          git_root=excluded.git_root,summary=excluded.summary,session_token=excluded.session_token,
          last_seen=excluded.last_seen,host=excluded.host`)
        .run(binding.peer_id, binding.name, this.options.pid, this.options.cwd, this.options.git_root,
          binding.summary, token, new Date(binding.created_at).toISOString(),
          new Date(binding.created_at).toISOString(), now, hostname());
      if (old?.generation !== binding.generation) {
        this.db.query("UPDATE messages SET lease_token=NULL, lease_expires_at=NULL WHERE to_id=? AND acked=0")
          .run(binding.peer_id);
      }
      return Object.freeze({ peer_id: binding.peer_id, name: binding.name,
        backend_id: binding.backend_id, adapter_id: binding.adapter_id,
        generation: binding.generation, session_token: token, inbox_root: this.options.inboxRoot });
    }).immediate();
  }

  async poll(owner: ConversationCredential) {
    return pollMessages(this.db, owner.peer_id, owner.session_token, owner);
  }
  async ack(owner: ConversationCredential, tokens: string[]) {
    return ackMessages(this.db, { id: owner.peer_id, session_token: owner.session_token, lease_tokens: tokens }, owner);
  }
  async invoke(owner: ConversationCredential, tool: Exclude<HermesConversationTool,
    "check_messages" | "wait_for_peer_messages">, args: Readonly<Record<string, unknown>>): Promise<string> {
    return withConversationFence(this.db, owner.peer_id, owner.session_token, owner, () => {
      switch (tool) {
        case "list_peers": {
          const scope = args.scope ?? "machine";
          if (scope !== "machine" && scope !== "directory" && scope !== "repo") throw new Error("invalid_scope");
          const peerType = args.peer_type;
          if (peerType !== undefined && !["claude", "codex", "hermes", "droid"].includes(String(peerType))) {
            throw new Error("invalid_peer_type");
          }
          const peers = listPeers(this.db, { scope, cwd: this.options.cwd, git_root: this.options.git_root,
            exclude_id: owner.peer_id, peer_type: peerType as PeerType | undefined });
          return JSON.stringify({ peers, count: peers.length, conversations: this.bindings.status() });
        }
        case "set_summary":
          setPeerSummary(this.db, owner.peer_id, owner.session_token, text(args.summary, "summary"), owner);
          return "Summary set.";
        case "rename_peer": {
          const result = renamePeer(this.db, { id: owner.peer_id, session_token: owner.session_token,
            new_name: text(args.new_name, "new_name") }, owner);
          if (!result.ok) throw new Error(result.error);
          return `Renamed to ${result.name}.`;
        }
        case "send_message": {
          const result = sendMessage(this.db, { from_id: owner.peer_id, session_token: owner.session_token,
            to_id_or_name: text(args.to_id, "to_id"), text: text(args.message, "message") }, owner);
          if (!result.ok) throw new Error(result.error);
          return `Message queued (id=${result.message_id}).${result.notice ? ` ${result.notice}` : ""}`;
        }
      }
    });
  }

  async release(owner: ConversationCredential, reason: "closed" | "reaped" | "orphaned"): Promise<void> {
    const evidence = this.options.releaseEvidence(owner);
    withConversationFence(this.db, owner.peer_id, owner.session_token, owner, () => {
      this.bindings.release(owner, reason, evidence.lifecycle_generation, evidence.observed_at);
      this.db.query("DELETE FROM peers WHERE id=? AND session_token=?").run(owner.peer_id, owner.session_token);
      this.db.query("DELETE FROM hermes_conversation_tokens WHERE peer_id=? AND generation=?")
        .run(owner.peer_id, owner.generation);
    }, true);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 50_000) throw new Error(`invalid_${name}`);
  return value;
}
