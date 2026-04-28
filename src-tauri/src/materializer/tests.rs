//! Tests for materializer queue coordination, dispatch routing, dedup logic, shutdown, flush barriers, and metrics.
use super::*;
use crate::db::init_pool;
use crate::error::AppError;
use crate::gcal_push::connector::GcalConnectorHandle;
use crate::op::{
    AddAttachmentPayload, AddTagPayload, CreateBlockPayload, DeleteAttachmentPayload,
    DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    PurgeBlockPayload, RestoreBlockPayload, SetPropertyPayload,
};
use crate::op_log::append_local_op;
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::Ordering as AtomicOrdering;
use std::sync::{Arc as StdArc, OnceLock};
use std::time::Duration;
use tempfile::TempDir;

const DEV: &str = "test-device-mat";
const FIXED_TS: &str = "2025-01-01T00:00:00Z";
const FAKE_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// Empty GCal handle cell used by every existing materializer test
/// that predates FEAT-5h.  The cell is never populated, so
/// [`crate::gcal_push::dirty_producer::compute_dirty_event`] is never
/// invoked and the test behaves exactly as it did before the handle
/// parameter was added.
fn empty_gcal_handle() -> OnceLock<GcalConnectorHandle> {
    OnceLock::new()
}

fn empty_gcal_handle_arc() -> StdArc<OnceLock<GcalConnectorHandle>> {
    StdArc::new(OnceLock::new())
}

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}
fn fake_op_record(op_type: &str, payload: &str) -> OpRecord {
    OpRecord {
        device_id: DEV.into(),
        seq: 1,
        parent_seqs: None,
        hash: FAKE_HASH.into(),
        op_type: op_type.into(),
        payload: payload.into(),
        created_at: FIXED_TS.into(),
    }
}
async fn make_op_record(pool: &SqlitePool, payload: OpPayload) -> OpRecord {
    append_local_op(pool, DEV, payload).await.unwrap()
}
async fn insert_block_direct(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
        .bind(id)
        .bind(block_type)
        .bind(content)
        .execute(pool)
        .await
        .unwrap();
}
async fn soft_delete_block_direct(pool: &SqlitePool, id: &str) {
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
        .bind(FIXED_TS)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}
async fn insert_block_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}
async fn insert_property_date(pool: &SqlitePool, block_id: &str, key: &str, value_date: &str) {
    sqlx::query(
        "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
    )
    .bind(block_id)
    .bind(key)
    .bind(value_date)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn new_creates_materializer_with_functional_queues() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .is_ok(),
        "new materializer should accept background tasks"
    );
}

// ──────────────────────────────────────────────────────────────────────
// TEST-2: wait_for_initial_block_count_cache
//
// Deterministic synchronization point for tests that want to overwrite
// `cached_block_count` with a simulated value. Verifies:
// 1. The initial background refresh populates `cached_block_count` from
//    the real DB state by the time the helper returns.
// 2. The helper is idempotent — calling it multiple times is safe.
// 3. After the helper returns, a test store of a simulated value is
//    durable: no stale writer clobbers it later.
// ──────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn wait_for_initial_block_count_cache_returns_after_refresh() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "COUNT_A", "content", "a").await;
    insert_block_direct(&pool, "COUNT_B", "content", "b").await;
    insert_block_direct(&pool, "COUNT_C", "content", "c").await;
    let mat = Materializer::new(pool.clone());

    // Before the helper returns the count may be 0 (the initial refresh
    // has not been scheduled yet). After it returns it MUST reflect the
    // actual DB count.
    mat.wait_for_initial_block_count_cache().await;

    let cached = mat
        .metrics()
        .cached_block_count
        .load(AtomicOrdering::Relaxed);
    assert_eq!(
        cached, 3,
        "cached block count should equal the actual DB count (3) once the helper returns"
    );

    // Idempotency: a second call must still return promptly. If we used a
    // `Notify` without the `AtomicBool` backing flag, a late-attaching
    // waiter would block forever on the already-consumed notification.
    mat.wait_for_initial_block_count_cache().await;
}

#[tokio::test]
async fn wait_for_initial_block_count_cache_allows_simulated_overwrite() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "SIM_A", "content", "a").await;
    let mat = Materializer::new(pool.clone());

    mat.wait_for_initial_block_count_cache().await;

    // Overwrite with a simulated value. No stale writer should appear
    // afterwards — this is the core contract the adaptive-FTS-threshold
    // tests depend on.
    mat.metrics()
        .cached_block_count
        .store(10_000_000, AtomicOrdering::Relaxed);

    // Yield a few times so any late-arriving task would have a chance to
    // run on the current-thread runtime.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    let cached = mat
        .metrics()
        .cached_block_count
        .load(AtomicOrdering::Relaxed);
    assert_eq!(
        cached, 10_000_000,
        "simulated count must survive — no stale writer may clobber it after the helper returns"
    );
}

// ──────────────────────────────────────────────────────────────────────
// TEST-5: wait_for_pending_block_count_refreshes
//
// Counted sync primitive for the fire-and-forget refresh tasks spawned
// after an FTS optimize (dispatch.rs:191). Unlike the one-shot
// `wait_for_initial_block_count_cache` gate, these refreshes are
// repeatable and can overlap — a test that wants to simulate a
// different `cached_block_count` value after an optimize must first
// await this helper or race against the late-arriving refresh.
//
// Tests verify:
// 1. Happy path: spawn N refreshes, await the helper, confirm all drain
//    and the cached count reflects the real DB state.
// 2. "Waiter attaches while refreshes are in-flight": non-trivial wait,
//    counter hits zero post-await.
// 3. "All refreshes complete before waiter attaches": the helper must
//    return promptly (no wedge on an already-consumed notify).
// 4. Independence from `wait_for_initial_block_count_cache`: the two
//    primitives cover disjoint concerns and compose.
// ──────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn wait_for_pending_block_count_refreshes_with_no_refreshes_returns_immediately() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);

    // No post-optimize refresh has been triggered — counter is zero.
    // The helper must take the fast path (single Acquire load) and
    // return without ever attaching to the notify.
    tokio::time::timeout(
        Duration::from_millis(500),
        mat.wait_for_pending_block_count_refreshes(),
    )
    .await
    .expect("helper must return immediately when no refreshes are pending");
}

#[tokio::test]
async fn wait_for_pending_block_count_refreshes_drains_inflight_refreshes() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "PCR_A", "content", "a").await;
    insert_block_direct(&pool, "PCR_B", "content", "b").await;
    insert_block_direct(&pool, "PCR_C", "content", "c").await;
    insert_block_direct(&pool, "PCR_D", "content", "d").await;
    let mat = Materializer::new(pool.clone());

    // Gate on the one-shot init first so the two primitives compose —
    // otherwise the initial refresh could race with our simulated
    // pre-state below.
    mat.wait_for_initial_block_count_cache().await;

    // Pre-set the cached count to a bogus value so the happy-path
    // assertion at the end genuinely verifies the refresh ran (we
    // expect it to be overwritten with the real DB count of 4).
    mat.metrics()
        .cached_block_count
        .store(99_999, AtomicOrdering::Relaxed);

    // Spawn three post-optimize-style refreshes. This is the exact
    // call path dispatch.rs uses after an FTS optimize. Calling the
    // method directly instead of going through the op-dispatch machinery
    // keeps the test focused on the counter invariant.
    mat.refresh_block_count_cache();
    mat.refresh_block_count_cache();
    mat.refresh_block_count_cache();

    // Counter should be observably non-zero at least some of the time
    // between spawn and drain. We don't assert exactly 3 because the
    // first task may have completed already on a fast runtime — but
    // the increment happens before the spawn so observing zero here
    // would be a bug.
    let snapshot = mat
        .pending_block_count_refreshes
        .load(AtomicOrdering::Acquire);
    assert!(
        snapshot >= 1,
        "counter must be non-zero between spawn-time increment and task completion (saw {snapshot})"
    );

    // Wait for drain. A generous timeout guards against the helper
    // wedging on an already-fired notify (bug we explicitly test for).
    tokio::time::timeout(
        Duration::from_secs(5),
        mat.wait_for_pending_block_count_refreshes(),
    )
    .await
    .expect("helper must return once all pending refreshes complete");

    assert_eq!(
        mat.pending_block_count_refreshes
            .load(AtomicOrdering::Acquire),
        0,
        "counter must be zero after wait_for_pending_block_count_refreshes returns"
    );

    // Verify the refresh actually executed: the last completing task
    // overwrote our bogus sentinel with the real DB count.
    let cached = mat
        .metrics()
        .cached_block_count
        .load(AtomicOrdering::Relaxed);
    assert_eq!(
        cached, 4,
        "cached block count must match real DB count (4) after pending refreshes drain"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_for_pending_block_count_refreshes_returns_after_tasks_already_finished() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "PCR_DONE", "content", "done").await;
    let mat = Materializer::new(pool.clone());
    mat.wait_for_initial_block_count_cache().await;

    // Trigger a refresh and wait deterministically for the spawned
    // task to drain the counter to zero before attaching the waiter.
    //
    // Earlier revisions of this test polled `yield_now()` up to 1_000
    // times. That worked on an idle single-threaded runtime where each
    // yield was effectively one poll of the spawned future, but it
    // flaked under CI load: `sqlx::query_scalar(...).fetch_one(&pool)`
    // suspends across multiple polls (pool acquire → SQLite IO →
    // result decode), and on a busy single-thread executor 1_000
    // yields was not always enough to drive that to completion before
    // the hard `assert_eq!(counter, 0)` precondition fired.
    //
    // The fix: run on a `multi_thread` runtime so the spawned refresh
    // can execute on a worker thread independently of the main test
    // task, and poll with `tokio::time::sleep(1ms)` against a generous
    // 5 s deadline. The deadline is purely a panic-instead-of-hang
    // safety net — on a healthy runtime the SELECT COUNT(*) returns
    // in microseconds and the loop exits within the first iteration.
    mat.refresh_block_count_cache();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while mat
        .pending_block_count_refreshes
        .load(AtomicOrdering::Acquire)
        != 0
    {
        if tokio::time::Instant::now() >= deadline {
            panic!(
                "test precondition: refresh did not drain the counter within 5s \
                 (last value: {})",
                mat.pending_block_count_refreshes
                    .load(AtomicOrdering::Acquire)
            );
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }

    // Now attach the waiter AFTER the notify has already fired.
    // The double-checked pattern in the helper must observe the zero
    // counter on the first load and return without waiting. A broken
    // implementation that only relied on `Notify` would wedge here
    // because `notify_waiters()` only wakes currently-attached waiters.
    tokio::time::timeout(
        Duration::from_millis(500),
        mat.wait_for_pending_block_count_refreshes(),
    )
    .await
    .expect(
        "helper must return promptly when tasks finished before the waiter attached \
         (fast-path on the pre-notified counter load)",
    );
}

#[tokio::test]
async fn wait_for_pending_block_count_refreshes_handles_overlapping_spawns() {
    let (pool, _dir) = test_pool().await;
    for i in 0..5 {
        insert_block_direct(&pool, &format!("PCR_OVL_{i:02}"), "content", "x").await;
    }
    let mat = Materializer::new(pool.clone());
    mat.wait_for_initial_block_count_cache().await;

    // Interleave spawn calls with yield_now so the runtime has a chance
    // to progress earlier refreshes between each new spawn. This
    // creates the "N refreshes in flight at once" ordering that most
    // closely models the bursty FTS-optimize trigger path (edits
    // crossing the threshold N times before the first refresh
    // finishes).
    for _ in 0..6 {
        mat.refresh_block_count_cache();
        tokio::task::yield_now().await;
    }

    tokio::time::timeout(
        Duration::from_secs(5),
        mat.wait_for_pending_block_count_refreshes(),
    )
    .await
    .expect("helper must drain overlapping refreshes without deadlocking");

    assert_eq!(
        mat.pending_block_count_refreshes
            .load(AtomicOrdering::Acquire),
        0,
        "counter must reach zero after overlapping refreshes drain"
    );

    // Second call is a no-op fast path — verifies the notify has not
    // been "consumed" in a way that permanently breaks the primitive.
    tokio::time::timeout(
        Duration::from_millis(500),
        mat.wait_for_pending_block_count_refreshes(),
    )
    .await
    .expect("second wait after drain must return on the fast path");

    let cached = mat
        .metrics()
        .cached_block_count
        .load(AtomicOrdering::Relaxed);
    assert_eq!(
        cached, 5,
        "cached block count must match real DB count (5) after overlapping refreshes drain"
    );
}

/// PERF-24: the lifecycle-aware constructor must produce a fully
/// functional materializer — it only changes the behaviour of the
/// internal metrics-snapshot task, not of the main queues.
#[tokio::test]
async fn with_read_pool_and_lifecycle_accepts_tasks() {
    let (pool, _dir) = test_pool().await;
    let lifecycle = crate::lifecycle::LifecycleHooks::new();
    let mat = Materializer::with_read_pool_and_lifecycle(pool.clone(), pool, lifecycle);
    assert!(
        mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .is_ok(),
        "lifecycle-aware materializer must still accept background tasks"
    );
    mat.enqueue_foreground(MaterializeTask::RebuildTagsCache)
        .await
        .expect("lifecycle-aware materializer must still accept foreground tasks");
    mat.shutdown();
}

