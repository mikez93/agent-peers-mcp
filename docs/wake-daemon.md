# Wake daemon — operations & logging

The wake daemon is the background loop that lets idle, app-server-backed Codex
peers be *woken* when another peer sends them a message. Each launch
(`codexpeer`, `adspeer`, `ccrpeer`, `codex-peer start …`) auto-starts it; you can
also run it in the foreground with `peerwake` (`codex-peer daemon`).

- **Engine:** `shared/wake-daemon.ts` (`runWakePass`) — one bodyless pass.
- **Entry:** `wake-daemon.ts` — prints one line per noteworthy result. Flags:
  `--json` prints one JSON object per result, and `--quiet-noop` (what the loop
  uses) prints only results flagged for logging. Without `--quiet-noop` every
  result prints, which is what `codex-peer wake` does for on-demand debugging.
- **Loop:** `bin/codex-peer` `run_daemon` runs the entry every
  `CODEX_PEER_DAEMON_INTERVAL` seconds (default 5). On macOS a LaunchAgent
  (`com.mike.agent-peers-wake`) and on Linux the systemd user unit
  `agent-peers-wake.service` both run `bin/codex-peer daemon 5` and restart it on
  failure. Because the entry is re-run every pass, new code is picked up without a
  restart.
- **Log:** `~/.agent-peers-codex/wake-daemon.log`.
- **State:** `~/.agent-peers-codex/wake-ledger/` (wake backoff per unread set),
  `~/.agent-peers-codex/wake-observe/` (per-peer skip-state, for log coalescing),
  `~/.agent-peers-codex/wake-registry.json` (who is wakeable and where).

Peers get into the registry two ways: a managed `codex-peer` launch, or a Codex
desktop chat that registers itself against the app-server socket its parent owns
(`ws+unix://`). The daemon treats both the same. Details:
[wakeable-codex.md](wakeable-codex.md).

## How a pass decides

For each registered peer with unread messages, a pass reads the peer's live
thread status from its app-server and acts on it:

| Thread state | What the daemon does |
|---|---|
| `idle` | Eligible to wake. The **wake ledger** fires one nudge, then backs off re-waking the *same* unread set on a `5m → 30m → 2h` schedule and abandons after the cap (the message still surfaces on the peer's next turn). |
| `active` (working) | **Steered.** The wake is appended to the running turn with `turn/steer` (`expectedTurnId` = the in-progress turn from `thread/turns/list`), the same as typing into a busy Codex chat, and logged as `steered`. If that turn ended first, an idle thread gets a normal wake turn; otherwise the claim is released (the skip reason is `steer_raced`, or the thread's new state) and the next pass retries. The same ledger backoff applies to re-steering an unchanged unread set. |
| `waitingOnApproval` / `waitingOnUserInput` | Turn is parked on a prompt for the person — **not** woken. Polled every pass so delivery happens the instant it resumes; the repeated log lines are coalesced. |
| `systemError` | Thread is **wedged** (a failed/crashed turn). It can't be woken until bounced. Re-checked on an escalating `5m → 30m → 2h` backoff instead of every pass, and logged once with a bounce hint. |

## What else the same run does

After the Codex pass, `wake-daemon.ts` runs two more passes, each isolated so a
failure in one cannot affect the others. Both do nothing until opted in:

- **Hermes chats** run only for profiles listed in
  `~/.agent-peers-hermes/chat-wake/enabled`. The driver that wakes closed Hermes
  chats is built and available per profile, and is currently switched off: the file
  does not exist on the Studio. The Hermes Desktop plugin is a separate opt-in. See
  [components/hermes-desktop-wake.md](components/hermes-desktop-wake.md).
- **OpenClaw main sessions** run only for agent ids listed in
  `~/.agent-peers-openclaw/wake/enabled`. See
  [components/openclaw-peer.md](components/openclaw-peer.md).

Their log lines are prefixed `hermes:` and `openclaw:` and are printed on state
changes only.

## Reading the log

Lines are timestamped (UTC ISO-8601):

```
2026-06-22T21:15:03.124Z wake: nudged google-ads-codex (79eea704…) thread=019ee815…
2026-06-22T21:20:40.880Z wake: skipped Brixton (4a12af35…) thread=019ee81d… (thread_system_error) — peer thread hit a system error (likely a failed/crashed turn) and can't be woken until bounced — close the TUI and relaunch `codexpeer` in /Users/mike/www/trophy-shopify-theme
```

The daemon **coalesces** repeated skips: a state is logged once when it starts
(a transition) and then at most once per heartbeat window (escalating for a
wedged peer) until it changes — so a stuck or busy peer costs a handful of lines
a day, not thousands. A `wake: nudged` line always prints.

### "peer thread hit a system error … bounce it"

This peer's Codex thread is in `systemError`. The daemon will keep it on a slow
re-check (so it auto-recovers if the thread heals) but cannot wake it. To clear
it: close that peer's TUI and relaunch it (`codexpeer` in the printed `cwd`).
`codexpeer live` shows current peer state.

## Tuning (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_PEER_DAEMON_INTERVAL` | `5` | Seconds between passes. |
| `CODEX_PEER_DAEMON_LOG_MAX_BYTES` | `5242880` (5 MiB) | Live log is copy-truncated to `wake-daemon.log.1`, `.2`, … once it reaches this size. |
| `CODEX_PEER_DAEMON_LOG_KEEP` | `3` | Number of rotated log files to keep. |
| `AGENT_PEERS_CODEX_STATE_DIR` | `~/.agent-peers-codex` | Coordination root: the log, registry, ledgers and daemon state. Inbox files follow `AGENT_PEERS_STATE_DIR` when it is set; the daemon reads both roots. |

Rotation is copy-truncate (not rename) because the backgrounded daemon holds the
log file descriptor open in append mode for its whole life; truncating in place
lets it keep writing without a restart. Picking up a **changed rotation cap or
interval** does require restarting the daemon (`codex-peer daemon-stop`, then any
launch re-starts it); the wake *logic* is reloaded every pass automatically.
