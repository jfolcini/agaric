//! `SpaceId` newtype + `SpaceScope` tagged enum, used by space-scoped queries.
//!
//! Mirrors [`crate::ulid::ActiveBlockId`]: transparent serde + sqlx so the
//! wire / DB layers see a plain string while Rust call sites get the named
//! type.
//!
//! [`SpaceScope::Global`] applies no `block_properties.space` filter at the
//! SQL level — results span every space (pre- behaviour, plus journal
//! / settings views that intentionally span all spaces).
//! [`SpaceScope::Active`] restricts results to blocks belonging to the
//! wrapped [`SpaceId`].
//!
//! Wire format: specta emits `SpaceScope` as the discriminated union
//! `{ kind: "global" } | { kind: "active"; space_id: SpaceId }`.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

use crate::error::AppError;
use crate::ulid::BlockId;

/// Newtype wrapper around a space ULID for type-safety + IPC bindings.
///
/// Mirrors [`crate::ulid::ActiveBlockId`] (the strict newtype):
/// transparent serde + transparent sqlx + `specta::Type` so the wire / DB
/// layers see a plain string while Rust call sites get the named type.
///
/// # Normalisation
///
/// Stored value is the canonical uppercase Crockford base32 representation —
/// AGENTS.md invariant #8. Both `from_string`, `from_trusted`, and the
/// `Deserialize` impl uppercase via `to_ascii_uppercase` so every path
/// produces byte-identical output for non-ASCII inputs (e.g. "ß" stays "SS"
/// is *not* what we want; `to_ascii_uppercase` is the only normaliser that
/// keeps blake3 hash determinism).
///
/// # Wire format
///
/// `serde(transparent)` + `sqlx(transparent)` → JSON / SQLite see a bare
/// string. Specta emits `export type SpaceId = string;`. The newtype is
/// purely a Rust-side type-safety gate.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, sqlx::Type, specta::Type,
)]
#[serde(transparent)]
#[sqlx(transparent)]
pub struct SpaceId(String);

impl<'de> Deserialize<'de> for SpaceId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Lenient: uppercase-normalize without ULID validation. Strict
        // validation lives in `from_string`; the deserialize path mirrors
        // `BlockId::Deserialize` / `ActiveBlockId::Deserialize` so that
        // round-tripping through serde never rejects a value that
        // `from_trusted` would accept.
        let s = String::deserialize(deserializer)?;
        Ok(Self(s.to_ascii_uppercase()))
    }
}

impl SpaceId {
    /// Strict constructor — validates the input is a 26-char Crockford
    /// base32 ULID and returns it in canonical uppercase form.
    ///
    /// Use this at API boundaries where the source is untrusted (Tauri
    /// command parameters, op-log payloads, sync messages). For values
    /// that are already known to be valid ULIDs (e.g. produced by a
    /// previous `from_string` call and round-tripped through the DB),
    /// prefer [`SpaceId::from_trusted`] which skips the parse.
    pub fn from_string(s: impl Into<String>) -> Result<Self, AppError> {
        let s = s.into();
        let parsed = ulid::Ulid::from_str(&s)
            .map_err(|e| AppError::Ulid(format!("Invalid space ULID '{}': {}", s, e)))?;
        // Store the canonical uppercase form, not the original input —
        // mirrors `BlockId::from_string`. For ASCII Crockford base32 the
        // two forms coincide, but going through `parsed.to_string()`
        // tracks the `ulid` crate's canonical encoding rather than
        // trusting the caller's casing.
        Ok(Self(parsed.to_string()))
    }

    /// Construct from a string already known to be a valid ULID. Skips
    /// the parse but still uppercases via `to_ascii_uppercase` to match
    /// the `Deserialize` impl byte-for-byte. Mirrors
    /// [`crate::ulid::BlockId::from_trusted`].
    pub fn from_trusted(s: &str) -> Self {
        Self(s.to_ascii_uppercase())
    }

