# T2 exact-wake coordinator fixtures

Tracking: `bd-1con`. This is source-stage work, not a live wake release.
The runtime imports these modules but selects their composition only through
a programmatically injected authenticated host bridge. The standard launcher
supplies none. No new service flag, daemon replacement or real inference is
enabled merely by importing these files.

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
endpoint. Standard `hermes-server.ts` supplies no bridge and retains T1 behavior.

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

### Exact remaining host methods (Kepler9751)

The typed bridge is `HermesConversationHostBridge` in
`shared/hermes-conversation-composition.ts`. Final authenticated wire translation,
factory construction and a replayed host source pin remain required:

1. `observe(exactContext, signal)`: positive registry/readback ownership, host
   lifecycle generation and **request-start** time. GUI checkpoint `329d93de36`
   is not all-host inventory. Native CLI/cron positive authority is unimplemented;
   `runtime_context` hints must yield unknown/no bind, never a T1 fallback.
2. `inventory(knownRoots, signal)`: complete normalized scope, exact live/terminal
   states/reasons and unknown handling; batch/deduplicate terminal lookups limited
   to 128 roots per host request.
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
