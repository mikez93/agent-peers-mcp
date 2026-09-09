# T2 exact-wake coordinator fixtures

Tracking: `bd-1con`. This is source-stage work, not a live wake release.
The runtime selects composition through a host-issued private attachment or a
programmatically injected test bridge. Without either it retains T1 behavior
(except the existing host-counter rollback refusal). No new service flag,
daemon replacement or real inference is enabled merely by importing these files.

## Boundary

The coordinator accepts bodyless pending-mail candidates from the authoritative
binding store. Status text, sender history, PID, backend recency and foreground
pane selection are not identity sources. It freezes each candidate at entry.

Injected ports must supply authenticated exact lifecycle evidence, recheck the
current binding before admission, and admit a hidden queued event without taking
over the user's transport. Host ownership-lock validation and durable idempotency
are required contracts, not behavior implemented by the TypeScript fixtures.
There is deliberately no assumed public RPC name or metadata-injection endpoint.

Lifecycle evidence must match home, compression root, current segment, backend,
platform and optional UI ID. Unknown/missing/stale evidence and busy, queued or
compacting work defer. Only an authoritative `automatic_reap` terminal reason
permits exact cold resume. Explicit close, deletion and finished cron do not.
The bridge must translate verified host enum values, not infer a terminal reason
from absence in an inventory.

## Attempts and mail

One persistent latest-attempt row belongs to each stable peer/K. A positive
`attempt_sequence` increases transactionally for each new attempt and never
resets for new mail, backend replacement or coordinator restart. Replays retain
the same sequence and UUID. The host must retain its latest sequence/UUID/status,
reject lower sequences and equal-sequence/different-ID calls, and admit a higher
sequence only after the previous attempt is terminal (Kepler9682).

Uncertainty is
written before calling admission. Lost responses require reconciliation; unknown
is not absence. Accepted/started attempts prevent a second prompt, including when
new mail arrives. An unresolved old backend cannot be replaced by guessing a new
owner. Host receipts must echo the exact attempt and context.

Completed unchanged mail retries after 60 seconds, 5 minutes and 30 minutes,
then remains exhausted without a TTL reset. Ack-only shrinking of the unread set
does not reset that budget. Cancellation suppresses the remaining old mail;
genuinely new message IDs may start a new budget. No receipt state acknowledges
mail. Ordinary later-call confirmation remains the only delivery authority.

Deferred replacements preserve the existing retry budget. Independent targets
run concurrently under one pass deadline (at most five seconds), not per-chat
timers. Every port receives an AbortSignal and must cancel its transport work,
not an already admitted host turn. Late replies cannot update the ledger.

## Evidence and remaining integration

The focused tests exercise routing, strict evidence checks, immutable entry
snapshots, concurrent claims, uncertain RPC recovery, cancellation and backoff.
The MCP test uses the real SDK, conversation adapter, broker and disk inbox.
A fixture host dispatches the admitted context: only its own private inbox reads
the synthetic message, and a sibling's later call cannot acknowledge it.
The disk test closes/reopens SQLite to verify ledger continuity.

These tests do **not** prove a real Hermes host admitted or started a turn,
preserved a Desktop socket, resumed a cold session, survived backend SIGKILL,
or met the 30-second idle-ready wake goal. They do not replace the separate
50-cycle adapter fixture or the required live cross-surface acceptance.

Before integration, pair Kepler's reviewed lifecycle/admission package with an
authenticated bridge and bounded transport calls, verify final host schemas,
and test the real owning dispatcher. T1's adapter dispatch sequence is not a
host lifecycle sequence: promotion requires a new backend UUID or a separate
counter namespace. Keep v1 excluding every v2 binding, and keep durable legacy
mailboxes/crons separate. Marco owns live acceptance and daemon retirement.

The lifecycle reconciler must also keep **open, idle conversations listed with
their own status** while fresh host evidence proves ownership (Marco9692).
Renewal cannot depend on model tool activity or the 45-second T1 dispatch lease.
Explicit close and automatic reap delist/release loaded state while retaining
the private mailbox; missing inventory is unknown, not close. This reconciler is
not implemented by the wake module. Its candidates must come from that reconciled
binding authority before live T2 activation. The coordinator already receives the
actual peer UUID; it never asks a model to report its identity from `list_peers`.

## OPEN-idle lifecycle preparation

`shared/hermes-conversation-lifecycle.ts` is the shared reconciliation engine.
It normalizes no
particular Hermes RPC. Its input is an authenticated complete inventory with
home/backend identity, observation time, and explicit per-conversation state,
reason and host sequence. Unknown/incomplete/stale input abstains; missing rows
never generate close commands.

