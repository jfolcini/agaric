//! FEAT-3 Phase 1: `list_spaces` Tauri command.
//! FEAT-3 Phase 2: `create_page_in_space` Tauri command.
//!
//! A "space" is a page block marked with `is_space = "true"`. This
//! module hosts the space-related Tauri commands:
//!
//! * [`list_spaces`] — read-only — returns every live, non-conflict
//!   space block as a lightweight `{ id, name }` shape for the sidebar
//!   `SpaceSwitcher`. Ordering is alphabetical by name.
//! * [`create_page_in_space`] — atomic page-create-and-assign-to-space.
//!   Emits a `CreateBlock` op plus a `SetProperty(key = "space",
//!   value_ref = <space_id>)` op inside a single `BEGIN IMMEDIATE`
//!   transaction so a page never exists without a space property.

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::commands::{create_block_in_tx, set_property_in_tx};
use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::ulid::BlockId;

use super::sanitize_internal_error;

/// A space row returned by [`list_spaces_inner`] — just the pieces the
/// frontend needs to render the switcher (ULID + display name).
#[derive(Serialize, Deserialize, Type, Clone, Debug)]
pub struct SpaceRow {
    pub id: String,
    pub name: String,
}

/// Return every space block (live, non-conflict) as a `{ id, name }`
/// row, ordered alphabetically by name.
///
/// A space is identified by the presence of a `block_properties` row
/// with `key = 'is_space'` and `value_text = 'true'`. The `content`
/// column on the block row is the user-facing name.
#[instrument(skip(pool), err)]
pub async fn list_spaces_inner(pool: &SqlitePool) -> Result<Vec<SpaceRow>, AppError> {
    let rows = sqlx::query_as!(
        SpaceRow,
        r#"SELECT b.id as "id!: String", COALESCE(b.content, '') as "name!: String"
           FROM blocks b
           INNER JOIN block_properties p
               ON p.block_id = b.id
              AND p.key = 'is_space'
              AND p.value_text = 'true'
           WHERE b.deleted_at IS NULL
             AND b.is_conflict = 0
           ORDER BY COALESCE(b.content, '') ASC, b.id ASC"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Tauri command: list every space. Delegates to [`list_spaces_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_spaces(pool: State<'_, ReadPool>) -> Result<Vec<SpaceRow>, AppError> {
    list_spaces_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// FEAT-3 Phase 2: `create_page_in_space`
// ---------------------------------------------------------------------------

/// Create a new page block and atomically assign it to `space_id`.
///
/// Both ops (`CreateBlock` and `SetProperty(space = <space_id>)`) are
/// appended inside a single `BEGIN IMMEDIATE` transaction so a page can
/// never exist in the op log without a `space` property — the FEAT-3
/// invariant "nothing outside of spaces".
///
/// Rejects (with [`AppError::Validation`]) if `space_id` does not resolve
/// to a live, non-conflict block carrying `is_space = 'true'`. The check
/// happens inside the transaction so the validation is TOCTOU-safe
/// against a concurrent delete of the target space.
///
/// Returns the new page's `BlockId`. The Tauri wrapper serialises that
/// via `BlockId`'s transparent `Serialize` impl — the frontend receives
/// a plain string.
///
/// # Errors
///
/// - [`AppError::Validation`] — `space_id` does not refer to a live space block.
/// - [`AppError::NotFound`] — `parent_id` does not refer to a live block.
/// - Other [`AppError`] variants propagated from
///   [`create_block_in_tx`] / [`set_property_in_tx`].
#[instrument(skip(pool, content), err)]
pub async fn create_page_in_space_inner(
    pool: &SqlitePool,
    device_id: &str,
    parent_id: Option<String>,
    content: String,
    space_id: String,
) -> Result<BlockId, AppError> {
    // Single write transaction — both ops land together or neither does.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // 1. Validate `space_id` upfront inside the tx. The target must
    //    exist as a live, non-conflict block AND carry `is_space = 'true'`.
    //    Inside the tx the check is TOCTOU-safe against a concurrent
    //    delete.
    let space_ok = sqlx::query_scalar!(
        r#"SELECT 1 as "ok: i32" FROM blocks b
           WHERE b.id = ?
             AND b.deleted_at IS NULL
             AND b.is_conflict = 0
             AND EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id
                   AND p.key = 'is_space'
                   AND p.value_text = 'true'
             )"#,
        space_id,
    )
    .fetch_optional(&mut *tx)
    .await?;
    if space_ok.is_none() {
        return Err(AppError::Validation(format!(
            "space_id '{space_id}' does not refer to a live space block (is_space = 'true')"
        )));
    }

    // 2. Create the page block. `create_block_in_tx` generates the ULID,
    //    appends a `CreateBlock` op, and inserts the materialized row.
    let (block, _page_op_record) = create_block_in_tx(
        &mut tx,
        device_id,
        "page".to_string(),
        content,
        parent_id,
        // `None` means "append after last sibling" — matches the
        // existing `create_block` behaviour for top-level pages.
        None,
    )
    .await?;
    let new_page_id = BlockId::from_trusted(&block.id);

    // 3. Stamp the `space` ref property. Ops are emitted in the order
    //    (create → set) so a sync peer materializes them in the same
    //    order and never observes a page without its space property in
    //    steady state.
    set_property_in_tx(
        &mut tx,
        device_id,
        block.id.clone(),
        "space",
        None,
        None,
        None,
        Some(space_id),
    )
    .await?;

    tx.commit().await?;
    Ok(new_page_id)
}

/// Tauri command wrapper around [`create_page_in_space_inner`].
///
/// Returns a plain `String` (the new page's ULID) rather than `BlockId`
/// to keep the specta-generated bindings the simple shape the frontend
/// expects. Background cache tasks (tag-inheritance, block-tag-refs,
/// FTS indexing) are dispatched after the ops are committed — we
/// deliberately wait until the full page-create-plus-set-property pair
/// is durable before scheduling derived-state work.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn create_page_in_space(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    parent_id: Option<String>,
    content: String,
    space_id: String,
) -> Result<String, AppError> {
    let id = create_page_in_space_inner(
        &pool.0,
        device_id.as_str(),
        parent_id,
        content,
        space_id.clone(),
    )
    .await
    .map_err(sanitize_internal_error)?;

    // After the commit succeeds, enqueue the same background cache
    // rebuilds that `create_block` would trigger. We re-read the
    // freshly-appended op records rather than threading them through
    // the _inner return type — the materializer operates on `OpRecord`
    // so we need the hash + seq + timestamps the op_log stamped.
    dispatch_background_for_page_create(&pool.0, &materializer, id.as_str(), &space_id).await;

    Ok(id.into_string())
}

