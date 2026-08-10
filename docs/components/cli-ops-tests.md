# Operations CLI, Deployment & Tests

Truth-from-code as of repo HEAD `63503f2` (2026-08-10). Every claim below was read out of
the source; where the code and the README disagree, this document follows the code and
the disagreement is recorded in [README accuracy](#7-readme-accuracy-do-not-trust-these-sections).

Scope: `cli.ts`, `bin/codex-peer` (operational surface only — wake internals are documented
in `docs/wakeable-codex.md` and `docs/wake-daemon.md`), `package.json`, `.env.example`,
the launchd deployment, the 31-file test suite, and the status of
`docs/known-issues-2026-08-08.md`.

---

## 1. Purpose — the operator surface

The peer network has three independent stores that can disagree with each other:

| Store | Location | Written by |
|---|---|---|
| Broker rows (peers, messages, leases) | SQLite at `~/.agent-peers.db` | `broker.ts` only |
| Durable inboxes (message bodies, per peer UUID) | `~/.agent-peers-{codex,hermes,claude}/<peer-id>.json` | each MCP server |
| Wake pointers (thread/app-server per peer UUID) | `~/.agent-peers-codex/wake-registry.json` | wakeable launcher + wake daemon |

When those three drift — a peer dies and re-registers under a new UUID, a wake pointer is
lost, an inbox file outlives its broker row — messages become invisible rather than lost.
`cli.ts` is the tool that makes each store separately visible and repairs the drift. It is
explicitly a *recovery* tool: it is pointed at damaged and even pre-migration snapshots, and
several commands are written to degrade rather than crash when they find one
(`cli.ts:655-660` probes `pragma_table_info` before reading `message_uid`).

**Trust boundary.** The CLI deliberately splits its access. Anything that mutates peer state
goes through the broker's authenticated HTTP API. Anything that reads message *bodies* opens
SQLite read-only instead, because the broker refuses to expose bodies over HTTP at all —
127.0.0.1 is reachable by every local process, so OS file permissions on `~/.agent-peers.db`
(0600) are the only real boundary. Two HTTP endpoints were deleted for exactly this reason
and the removals are recorded in the code: `/admin/rename-peer` (`cli.ts:177-181`,
`broker.ts:1442-1445`) and `/orphaned-messages` (`cli.ts:467-469`).

---

## 2. CLI reference

Entry point `cli.ts:718` — a bare `switch` over `process.argv[2]`. Invoke as
`bun cli.ts <sub> [args]` from the repo root, or through the `codex-peer` wrapper
(§4) which forwards a subset.

Broker HTTP calls read the shared secret once at module load (`cli.ts:46`) and send it in
the `X-Agent-Peers-Secret` header. `/health` is the only unauthenticated route
(`broker.ts:1379-1383`); every other route including `/rename-peer` and `/ready` requires
the secret (`broker.ts:1384-1390`).

### Read-only commands

| Subcommand | Args / flags | Reads | Notes |
|---|---|---|---|
| `status` | — | broker HTTP + wake registry + inbox metadata | `cli.ts:104`. Liveness check first; **exits 1** if the broker is down. Then runs `peers` and `wake-status` in sequence. The only command that fails loudly on a dead broker. |
| `peers` | — | broker HTTP `list-peers` | `cli.ts:116`. Scope `machine`. Broker filters rows staler than 60s (`broker.ts:566-573`), so this is live peers only — a durable-but-idle peer is addressable yet absent here. |
| `wake-status` / `live` | — | broker HTTP + `wake-registry.json` + `*.metadata.json` + app-server WS | `cli.ts:301`. See below. |
| `messages` | — | **direct SQLite (read-only)** | `cli.ts:400`. Newest-first, hard cap 500 rows; prints `N of M … (truncated)` when capped. Status per row is `ACKED` / `LEASED` (unexpired lease) / `PENDING`. Bodies truncated to 80 chars. Dead sender/recipient render as `(gone: <8-char-prefix>…)`. |
| `orphaned-messages` | — | **direct SQLite (read-only)** | `cli.ts:466`. Strict definition: unacked *and* the recipient row is **gone** (`LEFT JOIN … WHERE p.id IS NULL`). Misses the durable-peer case — that is what `stranded-messages` is for. |
| `stranded-messages` | — | **direct SQLite (read-only)** | `cli.ts:646`. The complement of the above: unacked mail whose recipient row **exists** but has `last_seen` older than 24h. Prints full bodies (this is recovery output, not a preview). Tolerates a pre-migration DB with no `message_uid` column. |
| `inboxes` | `--stranded` | **inbox files + SQLite** | `cli.ts:620`. Enumerates every inbox file across all three runtime dirs, joins each to its broker row, and labels rows with no broker row `DEAD (no broker row)`. Footer totals unread in dead inboxes. `--stranded` additionally prints full bodies for dead inboxes only. This command exists because 24 Hermes messages were sitting invisible at the time it shipped (`cli.ts:551-558`). |
| `suggest-name` | `<base>` | broker HTTP `list-peers` | `cli.ts:533`. Machine-readable: **only** the chosen name goes to stdout. Returns `base` unchanged if free or if the broker is unreachable; adds a memorable suffix (`repo-codex-otter`) on live collision. Consumed by `bin/codex-peer:186`. |

`wake-status` is the richest read. It partitions live Codex peers into three buckets —
wakeable (registry `status === "ready"`), *looks like a wakeable launch but needs repair*
(no registry entry and the name matches `/(?:^|-)codex(?:-\d+)?$/`, `cli.ts:325`), and
other — then appends registry entries with no live broker row as "stale or registry-only".
For the wakeable rows only, it probes the real app-server thread status over WebSocket
(`cli.ts:22-37`) and prints it as `thread_status=`. That field is the ground truth the
operator should trust over the Codex TUI's spinner, which lingers as "working" after an
externally injected wake turn. The probe is best-effort and bounded — 3s per RPC, all peers
probed concurrently, so the whole command is bounded at roughly 6s regardless of peer count,
and a wedged app-server just omits the field rather than hanging the command.

### Mutating commands

| Subcommand | Args | Writes | Destructive? | Safety rails |
|---|---|---|---|---|
| `send` | `<name-or-id> <message…>` | broker HTTP | No | `cli.ts:132`. Trailing args are joined with spaces, so quoting is optional. Registers a throwaway peer `cli-operator-<pid>` because the broker requires `from_id` to resolve to a live registered peer, then **always** unregisters in a `finally`. `process.exit()` was deliberately moved out of the `try` so the cleanup actually runs (`cli.ts:146-148`); on failure it captures the status, unregisters, then exits 1. |
| `rename` | `<name-or-id> <new-name>` | SQLite read → broker HTTP | No | `cli.ts:176`. Reads the target's `session_token` out of SQLite and impersonates the peer against the ordinary session-authenticated `/rename-peer`. Exits 1 on unknown target or broker rejection. Session-scoped for durable peers: a `PEER_NAME`-configured peer re-registers under its configured name on restart. |
| `retire` / `unregister` | `<name-or-id>` | broker HTTP + wake registry | Partially | `cli.ts:199`. Removes the peer from discovery and drops its wake-registry row. **Message history and inbox files are deliberately preserved** and it says so. If the broker row is already gone it falls back to retiring a matching stale wake entry by name or id. |
| `repair-wake` / `attach-wake` | `<name-or-id>` | wake registry + claim store | No | `cli.ts:230`. Codex peers only (exits 1 otherwise). Matches launch claims on cwd+tty. **Ambiguity guard** (`cli.ts:253-266`): if two or more *live* claims with distinct thread ids match, it refuses, prints every candidate, and tells the operator to retire the stragglers first — wiring the pointer to the wrong thread would wake the wrong session. Otherwise prefers a live claim, falling back to the newest complete one. |
| `gc-inboxes` | `[--apply] [--min-age-days N]` | renames inbox files | **Yes** (archival only) | See below. |
| `kill-broker` | — | SIGTERM | **Yes** | `cli.ts:498`. Targets **only** the pid from the broker's own `/health` payload. The comment at `cli.ts:515-517` records why: the old `lsof -i :PORT` implementation returned the listener *and* every established MCP client connection, so it killed the broker and every live peer. Prints `broker not running` and returns 0 if `/health` doesn't answer; throws on a nonsensical pid (`≤1` or non-integer). |

`gc-inboxes` (`cli.ts:679`) carries the most safety rails in the file, in layers:

- **Dry-run is the default.** Without `--apply` it prints `would archive …` per file plus each file's mtime age in days, and the footer explicitly names `--apply` as the way to act.
- **Only dead inboxes are candidates.** A file whose peer UUID still has *any* row in `peers` is skipped, live or merely retained.
- **7-day mtime gate.** A dead inbox modified more recently than `--min-age-days` (default 7) is skipped because it may be mid-write.
- **Skips are announced, not silent.** The footer reports the count skipped for recency, the threshold, and the escape hatch (`--min-age-days 0`) — `cli.ts:712-715` notes that a silent cap reads as "covered everything".
- **Archive, never delete.** Files are renamed to `<path>.archived-<ISO-timestamp-with-:-and-.-replaced-by->`, and the sidecar `.metadata.json` is renamed alongside. The timestamp is load-bearing: a bare `.archived` suffix would clobber a previous archive of the same peer UUID and silently destroy the bodies this command exists to protect (`cli.ts:698-701`).

### Argument handling

Validation is minimal and uniform: `send` requires ≥2 args, `rename` exactly 2,
`retire` / `repair-wake` / `suggest-name` exactly 1 — each exits 2 with a one-line usage
string. An unknown subcommand prints the full usage block and exits 2; a bare `bun cli.ts`
prints the same block and exits 0 (`cli.ts:804`). Flags are matched by `rest.includes(…)`
and `rest.indexOf(…)`, so unrecognized flags are silently ignored and the `--flag=value`
form is not supported (see Red Flags).

---

## 3. Deployment

### The broker is owned by launchd

The controlling contract is stated at `shared/ensure-broker.ts:6-16`: **launchd is the only
process that starts the broker in production.** A client-spawned broker inherits the
client's environment (`AGENT_PEERS_DB`, `PEER_NAME`, cwd) and its lifetime — which is how a
Hermes gateway ended up owning port 7900 while the launchd service crash-looped 122 times on
`EADDRINUSE`.

`~/Library/LaunchAgents/com.mike.agent-peers-broker.plist` as installed:

| Key | Value |
|---|---|
| `Label` | `com.mike.agent-peers-broker` |
| `ProgramArguments` | `/Users/mike/.bun/bin/bun`, `/Users/mike/agent-peers-mcp/broker.ts`, `--owner=launchd` |
| `EnvironmentVariables` | `AGENT_PEERS_PORT=7900`, `AGENT_PEERS_DB=/Users/mike/.agent-peers.db` |
| `RunAtLoad` / `KeepAlive` | both `true` |
| `ThrottleInterval` | `5` |
| `StandardOutPath` / `StandardErrorPath` | `/Users/mike/Library/Logs/agent-peers-broker.log` |

The `--owner=launchd` flag is the whole point. `broker.ts:1549` parses it into a
`BrokerOwner`, and `startBrokerMain` (`broker.ts:1493`) branches hard on it:

- **`owner=launchd`** treats itself as the sole legitimate owner of the port. On `EADDRINUSE`
  it identifies the actual listening pid via `lsof -ti tcp:7900 -sTCP:LISTEN`, SIGTERMs it,
  waits up to 5s for it to die, and retries — 4 bind attempts for at most 3 evictions, so a
  successful final eviction still gets a bind. Each pid is signalled at most once; if the
  port is busy again afterwards, someone new owns it. The eviction target comes from `lsof`,
  never from the squatter's own unauthenticated `/health` response, which could name an
  arbitrary same-user victim (`broker.ts:1503-1506`).
- **`owner=client`** (legacy self-spawn, or a manual `bun broker.ts`) yields on `EADDRINUSE`
  with **exit 0** — never crash-loops, never fights.

The owner is echoed on every startup line and surfaced on `/health` and `/ready`, so it is
always visible in the log: `[broker] listening on http://127.0.0.1:7900, db=…, pid=…,
owner=launchd, epoch=…`.

### How a client brings the broker up

`ensureBroker` (`shared/ensure-broker.ts:48`) never spawns in production. If the broker is
not alive it runs `launchctl kickstart gui/<uid>/com.mike.agent-peers-broker` — a no-op if
the service is already running — then polls liveness every 250ms for up to **15s** (raised
from an earlier 6s budget because launchd cold start plus SQLite migration can exceed it).
On timeout it throws an error that names the label, the `launchctl print` command, the log
path, and the escape hatch. The legacy self-spawn path survives only behind
`AGENT_PEERS_SPAWN_BROKER=1` (tests, dev boxes with no LaunchAgent) and pins the child
environment so nothing session-specific leaks into a broker that outlives its spawner:
only `PATH`, `HOME`, and — when set — `AGENT_PEERS_PORT`, `AGENT_PEERS_DB`,
`AGENT_PEERS_SECRET_PATH` are forwarded.

Clients additionally verify *which* broker answered. `shared/broker-client.ts:41-83` checks
`/ready` for a matching `db_id`, `protocol`, and an acceptable `owner` — `launchd` always,
`client` only in dev mode and only for that literal value. A squatter answering `/health`
cannot satisfy it, which makes `ensureBroker` kickstart the real service, whose startup
evicts the squatter.

### Operating the service

```bash
launchctl print   gui/$(id -u)/com.mike.agent-peers-broker   # state, last exit, pid
launchctl kickstart -k gui/$(id -u)/com.mike.agent-peers-broker  # restart in place
launchctl bootout   gui/$(id -u)/com.mike.agent-peers-broker   # unload
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mike.agent-peers-broker.plist
tail -f ~/Library/Logs/agent-peers-broker.log
```

> **Operational hazard — the bootout→bootstrap race.** A `bootout` immediately followed by a
> `bootstrap` fails with `Input/output error` (errno 5): launchd has not finished tearing the
> old job down when the new one is submitted. Wait 2–3 seconds between the two, or prefer
> `launchctl kickstart -k`, which restarts in place and avoids the window entirely. This is
> field knowledge about launchd, not a behavior of this repo — nothing in the source
> encodes it, so it is easy to rediscover the hard way.

Note that `KeepAlive=true` changes the meaning of `cli.ts kill-broker` in production: it
SIGTERMs the broker, launchd notices, and after `ThrottleInterval` (5s) starts it again. It
is a *restart*, not a stop. To actually stop the broker, `bootout` the service.

### The wake daemon is also a LaunchAgent

A second plist, `~/Library/LaunchAgents/com.mike.agent-peers-wake.plist`, runs
`/Users/mike/agent-peers-mcp/bin/codex-peer daemon 5` with `RunAtLoad`, `KeepAlive`,
`ThrottleInterval=5`, an explicit `PATH` (launchd jobs get almost none), and both streams
redirected to `~/.agent-peers-codex/wake-daemon.log`. This is *not* referenced anywhere in
the repo — `bin/codex-peer` still manages a pidfile-tracked background daemon of its own
(§4), and the two mechanisms converge only by accident (see Red Flags).

### Secret and DB provisioning

The broker generates `~/.agent-peers-secret` on first startup at mode 0600. Clients read it
through `readSharedSecret` (`shared/shared-secret.ts:52`), which fails **closed** on every
deviation — a symlink, a non-regular file, an owner other than the current uid, any mode
other than 0600, or a body shorter than 32 chars (a partial write). Failures print to stderr
and return `null` rather than throwing. `waitForSharedSecret` polls for up to 6s after a
spawn, since the broker needs a few hundred ms to provision the file.

The broker enforces the same discipline at runtime on the DB side: every GC tick chmods
`~/.agent-peers.db` and its `-wal` / `-shm` sidecars to 0600 and then *verifies* them,
crashing the broker with a clear error if any has drifted off 0600 or off the correct owner
(`broker.ts:1358-1370`). Serving with world-readable session tokens is treated as worse than
not serving.

Observed on this machine, all correct: `~/.agent-peers-secret` 0600, `~/.agent-peers.db`
plus `-wal` / `-shm` 0600, and the three inbox directories 0700 with 0600 contents.

### Both-machine model

The fleet runs a Mac Studio and a MacBook. Today each machine is fully independent: its own
launchd-owned broker on loopback `127.0.0.1:7900`, its own `~/.agent-peers.db`, its own
secret. Nothing crosses machines — `list_peers scope=machine` means what it says. Client
adoption of new code is *rolling*: the broker picks up new code on the next launchd restart,
but each MCP client keeps running the code it loaded at session start, so a session must be
closed and relaunched to adopt a change. There is no push mechanism and no version
negotiation beyond `/ready`'s `protocol: 1`.

Cross-machine federation is designed but **not implemented** — see
`docs/plans/cross-machine-federation-tailscale.md`, which recommends per-machine brokers
with store-and-forward relay over Tailscale, adds `host` / `origin` columns and a
`name@host` addressing form, and introduces a second `~/.agent-peers-federation-secret`
scoped to `/federation/*` routes. None of that exists at `63503f2`; the `host` column from
the parallel identity work does (`tests/phase3-identity.test.ts` asserts `host` is recorded).

---

## 4. `bin/codex-peer` — operational surface

A 442-line bash wrapper (`set -euo pipefail`) that is the human-facing front door. Two jobs
matter operationally; the launch internals belong to `docs/wakeable-codex.md`.

**It is a thin forwarder for the CLI.** `peers`, `status`, `live` / `wake-status`,
`messages`, `send`, `retire`, `repair-wake` shell straight into `bun cli.ts …` after `cd`ing
to the repo root (`run_bun`, `bin/codex-peer:170`). It exposes strictly *fewer* commands than
`cli.ts` — `inboxes`, `stranded-messages`, `gc-inboxes`, `orphaned-messages`,
`kill-broker`, and `suggest-name` have no wrapper equivalent and must be run as
`bun cli.ts …` from the repo. Mike's installed zsh aliases are listed in the usage block:
`peerwake`, `adspeer`, `ccrpeer`, `peerlist`, `peerstatus`, `peerrepair`, `peerretire`,
`peerdoc`.

**It manages the wake daemon.** `ensure_daemon` (`bin/codex-peer:253`) is called by every
launch path so the daemon comes back on its own after a reboot without anyone remembering
`peerwake`. It is idempotent and concurrency-safe: liveness is a pidfile plus `kill -0`, and
the start is guarded by an atomic `mkdir` lockdir with a re-check inside the lock, so
simultaneous launches produce exactly one daemon. `daemon-stop` / `daemon-status` inspect
the same pidfile. `run_daemon` refuses to start a second foreground daemon and installs
`EXIT` / `INT` / `TERM` traps that remove the pidfile.

The daemon log is size-rotated in-loop (`rotate_daemon_log_if_needed`,
`bin/codex-peer:299`): at 5 MiB (`CODEX_PEER_DAEMON_LOG_MAX_BYTES`) it shifts `.1`→`.2`…
keeping 3 rotations, then **copy-truncates** rather than renames. Copytruncate is required,
not stylistic — the backgrounded daemon holds the log fd open in append mode for its whole
life, so a rename would leave it writing into an unlinked inode. The tradeoff is honest in
the comment: a line or two written between the copy and the truncate is lost.

`install` symlinks the script to `~/.local/bin/codex-peer` and warns if that directory is not
on `PATH`. `doc` opens the bundled HTML explainer.

---

## 5. `package.json` and `.env.example`

`package.json` is 18 lines and deliberately minimal: `"private": true`, `"type": "module"`,
two scripts (`broker` → `bun broker.ts`, `test` → `bun test`), one runtime dependency
(`@modelcontextprotocol/sdk` ^1.27.1), two dev dependencies (`@types/bun`, `typescript`
^5.9.3). There is no `main` or `exports` field, no build step, no lint script, and no
typecheck script — `bunx tsc --noEmit` must be run by hand (it is clean at `63503f2`).

`.env.example` is 14 lines and documents 5 variables: `OPENAI_API_KEY`, `AGENT_PEERS_PORT`,
`AGENT_PEERS_DB`, `PEER_NAME`, `AGENT_PEERS_DISABLE_TAB_TITLE`. The code reads **29**
`AGENT_PEERS_*` / `CODEX_PEER_*` / `PEER_NAME` variables. Notably absent from both
`.env.example` and the README table: `AGENT_PEERS_ENABLED` (the master on/off switch —
documented only in README prose), `AGENT_PEERS_SPAWN_BROKER`, `AGENT_PEERS_EPHEMERAL`,
`AGENT_PEERS_STATE_DIR`, `AGENT_PEERS_HERMES_STATE_DIR`, `AGENT_PEERS_SECRET_PATH`,
`AGENT_PEERS_HEARTBEAT_MS`, `AGENT_PEERS_RUNTIME`, `AGENT_PEERS_HERMES_ROLE`.

One resolution rule is worth stating because getting it backwards would make the CLI report
clean while mail strands: the generic `AGENT_PEERS_STATE_DIR` takes precedence over the
runtime-specific variable, in the writers and in the CLI alike. Verified consistent across
`shared/codex-inbox.ts:99-102`, `hermes-server.ts:25-27`, `shared/hermes-claims.ts:30-31`,
`claude-server.ts:74`, and `cli.ts:585-587` (which carries the explanatory comment).

---

## 6. Test suite

**239 tests across 31 files, 1158 assertions, 0 failures — verified by running `bun test` at
`63503f2` (3.99s).** `bunx tsc --noEmit` is also clean. There are no `.skip`, `.only`, or
`.todo` markers anywhere in the suite.

```bash
bun test                       # full suite, ~4s
bun test tests/broker.test.ts  # single file
bunx tsc --noEmit              # typecheck (not wired to a script)
```

### By subsystem

**Broker core — HTTP, SQLite, migration, ownership (7 files, ~1560 lines).**
`broker.test.ts` (648) is the largest single file and proves every mutation is
session-token authenticated, tokens never leak through `listPeers`, leases deliver once
until expiry, and durable vs ephemeral peers have distinct GC, queue, and visibility
semantics. `migration.test.ts` proves pre-session-token DBs upgrade in place, that the
migration is idempotent, that it self-heals NULL tokens left by a crashed partial migration,
and that the `peer_type` CHECK expands for Hermes without data loss. `broker-ownership.test.ts`
is the one test with genuinely competing broker *processes*: it spawns two real brokers and
asserts a client-owner yields exit 0 while a launchd-owner evicts the incumbent.
`phase2-delivery-gc.test.ts` and `phase3-identity.test.ts` are milestone regression suites
covering stale-hide-but-not-delete, GC grace, retention pruning, typed ack outcomes,
`message_uid` minting/backfill, and — on the identity side — explicit `durable` opt-in,
peer_type-fenced reclaim, `prev_id` re-pointing, and single-winner Hermes name claims.
`heartbeat-eviction.test.ts` proves an evicted or token-rotated peer gets `known:false`
rather than a silently successful heartbeat. `broker-client.test.ts` round-trips
register→send→poll→ack against a live in-process broker and asserts every route rejects a
missing shared secret.

**Delivery and inbox (6 files, ~960 lines).** `delivery-state.test.ts` covers the piggyback
state machine — drawn-but-unreturned messages blocked from re-deal yet never confirmable,
concurrent calls confirming only their own draws, idempotent promote/rollback, and the
arrival-causality barrier that forbids confirming a message which did not exist when the
call was issued. Its header notes it exists because the 2026-08-10 second review found these
interleavings unreachable from the integration suite. `codex-inbox-store.test.ts` proves
dedupe, restart persistence, surgical `removeByIds`, that the bodyless metadata sidecar
contains neither bodies nor lease tokens, 0600/0700 enforcement with fail-closed on wide
perms, and that a failed persist keeps messages in memory. `e2e-live-delivery.test.ts` is the
integration proof against a real broker: sender identity survives the hop, idle-arrival
messages backfill through `check_messages`, and a peer that dies mid-lease and restarts under
the same name sees its backlog on the first poll. `piggyback.test.ts`, `recent-delivered.test.ts`,
and `wait-for-peer-messages.test.ts` cover inbox rendering, the TTL/capped ring buffer, and
the bounded-wait planner respectively.

**Wake — daemon, launcher, registry, claims, role (8 files, ~1240 lines).**
`wake-daemon.test.ts` proves the nudge fires only for loaded *idle* threads and is refused
for not-loaded, active, approval-wait, user-input-wait, and ambiguous-identity threads, with
signature dedupe and metadata left untouched on failure. `wake-daemon-backoff.test.ts` locks
the escalating retry schedule and the 3-start attempt cap; `wake-daemon-observe.test.ts`
covers `systemError` logging, backoff, recovery, and coalesced active-skips. Both inject a
fake clock, so neither is timing-flaky. `wake-registry.test.ts` and `wake-launch-claims.test.ts`
cover the durable pointer file (0600/0700, stale-pid and stale-socket filtering, token stored
only as a digest) and the launcher↔MCP-child handshake (cwd+tty matching, waiters, consumed
claims, multiple-live-candidate surfacing). `wake-launch-role.test.ts` proves exactly one
concurrent child wins root election, losers go inert, and dead-process locks are reclaimable.
`wakeable-launcher.test.ts` covers arg/env construction including the two-app-server
invariant and that broker secrets are never injected. `app-server-client.test.ts` covers the
WS client's timeouts, fast-fail connect, and materialize-without-a-turn.

**Readiness, ownership, protection, secrets (4 files, ~420 lines).**
`readiness-probe.test.ts` proves `/ready` fails closed on a wrong secret, wrong or missing
`db_id`, wrong protocol, malformed body, a pre-`/ready` broker, or no readable secret — even
when a squatter is answering `/health` — and that `owner=client` passes only in dev mode for
that literal value. `protection-check.test.ts` covers the reaper integration: the broker
vouches for itself despite PPID=1, unknown pids report *unprotected* rather than dead, a
mismatched `start_time` refuses to vouch (PID-reuse fence), and pid 1 is never expanded.
`shared-secret.test.ts` proves 0644, 0640, symlinks, missing files, and short files all fail
closed with `null`. `ensure-broker.test.ts` proves an alive broker returns without spawning,
a dead one is kickstarted and awaited, a no-op kickstart throws an error naming launchd and
the escape hatch, and — via the `tests/fixtures/echo-env-broker.ts` fixture — that the pinned
spawn env strips session variables while forwarding machine config.

**CLI and process lifecycle (3 files, 73 lines).** `cli-kill-broker.test.ts` spawns a real
broker plus a merely-connected client and proves `kill-broker` terminates only the pid from
`/health`, leaving the client alive — the regression test for the `lsof`-kills-everything
bug. `process-lifecycle.test.ts` (9 lines) asserts exactly three cases of
`parentProcessWasLost`: `(42, 1)` true, `(42, 99)` false, `(1, 1)` false. `codex-peer-script.test.ts`
(8 lines) reads `bin/codex-peer` as text and asserts it contains `CODEX_PEER_VERBOSE:-0` and
does *not* contain ungated `printf 'codex-peer: (starting|resuming|network peer name|started background)`
— i.e. launcher chatter stays verbose-gated.

**Shared utilities and regression suites.** `names.test.ts` covers generation, validation,
and suffix laddering (the base is trimmed, never the suffix). `bounded-log.test.ts` proves
rotation happens *before* the cap is exceeded and mode 0600 survives.
`review-fixes-20260810.test.ts` (138 lines) locks in the **2026-08-10 fresh-eyes review**
fixes specifically: the `CodexInboxStore` lazy-load guard (a forgotten `init()` makes the
first write merge rather than clobber disk) and `HermesNameClaims` dead-owner reclaim via
atomic rename (one winner per round, no unlink TOCTOU, PID-reuse fence).

### Execution characteristics worth knowing

Four files spawn real OS subprocesses: `broker-ownership.test.ts:16` (two brokers on port
7949), `cli-kill-broker.test.ts:21,35,42`, `ensure-broker.test.ts:82` (port 7947), and
`wake-launch-role.test.ts:62` (a `sleep 30` as a live-pid stand-in). Six more start a real
in-process HTTP broker on hardcoded ports: 7911, 7921, 7931, 7933, 7951, 7953.
`readiness-probe.test.ts` uses 7961. Every port is hardcoded except `cli-kill-broker.test.ts:19`,
which randomizes in 20000–40000. None collide with the production broker on 7900, but the
suite is **not safe to run concurrently with itself**. Six permission assertions are
POSIX-gated with `test.if` (`codex-inbox-store.test.ts:159,173`; `wake-registry.test.ts:106,120`)
and silently vanish on Windows. `readiness-probe.test.ts:55,64` mutates the global
`AGENT_PEERS_SPAWN_BROKER` env var, which is not parallel-safe. Real sleeps appear in
`broker.test.ts:178,186` (a 20ms margin to make `last_seen` advance — the tightest in the
suite), `cli-kill-broker.test.ts` (fully sleep-synchronized, no polling),
`wake-launch-claims.test.ts:46`, and `phase2-delivery-gc.test.ts:161`.

---

## 7. README accuracy (do not trust these sections)

Assessment only — the README was **not** edited. Line numbers are README line numbers.

| Line(s) | Problem |
|---|---|
| 237-250 | The entire **Shell CLI** section is badly incomplete: it lists 6 commands out of 14. Missing: `wake-status`/`live`, `retire`, `repair-wake`, `suggest-name`, `messages`, `inboxes`, `stranded-messages`, `gc-inboxes`. The stranded-mail recovery tooling — the most operationally important addition — is entirely undocumented. |
| 247 | `kill-broker` described as "Stop only the broker daemon (peers stay running)". Under `KeepAlive=true` launchd restarts it within `ThrottleInterval` (5s), so in production this is a *restart*, not a stop. |
| 256 | "Broker daemon … **Auto-launches on first session**" — directly contradicts the launchd ownership contract (`shared/ensure-broker.ts:6-16`) *and* the README's own line 189. Clients kickstart and wait; they do not spawn. |
| 406-407 | Troubleshooting "Broker port 7900 already in use → Kill any old broker: `bun cli.ts kill-broker`". Obsolete: a launchd-owner broker now evicts squatters itself (`broker.ts:1524-1532`), and `kill-broker` + `KeepAlive` is a restart. |
| 465 | "tests/ # **185 tests**" — actual count is **239**. |
| 442 | Architecture tree describes `cli.ts` as "(+ live / repair-wake / retire)" — omits `inboxes`, `stranded-messages`, `gc-inboxes`, `suggest-name`, `messages`. |
| 446-464 | `shared/` tree lists 18 of 24 files. Missing: `async-lock.ts`, `bounded-log.ts`, `delivery-state.ts`, `hermes-claims.ts`, `process-lifecycle.ts`, `recent-delivered.ts`. Several are load-bearing (delivery state machine, Hermes name election). |
| 466-474 | `docs/` tree omits `delivery-contract.md` and `plans/cross-machine-federation-tailscale.md`, both tracked at HEAD. |
| 55, 502 | "Unreachable recipient → orphan, visible via `cli.ts orphaned-messages`" — now only half the story. A *durable* recipient that never returns holds mail invisibly for 7 days and the strict orphan view misses it entirely; `stranded-messages` exists precisely for that case (`cli.ts:646-650`). |
| 337-352 | Environment table lists 12 of 29 variables. Missing at minimum: `AGENT_PEERS_ENABLED` (the master switch — only in prose), `AGENT_PEERS_SPAWN_BROKER`, `AGENT_PEERS_EPHEMERAL`, `AGENT_PEERS_STATE_DIR` (which *overrides* the per-runtime vars that are listed), `AGENT_PEERS_HERMES_STATE_DIR`, `AGENT_PEERS_SECRET_PATH`, `AGENT_PEERS_HEARTBEAT_MS`, `AGENT_PEERS_RUNTIME`, `AGENT_PEERS_HERMES_ROLE`. |
| whole file | **`/ready` is never mentioned.** The authenticated readiness handshake (`db_id`, `protocol: 1`, owner check) is how clients avoid trusting a squatter, and it has a dedicated test file. Not documented. |
| whole file | **Durable vs ephemeral peers are never explained.** This is the central identity change (explicit opt-in, 60s discovery cutoff, 7-day durable retention) and it changes what `list_peers` shows. Line 200 gestures at reclaim timing without naming the model. |
| whole file | **Hermes name election is never mentioned** (`shared/hermes-claims.ts`), though line 50 describes Hermes as first-class. |
| 49 vs 421 | Internally inconsistent Codex CLI versions: "v0.120, Apr 2026" at 49 and 215, "codex-cli 0.146.1" at 421. |
| 540-544, 592-596, 662-666, 696-698 | Install/update/uninstall prompts instruct the user to find broker PIDs with `lsof -t -i:7900` and `kill -TERM` them. Under launchd that kills a service which immediately restarts, and `lsof -t -i:7900` (without `-sTCP:LISTEN`) returns connected clients too — the exact bug `kill-broker` was fixed to avoid (`cli.ts:515-517`). These should be `launchctl bootout`. |
| 671, 714 | Uninstall deletes `~/.agent-peers-codex` but never `~/.agent-peers-hermes` or `~/.agent-peers-claude`, both of which exist and hold message bodies. Also never removes either LaunchAgent plist, so launchd keeps trying to run a deleted broker. |
| 62, 121-128 | The install/uninstall "ownership split" narrative predates launchd ownership. It frames the broker as Claude-owned shared state; it is now launchd-owned, and neither agent should be starting or killing it. |
| 268 | Links `docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md` as "the full technical spec". It is four months old and predates delivery state, wake, identity, ownership, and readiness work. |

Two things the README gets *right* and should be preserved: line 189 correctly states launchd
ownership and the `AGENT_PEERS_SPAWN_BROKER=1` dev escape hatch, and line 200 correctly
describes case-sensitive names, suffixing, and session-scoped rename for durable peers.

---

## 8. Known-issues status (`docs/known-issues-2026-08-08.md` at `63503f2`)

The document's own header — "Not yet fixed" — is now stale for issues 1 and 2.

**Issue 1 — unfiltered inbox delivery breaks targeted waits: PARTIALLY FIXED.**
A `from` sender filter now exists on `wait_for_peer_messages` for Codex and, by import,
Hermes — Marco's own runtime (`codex-server.ts:233-254` schema, `:291-306` predicate,
`:764-769` handler; `hermes-server.ts:40` imports `codex-server.ts`). The code comment names
this exact incident. Crucially the non-matching message is **not consumed**: it stays in the
durable queue and still surfaces in `[PEER INBOX]`, so the reported failure — a wait for
Kepler eating an unrelated Vector message and exiting — is gone. Documented at
`docs/delivery-contract.md:57-59`. Still open: neither upstream fix candidate was taken.
There is no broker-side filter (`poll-messages` still takes only `{id, session_token}` —
`shared/types.ts:96`, `broker.ts:698,1439`) and no `in_reply_to` lineage anywhere in the
schema (`broker.ts:135-150`), so waiting on a *conversation* remains impossible. Claude peers
get nothing at all — `claude-server.ts` has no `wait_for_peer_messages` tool
(`:131,144,157,166,172`). And the sender-matching predicate itself is untested: it lives
inline at `codex-server.ts:302-304` and `tests/wait-for-peer-messages.test.ts` exercises only
the generic `isFresh` callback.

