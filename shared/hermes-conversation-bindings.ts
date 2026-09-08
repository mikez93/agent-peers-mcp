// Fixture-stage binding store for bd-1con. No live broker entry point installs
// this schema yet. Host lifecycle evidence must be verified before calling it.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { conversationKey, conversationName, parseHermesConversationContext, type HermesConversationContext } from "./hermes-conversation-context.ts";

export const HERMES_OWNER_LEASE_MS = 45_000;
export const HERMES_SNAPSHOT_MAX_AGE_MS = 10_000;

export type ConversationState = "active" | "reaped" | "closed" | "suspended" | "orphaned" | "disposed";

export interface ConversationBinding {
  home: string;
  conversation_id: string;
  peer_id: string;
  name: string;
  summary: string;
  current_session_id: string;
  platform: string;
  backend_id: string;
  adapter_id: string;
  generation: number;
  lifecycle_generation: number;
  state: ConversationState;
  owner_lease_until: number;
  observed_at: number;
  created_at: number;
  updated_at: number;
}

export interface ConversationOwner {
  peer_id: string;
  backend_id: string;
  adapter_id: string;
  generation: number;
}

export interface LiveConversationEvidence {
  context: Readonly<HermesConversationContext>;
  adapter_id: string;
  lifecycle_generation: number;
  observed_at: number;
}

