//! #6521 — a command's engine writes are saved in `loro_doc_delta` in the
//! command's own transaction, the cascade of a delete, a restore, a purge or a
//! move with them, and so are those of an op the materializer applies.
//!
//! `settle` runs the oracle that rebuilds every engine from its saved rows, so
//! each test here ends on it.

use crate::prelude::*;
use agaric_lib::materializer::{MaterializeTask, handle_foreground_task};
use agaric_store::op::{DeleteBlockPayload, MoveBlockPayload, RestoreBlockPayload};

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
async fn a_delete_restore_and_purge_save_the_cascade_they_write_6521() {
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

/// Let `allowed` more `loro_doc_delta` rows be saved, and refuse every row
/// after them. With one, a transaction saves its row and nothing after it can:
/// what a kill right after its commit leaves on disk.
async fn refuse_deltas_after(pool: &SqlitePool, allowed: i64) {
    let limit = delta_rows(pool).await + allowed;
    sqlx::query(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) \
         VALUES ('test.delta_limit', ?, 0)",
    )
    .bind(limit.to_string())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TRIGGER IF NOT EXISTS refuse_deltas BEFORE INSERT ON loro_doc_delta \
         WHEN (SELECT COUNT(*) FROM loro_doc_delta) >= \
              (SELECT CAST(value AS INTEGER) FROM app_settings WHERE key = 'test.delta_limit') \
         BEGIN SELECT RAISE(ABORT, 'no more deltas'); END",
    )
    .execute(pool)
    .await
    .unwrap();
}

/// What the engine holds of `block`: `None` for no such block, else whether
/// it is tombstoned.
fn engine_tombstone(mat: &Materializer, block: &BlockId) -> Option<bool> {
    let id = block.as_str();
    mat.loro_state()
        .registry
        .with_engine(&SpaceId::from_trusted(TEST_SPACE_ID), DEV, |engine| {
            engine
                .read_block(id)
                .unwrap()
                .map(|_| engine.read_deleted_at(id).unwrap().is_some())
        })
        .unwrap()
}

/// What SQL holds of `block`, as [`engine_tombstone`] reads the engine.
async fn sql_tombstone(pool: &SqlitePool, block: &BlockId) -> Option<bool> {
    sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM blocks WHERE id = ?")
        .bind(block.as_str())
        .fetch_optional(pool)
        .await
        .unwrap()
}

/// A vault holding a page with `parent` and its two children. Returns the
/// three blocks, the parent first.
async fn parent_with_two_children() -> (SqlitePool, tempfile::TempDir, Materializer, [BlockId; 3]) {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await;
    let parent = append_child(&pool, &mat, &page, "parent").await;
    let one = append_child(&pool, &mat, &parent, "child one").await;
    let two = append_child(&pool, &mat, &parent, "child two").await;
    settle(&mat).await;
    (pool, dir, mat, [parent, one, two])
}

/// `blocks` in SQL and in the engine, each as [`sql_tombstone`] and
/// [`engine_tombstone`] read it.
async fn tombstones(
    pool: &SqlitePool,
    mat: &Materializer,
    blocks: &[BlockId],
) -> (Vec<Option<bool>>, Vec<Option<bool>>) {
    let mut sql = Vec::new();
    for block in blocks {
        sql.push(sql_tombstone(pool, block).await);
    }
    let engine = blocks.iter().map(|b| engine_tombstone(mat, b)).collect();
    (sql, engine)
}

/// #6521 — a delete's row holds its cascade: with every later row refused,
/// the engine the saved rows rebuild has the children tombstoned too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_delete_saves_its_cascade_in_its_own_transaction_6521() {
    let (pool, _dir, mat, blocks) = parent_with_two_children().await;
    refuse_deltas_after(&pool, 1).await;

    delete_block_inner(&pool, DEV, &mat, blocks[0].clone())
        .await
        .unwrap();

    assert_eq!(
        tombstones(&pool, &mat, &blocks).await,
        (vec![Some(true); 3], vec![Some(true); 3]),
        "SQL and the engine hold the parent and both children deleted"
    );
    settle(&mat).await;
}

/// The trash, after `parent_with_two_children`'s parent is deleted. Returns
/// the delete's timestamp.
async fn trashed(pool: &SqlitePool, mat: &Materializer, parent: &BlockId) -> i64 {
    let deleted = delete_block_inner(pool, DEV, mat, parent.clone())
        .await
        .unwrap();
    settle(mat).await;
    deleted.deleted_at
}

