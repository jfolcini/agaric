//! Blake3 hash computation for op log entries.
//!
//! Each op log row stores a content-addressable hash of its fields so that
//! replicas can detect corruption or tampering during sync.
/// Compute the blake3 hash of an op log entry.
///
/// The hash input is the concatenation of all fields separated by null bytes
/// (`\0`) to avoid ambiguity:
///
/// ```text
/// blake3(device_id \0 seq \0 parent_seqs_canonical \0 op_type \0 payload_canonical)
/// ```
///
/// **Wire format contract:** The `\0` delimiter layout above is the
/// cross-implementation hash contract. Any future client (mobile, web, sync
/// server) **must** produce the same byte sequence for the same inputs, or
/// hash verification will fail during sync. Do not change the field order,
/// delimiter, or encoding without a coordinated migration across all
/// implementations.
///
/// - `parent_seqs`: The raw JSON string from the `parent_seqs` column, or `None`
///   for the genesis op (seq 1). When `None`, the empty string is used in the
///   hash input. When `Some`, the JSON array should already have entries sorted
///   lexicographically by `[device_id, seq]`.
/// - `payload`: The canonical JSON string of the op payload (keys ordered
///   alphabetically via `serde_json::to_value` → BTreeMap). **All ULID fields in the payload MUST be
///   uppercase Crockford base32 before hashing** — call
///   `OpPayload::normalize_block_ids()` before serialization.
///   `append_local_op_in_tx` enforces this automatically.
///
/// Returns the hash as a lowercase hex string (64 chars for blake3's 256-bit
/// output).
#[inline]
#[must_use]
pub fn compute_op_hash(
    device_id: &str,
    seq: i64,
    parent_seqs: Option<&str>,
    op_type: &str,
    payload: &str,
) -> String {
    let parent_seqs_canonical = parent_seqs.unwrap_or("");

    debug_assert!(
        !device_id.contains('\0'),
        "device_id must not contain null bytes"
    );
    debug_assert!(
        !parent_seqs_canonical.contains('\0'),
        "parent_seqs must not contain null bytes"
    );
    debug_assert!(
        !op_type.contains('\0'),
        "op_type must not contain null bytes"
    );
    // payload: serde_json serializes \0 as \\u0000, so raw \0 indicates corruption
    debug_assert!(
        !payload.contains('\0'),
        "serialized payload must not contain raw null bytes"
    );

    // Format seq into a stack buffer to avoid the heap allocation that
    // `i64::to_string()` would incur on every call.
    let mut seq_buf = [0u8; 20]; // i64 max decimal repr is 20 chars (incl. sign)
    let seq_len = {
        let mut cursor = std::io::Cursor::new(&mut seq_buf[..]);
        std::io::Write::write_fmt(&mut cursor, format_args!("{seq}"))
            .expect("i64 decimal fits in 20-byte buffer");
        cursor.position() as usize
    };

    let mut hasher = blake3::Hasher::new();
    hasher.update(device_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(&seq_buf[..seq_len]);
    hasher.update(b"\0");
    hasher.update(parent_seqs_canonical.as_bytes());
    hasher.update(b"\0");
    hasher.update(op_type.as_bytes());
    hasher.update(b"\0");
    hasher.update(payload.as_bytes());

    // `to_hex()` returns a stack-allocated `ArrayString<64>`;
    // `.to_string()` is the single heap allocation for the return value.
    hasher.finalize().to_hex().to_string()
}

/// Verify that an [`OpRecord`]'s stored hash matches its recomputed hash.
///
/// Returns `Ok(())` if the hash is valid, or `Err` with a human-readable
/// message describing the mismatch (device_id, seq, expected vs actual).
///
/// Prefer this over [`verify_op_hash`] when you already have an `OpRecord`
/// — it avoids having to destructure the fields at every call site.
pub fn verify_op_record(record: &crate::op_log::OpRecord) -> Result<(), String> {
    let expected = compute_op_hash(
        &record.device_id,
        record.seq,
        record.parent_seqs.as_deref(),
        &record.op_type,
        &record.payload,
    );
    if constant_time_eq(expected.as_bytes(), record.hash.as_bytes()) {
        Ok(())
    } else {
        Err(format!(
            "hash mismatch for {}:{} — expected {}, got {}",
            record.device_id, record.seq, expected, record.hash
        ))
    }
}

/// Verify that a stored hash matches the recomputed hash of the given fields.
///
/// Uses constant-time comparison to prevent timing side-channel leaks,
/// even though the inputs are not secret — defence in depth.
#[inline]
#[must_use]
pub fn verify_op_hash(
    stored_hash: &str,
    device_id: &str,
    seq: i64,
    parent_seqs: Option<&str>,
    op_type: &str,
    payload: &str,
) -> bool {
    let computed = compute_op_hash(device_id, seq, parent_seqs, op_type, payload);
    constant_time_eq(stored_hash.as_bytes(), computed.as_bytes())
}

/// Constant-time byte-slice comparison (avoids early-exit on first diff).
///
/// **Note:** The `a.len() != b.len()` early return means this is only truly
/// constant-time for equal-length inputs.  This is safe for our use case
/// (blake3 hex hashes are always exactly 64 bytes) but callers should not
/// assume constant-time behavior for variable-length inputs.
#[inline]
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Tests for `compute_op_hash`, `verify_op_hash`, and `constant_time_eq`.
///
/// Covers determinism, per-field sensitivity, golden vectors, edge cases
/// (unicode, empty, large, boundary seq values, embedded null bytes),
/// verification with tampered fields, and constant-time comparison.
#[cfg(test)]
mod tests {
    use super::*;

    // ── Test fixture constants ──────────────────────────────────────────

    const DEV_1: &str = "dev-1";
    const DEV_2: &str = "dev-2";
    const OP_CREATE: &str = "create_block";
    const OP_EDIT: &str = "edit_block";
    const OP_DELETE: &str = "delete_block";
    const EMPTY_JSON: &str = "{}";

    /// Pinned golden hash — detects accidental changes to the hashing scheme.
    /// Input: `compute_op_hash("device-123", 42, Some(r#"[["dev-1",41]]"#), "edit_block",
    ///         r#"{"block_id":"AB","to_text":"hello"}"#)`
    const GOLDEN_HASH: &str = "4ba8948410b19f80a9fd01a3d8820965f72bcef7ceadb798360206e9ec015d3c";

    /// Assert a hash string is a valid 64-char lowercase hex output.
    fn assert_valid_hash(h: &str, ctx: &str) {
        assert_eq!(
            h.len(),
            64,
            "{ctx}: hash length must be 64, got {}",
            h.len()
        );
        assert!(
            h.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "{ctx}: hash must be lowercase hex, got: {h}"
        );
    }

    // ── compute_op_hash: determinism & format ───────────────────────────

    #[test]
    fn compute_op_hash_is_deterministic() {
        let h1 = compute_op_hash(DEV_1, 1, None, OP_CREATE, r#"{"block_id":"X"}"#);
        let h2 = compute_op_hash(DEV_1, 1, None, OP_CREATE, r#"{"block_id":"X"}"#);
        assert_eq!(h1, h2, "identical inputs must produce identical hashes");
    }

    #[test]
    fn compute_op_hash_returns_64_lowercase_hex_chars() {
        let h = compute_op_hash(DEV_1, 1, None, OP_CREATE, EMPTY_JSON);
        assert_valid_hash(&h, "basic");
    }

    // ── compute_op_hash: each field affects the hash ────────────────────

    #[test]
    fn different_device_id_produces_different_hash() {
        let h1 = compute_op_hash(DEV_1, 1, None, OP_CREATE, EMPTY_JSON);
        let h2 = compute_op_hash(DEV_2, 1, None, OP_CREATE, EMPTY_JSON);
        assert_ne!(h1, h2, "different device_id must produce different hashes");
    }

    #[test]
    fn different_seq_produces_different_hash() {
        let h1 = compute_op_hash(DEV_1, 1, None, OP_CREATE, EMPTY_JSON);
        let h2 = compute_op_hash(DEV_1, 2, None, OP_CREATE, EMPTY_JSON);
        assert_ne!(h1, h2, "different seq must produce different hashes");
    }

    #[test]
    fn different_op_types_produce_different_hashes() {
        let h1 = compute_op_hash(DEV_1, 1, None, OP_CREATE, EMPTY_JSON);
        let h2 = compute_op_hash(DEV_1, 1, None, OP_EDIT, EMPTY_JSON);
        let h3 = compute_op_hash(DEV_1, 1, None, OP_DELETE, EMPTY_JSON);
        assert_ne!(h1, h2, "create vs edit");
        assert_ne!(h1, h3, "create vs delete");
        assert_ne!(h2, h3, "edit vs delete");
    }

    #[test]
    fn null_parent_seqs_differs_from_empty_array() {
        let h_none = compute_op_hash(DEV_1, 1, None, OP_CREATE, EMPTY_JSON);
        let h_empty = compute_op_hash(DEV_1, 1, Some("[]"), OP_CREATE, EMPTY_JSON);
        assert_ne!(
            h_none, h_empty,
            "None parent_seqs (genesis) must differ from Some(\"[]\")"
        );
    }

    #[test]
    fn different_parent_seqs_produce_different_hashes() {
        let h1 = compute_op_hash(DEV_1, 3, Some(r#"[["dev-1",2]]"#), OP_EDIT, EMPTY_JSON);
        let h2 = compute_op_hash(DEV_1, 3, Some(r#"[["dev-1",1]]"#), OP_EDIT, EMPTY_JSON);
        assert_ne!(
            h1, h2,
            "different parent_seqs must produce different hashes"
        );
    }

    // ── golden / known-vector ───────────────────────────────────────────

    #[test]
    fn golden_known_vector_detects_hash_scheme_changes() {
        let h = compute_op_hash(
            "device-123",
            42,
            Some(r#"[["dev-1",41]]"#),
            OP_EDIT,
            r#"{"block_id":"AB","to_text":"hello"}"#,
        );
        assert_eq!(
            h, GOLDEN_HASH,
            "golden hash changed — hashing scheme may have been altered"
        );
    }

    // ── edge cases ──────────────────────────────────────────────────────

    #[test]
    fn unicode_inputs_produce_valid_hash() {
        let h = compute_op_hash(
            "日本語デバイス",
            1,
            None,
            OP_CREATE,
            r#"{"text":"こんにちは世界 🌍"}"#,
        );
        assert_valid_hash(&h, "unicode inputs");
    }

    #[test]
    fn empty_inputs_produce_valid_hash() {
        let h = compute_op_hash("", 0, None, "", "");
        assert_valid_hash(&h, "all-empty inputs");
    }

    #[test]
    fn large_payload_over_1mb_produces_valid_hash() {
        let big = "x".repeat(1_100_000);
        let h = compute_op_hash(DEV_1, 1, None, OP_CREATE, &big);
        assert_valid_hash(&h, "1.1 MB payload");
    }

    #[test]
    fn negative_seq_differs_from_positive() {
        let h_neg = compute_op_hash(DEV_1, -1, None, OP_CREATE, EMPTY_JSON);
        let h_pos = compute_op_hash(DEV_1, 1, None, OP_CREATE, EMPTY_JSON);
        assert_ne!(h_neg, h_pos, "negative and positive seq must differ");
        assert_valid_hash(&h_neg, "negative seq");
    }

    #[test]
    fn extreme_seq_values_produce_valid_distinct_hashes() {
        let h_max = compute_op_hash(DEV_1, i64::MAX, None, OP_CREATE, EMPTY_JSON);
        let h_min = compute_op_hash(DEV_1, i64::MIN, None, OP_CREATE, EMPTY_JSON);
        assert_valid_hash(&h_max, "i64::MAX seq");
        assert_valid_hash(&h_min, "i64::MIN seq");
        assert_ne!(
            h_max, h_min,
            "i64::MAX and i64::MIN must produce different hashes"
        );
    }

    /// In debug builds the null-byte debug_assert fires before hashing,
    /// so we expect a panic.
    #[test]
    #[should_panic(expected = "serialized payload must not contain raw null bytes")]
    #[cfg(debug_assertions)]
    fn payload_with_embedded_null_bytes_is_distinct() {
        let _ = compute_op_hash(DEV_1, 1, None, OP_CREATE, "abc\0def");
    }

    /// In release builds (no debug_assertions) the null byte is hashed
    /// normally and must produce a distinct hash from the non-null version.
    #[test]
    #[cfg(not(debug_assertions))]
    fn payload_with_embedded_null_bytes_is_distinct() {
        let h1 = compute_op_hash(DEV_1, 1, None, OP_CREATE, "abc\0def");
        let h2 = compute_op_hash(DEV_1, 1, None, OP_CREATE, "abcdef");
        assert_valid_hash(&h1, "null-byte payload");
        assert_ne!(h1, h2, "embedded null byte must affect the hash");
    }

    // ── verify_op_hash ─────────────────────────────────────────────────

    #[test]
    fn verify_op_hash_returns_true_for_matching_inputs() {
        let h = compute_op_hash(DEV_1, 1, None, OP_CREATE, EMPTY_JSON);
        assert!(
            verify_op_hash(&h, DEV_1, 1, None, OP_CREATE, EMPTY_JSON),
            "verify must return true for matching inputs"
        );
    }

    #[test]
    fn verify_op_hash_rejects_wrong_hash() {
        let zeroes = "0".repeat(64);
        assert!(
            !verify_op_hash(&zeroes, DEV_1, 1, None, OP_CREATE, EMPTY_JSON),
            "verify must return false for an all-zero hash"
        );
    }

    #[test]
    fn verify_op_hash_rejects_tampered_payload() {
        let h = compute_op_hash(DEV_1, 1, None, OP_CREATE, r#"{"ok":true}"#);
        assert!(
            !verify_op_hash(&h, DEV_1, 1, None, OP_CREATE, r#"{"ok":false}"#),
            "verify must detect tampered payload"
        );
    }

    #[test]
    fn verify_op_hash_rejects_tampered_device_id() {
        let h = compute_op_hash(DEV_1, 1, None, OP_CREATE, EMPTY_JSON);
        assert!(
            !verify_op_hash(&h, DEV_2, 1, None, OP_CREATE, EMPTY_JSON),
            "verify must detect tampered device_id"
        );
    }

    #[test]
    fn verify_op_hash_rejects_tampered_seq() {
        let h = compute_op_hash(DEV_1, 1, None, OP_CREATE, EMPTY_JSON);
        assert!(
            !verify_op_hash(&h, DEV_1, 999, None, OP_CREATE, EMPTY_JSON),
            "verify must detect tampered seq"
        );
    }

    #[test]
    fn verify_op_hash_rejects_wrong_length_hash() {
        assert!(
            !verify_op_hash("abc", DEV_1, 1, None, OP_CREATE, EMPTY_JSON),
            "verify must reject hash with wrong length"
        );
    }

    #[test]
    fn verify_op_hash_rejects_empty_hash() {
        assert!(
            !verify_op_hash("", DEV_1, 1, None, OP_CREATE, EMPTY_JSON),
            "verify must reject empty hash string"
        );
    }

    // ── verify_op_record ─────────────────────────────────────────────

    /// Helper: build a valid [`OpRecord`] with a correct hash.
    fn make_valid_record() -> crate::op_log::OpRecord {
        let payload = r#"{"block_id":"AB","text":"hello"}"#;
        let hash = compute_op_hash(DEV_1, 1, None, OP_CREATE, payload);
        crate::op_log::OpRecord {
            device_id: DEV_1.to_string(),
            seq: 1,
            parent_seqs: None,
            hash,
            op_type: OP_CREATE.to_string(),
            payload: payload.to_string(),
            created_at: "2025-01-01T00:00:00+00:00".to_string(),
        }
    }

    #[test]
    fn verify_op_hash_valid() {
        let record = make_valid_record();
        assert!(
            verify_op_record(&record).is_ok(),
            "verify_op_record must return Ok for a correctly-hashed record"
        );
    }

    #[test]
    fn verify_op_hash_detects_tampered_payload() {
        let mut record = make_valid_record();
        record.payload = r#"{"block_id":"AB","text":"TAMPERED"}"#.to_string();
        let result = verify_op_record(&record);
        assert!(result.is_err(), "must detect tampered payload");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("hash mismatch"),
            "error should mention hash mismatch, got: {msg}"
        );
    }

    #[test]
    fn verify_op_hash_detects_tampered_hash() {
        let mut record = make_valid_record();
        record.hash = "0".repeat(64);
        let result = verify_op_record(&record);
        assert!(result.is_err(), "must detect tampered hash");
        let msg = result.unwrap_err();
        assert!(
            msg.contains("hash mismatch"),
            "error should mention hash mismatch, got: {msg}"
        );
    }

    // ── constant_time_eq ───────────────────────────────────────────────

    #[test]
    fn constant_time_eq_equal_slices_returns_true() {
        assert!(constant_time_eq(b"hello", b"hello"));
    }

    #[test]
    fn constant_time_eq_different_content_returns_false() {
        assert!(!constant_time_eq(b"hello", b"world"));
    }

    #[test]
    fn constant_time_eq_different_lengths_returns_false() {
        assert!(!constant_time_eq(b"hello", b"hell"));
    }

    #[test]
    fn constant_time_eq_empty_slices_returns_true() {
        assert!(constant_time_eq(b"", b""));
    }

    // ── debug_assert: null-byte separator ──────────────────────────────

    #[test]
    #[should_panic(expected = "device_id must not contain null bytes")]
    #[cfg(debug_assertions)]
    fn null_byte_debug_assert_fires_for_device_id() {
        let _ = compute_op_hash("dev\0ice", 1, None, "create_block", "{}");
    }

    #[test]
    #[should_panic(expected = "parent_seqs must not contain null bytes")]
    #[cfg(debug_assertions)]
    fn null_byte_debug_assert_fires_for_parent_seqs() {
        let _ = compute_op_hash("dev", 1, Some("abc\0def"), "create_block", "{}");
    }

    #[test]
    #[should_panic(expected = "op_type must not contain null bytes")]
    #[cfg(debug_assertions)]
    fn null_byte_debug_assert_fires_for_op_type() {
        let _ = compute_op_hash("dev", 1, None, "create\0block", "{}");
    }
}

// ===========================================================================
// Property-based tests (proptest)
// ===========================================================================

#[cfg(test)]
mod proptest_tests {
    use super::*;
    use proptest::prelude::*;

    // ── Hash determinism: same inputs → same output ─────────────────────

    proptest! {
        #[test]
        fn compute_op_hash_deterministic(
            device_id in "[a-z0-9-]{10,40}",
            seq in 1i64..10000,
            op_type in "create_block|edit_block|delete_block|add_tag|remove_tag",
            payload in "\\{[a-z_:\" ,0-9]{0,100}\\}",
        ) {
            let hash1 = compute_op_hash(&device_id, seq, None, &op_type, &payload);
            let hash2 = compute_op_hash(&device_id, seq, None, &op_type, &payload);
            prop_assert_eq!(&hash1, &hash2, "identical inputs must produce identical hashes");
        }
    }

    // ── Different inputs → different hashes (collision resistance) ──────

    proptest! {
        #[test]
        fn compute_op_hash_different_seqs_differ(
            device_id in "[a-z0-9-]{10,40}",
            seq1 in 1i64..5000,
            seq2 in 5001i64..10000,
        ) {
            let hash1 = compute_op_hash(&device_id, seq1, None, "edit_block", "{}");
            let hash2 = compute_op_hash(&device_id, seq2, None, "edit_block", "{}");
            prop_assert_ne!(hash1, hash2, "different seq values must produce different hashes");
        }
    }

    // ── Hash output format is always 64-char lowercase hex ──────────────

    proptest! {
        #[test]
        fn compute_op_hash_always_valid_format(
            device_id in "[a-z0-9]{1,20}",
            seq in 0i64..100000,
            payload in "[a-z0-9 ]{0,50}",
        ) {
            let h = compute_op_hash(&device_id, seq, None, "create_block", &payload);
            prop_assert_eq!(h.len(), 64, "hash length must be 64");
            prop_assert!(
                h.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "hash must be lowercase hex, got: {}", h
            );
        }
    }
}
