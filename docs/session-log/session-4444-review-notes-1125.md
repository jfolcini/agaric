# Session 4444 — review notes from the PRs merged on 2026-11-25

**Ask.** Read every PR merged in the last 24 hours (#7038 to #7077, 32 PRs), find the reviewer's non-blocking notes that no later PR addressed, and address them in one follow-up.

**Already handled before this session.**
- #7038, #7043, #7049, #7051 and #7054's first push: disposed of in #7054 (`session-4428-npm-retry-fresh-cache.md`).
- #7072, the `verify-lockfiles` error text that called loro "pinned exactly": deleted in #7075.
- #7052, the orphaned `searchSheet.dragHandleLabel` translator comments: removed before #7052 merged.
- #7052, the `--block-*` comment that still described the 44 px checkbox box: reworded in 5a1bfaf07.
- #7075, "force `cap.fallback` on the failed arm": declined on the PR with a trace through loro-internal 1.19.2's import path.

**Fixed here.**
- #7062, the `gradle-verification-commit.yml` header: the reflow in #7062 left "comment asks a person to" on a line of its own. Reflowed.

**Checked and left.**
- #7072, "engine/mod.rs and snapshot.rs still name loro-internal's `import_blobs_as_batch`": premise wrong. loro-internal 1.19.2 (the locked version) still has `import_blobs_as_batch` in `src/loro.rs`. It still sorts with the stable `sort_by` on `(mode, descending change_num)`, force-detaches under the txn mutex, and re-attaches in `BatchImportGuard::finish`. Both doc comments are accurate.
- #7074, "`useScrollRestore` keeps setting `scrollTop` for all `RESTORE_FRAMES` when the saved position cannot be reached": the reviewer called it harmless. A wheel, touch or key press stops it. The case it misses is a mouse drag on the Radix scrollbar, which is a sibling of the viewport, so a listener on the container would not catch it either. No cheap fix, and no victim on record.
- #7063, "`archive_indexed` is a hand-synced twin": the note asks for a shared script only if a third copy appears. There are still two (`apt-install`, `playwright-setup`).
- #7060 (the title names 3.24.0 but the lock has 3.25.0), #7062 (scope), #7063 (session-log scope): notes on merged descriptions and on process. Nothing in the tree to change.
- #7060 and #7049, duplicate `jiff` and `zbus` lines: compile time only. `deny.toml` warns on multiple versions.
- #7069, `data-encoding-macro-internal` re-resolved to syn 3: `verify-lockfiles` and the `--locked` builds passed before merge.

**Ran.** The pre-commit hooks on the changed files. This PR changes a workflow comment and a session log, so there is no test to run.
