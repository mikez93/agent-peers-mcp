// T2 coordinator (bd-1con), selected only with an injected authenticated host.
// Ports require authenticated lifecycle evidence and host-side atomic, idempotent,
// non-owning admission. A successful submission never acknowledges broker mail.
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { conversationKey, parseHermesConversationContext, type HermesConversationContext } from "./hermes-conversation-context.ts";
import type { ConversationState } from "./hermes-conversation-bindings.ts";

export interface WakeCandidate {
  peer_id: string;
  context: Readonly<HermesConversationContext>;
  binding_generation: number;
  state: ConversationState;
  unread_ids: readonly number[];
}

export interface WakeLifecycle {
  context: Readonly<HermesConversationContext>;
  lifecycle_generation: number;
  observed_at: number;
  state: "live" | "terminal" | "unknown";
  end_reason: string | null;
  busy: boolean;
  queued: boolean;
  compacting: boolean;
}

export interface WakeRequest {
  attempt_id: string;
  attempt_sequence: number;
  peer_id: string;
  context: Readonly<HermesConversationContext>;
  binding_generation: number;
  expected_lifecycle_generation: number;
  resume: boolean;
  queued: true;
  hidden: true;
  notice: string;
}

export type WakeReceiptState = "absent" | "unknown" | "deferred" | "rejected"
  | "accepted" | "started" | "completed" | "cancelled";
export interface WakeReceipt {
  attempt_id: string;
  attempt_sequence: number;
  context: Readonly<HermesConversationContext>;
  state: WakeReceiptState;
}

export interface HermesWakePorts {
  snapshot(candidate: Readonly<WakeCandidate>, signal: AbortSignal): Promise<WakeLifecycle | null>;
  // Must recheck binding epoch, state and unread signature immediately before
  // admission. The real integration must couple disposal/close to host fencing.
  current(candidate: Readonly<WakeCandidate>, signal: AbortSignal): Promise<boolean>;
  admit(request: Readonly<WakeRequest>, signal: AbortSignal): Promise<WakeReceipt>;
  reconcile(request: Readonly<WakeRequest>, signal: AbortSignal): Promise<WakeReceipt>;
}

interface Attempt {
  peer_id: string;
  signature: string;
  unread_ids: string;
  request: string;
  state: WakeReceiptState | "uncertain";
  retry: number;
  updated_at: number;
}

export interface WakeDecision {
  peer_id: string;
  reason: string;
  attempt_id?: string;
}

const RETRY_MS = [60_000, 300_000, 1_800_000];
const PENDING = new Set<Attempt["state"]>(["uncertain", "accepted", "started"]);

export function installHermesWakeSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hermes_wake_attempts (
    peer_id TEXT PRIMARY KEY, signature TEXT NOT NULL, unread_ids TEXT NOT NULL, request TEXT NOT NULL,
    state TEXT NOT NULL, retry INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
}

function contextCopy(context: Readonly<HermesConversationContext>): Readonly<HermesConversationContext> {
  return parseHermesConversationContext(Object.fromEntries(
    Object.entries(context).map(([key, value]) => [`hermes/${key}`, value]),
  ), { home: context.home, backend_id: context.backend_id });
}

function sameContext(a: Readonly<HermesConversationContext>, b: Readonly<HermesConversationContext>): boolean {
  return a.home === b.home && a.conversation_id === b.conversation_id && a.session_id === b.session_id
    && a.backend_id === b.backend_id && a.platform === b.platform && a.ui_session_id === b.ui_session_id;
}

function signature(candidate: WakeCandidate): string {
  return createHash("sha256").update(JSON.stringify([
    conversationKey(candidate.context), [...candidate.unread_ids].sort((a, b) => a - b),
  ])).digest("hex");
}

function requestCopy(request: WakeRequest): Readonly<WakeRequest> {
  return Object.freeze({ ...request, context: contextCopy(request.context) });
}

