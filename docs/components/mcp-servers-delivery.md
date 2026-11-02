# MCP Servers & Delivery Pipeline

Truth-from-code documentation of the five `agent-peers-mcp` MCP server surfaces
and the delivery-guarantee machinery they share. Verified against repo HEAD
`9be6159` (branch `docs-v3`), 2026-11-02. Source references name functions, not
line numbers, because the files change often.

Entry points: `claude-server.ts`, `codex-server.ts`, `hermes-server.ts`,
`droid-server.ts`, `openclaw-server.ts`. Only the first two hold logic. The other
three are short wrappers that set `AGENT_PEERS_RUNTIME` and import
`codex-server.ts`.

Shared modules:
`shared/delivery-state.ts`, `shared/codex-inbox.ts`, `shared/piggyback.ts`,
`shared/recent-delivered.ts`, `shared/wait-for-peer-messages.ts`,
`shared/colleague-prompt.ts`, `shared/hermes-claims.ts`, `shared/async-lock.ts`,
`shared/state-dir.ts`, `shared/chat-list.ts`, `shared/claude-socket-wake.ts`,
`shared/openclaw-gate.ts`, `shared/peer-identity.ts`, `shared/peer-context.ts`,
`shared/names.ts`, `shared/summarize.ts`, `shared/tab-title.ts`.

