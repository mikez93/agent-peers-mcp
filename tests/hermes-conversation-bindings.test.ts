import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { initDb } from "../broker.ts";
import {
  HermesConversationBindings, installHermesConversationSchema, dormantMailboxNotice,
  HERMES_OWNER_LEASE_MS, HERMES_SNAPSHOT_MAX_AGE_MS,
  type LiveConversationEvidence,
} from "../shared/hermes-conversation-bindings.ts";
import {
  parseHermesConversationContext, conversationKey, conversationName,
} from "../shared/hermes-conversation-context.ts";

let dir: string;
let db: Database;
let store: HermesConversationBindings;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hermes-bindings-"));
  db = initDb(join(dir, "broker.db"));
  installHermesConversationSchema(db);
  clock = Date.parse("2026-09-08T12:00:00Z");
  store = new HermesConversationBindings(db, () => clock);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function evidence(id = "chat-a", overrides: Partial<LiveConversationEvidence> = {}): LiveConversationEvidence {
  return {
    context: { home: "/profiles/ezra", conversation_id: id, session_id: id,
      platform: "desktop", backend_id: "backend-1", ui_session_id: `ui-${id}` },
    adapter_id: "adapter-1", lifecycle_generation: 1, observed_at: clock, ...overrides,
  };
}

function meta() {
  return { "hermes/home": "/profiles/ezra", "hermes/conversation_id": "chat-a",
    "hermes/session_id": "chat-a-segment2", "hermes/platform": "desktop",
    "hermes/backend_id": "backend-1", "hermes/ui_session_id": "ui-a" };
}

test("host metadata is required, scoped, immutable and independent of arguments or env", () => {
  const expected = { home: "/profiles/ezra", backend_id: "backend-1" };
  for (const absent of [undefined, null, [], { session_id: "from-tool-arguments" }]) {
    expect(() => parseHermesConversationContext(absent, expected)).toThrow();
  }
  const source = meta();
  const parsed = parseHermesConversationContext(source, expected);
  source["hermes/session_id"] = "sibling";
  expect(parsed.session_id).toBe("chat-a-segment2");
  expect(Object.isFrozen(parsed)).toBe(true);
  for (const wrong of [
    { ...meta(), "hermes/home": "/profiles/marco" },
    { ...meta(), "hermes/backend_id": "old-backend" },
    { ...meta(), "hermes/home": "/profiles/../profiles/ezra" },
    { ...meta(), "hermes/conversation_id": "" },
    { ...meta(), "hermes/ui_session_id": "\nforged" },
  ]) {
    expect(() => parseHermesConversationContext(wrong, expected)).toThrow();
  }
});

test("K and names distinguish profiles and branches but ignore runtime and compression segment", () => {
  const a = evidence().context;
  const compressed = { ...a, session_id: "compressed", ui_session_id: "new-ui" };
  const branch = { ...a, conversation_id: "branch" };
  const otherProfile = { ...a, home: "/profiles/marco" };
  expect(conversationKey(a)).toBe(conversationKey(compressed));
  expect(conversationName(a, "ezra")).toBe(conversationName(compressed, "ezra"));
  expect(conversationKey(branch)).not.toBe(conversationKey(a));
  expect(conversationKey(otherProfile)).not.toBe(conversationKey(a));
  expect(conversationName(otherProfile, "ezra")).not.toBe(conversationName(a, "ezra"));
});

test("first call registers once, status is private and names lengthen on a reserved collision", () => {
  const a = store.claim(evidence(), "ezra");
  expect(store.claim(evidence(), "ezra").peer_id).toBe(a.peer_id);
  const b = store.claim(evidence("chat-b"), "ezra");
  store.setSummary(a, "Working on A");
  expect(store.get(a.peer_id)?.summary).toBe("Working on A");
  expect(store.get(b.peer_id)?.summary).toBe("");
  expect(() => store.setSummary({ ...a, peer_id: b.peer_id, generation: a.generation + 1 }, "wrong")).toThrow();
  const c = evidence("chat-c");
  const short = conversationName(c.context, "ezra");
  db.query("UPDATE hermes_conversations SET name = ? WHERE peer_id = ?").run(short, b.peer_id);
  expect(store.claim(c, "ezra").name).toBe(conversationName(c.context, "ezra", 16));
  expect(store.status()).toEqual({ active: 3, dormant: 0, orphaned: 0, disposed: 0 });
});

test("a live owner cannot be stolen and old callbacks cannot mutate a resumed binding", () => {
  const a = store.claim(evidence(), "ezra");
  expect(() => store.claim(evidence("chat-a", { adapter_id: "adapter-2" }), "ezra"))
    .toThrow("conversation_owned");
  clock++;
  store.release(a, "closed", 2, clock);
  expect(() => store.claim(evidence("chat-a", { lifecycle_generation: 2 }), "ezra"))
    .toThrow("stale_lifecycle_evidence");
  clock++;
  const resumed = store.claim(evidence("chat-a", { adapter_id: "adapter-2", lifecycle_generation: 3 }), "ezra");
  expect(resumed.peer_id).toBe(a.peer_id);
  expect(resumed.generation).toBe(a.generation + 1);
  expect(() => store.release(a, "closed", 4, clock)).toThrow("stale_conversation_owner");
  expect(() => store.refresh(a, evidence())).toThrow("stale_conversation_owner");
  expect(() => store.setSummary(a, "old callback")).toThrow("stale_conversation_owner");
  expect(store.get(a.peer_id)?.state).toBe("active");
});

