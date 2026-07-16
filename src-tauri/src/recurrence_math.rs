//! Pure recurrence date-math: interval shifting + per-block occurrence
//! projection. No DB access, no async, no `AppError` — deterministic
//! `chrono` math (the `.+`/`++` modes take `today` as a parameter rather
//! than consulting the clock, so even those are pure here).
//!
//! Lives BELOW the store layer (#2621) so `cache::projected_agenda` (store)
//! can project recurrence dates without reaching *up* into the app-layer
//! `recurrence` module, whose `compute` half is `CommandTx` / `LoroState` /
//! materializer-coupled. The `recurrence` module re-exports
//! [`shift_date_once`] and [`project_block_dates`] so
//! `crate::recurrence::…` call sites resolve unchanged; the `AppError`-typed
//! string wrapper `recurrence::parser::shift_date` stays up in `recurrence`
//! and calls [`shift_date_once`] downward.

use chrono::Datelike;

/// (b) — calendar-range bound for `+Nm` / `+Ny` shifts.
///
/// Shifts that resolve to a year outside `MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR`
/// return `None` instead of producing garbage dates. The bound is deliberately
/// loose; it exists to guard against pathological input (e.g. `+99999999y`
/// underflowing/overflowing the i64 month arithmetic), not to enforce a
/// product-level calendar range.
const MIN_CALENDAR_YEAR: i64 = 1900;
const MAX_CALENDAR_YEAR: i64 = 2200;

/// Return the number of days in the given month of the given year.
pub(crate) fn days_in_month(year: i32, month: u32) -> u32 {
    chrono::NaiveDate::from_ymd_opt(
        if month == 12 { year + 1 } else { year },
        if month == 12 { 1 } else { month + 1 },
        1,
    )
    .map_or(28, |d| d.pred_opt().unwrap().day())
}

/// (b) — return `date` only if its year is inside the
/// `MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR` guard rail; otherwise `None`.
///
/// The day/week arms (`daily`/`weekly`/`+Nd`/`+Nw`) use this to enforce the
/// same calendar-year bound that `shift_by_months` enforces for the month/year
/// arms, so a large count that lands outside `[1900, 2200]` returns `None`
/// instead of leaking an out-of-rail date.
fn in_calendar_rail(date: chrono::NaiveDate) -> Option<chrono::NaiveDate> {
    if (MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR).contains(&i64::from(date.year())) {
        Some(date)
    } else {
        None
    }
}

/// (b) — shift `base` forward by `n_days` calendar days using checked
/// arithmetic, returning `None` on `NaiveDate` overflow (instead of panicking)
/// and applying the `MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR` guard rail.
///
/// Shared by the `daily`/`weekly`/`+Nd`/`+Nw` arms. Mirrors `shift_by_months`:
/// checked arithmetic + the calendar-year bound, returning `None` rather than a
/// panic or an out-of-rail date.
fn shift_by_days(base: chrono::NaiveDate, n_days: i64) -> Option<chrono::NaiveDate> {
    let shifted = base.checked_add_signed(chrono::Duration::try_days(n_days)?)?;
    in_calendar_rail(shifted)
}

/// (b) — shift `base` by `n_months` months, clamping the resulting
/// day-of-month against the destination month length so e.g. shifting from
/// `2024-02-29` by 12 months lands on `2025-02-28`.
///
/// Shared by the `+Nm` arm (passes `n` directly) and the `+Ny` arm (passes
/// `n * 12`). Returns `None` if the shifted year falls outside the
/// `MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR` guard rail or the month
/// arithmetic overflows i64.
fn shift_by_months(base: chrono::NaiveDate, n_months: i64) -> Option<chrono::NaiveDate> {
    let year = base.year();
    let month = base.month();
    let day = base.day();

    let total_months = i64::from(year)
        .checked_mul(12)?
        .checked_add(i64::from(month) - 1)?
        .checked_add(n_months)?;
    let new_year_i64 = total_months.div_euclid(12);
    let new_month: u32 = u32::try_from(total_months.rem_euclid(12) + 1)
        .expect("invariant: rem_euclid(12) + 1 is in [1, 12]");
    if !(MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR).contains(&new_year_i64) {
        return None;
    }
    let new_year = i32::try_from(new_year_i64).ok()?;
    let max_day = days_in_month(new_year, new_month);
    chrono::NaiveDate::from_ymd_opt(new_year, new_month, day.min(max_day))
}

