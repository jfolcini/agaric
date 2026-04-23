//! FEAT-3 Phase 1: `list_spaces` Tauri command.
//!
//! A "space" is a page block marked with `is_space = "true"`. This
//! command returns every such live, non-conflict block as a lightweight
//! `{ id, name }` shape for the sidebar `SpaceSwitcher`. Ordering is
//! alphabetical by name so the UI is deterministic and tests can assert
//! exact positions.
//!
//! Read-only; no device_id, no materializer — just a reader pool query.

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::db::ReadPool;
use crate::error::AppError;

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
}
