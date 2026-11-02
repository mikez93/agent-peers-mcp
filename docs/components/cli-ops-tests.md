# Operations CLI, Deployment & Tests

Truth-from-code as of repo HEAD `9be6159` (the accepted four-host baseline). Where this file and the
code disagree, the code wins. Line numbers are left out on purpose; use function and command names.

Scope: `cli.ts`, `bin/codex-peer` (operational surface only; wake internals are in
[wake-subsystem.md](wake-subsystem.md), [../wakeable-codex.md](../wakeable-codex.md) and
[../wake-daemon.md](../wake-daemon.md)), `package.json`, `.env.example`, the launchd and systemd
deployment, the test suite, and the status of `docs/known-issues-2026-08-08.md`.

---

## 1. Purpose: the operator surface

The peer network has several independent stores that can disagree with each other:

| Store | Location | Written by |
|---|---|---|
| Broker rows (peers, messages, leases, chat routes) | SQLite at `~/.agent-peers.db` | `broker.ts` only |
| Durable inboxes (message bodies, per peer UUID) | `~/.agent-peers-{codex,hermes,droid,claude,openclaw}/<peer-id>.json` | each MCP server |
| Wake pointers (thread/app-server per peer UUID) | `~/.agent-peers-codex/wake-registry.json` | wakeable launcher, Codex desktop registration, wake daemon |
| Hermes and OpenClaw wake ledgers | `~/.agent-peers-hermes/chat-wake/`, `~/.agent-peers-openclaw/` | wake daemon passes |

When those drift (a peer dies and re-registers under a new UUID, a wake pointer is lost, an inbox
file outlives its broker row), messages become invisible rather than lost. `cli.ts` makes each store
separately visible and repairs the drift. It is explicitly a *recovery* tool: it is pointed at damaged
and even pre-migration snapshots, and several commands degrade rather than crash when they find one
(`stranded-messages` probes `pragma_table_info` before reading `message_uid`).

Each machine has its own broker, database and inboxes, so `cli.ts` always operates on the machine it
runs on. `peers` and `send` can reach other machines through federation (`name@host`); everything
else is local.

**State directory resolution.** `shared/state-dir.ts` (`resolveStateDir`) is the single resolver,
with two layouts. *Inbox* directories (where MCP servers write and the CLI reads message files) take
`AGENT_PEERS_STATE_DIR` first, then `AGENT_PEERS_<RUNTIME>_STATE_DIR`, then a default of
`~/.agent-peers-<runtime>` (Hermes and Droid inboxes also honor `AGENT_PEERS_CODEX_STATE_DIR`
before the default). *Coordination* files (wake registry, launch claims, ledgers, daemon pid and log)
deliberately stay where already-running launchers hold their locks: for Codex and Droid they ignore
the generic `AGENT_PEERS_STATE_DIR`. Getting the inbox order backwards would make the CLI report clean
while mail strands, so `cli.ts inboxes` uses the same resolver as the writers.

**Trust boundary.** The CLI splits its access. Anything that mutates peer state goes through the
broker's authenticated HTTP API. Anything that reads message *bodies* opens SQLite read-only instead,
because the broker refuses to expose bodies over HTTP at all: 127.0.0.1 is reachable by every local
process, so OS file permissions on `~/.agent-peers.db` (0600) are the only real boundary. Two HTTP
endpoints were deleted for exactly this reason: `/admin/rename-peer` and `/orphaned-messages`.

---

## 2. CLI reference

Invoke as `bun cli.ts <sub> [args]` from the repo root, or through the `codex-peer` wrapper (section
4), which forwards a subset. The command list below matches `bun cli.ts` usage output exactly:

```
bun cli.ts status
bun cli.ts peers
bun cli.ts wake-status
bun cli.ts send <name-or-id> <message>
bun cli.ts rename <name-or-id> <new-name>
bun cli.ts retire <name-or-id>
bun cli.ts repair-wake <name-or-id>
bun cli.ts suggest-name <base>
bun cli.ts messages
bun cli.ts orphaned-messages
bun cli.ts inboxes [--stranded]
bun cli.ts stranded-messages
bun cli.ts gc-inboxes [--apply] [--min-age-days N]
bun cli.ts hermes-desktop-clear <profile> <chat-key> [--handled]
bun cli.ts openclaw status [agent]
bun cli.ts openclaw bind <agent>
bun cli.ts openclaw clear <agent> <submission-id|halt> [note]
bun cli.ts openclaw rearm <agent> <submission-id> [note]
bun cli.ts kill-broker
```

Three undocumented aliases are also accepted: `live` (for `wake-status`), `unregister` (for `retire`)
and `attach-wake` (for `repair-wake`). There is no `--help` flag. An unknown subcommand, including
`--help`, prints the usage block above and exits 2; a bare `bun cli.ts` prints it and exits 0.

The broker URL is `http://127.0.0.1:${AGENT_PEERS_PORT:-7900}`. The shared secret is read once at
module load from `AGENT_PEERS_SECRET_PATH` or `~/.agent-peers-secret` and sent in the
`X-Agent-Peers-Secret` header. `/health` is the only unauthenticated route that matters here; every
other route including `/rename-peer` and `/ready` requires the secret. The database is read from
`AGENT_PEERS_DB` or `~/.agent-peers.db`.

### Read-only commands

