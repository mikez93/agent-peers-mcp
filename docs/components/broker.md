# Broker Daemon

Truth-from-code documentation of the `agent-peers-mcp` broker, as of repo HEAD `63503f2`.

Primary source: `/Users/mike/agent-peers-mcp/broker.ts` (1552 lines).
Supporting: `shared/ensure-broker.ts`, `shared/shared-secret.ts`, `shared/types.ts`, `shared/broker-client.ts`, `shared/names.ts`.

---

## 1. Purpose

The broker is a single-machine, loopback-only HTTP daemon backed by SQLite that acts as the
registry and message queue for AI coding agents ("peers") sharing one Mac. It is the only
process that writes `~/.agent-peers.db`; every other component (the Claude MCP server, the
Codex/Hermes MCP server, `cli.ts`) talks to it over `http://127.0.0.1:7900`.

It solves four problems:

1. **Discovery** — an agent in one terminal has no way to know that another agent exists, what
   repo it is in, or what it is working on. The broker holds a registry of live peers with
   `cwd`, `git_root`, `tty`, `pid`, and a self-declared `summary`.
2. **Delivery** — agents are turn-based and often not executing when a message is sent. The
   broker holds messages in a durable mailbox with lease-and-ack semantics so a message
   survives the recipient being between turns.
3. **Identity stability** — a named agent (e.g. `ezra-hermes`) must keep the same UUID and
   mailbox across process restarts, sleep/wake, and MCP server teardown between turns.
4. **Liveness attestation for an external reaper** — an LLM agent waiting on a model response
   sits at ~0% CPU and is indistinguishable from a corpse by any CPU/idle heuristic. The broker
   exposes an authoritative "these pids are live agent work" endpoint that MacGuardian's process
   reaper consults before killing anything (`broker.ts:893-1093`).

Binding is hard-coded to `127.0.0.1` (`broker.ts:1375`); there is no network exposure.

---

## 2. Structure of `broker.ts`

| Section | Lines | Contents |
| --- | --- | --- |
| Constants | 20-58 | paths, thresholds, `SECRET_HEADER` |
| Schema + migrations | 60-372 | `initDb`, permission enforcement, five migrations |
| Peer CRUD | 374-552 | `registerPeer`, `heartbeatPeer`, `unregisterPeer`, `setPeerSummary`, getters |
| Listing | 554-607 | `listPeers` with scope filters |
| Send | 609-694 | `sendMessage` (single-transaction auth + resolve + insert) |
| Poll (lease) | 696-750 | `pollMessages` |
| Ack | 752-810 | `ackMessages` with typed per-token outcomes |
| Rename | 812-838 | `renamePeer` |
| GC | 840-891 | `gcStalePeers`, `gcOldMessages`, `shouldSkipGcSweep` |
| Protection check | 893-1093 | `ps` snapshots, `buildProtectedPidSet`, `checkProtection` |
| Orphans / inspection | 1095-1168 | `listOrphanedMessages`, `listAllMessages` (CLI-only, not HTTP) |
| HTTP | 1170-1475 | `ensureSharedSecret`, `startBroker`, route table, GC timer, signal handling |
| Ownership arbitration | 1477-1551 | `startBrokerMain`, `--owner=launchd` eviction loop, `import.meta.main` |

### Schema

Two tables, both created by `initDb` (`broker.ts:94-181`).

**`peers`** — `id` (UUID PK), `name` (UNIQUE), `peer_type` (CHECK in `claude|codex|hermes`),
`pid`, `cwd`, `git_root`, `tty`, `summary`, `session_token` (NOT NULL), `registered_at`,
`last_seen`, `durable` (INTEGER default 0), `host` (added by migration, nullable).
Indices on `last_seen` and `name`.

**`messages`** — `id` (INTEGER AUTOINCREMENT PK), `from_id`, `to_id`, `text`, `sent_at`,
`acked` (default 0), `lease_token`, `lease_expires_at`, `message_uid` (UUID, unique index).
Index on `(to_id, acked)`. There are no foreign keys, despite `PRAGMA foreign_keys = ON`
(`broker.ts:105`) — orphaned messages (rows whose `to_id` no longer exists) are an expected
state, surfaced by `cli.ts orphaned-messages`.

### Migrations

Run in a fixed order from `initDb` (`broker.ts:154-164`), each wrapped in `BEGIN IMMEDIATE` so
concurrent broker startups serialize:

1. `migrate_peers_add_session_token` (194) — adds the column, **deletes every pre-upgrade peer
   row** (they cannot authenticate under the new scheme), self-heals NULL tokens with fresh
   UUIDs, and rebuilds the table if `session_token` is still nullable.
2. `migrate_peers_add_hermes_peer_type` (357) — detects a missing `'hermes'` in the stored
   CHECK constraint via `sqlite_master` and rebuilds the table to widen it.
