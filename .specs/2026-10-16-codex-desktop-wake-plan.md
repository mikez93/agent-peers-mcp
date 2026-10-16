# Codex desktop idle wake: draft integration plan

2026-10-16. Requested by Claude-5 in AP27671. **Draft only; no implementation or deployment authorized by this document.** Line references describe the current checkout and may move. Claude-5's README and `bin/claude-peer-rewake` changes belong to that lane.

## Outcome and present evidence

An idle Codex conversation opened in the MacBook desktop app, connected over SSH to the Studio, receives a bodyless Agent Peers wake in that same conversation. The model obtains message bodies through `check_messages`; Mike can continue through the desktop afterward.

The load-bearing assumption is that the MacBook client and wake client can share the same loaded thread on Studio daemon PID5682. Transport and inference are proven; MacBook UI behavior is still unverified. The Studio's unrelated local ChatGPT window showed “open in another app,” which does not test the intended MacBook client (AP27665–27666).

Live evidence on Codex 0.162.1:

- A second Unix-WebSocket client initialized and listed loaded threads. A fresh second connection could start a turn on the test thread without `thread/resume`.
- Test thread `01a14660-4f5e-7423-a236-2a59560f842d`, named “AP desktop wake test — disposable,” consumed synthetic AP27663 after a bodyless wake. Its final response was `AP_INBOX_CONSUMED_276_TEST`.
- Omitted turn-level permission/model overrides preserved read-only sandbox, restricted network, `approval_policy=never`, and GPT-6 Luna low, verified in rollout `turn_context` records. This establishes inheritance for the tested configuration, not every permission mode.
- Calling `turn/start` while busy returned the existing turn ID and appended input into that turn. It neither rejected nor created an independently queued turn.
- **The existing `CodexAppServerWsClient` works unchanged with a `ws+unix:///absolute/socket` URL.** A read-only probe using the actual class on installed Bun 1.3.14 returned five loaded threads. The test thread was no longer loaded at that later probe; Mike must open it before the UI test. No automatic resume is proposed.

Scratch client: `/tmp/ap-desktop-probe.syZ9d6/client.cjs`. Test rollout: `/Users/mike/.codex/sessions/2026/10/16/rollout-2026-10-16T13-21-19-01a14660-4f5e-7423-a236-2a59560f842d.jsonl`. Both temporary clients exited.

## Smallest approach

Use the existing wake client, registry, polling loop, and delivery contract. Add exact per-thread registration after the first MCP tool call, discovering the Unix socket from that MCP process's own app-server parent. Tighten the existing idle check. No Codex source patch, new transport implementation, package, proxy service, or host-to-host Agent Peers routing is needed.

Alternatives considered: manual `check_messages` remains the functioning fallback but cannot wake idle sessions; a separate resumed app-server conflicts with the same-desktop-conversation requirement; a new Unix transport layer duplicates functionality already provided by Bun. The proposed integration can still fail at desktop event/rendering or writer ownership, and it cannot promise an atomic idle-only submission.

### 1. Bind the first MCP call to its exact thread

Touch points: `codex-server.ts:674` (tool handler), `:460`/`:477` (arrival barrier), `:789` (parent PID), `:1145` (registry registration), `:1194` (existing hints). Keep a small discovery helper in `shared/codex-desktop-wake.ts` if needed to test it independently.

- Only add this path for Codex sessions without existing explicit wake hints or a managed launch claim. Preserve managed root/secondary election at `codex-server.ts:843` and its empty-tool secondary behavior.
- Read the host-supplied `req.params._meta.threadId`, not a model argument or environment guess. First valid call establishes identity; missing metadata leaves ordinary inbox access functioning and the peer non-wakeable. Never infer a thread from cwd, title, latest rollout, or sibling order. A later conflicting ID must invalidate this binding rather than silently retarget it.
- Preserve request-entry confirmation ordering. Do not insert awaited socket discovery before `withPiggyback` captures `delivery.newArrival()` at line477. Perform bounded registration inside its callback, after that capture; a registration failure must not fail the requested inbox operation.
- Inspect only the MCP's direct parent PID. On macOS, use bounded `lsof -a -p <parent> -U -Fn` to find pathname sockets, deduplicate them, and validate candidate sockets through initialize + loaded-thread membership + `thread/read` for the supplied ID. Require a single matching parent-owned endpoint; absent or ambiguous endpoints remain non-wakeable. A stdio-only parent remains unsupported by this path.
- The observed socket is `/private/tmp/codex-daemon-501/6dece484e4958536174af18b33e33e10694fdb465dffe655396f0c31302d7ffa`. It is evidence, **not a constant**. Rediscover after MCP restart; do not scan all hosts or app-servers.
- Use the existing registry fields: exact peer ID and broker-session hash, thread ID, parent PID, MCP PID, socket path, `app_server_url=ws+unix://<absolute-path>`, and `tui_pid=null` because the UI is remote. Preserve `app-server-ws` capability. Store server-reported canonical cwd after checking it equals the real path of the MCP cwd; `/tmp` versus `/private/tmp` must not make valid registrations fail. Retain a returned rollout path when present; a paginated thread need not have a materialized JSONL file.
- Publish readiness only after validation and successful persistence. Reuse the binding on broker re-registration (`codex-server.ts:1071`) and refresh its name after rename (`:738`). Do not repeatedly discover a successfully bound socket on every tool call. Existing sessions adopt the path only after their MCP reload/restart and first AP call; do not mass-reload live business sessions.

