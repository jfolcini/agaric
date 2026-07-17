//! Recurrence (repeat-rule) core (#2621 THE INVERSION).
//!
//! The neutral, transaction-scoped inner core of the recurring-task flow,
//! moved down from the app crate's `recurrence` module so it depends *down* on
//! the block-write core ([`crate::block_ops`]) and the pure interval math
//! ([`agaric_store::recurrence_math`]) with no upward app edge. The app crate
//! keeps the `CommandTx` / `Materializer` orchestration behind unchanged shims
//! (`crate::recurrence::compute::handle_recurrence` /
//! `handle_recurrence_in_tx`), which forward the open transaction to
//! [`build_recurrence_sibling_in_tx`] and enqueue the returned op records.
//!
//! Module layout:
//! - `parser` — pure rule-string parsing and date math (RRULE-like)
//! - `compute` — the transaction-scoped next-occurrence core (DB reads +
//!   sibling creation)

pub mod compute;
pub mod parser;

pub use compute::build_recurrence_sibling_in_tx;
pub use parser::shift_date;

#[cfg(test)]
mod tests {
    //! Pure date-math unit tests moved down with the recurrence core:
    //! `shift_date` string-path behaviour plus the `shift_date_once` /
    //! `days_in_month` interval primitives it builds on.

    use super::shift_date;
    use agaric_store::recurrence_math::{days_in_month, shift_date_once};

    #[test]
    fn shift_date_default_mode_shifts_from_original() {
        // Default (+) mode: shift from the original date.
        //
        // `shift_date` returns
        // `Result<Option<String>, AppError>`. The default arm cannot trip
        // either error path (no `++` loop, no overflow), so we unwrap the
        // outer `Result` once and pattern-match the `Option` as before.
        assert_eq!(
            shift_date("2025-06-15", "daily").unwrap(),
            Some("2025-06-16".into()),
            "daily should shift by one day"
        );
        assert_eq!(
            shift_date("2025-06-15", "weekly").unwrap(),
            Some("2025-06-22".into()),
            "weekly should shift by seven days"
        );
        assert_eq!(
            shift_date("2025-06-15", "+3d").unwrap(),
            Some("2025-06-18".into()),
            "+3d should shift by three days"
        );
    }

