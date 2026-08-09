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
pub fn days_in_month(year: i32, month: u32) -> u32 {
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

/// Why a single recurrence shift produced no date (#3281).
///
/// [`shift_date_once`] collapses both causes into `None`, which is fine for
/// the `+` / `.+` prefix arms (both treat any failure as "skip the shift
/// silently"). The `++` arm must tell them apart: a malformed rule is user
/// input to be ignored, while a genuine arithmetic dead-end is a real error
/// worth aborting on. Conflating them made `++2weeks` — a typo for `++2w` —
/// report "arithmetic overflow" and roll back the completion transaction, so
/// the task could never be marked DONE.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShiftFailure {
    /// The interval string is malformed: unknown keyword, unknown unit
    /// letter, non-numeric or non-positive count, or too short to split.
    /// The caller should treat this as "no shift requested".
    Interval,
    /// The interval parsed fine, but the date arithmetic overflowed `i64` /
    /// `NaiveDate`, or the result left the
    /// `MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR` guard rail.
    Overflow,
}

/// Shift `base` by one recurrence interval, distinguishing the two failure
/// causes (#3281).
///
/// This is the kernel; [`shift_date_once`] is the `Option`-shaped wrapper
/// kept for the call sites that do not care which cause fired.
pub fn try_shift_date_once(
    base: chrono::NaiveDate,
    interval: &str,
) -> Result<chrono::NaiveDate, ShiftFailure> {
    let year = base.year();
    let month = base.month();
    let day = base.day();

    // Every arithmetic dead-end below is an `Overflow`; every rejected
    // *shape* is an `Interval`.
    let ovf = || ShiftFailure::Overflow;

    let shifted = match interval {
        "daily" => shift_by_days(base, 1).ok_or_else(ovf)?,
        "weekly" => shift_by_days(base, 7).ok_or_else(ovf)?,
        // #3281: `yearly` is advertised by the UI vocabulary — the
        // `/repeat-yearly` slash command writes the bare string `yearly` into
        // the `repeat` property and `repeat.yearly` is a first-class i18n
        // label — but had no arm here, so the shift silently no-opped and
        // produced a dateless sibling. Delegates to the same
        // leap-day-clamping month arithmetic as `+1y`.
        "yearly" => shift_by_months(base, 12).ok_or_else(ovf)?,
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
            // fails instead of leaking an out-of-rail date.
            in_calendar_rail(
                chrono::NaiveDate::from_ymd_opt(new_year, new_month, day.min(max_day))
                    .ok_or_else(ovf)?,
            )
            .ok_or_else(ovf)?
        }
        _ => {
            // Parse +Nd, +Nw, +Nm patterns (the leading '+' is already stripped
            // by the caller for `.+` and `++` modes, but may still be present
            // for the default `+` mode).
            let num_unit = interval.strip_prefix('+').unwrap_or(interval);
            if num_unit.len() < 2 {
                return Err(ShiftFailure::Interval);
            }
            let (num_str, unit) = num_unit.split_at(num_unit.len() - 1);
            // #3281: a count that does not parse is a MALFORMED RULE, not an
            // arithmetic overflow — `++2weeks` splits into `"2week"` / `"s"`
            // and lands here.
            let Ok(n) = num_str.parse::<i64>() else {
                return Err(ShiftFailure::Interval);
            };
            // Org-mode recurrence semantics never go backwards (and
            // a zero interval would either no-op or, in `++` mode, loop
            // until the safety limit). Reject negative and zero counts at
            // parse time.
            if n <= 0 {
                return Err(ShiftFailure::Interval);
            }
            match unit {
                "d" => shift_by_days(base, n).ok_or_else(ovf)?,
                // (b): guard `n * 7` against i64 overflow before handing the
                // day count to the checked day shift.
                "w" => shift_by_days(base, n.checked_mul(7).ok_or_else(ovf)?).ok_or_else(ovf)?,
                // (b): `+Nm` and `+Ny` share the leap-day-clamping
                // month arithmetic via `shift_by_months`; the `y` arm just
                // multiplies by 12 first. `+1y` from 2024-02-29 lands
                // on 2025-02-28 because the helper clamps day against the
                // destination month length.
                "m" => shift_by_months(base, n).ok_or_else(ovf)?,
                "y" => shift_by_months(base, n.checked_mul(12).ok_or_else(ovf)?).ok_or_else(ovf)?,
                _ => return Err(ShiftFailure::Interval),
            }
        }
    };

    Ok(shifted)
}

