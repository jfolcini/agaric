//! Pure date-math and rule-string parsing for recurrence.
//!
//! No DB access, no async. All functions are deterministic given their
//! inputs (except `shift_date` with `.+` / `++` modes, which consult
//! `chrono::Local::now()`).

use chrono::Datelike;

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
            match unit {
                "d" => base + chrono::Duration::days(n),
                "w" => base + chrono::Duration::days(n * 7),
                "m" => {
                    let total_months = (year as i64)
                        .checked_mul(12)?
                        .checked_add(month as i64 - 1)?
                        .checked_add(n)?;
                    let new_year_i64 = total_months.div_euclid(12);
                    // rem_euclid(12) + 1 is in [1, 12]; always fits in u32
                    #[allow(clippy::cast_possible_truncation)]
                    let new_month = (total_months.rem_euclid(12) + 1) as u32;
                    // Clamp to a reasonable calendar range; return None for
                    // extreme values instead of producing garbage dates.
                    if !(1900..=2200).contains(&new_year_i64) {
                        return None;
                    }
                    let new_year = i32::try_from(new_year_i64).ok()?;
                    let max_day = days_in_month(new_year, new_month);
                    chrono::NaiveDate::from_ymd_opt(new_year, new_month, day.min(max_day))?
                }
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