**Issue 2 — duplicate/stale registrations pollute the peer list: FIXED**, via the inverse of
the suggested design. There is no `ephemeral: true` opt-out; instead **ephemeral is the
default and durability is an explicit opt-in** (`broker.ts:128` column, `:339-348` migration,
`:406-410` register — whose comment retires the old "asked for a name, therefore durable"
rule that let every `hermes mcp test` spawn reserve a name for 7 days). Suffix-ladder
fallback names stay ephemeral (`broker.ts:456-462`). `listPeers` applies an unconditional
60s `last_seen` cutoff that durable rows do **not** escape (`broker.ts:566-573`), so a
durable-but-idle peer is addressable yet invisible in the roster; GC removes ephemeral rows
at 60s and durable at 7 days (`broker.ts:848-859`). The `cli-operator-<pid>` peer named in
the report registers with no `durable` field and unregisters in a `finally` (`cli.ts:132-167`),
so worst case (SIGKILL) it ages out in 60s. Covered by `tests/broker.test.ts:389,401,412,443`
and `tests/phase3-identity.test.ts:49-60` — the latter's `test-squatter` case is literally
the reported bug. Residual: a live short-lived spawn is still visible for the seconds it
exists; there is no "skip the public list" flag. The reported failure mode (a
`cwd=/private/tmp` hermes peer mistaken for the live Ezra gateway) is closed.