/// Re-fetch and dispatch the two ops that `create_page_in_space_inner`
/// emitted so background caches (tag-inheritance, FTS, pages_cache,
/// projected agenda) stay consistent. Silent on lookup failure — the
/// rows were just committed by the same task, but the background-
/// dispatch layer already logs warnings via
/// `Materializer::dispatch_background_or_warn` when it fails.
async fn dispatch_background_for_page_create(
    pool: &SqlitePool,
    materializer: &Materializer,
    page_id: &str,
    _space_id: &str,
) {
    // Fetch the two most recent op_log rows for this block — both were
    // appended inside the same transaction above, so they are the
    // highest-`seq` rows for this device that carry `block_id = ?`.
    // ORDER BY seq ASC so we dispatch CreateBlock before SetProperty.
    let rows = sqlx::query_as!(
        crate::op_log::OpRecord,
        r#"SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at
           FROM op_log
           WHERE block_id = ?
           ORDER BY seq ASC"#,
        page_id,
    )
    .fetch_all(pool)
    .await;
    match rows {
        Ok(rows) => {
            for rec in &rows {
                materializer.dispatch_background_or_warn(rec);
            }
        }
        Err(e) => {
            tracing::warn!(
                page_id,
                error = %e,
                "create_page_in_space: failed to re-fetch op records for background dispatch"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use super::*;
    use crate::db::init_pool;
    use crate::spaces::bootstrap_spaces;
    use crate::spaces::{SPACE_PERSONAL_ULID, SPACE_WORK_ULID};

    const DEV: &str = "test-device";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a live page block that is NOT a space (no `is_space`
    /// property). Used to verify the filter on the command query.
    async fn insert_plain_page(pool: &SqlitePool, id: &str, content: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, is_conflict) \
             VALUES (?, 'page', ?, NULL, 1, ?, 0)",
            id,
            content,
            id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Mark an existing block as a space (`is_space = "true"`).
    async fn mark_as_space(pool: &SqlitePool, id: &str) {
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
            id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn list_spaces_returns_both_seeded() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        let spaces = list_spaces_inner(&pool).await.unwrap();
        assert_eq!(
            spaces.len(),
            2,
            "bootstrap seeds exactly two spaces; list_spaces must return both"
        );

        let ids: Vec<&str> = spaces.iter().map(|s| s.id.as_str()).collect();
        assert!(
            ids.contains(&SPACE_PERSONAL_ULID),
            "Personal space must appear in list_spaces"
        );
        assert!(
            ids.contains(&SPACE_WORK_ULID),
            "Work space must appear in list_spaces"
        );
    }

    #[tokio::test]
    async fn list_spaces_excludes_pages_without_is_space() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        // A regular (non-space) page must not surface from list_spaces —
        // the `INNER JOIN block_properties ON key = 'is_space'` excludes it.
        insert_plain_page(&pool, "01JABCD0000000000000000001", "Just a page").await;

        let spaces = list_spaces_inner(&pool).await.unwrap();
        assert_eq!(
            spaces.len(),
            2,
            "non-space pages must not appear in list_spaces"
        );
        assert!(
            spaces.iter().all(|s| s.id != "01JABCD0000000000000000001"),
            "non-space page ID must not appear in results"
        );
    }

    #[tokio::test]
    async fn list_spaces_orders_alphabetically() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        let spaces = list_spaces_inner(&pool).await.unwrap();
        assert_eq!(spaces.len(), 2);
        assert_eq!(
            spaces[0].name, "Personal",
            "Personal sorts before Work alphabetically"
        );
        assert_eq!(spaces[1].name, "Work");
    }

    #[tokio::test]
    async fn list_spaces_excludes_deleted_and_conflict_spaces() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        // Manufacture a soft-deleted "Archive" space.
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, is_conflict, deleted_at) \
             VALUES (?, 'page', 'Archive', NULL, 1, ?, 0, '2025-01-01T00:00:00Z')",
            "01JABCD0000000000000000001",
            "01JABCD0000000000000000001",
        )
        .execute(&pool)
        .await
        .unwrap();
        mark_as_space(&pool, "01JABCD0000000000000000001").await;

        // Manufacture a conflict-copy "Copy" space.
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, is_conflict) \
             VALUES (?, 'page', 'Copy', NULL, 1, ?, 1)",
            "01JABCD0000000000000000002",
            "01JABCD0000000000000000002",
        )
        .execute(&pool)
        .await
        .unwrap();
        mark_as_space(&pool, "01JABCD0000000000000000002").await;

        let spaces = list_spaces_inner(&pool).await.unwrap();
        assert_eq!(
            spaces.len(),
            2,
            "deleted + conflict spaces must be filtered out; only Personal + Work remain"
        );
        let names: Vec<&str> = spaces.iter().map(|s| s.name.as_str()).collect();
        assert!(!names.contains(&"Archive"), "soft-deleted space excluded");
        assert!(!names.contains(&"Copy"), "conflict-copy space excluded");
    }

    #[tokio::test]
    async fn list_spaces_on_empty_db_returns_empty_vec() {
        let (pool, _dir) = test_pool().await;
        // No bootstrap — no spaces.
        let spaces = list_spaces_inner(&pool).await.unwrap();
        assert_eq!(spaces.len(), 0, "empty DB yields no spaces");
    }

    #[tokio::test]
    async fn list_spaces_row_fields_match_seed_data() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        let spaces = list_spaces_inner(&pool).await.unwrap();
        let personal = spaces
            .iter()
            .find(|s| s.id == SPACE_PERSONAL_ULID)
            .expect("Personal present");
        assert_eq!(personal.name, "Personal");
        let work = spaces
            .iter()
            .find(|s| s.id == SPACE_WORK_ULID)
            .expect("Work present");
        assert_eq!(work.name, "Work");
    }

    // ---------------------------------------------------------------------
    // FEAT-3 Phase 2 — `create_page_in_space_inner` tests
    // ---------------------------------------------------------------------
    //
    // Covers the happy path, op-log atomicity, and every validation
    // branch (nonexistent target, missing `is_space` flag, soft-deleted
    // target, conflict copy, nested-parent path). Each test uses a
    // fresh `test_pool()` + `bootstrap_spaces()` so the seeded Personal
    // / Work spaces are available as valid targets.

    /// Count every row in `op_log`. Used to assert append-only
    /// atomicity: a validation failure must leave the log unchanged.
    async fn count_op_log(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar!(r#"SELECT COUNT(*) as "n!: i64" FROM op_log"#)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// Count `op_log` rows whose extracted `block_id` column matches
    /// `id`. `block_id` is populated on insert for every op type (see
    /// `op_log::extract_block_id`), so both `CreateBlock` and
    /// `SetProperty` rows are captured.
    async fn count_ops_for_block(pool: &SqlitePool, id: &str) -> i64 {
        sqlx::query_scalar!(
            r#"SELECT COUNT(*) as "n!: i64" FROM op_log WHERE block_id = ?"#,
            id
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// Return `(block_type, content, parent_id)` for the block with
    /// `id`, or `None` if no such row exists.
    async fn get_block_fields(
        pool: &SqlitePool,
        id: &str,
    ) -> Option<(String, Option<String>, Option<String>)> {
        sqlx::query!(
            r#"SELECT block_type as "block_type!: String", content, parent_id
               FROM blocks WHERE id = ?"#,
            id
        )
        .fetch_optional(pool)
        .await
        .unwrap()
        .map(|r| (r.block_type, r.content, r.parent_id))
    }

    /// Return the `value_ref` of the `space` property for `block_id`,
    /// or `None` if no such property exists.
    async fn get_space_property_ref(pool: &SqlitePool, block_id: &str) -> Option<String> {
        sqlx::query_scalar!(
            r#"SELECT value_ref FROM block_properties
               WHERE block_id = ? AND key = 'space'"#,
            block_id
        )
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten()
    }

    #[tokio::test]
    async fn create_page_in_space_happy_path() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        let new_id = create_page_in_space_inner(
            &pool,
            DEV,
            None,
            "My page".into(),
            SPACE_PERSONAL_ULID.to_owned(),
        )
        .await
        .expect("happy-path create must succeed");
        let id = new_id.as_str();

        let fields = get_block_fields(&pool, id)
            .await
            .expect("new page must materialize a blocks row");
        let (block_type, content, parent_id) = fields;
        assert_eq!(block_type, "page", "new block must be block_type = 'page'");
        assert_eq!(
            content.as_deref(),
            Some("My page"),
            "content must match the caller-supplied value"
        );
        assert!(
            parent_id.is_none(),
            "top-level page has no parent_id; got {parent_id:?}"
        );

        let space_ref = get_space_property_ref(&pool, id).await;
        assert_eq!(
            space_ref.as_deref(),
            Some(SPACE_PERSONAL_ULID),
            "space property must point to the requested space"
        );
    }

    #[tokio::test]
    async fn create_page_in_space_emits_two_ops_atomically() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        let before = count_op_log(&pool).await;

        let new_id = create_page_in_space_inner(
            &pool,
            DEV,
            None,
            "Atomic ops page".into(),
            SPACE_PERSONAL_ULID.to_owned(),
        )
        .await
        .expect("create must succeed");
        let id = new_id.as_str();

        let after = count_op_log(&pool).await;
        assert_eq!(
            after - before,
            2,
            "exactly two ops must be appended (create_block + set_property(space))"
        );

        let per_block = count_ops_for_block(&pool, id).await;
        assert_eq!(
            per_block, 2,
            "both appended ops must reference the new page id (got {per_block})"
        );
    }

    #[tokio::test]
    async fn create_page_in_space_rejects_nonexistent_space() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        let before = count_op_log(&pool).await;

        let bogus = "01JXXXX0000000000000000000".to_owned();
        let result = create_page_in_space_inner(&pool, DEV, None, "Rejected".into(), bogus).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "nonexistent space_id must yield AppError::Validation, got {result:?}"
        );
        assert_eq!(
            count_op_log(&pool).await,
            before,
            "atomicity: a validation failure must not append any ops"
        );
    }

    #[tokio::test]
    async fn create_page_in_space_rejects_target_without_is_space() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        // A live page block that is NOT a space (no `is_space` property).
        let plain_id = "01JPLAIN0000000000000000AB";
        insert_plain_page(&pool, plain_id, "Just a page").await;

        let before = count_op_log(&pool).await;

        let result =
            create_page_in_space_inner(&pool, DEV, None, "Nope".into(), plain_id.to_owned()).await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "plain page (no is_space) must be rejected with Validation, got {result:?}"
        );
        assert_eq!(
            count_op_log(&pool).await,
            before,
            "atomicity: validation failure must not append any ops"
        );
    }

    #[tokio::test]
    async fn create_page_in_space_rejects_deleted_space_target() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        // Soft-delete the Work space via direct SQL (bypassing the
        // command layer) to simulate the state we need to guard against.
        sqlx::query!(
            "UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = ?",
            SPACE_WORK_ULID
        )
        .execute(&pool)
        .await
        .unwrap();

        let before = count_op_log(&pool).await;

        let result = create_page_in_space_inner(
            &pool,
            DEV,
            None,
            "Should not land".into(),
            SPACE_WORK_ULID.to_owned(),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "soft-deleted space target must be rejected with Validation, got {result:?}"
        );
        assert_eq!(
            count_op_log(&pool).await,
            before,
            "atomicity: validation failure must not append any ops"
        );
    }

    #[tokio::test]
    async fn create_page_in_space_rejects_conflict_space_target() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        // Flip `is_conflict = 1` on the Work space directly.
        sqlx::query!(
            "UPDATE blocks SET is_conflict = 1 WHERE id = ?",
            SPACE_WORK_ULID
        )
        .execute(&pool)
        .await
        .unwrap();

        let before = count_op_log(&pool).await;

        let result = create_page_in_space_inner(
            &pool,
            DEV,
            None,
            "Should not land".into(),
            SPACE_WORK_ULID.to_owned(),
        )
        .await;

        assert!(
            matches!(result, Err(AppError::Validation(_))),
            "conflict-copy space target must be rejected with Validation, got {result:?}"
        );
        assert_eq!(
            count_op_log(&pool).await,
            before,
            "atomicity: validation failure must not append any ops"
        );
    }

    #[tokio::test]
    async fn create_page_in_space_with_parent_id_creates_nested_page() {
        let (pool, _dir) = test_pool().await;
        bootstrap_spaces(&pool, DEV).await.unwrap();

        // Seed a parent page inside Personal so the child inherits the
        // same space via its own `space` property.
        let parent_id = create_page_in_space_inner(
            &pool,
            DEV,
            None,
            "Parent".into(),
            SPACE_PERSONAL_ULID.to_owned(),
        )
        .await
        .expect("parent create must succeed");
        let parent = parent_id.as_str().to_owned();

        let child_id = create_page_in_space_inner(
            &pool,
            DEV,
            Some(parent.clone()),
            "Child".into(),
            SPACE_PERSONAL_ULID.to_owned(),
        )
        .await
        .expect("child create must succeed");
        let child = child_id.as_str();

        let (_btype, _content, got_parent) = get_block_fields(&pool, child)
            .await
            .expect("child block row must exist");
        assert_eq!(
            got_parent.as_deref(),
            Some(parent.as_str()),
            "child must carry parent_id = parent"
        );

        let child_space = get_space_property_ref(&pool, child).await;
        assert_eq!(
            child_space.as_deref(),
            Some(SPACE_PERSONAL_ULID),
            "child must carry the same space property as its parent"
        );
    }
}
