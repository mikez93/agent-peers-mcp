# Cross-Machine Architecture for agent-peers-mcp (Tailscale Federation)

Repo: /Users/mike/agent-peers-mcp @ cfd74f5. Design layers on top of the parallel identity-stabilization workstream (stable mailbox identity, one-peer-per-logical-agent, suspend-aware GC).

## 1. Topology recommendation: (b) per-machine brokers + broker-to-broker store-and-forward federation

Each machine keeps its own authoritative broker (loopback-bound, own SQLite DB) for the peers that live on it. Brokers federate over the tailnet: a directory-sync loop exchanges peer listings, and a relay loop pushes messages destined for remote peers into the remote broker's mailbox, store-and-forward with retry.

### Why not (a) single broker on Studio

- During a MagicSock wedge (175s blackouts observed), every MacBook peer goes deaf — including MacBook-to-MacBook messaging, heartbeats, registration, and the piggyback channel. Two agents in adjacent terminal tabs on the same laptop could not talk to each other because the WAN-ish link is down. That is a strict regression from today.
- ensure-broker auto-spawn breaks: a MacBook session starting during a wedge can neither reach the Studio broker nor legitimately spawn one.
- Machine-local subsystems (wake daemon over local WebSocket, /v1/protection/check shelling to `ps`, PID liveness on peers.pid) are meaningless against a remote broker. The Studio broker cannot vouch for MacBook pids; MacGuardian's reaper on the MacBook would lose its protection oracle entirely.
- Requires merging two DBs and gives the MacBook no autonomy. Rollback is a full re-migration.

### Why not (c) thin periodic sync

(c) is (b) with worse latency and the same schema/auth work. Once you need a host column, a fleet directory, an idempotency key, and an outbox, you have built federation; polling instead of pushing just adds seconds of delay and more duplicate-delivery windows. No simplicity is actually saved.

### Tradeoff table

| Criterion | (a) single broker on Studio | (b) federation (RECOMMENDED) | (c) periodic sync |
|---|---|---|---|
| MacBook local messaging during wedge | DEAD | unaffected | unaffected |
| Remote messaging during wedge | fails hard | queued, auto-flush | queued, slower flush |
| Wake daemon / protection / PID liveness | broken for MacBook | works (all local) | works |
| DB migration | merge two DBs | none (additive columns) | none |
| Rollback | painful | env-flag off, local unchanged | env-flag off |
| New moving parts | remote client plumbing everywhere | 2 broker loops + 3 endpoints | same + duplicate handling |
| Loopback-only broker binding preserved | no (or serve-only) | yes | yes |

Decisive extra: **remote wake works for free under (b).** Wake is triggered by message arrival at the destination machine's local broker; a relayed message lands in the local mailbox and the existing local wake machinery fires. No cross-machine wake protocol needed.

## 2. Identity / addressing

- **Host alias**: each machine gets a short stable alias — `studio`, `mbp` — stored in `~/.agent-peers-host` (fleet-managed, one word, same charset as peer names). Broker loads it at startup; refuses to start without it once federation is enabled (fail-closed on identity).
- **Fleet map**: `~/.agent-peers-fleet.json` (fleet-reconciler-managed):
  ```json
  {
    "self": "mbp",
    "hosts": {
      "studio": "https://mike-mac-studio.tail72b372.ts.net/agent-peers",
      "mbp": "https://macbook-pro-3.tail72b372.ts.net/agent-peers"
    }
  }
  ```
- **Schema**: `peers` gains `host TEXT NOT NULL` (backfilled to self alias) and `origin TEXT NOT NULL DEFAULT 'local' CHECK(origin IN ('local','remote'))`. UNIQUE(name) becomes **UNIQUE(name, host)**. Remote rows are cached directory entries: no pid/tty/session_token semantics (session_token set to a sentinel, never honored for remote rows — every session-token-authenticated WHERE clause additionally requires `origin = 'local'`).
- **Addressing**: `send_message` accepts `name`, `name@host`, or peer UUID.
  - Bare name: resolve locally first; if no local match and exactly one remote match, route there; if multiple matches across hosts, error: `ambiguous peer "ezra-hermes": ezra-hermes@studio, ezra-hermes@mbp — qualify with @host`.
  - `list_peers`: every row now includes `host` and, for remote rows, `reachable: boolean` + `host_last_sync`. Scope semantics: `machine` (default today) stays local-only; new `scope: "fleet"` returns local + remote. Recommend making the MCP tool default to fleet so "list_peers just works" — output sorted local-first, remote annotated `@studio (reachable)` / `@studio (UNREACHABLE 3m — messages will queue)`.
- Collisions across machines are legal (unique per host); the parallel workstream's one-peer-per-logical-agent election stays per-host; fleet-level name election is explicitly out of scope for v1.

## 3. Auth / transport

