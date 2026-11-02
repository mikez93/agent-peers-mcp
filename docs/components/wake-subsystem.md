# Codex Wake Subsystem

Truth-from-code documentation of the Codex wake path in `agent-peers-mcp`, as of repo HEAD `9be6159`.
Line numbers are left out on purpose; use function names.

Primary sources:
`wake-daemon.ts`, `wakeable-codex.ts`, `bin/codex-peer`, `shared/wake-daemon.ts`,
`shared/wakeable-launcher.ts`, `shared/wake-launch-claims.ts`, `shared/wake-registry.ts`,
`shared/app-server-client.ts`, `shared/codex-desktop-wake.ts`, `shared/wake-launch-role.ts`,
`shared/state-dir.ts`, `shared/bounded-log.ts`, `shared/process-lifecycle.ts`.

Supporting (read for accuracy, documented elsewhere): `codex-server.ts`, `cli.ts`,
`shared/codex-inbox.ts`, `deploy/linux/agent-peers-wake.service`.

Operator-level companions: [`docs/wakeable-codex.md`](../wakeable-codex.md) (design rationale and
security model) and [`docs/wake-daemon.md`](../wake-daemon.md) (log reading and tuning). This file is the
implementation-level reference. Hermes, OpenClaw, Claude and Droid wakes are separate:
[hermes-desktop-wake.md](hermes-desktop-wake.md), [openclaw-peer.md](openclaw-peer.md),
[../wakeable-droid.md](../wakeable-droid.md).

---

## 1. Purpose

Stock Codex CLI surfaces peer messages **only on the response to an agent-peers tool call**. A Codex
session parked at its prompt calls no tools, so mail sits in its inbox until the human types something.
Codex exposes no MCP push channel (`tools` is the only supported MCP feature), so there is no way to hand
an idle session a message from outside.

The wake subsystem makes wakeability a **property of how the session was started** instead of forking the
Codex binary. There are two ways a Codex session becomes wakeable:

1. **Managed launch** (`codex-peer`). `codex-peer` starts Codex under a **managed app-server** (`codex
   app-server --listen ws://...`) bound to one thread, with a visible `codex resume --remote <url>
   <thread>` TUI attached to that *same* thread. The agent-peers MCP that the app-server spawns records
   `peer_id -> { app_server_url, thread_id, ... }` in a durable **wake registry**.
2. **Codex desktop chat** (section 3.6). A chat opened in the Codex desktop app, including one opened over
   SSH on another machine, runs under an app-server the app owns. Its agent-peers MCP discovers that
   app-server's unix socket and registers the same kind of registry row.

Either way, a **wake daemon** polls, every 5 s, for peers that have unread mail and a loaded thread. An
**idle** thread gets a bodyless wake prompt through `turn/start`. A **busy** thread gets the wake appended
to its running turn through `turn/steer` (section 3.5). The prompt carries no message content: it only
tells the model to call `check_messages`, which remains the single authoritative delivery path.

The woken session is the same live instance: same thread, same rollout file, same visible TUI. It is never
killed or restarted with fresh context.

---

## 2. Component map

| File | Role |
| --- | --- |
| `bin/codex-peer` | Operator shell wrapper: launch, daemon lifecycle, inspect/repair/retire. Delegates every non-daemon subcommand to `cli.ts`. |
| `wakeable-codex.ts` | Small entry point; parses argv and calls `runWakeableLauncher`. |
| `shared/wakeable-launcher.ts` | The two-phase launch: throwaway app-server to materialize/inspect the thread, then the visible app-server + TUI. Writes the launch claim. |
| `wake-daemon.ts` | One-shot entry point. Runs the Codex pass, then the Hermes chat pass and the OpenClaw pass (both inert until opted in), formatting results as log lines or `--json`. |
| `shared/wake-daemon.ts` | The Codex wake engine (`runWakePass`) plus two private stores: `WakeLedger` (re-wake backoff) and `WakeObservationLog` (log coalescing and wedged-peer re-check backoff). |
| `shared/wake-registry.ts` | Durable `peer_id -> app-server/thread` registry with pid/socket liveness, GC, and a cross-process file lock. |
| `shared/wake-launch-claims.ts` | Launcher to MCP-child handshake file, plus the atomic root-election lock. |
| `shared/wake-launch-role.ts` | Pure decision function: `standalone` / `root` / `secondary`, and `canUseLegacyWakeEnv`. |
| `shared/codex-desktop-wake.ts` | Exact-thread registration for Codex desktop chats (section 3.6). |
| `shared/app-server-client.ts` | Minimal WebSocket JSON-RPC client for the Codex app-server, with bounded connect/request timeouts. |
| `shared/state-dir.ts` | `resolveStateDir`: one resolver for inbox and coordination directories. |
| `shared/bounded-log.ts` | Size-rotating private log used for app-server stdout/stderr. |
| `shared/process-lifecycle.ts` | `parentProcessWasLost(initial, current)`: orphan-parent watchdog predicate. |

---

## 3. Lifecycle

### 3.1 Launch (`bin/codex-peer` -> `wakeable-codex.ts` -> `runWakeableLauncher`)

`start_peer` does four things in order: validate the repo path, ensure `codex` is on PATH, **auto-start the
background wake daemon** (`ensure_daemon`), and resolve a non-colliding peer name via `cli.ts suggest-name`.
The default name comes from `peer-name.ts` (persona, repository and harness, for example
`vector-agentic-coding-resources-codex`). It then runs `bun wakeable-codex.ts --cwd <repo> --name <peer>`.

`runWakeableLauncher` runs two phases:

