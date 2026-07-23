# Session 1203 — Fold the double subtree walk in move-block rederive into one

**Date:** 2026-07-23
**Branch:** `perf/single-subtree-walk-move`
**Closes:** #2936

## Summary

`rederive_page_and_space_ids` (`src-tauri/agaric-store/src/block_descendants.rs`), run
inside the move-block transaction to re-stamp `page_id`/`space_id` on a moved subtree,
embedded the **same** `WITH RECURSIVE descendants(...)` walk twice — once in the step-3
`page_id` UPDATE and once in the step-4 `space_id` UPDATE. The two CTE bodies were
character-identical (same seed `parent_id = ?1 AND deleted_at IS NULL`, same recursive arm
with the `depth < 100` cap and `block_type != 'page'` boundary). The walk reads only
`parent_id`/`deleted_at`/`block_type`/`depth` — never `page_id`/`space_id` — so it is
invariant across the two UPDATEs. This folds it into a single walk: capture the descendant
id-set once (before the page_id UPDATE), then drive both UPDATEs off that captured set.

## The change

- Capture the subtree once via a runtime `query` (the byte-identical CTE body → `Vec<String>`
  of ids), serialize to a JSON array, and feed both UPDATEs `IN (SELECT value FROM json_each(?1))`.
- **Ordering preserved:** page_id UPDATE still runs before space_id UPDATE, so step 4's
  correlated `SELECT p.space_id FROM blocks p WHERE p.id = blocks.page_id` reads the freshly
  written page_id. The space subquery stays **per-row correlated** (not flattened to a constant),
  and the `page_id IS NOT NULL` guard is retained (a no-page destination leaves space_id untouched).
- **Row-set equivalence:** step 3 excludes the root (`block_type != 'page'` + the walk seeds on
  children of root; root's page_id was set separately in step 2); step 4 re-includes the root
  (`id = ?2[root] OR id IN json_each(...)`). Nested-page boundary rows are in the captured set but
  excluded by each UPDATE's own `block_type != 'page'`, exactly as before.
- Two compile-time `query!` macros became runtime queries, so their `.sqlx` cache entries
  (`...1089.json` space_id UPDATE, `...517fb.json` page_id UPDATE) are deleted with no new/orphan
  entries. New runtime queries carry `// dynamic-sql:` markers per the module's convention.

## Tests

Two new integration tests drive the real `move_block_inner` pipeline and assert committed DB
state (`src-tauri/src/command_integration_tests/block_integration.rs`):

- `move_multilevel_subtree_cross_space_cascades_page_and_space_id` — moves a 3-deep subtree
  (R/C/G) across spaces and asserts, per row, `page_id == P2` **and** a separate `space_id == P2`.
  Catches the trap where page cascades but space goes stale/dropped.
- `same_parent_reorder_skips_page_and_space_rederive` — a same-parent reorder hits the #2200
  early-out that skips the rederive; a sentinel (A paged to P1 but stamped space P2) must survive,
  so a wrongly-run cascade would fail. Also guards the (d) "space flattened to a constant" case:
  nested-page content `NC` behind the page boundary must stay `space P1`.

## Verification

Independent adversarial review confirmed byte-for-byte CTE identity against `origin/main` and the
two deleted `.sqlx` entries; both UPDATEs' row sets and the per-row space correlation are provably
identical to origin; bind ordering (numbered params) correct; both new tests non-tautological.
`cargo nextest` (move/reparent/rederive/cascade/descendant/subtree filter) **299 passed, 0 failed**;
both new tests pass by name; agaric-store CTE drift guards **4 passed**; `clippy --workspace --lib
--tests -D warnings` clean; `.sqlx` shows exactly the 2 expected deletions, 0 orphans.