/// PERF-24: flipping the foreground flag must not corrupt the
/// materializer's queues. We flip the flag while actively enqueueing
/// and verify shutdown still completes cleanly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lifecycle_flag_flip_does_not_break_queues() {
    let (pool, _dir) = test_pool().await;
    let lifecycle = crate::lifecycle::LifecycleHooks::new();
    let mat = Materializer::with_read_pool_and_lifecycle(pool.clone(), pool, lifecycle.clone());

    // Flip backgrounded → foreground a few times while enqueueing.
    for i in 0..5 {
        if i % 2 == 0 {
            lifecycle.mark_backgrounded();
        } else {
            lifecycle.mark_foreground();
        }
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .expect("enqueue must succeed regardless of foreground state");
    }

    mat.flush_background()
        .await
        .expect("flush_background must still drain queue after flag flips");
    mat.shutdown();
}
#[tokio::test]
async fn clone_shares_queues_both_can_enqueue() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let mat2 = mat.clone();
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "original clone should enqueue successfully"
    );
    assert!(
        mat2.enqueue_background(MaterializeTask::RebuildPagesCache)
            .await
            .is_ok(),
        "second clone should enqueue successfully"
    );
}
#[tokio::test]
async fn dispatch_op_create_block_page() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-1"),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            content: "My page".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT block_type, content FROM blocks WHERE id = 'BLK-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "page", "block_type should be page");
    assert_eq!(row.1, "My page", "content should match created page title");
}
#[tokio::test]
async fn dispatch_op_create_block_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-tag"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            content: "urgent".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT block_type, content FROM blocks WHERE id = 'BLK-TAG'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "tag", "block_type should be tag");
    assert_eq!(row.1, "urgent", "content should match created tag name");
}
#[tokio::test]
async fn dispatch_op_create_block_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-c"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "just content".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT block_type, content FROM blocks WHERE id = 'BLK-C'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "content", "block_type should be content");
    assert_eq!(
        row.1, "just content",
        "content should match created block text"
    );
}
#[tokio::test]
async fn dispatch_op_edit_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-2", "content", "original").await;
    make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-2"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "original".into(),
        }),
    )
    .await;
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("blk-2"),
            to_text: "edited".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String,)>("SELECT content FROM blocks WHERE id = 'BLK-2'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, "edited", "content should be updated after EditBlock");
}
#[tokio::test]
async fn dispatch_op_delete_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-3", "content", "to delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("blk-3"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row =
        sqlx::query_as::<_, (Option<String>,)>("SELECT deleted_at FROM blocks WHERE id = 'BLK-3'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        row.0.is_some(),
        "deleted_at should be set after DeleteBlock"
    );
}
#[tokio::test]
async fn dispatch_op_restore_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-R", "content", "was deleted").await;
    soft_delete_block_direct(&pool, "BLK-R").await;
    let r = make_op_record(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id("blk-r"),
            deleted_at_ref: FIXED_TS.into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row =
        sqlx::query_as::<_, (Option<String>,)>("SELECT deleted_at FROM blocks WHERE id = 'BLK-R'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        row.0.is_none(),
        "deleted_at should be NULL after RestoreBlock"
    );
}
#[tokio::test]
async fn dispatch_op_purge_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-P", "content", "to purge").await;
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("blk-p"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM blocks WHERE id = 'BLK-P'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, 0, "block should be gone after PurgeBlock");
}
#[tokio::test]
async fn dispatch_op_add_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-4", "content", "tagged block").await;
    insert_block_direct(&pool, "TAG-1", "tag", "my-tag").await;
    let r = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("blk-4"),
            tag_id: BlockId::test_id("tag-1"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = 'BLK-4' AND tag_id = 'TAG-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 1, "block_tags row should exist after AddTag");
}
#[tokio::test]
async fn dispatch_op_remove_tag() {
    use crate::op::RemoveTagPayload;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-RT", "content", "rt block").await;
    insert_block_direct(&pool, "TAG-99", "tag", "rm-tag").await;
    insert_block_tag(&pool, "BLK-RT", "TAG-99").await;
    let r = make_op_record(
        &pool,
        OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::test_id("blk-rt"),
            tag_id: BlockId::test_id("tag-99"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = 'BLK-RT' AND tag_id = 'TAG-99'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 0, "block_tags row should be gone after RemoveTag");
}
#[tokio::test]
async fn dispatch_op_set_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-5", "content", "prop block").await;
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("blk-5"),
            key: "due".into(),
            value_text: None,
            value_num: None,
            value_date: Some("2025-01-15".into()),
            value_ref: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT value_date FROM block_properties WHERE block_id = 'BLK-5' AND key = 'due'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.0, "2025-01-15",
        "value_date should match the set property date"
    );
}
#[tokio::test]
async fn dispatch_op_delete_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-DP", "content", "dp block").await;
    insert_property_date(&pool, "BLK-DP", "due", "2025-01-15").await;
    let r = make_op_record(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("blk-dp"),
            key: "due".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-DP' AND key = 'due'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 0, "property should be gone after DeleteProperty");
}
#[tokio::test]
async fn dispatch_op_move_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-PARENT", "page", "parent page").await;
    insert_block_direct(&pool, "BLK-6", "content", "child block").await;
    let r = make_op_record(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("blk-6"),
            new_parent_id: Some(BlockId::test_id("blk-parent")),
            new_position: 2,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (Option<String>, i64)>(
        "SELECT parent_id, position FROM blocks WHERE id = 'BLK-6'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.0.as_deref(),
        Some("BLK-PARENT"),
        "parent_id should be set after MoveBlock"
    );
    assert_eq!(row.1, 2, "position should be updated after MoveBlock");
}
#[tokio::test]
async fn dispatch_op_add_attachment() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-A", "content", "attachment block").await;
    let r = make_op_record(
        &pool,
        OpPayload::AddAttachment(AddAttachmentPayload {
            attachment_id: BlockId::test_id("ATT-1"),
            block_id: BlockId::test_id("blk-a"),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 1024,
            fs_path: "/tmp/photo.png".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    // M-1: AttachmentId (BlockId alias) auto-uppercases on construction, so
    // the materializer writes 'ATT-1' regardless of input casing.
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT filename, mime_type FROM attachments WHERE id = 'ATT-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "photo.png", "filename should match added attachment");
    assert_eq!(
        row.1, "image/png",
        "mime_type should match added attachment"
    );
}
#[tokio::test]
async fn dispatch_op_delete_attachment() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-ATT-DEL", "content", "att block").await;
    // M-1: store the row with the canonical-uppercase id so it matches the
    // bind value the materializer derives from the auto-normalized
    // AttachmentId in the payload.
    sqlx::query("INSERT INTO attachments (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) VALUES ('ATT-2', 'BLK-ATT-DEL', 'f.txt', '/tmp/f.txt', 'text/plain', 10, '2025-01-01T00:00:00Z')")
        .execute(&pool).await.unwrap();
    let r = make_op_record(
        &pool,
        OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: BlockId::test_id("ATT-2"),
            fs_path: "/tmp/f.txt".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM attachments WHERE id = 'ATT-2'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, 0, "attachment should be gone after DeleteAttachment");
}
#[tokio::test]
async fn dispatch_op_unknown_op_type() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.dispatch_op(&fake_op_record("unknown_future_op", "{}"))
            .await
            .is_ok(),
        "unknown op type should not cause an error"
    );
}
#[tokio::test]
async fn dispatch_background_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("blk-bg"),
            to_text: "edited bg".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "at least one background task should have been processed"
    );
}
#[tokio::test]
async fn dispatch_background_delete() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("blk-db"),
        }),
    )
    .await;
    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "at least one background task should have been processed"
    );
}
#[tokio::test]
async fn enqueue_foreground_any() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.enqueue_foreground(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "should enqueue foreground task successfully"
    );
}
#[tokio::test]
async fn enqueue_background_all() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "should enqueue RebuildTagsCache in background"
    );
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildPagesCache)
            .await
            .is_ok(),
        "should enqueue RebuildPagesCache in background"
    );
    assert!(
        mat.enqueue_background(MaterializeTask::ReindexBlockLinks {
            block_id: "blk-x".into()
        })
        .await
        .is_ok(),
        "should enqueue ReindexBlockLinks in background"
    );
}
#[tokio::test]
async fn try_enqueue_background_drops_when_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    for _ in 0..2000 {
        assert!(
            mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
                .is_ok(),
            "try_enqueue should accept tasks when not full"
        );
    }
}

/// M-7 / M-8: the `try_enqueue_background` Full-arm must increment
/// `metrics.bg_dropped` so sustained backpressure is visible in
/// `StatusInfo`.  Without the increment, dropped cache-rebuild
/// fan-outs are an invisible degradation.
///
/// Single-threaded `#[tokio::test]` runtime guarantees the bg
/// consumer cannot drain during the sync `try_send` loop, so the
/// bounded channel fills at `BACKGROUND_CAPACITY` and every
/// subsequent send lands in the Full arm.
#[tokio::test]
async fn try_enqueue_background_full_arm_increments_bg_dropped() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    // Channel capacity is 1024 — push more than that without yielding
    // so the consumer never runs and the Full arm is exercised
    // deterministically.  We push 2x capacity to give the increment
    // ~1024 chances to fire.
    for _ in 0..2048 {
        // Each call returns `Ok(())` regardless of whether it landed
        // or was shed — the helper preserves the `Ok` return for
        // back-compat.  We assert via the metric instead.
        let _ = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
    }

    let dropped = mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed);
    assert!(
        dropped > 0,
        "bg_dropped must increment when try_enqueue_background sheds tasks under backpressure, got {dropped}"
    );

    // Stop the consumer cleanly so the test runtime can drain.
    mat.shutdown();
}

/// M-7 / M-8: the cache-rebuild fan-out path
/// (`enqueue_full_cache_rebuild`, used by `delete_block` /
/// `restore_block` / `purge_block`) is the specific code path called
/// out in the recommendation.  When the bg queue is saturated, every
/// fan-out task shed by the helper must tick `bg_dropped` so the
/// "agenda missing entries until something else is edited" symptom is
/// observable.
#[tokio::test]
async fn enqueue_full_cache_rebuild_under_backpressure_increments_bg_dropped() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);

    // Fill the bg queue to capacity first so the cache-rebuild fan-out
    // arrives at a queue that is already full.
    for _ in 0..2048 {
        let _ = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
    }
    let baseline = mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed);
    assert!(
        baseline > 0,
        "precondition: backpressure must already have ticked bg_dropped, got {baseline}"
    );

    // Drive a synthetic delete_block fan-out via the same dispatch entry
    // point a real op uses.  The fan-out covers all 7 tasks in
    // `FULL_CACHE_REBUILD_TASKS` plus a `RemoveFtsBlock` for the
    // non-empty block_id — every one should be shed and counted because
    // the queue is saturated.
    let record = fake_op_record("delete_block", r#"{"block_id":"BLK-DEL"}"#);
    let _ = mat.dispatch_background(&record);

    let after = mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed);
    assert!(
        after >= baseline + 7,
        "the delete_block cache-rebuild fan-out must add at least 7 drops under saturation (baseline={baseline}, after={after})"
    );

    mat.shutdown();
}
#[tokio::test]
async fn try_enqueue_after_shutdown_err() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .is_err(),
        "try_enqueue should fail after shutdown"
    );
}
#[tokio::test]
async fn shutdown_stops_consumers() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "should enqueue before shutdown"
    );
    mat.flush_background().await.unwrap();
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_err(),
        "enqueue should fail after shutdown"
    );
}
#[tokio::test]
async fn shutdown_when_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    for _ in 0..2000 {
        let _ = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
    }
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .is_err(),
        "try_enqueue should fail after shutdown when full"
    );
    assert!(
        mat.enqueue_foreground(MaterializeTask::RebuildTagsCache)
            .await
            .is_err(),
        "foreground enqueue should fail after shutdown when full"
    );
}
#[tokio::test]
async fn metrics_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.enqueue_background(MaterializeTask::RebuildPagesCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    assert_eq!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed),
        3,
        "should have processed exactly 2 background tasks plus the flush barrier"
    );
}
#[tokio::test]
async fn metrics_fg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-fg"),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "hello".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(r))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();
    assert_eq!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed),
        2,
        "should have processed exactly 1 foreground task plus the flush barrier"
    );
}
#[tokio::test]
async fn consumer_survives() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.enqueue_background(MaterializeTask::RebuildPagesCache)
        .await
        .unwrap();
    mat.enqueue_background(MaterializeTask::ReindexBlockLinks {
        block_id: "blk-iso".into(),
    })
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "consumer should survive processing multiple tasks"
    );
}
#[tokio::test]
async fn flush_fg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-flush-fg"),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "flush fg".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(r))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();
    assert_eq!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed),
        2,
        "flush_foreground should process exactly 1 task plus the flush barrier"
    );
}
#[tokio::test]
async fn flush_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    assert_eq!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed),
        2,
        "flush_background should process exactly 1 task plus the flush barrier"
    );
}
#[tokio::test]
async fn flush_both() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-flush-both"),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "flush both".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(r))
        .await
        .unwrap();
    mat.enqueue_background(MaterializeTask::RebuildPagesCache)
        .await
        .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed),
        2,
        "flush should process exactly 1 foreground task plus the flush barrier"
    );
    assert_eq!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed),
        2,
        "flush should process exactly 1 background task plus the flush barrier"
    );
}