/// Shift a `YYYY-MM-DD` date string by a recurrence interval once from
/// the given base date.
///
/// Returns the shifted date or `None` if parsing fails.
pub(crate) fn shift_date_once(
    base: chrono::NaiveDate,
    interval: &str,
) -> Option<chrono::NaiveDate> {
    let year = base.year();
    let month = base.month();
    let day = base.day();

    let shifted = match interval {
        "daily" => shift_by_days(base, 1)?,
        "weekly" => shift_by_days(base, 7)?,
        "monthly" => {
            // #679: month-end clamp is INTENTIONALLY sticky (Org-mode
            // in-place shift semantics). We shift the *given base* by one
            // month and clamp the day-of-month against the destination
            // month's length (`day.min(max_day)`). Because each recurrence
            // step uses the PREVIOUS shifted date as its base (see
            // `compute.rs` sibling base = previous shifted date), the
            // original day-of-month is NOT restored once it has been
            // clamped: Jan-31 → Feb-28 → Mar-28 → Apr-28 … forever, never
            // back to day-31. This matches Org-mode's behavior, where the
            // repeater rewrites the timestamp in place and the clamped day
            // becomes the new anchor. Do NOT "fix" this to re-derive the
            // day from the series origin without changing the documented
            // contract and the chain test that pins it
            // (`monthly_clamp_is_sticky_three_step_chain` in tests.rs).
            let new_month = if month == 12 { 1 } else { month + 1 };
            let new_year = if month == 12 { year + 1 } else { year };
            let max_day = days_in_month(new_year, new_month);
            // (b): apply the same calendar-year guard rail as the month/year
            // arms so e.g. `2200-12-01 monthly` (which would roll to 2201)
            // returns `None` instead of leaking an out-of-rail date.
            in_calendar_rail(chrono::NaiveDate::from_ymd_opt(
                new_year,
                new_month,
                day.min(max_day),
            )?)?
        }
        _ => {
            // Parse +Nd, +Nw, +Nm patterns (the leading '+' is already stripped
            // by the caller for `.+` and `++` modes, but may still be present
            // for the default `+` mode).
            let num_unit = interval.strip_prefix('+').unwrap_or(interval);
            if num_unit.len() < 2 {
                return None;
            }
            let (num_str, unit) = num_unit.split_at(num_unit.len() - 1);
            let n: i64 = num_str.parse().ok()?;
            // Org-mode recurrence semantics never go backwards (and
            // a zero interval would either no-op or, in `++` mode, loop
            // until the safety limit). Reject negative and zero counts at
            // parse time.
            if n <= 0 {
                return None;
            }
            match unit {
                "d" => shift_by_days(base, n)?,
                // (b): guard `n * 7` against i64 overflow before handing the
                // day count to the checked day shift.
                "w" => shift_by_days(base, n.checked_mul(7)?)?,
                // (b): `+Nm` and `+Ny` share the leap-day-clamping
                // month arithmetic via `shift_by_months`; the `y` arm just
                // Multiplies by 12 first. `+1y` from 2024-02-29 lands
                // on 2025-02-28 because the helper clamps day against the
                // destination month length.
                "m" => shift_by_months(base, n)?,
                "y" => shift_by_months(base, n.checked_mul(12)?)?,
                _ => return None,
            }
        }
    };

    Some(shifted)
}

// --- Per-block occurrence projection (was recurrence/projection.rs) ---

