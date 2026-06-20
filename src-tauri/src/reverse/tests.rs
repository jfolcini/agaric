use super::*;
use crate::db::init_pool;
use crate::op::*;
use crate::op_log::append_local_op_at;
use crate::ulid::BlockId;
use std::path::PathBuf;
use tempfile::TempDir;

const FIXED_TS: i64 = 1_736_942_400_000;
const TEST_DEVICE: &str = "test-device";

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

async fn append_op(pool: &SqlitePool, payload: OpPayload, ts: i64) -> crate::op_log::OpRecord {
    append_local_op_at(pool, TEST_DEVICE, payload, ts)
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
        index: None,
        content: "hello".into(),
    });
    let rec = append_op(&pool, create, FIXED_TS).await;
    let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
    assert!(matches!(reverse, OpPayload::DeleteBlock(ref p) if p.block_id == "BLK1"));
}
#[tokio::test]
async fn reverse_delete_block_produces_restore_block_with_deleted_at() {
    let (pool, _dir) = test_pool().await;
    let delete_ts: i64 = 1_736_946_000_000;
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
            index: None,
            content: "original".into(),
        }),
        1_736_942_400_000,
    )
    .await;
    append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK3"),
            to_text: "first edit".into(),
            prev_edit: None,
        }),
        1_736_942_460_000,
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK3"),
            to_text: "second edit".into(),
            prev_edit: None,
        }),
        1_736_942_520_000,
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
/// #1526: undo of an edit must restore the text of its CAUSAL predecessor
/// (`EditBlockPayload::prev_edit`), NOT the ancestor that merely happens to be
/// nearest in `(created_at, seq, device_id)` order. The two disagree under
/// cross-device clock skew, where a concurrent edit from another device lands
/// with a `created_at` BETWEEN the causal predecessor and the edit being
/// undone — `find_prior_text`'s timestamp scan would (wrongly) return that
/// intruder.
///
/// Scenario (same block, two devices, skewed clocks):
///   * `device-a` creates the block ("v0")           @ ts = T+0   (a, seq 1)
///   * `device-a` edits to "CORRECT-causal-prev"      @ ts = T+5   (a, seq 2)
///   * `device-b` edits to "WRONG-intruder"           @ ts = T+8   (b, seq 1)
///   * `device-b` edits to "latest", prev_edit=(a,2)  @ ts = T+10  (b, seq 2)
///
/// Undoing the last edit must restore "CORRECT-causal-prev" (its prev_edit
/// target), even though `find_prior_text` ordered by `(created_at, seq,
/// device_id)` would return "WRONG-intruder" (ts T+8 is the greatest key
/// strictly before T+10). The fix follows `prev_edit`; this test pins it.
#[tokio::test]
async fn reverse_edit_follows_prev_edit_not_timestamp_under_skew_1526() {
    let (pool, _dir) = test_pool().await;
    const DEV_A: &str = "device-a";
    const DEV_B: &str = "device-b";
    let blk = BlockId::test_id("SKEWBLK");

    // (a, seq 1) create "v0".
    append_local_op_at(
        &pool,
        DEV_A,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: blk.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "v0".into(),
        }),
        FIXED_TS,
    )
    .await
    .unwrap();

    // (a, seq 2) edit to the CAUSAL predecessor text @ T+5.
    let prev = append_local_op_at(
        &pool,
        DEV_A,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: blk.clone(),
            to_text: "CORRECT-causal-prev".into(),
            prev_edit: Some((DEV_A.to_string(), 1)),
        }),
        FIXED_TS + 5,
    )
    .await
    .unwrap();
    assert_eq!(prev.seq, 2, "sanity: causal predecessor is (a, seq 2)");

    // (b, seq 1) concurrent INTRUDER edit @ T+8 — different device, NOT the
    // causal predecessor, but its timestamp sits between prev and the undo
    // target, so the timestamp scan would pick it.
    append_local_op_at(
        &pool,
        DEV_B,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: blk.clone(),
            to_text: "WRONG-intruder".into(),
            prev_edit: None,
        }),
        FIXED_TS + 8,
    )
    .await
    .unwrap();

    // (b, seq 2) the edit we will undo @ T+10; prev_edit points at (a, 2).
    let undo_target = append_local_op_at(
        &pool,
        DEV_B,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: blk.clone(),
            to_text: "latest".into(),
            prev_edit: Some((DEV_A.to_string(), 2)),
        }),
        FIXED_TS + 10,
    )
    .await
    .unwrap();

    // Sanity: the timestamp-ordered scan WOULD return the intruder — proving the
    // disagreement is real and the prev_edit branch is load-bearing.
    let by_timestamp = find_prior_text(
        &pool,
        blk.as_str(),
        undo_target.created_at,
        undo_target.seq,
        &undo_target.device_id,
    )
    .await
    .unwrap();
    assert_eq!(
        by_timestamp.as_deref(),
        Some("WRONG-intruder"),
        "sanity: the (created_at, seq, device_id) scan returns the intruder, \
         so following prev_edit must override it"
    );

    // The reverse must restore the CAUSAL predecessor's text, via prev_edit.
    let reverse = compute_reverse(&pool, DEV_B, undo_target.seq)
        .await
        .unwrap();
    match reverse {
        OpPayload::EditBlock(ref p) => assert_eq!(
            p.to_text, "CORRECT-causal-prev",
            "#1526: undo must restore the prev_edit target, not the \
             timestamp-nearest intruder"
        ),
        other => panic!("expected EditBlock, got {other:?}"),
    }
}

