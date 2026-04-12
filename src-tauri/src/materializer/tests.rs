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
    assert!(mat
        .try_enqueue_background(MaterializeTask::RebuildTagsCache)
        .is_ok());
}
#[tokio::test]
async fn clone_shares_queues_both_can_enqueue() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let mat2 = mat.clone();
    assert!(mat
        .enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .is_ok());
    assert!(mat2
        .enqueue_background(MaterializeTask::RebuildPagesCache)
        .await
        .is_ok());
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
    assert!(mat.dispatch_op(&r).await.is_ok());
    mat.flush().await.unwrap();
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
    assert!(mat.dispatch_op(&r).await.is_ok());
    mat.flush().await.unwrap();
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
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_edit_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
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
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_delete_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("blk-3"),
        }),
    )
    .await;
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_restore_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id("blk-r"),
            deleted_at_ref: FIXED_TS.into(),
        }),
    )
    .await;
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_purge_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::test_id("blk-p"),
        }),
    )
    .await;
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_add_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::AddTag(AddTagPayload {
            block_id: BlockId::test_id("blk-4"),
            tag_id: BlockId::test_id("tag-1"),
        }),
    )
    .await;
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_remove_tag() {
    use crate::op::RemoveTagPayload;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::RemoveTag(RemoveTagPayload {
            block_id: BlockId::test_id("blk-rt"),
            tag_id: BlockId::test_id("tag-99"),
        }),
    )
    .await;
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_set_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
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
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_delete_property() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("blk-dp"),
            key: "due".into(),
        }),
    )
    .await;
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_move_block() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("blk-6"),
            new_parent_id: Some(BlockId::test_id("blk-parent")),
            new_position: 2,
        }),
    )
    .await;
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_add_attachment() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
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
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_delete_attachment() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let r = make_op_record(
        &pool,
        OpPayload::DeleteAttachment(DeleteAttachmentPayload {
            attachment_id: "att-2".into(),
        }),
    )
    .await;
    assert!(mat.dispatch_op(&r).await.is_ok());
}
#[tokio::test]
async fn dispatch_op_unknown_op_type() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(mat
        .dispatch_op(&fake_op_record("unknown_future_op", "{}"))
        .await
        .is_ok());
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
    assert!(mat.dispatch_background(&r).is_ok());
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
    assert!(mat.dispatch_background(&r).is_ok());
}
#[tokio::test]
async fn enqueue_foreground_any() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(mat
        .enqueue_foreground(MaterializeTask::RebuildTagsCache)
        .await
        .is_ok());
}
#[tokio::test]
async fn enqueue_background_all() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(mat
        .enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .is_ok());
    assert!(mat
        .enqueue_background(MaterializeTask::RebuildPagesCache)
        .await
        .is_ok());
    assert!(mat
        .enqueue_background(MaterializeTask::ReindexBlockLinks {
            block_id: "blk-x".into()
        })
        .await
        .is_ok());
}
#[tokio::test]
async fn try_enqueue_background_drops_when_full() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    for _ in 0..2000 {
        assert!(mat
            .try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .is_ok());
    }
}
#[tokio::test]
async fn try_enqueue_after_shutdown_err() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(mat
        .try_enqueue_background(MaterializeTask::RebuildTagsCache)
        .is_err());
}
#[tokio::test]
async fn shutdown_stops_consumers() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    assert!(mat
        .enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .is_ok());
    mat.flush_background().await.unwrap();
    mat.shutdown();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(mat
        .enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .is_err());
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
    assert!(mat
        .try_enqueue_background(MaterializeTask::RebuildTagsCache)
        .is_err());
    assert!(mat
        .enqueue_foreground(MaterializeTask::RebuildTagsCache)
        .await
        .is_err());
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
    assert!(mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1);
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
    assert!(mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1);
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
    assert!(mat
        .enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .is_ok());
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
    assert!(mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1);
}
#[tokio::test]
async fn flush_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    mat.flush_background().await.unwrap();
    assert!(mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1);
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
    assert!(mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1);
    assert!(mat.metrics().bg_processed.load(AtomicOrdering::Relaxed) >= 1);
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
    assert_eq!(d.len(), 3);
    assert_eq!(
        d.iter()
            .filter(|t| matches!(t, MaterializeTask::Barrier(_)))
            .count(),
        2
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
    assert_eq!(d.len(), 3);
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
    assert_eq!(d.len(), 4);
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
    assert_eq!(d.len(), 4);
    assert_eq!(
        d.iter()
            .filter(|t| matches!(t, MaterializeTask::ApplyOp(_)))
            .count(),
        3
    );
}
#[test]
fn dedup_empty() {
    assert!(dedup_tasks(vec![]).is_empty());
}
#[test]
fn dedup_single() {
    assert_eq!(
        dedup_tasks(vec![MaterializeTask::RebuildTagsCache]).len(),
        1
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
        1
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
        3
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
        2
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
        2
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
        2
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
    assert_eq!(d.len(), 3);
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
        3
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
    assert_eq!(groups.len(), 3);
    assert!(groups.last().unwrap().0.is_none());
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
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].1.len(), 3);
    for (i, exp) in ["first", "second", "third"].iter().enumerate() {
        match &groups[0].1[i] {
            MaterializeTask::ApplyOp(r) => assert!(r.payload.contains(exp)),
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
    assert_eq!(ca.as_deref(), Some("updated-A"));
    let cb: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'PAR_B'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cb.as_deref(), Some("updated-B"));
    assert!(mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 2);
}

