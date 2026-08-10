# Documentation Index

Generated documentation for `agent-peers-mcp`, current as of `63503f2` (2026-08-10).

The repository's top-level [`README.md`](../README.md) is the product introduction — what the
project is and how to install it. This directory is the engineering reference: how it actually
works, what its guarantees are, and what is wrong with it.

## Start here

| Document | What it is |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design: components, identity model, delivery pipeline, broker ownership, deliberate non-goals |
| [../AGENTS.md](../AGENTS.md) | Working context for an AI agent editing this repo — patterns, and the ten gotchas that have already caused real bugs |
| [delivery-contract.md](delivery-contract.md) | **Normative.** Per-harness delivery guarantees, ack semantics, election behavior. Read before changing delivery code |
| [IMPROVEMENT-REPORT.md](IMPROVEMENT-REPORT.md) | Prioritized, actionable improvement plan synthesized from all analysis |

## Component references

Implementation-level detail, written truth-from-code.

| Document | Covers |
| --- | --- |
| [components/broker.md](components/broker.md) | The broker daemon: schema, migrations, every HTTP endpoint, GC/eviction, ownership arbitration, permission trust boundary |
| [components/mcp-servers-delivery.md](components/mcp-servers-delivery.md) | The three MCP server surfaces and the `DeliveryState` machine |
| [components/wake-subsystem.md](components/wake-subsystem.md) | Codex idle wake: app-server hosting, registry, launch claims, daemon loop |
| [components/cli-ops-tests.md](components/cli-ops-tests.md) | `cli.ts` operator reference, launchd deployment, test suite map |

## Issue analysis

| Document | Covers |
| --- | --- |
| [issues/CONFLICTS.md](issues/CONFLICTS.md) | Contract mismatches between components; inconsistent implementations of the same concept |
| [issues/TECHNICAL-DEBT.md](issues/TECHNICAL-DEBT.md) | Dependencies, dead code, refactoring candidates |
| [issues/SECURITY-CONCERNS.md](issues/SECURITY-CONCERNS.md) | Security assessment with severity and remediation |

## Design and history

| Document | Status |
| --- | --- |
| [wakeable-codex.md](wakeable-codex.md) | Current — wake design and security model |
| [wake-daemon.md](wake-daemon.md) | Current — wake daemon operations and log reading |
| [plans/cross-machine-federation-tailscale.md](plans/cross-machine-federation-tailscale.md) | **Designed, deliberately not built.** Tracked by bd-21r.8 |
| [known-issues-2026-08-08.md](known-issues-2026-08-08.md) | Historical snapshot — many entries fixed since; check status in `components/cli-ops-tests.md` before trusting one |
| [plans/](plans/) | Older design records; history, not current behavior |

## Commands

```bash
bun test              # 239 tests across 31 files
bunx tsc --noEmit     # typecheck — must be clean
bun cli.ts --help     # operator CLI
```
