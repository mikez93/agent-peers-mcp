# Retired Hermes V2 runtime

The private per-conversation adapter, lifecycle/GUI attachment bridge, wake
coordinator and `hermes-conversations-cli.ts` were retired under `bd-b2in.9`.
The complete pre-retirement source is preserved by the annotated local tag
`archive/hermes-v2-2026-10-31`, pointing to `2c47724`. The integration owner
publishes that tag with the eventual approved release.

New `hermes-server.ts` processes use the stock chat-mail adapter. An obsolete
`AGENT_PEERS_HERMES_V2=1` prints a warning but no longer selects the removed
runtime. Existing enabled/disabled and passive-role gates remain effective.
No running adapter is restarted by this source change, and there are no new
lazy imports into those processes.

**Data is not retired.** No table is dropped, no row is migrated or deleted, and
no inbox or transcript is moved. The `hermes_conversations` table and any related
tables remain in existing databases. Normal startup does not create new V2 state.

`shared/hermes-conversation-fence.ts` remains as a small compatibility boundary.
Normal broker operations still reserve legacy names/UUIDs, reject token-only or
stale-owner access to a legacy mailbox, and preserve its unacknowledged mail from
GC. The CLI still avoids archiving those inboxes. Removing these checks would
change behavior reachable by ordinary clients, not just remove dead code.
Already-loaded old callers retain the same owner-fenced broker signatures.

Historical T1/T2 documents remain labelled as historical. They are not
instructions to reactivate V2. Use `git show` against the archive tag for
investigation; do not roll a live broker database or transcript back to recover
source. Any old backlog still needs a separate, explicit reconciliation.
