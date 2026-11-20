# Interactive Antigravity as a wakeable peer

On a fleet machine, typing `agy` opens the normal Antigravity chat. That chat joins Agent Peers and wakes when mail arrives while it is idle, the same as `droid`, `claude` and `codex`. Use `agypeer` instead when you want a background Antigravity worker with no window (see [wakeable-agy.md](wakeable-agy.md)).

## How it works

Antigravity gives outside programs no way to start a turn in an open chat. It does start a new turn by itself when a background task the agent started finishes (verified on agy 1.5.13, 2026-11-20). The wake is built on that behavior:

1. The fleet's `agy` shell function runs `bun agy-interactive.ts launch`. The launcher creates a launch claim for the current directory, then starts `agy` with the claim ID in `AGENT_PEERS_LAUNCH_CLAIM_ID` and a first prompt asking the agent to start the mail waiter as a background task.
2. Antigravity starts the `agent-peers` MCP server from its user config (`~/.gemini/config/mcp_config.json`). The server inherits the claim ID from agy's environment, registers the peer, and binds its peer ID to the claim.
3. The waiter (`agy-interactive.ts wait`) inherits the same claim ID. It waits for the binding, then watches that peer's mailbox. When mail newer than the last message it reported arrives, it prints a short note and exits.
4. The finished background task wakes the idle chat. The note tells the agent to call `check_messages`, handle the mail, and start the waiter again.
5. When `agy` exits, the launcher removes the claim. A waiter still running notices and exits quietly.

The waiter records, per claim, the last message ID it reported, so one message never wakes the chat twice. Mail that arrives during a turn is handled in that turn or by the next wake. A half-typed message in the input box survives a wake.

## Setup

The fleet installers run `bun agy-interactive.ts setup` on every machine where `agy` is installed. It is idempotent, and it leaves other settings alone. It does two things:

- It registers `agent-peers` in Antigravity's user MCP config, with `AGENT_PEERS_AGY_USER_CONFIG=1` and the Antigravity state directory in its environment.
- It adds four rules to `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`: the waiter command, `mcp(agent-peers/*)`, `read_file(<this repo>)` and `write_file(<state dir>)`. The first two stop permission prompts for the plumbing. The last two let the waiter run inside Antigravity's terminal sandbox, which otherwise sees only the workspace and temp directories.

## Other agy processes

The user-level entry loads in every agy process, so it must stay quiet where it doesn't belong:

- Without a launch claim (`agy -p`, `command agy`, or agy started some other way), the server offers no tools and registers no peer.
- Antigravity runs one MCP server per name and prefers the user-config copy over the one agypeer passes in its ACP session. So agypeer also puts its claim ID, state directory and peer name in its `agy acp` child's environment, and whichever copy runs binds agypeer's claim.
- agypeer drops any claim ID it inherited, so starting agypeer from inside an interactive agy can't take over that session's claim.
- Interactive claims carry the session ID `agy-interactive:<claim-id>`, so agypeer's startup check doesn't mistake them for another launcher still starting.

## What runs native agy

These go straight to native `agy`: a subcommand (`mcp`, `models`, `acp` and the rest), `-p`, `--print`, `--prompt`, `--help` or `--version`; redirected input or output; and `command agy`. `agy -i "prompt"` stays wakeable, and your prompt runs after the waiter starts. Model, `-c` and `--conversation` pass through.

The launcher starts agy in `accept-edits` mode, Mike's default: Antigravity edits files without asking and asks before running commands. Pass `--mode auto` or `--mode plan` to choose otherwise, or cycle modes with Shift+Tab inside the chat. While Mike is away, a command the agent asks about waits for an answer, so a woken chat may pause on a prompt.

## Limits

- Only sessions started through the shell function are wakeable. A chat that is already running can't be made wakeable after the fact.
- The wake depends on Antigravity's background-task behavior, which is not documented. After an agy upgrade, start `agy`, send it mail, and check that it replies.
- The agent starts the waiter because its prompt says to. If it kills the waiter, or doesn't restart it after a wake, the chat stops waking until the waiter runs again. The `/tasks` panel shows whether it is running.
- On omarchy, agy reports signed out over SSH, so start it from a desktop terminal there.

## Verified on 2026-11-20 (MacBook, agy 1.5.13, Gemini 3.8 Flash)

| Check | Result |
|---|---|
| Idle wake, twice in a row, re-arming after each | Replied both times |
| Idle wake with a half-typed message in the input box | Replied; the draft was untouched |
| Two chats in the same directory | Each got its own peer; mail to one woke only that one |
| Mail during a turn | Handled once, in the same turn |
| Idle for 11 minutes | Woke and replied |
| Through the real `agy` shell function after `setup` | Waiter started on the first try, no permission prompts, replied to mail |
| agypeer with the user-level entry present | Started, registered and replied |
| Accept-edits mode (the default), idle wake | Replied with no permission prompts and restarted the waiter |
| Mail sent while the chat was closed and reopened | Picked up and answered in the new chat's first turn |
| Studio and omarchy over SSH, agy at its sign-in screen | Shell function, launch claim, MCP binding and the waiter's wake note all worked, and closing the window removed the claim; the agent's own turn needs a signed-in agy |
