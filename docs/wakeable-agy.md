# Wakeable Antigravity peers

Verified 2026-11-20 on the MacBook with `agy` 1.5.13 (ACP server 1.5.13) on a
Google AI Pro login. Checked against `wakeable-agy.ts`, `shared/agy-profile.ts`,
`shared/droid-acp-client.ts`, `shared/droid-launcher.ts` and `cli.ts`.

## Guarantee

`agypeer` hosts a headless Antigravity session (`agy acp`) as a wakeable
Agent Peer of type `antigravity`. When a peer message arrives while the session
is idle, the launcher starts a turn with a bodyless wake prompt. Antigravity
then reads the actual message by calling the Agent Peers `check_messages` MCP
tool, and replies with `send_message`.

`agypeer` is always headless. Antigravity has no IPC relay like Droid's native
launcher, so you talk to an `agypeer` session through Agent Peers. Your own
interactive `agy` is untouched and stays non-wakeable.

## Account and policy

Mike chose to run `agypeer` on his Google AI Pro login on 2026-11-20 and
accepted the risk Google describes. The Antigravity FAQ says wrapping `agy`
inside third-party agents "is not supported under consumer plans". Google
staff say enforcement suspends Antigravity and Gemini CLI access, not the whole
Google account. Source notes are in the fleet repo at
`intel-vault/tools/ecosystems/antigravity/README.md`.

## Launch and resume

```bash
agypeer                                   # current directory, default name
agypeer start [peer-name] [cwd]
agypeer start reviewer ~/code/service --thinking medium
agypeer resume <session-id> [peer-name] [cwd]
```

| Option | Meaning |
|---|---|
| `--model ID` | Model for a new session. Default `gemini-4-neon` (env `AGY_PEER_MODEL`) |
| `--thinking LEVEL` | `low`, `medium`, `high` or `xhigh`. Default `high` (env `AGY_PEER_THINKING`) |
| `--mode MODE` | `default`, `accept-edits`, `auto` or `plan`. Default `auto` (env `AGY_PEER_MODE`) |
| `--name NAME` | Override the `<persona>-<repo>-antigravity` default name |
| `--cwd`, `-C DIR` | Working directory, default the current directory |
| `--agy PATH` | `agy` executable, default a `PATH` lookup |
| `--poll-ms MS` | Inbox metadata poll interval, default 1000 |
| `--claim-timeout-ms MS` | How long to wait for the MCP child to bind, default 15000 |

On start, `agypeer` prints:

```
antigravity_peer:
  name: vector-agentic-coding-resources-antigravity
  peer_id: <uuid>
  session_id: <antigravity session id>
  status: wakeable
```

Antigravity exposes the model and thinking level as separate ACP config
options (`model` and `thought_level`). Its model ids are base names such as
`gemini-4-neon`, `gemini-4-argon`, `claude-opus-5-5` and `gemini-3.8-flash`.
`agy models` lists the combined names (`gemini-4-neon-high`). Those belong to
the older model list and are not what `agypeer` sets.

`resume` uses ACP `session/resume` on the exact session id. It restores the
saved peer name, peer UUID and working directory, and drains mail that queued
while the host was down. A resumed session keeps its own model unless you pass
`--model` or `--thinking`. The mode is set on every start and resume.

### Signed-out machines

Before anything starts, `agypeer` runs `agy models`. A machine without an
Antigravity login exits with:

```
error: Antigravity is signed out on this machine; run `agy` once in a terminal to sign in, then retry
```

Sign in by running `agy` once in a terminal on that machine. Don't copy
credential files between machines.

## Permissions, and what `auto` allows

Nobody is present to answer a permission request, so the host answers them
itself:

- It allows the six Agent Peers tools (`list_peers`, `send_message`,
  `set_summary`, `check_messages`, `wait_for_peer_messages`, `rename_peer`),
  one call at a time. Antigravity names MCP tools `mcp_<server>_<tool>`, so the
  host matches `mcp_agent-peers_<tool>` on the request's `toolCall.name`.
