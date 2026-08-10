// tests/delivery-state.test.ts
//
// Deterministic coverage for the piggyback delivery state machine — the
// exact interleavings the 2026-08-10 second review proved unreachable by
// the integration suite:
//   1. concurrent call B must not confirm (nor make ack-eligible) messages
//      call A drew but has not returned
//   2. a cancelled call's draws roll back re-dealable, with nothing
//      confirmable
//   3. a call that never promotes (process death analogue) leaves its draws
//      blocked in-process but unconfirmed — never ack-eligible

import { test, expect } from "bun:test";
import { DeliveryState } from "../shared/delivery-state.ts";

test("a drawn-but-unreturned message is blocked from re-deal and NOT confirmable", () => {
  const d = new DeliveryState();
  d.draw("call-A", [1, 2]);
  // Concurrent call B enters the critical section while A is running:
  expect(d.confirmable(d.newArrival())).toEqual([]); // B must find nothing to confirm/ack
  expect(d.isBlocked(1)).toBe(true); // and must not re-deal A's draws
  expect(d.isBlocked(2)).toBe(true);
});

test("parallel calls: only the completed call's draws become confirmable", () => {
  const d = new DeliveryState();
  d.draw("call-A", [1]); // A draws, still running
  d.draw("call-B", [2]); // B draws concurrently
  d.promote("call-B"); // B's response is fully built; A is still in flight
  expect(d.confirmable(d.newArrival())).toEqual([2]); // a LATER call may confirm B's draw only
  expect(d.isBlocked(1)).toBe(true); // A's draw remains blocked, unconfirmable
  d.markConfirmed([2]);
  expect(d.isConfirmed(2)).toBe(true);
  expect(d.isConfirmed(1)).toBe(false);
  // A finally completes: its draw becomes confirmable now, not earlier.
  d.promote("call-A");
  expect(d.confirmable(d.newArrival())).toEqual([1]);
});

test("cancellation rolls draws back to re-dealable with nothing confirmable", () => {
  const d = new DeliveryState();
  d.draw("call-A", [7, 8]);
  d.rollback("call-A"); // request aborted before the response could land
  expect(d.confirmable(d.newArrival())).toEqual([]);
  expect(d.isBlocked(7)).toBe(false); // next call re-deals the same messages
  expect(d.isBlocked(8)).toBe(false);
  expect(d.isConfirmed(7)).toBe(false);
});

test("a call that never promotes leaves draws blocked but never confirmable", () => {
  const d = new DeliveryState();
  d.draw("call-A", [3]);
  // No promote, no rollback — the process-death analogue. However many
  // later calls run, nothing about id 3 may be confirmed or acked.
  d.draw("call-B", []);
  d.promote("call-B");
  expect(d.confirmable(d.newArrival())).toEqual([]);
  expect(d.isConfirmed(3)).toBe(false);
  expect(d.isBlocked(3)).toBe(true);
});

test("promote/rollback are idempotent and scoped to their own call", () => {
  const d = new DeliveryState();
  d.draw("call-A", [1]);
  d.draw("call-B", [2]);
  d.rollback("call-B");
  d.rollback("call-B"); // double rollback: no effect
  d.promote("call-B"); // promote after rollback: call is gone, no effect
  expect(d.confirmable(d.newArrival())).toEqual([]);
  d.promote("call-A");
  d.promote("call-A"); // double promote: no duplicate
  expect(d.confirmable(d.newArrival())).toEqual([1]);
});

test("watermark prune drops only confirmed ids far below the frontier", () => {
  const d = new DeliveryState();
  d.draw("c", [100, 20_000]);
  d.promote("c");
  d.markConfirmed([100, 20_000]);
  d.pruneConfirmedBelow(d.maxConfirmed() - 10_000);
  expect(d.isConfirmed(100)).toBe(false); // pruned — can no longer re-offer
  expect(d.isConfirmed(20_000)).toBe(true); // retained
});

test("BARRIER: a call issued before a response existed cannot confirm it", () => {
  const d = new DeliveryState();
  // Schedule from the third review: A draws M; B ARRIVES (snapshot at request
  // entry) and parks in its pre-read wait; A's response completes; B finally
  // reaches the critical section. B predates A's response — B is not evidence
  // the model received it, so B must not confirm M.
  d.draw("call-A", [42]);
  const bArrival = d.newArrival(); // B arrives while A is still in flight
  d.promote("call-A"); // A's response is built AFTER B was issued
  expect(d.confirmable(bArrival)).toEqual([]); // B confirms nothing
  expect(d.isBlocked(42)).toBe(true); // M stays presented, unpruned, unacked
  // A call that genuinely arrives after A's response completes confirms it.
  expect(d.confirmable(d.newArrival())).toEqual([42]);
});

test("post-confirm re-offer classifies as confirmed (ack branch, no resurrect)", () => {
  const d = new DeliveryState();
  d.draw("c", [9]);
  d.promote("c");
  d.markConfirmed(d.confirmable(d.newArrival()));
  // A background re-offer of id 9 arriving after confirm must hit the
  // isConfirmed branch (ack the stale lease) — never be treated as unread.
  expect(d.isConfirmed(9)).toBe(true);
  expect(d.isBlocked(9)).toBe(true);
});
