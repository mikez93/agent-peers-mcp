// tests/readiness-probe.test.ts
//
// Matrix coverage for createReadinessProbe (2026-08-10 second review H3,
// tightened in the third review): wrong owner, wrong protocol, wrong DB,
// MISSING db_id, wrong secret, old broker (no /ready), missing/unreadable
// secret (fail closed — no /health bootstrap window), dev-mode owner rules.

import { test, expect, afterAll } from "bun:test";
import { createReadinessProbe, expectedDbIdentityHash, SECRET_HEADER } from "../shared/broker-client.ts";

const GOOD_SECRET = "s".repeat(40);
const DB_PATH = "/tmp/probe-test.db";
const PORT = 7961;

type ReadyBody = { ok?: boolean; protocol?: number; owner?: string; db_id?: string };
let readyBody: ReadyBody | null = { ok: true, protocol: 1, owner: "launchd", db_id: expectedDbIdentityHash(DB_PATH) };
let requireSecret = true;

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, pid: 1 });
    if (url.pathname === "/ready") {
      if (readyBody === null) return new Response("not found", { status: 404 }); // old broker
      if (requireSecret && req.headers.get(SECRET_HEADER) !== GOOD_SECRET) {
        return Response.json({ error: "bad secret" }, { status: 401 });
      }
      return Response.json(readyBody);
    }
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => server.stop(true));

function probe(secret: string | null) {
  return createReadinessProbe(`http://127.0.0.1:${PORT}`, () => secret, {
    expectedDbPath: () => DB_PATH,
  });
}

test("healthy launchd broker with matching DB passes", async () => {
  readyBody = { ok: true, protocol: 1, owner: "launchd", db_id: expectedDbIdentityHash(DB_PATH) };
  expect(await probe(GOOD_SECRET)()).toBe(true);
});

test("wrong secret (someone else's broker) fails", async () => {
  expect(await probe("wrong-".padEnd(40, "x"))()).toBe(false);
});

test("client-owned broker fails outside dev mode, passes inside it", async () => {
  readyBody = { ok: true, protocol: 1, owner: "client", db_id: expectedDbIdentityHash(DB_PATH) };
  expect(await probe(GOOD_SECRET)()).toBe(false);
  process.env.AGENT_PEERS_SPAWN_BROKER = "1";
  try {
    expect(await probe(GOOD_SECRET)()).toBe(true);
  } finally {
    delete process.env.AGENT_PEERS_SPAWN_BROKER;
  }
});

test("dev mode accepts ONLY owner=client — arbitrary or absent owner still fails", async () => {
  process.env.AGENT_PEERS_SPAWN_BROKER = "1";
  try {
    readyBody = { ok: true, protocol: 1, owner: "squatter", db_id: expectedDbIdentityHash(DB_PATH) };
    expect(await probe(GOOD_SECRET)()).toBe(false);
    readyBody = { ok: true, protocol: 1, db_id: expectedDbIdentityHash(DB_PATH) }; // owner absent
    expect(await probe(GOOD_SECRET)()).toBe(false);
  } finally {
    delete process.env.AGENT_PEERS_SPAWN_BROKER;
  }
});

test("wrong DB identity fails", async () => {
  readyBody = { ok: true, protocol: 1, owner: "launchd", db_id: "deadbeef0000" };
  expect(await probe(GOOD_SECRET)()).toBe(false);
});

test("MISSING db_id fails — db identity is required, not optional", async () => {
  readyBody = { ok: true, protocol: 1, owner: "launchd" };
  expect(await probe(GOOD_SECRET)()).toBe(false);
});

test("wrong protocol fails", async () => {
  readyBody = { ok: true, protocol: 99, owner: "launchd", db_id: expectedDbIdentityHash(DB_PATH) };
  expect(await probe(GOOD_SECRET)()).toBe(false);
});

test("malformed body fails", async () => {
  readyBody = {};
  expect(await probe(GOOD_SECRET)()).toBe(false);
});

test("old broker without /ready fails when a secret exists", async () => {
  readyBody = null; // 404 on /ready
  expect(await probe(GOOD_SECRET)()).toBe(false);
});

test("no readable secret fails closed — even with a squatter answering /health", async () => {
  // First-boot has NO /health bootstrap window (third review H3): with no
  // secret there is nothing to authenticate, so not-ready → ensureBroker
  // kickstarts launchd → the real broker provisions the secret → the probe
  // (which re-reads the secret every call) authenticates on the next poll.
  readyBody = { ok: true, protocol: 1, owner: "launchd", db_id: expectedDbIdentityHash(DB_PATH) };
  expect(await probe(null)()).toBe(false);
});
