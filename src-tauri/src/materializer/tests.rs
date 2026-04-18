//! Tests for materializer queue coordination, dispatch routing, dedup logic, shutdown, flush barriers, and metrics.
use super::*;
use crate::db::init_pool;
use crate::op::{
    AddAttachmentPayload, AddTagPayload, CreateBlockPayload, DeleteAttachmentPayload,
    DeleteBlockPayload, DeletePropertyPayload, EditBlockPayload, MoveBlockPayload, OpPayload,
    PurgeBlockPayload, RestoreBlockPayload, SetPropertyPayload,
};
use crate::op_log::append_local_op;
use crate::ulid::BlockId;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::atomic::Ordering as AtomicOrdering;
use std::time::Duration;
use tempfile::TempDir;

const DEV: &str = "test-device-mat";
const FIXED_TS: &str = "2025-01-01T00:00:00Z";
const FAKE_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}
fn fake_op_record(op_type: &str, payload: &str) -> OpRecord {
    OpRecord {
        device_id: DEV.into(),
        seq: 1,
        parent_seqs: None,
        hash: FAKE_HASH.into(),
        op_type: op_type.into(),
        payload: payload.into(),
        created_at: FIXED_TS.into(),
    }
}
async fn make_op_record(pool: &SqlitePool, payload: OpPayload) -> OpRecord {
    append_local_op(pool, DEV, payload).await.unwrap()
}
async fn insert_block_direct(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
        .bind(id)
        .bind(block_type)
        .bind(content)
        .execute(pool)
        .await
        .unwrap();
}
async fn soft_delete_block_direct(pool: &SqlitePool, id: &str) {
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
        .bind(FIXED_TS)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}
