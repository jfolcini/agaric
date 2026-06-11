use super::*;

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
            index: None,
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
            index: None,
            content: "child".into(),
        }),
    )
    .await;

    // Two separate `ApplyOp` tasks enqueued back-to-back. Under the
    // pre-fix JoinSet dispatch these hashed to different buckets (one
    // per block_id) and raced; the strict-FIFO path must land both
    // deterministically.
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(parent)))
        .await
        .unwrap();
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(child)))
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
            index: None,
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
            index: None,
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
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(edit_y)))
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

// ──────────────────────────────────────────────────────────────────────
// L-15 — risk-area regression seats
//
// L-15 flagged the materializer as well-covered on happy paths but
// thin on a handful of failure / saturation / dispatch-edge code paths.
// The four tests below pin those uncovered behaviors as regression
// seats. They document current behavior — including the deliberately
// "drop on permanent failure" foreground apply contract from C-2a/b —
// rather than introducing new behavior. See the per-test comments for
// the exact contract being locked down.
// ──────────────────────────────────────────────────────────────────────

/// L-15 sub-test 1: an `ApplyOp` that fails permanently (FK violation
/// with a non-existent `parent_id`) is dropped after the foreground
/// retry exhausts, but the op_log row remains populated because
/// `append_local_op` committed before the apply attempt ran.
///
/// This is the regression seat for the eventual C-2b boot-replay fix:
/// any future patch that adds boot-time replay of dropped applies
/// must keep the op_log entry available so the replay sweep can
/// re-attempt the op once its FK dependency lands. Today the apply is
/// silently dropped (`fg_apply_dropped += 1`) and the divergence is
/// surfaced in logs and `StatusInfo` only — sync replay is the
/// long-term recovery mechanism.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_permanent_failure_leaves_op_log_populated_l15() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // The op_log append succeeds independently of any FK validation —
    // the op_log table has no FK to `blocks`. The apply itself fails
    // because `blocks.parent_id REFERENCES blocks(id)` is enforced and
    // `L15_NONEXISTENT_PARENT` was never inserted.
    let record = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("L15_ORPHAN_CHILD"),
            block_type: "content".into(),
            parent_id: Some(BlockId::test_id("L15_NONEXISTENT_PARENT")),
            position: Some(0),
            index: None,
            content: "orphan".into(),
        }),
    )
    .await;

    // Use `enqueue_foreground` directly (rather than `dispatch_op`) to
    // isolate the foreground apply-retry behavior from the parallel
    // background fan-out — this test only cares about the fg drop.
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(record)))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();

    // 1. op_log row IS populated — `append_local_op` committed before
    //    the apply was even enqueued.
    let oplog_count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        oplog_count, 1,
        "op_log row must remain populated after a permanent apply failure (regression seat for C-2b boot-replay)"
    );

    // 2. The corresponding row in `blocks` is NOT created — the FK
    //    violation rolled back the apply transaction (and the retry
    //    rolled back identically).
    let blocks_count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM blocks WHERE id = ?",
        "L15_ORPHAN_CHILD"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        blocks_count, 0,
        "FK-violating CreateBlock must not materialize after retry exhaust"
    );

    // 3. The drop-on-permanent-failure metric incremented — this is
    //    the operator-visible signal in `StatusInfo` until C-2b lands.
    let m = mat.metrics();
    assert_eq!(
        m.fg_apply_dropped.load(AtomicOrdering::Relaxed),
        1,
        "permanent ApplyOp failure must bump fg_apply_dropped exactly once",
    );
    assert_eq!(
        m.fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "permanent ApplyOp failure must bump fg_errors exactly once",
    );

    mat.shutdown();
}

/// L-15 sub-test 2: a `BatchApplyOps` whose ops include a parent
/// CreateBlock followed by a child CreateBlock (with `parent_id` set
/// to the parent's id) commits cleanly inside a single batch
/// transaction — both rows must exist after flush.
///
/// The risk this guards against is FK ordering: the batch executes
/// the two `INSERT INTO blocks` statements sequentially within ONE
/// transaction, so the parent is visible to the child's FK check
/// before the transaction commits. `worker_threads = 4` maximises
/// the chance that any latent reordering hazard (none today, but a
/// future refactor that splits the batch across connections would
/// surface) shows up in CI rather than only on the affected user's
/// machine. This is the batch-level analogue of `H5_PARENT/H5_CHILD`
/// which exercises two distinct `ApplyOp` tasks.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn apply_op_parent_child_same_batch_fk_ordering_l15() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let parent = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("L15_BATCH_PARENT"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            index: None,
            content: "parent".into(),
        }),
    )
    .await;
    let child = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("L15_BATCH_CHILD"),
            block_type: "content".into(),
            // FK target is the parent that is the FIRST op of the SAME
            // batch transaction — must be visible by the time the
            // child INSERT runs.
            parent_id: Some(BlockId::test_id("L15_BATCH_PARENT")),
            position: Some(1),
            index: None,
            content: "child".into(),
        }),
    )
    .await;

    mat.enqueue_foreground(MaterializeTask::BatchApplyOps(StdArc::new(vec![
        parent, child,
    ])))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();

    let parent_row: Option<String> =
        sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'L15_BATCH_PARENT'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        parent_row.as_deref(),
        Some("parent"),
        "parent row must commit as part of the batch transaction"
    );

    let child_row: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT content, parent_id FROM blocks WHERE id = 'L15_BATCH_CHILD'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        child_row.0.as_deref(),
        Some("child"),
        "child row must commit alongside the parent in the same batch"
    );
    assert_eq!(
        child_row.1.as_deref(),
        Some("L15_BATCH_PARENT"),
        "child.parent_id must reference the parent inserted earlier in the same batch"
    );

    // Neither op should have hit the retry path.
    assert_eq!(
        mat.metrics().fg_apply_dropped.load(AtomicOrdering::Relaxed),
        0,
        "no apply should be dropped — both ops commit cleanly in one batch tx"
    );
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "no foreground error expected for a parent-then-child batch"
    );

    mat.shutdown();
}