The caller supplies a synchronous local transactional `apply` port. That port
must compare the expected binding epoch/state/segment/order, maintain visible
peer/token state on renewal, revoke it on terminal release, and persist host
sequence provenance atomically. This is a required integration contract, not
permission to call the T1 asynchronous broker binding method without awaiting it.

T1 bindings have dispatch-order provenance. The same backend cannot silently
reinterpret that number as a host counter. A new backend UUID can reset the
counter only after old live ownership has expired and a newer observation
proves the exact conversation. Terminal evidence cannot release a different
backend's owner. Same-backend adapter replacement still needs a verified
ownership handoff; this preparatory engine abstains rather than guessing.

The controlled-clock test renews two actual broker binding/listing rows every
15 seconds for ten simulated minutes. Both retain their own status and epoch,
and the synthetic unread message row remains byte-for-byte equivalent. No
additional agent tool calls or model turns keep them alive. Other fixtures prove
exact close/reap delisting, token revocation without ack, stale/duplicate/unknown
evidence refusal, observation-anchored leases, immutable pass entry and CAS races.

The original engine fixture uses the real binding store plus visible-row
renewal/release SQL. Its new-backend test checks the proposed change and does not
claim successful mailbox reactivation. The paired port below extends the evidence
to same-backend recovery and real adapter drainage.

Generic native CLI/cron hook context may use `runtime_context` with the six
unprefixed identity fields and omitted absent UI ID (Kepler9727/Vector9734).
It remains a hint. A finalizer hook before a successful durable terminal write
cannot itself authorize release or prove liveness.

## Atomic broker pairing and local drainage

`shared/hermes-conversation-lifecycle-port.ts` pairs the normalized engine with
the real broker and adapter, now used by the injected runtime composition. Its
explicit fixture schema records host sequence provenance; it is not a migration
or permission to relabel live T1 dispatch counters.

Expected-binding comparison, binding renewal/release, visible peer/token state
and provenance update share one immediate SQLite transaction. Renewal reuses
the broker's synchronous `bindObserved` transaction, including inbox registration,
status restoration and old-epoch lease reset. This is a trusted local evidence
seam, not an HTTP route accepting model-supplied identity.

A terminal transaction revokes visibility and credentials before local calls
drain. `drainFenced` cancels only the matching or older local epoch, wakes parked
waiters without running unrelated maintenance, and waits for actual call
completion before deleting that slot. A poll that yields across close checks
cancellation again before parking; it does not need another scheduler tick.
Neither release nor drainage confirms a message.

Keep the lifecycle port for the adapter lifetime. It retains one latest pending
drain per peer and retries failed cleanup even when terminal evidence is
unchanged or a fresh host observation renews the binding. Successful cleanup
removes only that exact pending entry; an old completion cannot remove a newer
obligation. These are process-local cleanup obligations, not a durable journal:
process death itself discards local calls. Durable identity and mail remain in
the existing broker/inbox stores.

The paired tests use real temporary SQLite databases, broker functions, disk
inboxes and adapter calls. They verify:

- After expiry and removal of the collected peer/token, fresh host evidence
  restores the same UUID/status with a new credential epoch. The old credential
  is refused, mail is reoffered, and only a later request in the new epoch acks.
- Close revokes the peer/token while an actual poll is blocked. Drainage waits;
  the old call is cancelled and unread mail remains available after exact resume.
- Automatic reap drains a parked waiter; a close during an empty poll cannot
  create a waiter after the terminal notification, even with no running timer.
- A provenance-write failure rolls the transaction back; an expected-binding
  race cannot release a newer epoch. An old drain cannot evict a resumed slot,
  and a fresh resume survives an earlier close finishing.
- Failed postcommit cleanup is retried without another release or ack, and a
  failing maintenance hook cannot strand terminal local cleanup.

The last two cleanup defects were independently reproduced and captured as
failing regressions before correction. This extends the earlier binding-only
proof; it does **not** establish production authenticated inventory translation,
provenance migration/bootstrap, all cross-backend or replacement-adapter handoffs,
real host process death, cross-surface liveness, or live wake acceptance.

## Runtime composition and paired activation dependencies

`startHermesConversationRuntime({ createHostBridge })` composes the adapter, one
long-lived lifecycle port and the wake coordinator. This programmatic dependency
is not an environment-controlled module loader or public identity-injection
endpoint. Standard `hermes-server.ts` now constructs the GUI bridge when the
host supplies `AGENT_PEERS_HERMES_ATTACHMENT`; invalid references fail startup
rather than silently falling back to T1.

Containment, private database validation and exclusive backend process claims
precede bridge construction. Preparation requests inventory before stdio connects
and never admits a turn. The existing adapter scheduler then runs non-overlapping
lifecycle/wake passes. Observation calls are bounded and abortable. Stop aborts
transport work, drains local calls and closes the bridge/server/database while
retaining mailbox and uncertain-attempt state. It neither cancels accepted host
turns nor acknowledges mail.

