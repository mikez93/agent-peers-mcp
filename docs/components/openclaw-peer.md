# OpenClaw peer (bd-b2in.17)

Status, 2026-11-02: released and live on all four brokers (MacBook, Studio,
Omarchy, Hetzner; accepted baseline dd1fb2e, Marco AP10949). Alexander's
EXISTING OpenClaw agent `claude` on Hetzner is adopted as peer
`alex-openclaw-hetzner` through the `mcp.servers` entry `agent-peers-claude`,
with wake-on-mail ON for `claude` only (Marco AP10851/AP10944, accepted
AP10947). No agent was created; his id, persona, workspace, main history and
Telegram channels are unchanged. Still open: crash, lost-response and
compaction recovery, and the outbound gap after an idle unload (below).

Goal: Alexander's existing agent as a real Agent Peers member, with its own
`openclaw` peer type and wake-on-mail into its main session, without changing
his channels, the gateway's global settings, or the websites on the box.

## Pieces

| Piece | File | What it does |
| --- | --- | --- |
| Peer type | `shared/types.ts`, `shared/federation.ts`, `shared/state-dir.ts`, `codex-server.ts`, `claude-server.ts`, `cli.ts` | Adds `openclaw` everywhere a type is listed. State root `~/.agent-peers-openclaw` (or `AGENT_PEERS_STATE_DIR` / `AGENT_PEERS_OPENCLAW_STATE_DIR`), no fallback to the Codex inbox. |
| Broker migration | `broker.ts` `migrate_peers_add_openclaw_peer_type` | Runs last. Rebuilds `peers` from its own stored `CREATE TABLE` text with only the CHECK list changed, copies rows by the live column list, verifies the row count, recreates the indexes that existed. Idempotent. |
| Unread lookup | `broker.ts` `peerInbox`, `POST /peer-inbox` | Unacked message ids per openclaw peer and per bound peer id (even after the broker deleted a quiet row; unacked mail outlives it), so the wake pass sees mail while no child is alive. Capability `peer-inbox`. |
| MCP server | `openclaw-server.ts` | Sets `AGENT_PEERS_RUNTIME=openclaw` and loads `codex-server.ts`. Kill switch: `~/.agent-peers-openclaw/disabled`, read at startup and again on every tool call and background poll or heartbeat tick of a loaded child, so a bound child stops serving at once. Mail stays unacked and unleased in the broker. |
| Mailbox binding | `shared/openclaw-gate.ts` | Decides on every `tools/call` whether this child runs `agent:<id>:main`. See below. |
| Custody ledger | `shared/openclaw-state.ts` | Fsynced JSON ledger of every submission, binding file, enable file, lock. |
| Gateway calls | `shared/openclaw-gateway.ts` | `sessions.describe`, `chat.send`, `chat.history` through `openclaw gateway call`, Node 24 first on PATH. Refused outright when `OPENCLAW_SHELL` is set: OpenClaw refuses message RPCs from an agent's exec shell to keep attribution (`cli/gateway/query.md:427-429`, `concepts/session-tool.md:296-303`). The daemon and CLI run as external supervisors; the marker is never stripped. |
| Wake pass | `shared/openclaw-wake-pass.ts`, `wake-daemon.ts` | Runs inside the existing wake daemon after the Codex and Hermes passes. Off until the agent id is in `wake/enabled`. |
| Operator CLI | `cli.ts openclaw status|bind|clear|rearm` | Bind the main session, inspect, record operator decisions. `status` reconciles open submissions from custody (read-only Gateway calls) and names a held or dead lock. `bind` reconciles before refusing. |
| Federation | `shared/federation.ts` `relay` | An HTTP 400 `invalid federation envelope` (the destination parsed the envelope and refused it, as an old broker does for an unknown peer type) is now an explicit bounce notice to the sender instead of an endless retry. A 400 `invalid federation payload` (slow or cut upload) still retries. |

## Mailbox binding (Marco #3)

OpenClaw scopes `mcp.servers.<name>.codex.agents` per agent, but the Codex
harness starts one stdio child per session thread, and a child gets no session
in its environment (only `OPENCLAW_SHELL` exists, and only for exec/TUI/ACP).
First-child-wins would let any other session of the agent capture or strand
main's mail. So:

