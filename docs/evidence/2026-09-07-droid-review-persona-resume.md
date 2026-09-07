# Droid review: persona naming and collision-resume proof

Independent review of the Droid addition (`5eb6c40`) and its direct broker,
MCP, lifecycle, inspection, and fleet paths found five defects. The second
review reproduced one additional claim-update race. All six were fixed:

1. Resume saved the requested name rather than the allocated collision name
   and UUID. Actual identity is now saved and updated on MCP rename/rebind;
   prior UUID is carried through the broker's orphaned-mail recovery path.
2. Malformed ACP output or EOF could leave a living but unusable host. Reader
   failure now closes the transport and retires the host.
3. Startup ignored cancellation, and shutdown returned before child exit.
   Cancellation now covers startup; shutdown waits for exit and the SIGKILL
   fallback, reporting failure if the child still does not exit.
4. A stale crash claim could shadow a resumed live claim in inspection. Claim
   selection now uses the broker MCP PID, liveness, and deterministic recency.
5. Each idle poll attached a handler to the unresolved process-exit promise.
   One process-exit subscription now serves the entire host lifetime.
6. Session finalization could overwrite a concurrent MCP rebind. Short,
   exclusive cross-process claim updates now cover both binding and saved
   session identity. The launcher no longer writes an earlier snapshot.

The final independent re-review found no actionable blocker. Concurrent hosts
resuming the same Factory session remain an unverified Factory behavior, not a
proven defect; this patch does not add speculative session-lock infrastructure.

## Deterministic verification

Typechecking and 323 tests passed. New tests exercise all four actual stdio MCP
adapters, explicit overrides, concurrent persona names and newest Started
ordering, maximum-length collisions, UUID-name rejection, malformed ACP while
idle, actual termination of a SIGTERM-ignoring process, early cancellation,
bounded shutdown failure, one exit subscription across 100 polls, stale/live
claim selection, and the two-store claim-update interleaving.

## Real Factory run on Mac Studio

Droid 0.204.0, ACP v1, configured Luna proxy model, reasoning medium, autonomy
auto-low; isolated broker on port 17914. No production peer received test mail.
Only the six Agent Peers MCP operations were eligible for allow-once approval.

A live test reservation occupied `vector-agentic-coding-resources-droid`.
Starting with no explicit peer name and CWD `agentic-coding-resources` produced:

```text
name: vector-agentic-coding-resources-droid-2
peer_id: 7e71d5bb-919c-4515-bb3f-5fdba5e1f3f0
session_id: 0f9d14ee-b85a-4c17-8565-be04c8ea0ea0
status: wakeable
```

An idle message produced the exact reply `E2E_REVIEWED_WAKE_OK` from that peer
without terminal input. SIGINT stopped the host with exit 0. Bare resume from
a different caller CWD restored the same name, peer UUID, Factory session, and
saved CWD. A second idle message produced `E2E_REVIEWED_RESUME_OK`.

```text
broker=registered session=live mcp=live wakeable=yes unread=0
```

All four broker message rows were acknowledged. Both launches exited 0, and
the isolated broker/reservation were stopped. No credentials or message bodies
beyond the purpose-built test nonces are retained in this evidence.
