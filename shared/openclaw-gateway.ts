// shared/openclaw-gateway.ts
// The three OpenClaw Gateway methods the wake pass uses, called through the
// supported CLI (`openclaw gateway call <method> --json --params ...`).
// Schemas were read from the installed OpenClaw 2026.10.5 on Hetzner
// (dist/sessions-*.mjs, closed TypeBox objects: unknown fields are rejected):
//
//   sessions.describe { key, agentId? }          -> { session: { key, sessionId, hasActiveRun, isMain, ... } | null }
//   chat.send { sessionKey, agentId?, message, queueMode?, deliver?, idempotencyKey, ... }
//                                                -> { runId, status: "started", messageSeq?, interruptedActiveRun? }
//                                                   (cached retries: "accepted" | "in_flight" | "ok")
//   chat.history { sessionKey, agentId?, limit?, maxBytes?, inputRunIds? }
//                                                -> { ..., inputReceipts?: [{ runId, state: "pending", queued?, cancelled? }
//                                                                          | { runId, state: "consumed", consumedByEventId }] }
//
// chat.send uses idempotencyKey as the runId. inputReceipts are read from the
// durable session_pending_inputs table for the session's CURRENT sessionId
// only; the installed source labels them "durable correlations [that] never
// authorize replay". That table holds a row only while an input waits in the
// queue: a chat.send that starts at once on an idle session never gets one
// (observed for Alex's bind on 2026-11-02). Its custody is then the transcript
// itself: one user event whose __openclaw.runId is our key and whose
// idempotencyKey is "<key>:user". inputReceipts() reports that event as
// consumed, so an idle wake does not end as "unknown".
//
// The CLI needs Node 24.16+ first on PATH: under the box's /usr/bin/node 22
// every DB-backed command exits 1 (node:sqlite truncates TEXT at NUL).

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenClawSessionRow {
  key: string;
  sessionId: string;
  hasActiveRun?: boolean;
  isMain?: boolean;
}

export interface ChatSendParams {
  sessionKey: string;
  agentId: string;
  message: string;
  queueMode: "followup";
  deliver: false;
  idempotencyKey: string;
}

export interface ChatSendAck {
  runId?: string;
  status?: string;
  messageSeq?: number;
  interruptedActiveRun?: boolean;
}

export type InputReceipt =
  | { runId: string; state: "pending"; queued?: true; cancelled?: true }
  | { runId: string; state: "consumed"; consumedByEventId: string };

export interface OpenClawGateway {
  /** Null when the Gateway has no such session. Throws when it cannot answer. */
  describe(key: string, agentId: string): Promise<OpenClawSessionRow | null>;
  /** Throws on anything other than a parsed acknowledgement. */
  chatSend(params: ChatSendParams): Promise<ChatSendAck>;
  /** Receipts for the session's current sessionId. Throws when it cannot answer. */
  inputReceipts(sessionKey: string, agentId: string, runIds: string[]): Promise<InputReceipt[]>;
}

function nodeVersionOk(dirName: string): boolean {
  const m = dirName.match(/^node-v(\d+)\.(\d+)\./);
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2]);
  return (major === 24 && minor >= 16) || (major === 26 && minor >= 1) || major >= 27;
}

export interface OpenClawRuntime {
  openclawBin: string;
  nodeBinDir: string | null;
  problem?: string;
}

/** AGENT_PEERS_OPENCLAW_NODE_DIR (a directory holding `node`) wins; otherwise
 *  the newest suitable ~/.local/node/node-v*\/bin, where Hetzner keeps the
 *  Node 24 that its openclaw-gateway.service runs. */
export function resolveOpenClawRuntime(env: NodeJS.ProcessEnv = process.env): OpenClawRuntime {
  const home = env.HOME ?? homedir();
  const npmBin = join(home, ".npm-global", "bin", "openclaw");
  const openclawBin = env.AGENT_PEERS_OPENCLAW_BIN || (existsSync(npmBin) ? npmBin : "openclaw");
  if (env.AGENT_PEERS_OPENCLAW_NODE_DIR) return { openclawBin, nodeBinDir: env.AGENT_PEERS_OPENCLAW_NODE_DIR };
  const base = join(home, ".local", "node");
  let candidates: string[] = [];
  try { candidates = readdirSync(base).filter(nodeVersionOk); } catch { /* none */ }
  candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const c of candidates) {
    const dir = join(base, c, "bin");
    if (existsSync(join(dir, "node"))) return { openclawBin, nodeBinDir: dir };
  }
  return { openclawBin, nodeBinDir: null,
    problem: "no Node 24.16+ found under ~/.local/node; set AGENT_PEERS_OPENCLAW_NODE_DIR (the openclaw CLI fails under Node 22)" };
}

/** OpenClaw refuses message RPCs from an agent's exec shell
 *  (OPENCLAW_SHELL=exec) so worker output never appears as fresh human input
 *  (installed docs cli/gateway/query.md:427-429, concepts/session-tool.md:296-303).
 *  We honor that instead of stripping the marker: the wake daemon and the
 *  operator CLI are external supervisors and never run inside an agent shell. */
