# Codex Wake Subsystem

Truth-from-code documentation of the wake path in `agent-peers-mcp`, as of repo HEAD `63503f2`.

Primary sources:
`wake-daemon.ts` (32), `wakeable-codex.ts` (15), `bin/codex-peer` (442),
`shared/wake-daemon.ts` (571), `shared/wakeable-launcher.ts` (540),
`shared/wake-launch-claims.ts` (308), `shared/wake-registry.ts` (234),
`shared/app-server-client.ts` (224), `shared/bounded-log.ts` (74),
`shared/wake-launch-role.ts` (69), `shared/process-lifecycle.ts` (3).

Supporting (read for accuracy, documented elsewhere): `codex-server.ts`, `cli.ts`,
`shared/codex-inbox.ts`.

Operator-level companions: [`docs/wakeable-codex.md`](../wakeable-codex.md) (design rationale +
security model) and [`docs/wake-daemon.md`](../wake-daemon.md) (log reading + tuning). This file is
the implementation-level reference; drift between those docs and the code is recorded in
§12 and in Red Flags.

---

## 1. Purpose

Stock Codex CLI surfaces peer messages **only on the response to an agent-peers tool call**. A
Codex session parked at its prompt calls no tools, so mail sits in its inbox until the human types
something. Codex exposes no MCP push channel (`tools` is the only supported MCP feature), so there
is no way to hand an idle session a message from outside.

The wake subsystem makes wakeability a **launch-time property** instead of forking the Codex binary:

1. `codexpeer` starts Codex under a **managed app-server** (`codex app-server --listen ws://…`)
   bound to one thread, with a visible `codex resume --remote <url> <thread>` TUI attached to that
   *same* thread.
2. The agent-peers MCP that the app-server spawns records `peer_id -> { app_server_url, thread_id, … }`
   in a durable **wake registry**.
3. A **wake daemon** polls, every 5 s, for peers that have unread mail *and* an idle thread, and
   sends a **bodyless** wake prompt into that exact thread via `turn/start`. The prompt carries no
   message content — it only tells the model to call `check_messages`, which remains the single
   authoritative delivery path.

The woken session is the same live instance: same thread, same rollout file, same visible TUI. It
is never killed or restarted with fresh context.

---

## 2. Component map

| File | Role |
| --- | --- |
| `bin/codex-peer` | Operator shell wrapper: launch, daemon lifecycle, inspect/repair/retire. Delegates every non-daemon subcommand to `cli.ts`. |
| `wakeable-codex.ts` | 15-line entry point; parses argv and calls `runWakeableLauncher`. |
| `shared/wakeable-launcher.ts` | The two-phase launch: throwaway app-server to materialize/inspect the thread, then the visible app-server + TUI. Writes the launch claim. |
| `wake-daemon.ts` | One-shot pass entry point; formats `WakeResult[]` as log lines or `--json`. |
| `shared/wake-daemon.ts` | The wake engine (`runWakePass`) plus two private stores: `WakeLedger` (re-wake backoff) and `WakeObservationLog` (log coalescing + wedged-peer re-check backoff). |
| `shared/wake-registry.ts` | Durable `peer_id -> app-server/thread` registry with pid/socket liveness and GC. |
| `shared/wake-launch-claims.ts` | Launcher ↔ MCP-child handshake file, plus the atomic root-election lock. |
| `shared/wake-launch-role.ts` | Pure decision function: `standalone` / `root` / `secondary`. 69 lines, 40 of which are the rationale comment. |
| `shared/app-server-client.ts` | Minimal WebSocket JSON-RPC client for the Codex app-server, with bounded connect/request timeouts. |
| `shared/bounded-log.ts` | Size-rotating private log used for app-server stdout/stderr. |
| `shared/process-lifecycle.ts` | Three lines: `parentProcessWasLost(initial, current)` → orphan-parent watchdog predicate. |

---

## 3. Lifecycle

### 3.1 Launch (`bin/codex-peer` → `wakeable-codex.ts` → `runWakeableLauncher`)

`start_peer` (`bin/codex-peer:193-203`) does four things in order: validate the repo path, ensure
`codex` is on PATH, **auto-start the background wake daemon** (`ensure_daemon`), and resolve a
non-colliding peer name via `cli.ts suggest-name` (`bin/codex-peer:184-191`). It then runs
`bun wakeable-codex.ts --cwd <repo> --name <peer>`.

`runWakeableLauncher` (`shared/wakeable-launcher.ts:217-329`) runs two phases:

**Phase 1 — resolve the thread on a throwaway app-server.**
A fresh launch calls `materializeThread` (`:336-381`); `--thread-id` calls `inspectExistingThread`
(`:386-416`). Both spawn a *separate, short-lived* app-server configured with
`mcp_servers.agent-peers.env.AGENT_PEERS_ENABLED="0"` (`buildMaterializeMcpConfigArgs`, `:172-196`),
so its agent-peers MCP early-returns and registers **nothing**. A fresh thread is created with
`thread/start` and materialized with `thread/name/set` — naming a thread persists its rollout JSONL
without running a model turn. `waitForRolloutOnDisk` (`:422-432`) then blocks until the file exists
and is non-empty, because `codex resume --remote <threadId>` fails with `no rollout found for
thread id … (code -32600)` otherwise. The throwaway app-server is always killed in a `finally`.

**Phase 2 — the visible session.**
A port is allocated by binding `:0` and closing (`allocatePort`, `:447-462`), the resume app-server
is spawned with `buildResumeMcpConfigArgs` (`:155-161`) — which sets `AGENT_PEERS_WAKE_LAUNCH="1"`
and `mcp_servers.agent-peers.required=true` — and `waitForReadyz` polls `http://127.0.0.1:<port>/readyz`
for up to 10 s. The launch claim is then updated to `status: "ready"` with the resume app-server's
URL/pid and the thread id/rollout path (`:278-285`). Finally the visible TUI is spawned with
`stdin/stdout/stderr: "inherit"` and the launcher blocks on `tui.exited`; when the TUI exits, the
resume app-server is SIGTERM'd (`:321-323`).

Both app-servers' stdout/stderr are pumped into a per-peer bounded log at
`~/.agent-peers-codex/logs/<peer>-app-server.log` (`spawnLoggedAppServer`, `:479-496`), so launcher
plumbing never touches the session window.

### 3.2 Claim and root election

In `--remote` mode the **app-server**, not the thin resume TUI, spawns the agent-peers MCP — and it
spawns **one per Codex thread**. `thread/start`, a cold resume, `thread/fork`, a spawned subagent and
a detached review each create a Session with its own stdio MCP child, and unsubscribed threads stay
loaded for 30 minutes, so children accumulate. Every child used to call broker `register()`
unconditionally, so one launch produced N addressable peers and mail addressed to the canonical name
could land in a twin the daemon was not watching.

There is no spawn-time signal identifying the owning thread (the stdio child gets a cleared
environment; `cwd`, `ppid` and tty do not disambiguate; Codex stamps `_meta.threadId` on `tools/call`
but not on the startup `tools/list`). So the launcher elects instead — the full argument is preserved
in the header comment of `shared/wake-launch-role.ts:1-37`.

The election in `codex-server.ts:828-855`:

1. `isWakeLaunchEnv(process.env)` — is `AGENT_PEERS_WAKE_LAUNCH === "1"`? If not, this is an
   ordinary `codex` session → role `standalone` → registers as always.
2. `WakeLaunchClaimStore.findMatching({ cwd, tty, waitMs: 30_000, includeConsumed: true })` locates
   this launch's claim.
3. `tryAcquireRoot(claim_id, process.pid)` (`shared/wake-launch-claims.ts:211-234`) arbitrates by
   **exclusive create** (`flag: "wx"`, atomic on POSIX) of `<claim_id>.root.lock`. `consume()` cannot
   arbitrate — it is a read-modify-write and two children can both observe the claim unconsumed. A
   lock whose owner pid is dead is unlinked and re-acquired, so a crashed root does not strand the
   launch.
4. Winner → `root`; loser → `secondary`, which serves an **empty** tool list and returns before
   `setTabTitle`/`ensureBroker`, so it takes no identity, opens no broker connection, and writes no
   escape sequences to the shared terminal (`codex-server.ts:847-855`).

`mcp_servers.agent-peers.required=true` makes Codex await agent-peers init before `Session::spawn`/
`resume` completes, which makes the election deterministic rather than a race: the root thread is
constructed first and no descendant runtime is auto-opened during resume.

### 3.3 Registration

The root child calls `registerWakeableSessionIfEnabled` (`codex-server.ts:1072-1119`) right after
broker registration, and again on any post-eviction rejoin (`:1033`). Hints come from
`resolveWakeRegistrationHints` (`:1121-1156`), which has two branches:

- **env branch** (`:1125-1150`) — used when `AGENT_PEERS_WAKE_ENABLED === "1"`, reading
  `AGENT_PEERS_WAKE_THREAD_ID`, `…_APP_SERVER_URL`, `…_APP_SERVER_PID`, `…_APP_SERVER_SOCKET_PATH`,
  `…_ROLLOUT_PATH`. In the current `--remote` architecture nothing propagates these into the MCP
  child, so this branch is effectively unreachable on a normal launch (see Red Flags).
- **claim branch** (`:1155`) — returns the `wakeRootClaim` this child won during the election. This
  is the path that actually fires.

The registry row is upserted with `status: "ready"`, `capabilities: ["app-server-ws"]`,
`mcp_pid: process.pid`, and a SHA-256 hash of the broker session token. The claim is then marked
`consumed`, and the module flag `isWakeableSession = true` is set — which is what short-circuits
`wait_for_peer_messages` for this session (`codex-server.ts:749-750`).

