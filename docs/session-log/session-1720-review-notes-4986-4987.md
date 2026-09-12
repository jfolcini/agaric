# Session 1720 — review notes from #4986 and #4987

The non-blocking notes the reviewer left on #4986 (review notes from
#4983/#4984) and #4987 (the second `crud.rs` split), batched into one PR
after both merged, per AGENTS.md § How we work.

- **The restore fan-out spelled its per-root triple twice.** #4987 left
  `dispatch_restore_fanout` (single path) and `dispatch_restore_batch_fanout`
  (batch path) each calling `dispatch_restore_descendants`,
  `dispatch_restore_ancestors` and `reindex_restored_cohort_links`. The
  triple is one `dispatch_restore_root_fanout`, carrying the #3856 / #3834 /
  #4285 rationale once; the single path is that helper plus its FTS
  re-index, the batch path is the loop plus the union FTS pass. The
  bulk-vs-fold inventory entry for the batch helper now says so in one
  sentence instead of arguing the duplication away.
- **`SyncDaemon`'s `pub` rationale was stale.** Two comments said the
  fields are `pub` so app-hosted tests can construct the struct across the
  crate boundary; the only literal is the in-crate `#[cfg(test)]` module.
  `pub` on `handle` still earns its keep by keeping `dead_code` quiet on
  non-test builds, and the comment now says only that.

## Verified

`cargo clippy -p agaric --lib --tests -- -D warnings` clean;
`SQLX_OFFLINE=true cargo check --workspace --all-targets` 0 warnings;
`cargo nextest run --workspace -E 'test(restore) | test(bulk) |
test(shutdown) | test(sync_daemon)'` 478 passed; the bulk-vs-fold
inventory guard green. Falsified on a copy: the ancestor fan-out dropped
from `dispatch_restore_root_fanout` reddened both
`restore_block_inner_fans_the_restored_subtree_to_the_engine` and
`restore_blocks_by_ids_inner_fans_the_restored_subtree_to_the_engine`,
which is the point of one helper: one mutation, both paths red. Restored,
`cmp` clean. The pre-push verifier was skipped; CI runs the full suite on
the PR.
