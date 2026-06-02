## Session 953 — #85 (PEND-76 F2) single-block purge attachment file-leak (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator + 1 Explore (call-site map) |
| **Items closed** | #85 (PEND-76) — last open item |
| **Items modified** | #85 |
| **Tests added** | +2 (Rust) |
| **Files touched** | 3 |

**Summary:** Closed the final open item on PEND-76 (#85): the **F2 single-block purge
attachment file-leak**. `purge_block_inner` deleted attachment *rows* but never unlinked
the *files* (both bulk purge paths did, but via a "suspect" CWD-relative `remove_file`).
Per the maintainer's 2026-05-29 decision, the fix resolves attachment paths against
`app_data_dir` (absolute, matching `delete_attachment_inner`) and reconciles **all three
purge paths** through one shared helper. F1/F3/F4/F5 were already done or delegated
(F1 remote-propagation → #86 PEND-80, now shipped; F3/F4/F5 closed-as-done per the
maintainer comment). Backend-only; no SQL/migration.

**Files touched:**
- `src-tauri/src/materializer/coordinator.rs` (+9) — `Materializer::app_data_dir()` public
  getter (clones the `Arc<OnceLock<PathBuf>>` set at startup by `lib.rs`).
- `src-tauri/src/commands/blocks/crud.rs` (~+96/-61) — `remove_purged_attachment_files`
  (sync, pure, unit-testable: joins `app_data_dir`, skips absolute/`..` paths, treats a
  missing file as a no-op) + `spawn_purged_attachment_cleanup` (off-thread, post-commit,
  fire-and-forget). `purge_block_inner` now collects `fs_path`s (descendants CTE) before the
  row delete and spawns the unlink after commit. Both bulk paths' inline relative-`remove_file`
  loops replaced by the shared helper.
- `src-tauri/src/commands/tests/block_cmd_tests.rs` (+82) —
  `remove_purged_attachment_files_unlinks_safe_paths_only` (safe relative unlinked;
  parent-escape + absolute skipped; missing = no-op) and `purge_block_unlinks_attachment_files`
  (end-to-end: add attachment → soft-delete → purge → poll for file removal).

**Design decisions:**
- **Sourced `app_data_dir` from the `Materializer`** (already a parameter of all three
  `purge_*_inner` fns) rather than threading a new `app_data_dir` param through the ~22
  call sites the maintainer comment mentioned. The `Materializer` already carries
  `app_data_dir` (`Arc<OnceLock<PathBuf>>`, set from `lib.rs`), so this achieves the exact
  goal — proper absolute-path unlink across all purge paths — with **zero signature/call-site
  churn** and no redundant double source of truth. (Flagged for maintainer review in the PR.)
- All three purge paths now funnel through one helper, so the bulk paths stop depending on
  the process CWD and the single-block path stops leaking. A `None` `app_data_dir` (unwired,
  e.g. some tests) skips the unlink with a debug log — the `CleanupOrphanedAttachments` GC
  sweep remains the backstop.

**Verification:**
- `cargo check` clean.
- `cargo nextest run -E 'test(purge) + test(attachment) + test(cleanup_orphaned)'` — green
  (incl. the 2 new tests).

**Commit plan:** single commit; pushed; PR against `main`; not merged. #85 closed as
completed (F1→#86 done, F3/F4/F5 done-as-decided, F2 file-leak fixed here).
