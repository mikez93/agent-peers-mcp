# Broker Daemon

Truth-from-code documentation of the `agent-peers-mcp` broker, as of `9be6159`
(the accepted four-host baseline). Line numbers are left out on purpose; use function names.

Primary source: `broker.ts`.
Supporting: `shared/ensure-broker.ts`, `shared/shared-secret.ts`, `shared/types.ts`,
`shared/broker-client.ts`, `shared/broker-addressing.ts`, `shared/peer-address.ts`,
`shared/names.ts`, `shared/federation.ts`.

Related: [federation.md](federation.md) (cross-machine contract and `/federation/*`),
[linux-brokers.md](linux-brokers.md) (systemd deployment),
[openclaw-peer.md](openclaw-peer.md), [hermes-desktop-wake.md](hermes-desktop-wake.md).

---

## 1. Purpose

Each machine runs one broker: a loopback-only HTTP daemon backed by SQLite that is the
registry and message queue for the AI coding agents ("peers") on that machine. It is the
only process that writes `~/.agent-peers.db`; every other component (the Claude, Codex,
Hermes, Droid and OpenClaw MCP servers, and `cli.ts`) talks to it over
`http://127.0.0.1:7900`. The fleet has four machines, each with its own broker and database.
Brokers never share a database. They reach each other only through the optional federation
layer, which is off unless `AGENT_PEERS_FEDERATION=1` (see [federation.md](federation.md)).

It solves four problems:

1. **Discovery.** An agent in one terminal cannot otherwise know that another agent exists,
   what repo it is in, or what it is working on. The broker holds a registry of live peers
   with `cwd`, `git_root`, `tty`, `pid`, `persona` and a self-declared `summary`.
2. **Delivery.** Agents are turn-based and often not executing when a message is sent. The
   broker holds messages in a durable mailbox with lease-and-ack semantics, so a message
   survives the recipient being between turns.
3. **Identity stability.** A named agent (for example `ezra-hermes`) must keep the same UUID
   and mailbox across process restarts, sleep and wake, and MCP server teardown between turns.
4. **Liveness attestation for an external reaper.** An LLM agent waiting on a model response
   sits at about 0% CPU and is indistinguishable from a corpse by any CPU or idle heuristic.
   The broker exposes an authoritative "these pids are live agent work" endpoint that
   MacGuardian's process reaper consults before killing anything (`/v1/protection/check`).

The broker binds to `127.0.0.1` only (hard-coded in `startBroker`). Cross-machine traffic
enters only through the `/federation/*` routes, which Tailscale Serve exposes separately.

---

## 2. Structure of `broker.ts`

| Section | Contents |
| --- | --- |
| Constants | paths, thresholds, `SECRET_HEADER`, `MAX_POLL_BATCH`, `MAX_ACK_TOKENS` |
| Schema and migrations | `initDb`, permission enforcement, nine migrations |
| Peer CRUD | `registerPeer`, `heartbeatPeer`, `unregisterPeer`, `setPeerSummary`, getters |
| Listing | `listPeers` with scope filters, `withPersonaSummary` |
| Send | `sendMessage` (one transaction: sender auth, address resolution, insert) |
| v3 helpers | `insertResolvedMessage`, `deliverRelayed`, `snapshotSender`, `deliverNotice`, `listDirectoryPeers` (federation hooks), `listChats`, `listChatsRouted`, `chatInbox`, `peerInbox` |
| Poll (lease) | `pollMessages`, `pollMessagesScoped` |
| Ack | `ackMessages` with typed per-token outcomes |
| Rename | `renamePeer` |
| GC | `gcStalePeers`, `gcOldMessages`, `shouldSkipGcSweep` |
| Protection check | `ps` snapshots, `buildProtectedPidSet`, `checkProtection` |
| Orphans / inspection | `listOrphanedMessages`, `listAllMessages` (CLI-only, not HTTP) |
| HTTP | `ensureSharedSecret`, `startFederation`, `startBroker` (route table, GC timer, signals) |
| Ownership arbitration | `startBrokerMain`, service-owner eviction loop, `import.meta.main` |

### Schema

**`peers`.** Columns: `id` (UUID PK), `name` (UNIQUE), `peer_type`, `pid`, `cwd`, `git_root`,
`tty`, `summary`, `session_token` (NOT NULL), `registered_at`, `started_at`, `last_seen`,
`durable` (INTEGER, default 0), and four nullable text columns added by migrations: `host`,
`persona`, `capabilities`, `mailbox_owner`. `peer_type` has a CHECK constraint admitting exactly
five values: `claude`, `codex`, `hermes`, `droid`, `openclaw`. `started_at` is working-session
age; `last_seen` is only the liveness heartbeat. `host` is filled with `os.hostname()` on
registration, and a legacy `NULL` means unknown. `persona` is the AGENTS.md persona slug.
`capabilities` is a comma list of feature tags the client implements (for example `chat-mail`).
`mailbox_owner` is set for a Hermes election loser or chat member and names the profile's durable
peer that holds its mail. Indices exist on `last_seen` and `name`. Discovery has no recency index
because the table is tiny and its ordering is `COALESCE(started_at, registered_at)`.

**`messages`.** Columns: `id` (INTEGER AUTOINCREMENT PK), `from_id`, `to_id`, `text`, `sent_at`,
`acked` (default 0), `lease_token`, `lease_expires_at`, `message_uid` (UUID, unique index
`idx_messages_uid`), and two v3 columns, `to_chat` and `from_chat` (Hermes chat keys, null for
general mail). Indices: `(to_id, acked)` and `(to_id, to_chat, acked)`. There are no foreign keys
despite `PRAGMA foreign_keys = ON`, so orphaned messages (rows whose `to_id` no longer exists) are
an expected state, surfaced by `cli.ts orphaned-messages`.

**`chat_routes`** (v3). `id` (PK), `peer_name`, `chat_key`, `title`, `created_at`, `last_used`.
Each row gives one Hermes chat a stable, UUID-shaped route ID (derived from `peer_name` and
`chat_key`) so old clients can reply to a chat by `from_id`. A rename moves `peer_name` but keeps
the ID. Index on `(peer_name, chat_key)`.

**Federation tables.** `federation_outbox`, `federation_receipts`, `federation_routes` and
`federation_senders` are created by the `FederationService` constructor (`shared/federation.ts`),
not by `initDb`, and only when federation starts. Contract in [federation.md](federation.md).