### 2. Reuse the existing transport and preserve other registrations

`shared/app-server-client.ts:86` already calls Bun's `new WebSocket(url)`, so storing the `ws+unix://` URL is sufficient. Its timeouts, RPC methods, and `turn/start` payload at line219 stay intact. `cli.ts:31` and `shared/wake-daemon.ts:140` already construct this same client. Add a Unix-socket regression test in `tests/app-server-client.test.ts`; no new transport class or handwritten WebSocket frames.

One directly relevant registry issue must be addressed: `shared/wake-registry.ts:124` writes an instance snapshot; `:220` locks only that instance. Multiple desktop MCPs can therefore overwrite one another's rows, or race daemon pruning. Keep the existing JSON format, but serialize registry read-modify-write operations across processes, reload the latest state inside that lock, and use a unique temporary file for each atomic replacement (`:49`). Cover upsert, remove, prune, and markSeen. Reuse the repository's established exclusive-create/dead-owner lock approach, with bounded acquisition and no long network operations inside the lock. This is needed for concurrent per-thread registration, not a general registry rewrite.

### 3. Check idle immediately before sending

Touch points: `shared/wake-daemon.ts:142` (loaded check), `:148` (read/validate), `:155` (ledger claim), `:163` (wake), `:218` (validation).

Keep the first loaded/identity/idle check. After obtaining the ledger claim, perform a final `thread/read` and existing identity/cwd/status validation, then immediately call `startWakeTurn` with no permission, model, or sandbox overrides. If state changed, skip the wake and restore the prior ledger state for that unsubmitted claim so an active-state skip does not consume a retry or impose a delivered-wake cooldown. Add only the narrowly scoped claim-release support needed at `WakeLedger.claim`/`mark` (`:298`, `:331`). Do not change existing error retry policy in this task.

This reduces the race but **does not remove it**: a human can submit between final read and start. No atomic idle-only parameter was established. Do not describe this as guaranteed non-interference or queued delivery. If strict rejection of busy-thread input is required, this proposal does not meet that requirement; a supported upstream primitive is needed.

## What stays the same

The broker, body storage, leases, acknowledgments, confirm-on-next-call barrier, and piggyback delivery remain unchanged. The daemon reads bodyless metadata and sends the existing wake prompt. Successful turn completion is not a broker acknowledgment. Launcher claims, terminal wake, Hermes/Droid handling, default model choices, permissions, and peer naming continue as before. No app-server replacement, UI automation in production, desktop database writes, arbitrary peer retargeting, or new external destination.

## Verification and rollout boundary

First, Claude-5 coordinates Mike opening the named test on **MacBook → Studio**. Verify it is loaded, idle, and displaying that same conversation. Send one synthetic AP message, inject one bodyless wake without overrides, and have Mike confirm live user/assistant rendering and submit a harmless follow-up through the desktop. Record the returned turn, inbox call, response marker, and UI follow-up. This is the remaining UI acceptance test; do not substitute Studio's local window or transcript readback.

After authorization to implement, targeted checks must falsify wrong-thread binding, missing/conflicting metadata, ambiguous/wrong-parent sockets, same-cwd sibling collisions, `/tmp` normalization, registry lost updates across separate instances/processes, and an idle→active transition between the two reads. Unix transport tests cover handshake/RPC, timeout, and missing socket; existing TCP tests remain. Run targeted tests first, then the repo-required `bun test` and `bun run typecheck` before any commit.

Use one disposable desktop canary after implementation. Prove two desktop threads register without erasing each other, existing terminal wake still works, and only the addressed idle thread reacts. Runtime reload and eventual two-machine deployment require the separately agreed implementation scope; this draft performs neither. Rollback restores the prior AP code for the affected MCP/daemon; unread mail remains available through ordinary `check_messages`. Do not delete the test conversation or inbox as cleanup without authorization.

## Sources

- [Official Codex app-server protocol](https://learn.chatgpt.com/docs/app-server): Unix transport is WebSocket over the local socket; thread and turn RPCs.
- [Bun 1.3.13 release notes](https://bun.com/blog/bun-v1.3.13#websocket-client-support-wsunix-and-wssunix): native Unix WebSocket URL support; verified against installed Bun 1.3.14 and the existing AP client.
- [Merged Codex PR18093](https://github.com/openai/codex/pull/18093): authoritative `_meta.threadId` on MCP tool calls, not a startup identity contract.
- [Upstream desktop integration issue40134](https://github.com/openai/codex/issues/40134) and [external wake issue47193](https://github.com/openai/codex/issues/47193): unresolved general desktop integration requests; not proof that this SSH topology fails.
- Repository `docs/delivery-contract.md`; current source touch points above. Local observations and corrected machine attribution: AP27661–27666; draft request: AP27671.
