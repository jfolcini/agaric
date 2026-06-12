# Session 1000 — UX backlog: move conformance + undo-move reprojection fix

Part of the "fix all ux backlog issues" sweep (#921–#929). This entry covers the
Rust/backend findings of **#928** (block-move conformance + undo).

## #928 — conformance fixtures for moves + undo-of-move reprojection bug

### Finding 1 — conformance coverage for moves (2 single-block fixtures)
`conformance/fixtures/` gained move cases authored by the backend source-of-truth
(`CONFORMANCE_UPDATE=1`):
- `move_indent.json` — indent (move under previous sibling at append slot).
- `move_dedent.json` — dedent (move out to grandparent between two siblings).

The cross-parent **subtree** fixtures (block moved *with descendants*) are deferred to a
follow-up: they exposed a real divergence — the Rust materializer refreshes descendants'
`page_id` on a cross-parent move (#664), but the TS `tauri-mock` `move_block` handler
updates only the moved block, leaving descendant `page_id` stale. Shipping those fixtures
now would red the frontend conformance test (`conformance.test.ts`); they belong with the
mock fix. Tracked as #957.

The engine apply path does not enforce `MAX_BLOCK_DEPTH` (only the command layer does),
so the depth-clamp case can't be a conformance fixture — instead a subtree-aware
depth-clamp test (`move_block_with_deep_subtree_exceeding_max_depth_returns_validation_error`)
was added to `block_cmd_tests.rs`, covering the `parent_depth + 1 + subtree_depth`
dimension the existing single-block test misses.

### Finding 2 — undo-of-move reprojection (REAL data-integrity bug, fixed)
`apply_reverse_in_tx`'s MoveBlock arm did a raw `UPDATE blocks SET parent_id, position`
writing the **provisional** rank and never reprojected — the reverse-apply path only
enqueues a background cache rebuild, never the foreground engine apply. Undoing a
cross-page move left the source group with duplicate positions (`[A=1, B=2, C=2]`).

**Fix** (`commands/history.rs`): capture the moved block's current parent *before* the
reverse UPDATE, then re-densify **both** affected sibling groups via a new
`reproject_live_sibling_group` helper (reads canonical `(position ASC, id ASC)` live
order, excludes tombstones, delegates to `projection::reproject_dense_positions`) —
mirroring the forward `apply_move_block_via_loro` `old_siblings`/`new_siblings`
reprojection. Same-parent undos reproject once (dedup guard).

### Tests / verification
- New integration test `undo_cross_page_move_reprojects_source_group_dense`
  (`undo_integration.rs`) drives the move through the **engine path**
  (`install_for_test` + `seed_block_both` + `dispatch_op`) and ends with a guard
  asserting every block is present in the engine tree — a silent regression to the
  SQL-only fallback fails loudly.
- One stale assertion (`revert_move_block_restores_original_position`) that encoded the
  old buggy gapped value was corrected to the dense rank.
- No compile-time `query!`/`query_as!` added (only dynamic `query_scalar`) → no `.sqlx`
  regen.
- `cargo nextest run` (full suite): **4448 passed, 0 failed, 7 skipped**.
- Conformance + the 3 changed tests re-verified green in the review pass.

Partial #928 — Findings 1 & 2 of 7. Remaining (separate follow-ups): f3 frontend
`MAX_BLOCK_DEPTH` awareness, f4 `getProjection` maxDepth subtree-height clamp, f5 e2e
undo/redo of structural move, f6 `reorder()` no-op guard doc + test, f7 same-parent
tail-slot clamp parity test. No `Closes` — a re-scope comment is posted on #928.
