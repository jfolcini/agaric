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
/// **Deserialization normalizes to canonical Crockford base32** — any valid
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
        // `Deserialize` is the genuinely-UNTRUSTED entry point: remote op-log
        // payloads, sync messages and IPC parameters reach `BlockId` through
        // here (e.g. `serde_json::from_str::<EditBlockPayload>` in `dag.rs`).
        // Because `normalize_block_ids()` is now a no-op (op.rs), the canonical
        // form fed to the blake3 hash preimage is decided HERE.
        //
        // #1558 — Canonicalize valid ULIDs through the *same* Crockford path
        // `from_string` uses (`ulid::Ulid::from_str().to_string()`), so any
        // two encodings of the same logical ULID (case-variant, or any
        // decode-equivalent form a Crockford decoder accepts) collapse to one
        // byte-identical string and therefore one hash. Untrusted input can no
        // longer inject a non-canonical id into the hash preimage.
        //
        // Strings that are NOT valid 26-char ULIDs fall back to lenient
        // ASCII-uppercase normalization (no error) so that values stored by
        // `from_trusted` / `test_id` — synthetic non-ULID test fixtures like
        // "AB", "P", "BLOCK_A" — still deserialize. This keeps the test
        // ergonomics intact while hardening the real-ULID path. ASCII-only
        // uppercase matches `from_trusted` byte-for-byte for those non-ULID
        // inputs (AGENTS.md invariant #8).
        match ulid::Ulid::from_str(&s) {
            Ok(parsed) => Ok(Self(parsed.to_string())),
            Err(_) => Ok(Self(s.to_ascii_uppercase())),
        }
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
            .map_err(|e| crate::error::AppError::Ulid(format!("Invalid ULID '{s}': {e}")))?;
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
    /// **Lenient by design — this is the TRUSTED path.** Unlike the
    /// `Deserialize` impl (the untrusted entry point, which canonicalizes
    /// valid ULIDs through `ulid::Ulid::from_str` per #1558), `from_trusted`
    /// performs no ULID parse: the caller promises the value is already a
    /// valid, canonical ULID minted by `BlockId::new()` / `from_string`.
    /// Keeping it parse-free is what lets test fixtures and in-process
    /// round-trips use synthetic non-ULID ids ("AB", "P", "BLOCK_A") cheaply.
    ///
    /// Uses `to_ascii_uppercase()` so that, for the non-ULID inputs the two
    /// paths share (the `Deserialize` fallback also ASCII-uppercases), the
    /// byte output matches — Unicode `to_uppercase()` would produce different
    /// output for non-ASCII inputs (e.g. "ß" → "SS"), breaking blake3
    /// determinism across the two paths (AGENTS.md invariant #8).
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

impl PartialEq<String> for BlockId {
    fn eq(&self, other: &String) -> bool {
        self.0 == *other
    }
}

impl PartialEq<BlockId> for String {
    fn eq(&self, other: &BlockId) -> bool {
        *self == other.0
    }
}

impl PartialEq<BlockId> for str {
    fn eq(&self, other: &BlockId) -> bool {
        *self == other.0
    }
}

impl PartialEq<BlockId> for &str {
    fn eq(&self, other: &BlockId) -> bool {
        *self == other.0
    }
}

/// `String → BlockId` for test fixtures and trusted in-process conversions.
/// Bypasses ULID validation but normalises to uppercase to match
/// [`BlockId::from_trusted`] and the `Deserialize` impl (AGENTS.md
/// invariant #8). Production code that needs validation should call
/// [`BlockId::from_string`] instead.
impl From<String> for BlockId {
    fn from(s: String) -> Self {
        Self(s.to_ascii_uppercase())
    }
}

/// `&str → BlockId`. Same caveats as the `String` impl above.
impl From<&str> for BlockId {
    fn from(s: &str) -> Self {
        Self(s.to_ascii_uppercase())
    }
}

impl From<BlockId> for String {
    fn from(id: BlockId) -> Self {
        id.0
    }
}

