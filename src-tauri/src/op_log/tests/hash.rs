//! Hash-chain integrity tests.
//!
//! Split out of the former `op_log/mod.rs` `#[cfg(test)] mod tests` block (#1659).

use super::*;

// ── Hash integrity ────────────────────────────────────────────────────

/// Read a record from the DB with `get_op_by_seq` and recompute the blake3
/// hash from the stored columns — it must match the stored hash.
#[tokio::test]
async fn hash_verification_from_db_read() {
    let (pool, _dir) = test_pool().await;

    // Insert two ops to exercise both null and non-null parent_seqs
    for payload in [
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::test_id("BLK-H1"),
            block_type: "content".into(),
            parent_id: None,
            position: None,
            index: None,
            content: "first".into(),
        }),
        OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::test_id("BLK-H1"),
            to_text: "second".into(),
            prev_edit: None,
        }),
    ] {
        append_local_op(&pool, "dev-hash", payload).await.unwrap();
    }

    for seq in 1..=2 {
        let rec = get_op_by_seq(&ReadPool(pool.clone()), "dev-hash", seq)
            .await
            .unwrap();
        let recomputed = crate::hash::compute_op_hash(
            &rec.device_id,
            rec.seq,
            rec.parent_seqs.as_deref(),
            &rec.op_type,
            &rec.payload,
        );
        assert_eq!(rec.hash, recomputed, "hash mismatch for seq {seq}");
    }
}

/// #1693 — End-to-end tamper detection on a *stored* op record.
///
/// `verify_op_record` is intentionally NOT wired into production (the
/// single-user/local-first threat model at `hash.rs` leaves it unwired on
/// purpose). The gap this closes is test coverage: every existing
/// `verify_op_record` test hand-builds an `OpRecord`, so none proves that
/// a real appended-then-read-back row is (a) accepted while pristine and
/// (b) rejected once a hash-covered column is mutated.
///
/// The op hash covers exactly `device_id`, `seq`, `parent_seqs`, `op_type`,
/// and `payload` (see `compute_op_hash` in `hash.rs`). `created_at`, the
/// `hash` column itself, and the Rust-only `block_id` sidecar are NOT part
/// of the preimage. This test pins both halves: mutating a covered field
/// trips the verifier; mutating an uncovered field does not.
#[tokio::test]
async fn verify_op_record_detects_tamper_on_stored_op() {
    let (pool, _dir) = test_pool().await;

    // (1) Produce a real op record and read it back from storage.
    append_local_op_at(
        &pool,
        "dev-tamper",
        make_create_payload("BLK-TMP"),
        FIXED_TS,
    )
    .await
    .unwrap();
    let pristine = get_op_by_seq(&ReadPool(pool.clone()), "dev-tamper", 1)
        .await
        .unwrap();

    // (2) The pristine stored record must verify.
    assert!(
        crate::hash::verify_op_record(&pristine).is_ok(),
        "pristine stored op must pass verification"
    );

    // (3) Mutating any hash-covered field must be DETECTED.
    // payload (covered)
    {
        let mut tampered = pristine.clone();
        tampered.payload = r#"{"block_id":"BLK-TMP","tampered":true}"#.to_string();
        let err = crate::hash::verify_op_record(&tampered)
            .expect_err("tampered payload must fail verification");
        assert!(
            err.contains("hash mismatch"),
            "expected hash-mismatch error, got: {err}"
        );
    }
    // device_id (covered)
    {
        let mut tampered = pristine.clone();
        tampered.device_id = "dev-evil".to_string();
        assert!(
            crate::hash::verify_op_record(&tampered).is_err(),
            "tampered device_id must fail verification"
        );
    }
    // seq (covered)
    {
        let mut tampered = pristine.clone();
        tampered.seq = 999;
        assert!(
            crate::hash::verify_op_record(&tampered).is_err(),
            "tampered seq must fail verification"
        );
    }
    // op_type (covered)
    {
        let mut tampered = pristine.clone();
        tampered.op_type = "edit_block".to_string();
        assert!(
            crate::hash::verify_op_record(&tampered).is_err(),
            "tampered op_type must fail verification"
        );
    }

    // (4) Mutating a field OUTSIDE the hash preimage must NOT trip it —
    // this pins exactly what the hash protects.
    // created_at (not covered)
    {
        let mut untouched = pristine.clone();
        untouched.created_at = pristine.created_at + 86_400_000;
        assert!(
            crate::hash::verify_op_record(&untouched).is_ok(),
            "mutating created_at (outside the hash preimage) must NOT trip verification"
        );
    }
    // block_id sidecar (not covered — Rust-only cached field)
    {
        let mut untouched = pristine.clone();
        untouched.block_id = Some("DIFFERENT".to_string());
        assert!(
            crate::hash::verify_op_record(&untouched).is_ok(),
            "mutating the block_id sidecar (outside the hash preimage) must NOT trip verification"
        );
    }
}