| Subcommand | Reads | Notes |
|---|---|---|
| `status` | broker HTTP, wake registry, inbox metadata | Liveness check first; **exits 1** if the broker is down. Then runs `peers` and `wake-status`. The only command that fails loudly on a dead broker. |
| `peers` | broker HTTP `list-peers`, scope `machine` | Live peers only (the broker hides rows staler than 60s), newest working session first, with `started_at`, `cwd`, `tty`, `current_status` (persona-prefixed) and `heartbeat`. With federation on, other machines' peers are included, named `name@host`. A durable-but-idle peer is addressable yet absent here. |
| `wake-status` (alias `live`) | broker HTTP, `wake-registry.json`, `*.metadata.json`, app-server WebSocket, Droid launch claims | See below. |
| `messages` | **direct SQLite (read-only)** | Newest first, hard cap 500 rows; prints `Showing newest N of M ... (truncated ...)` when capped. Status per row is `ACKED`, `LEASED` (unexpired lease) or `PENDING`. Bodies truncated to 80 chars. Dead sender or recipient render as `(gone: <8-char-prefix>...)`. |
| `orphaned-messages` | **direct SQLite (read-only)** | Strict definition: unacked *and* the recipient row is **gone**. Misses the durable-peer case, which is what `stranded-messages` is for. |
| `stranded-messages` | **direct SQLite (read-only)** | The complement: unacked mail whose recipient row **exists** but has `last_seen` older than 24h. Prints full bodies (recovery output, not a preview). Tolerates a pre-migration DB with no `message_uid` column. |
| `inboxes` | inbox files plus SQLite | Enumerates inbox files across the five runtime directories (codex, hermes, droid, claude, openclaw), joins each to its broker row, labels rows with no broker row `DEAD (no broker row)`, and shows `(durable)` for durable peers. Footer totals unread in dead inboxes. `--stranded` additionally prints full bodies for dead inboxes only. |
| `suggest-name <base>` | broker HTTP `list-peers` with `local_only` | Machine-readable: **only** the chosen name goes to stdout. Returns `base` unchanged if free or if the broker is unreachable; adds a memorable suffix (`repo-codex-otter`) on a live collision. Considers local names only, so a sleeping remote host cannot delay a launch. Consumed by `bin/codex-peer`. |

`wake-status` partitions live Codex peers into three buckets (wakeable: registry `status === "ready"`;
*looks like a wakeable launch but needs repair*: no registry entry and the name matches
`/(?:^|-)codex(?:-\d+)?$/`; and other), then appends registry entries with no live broker row as "stale
or registry-only". For wakeable rows it probes the real app-server thread status over WebSocket and
prints it as `thread_status=`, the ground truth to trust over the Codex TUI's spinner, which lingers as
"working" after an externally injected wake turn. The probe is best-effort and bounded (3s per RPC, all
peers concurrently, so the command is bounded at roughly 6s) and a wedged app-server just omits the
field. A second section, "Wakeable Factory Droid sessions", lists Droid peers and bound Droid launch
claims with `broker=`, `session=`, `mcp=`, `wakeable=` and `unread=`; claims whose launcher and MCP
processes are both dead are hidden and counted. Hermes and OpenClaw wake state is **not** shown here;
use `openclaw status` and the Hermes ledgers.

### Mutating commands

| Subcommand | Writes | Destructive? | Notes and safety rails |
|---|---|---|---|
| `send <name-or-id> <message...>` | broker HTTP | No | Trailing args are joined with spaces, so quoting is optional. The target may be any address the broker resolves, including `name@host` and `name/<chat>`. Registers a throwaway peer `cli-operator-<pid>` (type `claude`) because the broker requires `from_id` to resolve to a live registered peer, then **always** unregisters in a `finally`. Prints `sent (id=..., from=...)` plus any broker notice (a remote send is queued, not delivered). Exits 1 on failure after cleaning up. |
| `rename <name-or-id> <new-name>` | SQLite read, broker HTTP | No | Reads the target's `session_token` out of SQLite and impersonates the peer against the ordinary session-authenticated `/rename-peer`. Exits 1 on unknown target or broker rejection. Session-scoped for durable peers: a `PEER_NAME`-configured peer re-registers under its configured name on restart. |
| `retire <name-or-id>` (alias `unregister`) | broker HTTP, wake registry | Partially | Removes the peer from discovery and drops its wake-registry row. **Message history and inbox files are deliberately preserved** and it says so. If the broker row is already gone it falls back to retiring a matching stale wake entry by name or id. |
| `repair-wake <name-or-id>` (alias `attach-wake`) | wake registry, claim store | No | Codex peers only (exits 1 otherwise). Matches launch claims on cwd+tty. **Ambiguity guard:** if two or more *live* claims with distinct thread ids match, it refuses, prints every candidate, and tells the operator to retire the stragglers first, because wiring the pointer to the wrong thread would wake the wrong session. Otherwise prefers a live claim, falling back to the newest complete one. |
| `gc-inboxes [--apply] [--min-age-days N]` | renames inbox files | **Yes** (archival only) | See below. |
| `hermes-desktop-clear <profile> <chat-key> [--handled]` | Hermes chat-wake ledger | No | Resolves a Hermes Desktop wake attempt that the in-process plugin left unresolved (unknown or unreadable evidence blocks re-waking that chat until an operator decides). Without `--handled` the attempt is cleared and the next tick may wake the chat again; with `--handled` the reviewed wake is recorded as having reached a turn, so its mail is not re-woken. Prints `<state>: <detail>`, or `no ledger for that chat`. Needs exactly two positional arguments. Background in [hermes-desktop-wake.md](hermes-desktop-wake.md). |
| `openclaw status [agent]` | none (reads Gateway state) | No | Lists enabled agents, the kill switch, any held ledger lock, the agent's binding and its last ten submissions. Reconciles open submissions from custody with read-only Gateway calls. |
| `openclaw bind <agent>` | OpenClaw ledger, one Gateway submission | No | Submits one bodyless message into `agent:<agent>:main` so its agent-peers child can prove its Codex thread. Exits 1 unless the result is `submitted`. |
| `openclaw clear <agent> <submission-id\|halt> [note]` | OpenClaw ledger | No | Records an operator decision about an open submission, or lifts a halt. It cancels nothing inside OpenClaw. |
| `openclaw rearm <agent> <submission-id> [note]` | OpenClaw ledger | No | Allows exactly one more wake for the unread set a finished submission already woke. Only a terminal submission can be re-armed; nothing is sent until the next pass. |
| `kill-broker` | SIGTERM | **Yes** | Targets **only** the pid from the broker's own `/health` payload. The old `lsof -i :PORT` implementation returned the listener *and* every established MCP client connection, so it killed the broker and every live peer. Prints `broker not running` and returns 0 if `/health` doesn't answer; throws on a nonsensical pid (1 or less, or non-integer). Under a service manager it is a *restart* (see section 3). |

