# Session 1731 — the `db/recovery.rs` splits (#4639)

Refs #4639, seventh slice: the five `#[expect(clippy::too_many_lines)]`
sites in `src-tauri/src/db/recovery.rs`, the disaster-recovery module
(`ensure_blocks_table_exists`, `reproject_blocks_from_engine`,
`ReplayDiagnostics::emit`, `recover_derived_state_from_op_log`,
`recover_attachments_from_op_log`). Pure moves inside the caller-owned
transactions and savepoints; no write reordered, no SQL literal changed by
a byte, no error text or log line changed, no lint suppression added.

- `ensure_blocks_table_exists`: `try_head_shape_rebuild` owns the
  head-shape attempt (the `spaces` pre-flight, the rebuild, the
  diagnostics emit and both error fallbacks) and answers `true` where the
  original returned early, so the parent's `&&` short-circuit falls
  through to the scaffold retry exactly as before.
- `reproject_blocks_from_engine`: `load_engine_snapshots` (the two
  early returns collapse into one emptiness check, neither had a side
  effect), `read_engine_core_rows` and `read_engine_block_states` (the
  bulk read with per-block fallback, and the per-block property, tag and
  tombstone reads), `project_engine_core_rows` and
  `project_engine_derived_rows` (the Pass A and Pass B/C/D savepoint
  loops), `reproject_space_from_engine` (the per-space body; a decode
  failure answers `None` so the parent counts the skip, an empty block
  list answers `Some((0, 0))` so the counters move as before) and
  `rebuild_caches_after_engine_reproject` after the commit.
- `emit`: one helper per report section (`emit_create_anomalies`,
  `emit_move_reconciliations`, `emit_cascade_truncations`,
  `emit_purge_tails_finished`), output order byte-identical.
- `recover_derived_state_from_op_log`: `replay_derived_op` is the op
  match, `replay_set_property_op` the set-property arm with
  `replay_set_property_clear` and `replay_reserved_set_property` under it;
  the loop's `continue`s became the helpers' `return Ok(())`.
- `recover_attachments_from_op_log`: `replay_attachment_op` is the op
  match and `replay_add_attachment` the add arm, which still takes the
  row for `created_at` and `is_replicated`.

## Verified

`cargo clippy -p agaric --lib --tests -- -D warnings` prints nothing
with the five attributes gone; `cargo fmt --all -- --check` clean;
`SQLX_OFFLINE=true cargo check --workspace --all-targets` 0 warnings;
`cargo nextest run --workspace` 6318 passed, 13 skipped; doc-tests green.
The reviewer lexed every string literal out of both revisions (1349
against 1344, the delta being the five removed `expect` reasons), lexed
all 58 `sqlx::query*` chains and found them identical modulo one rustfmt
reflow, and matched all 32 tracing calls field by field, so no SQL, log
line or `.sqlx/` entry moved; it also traced each of the five `continue`
to `return Ok(())` conversions to a loop whose match was already the last
statement. Falsified on copies: the committed head-shape attempt's early
return dropped reddened `recovered_blocks_schema_matches_migrated_head_3269`;
the Pass A savepoint committing turned into a rollback reddened
`recover_reprojects_remote_content_from_engine_2504`; the `add_tag` arm
never taken reddened `init_pool_recover_blocks_from_op_log_73`; the
space fan-out `UPDATE` dropped reddened
`recovery_set_space_dangling_target_skips_not_aborts_605`; the attachment
`INSERT` dropped reddened
`replicated_attachment_restored_only_when_blob_is_held_3268`; the
reviewer independently removed the dangling-`space` early return and
reddened the 605 and 708 tests. All restored, `cmp` clean. Two gaps
recorded, not filed: no test reaches the four `emit_*` helpers (pure
moves of log calls, matched by multiset) and none seeds an all-null
`set_property` on a reserved key, a gap that predates the split.
Attribute count 99 to 94.
