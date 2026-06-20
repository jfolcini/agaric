use super::*;

/// Regression test for the follow-up bug: the materializer
/// constructors must not panic when called outside any Tokio runtime
/// context, because that is exactly the context Tauri 2's `setup`
/// callback runs in (synchronously on the main thread before the app
/// Loop enters its runtime). Pre-fix, the commit replaced the
/// previous `tauri::async_runtime::spawn` (which uses Tauri's stored
/// runtime handle) with `JoinSet::spawn` (which calls
/// `Handle::current()` and panics outside a runtime), so the
/// production AppImage panicked at startup with "there is no reactor
/// running, must be called from the context of a Tokio 1.x runtime".
/// The test suite did not catch it because every test runs inside
/// `#[tokio::test]`, which provides a runtime context.
///
/// `Materializer::new` and `Materializer::with_read_pool_and_lifecycle`
/// share the same private `Self::build` helper which performs all
/// four startup `Self::spawn_task` calls, so a failure in either
/// constructor surfaces the same bug. Both are covered by a dedicated
/// `#[test]` (NOT `#[tokio::test]`) below: each uses a short-lived
/// `tokio::runtime::Runtime` only to build a `SqlitePool` (the only
/// async setup needed), drops the entered guard before constructing
/// the materializer, and exercises the public constructor from the
/// thread's bare context — reproducing Tauri's setup-time shape.
#[test]
fn materializer_new_does_not_panic_without_current_runtime() {
    use tokio::runtime::Runtime;

    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");

    let pool_runtime = Runtime::new().unwrap();
    let pool = pool_runtime.block_on(async { init_pool(&db_path).await.unwrap() });
    // After block_on returns, this thread is NOT in any tokio runtime
    // context. Confirm that to make the test's invariant explicit.
    assert!(
        tokio::runtime::Handle::try_current().is_err(),
        "test precondition: thread must not be in a tokio runtime context",
    );

    // Pre-fix this line panicked: `JoinSet::spawn` in the four
    // construction-time `Self::spawn_task` calls invoked
    // `Handle::current()` and there was no current runtime.
    let mat = Materializer::new(pool);

    // Sanity: shutdown must still work synchronously from a
    // non-runtime thread.
    mat.shutdown();

    // Keep the pool runtime alive until after the materializer is
    // dropped; otherwise tasks bound to Tauri's async_runtime that
    // hold pool references would race teardown.
    drop(pool_runtime);
}

/// Same regression as above, but covers
/// `Materializer::with_read_pool_and_lifecycle` — the constructor
/// actually used in `lib.rs` setup. Even though both constructors
/// dispatch to the same `Self::build`, pinning both protects against
/// a future refactor that splits the builders without re-checking
/// the no-runtime invariant.
#[test]
fn materializer_with_read_pool_and_lifecycle_does_not_panic_without_current_runtime() {
    use tokio::runtime::Runtime;

    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");

    let pool_runtime = Runtime::new().unwrap();
    let pool = pool_runtime.block_on(async { init_pool(&db_path).await.unwrap() });
    assert!(
        tokio::runtime::Handle::try_current().is_err(),
        "test precondition: thread must not be in a tokio runtime context",
    );

    let lifecycle = crate::lifecycle::LifecycleHooks::new();
    let mat = Materializer::with_read_pool_and_lifecycle(pool.clone(), pool, lifecycle);

    mat.shutdown();
    drop(pool_runtime);
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
            index: None,
            content: "hello".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(r)))
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
            index: None,
            content: "flush fg".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(r)))
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
            index: None,
            content: "flush both".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(StdArc::new(r)))
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
        MaterializeTask::ApplyOp(StdArc::new(r.clone())),
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::ApplyOp(StdArc::new(r.clone())),
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::ApplyOp(StdArc::new(r)),
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