1. No child registers at startup. Tools are listed (the thread starts), but no
   broker connection, poll, heartbeat or inbox file exists yet.
2. Every submission the daemon or CLI makes is one `chat.send` to exactly
   `agent:<id>:main` carrying a one-time token. Only main's input contains it;
   the ledger stores only its SHA-256.
3. Codex stamps the calling thread on every MCP `tools/call` as
   `_meta.threadId` (relied on already by `shared/codex-desktop-wake.ts`). A
   `check_messages` call that presents a live token therefore came from main's
   thread, and that thread id is written to `bindings/<id>.json`.
4. Afterwards a call is main iff its `_meta.threadId` equals the binding. Main's
   child takes a pid name claim (one live owner), registers the durable name
   from `PEER_NAME`, and serves mail normally.
5. A token moves the binding only if its submission is strictly newer than the
   one that proved the current binding (a reset or new Codex thread). An old
   token re-read in an old thread cannot pull it back. The old owner sees the
   move within 5 s and exits, so the new thread's child reclaims the same peer
   row (same UUID, same mailbox). If the old row still looks live (its pid is
   not reaped yet, or its last heartbeat is under the broker's 60 s reclaim
   cutoff), the new child drops the suffixed row the broker offers and retries
   for up to 90 s rather than keep a second identity.
6. Every other child (another operator-created session, an unrestricted cron
   session) answers every tool with an explanation and never registers, polls
   or draws mail. A call with no `_meta.threadId` is refused outright.
7. Policy-restricted turns, default sub-agent children and message-only source
   replies load no MCP servers at all (OpenClaw docs, below), so they have no
   child to misbehave.

Residual risk: a model in main that passes the token to an unrestricted
sub-agent, which presents it first, would bind that sub-agent's thread. The
wake text says to call `check_messages` yourself in this session; the default
sub-agent posture is restricted and loads no MCP.

### After an idle unload

OpenClaw unloads an idle main thread's MCP runtime (observed about 30 minutes
after the last turn on 2026-11-02; not a guaranteed TTL). The next turn in
`agent:<id>:main` runs on a NEW Codex thread whose replayed history still holds
the old token. The gate refuses that thread as secondary (step 5) until a newer
token proves it. On 2026-11-02 that was an explicit operator `bind`
(f093a925). A fresh inbound wake also carries a newer token and is designed to
re-prove the new thread when the normal admission and binding conditions hold,
but healing by an inbound wake after a real unload has not yet been
demonstrated. Until a newer token proves the thread, **outbound Agent Peers
from main is unavailable**: Alex cannot start a conversation on his own. Old
tokens are never accepted, and nothing in OpenClaw is changed for this.

## Wake and custody (Marco #1, #2, #5)

Per enabled agent, each daemon tick (every 5 s on Hetzner):

1. Any `intent` left from a crash becomes `unknown`.
2. If a submission is open (`accepted`/`unknown`), reconcile at most every
   15 s: `sessions.describe` for the current `sessionId`; if it differs from the
   one recorded at submission, the custody can no longer be read and the
   submission stays or becomes `unknown`. Otherwise `chat.history` with
   `inputRunIds` returns receipts: `consumed` → consumed (terminal),
   `pending`+`cancelled` → cancelled (terminal), `pending` → accepted (waiting),
   absent → unknown for an acknowledged submission, unchanged for an unknown one.
   Custody keys on the exact submission key, not on a run id. OpenClaw only
   keeps a queue row while an input waits, and deletes it on completion. An
   input that starts at once on an idle session never gets one. A followup that
   queued behind an active run is drained later under a run id OpenClaw
   generates itself. In both cases the transcript user event keeps
   `idempotencyKey: "<key>:user"`, so receipts are merged with an exact match on
   that key (last 200 messages, 2 MB; a run id must be present but need not
   equal the key). Native pending and cancelled receipts take precedence.