**Issue 3 — raw-HTTP client traps: STILL OPEN.** No `client.md` exists, tracked or untracked.
`shared/broker-client.ts` is still not importable — `package.json` is `"private": true` with
no `main` or `exports` — and the only README reference is a one-line file-tree comment
(`README.md:448`). The suggested "export the cli.ts client" was not done. Trap by trap
against tracked docs: the `to_id_or_name`/`text` request naming and the `text`/`sent_at`/`lease_token`
row fields appear only in the complaint itself and in the stale April plan doc
(`docs/superpowers/plans/2026-04-13-agent-peers-mcp-implementation.md:180,216,234`). Mandatory
acking is covered *conceptually* by `docs/delivery-contract.md:14-24` — including the sharp
"a client must never treat `{ok: true, acked: 0}` as success" — but that document never names
the `/ack-messages` endpoint or the `lease_tokens` field, so a scripter cannot act on it. The
"senders must be live and heartbeat before every send" rule is enforced
(`broker.ts:630-644`, with distinguishable `unauthorized sender` vs `sender stale: <name>`
errors) but documented nowhere. The mandatory `x-agent-peers-secret` header
(`broker.ts:52`) is likewise undocumented — the README mentions the secret *file* at line 256
but never the header contract.

---

## Red Flags

Ordered roughly by operational severity. All line references are at `63503f2`.