- Brokers **keep binding 127.0.0.1:7900**. Cross-machine exposure is exclusively via `tailscale serve` path mounts (tailnet-only, Tailscale-terminated TLS, prefix stripped by serve):
  - Studio: `tailscale serve --bg --set-path /agent-peers http://127.0.0.1:7900` (coexists with existing `/` and `/vector-ke` mounts)
  - MacBook: same command (first serve config on that machine).
- **Two-secret model**: the existing per-machine `~/.agent-peers-secret` stays machine-private and is never synced. A new `~/.agent-peers-federation-secret` (0600, same validation code as shared-secret.ts) is provisioned once and synced to both machines by the fleet reconciler (MacBook→Studio scp; reverse SSH not needed — reconciler runs from each machine, and the file only needs to land once). Sent as `X-Agent-Peers-Federation` and accepted **only** on `/federation/*` routes; the local secret is never accepted there and vice versa. Compromise blast radius: federation secret exposes relay/directory only, not local admin surface.
- Defense-in-depth (cheap, optional): federation handler checks the `Tailscale-User-Login` header that serve injects equals the owner's login. Not the primary control — the secret is.
- `/v1/protection/check` and `/health` remain reachable through serve; harmless (protection is positive-signal-only and derived from local `ps`). If desired, gate `/federation/*` as the only externally-mounted prefix later via a second port; not required for v1 given single-owner tailnet + secret gate.

## 4. Protocol / schema deltas

New broker endpoints (federation-secret gated):

