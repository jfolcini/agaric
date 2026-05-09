# PEND-09 — `apply_op` reorder design

PEND-09 Phase 2 day-11 deliverable, written **2026-05-10**.  Closes the
single biggest gap before the cutover flag-flip surfaced in
`pending/PEND-09-PHASE-2-REPORT.md` §4.1: today the
`pend09.loro_authoritative` runtime flag (commit `d0395805`) exists but
no code path branches on it.  Flipping it to `'1'` changes nothing
observable.

This doc designs the substantive reorder; day-11 lands the projection
helpers + the branch wired in for **CreateBlock + EditBlock** as
proof-of-concept; remaining op types ship under feature-gated TODO
stubs.  Day-12+ widens the wiring as scope permits.

## 1. Shape — Option A (chosen) over Option B

The cutover plan §8.4 listed two reorder shapes:

- **Option A** — `apply_op_tx` keeps its current outer
  match-on-op-type structure.  Each arm gets a flag check; on flag-on,
  it routes through a parallel set of "loro+projection" helpers.  When
  the flag is off (production default), the existing diffy-side
  `apply_*_tx` helpers run unchanged.
- **Option B** — `apply_op` is split into two top-level paths:
  `apply_op_tx` (today's diffy-side) and `project_from_loro_to_sql` (a
  new function bypassing `apply_op_tx`).  The `apply_op` /
  `BatchApplyOps` dispatch sites pick which to call based on
  `is_loro_authoritative()`.

**Decision: Option A.**  Three reasons:

1. **Test-coverage parity.**  Both paths share the same op-type
   dispatch shape, so the existing per-op-type SQL invariants
   (`materializer/handlers.rs`'s 12 `apply_*_tx` helpers) are still
   exercised in the diffy-off test runs.  Option B's bypass means the
   diffy code path becomes dead in cutover-on builds, but any latent
   bug in that path stays latent until the kill switch fires — by
   which point we'd be flying blind.  Option A keeps both paths
   live in the same function so the test harness exercises both
   under feature-on.
2. **Smaller diff per op type.**  Option A's per-arm if-else lets
   each op type land independently.  Day-11 ships CreateBlock + EditBlock;
   day-12 widens.  Option B forces the whole `project_from_loro_to_sql`
   function to land at once (every arm needs every helper) — too big
   for one commit.
3. **Easier rollback inside a single op type.**  If, say, MoveBlock's
   projection is wrong, an Option-A revert is one if-else removed in
   one arm.  Option B would need a per-op-type bypass-the-bypass —
   awkward.

Option A's drawback per the cutover plan §8.4 — "requires editing
every code path inside `apply_op_tx` that 'knows' diffy is
authoritative — a much larger churn surface" — is mitigated by the
fact that `apply_op_tx`'s arms are very thin today: each is a single
`apply_*_tx(p)` call.  The reorder becomes a simple branch ahead of
that call, not a rewrite of the call's internals.

## 2. Projection rules per op type

When `is_loro_authoritative()` returns `true`, the op-type arm:

1. Resolves the block's space (the engine is per-space).
2. Acquires the registry mutex via `LoroEngineRegistry::for_space`.
3. Applies the op to the engine via the matching `apply_*` method.
4. Reads the post-apply engine state for the affected block.
5. **Drops the registry mutex.**
6. Projects the engine state into SQL via a per-op `project_*_to_sql`
   helper that uses the same `&mut SqliteConnection` the caller is
   inside, so the projection commits atomically with the rest of the
   tx (cursor advance, etc.).

Per-op-type projection details:

| Op type | Engine apply | SQL projection |
| ------- | ------------ | -------------- |
| `CreateBlock` | `apply_create_block` | `INSERT INTO blocks (...) VALUES (engine.read_block(id))`. `block_properties` and `block_tags` start empty. The `tag_inheritance::inherit_parent_tags` helper still runs — it derives from the post-INSERT `blocks` row. |
| `EditBlock` | `apply_edit_via_diff_splice(to_text)` | `UPDATE blocks SET content = engine_snapshot.content WHERE id = ? AND deleted_at IS NULL`. (Same shape as today's diffy path.) |
| `DeleteBlock` | `apply_delete_block` (per-block-id) | `UPDATE blocks SET deleted_at = ? WHERE id = ?`. The cascade walk lives on the SQL side (`descendants_cte_active`), and each descendant's engine `apply_delete_block` is reachable through the post-commit shadow dispatch on the descendant's own subsequent `delete_block` op (or, in cutover, would need a similar fanout to the restore-cascade fanout). **Day-11 caveat:** the cascade-fanout-on-cutover is a follow-up; day-11's projection is the per-block-id update. |
| `MoveBlock` | `apply_move_block(parent, position)` | `UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?`, plus `tag_inheritance::recompute_subtree_inheritance`. |
| `SetProperty` | `apply_set_property(key, value)` | Two cases: (a) reserved hot-path key (`todo_state` / `priority` / `due_date` / `scheduled_date`) → `UPDATE blocks SET <col> = ? WHERE id = ?`; (b) non-reserved key → `INSERT OR REPLACE INTO block_properties (block_id, key, value_*) VALUES (...)`.  Hot-path keys mirror property values into both the engine's property map AND the dedicated `blocks` column (today's diffy code path makes the same choice — see `pending/PEND-09-crdt-migration.md` lines 17-36). |
| `DeleteProperty` | `apply_delete_property(key)` | Symmetrical: reserved key → `UPDATE blocks SET <col> = NULL`; non-reserved → `DELETE FROM block_properties WHERE block_id = ? AND key = ?`. |
| `AddTag` | `apply_add_tag(tag_id)` | `INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)`, plus `tag_inheritance::propagate_tag_to_descendants`. |
| `RemoveTag` | `apply_remove_tag(tag_id)` | `DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?`, plus `tag_inheritance::remove_inherited_tag`. |
| `RestoreBlock` | `apply_restore_block` (per-block-id) | `UPDATE blocks SET deleted_at = NULL` for the cohort.  The descendant cohort is captured pre-update via `collect_restore_cohort` (same SELECT used today), then projected.  Engine fanout via the existing `dispatch_restore_descendants_shadow` helper continues to work because each engine apply is idempotent — but in cutover the engine apply happens BEFORE the SQL UPDATE, so the cohort capture must run before the engine apply too (a re-scoped `collect_restore_cohort` that runs against pre-mutation SQL state). |
| `PurgeBlock` | `apply_purge_block` (per-block-id) | The whole 15-statement cascade in `apply_purge_block_tx` fires unchanged.  PurgeBlock's projection is "do the cascade and propagate the engine purge per-descendant" — same shape as RestoreBlock. |
| `AddAttachment` / `DeleteAttachment` | _NOT projected through Loro_ | Attachments carry file blobs that live outside the CRDT state per the cutover plan §8.2 + Phase-2 report §8.6.  These arms run their existing `apply_*_attachment_tx` SQL UPDATE unconditionally, regardless of the cutover flag.  `is_loro_authoritative()` is **not** checked on these arms — they always take the SQL path. |

## 3. Hot-path columns

The four hot-path columns (`todo_state`, `priority`, `due_date`,
`scheduled_date`) per `pending/PEND-09-crdt-migration.md` lines 17-36
are derived from `SetProperty` ops with reserved keys.  Today's
diffy-side `apply_set_property_tx` (`materializer/handlers.rs:837-904`)
handles this with a per-key match: reserved keys UPDATE the dedicated
column, non-reserved keys INSERT OR REPLACE into `block_properties`.

`project_set_property_to_sql` mirrors the same per-key match: for a
reserved key it reads the post-apply engine value and UPDATEs the
column; for a non-reserved key it INSERT-OR-REPLACES the
`block_properties` row.

The engine treats every property the same way (a single LoroMap entry
under `block_properties`) — the per-key column-vs-table distinction is
purely a SQL-projection concern.

## 4. Cache rebuilds (`block_links`, `block_tag_inherited`)

Both are derived caches per the cutover plan §8.2:

- `block_links` is re-derived from `blocks.content` by
  `cache::reindex_block_links` (parses `[[ULID]]` / `((ULID))` tokens).
  No engine support needed — once the projection updates
  `blocks.content`, the existing reindex helper produces correct
  rows.
- `block_tag_inherited` is re-derived from `block_tags` +
  parent-relationship by `cache::reindex_block_tag_refs` /
  `tag_inheritance::*`.  Same story — once `block_tags` is correct,
  the inheritance walk produces correct rows.

The cutover does **not** introduce new cache-rebuild calls; the
existing `tag_inheritance::*` calls inside each `apply_*_tx` arm move
verbatim into the projection helper.

## 5. Atomic semantics + the engine non-rollback

**Trade-off.**  If the engine apply succeeds but the SQL projection
fails:

- The tx rolls back automatically (sqlx `Transaction` drops without
  commit).
- The Loro engine state is **not** rolled back.  Loro 1.x does not
  expose a transaction primitive that we can wrap around the apply.

**Why it's acceptable.**  The op_log is the source of truth.  On the
next process start, the snapshot scheduler rebuilds engine state by
replaying the persisted op_log on top of the most recent snapshot.  An
engine-state divergence introduced by a crash mid-projection survives
only until that next replay — at which point the engine is rebuilt
from the same op_log the materializer uses, and the divergence is
gone.

The narrow window where divergence is observable: between the failed
projection and the next snapshot+replay cycle.  In that window:

- Reads from SQL (the user-visible path) reflect the pre-failure
  state, because the tx rolled back.
- Reads from the engine (parity-checking, debug paths, future Loro
  read-path) reflect the post-apply state.
- Sync messages emitted from the engine in this window propagate the
  diverged state.  But the materializer never enqueues a sync message
  on a tx-rolled-back op (op_log writes are themselves inside the tx
  that rolled back), so this window does not produce visible sync
  effects in practice.

**Mitigation if it becomes a problem (Phase 3+).**  Keep a per-engine
"applied op_log seq" counter; if it advances past the materializer's
`materializer_apply_cursor` (signalling a divergence), emit a
`tracing::error!` and force a full snapshot+replay to re-anchor.  Out
of scope for day-11.

## 6. Reversed parity logging (deferred to day-12)

When Loro is authoritative, the diffy code path becomes the secondary.
The parity log's column meanings flip:

- `loro_result` becomes the PRIMARY (because Loro is now the truth
  the SQL is projected from).
- `diffy_result` becomes the SECONDARY (the shadow check we run
  to confirm diffy would have produced the same SQL — useful for
  rollback safety).

**Day-11 scope.**  Leave shadow logging unchanged.  When the flag is
off (production default), the parity log keeps its current diffy=primary
shape; when on, the parity log's bucket classification continues to
report disagreements but with the inverted convention not yet
documented in the column header.  The flush task's classifier doesn't
care about which side is primary — it just compares two strings — so
correctness is unaffected.  Day-12 adds a column rename / docstring
update + a `loro_authoritative_at_classify` boolean column to the
`merge_parity_log` so retrospective analysis can know which way the
parity ran for any given row.

## 7. Engine guard scoping

The registry guard (`registry::EngineGuard`) holds the registry
`Mutex<HashMap<...>>`.  Under the cutover branch the apply path:

1. Acquires the guard via `for_space(...)`.
2. Calls `engine_mut().apply_*(...)`.
3. Calls `engine.read_block(...)` (or whichever read fits the
   op type) **while still holding the guard** — engine reads need the
   `&mut LoroEngine` that `engine_mut()` provides, but reading is
   intrinsically read-only and could hypothetically use a `&LoroEngine`
   if the API exposed one.  Today it uses `&self` on the engine
   methods, so the guard is held only for the duration of the read
   call.
4. **Drops the guard.**
5. Calls the projection helper, passing the read-back `BlockSnapshot`
   by value.

The projection helper does not touch the registry; its only argument
is the snapshot data.  This avoids a re-entrancy hazard (the
projection helper running async SQL while still holding the registry
mutex would deadlock if any nested call tried to re-acquire — though
in practice nothing nested does today).

The `EngineGuard` is `!Send` because `MutexGuard` is `!Send` on most
platforms — meaning we cannot hold it across an `.await` point.  This
is enforced by Rust's auto-trait inference; if a future change tries
to hold the guard across `.await`, it will fail to compile, which is
the correct behaviour.

**Decision:** read-back-then-drop-then-project.  Snapshot-by-value
keeps the projection helper's signature simple (no engine reference)
and makes it directly unit-testable from a synthetic `BlockSnapshot`.

## 8. Tests

**Unit tests** (in `src-tauri/src/loro/projection.rs`):

- `project_create_block_writes_blocks_row` — given a snapshot,
  the helper INSERTs a row matching the snapshot.
- `project_edit_block_updates_content` — given a pre-existing row,
  the helper UPDATEs `content` to match a new snapshot.
- `project_set_property_writes_typed_value_and_hot_path_column`
  — covers both the typed-value column path AND the hot-path mirror.
- `project_purge_block_cascades_to_properties_and_tags` — given
  pre-existing rows in `blocks`, `block_properties`, `block_tags`,
  the helper deletes all three.

**End-to-end tests** (in `src-tauri/src/materializer/handlers.rs`'s
test module or a new test module):

- `apply_op_tx_uses_loro_path_when_flag_on` — flip the flag,
  dispatch a CreateBlock op, verify SQL rows match the engine's
  read-back (i.e. the projection ran).
- `apply_op_tx_uses_diffy_path_when_flag_off` — default flag,
  dispatch a CreateBlock op, verify SQL rows match the diffy-direct
  path.

**Day-11 conservative scope.**  The unit tests for Create + Edit +
SetProperty + Purge land in `projection.rs`.  The end-to-end tests
land for Create + Edit only, demonstrating the branch wires to the
flag.  Move / Delete / Restore / DeleteProperty / Tag end-to-end tests
are day-12.

## 9. Day-11 deliverable scope

| Item | Day-11 | Day-12+ |
| ---- | ------ | ------- |
| Design doc | this doc | — |
| Projection helpers (Create, Edit) | with unit tests | — |
| Projection helpers (SetProperty, Purge) | with unit tests | — |
| Projection helpers (Move, Delete, Restore, DeleteProperty, Tag) | stubs with TODO comments | wire fully |
| `apply_op_tx` branch wired (Create, Edit) | yes | — |
| `apply_op_tx` branch wired (other op types) | branch lands but calls existing `apply_*_tx` (TODO: wire engine path) | wire fully |
| End-to-end tests (Create, Edit) | yes | — |
| End-to-end tests (other op types) | — | yes |
| Reversed parity logging | leave shadow logging as-is (flag-off path) | day-12 |
| Cohort-fanout-on-cutover for Restore / Purge | post-commit fanout still uses today's `dispatch_restore_descendants_shadow` (idempotent re-apply on the engine is harmless) | scope as-needed |

## 10. Default-build invariant

All new code is `#[cfg(feature = "loro-shadow")]`-gated.  When the
feature is off, the new module does not compile and the branch in
`apply_op_tx` is compiled out.  Default-build behaviour byte-identical
to commit `19b9d8bd` (Phase-2 day-10).

## 11. Flag-off invariant

Even with the feature on, the branch's "loro authoritative" arm is
guarded by `is_loro_authoritative()`, which defaults to `false` until
the maintainer explicitly flips the row.  Tests opt in via
`install_cutover_flag_for_test(true)` in scoped contexts.

## 12. Known follow-ups (day-12+)

The day-11 branch ships proof-of-concept for CreateBlock + EditBlock.
The following observations were surfaced during day-11 review and are
captured here so they're not lost on the way to day-12:

1. **Behaviour drift on duplicate CreateBlock under cutover-on.**
   `project_create_block_to_sql` uses `INSERT OR IGNORE` — a duplicate
   create silently no-ops on the SQL side, mirroring today's
   `apply_create_block_tx`.  The engine's `apply_create_block`,
   however, errors with "block slot already populated" if the block
   id is already present.  Under cutover-on, the engine apply runs
   first and surfaces the error before the projection's
   `INSERT OR IGNORE` would have absorbed it.  Net effect: a duplicate
   create that the diffy path silently absorbs becomes a hard error
   under cutover-on.  Day-12: either soften the engine's
   `apply_create_block` to be idempotent, or pre-check the engine
   state in `apply_create_block_via_loro` and short-circuit before
   the engine apply.  Mirror choice on the SQL side (so the two
   stay aligned).

2. **`page_id` not set by `apply_create_block_tx`; cutover-on falls
   back to diffy on resolve-failure.**  The diffy-side
   `apply_create_block_tx` does NOT populate `blocks.page_id` — that
   column is filled by `cache::rebuild_page_ids` on a background
   sweep, or by per-command updaters.  Without `page_id`,
   `resolve_block_space` for a freshly-created block walks
   parent-by-parent up to the page (which works), but for an
   EditBlock op against that same block (issued shortly after the
   create, before the page_id rebuild fires), `resolve_block_space`
   may fall back to the diffy path.  This is acceptable but not
   robust; day-12 should either populate `page_id` in
   `project_create_block_to_sql` (mirroring the diffy path's eventual
   state) or verify the resolution walks parent-by-parent for
   page_id-less blocks.  The end-to-end test
   `apply_op_tx_edit_block_uses_loro_path_when_flag_on` already
   inlines a `UPDATE blocks SET page_id = ?` between the create and
   the edit — that workaround is the proximate evidence.

3. **`apply_edit_via_diff_splice` checks engine state, not SQL.**  In
   the diffy path, `apply_edit_block_tx` no-ops on a block the SQL
   doesn't know about (the `WHERE id = ? AND deleted_at IS NULL`
   filter silently matches zero rows).  In the cutover-on path,
   `engine.apply_edit_via_diff_splice` errors on a block the engine
   doesn't know about.  A remote EditBlock for an unseen block
   therefore errors under cutover-on where it would silently no-op
   under cutover-off.  Day-12: either soften the engine's edit to
   no-op on missing block, or pre-check engine state and route to
   the diffy path on engine-not-found.  This dovetails with
   observation 1 — the same shape of "engine is strict, SQL is
   permissive".

These three observations all share the same root cause: the engine
is strict by design (op preconditions checked at apply time) and the
SQL layer is permissive by design (SQL idempotence via `OR IGNORE` +
`WHERE deleted_at IS NULL`).  The cutover surfaces this asymmetry.
Day-12+ design choice: align them, in either direction (loosen
engine, or tighten SQL), but pick a side and document it.

A fourth observation surfaced and rejected: the leading-underscore
`_effects` binding at `apply_op` (line 179) is intentional —
`_effects.restored_cohort` is read at line 204 inside the
`#[cfg(feature = "loro-shadow")]` block.  The leading underscore
suppresses the warning on default builds where that line is compiled
out; on feature-on builds the binding is read.  Not a bug.

— PEND-09 Phase 2 day-11, 2026-05-10.
