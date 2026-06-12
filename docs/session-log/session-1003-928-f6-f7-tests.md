# Session 1003 — #928 f6 + f7 (test/doc only)

Closes out the two remaining test-only findings of #928.

## f6 — `reorder()` no-op guard (doc + boundary test)
`src/stores/page-blocks.ts` `reorder()` guards `if (newIndex === currentSlot) return`
where `currentSlot = siblingSlot(blocks, block)`. `siblingSlot` counts the index
*including* the block itself; `newIndex` is the backend slot-basis *excluding* self —
they coincide only because dropping a block onto its own position yields the same count
either way. Added a comment documenting that, plus two vitest cases (siblings `[A,B,C]`):
`reorder(B,1)` (own slot) is a no-op (asserts `move_block` IPC NOT called + order
unchanged); `reorder(B,2)` moves B after C. Removing the guard trips the no-op assertion.

## f7 — same-parent tail-slot clamp parity (Rust integration test)
The engine `move_block_impl` clamps a same-parent move's slot to `count-1` (the node
vacates its slot first); the FE `moveDown` emits `sibIndex + 1`. New integration test
`move_same_parent_tail_clamp_matches_fe_new_index` (in `conformance.rs`, reusing its
engine-path harness: `install_for_test` + seed-into-engine + `dispatch_op` + `settle`)
drives `move_block(C,S1,0)` then `move_block(A,S1,2)` (the exact FE tail basis) and
asserts dense 1-based ranks with A clamped to the last slot — no gap/out-of-range/panic —
with an engine-tree-presence guard proving the production clamp path (not the SQL-only
fallback) ran.

## Verification
- `npx vitest run src/stores/__tests__/page-blocks.test.ts` → green (2 new f6 tests).
- `cargo nextest run -E 'test(move_same_parent_tail_clamp_matches_fe_new_index)'` + the
  surrounding conformance/move suite → green.

#928 status: f1 (single-block fixtures) + f2 (undo-move reproject fix) shipped in #955;
f3/f4 already on main (#940); f5 e2e in #959; f6/f7 here. The only remaining slice is the
f1 cross-parent **subtree** fixtures (need the TS-mock descendant page_id fix), tracked in
#957 — so #928 is not auto-closed here.
