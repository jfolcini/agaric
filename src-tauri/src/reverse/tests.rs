use super::*;
use crate::db::init_pool;
use crate::op::*;
use crate::op_log::append_local_op_at;
use crate::ulid::BlockId;
use std::path::PathBuf;
use tempfile::TempDir;

const FIXED_TS: &str = "2025-01-15T12:00:00Z";
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
    let delete_ts = "2025-01-15T13:00:00Z";
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
        "2025-01-15T12:00:00Z",
    )
    .await;
    append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK3"),
            to_text: "first edit".into(),
            prev_edit: None,
        }),
        "2025-01-15T12:01:00Z",
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK3"),
            to_text: "second edit".into(),
            prev_edit: None,
        }),
        "2025-01-15T12:02:00Z",
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
        "2025-01-15T12:00:00Z",
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK4"),
            to_text: "edited".into(),
            prev_edit: None,
        }),
        "2025-01-15T12:01:00Z",
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
        "2025-01-15T12:00:00Z",
    )
    .await;
    append_op(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK5"),
            new_parent_id: Some(BlockId::test_id("P2")),
            new_position: 3,
        }),
        "2025-01-15T12:01:00Z",
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK5"),
            new_parent_id: Some(BlockId::test_id("P3")),
            new_position: 5,
        }),
        "2025-01-15T12:02:00Z",
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
        "2025-01-15T12:00:00Z",
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK6"),
            new_parent_id: Some(BlockId::test_id("OTHER")),
            new_position: 7,
        }),
        "2025-01-15T12:01:00Z",
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
        "2025-01-15T12:00:00Z",
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK6NP"),
            new_parent_id: Some(BlockId::test_id("OTHERNP")),
            new_position: 7,
        }),
        "2025-01-15T12:01:00Z",
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
        "2025-01-15T12:00:00Z",
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
        "2025-01-15T12:01:00Z",
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
        "2025-01-15T12:00:00Z",
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("BLK10"),
            key: "color".into(),
        }),
        "2025-01-15T12:01:00Z",
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
            attachment_id: BlockId::test_id("ATT1"),
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
            attachment_id: BlockId::test_id("ATT2"),
            fs_path: "/tmp/att2.bin".into(),
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
            deleted_at_ref: "2025-01-15T10:00:00Z".into(),
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
/// TEST-50: with a populated `op_log`, calling `compute_reverse` on a
/// `seq` that does not exist must return `AppError::NotFound` whose
/// message names the `(device_id, seq)` pair — not panic, not return
/// an empty payload, not silently succeed. The sibling test above
/// covers the empty-log case; this one differentiates a real gap from
/// "no ops at all" and pins the diagnostic shape we rely on in
/// support.
#[tokio::test]
async fn compute_reverse_with_nonexistent_seq_returns_not_found_with_populated_log() {
    let (pool, _dir) = test_pool().await;

    // Populate op_log with a real entry first so we can distinguish
    // "seq missing" from "no ops at all".
    let real = append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK_GAP"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            content: "real".into(),
        }),
        FIXED_TS,
    )
    .await;

    // Sanity: the real seq round-trips.
    let _ = compute_reverse(&pool, TEST_DEVICE, real.seq).await.unwrap();

    // A seq strictly greater than any real entry must be NotFound.
    let bogus_seq = real.seq + 1_000_000;
    let result = compute_reverse(&pool, TEST_DEVICE, bogus_seq).await;
    match result {
        Err(AppError::NotFound(msg)) => {
            // The message must reference the (device, seq) pair so a
            // support session has something to grep for.
            assert!(
                msg.contains(TEST_DEVICE) && msg.contains(&bogus_seq.to_string()),
                "NotFound message must include device + seq; got: {msg:?}"
            );
        }
        other => panic!("expected NotFound for missing seq, got: {other:?}"),
    }
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
        "2025-01-15T12:01:00Z",
    )
    .await;
    let rev1 = compute_reverse(&pool, TEST_DEVICE, edit.seq).await.unwrap();
    match &rev1 {
        OpPayload::EditBlock(p) => assert_eq!(p.to_text, "original"),
        other => panic!("Expected EditBlock, got {:?}", other),
    }
    let undo_op = append_op(&pool, rev1, "2025-01-15T12:02:00Z").await;
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
        "2025-01-15T12:01:00Z",
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
    let undo_op = append_op(&pool, rev1, "2025-01-15T12:02:00Z").await;
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
    let delete_op = append_op(&pool, rev1, "2025-01-15T12:01:00Z").await;
    let rev2 = compute_reverse(&pool, TEST_DEVICE, delete_op.seq)
        .await
        .unwrap();
    assert!(matches!(&rev2, OpPayload::RestoreBlock(p) if p.block_id == "BLK_UC3"));
    let restore_op = append_op(&pool, rev2, "2025-01-15T12:02:00Z").await;
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
        "2025-01-15T12:01:00Z",
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
        "2025-01-15T12:01:00Z",
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
    let same_ts = "2025-01-15T12:01:00Z";
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
        "2025-01-15T12:01:00Z".to_owned(),
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
            attachment_id: BlockId::test_id("ATT_001"),
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
            attachment_id: BlockId::test_id("ATT_001"),
            fs_path: "attachments/att_001.bin".into(),
        }),
        "2025-01-15T12:01:00Z",
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
            attachment_id: BlockId::test_id("ATT_ORPHAN"),
            fs_path: "attachments/orphan.bin".into(),
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
            attachment_id: BlockId::test_id("ATT_RT"),
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
    let del_rec = append_op(&pool, rev1, "2025-01-15T12:01:00Z").await;
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
        "2025-01-15T12:00:00Z",
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
        "2025-01-15T12:01:00Z",
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
        "2025-01-15T12:00:00Z",
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("BLK_TS3"),
            key: "todo_state".into(),
        }),
        "2025-01-15T12:01:00Z",
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
        "2025-01-15T12:00:00Z",
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
        "2025-01-15T12:01:00Z",
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
        "2025-01-15T12:00:00Z",
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
        "2025-01-15T12:01:00Z",
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
        "2025-01-15T12:00:00Z",
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
        "2025-01-15T12:01:00Z",
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
        OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("2025-06-15".into())),
        other => panic!("Expected SetProperty, got {:?}", other),
    }
}

