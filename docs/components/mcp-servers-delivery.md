# MCP Servers & Delivery Pipeline

Truth-from-code documentation of the three `agent-peers-mcp` MCP server surfaces and the
delivery-guarantee machinery they share, as of repo HEAD `63503f2`.

Primary sources:
`/Users/mike/agent-peers-mcp/codex-server.ts` (1169 lines),
`/Users/mike/agent-peers-mcp/claude-server.ts` (670 lines),
`/Users/mike/agent-peers-mcp/hermes-server.ts` (42 lines).

Shared modules:
`shared/delivery-state.ts`, `shared/codex-inbox.ts`, `shared/piggyback.ts`,
`shared/recent-delivered.ts`, `shared/wait-for-peer-messages.ts`, `shared/colleague-prompt.ts`,
`shared/hermes-claims.ts`, `shared/async-lock.ts`, `shared/peer-context.ts`, `shared/names.ts`,
`shared/summarize.ts`, `shared/tab-title.ts`.

Companion doc: `docs/delivery-contract.md` states the *guarantees*; this doc states the
*implementation*. Where the two disagree it is called out in [§8](#8-red-flags).

---

## 1. Purpose

Each agent session (a Claude Code tab, a Codex CLI thread, a Hermes surface) spawns exactly one
stdio MCP server process. That process is the session's membrane against the broker: it registers
a peer identity, heartbeats it, polls the broker's mailbox, and — the hard part — gets inbound
messages *in front of the model* despite each harness having a different and mostly hostile input
surface.

There are three surfaces because there are three harnesses with three different constraints:

| Surface | File | Delivery mechanism | Why |
| --- | --- | --- | --- |
| **Codex** | `codex-server.ts` | Piggyback `[PEER INBOX]` block prepended to every tool response | Codex CLI does not surface MCP `notifications/message` to the model (`codex-server.ts:127-137`), so a tool *response* is the only model-visible input channel. |
| **Claude** | `claude-server.ts` | `notifications/claude/channel` push + `check_messages` backfill | Claude Code has a live channel, but a push fired while the session is idle at the prompt queues invisibly (`claude-server.ts:8-17`, `shared/recent-delivered.ts:3-8`). |
| **Hermes** | `hermes-server.ts` | Re-exports the Codex transport with `peer_type="hermes"` | Hermes surfaces are per-turn processes with no idle push and no tty; the Codex piggyback pipeline works, the Codex *timeouts* do not. |

The delivery machinery exists to answer one question honestly: **"did the model actually see this
message?"** The universal invariant driving all of it is stated at `codex-server.ts:6-9`:

> No message is acked to the broker (nor pruned from the durable queue) until we have evidence the
> previous tool-response cycle actually completed. That evidence is "the harness called us again."

The result is deliberate at-least-once delivery. Duplicate presentation is possible; silent loss is
the thing being engineered out.

---

## 2. Structure

### 2.1 `codex-server.ts`

| Section | Lines | Contents |
| --- | --- | --- |
| Pipeline doc comment | 1-54 | The two-layer model (durable inbox + piggyback) and the shutdown contract |
| Constants / runtime selection | 83-95 | Port, poll interval, heartbeat, `RUNTIME_PEER_TYPE`, wait timeouts |
| Module state | 101-122 | `client`, `myId`/`myName`/`mySession`, `inboxStore`, `pollInFlight`, `isWakeableSession` |
| `Server` construction | 124-190 | Capabilities (`logging`, `tools`) + the model-facing `instructions` string |
| Tool table | 192-264 | Six tools (see [§3.1](#31-tools)) |
| Ack queue | 268-289 | `pendingAcks` (cap 500) + `enqueueAck` |
| Delivery state | 280 | `new DeliveryState()` |
| Wait loop adapter | 291-306 | Wires `shared/wait-for-peer-messages.ts` to the durable store + dedupe set |
| Broker fetch (unlocked) | 312-314 | `fetchBrokerLeases` — pure HTTP, no local state |
| Classify + upsert (locked) | 323-401 | `applyLeasedToQueue` — triage, persist, signal-only preview push |
| Unlocked poll entry | 409-433 | `pollBrokerIntoQueue` — fetch outside lock, apply inside |
| Piggyback lock | 440 | `withPiggybackLock = createAsyncLock()` |
| Request wrapper | 442-510 | `withPiggyback` — arrival snapshot, pre-read hook, batch, handler, promote/rollback |
| Critical section | 514-644 | `acquireInboxBatch` — confirm, ack-flush, inline poll, read/filter/draw |
| Watermark prune | 646-654 | `pruneSeenWatermark` |
| Tool dispatch | 656-773 | `CallToolRequestSchema` handler |
| Startup | 777-1070 | `main()` — signals, watchdog, activation gate, elections, register, loops |
| Wake registration | 1072-1156 | `registerWakeableSessionIfEnabled`, `resolveWakeRegistrationHints` |
| Fatal handler | 1158-1169 | Clear title, unregister, exit 1 |

**Startup order in `main()` is load-bearing** and commented as such:

1. Signal handlers (`SIGINT`/`SIGTERM`/`SIGHUP`/`SIGQUIT`) + `exit` armed *first* (`:781-794`) — an
   unhandled SIGHUP exits 129 without firing `exit`, which would strand a `peer:<name>` tab title.
2. Orphan-parent watchdog every 1s (`:799-805`) — Bun's stdio transport can outlive its app-server
   parent; `parentProcessWasLost` detects the reparent to launchd.
3. Activation gate (`:811-816`) — `AGENT_PEERS_ENABLED !== "1"` ⇒ connect, expose **zero tools**,
   return. No broker, no tab title.
4. Wake-launch election (`:828-855`) — only for Codex. See [§2.4](#24-two-elections).
5. Tab title placeholder + keepalive (`:867-868`) — before `register()` so there is no "node" window.
6. `ensureBroker` → `waitForSharedSecret` → `createClient` (`:870-873`).
7. `myCwd` from `AGENT_PEERS_CWD || process.cwd()` (`:879`), git root, tty.
8. Hermes name-claim election (`:888-902`).
9. Best-effort summary with a 3s race (`:904-918`).
10. `register()` → construct + `init()` the `CodexInboxStore` (`:920-934`).
11. Wake-registry upsert for Codex (`:935-944`).
12. `mcp.connect(new StdioServerTransport())` (`:959`).
13. Self-scheduling 1s poll loop (`:962-971`) and 15s heartbeat/rejoin loop (`:992-1051`).

### 2.2 `claude-server.ts`

| Section | Lines | Contents |
| --- | --- | --- |
| Pipeline doc comment | 1-17 | Poll → persist → push → ack; within-session dedupe scope |
| Constants | 43-46, 74-79 | Port, intervals, `CLAUDE_INBOX_ROOT`, watermark slack, `DeliveryState` |
| `Server` construction | 85-127 | `capabilities.experimental["claude/channel"]` + instructions |
| Tool table | 129-181 | Five tools — **no** `wait_for_peer_messages` |
| Tool dispatch | 185-338 | Confirm-on-entry block (`:200-209`) then the switch |
| `check_messages` | 253-316 | Ring buffer ∪ durable unread, draw/promote/rollback |
| Startup | 340-654 | `main()` |
| Poll+push loop | 458-559 | `pollAndPush` + self-scheduling timer |
| Heartbeat / rejoin | 573-628 | Eviction detection and re-registration |
| Fatal handler | 656-670 | Clear title, unregister, exit 1 |

The Claude side is structurally simpler because delivery is *push-first*: the poll loop persists,
acks, and pushes in one pass; `check_messages` is pure backfill. There is no per-request wrapper and
**no mutex** (see [§8](#8-red-flags), RF-1).

### 2.3 `hermes-server.ts`

42 lines, all of it configuration:

```
process.env.AGENT_PEERS_RUNTIME = "hermes";   // :22 — read by codex-server.ts:87
… kill-switch checks …
await import("./codex-server.ts");            // :40 — dynamic, AFTER the env mutation
```

Three gates before the import (`:24-38`), in order:

1. **Flag file** `~/.agent-peers-hermes/disabled` (or under `AGENT_PEERS_STATE_DIR` /
   `AGENT_PEERS_HERMES_STATE_DIR`) ⇒ force `AGENT_PEERS_ENABLED=0`. This exists for hosts where the
   operator cannot inject env into a Hermes-managed MCP launch.
2. **`AGENT_PEERS_HERMES_ROLE=passive`** ⇒ force `AGENT_PEERS_ENABLED=0`. Configuration-level
   override for hosts that *can* distinguish gateway from serve.
3. Otherwise `AGENT_PEERS_ENABLED ??= "1"` — Hermes defaults to enabled, but an explicit
   `AGENT_PEERS_ENABLED=0` still wins because `??=` does not overwrite an existing value.

Everything else — tools, delivery, elections — is `codex-server.ts` behaving differently because
`RUNTIME_PEER_TYPE === "hermes"`. The behavioral deltas are exactly:

- `WAIT_FOR_MESSAGES_DEFAULT_MS` and `..._MAX_MS` drop 300s → **60s** (`codex-server.ts:93-94`),
  because a Hermes surface is a per-turn process that can be torn down mid-wait.
- Wake-launch election and wake-registry registration are skipped (`RUNTIME_IS_CODEX` guards at
  `:830`, `:935`, `:1032`).
- The Hermes name-claim election runs (`:892-902`).
- The durable inbox root becomes `~/.agent-peers-hermes` via `defaultRootDir()`
  (`shared/codex-inbox.ts:52-55`).
- Instruction text swaps "Codex" for "Hermes" (`:142`, `:187`).

### 2.4 Two elections

Both exist because one logical agent can spawn several MCP children, and only one may own the peer
identity.

**Codex wake-launch election** (`codex-server.ts:828-855`, `shared/wake-launch-role.ts`). In
`--remote` mode the app-server spawns one agent-peers MCP *per Codex thread* — `thread/start`, cold
`thread/resume`, `thread/fork`, subagents, detached reviews — and keeps unsubscribed threads loaded
for 30 minutes. Every child used to call `register()`, so one `codexpeer` launch produced N
addressable peers (observed: 4 per app-server), and name-addressed mail landed on a twin the wake
daemon was not watching. There is *no* spawn-time signal identifying the owning thread
(`wake-launch-role.ts:22-35`), so the launcher writes a single-use claim and the first child to
`tryAcquireRoot` wins. Losers (`role === "secondary"`) expose a zero-tool MCP and return
(`:847-855`) — they must still start, because the launcher sets
`mcp_servers.agent-peers.required=true`. `AGENT_PEERS_WAKE_LAUNCH=1` is what distinguishes "secondary
thread of a wakeable launch" (go inert) from "ordinary `codex` session with no claim" (register
normally) — without it, gating would silently remove every plain Codex session from the network.

**Hermes name-claim election** (`codex-server.ts:888-902`, `shared/hermes-claims.ts`). Per Hermes
profile, both the gateway and the serve process load `hermes-server.ts` with the same `PEER_NAME` and
no cwd, so one profile registered 2-3 peers that the broker's suffix ladder disambiguated into
`ezra-hermes`, `-2`, `-3`. The Codex cwd/tty key cannot separate them, so the lock is keyed by
`PEER_NAME`. Unlike a Codex secondary, **the loser does not go inert** — it may be the surface the
user is currently talking through, so it keeps full tooling and registers under an ephemeral
generated name (`:897-901`); it simply never owns the address peers use.

---

## 3. Public interfaces

### 3.1 Tools

| Tool | Codex | Hermes | Claude | Notes |
| --- | :---: | :---: | :---: | --- |
| `list_peers(scope, peer_type?)` | ✅ | ✅ | ✅ | `scope` ∈ `machine \| directory \| repo`, required |
| `send_message(to_id, message)` | ✅ | ✅ | ✅ | `to_id` accepts UUID or name |
| `set_summary(summary)` | ✅ | ✅ | ✅ | |
| `check_messages()` | ✅ | ✅ | ✅ | Different semantics per side — see below |
| `wait_for_peer_messages(timeout_ms?, from?)` | ✅ | ✅ (60s cap) | ❌ | Codex/Hermes only |
| `rename_peer(new_name)` | ✅ | ✅ | ✅ | Renames *yourself*; 1-32 chars `[a-zA-Z0-9_-]` |

Codex/Hermes tool definitions: `codex-server.ts:192-264`. Claude: `claude-server.ts:129-181`.

Critically, **on Codex/Hermes every tool response carries the inbox**: `list_peers`, `send_message`,
`set_summary`, `check_messages`, `wait_for_peer_messages`, and `rename_peer` all route through
`withPiggyback` (`codex-server.ts:660`), so any of them prepends a `[PEER INBOX]` block.
`check_messages` itself is a no-op handler (`:701-704`) — the piggyback already did the work. On
Claude, **only `check_messages` surfaces the inbox** (`claude-server.ts:253-316`); the other four
tools return their own text and nothing else.

The model-facing behavioral protocol is `COLLEAGUE_PROTOCOL` (`shared/colleague-prompt.ts:13-105`),
imported verbatim by both servers specifically so the two ends cannot drift in how they treat
peer messages. Each server then appends its own delivery prologue (`codex-server.ts:138-188`,
`claude-server.ts:92-125`). Both prologues carry the same load-bearing rule: **call `check_messages`
first thing every user turn.**

### 3.2 Environment configuration

| Variable | Read at | Effect |
| --- | --- | --- |
| `AGENT_PEERS_ENABLED` | `codex-server.ts:811`, `claude-server.ts:347` | Must be exactly `"1"`. Anything else ⇒ zero-tool no-op MCP, no broker, no tab title. Hermes defaults it to `"1"` (`hermes-server.ts:37`). |
| `PEER_NAME` | `codex-server.ts:888`, `claude-server.ts:415` | Requested stable name. Also the durability trigger. |
| `AGENT_PEERS_EPHEMERAL` | `codex-server.ts:889`, `claude-server.ts:421` | `"1"` ⇒ register non-durable even with a `PEER_NAME`. |
| `AGENT_PEERS_CWD` | `codex-server.ts:879` | Codex/Hermes only. Hermes surfaces inherit an arbitrary cwd (`/`, the profile dir, a workdir — three "identities" for one agent), so profiles pin it. **Claude has no equivalent** and always uses `process.cwd()` (`claude-server.ts:392`). |
| `AGENT_PEERS_SECRET_PATH` | `codex-server.ts:106`, `claude-server.ts:60` | Override for the shared-secret file used by the readiness probe. |
| `AGENT_PEERS_PORT` | `:83` / `:43` | Broker port, default `7900`, loopback only. |
| `AGENT_PEERS_HEARTBEAT_MS` | `:86` / `:46` | Heartbeat interval, default 15000. |
| `AGENT_PEERS_RUNTIME` | `codex-server.ts:87`, `shared/codex-inbox.ts:53` | `"hermes"` selects the Hermes identity + inbox root. Set by `hermes-server.ts:22`. |
| `AGENT_PEERS_HERMES_ROLE` | `hermes-server.ts:33` | `passive` ⇒ inert surface, no peer identity. |
| `AGENT_PEERS_STATE_DIR` | `claude-server.ts:74`, `codex-inbox.ts:100`, `hermes-server.ts:25`, `hermes-claims.ts:30` | Overrides the inbox/claims root for whichever runtime reads it. |
| `AGENT_PEERS_CODEX_STATE_DIR` | `codex-inbox.ts:101` | Codex inbox root — but also relocates the **Hermes** inbox (see RF-10). |
| `AGENT_PEERS_HERMES_STATE_DIR` | `hermes-server.ts:26`, `hermes-claims.ts:31` | Kill-switch flag + name-claims only; **not** the inbox. |
| `AGENT_PEERS_WAKE_ENABLED`, `..._THREAD_ID`, `..._APP_SERVER_URL`, `..._APP_SERVER_PID`, `..._APP_SERVER_SOCKET_PATH`, `..._ROLLOUT_PATH` | `codex-server.ts:1125-1149` | Env-injected wake-registry hints; bypasses the claim store (`claim_id: "env"`). |
| `AGENT_PEERS_WAKE_LAUNCH` | `shared/wake-launch-role.ts:70` | `"1"` marks every MCP child of a wakeable app-server. |
| `AGENT_PEERS_DISABLE_TAB_TITLE` | `shared/tab-title.ts:53,89,122` | `"1"` opts out of OSC title writes. |
| `OPENAI_API_KEY` | `shared/summarize.ts:42` | Absent ⇒ auto-summary returns `""` (non-fatal). |

**Kill-switch flag file**: `~/.agent-peers-hermes/disabled` (`hermes-server.ts:24-32`). Presence
disables *every* Hermes surface at once. Remove the file and `/reload-mcp` to rejoin. There is no
equivalent flag file for Codex or Claude.

### 3.3 Durable inbox files

| Runtime | Default path | Selected by |
| --- | --- | --- |
| Codex | `~/.agent-peers-codex/<peer-uuid>.json` | `codex-inbox.ts:52-55` |
| Hermes | `~/.agent-peers-hermes/<peer-uuid>.json` | same, via `AGENT_PEERS_RUNTIME=hermes` |
| Claude | `~/.agent-peers-claude/<peer-uuid>.json` | `claude-server.ts:74` (`rootDir` arg) |

Alongside each, a **bodyless** sidecar `<peer-uuid>.metadata.json` is written best-effort on every
mutation (`codex-inbox.ts:206-215`, shape at `:27-41`): sender identity, ids and timestamps, **no
message text**. It exists for external observers (the wake daemon, `cli.ts inboxes`) that need to
know mail is waiting without being handed message bodies.

State file format (`codex-inbox.ts:23-25`):

```json
{ "unread": [ { "id": 42, "from_id": "...", "from_name": "...", "from_peer_type": "codex",
                "from_cwd": "...", "from_summary": "...", "to_id": "...", "text": "...",
                "sent_at": "...", "lease_token": "..." } ] }
```

**Security invariant** (`codex-inbox.ts:7-15`): these files mirror the broker's SQLite trust
boundary. Directory `0o700` with a defensive re-`chmod` (`:62-65`), file `0o600` written to
`${path}.tmp` then `rename`d atomically (`:67-79`). On read the store **fails closed**
(`:217-248`): if the path is not a regular file, is owned by another uid, or has any mode other
than exactly `0600`, it logs to stderr and returns an empty inbox rather than serving
possibly-tampered or possibly-leaked content.

All mutations serialize through a per-instance promise-chain lock (`:262-275`), and every accessor
calls `ensureLoaded()` (`:129-133`) — a constructed-but-never-`init()`ed store used to start
empty-but-writable, so the first write atomically clobbered the previous incarnation's mail.

---

## 4. Delivery lifecycle (the core)

### 4.1 The state machine — `shared/delivery-state.ts`

Five sets/maps track every message id through one process (`:37-42`):
`drawnByCall`, `drawn`, `presented`, `presentedGen`, `confirmed`, plus a monotonic `generation`.

| Transition | Method | Meaning |
| --- | --- | --- |
| → drawn | `draw(callId, ids)` `:60-70` | Dealt into a response *under construction*. Blocks re-deal. **Not** ack- or confirm-eligible. |
| drawn → presented | `promote(callId)` `:72-82` | That call's response was fully built and un-aborted. Increments `generation` and stamps each id with it. |
| drawn → (undrawn) | `rollback(callId)` `:84-89` | The call was aborted; its draws return to re-dealable. Nothing was acked, nothing pruned. |
| presented → confirmed | `confirmable(gen)` `:93-100` + `markConfirmed(ids)` `:103-109` | The caller acked the leases and pruned the store; these are now known-delivered. |
| confirmed → ∅ | `pruneConfirmedBelow(watermark)` `:112-114` | Bounded-memory GC. |

`isBlocked(id)` (`:52-54`) is `drawn ∪ presented ∪ confirmed` — the single predicate that prevents
re-dealing anything already in flight.

**Arrival generations.** `newArrival()` (`:47-49`) returns the current `generation`, and a call may
only confirm presentations whose `presentedGen <= arrivalGen`. The snapshot is taken at **request
entry** (`codex-server.ts:459`, `claude-server.ts:200`), *before* the pre-read hook, because
`wait_for_peer_messages` can park a request for minutes. Without the barrier, a parked call that
finally reaches the lock would confirm a *sibling's* response that was built long after the parked
call was issued — and that call is no evidence the model received it. This was the third-review H1
finding; the reasoning is recorded at `delivery-state.ts:20-29` and `codex-server.ts:453-458`.

**Ack-at-confirm-only.** Broker acks are enqueued exclusively at confirm time, never at draw
(`delivery-state.ts:31-34`, `codex-server.ts:275-279`). A message's lease deliberately expires and
re-offers while it sits drawn or presented; the poll triage dedupes the re-offer by id and
*refreshes the stored lease token*, so the eventual confirm acks the freshest token. Acking at draw
was the second-review H1 race: a concurrent call's flush acked messages that a cancelled call never
delivered.

### 4.2 Codex/Hermes request flow

Every tool call runs `withPiggyback` (`codex-server.ts:442-510`):

```
1. guard registered?                        :446-451
2. callId = randomUUID()                    :452
3. arrivalGen = delivery.newArrival()       :459   ← barrier, BEFORE the hook
4. await opts.beforeReadQueue?.()           :466-470  ← OUTSIDE the lock (can block minutes)
5. fresh = await withPiggybackLock(         :472
        () => acquireInboxBatch(callId, arrivalGen))
6. run the tool handler                     :483-494  ← OUTSIDE the lock (broker I/O, slow)
7. finalText = formatInboxBlock(fresh) + toolText     :496-497
8. signal.aborted ? rollback(callId)        :498-503
                  : promote(callId)         :504-508
```

Steps 4 and 6 are deliberately outside the lock; only the read-draw-mark critical section is
serialized. `createAsyncLock` (`shared/async-lock.ts:6-19`) is a minimal FIFO promise-chain mutex —
sufficient because JS is single-threaded.

Inside the lock, `acquireInboxBatch` (`:514-644`) runs four ordered steps:

**STEP 1a — confirm-promote** (`:532-545`). For ids in `confirmable(arrivalGen)`:
read the freshest lease tokens from the durable store → `removeByIds` → *only then* `enqueueAck` →
`markConfirmed`. Ordering matters: a broker ack is never sent for a message without model-delivery
evidence. A prune failure leaves everything confirm-pending and retries next call.

**STEP 1b — unconditional ack flush** (`:560-583`). Flushes step 1a's acks plus re-lease tokens the
triage stashed for already-confirmed messages. These must go out even on tool calls that draw
nothing, or the broker re-leases the row forever. Tokens are removed from `pendingAcks` only on HTTP
success; the response is **typed** (`acked`, `stale`, per-token `results` — `shared/types.ts:110-118`)
and a partial ack is logged explicitly rather than being swallowed as `{ok:true, acked:0}`.

**STEP 2 — inline poll** (`:596-600`). Collapses the worst-case "message landed 0.99s before this
tool call" tail. **This step deliberately bypasses `pollBrokerIntoQueue()`** and calls
`applyLeasedToQueue(await fetchBrokerLeases())` directly. The reason is a genuine deadlock:
`createAsyncLock` is **not reentrant**, and `pollBrokerIntoQueue` (`:409-433`) can `await` a
background `pollInFlight` promise that is itself queued on the very lock this code holds. The
fetch/apply split at `:312-314` / `:323-401` exists precisely so a locked caller can take the two
halves separately. A concurrent background fetch is harmless — its apply serializes behind us, and
the id-keyed upsert is re-offer-safe by design.

**STEP 3 — read, filter, draw** (`:608-635`). Read (never consume) the durable queue, drop anything
`isBlocked`, then `draw(callId, ids)`. This is the single write point where a message goes from
"sitting in the queue" to "dealt to a response".

**STEP 4 — watermark prune** (`:641`, `:646-654`). Message ids are AUTOINCREMENT-monotonic, so
anything below both the newest confirmed id (minus a 10,000 slack) and everything still queued can
never be re-offered in a way the state needs to dedupe. Guarded by `Number.isFinite` for the
empty-confirmed case.

### 4.3 The poll triage — `applyLeasedToQueue`

`codex-server.ts:323-401`, and it must run under the piggyback lock (`:315-322` explains why): the
`isConfirmed`/`isBlocked` classification and the queue upsert have to be atomic with respect to a
concurrent confirm's read-token → remove → `markConfirmed` sequence. An upsert interleaved into that
window resurrects a just-confirmed row as unread, or makes the confirm ack a token the upsert is
about to replace.

Per leased message:

- **Already confirmed** (`:330-336`) ⇒ `enqueueAck(lease_token)` and drop it. We hold delivery
  evidence; the re-offer just means an earlier ack was lost or the lease expired first.
- **Fresh, drawn, or presented** (`:337-344`) ⇒ upsert into the durable store. For drawn/presented
  ids this *refreshes the stored lease token*. **Never** ack here.

Persistence happens first (`:349-361`); if it fails, nothing is pushed and nothing is acked — the
lease expires at the broker and the message re-leases.

Then, for genuinely-new ids only, a **signal-only** MCP `notifications/message` push
(`:363-400`, text from `shared/piggyback.ts:27-33`). It carries the sender's name and peer type plus
a pointer to the next tool call — **no body, no `reply_action`**, enforced by tests in
`tests/piggyback.test.ts:83-113`. The split exists to avoid double-reply: a Codex that *does* render
the log would otherwise see the message twice (once as a preview, once in `[PEER INBOX]`). It
updates **no** dedupe state; `[PEER INBOX]` is the one and only "shown to the model" trigger.

### 4.4 `wait_for_peer_messages`

`shared/wait-for-peer-messages.ts` splits the decision from the loop so the short-circuit is
unit-testable.

`planWaitForPeerMessages` (`:33-49`) throws on a non-finite explicit timeout, clamps to
`[0, maxMs]`, then returns `skip-wakeable` or `wait`. Wakeable sessions skip entirely
(`codex-server.ts:759-762`, tool response at `:706-719`): the wake daemon starts a fresh turn the
instant mail arrives, so blocking would only pin the turn "working" for minutes and make the session
look hung. `isWakeableSession` is set at `codex-server.ts:1117`.

`waitForFreshPeerMessages` (`:58-80`) is a poll/read/sleep loop. The adapter at
`codex-server.ts:291-306` supplies `isFresh`:

```ts
isFresh: (m) => !delivery.isBlocked(m.id) && (!from || m.from_id === from || m.from_name === from)
```

The `from` filter governs only **what ends the wait**. Non-matching mail stays queued and still
surfaces in this response's `[PEER INBOX]` — it is never consumed by a wait it did not satisfy. This
was `known-issues-2026-08-08 §1`: Marco's wait for Kepler ate an unrelated Vector message.

### 4.5 Claude flow

**Push path** (`claude-server.ts:458-543`), every 1s via a self-scheduling non-overlapping timer
(`:552-559` — `setInterval` would overlap under slow I/O and double-push):

1. `pollMessages` from the broker.
2. Already in the in-memory `seen` set ⇒ queue the new lease token, do **not** re-push (`:464-469`).
3. Otherwise **persist to the durable store first** (`:474-479`). On write failure: no push, no ack,
   the lease expires and re-offers. Acking before any durable record existed is what made a
   queued-while-idle push die with the process, already-acked and untraceable.
4. Durable copy exists ⇒ add to `seen`, queue the ack, then best-effort
   `notifications/claude/channel` push (`:492-506`) and `recordDelivered` into the ring buffer
   (`:508`). Push failure is logged and tolerated — `check_messages` will surface it.
5. Watermark-prune `seen` (`:519-525`), prune confirmed ids (`:532`), single batched
   `ackMessages` (`:533-539`).

Note the `meta` payload is `Record<string,string>`: the numeric `message_id` is stringified and
`source` is omitted because the channel auto-generates it from the server name (`:487-491`).

**Backfill path** — `check_messages` (`:253-316`) unions two sources:

- The **ring buffer** (`shared/recent-delivered.ts`): module-level, bounded by `RECENT_MAX = 50`
  entries and `RECENT_TTL_MS = 15 min` (`:30-31`), pruned on read and write (`:37-45`). Lost on
  restart, which is fine — the colleague protocol treats each session as a fresh conversation.
- **All unread durable mail at any age** (`:283-291`), skipping `isBlocked` ids. Age-gating durable
  unread behind the ring buffer's 15-minute window was a silent-loss path for sessions idle longer
  than the TTL. **There is no TTL on unread durable mail** (`:526-531`): an unread entry is mail the
  model has never seen and the broker already acked, so deleting it on a timer is silent loss. Entries
  leave only via confirm-on-next-call or the rejoin migration; a dead session's file is *archived,
  never deleted*, by `cli.ts gc-inboxes`.

Both are merged by id, sorted, formatted through the same `formatInboxBlock` Codex uses
(`shared/piggyback.ts:35-63`), then drawn/promoted/rolled-back exactly like the Codex path
(`:303-315`).

**Confirm** happens at the top of *every* tool call (`:200-209`), not just `check_messages`:
snapshot `arrivalGen`, `removeByIds(confirmable)`, `markConfirmed`. No ack is involved — Claude
already acked at poll time; the confirm only prunes the durable store.

### 4.6 Failure semantics summary

| Event | Result |
| --- | --- |
| Response dropped / request aborted | `rollback` ⇒ ids re-dealable, nothing acked, nothing pruned ⇒ re-delivered next call |
| MCP process dies after draw, before confirm | Durable file keeps the message; broker lease expires and re-offers; next incarnation re-delivers |
| Durable write fails | No push, no ack; broker re-leases |
| Ack HTTP fails | Tokens stay in `pendingAcks`; retried next call |
| Ack succeeds with `acked < sent` | Logged with per-token statuses; the re-lease refreshes the token and the confirm/triage path re-acks |
| Broker down > 60s (peer GC'd) | Heartbeat returns `known:false` ⇒ re-register with `prev_id`, migrate the durable inbox, re-point the wake registry |
| Shutdown | Timers cleared. **No** `pendingAcks` flush (those may never have reached the model), **no** unregister (preserves the 60s reclaim-by-name window), durable queue stays on disk |

The `known === undefined` case is explicitly **not** eviction (`codex-server.ts:983-985`,
`claude-server.ts:570-571`) — it means the broker predates the field. Never re-register on silence,
only on an explicit "no".

### 4.7 Hermes name-claim election details

`shared/hermes-claims.ts`. Lock file at `<root>/name-claims/<encodeURIComponent(name)>.lock`
containing `{owner_pid, acquired_at}`, mode `0600`, dir `0700`.

`tryAcquire` (`:77-114`) loops up to 3 times:

1. `writeFile(..., {flag: "wx"})` — exclusive create is atomic on POSIX; exactly one surface wins.
2. On `EEXIST`, read the holder. `ENOENT` (lock vanished between wx and read) ⇒ retry. Unreadable or
   corrupt ⇒ **fail closed**, return false.
3. Same `owner_pid` ⇒ idempotent true.
4. `ownerStillHoldsClaim` ⇒ false (someone else owns it).
5. Dead owner ⇒ **atomic rename reclaim** (`:106-110`). A plain unlink+retry races a concurrent
   reclaimer: after a SIGKILL, gateway and serve boot together, both read the dead pid, one unlinks
   and re-creates via `wx`, and the other then unlinks the *fresh winner's* lock — both win.
   `rename()` is the atomic claim on the stale file: exactly one renamer succeeds, the loser gets
   `ENOENT` and loops back to a plain `wx` against whatever the winner wrote.

`ownerStillHoldsClaim` (`:53-66`) is the **PID-reuse guard**: after a reboot an unrelated process can
inherit the old owner's pid, making a dead claim look held forever and stranding the canonical name.
A pid only vouches for the lock if its process **started before the lock was acquired**, checked via
`ps -p <pid> -o lstart=` with a **2s tolerance** (`ps` lstart has 1s precision). If `ps` cannot
answer — EPERM'd zombie, parse failure, race — it falls back to pid-liveness alone, the conservative
side.

`release` (`:117-123`) is owner-checked: a loser releasing is a no-op, so it can never delete the
winner's lock. Called from `lifecycleCleanup` (`codex-server.ts:1063-1065`).

---

## 5. Dependencies

- **`@modelcontextprotocol/sdk` ^1.27.1** (`package.json:12`) — `Server`, `StdioServerTransport`,
  `ListToolsRequestSchema`, `CallToolRequestSchema`. The SDK supplies `extra.signal` (the
  cancellation `AbortSignal` consumed at `codex-server.ts:746` / `claude-server.ts:310`) and
  `mcp.notification(...)` for both the Codex log preview and the Claude channel push.
- **`shared/broker-client.ts`** — the typed HTTP wrapper: `register`, `heartbeat`, `unregister`,
  `setSummary`, `listPeers`, `sendMessage`, `pollMessages`, `ackMessages`, `renamePeer`, plus
  `createReadinessProbe`. The probe is **authenticated and fail-closed**: only a `/ready` answering
  with the shared secret, `protocol === 1`, launchd ownership, and the expected DB identity counts as
  alive — a bare `/health` 200 from a squatter must not satisfy startup.
- **`shared/ensure-broker.ts`** + **`shared/shared-secret.ts`** — kickstart the launchd broker and
  block until the secret file exists, before `createClient`.
- **Bun** — `Bun.spawn` / `Bun.spawnSync` for `git rev-parse`, `git branch`, `git log`, and `ps`
  (`shared/peer-context.ts`, `shared/summarize.ts`, `shared/hermes-claims.ts:59`); `Bun.hash` for
  `expectedDbIdentityHash`; the `bun` runtime is the `command` in every harness config.
- **Node built-ins** — `node:fs/promises` (atomic inbox writes), `node:fs` sync (`tab-title.ts`
  writes OSC sequences to `/dev/tty`), `node:os`, `node:path`, `crypto.randomUUID`.
- **OpenAI API** (optional) — `shared/summarize.ts:53-66`, model `gpt-5.4-nano`, only when
  `OPENAI_API_KEY` is set.

---

## 6. Entry points

Each server is a `#!/usr/bin/env bun` script run as a stdio MCP child.

**Claude Code** (`README.md:95`):

```bash
claude mcp add --scope user --transport stdio agent-peers -- bun "$AGENT_PEERS_DIR/claude-server.ts"
alias agentpeers='AGENT_PEERS_ENABLED=1 claude --dangerously-skip-permissions \
  --dangerously-load-development-channels server:agent-peers'
```

Registered globally, so *every* `claude` session spawns the process; the alias is what sets
`AGENT_PEERS_ENABLED=1`. Plain `claude` gets the no-op MCP (`claude-server.ts:341-352`).
`--dangerously-load-development-channels server:agent-peers` is what makes the `claude/channel`
capability (`:88-90`) usable.

**Codex CLI** (`README.md:140-144`), `~/.codex/config.toml`:

```toml
[mcp_servers.agent-peers]
command = "bun"
args = ["$AGENT_PEERS_DIR/codex-server.ts"]
env = { "AGENT_PEERS_ENABLED" = "1" }
```

**Wakeable Codex** — `wakeable-codex.ts` → `shared/wakeable-launcher.ts` starts an app-server-backed
TUI and injects per-launch config via `-c mcp_servers.agent-peers.env.*` overrides
(`wakeable-launcher.ts:117-133`, `:158-159`): the `AGENT_PEERS_WAKE_*` hints, `PEER_NAME`,
`AGENT_PEERS_WAKE_LAUNCH=1`, and `mcp_servers.agent-peers.required=true` (which is why secondaries
must still expose an MCP rather than exiting). The thin resume TUI is launched with
`AGENT_PEERS_ENABLED=0` (`:184-193`) so it never takes an identity. `bin/codex-peer` is the
user-facing wrapper (aliases `peerwake`, `adspeer`, `ccrpeer`, `peerlist`, …).

**Hermes Agent** (`README.md:168-173`):

```bash
hermes mcp add agent-peers --command bun --env AGENT_PEERS_ENABLED=1 \
  --args "$HOME/agent-peers-mcp/hermes-server.ts"
hermes mcp test agent-peers
```

Hermes supports MCP reload, so an existing conversation can join with `/reload-mcp`. Codex cannot:
an idle stock Codex thread can only be made wakeable by resuming it through
`codex-peer resume <session-id>`.

---

## 7. Cross-cutting side effects

**Terminal tab title** (`shared/tab-title.ts`). Writes OSC 0, 1 and 2 (`:43-50`) — terminals disagree
about which one is "the tab title", iTerm2 uses OSC 1 — re-asserted every 1s (`:37`, `:88-99`)
because terminals overwrite the title with the foreground process name. Control characters are
stripped from the title (`:56`) so a peer name can never inject escape sequences. The keepalive timer
is `unref`'d so it never keeps the process alive on its own. Cleared synchronously on exit and on all
four fatal signals.

**Auto-summary** (`shared/summarize.ts`). `git branch --show-current` + `git log --name-only -n 10`
(deduped, capped at 20 paths) fed to `gpt-5.4-nano` with an 8s timeout. Registration races it with a
3s cap (`codex-server.ts:918`, `claude-server.ts:411`) and uploads late via `setSummary` if it
finishes afterwards. Every failure path returns `""`.

**Peer context** (`shared/peer-context.ts`). `getGitRoot` shells `git rev-parse --show-toplevel`;
`getTty` tries `ps -o tty=` for this pid, then the parent's, treating `?`/`??` as no tty.

**Names** (`shared/names.ts`). `isValidName` (`:77-81`) gates `rename_peer` on both servers:
1-32 chars, `^[a-zA-Z0-9_-]+$`. `generateName`/`generateSuffixWord` are broker/CLI-side.

---

## 8. Red Flags

Severity: **H** = can lose or duplicate mail / corrupt state · **M** = correctness or maintenance
hazard · **L** = smell, dead code, or hardcoded value.

### Concurrency and delivery correctness

- **RF-1 (H) `claude-server.ts:253-316`** — `check_messages` has **no mutex** around its
  read → draw window. Two parallel calls (Claude Code batches tool calls) both read the durable store
  before either reaches `delivery.draw()` at `:303`, so the
  same message is presented twice in one turn and the model may reply twice. (The read is the
  `for (const m of await inboxStore.getUnreadMessages())` at `:285`.) This is exactly the race
  `withPiggybackLock` (`codex-server.ts:440`, rationale at `:434-439`, bd-21r.3) fixes on the Codex
  side; the fix was never ported.
- **RF-2 (M) `claude-server.ts:595-617`** — the rejoin migration lacks the
  `myId !== again.id` guard that `codex-server.ts:1014` has. If `register()` returns the *same* UUID,
  `prevStore` and the new `inboxStore` address the same file with independent locks and in-memory
  state: `queueLeasedMessages(carried)` writes them back, then `prevStore.removeByIds(...)` filters
  them out of its own stale snapshot and persists an **empty** file. In-memory state survives, so
  nothing is lost unless the process dies before the next write. Currently hard to reach (the
  broker's reclaim path at `broker.ts:417-445` requires a stale row), but it is a live footgun.
- **RF-3 (M) `codex-server.ts:373-400`** — the best-effort preview push is `await`ed **per message
  inside the piggyback lock** (`applyLeasedToQueue` is only ever called under it, `:425` and `:597`).
  A slow or wedged transport stalls every concurrent tool call for the duration. The push is declared
  non-fatal; it should not be able to block the critical section.
- **RF-4 (M) `shared/codex-inbox.ts:67`** — the temp path is a fixed `${path}.tmp`. Two
  `CodexInboxStore` instances over one file (the RF-2 rejoin window, or two MCPs that resolved the
  same peer id) can interleave `writeFile`/`rename` on the same temp path. A pid- or random-suffixed
  temp name would make the atomic-rename guarantee actually hold under that aliasing.
- **RF-5 (M) `codex-server.ts:282-289`** — `enqueueAck` silently drops the **oldest** tokens when
  `pendingAcks` exceeds the hardcoded 500. Dropped tokens leave broker leases open. It self-heals
  (the re-offer hits the `isConfirmed` branch at `:330`), but the trim discards ack intent with only
  a log line, and 500 is a magic number.
- **RF-6 (L) `shared/delivery-state.ts:37,60-70`** — `drawnByCall` has no eviction path. A caller
  that draws but neither promotes nor rolls back leaks the entry forever and `drawn` blocks those ids
  from ever being re-delivered. Both current callers are correct, but nothing enforces the invariant.

### Asymmetries between the Claude and Codex servers

- **RF-7 (L) `claude-server.ts:532`** — `delivery.pruneConfirmedBelow(delivery.maxConfirmed() -
  SEEN_WATERMARK_SLACK)` lacks the `Number.isFinite` guard that `codex-server.ts:650` has. On an
  empty confirmed set this passes `-Infinity`; harmless today, but it is the same computation
  written two different ways in two files.
- **RF-8 (L) `claude-server.ts:523`** — `Math.max(...seen)` spreads the whole dedupe set as function
  arguments. Bounded by the watermark in practice, but a spread over a large set risks a
  `RangeError`; `codex-server.ts:648-653` iterates instead.
- **RF-9 (M) `claude-server.ts:212-250`, `:318-337`** — `list_peers`, `send_message`, `set_summary`
  and `rename_peer` make broker calls with **no `try`/`catch`**. A transient HTTP failure throws out
  of the handler. `codex-server.ts:491-494` catches and returns a typed tool error. Relatedly,
  `claude-server.ts:336` `throw`s on an unknown tool where `codex-server.ts:743` returns
  `{isError: true}`.

### Configuration and paths

- **RF-10 (M) `shared/codex-inbox.ts:52-55,99-102` vs `hermes-server.ts:24-29` and
  `shared/hermes-claims.ts:29-34`** — inbox root resolution honors `AGENT_PEERS_STATE_DIR` and
  `AGENT_PEERS_CODEX_STATE_DIR` but **not** `AGENT_PEERS_HERMES_STATE_DIR`. Two consequences: setting
  the Hermes-specific variable relocates the kill-switch flag file and the name-claims directory but
  leaves the durable inbox at the default; and setting the *Codex* variable silently relocates the
  **Hermes** inbox. `docs/delivery-contract.md:79` documents only the default path and never mentions
  `AGENT_PEERS_HERMES_STATE_DIR` at all.
- **RF-11 (M) `codex-server.ts:87` + `hermes-server.ts:22,40`** — `RUNTIME_PEER_TYPE` is captured
  from `process.env.AGENT_PEERS_RUNTIME` at module-evaluation time, and Hermes relies on mutating the
  env *before* a **dynamic** `import()`. Correct as written, but a static import or a bundler that
  hoists the import would evaluate the constant first and silently register every Hermes surface as
  `peer_type: "codex"`. Nothing in the code prevents that refactor.
- **RF-12 (L) `hermes-server.ts:24-32`** — the flag-file kill switch exists only for Hermes. Codex
  and Claude can be disabled solely through env, which is exactly the situation (operator cannot
  inject env into a harness-managed launch) that motivated the Hermes flag file.

### Wake / election / lifecycle

- **RF-13 (M) `codex-server.ts:1117`** — `isWakeableSession` is set to `true` and never cleared. If
  the wake daemon dies or the registry row goes stale, `wait_for_peer_messages` keeps short-circuiting
  (`:759-762`) and the session silently loses its only standby mechanism while still telling the model
  "the daemon will wake you".
- **RF-14 (M) `codex-server.ts:730-740`** — `rename_peer` does not move the Hermes name claim.
  `hermesClaimedName` (`:895`) keeps the original `PEER_NAME`, so after a rename the lock protects a
  name this peer no longer holds, and the name it *does* hold is unprotected against a sibling
  surface.
- **RF-15 (M) `codex-server.ts:1056-1066`** — `lifecycleCleanup` (and therefore the Hermes claim
  release at `:1063-1065`) runs **only** from the signal handlers. A plain stdin-close / transport
  teardown exits via the `exit` handler, which only clears the tab title, so the lock file is left
  behind and reclaim falls to the dead-pid path in `hermes-claims.ts:98`.
- **RF-16 (L) `codex-server.ts:799-805`** — the 1s parent watchdog is started **before** the
  `AGENT_PEERS_ENABLED` gate at `:811`, so even a fully disabled no-op MCP burns a timer for the life
  of the process. The Claude server starts its watchdog after the gate (`claude-server.ts:637-643`).
- **RF-17 (L) `codex-server.ts:1121-1124,1112`** — `resolveWakeRegistrationHints` declares a
  `{cwd, tty}` parameter but is called with the full registration opts object (`:1080`), and the
  env-var branch invents the stringly-typed sentinel `claim_id: "env"` that is compared by string
  equality at `:1112`. A discriminated union would make the two hint sources explicit.
- **RF-18 (M) `codex-server.ts:749-762`** — `planWaitForPeerMessages` throws on a non-finite
  `timeout_ms` (`wait-for-peer-messages.ts:40-42`), but the throw is swallowed by the hook's
  `try`/`catch` at `:466-470`; the model then sees `"wait_for_peer_messages did not run."` with no
  reason. The declared `minimum`/`maximum` at `:239-243` are documentation only — nothing validates
  the argument.

### Error handling and observability

- **RF-19 (M) `shared/codex-inbox.ts:217-259`** — one `catch` covers the perm stat, `readFile`, and
  `JSON.parse`, so genuine corruption is indistinguishable from `ENOENT` and silently yields an empty
  inbox (the comment at `:254-259` acknowledges this). The corrupt file is then overwritten by the
  next write with no quarantine copy — for a store whose entire purpose is not losing mail, that is
  the wrong default.
- **RF-20 (L) `shared/peer-context.ts:24`, `shared/summarize.ts:13,27`, `shared/hermes-claims.ts:59`**
  — `git` and `ps` are shelled out with **no timeout**. The summary path is protected by the 3s race
  (`codex-server.ts:918`), but `getGitRoot` at `:880` is awaited unbounded, so a hung `git` (index
  lock, network filesystem) blocks registration indefinitely.
- **RF-21 (L) `shared/hermes-claims.ts:59-64,80`** — hardcoded values in the election: 3 acquire
  attempts, a 2s `lstart` tolerance, and locale/format-dependent parsing of `ps -o lstart=` output.
  Every parse failure falls back to "owner still holds", i.e. toward stranding the canonical name.
- **RF-22 (L) `shared/tab-title.ts:59-76,124`** — `/dev/tty` is opened and closed fresh on every
  keepalive tick (1s, forever). Write failures warn exactly once and then no-op silently; the warn
  gate resets only on `setTabTitle` (`:80`), so a tty that comes back is never re-reported.

### Dead code, hardcoded values, privacy

- **RF-23 (L) `claude-server.ts:31` and `codex-server.ts:68`** — `clearTabTitle` is imported in both
  servers and used in neither (only `clearTabTitleSync` is). Dead import ×2.
- **RF-24 (L) `shared/codex-inbox.ts:291`** — `EMPTY_CODEX_INBOX_STATE` is exported and referenced
  nowhere in the repo, including tests. Dead export.
- **RF-25 (L) `shared/codex-inbox.ts:161-171`** — `consumeUnreadMessages` has no production caller
  (tests only), and the comment at `:176-178` explains why it must *not* be used for the confirm
  flow. Either delete it or mark it test-only.
- **RF-26 (L) `shared/recent-delivered.ts:33,58`** — module-level mutable singleton shared by every
  importer in the process, with `__resetRecentDeliveredForTest` exported from production code.
- **RF-27 (M) `shared/summarize.ts:41-66`** — whenever `OPENAI_API_KEY` is present, registration
  uploads the peer's cwd, git root, branch, and up to 20 recently-changed file paths to
  `api.openai.com`. There is **no opt-out flag** (contrast `AGENT_PEERS_DISABLE_TAB_TITLE`), the model
  id `gpt-5.4-nano` and the 8s timeout are hardcoded, and nothing in the README or the delivery
  contract flags the egress.

### Doc / code agreement

`docs/delivery-contract.md` was checked line-by-line against the code at `63503f2`. Its substantive
claims — write-before-push, ack-only-after-persistence, confirm-on-next-call for Codex/Hermes, the
arrival-causality barrier, the 300s vs 60s wait caps, `from`-filter non-consumption, no TTL on unread
durable mail, the `PEER_NAME` + `AGENT_PEERS_EPHEMERAL != "1"` durability rule, and the Hermes
election with non-inert losers — **all match the implementation**. Two gaps rather than
contradictions:

- **RF-28 (L) `docs/delivery-contract.md:79`** — states the Hermes inbox path as a fact without
  noting it is overridable, and omits `AGENT_PEERS_HERMES_STATE_DIR` entirely. See RF-10 for why that
  variable is the confusing one.
- **RF-29 (L) `docs/delivery-contract.md:60-61`** — "All inbox steps … run under a per-process mutex;
  parallel/batched tool calls cannot double-deliver" appears only under the Codex heading and is
  accurate there. The Claude section (`:31-50`) makes no equivalent claim and the code has no mutex
  (RF-1). A reader scanning for the guarantee is likely to assume parity; the Claude section should
  state the absence explicitly.
