# Native Droid interactive evidence — 2026-09-07

Local integration verified on Mike-Mac-Studio-Eth with Factory Droid 0.213.0.
The MacBook reports the same Droid version. Mike authorized publication and
both-machine deployment; rollout verification follows the local evidence below.

## Native terminal demonstration

An isolated broker on port 17921 and a private temporary peer-state directory
kept these checks separate from colleague traffic. Only synthetic peers received
test messages. No existing user session was opened or modified.

Factory session: `1cd23104-5364-4250-86ea-2421d0fc7821`.
Peer: `native-droid-e2e`, UUID `ef17b087-c0a6-4cc3-86f5-b042b77fe8ec`.
Model: `custom:GPT-5.6-Luna-Medium-Proxy-12`, medium effort, low autonomy.

- A human instruction produced `HUMAN_INPUT_OK` in Factory's native terminal.
- Idle mail `NATIVE_IDLE_20260907` started a visible turn without keyboard input.
  The synthetic sender received `NATIVE_PEER_REPLY_OK` and acknowledged it.
- Mail `NATIVE_BUSY_20260907`, sent during a permission wait, was handled without
  overlapping turns. The sender received `NATIVE_BUSY_REPLY_OK`.
- Exit and exact resume restored history, peer name, UUID, cwd, and model.
- Escape at a native peer-tool approval returned to the prompt while the unread
  message remained available. A later human instruction resumed handling.
- The first resume sender timed out while approvals were deliberately held for
  the cancellation test. Its later reply failed because that synthetic sender
  had already exited. A fresh sender received `NATIVE_RESUME_FRESH_OK`.
- A final resume, with the fleet-style model environment default present,
  reported `session=live mcp=live wakeable=yes unread=0` for that same UUID.
  Normal exit returned code 0 and printed the `droidpeer --resume` command.

Native tool approvals were granted one call at a time. The launcher never
selected persistent approval or bypassed Factory's permission UI.

## Regression checks

Tests cover authentication ordering, exact turn completion, human queue
serialization, cancellation, deleted/discarded queued input, UI-only messages,
permission passthrough, session/directory fencing, and normal/error shutdown.
Launcher fixtures verify canonical cwd binding and claim/ownership cleanup.
The existing ACP and durable-delivery suites remain part of the full run.

Latest full run: **349 passed, 0 failed**, 1,687 assertions across 43 test files.
`bunx tsc --noEmit` and `git diff --check` passed. Pilcrow's documentation lint
reported no error-level findings; repeated protocol names were retained for
precision. The isolated native terminal and broker were stopped after testing.
The native queue tests also cover human input coalesced into an enclosing turn:
Factory emits that outer completion without separate coalesced notifications.

## Independent review closeout

The read-only Codex review identified four concrete issues, now fixed and tested:

- Factory filesystem MCP entries take precedence over same-name injected ones.
  Native injection now uses a per-launch random name, short enough for tool-name
  limits. The fixture reproduces a conflicting fixed-name filesystem entry.
- Closing/reloading the same session could retain an old MCP PID. Closing disables
  wake immediately; closure retires the relay, and every in-process reload is
  rejected. A fresh launcher is required for a fresh binding.
- A pre-lock ACP host could still be starting with no session ID. A live unknown
  claim now blocks admission until it binds or exits.
- A recycled process ID could falsely block resume. Legacy claim checks now use
  the existing process-start-time guard, tested against an older claim timestamp.

The final Studio live test resumed the same peer with a uniquely named MCP and
handled `FINAL_STUDIO_NATIVE_20260907` through native one-call approvals.

## Compatibility boundary

The relay uses Factory's internal parent IPC transport, inspected in the
installed 0.213.0 binary. Public SDK 0.9.1 declarations corroborated request and
notification shapes. This is not a stable public TUI-attachment API. Repeat the
native demonstration after upgrading Droid. `--headless` retains the ACP path.

Managed sessions retain one repository and one session identity. Native resume
uses saved settings; explicit setting overrides must be made in the native UI.
An ordinary unmanaged `droid` process is not retrofitted with wakeability.
