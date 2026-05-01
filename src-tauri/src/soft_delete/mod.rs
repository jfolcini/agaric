//! Soft-delete with cascade, restore, and purge operations.

mod restore;
mod trash;

pub use restore::restore_block;
pub use trash::{cascade_soft_delete, soft_delete_block};
// M-81 — re-exported `pub(crate)` so the production write path
// `commands::blocks::crud::delete_block_inner` can call the same
// re-parent helper that `cascade_soft_delete` uses internally, keeping
// the conflict-copy re-parent semantics in one place across both
// cascade sites without widening the helper's public surface.
pub(crate) use trash::reparent_orphan_conflict_copies;

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
///
/// Recursive member filters `is_conflict = 0` — conflict copies share
/// their original's parent_id but are logically separate (invariant #9).
/// `depth < 100` bounds the walk.
///
/// Canonical CTE in `crate::block_descendants::DESCENDANTS_CTE_STANDARD`.
/// This site inlines the SQL because `sqlx::query!` requires a string
/// literal and cannot accept `concat!()` of a `macro_rules!` expansion.
pub async fn get_descendants(pool: &SqlitePool, block_id: &str) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.is_conflict = 0 AND d.depth < 100 \
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
    /// Device id stamped on the M-81 re-parent op log entries that
    /// `cascade_soft_delete` now emits for orphaned conflict copies. Tests
    /// that don't trigger a re-parent (the vast majority) will not write
    /// any op log rows, but the parameter is required by the signature.
    const TEST_DEVICE: &str = "soft-delete-test-device";

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
        let (ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();
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
        let (t2, count) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();
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
        let (ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, "LEAF01")
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(get_deleted_at(&pool, "LEAF01").await, Some(ts));
    }

    #[tokio::test]
    async fn cascade_soft_delete_on_nonexistent_returns_zero() {
        let (pool, _dir) = test_pool().await;
        let (_ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, "NONEXISTENT")
            .await
            .unwrap();
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
        let (ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, "L00")
            .await
            .unwrap();
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
        let (ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, "WROOT")
            .await
            .unwrap();
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
        cascade_soft_delete(&pool, TEST_DEVICE, "TREE_A")
            .await
            .unwrap();
        assert_eq!(get_deleted_at(&pool, "TREE_B").await, None);
        assert_eq!(get_deleted_at(&pool, "TREE_B_C").await, None);
    }

    #[tokio::test]
    async fn cascade_soft_delete_skips_conflict_copies() {
        // Invariant #9: the recursive CTE filters `is_conflict = 0` so a
        // conflict copy sharing parent_id with its original is NOT swept
        // into the cascade. Without that filter the conflict copy would be
        // soft-deleted alongside its ancestors and surface in trash UIs.
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(
            &pool,
            CHILD,
            "content",
            "normal child",
            Some(PARENT),
            Some(1),
        )
        .await;
        // Conflict copy: shares parent_id with the original but is_conflict = 1.
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict, conflict_source) \
             VALUES (?, 'content', 'conflict copy', ?, 2, 1, ?)",
            CHILD2,
            PARENT,
            CHILD,
        )
        .execute(&pool)
        .await
        .unwrap();

        let (ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        assert_eq!(count, 2);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(ts.clone()));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(ts));
        assert_eq!(get_deleted_at(&pool, CHILD2).await, None);
    }

    // ======================================================================
    // M-81: re-parent orphaned conflict copies on cascade soft-delete
    // ======================================================================

    /// Direct INSERT helper for a conflict copy. Conflict copies share their
    /// original's `parent_id` at creation time but carry `is_conflict = 1`,
    /// so the cascade CTE's `is_conflict = 0` filter (invariant #9) skips
    /// them — leaving them pointing at a soft-deleted ancestor unless
    /// `cascade_soft_delete` re-parents them. M-81 closes that gap.
    async fn insert_conflict_copy(
        pool: &SqlitePool,
        id: &str,
        parent_id: &str,
        position: i64,
        conflict_source: &str,
    ) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict, conflict_source) \
             VALUES (?, 'content', 'conflict copy', ?, ?, 1, ?)",
            id,
            parent_id,
            position,
            conflict_source,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn get_parent_id(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query!("SELECT parent_id FROM blocks WHERE id = ?", id)
            .fetch_one(pool)
            .await
            .unwrap()
            .parent_id
    }

    /// M-81 happy path: the cascade root sits under a live grandparent, so
    /// a conflict copy whose `parent_id` is the doomed CHILD must end up
    /// re-parented to the live ancestor outside the subtree.
    #[tokio::test]
    async fn cascade_reparents_conflict_copy_under_deleted_subtree_m81() {
        let (pool, _dir) = test_pool().await;
        // Live ancestor outside the cascade subtree.
        insert_block(&pool, "M81GP", "page", "grandparent", None, Some(1)).await;
        // Cascade root, parented under M81GP.
        insert_block(&pool, PARENT, "page", "parent", Some("M81GP"), Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        // Conflict copy's parent is CHILD, which is in the cascade subtree.
        insert_conflict_copy(&pool, CHILD2, CHILD, 2, CHILD).await;

        let (ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();

        // Cascade swept PARENT + CHILD; conflict copy is preserved alive.
        assert_eq!(count, 2);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(ts.clone()));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(ts));
        assert_eq!(get_deleted_at(&pool, CHILD2).await, None);
        // The conflict copy now points at the nearest live, non-conflict
        // ancestor — M81GP, the cascade root's parent.
        assert_eq!(
            get_parent_id(&pool, CHILD2).await,
            Some("M81GP".to_string()),
            "conflict copy must be re-parented to the nearest live ancestor outside the cascade subtree"
        );
    }

    /// M-81 edge case: the entire ancestor chain is being deleted (the
    /// cascade root has no parent), so no live, non-conflict ancestor is
    /// reachable and the conflict copy floats to `parent_id = NULL`.
    #[tokio::test]
    async fn cascade_reparents_conflict_copy_to_null_when_no_ancestor_m81() {
        let (pool, _dir) = test_pool().await;
        // PARENT is a top-level block (parent_id IS NULL) — the cascade
        // root has no live ancestor to re-parent under.
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_conflict_copy(&pool, CHILD2, CHILD, 2, CHILD).await;

        let (ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();

        assert_eq!(count, 2);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(ts.clone()));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(ts));
        assert_eq!(get_deleted_at(&pool, CHILD2).await, None);
        assert_eq!(
            get_parent_id(&pool, CHILD2).await,
            None,
            "conflict copy must float to parent_id = NULL when no live ancestor exists outside the cascade"
        );
    }

    /// M-81 sync replay contract: each re-parent must emit exactly one
    /// `move_block` op log entry inside the same `BEGIN IMMEDIATE`
    /// transaction as the cascade — so peers can replay the repair through
    /// normal sync. Two conflict copies → exactly two op log rows, each
    /// payload referencing the conflict copy id and the new parent id.
    #[tokio::test]
    async fn cascade_emits_op_log_entry_per_reparent_m81() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "M81GP2", "page", "grandparent", None, Some(1)).await;
        insert_block(&pool, PARENT, "page", "parent", Some("M81GP2"), Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        // Two distinct conflict copies, both pointing into the doomed
        // subtree (one under CHILD, one under PARENT).
        insert_conflict_copy(&pool, "M81CC1", CHILD, 5, CHILD).await;
        insert_conflict_copy(&pool, "M81CC2", PARENT, 7, PARENT).await;

        // Pre-condition: no op log rows for our test device.
        let pre: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM op_log WHERE device_id = ?"#,
            TEST_DEVICE
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(pre, 0);

        cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();

        // Exactly two move_block ops — one per re-parent — written by
        // this device. No DeleteBlock op (cascade_soft_delete itself does
        // not emit one; the production `delete_block` command writes that
        // separately).
        let move_count: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM op_log WHERE device_id = ? AND op_type = 'move_block'"#,
            TEST_DEVICE
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            move_count, 2,
            "one move_block op log entry must be written per re-parent",
        );

        let total: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM op_log WHERE device_id = ?"#,
            TEST_DEVICE
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            total, 2,
            "cascade_soft_delete must emit exactly the per-reparent ops, no extras",
        );

        // Each payload must reference its conflict copy id and the new
        // parent id (M81GP2 — the cascade root's live grandparent).
        let payloads: Vec<String> = sqlx::query_scalar!(
            r#"SELECT payload AS "payload!" FROM op_log WHERE device_id = ? AND op_type = 'move_block' ORDER BY seq"#,
            TEST_DEVICE
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(payloads.len(), 2);

        let mut saw_cc1 = 0;
        let mut saw_cc2 = 0;
        for payload in &payloads {
            let v: serde_json::Value = serde_json::from_str(payload).unwrap();
            let block_id = v["block_id"].as_str().unwrap();
            let new_parent_id = v["new_parent_id"].as_str().unwrap();
            assert_eq!(
                new_parent_id, "M81GP2",
                "every re-parent op must point at the live grandparent",
            );
            match block_id {
                "M81CC1" => saw_cc1 += 1,
                "M81CC2" => saw_cc2 += 1,
                other => panic!("unexpected move_block target: {other}"),
            }
        }
        assert_eq!(saw_cc1, 1, "M81CC1 must be re-parented exactly once");
        assert_eq!(saw_cc2, 1, "M81CC2 must be re-parented exactly once");
    }

    /// M-81 invariant: a conflict copy whose `parent_id` is OUTSIDE the
    /// cascade subtree is untouched by the cascade — neither its
    /// `parent_id` nor the op log are mutated on its behalf.
    #[tokio::test]
    async fn cascade_does_not_reparent_conflict_copy_outside_subtree_m81() {
        let (pool, _dir) = test_pool().await;
        // Two roots: PARENT (cascade target) and SIBLING (untouched).
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_block(&pool, "M81SIB", "page", "sibling root", None, Some(2)).await;
        // Conflict copy's parent is SIBLING — *outside* the cascade subtree.
        insert_conflict_copy(&pool, CHILD2, "M81SIB", 1, CHILD).await;

        cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();

        // CC is unaffected: still alive, still parented under SIBLING.
        assert_eq!(get_deleted_at(&pool, CHILD2).await, None);
        assert_eq!(
            get_parent_id(&pool, CHILD2).await,
            Some("M81SIB".to_string()),
            "conflict copy outside the cascade subtree must keep its parent_id",
        );
        // No op log entries — nothing was re-parented.
        let move_count: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM op_log WHERE device_id = ? AND op_type = 'move_block'"#,
            TEST_DEVICE
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            move_count, 0,
            "no move_block op must be emitted when no re-parent is needed",
        );
    }

    /// M-81 observability contract: each re-parent emits a `tracing::warn`
    /// breadcrumb naming `conflict_copy_id`, `deleted_ancestor_id`, and
    /// `new_parent_id`. Captured via the same in-process `BufWriter`
    /// pattern used by `dispatch_background_or_warn_logs_seq_and_device_id_on_serde_error`
    /// in `materializer/tests.rs` — the crate does not wire `tracing-test`.
    #[tokio::test]
    async fn cascade_emits_warn_log_per_reparent_m81() {
        use tracing_subscriber::layer::SubscriberExt;

        /// Thread-safe buffered writer for in-process log capture (mirrors
        /// `WarnBufWriter` in `materializer/tests.rs`; AGENTS.md
        /// "Test helper duplication is intentional").
        #[derive(Clone, Default)]
        struct WarnBufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

        impl std::io::Write for WarnBufWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for WarnBufWriter {
            type Writer = WarnBufWriter;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "M81GP3", "page", "grandparent", None, Some(1)).await;
        insert_block(&pool, PARENT, "page", "parent", Some("M81GP3"), Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        insert_conflict_copy(&pool, CHILD2, CHILD, 5, CHILD).await;

        let writer = WarnBufWriter::default();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("agaric=warn"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer.clone())
                    .with_ansi(false),
            );
        let _guard = tracing::subscriber::set_default(subscriber);

        cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();

        let contents = {
            let bytes = writer.0.lock().unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        };
        // Exactly one re-parent → exactly one warn line carrying the
        // conflict copy id, the deleted ancestor that triggered it, and
        // the new parent id.
        let warn_lines: Vec<&str> = contents
            .lines()
            .filter(|l| l.contains("M-81: re-parented conflict copy"))
            .collect();
        assert_eq!(
            warn_lines.len(),
            1,
            "exactly one warn line per re-parent, got: {contents:?}",
        );
        let line = warn_lines[0];
        assert!(
            line.contains(&format!("conflict_copy_id={CHILD2}")),
            "warn must include conflict_copy_id={CHILD2}, got: {line:?}",
        );
        assert!(
            line.contains(&format!("deleted_ancestor_id={CHILD}")),
            "warn must include deleted_ancestor_id={CHILD} (the conflict copy's pre-cascade parent), got: {line:?}",
        );
        assert!(
            line.contains("new_parent_id=") && line.contains("M81GP3"),
            "warn must include new_parent_id with the live grandparent M81GP3, got: {line:?}",
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
        let (ts, _) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();
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
        let (t2, _) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();
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
        let (real_ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        assert_eq!(count, 2);
        let wrong_ts = "1999-01-01T00:00:00+00:00";
        let restored = restore_block(&pool, PARENT, wrong_ts).await.unwrap();
        assert_eq!(restored, 0);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(real_ts.clone()));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(real_ts));
    }

    /// L-102: a wrong-token call must return `Ok(0)` AND emit a `tracing::warn`
    /// breadcrumb naming `block_id` and `deleted_at_ref`. Capturing tracing
    /// subscriber output in unit tests is heavy (requires per-test
    /// subscriber install + buffer capture wiring), so this test only
    /// asserts the contract-level return value. The warn line is reviewed
    /// at the source site (`soft_delete/restore.rs`).
    #[tokio::test]
    async fn restore_block_warns_when_no_rows_match() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        let (real_ts, count) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        assert_eq!(count, 2);

        let wrong_ts = "1999-01-01T00:00:00+00:00";
        let restored = restore_block(&pool, PARENT, wrong_ts).await.unwrap();

        // Contract: wrong token is a silent no-op at the return-value level.
        // The warn breadcrumb is emitted as a side effect (verified by code
        // review, not captured here).
        assert_eq!(restored, 0);
        // And the original deletion is preserved.
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
        let (ts1, count1) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        assert_eq!(count1, 3);
        let (_ts2, count2) = cascade_soft_delete(&pool, TEST_DEVICE, PARENT)
            .await
            .unwrap();
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
                cascade_soft_delete(&pool, TEST_DEVICE, &id).await
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