test("compression requires newer host generation and preserves status and mailbox", () => {
  const a = store.claim(evidence(), "ezra");
  store.setSummary(a, "same conversation");
  clock++;
  const compressed = evidence();
  compressed.context = { ...compressed.context, session_id: "segment-2" };
  expect(() => store.refresh(a, compressed)).toThrow("stale_lifecycle_evidence");
  compressed.lifecycle_generation = 2;
  store.refresh(a, compressed);
  const row = store.get(a.peer_id)!;
  expect(row.current_session_id).toBe("segment-2");
  expect(row.conversation_id).toBe("chat-a");
  expect(row.summary).toBe("same conversation");
  expect(row.generation).toBe(a.generation);
});

test("replayed or stale snapshots cannot renew ownership indefinitely", () => {
  const original = evidence();
  const a = store.claim(original, "ezra");
  clock += HERMES_SNAPSHOT_MAX_AGE_MS;
  store.refresh(a, original);
  expect(store.get(a.peer_id)?.owner_lease_until).toBe(original.observed_at + HERMES_OWNER_LEASE_MS);
  clock++;
  expect(() => store.refresh(a, original)).toThrow("invalid_lifecycle_evidence");
  expect(() => store.claim(evidence("future", { observed_at: clock + 1 }), "ezra")).toThrow();
  clock = a.owner_lease_until;
  expect(store.status().active).toBe(0);
  expect(() => store.setSummary(a, "late")).toThrow("stale_conversation_owner");
  expect(store.expire()).toBe(1);
  expect(store.get(a.peer_id)?.state).toBe("suspended");
});

test("expired backend lease and store reopen preserve UUID while rejecting old generations", () => {
  const a = store.claim(evidence(), "ezra");
  clock += HERMES_OWNER_LEASE_MS + 1;
  store.expire();
  db.close();
  db = initDb(join(dir, "broker.db"));
  installHermesConversationSchema(db); // repeated migration preserves persisted bindings
  store = new HermesConversationBindings(db, () => clock);
  const fresh = evidence();
  fresh.context = { ...fresh.context, backend_id: "backend-2" };
  fresh.adapter_id = "adapter-2";
  const resumed = store.claim(fresh, "ezra");
  expect(resumed.peer_id).toBe(a.peer_id);
  expect(resumed.name).toBe(a.name);
  expect(() => store.setSummary(a, "stale")).toThrow();
});

test("an older backend observation cannot overwrite a newer explicit close", () => {
  const original = evidence();
  const first = store.claim(original, "ezra");
  clock++;
  store.release(first, "reaped", 2, clock);
  clock++;
  const other = evidence();
  other.context = { ...other.context, backend_id: "backend-2" };
  other.adapter_id = "adapter-2";
  const second = store.claim(other, "ezra");
  clock++;
  store.release(second, "closed", 2, clock);
  expect(() => store.claim(original, "ezra")).toThrow("stale_lifecycle_evidence");
  expect(store.get(first.peer_id)?.state).toBe("closed");
  expect(store.get(first.peer_id)?.backend_id).toBe("backend-2");
});

test("expired-owner reclaim cannot bypass the compression lifecycle fence", () => {
  const first = store.claim(evidence(), "ezra");
  clock += HERMES_OWNER_LEASE_MS + 1;
  const compressed = evidence();
  compressed.context = { ...compressed.context, session_id: "segment-2" };
  expect(() => store.claim(compressed, "ezra")).toThrow("stale_lifecycle_evidence");
  expect(store.get(first.peer_id)?.current_session_id).toBe("chat-a");
  compressed.lifecycle_generation++;
  const resumed = store.claim(compressed, "ezra");
  expect(resumed.peer_id).toBe(first.peer_id);
  expect(resumed.current_session_id).toBe("segment-2");
});

test("close/reap/orphan disposition is explicit and cannot change or ack broker mail", () => {
  const a = store.claim(evidence(), "ezra");
  db.query("INSERT INTO messages (from_id,to_id,text,sent_at,acked) VALUES (?,?,?,?,0)")
    .run("sender", a.peer_id, "synthetic", new Date(clock).toISOString());
  clock++;
  store.release(a, "orphaned", 2, clock);
  expect(store.status().orphaned).toBe(1);
  const mail = db.query<{ acked: number; to_id: string; text: string }, []>("SELECT acked,to_id,text FROM messages").get()!;
  expect(mail).toEqual({ acked: 0, to_id: a.peer_id, text: "synthetic" });
  clock++;
  expect(() => store.claim(evidence("chat-a", { lifecycle_generation: 3 }), "ezra")).toThrow("conversation_not_resumable");
  expect(dormantMailboxNotice("closed")).toContain("recipient closed, will not be woken");
  expect(dormantMailboxNotice("reaped")).toContain("exact-session resume");
  expect(dormantMailboxNotice("active")).toBeUndefined();
});

test("50 binding cycles leave no active owners and retain each saved identity separately", () => {
  for (let cycle = 0; cycle < 50; cycle++) {
    const group = Array.from({ length: 5 }, (_, i) => store.claim(evidence(`cycle-${cycle}-chat-${i}`), "ezra"));
    expect(store.status().active).toBe(5);
    clock++;
    for (const binding of group) store.release(binding, cycle < 25 ? "closed" : "reaped", 2, clock);
    expect(store.status().active).toBe(0);
    expect(store.status().dormant).toBe((cycle + 1) * 5);
    clock++;
  }
  const summary = store.status();
  expect(summary).toEqual({ active: 0, dormant: 250, orphaned: 0, disposed: 0 });
  // This is a binding-store test, not the later full adapter process/timer/RSS proof.
  const leases = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM hermes_conversations WHERE owner_lease_until <> 0",
  ).get();
  expect(leases?.n).toBe(0);
});
