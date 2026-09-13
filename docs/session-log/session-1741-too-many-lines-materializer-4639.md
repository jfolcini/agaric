# Session 1741 — the materializer splits (#4639)

Refs #4639, fifteenth slice: the eight `#[expect(clippy::too_many_lines)]`
sites in `agaric-engine/src/materializer/`. **Seven of the eight are gone;
`handlers/task_handlers.rs::handle_background_task_inner` keeps its
attribute** — see "The one left behind". The sweep total drops 54 → 47.

The brief predicted 54 → 46 on a base that had not yet taken #5009. On
42b8da7 the ends were 61 → 54; after rebasing onto #5009 they are 54 → 47.
Either way the delta is the seven removed, not eight.
The brief pointed at `docs/session-log/session-1740-*.md` as the shape
reference. It was not visible from this branch's original base; the rebase
onto #5009 brought it in, and that is what this
follows.

## What moved

Every split is a pure move of an arm body or a pipeline stage. No SQL text,
bind order, log line, tracing field, metric name, early return or await
point changed.

### `consumer.rs`

- `process_single_foreground_task` keeps the barrier fast path, the
  100 ms-constant foreground retry and the durable-success clear; the
  `else` branch is `record_foreground_failure`. It takes
  `last_error: Option<&str>` rather than the `RetryOutcome`, so
  `metrics.fg_errors` is still bumped BEFORE `err_msg` is computed — the
  original order.
- `run_background` splits into the drain loop plus
  `process_single_background_task` → `run_background_task_with_retry` →
  `record_background_failure`. The 2-retry / 150 ms-exponential background
  ladder (`MAX_RETRIES`, `INITIAL_BACKOFF_MS`) moved verbatim into
  `run_background_task_with_retry` and stays distinct from the foreground
  100 ms constant, which stays in `process_single_foreground_task`.
- The barrier arm and its `pending_barriers` deferral stay in
  `run_background`: the #2582 happens-before argument is about the shape of
  that loop, so it must remain readable inside it.

### `handlers/attachments.rs`

`cleanup_orphaned_attachments` becomes a pipeline:
`load_referenced_paths` → `walk_attachment_files` →
`prune_unreferenced_blob_rows` → `sweep_walked_attachments` →
`log_cleanup_summary`, with the per-file decision in
`process_walked_attachment` and its five destructive steps in
`prune_blob_row_for_path`, `write_pool_confirms_orphan`,
`quarantine_orphan`, `confirm_orphan_after_quarantine`,
`restore_quarantined_bytes` and `remove_quarantined_orphan`.

- Every name that writes says so: `prune_*` deletes rows,
  `quarantine_orphan` renames, `remove_quarantined_orphan` unlinks,
  `restore_quarantined_bytes` renames back. `write_pool_confirms_orphan`
  and `load_referenced_paths` only read.
- `CleanupCounters` is a struct, not seven positional `usize`. All seven
  fields are `u64`; positionally a swap would compile and mis-report the
  pass. `log_cleanup_summary` destructures it back into locals so the
  final `tracing::info!` — shorthand fields and `{scanned}`-style format
  captures alike — is byte-identical.
