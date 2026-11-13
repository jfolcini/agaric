//! `split_block` and `merge_blocks` (#6531): each is one transaction of the
//! ops the single commands append.

use super::prelude::*;
use agaric_store::op::OpRef;

fn split(block: &BlockId, before: &str, after: &str, new_id: &str) -> SplitBlockRequest {
    SplitBlockRequest {
        block_id: block.clone(),
        before: before.into(),
        after: after.into(),
        new_block_id: new_id.into(),
        base_text: None,
    }
}

fn merge(block: &BlockId, into: &BlockId, merged_text: &str) -> MergeBlocksRequest {
    MergeBlocksRequest {
        block_id: block.clone(),
        into_id: into.clone(),
        merged_text: merged_text.into(),
        base_text: None,
    }
}

const NEW_ID: &str = "01SPTNEW000000000000000001";

async fn text(pool: &SqlitePool, id: &str) -> Option<String> {
    sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn is_deleted(pool: &SqlitePool, id: &str) -> bool {
    sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
        .is_some()
}

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The op type each ref names, in the order given.
async fn op_types(pool: &SqlitePool, refs: &[OpRef]) -> Vec<String> {
    let mut types = Vec::with_capacity(refs.len());
    for op in refs {
        types.push(
            sqlx::query_scalar("SELECT op_type FROM op_log WHERE device_id = ? AND seq = ?")
                .bind(&op.device_id)
                .bind(op.seq)
                .fetch_one(pool)
                .await
                .unwrap(),
        );
    }
    types
}

/// `id`'s text in the test space's doc, `None` when the doc does not hold it.
fn engine_text(mat: &Materializer, id: &str) -> Option<String> {
    let space = SpaceId::from_trusted(TEST_SPACE_ID);
    let mut guard = mat
        .loro_state()
        .registry
        .for_space(&space, DEV)
        .expect("for_space");
    let engine = guard.engine_mut();
    if !engine.contains_block(id) {
        return None;
    }
    engine.read_block_content(id).expect("read_block_content")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn split_block_keeps_before_and_creates_after_as_the_next_sibling() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let a = append_child(&pool, &mat, &page, "helloworld").await;
    let a1 = append_child(&pool, &mat, &a, "child of a").await;
    let b = append_child(&pool, &mat, &page, "next").await;

    let done = capture_op_refs(split_block_inner(
        &pool,
        DEV,
        &mat,
        split(&a, "hello", "world", NEW_ID),
    ))
    .await
    .unwrap();

    assert_eq!(done.inner.block.content.as_deref(), Some("hello"));
    assert_eq!(done.inner.created.id.as_str(), NEW_ID);
    assert_eq!(done.inner.created.content.as_deref(), Some("world"));
    assert_eq!(done.inner.created.position, Some(2));
    assert_eq!(
        live_children(&pool, &page).await,
        [a.as_str(), NEW_ID, b.as_str()]
    );
    assert_eq!(live_children(&pool, &a).await, [a1.as_str()]);
    assert_eq!(text(&pool, a.as_str()).await.as_deref(), Some("hello"));
    assert_eq!(text(&pool, NEW_ID).await.as_deref(), Some("world"));
    assert_eq!(engine_text(&mat, a.as_str()).as_deref(), Some("hello"));
    assert_eq!(engine_text(&mat, NEW_ID).as_deref(), Some("world"));
    assert_eq!(
        op_types(&pool, &done.op_refs).await,
        ["create_block", "edit_block"]
    );
}

/// The create has been applied, engine included, when the edit is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn split_block_refused_at_its_edit_leaves_nothing_of_the_create() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let a = append_child(&pool, &mat, &page, "helloworld").await;
    let ops_before = op_count(&pool).await;

    let overlong = "x".repeat(MAX_CONTENT_LENGTH + 1);
    let refused = split_block_inner(&pool, DEV, &mat, split(&a, &overlong, "world", NEW_ID)).await;

    assert!(
        matches!(refused, Err(AppError::Validation { .. })),
        "got {refused:?}"
    );
    assert_eq!(live_children(&pool, &page).await, [a.as_str()]);
    let created: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE id = ?")
        .bind(NEW_ID)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(created, 0);
    assert_eq!(op_count(&pool).await, ops_before);
    assert_eq!(engine_text(&mat, NEW_ID), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn split_block_of_a_missing_block_is_not_found() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    space_page(&pool, &mat).await;

    let missing = BlockId::from("01MISSING00000000000000001");
    let refused = split_block_inner(&pool, DEV, &mat, split(&missing, "a", "b", NEW_ID)).await;

    assert!(
        matches!(refused, Err(AppError::NotFound(_))),
        "got {refused:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_split_gives_back_the_one_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let a = append_child(&pool, &mat, &page, "helloworld").await;
    let b = append_child(&pool, &mat, &page, "next").await;
    let done = capture_op_refs(split_block_inner(
        &pool,
        DEV,
        &mat,
        split(&a, "hello", "world", NEW_ID),
    ))
    .await
    .unwrap();

    undo_ops_inner(&pool, DEV, &mat, done.op_refs)
        .await
        .unwrap();

    assert_eq!(text(&pool, a.as_str()).await.as_deref(), Some("helloworld"));
    assert_eq!(live_children(&pool, &page).await, [a.as_str(), b.as_str()]);
    assert!(is_deleted(&pool, NEW_ID).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_blocks_joins_the_text_and_deletes_the_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let a = append_child(&pool, &mat, &page, "Alpha").await;
    let b = append_child(&pool, &mat, &page, "Beta").await;

    let done = capture_op_refs(merge_blocks_inner(
        &pool,
        DEV,
        &mat,
        merge(&b, &a, "AlphaBeta"),
    ))
    .await
    .unwrap();

    assert_eq!(done.inner.block.id, a);
    assert_eq!(done.inner.block.content.as_deref(), Some("AlphaBeta"));
    assert!(done.inner.moves.is_empty());
    assert_eq!(text(&pool, a.as_str()).await.as_deref(), Some("AlphaBeta"));
    assert_eq!(engine_text(&mat, a.as_str()).as_deref(), Some("AlphaBeta"));
    assert!(is_deleted(&pool, b.as_str()).await);
    assert_eq!(live_children(&pool, &page).await, [a.as_str()]);
    assert_eq!(
        op_types(&pool, &done.op_refs).await,
        ["edit_block", "delete_block"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_blocks_moves_the_children_after_the_targets_own() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let a = append_child(&pool, &mat, &page, "Alpha").await;
    let a1 = append_child(&pool, &mat, &a, "a1").await;
    let b = append_child(&pool, &mat, &page, "Beta").await;
    let b1 = append_child(&pool, &mat, &b, "b1").await;
    let b2 = append_child(&pool, &mat, &b, "b2").await;
    let b2a = append_child(&pool, &mat, &b2, "b2a").await;

    let done = capture_op_refs(merge_blocks_inner(
        &pool,
        DEV,
        &mat,
        merge(&b, &a, "AlphaBeta"),
    ))
    .await
    .unwrap();

    assert_eq!(
        live_children(&pool, &a).await,
        [a1.as_str(), b1.as_str(), b2.as_str()]
    );
    assert_eq!(live_children(&pool, &b2).await, [b2a.as_str()]);
    assert!(is_deleted(&pool, b.as_str()).await);
    let moved: Vec<(&str, Option<&str>)> = done
        .inner
        .moves
        .iter()
        .map(|m| (m.block_id.as_str(), m.new_parent_id.as_deref()))
        .collect();
    assert_eq!(
        moved,
        [
            (b1.as_str(), Some(a.as_str())),
            (b2.as_str(), Some(a.as_str()))
        ]
    );
    assert_eq!(
        op_types(&pool, &done.op_refs).await,
        ["edit_block", "move_block", "move_block", "delete_block"]
    );
}

/// The edit has been applied, engine included, when the move is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_blocks_refused_at_its_move_leaves_nothing_of_the_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let b = append_child(&pool, &mat, &page, "Beta").await;
    let b1 = append_child(&pool, &mat, &b, "b1").await;
    let ops_before = op_count(&pool).await;

    let refused = merge_blocks_inner(&pool, DEV, &mat, merge(&b, &b1, "b1Beta")).await;

    assert!(
        matches!(refused, Err(AppError::InvalidOperation(_))),
        "got {refused:?}"
    );
    assert_eq!(text(&pool, b1.as_str()).await.as_deref(), Some("b1"));
    assert_eq!(engine_text(&mat, b1.as_str()).as_deref(), Some("b1"));
    assert_eq!(op_count(&pool).await, ops_before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_blocks_into_itself_is_refused_and_writes_nothing() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let a = append_child(&pool, &mat, &page, "Alpha").await;
    let ops_before = op_count(&pool).await;

    let refused = merge_blocks_inner(&pool, DEV, &mat, merge(&a, &a, "AlphaAlpha")).await;

    assert!(
        matches!(refused, Err(AppError::InvalidOperation(_))),
        "got {refused:?}"
    );
    assert_eq!(text(&pool, a.as_str()).await.as_deref(), Some("Alpha"));
    assert!(!is_deleted(&pool, a.as_str()).await);
    assert_eq!(op_count(&pool).await, ops_before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn merge_blocks_of_a_missing_block_is_not_found_and_keeps_the_targets_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let a = append_child(&pool, &mat, &page, "Alpha").await;
    let ops_before = op_count(&pool).await;

    let missing = BlockId::from("01MISSING00000000000000001");
    let refused = merge_blocks_inner(&pool, DEV, &mat, merge(&missing, &a, "AlphaBeta")).await;

    assert!(
        matches!(refused, Err(AppError::NotFound(_))),
        "got {refused:?}"
    );
    assert_eq!(text(&pool, a.as_str()).await.as_deref(), Some("Alpha"));
    assert_eq!(engine_text(&mat, a.as_str()).as_deref(), Some("Alpha"));
    assert_eq!(op_count(&pool).await, ops_before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_merge_gives_back_both_blocks_and_the_children() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let a = append_child(&pool, &mat, &page, "Alpha").await;
    let a1 = append_child(&pool, &mat, &a, "a1").await;
    let b = append_child(&pool, &mat, &page, "Beta").await;
    let b1 = append_child(&pool, &mat, &b, "b1").await;
    let b2 = append_child(&pool, &mat, &b, "b2").await;
    let done = capture_op_refs(merge_blocks_inner(
        &pool,
        DEV,
        &mat,
        merge(&b, &a, "AlphaBeta"),
    ))
    .await
    .unwrap();

    undo_ops_inner(&pool, DEV, &mat, done.op_refs)
        .await
        .unwrap();

    assert_eq!(text(&pool, a.as_str()).await.as_deref(), Some("Alpha"));
    assert_eq!(text(&pool, b.as_str()).await.as_deref(), Some("Beta"));
    assert_eq!(live_children(&pool, &page).await, [a.as_str(), b.as_str()]);
    assert_eq!(live_children(&pool, &a).await, [a1.as_str()]);
    assert_eq!(live_children(&pool, &b).await, [b1.as_str(), b2.as_str()]);
}