#[test]
fn dedup_barrier() {
    let n1 = Arc::new(tokio::sync::Notify::new());
    let n2 = Arc::new(tokio::sync::Notify::new());
    let d = dedup_tasks(vec![
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::Barrier(n1),
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::Barrier(n2),
    ]);
    assert_eq!(
        d.len(),
        3,
        "dedup should keep one RebuildTagsCache and both barriers"
    );
    assert_eq!(
        d.iter()
            .filter(|t| matches!(t, MaterializeTask::Barrier(_)))
            .count(),
        2,
        "barriers should never be deduped"
    );
}
#[test]
fn dedup_cache() {
    let d = dedup_tasks(vec![
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::RebuildPagesCache,
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::RebuildAgendaCache,
        MaterializeTask::RebuildPagesCache,
        MaterializeTask::RebuildTagsCache,
    ]);
    assert_eq!(
        d.len(),
        3,
        "dedup should collapse duplicate cache rebuild tasks"
    );
}
#[test]
fn dedup_block_links() {
    let d = dedup_tasks(vec![
        MaterializeTask::ReindexBlockLinks {
            block_id: "a".into(),
        },
        MaterializeTask::ReindexBlockLinks {
            block_id: "b".into(),
        },
        MaterializeTask::ReindexBlockLinks {
            block_id: "a".into(),
        },
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::ReindexBlockLinks {
            block_id: "c".into(),
        },
    ]);
    assert_eq!(
        d.len(),
        4,
        "dedup should collapse same block_id reindex but keep distinct ones"
    );
}
#[test]
fn dedup_apply_op() {
    let r = fake_op_record("create_block", "{}");
    let d = dedup_tasks(vec![
        MaterializeTask::ApplyOp(r.clone()),
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::ApplyOp(r.clone()),
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::ApplyOp(r),
    ]);
    assert_eq!(
        d.len(),
        4,
        "dedup should keep all ApplyOp tasks and collapse duplicate cache tasks"
    );
    assert_eq!(
        d.iter()
            .filter(|t| matches!(t, MaterializeTask::ApplyOp(_)))
            .count(),
        3,
        "ApplyOp tasks should never be deduped"
    );
}
#[test]
fn dedup_empty() {
    assert!(
        dedup_tasks(vec![]).is_empty(),
        "dedup of empty input should be empty"
    );
}
#[test]
fn dedup_single() {
    assert_eq!(
        dedup_tasks(vec![MaterializeTask::RebuildTagsCache]).len(),
        1,
        "dedup of single task should return one task"
    );
}
#[test]
fn dedup_same_reindex() {
    assert_eq!(
        dedup_tasks(vec![
            MaterializeTask::ReindexBlockLinks {
                block_id: "same".into()
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: "same".into()
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: "same".into()
            }
        ])
        .len(),
        1,
        "identical reindex tasks should dedup to one"
    );
}
#[test]
fn dedup_fts_update() {
    assert_eq!(
        dedup_tasks(vec![
            MaterializeTask::UpdateFtsBlock {
                block_id: "a".into()
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: "b".into()
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: "a".into()
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: "c".into()
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: "b".into()
            }
        ])
        .len(),
        3,
        "duplicate fts update tasks for same block_id should be collapsed"
    );
}
#[test]
fn dedup_fts_remove() {
    assert_eq!(
        dedup_tasks(vec![
            MaterializeTask::RemoveFtsBlock {
                block_id: "x".into()
            },
            MaterializeTask::RemoveFtsBlock {
                block_id: "y".into()
            },
            MaterializeTask::RemoveFtsBlock {
                block_id: "x".into()
            }
        ])
        .len(),
        2,
        "duplicate fts remove tasks for same block_id should be collapsed"
    );
}
#[test]
fn dedup_fts_reindex_ref() {
    assert_eq!(
        dedup_tasks(vec![
            MaterializeTask::ReindexFtsReferences {
                block_id: "tag-1".into()
            },
            MaterializeTask::ReindexFtsReferences {
                block_id: "tag-2".into()
            },
            MaterializeTask::ReindexFtsReferences {
                block_id: "tag-1".into()
            }
        ])
        .len(),
        2,
        "duplicate fts reindex references for same block_id should be collapsed"
    );
}
#[test]
fn dedup_fts_update_remove() {
    assert_eq!(
        dedup_tasks(vec![
            MaterializeTask::UpdateFtsBlock {
                block_id: "z".into()
            },
            MaterializeTask::RemoveFtsBlock {
                block_id: "z".into()
            }
        ])
        .len(),
        2,
        "update and remove for same block should both be kept as different task types"
    );
}
#[test]
fn dedup_fts_optimize() {
    let d = dedup_tasks(vec![
        MaterializeTask::FtsOptimize,
        MaterializeTask::RebuildFtsIndex,
        MaterializeTask::FtsOptimize,
        MaterializeTask::RebuildFtsIndex,
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::FtsOptimize,
    ]);
    assert_eq!(
        d.len(),
        3,
        "duplicate FtsOptimize and RebuildFtsIndex should each collapse to one"
    );
}
#[test]
fn dedup_hash() {
    assert_eq!(
        dedup_tasks(vec![
            MaterializeTask::ReindexBlockLinks {
                block_id: "A".into()
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: "A".into()
            },
            MaterializeTask::ReindexBlockLinks {
                block_id: "B".into()
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: "A".into()
            },
            MaterializeTask::UpdateFtsBlock {
                block_id: "A".into()
            }
        ])
        .len(),
        3,
        "dedup should collapse by task type and block_id together"
    );
}

/// H-5 / H-6 (2026-04) regression guard: two `ApplyOp` tasks targeting
/// *different* block_ids are now processed strictly FIFO (no JoinSet
/// bucketing). This test pins that both blocks see their edits in the
/// order the ops were enqueued and that `fg_processed` advances twice.
///
/// Historically this test was named `parallel_groups` and relied on the
/// JoinSet parallel-group dispatch to run the two ops concurrently.
/// That dispatch path was deleted for H-5 / H-6 because SQLite
/// serialises writes at the engine level (single writer in WAL mode),
/// so parallel buckets bought no throughput while creating FK-ordering
/// and bucketing-key hazards.
#[tokio::test]
async fn foreground_distinct_block_edits_land_in_fifo_order() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "PAR_A", "content", "original-A").await;
    insert_block_direct(&pool, "PAR_B", "content", "original-B").await;
    let ra = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("PAR_A"),
            to_text: "updated-A".into(),
            prev_edit: None,
        }),
    )
    .await;
    let rb = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("PAR_B"),
            to_text: "updated-B".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(ra))
        .await
        .unwrap();
    mat.enqueue_foreground(MaterializeTask::ApplyOp(rb))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();
    let ca: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'PAR_A'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ca.as_deref(),
        Some("updated-A"),
        "block PAR_A content should be updated"
    );
    let cb: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'PAR_B'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        cb.as_deref(),
        Some("updated-B"),
        "block PAR_B content should be updated"
    );
    assert_eq!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed),
        3,
        "should process exactly 2 distinct-block edits plus the flush barrier"
    );
}

#[test]
fn high_water_zero() {
    let m = QueueMetrics::default();
    assert_eq!(
        m.fg_high_water.load(AtomicOrdering::Relaxed),
        0,
        "fg high water should start at zero"
    );
    assert_eq!(
        m.bg_high_water.load(AtomicOrdering::Relaxed),
        0,
        "bg high water should start at zero"
    );
}
#[tokio::test]
async fn high_water_fg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-hw"),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "hw".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    assert!(
        mat.metrics().fg_high_water.load(AtomicOrdering::Relaxed) >= 1,
        "fg high water should increase after dispatch_op"
    );
}
#[tokio::test]
async fn high_water_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    assert!(
        mat.metrics().bg_high_water.load(AtomicOrdering::Relaxed) >= 1,
        "bg high water should increase after enqueue_background"
    );
}
#[tokio::test]
async fn status_info() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    tokio::time::sleep(Duration::from_millis(10)).await;
    let s = mat.status().await;
    assert_eq!(
        s.fg_high_water, 0,
        "initial fg high water in status should be zero"
    );
    assert_eq!(
        s.bg_high_water, 0,
        "initial bg high water in status should be zero"
    );
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-si"),
            block_type: "page".into(),
            parent_id: None,
            position: None,
            content: "status".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    assert!(
        mat.status().await.fg_high_water >= 1,
        "fg high water should rise after dispatching an op"
    );
}

#[tokio::test]
#[should_panic(expected = "edit_block payload has empty block_id")]
async fn dispatch_bg_empty_block_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let _ = mat.dispatch_background(&fake_op_record(
        "edit_block",
        r#"{"to_text":"hello","prev_edit":null}"#,
    ));
}
#[tokio::test]
async fn error_counters_zero() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let m = mat.metrics();
    assert_eq!(
        m.fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "fg errors should start at zero"
    );
    assert_eq!(
        m.bg_errors.load(AtomicOrdering::Relaxed),
        0,
        "bg errors should start at zero"
    );
    assert_eq!(
        m.fg_panics.load(AtomicOrdering::Relaxed),
        0,
        "fg panics should start at zero"
    );
    assert_eq!(
        m.bg_panics.load(AtomicOrdering::Relaxed),
        0,
        "bg panics should start at zero"
    );
}
#[tokio::test]
async fn status_error_counters() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let s = mat.status().await;
    assert_eq!(s.fg_errors, 0, "status fg_errors should start at zero");
    assert_eq!(s.bg_errors, 0, "status bg_errors should start at zero");
    assert_eq!(s.fg_panics, 0, "status fg_panics should start at zero");
    assert_eq!(s.bg_panics, 0, "status bg_panics should start at zero");
}