    /// Lightweight ULID-shape check for an already-constructed `SpaceId`.
    ///
    /// Reuses the same validator as [`SpaceId::from_string`]
    /// (`ulid::Ulid::from_str`) — a 26-char Crockford base32 string — but
    /// operates on the stored value rather than constructing a new id, so
    /// it can gate values that arrived through the lenient `Deserialize`
    /// path (which only uppercase-normalises, mirroring `BlockId`).
    ///
    /// Returns [`AppError::Validation`] on a malformed id so an IPC / sync
    /// boundary surfaces a clear error instead of binding a never-matching
    /// SQL param and silently returning empty results (issue #1588).
    pub fn validate_shape(&self) -> Result<(), AppError> {
        ulid::Ulid::from_str(&self.0)
            .map(|_| ())
            .map_err(|e| AppError::Validation(format!("malformed space id '{}': {}", self.0, e)))
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

impl fmt::Display for SpaceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl AsRef<str> for SpaceId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<SpaceId> for String {
    fn from(id: SpaceId) -> Self {
        id.0
    }
}

impl PartialEq<&str> for SpaceId {
    fn eq(&self, other: &&str) -> bool {
        self.0 == *other
    }
}

impl PartialEq<str> for SpaceId {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

impl PartialEq<String> for SpaceId {
    fn eq(&self, other: &String) -> bool {
        self.0 == *other
    }
}

impl PartialEq<SpaceId> for String {
    fn eq(&self, other: &SpaceId) -> bool {
        *self == other.0
    }
}

impl PartialEq<SpaceId> for str {
    fn eq(&self, other: &SpaceId) -> bool {
        *self == other.0
    }
}

impl PartialEq<SpaceId> for &str {
    fn eq(&self, other: &SpaceId) -> bool {
        *self == other.0
    }
}

/// The space scope a list / search query runs under.
///
/// `Global` — no `block_properties.space` filter is applied (pre-
/// behaviour, plus journal / settings views that intentionally span all
/// spaces). `Active(SpaceId)` — restrict results to blocks belonging to
/// the given space.
///
/// # Wire format
///
/// Adjacently-tagged via `#[serde(tag = "kind", content = "space_id")]`:
///
/// - `SpaceScope::Global`              → `{"kind":"global"}`
/// - `SpaceScope::Active(SpaceId(id))` → `{"kind":"active","space_id":"<ULID>"}`
///
/// Specta emits this as a TS discriminated union
/// (`{ kind: "global" } | { kind: "active"; space_id: SpaceId }`).
///
/// # Deserialize validates the `Active` id shape (issue #1588)
///
/// The wire/SQL layers treat the inner `SpaceId` as a trusted-shape string —
/// [`SpaceId::Deserialize`] only uppercase-normalises (mirroring `BlockId`),
/// so without a guard a malformed `space_id` from the frontend / MCP / sync
/// would bind a never-matching SQL filter param and silently return empty
/// results. The hand-written `Deserialize` impl below deserialises through the
/// same adjacently-tagged shape and then runs the lightweight ULID-shape check
/// ([`SpaceScope::validate`]), so this IPC boundary rejects a malformed space
/// id up front. `Global` and the seeded sentinel spaces are unaffected.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(tag = "kind", content = "space_id")]
pub enum SpaceScope {
    #[serde(rename = "global")]
    Global,
    #[serde(rename = "active")]
    Active(SpaceId),
}

impl<'de> Deserialize<'de> for SpaceScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // Reuse the derived adjacently-tagged shape via a private shim with an
        // identical `#[serde(...)]` contract, then validate the `Active` id
        // shape at this boundary. Keeping the shim's layout byte-identical to
        // the public enum preserves the wire format / specta output.
        #[derive(Deserialize)]
        #[serde(tag = "kind", content = "space_id")]
        enum Shim {
            #[serde(rename = "global")]
            Global,
            #[serde(rename = "active")]
            Active(SpaceId),
        }

        let scope = match Shim::deserialize(deserializer)? {
            Shim::Global => SpaceScope::Global,
            Shim::Active(id) => SpaceScope::Active(id),
        };
        scope.validate().map_err(serde::de::Error::custom)?;
        Ok(scope)
    }
}

impl SpaceScope {
    /// Adapter for the SQL bind site. Every list query takes a single
    /// `Option<&str>` "space filter" parameter that maps directly onto
    /// the existing `?N IS NULL OR …` SQL idiom; this helper returns
    /// the same shape so Phase 2 callsite migrations don't have to
    /// touch any SQL. Mirror of the soon-to-be-removed
    /// `space_id: Option<String>` parameter.
    pub fn as_filter_param(&self) -> Option<&str> {
        match self {
            SpaceScope::Global => None,
            SpaceScope::Active(id) => Some(id.as_str()),
        }
    }