The `openclaw` subcommands are an operator runbook, not a daily tool. Semantics, the custody ledger,
locks and recovery steps are in [openclaw-peer.md](openclaw-peer.md); an `openclaw` command with an
unknown action or no agent throws a usage error.

`gc-inboxes` carries the most safety rails in the file, in layers:

- **Dry-run is the default.** Without `--apply` it prints `would archive ...` per file plus each file's
  mtime age in days, and the footer names `--apply` as the way to act.
- **Only dead inboxes are candidates.** A file whose peer UUID still has *any* row in `peers` is skipped,
  live or merely retained. A file belonging to a legacy Hermes conversation mailbox is also skipped.
- **7-day mtime gate.** A dead inbox modified more recently than `--min-age-days` (default 7) is skipped
  because it may be mid-write.
- **Skips are announced, not silent.** The footer reports the count skipped for recency, the threshold,
  and the escape hatch (`--min-age-days 0`).
- **Archive, never delete.** Files are renamed to `<path>.archived-<ISO-timestamp-with-:-and-.-replaced-by->`,
  and the sidecar `.metadata.json` is renamed alongside. The timestamp is load-bearing: a bare
  `.archived` suffix would clobber a previous archive of the same peer UUID and silently destroy the
  bodies this command exists to protect.

### Argument handling

Validation is minimal: `send` requires 2 or more args, `rename` exactly 2, `retire`, `repair-wake` and
`suggest-name` exactly 1, `hermes-desktop-clear` exactly 2 plus the optional flag; each exits 2 with a
one-line usage string. Flags are matched by `rest.includes(...)` and `rest.indexOf(...)`, so
unrecognized flags are silently ignored and the `--flag=value` form is not supported (see Red Flags).

---

## 3. Deployment

### The broker is owned by the service manager

The controlling contract is in `shared/ensure-broker.ts`: **launchd (macOS) or systemd --user (Linux)
is the only process that starts the broker in production.** A client-spawned broker inherits the
client's environment (`AGENT_PEERS_DB`, `PEER_NAME`, cwd) and its lifetime, which is how a Hermes gateway
ended up owning port 7900 while the launchd service crash-looped 122 times on `EADDRINUSE`.

**macOS**, `~/Library/LaunchAgents/com.mike.agent-peers-broker.plist` (machine state, not tracked in
this repo; contents as read on the MacBook):

| Key | Value |
|---|---|
| `Label` | `com.mike.agent-peers-broker` |
| `ProgramArguments` | `/Users/mike/.bun/bin/bun`, `/Users/mike/agent-peers-mcp/broker.ts`, `--owner=launchd` |
| `EnvironmentVariables` | `AGENT_PEERS_PORT=7900`, `AGENT_PEERS_DB=/Users/mike/.agent-peers.db`, `AGENT_PEERS_FEDERATION=1` |
| `RunAtLoad` / `KeepAlive` | both `true` |
| `ThrottleInterval` | `5` |
| `StandardOutPath` / `StandardErrorPath` | `/Users/mike/Library/Logs/agent-peers-broker.log` |

**Linux** (Omarchy, Hetzner), tracked in `deploy/linux/`: `agent-peers-broker.service` runs
`%h/.bun/bin/bun %h/agent-peers-mcp/broker.ts --owner=systemd` with `AGENT_PEERS_PORT=7900`,
`AGENT_PEERS_DB=%h/.agent-peers.db`, `AGENT_PEERS_FEDERATION=1`, `Restart=always`, `RestartSec=5`.
`agent-peers-wake.service` runs `%h/agent-peers-mcp/bin/codex-peer daemon 5` with `Restart=always`
(section 4). `deploy/linux/install.sh <host-alias>` installs bun if missing, clones or fast-forwards
`~/agent-peers-mcp` (`AGENT_PEERS_REF`, default `main`), writes `~/.agent-peers-host`, requires the fleet
map and federation secret to already exist, installs both units, enables lingering, starts them, and
prints `/ready`. Re-running it is the update path. Logs: `journalctl --user -u agent-peers-broker`.
Details, Tailscale Serve and rollback in [linux-brokers.md](linux-brokers.md).