/// #1526: when `prev_edit` is `None` (e.g. legacy ops), the reverse falls back
/// to the timestamp-ordered `find_prior_text` — the pre-fix behaviour is
/// preserved for ops that carry no causal pointer.
#[tokio::test]
async fn reverse_edit_falls_back_to_timestamp_when_prev_edit_none_1526() {
    let (pool, _dir) = test_pool().await;
    append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("FALLBK"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "v0".into(),
        }),
        FIXED_TS,
    )
    .await;
    append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("FALLBK"),
            to_text: "prior".into(),
            prev_edit: None,
        }),
        FIXED_TS + 5,
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("FALLBK"),
            to_text: "latest".into(),
            prev_edit: None,
        }),
        FIXED_TS + 10,
    )
    .await;
    let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
    match reverse {
        OpPayload::EditBlock(ref p) => assert_eq!(
            p.to_text, "prior",
            "prev_edit=None falls back to the timestamp-nearest prior op"
        ),
        other => panic!("expected EditBlock, got {other:?}"),
    }
}

/// #1526: a dangling `prev_edit` (its op removed by op-log compaction) falls
/// back to `find_prior_text` rather than erroring out — the timestamp scan is
/// the best remaining reconstruction.
#[tokio::test]
async fn reverse_edit_dangling_prev_edit_falls_back_to_timestamp_1526() {
    let (pool, _dir) = test_pool().await;
    append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("DANGLE"),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "v0".into(),
        }),
        FIXED_TS,
    )
    .await;
    // The edit we undo references a NON-EXISTENT prev_edit (device, seq 999).
    let rec = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("DANGLE"),
            to_text: "latest".into(),
            prev_edit: Some((TEST_DEVICE.to_string(), 999)),
        }),
        FIXED_TS + 10,
    )
    .await;
    let reverse = compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap();
    match reverse {
        OpPayload::EditBlock(ref p) => assert_eq!(
            p.to_text, "v0",
            "dangling prev_edit falls back to the timestamp-nearest prior op (the create)"
        ),
        other => panic!("expected EditBlock, got {other:?}"),
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
            index: None,
            content: "from create".into(),
        }),
        1_736_942_400_000,
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK4"),
            to_text: "edited".into(),
            prev_edit: None,
        }),
        1_736_942_460_000,
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
            index: None,
            content: "test".into(),
        }),
        1_736_942_400_000,
    )
    .await;
    append_op(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK5"),
            new_parent_id: Some(BlockId::test_id("P2")),
            new_position: 3,
            new_index: None,
        }),
        1_736_942_460_000,
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK5"),
            new_parent_id: Some(BlockId::test_id("P3")),
            new_position: 5,
            new_index: None,
        }),
        1_736_942_520_000,
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
            index: None,
            content: "test".into(),
        }),
        1_736_942_400_000,
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK6"),
            new_parent_id: Some(BlockId::test_id("OTHER")),
            new_position: 7,
            new_index: None,
        }),
        1_736_942_460_000,
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
/// An ancient `create_block` payload with `position = None`
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
            index: None,
            content: "ancient".into(),
        }),
        1_736_942_400_000,
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::MoveBlock(MoveBlockPayload {
            block_id: BlockId::test_id("BLK6NP"),
            new_parent_id: Some(BlockId::test_id("OTHERNP")),
            new_position: 7,
            new_index: None,
        }),
        1_736_942_460_000,
    )
    .await;
    let result = compute_reverse(&pool, TEST_DEVICE, rec.seq).await;
    assert!(
        matches!(
            result,
            Err(AppError::NonReversible { ref op_type }) if op_type == "move_block"
        ),
        "reverse of move_block must be NonReversible when the \
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
            value_bool: None,
        }),
        1_736_942_400_000,
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
            value_bool: None,
        }),
        1_736_942_460_000,
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
            value_bool: None,
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
            value_bool: None,
        }),
        1_736_942_400_000,
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("BLK10"),
            key: "color".into(),
        }),
        1_736_942_460_000,
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
            deleted_at_ref: 1_736_935_200_000,
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
            new_index: None,
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
/// With a populated `op_log`, calling `compute_reverse` on a
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
            index: None,
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
            index: None,
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
        1_736_942_460_000,
    )
    .await;
    let rev1 = compute_reverse(&pool, TEST_DEVICE, edit.seq).await.unwrap();
    match &rev1 {
        OpPayload::EditBlock(p) => assert_eq!(p.to_text, "original"),
        other => panic!("Expected EditBlock, got {other:?}"),
    }
    let undo_op = append_op(&pool, rev1, 1_736_942_520_000).await;
    let rev2 = compute_reverse(&pool, TEST_DEVICE, undo_op.seq)
        .await
        .unwrap();
    match &rev2 {
        OpPayload::EditBlock(p) => assert_eq!(p.to_text, "modified"),
        other => panic!("Expected EditBlock, got {other:?}"),
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
            index: None,
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
            new_index: None,
        }),
        1_736_942_460_000,
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
        other => panic!("Expected MoveBlock, got {other:?}"),
    }
    let undo_op = append_op(&pool, rev1, 1_736_942_520_000).await;
    let rev2 = compute_reverse(&pool, TEST_DEVICE, undo_op.seq)
        .await
        .unwrap();
    match &rev2 {
        OpPayload::MoveBlock(p) => {
            assert_eq!(p.new_parent_id, Some(BlockId::test_id("PAGE2")));
            assert_eq!(p.new_position, 5);
        }
        other => panic!("Expected MoveBlock, got {other:?}"),
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
            index: None,
            content: "ephemeral".into(),
        }),
        FIXED_TS,
    )
    .await;
    let rev1 = compute_reverse(&pool, TEST_DEVICE, create.seq)
        .await
        .unwrap();
    assert!(matches!(&rev1, OpPayload::DeleteBlock(p) if p.block_id == "BLK_UC3"));
    let delete_op = append_op(&pool, rev1, 1_736_942_460_000).await;
    let rev2 = compute_reverse(&pool, TEST_DEVICE, delete_op.seq)
        .await
        .unwrap();
    assert!(matches!(&rev2, OpPayload::RestoreBlock(p) if p.block_id == "BLK_UC3"));
    let restore_op = append_op(&pool, rev2, 1_736_942_520_000).await;
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
            value_bool: None,
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
            value_bool: None,
        }),
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, set2.seq).await.unwrap() {
        OpPayload::SetProperty(p) => assert_eq!(p.value_num, Some(42.0)),
        other => panic!("Expected SetProperty, got {other:?}"),
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
            value_bool: None,
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
            value_bool: None,
        }),
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, set2.seq).await.unwrap() {
        OpPayload::SetProperty(p) => assert_eq!(p.value_date, Some("2025-06-15".into())),
        other => panic!("Expected SetProperty, got {other:?}"),
    }
}
/// Regression: reversing a `set_property` whose prior op was a
/// boolean must restore the prior `value_bool`. Without this, the rebuilt
/// payload would have all-None typed values, failing
/// `validate_set_property` with a count == 0 error.
#[tokio::test]
async fn reverse_set_property_value_bool() {
    let (pool, _dir) = test_pool().await;
    let set1 = append_op(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK_PB"),
            key: "flag".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: Some(true),
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
            block_id: BlockId::test_id("BLK_PB"),
            key: "flag".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: Some(false),
        }),
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, set2.seq).await.unwrap() {
        OpPayload::SetProperty(p) => {
            assert_eq!(p.value_bool, Some(true));
            assert!(p.value_text.is_none());
            assert!(p.value_num.is_none());
            assert!(p.value_date.is_none());
            assert!(p.value_ref.is_none());
        }
        other => panic!("Expected SetProperty, got {other:?}"),
    }
}
/// Regression: reversing a `delete_property` whose prior op was a
/// boolean must restore the prior `value_bool` so the redo path emits a
/// valid `SetProperty` payload (exactly-one-value).
#[tokio::test]
async fn reverse_delete_property_restores_value_bool() {
    let (pool, _dir) = test_pool().await;
    append_op(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK_PBD"),
            key: "flag".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: Some(true),
        }),
        FIXED_TS,
    )
    .await;
    let del = append_op(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("BLK_PBD"),
            key: "flag".into(),
        }),
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, del.seq).await.unwrap() {
        OpPayload::SetProperty(p) => assert_eq!(p.value_bool, Some(true)),
        other => panic!("Expected SetProperty, got {other:?}"),
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
            index: None,
            content: "v0".into(),
        }),
        FIXED_TS,
    )
    .await;
    let same_ts: i64 = 1_736_942_460_000;
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
        other => panic!("Expected EditBlock, got {other:?}"),
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
            index: None,
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
        1_736_942_460_000,
    )
    .await
    .unwrap();
    let reverse = compute_reverse(&pool, dev_b, edit_b.seq).await.unwrap();
    match reverse {
        OpPayload::EditBlock(ref p) => {
            assert_eq!(p.to_text, "original");
            let (dev, seq) = p.prev_edit.as_ref().unwrap();
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
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, del.seq).await.unwrap() {
        OpPayload::AddAttachment(p) => {
            assert_eq!(p.attachment_id, "ATT_001");
            assert_eq!(p.block_id, "BLK_ATT");
        }
        other => panic!("Expected AddAttachment, got {other:?}"),
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
    let del_rec = append_op(&pool, rev1, 1_736_942_460_000).await;
    match compute_reverse(&pool, TEST_DEVICE, del_rec.seq)
        .await
        .unwrap()
    {
        OpPayload::AddAttachment(p) => assert_eq!(p.attachment_id, "ATT_RT"),
        other => panic!("Expected AddAttachment, got {other:?}"),
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
            value_bool: None,
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
            value_bool: None,
        }),
        1_736_942_400_000,
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
            value_bool: None,
        }),
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
        OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("TODO".into())),
        other => panic!("Expected SetProperty, got {other:?}"),
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
            value_bool: None,
        }),
        1_736_942_400_000,
    )
    .await;
    let rec = append_op(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: BlockId::test_id("BLK_TS3"),
            key: "todo_state".into(),
        }),
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
        OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("DOING".into())),
        other => panic!("Expected SetProperty, got {other:?}"),
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
            value_bool: None,
        }),
        1_736_942_400_000,
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
            value_bool: None,
        }),
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
        OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("A".into())),
        other => panic!("Expected SetProperty, got {other:?}"),
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
            value_bool: None,
        }),
        1_736_942_400_000,
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
            value_bool: None,
        }),
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
        OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("2025-06-15".into())),
        other => panic!("Expected SetProperty, got {other:?}"),
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
            value_bool: None,
        }),
        1_736_942_400_000,
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
            value_bool: None,
        }),
        1_736_942_460_000,
    )
    .await;
    match compute_reverse(&pool, TEST_DEVICE, rec.seq).await.unwrap() {
        OpPayload::SetProperty(p) => assert_eq!(p.value_text, Some("2025-06-15".into())),
        other => panic!("Expected SetProperty, got {other:?}"),
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
    deleted_at: Option<i64>,
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
        deleted_at: r.get::<Option<i64>, _>("deleted_at"),
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
        index: None,
        content: "round-trip create".into(),
    });
    let create_rec = append_op(&pool, create_payload, 1_736_942_400_000).await;
    mat.dispatch_op(&create_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_original = snapshot_blocks(&pool).await;
    assert_eq!(post_original.len(), 1, "block must exist after CreateBlock");

    let reverse = compute_reverse(&pool, TEST_DEVICE, create_rec.seq)
        .await
        .unwrap();
    let reverse_rec = append_op(&pool, reverse, 1_736_942_460_000).await;
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
    let add_rec = append_op(&pool, add_payload, 1_736_942_400_000).await;
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
    let reverse_rec = append_op(&pool, reverse, 1_736_942_460_000).await;
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
    let remove_rec = append_op(&pool, remove_payload, 1_736_942_400_000).await;
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
    let reverse_rec = append_op(&pool, reverse, 1_736_942_460_000).await;
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
    let add_rec = append_op(&pool, add_payload, 1_736_942_400_000).await;
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
    let reverse_rec = append_op(&pool, reverse, 1_736_942_460_000).await;
    mat.dispatch_op(&reverse_rec).await.unwrap();
    mat.flush().await.unwrap();

    let post_reverse = snapshot_attachments(&pool).await;
    assert_eq!(
        post_reverse, pre_state,
        "post-reverse `attachments` must equal pre-original (empty); divergence: {post_reverse:?}"
    );
}