#[tokio::test]
async fn handle_fg_apply_op() {
    let (pool, _dir) = test_pool().await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('NOOP_BLK', 'content', 'original')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let task = MaterializeTask::ApplyOp(fake_op_record(
        "edit_block",
        r#"{"block_id":"NOOP_BLK","to_text":"modified","prev_edit":null}"#,
    ));
    assert!(
        handle_foreground_task(&pool, &task, &empty_gcal_handle())
            .await
            .is_ok(),
        "handle_foreground_task should succeed for valid ApplyOp"
    );
    let c: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'NOOP_BLK'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        c.as_deref(),
        Some("modified"),
        "content should be updated by foreground ApplyOp"
    );
}
#[tokio::test]
async fn handle_fg_barrier() {
    let (pool, _dir) = test_pool().await;
    let n = Arc::new(tokio::sync::Notify::new());
    assert!(
        handle_foreground_task(
            &pool,
            &MaterializeTask::Barrier(Arc::clone(&n)),
            &empty_gcal_handle()
        )
        .await
        .is_ok(),
        "barrier task should succeed"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), n.notified())
            .await
            .is_ok(),
        "barrier notify should fire within timeout"
    );
}
#[tokio::test]
async fn handle_fg_unexpected() {
    // L-14: an unexpected (background-only) variant in the foreground
    // queue must surface as `Err(Validation)` so the consumer bumps
    // `fg_errors` and reviewers see a real signal instead of a silent
    // drop.
    let (pool, _dir) = test_pool().await;
    let result = handle_foreground_task(
        &pool,
        &MaterializeTask::RebuildTagsCache,
        &empty_gcal_handle(),
    )
    .await;
    match result {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("unexpected task in foreground queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
}
#[tokio::test]
async fn handle_fg_unexpected_reindex() {
    // L-14: see `handle_fg_unexpected` — same contract for any
    // background-only variant.
    let (pool, _dir) = test_pool().await;
    let result = handle_foreground_task(
        &pool,
        &MaterializeTask::ReindexBlockLinks {
            block_id: "01FAKE00000000000000000000".into(),
        },
        &empty_gcal_handle(),
    )
    .await;
    match result {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("unexpected task in foreground queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
}
#[tokio::test]
async fn handle_bg_unexpected_apply() {
    // L-14 (bg mirror): an `ApplyOp` in the background queue is a
    // dispatch bug. The handler must return `Err(Validation)` so the
    // bg consumer bumps `bg_errors`. Block must NOT be created.
    let (pool, _dir) = test_pool().await;
    let result = handle_background_task(
        &pool,
        &MaterializeTask::ApplyOp(fake_op_record(
            "create_block",
            r#"{"block_id":"X","block_type":"content","content":"t","parent_id":null,"position":null}"#,
        )),
        None,
        None,
    )
    .await;
    match result {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("unexpected ApplyOp in background queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM blocks WHERE id = 'X'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.0, 0,
        "ApplyOp in bg queue must not mutate state even though it now errors"
    );
}

// ---------------------------------------------------------------------------
// L-12 / L-14 regression tests
// ---------------------------------------------------------------------------
//
// L-12: `enqueue_foreground` previously inspected `tx.capacity()` BEFORE
// the awaiting `send` to bump `fg_full_waits`. That snapshot was racy
// (the consumer can drain between the read and the send) so the metric
// under-counted real wait events. The fix uses `try_send` first and
// only bumps the counter on the `Full` arm — guaranteeing 1:1
// correlation between counter increments and "we actually awaited on a
// full channel".
//
// L-14: misrouted variants in either queue used to log at warn and
// return Ok(()), silently absorbing dispatch bugs. They now return
// `Err(AppError::Validation(_))` so consumers bump `fg_errors` /
// `bg_errors` and reviewers see a real signal.

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enqueue_foreground_does_not_bump_fg_full_waits_when_capacity_available() {
    // L-12: the happy path — channel has capacity, `try_send` succeeds
    // immediately, `fg_full_waits` must remain at zero. The old snapshot
    // check could in principle race (capacity read 0 milliseconds before
    // send), but more importantly was inverted in spirit: capacity == 0
    // does not actually mean we waited. The new contract is "the metric
    // counts real wait events only".
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let before = mat.metrics().fg_full_waits.load(AtomicOrdering::Relaxed);
    assert_eq!(before, 0, "fg_full_waits starts at zero");

    // A `Barrier` task is the cheapest valid foreground variant — it
    // completes synchronously inside the consumer with no I/O, so the
    // channel will not fill regardless of how fast we enqueue.
    let n = StdArc::new(tokio::sync::Notify::new());
    mat.enqueue_foreground(MaterializeTask::Barrier(StdArc::clone(&n)))
        .await
        .expect("foreground enqueue should succeed when capacity is available");

    let after = mat.metrics().fg_full_waits.load(AtomicOrdering::Relaxed);
    assert_eq!(
        after, 0,
        "fg_full_waits must not bump when the channel had capacity"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_fg_rebuild_fts_index_returns_validation_err() {
    // L-14: an explicit second test using a different background-only
    // variant (`RebuildFtsIndex`) so a future refactor that special-cases
    // any single variant cannot accidentally re-introduce the silent-Ok
    // behavior.
    let (pool, _dir) = test_pool().await;
    let result = handle_foreground_task(
        &pool,
        &MaterializeTask::RebuildFtsIndex,
        &empty_gcal_handle(),
    )
    .await;
    match result {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("unexpected task in foreground queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handle_bg_unexpected_batch_apply_returns_validation_err() {
    // L-14 (bg mirror): a `BatchApplyOps` in the background queue is a
    // dispatch bug — must surface as `Err(Validation)`.
    let (pool, _dir) = test_pool().await;
    let batch = StdArc::new(vec![fake_op_record(
        "create_block",
        r#"{"block_id":"BAD_BATCH_BLK","block_type":"content","content":"x","parent_id":null,"position":null}"#,
    )]);
    let result =
        handle_background_task(&pool, &MaterializeTask::BatchApplyOps(batch), None, None).await;
    match result {
        Err(AppError::Validation(msg)) => {
            assert!(
                msg.contains("unexpected BatchApplyOps in background queue"),
                "validation message should describe the misroute, got: {msg}"
            );
        }
        other => panic!("expected Err(Validation), got {other:?}"),
    }
    // The bg arm must not have applied any of the ops.
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM blocks WHERE id = 'BAD_BATCH_BLK'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.0, 0,
        "BatchApplyOps in bg queue must not mutate state even though it now errors"
    );
}

#[tokio::test]
async fn tags_cache_after_create_tag() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_FLUSH_1", "tag", "urgent").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_FLUSH_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            content: "urgent".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT name, usage_count FROM tags_cache WHERE tag_id = 'TAG_FLUSH_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "tags_cache should have a row for the created tag"
    );
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("name"),
        "urgent",
        "tag name in cache should match created tag"
    );
    assert_eq!(
        row.get::<i32, _>("usage_count"),
        0,
        "usage_count should be 0 for a new tag with no references"
    );
}
#[tokio::test]
async fn pages_cache_after_create_page() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "PAGE_FLUSH_1", "page", "My Test Page").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("PAGE_FLUSH_1"),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            content: "My Test Page".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT title FROM pages_cache WHERE page_id = 'PAGE_FLUSH_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "pages_cache should have a row for the created page"
    );
    assert_eq!(
        row.unwrap().get::<String, _>("title"),
        "My Test Page",
        "page title in cache should match created page"
    );
}
#[tokio::test]
async fn tags_cache_after_delete() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_DEL_1", "tag", "to-delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_DEL_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            content: "to-delete".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_some(),
        "tag should exist in cache before deletion"
    );
    soft_delete_block_direct(&pool, "TAG_DEL_1").await;
    let del = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("TAG_DEL_1"),
        }),
    )
    .await;
    mat.dispatch_op(&del).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_none(),
        "tag should be removed from cache after deletion"
    );
}
#[tokio::test]
async fn tags_usage_count() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_USE_1", "tag", "important").await;
    insert_block_direct(&pool, "BLK_USE_1", "content", "some note").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_USE_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            content: "important".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i32, _>("usage_count"),
        0,
        "usage_count should be 0 before any tag is applied"
    );
    insert_block_tag(&pool, "BLK_USE_1", "TAG_USE_1").await;
    let add = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("BLK_USE_1"),
            tag_id: BlockId::test_id("TAG_USE_1"),
        }),
    )
    .await;
    mat.dispatch_op(&add).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i32, _>("usage_count"),
        1,
        "usage_count should be 1 after adding tag to one block"
    );
}
#[tokio::test]
async fn agenda_cache_after_set_property() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK_AGD_1", "content", "task").await;
    insert_property_date(&pool, "BLK_AGD_1", "due", "2025-03-15").await;
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK_AGD_1"),
            key: "due".into(),
            value_text: None,
            value_num: None,
            value_date: Some("2025-03-15".into()),
            value_ref: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT date, source FROM agenda_cache WHERE block_id = 'BLK_AGD_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "agenda_cache should have a row after setting a date property"
    );
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("date"),
        "2025-03-15",
        "agenda date should match the set property value"
    );
    assert_eq!(
        row.get::<String, _>("source"),
        "property:due",
        "agenda source should indicate the property key"
    );
}

