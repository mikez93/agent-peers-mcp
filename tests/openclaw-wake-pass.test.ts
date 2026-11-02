// bd-b2in.17 OpenClaw wake pass. Marco's AP10809 corrections:
//  #1 busy sessions are queued with a per-request followup, never steered
//     or interrupted, and never gated by a separate idle check;
//  #2 intent and submission identity are durable before chat.send; anything
//     uncertain stays "unknown" across restarts and new mail until cleared;
//  #5 deliver:false, exact agent:<id>:main only.
// Plus: shipping wakes nothing until the per-agent enable file exists.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindOpenClawAgent, buildOpenClawWakeText, clearOpenClawSubmission, rearmOpenClawWake, runOpenClawWakePass, unreadSignature,
} from "../shared/openclaw-wake-pass.ts";
import { ledgerPath, readLedger, tokenHash, writeBinding, writeLedger } from "../shared/openclaw-state.ts";
import {
  OpenClawCliGateway, resolveOpenClawRuntime,
  type ChatSendAck, type ChatSendParams, type InputReceipt, type OpenClawGateway, type OpenClawSessionRow,
} from "../shared/openclaw-gateway.ts";
import type { PeerInboxEntry } from "../shared/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const AGENT = "peers";
const KEY = "agent:peers:main";
const PEER_ID = "9e2c1d4a-0000-4000-8000-000000000001";

function setup(opts: { enabled?: string | null; bound?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ap-openclaw-wake-"));
  dirs.push(root);
  if (opts.enabled !== null) {
    mkdirSync(join(root, "wake"), { recursive: true });
    writeFileSync(join(root, "wake", "enabled"), opts.enabled ?? `# agents\n${AGENT}\n`);
  }
  return root;
}

async function bind(root: string) {
  await writeBinding(root, { version: 1, agent_id: AGENT, session_key: KEY, session_id: "s-1",
    thread_id: "0199aaaa-0000-7000-8000-000000000001", proven_by: "agent-peers-bind-x", proven_at: new Date().toISOString(),
    proven_at_submission: new Date().toISOString(), peer_id: PEER_ID, peer_name: "openclaw-hetzner" });
}

class FakeGateway implements OpenClawGateway {
  calls: string[] = [];
  sends: ChatSendParams[] = [];
  row: OpenClawSessionRow | null = { key: KEY, sessionId: "s-1", hasActiveRun: false };
  sendImpl: (p: ChatSendParams) => Promise<ChatSendAck> = async (p) => ({ runId: p.idempotencyKey, status: "started" });
  receipts: InputReceipt[] = [];
  describeFails = false;
  async describe(key: string, agentId: string) {
    this.calls.push(`describe ${key} ${agentId}`);
    if (this.describeFails) throw new Error("gateway down");
    return this.row;
  }
  async chatSend(p: ChatSendParams) {
    this.calls.push("chat.send");
    this.sends.push(p);
    return this.sendImpl(p);
  }
  async inputReceipts(key: string, _agent: string, ids: string[]) {
    this.calls.push(`chat.history ${key} ${ids.join(",")}`);
    return this.receipts.filter((r) => ids.includes(r.runId));
  }
}

const inboxOf = (ids: number[]) => async (): Promise<PeerInboxEntry[]> =>
  ids.length ? [{ peer_id: PEER_ID, peer_name: "openclaw-hetzner", unread_ids: ids }] : [];

let clock = Date.parse("2026-11-01T12:00:00Z");
const now = () => new Date(clock);
const advance = (ms: number) => { clock += ms; };

test("no enable file: the pass returns nothing and calls neither the broker nor the Gateway", async () => {
  for (const enabled of [null, "", "# nothing here\n", "someone-else\n"]) {
    const root = setup({ enabled });
    await bind(root);
    const gw = new FakeGateway();
    let inboxCalls = 0;
    const results = await runOpenClawWakePass({ root, gateway: gw, now,
      peerInbox: async () => { inboxCalls++; return inboxOf([1])(); } });
    if (enabled === "someone-else\n") {
      expect(results.map((r) => r.agent_id)).toEqual(["someone-else"]);
      expect(results[0]!.state).toBe("unbound");
    } else {
      expect(results).toEqual([]);
      expect(inboxCalls).toBe(0);
    }
    expect(gw.calls).toEqual([]);
  }
});

test("unbound or idle agents make no Gateway calls at all", async () => {
  const root = setup();
  const gw = new FakeGateway();
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) }))[0]!.state).toBe("unbound");
  await bind(root);
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([]) }))[0]!.state).toBe("idle");
  expect(gw.calls).toEqual([]);
});

