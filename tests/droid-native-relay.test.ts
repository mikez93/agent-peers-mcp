import { expect, test } from "bun:test";
import { DroidNativeRelay, type DroidFrame } from "../shared/droid-native-relay.ts";
import { DroidWakeController } from "../shared/droid-launcher.ts";

function setup() {
  const daemon: DroidFrame[] = [], tui: DroidFrame[] = [];
  let cancelled = 0;
  const relay = new DroidNativeRelay({
    toDaemon: (frame) => { daemon.push(frame); }, toTui: (frame) => { tui.push(frame); },
    prepareSession: async (frame) => ({ ...frame, params: { ...frame.params, mcpServers: [{ name: "agent-peers" }] } }),
    sessionReady: async () => {}, onCancel: () => { cancelled++; },
  });
  const frame = (method: string, id: string, params: Record<string, any> = {}): DroidFrame => ({
    jsonrpc: "2.0", type: "request", factoryApiVersion: "test-api", factoryProtocolVersion: "test-protocol", method, id, params,
  });
  const notify = (notification: Record<string, unknown>, sessionId = "session") => relay.fromDaemon({
    method: "daemon.session_notification", params: { sessionId, notification },
  });
  async function ready() {
    await relay.fromTui(frame("daemon.initialize_session", "init", { sessionId: "session", token: "private-test-token" }));
    expect(daemon).toHaveLength(0); // Startup frames may arrive before daemon ready.
    await relay.fromDaemon({ type: "ready", pid: 123, version: "0.213.0" });
    const auth = daemon[0]!;
    expect(auth.method).toBe("daemon.authenticate");
    expect(auth.factoryProtocolVersion).toBe("test-protocol");
    await relay.fromDaemon({ id: auth.id, result: { userId: "user" } });
    expect(daemon[1]?.params?.mcpServers).toEqual([{ name: "agent-peers" }]);
    await relay.fromDaemon({ id: "init", result: { sessionId: "session" } });
  }
  return { relay, daemon, tui, frame, notify, ready, cancellations: () => cancelled };
}

test("native auth waits for ready, uses current TUI token, and does not reach the UI", async () => {
  const s = setup();
  await s.ready();
  expect(s.tui).toEqual([{ id: "init", result: { sessionId: "session" } }]);
  expect(s.relay.isBusy).toBe(false);
});

test("wake stays busy until its own turn completes; an unrelated completion is not a receipt", async () => {
  const s = setup(); await s.ready();
  const completion = s.relay.prompt("session", "bodyless wake");
  const request = s.daemon.at(-1)!;
  expect(request.params?.queuePlacement).toBe("end_of_loop");
  expect(s.relay.isBusy).toBe(true);
  await s.relay.fromDaemon({ id: request.id, result: { accepted: true } });
  expect(s.relay.isBusy).toBe(true);
  await s.notify({ type: "agent_turn_completed", turnId: "other" });
  expect(s.relay.isBusy).toBe(true);
  await s.notify({ type: "agent_turn_completed", turnId: request.params?.messageId });
  await completion;
  expect(s.relay.isBusy).toBe(false);
});

test("human queued turns prevent wake even during an idle notification between turns", async () => {
  const s = setup(); await s.ready();
  await s.relay.fromTui(s.frame("daemon.add_user_message", "human", { sessionId: "session", messageId: "human-turn", text: "work" }));
  await s.notify({ type: "droid_working_state_changed", newState: "idle" });
  expect(s.relay.isBusy).toBe(true);
  await expect(s.relay.prompt("session", "wake")).rejects.toThrow("not idle");
  await s.notify({ type: "agent_turn_completed", turnId: "human-turn" });
  expect(s.relay.isBusy).toBe(false);
});

test("native permissions and answers pass through unchanged", async () => {
  const s = setup(); await s.ready();
  const permission = s.frame("daemon.request_permission", "permission", { sessionId: "session", toolUses: [{ name: "Execute" }] });
  await s.relay.fromDaemon(permission);
  expect(s.tui.at(-1)).toEqual(permission);
  const denial = { id: "permission", type: "response", result: { outcome: "cancel" } };
  await s.relay.fromTui(denial);
  expect(s.daemon.at(-1)).toEqual(denial);
});

