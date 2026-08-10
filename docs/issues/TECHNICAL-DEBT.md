# Technical Debt — dependencies, dead code, refactoring candidates

Systemic review of `agent-peers-mcp` at HEAD `63503f2`. Every "dead" claim below was
verified by grepping the whole repo **including `tests/`** before being listed; the
evidence is given inline. Ordered by severity of consequence, not by size.

Cross-references to `CONFLICTS.md` use its `C<n>` ids.

---

## Part 1 — Dead code and write-only state

### D1 — HIGH — `WakeRegistry.markSeen()` has zero callers, so `last_seen_at` never advances

**File** `shared/wake-registry.ts:181-191`

```
$ grep -rn "markSeen" --include="*.ts" .
shared/wake-registry.ts:181:  async markSeen(peerId: PeerId, at = new Date().toISOString()): Promise<void> {
```

One hit: the definition. Not called by `codex-server.ts`, `cli.ts`, the wake daemon, or
any test.

**Consequence — this is not merely unused code.** `last_seen_at` is only ever written by
`upsert()` (`shared/wake-registry.ts:124-134`, called at `codex-server.ts:1092` and
`cli.ts:274`), i.e. at registration time. `prune()` (`shared/wake-registry.ts:152-172`)
computes a dead row's age from `last_seen_at` and keeps it only while
`ageMs <= deadGraceMs` (30 min default, `shared/wake-daemon.ts:67`). So a session
registered three hours ago and killed one second ago is pruned on the very next wake
pass instead of getting its 30-minute diagnostic grace window — the grace window
described in the comment at `shared/wake-registry.ts:147-151` does not work for any
session older than `deadGraceMs`.

**Fix.** Call `markSeen(entry.peer_id)` from `runWakePass` on every successful
`readThread` (around `shared/wake-daemon.ts:148`), or drop `last_seen_at` from the prune
predicate and use `updated_at`. Add a test that a long-lived-then-dead entry survives one
pass.

### D2 — MEDIUM — `broker.ts` `listAllMessages` / `InspectMessage` are dead and duplicated in `cli.ts`

**File** `broker.ts:1124-1168`

```
$ grep -rn "listAllMessages" --include="*.ts" .
broker.ts:1137:export function listAllMessages(
```

Definition only — no production caller, no test. `InspectMessage` (`broker.ts:1124-1135`)
is referenced solely as this function's return type.

`cli.ts:400-464` (`cmdMessages`) reimplements the identical query — same `LEFT JOIN`s,
same `active_lease` CASE expression, same 500-row cap, same `ACKED / LEASED / PENDING`
semantics — against a read-only SQLite handle. The `broker.ts` copy is the abandoned one.

**Consequence.** Two definitions of the operator-facing message-status vocabulary. A fix
to one (e.g. adding `message_uid`, which `cli.ts:653-660` already handles and
`broker.ts:1145-1166` does not) silently misses the other.

**Fix.** Delete `listAllMessages` and `InspectMessage`. If a shared definition is wanted
later, it belongs in `shared/`, not in the daemon that deliberately refuses to serve
message bodies over HTTP (`broker.ts:1446-1448`).

### D3 — MEDIUM — `broker.ts` `listOrphanedMessages` is production-dead and duplicated in `cli.ts`

**File** `broker.ts:1105-1113`

```
$ grep -rn "listOrphanedMessages" --include="*.ts" .
broker.ts:1105:export function listOrphanedMessages(db: Database): OrphanMessage[] {
tests/broker.test.ts:18:  listOrphanedMessages,
tests/broker.test.ts:634:  const orphans = listOrphanedMessages(db);
```

Tests only. The shipping path is `cli.ts:466-496` (`cmdOrphans`), which inlines the same
`LEFT JOIN peers ... WHERE p.id IS NULL AND m.acked = 0`.

**Consequence.** `tests/broker.test.ts:634` exercises the *unused* copy, so it cannot
catch a regression in the copy operators actually run.