/// Pinning test: `compute_reverse(restore_block)` discards the
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
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compute_reverse_restore_discards_deleted_at_ref_m71() {
    let (pool, _dir) = test_pool().await;
    // SQL-review `cascade_soft_delete` / `restore_block` now take
    // `&Materializer` so cache-invalidation dispatch is type-system-
    // enforced. The dispatched tasks are background fire-and-forget;
    // we don't await them here because this test only asserts the
    // op-log shape, not cache state.
    let mat = crate::materializer::Materializer::new(pool.clone());

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
        crate::soft_delete::cascade_soft_delete(&pool, &mat, TEST_DEVICE, block_id)
            .await
            .unwrap();

    // Step 2: restore so the block is alive again, then append a
    // RestoreBlock op carrying `deleted_at_a` so we have a record to
    // feed into compute_reverse.
    crate::soft_delete::restore_block(&pool, &mat, block_id, deleted_at_a)
        .await
        .unwrap();
    let restore_rec = append_op(
        &pool,
        OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::test_id(block_id),
            deleted_at_ref: deleted_at_a,
        }),
        FIXED_TS,
    )
    .await;

    // Step 3: compute the reverse. it must be bare DeleteBlock —
    // `deleted_at_ref` is intentionally NOT propagated.
    let reverse = compute_reverse(&pool, TEST_DEVICE, restore_rec.seq)
        .await
        .unwrap();
    assert!(
        matches!(&reverse, OpPayload::DeleteBlock(p) if p.block_id == block_id),
        "reverse(RestoreBlock) must be bare DeleteBlock(block_id); got: {reverse:?}"
    );

    // Sleep ≥1ms so the second cascade's millisecond-precision
    // timestamp is guaranteed to differ from `deleted_at_a` (matches
    // the pattern in `soft_delete::tests::cascade_soft_delete_skips_already_deleted_subtree`).
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    // Step 4: apply the reverse — equivalent to what the redo path
    // does in production — and capture the new `deleted_at_b`.
    let (deleted_at_b, _count_b) =
        crate::soft_delete::cascade_soft_delete(&pool, &mat, TEST_DEVICE, block_id)
            .await
            .unwrap();

    // The asymmetry: the reverse did not carry `deleted_at_ref`
    // through, so the new timestamp is distinct from the original
    // cascade group's timestamp.
    assert_ne!(
        deleted_at_a, deleted_at_b,
        "reverse(RestoreBlock) does not propagate deleted_at_ref, \
         so a subsequent cascade_soft_delete mints a fresh deleted_at. \
         If this assertion ever flips to equal, update the doc comment \
         on `reverse_restore_block` in `reverse/block_ops.rs` to match \
         the new behaviour."
    );
}

