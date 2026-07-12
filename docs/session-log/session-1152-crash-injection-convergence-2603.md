## Session 1152 — Crash-injection convergence test for the engine↔SQL boundary (#2603) (2026-07-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-12 |
| **Subagents** | orchestrator-authored + 1 Explore (code map) + 1 adversarial review |
| **Items closed** | `#2603` |
| **Items modified** | — |
| **Tests added** | +1 backend |
| **Files touched** | 2 |

**Summary:** Added an invariant test pinning the engine-ahead-of-SQL divergence on
a REMOTE op. The materializer applies the per-space Loro engine mutation in-memory
BEFORE the SQL projection + apply-cursor advance commit in the same transaction; a
COMMIT failure between the two leaves the engine ahead of SQL because the in-memory
engine mutation is not part of the SQL tx and is not rolled back. Unlike a LOCAL op
(healed by op-log boot replay), a REMOTE op is absent from the local op_log, so the
only recovery net is the #2504 `reproject_blocks_from_engine`. The test reproduces
the divergence via a rolled-back apply tx, proves the op-log path cannot heal it, and
asserts SQL converges back to the engine after reprojection.

**Files touched (this session):**
- `src-tauri/src/materializer/handlers/crash_injection_convergence_tests.rs` (new, +~300 LOC)
- `src-tauri/src/materializer/handlers/mod.rs` (+2 LOC — register the test module)

**Verification:**
- `cd src-tauri && cargo nextest run -E 'test(remote_op_commit_failure_leaves_engine_ahead_then_reproject_converges_2603)'` — 1 passed.
- Mutation check: replacing the `drop(tx)` crash with `tx.commit()` fails the divergence
  assertion (`SQL count == 0`), proving the test is non-vacuous.
- Adversarial reviewer re-verified the architectural claims against source and re-ran the
  materializer + recovery suites (see Process notes).

**Process notes:**
- The Explore-agent code map asserted "a crash before commit rolls back BOTH engine AND
  cursor atomically" — this was **wrong** and would have inverted the whole test premise.
  Verified against `loro_apply.rs:23-28` ("The engine's apply is NOT rolled back
  automatically") and `apply.rs:71-74` ("a tx rollback leaves the engine ahead of SQL")
  before writing. Load-bearing claims from subagents must be checked against source.
- Test-only change: no `docs/FEATURE-MAP.md` update needed (no new command/component/hook/
  store/table).
