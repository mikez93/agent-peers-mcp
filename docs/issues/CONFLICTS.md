# Cross-Component Conflicts — contract mismatches & inconsistencies

Systemic review of `agent-peers-mcp` at HEAD `63503f2`. Every finding below spans a
component boundary: it is invisible when reading `broker.ts`, `codex-server.ts`,
`claude-server.ts`, `cli.ts` or any single `shared/*.ts` in isolation.

Ordered most severe first. Each finding states the failure mode, the evidence that
establishes it, and the smallest fix. Findings that **look** like bugs but are
deliberate are marked **[BY DESIGN]** and explain why.

> **Orchestrator verification note (2026-08-10).** C1 and C2 were independently
> re-tested against the live deployment before this document was accepted. Both are
> **latent traps, not live defects** — the mechanism is real and the fix is still
> worth making, but neither is currently misbehaving on either machine:
>
> - **C1**: `AGENT_PEERS_STATE_DIR` is unset in the environment, in every LaunchAgent
>   plist, and in the Codex config. Nothing sets it today, so no wake is being
>   suppressed. It is a trap for the next operator who sets it.
> - **C2**: re-run against the *reachable* lifecycle (fresh DB → register a durable
>   peer → broker restart), `durable` survives with its value intact. The reproduction
>   required seeding a DB that has the `durable` column but lacks `hermes` in the
>   `peer_type` CHECK constraint — a state the current migration ordering never
>   produces, because the hermes migration runs before the durable migration. The
>   fragility is genuine (a schema-incomplete rebuild plus a now-false ordering
>   comment) and one migration reorder would make it live, so the fix stands; the
>   severity does not.
>
> Severities below are left as the analyst wrote them; read them together with this
> note. The prioritization in `../IMPROVEMENT-REPORT.md` reflects the corrected view.

---

## C1 — HIGH — `AGENT_PEERS_STATE_DIR` silently disables the entire wake subsystem

**Files**
- Writer: `shared/codex-inbox.ts:99-102`
- Readers: `shared/wake-daemon.ts:95`, `shared/wake-registry.ts:102`, `shared/wake-launch-claims.ts:92`, `shared/bounded-log.ts:56`

The durable inbox resolves its root directory as:

```ts
// shared/codex-inbox.ts:99-102
const rootDir = opts.rootDir
  ?? process.env.AGENT_PEERS_STATE_DIR
  ?? process.env.AGENT_PEERS_CODEX_STATE_DIR
  ?? defaultRootDir();
```

Every consumer in the wake subsystem resolves it as `AGENT_PEERS_CODEX_STATE_DIR ??
defaultRootDir()` — `AGENT_PEERS_STATE_DIR` is not consulted anywhere in
`wake-daemon.ts`, `wake-registry.ts`, `wake-launch-claims.ts` or `bounded-log.ts`.

**What goes wrong.** With `AGENT_PEERS_STATE_DIR` set (and `AGENT_PEERS_CODEX_STATE_DIR`
unset), `CodexInboxStore` writes `<peer>.metadata.json` into the STATE_DIR while
`runWakePass()` scans `~/.agent-peers-codex` for those same metadata files
(`shared/wake-daemon.ts:105` → `readAllInboxMetadata(rootDir)`). It finds none, so every
peer takes the `no_pending_metadata` branch at `shared/wake-daemon.ts:123-126` and is
skipped. That skip is created by `skip()` with `log: false`
(`shared/wake-daemon.ts:233-245`), so under `--quiet-noop` the daemon prints **nothing
at all**. Wakeable Codex sessions stop being woken, silently, with no error and no log
line. The wake registry and launch claims land in the other directory too, so
`repair-wake` cannot diagnose it either.

**Fix.** Add one shared resolver and use it in all five places:

```ts
// shared/state-dir.ts
export function codexStateDir(): string {
  return process.env.AGENT_PEERS_STATE_DIR
    ?? process.env.AGENT_PEERS_CODEX_STATE_DIR
    ?? join(homedir(), ".agent-peers-codex");
}
```

