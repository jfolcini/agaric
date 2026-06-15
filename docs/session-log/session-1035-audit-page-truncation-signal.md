# Session 1035 — audit fix #1258: surface load_page_subtree 10k truncation

2026-06-15. From the 2026-06 Opus quality audit (high severity — silent data
truncation). `/loop /batch-issues` run.

## Bug
`load_page_subtree` (`src-tauri/src/commands/pages/listing.rs`) caps results at
`PAGE_SUBTREE_MAX_BLOCKS = 10_000` via a bare `LIMIT`, with only a backend
`tracing::warn` and a plain `Vec<BlockRow>` return — the frontend had no awareness.
Descendants whose parent row was cut became unreachable orphans (dropped by
`buildFlatTree`'s DFS) and vanished silently with no user signal.

## Fix
- **Rust:** `load_page_subtree` now returns `PageSubtree { blocks, truncated, total }`.
  When the cap fires it runs a second `COUNT(*)` over the IDENTICAL predicate
  (`page_id = ?1 AND id != ?1 AND deleted_at IS NULL`) to get the true active-descendant
  count; `truncated = total > returned`. Below the cap no second query runs.
- **Frontend:** `page-blocks.ts` store gains `truncatedTotal: number | null`; `BlockTree.tsx`
  renders a non-blocking notice (SearchPanel capped-notice pattern: `role="status"`,
  alert-warning styling, i18n `blockTree.truncatedNotice` with shown/total) only when
  truncated.
- specta bindings + one new `.sqlx` cache file regenerated for the COUNT query.

## Verification
New Rust test `load_page_subtree_reports_truncation_over_cap` (10,005 rows). Reviewer
verified all 3 IPC consumers + the mock handler updated (mock⇄backend parity), the COUNT
matches the LIMIT predicate, banner a11y/i18n, and `.sqlx`/specta integrity. Reviewer also
fixed: a test that timed out the suite (set `page_id` in the bulk INSERT instead of an
O(N²) `rebuild_page_ids`), invalid ULIDs, two out-of-diff tsc breaks (`PageBlockState`
now requires `truncatedTotal`), and added store coverage for the truncated mapping.
Full Rust 4165 passed; full frontend 12712 passed; tsc clean.
