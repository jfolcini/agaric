# Session 1004 — #957: tauri-mock descendant page_id + subtree move fixtures

Closes the remaining slice of #928 f1 (deferred from #955 because the cross-parent subtree
fixtures exposed a TS-mock divergence).

## The bug
On a cross-parent move, the Rust backend refreshes `page_id` for the moved block **and all
its descendants** (#664). The TS `tauri-mock` `move_block` handler recomputed `page_id` only
for the moved block, leaving descendants on their old page — so a moved subtree's descendants
diverged from the backend (the frontend conformance test failed on the subtree fixtures).

## Fix
`src/lib/tauri-mock/handlers.ts`: new `refreshDescendantPageIds(rootBlockId)` helper
(BFS over `parent_id` edges across the `blocks` map) sets every transitive descendant's
`page_id` to the moved block's recomputed `page_id`. Called in all three move paths after
the moved block's own `page_id` is set and before the slot renumber:
- `move_block` handler
- `undo_page_op` move branch (the #958 paths had the same single-block-only bug)
- `redo_page_op` move branch

## Fixtures (re-added, `expected` backend-generated via `CONFORMANCE_UPDATE=1`)
- `move_cross_parent_subtree.json` — S1(Home) > { A>A1, B }; move A under B. Descendants
  keep `page_id=B1` (Home).
- `move_multilevel_subtree.json` — S1(Home) > { A>A1>A1a, B }; move A under B. 3-deep chain,
  all `page_id=B1`, inner ranks dense 1-based.

## Verification
- Rust `cargo nextest run -E 'test(conformance)'` → 1 passed (all 9 fixtures incl. the 2 new).
- TS `vitest run …/conformance.test.ts` → 9 passed (was failing before on the divergence).
- `vitest run src/lib/tauri-mock` → 64 passed. `tsc -b` clean.

Closes #957. Completes #928 f1.