3. `migrate_peers_add_durable` (339) — `ALTER TABLE ADD COLUMN durable INTEGER NOT NULL DEFAULT 0`.
4. `migrate_messages_add_message_uid` (309) — adds `message_uid`, backfills UUIDs on existing
   rows, creates the unique index. Groundwork for cross-machine federation where the local
   AUTOINCREMENT integer would collide across brokers.
5. `migrate_peers_add_host` (291) — adds `host TEXT`, filled with `os.hostname()` on new
   registrations. Schema-only; no routing code reads it yet.

Both rebuild-capable migrations (1 and 2) share `rebuildPeersTableWithNotNullSessionToken`
(257), a shadow-table copy whose column list is written out literally and **omits `durable` and
`host`** — see Red Flags.

### File-permission trust boundary

The DB file's POSIX mode is the operator trust boundary (`cli.ts rename`, `messages`,
`orphaned-messages` all read SQLite directly rather than going through HTTP). Enforcement is
layered:

- `process.umask(0o077)` before `new Database()` (`broker.ts:101`), so SQLite-created WAL/SHM
  sidecars start at 0600.
- `chmodIfExists` on `db`, `db-wal`, `db-shm` before and after migrations (111-113, 170-172),
  and again on every 30s GC tick (1360-1361).
- `enforceDbFilePerms` (72-92) re-stats each file and **throws/exits** if it is not a regular
  file, not owned by the current uid, or not mode 0600. Called at startup (178) and on every GC
  tick, where a failure calls `process.exit(1)` (1369).

### Relationship to `shared/ensure-broker.ts` and `shared/shared-secret.ts`

- **`ensure-broker.ts`** is the client-side "make sure the broker exists" helper. In production
  it does **not** spawn the broker: it runs `launchctl kickstart gui/<uid>/com.mike.agent-peers-broker`
  (a no-op if already running) and then polls a readiness callback for up to 15s. The legacy
  self-spawn path survives only behind `AGENT_PEERS_SPAWN_BROKER=1`, and pins the child env to
  `PATH`, `HOME`, and the three `AGENT_PEERS_*` machine-config vars, so a session's `PEER_NAME`
  or `cwd` cannot leak into a machine-global daemon.
- **`shared-secret.ts`** is the client-side reader/validator of `~/.agent-peers-secret`.
  `validateSecretFilePerms` (28) rejects symlinks, non-regular files, foreign owners, and any
  mode other than 0600. The broker imports this exact function so both sides apply identical
  checks (`broker.ts:11`, used at `1209` and `1289`). `waitForSharedSecret` polls for up to 6s
  after a broker start, since the file is provisioned by the broker.
- **`ensureSharedSecret`** (`broker.ts:1190-1295`) is the broker-side provisioner: reuse an
  existing valid file (>= 32 chars), else write to `<path>.tmp.<pid>.<ts>`, fsync, chmod 0600,
  and publish via `linkSync` (which fails with EEXIST if another broker won the race). On
  filesystems without hard links it falls back to `renameSync`. A short/empty existing file is a
  hard error with recovery instructions rather than an auto-repair, because auto-repair would
  race concurrent brokers.

---

## 3. Public Interfaces

Base URL `http://127.0.0.1:${AGENT_PEERS_PORT ?? 7900}`. Route table at `broker.ts:1376-1455`.

Every route except `GET /health` and `POST /v1/protection/check` requires the header
`X-Agent-Peers-Secret` matching the contents of `~/.agent-peers-secret`; a mismatch returns
`401 {"error":"missing or invalid x-agent-peers-secret"}` (`broker.ts:1424-1427`). Any
non-POST method that is not `/health` or `/ready` returns `405` (1401). Unknown POST paths
return `404` (1449). Any thrown error is caught and returned as `500 {"error": message}` (1451).

### `GET /health` — unauthenticated

```json
{ "ok": true, "pid": 1234, "epoch": "<uuid>", "owner": "launchd" | "client" }
```

Liveness only. Deliberately unauthenticated so diagnostics and the eviction path can identify
the responder. Used by `createClient().isAlive()` (`broker-client.ts:115`) and by
`cli.ts kill-broker`.

### `GET /ready` — authenticated

```json
{ "ok": true, "pid": 1234, "epoch": "<uuid>", "owner": "launchd", "protocol": 1, "db_id": "<12 hex>" }
```

This is the real readiness contract. `createReadinessProbe` (`broker-client.ts:56-94`) treats a
broker as ready only when **all** of these hold:

- a shared secret is readable (no secret → not ready; there is deliberately **no** fallback to
  `/health`, because a squatter with a `/health` endpoint could otherwise satisfy clients
  forever during first boot);
- HTTP 200 (401 = wrong secret, 404 = pre-`/ready` build; both are "not the broker we require");
- `ok === true` **and** `protocol === 1`;
- `owner === "launchd"`, or exactly `owner === "client"` when this client process itself has
  `AGENT_PEERS_SPAWN_BROKER=1`;
