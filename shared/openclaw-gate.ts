// shared/openclaw-gate.ts
// Which OpenClaw agent-peers child owns the agent's durable mailbox (bd-b2in.17,
// Marco's AP10809 correction #3).
//
// OpenClaw scopes an mcp.servers entry per AGENT (codex.agents: [<id>]), but
// the Codex harness starts one stdio child PER SESSION THREAD, and a child
// gets no session in its environment. "First child wins" would let any
// session of the agent (an operator-created chat, an unrestricted cron
// session) capture or strand the main session's mail. So no child takes the
// identity at startup. A child becomes the mailbox owner only on a tools/call
// that proves it runs agent:<id>:main:
//
//   1. Codex stamps the calling thread on every tools/call as _meta.threadId.
//   2. Every wake or bind the daemon/CLI submits (chat.send to exactly
//      agent:<id>:main) carries a one-time token. Only main's input contains
//      it. A call presenting a live token therefore comes from main's thread,
//      and that thread is recorded as the binding.
//   3. Later calls are main iff their _meta.threadId equals the binding.
//      A token can move the binding only if its submission is newer than the
//      one that proved the current binding (a reset or new Codex thread);
//      an older token re-read from an old thread cannot move it back.
//
// Children that cannot prove main register nothing, poll nothing and answer
// every tool with an explanation. A call without _meta.threadId cannot be
// placed at all and is refused: that is the adoption blocker until a live
// OpenClaw probe shows the stamp (docs/components/openclaw-peer.md).

import { HermesNameClaims } from "./hermes-claims.ts";
import {
  findSubmissionByToken, mainSessionKey, readBinding, readLedger, writeBinding,
  type OpenClawBinding, type Submission,
} from "./openclaw-state.ts";
import { join } from "node:path";

const THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function threadIdFromMeta(meta: unknown): string | null {
  const value = meta && typeof meta === "object" ? (meta as Record<string, unknown>).threadId : null;
  return typeof value === "string" && THREAD_ID.test(value) ? value : null;
}

export type OpenClawRole =
  | { role: "main"; threadId: string; rebind: OpenClawBinding | null }
  | { role: "secondary" | "unbound" | "unproven"; reason: string };

/** Pure decision for one tools/call. `proof` is the live submission whose
 *  token the call presented, if any; `bindingProof` is the submission that
 *  proved the current binding (for the newer-only rule). */
export function decideOpenClawRole(opts: {
  agentId: string;
  binding: OpenClawBinding | null;
  threadId: string | null;
  proof: Submission | null;
  now?: Date;
}): OpenClawRole {
  const { agentId, binding, threadId, proof } = opts;
  const key = mainSessionKey(agentId);
  if (!threadId) {
    return { role: "unproven", reason: `agent-peers cannot tell which OpenClaw session this call came from (the tools/call carried no _meta.threadId), so it does not read or send peer mail here. See docs/components/openclaw-peer.md.` };
  }
  if (binding && binding.thread_id === threadId) return { role: "main", threadId, rebind: null };
  const newer = proof && (!binding || Date.parse(proof.created_at) > Date.parse(binding.proven_at_submission ?? binding.proven_at));
  if (proof && newer) {
    const now = (opts.now ?? new Date()).toISOString();
    return { role: "main", threadId, rebind: {
      version: 1, agent_id: agentId, session_key: key, session_id: proof.session_id, thread_id: threadId,
      proven_by: proof.id, proven_at: now, proven_at_submission: proof.created_at,
      ...(binding?.peer_name ? { peer_name: binding.peer_name } : {}),
      ...(binding?.peer_id ? { peer_id: binding.peer_id } : {}),
    } };
  }
  if (!binding) {
    return { role: "unbound", reason: `agent-peers is not yet bound to ${key}. An operator binds it with \`bun cli.ts openclaw bind ${agentId}\`; until then no session of this agent reads or sends peer mail.` };
  }
  return { role: "secondary", reason: `agent-peers: this OpenClaw session is not ${agentId}'s main session (${key}), so it does not read or send peer mail. Peer mail for this agent is handled only in its main session.` };
}

export type GateResult = { ok: true } | { ok: false; text: string };

export class OpenClawMailboxGate {
  private myThread: string | null = null;
  private registration: Promise<void> | null = null;
  private readonly claims: HermesNameClaims;
  private claimed = false;

