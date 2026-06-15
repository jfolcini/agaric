<!-- markdownlint-disable MD013 MD060 -->
# Converging the `sql_only` apply fallback with the projection helpers

**Issue:** #1057 · **Status:** instrumentation landed (#1212); apply-path convergence is a reviewed follow-up.

## Why this exists

`src-tauri/src/materializer/handlers/sql_only.rs` is a *second, parallel*
implementation of block / property / tag apply semantics. It writes directly to
SQL, bypassing the per-space Loro engine and the projection layer. The
engine-routed handlers in `loro_apply.rs` (`apply_*_via_loro`) early-return into
it whenever the engine path cannot proceed:

- `crate::loro::shared::get()` is `None` — the Loro engine is uninitialised.
  Test scaffolding that does not call `crate::loro::shared::install_for_test`
  runs engine-less, so this is the **default** path for the bulk of the
  materializer / recovery / sync_daemon test suites (apply_op.rs 10 tests / 0
  installs, dispatch.rs 17 / 0, lifecycle.rs 9 / 0, recovery/tests.rs 40 / 1,
  sync_daemon/tests.rs 69 / 2).
- `crate::space::resolve_block_space(...)` misses — the block's space cannot be
  resolved (orphan block, no `space` ancestor, pre-FEAT-3 row, fresh
  page-create with no `SetProperty(space)` yet).

**In production both arms are unreachable** — `init` runs at boot and space
resolution succeeds on every well-formed op.

### The hazard is drift, not dead code

The fallback has repeatedly diverged from the real projection and had to be
patched back into parity, each divergence a latent correctness bug the second
path silently masked:

| Divergence | Fix | Symptom if undetected |
| --- | --- | --- |
| index/position mapping (`sql_only.rs:14-19`) | #400 | wrong sibling order on engine-less replay |
| cycle check missing (`:104-140`) | #383 | `parent_id` cycle → recursive CTEs saturate at depth-100 |
| reserved-key + `space`-column routing (`:202-219`) | #533 / #802 | `SetProperty(space)` replay aborts on `key_not_reserved` CHECK (0088) |
| delete-property `space` arm (`:221-235`) | #802 | `DeleteProperty(space)` no-ops; `blocks.space_id` silently stays set |

> **Note on #891.** The original issue framing linked #891 to this file. That
> link is a *misattribution*: #891 was a conformance test silently running the
> fallback, fixed by the `engine_path_tests` convention (`install_for_test()` +
> `append_local_op`), **not** by touching `sql_only.rs`. The lesson it teaches —
> *apply tests without `install_for_test()` silently exercise the fallback, not
> production* — is the cornerstone of the test strategy below.

Deleting `sql_only.rs` is **infeasible / mis-scoped**: it is the default path
for ~135 tests that never install the engine. The convergence target is not
deletion but *making the two arms identical by construction* so they cannot
drift.

## Part 1 — instrumentation (landed, #1212)

`materializer/handlers/sql_only_fallback.rs` provides `record(op, reason)`:
a process-global monotonic `AtomicU64` counter plus a `debug!` log
(`target: "materializer::sql_only_fallback"`) tagged with the op type and the
reason (`EngineUninit` vs `SpaceUnresolved`). It is purely additive — it does
not alter control flow.

`debug!` (not `warn!`) is deliberate: the SQL-only path is the default for the
engine-less test suites, so `warn!` would spam every run. Production
observability comes from the counter (a nonzero `count()` outside tests is the
signal) plus the debug log.

### The 18 instrumented branches

Nine `apply_*_via_loro` handlers, each with two early-return arms
(`SpaceUnresolved` first, then `EngineUninit`):

| # | Handler | `SpaceUnresolved` arm | `EngineUninit` arm | Op label |
| --- | --- | --- | --- | --- |
| 1, 2 | `apply_create_block_via_loro` | loro_apply.rs:68 | :80 | `create_block` |
| 3, 4 | `apply_edit_block_via_loro` | :150 | :159 | `edit_block` |
| 5, 6 | `apply_set_property_via_loro` | :201 | :210 | `set_property` |
| 7, 8 | `apply_delete_block_via_loro` | :266 | :275 | `delete_block` |
| 9, 10 | `apply_move_block_via_loro` | :310 | :324 | `move_block` |
| 11, 12 | `apply_restore_block_via_loro` | :421 | :430 | `restore_block` |
| 13, 14 | `apply_add_tag_via_loro` | :646 | :655 | `add_tag` |
| 15, 16 | `apply_remove_tag_via_loro` | :692 | :701 | `remove_tag` |
| 17, 18 | `apply_delete_property_via_loro` | :735 | :744 | `delete_property` |

`apply_purge_block_via_loro` (loro_apply.rs:466 / :471) is intentionally **not**
in the 18: its fallback is `purge_block_sql_cascade`, which is the canonical
SQL cascade run on *both* arms (the engine only models three of the ~15 tables
the cascade touches), so it is convergent by construction and has no second
implementation to drift against.

## Part 2 — convergence plan (this is the reviewed follow-up; do NOT do it in the instrumentation PR)

### The structural obstacle

The engine path and the fallback do not share a signature shape:

- The `apply_*_via_loro` path applies the op to the engine, **reads back a
  `BlockSnapshot`**, then projects the *snapshot* to SQL
  (`project_create_block_to_sql(conn, &snapshot)`, `project_move_block_to_sql(conn, &snapshot)`, …).
  The snapshot is authoritative — it reflects the engine's convergent decision
  (e.g. a rejected cyclic move keeps the old parent; the dense-rank sibling
  order; the LWW property winner).