- `db_id` is a string equal to `expectedDbIdentityHash(expectedDbPath)`.

`db_id` is `Bun.hash(resolve(dbPath)).toString(16).slice(0,12)` — computed identically on both
sides (`broker.ts:1325-1327`, `broker-client.ts:34-36`). It identifies the DB **path**, not its
contents.

### `POST /v1/protection/check` — unauthenticated, throttled

Request: either `ProtectionQueryEntry[]` or `{ entries: ProtectionQueryEntry[] }`, where an
entry is `{ pid: number, start_time?: string | null }`. Entries beyond 512 are dropped.

Response (`checkProtection`, `broker.ts:1055-1093`):

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

Contract (documented at `broker.ts:893-905`): **positive signal only**. The answer may spare a
process; it may never condemn one. A pid's absence is not evidence of death — the reaper falls
back to its own weaker tests, and treats any non-200 (including the `429` throttle) as "broker
unusable, reap nothing in broker-dependent classes". `generation` lets the reaper detect a
broker restart between classify time and signal time.

The protected set (`buildProtectedPidSet`, 1011-1053) unions two anchor sources: pids from the
`peers` table that are still alive, and any live process whose command matches
`agent-peers-mcp/(claude|codex|hermes)-server\.ts`. Source 2 exists because source 1 expires
after 60s of no heartbeat. From each anchor it protects the anchor, its parent (the agent host),
and — only for **non-GUI** hosts — the host's entire child subtree. GUI hosts (`.app/Contents/MacOS/`)
are not expanded because ChatGPT.app parents ~200 MCP servers and the reaper's own `.app`-ancestor
test already covers them. The broker's own pid is protected (it is PPID=1 as a LaunchAgent, which
previously made the reaper SIGKILL it every 30 minutes). If `ps` inspection fails, the set is
empty — "we vouch for nothing", never "everything is dead".

`start_time` is an identity fence against pid reuse: `canonicalStartTime` collapses whitespace
runs (macOS pads single-digit days) and a mismatch returns `identity_mismatch`, not protection.

Throttle: a global sliding window of 4 requests per 10s (`broker.ts:1310-1321`), ~10× the
reaper's real cadence.

Why unauthenticated (1403-1411): the reaper is a separate codebase; requiring the secret would
widen its trust boundary for no gain, since the endpoint only reveals which pids are agent
sessions (derivable from `ps`) and cannot launder protection onto a hostile process — getting
into the registry requires the secret.

### `POST /register`

Request `RegisterRequest` (`types.ts:36-55`): `peer_type`, optional `name`, `pid`, `cwd`,
`git_root`, `tty`, `summary`, optional `durable`, optional `prev_id`.
Response: `RegisterResponse` (`id`, `name`, `session_token`) plus `epoch`.

Semantics (`registerPeer` / `registerPeerInner`, `broker.ts:391-472`), all in one transaction:

- A fresh `session_token` UUID is minted on **every** register, including reclaims. The token is
  the session boundary: after a reclaim, the previous incarnation's client can no longer act as
  this peer.
- **Durability is explicit**: `durable = req.durable === true && req.name && isValidName(req.name)`.
  Merely asking for a name no longer reserves it — that older rule let throwaway `hermes mcp test`
  spawns squat names for 7 days.
- **Reclaim fast path**: if `name` matches an existing row **and `peer_type` matches** and that
  row's `last_seen` is older than `STALE_RECLAIM_THRESHOLD_MS` (60s), the row is UPDATEd in
  place, preserving the UUID and therefore the mailbox. The type guard stops a `claude` process
  from inheriting `ezra-hermes`'s UUID and queued mail just by asking for the name. On reclaim,
  all stale leases on that peer's unacked messages are cleared so the new session's first poll
  returns the backlog immediately (437-440).
- **Suffix ladder** otherwise (`nameCandidates`, 376-389): `name`, `name-2` … `name-99` (each
  capped at `NAME_MAX_LEN` = 32), then 100 random `adjective-noun` names, then 998 more random
  names with numeric suffixes. Only the peer's *own* requested name gets `durable`; a
  ladder-assigned fallback is always ephemeral (462), because nobody addresses that name.
  Exhausting the ladder throws (471).
- **`prev_id` mailbox migration** (`repointOrphanedMail`, 487-498): if the client's previous row
  is **gone**, its unacked messages are re-pointed to the new id and their leases cleared. Guard:
  never when the previous row still exists, never self-referential. The docstring records an
  **accepted risk** — `prev_id` is client-asserted with no proof of prior ownership, so any
  authenticated peer could claim a dead UUID's mail; accepted because all clients share one
  single-user trust boundary. This path exists because 5,202 messages had accumulated as
  permanently unreachable orphans.

### `POST /heartbeat`

Request `{ id, session_token }`. Response `{ ok: true, known: boolean, epoch }`.