Companion doc: [`docs/delivery-contract.md`](../delivery-contract.md) states the
*guarantees*; this doc states the *implementation*. Where the two disagree it is
called out in [§8](#8-red-flags).

---

## 1. Purpose

Each agent session (a Claude Code tab, a Codex CLI thread, a Hermes surface, a
Droid session, an OpenClaw session thread) spawns a stdio MCP server process.
That process is the session's membrane against the broker: it registers a peer
identity, heartbeats it, polls the broker's mailbox, and — the hard part — gets
inbound messages *in front of the model* despite each harness having a
different and mostly hostile input surface.

There are five surfaces because there are five peer types, but only two
delivery mechanisms:

| Surface | Entry point | Peer type | Delivery mechanism | Why |
| --- | --- | --- | --- | --- |
| **Claude** | `claude-server.ts` | `claude` | Channel push or inbox-socket notice, plus `check_messages` backfill | Claude Code has a live channel. Earlier builds queued a push fired while the session sat idle at the prompt, invisibly (see `shared/recent-delivered.ts`); on 2026-11-02 current builds were observed starting a turn from an idle push. `check_messages` stays the rule either way. |
| **Codex** | `codex-server.ts` | `codex` | Piggyback `[PEER INBOX]` block prepended to every tool response | Codex CLI does not surface MCP `notifications/message` to the model, so a tool *response* is the only model-visible input channel. |
| **Hermes** | `hermes-server.ts` | `hermes` | Same transport as Codex, with per-chat mail partitions | Hermes surfaces have no idle push; the piggyback pipeline works, the Codex *timeouts* do not. |
| **Droid** | `droid-server.ts` | `droid` | Same transport as Codex | Injected by the `droidpeer` launcher into a session-scoped MCP. |
| **OpenClaw** | `openclaw-server.ts` | `openclaw` | Same transport as Codex, gated to the agent's main session | One child per session thread; only the main session may own the mailbox. |

The delivery machinery exists to answer one question honestly: **"did the model
actually see this message?"** The universal invariant driving all of it is
stated in the header of `codex-server.ts`:

> No message is acked to the broker (nor pruned from the durable queue) until we have evidence the
> previous tool-response cycle actually completed. That evidence is "the harness called us again."

The result is deliberate at-least-once delivery. Duplicate presentation is
possible; silent loss is the thing being engineered out.

---

## 2. Structure

### 2.1 `codex-server.ts`

One file serves four peer types; `RUNTIME_PEER_TYPE` (from
`AGENT_PEERS_RUNTIME`) selects `codex`, `hermes`, `droid` or `openclaw`.

| Section | Contents |
| --- | --- |
| Pipeline doc comment | The two-layer model (durable inbox + piggyback) and the shutdown contract |
| Constants / runtime selection | Port, adaptive poll interval (1s while a conversation is live, 3s idle), heartbeat, `RUNTIME_PEER_TYPE`, Hermes chat-mail switches, wait timeouts |
| Module state | `client`, `myId`/`myName`/`mySession`, `inboxStore`, `pollInFlight`, `isWakeableSession`, OpenClaw gate |
| `Server` construction | Capabilities (`logging`, `tools`) and the model-facing `instructions` string, with Hermes and OpenClaw sections added by runtime |
| `TOOLS` | Six base tools plus `list_chats`; Hermes adds `chat` / `from_chat` arguments (see [§3.1](#31-tools)) |
| Ack queue | `pendingAcks` (cap 500) and `enqueueAck` |
| Wait loop adapter | `waitForFreshPeerMessages` wires `shared/wait-for-peer-messages.ts` to the durable store, the dedupe set and, for Hermes, the chat partition |
| Broker fetch (unlocked) | `fetchBrokerLeases`: pure HTTP, no local state |
| Classify + upsert (locked) | `applyLeasedToQueue`: triage, persist, signal-only preview push |
| Unlocked poll entry | `pollBrokerIntoQueue`: fetch outside the lock, apply inside |
| Request wrapper | `withPiggyback`: arrival snapshot, pre-read hook, batch, handler, promote or rollback |
| Critical section | `acquireInboxBatch`: partition choice, confirm, ack flush, inline poll, read/filter/draw |
| Watermark prune | `pruneSeenWatermark` |
| Tool dispatch | The `CallToolRequestSchema` handler, with the OpenClaw gate in front of `withPiggyback` |
| Startup | `main()`: signals, watchdog, gates, elections, register, loops |
| Wake registration | `registerWakeableSessionIfEnabled`, `resolveWakeRegistrationHints`, `bindDroidLaunchClaim` |
| Fatal handler | Clear title, unregister, exit 1 |

**Startup order in `main()` is load-bearing** and commented as such:

1. Signal handlers (`SIGINT`/`SIGTERM`/`SIGHUP`/`SIGQUIT`) + `exit` armed *first* — an
   unhandled SIGHUP exits 129 without firing `exit`, which would strand a `peer:<name>` tab title.
2. Orphan-parent watchdog every 1s — Bun's stdio transport can outlive its app-server
   parent; `parentProcessWasLost` detects the reparent to launchd.
3. Paperclip containment gate — `PAPERCLIP_AGENT_ID` or `PAPERCLIP_RUN_ID` set ⇒
   connect, expose **zero tools**, return. Runs **before** the activation gate on purpose, so a
   Paperclip adapter config that sets `AGENT_PEERS_ENABLED=1` cannot opt the agent back on. See
   [§2.5](#25-paperclip-containment).
4. Activation gate — `AGENT_PEERS_ENABLED !== "1"` ⇒ connect, expose **zero tools**,
   return. No broker, no tab title.
5. OpenClaw only — connect the transport first, then register nothing until a tool call proves
   this child runs the agent's main session ([§2.4](#24-elections-and-gates)).
6. Wake-launch election — only for Codex ([§2.4](#24-elections-and-gates)).
7. Tab title placeholder + keepalive — before `register()` so there is no "node" window.
8. `ensureBroker` → `waitForSharedSecret` → `createClient`.
9. `myCwd` from `AGENT_PEERS_CWD || process.cwd()`, git root, tty.
10. Codex desktop-wake registration object, when eligible (`desktopWakeEligible`).
11. Identity: the persona-repository-harness default name, then for Hermes the member or
    name-claim path ([§2.4](#24-elections-and-gates)).
12. Best-effort summary, raced against 3s.
13. `register()`. OpenClaw retries until the broker returns exactly `PEER_NAME`, for up to
    `AGENT_PEERS_OPENCLAW_RECLAIM_WAIT_MS` (default 90s), then fails loudly.
14. Construct and `init()` the `CodexInboxStore`. If the inbox file is refused, startup fails
    rather than overwrite it (see [§3.3](#33-durable-inbox-files)).
15. Wake binding: wake-registry upsert (Codex), or Droid launch-claim bind.
16. `mcp.connect(new StdioServerTransport())` (already done earlier for OpenClaw).
17. Self-scheduling poll loop and a 15s heartbeat/rejoin loop.

### 2.2 `claude-server.ts`

| Section | Contents |
| --- | --- |
| Pipeline doc comment | Poll → persist → push → ack; within-session dedupe scope |
| Constants | Port, adaptive intervals, `CLAUDE_INBOX_ROOT`, watermark slack, `DeliveryState`, `checkMessagesLock`, `WAKE_MODE` |
| `Server` construction | `capabilities.experimental["claude/channel"]` + instructions |
| `TOOLS` | Six tools (the base five plus `list_chats`); **no** `wait_for_peer_messages` |
| Tool dispatch | Confirm-on-entry block, then the switch |
| `check_messages` | Ring buffer ∪ durable unread, draw/promote/rollback, under `checkMessagesLock` |
| Startup | `main()` |
| Poll+push loop | `pollAndPush` and a self-scheduling timer |
| Heartbeat / rejoin | Eviction detection and re-registration |
| Fatal handler | Clear title, unregister, exit 1 |

The Claude side is structurally simpler because delivery is *push-first*: the
poll loop persists, acks, and announces in one pass; `check_messages` is pure
backfill. There is no per-request wrapper; the only lock is the one around
`check_messages`.

`WAKE_MODE` (`shared/claude-socket-wake.ts`, `chooseWakeMode`) is one of:

- `channel`: the session was launched with the agent-peers channel. Mail is pushed
  as `notifications/claude/channel`.
- `socket`: Claude Code exports `CLAUDE_CODE_MESSAGING_SOCKET`, and there is no
  channel. After the durable write and the ack, a `SocketWaker` posts a bodyless
  "[Agent Peers] N new peer messages" notice to that socket, which starts a turn
  when the session is idle. Repeated failures degrade it and remove its marker
  file so the rewake hook can take over.
- `none`: the desktop app, unless `AGENT_PEERS_SOCKET_WAKE=1` opts in. It relies on
  `bin/claude-peer-rewake`. `AGENT_PEERS_SOCKET_WAKE=0` forces `none` for a non-channel session.

Claude desktop sessions (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`) join by default,
unless `AGENT_PEERS_ENABLED=0`, and skip tab-title writes.

### 2.3 The three wrappers

**`hermes-server.ts`** sets `AGENT_PEERS_RUNTIME=hermes`, then runs three gates before
the dynamic import, in order:

1. **Flag file** `~/.agent-peers-hermes/disabled` (or under `AGENT_PEERS_STATE_DIR` /
   `AGENT_PEERS_HERMES_STATE_DIR`) ⇒ force `AGENT_PEERS_ENABLED=0`. It exists for hosts
   where the operator cannot inject env into a Hermes-managed MCP launch.
2. **`AGENT_PEERS_HERMES_ROLE=passive`** ⇒ force `AGENT_PEERS_ENABLED=0`.
3. Otherwise `AGENT_PEERS_ENABLED ??= "1"`, so an explicit `AGENT_PEERS_ENABLED=0` still wins.

An obsolete `AGENT_PEERS_HERMES_V2=1` only prints a warning (see
[`legacy-hermes-v2.md`](../legacy-hermes-v2.md)).

**`droid-server.ts`** sets `AGENT_PEERS_RUNTIME=droid` and `AGENT_PEERS_ENABLED ??= "1"`.
The `droidpeer` launcher injects it into the Droid session.

**`openclaw-server.ts`** sets `AGENT_PEERS_RUNTIME=openclaw`. If
`~/.agent-peers-openclaw/disabled` exists (or the equivalent under
`AGENT_PEERS_STATE_DIR` / `AGENT_PEERS_OPENCLAW_STATE_DIR`) it forces
`AGENT_PEERS_ENABLED=0`; otherwise `AGENT_PEERS_ENABLED ??= "1"`. `codex-server.ts`
re-reads the same file on every tool call and background tick, so a loaded child goes
inert at once. Design and runbook: [`openclaw-peer.md`](openclaw-peer.md).

Behavioral deltas from Codex, all inside `codex-server.ts` keyed on the runtime:

- Wait timeouts drop from 300s to **60s** for Hermes and OpenClaw, because a Hermes
  surface can be torn down mid-wait.
- Wake-launch election and wake-registry registration are Codex-only. Droid binds its
  launch claim instead. Hermes and OpenClaw are not registered with the Codex wake registry.
- Hermes runs the name-claim election or the member path; OpenClaw runs the mailbox gate.
- The durable inbox root becomes `~/.agent-peers-<runtime>` (`shared/state-dir.ts`).
- Hermes adds chat arguments and partitions; OpenClaw adds the `wake` argument to
  `check_messages` and refuses `rename_peer`.
- Instruction text swaps "Codex" for the runtime name.

### 2.4 Elections and gates

Each exists because one logical agent can spawn several MCP children, and only one may own
the peer identity.

**Codex wake-launch election** (`main()`, `shared/wake-launch-role.ts`). In `--remote` mode
the app-server spawns one agent-peers MCP *per Codex thread* — `thread/start`, cold
`thread/resume`, `thread/fork`, subagents, detached reviews — and keeps unsubscribed threads
loaded for 30 minutes. Every child used to call `register()`, so one `codexpeer` launch
produced N addressable peers (observed: 4 per app-server), and name-addressed mail landed on a
twin the wake daemon was not watching. There is *no* spawn-time signal identifying the owning
thread, so the launcher writes a single-use claim and the first child to `tryAcquireRoot` wins.
Losers (`role === "secondary"`) expose a zero-tool MCP and return — they must still start,
because the launcher sets `mcp_servers.agent-peers.required=true`. `AGENT_PEERS_WAKE_LAUNCH=1`
is what distinguishes "secondary thread of a wakeable launch" (go inert) from "ordinary `codex`
session with no claim" (register normally) — without it, gating would silently remove every
plain Codex session from the network.

**Hermes name-claim election** (`main()`, `shared/hermes-claims.ts`). Per Hermes profile, the
gateway and the serve process load `hermes-server.ts` with the same `PEER_NAME` and no cwd, so
one profile registered 2-3 peers that the broker's suffix ladder disambiguated into
`ezra-hermes`, `-2`, `-3`. The lock is keyed by `PEER_NAME`. Unlike a Codex secondary, **the
loser does not go inert** — it may be the surface the user is currently talking through, so it
keeps full tooling and registers under an ephemeral generated name; it simply never owns the
address peers use. A loser (and a member, below) registers with `mailbox_owner` set to the
durable name, so its chats' mail is read from the owner's mailbox.

**Hermes member role** (`AGENT_PEERS_HERMES_ROLE=member`). Skips the election. The surface keeps
every tool but never takes the durable name, which stays with the always-on gateway. It is
meant for Desktop and WebUI backends. Older code treats an unknown role like any surface.

**OpenClaw mailbox gate** (`shared/openclaw-gate.ts`). No child registers at startup. On
every tool call the gate decides whether this child runs `agent:<id>:main`, using Codex's
`_meta.threadId` and the binding file or a live wake token. Only the proven child claims the
name (it reuses `HermesNameClaims`), registers, and polls. Every other child answers each tool
with an explanation. A call with no thread id is refused. A newer proof moves the binding and
the old owner steps down within about 5 seconds.

### 2.5 Paperclip containment

An agent embodied inside a Paperclip company must never join the peer network. Refusing broker
registration is the single choke point that blocks both directions: the agent cannot be listed,
messaged, or woken by a peer, and it never receives the peer tools to message out.

Keys **only** on embodiment markers (`PAPERCLIP_AGENT_ID`, `PAPERCLIP_RUN_ID`) — set per-run by
Paperclip's adapter, and by `paperclipai agent local-cli` when a shell is given an agent identity.
Deliberately ignores `PAPERCLIP_HOME` / `PAPERCLIP_INSTANCE_ID` / `PAPERCLIP_CONFIG` /
`PAPERCLIP_COMPANY_ID`: a board **operator** carries those while running the CLI and must stay
allowed on the network.

Motivation: on 2026-08-27 CCR ran two copies of the same persona — one Paperclip agent, one
hand-launched peer — coordinating with the same colleague on the same task with no shared state.
Pausing the board agent stopped only half the work. Before the guard the separation held only by
accident, because Paperclip's adapter happened not to set `AGENT_PEERS_ENABLED`.

`claude-server.ts` and `codex-server.ts` each call the guard, so all five surfaces inherit it.
Covered by `tests/paperclip-guard.test.ts`, which asserts gate ordering against the real source.

---

## 3. Public interfaces

### 3.1 Tools

| Tool | Claude | Codex | Hermes | Droid | OpenClaw | Notes |
| --- | :---: | :---: | :---: | :---: | :---: | --- |
| `list_peers(scope, peer_type?)` | yes | yes | yes | yes | yes | `scope` ∈ `machine \| directory \| repo`, required; `peer_type` ∈ the five types. With federation on, `machine` scope also lists the other machines' peers (qualified `name@host`); an unreachable host is reported in a header, not an error. |
| `send_message(to_id, message)` | yes | yes | yes | yes | yes | `to_id` accepts a UUID, an exact or persona name, `name@host`, and `name/<chat title or ID>` for a Hermes chat. Hermes adds `from_chat`. |
| `set_summary(summary)` | yes | yes | yes | yes | yes | |
| `check_messages()` | yes | yes | yes (+`chat`) | yes | yes (+`wake`) | Different semantics per side — see below |
| `wait_for_peer_messages(timeout_ms?, from?)` | no | yes (300s) | yes (60s, +`chat`) | yes (300s) | yes (60s) | A wakeable Codex or Droid session returns immediately instead of blocking |
| `rename_peer(new_name)` | yes | yes | yes | yes | refused | Renames *yourself*; 1-96 chars `[a-zA-Z0-9_-]`, not a UUID. OpenClaw takes its name from `PEER_NAME` and the binding. |
| `list_chats(peer, query?, limit?, offset?)` | yes | yes | yes | yes | yes | Read-only list of a Hermes agent's chats (titles and status, never transcript text); returns addresses to send to. `peer@host` reaches another machine. It never wakes the agent or reads its mail. |

Tool definitions live in the `TOOLS` array of `codex-server.ts` and `claude-server.ts`. The
Hermes `chat` argument names the chat whose mail a call reads and confirms: the chat in a
wake message, else `$HERMES_SESSION_ID`, or `"general"` for the profile's Agent Peers chat.
With no `chat`, a Hermes call reads the general mailbox. `AGENT_PEERS_HERMES_CHAT_MAIL=0` removes
the chat arguments.

Critically, **on Codex, Hermes, Droid and OpenClaw every tool response carries the inbox**:
`list_peers`, `send_message`, `set_summary`, `check_messages`, `wait_for_peer_messages`,
`rename_peer` and `list_chats` all route through `withPiggyback`, so any of them prepends a
`[PEER INBOX]` block. `check_messages` itself only returns a short status line — the piggyback
already did the work. On Claude, **only `check_messages` surfaces the inbox**; the other tools
return their own text and nothing else.

The model-facing behavioral protocol is `COLLEAGUE_PROTOCOL` (`shared/colleague-prompt.ts`),
imported verbatim by both servers specifically so the two ends cannot drift in how they treat
peer messages. Each server then appends its own delivery prologue. Both prologues carry the
same load-bearing rule: **call `check_messages` first thing every user turn.**

Both servers also use `shared/peer-list.ts` for discovery rendering. `Started` means when the
current MCP-backed working session began and controls display order; `Heartbeat` means only that
the peer is live. The response and shared protocol require a deliberate selection check before
messaging: identify the collaboration need, compare every plausible candidate's repo/CWD and
Current status, and choose the strongest task match rather than the first row. Exact user targets
and explicit latest/current requests take precedence; `Started` otherwise breaks ties between
similarly relevant candidates. Missing statuses and unfamiliar harnesses remain valid candidates.

### 3.2 Environment configuration

| Variable | Read by | Effect |
| --- | --- | --- |
| `PAPERCLIP_AGENT_ID`, `PAPERCLIP_RUN_ID` | both servers | Either one set ⇒ zero-tool no-op MCP, no registration. Checked **before** `AGENT_PEERS_ENABLED`, so it cannot be overridden. See `shared/paperclip-guard.ts`. |
| `AGENT_PEERS_ENABLED` | both servers | Must be exactly `"1"`. Anything else ⇒ zero-tool no-op MCP, no broker, no tab title. The Hermes, Droid and OpenClaw wrappers default it to `"1"`; Claude desktop sessions join unless it is `"0"`. |
| `PEER_NAME` | both servers | Requested stable name. Also the durability trigger. |
| `AGENT_PEERS_EPHEMERAL` | both servers | `"1"` ⇒ register non-durable even with a `PEER_NAME`. |
| `AGENT_PEERS_CWD` | `codex-server.ts` | Codex-family only. Hermes surfaces inherit an arbitrary cwd (`/`, the profile dir, a workdir — three "identities" for one agent), so profiles pin it. **Claude has no equivalent** and always uses `process.cwd()`. |
| `AGENT_PEERS_SECRET_PATH` | both servers | Override for the shared-secret file used by the readiness probe. |
| `AGENT_PEERS_PORT` | both servers | Broker port, default `7900`, loopback only. |
| `AGENT_PEERS_HEARTBEAT_MS` | both servers | Heartbeat interval, default 15000. |
| `AGENT_PEERS_IDLE_POLL_MS` | both servers | Poll interval when no peer conversation has been live for 2 minutes, default 3000. The active interval is 1000. |
| `AGENT_PEERS_RUNTIME` | `codex-server.ts`, `state-dir.ts` | `hermes`, `droid` or `openclaw` selects the identity and inbox root; anything else is Codex. Set by the wrappers. |
| `AGENT_PEERS_HERMES_ROLE` | `hermes-server.ts`, `codex-server.ts` | `passive` ⇒ inert surface, no peer identity. `member` ⇒ full tools, never the durable name. |
| `AGENT_PEERS_HERMES_CHAT_MAIL` | `codex-server.ts` | `"0"` switches Hermes per-chat mail off: the surface reads only general mail, and chat mail stays hidden and unconfirmed. |
| `AGENT_PEERS_OPENCLAW_AGENT` | `codex-server.ts` | The OpenClaw agent id whose main session this entry serves. Required, with `PEER_NAME`. |
| `AGENT_PEERS_OPENCLAW_RECLAIM_WAIT_MS` | `codex-server.ts` | How long a new main child retries reclaiming the peer name, default 90000. |
| `AGENT_PEERS_STATE_DIR` | `shared/state-dir.ts` | Overrides the inbox/claims root for any runtime. |
| `AGENT_PEERS_{CODEX,HERMES,DROID,OPENCLAW}_STATE_DIR` | `shared/state-dir.ts` | Runtime-specific root. For Hermes and Droid *inboxes* the Codex variable is a last fallback before the default, so it can still relocate their inbox. |
| `AGENT_PEERS_WAKE_ENABLED`, `..._THREAD_ID`, `..._APP_SERVER_URL`, `..._APP_SERVER_PID`, `..._APP_SERVER_SOCKET_PATH`, `..._ROLLOUT_PATH` | `codex-server.ts` | Env-injected wake-registry hints for legacy standalone launchers; bypasses the claim store (`claim_id: "env"`). Ignored in a managed wake launch. |
| `AGENT_PEERS_WAKE_LAUNCH` | `shared/wake-launch-role.ts` | `"1"` marks every MCP child of a wakeable app-server. |
| `AGENT_PEERS_DROID_LAUNCH_CLAIM_ID` | `codex-server.ts` | Set by `droidpeer`; binds the session to its private launch claim. Without it a Droid session is not wakeable. |
| `AGENT_PEERS_SOCKET_WAKE` | `claude-server.ts` | `0` disables inbox-socket wake; `1` opts the desktop app into it. |
| `AGENT_PEERS_DISABLE_TAB_TITLE` | `shared/tab-title.ts` | `"1"` opts out of OSC title writes. |
| `AGENT_PEERS_AUTO_SUMMARY`, `OPENAI_API_KEY` | `shared/summarize.ts` | Auto-summary runs only when both are set (`AGENT_PEERS_AUTO_SUMMARY=1`). Otherwise it returns `""`. |

**Kill-switch flag files.** `~/.agent-peers-hermes/disabled` disables *every* Hermes surface
at once, and `~/.agent-peers-openclaw/disabled` does the same for OpenClaw (re-read on each
call and tick, so a loaded child stops serving at once). Remove the file to rejoin; a Hermes
surface additionally needs an MCP reload. There is no equivalent flag file for Codex, Claude or Droid.

**Reloading the MCP.** Hermes CLI/TUI and gateway chats support `/reload-mcp`. Hermes Desktop
does not show it; toggle the Agent Peers connector off and on instead. A reload restarts the
MCP for every chat that backend hosts, not just the current one. Durable inbox state survives,
and drawn-but-unconfirmed mail is shown again.

### 3.3 Durable inbox files

| Runtime | Default path | Selected by |
| --- | --- | --- |
| Codex | `~/.agent-peers-codex/<peer-uuid>.json` | `resolveStateDir` (default runtime) |
| Hermes | `~/.agent-peers-hermes/<peer-uuid>.json` | `AGENT_PEERS_RUNTIME=hermes` |
| Droid | `~/.agent-peers-droid/<peer-uuid>.json` | `AGENT_PEERS_RUNTIME=droid` |
| OpenClaw | `~/.agent-peers-openclaw/<peer-uuid>.json` | `AGENT_PEERS_RUNTIME=openclaw` |
| Claude | `~/.agent-peers-claude/<peer-uuid>.json` | `claude-server.ts` passes `resolveStateDir({runtime: "claude"})` as the root |

Alongside each, a **bodyless** sidecar `<peer-uuid>.metadata.json` is written best-effort on
every mutation: sender identity, ids and timestamps, **no message text and no lease token**. It
exists for external observers (the wake daemon, `cli.ts inboxes`) that need to know mail is
waiting without being handed message bodies.

State file format:

```json
{ "unread": [ { "id": 42, "from_id": "...", "from_name": "...", "from_peer_type": "codex",
                "from_cwd": "...", "from_summary": "...", "to_id": "...", "text": "...",
                "sent_at": "...", "lease_token": "...", "to_chat": "...", "from_chat": "..." } ] }
```

`to_chat` and `from_chat` appear only on chat mail. One file holds every partition of a Hermes
peer; a call reads and confirms only entries in its own partition (general, or one chat).

**Security invariant** (`shared/codex-inbox.ts`): these files mirror the broker's SQLite trust
boundary. Directory `0o700` with a defensive re-`chmod`; file `0o600`, written to a unique
temp file (`atomicWriteJson` in `shared/file-state.ts`, named with the pid and a UUID) and
`rename`d atomically. On read the store **fails closed**: a missing file is the only
trustworthy empty state. A symlink or non-regular file, more than one hard link, another
owner's uid, any mode other than exactly `0600`, or unparseable JSON makes the read **throw**,
so nothing is served and nothing is overwritten. At startup that failure stops the MCP with a
logged error rather than silently starting empty.

All mutations serialize through a per-instance promise-chain lock, and every accessor calls
`ensureLoaded()` — a constructed-but-never-`init()`ed store used to start empty-but-writable,
so the first write atomically clobbered the previous incarnation's mail.

---

## 4. Delivery lifecycle (the core)

### 4.1 The state machine — `shared/delivery-state.ts`

Five sets/maps track every message id through one process:
`drawnByCall`, `drawn`, `presented`, `presentedGen`, `confirmed`, plus a monotonic `generation`.
The machine is the same for every surface.

| Transition | Method | Meaning |
| --- | --- | --- |
| → drawn | `draw(callId, ids)` | Dealt into a response *under construction*. Blocks re-deal. **Not** ack- or confirm-eligible. |
| drawn → presented | `promote(callId)` | That call's response was fully built and un-aborted. Increments `generation` and stamps each id with it. |
| drawn → (undrawn) | `rollback(callId)` | The call was aborted; its draws return to re-dealable. Nothing was acked, nothing was pruned. |
| presented → confirmed | `confirmable(gen)` + `markConfirmed(ids)` | The caller acked the leases and pruned the store; these are now known-delivered. |
| confirmed → ∅ | `pruneConfirmedBelow(watermark)` | Bounded-memory GC. |

`isBlocked(id)` is `drawn ∪ presented ∪ confirmed` — the single predicate that prevents
re-dealing anything already in flight.

**Arrival generations.** `newArrival()` returns the current `generation`, and a call may only
confirm presentations whose `presentedGen <= arrivalGen`. The snapshot is taken at **request
entry** (`withPiggyback`, and the top of the Claude tool handler), *before* the pre-read hook,
because `wait_for_peer_messages` can park a request for minutes. Without the barrier, a parked
call that finally reaches the lock would confirm a *sibling's* response that was built long
after the parked call was issued — and that call is no evidence the model received it. This was
the third-review H1 finding; the reasoning is recorded in the headers of `delivery-state.ts`
and `withPiggyback`.

**Ack-at-confirm-only.** Broker acks are enqueued exclusively at confirm time, never at draw. A
message's lease deliberately expires and re-offers while it sits drawn or presented; the poll
triage dedupes the re-offer by id and *refreshes the stored lease token*, so the eventual
confirm acks the freshest token. Acking at draw was the second-review H1 race: a concurrent
call's flush acked messages that a cancelled call never delivered.

### 4.2 Codex-family request flow (Codex, Hermes, Droid, OpenClaw)

For OpenClaw, the tool handler first checks the kill switch and asks the mailbox gate to admit
the call; a refused call never reaches `withPiggyback`, so it never polls or draws mail. Every
admitted call then runs `withPiggyback`:

```
1. guard registered?
2. callId = randomUUID()
3. arrivalGen = delivery.newArrival()          <- barrier, BEFORE the hook
4. await opts.beforeReadQueue?.()              <- OUTSIDE the lock (can block minutes)
5. fresh = await withPiggybackLock(
        () => acquireInboxBatch(callId, arrivalGen, chat))
6. run the tool handler                        <- OUTSIDE the lock (broker I/O, slow)
7. finalText = formatInboxBlock(fresh) + note + toolText
8. signal.aborted ? rollback(callId)
                  : promote(callId)
```

Steps 4 and 6 are deliberately outside the lock; only the read-draw-mark critical section is
serialized. `createAsyncLock` (`shared/async-lock.ts`) is a minimal FIFO promise-chain mutex —
sufficient because JS is single-threaded. A failure in the pre-read hook is logged and the call
continues.

Inside the lock, `acquireInboxBatch` runs these ordered steps:

**STEP 0 — choose the mailbox (Hermes only).** Hermes always works by partition. With no `chat`,
or `general`, the call reads the general partition. With a chat, the call first calls
`pollChat`, which leases only that chat's mail and also refreshes the lease tokens of mail the
chat presented earlier. The broker reports the scope it used: `chat` (read that chat's
partition), `general`, or `none`. For `none` (no such chat) or an old broker that returns no
scope, the call reads nothing and adds a note to the response; a failed chat poll also adds a
note. Nothing is lost in any of these cases. Other runtimes have no partitions.

**STEP 1a — confirm-promote.** For ids in `confirmable(arrivalGen)`, restricted to the call's
own partition: read the freshest lease tokens from the durable store → `removeByIds` → *only
then* `enqueueAck` → `markConfirmed`. Ordering matters: a broker ack is never sent for a message
without model-delivery evidence. A prune failure leaves everything confirm-pending and retries
next call.

**STEP 1b — unconditional ack flush.** Flushes step 1a's acks plus re-lease tokens the triage
stashed for already-confirmed messages. These must go out even on tool calls that draw nothing,
or the broker re-leases the row forever. Tokens are removed from `pendingAcks` only on HTTP
success; the response is **typed** (`acked`, `stale`, per-token `results` — `shared/types.ts`)
and a partial ack is logged explicitly rather than being swallowed as `{ok:true, acked:0}`.

**STEP 2 — inline poll** (skipped when step 0 already polled a chat). Collapses the worst-case
"message landed 0.99s before this tool call" tail. **This step deliberately bypasses
`pollBrokerIntoQueue()`** and calls `applyLeasedToQueue(await fetchBrokerLeases())` directly.
The reason is a genuine deadlock: `createAsyncLock` is **not reentrant**, and
`pollBrokerIntoQueue` can `await` a background `pollInFlight` promise that is itself queued on
the very lock this code holds. A concurrent background fetch is harmless — its apply serializes
behind us, and the id-keyed upsert is re-offer-safe by design.

**STEP 3 — read, filter, draw.** Read (never consume) the durable queue, drop anything
`isBlocked` or outside the call's partition, then `draw(callId, ids)`. This is the single write
point where a message goes from "sitting in the queue" to "dealt to a response".

**STEP 4 — watermark prune.** Message ids are AUTOINCREMENT-monotonic, so anything below both
the newest confirmed id (minus a 10,000 slack) and everything still queued can never be
re-offered in a way the state needs to dedupe. Guarded by `Number.isFinite` for the
empty-confirmed case.

### 4.3 The poll triage — `applyLeasedToQueue`

It must run under the piggyback lock: the `isConfirmed`/`isBlocked` classification and the queue
upsert have to be atomic with respect to a concurrent confirm's read-token → remove →
`markConfirmed` sequence. An upsert interleaved into that window resurrects a just-confirmed row
as unread, or makes the confirm ack a token the upsert is about to replace.

Per leased message:

- **Already confirmed** ⇒ `enqueueAck(lease_token)` and drop it. We hold delivery evidence; the
  re-offer just means an earlier ack was lost or the lease expired first.
- **Fresh, drawn, or presented** ⇒ upsert into the durable store. For drawn/presented ids this
  *refreshes the stored lease token*. **Never** ack here.

Persistence happens first; if it fails, nothing is pushed and nothing is acked — the lease
expires at the broker and the message re-leases.

Then, for genuinely-new ids only, a **signal-only** MCP `notifications/message` push (text from
`formatInboxPreview` in `shared/piggyback.ts`). It carries the sender's name and peer type plus a
pointer to the next tool call — **no body, no `reply_action`**, enforced by tests in
`tests/piggyback.test.ts`. The split exists to avoid double-reply: a Codex that *does* render
the log would otherwise see the message twice (once as a preview, once in `[PEER INBOX]`). It
updates **no** dedupe state; `[PEER INBOX]` is the one and only "shown to the model" trigger.

The background poll (`pollBrokerIntoQueue`) reads the general mailbox only, and a killed
OpenClaw child skips it, leaving mail unleased at the broker. Chat mail is leased only by a call
that names its chat.

### 4.4 `wait_for_peer_messages`

`shared/wait-for-peer-messages.ts` splits the decision from the loop so the short-circuit is
unit-testable.

`planWaitForPeerMessages` throws on a non-finite explicit timeout, clamps to `[0, maxMs]`, then
returns `skip-wakeable` or `wait`. Wakeable sessions skip entirely: the wake daemon (Codex) or the
`droidpeer` host (Droid) starts a fresh turn the instant mail arrives, so blocking would only
pin the turn "working" for minutes and make the session look hung. `isWakeableSession` is set by
the wake-registry upsert, by the desktop-wake registration, or by a bound Droid launch claim.

`waitForFreshPeerMessages` is a poll/read/sleep loop (500 ms). The adapter in `codex-server.ts`
supplies `isFresh`:

```ts
isFresh: (m) =>
  !delivery.isBlocked(m.id) &&
  (!HERMES_PARTITIONED || (chatKey !== null && partitionOf(m) === chatKey)) &&
  (!from || m.from_id === from || m.from_name === from)
```

The `from` filter governs only **what ends the wait**. Non-matching mail stays queued and still
surfaces in this response's `[PEER INBOX]` — it is never consumed by a wait it did not satisfy.
This was `known-issues-2026-08-08 §1`: Marco's wait for Kepler ate an unrelated Vector message.
A Hermes wait ends only on mail in its own partition, and a chat wait polls that chat.

### 4.5 Claude flow

**Push path** (`pollAndPush`), every 1s while a conversation is live and every 3s when idle,
via a self-scheduling non-overlapping timer (`setInterval` would overlap under slow I/O and
double-push):

1. `pollMessages` from the broker.
2. Already in the in-memory `seen` set ⇒ queue the new lease token, do **not** announce again.
3. Otherwise **persist to the durable store first**. On write failure: no announcement, no ack,
   the lease expires and re-offers. Acking before any durable record existed is what made a
   queued-while-idle push die with the process, already-acked and untraceable.
4. Durable copy exists ⇒ add to `seen`, queue the ack, then announce. In `channel` mode that is
   a best-effort `notifications/claude/channel` push plus `recordDelivered` into the ring
   buffer; in `socket` mode the message is queued for the `SocketWaker` (also recorded in the
   ring buffer) and announced after the ack. Failure is logged and tolerated — `check_messages`
   will surface it.
5. Watermark-prune `seen`, prune confirmed ids, single batched `ackMessages`, then flush the waker.

Whether a channel push that lands while the session is idle at the prompt is shown at once
depends on the Claude Code build. Earlier builds queued it invisibly until the next turn. On
2026-11-02 a terminal session on current Claude Code started a new turn from an idle channel push
(Marco AP10963), and an Omarchy test session idle-woke and replied in about ten seconds. Treat
that as observed behavior, not a guarantee: the ring buffer and `check_messages` exist for the
cases where it does not hold, and the rule stays to call `check_messages` first thing every turn.

The channel `meta` payload is `Record<string,string>`: the numeric `message_id` is stringified
and `source` is omitted because the channel auto-generates it from the server name.

**Backfill path** — `check_messages` unions two sources, under `checkMessagesLock` so
overlapping calls cannot both draw the same entry:

- The **ring buffer** (`shared/recent-delivered.ts`): module-level, bounded by `RECENT_MAX = 50`
  entries and `RECENT_TTL_MS = 15 min`, pruned on read and write. Lost on restart, which is
  fine — the colleague protocol treats each session as a fresh conversation. Entries already
  confirmed are skipped.
- **All unread durable mail at any age**, skipping `isBlocked` ids. Age-gating durable unread
  behind the ring buffer's 15-minute window was a silent-loss path for sessions idle longer than
  the TTL. **There is no TTL on unread durable mail**: an unread entry is mail the model has
  never seen and the broker already acked, so deleting it on a timer is silent loss. Entries
  leave only via confirm-on-next-call or the rejoin migration; a dead session's file is
  *archived, never deleted*, by `cli.ts gc-inboxes`.

Both are merged by id, sorted, formatted through the same `formatInboxBlock` Codex uses, then
drawn/promoted/rolled-back exactly like the Codex path.

**Confirm** happens at the top of *every* tool call, not just `check_messages`: snapshot
`arrivalGen`, `removeByIds(confirmable)`, `markConfirmed`. No ack is involved — Claude already
acked at poll time; the confirm only prunes the durable store.

### 4.6 Failure semantics summary

| Event | Result |
| --- | --- |
| Response dropped / request aborted | `rollback` ⇒ ids re-dealable, nothing acked, nothing pruned ⇒ re-delivered next call |
| MCP process dies after draw, before confirm | Durable file keeps the message; broker lease expires and re-offers; next incarnation re-delivers |
| MCP reload (for example the Desktop connector toggle) | Same as a process death: state is on disk; unconfirmed mail is shown again |
| Durable write fails | No push, no ack; broker re-leases |
| Inbox file refused (permissions, owner, links, corrupt JSON) | Nothing served, nothing overwritten; startup fails loudly |
| Ack HTTP fails | Tokens stay in `pendingAcks`; retried next call |
| Ack succeeds with `acked < sent` | Logged with per-token statuses; the re-lease refreshes the token and the confirm/triage path re-acks |
| Chat poll fails, or the chat is unknown (Hermes) | The call reads nothing from that chat and says so in a note; nothing is lost |
| Broker down > 60s (peer GC'd) | Heartbeat returns `known:false` ⇒ re-register with `prev_id`, migrate the durable inbox, re-point the wake registry |
| Shutdown | Timers cleared. **No** `pendingAcks` flush (those may never have reached the model), **no** unregister (preserves the 60s reclaim-by-name window), durable queue stays on disk. A Hermes name claim and an OpenClaw gate claim are released. |

The `known === undefined` case is explicitly **not** eviction — it means the broker predates the
field. Never re-register on silence, only on an explicit "no".

### 4.7 Hermes name-claim election details

`shared/hermes-claims.ts`. Lock file at `<root>/name-claims/<encodeURIComponent(name)>.lock`
containing `{owner_pid, acquired_at}`, mode `0600`, dir `0700`. The OpenClaw gate reuses this
class with its own root.

`tryAcquire` loops up to 3 times:

1. `writeFile(..., {flag: "wx"})` — exclusive create is atomic on POSIX; exactly one surface wins.
2. On `EEXIST`, read the holder. `ENOENT` (lock vanished between wx and read) ⇒ retry. Unreadable or
   corrupt ⇒ **fail closed**, return false.
3. Same `owner_pid` ⇒ idempotent true.
4. `ownerStillHoldsClaim` ⇒ false (someone else owns it).
5. Dead owner ⇒ **atomic rename reclaim**. A plain unlink+retry races a concurrent
   reclaimer: after a SIGKILL, gateway and serve boot together, both read the dead pid, one unlinks
   and re-creates via `wx`, and the other then unlinks the *fresh winner's* lock — both win.
   `rename()` is the atomic claim on the stale file: exactly one renamer succeeds, the loser gets
   `ENOENT` and loops back to a plain `wx` against whatever the winner wrote.

`ownerStillHoldsClaim` is the **PID-reuse guard**: after a reboot an unrelated process can
inherit the old owner's pid, making a dead claim look held forever and stranding the canonical
name. A pid only vouches for the lock if its process **started before the lock was acquired**,
checked via `ps -p <pid> -o lstart=` with a **2s tolerance** (`ps` lstart has 1s precision). If
`ps` cannot answer — EPERM'd zombie, parse failure, race — it falls back to pid-liveness alone,
the conservative side.

`release` is owner-checked: a loser releasing is a no-op, so it can never delete the winner's
lock. Called from `lifecycleCleanup` in `codex-server.ts`.

---

## 5. Dependencies

- **`@modelcontextprotocol/sdk` ^1.27.1** (`package.json`) — `Server`, `StdioServerTransport`,
  `ListToolsRequestSchema`, `CallToolRequestSchema`. The SDK supplies `extra.signal` (the
  cancellation `AbortSignal` consumed by `withPiggyback` and the Claude `check_messages`) and
  `mcp.notification(...)` for both the Codex log preview and the Claude channel push.
- **`shared/broker-client.ts`** — the typed HTTP wrapper: `register`, `heartbeat`, `unregister`,
  `setSummary`, `listPeers`, `sendMessage`, `pollMessages`, `pollChat`, `ackMessages`,
  `renamePeer`, `listChats`, plus the wake passes' `chatInbox` and `peerInbox`, and
  `createReadinessProbe`. The probe is **authenticated and fail-closed**: only a `/ready`
  answering with the shared secret, `protocol === 1`, a service owner (`launchd` or `systemd`;
  a client-owned broker only on a dev box with `AGENT_PEERS_SPAWN_BROKER=1`) and the expected DB
  identity counts as alive — a bare `/health` 200 from a squatter must not satisfy startup.
- **`shared/ensure-broker.ts`** + **`shared/shared-secret.ts`** — clients never spawn the broker.
  They ask the service manager to start it (`launchctl kickstart` on macOS,
  `systemctl --user start agent-peers-broker` on Linux), poll readiness, and block until the
  secret file exists, before `createClient`.
- **Bun** — `Bun.spawn` / `Bun.spawnSync` for `git rev-parse`, `git branch`, `git log`, and `ps`
  (`shared/peer-context.ts`, `shared/summarize.ts`, `shared/hermes-claims.ts`); `Bun.hash` for
  the DB identity hash; the `bun` runtime is the `command` in every harness config.
- **Node built-ins** — `node:fs/promises` (atomic inbox writes), `node:fs` sync (`tab-title.ts`
  writes OSC sequences to `/dev/tty`), `node:os`, `node:path`, `crypto.randomUUID`.
- **OpenAI API** (optional) — `shared/summarize.ts`, model `gpt-5.4-nano`, only when
  `OPENAI_API_KEY` and `AGENT_PEERS_AUTO_SUMMARY=1` are both set.

---

## 6. Entry points

Each server is a `#!/usr/bin/env bun` script run as a stdio MCP child.

**Claude Code** (`README.md`):

```bash
claude mcp add --scope user --transport stdio agent-peers -- bun "$AGENT_PEERS_DIR/claude-server.ts"
alias agentpeers='AGENT_PEERS_ENABLED=1 claude --dangerously-skip-permissions \
  --dangerously-load-development-channels server:agent-peers'
```

Registered globally, so *every* `claude` session spawns the process; the alias is what sets
`AGENT_PEERS_ENABLED=1`. Plain terminal `claude` gets the no-op MCP; Claude desktop sessions
join without the alias. `--dangerously-load-development-channels server:agent-peers` is what
makes the `claude/channel` capability usable; sessions without it wake through the inbox
socket or the rewake hook ([§2.2](#22-claude-serverts)).

**Codex CLI** (`README.md`), `~/.codex/config.toml`:

```toml
[mcp_servers.agent-peers]
command = "bun"
args = ["$AGENT_PEERS_DIR/codex-server.ts"]
env = { "AGENT_PEERS_ENABLED" = "1" }
```

**Wakeable Codex** — `wakeable-codex.ts` → `shared/wakeable-launcher.ts` starts an app-server-backed
TUI and injects per-launch config via `-c mcp_servers.agent-peers.env.*` overrides: the
`AGENT_PEERS_WAKE_*` hints, `PEER_NAME`, `AGENT_PEERS_WAKE_LAUNCH=1`, and
`mcp_servers.agent-peers.required=true` (which is why secondaries must still expose an MCP
rather than exiting). The thin resume TUI is launched with `AGENT_PEERS_ENABLED=0` so it never
takes an identity. `bin/codex-peer` is the user-facing wrapper (aliases `peerwake`, `adspeer`,
`ccrpeer`, `peerlist`, …). A Codex desktop chat over SSH is made wakeable on its first
agent-peers tool call ([`wake-subsystem.md`](wake-subsystem.md)).

**Hermes Agent** (`README.md`):

```bash
hermes mcp add agent-peers --command bun --env AGENT_PEERS_ENABLED=1 \
  --args "$HOME/agent-peers-mcp/hermes-server.ts"
hermes mcp test agent-peers
```

Each profile also sets `PEER_NAME` and `AGENT_PEERS_CWD`. In the Hermes CLI/TUI and gateway
chats, an existing conversation can join or pick up code with `/reload-mcp`. Hermes Desktop has
no `/reload-mcp`: toggle the Agent Peers connector off and on. Either reload is process-wide for
that backend. Codex cannot reload: an idle stock Codex thread can only be made wakeable by
resuming it through `codex-peer resume <session-id>`.

**Factory Droid** — launched through `droidpeer`, which injects `droid-server.ts` as a
session-scoped MCP server into the Droid session it owns ([`wakeable-droid.md`](../wakeable-droid.md)).
A Droid not launched that way has no launch claim and is not wakeable.

**OpenClaw** — an `mcp.servers` entry scoped to one agent (`codex.agents: ["<id>"]`) whose
command runs `openclaw-server.ts`, with `AGENT_PEERS_OPENCLAW_AGENT` and `PEER_NAME` in its
env. Wiring and runbook: [`openclaw-peer.md`](openclaw-peer.md).

---

## 7. Cross-cutting side effects

**Terminal tab title** (`shared/tab-title.ts`). Writes OSC 0, 1 and 2 — terminals disagree
about which one is "the tab title", iTerm2 uses OSC 1 — re-asserted every 1s
because terminals overwrite the title with the foreground process name. Control characters are
stripped from the title so a peer name can never inject escape sequences. The keepalive timer
is `unref`'d so it never keeps the process alive on its own. Cleared synchronously on exit and on all
four fatal signals.

**Auto-summary** (`shared/summarize.ts`). Off unless `OPENAI_API_KEY` is set and
`AGENT_PEERS_AUTO_SUMMARY=1`. It then sends only the branch name, the count of recently changed
files and their extensions (no paths or file names) to `gpt-5.4-nano` with an 8s timeout, and
frames them as untrusted data. Registration races it with a 3s cap and uploads late via
`setSummary` if it finishes afterwards. Every failure path returns `""`.

**Peer context** (`shared/peer-context.ts`). `getGitRoot` shells `git rev-parse --show-toplevel`;
`getTty` tries `ps -o tty=` for this pid, then the parent's, treating `?`/`??` as no tty.

**Names and identity.** `isValidName` (`shared/names.ts`) gates `rename_peer` on every
surface: 1-96 chars, `^[a-zA-Z0-9_-]+$`, excluding UUID-shaped names. `shared/peer-identity.ts`
derives persona-repository-harness default names and the persona from `AGENTS.md` for all five
adapters; the persona travels in `register` so the broker can resolve a bare persona such as
`marco`. `generateName`/`generateSuffixWord` are broker/CLI-side fallback/collision helpers.

---

## 8. Red Flags

Severity: **H** = can lose or duplicate mail / corrupt state · **M** = correctness or maintenance
hazard · **L** = smell, dead code, or hardcoded value. This section was re-audited against
`9be6159`. Items from the 2026-08-10 audit that the code has since fixed are listed at the end.

### Open

- **RF-2 (M) `claude-server.ts`, heartbeat rejoin** — the migration lacks the
  `myId !== again.id` guard that `codex-server.ts` has (`prevStore = myId !== again.id ? … : null`).
  If `register()` returns the *same* UUID, `prevStore` and the new `inboxStore` address the same
  file with independent locks and in-memory state: `queueLeasedMessages(carried)` writes them
  back, then `prevStore.removeByIds(...)` filters them out of its own stale snapshot and persists
  an **empty** file. In-memory state survives, so nothing is lost unless the process dies before
  the next write. Hard to reach (the broker's reclaim path requires a stale row), but a live footgun.
- **RF-3 (M) `applyLeasedToQueue`** — the best-effort preview push is `await`ed **per message
  inside the piggyback lock**. A slow or wedged transport stalls every concurrent tool call for
  the duration. The push is declared non-fatal; it should not be able to block the critical section.
- **RF-5 (M) `enqueueAck`** — silently drops the **oldest** tokens when `pendingAcks` exceeds the
  hardcoded 500. Dropped tokens leave broker leases open. It self-heals (the re-offer hits the
  `isConfirmed` branch), but the trim discards ack intent with only a log line.
- **RF-6 (L) `shared/delivery-state.ts` `draw`** — `drawnByCall` has no eviction path. A caller
  that draws but neither promotes nor rolls back leaks the entry forever and `drawn` blocks those
  ids from ever being re-delivered. Both current callers are correct, but nothing enforces it.
- **RF-7 (L) `claude-server.ts` `pollAndPush`** — `delivery.pruneConfirmedBelow(delivery.maxConfirmed()
  - SEEN_WATERMARK_SLACK)` lacks the `Number.isFinite` guard that `pruneSeenWatermark` has. On an
  empty confirmed set this passes `-Infinity`; harmless today.
- **RF-8 (L) `claude-server.ts` `pollAndPush`** — `Math.max(...seen)` spreads the whole dedupe set
  as function arguments. Bounded by the watermark in practice, but a large spread risks a
  `RangeError`; `pruneSeenWatermark` iterates instead.
- **RF-9 (M) `claude-server.ts` tool dispatch** — `list_peers`, `send_message`, `set_summary` and
  `rename_peer` make broker calls with **no `try`/`catch`**. A transient HTTP failure throws out
  of the handler. `withPiggyback` catches and returns a typed tool error. Relatedly, an unknown
  tool `throw`s in Claude but returns `{isError: true}` in Codex.
- **RF-10 (L) `shared/state-dir.ts`** — the Codex-specific state-dir variable is still a last
  fallback for the Hermes and Droid *inboxes*, so setting `AGENT_PEERS_CODEX_STATE_DIR`
  silently relocates them. (Kept for rolling-upgrade compatibility.)
- **RF-11 (M) `codex-server.ts` `RUNTIME_PEER_TYPE`** — captured from `process.env.AGENT_PEERS_RUNTIME`
  at module-evaluation time, and the three wrappers rely on mutating the env *before* a
  **dynamic** `import()`. Correct as written, but a static import or a bundler that hoists the
  import would evaluate the constant first and silently register every Hermes, Droid and OpenClaw
  surface as `peer_type: "codex"`. Nothing in the code prevents that refactor.
- **RF-12 (L) kill switches** — the flag-file kill switch exists only for Hermes and OpenClaw.
  Codex, Claude and Droid can be disabled solely through env, which is exactly the situation
  (operator cannot inject env into a harness-managed launch) that motivated the flag files.
- **RF-13 (M) `codex-server.ts` `registerWakeableSessionIfEnabled`** — through the wake-registry
  path, `isWakeableSession` is set to `true` and never cleared. If the wake daemon dies or the
  registry row goes stale, `wait_for_peer_messages` keeps short-circuiting and the session
  silently loses its only standby mechanism while still telling the model "the daemon will wake
  you". (The desktop-wake path re-evaluates it on each call.)
- **RF-14 (M) `rename_peer`** — does not move the Hermes name claim. `hermesClaimedName` keeps the
  original `PEER_NAME`, so after a rename the lock protects a name this peer no longer holds,
  and the name it *does* hold is unprotected against a sibling surface.
- **RF-15 (M) `lifecycleCleanup`** — and therefore the Hermes claim release and the OpenClaw gate
  release — runs **only** from the signal handlers. A plain stdin-close / transport teardown
  exits via the `exit` handler, which only clears the tab title, so the lock file is left behind
  and reclaim falls to the dead-pid path in `hermes-claims.ts`.
- **RF-16 (L) `codex-server.ts` `main`** — the 1s parent watchdog is started **before** the
  `AGENT_PEERS_ENABLED` gate, so even a fully disabled no-op MCP burns a timer for the life of
  the process. The Claude server starts its watchdog after the gate.
- **RF-17 (L) `resolveWakeRegistrationHints`** — declares a `{cwd, tty}` parameter but is called
  with the full registration object, and the env-var branch uses the stringly-typed sentinel
  `claim_id: "env"`. A discriminated union would make the two hint sources explicit.
- **RF-18 (M) `wait_for_peer_messages`** — `planWaitForPeerMessages` throws on a non-finite
  `timeout_ms`, but the throw is swallowed by the pre-read hook's `try`/`catch`; the model then
  sees `"wait_for_peer_messages did not run."` with no reason. The declared `minimum`/`maximum`
  in the tool schema are documentation only — nothing validates the argument.
- **RF-20 (L) `shared/peer-context.ts`, `shared/summarize.ts`, `shared/hermes-claims.ts`** — `git`
  and `ps` are shelled out with **no timeout**. The summary path is protected by the 3s race, but
  `getGitRoot` is awaited unbounded, so a hung `git` (index lock, network filesystem) blocks
  registration indefinitely.
- **RF-21 (L) `shared/hermes-claims.ts`** — hardcoded values in the election: 3 acquire attempts,
  a 2s `lstart` tolerance, and locale/format-dependent parsing of `ps -o lstart=` output. Every
  parse failure falls back to "owner still holds", i.e. toward stranding the canonical name.
- **RF-22 (L) `shared/tab-title.ts`** — `/dev/tty` is opened and closed fresh on every keepalive
  tick (1s, forever). Write failures warn exactly once and then no-op silently; the warn gate
  resets only on `setTabTitle`, so a tty that comes back is never re-reported.
- **RF-23 (L) `codex-server.ts`** — `clearTabTitle` is imported and unused (only `clearTabTitleSync`
  is). Dead import.
- **RF-24 (L) `shared/codex-inbox.ts`** — `EMPTY_CODEX_INBOX_STATE` is exported and referenced
  nowhere in production code. `consumeUnreadMessages` has no production caller either (and its
  comment explains why it must *not* be used for the confirm flow). Delete or mark test-only.
- **RF-26 (L) `shared/recent-delivered.ts`** — module-level mutable singleton shared by every
  importer in the process, with `__resetRecentDeliveredForTest` exported from production code.

### Fixed since the 2026-08-10 audit (`63503f2`)

- **RF-1 (was H)** — Claude `check_messages` now runs under `checkMessagesLock`, so parallel calls
  cannot draw the same entry twice.
- **RF-4 (was M)** — inbox writes use a unique pid-and-UUID temp file (`atomicWriteJson`), so two
  store instances over one file can no longer share a temp path.
- **RF-19 (was M)** — a corrupt or unreadable inbox file now throws instead of reading as empty, so
  it is never overwritten; only a missing file is an empty inbox.
- **RF-27 (was M)** — auto-summary is opt-in (`AGENT_PEERS_AUTO_SUMMARY=1` plus a key) and sends
  only the branch name and file counts and extensions, never paths.
- **RF-10 (partly)** — `AGENT_PEERS_HERMES_STATE_DIR` is now honored for the Hermes inbox through
  one resolver, `shared/state-dir.ts`.
- **RF-25 (was L)** — `claude-server.ts` no longer imports the unused `clearTabTitle`.

### Doc / code agreement

`docs/delivery-contract.md` was rewritten and checked against the code at `9be6159`. Its claims
— write-before-push, ack-only-after-persistence, confirm-on-next-call for Codex, Hermes, Droid
and OpenClaw, the arrival-causality barrier, the 300s and 60s wait caps, `from`-filter
non-consumption, no TTL on unread durable mail, the `PEER_NAME` + `AGENT_PEERS_EPHEMERAL != "1"`
durability rule, and the Hermes election with non-inert losers — match the implementation. The
earlier gaps (RF-28, RF-29: the Hermes inbox path and the Claude lock) are closed.
