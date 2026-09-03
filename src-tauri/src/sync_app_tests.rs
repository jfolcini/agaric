//! #3120: the one repatriated sync test that still needs the app crate.
//! `undo_page_op_inner` lives in `commands::history`, so the undo half of the
//! #2474 snapshot-RESET pin stays here; the rest of that suite is in
//! `agaric_sync::snapshot::tests`.

use crate::commands::history::undo_page_op_inner;
use crate::db::init_pool;
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::op::{CreateBlockPayload, OpPayload};
use agaric_store::op_log::append_local_op_at;
use agaric_sync::snapshot::{apply_snapshot, create_snapshot};
use sqlx::SqlitePool;
use tempfile::TempDir;

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
    (pool, dir)
}

fn test_materializer(pool: &SqlitePool) -> Materializer {
    Materializer::new(pool.clone())
}

async fn insert_block(pool: &SqlitePool, id: &str, content: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
             VALUES (?, 'content', ?, 1)",
    )
    .bind(id)
    .bind(content)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_op_at(pool: &SqlitePool, device_id: &str, block_id: &str, ts: i64) {
    let op = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id(block_id),
        block_type: "content".to_owned(),
        parent_id: None,
        position: Some(0),
        index: None,
        content: "test".to_owned(),
    });
    append_local_op_at(pool, device_id, op, ts).await.unwrap();
}

/// #2474 (history/undo reset): the undo surface is built on `op_log`, so
/// after a catch-up RESET there is NOTHING to undo even for a block that
/// survived in the snapshot — its entire local paper trail was wiped.
/// `undo_page_op_inner` returns `NotFound` because the op it would walk
/// back no longer exists.
///
/// Pins: undo/history built on op_log is reset (empty) post-RESET.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_snapshot_resets_undo_and_history_surface_2474() {
    let (pool, _dir) = test_pool().await;
    let mat = test_materializer(&pool);
    let device_id = "dev-1";

    // A block with a real op history (create + an edit) — undoable
    // pre-reset.
    insert_block(&pool, "BLOCK-ORIG", "v1").await;
    insert_op_at(&pool, device_id, "BLOCK-ORIG", 1_735_689_600_000).await;
    let snapshot_id = create_snapshot(&pool, device_id).await.unwrap();
    let snap_data = sqlx::query!("SELECT data FROM log_snapshots WHERE id = ?", snapshot_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .data;

    // A post-frontier local edit — an undoable op in the live log.
    insert_op_at(&pool, device_id, "BLOCK-ORIG", 1_748_736_000_000).await;
    let history_before: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        history_before, 2,
        "pre-condition: two ops form the undo history"
    );

    // Apply the RESET.
    apply_snapshot(&pool, &mat, &snap_data[..]).await.unwrap();

    // The op_log — the sole backing store the history/undo queries walk —
    // is empty, so there is no history at all.
    let history_after: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM op_log")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        history_after, 0,
        "#2474: op_log is empty post-reset, so page history / activity feed reset too"
    );

    // Undo of the (still-present) snapshot block finds no op to reverse:
    // the undo stack was destroyed with the op_log.
    let undo = undo_page_op_inner(&pool, device_id, &mat, "BLOCK-ORIG".to_string(), 0).await;
    assert!(
        matches!(undo, Err(AppError::NotFound(_))),
        "#2474: after a catch-up RESET the undo surface is reset — undo returns \
         NotFound because op_log (its backing store) was wiped; got {undo:?}"
    );

    mat.shutdown();
}
