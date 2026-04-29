//! Tests for `BlockId` newtype: construction, parsing, normalization,
//! trait impls (Display, AsRef, From, Eq, Hash, Default, Serialize/Deserialize),
//! and the `AttachmentId`/`SnapshotId` type aliases.

use super::*;
use std::collections::HashSet;

/// A known-valid ULID in canonical uppercase Crockford base32 (from the ULID spec).
const FIXTURE_ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
/// Same ULID in lowercase, for normalization tests.
const FIXTURE_ULID_LOWER: &str = "01arz3ndektsv4rrffq69g5fav";
/// A second distinct valid ULID for inequality/uniqueness tests.
const FIXTURE_ULID_OTHER: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

// --- BlockId::new ---

#[test]
fn new_produces_26_char_uppercase_crockford_base32() {
    let id = BlockId::new();
    let s = id.as_str();
    assert_eq!(s.len(), 26, "ULID must be exactly 26 characters");
    assert!(
        s.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
        "ULID must be uppercase Crockford base32, got '{s}'"
    );
}

#[test]
fn new_produces_unique_ids_on_consecutive_calls() {
    let a = BlockId::new();
    let b = BlockId::new();
    assert_ne!(
        a, b,
        "consecutive BlockId::new() calls must produce distinct IDs"
    );
}

// --- BlockId::from_string: happy paths ---

#[test]
fn from_string_accepts_valid_uppercase_ulid() {
    let id = BlockId::from_string(FIXTURE_ULID).expect("valid uppercase ULID should parse");
    assert_eq!(
        id.as_str(),
        FIXTURE_ULID,
        "should preserve canonical uppercase form"
    );
}

#[test]
fn from_string_normalizes_lowercase_to_uppercase() {
    let id = BlockId::from_string(FIXTURE_ULID_LOWER).expect("lowercase ULID should parse");
    assert_eq!(
        id.as_str(),
        FIXTURE_ULID,
        "should normalize lowercase to uppercase"
    );
}

#[test]
fn from_string_normalizes_mixed_case_to_uppercase() {
    let mixed = "01Arz3NdEkTsV4RrFfQ69G5FaV";
    let id = BlockId::from_string(mixed).expect("mixed-case ULID should parse");
    assert_eq!(
        id.as_str(),
        FIXTURE_ULID,
        "should normalize mixed case to uppercase"
    );
}

#[test]
fn from_string_accepts_owned_string() {
    let owned = String::from(FIXTURE_ULID);
    let id = BlockId::from_string(owned).expect("owned String should be accepted");
    assert_eq!(id.as_str(), FIXTURE_ULID);
}

// --- BlockId::from_string: error paths ---

#[test]
fn from_string_rejects_empty_input() {
    let err = BlockId::from_string("").expect_err("empty string is not a valid ULID");
    assert!(
        matches!(err, crate::error::AppError::Ulid(_)),
        "should be Ulid error variant"
    );
}

#[test]
fn from_string_rejects_garbage_input() {
    let err =
        BlockId::from_string("definitely-not-a-ulid").expect_err("garbage is not a valid ULID");
    assert!(
        matches!(err, crate::error::AppError::Ulid(_)),
        "should be Ulid error variant"
    );
}

#[test]
fn from_string_rejects_too_short_input() {
    let err = BlockId::from_string("01ARZ3NDEK").expect_err("10 chars is too short for a ULID");
    assert!(
        matches!(err, crate::error::AppError::Ulid(_)),
        "should be Ulid error variant"
    );
}

#[test]
fn from_string_rejects_too_long_input() {
    let too_long = format!("{FIXTURE_ULID}X");
    let err = BlockId::from_string(too_long).expect_err("27 chars is too long for a ULID");
    assert!(
        matches!(err, crate::error::AppError::Ulid(_)),
        "should be Ulid error variant"
    );
}

