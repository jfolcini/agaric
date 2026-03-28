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
pub fn compute_op_hash(
    device_id: &str,
    seq: i64,
    parent_seqs: Option<&str>,
    op_type: &str,
    payload: &str,
) -> String {
    let parent_seqs_canonical = parent_seqs.unwrap_or("");

    let mut hasher = blake3::Hasher::new();
    hasher.update(device_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(seq.to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(parent_seqs_canonical.as_bytes());
    hasher.update(b"\0");
    hasher.update(op_type.as_bytes());
    hasher.update(b"\0");
    hasher.update(payload.as_bytes());

    hasher.finalize().to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic() {
        let h1 = compute_op_hash("dev-1", 1, None, "create_block", r#"{"block_id":"X"}"#);
        let h2 = compute_op_hash("dev-1", 1, None, "create_block", r#"{"block_id":"X"}"#);
        assert_eq!(h1, h2);
    }

    #[test]
    fn hash_is_64_hex_chars() {
        let h = compute_op_hash("dev-1", 1, None, "create_block", "{}");
        assert_eq!(h.len(), 64);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
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
}