export function installHermesConversationSchema(db: Database): void {
  // Independent of peers: collecting a visible ephemeral row must not destroy
  // the saved mailbox's UUID. Full K is unique; shortened names are only labels.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hermes_conversations (
      home TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      peer_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      summary TEXT NOT NULL DEFAULT '',
      current_session_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      backend_id TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK(generation > 0),
      lifecycle_generation INTEGER NOT NULL CHECK(lifecycle_generation >= 0),
      state TEXT NOT NULL CHECK(state IN ('active','reaped','closed','suspended','orphaned','disposed')),
      owner_lease_until INTEGER NOT NULL,
      observed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(home, conversation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_hermes_conversations_state_lease
      ON hermes_conversations(state, owner_lease_until);
  `);
}

export class HermesConversationBindings {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  get(peerId: string): ConversationBinding | null {
    return this.db.query<ConversationBinding, [string]>(
      "SELECT * FROM hermes_conversations WHERE peer_id = ?",
    ).get(peerId);
  }

  private byKey(context: HermesConversationContext): ConversationBinding | null {
    return this.db.query<ConversationBinding, [string, string]>(
      "SELECT * FROM hermes_conversations WHERE home = ? AND conversation_id = ?",
    ).get(context.home, context.conversation_id);
  }

  private validateEvidence(evidence: LiveConversationEvidence): number {
    const ctx = evidence.context;
    parseHermesConversationContext({
      "hermes/home": ctx.home, "hermes/conversation_id": ctx.conversation_id,
      "hermes/session_id": ctx.session_id, "hermes/platform": ctx.platform,
      "hermes/backend_id": ctx.backend_id, "hermes/ui_session_id": ctx.ui_session_id,
    }, { home: ctx.home, backend_id: ctx.backend_id });
    const now = this.now();
    if (!Number.isSafeInteger(evidence.observed_at) || evidence.observed_at > now
        || now - evidence.observed_at > HERMES_SNAPSHOT_MAX_AGE_MS
        || !Number.isSafeInteger(evidence.lifecycle_generation) || evidence.lifecycle_generation < 0
        || !evidence.adapter_id.trim()) {
      throw new Error("invalid_lifecycle_evidence");
    }
    return now;
  }

  private checkOwner(owner: ConversationOwner, requireLive = true): ConversationBinding {
    const row = this.get(owner.peer_id);
    if (!row || row.generation !== owner.generation || row.backend_id !== owner.backend_id
        || row.adapter_id !== owner.adapter_id
        || (requireLive && (row.state !== "active" || row.owner_lease_until <= this.now()))) {
      throw new Error("stale_conversation_owner");
    }
    return row;
  }

  claim(evidence: LiveConversationEvidence, profile: string): ConversationBinding {
    return this.db.transaction(() => {
      const now = this.validateEvidence(evidence);
      const ctx = evidence.context;
      const old = this.byKey(ctx);
      if (old?.state === "disposed" || old?.state === "orphaned") {
        throw new Error("conversation_not_resumable");
      }
      if (old?.state === "active" && old.owner_lease_until > now) {
        if (old.adapter_id !== evidence.adapter_id || old.backend_id !== ctx.backend_id) {
          throw new Error("conversation_owned");
        }
        this.refresh(old, evidence);
        return this.get(old.peer_id)!;
      }
      // The host's lifecycle sequence resets with a backend; observation order
      // does not. A delayed old-backend snapshot must never reopen a newer close.
      const needsNewLifecycle = old && (old.state === "closed" || old.state === "reaped"
        || old.current_session_id !== ctx.session_id);
      if (old && (evidence.observed_at <= old.observed_at
          || (old.backend_id === ctx.backend_id
              && (evidence.lifecycle_generation < old.lifecycle_generation
                  || (needsNewLifecycle && evidence.lifecycle_generation === old.lifecycle_generation))))) {
        throw new Error("stale_lifecycle_evidence");
      }
      const name = old?.name ?? this.availableName(ctx, profile);
      const peerId = old?.peer_id ?? randomUUID();
      this.db.query(`
        INSERT INTO hermes_conversations
          (home, conversation_id, peer_id, name, current_session_id, platform,
           backend_id, adapter_id, generation, lifecycle_generation, state,
           owner_lease_until, observed_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
        ON CONFLICT(home, conversation_id) DO UPDATE SET
          current_session_id=excluded.current_session_id, platform=excluded.platform,
          backend_id=excluded.backend_id, adapter_id=excluded.adapter_id,
          generation=excluded.generation, lifecycle_generation=excluded.lifecycle_generation,
          state='active', owner_lease_until=excluded.owner_lease_until,
          observed_at=excluded.observed_at, updated_at=excluded.updated_at
      `).run(ctx.home, ctx.conversation_id, peerId, name, ctx.session_id, ctx.platform,
        ctx.backend_id, evidence.adapter_id, (old?.generation ?? 0) + 1,
        evidence.lifecycle_generation, evidence.observed_at + HERMES_OWNER_LEASE_MS,
        evidence.observed_at, old?.created_at ?? now, now);
      return this.get(peerId)!;
    })();
  }

  private availableName(context: HermesConversationContext, profile: string): string {
    for (let length = 12; length <= 64; length += 4) {
      const candidate = conversationName(context, profile, length);
      const reserved = this.db.query("SELECT 1 FROM hermes_conversations WHERE name = ?").get(candidate);
      const visible = this.db.query("SELECT 1 FROM peers WHERE name = ?").get(candidate);
      if (!reserved && !visible) return candidate;
    }
    throw new Error("conversation_name_collision");
  }

  refresh(owner: ConversationOwner, evidence: LiveConversationEvidence): void {
    this.db.transaction(() => {
      const now = this.validateEvidence(evidence);
      const row = this.checkOwner(owner);
      if (conversationKey(row) !== conversationKey(evidence.context)
          || row.backend_id !== evidence.context.backend_id || row.adapter_id !== evidence.adapter_id
          || evidence.lifecycle_generation < row.lifecycle_generation
          || evidence.observed_at < row.observed_at
          || (row.current_session_id !== evidence.context.session_id
              && evidence.lifecycle_generation <= row.lifecycle_generation)) {
        throw new Error("stale_lifecycle_evidence");
      }
      // Replaying a fresh-looking but unchanged snapshot cannot extend ownership
      // indefinitely. Its lease is anchored to host observation, not caller time.
      this.db.query(`UPDATE hermes_conversations SET current_session_id = ?, platform = ?,
        lifecycle_generation = ?, observed_at = ?, owner_lease_until = ?, updated_at = ?
        WHERE peer_id = ?`).run(evidence.context.session_id, evidence.context.platform,
        evidence.lifecycle_generation, evidence.observed_at,
        evidence.observed_at + HERMES_OWNER_LEASE_MS, now, row.peer_id);
    })();
  }

  setSummary(owner: ConversationOwner, summary: string): void {
    this.db.transaction(() => {
      this.checkOwner(owner);
      this.db.query("UPDATE hermes_conversations SET summary = ?, updated_at = ? WHERE peer_id = ?")
        .run(summary, this.now(), owner.peer_id);
    })();
  }

  release(
    owner: ConversationOwner,
    state: "reaped" | "closed" | "orphaned",
    lifecycleGeneration: number,
    observedAt: number,
  ): void {
    this.db.transaction(() => {
      const row = this.checkOwner(owner);
      this.validateEvidence({ context: { ...row, session_id: row.current_session_id },
        adapter_id: row.adapter_id, lifecycle_generation: lifecycleGeneration, observed_at: observedAt });
      if (lifecycleGeneration <= row.lifecycle_generation || observedAt < row.observed_at) {
        throw new Error("stale_lifecycle_evidence");
      }
      this.db.query(`UPDATE hermes_conversations SET state = ?, lifecycle_generation = ?,
        observed_at = ?, owner_lease_until = 0, updated_at = ? WHERE peer_id = ?`)
        .run(state, lifecycleGeneration, observedAt, this.now(), row.peer_id);
      // Tokens and visible rows are managed by the broker integration, not by
      // this store. Releasing a binding never touches message or inbox contents.
    })();
  }

  expire(): number {
    return this.db.query(`UPDATE hermes_conversations SET state = 'suspended',
      updated_at = ? WHERE state = 'active' AND owner_lease_until <= ?`)
      .run(this.now(), this.now()).changes;
  }

  status(): { active: number; dormant: number; orphaned: number; disposed: number } {
    const counts = { active: 0, dormant: 0, orphaned: 0, disposed: 0 };
    for (const row of this.db.query<{ state: ConversationState; n: number }, [number]>(
      `SELECT CASE WHEN state = 'active' AND owner_lease_until <= ? THEN 'suspended'
        ELSE state END AS state, COUNT(*) AS n FROM hermes_conversations GROUP BY 1`,
    ).all(this.now())) {
      if (row.state === "active" || row.state === "orphaned" || row.state === "disposed") counts[row.state] += row.n;
      else counts.dormant += row.n;
    }
    return counts;
  }
}

export function dormantMailboxNotice(state: ConversationState): string | undefined {
  const notices: Partial<Record<ConversationState, string>> = {
    closed: "queued to dormant mailbox; recipient closed, will not be woken",
    reaped: "queued to dormant mailbox; automatic reap, exact-session resume pending",
    suspended: "queued to dormant mailbox; backend unavailable, wake pending",
    orphaned: "queued to orphaned mailbox; chat deleted, operator action required",
  };
  return notices[state];
}
