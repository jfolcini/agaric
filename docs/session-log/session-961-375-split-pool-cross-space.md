# Session 961 — #375: restore the cross-space filter on the split/rebuild cache paths

**Date:** 2026-06-03
**Scope:** SQL-review finding #375 — the production cache-reindex paths drop the
cross-space isolation filter that the canonical single-pool path enforces.

## Symptom

The single-pool `reindex_block_links` / `reindex_block_tag_refs` push a
cross-space filter into their INSERTs (`AND (?3 IS NULL OR ?3 = (…space
subquery…))`, PEND-15 Phase 3 / #345/#346) so a cross-space `[[ULID]]` /
`#[ULID]` token never enters the cache. But:

- The `_split` variants — the ones actually dispatched in production whenever a
  `read_pool` exists (`materializer/coordinator.rs:148` always passes
  `Some(read_pool)`) — omitted that filter entirely.
- The split tag-refs INSERT also dropped the `deleted_at IS NULL` guard on its
  tag-existence `EXISTS`, so a soft-deleted tag could still produce a ref.
- `compute_desired_pairs`, used by the FULL rebuild (snapshot restore, boot
  empty-table fallback, explicit "rebuild caches"), had no space check at all.

So on the production split path and after any rebuild, cross-space links/tag-refs
re-entered the cache — surfacing in backlinks/page-link rollups and inflating
`tags_cache.usage_count`.

## Fix

- `cache/block_links.rs` — `reindex_block_links_split`: resolve `source_space`
  from the `read_pool` (consistent with how the split path already reads
  content/targets) and add the identical `(?3 IS NULL OR ?3 = (…))` clause.
- `cache/block_tag_refs.rs` — `reindex_block_tag_refs_split`: same, and the
  INSERT is now **byte-identical** to the single-pool variant (restoring both
  the `deleted_at IS NULL` tag guard and the cross-space filter). Identical SQL
  text means it reuses the single-pool query's `.sqlx` cache entry — the old
  split-only entry is pruned.
- `cache/block_tag_refs.rs` — `compute_desired_pairs`: resolve every live
  block's space once into a `block_id → Option<space>` map (the same
  page_id-aware, soft-delete-guarded SQL as `space::resolve_block_space`) and
  keep a `(source, tag)` pair iff `source_space IS NULL` (unscoped → keep all,
  backward-compat) or `source_space == tag_space` (a NULL tag space drops,
  matching `NULL = ?3`). Covers both `rebuild_block_tag_refs_cache` and its
  `_split` sibling, which funnel through this function.

The "spaceless source keeps everything" branch is preserved in all three paths,
so legacy/unscoped blocks are unaffected; the change only converges the
split/rebuild paths onto the established single-pool policy.

## Verification

- 3 new regression tests (`cache/tests.rs`): split links, split tag-refs
  (cross-space + soft-deleted tag), and the full rebuild. The independent
  reviewer confirmed all three FAIL on `origin/main` and PASS on the branch.
- `cargo nextest` cache suite: 101 passed / 0 failed.
- `cargo sqlx prepare -- --tests` re-run; `.sqlx` updated (one new
  `compute_desired_pairs` entry; the now-redundant split tag-refs INSERT entry
  pruned because it became identical to single-pool).
- Independent technical review: confirmed SQL byte-identity, semantic match
  between the Rust-side rebuild filter and the incremental SQL filter, and
  backward-compat for spaceless sources.
