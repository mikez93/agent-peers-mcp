# Factory Droid idle-wake E2E evidence — 2026-09-07

This is the retained, sanitized transcript for the real-model acceptance run.
No broker secret, Factory credential, session token, or message body outside the
purpose-built nonce is included.

## Runtime

- Factory Droid CLI: `0.204.0`
- ACP command: `droid exec --output-format acp`
- Broker: isolated client-owned broker on loopback port `17911`
- Droid model: fleet custom GPT-5.6 Luna proxy
- Autonomy: `auto-low`; the ACP client approved only one invocation at a time
  for the exact Agent Peers tool-title allowlist

## New session and first idle wake

The managed launcher reported:

```text
droid_peer:
  name: droid-final-e2e
  peer_id: a057f1b2-76f6-44b5-bc93-d4bf8175d4fd
  session_id: 7249b6e5-38cc-46ab-a72f-a9b58a4ac45d
  status: wakeable
```

While the launcher was idle, the persistent verifier sent
`E2E_NONCE_20260907_FINAL`. Without terminal input, Droid woke, called
`check_messages`, and replied through `send_message`:

```text
sent: 1
reply: E2E_DROID_WAKE_FINAL_OK
from: droid-final-e2e
acked: 1
```

## Process restart, bare resume, and second idle wake

The launcher was stopped with SIGINT and exited `0`. It was then invoked with
only `resume 7249b6e5-38cc-46ab-a72f-a9b58a4ac45d` plus model configuration.
The saved name and working directory were restored, and the broker reclaimed
the same peer UUID:

```text
droid_peer:
  name: droid-final-e2e
  peer_id: a057f1b2-76f6-44b5-bc93-d4bf8175d4fd
  session_id: 7249b6e5-38cc-46ab-a72f-a9b58a4ac45d
  status: wakeable
```

A second message arrived while that resumed session was idle:

```text
sent: 3
reply: E2E_DROID_RESUME_WAKE_OK
from: droid-final-e2e
acked: 1
```

## Independent state checks

`bun cli.ts live` distinguished broker membership, process liveness, and
wakeability:

```text
Wakeable Factory Droid sessions:
  droid-final-e2e  broker=registered  session=live  mcp=live  wakeable=yes  unread=0  id=a057f1b2-76f6-44b5-bc93-d4bf8175d4fd
    cwd=/Users/mike/agent-peers-mcp  session_id=7249b6e5-38cc-46ab-a72f-a9b58a4ac45d
```

The broker database contained exactly the two nonce/reply pairs, and all four
rows had `acked=1`. The private Droid metadata file contained `"unread": []`.
Together, this proves sender → broker persistence → bodyless idle wake → real
Factory permission flow → `check_messages` → `send_message` → broker ack, both
before and after exact-session resume.