test("cancel suppresses same-mail retries, while genuinely new mail can wake", async () => {
  let pending = { pendingCount: 1, lastMessageId: 10 };
  let calls = 0;
  const controller = new DroidWakeController("session", { isBusy: false, prompt: async () => { calls++; } },
    { read: async () => pending }, () => {}, [0]);
  await controller.pollOnce(); await controller.waitForIdle();
  controller.suppressCurrentUnread();
  expect((await controller.pollOnce()).action).toBe("unchanged");
  pending = { pendingCount: 2, lastMessageId: 11 };
  expect((await controller.pollOnce()).action).toBe("wake");
  expect(calls).toBe(2);
});

test("interrupt reaches the native daemon and notifies wake suppression", async () => {
  const s = setup(); await s.ready();
  const completion = s.relay.prompt("session", "wake");
  const wake = s.daemon.at(-1)!;
  await s.relay.fromTui(s.frame("daemon.interrupt_session", "stop", { sessionId: "session" }));
  expect(s.cancellations()).toBe(1);
  expect(s.daemon.at(-1)?.method).toBe("daemon.interrupt_session");
  await s.notify({ type: "agent_turn_completed", turnId: wake.params?.messageId });
  await completion;
});

test("canceling a human turn does not suppress unread peer mail", async () => {
  const s = setup(); await s.ready();
  await s.relay.fromTui(s.frame("daemon.add_user_message", "human", { messageId: "turn" }));
  await s.relay.fromTui(s.frame("daemon.interrupt_session", "stop"));
  await s.notify({ type: "agent_turn_completed", turnId: "turn", reason: "cancelled" });
  expect(s.cancellations()).toBe(0);
  expect(s.relay.isBusy).toBe(false);
});

test("queued deletion frees the human turn only after successful daemon acknowledgment", async () => {
  const s = setup(); await s.ready();
  await s.relay.fromTui(s.frame("daemon.add_user_message", "human", { messageId: "turn" }));
  await s.relay.fromTui(s.frame("daemon.resolve_queued_user_message", "delete-failed", { requestId: "human", action: "delete" }));
  await s.relay.fromDaemon({ id: "delete-failed", error: { code: -1, message: "failed" } });
  expect(s.relay.isBusy).toBe(true);
  await s.relay.fromTui(s.frame("daemon.resolve_queued_user_message", "delete", { requestId: "human", action: "delete" }));
  expect(s.relay.isBusy).toBe(true);
  await s.relay.fromDaemon({ id: "delete", result: {} });
  expect(s.relay.isBusy).toBe(false);
});

test("discarded queue notifications release exactly the identified turn", async () => {
  const s = setup(); await s.ready();
  await s.relay.fromTui(s.frame("daemon.add_user_message", "human", { messageId: "turn" }));
  await s.notify({ type: "queued_messages_discarded", requestId: "other", text: "unrelated" });
  expect(s.relay.isBusy).toBe(true);
  await s.notify({ type: "queued_messages_discarded", requestId: "human", text: "discarded" });
  expect(s.relay.isBusy).toBe(false);
  const completion = s.relay.prompt("session", "wake");
  await s.notify({ type: "queued_messages_discarded", requestId: s.daemon.at(-1)!.id, text: "wake" });
  await completion;
  expect(s.cancellations()).toBe(1);
  expect(s.relay.isBusy).toBe(false);
});

test("wake rejection and shutdown settle pending work", async () => {
  const s = setup(); await s.ready();
  const completion = s.relay.prompt("session", "wake");
  const check = completion.catch((error: Error) => error.message);
  await s.relay.fromDaemon({ id: s.daemon.at(-1)?.id, error: { code: -1, message: "busy" } });
  expect(await check).toContain("rejected");
  expect(s.relay.isBusy).toBe(false);
  const next = s.relay.prompt("session", "wake");
  const closed = next.catch((error: Error) => error.message);
  s.relay.close(); expect(await closed).toContain("stopped");
  expect(s.relay.isBusy).toBe(true);
});

