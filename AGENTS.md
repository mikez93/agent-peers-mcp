# agent-peers-mcp — AI Context

Working context for an AI agent editing this repo. Updated against `9be6159` (2026-11-02), the
accepted four-machine v3 baseline.

## Quick Reference

- **Stack**: Bun + TypeScript, SQLite (`bun:sqlite`), MCP SDK. No build step; sources run directly.
  One Python plugin (`hermes-plugins/agent-peers-desktop-wake/`), tested through `bun test`.
- **Entry points**: `broker.ts` (daemon); MCP servers `codex-server.ts` and `claude-server.ts`, plus
  thin entry points `hermes-server.ts`, `droid-server.ts` and `openclaw-server.ts` that set
  `AGENT_PEERS_RUNTIME` and load `codex-server.ts`; `cli.ts` (ops); `wake-daemon.ts` +
  `bin/codex-peer` (the wake daemon: Codex, Hermes chat and OpenClaw passes); `wakeable-droid.ts` +
  `bin/droidpeer` (Droid wake); `bin/claude-peer-rewake` (Claude desktop-app wake hook);
  `deploy/linux/install.sh` (Linux broker and wake units).
- **Peer types**: `claude`, `codex`, `hermes`, `droid`, `openclaw`. Adding one means touching the
  `peers` CHECK constraint (a migration), `shared/types.ts`, `shared/federation.ts` and
  `shared/state-dir.ts`.
- **Test**: `bun test`. **Typecheck**: `bun run typecheck`. Both must be clean before you commit.
  `bun install` first on a fresh checkout. The suite is 579 tests in 66 files at `9be6159`; broker
  tests start isolated brokers on their own ports and temporary databases.
- **Runtime state** (not in the repo, all under `$HOME`):
  - Broker: `~/.agent-peers.db`, `~/.agent-peers-secret` (0600).
  - Federation (only when `AGENT_PEERS_FEDERATION=1`): `~/.agent-peers-host`,
    `~/.agent-peers-fleet.json`, `~/.agent-peers-federation-secret` (0600, separate from the local
    secret). Its state lives in the broker DB (`federation_outbox`, `federation_receipts`,
    `federation_routes`, `federation_senders`).
  - Per-harness inboxes and coordination: `~/.agent-peers-{codex,claude,hermes,droid,openclaw}/`.
  - Codex wake: `~/.agent-peers-codex/wake-registry.json`, `wake-ledger/`, `wake-daemon.log`.
  - Hermes chat wake, under `~/.agent-peers-hermes/`: `disabled` (kill switch),
    `chat-wake/enabled` (profiles the gateway driver may wake), `chat-wake/desktop-enabled` (the
    Desktop plugin opt-in, one `<profile> <chat-key|*>` line each), `chat-wake/<profile>/` (one
    ledger per chat, `<ledger>.lock`, `evidence/`, `logs/`).
  - OpenClaw, under `~/.agent-peers-openclaw/`: `disabled`, `wake/enabled`,
    `wake/<agent>.ledger.json` (custody ledger) with its `.lock`, `bindings/<agent>.json`.
  - Claude socket-wake markers: `~/.agent-peers-claude/socket-wake/<server pid>`.
  - Any of these roots can be moved with `AGENT_PEERS_STATE_DIR` or
    `AGENT_PEERS_<RUNTIME>_STATE_DIR` (`shared/state-dir.ts`).

## Component Map

| Area | Files | Deep doc |
| --- | --- | --- |
| Broker daemon, HTTP API, schema | `broker.ts`, `shared/ensure-broker.ts`, `shared/shared-secret.ts` | `docs/components/broker.md` |
| Addressing, personas, chat mail | `shared/peer-address.ts`, `shared/broker-addressing.ts`, `shared/chat-directory.ts`, `shared/chat-list.ts` | `docs/ARCHITECTURE.md` §4 |
| Federation (cross-machine) | `shared/federation.ts`, `shared/federation-config.ts` | `docs/components/federation.md` |
| Linux brokers (systemd --user) | `deploy/linux/` | `docs/components/linux-brokers.md` |
| MCP servers + delivery machine | `codex-server.ts`, `claude-server.ts`, `hermes-server.ts`, `droid-server.ts`, `shared/delivery-state.ts`, `shared/codex-inbox.ts`, `shared/piggyback.ts`, `shared/hermes-claims.ts`, `shared/paperclip-guard.ts` | `docs/components/mcp-servers-delivery.md` (August baseline) |
| Codex idle wake (incl. desktop chats over SSH) | `wake-daemon.ts`, `wakeable-codex.ts`, `bin/codex-peer`, `shared/wake-*.ts`, `shared/app-server-client.ts`, `shared/codex-desktop-wake.ts` | `docs/components/wake-subsystem.md`, `docs/wakeable-codex.md`, `docs/wake-daemon.md` |
| Claude wake (channel, inbox socket, desktop hook) | `shared/claude-socket-wake.ts`, `bin/claude-peer-rewake` | `docs/ARCHITECTURE.md` §7 |
| Droid idle wake | `wakeable-droid.ts`, `bin/droidpeer`, `shared/droid-*.ts` | `docs/wakeable-droid.md` |
| Hermes chat wake (gateway driver) | `shared/hermes-wake-pass.ts`, `shared/hermes-chat-wake.ts` | `docs/ARCHITECTURE.md` §7 |
| Hermes Desktop wake plugin | `hermes-plugins/agent-peers-desktop-wake/`, tests in `tests/python/` | `docs/components/hermes-desktop-wake.md` |
| OpenClaw peer (main-session binding, followup wake, custody ledger) | `openclaw-server.ts`, `shared/openclaw-*.ts` | `docs/components/openclaw-peer.md` |
| Retired Hermes V2 runtime (compatibility fence only) | `shared/hermes-conversation-fence.ts` | `docs/legacy-hermes-v2.md` |
| Operator CLI | `cli.ts` | `docs/components/cli-ops-tests.md` (`bun cli.ts --help` is the live list) |
| Switchover rehearsal | `scripts/rehearse-switchover.ts` | header comment |
| System design | — | `docs/ARCHITECTURE.md` |
| **Normative delivery guarantees** | — | **`docs/delivery-contract.md`** |