`cli.ts:580-588` already documents this exact precedence as "same precedence as the
WRITERS" — the wake subsystem is the outlier, not the CLI.

---

## C2 — HIGH — A schema migration silently clears every peer's `durable` flag

**Files** `broker.ts:257-289` (`rebuildPeersTableWithNotNullSessionToken`),
`broker.ts:154-165` (migration ordering), `broker.ts:357-372`
(`migrate_peers_add_hermes_peer_type`)

`rebuildPeersTableWithNotNullSessionToken` writes its column list out literally
(`broker.ts:263-283`) and that list contains neither `durable` nor `host`. The ordering
comment at `broker.ts:155-162` argues this is safe because `migrate_peers_add_durable`
runs last. That reasoning protects the **schema** but not the **data**: the rebuild
drops the column with its contents, and the re-add repopulates it with the
`DEFAULT 0` — i.e. ephemeral.

**Evidence (reproduced).** Seeding a pre-hermes DB containing one row with `durable = 1`
and running `initDb()`:

```
BEFORE: durable = { durable: 1 }
[broker] migration: expanded peer_type constraint to include hermes
AFTER : row = { id: "id-1", durable: 0, host: null }
```

**What goes wrong.** `gcStalePeers` (`broker.ts:842-861`) applies
`STALE_THRESHOLD_MS` (60s) to `durable = 0` rows and `DURABLE_RETENTION_MS` (7 days) to
`durable = 1`. After this migration every named agent is deleted 60 seconds after it
stops heartbeating — destroying its stable UUID and orphaning its queued mail. That is
precisely the `ezra-hermes` incident the `DURABLE_RETENTION_MS` comment at
`broker.ts:27-46` was written to prevent. A Hermes agent between turns is not running,
so it cannot re-register to re-flag itself inside that window.