The `--owner=` flag is the whole point. `startBrokerMain` branches on it (details in
[broker.md](broker.md)):

- **`owner=launchd` or `owner=systemd`** treats itself as the sole legitimate owner of the port. On
  `EADDRINUSE` it identifies the actual listening pid via `lsof -ti tcp:7900 -sTCP:LISTEN` (or `ss` when
  `lsof` is missing), SIGTERMs it, waits up to 5s for it to die, and retries: 4 bind attempts for at most
  3 evictions. Each pid is signalled at most once. The eviction target comes from the socket owner, never
  from the squatter's own unauthenticated `/health` response.
- **`owner=client`** (legacy self-spawn, or a manual `bun broker.ts`) yields on `EADDRINUSE` with
  **exit 0**: never crash-loops, never fights.

The owner is echoed on the startup line and on `/health` and `/ready`: `[broker] listening on
http://127.0.0.1:7900, db=..., pid=..., owner=launchd, epoch=...`.

### How a client brings the broker up

`ensureBroker` never spawns in production. If the broker is not ready it runs
`launchctl kickstart gui/<uid>/com.mike.agent-peers-broker` on macOS or `systemctl --user start
agent-peers-broker` on Linux (no-ops if the service is already running), then polls readiness every 250ms
for up to **15s**. On timeout it throws an error that names the service, the diagnostic command, the log
location, and the escape hatch. The legacy self-spawn path survives only behind
`AGENT_PEERS_SPAWN_BROKER=1` (tests, dev boxes with no service) and pins the child environment: only
`PATH`, `HOME`, and, when set, `AGENT_PEERS_PORT`, `AGENT_PEERS_DB`, `AGENT_PEERS_SECRET_PATH` are
forwarded.

Clients additionally verify *which* broker answered. `createReadinessProbe` checks `GET /ready` (with the
secret) for `protocol: 1`, a matching `db_id`, and an acceptable `owner`: `launchd` or `systemd` always,
`client` only in dev mode and only for that literal value. A squatter answering `/health` cannot satisfy
it, which makes `ensureBroker` start the real service, whose startup evicts the squatter.

### Operating the service

macOS:

```bash
launchctl print   gui/$(id -u)/com.mike.agent-peers-broker      # state, last exit, pid
launchctl kickstart -k gui/$(id -u)/com.mike.agent-peers-broker # restart in place
launchctl bootout   gui/$(id -u)/com.mike.agent-peers-broker    # unload
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mike.agent-peers-broker.plist
tail -f ~/Library/Logs/agent-peers-broker.log
```

Linux:

```bash
systemctl --user status agent-peers-broker agent-peers-wake
systemctl --user restart agent-peers-broker
journalctl --user -u agent-peers-broker -f
```

> **Operational hazard: the bootout then bootstrap race (macOS).** A `bootout` immediately followed by a
> `bootstrap` fails with `Input/output error` (errno 5): launchd has not finished tearing the old job
> down. Wait 2 to 3 seconds between the two, or prefer `launchctl kickstart -k`, which restarts in place.
> This is field knowledge about launchd, not a behavior of this repo.

`KeepAlive` (launchd) and `Restart=always` (systemd) change the meaning of `cli.ts kill-broker`: it
SIGTERMs the broker, the service manager notices, and starts it again after 5s. It is a *restart*, not a
stop. To actually stop the broker, `bootout` the LaunchAgent or `systemctl --user stop` the unit.

### The wake daemon is also a service

On macOS, `~/Library/LaunchAgents/com.mike.agent-peers-wake.plist` (machine state, contents as read on the
MacBook) runs `/Users/mike/agent-peers-mcp/bin/codex-peer daemon 5` with `RunAtLoad`, `KeepAlive`,
`ThrottleInterval=5`, an explicit `PATH`, and both streams redirected to
`~/.agent-peers-codex/wake-daemon.log`. On Linux the tracked `agent-peers-wake.service` runs the same
command. Neither is referenced by the wrapper itself: `bin/codex-peer` also manages a pidfile-tracked
background daemon of its own (section 4), and the two mechanisms converge only because `run_daemon`
overwrites the pidfile with its own pid, which makes `ensure_daemon` a no-op (see Red Flags).

`wake-daemon.ts` runs three passes each time: Codex (the engine documented in
[wake-subsystem.md](wake-subsystem.md)), Hermes chats (only for profiles listed in
`~/.agent-peers-hermes/chat-wake/enabled`) and OpenClaw main sessions (only for agent ids listed in
`~/.agent-peers-openclaw/wake/enabled`). The Hermes and OpenClaw passes do nothing, and call neither the
broker nor the Gateway, until opted in, and a failure in one never affects the others.

### Secret and DB provisioning

The broker generates `~/.agent-peers-secret` on first startup at mode 0600. Clients read it through
`readSharedSecret`, which fails **closed** on every deviation: a symlink, a non-regular file, an owner
other than the current uid, any mode other than 0600, or a body shorter than 32 chars (a partial write).
Failures print to stderr and return `null` rather than throwing. `waitForSharedSecret` polls for up to 6s
after a spawn.