export class HermesConversationWakeCoordinator {
  private running = false;
  constructor(private readonly db: Database, private readonly ports: HermesWakePorts,
    private readonly now: () => number = Date.now, private readonly deadlineMs = 5_000) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 5_000) throw new Error("invalid_wake_deadline");
  }

  // One bounded pass timer, never a timer or resident map per dormant chat.
  async run(candidates: readonly WakeCandidate[], signal?: AbortSignal): Promise<WakeDecision[]> {
    if (this.running) throw new Error("wake_pass_running");
    const frozen = candidates.map(candidate => {
      if (!candidate.peer_id || !Number.isSafeInteger(candidate.binding_generation) || candidate.binding_generation < 1
          || candidate.unread_ids.length > 500 || candidate.unread_ids.some(id => !Number.isSafeInteger(id) || id < 1)
          || new Set(candidate.unread_ids).size !== candidate.unread_ids.length) throw new Error("invalid_wake_candidate");
      return Object.freeze({ ...candidate, context: contextCopy(candidate.context),
        unread_ids: Object.freeze([...candidate.unread_ids]) });
    });
    this.running = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.deadlineMs);
    try {
      return await Promise.all(frozen.map(async candidate => {
        try { return await this.visit(candidate, controller.signal); }
        catch { return { peer_id: candidate.peer_id, reason: "wake_unavailable" }; }
      }));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.running = false;
    }
  }

  private async rpc<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new Error("wake_deadline");
    let abort!: () => void;
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () => reject(new Error("wake_deadline"));
        signal.addEventListener("abort", abort, { once: true });
        // Observe late rejection but never let a late result mutate the ledger.
        Promise.resolve().then(() => {
          if (signal.aborted) throw new Error("wake_deadline");
          return call();
        }).then(resolve, reject);
      });
    } finally { signal.removeEventListener("abort", abort); }
  }

  private get(peerId: string): Attempt | null {
    return this.db.query<Attempt, [string]>("SELECT * FROM hermes_wake_attempts WHERE peer_id=?").get(peerId);
  }

  private saveReceipt(attempt: Attempt, receipt: WakeReceipt): void {
    const request = JSON.parse(attempt.request) as WakeRequest;
    if (receipt.attempt_id !== request.attempt_id || receipt.attempt_sequence !== request.attempt_sequence
        || !sameContext(receipt.context, request.context)
        || !["absent", "unknown", "deferred", "rejected", "accepted", "started", "completed", "cancelled"].includes(receipt.state)) {
      throw new Error("wake_receipt_mismatch");
    }
    if (receipt.state === "unknown" || receipt.state === "absent") return;
    // Concurrent coordinators can reconcile the same deduplicated attempt.
    // Never regress terminal evidence or a started receipt to accepted.
    this.db.query(`UPDATE hermes_wake_attempts SET state=?,updated_at=?
      WHERE peer_id=? AND request=? AND state IN ('uncertain','accepted','started')
      AND NOT (state='started' AND ?='accepted')`).run(
      receipt.state, this.now(), attempt.peer_id, attempt.request, receipt.state,
    );
  }

  private async visit(candidate: Readonly<WakeCandidate>, signal: AbortSignal): Promise<WakeDecision> {
    const result = (reason: string, attempt_id?: string): WakeDecision => ({ peer_id: candidate.peer_id, reason, attempt_id });
    const sig = signature(candidate);
    let old = this.get(candidate.peer_id);
    if (old && PENDING.has(old.state)) {
      const request = requestCopy(JSON.parse(old.request));
      const receipt = await this.rpc(signal, () => this.ports.reconcile(request, signal));
      this.saveReceipt(old, receipt);
      if (receipt.state === "absent") {
        if (old.state !== "uncertain") return result("receipt_lost", request.attempt_id);
        // Even an authoritative miss permits only replay of the SAME attempt.
        // A new epoch cannot replace an unresolved old attempt after restart.
        if (!sameContext(candidate.context, request.context)
            || candidate.binding_generation !== request.binding_generation) return result("unresolved_old_owner", request.attempt_id);
        if (!await this.eligible(candidate, signal, request)) return result("deferred", request.attempt_id);
        this.saveReceipt(old, await this.rpc(signal, () => this.ports.admit(request, signal)));
      }
      old = this.get(candidate.peer_id)!;
      if (PENDING.has(old.state)) return result(old.state, request.attempt_id);
    }
    if (!candidate.unread_ids.length) return result("no_mail");
    const newMail = !old || candidate.unread_ids.some(id => !(JSON.parse(old!.unread_ids) as number[]).includes(id));
    if (old && !newMail) {
      if (old.state === "cancelled") return result("cancelled");
      if (old.state === "rejected") return result("rejected");
      if (old.state === "completed") {
        if (old.retry >= RETRY_MS.length) return result("wake_exhausted");
        if (this.now() - old.updated_at < RETRY_MS[old.retry]!) return result("backoff");
      }
    }
    const lifecycle = await this.eligible(candidate, signal);
    if (!lifecycle) return result("deferred");
    const sequence = old ? (JSON.parse(old.request) as WakeRequest).attempt_sequence + 1 : 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("wake_sequence_exhausted");
    const request = requestCopy({
      attempt_id: randomUUID(), attempt_sequence: sequence, peer_id: candidate.peer_id, context: candidate.context,
      binding_generation: candidate.binding_generation,
      expected_lifecycle_generation: lifecycle.lifecycle_generation, resume: lifecycle.state === "terminal",
      queued: true, hidden: true,
      notice: "You have pending Agent Peers mail for this conversation. Call check_messages once. "
        + "Only that tool response is authoritative; do not infer message content from this notice.",
    });
    const attempt = this.db.transaction(() => {
      const current = this.get(candidate.peer_id);
      // Another coordinator advanced this row while lifecycle/current awaited.
      if (JSON.stringify(current) !== JSON.stringify(old)) return null;
      const retry = old && !newMail ? old.retry + (old.state === "completed" ? 1 : 0) : 0;
      this.db.query(`INSERT INTO hermes_wake_attempts VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(peer_id) DO UPDATE SET signature=excluded.signature,unread_ids=excluded.unread_ids,request=excluded.request,
          state=excluded.state,retry=excluded.retry,updated_at=excluded.updated_at`)
        .run(candidate.peer_id, newMail ? sig : old!.signature,
          newMail ? JSON.stringify(candidate.unread_ids) : old!.unread_ids,
          JSON.stringify(request), "uncertain", retry, this.now());
      return this.get(candidate.peer_id)!;
    }).immediate();
    if (!attempt) return result("concurrent_attempt");
    // Persist uncertainty BEFORE the RPC, including before a crash or lost reply.
    this.saveReceipt(attempt, await this.rpc(signal, () => this.ports.admit(request, signal)));
    return result(this.get(candidate.peer_id)!.state, request.attempt_id);
  }

  private async eligible(candidate: Readonly<WakeCandidate>, signal: AbortSignal,
    replay?: Readonly<WakeRequest>): Promise<WakeLifecycle | null> {
    if (!candidate.unread_ids.length || !["active", "reaped"].includes(candidate.state)) return null;
    const snapshot = await this.rpc(signal, () => this.ports.snapshot(candidate, signal));
    if (!snapshot) return null;
    // Copy immediately after the await; later caller mutation cannot retarget admission.
    const row = Object.freeze({ ...snapshot, context: contextCopy(snapshot.context) });
    if (!sameContext(row.context, candidate.context) || !Number.isSafeInteger(row.lifecycle_generation)
        || row.lifecycle_generation < 0 || !Number.isSafeInteger(row.observed_at)
        || row.observed_at > this.now() || this.now() - row.observed_at > 10_000
        || row.busy !== false || row.queued !== false || row.compacting !== false
        || !(row.state === "live" && row.end_reason === null
          || row.state === "terminal" && row.end_reason === "automatic_reap" && row.context.platform !== "cron")
        || replay && (row.lifecycle_generation !== replay.expected_lifecycle_generation
          || (row.state === "terminal") !== replay.resume)) return null;
    if (!await this.rpc(signal, () => this.ports.current(candidate, signal)) || this.now() - row.observed_at > 10_000) return null;
    return row;
  }
}
