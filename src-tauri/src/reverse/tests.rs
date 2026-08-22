use super::*;
use crate::db::init_pool;
use agaric_core::ulid::BlockId;
use agaric_store::op::*;
use agaric_store::op_log::append_local_op_at;
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

async fn append_op(
    pool: &SqlitePool,
    payload: OpPayload,
    ts: i64,
) -> agaric_store::op_log::OpRecord {
    append_local_op_at(pool, TEST_DEVICE, payload, ts)
        .await
        .unwrap()
}

/// #2549: seed a REPLICATED (audit-only, `is_replicated = 1`) op — a row
/// ingested for provenance that is NEVER applied to local state (#2481/#2495).
///
/// Goes through the real sync-ingest core (`dag::insert_replicated_op`) so the
/// denormalized `block_id` column is populated and the `is_replicated = 1`
/// stamp is set exactly as a synced audit row would be. Authored by a distinct
/// (foreign) `device_id` and serialized with the same inner-payload encoding as
/// the local append path, so `find_prior_*` sees a byte-faithful candidate row.
async fn append_replicated_op(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
    mut payload: OpPayload,
    ts: i64,
) -> agaric_store::op_log::OpRecord {
    // Mirror the local append path: normalize ULIDs, then serialize the inner
    // payload (no `op_type` tag) exactly as `append_local_op_at` stores it.
    payload.normalize_block_ids();
    let op_type = payload.op_type_str().to_owned();
    let payload_json = agaric_store::op_log::serialize_inner_payload(&payload).unwrap();
    let hash = agaric_core::hash::compute_op_hash(device_id, seq, None, &op_type, &payload_json);
    let transfer = agaric_sync::sync_protocol::types::OpTransfer {
        device_id: device_id.to_owned(),
        seq,
        parent_seqs: None,
        hash,
        op_type,
        payload: payload_json,
        created_at: ts,
        origin: "agent:codex".to_owned(),
    };
    agaric_sync::sync_protocol::insert_replicated_op(pool, &transfer)
        .await
        .expect("replicated audit op must ingest");
    agaric_store::op_log::get_op_by_seq(&crate::db::ReadPool(pool.clone()), device_id, seq)
        .await
        .expect("replicated op must be readable")
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
/// #3645: an `edit_block` with no reconstructable prior answers
/// `NonReversible`, NOT `NotFound`.
///
/// The condition is "no inverse exists for this op", which is what
/// `NonReversible` names — and, critically, it is the answer
/// `batch::build_reverse_edit_block` already gave for the identical input.
/// While the two kernels disagreed, the same op was FATAL under Ctrl+Z and
/// SKIPPABLE under a bulk restore; the parity oracle compares `Ok` payloads
/// only and could not see the split. The sibling `move_block` /
/// `set_property` / `delete_property` arms keep `NotFound` — those are
/// genuinely missing prior-context rows, not absent inverses.
#[tokio::test]
async fn reverse_edit_block_without_prior_returns_non_reversible_3645() {
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
    let err = compute_reverse(&pool, TEST_DEVICE, rec.seq)
        .await
        .expect_err("an edit with no reconstructable prior has no inverse");
    assert!(
        matches!(&err, AppError::NonReversible { op_type } if op_type == "edit_block"),
        "#3645: expected NonReversible {{ op_type: \"edit_block\" }}, got {err:?}"
    );
    assert!(
        crate::reverse::is_skippable_non_reversible(&err),
        "#3645: the per-op kernel must emit the SAME skippable kind the batch \
         kernel emits for this input, got {err:?}"
    );
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
        OpPayload::AddAttachment(agaric_store::op::AddAttachmentPayload {
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
        OpPayload::DeleteAttachment(agaric_store::op::DeleteAttachmentPayload {
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
        OpPayload::DeleteAttachment(agaric_store::op::DeleteAttachmentPayload {
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
        OpPayload::AddAttachment(agaric_store::op::AddAttachmentPayload {
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

/// I-Lifecycle-3 — round-trip contract for `create_block`.
///
/// The pre-existing `reverse_create_block_produces_delete_block` test
/// only checks that `compute_reverse` returns the `DeleteBlock`
/// variant for the same `block_id`. This test extends the contract to
/// the materialized state: apply `CreateBlock` → apply
/// `compute_reverse(...)` → assert the resulting `blocks` state.
///
/// **Strict identity round-trip is a known design divergence (not a
/// code bug), and this test pins the divergent behavior.**
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
/// This test therefore asserts the tombstone shape instead of
/// emptiness. If it ever fails because `blocks` came back EMPTY, the
/// undo semantics changed to a hard-delete round-trip — revisit the
/// op-log convergence rationale above before accepting that change.
///
/// (Historical note: this was previously an `#[ignore]`d,
/// deliberately-failing oracle. The nightly deep-checks lane runs
/// `cargo nextest run --run-ignored=only` for its perf gates, so a
/// never-passing ignored test poisoned every nightly run; pinning the
/// documented divergence keeps the oracle greppable AND every lane
/// green.)
#[tokio::test]
async fn create_block_apply_then_reverse_leaves_tombstone_i_lifecycle_3() {
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
        post_reverse.len(),
        1,
        "reverse of create_block must soft-delete (tombstone), not purge; got: {post_reverse:?}"
    );
    let tombstone = &post_reverse[0];
    assert_eq!(tombstone.id, BlockId::test_id("BLK_RT_CB").to_string());
    assert_eq!(
        tombstone.deleted_at,
        Some(1_736_942_460_000),
        "tombstone must carry the reverse op's created_at as deleted_at"
    );
    assert_eq!(
        tombstone.content.as_deref(),
        Some("round-trip create"),
        "soft-delete must preserve content for op-log convergence"
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
        matches!(err, agaric_core::error::AppError::Validation { .. }),
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

    // #3280: remember each block's `create_block` op so the edits below
    // can carry a REALISTIC `prev_edit` pointer. Production never emits
    // `prev_edit: None` for an `edit_block` — `find_prev_edit_in_tx`
    // stamps the pointer on every local edit — and `None` is precisely
    // the shape where the pointer-first and timestamp-scan kernels
    // trivially agree, so seeding it made this oracle blind.
    let mut create_refs: std::collections::HashMap<&str, (String, i64)> =
        std::collections::HashMap::new();

    for bid in &blocks {
        let create_rec = append_op(
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
        create_refs.insert(bid, (create_rec.device_id.clone(), create_rec.seq));
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
    let mut op_refs: Vec<agaric_store::op::OpRef> = Vec::new();

    // #3280: the oracle must exercise BOTH arms of the shared decision.
    // Stamping a RESOLVING pointer on every edit covers the pointer arm but
    // leaves `fetch_prior_text_batch` — the batch module's hand-copied
    // TIMESTAMP-FALLBACK SQL — completely unexercised, i.e. it swaps the
    // original `prev_edit: None` blindness for its mirror image. B3_BLK1
    // therefore deliberately keeps `prev_edit: None` (the shape production
    // still emits for pre-#1526 ops and for the first local edit of a
    // peer-originated block), and gets a prior history that makes the
    // fallback scan decisive on BOTH axes the copy must mirror:
    //   * ORDER — two local candidates ("v0" create, "v0.5" edit), so a
    //     drifted `ORDER BY` picks the create instead of the newest edit;
    //   * PROVENANCE — a replicated audit row that is the timestamp-NEWEST
    //     candidate, so a copy missing `is_replicated = 0` (#2549/#3281)
    //     picks never-applied foreign text.
    // The per-op kernel resolves through the shared primitive, so either
    // drift in the batch copy breaks parity here.
    append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("B3_BLK1"),
            to_text: "B3_BLK1 v0.5".into(),
            prev_edit: Some(create_refs["B3_BLK1"].clone()),
        }),
        next_ts(&mut ts),
    )
    .await;
    append_replicated_op(
        &pool,
        "b3-audit-remote",
        1,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("B3_BLK1"),
            to_text: "FOREIGN-never-applied".into(),
            prev_edit: None,
        }),
        next_ts(&mut ts),
    )
    .await;

    for bid in &blocks[..4] {
        let rec = append_op(
            &pool,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id(bid),
                to_text: format!("{bid} v1"),
                // B3_BLK1 exercises the fallback arm; the rest the pointer
                // arm. See the note above.
                prev_edit: if *bid == "B3_BLK1" {
                    None
                } else {
                    Some(create_refs[bid].clone())
                },
            }),
            next_ts(&mut ts),
        )
        .await;
        op_refs.push(agaric_store::op::OpRef {
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
        op_refs.push(agaric_store::op::OpRef {
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
        op_refs.push(agaric_store::op::OpRef {
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
            OpPayload::AddAttachment(agaric_store::op::AddAttachmentPayload {
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
        op_refs.push(agaric_store::op::OpRef {
            device_id: rec.device_id,
            seq: rec.seq,
        });
        att_ids.push(att_id);
    }
    // #3706 review (B-3 parity): the delete's `fs_path` deliberately DIFFERS
    // from the matching add's (`/tmp/blob_{att_id}.png` vs `/tmp/{att_id}.png`)
    // — simulating a repoint onto a shared blob between the add and the
    // delete, same as the three production repointers. An identical path on
    // both ops would make the twins agree whether or not either one adopts
    // the delete-time path, so the parity comparison below could not tell a
    // correct adoption from a same-payload no-op.
    //
    // The index of the first `delete_attachment` is captured from `op_refs`
    // itself rather than hand-counted from the groups ahead of it: the
    // absolute-answer assertion at the bottom indexes `batched` by it, and a
    // literal offset silently RETARGETS onto a different op-type the moment
    // anyone inserts an op earlier in the batch — surfacing as a bogus
    // "expected AddAttachment" panic that reads like an attachment-reverse
    // regression rather than a stale index (#3706 review).
    let delete_att_base = op_refs.len();
    for att_id in &att_ids {
        let rec = append_op(
            &pool,
            OpPayload::DeleteAttachment(agaric_store::op::DeleteAttachmentPayload {
                attachment_id: BlockId::test_id(att_id),
                fs_path: format!("/tmp/blob_{att_id}.png"),
            }),
            next_ts(&mut ts),
        )
        .await;
        op_refs.push(agaric_store::op::OpRef {
            device_id: rec.device_id,
            seq: rec.seq,
        });
    }

    // -- #3280: two-device clock-skew block ---------------------------
    //
    // The 20 ops above all originate on a single device with monotonic
    // timestamps, so `seq` order and `created_at` order coincide and the
    // pointer-first kernel and the timestamp-scan kernel cannot be told
    // apart. Add the #1526 skew shape (mirrors
    // `reverse_edit_follows_prev_edit_not_timestamp_under_skew_1526`) so
    // the oracle can actually observe a divergence:
    //   * device-a creates "v0"                       @ T+0  (a, 1)
    //   * device-a edits "CORRECT-causal-prev"        @ T+5  (a, 2)
    //   * device-b edits "WRONG-intruder"             @ T+8  (b, 1)
    //   * device-b edits, prev_edit=(a,2)             @ T+10 (b, 2)
    // Undoing (b, 2) must restore "CORRECT-causal-prev" on BOTH paths;
    // the timestamp scan alone would return "WRONG-intruder".
    const B3_DEV_A: &str = "b3-device-a";
    const B3_DEV_B: &str = "b3-device-b";
    let skew_blk = BlockId::test_id("B3_SKEW");
    let skew_t = 1_736_942_400_000 + 100 * 60_000;

    append_local_op_at(
        &pool,
        B3_DEV_A,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: skew_blk.clone(),
            block_type: "content".into(),
            parent_id: Some(BlockId::test_id("B3_ROOT")),
            position: Some(1),
            index: None,
            content: "v0".into(),
        }),
        skew_t,
    )
    .await
    .unwrap();
    let causal_prev = append_local_op_at(
        &pool,
        B3_DEV_A,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: skew_blk.clone(),
            to_text: "CORRECT-causal-prev".into(),
            prev_edit: Some((B3_DEV_A.to_string(), 1)),
        }),
        skew_t + 5,
    )
    .await
    .unwrap();
    append_local_op_at(
        &pool,
        B3_DEV_B,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: skew_blk.clone(),
            to_text: "WRONG-intruder".into(),
            prev_edit: None,
        }),
        skew_t + 8,
    )
    .await
    .unwrap();
    let skew_target = append_local_op_at(
        &pool,
        B3_DEV_B,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: skew_blk.clone(),
            to_text: "latest".into(),
            prev_edit: Some((B3_DEV_A.to_string(), causal_prev.seq)),
        }),
        skew_t + 10,
    )
    .await
    .unwrap();
    op_refs.push(agaric_store::op::OpRef {
        device_id: skew_target.device_id.clone(),
        seq: skew_target.seq,
    });

    // -- #3644: peer-originated block -------------------------------------
    //
    // The block arrived via sync: its only op_log row is a REPLICATED audit
    // row, its content reached this device through Loro, and the user's
    // first local edit points at that audit row. Both kernels must RESOLVE
    // the pointer — the blind scan is barred from replicated rows (#2549)
    // and would find nothing at all here, so this fixture is what pins the
    // deliberate ABSENCE of an `is_replicated` predicate on
    // `fetch_prev_edit_rows_batch` against the single-op
    // `resolve_prev_edit_target`. Adding the predicate back to either copy
    // alone breaks parity here.
    let peer_blk = BlockId::test_id("B3_PEER");
    let peer_audit = append_replicated_op(
        &pool,
        "b3-peer-remote",
        1,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: peer_blk.clone(),
            block_type: "content".into(),
            parent_id: Some(BlockId::test_id("B3_ROOT")),
            position: Some(2),
            index: None,
            content: "PEER-ORIGIN".into(),
        }),
        skew_t + 20,
    )
    .await;
    let peer_target = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: peer_blk.clone(),
            to_text: "my local edit".into(),
            prev_edit: Some((peer_audit.device_id.clone(), peer_audit.seq)),
        }),
        skew_t + 25,
    )
    .await;
    op_refs.push(agaric_store::op::OpRef {
        device_id: peer_target.device_id.clone(),
        seq: peer_target.seq,
    });

    assert_eq!(op_refs.len(), 22, "test should batch exactly 22 ops");

    // -- legacy oracle: per-op loop ----------------------------------
    let mut legacy: Vec<OpPayload> = Vec::with_capacity(op_refs.len());
    for r in &op_refs {
        legacy.push(compute_reverse(&pool, &r.device_id, r.seq).await.unwrap());
    }

    // -- batched candidate ------------------------------------------
    let records = get_op_records_batch(&pool, &op_refs).await.unwrap();
    // #2020: per-op `Result`s — every op in this batch is reversible, so
    // unwrap each inner result into the byte-for-byte payload comparison.
    let batched: Vec<OpPayload> = compute_reverse_batch(&pool, &records)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.expect("all ops in this batch are reversible"))
        .collect();

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

    // #3280: pin the ABSOLUTE answer for the FALLBACK-arm op (idx 0 is
    // B3_BLK1's pointerless edit) — a drift shared by both kernels would
    // otherwise still satisfy the parity comparison above.
    match batched.first().expect("fallback-arm reverse present") {
        OpPayload::EditBlock(p) => assert_eq!(
            p.to_text, "B3_BLK1 v0.5",
            "#3280/#2549: with no causal pointer the timestamp scan must return \
             the newest LOCAL prior edit — not the create (order drift) and not \
             the replicated audit row (provenance drift)"
        ),
        other => panic!("expected EditBlock for the fallback-arm op, got {other:?}"),
    }

    // #3280: pin the ABSOLUTE answer for the skew op too, not just
    // batch/per-op agreement — a shared regression in both kernels would
    // otherwise still satisfy the parity comparison above.
    match &batched[batched.len() - 2] {
        OpPayload::EditBlock(p) => assert_eq!(
            p.to_text, "CORRECT-causal-prev",
            "#3280/#1526: the BATCH path must follow payload.prev_edit, not the \
             timestamp-nearest intruder"
        ),
        other => panic!("expected EditBlock for the skew op, got {other:?}"),
    }

    // #3644: same, for the peer-originated block — the blind scan has
    // nothing to offer here, so this can only pass by resolving the pointer
    // into the replicated audit row.
    match batched.last().expect("peer-origin reverse present") {
        OpPayload::EditBlock(p) => assert_eq!(
            p.to_text, "PEER-ORIGIN",
            "#3644: both kernels must resolve a prev_edit that names a \
             replicated audit row"
        ),
        other => panic!("expected EditBlock for the peer-origin op, got {other:?}"),
    }

    // #3706 review: pin the ABSOLUTE answer for the attachment reverses too —
    // not just batch/per-op agreement. The `delete_attachment` reverses
    // occupy `delete_att_base .. delete_att_base + att_ids.len()`, an offset
    // DERIVED from `op_refs.len()` at the point that group was appended (see
    // there) rather than hand-counted from the preceding groups. A regression
    // shared by both kernels — e.g. gutting the body of the
    // `adopt_delete_time_fs_path` helper they both call, rather than just one
    // call site — would still satisfy the parity comparison above, since it
    // would move both `batched` and `legacy` the same wrong way.
    for (i, att_id) in att_ids.iter().enumerate() {
        let idx = delete_att_base + i;
        match &batched[idx] {
            OpPayload::AddAttachment(p) => assert_eq!(
                p.fs_path,
                format!("/tmp/blob_{att_id}.png"),
                "#3706 review: the restored row must name the path the row \
                 held at DELETE time, not the one it was created with"
            ),
            other => panic!(
                "expected AddAttachment for the delete_attachment reverse at idx {idx}, got {other:?}"
            ),
        }
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

    let op_refs = vec![agaric_store::op::OpRef {
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
    // #2020: per-op `Result`s — this single reversible op unwraps cleanly.
    let batched: Vec<OpPayload> = compute_reverse_batch(&pool, &records)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.expect("the final Set is reversible"))
        .collect();
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
    let mut op_refs: Vec<agaric_store::op::OpRef> = Vec::with_capacity(N_EDITS);
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
        op_refs.push(agaric_store::op::OpRef {
            device_id: rec.device_id,
            seq: rec.seq,
        });
    }

    // The two batch helpers that fan out one bound subquery per op.
    // Either would have tripped "too many SQL variables" pre-chunking.
    let records = get_op_records_batch(&pool, &op_refs).await.unwrap();
    assert_eq!(records.len(), N_EDITS, "all op records round-tripped");

    // #2020: per-op `Result`s — every edit is reversible, so unwrap each.
    let batched: Vec<OpPayload> = compute_reverse_batch(&pool, &records)
        .await
        .expect("C5: batched reverse of 400 edits must not overflow the SQL bind limit")
        .into_iter()
        .map(|r| r.expect("every edit in this batch is reversible"))
        .collect();
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

// ======================================================================
// #2549 — reverse prior-state reconstruction must skip replicated audit
// rows (`is_replicated = 1`) that were NEVER applied to local state.
//
// #2495 introduced audit-only replicated ops: rows landed in `op_log`
// for provenance but never materialized. The shared `compute_reverse` /
// `compute_reverse_batch` prior-state walk (`find_prior_*`) must ignore
// them — otherwise an explicit revert reconstructs "prior state" from a
// value this device never held, restoring foreign content/properties.
// ======================================================================

/// #2549 (single-op path): `compute_reverse` of a local `edit_block` must
/// reconstruct the prior text from the most recent LOCAL edit, skipping a
/// never-applied replicated audit row that sits between the two local edits.
#[tokio::test]
async fn compute_reverse_edit_skips_replicated_prior_text_2549() {
    let (pool, _dir) = test_pool().await;
    let blk = "BLK_2549_TEXT";

    append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(blk),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "seed".into(),
        }),
        1_000,
    )
    .await;
    // Local edit A -> "local-1".
    append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "local-1".into(),
            prev_edit: None,
        }),
        2_000,
    )
    .await;
    // Replicated audit row (foreign device) -> "foreign", NEVER applied.
    append_replicated_op(
        &pool,
        "remote-dev",
        1,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "foreign".into(),
            prev_edit: None,
        }),
        3_000,
    )
    .await;
    // Local edit B -> "local-2" (the op we reverse).
    let edit_b = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "local-2".into(),
            prev_edit: None,
        }),
        4_000,
    )
    .await;

    let reverse = compute_reverse(&pool, TEST_DEVICE, edit_b.seq)
        .await
        .unwrap();
    match reverse {
        OpPayload::EditBlock(p) => assert_eq!(
            p.to_text, "local-1",
            "reverse must restore the last LOCAL content, not the never-applied replicated 'foreign' row (#2549)"
        ),
        other => panic!("expected EditBlock reverse, got {other:?}"),
    }
}

