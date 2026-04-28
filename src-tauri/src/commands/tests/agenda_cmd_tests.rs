#![allow(unused_imports)]
use super::super::*;
use super::common::*;
use chrono::Datelike;

// ======================================================================
// list_blocks with agenda_source filter
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_agenda_source_filter_due_date() {
    let (pool, _dir) = test_pool().await;

    // Insert blocks
    insert_block(&pool, "AG_DUE1", "content", "due task", None, None).await;
    insert_block(&pool, "AG_SCHED1", "content", "scheduled task", None, None).await;

    // Insert agenda_cache entries with different sources on the same date
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-08-01")
        .bind("AG_DUE1")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-08-01")
        .bind("AG_SCHED1")
        .bind("column:scheduled_date")
        .execute(&pool)
        .await
        .unwrap();

    // Filter by column:due_date — should only return AG_DUE1
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-08-01".into()),
        None,
        None,
        Some("column:due_date".into()),
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 1, "should return only due_date items");
    assert_eq!(
        resp.items[0].id, "AG_DUE1",
        "returned item should be the due_date block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_agenda_source_filter_scheduled_date() {
    let (pool, _dir) = test_pool().await;

    // Insert blocks
    insert_block(&pool, "AG_DUE2", "content", "due task", None, None).await;
    insert_block(&pool, "AG_SCHED2", "content", "scheduled task", None, None).await;

    // Insert agenda_cache entries with different sources on the same date
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-08-02")
        .bind("AG_DUE2")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-08-02")
        .bind("AG_SCHED2")
        .bind("column:scheduled_date")
        .execute(&pool)
        .await
        .unwrap();

    // Filter by column:scheduled_date — should only return AG_SCHED2
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-08-02".into()),
        None,
        None,
        Some("column:scheduled_date".into()),
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "should return only scheduled_date items"
    );
    assert_eq!(
        resp.items[0].id, "AG_SCHED2",
        "returned item should be scheduled_date block"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_agenda_no_source_returns_all() {
    let (pool, _dir) = test_pool().await;

    // Insert blocks
    insert_block(&pool, "AG_ALL1", "content", "due task", None, None).await;
    insert_block(&pool, "AG_ALL2", "content", "scheduled task", None, None).await;
    insert_block(&pool, "AG_ALL3", "content", "property task", None, None).await;

    // Insert agenda_cache entries with different sources on the same date
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-08-03")
        .bind("AG_ALL1")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-08-03")
        .bind("AG_ALL2")
        .bind("column:scheduled_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-08-03")
        .bind("AG_ALL3")
        .bind("property:created_at")
        .execute(&pool)
        .await
        .unwrap();

    // No source filter — should return all 3 items (backward compatible)
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        Some("2025-08-03".into()),
        None,
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        3,
        "no source filter should return all agenda items"
    );
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"AG_ALL1"), "should include AG_ALL1");
    assert!(ids.contains(&"AG_ALL2"), "should include AG_ALL2");
    assert!(ids.contains(&"AG_ALL3"), "should include AG_ALL3");
}

