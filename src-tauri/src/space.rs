//! `SpaceId` newtype + `SpaceScope` tagged enum, used by space-scoped queries.
//!
//! Mirrors [`crate::ulid::ActiveBlockId`]: transparent serde + sqlx so the
//! wire / DB layers see a plain string while Rust call sites get the named
//! type.
//!
//! [`SpaceScope::Global`] applies no `block_properties.space` filter at the
//! SQL level — results span every space (pre-FEAT-3 behaviour, plus journal
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
/// Mirrors [`crate::ulid::ActiveBlockId`] (the strict MAINT-113 newtype):
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
/// `Global` — no `block_properties.space` filter is applied (pre-FEAT-3
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", content = "space_id")]
pub enum SpaceScope {
    #[serde(rename = "global")]
    Global,
    #[serde(rename = "active")]
    Active(SpaceId),
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
}

// ---------------------------------------------------------------------------
// Block-space resolution helper (PEND-15 Phase 2 foundation)
// ---------------------------------------------------------------------------

/// Resolve a block's owning space via the canonical
/// `COALESCE(b.page_id, b.id) → block_properties.space` lookup.
///
/// PEND-15 Phase 2 helper. Used by every same-space enforcement
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
/// - `Ok(None)` — block has no owning space. This is the case for
///   (a) tag blocks (top-level, no `page_id`, no `space` property
///   pre-Path-A), (b) space blocks themselves (they ARE the space;
///   they don't carry a `space` ref pointing at themselves), (c)
///   pre-FEAT-3 blocks that haven't been migrated to a space yet
///   (rare; bootstrap fast-path normally covers this), (d) blocks
///   whose `page_id` points at a deleted/conflict page (the
///   COALESCE step won't find a live page; falls through to the
///   block's own id which has no `space` property).
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
/// The helper executes ONE query (via `query!`). SQLite's
/// correlated subquery in `COALESCE` short-circuits when the
/// inner `page_id` lookup yields a row.
///
/// Both ends of the COALESCE chain are conflict / soft-delete
/// filtered to mirror AGENTS.md invariant #9 — conflict copies
/// and tombstones must never participate in space resolution:
///
/// * Inner subquery — the **input** block must be live for its
///   `page_id` to flow through the COALESCE.
/// * Outer `JOIN blocks tgt ON tgt.id = bp.block_id` — the block
///   that *holds* the `space` property (the page, after the
///   COALESCE resolves) must be live too. This is what catches
///   case (d) above: an input block whose `page_id` references a
///   conflict / soft-deleted page falls through to its own id,
///   which has no `space` property, and the resolver returns
///   `None`.
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
    let row = sqlx::query!(
        r#"SELECT bp.value_ref AS "space_id?"
             FROM block_properties bp
             JOIN blocks tgt ON tgt.id = bp.block_id
                            AND tgt.deleted_at IS NULL
            WHERE bp.block_id = COALESCE(
                    (SELECT page_id FROM blocks
                      WHERE id = ?1
                        AND deleted_at IS NULL),
                    ?1)
              AND bp.key = 'space'
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
    // `SELECT … as "x: SpaceId"` cast hint — the same pattern MAINT-113
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
    // resolve_block_space — PEND-15 Phase 2 helper
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
    }

    /// Insert a page belonging to `space_id` with the given soft-delete
    /// flag. Mirrors the audit binary's `insert_page` helper but exposes
    /// `deleted_at` so the soft-delete-filtering tests can flip it.
    async fn seed_page(pool: &SqlitePool, page_id: &str, space_id: &str, deleted_at: Option<&str>) {
        sqlx::query(
            "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, page_id, deleted_at) \
             VALUES (?, 'page', 'Page', NULL, 1, ?, ?)",
        )
        .bind(page_id)
        .bind(page_id)
        .bind(deleted_at)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        )
        .bind(page_id)
        .bind(space_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a content block under `page_id`. Inherits its space
    /// transitively via the `COALESCE(page_id, id)` resolution path.
    async fn seed_content_block(pool: &SqlitePool, block_id: &str, page_id: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', 'Content', ?, 1, ?)",
        )
        .bind(block_id)
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
            Some("2025-01-01T00:00:00Z"),
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