// ──────────────────────────────────────────────────────────────────────
// AGENTS.md "Undo/reverse testing" invariants
//
// Pins two contract-level properties of the batch reverse path
// (`revert_ops_inner` in `commands/history.rs` — the function the
// Undo stack actually calls; `compute_reverse` is its single-op
// building block):
//
//   (a) batch-ordering is newest-first by (created_at DESC, seq DESC)
//       — the tie-break on `seq` when `created_at` is identical must
//       hold so a local burst of ops reverses in LIFO order;
//   (b) the op_log is append-only (invariant #1): a revert appends
//       exactly one new op per input and leaves the original row
//       untouched.
//
// Both behaviours are already exercised end-to-end by tests in
// `commands/tests/undo_redo_tests.rs`, but those tests cover the
// full command stack (create_block_inner / edit_block_inner /
// Materializer). The two tests below pin the same invariants at
// this module's level using the bare-pool idioms that dominate
// `reverse/tests.rs` (`append_local_op_at` + direct `op_log` SQL),
// so a regression in the sort predicate or the append contract
// surfaces here even if the command-layer tests drift.
// ──────────────────────────────────────────────────────────────────────

/// Batch-ordering is newest-first by (created_at DESC,
/// seq DESC). Three ops on the same device share an identical
/// `created_at`, so the tie-break falls entirely on `seq`. Passing
/// them oldest-first must yield results in strict seq-descending
/// order.
#[tokio::test]
async fn revert_ops_returns_results_newest_first_by_created_at_desc_seq_desc() {
    use crate::commands::revert_ops_inner;
    use crate::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Three SetProperty ops on the same block with distinct keys
    // and the same `created_at`. Each has no prior set_property for
    // its (block, key) pair, so `compute_reverse` returns a bare
    // `DeleteProperty` — `apply_reverse_in_tx` executes an idempotent
    // DELETE with no FK dependency on `blocks`, so no seed row is
    // required.
    let block_id = BlockId::test_id("BLK_BATCH");
    let mk = |key: &str| {
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: block_id.clone(),
            key: key.into(),
            value_text: Some("v".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        })
    };
    let rec1 = append_op(&pool, mk("k1"), FIXED_TS).await;
    let rec2 = append_op(&pool, mk("k2"), FIXED_TS).await;
    let rec3 = append_op(&pool, mk("k3"), FIXED_TS).await;

    // Sanity: all three share the timestamp (so the sort degenerates
    // to seq DESC) and the auto-assigned seqs are strictly
    // ascending (so a newest-first result is unambiguously
    // distinguishable from insertion order).
    assert_eq!(rec1.created_at, FIXED_TS);
    assert_eq!(rec2.created_at, FIXED_TS);
    assert_eq!(rec3.created_at, FIXED_TS);
    assert!(
        rec1.seq < rec2.seq && rec2.seq < rec3.seq,
        "append_local_op_at must assign ascending seqs; got {}, {}, {}",
        rec1.seq,
        rec2.seq,
        rec3.seq
    );

    // Pass the ops in oldest-first order; the batch must re-sort
    // internally before applying.
    let results = revert_ops_inner(
        &pool,
        TEST_DEVICE,
        &mat,
        vec![
            OpRef {
                device_id: TEST_DEVICE.into(),
                seq: rec1.seq,
            },
            OpRef {
                device_id: TEST_DEVICE.into(),
                seq: rec2.seq,
            },
            OpRef {
                device_id: TEST_DEVICE.into(),
                seq: rec3.seq,
            },
        ],
    )
    .await
    .unwrap();

    assert_eq!(results.len(), 3, "one result per input op");
    assert_eq!(
        results[0].reversed_op.seq, rec3.seq,
        "newest op (highest seq with identical created_at) must be reversed first"
    );
    assert_eq!(
        results[1].reversed_op.seq, rec2.seq,
        "middle op must be reversed second"
    );
    assert_eq!(
        results[2].reversed_op.seq, rec1.seq,
        "oldest op (lowest seq) must be reversed last"
    );
}

