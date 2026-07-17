# Session 1170 — Scope inbound-sync block_tag_refs rebuild to changed blocks (#2667)

## Scope

`enqueue_inbound_sync_rebuilds` (`src-tauri/src/materializer/dispatch.rs`) fanned
out the full `INBOUND_SYNC_CACHE_REBUILD_TASKS` array — 8 global
O(vault)/O(pages)/O(links) cache rebuilds — for ANY non-empty inbound delta, even
a single-block remote change arriving at the sender's ~3s debounce cadence during
active peer editing. FTS was already narrowed per-changed-block in the same
function (#421) and tag-inheritance excluded (#2265), but the other 8 were not.

## Change

Narrowed **exactly one** of the eight — `RebuildBlockTagRefsCache` — to
per-changed-block `ReindexBlockTagRefs` below a threshold (single full rebuild
above), the direct structural analog of the shipped #421 FTS narrowing:

- Removed `RebuildBlockTagRefsCache` from `INBOUND_SYNC_CACHE_REBUILD_TASKS`
  (8 → 7).
- Added pure selector `inbound_sync_block_tag_refs_tasks(changed_blocks)`
  (empty → none; ≤ threshold → per-block `ReindexBlockTagRefs`; > threshold →
  single `RebuildBlockTagRefsCache`), enqueued inline right after the FTS loop.
- Threshold `SYNC_BLOCK_TAG_REFS_PER_BLOCK_MAX = SYNC_FTS_PER_BLOCK_MAX`
  (`BACKGROUND_CAPACITY/4` = 256) — aliased to the existing #421 queue-safety
  bound, since the same `changed_blocks` set gates both per-block fan-outs.

**Why safe:** `block_tag_refs` rows derive only from a block's own inline
`#[ULID]` tag tokens (filtered to live same-space tag blocks). The full rebuild
`compute_desired_pairs` is by design the union over live blocks of exactly what
per-block `reindex_block_tag_refs` computes (same `deleted_at IS NULL`,
tag-block, source-space filters — pinned by #375/#678); no cross-block roll-up,
no move-staleness gap (a MOVE never changes a block's own tokens). The per-block
path also matches the local-edit path (which drives the identical
`reindex_block_tag_refs`). Purges need no task: both FKs are `ON DELETE CASCADE`
(migration 0034), as with FTS. The one asymmetry — a transient
tag-space-propagation-gap where the per-block path yields a subset (never extra
rows), self-healing on any full rebuild — matches accepted local behavior and
improves cross-device convergence.

The other 7 rebuilds stay global: no proven per-block scoped variant covers them
from the changed-block id set (usage_count needs tag_ids; pages caches are
page-level aggregates; agenda has no per-block task; RebuildPageIds needs
descendant re-derivation; page_link_cache has the #627 cross-page roll-up gap).
#2264 both-empty short-circuit and #2265 tag-inheritance exclusion untouched.

## Tests

- Unit selector tests (empty/small/at-threshold/large), mirroring FTS.
- Pinning invariant → `inbound_sync_set_is_full_minus_tag_inheritance_and_block_tag_refs`.
- `inbound_block_tag_refs_scoped_equals_global_rebuild_2667`: applies a small
  delta (incl. a soft-deleted referencing block and a stray non-tag ref),
  snapshots `block_tag_refs`, runs the global `rebuild_block_tag_refs_cache` on
  the same pool, asserts byte-identical.
- Purge-only test proving the cascade path enqueues nothing and matches a full
  rebuild.

## Review

Independent adversarial deep review (Opus): equivalence confirmed (true per-block
union, no roll-up); dormant-ref revival ruled acceptable-known-limitation
matching local behavior (net convergence improvement); move-staleness, purge
cascade, threshold safety, and the 7 kept-global tasks all confirmed. Full suite
3462 passed / 0 failed / 6 skipped; clippy `-D warnings` clean; no `.sqlx` delta.
Re-verified after rebasing onto an overlapping materializer-invalidation change
(#ef7c36bd): check + clippy + 54 targeted tests green.

Closes #2667.
