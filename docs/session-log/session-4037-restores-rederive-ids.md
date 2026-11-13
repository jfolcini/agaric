# Session 4037 — Batch restore and restore-all re-derive `page_id` and `space_id`

#6522 follow-on, decided by the maintainer on the issue: since #6656 no vault-wide `RebuildPageIds` follows a restore, so each restore has to leave its rows with the ids their place in the tree gives them. Single restore already did. Batch restore did not at all, and restore-all re-derived `page_id` only.

Picked up from the handover (#6667): the branch held the two red tests and no fix.

## What changed

- **Batch restore** (`restore_blocks_by_ids_inner`) calls `rederive_page_and_space_ids` for each root, and for the topmost ancestor its chain brought back, in the order single restore uses.
- **Restore-all** (`restore_all_deleted_inner`) keeps its whole-table `page_id` backfill and then re-derives `space_id` for the rows it restored, through the new `cache::rederive_space_ids_in_tx`: the write half of `rebuild_space_ids`, for a list of ids, on the caller's connection.
- The bulk-equivalence baseline and a test comment said the batch path skips this refresh. Both now say it runs.

## Traps

- No command leaves a trashed row with a wrong `page_id` today, so the tests plant the drift by hand with the materializer shut down. Whatever ids the restore leaves are its own transaction's.
- `cargo test` on `command_integration` can fail two unrelated tests on a cold template database (`table _sqlx_migrations already exists`): threads of one process race to build it. nextest runs a process per test and does not.

## Verified

- `batch_restore_rederives_page_and_space_ids_6522` and `restore_all_rederives_page_and_space_ids_6522`: green, and each red on its "must re-derive" assertion with its fix removed.
- The other `_6522` lifecycle tests, `cargo clippy --workspace --all-targets -- -D warnings`, `node scripts/check-bulk-equivalence.mjs`.
- The full suites were left to CI: this container had no `cargo-nextest` while the item was built.