#[test]
fn high_water_zero() {
    let m = QueueMetrics::default();
    assert_eq!(m.fg_high_water.load(AtomicOrdering::Relaxed), 0);
    assert_eq!(m.bg_high_water.load(AtomicOrdering::Relaxed), 0);
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
    assert!(mat.metrics().fg_high_water.load(AtomicOrdering::Relaxed) >= 1);
}
#[tokio::test]
async fn high_water_bg() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    mat.enqueue_background(MaterializeTask::RebuildTagsCache)
        .await
        .unwrap();
    assert!(mat.metrics().bg_high_water.load(AtomicOrdering::Relaxed) >= 1);
}
#[tokio::test]
async fn status_info() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    tokio::time::sleep(Duration::from_millis(10)).await;
    let s = mat.status();
    assert_eq!(s.fg_high_water, 0);
    assert_eq!(s.bg_high_water, 0);
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
    assert!(mat.status().fg_high_water >= 1);
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
    assert_eq!(m.fg_errors.load(AtomicOrdering::Relaxed), 0);
    assert_eq!(m.bg_errors.load(AtomicOrdering::Relaxed), 0);
    assert_eq!(m.fg_panics.load(AtomicOrdering::Relaxed), 0);
    assert_eq!(m.bg_panics.load(AtomicOrdering::Relaxed), 0);
}
#[tokio::test]
async fn status_error_counters() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool);
    let s = mat.status();
    assert_eq!(s.fg_errors, 0);
    assert_eq!(s.bg_errors, 0);
    assert_eq!(s.fg_panics, 0);
    assert_eq!(s.bg_panics, 0);
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
            .is_ok()
    );
    let c: Option<String> = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = 'NOOP_BLK'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(c.as_deref(), Some("modified"));
}
#[tokio::test]
async fn handle_fg_barrier() {
    let (pool, _dir) = test_pool().await;
    let n = Arc::new(tokio::sync::Notify::new());
    assert!(handle_foreground_task(
        &pool,
        &MaterializeTask::Barrier(Arc::clone(&n)),
        &QueueMetrics::default()
    )
    .await
    .is_ok());
    assert!(
        tokio::time::timeout(Duration::from_millis(100), n.notified())
            .await
            .is_ok()
    );
}
#[tokio::test]
async fn handle_fg_unexpected() {
    let (pool, _dir) = test_pool().await;
    assert!(handle_foreground_task(
        &pool,
        &MaterializeTask::RebuildTagsCache,
        &QueueMetrics::default()
    )
    .await
    .is_ok());
}
#[tokio::test]
async fn handle_fg_unexpected_reindex() {
    let (pool, _dir) = test_pool().await;
    assert!(handle_foreground_task(
        &pool,
        &MaterializeTask::ReindexBlockLinks {
            block_id: "01FAKE00000000000000000000".into()
        },
        &QueueMetrics::default()
    )
    .await
    .is_ok());
}
#[tokio::test]
async fn handle_bg_unexpected_apply() {
    let (pool, _dir) = test_pool().await;
    assert!(handle_background_task(&pool, &MaterializeTask::ApplyOp(fake_op_record("create_block", r#"{"block_id":"X","block_type":"content","content":"t","parent_id":null,"position":null}"#)), None).await.is_ok());
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
    assert!(row.is_some());
    let row = row.unwrap();
    assert_eq!(row.get::<String, _>("name"), "urgent");
    assert_eq!(row.get::<i32, _>("usage_count"), 0);
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
    assert!(row.is_some());
    assert_eq!(row.unwrap().get::<String, _>("title"), "My Test Page");
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
            .is_some()
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
            .is_none()
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
        0
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
        1
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
    assert!(row.is_some());
    let row = row.unwrap();
    assert_eq!(row.get::<String, _>("date"), "2025-03-15");
    assert_eq!(row.get::<String, _>("source"), "property:due");
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
    assert!(row.is_some());
    let row = row.unwrap();
    assert_eq!(row.get::<String, _>("block_type"), "content");
    assert_eq!(
        row.get::<Option<String>, _>("content").as_deref(),
        Some("hello from remote")
    );
    assert_eq!(row.get::<Option<i64>, _>("position"), Some(1));
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
        Some("original")
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
        Some("after edit")
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
            .is_some()
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
            .is_none()
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
            .is_none()
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
        Some("APPLY_MOVE_PARENT")
    );
    assert_eq!(row.get::<Option<i64>, _>("position"), Some(5));
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
    assert_eq!(count, 1);
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
    assert_eq!(metrics.fg_processed.load(AtomicOrdering::Relaxed), 1);
    assert_eq!(metrics.fg_errors.load(AtomicOrdering::Relaxed), 0);
    assert_eq!(metrics.fg_panics.load(AtomicOrdering::Relaxed), 0);
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
    assert_eq!(metrics.fg_processed.load(AtomicOrdering::Relaxed), 1);
    assert_eq!(metrics.fg_errors.load(AtomicOrdering::Relaxed), 0);
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
    assert_eq!(metrics.fg_processed.load(AtomicOrdering::Relaxed), 1);
    assert_eq!(metrics.fg_errors.load(AtomicOrdering::Relaxed), 1);
    assert_eq!(metrics.fg_panics.load(AtomicOrdering::Relaxed), 0);
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
    assert!(mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 1);
    assert_eq!(mat.metrics().fg_errors.load(AtomicOrdering::Relaxed), 0);
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
    assert_eq!(mat.metrics().fg_errors.load(AtomicOrdering::Relaxed), 1);
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
    assert_eq!(mat.metrics().fg_errors.load(AtomicOrdering::Relaxed), 1);
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
    assert_eq!(mat.metrics().fg_errors.load(AtomicOrdering::Relaxed), 0);
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
    assert_eq!(count, 1);
    mat.shutdown();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bg_with_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG02", "tag", "split-tag").await;
    assert!(
        handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, Some(&pool))
            .await
            .is_ok()
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bg_without_read_pool() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, "TAG03", "tag", "orig-tag").await;
    assert!(
        handle_background_task(&pool, &MaterializeTask::RebuildTagsCache, None)
            .await
            .is_ok()
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
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
    assert!(is_reserved_property_key("todo_state"));
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
    assert_eq!(ts, Some("DONE".into()));
    let pc: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM block_properties WHERE block_id = 'BLK-RES' AND key = 'todo_state'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(pc, 0);
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
    assert!(after.is_none());
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
    assert!(mat.metrics().fg_processed.load(AtomicOrdering::Relaxed) >= 10);
}