  constructor(private readonly opts: {
    root: string;
    agentId: string;
    peerName: string;
    pid?: number;
    now?: () => Date;
    /** Registers the peer and starts polling. Called once, after the claim. */
    becomeMain: () => Promise<{ peerId: string; peerName: string }>;
    log?: (msg: string) => void;
    claimWaitMs?: number;
  }) {
    this.claims = new HermesNameClaims(join(opts.root, "name-claims"));
  }

  get isMain(): boolean { return this.myThread !== null; }
  get thread(): string | null { return this.myThread; }

  async admit(meta: unknown, wakeArg: unknown): Promise<GateResult> {
    const threadId = threadIdFromMeta(meta);
    const pid = this.opts.pid ?? process.pid;
    if (this.myThread) {
      if (threadId !== this.myThread) {
        return { ok: false, text: "agent-peers: this call came from a different Codex thread than the one this process serves; refusing." };
      }
      const superseded = await this.supersededReason();
      if (superseded) return { ok: false, text: superseded };
      return this.awaitRegistration();
    }

    const now = this.opts.now?.() ?? new Date();
    let proof: Submission | null = null;
    if (typeof wakeArg === "string" && wakeArg.trim()) {
      try {
        proof = findSubmissionByToken(await readLedger(this.opts.root, this.opts.agentId), wakeArg.trim(), now);
      } catch (e) {
        return { ok: false, text: `agent-peers: cannot read the OpenClaw wake ledger: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const binding = await readBinding(this.opts.root, this.opts.agentId);
    const role = decideOpenClawRole({ agentId: this.opts.agentId, binding, threadId, proof, now });
    if (role.role !== "main") return { ok: false, text: role.reason };

    // Move the binding first: the previous owner (a child of main's previous
    // thread) steps down only once it sees the binding name another thread.
    if (role.rebind) {
      await writeBinding(this.opts.root, role.rebind);
      this.opts.log?.(`openclaw binding: ${role.rebind.session_key} runs on Codex thread ${role.threadId} (proved by ${role.rebind.proven_by})`);
    }
    // Only children of main's thread reach the claim. A live holder is the
    // previous child of main, which steps down within one check interval
    // once the binding has moved. Wait for it rather than registering a
    // second identity.
    const deadline = Date.now() + (this.opts.claimWaitMs ?? 20_000);
    while (!(await this.claims.tryAcquire(this.opts.peerName, pid))) {
      if (Date.now() > deadline) {
        return { ok: false, text: `agent-peers: another live process still owns ${this.opts.peerName}'s mailbox; try again in a minute.` };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    this.claimed = true;
    // A newer proof may have moved the binding while we waited.
    const current = await readBinding(this.opts.root, this.opts.agentId);
    if (!current || current.thread_id !== role.threadId) {
      await this.release();
      return { ok: false, text: "agent-peers: the main-session binding moved to another Codex thread while this call waited; refusing." };
    }
    this.myThread = role.threadId;
    return this.awaitRegistration();
  }

  private async awaitRegistration(): Promise<GateResult> {
    if (!this.registration) {
      this.registration = (async () => {
        const peer = await this.opts.becomeMain();
        const binding = await readBinding(this.opts.root, this.opts.agentId);
        if (binding && binding.thread_id === this.myThread) {
          await writeBinding(this.opts.root, { ...binding, peer_id: peer.peerId, peer_name: peer.peerName });
        }
      })();
    }
    try {
      await this.registration;
      return { ok: true };
    } catch (e) {
      this.registration = null; // a later call retries registration
      return { ok: false, text: `agent-peers: registration failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Non-null once a newer proof moved the binding to another thread. The
   *  owner then stops so the new thread's child can take the mailbox. */
  async supersededReason(): Promise<string | null> {
    if (!this.myThread) return null;
    const binding = await readBinding(this.opts.root, this.opts.agentId);
    if (binding && binding.thread_id !== this.myThread) {
      return `agent-peers: ${binding.session_key} now runs on another Codex thread; this process no longer owns its mailbox.`;
    }
    return null;
  }

  async release(): Promise<void> {
    if (this.claimed) await this.claims.release(this.opts.peerName, this.opts.pid ?? process.pid);
    this.claimed = false;
  }
}
