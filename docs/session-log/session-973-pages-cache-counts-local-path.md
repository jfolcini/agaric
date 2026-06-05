## Session 973 — pages_cache counts: local-path maintenance + #432 commit-gate fix (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Subagents** | 1 build + 1 review (+ orchestrator probe) |
| **Items closed** | `#432` |
| **Items modified** | `#417` (correctness prerequisite landed; perf gate remains) |
| **Tests added** | +2 backend integration (local-path counts; #432 no-op-rebuild persistence) |
| **Files touched** | 6 |

**Summary:** While investigating #417, a probe driving the **real local command
path** uncovered a confirmed correctness bug: creating content blocks under a
page never updated the page's `pages_cache.child_block_count` (stayed 0 despite
N real children). Two root causes, both fixed:
1. **#432** — `apply_sort_merge_rebuild` rolled back when the title/orphan diff
   was empty (`changed == 0`), **discarding the recomputed counts**. The count
   UPDATE is now guarded (`WHERE inbound_link_count != (<subq>) OR
   child_block_count != (<subq>)`) and its `rows_affected()` is added to
   `changed`, so a rebuild commits when counts changed — while a true no-op
   still returns 0 (idempotency + `updated_at` recency preserved). Bonus: the
   guard means the UPDATE now writes only changed rows (less write amplification).
2. **Local-path gap** — content/tag creates dispatched no pages_cache count
   maintenance (only the sync `ApplyOp` path ran `maintain_pages_cache_counts_after_op`).
   `create_block_in_tx` now calls the shared `recompute_pages_cache_counts_for_pages`
   in-tx for the owning page (skipped for page creates). page_id is set by the
   in-tx INSERT before the recompute, so the count subquery sees the new block.
   delete/move already enqueue the full `RebuildPagesCache`, which now persists
   counts thanks to the #432 fix.

**Files touched (this session):**
- `src-tauri/src/cache/pages.rs` — guarded count UPDATE + `changed` accounting (#432).
- `src-tauri/src/commands/blocks/crud.rs` — in-tx owning-page count recompute on create.
- `src-tauri/src/materializer/handlers.rs` — `recompute_pages_cache_counts_for_pages` → `pub(crate)` (no logic change).
- `src-tauri/src/materializer/mod.rs` — re-export the recompute helper.
- `src-tauri/src/command_integration_tests/pages_cache_counts.rs` (new) + `mod.rs`.
- `src-tauri/.sqlx/*` (count UPDATE SQL changed).

**Verification:**
- New `local_content_create_maintains_pages_cache_counts` (3 creates → child=3; inline link → inbound=1; delete child → child=2, inbound=0) and `rebuild_pages_cache_persists_counts_when_titles_unchanged` (#432) — both pass (were failing on main).
- `cargo nextest run` across cache/materializer/pages/backlink/list_pages — 800 passed (incl. `pages_cache_count_parity`); `cargo check --all-targets` clean.
- Independent review: #432 guard subqueries byte-match the SET subqueries (no false guard); page_id confirmed set in-tx before recompute; ApplyOp path untouched; recompute idempotent (no double-count).

**Process notes:** The audit's #417 premise ("scoped recompute covers every per-op
path") was wrong — it covers the `ApplyOp` (sync/recovery) path only. The local
command path was the gap. This lands the **correctness** foundation; the #417
**perf** optimization (titles-only fast path for per-op rebuilds) is now safely
enableable as a follow-up and #424 is unblocked.

**Commit plan:** single commit; pushed; PR against `main`.