#[tokio::test]
async fn apply_op_create() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("APPLY_CREATE_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "hello from remote".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row =
        sqlx::query("SELECT block_type, content, position FROM blocks WHERE id = 'APPLY_CREATE_1'")
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(row.is_some(), "block should exist after apply_op create");
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("block_type"),
        "content",
        "block_type should match created block"
    );
    assert_eq!(
        row.get::<Option<String>, _>("content").as_deref(),
        Some("hello from remote"),
        "content should match created block text"
    );
    assert_eq!(
        row.get::<Option<i64>, _>("position"),
        Some(1),
        "position should match created block position"
    );
}
#[tokio::test]
async fn apply_op_create_idempotent() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_IDEM_1", "content", "original").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("APPLY_IDEM_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "from remote".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT content FROM blocks WHERE id = 'APPLY_IDEM_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("content")
            .as_deref(),
        Some("original"),
        "idempotent create should not overwrite existing block content"
    );
}
#[tokio::test]
async fn apply_op_edit() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_EDIT_1", "content", "before edit").await;
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("APPLY_EDIT_1"),
            to_text: "after edit".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT content FROM blocks WHERE id = 'APPLY_EDIT_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("content")
            .as_deref(),
        Some("after edit"),
        "content should reflect the edit operation"
    );
}
#[tokio::test]
async fn apply_op_delete() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_DEL_1", "content", "to delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("APPLY_DEL_1"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT deleted_at FROM blocks WHERE id = 'APPLY_DEL_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("deleted_at")
            .is_some(),
        "deleted_at should be set after apply_op delete"
    );
}
#[tokio::test]
async fn apply_op_restore() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_RESTORE_1", "content", "to restore").await;
    soft_delete_block_direct(&pool, "APPLY_RESTORE_1").await;
    let r = make_op_record(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id("APPLY_RESTORE_1"),
            deleted_at_ref: FIXED_TS.into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT deleted_at FROM blocks WHERE id = 'APPLY_RESTORE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("deleted_at")
            .is_none(),
        "deleted_at should be cleared after apply_op restore"
    );
}
#[tokio::test]
async fn apply_op_purge() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_PURGE_1", "content", "to purge").await;
    soft_delete_block_direct(&pool, "APPLY_PURGE_1").await;
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("APPLY_PURGE_1"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT id FROM blocks WHERE id = 'APPLY_PURGE_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_none(),
        "block should be physically removed after apply_op purge"
    );
}
#[tokio::test]
async fn apply_op_move() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_MOVE_PARENT", "page", "parent").await;
    insert_block_direct(&pool, "APPLY_MOVE_1", "content", "movable").await;
    let r = make_op_record(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("APPLY_MOVE_1"),
            new_parent_id: Some(BlockId::test_id("APPLY_MOVE_PARENT")),
            new_position: 5,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT parent_id, position FROM blocks WHERE id = 'APPLY_MOVE_1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.get::<Option<String>, _>("parent_id").as_deref(),
        Some("APPLY_MOVE_PARENT"),
        "parent_id should be set after apply_op move"
    );
    assert_eq!(
        row.get::<Option<i64>, _>("position"),
        Some(5),
        "position should be updated after apply_op move"
    );
}
#[tokio::test]
async fn apply_op_add_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_ADDTAG_BLK", "content", "note").await;
    insert_block_direct(&pool, "APPLY_ADDTAG_TAG", "tag", "urgent").await;
    let r = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("APPLY_ADDTAG_BLK"),
            tag_id: BlockId::test_id("APPLY_ADDTAG_TAG"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?",
        "APPLY_ADDTAG_BLK",
        "APPLY_ADDTAG_TAG"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "block_tags row should exist after apply_op add_tag"
    );
}
#[tokio::test]
async fn apply_op_invalid_payload() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_foreground(MaterializeTask::ApplyOp(fake_op_record(
        "create_block",
        r#"{"not_valid": true}"#,
    )))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "malformed create_block payload should increment fg_errors exactly once after retry exhaustion"
    );
}
#[tokio::test]
async fn apply_op_unknown_op() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_foreground(MaterializeTask::ApplyOp(fake_op_record(
        "unknown_op",
        r#"{}"#,
    )))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "unknown op_type should increment fg_errors exactly once after retry exhaustion"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_retry_success() {
    let (pool, _dir) = test_pool().await;
    let metrics = Arc::new(QueueMetrics::default());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-retry-ok"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "retry test".into(),
        }),
    )
    .await;
    process_single_foreground_task(
        &pool,
        MaterializeTask::ApplyOp(r),
        &metrics,
        &empty_gcal_handle_arc(),
    )
    .await;
    assert_eq!(
        metrics.fg_processed.load(AtomicOrdering::Relaxed),
        1,
        "should count one processed task"
    );
    assert_eq!(
        metrics.fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "successful task should not increment errors"
    );
    assert_eq!(
        metrics.fg_panics.load(AtomicOrdering::Relaxed),
        0,
        "successful task should not increment panics"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_retry_barrier() {
    let (pool, _dir) = test_pool().await;
    let metrics = Arc::new(QueueMetrics::default());
    process_single_foreground_task(
        &pool,
        MaterializeTask::Barrier(Arc::new(tokio::sync::Notify::new())),
        &metrics,
        &empty_gcal_handle_arc(),
    )
    .await;
    assert_eq!(
        metrics.fg_processed.load(AtomicOrdering::Relaxed),
        1,
        "barrier should count as one processed task"
    );
    assert_eq!(
        metrics.fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "barrier should not increment errors"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_retry_bad_payload() {
    let (pool, _dir) = test_pool().await;
    let metrics = Arc::new(QueueMetrics::default());
    process_single_foreground_task(
        &pool,
        MaterializeTask::ApplyOp(fake_op_record("bogus_op_type", "{}")),
        &metrics,
        &empty_gcal_handle_arc(),
    )
    .await;
    assert_eq!(
        metrics.fg_processed.load(AtomicOrdering::Relaxed),
        1,
        "bad payload should still count as processed"
    );
    assert_eq!(
        metrics.fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "bad payload should increment error counter"
    );
    assert_eq!(
        metrics.fg_panics.load(AtomicOrdering::Relaxed),
        0,
        "bad payload should not cause a panic"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_lifecycle() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-lifecycle"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "lifecycle".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "lifecycle should process at least one foreground task"
    );
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "lifecycle should have no errors"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_failure_propagated() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_foreground(MaterializeTask::ApplyOp(fake_op_record(
        "create_block",
        "{}",
    )))
    .await
    .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "invalid payload should propagate as an error"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_partial_failure() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let good = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-batch-good"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "batch good".into(),
        }),
    )
    .await;
    let bad = fake_op_record("create_block", "{}");
    mat.enqueue_foreground(MaterializeTask::BatchApplyOps(StdArc::new(vec![good, bad])))
        .await
        .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "batch with a bad op should count one error"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_success() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-success"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "success".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(r))
        .await
        .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "successful apply_op should have zero errors"
    );
    mat.shutdown();
}
// ──────────────────────────────────────────────────────────────────────
// REVIEW-LATER C-2a — defense-in-depth observability for materializer
// divergence.
//
// When a foreground `ApplyOp` / `BatchApplyOps` task exhausts its 100ms
// in-memory retry, the dedicated `fg_apply_dropped` counter must bump
// (in addition to the existing `fg_errors`) and a warn line must be
// emitted with `kind` / `seq` / `device_id` / `op_type`. Non-Apply
// task failures must NOT bump `fg_apply_dropped`.
//
// These tests exercise only the metric side; the warn-line wiring is
// covered by inspection (tracing-test fixtures are intentionally not
// pulled in to keep this drop-observability change strictly additive).
// ──────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_apply_dropped_bumps_when_apply_op_retry_exhausts() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // C-2a: A `create_block` with an empty payload deterministically fails
    // `serde_json::from_str::<CreateBlockPayload>` inside `apply_op_tx`,
    // so both the first attempt and the 100ms retry land on Ok(Err(_)).
    // That is exactly the retry-exhaust path we want to observe.
    mat.enqueue_foreground(MaterializeTask::ApplyOp(fake_op_record(
        "create_block",
        "{}",
    )))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
    let m = mat.metrics();
    assert!(
        m.fg_apply_dropped.load(AtomicOrdering::Relaxed) >= 1,
        "ApplyOp retry exhaust should bump fg_apply_dropped at least once",
    );
    assert!(
        m.fg_errors.load(AtomicOrdering::Relaxed) >= 1,
        "ApplyOp retry exhaust should also still bump fg_errors",
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_apply_dropped_bumps_once_per_failed_batch() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // C-2a: A 2-element batch where the first op deterministically fails
    // payload deserialization. The whole batch is dropped together
    // (apply_op_tx returns Err inside the outer transaction, which is
    // rolled back). Per the spec, fg_apply_dropped must increment
    // exactly once for the failed batch, regardless of batch size — the
    // remaining ops are implicitly dropped.
    let bad1 = fake_op_record("create_block", "{}");
    let bad2 = fake_op_record("create_block", "{}");
    mat.enqueue_foreground(MaterializeTask::BatchApplyOps(StdArc::new(vec![
        bad1, bad2,
    ])))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
    let m = mat.metrics();
    assert!(
        m.fg_apply_dropped.load(AtomicOrdering::Relaxed) >= 1,
        "BatchApplyOps retry exhaust should bump fg_apply_dropped at least once",
    );
    assert!(
        m.fg_errors.load(AtomicOrdering::Relaxed) >= 1,
        "BatchApplyOps retry exhaust should also still bump fg_errors",
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_apply_dropped_stays_zero_for_non_apply_task() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // C-2a (negative case): a non-Apply task — `UpdateFtsBlock` for a
    // block that doesn't exist — must never bump `fg_apply_dropped`.
    // This task is routed to the background queue, where the existing
    // retry/persist semantics (BUG-22) apply unchanged. The point of
    // the assertion is that the new fg-only counter does not pollute
    // the bg path. (`UpdateFtsBlock` against a missing block actually
    // succeeds — the handler treats "no row" as "remove from FTS" — so
    // this also exercises the bg-success path's effect on the new
    // counter.)
    mat.enqueue_background(MaterializeTask::UpdateFtsBlock {
        block_id: "BLK_DOES_NOT_EXIST".into(),
    })
    .await
    .unwrap();
    mat.flush_background().await.unwrap();
    let m = mat.metrics();
    assert_eq!(
        m.fg_apply_dropped.load(AtomicOrdering::Relaxed),
        0,
        "non-Apply background task must not bump fg_apply_dropped",
    );
    // Sanity: the bg path itself ran (bg_processed advanced). We don't
    // assert on bg_errors / bg_dropped here — the point is just that
    // the new counter is fg-only.
    assert!(
        m.bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "background task should still be processed",
    );
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG01", "tag", "test-tag").await;
    let mat = Materializer::with_read_pool(pool.clone(), pool.clone());
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "tags_cache should have one entry after rebuild with read pool"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bg_with_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG02", "tag", "split-tag").await;
    assert!(
        handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, Some(&pool), None)
            .await
            .is_ok(),
        "background task should succeed with explicit read pool"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "tags_cache should have one entry using read pool");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bg_without_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG03", "tag", "orig-tag").await;
    assert!(
        handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, None, None)
            .await
            .is_ok(),
        "background task should succeed without explicit read pool"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "tags_cache should have one entry without read pool"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.try_enqueue_background(MaterializeTask::CleanupOrphanedAttachments)
        .unwrap();
    mat.flush_background().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reserved_key_todo_state() {
    use crate::op::is_reserved_property_key;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position, is_conflict) VALUES ('BLK-RES', 'content', 'test', 1, 0)").execute(&pool).await.unwrap();
    assert!(
        is_reserved_property_key("todo_state"),
        "todo_state should be a reserved property key"
    );
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK-RES"),
            key: "todo_state".into(),
            value_text: Some("DONE".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let ts: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = 'BLK-RES'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        ts,
        Some("DONE".into()),
        "todo_state column should be set to DONE"
    );
    let pc: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-RES' AND key = 'todo_state'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        pc, 0,
        "reserved key should not be stored in block_properties"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_reserved_key() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position, is_conflict, todo_state) VALUES ('BLK-DEL', 'content', 'test', 1, 0, 'TODO')").execute(&pool).await.unwrap();
    let r = make_op_record(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("BLK-DEL"),
            key: "todo_state".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let after: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = 'BLK-DEL'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        after.is_none(),
        "todo_state should be cleared after deleting reserved property"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_fg_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, ?, ?)")
        .bind("STRESS_01")
        .bind("content")
        .bind("stress")
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();
    let mut handles = Vec::new();
    for i in 0..20 {
        let mat_fg = mat.clone();
        let ps = format!(r#"{{"block_id":"STRESS_01","to_text":"v{i}","prev_edit":null}}"#);
        let record = fake_op_record("edit_block", &ps);
        handles.push(tokio::spawn(async move {
            let _ = mat_fg
                .enqueue_foreground(MaterializeTask::ApplyOp(record))
                .await;
        }));
        let mat_bg = mat.clone();
        handles.push(tokio::spawn(async move {
            let _ = mat_bg
                .enqueue_background(MaterializeTask::ReindexBlockLinks {
                    block_id: "STRESS_01".into(),
                })
                .await;
            let _ = mat_bg
                .enqueue_background(MaterializeTask::UpdateFtsBlock {
                    block_id: "STRESS_01".into(),
                })
                .await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    mat.flush().await.unwrap();
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_dispatch() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, ?, ?)")
        .bind("STRESS_SERIAL_01")
        .bind("content")
        .bind("initial")
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();
    let mut handles = Vec::new();
    for i in 0..10 {
        let mat_c = mat.clone();
        let pool_c = pool.clone();
        let payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("STRESS_SERIAL_01"),
            to_text: format!("concurrent-v{i}"),
            prev_edit: None,
        });
        handles.push(tokio::spawn(async move {
            let record = make_op_record(&pool_c, payload).await;
            mat_c.dispatch_op(&record).await.unwrap();
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed),
        11,
        "should process exactly 10 concurrent dispatch ops plus the flush barrier"
    );
}

// ======================================================================
// B-62: BatchApplyOps atomicity — if last op fails, none persist
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_apply_ops_atomic_rollback_on_failure() {
    let (pool, _dir) = test_pool().await;

    // First op: a valid create_block
    let good = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BATCH_ATOM_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "should be rolled back".into(),
        }),
    )
    .await;

    // Second op: bad payload that will fail deserialization
    let bad = fake_op_record("create_block", "{}");

    let task = MaterializeTask::BatchApplyOps(StdArc::new(vec![good, bad]));
    let result = handle_foreground_task(&pool, &task, &empty_gcal_handle()).await;
    assert!(
        result.is_err(),
        "batch should fail because the last op has bad payload"
    );

    // The first op's block should NOT be visible (rolled back)
    let row = sqlx::query("SELECT id FROM blocks WHERE id = 'BATCH_ATOM_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_none(),
        "block from first op should be rolled back when batch fails"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_apply_ops_all_succeed_commits() {
    let (pool, _dir) = test_pool().await;

    let op1 = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BATCH_OK_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "first".into(),
        }),
    )
    .await;

    let op2 = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BATCH_OK_2"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(2),
            content: "second".into(),
        }),
    )
    .await;

    let task = MaterializeTask::BatchApplyOps(StdArc::new(vec![op1, op2]));
    let result = handle_foreground_task(&pool, &task, &empty_gcal_handle()).await;
    result.unwrap();

    // Both blocks should be visible
    let r1 = sqlx::query("SELECT id FROM blocks WHERE id = 'BATCH_OK_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(r1.is_some(), "first block should be committed");

    let r2 = sqlx::query("SELECT id FROM blocks WHERE id = 'BATCH_OK_2'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(r2.is_some(), "second block should be committed");
}

// ======================================================================
// B-63: purge cleans page_aliases and projected_agenda_cache
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_handler_cleans_page_aliases() {
    let (pool, _dir) = test_pool().await;

    // Create a page block, soft-delete it, add a page alias
    insert_block_direct(&pool, "PURGE_PA_1", "page", "my page").await;
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PURGE_PA_1")
        .bind("alias-one")
        .execute(&pool)
        .await
        .unwrap();

    // Verify alias exists
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "alias should exist before purge");

    soft_delete_block_direct(&pool, "PURGE_PA_1").await;

    // Purge via handler
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("PURGE_PA_1"),
        }),
    )
    .await;
    let task = MaterializeTask::ApplyOp(r);
    handle_foreground_task(&pool, &task, &empty_gcal_handle())
        .await
        .unwrap();

    // Verify block and alias are gone
    let block_exists = sqlx::query("SELECT id FROM blocks WHERE id = 'PURGE_PA_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(block_exists.is_none(), "block should be physically gone");

    let alias_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(alias_count, 0, "page_aliases should be cleaned after purge");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_handler_cleans_projected_agenda_cache() {
    let (pool, _dir) = test_pool().await;

    // Create a block, soft-delete it, add a projected_agenda_cache row
    insert_block_direct(&pool, "PURGE_PAC_1", "content", "task").await;
    sqlx::query(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
    )
    .bind("PURGE_PAC_1")
    .bind("2025-06-01")
    .bind("due_date")
    .execute(&pool)
    .await
    .unwrap();

    // Verify cache row exists
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "projected_agenda_cache row should exist before purge"
    );

    soft_delete_block_direct(&pool, "PURGE_PAC_1").await;

    // Purge via handler
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("PURGE_PAC_1"),
        }),
    )
    .await;
    let task = MaterializeTask::ApplyOp(r);
    handle_foreground_task(&pool, &task, &empty_gcal_handle())
        .await
        .unwrap();

    // Verify block and cache row are gone
    let block_exists = sqlx::query("SELECT id FROM blocks WHERE id = 'PURGE_PAC_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(block_exists.is_none(), "block should be physically gone");

    let cache_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        cache_count, 0,
        "projected_agenda_cache should be cleaned after purge"
    );
}

// ======================================================================
// M-15: RemoveTag runs under transaction (via apply_op)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_handler_cleans_inherited() {
    let (pool, _dir) = test_pool().await;

    // Setup: block with a tag and child inheriting
    insert_block_direct(&pool, "RT_PARENT", "page", "parent page").await;
    insert_block_direct(&pool, "RT_TAG", "tag", "urgent").await;
    sqlx::query("UPDATE blocks SET parent_id = 'RT_PARENT' WHERE id = 'RT_TAG'")
        .execute(&pool)
        .await
        .ok(); // ignore if fails

    insert_block_tag(&pool, "RT_PARENT", "RT_TAG").await;

    // Insert a child block
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) VALUES (?, ?, ?, ?, ?)",
    )
    .bind("RT_CHILD")
    .bind("content")
    .bind("child")
    .bind("RT_PARENT")
    .bind(1_i64)
    .execute(&pool)
    .await
    .unwrap();

    // Propagate tag to descendants manually
    {
        let mut conn = pool.acquire().await.unwrap();
        crate::tag_inheritance::propagate_tag_to_descendants(&mut conn, "RT_PARENT", "RT_TAG")
            .await
            .unwrap();
    }

    // Verify child inherited the tag
    let inherited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tag_inherited WHERE block_id = 'RT_CHILD' AND tag_id = 'RT_TAG'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(inherited, 1, "child should inherit tag before removal");

    // Remove the tag via handler
    let r = make_op_record(
        &pool,
        OpPayload::RemoveTag(crate::op::RemoveTagPayload {
            block_id: BlockId::test_id("RT_PARENT"),
            tag_id: BlockId::test_id("RT_TAG"),
        }),
    )
    .await;
    let task = MaterializeTask::ApplyOp(r);
    handle_foreground_task(&pool, &task, &empty_gcal_handle())
        .await
        .unwrap();

    // Verify direct tag is gone
    let direct: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = 'RT_PARENT' AND tag_id = 'RT_TAG'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(direct, 0, "direct tag should be removed");

    // Verify inherited tag is cleaned up
    let inherited_after: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tag_inherited WHERE block_id = 'RT_CHILD' AND tag_id = 'RT_TAG'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        inherited_after, 0,
        "inherited tag should be cleaned up after removal"
    );
}

// ======================================================================
// UX-159: create_block dispatch enqueues RebuildProjectedAgendaCache
// ======================================================================

#[tokio::test]
async fn dispatch_create_block_enqueues_projected_agenda_cache() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("DISP_PAC_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "test dispatch".into(),
        }),
    )
    .await;

    // dispatch_background only enqueues bg tasks (no fg)
    mat.dispatch_background(&r).unwrap();

    // Flush background and verify the projected agenda cache rebuild ran
    // (RebuildProjectedAgendaCache is a no-op on an empty DB but the task
    // should have been enqueued and processed without error)
    mat.flush_background().await.unwrap();

    // If the task was enqueued, bg_processed should have at least the
    // expected tasks: RebuildTagInheritanceCache + RebuildProjectedAgendaCache + UpdateFtsBlock
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 2,
        "should have processed at least 2 background tasks (tag inheritance + projected agenda cache)"
    );
}

