//! Unit tests for `recurrence` (pure date math and async recurrence flow).
//!
//! The async tests exercise `handle_recurrence` indirectly through
//! `set_todo_state_inner`, which is the production call-site for the
//! recurrence flow.

use super::parser::{days_in_month, shift_date, shift_date_once};
use sqlx::SqlitePool;

#[test]
fn shift_date_default_mode_shifts_from_original() {
    // Default (+) mode: shift from the original date.
    //
    // PEND-26 N3 / PEND-24 H2: `shift_date` returns
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

    // Two `unwrap`s after PEND-26 N3 / PEND-24 H2: outer for `Result`,
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
    // L-110: shift_date_once is calendar-day arithmetic on NaiveDate, so DST
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
    // PEND-26 N3 / PEND-24 H2: malformed inputs (bad date, unknown
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

// ==================================================================
// M-36: overflow / range checks for month arithmetic
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
    // M-79 regression: Org-mode recurrence never goes backwards. A typo or
    // paste like `-1d` / `-3w` / `-2m` would silently set the next-occurrence
    // to a date in the past; reject at parse time so the caller (and the
    // user) sees the rule was not honored.
    // PEND-26 N3 / PEND-24 H2: rejection stays on the `Ok(None)` channel.
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
    // M-79 regression: a zero interval is also nonsense — `+0d` would no-op
    // (sibling has the same date as the original) and `++0w` would loop
    // until the 10_000-iteration safety limit.
    // PEND-26 N3 / PEND-24 H2: zero-count rejection stays on `Ok(None)`.
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
    // TEST-50: malformed RRULE intervals must be rejected at parse time
    // (return None) rather than silently coerced to 0 / 1 / something
    // arbitrary. Covers four shapes that have all surfaced from real
    // user typos:
    //   - "5x"     bogus unit suffix (not d/w/m/y)
    //   - "w"      missing numeric prefix
    //   - "3.5d"   float (i64 parser must fail)
    //   - "invalid" free-text junk
    // Style mirrors `shift_date_rejects_zero_intervals` above.
    // PEND-26 N3 / PEND-24 H2: malformed-rule rejection stays on `Ok(None)`.
    for rule in ["5x", "w", "3.5d", "invalid"] {
        assert_eq!(
            shift_date("2025-06-15", rule).unwrap(),
            None,
            "malformed interval {rule} must be rejected"
        );
    }
}

// ==================================================================
// PEND-24 H2 + PEND-26 N3: `++` arm explicit failure modes
// ==================================================================
//
// Two distinct dead-ends in the `shift_date` `++` arm previously
// returned silent garbage:
//
// * **PEND-24 H2** — the 10 000-iteration safety budget elapses without
//   `current > today`. Pre-fix the loop returned a stale past date; the
//   compute caller used it for end-condition checks and sibling
//   creation, silently creating a sibling with a past due date.
// * **PEND-26 N3** — `shift_date_once` returns `None` mid-loop (single
//   `NaiveDate` arithmetic overflow). Pre-fix the `?` propagation
//   surfaced this as `Ok(None)`, which the compute caller treated as
//   "no recurrence requested" and created a sibling with no due date.
//
// Both now return `Err(AppError::Validation(...))`. The boundary case
// (origin a few days back, well under the cap) confirms we did not
// accidentally tighten the cap or break the success path.
// `handle_recurrence_in_tx` propagation lives in the async section
// below (see `plus_plus_cap_exceeded_propagates_through_handle_recurrence`).

#[test]
fn plus_plus_with_very_old_origin_returns_err() {
    // PEND-24 H2: an origin 11 000 days in the past with `+1d`
    // exhausts the 10 000-iteration cap without catching up to today.
    // Pre-fix: silently returned a stale past date.
    // Post-fix: `Err(AppError::Validation)` carrying the inputs that
    // tripped the guard.
    let today = chrono::Local::now().date_naive();
    let very_old = today - chrono::Duration::days(11_000);
    let very_old_str = very_old.format("%Y-%m-%d").to_string();

    let result = shift_date(&very_old_str, "++1d");
    let err = result.expect_err("11 000 days under +1d must blow the 10 000 cap");
    let msg = err.to_string();
    assert!(
        msg.contains("cap exceeded"),
        "error must identify the cap-exceeded path, got: {msg}"
    );
    // The error carries the inputs the operator needs to reproduce.
    assert!(
        msg.contains("interval=1d") || msg.contains("interval=+1d"),
        "error should include the interval, got: {msg}"
    );
}