export function agentShellRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const shell = env.OPENCLAW_SHELL;
  return shell
    ? `refusing to call the OpenClaw Gateway: OPENCLAW_SHELL=${shell} marks an OpenClaw agent shell, where OpenClaw refuses message RPCs to keep attribution. `
      + "Run the wake daemon or this CLI from an ordinary login shell or its service instead."
    : null;
}

export class OpenClawCliGateway implements OpenClawGateway {
  constructor(private readonly opts: { runtime: OpenClawRuntime; env?: NodeJS.ProcessEnv; timeoutMs?: number }) {}

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const { runtime } = this.opts;
    if (!runtime.nodeBinDir) throw new Error(runtime.problem ?? "Node 24 for the openclaw CLI is not configured");
    const base = this.opts.env ?? process.env;
    const refusal = agentShellRefusal(base);
    if (refusal) throw new Error(refusal);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
    env.PATH = `${runtime.nodeBinDir}:${base.PATH ?? "/usr/bin:/bin"}`;
    const timeoutMs = this.opts.timeoutMs ?? 15_000;
    const proc = Bun.spawn([runtime.openclawBin, "gateway", "call", method, "--json",
      "--params", JSON.stringify(params), "--timeout", String(timeoutMs)], {
      env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs + 5_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      if (code !== 0) {
        const line = stderr.trim().split("\n").filter(Boolean).pop() ?? "";
        throw new Error(`openclaw gateway call ${method} exited ${code}${line ? `: ${line.slice(0, 300)}` : ""}`);
      }
      try {
        return JSON.parse(stdout);
      } catch {
        throw new Error(`openclaw gateway call ${method} printed no JSON result`);
      }
    } finally {
      clearTimeout(killer);
    }
  }

  async describe(key: string, agentId: string): Promise<OpenClawSessionRow | null> {
    const result = await this.call("sessions.describe", { key, agentId }) as { session?: Record<string, unknown> | null };
    const s = result?.session;
    if (!s || typeof s !== "object") return null;
    if (typeof s.key !== "string" || typeof s.sessionId !== "string") throw new Error("sessions.describe returned a row without key/sessionId");
    return { key: s.key, sessionId: s.sessionId,
      hasActiveRun: typeof s.hasActiveRun === "boolean" ? s.hasActiveRun : undefined,
      isMain: typeof s.isMain === "boolean" ? s.isMain : undefined };
  }

  async chatSend(params: ChatSendParams): Promise<ChatSendAck> {
    const ack = await this.call("chat.send", { ...params }) as ChatSendAck;
    if (!ack || typeof ack !== "object") throw new Error("chat.send returned no acknowledgement");
    return ack;
  }

  async inputReceipts(sessionKey: string, agentId: string, runIds: string[]): Promise<InputReceipt[]> {
    if (runIds.length === 0) return [];
    const ids = runIds.slice(0, 50);
    const result = await this.call("chat.history", {
      sessionKey, agentId, limit: TRANSCRIPT_WINDOW, maxBytes: TRANSCRIPT_MAX_BYTES, inputRunIds: ids,
    }) as { inputReceipts?: unknown; messages?: unknown };
    if (!Array.isArray(result?.inputReceipts)) {
      throw new Error("chat.history returned no inputReceipts (Gateway too old, or the session changed)");
    }
    const receipts = result.inputReceipts as InputReceipt[];
    const missing = ids.filter((id) => !receipts.some((r) => r.runId === id));
    return [...receipts, ...transcriptReceipts(result.messages, missing)];
  }
}

/** Recent transcript searched for inputs that ran without a queue row. An
 *  input older than this window stays "unknown" (fail-closed, operator clear). */
const TRANSCRIPT_WINDOW = 200;
const TRANSCRIPT_MAX_BYTES = 2_000_000;
const USER_SUFFIX = ":user";

/** A consumed receipt for each runId that has its own user event in the
 *  transcript. The proof is the exact idempotencyKey OpenClaw writes for a
 *  chat.send input: "<key>:user". An input that started at once runs under
 *  its own key (__openclaw.runId === key). A followup that queued behind an
 *  active run is drained later under a run id OpenClaw generates itself, but
 *  its user event keeps "<key>:user" (Alex busy wake, 2026-11-02). So the
 *  run id only has to be present, not equal. Anything else stays unknown. */
export function transcriptReceipts(messages: unknown, runIds: string[]): InputReceipt[] {
  if (!Array.isArray(messages) || runIds.length === 0) return [];
  const want = new Set(runIds);
  const out: InputReceipt[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const msg = m as { role?: unknown; idempotencyKey?: unknown; __openclaw?: { runId?: unknown; id?: unknown } };
    const key = msg.idempotencyKey;
    const eventId = msg.__openclaw?.id;
    const ranAs = msg.__openclaw?.runId;
    if (msg.role !== "user" || typeof key !== "string" || !key.endsWith(USER_SUFFIX)) continue;
    const runId = key.slice(0, -USER_SUFFIX.length);
    if (!want.has(runId) || typeof eventId !== "string" || !eventId || typeof ranAs !== "string" || !ranAs) continue;
    want.delete(runId);
    out.push({ runId, state: "consumed", consumedByEventId: eventId });
  }
  return out;
}