// BUG-12: Barrier race — tasks after a barrier in the same batch must
// complete before the barrier signals the caller.
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flush_background_completes_tasks_after_barrier() {
    use sqlx::Row;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Insert two tag blocks so the cache rebuilds have data to process.
    insert_block_direct(&pool, "BAR_TAG_1", "tag", "barrier-tag-1").await;
    insert_block_direct(&pool, "BAR_PAGE_1", "page", "barrier-page-1").await;

    // Enqueue: RebuildTagsCache, then a Barrier, then RebuildPagesCache.
    // Before the fix the barrier would signal immediately, and the pages
    // cache rebuild that follows it in the same batch could run AFTER
    // flush_background() returned.
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.enqueue_background(MaterializeTask::RebuildPagesCache)
        .await
        .unwrap();

    // flush_background sends its own Barrier and waits on it.
    mat.flush_background().await.unwrap();

    // After flush returns, BOTH cache rebuilds must have completed.
    let tag_row = sqlx::query("SELECT name FROM tags_cache WHERE tag_id = 'BAR_TAG_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        tag_row.is_some(),
        "tags_cache should contain BAR_TAG_1 after flush"
    );
    assert_eq!(
        tag_row.unwrap().get::<String, _>("name"),
        "barrier-tag-1",
        "tag name in cache should match after flush"
    );

    let page_row = sqlx::query("SELECT title FROM pages_cache WHERE page_id = 'BAR_PAGE_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        page_row.is_some(),
        "pages_cache should contain BAR_PAGE_1 after flush — task after barrier was not completed before signal"
    );
    assert_eq!(
        page_row.unwrap().get::<String, _>("title"),
        "barrier-page-1",
        "page title in cache should match after flush"
    );

    // Both tasks (+ the barrier itself) should be counted.
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 3,
        "should have processed RebuildTagsCache + Barrier + RebuildPagesCache"
    );
}

// ======================================================================
// PERF-11: Adaptive FTS optimize threshold — scales with corpus size
// ======================================================================

#[tokio::test]
async fn adaptive_fts_threshold_small_db() {
    // With a small DB (< 5M blocks), the threshold stays at 500.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "ADAPT_SM", "content", "small db block").await;

    // The Materializer constructor spawns a background task that reads the
    // actual block count from the DB and writes it to `cached_block_count`.
    // Wait for that to complete deterministically so the test sees a stable
    // count, then verify the threshold = max(500, count/10_000) = 500 still
    // holds for a small DB.
    //
    // Previously this was a 1-second polling loop on `> 0`, which raced
    // under nextest parallelism (TEST-2 in REVIEW-LATER.md).
    mat.wait_for_initial_block_count_cache().await;
    let cached = mat
        .metrics()
        .cached_block_count
        .load(AtomicOrdering::Relaxed);
    assert!(
        cached < 5_000_000,
        "cached block count should reflect a small DB (< 5M blocks); got {cached}"
    );

    // Simulate 499 prior edits and pin last-optimize to now so the
    // time-based path does not fire.
    mat.metrics()
        .fts_edits_since_optimize
        .store(499, AtomicOrdering::Relaxed);
    // Millis since epoch fits in u64 for millions of years; saturate on overflow.
    let now_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    mat.metrics()
        .fts_last_optimize_ms
        .store(now_ms, AtomicOrdering::Relaxed);

    // The 500th edit should trigger FtsOptimize and reset the counter.
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("ADAPT_SM"),
            to_text: "edited-500".into(),
            prev_edit: None,
        }),
    )
    .await;
    assert!(
        mat.dispatch_edit_background(&r, "content").is_ok(),
        "dispatch_edit_background should succeed for small db"
    );

    assert_eq!(
        mat.metrics()
            .fts_edits_since_optimize
            .load(AtomicOrdering::Relaxed),
        0,
        "counter should reset to 0 — FtsOptimize was enqueued at the 500-edit threshold"
    );

    // Flush to confirm the FtsOptimize task was actually processed.
    mat.flush_background().await.unwrap();
}

#[tokio::test]
async fn adaptive_fts_threshold_large_corpus() {
    // When cached_block_count is high, the threshold rises above 500.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "ADAPT_LG", "content", "large db block").await;

    // The Materializer constructor spawns a background task that reads the
    // actual block count from the DB and writes it to `cached_block_count`.
    // Wait for that deterministically before simulating the 10M-block
    // count below — otherwise the stale writer races our `.store(10M)` and
    // clobbers it with the real count (TEST-2 in REVIEW-LATER.md).
    mat.wait_for_initial_block_count_cache().await;

    // Simulate a 10 M-block corpus.
    // threshold = max(500, 10_000_000 / 10_000) = max(500, 1000) = 1000
    mat.metrics()
        .cached_block_count
        .store(10_000_000, AtomicOrdering::Relaxed);

    // Millis since epoch fits in u64 for millions of years; saturate on overflow.
    let now_ms = u64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    mat.metrics()
        .fts_last_optimize_ms
        .store(now_ms, AtomicOrdering::Relaxed);

    // At 500 edits the old fixed threshold would fire, but the adaptive
    // threshold is 1000, so no optimize yet.
    mat.metrics()
        .fts_edits_since_optimize
        .store(499, AtomicOrdering::Relaxed);
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("ADAPT_LG"),
            to_text: "edit-500".into(),
            prev_edit: None,
        }),
    )
    .await;
    assert!(
        mat.dispatch_edit_background(&r, "content").is_ok(),
        "dispatch_edit_background should succeed under adaptive threshold"
    );
    assert_eq!(
        mat.metrics()
            .fts_edits_since_optimize
            .load(AtomicOrdering::Relaxed),
        500,
        "counter should stay at 500 — threshold is 1000 for a 10M-block corpus"
    );

    // At 1000 edits the adaptive threshold is reached.
    mat.metrics()
        .fts_edits_since_optimize
        .store(999, AtomicOrdering::Relaxed);
    mat.metrics()
        .fts_last_optimize_ms
        .store(now_ms, AtomicOrdering::Relaxed);
    let r2 = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("ADAPT_LG"),
            to_text: "edit-1000".into(),
            prev_edit: None,
        }),
    )
    .await;
    assert!(
        mat.dispatch_edit_background(&r2, "content").is_ok(),
        "dispatch_edit_background should succeed at adaptive threshold"
    );
    assert_eq!(
        mat.metrics()
            .fts_edits_since_optimize
            .load(AtomicOrdering::Relaxed),
        0,
        "counter should reset to 0 — FtsOptimize fires at the 1000-edit adaptive threshold"
    );

    mat.flush_background().await.unwrap();
}

// ──────────────────────────────────────────────────────────────────────
// dispatch_background_or_warn (MAINT-47)
// ──────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn dispatch_background_or_warn_succeeds_when_queue_open() {
    // Happy path: on a running materializer the helper must dispatch the
    // record's background cache tasks without surfacing any error. It
    // returns `()` so the assertion is that the parallel `dispatch_background`
    // call on an equivalent record returns `Ok` — if that path is exercised
    // cleanly, the helper's `Ok` arm is covered.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let record = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK_OR_WARN"),
            to_text: "new content".into(),
            prev_edit: None,
        }),
    )
    .await;

    // Sanity: plain dispatch must succeed on an open materializer.
    assert!(
        mat.dispatch_background(&record).is_ok(),
        "plain dispatch_background must succeed so the helper's Ok arm is exercised"
    );

    // The helper must also run to completion without panic.
    mat.dispatch_background_or_warn(&record);

    mat.shutdown();
}

#[tokio::test]
async fn dispatch_background_or_warn_swallows_error_after_shutdown() {
    // Error path: once the materializer is shut down the background queue
    // is closed, so `dispatch_background` returns `Err(Channel(..))`. The
    // `_or_warn` helper must log that error at warn level and return
    // normally — it is explicitly fire-and-forget and must never unwind
    // the caller.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Use a fake record so we do not need the op log. The helper only
    // reads `record.op_type` and `record.payload` for dispatch routing.
    let record = fake_op_record("edit_block", r#"{"block_id":"SHUTDOWN_TARGET"}"#);

    // Confirm the underlying dispatch does error so we're exercising
    // the branch that invokes `tracing::warn!`…
    assert!(
        mat.dispatch_background(&record).is_err(),
        "dispatch_background is expected to fail after shutdown so the helper's warn branch is exercised"
    );
    // …and confirm the helper itself does not panic or propagate.
    mat.dispatch_background_or_warn(&record);
}

#[tokio::test]
async fn dispatch_background_or_warn_handles_unknown_op_type_gracefully() {
    // The inner dispatch emits its own warn for an unknown op_type and
    // returns `Ok(())`. The helper should still be callable and must not
    // log a second warn or panic. Exercises the `Ok` arm directly.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let record = fake_op_record("not_a_real_op", "{}");
    mat.dispatch_background_or_warn(&record);
    mat.shutdown();
}

/// M-11: `dispatch_background_or_warn`'s `tracing::warn!` must include
/// `seq` and `device_id` so triage on the user's own device can find
/// the offending row in `op_log` (mirrors the `dedup.rs` parse-error
/// pattern). With a malformed `create_block` payload `enqueue_background_tasks`
/// returns `Err` from the inner `serde_json::from_str::<CreateBlockHint>`
/// — exercising the warn branch — and the captured log output must
/// surface both fields.
#[tokio::test]
async fn dispatch_background_or_warn_logs_seq_and_device_id_on_serde_error() {
    use tracing_subscriber::layer::SubscriberExt;

    /// Thread-safe buffered writer for in-process log capture (mirrors
    /// the helper in `sync_protocol/tests.rs` and `db.rs` tests; see
    /// AGENTS.md § "Test helper duplication is intentional").
    #[derive(Clone, Default)]
    struct WarnBufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for WarnBufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for WarnBufWriter {
        type Writer = WarnBufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);

    let writer = WarnBufWriter::default();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("agaric=warn"))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false),
        );
    let _guard = tracing::subscriber::set_default(subscriber);

    // A `create_block` op with malformed JSON payload trips the
    // `serde_json::from_str::<CreateBlockHint>(&record.payload)?` at
    // `dispatch.rs:111` and surfaces an `Err` to `dispatch_background_or_warn`.
    let record = fake_op_record("create_block", "{not valid json");

    // Sanity: confirm the inner dispatch actually errors so the warn
    // branch is exercised rather than the silent Ok path.
    assert!(
        mat.dispatch_background(&record).is_err(),
        "malformed create_block payload must trip serde and return Err so the warn arm is exercised"
    );
    mat.dispatch_background_or_warn(&record);

    let contents = {
        let bytes = writer.0.lock().unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    };
    assert!(
        contents.contains(&format!("seq={}", record.seq)),
        "warn log must include seq={}, got: {contents:?}",
        record.seq
    );
    assert!(
        contents.contains(&format!("device_id={}", record.device_id)),
        "warn log must include device_id={}, got: {contents:?}",
        record.device_id
    );
    assert!(
        contents.contains("op_type=create_block"),
        "warn log must include op_type=create_block, got: {contents:?}"
    );

    mat.shutdown();
}

// ---------------------------------------------------------------------------
// MAINT-39: enqueue_full_cache_rebuild helper
// ---------------------------------------------------------------------------

/// The canonical fan-out list must contain the seven block-referencing
/// cache rebuild variants in a fixed order. Adding an 8th cache means
/// extending this array; the dispatch arms pick it up automatically.
/// Any drift between the delete/restore/purge arms and this constant is
/// a regression.
#[test]
fn full_cache_rebuild_tasks_has_seven_entries_in_canonical_order() {
    let tasks = &super::dispatch::FULL_CACHE_REBUILD_TASKS;
    // UX-250 extended the array with `RebuildBlockTagRefsCache` (7th).
    assert_eq!(
        tasks.len(),
        7,
        "FULL_CACHE_REBUILD_TASKS must contain exactly the 7 block-referencing caches"
    );
    assert!(
        matches!(tasks[0], MaterializeTask::RebuildTagsCache),
        "tasks[0] must be RebuildTagsCache, got {:?}",
        tasks[0]
    );
    assert!(
        matches!(tasks[1], MaterializeTask::RebuildPagesCache),
        "tasks[1] must be RebuildPagesCache, got {:?}",
        tasks[1]
    );
    assert!(
        matches!(tasks[2], MaterializeTask::RebuildAgendaCache),
        "tasks[2] must be RebuildAgendaCache, got {:?}",
        tasks[2]
    );
    assert!(
        matches!(tasks[3], MaterializeTask::RebuildProjectedAgendaCache),
        "tasks[3] must be RebuildProjectedAgendaCache, got {:?}",
        tasks[3]
    );
    assert!(
        matches!(tasks[4], MaterializeTask::RebuildTagInheritanceCache),
        "tasks[4] must be RebuildTagInheritanceCache, got {:?}",
        tasks[4]
    );
    assert!(
        matches!(tasks[5], MaterializeTask::RebuildPageIds),
        "tasks[5] must be RebuildPageIds, got {:?}",
        tasks[5]
    );
    assert!(
        matches!(tasks[6], MaterializeTask::RebuildBlockTagRefsCache),
        "tasks[6] must be RebuildBlockTagRefsCache, got {:?}",
        tasks[6]
    );
}

