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
launcher, so you talk to an `agypeer` session through Agent Peers. The
interactive `agy` chat is wakeable by a different mechanism, described in
[agy-interactive.md](agy-interactive.md).

Use it only when you want a background Antigravity worker that other agents can
hand work to while nobody is watching. It has no chat window: after it prints
its name and session id it waits for mail, and Ctrl-C stops it. For normal
work, type `agy`, which is a wakeable peer on fleet machines.

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

Before anything starts, `agypeer` runs `agy models`. When that can't find a
Google sign-in, it exits with:

```
error: agy can't read its Google sign-in from this session. Over SSH or in a sandboxed shell it can't reach the keychain or keyring, so it looks signed out even when it isn't; start agypeer from a terminal in the desktop session. If agy is signed out there too, run `agy` once to sign in.
```

This usually isn't a real sign-out. agy keeps its token in the macOS keychain
or the Linux keyring, which SSH sessions and sandboxed agent shells often can't
read; on 2026-11-20 both the Studio and omarchy looked signed out over SSH while
Mike's desktop terminals were signed in. Start agypeer from a desktop terminal.
If it is signed out there too, run `agy` once to sign in. Don't copy credential
files between machines.

## Permissions and modes

The default mode is `auto` (Mike, 2026-11-20, replacing his earlier
`accept-edits`). Antigravity edits files and runs the commands it judges safe
without asking. It still asks about some calls, and nobody is present to
answer, so the host answers permission requests itself:

- It allows the six Agent Peers tools (`list_peers`, `send_message`,
  `set_summary`, `check_messages`, `wait_for_peer_messages`, `rename_peer`),
  one call at a time. Antigravity names MCP tools `mcp_<server>_<tool>`, so the
  host matches `mcp_agent-peers_<tool>` on the request's `toolCall.name`.
- It refuses every other request by selecting Antigravity's own `reject_once`
  option. The agent is told "user denied permission" and carries on, so it can
  still reply to the sender. The host never answers `cancelled` when a
  `reject_once` option exists: Antigravity takes that as cancelling the whole
  turn, and the peer stops without replying (seen 2026-11-20). Elicitation is
  declined, and client methods such as terminal or filesystem access are
  refused.

In the 2026-11-20 test of `accept-edits` (`--mode accept-edits`, which asks
before every command), a file edit succeeded, `touch` was refused, and the peer
replied with both results.

**`--mode auto` asks very little.** In the 2026-11-20 tests, `auto` ran each of
these without a permission request:

- `rm -rf` on a directory inside the workspace;
- `rm -rf` on a directory outside the workspace, under `/tmp`;
- `git push --force` to a remote.

Antigravity asks permission for MCP tools even in `auto`, because its internal
`agy_tool_safety` monitor flags them. In one test its `severe_internal_risks_agy`
monitor failed to parse its own response and did not trigger. Treat an `auto`
peer like headless Droid at its default `auto-high`: any peer that can message
it can have it run destructive commands as Mike. Mike chose that default on
2026-11-20; pass `--mode accept-edits` when a peer should only edit files.
`--mode default` also refuses edits.

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
| `accept-edits` (the default until 2026-11-20), production broker | File edit succeeded; `touch` refused with "user denied permission"; the peer replied with both results. With the earlier `cancelled` answer it never replied |
| Cross-machine wake (production brokers) | Mail from the MacBook woke peers on the Studio and omarchy-01; both replied |
| Kill the host, queue mail, `resume` from another directory | Same name, UUID and session id; restored cwd; replied `RESUMED-OK` in 17 s |
| Signed-out `agy` | Clear error before launch (unit-tested with the Studio's exact output) |
| Droid regression | `droidpeer --headless` still started and reported `wakeable=yes` |

A wake turn on Gemini 4 Neon (High) costs about 20,000 input tokens, mostly
cached, for a trivial message.
