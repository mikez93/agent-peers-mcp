// shared/broker-client.ts
// Typed HTTP wrapper around the broker. Used by both MCP servers and cli.ts.

import type {
  RegisterRequest, RegisterResponse, SetSummaryRequest, ListPeersRequest,
  SendMessageRequest, SendMessageResponse, AckMessagesRequest, AckMessagesResponse,
  RenamePeerRequest, RenamePeerResponse,
  HeartbeatRequest, HeartbeatResponse, UnregisterRequest, PollMessagesRequest,
  LeasedMessage, Peer, ListChatsRequest, ListChatsResponse, ChatInboxEntry,
} from "./types.ts";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface BrokerClient {
  isAlive(): Promise<boolean>;
  register(req: RegisterRequest): Promise<RegisterResponse>;
  heartbeat(req: HeartbeatRequest): Promise<HeartbeatResponse>;
  unregister(req: UnregisterRequest): Promise<void>;
  setSummary(req: SetSummaryRequest): Promise<void>;
  listPeers(req: ListPeersRequest): Promise<Peer[]>;
  sendMessage(req: SendMessageRequest): Promise<SendMessageResponse>;
  pollMessages(req: PollMessagesRequest): Promise<LeasedMessage[]>;
  ackMessages(req: AckMessagesRequest): Promise<AckMessagesResponse>;
  renamePeer(req: RenamePeerRequest): Promise<RenamePeerResponse>;
  /** v3. Null when the broker predates chat discovery (404). */
  listChats(req: ListChatsRequest): Promise<ListChatsResponse | null>;
  /** v3. Null when the broker predates the chat inbox (404). */
  chatInbox(): Promise<ChatInboxEntry[] | null>;
  // Note: there is no adminRenamePeer() in the client anymore. cli.ts reads
  // the target peer's session_token from SQLite directly and calls renamePeer
  // with it — see cli.ts cmdRename.
}

export const SECRET_HEADER = "X-Agent-Peers-Secret";

/** Same non-secret identity computation as broker.ts dbIdentityHash — lets a
 *  client verify a broker serves the DB the client expects. */
export function expectedDbIdentityHash(dbPath: string): string {
  return Bun.hash(resolve(dbPath)).toString(16).slice(0, 12);
}

/** Authenticated readiness probe for ensureBroker() and startup gates.
 *
 *  A bare /health 200 proves only that SOMETHING answers on the port — the
 *  exact spoof the launchd-ownership work exists to prevent (a squatter with
 *  a /health endpoint used to satisfy clients indefinitely). Readiness means
 *  an authenticated /ready whose body confirms: protocol compatibility,
 *  launchd ownership (a client-owned broker is dev-only — accept it only
 *  when this process itself runs in the AGENT_PEERS_SPAWN_BROKER=1 dev
 *  escape), and the DB identity the client expects.
 *
 *  Secret handling is fail-closed EVERYWHERE, including first boot: with no
 *  readable secret there is no way to authenticate the responder, so the
 *  probe reports not-ready — never falls back to spoofable /health (third
 *  review H3: the bootstrap /health window let any squatter answer during
 *  first boot). Bootstrap still converges without the fallback: not-ready
 *  makes ensureBroker kickstart the launchd service, the real broker
 *  provisions the secret file, and readSecret() is re-read on every probe
 *  call, so the next poll authenticates against /ready. */
