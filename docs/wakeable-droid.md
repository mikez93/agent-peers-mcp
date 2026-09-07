# Wakeable Factory Droid peers

## Guarantee

`droidpeer` makes an **ACP-managed** Factory Droid session a first-class,
wakeable Agent Peer. A peer message sent while the Droid is idle starts a new
Droid turn without terminal input. The wake signal contains no message body;
the model receives the authoritative content only by calling the Agent Peers
`check_messages` MCP tool.

An ordinary already-running `droid` TUI is outside this guarantee. It was not
started under an externally owned ACP connection, so Agent Peers has no session
handle with which to start a turn.

## Launch and resume

```bash
droidpeer start <peer-name> [cwd]
droidpeer resume <factory-session-id> [peer-name] [cwd]
```

The launcher starts `droid exec --output-format acp`, negotiates ACP v1, and
creates or resumes one Factory session. It injects `droid-server.ts` as a stdio
MCP server using ACP's `mcpServers` session field.

## Wake path

1. The launcher creates a private, single-session launch claim.
2. `droid-server.ts` registers a `droid` peer with the local broker and binds
   the resulting peer UUID to that claim.
3. The MCP poller leases incoming mail, writes it to the private durable inbox,
   and writes adjacent bodyless metadata.
4. The ACP host watches only the metadata for the peer UUID in its claim. If the
   session is idle, it sends a fixed bodyless prompt to call `check_messages`.
5. Droid reads the real message through the MCP tool, handles it, and may reply
   with `send_message`.

Only one ACP prompt may be active at a time. Messages arriving while Droid is
busy remain in the durable inbox; the host evaluates the newest metadata as soon
as the current prompt resolves. If a completed turn leaves the same inbox
unread, the host retries after 5 minutes, 30 minutes, and 2 hours, then stops
proactive turns for that exact unread set. New mail changes the signature and
wakes immediately.

## Trust boundaries

- Claims, inboxes, and metadata live below `~/.agent-peers-droid` with a 0700
  directory and 0600 files.
- Claim binding uses the exact MCP child PID and broker peer UUID. It does not
  guess by cwd or display name.
- The wake prompt never includes sender text, message content, or broker lease
  tokens.
- ACP permission requests fail closed except for the six local Agent Peers MCP
  operations, which are approved for one call at a time so an idle peer can
  read and answer its inbox. Shell, filesystem, browser, connector, and unknown
  tools are never auto-approved by the launcher.
- ACP completion is a wake/control signal, not a delivery receipt. Broker acks
  remain controlled by the shared MCP confirm-on-next-call state machine.

## Recovery boundary

`droidpeer resume` can reopen the exact Factory session after the ACP host is
stopped, while the broker and on-disk inbox preserve queued mail. Automatic
process resurrection after a crash or reboot is deliberately separate from idle
wakeability and is not provided by this launcher.

If the bound MCP child itself dies, `peerstatus` reports `mcp=dead` and
`wakeable=no`. Restart the launcher with `droidpeer resume <session-id>`; a
binding is never stolen inside a live claim.

Bare `droidpeer resume <session-id>` restores the saved peer name and working
directory. Explicit name or cwd arguments override the saved values.

## Inspection

Run `bun cli.ts live` (or the fleet `peerstatus` wrapper) to distinguish Droid
broker membership, launcher/session process liveness, MCP process liveness,
wakeability, and unread count.