test("busy session: one followup chat.send into exactly agent:<id>:main, no steer, no interrupt, no idle gate", async () => {
  const root = setup();
  await bind(root);
  const gw = new FakeGateway();
  gw.row = { key: KEY, sessionId: "s-1", hasActiveRun: true };
  let ledgerAtSend: unknown = null;
  gw.sendImpl = async (p) => {
    // Custody before the send: the intent and its identity are already on disk.
    ledgerAtSend = JSON.parse(readFileSync(ledgerPath(root, AGENT), "utf8"));
    return { runId: p.idempotencyKey, status: "started" };
  };
  const [r] = await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([7, 3]) });
  expect(r!.state).toBe("submitted");
  expect(gw.calls).toEqual([`describe ${KEY} ${AGENT}`, "chat.send"]);
  const p = gw.sends[0]!;
  expect(p).toMatchObject({ sessionKey: KEY, agentId: AGENT, queueMode: "followup", deliver: false });
  expect(Object.keys(p).sort()).toEqual(["agentId", "deliver", "idempotencyKey", "message", "queueMode", "sessionKey"]);
  expect(p.idempotencyKey).toBe(r!.submission_id!);
  expect((ledgerAtSend as { submissions: { id: string; state: string; session_id: string }[] }).submissions)
    .toEqual([expect.objectContaining({ id: p.idempotencyKey, state: "intent", session_id: "s-1" })]);
  // The token is in the message only; the ledger keeps its hash.
  const token = p.message.match(/wake="([^"]+)"/)![1]!;
  const raw = readFileSync(ledgerPath(root, AGENT), "utf8");
  expect(raw).not.toContain(token);
  expect(raw).toContain(tokenHash(token));
  const ledger = await readLedger(root, AGENT);
  expect(ledger.submissions[0]).toMatchObject({ state: "accepted", signature: unreadSignature(PEER_ID, [3, 7]) });
});

test("lost response: unknown survives new mail and a daemon restart, and nothing is resubmitted until custody or an operator settles it", async () => {
  const root = setup();
  await bind(root);
  const gw = new FakeGateway();
  gw.sendImpl = async () => { throw new Error("openclaw gateway call chat.send exited 1: timeout"); };
  const [first] = await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) });
  expect(first!.state).toBe("unknown");
  const id = first!.submission_id!;

  // New mail, a later tick, and a "restarted daemon" (fresh gateway object).
  for (const ids of [[1, 2], [1, 2, 3]]) {
    advance(20_000);
    const fresh = new FakeGateway();
    const [r] = await runOpenClawWakePass({ root, gateway: fresh, now, peerInbox: inboxOf(ids) });
    expect(r!.state).toBe("blocked_unknown");
    expect(r!.submission_id).toBe(id);
    expect(fresh.calls).not.toContain("chat.send");
  }
  // Custody later shows it was admitted after all, then consumed.
  advance(20_000);
  gw.receipts = [{ runId: id, state: "pending", queued: true }];
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1, 2, 3]) }))[0]!.state).toBe("waiting");
  advance(20_000);
  gw.receipts = [{ runId: id, state: "consumed", consumedByEventId: "evt-9" }];
  gw.sends = [];
  gw.sendImpl = async (p) => ({ runId: p.idempotencyKey, status: "started" });
  const [after] = await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1, 2, 3]) });
  expect((await readLedger(root, AGENT)).submissions[0]).toMatchObject({ id, state: "consumed" });
  // Consumed frees the agent: the newer unread set gets exactly one new wake.
  expect(after!.state).toBe("submitted");
  expect(gw.sends).toHaveLength(1);
});

test("daemon death between intent and result reads as unknown, and custody, not a retry, resolves it", async () => {
  const root = setup();
  await bind(root);
  const created = now().toISOString();
  await writeLedger(root, { version: 1, agent_id: AGENT, submissions: [{
    id: "agent-peers-wake-crashed", kind: "wake", token_sha256: tokenHash("t"), session_key: KEY, session_id: "s-1",
    signature: unreadSignature(PEER_ID, [1]), state: "intent", created_at: created, updated_at: created }] });
  const gw = new FakeGateway();
  const [r] = await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1, 2]) });
  expect(r!.state).toBe("blocked_unknown");
  expect(gw.calls).toEqual([`describe ${KEY} ${AGENT}`, `chat.history ${KEY} agent-peers-wake-crashed`]);
  expect((await readLedger(root, AGENT)).submissions[0]!.detail).toContain("stopped before chat.send");
  advance(20_000);
  gw.receipts = [{ runId: "agent-peers-wake-crashed", state: "pending" }];
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1, 2]) }))[0]!.state).toBe("waiting");
  expect(gw.calls).not.toContain("chat.send");
});