/// #2549 (property sibling, single-op path): `compute_reverse` of a local
/// `set_property` must roll back to the prior LOCAL value, skipping a
/// never-applied replicated audit `set_property` on the same (block, key).
#[tokio::test]
async fn compute_reverse_set_property_skips_replicated_prior_2549() {
    let (pool, _dir) = test_pool().await;
    let blk = "BLK_2549_PROP";

    append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(blk),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "seed".into(),
        }),
        1_000,
    )
    .await;
    // Local set priority -> "local-1".
    append_op(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id(blk),
            key: "priority".into(),
            value_text: Some("local-1".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        2_000,
    )
    .await;
    // Replicated audit set priority -> "foreign", NEVER applied.
    append_replicated_op(
        &pool,
        "remote-dev",
        1,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id(blk),
            key: "priority".into(),
            value_text: Some("foreign".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        3_000,
    )
    .await;
    // Local set priority -> "local-2" (the op we reverse).
    let set_b = append_op(
        &pool,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id(blk),
            key: "priority".into(),
            value_text: Some("local-2".into()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        4_000,
    )
    .await;

    let reverse = compute_reverse(&pool, TEST_DEVICE, set_b.seq)
        .await
        .unwrap();
    match reverse {
        OpPayload::SetProperty(p) => assert_eq!(
            p.value_text.as_deref(),
            Some("local-1"),
            "reverse must restore the prior LOCAL property value, not the never-applied replicated 'foreign' row (#2549)"
        ),
        other => panic!("expected SetProperty reverse, got {other:?}"),
    }
}

/// #2549 (explicit revert, end-to-end, BATCH path): a full `revert_ops_inner`
/// of a local `edit_block` must materialize the last LOCAL content, not the
/// never-applied replicated audit content. This drives the same
/// `compute_reverse_batch` -> `fetch_prior_text_batch` walk that the real
/// `revert_ops` command uses.
#[tokio::test]
async fn revert_ops_restores_local_content_over_replicated_prior_2549() {
    use crate::commands::revert_ops_inner;
    use crate::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let blk = "BLK_2549_E2E";

    // Local create + edit A -> "local-1", both applied.
    let create_rec = append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(blk),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "local-0".into(),
        }),
        1_000,
    )
    .await;
    mat.dispatch_op(&create_rec).await.unwrap();
    let edit_a = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "local-1".into(),
            prev_edit: None,
        }),
        2_000,
    )
    .await;
    mat.dispatch_op(&edit_a).await.unwrap();

    // Replicated audit edit -> "foreign": lands in op_log but is NOT applied.
    append_replicated_op(
        &pool,
        "remote-dev",
        1,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "foreign".into(),
            prev_edit: None,
        }),
        3_000,
    )
    .await;

    // Local edit B -> "local-2", applied. This is the op we explicitly revert.
    let edit_b = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "local-2".into(),
            prev_edit: None,
        }),
        4_000,
    )
    .await;
    mat.dispatch_op(&edit_b).await.unwrap();
    mat.flush().await.unwrap();

    // Sanity: applied state is "local-2" before the revert.
    let pre = snapshot_blocks(&pool).await;
    assert_eq!(pre.len(), 1);
    assert_eq!(pre[0].content.as_deref(), Some("local-2"));

    revert_ops_inner(
        &pool,
        TEST_DEVICE,
        &mat,
        vec![OpRef {
            device_id: edit_b.device_id.clone(),
            seq: edit_b.seq,
        }],
    )
    .await
    .expect("explicit revert of a local edit must succeed");
    mat.flush().await.unwrap();

    let post = snapshot_blocks(&pool).await;
    assert_eq!(post.len(), 1);
    assert_eq!(
        post[0].content.as_deref(),
        Some("local-1"),
        "explicit revert must restore the last LOCAL content, not the never-applied replicated 'foreign' row (#2549)"
    );
}

