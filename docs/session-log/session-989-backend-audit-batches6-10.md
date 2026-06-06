# Session 989 — Backend Audit: Batches 6–10

**Date:** 2026-06-05 / 2026-06-06
**Branch(es):** `fix/backend-audit-batch7` (PR #523), `fix/backend-audit-batch8` (PR #524), `fix/backend-audit-batch9` (PR #525), `fix/backend-audit-batch10` (in progress)

## What shipped

### Batch 7 — PR #523
Issues: #466 #467 #472 #477 #483 #486

- **#466** `sync_daemon/orchestrator.rs` — `peers_appeared` now checks `is_pending_pairing` so QR-only pairing wakes the dormant daemon
- **#467** `commands/blocks/queries.rs` — `resolve_root_pages` caps at SMALL_IN_LIMIT + json_each fallback to avoid SQLite variable ceiling; stale doc fix
- **#472** `commands/pages.rs` / `queries.rs` — frontmatter export includes `value_bool`; `PageWithMetadataRow.deleted_at` → `Option<i64>`; doc fix for queries.rs
- **#477** `fts/search.rs` + `fts/sanitize.rs` — delete dead `strip_for_fts`; skip empty QuotedPhrase in FTS5 sanitizer (was a syntax error)
- **#483** `materializer/queue.rs` — `RebuildFtsIndex` uses blocking enqueue; `enqueue-drop` uses two-attempt `record_failure` retry; `spawn_sweeper` shutdown-flag doc
- **#486** `recovery/` + `boot.rs` — doc for `apply_snapshot` limitation; extract `cleanup_snapshots_impl`; out-of-tx draft-delete safety note

Post-push fixes: `.sqlx` cache entry for value_bool i64 query (#472); regenerate TypeScript bindings after `deleted_at: Option<i64>` change.

### Batch 8 — PR #524
Issues: #465 #481 #490 (M1+M2)

- **#465** `op.rs` — `SetPropertyPayload.value_ref` → `Option<BlockId>` (ULID uppercase normalization); updated all 8+ call sites across `crud.rs`, `tags.rs`, `bootstrap.rs`, `handlers.rs`, `merge/mod.rs`, `reverse/property_ops.rs`, `engine_proptest.rs`
- **#481** `loro/projection.rs` + `sync_protocol/loro_sync.rs` — `reproject_block_properties_from_engine` hoists `property_definitions` load out of the function; `apply_remote` loads it once before the block loop (N+1 → 1 query)
- **#490 M1** `orchestrator.rs` — `last_sent_hash` field doc clarifies always-None under loro-vv protocol
- **#490 M2** `sync_files.rs` — progress denominator uses DB `size_bytes` (no file hash on send path)

### Batch 9 — PR #525
Issues: #469 #470 #471 #473 #474 #476

- **#469** `cache/block_tag_refs.rs` doc fix; `cache/tags.rs` INSERT OR REPLACE for rename collision; `cache/pages.rs` CTE to eliminate double correlated-subquery in `recompute_all_pages_cache_counts`
- **#470** `crud.rs` — GCal DirtyEvents for `delete_blocks_by_ids_inner` (full FEAT-5i pattern: pre-op snapshot + post-commit notify loop); stale doc fix on `create_block_in_tx`
- **#471** `history.rs` — remove `deleted_at` from AddAttachment INSERT OR REPLACE; fix stale comments
- **#473** `properties.rs` — narrow `set_todo_state_inner` pre-fetch (`query_scalar!` not `query_as!(BlockRow)`); probe `repeat_carriers` inside IMMEDIATE tx
- **#474** `sync_cmds.rs` dead `let _session` removed; `db.rs` error-propagate op_count probe; `lib.rs` fix flaky timestamp test with pinned chrono constants
- **#476** `cache/projected_agenda.rs` + `agenda.rs` intra-doc link fixes; `pagination/tests.rs` stale module doc + new `test_list_page_history_multi_device_cursor`; `block_row_columns.rs` EXPECTED_HITS 16→15

### Batch 10 — in progress
Issues: #475 #479 #480 #485 #488 #489

## Infrastructure fixes

- **PR #523 rebase**: `fix/backend-audit-batch7` was 1 commit behind main (batch 6 landed after branch was created). Rebased cleanly; force-pushed to unblock merge.
- **`.sqlx` cache**: Manually staged only the 1 new cache entry for batch 7 to avoid committing 220 orphaned stale entries.
- **Specta bindings**: Regenerated `src/lib/bindings.ts` after `PageWithMetadataRow.deleted_at: Option<String>` → `Option<i64>` change.

## Open PRs
- **#523** (batch 7): CI running after rebase force-push
- **#524** (batch 8): all checks pass, `build` pending (native binary)
- **#525** (batch 9): CI running
