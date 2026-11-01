# Federation service

Sources: `shared/federation.ts`, `shared/federation-config.ts`.
The broker owns integration, authentication of local senders, chat resolution,
and the existing poll/lease/confirm pipeline.

## Contract

- Each machine remains authoritative for its own peers and mailboxes. No remote
  rows are inserted into `peers`; discovery queries the other machines live.
- `name@host[/chat]` addresses an exact remote name. A bare name first uses local
  resolution. Only `unknown_peer` permits remote discovery. Multiple matches, or
  an unreachable machine that prevents a certain answer, require an explicit
  address. Discovery does not adopt chats, wake agents, or consume mail.
- `list_chats` works across machines. `name@host` lists that Hermes agent's
  chats on its own machine through `GET /federation/chats`; a bare name unknown
  locally is looked up like a bare-name send (exactly one remote Hermes match is
  listed, several are ambiguous). Returned names and addresses are qualified
  (`ezra-hermes@studio/<chat key>`), so sending to one reaches that chat. The
  lookup is live and read-only: titles and status only, nothing stored, woken or
  consumed. An unreachable machine, or one whose broker predates the endpoint
  (404), returns a clear error.
- A successful remote send means **queued**, not delivered or seen. Enqueue is
  synchronous inside the broker's sender-authentication transaction. Network I/O
  happens later, outside that transaction. Negative receipt IDs identify remote
  outbox entries; they cannot collide with positive inbox message IDs. Old clients
  still print a numeric ID, followed by the explicit queued-not-seen notice.
- The destination records the outcome by `message_uid` in the same transaction
  as insertion and sender metadata. A lost response or broker restart can cause
  another relay attempt, but not a second destination insertion.
- Model delivery remains at-least-once. Federation does not acknowledge mail;
  the recipient confirms it on a later tool call as before.
- Incoming mail carries a persisted sender snapshot and UUID-to-host route.
  Peer UUIDs and chat-route UUIDs remain replyable after a broker restart.
  Qualified sender names include the stable chat key when applicable.
- Destination business rejections, including unknown/stale/full/ambiguous targets
  and missing chats, produce one durable system notice in the originating
  mailbox and chat. Candidates are qualified with the destination host. Notices
  are retained even if the original sender has since been evicted. Successful
  delivery warnings (including old-adapter general-mailbox fallback) also produce
  a durable notice; they are not silently treated as exact-chat delivery.

## Configuration

The service is opt-in through `AGENT_PEERS_FEDERATION=1`. With it unset, the
loader reads no federation files. When enabled:

| File | Contents |
| --- | --- |
| `~/.agent-peers-host` | A stable lowercase local alias, such as `macbook` |
| `~/.agent-peers-fleet.json` | A JSON object mapping fleet aliases to HTTPS Tailscale Serve base URLs |
| `~/.agent-peers-federation-secret` | The separate fleet credential, owner-only mode `0600` |

For example, a fleet map can contain:

```json
{
  "macbook": "https://macbook.example-tailnet.ts.net:8443",
  "studio": "https://studio.example-tailnet.ts.net:8443",
  "omarchy": "https://omarchy.example-tailnet.ts.net",
  "hetzner": "https://hetzner.example-tailnet.ts.net"
}
```

These are placeholder URLs, not installed destinations. Base URLs are origins
(scheme, host, and port when needed), without `/federation`. The Macs use
dedicated HTTPS port **8443**; Linux brokers use **443**. Mac port 443 already
serves unrelated applications, so the federation grants to the Macs allow only
TCP 8443. Existing authorized access is separate. The fleet's effective boundary
(2026-10-31) is:

- Hetzner cannot reach either Mac on port 443.
- Omarchy cannot reach the MacBook on port 443.
- Omarchy retains its pre-existing full access to the Studio, including 443.
  Do not revoke that access to match the federation-only grant.

Verify the effective policy, including other grants, rather than inferring
denial from the narrow federation grant alone.
The configured proxy must forward the service's
`/federation/directory`, `/federation/chats`, `/federation/relay`, and
`/federation/health` paths. The `/federation` mount below covers all of them.
The broker stays bound to localhost. Relay requests do not follow redirects.
Plain HTTP is accepted only for loopback fixtures.

Expose only the federation mount, not the broker's root or whole TCP port:

```sh
# MacBook and Studio: dedicated federation listener
tailscale serve --bg --https=8443 --set-path=/federation http://127.0.0.1:7900/federation

# Linux brokers: federation listener on 443
tailscale serve --bg --https=443 --set-path=/federation http://127.0.0.1:7900/federation
```