`heartbeatPeer` (520-524) is a single `UPDATE peers SET last_seen WHERE id = ? AND session_token = ?`;
`known` is the row count > 0. It exists because an UPDATE matching zero rows is not a SQL error:
after a long broker outage every peer is GC'd, and clients would otherwise heartbeat into
deleted rows forever while invisible to the network. `HeartbeatResponse.known` is optional in
the type on purpose — a broker predating the field omits it, and only an explicit `false` may
trigger re-registration.

### `POST /unregister`

Request `{ id, session_token }`. Response `{ ok: true }` unconditionally. Deletes the peer row;
its messages deliberately remain as orphans (spec §5.1).

### `POST /set-summary`

Request `{ id, session_token, summary }`. Response `{ ok: true }` unconditionally. Also bumps
`last_seen`.

### `POST /list-peers`

Request `ListPeersRequest`: `scope` (`"machine" | "directory" | "repo"`), `cwd`, `git_root`,
optional `exclude_id`, optional `peer_type`. Response: `Peer[]`, ordered `last_seen DESC`.

- Always filters `last_seen >= now - STALE_THRESHOLD_MS` (60s), so a closed tab disappears from
  discovery even before GC deletes the row.
- `scope: "directory"` adds `cwd = ?`; `scope: "repo"` adds `git_root = ?`, falling back to
  `cwd = ?` when the caller has no git root; `scope: "machine"` adds nothing.
- **No GC runs here.** The opportunistic `gcStalePeers()` call was removed on 2026-08-10: after
  a laptop wake, the first `list_peers` raced ahead of every frozen client's first heartbeat and
  purged the registry (77 → 9 peers, observed 2026-07-14).
- Column projection is explicit and excludes `session_token` (597-605). A prior `SELECT *`
  leaked tokens into the discovery response, which collapsed the entire auth model.

### `POST /send-message`

Request `SendMessageRequest`: `from_id`, `session_token`, `to_id_or_name`, `text`.
Response `SendMessageResponse`: `{ ok: true, message_id }` or `{ ok: false, error }`.

One transaction (`broker.ts:622-694`):

1. Sender auth: the sender row must match `id` + `session_token` **and** be live. Errors
   distinguish `unauthorized sender: <id>` from `sender stale: <name>`.
2. Target resolution, deliverability, and INSERT are a **single** `INSERT … SELECT … RETURNING`
   statement, so nothing can unregister between check and write. A target is deliverable if it
   is live **or** durable. Durable delivery is what makes "your colleague is idle" stop reading
   as "your colleague does not exist" for a Hermes agent between turns.
3. A **stale durable** target additionally requires fewer than `MAX_QUEUED_PER_DURABLE_PEER`
   (500) unacked messages; a live target bypasses the cap entirely.
4. On no insert, three distinguishable errors: `unknown peer: <x>`, `target peer mailbox full:
   <name> (<n> undelivered; it has not polled since <ts>)`, `target peer stale: <name>`.

### `POST /poll-messages`

Request `{ id, session_token }`. Response `{ messages: LeasedMessage[] }`.

`pollMessages` (698-750), one transaction:

