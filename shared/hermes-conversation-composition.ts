// Runtime composition with an injected authenticated host bridge. No wire RPC,
// credential discovery, or environment switch is inferred here.
import type { Database } from "bun:sqlite";
import { HermesConversationAdapter } from "./hermes-conversation-adapter.ts";
import type { HermesConversationBroker } from "./hermes-conversation-broker.ts";
import type { ConversationBinding } from "./hermes-conversation-bindings.ts";
import { conversationKey, type HermesConversationContext } from "./hermes-conversation-context.ts";
import { HermesConversationLifecyclePort, installHermesLifecyclePortSchema } from "./hermes-conversation-lifecycle-port.ts";
import { freezeLifecycleInventory, type LifecycleInventory } from "./hermes-conversation-lifecycle.ts";
import {
  HermesConversationWakeCoordinator, installHermesWakeSchema,
  type WakeCandidate, type WakeLifecycle, type WakeReceipt, type WakeRequest,
} from "./hermes-conversation-wake.ts";

export interface HermesConversationHostBridge {
  // Positive registry/readback authority, including native surfaces. Hooks alone
  // are not sufficient. Observation time means request START, not completion.
  observe(context: Readonly<HermesConversationContext>, signal: AbortSignal): Promise<WakeLifecycle | null>;
  // The bridge owns bounded wire batching/deduplication and complete/unknown
  // translation. Its normalized result has one observation per exact root.
  inventory(conversationIds: readonly string[], signal: AbortSignal): Promise<LifecycleInventory>;
  admit(request: Readonly<WakeRequest>, signal: AbortSignal): Promise<WakeReceipt>;
  reconcile(request: Readonly<WakeRequest>, signal: AbortSignal): Promise<WakeReceipt>;
  close(): Promise<void>;
}

function sameContext(a: Readonly<HermesConversationContext>, b: Readonly<HermesConversationContext>): boolean {
  return a.home === b.home && a.backend_id === b.backend_id && a.conversation_id === b.conversation_id
    && a.session_id === b.session_id && a.platform === b.platform && a.ui_session_id === b.ui_session_id;
}

export class HermesConversationComposition {
  readonly adapter: HermesConversationAdapter;
  private readonly lifecycle: HermesConversationLifecyclePort;
  private readonly wake: HermesConversationWakeCoordinator;
  private readonly abort = new AbortController();
  private running?: Promise<void>;
  private closing?: Promise<void>;
  private stopped = false;
  private readonly ownsBackend: () => boolean;
  private candidates: readonly WakeCandidate[] = [];
  private readonly scope: Readonly<{ home: string; backend_id: string; adapter_id: string }>;

  constructor(private readonly db: Database, private readonly broker: HermesConversationBroker,
    private readonly host: HermesConversationHostBridge,
    options: { home: string; backend_id: string; adapter_id: string; inboxRoot: string; onTick: () => void;
      ownsBackend: () => boolean }) {
    this.scope = Object.freeze({ home: options.home, backend_id: options.backend_id, adapter_id: options.adapter_id });
    this.ownsBackend = options.ownsBackend;
    installHermesLifecyclePortSchema(db);
    installHermesWakeSchema(db);
    this.adapter = new HermesConversationAdapter({
      home: options.home, backend_id: options.backend_id, inboxRoot: options.inboxRoot, onTick: options.onTick,
      broker: {
        bind: context => this.bind(context),
        poll: owner => broker.poll(owner),
        ack: (owner, tokens) => broker.ack(owner, tokens),
        invoke: (owner, tool, args) => broker.invoke(owner, tool, args),
        release: () => { throw new Error("authoritative_lifecycle_release_required"); },
      },
    });
    this.lifecycle = new HermesConversationLifecyclePort(db, broker, this.adapter, this.scope);
    this.wake = new HermesConversationWakeCoordinator(db, {
      snapshot: (candidate, signal) => host.observe(candidate.context, signal),
      current: async candidate => this.current(candidate),
      admit: (request, signal) => {
        const candidate = this.candidates.find(row => row.peer_id === request.peer_id
          && row.binding_generation === request.binding_generation && sameContext(row.context, request.context));
        if (!candidate || !this.current(candidate)) throw new Error("conversation_owner_changed");
        return host.admit(request, signal);
      },
      reconcile: (request, signal) => host.reconcile(request, signal),
    });
  }