/// #2549 (provenance guard): `revert_ops` must REFUSE to revert a replicated
/// audit op itself. Such a row was never applied to local state, so applying
/// its inverse would corrupt state by "undoing" a forward effect that never
/// happened on this device. The batch must be rejected with a `Validation`
/// error before any reverse is applied.
#[tokio::test]
async fn revert_ops_rejects_replicated_target_2549() {
    use crate::commands::revert_ops_inner;
    use crate::materializer::Materializer;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let blk = "BLK_2549_GUARD";

    let replicated = append_replicated_op(
        &pool,
        "remote-dev",
        1,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "foreign".into(),
            prev_edit: None,
        }),
        3_000,
    )
    .await;

    let err = revert_ops_inner(
        &pool,
        TEST_DEVICE,
        &mat,
        vec![OpRef {
            device_id: replicated.device_id.clone(),
            seq: replicated.seq,
        }],
    )
    .await
    .expect_err("reverting a replicated audit op must be rejected");
    assert!(
        matches!(err, agaric_core::error::AppError::Validation { .. }),
        "reverting a replicated audit op must surface AppError::Validation, got {err:?}"
    );
}

// ======================================================================
// #3280 / #3281 — one prev_edit decision, honoured by BOTH reverse
// kernels, and never sourced from a replicated audit row.
// ======================================================================

