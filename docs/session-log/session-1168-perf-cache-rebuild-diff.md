# Session 1168 — Perf: diff-based cache rebuilds (#2668, #2669)

## Scope

Two backend cache-rebuild perf bugs, shipped as one PR.

### #2668 — `page_id`/`space_id` rebuilds rewrote every row

`agaric-store/src/cache/page_id.rs`. The three full-table rewrites now write only
changed rows (mirroring the sibling `agenda.rs`/`block_tag_refs.rs` diff writers):

- `page_id` (single-pool + split-pool) share `compute_page_id_diff()` →
  `apply_page_id_diff()`. Desired map = the recursive ancestor CTE
  (`DESIRED_PAGE_ID_SQL`, unchanged) plus an in-memory monotone parent-copy fixpoint
  replacing the old SQL `extend_page_ids_below_depth_cap` loop (byte-identical result).
  Diff vs live column: `to_set` (chunked `CASE … WHERE id IN` UPDATE) and `to_null`
  (chunked `SET page_id = NULL WHERE id IN`). Early-return on empty diff. Single-pool
  computes the diff inside the write tx (atomic); split computes on `read_pool`, applies
  on `write_pool` (stale-while-revalidate preserved, strictly safer than the old full
  NULL-reset).
- `rebuild_space_ids` keeps its single `query!` but adds a null-safe change guard
  (`AND space_id IS NOT <owning page's space_id>`) — same target rows, zero writes when
  already correct.

### #2669 — redundant whole-vault `RebuildTagInheritanceCache`

`src/materializer/dispatch.rs`. Removed the redundant whole-vault rebuild from the
MoveBlock and RemoveTag arms; the in-tx helpers (`recompute_subtree_inheritance`,
`remove_inherited_tag`) already cover the full affected scope byte-identically. KEPT
the rebuild for AddTag (made conditional `if matches!(op_type, OpType::AddTag)`): its
in-tx `propagate_tag_to_descendants` is an `INSERT OR IGNORE` that is effective-tag
complete but does not re-point an existing inherited row to a newly-added closer
ancestor (`inherited_from` provenance divergence, pinned by a divergence test).

## Tests

- `page_id.rs`: 5 `_2668` tests (zero writes when unchanged for single-pool + split;
  only-changed-rows written with idempotent 0-write follow-up; stale-orphan NULLed;
  `space_id` zero/only-changed).
- `tag_inheritance/tests.rs`: 4 `_2669` tests (move/remove byte-equivalence vs
  `rebuild_all`; add-simple equivalence; add-nested provenance-divergence pin).

## Review

Independent adversarial deep review (Opus): no under-invalidation found; confirmed
the diff-pass equivalence (incl. depth-cap fixpoint, `to_null` path, split-pool
no-TOCTOU) and the move/remove scope-coverage claims. Full suite 3470 passed / 0
failed / 6 skipped; clippy clean. Reviewer regenerated the missing per-crate
`agaric-store/.sqlx` cache for the modified `rebuild_space_ids` query.

Closes #2668, #2669.