// ──────────────────────────────────────────────────────────────────────
// I-Lifecycle-3 — oracle-parity round-trip tests for ops whose
// existing reverse tests only assert the returned `OpPayload` variant
// (e.g. `assert!(matches!(reverse, OpPayload::DeleteBlock(_) ...))`).
//
// Variant-only assertions cannot detect a regression that emits the
// right enum variant with wrong field values, and they never exercise
// the apply→reverse→apply round-trip against the materialized
// database. The tests below mirror the structure of
// `undo_chain_*_round_trip` (above), but extend it: they actually
// apply both the original op and its computed reverse via the
// `Materializer` and assert that the affected materialized rows
// return to the pre-original snapshot. This is the contract the
// variant-only tests miss.
// ──────────────────────────────────────────────────────────────────────

/// Snapshot of one row in the `blocks` table. Used by the
/// `*_apply_then_reverse_round_trip_i_lifecycle_3` tests below to
/// compare the post-reverse state against the pre-original state.
#[derive(Debug, Clone, PartialEq, Eq)]
struct BlockRow {
    id: String,
    block_type: String,
    content: Option<String>,
    parent_id: Option<String>,
    position: Option<i64>,
    deleted_at: Option<String>,
}

async fn snapshot_blocks(pool: &SqlitePool) -> Vec<BlockRow> {
    use sqlx::Row;
    sqlx::query(
        "SELECT id, block_type, content, parent_id, position, deleted_at \
         FROM blocks ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| BlockRow {
        id: r.get::<String, _>("id"),
        block_type: r.get::<String, _>("block_type"),
        content: r.get::<Option<String>, _>("content"),
        parent_id: r.get::<Option<String>, _>("parent_id"),
        position: r.get::<Option<i64>, _>("position"),
        deleted_at: r.get::<Option<String>, _>("deleted_at"),
    })
    .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlockTagRow {
    block_id: String,
    tag_id: String,
}

