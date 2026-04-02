//! Soft-delete with cascade, restore, and purge operations.
//!
//! - **cascade soft-delete**: sets `deleted_at` on a block and ALL descendants
//!   via recursive CTE, using a single shared timestamp.
//! - **restore**: clears `deleted_at` on a block and descendants that share the
//!   same `deleted_at` timestamp (preserving independent deletes).
//! - **purge**: physically removes a block, its descendants, and all dependent
//!   rows from every FK-referencing table.  Irreversible.

use sqlx::SqlitePool;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Check whether a block is currently soft-deleted.
///
/// Returns `None` if the block does not exist, `Some(true)` if deleted,
/// `Some(false)` if alive.
pub async fn is_deleted(pool: &SqlitePool, block_id: &str) -> Result<Option<bool>, AppError> {
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", block_id,)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.deleted_at.is_some()))
}

/// Return the IDs of a block and all its descendants via recursive CTE.
///
/// Includes already-deleted descendants (unlike cascade which skips them).
/// Returns an empty `Vec` if the block does not exist.
pub async fn get_descendants(pool: &SqlitePool, block_id: &str) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         SELECT id FROM descendants",
        block_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.id).collect())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Soft-delete a single block (no cascade).
///
/// Returns `Some(timestamp)` if a block was newly deleted, or `None` if the
/// block does not exist or was already deleted.
pub async fn soft_delete_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<Option<String>, AppError> {
    let now = crate::now_rfc3339();
    let result = sqlx::query!(
        "UPDATE blocks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
        now,
        block_id
    )
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        Ok(None)
    } else {
        Ok(Some(now))
    }
}

/// Cascade soft-delete: sets `deleted_at` on the block and all non-deleted
/// descendants via recursive CTE.
///
/// Descendants that are already soft-deleted (different timestamp) are left
/// untouched, and the CTE will **not** traverse through them.
///
/// Returns `(timestamp, affected_count)` — the shared timestamp used and the
/// number of rows that were newly deleted.
///
/// **Note:** This function exists primarily for benchmarks and test setup.
/// Production code uses the corresponding command in `commands.rs`, which
/// also appends an op-log entry and dispatches materializer tasks.
pub async fn cascade_soft_delete(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(String, u64), AppError> {
    let now = crate::now_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let result = sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL \
         ) \
         UPDATE blocks SET deleted_at = ? \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at IS NULL",
        block_id,
        now,
    )
    .execute(&mut *tx)
    .await?;

    let count = result.rows_affected();
    tx.commit().await?;
    Ok((now, count))
}

/// Restore a soft-deleted block and descendants sharing the same `deleted_at`
/// timestamp.
///
/// The CTE traverses ALL descendants regardless of their `deleted_at` value,
/// but the UPDATE only clears `deleted_at` on blocks matching `deleted_at_ref`.
/// This preserves independently deleted descendants.
///
/// Returns the number of rows restored.
///
/// **Note:** This function exists primarily for benchmarks and test setup.
/// Production code uses the corresponding command in `commands.rs`, which
/// also appends an op-log entry and dispatches materializer tasks.
pub async fn restore_block(
    pool: &SqlitePool,
    block_id: &str,
    deleted_at_ref: &str,
) -> Result<u64, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let result = sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at = ?",
        block_id,
        deleted_at_ref,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(result.rows_affected())
}

/// Validate that an attachment `fs_path` is safe for file-system deletion.
///
/// Rejects absolute paths and `..` traversal components to prevent a
/// compromised or corrupt DB row from causing deletion of arbitrary files.
fn is_safe_attachment_path(path: &str) -> bool {
    use std::path::Path;
    let p = Path::new(path);
    // Reject absolute paths (e.g. "/etc/passwd", "C:\...")
    if p.is_absolute() {
        return false;
    }
    // Reject any component that is ".."
    p.components()
        .all(|c| !matches!(c, std::path::Component::ParentDir))
}

