# Session 2180 — Lessons from 1941–2172 into the AGENTS files; 1901–2100 archived

Two maintainer-approved chores in one PR.

**Lessons.** Three parallel readers mined every session log since #5390's
pass, plus this orchestrator's own day of `/batch-issues` work, for where time
and review rounds were lost. As in #5390, each lesson lands as a concrete trap
in the nested `AGENTS.md` where the work happens, or in the batch skill. Stale
guidance was corrected in place (bench lanes, the e2e-tauri local recipe, the
MCP summary ULID rule, the logger's IPC levels, the falsification wording) and
duplicates pruned. Root `AGENTS.md` changed only with the maintainer's
approval.

The costliest lesson: **never share a cargo target dir between worktrees of
this repo, not even one build at a time.** This session symlinked each
worktree's `src-tauri/target` to the main checkout's, reasoning that cargo's
lock serializes builds. It does not make the result correct. Workspace crates
get the same unit metadata in every checkout, so a build in one worktree
reused another's `agaric-engine` artifacts while their fingerprints still
looked fresh. A mutation builder then hit type errors in files it had not
touched. Recovery took removing the symlinks, `cargo clean -p` for every
workspace member in the shared dir, and re-running every gate that had gone
through it. The batch skill's "never share between concurrently building
trees" now says "between worktrees", and `docs/BUILD.md` gives the mechanism.

The other lessons:

- **Item claims.** Two sessions built the same item of a multi-item issue
  (#5625, #5626), so claims are now per item, with a liveness rule for
  `in-progress`.
- **Log numbers.** Session-log numbers collided three times with parallel
  sessions, so other sessions' PRs mean picking from the top of the window.
- **sqlx drift guard.** `check-sqlx-cache-drift` misfires when a crate swaps
  one shared query for another. The skip is sanctioned after `just gen-sqlx`,
  with the reason in the commit message.
- **Pushes.** Confirm a push with an explicit SHA comparison, not by eye.
- **Android SDK.** Setup now goes through the `android` CLI, which wraps the
  deprecated `sdkmanager`.

**Archive.** Sessions 1901–2000 (74 logs, two of them numbered 1943) and
2001–2100 (56 logs; the gaps were never used) moved into
`sessions-1901-2000.md` and `sessions-2001-2100.md`, headings demoted, newest
first. One log (1924) titled itself `Session 1924:` rather than with a dash
and was kept verbatim. Every archive's "Sessions above" line states the same
boundary, so all 21 moved to 2100 together with the README's archive list. No
file outside the folded range linked to any of them. The commit skips
`session-log-immutable`, as the README prescribes for a fold.

Docs only: prek over the changed files (markdownlint, link targets, doc
citations, typos) passed; no test suite applies.
