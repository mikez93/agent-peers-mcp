# Linux fleet brokers (Omarchy, Hetzner)

Sources: `deploy/linux/`, `shared/ensure-broker.ts`, `broker.ts` (`--owner=systemd`).
Installed 2026-10-31 (bd-b2in.8) on `mike@omarchy-01` and `openclaw@hetzner-box-01`.

## Contract

Same as the macOS LaunchAgent, with systemd --user as the service manager:

- `agent-peers-broker.service` runs `bun ~/agent-peers-mcp/broker.ts --owner=systemd`
  on loopback 7900 with `Restart=always`. The broker reports `owner: "systemd"` on
  `/ready`; the readiness probe accepts it on every platform. It is never spelled
  `launchd`.
- `agent-peers-wake.service` runs `bin/codex-peer daemon 5`, which reruns
  `wake-daemon.ts` from the checkout every 5 s, so a fast-forward of the checkout
  is picked up without touching the unit.
- A client that finds the broker down runs `systemctl --user start agent-peers-broker`
  (`ensureBroker`), the Linux twin of `launchctl kickstart`.
- Lingering is enabled (`loginctl enable-linger`), so both units run without a login.
- Federation is on in the unit (`AGENT_PEERS_FEDERATION=1`) and reads
  `~/.agent-peers-host`, `~/.agent-peers-fleet.json` and
  `~/.agent-peers-federation-secret` (0600, one fleet-wide value, separate from the
  local secret). `install.sh` checks for them. If they are missing or unusable the
  broker still starts, logs `federation config unusable, federation stays off`, and
  serves only local peers (`startFederation` in `broker.ts`).

## Install or update

```sh
git clone https://github.com/mikez93/agent-peers-mcp.git ~/agent-peers-mcp   # first time
AGENT_PEERS_REF=main sh ~/agent-peers-mcp/deploy/linux/install.sh <alias>      # alias: omarchy | hetzner
```

The script installs bun into `~/.bun` if missing, fast-forwards the checkout,
installs the units, enables linger, starts both services and prints `/ready`.
Re-running it is the update path. Logs: `journalctl --user -u agent-peers-broker`.

## Network

Only `/federation` is exposed, over Tailscale Serve, tailnet-only:

```sh
sudo tailscale set --operator=$USER          # once per box
tailscale serve --bg --set-path /federation http://127.0.0.1:7900/federation
```

Serve strips the mount and appends the remainder to the target, so
`https://<box>/federation/relay` reaches the broker's `/federation/relay` and
nothing else is reachable (`/health`, `/ready` answer 404 from Serve). The Macs
serve the same mount on port **8443**; the fleet map uses `:8443` for `macbook`
and `studio`. That keeps the internet-facing Hetzner node (and Omarchy toward the
MacBook) away from the Macs' other 443 mounts. Omarchy keeps its pre-existing
full access to the Studio (Mike, 2026-10-20); 8443 adds nothing there.

Tailnet policy (applied 2026-10-31 with tests): two grants, `omarchy-01` and the
Hetzner node to each other on tcp:443 and to the two Macs on tcp:8443. Tests:
Omarchy accepts Hetzner:443 and both Macs:8443, denies Hetzner:22 and MacBook:443;
Hetzner accepts Omarchy:443 and both Macs:8443, denies Omarchy:22, Studio:22,
Studio:443 and MacBook:443. The Macs already reach everything on both boxes.

## Rollback (scoped)

Each step removes only what this component added:

```sh
systemctl --user disable --now agent-peers-wake.service agent-peers-broker.service   # per box
tailscale serve --https=443 --set-path /federation off                               # this mount only
```

Policy: fetch fresh (`ts-admin policy get --output <file>`), delete only the two
federation grants and the two federation tests (the comment block names them),
validate, and `ts-admin policy apply --apply <file>`; the ETag check keeps any
later unrelated change. Never put back a whole saved copy. Fleet files
(`~/.agent-peers-host`, `~/.agent-peers-fleet.json`, `~/.agent-peers-federation-secret`)
are inert without `AGENT_PEERS_FEDERATION=1` and can stay.

## Verified

- Hetzner: units active, `/ready` owner=systemd protocol 1 with the federation
  capability; `/federation/health` answers 401 without the fleet secret and
  `{"ok":true,"host":"hetzner"}` with it, from the MacBook and from Omarchy.
- Omarchy: units active, same readiness; `cli.ts send <name>@hetzner` from Omarchy
  was queued, relayed and read by a probe recipient on Hetzner (sender shown as
  `<name>@omarchy`).
- A client squatter is evicted by a `--owner=systemd` broker (tests/broker-ownership).
