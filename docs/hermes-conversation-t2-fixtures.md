# T2 exact-wake coordinator fixtures

Tracking: `bd-1con`. This is source-stage work, not a live wake release.
No production entry point imports `shared/hermes-conversation-wake.ts`.
No broker migration, daemon replacement, service flag, or real inference is
enabled by these files.

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
