# Delivery Contract — per-harness guarantees

**Normative.** What each runtime can and cannot promise about message
delivery. This is the canonical reference for "did my peer see my message?"
questions (bd-21r.2).

Verified against the code at commit `9be6159` (branch `docs-v3`), 2026-11-02.
Where this file and the code disagree, the code is right and this file has a
bug. Companion docs: the implementation is in
[components/mcp-servers-delivery.md](components/mcp-servers-delivery.md);
federation in [components/federation.md](components/federation.md); OpenClaw in
[components/openclaw-peer.md](components/openclaw-peer.md); Hermes Desktop wake
in [components/hermes-desktop-wake.md](components/hermes-desktop-wake.md).

## At a glance

| Harness | Mail reaches the model through | Idle wake | Broker ack |
| --- | --- | --- | --- |
| Claude Code | Channel push, plus `check_messages` backfill | Channel push, Claude Code's inbox socket, or (desktop app) the rewake hook | At poll time, after the durable write |
| Codex | `[PEER INBOX]` prepended to tool results | Wake daemon starts or steers a turn (wakeable launches; desktop-app chats, including remote SSH ones, whose app-server exposes a socket) | Next tool call after a fully built response |
| Hermes | Same as Codex, per chat | Chat open in Desktop: in-process plugin. Closed chat: gateway driver, available per profile but switched off (see Hermes below) | Same as Codex |
| Factory Droid | Same as Codex | `droidpeer` host starts a bodyless turn | Same as Codex |
| OpenClaw | Same as Codex, main session only | Followup `chat.send` into `agent:<id>:main` | Same as Codex |

Every wake is bodyless and never acks anything. It only nudges the agent to
call `check_messages`. A wake can be lost or repeated; the mail stays queued
either way.

## The universal contract: honest at-least-once

Exactly-once is unattainable at the model/UI boundary, so the system does not
pretend. Every message is:

1. **Queued at the broker** — durable in that machine's broker database
   (`~/.agent-peers.db`, or `AGENT_PEERS_DB`) with a globally unique
   `message_uid`. The sender's `send_message` success means *queued*, never
   *seen*. Each of the four machines has its own broker and database; there is
   no shared queue (see [Across machines](#across-machines-federation)).
2. **Leased** to the recipient's MCP (30s lease, re-leased on expiry).
3. **Persisted** to the recipient's on-disk inbox *before* presentation
   (write-before-push), so a SIGKILL between lease and read loses nothing.
4. **Acked** back to the broker only after persistence. Claude acks right after
   the durable write; Codex, Hermes, Droid and OpenClaw ack only on the
   recipient's *next tool call* after a response that was fully built and not
   aborted (confirm-on-next-call).

Duplicate presentation is possible (lease expiry, crash between persist and
ack); the on-disk store dedupes by message id, and acks are **typed**:
`acked | expired | unknown | wrong_session`. A client must never treat
`{ok: true, acked: 0}` as success.

**An unacked broker row addressed to an idle agent whose inbox file already
holds the message is NORMAL, not stuck.** The ack flushes when the agent next
does anything.

## Addressing and chat mail (v3)

An address is `name[@host][/chat]`, or a peer UUID, or a chat-route UUID. The
broker resolves it, most exact first: UUID, chat route, exact name, then
case-insensitive name, then persona or leading name tokens (`marco`). Several
matches are never guessed; the sender gets the exact names back and nothing is
queued.

- **Chat-addressed mail.** A message whose `to_chat` is set belongs to one
  Hermes chat. The broker stores the stable chat key (the root session of a
  compressed chat). A sender produces it by addressing `name/<exact title or
  chat ID>`, or the address `list_chats` returns. There is no `to_chat`
  argument on the MCP tools. A chat address works only for Hermes peers; `/general`
  means the general mailbox. A title that does not match exactly returns
  candidates and sends nothing (`chat_miss`).
- **Mail isolation.** A poll without a chat, which is every non-Hermes client,
  every old client and every Hermes background loop, draws only general mail
  (`to_chat IS NULL`). A Hermes chat names itself and draws only its own mail
  from the profile's mailbox. A Hermes MCP call carries `chat` (and `from_chat`
  on `send_message`); without one it reads the general mailbox. Confirmation is
  partitioned the same way: a call confirms only presentations from its own
  partition, so one chat can never acknowledge another chat's mail.
- **Replies.** The broker records the sending chat, so a reply addressed to the
  message's `from_id` or `from_name` returns to that chat. If the sender's chat
  cannot be identified, replies go to its general mailbox and the send result
  says so.
- **Fallback.** A Hermes peer that has not advertised the `chat-mail`
  capability receives chat-addressed mail in its general mailbox, with a notice
  to the sender. With `AGENT_PEERS_HERMES_CHAT_MAIL=0` a Hermes MCP reads only
  general mail; chat mail stays queued, hidden and unconfirmed until the switch
  is removed.
- **Waking.** The background loop never polls chats, so a chat nobody opens is
  noticed only by a chat wake, or when someone opens it and reads (see Hermes below for which wakes are live).

## Across machines (federation)

Federation is opt-in (`AGENT_PEERS_FEDERATION=1`). Each machine stays
authoritative for its own peers and mail; no remote peer rows are copied, and
discovery is live. See [components/federation.md](components/federation.md).

- **Local first.** A bare name resolves on this machine; only `unknown_peer`
  triggers remote discovery. More than one match, or an unreachable machine that
  prevents a certain answer, requires an explicit `name@host`.
- **What "queued" means for a remote send.** The send writes a row to the
  sender's own broker outbox and returns a negative receipt id with the notice
  "queued for `<host>`; not yet delivered or seen". The relay runs later, outside
  the send. A transport or authentication failure retries with exponential delay
  capped at five minutes, with no age-based expiry; missing or invalid federation
  credentials fail closed and keep the mail.
- **What "delivered" means.** An outbox row marked `delivered` means the
  destination broker inserted the message into its mailbox. That is exactly the
  local meaning of queued. From there the destination runs the ordinary lease,
  persist and confirm pipeline for its harness. Federation never acks mail and
  never reports that anyone saw it.
- **No duplicates from the relay.** The destination records the outcome by
  `message_uid` in the same transaction as the insert, so a lost response or a
  broker restart causes another relay attempt but not a second row. Model
  delivery stays at-least-once.
- **Recovery notices.** If the destination refuses (unknown, stale, full,
  ambiguous, or missing chat) the sender receives one durable system notice, from
  `agent-peers@<host>`, in the originating mailbox and chat, listing qualified
  candidates. A delivery that succeeded with a warning (for example the
  general-mailbox fallback) also produces a notice. A destination broker that
  refuses the envelope itself, such as an older broker that does not know the
  `openclaw` peer type, bounces the same way instead of retrying forever. Notices
  survive the sender's eviction. Plain unreachability produces no notice; the
  message keeps retrying in the outbox.
- **Reply routing.** Relayed mail carries a persisted sender snapshot and a
  UUID-to-host route, so a reply to the sender's UUID or qualified name
  (`name@host[/chat]`) goes back to the right machine and chat, including after
  a broker restart. A UUID claimed by two hosts is not guessed.
- **`list_chats` across machines** is read-only: it writes no mail, wakes
  nothing, and returns qualified addresses (`ezra-hermes@studio/<chat key>`).

## Per-harness behavior

### Broker-side retention

The local durable stores above have no TTL. The broker's own `messages`
table does: acked rows are kept 7 days as receipts, and unacked **general**
mail is deleted after 30 days (`gcOldMessages`). A live recipient copies its
general mail into its local durable store within seconds of arrival (Claude
acks at that point; Codex, Droid, Hermes and OpenClaw leave the broker row
unacked until confirm), and that copy is removed only on confirm. So for
general mail the 30-day cutoff loses mail only for a recipient that never came
online in 30 days — mail to a UUID nobody will reclaim. `cli.ts
stranded-messages` lists it before then.

Unacked **chat** mail (`to_chat` set) never expires at the broker. A Hermes
owner's background loop reads only the general mailbox, so mail addressed to a
chat that nobody opens exists only in this table until that chat reads it (on
its own tool call or through the chat-wake pass). Legacy Hermes V2
conversation peers are also exempt.

### Claude Code (`claude-server.ts`)

- **Push-ish**: a background poll (every 1s while a peer conversation is live,
  every 3s when idle; `AGENT_PEERS_IDLE_POLL_MS`) persists each message to the
  durable store (`~/.agent-peers-claude/<peer-uuid>.json`), acks it, and then
  announces it. How it announces depends on the session: a session launched with
  the agent-peers channel gets a channel push carrying the message; a session
  with Claude Code's own inbox socket and no channel gets a bodyless
  "[Agent Peers] N new peer messages" notice through that socket; the desktop
  app keeps the `bin/claude-peer-rewake` hook unless socket wake is opted in
  (`AGENT_PEERS_SOCKET_WAKE=1`). `AGENT_PEERS_SOCKET_WAKE=0` turns the socket
  path off. A failed announcement loses nothing.
- Durable entries are removed ONLY by confirm-on-next-call: a `check_messages`
  response draws them, and a tool call that was ISSUED AFTER that response
  finished building is the evidence it reached the model. Eligibility is
  snapshotted at request entry — a call issued before or concurrently with a
  response (however late it runs) confirms nothing. `check_messages` calls are
  serialized by a lock, so batched calls cannot draw the same entry twice. There
  is NO TTL on unread durable mail — a dead session's file is archived (never
  deleted) by `gc-inboxes`.