/// Op_log is append-only (invariant #1). Reverting one
/// op must append exactly one new op to the log and leave the
/// original row untouched.
#[tokio::test]
async fn revert_ops_appends_reverse_op_without_mutating_original() {
    use crate::commands::revert_ops_inner;
    use crate::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // A single SetProperty. Its reverse is `DeleteProperty` (no
    // prior for this block/key), which applies cleanly without a
    // Seeded block row — see the (a) note above.
    let rec = append_op(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK_APPEND"),
            key: "tag".into(),
            value_text: Some("start".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        FIXED_TS,
    )
    .await;

    let count_before: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ?",
        TEST_DEVICE
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    revert_ops_inner(
        &pool,
        TEST_DEVICE,
        &mat,
        vec![OpRef {
            device_id: TEST_DEVICE.into(),
            seq: rec.seq,
        }],
    )
    .await
    .unwrap();

    let count_after: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ?",
        TEST_DEVICE
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count_after,
        count_before + 1,
        "revert_ops_inner must append exactly one reverse op to op_log"
    );

    // The original row (same (device_id, seq)) must still exist —
    // the op_log is strictly append-only (AGENTS.md invariant #1).
    let original_still_present: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE device_id = ? AND seq = ?",
        TEST_DEVICE,
        rec.seq,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        original_still_present, 1,
        "original op (device_id={TEST_DEVICE}, seq={}) must remain in op_log after revert",
        rec.seq
    );
}

