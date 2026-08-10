# Architecture

System design of `agent-peers-mcp` as of `63503f2` (2026-08-10). Truth-from-code:
everything below was read out of the source, not from intent.

---

## 1. The one-paragraph version

`agent-peers-mcp` lets AI coding agents running in separate terminals on the same Mac
discover each other and exchange messages. A single **broker** daemon (loopback HTTP +
SQLite) holds the peer registry and the message queues. Each agent session loads an **MCP
server** into its harness (Claude Code, Codex CLI, or Hermes Agent); that server registers
the session as a peer, polls the broker for mail, and surfaces it to the model through
whatever delivery channel its harness supports. A separate **wake subsystem** exists only
for Codex, whose CLI has no push channel: it hosts the session on Codex's app-server so a
daemon can start a turn on the exact live thread when mail arrives. Everything is
localhost-only; there is no cloud component and no API key anywhere in the message path.

---

## 2. Component map

| Component | Files | Runs as | Doc |
| --- | --- | --- | --- |
| Broker daemon | `broker.ts`, `shared/ensure-broker.ts`, `shared/shared-secret.ts` | One per machine, owned by launchd | [components/broker.md](components/broker.md) |
| MCP servers + delivery | `codex-server.ts`, `claude-server.ts`, `hermes-server.ts`, `shared/delivery-state.ts`, `shared/codex-inbox.ts`, `shared/piggyback.ts`, `shared/hermes-claims.ts` | One per agent session | [components/mcp-servers-delivery.md](components/mcp-servers-delivery.md) |
| Wake subsystem (Codex only) | `wake-daemon.ts`, `wakeable-codex.ts`, `bin/codex-peer`, `shared/wake-*.ts`, `shared/app-server-client.ts` | One daemon per machine + one app-server per wakeable session | [components/wake-subsystem.md](components/wake-subsystem.md) |
| Operations CLI | `cli.ts` | Invoked on demand | [components/cli-ops-tests.md](components/cli-ops-tests.md) |

Contracts that span components:

- [delivery-contract.md](delivery-contract.md) — the normative per-harness delivery
  guarantees. **This is the document to read before changing delivery code.**
- [wakeable-codex.md](wakeable-codex.md), [wake-daemon.md](wake-daemon.md) — wake design
  and operations.
- [plans/cross-machine-federation-tailscale.md](plans/cross-machine-federation-tailscale.md)
  — designed, deliberately **not built** (see §7).

---

## 3. Runtime topology

```
                        ┌───────────────────────────────────────────┐
                        │  launchd: com.mike.agent-peers-broker      │
                        │  broker.ts --owner=launchd                 │
                        │  127.0.0.1:7900   ~/.agent-peers.db (0600) │
                        └───────────────────────────────────────────┘
                              ▲             ▲              ▲
             X-Agent-Peers-Secret (0600 file), loopback only
                              │             │              │
        ┌─────────────────────┴──┐  ┌───────┴────────┐  ┌──┴──────────────────┐
        │ claude-server.ts       │  │ codex-server.ts│  │ hermes-server.ts    │
        │ (per Claude session)   │  │ (per Codex     │  │ (per Hermes surface,│
        │ channel push + ring    │  │  session)      │  │  codex transport)   │
        │ buffer + durable inbox │  │ [PEER INBOX]   │  │ election: 1 durable │
        │ ~/.agent-peers-claude  │  │ piggyback      │  │ ~/.agent-peers-hermes│
        └────────────────────────┘  │ ~/.agent-peers-│  └─────────────────────┘
                                    │  codex         │
                                    └───────┬────────┘
                                            │ (Codex only)
                        ┌───────────────────┴────────────────────┐
                        │ wake daemon → Codex app-server         │
                        │ turn/start on the exact live thread    │
                        └────────────────────────────────────────┘
```

**Trust boundary**: the shared secret file (`~/.agent-peers-secret`, 0600) and the DB file
mode. Any process running as the same user can read them, which is the accepted model —
this is a single-user developer machine, not a multi-tenant host. The broker refuses to run
if either file drifts off 0600 or changes owner.

---

## 4. Identity model

This is the part most often misunderstood, so it is stated explicitly:

- **One session = one peer = one UUID.** Every running agent session registers its own row.
  Several sessions of "the same" agent may run simultaneously in one repo and each is an
  independent peer that can message the others.
- **Names are a separate, exclusive layer.** A durable name (`vector`, `ezra-hermes`) is
  owned by exactly one peer at a time. A second session requesting a taken name is
  suffix-laddered (`vector-2`) rather than rejected — sessions are never capped, only names
  are exclusive.
- **Durability is explicit**: durable registration requires `PEER_NAME` and
  `AGENT_PEERS_EPHEMERAL != "1"`. Ephemeral rows age out ~60s after the process dies;
  durable rows survive restarts and keep their mailbox.
- **Names are currently case-SENSITIVE** (`vector` ≠ `Vector`) — tracked as bd-21r.11.
- **Hermes runs one durable peer per profile.** Both the gateway and serve processes of a
  profile load the MCP with the same `PEER_NAME`; they race a file-lock election
  (`shared/hermes-claims.ts`). The winner registers durable and owns the name; losers
  register ephemeral with the same tool allowlist. Duplicate ephemeral rows beside a durable
  one are election losers, not a bug.

---

## 5. Delivery pipeline (the load-bearing design)

