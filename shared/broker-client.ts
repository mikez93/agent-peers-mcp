// shared/broker-client.ts
// Typed HTTP wrapper around the broker. Used by both MCP servers and cli.ts.

import type {
  RegisterRequest, RegisterResponse, SetSummaryRequest, ListPeersRequest,
  SendMessageRequest, SendMessageResponse, AckMessagesRequest, AckMessagesResponse,
  RenamePeerRequest, RenamePeerResponse,
  HeartbeatRequest, HeartbeatResponse, UnregisterRequest, PollMessagesRequest,
  LeasedMessage, Peer,
} from "./types.ts";
import { existsSync } from "node:fs";
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
 *  Secret handling is fail-closed where it matters: a MISSING secret file is
 *  the legitimate first-boot window (the broker provisions the secret), so
 *  /health liveness bootstraps and waitForSharedSecret() gates all real use.
 *  A PRESENT-but-unreadable/invalid secret file is not bootstrap — it is a
 *  broken trust anchor, and the probe reports not-ready rather than falling
 *  back to spoofable /health. */
export function createReadinessProbe(
  baseUrl: string,
  readSecret: () => string | null,
  opts: { secretFileExists?: () => boolean; expectedDbPath?: () => string } = {},
): () => Promise<boolean> {
  const secretFileExists = opts.secretFileExists ?? (() => defaultSecretFileExists());
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
        const body = (await res.json()) as {
          ok?: boolean; protocol?: number; owner?: string; db_id?: string;
        };
        if (body.ok !== true || body.protocol !== 1) return false;
        const devMode = process.env.AGENT_PEERS_SPAWN_BROKER === "1";
        if (body.owner !== "launchd" && !devMode) return false;
        const expectedDb = opts.expectedDbPath?.() ?? defaultDbPath();
        if (typeof body.db_id === "string" && body.db_id !== expectedDbIdentityHash(expectedDb)) return false;
        return true;
      }
      if (secretFileExists()) return false; // present-but-invalid secret: fail closed
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  };
}

function defaultDbPath(): string {
  return process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db");
}

function defaultSecretFileExists(): boolean {
  const p = process.env.AGENT_PEERS_SECRET_PATH || resolve(homedir(), ".agent-peers-secret");
  return existsSync(p);
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