test("session switching cannot silently reuse the old peer mailbox", async () => {
  const s = setup(); await s.ready();
  const count = s.daemon.length;
  await s.relay.fromTui(s.frame("daemon.load_session", "switch", { sessionId: "another" }));
  expect(s.daemon.length).toBe(count);
  expect(s.tui.at(-1)?.error?.message).toContain("droidpeer --resume");
});

test("same-session reload cannot reuse an old MCP binding", async () => {
  const s = setup(); await s.ready();
  const count = s.daemon.length;
  await s.relay.fromTui(s.frame("daemon.load_session", "reload", { sessionId: "session" }));
  expect(s.daemon.length).toBe(count);
  expect(s.tui.at(-1)?.error?.message).toContain("loads one session once");
});

test("native close immediately disables wake and a closed notification retires the relay", async () => {
  const s = setup(); await s.ready();
  await s.relay.fromTui(s.frame("daemon.close_session", "close", { sessionId: "session" }));
  expect(s.relay.isBusy).toBe(true);
  await expect(s.relay.prompt("session", "mail")).rejects.toThrow("not idle");
  await expect(s.notify({ type: "session_closed" })).rejects.toThrow("fresh peer binding");
  const count = s.daemon.length;
  await s.relay.fromTui(s.frame("daemon.load_session", "reload", { sessionId: "session" }));
  expect(s.daemon.length).toBe(count);
});

test("native directory changes cannot desynchronize the bound mailbox", async () => {
  const s = setup(); await s.ready();
  const count = s.daemon.length;
  await s.relay.fromTui(s.frame("daemon.change_working_directory", "cwd", { sessionId: "session", workingDirectory: "/other" }));
  expect(s.daemon.length).toBe(count);
  expect(s.tui.at(-1)?.error?.message).toContain("launch directory");
});

test("batch discard releases queued turns while preserving the active turn", async () => {
  const s = setup(); await s.ready();
  for (const id of ["active", "queued1", "queued2"]) {
    await s.relay.fromTui(s.frame("daemon.add_user_message", id, { messageId: id }));
  }
  await s.notify({ type: "create_message", message: { id: "active", role: "user" } });
  await s.notify({ type: "queued_messages_discarded", text: "queued1\nqueued2" });
  expect(s.relay.isBusy).toBe(true);
  await s.notify({ type: "agent_turn_completed", turnId: "active", reason: "cancelled" });
  expect(s.relay.isBusy).toBe(false);
});

test("native UI-only messages pass through without requiring an agent turn", async () => {
  const s = setup(); await s.ready();
  const frame = s.frame("daemon.add_user_message", "notice", { text: "notice", skipAgentLoop: true });
  await s.relay.fromTui(frame);
  expect(s.daemon.at(-1)).toEqual(frame);
  expect(s.relay.isBusy).toBe(false);
});

test("coalesced human input finishes with the enclosing turn; unstarted input stays busy", async () => {
  const s = setup(); await s.ready();
  for (const id of ["active", "coalesced", "queued"]) {
    await s.relay.fromTui(s.frame("daemon.add_user_message", id, { messageId: id }));
  }
  for (const id of ["active", "coalesced"]) {
    await s.notify({ type: "create_message", message: { id, role: "user" } });
  }
  await s.notify({ type: "agent_turn_completed", turnId: "active" });
  expect(s.relay.isBusy).toBe(true);
  await s.notify({ type: "agent_turn_completed", turnId: "queued" });
  expect(s.relay.isBusy).toBe(false);
});

test("authentication failure fails visibly without forwarding queued session credentials", async () => {
  const s = setup();
  await s.relay.fromDaemon({ type: "ready", pid: 123, version: "0.213.0" });
  await s.relay.fromTui(s.frame("daemon.load_session", "resume", { sessionId: "session", token: "private" }));
  await expect(s.relay.fromDaemon({ id: s.daemon[0]?.id, error: { code: -1, message: "rejected" } })).rejects.toThrow("authentication failed");
  expect(s.daemon).toHaveLength(1);
});