1. The heartbeat UPDATE doubles as atomic auth: `UPDATE peers SET last_seen WHERE id AND
   session_token`. Zero rows → return `[]`. A bad token is therefore indistinguishable from an
   empty mailbox, which is deliberate (it exposes nobody's mailbox).
2. Selects all rows `to_id = ? AND acked = 0` whose lease is null or expired, ordered `id ASC`
   (FIFO). No limit.
3. Each row gets a fresh `lease_token` UUID and `lease_expires_at = now + LEASE_DURATION_MS`
   (**30 seconds**, `broker.ts:25`).
4. Each `LeasedMessage` is enriched with sender context looked up live: `from_name`,
   `from_peer_type`, `from_cwd`, `from_summary`. A deleted sender yields `from_name: "(gone)"`
   and `from_peer_type: "claude"` as defaults.

Delivery is **at-least-once**: a message whose lease expires before an ack arrives is re-offered
on the next poll.

### `POST /ack-messages`

Request `AckMessagesRequest`: `{ id, session_token, lease_tokens: string[] }`.
Response `AckMessagesResponse`: `{ ok: true, acked: number, stale?: number, results?: [...] }`.

`ackMessages` (754-810). Empty token array short-circuits to `{ ok: true, acked: 0, stale: 0,
results: [] }`. Otherwise, in one transaction: snapshot which submitted tokens currently exist,
then `UPDATE messages SET acked = 1, lease_token = NULL, lease_expires_at = NULL` where the
token matches **and** `to_id` belongs to a peer row with the caller's `session_token` **and**
`acked = 0` **and** the lease has not expired. Auth is a subquery inside the UPDATE, so there is
no TOCTOU window across a reclaim rotation.

When `acked < lease_tokens.length`, per-token outcomes are returned (`AckTokenStatus`,
`types.ts:108`):

| status | meaning |
| --- | --- |
| `acked` | this call acked it (or it was already acked) |
| `expired` | the lease outlived the caller's tool cycle; the broker **will re-offer** the message — the caller must not treat it as delivered |
| `wrong_session` | the message is not addressed to the calling peer's current session |
| `unknown` | the token was never issued, or none of the above applies |

`stale` is the count of `expired`. This exists to kill the success-shaped `{ok:true, acked:0}`
blind spot.

### `POST /rename-peer`

Request `{ id, session_token, new_name }`. Response `{ ok: true, name }` or `{ ok: false, error }`.

Validates the name (`isValidName`: 1-32 chars, `^[a-zA-Z0-9_-]+$`), then an atomic
auth-and-rename UPDATE with `session_token` in the WHERE. Zero changes → `unauthorized rename`
for both "unknown id" and "wrong token" (no auth-vs-enumeration leak). A UNIQUE violation →
`name taken`.

There is **no** broker-side admin rename and no `/admin/rename-peer` HTTP endpoint — an earlier
version had one and any local process could hijack any peer's identity. `cli.ts rename`
(`cli.ts:176-197`) instead reads the target's `session_token` straight out of the SQLite file
and calls the normal session-authenticated endpoint. Likewise there are no `/orphaned-messages`
or `/all-messages` HTTP endpoints (`broker.ts:1442-1448`); the CLI opens SQLite read-only.

### Environment configuration

| Variable | Default | Read at |
| --- | --- | --- |
| `AGENT_PEERS_PORT` | `7900` | `broker.ts:22` (module load, `parseInt`) |
| `AGENT_PEERS_DB` | `~/.agent-peers.db` | `broker.ts:1493` |
| `AGENT_PEERS_SECRET_PATH` | `~/.agent-peers-secret` | `broker.ts:1494` |
| `AGENT_PEERS_SPAWN_BROKER` | unset | `ensure-broker.ts:57`, `broker-client.ts:82` |

### Timing constants (`broker.ts:23-51`)

| Constant | Value | Effect |
| --- | --- | --- |
| `STALE_THRESHOLD_MS` | 60s | hidden from `list-peers`; not a valid sender; ephemeral GC cutoff |
| `STALE_RECLAIM_THRESHOLD_MS` | 60s | a row this old may be reclaimed by name+type |
| `LEASE_DURATION_MS` | 30s | poll lease lifetime |
| `GC_INTERVAL_MS` | 30s | GC timer period |
| `DURABLE_RETENTION_MS` | 7 days | durable peer row (identity + mailbox) survives without heartbeat |
| `MAX_QUEUED_PER_DURABLE_PEER` | 500 | cap on unacked mail for a stale durable peer |
| `MESSAGE_RETENTION_MS` | 7 days | acked message rows pruned after this |
| `UNACKED_RETENTION_MS` | 30 days | unacked message rows pruned after this |
| `PROTECTION_LEASE_MS` | 15s | protection answer validity advertised to the reaper |

### `BROKER_EPOCH`

One UUID per broker process (`broker.ts:1301`), surfaced on `/health`, `/ready`, `/register`,
and `/heartbeat`. It lets a client seeing `known: false` distinguish "the broker restarted under
me, just re-register" from "I was evicted for cause". `PROTECTION_GENERATION` (906) is the
equivalent for the reaper.

### Durable vs ephemeral peers

| | Ephemeral (default) | Durable (`durable: true` + valid requested name) |
| --- | --- | --- |
| Hidden from discovery after | 60s | 60s (same) |
| Row deleted after | 60s | 7 days |
| Can receive mail while stale | no (`target peer stale`) | yes, up to 500 unacked |
| Keeps UUID + mailbox across restarts | no | yes, via the reclaim path |

The two-tier retention (`gcStalePeers`, 842-861) is the fix for the concrete failure recorded in
the code: a Hermes agent starts its MCP servers per turn and stops heartbeating the moment it
finishes replying, so with a single 60s threshold governing both "hide" and "delete", a named
agent was erased from the registry between turns and every message to it failed with `unknown
peer` (observed 2026-08-08 with `marco-hermes`). Worse, when `STALE_RECLAIM_THRESHOLD_MS`
equalled the delete cutoff, a row became reclaimable and deletable at the same instant, so GC
essentially always won and the reclaim path was unreachable — costing named agents their UUID,
orphaning their mail, and letting them collide with their own uncollected ghost (`ezra-hermes-2`).

### Name reclaim rules (summary)

1. Name must be valid (`^[a-zA-Z0-9_-]+$`, 1-32 chars).
2. Existing row must match **both** name and `peer_type`.
3. Existing row must be stale (`last_seen < now - 60s`).
4. On success: UUID preserved, `session_token` rotated, stale leases cleared, `prev_id` mail
   re-pointed.
5. On failure: suffix ladder → a new UUID, and the ladder-assigned name is never durable.

Client-side, `pickAvailablePeerName` (`shared/names.ts:58-75`) pre-empts collisions with *live*
peers by appending a memorable animal word (`trophy-shopify-theme-codex-otter`) rather than a
positional `-2`; the broker's register-time ladder remains the final backstop for the
check-vs-register race.

### GC and eviction

The GC timer (`broker.ts:1345-1371`) fires every 30s and does four things: `gcStalePeers`,
`gcOldMessages`, a chmod sweep of the WAL/SHM sidecars, and a fail-closed permission
re-verification that `process.exit(1)`s on drift.

**Suspend awareness**: `shouldSkipGcSweep(elapsed)` returns true when a tick observed more than
`3 × GC_INTERVAL_MS` of wall clock — the post-wake tick. That tick is granted as a grace sweep
(logged, no deletions) so clients' 15s heartbeats can land first. The code notes explicitly that
a monotonic clock would *not* fix this: the elapsed gap is real; what is false is the inference
of death.

---

## 4. Dependencies

- **Bun runtime**: `bun:sqlite` (`Database`), `Bun.serve`, `Bun.spawn` / `Bun.spawnSync`,
  `Bun.hash`. Shebang `#!/usr/bin/env bun`.
- **Node builtins**: `node:os` (`homedir`, `hostname`), `node:path` (`resolve`), `node:crypto`
  (`randomUUID`), `node:fs` (sync APIs for the secret file and permission enforcement),
  `node:url` (`fileURLToPath`, in `ensure-broker.ts`).
- **SQLite in WAL mode**, single writer process, plus read-only readers via `cli.ts`.
- **External binaries**: `ps -axo` (twice per protection request), `lsof -ti tcp:<port>
  -sTCP:LISTEN` (eviction target), `launchctl kickstart` (from `ensure-broker.ts`).
- **No third-party npm packages** in the broker path.

---

## 5. Patterns

- **Fail-closed auth.** Missing/incorrect secret → 401 before any handler runs. No readable
  secret client-side → not ready, with no `/health` fallback. Wrong file mode on the DB or the
  secret → refuse to start (or exit at runtime). An unverifiable `db_id` or `owner` on `/ready`
  → not ready.
- **Auth folded into the mutation.** `authPeer()` was deliberately removed (`broker.ts:500-510`);
  every mutating statement binds `session_token` directly in its WHERE clause (or, for ack, in a
  subquery), so the auth check and the mutation are one atomic statement. This closes the TOCTOU
  window where a reclaim rotating the token between check and mutation would let a stale session
  act as the reclaimed peer.
- **Lease + ack, at-least-once.** Poll leases for 30s; ack requires an unexpired lease; expired
  leases are silently re-offered and reported as `expired` so callers can expect the redelivery.
- **Epoch / generation restart detection.** `BROKER_EPOCH` and `PROTECTION_GENERATION` let peers
  and the reaper detect "the broker underneath me is a different process" instead of
  misattributing the consequences.
- **Suffix-laddered names.** Requested name → `-2`…`-99` → random `adj-noun` → random with
  numeric suffix, with `NAME_MAX_LEN` respected at every step and durability granted only to the
  exact requested name.
- **Positive-signal-only external contract.** The protection endpoint may spare, never condemn;
  every failure mode (throttle, `ps` failure, unknown pid) degrades to "no protection asserted",
  and the caller's own contract turns that into "reap nothing".
- **Suspend-aware inference.** Both the GC grace sweep and the removal of opportunistic GC from
  `list-peers` come from the same lesson: after sleep, "stale" does not mean "dead".
- **Explicit column projection.** `SELECT *` is banned on `peers`; `PEER_COLS` and the
  `list-peers` SQL whitelist safe columns so `session_token` cannot reach a client payload.
- **Comments as incident log.** Most non-obvious decisions carry the date and the concrete
  failure that produced them. This is load-bearing documentation; changes that ignore it tend to
  re-open a named production bug.

---

## 6. Entry Points

### Production: launchd

`~/Library/LaunchAgents/com.mike.agent-peers-broker.plist`:

```
ProgramArguments: /Users/mike/.bun/bin/bun /Users/mike/agent-peers-mcp/broker.ts --owner=launchd
EnvironmentVariables: AGENT_PEERS_PORT=7900, AGENT_PEERS_DB=/Users/mike/.agent-peers.db
RunAtLoad: true, KeepAlive: true, ThrottleInterval: 5
Std{Out,Error}Path: /Users/mike/Library/Logs/agent-peers-broker.log
```

`import.meta.main` (`broker.ts:1548-1551`) reads `--owner=launchd` from argv, defaulting to
`"client"`, and calls `startBrokerMain(owner)`.

### Ownership arbitration (`startBrokerMain`, `broker.ts:1491-1543`)

Up to 4 bind attempts (3 evictions plus a final bind):

- **`owner=client`** — any `EADDRINUSE` means somebody else already serves this machine. Log and
  `process.exit(0)`. Never crash-loop, never fight.
- **`owner=launchd`** — launchd is the sole legitimate owner. Find the pid that *actually* holds
  the listening socket via `lsof -ti tcp:<port> -sTCP:LISTEN`, SIGTERM it (at most once per pid,
  tracked in `alreadySignaled`), poll up to 5s for its death, retry. Deliberately **not** the pid
  from the squatter's `/health`, which is unauthenticated and could name an arbitrary same-user
  victim (2026-08-10 review, high #4). After 4 attempts: log FATAL and `process.exit(1)`.

This arbitration exists because a client-spawned broker inherited a client's env and lifetime,
which is how a Hermes gateway ended up owning port 7900 while the launchd service crash-looped
122× on EADDRINUSE (`ensure-broker.ts:6-12`).

### Dev / test spawn path

`AGENT_PEERS_SPAWN_BROKER=1` re-enables `ensureBroker`'s self-spawn: `Bun.spawn(["bun",
<broker.ts>])` with a pinned env and `proc.unref()`. That broker runs as `owner=client`, which
`createReadinessProbe` accepts only when the *client* is also in dev mode.

### Signals

`SIGINT`/`SIGTERM` → clear the GC timer, `server.stop(true)`, `db.close()`, exit 0.
`SIGHUP` → **ignored** (`broker.ts:1471`): auto-spawned brokers inherit the spawning session's
controlling TTY (Bun.spawn has no detach/setsid), and closing that terminal tab used to kill the
broker for the whole machine (observed 2026-07-06).

### CLI admin paths (`cli.ts`)

| Command | Path |
| --- | --- |
| `status`, `peers`, `live` | HTTP `/health`, `/list-peers` |
| `send` | HTTP `/send-message` |
| `rename <target> <new>` | reads `session_token` from SQLite, then HTTP `/rename-peer` |
| `retire` / `unregister` | reads `session_token` from SQLite, then HTTP `/unregister`, plus wake-registry cleanup |
| `messages`, `orphaned-messages`, `stranded-messages`, `inboxes`, `gc-inboxes` | direct read-only SQLite (no HTTP endpoint exists) |
| `kill-broker` | `GET /health`, then SIGTERM the reported pid |
| `suggest-name <base>` | `/list-peers`, then `pickAvailablePeerName` |

---

## Red Flags

**Migration correctness**

- `broker.ts:263-285` — `rebuildPeersTableWithNotNullSessionToken` writes its column list
  literally and omits both `durable` and `host`. Any future or repeated invocation silently
  drops them; durable named agents would be re-created as ephemeral (60s deletion instead of 7
  days) and lose their identity/mailbox retention.
- `broker.ts:156-162` — the "MUST stay last among the peers migrations" comment is now false:
  `migrate_peers_add_host` was added at line 164, i.e. *after* `migrate_peers_add_durable`. The
  invariant survives by luck of ordering, and the comment no longer describes the code.
- `broker.ts:212` — the session_token migration `DELETE FROM peers` unconditionally drops every
  pre-upgrade peer row. Intentional and documented, but it is an unrecoverable data-loss step
  gated only on a column's absence.
- `broker.ts:1335` + `1515` — `initDb()` (which runs migrations, chmods, and can rebuild the
  `peers` table) executes *before* `Bun.serve` binds. A losing `owner=client` broker therefore
  mutates the live incumbent's database schema before yielding with exit 0.

**Availability / crash-loop risk**

- `broker.ts:1365-1370` — a permission drift on `~/.agent-peers.db-wal` (e.g. any tool that
  chmods it) calls `process.exit(1)` from a 30s timer. With launchd `KeepAlive: true` and
  `ThrottleInterval: 5`, that is a 5-second restart loop with no backoff and no alerting beyond
  the log file.
- `broker.ts:22` — `parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10)` has no NaN guard. A
  non-numeric value yields `NaN`, which `Bun.serve` interprets as "pick a port", so the broker
  silently listens somewhere no client will look.
- `broker.ts:1533-1541` — eviction only ever sends SIGTERM, never escalates. A squatter that
  ignores SIGTERM produces `FATAL: could not acquire port` → exit 1 → launchd restart → the same
  crash loop the ownership work was written to eliminate.

**Input validation / resource limits**

- `broker.ts:1412-1420` — `/v1/protection/check` is unauthenticated and parses the request body
  with no size limit before slicing to 512 entries. An arbitrary local process can force
  unbounded JSON parsing.
- `broker.ts:1418`, `1433-1441` — `readJson` has no schema validation on any endpoint. A
  malformed `RegisterRequest` (missing `peer_type`, wrong types) surfaces as a raw SQLite CHECK
  or binding error in a `500`. No endpoint ever returns `400`.
- `broker.ts:760, 774, 777` — `ackMessages` builds `IN (…)` with one placeholder per submitted
  token and never caps the array. More than SQLite's variable limit (999) turns a client bug
  into a 500.
- `broker.ts:716-725` — `pollMessages` has no `LIMIT`. A durable peer holding 500 queued
  messages receives and leases all 500 in one response.
- `broker.ts:662-667` — the `MAX_QUEUED_PER_DURABLE_PEER` cap applies **only** when the target is
  stale (`p.last_seen >= ?` short-circuits the cap). A live peer that never acks has an unbounded
  mailbox.
- `broker.ts:1310-1321` — the protection throttle is a single global window, not per-caller. Any
  local process can exhaust it and deny the legitimate reaper an answer (fail-safe by contract,
  but a trivially available degradation).

**Silent-failure / API-shape inconsistencies**

- `broker.ts:526-530` + `1435` — `unregisterPeer` returns `void` and the endpoint always answers
  `{ok:true}`, even when the token was wrong and nothing was deleted. This is the exact blind
  spot that `heartbeatPeer` was changed to report via `known` (512-524); the fix was not applied
  here.
- `broker.ts:532-535` + `1436` — same for `setPeerSummary`: unconditional `{ok:true}` regardless
  of whether the row matched.
- `types.ts:57-69` — `RegisterResponse` and `HeartbeatResponse` do not declare the `epoch` field
  that `broker.ts:1433-1434` actually returns. Type/implementation drift on a field clients are
  meant to key restart detection on.
- `broker.ts:755` vs `788-809` — `ackMessages` returns `results: []` for an empty token array but
  `results: undefined` when everything acked. Two different shapes for "nothing to report".
- `broker.ts:706-714` — `pollMessages` returns `[]` for a wrong/rotated `session_token`,
  indistinguishable from an empty mailbox. Documented as deliberate, but it means a client whose
  session was silently rotated polls forever and sees nothing.

**Concurrency**

- `broker.ts:789-808` — the per-token diagnosis loop in `ackMessages` runs **outside** the
  transaction that performed the UPDATE, issuing fresh `SELECT`s. Concurrent activity between
  the two can produce a status that contradicts the reported `acked` count.
- `broker.ts:728-732` — `pollMessages` issues one `UPDATE` per message plus one `getPeer` per
  message (N+1 twice over) inside its transaction.

**Security notes (accepted or partially mitigated)**

- `broker.ts:474-498` — `repointOrphanedMail` moves unacked mail to a client-asserted `prev_id`
  with no proof of prior ownership. Documented as an accepted risk; it is the one place mail
  changes addressee without the addressee's token.
- `cli.ts:499-520` — `kill-broker` SIGTERMs the pid returned by the **unauthenticated**
  `/health`. `broker.ts:1495-1499` explicitly stopped trusting that value for eviction (a
  squatter could name an arbitrary same-user victim); the CLI still trusts it.
- `broker.ts:1325-1327` — `dbIdentityHash` hashes the resolved *path*, not the file's inode,
  contents, or any per-database identifier. `/ready`'s `db_id` therefore proves "we agree on a
  path string", not "we are serving the same database".

**Stale comments / dead code**

- `broker.ts:537-540` — the `PEER_COLS` comment says "authPeer() is the only code path that
  touches session_token", but `authPeer()` was removed (see the note at line 500).
- `broker.ts:568-571` — the `listPeers` comment still describes "timer/opportunistic GC", though
  the opportunistic call was removed directly above at 556-563.
- `broker.ts:23-24` — `STALE_THRESHOLD_MS` and `STALE_RECLAIM_THRESHOLD_MS` are two constants
  with the same value and no distinct tuning path, while `broker.ts:34-39` explains that their
  being equal was the cause of a production bug.
- `broker.ts:385-388` — the final rung of `nameCandidates` yields `${generateName()}-${i}`,
  calling `generateName()` afresh each iteration, so the numeric suffix ladders nothing; it is
  1,000 random draws in a trench coat.
- `broker.ts:1165` — `LIMIT ${limit}` is string-interpolated into the SQL in `listAllMessages`.
  It is guarded to a positive number and only reachable from `cli.ts`, but it is the one
  non-parameterized value in the file.
- `ensure-broker.ts:36` — `process.getuid?.() ?? 501` hardcodes uid 501 as a fallback for the
  `launchctl kickstart gui/<uid>/` target.
- `ensure-broker.ts:34-46` — `defaultKickstart` swallows every error and discards stdout/stderr,
  so a missing/unloaded LaunchAgent is invisible until the 15s poll deadline expires.
- `broker.ts:1281-1286` — in `ensureSharedSecret`, the `linked === true` branch falls through
  silently when the read-back does not equal what was written ("shouldn't happen with link"),
  with no log line for a condition that would indicate real filesystem trouble.
