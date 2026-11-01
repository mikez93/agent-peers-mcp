# Hermes Desktop-open chat wake (in-process plugin)

Status: source and tests only (bd-b2in.16). Nothing here is enabled on any
machine. Live adoption needs Marco's runtime GO.

## What it does

Mail to a Hermes chat (`to_chat`) wakes that chat. A closed chat is woken by
the gateway driver (`shared/hermes-chat-wake.ts`, `hermes chat --resume -q`).
A chat Mike has open in Hermes Desktop is held by its Desktop backend, so the
driver waits (`waiting_desktop`). This plugin runs inside that backend and
uses Hermes's supported plugin API:

```python
ctx.inject_message(text, session_key=<stored session id>)
```

An idle session starts a turn; a busy one only queues (no interrupt). No
Desktop credential, tunnel, second client or Hermes patch is involved.

Code: `hermes-plugins/agent-peers-desktop-wake/`. Tests:
`tests/python/test_hermes_desktop_wake.py` (run by `bun test` through
`tests/hermes-desktop-wake-plugin.test.ts`) and the desktop cases in
`tests/hermes-chat-wake.test.ts`.

## Safety model

- **Inert by default.** It acts only when both of these hold:
  - `~/.agent-peers-hermes/chat-wake/desktop-enabled` has a line
    `<profile> <chat-key>` (one throwaway chat) or `<profile> *` (every chat
    of the profile). A bare profile line does nothing.
  - The profile config sets
    `plugins.entries.agent-peers-desktop-wake.allow_gateway_injection: true`,
    which is Hermes's own gate for injection outside the classic CLI.
- **Scope.** It only acts on chat-tagged mail addressed to the profile's
  durable peer `<profile>-hermes`, and only on chats whose slot this process
  holds in `runtime/active_sessions.json`. The check covers the whole
  compression lineage. General mailbox mail is never woken here. It reads the
  broker's `/chat-inbox` only. `check_messages`, through the normal MCP, reads
  and acks the mail.
- **Process role.** It refuses in three kinds of process:
  - a classic CLI process, where inject would use the interrupt queue;
  - any process with a messaging-gateway injector, because
    `plugins_injection.py` falls back to the gateway when the TUI host misses;
  - a process with no TUI or Desktop host.
- **Wake text.** It carries no message body, opens with
  `[agent-peers-wake <id>]`, and says it is automation, not typed by Mike. If
  Hermes merges it with Mike's queued text (`"{his text}\n\n{wake}"`), his
  text stays first and stays his instruction.
- **Durable attempt.** The attempt lives in the per-chat ledger that the
  gateway driver also uses (`<state>/chat-wake/<profile>/<sha256(chat)[:32]>.json`).
  - Before the inject, the plugin writes `desktop_attempt.state = "intent"`.
  - After the inject, it writes one of three results: `accepted` (queued,
    not handled), `not_submitted` (the host refused; another try is allowed),
    or `unknown` (Hermes logged "TUI scheduling failed", or the call raised).
  - Both executors take `<ledger>.lock` for every read-modify-write. While an
    attempt is open, the driver never launches.
- **Settlement from evidence** (`classifyDesktopAttempt`, mirrored in Python):

  | Evidence | Verdict |
  |---|---|
  | A marked user row, followed by an assistant row whose `finish_reason` is not a tool call | `handled`: raises `handled_max_id` and `launched_max_id` |
  | A marked row and a live host | `running` |
  | A marked row and a dead host | `unknown` |
  | No marked row and a dead host | `lost`: the in-memory queue died with the host; re-wake allowed |
  | A live host, intent never confirmed after 60 s | `unknown` |
  | A live host, accepted, but the host no longer holds the chat after 120 s | `unknown` |

  `unknown` blocks every automatic re-wake of that chat, even for newer mail.
  It clears only on evidence or by an operator:
  `bun cli.ts hermes-desktop-clear <profile> <chat-key> [--handled]`.
- **Kill switches.** The plugin checks these every tick and again just before
  each inject:
  - `AGENT_PEERS_WAKE_DISABLED=1`;
  - `<state>/disabled`;
  - `~/.agent-peers-hermes/disabled`.

  Unload sets the stop event and joins the worker. Disabling the plugin in
  config does not stop code that is already loaded, so use a kill switch
  first.

## Adoption path (needs runtime GO)

1. **Pick the backend.** Which backend hosts a chat is decided per chat, not
   per profile.
   - Read the target chat's entry in
     `~/.hermes/profiles/<p>/runtime/active_sessions.json`. Its `pid` is the
     hosting backend.
   - Map that pid to `~/.hermes/desktop-ssh/<ownershipId>/backend.lock.json`.
   - On the Studio today, Ezra's dedicated backend is 63023 and the
     default-profile pool backend is 42495. 42495 hosts profiles default,
     ezra, marco and valentina.
   - If the host is 42495, its Agent Peers MCP is still pre-A code. Reload it
     separately first, or chat-scoped `check_messages` will not work.
2. **Install, still inert.**
   - Link the plugin into the profile:
     `~/.hermes/profiles/<p>/plugins/agent-peers-desktop-wake` →
     `~/agent-peers-mcp/hermes-plugins/agent-peers-desktop-wake`, at the
     verified release SHA.
   - In that profile's config, add the plugin to `plugins.enabled` and set
     `allow_gateway_injection: true`.
   - The plugin stays inert until the opt-in file names a chat.
3. **Preflight before adoption.** A live rescan unloads and reloads the
   profile's other plugins (`plugins.py:1257`).
   - Run it only when the backend is idle: no running turn and no queued
     prompt.
   - Scope it to that one profile.
   - List the loaded plugins (Hindsight, tools) before and after, and confirm
     they are unchanged.
   - No forced restart.
4. **Adopt.**
   - The targeted route is the Plugins Hub toggle for that backend's
     connection (Mike, one click), or the backend's next natural spawn.
   - `hermes plugins enable` from a shell reaches only the backend in the
     host rendezvous record, plus the messaging gateway. On the Studio that
     backend is 42495, not 63023. Inside the messaging gateway, this plugin
     refuses by design.
   - A successful plugin load does not prove the chat has scoped mail.
5. **Throwaway proof, with profile-wide D off.**
   - Opt in one chat: `ezra <throwaway-chat-key>`.
   - Send one tagged non-business message to the chat's address.
   - Pass requires all of:
     - the ledger moves intent → accepted → handled;
     - the transcript has the marked row;
     - the turn calls `check_messages` with that chat;
     - no gateway admission appears for the session;
     - no other chat is touched.
   - Repeat with a turn already running. The wake must queue, Mike's turn
     must not be interrupted, and both texts must survive.
6. **Rollback, live, no reload.** Either delete the opt-in line or create
   `~/.agent-peers-hermes/disabled`. Mail stays queued.

## Assumptions still to verify (Hermes side)

- **A1.** A drained queued prompt persists its user row, including merged
  text, before any model or tool work. "No marked row, dead host" means
  `lost` only if this holds.
- **A2.** Closing a session that has a queued prompt: is the prompt dropped
  or drained? The plugin treats it as `unknown` after 120 s, which is
  conservative.
- **A3.** The registry `pid` of a Desktop SSH session is the backend's own
  pid. `active_sessions.py` writes `os.getpid()` of the claimant.
- **A4.** On Codex-provider turns, the final assistant row has a
  non-tool-call `finish_reason`, for example `stop`.