/// L-15 sub-test 3: a stricter version of the existing
/// `try_enqueue_background_drops_when_full` — push exactly
/// `BACKGROUND_CAPACITY + 100` tasks rapidly via `try_enqueue_background`
/// (bypassing `dispatch_op` so the consumer never sees the cooperative
/// yield it would get from a higher-level dispatch path) and assert
/// that `bg_dropped` increments at least once. The Full arm in
/// `try_enqueue_background` is the only place the metric is bumped, so
/// observing the increment confirms the saturation path is reachable.
///
/// Single-threaded `#[tokio::test]` runtime guarantees the bg consumer
/// task cannot run during the synchronous `for` loop, so the bounded
/// channel fills at `BACKGROUND_CAPACITY` and every subsequent send
/// lands in the Full arm deterministically.
#[tokio::test]
async fn try_enqueue_background_actually_drops_when_full_l15() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);

    // BACKGROUND_CAPACITY is the bg channel's bound; pushing
    // `BACKGROUND_CAPACITY + 100` synchronously, with no `.await` in
    // between, prevents the consumer task from running and gives 100
    // sends a chance to hit the Full arm.
    for _ in 0..(BACKGROUND_CAPACITY + 100) {
        // Each call returns Ok regardless of whether it landed or was
        // shed — the helper preserves the Ok return for back-compat.
        let _ = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
    }

    let dropped = mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed);
    assert!(
        dropped >= 1,
        "bg_dropped must increment at least once when BG_CAPACITY+100 sends saturate the queue, got {dropped}"
    );

    mat.shutdown();
}

/// L-15 sub-test 4: release-mode counterpart to
/// `dispatch_bg_empty_block_id` (which uses `#[should_panic]` against
/// a `debug_assert!`).
///
/// `dispatch::enqueue_background_tasks` contains a `debug_assert!` in
/// the `edit_block` arm for the empty-block_id case. In release builds
/// the assertion is compiled out and the dispatch falls through to the
/// `if !block_id.is_empty()` guards, which skip every block-id-specific
/// task (`ReindexBlockLinks`, `ReindexBlockTagRefs`, `UpdateFtsBlock`).
/// Only the global-rebuild fallback (RebuildTagsCache / RebuildPagesCache
/// / RebuildAgendaCache) plus the fixed FTS-optimize threshold check
/// are enqueued — none of which touches the empty block_id, so nothing
/// crashes on the bg consumer.
///
/// This test pins that release-mode contract: an empty block_id is a
/// soft programmer error, not a runtime crash. It is gated on
/// `#[cfg(not(debug_assertions))]` because the same dispatch call
/// panics in a debug build (covered by `dispatch_bg_empty_block_id`).
/// When the orchestrator's verification runs in debug mode this test
/// is excluded from compilation; the regression seat is exercised when
/// reviewers explicitly build in release mode (e.g.
/// `cargo nextest run --release -E '...l15$'`).
#[cfg(not(debug_assertions))]
#[tokio::test]
async fn dispatch_bg_empty_block_id_release_mode_l15() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // In release mode: must NOT panic, must return Ok, and must skip
    // every block-id-specific task via the `if !block_id.is_empty()`
    // guards. We exercise the dispatch path directly to lock down the
    // production code-path's release-mode behavior.
    mat.dispatch_background(&fake_op_record(
        "edit_block",
        r#"{"to_text":"hello","prev_edit":null}"#,
    ))
    .expect("release-mode dispatch must not return an error for an empty block_id");

    // Drain the queue. Only global rebuilds and possibly FtsOptimize
    // are expected; none touches the empty block_id, so the bg
    // consumer must not error or panic.
    mat.flush_background().await.unwrap();

    let m = mat.metrics();
    assert_eq!(
        m.bg_errors.load(AtomicOrdering::Relaxed),
        0,
        "empty-block_id fallback must not produce any background errors"
    );
    assert_eq!(
        m.bg_panics.load(AtomicOrdering::Relaxed),
        0,
        "empty-block_id fallback must not panic any background task"
    );

    mat.shutdown();
}