#[test]
fn from_string_rejects_non_ascii_input() {
    let err = BlockId::from_string("01ARZ3NDEKTSV4RRFFQ69G5F\u{00FC}")
        .expect_err("non-ASCII characters should be rejected");
    assert!(
        matches!(err, crate::error::AppError::Ulid(_)),
        "should be Ulid error variant"
    );
}

#[test]
fn from_string_error_message_includes_invalid_input() {
    let bad_input = "BADINPUT";
    let err = BlockId::from_string(bad_input).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains(bad_input),
        "error message should include the rejected input, got: {msg}"
    );
}

// --- Display ---

#[test]
fn display_returns_inner_ulid_string() {
    let id = BlockId::from_string(FIXTURE_ULID).unwrap();
    assert_eq!(
        format!("{id}"),
        FIXTURE_ULID,
        "Display should output the inner ULID"
    );
}

// --- AsRef<str> ---

#[test]
fn as_ref_returns_inner_str_slice() {
    let id = BlockId::from_string(FIXTURE_ULID).unwrap();
    let r: &str = id.as_ref();
    assert_eq!(r, FIXTURE_ULID, "AsRef<str> should return the inner ULID");
}

// --- as_str / into_string / From<BlockId> for String ---

#[test]
fn as_str_matches_display_and_as_ref() {
    let id = BlockId::from_string(FIXTURE_ULID).unwrap();
    let display = format!("{id}");
    let as_ref: &str = id.as_ref();
    assert_eq!(id.as_str(), display, "as_str and Display must agree");
    assert_eq!(id.as_str(), as_ref, "as_str and AsRef must agree");
}

#[test]
fn into_string_consumes_and_returns_inner() {
    let id = BlockId::from_string(FIXTURE_ULID).unwrap();
    assert_eq!(
        id.into_string(),
        FIXTURE_ULID,
        "into_string() should return the inner ULID"
    );
}

#[test]
fn from_block_id_into_string_matches_inner() {
    let id = BlockId::from_string(FIXTURE_ULID).unwrap();
    let s: String = id.into();
    assert_eq!(
        s, FIXTURE_ULID,
        "From<BlockId> for String should return the inner ULID"
    );
}

// --- Default ---

#[test]
fn default_produces_valid_parseable_ulid() {
    let id = BlockId::default();
    assert_eq!(id.as_str().len(), 26, "default ULID must be 26 chars");
    BlockId::from_string(id.as_str()).expect("default ULID should round-trip through from_string");
}

// --- PartialEq / Eq ---

#[test]
fn eq_holds_for_identical_ulid_values() {
    let a = BlockId::from_string(FIXTURE_ULID).unwrap();
    let b = BlockId::from_string(FIXTURE_ULID).unwrap();
    assert_eq!(a, b, "BlockIds from the same ULID must be equal");
}

#[test]
fn eq_case_normalized_lowercase_equals_uppercase() {
    let upper = BlockId::from_string(FIXTURE_ULID).unwrap();
    let lower = BlockId::from_string(FIXTURE_ULID_LOWER).unwrap();
    assert_eq!(
        upper, lower,
        "case-normalized BlockIds from same ULID must be equal"
    );
}

#[test]
fn ne_holds_for_different_ulid_values() {
    let a = BlockId::from_string(FIXTURE_ULID).unwrap();
    let b = BlockId::from_string(FIXTURE_ULID_OTHER).unwrap();
    assert_ne!(a, b, "BlockIds from different ULIDs must not be equal");
}

// --- Hash ---

#[test]
fn hash_is_consistent_for_equal_ids() {
    let a = BlockId::from_string(FIXTURE_ULID).unwrap();
    let b = BlockId::from_string(FIXTURE_ULID_LOWER).unwrap();
    let mut set = HashSet::new();
    set.insert(a);
    assert!(
        !set.insert(b),
        "inserting an equal BlockId into a HashSet should return false (duplicate)"
    );
}

