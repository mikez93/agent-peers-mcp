// bd-b2in.17, Marco's AP10809 correction #3: the durable mailbox belongs to
// the child that runs agent:<id>:main, proved by Codex's _meta.threadId plus a
// one-time token that only main's input contains. First-child-wins is not used.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideOpenClawRole, OpenClawMailboxGate, threadIdFromMeta } from "../shared/openclaw-gate.ts";
import {
  findSubmissionByToken, readBinding, tokenHash, WAKE_TOKEN_TTL_MS, writeLedger,
  type OpenClawBinding, type Submission,
} from "../shared/openclaw-state.ts";

const dirs: string[] = [];
const sleepers: Bun.Subprocess[] = [];
afterEach(() => {
  for (const s of sleepers.splice(0)) { try { s.kill("SIGKILL"); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const AGENT = "peers";
const T_MAIN = "0199aaaa-0000-7000-8000-000000000001";
const T_OTHER = "0199bbbb-0000-7000-8000-000000000002";
const T_RESET = "0199cccc-0000-7000-8000-000000000003";
const meta = (threadId?: string) => (threadId ? { threadId } : {});

function submission(id: string, token: string, createdAt: string, state: Submission["state"] = "accepted"): Submission {
  return { id, kind: "bind", token_sha256: tokenHash(token), session_key: `agent:${AGENT}:main`, session_id: "s-1",
    signature: null, state, created_at: createdAt, updated_at: createdAt };
}

async function rootWith(subs: Submission[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ap-openclaw-gate-"));
  dirs.push(root);
  await writeLedger(root, { version: 1, agent_id: AGENT, submissions: subs });
  return root;
}

function gate(root: string, pid: number, onMain: () => void = () => {}, claimWaitMs = 300) {
  return new OpenClawMailboxGate({ root, agentId: AGENT, peerName: "openclaw-hetzner", pid, claimWaitMs,
    becomeMain: async () => { onMain(); return { peerId: "peer-1", peerName: "openclaw-hetzner" }; } });
}

async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  await p.exited;
  return p.pid;
}
function livePid(): number {
  const p = Bun.spawn(["sleep", "30"]);
  sleepers.push(p);
  return p.pid;
}

test("role decision table", () => {
  const binding: OpenClawBinding = { version: 1, agent_id: AGENT, session_key: "agent:peers:main", session_id: "s-1",
    thread_id: T_MAIN, proven_by: "b1", proven_at: "2026-11-01T10:00:05Z", proven_at_submission: "2026-11-01T10:00:00Z" };
  const older = submission("b0", "old", "2026-11-01T09:00:00Z");
  const newer = submission("b2", "new", "2026-11-01T11:00:00Z");
  expect(decideOpenClawRole({ agentId: AGENT, binding, threadId: null, proof: newer }).role).toBe("unproven");
  expect(decideOpenClawRole({ agentId: AGENT, binding: null, threadId: T_MAIN, proof: null }).role).toBe("unbound");
  expect(decideOpenClawRole({ agentId: AGENT, binding, threadId: T_MAIN, proof: null })).toEqual({ role: "main", threadId: T_MAIN, rebind: null });
  expect(decideOpenClawRole({ agentId: AGENT, binding, threadId: T_OTHER, proof: null }).role).toBe("secondary");
  // An older token re-read in an old thread cannot pull the binding back.
  expect(decideOpenClawRole({ agentId: AGENT, binding, threadId: T_OTHER, proof: older }).role).toBe("secondary");
  const moved = decideOpenClawRole({ agentId: AGENT, binding, threadId: T_RESET, proof: newer });
  expect(moved).toMatchObject({ role: "main", threadId: T_RESET, rebind: { thread_id: T_RESET, proven_by: "b2", proven_at_submission: newer.created_at } });
  expect(threadIdFromMeta({ threadId: "not-a-thread" })).toBeNull();
  expect(threadIdFromMeta(undefined)).toBeNull();
});

test("tokens prove main only while live: cancelled, cleared and expired submissions do not count", () => {
  const t0 = new Date("2026-11-01T10:00:00Z");
  const ledger = { version: 1 as const, agent_id: AGENT, submissions: [
    submission("a", "ta", t0.toISOString()), submission("c", "tc", t0.toISOString(), "cancelled"),
    submission("d", "td", t0.toISOString(), "cleared"), submission("u", "tu", t0.toISOString(), "unknown") ] };
  expect(findSubmissionByToken(ledger, "ta", t0)?.id).toBe("a");
  expect(findSubmissionByToken(ledger, "tu", t0)?.id).toBe("u");
  expect(findSubmissionByToken(ledger, "tc", t0)).toBeNull();
  expect(findSubmissionByToken(ledger, "td", t0)).toBeNull();
  expect(findSubmissionByToken(ledger, "nope", t0)).toBeNull();
  expect(findSubmissionByToken(ledger, "ta", new Date(t0.getTime() + WAKE_TOKEN_TTL_MS + 1))).toBeNull();
});

test("main session plus a second unrestricted child: only the token-proven thread takes the mailbox", async () => {
  const root = await rootWith([submission("bind-1", "tok-1", new Date().toISOString())]);
  let mainCalls = 0, otherCalls = 0;
  const other = gate(root, process.pid, () => otherCalls++);
  const main = gate(root, process.pid, () => mainCalls++);
  // Before the bind, nobody is main, whatever order the children start in.
  expect(await other.admit(meta(T_OTHER), undefined)).toMatchObject({ ok: false, text: expect.stringContaining("not yet bound") });
  expect(await main.admit(meta(T_MAIN), undefined)).toMatchObject({ ok: false, text: expect.stringContaining("not yet bound") });
  expect(await main.admit(meta(T_MAIN), "tok-1")).toEqual({ ok: true });
  expect(mainCalls).toBe(1);
  expect((await readBinding(root, AGENT))).toMatchObject({ thread_id: T_MAIN, proven_by: "bind-1", peer_id: "peer-1" });
  // The other session never captures it: not without a token, not with main's
  // (already used) token, and it never registers.
  expect(await other.admit(meta(T_OTHER), undefined)).toMatchObject({ ok: false, text: expect.stringContaining("not peers's main session") });
  expect(await other.admit(meta(T_OTHER), "tok-1")).toMatchObject({ ok: false });
  expect(otherCalls).toBe(0);
  expect(other.isMain).toBe(false);
  // Main keeps working without a token; registration happens once.
  expect(await main.admit(meta(T_MAIN), undefined)).toEqual({ ok: true });
  expect(mainCalls).toBe(1);
  // A call with no thread stamp can never be placed.
  const blind = gate(root, process.pid);
  expect(await blind.admit(meta(), "tok-1")).toMatchObject({ ok: false, text: expect.stringContaining("_meta.threadId") });
});

test("restricted and cron turns: a cron session's child is a secondary and stays off the network", async () => {
  // OpenClaw disables MCP servers on policy-restricted turns (docs:
  // plugins/codex-harness-reference/restricted-turns), so those spawn no child.
  // An unrestricted cron session does spawn one, on its own thread.
  const root = await rootWith([submission("bind-1", "tok-1", new Date().toISOString())]);
  await gate(root, process.pid).admit(meta(T_MAIN), "tok-1");
  let cronMain = 0;
  const cron = gate(root, process.pid, () => cronMain++);
  // Every tool call from that thread is refused, before and after a retry.
  expect((await cron.admit(meta(T_OTHER), undefined)).ok).toBe(false);
  expect((await cron.admit(meta(T_OTHER), undefined)).ok).toBe(false);
  expect(cronMain).toBe(0);
  expect(cron.isMain).toBe(false);
});

test("winner death and reconnect: a new child of main's thread waits for a live owner, reclaims a dead one", async () => {
  const root = await rootWith([submission("bind-1", "tok-1", new Date().toISOString())]);
  const ownerPid = livePid();
  const first = gate(root, ownerPid);
  expect(await first.admit(meta(T_MAIN), "tok-1")).toEqual({ ok: true });
  // A second child for the same thread while the owner lives: refused, no second identity.
  let secondMain = 0;
  const second = gate(root, process.pid, () => secondMain++);
  expect(await second.admit(meta(T_MAIN), undefined)).toMatchObject({ ok: false, text: expect.stringContaining("another live process") });
  expect(secondMain).toBe(0);
  // The owner dies (crash, no release). The reconnecting child takes over.
  sleepers[0]!.kill("SIGKILL");
  await sleepers[0]!.exited;
  expect(await second.admit(meta(T_MAIN), undefined)).toEqual({ ok: true });
  expect(secondMain).toBe(1);
  // Same for an owner whose pid was already gone when we looked.
  const root2 = await rootWith([submission("bind-1", "tok-1", new Date().toISOString())]);
  await gate(root2, await deadPid()).admit(meta(T_MAIN), "tok-1");
  expect(await gate(root2, process.pid).admit(meta(T_MAIN), undefined)).toEqual({ ok: true });
});

test("session reset: a newer token moves the binding and the old owner is told to step down", async () => {
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const root = await rootWith([submission("bind-1", "tok-1", t0), submission("wake-2", "tok-2", new Date().toISOString())]);
  const old = gate(root, livePid(), () => {}, 300);
  expect(await old.admit(meta(T_MAIN), "tok-1")).toEqual({ ok: true });
  expect(await old.supersededReason()).toBeNull();
  // New thread after a reset presents the newer token. The old owner is alive,
  // so this call waits, then gives up; the binding has already moved.
  const fresh = gate(root, process.pid, () => {}, 300);
  expect(await fresh.admit(meta(T_RESET), "tok-2")).toMatchObject({ ok: false, text: expect.stringContaining("another live process") });
  expect((await readBinding(root, AGENT))?.thread_id).toBe(T_RESET);
  expect(await old.supersededReason()).toContain("another Codex thread");
  expect(await old.admit(meta(T_MAIN), undefined)).toMatchObject({ ok: false });
  // The old owner steps down (releases its claim); the next call succeeds.
  await old.release();
  expect(await fresh.admit(meta(T_RESET), undefined)).toEqual({ ok: true });
  // The old thread re-presenting its old token cannot pull the binding back.
  expect(await gate(root, process.pid).admit(meta(T_MAIN), "tok-1")).toMatchObject({ ok: false });
  expect((await readBinding(root, AGENT))?.thread_id).toBe(T_RESET);
});