### 3.4 Idle → mail → wake

While the session is idle it runs no inference. When mail arrives, `codex-server.ts` writes the
message body to `<peer-id>.json` and a **bodyless** envelope digest to `<peer-id>.metadata.json`
(`shared/codex-inbox.ts:208-210`). The daemon reads only the metadata file.

One pass (`runWakePass`, `shared/wake-daemon.ts:94-216`) per peer entry:

| Order | Check | Skip reason |
| --- | --- | --- |
| 1 | metadata file missing or `unread` empty | `no_pending_metadata` (silent, no round-trip) |
| 2 | peer is inside a wedged-state cooldown | `thread_system_error` (silent, no round-trip) |
| 3 | `thread/loaded/list` does not contain the thread | `thread_not_loaded` |
| 4 | `thread/read` fails validation (§4) | one of the `validateThread` reasons |
| 5 | ledger cooldown / attempt cap | `duplicate_or_cooldown` / `max_attempts` |
| 6 | `turn/start` throws | `wake_failed` |
| — | any app-server connect/RPC error | `app_server_unreachable` (pass continues to next peer) |

A successful wake emits `action: "wake"`, `reason: "nudged"`, a fresh `wake_id` (UUID) and the
returned `turn_id`, and **resets** that peer's observation record so the next anomaly logs fresh
(`:170-173`).

### 3.5 Staleness — what `wakeable=no (stale)` means

`WakeRegistry.isLive` (`shared/wake-registry.ts:193-199`) requires all of:

- `app_server_pid` alive (`process.kill(pid, 0)`),
- `mcp_pid` alive,
- `tui_pid` alive when non-null,
- `app_server_socket_path` exists when non-null (a `null` path passes trivially).

`list()` drops non-live rows by default; `list({ includeStale: true })` returns them with `status`
rewritten to `"stale"`. `cli.ts` uses the `includeStale` form, which is why `codexpeer live` can
print `wakeable=no (stale)` and a "Stale or registry-only wake entries" section. The daemon uses the
default form, so a stale row is simply never woken.

`prune({ deadGraceMs })` (`:152-172`) removes non-live rows whose `last_seen_at` is older than the
grace window (default 30 min in the daemon, `shared/wake-daemon.ts:67`). Live rows are never pruned.

---

## 4. Same-thread validation

`validateThread` (`shared/wake-daemon.ts:218-231`) runs before every wake and is the guarantee that
a nudge cannot land on the wrong session or interrupt work:

| Condition | Reason returned |
| --- | --- |
| `thread.id !== entry.thread_id` | `thread_identity_mismatch` |
| `thread.cwd !== entry.cwd` | `cwd_mismatch` |
| registry has a rollout path and `thread.path` differs | `rollout_mismatch` |
| `status.type === "notLoaded"` | `thread_not_loaded` |
| `status.type === "systemError"` | `thread_system_error` |
| `active` + `waitingOnApproval` | `waiting_on_approval` |
| `active` + `waitingOnUserInput` | `waiting_on_user_input` |
| `active` (no flags) | `thread_active` |
| anything not `idle` | `unknown_thread_status` |
| `idle` | `null` → eligible |

---

## 5. Backoff: two independent mechanisms

### 5.1 `WakeLedger` — throttles re-waking the *same* unread set

(`shared/wake-daemon.ts:281-392`, state in `~/.agent-peers-codex/wake-ledger/<sha256>.json`.)

The key is `pendingSignature(peerId, metadata)` = `sha256(peerId + ":" + sorted unread ids)`
(`:83-87`). A **new** message changes the signature and always wakes immediately; only a repeat of
the identical unread set is throttled.

`DEFAULT_BACKOFF_SCHEDULE_MS = [5m, 30m, 2h]` (`:65`). The schedule entries are the waits *before*
attempts 2, 3, 4; `maxAttempts = schedule.length + 1 = 4`. On the 4th observation the record is
flipped to `abandoned` and no further proactive nudge is sent for that unread set. The message is
**not** dropped — it stays in the durable inbox and still surfaces on the session's next tool call
or user turn.

Records are garbage-collected after `DEFAULT_LEDGER_TTL_MS = 24h` (`:66`).

### 5.2 `WakeObservationLog` — log coalescing and wedged-peer re-check backoff

(`shared/wake-daemon.ts:438-571`, state in `~/.agent-peers-codex/wake-observe/<sha256 of peer id>.json`.)

The daemon is bodyless — a fresh process every pass — so cross-pass memory has to live on disk. Each
record holds the last skip `reason`, `first_seen_at`, `log_count`, `observe_count`, `backoff_index`,
`next_log_at`, and optionally `next_check_at`.

- **First sight of a reason, or a change of reason** → log once (a transition).
- **Same reason repeating** → suppressed until `next_log_at`; the heartbeat interval is
  `OBSERVE_HEARTBEAT_MS = 30m` (`:77`) for ordinary reasons.
