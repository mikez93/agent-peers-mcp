#!/bin/sh
# Install or update the Agent Peers broker and wake loop on a Linux fleet box.
# Idempotent. Run as the box's agent user, e.g. `sh deploy/linux/install.sh hetzner`.
#
#   $1  this box's federation alias (lowercase; written to ~/.agent-peers-host)
#   AGENT_PEERS_REF   git ref to check out in ~/agent-peers-mcp (default: main)
#
# What it does: bun in $HOME/.bun (official installer) if missing; clone or
# fast-forward ~/agent-peers-mcp from the fleet fork; install the two user units;
# enable lingering so they run without a login; start them. The federation fleet
# map and secret are NOT generated here: copy ~/.agent-peers-fleet.json and
# ~/.agent-peers-federation-secret (0600) from an existing fleet box first.
set -eu
alias_name="${1:?usage: install.sh <host-alias>}"
ref="${AGENT_PEERS_REF:-main}"
repo_url="https://github.com/mikez93/agent-peers-mcp.git"
root="$HOME/agent-peers-mcp"
units="$HOME/.config/systemd/user"
here="$(cd "$(dirname "$0")" && pwd)"

case "$alias_name" in *[!a-z0-9.-]*|"") echo "alias must be lowercase [a-z0-9.-]" >&2; exit 2;; esac

if [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo "== installing bun into $HOME/.bun"
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash >/dev/null
fi
echo "bun: $("$HOME/.bun/bin/bun" --version)"

if [ ! -d "$root/.git" ]; then
  echo "== cloning $repo_url ($ref)"
  git clone -q "$repo_url" "$root"
fi
git -C "$root" fetch -q origin
git -C "$root" checkout -q "$ref" 2>/dev/null || git -C "$root" checkout -q -B "$ref" "origin/$ref"
git -C "$root" merge -q --ff-only "origin/$ref" 2>/dev/null || true
echo "checkout: $(git -C "$root" rev-parse --short HEAD) ($ref)"
(cd "$root" && "$HOME/.bun/bin/bun" install --frozen-lockfile >/dev/null 2>&1 || "$HOME/.bun/bin/bun" install >/dev/null)

printf '%s\n' "$alias_name" > "$HOME/.agent-peers-host"
for f in "$HOME/.agent-peers-fleet.json" "$HOME/.agent-peers-federation-secret"; do
  [ -f "$f" ] || { echo "missing $f: copy it from a fleet box before starting the broker" >&2; exit 3; }
done
chmod 600 "$HOME/.agent-peers-federation-secret"

mkdir -p "$units"
cp "$here/agent-peers-broker.service" "$here/agent-peers-wake.service" "$units/"
systemctl --user daemon-reload
loginctl enable-linger "$(id -un)" 2>/dev/null || sudo loginctl enable-linger "$(id -un)"
systemctl --user enable --now agent-peers-broker.service agent-peers-wake.service
systemctl --user restart agent-peers-broker.service
sleep 2
systemctl --user --no-pager --lines=0 status agent-peers-broker.service agent-peers-wake.service | grep -E "agent-peers|Active:"
echo "== readiness"
secret="$(cat "$HOME/.agent-peers-secret")"
curl -fsS -H "X-Agent-Peers-Secret: $secret" http://127.0.0.1:7900/ready; echo
