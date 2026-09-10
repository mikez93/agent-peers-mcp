// Lifecycle/wake translator pinned to Hermes 65d7a5b06a (Kepler9908).
// The caller supplies its existing authenticated, ID-correlated RPC transport.
// This module does not discover credentials, open sockets, or execute model work.
import { canonicalProfileHome, parseHermesConversationContext, type HermesConversationContext } from "./hermes-conversation-context.ts";
import type { HermesConversationHostBridge } from "./hermes-conversation-composition.ts";
import type { LifecycleInventory, LifecycleObservation } from "./hermes-conversation-lifecycle.ts";
import type { WakeLifecycle, WakeReceipt, WakeRequest } from "./hermes-conversation-wake.ts";

export interface HermesLifecycleRpc {
  // Resolve the JSON-RPC result only; reject RPC errors (including 4004/5036).
  request(method: "session.lifecycle_snapshot",
    params: Readonly<{ profile?: string; conversation_ids: readonly string[] }>, signal: AbortSignal): Promise<unknown>;
  request(method: "session.wake_admit" | "session.wake_reconcile",
    params: Readonly<WakeRequest>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

type Row = { observation: LifecycleObservation; busy: boolean; queued: boolean; compacting: boolean;
  changed_at: number; session_ended_at: number | null };
type Snapshot = { observed_at: number; complete: boolean; rows: Map<string, Row>; liveSignature: string };
const REAP = new Set(["idle_timeout", "lru_evict", "ws_orphan_reap"]);
const RECEIPTS = new Set(["absent", "unknown", "deferred", "rejected", "accepted", "started", "completed", "cancelled"]);
const SUPPORTED = new Set(["desktop", "tui", "cli", "cron"]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_gui_snapshot");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 4096
      || /[\x00-\x1f\x7f]/.test(value)) throw new Error("invalid_gui_identifier");
  return value;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("invalid_gui_sequence_or_time");
  return value as number;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid_gui_boolean");
  return value;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function sameContext(a: Readonly<HermesConversationContext>, b: Readonly<HermesConversationContext>): boolean {
  return a.home === b.home && a.backend_id === b.backend_id && a.conversation_id === b.conversation_id
    && a.session_id === b.session_id && a.platform === b.platform && a.ui_session_id === b.ui_session_id;
}

export class HermesGuiLifecycleBridge implements HermesConversationHostBridge {
  private readonly scope: Readonly<{ home: string; backend_id: string }>;
  private readonly profile?: string;
  private readonly stopSignal = new AbortController();
  private closing?: Promise<void>;

  constructor(scope: { home: string; backend_id: string }, private readonly rpc: HermesLifecycleRpc,
    options: { profile?: string } = {}) {
    this.scope = Object.freeze({ home: canonicalProfileHome(scope.home), backend_id: text(scope.backend_id) });
    // This is an existing profile selector, never derived from canonical home.
    if (options.profile !== undefined) this.profile = text(options.profile);
  }

  private parse(value: unknown, targets: readonly string[]): Snapshot {
    const data = record(value);
    if (data.home !== this.scope.home || data.backend_id !== this.scope.backend_id) throw new Error("gui_snapshot_scope_mismatch");
    const observed_at = positive(data.observed_at);
    if (observed_at > Date.now() || Date.now() - observed_at > 10_000) throw new Error("stale_gui_snapshot");
    const complete = bool(data.inventory_complete);
    if (!Array.isArray(data.unknown_runtime_ids) || !Array.isArray(data.sessions) || !Array.isArray(data.terminal)) {
      throw new Error("invalid_gui_inventory");
    }
    data.unknown_runtime_ids.forEach(text);
    const rows = new Map<string, Row>(), seen = new Set<string>();
    const live: [string, Row][] = [];
    for (const [values, isLive] of [[data.sessions, true], [data.terminal, false]] as const) {
      for (const value of values) {
        const row = record(value), id = text(row.conversation_id);
        if (seen.has(id) || !isLive && !targets.includes(id)) throw new Error("ambiguous_gui_inventory");
        seen.add(id);
        if (!isLive && row.state === "unknown") {
          if (Object.keys(row).length !== 2) throw new Error("invalid_gui_unknown");
          continue; // Missing full identity is unknown, never a fabricated close.
        }
        const context = parseHermesConversationContext(Object.fromEntries(
          ["home", "backend_id", "conversation_id", "session_id", "platform", "ui_session_id"]
            .map(key => [`hermes/${key}`, row[key]])), this.scope);
        if (!SUPPORTED.has(context.platform)
            || ["desktop", "tui"].includes(context.platform) !== !!context.ui_session_id) {
          throw new Error("invalid_runtime_surface_identity");
        }
        const generation = positive(row.lifecycle_generation), changed_at = positive(row.changed_at);
        let reason: string | null = null;
        let state: LifecycleObservation["state"] = "unknown";
        let ended: number | null = null;
        let busy = false, queued = false, compacting = false;
        if (isLive) {
          if (row.state !== "live" || row.end_reason !== null || row.session_ended_at !== null) throw new Error("invalid_gui_live");
          busy = bool(row.busy); queued = bool(row.queued); compacting = bool(row.compacting);
          state = "live";
        } else {
          if (!["closed", "reaped"].includes(row.state as string) || typeof row.session_ended_at !== "number"
              || !Number.isFinite(row.session_ended_at) || ["busy", "queued", "compacting"].some(key => key in row)) {
            throw new Error("invalid_gui_terminal");
          }
          ended = row.session_ended_at;
          const rawReason = text(row.end_reason);
          if (row.state === "reaped" && REAP.has(rawReason)) { state = "reaped"; reason = "automatic_reap"; }
          else if (row.state === "closed" && ["tui_close", "cli_close"].includes(rawReason)) {
            state = "closed"; reason = "explicit_close";
          }
          // Other reasons stay unknown. Do not invent run_completed or treat
          // disconnect/shutdown as an authorized automatic resurrection.
        }
        const parsed: Row = { observation: { context, lifecycle_generation: generation, state, end_reason: reason },
          busy, queued, compacting, changed_at, session_ended_at: ended };
        rows.set(id, parsed);
        if (isLive) live.push([id, parsed]);
      }
    }
    return { observed_at, complete: complete && data.unknown_runtime_ids.length === 0, rows,
      liveSignature: JSON.stringify(live.sort(([a], [b]) => a.localeCompare(b))) };
  }

  private async collect(ids: readonly string[], signal: AbortSignal): Promise<Snapshot | null> {
    const targets = [...new Set(ids.map(text))];
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.stopSignal.signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || this.stopSignal.signal.aborted) abort();
    const timer = setTimeout(abort, 5_000); // One deadline for the entire batch set.
    let abortReject: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        abortReject = () => reject(new Error("gui_snapshot_cancelled"));
        controller.signal.addEventListener("abort", abortReject, { once: true });
      });
      const all = new Map<string, Row>();
      let first: Snapshot | undefined, oldest = Infinity;
      for (let offset = 0; offset < Math.max(1, targets.length); offset += 128) {
        controller.signal.throwIfAborted();
        const batch = Object.freeze(targets.slice(offset, offset + 128));
        const params = Object.freeze({ ...(this.profile === undefined ? {} : { profile: this.profile }), conversation_ids: batch });
        const value = await Promise.race([this.rpc.request("session.lifecycle_snapshot", params, controller.signal), cancelled]);
        controller.signal.throwIfAborted();
        const parsed = this.parse(value, batch);
        if (!parsed.complete || first && first.liveSignature !== parsed.liveSignature) return null;
        first ??= parsed;
        oldest = Math.min(oldest, parsed.observed_at);
        for (const [id, row] of parsed.rows) {
          if (all.has(id) && JSON.stringify(all.get(id)) !== JSON.stringify(row)) return null;
          all.set(id, row);
        }
      }
      if (Date.now() - oldest > 10_000) return null;
      return { observed_at: oldest, complete: true, rows: all, liveSignature: first!.liveSignature };
    } catch {
      // RPC errors, malformed data and timeouts are unavailable, not absence.
      return null;
    } finally {
      clearTimeout(timer);
      if (abortReject) controller.signal.removeEventListener("abort", abortReject);
      signal.removeEventListener("abort", abort);
      this.stopSignal.signal.removeEventListener("abort", abort);
    }
  }

  async inventory(conversationIds: readonly string[], signal: AbortSignal): Promise<LifecycleInventory> {
    const result = await this.collect(conversationIds, signal);
    return { ...this.scope, observed_at: result?.observed_at ?? Date.now(),
      inventory_complete: !!result, observations: result ? [...result.rows.values()].map(row => row.observation) : [] };
  }

  async observe(input: Readonly<HermesConversationContext>, signal: AbortSignal): Promise<WakeLifecycle | null> {
    const context = parseHermesConversationContext(Object.fromEntries(
      Object.entries(input).map(([key, value]) => [`hermes/${key}`, value])), this.scope);
    const result = await this.collect([context.conversation_id], signal), row = result?.rows.get(context.conversation_id);
    if (!result || !row || row.observation.state === "unknown"
        || !sameContext(row.observation.context, context)) return null;
    return { context: row.observation.context, lifecycle_generation: row.observation.lifecycle_generation,
      observed_at: result.observed_at, state: row.observation.state === "live" ? "live" : "terminal",
      end_reason: row.observation.end_reason, busy: row.busy, queued: row.queued, compacting: row.compacting };
  }

  private requestCopy(value: Readonly<WakeRequest>): Readonly<WakeRequest> {
    const keys = ["attempt_id", "attempt_sequence", "peer_id", "context", "binding_generation",
      "expected_lifecycle_generation", "resume", "queued", "hidden", "notice"];
    if (!value || typeof value !== "object" || !exactKeys(value as unknown as Record<string, unknown>, keys)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.attempt_id)
        || ![value.attempt_sequence, value.binding_generation, value.expected_lifecycle_generation]
          .every(number => Number.isSafeInteger(number) && number > 0)
        || typeof value.resume !== "boolean" || value.queued !== true || value.hidden !== true) {
      throw new Error("invalid_wake_request");
    }
    const rawContext = record(value.context);
    const context = parseHermesConversationContext(Object.fromEntries(
      Object.entries(rawContext).map(([key, field]) => [`hermes/${key}`, field])), this.scope);
    text(value.peer_id); text(value.notice);
    if (!SUPPORTED.has(context.platform)
        || ["desktop", "tui"].includes(context.platform) !== !!context.ui_session_id) {
      throw new Error("invalid_wake_surface");
    }
    const contextKeys = ["home", "backend_id", "conversation_id", "session_id", "platform",
      ...(context.ui_session_id ? ["ui_session_id"] : [])];
    if (!exactKeys(rawContext, contextKeys)) throw new Error("invalid_wake_context");
    return Object.freeze({ ...value, context });
  }

  private receipt(value: unknown, request: Readonly<WakeRequest>): WakeReceipt {
    const data = record(value);
    if (!exactKeys(data, ["attempt_id", "attempt_sequence", "context", "state"])
        || data.attempt_id !== request.attempt_id || data.attempt_sequence !== request.attempt_sequence
        || !RECEIPTS.has(data.state as string)) throw new Error("wake_receipt_mismatch");
    const rawContext = { ...record(data.context) };
    if (["cli", "cron"].includes(String(rawContext.platform))) {
      // Hermes stores a fixed six-field receipt identity and represents the
      // native-only optional UI field as null; MCP metadata omits it.
      if (rawContext.ui_session_id !== null) throw new Error("wake_receipt_mismatch");
      delete rawContext.ui_session_id;
    }
    const context = parseHermesConversationContext(Object.fromEntries(
      Object.entries(rawContext).map(([key, field]) => [`hermes/${key}`, field])), this.scope);
    if (!exactKeys(rawContext, Object.keys(request.context))) {
      throw new Error("wake_receipt_mismatch");
    }
    if (!sameContext(context, request.context)) throw new Error("wake_receipt_mismatch");
    return Object.freeze({ attempt_id: request.attempt_id, attempt_sequence: request.attempt_sequence,
      context, state: data.state as WakeReceipt["state"] });
  }

  private async wake(method: "session.wake_admit" | "session.wake_reconcile",
    value: Readonly<WakeRequest>, signal: AbortSignal): Promise<WakeReceipt> {
    const request = this.requestCopy(value);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    this.stopSignal.signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || this.stopSignal.signal.aborted) abort();
    const timer = setTimeout(abort, 5_000);
    let rejectAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(new Error("wake_rpc_cancelled"));
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      controller.signal.throwIfAborted();
      const result = await Promise.race([this.rpc.request(method, request, controller.signal), cancelled]);
      controller.signal.throwIfAborted();
      return this.receipt(result, request);
    } finally {
      clearTimeout(timer);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
      signal.removeEventListener("abort", abort);
      this.stopSignal.signal.removeEventListener("abort", abort);
    }
  }
  async admit(value: Readonly<WakeRequest>, signal: AbortSignal): Promise<WakeReceipt> {
    return this.wake("session.wake_admit", value, signal);
  }
  async reconcile(value: Readonly<WakeRequest>, signal: AbortSignal): Promise<WakeReceipt> {
    return this.wake("session.wake_reconcile", value, signal);
  }
  close(): Promise<void> {
    this.stopSignal.abort();
    return this.closing ??= this.rpc.close();
  }
}