  private async bounded<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const stop = () => controller.abort();
    const timer = setTimeout(stop, 5_000);
    this.abort.signal.addEventListener("abort", stop, { once: true });
    if (this.abort.signal.aborted) stop();
    let rejectAbort!: () => void;
    try {
      return await new Promise<T>((resolve, reject) => {
        rejectAbort = () => reject(new Error("host_observation_cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
        if (controller.signal.aborted) { rejectAbort(); return; }
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return call(controller.signal);
        }).then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", rejectAbort);
      this.abort.signal.removeEventListener("abort", stop);
    }
  }

  private async bind(context: Readonly<HermesConversationContext>) {
    const observed = await this.bounded(signal => this.host.observe(context, signal));
    if (this.stopped || !observed || !sameContext(observed.context, context)
        || observed.state !== "live" || observed.end_reason !== null) throw new Error("host_not_live");
    // The broker validates sequence and freshness inside the same transaction.
    const evidence = structuredClone(observed);
    return this.db.transaction(() => {
      if (!this.ownsBackend()) throw new Error("adapter_process_not_owner");
      const old = this.db.query<ConversationBinding, [string, string]>(
        "SELECT * FROM hermes_conversations WHERE home=? AND conversation_id=?").get(context.home, context.conversation_id);
      if (old?.backend_id === context.backend_id && !this.db.query(
        "SELECT 1 FROM hermes_lifecycle_sequences WHERE peer_id=? AND backend_id=?").get(old.peer_id, context.backend_id)) {
        throw new Error("counter_namespace_required");
      }
      const owner = this.broker.bindObserved(context, { context, adapter_id: this.scope.adapter_id,
        lifecycle_generation: evidence.lifecycle_generation, observed_at: evidence.observed_at });
      this.db.query(`INSERT INTO hermes_lifecycle_sequences VALUES (?,?)
        ON CONFLICT(peer_id) DO UPDATE SET backend_id=excluded.backend_id`).run(owner.peer_id, context.backend_id);
      return owner;
    }).immediate();
  }

  private bindings(): ConversationBinding[] {
    return this.db.query<ConversationBinding, [string]>(
      "SELECT * FROM hermes_conversations WHERE home=? ORDER BY conversation_id").all(this.scope.home);
  }

  private unread(peerId: string): number[] {
    return this.db.query<{ id: number }, [string]>(
      "SELECT id FROM messages WHERE to_id=? AND acked=0 ORDER BY id").all(peerId).map(row => row.id);
  }

  private current(candidate: Readonly<WakeCandidate>): boolean {
    if (this.stopped || !this.ownsBackend() || !this.adapter.canWake(candidate.context)) return false;
    const row = this.broker.bindings.get(candidate.peer_id);
    return !!row && row.home === candidate.context.home && row.conversation_id === candidate.context.conversation_id
      && row.current_session_id === candidate.context.session_id && row.platform === candidate.context.platform
      && row.backend_id === candidate.context.backend_id && row.adapter_id === this.scope.adapter_id
      && row.generation === candidate.binding_generation && row.state === candidate.state
      && (row.state !== "active" || row.owner_lease_until > Date.now())
      && JSON.stringify(this.unread(row.peer_id)) === JSON.stringify([...candidate.unread_ids].sort((a, b) => a - b));
  }

  // Preparation proves host availability before connecting stdio, but never
  // admits a turn before the MCP server can receive its tool calls.
  prepare(): Promise<void> { return this.run(false); }
  tick(): Promise<void> { return this.run(true); }

  private run(admit: boolean): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("composition_stopped"));
    if (this.running) return this.running;
    const work = this.pass(admit);
    this.running = work.finally(() => { this.running = undefined; });
    return this.running;
  }

  private async pass(admit: boolean): Promise<void> {
    if (!this.ownsBackend()) throw new Error("adapter_process_not_owner");
    const inventory = freezeLifecycleInventory(await this.bounded(signal => this.host.inventory(
      this.bindings().map(row => row.conversation_id), signal)), this.scope);
    if (this.stopped) return;
    // Still retry committed local cleanup on unavailable inventory.
    if (!inventory) {
      await this.lifecycle.reconcile({ ...this.scope, observed_at: Date.now(), inventory_complete: false, observations: [] });
      return;
    }
    this.handoff(inventory);
    const decisions = await this.lifecycle.reconcile(inventory);
    if (this.stopped || !admit
        || Date.now() - inventory.observed_at > 10_000) return;
    const eligible = new Set(decisions.filter(row => ["renewed", "released", "unchanged"].includes(row.result))
      .map(row => row.peer_id));
    const observations = new Map(inventory.observations.map(row => [conversationKey(row.context), row]));
    const candidates: WakeCandidate[] = [];
    for (const binding of this.bindings()) {
      if (!eligible.has(binding.peer_id) || binding.backend_id !== this.scope.backend_id || binding.adapter_id !== this.scope.adapter_id) continue;
      const row = observations.get(conversationKey(binding));
      if (!row || row.state === "unknown" || row.context.session_id !== binding.current_session_id) continue;
      candidates.push({ peer_id: binding.peer_id, context: row.context, binding_generation: binding.generation,
        state: binding.state, unread_ids: this.unread(binding.peer_id) });
    }
    this.candidates = candidates;
    try { await this.wake.run(candidates, this.abort.signal); }
    finally { this.candidates = []; }
  }

  private handoff(inventory: Readonly<LifecycleInventory>): void {
    // Runtime has exclusively claimed this backend after proving the prior MCP
    // dead or completing its shutdown. Host evidence is still required per K.
    const rows = new Map(inventory.observations.map(row => [conversationKey(row.context), row]));
    for (const expected of this.bindings()) {
      try { this.db.transaction(() => {
        if (!this.ownsBackend()) throw new Error("adapter_process_not_owner");
        const old = this.broker.bindings.get(expected.peer_id);
        if (!old || JSON.stringify(old) !== JSON.stringify(expected)) return;
        if (old.backend_id !== this.scope.backend_id || old.adapter_id === this.scope.adapter_id
            || old.state === "disposed" || old.state === "orphaned"
            || old.state === "active" && old.owner_lease_until > Date.now()) return;
        const row = rows.get(conversationKey(old));
        if (!row || inventory.observed_at <= old.observed_at || Date.now() - inventory.observed_at > 10_000
            || !this.db.query("SELECT 1 FROM hermes_lifecycle_sequences WHERE peer_id=? AND backend_id=?")
              .get(old.peer_id, old.backend_id)) return;
        if (row.state === "live" && row.end_reason === null) {
          this.broker.bindObserved(row.context, { context: row.context, adapter_id: this.scope.adapter_id,
            lifecycle_generation: row.lifecycle_generation, observed_at: inventory.observed_at });
        } else if (old.state === "reaped" && row.state === "reaped" && row.end_reason === "automatic_reap"
            && row.context.platform !== "cron" && row.context.platform === old.platform
            && row.context.session_id === old.current_session_id && row.lifecycle_generation === old.lifecycle_generation) {
          this.db.query(`UPDATE hermes_conversations SET adapter_id=?,generation=generation+1,observed_at=?,updated_at=?
            WHERE peer_id=?`).run(this.scope.adapter_id, inventory.observed_at, Date.now(), old.peer_id);
          this.db.query("DELETE FROM peers WHERE id=?").run(old.peer_id);
          this.db.query("DELETE FROM hermes_conversation_tokens WHERE peer_id=?").run(old.peer_id);
        }
      }).immediate(); }
      catch (error) {
        // One stale/superseded target is not a backend failure. Each target has
        // its own transaction; real database/claim errors still fail closed.
        if (!(error instanceof Error) || !["stale_lifecycle_evidence", "superseded_conversation_segment",
          "conversation_owned", "conversation_not_resumable"].includes(error.message)) throw error;
      }
    }
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.abort.abort();
    this.closing = (async () => {
      const results = await Promise.allSettled([this.adapter.stop(), this.running]);
      await this.host.close();
      // Cancelling our in-flight inventory/receipt RPC is normal shutdown.
      if (results[0]?.status === "rejected") throw results[0].reason;
    })();
    return this.closing;
  }
}