The comment at `broker.ts:158-162` half-acknowledges this ("even if a future rebuild
does drop it, the next startup re-adds it and peers re-flag themselves on
re-registration") but understates the cost: re-flagging requires a `register()` call,
and `heartbeatPeer` (`broker.ts:520-524`) does not set `durable`.

**Fix.** Make the rebuild schema-complete and preserve data, or make it dynamic:

```sql
CREATE TABLE peers_new (..., durable INTEGER NOT NULL DEFAULT 0, host TEXT);
INSERT INTO peers_new (..., durable, host)
  SELECT ..., COALESCE(durable, 0), host FROM peers WHERE session_token IS NOT NULL;
```

Guard the copy with `columnExists(db, "peers", "durable")` so it still works against a
DB that genuinely predates the column. Add a migration test that asserts `durable`
survives the hermes-CHECK rebuild — `tests/migration.test.ts` currently has no
assertion mentioning `durable` or `host`.

---

## C3 — MEDIUM — `cli.ts` contradicts itself about state-dir precedence

**Files** `cli.ts:77-102` (`readUnreadCountsByPeer`) vs `cli.ts:574-610`
(`readAllInboxFiles`)

`readAllInboxFiles` resolves `AGENT_PEERS_STATE_DIR || <runtime var> || <default>` and
carries a comment explaining why that order matters. `readUnreadCountsByPeer`, forty
lines earlier in the same file, resolves only:

```ts
// cli.ts:81
const rootDir = process.env.AGENT_PEERS_CODEX_STATE_DIR ?? join(homedir(), ".agent-peers-codex");
```

**What goes wrong.** With `AGENT_PEERS_STATE_DIR` set, `bun cli.ts wake-status` and
`bun cli.ts status` report `unread=0` for every peer (`cli.ts:321`, `cli.ts:367`) while
`bun cli.ts inboxes` in the same shell correctly shows the mail. The operator's
first-line triage tool understates the backlog to zero — the exact failure the
`readAllInboxFiles` comment warns about, committed in the same file.

**Fix.** Call the shared resolver from C1 in both functions.

---

## C4 — MEDIUM — `epoch` is an undeclared response field that no client reads

**Files** `broker.ts:1433-1434`, `shared/types.ts:57-61` and `69`,
`docs/delivery-contract.md:103-104`

`/register` and `/heartbeat` both return `epoch: BROKER_EPOCH`, but `RegisterResponse`
and `HeartbeatResponse` in `shared/types.ts` declare no such field, so
`shared/broker-client.ts:121-122` types it away. Grepping `epoch` across the repo
returns only `broker.ts` and three test files that re-fetch over raw `fetch` — no
production client reads it.

`docs/delivery-contract.md:103-104` states the capability as delivered:

> Broker restarts stamp a new `BROKER_EPOCH` (returned on register/heartbeat) so
> clients can tell "broker restarted" from "I was evicted".

No client can tell those apart today. The eviction handlers in `codex-server.ts:992-1051`
and `claude-server.ts:573-628` branch on `known === false` alone and log a fixed message
— "evicted, most likely a broker outage >60s" — that guesses at what the epoch would
have answered. The broker's own comment at `broker.ts:1430-1432` says "log-only for
now", which is the honest version.

**Fix.** Either add `epoch?: string` to both response interfaces and have the rejoin
path log `epoch !== lastEpoch ? "broker restarted" : "evicted for cause"`, or soften
`docs/delivery-contract.md:103-104` to say the epoch is *available* rather than *used*.
Adding the field is ~5 lines and makes the doc true.

---

## C5 — MEDIUM — Three `isProcessAlive` implementations with contradictory `EPERM` semantics

**Files** `shared/hermes-claims.ts:36-45`, `shared/wake-launch-claims.ts:72-80`,
`shared/wake-registry.ts:72-80`

`hermes-claims.ts` treats `EPERM` as **alive** — deliberately, with a comment:

```ts
// shared/hermes-claims.ts:42-44
// EPERM means "alive but not ours" — still alive.
return e instanceof Error && "code" in e && (e as { code?: string }).code === "EPERM";
```

The other two use a bare `catch { return false; }` and treat `EPERM` as **dead**.

Additionally, only `hermes-claims.ts` has the PID-reuse guard
(`ownerStillHoldsClaim`, `shared/hermes-claims.ts:47-66`) that cross-checks
`ps -o lstart=` against the lock's `acquired_at`.
`WakeLaunchClaimStore.tryAcquireRoot` (`shared/wake-launch-claims.ts:211-234`) has no
such guard, so after a reboot an unrelated process inheriting the old owner's pid makes
a dead launch claim look permanently held — the same failure the hermes guard was
written for, documented at `shared/hermes-claims.ts:47-52`.

**What goes wrong.** A process owned by another uid (or one the current process cannot
signal) reads as dead in `wake-registry.isLive()` (`shared/wake-registry.ts:193-199`),
so a live wakeable session can be pruned from the registry and stop being woken. In
`wake-launch-claims.isLiveClaim()` the same misread lets `prune()` delete a live claim.

**Fix.** Extract one `shared/proc.ts` exporting `isProcessAlive` (EPERM ⇒ alive) and
`processStartedBefore(pid, iso)`, and have all three call sites use it. `hermes-claims.ts`
is the more correct implementation; converge on it.

---

## C6 — MEDIUM — `broker_session_token_hash` is written by two components and verified by none

**Files** written at `codex-server.ts:1105` and `cli.ts:287`; declared required at
`shared/wake-registry.ts:30`; consumed nowhere.

`hashBrokerSessionToken` binds a wake-registry row to the peer's broker session
incarnation. `validateThread` (`shared/wake-daemon.ts:218-231`) checks thread identity,
cwd and rollout path but never the token hash, and no other code reads the field.

**What goes wrong.** After a peer re-registers (eviction rejoin at
`codex-server.ts:1001-1013`, which rotates `session_token`) the registry row is refreshed
via `registerWakeableSessionIfEnabled` — but if that refresh fails or is skipped, a
stale row keeps pointing at a thread the daemon will still wake. The one field that
could detect the mismatch is inert. It is also a maintenance trap: it looks like a
security control and is not one.

**Fix.** Either have the daemon compare the row's hash against the peer's current broker
`session_token` before calling `startWakeTurn` (`shared/wake-daemon.ts:163`), or delete
the field. Do not leave it write-only.

---

## C7 — MEDIUM — Two competing wake-registration paths; the env path bypasses the identity election

**File** `codex-server.ts:1121-1156` (`resolveWakeRegistrationHints`)

Two mechanisms answer "which thread am I and where is my app-server":

1. **Env hints** — `AGENT_PEERS_WAKE_ENABLED=1` plus `AGENT_PEERS_WAKE_THREAD_ID` /
   `_APP_SERVER_URL` / `_APP_SERVER_PID` (`codex-server.ts:1125-1150`).
2. **Launch claim** — the single-use claim won via `tryAcquireRoot` at
   `codex-server.ts:831-842`, returned as `wakeRootClaim` (`codex-server.ts:1155`).

The single-identity election is gated on `AGENT_PEERS_WAKE_LAUNCH`
(`shared/wake-launch-role.ts:67-69`, `codex-server.ts:830`), *not* on
`AGENT_PEERS_WAKE_ENABLED`. `shared/wakeable-launcher.ts:198-215` (`buildWakeableEnv`)
sets the `WAKE_ENABLED` family on the TUI without `WAKE_LAUNCH`. Any MCP child that
inherits that env therefore skips the election entirely (`wakeLaunch === false` ⇒ role
`standalone` ⇒ `shouldRegisterAsPeer` true) and still writes a wake-registry row from
env hints — the multi-identity scenario the whole election exists to prevent, described
at length in `shared/wake-launch-role.ts:5-37`.

The blast radius is limited because `WakeRegistry.upsert` filters on
`peer_id !== … && thread_id !== …` (`shared/wake-registry.ts:126-128`), so the last
writer wins rather than accumulating rows — but "last writer wins" is not the intended
contract, and the winner may not be the thread the user is talking to.

**Fix.** Gate the env branch on the same flag: `if (process.env.AGENT_PEERS_WAKE_ENABLED
=== "1" && !isWakeLaunchEnv(process.env))`. If the env path is only a legacy fallback,
say so in a comment and add a startup warning when both signals are present.

---

## C8 — MEDIUM — `wake-launch-claims` uses a fixed temp filename for a multi-writer file

**File** `shared/wake-launch-claims.ts:49-56`

```ts
const tempPath = `${path}.tmp`;   // shared/wake-launch-claims.ts:50
```

Two different processes write the same claim: the launcher calls `update()` twice
(`shared/wakeable-launcher.ts:278-284` and `:319`) while the MCP child calls
`consume()` (`codex-server.ts:1113`). Both go through this `atomicWriteJson`. Two
concurrent writers share `<claim-id>.json.tmp`, so one can `rename()` the other's
partially-written file into place, or clobber it mid-write.

`shared/wake-daemon.ts:380` and `:559` already solve this with
`` `${path}.${process.pid}.tmp` `` — the codebase knows the pattern; two of five
`atomicWriteJson` copies use it (`shared/wake-registry.ts:57` and
`shared/codex-inbox.ts:67` are single-writer-per-process, so lower risk).

**Fix.** Use `` `${path}.${process.pid}.${Date.now()}.tmp` `` in
`shared/wake-launch-claims.ts:50`. Better: one shared `atomicWriteJson` (see
TECHNICAL-DEBT D10).

---

## C9 — LOW — `gcOldMessages` retention comment contradicts the constant beside it

**File** `broker.ts:863-868` vs `broker.ts:877` and `:886`

```
// Unacked rows follow durable-peer retention (7 days) — past that ...   (863-867)
export const UNACKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;            (877)
```

The code uses 30 days; `gcOldMessages`'s own inner comment (`broker.ts:880-884`) also
says 30 days and explains why. The block comment above the constant is stale by a
factor of four. An operator reading it will mis-predict when unacked mail expires.

**Fix.** Delete the "(7 days)" clause from `broker.ts:865`.

---

## C10 — LOW — `codex-inbox.ts` header documents the wrong override variable

**File** `shared/codex-inbox.ts:3-4` vs `:99-102`

The header says the store "Lives at `~/.agent-peers-codex/<peer-id>.json` (overridable
via `AGENT_PEERS_CODEX_STATE_DIR`)". `AGENT_PEERS_STATE_DIR` takes precedence over it
(`:100`), and `claude-server.ts:426` passes an explicit `rootDir` that overrides both.
Anyone debugging C1 or C3 starts from this comment and is sent to the wrong variable.

