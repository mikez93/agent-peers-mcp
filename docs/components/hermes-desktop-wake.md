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
ctx.inject_message(text, session_key=<registry entry session_id>)
```

An idle session starts a turn; a busy one only queues (no interrupt). No
Desktop credential, tunnel, second client or Hermes patch is involved.

Code: `hermes-plugins/agent-peers-desktop-wake/`. Tests:

- `tests/python/test_hermes_desktop_wake.py`, run by `bun test` through
  `tests/hermes-desktop-wake-plugin.test.ts`;
- the desktop cases in `tests/hermes-chat-wake.test.ts`, including a
  cross-language lock test that drives the Python lock from TypeScript;
- `tests/hermes-desktop-wake-regressions.test.ts` and the Python
  `Ap10806Regressions` class, which reproduce Marco's AP10806 findings. Both
  use only APIs that 4e5fd81 also had, so they can be run against that commit
  (`DESKTOP_WAKE_PLUGIN=<path>` points the Python tests at another copy of
  the plugin).

## Safety model

- **Inert by default.** It acts only when both of these hold:
  - `~/.agent-peers-hermes/chat-wake/desktop-enabled` has a line
    `<profile> <chat-key>` (one throwaway chat) or `<profile> *` (every chat
    of the profile). A bare profile line does nothing.
  - The profile config sets
    `plugins.entries.agent-peers-desktop-wake.allow_gateway_injection: true`,
    which is Hermes's own gate for injection outside the classic CLI.
- **Gates are re-checked at the last moment.** The kill switches, the process
  role, the Hermes gate and the opt-in of the exact chat are checked at the
  start of each tick, again after the broker read and before the intent is
  written, and again immediately before the inject. Opting a chat out while
  the inbox is being read stops the wake before anything is written.
- **Scope.** It only acts on chat-tagged mail addressed to the profile's
  durable peer `<profile>-hermes`, and only on chats whose slot this process
  holds in `runtime/active_sessions.json`. The check covers the whole
  compression lineage. The inject target is that registry entry's
  `session_id` (after a compression re-key, the tip), never
  `metadata.live_session_id`. General mailbox mail is never woken here. It
  reads the broker's `/chat-inbox` only. `check_messages`, through the normal
  MCP, reads and acks the mail.
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
  - Before the inject, the plugin writes `desktop_attempt.state = "intent"`
    with its pid and that pid's start time (`ps -o lstart=`), so a reused pid
    is not mistaken for the host.
  - After the inject, it writes one of three results: `accepted` (queued,
    not handled), `not_submitted` (the host refused or a gate closed; another
    try is allowed), or `unknown` (Hermes logged "TUI scheduling failed", or
    the call raised).
  - While an attempt is open, neither executor wakes that chat, even for
    newer mail.
- **Ledger lock**, shared by both languages: `<ledger>.lock` holds
  `{"pid","start","token"}`.
  - The owner writes a private temp file and `link()`s it into place, so the
    lock never exists without a complete owner record.
  - Acquire fails closed whenever the lock file exists, whatever its content
    and whether or not its holder is alive. Nothing clears it automatically:
    a reaper racing a fresh owner can leave two owners (Marco AP10817). A lock
    left by a crashed holder blocks only that one chat until an operator
    clears it (see "Clearing a dead lock" below). The gateway driver's status
    then reads `ledger lock held by dead pid <pid>`.
  - Release removes the lock only while it still carries the owner's token.
- **Cancellation.** `cli.ts` cancel survives every settlement and record
  step. A cancelled chat is never woken; its open attempt can still settle,
  and the ledger stays `cancelled`.
- **Settlement from correlated turn evidence only** (Kepler §20 as amended
  by AP10808). The plugin registers two hooks:
  - `pre_llm_call` writes `<state>/chat-wake/<profile>/evidence/<attempt>.started.json`;
  - `post_llm_call` writes `<attempt>.ended.json`.

  `ended` means the wake's turn ended. It is not proof that the turn
  succeeded or that the session was persisted, and it is distinct from the
  mail being handled in a business sense. Hermes fires `post_llm_call` once
  per turn that was not interrupted, including failed turns: the
  turn-completion explainer fills an empty or abnormal response before the
  hook (`turn_finalizer.py:649-652`), and a persist error is caught
  (`:637`). The hook payload has no failed, completed or persisted flag.

  Each hook writes only when the turn's own `user_message` carries the
  attempt's marker, the turn's `session_id` is in the chat's lineage, and the
  attempt belongs to this process. `ended` must match the `turn_id` that
  started. Both hooks return `None`, so they add nothing to the prompt.

  | Evidence (`classifyDesktopAttempt`, mirrored in Python) | Verdict |
  |---|---|
  | `ended` recorded | `handled` (the wake's turn ended): raises `handled_max_id` and `launched_max_id` |
  | `started` recorded, host alive | `running` (blocks) |
  | `started` recorded, host dead or reused | `unknown` |
  | Evidence exists but cannot be read | `unknown` |
  | No evidence, attempt already `unknown`, or host dead or reused | `unknown` |
  | No evidence, `intent` younger than 60 s | `pending` |
  | No evidence, `intent` older than 60 s | `unknown` |
  | No evidence, accepted, host still holds the chat | `pending` (blocks) |
  | No evidence, accepted, host no longer holds the chat, or the registry cannot be read | `unknown` |

  Transcript rows, `finish_reason`, a closed chat, a dead host and elapsed
  time never settle an attempt. `unknown` blocks every automatic re-wake of
  that chat. Later `ended` evidence still settles it; otherwise only an
  operator clears it:
  `bun cli.ts hermes-desktop-clear <profile> <chat-key> [--handled]`.
- **Kill switches.** Checked every tick and at each of the points above:
  - `AGENT_PEERS_WAKE_DISABLED=1`;
  - `<state>/disabled`;
  - `~/.agent-peers-hermes/disabled`.

  Unload sets the stop event and joins the worker. Disabling the plugin in
  config does not stop code that is already loaded, so use a kill switch
  first.

## Known limitation: failed wake turns settle as handled

A wake turn that fails still fires `post_llm_call`, so its attempt settles
`handled` and that mail is not woken again. Examples that write `ended`:
`session_persistence_failed`, `all_retries_exhausted_no_response`,
`pending_tool_result`, `max_iterations_reached` and `guardrail_halt`. The mail
itself stays unread in the broker until `check_messages` reads it, and newer
mail wakes the chat again. Tracked in bd-b2in.22, due before D. The future
signal is `on_session_end` (`turn_finalizer.py:796-808`), which carries
`failed`, `interrupted` and `turn_exit_reason`; it is not built yet.

## Known blocking cases (safe, need an operator)

These leave the chat blocked rather than risk a duplicate wake. Each ends
with an operator step after a look at the chat.

- **Interrupted wake turn.** `post_llm_call` does not fire, so the attempt
  stays `running` while the host lives and becomes `unknown` if it dies.
  Clear it with `hermes-desktop-clear`.
- **Closed with the wake still queued.** Hermes drops the queued prompt; the
  attempt becomes `unknown` at the next settle.
- **Duplicate text.** `_enqueue_prompt` can drop an exact duplicate of the
  in-flight text and still return True. The attempt stays `pending` while the
  chat is open. The per-attempt marker makes an exact duplicate practically
  impossible.
- **A crashed lock holder.** Its `<ledger>.lock` stays and blocks only that
  chat. Clear it as below.

## Clearing a dead lock

Do this only when the chat is blocked and the status names a dead pid. Both
executors must be stopped, so nothing can take the lock while you remove it.

1. Engage the kill switch: create `~/.agent-peers-hermes/disabled` (and
   `<state>/disabled` if `AGENT_PEERS_STATE_DIR` points elsewhere). If the
   gateway wake daemon is running (step D), stop it too; it has no flag-file
   switch. Wait one plugin tick (5 s).
2. Confirm no holder is alive: read the lock's `pid`, and check that
   `ps -o lstart= -p <pid>` prints nothing, or a start time different from
   the lock's `start`.
3. Remove `<ledger>.lock`. The ledger name is
   `<state>/chat-wake/<profile>/<sha256(chat-key)[:32]>.json`.
4. Release the kill switch: remove the flag file and restart the daemon if
   you stopped it.

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
     - `evidence/<attempt>.started.json` and `.ended.json` exist with the
       same `turn_id`;
     - the turn calls `check_messages` with that chat;
     - no gateway admission appears for the session;
     - no other chat is touched.
   - Repeat with a turn already running. The wake must queue, Mike's turn
     must not be interrupted, and both texts must survive.
6. **Rollback, live, no reload.** Either delete the opt-in line or create
   `~/.agent-peers-hermes/disabled`. Mail stays queued.

## Hermes-side assumptions (Kepler §20, amended AP10808)

- **A1.** No longer needed. Settlement does not read the transcript, so it
  does not matter when a drained prompt's user row is persisted. A missing or
  unreadable state.db, registry or evidence file is never read as "nothing
  happened".
- **A2.** No re-inject on any uncertain outcome. A chat closed with the wake
  queued is `unknown` until evidence or an operator settles it.
- **A3.** The inject target is the registry entry's `session_id`; the plugin
  never uses `metadata.live_session_id`. Still to confirm live: the registry
  `pid` of a Desktop SSH session is the backend's own pid
  (`active_sessions.py` writes `os.getpid()` of the claimant).
- **A4.** Settled only by the hooks above (`agent/turn_context.py:811`,
  `agent/turn_finalizer.py`). Kepler confirmed from source (AP10819, §21)
  that both hooks fire once per turn for a TUI-drained turn, that the marker
  survives a merge with Mike's text, and that profile routing holds through
  `session['profile_home']`. Not yet seen live. If the hooks did not reach
  the plugin, nothing would be recorded and the attempt would block for an
  operator, which is safe. `ended` is not success; see the known limitation
  above.

The gateway driver's `registryHolder` checks only the chat's root session, not
its compression tip. That is a real gap, but harmless today: no Desktop chat
has a compression lineage yet. It is noted here, not changed.
