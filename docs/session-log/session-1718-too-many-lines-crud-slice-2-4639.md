# Session 1718 — the rest of `crud.rs` and the space-validation dedup (#4639)

Refs #4639, second slice. The four remaining
`#[expect(clippy::too_many_lines)]` sites in `commands/blocks/crud.rs`
are split, and the two dedup notes the reviewer left on #4985 are folded
in. Pure moves; every in-transaction call stays in the same `CommandTx`
at the same point, every post-commit fan-out still runs after `commit`.
Attribute count 116 to 110; `crud.rs` is at zero.

- `delete_blocks_by_ids_inner`: `load_deletable_roots_in_tx` (the live-root
  probe and the non-empty-space refusal) and `append_delete_ops_in_tx`
  (one `DeleteBlock` op per root plus the pre-update cohort capture).
- `restore_block_inner`: `verify_restorable_in_tx` (exists, is deleted,
  `deleted_at` matches) and `dispatch_restore_fanout` (post-commit engine,
  link and FTS fan-out).
- `restore_blocks_by_ids_inner`: `load_restore_roots_in_tx` (the #3838
  live-id refusal and root resolve, reusing `TrashCascadeRoot`),
  `append_restore_ops_in_tx` and `dispatch_restore_batch_fanout`.
- `purge_blocks_by_ids_inner`: `load_purge_roots_in_tx` (the #3819
  live-id refusal) and `append_purge_ops_in_tx`.
- `purge_all_deleted_inner` calls `select_trash_cascade_roots_in_tx`
  instead of carrying a byte-identical copy of the cascade-root SQL.
- The space-validation SQL was verbatim at six sites (SQL and error text
  compared byte for byte); it is one `pub(crate)` `require_live_space_in_tx`
  in `commands/spaces.rs`, called from all six. Two of those callers,
  `create_page_in_space_inner` and `resolve_or_create_journal_page`,
  dropped under the threshold and lost their attributes as a consequence.

One thing surfaced by falsification and left alone: with the shared
guard merely disabled, four of the five "rejects an invalid space" tests
stay green because the #708 `spaces`-registry gate on the apply path
refuses the same input downstream; only the bibliography test pins the
early check specifically. Pre-existing, and the reviewer of #4985 already
named the two "is a space" definitions as a later slice's target.

The bulk-vs-fold inventory (#3346) caught `dispatch_restore_batch_fanout`
by its `batch` segment; it is recorded as `converged` in
`scripts/bulk-equivalence-baseline.json`, being the loop of the same three
per-root calls the single path's `dispatch_restore_fanout` makes, plus
one union FTS pass.

## Verified

`cargo clippy -p agaric --lib --tests -- -D warnings` prints nothing with
the six attributes gone; `SQLX_OFFLINE=true cargo check --workspace
--all-targets` 0 warnings; `cargo nextest run --workspace` 6318 passed, 13
skipped; `cargo test --doc --workspace` 10 passed. Every SQL literal that
moved was hashed old against new (the cascade-root query, the restore-root
query, and the six space-validation copies), all identical, so `.sqlx` is
untouched. Falsified on copies: one guard or write dropped per new helper
reddened a named test (`delete_blocks_by_ids_space_refusal_aborts_whole_batch`,
`restore_block_mismatched_deleted_at_returns_invalid_operation`,
`restore_blocks_by_ids_refuses_a_live_id`,
`purge_blocks_by_ids_refuses_a_live_id`,
`purge_all_deleted_removes_all_soft_deleted_blocks`, and the six
space-site happy paths with the shared guard set to always reject); the
reviewer independently reddened
`restore_block_inner_fans_the_restored_subtree_to_the_engine` by skipping
the post-commit fan-out. All restored, `cmp` clean.
