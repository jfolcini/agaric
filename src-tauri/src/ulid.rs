use serde::Serialize;
use std::fmt;
use std::str::FromStr;

/// Newtype wrapper around ULID for type safety and consistent serialisation.
/// Stores the canonical uppercase Crockford base32 representation.
///
/// Primary type for block IDs. Type aliases below provide semantic names for
/// non-block entity IDs (attachments, snapshots) that are also ULIDs.
///
/// **Deserialization normalizes to uppercase Crockford base32** — any valid
/// ULID string (lowercase, mixed-case) is accepted and stored in canonical
/// uppercase form. This is critical for blake3 hash determinism (ADR-07).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct BlockId(String);

impl<'de> serde::Deserialize<'de> for BlockId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        // Lenient: uppercase-normalize without ULID validation.
        // Validation happens at the API boundary via `from_string`.
        // This must accept any string stored by `from_trusted` / `test_id`.
        Ok(Self(s.to_ascii_uppercase()))
    }
}

/// Alias for attachment entity IDs (also ULIDs, same underlying type).
pub type AttachmentId = BlockId;

/// Alias for log snapshot entity IDs (also ULIDs, same underlying type).
pub type SnapshotId = BlockId;

impl BlockId {
    /// Generate a new ULID-based ID (always uppercase Crockford base32).
    pub fn new() -> Self {
        Self(ulid::Ulid::new().to_string())
    }

    /// Create from an existing ULID string. Validates format and normalises
    /// to uppercase Crockford base32 — essential for deterministic hashing
    /// in the op log (blake3 input must be canonical).
    pub fn from_string(s: impl Into<String>) -> Result<Self, crate::error::AppError> {
        let s = s.into();
        let parsed = ulid::Ulid::from_str(&s)
            .map_err(|e| crate::error::AppError::Ulid(format!("Invalid ULID '{}': {}", s, e)))?;
        // Store the canonical uppercase form, not the original input
        Ok(Self(parsed.to_string()))
    }

    /// Get the inner string reference.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Create from a trusted string (already known to be a valid ULID from a
    /// prior `BlockId::new()` call).  Normalises to uppercase but skips ULID
    /// validation. Use in command handlers where the ID was returned by a
    /// previous `create_block` and is being passed back from the frontend.
    pub fn from_trusted(s: &str) -> Self {
        Self(s.to_uppercase())
    }

    /// Consume and return the inner string.
    pub fn into_string(self) -> String {
        self.0
    }

    /// Test-only constructor that bypasses ULID validation but still
    /// uppercases the input.  Keeps test fixtures readable (e.g.
    /// `BlockId::test_id("BLK1")` instead of a 26-char ULID literal).
    #[cfg(test)]
    pub fn test_id(s: &str) -> Self {
        Self(s.to_uppercase())
    }
}

impl Default for BlockId {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for BlockId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl AsRef<str> for BlockId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl PartialEq<&str> for BlockId {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

impl PartialEq<str> for BlockId {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

impl From<BlockId> for String {
    fn from(id: BlockId) -> Self {
        id.0
    }
}

/// Tests for `BlockId` newtype: construction, parsing, normalization,
/// trait impls (Display, AsRef, From, Eq, Hash, Default, Serialize/Deserialize),
/// and the `AttachmentId`/`SnapshotId` type aliases.
#[cfg(test)]
mod tests {
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
        BlockId::from_string(id.as_str())
            .expect("default ULID should round-trip through from_string");
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
        let back: BlockId =
            serde_json::from_str(&json).expect("BlockId should deserialize from JSON");
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
        let id: BlockId =
            serde_json::from_str(&json).expect("should deserialize from a JSON string");
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
        let parsed =
            BlockId::from_string(&displayed).expect("Display output should be a valid ULID");
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
                let ulid = ulid::Ulid::from_parts((1_000_000 + i) as u64, 0);
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
        let unique: std::collections::HashSet<&str> = ids.iter().map(|id| id.as_str()).collect();
        assert_eq!(
            unique.len(),
            10,
            "all 10 consecutive ULIDs should be unique"
        );
    }
}