### Correctness and safety

1. **`gc-inboxes` accepts a negative `--min-age-days`, defeating its own recency gate.**
   `cli.ts:784-785` validates only `Number.isFinite`, so `--min-age-days -1` passes. The
   cutoff at `cli.ts:683` becomes `Date.now() + 86_400_000` — a *future* timestamp — so
   `box.mtimeMs > cutoff` is false for every file and the "too recent, may be mid-write"
   guard is silently inverted: every dead inbox is archived, including one written a second
   ago. Mitigated by archive-never-delete, but this is the one destructive command in the
   tool and its primary rail can be turned off by a typo (`-1` where `1` was meant). Should
   clamp to `>= 0`.

2. **The `needs repair` detector cannot see the names this same file generates.**
   `cli.ts:325` classifies a peer as a broken wakeable launch with
   `/(?:^|-)codex(?:-\d+)?$/`. But `cmdSuggestName` (`cli.ts:533-548`, via
   `pickAvailablePeerName`) is designed to hand a second concurrent peer a *memorable* suffix
   — `ccr-website-codex-otter` — explicitly instead of a positional `-2`, and
   `bin/codex-peer:186` uses it on every launch. `ccr-website-codex-otter` does not match the
   regex, so exactly the peers most likely to need `repair-wake` never appear in the "needs
   repair" bucket and never trigger the tip at `cli.ts:374-378`. The two features were
   shipped against each other.