/// Project one repeating block's occurrence dates within
/// `[range_start, range_end]`.
///
/// The caller decides what to do with each `(projected_date, source_name)`
/// tuple via `emit`. The helper itself owns the recurrence semantics:
///
/// - Trims and lowercases `repeat_rule`; empty / whitespace-only rules
///   produce zero emissions.
/// - Dispatches on the prefix:
///     * `.+` → `dot_plus` (completion-based — start advancing from
///       `today`).
///     * `++` → `plus_plus` (skip-past-today — start at the original
///       date, advance one step at a time until the result is strictly
///       greater than `today`, then pre-emit that caught-up date and
///       continue advancing).
///     * otherwise → `default` (shift from the original date).
/// - Pre-emits the caught-up date for `plus_plus` if it falls within
///   `[range_start, range_end]` and is not past `repeat_until`.
/// - 10 000-iteration safety bound per `(block, source)` so a
///   pathological rule cannot infinite-loop.
///   #680 / for `plus_plus`, if the catch-up loop exhausts
///   the safety bound (or `shift_date_once` overflows) WITHOUT reaching
///   a date strictly after `today`, the source is skipped entirely — no
///   occurrence is emitted. Emitting the stale past `current` would be a
///   silent data bug; this mirrors the string parser
///   (`parser::shift_date`), which raises `Err(AppError::Validation)`
///   for the identical input class.
/// - End conditions:
///     * `until_date` — stop once `current > until_date`.
///     * `remaining` — stop once we've produced `remaining` occurrences
///       of the **true series**. Each shift consumes one unit of the
///       budget regardless of whether the occurrence lands inside
///       `[range_start, range_end]` (#1550) and regardless of whether the
///       caller's `emit` closure accepted the entry, so the count
///       semantics track the real series position (and survive a cursor /
///       size-cap reject downstream). Counting only in-range emits let a
///       far-past-start recurrence advance through unbounded pre-range
///       steps for free and thus emit more in-range occurrences than
///       `repeat_count` implies.
/// - Range clipping:
///     * `current > range_end` → break (no more emissions can land).
///     * `current >= range_start` → emit; otherwise advance silently
///       and keep iterating. Either way the occurrence consumes one unit
///       of the `remaining` budget (see above).
/// - Materialization horizon (`max_emitted`, #2601): caps the number of
///   in-range occurrences EMITTED per source. `None` is unbounded (the
///   on-the-fly read path, which clips by the caller's query range
///   instead). The projected-agenda cache passes `Some(N)` so exactly the
///   next N future occurrences per source are materialized. Counted ONLY
///   on emit — never on a pre-`range_start` silent advance — so the number
///   of materialized future rows is exact no matter how far in the past
///   the base date sits (contrast `remaining`, which tracks series
///   position). With `max_emitted = Some(N)` and `range_end` set to a
///   far-future sentinel, the count is the sole horizon bound, so the
///   materialized calendar reach scales with cadence (daily ⇒ ~N days,
///   weekly ⇒ ~N weeks).
///
/// Source iteration order is fixed: `due_date` first, then
/// `scheduled_date`. Both the cache and on-the-fly paths previously
/// pushed in this order, so preserving it here keeps the parity test
/// observable.
///
/// `remaining` is pre-computed by the caller from
/// `repeat_count - repeat_seq` (see callsites). `None` means unbounded.
///
/// # Drift notes
///
/// The two pre-refactor callsites diverged on one subtle detail:
/// the cache previously clipped emissions against `today..horizon`
/// (`if current >= today && current <= horizon`) while the on-the-fly
/// path clipped against `range_start..range_end`. For a `dot_plus`
/// rule like `.+1w` starting at `today`, the first emit happens on the
/// **next** week boundary (because the loop shifts before the
/// emit-check), so a difference in clip boundary by even one day at
/// either end produces a 1-2 entry drift in long windows. The new
/// shared signature pushes the clip boundaries onto the caller —
/// since #2601 the cache passes `range_start = today`, a far-future
/// `range_end` sentinel, and `max_emitted = Some(HORIZON_OCCURRENCES)`
/// (so a fixed occurrence count, not a calendar window, bounds it), while
/// the on-the-fly path passes its caller-supplied range and `max_emitted =
/// None` — so both paths see one set of bounds and one comparator.
//
// `too_many_arguments` is deliberate here: each argument corresponds to
// one columnar input the two callsites already destructure off
// `RepeatingBlockRow` / `CacheRepeatingRow`. Wrapping them in a struct
// would just move the boilerplate elsewhere without changing the
// shape — both callsites pass every field. The shared-helper contract
// is meant to be the loud signature, not a hidden struct.
#[allow(clippy::too_many_arguments)]
pub(crate) fn project_block_dates<F>(
    due_date: Option<&str>,
    scheduled_date: Option<&str>,
    repeat_rule: &str,
    repeat_until: Option<chrono::NaiveDate>,
    remaining: Option<usize>,
    today: chrono::NaiveDate,
    range_start: chrono::NaiveDate,
    range_end: chrono::NaiveDate,
    max_emitted: Option<usize>,
    mut emit: F,
) where
    F: FnMut(chrono::NaiveDate, &'static str),
{
    let trimmed_rule = repeat_rule.trim().to_lowercase();
    if trimmed_rule.is_empty() {
        return;
    }

    // Parse mode and interval from the rule string. The interval is a
    // borrow into `trimmed_rule` so we keep `trimmed_rule` alive for
    // the duration of the projection.
    let (mode, interval) = if let Some(rest) = trimmed_rule.strip_prefix(".+") {
        ("dot_plus", rest)
    } else if let Some(rest) = trimmed_rule.strip_prefix("++") {
        ("plus_plus", rest)
    } else {
        ("default", trimmed_rule.as_str())
    };

    // Source iteration: due_date, then scheduled_date. Fixed order so
    // both callsites observe the same emission sequence (the cache's
    // `INSERT OR IGNORE` and the on-the-fly's BTreeMap dedupe both
    // tolerate duplicates, but a fixed source order keeps the cap /
    // cursor pagination deterministic when `remaining` cuts mid-source).
    let sources: [(Option<&str>, &'static str); 2] =
        [(due_date, "due_date"), (scheduled_date, "scheduled_date")];

    for (date_opt, source_name) in sources {
        let Some(date_str) = date_opt else { continue };
        let Ok(base) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") else {
            continue;
        };

        // Determine the starting point based on mode.
        let mut current = match mode {
            "dot_plus" => today,
            "plus_plus" => {
                // Advance from `base` one step at a time until strictly
                // greater than today. The caught-up date is pre-emitted
                // below, then the main loop continues from it.
                //
                // #680 / the catch-up can fail to reach a
                // future date in two ways — the 10 000-step budget
                // elapses without `c > today` (e.g. `++1d` against an
                // `original` decades in the past), or `shift_date_once`
                // returns `None` mid-loop (single-step `NaiveDate`
                // arithmetic overflow). In either case `c` is left as a
                // STALE PAST date. Pre-fix, the pre-emit block below and
                // the main loop still ran against that stale date, so the
                // projection silently emitted a past occurrence.
                //
                // The string parser (`parser::shift_date`) treats this
                // SAME input class as a hard `Err(AppError::Validation)`
                // ("cap exceeded" / "arithmetic overflow"). This
                // emit-driven projection has no error channel, so the
                // consistent "loud failure" here is to SKIP the source
                // entirely: produce no occurrence rather than a stale one.
                // We track whether we actually caught up and `continue`
                // to the next source when we did not.
                let mut c = base;
                let mut caught_up = false;
                for _ in 0..10_000 {
                    c = match shift_date_once(c, interval) {
                        Some(d) => d,
                        // Single-step overflow: cannot reach a valid
                        // future date, so abandon this source rather than
                        // emitting the stale `c`.
                        None => break,
                    };
                    if c > today {
                        caught_up = true;
                        break;
                    }
                }
                if !caught_up {
                    // Cap exhausted or overflow without `c > today`: skip
                    // emission (mirrors the parser's `Err(Validation)`).
                    continue;
                }
                c
            }
            _ => base,
        };

        let mut projected_count = 0usize;
        let max_remaining = remaining.unwrap_or(usize::MAX);
        // Materialization-horizon cap (#2601). Counts occurrences actually
        // EMITTED (in-range, i.e. `>= range_start`), independently of the
        // `remaining` series-position budget above. The projected-agenda
        // cache passes `Some(HORIZON_OCCURRENCES)` so exactly the next N
        // future occurrences per source are materialized; the on-the-fly
        // path passes `None` (it clips by the caller's query range instead).
        // Unlike `remaining`, this budget is NOT consumed by pre-range
        // silent advances, so the count of materialized *future* rows is
        // exact regardless of how far in the past the base date sits.
        let mut emitted_count = 0usize;
        let emit_budget = max_emitted.unwrap_or(usize::MAX);

        // For `++` mode, pre-emit the caught-up date itself when it is not
        // past `until_date` and lands within `range_end`. The main loop
        // shifts before emit-checking, so without this pre-emit the
        // caught-up date would be silently skipped.
        //
        // The caught-up date is the first real occurrence of the series, so
        // it consumes one unit of the `remaining` (repeat-count) budget even
        // when it falls before `range_start` (#1550: budget tracks the true
        // series, not just the in-range window). The `emit` itself stays
        // gated on the full `[range_start, range_end]` check.
        if mode == "plus_plus" && projected_count < max_remaining && current <= range_end {
            let past_until = repeat_until.is_some_and(|until| current > until);
            if !past_until {
                if current >= range_start {
                    emit(current, source_name);
                    emitted_count += 1;
                }
                projected_count += 1;
            }
        }

        // Main projection loop with the 10 000-step safety bound.
        for _ in 0..10_000 {
            if projected_count >= max_remaining {
                break;
            }
            // Materialization-horizon cap: stop once the next N future
            // occurrences have been emitted (#2601). No-op when the caller
            // passes `max_emitted = None` (`emit_budget = usize::MAX`).
            if emitted_count >= emit_budget {
                break;
            }

            current = match shift_date_once(current, interval) {
                Some(d) => d,
                None => break,
            };

            if let Some(until) = repeat_until
                && current > until
            {
                break;
            }

            if current > range_end {
                break;
            }

            // Every shift produces one occurrence of the true series, so
            // it consumes one unit of the `remaining` (repeat-count) budget
            // regardless of whether it lands inside `[range_start,
            // range_end]`. Counting only in-range emits (the pre-fix
            // behaviour, #1550) let a far-past-start recurrence advance
            // through unbounded pre-range steps without spending the
            // budget, so it could emit MORE in-range occurrences than
            // `repeat_count` implies. The `emit` itself stays gated on the
            // range check — only the in-range tuples are surfaced — but the
            // count now reflects the real series position.
            projected_count += 1;
            if current >= range_start {
                emit(current, source_name);
                emitted_count += 1;
            }
        }
    }
}
