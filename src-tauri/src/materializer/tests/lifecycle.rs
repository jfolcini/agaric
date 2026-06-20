use super::*;

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
// The foreground / background sender accessors must
// hand out clones of the *same* tokio mpsc channel on every call.
// Storage moved from `Arc<Mutex<Option<Sender>>>` to
// `Arc<OnceLock<Sender>>` — repeated `fg_sender()` / `bg_sender()` calls
// must continue to share one channel (write-once semantic).
// ──────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn fg_and_bg_sender_return_same_channel_across_calls() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let fg1 = mat.fg_sender().expect("fg sender available after new()");
    let fg2 = mat.fg_sender().expect("fg sender still available");
    assert!(
        fg1.same_channel(&fg2),
        "fg_sender must hand out the same channel on every call"
    );
    let bg1 = mat.bg_sender().expect("bg sender available after new()");
    let bg2 = mat.bg_sender().expect("bg sender still available");
    assert!(
        bg1.same_channel(&bg2),
        "bg_sender must hand out the same channel on every call"
    );
}

// ──────────────────────────────────────────────────────────────────────
// Wait_for_initial_block_count_cache
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
// Wait_for_pending_block_count_refreshes
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
        .block_count_test_hooks
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
        mat.block_count_test_hooks
            .pending_block_count_refreshes
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
        .block_count_test_hooks
        .pending_block_count_refreshes
        .load(AtomicOrdering::Acquire)
        != 0
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "test precondition: refresh did not drain the counter within 5s \
             (last value: {})",
            mat.block_count_test_hooks
                .pending_block_count_refreshes
                .load(AtomicOrdering::Acquire)
        );
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
        mat.block_count_test_hooks
            .pending_block_count_refreshes
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

/// The lifecycle-aware constructor must produce a fully
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

/// Flipping the foreground flag must not corrupt the
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
