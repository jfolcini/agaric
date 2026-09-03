//! Undo / redo append wrappers (#3443).
//!
//! `append_local_undo_op_in_tx` and `append_local_redo_op_in_tx` are called
//! only from the app crate's `commands::history`, so nothing in the crate
//! that provides them pinned the provenance columns they differ on.

use super::*;

/// The three provenance columns the two wrappers differ on.
///
/// Runtime (untyped) query, matching the sibling read-backs in
/// `tests::append`: it adds no `.sqlx` offline-cache entries.
async fn provenance(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
) -> (i64, Option<String>, Option<i64>) {
    use sqlx::Row as _;
    let row = sqlx::query(
        "SELECT is_undo, reverses_device_id, reverses_seq FROM op_log \
         WHERE device_id = ? AND seq = ?",
    )
    .bind(device_id)
    .bind(seq)
    .fetch_one(pool)
    .await
    .unwrap();
    (row.get(0), row.get(1), row.get(2))
}

/// Reddens if the undo wrapper stops stamping `is_undo = 1`, or stamps
/// `reverses_*` from anywhere but its `reverses` argument — which names a
/// foreign device, so the appending device's own address cannot satisfy it.
#[tokio::test]
async fn undo_append_flags_is_undo_and_links_reversed_op_3443() {
    let (pool, _dir) = test_pool().await;
    append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-UNDO"),
        FIXED_TS,
    )
    .await
    .unwrap();

    let reverses = OpRef {
        device_id: "peer-device".into(),
        seq: 7,
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let undo = append_local_undo_op_in_tx(
        &mut tx,
        TEST_DEVICE,
        OpPayload::DeleteBlock(DeleteBlockPayload {
            block_id: BlockId::test_id("BLK-UNDO"),
        }),
        FIXED_TS,
        &reverses,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(undo.seq, 2, "the undo op continues the device chain");
    assert_eq!(
        provenance(&pool, TEST_DEVICE, undo.seq).await,
        (1, Some("peer-device".to_owned()), Some(7)),
        "undo append stamps is_undo = 1 and the reversed op's ref"
    );
}

/// Reddens if the redo wrapper stamps `is_undo = 1` (which would make its
/// forward-equivalent output redo-visible), drops the `reverses_*` link to
/// the undo op it reverses, or stops chaining its hash over the parent link.
#[tokio::test]
async fn redo_append_is_forward_equivalent_and_links_reversed_op_3443() {
    let (pool, _dir) = test_pool().await;
    append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-REDO"),
        FIXED_TS,
    )
    .await
    .unwrap();

    let reverses = OpRef {
        device_id: TEST_DEVICE.into(),
        seq: 1,
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let redo = append_local_redo_op_in_tx(
        &mut tx,
        TEST_DEVICE,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK-REDO"),
            to_text: "reapplied".into(),
            prev_edit: None,
        }),
        FIXED_TS,
        &reverses,
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();

    assert_eq!(redo.seq, 2, "the redo op continues the device chain");
    assert_eq!(
        provenance(&pool, TEST_DEVICE, redo.seq).await,
        (0, Some(TEST_DEVICE.to_owned()), Some(1)),
        "redo append stays is_undo = 0 while linking the undo op it reverses"
    );
}