// ======================================================================
// list_blocks with agenda_date_range (date range query)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_date_range_returns_blocks_in_range() {
    let (pool, _dir) = test_pool().await;

    // Insert blocks for 3 different dates
    insert_block(&pool, "RNG_BLK1", "content", "task jan 15", None, None).await;
    insert_block(&pool, "RNG_BLK2", "content", "task jan 20", None, None).await;
    insert_block(&pool, "RNG_BLK3", "content", "task feb 05", None, None).await;

    // Insert agenda_cache entries
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-01-15")
        .bind("RNG_BLK1")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-01-20")
        .bind("RNG_BLK2")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-02-05")
        .bind("RNG_BLK3")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();

    // Query full January range — should return BLK1 and BLK2, not BLK3
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        None,
        Some("2025-01-01".into()),
        Some("2025-01-31".into()),
        Some("column:due_date".into()),
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "date range 2025-01-01..2025-01-31 should return 2 items"
    );
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(ids.contains(&"RNG_BLK1"), "BLK1 (jan 15) must be in range");
    assert!(ids.contains(&"RNG_BLK2"), "BLK2 (jan 20) must be in range");
    assert!(
        !ids.contains(&"RNG_BLK3"),
        "BLK3 (feb 05) must NOT be in range"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_date_range_single_day() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "RNG_SD1", "content", "single day task", None, None).await;
    insert_block(&pool, "RNG_SD2", "content", "other day task", None, None).await;

    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-03-15")
        .bind("RNG_SD1")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-03-16")
        .bind("RNG_SD2")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();

    // Range of a single day
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        None,
        Some("2025-03-15".into()),
        Some("2025-03-15".into()),
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 1, "single-day range should return 1 item");
    assert_eq!(
        resp.items[0].id, "RNG_SD1",
        "single-day match should be RNG_SD1"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_with_date_range_validates_format() {
    let (pool, _dir) = test_pool().await;

    // Invalid date format
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        None,
        Some("bad".into()),
        Some("2025-01-31".into()),
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "invalid start date must be rejected: {result:?}"
    );

    // start > end
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        None,
        Some("2025-02-01".into()),
        Some("2025-01-01".into()),
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "start > end must be rejected: {result:?}"
    );

    // Only one of start/end provided
    let result = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        None,
        Some("2025-01-01".into()),
        None,
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await;

    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "only start without end must be rejected: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_blocks_date_range_with_source_filter() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "RNG_SRC1", "content", "due block", None, None).await;
    insert_block(&pool, "RNG_SRC2", "content", "sched block", None, None).await;

    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-04-10")
        .bind("RNG_SRC1")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-04-10")
        .bind("RNG_SRC2")
        .bind("column:scheduled_date")
        .execute(&pool)
        .await
        .unwrap();

    // Range with source filter — only due_date source
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        None,
        Some("2025-04-01".into()),
        Some("2025-04-30".into()),
        Some("column:due_date".into()),
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "source filter should return only due_date items"
    );
    assert_eq!(
        resp.items[0].id, "RNG_SRC1",
        "filtered item should be the due_date block"
    );

    // Without source filter — both items
    let resp = list_blocks_inner(
        &pool,
        None,
        None,
        None,
        None,
        None,
        Some("2025-04-01".into()),
        Some("2025-04-30".into()),
        None,
        None,
        None,
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "no source filter should return all items"
    );
}