/// #3644: `EditBlockPayload::prev_edit` may name a REPLICATED audit row, and
/// the reverse MUST follow it.
///
/// The pointer is authored locally and names one specific op — the value
/// this block held when the edit was written. When a peer's edit arrives
/// (audit row in `op_log`, content applied through Loro) and the user then
/// edits the block, that peer edit IS the correct undo target. Refusing it
/// would silently restore the older `local-1` instead — the exact #1526
/// superseded-ancestor failure the causal pointer exists to prevent.
///
/// Contrast `compute_reverse_edit_skips_replicated_prior_text_2549`, which
/// pins the opposite policy on the BLIND timestamp scan. The two are not in
/// tension: the scan guesses, the pointer is a record.
#[tokio::test]
async fn compute_reverse_edit_follows_replicated_prev_edit_target_3644() {
    let (pool, _dir) = test_pool().await;
    let blk = "BLK_3281_PTR";

    append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id(blk),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "seed".into(),
        }),
        1_000,
    )
    .await;
    append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "local-1".into(),
            prev_edit: Some((TEST_DEVICE.to_string(), 1)),
        }),
        2_000,
    )
    .await;
    // Peer-authored audit row — ingested for provenance, NEVER applied here.
    let foreign = append_replicated_op(
        &pool,
        "remote-dev",
        9,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "foreign".into(),
            prev_edit: None,
        }),
        3_000,
    )
    .await;
    // The pointer `find_prev_edit_in_tx` stamps: the peer's edit was the
    // live value when this local edit was authored.
    let target = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id(blk),
            to_text: "local-2".into(),
            prev_edit: Some((foreign.device_id.clone(), foreign.seq)),
        }),
        4_000,
    )
    .await;

    let reverse = compute_reverse(&pool, TEST_DEVICE, target.seq)
        .await
        .unwrap();
    match reverse {
        OpPayload::EditBlock(ref p) => assert_eq!(
            p.to_text, "foreign",
            "#3644: a prev_edit naming a replicated audit row must RESOLVE — \
             that row is the value the block held when the edit was authored. \
             Falling back to the timestamp scan would restore the superseded \
             'local-1' instead"
        ),
        other => panic!("expected EditBlock, got {other:?}"),
    }
}