Delivery is **honest at-least-once**, never "exactly-once" — exactly-once is unattainable
at the model/UI boundary. The guarantee is that a message is never dropped silently and
never acked without evidence it reached the model.

Two independent mechanisms compose:

**(a) Broker side — lease and ack.** `poll-messages` leases messages with a token and an
expiry; the row stays queued until an explicit `ack-messages`. If a client dies mid-turn,
the lease expires and the broker re-offers. Ack results are typed
(`acked | expired | unknown | wrong_session`) so a client can never mistake
`{ok:true, acked:0}` for success.

**(b) Client side — the `DeliveryState` machine** (`shared/delivery-state.ts`). A message id
moves through four states:

| Transition | Meaning |
| --- | --- |
| `draw(callId, ids)` | dealt into a response under construction; blocks re-deal; **not** ack- or confirm-eligible |
| `promote(callId)` | that exact response was fully built and un-aborted → its draws become confirm-eligible, stamped with a new arrival generation |
| `rollback(callId)` | the request was aborted before the response could reach the model → draws return to re-dealable, nothing acked, nothing pruned |
| `markConfirmed(ids)` | a later call proved delivery → durable entry pruned and the broker ack enqueued |

Two invariants make this correct under concurrency, both of which were violated by earlier
implementations and are now regression-tested:

1. **Acks are enqueued only at confirm time, never at draw.** An unacked lease on an
   undelivered message is the broker's re-offer safety net. Acking at draw meant a
   concurrent flush could ack mail a cancelled call never delivered.
2. **Arrival-causality barrier.** Every request snapshots `newArrival()` at *request entry*
   — before any pre-read wait — and may only confirm presentations promoted before that
   snapshot. Without it, a call parked for minutes in `wait_for_peer_messages` could
   outlive a sibling's `promote` and wrongly confirm it, since "the next call" is
   meaningless once tool calls run in parallel.

**Serialization**: the read-draw-mark critical section runs under a per-process mutex
(`withPiggybackLock`). Because that lock is not reentrant, the broker poll is split into
`fetchBrokerLeases()` (pure HTTP, unlocked) and `applyLeasedToQueue()` (classification and
upsert, always under the lock). Code already holding the lock calls the two halves directly;
routing it through the wrapper could await a background poll queued on the same lock and
deadlock.

**Per-harness surfaces**:

| Harness | How the model sees mail | Durable store |
| --- | --- | --- |
| Codex | `[PEER INBOX]` block prepended to the next tool result (piggyback); optional `wait_for_peer_messages` (≤300s); wake daemon for idle sessions | `~/.agent-peers-codex/<uuid>.json` |
| Claude Code | Live channel push while active, plus `check_messages` as the authoritative read (ring buffer for the last 15 min **unioned with all unread durable mail at any age**) | `~/.agent-peers-claude/<uuid>.json` |
| Hermes | Bounded polling only, waits capped at 60s; `check_messages` canonical | `~/.agent-peers-hermes/<uuid>.json` |

---

## 6. Broker ownership

launchd is the **only** legitimate owner of port 7900 in production. Clients never spawn the
broker: `ensureBroker()` runs `launchctl kickstart` and polls a readiness callback for up to
15s. The legacy self-spawn path survives only behind `AGENT_PEERS_SPAWN_BROKER=1` and pins
the child environment so a session's `PEER_NAME`/`cwd` can never define a machine-global
daemon.

Readiness is **authenticated and fail-closed**. A bare `/health` 200 proves only that
something answers on the port; it is never sufficient. `createReadinessProbe` requires:

- a readable secret (no secret → not ready, full stop — there is no `/health` bootstrap
  window a squatter could answer);
- `GET /ready` returning `ok:true` and `protocol:1`;
- `owner === "launchd"`, or exactly `owner === "client"` under `AGENT_PEERS_SPAWN_BROKER=1`;
- a **present and matching** `db_id`.

Bootstrap still converges without the `/health` fallback: not-ready triggers kickstart, the
real broker provisions the secret, and the probe re-reads the secret on every poll.

`BROKER_EPOCH` is stamped on register/heartbeat responses so clients can distinguish "the
broker restarted" from "I was evicted for cause".

---

## 7. Deliberate non-goals

- **Cross-machine federation is designed but NOT built** (owner decision, 2026-08-09). The
  full design lives in `docs/plans/cross-machine-federation-tailscale.md` and is tracked by
  bead bd-21r.8. Only zero-cost groundwork shipped: a globally unique `message_uid` and a
  nullable `host` column. There is no relay, no sync daemon, and no `scope=fleet`. Two
  machines coordinate today by their human/agent operators, not by the broker.
- **No exactly-once delivery.** See §5.
- **No authentication on the protection endpoint.** It is spare-only liveness attestation
  for an external process reaper; adding auth would widen the shared secret's trust boundary
  for no gain.

---

## 8. Where to start reading

| If you want to… | Read |
| --- | --- |
| Change delivery/ack semantics | `docs/delivery-contract.md`, then `shared/delivery-state.ts` and its test |
| Change the broker schema or endpoints | `docs/components/broker.md` §2-3 |
| Debug "an agent isn't receiving mail" | `docs/components/cli-ops-tests.md` (CLI reference), then `cli.ts inboxes --stranded` |
| Understand Codex idle wake | `docs/wakeable-codex.md`, then `docs/components/wake-subsystem.md` |
| Know what's broken | `docs/IMPROVEMENT-REPORT.md` |