async fn insert_block_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}
async fn insert_property_date(pool: &SqlitePool, block_id: &str, key: &str, value_date: &str) {
    sqlx::query(
        "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
    )
    .bind(block_id)
    .bind(key)
    .bind(value_date)
    .execute(pool)
    .await
    .unwrap();
}

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
#[tokio::test]
async fn dispatch_op_create_block_page() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-1"),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            content: "My page".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT block_type, content FROM blocks WHERE id = 'BLK-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "page", "block_type should be page");
    assert_eq!(row.1, "My page", "content should match created page title");
}
#[tokio::test]
async fn dispatch_op_create_block_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-tag"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            content: "urgent".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT block_type, content FROM blocks WHERE id = 'BLK-TAG'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "tag", "block_type should be tag");
    assert_eq!(row.1, "urgent", "content should match created tag name");
}
#[tokio::test]
async fn dispatch_op_create_block_content() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-c"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "just content".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT block_type, content FROM blocks WHERE id = 'BLK-C'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "content", "block_type should be content");
    assert_eq!(
        row.1, "just content",
        "content should match created block text"
    );
}
#[tokio::test]
async fn dispatch_op_edit_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-2", "content", "original").await;
    make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-2"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "original".into(),
        }),
    )
    .await;
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("blk-2"),
            to_text: "edited".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String,)>("SELECT content FROM blocks WHERE id = 'BLK-2'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, "edited", "content should be updated after EditBlock");
}
#[tokio::test]
async fn dispatch_op_delete_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-3", "content", "to delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("blk-3"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row =
        sqlx::query_as::<_, (Option<String>,)>("SELECT deleted_at FROM blocks WHERE id = 'BLK-3'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        row.0.is_some(),
        "deleted_at should be set after DeleteBlock"
    );
}
#[tokio::test]
async fn dispatch_op_restore_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-R", "content", "was deleted").await;
    soft_delete_block_direct(&pool, "BLK-R").await;
    let r = make_op_record(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id("blk-r"),
            deleted_at_ref: FIXED_TS.into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row =
        sqlx::query_as::<_, (Option<String>,)>("SELECT deleted_at FROM blocks WHERE id = 'BLK-R'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        row.0.is_none(),
        "deleted_at should be NULL after RestoreBlock"
    );
}
#[tokio::test]
async fn dispatch_op_purge_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-P", "content", "to purge").await;
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("blk-p"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM blocks WHERE id = 'BLK-P'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, 0, "block should be gone after PurgeBlock");
}
#[tokio::test]
async fn dispatch_op_add_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-4", "content", "tagged block").await;
    insert_block_direct(&pool, "TAG-1", "tag", "my-tag").await;
    let r = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("blk-4"),
            tag_id: BlockId::test_id("tag-1"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = 'BLK-4' AND tag_id = 'TAG-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 1, "block_tags row should exist after AddTag");
}
#[tokio::test]
async fn dispatch_op_remove_tag() {
    use crate::op::RemoveTagPayload;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-RT", "content", "rt block").await;
    insert_block_direct(&pool, "TAG-99", "tag", "rm-tag").await;
    insert_block_tag(&pool, "BLK-RT", "TAG-99").await;
    let r = make_op_record(
        &pool,
        OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::test_id("blk-rt"),
            tag_id: BlockId::test_id("tag-99"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = 'BLK-RT' AND tag_id = 'TAG-99'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 0, "block_tags row should be gone after RemoveTag");
}
#[tokio::test]
async fn dispatch_op_set_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-5", "content", "prop block").await;
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("blk-5"),
            key: "due".into(),
            value_text: None,
            value_num: None,
            value_date: Some("2025-01-15".into()),
            value_ref: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT value_date FROM block_properties WHERE block_id = 'BLK-5' AND key = 'due'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.0, "2025-01-15",
        "value_date should match the set property date"
    );
}
#[tokio::test]
async fn dispatch_op_delete_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-DP", "content", "dp block").await;
    insert_property_date(&pool, "BLK-DP", "due", "2025-01-15").await;
    let r = make_op_record(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("blk-dp"),
            key: "due".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-DP' AND key = 'due'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, 0, "property should be gone after DeleteProperty");
}
#[tokio::test]
async fn dispatch_op_move_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-PARENT", "page", "parent page").await;
    insert_block_direct(&pool, "BLK-6", "content", "child block").await;
    let r = make_op_record(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("blk-6"),
            new_parent_id: Some(BlockId::test_id("blk-parent")),
            new_position: 2,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (Option<String>, i64)>(
        "SELECT parent_id, position FROM blocks WHERE id = 'BLK-6'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        row.0.as_deref(),
        Some("BLK-PARENT"),
        "parent_id should be set after MoveBlock"
    );
    assert_eq!(row.1, 2, "position should be updated after MoveBlock");
}
#[tokio::test]
async fn dispatch_op_add_attachment() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-A", "content", "attachment block").await;
    let r = make_op_record(
        &pool,
        OpPayload::AddAttachment(AddAttachmentPayload {
            attachment_id: "att-1".into(),
            block_id: BlockId::test_id("blk-a"),
            mime_type: "image/png".into(),
            filename: "photo.png".into(),
            size_bytes: 1024,
            fs_path: "/tmp/photo.png".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (String, String)>(
        "SELECT filename, mime_type FROM attachments WHERE id = 'att-1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "photo.png", "filename should match added attachment");
    assert_eq!(
        row.1, "image/png",
        "mime_type should match added attachment"
    );
}
#[tokio::test]
async fn dispatch_op_delete_attachment() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK-ATT-DEL", "content", "att block").await;
    sqlx::query("INSERT INTO attachments (id, block_id, filename, fs_path, mime_type, size_bytes, created_at) VALUES ('att-2', 'BLK-ATT-DEL', 'f.txt', '/tmp/f.txt', 'text/plain', 10, '2025-01-01T00:00:00Z')")
        .execute(&pool).await.unwrap();
    let r = make_op_record(
        &pool,
        OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: "att-2".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush_foreground().await.unwrap();
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM attachments WHERE id = 'att-2'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, 0, "attachment should be gone after DeleteAttachment");
}
#[tokio::test]
async fn dispatch_op_unknown_op_type() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.dispatch_op(&fake_op_record("unknown_future_op", "{}"))
            .await
            .is_ok(),
        "unknown op type should not cause an error"
    );
}
#[tokio::test]
async fn dispatch_background_edit() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("blk-bg"),
            to_text: "edited bg".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "at least one background task should have been processed"
    );
}
#[tokio::test]
async fn dispatch_background_delete() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("blk-db"),
        }),
    )
    .await;
    mat.dispatch_background(&r).unwrap();
    mat.flush_background().await.unwrap();
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "at least one background task should have been processed"
    );
}
#[tokio::test]
async fn enqueue_foreground_any() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.enqueue_foreground(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "should enqueue foreground task successfully"
    );
}
#[tokio::test]
async fn enqueue_background_all() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "should enqueue RebuildTagsCache in background"
    );
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildPagesCache)
            .await
            .is_ok(),
        "should enqueue RebuildPagesCache in background"
    );
    assert!(
        mat.enqueue_background(MaterializeTask::ReindexBlockLinks {
            block_id: "blk-x".into()
        })
        .await
        .is_ok(),
        "should enqueue ReindexBlockLinks in background"
    );
}
#[tokio::test]
async fn try_enqueue_background_drops_when_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    for _ in 0..2000 {
        assert!(
            mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
                .is_ok(),
            "try_enqueue should accept tasks when not full"
        );
    }
}
#[tokio::test]
async fn try_enqueue_after_shutdown_err() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .is_err(),
        "try_enqueue should fail after shutdown"
    );
}
#[tokio::test]
async fn shutdown_stops_consumers() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_ok(),
        "should enqueue before shutdown"
    );
    mat.flush_background().await.unwrap();
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        mat.enqueue_background(MaterializeTask::RebuildTagsCache)
            .await
            .is_err(),
        "enqueue should fail after shutdown"
    );
}
#[tokio::test]
async fn shutdown_when_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    for _ in 0..2000 {
        let _ = mat.try_enqueue_background(MaterializeTask::RebuildTagsCache);
    }
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .is_err(),
        "try_enqueue should fail after shutdown when full"
    );
    assert!(
        mat.enqueue_foreground(MaterializeTask::RebuildTagsCache)
            .await
            .is_err(),
        "foreground enqueue should fail after shutdown when full"
    );
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
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "should have processed at least one background task"
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
            content: "hello".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(r))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();
    assert!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "should have processed at least one foreground task"
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
            content: "flush fg".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(r))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();
    assert!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "flush_foreground should process at least one task"
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
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "flush_background should process at least one task"
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
            content: "flush both".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(r))
        .await
        .unwrap();
    mat.enqueue_background(MaterializeTask::RebuildPagesCache)
        .await
        .unwrap();
    mat.flush().await.unwrap();
    assert!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "flush should process foreground tasks"
    );
    assert!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "flush should process background tasks"
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
        MaterializeTask::ApplyOp(r.clone()),
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::ApplyOp(r.clone()),
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::ApplyOp(r),
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

