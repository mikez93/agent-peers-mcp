// shared/delivery-state.ts
//
// The piggyback delivery state machine, extracted so its concurrency and
// cancellation semantics are deterministically testable (2026-08-10 second
// review: the inline version shipped two real races in one day — draw-time
// ack flushing and cross-call confirm — precisely because nothing could
// exercise interleavings without spawning an MCP server).
//
// Lifecycle of a message id through one process:
//
//   draw(call)     — dealt into call's response-under-construction.
//                    Blocks re-deal. NOT ack- or confirm-eligible.
//   promote(call)  — that call's response was fully built and handed to the
//                    transport (and the request was not aborted): its draws
//                    become confirm-eligible.
//   rollback(call) — the call was aborted/cancelled before its response could
//                    reach the model: its draws return to undrawn, re-dealable
//                    to the next call. Nothing was acked, nothing was pruned.
//   confirmable(g) — ids whose response was fully built BEFORE arrival
//                    generation `g` was issued. A call snapshots its arrival
//                    generation via newArrival() at REQUEST ENTRY — before
//                    any pre-read wait — and may only confirm presentations
//                    older than that snapshot. A call issued concurrently
//                    with (or before) a response is no evidence the model
//                    received it, even if the call reaches the lock later
//                    (2026-08-10 third review: a call parked in the
//                    wait-for-messages hook outlived a sibling's promote and
//                    wrongly confirmed it). The caller acks the confirmed
//                    leases, prunes the durable store, then markConfirmed().
//
// Broker acks are enqueued ONLY at confirm time — never at draw. A message's
// lease deliberately expires and re-offers while it sits drawn/presented; the
// caller's poll loop dedupes re-offers by id (isBlocked) and refreshes the
// stored lease token, so the confirm-time ack uses the freshest token.

export class DeliveryState {
  private drawnByCall = new Map<string, Set<number>>();
  private drawn = new Set<number>();
  private presented = new Set<number>();
  private presentedGen = new Map<number, number>();
  private confirmed = new Set<number>();
  private generation = 0;

  /** Snapshot the arrival generation. Call at REQUEST ENTRY, before any
   *  pre-read wait — presentations promoted after this snapshot are not
   *  confirmable by this call. */
  newArrival(): number {
    return this.generation;
  }

  /** True if this id is anywhere in the pipeline (blocks re-deal). */
  isBlocked(id: number): boolean {
    return this.drawn.has(id) || this.presented.has(id) || this.confirmed.has(id);
  }

  isConfirmed(id: number): boolean {
    return this.confirmed.has(id);
  }

  draw(callId: string, ids: number[]): void {
    let set = this.drawnByCall.get(callId);
    if (!set) {
      set = new Set();
      this.drawnByCall.set(callId, set);
    }
    for (const id of ids) {
      set.add(id);
      this.drawn.add(id);
    }
  }

  promote(callId: string): void {
    const set = this.drawnByCall.get(callId);
    if (!set) return;
    this.generation++;
    for (const id of set) {
      this.drawn.delete(id);
      this.presented.add(id);
      this.presentedGen.set(id, this.generation);
    }
    this.drawnByCall.delete(callId);
  }

  rollback(callId: string): void {
    const set = this.drawnByCall.get(callId);
    if (!set) return;
    for (const id of set) this.drawn.delete(id);
    this.drawnByCall.delete(callId);
  }

  /** Ids confirmable by a call that arrived at generation `arrivalGen`:
   *  only presentations promoted BEFORE that arrival. */
  confirmable(arrivalGen: number): number[] {
    const out: number[] = [];
    for (const id of this.presented) {
      const gen = this.presentedGen.get(id);
      if (gen !== undefined && gen <= arrivalGen) out.push(id);
    }
    return out;
  }

  /** The caller acked + pruned these ids; they are now known-delivered. */
  markConfirmed(ids: number[]): void {
    for (const id of ids) {
      this.presented.delete(id);
      this.presentedGen.delete(id);
      this.confirmed.add(id);
    }
  }

  /** Watermark-prune the confirmed set (ids are AUTOINCREMENT-monotonic). */
  pruneConfirmedBelow(watermark: number): void {
    for (const id of this.confirmed) if (id < watermark) this.confirmed.delete(id);
  }

  maxConfirmed(): number {
    let max = -Infinity;
    for (const id of this.confirmed) if (id > max) max = id;
    return max;
  }
}