/// Shift a `YYYY-MM-DD` date string by a recurrence interval once from
/// the given base date.
///
/// Returns the shifted date or `None` if parsing fails or the arithmetic
/// dead-ends. Use [`try_shift_date_once`] when the two causes must be told
/// apart (#3281).
pub fn shift_date_once(base: chrono::NaiveDate, interval: &str) -> Option<chrono::NaiveDate> {
    try_shift_date_once(base, interval).ok()
}

// --- Rule-string normalization + mode split (one definition, #3647) ---

/// Normalize a raw `repeat` property value the way EVERY consumer does
/// before parsing it: trim surrounding whitespace, lowercase.
///
/// (#3647) Extracted so the write-time validator, the completion-time
/// string shifter (`agaric_engine::recurrence::shift_date`) and the
/// read-time projector ([`project_block_dates`]) cannot disagree about what
/// "the same rule" is. All three previously spelled `rule.trim().to_lowercase()`
/// inline.
#[must_use]
pub fn normalize_repeat_rule(rule: &str) -> String {
    rule.trim().to_lowercase()
}

/// Mode tag for the `.+` anchoring prefix (shift from today / completion).
pub const REPEAT_MODE_DOT_PLUS: &str = "dot_plus";
/// Mode tag for the `++` anchoring prefix (catch up past today).
pub const REPEAT_MODE_PLUS_PLUS: &str = "plus_plus";
/// Mode tag for a rule with no anchoring prefix (shift from the base date).
pub const REPEAT_MODE_DEFAULT: &str = "default";

/// Split a NORMALIZED rule (see [`normalize_repeat_rule`]) into its
/// anchoring-mode tag and the interval that follows it.
///
/// (#3647) The single definition of the prefix grammar. Note the `+` of a
/// plain `+Nd` rule is deliberately NOT stripped here — it belongs to the
/// interval and [`try_shift_date_once`] strips it itself — so only the two
/// two-character anchoring prefixes are recognised.
#[must_use]
pub fn split_repeat_rule(normalized: &str) -> (&'static str, &str) {
    if let Some(rest) = normalized.strip_prefix(".+") {
        (REPEAT_MODE_DOT_PLUS, rest)
    } else if let Some(rest) = normalized.strip_prefix("++") {
        (REPEAT_MODE_PLUS_PLUS, rest)
    } else {
        (REPEAT_MODE_DEFAULT, normalized)
    }
}

// --- Write-time rule validation (#3647) ---

/// Probe base date used to run the real interval parser during validation.
///
/// Mid-calendar-rail, first-of-month, non-leap-sensitive: no shape-valid
/// interval can be rejected here for a *date* reason that another base date
/// would accept. It does not need to be — [`try_shift_date_once`] returns
/// [`ShiftFailure::Interval`] purely as a function of the interval STRING
/// (every such `return` is inside the string-shape branch, never the
/// arithmetic branch), and
/// `repeat_rule_shape_tests::probe_verdict_is_base_independent` pins that.
const REPEAT_PROBE: (i32, u32, u32) = (2000, 1, 1);