/// #3644: the STAMPING site. `find_prev_edit_in_tx` picks the causal
/// predecessor that goes into `EditBlockPayload::prev_edit`, and it must be
/// able to name a REPLICATED audit row.
///
/// The scan answers "what is the live value of the block I am about to
/// overwrite". A peer's edit that arrived through Loro is part of that live
/// value even though its `op_log` row is audit-only, so an `is_replicated = 0`
/// predicate here would stamp the pointer at already-superseded text — and
/// for a block that ORIGINATED on a peer it would stamp `None`, leaving the
/// first local edit with nothing to reconstruct from at all.
#[tokio::test]
async fn find_prev_edit_in_tx_stamps_replicated_causal_predecessor_3644() {
    let (pool, _dir) = test_pool().await;
    let blk = "BLK_3281_STAMP";
    let blk_id = BlockId::test_id(blk);

    let local = append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: blk_id.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "seed".into(),
        }),
        1_000,
    )
    .await;
    // Higher `seq` than any local row, so `ORDER BY seq DESC` prefers it —
    // and it genuinely is the newer value, applied here through Loro.
    let foreign = append_replicated_op(
        &pool,
        "remote-dev",
        99,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: blk_id.clone(),
            to_text: "foreign".into(),
            prev_edit: None,
        }),
        2_000,
    )
    .await;

    let mut conn = pool.acquire().await.unwrap();
    let prev = crate::commands::blocks::crud::find_prev_edit_in_tx(&mut conn, blk_id.as_str())
        .await
        .unwrap();
    assert_eq!(
        prev,
        Some((foreign.device_id.clone(), foreign.seq)),
        "#3644: prev_edit must be stamped at the latest edit/create in causal \
         order, replicated included — that is the value being overwritten. \
         Got the older local row {local:?} instead",
        local = (local.device_id.clone(), local.seq)
    );
}

