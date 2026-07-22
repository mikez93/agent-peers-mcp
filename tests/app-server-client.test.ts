import { afterEach, expect, test } from "bun:test";

import { CodexAppServerWsClient, formatThreadStatus } from "../shared/app-server-client.ts";

const stoppers: Array<() => void> = [];

test("formatThreadStatus renders each status as a stable operator token", () => {
  // The one bit of logic in `codexpeer live`'s true-status probe: active threads
  // must surface their flags so a parked waitingOnApproval/Input is visually
  // distinct from a genuinely-working `active`, and every other variant maps to
  // its bare type. Covered here so the probe's network wrapper stays dumb.
  expect(formatThreadStatus({ type: "idle" })).toBe("idle");
  expect(formatThreadStatus({ type: "notLoaded" })).toBe("notLoaded");
  expect(formatThreadStatus({ type: "systemError" })).toBe("systemError");
  expect(formatThreadStatus({ type: "active", activeFlags: [] })).toBe("active");
  expect(formatThreadStatus({ type: "active", activeFlags: ["waitingOnApproval"] }))
    .toBe("active:waitingOnApproval");
  expect(formatThreadStatus({ type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"] }))
    .toBe("active:waitingOnApproval,waitingOnUserInput");
});

test("formatThreadStatus tolerates a missing activeFlags array", () => {
  // Defensive: the app-server contract types activeFlags as required, but a
  // malformed/older payload should degrade to bare `active`, not throw inside an
  // operator status command.
  expect(formatThreadStatus({ type: "active" } as never)).toBe("active");
});

afterEach(() => {
  for (const stop of stoppers.splice(0)) {
    try { stop(); } catch { /* best effort */ }
  }
});

test("request rejects when the app-server upgrades but never responds (request timeout)", async () => {
  // A websocket server that accepts the connection but never sends a reply.
  // initialize() (issued inside connect()) should therefore time out, and any
  // caller awaiting connect() should reject rather than hang forever.
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: { open() {}, message() {} },
  });
  stoppers.push(() => server.stop(true));

  const client = new CodexAppServerWsClient(`ws://127.0.0.1:${server.port}`, { timeoutMs: 150 });
  const start = Date.now();
  await expect(client.listLoadedThreads()).rejects.toThrow(/timed out/);
  expect(Date.now() - start).toBeLessThan(2_000);
  client.close();
});

test("connect rejects fast when nothing is listening", async () => {
  // Port 1 is privileged/unused; the connection is refused quickly.
  const client = new CodexAppServerWsClient("ws://127.0.0.1:1", { timeoutMs: 300 });
  const start = Date.now();
  await expect(client.listLoadedThreads()).rejects.toThrow();
  expect(Date.now() - start).toBeLessThan(2_000);
  client.close();
});

test("rollbackThread drops the launcher bootstrap turn", async () => {
  const seen: Array<{ method?: string; params?: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("not a websocket", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const request = JSON.parse(String(raw)) as { id: number; method?: string; params?: unknown };
        seen.push(request);
        const result = request.method === "thread/rollback"
          ? { thread: { id: "thread-1", cwd: "/repo", path: "/rollout", status: { type: "idle" } } }
          : {};
        ws.send(JSON.stringify({ id: request.id, result }));
      },
    },
  });
  stoppers.push(() => server.stop(true));

  const client = new CodexAppServerWsClient(`ws://127.0.0.1:${server.port}`);
  const thread = await client.rollbackThread("thread-1", 1);

  expect(thread.id).toBe("thread-1");
  expect(seen.find((request) => request.method === "thread/rollback")?.params)
    .toEqual({ threadId: "thread-1", numTurns: 1 });
  client.close();
});