- The `apply_*_sql_only` fallbacks operate **directly on the payload** because
  there is no engine to read back from.

So convergence is *not* "call `project_*_to_sql`" verbatim for the snapshot-keyed
helpers — there is no snapshot. Two helpers (`project_set_property_to_sql`,
`project_delete_property_to_sql`) **are** already payload-keyed, which is exactly
why `apply_set_property_sql_only` / `apply_delete_property_sql_only` already
delegate to them (#802) and cannot drift. The remaining seven need a bridge.

### Per-branch target

| Op | Current fallback | Convergence target |
| --- | --- | --- |
| `set_property` | delegates to `project_set_property_to_sql` | **done** (#802) — payload-keyed projection |
| `delete_property` | delegates to `project_delete_property_to_sql` | **done** (#802) — payload-keyed projection |
| `create_block` | bare `INSERT OR IGNORE` + index→position + `inherit_parent_tags` | synthesize a `BlockSnapshot` from the payload, call `project_create_block_to_sql` + `reproject_dense_positions`; or extract a `project_create_block_from_payload` shared helper the engine path also funnels through after read-back |
| `edit_block` | bare `UPDATE blocks SET content` | snapshot-synth → `project_edit_block_to_sql`, or shared payload helper |
| `delete_block` | `descendants_cte_active!` cascade UPDATE | route through `project_delete_block_to_sql` (already cohort/cascade-aware; the engine path already calls it) — the fallback's cascade is a re-spelling of the same CTE |
| `restore_block` | `descendants_cte_cohort!` cascade UPDATE | route through `project_restore_block_to_sql` (already cohort-contiguous since #1055) — same re-spelling |
| `move_block` | inline #383 cycle probe + bare `UPDATE parent_id/position` | the hardest: the engine path's cyclic-move *rejection* lives in the engine, and the fallback re-implements it in SQL (#383). Convergence requires a shared `validate_move_no_cycle` + `project_move_block_from_payload` that both arms call, with the fallback synthesizing the post-move snapshot |
| `add_tag` | `INSERT OR IGNORE block_tags` + `propagate_tag_to_descendants` | `project_add_tag_to_sql` (payload-keyed: `(block_id, tag_id)`) + the same inheritance fanout — straightforward delegation |
| `remove_tag` | `DELETE block_tags` + `remove_inherited_tag` | `project_remove_tag_to_sql` (payload-keyed) + the same inheritance cleanup — straightforward delegation |

### Shared-helper extraction plan

1. **Tags first (lowest risk).** `add_tag` / `remove_tag` projections are already
   payload-keyed (`block_id`, `tag_id`). Make the fallbacks delegate verbatim,
   exactly as #802 did for properties. No snapshot needed.
2. **Delete / restore next.** Both projections are already cohort/cascade-aware
   and payload-keyed (`block_id`, `now` / `deleted_at_ref`). Replace the
   re-spelled CTEs in the fallback with a call to the projection. Confirm the
   `descendants_cte_*` macro the projection uses is the same one the fallback
   used.
3. **Create / edit.** Introduce a payload→`BlockSnapshot` synthesis (the engine
   path's read-back equivalent for the fields the projection consumes) or split
   each projection into a payload-keyed core that both arms call. The engine
   path keeps its read-back; the fallback feeds the payload-derived snapshot.
4. **Move last (highest risk).** Extract the cyclic-move guard into one
   `validate_move_no_cycle(conn, block_id, new_parent)` used by both
   `move_block_inner` (command path), the engine, and the fallback. Then route
   the fallback through `project_move_block_from_payload`. Reproject dense
   sibling positions on both affected groups, matching the engine path.

The invariant the extraction must preserve: **every SQL write a fallback makes
is byte-for-byte the write the projection makes for the same logical effect.**
Where the engine path's read-back changes the effect (cyclic-move rejection,
dense-rank reorder, LWW property winner), the shared helper must encode that
same decision so the fallback's payload-derived result matches.

### Test strategy

- **The fallback is exercised by default.** Any apply test that does not call
  `install_for_test()` runs the fallback. So the existing ~135 engine-less tests
  already pin the fallback's behavior — the convergence refactor must leave them
  green (it is a behavior-preserving extraction, not a semantics change).
- **Conformance via the real foreground pipeline.** To prove the two arms agree,
  drive the *same* op through both paths and assert identical SQL:
  - engine path: `install_for_test()` + `append_local_op` + `dispatch_op` +
    `settle`, then read the **settled** reprojected state (per the #891 lesson —
    not the transient provisional command-path position; see crud.rs:195);
  - fallback path: the same op with no install;
  - assert the resulting `blocks` / `block_properties` / `block_tags` rows are
    equal. `engine_path_tests.rs` already establishes this convention.
- **Counter assertions.** Use `sql_only_fallback::count()` to assert that the
  engine-path conformance cases took **zero** fallbacks and the engine-less
  cases took the expected number — catching an accidental fallback in a test
  that meant to exercise the engine (the #891 failure mode).
- **Do not migrate the ~135 engine-less tests to `install_for_test()` here.**
  That is a separately-scoped L/XL effort and a prerequisite to any eventual
  deletion of `sql_only.rs`; convergence does not require it.

### Sequencing / risk

Ship as a sequence of small, individually-reviewed PRs in the order above
(tags → delete/restore → create/edit → move), each behavior-preserving and each
gated by the conformance + counter tests. The move arm is the only one that
touches shared validation logic and should be reviewed most carefully. None of
this belongs in the instrumentation PR.