**Fix.** Point `cmdOrphans` at `listOrphanedMessages` (it already opens the DB), or
delete the broker copy and move the test to cover `cli.ts`. Do not leave the tested
implementation and the shipped implementation as separate code.

### D4 — MEDIUM — `broker_session_token_hash` is written by two components and read by none

Covered in detail as **C6**. Listed here because it is also the clearest instance of
"state written but never read" in the codebase: `codex-server.ts:1105` and `cli.ts:287`
compute it, `shared/wake-registry.ts:30` requires it, nothing consumes it.

### D5 — LOW — `WakeRegistry.getByPeerId()` has zero callers

**File** `shared/wake-registry.ts:174-179`. Grep returns the definition only — no
production caller, no test. Delete, or use it in `cli.ts cmdRetire`
(`cli.ts:203-217`), which currently does a manual `list({includeStale:true}).find(...)`
scan that this method exists to replace.

### D6 — LOW — `clearTabTitle` is imported into both servers and never called

**Files** `claude-server.ts:31`, `codex-server.ts:68`

Both import `clearTabTitle` alongside `clearTabTitleSync`. Only the `Sync` variant is
used (`claude-server.ts:367,374,661`; `codex-server.ts:787,794,1162`). The async variant
is defined at `shared/tab-title.ts:110` and called from nowhere.

**Fix.** Drop the import from both servers and delete `clearTabTitle` from
`shared/tab-title.ts`, or document why an async clear is retained for a code path that
only ever runs during synchronous death handlers.

### D7 — LOW — `EMPTY_CODEX_INBOX_STATE` has zero references

**File** `shared/codex-inbox.ts:291` (`export { EMPTY_STATE as EMPTY_CODEX_INBOX_STATE }`).
Grep returns that line only. `EMPTY_STATE` itself (`:43`) is likewise unreferenced —
every reset path constructs `{ unread: [] }` inline (`:165`, `:184-186`, `:199`).
Delete both.

### D8 — LOW — `consumeUnreadMessages` and `getUnreadMessageMetadata` are tests-only

**File** `shared/codex-inbox.ts:161-171` and `:142-147`

`consumeUnreadMessages` is referenced by `tests/codex-inbox-store.test.ts:47,211` and
`tests/review-fixes-20260810.test.ts:76`, never by a server. It is superseded by
`removeByIds` for exactly the reason the comment at `shared/codex-inbox.ts:173-178`
gives ("A plain consumeUnreadMessages() would drop EVERYTHING"). Keeping a
known-dangerous method alive purely to test it is a footgun — a future contributor will
reach for the shorter name.

`getUnreadMessageMetadata` is referenced by `tests/codex-inbox-store.test.ts:148` only;
production reads the metadata *files* directly (`shared/wake-daemon.ts:247-269`,
`cli.ts:90-101`) rather than going through the store.

**Fix.** Delete `consumeUnreadMessages` and rewrite its tests against `removeByIds`.
Keep `getUnreadMessageMetadata` only if the daemon is refactored to use it.

### D9 — LOW — The launcher's MCP-env config args are superseded by the claim handshake

**Files** `shared/wakeable-launcher.ts:109-129` (`buildMcpEnvConfigArgs`),
`:198-215` (`buildWakeableEnv`), consumed at `:83-107` and `:303-310`

The launcher's own comment states the mechanism is inert:

```
// shared/wakeable-launcher.ts:275-277
// (The resume command's own -c env is ignored in --remote mode, where
// the app-server, not the TUI, spawns the MCP; the claim is authoritative.)
```

`buildMcpEnvConfigArgs` output is passed to `codex resume --remote`
(`shared/wakeable-launcher.ts:94-102`), and `buildWakeableEnv` sets the same variables in
the TUI's process env — neither reaches the app-server that actually spawns the MCP.
Both are exported and unit-tested (`tests/wakeable-launcher.test.ts:80-88, 164-168`),
which makes them look load-bearing.