export function createReadinessProbe(
  baseUrl: string,
  readSecret: () => string | null,
  opts: { expectedDbPath?: () => string } = {},
): () => Promise<boolean> {
  return async () => {
    const secret = readSecret();
    // No readable secret (missing file OR present-but-unreadable): nothing to
    // authenticate with, so nothing on the port can be verified. Not ready.
    if (!secret) return false;
    try {
      const res = await fetch(`${baseUrl}/ready`, {
        headers: { [SECRET_HEADER]: secret },
        signal: AbortSignal.timeout(2000),
      });
      // 401 = wrong secret (not our broker); 404 = pre-/ready build.
      // Both mean "not the broker we require" — let ensureBroker kickstart
      // the launchd service, whose startup evicts whatever is squatting.
      if (!res.ok) return false;
      const body = (await res.json()) as {
        ok?: boolean; protocol?: number; owner?: string; db_id?: string;
      };
      if (body.ok !== true || body.protocol !== 1) return false;
      // Ownership: launchd always; a client-owned broker only under the
      // explicit AGENT_PEERS_SPAWN_BROKER=1 dev escape — and then only
      // owner="client" exactly, never an arbitrary/absent owner value.
      const devMode = process.env.AGENT_PEERS_SPAWN_BROKER === "1";
      const ownerOk = body.owner === "launchd" || (devMode && body.owner === "client");
      if (!ownerOk) return false;
      // DB identity is REQUIRED: an absent db_id is a broker we can't verify
      // (or a responder that merely echoes ok/protocol), not a pass.
      const expectedDb = opts.expectedDbPath?.() ?? defaultDbPath();
      if (typeof body.db_id !== "string" || body.db_id !== expectedDbIdentityHash(expectedDb)) return false;
      return true;
    } catch {
      return false;
    }
  };
}

function defaultDbPath(): string {
  return process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
}

/** Default per-request timeout. A broker that never answers (hung, or the
 *  Mac waking from sleep) must not wedge an MCP tool call forever. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export class BrokerHttpError extends Error {
  constructor(readonly path: string, readonly status: number, body: string) {
    super(`broker ${path}: ${status} ${body}`);
  }
}

/**
 * `secret` may be a reader function. A reader is called per request, so a
 * rotated secret file is picked up without restarting the session; on a 401
 * the request is retried once with a freshly read secret. A 401 means the
 * broker refused before doing anything, so the retry cannot double-apply.
 * Timeouts are never retried here: a timed-out send may already be stored.
 */
export function createClient(
  baseUrl: string,
  secret: string | (() => string | null),
  opts: { timeoutMs?: number } = {},
): BrokerClient {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const readSecret = typeof secret === "function" ? secret : () => secret;
  let cached = readSecret() ?? "";

  async function send(path: string, body: unknown, key: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [SECRET_HEADER]: key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function postRaw(path: string, body: unknown): Promise<Response> {
    let res = await send(path, body, cached);
    if (res.status === 401 && typeof secret === "function") {
      const fresh = readSecret() ?? "";
      if (fresh && fresh !== cached) {
        cached = fresh;
        res = await send(path, body, cached);
      }
    }
    return res;
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await postRaw(path, body);
    if (!res.ok) throw new BrokerHttpError(path, res.status, await res.text());
    return res.json() as Promise<T>;
  }

  /** For additive endpoints: an older broker answers 404, meaning absent. */
  async function postOptional<T>(path: string, body: unknown): Promise<T | null> {
    const res = await postRaw(path, body);
    if (res.status === 404) return null;
    if (!res.ok) throw new BrokerHttpError(path, res.status, await res.text());
    return res.json() as Promise<T>;
  }

  return {
    async isAlive() {
      try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch { return false; }
    },
    register(req) { return post<RegisterResponse>("/register", req); },
    heartbeat(req) { return post<HeartbeatResponse>("/heartbeat", req); },
    async unregister(req) { await post("/unregister", req); },
    async setSummary(req) { await post("/set-summary", req); },
    listPeers(req) { return post<Peer[]>("/list-peers", req); },
    sendMessage(req) { return post<SendMessageResponse>("/send-message", req); },
    async pollMessages(req) {
      const { messages } = await post<{ messages: LeasedMessage[] }>("/poll-messages", req);
      return messages;
    },
    ackMessages(req) { return post<AckMessagesResponse>("/ack-messages", req); },
    renamePeer(req) { return post<RenamePeerResponse>("/rename-peer", req); },
    listChats(req) { return postOptional<ListChatsResponse>("/list-chats", req); },
    async chatInbox() {
      const r = await postOptional<{ entries: ChatInboxEntry[] }>("/chat-inbox", {});
      return r ? r.entries : null;
    },
  };
}
