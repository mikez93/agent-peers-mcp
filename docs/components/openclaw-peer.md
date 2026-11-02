# OpenClaw peer (bd-b2in.17)

Status, 2026-11-01: code and tests on branch `next-openclaw` only. Not merged,
not deployed, no OpenClaw agent created, no `mcp.servers` entry, no wake enabled.
Marco's GO (AP10809) covered isolated implementation and tests. **Adoption is
blocked** on the live checks in "Adoption blockers" below; the runbook at the
end is a draft and is **NOT AUTHORIZED** to run.

Goal: one dedicated, channel-unbound OpenClaw agent on Hetzner as a real Agent
Peers member, with its own `openclaw` peer type and wake-on-mail into its main
session, without touching Alexander's Telegram-bound agent (`claude`), the
gateway's global settings, or the websites on the box.

## Pieces

| Piece | File | What it does |
| --- | --- | --- |
| Peer type | `shared/types.ts`, `shared/federation.ts`, `shared/state-dir.ts`, `codex-server.ts`, `claude-server.ts`, `cli.ts` | Adds `openclaw` everywhere a type is listed. State root `~/.agent-peers-openclaw` (or `AGENT_PEERS_STATE_DIR` / `AGENT_PEERS_OPENCLAW_STATE_DIR`), no fallback to the Codex inbox. |
| Broker migration | `broker.ts` `migrate_peers_add_openclaw_peer_type` | Runs last. Rebuilds `peers` from its own stored `CREATE TABLE` text with only the CHECK list changed, copies rows by the live column list, verifies the row count, recreates the indexes that existed. Idempotent. |
| Unread lookup | `broker.ts` `peerInbox`, `POST /peer-inbox` | Unacked message ids per openclaw peer and per bound peer id (even after the broker deleted a quiet row; unacked mail outlives it), so the wake pass sees mail while no child is alive. Capability `peer-inbox`. |
| MCP server | `openclaw-server.ts` | Sets `AGENT_PEERS_RUNTIME=openclaw` and loads `codex-server.ts`. Kill switch: `~/.agent-peers-openclaw/disabled`. |
| Mailbox binding | `shared/openclaw-gate.ts` | Decides on every `tools/call` whether this child runs `agent:<id>:main`. See below. |
| Custody ledger | `shared/openclaw-state.ts` | Fsynced JSON ledger of every submission, binding file, enable file, lock. |
| Gateway calls | `shared/openclaw-gateway.ts` | `sessions.describe`, `chat.send`, `chat.history` through `openclaw gateway call`, Node 24 first on PATH. |
| Wake pass | `shared/openclaw-wake-pass.ts`, `wake-daemon.ts` | Runs inside the existing wake daemon after the Codex and Hermes passes. Off until the agent id is in `wake/enabled`. |
| Operator CLI | `cli.ts openclaw status|bind|clear|rearm` | Bind the main session, inspect, record operator decisions. |
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
3. While anything is open, nothing new is submitted: not on timeout, not on new
   mail. An `unknown` stays until `bun cli.ts openclaw clear <agent> <id>`.
4. Otherwise, with a binding and unread mail: one wake per unread set
   (signature = sorted unread ids). If that wake ran but the turn never read
   the mail, `bun cli.ts openclaw rearm <agent> <id>` allows exactly one more
   wake for the same set; the daemon never re-arms on its own. Nothing is submitted if `agent:<id>:main`
   does not exist; the session is never created.
5. Submit: write the intent with its idempotencyKey and the observed sessionId,
   fsync, then `chat.send` with `queueMode: "followup"`, `deliver: false`. The
   ack is accepted only if `runId` equals our key and `status` is `started`
   (or a cached `accepted`/`in_flight`/`ok`). Anything else, including a
   timeout, is `unknown`.
6. If OpenClaw ever reports `interruptedActiveRun` for a followup, the agent's
   wakes halt until `bun cli.ts openclaw clear <agent> halt`.

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
| `chat.send` params, `queueMode`, `deliver`, `idempotencyKey`=runId, ack shapes | Verified in installed source |
| Main's `broker.ts` (1b6254b) opens a migrated DB holding an openclaw row and its mail | Verified once here by running main's `initDb` and `pollMessages` on it |
| `chat.history inputReceipts` semantics and sessionId scope | Verified in installed source |
| `followup` queues behind a busy run without steering | Documented; busy behavior tested only against a fake Gateway |
| `deliver:false` produces no channel delivery | Verified in source; live check pending |
| OpenClaw's bundled Codex 0.160.0 stamps `_meta.threadId` on MCP `tools/call` | **Assumed** (true for Codex CLI/Desktop in this repo); not visible in binary strings |
| `mcp.servers` with `codex.agents` reaches the agent's Codex threads on this box | Documented, issue openclaw/openclaw#80814 fixed; **not proven live** |
| One child per session thread; main's thread id stable across unload/compaction | Assumed from docs; the design tolerates a new thread only via a newer token |
| A dead MCP child is relaunched for main's thread on its next turn (winner death, step-down, registration failure) | Assumed; tested only with a test harness spawning the new child; if OpenClaw does not, the expected recovery is `openclaw mcp reload` (also unverified) |
| `session_pending_inputs` rows outlive consumption long enough to read | Assumed; if a row vanishes first the submission goes `unknown` (safe, needs a clear) |

## Adoption blockers