test("an acknowledged submission with no custody receipt (Gateway restart) or a changed session becomes unknown, never resubmitted", async () => {
  for (const scenario of ["receipt-missing", "session-reset"] as const) {
    const root = setup();
    await bind(root);
    const gw = new FakeGateway();
    const [r] = await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([4]) });
    expect(r!.state).toBe("submitted");
    advance(20_000);
    if (scenario === "session-reset") gw.row = { key: KEY, sessionId: "s-2" };
    gw.sends = [];
    const [next] = await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([4, 5]) });
    expect(next!.state).toBe("blocked_unknown");
    expect(gw.sends).toEqual([]);
    const sub = (await readLedger(root, AGENT)).submissions[0]!;
    expect(sub.state).toBe("unknown");
    expect(sub.detail).toContain(scenario === "session-reset" ? "session changed" : "no custody receipt");
    if (scenario === "session-reset") expect(gw.calls.filter((c) => c.startsWith("chat.history"))).toEqual([]);
  }
});

test("one wake per unread set; an operator clear unblocks only future, different mail", async () => {
  const root = setup();
  await bind(root);
  const gw = new FakeGateway();
  const [r] = await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) });
  const id = r!.submission_id!;
  advance(20_000);
  gw.receipts = [{ runId: id, state: "consumed", consumedByEventId: "e1" }];
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) }))[0]!.state).toBe("already_woken");
  expect(gw.sends).toHaveLength(1);

  // A second wake for new mail goes unknown; the operator clears it.
  gw.sendImpl = async () => { throw new Error("lost"); };
  const [u] = await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1, 2]) });
  expect(u!.state).toBe("unknown");
  expect(await clearOpenClawSubmission(root, AGENT, u!.submission_id!, "checked the transcript", now)).toContain("cleared");
  gw.sendImpl = async (p) => ({ runId: p.idempotencyKey, status: "started" });
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1, 2]) }))[0]!.state).toBe("already_woken");
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1, 2, 3]) }))[0]!.state).toBe("submitted");
});

test("an interrupted active run halts all wakes until an operator lifts it", async () => {
  const root = setup();
  await bind(root);
  const gw = new FakeGateway();
  gw.sendImpl = async (p) => ({ runId: p.idempotencyKey, status: "started", interruptedActiveRun: true });
  await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) });
  advance(20_000);
  gw.receipts = [{ runId: gw.sends[0]!.idempotencyKey, state: "consumed", consumedByEventId: "e" }];
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1, 2]) }))[0]!.state).toBe("halted");
  expect(gw.sends).toHaveLength(1);
  expect(await clearOpenClawSubmission(root, AGENT, "halt", "", now)).toContain("halt cleared");
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1, 2]) }))[0]!.state).toBe("submitted");
});

test("a child that rejoined under a new peer id is still found by name", async () => {
  const root = setup();
  await bind(root);
  const gw = new FakeGateway();
  const moved = async (): Promise<PeerInboxEntry[]> => [{ peer_id: "9e2c1d4a-0000-4000-8000-0000000000ff", peer_name: "openclaw-hetzner", unread_ids: [8] }];
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: moved }))[0]!.state).toBe("submitted");
});

test("no main session or an unreachable Gateway submits nothing and records nothing", async () => {
  const root = setup();
  await bind(root);
  const gw = new FakeGateway();
  gw.row = null;
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) }))[0]!.state).toBe("no_main_session");
  gw.describeFails = true;
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) }))[0]!.state).toBe("gateway_unreachable");
  expect(gw.sends).toEqual([]);
  expect((await readLedger(root, AGENT)).submissions).toEqual([]);
});