/// Why a `repeat` rule was rejected by [`validate_repeat_rule_shape`].
///
/// **Explanation only.** These variants never decide validity — the verdict
/// always comes from [`try_shift_date_once`], the same parser recurrence runs
/// at completion and projection time. Classification runs only *after* the
/// parser has already rejected the rule, purely to turn "invalid" into
/// something the user can act on. A bug here can make a message unhelpful; it
/// cannot make a good rule fail or a bad rule pass.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepeatRuleProblem {
    /// The whole rule is empty or whitespace-only.
    Empty,
    /// An anchoring prefix (`.+` / `++`) with nothing after it.
    MissingInterval,
    /// The interval contains whitespace (`++ 1d` — a very common typo, and
    /// one the drawer's free-text `<Input>` invites).
    InternalWhitespace,
    /// A bare keyword carrying a `+` (`+daily`). The keyword arms match the
    /// bare form only.
    KeywordWithPlus,
    /// `+0d` / `-3w` — Org-mode recurrence never stands still or goes back.
    NonPositiveCount,
    /// The count parsed but the trailing unit letter is not `d`/`w`/`m`/`y`.
    UnknownUnit,
    /// Anything else: junk, a float count, a missing count (`+d`).
    Unparseable,
}

impl RepeatRuleProblem {
    /// A short human reason, phrased to complete
    /// "repeat rule '…' is not valid: **{hint}**".
    #[must_use]
    pub fn hint(self) -> &'static str {
        match self {
            RepeatRuleProblem::Empty => "the rule is empty",
            RepeatRuleProblem::MissingInterval => {
                "the `.+` / `++` prefix is not followed by an interval"
            }
            RepeatRuleProblem::InternalWhitespace => {
                "it contains a space — write `++1d`, not `++ 1d`"
            }
            RepeatRuleProblem::KeywordWithPlus => {
                "the plain keywords take no `+` — write `daily`, or `+1d` for the numeric form"
            }
            RepeatRuleProblem::NonPositiveCount => "the count must be 1 or more",
            RepeatRuleProblem::UnknownUnit => "the unit must be one of d, w, m, y",
            RepeatRuleProblem::Unparseable => "the interval is not a keyword or a `+N<unit>` count",
        }
    }
}

/// Classify an interval the parser has ALREADY rejected. Explanation only —
/// see [`RepeatRuleProblem`].
fn classify_rejected_interval(interval: &str) -> RepeatRuleProblem {
    if interval.is_empty() {
        return RepeatRuleProblem::MissingInterval;
    }
    if interval.chars().any(char::is_whitespace) {
        return RepeatRuleProblem::InternalWhitespace;
    }
    let num_unit = interval.strip_prefix('+').unwrap_or(interval);
    if num_unit != interval && matches!(num_unit, "daily" | "weekly" | "monthly" | "yearly") {
        return RepeatRuleProblem::KeywordWithPlus;
    }
    if num_unit.len() >= 2 {
        // Same split the parser uses; only the count is inspected here —
        // if it parses, the trailing unit letter is by elimination what
        // `try_shift_date_once` rejected.
        let (num_str, _unit) = num_unit.split_at(num_unit.len() - 1);
        if let Ok(n) = num_str.parse::<i64>() {
            return if n <= 0 {
                RepeatRuleProblem::NonPositiveCount
            } else {
                // The count is fine, so the unit is what the parser choked on.
                RepeatRuleProblem::UnknownUnit
            };
        }
    }
    RepeatRuleProblem::Unparseable
}

