# Session 1169 — Engine purge no longer leaks descendants' CRDT map entries (#2694)

## Scope

`apply_purge_block` (agaric-engine `src/loro/engine/apply.rs`) deleted the seed
block's tree node and removed its `BLOCK_PROPERTIES_ROOT` / `BLOCK_TAGS_ROOT` map
entries — but only for the seed `block_id`. The purge emits a single `PurgeBlock`
op for the seed (SQL-cascades descendants); there is no per-descendant engine
fan-out. So purged descendants' property/tag entries stayed in the per-space
LoroDoc forever (doc/snapshot bloat, exported to peers in sync envelopes),
eroding the engine/SQL two-target parity invariant. Surfaced by the 2026-07-16
multi-agent deep review.

## Change

`apply_purge_block` now builds `purge_ids` from `collect_subtree_block_ids(node)`
(seed + all live descendants, collected BEFORE the tree node is deleted) and
loops deleting each id's entry from both `BLOCK_PROPERTIES_ROOT` and
`BLOCK_TAGS_ROOT`, using the same `props_root.get(id)/.delete(id)` API the
seed-only code used. When the seed's tree node is already absent (empty-trash /
double-purge), a guard still pushes the seed id so its lingering entries are
cleaned. `purge_blocks_by_ids_inner` (multi-select cohort path, which already
fans a per-member engine PurgeBlock and does not leak) is untouched. The fix
covers the single-purge, empty-trash, and remote/replay paths since they all
route through `apply_purge_block`.

The method docstring — which falsely claimed the materializer "dispatches one
PurgeBlock per descendant" — is corrected to match the inline comment: a single
seed PurgeBlock, with the engine pruning descendants' index + property/tag
entries locally.

## Tests

`purge_parent_wipes_descendant_property_and_tag_entries` (engine `mod tree_tests`)
sets a property AND a tag on a CHILD, asserts both raw-map entries exist, purges
the PARENT, then asserts the child's entries are gone from both roots via direct
`doc.get_map(...)` reads (plus public `read_property_typed`/`read_tags`). Fails
pre-fix (seed-only deletion leaves the child's entries), passes post-fix.

## Review

Independent consolidation + adversarial review: collect-then-delete ordering
confirmed correct (descendants not missed); absent-seed idempotency verified;
no over-deletion; the test is a genuine regression guard. Full suite 3461 passed
/ 0 failed / 6 skipped; clippy `-D warnings` clean; no `.sqlx` delta (pure
CRDT-map change).

Closes #2694.
