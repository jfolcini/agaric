# Session 1573 — reconciliation oracle over `blocks.space_id` (#3345)

One artefact of #3345, on top of #4679 (PR #4802), which made it reachable: two registered spaces, a `SetProperty(space)` re-targeted onto the rooting page, and drivers that no longer stamp the column themselves. Before that the oracle would have diffed the harness's own constant against a rebuild rooted in the same constant.

**What the oracle now diffs.** `reconcile` gains Artefact 9: for every non-page block with a page ancestor, `blocks.space_id` must equal that page's own `space_id`, NULL included. The expected side is `fold_block_space_ids`, a Rust fold over the raw `blocks` dump that walks `parent_id` to the nearest page (the same walk Artefact 4 uses, so it reads no `page_id`) and copies the page's column; it shares no SQL with `set_block_space_id_from_parent`, the `space` projection, `rederive_page_and_space_ids` or `rebuild_space_ids`. Pages, top-level tags and orphans are scoped out, and the doc says why: a page's value is authoritative, a tag owns its own, and an orphan "keeps its last value", which is history rather than a function of base tables. Tombstones are in scope because no writer filters on `deleted_at` and the trash list reads the column live. The divergence names the block, the owning page and both values (`rebuilt-from-base: SPACE_Y (owning page PAGE_A's space_id)` / `incremental state: SPACE_X`), ordered directly after `blocks.page_id` so an ownership drift is reported once at its root. `OracleCoverage.derived_space_rows` is the fold's size; `distinct_block_spaces` is now the fold's distinct values over derived rows rather than a `COUNT(DISTINCT)` over every row, so it counts spaces the oracle audited a block in, not spaces an authoritative row happens to name.

**Settling.** Unchanged from #4679: B6 asks production's `invalidations_for_op` and runs the `SetBlockPageId` space half it names, never a fixed list, and asserts on state. Every settle in B6 now fails through `TestCaseError` instead of `.expect`, so a dispatch-table error shrinks to the op that caused it. B6's space non-vacuity moved onto the fold: one page group is in one space at a time, so a per-op peak can never read two; B6 unions the fold's values across the chain and requires two whenever the chain both created a block and migrated the group with one present.

**What a broken maintainer looks like.** The test is the falsification, not a
companion to it: `block_space_ids_reconcile_and_report_a_missed_stamp_3345` builds the state a
broken maintainer leaves and asserts the oracle REPORTS it, in both directions. Direction 1 is
three created blocks whose `SetBlockPageId` space half never ran — the oracle names each block,
the page it should have inherited from and the NULL it holds (`in 3 place(s)`; `B_CHILD`, which
was stamped, is not among them) — and then production's own
`set_block_space_id_from_parent` runs, in production's order (a child copies its PARENT's
column, so the parent is stamped first), and the vault reconciles. Direction 2 moves `PAGE_A`
to `SPACE_Y` and leaves its group behind, so the report names both spaces and the reader can
see which way it drifted.

That structure makes it non-vacuous by construction — with no Artefact 9,
`reconciliation_failure` returns `None` and the `.expect` panics — and this was confirmed
rather than assumed: silencing the artefact's `out.push` against a copy of
`reconciliation_oracle.rs` reddens exactly
`block_space_ids_reconcile_and_report_a_missed_stamp_3345` and leaves the four other `3345`
tests green. Restored and `cmp`-verified.

One mutation deliberately NOT used: rewriting `set_block_space_id_from_parent`'s SQL. It is a
`sqlx::query!`, so changing its text invalidates the offline `.sqlx` cache and the crate stops
compiling under `SQLX_OFFLINE` — the run produces no test signal at all, which is easy to
misread as a passing mutant.

**What stays uncovered.** B6 has one page group and its content blocks are all leaves-or-siblings under `PAGE_ID`, so the nested-page boundary in a different space, the orphan and the tag rest solely on `block_space_ids_reconcile_and_report_a_missed_stamp_3345`; do not read a green B6 as broad coverage. The settle calls the production function directly, so the `SetBlockPageId` task-to-function wiring is not audited here (pinned in the materializer tests). The remaining #3345 artefacts (`agenda_cache`, `projected_agenda_cache`, `block_tag_refs`, `tags_cache.usage_count`) are untouched, one PR each.

**Rebase note.** Written against a base that predates #4733 (PR #4800), which rewrote the same
file's coverage counters. Rebased onto it before shipping rather than merged: the one conflict
was in `oracle_coverage`, where #4733 added `fts_tombstoned_blocks` and this change added the
two space folds — both fold the SAME `dump_blocks` result for independent artefacts, so both
sides stay. `cargo nextest run --workspace` on the rebased tree: **6304/6304 passed**. A clean
suite on the stale base would have proved nothing about the tree that ships.

## Review round 1 — the new artefact makes a latent generator bug observable

Blocking, and correctly placed in the GENERATOR rather than the oracle.
`prepare_chain_b5` re-targets `SetProperty(space)` onto `PAGE_ID` but leaves
`DeleteProperty` alone, and `ChainModel` gates `DeleteProperty` on "the key was
Set on this block" — resolving both BEFORE that rewrite. So the chain
`Create(B1) → SetProperty(B1, space) → DeleteProperty(B1, space)` is
generatable, the third op runs `project_delete_property_to_sql`'s space arm
(`UPDATE blocks SET space_id = NULL WHERE id = ? OR page_id = ?`) against a
CONTENT block, and nothing repairs it: `invalidations_for_op` returns no
`SetBlockPageId` for `DeleteProperty`. Artefact 9 then reports it, correctly —
roughly 4% of B6 runs, so a green CI run here would not have cleared it.

The artefact is right and the chain is unreachable in production: R17 means the
command layer only ever writes `space` on a page. So the fix is to drop
`DeleteProperty(space)` in `prepare_chain_b5`, the way `prepare_chain` already
drops `SetProperty(space)`. Re-targeting it onto `PAGE_ID` instead is NOT
equivalent — that nulls the whole page group's space and trips B5's own
zero-`sql_only_fallback` guard on the next op.

Two non-blocking notes taken. `fold_block_space_ids`'s two `by_id.get(...) else
{ continue }` arms were unreachable — `fold_page_ownership` keys on every block
in the same slice `by_id` is built from — so they are gone and the lookups index
directly; a silent `continue` there would have shrunk what the artefact audits
without reporting anything. And the per-op `oracle_coverage` read now fails
through `TestCaseError` like the three settles beside it, so a failure shrinks to
the op that caused it.

`cargo nextest run --workspace` after the change: **6304/6304 passed**.
