# agent-peers-mcp

### Your Claude Code, Codex CLI, Hermes Agent, Factory Droid, and OpenClaw agents, working as colleagues.

Run Claude, Codex, Hermes, Factory Droid, or OpenClaw agents in separate terminals or desktop apps and they **discover each other**, **message each other**, and **take initiative**. Codex finds something Claude should know → it pings Claude. Droid changes an interface Codex depends on → it pings Codex before the build breaks. No cloud. No API keys between them. Each machine runs a tiny SQLite broker on localhost, and with federation switched on, machines on your Tailscale network can reach each other's agents too.
```
  Terminal 1 (Claude)           Terminal 2 (Codex)           Terminal 3 (Claude)
  ┌──────────────────┐          ┌──────────────────┐         ┌──────────────────┐
  │ "Send to peer    │────────> │ ← [PEER INBOX]   │         │ ← <channel push> │
  │  backend-codex:  │          │  respond via     │<────────│  "can you check  │
  │  what's the DB   │          │  send_message    │         │   the auth bug?" │
  │  schema?"        │<─────────│                  │         │                  │
  └──────────────────┘          └──────────────────┘         └──────────────────┘
                 \\                    |                          /
                  \\                   v                         /
                   └───── broker on localhost:7900 ─────────────┘
                              (SQLite + HTTP daemon)
```

> Hardened, security-reviewed successor to [louislva/claude-peers-mcp](https://github.com/louislva/claude-peers-mcp) with Codex CLI, Hermes, Factory Droid, and OpenClaw support, cross-machine federation, and a full colleague-behavior protocol added.

---

## What collaboration actually looks like

Imagine you're merging two projects each AI has been working on alone. With this installed, the flow looks like this:

> **You (to Claude):** "Start merging Project A into the monorepo. Ask `codex-backend` anything you need."
>
> **Claude** reads A's auth module, notices it uses `bcrypt@4`, wants to know what B is on. Sends:
> > `to codex-backend:` "A's on bcrypt 4. What version is B on?"
>
> **Codex** receives it mid-task. Doesn't auto-reply "got it" (it's trained not to). Goes quiet, looks at B's `package.json`. Sees `bcrypt@5`. *Also* notices B bakes `tenant_id` into JWTs — remembers Claude will break multi-tenancy if those get dropped. Sends back:
> > `to claude-frontend:` "B is on bcrypt 5, and we bake `tenant_id` into the JWT — if the merged project drops that claim, multi-tenancy in B breaks. Want me to extract the claims schema to a shared module?"
>
> **Claude** now has a real answer + a surfaced risk + a concrete next step. Replies:
> > `to codex-backend:` "Yes please. Use `shared/auth/claims.ts`. I'll rewire A once you push."

Brief. Substantive. Initiative on both sides. No spam. That's the whole pitch.

---
## What you get

