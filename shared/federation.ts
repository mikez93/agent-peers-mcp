// Broker-owned federation. Network calls never hold a SQLite transaction.
// Transport acceptance is not model acknowledgment: the normal destination
// poll/lease/confirm pipeline remains the only consumer of relayed messages.
import type { Database } from "bun:sqlite";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chatRouteId, defaultIsLocalHost, type RemoteSendRequest, type RemoteSendResult } from "./broker-addressing.ts";
import { parseAddress } from "./peer-address.ts";
import { readSharedSecret } from "./shared-secret.ts";
import { validateFederationConfig, validHost, type FederationConfig } from "./federation-config.ts";
import type { ListChatsResponse, Peer, PeerType, SendMessageRequest, SendMessageResponse } from "./types.ts";

export { loadFederationConfig, type FederationConfig } from "./federation-config.ts";
export const FEDERATION_SECRET_HEADER = "x-agent-peers-federation-secret";
export const FEDERATION_HOST_HEADER = "x-agent-peers-federation-host";
export const UNREACHABLE_HOSTS_HEADER = "x-agent-peers-unreachable-hosts";
const BODY_LIMIT = 2 * 1024 * 1024;
const MAX_TEXT = 100_000;
const PEER_TYPES: PeerType[] = ["claude", "codex", "hermes", "droid"];
const REJECTIONS = new Set(["unknown_peer", "stale_peer", "mailbox_full", "ambiguous", "chat_miss", "invalid"]);