test("bind is a bodyless followup with the same custody rules, and refuses while anything is open", async () => {
  const root = setup({ enabled: null }); // binding does not need wakes switched on
  const gw = new FakeGateway();
  const r = await bindOpenClawAgent({ root, agentId: AGENT, gateway: gw, now, newToken: () => "tok-bind" });
  expect(r.state).toBe("submitted");
  expect(gw.sends[0]).toMatchObject({ queueMode: "followup", deliver: false, sessionKey: KEY });
  expect(gw.sends[0]!.message).toBe(buildOpenClawWakeText("bind", "tok-bind", r.submission_id!));
  expect(gw.sends[0]!.message).not.toMatch(/from:|text:/i);
  const again = await bindOpenClawAgent({ root, agentId: AGENT, gateway: gw, now });
  expect(again.state).toBe("blocked_open");
  expect(gw.sends).toHaveLength(1);
});

test("Node 24 is resolved from ~/.local/node and Node 22 is refused", () => {
  const home = mkdtempSync(join(tmpdir(), "ap-openclaw-node-"));
  dirs.push(home);
  const mk = (v: string) => { const d = join(home, ".local", "node", `node-${v}-linux-x64`, "bin"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "node"), ""); return d; };
  mk("v22.23.4");
  expect(resolveOpenClawRuntime({ HOME: home }).nodeBinDir).toBeNull();
  expect(resolveOpenClawRuntime({ HOME: home }).problem).toContain("Node 22");
  const d24 = mk("v24.22.1");
  mk("v24.9.0");
  expect(resolveOpenClawRuntime({ HOME: home }).nodeBinDir).toBe(d24);
  expect(resolveOpenClawRuntime({ HOME: home, AGENT_PEERS_OPENCLAW_NODE_DIR: "/opt/n/bin" }).nodeBinDir).toBe("/opt/n/bin");
});

test("the CLI gateway puts Node 24 first on PATH, drops OPENCLAW_SHELL, and passes closed-schema params", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ap-openclaw-cli-"));
  dirs.push(dir);
  const nodeDir = join(dir, "node24", "bin");
  mkdirSync(nodeDir, { recursive: true });
  const log = join(dir, "argv.json");
  const fake = join(dir, "openclaw");
  writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$PATH" > "${log}.path"
printf '%s\\n' "\${OPENCLAW_SHELL:-unset}" > "${log}.shell"
for a in "$@"; do printf '%s\\n' "$a"; done > "${log}"
case "$3" in
  sessions.describe) echo '{"session":{"key":"agent:peers:main","sessionId":"s-9","hasActiveRun":true,"isMain":true}}' ;;
  chat.send) echo '{"runId":"agent-peers-wake-1","status":"started"}' ;;
  chat.history) echo '{"messages":[],"inputReceipts":[{"runId":"agent-peers-wake-1","state":"pending","queued":true}]}' ;;
  *) echo "unknown method" >&2; exit 3 ;;