- It cancels every other permission request. Elicitation is declined, and
  client methods such as terminal or filesystem access are refused.

What Antigravity asks about depends on the mode. **`auto` (the default) asks
very little.** In the 2026-11-20 tests, `auto` ran each of these without a
permission request:

- `rm -rf` on a directory inside the workspace;
- `rm -rf` on a directory outside the workspace, under `/tmp`;
- `git push --force` to a remote.

Antigravity asks permission for MCP tools even in `auto`, because its internal
`agy_tool_safety` monitor flags them. In one test its `severe_internal_risks_agy`
monitor failed to parse its own response and did not trigger. Treat an `auto`
peer like headless Droid at its default `auto-high`: any peer that can message
it can have it run destructive commands as Mike.

For a tighter peer, use `--mode accept-edits`. Antigravity then edits files in
the workspace without asking but asks before commands, and the host cancels
those requests. `--mode default` also cancels edits.

## Operating it

`bun cli.ts live` (alias `wake-status`) lists Antigravity sessions under
**Wakeable Antigravity sessions**, using Droid's fields:

```
probe-agyspike-antigravity  broker=registered  session=live  mcp=live  wakeable=yes  unread=0  id=<uuid>
  cwd=<dir>  session_id=<antigravity session id>
```

`wakeable=yes` requires a registered broker row, a live launcher, a live MCP
child whose PID matches the broker row, and a recorded session id.

State lives in `~/.agent-peers-antigravity` (override with
`AGENT_PEERS_ANTIGRAVITY_STATE_DIR`): launch claims, saved sessions, session
owner locks and the bodyless inbox metadata the launcher polls.

Stop the host with Ctrl-C or SIGTERM. It cancels any running turn, closes
`agy acp` (SIGKILL after a grace period), removes its launch claim, and keeps
the saved session for `resume`.

## How it works

`agypeer` reuses the Droid headless ACP host through a runtime profile
(`AGY_LAUNCHER_PROFILE` in `shared/agy-profile.ts`). The wake controller,
retry ladder (5 minutes, 30 minutes, 2 hours, then stop for an unchanged unread
set), launch claims and shutdown are the same code Droid uses. Only the
executable, permission matcher, session configuration and state root differ.

1. The launcher creates a launch claim and spawns `agy acp`.
2. `session/new` (or `session/resume`) injects `agy-server.ts` as the MCP server
   `agent-peers`, with `AGENT_PEERS_RUNTIME=antigravity` and
   `AGENT_PEERS_LAUNCH_CLAIM_ID`.
3. The MCP child registers with the broker as `antigravity` and binds the claim
   to its peer id and PID.
4. The launcher sets the model, thinking level and mode, then polls the
   claim-bound inbox metadata.
5. New unread mail while idle sends the wake prompt. Mail that arrives during a
   turn waits for the turn to end and then wakes once.

`agy` loads `~/.gemini/GEMINI.md` and the working directory's `AGENTS.md` under
ACP (verified 2026-11-20), so fleet instructions and personas apply.

## Verified on 2026-11-20 (MacBook, isolated test broker)

| Check | Result |
|---|---|
| Start in a repo with an `AGENTS.md` persona | Named `probe-agyspike-antigravity`; `live` showed `wakeable=yes` |
| Idle wake after 20 s idle | Replied `PONG-1` through `send_message` in 16 s |
| Second message sent mid-turn | Queued, then exactly one more wake after the turn; both replies, no duplicates |
| File edit in `auto` | Created the file without a prompt |
| Destructive commands in `auto` | Ran without a prompt (see above) |
| Kill the host, queue mail, `resume` from another directory | Same name, UUID and session id; restored cwd; replied `RESUMED-OK` in 17 s |
| Signed-out `agy` | Clear error before launch (unit-tested with the Studio's exact output) |
| Droid regression | `droidpeer --headless` still started and reported `wakeable=yes` |

A wake turn on Gemini 4 Neon (High) costs about 20,000 input tokens, mostly
cached, for a trivial message.
