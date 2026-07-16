//! Recurrence rule-string parsing — the `AppError`-typed string wrapper.
//!
//! No DB access, no async. `shift_date` is deterministic given its inputs
//! except the `.+` / `++` modes, which consult `chrono::Local::now()`.
//!
//! The pure interval-shift math it builds on ([`shift_date_once`] and the
//! calendar-rail helpers) lives one layer down in [`crate::recurrence_math`]
//! (#2621) so the store-layer projection path can reuse it without depending
//! on this app-layer module.

use crate::error::AppError;
use crate::recurrence_math::shift_date_once;

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
///
/// # Return type
///
/// Returns `Result<Option<String>, AppError>` so the three failure modes
/// stay distinguishable at the call site:
///
/// * `Ok(Some(date))` — shift succeeded.
/// * `Ok(None)` — input could not be parsed (malformed `date`, malformed
///   `rule`, zero/negative count, unknown unit). These are user-input
///   shape errors that the caller already treats as "skip the shift
///   silently"; preserving the `None` channel keeps that contract.
/// * `Err(AppError::Validation)` — the `++` arm hit one of two
///   distinct dead-ends that previously returned silent garbage:
///   **:** `shift_date_once` returned `None` mid-loop
///   (i.e. a `NaiveDate` arithmetic overflow on a single shift).
///   The pre-fix `?` propagation surfaced as `Ok(None)`, which the
///   compute caller treated as "no recurrence requested" and created
///   a sibling with no due date.
///   **:** the 10 000-iteration safety budget elapsed
///   without `current > today` (e.g. `+1d` against an `original` ~30
///   years in the past). The pre-fix loop returned the stale past
///   date silently.
pub(crate) fn shift_date(date: &str, rule: &str) -> Result<Option<String>, AppError> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Ok(None);
    }
    let Ok(year) = parts[0].parse::<i32>() else {
        return Ok(None);
    };
    let Ok(month) = parts[1].parse::<u32>() else {
        return Ok(None);
    };
    let Ok(day) = parts[2].parse::<u32>() else {
        return Ok(None);
    };

    let Some(original) = chrono::NaiveDate::from_ymd_opt(year, month, day) else {
        return Ok(None);
    };
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
            // Shift from today, not from the original date.
            // Parse failures stay on the `Ok(None)` channel (existing
            // contract); the compute caller treats this as "no shift".
            let Some(s) = shift_date_once(today, interval) else {
                return Ok(None);
            };
            s
        }
        "plus_plus" => {
            // Keep shifting from original until result > today.
            //
            // Two dead-ends that previously returned silent garbage now
            // surface as `Err(AppError::Validation)`:
            //
            // * `shift_date_once` returns `None` mid-loop
            //   (single-step `NaiveDate` arithmetic overflow). The
            //   pre-fix `?` propagated `None` out of `shift_date`,
            //   which the compute caller treated as "no recurrence"
            //   and created a sibling with no due date.
            // * the 10 000-iteration safety budget
            //   elapses without `current > today` (e.g. `+1d` from an
            //   `original` ~30 years in the past). The pre-fix loop
            //   returned the stale past date silently.
            //
            // Both errors carry `original`/`interval`/`today` so the
            // operator can reproduce the input that tripped the guard
            // without spelunking through the op log. `AppError::Validation`
            // matches the surrounding date-shape rejections in
            // `commands/properties.rs` (`due_date`/`scheduled_date`
            // ISO-format checks both raise `Validation`).
            let mut current = original;
            let mut hit_cap = true;
            for _ in 0..10_000 {
                let Some(next) = shift_date_once(current, interval) else {
                    // Explicit overflow signal instead of
                    // silently returning `Ok(None)` from the parent.
                    return Err(AppError::validation(format!(
                        "recurrence ++ arithmetic overflow: original={original} interval={interval}"
                    )));
                };
                current = next;
                if current > today {
                    hit_cap = false;
                    break;
                }
            }
            if hit_cap {
                // Cap exhausted without catching up to
                // today; previously returned a stale past date.
                return Err(AppError::validation(format!(
                    "recurrence ++ cap exceeded: original={original} interval={interval} today={today}"
                )));
            }
            current
        }
        _ => {
            // Default: shift from original date once. Parse failures
            // stay on the `Ok(None)` channel (existing contract).
            let Some(s) = shift_date_once(original, interval) else {
                return Ok(None);
            };
            s
        }
    };

    Ok(Some(shifted.format("%Y-%m-%d").to_string()))
}

#[cfg(test)]
mod tests_m80 {
    //! Table-driven tests for `+Ny` (yearly) recurrence support.

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
            // Org-mode recurrence never goes "nowhere").
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
            // `shift_date` returns
            // `Result<Option<String>, AppError>`. None of these table
            // cases exercise the `++` arm, so all rows expect `Ok(_)`;
            // the `Option` then captures the parse-success vs
            // parse-failure split that the table was designed around.
            let actual = shift_date(date, rule).expect("non-`++` rules never return Err");
            let expected_owned = expected.map(std::string::ToString::to_string);
            assert_eq!(actual, expected_owned, "{desc}");
        }
    }
}
