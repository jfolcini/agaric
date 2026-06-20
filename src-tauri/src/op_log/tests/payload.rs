//! Payload serialization, ULID normalization, validation, snapshots, parent-seq parsing, and canonical JSON ordering.
//!
//! Split out of the former `op_log/mod.rs` `#[cfg(test)] mod tests` block (#1659).

use super::*;

// ── Payload serialization ───────────────────────────────────────────

/// The `payload` column must contain only the inner payload fields,
/// NOT the `op_type` serde tag that [`OpPayload`]'s tagged enum would add.
#[tokio::test]
async fn payload_column_excludes_op_type_tag() {
    let (pool, _dir) = test_pool().await;

    let record = append_local_op_at(&pool, "dev-tag", make_create_payload("BLK-TAG"), FIXED_TS)
        .await
        .unwrap();

    let parsed: serde_json::Value = serde_json::from_str(&record.payload).unwrap();
    assert!(
        parsed.get("op_type").is_none(),
        "payload column must not contain op_type tag, got: {}",
        record.payload
    );
    assert!(
        parsed.get("block_id").is_some(),
        "payload column must contain block_id field"
    );
}

// ── F-01: ULID normalization before serialization ────────────────

/// Verify that `append_local_op_in_tx` normalizes lowercase ULIDs in
/// payloads to uppercase before serialization and hashing.
#[tokio::test]
async fn append_normalizes_ulid_case_in_payload() {
    let (pool, _dir) = test_pool().await;

    // Lowercase ULID — should be uppercased before storage.
    let lower_id = "01arz3ndektsv4rrffq69g5fav";
    let upper_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    let record = append_local_op_at(
        &pool,
        TEST_DEVICE,
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(lower_id).unwrap(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "test".into(),
        }),
        FIXED_TS,
    )
    .await
    .unwrap();

    // The stored payload must contain the uppercase form.
    let parsed: serde_json::Value = serde_json::from_str(&record.payload).unwrap();
    assert_eq!(
        parsed["block_id"].as_str().unwrap(),
        upper_id,
        "stored block_id should be uppercase"
    );
}

/// Two ops with the same logical ULID (different case) must produce
/// identical hashes — ensuring cross-device determinism.
#[tokio::test]
async fn normalized_and_unnormalized_ulid_produce_same_hash() {
    let (pool, _dir) = test_pool().await;

    let lower_id = "01arz3ndektsv4rrffq69g5fav";
    let upper_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    let rec_lower = append_local_op_at(
        &pool,
        "dev-a",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(lower_id).unwrap(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "test".into(),
        }),
        FIXED_TS,
    )
    .await
    .unwrap();

    let rec_upper = append_local_op_at(
        &pool,
        "dev-a",
        OpPayload::CreateBlock(CreateBlockPayload {
            block_id: BlockId::from_string(upper_id).unwrap(),
            block_type: "content".into(),
            parent_id: None,
            position: Some(1),
            index: None,
            content: "test".into(),
        }),
        FIXED_TS,
    )
    .await
    .unwrap();

    // The payloads should be identical (both uppercased).
    assert_eq!(
        rec_lower.payload, rec_upper.payload,
        "payloads should be identical after normalization"
    );

    // Hashes differ only because seq differs (1 vs 2), but the payload
    // portion of the hash input is identical.
    let hash_lower = compute_op_hash("dev-a", 1, None, "create_block", &rec_lower.payload);
    let hash_upper = compute_op_hash("dev-a", 1, None, "create_block", &rec_upper.payload);
    assert_eq!(
        hash_lower, hash_upper,
        "same payload JSON should produce the same hash"
    );
}

