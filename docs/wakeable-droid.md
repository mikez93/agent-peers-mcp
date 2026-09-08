# Wakeable Factory Droid peers

## Guarantee

`droidpeer` opens Factory's native interactive terminal as a managed,
wakeable Agent Peer. Human chat and peer wake use the same Factory session.
A peer message sent while the Droid is idle starts a new
Droid turn without terminal input. The wake signal contains no message body;
the model receives the authoritative content only by calling the Agent Peers
`check_messages` MCP tool.

An ordinary already-running `droid` TUI is outside this guarantee. It was not
started under an externally owned connection, so Agent Peers has no session
handle with which to start a turn.

## Launch and resume

```bash
droidpeer
droidpeer --resume <factory-session-id>
droid-peer --resume <factory-session-id>
droidpeer start [peer-name] [cwd]
droidpeer start --cwd <repo-path>
droidpeer resume <factory-session-id> [peer-name] [cwd]
```

Bare `droidpeer` starts in the current directory. `--resume` (or `-r`) accepts
the session ID printed by native Droid; `droid-peer` is an executable alias.
In a terminal this opens native Droid: normal input, streamed answers, history,
permission prompts, cancellation, and native settings. With redirected input or
output, or explicit `--headless`, it hosts the previous ACP background session.

The native launcher owns `droid daemon --listen ipc` and relays the native TUI's
parent IPC connection. It injects `droid-server.ts` as a session-scoped MCP server.
Its per-launch MCP name avoids filesystem configuration overriding the binding.
Factory's internal IPC contract was verified on **Droid 0.213.0**; it is not a
documented stable third-party TUI attachment API. Re-run the native smoke test
after a Droid upgrade. The headless fallback uses `droid exec --output-format acp`.

Model, reasoning, and autonomy options configure new native sessions. Native
resume retains saved settings and ignores environment defaults; explicit setting
flags are rejected with guidance to use the native UI. A native managed session
keeps its saved directory; start another session to change repositories. Session
switching and directory changes inside the TUI are rejected to protect mailbox
identity. A second managed launcher cannot open an already-owned session.
Same-session reload also requires exiting and resuming in a fresh launcher.
If an older launcher is still starting without a known session ID, wait for it
to bind or close it before launching another managed peer.

Omitting the name derives `<persona>-<repo>-droid` from the repository's primary
`AGENTS.md` identity, falling back to `<repo>-droid`. An explicit argument or
`PEER_NAME` overrides that default.

## Wake path

1. The launcher creates a private, single-session launch claim.
2. `droid-server.ts` registers a `droid` peer with the local broker and binds
   the resulting peer UUID to that claim.
3. The MCP poller leases incoming mail, writes it to the private durable inbox,
   and writes adjacent bodyless metadata.
4. The host watches only the metadata for the peer UUID in its claim. If the
   session is idle, it sends a fixed bodyless prompt to call `check_messages`.
5. Droid reads the real message through the MCP tool, handles it, and may reply
   with `send_message`.

Only one peer wake may be active at a time. Native human work and queued input
also keep the wake controller busy. Messages arriving while Droid is
busy remain in the durable inbox; the host evaluates the newest metadata as soon
as the current prompt resolves. If a completed turn leaves the same inbox
unread, the host retries after 5 minutes, 30 minutes, and 2 hours, then stops
proactive turns for that exact unread set. New mail changes the signature and
wakes immediately.

Canceling a native peer wake suppresses retries of that unchanged unread set;
new mail can still wake. Canceling ordinary human work does not suppress mail.
Deleting queued native input releases the corresponding busy marker. Neither
cancellation nor queue deletion acknowledges unread broker mail.

## Trust boundaries

- Claims, inboxes, and metadata live below `~/.agent-peers-droid` with a 0700
  directory and 0600 files.
- Claim binding uses the exact MCP child PID and broker peer UUID. It does not
  guess by cwd or display name.
- The wake prompt never includes sender text, message content, or broker lease
  tokens.
- Native permission requests and user answers pass through unchanged. The relay
  never auto-approves tools; peer work can pause for your native approval.
- In headless mode, ACP permission requests fail closed except for the six local Agent Peers MCP
  operations, which are approved for one call at a time so an idle peer can
  read and answer its inbox. Shell, filesystem, browser, connector, and unknown
  tools are never auto-approved by the launcher.
- Turn completion is a wake/control signal, not a delivery receipt. Broker acks
  remain controlled by the shared MCP confirm-on-next-call state machine.

## Recovery boundary

`droidpeer resume` can reopen the exact Factory session after the managed host is
stopped, while the broker and on-disk inbox preserve queued mail. Automatic
process resurrection after a crash or reboot is deliberately separate from idle
wakeability and is not provided by this launcher.

If the bound MCP child itself dies, `peerstatus` reports `mcp=dead` and
`wakeable=no`. Restart the launcher with `droidpeer resume <session-id>`; a
binding is never stolen inside a live claim.

Bare `droidpeer resume <session-id>` restores the actual allocated peer name
(including a collision suffix), prior peer UUID, and working directory. The UUID
lets the broker recover orphaned unread mail if the old peer row was collected.
MCP rename and broker re-registration refresh that saved identity. Explicit name
arguments override the saved name. Cwd overrides are supported by headless ACP;
native resume keeps the saved directory.

Malformed ACP output or native IPC, and closed transports, terminate the managed host so it cannot
remain falsely wakeable. Cancellation covers startup as well as idle/wake turns;
shutdown waits for the child to exit, escalating SIGTERM to SIGKILL after two
seconds. A child that fails to exit produces a shutdown error instead of a
successful close report.

## Inspection

Run `bun cli.ts live` (or the fleet `peerstatus` wrapper) to distinguish Droid
broker membership, launcher/session process liveness, MCP process liveness,
wakeability, and unread count.
When crash residue and a resumed claim share a peer UUID, inspection prefers the
live claim matching the broker's current MCP PID. A claim without a finalized
Factory session ID cannot report wakeable.