First T2 bind/renew requires positive authenticated `observe` evidence, not a
dispatch counter. The same backend cannot silently cross counter namespaces:
forward cutover needs a reviewed namespace change, and a host-marked backend
refuses T1 rollback without a new backend UUID. That UUID does not replace an
unresolved wake attempt; its original request must be reconciled first.

For same-backend MCP replacement, the verified current process claim plus fresh
host evidence recovers inactive/expired live bindings without a model tool call,
advancing generation/token fencing. An exact already-reaped binding may transfer
local adapter ownership without creating a visible peer/token, allowing a
separately fenced cold-resume request. A live lease, missing provenance or lost
process claim cannot be bypassed.

Strict whole-inventory validation and successful lifecycle decisions gate wake
candidates. Future/incomplete/malformed evidence or a failed transaction cannot
be bypassed by another snapshot. Binding/unread state and local closing state are
rechecked at the bridge admission boundary. Host-side atomic admission/start
fencing remains separately required.

The real stdio tests use a **synthetic host**, not Hermes. They prove zero
transport starts on preparation failure/cancellation, bodyless wake routing,
graceful and MCP-only SIGKILL replacement from retained host context before
another tool call, and rollback under a new
backend UUID with the same mailbox/unread message. They do not prove actual model
wake, host admission persistence, user transport preservation or native liveness.

### Frozen GUI translator subset (Kepler9759/9760)

`shared/hermes-gui-lifecycle-bridge.ts` implements the GUI observation/inventory
translation against reviewed Hermes commit
`329d93de36cd32806e4fd4922ebc735eb307b37a`:
`tui_gateway/methods_lifecycle.py:161–249`,
`hermes_state_runtime_lifecycle.py`, and the reclaim-reason set in
`tui_gateway/session_lifecycle.py:286`.

The caller provides the **existing authenticated, response-ID-correlated**
JSON-RPC transport. `request()` resolves the result object only and rejects RPC
errors. The bridge does not open sockets, read credentials or provide a new
authentication factory. Its sole wire method is `session.lifecycle_snapshot`,
with optional existing profile selector and at most 128 unique
`conversation_ids`. A profile selector is never synthesized from canonical home;
returned home/backend must match the bridge scope exactly.

Local `observe()` selects an exact six-field Desktop row from this snapshot.
It is not a new RPC. Unsupported/native/compute surfaces remain unknown. Missing
rows and the short `{conversation_id,state:"unknown"}` terminal form never
create identity or imply close. Sequence must be positive, live activity flags
must be booleans, and durable terminal end fingerprints must be numeric.
`changed_at` may be newer than request-start `observed_at`; it is not freshness.
The end fingerprint is opaque, not converted into a freshness timestamp.

Larger terminal lookup sets use sequential 128-root batches under one five-second
deadline. Repeated whole-GUI live inventories must agree (including activity
flags); changes, malformed/error responses or partial inventory discard the
entire aggregate. Identical live rows are deduplicated and the oldest
request-start time is retained. This is deliberately conservative, not an atomic
snapshot across requests. `inventory_complete` only describes the captured GUI
registry, never native or fleet completeness.

Only `idle_timeout`, `lru_evict`, and `ws_orphan_reap` map to `automatic_reap`;
`tui_close` maps to `explicit_close`. Other durable end reasons currently abstain,
rather than inventing a normalized completion/close policy. RPC 4004/5036,
timeouts and aborts yield unavailable/unknown, not an empty authoritative inbox.

The bridge's `admit` and `reconcile` methods **reject as unavailable**. It has no
live activation. Its original tests feed pinned-shape synthetic
RPC results and compose the translator with the actual broker/adapter: metadata
is translated, but no host turn is admitted and unread mail is not acknowledged.
Neither those fixtures nor an injected transport prove authentication or real
host RPC cancellation.

### Exact remaining host methods

The typed bridge is `HermesConversationHostBridge` in
`shared/hermes-conversation-composition.ts`. Final native/admission wire
translation and a replayed final host source pin remain required:

1. `observe(exactContext, signal)`: positive registry/readback ownership, host
   lifecycle generation and **request-start** time. GUI checkpoint `329d93de36`
   is not all-host inventory. Native CLI/cron positive authority is unimplemented;
   `runtime_context` hints must yield unknown/no bind, never a T1 fallback.
2. `inventory(knownRoots, signal)`: the frozen GUI subset above is translated.
   Native positive authority and final cross-surface integration remain open.