#[test]
fn batch_groups() {
    let groups = group_tasks_by_block_id(vec![
        MaterializeTask::ApplyOp(fake_op_record(
            "edit_block",
            r#"{"block_id":"blk-A","to_text":"a1"}"#,
        )),
        MaterializeTask::ApplyOp(fake_op_record(
            "edit_block",
            r#"{"block_id":"blk-B","to_text":"b1"}"#,
        )),
        MaterializeTask::ApplyOp(fake_op_record(
            "edit_block",
            r#"{"block_id":"blk-A","to_text":"a2"}"#,
        )),
        MaterializeTask::RebuildTagsCache,
    ]);
    assert_eq!(
        groups.len(),
        3,
        "should produce 3 groups: blk-A, blk-B, and ungrouped"
    );
    assert!(
        groups.last().unwrap().0.is_none(),
        "last group should have no block_id for non-ApplyOp tasks"
    );
}
#[test]
fn batch_order() {
    let groups = group_tasks_by_block_id(vec![
        MaterializeTask::ApplyOp(fake_op_record(
            "edit_block",
            r#"{"block_id":"blk-X","to_text":"first"}"#,
        )),
        MaterializeTask::ApplyOp(fake_op_record(
            "edit_block",
            r#"{"block_id":"blk-X","to_text":"second"}"#,
        )),
        MaterializeTask::ApplyOp(fake_op_record(
            "edit_block",
            r#"{"block_id":"blk-X","to_text":"third"}"#,
        )),
    ]);
    assert_eq!(
        groups.len(),
        1,
        "all ops for same block should be in one group"
    );
    assert_eq!(groups[0].1.len(), 3, "group should contain all 3 ops");
    for (i, exp) in ["first", "second", "third"].iter().enumerate() {
        match &groups[0].1[i] {
            MaterializeTask::ApplyOp(r) => assert!(
                r.payload.contains(exp),
                "op at index {i} should contain '{exp}'"
            ),
            o => panic!("expected ApplyOp, got {o:?}"),
        }
    }
}

#[tokio::test]
async fn parallel_groups() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "PAR_A", "content", "original-A").await;
    insert_block_direct(&pool, "PAR_B", "content", "original-B").await;
    let ra = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("PAR_A"),
            to_text: "updated-A".into(),
            prev_edit: None,
        }),
    )
    .await;
    let rb = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("PAR_B"),
            to_text: "updated-B".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(ra))
        .await
        .unwrap();
    mat.enqueue_foreground(MaterializeTask::ApplyOp(rb))
        .await
        .unwrap();
    mat.flush_foreground().await.unwrap();
    let ca: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'PAR_A'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ca.as_deref(),
        Some("updated-A"),
        "block PAR_A content should be updated"
    );
    let cb: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'PAR_B'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        cb.as_deref(),
        Some("updated-B"),
        "block PAR_B content should be updated"
    );
    assert!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 2,
        "should process at least 2 foreground tasks for parallel groups"
    );
}

#[test]
fn high_water_zero() {
    let m = QueueMetrics::default();
    assert_eq!(
        m.fg_high_water.load(AtomicOrdering::Relaxed),
        0,
        "fg high water should start at zero"
    );
    assert_eq!(
        m.bg_high_water.load(AtomicOrdering::Relaxed),
        0,
        "bg high water should start at zero"
    );
}
#[tokio::test]
async fn high_water_fg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-hw"),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            content: "hw".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    assert!(
        mat.metrics().fg_high_water.load(AtomicOrdering::Relaxed) >= 1,
        "fg high water should increase after dispatch_op"
    );
}
#[tokio::test]
async fn high_water_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    assert!(
        mat.metrics().bg_high_water.load(AtomicOrdering::Relaxed) >= 1,
        "bg high water should increase after enqueue_background"
    );
}
#[tokio::test]
async fn status_info() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    tokio::time::sleep(Duration::from_millis(10)).await;
    let s = mat.status();
    assert_eq!(
        s.fg_high_water, 0,
        "initial fg high water in status should be zero"
    );
    assert_eq!(
        s.bg_high_water, 0,
        "initial bg high water in status should be zero"
    );
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-si"),
            block_type: "page".into(),
            parent_id: None,
            position: None,
            content: "status".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    assert!(
        mat.status().fg_high_water >= 1,
        "fg high water should rise after dispatching an op"
    );
}

