## Session 1138 — #2037 pt2: narrow cache invalidations for content-block delete/restore/purge (2026-06-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-30 |
| **Files touched** | `src-tauri/src/materializer/dispatch.rs`, `src-tauri/src/db/command_tx.rs`, `src-tauri/src/commands/blocks/crud.rs`, `src-tauri/src/commands/tests/tag_cmd_tests.rs`, `src-tauri/.sqlx/*` |
| **Tests added** | 7 dispatch.rs lifecycle-narrowing pins + 1 end-to-end `usage_count` convergence test (#2172) |

**Summary:** Follow-up to #2037 pt1 (the per-op `materializer::dispatch` invalidation
narrowing). `delete_block` / `restore_block` / `purge_block` ops unconditionally fanned out
the full 8-task `FULL_CACHE_REBUILD_TASKS` set, including the O(pages) `RebuildPagesCache` row
rebuild. A CONTENT block's lifecycle cannot add, remove, or rename a `block_type = 'page'` row,
so for the common case (deleting/restoring/purging a content block) that rebuild was pure waste.
The `block_type_hint` parameter on `invalidations_for_op` already existed but every production
lifecycle caller passed `None`, so the narrowing could never fire — the core of this change is
threading the real `block_type` through.

> **#2172 review correction:** an earlier revision also dropped `RebuildTagsCache` for content
> blocks. That was a correctness regression caught in review: `tags_cache.usage_count` counts the
> DISTINCT *live* blocks referencing each tag via `block_tags`/`block_tag_refs` — and those
> sources are overwhelmingly CONTENT blocks (inline `#tag`/`#[ULID]`). Deleting/restoring a
> tagged content block therefore changes `usage_count`, which only `RebuildTagsCache` recomputes
> (`RebuildBlockTagRefsCache` rebuilds the refs *table*, not the count). The narrowing now drops
> **only** `RebuildPagesCache`; `RebuildTagsCache` is retained, guarded by a new end-to-end
> convergence test.

**Change:**
- `materializer/dispatch.rs`: added `CONTENT_LIFECYCLE_REBUILD_TASKS` (the full set MINUS only
  `RebuildPagesCache`) and a pure `lifecycle_rebuild_tasks(hint)` selector. The
  delete/restore/purge arms call it. Narrowing is gated on EXACTLY `Some("content")`;
  `Some("page")`, `Some("tag")`, any unknown string, or `None` keep the full set
  (correctness-first default — a page delete still rebuilds `pages_cache`). Dropping
  `RebuildPagesCache` is safe because it only rebuilds page *rows* `(page_id, title)` from
  `block_type = 'page'` blocks — the count recompute was extracted out of it (#417) into the
  separate `RebuildPagesCacheCounts` task and per-op counts are foreground-maintained.
  `RebuildTagsCache` is retained (see review correction above). `RebuildTagInheritanceCache` is
  retained because the inheritance recursive CTE filters `deleted_at IS NULL`, so a content
  soft-delete/restore does change descendant inheritance. Agenda / projected-agenda / page_ids /
  block_tag_refs / page_link are also retained. Added `Materializer::dispatch_lifecycle_background`.
- `db/command_tx.rs`: new `PendingDispatch::LifecycleBackground { record, block_type }` variant +
  `enqueue_lifecycle_background` method (mirrors `enqueue_edit_background`; warns on dispatch
  error, never propagates) and its drain arm.
- `commands/blocks/crud.rs`: threaded `block_type` into all 8 production lifecycle sites (single
  + batch + all-deleted delete/restore/purge) by extending their existing validation /
  root-selection SELECTs to read `block_type` and switching them to `enqueue_lifecycle_background`.
  The test/bench-only `cascade_soft_delete` primitive and the remote-sync / engine-replay paths
  are unchanged (still full set).
- Regenerated `.sqlx` offline query cache for the `SELECT … block_type` changes.

**Verification:** dispatch.rs tests pin that content delete/restore/purge omit `RebuildPagesCache`
but RETAIN `RebuildTagsCache` + `RebuildTagInheritanceCache`; that page/tag/None hints keep the
full 8-task set; and that the narrowed set equals "full minus only `RebuildPagesCache`, order
preserved". A new end-to-end test (`content_delete_restore_keeps_tag_usage_count_in_sync_2172`)
drives the real `delete_block_inner`/`restore_block_inner` command path and asserts
`tags_cache.usage_count` converges 1→0→1 after the background queue settles (the #2172
regression guard). `cargo test -p agaric materializer::dispatch` → 43 passed; the convergence
test → 1 passed; `cache::cascade` → 15 passed; the page-create integration test
(`materializer_processes_background_tasks_after_page_create`) → 1 passed. `cargo clippy -p agaric
--lib --tests -- -D warnings` clean; `cargo fmt -p agaric -- --check` clean.

**Commit plan:** single commit on `claude/issue-2037-pt2-delete-narrowing`; draft PR referencing
#2037 as a follow-up perf refinement.