- Earlier Claude Code builds queued a channel push that arrived while the
  session sat idle at the prompt, and showed it only when the session next
  redrew. On 2026-11-02, current builds were observed starting a new turn from
  an idle channel push (a MacBook terminal session, and an Omarchy test session
  that replied in about ten seconds). That is observed behavior, not a
  guarantee. **`check_messages` at the start of every turn remains the rule and
  the only reliable read** — it unions the ring
  buffer (last 15 min, at most 50 entries) with ALL unread durable mail at any
  age. Entries it surfaces are removed only after a LATER call confirms the
  response landed; an aborted/dropped response leaves them in place for
  re-delivery.
- Claude reads general mail only. It can send to a Hermes chat (`name/chat`)
  and call `list_chats`.
- Durable registration requires `PEER_NAME` set and
  `AGENT_PEERS_EPHEMERAL != "1"` (the same guard applies to Codex/Hermes/Droid:
  a requested name registers durable unless `AGENT_PEERS_EPHEMERAL=1`).

### Codex CLI (`codex-server.ts`)

- **Piggyback**: fresh mail is prepended as `[PEER INBOX]` to the next tool
  result. The background poll also sends a body-free MCP log notification, which
  current Codex does not show to the model; it is a nudge, never a delivery.
- **Waking.** A session launched through `codex-peer` (and, on macOS, a Codex desktop chat
  opened over SSH, after its first agent-peers tool call) is registered with the
  wake daemon. The daemon starts a turn on an idle thread, or appends the wake
  to a running turn with `turn/steer`. It leaves a thread parked on an approval
  or a question alone, and re-wakes the same unread set on a 5 min / 30 min /
  2 h schedule. A session that is not registered sees nothing until its next
  tool call. Operations: [wake-daemon.md](wake-daemon.md).
- `wait_for_peer_messages` blocks up to 300s (default), optionally filtered by
  `from` — a non-matching message ends nothing and is never consumed by the
  filter. A wakeable session returns immediately instead of blocking.
- All inbox steps (ack-flush, confirm-promote, poll, read/mark) run under a
  per-process mutex; parallel/batched tool calls cannot double-deliver.
  Delivery lifecycle (shared/delivery-state.ts): a message drawn into one
  call's response becomes confirm-eligible only when that exact response is
  fully built and un-aborted (an aborted request rolls its draws back
  re-dealable), and its broker ack is enqueued only at the NEXT call's
  confirm — never at draw time. Confirmation carries an arrival-causality
  barrier: each request snapshots confirm eligibility at entry (before any
  pre-read wait), so only responses fully built BEFORE the request was
  issued are confirmable by it. A concurrent or earlier-issued call —
  including one parked for minutes in `wait_for_peer_messages` — is never
  treated as evidence about a response built after it arrived.

### Hermes (`hermes-server.ts` → codex transport)

- **Bounded polling, never push.** Waits cap at **60s** (vs 300s for Codex) so
  a Hermes turn can't hang on an empty inbox. `check_messages` is canonical.
- Unread state is durable on disk (`~/.agent-peers-hermes/<peer-uuid>.json`)
  and survives MCP restarts, MCP reloads and process death. Mail that was drawn
  but not yet confirmed when a reload happens is shown again.