## Key Patterns

- **Fail-closed everywhere on trust.** Secret file and DB must be regular files, owned by the
  current uid, mode 0600, or the broker exits. Readiness requires an authenticated `/ready`
  with protocol 1, an allowed owner and a matching `db_id`; a bare `/health` 200 is never
  sufficient.
- **The service manager owns the broker.** launchd on macOS, `systemd --user` on Linux. Clients
  start the service and wait; they never spawn it except under `AGENT_PEERS_SPAWN_BROKER=1`
  (dev/tests) with a pinned child env.
- **Each machine's broker is authoritative for its own peers and mail.** Federation never copies
  remote peers into `peers`; it queries live and relays into the destination's outbox.
- **At-least-once delivery, stated honestly.** Lease + explicit ack at the broker; typed ack
  outcomes; duplicate presentation is possible and deduped by message id.
- **Wakes are bodyless.** A wake names senders or ids and tells the agent to call
  `check_messages`; it never carries message text and never acks.
- **Evidence-based confirmation.** A drawn message is pruned/acked only after a *later*
  request proves the response reached the model — see Gotchas.
- **Per-session identity.** One session = one peer = one UUID. Names are exclusive; sessions
  are not.
- **v3 features are additive and advertised.** New behavior shows up in `/ready` `capabilities`,
  new columns and tables are added without rebuilding old ones, and `protocol` stays `1` because
  old clients compare it for equality.
- **Paperclip agents are never peers.** A session embodied inside a Paperclip company
  (`PAPERCLIP_AGENT_ID` or `PAPERCLIP_RUN_ID` set) is refused registration, which blocks both
  directions at once: it cannot be listed/messaged/woken, and never gets the peer tools. The
  check runs **before** the `AGENT_PEERS_ENABLED` gate so an adapter config cannot opt it back
  in. See `shared/paperclip-guard.ts` — and keep it keyed on embodiment markers only; a board
  *operator* carries `PAPERCLIP_HOME`/`INSTANCE_ID`/`COMPANY_ID` and must stay allowed.

## Gotchas

Things that have already caused real bugs here. Read before touching delivery, startup, wake or
federation.

1. **Never enqueue a broker ack at draw time.** An unacked lease on an undelivered message is
   the re-offer safety net. Acks belong at confirm only.
2. **Confirm eligibility is snapshotted at REQUEST ENTRY** (`delivery.newArrival()`), before
   any pre-read wait — not at lock entry. A call parked in `wait_for_peer_messages` can
   outlive a sibling's `promote`; if it sampled later it would confirm a response that did not
   exist when it was issued. There is a regression test named `BARRIER:` — do not weaken it.
3. **`createAsyncLock()` is NOT reentrant.** Code already inside `withPiggybackLock` must call
   `fetchBrokerLeases()` + `applyLeasedToQueue()` directly, never `pollBrokerIntoQueue()`,
   which can await a background poll queued on the same lock → deadlock.
4. **Classification and upsert of leased mail must be inside the lock.** Outside it, an upsert
   can interleave with a confirm's read-token → remove → markConfirmed window and resurrect a
   just-confirmed message as unread.
5. **"Deployed ≠ in effect."** MCP servers only reload when their session restarts. Pushing
   client-side changes does not change any running session; adoption is rolling. A broker
   restart changes broker-side behavior for every client at once, which is why v3 addressing
   lives in the broker.
6. **`launchctl bootstrap` immediately after `bootout` fails** with "Input/output error 5".
   Wait 2-3 seconds, or just use `launchctl kickstart -k`. On Linux the equivalent restart is
   `systemctl --user restart agent-peers-broker`.
7. **Peer names are case-sensitive at registration** (`vector` ≠ `Vector`) — bd-21r.11. Sending
   falls back to a case-insensitive and then a persona match, and several matches return the
   candidates instead of guessing. Defaults are `persona-repository-harness` from the AGENTS.md
   persona. Explicit names remain overrides. Names allow 96 characters but never UUID-shaped
   strings; this keeps name-or-ID addressing unambiguous. `Started` determines session age,
   independently of name suffixes and heartbeat recency.