Tables from the retired Hermes V2 runtime (`hermes_conversations` and related) are never created by
current code, but existing databases may still hold them. The broker keeps a passive fence for them
(see [Legacy Hermes conversation fence](#legacy-hermes-conversation-fence)).

### Migrations

`initDb` runs these in a fixed order. Each is wrapped in `BEGIN IMMEDIATE` so concurrent broker
startups serialize, and each is idempotent.

1. `migrate_peers_add_session_token`: adds the column, **deletes every pre-upgrade peer row** (they
   cannot authenticate under the new scheme), self-heals NULL tokens with fresh UUIDs, and rebuilds
   the table if `session_token` is still nullable.
2. `migrate_peers_add_hermes_peer_type`: detects a missing `'hermes'` in the stored CHECK via
   `sqlite_master` and rebuilds the table to widen it.
3. `migrate_peers_add_durable`: `ALTER TABLE ADD COLUMN durable INTEGER NOT NULL DEFAULT 0`.
4. `migrate_messages_add_message_uid`: adds `message_uid`, backfills UUIDs on existing rows, creates
   the unique index. The local integer id collides across brokers; the UID is the global identity
   federation dedupes on.
5. `migrate_peers_add_host`: adds `host TEXT`.
6. `migrate_peers_add_started_at`: adds `started_at`, backfills from `registered_at`, and drops the
   unusable plain-column recency index from an earlier release.
7. `migrate_peers_add_droid_peer_type`: rebuilds `peers` to admit `'droid'`, copying the full column
   list as it stood before v3.
8. `migrate_v3_addressing`: adds `persona`, `capabilities`, `mailbox_owner`, `messages.to_chat`,
   `messages.from_chat`, the `chat_routes` table and its indexes. Additive only, so an older broker
   can still open the database after a rollback.
9. `migrate_peers_add_openclaw_peer_type`: **must stay last.** It widens the CHECK to admit
   `'openclaw'` by copying the table's own stored `CREATE TABLE` text with only the CHECK list
   changed and copying rows by the live column list, so every column added by any earlier migration
   survives. It verifies the row count and rolls back on a mismatch, refuses to run if it cannot
   recognize the stored definition, and recreates the indexes that existed.

Migrations 1, 2 and 7 rebuild `peers` from a column list written in code, so they know nothing of
the v3 columns. They are safe only because they run before `migrate_v3_addressing`. The
session-token rebuild (`rebuildPeersTableWithNotNullSessionToken`) now carries `started_at`,
`durable` and `host` when present.

### File-permission trust boundary

The DB file's POSIX mode is the operator trust boundary (`cli.ts rename`, `messages` and
`orphaned-messages` read SQLite directly rather than going through HTTP). Enforcement is layered:

- `process.umask(0o077)` before `new Database()`, so SQLite-created WAL/SHM sidecars start at 0600.
- `chmodIfExists` on `db`, `db-wal`, `db-shm` before and after migrations, and again on every 30s
  GC tick.
- `enforceDbFilePerms` re-stats each file and **throws** if it is not a regular file, not owned by
  the current uid, or not mode 0600. It runs at startup and on every GC tick; a tick failure calls
  `process.exit(1)`.

### Relationship to `shared/ensure-broker.ts` and `shared/shared-secret.ts`

- **`ensure-broker.ts`** is the client-side "make sure the broker exists" helper. In production it
  does **not** spawn the broker. `serviceStartCommand()` returns `systemctl --user start
  agent-peers-broker` on Linux and `launchctl kickstart gui/<uid>/com.mike.agent-peers-broker`
  elsewhere (both are no-ops if the service is already running), and then it polls a readiness
  callback for up to 15s. The legacy self-spawn path survives only behind
  `AGENT_PEERS_SPAWN_BROKER=1` and pins the child env to `PATH`, `HOME`, and the three
  machine-config vars (`AGENT_PEERS_PORT`, `AGENT_PEERS_DB`, `AGENT_PEERS_SECRET_PATH`), so a
  session's `PEER_NAME` or `cwd` cannot leak into a machine-global daemon.
- **`shared-secret.ts`** is the client-side reader and validator of `~/.agent-peers-secret`.
  `validateSecretFilePerms` rejects symlinks, non-regular files, foreign owners, and any mode other
  than 0600. The broker imports the same function so both sides apply identical checks.
  `waitForSharedSecret` polls for up to 6s after a broker start, since the broker provisions the file.
- **`ensureSharedSecret`** (in `broker.ts`) is the broker-side provisioner: reuse an existing valid
  file (at least 32 chars), otherwise write `<path>.tmp.<pid>.<ts>`, fsync, chmod 0600, and publish
  via `linkSync` (which fails with EEXIST if another broker won the race). On filesystems without
  hard links it falls back to `renameSync`. A short or empty existing file is a hard error with
  recovery instructions rather than an auto-repair, because auto-repair would race concurrent
  brokers.

---

## 3. Public Interfaces

Base URL `http://127.0.0.1:${AGENT_PEERS_PORT ?? 7900}`.

Routing order in `startBroker`:

1. `GET /health` and `GET /ready`. `/health` is unauthenticated; `/ready` requires the secret.
2. `/federation/*`, only when federation started. These carry their own credential and are handled
   by `FederationService.handle` before anything else (see [federation.md](federation.md)). They
   accept `GET` for `health`, `directory` and `chats`, and `POST` for `relay`. The local secret is
   **not** accepted on them.
3. Any other non-`POST` request returns `405`.
4. `POST /v1/protection/check`, unauthenticated and throttled.
5. The secret gate. Every remaining route requires the header `X-Agent-Peers-Secret` matching
   `~/.agent-peers-secret`; a mismatch returns `401 {"error":"missing or invalid x-agent-peers-secret"}`.
6. The route switch. An unknown `POST` path returns `404`. Any thrown error is caught and returned
   as `500 {"error": message}`; no endpoint returns `400`.

Endpoint summary:

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | liveness, pid, epoch, owner |
| `GET /ready` | local secret | readiness contract, capabilities |
| `POST /v1/protection/check` | none, throttled | reaper attestation |
| `POST /register` | local secret | register or reclaim a peer |
| `POST /heartbeat` | local secret | refresh `last_seen`, report `known` |
| `POST /unregister` | local secret | delete a peer row |
| `POST /set-summary` | local secret | set the status line |
| `POST /list-peers` | local secret | discovery; machine scope also lists other machines |
| `POST /send-message` | local secret | address, resolve, queue a message |
| `POST /poll-messages` | local secret | lease unread mail, optionally for one chat |
| `POST /ack-messages` | local secret | confirm leased mail |
| `POST /rename-peer` | local secret | rename the caller |
| `POST /list-chats` | local secret | list a Hermes agent's chats, locally or on another machine |
| `POST /chat-inbox` | local secret | unread Hermes mail grouped by chat (wake daemon) |
| `POST /peer-inbox` | local secret | unread mail per OpenClaw peer (OpenClaw wake pass) |
| `GET /federation/health`, `GET /federation/directory`, `GET /federation/chats`, `POST /federation/relay` | federation secret plus host header | cross-machine, only when federation is on |

### `GET /health` (unauthenticated)

```json
{ "ok": true, "pid": 1234, "epoch": "<uuid>", "owner": "launchd" | "systemd" | "client" }
```

Liveness only. Deliberately unauthenticated so diagnostics can identify the responder. Used by
`createClient().isAlive()` and by `cli.ts kill-broker`.

### `GET /ready` (authenticated)

```json
{ "ok": true, "pid": 1234, "epoch": "<uuid>", "owner": "launchd" | "systemd" | "client",
  "protocol": 1, "db_id": "<12 hex>",
  "capabilities": ["persona-names", "chat-mail", "list-chats", "chat-inbox",
                   "bounded-poll", "peer-inbox", "federation"] }
```

This is the real readiness contract. A bare `/health` 200 is never readiness.
`createReadinessProbe` (`shared/broker-client.ts`) treats a broker as ready only when **all** of
these hold:

- a shared secret is readable (no secret means not ready; there is deliberately **no** fallback to
  `/health`, because a squatter with a `/health` endpoint could otherwise satisfy clients forever
  during first boot);
- HTTP 200 (401 is a wrong secret, 404 a pre-`/ready` build; both are "not the broker we require");
- `ok === true` **and** `protocol === 1`;
- `owner` is `"launchd"` or `"systemd"`, or exactly `"client"` when this client process itself has
  `AGENT_PEERS_SPAWN_BROKER=1`;
- `db_id` is a string equal to `expectedDbIdentityHash(expectedDbPath)`.

`db_id` is `Bun.hash(resolve(dbPath)).toString(16).slice(0,12)`, computed identically in
`broker.ts` and `broker-client.ts`. It identifies the DB **path**, not its contents. The macOS
LaunchAgent reports `owner: "launchd"` and the Linux unit `owner: "systemd"`; the probe accepts
either on every platform. v3 features are advertised in `capabilities`, never by bumping `protocol`
(old clients compare it for equality). `"federation"` is appended only when federation is running.
The probe does not read `capabilities`; it exists for feature detection by newer clients.

### `POST /v1/protection/check` (unauthenticated, throttled)

Request: either `ProtectionQueryEntry[]` or `{ entries: ProtectionQueryEntry[] }`, where an entry is
`{ pid: number, start_time?: string | null }`. Entries beyond 512 are dropped.

Response (`checkProtection`):

```json
{
  "schema": 1,
  "generation": "<uuid, one per broker process>",
  "generated_at": "<iso>",
  "lease_until": "<iso, now + 15s>",
  "protected_count": 42,
  "results": [ { "pid": 1234, "protected": true,
                 "reason": "live_agent_session_tree" | "not_registered"
                          | "process_not_found" | "identity_mismatch",
                 "start_time": "<canonical ps lstart>" | null } ]
}
```

Contract: **positive signal only.** The answer may spare a process; it may never condemn one. A
pid's absence is not evidence of death. The reaper falls back to its own weaker tests and treats any
non-200 (including the `429` throttle) as "broker unusable, reap nothing in broker-dependent
classes". `generation` lets the reaper detect a broker restart between classify time and signal time.

The protected set (`buildProtectedPidSet`) unions two anchor sources: pids from the `peers` table
that are still alive, and any live process whose command matches
`agent-peers-mcp/(claude|codex|hermes|droid|openclaw)-server\.ts`. The second source exists because
the first expires after 60s without a heartbeat. From each anchor it protects the anchor, its parent
(the agent host), and, only for **non-GUI** hosts, the host's entire child subtree. GUI hosts
(`.app/Contents/MacOS/`) are not expanded because ChatGPT.app parents about 200 MCP servers and the
reaper's own `.app`-ancestor test already covers them. The broker's own pid is protected (it is PPID
1 under launchd, which previously made the reaper SIGKILL it every 30 minutes). If `ps` inspection
fails the set is empty: "we vouch for nothing", never "everything is dead".

`start_time` is an identity fence against pid reuse: `canonicalStartTime` collapses whitespace runs
(macOS pads single-digit days) and a mismatch returns `identity_mismatch`, not protection.

Throttle: a global sliding window of 4 requests per 10s (about 10 times the reaper's real cadence).
The endpoint is unauthenticated because the reaper is a separate codebase, and requiring the secret
would widen its trust boundary for no gain: the endpoint only reveals which pids are agent sessions
(derivable from `ps`) and cannot launder protection onto a hostile process, since getting into the
registry requires the secret.

### `POST /register`

Request `RegisterRequest` (`shared/types.ts`): `peer_type`, optional `name`, `pid`, `cwd`, `git_root`,
`tty`, `summary`, optional `started_at`, `durable`, `prev_id`, and the v3 fields `persona` (slug,
truncated to 64 chars), `capabilities` (up to 16 tags matching `^[a-z0-9-]{1,32}$`) and
`mailbox_owner` (a valid name). The v3 fields are rewritten on every register, including reclaims, so
a reclaimed row never keeps a previous incarnation's capabilities. Response: `RegisterResponse`
(`id`, `name`, `session_token`) plus `epoch`.

Semantics (`registerPeer` / `registerPeerInner`), all in one transaction:

- A fresh `session_token` UUID is minted on **every** register, including reclaims. The token is the
  session boundary: after a reclaim the previous incarnation's client can no longer act as this peer.
- **Durability is explicit**: `durable = req.durable === true && req.name && isValidName(req.name)`.
  Merely asking for a name does not reserve it; that older rule let throwaway `hermes mcp test`
  spawns squat names for 7 days.
- **Reclaim fast path**: if `name` matches an existing row **and `peer_type` matches**, and either
  that row's `last_seen` is older than `STALE_RECLAIM_THRESHOLD_MS` (60s) or the row is on this host
  (`host` equals `os.hostname()`) and its recorded pid is provably dead (`kill(pid, 0)` fails with
  ESRCH), the row is UPDATEd in place, preserving the UUID and therefore the mailbox. A legacy `NULL`
  host, a remote host and an uninspectable pid stay age-gated. The type guard stops a `claude`
  process from inheriting `ezra-hermes`'s UUID and queued mail just by asking for the name. On
  reclaim, all leases on that peer's unacked messages are cleared so the new session's first poll
  returns the backlog immediately.
- **Suffix ladder** otherwise (`nameCandidates`): `name`, then `name-2` through `name-99` (via
  `appendSuffixWithinLimit`, which keeps the suffix and trims the base to stay within `NAME_MAX_LEN`
  = **96**), then 100 random `adjective-noun` names, then up to 998 more random names with numeric
  suffixes. Only the peer's *own* requested name gets `durable`; a ladder-assigned fallback is always
  ephemeral. Exhausting the ladder throws.
- A `name` or `prev_id` that belongs to a legacy Hermes conversation mailbox is refused or skipped
  (see [Legacy Hermes conversation fence](#legacy-hermes-conversation-fence)).
- **`prev_id` mailbox migration** (`repointOrphanedMail`): if the client's previous row is **gone**,
  its unacked messages are re-pointed to the new id and their leases cleared. Guard: never when the
  previous row still exists, never self-referential. The code records an **accepted risk**: `prev_id`
  is client-asserted with no proof of prior ownership, so any authenticated peer could claim a dead
  UUID's mail. It is accepted because all clients share one single-user trust boundary. The path
  exists because 5,202 messages had accumulated as permanently unreachable orphans.

### `POST /heartbeat`

Request `{ id, session_token }`. Response `{ ok: true, known: boolean, epoch }`.

`heartbeatPeer` is a single `UPDATE peers SET last_seen WHERE id = ? AND session_token = ?`; `known`
is the row count greater than zero. It exists because an UPDATE matching zero rows is not a SQL
error: after a long broker outage every peer is GC'd, and clients would otherwise heartbeat into
deleted rows forever while invisible to the network. `HeartbeatResponse.known` is optional in the
type on purpose: a broker predating the field omits it, and only an explicit `false` may trigger
re-registration.

### `POST /unregister`

Request `{ id, session_token }`. Response `{ ok: true }` unconditionally. Deletes the peer row; its
messages deliberately remain as orphans.

### `POST /set-summary`

Request `{ id, session_token, summary }`. Response `{ ok: true }` unconditionally. Also bumps
`last_seen`.

### `POST /list-peers`

Request `ListPeersRequest`: `scope` (`"machine" | "directory" | "repo"`), `cwd`, `git_root`, optional
`exclude_id`, `peer_type`, and `local_only`. Response: a **bare `Peer[]` array**, newest working
session first (`COALESCE(started_at, registered_at) DESC`, then `registered_at`, `name`, `id`).

- Always filters `last_seen >= now - STALE_THRESHOLD_MS` (60s), so a closed tab disappears from
  discovery even before GC deletes the row. A durable-but-idle peer is addressable yet absent here.
- `scope: "directory"` adds `cwd = ?`; `scope: "repo"` adds `git_root = ?`, falling back to `cwd = ?`
  when the caller has no git root; `scope: "machine"` adds nothing.
- **Persona status.** Every returned `summary` is prefixed with the agent's persona name
  (`Marco: ...`), computed on read so stored summaries stay exactly what the agent wrote.
- **Federation.** With federation on, `scope: "machine"` also queries the other machines live and
  appends their peers, named `name@host` (about 1.5s per unreachable host). `local_only: true` skips
  this. The response stays a bare array for old clients; hosts that did not answer are listed in the
  `X-Agent-Peers-Unreachable-Hosts` response header. Nothing from other machines is written to `peers`.
- **No GC runs here.** The opportunistic `gcStalePeers()` call was removed: after a laptop wake the
  first `list_peers` raced ahead of every frozen client's first heartbeat and purged the registry (77
  peers to 9, observed 2026-07-14).
- Column projection is explicit and excludes `session_token`. A prior `SELECT *` leaked tokens into
  the discovery response, which collapsed the whole auth model.

### `POST /send-message`

Request `SendMessageRequest`: `from_id`, `session_token`, `to_id_or_name`, `text`, and optional
`from_chat` (the sending Hermes chat, so replies return to it). Response `SendMessageResponse`:
`{ ok: true, message_id, notice? }` or `{ ok: false, error, code?, candidates? }`, where `code` is one
of `unknown_peer`, `stale_peer`, `mailbox_full`, `ambiguous`, `chat_miss`, `invalid`, `unauthorized`.
With federation on, the call goes through `FederationService.send`, which tries local delivery first
and asks other machines only on `unknown_peer`. A successful remote send means **queued**, not
delivered.

One transaction (`sendMessageInner`):

1. Sender auth: the sender row must match `id` + `session_token` **and** be live. Errors distinguish
   `unauthorized sender: <id>` from `sender stale: <name>` (both `code: "unauthorized"`).
2. A target that is a legacy conversation mailbox is handled separately (disposed or full-mailbox
   errors; a dormant-mailbox notice on success).
3. **Address resolution** (`resolveAddress` in `shared/broker-addressing.ts`), in this order: exact peer
   UUID; chat-route UUID; a persisted remote route; `name@host` for another machine; exact peer name
   (case-sensitive); case-insensitive exact name among deliverable peers; persona or leading name
   tokens (`marco` matches `marco-imekka-director-ops-droid`) among deliverable peers. Several matches
   never guess: the sender gets `ambiguous` with the exact names in `candidates`. "Deliverable" means
   live or durable. See [Addressing](#addressing-v3).
4. Deliverability and INSERT are a **single** `INSERT ... SELECT ... RETURNING`, so nothing can
   unregister between check and write. A target is deliverable if it is live **or** durable. Durable
   delivery is what makes "your colleague is idle" stop reading as "your colleague does not exist" for
   a Hermes agent between turns.
5. A **stale durable** target additionally requires fewer than `MAX_QUEUED_PER_DURABLE_PEER` (500)
   unacked messages; a live target bypasses the cap entirely.
6. On no insert, two distinguishable errors: `target peer mailbox full: <name> (<n> undelivered; it has
   not polled since <ts>)` (`mailbox_full`) and `target peer stale: <name>` (`stale_peer`). An
   unresolved name is `unknown peer: <x>` (`unknown_peer`).
7. The result may carry a `notice`, for example when a name matched loosely (`delivered to <name>`),
   when the recipient has not switched to per-chat mail and the message went to its general mailbox,
   or when the sender's chat could not be identified.

### `POST /poll-messages`

Request `{ id, session_token, chat? }`. Response: `{ messages: LeasedMessage[] }` when `chat` is
omitted; when `chat` is a string the response is `{ messages, scope, chat_key }`, where `scope` is
`"general"`, `"chat"` or `"none"` and `chat_key` is the resolved stable key.

`pollMessagesScoped`, one transaction:

1. Auth is the `session_token` match. A wrong token or missing peer returns an empty list, which is
   deliberately indistinguishable from an empty mailbox (it exposes nobody's mailbox).
2. **Heartbeat, throttled.** `last_seen` is refreshed only if it is at least `POLL_HEARTBEAT_WRITE_MS`
   (10s) old. Sessions poll about once a second, and an unconditional UPDATE made every empty poll a
   durable write.
3. **Mail scope** (`resolvePollScope`). A poll without `chat` (every old client, every non-Hermes
   client) draws only **general** mail (`to_chat IS NULL`), so chat-addressed mail can never be
   consumed by the wrong conversation. A Hermes chat names itself and draws only its own mail, which
   lives in the profile's durable owner mailbox. A chat that cannot be resolved yields `scope: "none"`
   and no mail. The reserved chat name `general` reads the general mailbox.
4. Selects up to `MAX_POLL_BATCH` (**100**) rows with `acked = 0` and a null or expired lease, ordered
   `id ASC` (FIFO).
5. Each row gets a fresh `lease_token` UUID and `lease_expires_at = now + LEASE_DURATION_MS`
   (**30 seconds**).
6. Each `LeasedMessage` is enriched with sender context looked up live: `from_name`, `from_peer_type`,
   `from_cwd`, `from_summary` (persona-prefixed), plus `to_chat` and `from_chat` when set. A deleted
   sender yields `from_name: "(gone)"` and `from_peer_type: "claude"`. When the sender was a Hermes
   chat, `from_id` is the stable chat-route UUID and `from_name` is `<owner>/<chat key>`, so replies
   return to that chat. For mail relayed from another machine the stored federation sender snapshot is
   used instead.

Delivery is **at-least-once**: a message whose lease expires before an ack arrives is re-offered on the
next poll.

### `POST /ack-messages`

Request `AckMessagesRequest`: `{ id, session_token, lease_tokens: string[] }`. Response
`AckMessagesResponse`: `{ ok: true, acked, stale?, results? }`.

`ackMessages`: an empty token array short-circuits to `{ ok: true, acked: 0, stale: 0, results: [] }`.
More than `MAX_ACK_TOKENS` (**1000**) tokens throws (returned as `500`). Otherwise, in one
transaction: snapshot which submitted tokens currently exist, then `UPDATE messages SET acked = 1,
lease_token = NULL, lease_expires_at = NULL` where the token matches **and** `to_id` is the caller's
own mailbox (the peer row with the caller's `session_token`, **or** the profile owner's mailbox named
by the caller's `mailbox_owner`, so a Hermes chat member can confirm its own chat's mail) **and**
`acked = 0` **and** the lease has not expired. Auth is a subquery inside the UPDATE, so there is no
TOCTOU window across a reclaim rotation.

When `acked < lease_tokens.length`, per-token outcomes are returned (`AckTokenStatus`):

| status | meaning |
| --- | --- |
| `acked` | this call acked it (or it was already acked) |
| `expired` | the lease outlived the caller's tool cycle; the broker **will re-offer** the message, so the caller must not treat it as delivered |
| `wrong_session` | the message is not addressed to the calling peer's current session or mailbox owner |
| `unknown` | the token was never issued, or none of the above applies |

`stale` is the count of `expired`. This exists to kill the success-shaped `{ok:true, acked:0}` blind
spot.

### `POST /rename-peer`

Request `{ id, session_token, new_name }`. Response `{ ok: true, name }` or `{ ok: false, error }`.

Validates the name (`isValidName`: 1 to 96 chars, `^[a-zA-Z0-9_-]+$`, not UUID-shaped), then an
atomic auth-and-rename UPDATE with `session_token` in the WHERE. Zero changes returns `unauthorized
rename` for both "unknown id" and "wrong token" (no auth-versus-enumeration leak). A UNIQUE violation
returns `name taken`; a name reserved by a legacy conversation returns `name reserved by
conversation`. A successful rename also moves `chat_routes.peer_name` and any `mailbox_owner` that
pointed at the old name, keeping route UUIDs so replies to chats addressed before the rename still land.

There is **no** broker-side admin rename and no `/admin/rename-peer` endpoint; an earlier version had
one and any local process could hijack any peer's identity. `cli.ts rename` instead reads the target's
`session_token` straight out of the SQLite file and calls the normal session-authenticated endpoint.
Likewise there are no `/orphaned-messages` or `/all-messages` endpoints; the CLI opens SQLite
read-only.

### `POST /list-chats`

Request `ListChatsRequest`: `{ id, session_token, peer, query?, limit?, offset? }`. Response
`ListChatsResponse`: `{ ok, peer, chats: [{ ..., address }] }` or `{ ok: false, error, candidates? }`.

The caller must be a live, authenticated peer. `peer` is a Hermes agent's name, optionally
`name@host`. Only Hermes agents have chats (other types return an error). Results are titles and
status only, never transcript text; the call adopts nothing, wakes nothing and consumes no mail.
`limit` is clamped to 1 through 50 (default 20), and `query` is truncated to 200 chars. Each chat's
`address` is `<owner>/<chat key>`. For another machine the lookup is forwarded through
`GET /federation/chats` and the returned addresses are qualified (`name@host/<chat key>`). A bare name
unknown locally follows the bare-name send rules: exactly one remote Hermes match is listed; several
matches, or an unreachable machine that might hold another, need an explicit `name@host`. With
federation off, a remote `name@host` returns an error.

### `POST /chat-inbox`

Response `{ entries: ChatInboxEntry[] }`: unread Hermes mail grouped by recipient chat (`peer_id`,
`peer_name`, `to_chat`, `title`, `unread`, `leased`, `max_id`, `oldest_sent_at`). It is consumed by the
Hermes wake pass in the wake daemon. General mail is listed only for owners that advertise the
`chat-mail` capability, so old Hermes processes keep their behavior until they restart on new code.

### `POST /peer-inbox`

Request `{ peer_type, peer_ids? }`. Response `{ entries: PeerInboxEntry[] }` (`peer_id`, `peer_name`,
`unread_ids` capped at 500). Only `peer_type: "openclaw"` returns anything. Up to 32 explicit UUIDs in
`peer_ids` are matched on `messages.to_id` directly, because an OpenClaw child heartbeats only while
its thread is loaded and the broker may have deleted a quiet durable row while its mail still waits.
Consumed by the OpenClaw wake pass; see [openclaw-peer.md](openclaw-peer.md).

### Addressing (v3)

- **Names.** The default name is `persona-repository-harness`, built client-side by
  `shared/peer-identity.ts` from the AGENTS.md persona declaration, the git repository name and the
  harness (`vector-agentic-coding-resources-codex`, `marco-imekka-director-ops-droid`), with
  `repository-harness` as the fallback when no unambiguous persona is declared. A set `PEER_NAME`
  overrides it. Names are case-sensitive, 1 to 96 characters, `[a-zA-Z0-9_-]`, never UUID-shaped.
- **Persona lookup.** `shared/peer-address.ts` derives a persona from the registered `persona` field or,
  failing that, the first token of a generated name. A query such as `marco` matches any deliverable
  peer whose name equals it or starts with `marco-`, or whose persona is `marco`.
- **Address syntax.** `name[@host][/chat]`. The first `/` starts the chat part (a Hermes chat title,
  session ID or chat key). `@host` names a federation machine. `name@host` is exact: it skips local
  resolution and goes to that machine. Chat addresses work only for Hermes agents.
- **Chat mail isolation.** Chat-addressed mail is stored in the profile owner's mailbox with `to_chat`
  set and is returned only to a poll that names that chat; general mail is returned only to a poll
  without a chat. A recipient without the `chat-mail` capability gets such messages in its general
  mailbox, with a notice to the sender.
- **Ambiguity never guesses.** Multiple matches return the exact names (or `name@host` forms) so the
  sender can resend.

### Legacy Hermes conversation fence

The Hermes V2 runtime was retired (see [../legacy-hermes-v2.md](../legacy-hermes-v2.md)). The broker
still routes every mutation through `withConversationFence` and `findConversation`
(`shared/hermes-conversation-fence.ts`), which do nothing unless a `hermes_conversations` table exists
in the database. Where one exists, the fence reserves legacy names and UUIDs, rejects token-only access
to a conversation mailbox, appends a notice when mail is queued to a dormant mailbox, and exempts that
mailbox's unread mail from message GC. No new fence state is created.

### Environment configuration

| Variable | Default | Read at |
| --- | --- | --- |
| `AGENT_PEERS_PORT` | `7900` | broker module load (`parseInt`) |
| `AGENT_PEERS_DB` | `~/.agent-peers.db` | `startBrokerMain` |
| `AGENT_PEERS_SECRET_PATH` | `~/.agent-peers-secret` | `startBrokerMain` |
| `AGENT_PEERS_SPAWN_BROKER` | unset | `ensure-broker.ts`, `broker-client.ts` |
| `AGENT_PEERS_FEDERATION` | unset | `loadFederationConfig`; must be `1` to read `~/.agent-peers-host`, `~/.agent-peers-fleet.json` and `~/.agent-peers-federation-secret` |

If `AGENT_PEERS_FEDERATION=1` but the config or federation secret is missing or invalid, the broker
logs `federation config unusable, federation stays off` and serves local traffic normally. It does not
refuse to start.

### Timing and size constants

| Constant | Value | Effect |
| --- | --- | --- |
| `STALE_THRESHOLD_MS` | 60s | hidden from `list-peers`; not a valid sender; ephemeral GC cutoff |
| `STALE_RECLAIM_THRESHOLD_MS` | 60s | a row this old may be reclaimed by name+type |
| `LEASE_DURATION_MS` | 30s | poll lease lifetime |
| `POLL_HEARTBEAT_WRITE_MS` | 10s | a poll refreshes `last_seen` only when it is this old |
| `GC_INTERVAL_MS` | 30s | GC timer period |
| `DURABLE_RETENTION_MS` | 7 days | durable peer row (identity + mailbox) survives without heartbeat |
| `MAX_QUEUED_PER_DURABLE_PEER` | 500 | cap on unacked mail for a stale durable peer (also for a legacy conversation mailbox) |
| `MAX_POLL_BATCH` | 100 | most messages one poll leases |
| `MAX_ACK_TOKENS` | 1000 | most lease tokens one ack accepts |
| `MESSAGE_RETENTION_MS` | 7 days | acked message rows pruned after this |
| `UNACKED_RETENTION_MS` | 30 days | unacked message rows pruned after this (not chat mail; see GC) |
| `PROTECTION_LEASE_MS` | 15s | protection answer validity advertised to the reaper |

### `BROKER_EPOCH`

One UUID per broker process, surfaced on `/health`, `/ready`, `/register` and `/heartbeat`. It lets a
client seeing `known: false` distinguish "the broker restarted under me, just re-register" from "I was
evicted for cause". `PROTECTION_GENERATION` is the equivalent for the reaper.

### Durable vs ephemeral peers

| | Ephemeral (default) | Durable (`durable: true` + valid requested name) |
| --- | --- | --- |
| Hidden from discovery after | 60s | 60s (same) |
| Row deleted after | 60s | 7 days |
| Can receive mail while stale | no (`target peer stale`) | yes, up to 500 unacked |
| Keeps UUID + mailbox across restarts | no | yes, via the reclaim path |

Two-tier retention (`gcStalePeers`) fixes a concrete failure recorded in the code: a Hermes agent starts
its MCP servers per turn and stops heartbeating when it finishes replying, so with a single 60s
threshold governing both "hide" and "delete", a named agent was erased between turns and every message
to it failed with `unknown peer` (observed 2026-08-08 with `marco-hermes`). Worse, when
`STALE_RECLAIM_THRESHOLD_MS` equalled the delete cutoff, a row became reclaimable and deletable at the
same instant, so GC essentially always won, costing named agents their UUID and orphaning their mail.

### Name reclaim rules (summary)

1. Name must be valid (`^[a-zA-Z0-9_-]+$`, 1 to 96 chars, not a UUID).
2. Existing row must match **both** name and `peer_type`.
3. Existing row must be stale (`last_seen` older than 60s), **or** be on this host with a pid that is
   provably dead.
4. On success: UUID preserved, `session_token` rotated, stale leases cleared, `prev_id` mail re-pointed.
5. On failure: suffix ladder, a new UUID, and the ladder-assigned name is never durable.

Client-side, `pickAvailablePeerName` (`shared/names.ts`) pre-empts collisions with *live* peers by
appending a memorable animal word (`trophy-shopify-theme-codex-otter`) rather than a positional `-2`;
the broker's register-time ladder remains the final backstop for the check-versus-register race.

### GC and eviction

The GC timer fires every 30s and does four things: `gcStalePeers`, `gcOldMessages`, a chmod sweep of the
WAL/SHM sidecars, and a fail-closed permission re-verification that `process.exit(1)`s on drift.

`gcOldMessages` deletes acked rows older than 7 days and unacked rows older than 30 days, with two
exemptions for unacked mail: mail addressed to a legacy conversation mailbox, and **chat mail**
(`to_chat IS NOT NULL`), which never expires here because a Hermes owner's background loop reads only
its general mailbox, so mail for a chat nobody has opened exists only in this table.

**Suspend awareness**: `shouldSkipGcSweep(elapsed)` returns true when a tick observed more than
`3 x GC_INTERVAL_MS` of wall clock, the post-wake tick. That tick is granted as a grace sweep (logged,
no deletions) so clients' 15s heartbeats can land first. A monotonic clock would *not* fix this: the
elapsed gap is real; what is false is the inference of death.

---

## 4. Dependencies

- **Bun runtime**: `bun:sqlite` (`Database`), `Bun.serve`, `Bun.spawn` / `Bun.spawnSync`, `Bun.hash`.
  Shebang `#!/usr/bin/env bun`.
- **Node builtins**: `node:os` (`homedir`, `hostname`), `node:path`, `node:crypto` (`randomUUID`),
  `node:fs` (sync APIs for the secret file and permission enforcement), `node:url` (in
  `ensure-broker.ts`).
- **SQLite in WAL mode**, single writer process, plus read-only readers via `cli.ts`.
- **External binaries**: `ps -axo` (twice per protection request), `lsof -ti tcp:<port> -sTCP:LISTEN`
  with an `ss -Hltnp` fallback for the eviction target (Linux hosts without `lsof`), and `launchctl
  kickstart` / `systemctl --user start` (from `ensure-broker.ts`).
- **Hermes state databases** (read-only): `HermesChatDirectory` (`shared/hermes-chat-wake.ts`) is
  installed by `startBrokerMain` to resolve Hermes chat titles against each profile's `state.db`. Tests
  do not install it, to stay hermetic.
- **No third-party npm packages** in the broker path. (`@modelcontextprotocol/sdk` is used by the MCP
  servers, not the broker.)

---

## 5. Patterns

- **Fail-closed auth.** Missing or incorrect secret yields 401 before any handler runs. No readable
  secret client-side means not ready, with no `/health` fallback. Wrong file mode on the DB or the
  secret means refuse to start (or exit at runtime). An unverifiable `db_id` or `owner` on `/ready`
  means not ready.
- **Auth folded into the mutation.** Every mutating statement binds `session_token` directly in its
  WHERE clause (or, for ack, in a subquery), so the auth check and the mutation are one atomic
  statement. This closes the TOCTOU window where a reclaim rotating the token between check and
  mutation would let a stale session act as the reclaimed peer.
- **Lease + ack, at-least-once.** Poll leases for 30s; ack requires an unexpired lease; expired leases
  are silently re-offered and reported as `expired` so callers can expect the redelivery.
- **Epoch / generation restart detection.** `BROKER_EPOCH` and `PROTECTION_GENERATION` let peers and the
  reaper detect "the broker underneath me is a different process".
- **Suffix-laddered names.** Requested name, then `-2` to `-99`, then random `adj-noun`, then random
  with numeric suffix, with `NAME_MAX_LEN` respected at every step and durability granted only to the
  exact requested name.
- **Additive protocol changes.** New features ship as new optional fields, new routes that old clients
  never call, and `capabilities` tags on `/ready`. `protocol` stays 1. A client that lacks a capability
  keeps its old behavior (no `chat` on poll means general mail only).
- **Positive-signal-only external contract.** The protection endpoint may spare, never condemn; every
  failure mode degrades to "no protection asserted".
- **Suspend-aware inference.** Both the GC grace sweep and the removal of opportunistic GC from
  `list-peers` come from the same lesson: after sleep, "stale" does not mean "dead".
- **Explicit column projection.** `SELECT *` is banned on `peers`; `PEER_COLS` and the `list-peers` SQL
  whitelist safe columns so `session_token` cannot reach a client payload.
- **Comments as incident log.** Most non-obvious decisions carry the date and the concrete failure that
  produced them. This is load-bearing documentation; changes that ignore it tend to re-open a named
  production bug.

---

## 6. Entry Points

### Production: launchd (macOS) and systemd (Linux)

macOS, `~/Library/LaunchAgents/com.mike.agent-peers-broker.plist` (machine state, not tracked in this
repo; contents as read on the MacBook):

```
ProgramArguments: /Users/mike/.bun/bin/bun /Users/mike/agent-peers-mcp/broker.ts --owner=launchd
EnvironmentVariables: AGENT_PEERS_PORT=7900, AGENT_PEERS_DB=/Users/mike/.agent-peers.db,
                      AGENT_PEERS_FEDERATION=1
RunAtLoad: true, KeepAlive: true, ThrottleInterval: 5
Std{Out,Error}Path: /Users/mike/Library/Logs/agent-peers-broker.log
```

Linux, `deploy/linux/agent-peers-broker.service` (tracked): `ExecStart=%h/.bun/bin/bun
%h/agent-peers-mcp/broker.ts --owner=systemd`, `AGENT_PEERS_PORT=7900`,
`AGENT_PEERS_DB=%h/.agent-peers.db`, `AGENT_PEERS_FEDERATION=1`, `Restart=always`, `RestartSec=5`.
Install and update with `deploy/linux/install.sh`; see [linux-brokers.md](linux-brokers.md).

`import.meta.main` reads `--owner=launchd` or `--owner=systemd` from argv, defaulting to `"client"`, and
calls `startBrokerMain(owner)`. `isServiceOwner(owner)` is true for `launchd` and `systemd`, which are
treated identically.

### Ownership arbitration (`startBrokerMain`)

Up to 4 bind attempts (3 evictions plus a final bind):

- **`owner=client`**: any `EADDRINUSE` means somebody else already serves this machine. Log and
  `process.exit(0)`. Never crash-loop, never fight.
- **service owner (`launchd` or `systemd`)**: the service manager is the sole legitimate owner. Find the
  pid that *actually* holds the listening socket via `lsof -ti tcp:<port> -sTCP:LISTEN` (or `ss -Hltnp
  'sport = :<port>'` when `lsof` is missing), SIGTERM it (at most once per pid), poll up to 5s for its
  death, retry. Deliberately **not** the pid from the squatter's `/health`, which is unauthenticated
  and could name an arbitrary same-user victim. After 4 attempts: log FATAL and `process.exit(1)`.

This arbitration exists because a client-spawned broker inherited a client's env and lifetime, which is
how a Hermes gateway ended up owning port 7900 while the launchd service crash-looped 122 times on
EADDRINUSE.

### Dev / test spawn path

`AGENT_PEERS_SPAWN_BROKER=1` re-enables `ensureBroker`'s self-spawn: `Bun.spawn(["bun", <broker.ts>])`
with a pinned env and `proc.unref()`. That broker runs as `owner=client`, which `createReadinessProbe`
accepts only when the *client* is also in dev mode.

### Signals

`SIGINT`/`SIGTERM` clear the GC timer, `server.stop(true)`, stop the federation service, close the DB,
and exit 0. `SIGHUP` is **ignored**: auto-spawned brokers inherit the spawning session's controlling TTY
(Bun.spawn has no detach/setsid), and closing that terminal tab used to kill the broker for the whole
machine (observed 2026-07-06).

### CLI admin paths (`cli.ts`)

| Command | Path |
| --- | --- |
| `status`, `peers`, `wake-status` (alias `live`) | HTTP `/health`, `/list-peers` |
| `send` | HTTP `/register`, `/send-message`, `/unregister` (a throwaway `cli-operator-<pid>` peer) |
| `rename <target> <new>` | reads `session_token` from SQLite, then HTTP `/rename-peer` |
| `retire` / `unregister` | reads `session_token` from SQLite, then HTTP `/unregister`, plus wake-registry cleanup |
| `messages`, `orphaned-messages`, `stranded-messages`, `inboxes`, `gc-inboxes` | direct read-only SQLite (no HTTP endpoint exists) |
| `kill-broker` | `GET /health`, then SIGTERM the reported pid |
| `suggest-name <base>` | `/list-peers` with `local_only`, then `pickAvailablePeerName` |

The full CLI is in [cli-ops-tests.md](cli-ops-tests.md).

---

## Red Flags

Found by reading the code at `9be6159`; none were reproduced for this document.

**Migration correctness**

- `migrate_peers_add_session_token` runs `DELETE FROM peers` unconditionally when the column is absent.
  Intentional and documented, but it is an unrecoverable data-loss step gated only on a column's absence.
- `initDb()` (which runs migrations, chmods, and can rebuild the `peers` table) executes *before*
  `Bun.serve` binds, as does `startFederation`. A losing `owner=client` broker therefore mutates the live
  incumbent's database schema, and creates federation tables, before yielding with exit 0.
- `startBroker` starts the GC timer and the federation worker before `Bun.serve`, and nothing cleans
  them up when `Bun.serve` throws `EADDRINUSE`. A service-owner broker retries `startBroker` up to 4
  times in one process, so each failed attempt can leave another GC timer (and, with federation on,
  another worker) running. Harmless for the GC timer; the effect on the worker is unverified.

**Availability / crash-loop risk**

- A permission drift on `~/.agent-peers.db-wal` (for example any tool that chmods it) calls
  `process.exit(1)` from the 30s timer. With launchd `KeepAlive` and `ThrottleInterval: 5`, or systemd
  `Restart=always` and `RestartSec=5`, that is a 5-second restart loop with no backoff and no alerting
  beyond the log.
- `DEFAULT_PORT = parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10)` has no NaN guard. A non-numeric
  value yields `NaN`, which `Bun.serve` interprets as "pick a port", so the broker silently listens
  somewhere no client will look.
- Eviction only ever sends SIGTERM, never escalates. A squatter that ignores SIGTERM produces `FATAL:
  could not acquire port` and exit 1, then a service-manager restart: the crash loop the ownership work
  was written to eliminate.

**Input validation / resource limits**

- `/v1/protection/check` is unauthenticated and parses the request body with no size limit before
  slicing to 512 entries. An arbitrary local process can force unbounded JSON parsing.
- `readJson` has no schema validation on any endpoint. A malformed `RegisterRequest` (missing
  `peer_type`, wrong types) surfaces as a raw SQLite CHECK or binding error in a `500`. No endpoint ever
  returns `400`.
- The `MAX_QUEUED_PER_DURABLE_PEER` cap applies **only** when the target is stale (`p.last_seen >= ?`
  short-circuits the cap). A live peer that never acks has an unbounded mailbox.
- The protection throttle is a single global window, not per-caller. Any local process can exhaust it and
  deny the legitimate reaper an answer (fail-safe by contract, but a trivially available degradation).

**Silent-failure / API-shape inconsistencies**

- `unregisterPeer` returns `void` and the endpoint always answers `{ok:true}`, even when the token was
  wrong and nothing was deleted. This is the blind spot `heartbeatPeer` was changed to report via
  `known`; the fix was not applied here. Same for `setPeerSummary`.
- `RegisterResponse` and `HeartbeatResponse` in `shared/types.ts` do not declare the `epoch` field the
  broker returns. Type/implementation drift on a field clients are meant to key restart detection on.
- `ackMessages` returns `results: []` for an empty token array but `results: undefined` when everything
  acked. Two shapes for "nothing to report". An over-long token array returns a `500`, not a `400`.
- `pollMessages` returns `[]` for a wrong or rotated `session_token`, indistinguishable from an empty
  mailbox. Documented as deliberate, but a client whose session was silently rotated polls forever and
  sees nothing.

**Concurrency**

- The per-token diagnosis loop in `ackMessages` runs **outside** the transaction that performed the
  UPDATE, issuing fresh `SELECT`s. Concurrent activity between the two can produce a status that
  contradicts the reported `acked` count.
- `pollMessages` issues one `UPDATE` per message plus lookups per message (N+1) inside its transaction,
  now bounded by `MAX_POLL_BATCH`.

**Security notes (accepted or partially mitigated)**

- `repointOrphanedMail` moves unacked mail to a client-asserted `prev_id` with no proof of prior
  ownership. Documented as an accepted risk; it is the one place mail changes addressee without the
  addressee's token.
- `cli.ts kill-broker` SIGTERMs the pid returned by the **unauthenticated** `/health`. The broker's own
  eviction stopped trusting that value (a squatter could name an arbitrary same-user victim); the CLI
  still trusts it.
- `dbIdentityHash` hashes the resolved *path*, not the file's inode, contents, or any per-database
  identifier. `/ready`'s `db_id` therefore proves "we agree on a path string", not "we are serving the
  same database".

**Stale comments / dead code**

- The `PEER_COLS` comment says "authPeer() is the only code path that touches session_token", but
  `authPeer()` was removed.
- The `listPeers` comment still mentions "timer/opportunistic GC", though the opportunistic call was
  removed from that function.
- `STALE_THRESHOLD_MS` and `STALE_RECLAIM_THRESHOLD_MS` are two constants with the same value and no
  distinct tuning path, while the comments explain that their being equal was the cause of a production
  bug.
- The final rung of `nameCandidates` yields `${generateName()}-${i}`, calling `generateName()` afresh
  each iteration, so the numeric suffix ladders nothing; it is up to 998 random draws.
- `LIMIT ${limit}` is string-interpolated into the SQL in `listAllMessages`. It is guarded to a positive
  number and only reachable from `cli.ts`, but it is the one non-parameterized value in the file.
- `ensure-broker.ts`: `serviceStartCommand` falls back to uid 501 when `process.getuid` is missing, and
  `defaultKickstart` swallows every error and discards stdout/stderr, so a missing or unloaded service is
  invisible until the 15s poll deadline expires.
- In `ensureSharedSecret`, the `linked === true` branch falls through silently when the read-back does
  not equal what was written ("shouldn't happen with link"), with no log line for a condition that would
  indicate real filesystem trouble.
