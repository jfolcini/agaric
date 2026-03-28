//! Soft-delete with cascade, restore, and purge operations.
//!
//! - **cascade soft-delete**: sets `deleted_at` on a block and ALL descendants
//!   via recursive CTE, using a single shared timestamp.
//! - **restore**: clears `deleted_at` on a block and descendants that share the
//!   same `deleted_at` timestamp (preserving independent deletes).
//! - **purge**: physically removes a block, its descendants, and all dependent
//!   rows from every FK-referencing table.  Irreversible.

use chrono::Utc;
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
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(deleted_at,)| deleted_at.is_some()))
}

/// Return the IDs of a block and all its descendants via recursive CTE.
///
/// Includes already-deleted descendants (unlike cascade which skips them).
/// Returns an empty `Vec` if the block does not exist.
pub async fn get_descendants(pool: &SqlitePool, block_id: &str) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         SELECT id FROM descendants",
    )
    .bind(block_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
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
    let now = Utc::now().to_rfc3339();
    let result =
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
            .bind(&now)
            .bind(block_id)
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
pub async fn cascade_soft_delete(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(String, u64), AppError> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;

    let result = sqlx::query(
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
    )
    .bind(block_id)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    let count = result.rows_affected();
    tx.commit().await?;
    Ok((now, count))
}

/// Restore a soft-deleted block and descendants sharing the same `deleted_at`
/// timestamp.
///
/// Descendants that were independently deleted (different timestamp) remain
/// deleted because the CTE only traverses through blocks matching
/// `deleted_at_ref`.
///
/// Returns the number of rows restored.
pub async fn restore_block(
    pool: &SqlitePool,
    block_id: &str,
    deleted_at_ref: &str,
) -> Result<u64, AppError> {
    let mut tx = pool.begin().await?;

    let result = sqlx::query(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at = ? \
         ) \
         UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at = ?",
    )
    .bind(block_id)
    .bind(deleted_at_ref)
    .bind(deleted_at_ref)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(result.rows_affected())
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
    let mut tx = pool.begin().await?;

    // Defer FK checks until commit — the entire subtree will be gone by then
    // so no constraints will be violated.  The pragma resets automatically at
    // COMMIT/ROLLBACK.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut *tx)
        .await?;

    // The recursive CTE reused in every batch operation below.
    // Each query re-evaluates it, but SQLite's engine is efficient for
    // in-memory trees.  This avoids temp-table management overhead and
    // keeps each statement self-contained.
    const DESC_CTE: &str = "WITH RECURSIVE descendants(id) AS ( \
        SELECT id FROM blocks WHERE id = ? \
        UNION ALL \
        SELECT b.id FROM blocks b \
        INNER JOIN descendants d ON b.parent_id = d.id \
    )";

    // --- Batch-clean dependent tables (one query each) ---

    // block_tags: either column may reference a descendant
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM block_tags \
         WHERE block_id IN (SELECT id FROM descendants) \
            OR tag_id IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // block_properties: owned by descendants
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM block_properties \
         WHERE block_id IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // block_properties: value_ref pointing into the subtree (NULLify, don't
    // delete — the row belongs to a block outside the subtree)
    sqlx::query(&format!(
        "{DESC_CTE} UPDATE block_properties SET value_ref = NULL \
         WHERE value_ref IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // block_links: either end may be in the subtree
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM block_links \
         WHERE source_id IN (SELECT id FROM descendants) \
            OR target_id IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // agenda_cache
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM agenda_cache \
         WHERE block_id IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // tags_cache
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM tags_cache \
         WHERE tag_id IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // pages_cache
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM pages_cache \
         WHERE page_id IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // attachments
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM attachments \
         WHERE block_id IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // block_drafts
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM block_drafts \
         WHERE block_id IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // Nullify conflict_source refs from blocks outside the subtree.
    sqlx::query(&format!(
        "{DESC_CTE} UPDATE blocks SET conflict_source = NULL \
         WHERE conflict_source IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    // --- Delete blocks (deferred FK allows single-statement batch) ---
    let result = sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM blocks \
         WHERE id IN (SELECT id FROM descendants)"
    ))
    .bind(block_id)
    .execute(&mut *tx)
    .await?;

    let count = result.rows_affected();
    tx.commit().await?;
    Ok(count)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

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
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .bind(position)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Read `deleted_at` for a block. Returns None if block does not exist.
    async fn get_deleted_at(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_as::<_, (Option<String>,)>("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await
            .unwrap()
            .and_then(|r| r.0)
    }

    /// Check if a block row exists in the `blocks` table.
    async fn block_exists(pool: &SqlitePool, id: &str) -> bool {
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();
        count.0 > 0
    }

    // ======================================================================
    // soft_delete_block (single, no cascade)
    // ======================================================================

    #[tokio::test]
    async fn soft_delete_single() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK001", "content", "hello", None, None).await;

        let ts = soft_delete_block(&pool, "BLK001").await.unwrap().unwrap();

        let deleted_at = get_deleted_at(&pool, "BLK001").await;
        assert_eq!(deleted_at, Some(ts));
    }

    #[tokio::test]
    async fn soft_delete_already_deleted() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK001", "content", "hello", None, None).await;

        let ts1 = soft_delete_block(&pool, "BLK001").await.unwrap().unwrap();
        // Second call is a no-op — returns None.
        let ts2 = soft_delete_block(&pool, "BLK001").await.unwrap();
        assert_eq!(ts2, None);

        // Original timestamp is preserved.
        let deleted_at = get_deleted_at(&pool, "BLK001").await;
        assert_eq!(deleted_at, Some(ts1));
    }

    #[tokio::test]
    async fn soft_delete_nonexistent_returns_none() {
        let (pool, _dir) = test_pool().await;

        let result = soft_delete_block(&pool, "NOPE").await.unwrap();
        assert_eq!(result, None);
    }

    #[tokio::test]
    async fn soft_delete_yields_different_timestamps() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK001", "content", "a", None, None).await;
        insert_block(&pool, "BLK002", "content", "b", None, None).await;

        let ts1 = soft_delete_block(&pool, "BLK001").await.unwrap().unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let ts2 = soft_delete_block(&pool, "BLK002").await.unwrap().unwrap();

        assert_ne!(
            ts1, ts2,
            "consecutive soft-deletes should have different timestamps"
        );
    }

    // ======================================================================
    // cascade_soft_delete
    // ======================================================================

    #[tokio::test]
    async fn cascade_delete_subtree() {
        let (pool, _dir) = test_pool().await;
        // parent -> child -> grandchild
        insert_block(&pool, "PAR001", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CHD001", "content", "child", Some("PAR001"), Some(1)).await;
        insert_block(
            &pool,
            "GCH001",
            "content",
            "grandchild",
            Some("CHD001"),
            Some(1),
        )
        .await;

        let (ts, count) = cascade_soft_delete(&pool, "PAR001").await.unwrap();

        assert_eq!(count, 3);
        // All three share the same timestamp.
        assert_eq!(get_deleted_at(&pool, "PAR001").await, Some(ts.clone()));
        assert_eq!(get_deleted_at(&pool, "CHD001").await, Some(ts.clone()));
        assert_eq!(get_deleted_at(&pool, "GCH001").await, Some(ts));
    }

    #[tokio::test]
    async fn cascade_skips_already_deleted() {
        let (pool, _dir) = test_pool().await;
        // parent -> child -> grandchild
        insert_block(&pool, "PAR001", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CHD001", "content", "child", Some("PAR001"), Some(1)).await;
        insert_block(
            &pool,
            "GCH001",
            "content",
            "grandchild",
            Some("CHD001"),
            Some(1),
        )
        .await;

        // Independently delete the child first.
        let t1 = soft_delete_block(&pool, "CHD001").await.unwrap().unwrap();

        // Cascade-delete parent: CTE does NOT traverse through the
        // already-deleted child, so grandchild is NOT reached.
        let (t2, count) = cascade_soft_delete(&pool, "PAR001").await.unwrap();
        assert_ne!(t1, t2);
        assert_eq!(count, 1); // only the parent

        assert_eq!(get_deleted_at(&pool, "PAR001").await, Some(t2));
        // Child keeps its original timestamp.
        assert_eq!(get_deleted_at(&pool, "CHD001").await, Some(t1));
        // Grandchild was not reached — still alive.
        assert_eq!(get_deleted_at(&pool, "GCH001").await, None);
    }

    #[tokio::test]
    async fn cascade_deep_tree() {
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
        assert_eq!(count, 11); // L00 through L10

        for i in 0..=10 {
            let id = format!("L{i:02}");
            assert_eq!(get_deleted_at(&pool, &id).await, Some(ts.clone()));
        }
    }

    #[tokio::test]
    async fn cascade_wide_tree() {
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
        assert_eq!(count, 101); // root + 100 children

        assert_eq!(get_deleted_at(&pool, "WROOT").await, Some(ts.clone()));
        for i in 0..100 {
            let id = format!("WC{i:03}");
            assert_eq!(get_deleted_at(&pool, &id).await, Some(ts.clone()));
        }
    }

    #[tokio::test]
    async fn cascade_preserves_outside_subtree() {
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

        // Tree B should be completely unaffected.
        assert_eq!(get_deleted_at(&pool, "TREE_B").await, None);
        assert_eq!(get_deleted_at(&pool, "TREE_B_C").await, None);
    }

    // ======================================================================
    // restore_block
    // ======================================================================

    #[tokio::test]
    async fn restore_block_and_descendants() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "PAR001", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CHD001", "content", "child", Some("PAR001"), Some(1)).await;
        insert_block(
            &pool,
            "GCH001",
            "content",
            "grandchild",
            Some("CHD001"),
            Some(1),
        )
        .await;

        let (ts, _) = cascade_soft_delete(&pool, "PAR001").await.unwrap();
        let restored = restore_block(&pool, "PAR001", &ts).await.unwrap();

        assert_eq!(restored, 3);
        assert_eq!(get_deleted_at(&pool, "PAR001").await, None);
        assert_eq!(get_deleted_at(&pool, "CHD001").await, None);
        assert_eq!(get_deleted_at(&pool, "GCH001").await, None);
    }

    #[tokio::test]
    async fn restore_preserves_independently_deleted() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "PAR001", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CHD001", "content", "child", Some("PAR001"), Some(1)).await;
        insert_block(
            &pool,
            "GCH001",
            "content",
            "grandchild",
            Some("CHD001"),
            Some(1),
        )
        .await;

        // Independently delete grandchild with a known timestamp.
        let t_indep = "2025-01-01T00:00:00+00:00";
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(t_indep)
            .bind("GCH001")
            .execute(&pool)
            .await
            .unwrap();

        // Cascade-delete parent (child gets t2, grandchild already has t_indep).
        let (t2, _) = cascade_soft_delete(&pool, "PAR001").await.unwrap();

        // Restore using the cascade timestamp.
        let restored = restore_block(&pool, "PAR001", &t2).await.unwrap();
        assert_eq!(restored, 2); // parent + child

        assert_eq!(get_deleted_at(&pool, "PAR001").await, None);
        assert_eq!(get_deleted_at(&pool, "CHD001").await, None);
        // Grandchild retains its independent deletion.
        assert_eq!(
            get_deleted_at(&pool, "GCH001").await,
            Some(t_indep.to_string())
        );
    }

    #[tokio::test]
    async fn restore_non_deleted_returns_zero() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK001", "content", "alive", None, None).await;

        // Attempt to restore a block that is not deleted.
        let restored = restore_block(&pool, "BLK001", "2025-01-01T00:00:00+00:00")
            .await
            .unwrap();
        assert_eq!(restored, 0);
    }

    // ======================================================================
    // purge_block
    // ======================================================================

    #[tokio::test]
    async fn purge_removes_all() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "PAR001", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CHD001", "content", "child", Some("PAR001"), Some(1)).await;
        insert_block(
            &pool,
            "GCH001",
            "content",
            "grandchild",
            Some("CHD001"),
            Some(1),
        )
        .await;

        let count = purge_block(&pool, "PAR001").await.unwrap();
        assert_eq!(count, 3);

        assert!(!block_exists(&pool, "PAR001").await);
        assert!(!block_exists(&pool, "CHD001").await);
        assert!(!block_exists(&pool, "GCH001").await);
    }

    #[tokio::test]
    async fn purge_cleans_dependent_tables() {
        let (pool, _dir) = test_pool().await;

        // Block to purge and a block that remains.
        insert_block(&pool, "BLK001", "content", "to purge", None, None).await;
        insert_block(&pool, "TAG001", "tag", "my-tag", None, None).await;
        insert_block(&pool, "TARGET", "content", "link target", None, None).await;

        // block_tags
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind("BLK001")
            .bind("TAG001")
            .execute(&pool)
            .await
            .unwrap();

        // block_properties
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind("BLK001")
            .bind("status")
            .bind("done")
            .execute(&pool)
            .await
            .unwrap();

        // block_links
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("BLK001")
            .bind("TARGET")
            .execute(&pool)
            .await
            .unwrap();

        // Purge
        let count = purge_block(&pool, "BLK001").await.unwrap();
        assert_eq!(count, 1);

        // Verify dependent rows are gone.
        let tags: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ?")
            .bind("BLK001")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tags.0, 0);

        let props: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_properties WHERE block_id = ?")
                .bind("BLK001")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(props.0, 0);

        let links: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
            .bind("BLK001")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(links.0, 0);

        // TAG001 and TARGET should still exist.
        assert!(block_exists(&pool, "TAG001").await);
        assert!(block_exists(&pool, "TARGET").await);
    }

    #[tokio::test]
    async fn purge_cleans_tag_id_in_block_tags() {
        let (pool, _dir) = test_pool().await;

        // A content block tagged with TAG001.  We purge the TAG, not the
        // content block — the block_tags row must be cleaned via the tag_id
        // column.
        insert_block(&pool, "CONTENT", "content", "my note", None, None).await;
        insert_block(&pool, "TAG001", "tag", "important", None, None).await;

        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind("CONTENT")
            .bind("TAG001")
            .execute(&pool)
            .await
            .unwrap();

        purge_block(&pool, "TAG001").await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE tag_id = ?")
            .bind("TAG001")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0, "block_tags row should be cleaned via tag_id");

        // The content block itself should still exist.
        assert!(block_exists(&pool, "CONTENT").await);
    }

    #[tokio::test]
    async fn purge_cleans_value_ref_in_properties() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "REFTGT", "content", "ref target", None, None).await;
        insert_block(&pool, "OWNER", "content", "owner", None, None).await;

        sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, ?, ?)")
            .bind("OWNER")
            .bind("link")
            .bind("REFTGT")
            .execute(&pool)
            .await
            .unwrap();

        purge_block(&pool, "REFTGT").await.unwrap();

        // The property row still belongs to OWNER, but value_ref must be NULL.
        let value_ref: (Option<String>,) =
            sqlx::query_as("SELECT value_ref FROM block_properties WHERE block_id = ? AND key = ?")
                .bind("OWNER")
                .bind("link")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(value_ref.0, None, "value_ref should be NULLed after purge");
    }

    #[tokio::test]
    async fn purge_cleans_conflict_source() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "ORIGINAL", "content", "original", None, None).await;
        insert_block(&pool, "CONFLICT", "content", "conflict copy", None, None).await;

        // ORIGINAL.conflict_source → CONFLICT
        sqlx::query("UPDATE blocks SET conflict_source = ? WHERE id = ?")
            .bind("CONFLICT")
            .bind("ORIGINAL")
            .execute(&pool)
            .await
            .unwrap();

        purge_block(&pool, "CONFLICT").await.unwrap();

        let cs: (Option<String>,) =
            sqlx::query_as("SELECT conflict_source FROM blocks WHERE id = ?")
                .bind("ORIGINAL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cs.0, None, "conflict_source should be NULLed after purge");
    }

    #[tokio::test]
    async fn purge_nonexistent_returns_zero() {
        let (pool, _dir) = test_pool().await;

        let count = purge_block(&pool, "DOES_NOT_EXIST").await.unwrap();
        assert_eq!(count, 0);
    }

    // ======================================================================
    // Helpers
    // ======================================================================

    #[tokio::test]
    async fn is_deleted_helper() {
        let (pool, _dir) = test_pool().await;

        // Non-existent block → None
        assert_eq!(is_deleted(&pool, "NOPE").await.unwrap(), None);

        // Existing, alive block → Some(false)
        insert_block(&pool, "BLK001", "content", "hi", None, None).await;
        assert_eq!(is_deleted(&pool, "BLK001").await.unwrap(), Some(false));

        // After soft-delete → Some(true)
        soft_delete_block(&pool, "BLK001").await.unwrap();
        assert_eq!(is_deleted(&pool, "BLK001").await.unwrap(), Some(true));
    }

    #[tokio::test]
    async fn get_descendants_returns_subtree() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAR001", "page", "parent", None, Some(1)).await;
        insert_block(&pool, "CHD001", "content", "child", Some("PAR001"), Some(1)).await;
        insert_block(
            &pool,
            "CHD002",
            "content",
            "child2",
            Some("PAR001"),
            Some(2),
        )
        .await;
        insert_block(
            &pool,
            "GCH001",
            "content",
            "grandchild",
            Some("CHD001"),
            Some(1),
        )
        .await;

        let mut ids = get_descendants(&pool, "PAR001").await.unwrap();
        ids.sort();
        assert_eq!(ids, vec!["CHD001", "CHD002", "GCH001", "PAR001"]);
    }

    #[tokio::test]
    async fn get_descendants_nonexistent_is_empty() {
        let (pool, _dir) = test_pool().await;

        let ids = get_descendants(&pool, "NOPE").await.unwrap();
        assert!(ids.is_empty());
    }
}