export interface FederationSender {
  /** Reply UUID: the peer itself, or the stable chat route for a chat sender. */
  id: string;
  /** Actual local mailbox owner, used to retain bounce mail across eviction. */
  peer_id: string;
  name: string;
  peer_type: PeerType;
  cwd: string;
  summary: string;
  chat: string | null;
}
export interface FederationEnvelope {
  message_uid: string;
  origin_host: string;
  target_host: string;
  to_address: string;
  sender: FederationSender;
  text: string;
  sent_at: string;
}
export interface FederationNotice {
  to_id: string;
  to_chat: string | null;
  from_id: string;
  text: string;
  sent_at: string;
  message_uid: string;
}
export interface FederationDeps {
  db: Database;
  config: FederationConfig;
  listLocalPeers: (req: { query?: string }) => Peer[];
  sendLocal: (req: SendMessageRequest) => SendMessageResponse;
  snapshotSender: (req: RemoteSendRequest) => FederationSender;
  /** Must synchronously insert into deps.db, without remote resolution. */
  deliverLocal: (message: {
    to_address: string; from_id: string; from_chat: string | null;
    text: string; sent_at: string; message_uid: string;
  }) => SendMessageResponse;
  /** Insert system mail even if its original recipient has since gone stale. */
  deliverNotice: (notice: FederationNotice) => { message_id: number };
  /** Read-only chat lookup for a local Hermes agent; omitted means no
   *  /federation/chats endpoint on this broker. */
  listLocalChats?: (peer: string, req: ChatQuery) => ListChatsResponse;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
export interface ChatQuery { query?: string; limit?: number; offset?: number }
export interface FederationDirectory {
  peers: (Peer & { host: string })[];
  unreachable_hosts: string[];
}
interface SenderSnapshot {
  from_id: string;
  from_name: string;
  from_peer_type: PeerType;
  from_cwd: string;
  from_summary: string;
}
interface OutboxRow {
  id: number;
  message_uid: string;
  host: string;
  envelope: string;
  status: "pending" | "delivered" | "bounced";
  attempts: number;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function str(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= max;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function isSender(value: unknown): value is FederationSender {
  return plain(value) && uuid(value.id) && uuid(value.peer_id)
    && str(value.name, 96) && !/[/@]/.test(value.name)
    && PEER_TYPES.includes(value.peer_type as PeerType) && str(value.cwd, 8192, true)
    && str(value.summary, 8192, true) && (value.chat === null || str(value.chat, 4096));
}
function envelopeFrom(value: unknown): FederationEnvelope | null {
  if (!plain(value) || !uuid(value.message_uid) || !validHost(value.origin_host) || !validHost(value.target_host)
    || !str(value.to_address, 4224) || value.to_address.split("/")[0]!.includes("@")
    || !parseAddress(value.to_address).name
    || !isSender(value.sender) || !str(value.text, MAX_TEXT)
    || !str(value.sent_at, 64) || !Number.isFinite(Date.parse(value.sent_at))) return null;
  // Whitelist instead of relaying arbitrary fields, especially session tokens.
  const s = value.sender;
  return { message_uid: value.message_uid, origin_host: value.origin_host, target_host: value.target_host,
    to_address: value.to_address, sender: { id: s.id, peer_id: s.peer_id, name: s.name,
      peer_type: s.peer_type, cwd: s.cwd, summary: s.summary, chat: s.chat },
    text: value.text, sent_at: value.sent_at };
}
function publicPeer(value: unknown): Peer | null {
  if (!plain(value) || !uuid(value.id) || !str(value.name, 96) || /[/@]/.test(value.name)
    || !PEER_TYPES.includes(value.peer_type as PeerType)
    || !str(value.registered_at, 64) || !str(value.last_seen, 64)) return null;
  return { id: value.id, name: value.name, peer_type: value.peer_type as PeerType,
    pid: Number.isSafeInteger(value.pid) ? value.pid as number : 0,
    cwd: str(value.cwd, 8192, true) ? value.cwd : "",
    git_root: str(value.git_root, 8192) ? value.git_root : null,
    tty: str(value.tty, 1024) ? value.tty : null,
    summary: str(value.summary, 8192, true) ? value.summary : "",
    registered_at: value.registered_at, last_seen: value.last_seen,
    started_at: str(value.started_at, 64) ? value.started_at : value.registered_at,
    persona: str(value.persona, 96) ? value.persona : null };
}
/** Validate another broker's chat list and qualify every name with its host.
 *  The remote's own error text is passed on; it never contains transcript text. */
function remoteChats(body: unknown, host: string): ListChatsResponse | null {
  if (!plain(body) || typeof body.ok !== "boolean") return null;
  if (!body.ok) {
    if (!str(body.error, 1000)) return null;
    const candidates = Array.isArray(body.candidates) && body.candidates.length <= 50
      && body.candidates.every(c => str(c, 200)) ? body.candidates as string[] : undefined;
    return { ok: false, error: `${body.error} (on ${host})`,
      ...(candidates?.length ? { candidates: candidates.map(c => qualified(c, host)) } : {}) };
  }
  if (!str(body.peer, 200) || !Array.isArray(body.chats) || body.chats.length > 50) return null;
  const peer = body.peer;
  const chats: NonNullable<ListChatsResponse["chats"]> = [];
  for (const c of body.chats) {
    if (!plain(c) || !str(c.chat_key, 512) || (c.title != null && !str(c.title, 1000, true))
      || (c.last_active != null && !str(c.last_active, 100))
      || (c.busy !== undefined && typeof c.busy !== "boolean")
      || (c.archived !== undefined && typeof c.archived !== "boolean")) return null;
    chats.push({ chat_key: c.chat_key, title: (c.title ?? null) as string | null,
      ...(c.last_active != null ? { last_active: c.last_active as string } : {}),
      ...(c.busy !== undefined ? { busy: c.busy as boolean } : {}),
      ...(c.archived !== undefined ? { archived: c.archived as boolean } : {}),
      address: qualified(peer, host, c.chat_key) });
  }
  return { ok: true, peer: qualified(peer, host), chats };
}
function qualified(name: string, host: string, chat: string | null = null): string {
  return `${name}@${host}${chat ? `/${chat}` : ""}`;
}
function safeResult(value: unknown): SendMessageResponse | null {
  if (!plain(value) || typeof value.ok !== "boolean") return null;
  if (value.ok && (!Number.isSafeInteger(value.message_id) || (value.message_id as number) < 1)) return null;
  if (!value.ok && (!REJECTIONS.has(value.code as string) || !str(value.error, 16_384))) return null;
  if (value.candidates !== undefined && (!Array.isArray(value.candidates)
    || value.candidates.length > 500 || value.candidates.some(c => !str(c, 4224)))) return null;
  return { ok: value.ok, ...(value.ok ? { message_id: value.message_id as number } : {
    code: value.code as SendMessageResponse["code"], error: value.error as string }),
    ...(str(value.notice, 16_384) ? { notice: value.notice } : {}),
    ...(Array.isArray(value.candidates) ? { candidates: value.candidates as string[] } : {}) };
}
async function boundedJson(message: Request | Response, timeoutMs: number): Promise<unknown> {
  if (Number(message.headers.get("content-length") ?? "0") > BODY_LIMIT || !message.body) {
    throw new Error("invalid federation body size");
  }
  const reader = message.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > BODY_LIMIT) throw new Error("federation body too large");
          chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("federation body timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export class FederationService {
  private readonly db: Database;
  private readonly config: FederationConfig;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private abort = new AbortController();
  private stopped = false;

  constructor(private readonly deps: FederationDeps) {
    validateFederationConfig(deps.config);
    this.db = deps.db;
    this.config = deps.config;
    this.fetcher = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS federation_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_uid TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL, envelope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS federation_outbox_due ON federation_outbox(status, next_attempt, id);
      CREATE TABLE IF NOT EXISTS federation_receipts (
        message_uid TEXT PRIMARY KEY, origin_host TEXT NOT NULL, digest TEXT NOT NULL,
        response TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS federation_routes (
        id TEXT NOT NULL, host TEXT NOT NULL, PRIMARY KEY(id, host)
      );
      CREATE TABLE IF NOT EXISTS federation_senders (
        message_id INTEGER PRIMARY KEY, snapshot TEXT NOT NULL
      );
    `);
  }

  isLocalHost = (host: string): boolean => host.toLowerCase() === this.config.host
    || (this.config.aliases ?? []).includes(host.toLowerCase()) || defaultIsLocalHost(host);

  private secret(): string | null {
    const secret = readSharedSecret(this.config.secretPath);
    // A copied local secret is not federation configuration. Keep old running
    // clients' local credential untouched; reread only for auth repair here.
    return secret && secret !== readSharedSecret(this.config.localSecretPath) ? secret : null;
  }
  private rememberRoute(id: string, host: string): void {
    this.db.query("INSERT OR IGNORE INTO federation_routes (id, host) VALUES (?, ?)").run(id, host);
  }
  remoteRoute = (id: string): { host: string; name: string; chat: null } | null => {
    const rows = this.db.query<{ host: string }, [string]>("SELECT host FROM federation_routes WHERE id = ?").all(id);
    // UUIDs copied onto two machines are not permission to guess a destination.
    return rows.length === 1 ? { host: rows[0]!.host, name: id, chat: null } : null;
  };
  senderForMessage = (id: number): SenderSnapshot | null => {
    const row = this.db.query<{ snapshot: string }, [number]>(
      "SELECT snapshot FROM federation_senders WHERE message_id = ?",
    ).get(id);
    return row ? JSON.parse(row.snapshot) : null;
  };
  private saveSender(id: number, sender: SenderSnapshot): void {
    this.db.query("INSERT INTO federation_senders (message_id, snapshot) VALUES (?, ?)")
      .run(id, JSON.stringify(sender));
  }

  /** Called inside sendMessage's authenticated transaction. No await/fetch. */
  enqueue = (req: RemoteSendRequest): RemoteSendResult => {
    if (req.db !== this.db) return { ok: false, error: "federation database mismatch; nothing queued" };
    if (!this.config.enabled) return { ok: false, error: "federation is disabled; nothing queued" };
    const host = req.host.toLowerCase();
    if (!Object.hasOwn(this.config.hosts, host) || this.isLocalHost(host)) {
      return { ok: false, error: `unknown remote machine "${req.host}"; nothing queued` };
    }
    const sender = this.deps.snapshotSender(req);
    const message = envelopeFrom({ message_uid: randomUUID(), origin_host: this.config.host,
      target_host: host, to_address: req.name + (req.chat ? `/${req.chat}` : ""),
      sender, text: req.text, sent_at: req.sentAt });
    if (!message) return { ok: false, error: "invalid federation message or sender; nothing queued" };
    const row = this.db.query<{ id: number }, [string, string, string, number]>(
      "INSERT INTO federation_outbox (message_uid, host, envelope, created_at) VALUES (?, ?, ?, ?) RETURNING id",
    ).get(message.message_uid, host, JSON.stringify(message), this.now())!;
    // Old clients interpolate the numeric ID directly. Negative receipt IDs
    // distinguish outbox entries from positive local/destination message IDs.
    const senderNotice = req.fromChat && req.fromChat.trim().toLowerCase() !== "general" && !sender.chat
      ? " Your sending chat could not be resolved; replies will go to your general mailbox." : "";
    return { ok: true, message_id: -row.id,
      notice: `queued for ${host}; not yet delivered or seen. Destination rejection will return a delivery notice.${senderNotice}` };
  };

  /** Local wins, including local errors. Only an unknown bare name fans out. */
  async send(req: SendMessageRequest): Promise<SendMessageResponse> {
    const first = this.deps.sendLocal(req);
    if (first.ok || first.code !== "unknown_peer" || !this.config.enabled) return first;
    const parsed = parseAddress(req.to_id_or_name);
    if (parsed.host || !parsed.name) return first;
    const directory = await this.directory(parsed.name);
    const remotes = directory.peers.filter(p => p.host !== this.config.host);
    const candidates = remotes.map(p => p.name + (parsed.chat ? `/${parsed.chat}` : ""));
    if (directory.unreachable_hosts.length) {
      return { ok: false, code: "ambiguous", error: `Cannot resolve "${parsed.name}" while these machines are unreachable: ${directory.unreachable_hosts.join(", ")}. Use an explicit name@host to queue.`,
        candidates };
    }
    if (remotes.length !== 1) return remotes.length === 0 ? first
      : { ok: false, code: "ambiguous", error: `"${parsed.name}" matches multiple remote peers. Resend to an exact name@host.`, candidates };
    // A network wait can outlive a session token, a local registration, or a
    // rename. Recheck local precedence AND authenticate again inside sendLocal.
    const current = this.deps.sendLocal(req);
    if (current.ok || current.code !== "unknown_peer") return current;
    return this.deps.sendLocal({ ...req, to_id_or_name: candidates[0]! });
  }

  private async request(host: string, path: string, timeoutMs: number, body?: unknown): Promise<unknown> {
    const secret = this.secret();
    const base = this.config.hosts[host];
    if (!secret || !base) throw new Error("federation auth or host configuration unavailable");
    const response = await this.fetcher(`${base.replace(/\/$/, "")}/federation/${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.abort.signal]),
      headers: { [FEDERATION_SECRET_HEADER]: secret, [FEDERATION_HOST_HEADER]: this.config.host,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`federation HTTP ${response.status}`);
    }
    return boundedJson(response, timeoutMs);
  }

  /** Live discovery only. Persist UUID routing, never remote peers/directories. */
  async directory(query?: string): Promise<FederationDirectory> {
    const locals = this.deps.listLocalPeers({ query }).map(p => ({ ...p, host: this.config.host }));
    if (!this.config.enabled) return { peers: locals, unreachable_hosts: [] };
    const hosts = Object.keys(this.config.hosts).filter(h => !this.isLocalHost(h));
    const results = await Promise.allSettled(hosts.map(async host => {
      const body = await this.request(host, `directory${query ? `?query=${encodeURIComponent(query)}` : ""}`,
        this.config.discoveryTimeoutMs ?? 1500);
      if (!plain(body) || body.host !== host || !Array.isArray(body.peers) || body.peers.length > 5000) {
        throw new Error("invalid federation directory");
      }
      const peers = body.peers.map(publicPeer);
      if (peers.some(p => !p)) throw new Error("invalid federation directory peer");
      return peers.map(p => ({ ...p!, name: qualified(p!.name, host), host }));
    }));
    const peers = [...locals];
    const unreachable_hosts: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "rejected") unreachable_hosts.push(hosts[i]!);
      else {
        for (const peer of result.value) this.rememberRoute(peer.id, peer.host);
        peers.push(...result.value);
      }
    });
    return { peers, unreachable_hosts };
  }

  /** Live, read-only chat lookup on another machine. Addresses come back
   *  qualified (name@host/chat) so a send goes to the same machine. */
  async chats(rawHost: string, req: ChatQuery & { peer: string }): Promise<ListChatsResponse> {
    if (!this.config.enabled) return { ok: false, error: "federation is disabled on this machine" };
    const host = rawHost.toLowerCase();
    if (!Object.hasOwn(this.config.hosts, host) || this.isLocalHost(host)) {
      return { ok: false, error: `unknown remote machine "${rawHost}"` };
    }
    const params = new URLSearchParams({ peer: req.peer });
    if (req.query !== undefined) params.set("query", req.query);
    if (req.limit !== undefined) params.set("limit", String(req.limit));
    if (req.offset !== undefined) params.set("offset", String(req.offset));
    let body: unknown;
    try {
      body = await this.request(host, `chats?${params}`, this.config.discoveryTimeoutMs ?? 1500);
    } catch (error) {
      // 404 means the other broker predates remote chat lookup.
      const status = error instanceof Error ? error.message : "";
      const reason = status === "federation HTTP 404" ? "its broker is too old to list chats remotely"
        : status === "federation HTTP 401" ? "it refused this machine's federation credentials"
        : "it is unreachable right now";
      return { ok: false, error: `can't list chats on ${host}: ${reason}` };
    }
    return remoteChats(body, host) ?? { ok: false, error: `invalid chat list from ${host}` };
  }

  /** Authenticated federation routes only; caller retains its local auth gate. */
  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/federation/")) return null;
    if (!this.config.enabled) return Response.json({ error: "federation disabled" }, { status: 503 });
    const secret = this.secret();
    const supplied = req.headers.get(FEDERATION_SECRET_HEADER) ?? "";
    const origin = req.headers.get(FEDERATION_HOST_HEADER) ?? "";
    if (!secret || Buffer.byteLength(supplied) !== Buffer.byteLength(secret)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
      || !Object.hasOwn(this.config.hosts, origin) || this.isLocalHost(origin)) {
      return Response.json({ error: "unauthorized federation request" }, { status: 401 });
    }
    if (url.pathname === "/federation/health" && req.method === "GET") {
      return Response.json({ ok: true, host: this.config.host, ...this.status() });
    }
    if (url.pathname === "/federation/directory" && req.method === "GET") {
      const query = url.searchParams.get("query") ?? undefined;
      if (query !== undefined && !str(query, 4096)) return Response.json({ error: "invalid query" }, { status: 400 });
      const peers = this.deps.listLocalPeers({ query }).map(publicPeer);
      if (peers.some(p => !p)) return Response.json({ error: "invalid local directory" }, { status: 500 });
      return Response.json({ host: this.config.host, peers });
    }
    if (url.pathname === "/federation/chats" && req.method === "GET" && this.deps.listLocalChats) {
      const q = url.searchParams;
      const peer = q.get("peer") ?? "";
      const query = q.get("query") ?? undefined;
      if (!str(peer, 200) || (query !== undefined && !str(query, 4096, true))) {
        return Response.json({ error: "invalid chat query" }, { status: 400 });
      }
      const num = (key: string) => q.has(key) ? Number(q.get(key)) : undefined;
      try {
        return Response.json(this.deps.listLocalChats(peer, { query, limit: num("limit"), offset: num("offset") }));
      } catch {
        return Response.json({ error: "chat lookup temporarily unavailable" }, { status: 503 });
      }
    }
    if (url.pathname !== "/federation/relay" || req.method !== "POST") {
      return Response.json({ error: "unknown federation endpoint" }, { status: 404 });
    }
    let message: FederationEnvelope | null;
    try { message = envelopeFrom(await boundedJson(req, this.config.relayTimeoutMs ?? 2000)); }
    catch { return Response.json({ error: "invalid federation payload" }, { status: 400 }); }
    if (!message || message.origin_host !== origin || message.target_host !== this.config.host) {
      return Response.json({ error: "invalid federation envelope" }, { status: 400 });
    }
    try {
      return Response.json(this.receive(message));
    } catch {
      // Leave no receipt on DB/insertion failure. The sender retains its outbox
      // and can retry safely after either broker recovers.
      return Response.json({ error: "federation delivery temporarily unavailable" }, { status: 503 });
    }
  }

  private receive(message: FederationEnvelope): SendMessageResponse {
    const digest = createHash("sha256").update(JSON.stringify(message)).digest("hex");
    return this.db.transaction(() => {
      const receipt = this.db.query<{ origin_host: string; digest: string; response: string }, [string]>(
        "SELECT origin_host, digest, response FROM federation_receipts WHERE message_uid = ?",
      ).get(message.message_uid);
      if (receipt) {
        if (receipt.origin_host !== message.origin_host || receipt.digest !== digest) {
          return { ok: false, code: "invalid" as const, error: "message_uid already belongs to a different envelope" };
        }
        return JSON.parse(receipt.response) as SendMessageResponse;
      }
      const target = parseAddress(message.to_address);
      const named = !uuid(target.name) ? this.deps.listLocalPeers({ query: target.name }) : [];
      // Explicit host addressing is exact. Bare/persona discovery already chose
      // a full name at the origin; a relay must never guess a different session.
      const missing = !uuid(target.name) && !named.some(p => p.name === target.name);
      const result = safeResult(missing ? { ok: false, code: "unknown_peer",
        error: `unknown exact peer: ${target.name}`,
        candidates: named.map(p => p.name + (target.chat ? `/${target.chat}` : "")) } : this.deps.deliverLocal({
        to_address: message.to_address, from_id: message.sender.id, from_chat: message.sender.chat,
        text: message.text, sent_at: message.sent_at, message_uid: message.message_uid,
      }));
      if (!result) throw new Error("invalid local delivery result");
      if (result.ok) {
        const s = message.sender;
        this.saveSender(result.message_id!, { from_id: s.id,
          from_name: qualified(s.name, message.origin_host, s.chat),
          from_peer_type: s.peer_type, from_cwd: s.cwd, from_summary: s.summary });
        this.rememberRoute(s.id, message.origin_host);
      }
      this.db.query("INSERT INTO federation_receipts (message_uid, origin_host, digest, response) VALUES (?, ?, ?, ?)")
        .run(message.message_uid, message.origin_host, digest, JSON.stringify(result));
      return result;
    })();
  }

  private complete(row: OutboxRow, message: FederationEnvelope, result: SendMessageResponse): void {
    this.db.transaction(() => {
      const current = this.db.query<{ status: string }, [number]>(
        "SELECT status FROM federation_outbox WHERE id = ?",
      ).get(row.id);
      if (current?.status !== "pending") return;
      // Success can still mean degraded delivery (an old Hermes adapter's
      // general-mailbox fallback). Never hide that destination warning.
      if (!result.ok || result.notice) {
        const candidates = (result.candidates ?? []).map(c => {
          const p = parseAddress(c);
          return qualified(p.name, row.host, p.chat);
        });
        const target = parseAddress(message.to_address);
        const label = qualified(target.name, row.host, target.chat);
        const systemId = chatRouteId("agent-peers", `system@${row.host}`);
        const notice = this.deps.deliverNotice({
          to_id: message.sender.peer_id, to_chat: message.sender.chat, from_id: systemId,
          text: `${result.ok ? "Delivery update for" : "Delivery failed to"} ${label} (message ${message.message_uid}): ${result.ok ? result.notice : result.error}`
            + (candidates.length ? `\nCandidates: ${candidates.join(", ")}` : "")
            + (result.ok ? "\nQueued at the destination; not proof the recipient has seen it." : "\nNothing was delivered by this attempt."),
          sent_at: new Date(this.now()).toISOString(),
          message_uid: chatRouteId("agent-peers", `${result.ok ? "notice" : "bounce"}:${message.message_uid}`),
        });
        if (!Number.isSafeInteger(notice.message_id) || notice.message_id < 1) throw new Error("invalid notice insertion");
        this.saveSender(notice.message_id, { from_id: systemId, from_name: qualified("agent-peers", row.host),
          from_peer_type: "claude", from_cwd: "", from_summary: "Agent Peers delivery notice" });
      }
      this.db.query("UPDATE federation_outbox SET status = ?, completed_at = ?, last_error = ? WHERE id = ?")
        .run(result.ok ? "delivered" : "bounced", this.now(), result.ok ? null : result.error!, row.id);
    })();
  }
  private retry(row: OutboxRow, error: string): void {
    const attempts = row.attempts + 1;
    const delay = Math.min(this.config.retryMaxMs ?? 300_000,
      (this.config.retryBaseMs ?? 1000) * 2 ** Math.min(attempts - 1, 20));
    this.db.query(`UPDATE federation_outbox SET attempts = attempts + 1, next_attempt = ?, last_error = ?
      WHERE id = ? AND status = 'pending'`).run(this.now() + delay, error, row.id);
  }
  private async relay(row: OutboxRow): Promise<void> {
    try {
      const message = envelopeFrom(JSON.parse(row.envelope));
      if (!message) throw new Error("invalid persisted envelope");
      const result = safeResult(await this.request(row.host, "relay", this.config.relayTimeoutMs ?? 2000, message));
      if (!result) throw new Error("invalid federation response");
      this.complete(row, message, result);
    } catch (error) {
      // Error messages from fetch can contain URLs. Record a bounded category,
      // never credentials, request bodies, or remote response text.
      this.retry(row, error instanceof Error && /^federation HTTP \d+$/.test(error.message)
        ? error.message : "relay unavailable; retry scheduled");
    }
  }
  tick(): Promise<void> {
    if (!this.config.enabled || this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    const rows = this.db.query<OutboxRow, [number]>(
      "SELECT id, message_uid, host, envelope, status, attempts FROM federation_outbox WHERE status = 'pending' AND next_attempt <= ? ORDER BY id LIMIT 32",
    ).all(this.now());
    this.running = Promise.all(rows.map(row => this.relay(row))).then(() => {}).finally(() => { this.running = null; });
    return this.running;
  }
  start(): void {
    if (this.timer || !this.config.enabled) return;
    this.stopped = false;
    this.abort = new AbortController();
    const run = () => { void this.tick().catch(() => console.error("[agent-peers] federation worker database error")); };
    this.timer = setInterval(run, this.config.workerIntervalMs ?? 1000);
    this.timer.unref();
    run();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort();
    await this.running;
  }
  status(): { pending: number; delivered: number; bounced: number } {
    const result = { pending: 0, delivered: 0, bounced: 0 };
    for (const row of this.db.query<{ status: keyof typeof result; n: number }, []>(
      "SELECT status, count(*) AS n FROM federation_outbox GROUP BY status",
    ).all()) {
      if (Object.hasOwn(result, row.status)) result[row.status] = row.n;
    }
    return result;
  }
}