3. **`bin/codex-peer daemon-stop` no longer stops the wake daemon.**
   `com.mike.agent-peers-wake.plist` runs `bin/codex-peer daemon 5` with `KeepAlive=true` and
   `ThrottleInterval=5`. `daemon_stop` (`bin/codex-peer:273`) kills the pid and removes the
   pidfile, then launchd restarts it 5s later — with `daemon_status` reporting "not running"
   in the gap. The script has no awareness of the LaunchAgent, and nothing in the repo
   references it (the plist is machine state, not tracked). The two daemon-management
   mechanisms converge only because `run_daemon` overwrites the pidfile with its own `$$`,
   which makes `ensure_daemon` no-op. An operator following the documented
   `daemon-stop` path will conclude the daemon is unkillable.

4. **`cli.ts:43-45`'s trust-boundary comment is factually wrong about `rename`.**
   It claims "Direct-SQLite commands (rename, messages, orphaned-messages) and `kill-broker`
   don't [require the secret]". `cmdRename` reads SQLite only for the session token and then
   calls `client.renamePeer` → `POST /rename-peer` (`shared/broker-client.ts:132`), which
   sends the shared-secret header and is gated like every non-`/health` route. `rename` fails
   without a readable secret. This is the kind of comment an operator reads while debugging a
   permissions problem.

