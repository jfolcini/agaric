//! Unit tests for `recurrence` (pure date math and async recurrence flow).
//!
//! The async tests exercise `handle_recurrence` indirectly through
//! `set_todo_state_inner`, which is the production call-site for the
//! recurrence flow.

use super::parser::{days_in_month, shift_date, shift_date_once};
use sqlx::SqlitePool;

#[test]
fn shift_date_default_mode_shifts_from_original() {
    // Default (+) mode: shift from the original date
    assert_eq!(
        shift_date("2025-06-15", "daily"),
        Some("2025-06-16".into()),
        "daily should shift by one day"
    );
    assert_eq!(
        shift_date("2025-06-15", "weekly"),
        Some("2025-06-22".into()),
        "weekly should shift by seven days"
    );
    assert_eq!(
        shift_date("2025-06-15", "+3d"),
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

    // Use a date far in the past — with .+ the result should be based on today
    let result = shift_date("2020-01-01", ".+weekly").unwrap();
    assert_eq!(
        result, expected_str,
        ".+weekly should shift from today, not from 2020-01-01"
    );

    // Also test with .+daily
    let expected_daily = (today + chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    let result_daily = shift_date("2020-01-01", ".+daily").unwrap();
    assert_eq!(
        result_daily, expected_daily,
        ".+daily should shift from today"
    );

    // .+3d
    let expected_3d = (today + chrono::Duration::days(3))
        .format("%Y-%m-%d")
        .to_string();
    let result_3d = shift_date("2020-01-01", ".+3d").unwrap();
    assert_eq!(result_3d, expected_3d, ".+3d should shift from today");
}

#[test]
fn shift_date_plus_plus_prefix_advances_to_future() {
    // ++ mode: keep shifting from original until result > today
    let today = chrono::Local::now().date_naive();

    // Use a date that's ~3 weeks in the past
    let past = today - chrono::Duration::days(21);
    let past_str = past.format("%Y-%m-%d").to_string();

    let result = shift_date(&past_str, "++weekly").unwrap();
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

    let result = shift_date(&past_str, "++daily").unwrap();
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
fn shift_date_returns_none_for_bad_input() {
    assert_eq!(
        shift_date("not-a-date", "daily"),
        None,
        "invalid date should return None"
    );
    assert_eq!(
        shift_date("2025-06-15", "xyz"),
        None,
        "unknown interval should return None"
    );
    assert_eq!(
        shift_date("2025-06-15", ""),
        None,
        "empty rule should return None"
    );
}

#[test]
fn shift_date_monthly_from_string() {
    assert_eq!(
        shift_date("2025-01-31", "monthly"),
        Some("2025-02-28".into()),
        "Jan 31 monthly should clamp to Feb 28"
    );
    assert_eq!(
        shift_date("2025-06-15", "monthly"),
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
        block_id.to_string(),
        "repeat".to_string(),
        Some(rule.to_string()),
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
        block_id.to_string(),
        key.to_string(),
        None,
        Some(value),
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
        block_id.to_string(),
        key.to_string(),
        None,
        None,
        Some(date.to_string()),
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
        r#"SELECT id, block_type, content, parent_id, position, deleted_at,
                  is_conflict as "is_conflict: bool", conflict_type, todo_state, priority,
                  due_date, scheduled_date, page_id
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
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Set due_date
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat = daily
    set_repeat_property(&pool, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Mark DONE to trigger handle_recurrence via set_todo_state_inner
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Verify sibling was created with shifted due_date
    let siblings = find_recurrence_siblings(&pool, &block.id).await;
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
    let original = get_block_inner(&pool, block.id.clone()).await.unwrap();
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

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Set due_date to 2025-06-15
    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat = daily
    set_repeat_property(&pool, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Set repeat-until to 2025-06-15 — shifted date (2025-06-16) > until date
    set_date_property(&pool, &mat, &block.id, "repeat-until", "2025-06-15").await;
    mat.flush_background().await.unwrap();

    // Mark DONE — handle_recurrence should NOT create a sibling
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, &block.id).await;
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

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Set repeat-count = 2 and repeat-seq = 2 (already exhausted)
    set_num_property(&pool, &mat, &block.id, "repeat-count", 2.0).await;
    mat.flush_background().await.unwrap();
    set_num_property(&pool, &mat, &block.id, "repeat-seq", 2.0).await;
    mat.flush_background().await.unwrap();

    // Mark DONE — handle_recurrence should NOT create a sibling
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, &block.id).await;
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

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, &mat, &block.id, "weekly").await;
    mat.flush_background().await.unwrap();

    // Set repeat-until on original
    set_date_property(&pool, &mat, &block.id, "repeat-until", "2025-12-31").await;
    mat.flush_background().await.unwrap();

    // Set repeat-count and repeat-seq on original
    set_num_property(&pool, &mat, &block.id, "repeat-count", 5.0).await;
    mat.flush_background().await.unwrap();
    set_num_property(&pool, &mat, &block.id, "repeat-seq", 1.0).await;
    mat.flush_background().await.unwrap();

    // Mark DONE
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, &block.id).await;
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

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        Some("2025-06-15".into()),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_repeat_property(&pool, &mat, &block.id, "daily").await;
    mat.flush_background().await.unwrap();

    // Mark DONE — creates first sibling
    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let siblings = find_recurrence_siblings(&pool, &block.id).await;
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
