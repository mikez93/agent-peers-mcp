# T1 opt-in activation and rollback

Tracking: `bd-1con`. Activation owner: Marco, coordinated with Kepler.
Vector's automated proofs use temporary profiles/databases and real stdio MCP
children. They are **not** a live Hermes acceptance receipt.

## What this release enables

- `AGENT_PEERS_HERMES_V2=1` selects the multiplex adapter in `hermes-server.ts`.
  Absent/other values take the unchanged legacy import.
- First **strict host `_meta` tool call**, not process startup or model arguments,
  registers the calling conversation's peer. All six tools use that identity.
- One active adapter process is allowed per host backend UUID. Duplicate MCP
  processes expose no tools rather than competing for the mailbox.
- T1 observes dispatch order; it does not invent host close/reap events.
  Forty-five-second owner leases expire without calls; the shared one-second
  scheduler suspends expired bindings and unloads idle local state. Calls can
  resume the same UUID. MCP shutdown/death does not acknowledge unread mail.
- **No v2 autonomous wake.** T1 live acceptance is identity/status and private
  read/ack only. T2 adds actual lifecycle and exact queued wake.

## Required paired source and configuration

1. Agent Peers source: `0b42a1ab5bbfedcf0875271f511a03b07628076e`.
   Paired host source supplied by Kepler9672:
   `7ec7864550549968fb226d6dba568d367caf55b4`,
   tree `760a56600ab5b678c4175c4993aec1543549eb64`, package
   `~/Hermes/maintainers/kepler/patches/hermes-conversation-meta-20260909-home`.
   This superseding T1 package **forces both**
   `AGENT_PEERS_HERMES_BACKEND_ID` and `AGENT_PEERS_HERMES_HOME` into stdio
   children after configuration overrides. The earlier `2e59e917` host package
   does not suffice for the home bridge.
2. The adapter requires a canonical `AGENT_PEERS_HERMES_HOME` and valid
   host-lifetime UUID. It never falls back to generic `HERMES_HOME`, and these
   two internal bridges must not be manufactured in profile config or `.env`.
3. Keep the configured MCP command pointing to the published
   `/Users/mike/agent-peers-mcp/hermes-server.ts`, using the installed Bun.
   Preserve existing `PEER_NAME`, `AGENT_PEERS_CWD`, allowlists and credentials.
4. Hermes filters inherited child env. Add only this non-secret interpolation
   to the existing profile `mcp_servers.agent-peers.env` map:

   ```yaml
   AGENT_PEERS_HERMES_V2: "${AGENT_PEERS_HERMES_V2}"
   ```

   The parent serve sets `1`. Parent gateway/cron instances keep it absent or
   explicitly `0`, so their child adapter stays legacy. Do not put a literal
   `1` into the shared profile MCP config: that would also opt in gateways.
   Kepler9671 verified the actual interpolation/environment chain: ordinary
   serve parent `1` reaches the child; profile-scoped `0` overrides it, and a
   multiplex-scope miss preserves the literal placeholder. Before the canary,
   verify the selected profile/external scope has no conflicting V2 overlay.

The adapter reads `AGENT_PEERS_DB` (default `~/.agent-peers.db`), requires an
existing owner-only 0600 regular file and equally private WAL/SHM/journal
sidecars, and uses SQLite transactions under the
same local OS-user boundary as the operator CLI. It never starts a broker.
`AGENT_PEERS_STATE_DIR` / `AGENT_PEERS_HERMES_STATE_DIR` select its inbox root,
otherwise `~/.agent-peers-hermes`. `PEER_NAME` supplies a conversation-name
prefix, **not** a durable identity takeover.

## Studio rollout order

Verify host identity and back up the existing SQLite database using SQLite's
online backup API, plus affected profile config/plist files, before changes.
No raw token or message-body contents belong in the activation receipt.

1. Run the shared broker from the new Agent Peers source **before the first v2
   binding**. An already-running old broker does not hot-reload new fencing,
   retention, or name-takeover protection:

   ```sh
   launchctl kickstart -k "gui/$(id -u)/com.mike.agent-peers-broker"
   bun /Users/mike/agent-peers-mcp/cli.ts status
   ```

   Confirm authenticated readiness/source identity using the maintainer's
   broker checks. Restarting the broker preserves its database and tokens.
2. Verify the live v1 wake daemon excludes every UUID found in
   `hermes_conversations`, regardless of state, and abstains on lookup failure.
   Keep that exclusion during rollback too.
3. Kepler promotes the reviewed paired Hermes source. For the chosen serves,
   add `HERMES_MCP_SESSION_META=1` and `AGENT_PEERS_HERMES_V2=1` under
   `EnvironmentVariables` in these existing plists:

   | Profile | Plist / launchd label | Port |
   |---|---|---|
   | Ezra | `~/Library/LaunchAgents/ai.hermes.serve-ezra.plist` / `ai.hermes.serve-ezra` | 9121 |
   | Marco | `~/Library/LaunchAgents/ai.hermes.serve-marco.plist` / `ai.hermes.serve-marco` | 9122 |
   | Valentina | `~/Library/LaunchAgents/ai.hermes.serve-valentina.plist` / `ai.hermes.serve-valentina` | 9123 |

   Begin with Ezra's two-chat proof. Do not bounce all owner services blindly.
   Plist edits require unloading/reloading the definition, not just kickstart:

   ```sh
   launchctl bootout "gui/$(id -u)/ai.hermes.serve-ezra"
   sleep 3
   launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.hermes.serve-ezra.plist"
   ```

   Apply the same approved, sequential procedure to the other selected serves.
   Gateways, durable cron identities and Desktop app are not in this restart set.
4. Reconnect the Desktop to the promoted serve. Run normal owner turns in two
   Ezra chats. Each sets a distinct synthetic status through `set_summary`;
   send private synthetic mail to each resulting UUID, then verify that only
   that chat reads/acknowledges it. This requires real owning-agent dispatch.
   No public metadata-injection endpoint exists.

## Independent metadata evidence

After a real tool call creates a binding, inspect its UUID:

```sh
bun /Users/mike/agent-peers-mcp/hermes-conversations-cli.ts inspect <peer-id> --db "$HOME/.agent-peers.db"
```

This reads actual home, stable conversation root, current stored segment,
backend/adapter IDs, generation, observation time and state. It omits credentials,
message bodies and status prose. Compare against the host's actual session
metadata, not an assistant's claim about its identity.

## Coexistence and rollback

Keep `ezra-hermes`, `marco-hermes`, and `valentina-hermes` durable identities and
their crons intact. Their legacy mailboxes cannot read/ack v2 mail. V1 may wake
legacy mail only; it must never reroute v2 mail to a durable identity.

Rollback: remove/set `0` for `AGENT_PEERS_HERMES_V2` on the opted-in serve plists,
reload only those serves, and verify legacy tools. `HERMES_MCP_SESSION_META`
may independently return to `0` with Kepler's source rollback plan.

**Keep the new broker and v1 exclusion running.** Do not roll the broker back to
code that can steal or age-delete retained v2 mail. Do not delete conversation
tables, inboxes, or unread rows. V2 bindings become dormant and remain resumable
when v2 is re-enabled; rollback does not deliver their mail to legacy peers.