/// Regression: `AddAttachmentPayload.attachment_id` is now an
/// `AttachmentId` (alias of `BlockId`), so a payload deserialized from
/// JSON with a lowercase ULID must produce byte-identical canonical
/// payload bytes (and thus an identical `compute_op_hash` digest) to
/// The same payload constructed with the uppercase form. Before
/// the field was a raw `String`, which bypassed the
/// `BlockId`-deserialize uppercase contract and broke blake3
/// hash determinism across devices when one device emitted a
/// lowercased `attachment_id` (AGENTS.md invariant #8).
///
/// Uses the JSON deserialization path because `BlockId::from_trusted`
/// only accepts already-uppercased input by contract.
#[tokio::test]
async fn attachment_id_normalization_lowercase_and_uppercase_produce_same_hash_m1() {
    let lower_id = "01arz3ndektsv4rrffq69g5fav";
    let upper_id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let block_upper = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

    // Same logical payload, only `attachment_id` casing differs.
    let lower_json = format!(
        r#"{{"op_type":"add_attachment","attachment_id":"{lower_id}","block_id":"{block_upper}","mime_type":"image/png","filename":"photo.png","size_bytes":1024,"fs_path":"/tmp/photo.png"}}"#
    );
    let upper_json = format!(
        r#"{{"op_type":"add_attachment","attachment_id":"{upper_id}","block_id":"{block_upper}","mime_type":"image/png","filename":"photo.png","size_bytes":1024,"fs_path":"/tmp/photo.png"}}"#
    );

    let payload_lower: OpPayload = serde_json::from_str(&lower_json).unwrap();
    let payload_upper: OpPayload = serde_json::from_str(&upper_json).unwrap();

    // After deserialization through `BlockId`, the two payloads must be
    // byte-identical at the struct level — this is the invariant the
    // Raw-`String` field violated before.
    assert_eq!(
        payload_lower, payload_upper,
        "lowercase and uppercase attachment_id must deserialize equal"
    );

    // Round-trip through canonical JSON serialization (the same path
    // used by `serialize_inner_payload` on the write side) and confirm
    // the bytes match — this is what feeds `compute_op_hash`.
    let canonical_lower = serialize_inner_payload(&payload_lower).unwrap();
    let canonical_upper = serialize_inner_payload(&payload_upper).unwrap();
    assert_eq!(
        canonical_lower, canonical_upper,
        "canonical payload JSON must be identical regardless of input case"
    );

    // Final invariant: the cross-device hash is identical for both.
    let hash_lower = compute_op_hash("dev-a", 1, None, "add_attachment", &canonical_lower);
    let hash_upper = compute_op_hash("dev-a", 1, None, "add_attachment", &canonical_upper);
    assert_eq!(
        hash_lower, hash_upper,
        "AGENTS.md invariant #8: lowercase and uppercase attachment_id must hash identically"
    );
}

// ── F-02: validate_set_property enforcement ────────────────────────

/// Verify that appending a SetProperty op with zero value fields is
/// rejected at the op_log layer.
#[tokio::test]
async fn append_rejects_set_property_with_zero_values() {
    let (pool, _dir) = test_pool().await;

    let result = append_local_op_at(
        &pool,
        TEST_DEVICE,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK001"),
            key: "status".into(),
            value_text: None,
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        FIXED_TS,
    )
    .await;

    assert!(result.is_err(), "zero value fields should be rejected");
    let err = result.unwrap_err();
    assert!(
        matches!(err, AppError::Validation(_)),
        "expected Validation error, got: {err:?}"
    );
}

/// Verify that appending a SetProperty op with multiple value fields is
/// rejected at the op_log layer.
#[tokio::test]
async fn append_rejects_set_property_with_multiple_values() {
    let (pool, _dir) = test_pool().await;

    let result = append_local_op_at(
        &pool,
        TEST_DEVICE,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK001"),
            key: "status".into(),
            value_text: Some("active".into()),
            value_num: Some(42.0),
            value_date: None,
            value_ref: None,
            value_bool: None,
        }),
        FIXED_TS,
    )
    .await;

    assert!(result.is_err(), "multiple value fields should be rejected");
}

