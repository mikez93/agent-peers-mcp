#!/usr/bin/env bun
// Test fixture for ensure-broker.test.ts. Pretends to be a broker: serves
// /health on AGENT_PEERS_PORT. If it can see AGENT_PEERS_TEST_OUT (a
// session-only env var that the pinned-env spawn must strip), it writes its
// full env there — the test asserts that file never appears.

import { writeFileSync } from "node:fs";

const port = parseInt(process.env.AGENT_PEERS_PORT ?? "7947", 10);

if (process.env.AGENT_PEERS_TEST_OUT) {
  writeFileSync(process.env.AGENT_PEERS_TEST_OUT, JSON.stringify(process.env));
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, pid: process.pid }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/shutdown") {
      setTimeout(() => { server.stop(true); process.exit(0); }, 10);
      return new Response("bye");
    }
    return new Response("not found", { status: 404 });
  },
});

// Safety: never outlive the test run.
setTimeout(() => process.exit(0), 30_000);
