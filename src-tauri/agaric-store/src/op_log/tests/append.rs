//! Append basics and all-op-type coverage.
//!
//! Split out of the former `op_log/mod.rs` `#[cfg(test)] mod tests` block (#1659).

use super::*;

// ── Append basics ────────────────────────────────────────────────────

#[tokio::test]
async fn append_first_op_has_seq_1_and_null_parents() {
    let (pool, _dir) = test_pool().await;

    let record = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-FIRST"),
        FIXED_TS,
    )
    .await
    .unwrap();

    assert_eq!(record.seq, 1, "first op must have seq 1");
    assert!(
        record.parent_seqs.is_none(),
        "genesis op must have null parent_seqs"
    );
    assert_eq!(
        record.op_type, "create_block",
        "op_type should be create_block"
    );
    assert_eq!(
        record.device_id, TEST_DEVICE,
        "device_id should match test device"
    );
    assert_eq!(record.hash.len(), 64, "hash must be 64 hex chars");
}

#[tokio::test]
async fn second_op_references_first_as_parent() {
    let (pool, _dir) = test_pool().await;

    let r1 = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-PARENT"),
        FIXED_TS,
    )
    .await
    .unwrap();
    assert_eq!(r1.seq, 1, "first op should have seq 1");

    let p2 = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::test_id("BLK-PARENT"),
        to_text: "world".into(),
        prev_edit: None,
    });
    let r2 = append_local_op_at(&pool, TEST_DEVICE, p2, FIXED_TS)
        .await
        .unwrap();

    assert_eq!(r2.seq, 2, "second op must have seq 2");
    let parent_seqs = r2.parsed_parent_seqs().unwrap().unwrap();
    assert_eq!(parent_seqs.len(), 1, "should reference exactly one parent");
    assert_eq!(parent_seqs[0].0, TEST_DEVICE, "parent device must match");
    assert_eq!(parent_seqs[0].1, 1, "parent seq must be 1");
}

#[tokio::test]
async fn separate_devices_have_independent_seqs() {
    let (pool, _dir) = test_pool().await;

    let r1 = append_local_op_at(&pool, "device-A", make_create_payload("BLK-A"), FIXED_TS)
        .await
        .unwrap();
    let r2 = append_local_op_at(&pool, "device-B", make_create_payload("BLK-B"), FIXED_TS)
        .await
        .unwrap();

    assert_eq!(r1.seq, 1, "device-A first op must be seq 1");
    assert_eq!(r2.seq, 1, "device-B first op must also be seq 1");
}

// ── All op types ──────────────────────────────────────────────────────

/// Every op type should append successfully and produce the correct
/// `op_type` string in the stored record. (#652: count-free name — the
/// fixture list is the source of truth.)
#[tokio::test]
async fn all_op_types_append_successfully() {
    let (pool, _dir) = test_pool().await;

    for (expected_type, payload) in all_op_payloads() {
        let record = append_local_op(&pool, "dev-all", payload).await.unwrap();
        assert_eq!(
            record.op_type, expected_type,
            "op_type mismatch for variant {expected_type}"
        );
        assert_eq!(record.hash.len(), 64, "hash should be 64 hex chars");
    }
}

/// Appending 10 ops sequentially must yield seq numbers 1..=10 with no
/// gaps and each `parent_seqs` referencing the previous.
#[tokio::test]
async fn sequential_ops_produce_consecutive_seqs() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=10_i64 {
        let payload = make_create_payload(&format!("BLK{i:04}"));
        let rec = append_local_op_at(&pool, "seq-dev", payload, FIXED_TS)
            .await
            .unwrap();
        assert_eq!(rec.seq, i, "expected seq {i}");

        if i == 1 {
            assert!(
                rec.parent_seqs.is_none(),
                "genesis op must have null parents"
            );
        } else {
            let parents = rec.parsed_parent_seqs().unwrap().unwrap();
            assert_eq!(
                parents,
                vec![("seq-dev".to_string(), i - 1)],
                "parent_seqs mismatch at seq {i}"
            );
        }
    }
}

