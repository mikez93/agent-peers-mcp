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
//   confirmable()  — ids whose response is fully built; the NEXT call arriving
//                    is the evidence they reached the model. The caller acks
//                    their leases and prunes them from the durable store, then
//                    calls markConfirmed().
//
// Broker acks are enqueued ONLY at confirm time — never at draw. A message's
// lease deliberately expires and re-offers while it sits drawn/presented; the
// caller's poll loop dedupes re-offers by id (isBlocked) and refreshes the
// stored lease token, so the confirm-time ack uses the freshest token.

export class DeliveryState {
  private drawnByCall = new Map<string, Set<number>>();
  private drawn = new Set<number>();
  private presented = new Set<number>();
  private confirmed = new Set<number>();

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
    for (const id of set) {
      this.drawn.delete(id);
      this.presented.add(id);
    }
    this.drawnByCall.delete(callId);
  }

  rollback(callId: string): void {
    const set = this.drawnByCall.get(callId);
    if (!set) return;
    for (const id of set) this.drawn.delete(id);
    this.drawnByCall.delete(callId);
  }

  /** Ids eligible for confirm by the next arriving call. */
  confirmable(): number[] {
    return [...this.presented];
  }

  /** The caller acked + pruned these ids; they are now known-delivered. */
  markConfirmed(ids: number[]): void {
    for (const id of ids) {
      this.presented.delete(id);
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
