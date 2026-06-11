// ======================================================================
// FEAT-5h: DirtyEvent emission from the foreground apply_op path
// ======================================================================
//
// These tests drive the full foreground consumer — not `apply_op`
// directly — so they exercise the `OnceLock<GcalConnectorHandle>`
// plumbing end-to-end: set_gcal_handle, consumer read, per-op
// snapshot, per-op notify.

use super::*;
use crate::gcal_push::connector::{DirtyEvent, GcalConnectorHandle};
use std::sync::Arc as StdArcInner;
use tokio::sync::{Notify, mpsc};

/// Install a freshly-constructed [`GcalConnectorHandle`] on `mat`
/// and return the receiving end so the test can assert on emitted
/// events.
fn wire_up_handle(mat: &Materializer) -> mpsc::UnboundedReceiver<DirtyEvent> {
    let (tx, rx) = mpsc::unbounded_channel::<DirtyEvent>();
    let handle = GcalConnectorHandle::__test_new(tx, StdArcInner::new(Notify::new()));
    mat.set_gcal_handle(handle);
    rx
}

/// Seed a block with the given `due_date` / `scheduled_date`
/// directly via SQL so the test isn't coupled to the command
/// layer.  Returns the block id.
async fn seed_dated_block(pool: &SqlitePool, id: &str, due: Option<&str>, scheduled: Option<&str>) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, due_date, scheduled_date) \
             VALUES (?, 'content', 'task', ?, ?)",
    )
    .bind(id)
    .bind(due)
    .bind(scheduled)
    .execute(pool)
    .await
    .unwrap();
}

/// Today plus `offset` days as an ISO-8601 date string.  We
/// always use today-relative dates because the producer clamps
/// to `[today, today + MAX_WINDOW_DAYS]`.
fn today_plus(offset: i64) -> String {
    (chrono::Local::now().date_naive() + chrono::Duration::days(offset))
        .format("%Y-%m-%d")
        .to_string()
}

fn today_plus_naive(offset: i64) -> chrono::NaiveDate {
    chrono::Local::now().date_naive() + chrono::Duration::days(offset)
}