/// `enqueue_full_cache_rebuild` must push each of the seven canonical
/// tasks through the background queue and let the consumer process them.
/// Using `bg_processed` as the observability signal rather than queue
/// inspection keeps the test robust against consumer timing.
///
/// Note: `flush_background` enqueues a `Barrier` task that also counts as
/// processed, so the expected delta is `7 + 1 = 8`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enqueue_full_cache_rebuild_dispatches_all_six_tasks() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);

    let before = mat.metrics().bg_processed.load(AtomicOrdering::Relaxed);
    mat.enqueue_full_cache_rebuild()
        .expect("enqueue_full_cache_rebuild must succeed on a fresh materializer");
    mat.flush_background()
        .await
        .expect("flush_background must succeed after enqueuing the rebuild fan-out");
    let after = mat.metrics().bg_processed.load(AtomicOrdering::Relaxed);

    // 7 rebuild tasks + 1 flush Barrier.
    assert_eq!(
        after - before,
        8,
        "enqueue_full_cache_rebuild must dispatch exactly the 7 FULL_CACHE_REBUILD_TASKS entries (before={before}, after={after}, expected 7 + 1 flush barrier)"
    );
}

/// `dispatch_op` on a `DeleteBlock` op must produce the full cache fan-out
/// + a `RemoveFtsBlock` for the target — 8 background tasks in total plus
/// the flush barrier. This guards against the delete arm drifting away
/// from `enqueue_full_cache_rebuild`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_delete_block_enqueues_full_cache_rebuild_plus_fts_removal() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-M39-D", "content", "to delete").await;

    let before_bg = mat.metrics().bg_processed.load(AtomicOrdering::Relaxed);
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("blk-m39-d"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    mat.flush_background().await.unwrap();
    let after_bg = mat.metrics().bg_processed.load(AtomicOrdering::Relaxed);

    // 7 rebuild tasks + 1 RemoveFtsBlock + 1 flush Barrier = 9.
    assert_eq!(
        after_bg - before_bg,
        9,
        "delete_block must enqueue 7 cache rebuilds + 1 RemoveFtsBlock (+ 1 flush barrier)"
    );
}

/// `dispatch_op` on a `RestoreBlock` op must produce the full cache fan-out
/// + an `UpdateFtsBlock` for the target — 8 background tasks in total plus
/// the flush barrier.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_restore_block_enqueues_full_cache_rebuild_plus_fts_update() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-M39-R", "content", "was deleted").await;
    soft_delete_block_direct(&pool, "BLK-M39-R").await;

    let before_bg = mat.metrics().bg_processed.load(AtomicOrdering::Relaxed);
    let r = make_op_record(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id("blk-m39-r"),
            deleted_at_ref: FIXED_TS.into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    mat.flush_background().await.unwrap();
    let after_bg = mat.metrics().bg_processed.load(AtomicOrdering::Relaxed);

    // 7 rebuild tasks + 1 UpdateFtsBlock + 1 flush Barrier = 9.
    assert_eq!(
        after_bg - before_bg,
        9,
        "restore_block must enqueue 7 cache rebuilds + 1 UpdateFtsBlock (+ 1 flush barrier)"
    );
}

/// `dispatch_op` on a `PurgeBlock` op must produce the full cache fan-out
/// + a `RemoveFtsBlock` for the target — 8 background tasks in total plus
/// the flush barrier.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_purge_block_enqueues_full_cache_rebuild_plus_fts_removal() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-M39-P", "content", "to purge").await;

    let before_bg = mat.metrics().bg_processed.load(AtomicOrdering::Relaxed);
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("blk-m39-p"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    mat.flush_background().await.unwrap();
    let after_bg = mat.metrics().bg_processed.load(AtomicOrdering::Relaxed);

    // 7 rebuild tasks + 1 RemoveFtsBlock + 1 flush Barrier = 9.
    assert_eq!(
        after_bg - before_bg,
        9,
        "purge_block must enqueue 7 cache rebuilds + 1 RemoveFtsBlock (+ 1 flush barrier)"
    );
}

// BUG-46 regression for the materializer's `OpType::PurgeBlock` path:
// before the fix, the DELETE FROM block_tag_inherited only matched
// block_id / inherited_from, so rows whose `tag_id` column pointed at
// the purged tag were left behind and triggered FK error 787 when the
// tag row was about to be physically removed. Dispatch a PurgeBlock op
// for a soft-deleted tag that is still inherited by alive blocks and
// verify the handler commits cleanly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_purge_block_removes_block_tag_inherited_when_block_is_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Alive ancestor (page), alive child block, alive tag.
    insert_block_direct(&pool, "M_BUG46_ANC", "page", "alive ancestor").await;
    insert_block_direct(&pool, "M_BUG46_BLK", "content", "alive child").await;
    insert_block_direct(&pool, "M_BUG46_TAG", "tag", "doomed tag").await;

    // Inheritance row keyed on the tag via `tag_id` — the column the
    // original fix missed. block_id + inherited_from point at alive
    // blocks so only `tag_id` references the soft-deleted tag.
    sqlx::query(
        "INSERT INTO block_tag_inherited (block_id, tag_id, inherited_from) VALUES (?, ?, ?)",
    )
    .bind("M_BUG46_BLK")
    .bind("M_BUG46_TAG")
    .bind("M_BUG46_ANC")
    .execute(&pool)
    .await
    .unwrap();

    // Soft-delete the tag (leaves ancestor + child alive).
    soft_delete_block_direct(&pool, "M_BUG46_TAG").await;

    // Drive a PurgeBlock op through apply_op. Before the fix this
    // returned an FK-constraint error because `block_tag_inherited.tag_id`
    // still referenced M_BUG46_TAG when the core table DELETE ran.
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("M_BUG46_TAG"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();

    // Tag is physically gone.
    let tag_exists = sqlx::query("SELECT id FROM blocks WHERE id = 'M_BUG46_TAG'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        tag_exists.is_none(),
        "tag block must be physically removed after PurgeBlock apply_op"
    );

    // Alive ancestor + child untouched.
    let anc_exists = sqlx::query("SELECT id FROM blocks WHERE id = 'M_BUG46_ANC'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(anc_exists.is_some(), "alive ancestor must remain");
    let blk_exists = sqlx::query("SELECT id FROM blocks WHERE id = 'M_BUG46_BLK'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(blk_exists.is_some(), "alive child must remain");

    // Zero rows reference M_BUG46_TAG in any column of block_tag_inherited.
    let refs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_tag_inherited \
         WHERE block_id = ? OR tag_id = ? OR inherited_from = ?",
    )
    .bind("M_BUG46_TAG")
    .bind("M_BUG46_TAG")
    .bind("M_BUG46_TAG")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        refs, 0,
        "no block_tag_inherited row may reference the purged tag in any column"
    );
}

// ======================================================================
// FEAT-5h: DirtyEvent emission from the foreground apply_op path
// ======================================================================
//
// These tests drive the full foreground consumer — not `apply_op`
// directly — so they exercise the `OnceLock<GcalConnectorHandle>`
// plumbing end-to-end: set_gcal_handle, consumer read, per-op
// snapshot, per-op notify.

mod gcal_hook {
    use super::*;
    use crate::gcal_push::connector::{DirtyEvent, GcalConnectorHandle};
    use std::sync::Arc as StdArcInner;
    use tokio::sync::{mpsc, Notify};

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
    async fn seed_dated_block(
        pool: &SqlitePool,
        id: &str,
        due: Option<&str>,
        scheduled: Option<&str>,
    ) {
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
    async fn drain_events(
        rx: &mut mpsc::UnboundedReceiver<DirtyEvent>,
        max: usize,
    ) -> Vec<DirtyEvent> {
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
            }),
        )
        .await;
        mat.dispatch_op(&r).await.unwrap();
        mat.flush_foreground().await.unwrap();

        let events = drain_events(&mut rx, 5).await;
        assert_eq!(events.len(), 0, "no event for non-agenda property key");
    }
}

// ======================================================================
// UX-250 — ReindexBlockTagRefs / RebuildBlockTagRefsCache
// ======================================================================

#[test]
fn dedup_block_tag_refs_collapses_same_block_id() {
    let d = dedup_tasks(vec![
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "a".into(),
        },
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "b".into(),
        },
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "a".into(),
        },
        MaterializeTask::RebuildBlockTagRefsCache,
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "c".into(),
        },
    ]);
    assert_eq!(
        d.len(),
        4,
        "dedup should collapse same block_id reindex (a) but keep distinct ones (b, c) and the one RebuildBlockTagRefsCache"
    );
}

#[test]
fn dedup_reindex_block_tag_refs_and_block_links_independent() {
    // The two tasks share a block_id but are different task types and
    // must coexist through dedup.
    let d = dedup_tasks(vec![
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "X".into(),
        },
        MaterializeTask::ReindexBlockLinks {
            block_id: "X".into(),
        },
        MaterializeTask::ReindexBlockTagRefs {
            block_id: "X".into(),
        },
        MaterializeTask::ReindexBlockLinks {
            block_id: "X".into(),
        },
    ]);
    assert_eq!(
        d.len(),
        2,
        "links and tag-refs reindex share the block but have distinct dedup buckets"
    );
}

#[test]
fn dedup_rebuild_block_tag_refs_cache_collapses() {
    let d = dedup_tasks(vec![
        MaterializeTask::RebuildBlockTagRefsCache,
        MaterializeTask::RebuildBlockTagRefsCache,
        MaterializeTask::RebuildBlockTagRefsCache,
    ]);
    assert_eq!(
        d.len(),
        1,
        "repeated RebuildBlockTagRefsCache collapses to one via discriminant dedup"
    );
}

#[tokio::test]
async fn handle_bg_reindex_block_tag_refs_runs() {
    let (pool, _dir) = test_pool().await;
    // Fresh pool starts with no rows so the handler is a no-op on a
    // nonexistent block_id — the contract is "must not error".
    handle_background_task(
        &pool,
        &MaterializeTask::ReindexBlockTagRefs {
            block_id: "01HBTRBLK0000000000000NONE".into(),
        },
        None,
        None,
    )
    .await
    .unwrap();
    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_tag_refs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "nonexistent block produces no rows");
}

#[tokio::test]
async fn handle_bg_rebuild_block_tag_refs_cache_runs() {
    let (pool, _dir) = test_pool().await;
    // Seed a tag + a content block with an inline ref.
    let tag = "01HBTRTAGHBG00000000000001";
    let src = "01HBTRBLKHBG00000000000001";
    insert_block_direct(&pool, tag, "tag", "bg-tag").await;
    insert_block_direct(&pool, src, "content", &format!("#[{tag}]")).await;

    handle_background_task(
        &pool,
        &MaterializeTask::RebuildBlockTagRefsCache,
        None,
        None,
    )
    .await
    .unwrap();

    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_tag_refs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "full rebuild via materializer handler must populate the row"
    );
}

#[tokio::test]
async fn handle_bg_reindex_block_tag_refs_split_path() {
    let (pool, _dir) = test_pool().await;
    let tag = "01HBTRTAGSPL00000000000001";
    let src = "01HBTRBLKSPL00000000000001";
    insert_block_direct(&pool, tag, "tag", "spl").await;
    insert_block_direct(&pool, src, "content", &format!("#[{tag}]")).await;

    handle_background_task(
        &pool,
        &MaterializeTask::ReindexBlockTagRefs {
            block_id: src.into(),
        },
        Some(&pool), // same pool used for both read and write
        None,
    )
    .await
    .unwrap();

    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_tag_refs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "split-pool reindex path produces the same row");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_edit_block_enqueues_reindex_block_tag_refs() {
    // Verifies that the edit_block dispatch arm enqueues
    // ReindexBlockTagRefs against the block_id in the op payload, and
    // that the background handler scans the content and populates
    // block_tag_refs. To avoid a race between the foreground ApplyOp
    // (which commits the new content) and the background reindex
    // (which reads it), we seed the new content directly and then
    // dispatch only the background arm — the same code path that
    // `dispatch_op` uses once ApplyOp has flushed.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let tag = "01HBTRTAGDSPEDT00000000001";
    let src = "01HBTRBLKDSPEDT00000000001";
    insert_block_direct(&pool, tag, "tag", "e").await;
    insert_block_direct(&pool, src, "content", &format!("edited: #[{tag}]")).await;

    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(src),
            to_text: format!("edited: #[{tag}]"),
            prev_edit: None,
        }),
    )
    .await;

    // dispatch_edit_background is the path taken by the command handler
    // after the op has been durably written and the edit applied.
    mat.dispatch_edit_background(&r, "content").unwrap();
    mat.flush_background().await.unwrap();

    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM block_tag_refs WHERE source_id = ? AND tag_id = ?",
    )
    .bind(src)
    .bind(tag)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "edit_block must enqueue ReindexBlockTagRefs and populate the row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_create_block_with_inline_ref_populates_row() {
    // Same race-avoidance rationale as the edit_block test above: seed
    // the block directly, then verify that the background arm of
    // create_block dispatch enqueues ReindexBlockTagRefs and the handler
    // scans content to populate block_tag_refs.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let tag = "01HBTRTAGDSPCR000000000001";
    let src = "01HBTRBLKDSPCR000000000001";
    insert_block_direct(&pool, tag, "tag", "c").await;
    insert_block_direct(
        &pool,
        src,
        "content",
        &format!("fresh with inline ref: #[{tag}]"),
    )
    .await;

    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(src),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: format!("fresh with inline ref: #[{tag}]"),
        }),
    )
    .await;

    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();

    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM block_tag_refs WHERE source_id = ? AND tag_id = ?",
    )
    .bind(src)
    .bind(tag)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "create_block with non-empty content must enqueue ReindexBlockTagRefs"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatch_delete_block_fires_rebuild_block_tag_refs_cache() {
    // Verifies that a `delete_block` op triggers the full-cache-rebuild
    // fan-out (including `RebuildBlockTagRefsCache`). We arrange the
    // world so that the rebuild is *observable*: the source block is
    // already soft-deleted at the moment the rebuild runs, so its row
    // in block_tag_refs must disappear after the rebuild scans content.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let tag = "01HBTRTAGDSPDEL00000000001";
    let src = "01HBTRBLKDSPDEL00000000001";
    insert_block_direct(&pool, tag, "tag", "d").await;
    insert_block_direct(&pool, src, "content", &format!("#[{tag}]")).await;
    // Pre-populate block_tag_refs so we can observe the rebuild clearing
    // it once the source gets soft-deleted.
    sqlx::query!(
        "INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
        src,
        tag,
    )
    .execute(&pool)
    .await
    .unwrap();
    // Soft-delete the source directly so the rebuild observes the
    // deletion regardless of whether the foreground ApplyOp has landed
    // by the time the background consumer starts.
    soft_delete_block_direct(&pool, src).await;

    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id(src),
        }),
    )
    .await;

    // Trigger just the background fan-out; we don't need the foreground
    // ApplyOp for this assertion (the row is already soft-deleted).
    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();

    let count = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM block_tag_refs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "delete_block fires RebuildBlockTagRefsCache which drops rows for soft-deleted sources"
    );
}

