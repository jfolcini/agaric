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
///
/// **Note:** This function exists primarily for benchmarks and test setup.
/// Production code uses the corresponding command in `commands.rs`, which
/// also appends an op-log entry and dispatches materializer tasks.
pub async fn cascade_soft_delete(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(String, u64), AppError> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

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

    let result = sqlx::query(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT id FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
         ) \
         UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at = ?",
    )
    .bind(block_id)
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
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

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

    // fts_blocks (FTS5 virtual table — no FK, must be cleaned explicitly)
    sqlx::query(&format!(
        "{DESC_CTE} DELETE FROM fts_blocks \
         WHERE block_id IN (SELECT id FROM descendants)"
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

        // Cascade-delete parent: CTE does NOT traverse through the
        // already-deleted child, so grandchild is NOT reached.
        let (t2, count) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        assert_ne!(t1, t2);
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
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(FIXED_DELETED_AT)
            .bind(GRANDCHILD)
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
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(BLOCK_A)
            .bind("TAG001")
            .execute(&pool)
            .await
            .unwrap();

        // block_properties
        sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
            .bind(BLOCK_A)
            .bind("status")
            .bind("done")
            .execute(&pool)
            .await
            .unwrap();

        // block_links
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(BLOCK_A)
            .bind("TARGET")
            .execute(&pool)
            .await
            .unwrap();

        let count = purge_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(count, 1);

        let tags: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_tags WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tags.0, 0, "block_tags rows should be purged");

        let props: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM block_properties WHERE block_id = ?")
                .bind(BLOCK_A)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(props.0, 0, "block_properties rows should be purged");

        let links: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_links WHERE source_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(links.0, 0, "block_links rows should be purged");

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

        sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, ?, ?)")
            .bind("OWNER")
            .bind("link")
            .bind("REFTGT")
            .execute(&pool)
            .await
            .unwrap();

        purge_block(&pool, "REFTGT").await.unwrap();

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
    async fn purge_block_nullifies_conflict_source() {
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
        sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)")
            .bind(BLOCK_A)
            .bind("due")
            .bind("2025-06-01")
            .execute(&pool)
            .await
            .unwrap();
        crate::cache::rebuild_agenda_cache(&pool).await.unwrap();

        let before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agenda_cache WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            before.0 > 0,
            "agenda_cache should have an entry before purge"
        );

        purge_block(&pool, BLOCK_A).await.unwrap();

        let after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM agenda_cache WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after.0, 0, "agenda_cache rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_cleans_tags_cache() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PTAG01", "tag", "purge-me-tag", None, None).await;
        crate::cache::rebuild_tags_cache(&pool).await.unwrap();

        let before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tags_cache WHERE tag_id = ?")
            .bind("PTAG01")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(before.0 > 0, "tags_cache should have an entry before purge");

        purge_block(&pool, "PTAG01").await.unwrap();

        let after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM tags_cache WHERE tag_id = ?")
            .bind("PTAG01")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after.0, 0, "tags_cache rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_cleans_pages_cache() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PPAGE1", "page", "Purge Page", None, None).await;
        crate::cache::rebuild_pages_cache(&pool).await.unwrap();

        let before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pages_cache WHERE page_id = ?")
            .bind("PPAGE1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            before.0 > 0,
            "pages_cache should have an entry before purge"
        );

        purge_block(&pool, "PPAGE1").await.unwrap();

        let after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM pages_cache WHERE page_id = ?")
            .bind("PPAGE1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after.0, 0, "pages_cache rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_cleans_attachments() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "has attachment", None, None).await;
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("ATT001")
        .bind(BLOCK_A)
        .bind("image/png")
        .bind("photo.png")
        .bind(1024_i64)
        .bind("/tmp/photo.png")
        .bind("2025-01-01T00:00:00Z")
        .execute(&pool)
        .await
        .unwrap();

        purge_block(&pool, BLOCK_A).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM attachments WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0, "attachments rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_cleans_block_drafts() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "has draft", None, None).await;
        sqlx::query("INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)")
            .bind(BLOCK_A)
            .bind("draft content")
            .bind("2025-01-01T00:00:00Z")
            .execute(&pool)
            .await
            .unwrap();

        purge_block(&pool, BLOCK_A).await.unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM block_drafts WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0, "block_drafts rows should be purged");
    }

    #[tokio::test]
    async fn purge_block_cleans_fts_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, BLOCK_A, "content", "searchable text", None, None).await;
        crate::fts::update_fts_for_block(&pool, BLOCK_A)
            .await
            .unwrap();

        let before: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(before.0 > 0, "fts_blocks should have an entry before purge");

        purge_block(&pool, BLOCK_A).await.unwrap();

        let after: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?")
            .bind(BLOCK_A)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(after.0, 0, "fts_blocks rows should be purged");
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
}
