# Hermes per-conversation T1 integration

Tracking: `bd-1con`. Design approved by Marco on 2026-09-08:
`agentic-coding-resources/.specs/2026-09-08-hermes-conversation-peers-design.md`.

## Current implementation boundary

**Opt-in source, not deployed by this change.** `hermes-server.ts` uses the legacy
adapter unless `AGENT_PEERS_HERMES_V2=1`. T1 bootstrap uses the first strict host
metadata call for identity, with lease-only cleanup until T2. Normal startup does
not install conversation tables. No HTTP endpoint accepts caller-asserted lifecycle
evidence. Without these tables, existing identities, crons and retention behavior
remain unchanged. Activation/rollback:
[`hermes-conversation-t1-activation.md`](hermes-conversation-t1-activation.md).

- `shared/hermes-conversation-context.ts`: strict metadata parsing, immutable
  snapshots, full identity key and stable shortened names.
- `shared/hermes-conversation-bindings.ts`: explicit schema installation and
  synchronous transactional binding lifecycle against the broker SQLite database.
- `shared/hermes-conversation-adapter.ts`: per-K delivery state, mutex, durable
  inbox and credential epoch; one shared scheduler, no per-chat processes/timers.
- `shared/hermes-conversation-mcp.ts`: actual SDK tool envelope, attached only by
  fixtures; all six tools select identity exclusively from request `_meta`.
- `shared/hermes-conversation-broker.ts`: explicit registration/recreation seam,
  injected evidence, stable UUID, token rotation and inbox-root registration.
  Fixtures supply synthetic lifecycle observations. T1 runtime supplies actual
  strict dispatch observations, not synthetic host close/reap events.
- `shared/hermes-conversation-fence.ts`: transactional token + generation +
  backend + adapter fencing on existing read/mutation/ack paths. Token-only
  legacy calls cannot access a conversation mailbox; legacy `prev_id` and names
  cannot take it over.
- `shared/hermes-conversation-orphans.ts`: explicit operator archival/disposal.
- `hermes-conversations-cli.ts`: explicit-path inspection/disposal CLI, with no
  live database default, startup, or schema installation during inspection.
- `shared/hermes-conversation-runtime.ts`: opt-in stdio bootstrap, owner-only
  existing SQLite database, one active process per host backend UUID, strict
  host-owned home bridge, lease expiry and no autonomous wake.

## Contract for the temporary wake daemon

Table: `hermes_conversations`. `peer_id TEXT UNIQUE NOT NULL` is the complete
exclusion contract. The temporary daemon must exclude **every** matching peer,
not just active rows:

```sql
SELECT 1 FROM hermes_conversations WHERE peer_id = ? LIMIT 1;
```

If the table does not exist, there are no v2 bindings. Any other database/query
failure must make the temporary daemon abstain. Do not create or migrate the table
from a read-only wake check. Exclusion must be deployed before the first live v2 row.

## Agreed host metadata (Kepler9554)

Read from MCP `params._meta`, never model tool arguments or shared process env:

| Field | Meaning |
| --- | --- |
| `hermes/home` | Canonical absolute profile home; resolved by host |
| `hermes/conversation_id` | Stable stored ID of a validated compression-only lineage |
| `hermes/session_id` | Current stored transcript segment ID |
| `hermes/platform` | Actual session surface, independent of Electron env flags |
| `hermes/backend_id` | UUID of the backend lifetime |
| `hermes/ui_session_id` | Optional runtime ID for GUI/TUI sessions |

The adapter supplies its expected profile home and backend ID to the parser.
`AGENT_PEERS_HERMES_BACKEND_ID` is a host-generated process-lifetime UUID carried
only in child spawn configuration. Replacement MCP children receive the same UUID;
a new backend receives a new UUID. The adapter validates and snapshots it, never
generates a fallback, and compares it with every request's `hermes/backend_id`.
Lexical path aliases and mismatched owners are refused. The host must resolve
symlinks and lineage; the parser does not resolve arbitrary paths or infer lineage.
Unknown `_meta` fields are ignored so unrelated MCP metadata remains compatible.

The key is JSON encoding of `[home, conversation_id]`, avoiding ambiguous string
concatenation. Names hash the full key; compression/runtime-ID changes do not rename
the peer. A branch is a new conversation. Hash suffixes lengthen if a name is already
reserved by a binding or visible peer.

## Binding fields and lifecycle

Primary key: `(home, conversation_id)`. Stable `peer_id` and `name` are independently
unique. Summary is per binding. The current stored session, platform, backend and
adapter IDs are stored alongside ownership and lifecycle generations.

`generation` fences each new binding owner. `lifecycle_generation` is the host's
monotonic lifecycle sequence within a backend lifetime. `observed_at` is the host
observation time in epoch milliseconds. A new backend can restart its sequence.

The store only accepts fresh observations (at most 10 seconds old, not in the
future). Ownership lasts 45 seconds from observation. Replaying an unchanged
snapshot does not keep extending the lease. A different owner cannot claim a live
lease; after expiry/release a fresh claim increments the ownership generation and
preserves UUID, name, summary and created time.

States: `active`, `reaped`, `closed`, `suspended`, `orphaned`, `disposed`.
Automatic reap and explicit close are distinct. Expiration means suspended, not
closed. A deleted chat's orphaned binding cannot be silently reclaimed. Disposal
is reserved for the operator integration, not performed by this store.