The broker enforces the same discipline on the DB side: every GC tick chmods `~/.agent-peers.db` and its
`-wal` / `-shm` sidecars to 0600 and then *verifies* them, crashing the broker with a clear error if any
has drifted off 0600 or off the correct owner. Serving with world-readable session tokens is treated as
worse than not serving.

The federation credential (`~/.agent-peers-federation-secret`, 0600) is a separate, fleet-wide value and
is never the local secret; see [federation.md](federation.md).

### Four-host model

The fleet runs four hosts: `macbook` and `studio` (macOS, launchd) and `omarchy` and `hetzner` (Linux,
systemd). Each host is fully independent for storage: its own broker on loopback `127.0.0.1:7900`, its
own `~/.agent-peers.db`, its own local secret. With federation on, brokers discover each other's peers
live and relay mail over Tailscale Serve (`name@host`), but no remote rows are copied into `peers` and
each machine stays authoritative for its own peers and mail ([federation.md](federation.md)). Code
adoption is *rolling*: a broker picks up new code on its next restart, but each MCP client keeps running
the code it loaded at session start, so a session must be closed and relaunched to adopt a change. The
only version negotiation is `/ready`'s `protocol: 1` plus its `capabilities` list.

On the Macs a separate fleet reconcile job (outside this repo) keeps the checkout current; the Linux hosts
are updated by re-running `deploy/linux/install.sh`.

---

## 4. `bin/codex-peer`: operational surface

A bash wrapper (`set -euo pipefail`) that is the human-facing front door. Two jobs matter operationally;
the launch internals belong to [../wakeable-codex.md](../wakeable-codex.md).

**It is a thin forwarder for the CLI.** `peers`, `status`, `live` / `wake-status`, `messages`, `send`,
`retire` / `unregister` and `repair-wake` / `attach-wake` shell into `bun cli.ts ...` after `cd`ing to the
repo root (`run_bun`). It exposes strictly *fewer* commands than `cli.ts`: `inboxes`, `stranded-messages`,
`gc-inboxes`, `orphaned-messages`, `kill-broker`, `suggest-name`, `rename`, `hermes-desktop-clear` and
`openclaw` have no wrapper equivalent and must be run as `bun cli.ts ...` from the repo. It also has
launch commands (default `here`, `start`, `resume`, `google-ads`, `ccr`), `session-cwd <session-id>`
(prints the saved cwd of a Codex session, read-only; the id must be a canonical UUID), `wake` / `wake-once`
(one verbose wake pass), `doc`, and `install`. The default peer name is computed by `peer-name.ts` (the
persona-repository-harness rule, for example `vector-agentic-coding-resources-codex`), then made unique
with `cli.ts suggest-name`. The zsh aliases listed in its usage block (`peerwake`, `adspeer`, `ccrpeer`,
`peerlist`, `peerstatus`, `peerrepair`, `peerretire`, `peerdoc`) are Mike's, not installed by this repo.

**It manages the wake daemon.** `ensure_daemon` is called by every launch path so the daemon comes back
on its own after a reboot. It is idempotent and concurrency-safe: liveness is a pidfile plus `kill -0`,
and the start is guarded by an atomic `mkdir` lockdir with a re-check inside the lock, so simultaneous
launches produce exactly one daemon. The daemon child is started with every `BRAIN_ROUTER_TOKEN_*`
environment variable removed, so a launch's process-scoped credential never leaks into the long-lived
daemon. `daemon-stop` / `daemon-status` inspect the same pidfile. `run_daemon` refuses to start a second
foreground daemon and installs `EXIT` / `INT` / `TERM` traps that remove the pidfile.

The daemon log is size-rotated in-loop (`rotate_daemon_log_if_needed`): at 5 MiB
(`CODEX_PEER_DAEMON_LOG_MAX_BYTES`) it shifts `.1` to `.2` and so on, keeping 3 rotations
(`CODEX_PEER_DAEMON_LOG_KEEP`), then **copy-truncates** rather than renames. Copytruncate is required: the
daemon holds the log fd open in append mode for its whole life, so a rename would leave it writing into an
unlinked inode. The tradeoff: a line or two written between the copy and the truncate is lost.

`install` symlinks the script to `~/.local/bin/codex-peer` and warns if that directory is not on `PATH`.
`doc` opens the bundled HTML explainer.

Other launchers in `bin/`: `droidpeer` (alias `droid-peer`) starts wakeable Factory Droid
([../wakeable-droid.md](../wakeable-droid.md)), and `claude-peer-rewake` is the idle-wake hook helper for Claude Code
sessions launched without the development channel (the Claude desktop app).

---

## 5. `package.json` and `.env.example`

`package.json` is minimal: `"private": true`, `"type": "module"`, `packageManager` `bun@1.3.14`, four
scripts (`broker` runs `bun broker.ts`; `test` and `test:ci` run `bun test`; `typecheck` runs
`tsc --noEmit`), one runtime dependency (`@modelcontextprotocol/sdk`), and two dev dependencies
(`@types/bun`, `typescript`). There is no `main` or `exports` field and no build step.