#[test]
fn plus_plus_overflow_returns_err() {
    // PEND-26 N3: an origin within a few years of `NaiveDate::MAX`
    // combined with `++100y` overflows the underlying `chrono` month
    // arithmetic on the first iteration (`shift_by_months` rejects
    // years above `MAX_CALENDAR_YEAR` = 2200).
    //
    // Pre-fix: `shift_date_once` returned `None`, the `?` propagated
    // out of `shift_date` as `None`, and the compute caller silently
    // created a sibling with no due date.
    // Post-fix: explicit `Err(AppError::Validation)` with "arithmetic
    // overflow" in the message.
    //
    // Choosing a date inside the calendar guard rail (year 2150) so
    // the *first iteration* of `++100y` (target year 2250) is the one
    // that exceeds `MAX_CALENDAR_YEAR`. This pins the N3 path
    // (`shift_date_once` returning `None` mid-`++` loop) regardless of
    // what `today` is when the test runs.
    let result = shift_date("2150-01-15", "++100y");
    let err =
        result.expect_err("++100y from 2150 must overflow the 2200 calendar guard on iteration 1");
    let msg = err.to_string();
    assert!(
        msg.contains("arithmetic overflow"),
        "error must identify the overflow path, got: {msg}"
    );
    assert!(
        msg.contains("interval=100y") || msg.contains("interval=+100y"),
        "error should include the interval, got: {msg}"
    );
}

#[test]
fn plus_plus_boundary_success_under_cap() {
    // Boundary case: origin only 5 days in the past with `+1d` should
    // succeed in 6 iterations — well under the 10 000-iteration cap.
    // Confirms PEND-24 H2's added `hit_cap` flag does not regress the
    // success path.
    let today = chrono::Local::now().date_naive();
    let recent = today - chrono::Duration::days(5);
    let recent_str = recent.format("%Y-%m-%d").to_string();

    let expected = today + chrono::Duration::days(1);
    let expected_str = expected.format("%Y-%m-%d").to_string();

    let result = shift_date(&recent_str, "++1d")
        .expect("5-day origin under +1d is well within the cap")
        .expect("`++1d` parses cleanly so the inner Option is Some");
    assert_eq!(
        result, expected_str,
        "++1d from 5 days ago must land on tomorrow (today + 1)"
    );
}

// ==================================================================
// T-36: handle_recurrence() dedicated integration tests
// ==================================================================

use crate::commands::{
    create_block_inner, get_block_inner, get_properties_inner, set_due_date_inner,
    set_property_inner, set_todo_state_inner,
};
use crate::db::init_pool;
use crate::materializer::Materializer;
use crate::pagination::BlockRow;
use std::path::PathBuf;
use tempfile::TempDir;

