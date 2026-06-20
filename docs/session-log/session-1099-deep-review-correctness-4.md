# Session 1099 — /batch-issues loop: 6 correctness fixes, batch 41 (2026-06-20)

## What happened

Six correctness findings from the deep review (the reverse/undo cluster handled as one
cohesive pass + three singles), built by parallel subagents in `wt-batch41` and reviewed
together. Part of the maintainer-requested sweep of all open `correctness`-labelled issues.

## Shipped

PR `fix/deep-review-correctness-4`:

- **#1517** (HIGH, `commands/history.rs`) — `find_undo_group_inner` already keys on
  `is_undo = 0` (the dead `op_type NOT LIKE 'undo_%'` filter was gone); added the
  regression test the issue requested (mutation-verified: removing the `is_undo` filter
  inflates the group and fails the test).
- **#1526** (MEDIUM, `reverse/block_ops.rs`) — `reverse_edit_block` now reconstructs the
  inverse by following the causal `EditBlockPayload::prev_edit` pointer (via `get_op_by_seq`,
  `seq DESC`) instead of timestamp order, falling back to the timestamp scan only when
  `prev_edit` is `None` or dangles (post-compaction). Move reverse stays timestamp-ordered
  — `MoveBlockPayload` carries no causal pointer (documented; structurally inapplicable).
- **#1543** (LOW, `reverse/block_ops.rs`) — documented + test-pinned that
  `reverse_create_block`'s soft-delete-leaves-a-recoverable-tombstone is BY DESIGN (redo
  re-applies onto the existing node). No behaviour change; the test drives the production
  engine path and asserts present-but-soft-deleted (not purged).
- **#1546** (LOW, `tag_inheritance/`) — made the full rebuild's `inherited_from`
  attribution explicitly nearest-ancestor (MIN-depth, MIN(inherited_from) tiebreak) via a
  new `tag_inh_rebuild_nearest!` CTE, matching the incremental path. This removes reliance
  on SQLite's undocumented depth-FIFO recursion order (which already converged in practice)
  — a determinism hardening that guarantees rebuild/incremental parity rather than relying
  on evaluation order.
- **#1556** (LOW, `fts/search/post_filter.rs`) — the toggle post-filter reported
  `has_more=false` when the scan-window cap was hit before a full filtered page. Added an
  `fts_exhausted` flag (set only at genuine break points); `has_more=true` + a resume
  cursor when the cap truncated a live source, `false` only on true exhaustion.
- **#1549** (LOW, `db/pool.rs` + delete sites) — restore could over-restore an
  independently-deleted nested subtree under a same-millisecond `deleted_at` collision
  (non-monotonic `now_ms()`). Per the maintainer's choice, added `next_delete_ms()` (a
  process-global `AtomicI64` CAS, `max(now_ms(), last+1)`) used at all four fresh-delete
  stamp sites, so distinct deletes get distinct timestamps and the existing restore-cohort
  filter correctly leaves the independent subtree deleted. `now_ms()` unchanged elsewhere.

## Review pass

Reviewer (APPROVE): found+fixed one clippy `too_many_arguments` on the #1517 test helper
(`#[allow]` + justification). Mutation-verified #1517 (is_undo exclusion), #1556 (window-cap
has_more). Confirmed #1526 follows `prev_edit` (skew test load-bearing) and move's doc-only
resolution is justified (no causal pointer). #1543 is doc+test-only through the production
path. #1549's `next_delete_ms()` is sound and covers all four enumerated sites; unit tests
(10k burst + 8-thread uniqueness) carry the monotonicity proof. Noted #1546 is a
determinism hardening (SQLite FIFO already converged), framed accordingly. clippy
`--all-targets` clean; 823 tests pass; `.sqlx`/baseline unchanged; groups disjoint.

## Notes

- Pre-existing/out-of-scope observation (not changed here): a fresh soft-delete stamp in
  `apply_reverse_in_tx` (reverse-of-create / redo path) still uses `now_ms()` — it recovers
  via redo-onto-tombstone, not the `deleted_at`-keyed cohort restore, so it's outside #1549's
  scope.
- Rebased onto current `origin/main` before push.
