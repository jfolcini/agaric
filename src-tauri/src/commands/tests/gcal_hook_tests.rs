//! FEAT-5i — integration tests for the local-command `DirtyEvent`
//! producer path.  Mirrors the FEAT-5h tests in
//! `materializer/tests.rs::gcal_hook` but exercises the command
//! handlers (`set_property_inner`, `delete_property_inner`,
//! `edit_block_inner`, `delete_block_inner`, `restore_block_inner`)
//! end-to-end so the pre-commit snapshot + post-commit notify
//! pattern is verified from every caller.

#![allow(unused_imports)]

use super::super::*;
use super::common::*;
use crate::gcal_push::connector::{DirtyEvent, GcalConnectorHandle};
use crate::materializer::Materializer;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Notify};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Wire a fresh [`GcalConnectorHandle`] into the materializer and
/// return its receiver.  One call per test; the handle is single-use
/// because the materializer's `OnceLock` rejects the second
/// `set_gcal_handle` call.
fn wire_up_handle(mat: &Materializer) -> mpsc::UnboundedReceiver<DirtyEvent> {
    let (tx, rx) = mpsc::unbounded_channel::<DirtyEvent>();
    let handle = GcalConnectorHandle::__test_new(tx, Arc::new(Notify::new()));
    mat.set_gcal_handle(handle);
    rx
}

/// Drain up to `max` events with a short per-recv timeout.  Tests
/// assert exact counts afterward; the timeout only prevents hangs
/// when fewer events than expected were emitted.
async fn drain_events(rx: &mut mpsc::UnboundedReceiver<DirtyEvent>, max: usize) -> Vec<DirtyEvent> {
    let mut out = Vec::new();
    for _ in 0..max {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(ev)) => out.push(ev),
            Ok(None) | Err(_) => break,
        }
    }
    out
}

/// Today-relative date string so tests don't run into the producer's
/// `[today, today + MAX_WINDOW_DAYS]` clamp at run time.
fn today_plus(offset: i64) -> String {
    (chrono::Local::now().date_naive() + chrono::Duration::days(offset))
        .format("%Y-%m-%d")
        .to_string()
}

fn today_plus_naive(offset: i64) -> chrono::NaiveDate {
    chrono::Local::now().date_naive() + chrono::Duration::days(offset)
}

// ---------------------------------------------------------------------------
// set_property_inner → SetProperty(due_date)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_due_date_emits_single_dirty_event() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let mut rx = wire_up_handle(&mat);

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let old_str = today_plus(3);
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some(old_str.clone()),
        None,
        None,
    )
    .await
    .unwrap();
    // Drain the priming event emitted by the first set (old=None,
    // new=[today+3]).
    let primed = drain_events(&mut rx, 5).await;
    assert_eq!(primed.len(), 1);

    // Act: move the due_date to today+4.
    let new_str = today_plus(4);
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some(new_str.clone()),
        None,
        None,
    )
    .await
    .unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(events.len(), 1, "exactly one DirtyEvent per op");
    let ev = &events[0];
    assert_eq!(ev.old_affected_dates, vec![today_plus_naive(3)]);
    assert_eq!(ev.new_affected_dates, vec![today_plus_naive(4)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_todo_state_emits_single_dirty_event() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // Create + set due_date BEFORE wiring the handle so we don't
    // observe priming events.
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let date_str = today_plus(5);
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some(date_str),
        None,
        None,
    )
    .await
    .unwrap();

    // NOW wire the handle — subsequent ops should notify.
    let mut rx = wire_up_handle(&mat);

    set_todo_state_inner(&pool, DEV, &mat, block.id.clone(), Some("DONE".into()))
        .await
        .unwrap();

    let events = drain_events(&mut rx, 5).await;
    // set_todo_state_inner fires set_property_inner twice in the
    // null→DONE path (todo_state + completed_at via the
    // completed_at property set).  Both go through our hook, but
    // only `todo_state` is an agenda-relevant key — the
    // `completed_at` set emits `compute_dirty_event = None` because
    // `completed_at` is not on the whitelist.  Exact count: 1.
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].old_affected_dates, vec![today_plus_naive(5)]);
    assert_eq!(events[0].new_affected_dates, vec![today_plus_naive(5)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_property_non_agenda_key_emits_zero_events() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some(today_plus(2)),
        None,
        None,
    )
    .await
    .unwrap();

    let mut rx = wire_up_handle(&mat);

    // "assignee" is not in the agenda-relevant whitelist.
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "assignee".into(),
        Some("alice".into()),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(events.len(), 0);
}

