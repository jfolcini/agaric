//! `resolve_prev_edit_target` (#3443).
//!
//! The causal `prev_edit` pointer resolver is called only from the app crate's
//! `reverse::block_ops`, so nothing in the crate that provides it pinned what
//! it resolves — including the deliberate absence of an `is_replicated`
//! predicate that `reverse::batch`'s batched copy mirrors.

use super::*;

/// Reddens if the resolver stops returning the pointed-at op's own
/// `(op_type, payload)` — a different row, a different column, or a constant.
#[tokio::test]
async fn resolve_prev_edit_target_returns_pointed_at_op_3443() {
    let (pool, _dir) = test_pool().await;
    let created = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-PREV"),
        FIXED_TS,
    )
    .await
    .unwrap();
    let edited = append_local_op_at(
        &pool,
        TEST_DEVICE,
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK-PREV"),
            to_text: "second".into(),
            prev_edit: None,
        }),
        FIXED_TS,
    )
    .await
    .unwrap();

    assert_eq!(
        resolve_prev_edit_target(&ReadPool(pool.clone()), TEST_DEVICE, created.seq)
            .await
            .unwrap(),
        Some((created.op_type, created.payload)),
        "the pointer must resolve to the create op it names"
    );
    assert_eq!(
        resolve_prev_edit_target(&ReadPool(pool.clone()), TEST_DEVICE, edited.seq)
            .await
            .unwrap(),
        Some((edited.op_type, edited.payload)),
        "resolving the later seq must return that op, not the earlier one"
    );
}

/// Reddens if a pointer with no row stops resolving to `None` (compaction is
/// the only way that happens), or if the `device_id` predicate is dropped.
#[tokio::test]
async fn resolve_prev_edit_target_returns_none_for_missing_row_3443() {
    let (pool, _dir) = test_pool().await;
    append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-GONE"),
        FIXED_TS,
    )
    .await
    .unwrap();

    assert_eq!(
        resolve_prev_edit_target(&ReadPool(pool.clone()), TEST_DEVICE, 99)
            .await
            .unwrap(),
        None,
        "a seq this device never issued must resolve to None"
    );
    assert_eq!(
        resolve_prev_edit_target(&ReadPool(pool.clone()), "other-device", 1)
            .await
            .unwrap(),
        None,
        "seq 1 of a device with no ops must resolve to None"
    );
}

/// Reddens if an `is_replicated = 0` predicate is added: a peer-originated
/// block's first local edit points at its audit row, and refusing that
/// pointer leaves undo with no reconstruction source at all (#3644).
#[tokio::test]
async fn resolve_prev_edit_target_resolves_replicated_audit_row_3443() {
    let (pool, _dir) = test_pool().await;
    let record = OpRecord {
        device_id: "peer-device".into(),
        seq: 4,
        parent_seqs: None,
        hash: "a".repeat(64),
        op_type: "create_block".into(),
        payload: r#"{"block_id":"BLK-PEER","content":"peer text"}"#.into(),
        created_at: FIXED_TS,
        block_id: None,
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let inserted = ingest_remote_op_in_tx(&mut tx, &record, "user", true)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(inserted, "the audit row must land");

    assert_eq!(
        resolve_prev_edit_target(&ReadPool(pool.clone()), "peer-device", 4)
            .await
            .unwrap(),
        Some((record.op_type, record.payload)),
        "a replicated audit row must resolve — the resolver has no is_replicated predicate"
    );
}