#[test]
fn hash_set_stores_distinct_ids_separately() {
    let a = BlockId::from_string(FIXTURE_ULID).unwrap();
    let b = BlockId::from_string(FIXTURE_ULID_OTHER).unwrap();
    let mut set = HashSet::new();
    set.insert(a);
    set.insert(b);
    assert_eq!(set.len(), 2, "HashSet should contain both distinct IDs");
}

// --- Serialize / Deserialize ---

#[test]
fn serde_roundtrip_preserves_value() {
    let id = BlockId::from_string(FIXTURE_ULID).unwrap();
    let json = serde_json::to_string(&id).expect("BlockId should serialize to JSON");
    let back: BlockId = serde_json::from_str(&json).expect("BlockId should deserialize from JSON");
    assert_eq!(id, back, "serde round-trip must preserve the value");
}

#[test]
fn serialize_produces_bare_json_string() {
    let id = BlockId::from_string(FIXTURE_ULID).unwrap();
    let json = serde_json::to_string(&id).unwrap();
    let expected = format!("\"{FIXTURE_ULID}\"");
    assert_eq!(
        json, expected,
        "serde(transparent) should emit a bare JSON string"
    );
}

#[test]
fn deserialize_from_json_string_literal() {
    let json = format!("\"{FIXTURE_ULID}\"");
    let id: BlockId = serde_json::from_str(&json).expect("should deserialize from a JSON string");
    assert_eq!(
        id.as_str(),
        FIXTURE_ULID,
        "deserialized value should match fixture"
    );
}

// --- Type aliases ---

#[test]
fn attachment_id_alias_is_interchangeable_with_block_id() {
    let att: AttachmentId = BlockId::from_string(FIXTURE_ULID).unwrap();
    assert_eq!(
        att.as_str(),
        FIXTURE_ULID,
        "AttachmentId is a type alias for BlockId"
    );
}

#[test]
fn snapshot_id_alias_is_interchangeable_with_block_id() {
    let snap: SnapshotId = BlockId::from_string(FIXTURE_ULID).unwrap();
    assert_eq!(
        snap.as_str(),
        FIXTURE_ULID,
        "SnapshotId is a type alias for BlockId"
    );
}

// --- F01: Deserialization normalization ---

#[test]
fn deserialize_normalizes_lowercase_to_uppercase() {
    let json = format!("\"{FIXTURE_ULID_LOWER}\"");
    let id: BlockId = serde_json::from_str(&json).expect("lowercase ULID should deserialize");
    assert_eq!(
        id.as_str(),
        FIXTURE_ULID,
        "deserialization must normalize lowercase to uppercase"
    );
}

#[test]
fn deserialize_normalizes_mixed_case_to_uppercase() {
    let mixed = "\"01Arz3NdEkTsV4RrFfQ69G5FaV\"";
    let id: BlockId = serde_json::from_str(mixed).expect("mixed-case ULID should deserialize");
    assert_eq!(
        id.as_str(),
        FIXTURE_ULID,
        "deserialization must normalize mixed case to uppercase"
    );
}

#[test]
fn deserialize_accepts_any_string_and_uppercases() {
    let json = "\"not-a-ulid\"";
    let result: BlockId = serde_json::from_str(json).unwrap();
    assert_eq!(
        result.as_str(),
        "NOT-A-ULID",
        "deserialization is lenient — just uppercases, validation is at the API boundary"
    );
}

#[test]
fn deserialize_roundtrip_preserves_normalization() {
    let lower_json = format!("\"{FIXTURE_ULID_LOWER}\"");
    let id: BlockId = serde_json::from_str(&lower_json).unwrap();
    let reserialized = serde_json::to_string(&id).unwrap();
    let expected = format!("\"{FIXTURE_ULID}\"");
    assert_eq!(
        reserialized, expected,
        "round-trip through serde must produce uppercase"
    );
}

// --- REVIEW-LATER #61 edge-case tests ---

