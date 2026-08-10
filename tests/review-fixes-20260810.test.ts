// tests/review-fixes-20260810.test.ts
//
// Regression coverage for the 2026-08-10 fresh-eyes review findings:
//   #1  A restart-shaped CodexInboxStore sequence must never clobber a
//       previous incarnation's persisted unread mail — even when the caller
//       forgets init() (lazy-load guard).
//   #2  HermesNameClaims: two claimants racing over a DEAD owner's lock must
//       produce exactly one winner (atomic rename reclaim, no unlink TOCTOU).

import { test, expect } from "bun:test";
import { CodexInboxStore } from "../shared/codex-inbox.ts";
import { HermesNameClaims } from "../shared/hermes-claims.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function leased(id: number, text: string) {
  return {
    id, text,
    from_id: "sender-uuid", from_name: "sender", from_peer_type: "claude" as const,
    from_summary: "", from_cwd: "/x",
    sent_at: new Date().toISOString(),
    lease_token: `tok-${id}`,
  };
}

test("restart: a re-constructed store surfaces the previous incarnation's unread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-restart-"));
  try {
    const first = new CodexInboxStore({ peerId: "peer-restart", rootDir: dir });
    await first.init();
    await first.queueLeasedMessages([leased(1, "persisted before the crash")]);

    // Process dies; a new incarnation constructs a fresh store over the same
    // file — exactly what claude-server does at register time.
    const second = new CodexInboxStore({ peerId: "peer-restart", rootDir: dir });
    await second.init();
    const unread = await second.getUnreadMessages();
    expect(unread.map((m) => m.text)).toEqual(["persisted before the crash"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forgotten init(): first write on a fresh store must MERGE, not clobber disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-clobber-"));
  try {
    const first = new CodexInboxStore({ peerId: "peer-clobber", rootDir: dir });
    await first.init();
    await first.queueLeasedMessages([leased(1, "already acked at the broker")]);

    // The bug: a store constructed WITHOUT init() used to start empty-but-
    // writable, and its first queue atomically overwrote the file.
    const forgetful = new CodexInboxStore({ peerId: "peer-clobber", rootDir: dir });
    await forgetful.queueLeasedMessages([leased(2, "new mail")]); // no init()!

    const verify = new CodexInboxStore({ peerId: "peer-clobber", rootDir: dir });
    await verify.init();
    const texts = (await verify.getUnreadMessages()).map((m) => m.text);
    expect(texts).toContain("already acked at the broker");
    expect(texts).toContain("new mail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("forgotten init(): consume/remove also load disk state first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "inbox-consume-"));
  try {
    const first = new CodexInboxStore({ peerId: "peer-consume", rootDir: dir });
    await first.init();
    await first.queueLeasedMessages([leased(7, "must be consumable after restart")]);

    const forgetful = new CodexInboxStore({ peerId: "peer-consume", rootDir: dir });
    const consumed = await forgetful.consumeUnreadMessages(); // no init()!
    expect(consumed.map((m) => m.text)).toEqual(["must be consumable after restart"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent dead-owner reclaim: exactly one winner per round", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claims-race-"));
  try {
    for (let round = 0; round < 10; round++) {
      const name = `race-agent-${round}`;
      // A lock held by a pid that cannot be alive (pid_max on macOS is 99998).
      writeFileSync(
        join(dir, `${encodeURIComponent(name)}.lock`),
        JSON.stringify({ owner_pid: 9_999_999, acquired_at: new Date().toISOString() }),
        { mode: 0o600 },
      );
      // Two live claimants race the reclaim. process.pid is us; pid 1 is
      // launchd (alive → EPERM from kill(1, 0), which isProcessAlive treats
      // as alive). Both are legitimate concurrent surfaces.
      const a = new HermesNameClaims(dir);
      const b = new HermesNameClaims(dir);
      const [aWon, bWon] = await Promise.all([
        a.tryAcquire(name, process.pid),
        b.tryAcquire(name, 1),
      ]);
      expect(Number(aWon) + Number(bWon)).toBe(1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