- **Wedged reasons** (`OBSERVE_BACKOFF_REASONS = {"thread_system_error"}`, `:75`) additionally get
  `next_check_at`, and `recheckBackoff` (`:449-459`) skips the app-server round-trip *and* the log
  line entirely inside the cooldown, escalating `5m → 30m → 2h` (`:76`). A wedged thread cannot be
  woken until a human bounces it, so `bounceHint` (`:427-432`) attaches
  `close the TUI and relaunch \`codexpeer\` in <cwd>` to the line.

An `active` peer is deliberately **not** in the backoff set: its user is mid-turn, and the daemon
wants low-latency delivery the instant it goes idle, so it keeps polling every pass and only
coalesces the log lines.

---

## 6. Public interfaces

### 6.1 Files and directories

Root is `AGENT_PEERS_CODEX_STATE_DIR`, defaulting to `~/.agent-peers-codex`.

| Path | Written by | Mode | Contents |
| --- | --- | --- | --- |
| `wake-registry.json` | `codex-server.ts`, `cli.ts` | 0600 in 0700 dir | `{ entries: WakeRegistryEntry[] }`, atomic temp+rename |
| `wake-launch-claims/<uuid>.json` | launcher, MCP child | 0600 | launch handshake record |
| `wake-launch-claims/<uuid>.root.lock` | MCP child | 0600, `wx` | `{ owner_pid, acquired_at }` |
| `wake-ledger/<sha256>.json` | daemon | 0600 | `{ signature, status, attempts, updated_at, error? }` |
| `wake-observe/<sha256>.json` | daemon | 0600 | per-peer last-skip observation record |
| `<peer-id>.json` / `<peer-id>.metadata.json` | `codex-server.ts` | 0600 | durable inbox + bodyless envelope digest |
| `logs/<peer>-app-server.log[.1…]` | launcher | 0600 in 0700 dir | app-server stdout/stderr, 5 MiB × 3 |
| `wake-daemon.log[.1…]`, `wake-daemon.pid` | `bin/codex-peer` shell redirect | umask default (observed 0644) | daemon output + pidfile |
| `wake-daemon.lock/` | `bin/codex-peer` | dir | atomic single-starter lock |

`WakeRegistry.readStateFromDisk` (`shared/wake-registry.ts:201-218`) fails closed on POSIX: it
returns empty state if the registry file is not a regular file, is owned by another uid, or has a
mode other than exactly `0600`.

### 6.2 Environment variables the code reads

| Variable | Read at | Effect |
| --- | --- | --- |
| `AGENT_PEERS_CODEX_STATE_DIR` | `shared/wake-daemon.ts:95`, `wake-registry.ts:102`, `wake-launch-claims.ts:92`, `bounded-log.ts:56`, `bin/codex-peer:10` | State root for every wake artifact |
| `AGENT_PEERS_WAKE_LAUNCH` | `shared/wake-launch-role.ts:68` | `"1"` (exact) marks an MCP child as belonging to a wakeable launch → election applies |
| `AGENT_PEERS_WAKE_ENABLED` | `codex-server.ts:1125` | `"1"` selects the env-hint registration branch |
| `AGENT_PEERS_WAKE_THREAD_ID` | `codex-server.ts:1126`, `:479` | Thread to register / delivery breadcrumb |
| `AGENT_PEERS_WAKE_APP_SERVER_URL` | `codex-server.ts:1127` | App-server the daemon connects to |
| `AGENT_PEERS_WAKE_APP_SERVER_PID` | `codex-server.ts:1128` | Liveness pid |
| `AGENT_PEERS_WAKE_APP_SERVER_SOCKET_PATH` | `codex-server.ts:1141` | Optional socket liveness path — **never set anywhere in this repo** |
| `AGENT_PEERS_WAKE_ROLLOUT_PATH` | `codex-server.ts:1143` | Rollout path used by `rollout_mismatch` validation |
| `AGENT_PEERS_ENABLED` | `codex-server.ts:811` | `"0"` on the phase-1 app-server → MCP is a no-op, registers nothing |
| `PEER_NAME` | launcher config args, `codex-server.ts:888` | Requested peer name |
| `CODEX_PEER_DAEMON_INTERVAL` | `bin/codex-peer:14` | Seconds between passes (default 5) |
| `CODEX_PEER_DAEMON_LOG_MAX_BYTES` / `_KEEP` | `bin/codex-peer:19-20` | Daemon log copy-truncate rotation (5 MiB × 3) |
| `CODEX_PEER_APP_SERVER_LOG_MAX_BYTES` / `_KEEP` | `shared/bounded-log.ts:61-62` | Per-peer app-server log rotation |
| `CODEX_PEER_VERBOSE` | `bin/codex-peer:115` | `"1"` shows launcher status lines |
| `AGENT_PEERS_MCP_DIR` | `bin/codex-peer:4` | Override for the repo root the wrapper `cd`s into |
| `GOOGLE_ADS_EXPERT_REPO`, `CCR_WEBSITE_REPO` | `bin/codex-peer:5-6` | Override the two hardcoded shortcut repos |
| `CODEX_HOME` | `bin/codex-peer:215` | Where `codex-peer resume` looks for rollouts (default `~/.codex`) |

