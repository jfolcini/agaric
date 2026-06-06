## Session 992 — sync write-ahead inbox, block_type CHECK, native space_id (2026-06-06)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-06 |
| **Subagents** | 4 build (space-filter swaps) + 1 technical review |
| **Items closed** | `#535`, `#541`, `#533` (via PRs #579/#580/#581 — chained, merge bottom-up) |
| **Items modified** | — |
| **Tests added** | +0 (frontend) / +6 (backend) |
| **Files touched** | ~60 (incl. `.sqlx` regen) |

**Summary:** Shipped a three-PR backend stack. #535 closes the `apply_remote` crash
window between Loro engine import and SQL commit with a write-ahead `loro_sync_inbox`
slot (migration 0084) replayed at boot. #541 promotes the `block_type` enum guard from
the migration-0005 BEFORE INSERT/UPDATE triggers to a native `block_type_valid` CHECK
constraint via a `blocks` rebuild (migration 0085), removing the per-rebuild
trigger-recreation tax. #533 promotes space membership from a `block_properties(key=
'space')` sub-select to a native indexed `blocks.space_id` column (migration 0086),
collapsing every paginated space filter to `b.space_id = ?`; `space_id` is a derived
cache maintained alongside the existing `page_id` denormalization.

**Files touched (this session — #533 slice):**
- `src-tauri/migrations/0086_blocks_space_id_column.sql` (new)
- `src-tauri/src/cache/page_id.rs`, `cache/mod.rs` (rebuild_space_ids + inherit helper)
- `src-tauri/src/materializer/handlers.rs` (SetBlockPageId / RebuildPageIds maintain space_id)
- `src-tauri/src/loro/projection.rs`, `commands/blocks/crud.rs` (set/delete space → group space_id)
- `src-tauri/src/commands/blocks/move_ops.rs`, `commands/blocks/crud.rs` (move/restore subtree space_id)
- read-filter swaps: `pagination/*`, `backlink/*`, `tag_query/query.rs`, `fts/filter_builder.rs`,
  `commands/{agenda,pages,queries}.rs`, `commands/blocks/queries.rs`, `filters/primitive.rs`
- `src-tauri/src/space_filter_canonical.rs` (drift guard repointed to new shape)
- test seed helpers in both `common.rs` modules + `pagination/tests.rs`/`fts/tests.rs`

**Verification:**
- `cd src-tauri && cargo nextest run` — 4236 tests passed, 0 failed (#533 branch).
- pre-commit hook — all staged-file checks pass (clippy, fmt, typos, migrations, sqlx).
- pre-push hook — full clippy + verify-CI-equivalent pass on all three branches.

**Process notes:** A technical review subagent on #533 caught two stale-cache bugs the
suite missed: descendant `space_id` left stale on move-to-space of a populated page (a
space-property change enqueues no page_id rebuild), and a read-after-commit window on
cross-space move/restore. Both fixed by stamping the whole owning-page group
synchronously; covered by a new regression test.

**Lessons learned (for future sessions):** When denormalizing a property into a column,
every test-seed helper that wrote the property row directly must also maintain the new
column — there are two separate `common.rs` modules (`commands/tests/` and
`command_integration_tests/`) plus per-module local seed helpers; missing one shows up
as a cluster of space-filter test failures.

**Commit plan:** pushed — three chained PRs (#579 → #580 → #581), merge bottom-up.
