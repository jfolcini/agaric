use serde::Serialize;
use sqlx::SqlitePool;
use std::fmt;
use std::str::FromStr;

use crate::error::AppError;

/// Newtype wrapper around ULID for type safety and consistent serialisation.
/// Stores the canonical uppercase Crockford base32 representation.
///
/// Primary type for block IDs. Type aliases below provide semantic names for
/// non-block entity IDs (attachments, snapshots) that are also ULIDs.
///
/// **Deserialization normalizes to uppercase Crockford base32** — any valid
/// ULID string (lowercase, mixed-case) is accepted and stored in canonical
/// uppercase form. This is critical for blake3 hash determinism.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, sqlx::Type, specta::Type)]
#[serde(transparent)]
#[sqlx(transparent)]
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
    ///
    /// Uses `to_ascii_uppercase()` to match the `Deserialize` impl — Unicode
    /// `to_uppercase()` would produce different output for non-ASCII inputs
    /// (e.g. "ß" → "SS"), breaking blake3 determinism across the two paths.
    pub fn from_trusted(s: &str) -> Self {
        Self(s.to_ascii_uppercase())
    }

    /// Consume and return the inner string.
    pub fn into_string(self) -> String {
        self.0
    }

    /// Test-only constructor that bypasses ULID validation but still
    /// uppercases the input.  Keeps test fixtures readable (e.g.
    /// `BlockId::test_id("BLK1")` instead of a 26-char ULID literal).
    ///
    /// Uses `to_ascii_uppercase()` to match `from_trusted` and the
    /// `Deserialize` impl — keeps every normalisation path byte-stable
    /// for non-ASCII inputs (AGENTS.md invariant #8).
    #[cfg(test)]
    pub fn test_id(s: &str) -> Self {
        Self(s.to_ascii_uppercase())
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
// ActiveBlockId — MAINT-113 M1
// ---------------------------------------------------------------------------
//
// Lifts the "block is live" predicate into the type system. A function
// signature that takes `&ActiveBlockId` documents — and enforces — that
// the caller has already verified the block exists and has not been
// soft-deleted.
//
// `ActiveBlockId` is a *strict* subset of `BlockId`. Every `ActiveBlockId`
// value is also a valid `BlockId` (witnessed by the `From<ActiveBlockId>
// for BlockId` impl below), but only IDs that have round-tripped through
// [`verify_active`] (or were produced by an active-filtering query) carry
// the `ActiveBlockId` tag.
//
// Wire format is identical to `BlockId` and `String` — both `serde` and
// `sqlx` use the transparent encoding so the JSON / SQLite layer cannot
// distinguish the type. The newtype is purely a Rust-side type-safety
// gate; sync, IPC, and op log payloads all continue to see the underlying
// 26-character ULID string.

/// A block ID that has been verified to refer to an active block.
///
/// "Active" means the block exists in the materialised `blocks` table
/// AND `deleted_at IS NULL`. Use [`verify_active`]
/// to convert a raw [`BlockId`] into this type.
///
/// **Wire-format parity with [`BlockId`] / `String`:** `serde` uses
/// `transparent`, and `sqlx::Type` is `transparent` over the inner
/// `String` — the encoded representation is byte-identical to the
/// underlying ULID. Round-tripping through JSON / SQLite preserves the
/// active claim only because callers use [`verify_active`] at the
/// boundary; deserialising raw user input never produces an
/// `ActiveBlockId` whose claim has been checked.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, sqlx::Type, specta::Type,
)]
#[serde(transparent)]
#[sqlx(transparent)]
pub struct ActiveBlockId(String);

impl<'de> serde::Deserialize<'de> for ActiveBlockId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Mirror `BlockId::Deserialize`: lenient uppercase normalisation
        // without ULID validation. The activeness invariant is NOT
        // re-checked on deserialize — it's the caller's responsibility
        // to feed `verify_active` if the source is untrusted.
        let s = String::deserialize(deserializer)?;
        Ok(Self(s.to_ascii_uppercase()))
    }
}

impl ActiveBlockId {
    /// Get the inner string reference.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Consume and return the inner string.
    pub fn into_string(self) -> String {
        self.0
    }