/// C5 (#344): `revert_ops_inner` must reject a batch larger than
/// `MAX_REVERT_OPS` (1000) with a clean `Validation` error, before any
/// DB work — so a point-in-time restore that sweeps an unbounded op set
/// can never hand the batch helpers a Vec large enough to overflow the
/// SQL bind limit. 1001 refs need no seeding: the cap is checked up
/// front, ahead of the first query.
#[tokio::test]
async fn revert_ops_rejects_batch_over_max_revert_ops_c5() {
    use crate::commands::revert_ops_inner;
    use crate::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    let ops: Vec<OpRef> = (1..=1001)
        .map(|seq| OpRef {
            device_id: TEST_DEVICE.into(),
            seq,
        })
        .collect();

    let err = revert_ops_inner(&pool, TEST_DEVICE, &mat, ops)
        .await
        .expect_err("C5: a 1001-op batch must be rejected");
    assert!(
        matches!(err, crate::error::AppError::Validation(_)),
        "over-cap batch must surface AppError::Validation, got {err:?}"
    );
}

// ======================================================================
// SQL-review B-3 — parity: batched vs. per-op reverse computation
// ======================================================================

/// Pin the batched `compute_reverse_batch` output byte-for-byte against
/// the legacy `for op in ops { compute_reverse(...) }` loop. The batch
/// path is a pure read-path optimisation — any divergence is a
/// correctness regression in the undo engine.
///
/// Seeds a 20-op mixed batch covering edit_block, move_block,
/// set_property, and add_attachment plus the support history each
/// reverse needs to find prior context. Then asserts:
///   * `compute_reverse_batch(pool, &records).await == legacy`
///   * `legacy` is produced by the per-op `compute_reverse` loop.
#[tokio::test]
async fn compute_reverse_batch_matches_per_op_loop() {
    use crate::reverse::{compute_reverse_batch, get_op_records_batch};

    let (pool, _dir) = test_pool().await;

    // -- seed support history (5 distinct blocks + 5 attachments) ----
    //
    // Each block carries a create + an edit + a move so the
    // edit_block / move_block reverse lookups find prior context.
    // Each property block carries a `priority=low` seed so the
    // set_property reverse finds something to roll back to. Each
    // attachment block carries an `add_attachment` whose paired
    // `delete_attachment` we will later target.
    let blocks: Vec<&str> = vec!["B3_BLK1", "B3_BLK2", "B3_BLK3", "B3_BLK4", "B3_BLK5"];
    let mut ts = 0i64;
    let next_ts = |ts: &mut i64| -> i64 {
        *ts += 1;
        1_736_942_400_000 + *ts * 60_000
    };

    for bid in &blocks {
        append_op(
            &pool,
            OpPayload::CreateBlock(CreateBlockPayload {
                block_id: BlockId::test_id(bid),
                block_type: "content".into(),
                parent_id: Some(BlockId::test_id("B3_ROOT")),
                position: Some(1),
                index: None,
                content: format!("{bid} v0"),
            }),
            next_ts(&mut ts),
        )
        .await;
        append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id(bid),
                key: "priority".into(),
                value_text: Some("low".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
            }),
            next_ts(&mut ts),
        )
        .await;
    }

    // -- 20-op mixed batch -------------------------------------------
    //
    // Distribution (4 each):
    //   * 4 × edit_block  — change content
    //   * 4 × move_block  — reparent under "B3_NEW_PARENT"
    //   * 4 × set_property — bump priority to "high"
    //   * 4 × add_attachment — net-new attachment per block
    //   * 4 × delete_attachment — soft-delete each just-added attachment
    let mut op_refs: Vec<crate::op::OpRef> = Vec::new();

    for bid in &blocks[..4] {
        let rec = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id(bid),
                to_text: format!("{bid} v1"),
                prev_edit: None,
            }),
            next_ts(&mut ts),
        )
        .await;
        op_refs.push(crate::op::OpRef {
            device_id: rec.device_id,
            seq: rec.seq,
        });
    }
    for bid in &blocks[..4] {
        let rec = append_op(
            &pool,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id(bid),
                new_parent_id: Some(BlockId::test_id("B3_NEW_PARENT")),
                new_position: 9,
                new_index: None,
            }),
            next_ts(&mut ts),
        )
        .await;
        op_refs.push(crate::op::OpRef {
            device_id: rec.device_id,
            seq: rec.seq,
        });
    }
    for bid in &blocks[..4] {
        let rec = append_op(
            &pool,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id(bid),
                key: "priority".into(),
                value_text: Some("high".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
            }),
            next_ts(&mut ts),
        )
        .await;
        op_refs.push(crate::op::OpRef {
            device_id: rec.device_id,
            seq: rec.seq,
        });
    }
    // 4 × add_attachment — record so we can target the matching delete.
    let mut att_ids: Vec<String> = Vec::new();
    for (i, bid) in blocks[..4].iter().enumerate() {
        let att_id = format!("B3_ATT_{i:02}");
        let rec = append_op(
            &pool,
            OpPayload::AddAttachment(crate::op::AddAttachmentPayload {
                attachment_id: BlockId::test_id(&att_id),
                block_id: BlockId::test_id(bid),
                mime_type: "image/png".into(),
                filename: format!("{att_id}.png"),
                size_bytes: 1024,
                fs_path: format!("/tmp/{att_id}.png"),
            }),
            next_ts(&mut ts),
        )
        .await;
        op_refs.push(crate::op::OpRef {
            device_id: rec.device_id,
            seq: rec.seq,
        });
        att_ids.push(att_id);
    }
    for att_id in &att_ids {
        let rec = append_op(
            &pool,
            OpPayload::DeleteAttachment(crate::op::DeleteAttachmentPayload {
                attachment_id: BlockId::test_id(att_id),
                fs_path: format!("/tmp/{att_id}.png"),
            }),
            next_ts(&mut ts),
        )
        .await;
        op_refs.push(crate::op::OpRef {
            device_id: rec.device_id,
            seq: rec.seq,
        });
    }

    assert_eq!(op_refs.len(), 20, "test should batch exactly 20 ops");

    // -- legacy oracle: per-op loop ----------------------------------
    let mut legacy: Vec<OpPayload> = Vec::with_capacity(op_refs.len());
    for r in &op_refs {
        legacy.push(compute_reverse(&pool, &r.device_id, r.seq).await.unwrap());
    }

    // -- batched candidate ------------------------------------------
    let records = get_op_records_batch(&pool, &op_refs).await.unwrap();
    let batched = compute_reverse_batch(&pool, &records).await.unwrap();

    // -- assert byte-identical ---------------------------------------
    assert_eq!(
        batched.len(),
        legacy.len(),
        "batched output length must match legacy"
    );
    for (i, (b, l)) in batched.iter().zip(legacy.iter()).enumerate() {
        assert_eq!(
            b, l,
            "B-3 parity violation at idx {i}: batched={b:?} vs legacy={l:?}"
        );
    }
}

