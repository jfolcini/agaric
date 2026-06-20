# Session 1094 — /batch-issues loop: 4 correctness fixes, batch 39 (2026-06-20)

## What happened

Four independent correctness findings from the deep review, built by parallel subagents
in shared worktree `wt-batch39` and reviewed together. Part of the maintainer-requested
sweep of all open `correctness`-labelled issues.

## Shipped

PR `fix/deep-review-low-correctness-2`:

- **#1557** (`tag_query/query.rs`) — `list_tags_by_prefix` prepended the off-page exact
  match with `rows.insert(0, exact)`, breaking the `ORDER BY name` contract. Now inserts
  at the BINARY-sorted slot via `partition_point(|r| r.name < exact.name)` (collation
  matches `tags_cache.name`'s BINARY); dedup + cap-eviction preserved.
- **#1550** (`recurrence/projection.rs`) — the recurrence projection's repeat-count
  budget (`projected_count`) only incremented on in-range emits, so a recurrence whose
  base precedes `range_start` advanced through pre-range steps "for free" and emitted more
  than `repeat_count` in-range occurrences. Moved the increment out of the in-range
  branch so every series occurrence consumes budget; emitted (in-range) tuples unchanged.
- **#1553** (`commands/history.rs`) — `apply_reverse_in_tx`'s MoveBlock arm was already
  functionally correct (raw provisional write + immediate re-densify) but the two were
  separable. Extracted `reverse_move_block` binding the raw `UPDATE` + the dense
  reprojection of BOTH sibling groups + page/space re-derivation into one inseparable
  unit. Byte-identical behavior; a both-groups-settled test guards against a future
  reprojection drop.
- **#1547** (`recurrence/compute.rs`) — a recurrence sibling could commit with no
  due/scheduled date when the shifted-date validity guard failed (warn-and-skip). New
  `push_shifted_date_property` helper returns `AppError::Validation` so the IMMEDIATE tx
  rolls back (the M-77 contract) instead of committing a dateless sibling.

## Review pass

Reviewer (APPROVE, no defects): all four correct. Mutation-checked #1557 (revert to
`insert(0)` fails the sorted-slot test) and #1550 (revert to in-range-only count fails the
pre-range test). Confirmed the two recurrence fixes coexist (different files/functions,
zero clobber), the #1557 collation matches, the #1553 extraction is byte-identical (same
SQL/param/reproject order), and #1547 rolls back rather than committing. clippy
`--all-targets` clean; 495 targeted tests pass; `.sqlx`/baseline unchanged.

## Notes

- Two fixes touch the recurrence module but DIFFERENT files (`projection.rs` vs
  `compute.rs`) — verified no shared-worktree clobber (#1547's tests correctly live in
  `compute.rs`'s own module since `push_shifted_date_property` is private).
- Branch base is current `origin/main`.