- **One durable peer per logical agent**: gateway and serve surfaces race a
  PEER_NAME-keyed file-lock election (`~/.agent-peers-hermes/name-claims/`);
  the winner registers durable and owns the name, losers register under an
  ephemeral generated name and age out in 60s once their process dies. Losers
  keep full tooling — they can still act as the user's live surface; they just
  never own the canonical name. Duplicate ephemeral rows next to a durable one
  are election losers, not a bug. A Desktop or WebUI backend can instead set
  `AGENT_PEERS_HERMES_ROLE=member`, which skips the election and registers as a
  member of the profile's mailbox.
- **Per-chat mail.** A loser or member can read a chat's mail from the owner's
  mailbox, but general mail sent to the durable name is read only by the owner's
  own child (the root gateway's), never by a Desktop child. See
  [Addressing and chat mail](#addressing-and-chat-mail-v3).
- Config contract per profile: `PEER_NAME`, `AGENT_PEERS_CWD`,
  `AGENT_PEERS_ENABLED: '1'`. Kill switches: flag file
  `~/.agent-peers-hermes/disabled` (all surfaces), or
  `AGENT_PEERS_HERMES_ROLE: passive` per surface.

**Chat wake: what "woken" means.** Chat mail is noticed by wake passes, not by
the recipient's background loop. Neither executor below acks mail, carries a
message body, or proves the agent read anything. The woken agent must call
`check_messages` with its chat, and the normal confirm-on-next-call then acks.

- *Gateway driver* (`shared/hermes-chat-wake.ts`, run by the wake daemon). For
  each chat with unread mail it runs `hermes -p <profile> chat --resume
  <session> -q "<wake text>"`; the general mailbox uses the profile's "Agent
  Peers" chat. It runs only for profiles listed in
  `~/.agent-peers-hermes/chat-wake/enabled`. **As of 2026-11-02 that file does
  not exist on the Studio, so the driver is built but switched off; today only
  chats open in Hermes Desktop are woken, by the plugin.** State is one JSON
  ledger per chat under `chat-wake/<profile>/`. The `~/.agent-peers-hermes/disabled`
  flag stops the plugin but not this driver; removing a profile from `enabled`
  does. Ledger states: `launched`, `running`, `done`,
  `waiting_desktop` (the chat is open in Desktop or a terminal), `waiting_turn`
  (another executor holds Hermes's turn lease), `waiting_gateway`, `cooldown`,
  `input_required`, `exhausted`, `cancelled`, `not_found`, `no_profile`, and
  `desktop_unknown`. `done` means the wake's turn completed (or its gateway
  admission reached a terminal state). It does not mean the mail was read: mail
  up to the id that wake covered is not woken again, and only newer mail starts a
  new wake. A failed launch retries on a 5 min / 30 min / 2 h ladder, then parks as
  `exhausted`.
- *Desktop plugin* (`hermes-plugins/agent-peers-desktop-wake`). For a chat open
  in a Desktop backend it queues the wake in the open chat through Hermes's
  `ctx.inject_message`: an idle chat starts a turn, a busy chat only queues. It
  shares the driver's ledger and writes a `desktop_attempt` (`intent`, then
  `accepted` or `unknown`) around the call. While an attempt is open, neither
  executor wakes that chat. An attempt settles only on positive, correlated
  turn evidence: `ended` means the wake's own turn ended, which Hermes also
  reports for failed turns, so it is *not* proof the mail was handled. Anything
  uncertain or unreadable is `unknown`, and **`unknown` blocks every re-wake of
  that chat until an operator runs** `bun cli.ts hermes-desktop-clear <profile>
  <chat-key> [--handled]`. It never wakes the general mailbox. Details:
  [components/hermes-desktop-wake.md](components/hermes-desktop-wake.md).

### Factory Droid (`droid-server.ts` → shared durable transport)

- A wakeable Droid is a managed session launched through `droidpeer`: native
  terminal chat by default, ACP with `--headless` or redirected IO. A pre-existing
  unmanaged Droid TUI is not wakeable.
- The MCP child writes the authoritative inbox to
  `~/.agent-peers-droid/<peer-uuid>.json`. Adjacent metadata contains only
  sender/message identifiers and timestamps, never message text or lease tokens.
- The long-lived host watches the exact peer bound through its private launch
  claim. When idle mail arrives, it starts a turn with a bodyless prompt directing
  Droid to call `check_messages`. Mail arriving during a turn queues until the
  outstanding turn completes. Native queued human input also defers wake.
- If the same unread set remains after a completed turn, the host retries on a
  bounded 5-minute/30-minute/2-hour schedule. New mail wakes immediately.
- Canceling a native peer turn suppresses retries for unchanged unread mail;
  it does not acknowledge mail. Native permissions remain under user control.
- Turn completion does not acknowledge broker mail. The shared delivery state
  still confirms and acks a presented message only on Droid's next agent-peers
  tool call, preserving the universal at-least-once contract.

### OpenClaw (`openclaw-server.ts` → codex transport)

Full design, evidence and runbook: [components/openclaw-peer.md](components/openclaw-peer.md).

- **Main session only.** OpenClaw starts one MCP child per session thread of an
  agent, and a child cannot tell which session it serves. So no child registers
  at startup. A child takes the peer identity only on a tool call proven to come
  from `agent:<id>:main`: the call carries Codex's `_meta.threadId`, and that
  thread is either the recorded binding or presents a newer one-time wake token.
  Every other child answers each tool with an explanation and never polls or
  draws mail. A call with no thread id is refused. The mailbox and its
  confirm-on-next-call behave as for Codex; waits cap at 60s.
- **Wake.** When the agent is listed in `~/.agent-peers-openclaw/wake/enabled`,
  the wake daemon submits one `chat.send` to `agent:<id>:main` with
  `queueMode: "followup"` and `deliver: false`. An idle session starts a turn; a
  busy one queues the wake behind the active run, never steering or interrupting
  it. The text is bodyless and carries a token the agent passes to
  `check_messages` (`wake`).
- **Custody ledger.** Each submission is written (`intent`) and fsynced before
  `chat.send`. States: `intent`, `accepted`, `unknown`, `consumed`, `cancelled`,
  `cleared`. While any submission is `intent`, `accepted` or `unknown`, nothing
  new is submitted, not on timeout and not on new mail. Outcomes come only from
  OpenClaw's acknowledgement or its input receipts for that exact submission.
  `consumed` means OpenClaw shows the wake input became a turn. It does not mean
  the agent read the mail; the broker row is acked only by the agent's own
  `check_messages` and the next call.
- **Fail closed.** `unknown` is never resubmitted or cleared automatically. It
  settles on its own when receipts appear, and otherwise waits for an operator
  (`bun cli.ts openclaw clear <agent> <id>`). `openclaw rearm <agent> <id>`
  allows exactly one more wake for the same unread set. If OpenClaw reports an
  interrupted active run, wakes halt until `openclaw clear <agent> halt`. A mail
  set is woken at most once.
- **Kill switch.** `~/.agent-peers-openclaw/disabled` makes loaded children
  refuse on their next call and stops passes and binds. Mail stays unacked.
- **Known gap.** After an idle unload, outbound mail from main is unavailable
  until a newer token proves the new thread. Inbound healing by a wake has not
  yet been demonstrated.

## Receipts and recovery

- `list_peers` + broker `messages` table answer "queued for whom"; the
  recipient's inbox file answers "persisted"; typed ack outcomes answer
  "confirmed". For a remote send, the sender's outbox (`federation_outbox`)
  answers "queued here, not yet at the destination".
- Observability CLI: `bun cli.ts inboxes [--stranded]` (unread mail matched to
  live/dead broker rows), `stranded-messages` (unacked to peers idle >24h),
  `gc-inboxes [--min-age-days N]` (dry-run by default; add `--apply` to archive
  dead inbox files by timestamped rename — never deletes; default 7d mtime gate
  announces skips). Wake state: `wake-status`, the Hermes ledgers under
  `~/.agent-peers-hermes/chat-wake/`, and `bun cli.ts openclaw status <agent>`.
- On re-registration, `prev_id` re-points unacked mail to the new incarnation
  only when the old row is gone; a live row is never robbed.
- Broker restarts stamp a new `BROKER_EPOCH` (returned on register/heartbeat)
  so clients can tell "broker restarted" from "I was evicted".