/// Drain up to `max` events with a short timeout per recv so
/// `rx.recv().await` doesn't hang when fewer events than
/// expected were emitted — the test asserts an exact count
/// afterward.
async fn drain_events(rx: &mut mpsc::UnboundedReceiver<DirtyEvent>, max: usize) -> Vec<DirtyEvent> {
    let mut out = Vec::new();
    for _ in 0..max {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(ev)) => out.push(ev),
            Ok(None) => break,
            Err(_) => break,
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_set_property_due_date_emits_single_dirty_event() {
    // Per FEAT-5h verification: seed a block with
    // `due_date = today+3`, run the materializer with a
    // `SetProperty(due_date = today+4)` op, assert the connector
    // observed exactly **one** `DirtyEvent { old=[today+3],
    // new=[today+4] }`.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let mut rx = wire_up_handle(&mat);

    let old_str = today_plus(3);
    let new_str = today_plus(4);
    seed_dated_block(&pool, "FEAT5H_BLK1", Some(&old_str), None).await;

    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("FEAT5H_BLK1"),
            key: "due_date".into(),
            value_text: None,
            value_num: None,
            value_date: Some(new_str.clone()),
            value_ref: None,
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(
        events.len(),
        1,
        "exactly one DirtyEvent should reach the connector"
    );
    let ev = &events[0];
    assert_eq!(ev.old_affected_dates, vec![today_plus_naive(3)]);
    assert_eq!(ev.new_affected_dates, vec![today_plus_naive(4)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_delete_block_emits_old_only_dirty_event() {
    // DeleteBlock: `old_affected_dates = {due_date, scheduled_date}`,
    // `new_affected_dates = {}` — the connector drops the date on
    // the next cycle.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let mut rx = wire_up_handle(&mat);

    let due_str = today_plus(5);
    let sch_str = today_plus(6);
    seed_dated_block(&pool, "FEAT5H_BLK2", Some(&due_str), Some(&sch_str)).await;

    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("FEAT5H_BLK2"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(events.len(), 1, "exactly one DirtyEvent for DeleteBlock");
    let ev = &events[0];
    assert_eq!(
        ev.old_affected_dates,
        vec![today_plus_naive(5), today_plus_naive(6)]
    );
    assert!(ev.new_affected_dates.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_apply_ops_emits_one_event_per_setting_op() {
    // Bulk-import simulation from the FEAT-5h verification:
    // 100 blocks gaining due_date in one batch → connector
    // observes exactly 100 DirtyEvents.  Our producer does NOT
    // coalesce per op (coalescing happens on the connector side
    // via the DirtySet), so the count is exact.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let mut rx = wire_up_handle(&mat);

    let new_str = today_plus(7);
    let mut records = Vec::with_capacity(100);
    for i in 0..100 {
        let id = format!("FEAT5H_BATCH_{i:03}");
        seed_dated_block(&pool, &id, None, None).await;
        let rec = make_op_record(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::from_trusted(&id),
                key: "due_date".into(),
                value_text: None,
                value_num: None,
                value_date: Some(new_str.clone()),
                value_ref: None,
                value_bool: None,
            }),
        )
        .await;
        records.push(rec);
    }

    // Dispatch as a single BatchApplyOps task so the
    // transaction-wrapped path is exercised.
    mat.enqueue_foreground(MaterializeTask::BatchApplyOps(StdArc::new(records)))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();

    let events = drain_events(&mut rx, 150).await;
    assert_eq!(
        events.len(),
        100,
        "one DirtyEvent per op in the batch — no coalescing at the producer",
    );
    for ev in events {
        assert!(ev.old_affected_dates.is_empty());
        assert_eq!(ev.new_affected_dates, vec![today_plus_naive(7)]);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn no_handle_set_is_silent_noop() {
    // A `Materializer` without `set_gcal_handle` called must
    // apply ops normally — no panic, no hang.  This exercises
    // the `OnceLock::get() == None` branch in the handler.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // Deliberately DO NOT call `wire_up_handle`.

    let due_str = today_plus(2);
    seed_dated_block(&pool, "FEAT5H_BLK_NOHDL", None, None).await;

    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("FEAT5H_BLK_NOHDL"),
            key: "due_date".into(),
            value_text: None,
            value_num: None,
            value_date: Some(due_str.clone()),
            value_ref: None,
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();

    // Verify the op was actually applied.
    let row = sqlx::query_as::<_, (Option<String>,)>(
        "SELECT due_date FROM blocks WHERE id = 'FEAT5H_BLK_NOHDL'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0.as_deref(), Some(due_str.as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_gcal_handle_rejects_second_call() {
    // `OnceLock` semantics: second `set_gcal_handle` must not
    // replace the first.  The first handle stays wired; the
    // second call logs a warn and is dropped.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let (tx1, mut rx1) = mpsc::unbounded_channel::<DirtyEvent>();
    let handle1 = GcalConnectorHandle::__test_new(tx1, StdArcInner::new(Notify::new()));
    mat.set_gcal_handle(handle1);

    let (tx2, mut rx2) = mpsc::unbounded_channel::<DirtyEvent>();
    let handle2 = GcalConnectorHandle::__test_new(tx2, StdArcInner::new(Notify::new()));
    mat.set_gcal_handle(handle2);

    // Drive an op that should produce a DirtyEvent.
    let due_str = today_plus(8);
    seed_dated_block(&pool, "FEAT5H_DUP", Some(&due_str), None).await;
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("FEAT5H_DUP"),
            key: "todo_state".into(),
            value_text: Some("DONE".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();

    // Handle 1 should see the event; handle 2 (the rejected
    // override) should see nothing.
    let on_first = drain_events(&mut rx1, 5).await;
    let on_second = drain_events(&mut rx2, 5).await;
    assert_eq!(on_first.len(), 1, "first handle still wired");
    assert_eq!(on_second.len(), 0, "second handle was rejected");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_set_property_non_agenda_key_emits_nothing() {
    // A SetProperty on a non-agenda-relevant key (e.g., "assignee")
    // must NOT wake the connector — the producer returns None.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let mut rx = wire_up_handle(&mat);

    seed_dated_block(&pool, "FEAT5H_ASSIGN", Some(&today_plus(3)), None).await;
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("FEAT5H_ASSIGN"),
            key: "assignee".into(),
            value_text: Some("alice".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();

    let events = drain_events(&mut rx, 5).await;
    assert_eq!(events.len(), 0, "no event for non-agenda property key");
}
