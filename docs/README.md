# Documentation Index

Engineering reference for `agent-peers-mcp`, written truth-from-code. Index checked against
`9be6159` (2026-11-02), the accepted four-machine baseline (v3).

The repository's top-level [`README.md`](../README.md) is the product introduction: what the
project is and how to install it. This directory explains how it works, what it guarantees, and
what is known to be wrong. **Where a document and the code disagree, the code wins.**

Status words used below:

- **Current**: checked against the v3 code.
- **History**: a dated snapshot or a retired design. Do not treat it as current behavior.

## Start here

| Document | Status | What it is |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current | System design: four machines, five peer types, addressing, delivery pipeline, every wake path, broker ownership, federation in brief |
| [../AGENTS.md](../AGENTS.md) | Current | Working context for an AI agent editing this repo: component map, runtime state, and the gotchas that have already caused real bugs |
| [delivery-contract.md](delivery-contract.md) | Normative | Per-harness delivery guarantees, ack semantics, retention. Last updated 2026-10-31. Read before changing delivery code |

## Component references

| Document | Status | Covers |
| --- | --- | --- |
| [components/federation.md](components/federation.md) | Current | Cross-machine federation: addressing contract, authentication, relay outbox and receipts, Tailscale Serve recipe, rollback |
| [components/linux-brokers.md](components/linux-brokers.md) | Current | The `systemd --user` broker and wake units for Omarchy and Hetzner, install and update, network exposure |
| [components/hermes-desktop-wake.md](components/hermes-desktop-wake.md) | Current | The in-process Hermes Desktop plugin that wakes a chat held open in Desktop; safety model, ledgers, operator clear |
| [components/openclaw-peer.md](components/openclaw-peer.md) | Current | The OpenClaw peer type: main-session binding, followup wake, custody ledger, runbook, open risks |
| [components/broker.md](components/broker.md) | Current | Broker daemon: schema, migrations, HTTP endpoints, GC and eviction, ownership arbitration |
| [components/mcp-servers-delivery.md](components/mcp-servers-delivery.md) | Current | The five MCP server surfaces and the `DeliveryState` machine |
| [components/wake-subsystem.md](components/wake-subsystem.md) | Current | Codex idle wake: app-server hosting, desktop chats, busy-turn steering, registry, launch claims, daemon loop |
| [components/cli-ops-tests.md](components/cli-ops-tests.md) | Current | `cli.ts` reference, launchd and systemd deployment, test suite map |

## Wake and launcher guides

| Document | Status | Covers |
| --- | --- | --- |
| [wakeable-codex.md](wakeable-codex.md) | Current for launcher-started Codex | Codex idle wake design and security model. Desktop chats over SSH are covered only in [ARCHITECTURE.md](ARCHITECTURE.md) §7 |
| [wake-daemon.md](wake-daemon.md) | Current for the Codex pass | Wake daemon operations and log reading. The daemon also runs a Hermes pass and an OpenClaw pass; see [ARCHITECTURE.md](ARCHITECTURE.md) §7 |
| [wakeable-droid.md](wakeable-droid.md) | Current | `droidpeer`: native Factory Droid TUI or headless ACP host, wake path, trust boundaries, recovery |
| [evidence/](evidence/) | History | Dated Droid acceptance receipts (2026-09-07) |

## Retired

| Document | Status | Note |
| --- | --- | --- |
| [legacy-hermes-v2.md](legacy-hermes-v2.md) | Current | What retiring the per-conversation Hermes V2 runtime (bd-b2in.9) left behind: data kept, fence kept, source preserved at the local tag `archive/hermes-v2-2026-10-31` |
| [hermes-conversation-bindings.md](hermes-conversation-bindings.md) | History | The V2 per-conversation design. Retired 2026-10-31; the code it describes is gone from `master` |
| [hermes-conversation-t1-activation.md](hermes-conversation-t1-activation.md) | History | V2 T1 activation and rollback runbook. Not an activation guide any more |
| [hermes-conversation-t2-fixtures.md](hermes-conversation-t2-fixtures.md) | History | V2 T2 exact-wake fixtures. Replaced by the stock-Hermes chat wake in `shared/hermes-chat-wake.ts` |

Current Hermes chat mail and wake is described in [ARCHITECTURE.md](ARCHITECTURE.md) §5 and §7, with
the Desktop plugin in [components/hermes-desktop-wake.md](components/hermes-desktop-wake.md).

## Dated analyses and plans (history)

These are snapshots. Many findings have since been fixed, and none were re-verified for v3. Check
the code before acting on one.

| Document | Dated | What it was |
| --- | --- | --- |
| [IMPROVEMENT-REPORT.md](IMPROVEMENT-REPORT.md) | 2026-08-10 | Prioritized improvement plan synthesized from the August analysis |
| [issues/CONFLICTS.md](issues/CONFLICTS.md) | 2026-08-10 | Contract mismatches between components |
| [issues/TECHNICAL-DEBT.md](issues/TECHNICAL-DEBT.md) | 2026-08-10 | Dependencies, dead code, refactoring candidates |
| [issues/SECURITY-CONCERNS.md](issues/SECURITY-CONCERNS.md) | 2026-08-10 | Security assessment with severity and remediation |
| [known-issues-2026-08-08.md](known-issues-2026-08-08.md) | 2026-08-08 | Field reports from one fleet session; several fixed since |
| [plans/cross-machine-federation-tailscale.md](plans/cross-machine-federation-tailscale.md) | August | The federation design. **Built and live**; the contract is now [components/federation.md](components/federation.md) |
| [plans/](plans/) | April | Earlier Codex conversation design and plan |
| [superpowers/](superpowers/) | 2026-04-13 | The original implementation plan and design spec |

## Commands

```bash
bun test              # 579 tests across 66 files (run at 9be6159)
bun run typecheck     # tsc --noEmit; must be clean
bun cli.ts --help     # operator CLI
```

`bun test` needs `node_modules` (`bun install`) because several e2e tests import the MCP SDK.
The broker tests start isolated brokers on their own ports and temporary databases, so they do
not touch a running broker.
