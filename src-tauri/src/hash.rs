//! Blake3 hash computation for op log entries (ADR-07).
//!
//! Each op log row stores a content-addressable hash of its fields so that
//! replicas can detect corruption or tampering during sync.

#![allow(dead_code)]

/// Compute the blake3 hash of an op log entry.
///
/// The hash input is the concatenation of all fields separated by null bytes
/// (`\0`) to avoid ambiguity:
///
/// ```text
/// blake3(device_id \0 seq \0 parent_seqs_canonical \0 op_type \0 payload_canonical)
/// ```
///
/// - `parent_seqs`: The raw JSON string from the `parent_seqs` column, or `None`
///   for the genesis op (seq 1). When `None`, the empty string is used in the
///   hash input. When `Some`, the JSON array should already have entries sorted
///   lexicographically by `[device_id, seq]`.
/// - `payload`: The canonical JSON string of the op payload (keys ordered by
///   serde's derive order).
///
/// Returns the hash as a lowercase hex string (64 chars for blake3's 256-bit
/// output).
#[inline]
pub fn compute_op_hash(
    device_id: &str,
    seq: i64,
    parent_seqs: Option<&str>,
    op_type: &str,
    payload: &str,
) -> String {
    let parent_seqs_canonical = parent_seqs.unwrap_or("");

    // Format seq into a stack buffer to avoid the heap allocation that
    // `i64::to_string()` would incur on every call.
    let mut seq_buf = [0u8; 20]; // i64 max decimal repr is 20 chars (incl. sign)
    let seq_len = {
        let mut cursor = std::io::Cursor::new(&mut seq_buf[..]);
        std::io::Write::write_fmt(&mut cursor, format_args!("{seq}")).unwrap();
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

/// Verify that a stored hash matches the recomputed hash of the given fields.
///
/// Uses constant-time comparison to prevent timing side-channel leaks,
/// even though the inputs are not secret — defence in depth.
#[inline]
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── determinism & basic properties ──────────────────────────────────

    #[test]
    fn hash_is_deterministic() {
        let h1 = compute_op_hash("dev-1", 1, None, "create_block", r#"{"block_id":"X"}"#);
        let h2 = compute_op_hash("dev-1", 1, None, "create_block", r#"{"block_id":"X"}"#);
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_is_64_lowercase_hex_chars() {
        let h = compute_op_hash("dev-1", 1, None, "create_block", "{}");
        assert_eq!(h.len(), 64, "hash length must be 64");
        assert!(
            h.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "hash must be lowercase hex, got: {h}"
        );
    }

    #[test]
    fn different_inputs_produce_different_hashes() {
        let h1 = compute_op_hash("dev-1", 1, None, "create_block", "{}");
        let h2 = compute_op_hash("dev-1", 2, None, "create_block", "{}");
        let h3 = compute_op_hash("dev-2", 1, None, "create_block", "{}");
        assert_ne!(h1, h2);
        assert_ne!(h1, h3);
    }

    #[test]
    fn null_parent_seqs_vs_empty_array() {
        // None (genesis) and Some("[]") must produce different hashes
        let h_none = compute_op_hash("dev-1", 1, None, "create_block", "{}");
        let h_empty = compute_op_hash("dev-1", 1, Some("[]"), "create_block", "{}");
        assert_ne!(h_none, h_empty);
    }

    #[test]
    fn parent_seqs_included_in_hash() {
        let h1 = compute_op_hash("dev-1", 3, Some(r#"[["dev-1",2]]"#), "edit_block", "{}");
        let h2 = compute_op_hash("dev-1", 3, Some(r#"[["dev-1",1]]"#), "edit_block", "{}");
        assert_ne!(h1, h2);
    }

    // ── golden / known-vector test ─────────────────────────────────────

    #[test]
    fn golden_known_vector() {
        // Pre-computed golden value — if the hashing scheme ever changes this
        // test will catch it.  Regenerate with:
        //   blake3("device-123\042\0[["dev-1",41]]\0edit_block\0{"block_id":"AB","to_text":"hello"}")
        let h = compute_op_hash(
            "device-123",
            42,
            Some(r#"[["dev-1",41]]"#),
            "edit_block",
            r#"{"block_id":"AB","to_text":"hello"}"#,
        );
        // We'll fill the real value after running once.  For now assert format.
        assert_eq!(h.len(), 64);
        // Pin the golden value (computed by this implementation):
        let expected = compute_op_hash(
            "device-123",
            42,
            Some(r#"[["dev-1",41]]"#),
            "edit_block",
            r#"{"block_id":"AB","to_text":"hello"}"#,
        );
        assert_eq!(h, expected, "golden hash must be stable across runs");

        // Hard-coded golden value (set after first successful run).
        // To regenerate: run this test, copy the printed hash, paste here.
        let golden = &GOLDEN_HASH;
        assert_eq!(
            h, *golden,
            "golden hash changed — hashing scheme may have been altered"
        );
    }

    /// Hard-coded golden hash for the known-vector test.
    /// Computed once and pinned to detect accidental hashing-scheme changes.
    const GOLDEN_HASH: &str = "4ba8948410b19f80a9fd01a3d8820965f72bcef7ceadb798360206e9ec015d3c";

    // ── Unicode & edge cases ───────────────────────────────────────────

    #[test]
    fn unicode_device_id_and_payload() {
        let h = compute_op_hash(
            "日本語デバイス",
            1,
            None,
            "create_block",
            r#"{"text":"こんにちは世界 🌍"}"#,
        );
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));

        // Must be deterministic with unicode
        let h2 = compute_op_hash(
            "日本語デバイス",
            1,
            None,
            "create_block",
            r#"{"text":"こんにちは世界 🌍"}"#,
        );
        assert_eq!(h, h2);
    }

    #[test]
    fn empty_strings_for_all_fields() {
        let h = compute_op_hash("", 0, None, "", "");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn large_payload_over_1mb() {
        let big = "x".repeat(1_100_000); // ~1.1 MB
        let h = compute_op_hash("dev-1", 1, None, "create_block", &big);
        assert_eq!(h.len(), 64);
        // Hash must still be deterministic
        let h2 = compute_op_hash("dev-1", 1, None, "create_block", &big);
        assert_eq!(h, h2);
    }

    #[test]
    fn negative_seq_works() {
        let h = compute_op_hash("dev-1", -1, None, "create_block", "{}");
        assert_eq!(h.len(), 64);
        // Negative and positive must differ
        let h_pos = compute_op_hash("dev-1", 1, None, "create_block", "{}");
        assert_ne!(h, h_pos);
    }

    #[test]
    fn different_op_types_produce_different_hashes() {
        let h1 = compute_op_hash("dev-1", 1, None, "create_block", "{}");
        let h2 = compute_op_hash("dev-1", 1, None, "edit_block", "{}");
        let h3 = compute_op_hash("dev-1", 1, None, "delete_block", "{}");
        assert_ne!(h1, h2);
        assert_ne!(h1, h3);
        assert_ne!(h2, h3);
    }

    // ── verify_op_hash ─────────────────────────────────────────────────

    #[test]
    fn verify_op_hash_returns_true_for_matching() {
        let h = compute_op_hash("dev-1", 1, None, "create_block", "{}");
        assert!(verify_op_hash(&h, "dev-1", 1, None, "create_block", "{}"));
    }

    #[test]
    fn verify_op_hash_returns_false_for_wrong_hash() {
        assert!(!verify_op_hash(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "dev-1",
            1,
            None,
            "create_block",
            "{}"
        ));
    }

    #[test]
    fn verify_op_hash_returns_false_for_tampered_payload() {
        let h = compute_op_hash("dev-1", 1, None, "create_block", r#"{"ok":true}"#);
        // Same hash but different payload → must fail
        assert!(!verify_op_hash(
            &h,
            "dev-1",
            1,
            None,
            "create_block",
            r#"{"ok":false}"#
        ));
    }

    #[test]
    fn verify_op_hash_rejects_wrong_length() {
        assert!(!verify_op_hash(
            "abc",
            "dev-1",
            1,
            None,
            "create_block",
            "{}"
        ));
    }

    // ── constant_time_eq unit tests ────────────────────────────────────

    #[test]
    fn constant_time_eq_basics() {
        assert!(constant_time_eq(b"hello", b"hello"));
        assert!(!constant_time_eq(b"hello", b"world"));
        assert!(!constant_time_eq(b"hello", b"hell"));
        assert!(constant_time_eq(b"", b""));
    }
}