| | |
|---|---|
| 🧠 → 🧠 **Claude ↔ Claude** | Sessions launched with `agentpeers` get messages mid-task through Claude's native `claude/channel` push, instantly while a turn is running, and on current Claude Code builds also at an idle prompt (observed 2026-11-02; older builds queued idle pushes until the next turn's `check_messages`). Claude sessions without the channel, including the desktop app, are woken from idle when mail arrives (see [Claude sessions without the channel](#claude-sessions-without-the-channel-desktop-app)). |
| 🤖 → 🤖 / 🧠 → 🤖 **Claude ↔ Codex** | Stock Codex CLI has no mid-task push channel for MCP servers, so a plain `codex` session picks up peer messages on its next agent-peers tool call. Its shared instructions tell it to call `check_messages` at the start of every user turn, which bounds delivery latency to one user turn. A durable on-disk inbox at `~/.agent-peers-codex/<peer-id>.json` (0o600) means Codex never loses a message, even across a restart. A Codex session launched through `codex-peer`, or opened as a Codex desktop chat, is also **woken from idle**, and mail for a chat that is mid-task is appended to its running turn ([details](#wakeable-codex-peers-idle-wake-no-fork)). |
| 🪽 **Hermes ↔ any peer** | Hermes registers as a first-class `hermes` peer through `hermes-server.ts`: one durable peer per profile (for example `ezra-hermes`), with the same durable polling and authoritative `[PEER INBOX]` delivery used by Codex. Mail can be addressed to a single Hermes chat (`ezra-hermes/Instagram ads`). A chat open in Hermes Desktop can be woken by a plugin, and a closed chat by a gateway driver; both are opt-in and off until you enable them ([details](#hermes-chats-mail-and-wake)). |
| 🏭 **Factory Droid ↔ any peer** | `droidpeer` opens Factory's native Droid terminal UI as a managed `droid` peer. When mail arrives while Droid is idle, the launcher starts a turn with a bodyless wake prompt, and Droid retrieves the real message through `check_messages`. Ordinary `droid` sessions are not wakeable. |
| 🦞 **OpenClaw ↔ any peer** | An OpenClaw agent joins as an `openclaw` peer through an MCP server entry, and mail can wake its main session ([details](#openclaw)). |
| 🌐 **Across machines** | With federation on, `name@host` addresses an agent on another machine, and `list_peers` and `list_chats` show remote agents too. Each machine stays authoritative for its own peers and mail ([details](#across-machines-federation)). |
| 👥 **Colleague behavior protocol** | Shared prompt imported by every MCP server: don't auto-reply "got it", investigate before answering, push back on disagreement, ping proactively when you find something the other peer cares about, close every loop. |
| 🏷️ **Friendly names** | Default names are `persona-repository-harness`, such as `vector-agentic-coding-resources-codex`, or set `PEER_NAME=frontend-tab` for a stable one. Your terminal tab renames itself so you can tell sessions apart at a glance. Peers can rename themselves mid-session. |
| 🔍 **Scoped discovery** | `list_peers` with scope `machine` / `directory` / `repo`, optionally filtered by `peer_type`. Live peers display newest-first, but agents pause and choose by task/status fit rather than grabbing the first row. `Started` remains distinct from the liveness `Heartbeat`. |
| 🔐 **Per-user auth** | Session token per peer, per-user shared secret, DB + WAL sidecars + secret file all at 0o600 with a fail-closed startup check. Another local user can't eavesdrop on your peer traffic. |
| 📬 **At-least-once delivery** | 30s lease → confirm-on-next-call ack. A dropped MCP response leaves the message on disk + leased at the broker and re-surfaces. Never silently lost. Unreachable recipient → message becomes an orphan, visible via `cli.ts orphaned-messages`. |
| ♻️ **Reclaim-safe restart** | Kill a session and relaunch with the same `PEER_NAME` within 60s → broker reclaims the UUID *and* clears stale leases. Backlog lands on the new session's first poll. |

---

## Install

**Ownership split (applies to install, update, AND uninstall).** The repo folder, `node_modules`, the broker daemon, and the SQLite DB at `~/.agent-peers.db` are **shared** between every agent on this machine. Claude owns all that shared state. Codex owns only its own `~/.codex/config.toml` entry. If you run prompts from both agents concurrently without this split, they'll race on `git clone`, `bun install`, `rm -rf`, and broker kill — real risk of corrupted install. Hermes, Droid, and OpenClaw have no install prompt; you wire them by hand once the repo is cloned (see [Usage](#usage)).

**Pick your case — exact steps differ:**

| Your setup | What to run | Order |
|---|---|---|
| 🧠 **Claude only** (no Codex) | Claude install prompt | 1 step |
| 🧠 **+** 🤖 **Both Claude and Codex** | Claude install prompt, then Codex wire-only prompt | Claude FIRST (sets up shared repo), then Codex (writes config.toml only) |
| 🤖 **Codex only** (no Claude) | Manual clone, then Codex wire-only prompt | 1. Shell: `git clone https://github.com/Co-Messi/agent-peers-mcp.git ~/agent-peers-mcp && cd ~/agent-peers-mcp && bun install` — 2. Paste the Codex wire-only prompt |

> **Why Claude-first when you have both:** the Codex wire-only prompt refuses to proceed if it can't find the already-cloned repo + deps. It will not `git clone` or `bun install`, because those are Claude's to own.

> **What the Codex wire-only prompt does:** reads `~/Github Repos/agent-peers-mcp` or `~/agent-peers-mcp` to find the existing install, then appends a single `[mcp_servers.agent-peers]` block to `~/.codex/config.toml`. That's the entire write. It does NOT touch the broker, DB, shared secret, or any file outside `~/.codex/config.toml`.

> **Install the broker service too.** The prompts below wire the agents, but a broker has to be running before any of them can join. See [The broker](#the-broker).

---

<details>
<summary><b>🧠 For Claude Code — primary install</b> (clones repo, installs deps, wires Claude) — <i>click to expand</i></summary>

Open a Claude Code session and paste this verbatim:

````
Install https://github.com/Co-Messi/agent-peers-mcp for me.

First, fetch its README from that repo URL and read it so you understand what the project is and why I want it installed.

Then do all of the following:

1. Clone the repo to a sensible location on my machine (prefer `~/Github Repos/agent-peers-mcp` if that parent directory exists, otherwise `~/agent-peers-mcp`). Remember the absolute path as $AGENT_PEERS_DIR.

2. cd into $AGENT_PEERS_DIR and run `bun install`.

3. Register the MCP globally for Claude Code by running:
   claude mcp add --scope user --transport stdio agent-peers -- bun "$AGENT_PEERS_DIR/claude-server.ts"

4. Append the launcher alias to ~/.zshrc (skip if it's already there — don't duplicate).

   CRITICAL — the alias MUST start with `AGENT_PEERS_ENABLED=1`. Without that env flag, the MCP server runs in no-op mode (no tools, no broker, no tab title) so the peer network stays dormant. The whole point of the alias is to set this flag only when launching `agentpeers`, leaving plain `claude` untouched:
   alias agentpeers='AGENT_PEERS_ENABLED=1 claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers'

5. Tell me the install is done and I should:
   - `source ~/.zshrc` (or open a new terminal)
   - Launch another tab with `PEER_NAME=my-name agentpeers`
   - Make sure a broker service is installed, or `AGENT_PEERS_SPAWN_BROKER=1` is set for a solo dev box (the README's "The broker" section explains which)
   - Ask the new session to "list all peers on this machine"
   - If I also want Codex wired up, paste the Codex wire-only install prompt from this repo's README into a Codex session.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

<details>
<summary><b>🤖 For Codex — wire-only install</b> (assumes the shared repo is already cloned) — <i>click to expand</i></summary>

Open a Codex session and paste this verbatim:

````
Wire the agent-peers MCP into my Codex config for me.

CRITICAL — this is a WIRE-ONLY install. The shared agent-peers-mcp repo (node_modules, the broker, the DB at ~/.agent-peers.db) is owned by the Claude Code install prompt (or by me if I cloned manually). You must NOT:
  - clone the repo
  - run `bun install`
  - modify any file outside ~/.codex/config.toml
  - kill or start the broker daemon
  - touch ~/.agent-peers.db or ~/.agent-peers-secret

Doing any of those would race against the Claude Code side and can corrupt the shared install. Your only job in this prompt is to write one block into ~/.codex/config.toml. That's it.

Do the following:

1. Locate the existing shared install. Try these paths in order:
     - ~/Github\ Repos/agent-peers-mcp
     - ~/agent-peers-mcp
     - otherwise ask me where I cloned it — do NOT proceed without an absolute path.
   Verify that $AGENT_PEERS_DIR/codex-server.ts exists. If it does not, STOP and tell me the shared install is missing — I need to run the Claude Code install prompt first, or clone the repo manually (the README has the one-liner).
   Remember the verified absolute path as $AGENT_PEERS_DIR.

2. Append this block to ~/.codex/config.toml (create the file if it doesn't exist; SKIP the write entirely if the [mcp_servers.agent-peers] section is already present — do NOT duplicate):
   [mcp_servers.agent-peers]
   command = "bun"
   args = ["$AGENT_PEERS_DIR/codex-server.ts"]
   env = { "AGENT_PEERS_ENABLED" = "1" }
   Substitute $AGENT_PEERS_DIR with the real absolute path before writing.

   CRITICAL — do NOT omit the `env = { "AGENT_PEERS_ENABLED" = "1" }` line. Without it, the Codex-side MCP server starts in no-op mode: zero tools exposed, no broker connection, and Codex will never see peer messages or appear in anyone's peer list. Setting this env flag to "1" is what activates the peer network.

3. Tell me the install is done and I should:
   - Open a new terminal and run `codex` — the MCP will load automatically
   - Optionally set `PEER_NAME=my-name` before launching for a stable name
   - Ask the new session to "list all peers on this machine"

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

---

## The broker

Every machine runs one broker on `localhost:7900`. **Clients never start it.** A session that finds no ready broker asks the service manager to start one, then waits up to 15 seconds. So a service has to exist:

- **Linux:** a `systemd --user` unit, `deploy/linux/agent-peers-broker.service`, plus `agent-peers-wake.service` for the wake daemon. `deploy/linux/install.sh <host-alias>` installs both. The shipped broker unit sets `AGENT_PEERS_FEDERATION=1` (a comment in the unit says to flip it to `0` for a standalone box), and `install.sh` stops unless the fleet map and federation secret from [Across machines](#across-machines-federation) already exist, so a standalone box installs the units by hand. Details: [`docs/components/linux-brokers.md`](docs/components/linux-brokers.md).
- **macOS:** a LaunchAgent labelled `com.mike.agent-peers-broker` that runs `bun broker.ts --owner=launchd` with `RunAtLoad` and `KeepAlive`. The label is fixed in `shared/ensure-broker.ts`, and clients start it with `launchctl kickstart`. The plist layout is in [`docs/components/broker.md`](docs/components/broker.md) (section 6, Entry Points).
- **Solo or dev box without a service:** set `AGENT_PEERS_SPAWN_BROKER=1`, and the first session spawns a client-owned broker. Clients accept a client-owned broker only when they have this variable set themselves, so it has to be in every client's environment: your shell for `agentpeers`, and the `env = { ... }` block of the Codex `config.toml` entry.

A client also checks `GET /ready` (sent with the shared secret) before it trusts a broker. It requires protocol `1`, a service owner (`launchd` or `systemd`, or `client` in dev mode), and the expected DB. A bare `/health` answer is not readiness.

---

## Usage

**Shortest possible path to seeing it work:** with a broker running, open two terminals, launch `agentpeers` in one and `codex` in the other, then ask one of them to `"list all peers on this machine"`. You're off.

### Hermes Agent

Configure the adapter once, then start Hermes:

```bash
hermes mcp add agent-peers \
  --command bun \
  --env AGENT_PEERS_ENABLED=1 \
  --args "$HOME/agent-peers-mcp/hermes-server.ts"
hermes mcp test agent-peers
```

To add the adapter to a conversation that is already running, reload MCP servers. In the Hermes CLI/TUI or a gateway chat, run `/reload-mcp`. **Hermes Desktop has no `/reload-mcp`.** In Desktop, toggle the Agent Peers connector off and on (Capabilities → Connectors). A reload is process-wide: it restarts the MCP for every chat that Desktop backend hosts.

For a durable identity, set `PEER_NAME` (for example `ezra-hermes`) in the profile's MCP environment. A profile can have several Hermes surfaces (gateway, Desktop, CLI) and they share that name through a lock: one surface holds the durable name, and the others register under generated ephemeral names. General mail sent to the durable name is read only by the surface that holds it; another surface's general polls read its own ephemeral mailbox. Chat mail is different: a surface reading a chat's mail resolves the durable owner's mailbox, so each chat sees its own mail wherever it runs. A Desktop or WebUI backend can set `AGENT_PEERS_HERMES_ROLE=member` to skip the election and never take the durable name.

Hermes can join after launch because it supports MCP reload. Codex wakeability is different: an idle Codex thread can only be woken when it was hosted by the app-server-backed launcher or is a Codex desktop chat. An existing stock Codex thread must be resumed through `codex-peer resume <session-id>`; no MCP reload can retrofit that process.

Per-chat mail and wake for Hermes are covered in [Hermes chats: mail and wake](#hermes-chats-mail-and-wake). Factory Droid and OpenClaw have their own sections below.

If you want more than that, here's the full flow:

### Step 1 — Launch

Open a new terminal and run the launcher for your agent:

| Agent | Command |
|---|---|
| **Claude Code** | `agentpeers` (the Claude desktop app joins without a launcher) |
| **Codex** | `codex` joins the network; `codex-peer` joins and is wakeable from idle |
| **Factory Droid** | `droidpeer` |
| **Hermes** | Start Hermes with the MCP configured as above |
| **OpenClaw** | The OpenClaw gateway loads the MCP entry ([setup](docs/components/openclaw-peer.md)) |

That's it — the MCP loads automatically and your terminal tab renames itself to `peer:<name>`. The broker is started by its service, not by the session (see [The broker](#the-broker)).

### Step 2 — Name it (optional but useful)

New default names include the persona declared in the repository's `AGENTS.md`, the repository, and the harness: `vector-agentic-coding-resources-codex`, `valentina-trophy-master-mind-claude`, or `marco-imekka-director-ops-droid`. The persona comes from a standalone line such as `You are **Vector**, ...` in the repository's primary `AGENTS.md`. If there is no unambiguous persona declaration, the default is `<repo>-<harness>`. For an explicit override, set `PEER_NAME` **before** launching:

```bash
PEER_NAME=frontend-tab agentpeers   # Claude
PEER_NAME=backend-work codex        # Codex
```

Rules: 1–96 chars, `[a-zA-Z0-9_-]`, excluding UUID-shaped names so names cannot be confused with peer IDs. Names are case-sensitive. Concurrent instances receive suffixes while retaining their persona/repository prefix. `Started` records working-session age; choose the newest matching live session when asked for the latest instance, and otherwise compare current task and CWD first. Heartbeat indicates liveness only.

A peer is durable (its name is retained across sessions) only when `PEER_NAME` is set, and `AGENT_PEERS_EPHEMERAL=1` forces ephemeral even then. Deriving a default name never makes a peer durable. A same-type peer can reclaim its name once the old row is stale or its same-host process is provably dead. Droid saves its actual allocated name and UUID, including a collision suffix or an MCP rename, for exact-session resume; other harnesses retain their configured-name resume behavior.

### Step 3 — Sanity check

With two sessions running, ask either of them:

> "List all peers on this machine"

You should see the other. Then:

> "Send a message to peer \<name\>: hello"

What happens on the receiving side:

- **Claude** (launched with `agentpeers`) sees it **instantly** if a turn is running, via a `<channel source="agent-peers">` push. No manual action. Observed 2026-11-02 on current Claude Code (2.1.30x), a push that arrives at an idle prompt also starts a turn; older builds queued it until the next turn, so sessions still call `check_messages` at the start of every turn.
- **Codex** has no mid-task MCP push, so a plain `codex` session sees the message on its **next agent-peers tool call**. The shared instructions tell Codex to call `check_messages` at the start of every user turn — so the worst-case lag is one of your turns, not "until Codex happens to think of it." You can also just type "check messages" to force it. A `codex-peer` session is woken without you typing anything.

### Step 4 — Real use

A few prompts that showcase what this is actually for:

**Hand off a specific task** →
> "Send to backend-work: I'm changing the auth interface in `auth.ts` — here's the new shape: `…`. Can you update the backend to match?"

**Ask a peer to review your work** →
> "Send to code-reviewer: review my last commit and tell me what's wrong. Be blunt."

**Find the right peer first** →
> "List all peers in this repo and tell me what each one is working on" — each peer keeps a 1-2 sentence `summary` up to date.

**Unblock on a cross-project question** →
> "Send to data-pipeline: what schema does `events` use for the `metadata` column — JSON or text? I need to know before I pick a migration strategy."

**Reach an agent on another machine, or one chat of a Hermes agent** →
> "Send to backend-work@studio: …" or "Send to valentina-hermes/Instagram ads: …" (federation is described [below](#across-machines-federation))

The colleague protocol handles the rest: the receiving peer investigates before replying, doesn't spam "got it," pushes back if you're proposing something that'll break their work, and pings you back when they have a real answer (or a real blocker).

---

## Shell CLI

Inspect and control the broker from a terminal (no agent session needed). Run these from inside the cloned `agent-peers-mcp/` directory; `bun cli.ts --help` prints the full list.

```bash
bun cli.ts status                        # Broker health, peer list, and wakeable-peer status
bun cli.ts peers                         # Peers only
bun cli.ts wake-status                   # Wakeable Codex and Droid peers: unread counts, true thread status (alias: live)
bun cli.ts send frontend-tab "ship it"   # Send a message from the shell (also name@host[/chat])
bun cli.ts rename calm-fox docs-writer   # Admin rename (operator action)
bun cli.ts retire docs-writer            # Remove a stale or confusing peer from discovery
bun cli.ts repair-wake <name>            # Re-attach a live Codex peer whose wake pointer was lost
bun cli.ts suggest-name <base>           # Print an unused peer name for <base>
bun cli.ts messages                      # Recent messages with lease state (reads the DB directly)
bun cli.ts orphaned-messages             # Messages to peers that died
bun cli.ts stranded-messages             # Unacked mail to peers idle for more than 24h
bun cli.ts inboxes [--stranded]          # Durable inbox files with unread counts; --stranded shows bodies in dead inboxes
bun cli.ts gc-inboxes [--apply] [--min-age-days N]   # Archive dead inbox files (dry run unless --apply, default age 7 days)
bun cli.ts hermes-desktop-clear <profile> <chat-key> [--handled]   # Release a blocked Desktop wake (see Hermes chats)
bun cli.ts openclaw status|bind|clear|rearm ...      # OpenClaw main-session wiring (see OpenClaw)
bun cli.ts kill-broker                   # Stop only the broker daemon (peers stay running)
```

Under a service manager, `kill-broker` just makes the service start a fresh broker.

---

## How it works

- **Broker daemon** (`broker.ts`) runs on `localhost:7900` with SQLite at `~/.agent-peers.db`. launchd or systemd starts it; sessions only ask the service to start (see [The broker](#the-broker)). DB + WAL sidecars are 0o600, per-user shared secret at `~/.agent-peers-secret` (also 0o600) authenticates peer HTTP calls.
- **Each session** spawns an MCP server (`claude-server.ts`, `codex-server.ts`, `hermes-server.ts`, `droid-server.ts`, or `openclaw-server.ts`) that registers with the broker and receives a rotating session token.
- **Claude sessions** poll the broker (every 1s while a conversation is live, every 3s when idle; `AGENT_PEERS_IDLE_POLL_MS`) and push inbound messages via `notifications/claude/channel` → Claude sees the message mid-task. Each message is written to a durable inbox under `~/.agent-peers-claude` before it is pushed.
- **Codex sessions** have no mid-task MCP push channel ([OpenAI Codex docs list `tools` as the only supported MCP feature](https://github.com/openai/codex/blob/main/docs/config.md) — resources, prompts, and `notifications/message` aren't surfaced). So Codex runs a two-layer delivery pipeline plus a prompt-level nudge:
  1. **Background poll (1s while active, 3s idle)** writes each new leased message to a durable on-disk inbox at `~/.agent-peers-codex/<peer-id>.json` (0o600 file, 0o700 dir, fail-closed perm check on read). Crash/restart safe.
  2. **Authoritative `[PEER INBOX]` block** is prepended to the NEXT agent-peers tool response. This is the **only** delivery path the Codex model sees. Full body, reply hints, sender metadata, per-message ids.
  3. **Prompt-level nudge:** the shared colleague instructions tell Codex to call `check_messages` at the start of every user turn. This bounds delivery latency to one user turn — the pragmatic answer to "Codex CLI doesn't support MCP push."
  4. **Signal-only `notifications/message` preview** also fires per poll tick — but current Codex CLI silently drops log notifications, so this is dormant future-compatible plumbing. When Codex adds MCP log surfacing, the preview will light up automatically.
- **Confirm-on-next-call dedupe.** Codex uses a two-set state machine: `presentedPendingConfirm` (drawn into current response, not yet known-delivered) + `seen` (confirmed delivered). Messages only transition to `seen` (+ get acked + get pruned from disk) at the START of the NEXT tool call, which proves the previous response cycle completed. Dropped MCP responses don't silently lose messages — they re-surface on the next call or after a session restart.
- **Shared colleague protocol.** The servers import the same `COLLEAGUE_PROTOCOL` string from `shared/colleague-prompt.ts`, so the agents can't drift on reactive/proactive/maintenance behavior.
- **Wakeable Droid sessions** are launched by `droidpeer`. In a terminal it owns `droid daemon --listen ipc` and relays the native Droid UI; with redirected input or output it hosts an ACP session (`droid exec --output-format acp`) instead. The MCP child persists inbound mail under `~/.agent-peers-droid`; bodyless metadata signals the launcher only after persistence. The launcher never embeds peer message content in its wake prompt.
- **Federation is a layer on the same broker.** With it on, the broker relays a message addressed `name@host` to the other machine's broker over HTTPS and answers discovery queries live. See [Across machines](#across-machines-federation).
- **Sessions gracefully restart.** If you SIGKILL a session and restart with the same `PEER_NAME` within 60s, the broker reclaims the same UUID AND clears stale leases for that peer so the new session sees any undelivered backlog on its first poll (instead of waiting 30s for leases to expire).

Read the full technical spec at [`docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md`](docs/superpowers/specs/2026-04-13-agent-peers-mcp-design.md).

Wider reading: [`docs/README.md`](docs/README.md) indexes the engineering reference, including [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and the normative [`docs/delivery-contract.md`](docs/delivery-contract.md).

---

## Claude sessions without the channel (desktop app)

Only a session launched with `--dangerously-load-development-channels server:agent-peers` (the `agentpeers` alias) gets channel push. Observed 2026-11-02 on current Claude Code (2.1.30x), a push that arrives at an idle prompt also starts a turn; older builds queued it until the next turn, so sessions still call `check_messages` at the start of every turn. Other Claude Code sessions still register and have the peer tools, and two mechanisms wake them when mail arrives. Either way the wake is a short notice naming the senders; `check_messages` stays the only place mail is read and confirmed.

- **Inbox socket (terminal sessions).** A session with the MCP enabled (`AGENT_PEERS_ENABLED=1`) but no channel is woken through Claude Code's own per-session inbox socket, which Claude Code exposes to the MCP as `CLAUDE_CODE_MESSAGING_SOCKET`. A busy session reads the notice between tool calls, and an idle one starts a turn. Claude Code's cross-session messaging settings can restrict this. `AGENT_PEERS_SOCKET_WAKE=0` turns it off.
- **Rewake hook (desktop app).** The Claude desktop app, including its remote-SSH sessions, starts Claude Code without the channel flag and has no setting that adds it. Desktop sessions join the network by default (`AGENT_PEERS_ENABLED=0` opts a session out) and skip the terminal tab title. They are woken by `bin/claude-peer-rewake`, which uses a documented hook feature: an `asyncRewake` command hook that exits with code 2 "wakes Claude immediately even when the session is idle" ([hooks reference](https://code.claude.com/docs/en/hooks), Run hooks in the background > Limitations). `AGENT_PEERS_SOCKET_WAKE=1` opts a desktop session in to socket wake instead.

Install the hook as a user-level `Stop` and `StopFailure` hook in `~/.claude/settings.json`, substituting the absolute path of your checkout. Merge these two entries into any existing `hooks` object rather than replacing it:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "<AGENT_PEERS_DIR>/bin/claude-peer-rewake", "asyncRewake": true, "timeout": 86400 } ] }
    ],
    "StopFailure": [
      { "hooks": [ { "type": "command", "command": "<AGENT_PEERS_DIR>/bin/claude-peer-rewake", "asyncRewake": true, "timeout": 86400 } ] }
    ]
  }
}
```

- After each turn, it waits in the background, one waiter per session. It finds its own peer exactly: the hook's Claude process, then that process's `claude-server.ts` child, which is `peers.pid` in the broker. It then watches the bodyless `~/.agent-peers-claude/<peer>.metadata.json`.
- When a message id it hasn't announced before appears, it exits 2 with the sender names and ids, and Claude calls `check_messages`. It never reads message bodies and never acks, so `check_messages` stays the only delivery path. Announced ids are kept in `~/.agent-peers-claude/rewake/` and pruned after a week.
- It exits 0 immediately in sessions that already have the channel (terminal `agentpeers`), in sessions whose MCP wakes them through the inbox socket, and in `-p` runs. It also exits when the session ends, when no peer row appears within a minute, or after about 24 hours idle. In that last case, the next turn re-arms it.
- Don't add it to `SessionStart`. In SDK mode (which the desktop app uses), an async `SessionStart` hook holds the session until the hook exits. A new session is armed once its first turn ends.

---

## Wakeable Codex peers (idle wake, no fork)

Stock Codex CLI can't be woken from idle by an MCP server — it only sees peer messages when it calls an agent-peers tool (see [Known behaviors](#known-behaviors)). **Wakeable mode** closes that gap for Codex **without forking the Codex binary**: launch Codex under a managed Codex app-server, register the live thread, and let a small background daemon nudge that exact thread to call `check_messages` when mail arrives. The nudge is a **bodyless prompt** — the message body is still only ever delivered through the normal `check_messages` tool response.

### Quick start

```bash
# one-time: link the helper onto your PATH
bun bin/codex-peer install      # symlinks ~/.local/bin/codex-peer

# launch a wakeable Codex peer in the current repo (auto-named like vector-agentic-coding-resources-codex)
codex-peer

# ...or any repo, with an explicit stable name
codex-peer start my-service ~/code/my-service

# resume an existing session and keep it wakeable on the peer network
codex-peer resume <session-id>
```

Every launch **auto-starts a single background wake daemon** (idempotent, pidfile-tracked, detached) — you never have to remember to run a watcher, and it comes back on its own on your next launch after a reboot.

The normal launch path is intentionally quiet and uses Codex's full-screen TUI.
Internal app-server output is written to a private bounded log under
`~/.agent-peers-codex/logs/`, and the session opens at a clean, empty prompt:
the rollout is materialized with `thread/name/set`, which persists it **without
running a model turn**, so there is no launcher plumbing to appear as chat. Set
`CODEX_PEER_VERBOSE=1` only when you want launcher status lines.

### How the wake works

1. `codex-peer` starts `codex app-server --listen ws://127.0.0.1:<port>` plus a visible `codex resume --remote <url> <thread>` TUI bound to one managed thread.
2. The agent-peers MCP child (running under the app-server) wins the launch's single-identity election, registers as a peer and, when mail arrives, writes **bodyless** metadata (sender id/name, timestamp — no body, no lease token) to `~/.agent-peers-codex/<peer>.metadata.json` next to the durable inbox.
3. The wake daemon polls that metadata plus a durable wake registry. For each peer with unread mail whose thread is **loaded and idle**, it sends one bodyless wake prompt into the same app-server thread. If the thread is **mid-turn**, the daemon appends the wake to the running turn instead (`turn/steer`), so a busy chat sees the mail without waiting for its task to end. A thread parked on an approval or user-input prompt is not woken until it resumes.
4. Codex calls `check_messages`; the authoritative `[PEER INBOX]` block on that tool response carries the real content. Then it returns to waiting.

It is the **same live instance** — same thread, same rollout, same visible TUI. It is never killed and restarted with fresh context.

### Codex desktop chats

A Codex desktop chat, such as one opened over SSH on a Mac that hosts Codex's app-server daemon, can be woken the same way without `codex-peer`. On its first agent-peers tool call the MCP binds to the thread id Codex supplies, finds the app-server socket its parent process holds, checks that the thread is loaded in that app-server, and registers it with the wake daemon. Discovery runs on macOS only. A chat with no such socket (for example a remote-control relay chat) stays non-wakeable.

### What it costs

- **Launching a peer costs zero model tokens and takes a few seconds.** Materializing
  the thread is a metadata write (`thread/name/set`), not a conversation. Before
  2026-08-06 every launch ran a throwaway model turn purely to force the rollout file
  onto disk and then deleted it — 5.3s–29.4s each time, plus tokens.
- **An idle wakeable peer with no mail spends zero model tokens.** The idle TUI runs no inference; the wake daemon's poll is local-only (metadata files + local WebSocket JSON-RPC to the app-server) and never calls the model. A model turn fires only when there is real unread mail.
- **Each wake re-bills the accumulated thread context** (turns are stateless), so wake cost grows with session age. Re-waking the *same* unread set backs off on an escalating schedule (5m → 30m → 2h) and then stops; a new message is a new signature and always wakes immediately. A thread that is waiting on an approval or user-input prompt is never nudged; see [`docs/wake-daemon.md`](docs/wake-daemon.md) for how each thread state is handled.

### Operating it

| Command | What it does |
|---|---|
| `codex-peer` | Start a wakeable peer in the cwd (auto-name) |
| `codex-peer start <name> <path>` | Start a wakeable peer with a stable name |
| `codex-peer resume <session-id>` | Resume an existing session as a wakeable peer |
| `codex-peer live` | Show wakeable sessions + unread counts |
| `codex-peer daemon-status` / `daemon-stop` | Inspect / stop the background daemon |
| `codex-peer daemon [seconds]` / `wake` | Run the wake loop in the foreground / run one wake pass |
| `codex-peer send <peer> <message>` | Send a message from the shell |
| `codex-peer repair-wake <name>` | Re-attach a live peer whose wake pointer was lost |
| `codex-peer retire <name>` | Remove a stale/confusing peer from discovery |

The same daemon also runs the Hermes chat-wake and OpenClaw passes (below), so run it (`codex-peer daemon`, or `agent-peers-wake.service` on Linux) even on a machine with no Codex peers if you use those. Full design, security model, and failure-mode notes: [`docs/wakeable-codex.md`](docs/wakeable-codex.md).

---

## Wakeable Factory Droid peers

`droidpeer` (alias `droid-peer`) opens Factory's native interactive Droid as a managed, wakeable peer. Human chat and peer wake use the same Factory session:

```bash
droidpeer                                    # current directory
droidpeer --resume <factory-session-id>      # an exact session
droidpeer start my-droid ~/code/my-service   # explicit name and directory
droidpeer resume <factory-session-id> [peer-name] [cwd]
```

When the durable inbox gains a message and the Droid turn is idle, the launcher sends a bodyless prompt telling Droid to call `check_messages`. If a turn is running or input is queued, the wake waits. With redirected input or output, or `--headless`, `droidpeer` hosts an ACP background session (`droid exec --output-format acp`) instead. The message body and broker acknowledgement remain governed by the normal MCP delivery state machine.

Managed sessions default to autonomy `high` (`--autonomy-level` or `DROID_PEER_AUTONOMY_LEVEL` override it), which removes routine approval stalls but not Factory's denylist, sandbox, or organization policy. Native resume keeps the saved directory, model, and reasoning settings.

The guarantee applies only to sessions launched through `droidpeer`. An arbitrary already-running `droid` TUI has no external session handle and cannot be made wakeable after launch. The native launcher relies on Factory's internal IPC, which was verified on Droid 0.213.0 and is not a documented stable interface, so re-run the native smoke test after a Droid upgrade. Run `bun cli.ts wake-status` to inspect broker, process, and wakeability state. See [`docs/wakeable-droid.md`](docs/wakeable-droid.md).

---

## Hermes chats: mail and wake

A Hermes agent can be addressed per chat, not just per profile.

- **Address a chat:** `name/<chat title or chat ID>`, for example `valentina-hermes/Instagram ads`. A title matches exactly (any letter case); a near miss returns candidates and sends nothing. The `list_chats` tool lists an agent's chats (titles and status only, never transcripts) and never wakes the agent. It also works across machines: `list_chats` with peer `ezra-hermes@studio`.
- **Replies and reading:** a Hermes chat passes `from_chat` to `send_message`, so replies come back to that chat, and passes `chat` to `check_messages`, so it reads and confirms only its own mail. Mail with no chat goes to the profile's general mailbox, which belongs to the agent rather than to any chat. Only the gateway driver (switched off, below) processes it in a chat: it resumes the profile's "Agent Peers" chat, created on first use. Chat mail is on for the Hermes adapter; `AGENT_PEERS_HERMES_CHAT_MAIL=0` turns it off.

**Waking a chat.** Mail to a chat can wake only that chat, with a bodyless prompt telling the agent to call `check_messages` for it. Two wakers exist, and which one applies depends on where the chat is. Neither does anything until you enable it (below), so by default mail waits for the agent's next `check_messages`:

| Chat state | Waker | How |
|---|---|---|
| Closed | The **gateway driver**, run by the wake daemon (`shared/hermes-chat-wake.ts`), available per profile and off until enabled | Runs `hermes -p <profile> chat --resume <session-id> -q "<wake text>"` |
| Open in Hermes Desktop | The **Desktop plugin** `hermes-plugins/agent-peers-desktop-wake`, running inside the Desktop backend | Calls Hermes's plugin API `ctx.inject_message`: an idle chat starts a turn, a busy chat only queues the wake and is never interrupted |

Hermes lets only one process hold a chat, so once enabled the gateway driver waits while a window has the chat open and wakes it within a tick after it closes. Without the Desktop plugin, mail to an open chat waits until the chat closes (or the agent calls `check_messages` itself). Both wakers share per-chat ledgers, so a chat is never woken by both.

**Enabling each waker (both are off by default):**

- **Gateway driver:** list the profile in `~/.agent-peers-hermes/chat-wake/enabled`, one profile per line (`#` comments allowed), and keep the wake daemon running (see the Codex section above). `AGENT_PEERS_HERMES_BIN` points at the `hermes` binary when it is not `~/.local/bin/hermes` or on `PATH`. Remove the line to stop wakes for that profile; mail stays queued.
- **Desktop plugin:** install it into the profile (link `hermes-plugins/agent-peers-desktop-wake` into the profile's `plugins/` directory, add it to `plugins.enabled`, and set `plugins.entries.agent-peers-desktop-wake.allow_gateway_injection: true`). Then create `~/.agent-peers-hermes/chat-wake/desktop-enabled` with one line per profile, either `<profile> *` (every chat of that profile) or `<profile> <chat-key>` (one chat). A bare profile name does nothing, and removing a line stops wakes for it. The adoption steps, including how to activate the plugin without disturbing a running backend, are in [`docs/components/hermes-desktop-wake.md`](docs/components/hermes-desktop-wake.md).

**If a chat stops waking.** The plugin never re-injects after an uncertain outcome, because a duplicate wake could repeat work. It blocks that chat until you look at it and run `bun cli.ts hermes-desktop-clear <profile> <chat-key>`. Add `--handled` when the wake did reach a turn, so its mail is not woken again. The gateway driver's status names a lock left by a dead process. A wake turn that fails still counts as handled (a known limitation tracked in the component doc), so the mail stays unread in the broker until `check_messages` reads it, and newer mail wakes the chat again.

**Kill switches.** Creating `~/.agent-peers-hermes/disabled` makes every Hermes MCP surface inert and stops the Desktop plugin. The MCP reads the file at startup, so a running chat applies it at its next MCP reload, while the plugin checks it every few seconds. `AGENT_PEERS_HERMES_ROLE=passive` makes one surface inert, and `AGENT_PEERS_WAKE_DISABLED=1` stops the Desktop plugin.

---

## OpenClaw

An OpenClaw agent joins as an `openclaw` peer. OpenClaw runs the MCP entry `openclaw-server.ts` (which loads `codex-server.ts` with `AGENT_PEERS_RUNTIME=openclaw`) inside the agent's Codex harness. OpenClaw starts one MCP child per session thread, so a gate binds the peer's mailbox to the agent's main session (`agent:<id>:main`) only. Every other session of that agent gets an inert MCP that cannot read or strand its mail. The entry's environment must carry `AGENT_PEERS_OPENCLAW_AGENT=<agent>` and `PEER_NAME=<name>`.

Mail wakes the main session with a follow-up message sent through the OpenClaw gateway. The wake carries a one-time token, not the mail, and the agent reads the mail with `check_messages`. Wake is off until the agent id is listed in `~/.agent-peers-openclaw/wake/enabled`. `bun cli.ts openclaw status|bind|clear|rearm` inspects and operates it, and `~/.agent-peers-openclaw/disabled` is the kill switch.

OpenClaw support is new. [`docs/components/openclaw-peer.md`](docs/components/openclaw-peer.md) separates what has been proven live from what is still open (recovery after a crash or a lost response, and outbound mail after an idle unload), and holds the setup and operating runbook. Read it before you adopt an agent.

---

## Across machines (federation)

Each machine keeps its own broker and database. Federation lets agents on different machines find and message each other without merging those databases. It is off by default.

- **Addressing.** `name@host[/chat]` names an exact agent on a host, such as `backend-work@studio` or `ezra-hermes@studio/Instagram ads`. A bare name resolves on this machine first. Only when no local peer matches does the broker ask the other machines, and if several match, or a machine that might hold another match is unreachable, you must give an explicit `name@host`. `list_peers` with scope `machine` also lists the other machines' peers (unreachable hosts are reported), and `list_chats` works across machines.
- **Who is authoritative.** Each machine stays authoritative for its own peers, mailboxes, and chats. No remote rows are copied into the local peer table; discovery is a live query.
- **What a send means.** A remote send returns when the message is *queued* for relay, not when it is delivered or seen. The destination inserts it once, even if the relay is retried. If the destination refuses it (unknown, stale, full, or ambiguous target), the sender gets a system notice in its mailbox.
- **Turning it on**, per machine: set `AGENT_PEERS_FEDERATION=1` in the broker's environment (its launchd or systemd definition), and create three files in the home directory. `~/.agent-peers-host` holds this machine's lowercase alias, such as `macbook`. `~/.agent-peers-fleet.json` maps every machine's alias to its HTTPS base URL. `~/.agent-peers-federation-secret` (mode 0600) holds one fleet-wide credential, separate from the local broker secret. Then expose only the broker's `/federation` path to your tailnet with Tailscale Serve.

The Serve commands, ports, access policy, and the contract are in [`docs/components/federation.md`](docs/components/federation.md). Setting up a Linux host is in [`docs/components/linux-brokers.md`](docs/components/linux-brokers.md).

---

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `AGENT_PEERS_ENABLED` | — | Must be `1` for a session's MCP to join the network (the `agentpeers` alias and the Codex `env` block set it). Hermes defaults it to `1`, and Claude desktop sessions join without it. `0` opts a session out |
| `AGENT_PEERS_PORT` | `7900` | Broker port |
| `AGENT_PEERS_DB` | `~/.agent-peers.db` | SQLite path |
| `AGENT_PEERS_SECRET_PATH` | `~/.agent-peers-secret` | Shared-secret file |
| `AGENT_PEERS_SPAWN_BROKER` | — | `1` lets clients spawn a client-owned broker, for a dev box with no service. Every client on the box needs it |
| `AGENT_PEERS_FEDERATION` | — | `1` turns on cross-machine federation in the broker (needs the files described [above](#across-machines-federation)) |
| `PEER_NAME` | persona-repo-harness | Explicit peer-name override (1-96 chars, `[a-zA-Z0-9_-]`, not a UUID). Setting it also makes the peer durable |
| `AGENT_PEERS_EPHEMERAL` | — | `1` registers a non-durable peer even when `PEER_NAME` is set |
| `AGENT_PEERS_STATE_DIR` | `~/.agent-peers-<runtime>` | Overrides the inbox and state directory for whichever runtime reads it (`claude`, `codex`, `droid`, `hermes`, `openclaw`) |
| `AGENT_PEERS_IDLE_POLL_MS` | `3000` | Poll interval when idle; sessions poll every 1s while a conversation is live |
| `AGENT_PEERS_HEARTBEAT_MS` | `15000` | Heartbeat interval |
| `OPENAI_API_KEY` | — | API key used only when `AGENT_PEERS_AUTO_SUMMARY=1` |
| `AGENT_PEERS_AUTO_SUMMARY` | `0` | Set to `1` to opt in to `gpt-5.4-nano` summaries. Only branch, file count/extensions, and presence of a Git root are sent; paths and filenames are excluded. |
| `AGENT_PEERS_DISABLE_TAB_TITLE` | — | Set to `1` to skip terminal tab title writing |
| `AGENT_PEERS_SOCKET_WAKE` | — | Claude only. `0` turns off inbox-socket wake; `1` opts a desktop-app session in to it |
| `AGENT_PEERS_HERMES_ROLE` | — | `passive` makes a Hermes surface inert. `member` keeps every tool but never takes the profile's durable name |
| `AGENT_PEERS_HERMES_CHAT_MAIL` | on | `0` turns off per-chat mail for the Hermes adapter |
| `AGENT_PEERS_HERMES_BIN` | `~/.local/bin/hermes`, else `hermes` | The `hermes` binary the gateway wake driver runs |
| `AGENT_PEERS_WAKE_DISABLED` | — | `1` stops the Hermes Desktop wake plugin |
| `AGENT_PEERS_CODEX_STATE_DIR` | `~/.agent-peers-codex` | Codex durable inbox + wake registry/daemon state dir |
| `AGENT_PEERS_DROID_STATE_DIR` | `~/.agent-peers-droid` | Droid durable inbox + launch state dir |
| `CODEX_PEER_DAEMON_INTERVAL` | `5` | Background wake daemon poll interval (seconds) |
| `CODEX_PEER_DAEMON_LOG_MAX_BYTES` | `5242880` | Size at which `wake-daemon.log` is rotated (copy-truncate) |
| `CODEX_PEER_DAEMON_LOG_KEEP` | `3` | Number of rotated wake-daemon logs to keep |
| `CODEX_PEER_APP_SERVER_LOG_MAX_BYTES` | `5242880` | Per-peer app-server log rotation size |
| `CODEX_PEER_APP_SERVER_LOG_KEEP` | `3` | Number of rotated per-peer app-server logs to keep |
| `CODEX_PEER_VERBOSE` | `0` | Set to `1` to show launcher status lines before the TUI |
| `AGENT_PEERS_WAKE_LAUNCH` | — | **Set by the launcher, not by you.** Marks every agent-peers MCP spawned by a wakeable launch's app-server so the duplicate-identity election can tell a secondary Codex thread from an ordinary `codex` session |

OpenClaw's variables are listed in [`docs/components/openclaw-peer.md`](docs/components/openclaw-peer.md). See [docs/wake-daemon.md](docs/wake-daemon.md) for wake-daemon operations: log format, the wedged-peer (`systemError`) signal, and tuning.

---

## Known behaviors

**One `codex-peer` launch = exactly one peer, even though Codex starts several MCPs.**
In `--remote` mode the app-server spawns the agent-peers MCP **once per Codex
thread** — a fork, a spawned subagent, a detached review and a cold resume each get
their own — and it keeps unsubscribed threads loaded for 30 minutes, so they
accumulate. Every one of those children used to register its own peer, which is
where names like `ccr-codex-3-2-2-2` came from, and worse: mail addressed to the
name could land in a twin the wake daemon wasn't watching and simply never arrive.
Children now elect a single root via the launch claim (atomic exclusive-create);
losers serve an empty MCP and take no identity. Plain `codex` sessions are
unaffected and still register normally — the launcher sets `AGENT_PEERS_WAKE_LAUNCH=1`
specifically so the two cases stay distinguishable. Details:
[`docs/wakeable-codex.md`](docs/wakeable-codex.md).

**Sessions started before this change keep their duplicates.** The election is
applied at launch, so already-running peers with `-2`/`-2-2` twins only clean up
when you close and relaunch them.

**Claude terminal sessions only activate peers when you launch via `agentpeers`.**
The `agentpeers` alias sets `AGENT_PEERS_ENABLED=1`. Plain `claude` does not, so the MCP loads in idle/no-op mode — no peer registration, no tab title change, no broker connection. This is intentional: the MCP is registered globally in `~/.claude.json`, so every `claude` session spawns it, and we don't want the peer network showing up in unrelated sessions. The Claude desktop app is the exception: it has no launcher, so its sessions join by default, and `AGENT_PEERS_ENABLED=0` opts one out.

**Codex always has peers active** (as long as you included `env = { "AGENT_PEERS_ENABLED" = "1" }` in your `config.toml` entry). If you want a Codex session without peers, remove or comment out that `env` line temporarily.

**Idle sessions only reply if they are wakeable. Otherwise they see messages on their next turn.**
An MCP server cannot start a turn on its own, so a session that nothing wakes processes peer messages **during turns**, not while idle at the prompt. If you send a message to a peer sitting at an empty prompt, it surfaces on the next user turn (when you type something, or ask them to "check messages"). Sessions with a wake path are the exception: `codex-peer` sessions and Codex desktop chats, `droidpeer` sessions, Hermes chats with wake enabled, OpenClaw agents with wake enabled, and Claude sessions without the channel (inbox socket or rewake hook). A Claude session that has the channel gets live push during a turn; on current Claude Code builds the push also wakes it at an idle prompt (observed 2026-11-02), while older builds queued it.

What we do to make the other case as painless as possible: **every agent is instructed to call `check_messages` at the start of every user turn.** So the worst-case lag is "one of your own user turns" — type "hi" or "what's new" to a quiet peer and any pending messages surface in their first response.

**`check_messages` works on BOTH agents and returns the same `[PEER INBOX]` framing.**
On Codex, it drains the durable on-disk queue. On Claude, it returns an in-memory ring buffer (last 15 min, max 50 messages) populated by the background channel-push loop, plus all unread mail in Claude's durable inbox. On either side, it's the reliable "give me my inbox" button. Just type "check messages" whenever you want to see what peers have sent.

**On Codex, the `notifications/message` preview is dormant.**
[OpenAI Codex CLI v0.120 docs](https://github.com/openai/codex/blob/main/docs/config.md) list `tools` as the only supported MCP feature — resources, prompts, and `notifications/message` are not surfaced to the model. We still emit the preview every poll tick as future-compatible plumbing. When a future Codex CLI adds MCP log-notification surfacing, it'll light up automatically with no code change. Today it's a no-op you can safely ignore.

**Tab title ("peer:calm-fox") is re-asserted every 1 second via OSC 0/1/2.**
Most terminals (iTerm2, Terminal.app, Ghostty, Warp) track the running foreground process and periodically overwrite the tab title with the binary name ("node" / "bun"). A one-shot OSC write at startup therefore decays. The MCP server runs a lightweight keepalive that writes OSC 0 (window+icon title), OSC 1 (icon/tab title — what iTerm2 uses for tabs), and OSC 2 (window title) every 1s so `peer:<name>` stays visible. If your terminal is configured with a hardcoded title source (e.g. iTerm2 "Profile → General → Title" overriding application writes), we can't win — set `AGENT_PEERS_DISABLE_TAB_TITLE=1` to opt out of the keepalive entirely.

**Closed tabs disappear from discovery within ~60 seconds, but the backlog isn't stranded.**
When you close a tab, the shell kills the session without graceful cleanup. `list_peers` filters stale peers out of this machine's results. With federation on, ordinary remote directory listings use the same 60-second heartbeat cutoff for both durable and ephemeral peers. Named lookups still resolve retained durable mailboxes, so exact-name sends and `list_chats` keep working while the recipient is offline; hiding a peer from discovery does not delete its row or mail. If you restart with the same `PEER_NAME` within 60-90s, the broker reclaims the same UUID AND clears any stale leases for that peer, so the new session picks up undelivered backlog on its first poll instead of waiting up to 30s for leases to expire. Codex additionally persists its durable inbox on disk, so messages sitting on a reclaimed session are replayed even if they were drawn but not yet confirmed delivered.

**Peer discovery distinguishes age from activity.**
`Started` is when the current MCP-backed working session began; relaunching the MCP or resuming an older conversation resets it. `Heartbeat` only proves that the peer is still live. Hermes may launch a temporary MCP helper on each turn, so the broker preserves the durable Hermes peer's original `Started` value instead of making every helper look like a brand-new agent. Before messaging, the shared instructions make the agent pause, identify why it needs a collaborator, and compare every plausible peer's CWD and Current status with that need. It chooses the strongest task match rather than the first row, using `Started` as a tie-breaker unless the user explicitly asks for the latest instance. Exact user-supplied targets still win, and a missing status or unfamiliar harness does not exclude a candidate.

**A losing Hermes surface reads its own general mailbox and owner-scoped chat mail.**
When several Hermes surfaces of one profile start (gateway, Desktop, CLI), one holds the durable name and the rest register under generated names such as `<workdir>-hermes-2`. A loser can send, but general mail addressed to the durable name goes to the surface that holds it. Which surface wins depends on start order, unless the Desktop and WebUI backends run as `member` (as on the Studio), which leaves the name to the gateway. A loser or member still reads its own chats' mail from the durable owner's mailbox. See [Hermes chats](#hermes-chats-mail-and-wake).

**Paperclip agents stay off the network.**
An agent running inside a Paperclip company is refused registration (`PAPERCLIP_AGENT_ID` or `PAPERCLIP_RUN_ID` in its environment, checked before `AGENT_PEERS_ENABLED`). It can't be listed, messaged, or woken, and it gets no peer tools. The two systems keep separate inboxes and chains of command on purpose.

---

## Troubleshooting

**"No other peers found"**
Make sure at least two sessions are running with the MCP loaded. Run `bun cli.ts status` from a third shell to confirm the broker sees them.

**"broker did not come up within 15s" or sessions can't join**
No broker service is installed or it can't start. Check `systemctl --user status agent-peers-broker` and `journalctl --user -u agent-peers-broker` on Linux, or `launchctl print gui/$(id -u)/com.mike.agent-peers-broker` and `~/Library/Logs/agent-peers-broker.log` on macOS. On a dev box with no service, set `AGENT_PEERS_SPAWN_BROKER=1` in every client's environment ([The broker](#the-broker)). A bare `/health` answer from something on port 7900 does not make it the broker: clients also check `/ready` for protocol 1, a service owner, and the matching DB.

**Broker port 7900 already in use**
Kill any old broker: `bun cli.ts kill-broker` (a service restarts it). If another process owns the port, set `AGENT_PEERS_PORT=7901` in your env.

**Codex doesn't see the inbox**
Ask it to call `list_peers` or `check_messages` — messages surface on any agent-peers tool response, not just specific ones. If you still don't see the `[PEER INBOX]` block, your Codex version may not render tool responses verbatim; file an issue with your Codex version.

**Upgraded from an older install and existing peers aren't working**
The broker migrates pre-session-token databases by dropping all legacy peer rows (they can't authenticate under the new scheme). Restart all your sessions to re-register. Any in-flight messages for the dropped peers are visible via `bun cli.ts orphaned-messages`.

**`codex-peer` fails with "Cannot rollback while a turn is in progress"**
Fixed on 2026-08-06 — upgrade. Materialization used to run a throwaway model turn and
then delete it with `thread/rollback`; because `turn/start` returns *before* the
thread reports itself busy, the delete could land inside the still-running turn
(reproduced in 1 of 6 launches). Materialization no longer runs a turn at all, so
there is nothing to roll back. `thread/rollback` is also deprecated in codex-cli
0.146.1.

**One repo shows several peers with compounding names (`name-2`, `name-3-2-2-2`)**
Fixed on 2026-08-06 — relaunch the affected sessions. The app-server spawns one
agent-peers MCP per Codex thread and each used to register separately; children now
elect a single root. Already-running sessions keep their duplicates until relaunched.
If you see this on a *fresh* launch, that is a real bug — check that the launcher
passed `AGENT_PEERS_WAKE_LAUNCH=1` (`ps eww` on the app-server).

**A remote peer is missing, or a send to `name@host` fails**
Check that federation is on for both brokers and that each machine's `~/.agent-peers-fleet.json` lists the other. `list_peers` reports unreachable hosts. A bare name that matches several peers, or that might also live on an unreachable machine, needs an explicit `name@host`. A refused credential (401) means the remote broker rejected the fleet credential, so check that `~/.agent-peers-federation-secret` is the same value on both machines. A remote send that returned means *queued*; if the destination rejects it, a system notice arrives in your mailbox. See [`docs/components/federation.md`](docs/components/federation.md).

**Hermes Desktop has no `/reload-mcp`**
Toggle the Agent Peers connector off and on (Capabilities → Connectors). Remember the reload is process-wide for every chat that backend hosts.

**A Hermes chat is not being woken**
Check that its profile is listed in `~/.agent-peers-hermes/chat-wake/enabled` (closed chats) or `~/.agent-peers-hermes/chat-wake/desktop-enabled` (chats open in Desktop), that the wake daemon is running, and that `~/.agent-peers-hermes/disabled` does not exist. If the Desktop wake status shows an unresolved attempt or a lock held by a dead pid, see [Hermes chats](#hermes-chats-mail-and-wake) and `bun cli.ts hermes-desktop-clear`.

**Running alongside upstream `claude-peers-mcp`**
They coexist cleanly on different ports (7900 vs 7899) and different MCP names (`agent-peers` vs `claude-peers`). You can use both simultaneously; they don't share state.

---

## Architecture

```
agent-peers-mcp/
├── broker.ts                                  # HTTP+SQLite daemon (7900, 0o600 DB, shared-secret auth, federation endpoints)
├── claude-server.ts                           # MCP server — claude/channel push, inbox-socket wake
├── codex-server.ts                            # MCP server — durable queue + signal-only preview + [PEER INBOX]; also loaded by the Hermes and OpenClaw entries
├── hermes-server.ts  droid-server.ts  openclaw-server.ts   # Entry points that set the runtime and load codex-server.ts
├── cli.ts                                     # Admin / inspection CLI (see Shell CLI)
├── bin/
│   ├── codex-peer                             # Wakeable Codex launcher + background wake daemon manager
│   ├── droidpeer  droid-peer                  # Wakeable Droid launcher (native TUI or headless ACP)
│   └── claude-peer-rewake                     # asyncRewake hook for Claude sessions without the channel
├── wakeable-codex.ts  wakeable-droid.ts       # Entries behind the launchers
├── wake-daemon.ts                             # Entry: one wake pass (Codex, Hermes chats, OpenClaw)
├── deploy/linux/                              # systemd --user units + install.sh for Linux brokers
├── hermes-plugins/agent-peers-desktop-wake/   # Hermes Desktop in-process wake plugin
├── shared/
│   ├── types.ts  broker-client.ts  ensure-broker.ts  shared-secret.ts   # API types, typed HTTP client, service start + readiness, secret
│   ├── federation.ts  federation-config.ts    # Cross-machine relay, discovery, fleet config
│   ├── peer-identity.ts  peer-address.ts  names.ts   # persona-repository-harness names, name@host/chat parsing
│   ├── piggyback.ts  codex-inbox.ts  delivery-state.ts   # [PEER INBOX] formatting, durable inbox + bodyless metadata, confirm-on-next-call
│   ├── wake-daemon.ts  wake-registry.ts  wake-launch-claims.ts  wake-launch-role.ts   # Codex wake engine, registry, launch handshake, single-identity election
│   ├── app-server-client.ts  wakeable-launcher.ts  codex-desktop-wake.ts   # Codex app-server client, launcher, desktop-chat wake
│   ├── claude-socket-wake.ts                  # Claude inbox-socket wake
│   ├── droid-*.ts                             # Droid launcher, native relay, ACP client, launch claims
│   ├── hermes-*.ts  chat-directory.ts  chat-list.ts   # Hermes chat addressing, name claims, chat wake driver and pass
│   ├── openclaw-*.ts                          # OpenClaw gate, state ledger, gateway calls, wake pass
│   ├── paperclip-guard.ts                     # Keeps Paperclip agents off the network
│   └── colleague-prompt.ts  peer-list.ts  tab-title.ts  summarize.ts   # Shared protocol text, discovery rendering, tab title, auto-summary
├── tests/                                     # bun test suite — broker, migration, federation, delivery, wake, Hermes, Droid, OpenClaw
├── docs/
│   ├── README.md  ARCHITECTURE.md  delivery-contract.md   # Index, system design, normative delivery guarantees
│   ├── components/                            # Per-component references: broker, federation, linux-brokers, hermes-desktop-wake, openclaw-peer, ...
│   ├── wakeable-codex.md  wakeable-droid.md  wake-daemon.md   # Wake design and operations
│   └── superpowers/ plans/                    # Original spec and historical design records
```

---

## Coexistence with upstream `claude-peers-mcp`

|  | upstream `claude-peers-mcp` | this `agent-peers-mcp` |
|---|---|---|
| Broker port | 7899 | 7900 |
| SQLite | `~/.claude-peers.db` | `~/.agent-peers.db` |
| MCP name | `claude-peers` | `agent-peers` |
| Alias | `claudedpeers` | `agentpeers` |
| Codex support | No | Yes |
| Session-token auth | No | Yes |
| Orphan observability | No | Yes |
| Self-rename tool | No | Yes |

Both can run simultaneously. They do not talk to each other — you'd run `claudedpeers` for the upstream network and `agentpeers` for this one.

---

## Delivery contract

**Within a single session** — deterministic dedupe by `message_id` via in-memory seen-set. Same message is never delivered twice while your process is alive.

**Across a process restart** that reclaims the same UUID (via `PEER_NAME` within the 60-90s GC window) — **at-least-once**. A message polled but not acked before a crash may be re-delivered once. Replies should be idempotent.

**When a recipient dies before delivery** — messages are preserved in the broker DB as **orphans**, visible via `bun cli.ts orphaned-messages`. Never silently lost.

**Across machines** — a remote `send_message` success means the message was *queued* for relay, not delivered or seen. The destination inserts it exactly once, and delivery to the model stays at-least-once as above.

**Peer-to-peer security** — every peer gets a session token on register. Wrong token → operation silently no-ops (heartbeat / set_summary / unregister) or explicitly rejects (send / poll / ack / rename). You cannot impersonate, drain, or rename another peer via the MCP. Federation between machines uses a separate fleet credential, never the local broker secret.

---

## Update (pull latest version)

**Same ownership split as Install.** Whoever owns the shared repo is responsible for pulling new code. Do NOT run the update prompt from both agents concurrently — they'll race on `git pull`, `bun install`, and broker kill.

**Pick your case:**

| Your setup | What to run | Result |
|---|---|---|
| 🧠 **Claude only** | Claude update prompt | Pulls repo, reinstalls deps, runs tests, restarts the broker, tells you to restart any running `agentpeers` sessions |
| 🧠 **+** 🤖 **Both** | Claude update prompt **only** (Claude owns the shared repo) | Pulls repo, reinstalls deps, runs tests, restarts the broker, tells you to restart BOTH `agentpeers` AND `codex` sessions |
| 🤖 **Codex only** | Codex-only update prompt | Pulls repo, reinstalls deps, runs tests, restarts the broker, tells you to restart Codex sessions |

> **If you run the Codex-only update prompt with Claude ALSO wired up**, it will detect the conflict (checks `~/.claude.json` for an `agent-peers` entry) and stop with a message telling you to run the Claude update prompt instead. This is a safety rail — do not override it.

> **Why is there no "Codex update after Claude update" step?** Codex doesn't own the repo in the mixed-agents case. Once Claude has pulled new code, Codex just needs to be relaunched so the new `codex-server.ts` loads into the new MCP process. That's "close the terminal and open a new one," not a prompt.

> **Other agents and other machines.** Hermes and Droid sessions also need a restart after an update (`droidpeer`: relaunch; Hermes: toggle the connector in Desktop, or `/reload-mcp` in a CLI or gateway chat). With federation, update each machine; on a Linux host, re-running `deploy/linux/install.sh` is the update path ([`docs/components/linux-brokers.md`](docs/components/linux-brokers.md)).

---

<details>
<summary><b>🧠 For Claude Code — update prompt</b> (the ONLY update prompt if you have both agents installed) — <i>click to expand</i></summary>

Open a Claude Code session and paste this verbatim:

````
Update agent-peers-mcp to the latest version on my machine.

Step 1 — find the install directory. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp, or elsewhere under my home directory. If you find more than one candidate, or you're uncertain, LIST the candidates and ASK me which one to update before proceeding. Do NOT modify anything until I confirm.

Once I confirm the path, do all of the following in order:

1. cd into the confirmed install directory.

2. Record the current commit SHA for rollback reference:
   `git rev-parse --short HEAD` — save the value so you can tell me later.

3. DIRTY WORKTREE CHECK — before any destructive git action:
   Run `git status --porcelain`. If it produces ANY output (modified, added, or untracked files), STOP. Show me the output and ask whether I want to: (a) stash my changes and proceed, (b) abort the update, or (c) blow the changes away with a hard reset. Do NOT proceed to step 4 until I answer.
   If `git status --porcelain` is empty, continue.

4. Pull the latest code. Prefer a fast-forward pull so accidental rebases or divergent local commits surface as an error rather than a silent clobber:
   `git fetch origin main && git pull --ff-only origin main`
   If that fails (e.g. because we chose "blow away changes" in step 4, or local commits diverged), fall back to `git reset --hard origin/main` — but only after explicit confirmation.

5. Refresh dependencies:
   `bun install`

6. Run the test suite as a sanity check:
   `bun test`
   If any test fails, STOP and show me the failure output — do NOT tell me the update is complete.

7. Restart the broker so it runs the new code, but only now that the tests pass: `bun cli.ts kill-broker`. A broker owned by launchd or systemd comes back on its own; on a dev box with `AGENT_PEERS_SPAWN_BROKER=1` the next session starts it. Confirm with `bun cli.ts status`.

8. Print a summary: old commit SHA, new commit SHA, the short-log between them (`git log --oneline <old>..HEAD`), and what tests passed.

9. Tell me to close and relaunch any running `agentpeers`, `codex`, and `droidpeer` sessions so the new MCP server code is loaded (in Hermes Desktop, toggle the Agent Peers connector; in a Hermes CLI or gateway chat, run `/reload-mcp`). Both agents share this repo, so both sets of sessions need to restart. Existing sessions keep running the OLD code until they restart.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

<details>
<summary><b>🤖 For Codex — update prompt</b> (Codex-only installs only — DO NOT run this if Claude Code is also wired up) — <i>click to expand</i></summary>

Open a Codex session and paste this verbatim. **Skip this entire section** if you have Claude Code installed — the Claude update prompt above already handles the shared repo for both agents.

````
Update agent-peers-mcp to the latest version on my machine.

CRITICAL — before starting, verify I am the sole installer of this MCP:

1. Check ~/.claude.json — if it has an entry with name "agent-peers" OR an mcpServers["agent-peers"] key, Claude Code is ALSO wired to this shared repo. STOP immediately and tell me: "Claude Code is also using this install. The shared repo update is Claude's job — paste the Claude Code update prompt from the README into a Claude session instead. Once Claude has updated, come back here and I'll just tell you to restart your Codex sessions." Do NOT proceed.

2. If ~/.claude.json has NO agent-peers entry (or the file doesn't exist), I am the sole installer. Continue.

Step 2 — find the install directory. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp, or elsewhere under my home directory. If you find more than one candidate, or you're uncertain, LIST the candidates and ASK me which one to update before proceeding. Do NOT modify anything until I confirm.

Once I confirm the path, do all of the following in order:

1. cd into the confirmed install directory.

2. Record the current commit SHA for rollback reference:
   `git rev-parse --short HEAD` — save the value so you can tell me later.

3. DIRTY WORKTREE CHECK — before any destructive git action:
   Run `git status --porcelain`. If it produces ANY output (modified, added, or untracked files), STOP. Show me the output and ask whether I want to: (a) stash my changes and proceed, (b) abort the update, or (c) blow the changes away with a hard reset. Do NOT proceed until I answer.
   If `git status --porcelain` is empty, continue.

4. Pull the latest code with a fast-forward pull:
   `git fetch origin main && git pull --ff-only origin main`
   If that fails, fall back to `git reset --hard origin/main` — but only after explicit confirmation.

5. Refresh dependencies: `bun install`

6. Run the test suite as a sanity check: `bun test`
   If any test fails, STOP and show me the failure output — do NOT tell me the update is complete.

7. Restart the broker so it runs the new code, but only now that the tests pass: `bun cli.ts kill-broker`. A broker owned by launchd or systemd comes back on its own; on a dev box with `AGENT_PEERS_SPAWN_BROKER=1` the next session starts it. Confirm with `bun cli.ts status`.

8. Print a summary: old commit SHA, new commit SHA, the short-log between them (`git log --oneline <old>..HEAD`), and what tests passed.

9. Tell me to close and relaunch any running Codex sessions so the new MCP server code is loaded.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

---

## Uninstall

**Same ownership split, but reversed order vs install.** Why? When you're tearing down, you want Codex to STOP trying to launch the MCP binary *before* Claude deletes that binary. Otherwise every new `codex` session you open after uninstall will error on startup looking for a file that's gone.

**Pick your case:**

| Your setup | What to run | Order + why |
|---|---|---|
| 🧠 **Claude only** | Claude uninstall prompt | 1 step — it removes Claude's MCP registration, the `agentpeers` alias, the shared repo, the broker and its service, and all `~/.agent-peers*` state files. |
| 🧠 **+** 🤖 **Both** | Codex uninstall prompt **first**, then Claude uninstall prompt | **Codex FIRST** so Codex stops trying to spawn `codex-server.ts` on every new session. Codex's uninstall auto-detects the two-agent case and does a **config-only** teardown (removes only the `~/.codex/config.toml` block, leaves the shared repo alone). Then Claude's uninstall tears down the shared repo, broker, DB, alias, secret file, and Codex's durable inbox directory. |
| 🤖 **Codex only** | Codex uninstall prompt | 1 step — Codex's uninstall auto-detects the solo case (no `agent-peers` entry in `~/.claude.json`) and does a **full** teardown: removes its `config.toml` block AND the shared repo, broker, DB, secret, and inbox directory. |

> **Why the Codex prompt auto-branches instead of being two different prompts:** one prompt handles all three cases reliably by reading `~/.claude.json` up-front to figure out whether shared state is Claude's to clean up or Codex's. If it finds Claude wired, it does "Case A" (config-only). If it doesn't, "Case B" (full teardown). This keeps the README short and prevents the user picking the wrong prompt.

> **Why Claude uninstall checks Codex's config.toml:** it looks for a lingering `[mcp_servers.agent-peers]` entry and warns you before deleting the shared repo. It does NOT auto-edit `~/.codex/config.toml` — that's Codex's prompt's job. The warning is there so you don't end up with a dangling Codex wiring pointing at a deleted binary.

---

<details>
<summary><b>🤖 For Codex — uninstall prompt</b> (run this FIRST if you have both agents installed) — <i>click to expand</i></summary>

Open a Codex session and paste this verbatim:

````
Remove the agent-peers MCP wiring from my Codex config. I may or may not still want Claude Code to keep using the shared repo — detect which and act accordingly.

Do NOT wipe anything until you've done this detection step:

1. Check ~/.claude.json for an "agent-peers" MCP entry (either a top-level `agent-peers` block or an mcpServers["agent-peers"] key). Tell me explicitly which case we're in:
   - CASE A — Claude Code is also wired up: I'm doing a config-only teardown on the Codex side. The shared repo, node_modules, broker, and DB are staying — they belong to Claude Code. My only job is to remove my Codex wiring.
   - CASE B — Claude Code is NOT wired up (or ~/.claude.json doesn't exist / has no agent-peers entry): I'm the sole installer, so I will do a FULL teardown — config, shared repo, and broker state.

Ask me to confirm which case applies before touching anything. If I confirm CASE A, proceed with steps 2-3 below. If CASE B, proceed with steps 2-6.

STEP 2 (both cases) — Remove the [mcp_servers.agent-peers] block from ~/.codex/config.toml. Keep every other mcp_servers entry and every other section intact. If you are not 100% certain you can surgically edit TOML, FIRST show me the exact block you intend to remove and ask me to confirm before writing.

STEP 3 (CASE A only) — Summarize: tell me "Codex wiring removed. Shared repo at <path> and DB at ~/.agent-peers* are Claude Code's to own — if you want those gone too, run the Claude Code uninstall prompt from the README next." Stop here.

STEP 4 (CASE B only) — Stop the wake daemon and the broker:
   - From inside the repo directory, run `bin/codex-peer daemon-stop`.
   - If a broker service is installed (macOS LaunchAgent `com.mike.agent-peers-broker`; on Linux `agent-peers-broker.service` and `agent-peers-wake.service`), stop and remove it first, or it will restart the broker. On Linux: `systemctl --user disable --now agent-peers-wake.service agent-peers-broker.service`.
   - Run `bun cli.ts kill-broker` from inside the repo directory for any broker that is still running.

STEP 5 (CASE B only) — Find and delete the shared repo. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp. If you find more than one or are uncertain, LIST candidates and ASK me before deleting. Remove recursively.

STEP 6 (CASE B only) — Delete all broker state files in my home directory:
   rm -f ~/.agent-peers.db ~/.agent-peers.db-shm ~/.agent-peers.db-wal ~/.agent-peers-secret ~/.agent-peers-host ~/.agent-peers-fleet.json ~/.agent-peers-federation-secret ~/.local/bin/codex-peer
   rm -rf ~/.agent-peers-codex ~/.agent-peers-claude ~/.agent-peers-droid ~/.agent-peers-hermes ~/.agent-peers-openclaw
   (The federation files and the `codex-peer` symlink may not exist; missing paths are fine.) Run `ls -la ~/.agent-peers* 2>/dev/null || echo 'clean'` to confirm nothing is left.

STEP 7 (CASE B only) — Summarize: list every path/resource you removed and paste the `ls -la ~/.agent-peers* 2>/dev/null || echo 'clean'` output so I can verify.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

<details>
<summary><b>🧠 For Claude Code — uninstall prompt</b> (tears down the shared repo + broker + DB) — <i>click to expand</i></summary>

Open a Claude Code session and paste this verbatim. **If you also had Codex wired up**, run the Codex uninstall prompt above first so Codex stops trying to launch the server.

````
Completely uninstall agent-peers-mcp for me — I want every trace gone from the Claude side + the shared state.

Step 1 — find the install directory. Likely locations: ~/Github Repos/agent-peers-mcp, ~/agent-peers-mcp, or elsewhere under my home directory. If you find more than one candidate, or you're uncertain, LIST the candidates and ASK me which one to remove before proceeding. Do NOT delete anything until I confirm.

Step 2 — Codex coexistence check. Read ~/.codex/config.toml. If it still contains a [mcp_servers.agent-peers] block, WARN me: "Codex is still wired to this MCP — after I remove the shared repo, Codex will fail to start any new session until you also remove its [mcp_servers.agent-peers] block (run the Codex uninstall prompt). Want me to continue anyway?" Do not auto-edit Codex's config — that's its own prompt's job.

Once I confirm the path (and any warnings), do a FULL wipe — do not ask per-item confirmations; just do everything:

1. Stop the wake daemon and any running broker:
   - From inside the confirmed repo directory, run `bin/codex-peer daemon-stop`.
   - If a broker service is installed (macOS LaunchAgent `com.mike.agent-peers-broker`; on Linux `agent-peers-broker.service` and `agent-peers-wake.service`), stop and remove it first, or it will restart the broker. On Linux: `systemctl --user disable --now agent-peers-wake.service agent-peers-broker.service`.
   - Run `bun cli.ts kill-broker` from inside the repo directory for any broker that is still running.

2. Unregister the MCP from Claude Code:
   claude mcp remove agent-peers
   If I installed the `claude-peer-rewake` hook, remove its entries from the `Stop` and `StopFailure` hooks in ~/.claude/settings.json. If I wired Hermes, Droid, or OpenClaw, tell me which of their MCP entries or plugin links remain; those are not yours to edit without asking.

3. Remove the launcher alias from ~/.zshrc. The line looks like:
   alias agentpeers='AGENT_PEERS_ENABLED=1 claude --dangerously-skip-permissions --dangerously-load-development-channels server:agent-peers'
   Delete that line (and any surrounding "# agent-peers-mcp" comment). Leave every other line in ~/.zshrc untouched.

4. Delete the cloned repo directory (the exact path I confirmed in Step 1) — remove recursively.

5. Delete ALL broker and inbox state files under my home directory:
   - ~/.agent-peers.db, ~/.agent-peers.db-shm, ~/.agent-peers.db-wal
   - ~/.agent-peers-secret
   - ~/.agent-peers-codex/, ~/.agent-peers-claude/, ~/.agent-peers-droid/, ~/.agent-peers-hermes/, ~/.agent-peers-openclaw/ (directories, recursive — durable inboxes and wake state)
   - ~/.agent-peers-host, ~/.agent-peers-fleet.json, ~/.agent-peers-federation-secret (federation files, if present)
   - ~/.local/bin/codex-peer (symlink, if present)
   Use `rm -f` for the files and `rm -rf` for the directories so missing paths don't error. Also run `ls -la ~/.agent-peers* 2>/dev/null` afterwards to confirm nothing is left.

6. Tell me to run `source ~/.zshrc` (or open a new terminal) so the alias change takes effect.

7. Give me a final summary listing every path and resource you removed, plus anything you couldn't remove and why. Also paste the output of `ls -la ~/.agent-peers* 2>/dev/null || echo 'clean'` so I can see it's fully gone. If I had Codex wired up and I haven't run the Codex uninstall prompt yet, remind me to do that now.

Confirm each step's outcome as you go. If any step fails, stop and ask me how to proceed — don't silently move on.
````

</details>

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [Claude Code](https://claude.ai/code) v2.1.80+ (for channel push)
- [OpenAI Codex CLI](https://github.com/openai/codex-cli) (for the Codex side)
- Optional, per agent: Hermes Agent, Factory Droid (`droid`), OpenClaw
- Optional, for federation: [Tailscale](https://tailscale.com) on every machine
- macOS or Linux. The broker and wake daemon run on both (Linux under `systemd --user`, see [`docs/components/linux-brokers.md`](docs/components/linux-brokers.md)); Codex desktop-chat wake discovery is macOS only.

---

## License

MIT. See `LICENSE`.

---

## Contributing

Issues and PRs welcome at https://github.com/Co-Messi/agent-peers-mcp.

If you want to propose a change, please read `docs/superpowers/specs/` first — the full design rationale and rejected alternatives are documented there.
