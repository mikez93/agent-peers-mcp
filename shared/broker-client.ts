// shared/broker-client.ts
// Typed HTTP wrapper around the broker. Used by both MCP servers and cli.ts.

import type {
  RegisterRequest, RegisterResponse, SetSummaryRequest, ListPeersRequest,
  SendMessageRequest, SendMessageResponse, AckMessagesRequest, AckMessagesResponse,
  RenamePeerRequest, RenamePeerResponse,
  HeartbeatRequest, HeartbeatResponse, UnregisterRequest, PollMessagesRequest,
  LeasedMessage, Peer,
} from "./types.ts";

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
  // Note: there is no adminRenamePeer() in the client anymore. cli.ts reads
  // the target peer's session_token from SQLite directly and calls renamePeer
  // with it — see cli.ts cmdRename.
}

export const SECRET_HEADER = "X-Agent-Peers-Secret";

/** Authenticated readiness probe for ensureBroker() and startup gates.
 *
 *  A bare /health 200 proves only that SOMETHING answers on the port — the
 *  exact spoof the launchd-ownership work exists to prevent (a squatter with
 *  a /health endpoint used to satisfy clients indefinitely). When the shared
 *  secret is provisioned, readiness means an authenticated /ready whose body
 *  confirms protocol compatibility. Before the secret exists (first boot on a
 *  fresh machine — the broker itself provisions it), a plain /health probe is
 *  the only option; waitForSharedSecret() gates all real use right after. */
export function createReadinessProbe(
  baseUrl: string,
  readSecret: () => string | null,
): () => Promise<boolean> {
  return async () => {
    const secret = readSecret();
    try {
      if (secret) {
        const res = await fetch(`${baseUrl}/ready`, {
          headers: { [SECRET_HEADER]: secret },
          signal: AbortSignal.timeout(2000),
        });
        // 401 = wrong secret (not our broker); 404 = pre-/ready build.
        // Both mean "not the broker we require" — let ensureBroker kickstart
        // the launchd service, whose startup evicts whatever is squatting.
        if (!res.ok) return false;
        const body = (await res.json()) as { ok?: boolean; protocol?: number };
        return body.ok === true && body.protocol === 1;
      }
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  };
}

export function createClient(baseUrl: string, sharedSecret: string): BrokerClient {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SECRET_HEADER]: sharedSecret,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`broker ${path}: ${res.status} ${await res.text()}`);
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
  };
}
