// Fixture-stage T2 reconciliation. No runtime importer or host RPC translation.
// The input is authenticated host evidence, never a model's tool arguments.
import {
  HERMES_SNAPSHOT_MAX_AGE_MS, type ConversationBinding, type ConversationState,
} from "./hermes-conversation-bindings.ts";
import { canonicalProfileHome, conversationKey, parseHermesConversationContext,
  type HermesConversationContext } from "./hermes-conversation-context.ts";

export interface LifecycleObservation {
  context: Readonly<HermesConversationContext>;
  lifecycle_generation: number;
  state: "live" | "closed" | "reaped" | "unknown";
  end_reason: string | null;
}

// Internal normalized shape, not a claim about an unfrozen Hermes wire schema.
export interface LifecycleInventory {
  home: string;
  backend_id: string;
  observed_at: number;
  inventory_complete: boolean;
  observations: readonly LifecycleObservation[];
}

export interface LifecycleBinding extends ConversationBinding {
  // Missing marker means T1 dispatch ordering. The bridge must persist this
  // provenance with a successful host-derived renewal, not infer it from a count.
  sequence_source?: "host" | "dispatch";
}

export interface LifecycleChange {
  action: "renew" | "release";
  expected: Readonly<LifecycleBinding>;
  observation: Readonly<LifecycleObservation>;
  observed_at: number;
  adapter_id: string;
}

export interface LifecyclePorts {
  bindings(): readonly LifecycleBinding[];
  // Local synchronous transaction: compare expected binding epoch/state/segment/
  // ordering, apply the host evidence and persist sequence provenance together.
  // Renew must maintain the visible peer/token without changing status or mail.
  // Release must revoke visibility/token without acknowledging or deleting mail.
  apply(change: Readonly<LifecycleChange>): boolean;
}

export interface LifecycleDecision {
  peer_id: string;
  result: "renewed" | "released" | "unchanged" | "unknown" | "stale" | "unavailable" | "counter_namespace_required";
}

function copyContext(context: Readonly<HermesConversationContext>, expected: { home: string; backend_id: string }) {
  return parseHermesConversationContext(Object.fromEntries(
    Object.entries(context).map(([key, value]) => [`hermes/${key}`, value]),
  ), expected);
}

export class HermesConversationLifecycleReconciler {
  private readonly scope: Readonly<{ home: string; backend_id: string; adapter_id: string }>;
  constructor(scope: { home: string; backend_id: string; adapter_id: string },
    private readonly ports: LifecyclePorts, private readonly now: () => number = Date.now) {
    if (!scope.backend_id || !scope.adapter_id) throw new Error("invalid_lifecycle_scope");
    this.scope = Object.freeze({ ...scope, home: canonicalProfileHome(scope.home) });
  }

  reconcile(inventory: LifecycleInventory): LifecycleDecision[] {
    const now = this.now();
    if (inventory.home !== this.scope.home || inventory.backend_id !== this.scope.backend_id) {
      throw new Error("lifecycle_scope_mismatch");
    }
    if (inventory.inventory_complete !== true || !Number.isSafeInteger(inventory.observed_at)
        || inventory.observed_at > now || now - inventory.observed_at > HERMES_SNAPSHOT_MAX_AGE_MS) {
      return [];
    }
    // Freeze the whole pass before a binding read or an apply callback. Missing
    // rows never become close commands, even in an allegedly complete inventory.
    const observedAt = inventory.observed_at;
    const rows = new Map<string, Readonly<LifecycleObservation>>();
    for (const row of inventory.observations) {
      const context = copyContext(row.context, this.scope);
      const key = conversationKey(context);
      if (rows.has(key)) throw new Error("ambiguous_lifecycle_inventory");
      if (!Number.isSafeInteger(row.lifecycle_generation) || row.lifecycle_generation < 0
          || !["live", "closed", "reaped", "unknown"].includes(row.state)
          || row.end_reason !== null && typeof row.end_reason !== "string") {
        throw new Error("invalid_lifecycle_observation");
      }
      rows.set(key, Object.freeze({ context, lifecycle_generation: row.lifecycle_generation,
        state: row.state, end_reason: row.end_reason }));
    }
    const bindings = this.ports.bindings().map(binding => Object.freeze({ ...binding }));
    const results: LifecycleDecision[] = [];
    for (const binding of bindings) {
      if (binding.home !== this.scope.home) continue;
      const row = rows.get(conversationKey(binding));
      const result = (value: LifecycleDecision["result"]) => results.push({ peer_id: binding.peer_id, result: value });
      if (!row || row.state === "unknown" || !this.knownReason(row)) { result("unknown"); continue; }
      if (binding.state === "disposed" || binding.state === "orphaned") { result("unchanged"); continue; }
      if (this.now() - observedAt > HERMES_SNAPSHOT_MAX_AGE_MS || observedAt < binding.observed_at) {
        result("stale"); continue;
      }
      const sameBackend = binding.backend_id === this.scope.backend_id;
      if (sameBackend && binding.sequence_source !== "host") { result("counter_namespace_required"); continue; }
      const terminal = row.state !== "live";
      if (!sameBackend) {
        // New backend UUID permits counter reset, not stealing a live owner's
        // lease or applying another backend's terminal event.
        if (terminal || observedAt <= binding.observed_at
            || binding.state === "active" && binding.owner_lease_until > this.now()) {
          result("stale"); continue;
        }
      } else {
        if (binding.adapter_id !== this.scope.adapter_id) { result("stale"); continue; }
        const changesLifecycle = terminal || binding.current_session_id !== row.context.session_id
          || binding.state === "closed" || binding.state === "reaped";
        if (row.lifecycle_generation < binding.lifecycle_generation
            || changesLifecycle && row.lifecycle_generation === binding.lifecycle_generation) {
          // Repeated identical terminal evidence is a no-op, not a resurrection.
          result(terminal && row.state === binding.state
            && row.lifecycle_generation === binding.lifecycle_generation
            && row.context.session_id === binding.current_session_id ? "unchanged" : "stale");
          continue;
        }
      }
      if (terminal && (!["active", "suspended"].includes(binding.state)
          || row.context.session_id !== binding.current_session_id)) {
        result("stale"); continue;
      }
      const change = Object.freeze({ action: terminal ? "release" as const : "renew" as const,
        expected: binding, observation: row, observed_at: observedAt, adapter_id: this.scope.adapter_id });
      try { result(this.ports.apply(change) ? terminal ? "released" : "renewed" : "stale"); }
      catch { result("unavailable"); }
    }
    return results;
  }

  private knownReason(row: Readonly<LifecycleObservation>): boolean {
    if (row.state === "live") return row.end_reason === null;
    if (row.state === "reaped") return row.end_reason === "automatic_reap" && row.context.platform !== "cron";
    return row.state === "closed" && ["explicit_close", "run_completed"].includes(row.end_reason ?? "");
  }
}

// Useful to adapters implementing the transactional port; no untyped fallback
// from missing terminal reason to close is allowed.
export function lifecycleReleaseState(row: Readonly<LifecycleObservation>): Extract<ConversationState, "closed" | "reaped"> {
  if (row.state !== "closed" && row.state !== "reaped") throw new Error("terminal_lifecycle_required");
  return row.state;
}
