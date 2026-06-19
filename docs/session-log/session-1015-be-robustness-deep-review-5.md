# Session 1015 — /batch-issues loop: backend robustness, batch 16 (2026-06-19)

## What happened

Sixteenth batch of the `/loop /batch-issues` run: backend robustness /
maintainability findings from the multi-agent deep review, on disjoint file
clusters, built by parallel subagents (≤2 concurrent Rust) and adversarially
reviewed. Ran overlapped with frontend batch 15 in worktree `wt-fe15`.

## Shipped

Single PR `fix/be-robustness-deep-review-5`:

- **#1571** (MEDIUM, robustness) — `engine_apply` returns no `Result` and only
  `warn`s on a dispatch / `for_space` failure; the post-commit delete/restore
  cohort fan-out calls it per descendant and absorbs every failure. After the SQL
  tx commits, a failed engine apply leaves the op-log/SQL source of truth and the
  per-space `LoroDoc` diverged for that block with no durable counter a health
  check can observe. Added a dedicated, machine-detectable divergence signal,
  mirroring the existing `sql_only_fallback` / `snapshot_fallback_metrics`
  precedent: a new `merge/divergence.rs` with a process-global `AtomicU64`
  (`ENGINE_DIVERGENCE_COUNT`), `record(op_id, op_type, detail)` that increments it
  and emits a stable structured `tracing::warn!(target: "merge::engine_divergence",
  …, "engine_apply_diverged")`, and a `count()` getter for health checks/tests.
  `engine_apply` calls `record(...)` in BOTH swallowed-failure arms. Behavior is
  otherwise identical (still warn + skip, non-fatal, commit ordering untouched) —
  observability only. The cohort helpers in `materializer/handlers/apply.rs` route
  every swallowed failure through `engine_apply`, so the single instrumentation
  point covers them without duplication.
- **#1606** (LOW, robustness) — the MCP `append_block` schema declares `position`
  `minimum: 1`, but serde does not honour JSON-Schema constraints, so `position` 0
  or negative was silently clamped to the first child via
  `position.max(1).saturating_sub(1)` — inconsistent with the loud-rejection
  posture of `validate_limit`. `handle_append_block` now rejects `position < 1`
  with `AppError::Validation` (JSON-RPC -32602) before the 1-based→0-based
  conversion, keeping the `saturating_sub` underflow backstop as defense-in-depth.
- **#1665** (LOW, maintainability) — both the MCP boundary (`validate_limit`) and
  the backing `*_inner` functions independently reject out-of-range limits with
  different messages; via MCP, `validate_limit` short-circuits so the `*_inner`
  message is never observed on the wire (the inner check is intentional
  defense-in-depth for non-MCP callers). Added a doc-comment at `validate_limit`
  explaining it shadows the inner checks on the MCP path, plus one-line
  back-reference comments on `list_pages_inner` / `get_page_inner`, so a maintainer
  doesn't "fix" the unreachable inner message or delete the backstop. No behavior
  change.

## Review pass

Three adversarial reviewers (different subagent than each builder), all running the
real `cargo clippy --all-targets -- -D warnings` gate plus targeted nextest:

- **#1571 reviewer** verified precedent fidelity against the two existing
  fallback-metrics modules, that both swallow arms are instrumented and no other
  swallowed `engine_apply` path was missed, and mutation-tested the counter test.
- **#1606+#1665 reviewer** confirmed the issue's three cited locations all point to
  the single `append_block` tool (no second insert site silently clamping),
  traced the `AppError::Validation → ErrorData::invalid_params (-32602)` mapping in
  `rmcp_adapter.rs` end-to-end (with its own adapter test as evidence), mutation-
  tested the two rejection tests (both fail without the guard), and confirmed #1665
  is genuinely comment-only. Clippy exit 0, zero warnings.

## Notes

- Files: new `merge/divergence.rs`; `merge/mod.rs`, `merge/apply.rs` (test),
  `mcp/tools_rw.rs`, `mcp/tools_ro.rs`, `commands/pages/listing.rs`
  (+ `mcp/tools_rw/tests.rs`). No new SQL macros → no `.sqlx` regen needed.
- Also closed **#1651** (MEDIUM, maintainability — `ENGINE_FORMAT_VERSION` dead
  gate) with code evidence: it was fully resolved by the prior batch's #1584, which
  now stamps the const on export and asserts it on import.
- Pushed serially with frontend batch 15 to avoid concurrent heavy pre-push (OOM).