    /// Validate that an `Active` scope wraps a well-formed space ULID.
    ///
    /// `Global` is always valid (it applies no filter). `Active(id)` is
    /// validated via [`SpaceId::validate_shape`] so a malformed id arriving
    /// through the lenient serde `Deserialize` path at an IPC / MCP / sync
    /// boundary is rejected with a clear [`AppError::Validation`] rather than
    /// silently binding a never-matching SQL filter param and returning empty
    /// results (issue #1588). The seeded sentinel spaces
    /// (`SPACE_PERSONAL_ULID` / `SPACE_WORK_ULID`) are canonical ULIDs and
    /// pass unchanged.
    pub fn validate(&self) -> Result<(), AppError> {
        match self {
            SpaceScope::Global => Ok(()),
            SpaceScope::Active(id) => id.validate_shape(),
        }
    }
}

// ---------------------------------------------------------------------------
// Block-space resolution helper (Phase 2 foundation)
// ---------------------------------------------------------------------------

/// Resolve a block's owning space via the canonical
/// `COALESCE(b.page_id, b.id) → block_properties.space` lookup.
///
/// Phase 2 helper. Used by every same-space enforcement
/// entry point (`set_property` ref-type validation, `edit_block`
/// content-scan, `add_tag`, sync-ingress rejection, bulk-import
/// scan). All enforcement points share this helper so the
/// "what space does this block belong to?" question has exactly
/// one answer.
///
/// # Returns
///
/// - `Ok(Some(space_id))` — block has an owning space (a `space`
///   ref property on its owning page, found via `COALESCE(page_id,
///   id)` resolution).
/// - `Ok(None)` — block has a NULL `space_id` (no owning space) or is
///   itself soft-deleted. This is the case for (a) tag blocks not yet
///   assigned to a space, (b) space blocks themselves (they ARE the
///   space; their `space_id` is NULL — they don't point at themselves),
///   (c) pre- blocks that haven't been migrated to a space yet
///   (rare; bootstrap fast-path normally covers this), (d) the block
///   being soft-deleted (`deleted_at IS NOT NULL`).
/// - `Err(AppError::Database)` — DB error (rare; would propagate
///   from the same `query!` macros every other helper uses).
///
/// # Why `Option<SpaceId>` and not `SpaceScope`
///
/// The caller's enforcement decision is shape-dependent — same-
/// space rejection compares `Option<SpaceId>` directly. Wrapping
/// in `SpaceScope::Global`/`Active` would force the caller to
/// destructure for the comparison, adding boilerplate. Future
/// callers can convert via `space.map_or(SpaceScope::Global,
/// SpaceScope::Active)` if they need the tagged form.
///
/// # SQL
///
/// Phase 2 (#533): the helper reads the block's own `blocks.space_id`
/// column directly — every block carries its space (a content block
/// inherits its owning page's space; a page/tag/space block carries
/// its own). The pre-Phase-2 `COALESCE(page_id, id)` indirection into
/// `block_properties(key='space')` is gone, along with the property
/// rows themselves (migration 0087).
///
/// The **input** block must be live (`deleted_at IS NULL`) to mirror
/// AGENTS.md invariant #9 — tombstones must never participate in space
/// resolution. A soft-deleted block resolves to `None`, matching the
/// pre-Phase-2 behaviour where a deleted block fell through the
/// COALESCE to an id with no `space` property.
///
/// # Lifetime
///
/// Generic over [`sqlx::SqliteExecutor`] so it accepts both
/// `&SqlitePool` and `&mut SqliteConnection` (including the
/// `&mut Transaction` form). Phase 2 enforcement points all run
/// inside the command's `BEGIN IMMEDIATE` transaction — the
/// helper must not open a fresh connection.
pub async fn resolve_block_space<'e, E>(
    executor: E,
    block_id: &BlockId,
) -> Result<Option<SpaceId>, AppError>
where
    E: sqlx::SqliteExecutor<'e>,
{
    let block_id_str = block_id.as_str();
    // #533 Phase 2: a block's space lives in `blocks.space_id`. Prefer the
    // block's own column, but fall back to its owning page's `space_id`
    // (`blocks.page_id` → that page) when the block's own value is not yet
    // materialised — e.g. a freshly-created block inside the same tx, whose
    // `page_id` is already stamped but whose `space_id` is set by the
    // post-commit propagation task. Without the fallback, in-tx cross-space
    // ref validation on create would resolve NULL and silently pass.
    let row = sqlx::query!(
        r#"SELECT COALESCE(b.space_id, p.space_id) AS "space_id?"
             FROM blocks b
             LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
            WHERE b.id = ?1
              AND b.deleted_at IS NULL
            LIMIT 1"#,
        block_id_str,
    )
    .fetch_optional(executor)
    .await?;

    // The stored `value_ref` came from a previous `SetProperty(space, …)`
    // op that was validated at emission time. Skip the re-parse —
    // `from_trusted` keeps the byte-stable normalisation contract
    // (AGENTS.md invariant #8) without re-running `ulid::Ulid::from_str`.
    Ok(row
        .and_then(|r| r.space_id)
        .map(|s| SpaceId::from_trusted(&s)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::tests::common::test_pool;

    /// A known-valid ULID in canonical uppercase Crockford base32.
    const FIXTURE_ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    /// Same ULID in lowercase, for normalisation tests.
    const FIXTURE_ULID_LOWER: &str = "01arz3ndektsv4rrffq69g5fav";

    // --- SpaceId::from_string ---

    #[test]
    fn from_string_accepts_valid_ulid() {
        let id = SpaceId::from_string(FIXTURE_ULID).expect("valid ULID should parse");
        assert_eq!(id.as_str(), FIXTURE_ULID);
    }

    #[test]
    fn from_string_normalises_lowercase_to_uppercase() {
        let id = SpaceId::from_string(FIXTURE_ULID_LOWER).expect("lowercase ULID should parse");
        assert_eq!(id.as_str(), FIXTURE_ULID);
    }

    #[test]
    fn from_string_rejects_garbage() {
        let err = SpaceId::from_string("not-a-ulid").expect_err("garbage must reject");
        assert!(matches!(err, AppError::Ulid(_)));
    }

    #[test]
    fn from_string_rejects_empty() {
        let err = SpaceId::from_string("").expect_err("empty must reject");
        assert!(matches!(err, AppError::Ulid(_)));
    }

    // --- SpaceId::from_trusted ---

    #[test]
    fn from_trusted_skips_validation_and_normalises_case() {
        // Not a valid ULID, but `from_trusted` doesn't check.
        let id = SpaceId::from_trusted("01testspace000000000000001");
        assert_eq!(id.as_str(), "01TESTSPACE000000000000001");
    }

    // --- SpaceId PartialEq with str / String ---

    #[test]
    fn space_id_eq_str_borrow_and_owned() {
        let id = SpaceId::from_trusted(FIXTURE_ULID);
        assert_eq!(id, FIXTURE_ULID);
        assert_eq!(id, String::from(FIXTURE_ULID));
        assert_eq!(id, *FIXTURE_ULID);
    }

    #[test]
    fn str_and_string_eq_space_id() {
        let id = SpaceId::from_trusted(FIXTURE_ULID);
        assert_eq!(*FIXTURE_ULID, id);
        assert_eq!(String::from(FIXTURE_ULID), id);
    }

    #[test]
    fn str_ref_eq_space_id() {
        let id = SpaceId::from_trusted(FIXTURE_ULID);
        assert_eq!(FIXTURE_ULID, id);
    }

    // --- SpaceScope serde round-trip ---

    #[test]
    fn space_scope_global_serialises_to_kind_only() {
        let json = serde_json::to_value(SpaceScope::Global).unwrap();
        assert_eq!(json, serde_json::json!({ "kind": "global" }));
    }

    #[test]
    fn space_scope_global_round_trips_through_serde_json() {
        let original = SpaceScope::Global;
        let json = serde_json::to_string(&original).unwrap();
        let decoded: SpaceScope = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn space_scope_active_serialises_to_kind_and_space_id() {
        let scope = SpaceScope::Active(SpaceId::from_trusted(FIXTURE_ULID));
        let json = serde_json::to_value(&scope).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "active", "space_id": FIXTURE_ULID })
        );
    }

    #[test]
    fn space_scope_active_round_trips_through_serde_json() {
        let original = SpaceScope::Active(SpaceId::from_trusted(FIXTURE_ULID));
        let json = serde_json::to_string(&original).unwrap();
        let decoded: SpaceScope = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn space_scope_active_normalises_lowercase_via_deserialize() {
        // The `space_id` field deserialises through `SpaceId::Deserialize`,
        // which uppercase-normalises without validation. Confirms the wire
        // path produces canonical uppercase regardless of input case.
        let json = serde_json::json!({ "kind": "active", "space_id": FIXTURE_ULID_LOWER });
        let decoded: SpaceScope = serde_json::from_value(json).unwrap();
        assert_eq!(
            decoded,
            SpaceScope::Active(SpaceId::from_trusted(FIXTURE_ULID))
        );
    }

    // --- SpaceScope::validate / SpaceId::validate_shape (issue #1588) ---

    #[test]
    fn validate_shape_accepts_valid_ulid() {
        let id = SpaceId::from_trusted(FIXTURE_ULID);
        assert!(id.validate_shape().is_ok());
    }

    #[test]
    fn validate_shape_rejects_malformed_with_validation_error() {
        // `from_trusted` skips validation, so a garbage id can exist; the
        // boundary check must catch it.
        let id = SpaceId::from_trusted("not-a-ulid");
        let err = id
            .validate_shape()
            .expect_err("malformed space id must reject");
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn space_scope_validate_global_is_ok() {
        assert!(SpaceScope::Global.validate().is_ok());
    }

    #[test]
    fn space_scope_validate_active_valid_ulid_ok() {
        let scope = SpaceScope::Active(SpaceId::from_trusted(FIXTURE_ULID));
        assert!(scope.validate().is_ok());
    }

    #[test]
    fn space_scope_validate_active_malformed_is_validation_error() {
        let scope = SpaceScope::Active(SpaceId::from_trusted("DOES_NOT_EXIST"));
        let err = scope
            .validate()
            .expect_err("malformed active scope must reject");
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn space_scope_validate_seeded_sentinels_pass() {
        // Guard against over-rejection: the seeded sentinel spaces are
        // canonical ULIDs and must pass the shape check unchanged.
        for sentinel in [SPACE_PERSONAL_ULID, SPACE_WORK_ULID] {
            let scope = SpaceScope::Active(SpaceId::from_trusted(sentinel));
            assert!(
                scope.validate().is_ok(),
                "sentinel space {sentinel} must pass shape validation"
            );
        }
    }

    #[test]
    fn space_scope_deserialize_rejects_malformed_active_id() {
        // The IPC boundary: a malformed `space_id` must fail deserialization
        // (a clear error) rather than yielding an `Active` scope that
        // silently matches nothing.
        let json = serde_json::json!({ "kind": "active", "space_id": "not-a-ulid" });
        let result: Result<SpaceScope, _> = serde_json::from_value(json);
        assert!(
            result.is_err(),
            "malformed space_id must reject at deserialize"
        );
    }

    #[test]
    fn space_scope_deserialize_accepts_valid_active_id() {
        let json = serde_json::json!({ "kind": "active", "space_id": FIXTURE_ULID });
        let decoded: SpaceScope =
            serde_json::from_value(json).expect("valid ULID must deserialize");
        assert_eq!(
            decoded,
            SpaceScope::Active(SpaceId::from_trusted(FIXTURE_ULID))
        );
    }

    #[test]
    fn space_scope_deserialize_accepts_seeded_sentinels() {
        for sentinel in [SPACE_PERSONAL_ULID, SPACE_WORK_ULID] {
            let json = serde_json::json!({ "kind": "active", "space_id": sentinel });
            let decoded: SpaceScope =
                serde_json::from_value(json).unwrap_or_else(|e| panic!("sentinel {sentinel}: {e}"));
            assert_eq!(decoded, SpaceScope::Active(SpaceId::from_trusted(sentinel)));
        }
    }

    // --- SpaceScope::as_filter_param ---

    #[test]
    fn as_filter_param_global_is_none() {
        assert_eq!(SpaceScope::Global.as_filter_param(), None);
    }

    #[test]
    fn as_filter_param_active_is_some_inner_str() {
        let scope = SpaceScope::Active(SpaceId::from_trusted(FIXTURE_ULID));
        assert_eq!(scope.as_filter_param(), Some(FIXTURE_ULID));
    }

    // --- sqlx column-cast probe ---
    //
    // Confirms `#[sqlx(transparent)]` on `SpaceId` lets `query_scalar!` and
    // `query_as!` decode a `TEXT` column as `SpaceId` via the
    // `SELECT … as "x: SpaceId"` cast hint — the same pattern
    // uses for `ActiveBlockId`.

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sqlx_column_cast_via_query_scalar() {
        let (pool, _dir) = test_pool().await;
        let id: SpaceId =
            sqlx::query_scalar!(r#"SELECT '01ARZ3NDEKTSV4RRFFQ69G5FAV' AS "id!: SpaceId""#)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(id.as_str(), FIXTURE_ULID);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sqlx_column_cast_via_query_as() {
        struct Row {
            id: SpaceId,
        }
        let (pool, _dir) = test_pool().await;
        let row = sqlx::query_as!(
            Row,
            r#"SELECT '01ARZ3NDEKTSV4RRFFQ69G5FAV' AS "id!: SpaceId""#
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.id.as_str(), FIXTURE_ULID);
    }

    // -----------------------------------------------------------------
    // Resolve_block_space — Phase 2 helper
    // -----------------------------------------------------------------

    use crate::spaces::{SPACE_PERSONAL_ULID, SPACE_WORK_ULID};
    use sqlx::SqlitePool;

    /// Synthetic page ULIDs for the resolver tests. Hand-typed 26-char
    /// Crockford-base32 strings so the asserts are byte-stable.
    const PAGE_A_ULID: &str = "01PEND15RESOLVERPAGEA00001";
    const PAGE_B_ULID: &str = "01PEND15RESOLVERPAGEB00002";
    const CONTENT_A_ULID: &str = "01PEND15RESOLVERCONTENTA01";
    const CONTENT_B_ULID: &str = "01PEND15RESOLVERCONTENTB02";
    const TAG_ULID: &str = "01PEND15RESOLVERTAG0000001";
    const NONEXISTENT_ULID: &str = "01PEND15RESOLVERMISSING001";

    /// Insert the seeded space block (idempotent). The
    /// `block_properties.value_ref → blocks(id)` FK requires the
    /// space's own row to exist before any page can carry a `space`
    /// property pointing at it.
    async fn seed_space_block(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', 'Space', NULL, 1, ?)",
        )
        .bind(id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
        // #708: register in the `spaces` table (production does this via
        // the is_space property -> 0089 trigger); `blocks.space_id` now
        // REFERENCES spaces(id), so unregistered targets fail FK 787.
        sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert a page belonging to `space_id` with the given soft-delete
    /// flag. Mirrors the audit binary's `insert_page` helper but exposes
    /// `deleted_at` so the soft-delete-filtering tests can flip it.
    async fn seed_page(pool: &SqlitePool, page_id: &str, space_id: &str, deleted_at: Option<i64>) {
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, page_id, deleted_at, space_id) \
             VALUES (?, 'page', 'Page', NULL, 1, ?, ?, ?)",
        )
        .bind(page_id)
        .bind(page_id)
        .bind(deleted_at)
        .bind(space_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a content block under `page_id`. Inherits its space
    /// transitively via the `COALESCE(page_id, id)` resolution path.
    async fn seed_content_block(pool: &SqlitePool, block_id: &str, page_id: &str) {
        // A content block inherits its owning page's space. Post-Phase-2
        // every block carries `space_id` on its own row, so copy the
        // page's column onto the content block (NULL if the page is
        // soft-deleted / unscoped, mirroring production materialization).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             SELECT ?, 'content', 'Content', ?, 1, ?, \
                    (SELECT space_id FROM blocks WHERE id = ? AND deleted_at IS NULL)",
        )
        .bind(block_id)
        .bind(page_id)
        .bind(page_id)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a tag-style block (top-level, no parent, no page_id, no
    /// `space` property). Mirrors the pre-Path-A production state for
    /// tag blocks.
    async fn seed_tag_block(pool: &SqlitePool, tag_id: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', 'Tag', NULL, NULL)",
        )
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_block_space_returns_some_for_page_in_space() {
        let (pool, _dir) = test_pool().await;
        seed_space_block(&pool, SPACE_PERSONAL_ULID).await;
        seed_page(&pool, PAGE_A_ULID, SPACE_PERSONAL_ULID, None).await;

        let resolved = resolve_block_space(&pool, &BlockId::from_trusted(PAGE_A_ULID))
            .await
            .unwrap();
        assert_eq!(resolved, Some(SpaceId::from_trusted(SPACE_PERSONAL_ULID)));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_block_space_content_block_inherits_pages_space() {
        let (pool, _dir) = test_pool().await;
        seed_space_block(&pool, SPACE_PERSONAL_ULID).await;
        seed_page(&pool, PAGE_A_ULID, SPACE_PERSONAL_ULID, None).await;
        seed_content_block(&pool, CONTENT_A_ULID, PAGE_A_ULID).await;

        let page_resolved = resolve_block_space(&pool, &BlockId::from_trusted(PAGE_A_ULID))
            .await
            .unwrap();
        let content_resolved = resolve_block_space(&pool, &BlockId::from_trusted(CONTENT_A_ULID))
            .await
            .unwrap();
        assert_eq!(
            page_resolved,
            Some(SpaceId::from_trusted(SPACE_PERSONAL_ULID))
        );
        assert_eq!(
            content_resolved,
            Some(SpaceId::from_trusted(SPACE_PERSONAL_ULID))
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_block_space_returns_none_for_block_without_space() {
        let (pool, _dir) = test_pool().await;
        seed_tag_block(&pool, TAG_ULID).await;

        let resolved = resolve_block_space(&pool, &BlockId::from_trusted(TAG_ULID))
            .await
            .unwrap();
        assert_eq!(resolved, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_block_space_returns_none_for_nonexistent_block() {
        let (pool, _dir) = test_pool().await;
        // No seeding — the block id isn't in `blocks` and has no
        // `block_properties` row either. The COALESCE inner subquery
        // returns NULL; the outer query falls back to the block's own
        // id, which has no `space` row, so the resolver returns None.
        let resolved = resolve_block_space(&pool, &BlockId::from_trusted(NONEXISTENT_ULID))
            .await
            .unwrap();
        assert_eq!(resolved, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_block_space_skips_soft_deleted_page_in_coalesce_chain() {
        let (pool, _dir) = test_pool().await;
        seed_space_block(&pool, SPACE_PERSONAL_ULID).await;
        // Page is soft-deleted (deleted_at non-NULL) — must not feed
        // page_id through the COALESCE inner subquery.
        seed_page(
            &pool,
            PAGE_A_ULID,
            SPACE_PERSONAL_ULID,
            Some(1_735_689_600_000),
        )
        .await;
        seed_content_block(&pool, CONTENT_A_ULID, PAGE_A_ULID).await;

        let resolved = resolve_block_space(&pool, &BlockId::from_trusted(CONTENT_A_ULID))
            .await
            .unwrap();
        assert_eq!(resolved, None);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_block_space_returns_trusted_form_byte_for_byte() {
        // Stored ULID is byte-stable (canonical uppercase) coming out
        // of the materializer. The resolver must return the same bytes
        // — `from_trusted` just normalises ASCII case, no re-parse.
        let (pool, _dir) = test_pool().await;
        seed_space_block(&pool, SPACE_WORK_ULID).await;
        seed_page(&pool, PAGE_B_ULID, SPACE_WORK_ULID, None).await;

        let resolved = resolve_block_space(&pool, &BlockId::from_trusted(PAGE_B_ULID))
            .await
            .unwrap()
            .expect("page in Work resolves to Some(SpaceId)");
        assert_eq!(resolved.as_str(), SPACE_WORK_ULID);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resolve_block_space_works_inside_transaction() {
        // Smoke: the `SqliteExecutor` generic accepts `&mut conn` from
        // an open transaction so Phase 2 enforcement points can call
        // the helper inside their existing `BEGIN IMMEDIATE` tx.
        let (pool, _dir) = test_pool().await;
        seed_space_block(&pool, SPACE_PERSONAL_ULID).await;
        seed_page(&pool, PAGE_A_ULID, SPACE_PERSONAL_ULID, None).await;
        seed_content_block(&pool, CONTENT_B_ULID, PAGE_A_ULID).await;

        let mut tx = pool.begin().await.unwrap();
        let resolved = resolve_block_space(&mut *tx, &BlockId::from_trusted(CONTENT_B_ULID))
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(resolved, Some(SpaceId::from_trusted(SPACE_PERSONAL_ULID)));
    }
}