### 6.3 App-server JSON-RPC calls used

`CodexAppServerWsClient` (`shared/app-server-client.ts:61-224`) speaks JSON-RPC over a plain
WebSocket to `ws://127.0.0.1:<port>`, with a 5 s default timeout on connect and on every request.

| Method | Params | Used by |
| --- | --- | --- |
| `initialize` | `{ clientInfo: { name: "agent-peers-wake-daemon", version: "0.1.0" }, capabilities: {} }` | every `connect()` |
| `thread/loaded/list` | `{}` | daemon pre-check |
| `thread/read` | `{ threadId, includeTurns: false }` | daemon validation, launcher inspect, `codexpeer live` probe |
| `thread/start` | `{ cwd, model, config: { model_reasoning_effort } }` | launcher phase 1 (fresh) |
| `thread/name/set` | `{ threadId, name }` | launcher materialization (no model turn) |
| `turn/start` | `{ threadId, clientUserMessageId, input: [{ type: "text", text, text_elements: [] }] }` | the wake itself |
| `config/mcpServer/reload` | `null` | `reloadMcpServers()` — **no production caller** |

The wake prompt (`buildWakePrompt`, `shared/wake-daemon.ts:89-92`) is fixed text plus a UUID; the
`clientUserMessageId` is `agent-peers-wake-<uuid>`.

### 6.4 `codex-peer` CLI surface

| Subcommand | Behavior |
| --- | --- |
| *(none)* / `here` / `.` | Launch in `$PWD`, auto-named `<repo>-codex` (`auto_peer_name`, `:144-168`; 26-char base cap) |
| `google-ads` \| `ads`, `ccr` \| `ccr-website` | Launch in the two hardcoded repos with fixed names |
| `start <name> <repo> [-- args]` | Launch any repo with a chosen name |
| `resume <session-id> [-- args]` | Read the rollout's `cwd` with `jq`, then launch `--thread-id` |
| `daemon [seconds]` | Foreground wake loop; refuses to double-start |
| `daemon-stop`, `daemon-status`, `ensure-daemon` | Background daemon lifecycle |
| `wake` \| `wake-once` | One verbose pass (`bun wake-daemon.ts`, no `--quiet-noop`) |
| `send`, `peers`, `status`, `live` \| `wake-status`, `messages` | Thin wrappers over `cli.ts` |
| `retire <name-or-id>` | `cli.ts retire` — unregister from broker + drop the wake row |
| `repair-wake` \| `attach-wake <name-or-id>` | `cli.ts repair-wake` — re-attach a live peer to its claim |
| `doc` \| `open-doc` | Opens `docs/examples/wakeable-codex-peer-demo.html` |
| `install [path]` | Symlinks the script to `~/.local/bin/codex-peer` |
| `help` / anything else | Usage; unknown exits 2 |

`wake-daemon.ts` itself takes `--json` (one JSON object per result, ignores the log flag) and
`--quiet-noop` (daemon mode: print only results with `log: true`).

`repair-wake` (`cli.ts:230-299`) is the recovery path when a live Codex peer shows `wakeable=no`. It
matches launch claims by `cwd` + `tty` (narrowed by `requested_peer_name` when available) and
**refuses** when two or more *live* candidates have distinct thread ids, rather than guessing and
wiring the wake pointer to the wrong session (`cli.ts:253-266`).

---

## 7. Data shapes

`WakeRegistryEntry` (`shared/wake-registry.ts:17-36`): `peer_id`, `peer_name`, `cwd`, `git_root`,
`tty`, `thread_id`, `rollout_path`, `app_server_url`, `app_server_socket_path`, `app_server_pid`,
`tui_pid`, `mcp_pid`, `broker_session_token_hash`, `status` (`starting|ready|stale`), `capabilities`,
`created_at`, `updated_at`, `last_seen_at`. Only `ready` and `stale` are ever produced.

`upsert` (`:124-134`) removes any existing row sharing **either** the peer id or the thread id before
inserting, so a relaunch cannot leave a duplicate pointer.

`WakeLaunchClaim` (`shared/wake-launch-claims.ts:15-30`): `claim_id`, `cwd`, `tty`,
`requested_peer_name`, the app-server URL/pid/socket, `thread_id`, `rollout_path`, `tui_pid`,
`status` (`starting|ready|consumed|failed`), timestamps, `consumed_by_peer_id`. A claim is
"complete" only when it is `ready`/`consumed` **and** carries a URL, a positive pid, and a thread id
(`isCompleteClaim`, `:58-66`); "live" additionally requires the app-server (and TUI, if recorded) pid
to be alive (`isLiveClaim`, `:82-86`). Claims are matched within a 10-minute `maxAgeMs` window *or*
while live, and pruned on the same rule.

