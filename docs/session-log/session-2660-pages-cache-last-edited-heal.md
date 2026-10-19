# Session 2660 — pages created by 0.18 with their space in one command get their last-edited time raised to the op log

The maintainer's 0.19.0 integrity check reported two `pages_cache.last_edited_ms`
divergences. Diagnosed from a read-only copy of the vault; the running app's
database was never opened.

- **Cause, fixed before 0.19.0:** both pages were created on 2026-10-17 by
  0.18.0 through a `[[New page]]` link (`create_page_in_space`): a
  `create_block` and, 1–2 ms later, the page's `space` stamp. 0.18's
  `create_page_in_space_inner` dropped the stamp's op record, and
  `CommandTx::commit_and_dispatch` raised `last_edited_ms` only for the ops it
  dispatched, so the row kept the create's time. Pages that got any later op
  were raised by it; these two link targets never did. 3cd3bf5a3 (in 0.19.0)
  queues the stamp through `enqueue_without_dispatch`; no other command still
  drops a space record for a page. `create_page_in_space_is_last_edited_at_its_space_stamp`
  goes red with that line removed, on the vault's shape.
- **Heal:** nothing raised an existing row (the integrity check only reads,
  `RebuildPagesCache` fills only rows still at 0, and boot checks only missing,
  zero or misplaced rows), so migration 0127 raises every row to the newest op
  on any block of its page, only upward. Rows still at 0123's unfilled 0 are
  left for the boot rebuild, which also fills their title key; the 0123
  migration test caught a first version that raised them. On a scratch copy of the vault copy it changed exactly
  the two rows.

Test: `pages_cache_0127_last_edited_rises_to_the_newest_op_on_the_page_5371`,
red on each of three mutations (no only-raise guard, page block's own ops
only, raising unfilled rows).

Ran: nextest over `pages_cache`, `reconcil`, `last_edited` and the migration
tests (189), `cargo clippy --workspace --all-targets -- -D warnings`,
`SQLX_OFFLINE=true cargo check --workspace --all-targets`,
`prek run --hook-stage manual --all-files`.