This is also the mechanism behind **C7**: the leftover env is what lets an MCP child skip
the identity election.

**Fix.** Delete both, or add a comment marking them as a compatibility shim for
non-`--remote` launches and gate their use accordingly.

### D10 — LOW — Unreachable-in-practice recursion in `tryAcquireRoot`

**File** `shared/wake-launch-claims.ts:211-234`

On a dead-owner reclaim the method `unlink`s the lock and calls itself
(`:228-229`) with no depth bound. Two children racing reclaims can in principle ping-pong.
It terminates in practice because `wx` succeeds for one of them, but the sibling
implementation in `shared/hermes-claims.ts:80-113` solves the same problem with a bounded
`for (let attempt = 0; attempt < 3; …)` loop *and* an atomic `rename`-to-tombstone that
arbitrates the reclaim race (`shared/hermes-claims.ts:99-110`).

**Fix.** Port the hermes bounded-loop + rename-tombstone approach here. See C5 — these
two files should share one lock primitive.

---

## Part 2 — Duplication and coupling

### D11 — MEDIUM — Five hand-rolled `atomicWriteJson`, three `isProcessAlive`, two promise-chain mutexes

| Primitive | Copies |
|---|---|
| `atomicWriteJson` | `shared/codex-inbox.ts:57-80`, `shared/wake-registry.ts:50-63`, `shared/wake-launch-claims.ts:49-56`, `shared/wake-daemon.ts:378-386`, `shared/wake-daemon.ts:556-565` |
| `isProcessAlive` | `shared/hermes-claims.ts:36-45`, `shared/wake-launch-claims.ts:72-80`, `shared/wake-registry.ts:72-80` |
| promise-chain mutex | `shared/async-lock.ts:6-18` (`createAsyncLock`), plus private `withLock` re-implementations at `shared/codex-inbox.ts:262-275` and `shared/wake-registry.ts:220-233` |

The copies have **diverged**, which is what turns duplication into defects:

- Temp-file naming differs (fixed `.tmp` vs pid-suffixed) — see **C8**.
- `EPERM` handling differs and PID-reuse guarding differs — see **C5**.
- Only `codex-inbox.ts` fail-closes on file permissions (`:217-248`); `wake-registry.ts`
  checks perms but returns empty silently (`:203-209`); `wake-launch-claims.ts:290-299`
  checks none.

**Fix.** Extract `shared/atomic-json.ts` (write + fail-closed read, pid-suffixed temp)
and `shared/proc.ts` (`isProcessAlive`, `processStartedBefore`). Have
`CodexInboxStore` and `WakeRegistry` use `createAsyncLock()` instead of their private
copies. Roughly 120 lines removed and three classes of divergence closed.

### D12 — LOW — Message-status and orphan queries exist in two places each

Consolidation of D2 + D3. The SQL that answers "what is the state of the message queue"
lives in both `broker.ts` (dead) and `cli.ts` (live). Add the missing `message_uid`
column to whichever copy survives — `cli.ts:653-660` already guards for its absence on
pre-migration DBs, and that guard is the behavior worth keeping.

### D13 — LOW — `ackMessages` builds its per-token report outside the transaction

**File** `broker.ts:771-808`

The `ackTx` transaction snapshots `existing` and runs the `UPDATE` atomically
(`broker.ts:771-780`), which is correct. The per-token classification that follows
(`:789-808`) issues fresh `SELECT`s **after** the transaction commits — including a peer
lookup at `:798-800`. A concurrent reclaim between commit and classification can flip a
token's report from `expired` to `wrong_session`.

The reported `acked` count is authoritative and unaffected, so this is a diagnostic
accuracy issue rather than a delivery bug. Still, `AckMessagesResponse.results`
(`shared/types.ts:116-117`) is documented as the caller's evidence for why an ack did not
land, and `codex-server.ts:573-579` logs it verbatim.