**Phase 1: resolve the thread on a throwaway app-server.** A fresh launch calls `materializeThread`;
`--thread-id` calls `inspectExistingThread`. Both spawn a *separate, short-lived* app-server configured with
`mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED="0"` (`buildMaterializeMcpConfigArgs`), so its agent-peers
MCP early-returns and registers **nothing**. A fresh thread is created with `thread/start` and materialized
with `thread/name/set`: naming a thread persists its rollout JSONL without running a model turn. The
materialize client declares the `experimentalApi` capability and starts the thread with
`historyMode: "legacy"`, because codex-cli 0.151.0 made `paginated` history the default and, under it,
`thread/name/set` succeeds without ever writing a rollout. `waitForRolloutOnDisk` then blocks until the
file exists and is non-empty, because `codex resume --remote <threadId>` fails with `no rollout found for
thread id ... (code -32600)` otherwise. The throwaway app-server is always killed in a `finally`.

Fresh threads also get explicit permissions, since `thread/start` does not inherit the CLI's user-level
defaults: approval policy `never` and sandbox `danger-full-access`, unless native Codex flags or config
narrow them (`--full-auto`, `-a`, `-s`, `-c approval_policy=...`, `-c sandbox_mode=...`; the launcher
verifies that the app-server echoed the requested values). Model `gpt-5.6-sol` and reasoning effort `high`
are also set for fresh threads. Resumed threads keep their saved settings.

**Phase 2: the visible session.** A port is allocated by binding `:0` and closing (`allocatePort`), the
resume app-server is spawned with `buildResumeAppServerArgs` and waits on `http://127.0.0.1:<port>/readyz`
for up to 10 s. That argument list carries, in order: fresh-thread model and permission config, the
caller's `-c`/`--config`/`--enable`/`--disable` overrides (other passthrough arguments stay TUI-only), and
last the launcher invariants from `buildResumeMcpConfigArgs`: the peer name, forwarded state directories,
`AGENT_PEERS_WAKE_LAUNCH="1"`, and `mcp_servers.agent-peers.required=true`. The launch claim is then updated
to `status: "ready"` with the resume app-server's URL/pid and the thread id/rollout path. Finally the
visible TUI is spawned with `stdin/stdout/stderr: "inherit"` and the launcher blocks on `tui.exited`; when
the TUI exits, the resume app-server is SIGTERM'd, and if phase 2 never reached `ready` the claim is marked
`failed`.

Both app-servers' stdout/stderr are pumped into a per-peer bounded log at
`<coordination root>/logs/<peer>-app-server.log`, so launcher plumbing never touches the session window.

### 3.2 Claim and root election

In `--remote` mode the **app-server**, not the thin resume TUI, spawns the agent-peers MCP, and it spawns
**one per Codex thread**. `thread/start`, a cold resume, `thread/fork`, a spawned subagent and a detached
review each create a Session with its own stdio MCP child, and unsubscribed threads stay loaded for 30
minutes, so children accumulate. Every child used to call broker `register()` unconditionally, so one launch
produced N addressable peers and mail addressed to the canonical name could land in a twin the daemon was
not watching.

There is no spawn-time signal identifying the owning thread (the stdio child gets a cleared environment;
`cwd`, `ppid` and tty do not disambiguate; Codex stamps `_meta.threadId` on `tools/call` but not on the
startup `tools/list`). So the launcher elects instead; the full argument is in the header comment of
`shared/wake-launch-role.ts`.

The election in `codex-server.ts`:

1. `isWakeLaunchEnv(process.env)`: is `AGENT_PEERS_WAKE_LAUNCH === "1"`? If not, this is an ordinary `codex`
   session (or a desktop chat) and the role is `standalone`: it registers as always.
2. `WakeLaunchClaimStore.findMatching({ cwd, tty, waitMs: 30_000, includeConsumed: true })` locates this
   launch's claim.
3. `tryAcquireRoot(claim_id, process.pid)` arbitrates by **exclusive create** (`flag: "wx"`, atomic on POSIX)
   of `<claim_id>.root.lock`. `consume()` cannot arbitrate: it is a read-modify-write and two children can
   both observe the claim unconsumed. A lock whose owner pid is provably dead (only `ESRCH` counts) is
   reclaimed under a `.reclaim` guard file, with at most three attempts, so a crashed root does not strand
   the launch and competing reclaimers cannot steal a fresh winner's lock.
4. Winner: `root`. Loser: `secondary`, which serves an **empty** tool list and returns before
   `setTabTitle`/`ensureBroker`, so it takes no identity, opens no broker connection, and writes no escape
   sequences to the shared terminal.

`mcp_servers.agent-peers.required=true` makes Codex await agent-peers init before `Session::spawn`/`resume`
completes, which makes the election deterministic rather than a race: the root thread is constructed first
and no descendant runtime is auto-opened during resume.

### 3.3 Registration (managed launch)

The root child calls `registerWakeableSessionIfEnabled` right after broker registration, and again on any
post-eviction rejoin. Hints come from `resolveWakeRegistrationHints`, which has two branches:

- **Legacy env branch**, used only when `canUseLegacyWakeEnv(env)` holds: `AGENT_PEERS_WAKE_ENABLED === "1"`
  **and** `AGENT_PEERS_WAKE_LAUNCH` is not `1`. It reads `AGENT_PEERS_WAKE_THREAD_ID`,
  `..._APP_SERVER_URL`, `..._APP_SERVER_PID`, `..._APP_SERVER_SOCKET_PATH` and `..._ROLLOUT_PATH`. A managed
  launch never takes it: the TUI's `-c` env is ignored in `--remote` mode and the siblings of a managed
  launch share inherited env, so the exact claim won in the election is used instead.
