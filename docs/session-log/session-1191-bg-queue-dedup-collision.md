# Session 1191 — Materializer dedup: key on id, not a 64-bit fingerprint

**Date:** 2026-07-22
**Branch:** `fix/bg-queue-dedup-collision`
**Closes:** #2911

## Summary

Fix a silent-drop correctness bug (#2911) in the materializer background-queue
dedup. File: `src-tauri/src/materializer/dedup.rs`.

## The bug

`dedup_tasks` deduplicated the seven per-block task kinds (`ReindexBlockLinks`,
`ReindexBlockTagRefs`, `UpdateFtsBlock`, `ReindexFtsReferences`, `RemoveFtsBlock`,
`RefreshTagUsageCount`, `SetBlockPageId`) by inserting a **64-bit FxHasher
fingerprint** of the id (`hash_id`) into per-kind `seen_*` sets. Two *distinct*
ids that collide on the 64-bit fingerprint within a single drain would make the
second `insert` fail, silently dropping that id's task — leaving stale
FTS/links/tag-count/page_id with no signal until an unrelated lifecycle rebuild.
The #2540 comment on `SetBlockPageId` already flagged exactly this consequence.

## The fix

Key the seen-sets on the **id itself** instead of a fingerprint. The task ids are
already `Arc<str>`, so:

- `seen_*` sets changed from `FxHashSet<u64>` to `FxHashSet<Arc<str>>`.
- Each per-id arm does `seen_X.insert(Arc::clone(id))` — a refcount bump, not a
  string copy, so no perf regression.
- `hash_id()` and the `FxHasher` import removed.

`FxHashSet<Arc<str>>` hashes/compares by the dereferenced str **contents** (Arc
delegates `Hash`/`Eq` to `str`; FxHasher only swaps the hashing algorithm, not
what is hashed), so equal-content ids from different allocations correctly dedup.
This eliminates the collision class by construction — there is no fingerprinting
step anymore. All other behavior is unchanged: same match order, same
first-occurrence-wins contract, the `mem::discriminant` catch-all arm, the
`RebuildPagesCacheCounts` deferred-flag tail, and the never-deduped
`ApplyOp`/`BatchApplyOps`/`Barrier` arm.

## Tests

Added `#[cfg(test)] mod tests` to dedup.rs: `per_id_arms_dedup_on_identity_not_a_fingerprint`
(all 7 arms: same id → 1 survivor, distinct ids → 2 survivors, using independent
`Arc<str>` allocations so a pointer-identity bug would fail it) and
`mixed_per_id_kinds_dedup_independently` (per-kind counts in one drain, no
cross-arm bleed). Backend suite: 385 passed, 0 failed; clippy clean.
