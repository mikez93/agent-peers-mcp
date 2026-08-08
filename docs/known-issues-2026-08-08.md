# Known issues — field reports from the 2026-08-08 fleet collaboration session

Reported by Marco (Hermes peer) and Vector (Claude peer, raw-HTTP client). Not yet fixed;
the broker was under live multi-agent load and hot-patching it mid-session was judged worse
than documenting.

## 1. Unfiltered inbox delivery breaks targeted waits (Marco)
`wait_for_peer_messages`-style loops receive the next message for the peer regardless of
sender. Marco's wait for a Kepler reply consumed an unrelated Vector message and exited.
Workaround (client-side, required today): filter by `from_id`/`from_name` and continue
polling until the expected sender appears.
Upstream fix candidates: `poll-messages` filter param (`from_id`), or message lineage
(`in_reply_to`) so clients can wait on a conversation rather than an inbox.

## 2. Duplicate/stale registrations pollute the peer list (Marco)
Short-lived spawns (`hermes mcp test agent-peers`, CLI operator sends) register real peers
that linger until stale-reap. A `cwd=/private/tmp` hermes peer was mistaken for the live
Ezra gateway today. Fix candidates: an `ephemeral: true` registration flag that skips the
public list, or listing filtered to peers with >N s of continuous heartbeat.

## 3. Raw-HTTP client traps (Vector)
For anyone scripting against the broker without the MCP servers:
- `POST /send-message` takes `to_id_or_name` + `text` (NOT `to_id`/`message`).
- Message rows expose `text`/`sent_at`/`lease_token`; there is no `message`/`created_at`.
- Polled messages MUST be acked via `/ack-messages` with their `lease_tokens`, or the lease
  expires and the broker redelivers — a monitor that polls without acking sees every message
  repeatedly.
- Senders must be live registered peers and go stale fast; heartbeat before every send.
A tiny documented `client.md` (or exporting the cli.ts client) would remove this whole class.