- **Claim branch**: returns the `wakeRootClaim` this child won. This is the path that fires on a normal
  launch.

The registry row is upserted with `status: "ready"`, `capabilities: ["app-server-ws"]`, `mcp_pid:
process.pid`, and a SHA-256 hash of the broker session token. The claim is then marked `consumed`, and the
module flag `isWakeableSession = true` is set, which short-circuits `wait_for_peer_messages` for this
session (`planWaitForPeerMessages` returns `skip-wakeable`).

### 3.4 Idle -> mail -> wake

While the session is idle it runs no inference. When mail arrives, `codex-server.ts` writes the message body
to `<peer-id>.json` and a **bodyless** envelope digest to `<peer-id>.metadata.json`
(`shared/codex-inbox.ts`). The daemon reads only the metadata file. It reads the configured inbox root and,
when that differs from the coordination root, the coordination root too, so MCP children started before the
state-directory consolidation stay wakeable.

One pass (`runWakePass`) per registry entry:

| Order | Check | Skip reason |
| --- | --- | --- |
| 1 | metadata file missing or `unread` empty | `no_pending_metadata` (silent, no round-trip) |
| 2 | peer is inside a wedged-state cooldown | `thread_system_error` (silent, no round-trip) |
| 3 | `thread/loaded/list` does not contain the thread | `thread_not_loaded` |
| 4 | `thread/read` fails validation (section 4) | one of the `validateThread` reasons |
| 5 | ledger cooldown / attempt cap | `duplicate_or_cooldown` / `max_attempts` |
| 6 | second `thread/read` after the ledger claim fails validation | the validation reason; the claim is **released**, spending no attempt |
| 7 | the thread is `active` and the steer misses | `steer_raced`, or the now-current reason; claim released |
| 8 | `turn/start` or `turn/steer` throws | `wake_failed` (ledger marked `failed`) |
| none | any app-server connect/RPC error | `app_server_unreachable` (pass continues to next peer) |

A successful wake emits `action: "wake"`, a fresh `wake_id` (UUID) and the returned `turn_id`, with `reason:
"nudged"` (idle thread, `turn/start`) or `reason: "steered"` (busy thread, `turn/steer`), and **resets** that
peer's observation record so the next anomaly logs fresh.

### 3.5 Busy chat: delivery into the running turn (commit `237d5f7`)

Mail for a chat that is mid-task no longer waits for the task to end. When validation reports
`thread_active` (a working turn, with neither `waitingOnApproval` nor `waitingOnUserInput`) and the app-server
client supports it, the pass:

1. Finds the in-progress turn with `thread/turns/list` (`activeTurnId`: newest turn, `limit: 1`, and its
   status must be `inProgress`).
2. Appends the wake with `turn/steer`, carrying `expectedTurnId`, the same as typing into a busy Codex chat.
   The steer text is `buildSteerPrompt`, still bodyless: it tells the agent to call `check_messages` once,
   handle the mail as a colleague would, then continue its task.
