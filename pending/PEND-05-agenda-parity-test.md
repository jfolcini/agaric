# PEND-05 — Projected-agenda parity test (cached vs on-the-fly)

## Problem

`list_projected_agenda_inner` in <ref_file file="/home/javier/dev/agaric/src-tauri/src/commands/agenda.rs" /> has **two independent code paths** that compute projected agenda entries:

**Path 1 — Cached** (~lines 219-292): single SQL query against `projected_agenda_cache` (migration 0025), populated by the materializer's `RebuildProjectedAgendaCache` task. The cache rebuild itself lives in `cache::projected_agenda::rebuild_projected_agenda_cache_impl` (cache/projected_agenda.rs:100-156).

**Path 2 — On-the-fly** (~lines 281-291, delegating to `list_projected_agenda_on_the_fly` lines ~371-627): fetches repeating blocks, computes projections in-memory, applies repeat rules + modes (`.+`, `++`, default) + end conditions (`repeat-until`, `repeat-count`, `repeat-seq`). Triggered when cache is empty AND no cursor is provided.

There is currently **no test that asserts these two paths produce identical results.** Both paths must compute the same projections for identical inputs, but the projection logic is duplicated across two locations. Drift vectors found during investigation:

- Mode parsing (`.+` and `++` prefixes) — two separate `strip_prefix` blocks, easy to fix one without the other.
- `++` (skip-past-today) pre-add window — cache uses `current >= today && current <= horizon` (cache/projected_agenda.rs:333); on-the-fly uses `current >= range_start && current <= range_end` (commands/agenda.rs:526). Subtly different.
- Until-date filtering — different conditional styles in the two paths.
- Horizon — cache projects to `today + 365 days` (cache/projected_agenda.rs:106); on-the-fly to caller-supplied `range_end`.
- Cursor filtering — cache filters in SQL; on-the-fly post-sorts and filters in-memory.

If the cache rebuild diverges from on-the-fly (a bugfix on one path missed on the other), the user sees different agendas depending on whether the cache is warm or cold. This is invisible to the user beyond "agenda items appearing/disappearing" — the kind of bug that hides for months.

## Test design

**Single deterministic parity test in `src-tauri/src/commands/tests/agenda_cmd_tests.rs`.** Property-based variant deferred (see Open Questions).

### Test name

`projected_agenda_cached_equals_on_the_fly`

### Setup

Build a small but representative fixture: 5 blocks covering each repeat surface that has historically drifted. **Use far-future dates (2050) so the fixture is stable for ~25 years and the cache rebuild's `chrono::Local::now()` always falls before all due_dates** — the test exercises both paths regardless of when CI runs.

- **Block A** — `due_date=2050-04-06`, `repeat=daily`, `repeat-count=5` (5 occurrences, simplest)
- **Block B** — `scheduled_date=2050-04-10`, `repeat=weekly`, `repeat-until=2050-05-01` (until-date filter)
- **Block C** — `due_date=2050-04-15`, `repeat=+3d`, `repeat-count=3` (custom interval)
- **Block D** — `due_date=2050-04-20`, `repeat=.+ 1w` (completion-based mode)
- **Block E** — `due_date=2050-04-25`, `repeat=++ 1w` (skip-past-today mode — the trickiest)

All blocks: not-DONE, not-deleted, not-conflict, not on a template page. **`space_id` = `None`** in both query paths (matches the existing test convention at agenda_cmd_tests.rs:1115; the FEAT-3p4 path is exercised by separate space-scoped tests).

**Pin `today = 2050-04-06`** in the on-the-fly call. The cache rebuild reads `chrono::Local::now()` directly — at any reasonable runtime year that's still before 2050-04-06, so all fixture due_dates are in the future and both paths populate.

**Important — range must extend past day 365.** The reviewer caught that the original proposed range (~55 days) is *inside* the cache's 365-day horizon and therefore cannot expose the **horizon drift** between cache (`today + 365`) and on-the-fly (caller-supplied `range_end`). **Use `range_start = 2050-04-06`, `range_end = 2051-05-01`** — that's ~390 days, comfortably past the cache horizon. The fixture's repeat-count=5 / repeat-until=2050-05-01 / repeat-count=3 end conditions cap each individual block, so the test still terminates with a small number of projected entries.