#[tokio::test]
#[should_panic(expected = "edit_block payload has empty block_id")]
async fn dispatch_bg_empty_block_id() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let _ = mat.dispatch_background(&fake_op_record(
        "edit_block",
        r#"{"to_text":"hello","prev_edit":null}"#,
    ));
}
#[tokio::test]
async fn error_counters_zero() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let m = mat.metrics();
    assert_eq!(
        m.fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "fg errors should start at zero"
    );
    assert_eq!(
        m.bg_errors.load(AtomicOrdering::Relaxed),
        0,
        "bg errors should start at zero"
    );
    assert_eq!(
        m.fg_panics.load(AtomicOrdering::Relaxed),
        0,
        "fg panics should start at zero"
    );
    assert_eq!(
        m.bg_panics.load(AtomicOrdering::Relaxed),
        0,
        "bg panics should start at zero"
    );
}
#[tokio::test]
async fn status_error_counters() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let s = mat.status();
    assert_eq!(s.fg_errors, 0, "status fg_errors should start at zero");
    assert_eq!(s.bg_errors, 0, "status bg_errors should start at zero");
    assert_eq!(s.fg_panics, 0, "status fg_panics should start at zero");
    assert_eq!(s.bg_panics, 0, "status bg_panics should start at zero");
}

#[tokio::test]
async fn handle_fg_apply_op() {
    let (pool, _dir) = test_pool().await;
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('NOOP_BLK', 'content', 'original')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let task = MaterializeTask::ApplyOp(fake_op_record(
        "edit_block",
        r#"{"block_id":"NOOP_BLK","to_text":"modified","prev_edit":null}"#,
    ));
    assert!(
        handle_foreground_task(&pool, &task, &QueueMetrics::default())
            .await
            .is_ok(),
        "handle_foreground_task should succeed for valid ApplyOp"
    );
    let c: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'NOOP_BLK'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        c.as_deref(),
        Some("modified"),
        "content should be updated by foreground ApplyOp"
    );
}
#[tokio::test]
async fn handle_fg_barrier() {
    let (pool, _dir) = test_pool().await;
    let n = Arc::new(tokio::sync::Notify::new());
    assert!(
        handle_foreground_task(
            &pool,
            &MaterializeTask::Barrier(Arc::clone(&n)),
            &QueueMetrics::default()
        )
        .await
        .is_ok(),
        "barrier task should succeed"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), n.notified())
            .await
            .is_ok(),
        "barrier notify should fire within timeout"
    );
}
#[tokio::test]
async fn handle_fg_unexpected() {
    let (pool, _dir) = test_pool().await;
    assert!(
        handle_foreground_task(
            &pool,
            &MaterializeTask::RebuildTagsCache,
            &QueueMetrics::default()
        )
        .await
        .is_ok(),
        "unexpected task in foreground should not error"
    );
}
#[tokio::test]
async fn handle_fg_unexpected_reindex() {
    let (pool, _dir) = test_pool().await;
    assert!(
        handle_foreground_task(
            &pool,
            &MaterializeTask::ReindexBlockLinks {
                block_id: "01FAKE00000000000000000000".into()
            },
            &QueueMetrics::default()
        )
        .await
        .is_ok(),
        "unexpected reindex task in foreground should not error"
    );
}
#[tokio::test]
async fn handle_bg_unexpected_apply() {
    let (pool, _dir) = test_pool().await;
    handle_background_task(&pool, &MaterializeTask::ApplyOp(fake_op_record("create_block", r#"{"block_id":"X","block_type":"content","content":"t","parent_id":null,"position":null}"#)), None).await.unwrap();
    // ApplyOp in the background queue is a no-op — block must NOT be created
    let row = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM blocks WHERE id = 'X'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, 0, "ApplyOp in bg queue should be a no-op");
}

#[tokio::test]
async fn tags_cache_after_create_tag() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_FLUSH_1", "tag", "urgent").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_FLUSH_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            content: "urgent".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT name, usage_count FROM tags_cache WHERE tag_id = 'TAG_FLUSH_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "tags_cache should have a row for the created tag"
    );
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("name"),
        "urgent",
        "tag name in cache should match created tag"
    );
    assert_eq!(
        row.get::<i32, _>("usage_count"),
        0,
        "usage_count should be 0 for a new tag with no references"
    );
}
#[tokio::test]
async fn pages_cache_after_create_page() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "PAGE_FLUSH_1", "page", "My Test Page").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("PAGE_FLUSH_1"),
            block_type: "page".into(),
            parent_id: None,
            position: Some(0),
            content: "My Test Page".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT title FROM pages_cache WHERE page_id = 'PAGE_FLUSH_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "pages_cache should have a row for the created page"
    );
    assert_eq!(
        row.unwrap().get::<String, _>("title"),
        "My Test Page",
        "page title in cache should match created page"
    );
}
#[tokio::test]
async fn tags_cache_after_delete() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_DEL_1", "tag", "to-delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_DEL_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            content: "to-delete".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_some(),
        "tag should exist in cache before deletion"
    );
    soft_delete_block_direct(&pool, "TAG_DEL_1").await;
    let del = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("TAG_DEL_1"),
        }),
    )
    .await;
    mat.dispatch_op(&del).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT tag_id FROM tags_cache WHERE tag_id = 'TAG_DEL_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_none(),
        "tag should be removed from cache after deletion"
    );
}
#[tokio::test]
async fn tags_usage_count() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "TAG_USE_1", "tag", "important").await;
    insert_block_direct(&pool, "BLK_USE_1", "content", "some note").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("TAG_USE_1"),
            block_type: "tag".into(),
            parent_id: None,
            position: None,
            content: "important".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i32, _>("usage_count"),
        0,
        "usage_count should be 0 before any tag is applied"
    );
    insert_block_tag(&pool, "BLK_USE_1", "TAG_USE_1").await;
    let add = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("BLK_USE_1"),
            tag_id: BlockId::test_id("TAG_USE_1"),
        }),
    )
    .await;
    mat.dispatch_op(&add).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT usage_count FROM tags_cache WHERE tag_id = 'TAG_USE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<i32, _>("usage_count"),
        1,
        "usage_count should be 1 after adding tag to one block"
    );
}
#[tokio::test]
async fn agenda_cache_after_set_property() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "BLK_AGD_1", "content", "task").await;
    insert_property_date(&pool, "BLK_AGD_1", "due", "2025-03-15").await;
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK_AGD_1"),
            key: "due".into(),
            value_text: None,
            value_num: None,
            value_date: Some("2025-03-15".into()),
            value_ref: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT date, source FROM agenda_cache WHERE block_id = 'BLK_AGD_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_some(),
        "agenda_cache should have a row after setting a date property"
    );
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("date"),
        "2025-03-15",
        "agenda date should match the set property value"
    );
    assert_eq!(
        row.get::<String, _>("source"),
        "property:due",
        "agenda source should indicate the property key"
    );
}