**Fix.** State the full precedence chain in the header.

---

## C11 — LOW — The "MUST stay last" migration comment is already false

**File** `broker.ts:155-162` vs `:162-164`

The comment asserts `migrate_peers_add_durable` "MUST stay last among the peers
migrations". `migrate_peers_add_host(db)` runs after it at `broker.ts:164`. Being after
the rebuilds is the *correct* position for `host`, so this is a documentation defect,
not a live bug — but the invariant as written is violated by the line two below it,
which is exactly how C2 becomes easy to reintroduce.

**Fix.** Restate as "must run after any migration that can rebuild the peers table",
and list `host` alongside `durable`.

---

## C12 — LOW — `startWakeTurn` accepts two parameters and discards them

**File** `shared/app-server-client.ts:162-177`

The signature takes `wakeId` and `pendingSignature`; the RPC body sends only
`threadId`, `clientUserMessageId` and `input`. Both values are silently dropped.

The tests do not catch this: `tests/wake-daemon.test.ts:72` and `:87-90` record
`pendingSignature` off a **fake** client that stores what it receives, so the assertion
passes regardless of what the real client does. See TECHNICAL-DEBT D14.

**Fix.** Either forward them (`_meta: { wakeId, pendingSignature }`) if the app-server
accepts extra fields, or drop them from the interface at
`shared/app-server-client.ts:33-39` and from the call site at
`shared/wake-daemon.ts:163-169`.