This is a deployment recipe, not an automatically executed setup step. Check
existing Serve mappings first and preserve unrelated services; do not use
`serve reset` or Funnel. Match the fleet URL, Serve listener, and grant port.
Remove only the relevant mount with
`tailscale serve --https=8443 --set-path=/federation off` on a Mac, or
`tailscale serve --https=443 --set-path=/federation off` on Linux, not a global reset.
At cutover, verify the federation health route with the separate credential,
that local-only paths such as `/register` are not exposed by this mount, and
that Hetzner is denied both Macs' port-443 services and Omarchy is denied the
MacBook's. Omarchy-to-Studio access must remain unchanged.
Docs/CLI syntax is not live proxy-path or authorization proof.

Reference: [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve),
checked with the installed `tailscale serve --help` on 2026-10-31.

Do not reuse, rotate, or replace the local broker secret during this rollout.
Old running adapters cache it. The federation secret is reread on every incoming
request and outgoing attempt, so repairing federation authentication does not
require restarting client sessions. Missing/invalid federation credentials fail
closed and retain queued mail.

Client project doors are not fleet membership. Do not add client machines to
this map.

## Broker integration

Construct `FederationService` with a shared `db`, config, and synchronous
callbacks:

- `listLocalPeers({query})`: safe local-only projection, including retained
  durable identities. No session tokens, recursive fanout, or wake effects.
- `sendLocal(request)`: normal authenticated local send, using the configured
  synchronous `enqueue` hook for remote addresses.
- `snapshotSender(remoteSendRequest)`: resolves any sending chat to its stable
  key and records its local chat route. Returns the reply UUID and actual mailbox
  owner UUID separately.
- `deliverLocal(message)`: local-only resolution and insertion on that same DB.
- `deliverNotice(notice)`: insert system mail without requiring the original
  recipient to remain live; normal `prev_id` reclaim can recover it later.
- `listLocalChats(peer, {query, limit, offset})` (optional): the broker's chat
  lookup without caller authentication, since the fleet secret authenticates the
  machine. Omitted, `/federation/chats` answers 404. `chats(host, request)` is
  the client side; `/list-chats` authenticates the local caller first.

Attach `enqueue`, `remoteRoute`, `senderForMessage`, and `isLocalHost` to the
broker's addressing dependencies. Invoke `send(request)` outside any transaction
for bare-name discovery. It rechecks local precedence and sender authentication
after the network wait.

Call `handle(request)` before the local secret gate, but route no other API
through federation authentication. The service requires both
`X-Agent-Peers-Federation-Secret` and a configured
`X-Agent-Peers-Federation-Host`. The local `X-Agent-Peers-Secret` is not accepted.

Keep `/list-peers` a **bare JSON array** for old clients. Qualified remote rows
come from `directory()`. Put its `unreachable_hosts` in
`X-Agent-Peers-Unreachable-Hosts`, not a wrapper object. Keep `/ready` protocol 1.

Start the worker only for the active broker; await `stop()` before closing its
DB. Tests can call `tick()` directly. A tick handles at most 32 due records;
concurrent ticks coalesce. Discovery defaults to 1.5 seconds, relay to 2 seconds.
Transport/auth/server failures retry with exponential delay capped at five
minutes, without an age-based mail deletion rule.

## Durable state and recovery

The service adds four tables without rebuilding existing ones:

- `federation_outbox`: pending/delivered/bounced records, attempt count, next
  attempt, and bounded diagnostic status.
- `federation_receipts`: durable UID outcomes, including terminal rejection.
- `federation_routes`: reply UUID and host, not a replicated peer directory.
- `federation_senders`: identity snapshots keyed by local message ID.

No automatic garbage collection removes these receipts or queued mail. Reusing
a UID with different contents is rejected. Duplicate UUID routes from two hosts
are not guessed; use an explicit host.

For rollback, disable federation and restart only the broker in the coordinated
cutover window. Keep the same local secret, database, and adapter processes.
Queued federation rows remain for later recovery. This does not undo Hermes
chat adoption or roll back transcripts.

## Evidence boundary

`tests/federation.test.ts` exercises isolated broker callbacks, temporary
databases/secrets, and a random loopback HTTP port. It covers timeout-after-commit
dedupe, restart/reply routes, auth repair, rejection notices, discovery conflicts,
rollback, and bounded retry. `tests/federation-crash.test.ts` kills actual child
processes after outbox commit, during receive insertion, and after destination
commit, then opens fresh database connections to verify recovery and dedupe.
These checks are not evidence of a configured
Tailscale path, a four-machine deployment, or a model's receipt/reply. Those remain
separate integration and runtime acceptance gates.

`tests/federation-broker.test.ts` uses the actual broker exports for sender
snapshots, chat routes, insertion, notices and polling. It guards against a fake
transport fixture masking different route/rename behavior in the real broker,
and proves the old-Hermes fallback warning reaches the original sender.