// ---------------------------------------------------------------------------
// ActiveBlockId
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
/// [`ActiveBlockId`]. Every `ActiveBlockId` value in the
/// codebase is either:
///
/// 1. produced directly by a SQL query that filters on
///    deleted_at IS NULL` (constructed via
///    [`ActiveBlockId::from_trusted_active`] at the helper boundary), or
/// 2. round-tripped through this function from a raw [`BlockId`].
///
/// Standalone (pool) form. Write commands that already open their own
/// transaction should call [`verify_active_in_tx`] instead so the
/// activeness check folds into the write transaction and the row is read
/// only once (#1627). This pool form remains the gate for read-only and
/// non-transactional callers (e.g. the MCP `set_property` boundary, which
/// has no surrounding tx of its own).
///
/// # Errors
///
/// - [`AppError::NotFound`] — no row exists with this id.
/// - [`AppError::Validation`] — the row exists but has been soft-deleted
///   (`deleted_at IS NOT NULL`).
pub async fn verify_active(pool: &SqlitePool, id: &BlockId) -> Result<ActiveBlockId, AppError> {
    let mut conn = pool.acquire().await?;
    verify_active_in_tx(&mut conn, id).await
}

/// In-transaction sibling of [`verify_active`].
///
/// Performs the IDENTICAL existence / soft-deleted discrimination as
/// [`verify_active`] — same SQL shape, same distinct error variants and
/// messages — but against a live transaction executor instead of the
/// pool. This lets a write command fold the activeness gate INTO the
/// same `BEGIN IMMEDIATE` transaction that performs the write, so the
/// row is read exactly once (TOCTOU-safe) and the previously redundant
/// pre-transaction round-trip on the pool is eliminated (#1627).
///
/// The returned [`ActiveBlockId`] carries the same type-state guarantee
/// as [`verify_active`]'s — it is minted only after the row is confirmed
/// to exist with `deleted_at IS NULL` inside the caller's transaction.
///
/// # Errors
///
/// - [`AppError::NotFound`] — no row exists with this id.
/// - [`AppError::Validation`] — the row exists but has been soft-deleted
///   (`deleted_at IS NOT NULL`).
pub async fn verify_active_in_tx(
    conn: &mut sqlx::SqliteConnection,
    id: &BlockId,
) -> Result<ActiveBlockId, AppError> {
    let id_str = id.as_str();
    let row = sqlx::query!(
        r#"SELECT deleted_at
           FROM blocks
           WHERE id = ?"#,
        id_str,
    )
    .fetch_optional(&mut *conn)
    .await?;

    let row = row.ok_or_else(|| AppError::NotFound(format!("block '{id_str}' does not exist")))?;

    if row.deleted_at.is_some() {
        return Err(AppError::Validation(format!(
            "block '{id_str}' has been soft-deleted"
        )));
    }

    Ok(ActiveBlockId(id_str.to_string()))
}

// ---------------------------------------------------------------------------
// PageId
// ---------------------------------------------------------------------------
//
// Lifts the "this id names a page (or a block's owning page)" role into
// the type system. A `page_id` TEXT column read into a `PageId` documents
// — and enforces at the Rust level — that the value is a page reference,
// distinct from a generic [`BlockId`]. The maintainer decision on #107 is
// to introduce a *distinct* newtype rather than a bare alias.
//
// `PageId` wraps [`BlockId`] (not `String`) because every page id is also
// a valid block id — pages are blocks with `block_type = 'page'`, and the
// `page_id` column stores the owning page's block id. Wrapping `BlockId`
// inherits its uppercase-normalising `Deserialize` for free and makes the
// `PageId → BlockId` widening conversion infallible and zero-cost.
//
// Wire format is identical to `BlockId` and `String`: both `serde` and
// `sqlx` use the transparent encoding (delegating through the inner
// `BlockId`, which is itself transparent over `String`). The JSON / SQLite
// layer cannot distinguish the type — sync, IPC, and op-log payloads all
// continue to see the underlying 26-character ULID string. The newtype is
// purely a Rust-side type-safety tag.