`.env.example` documents six variables: `OPENAI_API_KEY`, `AGENT_PEERS_AUTO_SUMMARY`, `AGENT_PEERS_PORT`,
`AGENT_PEERS_DB`, `PEER_NAME`, `AGENT_PEERS_DISABLE_TAB_TITLE`. The code reads many more
`AGENT_PEERS_*`, `CODEX_PEER_*` and `DROID_PEER_*` variables. Notably absent from `.env.example`:
`AGENT_PEERS_ENABLED` (the master on/off switch), `AGENT_PEERS_SPAWN_BROKER`, `AGENT_PEERS_EPHEMERAL`,
`AGENT_PEERS_FEDERATION`, `AGENT_PEERS_STATE_DIR`, `AGENT_PEERS_HERMES_STATE_DIR`,
`AGENT_PEERS_SECRET_PATH`, `AGENT_PEERS_RUNTIME`, `AGENT_PEERS_HERMES_ROLE`.

---

## 6. Test suite

`bun test` collects **66 test files** (`ls tests/*.test.ts`) plus fixtures in `tests/fixtures/` and one
Python test in `tests/python/`. Run at `9be6159` in a worktree with no `node_modules` (dependencies not
installed): **556 tests pass in the 62 files that load (about 76s, 3559 assertions), 0 fail.** Four files
cannot load without `@modelcontextprotocol/sdk` and are reported by bun as errors, so the raw summary
reads `556 pass, 4 fail, 4 errors`: `openclaw-binding.e2e.test.ts`, `legacy-conversation-retention.test.ts`,
`peer-naming-integration.test.ts` and `hermes-chat-mail.e2e.test.ts`. They are an install problem, not
test failures; run `bun install` first for the full suite. `typecheck` was not run for this document.

```bash
bun test                       # full suite
bun test tests/broker.test.ts  # single file
bun run typecheck              # tsc --noEmit
```

The Hermes Desktop wake plugin's Python tests run through bun: `tests/hermes-desktop-wake-plugin.test.ts`
calls `python3 -B tests/python/test_hermes_desktop_wake.py` (60s timeout), so `bun test` needs `python3`
on `PATH` and Hermes itself is not needed (the tests use a fake plugin context).

### By subsystem

**Broker core: HTTP, SQLite, migration, ownership.** `broker.test.ts` proves every mutation is
session-token authenticated, tokens never leak through `listPeers`, leases deliver once until expiry, and
durable vs ephemeral peers have distinct GC, queue and visibility semantics. `migration.test.ts` proves
pre-session-token DBs upgrade in place, the migration is idempotent, NULL tokens left by a crashed partial
migration self-heal, and the `peer_type` CHECK expands without data loss. `openclaw-migration.test.ts`
proves the final OpenClaw rebuild is lossless (peer IDs, tokens, v3 columns, durable retention).
`broker-ownership.test.ts` spawns real competing broker processes on random ports and asserts a
client-owner yields exit 0 while a service-owner (including `--owner=systemd`) evicts the incumbent.
`phase2-delivery-gc.test.ts` and `phase3-identity.test.ts` are milestone regressions (stale-hide-but-not-delete,
GC grace, retention pruning, typed ack outcomes, `message_uid`, explicit `durable`, peer_type-fenced
reclaim, `prev_id` re-pointing). `heartbeat-eviction.test.ts` proves an evicted or token-rotated peer gets
`known:false`. `broker-client.test.ts` and `broker-client-resilience.test.ts` round-trip
register, send, poll, ack against a live in-process broker, assert every route rejects a missing secret,
and cover secret rotation, timeouts and old brokers. `legacy-conversation-retention.test.ts` covers the
retired-V2 fence.

**Addressing and identity (v3).** `broker-v3-addressing.test.ts` (find-by-name, chat mail isolation, chat
replies, remote hook, bounds; old clients without a chat field must not change), `peer-address.test.ts`,
`peer-identity.test.ts` (persona and default-name derivation), `peer-list.test.ts`, `names.test.ts`
(generation, validation, suffix laddering: the base is trimmed, never the suffix),
`peer-naming-integration.test.ts`, `paperclip-guard.test.ts` (Paperclip agents stay off the network).

**Federation.** `federation.test.ts` (outbox, dedupe, discovery, rejection notices, retry),
`federation-broker.test.ts` (real broker exports), `federation-crash.test.ts` (child processes killed
mid-flight, then recovery), `federation-integrated.e2e.test.ts` (two real brokers over loopback HTTP,
including cross-machine chat listing). None of these is evidence of a configured Tailscale path or a model
actually receiving a message.

**Delivery and inbox.** `delivery-state.test.ts` (piggyback state machine and its arrival-causality
barrier), `codex-inbox-store.test.ts` (dedupe, restart persistence, bodyless metadata, 0600/0700 fail-closed),
`e2e-live-delivery.test.ts` (real broker, sender identity survives the hop, backlog on restart),
`piggyback.test.ts`, `recent-delivered.test.ts`, `wait-for-peer-messages.test.ts`, `summarize.test.ts`,
`session-start.test.ts`, `file-state.test.ts`, `state-dir.test.ts` (the two resolver layouts).

**Wake: Codex.** `wake-daemon.test.ts` (nudge only for loaded idle threads; steering a working thread's
running turn; refusal for not-loaded, approval-wait, user-input-wait and ambiguous-identity threads;
signature dedupe; unsent claims restored), `wake-daemon-backoff.test.ts`, `wake-daemon-observe.test.ts`,
`wake-registry.test.ts`, `wake-launch-claims.test.ts`, `wake-launch-role.test.ts`,
`wakeable-launcher.test.ts`, `app-server-client.test.ts`, `bounded-log.test.ts`,
`process-lifecycle.test.ts`, `codex-peer-script.test.ts` (launcher chatter stays verbose-gated), and
`codex-desktop-wake.test.ts` (desktop chat registration by exact thread id and parent socket).

