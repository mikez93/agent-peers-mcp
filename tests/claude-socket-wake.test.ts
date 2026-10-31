import { test, expect } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseWakeMode, formatWakeText, hasAgentPeersChannel, postToInboxSocket, SocketWaker,
  writeSocketWakeMarker, removeSocketWakeMarker, socketWakeMarkerPath, ancestorCommands,
} from "../shared/claude-socket-wake.ts";
import type { LeasedMessage } from "../shared/types.ts";

const msg = (id: number, text = `hello ${id}`): LeasedMessage => ({
  id, from_id: "u1", from_name: "marco-imekka-director-ops-droid", from_peer_type: "droid",
  from_cwd: "/w/imekka-director-ops", from_summary: "Marco: reviewing", to_id: "me", text,
  sent_at: "2026-10-31T00:00:00Z", lease_token: "l",
});

test("channel detection matches the launcher flags only", () => {
  expect(hasAgentPeersChannel("claude --dangerously-load-development-channels server:agent-peers --model opus")).toBe(true);
  expect(hasAgentPeersChannel("claude --channels server:agent-peers")).toBe(true);
  expect(hasAgentPeersChannel("claude --model opus")).toBe(false);
  expect(hasAgentPeersChannel("claude --channels server:other")).toBe(false);
});

test("wake mode: channel sessions stay on the channel, others use the socket", () => {
  const sock = { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock" };
  expect(chooseWakeMode(sock, "claude --dangerously-load-development-channels server:agent-peers")).toBe("channel");
  expect(chooseWakeMode(sock, "claude")).toBe("socket");
  expect(chooseWakeMode({}, "claude")).toBe("none");
  expect(chooseWakeMode({ ...sock, AGENT_PEERS_SOCKET_WAKE: "0" }, "claude")).toBe("none");
  // Desktop app sessions keep the rewake hook unless socket wake is opted in.
  expect(chooseWakeMode({ ...sock, CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, "claude")).toBe("none");
  expect(chooseWakeMode({ ...sock, CLAUDE_CODE_ENTRYPOINT: "claude-desktop", AGENT_PEERS_SOCKET_WAKE: "1" }, "claude")).toBe("socket");
  // A wrapper shell between Claude and the server still finds the channel flag.
  expect(chooseWakeMode(sock, ["/bin/sh -c bun claude-server.ts", "claude --channels server:agent-peers"])).toBe("channel");
  expect(chooseWakeMode(sock, ["/bin/sh -c bun claude-server.ts", "claude"])).toBe("socket");
  // An inner Claude started from an outer channel session's shell is judged
  // by its own flags, not the outer session's.
  expect(chooseWakeMode(sock, ["claude --model opus", "/bin/zsh -c x", "claude --channels server:agent-peers"])).toBe("socket");
  // npm installs run Claude Code under node.
  expect(chooseWakeMode(sock, ["node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --channels server:agent-peers"])).toBe("channel");
});

test("wake text is a notice: senders and ids, never the body", () => {
  const one = formatWakeText([msg(7, "secret plan details")]);
  expect(one).toContain("[Agent Peers] 1 new peer message: #7 from marco-imekka-director-ops-droid");
  expect(one).toContain("check_messages");
  expect(one).toContain("not Mike's instruction");
  expect(one).not.toContain("secret plan details");
  const two = formatWakeText([msg(7), msg(8)]);
  expect(two).toContain("2 new peer messages: #7");
  expect(two).toContain("#8");
});

test("postToInboxSocket sends the auth line then one user message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-sock-"));
  const path = join(dir, "inbox.sock");
  const received: string[] = [];
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => { buf += d.toString(); });
    c.on("end", () => { received.push(buf); });
  });
  await new Promise<void>((r) => server.listen(path, () => r()));
  await postToInboxSocket(path, "tok123", "hi there");
  await new Promise((r) => setTimeout(r, 50));
  server.close();
  const lines = received[0]!.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0]).toEqual({ type: "auth", token: "tok123" });
  expect(lines[1]).toEqual({ type: "user", message: { role: "user", content: "hi there" } });
});

test("SocketWaker batches, retries, then degrades without losing track", async () => {
  const sent: string[] = [];
  let fail = 2;
  const logs: string[] = [];
  const w = new SocketWaker({
    socketPath: "/nope", log: (m) => logs.push(m), maxFailures: 3,
    post: async (_p, _t, content) => { if (fail-- > 0) throw new Error("down"); sent.push(content); },
  });
  w.queue([msg(1), msg(2)]);
  expect(await w.flush()).toBe(false);
  expect(await w.flush()).toBe(false);
  expect(await w.flush()).toBe(true);
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain("#1");
  expect(sent[0]).toContain("#2");

  const w2 = new SocketWaker({ socketPath: "/nope", log: () => {}, maxFailures: 2, post: async () => { throw new Error("x"); } });
  w2.queue([msg(3)]);
  await w2.flush(); await w2.flush();
  expect(w2.degraded).toBe(true);
  expect(w2.pendingCount).toBe(0);
});

test("socket wake marker lifecycle", () => {
  const root = mkdtempSync(join(tmpdir(), "ap-marker-"));
  writeSocketWakeMarker(root, 4242);
  expect(existsSync(socketWakeMarkerPath(root, 4242))).toBe(true);
  expect(readFileSync(socketWakeMarkerPath(root, 4242), "utf8")).toContain("T");
  removeSocketWakeMarker(root, 4242);
  expect(existsSync(socketWakeMarkerPath(root, 4242))).toBe(false);
});

test("ancestorCommands sees this test's parent chain", () => {
  const chain = ancestorCommands(process.pid, 3);
  expect(chain.length).toBeGreaterThan(0);
});
