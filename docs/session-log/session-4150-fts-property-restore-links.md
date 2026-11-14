# Session 4150 — The FTS incremental-equals-rebuild property left the link reindex out of its restore step

Set out to fix what #6766 reported and left: `fts::tests::incremental_equals_rebuild_6534` red about one run in twelve on `main`. The brief called it a defect in the incremental FTS writers. It is not one: the property's own restore step was missing a writer production runs.

## What was wrong

The minimal input writes a link to a page into a block that is in the Trash, restores the block, then renames the page. A link reindex reads a tombstoned source as content-less, so the write drops the block's `block_links` rows, and a page rename finds the blocks to re-strip through `block_links`. Production re-derives the links at every restore site before the FTS pass (`reindex_restored_cohort_links`, #4209 and #4285). The property's `Step::Restore` ran only the FTS half, so the rename never reached the block.

## What shipped

- `Step::Restore` runs `reindex_block_links` first, as production does. The generator, the case count and the assertion are unchanged.
- The seed `cc 4380c303…` is committed under `agaric-store/proptest-regressions/`.
- `a_rename_reaches_the_fts_row_of_a_block_edited_in_the_trash_then_restored` drives the same sequence through the materializer's op pipeline. It was green on `main` before any change, and red (`see Plain café page` where `see rust` is expected) with both restore-side link reindexes removed.

No production code changed.

## Tags

A tag rename has no such dependency: `referrers_of` finds a tag's mentions by scanning `blocks.content`, not through `block_tag_refs`. The property renames the tag too and passed.

## Which routes edit a block in the Trash

Read from the code, not run: the local `edit_block`, MCP, the markdown mirror, drafts and undo all refuse a deleted block. An inbound sync merge and a replayed `edit_block` op do write its content, and both then run the link reindex that drops its rows.

## Read, not reproduced, and left alone

Three paths clear `deleted_at` without a link reindex, by reading: the `MoveBlock` un-sweep of an inherited tombstone, a sync-imported restore's cohort members whose own engine state did not change in that import, and the recovery reprojection. None was reproduced, and each is in the materializer or recovery, outside this change.

## Suites run

`agaric-store` property at `PROPTEST_CASES=20000` (green), the new app-crate test, `cargo clippy --workspace --all-targets -- -D warnings`.