3. While anything is open, nothing new is submitted: not on timeout, not on new
   mail. An `unknown` in the same session is re-read on every reconcile and
   settles to consumed or cancelled as soon as custody evidence appears. An
   idle-started input read too early (its user event is not written yet) shows
   `unknown` once and then `consumed`; re-run `status`, do not clear it. Only a
   submission that never shows evidence, or whose session changed, stays
   `unknown` until an operator decides with `bun cli.ts openclaw clear <agent> <id>`.
   Nothing clears or replays on its own.
4. Otherwise, with a binding and unread mail: one wake per unread set
   (signature = sorted unread ids). If that wake ran but the turn never read
   the mail, `bun cli.ts openclaw rearm <agent> <id>` allows exactly one more
   wake for the same set; the daemon never re-arms on its own. Nothing is submitted if `agent:<id>:main`
   does not exist; the session is never created.
5. Submit: write the intent with its idempotencyKey and the observed sessionId,
   fsync, then `chat.send` with `queueMode: "followup"`, `deliver: false`. The
   ack is accepted only if the ack's `runId` equals our key and `status` is
   `started` (or a cached `accepted`/`in_flight`/`ok`). Anything else, including a
   timeout, is `unknown`. The ack's run id is not the custody proof; step 2 is.
6. If OpenClaw ever reports `interruptedActiveRun` for a followup, the agent's
   wakes halt until `bun cli.ts openclaw clear <agent> halt`.
7. The opt-in (`wake/enabled`) and the kill switch (`disabled`) are re-read
   after every await: on taking the lock, after the inbox read, after
   `sessions.describe` (before the intent is written), and once more after the
   intent is fsynced (then the intent is withdrawn as `cancelled`, since
   nothing was sent). Flipping either mid-pass submits nothing new. It never
   cancels work OpenClaw already admitted.
8. The ledger lock (`wake/<agent>.lock`) fails closed. It only ever appears
   complete (a temp file `link()`ed into place), acquire never reaps it even
   when its holder is dead, and release removes it only while it still carries
   the owner's token. This is the same rule as the Hermes Desktop lock (2d47fe1,
   Marco AP10817/AP10842): a reaper racing a fresh owner can leave two holders
   and two submissions. A crashed holder blocks only its agent, and status names it.

### Clearing a dead lock

Do this only when `bun cli.ts openclaw status <agent>` (run from
`/home/openclaw/agent-peers-mcp`) reports `held by dead pid <pid>`. Every
ledger writer must have finished and stay quiet while you remove the lock. A
fixed delay proves nothing.

1. Record whether the kill switch is already engaged
   (`~/.agent-peers-openclaw/disabled`, or `<AGENT_PEERS_STATE_DIR>/disabled`).
   Recovery restores exactly that state.
2. If it is not engaged, engage it: `touch ~/.agent-peers-openclaw/disabled`.
   Wake passes that start afterwards and `bind` then do nothing.
3. Confirm every writer is quiet:
   - the wake pass: on Hetzner `agent-peers-wake.service` runs
     `codex-peer daemon 5`, a loop that starts `bun wake-daemon.ts` for each
     pass. A pass that started before the switch may still be working, so
     confirm no `wake-daemon.ts` process (`pgrep -af wake-daemon.ts`) started
     before the switch is still running;
   - operator writers: `status`, `clear`, `rearm` and `bind` take the same lock
     and wait up to 10 seconds for it, so a call already waiting can outlive a
     daemon tick. Confirm no `cli.ts openclaw` process is running
     (`pgrep -af "cli.ts openclaw"`), and make sure no shell or agent session,
     yours or another lane's, starts one until step 6.
