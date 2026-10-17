# Session 2330 — A peer keeps a page moved to another space, whatever order the docs arrive

#5712: a peer could lose the blocks of a page that another device had moved
to a different space, depending on which space's doc it imported first. The new space's engine still held the
page, but the SQL rows were gone.

**Cause.** A cross-space move prunes the subtree from the old space's doc
(#2907). On the peer, the import derives its purged set as "held before minus
held after", so the prune reads as a purge, and Pass D deleted those rows from
every table. When the new space's doc had already been imported, nothing
recreated them. The responder sends spaces in `registry.space_ids()` order,
which is HashMap order, so either order happens.

**Fix.** Pass D (`project_pass_d`) now sweeps only the ids that no engine
holds, using `LoroEngineRegistry::spaces_containing` from #5711. The same
filter covers the crash-recovery path's saved tombstone, so
`narrow_tombstone_to_sweep` (#2292's narrower filter for that list alone) is
gone.

**Tests.** `move_page_across_spaces_then_import` in `src/spaces/tests.rs`
drives the real commands and forces each import order through
`apply_remote`. New-space-first went red without the filter; old-space-first
was already green. `replay_keeps_rows_another_space_holds_despite_the_tombstone_5712`
pins the recovery path, and it alone went red when the filter covered only
the engine's purged set.

**Still open; the maintainer approved closing it.** When the old doc
arrives first, Pass D still deletes the rows and the new doc's import
recreates them from the engine. Whatever the docs don't carry is lost in that
order:
- the peer's own device-local rows on the moved blocks: `block_drafts` and
  `page_opens` (through the `blocks` cascade). Attachment rows come back
  with the new doc now that #5608 keeps them in the engine;
- rows on untouched blocks that point at the moved ones: `block_links`
  backlinks and `block_properties.value_ref`, probed in review. `block_tags`
  likely goes the same way, but it was not probed.

The new-space-first order keeps all of them. A move-out marker in the old doc
(a follow-up under #5712, designed separately) is to let the peer tell a
prune from a purge and keep those rows.

The review also probed moving a page there and back, with and without an
intermediate sync and in both import orders: all four end with the blocks
live in the old space.

Gates: targeted nextest (sync, spaces, projection, registry, loro_sync),
1,581 passed; full workspace nextest, 3,504 + 3,496 passed; clippy, fmt and
`SQLX_OFFLINE=true cargo check --workspace --all-targets`, all clean.

Session 2328 (#5608) said this loss was "filed separately"; it is #5712.