`WakeResult` (`shared/wake-daemon.ts:14-32`): `peer_id`, `peer_name`, `cwd`, `thread_id`, `action`
(`wake|skip`), `reason`, `log`, optional `note`, `wake_id`, `turn_id`.

---

## 8. Process lifecycle and cleanup

- **Orphan-parent watchdog.** `codex-server.ts:799-805` polls every 1 s and calls
  `parentProcessWasLost(initialParentPid, process.ppid)` — true only when the process started with a
  real parent (`> 1`) that has since become pid 1. Bun's stdio transport can outlive its app-server
  parent, leaving an orphan that heartbeats forever as a live peer; reparenting to launchd is the
  signal that the MCP session is gone, and the MCP exits.
- **Signal handling.** `SIGINT/SIGTERM/SIGHUP/SIGQUIT` and `exit` are armed before any
  `setTabTitle()` call (`codex-server.ts:780-794`), because an unhandled SIGHUP exits 129 without
  firing `exit`.
- **Launcher teardown.** The resume app-server is SIGTERM'd in a `finally` when the TUI exits
  (`shared/wakeable-launcher.ts:321-323`, `stopLoggedAppServer` at `:498-502`); phase-1 app-servers
  are killed the same way. If phase 2 never reaches `status: "ready"`, the claim is marked `failed`
  (`:324-328`).
- **GC every pass.** `runWakePass` finishes with four independent best-effort prunes (`:198-213`):
  ledger TTL, observation TTL, dead registry rows past the grace window, and dead/old launch claims.
  Each is wrapped in its own `try/catch` so a GC failure can never affect wake delivery.
- **Daemon single-instance.** `ensure_daemon` (`bin/codex-peer:253-271`) checks the pidfile, takes an
  atomic `mkdir` lock, re-checks, then `nohup`s + `disown`s the daemon. `run_daemon`
  (`:314-336`) writes its own pid and traps `EXIT/INT/TERM` to remove the pidfile.

---

## 9. Dependencies

- **Codex CLI** — `codex app-server --listen`, `codex resume --remote`, `thread/*` and `turn/start`
  RPCs, `/readyz`, and `-c mcp_servers.agent-peers.*` config injection. `thread/rollback` was
  removed as deprecated in codex-cli 0.146.1 (`shared/app-server-client.ts:140-150`).
- **Broker** (`broker.ts` + `shared/broker-client.ts`) — peer registration, name uniqueness ladder,
  message delivery. The daemon itself never talks to the broker; it reads inbox metadata files.
