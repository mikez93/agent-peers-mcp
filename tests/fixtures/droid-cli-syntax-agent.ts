#!/usr/bin/env bun
// Fail at the requested session method: executable syntax tests reach real ACP
// dispatch without starting Factory, loading a session, or invoking a model.
import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.method === "initialize") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {
      protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    } }));
  } else if (frame.method === "session/new" || frame.method === "session/resume") {
    console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id,
      error: { code: -32000, message: `TEST_SESSION:${frame.method}:${frame.params.sessionId ?? "new"}` },
    }));
  }
}
