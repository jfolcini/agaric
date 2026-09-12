# Session 1716 — four `too_many_lines` splits in the block commands (#4639)

Refs #4639, one slice: the four `#[expect(clippy::too_many_lines)]`
sites nearest the 70-line threshold, so each extraction is one small
helper placed above its caller. Pure moves, zero behaviour change; the
`#[expect]` on each is gone, which the build enforces. The four larger
sites in `crud.rs` (`delete_blocks_by_ids_inner`, `restore_block_inner`,
`restore_blocks_by_ids_inner`, `purge_blocks_by_ids_inner`) stay for a
later slice.

- `history.rs` `verify_undo_targets_in_tx` (71 lines): the missing-ref
  set difference that names the `NotFound` is `first_missing_ref`.
- `crud.rs` `delete_block_inner` (79): the in-transaction validation
  (exists, live, not a non-empty space) is `verify_deletable_in_tx`,
  returning the block type; same `CommandTx`, same point.
- `crud.rs` `move_blocks_to_space_inner` (75): the once-per-batch target
  check is `require_live_space_in_tx`.
- `crud.rs` `restore_all_deleted_inner` (86): the C9/#345 cascade-root
  query is `select_trash_cascade_roots_in_tx` over a private
  `TrashCascadeRoot` row; byte-identical SQL, so the `.sqlx` caches did
  not move.

Two redundancies surfaced by falsification, both pre-existing: a missing
undo ref is also refused by `revert_ops_in_tx`'s own per-op lookup, so
only the message text depends on `first_missing_ref`; and a non-space
move target is also refused by the per-block `space` property backstop,
which `move_blocks_to_space_rejects_non_space_target` already documents.
Noted, not changed: the space-validation SQL now in
`require_live_space_in_tx` is verbatim in `create_tag_in_space` and
`spaces.rs::create_page_in_space_inner`, and the cascade-root SQL is
verbatim in `purge_all_deleted_inner`; a later slice can point them at
the helpers.

## Verified

`cargo clippy -p agaric --lib --tests -- -D warnings` prints nothing with
the four attributes gone (before the split it reported 71, 79, 75, 86);
`SQLX_OFFLINE=true cargo check --workspace --all-targets` clean; `cargo
nextest run --workspace` 6318 passed, 13 skipped; `cargo test --doc
--workspace` 10 passed. The cascade-root SQL was compared byte for byte
between `HEAD` and the tree (771 bytes, identical), so the `.sqlx` entry
is unchanged. Falsified on copies: one guard dropped per crud helper
reddened a named test (`delete_block_already_deleted_returns_invalid_operation`,
`move_blocks_to_space_moves_all_in_one_tx`,
`restore_all_deleted_restores_all_soft_deleted_blocks`), and the reviewer
independently reddened `delete_block_refuses_to_delete_non_empty_space`
by dropping the non-empty-space guard; all restored, `cmp` clean. The
remaining count of `#[expect(clippy::too_many_lines)]` attributes is 116.
