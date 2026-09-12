# Session 1727 — review notes from #4988, #4989, #4990 and #4991

The non-blocking notes the reviewer left on four merged #4639 slices,
batched into one follow-up as § How we work asks, plus one from #4995.
Four applied, one declined.

- #4988 `toggle_filter.rs`: the regex arm of `search_with_toggles`
  returns `regex_mode_query(…).await` directly instead of binding and
  re-wrapping it. The `conformance-coverage` guard that parses this
  function for its arm dispatch (#4993) still finds every needle.
- #4989 `crud.rs`: `restore_all_deleted_inner`'s post-commit loop now
  runs `dispatch_restore_root_fanout` with an empty ancestor chain, the
  same helper the single and batch restores use; the ancestor step is a
  no-op on an empty slice, so the fan-out is unchanged and the duplicated
  per-call prose is gone.
- #4990 `bibliography.rs`: declined. The `None => None` arm the note
  called unreachable matches an `Option<ValuePart>`; it cannot be taken at
  runtime, but removing it does not compile.
- #4991 `block_ops.rs`: the orphan paragraph about the moved cross-space
  check is deleted, its one ordering reason moved to the
  `validate_parent_in_tx` call it orders, and the stale "so both stay
  below" sentence now names the two helpers on either side of the engine
  apply.

## Verified

`cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo fmt
--all -- --check` clean; `cargo nextest run --workspace` 6318 passed, 13
skipped; doc-tests green; `conformance-coverage.test.ts` 25 passed, so the
#4993 arm-dispatch guard still finds its needles; `node
scripts/check-bulk-equivalence.mjs` 51 inventoried, no new entries. The
reviewer confirmed the ancestor step's empty-slice early return is the
first statement of `fan_out_restore` and that the fold keeps the old
order (descendants, then links) with nothing dropped. Falsified on
copies: the fold given an empty cohort reddened
`restore_all_deleted_inner_fans_the_restored_subtree_to_the_engine`; the
reviewer independently dropped the link reindex inside
`dispatch_restore_root_fanout` and reddened
`the_restore_all_command_relinks_a_restored_descendants_referrer_4285`,
then reddened both with the empty cohort. All restored, `cmp` clean. One
more note rides along from #4995: the mock's three attachment
constructors stamp `created_at` with `Date.now()`, the number the binding
declares, instead of an ISO string.