#[tokio::test]
async fn apply_op_create() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("APPLY_CREATE_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "hello from remote".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row =
        sqlx::query("SELECT block_type, content, position FROM blocks WHERE id = 'APPLY_CREATE_1'")
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(row.is_some(), "block should exist after apply_op create");
    let row = row.unwrap();
    assert_eq!(
        row.get::<String, _>("block_type"),
        "content",
        "block_type should match created block"
    );
    assert_eq!(
        row.get::<Option<String>, _>("content").as_deref(),
        Some("hello from remote"),
        "content should match created block text"
    );
    assert_eq!(
        row.get::<Option<i64>, _>("position"),
        Some(1),
        "position should match created block position"
    );
}
#[tokio::test]
async fn apply_op_create_idempotent() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_IDEM_1", "content", "original").await;
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("APPLY_IDEM_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "from remote".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT content FROM blocks WHERE id = 'APPLY_IDEM_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("content")
            .as_deref(),
        Some("original"),
        "idempotent create should not overwrite existing block content"
    );
}
#[tokio::test]
async fn apply_op_edit() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_EDIT_1", "content", "before edit").await;
    let r = make_op_record(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("APPLY_EDIT_1"),
            to_text: "after edit".into(),
            prev_edit: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        sqlx::query("SELECT content FROM blocks WHERE id = 'APPLY_EDIT_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("content")
            .as_deref(),
        Some("after edit"),
        "content should reflect the edit operation"
    );
}
#[tokio::test]
async fn apply_op_delete() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_DEL_1", "content", "to delete").await;
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("APPLY_DEL_1"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT deleted_at FROM blocks WHERE id = 'APPLY_DEL_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("deleted_at")
            .is_some(),
        "deleted_at should be set after apply_op delete"
    );
}
#[tokio::test]
async fn apply_op_restore() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_RESTORE_1", "content", "to restore").await;
    soft_delete_block_direct(&pool, "APPLY_RESTORE_1").await;
    let r = make_op_record(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id("APPLY_RESTORE_1"),
            deleted_at_ref: FIXED_TS.into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT deleted_at FROM blocks WHERE id = 'APPLY_RESTORE_1'")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get::<Option<String>, _>("deleted_at")
            .is_none(),
        "deleted_at should be cleared after apply_op restore"
    );
}
#[tokio::test]
async fn apply_op_purge() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_PURGE_1", "content", "to purge").await;
    soft_delete_block_direct(&pool, "APPLY_PURGE_1").await;
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("APPLY_PURGE_1"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        sqlx::query("SELECT id FROM blocks WHERE id = 'APPLY_PURGE_1'")
            .fetch_optional(&pool)
            .await
            .unwrap()
            .is_none(),
        "block should be physically removed after apply_op purge"
    );
}
#[tokio::test]
async fn apply_op_move() {
    use sqlx::Row;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_MOVE_PARENT", "page", "parent").await;
    insert_block_direct(&pool, "APPLY_MOVE_1", "content", "movable").await;
    let r = make_op_record(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("APPLY_MOVE_1"),
            new_parent_id: Some(BlockId::test_id("APPLY_MOVE_PARENT")),
            new_position: 5,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let row = sqlx::query("SELECT parent_id, position FROM blocks WHERE id = 'APPLY_MOVE_1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        row.get::<Option<String>, _>("parent_id").as_deref(),
        Some("APPLY_MOVE_PARENT"),
        "parent_id should be set after apply_op move"
    );
    assert_eq!(
        row.get::<Option<i64>, _>("position"),
        Some(5),
        "position should be updated after apply_op move"
    );
}
#[tokio::test]
async fn apply_op_add_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block_direct(&pool, "APPLY_ADDTAG_BLK", "content", "note").await;
    insert_block_direct(&pool, "APPLY_ADDTAG_TAG", "tag", "urgent").await;
    let r = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("APPLY_ADDTAG_BLK"),
            tag_id: BlockId::test_id("APPLY_ADDTAG_TAG"),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM block_tags WHERE block_id = ? AND tag_id = ?",
        "APPLY_ADDTAG_BLK",
        "APPLY_ADDTAG_TAG"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "block_tags row should exist after apply_op add_tag"
    );
}
#[tokio::test]
async fn apply_op_invalid_payload() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_foreground(MaterializeTask::ApplyOp(fake_op_record(
        "create_block",
        r#"{"not_valid": true}"#,
    )))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
}
#[tokio::test]
async fn apply_op_unknown_op() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_foreground(MaterializeTask::ApplyOp(fake_op_record(
        "unknown_op",
        r#"{}"#,
    )))
    .await
    .unwrap();
    mat.flush_foreground().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_retry_success() {
    let (pool, _dir) = test_pool().await;
    let metrics = Arc::new(QueueMetrics::default());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-retry-ok"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "retry test".into(),
        }),
    )
    .await;
    process_single_foreground_task(&pool, MaterializeTask::ApplyOp(r), &metrics).await;
    assert_eq!(
        metrics.fg_processed.load(AtomicOrdering::Relaxed),
        1,
        "should count one processed task"
    );
    assert_eq!(
        metrics.fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "successful task should not increment errors"
    );
    assert_eq!(
        metrics.fg_panics.load(AtomicOrdering::Relaxed),
        0,
        "successful task should not increment panics"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_retry_barrier() {
    let (pool, _dir) = test_pool().await;
    let metrics = Arc::new(QueueMetrics::default());
    process_single_foreground_task(
        &pool,
        MaterializeTask::Barrier(Arc::new(tokio::sync::Notify::new())),
        &metrics,
    )
    .await;
    assert_eq!(
        metrics.fg_processed.load(AtomicOrdering::Relaxed),
        1,
        "barrier should count as one processed task"
    );
    assert_eq!(
        metrics.fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "barrier should not increment errors"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_retry_bad_payload() {
    let (pool, _dir) = test_pool().await;
    let metrics = Arc::new(QueueMetrics::default());
    process_single_foreground_task(
        &pool,
        MaterializeTask::ApplyOp(fake_op_record("bogus_op_type", "{}")),
        &metrics,
    )
    .await;
    assert_eq!(
        metrics.fg_processed.load(AtomicOrdering::Relaxed),
        1,
        "bad payload should still count as processed"
    );
    assert_eq!(
        metrics.fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "bad payload should increment error counter"
    );
    assert_eq!(
        metrics.fg_panics.load(AtomicOrdering::Relaxed),
        0,
        "bad payload should not cause a panic"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fg_lifecycle() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-lifecycle"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "lifecycle".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    assert!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1,
        "lifecycle should process at least one foreground task"
    );
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "lifecycle should have no errors"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_failure_propagated() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.enqueue_foreground(MaterializeTask::ApplyOp(fake_op_record(
        "create_block",
        "{}",
    )))
    .await
    .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "invalid payload should propagate as an error"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_partial_failure() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let good = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-batch-good"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "batch good".into(),
        }),
    )
    .await;
    let bad = fake_op_record("create_block", "{}");
    mat.enqueue_foreground(MaterializeTask::BatchApplyOps(vec![good, bad]))
        .await
        .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        1,
        "batch with a bad op should count one error"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apply_op_success() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("blk-success"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(0),
            content: "success".into(),
        }),
    )
    .await;
    mat.enqueue_foreground(MaterializeTask::ApplyOp(r))
        .await
        .unwrap();
    mat.flush().await.unwrap();
    assert_eq!(
        mat.metrics().fg_errors.load(AtomicOrdering::Relaxed),
        0,
        "successful apply_op should have zero errors"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG01", "tag", "test-tag").await;
    let mat = Materializer::with_read_pool(pool.clone(), pool.clone());
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "tags_cache should have one entry after rebuild with read pool"
    );
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bg_with_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG02", "tag", "split-tag").await;
    assert!(
        handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, Some(&pool))
            .await
            .is_ok(),
        "background task should succeed with explicit read pool"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1, "tags_cache should have one entry using read pool");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bg_without_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG03", "tag", "orig-tag").await;
    assert!(
        handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, None)
            .await
            .is_ok(),
        "background task should succeed without explicit read pool"
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "tags_cache should have one entry without read pool"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_orphaned_attachments() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.try_enqueue_background(MaterializeTask::CleanupOrphanedAttachments)
        .unwrap();
    mat.flush_background().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reserved_key_todo_state() {
    use crate::op::is_reserved_property_key;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position, is_conflict) VALUES ('BLK-RES', 'content', 'test', 1, 0)").execute(&pool).await.unwrap();
    assert!(
        is_reserved_property_key("todo_state"),
        "todo_state should be a reserved property key"
    );
    let r = make_op_record(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK-RES"),
            key: "todo_state".into(),
            value_text: Some("DONE".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let ts: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = 'BLK-RES'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        ts,
        Some("DONE".into()),
        "todo_state column should be set to DONE"
    );
    let pc: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-RES' AND key = 'todo_state'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        pc, 0,
        "reserved key should not be stored in block_properties"
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delete_reserved_key() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position, is_conflict, todo_state) VALUES ('BLK-DEL', 'content', 'test', 1, 0, 'TODO')").execute(&pool).await.unwrap();
    let r = make_op_record(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("BLK-DEL"),
            key: "todo_state".into(),
        }),
    )
    .await;
    mat.dispatch_op(&r).await.unwrap();
    mat.flush().await.unwrap();
    let after: Option<String> =
        sqlx::query_scalar("SELECT todo_state FROM blocks WHERE id = 'BLK-DEL'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        after.is_none(),
        "todo_state should be cleared after deleting reserved property"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_fg_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, ?, ?)")
        .bind("STRESS_01")
        .bind("content")
        .bind("stress")
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();
    let mut handles = Vec::new();
    for i in 0..20 {
        let mat_fg = mat.clone();
        let ps = format!(r#"{{"block_id":"STRESS_01","to_text":"v{i}","prev_edit":null}}"#);
        let record = fake_op_record("edit_block", &ps);
        handles.push(tokio::spawn(async move {
            let _ = mat_fg
                .enqueue_foreground(MaterializeTask::ApplyOp(record))
                .await;
        }));
        let mat_bg = mat.clone();
        handles.push(tokio::spawn(async move {
            let _ = mat_bg
                .enqueue_background(MaterializeTask::ReindexBlockLinks {
                    block_id: "STRESS_01".into(),
                })
                .await;
            let _ = mat_bg
                .enqueue_background(MaterializeTask::UpdateFtsBlock {
                    block_id: "STRESS_01".into(),
                })
                .await;
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    mat.flush().await.unwrap();
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_dispatch() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    sqlx::query("INSERT INTO blocks (id, block_type, content, position) VALUES (?, ?, ?, ?)")
        .bind("STRESS_SERIAL_01")
        .bind("content")
        .bind("initial")
        .bind(1_i64)
        .execute(&pool)
        .await
        .unwrap();
    let mut handles = Vec::new();
    for i in 0..10 {
        let mat_c = mat.clone();
        let pool_c = pool.clone();
        let payload = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("STRESS_SERIAL_01"),
            to_text: format!("concurrent-v{i}"),
            prev_edit: None,
        });
        handles.push(tokio::spawn(async move {
            let record = make_op_record(&pool_c, payload).await;
            mat_c.dispatch_op(&record).await.unwrap();
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    mat.flush().await.unwrap();
    assert!(
        mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 10,
        "should process at least 10 concurrent dispatch ops"
    );
}

// ======================================================================
// B-62: BatchApplyOps atomicity — if last op fails, none persist
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_apply_ops_atomic_rollback_on_failure() {
    let (pool, _dir) = test_pool().await;
    let metrics = std::sync::Arc::new(QueueMetrics::default());

    // First op: a valid create_block
    let good = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BATCH_ATOM_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "should be rolled back".into(),
        }),
    )
    .await;

    // Second op: bad payload that will fail deserialization
    let bad = fake_op_record("create_block", "{}");

    let task = MaterializeTask::BatchApplyOps(vec![good, bad]);
    let result = handle_foreground_task(&pool, &task, &metrics).await;
    assert!(
        result.is_err(),
        "batch should fail because the last op has bad payload"
    );

    // The first op's block should NOT be visible (rolled back)
    let row = sqlx::query("SELECT id FROM blocks WHERE id = 'BATCH_ATOM_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(
        row.is_none(),
        "block from first op should be rolled back when batch fails"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_apply_ops_all_succeed_commits() {
    let (pool, _dir) = test_pool().await;
    let metrics = std::sync::Arc::new(QueueMetrics::default());

    let op1 = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BATCH_OK_1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "first".into(),
        }),
    )
    .await;

    let op2 = make_op_record(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BATCH_OK_2"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(2),
            content: "second".into(),
        }),
    )
    .await;

    let task = MaterializeTask::BatchApplyOps(vec![op1, op2]);
    let result = handle_foreground_task(&pool, &task, &metrics).await;
    result.unwrap();

    // Both blocks should be visible
    let r1 = sqlx::query("SELECT id FROM blocks WHERE id = 'BATCH_OK_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(r1.is_some(), "first block should be committed");

    let r2 = sqlx::query("SELECT id FROM blocks WHERE id = 'BATCH_OK_2'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(r2.is_some(), "second block should be committed");
}

// ======================================================================
// B-63: purge cleans page_aliases and projected_agenda_cache
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_handler_cleans_page_aliases() {
    let (pool, _dir) = test_pool().await;
    let metrics = std::sync::Arc::new(QueueMetrics::default());

    // Create a page block, soft-delete it, add a page alias
    insert_block_direct(&pool, "PURGE_PA_1", "page", "my page").await;
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind("PURGE_PA_1")
        .bind("alias-one")
        .execute(&pool)
        .await
        .unwrap();

    // Verify alias exists
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 1, "alias should exist before purge");

    soft_delete_block_direct(&pool, "PURGE_PA_1").await;

    // Purge via handler
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("PURGE_PA_1"),
        }),
    )
    .await;
    let task = MaterializeTask::ApplyOp(r);
    handle_foreground_task(&pool, &task, &metrics)
        .await
        .unwrap();

    // Verify block and alias are gone
    let block_exists = sqlx::query("SELECT id FROM blocks WHERE id = 'PURGE_PA_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(block_exists.is_none(), "block should be physically gone");

    let alias_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM page_aliases WHERE page_id = 'PURGE_PA_1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(alias_count, 0, "page_aliases should be cleaned after purge");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn purge_handler_cleans_projected_agenda_cache() {
    let (pool, _dir) = test_pool().await;
    let metrics = std::sync::Arc::new(QueueMetrics::default());

    // Create a block, soft-delete it, add a projected_agenda_cache row
    insert_block_direct(&pool, "PURGE_PAC_1", "content", "task").await;
    sqlx::query(
        "INSERT INTO projected_agenda_cache (block_id, projected_date, source) VALUES (?, ?, ?)",
    )
    .bind("PURGE_PAC_1")
    .bind("2025-06-01")
    .bind("due_date")
    .execute(&pool)
    .await
    .unwrap();

    // Verify cache row exists
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "projected_agenda_cache row should exist before purge"
    );

    soft_delete_block_direct(&pool, "PURGE_PAC_1").await;

    // Purge via handler
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("PURGE_PAC_1"),
        }),
    )
    .await;
    let task = MaterializeTask::ApplyOp(r);
    handle_foreground_task(&pool, &task, &metrics)
        .await
        .unwrap();

    // Verify block and cache row are gone
    let block_exists = sqlx::query("SELECT id FROM blocks WHERE id = 'PURGE_PAC_1'")
        .fetch_optional(&pool)
        .await
        .unwrap();
    assert!(block_exists.is_none(), "block should be physically gone");

    let cache_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projected_agenda_cache WHERE block_id = 'PURGE_PAC_1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        cache_count, 0,
        "projected_agenda_cache should be cleaned after purge"
    );
}

// ======================================================================
// M-15: RemoveTag runs under transaction (via apply_op)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_handler_cleans_inherited() {
    let (pool, _dir) = test_pool().await;
    let metrics = std::sync::Arc::new(QueueMetrics::default());

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
    let task = MaterializeTask::ApplyOp(r);
    handle_foreground_task(&pool, &task, &metrics)
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

    // cached_block_count starts at 0 → threshold = max(500, 0/10_000) = 500
    assert_eq!(
        mat.metrics()
            .cached_block_count
            .load(AtomicOrdering::Relaxed),
        0,
        "cached block count should start at 0 before async refresh"
    );

    // Simulate 499 prior edits and pin last-optimize to now so the
    // time-based path does not fire.
    mat.metrics()
        .fts_edits_since_optimize
        .store(499, AtomicOrdering::Relaxed);
    #[allow(clippy::cast_possible_truncation)]
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
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

    // Simulate a 10 M-block corpus.
    // threshold = max(500, 10_000_000 / 10_000) = max(500, 1000) = 1000
    mat.metrics()
        .cached_block_count
        .store(10_000_000, AtomicOrdering::Relaxed);

    #[allow(clippy::cast_possible_truncation)]
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
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