5. **No top-level error handling anywhere in `cli.ts`.** `cli.ts:718-805` is a bare `switch`
   with top-level `await` and no `try`/`catch`. Only `status` checks broker liveness
   (`cli.ts:105-109`). Every other broker-touching command — `peers`, `send`, `rename`,
   `retire`, `repair-wake` — surfaces a raw `fetch` rejection and a stack trace when the
   broker is down, from a tool whose entire purpose is diagnosing a broken network. A dead
   broker is the single most likely reason someone runs this CLI.

6. **The metadata-rename `catch` in `gc-inboxes` swallows real failures.**
   `cli.ts:702` wraps the sidecar rename in `try { … } catch { /* no metadata file */ }`.
   The comment names one benign cause, but the bare catch also silently absorbs `EACCES`,
   `EXDEV`, and a partially-completed rename — leaving an orphaned `.metadata.json` next to
   an archived `.json` with no indication anything went wrong. The main file's rename at
   `cli.ts:701` is unguarded, so a mid-loop failure there aborts the command with the running
   `archived N` footer never printed.

7. **`cmdSend` misrepresents the operator as a Claude session.** `cli.ts:138` registers the
   throwaway peer with `peer_type: "claude"`. It is a shell operator, not a Claude session.
   Recipients see a `claude` peer, and `peer_type` is now load-bearing — phase-3 made reclaim
   peer_type-fenced (`tests/phase3-identity.test.ts`). Low blast radius given the
   `cli-operator-<pid>` name and immediate unregister, but it is a lie in a field that
   acquired meaning after the code was written.

