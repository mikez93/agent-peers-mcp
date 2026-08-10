# agent-peers-mcp — AI Context

Working context for an AI agent editing this repo. Written against `63503f2` (2026-08-10).

## Quick Reference

- **Stack**: Bun + TypeScript, SQLite (`bun:sqlite`), MCP SDK. No build step; sources run directly.
- **Entry points**: `broker.ts` (daemon), `codex-server.ts` / `claude-server.ts` / `hermes-server.ts` (MCP servers), `cli.ts` (ops), `wake-daemon.ts` + `bin/codex-peer` (Codex wake).
- **Test**: `bun test` (239 tests, 31 files). **Typecheck**: `bunx tsc --noEmit`. Both must be clean before you commit.
- **Runtime state** (not in the repo): `~/.agent-peers.db`, `~/.agent-peers-secret` (0600), `~/.agent-peers-{codex,claude,hermes}/`.

## Component Map

| Area | Files | Deep doc |
| --- | --- | --- |
| Broker daemon, HTTP API, schema | `broker.ts`, `shared/ensure-broker.ts`, `shared/shared-secret.ts` | `docs/components/broker.md` |
| MCP servers + delivery machine | `codex-server.ts`, `claude-server.ts`, `hermes-server.ts`, `shared/delivery-state.ts`, `shared/codex-inbox.ts`, `shared/piggyback.ts`, `shared/hermes-claims.ts` | `docs/components/mcp-servers-delivery.md` |
| Codex idle wake | `wake-daemon.ts`, `wakeable-codex.ts`, `bin/codex-peer`, `shared/wake-*.ts`, `shared/app-server-client.ts` | `docs/components/wake-subsystem.md` |
| Operator CLI | `cli.ts` | `docs/components/cli-ops-tests.md` |
| System design | — | `docs/ARCHITECTURE.md` |
| **Normative delivery guarantees** | — | **`docs/delivery-contract.md`** |

## Key Patterns

- **Fail-closed everywhere on trust.** Secret file and DB must be regular files, owned by the
  current uid, mode 0600, or the broker exits. Readiness requires an authenticated `/ready`
  with matching `db_id`; a bare `/health` 200 is never sufficient.
- **launchd owns the broker.** Clients kickstart and wait; they never spawn it except under
  `AGENT_PEERS_SPAWN_BROKER=1` (dev/tests) with a pinned child env.
- **At-least-once delivery, stated honestly.** Lease + explicit ack at the broker; typed ack
  outcomes; duplicate presentation is possible and deduped by message id.
- **Evidence-based confirmation.** A drawn message is pruned/acked only after a *later*
  request proves the response reached the model — see Gotchas.
- **Per-session identity.** One session = one peer = one UUID. Names are exclusive; sessions
  are not.

## Gotchas

Things that have already caused real bugs here. Read before touching delivery or startup.

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
   client-side changes does not change any running session; adoption is rolling.
6. **`launchctl bootstrap` immediately after `bootout` fails** with "Input/output error 5".
   Wait 2-3 seconds, or just use `launchctl kickstart -k`.
7. **Peer names are case-sensitive** (`vector` ≠ `Vector`) — bd-21r.11.
8. **`gc-inboxes` has a 7-day mtime gate** and dry-runs by default. It announces skips; pass
   `--min-age-days 0` only for rows you have verified dead. It archives by timestamped rename
   and never deletes.
9. **Unread durable mail has no TTL.** The 15-minute window in `check_messages` is a *display*
   window for the ring buffer only; unread mail surfaces at any age. Do not add a TTL — that
   was a silent-loss bug.
10. **Cross-machine is out of scope.** Do not add host routing, relay endpoints, or
    `scope=fleet` without reopening bd-21r.8. The `host` column and `message_uid` are
    intentional groundwork only.

## Conventions

- Comments in this codebase explain *why*, usually citing the review round or bead that forced
  the behavior. Preserve those citations when you edit nearby code; they are the only record
  of which races the shape is defending against.
- Tests live in `tests/` mirroring the module name. Concurrency fixes need a deterministic test
  at the state-machine level (`tests/delivery-state.test.ts`), not just an integration test —
  integration tests cannot reach the interleavings.

## Known Issues

- `docs/IMPROVEMENT-REPORT.md` — prioritized, actionable.
- `docs/issues/` — conflicts, technical debt, security notes.
- `docs/known-issues-2026-08-08.md` — historical; check status before trusting an entry.