/// #3280 (Mode B): an `edit_block` whose prior text NEITHER source can
/// reconstruct — no causal pointer (a legacy pre-#1526 op) on a block that
/// originated on a peer, so the locally-scoped timestamp scan finds nothing
/// either.
///
/// #3644 narrowed this: an edit that DOES carry a pointer into the peer's
/// audit row now reverses fine (see
/// `compute_reverse_edit_follows_replicated_prev_edit_target_3644`), so the
/// pointerless shape is what is left of Mode B — and it is still reachable
/// on any vault carrying ops written before the pointer existed.
///
/// The batch kernel used to answer `AppError::NotFound`, which
/// `is_skippable_non_reversible` does NOT match, so `compute_reverse_batch`
/// took its fatal arm and aborted the ENTIRE restore with no partial
/// progress — the exact #2020 failure mode the predicate exists to prevent —
/// even when the caller asked to skip non-reversible ops. It must be
/// `NonReversible` (skippable) instead, and the rest of the batch must
/// survive.
#[tokio::test]
async fn batch_reverse_edit_without_prior_is_skippable_not_fatal_3280() {
    use crate::reverse::{
        compute_reverse_batch, get_op_records_batch, is_skippable_non_reversible,
    };

    let (pool, _dir) = test_pool().await;
    let peer_blk = BlockId::test_id("BLK_3280_PEER");
    let local_blk = BlockId::test_id("BLK_3280_LOCAL");

    // Peer-originated block: its only op_log row is an audit row.
    let _peer_create = append_replicated_op(
        &pool,
        "remote-dev",
        1,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: peer_blk.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "peer text".into(),
        }),
        1_000,
    )
    .await;
    // First LOCAL edit of that block, written BEFORE #1526 introduced the
    // pointer — so there is no causal anchor, and the blind scan is
    // correctly barred from the peer's audit row (#2549).
    let peer_edit = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: peer_blk.clone(),
            to_text: "my edit".into(),
            prev_edit: None,
        }),
        2_000,
    )
    .await;

    // An ordinary, fully reversible local edit sharing the batch, so we can
    // assert PARTIAL PROGRESS rather than an all-or-nothing abort.
    append_op(
        &pool,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: local_blk.clone(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "v0".into(),
        }),
        3_000,
    )
    .await;
    let local_edit = append_op(
        &pool,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: local_blk.clone(),
            to_text: "v1".into(),
            prev_edit: Some((TEST_DEVICE.to_string(), 2)),
        }),
        4_000,
    )
    .await;

    let op_refs = vec![
        OpRef {
            device_id: peer_edit.device_id.clone(),
            seq: peer_edit.seq,
        },
        OpRef {
            device_id: local_edit.device_id.clone(),
            seq: local_edit.seq,
        },
    ];
    let records = get_op_records_batch(&pool, &op_refs).await.unwrap();
    let out = compute_reverse_batch(&pool, &records)
        .await
        .expect("#3280: an unreconstructable edit must NOT abort the whole batch");

    assert_eq!(out.len(), 2, "one result per input op");
    let err = out[0]
        .as_ref()
        .expect_err("the peer-originated edit has no local prior text");
    assert!(
        is_skippable_non_reversible(err),
        "#3280: it must be AppError::NonReversible so a restore with \
         skip_non_reversible = true can continue, got {err:?}"
    );
    match out[1].as_ref().expect("the local edit is reversible") {
        OpPayload::EditBlock(p) => assert_eq!(
            p.to_text, "v0",
            "#3280: the rest of the batch must still be computed (partial progress)"
        ),
        other => panic!("expected EditBlock, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// #382 / #3646 — the cross-device `(created_at, seq)` collision.
//
// `seq` is a PER-DEVICE counter, so two devices' first ops both carry
// `seq = 1`; append them at the same frozen `created_at` and the canonical
// `(created_at, seq, device_id)` total order has nothing left to sort on but
// `device_id`. No fixture anywhere seeded that shape before #3646, so every
// `, device_id DESC` in the four hand-copied UNION-ALL scans in
// `super::batch` — and in the four single-op scans they mirror — could be
// deleted with the whole suite staying green.
//
// Each test below drives BOTH kernels over the same fixture, so one mutation
// reddens whichever copy it was made to: the single-op scan
// (`agaric_store::op_log::latest_block_edit_before` / `find_prior_position` /
// `find_prior_property` / `attachment_ops::reverse_delete_attachment`) or the
// batch copy (`fetch_prior_text_batch` / `fetch_prior_position_batch` /
// `fetch_prior_property_batch` / `fetch_prior_attachment_batch`).
//
// # Why every test runs the fixture TWICE
//
// Strip `, device_id DESC` and the `LIMIT 1` winner is left to SQLite's row
// order — which is not one behaviour but several, because each of these
// scans gets a different plan. Measured while writing this: the text and
// position scans returned the LAST-written of the tied pair, the attachment
// scan (partial index `idx_op_log_attachment_id`) the FIRST. A fixture that
// fixes one write order therefore catches only some of the mutations — the
// first pass of this work seeded winner-first and left two of the four batch
// copies still undetectable.
//
// So [`TIE_ORDERS`] runs each fixture under both write orders on a fresh
// pool, and asserts the SAME winner both times. That is exactly the property
// at stake — the tie-break decides, not the row order — and it makes the
// assertion independent of which plan SQLite happens to pick, today or after
// an index change. (The property scan is the one case where no write order
// can redden the mutation; see that test's doc for why, and why the clause
// stays regardless.)
//
// `TIE_WINNER` / `TIE_LOSER` collide; `TIE_ANCHOR` authors the op being
// reversed. It is appended at the SAME `(created_at, seq)` as the pair and
// sorts ABOVE both, so the bound's `device_id < ?` component is what admits
// the two candidates at all — the `ORDER BY` then picks between them. One
// fixture, both halves of the tie-break.
const TIE_WINNER: &str = "tie-dev-b";
const TIE_LOSER: &str = "tie-dev-a";
const TIE_ANCHOR: &str = "tie-dev-z";
const TIE_ORDERS: [[&str; 2]; 2] = [[TIE_WINNER, TIE_LOSER], [TIE_LOSER, TIE_WINNER]];

/// Reverse `(TIE_ANCHOR, 1)` through both kernels and assert they agree,
/// returning the payload. Parity is asserted here so each tie-break test
/// below only has to state the ONE answer the canonical order requires.
async fn reverse_anchor_both_kernels(pool: &SqlitePool) -> OpPayload {
    let single = compute_reverse(pool, TIE_ANCHOR, 1)
        .await
        .expect("single-op kernel must reverse the anchor op");
    let refs = vec![agaric_store::op::OpRef {
        device_id: TIE_ANCHOR.to_string(),
        seq: 1,
    }];
    let records = crate::reverse::get_op_records_batch(pool, &refs)
        .await
        .unwrap();
    let batched = crate::reverse::compute_reverse_batch(pool, &records)
        .await
        .expect("batch kernel must not fail at batch level")
        .pop()
        .expect("one op in, one result out")
        .expect("batch kernel must reverse the anchor op");
    assert_eq!(
        single, batched,
        "the two kernels must resolve the cross-device collision identically"
    );
    batched
}

/// #382/#3646: `fetch_prior_text_batch` and the single-op `StrictlyBefore`
/// scan must both break an equal-`(created_at, seq)` cross-device tie on
/// `device_id DESC`.
///
/// The anchor edit deliberately carries `prev_edit: None` — with a resolving
/// causal pointer `resolve_prior_text` never consults the timestamp scan at
/// all (and, since #3650, the batch kernel does not even issue it), so the
/// tie-break would be unreachable.
#[tokio::test]
async fn reverse_edit_tie_breaks_on_device_id_3646() {
    for write_order in TIE_ORDERS {
        let (pool, _dir) = test_pool().await;
        for dev in write_order {
            append_local_op_at(
                &pool,
                dev,
                OpPayload::EditBlock(EditBlockPayload {
                    block_id: BlockId::test_id("TIETXT"),
                    to_text: format!("from {dev}"),
                    prev_edit: None,
                }),
                FIXED_TS,
            )
            .await
            .unwrap();
        }
        append_local_op_at(
            &pool,
            TIE_ANCHOR,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("TIETXT"),
                to_text: "anchor".into(),
                prev_edit: None,
            }),
            FIXED_TS,
        )
        .await
        .unwrap();

        match reverse_anchor_both_kernels(&pool).await {
            OpPayload::EditBlock(p) => assert_eq!(
                p.to_text,
                format!("from {TIE_WINNER}"),
                "#382: the prior-text scan must tie-break on device_id DESC \
                 (write order {write_order:?})"
            ),
            other => panic!("expected EditBlock, got {other:?}"),
        }
    }
}