- **Bun** — `Bun.spawn`, `Bun.sleep`, `bun:sqlite` (in `cli.ts`), and the global `WebSocket`/`fetch`.
- **`ps`/`kill(0)`** — all liveness is pid-probe based; there is no launchd job for the wake daemon
  (it is a `nohup`'d background shell loop, restarted by the next launch after a reboot).
- **`jq`** — required only by `codex-peer resume` to read `cwd` out of a rollout (`bin/codex-peer:219-220`).

---

## 10. Entry points

| Entry | Invocation |
| --- | --- |
| Wake pass (one shot) | `bun wake-daemon.ts [--json] [--quiet-noop]` |
| Wake loop | `codex-peer daemon [seconds]` → `run_bun wake-daemon.ts --quiet-noop` every N s |
| Auto-started loop | any `codex-peer` launch → `ensure_daemon` → `nohup codex-peer daemon 5 &` |
| Launcher | `bun wakeable-codex.ts [--cwd DIR] [--port N] [--name NAME] [--thread-id ID] [--no-alt-screen] [--materialize\|--no-materialize] [-- codex args]` |
| PATH install | `bun bin/codex-peer install [path]` → symlink at `~/.local/bin/codex-peer` |

Aliases documented in the wrapper's own usage text (`bin/codex-peer:26-34`): `peerwake`, `adspeer`,
`ccrpeer`, `peerlist`, `peerstatus`, `peerrepair`, `peerretire`, `peerdoc`. These are shell aliases
on the author's machine, not installed by this repo.

---

## 11. Tests

`tests/wake-daemon.test.ts`, `wake-daemon-backoff.test.ts`, `wake-daemon-observe.test.ts`,
`wake-registry.test.ts`, `wake-launch-claims.test.ts`, `wake-launch-role.test.ts`,
`wakeable-launcher.test.ts`, `app-server-client.test.ts`, `bounded-log.test.ts`,
`process-lifecycle.test.ts`, `codex-peer-script.test.ts`. Run with `bun test`; type-check with
`bunx tsc --noEmit`.

---

## 12. Drift against the existing wake docs

Both existing docs are broadly accurate; the specific divergences are:

- `docs/wakeable-codex.md:124` says "Normal launches bind the visible session to its exact
  app-server/thread **via env**, so they are unambiguous." The code says the opposite: in `--remote`
  mode the resume command's own `-c` env is ignored and **the claim is authoritative**
  (`shared/wakeable-launcher.ts:274-277`). Normal launches bind by claim, matched on `cwd` + `tty` —
  the same key `repair-wake` uses.
- `docs/wake-daemon.md` was last updated 2026-06-22 and does not mention the `--json` flag, the
  launch-claim GC that now runs every pass (`shared/wake-daemon.ts:211-213`), or the pidfile/lockdir
  auto-start mechanics.
- `docs/wakeable-codex.md:74-78` states that metadata files are fail-closed on read. That is true of
  `shared/codex-inbox.ts` but **not** of the daemon's own reader (`shared/wake-daemon.ts:247-269`),
  which performs no uid/mode check.
- `docs/wakeable-codex.md:305-317` omits `tests/wake-daemon-observe.test.ts` and
  `tests/codex-peer-script.test.ts`.

---

## Red Flags

No `TODO`/`FIXME`/`HACK`/`XXX` markers exist anywhere in the scoped files, and no `as any` or
`@ts-ignore`. The findings below are behavioral.

**Dead or unreachable code**

- `shared/wakeable-launcher.ts:109-129` — `buildMcpEnvConfigArgs` injects `AGENT_PEERS_WAKE_*` as
  `-c mcp_servers.agent-peers.env.*` onto the **resume TUI** command, but the file's own comment at
  `:274-277` states the TUI's `-c` env is ignored in `--remote` mode. Dead config, entrenched by
  `tests/wakeable-launcher.test.ts:80-88`.
- `shared/wakeable-launcher.ts:198-215` — `buildWakeableEnv` exports `AGENT_PEERS_WAKE_*` into the
  TUI process env, but the TUI spawns no MCP in `--remote` mode; the values never reach a child that
  reads them.
- `codex-server.ts:1125-1150` — consequently the entire env-hint registration branch is unreachable
  on a normal launch. It is the *first* branch checked, has different semantics from the claim path,
  and is the only place `AGENT_PEERS_WAKE_APP_SERVER_SOCKET_PATH` is read.
- `codex-server.ts:1141` — `AGENT_PEERS_WAKE_APP_SERVER_SOCKET_PATH` is set by nothing in the repo,
  so `app_server_socket_path` is always `null`, and `socketPathExists(null)` returns `true`
  (`shared/wake-registry.ts:82-84`). The socket liveness check is a permanent no-op.
- `shared/wake-registry.ts:181-191` — `markSeen()` has no caller outside tests.
- `shared/wake-registry.ts:174-179` — `getByPeerId()` has no caller outside tests.
- `shared/app-server-client.ts:157-160` — `reloadMcpServers()` has no production caller (only
  `tests/app-server-client.test.ts:143`).
- `shared/app-server-client.ts:33-39, 162-177` — `startWakeTurn` takes `wakeId` and
  `pendingSignature` and sends neither; the wake id reaches the model only inside the prompt text.
- `shared/wake-registry.ts:11` — `WakeRegistryStatus` includes `"starting"`, which is never written.

**Correctness / reliability**

- `shared/wake-registry.ts:147-172` — because `markSeen()` is never called, `last_seen_at` is fixed
  at registration time, so `prune`'s "keeps a freshly-died session visible for 30 min" comment is
  false for any session that lived longer than `deadGraceMs`: its row is removed on the first pass
  after death, before the operator can diagnose it in `codexpeer live`.
- `codex-server.ts:1144` — in the env-hint path `tui_pid: process.ppid` is the **app-server** pid
  (the MCP's parent), not the TUI's. If that path ever fires, `isLive` probes the same pid twice and
  the registry reports a wrong `tui_pid`.
- `shared/codex-inbox.ts:100-104` resolves the state root as `AGENT_PEERS_STATE_DIR ??
  AGENT_PEERS_CODEX_STATE_DIR ?? ~/.agent-peers-<runtime>`, but `shared/wake-daemon.ts:95`,
  `wake-registry.ts:102` and `wake-launch-claims.ts:92` honour only `AGENT_PEERS_CODEX_STATE_DIR`.
  With `AGENT_PEERS_STATE_DIR` set, metadata is written where the daemon never looks — silent
  permanent no-wake with no error anywhere.
- `shared/wake-daemon.ts:322-324` — if a ledger record's `updated_at` is unparseable, `elapsed` is
  `NaN` and the guard returns `duplicate_or_cooldown` forever; a single corrupt file suppresses
  re-wakes for that unread set until the 24 h TTL GC removes it.
- `shared/wake-daemon.ts:185-188` — a failed `turn/start` is marked `failed` *after* `claim()` has
  already incremented `attempts`, so transient app-server failures consume the 4-attempt budget
  exactly like delivered wakes; the ledger cannot distinguish "shown to the model 4 times" from
  "failed to deliver 4 times".
- `bin/codex-peer:4` + `:338-349` — `ROOT_DIR` is derived from `dirname "${BASH_SOURCE[0]}"` with no
  symlink resolution, while `install_command` installs a **symlink** at `~/.local/bin/codex-peer`.
  Invoked through that symlink, `ROOT_DIR` resolves to `~/.local` and every `run_bun` call fails
  unless `AGENT_PEERS_MCP_DIR` is exported (verified: `dirname` of a symlink path is not resolved).
- `bin/codex-peer:253-271` — if a launcher dies between `mkdir "$DAEMON_LOCKDIR"` and the matching
  `rmdir`, `ensure_daemon` returns success forever and the wake daemon silently never auto-starts
  again. There is no stale-lock reclaim, unlike `WakeLaunchClaimStore.tryAcquireRoot`.
- `bin/codex-peer:236-247` — `daemon_pid` validates only `kill -0`, with no check that the pid is
  actually the daemon. A recycled pid makes `daemon-status` report "running" and suppresses
  auto-start.
- `shared/wake-launch-claims.ts:211-233` — `tryAcquireRoot` recurses after reclaiming a dead owner's
  lock with no depth bound; two children each reclaiming in turn could recurse repeatedly.
- `shared/wake-launch-claims.ts:68-70` — `isRecent` reads `Date.now()` directly while `prune()`
  accepts an injectable `now`, so a frozen test clock cannot control matching consistently.
- `shared/app-server-client.ts:179-182` — `close()` nulls `this.ws` immediately; pending requests are
  only rejected later, when the socket's `close` event fires against the shared `pending` map. A
  reconnect in that window shares state with the dying socket.

**Security / permissions**

- `shared/wake-daemon.ts:247-269` — `readAllInboxMetadata` reads every `*.metadata.json` with no
  uid/mode fail-closed check, unlike `shared/codex-inbox.ts:225-250`. Any same-uid process can plant
  a metadata file and cause repeated model turns (bodyless, so no content injection, but it burns
  tokens). This also contradicts the fail-closed claim in `docs/wakeable-codex.md:74-78`.
- `bin/codex-peer:265-267` — `wake-daemon.log` and `wake-daemon.pid` are created by shell redirection
  under the default umask (observed `0644`) while every other wake artifact is `0600`. The log
  contains peer names, thread ids, and repo paths.
- `shared/bounded-log.ts:23-24` — `chmodSync(dirname(path), 0o700)` runs unconditionally, including
  on Windows where every other module guards with `IS_POSIX`; and `append()` re-chmods the file on
  every single write (`:34`), one extra syscall per log line.

**Hardcoded values / portability**

- `bin/codex-peer:5-6, 144-155, 372-376` — `/Users/mike/www/ai/google-ads-expert` and
  `/Users/mike/www/ai/ccr-website` are hardcoded defaults with dedicated `google-ads` / `ccr`
  subcommands and `auto_peer_name` special cases. Machine-specific logic in a shared wrapper.
- `bin/codex-peer:26-34` — the usage text advertises personal shell aliases this repo does not install.
- `shared/wakeable-launcher.ts:163-170, 356-359` — `gpt-5.6-sol` and `model_reasoning_effort=high`
  are hardcoded for fresh threads with no env override.
- `shared/wakeable-launcher.ts:422, 464-477` — 10 s fixed timeouts for rollout-on-disk and `/readyz`;
  `shared/wake-daemon.ts:65-67` — backoff, TTL and grace constants are compile-time only (injectable
  in `WakeDaemonOptions` but nothing on the CLI path passes them).
- `shared/wakeable-launcher.ts:528-540` — `retryEmptyRolloutRace` retries a magic count of 20 × 100 ms
  keyed on **substring matching an app-server error message** (`isEmptyRolloutRaceError`, `:521-526`),
  which will silently stop working if Codex rewords the error.

**Performance / churn**

- `shared/wake-daemon.ts:140` — a fresh `WebSocket` + `initialize` handshake per peer per pass; at the
  default 5 s interval that is ~17k connections/day/peer. Inherent to the bodyless design, but real.
- `shared/wake-daemon.ts:466-510` — `annotate` writes the observation file on **every** skip, including
  the suppressed branch at `:508` where the only change is an incremented counter. A busy peer causes
  one small atomic temp+rename every 5 s indefinitely.
- `bin/codex-peer:299-312` — daemon log rotation only runs inside the foreground `run_daemon` loop, so
  `codex-peer wake` never rotates; and the copy-truncate window can lose lines written between `cp`
  and `: >` (acknowledged in the comment at `:294-298`).
- `bin/codex-peer:170-174` — `run_bun` performs a bare `cd "$ROOT_DIR"` in the current shell rather
  than a subshell, permanently changing cwd mid-invocation; the launcher has to compensate with an
  explicit `cwd:` on both spawns (`shared/wakeable-launcher.ts:264-268`).
