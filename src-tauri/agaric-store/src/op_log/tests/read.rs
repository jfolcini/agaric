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

// ── #382 / #3646: the cross-device `(created_at, seq)` collision ──────
//
// `seq` is a PER-DEVICE counter, so two devices' first ops both carry
// `seq = 1`; freeze their `created_at` to the same instant and the canonical
// `(created_at, seq, device_id)` order has nothing left to sort on but
// `device_id`. Until #3646 no fixture anywhere seeded that shape, which meant
// every `, device_id DESC` in the codebase — the three [`BlockEditScan`] arms
// plus four hand-copied UNION-ALL scans in the app's `reverse::batch` — could
// be deleted with the whole suite staying green.
//
// Strip the tie-break and the `LIMIT 1` winner falls to SQLite's row order,
// which is plan-dependent: measured across these scans it returns sometimes
// the first-written of the tied pair and sometimes the last. So each test
// below runs its fixture under BOTH write orders on a fresh pool and demands
// the same winner either way — which is the property at stake ("the
// tie-break decides, not the row order") and keeps the assertion honest
// whichever plan SQLite picks.
const TIE_WINNER: &str = "dev-b";
const TIE_LOSER: &str = "dev-a";
const TIE_ORDERS: [[&str; 2]; 2] = [[TIE_WINNER, TIE_LOSER], [TIE_LOSER, TIE_WINNER]];

/// Append two `edit_block` rows for `block_id` colliding on an identical
/// `(created_at, seq)` across the two devices, in `write_order`. Both are
/// locally-authored (`is_replicated = 0`) so the provenance-guarded
/// [`BlockEditScan::StrictlyBefore`] arm can see them too.
async fn seed_cross_device_collision(pool: &SqlitePool, block_id: &str, at: i64, order: [&str; 2]) {
    for dev in order {
        append_local_op_at(
            pool,
            dev,
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id(block_id),
                to_text: format!("from {dev}"),
                prev_edit: None,
            }),
            at,
        )
        .await
        .unwrap();
    }
}

/// #382/#3646: `StrictlyBefore` tie-breaks an equal-`(created_at, seq)`
/// cross-device collision on `device_id DESC`.
///
/// The anchor op is `dev-z`'s, itself at the SAME `(created_at, seq)` as the
/// pair, so BOTH halves of the tie-break are exercised at once: the bound's
/// `device_id < ?4` is what lets the two colliding rows through at all, and
/// the `ORDER BY`'s `device_id DESC` is what picks between them.
#[tokio::test]
async fn latest_block_edit_before_strictly_before_tie_breaks_on_device_id_382() {
    for order in TIE_ORDERS {
        let (pool, _dir) = test_pool().await;
        seed_cross_device_collision(&pool, "BLKTIE", FIXED_TS, order).await;
        // `dev-z` sorts above both, so `(FIXED_TS, 1, dev-z)` is strictly
        // after `(FIXED_TS, 1, dev-b)` and `(FIXED_TS, 1, dev-a)`.
        let anchor = append_local_op_at(
            &pool,
            "dev-z",
            OpPayload::EditBlock(EditBlockPayload {
                block_id: BlockId::test_id("BLKTIE"),
                to_text: "anchor".into(),
                prev_edit: None,
            }),
            FIXED_TS,
        )
        .await
        .unwrap();

        let row = latest_block_edit_before(
            &pool,
            "BLKTIE",
            BlockEditScan::StrictlyBefore {
                created_at: anchor.created_at,
                seq: anchor.seq,
                device_id: &anchor.device_id,
            },
        )
        .await
        .unwrap()
        .expect("both colliding rows are strictly before the anchor");

        assert_eq!(
            row.device_id, TIE_WINNER,
            "#382: an equal-(created_at, seq) cross-device collision must resolve on \
             device_id DESC, not on SQLite's row order (write order {order:?})"
        );
        assert!(
            row.payload.contains(&format!("from {TIE_WINNER}")),
            "winning row's payload must be {TIE_WINNER}'s: {}",
            row.payload
        );
    }
}

/// #3646: `AtOrBefore`'s bound is expressed over `(created_at, seq)` only
/// while its `ORDER BY` tie-breaks on `device_id` — so when two rows collide
/// the bound cannot name one of them, and the tie-break decides.
///
/// That is the documented resolution (see [`BlockEditScan::AtOrBefore`]), not
/// an accident: whichever of the two colliding rows the history panel offered
/// the user, the preview snaps to the higher `device_id`. Pin it, because
/// without `, device_id DESC` the answer falls back to SQLite's row order.
#[tokio::test]
async fn latest_block_edit_before_at_or_before_resolves_collision_on_device_id_3646() {
    for order in TIE_ORDERS {
        let (pool, _dir) = test_pool().await;
        seed_cross_device_collision(&pool, "BLKAOB", FIXED_TS, order).await;

        // The caller can only ever pass `(created_at, seq)` — identical for
        // both rows — so there is exactly one query to make, and its answer
        // must be the tie-break winner rather than whichever row SQLite
        // reaches first.
        let row = latest_block_edit_before(
            &pool,
            "BLKAOB",
            BlockEditScan::AtOrBefore {
                created_at: FIXED_TS,
                seq: 1,
            },
        )
        .await
        .unwrap()
        .expect("the inclusive bound admits both colliding rows");

        assert_eq!(
            row.device_id, TIE_WINNER,
            "#3646: AtOrBefore admits both halves of a (created_at, seq) collision, so \
             device_id DESC — not SQLite's row order — must decide which one it returns \
             (write order {order:?})"
        );
        assert!(
            row.payload.contains(&format!("from {TIE_WINNER}")),
            "winning row's payload must be {TIE_WINNER}'s: {}",
            row.payload
        );
    }
}

/// #3655: `LatestCausal` orders on the PER-DEVICE `seq`, so two devices'
/// first edits tie at `seq = 1`. The tie is broken on `device_id DESC` —
/// deterministic, though (as the variant's doc says) not causally meaningful.
/// Pin the determinism; a stamped `prev_edit` that varied with row order
/// would make undo non-reproducible.
///
/// Both rows share one `created_at`, which is load-bearing for DETECTION as
/// well as realism: this query is served by `idx_op_log_block_created`
/// (`block_id, created_at`), so the un-tie-broken sorter is fed rows in
/// `created_at` order. Give the two devices different timestamps and the
/// winner is decided by wall-clock rather than write order — which made an
/// earlier draft of this test miss the mutation under both write orders.
#[tokio::test]
async fn latest_block_edit_before_latest_causal_tie_breaks_on_device_id_3655() {
    for order in TIE_ORDERS {
        let (pool, _dir) = test_pool().await;
        for dev in order {
            append_local_op_at(
                &pool,
                dev,
                OpPayload::EditBlock(EditBlockPayload {
                    block_id: BlockId::test_id("BLKCAU"),
                    to_text: format!("from {dev}"),
                    prev_edit: None,
                }),
                FIXED_TS,
            )
            .await
            .unwrap();
        }

        let row = latest_block_edit_before(&pool, "BLKCAU", BlockEditScan::LatestCausal)
            .await
            .unwrap()
            .expect("both rows are candidates for the unbounded causal scan");

        assert_eq!(
            row.device_id, TIE_WINNER,
            "#3655: per-device seq ties across devices; device_id DESC must resolve it \
             deterministically so prev_edit stamping is reproducible (write order {order:?})"
        );
    }
}