3. `admit(request, signal)` / `reconcile(request, signal)`: exact context,
   lifecycle generation, monotonic attempt sequence/UUID and durable receipt.
   These host methods are unimplemented. They must fence close/disposal before
   enqueue and again before start, preserve hidden queued/display/terminal-callback
   fields, and never rebind user transport.
4. `close()`: release bridge transport/resources without cancelling accepted work.

Do not substitute ordinary `prompt.submit`/`session.resume` or guess missing
native authority. Assemble the paired activation package after these methods
and source replay are frozen. Preserve the new broker, retained mail, v1 exclusion
and durable crons throughout rollback. Marco owns live acceptance and retirement.

## Host-issued authenticated attachment

`shared/hermes-runtime-attachment.ts` pairs the GUI translator with the existing
authenticated `/api/ws` route, pinned to Hermes
`976c118bcd3c39c5ddd242459251df8bb879d618` (tree
`ecf26f5a1a6e541268618fd45a06fe1e1773d84f`). The host publishes a canonical
private descriptor after actual loopback bind and forces its reference after
child configuration overrides. It does not add another authentication scheme.

The factory reads only the supplied reference. It requires an owner-only0700
parent and regular, single-link0600 file, checks the opened descriptor and
named inode, bounds its read, and verifies version/scope/auth fields. Endpoint
validation precedes URL normalization: only literal IPv4 loopback or `[::1]`,
explicit port, `/api/ws`, and the one matching UUIDv4 marker are accepted.
Credentials are added in memory; filesystem, parsing, socket and RPC errors
never propagate private descriptor contents, paths or authenticated URLs.

Connection plus first `gateway.ping` has one five-second deadline. The ping
must return the exact home/backend; there is no `gateway.ready` wait. Subsequent
requests are result-only, ID-correlated and bounded, with local abort/late-reply
fencing. The attachment omits profile selectors. Close terminates only its
socket, settles pending requests and never deletes the host-owned descriptor.
The host's non-owning route preserves dispatched workers on socket loss;
accepted-turn preservation remains unproved until admission exists.

The standard launcher constructs this bridge only after containment, private
database validation and exclusive backend claim. Missing/invalid supplied
references fail startup with no T1 fallback. A shutdown during handshake aborts
construction and releases the claim. An absent reference retains the earlier
T1 path and host-counter rollback guard.

The new fixture suite covers actual loopback token/internal handshakes,
permission/link/path/scope/endpoint refusals before dialing, refused upgrades,
redirect refusal, malformed/oversize/error responses, correlation, cancellation,
deadlines, remote socket loss, descriptor reuse and real standard stdio startup.
The upgrade-refusal fixtures model ASGI's preaccept HTTP403, not real host
authentication. Remote socket loss uses a disposable child process because
Bun1.3.14's in-process server-side close leaves `pendingWebSockets=1` and its
`stop()` promise unresolved. These tests do not claim Hermes backend-death
continuity, native lifecycle authority, admission, model turns or live rollout.

`tests/fixtures/hermes-attachment-consumer.ts` is the bounded descriptor consumer
for the separate Python-host pairing harness. It uses the actual factory,
checks complete scoped inventory and idempotent close without deleting the
reference, and emits only a content-free success marker or failure exit.

Kepler9788 reports paired **2/2 token/internal PASS**, retries0, using real
uvicorn plus the production Python route at the frozen host pin. Both cases
invoke that actual Bun consumer under minimal environment/temporary HOME.
Consumer SHA256 `6f33745cd0a8f3e9e354028540fac2b3e56e6ce6841c50dd4e8f6ed4a5a587ec`;
factory SHA256 `20e32d2ed57905fe96f88f6082ba15413287bc3f9a0ce08faf2881f8c674a6c4`,
stable before/after. This proves factory-to-Python authentication, exact
**empty** inventory, idempotent close and descriptor retention. It does not
prove populated lifecycle ownership, the complete MCP composition against
Python, unread/ack, native authority, admission or resource-cycle acceptance.
The local pairing harness is Kepler-owned
`tmp/hermes-attachment-pair-20260909/test_pair.py`, SHA256
`9c160cb4c3ae35c33718b6690489a55af6ceca87a570f7b39c696f5f55884bb2`.

Final local validation: 43 attachment tests, 58 combined attachment/runtime
tests with260 assertions, and full522 tests/55files3662 assertions; TypeScript
and diff checks pass. Independent source review (including final cleanup delta)
is clear. Independent QA initially passed56 combined tests/234 assertions, then
rechecked the final43 attachment tests/189 assertions and typecheck, including
exact error/stack/stderr redaction, nonregular-directory refusal and
post-handshake timeout. Wrong-owner rejection,
successful IPv6 dialing and explicit zero-stdio-start instrumentation during the
attachment handshake remain source-checked or separate-fixture evidence rather
than direct cases here. No production activation is implied by these results.