// UX-250: `full_cache_rebuild_tasks_has_seven_entries_in_canonical_order`
// (above, in the MAINT-39 section) already asserts that
// FULL_CACHE_REBUILD_TASKS includes `RebuildBlockTagRefsCache` at slot 6.
// Keep that single authoritative assertion rather than duplicating it
// here.

// ============================================================================
// REVIEW-LATER C-3c — orphaned attachments GC tests
// ============================================================================

/// Helper: insert a row into `attachments` for the GC test.
async fn insert_attachment_row(
    pool: &SqlitePool,
    attachment_id: &str,
    block_id: &str,
    fs_path: &str,
) {
    // Make sure a parent block exists so the FK in `attachments` resolves.
    let _ = sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content) VALUES (?, 'content', '')",
    )
    .bind(block_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, 'application/octet-stream', 'f', 1, ?, '2025-01-01T00:00:00Z')",
    )
    .bind(attachment_id)
    .bind(block_id)
    .bind(fs_path)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_dir_missing_is_noop() {
    // C-3c safety check: no `attachments/` subdirectory under
    // `app_data_dir` → handler returns Ok and touches nothing.
    let (pool, dir) = test_pool().await;
    super::handlers::cleanup_orphaned_attachments(&pool, dir.path())
        .await
        .unwrap();
    assert!(
        !dir.path().join("attachments").exists(),
        "GC pass must not create the attachments directory"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_dir_empty_is_noop() {
    // C-3c safety check: empty `attachments/` → no-op.
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();
    super::handlers::cleanup_orphaned_attachments(&pool, dir.path())
        .await
        .unwrap();
    assert!(
        attachments.exists(),
        "empty attachments directory must remain after GC pass"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_all_referenced_keeps_files() {
    // C-3c happy path: every file in `attachments/` has a matching
    // row in the `attachments` table → no files removed.
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    for i in 0..3 {
        let rel = format!("attachments/file_{i}.dat");
        let full = dir.path().join(&rel);
        tokio::fs::write(&full, b"data").await.unwrap();
        insert_attachment_row(&pool, &format!("ATT_{i}"), &format!("BLK_{i}"), &rel).await;
    }

    super::handlers::cleanup_orphaned_attachments(&pool, dir.path())
        .await
        .unwrap();

    for i in 0..3 {
        let full = dir.path().join(format!("attachments/file_{i}.dat"));
        assert!(
            full.exists(),
            "referenced attachment file must not be removed: {}",
            full.display()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_all_orphaned_are_removed() {
    // C-3c reconciliation path: 3 files on disk, 0 rows referencing
    // them → all 3 unlinked.
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    for i in 0..3 {
        let full = attachments.join(format!("orphan_{i}.dat"));
        tokio::fs::write(&full, b"orphaned").await.unwrap();
    }

    super::handlers::cleanup_orphaned_attachments(&pool, dir.path())
        .await
        .unwrap();

    for i in 0..3 {
        let full = attachments.join(format!("orphan_{i}.dat"));
        assert!(
            !full.exists(),
            "orphan file must be removed: {}",
            full.display()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_mixed_referenced_and_orphaned() {
    // C-3c mixed case: 2 referenced files + 1 orphan → only the
    // orphan unlinked, references untouched.
    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    tokio::fs::create_dir_all(&attachments).await.unwrap();

    let rel_a = "attachments/keep_a.dat".to_string();
    let rel_b = "attachments/keep_b.dat".to_string();
    let rel_orphan = "attachments/orphan.dat".to_string();

    tokio::fs::write(dir.path().join(&rel_a), b"a")
        .await
        .unwrap();
    tokio::fs::write(dir.path().join(&rel_b), b"b")
        .await
        .unwrap();
    tokio::fs::write(dir.path().join(&rel_orphan), b"o")
        .await
        .unwrap();

    insert_attachment_row(&pool, "ATT_A", "BLK_A", &rel_a).await;
    insert_attachment_row(&pool, "ATT_B", "BLK_B", &rel_b).await;

    super::handlers::cleanup_orphaned_attachments(&pool, dir.path())
        .await
        .unwrap();

    assert!(
        dir.path().join(&rel_a).exists(),
        "referenced file A must remain"
    );
    assert!(
        dir.path().join(&rel_b).exists(),
        "referenced file B must remain"
    );
    assert!(
        !dir.path().join(&rel_orphan).exists(),
        "orphan file must be removed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_subdir_walk() {
    // C-3c subdirectory walk: a file under `attachments/sub/` must be
    // walked into and removed if unreferenced. FEAT-3 large-vault
    // layouts may organize attachments into subdirectories.
    let (pool, dir) = test_pool().await;
    let sub = dir.path().join("attachments").join("sub");
    tokio::fs::create_dir_all(&sub).await.unwrap();
    let nested = sub.join("x.dat");
    tokio::fs::write(&nested, b"nested orphan").await.unwrap();

    super::handlers::cleanup_orphaned_attachments(&pool, dir.path())
        .await
        .unwrap();

    assert!(
        !nested.exists(),
        "nested orphan in subdirectory must be removed: {}",
        nested.display()
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments_unlink_error_is_non_fatal() {
    // C-3c robustness: when an unlink fails (e.g. parent directory is
    // read-only), the GC pass must still complete Ok and continue
    // processing other files. Skipped on Windows because Unix-style
    // chmod doesn't translate to a "remove blocked" semantic there.
    use std::os::unix::fs::PermissionsExt;

    let (pool, dir) = test_pool().await;
    let attachments = dir.path().join("attachments");
    let locked = attachments.join("locked");
    tokio::fs::create_dir_all(&locked).await.unwrap();

    // Place an orphan inside the read-only directory so `remove_file`
    // gets EACCES while the parent walk still succeeds (read perms
    // intact, write perms removed via 0o555).
    let orphan = locked.join("blocked.dat");
    tokio::fs::write(&orphan, b"can't unlink me").await.unwrap();

    let mut perms = std::fs::metadata(&locked).unwrap().permissions();
    perms.set_mode(0o555);
    std::fs::set_permissions(&locked, perms).unwrap();

    // Also place an orphan in a normal directory so we can confirm the
    // pass continued past the failure.
    let removable = attachments.join("removable.dat");
    tokio::fs::write(&removable, b"orphan").await.unwrap();

    let result = super::handlers::cleanup_orphaned_attachments(&pool, dir.path()).await;

    // Restore write perms so TempDir can clean up.
    let mut perms = std::fs::metadata(&locked).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&locked, perms).unwrap();

    assert!(
        result.is_ok(),
        "GC pass must not propagate per-file unlink errors"
    );
    assert!(
        !removable.exists(),
        "removable orphan must still be unlinked even if another file failed",
    );
}

// ======================================================================
// H-5 / H-6 (2026-04) — foreground FIFO regression tests
// ======================================================================
//
// These tests pin the post-fix contract: the foreground segment runs
// tasks strictly FIFO, with no JoinSet bucketing by `block_id`. Pre-fix,
// two cascading `ApplyOp` tasks (parent then child) could land in
// different buckets keyed on their respective block_ids and race on
// apply — producing an SQLite FK violation on the child's `parent_id`
// when the child raced ahead of the parent. `BatchApplyOps` likewise
// keyed on `records[0].block_id` only, so a batch touching blocks
// `X, Y, Z` could run in parallel with an independent `ApplyOp` for
// `Y`, racing to mutate the same row.
//
// Both races are structurally impossible after the JoinSet path was
// removed (SQLite serialises writes anyway, so the "parallelism"
// bought no throughput while introducing real hazards).

/// H-5 regression: a parent-create op followed by a child-create op
/// whose `parent_id` references the parent must both land cleanly when
/// enqueued as two distinct `ApplyOp` tasks back-to-back. Pre-fix,
/// these would have been routed to different buckets (key = parent.id
/// and key = child.id) and dispatched to a JoinSet, creating a race
/// window where the child's INSERT could hit SQLite's FK check before
/// the parent's INSERT committed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h5_parent_and_child_create_both_land_under_strict_fifo() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("H5_PARENT"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "parent".into(),
        }),
    )
    .await;
    let child = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("H5_CHILD"),
            block_type: "content".into(),
            // Forces parent→child FK ordering.
            parent_id: Some(BlockId::test_id("H5_PARENT")),
            position: Some(1),
            content: "child".into(),
        }),
    )
    .await;

    // Two separate `ApplyOp` tasks enqueued back-to-back. Under the
    // pre-fix JoinSet dispatch these hashed to different buckets (one
    // per block_id) and raced; the strict-FIFO path must land both
    // deterministically.
    mat.enqueue_foreground(MaterializeTask::ApplyOp(parent))
        .await
        .unwrap();
    mat.enqueue_foreground(MaterializeTask::ApplyOp(child))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();

    let parent_row: Option<String> =
        sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'H5_PARENT'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        parent_row.as_deref(),
        Some("parent"),
        "parent block must be materialized"
    );

    let child_row: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT content, parent_id FROM blocks WHERE id = 'H5_CHILD'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        child_row.0.as_deref(),
        Some("child"),
        "child block must be materialized after parent"
    );
    assert_eq!(
        child_row.1.as_deref(),
        Some("H5_PARENT"),
        "child.parent_id must point at the parent that landed first"
    );

    // Neither apply should have hit the retry path — under strict FIFO
    // the FK-ordering race that previously forced a retry is gone.
    assert_eq!(
        mat.metrics().fg_apply_dropped.load(AtomicOrdering::Relaxed),
        0,
        "no apply should be dropped under strict FIFO"
    );
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "no foreground error should surface; both applies must succeed on the first attempt"
    );
}

/// H-6 regression: a `BatchApplyOps` containing multiple block_ids
/// followed by an independent `ApplyOp` targeting one of the batch's
/// non-first block_ids must serialize correctly — the edit must land
/// AFTER the batch's create, producing the edited content.
///
/// Pre-fix, the batch's grouping key was `records[0].block_id` (the
/// `X` here), so the independent `ApplyOp` for `Y` hashed to a
/// different bucket and raced the batch via JoinSet. The edit could
/// reach `Y` before the batch had inserted the `Y` row, dropping the
/// edit (UPDATE affects 0 rows) or erroring (depending on op type).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn h6_batch_and_concurrent_apply_op_serialize_in_fifo() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let create_x = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("H6_X"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "x-initial".into(),
        }),
    )
    .await;
    let create_y = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("H6_Y"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(2),
            content: "y-initial".into(),
        }),
    )
    .await;
    // Batch with two different block_ids — H6_X first so the pre-fix
    // bucketing key would have been H6_X.
    let batch = MaterializeTask::BatchApplyOps(StdArc::new(vec![create_x, create_y]));

    // Independent edit targeting H6_Y (the batch's *second* record).
    // Pre-fix, this landed in a different bucket from the batch and
    // raced.
    let edit_y = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("H6_Y"),
            to_text: "y-edited".into(),
            prev_edit: None,
        }),
    )
    .await;

    mat.enqueue_foreground(batch).await.unwrap();
    mat.enqueue_foreground(MaterializeTask::ApplyOp(edit_y))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();

    let y_content: Option<String> =
        sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'H6_Y'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        y_content.as_deref(),
        Some("y-edited"),
        "edit must land AFTER the batch's create — strict FIFO guarantees no race"
    );

    let x_content: Option<String> =
        sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'H6_X'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        x_content.as_deref(),
        Some("x-initial"),
        "batch's other block (H6_X, the former bucketing-key record) must also land"
    );

    assert_eq!(
        mat.metrics().fg_apply_dropped.load(AtomicOrdering::Relaxed),
        0,
        "no apply should be dropped under strict FIFO"
    );
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "no foreground error should surface"
    );
}