**Wake: Claude, Hermes, OpenClaw.** `claude-socket-wake.test.ts`, `claude-peer-rewake.test.ts`,
`claude-server-socket-wake.e2e.test.ts` (a session without the development channel is woken through its
inbox socket; channel sessions are left alone). `hermes-chat-wake.test.ts`, `hermes-wake-pass.test.ts`,
`hermes-chat-mail.e2e.test.ts` (per-chat isolation), `hermes-desktop-wake-regressions.test.ts` and
`hermes-desktop-wake-plugin.test.ts` (plus the Python test). `openclaw-gate.test.ts`,
`openclaw-wake-pass.test.ts`, `openclaw-binding.e2e.test.ts`.

**Droid.** `droid-acp-client.test.ts`, `droid-cli.test.ts`, `droid-launch-claims.test.ts`,
`droid-launcher.test.ts`, `droid-native-launcher.test.ts`, `droid-native-relay.test.ts`.

**Readiness, ownership, protection, secrets.** `readiness-probe.test.ts` proves `/ready` fails closed on a
wrong secret, wrong or missing `db_id`, wrong protocol, malformed body, a pre-`/ready` broker, or no
readable secret, even when a squatter answers `/health`, and that `owner=client` passes only in dev mode.
`protection-check.test.ts` covers the reaper contract (the broker vouches for itself despite PPID 1,
unknown pids report *unprotected* not dead, a mismatched `start_time` refuses to vouch, pid 1 is never
expanded). `shared-secret.test.ts` (0644, 0640, symlinks, missing and short files all fail closed).
`ensure-broker.test.ts` (an alive broker returns without spawning, a dead one is started and awaited, the
pinned spawn env strips session variables, via `tests/fixtures/echo-env-broker.ts`).
`cli-kill-broker.test.ts` proves `kill-broker` terminates only the pid from `/health`, leaving a connected
client alive: the regression test for the `lsof`-kills-everything bug. `review-fixes-20260810.test.ts`
locks in fixes from the 2026-08-10 review.

### Execution characteristics worth knowing

Several files spawn real OS subprocesses (`broker-ownership`, `cli-kill-broker`, `ensure-broker`,
`federation-integrated.e2e`, `federation-crash`, and the e2e files that launch MCP servers). Newer
suites bind port 0 or a random port; six older ones bind fixed loopback ports (7911, 7921, 7931, 7933,
7951, 7953), none colliding with the production broker on 7900, so the suite is **not safe to run
concurrently with itself**. `readiness-probe.test.ts` mutates the global `AGENT_PEERS_SPAWN_BROKER` env
var, which is not parallel-safe. A few permission assertions are POSIX-gated with `test.if` and silently
vanish on Windows. `broker.test.ts` relies on a 20ms real sleep to make `last_seen` advance, the tightest
timing margin in the suite.

---

## 7. Known-issues status (`docs/known-issues-2026-08-08.md`)

That document's own header still says "Not yet fixed". Status at `9be6159`:

**Issue 1, unfiltered inbox delivery breaks targeted waits: partially fixed.** `wait_for_peer_messages`
accepts a `from` sender filter in `codex-server.ts` (also loaded by Hermes, Droid and OpenClaw). The
non-matching message is **not consumed**: it stays in the durable queue and still surfaces in
`[PEER INBOX]`, so a wait for one sender no longer eats another's message (documented in
`docs/delivery-contract.md`). Still open: no broker-side filter (`poll-messages` takes only the peer,
token and optional chat) and no `in_reply_to` lineage in the schema, so waiting on a *conversation*
remains impossible. `claude-server.ts` has no `wait_for_peer_messages` tool.

**Issue 2, duplicate and stale registrations pollute the peer list: fixed**, by the inverse of the
suggested design. Ephemeral is the default and durability is an explicit opt-in (`durable: true` plus a
valid requested name), ladder-assigned fallback names stay ephemeral, `listPeers` applies an unconditional
60s `last_seen` cutoff, and GC removes ephemeral rows at 60s and durable at 7 days. The
`cli-operator-<pid>` peer registers with no `durable` field and unregisters in a `finally`, so worst case
(SIGKILL) it ages out in 60s. Covered by `tests/broker.test.ts` and `tests/phase3-identity.test.ts`.

**Issue 3, raw-HTTP client traps: mostly addressed.** `shared/broker-client.ts` is still not importable
(`package.json` has no `main` or `exports`), but [broker.md](broker.md) now documents every route, its
request and response fields (`to_id_or_name`, `lease_tokens`, `text`, `sent_at`, `lease_token`), the
mandatory `X-Agent-Peers-Secret` header, the live-sender rule (`unauthorized sender` vs `sender stale`),
and the mandatory-ack contract.

---

## Red Flags

Ordered roughly by operational severity. Found by reading the code at `9be6159`; none were reproduced
for this document.

### Correctness and safety