/// A block id in its role as a page reference.
///
/// Read a `page_id` TEXT column into this type when the value names a page
/// (or the owning page of a block). It is a drop-in replacement for
/// reading the column as [`BlockId`] / `String`.
///
/// **Wire-format parity with [`BlockId`] / `String`:** `serde` uses
/// `transparent` and `sqlx::Type` is `transparent` over the inner
/// [`BlockId`] (itself transparent over `String`) — the encoded
/// representation is byte-identical to the underlying ULID. Round-tripping
/// through JSON / SQLite preserves the value exactly.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, sqlx::Type, specta::Type)]
#[serde(transparent)]
#[sqlx(transparent)]
pub struct PageId(BlockId);

impl<'de> serde::Deserialize<'de> for PageId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Delegate to `BlockId::Deserialize`, which lenient-normalises to
        // uppercase Crockford base32 without ULID validation. Keeps every
        // normalisation path byte-stable (AGENTS.md invariant #8).
        Ok(Self(BlockId::deserialize(deserializer)?))
    }
}

impl PageId {
    /// Get the inner string reference.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }

    /// Borrow the underlying [`BlockId`]. Free — `PageId` is a strict
    /// tag over `BlockId`.
    pub fn as_block_id(&self) -> &BlockId {
        &self.0
    }

    /// Consume and return the underlying [`BlockId`].
    pub fn into_block_id(self) -> BlockId {
        self.0
    }

    /// Consume and return the inner string.
    pub fn into_string(self) -> String {
        self.0.into_string()
    }

    /// Construct from a string already known to refer to a page. Skips
    /// ULID validation but normalises to uppercase to match
    /// [`BlockId::from_trusted`] and the `Deserialize` impl (AGENTS.md
    /// invariant #8). Use at helper boundaries where the value was just
    /// produced by a `page_id`-selecting query.
    pub fn from_trusted(s: &str) -> Self {
        Self(BlockId::from_trusted(s))
    }

    /// Test-only constructor that bypasses ULID validation but still
    /// uppercases the input. Mirrors [`BlockId::test_id`].
    #[cfg(test)]
    pub fn test_id(s: &str) -> Self {
        Self(BlockId::test_id(s))
    }
}

/// `BlockId → PageId` — every block id can be tagged as a page reference
/// (the type system does not re-check that it names a `block_type = 'page'`
/// row; that is the caller's responsibility at the query boundary).
impl From<BlockId> for PageId {
    fn from(id: BlockId) -> Self {
        Self(id)
    }
}

/// `PageId → BlockId` — a page id is always a valid block id. Infallible
/// and free.
impl From<PageId> for BlockId {
    fn from(id: PageId) -> Self {
        id.0
    }
}

/// `String → PageId` for test fixtures and trusted in-process conversions.
/// Bypasses ULID validation but normalises to uppercase via the inner
/// `BlockId` conversion. Mirror of [`BlockId`]'s implicit conversion.
impl From<String> for PageId {
    fn from(s: String) -> Self {
        Self(BlockId::from(s))
    }
}

/// `&str → PageId`. Same caveats as the `String` impl above.
impl From<&str> for PageId {
    fn from(s: &str) -> Self {
        Self(BlockId::from(s))
    }
}

impl From<PageId> for String {
    fn from(id: PageId) -> Self {
        id.0.into_string()
    }
}

impl fmt::Display for PageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl AsRef<str> for PageId {
    fn as_ref(&self) -> &str {
        self.0.as_str()
    }
}

impl PartialEq<&str> for PageId {
    fn eq(&self, other: &&str) -> bool {
        self.0 == **other
    }
}

impl PartialEq<str> for PageId {
    fn eq(&self, other: &str) -> bool {
        self.0 == *other
    }
}

impl PartialEq<String> for PageId {
    fn eq(&self, other: &String) -> bool {
        self.0 == *other
    }
}

impl PartialEq<PageId> for String {
    fn eq(&self, other: &PageId) -> bool {
        other.0 == *self
    }
}

impl PartialEq<PageId> for str {
    fn eq(&self, other: &PageId) -> bool {
        other.0 == *self
    }
}

impl PartialEq<PageId> for &str {
    fn eq(&self, other: &PageId) -> bool {
        other.0 == **self
    }
}

impl PartialEq<BlockId> for PageId {
    fn eq(&self, other: &BlockId) -> bool {
        self.0 == *other
    }
}

impl PartialEq<PageId> for BlockId {
    fn eq(&self, other: &PageId) -> bool {
        *self == other.0
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