---

## C13 — LOW — Eight environment variables are read but absent from the README table

**File** `README.md:334-347`

Read in code, missing from the documented table:

| Variable | Read at |
|---|---|
| `AGENT_PEERS_STATE_DIR` | `claude-server.ts:74`, `shared/codex-inbox.ts:100`, `shared/hermes-claims.ts:30`, `hermes-server.ts:25`, `cli.ts:585` |
| `AGENT_PEERS_ENABLED` | `claude-server.ts:347`, `codex-server.ts:811` |
| `AGENT_PEERS_EPHEMERAL` | `claude-server.ts:421`, `codex-server.ts:889` |
| `AGENT_PEERS_HEARTBEAT_MS` | `claude-server.ts:46`, `codex-server.ts:86` |
| `AGENT_PEERS_RUNTIME` | `codex-server.ts:87`, `shared/codex-inbox.ts:53`, `hermes-server.ts:22` |
| `AGENT_PEERS_HERMES_STATE_DIR` | `hermes-server.ts:26`, `shared/hermes-claims.ts:31`, `cli.ts:562` |
| `AGENT_PEERS_SECRET_PATH` | `broker.ts:1494`, `claude-server.ts:60`, `codex-server.ts:106` |
| `AGENT_PEERS_SPAWN_BROKER` | `shared/ensure-broker.ts:57`, `shared/broker-client.ts:82` |