/// #343 (SQL/C4): the batched property-reverse path must honour the #181
/// `delete_property` semantics. For the sequence
/// `Set(K="A"); Delete(K); Set(K="a")`, the most-recent prior op before
/// the final Set is a `delete_property` — so reversing the final Set must
/// yield `DeleteProperty(K)` (the property was absent), NOT a resurrected
/// `SetProperty(K="A")`. Pin the batched output against the single-op
/// `compute_reverse` oracle for this case.
#[tokio::test]
async fn compute_reverse_batch_set_delete_set_yields_delete_property() {
    use crate::reverse::{compute_reverse_batch, get_op_records_batch};

    let (pool, _dir) = test_pool().await;

    let bid = BlockId::test_id("C4_BLK");
    let key = "status";

    // Set(K="A")
    append_op(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: bid.clone(),
            key: key.into(),
            value_text: Some("A".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        FIXED_TS + 60_000,
    )
    .await;
    // Delete(K)
    append_op(
        &pool,
        OpPayload::DeleteProperty(DeletePropertyPayload {
            block_id: bid.clone(),
            key: key.into(),
        }),
        FIXED_TS + 120_000,
    )
    .await;
    // Set(K="a") — the op whose reverse we examine.
    let final_set = append_op(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: bid.clone(),
            key: key.into(),
            value_text: Some("a".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        FIXED_TS + 180_000,
    )
    .await;

    let op_refs = vec![crate::op::OpRef {
        device_id: final_set.device_id.clone(),
        seq: final_set.seq,
    }];

    // Single-op oracle.
    let legacy = compute_reverse(&pool, &final_set.device_id, final_set.seq)
        .await
        .unwrap();
    assert!(
        matches!(legacy, OpPayload::DeleteProperty(ref p) if p.key == key && p.block_id == bid),
        "single-op oracle should reverse Set;Delete;Set to DeleteProperty, got {legacy:?}"
    );

    // Batched candidate must match the oracle byte-for-byte.
    let records = get_op_records_batch(&pool, &op_refs).await.unwrap();
    let batched = compute_reverse_batch(&pool, &records).await.unwrap();
    assert_eq!(batched.len(), 1, "exactly one reverse for one op");
    assert_eq!(
        batched[0], legacy,
        "#343 parity violation: batched reverse of final Set must equal single-op DeleteProperty"
    );
}

/// C5 (#344): a batch large enough to overflow SQLite's bind-parameter
/// limit must still compute its reverses. Before chunking, each per-op
/// `edit_block` subquery in `fetch_prior_text_batch` bound 5 params, so
/// any batch over `floor(999 / 5) = 199` ops blew past the conservative
/// limit (and over 32766/5 ≈ 6553 the real one). 400 edits exercise the
/// chunk boundary several times over and assert no "too many SQL
/// variables" error — i.e. each executed UNION-ALL statement stays under
/// the bind cap while results remain aligned to input order.
#[tokio::test]
async fn compute_reverse_batch_chunks_large_edit_batch_c5() {
    use crate::reverse::{compute_reverse_batch, get_op_records_batch};

    let (pool, _dir) = test_pool().await;

    let bid = BlockId::test_id("C5_BLK");
    let mut ts = 0i64;
    let next_ts = |ts: &mut i64| -> i64 {
        *ts += 1;
        1_736_942_400_000 + *ts * 60_000
    };

    // Root create so every edit's prior-text lookup resolves.
    append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: bid.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "v0".into(),
        }),
        next_ts(&mut ts),
    )
    .await;

    // 400 sequential edits on the SAME block — comfortably over the
    // old ~199-op (5-bind) single-statement ceiling.
    const N_EDITS: usize = 400;
    let mut op_refs: Vec<crate::op::OpRef> = Vec::with_capacity(N_EDITS);
    for i in 0..N_EDITS {
        let rec = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: bid.clone(),
                to_text: format!("v{}", i + 1),
                prev_edit: None,
            }),
            next_ts(&mut ts),
        )
        .await;
        op_refs.push(crate::op::OpRef {
            device_id: rec.device_id,
            seq: rec.seq,
        });
    }

    // The two batch helpers that fan out one bound subquery per op.
    // Either would have tripped "too many SQL variables" pre-chunking.
    let records = get_op_records_batch(&pool, &op_refs).await.unwrap();
    assert_eq!(records.len(), N_EDITS, "all op records round-tripped");

    let batched = compute_reverse_batch(&pool, &records)
        .await
        .expect("C5: batched reverse of 400 edits must not overflow the SQL bind limit");
    assert_eq!(batched.len(), N_EDITS, "one reverse per input op, in order");

    // Output must stay aligned to input order across chunk boundaries:
    // the reverse of edit i restores the text edit (i-1) wrote ("v{i}"),
    // and the first edit reverts to the create_block content ("v0").
    for (i, rev) in batched.iter().enumerate() {
        let expected = if i == 0 {
            "v0".to_string()
        } else {
            format!("v{i}")
        };
        match rev {
            OpPayload::EditBlock(p) => assert_eq!(
                p.to_text, expected,
                "reverse #{i} should restore prior text '{expected}', got '{}'",
                p.to_text
            ),
            other => panic!("reverse #{i} should be EditBlock, got {other:?}"),
        }
    }
}

