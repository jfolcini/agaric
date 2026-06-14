# Session 1027 — sql_only fallback instrumentation (#1057 part 2)

Continuation of the 2026-06-14/15 autonomous `/loop /batch-issues` overnight pass
(earlier batches: #1188/#587 in session 1025; #828 + code-scanning triage in session 1026).
By this point the clean ready backlog in the search/tooling/docs lane was drained and the
concurrent loop agent had gone idle, so this batch took a **safe additive slice** of a
larger arch issue rather than forcing a risky refactor.

## Shipped

- **#1057 part 2 (rust-arch) — instrument the 18 sql_only fallback branches.**
  `materializer/handlers/loro_apply.rs` early-returns into the `sql_only` fallback from 18
  sites whenever the Loro engine isn't initialised (`shared::get()` None) or a block's space
  can't be resolved (`resolve_block_space` miss). In production both arms are unreachable,
  so a fallback there is a *silent* latent bug — the exact shape of the recurrent drift the
  issue documents. Added a new `materializer::handlers::sql_only_fallback` module (a global
  `AtomicU64` counter, `record(op, reason)` emitting a `tracing::debug!`, `count()`, and a
  `SqlOnlyFallbackReason { EngineUninit, SpaceUnresolved }` enum), and wired a `record(...)`
  call before each of the 18 returns — 9 `SpaceUnresolved` + 9 `EngineUninit`. **Purely
  additive**: every `return apply_*_sql_only(...)` is byte-identical; no control flow changed.
  Full Rust suite 4522 passed, 0 warnings. PR #1212.

  Scope discipline: this is **part 2 of 3**. The convergence refactor (route the remaining
  fallbacks through the shared `project_*_to_sql` helpers, part 1) and the L/XL test-migration
  to the engine path (part 3) remain open — PR refs #1057, does not close it.

## Notes / lessons

- **`debug!` not `warn!` for the instrumentation.** The sql_only fallback is the DEFAULT
  path for the many materializer/recovery/sync tests that don't call `install_for_test`, so
  a `warn!` would spam the whole suite. Production observability comes from the counter
  (nonzero = an unexpected real fallback); the per-call log stays at debug level.
- **A bare `debug_assert!` would have been wrong** for the same reason — the fallback is
  test-reachable by design, so asserting it never fires would break dozens of tests. A
  monotonic global counter, asserted with `>` (not `== before+1`), is parallelism-safe under
  nextest where a process-global counter is shared across concurrently-running tests.
- Backlog reality at this hour: the remaining open issues are large/gated/risky (#1019 gated
  on an e2e suite that is itself an actively-worked maintainer lane, #645 XL crate-carve),
  mobile (hard to runtime-verify), or design-notes needing maintainer input (daytime CET).
  The #1057 instrumentation slice was the cleanest completable-with-rigor item left.