### Robustness and hygiene

8. **Flag parsing is `includes`/`indexOf` with no validation** (`cli.ts:777,783-785`).
   Unrecognized flags are silently ignored — `inboxes --strandedd` quietly prints no bodies,
   and `gc-inboxes --min-age-days=0` (equals form, unsupported) silently uses 7. There is no
   "unknown flag" error anywhere in the CLI.

9. **`BROKER_PORT` has no NaN guard.** `cli.ts:39` — `parseInt(process.env.AGENT_PEERS_PORT ?? "7900", 10)`
   with no validation. A malformed `AGENT_PEERS_PORT` produces `http://127.0.0.1:NaN` and a
   confusing fetch failure rather than a clear config error.

10. **SQL built by template interpolation** at `cli.ts:439` (`LIMIT ${LIMIT}`). `LIMIT` is a
    local `const 500`, so this is not injectable today — but it is the one place in the file
    that builds SQL by concatenation, in a file where every other value is a bound parameter.

11. **The DB path is re-derived in four places instead of once.**
    `cli.ts:64`, `:408`, `:473`, `:616` each independently compute
    `process.env.AGENT_PEERS_DB || resolve(homedir(), ".agent-peers.db")`.
    `openDbReadonly()` (`cli.ts:612`) exists and does exactly this; `readPeerAuth`,
    `cmdMessages`, and `cmdOrphans` predate it and were never migrated. Four copies of a path
    rule is four places for them to drift.

