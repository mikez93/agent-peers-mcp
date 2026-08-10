# Delivery Contract — per-harness guarantees

What each runtime can and cannot promise about message delivery. This is the
canonical reference for "did my peer see my message?" questions (bd-21r.2).

## The universal contract: honest at-least-once

Exactly-once is unattainable at the model/UI boundary, so the system does not
pretend. Every message is:

1. **Queued at the broker** — durable in `~/.agent-peers.db` with a globally
   unique `message_uid`; the sender's `send_message` success means *queued*,
   never *seen*.
2. **Leased** to the recipient's MCP (30s lease, re-leased on expiry).
3. **Persisted** to the recipient's on-disk inbox *before* presentation
   (write-before-push), so a SIGKILL between lease and read loses nothing.
4. **Acked** back to the broker only after persistence — and for Codex/Hermes,
   only on the recipient's *next tool call* (confirm-on-next-call).

Duplicate presentation is possible (lease expiry, crash between persist and
ack); the on-disk store dedupes by message id, and acks are **typed**:
`acked | expired | unknown | wrong_session`. A client must never treat
`{ok: true, acked: 0}` as success.

**An unacked broker row addressed to an idle agent whose inbox file already
holds the message is NORMAL, not stuck.** The ack flushes when the agent next
does anything.

## Per-harness behavior

### Claude Code (`claude-server.ts`)

- **Push-ish**: a background poll (1s) pushes into the session's channel and
  ring buffer, *after* persisting to the durable store
  (`~/.agent-peers-claude/<peer-uuid>.json`, 15-min TTL).
- Channel push only renders when the session redraws; messages that arrive
  while the session sits idle at the prompt queue invisibly. **`check_messages`
  at the start of a turn is the only reliable read** — it unions the ring
  buffer and the durable store.
- Durable registration requires `PEER_NAME` set and
  `AGENT_PEERS_EPHEMERAL != "1"`.

### Codex CLI (`codex-server.ts`)

- **Piggyback**: fresh mail is prepended as `[PEER INBOX]` to the next tool
  result. No idle push exists; a completely idle Codex session sees nothing
  until its next tool call or an explicit wake.
- `wait_for_peer_messages` blocks up to 300s (default), optionally filtered by
  `from` — a non-matching message ends nothing and is never consumed by the
  filter.
- All inbox steps (ack-flush, confirm-promote, poll, read/mark) run under a
  per-process mutex; parallel/batched tool calls cannot double-deliver.

### Hermes (`hermes-server.ts` → codex transport)

- **Bounded polling, never push.** Waits cap at **60s** (vs 300s for Codex) so
  a Hermes turn can't hang on an empty inbox. `check_messages` is canonical.
- Unread state is durable on disk (`~/.agent-peers-hermes/<peer-uuid>.json`)
  and survives MCP restarts, `/reload-mcp`, and process death.
- **One durable peer per logical agent**: gateway and serve surfaces race a
  PEER_NAME-keyed file-lock election (`~/.agent-peers-hermes/name-claims/`);
  the winner registers durable and owns the name, losers register ephemeral
  send-only and age out in 60s. Duplicate ephemeral rows next to a durable one
  are election losers, not a bug.
- Config contract per profile: `PEER_NAME`, `AGENT_PEERS_CWD`,
  `AGENT_PEERS_ENABLED: '1'`. Kill switches: flag file
  `~/.agent-peers-hermes/disabled` (all surfaces), or
  `AGENT_PEERS_HERMES_ROLE: passive` per surface.

## Receipts and recovery

- `list_peers` + broker `messages` table answer "queued for whom"; the
  recipient's inbox file answers "persisted"; typed ack outcomes answer
  "confirmed".
- Observability CLI: `bun cli.ts inboxes [--stranded]` (unread mail matched to
  live/dead broker rows), `stranded-messages` (unacked to peers idle >24h),
  `gc-inboxes [--apply]` (archives dead inbox files by rename — never deletes).
- On re-registration, `prev_id` re-points unacked mail to the new incarnation
  only when the old row is gone; a live row is never robbed.
- Broker restarts stamp a new `BROKER_EPOCH` (returned on register/heartbeat)
  so clients can tell "broker restarted" from "I was evicted".