/// #6521 — a restore writes the engine only through its cascade. When that
/// cannot be saved `command` fails, and neither SQL nor the engine holds it.
async fn a_restore_whose_cascade_cannot_be_saved_restores_nothing(command: &str) {
    let (pool, _dir, mat, blocks) = parent_with_two_children().await;
    let deleted_at = trashed(&pool, &mat, &blocks[0]).await;
    let ops = op_rows(&pool).await;
    refuse_deltas_after(&pool, 0).await;

    let parent = blocks[0].clone();
    let refused = match command {
        "restore_block" => restore_block_inner(&pool, DEV, &mat, parent, deleted_at)
            .await
            .map(drop),
        "restore_blocks_by_ids" => restore_blocks_by_ids_inner(&pool, DEV, &mat, vec![parent])
            .await
            .map(drop),
        _ => restore_all_deleted_inner(&pool, DEV, &mat).await.map(drop),
    };

    assert!(refused.is_err(), "{command} fails with its cascade's delta");
    assert_eq!(op_rows(&pool).await, ops, "no op is in the log");
    assert_eq!(
        tombstones(&pool, &mat, &blocks).await,
        (vec![Some(true); 3], vec![Some(true); 3]),
        "SQL and the engine still hold all three deleted"
    );
    settle(&mat).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_block_whose_cascade_cannot_be_saved_restores_nothing_6521() {
    a_restore_whose_cascade_cannot_be_saved_restores_nothing("restore_block").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_blocks_by_ids_whose_cascade_cannot_be_saved_restores_nothing_6521() {
    a_restore_whose_cascade_cannot_be_saved_restores_nothing("restore_blocks_by_ids").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restore_all_deleted_whose_cascade_cannot_be_saved_restores_nothing_6521() {
    a_restore_whose_cascade_cannot_be_saved_restores_nothing("restore_all_deleted").await;
}

/// #6521 — a purge writes the engine only through its cascade. When that
/// cannot be saved `command` fails, and SQL and the engine keep the blocks.
async fn a_purge_whose_cascade_cannot_be_saved_purges_nothing(command: &str) {
    let (pool, _dir, mat, blocks) = parent_with_two_children().await;
    trashed(&pool, &mat, &blocks[0]).await;
    let ops = op_rows(&pool).await;
    refuse_deltas_after(&pool, 0).await;

    let parent = blocks[0].clone();
    let refused = match command {
        "purge_block" => purge_block_inner(&pool, DEV, &mat, parent).await.map(drop),
        "purge_blocks_by_ids" => purge_blocks_by_ids_inner(&pool, DEV, &mat, vec![parent])
            .await
            .map(drop),
        _ => purge_all_deleted_inner(&pool, DEV, &mat).await.map(drop),
    };

    assert!(refused.is_err(), "{command} fails with its cascade's delta");
    assert_eq!(op_rows(&pool).await, ops, "no op is in the log");
    assert_eq!(
        tombstones(&pool, &mat, &blocks).await,
        (vec![Some(true); 3], vec![Some(true); 3]),
        "SQL and the engine still hold all three, deleted"
    );
    settle(&mat).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_block_whose_cascade_cannot_be_saved_purges_nothing_6521() {
    a_purge_whose_cascade_cannot_be_saved_purges_nothing("purge_block").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_blocks_by_ids_whose_cascade_cannot_be_saved_purges_nothing_6521() {
    a_purge_whose_cascade_cannot_be_saved_purges_nothing("purge_blocks_by_ids").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_all_deleted_whose_cascade_cannot_be_saved_purges_nothing_6521() {
    a_purge_whose_cascade_cannot_be_saved_purges_nothing("purge_all_deleted").await;
}

/// #6521 — the batch delete writes the engine only through its cascade. When
/// that cannot be saved the delete fails, and the blocks stay live in both.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_batch_delete_whose_cascade_cannot_be_saved_deletes_nothing_6521() {
    let (pool, _dir, mat, blocks) = parent_with_two_children().await;
    let ops = op_rows(&pool).await;
    refuse_deltas_after(&pool, 0).await;

    let refused = delete_blocks_by_ids_inner(&pool, DEV, &mat, vec![blocks[0].clone()]).await;

    assert!(
        refused.is_err(),
        "the delete fails with its cascade's delta"
    );
    assert_eq!(op_rows(&pool).await, ops, "no op is in the log");
    assert_eq!(
        tombstones(&pool, &mat, &blocks).await,
        (vec![Some(false); 3], vec![Some(false); 3]),
        "SQL and the engine still hold all three live"
    );
    settle(&mat).await;
}

/// How the materializer is handed one op: alone, or as a batch of one.
#[derive(Clone, Copy)]
enum Applied {
    Alone,
    InABatch,
}

/// Append `payload` to the op log and have the materializer apply it.
async fn materialize(
    pool: &SqlitePool,
    mat: &Materializer,
    payload: OpPayload,
    applied: Applied,
) -> Result<(), AppError> {
    let record = op_log::append_local_op(pool, DEV, payload).await.unwrap();
    let task = match applied {
        Applied::Alone => MaterializeTask::ApplyOp(Arc::new(record)),
        Applied::InABatch => MaterializeTask::BatchApplyOps(Arc::new(vec![record])),
    };
    handle_foreground_task(pool, &task, mat.loro_state()).await
}

/// #6521 — an op the materializer applies saves its cascade in its own
/// transaction: with every later row refused, the engine the saved rows
/// rebuild holds the delete's, then the restore's, whole cohort.
async fn an_applied_delete_and_restore_save_their_cascade_in_their_own_transaction(
    applied: Applied,
) {
    let (pool, _dir, mat, blocks) = parent_with_two_children().await;
    refuse_deltas_after(&pool, 1).await;

    let delete = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: blocks[0].clone(),
    });
    materialize(&pool, &mat, delete, applied).await.unwrap();

    assert_eq!(
        tombstones(&pool, &mat, &blocks).await,
        (vec![Some(true); 3], vec![Some(true); 3]),
        "the delete reaches the parent and both children"
    );
    settle(&mat).await;

    let deleted_at_ref: i64 = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(blocks[0].as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    refuse_deltas_after(&pool, 1).await;

    let restore = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: blocks[0].clone(),
        deleted_at_ref,
    });
    materialize(&pool, &mat, restore, applied).await.unwrap();

    assert_eq!(
        tombstones(&pool, &mat, &blocks).await,
        (vec![Some(false); 3], vec![Some(false); 3]),
        "the restore reaches the parent and both children"
    );
    settle(&mat).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_op_applied_alone_saves_its_cascade_in_its_own_transaction_6521() {
    an_applied_delete_and_restore_save_their_cascade_in_their_own_transaction(Applied::Alone).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_op_applied_in_a_batch_saves_its_cascade_in_its_own_transaction_6521() {
    an_applied_delete_and_restore_save_their_cascade_in_their_own_transaction(Applied::InABatch)
        .await;
}

/// #6521 — a move of a block out of a deleted parent brings it back to life
/// in SQL with no engine write of its own; the engine learns it from the
/// cascade. When that cannot be saved the move fails and changes nothing.
async fn an_applied_move_whose_cascade_cannot_be_saved_moves_nothing(applied: Applied) {
    let (pool, _dir, mat, blocks) = parent_with_two_children().await;
    let page: String = sqlx::query_scalar("SELECT parent_id FROM blocks WHERE id = ?")
        .bind(blocks[0].as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    trashed(&pool, &mat, &blocks[0]).await;
    refuse_deltas_after(&pool, 0).await;

    let out_of_the_trash = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: blocks[1].clone(),
        new_parent_id: Some(BlockId::from_trusted(&page)),
        new_position: agaric_store::pagination::index_to_provisional_position(0),
        new_index: Some(0),
        prior: None,
    });
    let refused = materialize(&pool, &mat, out_of_the_trash, applied).await;

    assert!(refused.is_err(), "the move fails with its cascade's delta");
    assert_eq!(
        tombstones(&pool, &mat, &blocks).await,
        (vec![Some(true); 3], vec![Some(true); 3]),
        "SQL and the engine still hold all three deleted"
    );
    assert_eq!(
        live_children(&pool, &BlockId::from_trusted(&page)).await,
        Vec::<String>::new(),
        "and the child is not on the page"
    );
    settle(&mat).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_applied_alone_whose_cascade_cannot_be_saved_moves_nothing_6521() {
    an_applied_move_whose_cascade_cannot_be_saved_moves_nothing(Applied::Alone).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_applied_in_a_batch_whose_cascade_cannot_be_saved_moves_nothing_6521() {
    an_applied_move_whose_cascade_cannot_be_saved_moves_nothing(Applied::InABatch).await;
}
