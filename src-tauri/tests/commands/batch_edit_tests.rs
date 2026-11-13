//! `edit_blocks_batch` (#6608): the write half of replace across pages.

use super::prelude::*;

fn edit(block: &BlockId, expected: &str, to_text: &str) -> BlockEdit {
    BlockEdit {
        block_id: block.clone(),
        expected: expected.into(),
        to_text: to_text.into(),
    }
}

async fn content(pool: &SqlitePool, block: &BlockId) -> String {
    get_block_inner(pool, block.clone())
        .await
        .unwrap()
        .content
        .unwrap()
}

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Two pages in the test space, the first with two blocks, the second with one.
async fn two_pages(pool: &SqlitePool, mat: &Materializer) -> [BlockId; 3] {
    let first = space_page(pool, mat).await;
    let second =
        create_page_in_space_inner(pool, DEV, mat, None, "Other".into(), TEST_SPACE_ID.into())
            .await
            .unwrap();
    [
        append_child(pool, mat, &first, "one needle").await,
        append_child(pool, mat, &first, "two needle").await,
        append_child(pool, mat, &second, "three needle").await,
    ]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_blocks_batch_writes_every_block_and_one_undo_restores_them() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [a, b, c] = two_pages(&pool, &mat).await;

    let resp = capture_op_refs(edit_blocks_batch_inner(
        &pool,
        DEV,
        &mat,
        vec![
            edit(&a, "one needle", "one pin"),
            edit(&b, "two needle", "two pin"),
            edit(&c, "three needle", "three pin"),
        ],
    ))
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(resp.inner.skipped, Vec::<BlockId>::new());
    assert_eq!(content(&pool, &a).await, "one pin");
    assert_eq!(content(&pool, &b).await, "two pin");
    assert_eq!(content(&pool, &c).await, "three pin");
    // One op per block, in one contiguous seq range.
    let seqs: Vec<i64> = resp.op_refs.iter().map(|r| r.seq).collect();
    assert_eq!(seqs, vec![seqs[0], seqs[0] + 1, seqs[0] + 2]);

    undo_ops_inner(&pool, DEV, &mat, resp.op_refs.clone())
        .await
        .unwrap();
    settle(&mat).await;
    assert_eq!(content(&pool, &a).await, "one needle");
    assert_eq!(content(&pool, &b).await, "two needle");
    assert_eq!(content(&pool, &c).await, "three needle");
}

/// A block edited after its content was read keeps the newer text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_blocks_batch_leaves_a_block_changed_since_alone() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [a, b, c] = two_pages(&pool, &mat).await;
    edit_block_inner(&pool, DEV, &mat, b.clone(), "two needle, and more".into())
        .await
        .unwrap();

    let resp = capture_op_refs(edit_blocks_batch_inner(
        &pool,
        DEV,
        &mat,
        vec![
            edit(&a, "one needle", "one pin"),
            edit(&b, "two needle", "two pin"),
            edit(&c, "three needle", "three pin"),
        ],
    ))
    .await
    .unwrap();

    assert_eq!(resp.inner.skipped, vec![b.clone()]);
    assert_eq!(resp.op_refs.len(), 2);
    assert_eq!(content(&pool, &a).await, "one pin");
    assert_eq!(content(&pool, &b).await, "two needle, and more");
    assert_eq!(content(&pool, &c).await, "three pin");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_blocks_batch_leaves_a_deleted_block_alone() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [a, b, _c] = two_pages(&pool, &mat).await;
    delete_block_inner(&pool, DEV, &mat, a.clone())
        .await
        .unwrap();
    let gone = BlockId::from("01HZZZZZZZZZZZZZZZZZZZZZZZ");

    let resp = capture_op_refs(edit_blocks_batch_inner(
        &pool,
        DEV,
        &mat,
        vec![
            edit(&a, "one needle", "one pin"),
            edit(&gone, "anything", "else"),
            edit(&b, "two needle", "two pin"),
        ],
    ))
    .await
    .unwrap();

    assert_eq!(resp.inner.skipped, vec![a.clone(), gone]);
    assert_eq!(resp.op_refs.len(), 1);
    assert_eq!(content(&pool, &a).await, "one needle");
    assert_eq!(content(&pool, &b).await, "two pin");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_blocks_batch_refuses_an_empty_or_oversize_list() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [a, _b, _c] = two_pages(&pool, &mat).await;
    let before = op_count(&pool).await;

    let empty = edit_blocks_batch_inner(&pool, DEV, &mat, vec![]).await;
    assert!(matches!(empty, Err(AppError::Validation { .. })), "{empty:?}");

    let over = vec![edit(&a, "one needle", "one pin"); pagination::MAX_BATCH_BLOCK_IDS + 1];
    let err = edit_blocks_batch_inner(&pool, DEV, &mat, over)
        .await
        .unwrap_err();
    assert_eq!(
        err.to_string(),
        format!(
            "Validation error: edits length {} exceeds maximum {}",
            pagination::MAX_BATCH_BLOCK_IDS + 1,
            pagination::MAX_BATCH_BLOCK_IDS
        )
    );
    assert_eq!(content(&pool, &a).await, "one needle");
    assert_eq!(op_count(&pool).await, before);
}

/// An edit the single command refuses fails the batch, and the edits before it roll back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edit_blocks_batch_rolls_back_every_block_when_one_edit_is_refused() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let [a, b, c] = two_pages(&pool, &mat).await;
    let before = op_count(&pool).await;

    let result = edit_blocks_batch_inner(
        &pool,
        DEV,
        &mat,
        vec![
            edit(&a, "one needle", "one pin"),
            edit(&b, "two needle", &"x".repeat(MAX_CONTENT_LENGTH + 1)),
            edit(&c, "three needle", "three pin"),
        ],
    )
    .await;

    assert!(matches!(result, Err(AppError::Validation { .. })), "{result:?}");
    assert_eq!(content(&pool, &a).await, "one needle");
    assert_eq!(content(&pool, &b).await, "two needle");
    assert_eq!(content(&pool, &c).await, "three needle");
    assert_eq!(op_count(&pool).await, before);

    // The engine rolled back with the rows: the same edit now applies cleanly.
    edit_block_inner(&pool, DEV, &mat, a.clone(), "one pin".into())
        .await
        .unwrap();
    assert_eq!(content(&pool, &a).await, "one pin");
}