/// #382/#3646: same collision, on the `move_block` prior-placement scan —
/// `fetch_prior_position_batch` and `block_ops::find_prior_position`.
#[tokio::test]
async fn reverse_move_tie_breaks_on_device_id_3646() {
    // Parent + slot are keyed off the device so the winner is identifiable
    // from the reverse payload alone.
    let slot = |dev: &str| if dev == TIE_WINNER { 7_i64 } else { 3 };
    let parent = |dev: &str| {
        if dev == TIE_WINNER { "TIEPB" } else { "TIEPA" }
    };
    for write_order in TIE_ORDERS {
        let (pool, _dir) = test_pool().await;
        for dev in write_order {
            append_local_op_at(
                &pool,
                dev,
                OpPayload::MoveBlock(MoveBlockPayload {
                    block_id: BlockId::test_id("TIEMOV"),
                    new_parent_id: Some(BlockId::test_id(parent(dev))),
                    new_position: slot(dev),
                    new_index: None,
                }),
                FIXED_TS,
            )
            .await
            .unwrap();
        }
        append_local_op_at(
            &pool,
            TIE_ANCHOR,
            OpPayload::MoveBlock(MoveBlockPayload {
                block_id: BlockId::test_id("TIEMOV"),
                new_parent_id: Some(BlockId::test_id("TIEPZ")),
                new_position: 9,
                new_index: None,
            }),
            FIXED_TS,
        )
        .await
        .unwrap();

        match reverse_anchor_both_kernels(&pool).await {
            OpPayload::MoveBlock(p) => {
                assert_eq!(
                    p.new_parent_id.as_ref().map(|id| id.as_str().to_string()),
                    Some(BlockId::test_id(parent(TIE_WINNER)).as_str().to_string()),
                    "#382: the prior-placement scan must tie-break on device_id DESC \
                     (write order {write_order:?})"
                );
                assert_eq!(
                    p.new_position,
                    slot(TIE_WINNER),
                    "must restore the winner's slot (write order {write_order:?})"
                );
            }
            other => panic!("expected MoveBlock, got {other:?}"),
        }
    }
}