const DEV: &str = "test-device-001";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Helper: set a repeat property on a block.
async fn set_repeat_property(pool: &SqlitePool, mat: &Materializer, block_id: &str, rule: &str) {
    set_property_inner(
        pool,
        DEV,
        mat,
        block_id.to_string().into(),
        "repeat".to_string(),
        Some(rule.to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
}

/// Helper: set a property with a numeric value.
async fn set_num_property(
    pool: &SqlitePool,
    mat: &Materializer,
    block_id: &str,
    key: &str,
    value: f64,
) {
    set_property_inner(
        pool,
        DEV,
        mat,
        block_id.to_string().into(),
        key.to_string(),
        None,
        Some(value),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
}

/// Helper: set a property with a date value.
async fn set_date_property(
    pool: &SqlitePool,
    mat: &Materializer,
    block_id: &str,
    key: &str,
    date: &str,
) {
    set_property_inner(
        pool,
        DEV,
        mat,
        block_id.to_string().into(),
        key.to_string(),
        None,
        None,
        Some(date.to_string()),
        None,
        None,
        None,
    )
    .await
    .unwrap();
}

/// Helper: find sibling blocks created by recurrence (TODO blocks that
/// aren't the original).
async fn find_recurrence_siblings(pool: &SqlitePool, original_id: &str) -> Vec<BlockRow> {
    sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at,  todo_state, priority,
                  due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId"
           FROM blocks WHERE id != ? AND todo_state = 'TODO' AND deleted_at IS NULL"#,
        original_id
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_recurrence_daily_creates_sibling_with_shifted_due_date() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a content block
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "recurring daily task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set TODO state
    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set due_date
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat = daily
    set_repeat_property(&pool, &mat, block.id.as_str(), "daily").await;
    mat.flush_background().await.unwrap();

    // Mark DONE to trigger handle_recurrence via set_todo_state_inner
    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Verify sibling was created with shifted due_date
    let siblings = find_recurrence_siblings(&pool, block.id.as_str()).await;
    assert_eq!(
        siblings.len(),
        1,
        "handle_recurrence should create exactly one sibling"
    );
    let sibling = &siblings[0];
    assert_eq!(
        sibling.due_date.as_deref(),
        Some("2025-06-16"),
        "sibling due_date should be shifted by 1 day from 2025-06-15"
    );
    assert_eq!(
        sibling.todo_state.as_deref(),
        Some("TODO"),
        "sibling should have TODO state"
    );
    assert_eq!(
        sibling.content.as_deref(),
        Some("recurring daily task"),
        "sibling should copy the original content"
    );

    // Original should be DONE
    let original = get_block_inner(&pool, block.id).await.unwrap();
    assert_eq!(
        original.todo_state.as_deref(),
        Some("DONE"),
        "original block should remain DONE"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_recurrence_repeat_until_stops_when_past_deadline() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "until-limited task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set due_date to 2025-06-15
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat = daily
    set_repeat_property(&pool, &mat, block.id.as_str(), "daily").await;
    mat.flush_background().await.unwrap();

    // Set repeat-until to 2025-06-15 — shifted date (2025-06-16) > until date
    set_date_property(&pool, &mat, block.id.as_str(), "repeat-until", "2025-06-15").await;
    mat.flush_background().await.unwrap();

    // Mark DONE — handle_recurrence should NOT create a sibling
    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, block.id.as_str()).await;
    assert_eq!(
        siblings.len(),
        0,
        "no sibling should be created when shifted date exceeds repeat-until"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_recurrence_repeat_count_stops_when_exhausted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "count-limited task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, &mat, block.id.as_str(), "daily").await;
    mat.flush_background().await.unwrap();

    // Set repeat-count = 2 and repeat-seq = 2 (already exhausted)
    set_num_property(&pool, &mat, block.id.as_str(), "repeat-count", 2.0).await;
    mat.flush_background().await.unwrap();
    set_num_property(&pool, &mat, block.id.as_str(), "repeat-seq", 2.0).await;
    mat.flush_background().await.unwrap();

    // Mark DONE — handle_recurrence should NOT create a sibling
    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, block.id.as_str()).await;
    assert_eq!(
        siblings.len(),
        0,
        "no sibling should be created when repeat-seq >= repeat-count"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_recurrence_copies_properties_to_sibling() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "property copy test".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, &mat, block.id.as_str(), "weekly").await;
    mat.flush_background().await.unwrap();

    // Set repeat-until on original
    set_date_property(&pool, &mat, block.id.as_str(), "repeat-until", "2025-12-31").await;
    mat.flush_background().await.unwrap();

    // Set repeat-count and repeat-seq on original
    set_num_property(&pool, &mat, block.id.as_str(), "repeat-count", 5.0).await;
    mat.flush_background().await.unwrap();
    set_num_property(&pool, &mat, block.id.as_str(), "repeat-seq", 1.0).await;
    mat.flush_background().await.unwrap();

    // Mark DONE
    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, block.id.as_str()).await;
    assert_eq!(siblings.len(), 1, "should create exactly one sibling");
    let sibling = &siblings[0];

    // Verify properties on the sibling
    let props = get_properties_inner(&pool, sibling.id.clone())
        .await
        .unwrap();

    // repeat property copied
    let repeat_prop = props.iter().find(|p| p.key == "repeat");
    assert!(repeat_prop.is_some(), "sibling should have repeat property");
    assert_eq!(
        repeat_prop.unwrap().value_text.as_deref(),
        Some("weekly"),
        "sibling repeat should match original rule"
    );

    // repeat-until copied
    let until_prop = props.iter().find(|p| p.key == "repeat-until");
    assert!(
        until_prop.is_some(),
        "sibling should have repeat-until property"
    );
    assert_eq!(
        until_prop.unwrap().value_date.as_deref(),
        Some("2025-12-31"),
        "sibling repeat-until should match original"
    );

    // repeat-count copied
    let count_prop = props.iter().find(|p| p.key == "repeat-count");
    assert!(
        count_prop.is_some(),
        "sibling should have repeat-count property"
    );
    assert_eq!(
        count_prop.unwrap().value_num,
        Some(5.0),
        "sibling repeat-count should match original"
    );

    // repeat-seq incremented from 1 to 2
    let seq_prop = props.iter().find(|p| p.key == "repeat-seq");
    assert!(
        seq_prop.is_some(),
        "sibling should have repeat-seq property"
    );
    assert_eq!(
        seq_prop.unwrap().value_num,
        Some(2.0),
        "sibling repeat-seq should be incremented from 1 to 2"
    );

    // due_date shifted by 1 week
    assert_eq!(
        sibling.due_date.as_deref(),
        Some("2025-06-22"),
        "sibling due_date should be shifted by 7 days"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_recurrence_sets_repeat_origin_on_sibling() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "origin test".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, &mat, block.id.as_str(), "daily").await;
    mat.flush_background().await.unwrap();

    // Mark DONE — creates first sibling
    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, block.id.as_str()).await;
    assert_eq!(siblings.len(), 1, "should create one sibling");
    let sibling = &siblings[0];

    // Verify repeat-origin points back to original block
    let props = get_properties_inner(&pool, sibling.id.clone())
        .await
        .unwrap();
    let origin_prop = props.iter().find(|p| p.key == "repeat-origin");
    assert!(
        origin_prop.is_some(),
        "sibling should have repeat-origin property"
    );
    assert_eq!(
        origin_prop.unwrap().value_ref.as_deref(),
        Some(block.id.as_str()),
        "repeat-origin should point to the original block"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_recurrence_sibling_position_does_not_collide() {
    // M-78 regression: the new recurrence sibling's position must NOT
    // collide with an existing sibling that already occupies
    // `original.position + 1`. The sibling is appended past MAX(position)
    // among living siblings so each sibling holds a unique slot.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a parent page so the siblings have a shared parent.
    let parent = create_block_inner(&pool, DEV, &mat, "page".into(), "parent".into(), None, None)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // The recurring task — placed at position 1 under the parent.
    // (positions are 1-based per `crud.rs::create_block_inner`.)
    let recurring = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "recurring task".into(),
        Some(parent.id.clone()),
        Some(1),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Sibling A occupies position 2 — the slot the buggy code would re-use.
    let sibling_a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "neighbor A".into(),
        Some(parent.id.clone()),
        Some(2),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Sibling B occupies position 3 (the highest live MAX we expect to see).
    let sibling_b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "neighbor B".into(),
        Some(parent.id.clone()),
        Some(3),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Wire up the recurring task and trigger the recurrence flow.
    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        recurring.id.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        recurring.id.as_str().into(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    set_repeat_property(&pool, &mat, recurring.id.as_str(), "daily").await;
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        recurring.id.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Find the new recurrence sibling (TODO under the same parent, distinct
    // from the two pre-existing neighbors).
    let rows: Vec<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: crate::ulid::BlockId", block_type, content, parent_id as "parent_id: crate::ulid::BlockId", position, deleted_at,  todo_state, priority,
                  due_date, scheduled_date, page_id as "page_id: crate::ulid::BlockId"
           FROM blocks
           WHERE parent_id = ?
             AND id NOT IN (?, ?, ?)
             AND todo_state = 'TODO'
             AND deleted_at IS NULL"#,
        parent.id,
        recurring.id,
        sibling_a.id,
        sibling_b.id,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "exactly one recurrence sibling should be created"
    );
    let new_sibling = &rows[0];

    // The naive `original.position + 1` would yield 2, colliding with
    // sibling A. Assert the new sibling's position is strictly greater
    // than every live sibling currently occupying a non-sentinel slot.
    let new_pos = new_sibling.position.expect("sibling has a position");
    assert!(
        new_pos > 3,
        "new recurrence sibling position {new_pos} must be > MAX(existing siblings) (3); got collision"
    );

    // Sanity: every living sibling under the parent has a distinct position.
    let positions: Vec<i64> =
        sqlx::query_scalar("SELECT position FROM blocks WHERE parent_id = ? AND deleted_at IS NULL AND position IS NOT NULL")
            .bind(&parent.id)
            .fetch_all(&pool)
            .await
            .unwrap();
    let mut deduped = positions.clone();
    deduped.sort_unstable();
    deduped.dedup();
    assert_eq!(
        positions.len(),
        deduped.len(),
        "all living siblings must have distinct positions; got {positions:?}"
    );

    mat.shutdown();
}

// ==================================================================
// TEST-16: year-boundary recurrence integration tests
// ==================================================================
//
// Pin the year-component arithmetic in `shift_date` end-to-end through
// the full recurrence flow (`set_todo_state_inner` -> `handle_recurrence`).
// The earlier DST and leap-year tests in this file only exercise
// `shift_date` at the function level; these two cases assert that the
// integration path correctly carries the year rollover from the
// `chrono::NaiveDate + Duration` result back into the new sibling's
// `due_date` column.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_recurrence_daily_crosses_year_boundary() {
    // TEST-16: daily recurrence on Dec 31 must shift to Jan 1 of the
    // next year. Invariant: the year component increments when the day
    // arithmetic carries past Dec 31.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "year-boundary daily task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("2025-12-31".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, &mat, block.id.as_str(), "daily").await;
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, block.id.as_str()).await;
    assert_eq!(
        siblings.len(),
        1,
        "daily recurrence across year boundary should create exactly one sibling"
    );
    assert_eq!(
        siblings[0].due_date.as_deref(),
        Some("2026-01-01"),
        "daily shift from 2025-12-31 must roll into 2026-01-01 (year component +1)"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_recurrence_weekly_crosses_year_boundary() {
    // TEST-16: weekly recurrence on Tuesday Dec 30, 2025 must shift to
    // Tuesday Jan 6, 2026. Invariant: a 7-day shift that straddles
    // Dec 31 -> Jan 1 advances the year exactly once and preserves the
    // weekday (verified against calendar: Dec 30 2025 = Tuesday,
    // Jan 6 2026 = Tuesday).
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "year-boundary weekly task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("2025-12-30".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, &mat, block.id.as_str(), "weekly").await;
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, block.id.as_str()).await;
    assert_eq!(
        siblings.len(),
        1,
        "weekly recurrence across year boundary should create exactly one sibling"
    );
    assert_eq!(
        siblings[0].due_date.as_deref(),
        Some("2026-01-06"),
        "weekly shift from 2025-12-30 (Tue) must land on 2026-01-06 (Tue)"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn plus_plus_cap_exceeded_propagates_through_handle_recurrence() {
    // PEND-24 H2 (caller-level): the `Err(AppError::Validation)` raised
    // by `shift_date`'s `++` cap-exceeded path must propagate through
    // `handle_recurrence_in_tx` (called via `set_todo_state_inner` at
    // `commands/properties.rs:348`) and roll back the IMMEDIATE tx so
    // *no* sibling is committed.
    //
    // Pre-fix: the `++` arm silently returned a stale past date, so
    // `handle_recurrence_in_tx` happily created a sibling with that
    // past date as its `due_date` (a hidden bug — agenda silently
    // dropped the recurring task off the visible date window).
    // Post-fix: the error surfaces up through `set_todo_state_inner`,
    // the tx rolls back, and the caller sees the validation error.
    //
    // Vehicle: due_date = today - 11_000 days, repeat = ++1d. The
    // 10 000-iteration cap is exhausted before the loop catches up to
    // today.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "ancient recurring task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("TODO".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let today = chrono::Local::now().date_naive();
    let ancient = today - chrono::Duration::days(11_000);
    let ancient_str = ancient.format("%Y-%m-%d").to_string();
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some(ancient_str.clone()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, &mat, block.id.as_str(), "++1d").await;
    mat.flush_background().await.unwrap();

    // Snapshot op_log size BEFORE the failing transition so we can
    // assert that no partial entries from this DONE transition leaked
    // past the rolled-back IMMEDIATE tx.
    let ops_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();

    // Mark DONE — `handle_recurrence_in_tx` should propagate the
    // cap-exceeded `Err`. Pre-fix this returned `Ok(_)` and committed
    // a sibling with a stale past `due_date`.
    let result = set_todo_state_inner(
        &pool,
        DEV,
        &mat,
        block.id.as_str().into(),
        Some("DONE".into()),
    )
    .await;

    let err = result.expect_err(
        "PEND-24 H2: ancient origin under ++1d must propagate cap-exceeded as AppError::Validation",
    );
    let msg = err.to_string();
    assert!(
        msg.contains("cap exceeded"),
        "error must identify the cap-exceeded path, got: {msg}"
    );

    // No sibling committed: the IMMEDIATE tx rolled back the failing
    // recurrence flow entirely. Mirrors
    // `handle_recurrence_propagates_set_property_error` in
    // `compute::tests_h17_m77`.
    let siblings = find_recurrence_siblings(&pool, block.id.as_str()).await;
    assert_eq!(
        siblings.len(),
        0,
        "no recurrence sibling should be committed when shift_date returns Err — got {} sibling(s)",
        siblings.len()
    );

    // No partial op_log entries leaked past the rollback.
    let ops_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ops_after, ops_before,
        "rolled-back IMMEDIATE tx must leave op_log unchanged (before={ops_before}, after={ops_after})"
    );

    mat.shutdown();
}
