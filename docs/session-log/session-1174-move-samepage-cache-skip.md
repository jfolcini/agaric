# Session 1174 — Skip 3 page-caches on same-page moves (#2700)

## Scope

The MoveBlock invalidation arm (`materializer/dispatch.rs`) unconditionally
enqueued `RebuildPagesCache`, `RebuildPageLinkCache`, and
`RebuildProjectedAgendaCache` — all `page_id`-derived and justified only for
cross-page reparents (#627/#2196) — even for same-parent sibling reorders and
same-page indents (burst editor gestures) that provably can't change any block's
`page_id`. Each fired a full `block_links` re-aggregation + a 365-day recurrence
re-expansion in a writer tx. Filed from the 2026-07-16 deep review (severity:low).

## Change

Thread a `same_page` hint from the move command into dispatch, mirroring the
`block_type_hint` precedent:

- `commands/blocks/move_ops.rs` `move_block_in_tx`: read the moved block's
  `page_id` before and after `apply_op_projected` (the in-tx
  `rederive_page_and_space_ids` runs synchronously, chunk=None), and compute
  `same_page = old_page_id == new_page_id AND !subtree_has_nested_page`.
- `db/command_tx.rs`: new `PendingDispatch::MoveBackground { record, same_page }`
  + `enqueue_move_background`, drained post-commit into
  `Materializer::dispatch_move_background` → `enqueue_background_tasks(record,
  None, Some(same_page))`.
- `materializer/dispatch.rs`: `invalidations_for_op` / `enqueue_background_tasks`
  gained a `move_same_page: Option<bool>` param; the MoveBlock arm gates exactly
  the 3 page-caches behind `if !same_page`. `None` (remote replay / inbound sync /
  boot) and `Some(false)` (cross-page) keep the full conservative set.
  `RebuildTagInheritanceCache` and `RebuildAgendaCache` left unconditional.

## The nested-page safety conjunct (found by adversarial review)

The naive "root `page_id` unchanged ⇒ whole subtree's `page_id` unchanged" is
FALSE when the moved subtree contains a nested page: `rederive_page_and_space_ids`
collects all descendants by recursing on `parent_id` with no `block_type != 'page'`
boundary, then flattens every non-page descendant onto the moved root's page. So a
same-page indent dragging a nested page DOES change that page's content
descendants' `page_id`, and skipping the rebuilds would leave `page_link_cache` /
`projected_agenda_cache` stale (demonstrable stale backlink source-page). The
`!subtree_has_nested_page` conjunct forces the full rebuild whenever a nested page
rides along; the common nested-page-free reorder/indent keeps the optimization.

## Tests

Matrix (`Some(true)` skips the 3; `Some(false)`/`None` keep the full set);
end-to-end byte-identical equivalence for a same-parent reorder and a same-page
indent (non-empty page_link + projected_agenda caches, move, settle reduced
fan-out, force full rebuild, assert identical); and
`same_page_indent_with_nested_page_forces_full_rebuild_2700` — proven both
directions (FAILS with the guard removed: `page_link_cache diverged … after a
same-page indent dragging a nested page`; PASSES with it).

## Review

Independent adversarial deep review (Opus) initially returned DO-NOT-SHIP,
empirically reproducing the nested-page under-invalidation; the guard + pin test
were added and re-verified. Batch moves (per-move hint), before/after read timing
(synchronous in-tx), and hint-absent safety all confirmed. Full suite 3472 passed
/ 0 failed / 6 skipped; clippy `-D warnings` clean; #646/#110 guards pass; no
`.sqlx` delta.

Closes #2700.