3. If the turn ended first (no in-progress turn, or the server rejects the steer with "expected active turn
   id" or "no active turn"), re-reads the thread. An idle thread gets a normal `turn/start` wake; a thread
   that is busy again, or in any other state, releases the ledger claim (`steer_raced` or that reason) and
   the next pass retries. Any other steer error is recorded as a failed wake.

The ledger backoff is unchanged: a busy thread is steered once per new unread batch, not on every poll. A
client without `activeTurnId`/`steerWakeTurn` (a minimal test double) leaves a busy thread alone, as before.
Chats parked on an approval or user-input prompt are still **not** woken or steered; they are re-checked
every pass so delivery happens the instant they resume. Before the first `turn/start` or `turn/steer` the
daemon re-reads the thread once more, so a turn a user started while the ledger was being written is
steered rather than collided with. This narrows, but cannot atomically eliminate, the gap between observing
idle and `turn/start` (which can append to a busy turn).

### 3.6 Codex desktop chats over SSH (commit `12f6f2b`)

A Codex desktop chat opened over SSH runs under an app-server the desktop app owns, listening on a unix
socket on the machine that hosts it (the Studio, in Mike's fleet). The agent-peers MCP is a stdio child of
that app-server. It cannot use the launcher's claim, so `shared/codex-desktop-wake.ts` registers it by
exact thread id:

- **Eligibility** (`desktopWakeEligible`): the runtime is Codex and `AGENT_PEERS_WAKE_ENABLED` is neither
  `1` nor `0` and `AGENT_PEERS_WAKE_LAUNCH` is not `1`. Managed launches, explicitly disabled sessions, and
  Hermes, Droid and OpenClaw runtimes are excluded.
- **Identity comes only from host metadata.** On a tool call, `observe` reads `_meta.threadId` supplied by
  Codex (it must be a UUID) and nothing else. It is called after the arrival barrier in the delivery path
  (`beforeReadQueue`), so socket discovery cannot move the confirm-on-next-call barrier past an `await`.
- **One bounded discovery pass, never a retry loop.** `lsof -a -p <parent pid> -U -Fn` lists the unix
  sockets owned by the MCP's **direct parent** (the app-server). Discovery runs on macOS only (it returns no
  sockets elsewhere), takes at most 3 s, and never expands to other pids. For each socket path (absolute, an
  actual socket) it connects at `ws+unix://<path>`, requires `thread/loaded/list` to contain the thread,
  reads it, and requires the same id, a status other than `notLoaded`, and the same canonical `cwd`. Exactly
  **one** match is a binding; zero or several are not wakeable.
- **Registration** writes a registry row with `app_server_url: ws+unix://...`, `app_server_socket_path` set
  to that socket, `app_server_pid` set to the parent pid, `tui_pid: null`, and the usual token hash. The row
  is written only after the registry write succeeds, and a failed write never reports readiness or fails
  ordinary tool handling.
- **Refresh, not rediscovery.** Broker rejoin and `rename_peer` call `refresh`, which republishes the
  validated binding under the new peer/session token. If later metadata names a *different* thread, the
  registration is permanently invalidated and the old row removed; it is never retargeted.
- **Non-wakeable hosts fail clean.** A stdio host with no reachable parent socket (for example a
  remote-control relay chat, which has no attach point) simply stays non-wakeable, with no further I/O or
  errors.

After registration the daemon treats the row like any other: same validation (thread id, cwd, rollout path
when known), same ledger, same steering. Registry writes are serialized by the file lock, so several
desktop MCPs cannot overwrite one another. `codex-peer live` shows these sessions as wakeable.

### 3.7 Staleness: what `wakeable=no (stale)` means

`WakeRegistry.isLive` requires all of:

- `app_server_pid` alive,
- `mcp_pid` alive,
- `tui_pid` alive when non-null,
- `app_server_socket_path` exists when non-null (a `null` path passes trivially).

Liveness uses `isProcessAlive`, where only `ESRCH` means dead, so a live process owned by another uid is
never treated as gone. `list()` drops non-live rows by default; `list({ includeStale: true })` returns them
with `status` rewritten to `"stale"`. `cli.ts` uses the `includeStale` form, which is why `codex-peer live`
can print `wakeable=no (stale)` and a "Stale or registry-only wake entries" section. The daemon uses the
default form, so a stale row is simply never woken.

`prune({ deadGraceMs })` removes non-live rows whose `last_seen_at` is older than the grace window
(default 30 min in the daemon). Live rows are never pruned.

---

## 4. Same-thread validation

`validateThread` runs before every wake (and again just before sending) and is the guarantee that a nudge
cannot land on the wrong session or interrupt work:

| Condition | Reason returned |
| --- | --- |
| `thread.id !== entry.thread_id` | `thread_identity_mismatch` |
| `thread.cwd !== entry.cwd` | `cwd_mismatch` |
| registry has a rollout path and `thread.path` differs | `rollout_mismatch` |
| `status.type === "notLoaded"` | `thread_not_loaded` |
| `status.type === "systemError"` | `thread_system_error` |
| `active` + `waitingOnApproval` | `waiting_on_approval` |
| `active` + `waitingOnUserInput` | `waiting_on_user_input` |
| `active` (no flags) | `thread_active`: **steered** into the running turn when the client supports it, otherwise skipped |
| anything not `idle` | `unknown_thread_status` |
| `idle` | `null`: eligible for `turn/start` |

---

## 5. Backoff: two independent mechanisms

### 5.1 `WakeLedger`: throttles re-waking the *same* unread set

(State in `<coordination root>/wake-ledger/<sha256>.json`.)

The key is `pendingSignature(peerId, metadata)` = `sha256(peerId + ":" + sorted unread ids)`. A **new**
message changes the signature and always wakes immediately; only a repeat of the identical unread set is
throttled. The same rule governs steering a busy thread.

`DEFAULT_BACKOFF_SCHEDULE_MS = [5m, 30m, 2h]`. The schedule entries are the waits *before* attempts 2, 3, 4;
`maxAttempts = schedule.length + 1 = 4`. On the 4th observation the record is flipped to `abandoned` and no
further proactive nudge is sent for that unread set. The message is **not** dropped: it stays in the durable
inbox and still surfaces on the session's next tool call or user turn.

A claim that is never sent (the final read found the thread busy with a prompt, or an unexpected read error)
is **released**: the ledger is restored to its exact previous record, so that skip spends neither an attempt
nor a cooldown. Records are garbage-collected after `DEFAULT_LEDGER_TTL_MS = 24h`.

### 5.2 `WakeObservationLog`: log coalescing and wedged-peer re-check backoff

(State in `<coordination root>/wake-observe/<sha256 of peer id>.json`.)

The daemon is bodyless (a fresh process every pass), so cross-pass memory has to live on disk. Each record
holds the last skip `reason`, `first_seen_at`, `log_count`, `observe_count`, `backoff_index`, `next_log_at`,
and optionally `next_check_at`.

- **First sight of a reason, or a change of reason**: log once (a transition).
- **Same reason repeating**: suppressed until `next_log_at`; the heartbeat interval is `OBSERVE_HEARTBEAT_MS
  = 30m` for ordinary reasons.
- **Wedged reasons** (`OBSERVE_BACKOFF_REASONS = {"thread_system_error"}`) additionally get `next_check_at`,
  and `recheckBackoff` skips the app-server round-trip *and* the log line entirely inside the cooldown,
  escalating `5m -> 30m -> 2h`. A wedged thread cannot be woken until a human bounces it, so `bounceHint`
  attaches `close the TUI and relaunch codexpeer in <cwd>` to the line.

An `active` peer is deliberately **not** in the backoff set: its user is mid-turn, and the daemon wants
low-latency delivery the instant it goes idle (or a steer), so it keeps polling every pass and only
coalesces the log lines.

---

## 6. Public interfaces

### 6.1 Files and directories

There are two roots (`shared/state-dir.ts`). The **coordination root** holds everything the launcher, MCP
children and daemon share (registry, claims, ledgers, daemon pid and log); it is
`AGENT_PEERS_CODEX_STATE_DIR` or `~/.agent-peers-codex`, and the generic `AGENT_PEERS_STATE_DIR` is
deliberately **ignored** for it, so a rolling upgrade cannot move the locks that already-running launchers
hold and elect a second session owner. The **inbox root** (message bodies and metadata) is
`AGENT_PEERS_STATE_DIR`, then `AGENT_PEERS_CODEX_STATE_DIR`, then `~/.agent-peers-codex`. By default they
are the same directory.

| Path | Written by | Mode | Contents |
| --- | --- | --- | --- |
| `wake-registry.json` | `codex-server.ts`, `cli.ts`, desktop registration | 0600 in 0700 dir | `{ entries: WakeRegistryEntry[] }`, atomic temp+rename |
| `wake-registry.json.lock` | any registry user | 0600, `wx` | `{ owner_pid }`; held for each registry operation, with a 2 s wait, reclaimed only from a provably dead owner |
| `wake-launch-claims/<uuid>.json` | launcher, MCP child | 0600 | launch handshake record |
| `wake-launch-claims/<uuid>.root.lock` | MCP child | 0600, `wx` | `{ owner_pid, acquired_at }` |
| `wake-ledger/<sha256>.json` | daemon | 0600 | `{ signature, status, attempts, updated_at, error? }` |
| `wake-observe/<sha256>.json` | daemon | 0600 | per-peer last-skip observation record |
| `<peer-id>.json` / `<peer-id>.metadata.json` (inbox root) | `codex-server.ts` | 0600 | durable inbox + bodyless envelope digest |
| `logs/<peer>-app-server.log[.1...]` | launcher | 0600 in 0700 dir | app-server stdout/stderr, 5 MiB x 3 |
| `wake-daemon.log[.1...]`, `wake-daemon.pid` | `bin/codex-peer` shell redirect | umask default | daemon output + pidfile |
| `wake-daemon.lock/` | `bin/codex-peer` | dir | atomic single-starter lock |

`WakeRegistry.readStateFromDisk` fails closed on POSIX: it returns empty state if the registry file is not
a regular file, is owned by another uid, or has a mode other than exactly `0600`. Every operation re-reads
the committed file under the lock, so no process persists a cached snapshot over another process's rows.

### 6.2 Environment variables the code reads

| Variable | Effect |
| --- | --- |
| `AGENT_PEERS_CODEX_STATE_DIR` | Coordination root; also the inbox root when `AGENT_PEERS_STATE_DIR` is unset |
| `AGENT_PEERS_STATE_DIR` | Inbox root only (see 6.1) |
| `AGENT_PEERS_WAKE_LAUNCH` | `"1"` (exact) marks an MCP child as belonging to a managed wakeable launch, so the election applies and desktop registration is off |
| `AGENT_PEERS_WAKE_ENABLED` | `"1"` selects the legacy env-hint registration (only without `WAKE_LAUNCH`); `"0"` also disables desktop registration |
| `AGENT_PEERS_WAKE_THREAD_ID` | Thread to register on the legacy path; also a delivery breadcrumb |
| `AGENT_PEERS_WAKE_APP_SERVER_URL`, `..._APP_SERVER_PID`, `..._ROLLOUT_PATH` | Legacy env-hint branch only |
| `AGENT_PEERS_WAKE_APP_SERVER_SOCKET_PATH` | Legacy env-hint branch only; **set by nothing in this repo**, so managed launches register `app_server_socket_path: null` (desktop registrations set a real socket path) |
| `AGENT_PEERS_ENABLED` | `"0"` on the phase-1 app-server makes the MCP a no-op that registers nothing |
| `PEER_NAME` | Requested peer name |
| `CODEX_PEER_DAEMON_INTERVAL` | Seconds between passes (default 5) |
| `CODEX_PEER_DAEMON_LOG_MAX_BYTES` / `_KEEP` | Daemon log copy-truncate rotation (5 MiB x 3) |
| `CODEX_PEER_APP_SERVER_LOG_MAX_BYTES` / `_KEEP` | Per-peer app-server log rotation |
| `CODEX_PEER_VERBOSE` | `"1"` shows launcher status lines |
| `AGENT_PEERS_MCP_DIR` | Override for the repo root the wrapper `cd`s into |
| `GOOGLE_ADS_EXPERT_REPO`, `CCR_WEBSITE_REPO` | Override the two hardcoded shortcut repos |
| `CODEX_HOME` | Where `codex-peer resume` and `session-cwd` look for rollouts (default `~/.codex`) |

### 6.3 App-server JSON-RPC calls used

`CodexAppServerWsClient` speaks JSON-RPC over a WebSocket (`ws://127.0.0.1:<port>` for managed launches,
`ws+unix://<socket>` for desktop chats), with a 5 s default timeout on connect and on every request.

| Method | Params | Used by |
| --- | --- | --- |
| `initialize` | `{ clientInfo: { name: "agent-peers-wake-daemon", version: "0.1.0" }, capabilities: {} }`, or `{ experimentalApi: true }` for the materialize client | every `connect()` |
| `thread/loaded/list` | `{}` | daemon pre-check, desktop discovery |
| `thread/read` | `{ threadId, includeTurns: false }` | daemon validation (twice per wake), launcher inspect, desktop discovery, `codex-peer live` probe |
| `thread/start` | `{ cwd, model, config: { model_reasoning_effort }, approvalPolicy, sandbox, historyMode }` | launcher phase 1 (fresh) |
| `thread/name/set` | `{ threadId, name }` | launcher materialization (no model turn) |
| `turn/start` | `{ threadId, clientUserMessageId, input: [{ type: "text", text, text_elements: [] }] }` | the idle wake |
| `thread/turns/list` | `{ threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }` | find the in-progress turn before a steer |
| `turn/steer` | `{ threadId, expectedTurnId, clientUserMessageId, input: [...] }` | the busy-turn wake |
| `config/mcpServer/reload` | `null` | `reloadMcpServers()`: **no production caller** |

The prompts (`buildWakePrompt`, `buildSteerPrompt`) are fixed text plus a UUID; the `clientUserMessageId` is
`agent-peers-wake-<uuid>`.

### 6.4 `codex-peer` CLI surface

| Subcommand | Behavior |
| --- | --- |
| *(none)* / `here` / `.` | Launch in `$PWD`, auto-named by `peer-name.ts` |
| `google-ads` \| `ads`, `ccr` \| `ccr-website` | Launch in the two hardcoded repos with fixed names |
| `start <name> <repo> [-- args]` | Launch any repo with a chosen name |
| `resume <session-id> [-- args]` | Read the rollout's `cwd` with `jq`, then launch `--thread-id` |
| `session-cwd <session-id>` | Print only the saved absolute cwd of a session (UUID required); never launches Codex |
| `daemon [seconds]` | Foreground wake loop; refuses to double-start |
| `daemon-stop`, `daemon-status`, `ensure-daemon` | Background daemon lifecycle |
| `wake` \| `wake-once` | One verbose pass (`bun wake-daemon.ts`, no `--quiet-noop`) |
| `send`, `peers`, `status`, `live` \| `wake-status`, `messages` | Thin wrappers over `cli.ts` |
| `retire` \| `unregister <name-or-id>` | `cli.ts retire`: unregister from broker and drop the wake row |
| `repair-wake` \| `attach-wake <name-or-id>` | `cli.ts repair-wake`: re-attach a live peer to its claim |
| `doc` \| `open-doc` | Opens `docs/examples/wakeable-codex-peer-demo.html` |
| `install [path]` | Symlinks the script to `~/.local/bin/codex-peer` |
| `help` / `-h` / `--help` / anything else | Usage; unknown exits 2 |

`wake-daemon.ts` itself takes `--json` (one JSON object per result; Hermes and OpenClaw results are wrapped
as `{"hermes": ...}` and `{"openclaw": ...}`) and `--quiet-noop` (daemon mode: print only results with
`log: true`).

`repair-wake` is the recovery path when a live Codex peer shows `wakeable=no`. It matches launch claims by
`cwd` + `tty` (narrowed by `requested_peer_name` when available) and **refuses** when two or more *live*
candidates have distinct thread ids, rather than guessing and wiring the wake pointer to the wrong session.
It does not repair desktop-chat registrations (those have no claim). A desktop chat whose first registration write failed retries it on later tool calls. Once a registration has succeeded, the MCP child caches it and does not check the registry again (`persist` in `shared/codex-desktop-wake.ts` returns early for the same peer, name and token), so a row lost afterwards is not rewritten by that child: it needs an MCP or session restart followed by a tool call.

---

## 7. Data shapes

`WakeRegistryEntry`: `peer_id`, `peer_name`, `cwd`, `git_root`, `tty`, `thread_id`, `rollout_path`,
`app_server_url`, `app_server_socket_path`, `app_server_pid`, `tui_pid`, `mcp_pid`,
`broker_session_token_hash`, `status` (`starting|ready|stale`), `capabilities`, `created_at`, `updated_at`,
`last_seen_at`. Only `ready` and `stale` are ever produced.

`upsert` removes any existing row sharing **either** the peer id or the thread id before inserting, so a
relaunch cannot leave a duplicate pointer.

`WakeLaunchClaim`: `claim_id`, `cwd`, `tty`, `requested_peer_name`, the app-server URL/pid/socket,
`thread_id`, `rollout_path`, `tui_pid`, `status` (`starting|ready|consumed|failed`), timestamps,
`consumed_by_peer_id`. A claim is "complete" only when it is `ready`/`consumed` **and** carries a URL, a
positive pid, and a thread id; "live" additionally requires the app-server (and TUI, if recorded) pid to be
alive. Claims are matched within a 10-minute `maxAgeMs` window *or* while live, and pruned on the same rule.

`WakeResult`: `peer_id`, `peer_name`, `cwd`, `thread_id`, `action` (`wake|skip`), `reason`, `log`, optional
`note`, `wake_id`, `turn_id`.

---

## 8. Process lifecycle and cleanup

- **Orphan-parent watchdog.** `codex-server.ts` polls every 1 s and calls `parentProcessWasLost(initial,
  current)`: true only when the process started with a real parent (greater than 1) that has since become
  pid 1. Bun's stdio transport can outlive its app-server parent, leaving an orphan that heartbeats forever
  as a live peer; reparenting to init is the signal that the MCP session is gone, and the MCP exits.
- **Signal handling.** `SIGINT/SIGTERM/SIGHUP/SIGQUIT` and `exit` are armed before any `setTabTitle()`
  call, because an unhandled SIGHUP exits 129 without firing `exit`.
- **Launcher teardown.** The resume app-server is SIGTERM'd in a `finally` when the TUI exits; phase-1
  app-servers are killed the same way. If phase 2 never reaches `status: "ready"`, the claim is marked
  `failed`.
- **GC every pass.** `runWakePass` finishes with four independent best-effort prunes: ledger TTL,
  observation TTL, dead registry rows past the grace window, and dead/old launch claims. Each is wrapped in
  its own `try/catch` so a GC failure can never affect wake delivery.
- **Daemon single-instance and service management.** `ensure_daemon` checks the pidfile, takes an atomic
  `mkdir` lock, re-checks, then `nohup`s and `disown`s the daemon, with `BRAIN_ROUTER_TOKEN_*` variables
  removed from its environment. `run_daemon` writes its own pid and traps `EXIT/INT/TERM` to remove the
  pidfile. On a service-managed host the daemon is a service instead: the macOS LaunchAgent
  `com.mike.agent-peers-wake` and, on Linux, `agent-peers-wake.service` both run `bin/codex-peer daemon 5`
  with automatic restart (`deploy/linux/agent-peers-wake.service` is tracked in this repo; the macOS plist
  is machine state). Because `run_daemon` overwrites the pidfile with its own pid, `ensure_daemon` then
  sees a live daemon and does nothing. `daemon-stop` on such a host only restarts it.

---

## 9. Dependencies

- **Codex CLI**: `codex app-server --listen`, `codex resume --remote`, `thread/*` and `turn/*` RPCs,
  `/readyz`, and `-c mcp_servers.agent-peers.*` config injection. `thread/rollback` was removed as
  deprecated in codex-cli 0.146.1. Busy-turn steering was verified on a disposable codex 0.162.1
  app-server (commit message of `237d5f7`).
- **Broker** (`broker.ts` + `shared/broker-client.ts`): peer registration, name uniqueness ladder, message
  delivery. The Codex pass itself never talks to the broker; it reads inbox metadata files.
- **Bun**: `Bun.spawn`, `Bun.sleep`, `bun:sqlite` (in `cli.ts`), and the global `WebSocket`/`fetch`.
- **`ps`/`kill(0)`**: all liveness is pid-probe based.
- **`lsof`** (macOS only): desktop-chat discovery of the parent's unix sockets.
- **`jq`**: required only by `codex-peer resume` and `session-cwd` to read `cwd` out of a rollout.

---

## 10. Entry points

| Entry | Invocation |
| --- | --- |
| Wake pass (one shot) | `bun wake-daemon.ts [--json] [--quiet-noop]` |
| Wake loop | `codex-peer daemon [seconds]` -> `run_bun wake-daemon.ts --quiet-noop` every N s |
| Auto-started loop | any `codex-peer` launch -> `ensure_daemon` -> `nohup codex-peer daemon 5 &` |
| Service-managed loop | LaunchAgent (macOS) or `agent-peers-wake.service` (Linux) -> `codex-peer daemon 5` |
| Launcher | `bun wakeable-codex.ts [--cwd DIR] [--port N] [--name NAME] [--thread-id ID] [--no-alt-screen] [--materialize\|--no-materialize] [-- codex args]` |
| PATH install | `bun bin/codex-peer install [path]` -> symlink at `~/.local/bin/codex-peer` |

The shell aliases in the wrapper's usage text (`peerwake`, `adspeer`, `ccrpeer`, `peerlist`, `peerstatus`,
`peerrepair`, `peerretire`, `peerdoc`) are Mike's own, not installed by this repo.