12. **`node:` imports are dynamically imported inside functions throughout** (`cli.ts:61-63,
    78-80, 405-407, 470-472, 613-615, 680`) rather than imported once at the top. There is no
    apparent reason — these are not optional dependencies and this is not a conditional code
    path. It is repeated per call and obscures the file's real dependencies.

13. **`cli.ts:688` drops the type parameters** used everywhere else:
    `db.query("SELECT id FROM peers WHERE id = ?").get(box.peerId)` returns `unknown` in a
    file that otherwise consistently types its rows.

14. **`readAllInboxFiles` has no size limit and reads every file fully into memory**
    (`cli.ts:574-610`). `inboxes` on a machine with many large inboxes reads and JSON-parses
    all of them; the largest inbox observed here is 19KB, so this is theoretical today.

15. **Hardcoded personal paths in a script published to GitHub.**
    `bin/codex-peer:5-6` defaults `GOOGLE_ADS_EXPERT_REPO=/Users/mike/www/ai/google-ads-expert`
    and `CCR_WEBSITE_REPO=/Users/mike/www/ai/ccr-website`, with `google-ads`/`ccr`
    subcommands and `adspeer`/`ccrpeer` aliases documented in `usage()` alongside the phrase
    "installed on Mike's machine" (`bin/codex-peer:26`). Both are env-overridable, so this is
    cosmetic, but the repo's README markets it as a general-purpose tool.

16. **The wake-daemon log is world-readable while everything else is 0600.**
    Observed: `~/.agent-peers-codex/wake-daemon.log` is `-rw-r--r--`, inside a 0700 directory
    whose every other file is 0600. Both the launchd plist and `ensure_daemon`'s
    `nohup … >>"$DAEMON_LOGFILE"` create it with the default umask; nothing chmods it. The
    directory mode contains the exposure, so this is defense-in-depth drift rather than a
    live leak — but `shared/bounded-log.ts` has a test asserting 0600 for the *other* logs,
    so the inconsistency is unintentional.

17. **A stray `.DS_Store` is tracked in state directories** (`~/.agent-peers-codex/.DS_Store`,
    and one in the repo root). `readAllInboxFiles` correctly skips it (non-`.json`), so this
    is cosmetic.

### Dead code and staleness

18. **`docs/known-issues-2026-08-08.md:3-5` still says "Not yet fixed"** for all three issues,
    two of which are now fixed or substantially fixed (§8). The file has no status column and
    no last-reviewed date, so it reads as current.

19. **No typecheck or lint script in `package.json`.** `bunx tsc --noEmit` is clean but must
    be remembered; nothing in CI or the update prompts runs it. The README's update prompts
    (`README.md:559-561, 610`) run `bun test` only.

20. **The suite is not safe to run concurrently with itself** — ten test files bind hardcoded
    ports (7911, 7921, 7931, 7933, 7947, 7949, 7951, 7953, 7961), and
    `readiness-probe.test.ts:55,64` mutates process-global env. Only
    `cli-kill-broker.test.ts:19` randomizes its port. Not a problem for `bun test` today
    (single process, sequential files), but it silently forecloses parallelization.

21. **`tests/broker.test.ts:178,186` depend on a 20ms real sleep** to make `last_seen`
    strictly advance — the tightest timing margin in the suite and the most likely source of a
    future flake under load or a coarse clock. `cli-kill-broker.test.ts` is fully
    sleep-synchronized (`Bun.sleep(50)`, `(100)`) rather than polling, and holds a socket open
    for 30s.
