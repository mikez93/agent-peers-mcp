// Broker client resilience: secret rotation, timeouts, and old brokers.
// Uses small stand-in HTTP servers so each failure is exact.

import { test, expect, afterEach } from "bun:test";
import { createClient, SECRET_HEADER, BrokerHttpError } from "../shared/broker-client.ts";

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => { while (servers.length) servers.pop()!.stop(true); });

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
}

test("a rotated secret is picked up on 401 and the request is retried once", async () => {
  let current = "new-secret";
  const seen: string[] = [];
  const url = serve((req) => {
    const key = req.headers.get(SECRET_HEADER) ?? "";
    seen.push(key);
    if (key !== current) return new Response("bad secret", { status: 401 });
    return Response.json({ ok: true, known: true });
  });
  let fileSecret = "old-secret";
  const client = createClient(url, () => fileSecret);
  fileSecret = "new-secret"; // the broker regenerated it after the client cached the old one
  const r = await client.heartbeat({ id: "x", session_token: "t" });
  expect(r.known).toBe(true);
  expect(seen).toEqual(["old-secret", "new-secret"]);
  // The fresh secret is now cached: one request, no retry.
  await client.heartbeat({ id: "x", session_token: "t" });
  expect(seen.length).toBe(3);
  current = "other";
});

test("a 401 with no new secret fails without looping", async () => {
  let calls = 0;
  const url = serve(() => { calls++; return new Response("bad", { status: 401 }); });
  const client = createClient(url, () => "same");
  await expect(client.heartbeat({ id: "x", session_token: "t" })).rejects.toBeInstanceOf(BrokerHttpError);
  expect(calls).toBe(1);
});

test("a hung broker times out instead of wedging the tool call", async () => {
  const url = serve(() => new Promise<Response>(() => {}));
  const client = createClient(url, "s", { timeoutMs: 200 });
  const started = Date.now();
  await expect(client.listPeers({ scope: "machine", cwd: "/", git_root: null })).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(2000);
});

test("v3 chat endpoints report absent on an old broker", async () => {
  const url = serve(() => Response.json({ error: "not found" }, { status: 404 }));
  const client = createClient(url, "s");
  expect(await client.listChats({ id: "a", session_token: "b", peer: "valentina" })).toBeNull();
  expect(await client.chatInbox()).toBeNull();
});

test("v3 chat endpoints return data on a new broker", async () => {
  const url = serve(async (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/chat-inbox") return Response.json({ entries: [{ peer_id: "p", peer_name: "valentina-hermes", to_chat: null, title: null, unread: 2, leased: 0, max_id: 9, oldest_sent_at: "t" }] });
    return Response.json({ ok: true, peer: "valentina-hermes", chats: [] });
  });
  const client = createClient(url, "s");
  expect((await client.chatInbox())![0]!.unread).toBe(2);
  expect((await client.listChats({ id: "a", session_token: "b", peer: "valentina" }))!.ok).toBe(true);
});