/// Case normalization is idempotent: normalizing an already-uppercase ULID
/// produces the same result as normalizing it a second time.
#[test]
fn case_normalization_is_idempotent() {
    // Start from lowercase
    let id = BlockId::from_string(FIXTURE_ULID_LOWER).unwrap();
    let normalized_once = id.as_str().to_string();

    // Normalize again
    let id2 = BlockId::from_string(&normalized_once).unwrap();
    let normalized_twice = id2.as_str().to_string();

    assert_eq!(
        normalized_once, normalized_twice,
        "normalizing an already-normalized ULID must be idempotent"
    );
    assert_eq!(normalized_once, FIXTURE_ULID);
}

/// Comparison ordering matches ULID monotonicity: a ULID with an earlier
/// timestamp component sorts lexicographically before one with a later
/// timestamp.
#[test]
fn comparison_ordering_matches_monotonicity() {
    // FIXTURE_ULID starts with "01AR..." and FIXTURE_ULID_OTHER with "01BX..."
    // The first 10 chars encode the timestamp; "01AR..." < "01BX..." means
    // FIXTURE_ULID has an earlier timestamp and should sort first.
    let earlier = BlockId::from_string(FIXTURE_ULID).unwrap();
    let later = BlockId::from_string(FIXTURE_ULID_OTHER).unwrap();

    assert!(
        earlier.as_str() < later.as_str(),
        "earlier-timestamp ULID should sort before later-timestamp ULID: {} vs {}",
        earlier.as_str(),
        later.as_str(),
    );
}

/// Display → from_string round-trip preserves the value.
#[test]
fn display_from_string_round_trip() {
    let id = BlockId::new();
    let displayed = format!("{id}");
    let parsed = BlockId::from_string(&displayed).expect("Display output should be a valid ULID");
    assert_eq!(
        parsed.as_str(),
        id.as_str(),
        "Display -> from_string round-trip must preserve the value"
    );
}

/// from_string → Display round-trip for a known fixture.
#[test]
fn from_string_display_round_trip_fixture() {
    let id = BlockId::from_string(FIXTURE_ULID).unwrap();
    let displayed = id.to_string();
    assert_eq!(displayed, FIXTURE_ULID);
    let reparsed = BlockId::from_string(&displayed).unwrap();
    assert_eq!(reparsed.as_str(), FIXTURE_ULID);
}

/// Multiple ULIDs with distinct timestamps maintain strict ordering.
/// Uses `ulid::Ulid::from_parts` to create ULIDs with known timestamps.
#[test]
fn consecutive_ulids_maintain_ordering() {
    let ids: Vec<BlockId> = (0..10)
        .map(|i| {
            // Create ULIDs with increasing timestamps (ms apart)
            let ulid = ulid::Ulid::from_parts(1_000_000_u64 + u64::try_from(i).unwrap(), 0);
            BlockId::from_string(ulid.to_string()).unwrap()
        })
        .collect();
    let strings: Vec<String> = ids.iter().map(|id| id.as_str().to_string()).collect();

    // Verify ordering is non-decreasing
    for window in strings.windows(2) {
        assert!(
            window[0] <= window[1],
            "ULID ordering violated: {} > {}",
            window[0],
            window[1],
        );
    }

    // Verify all are unique
    let unique: std::collections::HashSet<&str> = ids.iter().map(BlockId::as_str).collect();
    assert_eq!(
        unique.len(),
        10,
        "all 10 consecutive ULIDs should be unique"
    );
}

// --- from_trusted normalization ---

#[test]
fn from_trusted_normalizes_to_uppercase() {
    let id = BlockId::from_trusted("abc123");
    assert_eq!(
        id.as_str(),
        "ABC123",
        "from_trusted should normalize lowercase to uppercase"
    );

    let ulid_lower = FIXTURE_ULID_LOWER;
    let id2 = BlockId::from_trusted(ulid_lower);
    assert_eq!(
        id2.as_str(),
        FIXTURE_ULID,
        "from_trusted should normalize a lowercase ULID to uppercase"
    );
}

