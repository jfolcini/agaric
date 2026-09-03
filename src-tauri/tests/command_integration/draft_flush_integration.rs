//! Integration tests for the draft-flush materialization + supersession fix
//! (#2651).
//!
//! Before the fix, `flush_draft` / `flush_all_drafts` appended an `edit_block`
//! op but never materialized `blocks.content` nor applied the op to the Loro
//! engine — the op sat unmaterialized until the next boot replay, so
//! `blocks.content` held the pre-flush text (typing appeared reverted on
//! navigate-back) and the background FTS/link reindex indexed STALE content.
//!
//! The fix routes the just-appended record through `apply_op_projected` in the
//! SAME `CommandTx` (exactly like `edit_block_inner`), so `blocks.content` and
//! the per-space engine are updated atomically with the op append. It also adds
//! a supersession guard (mirroring boot draft-recovery) so a stale stored draft
//! flushed AFTER a newer edit does not regress content.

use super::common::*;

/// Count `edit_block` ops targeting a given block id in `op_log`.
async fn count_edit_block_ops(pool: &SqlitePool, block_id: &str) -> i64 {
    sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE op_type = 'edit_block' \
         AND json_extract(payload, '$.block_id') = ?",
        block_id,
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Read `blocks.content` directly (bypasses any reprojection cache).
async fn block_content(pool: &SqlitePool, block_id: &str) -> Option<String> {
    sqlx::query_scalar!("SELECT content FROM blocks WHERE id = ?", block_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn draft_exists(pool: &SqlitePool, block_id: &str) -> bool {
    agaric_engine::draft::get_draft(pool, block_id)
        .await
        .unwrap()
        .is_some()
}

// ---------------------------------------------------------------------------
// (a) core regression — flush_draft materializes blocks.content (not stale)
//     and (b) the engine-backed apply path writes it (create_block_inner
//     mounts the per-space engine, and the flush routes through
//     `apply_op_projected` → engine apply → reproject → `UPDATE blocks`).
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flush_draft_materializes_content_not_stale() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    // Real, engine-mounted block seeded via the command path.
    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "before".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let id = created.id.as_str().to_string();

    // Autosave a newer draft, then flush it (blur / unmount path).
    agaric_engine::draft::save_draft(&pool, DEV, &id, "after")
        .await
        .unwrap();

    flush_draft_inner(&pool, DEV, created.id.clone(), &mat)
        .await
        .expect("flush must succeed");
    settle(&mat).await;

    // Core regression: blocks.content must be the flushed text, NOT the stale
    // pre-flush "before". Before the fix this read "before" until the next boot.
    assert_eq!(
        block_content(&pool, &id).await,
        Some("after".into()),
        "#2651: blocks.content must reflect the flushed draft in-tx, not stale text",
    );
    // The reprojection read path (engine-backed) agrees.
    let row = get_block_inner(&pool, created.id.clone()).await.unwrap();
    assert_eq!(
        row.content,
        Some("after".into()),
        "#2651: get_block_inner (engine-backed reproject) must reflect the flush",
    );
    // Exactly one edit_block op was appended by the flush.
    assert_eq!(
        count_edit_block_ops(&pool, &id).await,
        1,
        "flush appends one edit_block op"
    );
    assert!(
        !draft_exists(&pool, &id).await,
        "draft row deleted after flush"
    );

    mat.shutdown();
}

// ---------------------------------------------------------------------------
// (a')/batch — flush_all_drafts materializes blocks.content too.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flush_all_drafts_materializes_content_not_stale() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let a = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "a-before".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    let b = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "b-before".into(),
        None,
        Some(2),
    )
    .await
    .unwrap();
    settle(&mat).await;

    let a_id = a.id.as_str().to_string();
    let b_id = b.id.as_str().to_string();

    agaric_engine::draft::save_draft(&pool, DEV, &a_id, "a-after")
        .await
        .unwrap();
    agaric_engine::draft::save_draft(&pool, DEV, &b_id, "b-after")
        .await
        .unwrap();

    let result = flush_all_drafts_inner(&pool, DEV, &mat)
        .await
        .expect("flush_all must succeed");
    assert_eq!(result.flushed, 2, "both drafts processed");
    settle(&mat).await;

    assert_eq!(
        block_content(&pool, &a_id).await,
        Some("a-after".into()),
        "#2651: flush_all must materialize block a's content",
    );
    assert_eq!(
        block_content(&pool, &b_id).await,
        Some("b-after".into()),
        "#2651: flush_all must materialize block b's content",
    );
    assert!(!draft_exists(&pool, &a_id).await);
    assert!(!draft_exists(&pool, &b_id).await);

    mat.shutdown();
}

// ---------------------------------------------------------------------------
// (c) supersession guard — a stale draft flushed AFTER a newer edit_block must
//     NOT regress content. The newer edit wins; the flush appends nothing.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flush_draft_superseded_by_newer_edit_does_not_regress() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);

    let created = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "v1".into(),
        None,
        Some(1),
    )
    .await
    .unwrap();
    settle(&mat).await;
    let id = created.id.as_str().to_string();

    // 1. Autosave a stale draft. Its monotonic anchor captures the op-log
    //    high-water at THIS moment (the create op).
    agaric_engine::draft::save_draft(&pool, DEV, &id, "stale-draft")
        .await
        .unwrap();

    // 2. A NEWER edit_block lands AFTER the draft was saved — seq > anchor.
    edit_block_inner(&pool, DEV, &mat, created.id.clone(), "newer-edit".into())
        .await
        .unwrap();
    settle(&mat).await;

    // 3. Now the (stale) draft is flushed. The supersession guard must detect
    //    the newer edit and DROP the draft without appending/applying anything.
    flush_draft_inner(&pool, DEV, created.id.clone(), &mat)
        .await
        .expect("superseded flush must succeed (drops stale draft)");
    settle(&mat).await;

    // Content must be the newer edit, NOT the stale draft.
    assert_eq!(
        block_content(&pool, &id).await,
        Some("newer-edit".into()),
        "#2651: superseded flush must NOT regress content to the stale draft",
    );
    // Only the single edit_block op from step 2 exists — the flush appended none.
    assert_eq!(
        count_edit_block_ops(&pool, &id).await,
        1,
        "#2651: superseded flush must NOT append an edit_block op",
    );
    // The stale draft row is dropped either way.
    assert!(
        !draft_exists(&pool, &id).await,
        "#2651: superseded flush must still drop the stale draft row",
    );

    mat.shutdown();
}
