# Session 1062 — #1257 route-through completion + draft-anchor + filter-compiler foundations

2026-06-16/17. Overnight `/loop /batch-issues` run. Completed the position/engine data-integrity
cluster (the #1257 route-through) and landed two filter-compiler foundations (#1320 PR-0, #1280
Phase 0), plus the #1256 draft-recovery fix and the #1392 move cleanup.

## Merged

| PR | Issue | Description |
|----|-------|-------------|
| #1390 | #1257 PR-4 | Route `move_block` through `apply_move_block_via_loro` (engine apply + dense reproject of both sibling groups) in-tx; cursor pinned |
| #1391 | #1257 PR-5 | Apply delete/restore/purge cohort cascade to the engine in-tx (pre-capture cohort+space below the SQL soft-delete; no #1257 phantom) |
| #1393 | #1256 | Gate draft recovery on a monotonic per-device `draft_anchor_seq` (migration 0092) instead of a timestamp race |
| #1394 | #1320 PR-0 | Route the search `Space` filter through `SearchProjection` — first production call site of the cross-surface filter compiler (zero-behaviour-change cutover) |
| #1395 | #1392 | Drop the redundant post-route-through `recompute_subtree_inheritance` in `move_block_inner` (both arms already recompute) |

## Open

| PR | Issue | Description |
|----|-------|-------------|
| #1397 | #1280 Phase 0 | `FilterExpr` boolean tree (And/Or/Not over `FilterPrimitive`) + `Projection::compile_expr` — foundation for the composable advanced-query mode |

## Notes

- **#1257 route-through is complete** (PR-1 freshness gate through PR-5 cascade). The local command
  path engine-applies in the `CommandTx` via the `apply_*_via_loro` helpers and never advances the
  apply cursor (boot replay re-applies idempotently — the safety net). `#1245`/`#1248`/`#1249`
  resolved by it. The planned "PR-6" (provisional-position cleanup) was assessed **not needed**:
  `provisional_position` is load-bearing for the op-log `MoveBlock` breadcrumb, the `MoveResponse`,
  and the engine-absent `apply_move_block_sql_only` fallback rank.
- **#1392** is pinned by a two-arm conformance test (`local_move_inheritance_engine_arm_1392` /
  `local_move_inheritance_sql_fallback_arm_1392`) — the fallback test forks its own process so the
  process-global engine is genuinely uninitialised.
- **#1256** review caught nothing to fix but the push surfaced a stale `draft_bench.rs` (9 call
  sites on the old `save_draft` arity — `--tests` skips benches) and a regenerate-bindings step;
  both fixed before merge.
- **#1320 PR-0** routes only `Space` (byte-identical to the legacy `add_space`); `Tag`
  (`COUNT(DISTINCT)` ALL-semantics) and property (`prop:` four-column OR) diverge and stay legacy,
  pinned by parity tests so a follow-up must reconcile them deliberately.
- **#1280 Phase 0** lifts the backlink resolver's 3-valued `NOT COALESCE((…),0)` complement into a
  cross-surface `compile_expr`. Adversarial review SHIP; filed **#1396** to add a recursion-depth
  guard when `FilterExpr` is first wired to an IPC command (safe today — nothing constructs it from
  untrusted input yet).

## Process

- Merge train via worktrees; rebased each branch onto `origin/main` after every parent merge,
  resolving the additive `materializer/mod.rs` + interleaved `conformance.rs` conflicts (take main's
  side, append the PR's new test fn).
- Serialized the hook-heavy pushes in the foreground (OOM guard); verified each landed
  (remote SHA == local) since `rtk` can mask a pre-push abort.