1. **`gc-inboxes` accepts a negative `--min-age-days`, defeating its own recency gate.** Only
   `Number.isFinite` is validated, so `--min-age-days -1` passes. The cutoff becomes a *future* timestamp,
   so the "too recent, may be mid-write" guard is silently inverted: every dead inbox is archived,
   including one written a second ago. Mitigated by archive-never-delete, but this is the one destructive
   command in the tool and its primary rail can be turned off by a typo. It should clamp to 0 or more.

2. **The `needs repair` detector cannot see the names this same code generates.** `cmdWakeStatus`
   classifies a peer as a broken wakeable launch with `/(?:^|-)codex(?:-\d+)?$/`. But `cmdSuggestName` is
   designed to hand a second concurrent peer a *memorable* suffix (`ccr-website-codex-otter`) instead of a
   positional `-2`, and `bin/codex-peer` uses it on every launch. `ccr-website-codex-otter` does not match
   the regex, so exactly the peers most likely to need `repair-wake` never appear in the "needs repair"
   bucket and never trigger the tip.

3. **`bin/codex-peer daemon-stop` no longer stops the wake daemon under a service manager.** The macOS
   LaunchAgent and the Linux unit both run `codex-peer daemon 5` with automatic restart. `daemon_stop`
   kills the pid and removes the pidfile, then the service manager restarts it 5s later, with
   `daemon-status` reporting "not running" in the gap. The script has no awareness of either service. To
   stop the daemon, stop the service.

4. **`cli.ts`'s trust-boundary comment is factually wrong about `rename`.** It claims "Direct-SQLite
   commands (rename, messages, orphaned-messages) and `kill-broker` don't [require the secret]".
   `cmdRename` reads SQLite only for the session token and then calls `client.renamePeer`, which sends the
   shared-secret header and is gated like every non-`/health` route. `rename` fails without a readable
   secret.

5. **Most commands have no error handling for a dead broker.** The dispatch is a bare `switch` with
   top-level `await`. Only `status` checks broker liveness. Every other broker-touching command (`peers`,
   `send`, `rename`, `retire`, `repair-wake`) surfaces a raw `fetch` rejection and a stack trace when the
   broker is down, from a tool whose purpose is diagnosing a broken network.

6. **The metadata-rename `catch` in `gc-inboxes` swallows real failures.** The sidecar rename is wrapped in
   a bare `catch` that names one benign cause (no metadata file) but also absorbs `EACCES`, `EXDEV` and a
   partial rename, leaving an orphaned `.metadata.json` next to an archived `.json`. The main file's
   rename is unguarded, so a mid-loop failure aborts the command before the footer prints.

7. **`cmdSend` registers the operator as a `claude` peer.** It is a shell operator, not a Claude session.
   Recipients see a `claude` peer, and `peer_type` is load-bearing (reclaim is peer_type-fenced). Low blast
   radius given the `cli-operator-<pid>` name and immediate unregister.

### Robustness and hygiene

8. **Flag parsing is `includes`/`indexOf` with no validation.** Unrecognized flags are silently ignored:
   `inboxes --strandedd` quietly prints no bodies, and `gc-inboxes --min-age-days=0` (equals form) silently
   uses 7. `hermes-desktop-clear` only strips the exact `--handled` flag, so a typo makes it a third
   positional argument and the command exits 2 with usage.

9. **`BROKER_PORT` has no NaN guard.** `parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10)` with no
   validation. A malformed `AGENT_PEERS_PORT` produces `http://127.0.0.1:NaN` and a confusing fetch
   failure rather than a clear config error.

10. **SQL built by interpolation** in `cmdMessages` (`LIMIT ${LIMIT}`, a local constant 500). Not
    injectable today, but the one place in the file that builds SQL by concatenation.

11. **The DB path is re-derived in four places** (`readPeerAuth`, `cmdMessages`, `cmdOrphans`,
    `openDbReadonly`), each computing `process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db")`.
    `openDbReadonly` exists and does exactly this; the other three predate it.

12. **`node:` imports are dynamically imported inside functions** throughout, rather than once at the top,
    with no apparent reason. `cmdGcInboxes` also drops the row type on `db.query("SELECT id FROM peers ...")`,
    returning `unknown` in a file that otherwise types its rows.

13. **`readAllInboxFiles` has no size limit** and reads every inbox file fully into memory. Theoretical
    today.

14. **Hardcoded personal paths in a shipped script.** `bin/codex-peer` defaults `GOOGLE_ADS_EXPERT_REPO` to
    `/Users/mike/www/ai/google-ads-expert` and `CCR_WEBSITE_REPO` to `/Users/mike/www/ai/ccr-website`, with
    `google-ads` and `ccr` subcommands and alias documentation that says "installed on Mike's machine". Both
    paths are env-overridable, so this is cosmetic.

15. **The wake-daemon log is created by shell redirection under the default umask**, while every other wake
    artifact is 0600. The directory mode (0700) contains the exposure, so this is defense-in-depth drift
    rather than a live leak.

### Staleness

16. **`docs/known-issues-2026-08-08.md` still says "Not yet fixed"** for all three issues (section 7). It
    has no status column or review date, so it reads as current.

17. **The suite is not safe to run concurrently with itself** because six files bind fixed ports and one
    mutates process-global env (section 6). Not a problem for `bun test` today (sequential files in one
    process), but it forecloses parallelization.

18. **`broker.test.ts` depends on a 20ms real sleep** to make `last_seen` strictly advance: the most likely
    source of a future flake under load or a coarse clock.