4. Confirm the holder is dead: `ps -p <pid>` prints no process (or one whose
   start time is after the lock's `at`).
5. Remove `~/.agent-peers-openclaw/wake/<agent>.lock`.
6. Restore the kill switch to the state recorded in step 1: remove the
   `disabled` file only if it was absent before you started.

There is no idle check before sending. `followup` makes the Gateway admit the
input atomically: an idle session starts a turn, a busy one keeps it queued
behind the active run, without steering into it. The global
`messages.queue.mode` (steer on Hetzner) is never read or changed.

Disabling future wakes (remove the line from `wake/enabled`) does not cancel
admitted work; that stays in OpenClaw's custody and runs. Cancelling it is an
OpenClaw operator action (`chat.abort` with its `runId`), never automated here.
`clear` only records that an operator settled it; it cancels nothing.

## Verified OpenClaw facts (installed 2026.10.5, Hetzner, read-only)

Schemas are closed TypeBox objects in `~/.npm-global/lib/node_modules/openclaw/dist`:

- `sessions-C1mmMImW.mjs:2425-2459` `ChatSendParamsSchema`: `sessionKey`
  (required), `agentId?`, `sessionId?`, `message` (required), `queueMode?`
  enum `steer|followup|collect|interrupt` (`QUEUE_MODES`, :2393),
  `deliver?: boolean`, `timeoutMs?`, `idempotencyKey` (required), and other
  optional fields we do not send. Extra fields are rejected.
- `chat-send-handler-o4Nr7Ej0.mjs:4271` `clientRunId = p.idempotencyKey`: the
  key is the runId. Ack at :6134-6140 `{ runId, status: "started",
  messageSeq?, interruptedActiveRun? }`. A resend of the same key while in
  memory returns `in_flight` (:3815-3817) or `ok` (:4105-4107). External
  delivery happens only for `deliver === true` (:2375, `explicitDeliverRoute`).
  `queueMode` is a per-request override (:2830 `queueModeOverride`).
- `sessions-C1mmMImW.mjs:2889` `SessionsDescribeParamsSchema` `{ key, agentId?,
  ... }`; the result is `{ session }`. A live read of Alexander's main session
  (key names only) showed `sessionId`, `isMain`, `hasActiveRun`, `activeRunIds`,
  `effectiveQueueMode`; **no Codex thread id is exposed**.
- `sessions-C1mmMImW.mjs:2164` `ChatHistoryParamsSchema` with `inputRunIds`
  (1-50 ids); `:2225` `ChatInputReceiptsSchema` `pending` (`queued?`,
  `cancelled?`) or `consumed` (`consumedByEventId`).
  `chat-history-handler-BPX4wj3J.mjs:701-714` returns receipts only for the
  session's current `sessionId`; `sessionId` cannot be passed without
  `messageId`. `session-accessor.sqlite-pending-input-receipts-BTn9k2Yx.mjs`
  reads table `session_pending_inputs` by `(session_key, session_id, run_id)`
  and is commented "these durable correlations never authorize replay".

Installed docs (mirror docs.openclaw.ai):

- `concepts/queue.md:29-47`: default mode `steer`; `followup` "do not steer.
  Enqueue each message for a later agent turn after the current run ends".
- `concepts/queue.md:177-192`: `chat.send` input is stored before the ack; a
  Gateway stop before transcript leaves "interrupted input" that "requires an
  explicit resend. The in-memory queue is not replayed."
- `gateway/protocol/rpc-session-control.md:50` `sessions.send` has no queue
  override (so it would steer into a busy main); `:53` `sessions.steer` is
  `chat.send` with `interrupt`; `:67` per-request `queueMode`; `:69` "started"
  does not establish a transcript row; reconcile by submission identity,
  "never a predicted position or matching content".
- `cli/gateway/query.md:412-420`: `gateway call sessions.send/chat.send`; a
  `started` response confirms acceptance, not a reply.
- `web/control-ui/chat.md:423`: same `idempotencyKey` returns `in_flight`/`ok`.
- `plugins/codex-harness-reference/restricted-turns.md:54-58`: restricted turns
  disable configured MCP servers and use a transient Codex thread.
- `gateway/config-extensions.md:51-54, 88-97`: `codex.agents` scopes a server
  to agent ids. `openclaw mcp reload` "Dispose cached MCP runtimes so new
  config is used on the next turn" (CLI help), so no Gateway restart is needed.
- CLI help: `openclaw mcp add` probes unless `--no-probe` and cannot set
  `codex.agents`; `openclaw mcp set <name> <json>` takes the full object;
  `openclaw agents add [name] --workspace <dir> --non-interactive` with no
  `--bind` creates a channel-unbound agent.

## Verified here versus assumed

| Claim | Status |
| --- | --- |
| `chat.send` params, `queueMode`, `deliver`, ack shapes; the ack's `runId` equals our idempotencyKey | Verified in installed source and live. The ack's run id is not the custody proof: a followup drained after a busy run executes under a run id OpenClaw generates itself (Wake and custody, step 2). |
| Main's `broker.ts` (1b6254b) opens a migrated DB holding an openclaw row and its mail | Verified once here by running main's `initDb` and `pollMessages` on it |
| `chat.history inputReceipts` semantics and sessionId scope | Verified in installed source and live. Queue receipts exist only while an input waits (last row). |
| `followup` queues behind a busy run without steering | **Verified live** (Hetzner, 2026-11-02): busy wakes 019b1c56 and cfe0584e each showed "queued behind the active run"; the running synthetic turns finished whole (1000/1000 lines and their end markers); each wake ran once, afterwards. |
| `deliver:false` suppresses OpenClaw's automatic delivery of the turn's reply to the session's channel | Verified in source and live: no Telegram delivery from any test turn. It does NOT stop the agent from calling an external messaging tool itself, so probe and wake texts forbid external sends, and the test turns' tool lists were checked (agent-peers tools and exec only, no Telegram sends). |
| OpenClaw's bundled Codex 0.160.0 stamps `_meta.threadId` on MCP `tools/call` | **Verified live**: calls from a throwaway explicit session and from main threads 01a199fe and 01a19a43 carried it. |
| `mcp.servers` with `codex.agents` reaches the agent's Codex threads on this box | **Verified live**: `agent-peers-claude` (`codex.agents: ["claude"]`) reaches Alex's Codex threads, one child per thread; children of other sessions refuse and register nothing. |
| One child per session thread; main's thread id stable across unload/compaction | **False across an idle unload** (Hetzner, 2026-11-02): main's bound child exited about 30 minutes after its last turn, and the next turn ran on a NEW Codex thread (01a199fe → 01a19a43) whose replayed history still holds the old token. The gate refused it as secondary, as designed. An explicit operator bind (f093a925), newer than the binding's proof, moved the binding, and that same child took the identity. A fresh wake token is designed to do the same, but that has not been demonstrated after a real unload. Compaction is untested. |
| A dead MCP child is relaunched for main's thread on its next turn (winner death, step-down, registration failure) | **Verified for idle unload** (Hetzner, 2026-11-02): the next main turn started a new child (pid 1065526), which served once a newer token proved main. Winner death and step-down are still untested live. |
| `session_pending_inputs` rows outlive consumption long enough to read | **False** (Hetzner, 2026-11-02). A `chat.send` that starts at once on an idle session never gets a row; a followup that queued behind an active run has one only while it waits, and it is deleted on completion. `inputReceipts()` therefore also accepts the transcript user event whose `idempotencyKey` is exactly `<key>:user`, with a non-empty event id and a run id present, which may be OpenClaw's own drain run id (last 200 messages, 2 MB). Native pending and cancelled receipts take precedence. Missing evidence leaves the submission `unknown`, which is re-read on every reconcile and settles when evidence appears; an operator clear is needed only when none ever appears or the session changed. |

## Adoption record (2026-11-02)

The former blockers, as settled on Hetzner:

1. `_meta.threadId`: a `tools/call` from Alex's sessions carries it. A
   throwaway explicit session proved it and registered no peer.
2. Projection: `agent-peers-claude` (`codex.agents: ["claude"]`) reaches his
   Codex threads, one child per thread. Children of other sessions refuse and
   register nothing.
3. All four brokers run this code (dd1fb2e at closeout).
4. Mike's decisions: the existing agent `claude`, peer `alex-openclaw-hetzner`,
   persona unchanged. No new agent.
5. Code uptake needs no Gateway restart: wake passes are fresh processes, and a
   child loads at thread start.

Live acceptance under Marco AP10851/AP10944:
- Bind custody: d6feefea; after an idle unload, re-bind f093a925 → event 44bc3433
  on thread 01a19a43.
- Kill switch on the same loaded child: refused and inert, then served again
  on release.
- Idle wake 07df4972 → 202fb5c4.
- Busy wakes 019b1c56 → 8f211df1 (settled after 55a4293) and cfe0584e → ca353f12.
  Each queued behind the active run without interrupting it, with one
  submission, a substantive reply and no Telegram delivery.

Not yet proven: lost response, daemon or Gateway restart mid-submission, and
compaction.

## Operating runbook

Run as `openclaw@hetzner-box-01` from the checkout, since every `bun cli.ts`
command below is relative to it: `cd /home/openclaw/agent-peers-mcp`. Every
`openclaw` command needs Node 24 first:
`export PATH=$HOME/.local/node/node-v24.22.1-linux-x64/bin:$HOME/.npm-global/bin:$PATH`.
For Alex, `<id>` is `claude` and `<name>` is `alex-openclaw-hetzner`.

1. Inspect: `bun cli.ts openclaw status <id>` (binding
   thread, submissions, wakes on or off), `bun cli.ts peers`, and
   `~/.agent-peers-openclaw/{wake/enabled,disabled}`.
2. Wiring (already in place for Alex; change only this entry, and take a 0600
   backup of the config first):
   ```
   openclaw mcp set agent-peers-<id> '{"command":"/home/openclaw/.bun/bin/bun",
     "args":["/home/openclaw/agent-peers-mcp/openclaw-server.ts"],
     "env":{"AGENT_PEERS_ENABLED":"1","AGENT_PEERS_OPENCLAW_AGENT":"<id>","PEER_NAME":"<name>",
            "AGENT_PEERS_DISABLE_TAB_TITLE":"1","AGENT_PEERS_AUTO_SUMMARY":"0"},
     "codex":{"agents":["<id>"],"defaultToolsApprovalMode":"approve"}}'
   openclaw mcp reload
   ```
   (`mcp add --no-probe` cannot set `codex.agents`; `mcp set` does not probe.)
3. Bind or re-bind: `bun cli.ts openclaw bind <id>`, then `status` until the
   submission is `consumed` and the binding shows a thread and a peer. One early
   `unknown` is normal for an idle start (see Wake and custody, step 3). Re-bind when the gate refuses main as secondary after an idle unload and
   outbound is needed.
4. Wakes: on with `echo <id> >> ~/.agent-peers-openclaw/wake/enabled`; off with
   `sed -i '/^<id>$/d' ~/.agent-peers-openclaw/wake/enabled`. Turn them off and
   keep the evidence on any unknown, failed or halted custody.
5. Control turns for tests: one `chat.send` to `agent:<id>:main` with
   `queueMode: "followup"`, `deliver: false` and a recorded idempotencyKey.
   Forbid external sends in the text. OpenClaw's Codex harness calls MCP tools
   only through its `exec` code tool, so allow exec "only as the means of
   invoking that one tool". Banning exec blocks the tool under test.
6. Checks: idle wake (`submitted`, then `consumed`, then a reply); busy wake
   (send while `hasActiveRun`; expect "queued behind the active run", the
   running turn completes untouched, then the wake runs and its custody settles
   to the drained user event); no Telegram delivery (the wake turn uses only
   agent-peers tools and exec).
7. Name, persona and standing instructions are Mike's and stay unchanged.

## Rollback

Disables only this wiring; keeps all state and new-type obligations. Never
restore an old checkout or an old broker DB (the `openclaw` CHECK and any
openclaw rows must stay readable).

1. Stop future wakes: remove `<id>` from `~/.agent-peers-openclaw/wake/enabled`.
   Admitted work still runs.
2. Make every child inert at once: `touch ~/.agent-peers-openclaw/disabled`.
   Loaded children stop serving on their next call or tick; passes and `bind`
   submit nothing. Nothing is cancelled and no mail is acked.
3. Remove the OpenClaw wiring: `openclaw mcp unset agent-peers-<id>` and
   `openclaw mcp reload`. The agent can stay.
4. Leave the ledger, binding, broker row and mail in place; mail stays queued
   and is delivered if the wiring returns.
