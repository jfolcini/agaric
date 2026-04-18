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
/// uppercase form. This is critical for blake3 hash determinism.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Tests live in `ulid/tests.rs` — pattern established for `dag.rs` +
// `dag/tests.rs`. The ~470-line test module dwarfed the ~115 lines of
// implementation above; splitting them keeps this file focused on the
// `BlockId` newtype contract.

#[cfg(test)]
mod tests;