- `POST /federation/directory` — request: `{ from_host, peers: [...] }` (the caller's local live+durable peers, PEER_COLS + host); response: same shape for the callee. Each side upserts the other's peers as `origin='remote'` rows and records `fleet_hosts.last_sync`. Runs every 15s from each broker to every fleet host (full-state exchange, so it doubles as reachability probe and heals any drift).
- `POST /federation/relay` — request: `{ from_host, messages: [{ origin_msg_id, to_name, from_name, from_host, from_peer_type, from_summary, from_cwd, text, sent_at }] }`. Callee inserts into its own `messages` for the local peer named `to_name` (same deliverability rules as local send: live-or-durable, mailbox cap). Response per message: `delivered | unknown_peer | mailbox_full | stale`. **Idempotency**: UNIQUE(origin_host, origin_msg_id) on messages; duplicate relay attempts (retry after timeout where the write actually landed) return `delivered` without a second insert.
- `GET /federation/health` — `{ host, broker_pid, schema }` (federation-secret gated; distinct from public /health).

Schema deltas:

- `peers`: `+ host TEXT NOT NULL`, `+ origin TEXT NOT NULL DEFAULT 'local'`, UNIQUE(name)→UNIQUE(name, host).
- `messages`: `+ origin_host TEXT`, `+ origin_msg_id INTEGER`, `+ from_host TEXT`, `+ from_name TEXT`, `+ from_peer_type TEXT`, `+ from_summary TEXT` (nullable; local messages leave them NULL and enrich from peers as today; relayed messages carry the snapshot since from_id won't resolve). Partial unique index on (origin_host, origin_msg_id) WHERE origin_msg_id IS NOT NULL.
- New `remote_outbox`: `(id INTEGER PK, to_name, to_host, from_id, from_snapshot_json, text, created_at, attempts INTEGER DEFAULT 0, next_attempt_at, last_error, status CHECK(status IN ('queued','delivered','failed')))`.
- New `fleet_hosts`: `(host TEXT PK, base_url, last_sync_ok_at, last_attempt_at, consecutive_failures INTEGER)` — loaded from fleet.json at startup, runtime state persisted.

Send path change in `sendMessage()`: resolve target; if `origin='remote'` (or `name@host` names a non-self host), validate sender auth as today, snapshot sender metadata, insert into `remote_outbox`, return `{ ok: true, message_id, status: "queued_for_relay", detail: "peer ezra-hermes is on studio; relay pending (host reachable)" }` — or `"(host UNREACHABLE for 3m; will retry)"`. Local sends return `status: "delivered_local"`.

Relay loop (in broker, alongside GC timer): every 5s, batch-pull queued outbox rows due for attempt, POST per destination host with 10s timeout. Success → mark delivered (keep row 24h for observability, then GC). Failure → exponential backoff 5s/15s/30s/60s cap with jitter, bump consecutive_failures on fleet_hosts. Terminal responses (`unknown_peer`, `mailbox_full`) → mark failed AND inject a system notice into the **sender's own mailbox**: "delivery to ezra-hermes@studio failed: mailbox full". TTL: after 24h queued, mark failed + same bounce notice. Directory-sync success immediately triggers a relay flush (fast recovery after wedge).

## 5. Client changes (deliberately minimal)

- MCP servers (claude/codex/hermes) still talk **only** to the local loopback broker; no client ever dials cross-machine. Join ergonomics (shell wrappers, env, hermes config) unchanged.
- `list_peers` tool: pass through `host`/`reachable`, default scope fleet, render `name@host` for remote rows with reachability annotation.
- `send_message` tool: accept `name@host`; surface the new `status`/`detail` so the agent sees "queued, host unreachable" instead of a fake success.
- `check_messages`/piggyback: prepend a degraded-state line when any fleet host has consecutive_failures ≥ 2: "note: studio unreachable 4m; 2 outbound messages queued."
- cli.ts: `fleet` command (host table: url, last sync, failures, queued outbox count), `outbox` command (queued/failed rows), `messages` gains from_host column.

## 6. Failure-mode matrix

| Scenario | Local messaging | Remote send | Discovery | Recovery |
|---|---|---|---|---|
| MagicSock wedge on MacBook (tailnet dead, LAN fine) | unaffected both machines | queued in outbox, status visible to sender | remote peers listed with UNREACHABLE + age | first directory-sync success flushes outbox; nothing lost |
| Remote broker process down (tailnet fine) | unaffected | serve returns 502 → same queue path | same UNREACHABLE marking | ensure-broker revives broker on next local session there; flush |
| Wedge/timeout mid-relay (write may have landed) | — | retry; (origin_host, origin_msg_id) dedupes | — | at-most-once insert, at-least-once attempt |
| Tailscale serve config lost (app auto-update) | unaffected | queue path (connection refused/404) | UNREACHABLE | watchdog/`cli.ts fleet` shows persistent failure → re-run serve cmd (fleet reconciler asserts serve config) |
| Destination peer unknown/mailbox full | — | terminal failure + bounce message to sender's mailbox | — | sender is told explicitly |
| Both brokers fine, message to suspended durable remote peer | — | relayed, waits in remote mailbox (existing durable semantics) | shown stale-but-durable | delivered on peer's next poll/wake |

## 7. Migration sequence

1. Land schema migrations (additive, follow existing BEGIN IMMEDIATE pattern; host backfill = self alias; keep migration ordered LAST like `durable`). Old brokers ignore new columns — safe to deploy one machine at a time.
2. Provision `~/.agent-peers-host` + `~/.agent-peers-fleet.json` + federation secret on both machines via fleet reconciler (Studio via reconcile-local). Federation stays OFF (`AGENT_PEERS_FEDERATION=1` gate, default off).
3. `tailscale serve --set-path /agent-peers` on both machines; verify with curl from the peer machine (401 without federation header = success).
4. Restart brokers with federation on; watch `cli.ts fleet` for green sync both directions.
5. Round-trip acceptance tests (below).
6. Rollback: unset AGENT_PEERS_FEDERATION (brokers stop syncing/relaying; remote rows age out via existing GC; queued outbox rows persist inert and visible), remove serve mounts. Local behavior is byte-identical to today — no DB merge ever happened, so rollback is a flag flip.

Queued-mail safety: no existing mail moves between DBs at any point; each DB remains authoritative for its own mailboxes.

## 8. Acceptance tests

1. Round trip: MacBook claude peer → `send_message ezra-hermes@studio` → delivered, replied, reply arrives back; `messages` shows from_host on both sides.
2. Bare-name resolution: unique remote name resolves; duplicated name across hosts errors with candidate list.
3. Fleet discovery: `list_peers` on MacBook shows Studio durable peers with host + reachable=true within 15s of their registration.
4. Outage injection (wedge sim): block tailnet (down the interface or `tailscale down` on MacBook) → send to remote peer → `ok: true, status: queued_for_relay` with UNREACHABLE detail; local MacBook peer-to-peer messaging still works; restore tailnet → message delivered ≤ 20s, exactly once.
5. Mid-send timeout dedupe: inject delay >10s on remote /federation/relay so sender times out after the write lands; verify retry yields exactly one message row (idempotency index).
6. Remote broker down: kill Studio broker; send from MacBook → queued; restart broker → flush; no dupes.
7. Bounce: send to nonexistent remote name → sender receives system bounce message.
8. Mailbox cap: fill remote durable mailbox to 500 → relay returns mailbox_full → bounce to sender.
9. Remote wake: message relayed to a wakeable idle Codex on Studio wakes it via Studio's own wake daemon (no cross-machine wake code).
10. Security: request to /federation/relay with local secret (not federation secret) → 401; plain HTTP to :7900 from other machine's LAN IP → connection refused (loopback bind); serve URL from a non-tailnet network → unreachable.
11. Rollback: disable federation flag → local suite still green; remote rows disappear from list_peers within GC window.

## 9. Explicit scope decisions

- Remote wake RELAY protocol: unnecessary (wake fires locally on relayed delivery) — nothing to build.
- Fleet-wide unique names / logical-agent election across machines: v2.
- >2 machines: design is N-way already (fleet.json), but only 2 tested.
- End-to-end encryption beyond Tailscale TLS: out of scope (single owner, single tailnet).
