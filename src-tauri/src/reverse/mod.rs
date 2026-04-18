//! Reverse (inverse) op computation for the undo engine.

mod attachment_ops;
mod block_ops;
mod property_ops;
mod tag_ops;

pub(crate) use block_ops::find_prior_text;

use sqlx::SqlitePool;
use std::str::FromStr;

use crate::error::AppError;
use crate::op::{OpPayload, OpType};

pub async fn compute_reverse(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
) -> Result<OpPayload, AppError> {
    let record = crate::op_log::get_op_by_seq(pool, device_id, seq).await?;
    let op_type = OpType::from_str(&record.op_type)
        .map_err(|e| AppError::Validation(format!("unknown op_type in record: {e}")))?;
    match op_type {
        OpType::CreateBlock => block_ops::reverse_create_block(&record),
        OpType::DeleteBlock => block_ops::reverse_delete_block(pool, &record),
        OpType::EditBlock => block_ops::reverse_edit_block(pool, &record).await,
        OpType::MoveBlock => block_ops::reverse_move_block(pool, &record).await,
        OpType::AddTag => tag_ops::reverse_add_tag(&record),
        OpType::RemoveTag => tag_ops::reverse_remove_tag(&record),
        OpType::SetProperty => property_ops::reverse_set_property(pool, &record).await,
        OpType::DeleteProperty => property_ops::reverse_delete_property(pool, &record).await,
        OpType::AddAttachment => attachment_ops::reverse_add_attachment(&record),
        OpType::RestoreBlock => block_ops::reverse_restore_block(&record),
        OpType::DeleteAttachment => attachment_ops::reverse_delete_attachment(pool, &record).await,
        OpType::PurgeBlock => Err(AppError::NonReversible {
            op_type: record.op_type.clone(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::op::*;
    use crate::op_log::append_local_op_at;
    use crate::ulid::BlockId;
    use std::path::PathBuf;
    use tempfile::TempDir;

    const FIXED_TS: &str = "2025-01-15T12:00:00+00:00";
    const TEST_DEVICE: &str = "test-device";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn append_op(pool: &SqlitePool, payload: OpPayload, ts: &str) -> crate::op_log::OpRecord {
        append_local_op_at(pool, TEST_DEVICE, payload, ts.to_string())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn reverse_create_block_produces_delete_block() {
        let (pool, _dir) = test_pool().await;
        let create = OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK1"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "hello".into(),
        });
        let rec = append_op(&pool, create, FIXED_TS).await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        assert!(matches!(reverse, OpPayload::DeleteBlock(ref p) if p.block_id == "BLK1"));
    }
    #[tokio::test]
    async fn reverse_delete_block_produces_restore_block_with_deleted_at() {
        let (pool, _dir) = test_pool().await;
        let delete_ts = "2025-01-15T13:00:00+00:00";
        let rec = append_op(
            &pool,
            OpPayload::DeleteBlock(DeleteBlockPayload {
                block_id: BlockId::test_id("BLK2"),
            }),
            delete_ts,
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        match reverse {
            OpPayload::RestoreBlock(ref p) => {
                assert_eq!(p.block_id, "BLK2");
                assert_eq!(p.deleted_at_ref, delete_ts);
            }
            _ => panic!("expected RestoreBlock"),
        }
    }
    #[tokio::test]
    async fn reverse_edit_block_produces_edit_with_prior_text() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK3"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                content: "original".into(),
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK3"),
                to_text: "first edit".into(),
                prev_edit: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK3"),
                to_text: "second edit".into(),
                prev_edit: None,
            }),
            "2025-01-15T12:02:00+00:00",
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        match reverse {
            OpPayload::EditBlock(ref p) => {
                assert_eq!(p.to_text, "first edit");
                assert!(p.prev_edit.is_some());
            }
            _ => panic!("expected EditBlock"),
        }
    }
    #[tokio::test]
    async fn reverse_edit_block_when_prior_is_create_uses_content() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK4"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(1),
                content: "from create".into(),
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK4"),
                to_text: "edited".into(),
                prev_edit: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        match reverse {
            OpPayload::EditBlock(ref p) => assert_eq!(p.to_text, "from create"),
            _ => panic!("expected EditBlock"),
        }
    }
    #[tokio::test]
    async fn reverse_move_block_produces_move_with_prior_position() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK5"),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("P1")),
                position: Some(1),
                content: "test".into(),
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        append_op(
            &pool,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK5"),
                new_parent_id: Some(BlockId::test_id("P2")),
                new_position: 3,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK5"),
                new_parent_id: Some(BlockId::test_id("P3")),
                new_position: 5,
            }),
            "2025-01-15T12:02:00+00:00",
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        match reverse {
            OpPayload::MoveBlock(ref p) => {
                assert_eq!(p.new_parent_id, Some(BlockId::test_id("P2")));
                assert_eq!(p.new_position, 3);
            }
            _ => panic!("expected MoveBlock"),
        }
    }
    #[tokio::test]
    async fn reverse_move_block_when_prior_is_create_uses_create_position() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK6"),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("ROOT")),
                position: Some(2),
                content: "test".into(),
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK6"),
                new_parent_id: Some(BlockId::test_id("OTHER")),
                new_position: 7,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        match reverse {
            OpPayload::MoveBlock(ref p) => {
                assert_eq!(p.new_parent_id, Some(BlockId::test_id("ROOT")));
                assert_eq!(p.new_position, 2);
            }
            _ => panic!("expected MoveBlock"),
        }
    }
    /// BUG-26: An ancient `create_block` payload with `position = None`
    /// (pre-migration data) cannot be reversed into a valid `move_block`
    /// because positions are 1-based and `move_block_inner` rejects 0.
    /// Instead of silently defaulting to 0 (overflow into Validation) or
    /// fabricating 1 (pretending to know the original slot), the reverse
    /// must surface `NonReversible` explicitly.
    #[tokio::test]
    async fn reverse_move_block_when_prior_create_lacks_position_is_non_reversible() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK6NP"),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("ROOTNP")),
                position: None,
                content: "ancient".into(),
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK6NP"),
                new_parent_id: Some(BlockId::test_id("OTHERNP")),
                new_position: 7,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        let result = compute_reverse(&pool, TEST_DEVICE, rec.seq).await;
        assert!(
            matches!(
                result,
                Err(AppError::NonReversible { ref op_type }) if op_type == "move_block"
            ),
            "BUG-26: reverse of move_block must be NonReversible when the \
             prior create_block payload has position=None; got: {result:?}"
        );
    }
    #[tokio::test]
    async fn reverse_add_tag_produces_remove_tag() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::AddTag(AddTagPayload {
                block_id: BlockId::test_id("BLK7"),
                tag_id: BlockId::test_id("TAG1"),
            }),
            FIXED_TS,
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        match reverse {
            OpPayload::RemoveTag(ref p) => {
                assert_eq!(p.block_id, "BLK7");
                assert_eq!(p.tag_id, "TAG1");
            }
            _ => panic!("expected RemoveTag"),
        }
    }
    #[tokio::test]
    async fn reverse_remove_tag_produces_add_tag() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::RemoveTag(RemoveTagPayload {
                block_id: BlockId::test_id("BLK8"),
                tag_id: BlockId::test_id("TAG2"),
            }),
            FIXED_TS,
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        match reverse {
            OpPayload::AddTag(ref p) => {
                assert_eq!(p.block_id, "BLK8");
                assert_eq!(p.tag_id, "TAG2");
            }
            _ => panic!("expected AddTag"),
        }
    }
    #[tokio::test]
    async fn reverse_set_property_with_prior_produces_set_property() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK9"),
                key: "priority".into(),
                value_text: Some("low".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK9"),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        match reverse {
            OpPayload::SetProperty(ref p) => {
                assert_eq!(p.value_text, Some("low".into()));
            }
            _ => panic!("expected SetProperty"),
        }
    }
    #[tokio::test]
    async fn reverse_first_set_property_produces_delete_property() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK9B"),
                key: "status".into(),
                value_text: Some("active".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            FIXED_TS,
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        assert!(
            matches!(reverse, OpPayload::DeleteProperty(ref p) if p.block_id == "BLK9B" && p.key == "status")
        );
    }
    #[tokio::test]
    async fn reverse_delete_property_produces_set_property_with_prior() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK10"),
                key: "color".into(),
                value_text: Some("blue".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: BlockId::test_id("BLK10"),
                key: "color".into(),
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        match reverse {
            OpPayload::SetProperty(ref p) => assert_eq!(p.value_text, Some("blue".into())),
            _ => panic!("expected SetProperty"),
        }
    }
    #[tokio::test]
    async fn reverse_add_attachment_produces_delete_attachment() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::AddAttachment(AddAttachmentPayload {
                attachment_id: "ATT1".into(),
                block_id: BlockId::test_id("BLK11"),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 1024,
                fs_path: "/tmp/photo.png".into(),
            }),
            FIXED_TS,
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        assert!(matches!(reverse, OpPayload::DeleteAttachment(ref p) if p.attachment_id == "ATT1"));
    }
    #[tokio::test]
    async fn reverse_purge_block_returns_non_reversible_error() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::PurgeBlock(PurgeBlockPayload {
                block_id: BlockId::test_id("BLK12"),
            }),
            FIXED_TS,
        )
        .await;
        let result = compute_reverse(&pool, TEST_DEVICE, rec.seq).await;
        assert!(
            matches!(result, Err(AppError::NonReversible { ref op_type }) if op_type == "purge_block")
        );
    }
    #[tokio::test]
    async fn reverse_delete_attachment_returns_non_reversible_error() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::DeleteAttachment(DeleteAttachmentPayload {
                attachment_id: "ATT2".into(),
            }),
            FIXED_TS,
        )
        .await;
        let result = compute_reverse(&pool, TEST_DEVICE, rec.seq).await;
        assert!(
            matches!(result, Err(AppError::NonReversible { ref op_type }) if op_type == "delete_attachment")
        );
    }
    #[tokio::test]
    async fn reverse_restore_block_produces_delete_block() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::RestoreBlock(RestoreBlockPayload {
                block_id: BlockId::test_id("BLK14"),
                deleted_at_ref: "2025-01-15T10:00:00+00:00".into(),
            }),
            FIXED_TS,
        )
        .await;
        let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
        assert!(matches!(reverse, OpPayload::DeleteBlock(ref p) if p.block_id == "BLK14"));
    }
    #[tokio::test]
    async fn reverse_edit_block_without_prior_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("ORPHAN_EDIT"),
                to_text: "new text".into(),
                prev_edit: None,
            }),
            FIXED_TS,
        )
        .await;
        assert!(matches!(
            compute_reverse(&pool, TEST_DEVICE, rec.seq).await,
            Err(AppError::NotFound(_))
        ));
    }
    #[tokio::test]
    async fn reverse_move_block_without_prior_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("ORPHAN_MOVE"),
                new_parent_id: Some(BlockId::test_id("P1")),
                new_position: 5,
            }),
            FIXED_TS,
        )
        .await;
        assert!(matches!(
            compute_reverse(&pool, TEST_DEVICE, rec.seq).await,
            Err(AppError::NotFound(_))
        ));
    }
    #[tokio::test]
    async fn reverse_delete_property_without_prior_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: BlockId::test_id("ORPHAN_PROP"),
                key: "color".into(),
            }),
            FIXED_TS,
        )
        .await;
        assert!(matches!(
            compute_reverse(&pool, TEST_DEVICE, rec.seq).await,
            Err(AppError::NotFound(_))
        ));
    }
    #[tokio::test]
    async fn reverse_delete_block_missing_block_returns_not_found() {
        let (pool, _dir) = test_pool().await;
        assert!(matches!(
            compute_reverse(&pool, TEST_DEVICE, 9999).await,
            Err(AppError::NotFound(_))
        ));
    }
    #[tokio::test]
    async fn undo_chain_edit_round_trip() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_UC1"),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("PAGE1")),
                position: Some(0),
                content: "original".into(),
            }),
            FIXED_TS,
        )
        .await;
        let edit = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK_UC1"),
                to_text: "modified".into(),
                prev_edit: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        let rev1 = compute_reverse(&pool, TEST_DEVICE, edit.seq).await.unwrap();
        match &rev1 {
            OpPayload::EditBlock(p) => assert_eq!(p.to_text, "original"),
            other => panic!("Expected EditBlock, got {:?}", other),
        }
        let undo_op = append_op(&pool, rev1, "2025-01-15T12:02:00+00:00").await;
        let rev2 = compute_reverse(&pool, TEST_DEVICE, undo_op.seq)
            .await
            .unwrap();
        match &rev2 {
            OpPayload::EditBlock(p) => assert_eq!(p.to_text, "modified"),
            other => panic!("Expected EditBlock, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn undo_chain_move_round_trip() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_UC2"),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("PAGE1")),
                position: Some(0),
                content: "moveable".into(),
            }),
            FIXED_TS,
        )
        .await;
        let move_op = append_op(
            &pool,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("BLK_UC2"),
                new_parent_id: Some(BlockId::test_id("PAGE2")),
                new_position: 5,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        let rev1 = compute_reverse(&pool, TEST_DEVICE, move_op.seq)
            .await
            .unwrap();
        match &rev1 {
            OpPayload::MoveBlock(p) => {
                assert_eq!(p.new_parent_id, Some(BlockId::test_id("PAGE1")));
                assert_eq!(p.new_position, 0);
            }
            other => panic!("Expected MoveBlock, got {:?}", other),
        }
        let undo_op = append_op(&pool, rev1, "2025-01-15T12:02:00+00:00").await;
        let rev2 = compute_reverse(&pool, TEST_DEVICE, undo_op.seq)
            .await
            .unwrap();
        match &rev2 {
            OpPayload::MoveBlock(p) => {
                assert_eq!(p.new_parent_id, Some(BlockId::test_id("PAGE2")));
                assert_eq!(p.new_position, 5);
            }
            other => panic!("Expected MoveBlock, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn undo_chain_create_delete_restore() {
        let (pool, _dir) = test_pool().await;
        let create = append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_UC3"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "ephemeral".into(),
            }),
            FIXED_TS,
        )
        .await;
        let rev1 = compute_reverse(&pool, TEST_DEVICE, create.seq)
            .await
            .unwrap();
        assert!(matches!(&rev1, OpPayload::DeleteBlock(p) if p.block_id == "BLK_UC3"));
        let delete_op = append_op(&pool, rev1, "2025-01-15T12:01:00+00:00").await;
        let rev2 = compute_reverse(&pool, TEST_DEVICE, delete_op.seq)
            .await
            .unwrap();
        assert!(matches!(&rev2, OpPayload::RestoreBlock(p) if p.block_id == "BLK_UC3"));
        let restore_op = append_op(&pool, rev2, "2025-01-15T12:02:00+00:00").await;
        let rev3 = compute_reverse(&pool, TEST_DEVICE, restore_op.seq)
            .await
            .unwrap();
        assert!(matches!(&rev3, OpPayload::DeleteBlock(p) if p.block_id == "BLK_UC3"));
    }
    #[tokio::test]
    async fn reverse_set_property_value_num() {
        let (pool, _dir) = test_pool().await;
        let set1 = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PN"),
                key: "score".into(),
                value_text: None,
                value_num: Some(42.0),
                value_date: None,
                value_ref: None,
            }),
            FIXED_TS,
        )
        .await;
        assert!(matches!(
            compute_reverse(&pool, TEST_DEVICE, set1.seq).await.unwrap(),
            OpPayload::DeleteProperty(_)
        ));
        let set2 = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PN"),
                key: "score".into(),
                value_text: None,
                value_num: Some(99.0),
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        match compute_reverse(&pool, TEST_DEVICE, set2.seq).await.unwrap() {
            OpPayload::SetProperty(p) => assert_eq!(p.value_num, Some(42.0)),
            other => panic!("Expected SetProperty, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn reverse_set_property_value_date() {
        let (pool, _dir) = test_pool().await;
        let set1 = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PD"),
                key: "due-date".into(),
                value_text: None,
                value_num: None,
                value_date: Some("2025-06-15".into()),
                value_ref: None,
            }),
            FIXED_TS,
        )
        .await;
        assert!(matches!(
            compute_reverse(&pool, TEST_DEVICE, set1.seq).await.unwrap(),
            OpPayload::DeleteProperty(_)
        ));
        let set2 = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PD"),
                key: "due-date".into(),
                value_text: None,
                value_num: None,
                value_date: Some("2025-12-31".into()),
                value_ref: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        match compute_reverse(&pool, TEST_DEVICE, set2.seq).await.unwrap() {
            OpPayload::SetProperty(p) => assert_eq!(p.value_date, Some("2025-06-15".into())),
            other => panic!("Expected SetProperty, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn reverse_edit_same_timestamp_uses_seq_ordering() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_SEQ"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "v0".into(),
            }),
            FIXED_TS,
        )
        .await;
        let same_ts = "2025-01-15T12:01:00+00:00";
        append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK_SEQ"),
                to_text: "v1".into(),
                prev_edit: None,
            }),
            same_ts,
        )
        .await;
        let edit2 = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK_SEQ"),
                to_text: "v2".into(),
                prev_edit: None,
            }),
            same_ts,
        )
        .await;
        match compute_reverse(&pool, TEST_DEVICE, edit2.seq)
            .await
            .unwrap()
        {
            OpPayload::EditBlock(p) => assert_eq!(p.to_text, "v1"),
            other => panic!("Expected EditBlock, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn reverse_edit_block_prev_edit_points_to_reversed_op_from_different_device() {
        let (pool, _dir) = test_pool().await;
        let dev_b = "device-B";
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id("BLK_XD"),
                block_type: "content".into(),
                parent_id: None,
                position: Some(0),
                content: "original".into(),
            }),
            FIXED_TS,
        )
        .await;
        let edit_b = append_local_op_at(
            &pool,
            dev_b,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLK_XD"),
                to_text: "edited by B".into(),
                prev_edit: Some((TEST_DEVICE.to_owned(), 1)),
            }),
            "2025-01-15T12:01:00+00:00".to_owned(),
        )
        .await
        .unwrap();
        let reverse = compute_reverse(&pool, dev_b, edit_b.seq).await.unwrap();
        match reverse {
            OpPayload::EditBlock(ref p) => {
                assert_eq!(p.to_text, "original");
                let (ref dev, seq) = p.prev_edit.as_ref().unwrap();
                assert_eq!(dev, dev_b);
                assert_eq!(*seq, edit_b.seq);
            }
            _ => panic!("expected EditBlock"),
        }
    }
    #[tokio::test]
    async fn reverse_delete_attachment_returns_add_attachment_with_metadata() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: "ATT_001".into(),
                block_id: BlockId::test_id("BLK_ATT"),
                mime_type: "image/png".into(),
                filename: "photo.png".into(),
                size_bytes: 2048,
                fs_path: "/data/photo.png".into(),
            }),
            FIXED_TS,
        )
        .await;
        let del = append_op(
            &pool,
            OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
                attachment_id: "ATT_001".into(),
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        match compute_reverse(&pool, TEST_DEVICE, del.seq).await.unwrap() {
            OpPayload::AddAttachment(p) => {
                assert_eq!(p.attachment_id, "ATT_001");
                assert_eq!(p.block_id, "BLK_ATT");
            }
            other => panic!("Expected AddAttachment, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn reverse_delete_attachment_no_add_op_returns_non_reversible() {
        let (pool, _dir) = test_pool().await;
        let del = append_op(
            &pool,
            OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
                attachment_id: "ATT_ORPHAN".into(),
            }),
            FIXED_TS,
        )
        .await;
        assert!(matches!(
            compute_reverse(&pool, TEST_DEVICE, del.seq).await,
            Err(AppError::NonReversible { .. })
        ));
    }
    #[tokio::test]
    async fn reverse_delete_attachment_roundtrip() {
        let (pool, _dir) = test_pool().await;
        let add_rec = append_op(
            &pool,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: "ATT_RT".into(),
                block_id: BlockId::test_id("BLK_RT"),
                mime_type: "application/pdf".into(),
                filename: "doc.pdf".into(),
                size_bytes: 4096,
                fs_path: "/data/doc.pdf".into(),
            }),
            FIXED_TS,
        )
        .await;
        let rev1 = compute_reverse(&pool, TEST_DEVICE, add_rec.seq)
            .await
            .unwrap();
        assert!(matches!(rev1, OpPayload::DeleteAttachment(ref p) if p.attachment_id == "ATT_RT"));
        let del_rec = append_op(&pool, rev1, "2025-01-15T12:01:00+00:00").await;
        match compute_reverse(&pool, TEST_DEVICE, del_rec.seq)
            .await
            .unwrap()
        {
            OpPayload::AddAttachment(p) => assert_eq!(p.attachment_id, "ATT_RT"),
            other => panic!("Expected AddAttachment, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn reverse_set_reserved_property_todo_state() {
        let (pool, _dir) = test_pool().await;
        let rec = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_TS1"),
                key: "todo_state".into(),
                value_text: Some("TODO".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            FIXED_TS,
        )
        .await;
        assert!(
            matches!(compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap(), OpPayload::DeleteProperty(ref p) if p.key == "todo_state")
        );
    }
    #[tokio::test]
    async fn reverse_set_reserved_property_todo_state_with_prior() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_TS2"),
                key: "todo_state".into(),
                value_text: Some("TODO".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_TS2"),
                key: "todo_state".into(),
                value_text: Some("DONE".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
            OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("TODO".into())),
            other => panic!("Expected SetProperty, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn reverse_delete_reserved_property_todo_state() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_TS3"),
                key: "todo_state".into(),
                value_text: Some("DOING".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::DeleteProperty(DeletePropertyPayload {
                block_id: BlockId::test_id("BLK_TS3"),
                key: "todo_state".into(),
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
            OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("DOING".into())),
            other => panic!("Expected SetProperty, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn reverse_set_reserved_property_priority_with_prior() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PR1"),
                key: "priority".into(),
                value_text: Some("A".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_PR1"),
                key: "priority".into(),
                value_text: Some("C".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
            OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("A".into())),
            other => panic!("Expected SetProperty, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn reverse_set_reserved_property_due_date_with_prior() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_DD1"),
                key: "due_date".into(),
                value_text: Some("2025-06-15".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_DD1"),
                key: "due_date".into(),
                value_text: Some("2025-12-31".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
            OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("2025-06-15".into())),
            other => panic!("Expected SetProperty, got {:?}", other),
        }
    }
    #[tokio::test]
    async fn reverse_set_reserved_property_scheduled_date_with_prior() {
        let (pool, _dir) = test_pool().await;
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_SD1"),
                key: "scheduled_date".into(),
                value_text: Some("2025-06-15".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:00:00+00:00",
        )
        .await;
        let rec = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("BLK_SD1"),
                key: "scheduled_date".into(),
                value_text: Some("2025-12-31".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
            }),
            "2025-01-15T12:01:00+00:00",
        )
        .await;
        match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
            OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("2025-06-15".into())),
            other => panic!("Expected SetProperty, got {:?}", other),
        }
    }
}