/// #382 (sub-fix B): the reverse-op prior-context lookup must tie-break
/// on the full canonical `(created_at, seq, device_id)` total order. The
/// op_log PK is `(device_id, seq)` and `seq` is a PER-DEVICE counter, so
/// two devices can legitimately share the same `(created_at, seq)` pair.
///
/// Seed (all at the SAME `created_at`): the op being reversed is
/// `dev9 @ (created_at=T, seq=7)`. Two prior `edit_block` candidates
/// also live at `created_at=T, seq=7`: `dev1` ("from dev1") and `dev5`
/// ("from dev5"). Under the OLD bound `(created_at = T AND seq < 7)`,
/// BOTH are excluded (their seq is not `< 7`) and `find_prior_text`
/// returns None — losing the prior context entirely. Under the canonical
/// bound `(created_at = T AND (seq < 7 OR (seq = 7 AND device_id < dev9)))`
/// with `ORDER BY … device_id DESC`, both are in range and the winner is
/// the largest device_id still `< dev9` — `dev5`.
#[tokio::test]
async fn find_prior_text_tie_breaks_on_device_id_at_equal_created_at_seq() {
    let (pool, _dir) = test_pool().await;
    let block_id_upper = BlockId::test_id("BLKTIE").into_string();
    let t: i64 = 1_736_942_400_000;

    // Helper: raw-insert an edit_block row at an explicit (device, seq).
    async fn insert_edit(
        pool: &SqlitePool,
        device: &str,
        seq: i64,
        block_id: &str,
        created_at: i64,
        to_text: &str,
    ) {
        sqlx::query(
            "INSERT INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id) \
             VALUES (?, ?, NULL, ?, 'edit_block', ?, ?, ?)",
        )
        .bind(device)
        .bind(seq)
        .bind(format!("hash-{device}-{seq}"))
        .bind(format!(
            r#"{{"block_id":"{block_id}","to_text":"{to_text}"}}"#
        ))
        .bind(created_at)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
    }

    // Two prior candidates, same created_at & seq, different device_id.
    insert_edit(&pool, "dev1", 7, &block_id_upper, t, "from dev1").await;
    insert_edit(&pool, "dev5", 7, &block_id_upper, t, "from dev5").await;
    // The op being reversed: dev9 @ (t, 7).
    insert_edit(
        &pool,
        "dev9",
        7,
        &block_id_upper,
        t,
        "from dev9 (being reversed)",
    )
    .await;

    let prior = find_prior_text(&pool, &block_id_upper, t, 7, "dev9")
        .await
        .unwrap();

    assert_eq!(
        prior,
        Some("from dev5".to_string()),
        "equal (created_at, seq) ties must break on device_id: the prior of dev9 \
         is the largest device_id still < dev9 (dev5), not None and not dev1"
    );
}