// ---------------------------------------------------------------------------
// delete_property_inner
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_property_due_date_emits_dirty_event() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let date_str = today_plus(6);
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some(date_str),
        None,
        None,
    )
    .await
    .unwrap();

    let mut rx = wire_up_handle(&mat);

    delete_property_inner(&pool, DEV, &mat, block.id.clone(), "due_date".into())
        .await
        .unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].old_affected_dates, vec![today_plus_naive(6)]);
    assert!(events[0].new_affected_dates.is_empty());
}

// ---------------------------------------------------------------------------
// edit_block_inner
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_with_date_emits_dirty_event() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Buy milk".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let date_str = today_plus(4);
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some(date_str),
        None,
        None,
    )
    .await
    .unwrap();

    let mut rx = wire_up_handle(&mat);

    edit_block_inner(&pool, DEV, &mat, block.id.clone(), "Buy almond milk".into())
        .await
        .unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(events.len(), 1);
    let ev = &events[0];
    assert_eq!(ev.old_affected_dates, vec![today_plus_naive(4)]);
    assert_eq!(ev.new_affected_dates, vec![today_plus_naive(4)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_block_without_date_emits_zero_events() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "Random note".into(),
        None,
        None,
    )
    .await
    .unwrap();

    let mut rx = wire_up_handle(&mat);

    edit_block_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "Random note — edited".into(),
    )
    .await
    .unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(events.len(), 0);
}

// ---------------------------------------------------------------------------
// delete_block_inner / restore_block_inner
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_block_emits_old_only_dirty_event() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some(today_plus(7)),
        None,
        None,
    )
    .await
    .unwrap();
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "scheduled_date".into(),
        None,
        None,
        Some(today_plus(8)),
        None,
        None,
    )
    .await
    .unwrap();

    let mut rx = wire_up_handle(&mat);

    delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(events.len(), 1);
    let ev = &events[0];
    assert_eq!(
        ev.old_affected_dates,
        vec![today_plus_naive(7), today_plus_naive(8)]
    );
    assert!(ev.new_affected_dates.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_emits_new_only_dirty_event() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some(today_plus(9)),
        None,
        None,
    )
    .await
    .unwrap();
    let del = delete_block_inner(&pool, DEV, &mat, block.id.clone())
        .await
        .unwrap();

    let mut rx = wire_up_handle(&mat);

    restore_block_inner(&pool, DEV, &mat, block.id.clone(), del.deleted_at)
        .await
        .unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(events.len(), 1);
    let ev = &events[0];
    assert!(ev.old_affected_dates.is_empty());
    assert_eq!(ev.new_affected_dates, vec![today_plus_naive(9)]);
}

// ---------------------------------------------------------------------------
// No-handle-wired path (is_gcal_hook_active == false)
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_handle_set_property_commits_cleanly() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // Deliberately DO NOT wire a handle.

    let block = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "task".into(),
        None,
        None,
    )
    .await
    .unwrap();
    let due_str = today_plus(2);
    let updated = set_property_inner(
        &pool,
        DEV,
        &mat,
        block.id.clone(),
        "due_date".into(),
        None,
        None,
        Some(due_str.clone()),
        None,
        None,
    )
    .await
    .unwrap();

    assert_eq!(updated.due_date.as_deref(), Some(due_str.as_str()));
}