    /// Construct from a string already known to refer to an active block.
    ///
    /// Skips the [`verify_active`] DB lookup. Use ONLY when the call site
    /// has just produced the value from an active-filtering SQL query
    /// (e.g., a `SELECT … WHERE deleted_at IS NULL`
    /// helper) and the activeness claim is fresh. For untrusted input
    /// (command parameters, op log payloads, sync messages) call
    /// [`verify_active`] instead.
    ///
    /// Mirrors [`BlockId::from_trusted`] — `to_ascii_uppercase` keeps
    /// the byte-stable normalisation contract that blake3 hashing
    /// depends on (AGENTS.md invariant #8).
    pub fn from_trusted_active(s: &str) -> Self {
        Self(s.to_ascii_uppercase())
    }

    /// Test-only constructor that bypasses both ULID validation and
    /// the DB activeness check. Mirrors [`BlockId::test_id`].
    #[cfg(test)]
    pub fn test_id(s: &str) -> Self {
        Self(s.to_ascii_uppercase())
    }
}

/// `String → ActiveBlockId` for test fixtures and trusted in-process
/// conversions (e.g., wiring through `verify_active`'s returned
/// `ActiveBlockId.into_string()` round-trips, benches that seed known
/// rows). Bypasses both ULID validation and the DB activeness check —
/// production code reaching for a fresh `ActiveBlockId` should always
/// route through [`verify_active`] so the activeness claim is verified
/// at the call site. Mirror of [`BlockId`]'s implicit conversion.
impl From<String> for ActiveBlockId {
    fn from(s: String) -> Self {
        Self(s.to_ascii_uppercase())
    }
}

/// `&str → ActiveBlockId`. Same caveats as the `String` impl above.
impl From<&str> for ActiveBlockId {
    fn from(s: &str) -> Self {
        Self(s.to_ascii_uppercase())
    }
}

impl fmt::Display for ActiveBlockId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl AsRef<str> for ActiveBlockId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl PartialEq<&str> for ActiveBlockId {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

impl PartialEq<str> for ActiveBlockId {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

impl PartialEq<String> for ActiveBlockId {
    fn eq(&self, other: &String) -> bool {
        self.0 == *other
    }
}

impl PartialEq<ActiveBlockId> for String {
    fn eq(&self, other: &ActiveBlockId) -> bool {
        *self == other.0
    }
}

impl PartialEq<ActiveBlockId> for str {
    fn eq(&self, other: &ActiveBlockId) -> bool {
        *self == other.0
    }
}

impl PartialEq<ActiveBlockId> for &str {
    fn eq(&self, other: &ActiveBlockId) -> bool {
        *self == other.0
    }
}

impl From<ActiveBlockId> for String {
    fn from(id: ActiveBlockId) -> Self {
        id.0
    }
}

impl From<ActiveBlockId> for BlockId {
    /// `ActiveBlockId` is a strict subset of `BlockId` — every active
    /// id is also a valid raw id. Conversion is infallible and free.
    fn from(id: ActiveBlockId) -> Self {
        BlockId::from_trusted(&id.0)
    }
}

/// Verify that a [`BlockId`] refers to an active block — i.e., a row
/// exists in `blocks` with deleted_at IS NULL`.
///
/// This is the single checked gate from raw [`BlockId`] to
/// [`ActiveBlockId`] (MAINT-113 M1). Every `ActiveBlockId` value in the
/// codebase is either:
///
/// 1. produced directly by a SQL query that filters on
///    deleted_at IS NULL` (constructed via
///    [`ActiveBlockId::from_trusted_active`] at the helper boundary), or
/// 2. round-tripped through this function from a raw [`BlockId`].
///
/// # Errors
///
/// - [`AppError::NotFound`] — no row exists with this id.
/// - [`AppError::Validation`] — the row exists but has been soft-deleted
///   (`deleted_at IS NOT NULL`).
pub async fn verify_active(pool: &SqlitePool, id: &BlockId) -> Result<ActiveBlockId, AppError> {
    let id_str = id.as_str();
    let row = sqlx::query!(
        r#"SELECT deleted_at
           FROM blocks
           WHERE id = ?"#,
        id_str,
    )
    .fetch_optional(pool)
    .await?;

    let row =
        row.ok_or_else(|| AppError::NotFound(format!("block '{}' does not exist", id_str)))?;

    if row.deleted_at.is_some() {
        return Err(AppError::Validation(format!(
            "block '{}' has been soft-deleted",
            id_str
        )));
    }

    Ok(ActiveBlockId(id_str.to_string()))
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
