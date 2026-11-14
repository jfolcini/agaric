//! #6521 — a command's engine writes are saved in `loro_doc_delta` with the
//! write: in the command's own transaction, or, for the cascade a delete,
//! restore or purge writes after its commit, in the transaction that follows.
//!
//! `settle` runs the oracle that rebuilds every engine from its saved rows, so
//! each test here ends on it.

use crate::prelude::*;

async fn delta_rows(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM loro_doc_delta")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn op_rows(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

fn engine_blocks(mat: &Materializer) -> usize {
    mat.loro_state()
        .registry
        .with_engine(&SpaceId::from_trusted(TEST_SPACE_ID), DEV, |engine| {
            engine.live_block_ids()
        })
        .unwrap()
        .unwrap()
        .len()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_command_saves_one_delta_with_its_commit_6521() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let before = delta_rows(&pool).await;

    let child = append_child(&pool, &mat, &page, "first").await;
    assert_eq!(
        delta_rows(&pool).await,
        before + 1,
        "a create writes one space's engine in one transaction: one row"
    );
    edit_block_inner(&pool, DEV, &mat, child, "first, edited".into())
        .await
        .unwrap();
    assert_eq!(delta_rows(&pool).await, before + 2, "and so does an edit");

    settle(&mat).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_command_whose_delta_cannot_be_saved_fails_and_leaves_nothing_6521() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    append_child(&pool, &mat, &page, "kept").await;
    settle(&mat).await;
    let (ops, blocks) = (op_rows(&pool).await, engine_blocks(&mat));
    sqlx::query(
        "CREATE TRIGGER refuse_deltas BEFORE INSERT ON loro_doc_delta \
         BEGIN SELECT RAISE(ABORT, 'no deltas today'); END",
    )
    .execute(&pool)
    .await
    .unwrap();

    let refused = create_block_inner(
        &pool,
        DEV,
        &mat,
        "content".into(),
        "lost".into(),
        Some(page.clone()),
        None,
    )
    .await;

    assert!(refused.is_err(), "the command fails with its delta");
    assert_eq!(op_rows(&pool).await, ops, "its op is not in the log");
    assert_eq!(
        live_children(&pool, &page).await.len(),
        1,
        "its block is not in SQL"
    );
    assert_eq!(engine_blocks(&mat), blocks, "and not in the engine");
    settle(&mat).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_restore_and_purge_save_the_cascade_they_write_after_commit_6521() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let parent = append_child(&pool, &mat, &page, "parent").await;
    append_child(&pool, &mat, &parent, "child one").await;
    append_child(&pool, &mat, &parent, "child two").await;
    settle(&mat).await;

    let deleted = delete_block_inner(&pool, DEV, &mat, parent.clone())
        .await
        .unwrap();
    assert_eq!(
        deleted.descendants_affected, 3,
        "the parent and two children"
    );
    settle(&mat).await;

    restore_block_inner(&pool, DEV, &mat, parent.clone(), deleted.deleted_at)
        .await
        .unwrap();
    settle(&mat).await;

    delete_block_inner(&pool, DEV, &mat, parent.clone())
        .await
        .unwrap();
    purge_block_inner(&pool, DEV, &mat, parent).await.unwrap();
    settle(&mat).await;
}
