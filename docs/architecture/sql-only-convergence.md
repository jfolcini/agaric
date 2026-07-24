<!-- markdownlint-disable MD013 MD060 -->
# The `sql_only` apply fallback

**Issues:** #1057 (instrumentation), #1323 (convergence), #2250 / #2325 (apply-path collapse) · **Status:** CONVERGED.

Every op apply routes through `apply_op_projected`
(`src-tauri/agaric-engine/src/apply/kernel.rs`), which applies the op to the
per-space Loro engine and projects the result to SQL in one transaction. The
engine-routed handlers (`apply_*_via_loro`,
`src-tauri/agaric-engine/src/apply/loro_apply.rs`) early-return into a
SQL-only fallback (`apply_*_sql_only`,
`src-tauri/agaric-engine/src/apply/sql_only.rs`) when there is no engine state
to route the op through. This document explains why that second arm exists,
what keeps it from drifting from the engine arm, and where it is *allowed* to
differ.

## Why it exists

Two — and only two — triggers remain, both intrinsic to the per-space CRDT
model rather than accidents of test scaffolding. They are enumerated as
`SqlOnlyFallbackReason`
(`src-tauri/agaric-engine/src/apply/sql_only_fallback.rs`):

- **`SpaceUnresolved`** — `agaric_store::space::resolve_block_space` misses, so
  the op has no per-space engine to route to: an orphan block, a block with no
  `space` ancestor, a pre-spaces row, or a fresh page-create whose
  `SetProperty(space)` has not applied yet.
- **`EngineMissingTarget`** — the space resolved, but the block (or a
  `move_block`'s target parent) is absent from *that* space's engine tree, so a
  single-space engine mutation cannot represent the op. Reached by the #1257
  reconciliation window (an earlier op for the block was itself projected
  SQL-only) and by cross-space moves.

Both are **soft fallbacks, not errors**: the handler records the reason and
takes the SQL projection instead of propagating an `Err`. They are load-bearing
— the #2326 create-then-`SetProperty(space)` ordering depends on
`EngineMissingTarget` staying soft — so neither may be promoted to a hard error
or a `debug_assert!`.

A third arm, `EngineUninit` ("the process-global engine registry was never
initialised"), was **deleted** by #2249 / #2250. Engine state is now a required
`&LoroState` parameter threaded into every `apply_*_via_loro` handler, which
makes "registry not initialised" unrepresentable — and with it the whole class
of tests that silently exercised the fallback instead of the production engine
path (the #891 false-drift source).

> **Note on #891.** The original issue framing linked #891 to this file. That
> was a misattribution: #891 was a conformance test silently running the
> fallback, fixed by the `engine_path_tests` convention below, not by touching
> the fallback itself. The lesson it teaches — *an apply test with no engine
> installed silently exercises the fallback, not production* — is the
> cornerstone of the test strategy.

## What converged (#1323)

Deleting the fallback was never the goal; making the two arms **identical by
construction** was. Every `apply_*_sql_only` now synthesises the
`BlockSnapshot` the engine arm would have read back and calls the **same**
shared projection helper (`src-tauri/agaric-engine/src/loro/projection.rs`)
that the engine arm calls after its apply:

| Op | Shared projection both arms call |
| --- | --- |
| `create_block` | `project_create_block_to_sql` (+ `inherit_parent_tags` after, on both arms) |
| `edit_block` | `project_edit_block_to_sql` |
| `delete_block` | `project_delete_block_to_sql` (cohort/cascade CTE) |
| `restore_block` | `project_restore_block_to_sql` (cohort-contiguous since #1055) |
| `move_block` | `project_move_block_to_sql` |
| `add_tag` / `remove_tag` | `project_add_tag_to_sql` / `project_remove_tag_to_sql` (+ the same inheritance fan-out after) |
| `set_property` / `delete_property` | `project_set_property_to_sql` / `project_delete_property_to_sql` |

So the write *shape* — column list, `page_id` stamping, `OR IGNORE`, the
descendant CTE, the `deleted_at` value — cannot drift between the arms; there
is one spelling of each write.

The `move_block` cycle probe converged too. The defensive #383 check (a
malformed or replayed op installing a `parent_id` cycle would saturate every
recursive CTE walk at the depth-100 bound) now calls the shared
`agaric_store::block_descendants::move_would_cycle`, the same probe the
`move_block_inner` command path uses. Only the *reaction* differs by design:
the command path errors, the sync-replay fallback warns and no-ops, because
aborting would wedge inbound sync.

`purge_block` never had a second implementation to converge:
`purge_block_sql_cascade` is the canonical cascade and runs on both arms (the
engine models only a few of the tables the cascade touches).

## What deliberately still differs

**`position` value, not shape.** The engine arm runs
`reproject_dense_positions` after its projection, re-ranking the affected
sibling group(s) into a dense 1-based order over the engine's fractional-index
tree. The engine-less fallback has no tree, so it writes only a *provisional*
rank (`index_to_provisional_position`, i.e. `index + 1`, capped). For an
index-only insert or a cross-parent move into a populated sibling set the two
legitimately differ until boot replay reconciles. This is pinned rather than
masked by `create_edit_convergence_tests.rs` and `move_convergence_tests.rs`.

## Instrumentation

`sql_only_fallback::record(op, reason)` bumps a process-global monotonic
`AtomicU64` and emits a `debug!` (`target:
"materializer::sql_only_fallback"`) tagged with the op type and reason. It is
purely additive and does not alter control flow. `debug!` rather than `warn!`
is deliberate: sync_daemon tests thread synthetic ops over bare-block fixtures
with no space chain, so a warn would spam the suite.

Production observability is the counter, surfaced as
`StatusInfo::sql_only_fallback_count` (#1326) via the materializer coordinator's
status builder. A nonzero count in a normal session means an op took the
fallback and is worth explaining.

## Test strategy

- **The fallback is the default for engine-less tests.** Any apply test that
  does not install engine state runs the fallback. That is fine — those tests
  pin the fallback's behaviour — but it means a test that *intends* to exercise
  the engine must say so.
- **Conformance drives the real foreground pipeline.** To prove the arms agree,
  the same op is driven through both and the resulting `blocks` /
  `block_properties` / `block_tags` rows compared. The engine side must go
  through `install_for_test()` + `append_local_op` + `dispatch_op` + `settle`
  and assert the **settled** reprojected state, never the transient provisional
  command-path position (the #891 lesson). `engine_path_tests.rs` establishes
  the convention; the `*_convergence_tests.rs` files apply it per op family.
- **Counter assertions.** `sql_only_fallback::count()` asserts that
  engine-path cases took **zero** fallbacks and engine-less cases took the
  expected number — which is what catches an accidental fallback in a test
  meant to exercise the engine.
