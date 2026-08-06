# Wakeable Codex peers (idle wake, no fork)

This document describes how `agent-peers-mcp` makes an **idle** Codex CLI session
respond to peer messages **without forking the Codex binary**, the security model
that keeps it safe, and its failure modes.

## The problem

Stock Codex CLI only surfaces peer messages **on the response of an agent-peers
tool call**. An idle Codex — parked at its prompt, calling no tools — never sees
queued messages until it does something on its own (your next user turn, or any
agent-peers tool call). Unlike Claude Code, Codex exposes no MCP push channel an
external process can use to trigger a turn ([OpenAI Codex docs list `tools` as the
only supported MCP feature](https://github.com/openai/codex/blob/main/docs/config.md)).

The previously proposed fix was to **fork the Codex binary** and patch it to
surface `notifications/message` as developer instructions — which means tracking a
moving Rust codebase and rebuilding on every Codex release. Wakeable mode avoids
that entirely.

## Design: app-server-backed wake, no fork

Codex ships an **app-server** mode (`codex app-server --listen ws://…`) that hosts
a thread over local WebSocket JSON-RPC and lets a client start turns on it, while a
visible `codex resume --remote <url> <thread>` TUI stays attached to the *same*
thread. Wakeable mode uses that to make wakeability a **launch-time property**:

1. Start Codex under a managed app-server bound to one thread.
2. Register `peer_id -> { app_server_url, thread_id, … }` in a durable wake registry.
3. A small daemon watches for unread mail and, when the target thread is **loaded
   and idle**, sends a **bodyless** wake prompt into that same thread — which makes
   Codex call `check_messages` and surface the real content through the normal
   tool-response path.

The woken session is the **same live instance**: same thread, same rollout file,
same visible TUI. It is never killed or restarted with fresh context.

## Components

| File | Role |
|---|---|
| `bin/codex-peer` | Operator CLI: launch wakeable peers, manage the background daemon, inspect/repair/retire |
| `wakeable-codex.ts` → `shared/wakeable-launcher.ts` | Start the app-server, start/resume the thread, launch the visible TUI, write a launch claim |
| `shared/app-server-client.ts` | Minimal Codex app-server JSON-RPC client (`thread/loaded/list`, `thread/read`, `thread/name/set`, `turn/start`) with bounded connect/request timeouts |
| `shared/wake-registry.ts` | Durable `peer_id -> app-server/thread` registry (0o600), liveness checks, GC of dead rows |
| `shared/wake-launch-claims.ts` | Launcher ↔ MCP-child handshake so the visible session's `peer_id` is bound to the right app-server/thread; also arbitrates the single-identity election via atomic `tryAcquireRoot()` |
| `shared/wake-launch-role.ts` | Decides whether an MCP child registers a peer identity (`standalone` / `root` / `secondary`) — the duplicate-identity gate |
| `shared/codex-inbox.ts` | Durable on-disk inbox **plus bodyless metadata** the daemon reads |
| `shared/wake-daemon.ts` → `wake-daemon.ts` | The wake engine: one pass over the registry + metadata, with backoff/cap + GC |
| `codex-server.ts` | Registers the wakeable session and writes bodyless metadata when mail arrives |

## The wake turn

The wake prompt is deliberately **bodyless**:

```
[agent-peers wake]
You have pending agent-peers messages in your local MCP inbox. Immediately call
the agent-peers check_messages tool once. Treat that tool response as the only
authoritative message content. Do not infer message content from this wake
signal. After handling the inbox normally, return to waiting. Wake id: <uuid>
```

The daemon never carries the message body. `check_messages` (and its `[PEER INBOX]`
block) remains the single authoritative delivery path, exactly as for non-wakeable
Codex. The wake only causes a turn; it never *is* the message.

## Security model

- **Bodyless wake.** The daemon reads only envelope metadata (sender id/name/type,
  recipient id, timestamp, summary) — never the message body and never a lease
  token. The body lives only in the broker DB and is delivered only through
  `check_messages`.
- **Fail-closed file perms.** Inbox, metadata, registry, claim, and ledger files
  are written 0o600 in a 0o700 dir, with the mode re-applied defensively. On read,
  files that are not a regular file, owned by another uid, or wider than 0o600 are
  refused (empty state returned) so a local attacker can't spoof peer identities or
  read bodies through these files.
- **Local-only.** The app-server listens on `127.0.0.1`; the broker is local with a
  per-user 0o600 shared secret. No network surface is added.
- **Same-thread targeting is validated before every wake.** The daemon re-reads the
  thread and refuses to nudge unless `thread_id`, `cwd`, and (when known) the
  rollout path all match the registry, and the thread status is `idle`. Mismatches,
  `active`, `waitingOnApproval`, `waitingOnUserInput`, and error states are skipped
  — so a wake can never land on the wrong session or interrupt active/approval work.

## Token-cost characteristics

- **Launching a peer costs zero model tokens.** The rollout is materialized with
  `thread/name/set`, which persists the session metadata record without running a
  turn. Before 2026-08-06 every launch ran (and then deleted) a real model turn just
  to force the rollout file into existence — measured at 5.3s–29.4s of latency plus
  its tokens, on every single launch.
- **Idle with no mail = zero model tokens.** The idle TUI runs no inference. The
  wake daemon's poll is local-only (read metadata files + local WebSocket JSON-RPC
  to the app-server) and never calls the model. A model turn (`turn/start`) fires
  **only** when there is real unread mail for an idle thread.
- **Each wake re-bills the whole accumulated thread** as input tokens, because LLM
  turns are stateless and resend the full context; the prompt cache is cold after
  minutes. So per-wake cost grows with session age. This is inherent to the
  "same live instance" guarantee.
- **Re-waking the same unread set is throttled.** See backoff/cap below. A brand-new
  message is a different signature and always wakes immediately.

## Reliability & failure modes

- **Escalating backoff + attempt cap.** Re-waking the *same* unread set (e.g. the
  model checked then went idle, or ignored the nudge) backs off `5m → 30m → 2h` and
  is then **abandoned** — no more proactive nudges. The message is never lost; it
  still surfaces on the session's next tool call / user turn. This bounds the
  worst-case token cost of a stuck inbox to a handful of turns spread over hours,
  and removes the routine "one redundant wake" on the happy path. A new message
  (different signature) bypasses the backoff and wakes immediately. An **active**
  (deeply-thinking) thread is skipped before the ledger is touched, so long turns
  never burn attempts and are never abandoned mid-thought.
- **Bounded app-server I/O.** Connect and every JSON-RPC request are timeout-bounded
  (5s default). A wedged or half-dead app-server fails fast (`app_server_unreachable`)
  so it can't stall the rest of the (sequential) wake pass.
- **Stale-state GC.** Each pass prunes dead wake-registry rows (past a grace window),
  dead/old launch-claim files, and old ledger files, so `~/.agent-peers-codex/`
  doesn't grow without bound. Live sessions are never pruned; inbox **message** files
  are never touched.
- **Ambiguity-safe repair.** Normal launches bind the visible session to its exact
  app-server/thread via env, so they are unambiguous. The `repair-wake` fallback,
  which matches by cwd/tty, **refuses** when two or more live distinct-thread
  sessions share a cwd/tty (e.g. two Codex in the same repo with no distinct TTY)
  rather than guessing and attaching to the wrong thread.
- **Confirm-on-next-call delivery.** Messages stay in the durable inbox until the
  *next* tool call proves the prior response reached the model, so a dropped wake
  response re-delivers instead of silently losing mail.
- **One agent-peers identity per launch (claim election).** In `--remote` mode the
  visible `codex resume --remote` TUI is a thin client — it spawns **no** MCP
  itself. The **app-server** spawns the agent-peers MCP, and it spawns **one per
  Codex thread**, using the **app-server process's** `-c` config. `thread/start`, a
  cold `thread/resume`, `thread/fork`, a spawned subagent and a detached review each
  create a Session, and each Session launches its own stdio MCP child; the
  app-server also keeps unsubscribed threads loaded for **30 minutes**, so children
  accumulate. Ordinary turns and compaction reuse the existing child.

  The earlier two-app-server split (2026-06-25) fixed only the *materialize vs
  resume* case. It was written believing the phase-2 app-server hosts exactly one
  conversation and therefore registers exactly one identity. **That was wrong**, and
  it stayed wrong until measured: two live app-servers were each running **four**
  agent-peers MCPs, 15 MCP processes across 9 app-servers, and one terminal
  (`ttys023`) held `ccr-codex-2`, `ccr-codex-3-2-2-2`, `ccr-codex-4-2-2` and
  `ccr-codex-5-2-2`. Every child called broker `register()` unconditionally. The
  damage is worse than cosmetic naming: mail addressed to the peer's **name** can
  land in a twin the wake daemon is not watching, so it is neither delivered nor
  reported undelivered — and each child also runs a 1s `/dev/tty` tab-title
  keepalive, so an idle terminal had four processes writing escape sequences into it
  every second.

  **There is no spawn-time signal identifying the owning thread.** The stdio child
  gets a cleared environment, so `AGENT_PEERS_WAKE_THREAD_ID` — app-server *process*
  config — is copied identically into every child; `cwd`, `ppid` and tty do not
  disambiguate. Codex stamps an authoritative `_meta.threadId` on `tools/call`, but
  **not** on the startup `tools/list`, so it cannot gate registration without
  leaving a peer undiscoverable until it happens to call a tool — which defeats the
  entire point of a network that wakes idle peers.

  **So the launcher elects a root instead:**
  1. The resume app-server sets `AGENT_PEERS_WAKE_LAUNCH=1`, inherited by every MCP
     child it spawns. This is the discriminator that lets a losing child tell *"I am
     a secondary thread — go inert"* from *"I am an ordinary `codex` session with no
     claim — register normally"*. Without it the two are indistinguishable and
     gating would silently remove every plain Codex session from the network.
  2. Children race `WakeLaunchClaimStore.tryAcquireRoot()`, which arbitrates by
     exclusive create (`wx`, atomic on POSIX). `consume()` cannot arbitrate — it is a
     read-modify-write, and two children can both observe the claim as unconsumed. A
     lock whose owner process is dead is reclaimable, so a crashed root cannot
     strand the launch.
  3. The winner registers as today. Losers serve an **empty** MCP so their thread can
     still start, and take no identity: no broker connection, no inbox, no polling,
     no tab-title write. The election runs *before* `setTabTitle`/`ensureBroker`
     precisely so a secondary never touches the shared terminal.
  4. The app-server also sets `mcp_servers.agent-peers.required=true`, which makes
     Codex await agent-peers initialization before `Session::spawn`/`resume`
     completes. The root thread is constructed first and no descendant runtime is
     auto-opened during resume, so the root deterministically claims before any
     secondary can exist. **Scoped to this app-server only** — plain `codex` sessions
     keep agent-peers optional and still degrade gracefully when the broker is down.

  Phase 1 (materialize) remains a separate throwaway app-server with agent-peers
  fully **disabled**, so it never joins the election and cannot steal the claim.
  Verify with `codexpeer live`: a healthy launch shows exactly **one** wakeable
  identity per repo (no `-2`). See
  `.specs/2026-06-25-wakeable-codex-peer-delivery-fix-spec.md` for the original
  two-app-server work and `bd-di5` for the election.
- **Launcher plumbing stays out of the session window.** Both app-servers send
  stdout/stderr to a private, per-peer bounded log under
  `~/.agent-peers-codex/logs/`, and the launcher uses the normal alternate screen.
  Materialization itself is now invisible by construction rather than by cleanup:
  `thread/name/set` persists the rollout without running a turn, so there is no
  bootstrap turn to hide and the session opens at a clean prompt. Set
  `CODEX_PEER_VERBOSE=1` to restore the normally-hidden launcher status lines while
  debugging.
- **An MCP exits when its owning app-server dies.** The Codex MCP watches its
  original direct parent and exits if it is reparented to launchd. This closes
  the Bun stdio edge case that left dead sessions heartbeating as live peers.
- **The TUI "working" spinner can lie — trust `thread_status=` in `codexpeer live`.**
  Every daemon wake is injected into the thread by an *external* client (the wake
  daemon), not the TUI. (Materialization no longer contributes: it runs no turn at
  all now — see the launcher-plumbing note above.) The `--remote` TUI
  renders a "working" animation for turns it didn't initiate and **does not clear it**
  when such a turn finishes — so an idle, ready-to-wake session can *look* hung
  ("working" forever; Esc does nothing). It isn't hung: the thread is `idle`.
  `codexpeer live` now prints the **true** app-server thread status as a
  distinctly-named field (`thread_status=idle` / `thread_status=active` /
  `thread_status=active:waitingOnApproval` / `thread_status=notLoaded` /
  `thread_status=systemError`); trust that over the spinner. It is named separately
  from the detail line's `thread=<thread_id>` so the two never collide. A wedged or
  half-dead app-server makes the probe fail fast and the field is simply omitted.
  (The spinner itself is an upstream Codex `--remote` rendering behavior.)
- **`wait_for_peer_messages` is a no-op in a wakeable session — so a woken peer
  can't freeze itself waiting for a reply.** The blocking long-poll
  `wait_for_peer_messages` (up to 5 min) made sense for a non-wakeable session
  that wants to hold its turn open; in a *wakeable* session it is redundant and
  actively harmful — the daemon already starts a fresh turn on mail arrival, so
  blocking only pins the `--remote` TUI "working" for minutes and queues the
  operator's typed input behind the call (looks hung between peer pings). The
  server now detects wake-target sessions (a module flag set when the wake
  registry upsert succeeds) and **short-circuits `wait_for_peer_messages` to
  return immediately** for them (`planWaitForPeerMessages()` →
  `kind: "skip-wakeable"`). Any already-pending mail still surfaces, because the
  broker poll runs *before* the wait hook; future arrivals are covered by the
  daemon. The tool description and the system preamble also tell wakeable
  sessions to simply end the turn and go idle rather than long-poll. (The
  short-circuit is a launch-time property of the running MCP — a peer started
  before this change keeps blocking until relaunched.)

## Operating it

```bash
# install the helper onto PATH (one-time)
bun bin/codex-peer install

# launch a wakeable peer in the current repo (auto-name <repo>-codex)
codex-peer

# launch any repo with a stable name
codex-peer start my-service ~/code/my-service

# resume an existing session as a wakeable peer (saved cwd is automatic)
codex-peer resume <session-id>

# inspect / manage
codex-peer live              # wakeable sessions + unread counts
codex-peer daemon-status     # is the background daemon running?
codex-peer daemon-stop       # stop it
codex-peer repair-wake NAME  # re-attach a live peer whose wake pointer was lost
codex-peer retire NAME       # remove a stale/confusing peer from discovery
```

### Peer naming (multiple instances per repo)

A bare `codex-peer` auto-names the peer `<repo>-codex` (e.g. `ccr-website-codex`).
The name is intentionally deterministic so the primary instance is predictable
to address and so a relaunch **reclaims the same name** (the broker reclaims a
stale same-named row in place).

If you start a **second concurrent** peer in the same repo while the first is
still live, the launcher gives it a **memorable funny suffix** instead of a
positional `-2` — e.g. `ccr-website-codex-otter`. The launcher resolves this by
asking the broker (read-only, `cli.ts suggest-name <base>`) for the set of
**live** peer names: if `<base>` is free it is used unchanged (preserving the
canonical name + reclaim); if it is held by a live peer, a single animal word is
appended, trimmed if needed to stay within the 32-char name limit. Each instance
therefore gets a unique, individually-addressable name with no typing, so you can
tell any specific one to collaborate over the network. (The broker's own
register-time suffix ladder remains the final uniqueness backstop for the rare
check-vs-register race.) For a *chosen* stable name, use
`codex-peer start <name> <repo-path>`; a running peer can also rename itself via
the `rename_peer` tool.

**The background wake daemon auto-starts on every launch** — idempotent,
single-instance (pidfile + atomic lock), detached via `nohup`/`disown` so it
survives the terminal closing and is brought back by the first launch after a
reboot. You can still run `codex-peer daemon` in the foreground if you prefer to
watch it; it refuses to double-start.

Relevant environment variables:

| Var | Default | Purpose |
|---|---|---|
| `AGENT_PEERS_CODEX_STATE_DIR` | `~/.agent-peers-codex` | Inbox + wake registry/daemon state dir |
| `CODEX_PEER_DAEMON_INTERVAL` | `5` | Background daemon poll interval (seconds) |
| `CODEX_PEER_DAEMON_LOG_MAX_BYTES` | `5242880` | Size at which `wake-daemon.log` is rotated (copy-truncate) |
| `CODEX_PEER_DAEMON_LOG_KEEP` | `3` | Number of rotated wake-daemon logs to keep |
| `CODEX_PEER_APP_SERVER_LOG_MAX_BYTES` | `5242880` | Per-peer app-server log rotation size |
| `CODEX_PEER_APP_SERVER_LOG_KEEP` | `3` | Number of rotated per-peer app-server logs to keep |
| `CODEX_PEER_VERBOSE` | `0` | Set to `1` to show launcher status lines before the TUI |

Day-to-day wake-daemon operations — log format, how repeated skips are coalesced,
the wedged-peer (`systemError`) backoff + bounce signal, and rotation — are
documented in [wake-daemon.md](wake-daemon.md).

The launcher also injects internal `AGENT_PEERS_WAKE_*` config into the app-server's
MCP child (app-server URL/pid, thread id, rollout path) so the visible session
registers itself against the exact thread it is attached to.

## Testing

The wake path is covered by focused tests:

- `tests/wake-daemon.test.ts` — idle nudge, identity/cwd/active guards, dup suppression, failed-wake leaves metadata intact
- `tests/wake-daemon-backoff.test.ts` — escalating backoff, re-wake on schedule, abandon at the cap
- `tests/wake-registry.test.ts` — persistence, dedupe, liveness filtering, perms, GC
- `tests/wake-launch-claims.test.ts` — claim matching, consumed-claim reuse, ambiguity surfacing, GC
- `tests/wakeable-launcher.test.ts` — arg/env/config construction and full-screen defaults (no secret leakage into env)
- `tests/app-server-client.test.ts` — connect/request timeouts, and that materialization
  uses `thread/name/set` and issues **no** `turn/start` or `thread/rollback`
- `tests/wake-launch-role.test.ts` — single-identity election: a standalone `codex`
  session still registers, exactly one of N concurrent live children wins the root
  lock, and a lock held by a dead process is reclaimable
- `tests/bounded-log.test.ts` — private log paths, permissions, and rotation
- `tests/process-lifecycle.test.ts` — orphan-parent detection safety boundary
- `tests/codex-inbox-store.test.ts` — durable queue + bodyless metadata + fail-closed perms

Run `bunx tsc --noEmit` and `bun test` to verify.
