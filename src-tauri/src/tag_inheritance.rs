//! Incremental maintenance of the `block_tag_inherited` cache table (P-4).
//!
//! The table stores inherited tag relationships: when a block has a tag in
//! `block_tags`, all its non-deleted descendants inherit that tag. This module
//! provides helpers for incremental updates (called from command handlers and
//! `apply_op`) and a full rebuild (background safety net).

use sqlx::{SqliteConnection, SqlitePool};

use crate::error::AppError;

/// After adding a tag to a block, propagate it to all descendants.
///
/// Inserts `(descendant, tag_id, block_id)` for every non-deleted, non-conflict
/// descendant of `block_id`. Uses `INSERT OR IGNORE` to handle races and
/// re-application safely (a descendant might already inherit the same tag from
/// a closer ancestor — the PK constraint keeps the existing row).
pub async fn propagate_tag_to_descendants(
    conn: &mut SqliteConnection,
    block_id: &str,
    tag_id: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "WITH RECURSIVE descendants(id) AS ( \
             SELECT b.id FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION ALL \
             SELECT b.id FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
         ) \
         INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT id, ?2, ?1 FROM descendants",
    )
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// After removing a tag from a block, clean up inherited entries.
///
/// 1. Delete all rows where `inherited_from = block_id AND tag_id = tag_id`.
/// 2. For each affected descendant, walk up ancestors to find the next block
///    that directly has this tag. If found, re-insert with the new inherited_from.
///
/// This handles the case where grandparent and parent both have the same tag:
/// removing it from the parent should re-attribute inheritance to the grandparent.
pub async fn remove_inherited_tag(
    conn: &mut SqliteConnection,
    block_id: &str,
    tag_id: &str,
) -> Result<(), AppError> {
    // Step 1: Delete all entries inherited from this block for this tag
    sqlx::query("DELETE FROM block_tag_inherited WHERE inherited_from = ?1 AND tag_id = ?2")
        .bind(block_id)
        .bind(tag_id)
        .execute(&mut *conn)
        .await?;

    // Step 2: For descendants of block_id, check if any OTHER ancestor still
    // has this tag. If so, re-insert with the closest such ancestor.
    // We find all descendants of block_id, then for each, walk UP ancestors
    // (starting from block_id's parent) to find the nearest ancestor with the tag.
    //
    // Use a single SQL statement: for each descendant of block_id that doesn't
    // already have an entry in block_tag_inherited for this tag, find the
    // nearest ancestor with the tag via a lateral ancestor walk.
    sqlx::query(
        "WITH RECURSIVE \
             descendants(id) AS ( \
                 SELECT b.id FROM blocks b \
                 WHERE b.parent_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
                 UNION ALL \
                 SELECT b.id FROM blocks b \
                 JOIN descendants d ON b.parent_id = d.id \
                 WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
             ), \
             ancestors(id) AS ( \
                 SELECT parent_id AS id FROM blocks WHERE id = ?1 \
                 UNION ALL \
                 SELECT b.parent_id FROM blocks b \
                 JOIN ancestors a ON b.id = a.id \
                 WHERE b.parent_id IS NOT NULL \
             ), \
             nearest_ancestor AS ( \
                 SELECT a.id FROM ancestors a \
                 JOIN block_tags bt ON bt.block_id = a.id AND bt.tag_id = ?2 \
                 JOIN blocks b ON b.id = a.id \
                 WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
                 LIMIT 1 \
             ) \
         INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT d.id, ?2, na.id \
         FROM descendants d, nearest_ancestor na \
         WHERE d.id NOT IN ( \
             SELECT block_id FROM block_tag_inherited WHERE tag_id = ?2 \
         ) \
         AND d.id NOT IN ( \
             SELECT block_id FROM block_tags WHERE tag_id = ?2 \
         )",
    )
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;

    // Also re-insert for block_id itself if it's a descendant of the ancestor
    // (block_id no longer has the tag directly, but might inherit from above)
    sqlx::query(
        "WITH RECURSIVE \
             ancestors(id) AS ( \
                 SELECT parent_id AS id FROM blocks WHERE id = ?1 \
                 UNION ALL \
                 SELECT b.parent_id FROM blocks b \
                 JOIN ancestors a ON b.id = a.id \
                 WHERE b.parent_id IS NOT NULL \
             ), \
             nearest_ancestor AS ( \
                 SELECT a.id FROM ancestors a \
                 JOIN block_tags bt ON bt.block_id = a.id AND bt.tag_id = ?2 \
                 JOIN blocks b ON b.id = a.id \
                 WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
                 LIMIT 1 \
             ) \
         INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT ?1, ?2, na.id \
         FROM nearest_ancestor na \
         WHERE ?1 NOT IN ( \
             SELECT block_id FROM block_tags WHERE tag_id = ?2 \
         )",
    )
    .bind(block_id)
    .bind(tag_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// Recompute all inherited tags for a block and its entire subtree.
///
/// Used after `move_block` (ancestry changed), `delete_block` (subtree
/// soft-deleted), and `restore_block` (subtree un-deleted). This is the
/// "nuclear option" — deletes all inherited entries for the subtree, then
/// recomputes from scratch by walking up ancestors for each block.
pub async fn recompute_subtree_inheritance(
    conn: &mut SqliteConnection,
    root_id: &str,
) -> Result<(), AppError> {
    // Step 1: Delete all inherited entries where block_id is in the subtree
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS ( \
             SELECT ?1 AS id \
             UNION ALL \
             SELECT b.id FROM blocks b \
             JOIN subtree s ON b.parent_id = s.id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
         ) \
         DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM subtree)",
    )
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Also delete entries where inherited_from is in the subtree
    // (other blocks outside the subtree shouldn't be affected, but entries
    // inherited FROM a subtree block that has been moved need cleanup)
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS ( \
             SELECT ?1 AS id \
             UNION ALL \
             SELECT b.id FROM blocks b \
             JOIN subtree s ON b.parent_id = s.id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
         ) \
         DELETE FROM block_tag_inherited \
         WHERE inherited_from IN (SELECT id FROM subtree) \
           AND block_id NOT IN (SELECT id FROM subtree)",
    )
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Step 2: Recompute for the subtree. For each (block, tag) pair where
    // a block in the subtree has a direct tag, propagate to all its descendants
    // within the subtree.
    sqlx::query(
        "WITH RECURSIVE \
             subtree(id) AS ( \
                 SELECT ?1 AS id \
                 UNION ALL \
                 SELECT b.id FROM blocks b \
                 JOIN subtree s ON b.parent_id = s.id \
                 WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
             ), \
             tagged_descendants AS ( \
                 SELECT b.id AS block_id, bt.tag_id, bt.block_id AS inherited_from \
                 FROM subtree st \
                 JOIN block_tags bt ON bt.block_id = st.id \
                 JOIN blocks tagged ON tagged.id = bt.block_id \
                 JOIN blocks b ON b.parent_id = bt.block_id \
                 WHERE tagged.deleted_at IS NULL AND tagged.is_conflict = 0 \
                   AND b.deleted_at IS NULL AND b.is_conflict = 0 \
                 UNION ALL \
                 SELECT b.id, td.tag_id, td.inherited_from \
                 FROM tagged_descendants td \
                 JOIN blocks b ON b.parent_id = td.block_id \
                 WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
             ) \
         INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT block_id, tag_id, inherited_from FROM tagged_descendants",
    )
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Step 3: Handle tags inherited FROM OUTSIDE the subtree.
    // Walk up ancestors of root_id to find all tags that root_id and its
    // descendants should inherit from above.
    sqlx::query(
        "WITH RECURSIVE \
             ancestors(id) AS ( \
                 SELECT parent_id AS id FROM blocks WHERE id = ?1 \
                 UNION ALL \
                 SELECT b.parent_id FROM blocks b \
                 JOIN ancestors a ON b.id = a.id \
                 WHERE b.parent_id IS NOT NULL \
             ), \
             ancestor_tags AS ( \
                 SELECT bt.block_id AS inherited_from, bt.tag_id \
                 FROM ancestors anc \
                 JOIN block_tags bt ON bt.block_id = anc.id \
                 JOIN blocks b ON b.id = anc.id \
                 WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
             ), \
             subtree(id) AS ( \
                 SELECT ?1 AS id \
                 UNION ALL \
                 SELECT b.id FROM blocks b \
                 JOIN subtree s ON b.parent_id = s.id \
                 WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
             ) \
         INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT st.id, at2.tag_id, at2.inherited_from \
         FROM subtree st \
         CROSS JOIN ancestor_tags at2 \
         WHERE st.id NOT IN ( \
             SELECT block_id FROM block_tags WHERE tag_id = at2.tag_id \
         )",
    )
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// After creating a new block, inherit all tags from its parent.
///
/// The new block has no children yet, so we only need to copy the parent's
/// effective tags (direct from `block_tags` + inherited from `block_tag_inherited`).
pub async fn inherit_parent_tags(
    conn: &mut SqliteConnection,
    block_id: &str,
    parent_id: Option<&str>,
) -> Result<(), AppError> {
    let Some(parent_id) = parent_id else {
        return Ok(()); // Top-level block, no parent to inherit from
    };

    // Insert all of parent's direct tags as inherited
    sqlx::query(
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT ?1, bt.tag_id, bt.block_id \
         FROM block_tags bt \
         JOIN blocks b ON b.id = bt.block_id \
         WHERE bt.block_id = ?2 AND b.deleted_at IS NULL AND b.is_conflict = 0",
    )
    .bind(block_id)
    .bind(parent_id)
    .execute(&mut *conn)
    .await?;

    // Insert all of parent's inherited tags (pass through inherited_from)
    sqlx::query(
        "INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT ?1, bti.tag_id, bti.inherited_from \
         FROM block_tag_inherited bti \
         WHERE bti.block_id = ?2",
    )
    .bind(block_id)
    .bind(parent_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// Remove all inherited tag entries for a subtree being soft-deleted.
///
/// Also removes entries where other blocks inherited tags FROM blocks in this
/// subtree (since those blocks are now deleted, their tags shouldn't propagate).
pub async fn remove_subtree_inherited(
    conn: &mut SqliteConnection,
    root_id: &str,
) -> Result<(), AppError> {
    // Remove entries where block_id is in subtree
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS ( \
             SELECT ?1 AS id \
             UNION ALL \
             SELECT b.id FROM blocks b \
             JOIN subtree s ON b.parent_id = s.id \
         ) \
         DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM subtree)",
    )
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    // Remove entries where inherited_from is in subtree (tags from deleted blocks)
    sqlx::query(
        "WITH RECURSIVE subtree(id) AS ( \
             SELECT ?1 AS id \
             UNION ALL \
             SELECT b.id FROM blocks b \
             JOIN subtree s ON b.parent_id = s.id \
         ) \
         DELETE FROM block_tag_inherited \
         WHERE inherited_from IN (SELECT id FROM subtree)",
    )
    .bind(root_id)
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// Full rebuild of the `block_tag_inherited` table.
///
/// Atomic DELETE + recompute in a single transaction. Called as a background
/// materializer task (safety net / initial population).
pub async fn rebuild_all(pool: &SqlitePool) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM block_tag_inherited")
        .execute(&mut *tx)
        .await?;

    sqlx::query(
        "WITH RECURSIVE descendant_tags AS ( \
             SELECT b.id AS block_id, bt.tag_id, bt.block_id AS inherited_from \
             FROM block_tags bt \
             JOIN blocks tagged ON tagged.id = bt.block_id \
             JOIN blocks b ON b.parent_id = bt.block_id \
             WHERE tagged.deleted_at IS NULL AND tagged.is_conflict = 0 \
               AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION ALL \
             SELECT b.id AS block_id, dt.tag_id, dt.inherited_from \
             FROM descendant_tags dt \
             JOIN blocks b ON b.parent_id = dt.block_id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
         ) \
         INSERT OR IGNORE INTO block_tag_inherited (block_id, tag_id, inherited_from) \
         SELECT block_id, tag_id, inherited_from FROM descendant_tags",
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    // -- Helpers --

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
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, ?, ?, 1)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn get_inherited(pool: &SqlitePool) -> Vec<(String, String, String)> {
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT block_id, tag_id, inherited_from \
             FROM block_tag_inherited ORDER BY block_id, tag_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    async fn soft_delete(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    // ======================================================================
    // propagate_tag_to_descendants
    // ======================================================================

    #[tokio::test]
    async fn propagate_basic() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG", "tag", "tag-name", None).await;
        insert_block(&pool, "PAGE_A", "page", "page a", None).await;
        insert_block(&pool, "CHILD1", "content", "child 1", Some("PAGE_A")).await;
        insert_block(&pool, "CHILD2", "content", "child 2", Some("PAGE_A")).await;

        insert_tag_assoc(&pool, "PAGE_A", "TAG").await;

        let mut conn = pool.acquire().await.unwrap();
        propagate_tag_to_descendants(&mut *conn, "PAGE_A", "TAG")
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.contains(&("CHILD1".into(), "TAG".into(), "PAGE_A".into())));
        assert!(rows.contains(&("CHILD2".into(), "TAG".into(), "PAGE_A".into())));
    }

    #[tokio::test]
    async fn propagate_multi_level() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG", "tag", "tag-name", None).await;
        insert_block(&pool, "PAGE", "page", "page", None).await;
        insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;
        insert_block(&pool, "GRANDCHILD", "content", "grandchild", Some("CHILD")).await;

        insert_tag_assoc(&pool, "PAGE", "TAG").await;

        let mut conn = pool.acquire().await.unwrap();
        propagate_tag_to_descendants(&mut *conn, "PAGE", "TAG")
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.contains(&("CHILD".into(), "TAG".into(), "PAGE".into())));
        assert!(rows.contains(&("GRANDCHILD".into(), "TAG".into(), "PAGE".into())));
    }

    #[tokio::test]
    async fn propagate_skips_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG", "tag", "tag-name", None).await;
        insert_block(&pool, "PAGE", "page", "page", None).await;
        insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;
        insert_block(&pool, "GRANDCHILD", "content", "grandchild", Some("CHILD")).await;

        soft_delete(&pool, "CHILD").await;
        insert_tag_assoc(&pool, "PAGE", "TAG").await;

        let mut conn = pool.acquire().await.unwrap();
        propagate_tag_to_descendants(&mut *conn, "PAGE", "TAG")
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert!(
            rows.is_empty(),
            "Deleted subtree should not get inherited entries, got: {rows:?}"
        );
    }

    #[tokio::test]
    async fn propagate_idempotent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG", "tag", "tag-name", None).await;
        insert_block(&pool, "PAGE", "page", "page", None).await;
        insert_block(&pool, "CHILD1", "content", "child 1", Some("PAGE")).await;
        insert_block(&pool, "CHILD2", "content", "child 2", Some("PAGE")).await;

        insert_tag_assoc(&pool, "PAGE", "TAG").await;

        let mut conn = pool.acquire().await.unwrap();
        propagate_tag_to_descendants(&mut *conn, "PAGE", "TAG")
            .await
            .unwrap();
        // Second call — INSERT OR IGNORE should be a no-op.
        propagate_tag_to_descendants(&mut *conn, "PAGE", "TAG")
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert_eq!(
            rows.len(),
            2,
            "Idempotent call should not create duplicates"
        );
    }

    // ======================================================================
    // remove_inherited_tag
    // ======================================================================

    #[tokio::test]
    async fn remove_inherited_basic() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG", "tag", "tag-name", None).await;
        insert_block(&pool, "PAGE", "page", "page", None).await;
        insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;

        insert_tag_assoc(&pool, "PAGE", "TAG").await;

        let mut conn = pool.acquire().await.unwrap();
        propagate_tag_to_descendants(&mut *conn, "PAGE", "TAG")
            .await
            .unwrap();
        assert_eq!(get_inherited(&pool).await.len(), 1);

        // Simulate removing the tag from PAGE.
        sqlx::query("DELETE FROM block_tags WHERE block_id = 'PAGE' AND tag_id = 'TAG'")
            .execute(&pool)
            .await
            .unwrap();
        remove_inherited_tag(&mut *conn, "PAGE", "TAG")
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert!(
            rows.is_empty(),
            "All inherited entries should be removed when no ancestor has the tag"
        );
    }

    #[tokio::test]
    async fn remove_inherited_reattributes_to_grandparent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG", "tag", "tag-name", None).await;
        insert_block(&pool, "GRAND", "page", "grand", None).await;
        insert_block(&pool, "PARENT", "content", "parent", Some("GRAND")).await;
        insert_block(&pool, "CHILD", "content", "child", Some("PARENT")).await;

        // Both GRAND and PARENT have TAG directly.
        insert_tag_assoc(&pool, "GRAND", "TAG").await;
        insert_tag_assoc(&pool, "PARENT", "TAG").await;

        let mut conn = pool.acquire().await.unwrap();

        // Propagate PARENT first so CHILD gets inherited_from = PARENT.
        propagate_tag_to_descendants(&mut *conn, "PARENT", "TAG")
            .await
            .unwrap();
        // Propagate GRAND — PARENT gets (PARENT, TAG, GRAND);
        // CHILD already has (CHILD, TAG) so INSERT OR IGNORE keeps PARENT.
        propagate_tag_to_descendants(&mut *conn, "GRAND", "TAG")
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.contains(&("PARENT".into(), "TAG".into(), "GRAND".into())));
        assert!(rows.contains(&("CHILD".into(), "TAG".into(), "PARENT".into())));

        // Remove TAG from PARENT — CHILD should re-attribute to GRAND.
        sqlx::query("DELETE FROM block_tags WHERE block_id = 'PARENT' AND tag_id = 'TAG'")
            .execute(&pool)
            .await
            .unwrap();
        remove_inherited_tag(&mut *conn, "PARENT", "TAG")
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.contains(&("PARENT".into(), "TAG".into(), "GRAND".into())));
        assert!(rows.contains(&("CHILD".into(), "TAG".into(), "GRAND".into())));
    }

    // ======================================================================
    // recompute_subtree_inheritance
    // ======================================================================

    #[tokio::test]
    async fn recompute_subtree_after_move() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG", "tag", "tag-name", None).await;
        insert_block(&pool, "PAGE1", "page", "page 1", None).await;
        insert_block(&pool, "PAGE2", "page", "page 2", None).await;
        insert_block(&pool, "CHILD", "content", "child", Some("PAGE1")).await;

        insert_tag_assoc(&pool, "PAGE1", "TAG").await;

        let mut conn = pool.acquire().await.unwrap();
        propagate_tag_to_descendants(&mut *conn, "PAGE1", "TAG")
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert_eq!(rows, vec![("CHILD".into(), "TAG".into(), "PAGE1".into())]);

        // Move CHILD to PAGE2 (which has no tags).
        sqlx::query("UPDATE blocks SET parent_id = 'PAGE2' WHERE id = 'CHILD'")
            .execute(&pool)
            .await
            .unwrap();

        recompute_subtree_inheritance(&mut *conn, "CHILD")
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert!(
            rows.is_empty(),
            "CHILD should not inherit after moving to untagged parent, got: {rows:?}"
        );
    }

    // ======================================================================
    // inherit_parent_tags
    // ======================================================================

    #[tokio::test]
    async fn inherit_parent_tags_basic() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG", "tag", "tag-name", None).await;
        insert_block(&pool, "PAGE", "page", "page", None).await;
        insert_tag_assoc(&pool, "PAGE", "TAG").await;

        // Create a new child block.
        insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;

        let mut conn = pool.acquire().await.unwrap();
        inherit_parent_tags(&mut *conn, "CHILD", Some("PAGE"))
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert_eq!(rows, vec![("CHILD".into(), "TAG".into(), "PAGE".into())]);
    }

    #[tokio::test]
    async fn inherit_parent_tags_none_for_root() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK", "page", "block", None).await;

        let mut conn = pool.acquire().await.unwrap();
        inherit_parent_tags(&mut *conn, "BLOCK", None)
            .await
            .unwrap();

        let rows = get_inherited(&pool).await;
        assert!(rows.is_empty(), "Root blocks should not inherit any tags");
    }

    // ======================================================================
    // remove_subtree_inherited
    // ======================================================================

    #[tokio::test]
    async fn remove_subtree_basic() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG", "tag", "tag-name", None).await;
        insert_block(&pool, "PAGE", "page", "page", None).await;
        insert_block(&pool, "CHILD", "content", "child", Some("PAGE")).await;
        insert_block(&pool, "GRANDCHILD", "content", "grandchild", Some("CHILD")).await;

        insert_tag_assoc(&pool, "PAGE", "TAG").await;

        let mut conn = pool.acquire().await.unwrap();
        propagate_tag_to_descendants(&mut *conn, "PAGE", "TAG")
            .await
            .unwrap();
        assert_eq!(get_inherited(&pool).await.len(), 2);

        // Remove the subtree rooted at CHILD.
        remove_subtree_inherited(&mut *conn, "CHILD").await.unwrap();

        let rows = get_inherited(&pool).await;
        assert!(
            rows.is_empty(),
            "All inherited entries for the deleted subtree should be removed"
        );
    }

    // ======================================================================
    // rebuild_all
    // ======================================================================

    #[tokio::test]
    async fn rebuild_all_matches_propagation() {
        let (pool, _dir) = test_pool().await;

        // Tree: ROOT -> PAGE_A -> CHILD_A
        //            -> PAGE_B -> CHILD_B
        insert_block(&pool, "TAG1", "tag", "tag1", None).await;
        insert_block(&pool, "TAG2", "tag", "tag2", None).await;
        insert_block(&pool, "ROOT", "page", "root", None).await;
        insert_block(&pool, "PAGE_A", "page", "page a", Some("ROOT")).await;
        insert_block(&pool, "PAGE_B", "page", "page b", Some("ROOT")).await;
        insert_block(&pool, "CHILD_A", "content", "child a", Some("PAGE_A")).await;
        insert_block(&pool, "CHILD_B", "content", "child b", Some("PAGE_B")).await;

        // ROOT has TAG1, PAGE_B has TAG2.
        insert_tag_assoc(&pool, "ROOT", "TAG1").await;
        insert_tag_assoc(&pool, "PAGE_B", "TAG2").await;

        rebuild_all(&pool).await.unwrap();

        let rows = get_inherited(&pool).await;

        // TAG1 from ROOT propagates to all 4 descendants.
        assert!(rows.contains(&("PAGE_A".into(), "TAG1".into(), "ROOT".into())));
        assert!(rows.contains(&("PAGE_B".into(), "TAG1".into(), "ROOT".into())));
        assert!(rows.contains(&("CHILD_A".into(), "TAG1".into(), "ROOT".into())));
        assert!(rows.contains(&("CHILD_B".into(), "TAG1".into(), "ROOT".into())));

        // TAG2 from PAGE_B propagates only to CHILD_B.
        assert!(rows.contains(&("CHILD_B".into(), "TAG2".into(), "PAGE_B".into())));

        assert_eq!(rows.len(), 5);
    }
}
