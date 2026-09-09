// Fixture-only pairing of the normalized lifecycle engine with real broker and
// adapter seams. No runtime imports this or installs its provenance table yet.
import type { Database } from "bun:sqlite";
import type { HermesConversationAdapter } from "./hermes-conversation-adapter.ts";
import type { HermesConversationBroker } from "./hermes-conversation-broker.ts";
import {
  HermesConversationLifecycleReconciler, lifecycleReleaseState,
  type LifecycleBinding, type LifecycleChange, type LifecycleDecision, type LifecycleInventory,
} from "./hermes-conversation-lifecycle.ts";

export function installHermesLifecyclePortSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hermes_lifecycle_sequences (
    peer_id TEXT PRIMARY KEY REFERENCES hermes_conversations(peer_id),
    backend_id TEXT NOT NULL
  )`);
}

export class HermesConversationLifecyclePort {
  private readonly scope: Readonly<{ home: string; backend_id: string; adapter_id: string }>;
  // Process-local cleanup obligations, one latest fence per peer. Keep this
  // port for the adapter lifetime; process death already discards local calls.
  private readonly pendingDrains = new Map<string, Readonly<LifecycleChange>>();
  constructor(private readonly db: Database, private readonly broker: HermesConversationBroker,
    private readonly adapter: Pick<HermesConversationAdapter, "drainFenced">,
    scope: { home: string; backend_id: string; adapter_id: string }) {
    this.scope = Object.freeze({ ...scope });
  }

  private binding(peerId: string): LifecycleBinding | null {
    const binding = this.broker.bindings.get(peerId);
    if (!binding) return null;
    const marker = this.db.query<{ backend_id: string }, [string]>(
      "SELECT backend_id FROM hermes_lifecycle_sequences WHERE peer_id=?").get(peerId);
    return { ...binding, sequence_source: marker?.backend_id === binding.backend_id ? "host" : "dispatch" };
  }

  // No await between expected-binding comparison, broker state/token changes
  // and provenance persistence. Drain starts synchronously after commit, and
  // the returned promise waits for actual in-flight callbacks to settle.
  async reconcile(inventory: LifecycleInventory): Promise<LifecycleDecision[]> {
    const engine = new HermesConversationLifecycleReconciler(this.scope, {
      bindings: () => this.db.query<{ peer_id: string }, [string]>(
        "SELECT peer_id FROM hermes_conversations WHERE home=? ORDER BY conversation_id").all(this.scope.home)
        .map(row => this.binding(row.peer_id)!),
      apply: change => {
        const applied = this.apply(change);
        if (applied && change.action === "release") {
          this.pendingDrains.set(change.expected.peer_id, change);
        }
        return applied;
      },
    });
    const results = engine.reconcile(inventory);
    // A failed drain is independent of the already committed terminal state.
    // Retry it even when the next inventory is unchanged or renews a new epoch;
    // the adapter's owner fence protects any newer local slot.
    await Promise.all([...this.pendingDrains].map(async ([id, change]) => {
      const meta = Object.fromEntries(Object.entries(change.observation.context).map(([key, value]) => [`hermes/${key}`, value]));
      await this.adapter.drainFenced(meta, change.expected);
      if (this.pendingDrains.get(id) === change) this.pendingDrains.delete(id);
    }));
    return results;
  }

  private apply(change: Readonly<LifecycleChange>): boolean {
    return this.db.transaction(() => {
      const current = this.binding(change.expected.peer_id);
      if (!current || JSON.stringify(current) !== JSON.stringify(change.expected)) return false;
      if (change.action === "renew") {
        const owner = this.broker.bindObserved(change.observation.context, {
          context: change.observation.context, adapter_id: change.adapter_id,
          lifecycle_generation: change.observation.lifecycle_generation, observed_at: change.observed_at,
        });
        if (owner.peer_id !== current.peer_id) throw new Error("lifecycle_peer_changed");
      } else {
        this.broker.bindings.release(current, lifecycleReleaseState(change.observation),
          change.observation.lifecycle_generation, change.observed_at);
        this.db.query("DELETE FROM peers WHERE id=?").run(current.peer_id);
        this.db.query("DELETE FROM hermes_conversation_tokens WHERE peer_id=?").run(current.peer_id);
      }
      this.db.query(`INSERT INTO hermes_lifecycle_sequences VALUES (?,?)
        ON CONFLICT(peer_id) DO UPDATE SET backend_id=excluded.backend_id`)
        .run(current.peer_id, change.observation.context.backend_id);
      return true;
    }).immediate();
  }
}