1. Live proof that a `tools/call` from the dedicated agent's main session
   carries `_meta.threadId`. Without it every call is refused and nothing can
   bind; that failure is loud and safe, but adoption cannot proceed. If Codex
   0.160.0 does not stamp it, binding is unprovable with what OpenClaw exposes
   (no session key reaches the child, `sessions.describe` has no thread id,
   `/codex binding` is an in-conversation command) and adoption stays blocked.
2. Live proof that the `mcp.servers` entry projects into that agent's Codex
   threads, and how many children appear per session.
3. All four brokers (MacBook, Studio, Omarchy, Hetzner) on this code before any
   openclaw peer sends or appears: an old broker rejects an openclaw sender's
   envelope (now an explicit bounce on new senders) and hides the peer from lists.
4. Mike's decisions: agent id, peer name (default `openclaw-hetzner`), persona.
5. A quiet window agreed with Marco for the Gateway-restart acceptance step,
   since it also restarts Alexander's agent.

## Runtime runbook (DRAFT, NOT AUTHORIZED)

Run as `openclaw@hetzner-box-01`. Every `openclaw` command needs Node 24 first:
`export PATH=$HOME/.local/node/node-v24.22.1-linux-x64/bin:$HOME/.npm-global/bin:$PATH`.
`<id>` is the new agent id; `<name>` the peer name.

0. Preconditions: Marco and Mike approve; this branch merged and released to
   all four brokers; `bun ~/agent-peers-mcp/cli.ts status` on each shows the
   new broker; `openclaw agents list` shows `claude` unchanged.
1. Agent: `openclaw agents add <id> --workspace ~/.openclaw/workspace-<id> --non-interactive`
   (no `--bind`). Confirm with `openclaw agents list` that it has no bindings
   and `claude` still has its Telegram binding.
2. MCP entry, scoped to that agent only:
   ```
   openclaw mcp set agent-peers-<id> '{"command":"/home/openclaw/.bun/bin/bun",
     "args":["/home/openclaw/agent-peers-mcp/openclaw-server.ts"],
     "env":{"AGENT_PEERS_ENABLED":"1","AGENT_PEERS_OPENCLAW_AGENT":"<id>","PEER_NAME":"<name>",
            "AGENT_PEERS_DISABLE_TAB_TITLE":"1","AGENT_PEERS_AUTO_SUMMARY":"0"},
     "codex":{"agents":["<id>"],"defaultToolsApprovalMode":"approve"}}'
   openclaw mcp reload
   ```
   (`mcp add --no-probe` cannot set `codex.agents`; `mcp set` does not probe.)
3. Static check, then probe: `openclaw mcp doctor agent-peers-<id>`, then
   `openclaw mcp doctor agent-peers-<id> --probe`. A probe child takes no
   identity (it never makes a thread-stamped `tools/call`); confirm with
   `bun cli.ts peers` that no openclaw peer appeared.
4. Create main and see the tools: `openclaw agent --agent <id> --session-key agent:<id>:main --message "List your agent-peers tools. Do not call them." --json`
   (`--deliver` defaults to false).
5. Bind: `bun ~/agent-peers-mcp/cli.ts openclaw bind <id>`, then
   `bun cli.ts openclaw status <id>` until the submission is `consumed` and the
   binding shows a thread and a peer, and `bun cli.ts peers` shows exactly one
   `openclaw` peer `<name>`. **Blocker 1 is settled here**: if the bind is
   consumed but the binding never appears, check the child's stderr for the
   `_meta.threadId` refusal and stop.
6. Acceptance, wakes still off:
   - same exact agent/session: `sessions.describe` for `agent:<id>:main` shows the
     sessionId recorded on the bind; the binding's thread did not change;
   - from the MacBook and from Hetzner, send `<name>@hetzner` (the host in
     `~/.agent-peers-host`) a question
     that needs a substantive answer; prompt main with step 4's command
     ("check your agent-peers messages"); both senders get substantive replies;
   - Alexander's Telegram chats receive nothing (check `claude` sessions and
     `sessions.describe` on `agent:<id>:main` shows no channel delivery context).
7. Wakes on: `echo <id> >> ~/.agent-peers-openclaw/wake/enabled`. Then:
   - idle: send mail, see `openclaw: submitted` then `consumed` in the wake log
     and a reply;
   - busy: start a long turn in main (step 4 with a long task), send mail while
     `hasActiveRun` is true; the wake is `accepted` with "queued behind the
     active run", the running turn is not interrupted or steered, and the wake
     runs after it;
   - lost response and restart (quiet window only): stop the wake daemon mid-
     submission, or restart the Gateway after a submission; the ledger shows
     `unknown` or reconciles from custody, and no second submission appears
     until `openclaw clear`;
   - later scoped confirmation: a second sender, a day later, still answered in
     the same main session.
8. Name, persona and standing instructions from Mike.

## Rollback

Disables only this wiring; keeps all state and new-type obligations. Never
restore an old checkout or an old broker DB (the `openclaw` CHECK and any
openclaw rows must stay readable).

1. Stop future wakes: remove `<id>` from `~/.agent-peers-openclaw/wake/enabled`.
   Admitted work still runs.
2. Make every child inert at once: `touch ~/.agent-peers-openclaw/disabled`.
3. Remove the OpenClaw wiring: `openclaw mcp unset agent-peers-<id>` and
   `openclaw mcp reload`. The agent can stay.
4. Leave the ledger, binding, broker row and mail in place; mail stays queued
   and is delivered if the wiring returns.