- The bulk `attachment_blobs` prune still runs BEFORE the
  `files.is_empty()` early return (#3325) and before any unlink (#3371).
  Extracting it did not move it: `prune_unreferenced_blob_rows` is called
  from exactly where the block sat.

### `handlers/task_handlers.rs`

`handle_foreground_task`'s `BatchApplyOps` arm splits into
`apply_records_in_one_tx` (open `BEGIN IMMEDIATE`, per-record `apply_op_tx`,
chunk flush, cursor advance, commit) and `dispatch_committed_cohorts` (the
post-commit fan-out and the one batched FTS pass). The #412 mixed-device
rejection stays INLINE in the arm — it is a `return Err` on a write path
(invariant 5) and belongs where a reader of the match sees it.

Neither helper carries a `batch` / `bulk` / `by_ids` name segment, so
`scripts/check-bulk-equivalence.mjs` records nothing new. That was a
judgement, not evasion, and it is stated here so a reviewer can overrule
it: `handle_batch_apply_ops` was the other candidate name. Neither helper
re-implements the single-op path's SQL — `apply_records_in_one_tx` calls the
same `apply_op_tx` kernel per record and `dispatch_committed_cohorts` calls
the same `dispatch_*` helpers `apply_op` calls — so this is the "dispatch
loop above an already-recorded kernel" case the guard's header says needs no
row, and adding one for a body HEAD already carried inside a non-inventoried
function would be inventory churn. The guard reports `no new entries, no
stale entries`.

### `dispatch.rs`

`invalidations_for_op` becomes a dispatch table: each of the eight
non-empty `OpType` arms is one `push_*_invalidations` call. The match stays
EXHAUSTIVE — the empty attachment arm and its comment about the
no-`#[non_exhaustive]` invariant are untouched, and a new `OpType` variant
still fails the build here.

`push_create_block_invalidations` and `push_edit_block_invalidations` return
`Result<(), AppError>` because their bodies contain a `?` and a
`return Err` respectively; the arms call them with `?`, so the error still
leaves `invalidations_for_op` exactly as it did. The other six return `()`.

### `retry_queue.rs`

- `sweep_once_counted` becomes a loop over `retire_expired_row`,
  `sweep_apply_op_row` and `sweep_background_row`. The five ApplyOp
  retirement dispositions each get a `retire_*_row` helper, one per
  disposition, so the match reads as the decision table it is.
- `SweepTally` is a struct for the same reason `CleanupCounters` is: two
  `usize` counters threaded through three helpers.
- `retire_expired_row` takes `is_apply_op: bool` in place of the
  `apply_op_kind.is_none()` test, so the #621 exemption is a named
  parameter rather than a `None` check on a value the helper does not need.
- The two lease ladders stay apart and unmodified. The foreground ApplyOp
  re-enqueue leases with `BackoffClass::Failure` (1 → 5 → 30 min → 1 h cap);
  the background re-enqueue leases with
  `BackoffClass::of(row.last_error.as_deref())`, which routes a
  `SHED_LAST_ERROR` row to `BackoffClass::Shed` (1 → 2 → 3 → 5 min cap).
  `backoff_delay_for`, which holds both ladders, is outside every split and
  is byte-unchanged.
- `try_reenqueue_apply_op` becomes four gates in their original order:
  `purge_supersedes_op` (#621), `ancestor_purge_supersedes_op` (#2212),
  `edit_supersedes_op` (#850), `slot_write_supersedes_op` (#3294). Each
  returns `bool`; the `ApplyOpSweepDisposition` literal stays at the call
  site, so what each gate decides is visible in the caller.
- The slot gate's three `query_scalar!` families become
  `property_slot_superseded`, `tag_slot_superseded` and
  `tree_position_slot_superseded`. They share `SweptOpCoords`
  (`created_at`, `seq`, `dev`) — a struct because `created_at` and `seq`
  are both `i64` and a positional swap would compile and silently change
  which ops count as later.
- The three raw-string SQL literals in those helpers keep their ORIGINAL
  interior indentation, over-indented relative to their new nesting. This
  is deliberate: a raw string preserves whitespace, `query_scalar!` keys
  the `.sqlx/` offline cache on the query text, and re-indenting them would
  have forced a `just gen-sqlx` across four caches for a formatting change.
  No `.sqlx/` file is touched by this slice.

## The one left behind

`handle_background_task_inner` (325 lines) keeps its `#[expect]`. It is a
23-arm match over `MaterializeTask` with **no `_` arm**, so a new variant
fails to compile there today — a live compile-time guard, the same one
`invalidations_for_op` documents in prose two files over.

The arithmetic:

- Clippy's own diagnostic reports 325. 321 of its 324 lines are arm bodies.
  The five biggest (SetBlockPageId 88, ReindexBlockTagRefs 56, BatchApplyOps
  23, UpdateFtsBlock 20, ApplyOp 12) extracted leave ~143 — still over.
- Eight arms are a 4-argument `dispatch_split_or_single` call that rustfmt
  spreads over 9 lines; that is 72 lines, and no shorter call-site form fits
  in 100 columns for the longer variant names.
- With EVERY arm body extracted the match measures **~51**, comfortably
  under the threshold. That figure comes from generating the fully-extracted
  match, running it through rustfmt at 100 columns and counting; twelve of
  the 23 arms then fit on one line. It is a simulation, not a compiled
  extraction, but the 19-line margin makes the direction unambiguous.

**Extraction would NOT cost the exhaustive match.** Moving arm bodies out
leaves the 23 patterns and the absent `_` arm exactly as they are. The
alternatives that do lose exhaustiveness — a `_ =>` delegation chain, or
three functions whose or-patterns enumerate each other — are not required to
get under the threshold and were never the choice on offer.

So the real trade is: ~17 single-use private helpers, versus one `#[expect]`
on one function. This sweep leaves it. Two of the arms (SetBlockPageId 88,
ReindexBlockTagRefs 56) are genuinely what #4639 exists for and are worth
extracting on their own merits, but extracting only those does not reach the
threshold — it is all seventeen or none, and seventeen helpers that each have
one caller is the gold-plating AGENTS.md § How we work rules out. Recorded so
a maintainer can overrule with the real numbers in front of them.

An earlier draft of this section claimed the fully-extracted match measured
71 and framed the decision as protecting the exhaustive match. Both were
wrong: 71 was `23 arms x 3 lines + 2` assumed rather than measured, and
exhaustiveness was never at risk. Corrected in review before this landed.

## Adaptations that are not byte-for-byte moves

Each is behaviour-identical; they exist because a moved body crossed a
signature.

- `continue` → `return` / `return Ok(true)` / `return Ok(false)` /
  `return None` wherever a loop body became a function
  (`process_walked_attachment` and its steps, `retire_expired_row`).
- `&task` → `task`, `&pool` → `pool`, `&metrics` → `metrics`,
  `&relative_str` → `relative_str`, `&quarantine` → `quarantine` where the
  value arrives already borrowed.
- `outcome.last_error_msg.as_deref()` and `last_error_msg.as_deref()` are
  computed at the call site so the helpers take `Option<&str>`; the
  `unwrap_or("unknown error")` and its literal stay inside.
- `attachments_root.clone()` → `attachments_root.to_path_buf()`
  (`walk_attachment_files` takes `&Path`), and `rp_ref.cloned()` →
  `read_pool.cloned()` (`run_background_task_with_retry`'s parameter name).
- `let mut pruned_blobs` → `let pruned_blobs`: it is no longer mutated in
  `cleanup_orphaned_attachments`; the `+=` moved into `CleanupCounters`.
- `Ok(SweepCounts { re_enqueued, advanced: due.len() - stalled })` →
  the same with `tally.` prefixes; field-init shorthand lost, values equal.
- `log_cleanup_summary` takes `&CleanupCounters` and destructures with
  `let &CleanupCounters { .. } = counters` — a by-value parameter tripped
  `clippy::needless_pass_by_value`, and the `&`-pattern avoids deriving
  `Copy` just for the lint.
- `op_type: OpType` → `op_type: &OpType` in `push_tag_op_invalidations` and
  `push_property_op_invalidations` (`OpType` is not `Copy`, so by value
  tripped the same lint); the call sites pass `&op_type`.
- `let key = key.as_str();` moved from inside the slot arms to
  `key.as_str()` at the call in `slot_write_supersedes_op`; same for
  `tag_id`.
- `edit_supersedes_op` ends `return Ok(superseded_by_edit != 0); } Ok(false)`
  where the arm ended `if superseded_by_edit != 0 { return Ok(…Edit); } }`.
  Same predicate, same guard, the disposition literal now at the caller.
- `apply_op_kind.is_none()` → `!is_apply_op` inside `retire_expired_row`.
- The slot gate became a let-chain,
  `if let Some(slot) = WriteSlot::of(&record) && slot_write_supersedes_op(…).await? { … }`,
  where HEAD nested an `if` inside the `if let`. `?` still propagates, `None`
  still skips, `false` still falls through.
- Comments moved with the code they describe. No comment text changed, and
  the one comment left dangling by a moved annotation was deleted.

## Verified

Measured, not assumed. Code lines below come from a counter that mirrors
clippy's rule (body span, skipping blank and comment-only lines); it was
calibrated against clippy's own eight diagnostics on this base and agrees
within ±1. The gate is clippy itself, which is silent at threshold 70.

Before (clippy's numbers, with the eight attributes stripped):

```
consumer.rs:511  process_single_foreground_task    85/70
consumer.rs:688  run_background                   108/70
dispatch.rs:1390 invalidations_for_op             193/70
attachments.rs:401 cleanup_orphaned_attachments   298/70
task_handlers.rs:12  handle_foreground_task       134/70
task_handlers.rs:594 handle_background_task_inner 325/70
retry_queue.rs:1041 sweep_once_counted            204/70
retry_queue.rs:1572 try_reenqueue_apply_op        192/70
```

After (own counter):

| function | before | after | helpers extracted |
|---|---|---|---|
| `process_single_foreground_task` | 84 | 35 | `record_foreground_failure` 51 |
| `run_background` | 107 | 42 | 19 / 28 / 12 |
| `cleanup_orphaned_attachments` | 297 | 53 | 60 / 14 / 17 / 20 / 16 / 43 / 22 / 26 / 22 / 24 / 13 / 25 |
| `handle_foreground_task` | 133 | 58 | 37 / 42 |
| `invalidations_for_op` | 194 | 29 | 25 / 41 / 12 / 15 / 12 / 21 / 32 / 15 |
| `sweep_once_counted` | 203 | 45 | 36 / 39 / 33 / 20 / 16 / 16 / 16 / 16 |
| `try_reenqueue_apply_op` | 191 | 33 | 19 / 50 / 22 / 18 / 27 / 27 / 25 |
| `handle_background_task_inner` | 324 | 324 | not split — see above |

- `cargo clippy -p agaric-engine --lib --tests -- -D warnings`: clean. No
  `#[allow]` or `#[expect]` added anywhere in the slice.
- `cargo fmt --all -- --check`: clean.
- `node scripts/check-bulk-equivalence.mjs`: `OK: 54 bulk-named function(s)
  inventoried (6 converged, 13 covered, 2 exception, 1 gap, 8 not-a-fan-out,
  9 read-only, 15 wrapper), no new entries, no stale entries`. Baseline
  untouched.
- `cargo nextest run -p agaric-engine`: `1026 tests run: 1026 passed,
  0 skipped`.
- `cargo nextest run -p agaric -E 'test(attachments_gc) or
  test(materializer)'`: `75 tests run: 75 passed (1 slow), 2525 skipped` —
  the attachment GC oracles live in the app crate, so `-p agaric-engine`
  cannot reach them.
- `grep -ro 'expect(clippy::too_many_lines' --include=*.rs src-tauri | wc -l`:
  47 (was 54; 61 → 54 before the rebase onto #5009).
- A Rust-aware lexer that decodes `\`-continuations and raw strings compared
  the string-literal multiset of each of the five files against HEAD. The
  ONLY difference is the seven deleted `expect` reasons. `git diff` touches
  no `.sqlx/` file and no script.
- Every one of `invalidations_for_op`'s eight arm bodies was compared
  token-by-token (comments and whitespace normalised away) against its
  helper: all eight identical, `MoveBlock` included.

### Falsified on copies, each restored byte-exact (`cmp`)

- Inverting `retire_expired_row`'s `!is_apply_op` reddens 4 retry-queue
  tests, `sweep_keeps_apply_op_rows_past_give_up_thresholds_621` among them.
- Swallowing `apply_records_in_one_tx`'s in-loop `return Err(e)` (returning
  `ApplyEffects::default()` instead) reddens `batch_partial_failure`,
  `batch_apply_ops_atomic_rollback_on_failure` and
  `fg_apply_dropped_bumps_once_per_failed_batch` — the moved error path
  still propagates.
- Emptying `invalidations_for_op`'s `RestoreBlock` arm reddens 4 dispatch
  tests.
- Gating `process_walked_attachment`'s undo-retention exemption off reddens
  `a_gc_pass_inside_the_retention_window_keeps_the_bytes_undo_needs_4250`
  in the app crate.
- Gating `record_foreground_failure`'s `record_failure_with_retry` off
  reddens `foreground_applyop_exhausted_persists_and_re_enqueues_on_boot`
  and `record_failure_persist_error_is_metered_pend24_m1`.

### One mutation that SURVIVED

Changing the foreground ApplyOp lease in `sweep_apply_op_row` from
`BackoffClass::Failure` to `BackoffClass::Shed` leaves all 1026
`agaric-engine` tests green. The constant moved verbatim (the literal check
and a direct read confirm it), but nothing pins which ladder that lease
uses. This is a pre-existing gap in HEAD, not one this slice opened, and
closing it means adding a test, which is outside a pure-move slice. Stated
rather than left implied.

Not run here: the full workspace suite, doc-tests, Playwright, coverage.
No public signature changed and every new item is private to its module,
but `-p agaric-engine` does not compile the dependent crates, so the
workspace run is the reviewer's.
