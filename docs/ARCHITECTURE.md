# Architecture

System design of `agent-peers-mcp` as of `9be6159` (2026-11-02), the accepted four-machine v3
baseline. Truth-from-code: the statements below were read out of the source, not from intent.
Section 5 (the delivery pipeline) is unchanged since the August verification at `63503f2`:
`shared/delivery-state.ts` and `shared/piggyback.ts` have no commits since then.

Statements about what is switched on right now (which hosts, which profiles) are marked
**Live state**. They were true on 2026-11-02, they are not guarantees of the code, and they will
drift.

---

## 1. The one-paragraph version

`agent-peers-mcp` lets AI coding agents in separate terminals and apps discover each other and
exchange messages. It now spans **four machines**: a MacBook and a Mac Studio (macOS, launchd) and
two Linux boxes (`systemd --user`). Each runs its **own broker** (loopback HTTP plus its own
SQLite database), and each broker stays authoritative for its own peers and mail. **Federation**
lets the brokers address each other over Tailscale: `name@host` reaches a peer on another machine
and the destination broker queues the mail. An agent session loads an **MCP server** for its
harness (five peer types: Claude Code, Codex, Hermes, Factory Droid, OpenClaw), which registers a
peer, polls the broker, and surfaces mail to the model. Peers are found by **persona** (`marco`)
or exact name, and one Hermes agent's individual chats can be addressed (`ezra-hermes/<chat
title>`). Because most harnesses cannot be pushed into, a **wake subsystem** starts a turn on an
idle session when mail arrives, with a different mechanism per harness (§7). Everything stays on
loopback and the tailnet; there is no cloud component and no API key in the message path.

---

## 2. Component map

| Component | Files | Runs as | Doc |
| --- | --- | --- | --- |
| Broker daemon | `broker.ts`, `shared/ensure-broker.ts`, `shared/shared-secret.ts` | One per machine: launchd (macOS) or `systemd --user` (Linux) | [components/broker.md](components/broker.md) |
| Addressing and chat mail | `shared/peer-address.ts`, `shared/broker-addressing.ts`, `shared/chat-directory.ts`, `shared/chat-list.ts` | Inside the broker | §4 |
| Federation | `shared/federation.ts`, `shared/federation-config.ts` | Inside the broker; off unless `AGENT_PEERS_FEDERATION=1` | [components/federation.md](components/federation.md) |
| Linux deployment | `deploy/linux/` (`install.sh`, broker and wake units) | systemd user services | [components/linux-brokers.md](components/linux-brokers.md) |
| MCP servers + delivery | `claude-server.ts`, `codex-server.ts`, thin entry points `hermes-server.ts`, `droid-server.ts`, `openclaw-server.ts`; `shared/delivery-state.ts`, `shared/codex-inbox.ts`, `shared/piggyback.ts`, `shared/hermes-claims.ts`, `shared/paperclip-guard.ts` | One per agent session | [components/mcp-servers-delivery.md](components/mcp-servers-delivery.md) |
| Codex wake | `wake-daemon.ts`, `wakeable-codex.ts`, `bin/codex-peer`, `shared/wake-*.ts`, `shared/app-server-client.ts`, `shared/codex-desktop-wake.ts` | One daemon per machine; one app-server per launcher-started session | [components/wake-subsystem.md](components/wake-subsystem.md), [wakeable-codex.md](wakeable-codex.md), [wake-daemon.md](wake-daemon.md) |
| Claude wake | `shared/claude-socket-wake.ts`, `bin/claude-peer-rewake` | Inside `claude-server.ts`; one hook process per desktop-app session | §7 |
| Droid launcher and wake | `wakeable-droid.ts`, `bin/droidpeer`, `shared/droid-*.ts` | One launcher per Droid session | [wakeable-droid.md](wakeable-droid.md) |
| Hermes chat wake | `shared/hermes-wake-pass.ts`, `shared/hermes-chat-wake.ts` | A pass inside the wake daemon | §7 |
| Hermes Desktop wake plugin | `hermes-plugins/agent-peers-desktop-wake/` | Python plugin inside the Hermes Desktop backend | [components/hermes-desktop-wake.md](components/hermes-desktop-wake.md) |
| OpenClaw peer | `openclaw-server.ts`, `shared/openclaw-*.ts` | A child per OpenClaw session thread, plus a pass inside the wake daemon | [components/openclaw-peer.md](components/openclaw-peer.md) |
| Operations CLI | `cli.ts` | On demand | [components/cli-ops-tests.md](components/cli-ops-tests.md) |

Contracts that span components: [delivery-contract.md](delivery-contract.md) is the normative
delivery guarantee, and **the document to read before changing delivery code**.
[plans/cross-machine-federation-tailscale.md](plans/cross-machine-federation-tailscale.md) is the
August federation design, kept as history (§8).

---

## 3. Runtime topology

Each of the four machines (`macbook`, `studio`, `omarchy`, `hetzner`) looks like this:

```
       service manager:  launchd  com.mike.agent-peers-broker   (macOS)
                         systemd --user  agent-peers-broker      (Linux)
                        ┌───────────────────────────────────────────┐
                        │  broker.ts --owner=launchd | systemd       │
                        │  127.0.0.1:7900   ~/.agent-peers.db (0600) │── /federation/* ──┐
                        └───────────────────────────────────────────┘   (Tailscale Serve) │
                              ▲             ▲              ▲                              ▼
             X-Agent-Peers-Secret (0600 file), loopback only             the other three brokers
                              │             │              │
        ┌─────────────────────┴──┐  ┌───────┴────────┐  ┌──┴──────────────────┐
        │ claude-server.ts       │  │ codex-server.ts│  │ hermes-, droid-,    │
        │ (per Claude session)   │  │ (per Codex     │  │ openclaw-server.ts: │
        │ channel / socket push  │  │  session)      │  │ thin entry points   │
        │ ring buffer + inbox    │  │ [PEER INBOX]   │  │ that load           │
        └────────────────────────┘  │ piggyback      │  │ codex-server.ts     │
                                    └───────┬────────┘  └──┬──────────────────┘
                                            │              │
                        ┌───────────────────┴──────────────┴─────┐
                        │ wake daemon (codex-peer daemon loop)    │
                        │ passes: Codex, Hermes chats, OpenClaw   │
                        └─────────────────────────────────────────┘
```

Peers on the other machines are never rows in this broker's `peers` table. Federation asks the
other brokers live (§6), and a machine-scope `list_peers` merges their answers into its own.

**Live state (2026-11-02).** All four brokers report ready on protocol 1 at `9be6159`, and every
host lists every other host's peers. The Macs follow the fork's `main` through the fleet
reconciler; the Linux hosts are fast-forwarded by hand.

**Trust boundary**: the local shared secret (`~/.agent-peers-secret`, 0600) and the DB file mode.
Any process running as the same user can read them, which is the accepted model: each box is a
single-user machine. The broker refuses to run if either file drifts off 0600 or changes owner.
Federation uses a **separate**, fleet-wide secret (`~/.agent-peers-federation-secret`, 0600), so
the local secret never leaves its machine.

---

## 4. Identity and addressing

This is the part most often misunderstood, so it is stated explicitly.

### Sessions, names and durability

- **One session = one peer = one UUID.** Every running agent session registers its own row.
  Several sessions of "the same" agent may run in one repo, and each is an independent peer.
- **Names are a separate, exclusive layer.** A durable name is owned by exactly one peer at a time.
  A second session requesting a taken name is suffix-laddered (`vector-2`), not rejected.
- **Default names are `persona-repository-harness`**, for example
  `vector-agentic-coding-resources-codex` or `marco-imekka-director-ops-droid`. The persona comes
  from the repository's `AGENTS.md`; with none, the name falls back to `repository-harness`.
  Names are up to 96 characters and never UUID-shaped.
- **Durability is explicit**: durable registration requires `PEER_NAME` and
  `AGENT_PEERS_EPHEMERAL != "1"`. Ephemeral rows age out about 60s after the process dies;
  durable rows survive restarts and keep their mailbox.
- **Registration is case-sensitive** (`vector` and `Vector` are different names, bd-21r.11), but
  *addressing* is forgiving (next subsection).
- **Hermes runs one durable peer per profile.** The surfaces of a profile load the MCP with the
  same `PEER_NAME` and race a file-lock election (`shared/hermes-claims.ts`). The winner registers
  durable; losers register ephemeral under generated names. General mail to the durable name is
  read only by the winner; a loser's general polls read its own ephemeral mailbox, while its
  chat-scoped polls resolve the durable owner's mailbox (`resolvePollScope` in
  `shared/broker-addressing.ts`). The winner is whichever surface claims the name first; it is the
  gateway only in a deployment where the Desktop and WebUI backends run with
  `AGENT_PEERS_HERMES_ROLE=member`, which keeps every tool but never takes the durable name (the
  Studio is configured this way). Duplicate ephemeral rows beside a durable one are election
  losers, not a bug. `AGENT_PEERS_HERMES_ROLE=passive` makes one surface inert.

### Addressing

An address is `name[@host][/chat]` (`shared/peer-address.ts`), and the broker resolves it, so old
clients get the behavior after a broker restart. Precedence, most exact first
(`shared/broker-addressing.ts`): peer UUID, chat route UUID, exact name, case-insensitive exact
name among deliverable peers, then a **persona** or leading name tokens (`marco`). Several matches
never guess: the sender gets the exact names back and nothing is queued.

`name@host` is exact and goes through federation. A bare name resolves locally first, and only an
unknown peer triggers remote discovery; an ambiguous or uncertain answer needs an explicit
address (details in [components/federation.md](components/federation.md)).

### Chat mail

A Hermes agent holds many chats, and one agent-peers process serves all of them. With chat mail
on (the default for Hermes; `AGENT_PEERS_HERMES_CHAT_MAIL=0` turns it off), messages carry
`to_chat` and `from_chat`, each mail call names the chat it reads, and mail for one chat is never
drawn or confirmed by a call from another. A call without a chat reads the profile's **general
mailbox**.

A chat address matches an exact title (case-insensitive) or an exact session ID. A near miss wakes
nothing and returns candidates. `list_chats` lists a Hermes agent's chats, across machines too
(`ezra-hermes@studio/<chat key>`). Replies route back to the sending chat through a stable chat
route UUID. The chat directory reads each profile's Hermes `state.db` read-only
(`shared/hermes-chat-wake.ts`).

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
| `markConfirmed(ids)` | a later call proved delivery → durable entry pruned and (Codex, Hermes, Droid, OpenClaw) the broker ack enqueued |

Claude differs at the broker: `claude-server.ts` persists each message to its inbox file and
acks the broker in the same poll, before the model sees it. A Claude broker ack therefore proves
persistence, not model confirmation; Claude's confirmation is the later removal of the entry from
its local store after a fully built `check_messages`. The invariants below describe the Codex-family
path.

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

**Per-harness surfaces** (the full per-harness guarantees are in
[delivery-contract.md](delivery-contract.md)):

| Peer type | How the model sees mail | Durable store |
| --- | --- | --- |
| Codex | `[PEER INBOX]` block prepended to the next tool result (piggyback); optional `wait_for_peer_messages` (up to 300s); the wake daemon starts or steers a turn for idle or busy sessions | `~/.agent-peers-codex/<uuid>.json` |
| Claude Code | Live channel push, or an inbox-socket wake, while the session is reachable, plus `check_messages` as the authoritative read (ring buffer for the last 15 minutes **unioned with all unread durable mail at any age**) | `~/.agent-peers-claude/<uuid>.json` |
| Hermes | Bounded polling only, waits capped at 60s; `check_messages` canonical. With chat mail on, every call reads one chat's partition (§4) | `~/.agent-peers-hermes/<uuid>.json` |
| Factory Droid | Shared durable piggyback delivery; `droidpeer` wakes an idle managed session with a bodyless prompt | `~/.agent-peers-droid/<uuid>.json` |
| OpenClaw | The Hermes polling transport (waits capped at 60s); the wake pass submits a followup turn into the agent's main session | `~/.agent-peers-openclaw/<uuid>.json` |

State directories can be moved with `AGENT_PEERS_STATE_DIR` or a per-runtime
`AGENT_PEERS_<RUNTIME>_STATE_DIR` (`shared/state-dir.ts`).

---

## 6. Broker ownership and federation

### Ownership

The service manager is the **only** legitimate owner of port 7900 in production: launchd on
macOS, `systemd --user` on Linux (`deploy/linux/`; see [components/linux-brokers.md](components/linux-brokers.md)).
Clients never spawn the broker. `ensureBroker()` starts the service (`launchctl kickstart`, or
`systemctl --user start agent-peers-broker` on Linux) and polls a readiness callback for up to
15s. The legacy self-spawn path survives only behind `AGENT_PEERS_SPAWN_BROKER=1` and pins the
child environment so a session's `PEER_NAME` or `cwd` can never define a machine-global daemon.

Readiness is **authenticated and fail-closed**. A bare `/health` 200 proves only that something
answers on the port; it is never sufficient. `createReadinessProbe` requires:

- a readable secret (no secret means not ready, with no `/health` bootstrap window a squatter
  could answer);
- `GET /ready` returning `ok:true` and `protocol:1`;
- `owner` equal to `launchd` or `systemd`, or exactly `client` under `AGENT_PEERS_SPAWN_BROKER=1`;
- a **present and matching** `db_id` (the first 12 hex characters of a hash of the resolved DB
  path).

`/ready` also lists `capabilities` (for example `chat-mail` and `federation`). v3 features are
advertised there and never by bumping `protocol`, which old clients compare for equality.
`BROKER_EPOCH` is stamped on register and heartbeat responses so clients can tell "the broker
restarted" from "I was evicted for cause".

### Federation

Federation is **built and live**; the August plan that deferred it is history. Each broker keeps
its own database and stays authoritative for its own peers. There is no shared database, no
replicated peer table and no central broker.

- It is off unless `AGENT_PEERS_FEDERATION=1`. A missing or unusable config logs and leaves local
  service untouched (`startFederation` in `broker.ts`).
- Three files in the home directory configure it: `~/.agent-peers-host` (this machine's alias),
  `~/.agent-peers-fleet.json` (alias to Tailscale Serve base URL) and
  `~/.agent-peers-federation-secret`.
- Only the `/federation/` mount is exposed to the tailnet. It answers `health`, `directory`,
  `chats` and `relay`, authenticated by the federation secret and a host header; the local secret
  is not accepted there.
- A remote `send_message` is a synchronous enqueue into a durable outbox, so success means
  **queued**, not delivered or seen. A worker relays with exponential retry, and the destination
  dedupes on the globally unique `message_uid`. A destination that refuses an envelope it cannot
  parse produces a bounce notice to the sender instead of a retry loop.
- Discovery is live: `list_peers`, `list_chats` and bare-name sends ask the other brokers at
  request time.

The contract, tables, Serve recipe and rollback are in [components/federation.md](components/federation.md).

---

## 7. Wake paths

A message queued for an idle agent does nothing until something starts a turn. The wake subsystem
does that, with a different mechanism per harness. Every wake is **bodyless**: it names senders or
message ids and tells the agent to call `check_messages`. The mail itself is read and confirmed
through the normal MCP path, so a wake that fails or repeats loses and duplicates nothing.

The machine-wide **wake daemon** (`wake-daemon.ts`, looped by `bin/codex-peer daemon`) runs three
independent passes per tick: Codex, Hermes chats, OpenClaw. A failure in one never affects the
others. The repository starts it on demand: any `bin/codex-peer` launch auto-starts the daemon if it is
not running. A fleet can also run it as a service: Mike's Macs have the LaunchAgent
`com.mike.agent-peers-wake` (`codex-peer daemon 5`, installed by the fleet, not by this repo; see
[wake-daemon.md](wake-daemon.md)), and on Linux `agent-peers-wake.service` runs it. `droidpeer` hosts its own wake loop and does
not use the daemon.

| Peer type | How an idle session is woken | Gate or opt-in |
| --- | --- | --- |
| Codex, launcher-started | The daemon reads the thread status from the session's own app-server. An idle thread gets `turn/start` on the exact live thread; a working thread is **steered** (`turn/steer` appends the wake to the running turn), so mail reaches a busy chat too. Repeats back off 5m, 30m, 2h per unread set. | Session launched through `bin/codex-peer` |
| Codex desktop chat over SSH | The chat runs under the host's Codex app-server, reached through a unix socket. On its first agent-peers tool call the MCP binds to the host-supplied thread id, finds its parent's socket, validates the thread, and registers `ws+unix://` with the wake registry. A chat with no attach point (remote-control relay) stays non-wakeable. | Automatic discovery in `shared/codex-desktop-wake.ts` |
| Claude Code, channel | Mail is pushed live as a channel notification. | Launched with `--dangerously-load-development-channels server:agent-peers` (the `agentpeers` alias) |
| Claude Code, inbox socket | `claude-server.ts` posts a bodyless notice to the session's own inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`). Mail is persisted and acked at the broker before the notice goes out. | Chosen by `chooseWakeMode`; `AGENT_PEERS_SOCKET_WAKE=0` turns it off |
| Claude desktop app | Desktop sessions (including remote-SSH ones) join by default and have no channel. `bin/claude-peer-rewake` runs as an async-rewake Stop hook and exits 2 naming only new senders, which wakes the idle session. Socket wake is off for the desktop app unless `AGENT_PEERS_SOCKET_WAKE=1`. | The hook must be installed in Claude settings (see the top-level README) |
| Factory Droid | `droidpeer` hosts the session (native TUI relay, or a headless ACP host) and watches the peer's unread metadata. An idle session gets a fixed bodyless prompt. | Wakeable only when launched through `droidpeer` ([wakeable-droid.md](wakeable-droid.md)) |
| Hermes, chat in the gateway | The Hermes pass asks the broker's `/chat-inbox` which chats have unread mail and hands each to `shared/hermes-chat-wake.ts`, which runs `hermes -p <profile> chat --resume <session> -q`. To process general-mailbox mail it resumes the profile's "Agent Peers" chat. A chat open in Desktop is not touched: the driver waits. | Built but off until a profile is listed in `~/.agent-peers-hermes/chat-wake/enabled`; none is, by Mike's choice (2026-11-02) |
| Hermes, chat open in Desktop | A plugin inside the Desktop backend calls Hermes's `ctx.inject_message`. An idle chat starts a turn; a busy one only queues. It shares the driver's per-chat ledgers and settles only on correlated turn evidence. Unknown evidence blocks re-wakes of that chat until `bun cli.ts hermes-desktop-clear <profile> <chat-key> [--handled]`. | A `chat-wake/desktop-enabled` line per profile and chat, plus the profile's `allow_gateway_injection` ([components/hermes-desktop-wake.md](components/hermes-desktop-wake.md)) |
| OpenClaw | The OpenClaw pass submits a followup `chat.send` turn (`deliver:false`) into `agent:<id>:main` through the OpenClaw Gateway CLI. Every submission is recorded in a fail-closed custody ledger, and the wake pauses on any state it cannot prove. | Agent id listed in `~/.agent-peers-openclaw/wake/enabled` ([components/openclaw-peer.md](components/openclaw-peer.md)) |

Kill switches, and what each one reaches:
- `~/.agent-peers-hermes/disabled`: the Hermes MCP reads it at startup or reload (a running
  surface keeps serving until then); the Desktop plugin checks it live, before every wake; the
  gateway driver ignores it. To stop the driver, remove the profile from `chat-wake/enabled`.
- `AGENT_PEERS_HERMES_ROLE=passive`: one Hermes surface starts inert.
- `~/.agent-peers-openclaw/disabled`: loaded OpenClaw children refuse on their next call, and
  passes and binds stop.
Removing a profile or agent from its enable file stops wakes; mail stays queued.

**Live state (2026-11-02).** The gateway driver for closed Hermes chats is built but switched off: no `chat-wake/enabled` file exists on the Studio, so mail to a closed chat waits in its partition until the chat reads it. Only chats open in Hermes Desktop are woken today, by the plugin, which is on by default for the `default`, `ezra`,
`marco` and `valentina` profiles in the Studio Desktop backend, through one `<profile> *` line
each in `desktop-enabled`. The general mailbox is not Desktop-woken. OpenClaw wake is on for one
agent (`claude`, peer `alex-openclaw-hetzner`) on the Hetzner box. Recovery after an idle unload,
a lost response and compaction is not yet demonstrated; the OpenClaw doc keeps the evidence table.

---

## 8. Deliberate non-goals

- **No exactly-once delivery.** See §5.
- **No authentication on the protection endpoint.** It is spare-only liveness attestation for an
  external process reaper; adding auth would widen the shared secret's trust boundary for no gain.
- **No central or replicated state across machines.** Federation moves mail and answers live
  queries; it never copies peers from one broker into another. The August design
  (`docs/plans/cross-machine-federation-tailscale.md`) is history; the as-built contract is
  `components/federation.md`.
- **Client machines are not fleet members.** The fleet map lists the four fleet machines only; a
  client's machine is never added to it ([components/federation.md](components/federation.md)).

---

## 9. Where to start reading

| If you want to… | Read |
| --- | --- |
| Change delivery/ack semantics | `docs/delivery-contract.md`, then `shared/delivery-state.ts` and its test |
| Change the broker schema or endpoints | `docs/components/broker.md`, then the `migrate_v3_addressing` migration and the federation tables in `broker.ts` and `shared/federation.ts` |
| Change addressing or chat mail | `shared/peer-address.ts`, `shared/broker-addressing.ts`, `tests/broker-v3-addressing.test.ts` |
| Work on federation | `docs/components/federation.md`, `shared/federation.ts` |
| Add or repair a Linux broker | `docs/components/linux-brokers.md` |
| Debug "an agent isn't receiving mail" | `bun cli.ts inboxes --stranded` and `bun cli.ts wake-status`, then `bun cli.ts --help` |
| Understand Codex idle wake | `docs/wakeable-codex.md`, then `docs/components/wake-subsystem.md` |
| Understand a Hermes or OpenClaw wake | `docs/components/hermes-desktop-wake.md`, `docs/components/openclaw-peer.md`, `shared/hermes-chat-wake.ts` |
| Know what was wrong in August | `docs/IMPROVEMENT-REPORT.md` (a dated snapshot) |