/// Is `rule` a well-formed `repeat` rule? (#3647)
///
/// # How this is guaranteed to agree with the real grammar
///
/// It does not re-describe the grammar. It normalizes and splits the rule
/// with the SAME two helpers the shifter and the projector use
/// ([`normalize_repeat_rule`] / [`split_repeat_rule`]) and then hands the
/// interval to [`try_shift_date_once`] — the production parser — and reads
/// its verdict. Adding an interval form to the parser makes it valid here
/// automatically; there is no second table to keep in sync.
///
/// Only [`ShiftFailure::Interval`] — a rejected *shape* — is a malformed
/// rule. [`ShiftFailure::Overflow`] means the rule parsed and the date
/// arithmetic dead-ended for this particular base date (`+199y` from 2050
/// leaves the calendar rail), which is a property of the date, not of the
/// grammar; rejecting it at write time would refuse rules that are perfectly
/// usable from a different base date.
///
/// # Errors
///
/// [`RepeatRuleProblem`] describing what is wrong, for the message.
pub fn validate_repeat_rule_shape(rule: &str) -> Result<(), RepeatRuleProblem> {
    let normalized = normalize_repeat_rule(rule);
    if normalized.is_empty() {
        return Err(RepeatRuleProblem::Empty);
    }
    let (_mode, interval) = split_repeat_rule(&normalized);
    let probe = chrono::NaiveDate::from_ymd_opt(REPEAT_PROBE.0, REPEAT_PROBE.1, REPEAT_PROBE.2)
        .expect("invariant: REPEAT_PROBE is a real calendar date");
    match try_shift_date_once(probe, interval) {
        Ok(_) | Err(ShiftFailure::Overflow) => Ok(()),
        Err(ShiftFailure::Interval) => Err(classify_rejected_interval(interval)),
    }
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
pub fn project_block_dates<F>(
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
    let trimmed_rule = normalize_repeat_rule(repeat_rule);
    if trimmed_rule.is_empty() {
        return;
    }

    // Parse mode and interval from the rule string. The interval is a
    // borrow into `trimmed_rule` so we keep `trimmed_rule` alive for
    // the duration of the projection.
    // (#3647) The split is the shared [`split_repeat_rule`] — the same one
    // `shift_date` and `validate_repeat_rule_shape` use, so the write-time
    // gate cannot accept a prefix this projector would not.
    let (mode, interval) = split_repeat_rule(&trimmed_rule);

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
            REPEAT_MODE_DOT_PLUS => today,
            REPEAT_MODE_PLUS_PLUS => {
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
        if mode == REPEAT_MODE_PLUS_PLUS && projected_count < max_remaining && current <= range_end
        {
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

#[cfg(test)]
mod repeat_rule_shape_tests {
    //! (#3647) Tests for the write-time grammar gate.
    //!
    //! The gate's whole design claim is that it does not own a grammar — it
    //! asks [`try_shift_date_once`]. These tests pin the two things that
    //! claim depends on (the probe date is irrelevant to the verdict; an
    //! arithmetic dead-end is not a grammar error) plus the message
    //! classification. The end-to-end "the validator accepts exactly what
    //! recurrence honours" differential lives one layer up, in
    //! `agaric_engine::recurrence::parser`, where both the string shifter and
    //! the projector are visible.

    use super::{
        RepeatRuleProblem, ShiftFailure, normalize_repeat_rule, split_repeat_rule,
        try_shift_date_once, validate_repeat_rule_shape,
    };

    /// Rules spanning the whole grammar plus a spread of malformed shapes.
    /// Reused by several tests below.
    const CORPUS: &[&str] = &[
        // valid
        "daily",
        "weekly",
        "monthly",
        "yearly",
        "1d",
        "+1d",
        "+3d",
        "+2w",
        "+6m",
        "+1y",
        "12w",
        ".+daily",
        ".+weekly",
        ".+monthly",
        ".+yearly",
        ".+1d",
        ".+3w",
        "++daily",
        "++weekly",
        "++monthly",
        "++yearly",
        "++2w",
        "++10d",
        // malformed
        "",
        "   ",
        "+",
        "++",
        ".+",
        "+daily",
        "++ 1d",
        ".+ weekly",
        "2 w",
        "+0d",
        "-1d",
        "+-3w",
        "3.5d",
        "5x",
        "w",
        "+d",
        "invalid",
        "++2weeks",
        "FREQ=DAILY",
    ];

    /// The probe date in [`super::REPEAT_PROBE`] is only sound if the
    /// `Interval` (shape) verdict does not depend on the base date. Every
    /// `Err(ShiftFailure::Interval)` in `try_shift_date_once` sits in a
    /// string-shape branch, so it must not — pin that, because if it ever
    /// stops being true the validator silently starts accepting or rejecting
    /// rules based on an arbitrary constant.
    #[test]
    fn probe_verdict_is_base_independent() {
        let bases = [
            (2000, 1, 1),
            (1900, 1, 1),
            (2024, 2, 29),
            (2200, 12, 31),
            (2100, 6, 15),
        ];
        for rule in CORPUS {
            let normalized = normalize_repeat_rule(rule);
            let (_mode, interval) = split_repeat_rule(&normalized);
            let verdicts: Vec<bool> = bases
                .iter()
                .map(|&(y, m, d)| {
                    let base = chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap();
                    matches!(
                        try_shift_date_once(base, interval),
                        Err(ShiftFailure::Interval)
                    )
                })
                .collect();
            assert!(
                verdicts.windows(2).all(|w| w[0] == w[1]),
                "shape verdict for `{rule}` varies by base date ({verdicts:?}) — \
                 the single-probe validator is unsound"
            );
        }
    }

    /// An arithmetic dead-end is NOT a grammar error. `+199y` is a
    /// well-formed rule that overflows the calendar rail from a 2050 base and
    /// works fine from a 1950 one; rejecting it at write time would refuse a
    /// rule the engine can honour.
    #[test]
    fn arithmetic_overflow_is_not_a_grammar_error() {
        for rule in ["+199y", "+9999m", "++500y", ".+2000w"] {
            assert!(
                validate_repeat_rule_shape(rule).is_ok(),
                "`{rule}` parses as a rule — an out-of-rail RESULT is a date \
                 property, not a malformed grammar"
            );
        }
        // …and the probe really does overflow on at least one of them, so the
        // test is exercising the `Err(Overflow) => Ok(())` arm rather than
        // passing vacuously.
        let probe = chrono::NaiveDate::from_ymd_opt(2000, 1, 1).unwrap();
        assert_eq!(
            try_shift_date_once(probe, "9999m"),
            Err(ShiftFailure::Overflow),
            "expected the probe to hit the calendar rail for `9999m`"
        );
    }

    /// Every rejected rule gets the classification its message needs. These
    /// are explanation only — the reject/accept split is asserted elsewhere;
    /// here we only check the reason handed to the user.
    #[test]
    fn rejected_rules_are_classified_for_the_message() {
        let cases: &[(&str, RepeatRuleProblem)] = &[
            ("", RepeatRuleProblem::Empty),
            ("   ", RepeatRuleProblem::Empty),
            ("++", RepeatRuleProblem::MissingInterval),
            (".+", RepeatRuleProblem::MissingInterval),
            ("++ 1d", RepeatRuleProblem::InternalWhitespace),
            (".+ weekly", RepeatRuleProblem::InternalWhitespace),
            ("+daily", RepeatRuleProblem::KeywordWithPlus),
            ("+yearly", RepeatRuleProblem::KeywordWithPlus),
            ("+0d", RepeatRuleProblem::NonPositiveCount),
            ("-1d", RepeatRuleProblem::NonPositiveCount),
            ("5x", RepeatRuleProblem::UnknownUnit),
            ("12q", RepeatRuleProblem::UnknownUnit),
            ("3.5d", RepeatRuleProblem::Unparseable),
            ("++2weeks", RepeatRuleProblem::Unparseable),
            ("invalid", RepeatRuleProblem::Unparseable),
            ("w", RepeatRuleProblem::Unparseable),
        ];
        for (rule, expected) in cases {
            assert_eq!(
                validate_repeat_rule_shape(rule),
                Err(*expected),
                "wrong reason for `{rule}`"
            );
            assert!(
                !expected.hint().is_empty(),
                "every problem must carry a hint"
            );
        }
    }

    /// Normalization is part of the contract: a rule the user typed with
    /// surrounding whitespace or in capitals is the same rule.
    #[test]
    fn surrounding_whitespace_and_case_are_normalized_not_rejected() {
        for rule in ["  daily  ", "DAILY", "  ++2W", "\t.+Monthly\n"] {
            assert!(
                validate_repeat_rule_shape(rule).is_ok(),
                "`{rule}` must normalize to a valid rule (the shifter and the \
                 projector both normalize the same way)"
            );
        }
    }
}
