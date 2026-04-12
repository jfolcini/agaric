//! Soft-delete with cascade, restore, and purge operations.

mod purge;
mod restore;
mod trash;

pub use purge::purge_block;
pub use restore::restore_block;
pub use trash::{cascade_soft_delete, soft_delete_block};

use sqlx::SqlitePool;

use crate::error::AppError;

/// Check whether a block is currently soft-deleted.
pub async fn is_deleted(pool: &SqlitePool, block_id: &str) -> Result<Option<bool>, AppError> {
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", block_id,)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.deleted_at.is_some()))
}

/// Return the IDs of a block and all its descendants via recursive CTE.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const BLOCK_A: &str = "BLK_A01";
    const BLOCK_B: &str = "BLK_B02";
    const PARENT: &str = "PAR001";
    const CHILD: &str = "CHD001";
    const CHILD2: &str = "CHD002";
    const GRANDCHILD: &str = "GCH001";
    const FIXED_DELETED_AT: &str = "2025-01-01T00:00:00+00:00";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn insert_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
    ) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) VALUES (?, ?, ?, ?, ?)",
            id, block_type, content, parent_id, position,
        ).execute(pool).await.unwrap();
    }

    async fn get_deleted_at(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", id)
            .fetch_optional(pool)
            .await
            .unwrap()
            .and_then(|r| r.deleted_at)
    }

    async fn block_exists(pool: &SqlitePool, id: &str) -> bool {
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM blocks WHERE id = ?", id)
            .fetch_one(pool)
            .await
            .unwrap();
        count > 0
    }

    // ======================================================================
    // soft_delete_block
    // ======================================================================

    #[tokio::test]
    async fn soft_delete_block_marks_single_block_as_deleted() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "hello", None, None).await;
        let ts = soft_delete_block(&pool, BLOCK_A)
            .await
            .unwrap()
            .expect("should return timestamp");
        let deleted_at = get_deleted_at(&pool, BLOCK_A).await;
        assert_eq!(deleted_at, Some(ts));
    }

    #[tokio::test]
    async fn soft_delete_block_already_deleted_returns_none() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "hello", None, None).await;
        let ts1 = soft_delete_block(&pool, BLOCK_A).await.unwrap().unwrap();
        let ts2 = soft_delete_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(ts2, None);
        assert_eq!(get_deleted_at(&pool, BLOCK_A).await, Some(ts1));
    }

    #[tokio::test]
    async fn soft_delete_block_nonexistent_returns_none() {
        let (pool, _dir) = test_pool().await;
        assert_eq!(soft_delete_block(&pool, "NONEXISTENT").await.unwrap(), None);
    }

    #[tokio::test]
    async fn soft_delete_block_independent_calls_produce_ordered_timestamps() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "a", None, None).await;
        insert_block(&pool, BLOCK_B, "content", "b", None, None).await;
        let ts1 = soft_delete_block(&pool, BLOCK_A).await.unwrap().unwrap();
        let ts2 = soft_delete_block(&pool, BLOCK_B).await.unwrap().unwrap();
        assert!(ts1 <= ts2);
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
        assert_eq!(count, 3);
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
        let t1 = soft_delete_block(&pool, CHILD).await.unwrap().unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let (t2, count) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        assert_ne!(t1, t2);
        assert_eq!(count, 1);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(t2));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(t1));
        assert_eq!(get_deleted_at(&pool, GRANDCHILD).await, None);
    }

    #[tokio::test]
    async fn cascade_soft_delete_on_leaf_node_deletes_only_itself() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "LEAF01", "content", "leaf node", None, Some(1)).await;
        let (ts, count) = cascade_soft_delete(&pool, "LEAF01").await.unwrap();
        assert_eq!(count, 1);
        assert_eq!(get_deleted_at(&pool, "LEAF01").await, Some(ts));
    }

    #[tokio::test]
    async fn cascade_soft_delete_on_nonexistent_returns_zero() {
        let (pool, _dir) = test_pool().await;
        let (_ts, count) = cascade_soft_delete(&pool, "NONEXISTENT").await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn cascade_soft_delete_handles_deep_linear_chain() {
        let (pool, _dir) = test_pool().await;
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
        assert_eq!(count, 11);
        for i in 0..=10 {
            let id = format!("L{i:02}");
            assert_eq!(get_deleted_at(&pool, &id).await, Some(ts.clone()));
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
        assert_eq!(count, 101);
        assert_eq!(get_deleted_at(&pool, "WROOT").await, Some(ts.clone()));
        for i in 0..100 {
            let id = format!("WC{i:03}");
            assert_eq!(get_deleted_at(&pool, &id).await, Some(ts.clone()));
        }
    }

    #[tokio::test]
    async fn cascade_soft_delete_leaves_sibling_trees_untouched() {
        let (pool, _dir) = test_pool().await;
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
        cascade_soft_delete(&pool, "TREE_A").await.unwrap();
        assert_eq!(get_deleted_at(&pool, "TREE_B").await, None);
        assert_eq!(get_deleted_at(&pool, "TREE_B_C").await, None);
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
        assert_eq!(restored, 3);
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
        sqlx::query!(
            "UPDATE blocks SET deleted_at = ? WHERE id = ?",
            FIXED_DELETED_AT,
            GRANDCHILD
        )
        .execute(&pool)
        .await
        .unwrap();
        let (t2, _) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        let restored = restore_block(&pool, PARENT, &t2).await.unwrap();
        assert_eq!(restored, 2);
        assert_eq!(get_deleted_at(&pool, PARENT).await, None);
        assert_eq!(get_deleted_at(&pool, CHILD).await, None);
        assert_eq!(
            get_deleted_at(&pool, GRANDCHILD).await,
            Some(FIXED_DELETED_AT.to_string())
        );
    }

    #[tokio::test]
    async fn restore_block_on_non_deleted_returns_zero() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "alive", None, None).await;
        let restored = restore_block(&pool, BLOCK_A, FIXED_DELETED_AT)
            .await
            .unwrap();
        assert_eq!(restored, 0);
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
        assert_eq!(count, 3);
        assert!(!block_exists(&pool, PARENT).await);
        assert!(!block_exists(&pool, CHILD).await);
        assert!(!block_exists(&pool, GRANDCHILD).await);
    }

    #[tokio::test]
    async fn purge_block_cleans_dependent_tables() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "to purge", None, None).await;
        insert_block(&pool, "TAG001", "tag", "my-tag", None, None).await;
        insert_block(&pool, "TARGET", "content", "link target", None, None).await;
        sqlx::query!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            BLOCK_A,
            "TAG001"
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)",
            BLOCK_A,
            "status",
            "done"
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query!(
            "INSERT INTO block_links (source_id, target_id) VALUES (?, ?)",
            BLOCK_A,
            "TARGET"
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
        assert_eq!(tags, 0);
        let props: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_properties WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(props, 0);
        let links: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_links WHERE source_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(links, 0);
        assert!(block_exists(&pool, "TAG001").await);
        assert!(block_exists(&pool, "TARGET").await);
    }

    #[tokio::test]
    async fn purge_block_cleans_tag_id_in_block_tags() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "CONTENT", "content", "my note", None, None).await;
        insert_block(&pool, "TAG001", "tag", "important", None, None).await;
        sqlx::query!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            "CONTENT",
            "TAG001"
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
        assert_eq!(count, 0);
        assert!(block_exists(&pool, "CONTENT").await);
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
            "REFTGT"
        )
        .execute(&pool)
        .await
        .unwrap();
        purge_block(&pool, "REFTGT").await.unwrap();
        let row = sqlx::query!(
            "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = ?",
            "OWNER",
            "link"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.value_ref, None);
    }

    #[tokio::test]
    async fn purge_block_nullifies_conflict_source() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "ORIGINAL", "content", "original", None, None).await;
        insert_block(&pool, "CONFLICT", "content", "conflict copy", None, None).await;
        sqlx::query!(
            "UPDATE blocks SET conflict_source = ? WHERE id = ?",
            "CONFLICT",
            "ORIGINAL"
        )
        .execute(&pool)
        .await
        .unwrap();
        purge_block(&pool, "CONFLICT").await.unwrap();
        let row = sqlx::query!(
            "SELECT conflict_source FROM blocks WHERE id = ?",
            "ORIGINAL"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.conflict_source, None);
    }

    #[tokio::test]
    async fn purge_block_nonexistent_returns_zero() {
        let (pool, _dir) = test_pool().await;
        let count = purge_block(&pool, "DOES_NOT_EXIST").await.unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn purge_block_cleans_agenda_cache() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "task with date", None, None).await;
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
            BLOCK_A,
            "due",
            "2025-06-01"
        )
        .execute(&pool)
        .await
        .unwrap();
        crate::cache::rebuild_agenda_cache(&pool).await.unwrap();
        let before: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM agenda_cache WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(before > 0);
        purge_block(&pool, BLOCK_A).await.unwrap();
        let after: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM agenda_cache WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0);
    }

    #[tokio::test]
    async fn purge_block_cleans_tags_cache() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "PTAG01", "tag", "purge-me-tag", None, None).await;
        crate::cache::rebuild_tags_cache(&pool).await.unwrap();
        let before: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM tags_cache WHERE tag_id = ?", "PTAG01")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(before > 0);
        purge_block(&pool, "PTAG01").await.unwrap();
        let after: i64 =
            sqlx::query_scalar!("SELECT COUNT(*) FROM tags_cache WHERE tag_id = ?", "PTAG01")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(after, 0);
    }

    #[tokio::test]
    async fn purge_block_cleans_pages_cache() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "PPAGE1", "page", "Purge Page", None, None).await;
        crate::cache::rebuild_pages_cache(&pool).await.unwrap();
        let before: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM pages_cache WHERE page_id = ?",
            "PPAGE1"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(before > 0);
        purge_block(&pool, "PPAGE1").await.unwrap();
        let after: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM pages_cache WHERE page_id = ?",
            "PPAGE1"
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0);
    }

    #[tokio::test]
    async fn purge_block_cleans_attachments() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "has attachment", None, None).await;
        sqlx::query!("INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "ATT001", BLOCK_A, "image/png", "photo.png", 1024_i64, "attachments/photo.png", "2025-01-01T00:00:00Z").execute(&pool).await.unwrap();
        purge_block(&pool, BLOCK_A).await.unwrap();
        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM attachments WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn purge_block_deletes_attachment_files_on_disk() {
        let (pool, _dir) = test_pool().await;
        let test_dir = "_test_att_disk_purge";
        std::fs::create_dir_all(test_dir).unwrap();
        let file1_rel = format!("{}/att_file1.png", test_dir);
        let file2_rel = format!("{}/att_file2.jpg", test_dir);
        std::fs::write(&file1_rel, b"fake png data").unwrap();
        std::fs::write(&file2_rel, b"fake jpg data").unwrap();
        struct Cleanup(&'static str);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(self.0);
            }
        }
        let _cleanup = Cleanup(test_dir);
        assert!(std::path::Path::new(&file1_rel).exists());
        assert!(std::path::Path::new(&file2_rel).exists());
        insert_block(&pool, BLOCK_A, "content", "has attachments", None, None).await;
        for (att_id, path) in [
            ("ATT_F1", file1_rel.as_str()),
            ("ATT_F2", file2_rel.as_str()),
        ] {
            sqlx::query!("INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", att_id, BLOCK_A, "image/png", "photo.png", 1024_i64, path, "2025-01-01T00:00:00Z").execute(&pool).await.unwrap();
        }
        purge_block(&pool, BLOCK_A).await.unwrap();
        assert!(!std::path::Path::new(&file1_rel).exists());
        assert!(!std::path::Path::new(&file2_rel).exists());
    }

    #[tokio::test]
    async fn purge_block_without_attachments_succeeds() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "no attachments here", None, None).await;
        let count = purge_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(count, 1);
        assert!(!block_exists(&pool, BLOCK_A).await);
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
        sqlx::query!("INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "ATT_GONE", BLOCK_A, "application/pdf", "report.pdf", 2048_i64, "attachments/nonexistent_report.pdf", "2025-01-01T00:00:00Z").execute(&pool).await.unwrap();
        let count = purge_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(count, 1);
        let att_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM attachments WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(att_count, 0);
    }

    #[tokio::test]
    async fn purge_block_skips_unsafe_attachment_path() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "unsafe attachment", None, None).await;
        sqlx::query!("INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", "ATT_UNSAFE", BLOCK_A, "image/png", "photo.png", 1024_i64, "/etc/important_file", "2025-01-01T00:00:00Z").execute(&pool).await.unwrap();
        let count = purge_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(count, 1);
        let att_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM attachments WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(att_count, 0);
    }

    #[tokio::test]
    async fn purge_block_cleans_block_drafts() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, BLOCK_A, "content", "has draft", None, None).await;
        sqlx::query!(
            "INSERT INTO block_drafts (block_id, content, updated_at) VALUES (?, ?, ?)",
            BLOCK_A,
            "draft content",
            "2025-01-01T00:00:00Z"
        )
        .execute(&pool)
        .await
        .unwrap();
        purge_block(&pool, BLOCK_A).await.unwrap();
        let count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM block_drafts WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 0);
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
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(before > 0);
        purge_block(&pool, BLOCK_A).await.unwrap();
        let after: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) FROM fts_blocks WHERE block_id = ?",
            BLOCK_A
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, 0);
    }

    // ======================================================================
    // Helper functions: is_deleted, get_descendants
    // ======================================================================

    #[tokio::test]
    async fn is_deleted_returns_correct_state_for_each_lifecycle_stage() {
        let (pool, _dir) = test_pool().await;
        assert_eq!(is_deleted(&pool, "NOPE").await.unwrap(), None);
        insert_block(&pool, BLOCK_A, "content", "hi", None, None).await;
        assert_eq!(is_deleted(&pool, BLOCK_A).await.unwrap(), Some(false));
        soft_delete_block(&pool, BLOCK_A).await.unwrap();
        assert_eq!(is_deleted(&pool, BLOCK_A).await.unwrap(), Some(true));
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
        assert_eq!(ids, vec![CHILD, CHILD2, GRANDCHILD, PARENT]);
    }

    #[tokio::test]
    async fn get_descendants_nonexistent_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let ids = get_descendants(&pool, "NOPE").await.unwrap();
        assert!(ids.is_empty());
    }

    #[tokio::test]
    async fn restore_block_with_wrong_deleted_at_ref() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        let (real_ts, count) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        assert_eq!(count, 2);
        let wrong_ts = "1999-01-01T00:00:00+00:00";
        let restored = restore_block(&pool, PARENT, wrong_ts).await.unwrap();
        assert_eq!(restored, 0);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(real_ts.clone()));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(real_ts));
    }

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
        let (ts1, count1) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        assert_eq!(count1, 3);
        let (_ts2, count2) = cascade_soft_delete(&pool, PARENT).await.unwrap();
        assert_eq!(count2, 0);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(ts1.clone()));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(ts1.clone()));
        assert_eq!(get_deleted_at(&pool, GRANDCHILD).await, Some(ts1));
    }

    #[tokio::test]
    async fn concurrent_deletes_dont_panic() {
        let (pool, _dir) = test_pool().await;
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
        let mut handles = Vec::new();
        for i in 1..=5_i64 {
            let pool = pool.clone();
            handles.push(tokio::spawn(async move {
                let id = format!("CCHD{i:02}");
                cascade_soft_delete(&pool, &id).await
            }));
        }
        for handle in handles {
            let result = handle.await.expect("task must not panic");
            let (_ts, count) = result.expect("cascade_soft_delete must not error");
            assert_eq!(count, 1);
        }
        for i in 1..=5_i64 {
            let id = format!("CCHD{i:02}");
            assert!(get_deleted_at(&pool, &id).await.is_some());
        }
        assert_eq!(get_deleted_at(&pool, "CPAR01").await, None);
    }
}