    #[test]
    fn shift_date_dot_plus_prefix_uses_today_as_base() {
        // .+ mode: shift from today, not from the original date
        let today = chrono::Local::now().date_naive();
        let expected = today + chrono::Duration::days(7);
        let expected_str = expected.format("%Y-%m-%d").to_string();

        // Use a date far in the past — with .+ the result should be based on today.
        // Two `unwrap`s: the outer one peels the new `Result<_, AppError>` (the
        // `.+` arm cannot raise the `++` overflow / cap errors), the inner one
        // peels the `Option<String>` parse-success channel.
        let result = shift_date("2020-01-01", ".+weekly").unwrap().unwrap();
        assert_eq!(
            result, expected_str,
            ".+weekly should shift from today, not from 2020-01-01"
        );

        // Also test with .+daily
        let expected_daily = (today + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        let result_daily = shift_date("2020-01-01", ".+daily").unwrap().unwrap();
        assert_eq!(
            result_daily, expected_daily,
            ".+daily should shift from today"
        );

        // .+3d
        let expected_3d = (today + chrono::Duration::days(3))
            .format("%Y-%m-%d")
            .to_string();
        let result_3d = shift_date("2020-01-01", ".+3d").unwrap().unwrap();
        assert_eq!(result_3d, expected_3d, ".+3d should shift from today");
    }

    #[test]
    fn shift_date_plus_plus_prefix_advances_to_future() {
        // ++ mode: keep shifting from original until result > today
        let today = chrono::Local::now().date_naive();

        // Use a date that's ~3 weeks in the past
        let past = today - chrono::Duration::days(21);
        let past_str = past.format("%Y-%m-%d").to_string();

        // Two `unwrap`s after: outer for `Result`,
        // inner for `Option<String>`. A 21-day origin is well under the
        // 10 000-iteration cap so the `++` arm returns `Ok(Some(_))`.
        let result = shift_date(&past_str, "++weekly").unwrap().unwrap();
        let result_date = chrono::NaiveDate::parse_from_str(&result, "%Y-%m-%d").unwrap();

        assert!(
            result_date > today,
            "++weekly should advance past today, got {result} (today = {})",
            today.format("%Y-%m-%d")
        );

        // The result should be within 7 days after today (since we're stepping weekly)
        let max_expected = today + chrono::Duration::days(7);
        assert!(
            result_date <= max_expected,
            "++weekly result should be at most 7 days after today, got {result}"
        );
    }

    #[test]
    fn shift_date_plus_plus_daily_advances_to_future() {
        let today = chrono::Local::now().date_naive();

        // 10 days in the past
        let past = today - chrono::Duration::days(10);
        let past_str = past.format("%Y-%m-%d").to_string();

        // Same double-unwrap as above (outer `Result`, inner `Option`).
        let result = shift_date(&past_str, "++daily").unwrap().unwrap();
        let result_date = chrono::NaiveDate::parse_from_str(&result, "%Y-%m-%d").unwrap();

        assert!(
            result_date > today,
            "++daily should advance past today, got {result}"
        );
        // Should be exactly tomorrow (today + 1) since we step by 1 day
        let expected = today + chrono::Duration::days(1);
        assert_eq!(
            result_date, expected,
            "++daily from 10 days ago should land on tomorrow"
        );
    }

    #[test]
    fn days_in_month_known_values() {
        assert_eq!(days_in_month(2025, 1), 31, "January has 31 days");
        assert_eq!(days_in_month(2025, 2), 28, "February non-leap has 28 days");
        assert_eq!(days_in_month(2024, 2), 29, "February leap year has 29 days");
        assert_eq!(days_in_month(2025, 4), 30, "April has 30 days");
        assert_eq!(days_in_month(2025, 12), 31, "December has 31 days");
    }

    #[test]
    fn shift_date_once_monthly_clamps_day() {
        // Jan 31 + 1 month → Feb 28 (non-leap)
        let base = chrono::NaiveDate::from_ymd_opt(2025, 1, 31).unwrap();
        let result = shift_date_once(base, "monthly").unwrap();
        assert_eq!(
            result,
            chrono::NaiveDate::from_ymd_opt(2025, 2, 28).unwrap(),
            "Jan 31 + 1 month should clamp to Feb 28"
        );
    }

    #[test]
    fn shift_date_once_custom_intervals() {
        let base = chrono::NaiveDate::from_ymd_opt(2025, 6, 15).unwrap();

        assert_eq!(
            shift_date_once(base, "3d"),
            Some(chrono::NaiveDate::from_ymd_opt(2025, 6, 18).unwrap()),
            "3d should shift by three days"
        );
        assert_eq!(
            shift_date_once(base, "2w"),
            Some(chrono::NaiveDate::from_ymd_opt(2025, 6, 29).unwrap()),
            "2w should shift by two weeks"
        );
        assert_eq!(
            shift_date_once(base, "2m"),
            Some(chrono::NaiveDate::from_ymd_opt(2025, 8, 15).unwrap()),
            "2m should shift by two months"
        );
    }

    #[test]
    fn shift_date_once_dst_transitions_calendar_safe() {
        // Shift_date_once is calendar-day arithmetic on NaiveDate, so DST
        // transitions in any timezone must not shift the result by ±1 day.
        //
        // We exercise dates that fall on (or one day before) known DST-transition
        // days across multiple timezones. The pure NaiveDate arithmetic should
        // produce the same calendar result regardless of timezone — this test
        // pins that invariant so a future refactor that introduces a DateTime
        // (and thus a timezone-sensitive add) would be caught.
        //
        // Reference DST dates (2024):
        //   - Europe/London spring-forward:    2024-03-31 (skips 01:00→02:00)
        //   - Europe/London fall-back:         2024-10-27 (repeats 01:00→02:00)
        //   - America/New_York spring-forward: 2024-03-10 (skips 02:00→03:00)
        //   - America/New_York fall-back:      2024-11-03 (repeats 01:00→02:00)
        //   - Australia/Sydney spring-forward: 2024-10-06 (skips 02:00→03:00)
        //   - Australia/Sydney fall-back:      2024-04-07 (repeats 02:00→03:00)
        type Case = (
            i32,
            u32,
            u32,
            &'static str,
            Option<(i32, u32, u32)>,
            &'static str,
        );
        let cases: &[Case] = &[
            // (base_y, base_m, base_d, interval, expected_y_m_d, description)
            // London spring-forward: daily on 2024-03-30 → 2024-03-31 (transition day).
            (
                2024,
                3,
                30,
                "daily",
                Some((2024, 3, 31)),
                "London spring-forward eve daily → transition day",
            ),
            // London spring-forward: weekly on 2024-03-30 → 2024-04-06 (skips DST day cleanly).
            (
                2024,
                3,
                30,
                "weekly",
                Some((2024, 4, 6)),
                "London spring-forward eve weekly → 7 calendar days later",
            ),
            // London fall-back: daily on 2024-10-26 → 2024-10-27 (transition day).
            (
                2024,
                10,
                26,
                "daily",
                Some((2024, 10, 27)),
                "London fall-back eve daily → transition day",
            ),
            // London fall-back: weekly on 2024-10-26 → 2024-11-02 (spans transition).
            (
                2024,
                10,
                26,
                "weekly",
                Some((2024, 11, 2)),
                "London fall-back eve weekly → 7 calendar days later",
            ),
            // US Eastern spring-forward: +3d on 2024-03-08 → 2024-03-11 (spans DST).
            (
                2024,
                3,
                8,
                "+3d",
                Some((2024, 3, 11)),
                "US Eastern +3d across spring-forward → 3 calendar days",
            ),
            // US Eastern fall-back: +3d on 2024-11-01 → 2024-11-04 (spans DST).
            (
                2024,
                11,
                1,
                "+3d",
                Some((2024, 11, 4)),
                "US Eastern +3d across fall-back → 3 calendar days",
            ),
            // Sydney spring-forward: weekly on 2024-10-05 → 2024-10-12 (spans DST).
            (
                2024,
                10,
                5,
                "weekly",
                Some((2024, 10, 12)),
                "Sydney spring-forward eve weekly → 7 calendar days later",
            ),
            // Sydney fall-back: monthly on 2024-04-07 → 2024-05-07.
            (
                2024,
                4,
                7,
                "monthly",
                Some((2024, 5, 7)),
                "Sydney fall-back day monthly → same day next month",
            ),
            // Stress: +Nd that lands exactly on a DST day across years.
            (
                2025,
                3,
                8,
                "+2d",
                Some((2025, 3, 10)),
                "US Eastern 2025 spring-forward +2d → 3rd day forward",
            ),
            // Lord Howe Island half-hour DST start (2024-10-06): pure calendar day,
            // half-hour shift is irrelevant for NaiveDate arithmetic.
            (
                2024,
                10,
                5,
                "+2d",
                Some((2024, 10, 7)),
                "Lord Howe DST +2d across half-hour shift → 2 calendar days",
            ),
        ];

        for (y, m, d, rule, expected, desc) in cases {
            let base = chrono::NaiveDate::from_ymd_opt(*y, *m, *d).unwrap();
            let actual = shift_date_once(base, rule);
            let expected_date =
                expected.map(|(ey, em, ed)| chrono::NaiveDate::from_ymd_opt(ey, em, ed).unwrap());
            assert_eq!(actual, expected_date, "{desc}");
        }
    }

    #[test]
    fn shift_date_returns_none_for_bad_input() {
        // Malformed inputs (bad date, unknown
        // interval, empty rule) stay on the `Ok(None)` channel — they are
        // user-input shape errors, not the new `++`-arm overflow / cap
        // signals. The compute caller treats `Ok(None)` as "skip the shift
        // silently", preserving the pre-fix behaviour for these cases.
        assert_eq!(
            shift_date("not-a-date", "daily").unwrap(),
            None,
            "invalid date should return Ok(None)"
        );
        assert_eq!(
            shift_date("2025-06-15", "xyz").unwrap(),
            None,
            "unknown interval should return Ok(None)"
        );
        assert_eq!(
            shift_date("2025-06-15", "").unwrap(),
            None,
            "empty rule should return Ok(None)"
        );
    }

    #[test]
    fn shift_date_monthly_from_string() {
        assert_eq!(
            shift_date("2025-01-31", "monthly").unwrap(),
            Some("2025-02-28".into()),
            "Jan 31 monthly should clamp to Feb 28"
        );
        assert_eq!(
            shift_date("2025-06-15", "monthly").unwrap(),
            Some("2025-07-15".into()),
            "Jun 15 monthly should yield Jul 15"
        );
    }

    #[test]
    fn monthly_clamp_is_sticky_three_step_chain() {
        // #679: the month-end clamp is INTENTIONALLY sticky (Org-mode
        // in-place shift). Each recurrence step shifts the PREVIOUS shifted
        // date — not the series origin — so once Jan-31 clamps to Feb-28 the
        // day-of-month is never restored to 31. This test pins the full
        // three-step chain so a future "restore the original day" change
        // cannot silently regress the documented behavior.
        //
        // Step 1: Jan-31 → Feb-28 (clamp; Feb 2025 is non-leap, max day 28).
        let step1 = shift_date("2025-01-31", "monthly")
            .expect("monthly parses cleanly")
            .expect("monthly yields a date");
        assert_eq!(step1, "2025-02-28", "Jan-31 monthly clamps to Feb-28");

        // Step 2: base is the *clamped* Feb-28, so this yields Mar-28 — NOT
        // Mar-31. This is the crux of the sticky behavior.
        let step2 = shift_date(&step1, "monthly")
            .expect("monthly parses cleanly")
            .expect("monthly yields a date");
        assert_eq!(
            step2, "2025-03-28",
            "sticky clamp: Feb-28 monthly must yield Mar-28, NOT Mar-31"
        );
        assert_ne!(
            step2, "2025-03-31",
            "day-31 must NOT be restored after the Feb clamp (Org-mode in-place shift)"
        );

        // Step 3: Mar-28 → Apr-28, confirming the clamped day persists.
        let step3 = shift_date(&step2, "monthly")
            .expect("monthly parses cleanly")
            .expect("monthly yields a date");
        assert_eq!(
            step3, "2025-04-28",
            "sticky clamp persists: Mar-28 monthly yields Apr-28"
        );
    }

    #[test]
    fn shift_date_once_monthly_december_year_rollover() {
        // Dec 31 + 1 month → Jan 31 of the next year.
        // Exercises the `month == 12` branch in `shift_by_months` that sets
        // month = 1 and increments the year.
        let base = chrono::NaiveDate::from_ymd_opt(2025, 12, 31).unwrap();
        let result = shift_date_once(base, "monthly").unwrap();
        assert_eq!(
            result,
            chrono::NaiveDate::from_ymd_opt(2026, 1, 31).unwrap(),
            "monthly from Dec 31 must roll to Jan 31 of the next year"
        );
    }

    #[test]
    fn shift_date_monthly_december_rolls_year() {
        // End-to-end string path for the December → January year rollover.
        assert_eq!(
            shift_date("2025-12-15", "monthly").unwrap(),
            Some("2026-01-15".into()),
            "monthly shift from 2025-12-15 must produce 2026-01-15"
        );
        // Also pin the mid-month case from shift_date_once above via the string API.
        assert_eq!(
            shift_date("2025-12-31", "monthly").unwrap(),
            Some("2026-01-31".into()),
            "monthly shift from 2025-12-31 must produce 2026-01-31"
        );
    }

    // ==================================================================
    // Overflow / range checks for month arithmetic
    // ==================================================================

    #[test]
    fn shift_date_once_months_normal() {
        // 2026-01 + 3 months = 2026-04
        let base = chrono::NaiveDate::from_ymd_opt(2026, 1, 15).unwrap();
        let result = shift_date_once(base, "3m");
        assert_eq!(
            result,
            Some(chrono::NaiveDate::from_ymd_opt(2026, 4, 15).unwrap()),
            "Normal +3m shift should work"
        );
    }

    #[test]
    fn shift_date_once_months_year_rollover() {
        // 2026-11 + 3 months = 2027-02
        let base = chrono::NaiveDate::from_ymd_opt(2026, 11, 15).unwrap();
        let result = shift_date_once(base, "3m");
        assert_eq!(
            result,
            Some(chrono::NaiveDate::from_ymd_opt(2027, 2, 15).unwrap()),
            "Year rollover with +3m should work"
        );
    }

    #[test]
    fn shift_date_once_months_extreme_positive_returns_none() {
        // +100000 months should exceed the 2200 year cap
        let base = chrono::NaiveDate::from_ymd_opt(2025, 6, 15).unwrap();
        let result = shift_date_once(base, "100000m");
        assert_eq!(
            result, None,
            "Extreme positive month shift should return None"
        );
    }

    #[test]
    fn shift_date_once_months_extreme_negative_returns_none() {
        // -100000 months should go below the 1900 year floor
        let base = chrono::NaiveDate::from_ymd_opt(2025, 6, 15).unwrap();
        let result = shift_date_once(base, "-100000m");
        assert_eq!(
            result, None,
            "Extreme negative month shift should return None"
        );
    }

    #[test]
    fn shift_date_rejects_negative_intervals() {
        // Regression: Org-mode recurrence never goes backwards. A typo or
        // paste like `-1d` / `-3w` / `-2m` would silently set the next-occurrence
        // to a date in the past; reject at parse time so the caller (and the
        // user) sees the rule was not honored.
        // Rejection stays on the `Ok(None)` channel.
        for rule in ["-1d", "-1w", "-1m", "-3w", "-2m", "-7d"] {
            assert_eq!(
                shift_date("2025-06-15", rule).unwrap(),
                None,
                "negative interval {rule} must be rejected"
            );
        }
    }

    #[test]
    fn shift_date_rejects_zero_intervals() {
        // Regression: a zero interval is also nonsense — `+0d` would no-op
        // (sibling has the same date as the original) and `++0w` would loop
        // until the 10_000-iteration safety limit.
        // Zero-count rejection stays on `Ok(None)`.
        for rule in ["0d", "0w", "0m", "+0d", "+0w", "+0m"] {
            assert_eq!(
                shift_date("2025-06-15", rule).unwrap(),
                None,
                "zero interval {rule} must be rejected"
            );
        }
    }

    #[test]
    fn shift_date_rejects_malformed_intervals() {
        // Malformed RRULE intervals must be rejected at parse time
        // (return None) rather than silently coerced to 0 / 1 / something
        // arbitrary. Covers four shapes that have all surfaced from real
        // user typos:
        //   - "5x"     bogus unit suffix (not d/w/m/y)
        //   - "w"      missing numeric prefix
        //   - "3.5d"   float (i64 parser must fail)
        //   - "invalid" free-text junk
        // Style mirrors `shift_date_rejects_zero_intervals` above.
        // Malformed-rule rejection stays on `Ok(None)`.
        for rule in ["5x", "w", "3.5d", "invalid"] {
            assert_eq!(
                shift_date("2025-06-15", rule).unwrap(),
                None,
                "malformed interval {rule} must be rejected"
            );
        }
    }
}
