use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// Newtype wrapper around ULID for type safety and consistent serialisation.
/// Stores the canonical uppercase Crockford base32 representation.
///
/// Primary type for block IDs. Type aliases below provide semantic names for
/// non-block entity IDs (attachments, snapshots) that are also ULIDs.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BlockId(String);

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

    /// Consume and return the inner string.
    pub fn into_string(self) -> String {
        self.0
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

impl From<BlockId> for String {
    fn from(id: BlockId) -> Self {
        id.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_produces_valid_26_char_uppercase() {
        let id = BlockId::new();
        let s = id.as_str();
        assert_eq!(s.len(), 26);
        assert!(
            s.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
            "ULID should be uppercase Crockford base32: got '{s}'"
        );
    }

    #[test]
    fn from_string_valid_lowercase_normalizes_to_uppercase() {
        let upper = BlockId::new();
        let lower = upper.as_str().to_lowercase();
        let parsed = BlockId::from_string(lower).unwrap();
        assert_eq!(parsed.as_str(), upper.as_str());
    }

    #[test]
    fn from_string_invalid_returns_error() {
        let result = BlockId::from_string("definitely-not-a-ulid");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, crate::error::AppError::Ulid(_)));
    }

    #[test]
    fn from_string_empty_returns_error() {
        let result = BlockId::from_string("");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, crate::error::AppError::Ulid(_)));
    }

    #[test]
    fn display_as_ref_and_from_are_consistent() {
        let id = BlockId::new();
        let display = format!("{}", id);
        let as_ref: &str = id.as_ref();
        let as_str = id.as_str();
        assert_eq!(display, as_ref);
        assert_eq!(display, as_str);
        let into_string: String = id.into();
        assert_eq!(display, into_string);
    }

    #[test]
    fn serde_roundtrip_preserves_value() {
        let id = BlockId::new();
        let json = serde_json::to_string(&id).unwrap();
        let deserialized: BlockId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, deserialized);
    }

    #[test]
    fn default_produces_valid_ulid() {
        let id = BlockId::default();
        assert_eq!(id.as_str().len(), 26);
        // Verify it round-trips through from_string
        assert!(BlockId::from_string(id.as_str()).is_ok());
    }

    #[test]
    fn into_string_consumes_and_returns_inner() {
        let id = BlockId::new();
        let s = id.as_str().to_owned();
        let consumed = id.into_string();
        assert_eq!(s, consumed);
    }

    #[test]
    fn type_aliases_work() {
        // AttachmentId and SnapshotId are type aliases for BlockId
        let att: super::AttachmentId = BlockId::new();
        assert_eq!(att.as_str().len(), 26);
        let snap: super::SnapshotId = BlockId::new();
        assert_eq!(snap.as_str().len(), 26);
    }
}
