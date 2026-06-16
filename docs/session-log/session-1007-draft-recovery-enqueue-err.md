# Session 1007 — draft recovery surfaces engine-enqueue failures (#1322)

`/loop /batch-issues` run (2026-06-16), one of a 3-issue parallel batch (#1322 this, #1348 FE
gutter, #1351 docs).

## Shipped

- **#1322 — draft recovery reported phantom success when the Loro-engine enqueue failed.**
  `recover_single_draft` recovers an unflushed draft by atomically appending a synthetic
  `edit_block` op to `op_log` + patching `blocks.content` (committed), then enqueues the
  synthetic record as a foreground `ApplyOp` so the engine applies it and the apply cursor
  advances. If `enqueue_foreground` failed it only `warn!`ed and still returned `Ok(true)` —
  the caller (`boot.rs`) pushed the block to `drafts_recovered` and the recovery report showed
  clean success, while the engine was left silently stale (the op sits with `seq > cursor`,
  never applied).

  Fix (Option 1 — surface it): on enqueue failure, escalate to `error!` (with `block_id` + the
  underlying error) and return `Err(AppError::Channel(...))` instead of `Ok(true)`. The variant
  matches what `enqueue_foreground` itself returns and the function's `Result<bool, AppError>`
  signature. The committed `op_log` row + `blocks.content` update are deliberately preserved
  (not rolled back), so the next boot's replay walk can still apply the op — only the report
  becomes honest. The caller is unchanged: it already routes `Err` into `draft_errors` via
  `log_draft_error`, and only `Ok(true)` pushes to `drafts_recovered`, so the invariant holds —
  a draft reported recovered has its synthetic op enqueued, or the failure is reported.

  Distinct from #620 (which introduced the enqueue + warn-on-failure and fixed "op never
  dispatched") and #1257 (the general freshness-coupling design gap); this is the narrow bug of
  one recovery path swallowing an enqueue error and mislabeling it as a recovered draft.

## Tests

`recover_single_draft_returns_err_when_enqueue_fails_1322`: forces a real enqueue failure via
the materializer's public `shutdown()` (no internals touched), asserts
`Err(AppError::Channel(_))`, and asserts the synthetic op remains in `op_log` (data preserved).
Targeted 94/94; full suite **4195/4195**; `clippy` clean; no `.sqlx` drift.

(The first build agent died mid-verification — ended "waiting for the monitor" — so this shipped
via a continuation-as-review agent that verified the inherited diff in the foreground.)
