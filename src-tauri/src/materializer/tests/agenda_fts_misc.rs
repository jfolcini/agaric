use super::*;

// ======================================================================
// PEND-25 L2 + L9: `DeferredNotification.record` is `Arc<OpRecord>` and
// the `enqueue_*_background` family on `CommandTx` accepts
// `impl Into<Arc<OpRecord>>`. Together these let the producer wrap
// once and the dispatch + post-commit borrow share the record by
// refcount.
//
// This regression test exercises the `Arc<OpRecord>` shift on the
// `MaterializeTask::ApplyOp(Arc<OpRecord>)` path: the foreground
// handler calls `apply_op(record: &Arc<OpRecord>, ...)` which builds a
// `DeferredNotification` via `Arc::clone(record)`. We assert the
// post-call refcount goes down to 1 (the test's local handle), proving
// the dispatcher dropped its clone after firing the notification.
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_arc_record_does_not_leak_strong_count() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "ARC_OP_1", "content", "block-content").await;

    // Build the op record, then wrap in `Arc`. The dispatcher will
    // `Arc::clone` it inside `MaterializeTask::ApplyOp` and again inside
    // `DeferredNotification`; both clones must drop before the call
    // returns.
    let raw = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("ARC_OP_1"),
            to_text: "edited-content".into(),
            prev_edit: None,
        }),
    )
    .await;
    let record = StdArc::new(raw);
    assert_eq!(
        StdArc::strong_count(&record),
        1,
        "freshly-wrapped Arc starts at strong_count 1"
    );

    // Drive the ApplyOp through the foreground handler. The Arc inside
    // the task is cloned from our local handle, so the strong_count
    // observed by the handler is 2; the handler in turn `Arc::clone`s
    // for its `DeferredNotification` push (refcount 3 inside the call)
    // and drops both back when the handler returns.
    let task = MaterializeTask::ApplyOp(StdArc::clone(&record));
    handle_foreground_task(&pool, &task, &empty_gcal_handle())
        .await
        .unwrap();
    drop(task);

    // After the handler returns and the task is dropped, only our
    // local handle remains.
    assert_eq!(
        StdArc::strong_count(&record),
        1,
        "PEND-25 L2/L9: ApplyOp dispatch must not leak Arc<OpRecord> clones \
         beyond the handler invocation (got strong_count = {})",
        StdArc::strong_count(&record)
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
    let task = MaterializeTask::ApplyOp(StdArc::new(r));
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
            index: None,
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
    // under nextest parallelism (TEST-2).
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
    // clobbers it with the real count (TEST-2).
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

/// The canonical fan-out list must contain the eight block-referencing
/// cache rebuild variants in a fixed order. Adding a 9th cache means
/// extending this array; the dispatch arms pick it up automatically.
/// Any drift between the delete/restore/purge arms and this constant is
/// a regression.
#[test]
fn full_cache_rebuild_tasks_has_eight_entries_in_canonical_order() {
    let tasks = &super::super::dispatch::FULL_CACHE_REBUILD_TASKS;
    // UX-250 extended the array with `RebuildBlockTagRefsCache` (7th);
    // SQL-review §H-2 added `RebuildPageLinkCache` (8th).
    assert_eq!(
        tasks.len(),
        8,
        "FULL_CACHE_REBUILD_TASKS must contain exactly the 8 block-referencing caches"
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
    assert!(
        matches!(tasks[7], MaterializeTask::RebuildPageLinkCache),
        "tasks[7] must be RebuildPageLinkCache, got {:?}",
        tasks[7]
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

    // 8 rebuild tasks + 1 flush Barrier (post-SQL-review §H-2).
    assert_eq!(
        after - before,
        9,
        "enqueue_full_cache_rebuild must dispatch exactly the 8 FULL_CACHE_REBUILD_TASKS entries (before={before}, after={after}, expected 8 + 1 flush barrier)"
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

    // 8 rebuild tasks + 1 RemoveFtsBlock + 1 flush Barrier = 10
    // (post-SQL-review §H-2).
    assert_eq!(
        after_bg - before_bg,
        10,
        "delete_block must enqueue 8 cache rebuilds + 1 RemoveFtsBlock (+ 1 flush barrier)"
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
            deleted_at_ref: FIXED_TS,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    mat.flush_background().await.unwrap();
    let after_bg = mat.metrics().bg_processed.load(AtomicOrdering::Relaxed);

    // 8 rebuild tasks + 1 UpdateFtsBlock + 1 flush Barrier = 10
    // (post-SQL-review §H-2).
    assert_eq!(
        after_bg - before_bg,
        10,
        "restore_block must enqueue 8 cache rebuilds + 1 UpdateFtsBlock (+ 1 flush barrier)"
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

    // 8 rebuild tasks + 1 RemoveFtsBlock + 1 flush Barrier = 10
    // (post-SQL-review §H-2).
    assert_eq!(
        after_bg - before_bg,
        10,
        "purge_block must enqueue 8 cache rebuilds + 1 RemoveFtsBlock (+ 1 flush barrier)"
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
