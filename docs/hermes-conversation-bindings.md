# Hermes per-conversation binding foundation

Tracking: `bd-1con`. Design approved by Marco on 2026-09-08:
`agentic-coding-resources/.specs/2026-09-08-hermes-conversation-peers-design.md`.

## Current implementation boundary

**Fixture-only foundation.** The new modules are not imported by any running adapter
or broker entry point. No production migration installs the table yet. This is not
an idle-wake release and does not change existing delivery guarantees.

- `shared/hermes-conversation-context.ts`: strict metadata parsing, immutable
  snapshots, full identity key and stable shortened names.
- `shared/hermes-conversation-bindings.ts`: explicit schema installation and
  synchronous transactional binding lifecycle against the broker SQLite database.
- `tests/hermes-conversation-bindings.test.ts`: temporary-database tests for the
  above, including 50 cycles of five bindings each.

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

**This is not an authorization endpoint.** Owner handles are internal adapter/broker
values, not bearer credentials. The future broker integration must authenticate
each request, validate authoritative host evidence, and atomically fence peer-token,
message and binding operations. It must not expose this store directly to MCP callers.
In particular, the store alone does not revoke a broker token or enforce read/ack
isolation: those remain required integration work.

## Verification and remaining work

Run:

```sh
bun test tests/hermes-conversation-bindings.test.ts
bun run typecheck
```

The 50-cycle fixture proves binding-state cleanup only: five active bindings during
each cycle, zero afterward, 250 retained dormant mailbox records, zero remaining
nonzero owner leases. It does **not** prove 50 real chats, RSS/FD/timer bounds,
SIGKILL recovery, or end-to-end delivery. Those are later acceptance tests.

Still required before activation:

1. Kepler's implementation of agreed strict-context metadata and compression
   identity, then lifecycle snapshot and non-owning/deduplicated wake admission.
2. Atomic broker registration/token fencing with stable UUID recreation; per-identity
   adapter inbox, polling and confirm-on-later-call state.
3. v2-only unread retention exception and 500-message send cap, plus dormant recipient
   notices in actual `send_message` responses (the notice helper alone is not delivery).
4. Operator orphan list/dispose command and orphan count in adapter status. Disposal
   must explicitly reconcile both broker rows and persisted inbox obligations.
5. Exact-session wake coordinator and old-daemon exclusion/cutover.
6. Real MCP/serve isolation, transport, retry and lifecycle tests, full 50-cycle
   resource measurements, Marco's live A/B and MacBook proof, independent review.

No live services may be changed until Marco releases the deployment phase.

### Approved staging (Marco9557)

- **T0:** Kepler's update guard.
- **T1:** metadata and compression resolver, plus fixture proofs of goal items
  1 (identity/status), 2 (private mail), and 5 (cleanup/continuity). This foundation
  covers only binding state, not all of T1. The v1 daemon retains legacy wake duty.
- **T2:** lifecycle snapshot, non-owning admission, goal items 3/4/6/7 and v1
  retirement. No autonomous v2 wake is claimed in T1.

Goal item numbers remain unchanged. Kepler's 7–10-day estimate is **human-equivalent
engineering effort**, not measured agent-clock or elapsed delivery time.
