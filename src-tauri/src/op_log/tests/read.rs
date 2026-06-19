//! Read-helper and timestamp-determinism tests.
//!
//! Split out of the former `op_log/mod.rs` `#[cfg(test)] mod tests` block (#1659).

use super::*;

// ── Read helpers ──────────────────────────────────────────────────────

#[tokio::test]
async fn get_op_by_seq_returns_correct_record() {
    let (pool, _dir) = test_pool().await;

    let appended = append_local_op_at(&pool, "dev-get", make_create_payload("BLK-G"), FIXED_TS)
        .await
        .unwrap();

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "dev-get", 1)
        .await
        .unwrap();
    assert_eq!(fetched.device_id, appended.device_id, "device_id mismatch");
    assert_eq!(fetched.seq, appended.seq, "seq mismatch");
    assert_eq!(fetched.hash, appended.hash, "hash mismatch");
    assert_eq!(fetched.op_type, appended.op_type, "op_type mismatch");
    assert_eq!(fetched.payload, appended.payload, "payload mismatch");
    assert_eq!(
        fetched.created_at, appended.created_at,
        "created_at mismatch"
    );
}

#[tokio::test]
async fn get_op_by_seq_returns_not_found_for_missing_record() {
    let (pool, _dir) = test_pool().await;

    let err = get_op_by_seq(&ReadPool(pool.clone()), "ghost-device", 999).await;
    assert!(err.is_err(), "missing record should return an error");
    let msg = err.unwrap_err().to_string();
    assert!(
        msg.contains("Not found"),
        "expected NotFound error, got: {msg}"
    );
}

#[tokio::test]
async fn get_latest_seq_empty_returns_zero() {
    let (pool, _dir) = test_pool().await;

    let seq = get_latest_seq(&ReadPool(pool.clone()), "empty-device")
        .await
        .unwrap();
    assert_eq!(seq, 0, "empty device must have latest seq 0");
}

#[tokio::test]
async fn get_latest_seq_after_appends() {
    let (pool, _dir) = test_pool().await;

    for i in 0..5 {
        let payload = make_create_payload(&format!("BLK-LS{i}"));
        append_local_op_at(&pool, "dev-ls", payload, FIXED_TS)
            .await
            .unwrap();
    }
    let seq = get_latest_seq(&ReadPool(pool.clone()), "dev-ls")
        .await
        .unwrap();
    assert_eq!(seq, 5, "latest seq after 5 appends must be 5");
}

#[tokio::test]
async fn get_ops_since_returns_correct_subset() {
    let (pool, _dir) = test_pool().await;

    for i in 0..10 {
        let payload = make_create_payload(&format!("BLK-S{i:02}"));
        append_local_op_at(&pool, "dev-since", payload, FIXED_TS)
            .await
            .unwrap();
    }

    // Get ops after seq 7 → should be seqs 8, 9, 10 in ascending order
    let ops = get_ops_since(&ReadPool(pool.clone()), "dev-since", 7)
        .await
        .unwrap();
    assert_eq!(ops.len(), 3, "expected 3 ops after seq 7");
    assert_eq!(ops[0].seq, 8, "first returned op should be seq 8");
    assert_eq!(ops[1].seq, 9, "second returned op should be seq 9");
    assert_eq!(ops[2].seq, 10, "third returned op should be seq 10");

    // Get ops after seq 0 → all 10
    let all = get_ops_since(&ReadPool(pool.clone()), "dev-since", 0)
        .await
        .unwrap();
    assert_eq!(all.len(), 10, "after_seq=0 should return all ops");

    // Get ops after seq 10 → empty
    let none = get_ops_since(&ReadPool(pool.clone()), "dev-since", 10)
        .await
        .unwrap();
    assert!(none.is_empty(), "after_seq=max should return no ops");
}

#[tokio::test]
async fn get_ops_since_different_device_is_isolated() {
    let (pool, _dir) = test_pool().await;

    for i in 0..3 {
        let payload = make_create_payload(&format!("BLK-A{i}"));
        append_local_op_at(&pool, "dev-A", payload, FIXED_TS)
            .await
            .unwrap();
    }

    let ops = get_ops_since(&ReadPool(pool.clone()), "dev-B", 0)
        .await
        .unwrap();
    assert!(ops.is_empty(), "device-B should see no ops from device-A");
}

// ── Timestamp determinism ─────────────────────────────────────────────

/// `append_local_op_at` should store the exact caller-provided timestamp
/// rather than the current wall-clock time.
#[tokio::test]
async fn append_local_op_at_stores_exact_timestamp() {
    let (pool, _dir) = test_pool().await;

    // 2025-06-01T12:00:00Z in epoch-ms.
    let fixed_ts: i64 = 1_748_779_200_000;
    let record = append_local_op_at(&pool, "dev-ts", make_create_payload("BLK-TS"), fixed_ts)
        .await
        .unwrap();

    assert_eq!(
        record.created_at, fixed_ts,
        "returned record must have the exact provided timestamp"
    );

    let fetched = get_op_by_seq(&ReadPool(pool.clone()), "dev-ts", 1)
        .await
        .unwrap();
    assert_eq!(
        fetched.created_at, fixed_ts,
        "DB-stored timestamp must match the provided value"
    );
}