/// Append an op, read it back via `get_op_by_seq`, and verify the payload
/// JSON deserializes to the same inner struct.
#[tokio::test]
async fn payload_json_roundtrips_via_db() {
    let (pool, _dir) = test_pool().await;

    let original = CreateBlockPayload {
        block_id: BlockId::test_id("BLK-RT"),
        block_type: "heading".into(),
        parent_id: Some(BlockId::test_id("ROOT")),
        position: Some(42),
        index: None,
        content: "round-trip test".into(),
    };
    let record = append_local_op(&pool, "dev-rt", OpPayload::CreateBlock(original.clone()))
        .await
        .unwrap();

    // Read back from DB
    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "dev-rt", 1)
        .await
        .unwrap();
    assert_eq!(
        fetched.payload, record.payload,
        "DB payload should match appended payload"
    );

    // Deserialize the stored JSON back to the payload struct
    let deserialized: CreateBlockPayload = serde_json::from_str(&fetched.payload).unwrap();
    assert_eq!(
        deserialized.block_id, "BLK-RT",
        "block_id should round-trip"
    );
    assert_eq!(
        deserialized.block_type, "heading",
        "block_type should round-trip"
    );
    assert_eq!(
        deserialized.parent_id,
        Some(BlockId::test_id("ROOT")),
        "parent_id should round-trip"
    );
    assert_eq!(
        deserialized.position,
        Some(42),
        "position should round-trip"
    );
    assert_eq!(
        deserialized.content, "round-trip test",
        "content should round-trip"
    );
}

/// Tripwire: documents the contract that `append_local_op_in_tx`
/// requires its caller to open the transaction with `BEGIN IMMEDIATE`,
/// and exercises the happy path end-to-end with two serial appends
/// inside one IMMEDIATE tx.
///
/// Under `BEGIN DEFERRED` (the sqlx default for `pool.begin()`), the
/// read-`MAX(seq)` + INSERT pair can race against a concurrent
/// committer for the same `device_id`, producing
/// `SQLITE_BUSY_SNAPSHOT`. The IMMEDIATE wrap eagerly acquires the
/// write lock so this race window is closed at the tx boundary.
///
/// The real contention-regression net is
/// [`concurrent_appends_same_device_serialize_correctly`] below — if
/// a future change accidentally drops the IMMEDIATE wrap from
/// [`append_local_op_at`], that test starts producing duplicate or
/// non-contiguous seqs under load. This test is the "static" contract
/// witness: the documented sequence works exactly as the doc-block
/// claims.
#[tokio::test]
async fn l5_immediate_tx_contract_serial_appends() {
    let (pool, _dir) = test_pool().await;

    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let r1 = append_local_op_in_tx(
        &mut tx,
        TEST_DEVICE,
        make_create_payload("BLK-L5A"),
        FIXED_TS,
    )
    .await
    .expect("append #1 must succeed inside a BEGIN IMMEDIATE tx");
    let r2 = append_local_op_in_tx(
        &mut tx,
        TEST_DEVICE,
        make_create_payload("BLK-L5B"),
        FIXED_TS,
    )
    .await
    .expect("append #2 must succeed inside a BEGIN IMMEDIATE tx");
    tx.commit().await.expect("IMMEDIATE tx must commit cleanly");

    assert_eq!(
        (r1.seq, r2.seq),
        (1, 2),
        "serial appends inside one IMMEDIATE tx must produce contiguous seqs"
    );
}

/// Fire 10 concurrent appends from the same device; all should succeed and
/// produce a contiguous, duplicate-free seq range 1..=10.
///
/// SQLite serialises writers, so concurrent tasks contend for the write
/// lock. The retry loop with back-off proves the transaction logic is safe
/// under contention — no sequence gaps or duplicates.
#[tokio::test]
async fn concurrent_appends_same_device_serialize_correctly() {
    let (pool, _dir) = test_pool().await;

    let mut handles = Vec::new();
    for i in 0..10 {
        let pool = pool.clone();
        handles.push(tokio::spawn(async move {
            loop {
                let payload = make_create_payload(&format!("BLK-C{i:03}"));
                match append_local_op_at(&pool, "dev-conc", payload, FIXED_TS).await {
                    Ok(rec) => return rec,
                    // Issue #106 split `Database` and `PoolTimedOut`
                    // into distinct variants; either signals SQLite
                    // busy / writer contention from this test's
                    // perspective, both are retryable.
                    Err(AppError::Database(_) | AppError::PoolTimedOut) => {
                        // Back-off and retry — SQLite busy under contention.
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    Err(e) => panic!("unexpected error: {e}"),
                }
            }
        }));
    }

    let mut seqs: Vec<i64> = Vec::new();
    for h in handles {
        seqs.push(h.await.unwrap().seq);
    }
    seqs.sort_unstable();
    assert_eq!(
        seqs,
        (1..=10).collect::<Vec<i64>>(),
        "concurrent appends must produce contiguous seq range"
    );
}