8. **`gc-inboxes` has a 7-day mtime gate** and dry-runs by default. It announces skips; pass
   `--min-age-days 0` only for rows you have verified dead. It archives by timestamped rename
   and never deletes.
9. **Unread durable mail has no TTL.** The 15-minute window in `check_messages` is a *display*
   window for the ring buffer only; unread mail surfaces at any age. Do not add a TTL — that
   was a silent-loss bug.
10. **Federation: a remote send means "queued", not "delivered".** Do not make a send wait on the
    remote machine. The send's enqueue is synchronous inside the sender-authentication
    transaction; network I/O happens outside it. Keep `/list-peers` a **bare JSON array** (old
    clients parse it; unreachable hosts go in the `X-Agent-Peers-Unreachable-Hosts` header), and
    never bump `/ready` `protocol`. Never reuse the local broker secret for federation: old
    adapters cache it, and the federation secret is deliberately separate and re-read on every
    request. `docs/components/federation.md` is the contract.
11. **Chat mail is partitioned.** With chat mail on, a Hermes call that names a chat must never
    draw or confirm mail for another chat, and a call with no chat sees only the general mailbox.
    Near-miss chat titles return candidates and queue nothing. Do not add fuzzy matching.
12. **Hermes ledgers are shared across two languages and fail closed.** The gateway driver
    (`shared/hermes-chat-wake.ts`) and the Desktop plugin (Python) take the same
    `<ledger>.lock` and mirror `classifyDesktopAttempt`. Change one side and you must change the
    other, and the cross-language test in `tests/hermes-chat-wake.test.ts` must still pass. A held
    lock is never auto-cleared (a reaper racing a fresh owner can leave two owners), and uncertain
    desktop evidence blocks re-wakes of that chat until `bun cli.ts hermes-desktop-clear`.
13. **OpenClaw wake is custody-first.** Every submission is recorded in the fsynced ledger before
    any retry decision, and an unreadable ledger blocks wakes rather than reading as "nothing
    outstanding". Gateway calls are refused when `OPENCLAW_SHELL` is set; never strip that marker.
    Read `docs/components/openclaw-peer.md` before touching `shared/openclaw-*.ts`.
14. **Do not resurrect the Hermes V2 runtime.** It was retired (bd-b2in.9); `AGENT_PEERS_HERMES_V2=1`
    only prints a warning. `shared/hermes-conversation-fence.ts` stays because the broker still
    reserves legacy names, rejects stale-owner access and keeps their unacked mail out of GC.
    Its source is preserved at the tag `archive/hermes-v2-2026-10-31`. See `docs/legacy-hermes-v2.md`.
15. **An untracked file in the checkout blocks the Mac fleet reconcile.** The reconciler
    fast-forwards `~/agent-peers-mcp` and refuses to update a checkout that
    `git status --porcelain --untracked-files=all` reports as dirty. Hermes loads
    `hermes-plugins/agent-peers-desktop-wake/` from the checkout and writes Python `__pycache__/`
    beside it; that blocked the Studio until `dd1fb2e` added `__pycache__/` to `.gitignore`. Never
    leave scratch files, generated output or a new runtime artifact untracked in a live checkout;
    ignore it in `.gitignore` or write it outside the repo. On the Macs `origin` is the upstream
    Co-Messi repo and pushes go to `fork`.
16. **Federation is opt-in per broker, and Hermes Desktop wake is opt-in per profile.** Shipping
    code wakes nothing and federates nothing by itself: `AGENT_PEERS_FEDERATION=1` plus the three
    config files, `chat-wake/enabled`, `chat-wake/desktop-enabled` and `wake/enabled` decide what
    is live. At `9be6159` the closed-chat gateway driver is built but off (no `chat-wake/enabled`
    file on the Studio); only Desktop-open chats are woken, by the plugin. Removing a line is the rollback, and mail stays queued.

## Conventions

- Comments in this codebase explain *why*, usually citing the review round or bead that forced
  the behavior. Preserve those citations when you edit nearby code; they are the only record
  of which races the shape is defending against.
- Tests live in `tests/` mirroring the module name. Concurrency fixes need a deterministic test
  at the state-machine level (`tests/delivery-state.test.ts`), not just an integration test —
  integration tests cannot reach the interleavings.
- Docs follow "the code wins". Each component doc says what it was checked against; do not move
  a stamp forward for content you did not re-verify.

## Known Issues

- `docs/README.md` marks which docs are current and which are history.
- `docs/IMPROVEMENT-REPORT.md`, `docs/issues/` and `docs/known-issues-2026-08-08.md` are August
  snapshots (`63503f2` and earlier); check the code before trusting an entry.
- `docs/components/openclaw-peer.md` lists the OpenClaw recovery paths that are not yet proven
  (lost response, restart mid-submission, compaction, inbound healing after an idle unload).