#[test]
fn from_trusted_uses_ascii_only_uppercase_for_non_ascii() {
    // L-3 — Unicode `to_uppercase()` would map "ß" to "SS", but the
    // Deserialize path uses `to_ascii_uppercase()`, which leaves "ß"
    // untouched. `from_trusted` must match the Deserialize behaviour
    // so the two normalization paths agree on every byte sequence.
    let id = BlockId::from_trusted("ß");
    assert_eq!(
        id.as_str(),
        "ß",
        "from_trusted must use ASCII-only uppercase to match Deserialize"
    );
}

proptest::proptest! {
    /// L-3 — Property test: for any `String s`, the result of
    /// `BlockId::from_trusted(&s)` must agree byte-for-byte with the
    /// result of round-tripping `s` through serde JSON deserialization
    /// (which uses `to_ascii_uppercase()`). Both paths normalize without
    /// validating ULID format, so they must produce identical output.
    #[test]
    fn from_trusted_matches_deserialize_for_arbitrary_strings(s in ".*") {
        let trusted = BlockId::from_trusted(&s);
        let value = serde_json::Value::String(s.clone());
        let deserialized: BlockId = serde_json::from_value(value)
            .expect("BlockId Deserialize accepts any string");
        proptest::prop_assert_eq!(
            trusted.as_str(),
            deserialized.as_str(),
            "from_trusted and Deserialize must produce identical output for input {:?}",
            s
        );
    }
}

// --- I-GCalSpaces-1: ascii-only normalization parity ---

/// I-GCalSpaces-1 — Pin the post-fix behaviour: `from_trusted` uses ASCII-only
/// uppercase. Pre-fix Unicode `to_uppercase()` would have folded `"ß"` to
/// `"SS"` (length change!) and `"ı"` to `"I"`, diverging from the
/// `Deserialize` impl's `to_ascii_uppercase()` and breaking blake3 hash
/// determinism (AGENTS.md invariant #8).
#[test]
fn from_trusted_uses_ascii_uppercase_i_gcalspaces_1() {
    // Pre-fix Unicode behaviour: "ß".to_uppercase() == "SS" (length change).
    // Post-fix: ASCII-only — non-ASCII chars pass through unchanged.
    assert_eq!(BlockId::from_trusted("ß").as_str(), "ß");
    assert_eq!(BlockId::from_trusted("ı").as_str(), "ı");
    // Lowercase ASCII still uppercases.
    assert_eq!(BlockId::from_trusted("abc123").as_str(), "ABC123");
    // Already-uppercase ULIDs are unchanged.
    assert_eq!(
        BlockId::from_trusted("01ARZ3NDEKTSV4RRFFQ69G5FAV").as_str(),
        "01ARZ3NDEKTSV4RRFFQ69G5FAV"
    );
}

/// I-GCalSpaces-1 — `from_trusted` and the `Deserialize` impl must agree
/// byte-for-byte on every input, ASCII or not. Two normalisers meant two
/// ways to break blake3 determinism (AGENTS.md invariant #8); aligning
/// both on `to_ascii_uppercase` keeps the canonical form byte-stable.
#[test]
fn from_trusted_and_deserialize_agree_on_inputs_i_gcalspaces_1() {
    for input in [
        "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "abc",
        "ABC",
        "01arz3ndektsv4rrffq69g5fav", // lowercase that Deserialize would canonicalise
        "ß",                          // non-ASCII — verifies both paths agree on no-Unicode-folding
    ] {
        let from_trusted = BlockId::from_trusted(input);
        // Round-trip through serde-JSON to invoke the Deserialize path.
        let json = serde_json::json!(input).to_string();
        let from_de: BlockId = serde_json::from_str(&json).unwrap();
        assert_eq!(
            from_trusted.as_str(),
            from_de.as_str(),
            "from_trusted and Deserialize must agree on '{input}'"
        );
    }
}