async fn snapshot_block_tags(pool: &SqlitePool) -> Vec<BlockTagRow> {
    use sqlx::Row;
    sqlx::query("SELECT block_id, tag_id FROM block_tags ORDER BY block_id, tag_id")
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .map(|r| BlockTagRow {
            block_id: r.get::<String, _>("block_id"),
            tag_id: r.get::<String, _>("tag_id"),
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AttachmentRow {
    id: String,
    block_id: String,
    filename: String,
    fs_path: String,
    mime_type: String,
    size_bytes: i64,
}

async fn snapshot_attachments(pool: &SqlitePool) -> Vec<AttachmentRow> {
    use sqlx::Row;
    sqlx::query(
        "SELECT id, block_id, filename, fs_path, mime_type, size_bytes \
         FROM attachments ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
    .into_iter()
    .map(|r| AttachmentRow {
        id: r.get::<String, _>("id"),
        block_id: r.get::<String, _>("block_id"),
        filename: r.get::<String, _>("filename"),
        fs_path: r.get::<String, _>("fs_path"),
        mime_type: r.get::<String, _>("mime_type"),
        size_bytes: r.get::<i64, _>("size_bytes"),
    })
    .collect()
}

/// I-Lifecycle-3 — strict round-trip parity for `create_block`.
///
/// The pre-existing `reverse_create_block_produces_delete_block` test
/// only checks that `compute_reverse` returns the `DeleteBlock`
/// variant for the same `block_id`. It does not verify that applying
/// the reverse op restores the database to the pre-original state.
/// This test extends the contract: snapshot `blocks` empty → apply
/// `CreateBlock` → snapshot post-original → apply `compute_reverse(...)`
/// → snapshot post-reverse → assert post-reverse equals the empty
/// pre-state.
///
/// **CURRENTLY FAILS — known design divergence (not a code bug).**
///
/// `compute_reverse(create_block)` returns `DeleteBlock`, and the
/// materializer's `delete_block` arm is a **soft-delete** (sets
/// `deleted_at = record.created_at` rather than removing the row).
/// After `CreateBlock` + `DeleteBlock` the block row persists in
/// `blocks` with `deleted_at IS NOT NULL`, so strict equality with
/// the pre-state (zero rows) cannot hold. A true identity round-trip
/// would require `compute_reverse(create_block)` to emit `PurgeBlock`
/// (hard delete), but `PurgeBlock` is intentionally `NonReversible`
/// and the user-facing undo contract preserves the tombstone for
/// op-log convergence (sync replays must observe a deterministic
/// sequence; a hard delete would lose the create→delete history).
///
/// This is a documented design choice, not a regression to fix in
/// I-Lifecycle-3 scope. `#[ignore]` mirrors the I-Search-5 pattern
/// (see `tag_query/resolve/tests.rs`): the failing test is preserved
/// so the divergence is greppable and self-documenting, and so the
/// next maintainer revisiting undo semantics has a concrete oracle
/// to test against.
#[tokio::test]
#[ignore = "I-Lifecycle-3: strict round-trip cannot hold for create_block — \
    reverse is DeleteBlock (soft-delete) which leaves a tombstone in `blocks`; \
    a true identity round-trip would require PurgeBlock which is intentionally NonReversible. \
    Test preserved as an oracle for any future change to undo semantics."]
async fn create_block_apply_then_reverse_round_trip_i_lifecycle_3() {
    use crate::materializer::Materializer;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let pre_state = snapshot_blocks(&pool).await;
    assert!(pre_state.is_empty(), "pre-state must be empty");

    let create_payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id("BLK_RT_CB"),
        block_type: "content".into(),
        parent_id: None,
        position: Some(1),
        content: "round-trip create".into(),
    });
    let create_rec = append_op(&pool, create_payload, "2025-01-15T12:00:00Z").await;
    mat.dispatch_op(&create_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_original = snapshot_blocks(&pool).await;
    assert_eq!(post_original.len(), 1, "block must exist after CreateBlock");

    let reverse = compute_reverse(&pool, TEST_DEVICE, create_rec.seq)
        .await
        .unwrap();
    let reverse_rec = append_op(&pool, reverse, "2025-01-15T12:01:00Z").await;
    mat.dispatch_op(&reverse_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_reverse = snapshot_blocks(&pool).await;
    assert_eq!(
        post_reverse, pre_state,
        "post-reverse `blocks` must equal pre-original (empty); divergence: {post_reverse:?}"
    );
}

/// I-Lifecycle-3 — strict round-trip parity for `add_tag`.
///
/// The pre-existing `reverse_add_tag_produces_remove_tag` test only
/// checks that `compute_reverse` returns the `RemoveTag` variant
/// with the same `(block_id, tag_id)`. This test extends the
/// contract: pre-snapshot `block_tags` (no row) → apply `AddTag` →
/// post-original (one row) → apply `compute_reverse(...)` =
/// `RemoveTag` → post-reverse must equal pre-state (no row).
#[tokio::test]
async fn add_tag_apply_then_reverse_round_trip_i_lifecycle_3() {
    use crate::materializer::Materializer;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Seed the target and tag blocks so foreign keys in `block_tags`
    // are satisfied. `apply_op(AddTag)` calls
    // `tag_inheritance::propagate_tag_to_descendants`; with no
    // children the only mutation is the `block_tags` row itself.
    let block_id = BlockId::test_id("BLK_RT_AT");
    let tag_id = BlockId::test_id("TAG_RT_AT");
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'b'), (?, 'tag', 't')",
    )
    .bind(block_id.as_str())
    .bind(tag_id.as_str())
    .execute(&pool)
    .await
    .unwrap();

    let pre_state = snapshot_block_tags(&pool).await;
    assert!(pre_state.is_empty(), "pre-state must have no tag links");

    let add_payload = OpPayload::AddTag(AddTagPayload {
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
    });
    let add_rec = append_op(&pool, add_payload, "2025-01-15T12:00:00Z").await;
    mat.dispatch_op(&add_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_original = snapshot_block_tags(&pool).await;
    assert_eq!(
        post_original.len(),
        1,
        "block_tags row must exist after AddTag"
    );

    let reverse = compute_reverse(&pool, TEST_DEVICE, add_rec.seq)
        .await
        .unwrap();
    let reverse_rec = append_op(&pool, reverse, "2025-01-15T12:01:00Z").await;
    mat.dispatch_op(&reverse_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_reverse = snapshot_block_tags(&pool).await;
    assert_eq!(
        post_reverse, pre_state,
        "post-reverse `block_tags` must equal pre-original (empty); divergence: {post_reverse:?}"
    );
}

/// I-Lifecycle-3 — strict round-trip parity for `remove_tag`.
///
/// The pre-existing `reverse_remove_tag_produces_add_tag` test only
/// checks the returned variant. This test seeds an existing tag
/// link, applies `RemoveTag`, then applies `compute_reverse(...)` =
/// `AddTag`, and asserts the original `(block_id, tag_id)` row is
/// restored verbatim.
#[tokio::test]
async fn remove_tag_apply_then_reverse_round_trip_i_lifecycle_3() {
    use crate::materializer::Materializer;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let block_id = BlockId::test_id("BLK_RT_RT");
    let tag_id = BlockId::test_id("TAG_RT_RT");
    // Seed both blocks and the existing tag link so RemoveTag has
    // something to delete.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'b'), (?, 'tag', 't')",
    )
    .bind(block_id.as_str())
    .bind(tag_id.as_str())
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id.as_str())
        .bind(tag_id.as_str())
        .execute(&pool)
        .await
        .unwrap();

    let pre_state = snapshot_block_tags(&pool).await;
    assert_eq!(pre_state.len(), 1, "pre-state must have one tag link");

    let remove_payload = OpPayload::RemoveTag(RemoveTagPayload {
        block_id: block_id.clone(),
        tag_id: tag_id.clone(),
    });
    let remove_rec = append_op(&pool, remove_payload, "2025-01-15T12:00:00Z").await;
    mat.dispatch_op(&remove_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_original = snapshot_block_tags(&pool).await;
    assert!(
        post_original.is_empty(),
        "block_tags row must be gone after RemoveTag"
    );

    let reverse = compute_reverse(&pool, TEST_DEVICE, remove_rec.seq)
        .await
        .unwrap();
    let reverse_rec = append_op(&pool, reverse, "2025-01-15T12:01:00Z").await;
    mat.dispatch_op(&reverse_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_reverse = snapshot_block_tags(&pool).await;
    assert_eq!(
        post_reverse, pre_state,
        "post-reverse `block_tags` must equal pre-original; divergence: {post_reverse:?}"
    );
}

/// I-Lifecycle-3 — strict round-trip parity for `add_attachment`.
///
/// The pre-existing `reverse_add_attachment_produces_delete_attachment`
/// test only checks the returned variant. This test pre-snapshots
/// `attachments` (empty), applies `AddAttachment`, snapshots the
/// post-original (one row), then applies `compute_reverse(...)` =
/// `DeleteAttachment` (a hard delete in
/// `materializer::handlers::apply_op_tx`) and asserts the
/// `attachments` table returns to empty.
#[tokio::test]
async fn add_attachment_apply_then_reverse_round_trip_i_lifecycle_3() {
    use crate::materializer::Materializer;
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Seed the host block so the FK from `attachments.block_id` is
    // satisfied when `apply_op(AddAttachment)` inserts the row.
    let host_block = BlockId::test_id("BLK_RT_AA");
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'host')")
        .bind(host_block.as_str())
        .execute(&pool)
        .await
        .unwrap();

    let pre_state = snapshot_attachments(&pool).await;
    assert!(pre_state.is_empty(), "pre-state must have no attachments");

    let attachment_id = BlockId::test_id("ATT_RT_AA");
    let add_payload = OpPayload::AddAttachment(AddAttachmentPayload {
        attachment_id: attachment_id.clone(),
        block_id: host_block.clone(),
        mime_type: "image/png".into(),
        filename: "rt.png".into(),
        size_bytes: 4096,
        fs_path: "attachments/rt.png".into(),
    });
    let add_rec = append_op(&pool, add_payload, "2025-01-15T12:00:00Z").await;
    mat.dispatch_op(&add_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_original = snapshot_attachments(&pool).await;
    assert_eq!(
        post_original.len(),
        1,
        "attachments row must exist after AddAttachment"
    );

    let reverse = compute_reverse(&pool, TEST_DEVICE, add_rec.seq)
        .await
        .unwrap();
    let reverse_rec = append_op(&pool, reverse, "2025-01-15T12:01:00Z").await;
    mat.dispatch_op(&reverse_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_reverse = snapshot_attachments(&pool).await;
    assert_eq!(
        post_reverse, pre_state,
        "post-reverse `attachments` must equal pre-original (empty); divergence: {post_reverse:?}"
    );
}

/// M-71 pinning test: `compute_reverse(restore_block)` discards the
/// original `RestoreBlockPayload::deleted_at_ref` and produces a bare
/// `DeleteBlock(block_id)`. A subsequent `cascade_soft_delete`
/// therefore mints a fresh `deleted_at` distinct from the original
/// cascade group's timestamp.
///
/// This pins the current behaviour described in the doc comment on
/// `reverse_restore_block` in `reverse/block_ops.rs`. If a future
/// contributor extends the op payload to carry `deleted_at_ref`
/// through the reverse (with explicit user approval per
/// Architectural Stability), the `assert_ne!` below will need to flip
/// to `assert_eq!`, and the doc comment must be updated in lockstep.
#[tokio::test]
async fn compute_reverse_restore_discards_deleted_at_ref_m71() {
    let (pool, _dir) = test_pool().await;

    // Seed a block in the `blocks` table so cascade_soft_delete /
    // restore_block have a target. Direct SQL mirrors the inline
    // pattern used by `add_attachment_apply_then_reverse_round_trip_*`
    // earlier in this file; we are not using the materializer here.
    let block_id = "BLKM71";
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', 'm71 fixture', NULL, 1)",
    )
    .bind(block_id)
    .execute(&pool)
    .await
    .unwrap();

    // Step 1: cascade_soft_delete records the original `deleted_at_a`.
    let (deleted_at_a, _count_a) =
        crate::soft_delete::cascade_soft_delete(&pool, TEST_DEVICE, block_id)
            .await
            .unwrap();

    // Step 2: restore so the block is alive again, then append a
    // RestoreBlock op carrying `deleted_at_a` so we have a record to
    // feed into compute_reverse.
    crate::soft_delete::restore_block(&pool, block_id, &deleted_at_a)
        .await
        .unwrap();
    let restore_rec = append_op(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id(block_id),
            deleted_at_ref: deleted_at_a.clone(),
        }),
        FIXED_TS,
    )
    .await;

    // Step 3: compute the reverse. M-71: it must be bare DeleteBlock —
    // `deleted_at_ref` is intentionally NOT propagated.
    let reverse = compute_reverse(&pool, TEST_DEVICE, restore_rec.seq)
        .await
        .unwrap();
    assert!(
        matches!(&reverse, OpPayload::DeleteBlock(p) if p.block_id == block_id),
        "M-71: reverse(RestoreBlock) must be bare DeleteBlock(block_id); got: {reverse:?}"
    );

    // Sleep ≥1ms so the second cascade's millisecond-precision
    // timestamp is guaranteed to differ from `deleted_at_a` (matches
    // the pattern in `soft_delete::tests::cascade_soft_delete_skips_already_deleted_subtree`).
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    // Step 4: apply the reverse — equivalent to what the redo path
    // does in production — and capture the new `deleted_at_b`.
    let (deleted_at_b, _count_b) =
        crate::soft_delete::cascade_soft_delete(&pool, TEST_DEVICE, block_id)
            .await
            .unwrap();

    // The asymmetry: the reverse did not carry `deleted_at_ref`
    // through, so the new timestamp is distinct from the original
    // cascade group's timestamp.
    assert_ne!(
        deleted_at_a, deleted_at_b,
        "M-71: reverse(RestoreBlock) does not propagate deleted_at_ref, \
         so a subsequent cascade_soft_delete mints a fresh deleted_at. \
         If this assertion ever flips to equal, update the doc comment \
         on `reverse_restore_block` in `reverse/block_ops.rs` to match \
         the new behaviour."
    );
}