// ======================================================================
// count_agenda_batch
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_agenda_batch_empty_dates_returns_empty() {
    let (pool, _dir) = test_pool().await;
    let result = count_agenda_batch_inner(&pool, vec![]).await.unwrap();
    assert!(
        result.is_empty(),
        "empty dates input should return empty map"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_agenda_batch_returns_correct_counts() {
    let (pool, _dir) = test_pool().await;

    // Insert blocks that own the agenda entries
    insert_block(&pool, "AG_BLK1", "content", "task 1", None, None).await;
    insert_block(&pool, "AG_BLK2", "content", "task 2", None, None).await;
    insert_block(&pool, "AG_BLK3", "content", "task 3", None, None).await;

    // Insert agenda_cache entries: 2 items on 2025-06-01, 1 on 2025-06-02
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-06-01")
        .bind("AG_BLK1")
        .bind("property:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-06-01")
        .bind("AG_BLK2")
        .bind("property:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-06-02")
        .bind("AG_BLK3")
        .bind("property:due_date")
        .execute(&pool)
        .await
        .unwrap();

    let result = count_agenda_batch_inner(
        &pool,
        vec![
            "2025-06-01".into(),
            "2025-06-02".into(),
            "2025-06-03".into(),
        ],
    )
    .await
    .unwrap();

    assert_eq!(
        result.get("2025-06-01"),
        Some(&2),
        "June 1 should have 2 entries"
    );
    assert_eq!(
        result.get("2025-06-02"),
        Some(&1),
        "June 2 should have 1 entry"
    );
    assert_eq!(
        result.get("2025-06-03"),
        None,
        "date with no entries should not appear in result"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_agenda_batch_excludes_deleted_blocks() {
    let (pool, _dir) = test_pool().await;

    // Insert one live and one soft-deleted block
    insert_block(&pool, "AG_LIVE", "content", "live", None, None).await;
    insert_block(&pool, "AG_DEL", "content", "deleted", None, None).await;
    // Soft-delete AG_DEL
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = ?")
        .bind("AG_DEL")
        .execute(&pool)
        .await
        .unwrap();

    // Both blocks have agenda entries on the same date
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-07-01")
        .bind("AG_LIVE")
        .bind("property:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-07-01")
        .bind("AG_DEL")
        .bind("property:due_date")
        .execute(&pool)
        .await
        .unwrap();

    let result = count_agenda_batch_inner(&pool, vec!["2025-07-01".into()])
        .await
        .unwrap();

    assert_eq!(
        result.get("2025-07-01"),
        Some(&1),
        "only the live block should be counted"
    );
}

// ======================================================================
// count_agenda_batch_by_source
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_agenda_batch_by_source_empty_dates_returns_empty() {
    let (pool, _dir) = test_pool().await;
    let result = count_agenda_batch_by_source_inner(&pool, vec![])
        .await
        .unwrap();
    assert!(
        result.is_empty(),
        "empty date list should produce empty counts"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_agenda_batch_by_source_returns_correct_breakdown() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BS_BLK1", "content", "task 1", None, None).await;
    insert_block(&pool, "BS_BLK2", "content", "task 2", None, None).await;
    insert_block(&pool, "BS_BLK3", "content", "task 3", None, None).await;

    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-09-01")
        .bind("BS_BLK1")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-09-01")
        .bind("BS_BLK2")
        .bind("column:scheduled_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-09-01")
        .bind("BS_BLK3")
        .bind("property:deadline")
        .execute(&pool)
        .await
        .unwrap();

    let result = count_agenda_batch_by_source_inner(&pool, vec!["2025-09-01".into()])
        .await
        .unwrap();

    let day = result.get("2025-09-01").expect("date should be present");
    assert_eq!(
        day.get("column:due_date"),
        Some(&1),
        "should have 1 due_date entry"
    );
    assert_eq!(
        day.get("column:scheduled_date"),
        Some(&1),
        "should have 1 scheduled_date entry"
    );
    assert_eq!(
        day.get("property:deadline"),
        Some(&1),
        "should have 1 property:deadline entry"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_agenda_batch_by_source_excludes_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BSD_LIVE", "content", "live", None, None).await;
    insert_block(&pool, "BSD_DEL", "content", "deleted", None, None).await;

    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'BSD_DEL'")
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-09-02")
        .bind("BSD_LIVE")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-09-02")
        .bind("BSD_DEL")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();

    let result = count_agenda_batch_by_source_inner(&pool, vec!["2025-09-02".into()])
        .await
        .unwrap();

    let day = result.get("2025-09-02").expect("date should be present");
    assert_eq!(
        day.get("column:due_date"),
        Some(&1),
        "only non-deleted block should be counted"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_agenda_batch_by_source_single_date_returns_expected_counts() {
    // Regression test for PERF-17: json_each conversion preserves single-date semantics.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "SGL_BLK1", "content", "t1", None, None).await;
    insert_block(&pool, "SGL_BLK2", "content", "t2", None, None).await;

    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-10-01")
        .bind("SGL_BLK1")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-10-01")
        .bind("SGL_BLK2")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();

    let result = count_agenda_batch_by_source_inner(&pool, vec!["2025-10-01".into()])
        .await
        .unwrap();

    assert_eq!(result.len(), 1, "result contains exactly one date");
    let day = result.get("2025-10-01").expect("date should be present");
    assert_eq!(day.len(), 1, "day contains exactly one source bucket");
    assert_eq!(
        day.get("column:due_date"),
        Some(&2),
        "single-date query returns correct aggregated count"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_agenda_batch_by_source_missing_dates_not_in_result() {
    // Regression test for PERF-17: dates with no agenda entries are omitted.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "MIS_BLK", "content", "t", None, None).await;
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-11-01")
        .bind("MIS_BLK")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();

    let result = count_agenda_batch_by_source_inner(
        &pool,
        vec![
            "2025-11-01".into(),
            "2025-11-02".into(),
            "2025-11-03".into(),
        ],
    )
    .await
    .unwrap();

    assert_eq!(result.len(), 1, "only the one populated date is returned");
    assert!(
        result.contains_key("2025-11-01"),
        "populated date must be present"
    );
    assert!(
        !result.contains_key("2025-11-02"),
        "missing dates must not appear in result"
    );
    assert!(
        !result.contains_key("2025-11-03"),
        "missing dates must not appear in result"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn count_agenda_batch_by_source_large_input_beyond_sqlite_param_limit() {
    // Regression test for PERF-17: json_each avoids the SQLite ~999 bind-parameter
    // limit that the old `IN (?, ?, …)` format-string approach hit at scale.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BIGAG_BLK1", "content", "t1", None, None).await;
    insert_block(&pool, "BIGAG_BLK2", "content", "t2", None, None).await;

    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-12-25")
        .bind("BIGAG_BLK1")
        .bind("column:due_date")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind("2025-12-26")
        .bind("BIGAG_BLK2")
        .bind("column:scheduled_date")
        .execute(&pool)
        .await
        .unwrap();

    // Build a list of 1100 distinct dates in 2030 (all valid YYYY-MM-DD),
    // plus our two real dates. None of the 1100 will match.
    let mut dates: Vec<String> = Vec::with_capacity(1102);
    let mut day = chrono::NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
    for _ in 0..1100 {
        dates.push(day.format("%Y-%m-%d").to_string());
        day = day.succ_opt().unwrap();
    }
    dates.push("2025-12-25".into());
    dates.push("2025-12-26".into());

    let result = count_agenda_batch_by_source_inner(&pool, dates)
        .await
        .unwrap();

    assert_eq!(result.len(), 2, "only two dates have agenda entries");
    assert_eq!(
        result
            .get("2025-12-25")
            .and_then(|d| d.get("column:due_date")),
        Some(&1),
        "2025-12-25 has one due_date entry"
    );
    assert_eq!(
        result
            .get("2025-12-26")
            .and_then(|d| d.get("column:scheduled_date")),
        Some(&1),
        "2025-12-26 has one scheduled_date entry"
    );
}

// ======================================================================
// list_projected_agenda — projected future occurrences (#644 task 8)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_returns_future_weekly_occurrences() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a block with a due date and repeat rule
    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Weekly task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set due date to 3 weeks before today so the weekly cadence
    // produces today as an exact hit, plus future weeks.
    let today = chrono::Local::now().date_naive();
    let due_date = (today - chrono::Duration::days(21))
        .format("%Y-%m-%d")
        .to_string();
    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some(due_date))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat=weekly
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("weekly".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set todo_state=TODO
    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Project 4 weeks ahead from today
    let start = today.format("%Y-%m-%d").to_string();
    let end = (today + chrono::Duration::days(28))
        .format("%Y-%m-%d")
        .to_string();
    let entries = list_projected_agenda_inner(&pool, start, end, None)
        .await
        .unwrap();

    assert!(
        entries.len() >= 3,
        "should project at least 3 weekly occurrences, got {}",
        entries.len()
    );
    let expected_first = today.format("%Y-%m-%d").to_string();
    let expected_second = (today + chrono::Duration::days(7))
        .format("%Y-%m-%d")
        .to_string();
    let expected_third = (today + chrono::Duration::days(14))
        .format("%Y-%m-%d")
        .to_string();
    assert_eq!(
        entries[0].projected_date, expected_first,
        "first projection"
    );
    assert_eq!(
        entries[1].projected_date, expected_second,
        "second projection"
    );
    assert_eq!(
        entries[2].projected_date, expected_third,
        "third projection"
    );
    assert_eq!(
        entries[0].source, "due_date",
        "projection source should be due_date"
    );
    assert_eq!(
        entries[0].block.id, resp.id,
        "projected block id should match original"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_respects_repeat_until_end_condition() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Limited task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        Some({
            let today = chrono::Local::now().date_naive();
            (today - chrono::Duration::days(14))
                .format("%Y-%m-%d")
                .to_string()
        }),
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("weekly".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat-until to today + 8 days (should allow exactly 2 weekly occurrences:
    // today and today+7, since today+7 < today+8 but today+14 > today+8)
    let today = chrono::Local::now().date_naive();
    let until_date = (today + chrono::Duration::days(8))
        .format("%Y-%m-%d")
        .to_string();
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat-until".into(),
        None,
        None,
        Some(until_date),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let start = today.format("%Y-%m-%d").to_string();
    let end = (today + chrono::Duration::days(60))
        .format("%Y-%m-%d")
        .to_string();
    let entries = list_projected_agenda_inner(&pool, start, end, None)
        .await
        .unwrap();

    assert_eq!(
        entries.len(),
        2,
        "should stop at repeat-until date: {entries:?}"
    );
    let expected_first = today.format("%Y-%m-%d").to_string();
    let expected_second = (today + chrono::Duration::days(7))
        .format("%Y-%m-%d")
        .to_string();
    assert_eq!(
        entries[0].projected_date, expected_first,
        "first projection before until date"
    );
    assert_eq!(
        entries[1].projected_date, expected_second,
        "second projection before until date"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_respects_repeat_count_end_condition() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Counted task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("daily".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Set repeat-count=3, repeat-seq=1 (1 occurrence done, 2 remaining)
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat-count".into(),
        None,
        Some(3.0),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat-seq".into(),
        None,
        Some(1.0),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let entries =
        list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-30".into(), None)
            .await
            .unwrap();

    assert_eq!(
        entries.len(),
        2,
        "should project only 2 remaining occurrences (count=3, seq=1)"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_skips_done_blocks() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Done task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("weekly".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Mark as DONE — should be excluded from projection
    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("DONE".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let entries =
        list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-05-04".into(), None)
            .await
            .unwrap();

    // The original block is DONE, but set_todo_state may have created a new
    // TODO sibling with repeat. Filter to only entries from our block.
    let from_original: Vec<_> = entries.iter().filter(|e| e.block.id == resp.id).collect();
    assert!(
        from_original.is_empty(),
        "DONE blocks should not be projected"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_validates_date_range() {
    let (pool, _dir) = test_pool().await;

    // Invalid date format
    let result =
        list_projected_agenda_inner(&pool, "not-a-date".into(), "2026-04-30".into(), None).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "should reject invalid date"
    );

    // Start > end
    let result =
        list_projected_agenda_inner(&pool, "2026-05-01".into(), "2026-04-01".into(), None).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "should reject start > end"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_empty_when_no_repeating_blocks() {
    let (pool, _dir) = test_pool().await;

    let entries =
        list_projected_agenda_inner(&pool, "2026-04-01".into(), "2026-04-30".into(), None)
            .await
            .unwrap();

    assert!(
        entries.is_empty(),
        "should return empty when no repeating blocks exist"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_dot_plus_mode_projects_from_today() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Water plants".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Due date far in the past
    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2025-01-01".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // From-completion mode: shifts from today
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some(".+weekly".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Query a wide range that includes today + several weeks
    let today = chrono::Local::now().date_naive();
    let start = today.format("%Y-%m-%d").to_string();
    let end = (today + chrono::Duration::days(60))
        .format("%Y-%m-%d")
        .to_string();

    let entries = list_projected_agenda_inner(&pool, start, end, None)
        .await
        .unwrap();

    // .+ mode shifts from today, so first projection should be ~today+7d
    assert!(!entries.is_empty(), ".+ mode should produce projections");
    let first_date =
        chrono::NaiveDate::parse_from_str(&entries[0].projected_date, "%Y-%m-%d").unwrap();
    // First projection should be within 8 days of today (7 days for weekly + 1 day buffer)
    assert!(
        first_date <= today + chrono::Duration::days(8),
        ".+ weekly first projection {first_date} should be near today+7d ({today})"
    );
    assert!(
        first_date > today,
        ".+ first projection should be in the future"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_plus_plus_mode_catches_up_to_today() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Catch-up task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // Due date far in the past
    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2025-01-06".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // ++ mode: advance on original cadence until > today
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("++weekly".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let today = chrono::Local::now().date_naive();
    let start = today.format("%Y-%m-%d").to_string();
    let end = (today + chrono::Duration::days(30))
        .format("%Y-%m-%d")
        .to_string();

    let entries = list_projected_agenda_inner(&pool, start, end, None)
        .await
        .unwrap();

    // ++ mode should produce dates on the original Monday cadence
    // First projection should be the next Monday after today (from 2025-01-06 cadence)
    assert!(!entries.is_empty(), "++ mode should produce projections");
    let first_date =
        chrono::NaiveDate::parse_from_str(&entries[0].projected_date, "%Y-%m-%d").unwrap();
    assert!(
        first_date > today,
        "++ first projection should be in the future"
    );
    // Should be on a Monday (weekday 0 = Monday in chrono)
    assert_eq!(
        first_date.weekday(),
        chrono::Weekday::Mon,
        "++ weekly from Monday cadence should land on Monday, got {first_date}"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_both_date_columns_produce_separate_entries() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Dual dates".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_scheduled_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("weekly".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let entries =
        list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-20".into(), None)
            .await
            .unwrap();

    // Should have entries from both due_date and scheduled_date
    let due_entries: Vec<_> = entries.iter().filter(|e| e.source == "due_date").collect();
    let sched_entries: Vec<_> = entries
        .iter()
        .filter(|e| e.source == "scheduled_date")
        .collect();
    assert!(!due_entries.is_empty(), "should have due_date projections");
    assert!(
        !sched_entries.is_empty(),
        "should have scheduled_date projections"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_exhausted_count_returns_zero() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Exhausted".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("daily".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    // repeat-count=3, repeat-seq=3 → exhausted
    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat-count".into(),
        None,
        Some(3.0),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat-seq".into(),
        None,
        Some(3.0),
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    let entries =
        list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-30".into(), None)
            .await
            .unwrap();

    let from_block: Vec<_> = entries.iter().filter(|e| e.block.id == resp.id).collect();
    assert!(
        from_block.is_empty(),
        "exhausted repeat-count should produce zero projections"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn projected_agenda_limit_caps_results() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let resp = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Daily task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, resp.id.clone(), Some("2026-04-06".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        resp.id.clone(),
        "repeat".into(),
        Some("daily".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_todo_state_inner(&pool, DEV, &mat, resp.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Request 365 days of daily projections but limit to 5
    let entries =
        list_projected_agenda_inner(&pool, "2026-04-07".into(), "2027-04-06".into(), Some(5))
            .await
            .unwrap();

    assert_eq!(entries.len(), 5, "limit should cap results to 5");

    mat.shutdown();
}

// ======================================================================
// Template-page filtering (FEAT-5a — spec line 812)
// ======================================================================
//
// `list_projected_agenda_inner` — and by extension every downstream
// agenda consumer, including the FEAT-5 Google Calendar push — must
// exclude blocks whose owning page carries a `template` property so
// template scaffolding never surfaces in agenda output.
// These tests pin the filter in place on both branches of
// `list_projected_agenda_inner`: the on-the-fly fallback (empty cache)
// and the `projected_agenda_cache` read path (populated cache).

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_projected_agenda_excludes_blocks_under_template_page() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a page, mark it as a template, then create a repeating
    // task nested inside it.  Both blocks go through the real command
    // layer so `page_id` is populated correctly (migration 0027).
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Template library page".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        page.id.clone(),
        "template".into(),
        Some("true".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let task = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Recurring template task".into(),
        Some(page.id.clone()),
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, task.id.clone(), Some("2026-04-06".into()))
        .await
        .unwrap();
    set_property_inner(
        &pool,
        DEV,
        &mat,
        task.id.clone(),
        "repeat".into(),
        Some("daily".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    set_todo_state_inner(&pool, DEV, &mat, task.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Cache path: the materializer has populated `projected_agenda_cache`
    // for the repeating task.  With the template filter, nothing should
    // come back.
    let entries =
        list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-14".into(), None)
            .await
            .unwrap();
    assert_eq!(
        entries.len(),
        0,
        "blocks under a template page must not surface via projected_agenda_cache"
    );

    // On-the-fly path: clear the cache and re-query.  The fallback
    // branch must apply the same filter.
    sqlx::query("DELETE FROM projected_agenda_cache")
        .execute(&pool)
        .await
        .unwrap();
    let entries_on_fly =
        list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-14".into(), None)
            .await
            .unwrap();
    assert_eq!(
        entries_on_fly.len(),
        0,
        "blocks under a template page must not surface via the on-the-fly fallback"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_projected_agenda_includes_block_after_template_property_removed() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Same setup as above: template page → repeating child task.
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "Was a template".into(),
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_property_inner(
        &pool,
        DEV,
        &mat,
        page.id.clone(),
        "template".into(),
        Some("true".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    let task = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Now a real task".into(),
        Some(page.id.clone()),
        None,
    )
    .await
    .unwrap();
    mat.flush_background().await.unwrap();

    set_due_date_inner(&pool, DEV, &mat, task.id.clone(), Some("2026-04-06".into()))
        .await
        .unwrap();
    set_property_inner(
        &pool,
        DEV,
        &mat,
        task.id.clone(),
        "repeat".into(),
        Some("daily".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    set_todo_state_inner(&pool, DEV, &mat, task.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    mat.flush_background().await.unwrap();

    // Sanity: with the template property set, the task is filtered out.
    let filtered =
        list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-10".into(), None)
            .await
            .unwrap();
    assert_eq!(filtered.len(), 0);

    // Remove the template property and the task must re-enter the
    // agenda (on-the-fly path — we clear the cache to keep the test
    // deterministic).
    delete_property_inner(&pool, DEV, &mat, page.id.clone(), "template".into())
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    sqlx::query("DELETE FROM projected_agenda_cache")
        .execute(&pool)
        .await
        .unwrap();

    let entries =
        list_projected_agenda_inner(&pool, "2026-04-07".into(), "2026-04-10".into(), None)
            .await
            .unwrap();
    assert_eq!(
        entries.len(),
        4,
        "expected four daily projections (2026-04-07..2026-04-10) once template flag is cleared"
    );
    for entry in &entries {
        assert_eq!(entry.block.id, task.id);
    }

    mat.shutdown();
}

// ======================================================================
// list_undated_tasks
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_undated_tasks_returns_tasks_without_dates() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a page and a content block with a TODO state but no dates
    let page = create_block_inner(
        &pool,
        DEV,
        &mat,
        "page".into(),
        "TaskPage".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let task = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "undated task".into(),
        Some(page.id.clone()),
        None,
    )
    .await
    .unwrap();
    set_todo_state_inner(&pool, DEV, &mat, task.id.clone(), Some("TODO".into()))
        .await
        .unwrap();

    let resp = list_undated_tasks_inner(&pool, None, None).await.unwrap();
    assert_eq!(
        resp.items.len(),
        1,
        "should return exactly one undated task"
    );
    assert_eq!(
        resp.items[0].id, task.id,
        "returned task id should match the created task"
    );
    assert_eq!(
        resp.items[0].todo_state.as_deref(),
        Some("TODO"),
        "returned task should have TODO state"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_undated_tasks_excludes_dated_tasks() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create a content block with TODO state AND a due_date
    let task = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "dated task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    set_todo_state_inner(&pool, DEV, &mat, task.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    set_due_date_inner(&pool, DEV, &mat, task.id.clone(), Some("2025-06-01".into()))
        .await
        .unwrap();

    let resp = list_undated_tasks_inner(&pool, None, None).await.unwrap();
    assert!(
        resp.items.is_empty(),
        "tasks with due_date should be excluded"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_undated_tasks_excludes_deleted() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let task = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "to delete".into(),
        None,
        None,
    )
    .await
    .unwrap();
    set_todo_state_inner(&pool, DEV, &mat, task.id.clone(), Some("TODO".into()))
        .await
        .unwrap();
    delete_block_inner(&pool, DEV, &mat, task.id.clone())
        .await
        .unwrap();

    let resp = list_undated_tasks_inner(&pool, None, None).await.unwrap();
    assert!(resp.items.is_empty(), "deleted blocks should be excluded");

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_undated_tasks_pagination() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Create 3 undated tasks
    for i in 0..3 {
        let task = create_block_inner(
            &pool,
            DEV,
            &mat,
            "content".into(),
            format!("task {i}"),
            None,
            None,
        )
        .await
        .unwrap();
        set_todo_state_inner(&pool, DEV, &mat, task.id.clone(), Some("TODO".into()))
            .await
            .unwrap();
    }

    // Page 1: limit = 2
    let page1 = list_undated_tasks_inner(&pool, None, Some(2))
        .await
        .unwrap();
    assert_eq!(page1.items.len(), 2, "first page should contain 2 items");
    assert!(
        page1.has_more,
        "first page should indicate more results available"
    );
    assert!(
        page1.next_cursor.is_some(),
        "first page should provide a cursor for next page"
    );

    // Page 2: use cursor
    let page2 = list_undated_tasks_inner(&pool, page1.next_cursor, Some(2))
        .await
        .unwrap();
    assert_eq!(
        page2.items.len(),
        1,
        "second page should contain the remaining 1 item"
    );
    assert!(
        !page2.has_more,
        "second page should indicate no more results"
    );

    mat.shutdown();
}
