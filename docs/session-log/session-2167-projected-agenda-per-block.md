# Session 2167 — a property op refreshes only its own block's projected agenda (#5423 item 5)

In #5592's after-run, `set_property (todo_state, 2K-block page) @ 100K` took 2.33 ms for the command and 76.50 ms settled. The probe's vault has 200 repeating tasks, and every todo, date or repeat write enqueued `RebuildProjectedAgendaCache`. That rebuild deletes every row of `projected_agenda_cache` and re-projects every repeating block under one write lock. `agenda_cache` is already diff-based and is not enqueued for `todo_state`, so this rebuild accounted for the whole gap.

**The task.** `MaterializeTask::UpdateProjectedAgendaBlock { block_id }` runs on the background queue and is deduplicated per block. Its retry mirror (`RetryKind::UpdateProjectedAgendaBlock`) keeps the block id.

**Dispatch.** `push_property_op_invalidations` now pushes the per-block task for a projected-relevant key. Two cases still push the full rebuild:
- `template`, which changes every block on its page;
- an unparseable payload.

No other op's invalidations change.

**`update_projected_agenda_block`.** In one `BEGIN IMMEDIATE` it:
- reads the horizon's `rebuild_today`;
- deletes the block's rows;
- selects the block with the full rebuild's own predicate plus `b.id = ?1`;
- projects it at that anchor;
- inserts through the existing flush helper.

It never rewrites the horizon row. If there is no horizon row, or `rebuild_today` is not today, it rolls back and runs the full rebuild. So the first projected write of a day still re-anchors the horizon, as every such write used to.

**`dedup_tasks`.** Adding the task's key pushed it past clippy's 70-line limit. Its seven per-id sets are now one set keyed on (kind, id), with the same behaviour.

**Tests.**
- **Oracle:** `property_op_refreshes_one_block_equal_to_a_full_rebuild_5423` covers 13 shapes, each driven through `dispatch_op` and a flush:
  - daily and weekly repeat;
  - due only, scheduled only, both;
  - repeat-until, repeat-count;
  - DONE then TODO;
  - repeat removed, dates removed;
  - soft-deleted;
  - on a template page;
  - a block gaining `repeat`.

  After each one the whole cache equals a fresh full rebuild, and two other repeating blocks keep exactly their rows. The handler reads the wall clock, so a run that straddles local midnight fails this test; the module doc says so.
- **Store**, pinned to a date:
  - `per_block_refresh_projects_from_rebuild_today_5423`, which also checks that the horizon row is left alone;
  - `per_block_refresh_re_anchors_a_stale_or_missing_horizon_5423`.
- **Dispatch:** the property-op label tests now expect the per-block task. New tests cover `delete_property repeat` and `template`, set and deleted.
- **Retry and dedup:** both round-trip the new kind.

**Review** (a different model) found no correctness defect. It found two gaps in the oracle, both closed here:
- **Nothing pinned the narrowing itself.** Its "other blocks keep their rows" check also held under a whole-vault rebuild, so wiring the handler back to the full rebuild kept every test green. Before each op, the oracle now plants a cache row no rebuild writes, and requires the op to leave it.
- **No shape set `repeat-seq`**, so the per-block query's join to it was unpinned. A "repeat-seq set against a repeat-count" shape now covers it.

The review also diffed the old and new `dedup_tasks` over 30,000 random batches and found them identical.

**Falsified** on copies. Each mutation reddened the test named:

| Mutation | Red test |
| --- | --- |
| Drop the per-block DELETE | the store test and the oracle |
| Project at the wall clock instead of the anchor | the store test |
| Drop the template predicate | the oracle's template shape |
| Drop the stale-anchor fallback | the re-anchor test |
| Dispatch `template` to the per-block task | its dispatch test |
| Route the handler to the full rebuild | the oracle's planted row ("the op rewrote a block it does not own") |
| Break the per-block `repeat-seq` join (run by the reviewer) | the oracle's repeat-seq shape |

**Docs.** The comments and docs that described the old invalidation now describe the per-block refresh:
- `operations.md` § Bounded-horizon projected agenda;
- the cache row and the per-entity retry kinds in `data-and-events.md`;
- the freshness notes in `commands/agenda.rs`;
- `PROJECTED_AGENDA_OWNER` in the reconciliation oracle;
- the probe's comments.

Ran:
- `cargo nextest run --workspace -E 'test(projected) | test(agenda) | test(dispatch) | test(retry) | test(materializer) | test(dedup)'` (763 passed);
- `cargo clippy --workspace --all-targets -- -D warnings`;
- `cargo fmt --all --check`;
- `SQLX_OFFLINE=true cargo check --workspace --all-targets`;
- `just gen-sqlx`.

The after number comes from this branch's `bench-slo` run.
