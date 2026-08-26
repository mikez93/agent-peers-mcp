# Repository Cleanup Record

Date: 2026-08-26
Beads issue: `bd-336`

## Scope

Audit the `agent-peers-mcp` repositories on this computer and classify every worktree, local branch, remote-tracking branch, stash, and recoverable unreferenced commit. Preserve or integrate useful work, remove obsolete local artifacts, and leave the repository in a documented, verifiably clean state.

The repository's canonical branch is `main`; there is no `master` branch.

## Starting Inventory

- Primary checkout: `/Users/mike/agent-peers-mcp`
- Local worktrees: one, the primary checkout
- Local branches: one, `main`
- Stashes: none
- Uncommitted files: none before this audit
- Upstream for local `main`: `fork/main`, at the same commit (`06939e4`)
- Additional remote: `origin`, whose `main` is 17 commits not in local `main`; local `main` has 46 commits not in `origin/main`
- Other searchable clones using either current remote URL under `/Users/mike`: none found
- Separate predecessor archive: `/Users/mike/claude-peers-mcp-archive`; it is a clean checkout of a different repository and was not altered
- Remote-tracking topic branches under `origin`: ten, all requiring classification

## Tracking Repair

The checkout had no `.beads` workspace even though its agent instructions require Beads. A new Dolt-backed workspace with the historical `bd-` issue prefix was initialized, and this cleanup was claimed as `bd-336`.

## Decision Rules

1. Do not delete a dirty worktree or an unreferenced change.
2. Treat patch-equivalent or fully ancestor-merged branches as safe to remove locally.
3. Review non-equivalent branch diffs against current behavior and delivery guarantees before deciding that they are superseded.
4. Do not delete branches from GitHub as part of this computer-local cleanup.
5. Record every final branch and worktree disposition below.

## Branch Disposition

| Reference | Relationship to local `main` | Decision |
| --- | --- | --- |
| `fork/main` | Exact pre-cleanup match at `06939e4`; configured upstream | Keep as canonical remote branch |
| `origin/claude/docs-sync-post-pr2` | Ancestor of `main` | Already merged; no action |
| `origin/claude/fix-round-2-idle-delivery-and-tab-title` | Ancestor of `main` | Already merged; no action |
| `origin/claude/fix-tab-title-and-codex-nudge` | Ancestor of `main` | Already merged; no action |
| `origin/fix/check-messages-description-and-meta-types` | Ancestor of `main` | Already merged; no action |
| `origin/claude/fix-message-delivery-pjQvU` | Its only commit is patch-equivalent to a commit in `main` | Already integrated; no merge |
| `origin/feat/codex-conversation-flow` | Two of three commits are patch-equivalent; its remaining background-poll design is an older predecessor of the current durable delivery state machine | Superseded; do not merge |
| `origin/fix/codex-notice-level` | Interim notification-based wake experiment; current `main` uses the app-server wake daemon and retains confirm-on-next-call delivery | Obsolete; do not merge |
| `origin/codex-cli-pr-patch` | Adds a 2026-04 patch against another repository (`openai/codex`) | Obsolete third-party artifact; do not merge |
| `origin/docs/simplify-readme` | Describes the old notification/check-every-turn behavior | Stale documentation; do not merge |
| `origin/fix/roast-hardening` | Six non-equivalent commits against the pre-wake architecture | Do not merge wholesale. Ported the still-applicable inbox trust, summary privacy, and CI/typecheck pieces into current `main`. |
| `origin/main` | Diverged at `2b58c5b`: 17 origin-only and 47 pre-cleanup local-only commits | Do not merge wholesale. It combines `roast-hardening` with an older wake stack; current `main` has the later delivery, identity, Hermes, and wake architecture. |

The `origin/*` entries above are remote-tracking refs backed by live branches in the upstream `Co-Messi/agent-peers-mcp` repository. They are not local branches or worktrees, and this computer-local cleanup does not delete branches from someone else's GitHub repository.

## Unreachable Commit Disposition

`git fsck --full --unreachable --no-reflogs` found ten commits:

- `0527f5e`, `77f154b`: duplicate early wakeable-Codex implementations. Current history begins with the evolved `fdc0629`; the only tree difference is a newer launcher script.
- `93027a5`, `88dabfb`, `9f96627`: duplicate wake documentation commits. Their patch is already present in current history.
- `d08c021`, `b59fdd4`, `cef195d`: one automatic stash set from 2026-08-06. Its tracked changes and two formerly-untracked launch-role files were incorporated in `2ea2908`.
- `fd87298`, `6c4799b`: one automatic stash set from 2026-07-13. Its `claude-server.ts` change was incorporated in `0d4bbba`, which also contains the associated broker/client/test work.

All ten were superseded. They were pruned only after their hashes and replacement evidence had been recorded above; the objects are no longer recoverable from this clone.

## Selective Integration

The useful remnants of the divergent hardening line were reapplied to the current architecture rather than merging stale history:

- Durable inbox loads now treat only a missing file as empty. Permission, ownership, file-type, corruption, and other read failures block all subsequent writes so unread mail cannot be destroyed.
- OpenAI auto-summary is explicit opt-in (`AGENT_PEERS_AUTO_SUMMARY=1`) and sends only coarse, redacted repository metadata.
- `package.json` exposes `typecheck` and `test:ci`; GitHub Actions runs a frozen install, typecheck, and the full test suite on Bun 1.3.14.

## Verification

- `bun test tests/codex-inbox-store.test.ts`: passed (12 tests)
- `bun test tests/summarize.test.ts`: passed (2 tests)
- `bun run typecheck`: passed
- `bun install --frozen-lockfile`: passed with no changes
- `bun test`: passed (245 tests across 32 files)
- `git diff --check` and `git diff --cached --check`: passed
- `git worktree prune --expire now --verbose`: no stale worktree metadata
- `git remote prune origin` and `git remote prune fork`: no stale remote-tracking refs
- `git fsck --full --unreachable --no-reflogs`: clean after pruning
- `git count-objects -vH`: zero loose objects and zero garbage after repack (down from 90 loose objects / 612 KiB)
- Beads issue `bd-336`: closed after the documented work and checks completed