The store has no heartbeat timers, subscriptions, cached per-chat objects or
background process. Callers own their scheduling and must unload per-conversation
delivery state when releasing a binding.

The binding store alone is not authorization. The T1 broker integration combines
it with `hermes_conversation_tokens` and a transaction covering owner validation
and the normal broker operation. Poll/ack/send/summary/rename/heartbeat/unregister
require the current tuple and token. Visible-row GC does not delete the binding.
Renewing an expired owner rotates its generation/token; the adapter resets that
epoch's presentation state and fences old callbacks rather than wedging forever.
Waits obtain fresh trusted evidence, not just visible-peer heartbeats.

## Private delivery and retention

The adapter freezes metadata and snapshots its per-identity arrival barrier before
the first await. Persist-before-presentation, abort rollback, and confirmation only
by a later request from the same identity apply to every tool. A parked wait cannot
confirm a response promoted after the wait arrived. Sender-filtered waits leave
nonmatching mail undrawn. Close/reap unloads local state but never acknowledges mail.
At confirmation, durable pruning precedes broker acknowledgment, matching the
legacy transport. A bounded pending-ack map retries failures and confirmed
re-offers refresh their lease token. Unknown/expired results are reported as
incomplete broker acknowledgments, never silently treated as broker success.
Persisted per-UUID segment history refuses redispatched superseded transcripts.

Unread v2 messages are exempt from age GC. All v2 mailbox states enforce a
500-unread cap and explicitly refuse message 501. Acked history and all legacy
retention remain unchanged. Sending to a dormant saved UUID/name succeeds with an
explicit queued/no-wake notice; disposal refuses new sends. Claude, the shared
Codex/Hermes/Droid transport, and the operator sender display the broker notice.
Legacy `gc-inboxes` skips every retained conversation binding.

## Operator orphan disposition

```sh
bun hermes-conversations-cli.ts status --db /absolute/broker.db
bun hermes-conversations-cli.ts orphans --db /absolute/broker.db
bun hermes-conversations-cli.ts dispose <peer-id> --db /absolute/broker.db
bun hermes-conversations-cli.ts dispose <peer-id> --db /absolute/broker.db --apply
```

Disposal defaults to dry-run and requires a released orphan. The operator first
archives exact broker message IDs into `hermes_disposed_messages` and installs a
non-resumable tombstone. A persistent pending journal then archives both body and
metadata files under **every registered inbox root**, verifies each copy, and
removes only the verified originals. Only after archival completes are the exact
archived broker rows removed. No message is marked acknowledged. Partial failures
remain recoverable and retryable with the same command; completed disposal is an
idempotent no-op. Archive contents remain under the existing owner-only boundary.

## Verification and remaining work

Run:

```sh
bun test tests/hermes-conversation-bindings.test.ts
bun test tests/hermes-conversation-adapter.test.ts tests/hermes-conversation-broker.test.ts
bun test tests/hermes-conversation-cycles.test.ts
bun test
bun run typecheck
```

The original binding-only fixture remains. The resource fixture runs the
actual adapter, broker functions, SQLite and durable inboxes in a fresh Bun child:
50 cycles, five simultaneous conversations each, 25 close plus 25 reap. It asserts
zero per-chat map entries, calls, waiters, visible peers and live leases after
release, one shared timer until stop, 250 dormant identities and 250 unread
messages retained, FDs returning to baseline, and post-GC RSS growth from cycles
10–50 at most 10 MiB. Body/metadata IDs, recipient placement and body text must
match the broker's retained messages. The test prints baseline/peak/final RSS,
FD values and maximum batch cleanup time. Actual stdio fixtures additionally
exercise the gated launcher and MCP-only SIGKILL/replacement.

This does **not** prove 50 real Hermes chats, an actual host lifecycle feed,
backend SIGKILL/restart, live idle wake, or MacBook/Studio end-to-end acceptance.
In-memory SDK envelope tests and adapter function/resource fixtures are distinct.

Release boundaries:

1. T1 activation requires Kepler's reviewed strict-context/compression package
   with both host-owned spawn bridges, the updated broker, and v1 exclusion.
   Marco owns live A/B identity/private-mail acceptance.
2. T2 requires actual host lifecycle evidence and non-owning/deduplicated wake
   admission beyond T1 dispatch observations.
3. Exact-session wake and old-daemon retirement require real transport/retry/
   lifecycle acceptance, measured backend death, and MacBook proof.

No live services may be changed until Marco releases the deployment phase.

### Approved staging (Marco9557)

- **T0:** Kepler's update guard.
- **T1:** metadata and compression resolver, plus fixture proofs of goal items
  1 (identity/status), 2 (private mail), and 5 (cleanup/continuity). Marco9647 adds
  the opt-in runtime bootstrap for live items1/2; lifecycle cleanup in T1 remains
  lease-only. The v1 daemon retains **legacy-only** wake duty.
- **T2:** lifecycle snapshot, non-owning admission, goal items 3/4/6/7 and v1
  retirement. No autonomous v2 wake is claimed in T1.

Goal item numbers remain unchanged. Kepler's 7–10-day estimate is **human-equivalent
engineering effort**, not measured agent-clock or elapsed delivery time.