### Action

```text
1. rebuild_projected_agenda_cache(&pool).await.unwrap()
2. Page through list_projected_agenda_inner(&pool, "2050-04-06", "2051-05-01", limit=500, cursor=None, space_id=None)
   → collect all results into `cached_results: Vec<ProjectedAgendaEntry>`
3. sqlx::query("DELETE FROM projected_agenda_cache").execute(&pool).await.unwrap()
4. Call list_projected_agenda_on_the_fly(&pool, range_start=2050-04-06, range_end=2051-05-01, limit=500, pinned_today=2050-04-06, None, None)
   → collect into `on_the_fly_results: Vec<ProjectedAgendaEntry>`
```

The 390-day range exposes BOTH known drift vectors:

- **Horizon drift** — cache stops at `today + 365`; on-the-fly continues to `range_end`. Without a >365-day range, this drift is invisible.
- **`++` pre-add window drift** — block E's skip-past-today logic uses different bounds in each path; a range spanning multiple weeks past `today` exercises it.

### Assertion

```rust
assert_eq!(cached_results.len(), on_the_fly_results.len(),
    "cached and on-the-fly must return the same count");
for (i, (c, otf)) in cached_results.iter().zip(on_the_fly_results.iter()).enumerate() {
    assert_eq!(c.block.id, otf.block.id, "entry {i}: block_id mismatch");
    assert_eq!(c.projected_date, otf.projected_date, "entry {i}: projected_date mismatch");
    assert_eq!(c.source, otf.source, "entry {i}: source mismatch");
}
```

`assert_eq!` (not `assert!`) so the failure message shows the exact divergence.

## Test location

`src-tauri/src/commands/tests/agenda_cmd_tests.rs` — appended next to existing agenda tests like `projected_agenda_respects_repeat_count_end_condition`. Matches repo convention (command tests live in `commands/tests/`).

## Fixtures & helpers

**Reuse:** `test_pool()`, `create_block_inner()`, `set_property_inner()`, `set_due_date_inner()`, `settle(mat)`, `assign_all_to_test_space()` — all in `src-tauri/src/commands/tests/common.rs`.

**New helper (small):** inline cursor-pagination loop or a tiny `collect_all_pages` helper. No abstraction needed beyond ~10 lines.

**No insta snapshots needed** — the assertion is item-by-item, and the failure message already pinpoints the divergence.

## CI integration

Runs in `cargo nextest run` (default profile). No special tags needed. Deterministic (pinned `today`, no clock dependency in the on-the-fly path), no network, no system clock drift sensitivity beyond Open Question #3 below.

Execution time: <500ms (5 blocks, 2 queries, small temp DB).

## Cost

**S (1-2 hours).**

| Step | Time |
| --- | --- |
| Fixture setup (5 blocks + properties) | 30 min |
| Cached-path query + on-the-fly-path query | 30 min |
| Assertion + cursor pagination | 15 min |
| Run + iterate + handle test-pool quirks | 30 min |

## Impact

**Catches:** drift between cache rebuild and on-the-fly computation — a known, plausible bug class.

**Severity without test:** medium. Wrong agenda items, easy to notice but hard to debug (cache state is opaque).

**Severity with test:** eliminated. Any divergence is caught in CI before landing.

## Risk

**Low.** Test addition only; no behavior change. Currently passes (paths are in sync). If the test fails on first run, that's a discovery, not a regression introduced by the test.

## Open questions

1. **Property-based variant?** `proptest` is already a dev-dep. A proptest companion that generates random recurrence rules + date ranges would catch edge cases the manual fixture misses. **Recommendation: defer.** The manual test catches the known drift class; proptest is a separate concern (fuzzing the projection logic itself).

2. **Should the test call `Materializer` or `rebuild_projected_agenda_cache` directly?** **Recommendation: direct call.** Bypasses materializer multi-threading complexity. The materializer is exercised separately in `materializer/tests.rs`.

3. **Should we ALSO refactor the projection logic into a single function called by both paths, eliminating the drift surface entirely?** That's the deeper fix. The parity test catches drift; a refactor *prevents* it. **Recommendation: file as a follow-up `MAINT-*` item in REVIEW-LATER.md.** This task ships the safety net first; the refactor lands later when there's bandwidth.