/// Permanently delete a block and all its descendants (physical removal).
///
/// Uses batch CTE-based DELETEs to clean every FK-referencing table in ~12
/// queries total (regardless of subtree size), then removes blocks with
/// deferred FK enforcement.
///
/// **WARNING**: Irreversible.  Only for explicit user action or 30-day trash
/// cleanup.
pub async fn purge_block(pool: &SqlitePool, block_id: &str) -> Result<u64, AppError> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    // Defer FK checks until commit — the entire subtree will be gone by then
    // so no constraints will be violated.  The pragma resets automatically at
    // COMMIT/ROLLBACK.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;

    // --- Batch-clean dependent tables (one query each) ---
    // Each query embeds the recursive CTE inline.  SQLite's engine is
    // efficient for in-memory trees, and this keeps each statement
    // self-contained for compile-time verification by the sqlx macros.

    // block_tags: either column may reference a descendant
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM block_tags \
         WHERE block_id IN (SELECT id FROM descendants) \
            OR tag_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // block_properties: owned by descendants
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM block_properties \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // block_properties: value_ref pointing into the subtree (NULLify, don't
    // delete — the row belongs to a block outside the subtree)
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         UPDATE block_properties SET value_ref = NULL \
         WHERE value_ref IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // block_links: either end may be in the subtree
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM block_links \
         WHERE source_id IN (SELECT id FROM descendants) \
            OR target_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // agenda_cache
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM agenda_cache \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // tags_cache
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM tags_cache \
         WHERE tag_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // pages_cache
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM pages_cache \
         WHERE page_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // attachments — collect fs_path values BEFORE deleting rows so we can
    // remove the physical files after the transaction commits successfully.
    let attachment_rows = sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         SELECT fs_path FROM attachments \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .fetch_all(&mut *tx)
    .await?;

    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM attachments \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // block_drafts
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM block_drafts \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // Nullify conflict_source refs from blocks outside the subtree.
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         UPDATE blocks SET conflict_source = NULL \
         WHERE conflict_source IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // fts_blocks (FTS5 virtual table — no FK, must be cleaned explicitly)
    sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM fts_blocks \
         WHERE block_id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    // --- Delete blocks (deferred FK allows single-statement batch) ---
    let result = sqlx::query!(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         DELETE FROM blocks \
         WHERE id IN (SELECT id FROM descendants)",
        block_id,
    )
    .execute(&mut *tx)
    .await?;

    let count = result.rows_affected();
    tx.commit().await?;

    // Post-commit: delete physical attachment files from disk.
    // This MUST happen after commit — if we deleted files first and the
    // transaction rolled back, we'd lose files still referenced by DB rows.
    // Worst case here: orphan files on disk (better than dangling DB refs).
    for r in &attachment_rows {
        let path = &r.fs_path;
        if !is_safe_attachment_path(path) {
            tracing::warn!(path, "skipping attachment deletion: unsafe path");
            continue;
        }
        if let Err(e) = std::fs::remove_file(path) {
            // Log but don't fail — the DB rows are already gone.
            // NotFound is expected if the file was already cleaned up.
            tracing::warn!(path, error = %e, "failed to remove attachment file after purge");
        }
    }

    Ok(count)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests for soft-delete, cascade, restore, and purge operations.
    //!
    //! Covers: single soft-delete, cascade through subtrees (deep/wide),
    //! restore with timestamp matching, purge with FK-dependent table cleanup,
    //! and the `is_deleted` / `get_descendants` helpers.

    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    // -- Deterministic test fixtures --

    const BLOCK_A: &str = "BLK_A01";
    const BLOCK_B: &str = "BLK_B02";
    const PARENT: &str = "PAR001";
    const CHILD: &str = "CHD001";
    const CHILD2: &str = "CHD002";
    const GRANDCHILD: &str = "GCH001";
    const FIXED_DELETED_AT: &str = "2025-01-01T00:00:00+00:00";

    // -- Helpers --

    /// Creates a temporary SQLite database with all migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block with optional parent and position.
    async fn insert_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
    ) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, ?, ?, ?)",
            id,
            block_type,
            content,
            parent_id,
            position,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Read `deleted_at` for a block. Returns None if block does not exist.
    async fn get_deleted_at(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", id)
            .fetch_optional(pool)
            .await
            .unwrap()
            .and_then(|r| r.deleted_at)
    }

    /// Check if a block row exists in the `blocks` table.
    async fn block_exists(pool: &SqlitePool, id: &str) -> bool {
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", id)
            .fetch_one(pool)
            .await
            .unwrap();
        count > 0
    }

    // ======================================================================
    // soft_delete_block (single, no cascade)
    // ======================================================================

    #[tokio::test]
    async fn soft_delete_block_marks_single_block_as_deleted() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "hello", None, None).await;

        let ts = soft_delete_block(&pool, BLOCK_A)
            .await
            .unwrap()
            .expect("should return timestamp for newly deleted block");

        let deleted_at = get_deleted_at(&pool, BLOCK_A).await;
        assert_eq!(
            deleted_at,
            Some(ts),
            "deleted_at in DB should match returned timestamp"
        );
    }

    #[tokio::test]
    async fn soft_delete_block_already_deleted_returns_none() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "hello", None, None).await;

        let ts1 = soft_delete_block(&pool, BLOCK_A).await.unwrap().unwrap();
        let ts2 = soft_delete_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(ts2, None, "second soft-delete should be a no-op");

        let deleted_at = get_deleted_at(&pool, BLOCK_A).await;
        assert_eq!(
            deleted_at,
            Some(ts1),
            "original timestamp should be preserved"
        );
    }

    #[tokio::test]
    async fn soft_delete_block_nonexistent_returns_none() {
        let (pool, _dir) = test_pool().await;

        let result = soft_delete_block(&pool, "NONEXISTENT").await.unwrap();
        assert_eq!(
            result, None,
            "soft-deleting a nonexistent block should return None"
        );
    }

    #[tokio::test]
    async fn soft_delete_block_independent_calls_produce_ordered_timestamps() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "a", None, None).await;
        insert_block(&pool, BLOCK_B, "content", "b", None, None).await;

        let ts1 = soft_delete_block(&pool, BLOCK_A).await.unwrap().unwrap();
        let ts2 = soft_delete_block(&pool, BLOCK_B).await.unwrap().unwrap();

        assert!(
            ts1 <= ts2,
            "timestamps should be monotonically ordered: '{ts1}' <= '{ts2}'"
        );
    }

    // ======================================================================
    // cascade_soft_delete
    // ======================================================================

    #[tokio::test]
    async fn cascade_soft_delete_marks_entire_subtree() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_block(
            &pool,
            GRANDCHILD,
            "content",
            "grandchild",
            Some(CHILD),
            Some(1),
        )
        .await;

        let (ts, count) = cascade_soft_delete(&pool, PARENT).await.unwrap();

        assert_eq!(count, 3, "parent + child + grandchild = 3");
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(ts.clone()));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(ts.clone()));
        assert_eq!(get_deleted_at(&pool, GRANDCHILD).await, Some(ts));
    }

    #[tokio::test]
    async fn cascade_soft_delete_skips_already_deleted_subtree() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_block(
            &pool,
            GRANDCHILD,
            "content",
            "grandchild",
            Some(CHILD),
            Some(1),
        )
        .await;

        // Independently delete the child first.
        let t1 = soft_delete_block(&pool, CHILD).await.unwrap().unwrap();

        // Ensure the next wall-clock timestamp is strictly after t1.
        // now_rfc3339() has millisecond precision — without this sleep,
        // both calls can land in the same millisecond, making t1 == t2.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;

        // Cascade-delete parent: CTE does NOT traverse through the
        // already-deleted child, so grandchild is NOT reached.
        let (t2, count) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        assert_ne!(
            t1, t2,
            "cascade timestamp must differ from independent delete timestamp"
        );
        assert_eq!(count, 1, "only the parent should be newly deleted");

        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(t2));
        assert_eq!(
            get_deleted_at(&pool, CHILD).await,
            Some(t1),
            "child keeps its original independent timestamp"
        );
        assert_eq!(
            get_deleted_at(&pool, GRANDCHILD).await,
            None,
            "grandchild was unreachable through deleted child"
        );
    }

    #[tokio::test]
    async fn cascade_soft_delete_on_leaf_node_deletes_only_itself() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "LEAF01", "content", "leaf node", None, Some(1)).await;

        let (ts, count) = cascade_soft_delete(&pool, "LEAF01").await.unwrap();

        assert_eq!(count, 1, "leaf node has no descendants");
        assert_eq!(get_deleted_at(&pool, "LEAF01").await, Some(ts));
    }

    #[tokio::test]
    async fn cascade_soft_delete_on_nonexistent_returns_zero() {
        let (pool, _dir) = test_pool().await;

        let (_ts, count) = cascade_soft_delete(&pool, "NONEXISTENT").await.unwrap();
        assert_eq!(count, 0, "no rows affected for nonexistent block");
    }

    #[tokio::test]
    async fn cascade_soft_delete_handles_deep_linear_chain() {
        let (pool, _dir) = test_pool().await;

        // Create a linear chain: L00 -> L01 -> L02 -> ... -> L10
        insert_block(&pool, "L00", "page", "level 0", None, Some(1)).await;
        for i in 1..=10 {
            let id = format!("L{i:02}");
            let parent = format!("L{:02}", i - 1);
            insert_block(
                &pool,
                &id,
                "content",
                &format!("level {i}"),
                Some(&parent),
                Some(1),
            )
            .await;
        }

        let (ts, count) = cascade_soft_delete(&pool, "L00").await.unwrap();
        assert_eq!(count, 11, "L00 through L10 = 11 nodes");

        for i in 0..=10 {
            let id = format!("L{i:02}");
            assert_eq!(
                get_deleted_at(&pool, &id).await,
                Some(ts.clone()),
                "node {id} should share the cascade timestamp"
            );
        }
    }

    #[tokio::test]
    async fn cascade_soft_delete_handles_wide_tree() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "WROOT", "page", "wide root", None, Some(1)).await;
        for i in 0..100 {
            let id = format!("WC{i:03}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("WROOT"),
                Some(i as i64 + 1),
            )
            .await;
        }

        let (ts, count) = cascade_soft_delete(&pool, "WROOT").await.unwrap();
        assert_eq!(count, 101, "root + 100 children");

        assert_eq!(get_deleted_at(&pool, "WROOT").await, Some(ts.clone()));
        for i in 0..100 {
            let id = format!("WC{i:03}");
            assert_eq!(get_deleted_at(&pool, &id).await, Some(ts.clone()));
        }
    }

    #[tokio::test]
    async fn cascade_soft_delete_leaves_sibling_trees_untouched() {
        let (pool, _dir) = test_pool().await;

        // Two independent trees side by side.
        insert_block(&pool, "TREE_A", "page", "tree a root", None, Some(1)).await;
        insert_block(
            &pool,
            "TREE_A_C",
            "content",
            "tree a child",
            Some("TREE_A"),
            Some(1),
        )
        .await;
        insert_block(&pool, "TREE_B", "page", "tree b root", None, Some(2)).await;
        insert_block(
            &pool,
            "TREE_B_C",
            "content",
            "tree b child",
            Some("TREE_B"),
            Some(1),
        )
        .await;

        // Cascade delete tree A only.
        cascade_soft_delete(&pool, "TREE_A").await.unwrap();

        assert_eq!(
            get_deleted_at(&pool, "TREE_B").await,
            None,
            "sibling tree root should be unaffected"
        );
        assert_eq!(
            get_deleted_at(&pool, "TREE_B_C").await,
            None,
            "sibling tree child should be unaffected"
        );
    }

    // ======================================================================
    // restore_block
    // ======================================================================

    #[tokio::test]
    async fn restore_block_clears_entire_subtree() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_block(
            &pool,
            GRANDCHILD,
            "content",
            "grandchild",
            Some(CHILD),
            Some(1),
        )
        .await;

        let (ts, _) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        let restored = restore_block(&pool, PARENT, &ts).await.unwrap();

        assert_eq!(restored, 3, "parent + child + grandchild");
        assert_eq!(get_deleted_at(&pool, PARENT).await, None);
        assert_eq!(get_deleted_at(&pool, CHILD).await, None);
        assert_eq!(get_deleted_at(&pool, GRANDCHILD).await, None);
    }

    #[tokio::test]
    async fn restore_block_preserves_independently_deleted_descendants() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_block(
            &pool,
            GRANDCHILD,
            "content",
            "grandchild",
            Some(CHILD),
            Some(1),
        )
        .await;

        // Independently delete grandchild with a fixed timestamp.
        sqlx::query!(
            "UPDATE blocks SET deleted_at = ? WHERE id = ?",
            FIXED_DELETED_AT,
            GRANDCHILD,
        )
        .execute(&pool)
        .await
        .unwrap();

        // Cascade-delete parent (child gets t2, grandchild already has FIXED_DELETED_AT).
        let (t2, _) = cascade_soft_delete(&pool, PARENT).await.unwrap();

        // Restore using the cascade timestamp.
        let restored = restore_block(&pool, PARENT, &t2).await.unwrap();
        assert_eq!(restored, 2, "parent + child restored");

        assert_eq!(get_deleted_at(&pool, PARENT).await, None);
        assert_eq!(get_deleted_at(&pool, CHILD).await, None);
        assert_eq!(
            get_deleted_at(&pool, GRANDCHILD).await,
            Some(FIXED_DELETED_AT.to_string()),
            "grandchild retains its independent deletion timestamp"
        );
    }

    #[tokio::test]
    async fn restore_block_on_non_deleted_returns_zero() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "alive", None, None).await;

        let restored = restore_block(&pool, BLOCK_A, FIXED_DELETED_AT)
            .await
            .unwrap();
        assert_eq!(
            restored, 0,
            "restoring a non-deleted block should affect 0 rows"
        );
    }

    // ======================================================================
    // purge_block
    // ======================================================================

    #[tokio::test]
    async fn purge_block_removes_entire_subtree() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_block(
            &pool,
            GRANDCHILD,
            "content",
            "grandchild",
            Some(CHILD),
            Some(1),
        )
        .await;

        let count = purge_block(&pool, PARENT).await.unwrap();
        assert_eq!(count, 3, "parent + child + grandchild purged");

        assert!(!block_exists(&pool, PARENT).await, "parent should be gone");
        assert!(!block_exists(&pool, CHILD).await, "child should be gone");
        assert!(
            !block_exists(&pool, GRANDCHILD).await,
            "grandchild should be gone"
        );
    }

    #[tokio::test]
    async fn purge_block_cleans_dependent_tables() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "to purge", None, None).await;
        insert_block(&pool, "TAG001", "tag", "my-tag", None, None).await;
        insert_block(&pool, "TARGET", "content", "link target", None, None).await;

        // block_tags
        sqlx::query!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            BLOCK_A,
            "TAG001",
        )
        .execute(&pool)
        .await
        .unwrap();

        // block_properties
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)",
            BLOCK_A,
            "status",
            "done",
        )
        .execute(&pool)
        .await
        .unwrap();

        // block_links
        sqlx::query!(
            "INSERT INTO block_links (source_id, target_id) VALUES (?, ?)",
            BLOCK_A,
            "TARGET",
        )
        .execute(&pool)
        .await
        .unwrap();

        let count = purge_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(count, 1);

        let tags: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_tags WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tags, 0, "block_tags rows should be purged");

        let props: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ?",
            BLOCK_A,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(props, 0, "block_properties rows should be purged");

        let links: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_links WHERE source_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(links, 0, "block_links rows should be purged");

        assert!(
            block_exists(&pool, "TAG001").await,
            "TAG001 should survive purge"
        );
        assert!(
            block_exists(&pool, "TARGET").await,
            "TARGET should survive purge"
        );
    }

    #[tokio::test]
    async fn purge_block_cleans_tag_id_in_block_tags() {
        let (pool, _dir) = test_pool().await;

        // A content block tagged with TAG001. We purge the TAG, not the
        // content block — the block_tags row must be cleaned via the tag_id
        // column.
        insert_block(&pool, "CONTENT", "content", "my note", None, None).await;
        insert_block(&pool, "TAG001", "tag", "important", None, None).await;

        sqlx::query!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            "CONTENT",
            "TAG001",
        )
        .execute(&pool)
        .await
        .unwrap();

        purge_block(&pool, "TAG001").await.unwrap();

        let count: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM block_tags WHERE tag_id = ?", "TAG001")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0, "block_tags row should be cleaned via tag_id");
        assert!(
            block_exists(&pool, "CONTENT").await,
            "content block should survive"
        );
    }

    #[tokio::test]
    async fn purge_block_nullifies_value_ref_in_properties() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "REFTGT", "content", "ref target", None, None).await;
        insert_block(&pool, "OWNER", "content", "owner", None, None).await;

        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, ?, ?)",
            "OWNER",
            "link",
            "REFTGT",
        )
        .execute(&pool)
        .await
        .unwrap();

        purge_block(&pool, "REFTGT").await.unwrap();

        let row = sqlx::query!(
            "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = ?",
            "OWNER",
            "link",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row.value_ref, None,
            "value_ref should be NULLed after purge"
        );
    }

    #[tokio::test]
    async fn purge_block_nullifies_conflict_source() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "ORIGINAL", "content", "original", None, None).await;
        insert_block(&pool, "CONFLICT", "content", "conflict copy", None, None).await;

        // ORIGINAL.conflict_source → CONFLICT
        sqlx::query!(
            "UPDATE blocks SET conflict_source = ? WHERE id = ?",
            "CONFLICT",
            "ORIGINAL",
        )
        .execute(&pool)
        .await
        .unwrap();

        purge_block(&pool, "CONFLICT").await.unwrap();

        let row = sqlx::query!(
            "SELECT conflict_source FROM blocks WHERE id = ?",
            "ORIGINAL",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row.conflict_source, None,
            "conflict_source should be NULLed after purge"
        );
    }

    #[tokio::test]
    async fn purge_block_nonexistent_returns_zero() {
        let (pool, _dir) = test_pool().await;

        let count = purge_block(&pool, "DOES_NOT_EXIST").await.unwrap();
        assert_eq!(count, 0, "purging a nonexistent block should affect 0 rows");
    }

    // ======================================================================
    // purge_block: related table cleanup (F14)
    // ======================================================================

    #[tokio::test]
    async fn purge_block_cleans_agenda_cache() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "task with date", None, None).await;
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
            BLOCK_A,
            "due",
            "2025-06-01",
        )
        .execute(&pool)
        .await
        .unwrap();
        crate::cache::rebuild_agenda_cache(&pool).await.unwrap();

        let before: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM agenda_cache WHERE block_id = ?",
            BLOCK_A,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(before > 0, "agenda_cache should have an entry before purge");

        purge_block(&pool, BLOCK_A).await.unwrap();

        let after: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM agenda_cache WHERE block_id = ?",
            BLOCK_A,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0, "agenda_cache rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_cleans_tags_cache() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PTAG01", "tag", "purge-me-tag", None, None).await;
        crate::cache::rebuild_tags_cache(&pool).await.unwrap();

        let before: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM tags_cache WHERE tag_id = ?", "PTAG01",)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(before > 0, "tags_cache should have an entry before purge");

        purge_block(&pool, "PTAG01").await.unwrap();

        let after: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM tags_cache WHERE tag_id = ?", "PTAG01",)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(after, 0, "tags_cache rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_cleans_pages_cache() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PPAGE1", "page", "Purge Page", None, None).await;
        crate::cache::rebuild_pages_cache(&pool).await.unwrap();

        let before: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM pages_cache WHERE page_id = ?",
            "PPAGE1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(before > 0, "pages_cache should have an entry before purge");

        purge_block(&pool, "PPAGE1").await.unwrap();

        let after: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM pages_cache WHERE page_id = ?",
            "PPAGE1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0, "pages_cache rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_cleans_attachments() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "has attachment", None, None).await;
        sqlx::query!(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            "ATT001",
            BLOCK_A,
            "image/png",
            "photo.png",
            1024_i64,
            "attachments/photo.png",
            "2025-01-01T00:00:00Z",
        )
        .execute(&pool)
        .await
        .unwrap();

        purge_block(&pool, BLOCK_A).await.unwrap();

        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM attachments WHERE block_id = ?",
            BLOCK_A,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "attachments rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_deletes_attachment_files_on_disk() {
        let (pool, _dir) = test_pool().await;

        // Create real files at *relative* paths — the validation rejects
        // absolute paths, so we use a per-test subdirectory in the CWD.
        let test_dir = "_test_att_disk_purge";
        std::fs::create_dir_all(test_dir).unwrap();
        let file1_rel = format!("{}/att_file1.png", test_dir);
        let file2_rel = format!("{}/att_file2.jpg", test_dir);
        std::fs::write(&file1_rel, b"fake png data").unwrap();
        std::fs::write(&file2_rel, b"fake jpg data").unwrap();

        // Guard removes the directory even if the test panics.
        struct Cleanup(&'static str);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(self.0);
            }
        }
        let _cleanup = Cleanup(test_dir);

        assert!(
            std::path::Path::new(&file1_rel).exists(),
            "precondition: file1 exists"
        );
        assert!(
            std::path::Path::new(&file2_rel).exists(),
            "precondition: file2 exists"
        );

        insert_block(&pool, BLOCK_A, "content", "has attachments", None, None).await;

        // Two attachment rows pointing at real (relative) files.
        for (att_id, path) in [
            ("ATT_F1", file1_rel.as_str()),
            ("ATT_F2", file2_rel.as_str()),
        ] {
            sqlx::query!(
                "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                att_id,
                BLOCK_A,
                "image/png",
                "photo.png",
                1024_i64,
                path,
                "2025-01-01T00:00:00Z",
            )
            .execute(&pool)
            .await
            .unwrap();
        }

        purge_block(&pool, BLOCK_A).await.unwrap();

        assert!(
            !std::path::Path::new(&file1_rel).exists(),
            "attachment file1 should be deleted from disk after purge"
        );
        assert!(
            !std::path::Path::new(&file2_rel).exists(),
            "attachment file2 should be deleted from disk after purge"
        );
    }

    #[tokio::test]
    async fn purge_block_without_attachments_succeeds() {
        // Ensures purge works fine when there are no attachment rows at all
        // (the SELECT returns an empty Vec and the file-deletion loop is a no-op).
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "no attachments here", None, None).await;

        let count = purge_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(count, 1, "block should be purged");
        assert!(!block_exists(&pool, BLOCK_A).await, "block should be gone");
    }

    #[tokio::test]
    async fn purge_block_handles_missing_attachment_file_gracefully() {
        let (pool, _dir) = test_pool().await;

        insert_block(
            &pool,
            BLOCK_A,
            "content",
            "attachment with missing file",
            None,
            None,
        )
        .await;

        // Attachment row points to a non-existent file path.
        sqlx::query!(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            "ATT_GONE",
            BLOCK_A,
            "application/pdf",
            "report.pdf",
            2048_i64,
            "attachments/nonexistent_report.pdf",
            "2025-01-01T00:00:00Z",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Should succeed despite the missing file — errors are logged, not propagated.
        let count = purge_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(
            count, 1,
            "block should be purged even when attachment file is missing"
        );

        let att_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM attachments WHERE block_id = ?",
            BLOCK_A,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            att_count, 0,
            "attachment DB rows should be purged regardless"
        );
    }

    // -----------------------------------------------------------------------
    // is_safe_attachment_path
    // -----------------------------------------------------------------------

    #[test]
    fn safe_path_accepts_simple_relative() {
        assert!(super::is_safe_attachment_path("attachments/photo.png"));
    }

    #[test]
    fn safe_path_accepts_nested_relative() {
        assert!(super::is_safe_attachment_path(
            "attachments/2025/01/photo.png"
        ));
    }

    #[test]
    fn safe_path_accepts_filename_only() {
        assert!(super::is_safe_attachment_path("photo.png"));
    }

    #[test]
    fn safe_path_rejects_absolute_unix() {
        assert!(!super::is_safe_attachment_path("/etc/passwd"));
    }

    #[test]
    fn safe_path_rejects_absolute_tmp() {
        assert!(!super::is_safe_attachment_path("/tmp/photo.png"));
    }

    #[test]
    fn safe_path_rejects_parent_traversal() {
        assert!(!super::is_safe_attachment_path("../../../etc/passwd"));
    }

    #[test]
    fn safe_path_rejects_embedded_parent_traversal() {
        assert!(!super::is_safe_attachment_path(
            "attachments/../../secret.txt"
        ));
    }

    #[test]
    fn safe_path_rejects_dot_dot_only() {
        assert!(!super::is_safe_attachment_path(".."));
    }

    #[tokio::test]
    async fn purge_block_skips_unsafe_attachment_path() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "unsafe attachment", None, None).await;
        sqlx::query!(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            "ATT_UNSAFE",
            BLOCK_A,
            "image/png",
            "photo.png",
            1024_i64,
            "/etc/important_file",
            "2025-01-01T00:00:00Z",
        )
        .execute(&pool)
        .await
        .unwrap();

        // Should succeed — unsafe path is skipped, not attempted.
        let count = purge_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(count, 1, "block should be purged");
        let att_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM attachments WHERE block_id = ?",
            BLOCK_A,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            att_count, 0,
            "attachment DB row should be purged regardless"
        );
    }

    #[tokio::test]
    async fn purge_block_cleans_block_drafts() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "has draft", None, None).await;
        sqlx::query!(
            "INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)",
            BLOCK_A,
            "draft content",
            "2025-01-01T00:00:00Z",
        )
        .execute(&pool)
        .await
        .unwrap();

        purge_block(&pool, BLOCK_A).await.unwrap();

        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_drafts WHERE block_id = ?",
            BLOCK_A,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "block_drafts rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_cleans_fts_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "searchable text", None, None).await;
        crate::fts::update_fts_for_block(&pool, BLOCK_A)
            .await
            .unwrap();

        let before: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?",
            BLOCK_A,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(before > 0, "fts_blocks should have an entry before purge");

        purge_block(&pool, BLOCK_A).await.unwrap();

        let after: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?",
            BLOCK_A,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0, "fts_blocks rows should be purged");
    }

    // ======================================================================
    // Helper functions: is_deleted, get_descendants
    // ======================================================================

    #[tokio::test]
    async fn is_deleted_returns_correct_state_for_each_lifecycle_stage() {
        let (pool, _dir) = test_pool().await;

        assert_eq!(
            is_deleted(&pool, "NOPE").await.unwrap(),
            None,
            "nonexistent block → None"
        );

        insert_block(&pool, BLOCK_A, "content", "hi", None, None).await;
        assert_eq!(
            is_deleted(&pool, BLOCK_A).await.unwrap(),
            Some(false),
            "alive block → Some(false)"
        );

        soft_delete_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(
            is_deleted(&pool, BLOCK_A).await.unwrap(),
            Some(true),
            "soft-deleted block → Some(true)"
        );
    }

    #[tokio::test]
    async fn get_descendants_returns_full_subtree() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_block(&pool, CHILD2, "content", "child2", Some(PARENT), Some(2)).await;
        insert_block(
            &pool,
            GRANDCHILD,
            "content",
            "grandchild",
            Some(CHILD),
            Some(1),
        )
        .await;

        let mut ids = get_descendants(&pool, PARENT).await.unwrap();
        ids.sort();
        assert_eq!(
            ids,
            vec![CHILD, CHILD2, GRANDCHILD, PARENT],
            "should return all nodes in the subtree"
        );
    }

    #[tokio::test]
    async fn get_descendants_nonexistent_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let ids = get_descendants(&pool, "NOPE").await.unwrap();
        assert!(
            ids.is_empty(),
            "nonexistent block should have no descendants"
        );
    }

    // ======================================================================
    // restore_block: mismatched deleted_at timestamp
    // ======================================================================

    /// Restoring a block with a `deleted_at_ref` that does NOT match the
    /// block's actual `deleted_at` timestamp must restore zero rows.  This
    /// ensures that only blocks sharing the exact cascade timestamp are
    /// restored — independently deleted descendants are preserved.
    #[tokio::test]
    async fn restore_block_with_wrong_deleted_at_ref() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;

        // Cascade-delete parent + child with a shared timestamp.
        let (real_ts, count) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        assert_eq!(count, 2, "precondition: both blocks deleted");

        // Try to restore with a WRONG timestamp.
        let wrong_ts = "1999-01-01T00:00:00+00:00";
        assert_ne!(real_ts, wrong_ts, "precondition: timestamps differ");

        let restored = restore_block(&pool, PARENT, wrong_ts).await.unwrap();
        assert_eq!(
            restored, 0,
            "mismatched deleted_at_ref must restore zero rows"
        );

        // Both blocks should still be deleted with the original timestamp.
        assert_eq!(
            get_deleted_at(&pool, PARENT).await,
            Some(real_ts.clone()),
            "parent must remain deleted"
        );
        assert_eq!(
            get_deleted_at(&pool, CHILD).await,
            Some(real_ts),
            "child must remain deleted"
        );
    }

    // ======================================================================
    // cascade_soft_delete: double-delete idempotency
    // ======================================================================

    /// Calling `cascade_soft_delete` twice on the same block must not error.
    /// The second call should be a no-op (zero rows affected) because the
    /// block and all its descendants are already deleted and the CTE skips
    /// rows where `deleted_at IS NOT NULL`.
    #[tokio::test]
    async fn double_cascade_soft_delete_is_idempotent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_block(
            &pool,
            GRANDCHILD,
            "content",
            "grandchild",
            Some(CHILD),
            Some(1),
        )
        .await;

        // First cascade: deletes all 3
        let (ts1, count1) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        assert_eq!(
            count1, 3,
            "first cascade must delete parent + child + grandchild"
        );

        // Second cascade: must succeed with 0 rows affected
        let (_ts2, count2) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        assert_eq!(
            count2, 0,
            "second cascade must be a no-op (0 rows affected)"
        );

        // Original timestamps must be preserved (not overwritten)
        assert_eq!(
            get_deleted_at(&pool, PARENT).await,
            Some(ts1.clone()),
            "parent's deleted_at must retain original timestamp"
        );
        assert_eq!(
            get_deleted_at(&pool, CHILD).await,
            Some(ts1.clone()),
            "child's deleted_at must retain original timestamp"
        );
        assert_eq!(
            get_deleted_at(&pool, GRANDCHILD).await,
            Some(ts1),
            "grandchild's deleted_at must retain original timestamp"
        );
    }

    // ======================================================================
    // concurrent deletes stress test (#38)
    // ======================================================================

    /// Spawn 5 concurrent `cascade_soft_delete` calls on different children
    /// of the same parent.  All must complete without panic or deadlock.
    /// SQLite's busy_timeout(5000) + IMMEDIATE transactions ensure
    /// serialisation under contention; the test verifies correctness.
    #[tokio::test]
    async fn concurrent_deletes_dont_panic() {
        let (pool, _dir) = test_pool().await;

        // Create a parent with 5 children
        insert_block(&pool, "CPAR01", "page", "concurrent parent", None, Some(1)).await;
        for i in 1..=5_i64 {
            let id = format!("CCHD{i:02}");
            insert_block(
                &pool,
                &id,
                "content",
                &format!("child {i}"),
                Some("CPAR01"),
                Some(i),
            )
            .await;
        }

        // Spawn 5 concurrent cascade_soft_delete calls, each targeting a
        // different child. The parent is not deleted, only the children.
        let mut handles = Vec::new();
        for i in 1..=5_i64 {
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                let id = format!("CCHD{i:02}");
                cascade_soft_delete(&pool, &id).await
            }));
        }

        // All must complete without panic
        for handle in handles {
            let result = handle.await.expect("task must not panic");
            let (_ts, count) = result.expect("cascade_soft_delete must not error");
            // Each child is a leaf, so count is 1
            assert_eq!(count, 1, "each child deletion must affect exactly 1 row");
        }

        // Verify all children are deleted
        for i in 1..=5_i64 {
            let id = format!("CCHD{i:02}");
            assert!(
                get_deleted_at(&pool, &id).await.is_some(),
                "child {id} must be deleted"
            );
        }

        // Parent must still be alive
        assert_eq!(
            get_deleted_at(&pool, "CPAR01").await,
            None,
            "parent must not be affected by child deletions"
        );
    }
}