/// Verify that a valid SetProperty op (exactly one value) is accepted.
#[tokio::test]
async fn append_accepts_valid_set_property() {
    let (pool, _dir) = test_pool().await;

    let result = append_local_op_at(
        &pool,
        TEST_DEVICE,
        OpPayload::SetProperty(SetPropertyPayload {
            block_id: BlockId::test_id("BLK001"),
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

    assert!(result.is_ok(), "valid SetProperty should be accepted");
}

// ── insta snapshot tests ───────────────────────────────────────────

/// Snapshot an OpRecord after appending a create_block op.
/// Redacts hash (blake3 is content-dependent but includes device_id/seq
/// which are deterministic — however we redact to keep snapshots stable
/// if the hash algorithm or input format ever changes).
#[tokio::test]
async fn snapshot_op_record_after_create_block() {
    let (pool, _dir) = test_pool().await;

    let record = append_local_op_at(
        &pool,
        TEST_DEVICE,
        make_create_payload("BLK-SNAP"),
        FIXED_TS,
    )
    .await
    .unwrap();

    insta::assert_yaml_snapshot!(record, {
        ".hash" => "[HASH]",
    });
}

/// Snapshot `get_ops_since` result after appending multiple ops.
#[tokio::test]
async fn snapshot_get_ops_since_multiple() {
    let (pool, _dir) = test_pool().await;

    // Append 3 ops
    for i in 1..=3 {
        let payload = make_create_payload(&format!("BLK-MS{i:02}"));
        append_local_op_at(&pool, TEST_DEVICE, payload, FIXED_TS)
            .await
            .unwrap();
    }

    let ops = get_ops_since(&ReadPool(pool.clone()), TEST_DEVICE, 0)
        .await
        .unwrap();

    insta::assert_yaml_snapshot!(ops, {
        "[].hash" => "[HASH]",
    });
}

// ── parsed_parent_seqs ────────────────────────────────────────────────

/// Helper: build a minimal OpRecord for unit tests (no DB needed).
fn make_test_op() -> OpRecord {
    OpRecord {
        device_id: TEST_DEVICE.into(),
        seq: 1,
        parent_seqs: None,
        hash: "0".repeat(64),
        op_type: "create_block".into(),
        payload: "{}".into(),
        created_at: FIXED_TS,
        block_id: None,
    }
}

#[test]
fn parsed_parent_seqs_none_for_genesis() {
    let op = OpRecord {
        parent_seqs: None,
        ..make_test_op()
    };
    assert_eq!(
        op.parsed_parent_seqs().unwrap(),
        None,
        "genesis op should have no parents"
    );
}

#[test]
fn parsed_parent_seqs_parses_single_parent() {
    let op = OpRecord {
        parent_seqs: Some(r#"[["device1",1]]"#.to_string()),
        ..make_test_op()
    };
    assert_eq!(
        op.parsed_parent_seqs().unwrap(),
        Some(vec![("device1".to_string(), 1)]),
        "should parse single parent entry"
    );
}

#[test]
fn parsed_parent_seqs_parses_multi_parent() {
    let op = OpRecord {
        parent_seqs: Some(r#"[["device1",3],["device2",5]]"#.to_string()),
        ..make_test_op()
    };
    let parents = op.parsed_parent_seqs().unwrap().unwrap();
    assert_eq!(parents.len(), 2, "should parse both parent entries");
}

#[test]
fn parsed_parent_seqs_error_on_malformed() {
    let op = OpRecord {
        parent_seqs: Some("not json".to_string()),
        ..make_test_op()
    };
    assert!(
        op.parsed_parent_seqs().is_err(),
        "malformed JSON should return error"
    );
}

/// I-Core-11: pin `serde_json::to_string` over a single-entry
/// `[(device_id, prev_seq)]` slice as byte-identical to the legacy
/// `format!(r#"[["{}",{}]]"#, ...)` shape for UUID device_ids.
///
/// The single-parent path in `append_local_op_in_tx` was migrated from
/// the hand-rolled `format!` (which silently assumed a JSON-safe
/// `device_id`) to `serde_json::to_string`. The migration must NOT
/// change the on-disk `parent_seqs` byte content for UUID device_ids,
/// because the hash preimage embeds `parent_seqs` verbatim and any
/// drift would invalidate every previously-stored hash. This test
/// also pins the lack of whitespace in serde_json's array output so a
/// future serde_json release can't silently insert spaces.
#[test]
fn parent_seqs_serialisation_byte_identical_to_format_macro_i_core_11() {
    let device_id = "00000000-0000-0000-0000-000000000001";
    let prev_seq: i64 = 42;

    let legacy = format!(r#"[["{device_id}",{prev_seq}]]"#);
    let migrated = serde_json::to_string(&[(device_id.to_string(), prev_seq)]).unwrap();

    assert_eq!(
        legacy, migrated,
        "serde_json::to_string output must be byte-identical to the legacy \
             format! shape for UUID device_ids — any drift invalidates every \
             previously-stored op hash"
    );
    // Belt-and-braces: pin the exact literal so a future serde_json
    // release that adds whitespace or reorders tuple elements is
    // caught immediately.
    assert_eq!(
        migrated, r#"[["00000000-0000-0000-0000-000000000001",42]]"#,
        "parent_seqs JSON shape must be `[[\"<uuid>\",<seq>]]` with no whitespace"
    );
}

// ── Canonical JSON ordering ─────────────────────────────────────────

/// Verify that `serialize_inner_payload` produces keys in alphabetical
/// order for a `CreateBlockPayload` (whose declaration order differs from
/// alphabetical).
#[test]
fn canonical_json_keys_are_sorted() {
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::test_id("BLK001"),
        block_type: "content".into(),
        parent_id: None,
        position: Some(1),
        index: None,
        content: "hello".into(),
    });
    let json = serialize_inner_payload(&payload).unwrap();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let obj = value.as_object().unwrap();
    let keys: Vec<&String> = obj.keys().collect();
    let mut sorted_keys = keys.clone();
    sorted_keys.sort();
    assert_eq!(keys, sorted_keys, "JSON keys must be in alphabetical order");
}

/// Verify that all 12 payload types produce JSON with alphabetically
/// sorted keys when serialized through `serialize_inner_payload`.
#[test]
fn canonical_json_deterministic_across_all_payload_types() {
    for (op_type_name, payload) in all_op_payloads() {
        let json = serialize_inner_payload(&payload).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = value
            .as_object()
            .unwrap_or_else(|| panic!("{op_type_name}: expected JSON object"));
        let keys: Vec<&String> = obj.keys().collect();
        let mut sorted_keys = keys.clone();
        sorted_keys.sort();
        assert_eq!(
            keys, sorted_keys,
            "{op_type_name}: JSON keys must be in alphabetical order, got: {keys:?}"
        );
    }
}