**Fix.** Move the classification `SELECT`s inside `ackTx` and return the finished
`results` array from the transaction.

---

## Part 3 — Dependencies and build

### D14 — LOW — A test asserts against a fake that is more capable than the real client

**Files** `tests/wake-daemon.test.ts:72, 87-90` vs `shared/app-server-client.ts:162-177`

The test's fake `startWakeTurn` records `pendingSignature` into `startCalls`. The real
`CodexAppServerWsClient.startWakeTurn` accepts the parameter and never sends it (C12).
The test therefore passes whether or not the real client transmits the signature — it
cannot fail when the intended behavior breaks.

**Fix.** Either assert the wire payload (`tests/app-server-client.test.ts` already stands
up a fake WebSocket server for `setThreadName` at `:109-141`; use the same harness), or
remove the parameter and the assertion together.

### D15 — LOW — `tsconfig.types` names a transitive package, not the declared devDependency

**Files** `tsconfig.json` (`"types": ["bun-types"]`) vs `package.json:14-17`
(`"@types/bun": "^1.3.11"`)

`bun-types` is present in `node_modules` only as a transitive dependency of `@types/bun`.
`bunx tsc --noEmit` currently passes, so it resolves today — but a hoisting change or a
`@types/bun` major that stops depending on `bun-types` would silently drop every Bun
global from type checking, turning `Bun.spawn`, `Bun.serve` and `Bun.hash` into `any`
across `broker.ts`, `shared/summarize.ts` and `shared/peer-context.ts`.

**Fix.** `"types": ["@types/bun"]`, or add `bun-types` as an explicit devDependency.

### D16 — LOW — No `typecheck` or `lint` script

**File** `package.json:7-10` defines only `broker` and `test`. `bunx tsc --noEmit` passes
cleanly at HEAD and takes a few seconds — worth wiring as `"typecheck": "tsc --noEmit"`
so CI and pre-commit can run it.

### D17 — Verified clean: no circular imports, no unused runtime dependencies

Programmatic DFS over the import graph of `shared/*.ts` reports **no cycles**. The graph
is a shallow tree: `types.ts` is a leaf that five modules import; `wake-daemon.ts` and
`wakeable-launcher.ts` are the only modules with more than one intra-`shared` edge, and
no `shared/*` module imports `broker.ts`, `cli.ts` or any server. That layering is worth
preserving.

`package.json` declares one runtime dependency, `@modelcontextprotocol/sdk`, imported by
`claude-server.ts:19-24` and `codex-server.ts:56-61`. Both devDependencies
(`@types/bun`, `typescript`) are used. Nothing to remove — subject to D15.

---

## Refactoring candidates, ranked by value

1. **`shared/state-dir.ts`** — one resolver for all inbox/registry/claims paths. Fixes
   C1 (high, silent wake-subsystem failure) and C3, and removes a whole class of future
   split-brain bugs. Smallest change with the largest correctness payoff.
2. **`shared/atomic-json.ts` + `shared/proc.ts`** — collapses D11's five and three
   copies; fixes C5 and C8 as a side effect.
3. **`broker.ts` is 1,551 lines and holds five concerns** — schema/migrations
   (`:94-372`), peer CRUD (`:374-607`), the message pipeline (`:609-891`), the process
   protection service (`:893-1093`), and the HTTP layer (`:1170-1543`). The protection
   service in particular is an independent product with an external consumer contract
   (`:893-905`) and shares nothing with messaging except the `Database` handle. Splitting
   it into `broker/protection.ts` would cut the file by ~200 lines and make that contract
   reviewable on its own.
4. **Delete the dead surface** — D2, D3, D5, D6, D7, D8, D9 together remove roughly 150
   lines and, more importantly, remove three cases where the *tested* implementation and
   the *shipped* implementation are different code.
