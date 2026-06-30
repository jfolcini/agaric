## Session 1142 — #2069: list_projected_agenda on-the-fly date-overlap prefilter (2026-06-30)

| Field   | Value                                                  |
| ------- | ------------------------------------------------------ |
| Session | 1142                                                   |
| Issue   | #2069                                                  |
| Branch  | claude/issue-2069-projected-agenda-prefilter           |
| Date    | 2026-06-30                                             |
| Area    | src-tauri/src/commands/agenda.rs (on-the-fly fallback) |

## Summary

`list_projected_agenda` exceeded the 200 ms interactive SLO (~620 ms @ 100K).
The issue's literal premise — "push the date-range projection into SQL" — is
STALE / INFEASIBLE: the recurrence grammar (sticky monthly clamp, `.+`
dot-plus and `++` plus-plus today-anchored catch-up, the 10 000-step safety
bound, the 1900–2200 calendar rail) is stateful Rust in `crate::recurrence`
(`project_block_dates` / `shift_date_once`), and the cache rebuild ALSO
expands in Rust — neither can become a recursive-CTE / `generate_series`
rewrite without re-implementing that grammar in SQL.

The real cost: `list_projected_agenda_on_the_fly` (the fallback used on a
fresh first page before the cache is warm) ran its SELECT over ALL repeating
blocks, then expanded each across the 365-day horizon in Rust and paginated
AFTER. This change adds a PROVABLE-SUPERSET date-overlap PREFILTER to that
SELECT so blocks that cannot project an occurrence into `[range_start,
range_end]` are excluded before the Rust expansion — shrinking the expansion
set without changing results. The cache path and the recurrence math are
untouched.

## Change

- `src-tauri/src/commands/agenda.rs` — `list_projected_agenda_on_the_fly`:
  added one `AND ( ... )` clause to the existing `sqlx::query_as!` fallback
  SELECT (a new `?2` bind = `range_end` as `YYYY-MM-DD`). A block is KEPT iff
  its repeat rule is today-anchored (`bp.value_text LIKE '%.+%'` OR
  `LIKE '%++%'`) OR `b.due_date <= ?2` OR `b.scheduled_date <= ?2`. Only the
  UPPER bound is filtered; the lower bound is never touched (a past base with a
  forward repeat can still land in the window). All other predicates
  (`deleted_at`, `todo_state != 'DONE'`, has-repeat-rule, template carve-out,
  space filter) are unchanged.
  - Today-anchored prefixes verified against `recurrence::parser::shift_date`
    and `recurrence::projection::project_block_dates`: exactly `.+` (dot_plus)
    and `++` (plus_plus); every other form (daily / weekly / monthly / +Nd /
    +Nw / +Nm / +Ny) is base-anchored.
  - The today-anchored arms use a SUBSTRING-CONTAINS test (`LIKE '%.+%'` /
    `'%++%'`) rather than a `LOWER(TRIM(...)) LIKE '.+%'` PREFIX test (#2069
    review fix). `.+` / `++` contain no alphabetic characters (so case is
    irrelevant — no `LOWER`) and `.` / `+` are not LIKE metacharacters, so any
    rule the projector would classify as today-anchored necessarily contains
    the literal `.+` / `++` substring regardless of leading whitespace —
    closing the SQLite `TRIM()` (ASCII-space only) vs Rust `str::trim()` (all
    Unicode whitespace) gap, under which a `"\t.+1w"`-style rule with a base
    after `range_end` would otherwise be wrongly dropped. Base-anchored forms
    never contain those substrings, so they are not falsely kept (no perf
    regression). Strict superset preserved.
- `src-tauri/src/commands/tests/agenda_cmd_tests.rs` — new sibling parity test
  `projected_agenda_prefilter_is_superset_2069`; the existing
  `projected_agenda_cached_equals_on_the_fly` is kept UNMODIFIED.
- `src-tauri/benches/interactive_slo.rs` — `bench_list_projected_agenda` doc /
  TODO updated to record the stale SQL-pushdown premise and the prefilter; the
  `problem_skipped` SLO gate is KEPT in place (nightly confirmation).
- Regenerated the `.sqlx` offline cache (`cargo sqlx prepare -- --tests`): the
  fallback SELECT is a compile-checked `sqlx::query_as!` macro, so the new
  `?2` parameter required a cache entry refresh.

## Verification

- `cargo test -p agaric --lib agenda` — 163 passed, 0 failed; includes the
  UNMODIFIED parity gate `projected_agenda_cached_equals_on_the_fly` and the
  new `projected_agenda_prefilter_is_superset_2069`.
- The new test fixture is engineered to catch a bad prefilter and asserts
  on-the-fly (prefiltered) == cache (full expansion) == an explicit
  order-stable expected set:
  - `.+1w` blocks whose base is AFTER `range_end` (2060-01-01) and FAR BEFORE
    `range_start` (2000-01-01) — both project into the window via
    today-anchoring and MUST appear. The after-range one is precisely the
    entry a naive `base <= range_end` filter would wrongly drop.
  - `++1w` block whose base is before `range_start` (2050-01-01) — catches up
    into the window and MUST appear.
  - `weekly` block whose base is strictly AFTER `range_end` (2052-01-01) —
    base-anchored beyond the window, correctly ABSENT.
  - `+3d` block whose base is before the window (2050-04-01) with a repeat
    that lands inside — present.
  - boundary: a `weekly` base (2051-03-30) whose first shift lands EXACTLY on
    `range_end` (2051-04-06) — exercises the inclusive `<= range_end` bound.
  Confirmed the test FAILS when the prefilter is degraded to a naive
  `base <= range_end` (drops the today-anchored after-range blocks), then
  passes again with the today-anchored clause restored.
- `cargo clippy -p agaric --lib --tests -- -D warnings` — clean.
- `cargo fmt -p agaric -- --check` — clean.
- `cargo check -p agaric --bench interactive_slo` — compiles.

Proof of superset (no valid occurrence can be dropped): for base-anchored
rules the first occurrence is the base date and the series only moves forward,
so a base `> range_end` can never reach the window — safe to drop. For
today-anchored rules (`.+` starts from `today`; `++` starts from the catch-up
date `> today`), the base date is irrelevant to window membership, so they are
ALWAYS kept regardless of base. The filter therefore only ever removes blocks
whose entire forward series begins past `range_end`, which the full expansion
would also yield nothing for — parity proves it.

Note: the issue's "push the date-range projection into SQL" premise is stale —
the recurrence grammar is stateful Rust and cannot move into SQL. The
`bench_list_projected_agenda` `problem_skipped` SLO gate is kept in place; the
100K release bench is not runnable in the dev sandbox, so SLO confirmation
under budget is deferred to the nightly bench lane.