### What else the daemon pass runs

After the Codex pass, `wake-daemon.ts` runs two more passes, each wrapped so that a failure never affects
the others:

- **Hermes chats** (`shared/hermes-wake-pass.ts`). Does nothing unless a profile is listed in
  `<hermes state>/chat-wake/enabled` (`~/.agent-peers-hermes/chat-wake/enabled`, one profile per line). It is
  available per profile and, at the time of writing, **switched off**: the closed-chat driver is built but
  not enabled on any host. Hermes Desktop's in-process wake plugin is a separate mechanism with its own
  opt-in file; see [hermes-desktop-wake.md](hermes-desktop-wake.md).
- **OpenClaw main sessions** (`shared/openclaw-wake-pass.ts`). Does nothing, and calls neither the broker
  nor the Gateway, until an agent id is listed in `~/.agent-peers-openclaw/wake/enabled`; see
  [openclaw-peer.md](openclaw-peer.md).

---

## 11. Tests

`tests/wake-daemon.test.ts`, `wake-daemon-backoff.test.ts`, `wake-daemon-observe.test.ts`,
`wake-registry.test.ts`, `wake-launch-claims.test.ts`, `wake-launch-role.test.ts`,
`wakeable-launcher.test.ts`, `app-server-client.test.ts`, `codex-desktop-wake.test.ts`,
`bounded-log.test.ts`, `process-lifecycle.test.ts`, `codex-peer-script.test.ts`, `state-dir.test.ts`,
plus `hermes-wake-pass.test.ts` and `openclaw-wake-pass.test.ts` for the other two passes. Run with `bun
test`; type-check with `bun run typecheck`. Per-file purposes are in
[cli-ops-tests.md](cli-ops-tests.md#6-test-suite).

---

## 12. Drift against the operator docs

The operator-level wake docs were revised together with this file at `9be6159`; known intentional
differences are only in level of detail. In particular, normal launches bind the visible session to its
exact app-server and thread **by claim, matched on `cwd` + `tty`** (the same key `repair-wake` uses), not
by env: in `--remote` mode the resume command's own `-c` env is ignored and the claim is authoritative.

---

## Red Flags

Found by reading the code at `9be6159`; none were reproduced for this document. No `TODO`/`FIXME`/`HACK`
markers exist in the scoped files.

**Dead or unreachable code**

- `buildMcpEnvConfigArgs` injects `AGENT_PEERS_WAKE_*` as `-c mcp_servers.agent-peers.env.*` onto the
  **resume TUI** command, but the launcher's own comment says the TUI's `-c` env is ignored in `--remote`
  mode. Dead config, entrenched by `tests/wakeable-launcher.test.ts`. `buildWakeableEnv` likewise exports
  `AGENT_PEERS_WAKE_*` into a TUI process that spawns no MCP in `--remote` mode.
- `AGENT_PEERS_WAKE_APP_SERVER_SOCKET_PATH` is set by nothing in the repo, so a managed launch's
  `app_server_socket_path` is always `null`, and `socketPathExists(null)` returns `true`. The socket
  liveness check is a no-op for managed launches (it is real for desktop registrations).
- `WakeRegistry.markSeen()` and `getByPeerId()` have no callers outside tests; `reloadMcpServers()` has no
  production caller; `WakeRegistryStatus` includes `"starting"`, which is never written.
- `startWakeTurn` takes `wakeId` and `pendingSignature` and sends neither; the wake id reaches the model
  only inside the prompt text.

**Correctness / reliability**

- Because `markSeen()` is never called, `last_seen_at` is fixed at registration time, so `prune`'s "keeps a
  freshly-died session visible for 30 min" comment is false for any session that lived longer than
  `deadGraceMs`: its row is removed on the first pass after death, before the operator can diagnose it in
  `codex-peer live`.
- If a ledger record's `updated_at` is unparseable, `elapsed` is `NaN` and the guard returns
  `duplicate_or_cooldown` forever; one corrupt file suppresses re-wakes for that unread set until the 24 h
  TTL GC removes it.
- A failed `turn/start` is marked `failed` *after* `claim()` has already incremented `attempts`, so
  transient app-server failures consume the 4-attempt budget exactly like delivered wakes.
- `bin/codex-peer` derives `ROOT_DIR` from `dirname "${BASH_SOURCE[0]}"` with no symlink resolution, while
  `install_command` installs a **symlink** at `~/.local/bin/codex-peer`. Invoked through that symlink,
  `ROOT_DIR` resolves to `~/.local` and every `run_bun` call fails unless `AGENT_PEERS_MCP_DIR` is exported.
- If a launcher dies between `mkdir "$DAEMON_LOCKDIR"` and the matching `rmdir`, `ensure_daemon` returns
  success forever and the wake daemon silently never auto-starts again (there is no stale-lock reclaim).
  `daemon_pid` validates only `kill -0`, so a recycled pid makes `daemon-status` report "running" and
  suppresses auto-start. Neither affects a host where a service manager runs the daemon.
- `shared/wake-launch-claims.ts` `isRecent` reads `Date.now()` directly while `prune()` accepts an
  injectable `now`, so a frozen test clock cannot control matching consistently.
- `CodexAppServerWsClient.close()` nulls `this.ws` immediately; pending requests are rejected only when the
  socket's `close` event fires against the shared `pending` map, so a reconnect in that window shares state
  with the dying socket.
- Desktop discovery runs once per MCP and only when the first tool call carries `_meta.threadId`. A chat
  whose first call arrives before its app-server socket is listed, or whose socket the 3 s budget misses,
  stays non-wakeable until the MCP restarts; there is no retry by design.

**Security / permissions**

- `readAllInboxMetadata` reads every `*.metadata.json` with no uid/mode fail-closed check, unlike
  `shared/codex-inbox.ts`. Any same-uid process can plant a metadata file and cause repeated model turns
  (bodyless, so no content injection, but it burns tokens).
- `wake-daemon.log` and `wake-daemon.pid` are created by shell redirection under the default umask while
  every other wake artifact is `0600`. The log contains peer names, thread ids, and repo paths.
- Fresh managed threads default to approval `never` and sandbox `danger-full-access`
  (`resolveFreshThreadPermissions`). That is Mike's intended contract, but it is a hard-coded default that
  a caller narrows only through native Codex flags.
- `shared/bounded-log.ts` runs `chmodSync(dirname(path), 0o700)` unconditionally, including on Windows where
  other modules guard with `IS_POSIX`, and `append()` re-chmods the file on every write.

**Hardcoded values / portability**

- `bin/codex-peer` hardcodes `/Users/mike/www/ai/google-ads-expert` and `/Users/mike/www/ai/ccr-website` as
  defaults with dedicated `google-ads` / `ccr` subcommands, and its usage text advertises personal shell
  aliases this repo does not install.
- `gpt-5.6-sol` and `model_reasoning_effort=high` are hardcoded for fresh threads with no env override.
- 10 s fixed timeouts for rollout-on-disk and `/readyz`; backoff, TTL and grace constants are compile-time
  only (injectable in `WakeDaemonOptions`, but nothing on the CLI path passes them).
- `retryEmptyRolloutRace` retries a magic count of 20 x 100 ms keyed on **substring matching an app-server
  error message** (`isEmptyRolloutRaceError`), which will silently stop working if Codex rewords the error.

**Performance / churn**

- A fresh `WebSocket` + `initialize` handshake per peer per pass; at the default 5 s interval that is about
  17k connections per day per peer. Inherent to the bodyless design.
- `WakeObservationLog.annotate` writes the observation file on **every** skip, including the suppressed
  branch where the only change is an incremented counter: one small atomic temp+rename every 5 s per
  skipping peer, indefinitely.
- Daemon log rotation only runs inside the foreground `run_daemon` loop, so `codex-peer wake` never
  rotates; and the copy-truncate window can lose lines written between `cp` and `: >`.
- `run_bun` performs a bare `cd "$ROOT_DIR"` in the current shell rather than a subshell, permanently
  changing cwd mid-invocation; the launcher compensates with an explicit `cwd:` on both spawns.