/// #382/#3646: same collision, on the property prior-value scan —
/// `fetch_prior_property_batch` and `property_ops::find_prior_property`.
///
/// Unlike its three siblings this test does NOT redden when `, device_id
/// DESC` is deleted from either copy, and that is a fact about the schema
/// rather than a hole in the fixture: both statements are served by
/// `idx_op_log_block_key_created`, whose key ends in `… created_at, seq,
/// device_id`, so the index supplies the tie-break the `ORDER BY` asked for
/// and the mutated statement returns the identical row (checked with
/// `EXPLAIN QUERY PLAN`). The assertion still pins the RESOLUTION — which is
/// what #3646 asked for — and would catch any change that made the two scans
/// disagree with each other or with the canonical order.
#[tokio::test]
async fn reverse_set_property_tie_breaks_on_device_id_3646() {
    for write_order in TIE_ORDERS {
        let (pool, _dir) = test_pool().await;
        for dev in write_order {
            append_local_op_at(
                &pool,
                dev,
                OpPayload::SetProperty(SetPropertyPayload {
                    block_id: BlockId::test_id("TIEPROP"),
                    key: "priority".into(),
                    value_text: Some(format!("from {dev}")),
                    value_num: None,
                    value_date: None,
                    value_ref: None,
                    value_bool: None,
                }),
                FIXED_TS,
            )
            .await
            .unwrap();
        }
        append_local_op_at(
            &pool,
            TIE_ANCHOR,
            OpPayload::SetProperty(SetPropertyPayload {
                block_id: BlockId::test_id("TIEPROP"),
                key: "priority".into(),
                value_text: Some("anchor".into()),
                value_num: None,
                value_date: None,
                value_ref: None,
                value_bool: None,
            }),
            FIXED_TS,
        )
        .await
        .unwrap();

        match reverse_anchor_both_kernels(&pool).await {
            OpPayload::SetProperty(p) => assert_eq!(
                p.value_text,
                Some(format!("from {TIE_WINNER}")),
                "#382: the prior-property scan must tie-break on device_id DESC \
                 (write order {write_order:?})"
            ),
            other => panic!("expected SetProperty, got {other:?}"),
        }
    }
}

/// #382/#3646: same collision, on the attachment prior-add scan —
/// `fetch_prior_attachment_batch` and
/// `attachment_ops::reverse_delete_attachment`.
///
/// Two `add_attachment` rows for one `attachment_id` is a shape production
/// does not mint; it is the minimal way to put two candidates in front of a
/// scan whose predicate is `attachment_id` + the strictly-before bound, which
/// is exactly what the tie-break exists to arbitrate.
#[tokio::test]
async fn reverse_delete_attachment_tie_breaks_on_device_id_3646() {
    for write_order in TIE_ORDERS {
        let (pool, _dir) = test_pool().await;
        for dev in write_order {
            append_local_op_at(
                &pool,
                dev,
                OpPayload::AddAttachment(AddAttachmentPayload {
                    attachment_id: BlockId::test_id("TIEATT"),
                    block_id: BlockId::test_id("TIEABLK"),
                    mime_type: "image/png".into(),
                    filename: format!("from-{dev}.png"),
                    size_bytes: 1024,
                    fs_path: format!("/tmp/from-{dev}.png"),
                }),
                FIXED_TS,
            )
            .await
            .unwrap();
        }
        append_local_op_at(
            &pool,
            TIE_ANCHOR,
            OpPayload::DeleteAttachment(DeleteAttachmentPayload {
                attachment_id: BlockId::test_id("TIEATT"),
                fs_path: "/tmp/anchor.png".into(),
            }),
            FIXED_TS,
        )
        .await
        .unwrap();

        match reverse_anchor_both_kernels(&pool).await {
            OpPayload::AddAttachment(p) => assert_eq!(
                p.filename,
                format!("from-{TIE_WINNER}.png"),
                "#382: the prior-add scan must tie-break on device_id DESC \
                 (write order {write_order:?})"
            ),
            other => panic!("expected AddAttachment, got {other:?}"),
        }
    }
}
