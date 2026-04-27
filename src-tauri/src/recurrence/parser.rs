//! Pure date-math and rule-string parsing for recurrence.
//!
//! No DB access, no async. All functions are deterministic given their
//! inputs (except `shift_date` with `.+` / `++` modes, which consult
//! `chrono::Local::now()`).

use chrono::Datelike;

/// MAINT-152(b) — calendar-range bound for `+Nm` / `+Ny` shifts.
///
/// Shifts that resolve to a year outside `MIN_CALENDAR_YEAR..=MAX_CALENDAR_YEAR`
/// return `None` instead of producing garbage dates. The bound is deliberately
/// loose; it exists to guard against pathological input (e.g. `+99999999y`
/// underflowing/overflowing the i64 month arithmetic), not to enforce a
/// product-level calendar range.
const MIN_CALENDAR_YEAR: i64 = 1900;
const MAX_CALENDAR_YEAR: i64 = 2200;

/// Return the number of days in the given month of the given year.
pub(super) fn days_in_month(year: i32, month: u32) -> u32 {
    chrono::NaiveDate::from_ymd_opt(
        if month == 12 { year + 1 } else { year },
        if month == 12 { 1 } else { month + 1 },
        1,
    )
    .map(|d| d.pred_opt().unwrap().day())
    .unwrap_or(28)
}

/// MAINT-152(b) — shift `base` by `n_months` months, clamping the resulting
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

    let total_months = (year as i64)
        .checked_mul(12)?
        .checked_add(month as i64 - 1)?
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
        "daily" => base + chrono::Duration::days(1),
        "weekly" => base + chrono::Duration::days(7),
        "monthly" => {
            let new_month = if month == 12 { 1 } else { month + 1 };
            let new_year = if month == 12 { year + 1 } else { year };
            let max_day = days_in_month(new_year, new_month);
            chrono::NaiveDate::from_ymd_opt(new_year, new_month, day.min(max_day))?
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
            // M-79: Org-mode recurrence semantics never go backwards (and
            // a zero interval would either no-op or, in `++` mode, loop
            // until the safety limit). Reject negative and zero counts at
            // parse time.
            if n <= 0 {
                return None;
            }
            match unit {
                "d" => base + chrono::Duration::days(n),
                "w" => base + chrono::Duration::days(n * 7),
                // MAINT-152(b): `+Nm` and `+Ny` share the leap-day-clamping
                // month arithmetic via `shift_by_months`; the `y` arm just
                // multiplies by 12 first. M-80: `+1y` from 2024-02-29 lands
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

/// Shift a `YYYY-MM-DD` date string by a recurrence interval.
///
/// Supported mode prefixes:
/// - (none) or `+` — shift from the original date once (default)
/// - `.+` — shift from today's date (completion-based recurrence)
/// - `++` — shift from the original date repeatedly until result > today
///
/// Supported intervals (after prefix):
/// - `daily`  — every day
/// - `weekly` — every 7 days
/// - `monthly` — every month (same day-of-month, clamped)
/// - `+Nd` / `Nd` — every N days
/// - `+Nw` / `Nw` — every N weeks
/// - `+Nm` / `Nm` — every N months
/// - `+Ny` / `Ny` — every N years (clamped on Feb 29 → Feb 28)
pub(crate) fn shift_date(date: &str, rule: &str) -> Option<String> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let year: i32 = parts[0].parse().ok()?;
    let month: u32 = parts[1].parse().ok()?;
    let day: u32 = parts[2].parse().ok()?;

    let original = chrono::NaiveDate::from_ymd_opt(year, month, day)?;
    let today = chrono::Local::now().date_naive();

    let trimmed = rule.trim().to_lowercase();

    // Determine mode and strip prefix
    let (mode, interval) = if let Some(rest) = trimmed.strip_prefix(".+") {
        ("dot_plus", rest)
    } else if let Some(rest) = trimmed.strip_prefix("++") {
        ("plus_plus", rest)
    } else {
        // Default mode: `+` prefix or bare keyword
        ("default", trimmed.as_str())
    };

    let shifted = match mode {
        "dot_plus" => {
            // Shift from today, not from the original date
            shift_date_once(today, interval)?
        }
        "plus_plus" => {
            // Keep shifting from original until result > today
            let mut current = original;
            // Safety limit to avoid infinite loops on bad data
            for _ in 0..10_000 {
                current = shift_date_once(current, interval)?;
                if current > today {
                    break;
                }
            }
            current
        }
        _ => {
            // Default: shift from original date once
            shift_date_once(original, interval)?
        }
    };

    Some(shifted.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests_m80 {
    //! Table-driven tests for M-80: `+Ny` (yearly) recurrence support.

    use super::shift_date;

    #[test]
    fn shift_date_yearly_table() {
        // (input_date, rule, expected_result, description)
        let cases: &[(&str, &str, Option<&str>, &str)] = &[
            // Plain yearly shift on a non-leap-edge date
            (
                "2025-04-26",
                "+1y",
                Some("2026-04-26"),
                "+1y from 2025-04-26 → 2026-04-26",
            ),
            // Leap day → next non-leap year clamps to Feb 28
            (
                "2024-02-29",
                "+1y",
                Some("2025-02-28"),
                "+1y from 2024-02-29 (leap) → 2025-02-28 (no Feb 29 in 2025)",
            ),
            // Leap day → next leap year keeps Feb 29
            (
                "2028-02-29",
                "+4y",
                Some("2032-02-29"),
                "+4y from 2028-02-29 (leap) → 2032-02-29 (also leap)",
            ),
            (
                "2024-02-29",
                "+4y",
                Some("2028-02-29"),
                "+4y from 2024-02-29 (leap) → 2028-02-29 (also leap)",
            ),
            // Multi-year shift on a year-end date
            (
                "2025-12-31",
                "+2y",
                Some("2027-12-31"),
                "+2y from 2025-12-31 → 2027-12-31",
            ),
            // Zero count: matches `+0d`/`+0w`/`+0m` behaviour (returns None;
            // org-mode recurrence never goes "nowhere", per M-79).
            (
                "2025-04-26",
                "+0y",
                None,
                "+0y returns None (matches m/w/d zero-count behaviour)",
            ),
            // Negative count: matches `+-1d` etc., rejected at parse time.
            ("2025-04-26", "+-1y", None, "+-1y (negative) returns None"),
            // Malformed numeric portion
            (
                "2025-04-26",
                "+abcy",
                None,
                "+abcy (non-numeric count) returns None",
            ),
        ];

        for (date, rule, expected, desc) in cases {
            let actual = shift_date(date, rule);
            let expected_owned = expected.map(std::string::ToString::to_string);
            assert_eq!(actual, expected_owned, "{desc}");
        }
    }
}