esac
`, { mode: 0o755 });
  const gw = new OpenClawCliGateway({ runtime: { openclawBin: fake, nodeBinDir: nodeDir },
    env: { PATH: "/usr/bin:/bin", OPENCLAW_SHELL: "exec", HOME: dir }, timeoutMs: 4000 });
  expect(await gw.describe(KEY, AGENT)).toEqual({ key: KEY, sessionId: "s-9", hasActiveRun: true, isMain: true });
  expect(readFileSync(`${log}.path`, "utf8").trim()).toBe(`${nodeDir}:/usr/bin:/bin`);
  expect(readFileSync(`${log}.shell`, "utf8").trim()).toBe("unset");
  const ack = await gw.chatSend({ sessionKey: KEY, agentId: AGENT, message: "m", queueMode: "followup", deliver: false, idempotencyKey: "agent-peers-wake-1" });
  expect(ack).toEqual({ runId: "agent-peers-wake-1", status: "started" });
  const argv = readFileSync(log, "utf8").trim().split("\n");
  expect(argv.slice(0, 4)).toEqual(["gateway", "call", "chat.send", "--json"]);
  expect(argv[4]).toBe("--params");
  expect(JSON.parse(argv[5]!)).toEqual({ sessionKey: KEY, agentId: AGENT, message: "m", queueMode: "followup", deliver: false, idempotencyKey: "agent-peers-wake-1" });
  expect(argv.slice(6)).toEqual(["--timeout", "4000"]);
  expect(await gw.inputReceipts(KEY, AGENT, ["agent-peers-wake-1"])).toEqual([{ runId: "agent-peers-wake-1", state: "pending", queued: true }]);
  expect(JSON.parse(readFileSync(log, "utf8").trim().split("\n")[5]!)).toEqual({ sessionKey: KEY, agentId: AGENT, limit: 1, maxBytes: 4096, inputRunIds: ["agent-peers-wake-1"] });
  const broken = new OpenClawCliGateway({ runtime: { openclawBin: fake, nodeBinDir: nodeDir }, env: { PATH: "/usr/bin:/bin" } });
  await expect((broken as unknown as { call(m: string, p: object): Promise<unknown> }).call("nope", {})).rejects.toThrow(/exited 3: unknown method/);
});

// Review follow-ups (2026-11-01).
test("a quiet main whose broker row was deleted still wakes for mail held under its bound id", async () => {
  const { initDb, peerInbox: brokerPeerInbox, registerPeer, sendMessage } = await import("../broker.ts");
  const root = setup();
  const db = initDb(join(root, "peers.db"));
  try {
    const oc = registerPeer(db, { peer_type: "openclaw", name: "openclaw-hetzner", pid: process.pid, cwd: "/w", git_root: null, tty: null, summary: "", durable: true });
    const marco = registerPeer(db, { peer_type: "droid", name: "marco-droid", pid: process.pid, cwd: "/w", git_root: null, tty: null, summary: "", durable: true });
    await writeBinding(root, { version: 1, agent_id: AGENT, session_key: KEY, session_id: "s-1",
      thread_id: "0199aaaa-0000-7000-8000-000000000001", proven_by: "agent-peers-bind-x", proven_at: new Date().toISOString(),
      proven_at_submission: new Date().toISOString(), peer_id: oc.id, peer_name: "openclaw-hetzner" });
    expect(sendMessage(db, { from_id: marco.id, session_token: marco.session_token, to_id_or_name: oc.id, text: "while quiet" }).ok).toBe(true);
    db.query("DELETE FROM peers WHERE id = ?").run(oc.id); // what the 7-day durable GC does to a quiet row

    expect(brokerPeerInbox(db, "openclaw")).toEqual([]); // by type alone the mail is invisible
    const seenIds: string[][] = [];
    const gw = new FakeGateway();
    const [r] = await runOpenClawWakePass({ root, gateway: gw, now,
      peerInbox: async (ids) => { seenIds.push(ids); return brokerPeerInbox(db, "openclaw", ids); } });
    expect(seenIds).toEqual([[oc.id]]);
    expect(r!.state).toBe("submitted");
    expect(gw.sends).toHaveLength(1);

    // The woken child's registration (prev_id = the bound id) takes the mail.
    const reborn = registerPeer(db, { peer_type: "openclaw", name: "openclaw-hetzner", pid: process.pid, cwd: "/w", git_root: null, tty: null, summary: "", durable: true, prev_id: oc.id });
    expect(brokerPeerInbox(db, "openclaw", [oc.id])).toEqual([{ peer_id: reborn.id, peer_name: "openclaw-hetzner", unread_ids: [expect.any(Number)] }]);
  } finally {
    db.close();
  }
});

test("bind refuses while wakes are halted", async () => {
  const root = setup();
  await writeLedger(root, { version: 1, agent_id: AGENT, submissions: [], halted: { reason: "test halt", at: now().toISOString() } });
  const gw = new FakeGateway();
  const r = await bindOpenClawAgent({ root, agentId: AGENT, gateway: gw, now });
  expect(r.state).toBe("halted");
  expect(gw.calls).toEqual([]);
});

test("an operator can re-arm one more wake for an unread set whose wake ran but never read it", async () => {
  const root = setup();
  await bind(root);
  const gw = new FakeGateway();
  const [r] = await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) });
  const id = r!.submission_id!;
  expect(await rearmOpenClawWake(root, AGENT, id, "", now)).toContain("still accepted"); // open: refused
  advance(20_000);
  gw.receipts = [{ runId: id, state: "consumed", consumedByEventId: "e1" }];
  const stuck = (await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) }))[0]!;
  expect(stuck).toMatchObject({ state: "already_woken", submission_id: id });
  expect(await rearmOpenClawWake(root, AGENT, id, "turn ended without reading", now)).toContain("re-armed");
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) }))[0]!.state).toBe("submitted");
  expect(gw.sends).toHaveLength(2);
  advance(20_000);
  gw.receipts.push({ runId: gw.sends[1]!.idempotencyKey, state: "consumed", consumedByEventId: "e2" });
  expect((await runOpenClawWakePass({ root, gateway: gw, now, peerInbox: inboxOf([1]) }))[0]!.state).toBe("already_woken");
  expect(gw.sends).toHaveLength(2); // one re-arm buys exactly one wake
});
