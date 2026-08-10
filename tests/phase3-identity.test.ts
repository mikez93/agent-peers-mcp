// tests/phase3-identity.test.ts
//
// Stable-identity coverage (Phase 3):
//   - durable is explicit: a named register WITHOUT durable:true is ephemeral
//   - typed reclaim: a claude peer cannot inherit a stale hermes peer's UUID
//   - prev_id: re-registration re-points unacked mail from the dead
//     incarnation; a LIVE previous row is never robbed
//   - host column: filled on register, present after migration
//   - HermesNameClaims: exactly one winner per name; dead-owner reclaim;
//     owner-checked release

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startBroker, registerPeer, sendMessage, pollMessages, gcStalePeers, getPeer,
} from "../broker.ts";
import { HermesNameClaims } from "../shared/hermes-claims.ts";
import { existsSync, unlinkSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_DB = `/tmp/agent-peers-phase3-${Date.now()}.db`;
const TEST_SECRET = `/tmp/agent-peers-phase3-secret-${Date.now()}`;
const TEST_PORT = 7953;
let handle: ReturnType<typeof startBroker>;

beforeAll(() => { handle = startBroker(TEST_PORT, TEST_DB, TEST_SECRET); });
afterAll(() => {
  clearInterval(handle.gcTimer);
  handle.server.stop(true);
  handle.db.close();
  for (const p of [TEST_DB, TEST_SECRET]) if (existsSync(p)) unlinkSync(p);
});

function reg(opts: { name?: string; peer_type?: "claude" | "codex" | "hermes"; durable?: boolean; prev_id?: string }) {
  return registerPeer(handle.db, {
    peer_type: opts.peer_type ?? "claude",
    pid: process.pid, cwd: "/x", git_root: null, tty: null, summary: "",
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.durable !== undefined ? { durable: opts.durable } : {}),
    ...(opts.prev_id ? { prev_id: opts.prev_id } : {}),
  });
}

function ageOut(id: string) {
  handle.db.query("UPDATE peers SET last_seen = ? WHERE id = ?")
    .run(new Date(Date.now() - 10 * 60_000).toISOString(), id);
}

test("durable is explicit: a named register without durable:true stays ephemeral", () => {
  const squatter = reg({ name: "test-squatter" }); // no durable field
  ageOut(squatter.id);
  gcStalePeers(handle.db);
  expect(getPeer(handle.db, squatter.id)).toBeNull(); // gone at 60s, not 7 days

  const agent = reg({ name: "real-agent", durable: true });
  ageOut(agent.id);
  gcStalePeers(handle.db);
  expect(getPeer(handle.db, agent.id)).not.toBeNull(); // retained
});

test("typed reclaim: a claude register cannot inherit a stale hermes peer's UUID/mailbox", () => {
  const hermes = reg({ name: "cross-type-agent", peer_type: "hermes", durable: true });
  const sender = reg({ name: "cross-type-sender", durable: true });
  sendMessage(handle.db, {
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: "cross-type-agent", text: "hermes mail",
  });
  ageOut(hermes.id);

  const impostor = reg({ name: "cross-type-agent", peer_type: "claude", durable: true });
  // Type mismatch → suffix ladder, NOT reclaim: new UUID, renamed.
  expect(impostor.id).not.toBe(hermes.id);
  expect(impostor.name).not.toBe("cross-type-agent");
  // The hermes mailbox is untouched.
  expect(pollMessages(handle.db, impostor.id, impostor.session_token).length).toBe(0);

  // Same type DOES reclaim, preserving UUID + mailbox.
  const back = reg({ name: "cross-type-agent", peer_type: "hermes", durable: true });
  expect(back.id).toBe(hermes.id);
  expect(pollMessages(handle.db, back.id, back.session_token).map((m) => m.text)).toEqual(["hermes mail"]);
});

test("prev_id re-points unacked mail from a DEAD incarnation to the new row", () => {
  const ephemeralPeer = reg({}); // generated name, ephemeral
  const sender = reg({ name: "repoint-sender", durable: true });
  sendMessage(handle.db, {
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: ephemeralPeer.id, text: "queued before eviction",
  });
  // Evict: age out + GC deletes the ephemeral row; the message orphans.
  ageOut(ephemeralPeer.id);
  gcStalePeers(handle.db);
  expect(getPeer(handle.db, ephemeralPeer.id)).toBeNull();

  // Client re-registers with prev_id → new UUID, mail follows.
  const reborn = reg({ prev_id: ephemeralPeer.id });
  expect(reborn.id).not.toBe(ephemeralPeer.id);
  const got = pollMessages(handle.db, reborn.id, reborn.session_token);
  expect(got.map((m) => m.text)).toEqual(["queued before eviction"]);
});

test("prev_id never robs a LIVE previous row", () => {
  const alive = reg({}); // stays live
  const sender = reg({ name: "rob-sender", durable: true });
  sendMessage(handle.db, {
    from_id: sender.id, session_token: sender.session_token,
    to_id_or_name: alive.id, text: "belongs to the live row",
  });
  const thief = reg({ prev_id: alive.id });
  expect(pollMessages(handle.db, thief.id, thief.session_token).length).toBe(0);
  expect(pollMessages(handle.db, alive.id, alive.session_token).map((m) => m.text))
    .toEqual(["belongs to the live row"]);
});

test("host column is filled on register", () => {
  const p = reg({});
  const row = handle.db.query<{ host: string | null }, [string]>(
    "SELECT host FROM peers WHERE id = ?"
  ).get(p.id);
  expect(row?.host).toBeTruthy();
});

test("HermesNameClaims: single winner, dead-owner reclaim, owner-checked release", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-claims-"));
  try {
    const claims = new HermesNameClaims(dir);
    // Two surfaces race for one name: exactly one winner (same pid is
    // idempotent, so simulate the loser with a different LIVE pid — use
    // pid 1, launchd, which is alive and not ours → EPERM-alive or real).
    expect(await claims.tryAcquire("ezra-hermes", process.pid)).toBe(true);
    expect(await claims.tryAcquire("ezra-hermes", process.pid)).toBe(true); // idempotent
    // A different claimant loses while the owner (this process) is alive.
    // (tryAcquire arbitrates by the RECORDED owner pid, not the caller's.)
    const rival = new HermesNameClaims(dir);
    expect(await rival.tryAcquire("ezra-hermes", 999_999_1)).toBe(false);

    // Owner-checked release: a non-owner release is a no-op.
    await claims.release("ezra-hermes", 999_999_1);
    expect(await rival.tryAcquire("ezra-hermes", 999_999_1)).toBe(false);

    // Real release frees the name.
    await claims.release("ezra-hermes", process.pid);
    expect(await rival.tryAcquire("ezra-hermes", 999_999_2)).toBe(true);

    // Dead-owner reclaim: 999_999_2 is not a live pid, so a live claimant
    // steals the lock.
    expect(await claims.tryAcquire("ezra-hermes", process.pid)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