`AGENT_PEERS_ENABLED` and `AGENT_PEERS_SPAWN_BROKER` appear in README prose
(`README.md:99-100`, `:189`) but not the table; `AGENT_PEERS_STATE_DIR` appears only in
`docs/components/wake-subsystem.md`. `AGENT_PEERS_HEARTBEAT_MS` and
`AGENT_PEERS_RUNTIME` appear in no document at all.

**Fix.** Extend the table. `AGENT_PEERS_STATE_DIR` deserves an explicit warning given C1.

---

## C14 — LOW — `AGENT_PEERS_HERMES_STATE_DIR` moves the kill switch but not the mailbox

**Files** `hermes-server.ts:24-29`, `shared/hermes-claims.ts:29-34`, `shared/codex-inbox.ts:99-102`

`AGENT_PEERS_HERMES_STATE_DIR` relocates the Hermes `disabled` flag file and the
`name-claims/` election directory. It does **not** relocate the Hermes inbox:
`CodexInboxStore` consults `AGENT_PEERS_STATE_DIR` then `AGENT_PEERS_CODEX_STATE_DIR`,
never the Hermes variable, so `defaultRootDir()` (`shared/codex-inbox.ts:52-55`) puts it
back at `~/.agent-peers-hermes`. An operator who relocates Hermes state gets a split
layout with no warning.

**Fix.** Have `CodexInboxStore` consult `AGENT_PEERS_HERMES_STATE_DIR` when
`AGENT_PEERS_RUNTIME === "hermes"`, mirroring the runtime switch already present at
`shared/codex-inbox.ts:52-55`.

---

## C15 — LOW — `BROKER_EPOCH` and `PROTECTION_GENERATION` are two names for one fact

**File** `broker.ts:906` and `broker.ts:1301`

Both are `randomUUID()` minted once per broker process and both answer "did the broker
restart under me". They are surfaced to different audiences (`generation` to the
MacGuardian reaper via `/v1/protection/check`, `epoch` to peers via `/health`, `/ready`,
`/register`, `/heartbeat`) and can never disagree.

**[PARTLY BY DESIGN]** The split is defensible as an API-versioning boundary: the reaper
is an external codebase and pinning it to `generation` avoids coupling it to peer-facing
fields. Worth a one-line comment on each saying so, otherwise the next reader will
"consolidate" them and break the reaper contract described at `broker.ts:893-905`.

---

## Deliberate designs confirmed, NOT defects

Verified against the surrounding comments before flagging; all are intentional:

- **`listPeers` performs no GC** (`broker.ts:556-563`). Removed on purpose — the
  opportunistic GC caused the 2026-07-14 post-wake mass eviction (77 → 9 peers).
- **No `authPeer()` helper** (`broker.ts:500-510`). Every mutation binds `session_token`
  in its own `WHERE` clause to close a TOCTOU window against reclaim-rotation.
- **Shutdown does not flush `pendingAcks` and does not unregister**
  (`codex-server.ts:50-54`, `:1053-1066`). Flushing would ack undelivered mail;
  unregistering would break reclaim-by-name.
- **Duplicate ephemeral Hermes rows beside a durable one** are name-claim election
  losers, not a bug (`docs/delivery-contract.md:83-85`, `shared/hermes-claims.ts:1-20`).
- **`known === undefined` never triggers re-registration** (`shared/types.ts:65-69`,
  `codex-server.ts:996`, `claude-server.ts:577`). Silence means "old broker", not
  "evicted".
- **`claude-server` acks at poll time while `codex-server` acks only at confirm time.**
  Different but correct: Claude persists durably *before* acking
  (`claude-server.ts:474-485`), so the ack is safe; Codex has no equivalent pre-ack
  persistence guarantee at that point. Documented in `docs/delivery-contract.md:31-71`.
  Note that `DeliveryState` therefore means different things in the two servers — worth
  a comment at `claude-server.ts:79`.
