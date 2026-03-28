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
// Public API
// ---------------------------------------------------------------------------

/// Soft-delete a single block (no cascade).
///
/// No-op if the block is already deleted.
/// Returns the ISO-8601 timestamp used.
pub async fn soft_delete_block(pool: &SqlitePool, block_id: &str) -> Result<String, AppError> {
    let now = Utc::now().to_rfc3339();
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(&now)
        .bind(block_id)
        .execute(pool)
        .await?;
    Ok(now)
}

/// Cascade soft-delete: sets `deleted_at` on the block and all non-deleted
/// descendants via recursive CTE.
///
/// Descendants that are already soft-deleted (different timestamp) are left
/// untouched, and the CTE will **not** traverse through them.
///
/// Returns the shared timestamp used for all newly-deleted rows.
pub async fn cascade_soft_delete(pool: &SqlitePool, block_id: &str) -> Result<String, AppError> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;

    sqlx::query(
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

    tx.commit().await?;
    Ok(now)
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
/// Cleans every FK-referencing table before removing `blocks` rows
/// (children-first ordering to honour the self-referential FK).
///
/// **WARNING**: Irreversible.  Only for explicit user action or 30-day trash
/// cleanup.
pub async fn purge_block(pool: &SqlitePool, block_id: &str) -> Result<u64, AppError> {
    let mut tx = pool.begin().await?;

    // Collect ALL descendants (including already-deleted ones).
    let descendant_ids: Vec<(String,)> = sqlx::query_as(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         SELECT id FROM descendants",
    )
    .bind(block_id)
    .fetch_all(&mut *tx)
    .await?;

    // Clean dependent tables for each descendant.
    for (id,) in &descendant_ids {
        sqlx::query("DELETE FROM block_tags WHERE block_id = ? OR tag_id = ?")
            .bind(id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM block_properties WHERE block_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE block_properties SET value_ref = NULL WHERE value_ref = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM block_links WHERE source_id = ? OR target_id = ?")
            .bind(id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM agenda_cache WHERE block_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM tags_cache WHERE tag_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM pages_cache WHERE page_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM attachments WHERE block_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM block_drafts WHERE block_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        // Nullify conflict_source refs from blocks outside the subtree.
        sqlx::query("UPDATE blocks SET conflict_source = NULL WHERE conflict_source = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    // Delete blocks in reverse CTE order (leaves first) to respect the
    // self-referential `parent_id` foreign key.
    for (id,) in descendant_ids.iter().rev() {
        sqlx::query("DELETE FROM blocks WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    let count = descendant_ids.len() as u64;
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

        let ts = soft_delete_block(&pool, "BLK001").await.unwrap();

        let deleted_at = get_deleted_at(&pool, "BLK001").await;
        assert_eq!(deleted_at, Some(ts));
    }

    #[tokio::test]
    async fn soft_delete_already_deleted() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK001", "content", "hello", None, None).await;

        let ts1 = soft_delete_block(&pool, "BLK001").await.unwrap();
        // Second call is a no-op -- original timestamp is preserved.
        let _ts2 = soft_delete_block(&pool, "BLK001").await.unwrap();

        let deleted_at = get_deleted_at(&pool, "BLK001").await;
        assert_eq!(deleted_at, Some(ts1));
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

        let ts = cascade_soft_delete(&pool, "PAR001").await.unwrap();

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
        let t1 = soft_delete_block(&pool, "CHD001").await.unwrap();

        // Cascade-delete parent: CTE does NOT traverse through the
        // already-deleted child, so grandchild is NOT reached.
        let t2 = cascade_soft_delete(&pool, "PAR001").await.unwrap();
        assert_ne!(t1, t2);

        assert_eq!(get_deleted_at(&pool, "PAR001").await, Some(t2));
        // Child keeps its original timestamp.
        assert_eq!(get_deleted_at(&pool, "CHD001").await, Some(t1));
        // Grandchild was not reached -- still alive.
        assert_eq!(get_deleted_at(&pool, "GCH001").await, None);
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

        let ts = cascade_soft_delete(&pool, "PAR001").await.unwrap();
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
        let t2 = cascade_soft_delete(&pool, "PAR001").await.unwrap();

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
}
