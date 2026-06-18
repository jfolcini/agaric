//! Soft-delete with cascade, restore, and purge operations.
//!
//! NOTE (#386/#1656): the `cascade_soft_delete` and `restore_block`
//! primitives re-exported below have **no production callers**. Production
//! deletes go through `commands::blocks::crud::delete_block_inner`, and
//! production restores through `loro::engine::apply_restore_block` /
//! `materializer::handlers::project_restore_block_to_sql`. These primitives
//! exist solely to exercise the materializer cache-rebuild fan-out in tests;
//! their only consumers are `#[cfg(test)]` modules plus the
//! `soft_delete_bench` perf harness (a public-API bench, which is why they
//! cannot simply be `#[cfg(test)]`-gated). Treat their `&Materializer` /
//! op-dispatch wiring as test scaffolding, NOT production guidance — see the
//! per-function docs. The `is_deleted` helper below is the one item here on a
//! production path.

mod restore;
mod trash;

#[cfg(test)]
mod proptest_b3;

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

// MAINT-113 M1 — `get_descendants` removed (2026-05-02). It returned a
// non-conflict-but-possibly-deleted descendant set (
// only, no `deleted_at IS NULL` filter), so it never fit the
// `ActiveBlockId` model the rest of the codebase reaches for. It also
// had zero production callers — only its own `#[cfg(test)]` module
// referenced it. The remaining cascade / restore / purge call sites
// use the `descendants_cte_*` macros from `crate::block_descendants`
// directly, with the variant chosen at the call site:
// - cascade_soft_delete   → descendants_cte_active!()
// - restore_block         → descendants_cte_standard!()
// - purge / compaction    → descendants_cte_purge!()

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::materializer::Materializer;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const BLOCK_A: &str = "BLK_A01";
    const BLOCK_B: &str = "BLK_B02";
    const PARENT: &str = "PAR001";
    const CHILD: &str = "CHD001";
    const GRANDCHILD: &str = "GCH001";
    const FIXED_DELETED_AT: i64 = 1_735_689_600_000;
    /// Device id stamped on op log entries written by cascade soft-delete
    /// tests.
    const TEST_DEVICE: &str = "soft-delete-test-device";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// SQL-review M-3: `cascade_soft_delete` / `restore_block` now take
    /// `&Materializer`, so every test setup needs one. Pool + Materializer
    /// + TempDir bundle; drop order matters (TempDir last).
    async fn test_pool_and_mat() -> (SqlitePool, Materializer, TempDir) {
        let (pool, dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        (pool, mat, dir)
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

    async fn get_deleted_at(pool: &SqlitePool, id: &str) -> Option<i64> {
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
        let (pool, mat, _dir) = test_pool_and_mat().await;
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
        let (ts, count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        assert_eq!(count, 3);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(ts));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(ts));
        assert_eq!(get_deleted_at(&pool, GRANDCHILD).await, Some(ts));
    }

    #[tokio::test]
    async fn cascade_soft_delete_skips_already_deleted_subtree() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
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
        let (t2, count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, PARENT)
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
        let (pool, mat, _dir) = test_pool_and_mat().await;
        insert_block(&pool, "LEAF01", "content", "leaf node", None, Some(1)).await;
        let (ts, count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, "LEAF01")
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(get_deleted_at(&pool, "LEAF01").await, Some(ts));
    }

    #[tokio::test]
    async fn cascade_soft_delete_on_nonexistent_returns_zero() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
        let (_ts, count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, "NONEXISTENT")
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn cascade_soft_delete_handles_deep_linear_chain() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
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
        let (ts, count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, "L00")
            .await
            .unwrap();
        assert_eq!(count, 11);
        for i in 0..=10 {
            let id = format!("L{i:02}");
            assert_eq!(get_deleted_at(&pool, &id).await, Some(ts));
        }
    }

    #[tokio::test]
    async fn cascade_soft_delete_handles_wide_tree() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
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
        let (ts, count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, "WROOT")
            .await
            .unwrap();
        assert_eq!(count, 101);
        assert_eq!(get_deleted_at(&pool, "WROOT").await, Some(ts));
        for i in 0..100 {
            let id = format!("WC{i:03}");
            assert_eq!(get_deleted_at(&pool, &id).await, Some(ts));
        }
    }

    #[tokio::test]
    async fn cascade_soft_delete_leaves_sibling_trees_untouched() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
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
        cascade_soft_delete(&pool, &mat, TEST_DEVICE, "TREE_A")
            .await
            .unwrap();
        assert_eq!(get_deleted_at(&pool, "TREE_B").await, None);
        assert_eq!(get_deleted_at(&pool, "TREE_B_C").await, None);
    }

    // ======================================================================
    // restore_block
    // ======================================================================

    #[tokio::test]
    async fn restore_block_clears_entire_subtree() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
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
        let (ts, _) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        let restored = restore_block(&pool, &mat, PARENT, ts).await.unwrap();
        assert_eq!(restored, 3);
        assert_eq!(get_deleted_at(&pool, PARENT).await, None);
        assert_eq!(get_deleted_at(&pool, CHILD).await, None);
        assert_eq!(get_deleted_at(&pool, GRANDCHILD).await, None);
    }

    #[tokio::test]
    async fn restore_block_preserves_independently_deleted_descendants() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
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
        let (t2, _) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        let restored = restore_block(&pool, &mat, PARENT, t2).await.unwrap();
        assert_eq!(restored, 2);
        assert_eq!(get_deleted_at(&pool, PARENT).await, None);
        assert_eq!(get_deleted_at(&pool, CHILD).await, None);
        assert_eq!(
            get_deleted_at(&pool, GRANDCHILD).await,
            Some(FIXED_DELETED_AT)
        );
    }

    #[tokio::test]
    async fn restore_block_on_non_deleted_returns_zero() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
        insert_block(&pool, BLOCK_A, "content", "alive", None, None).await;
        let restored = restore_block(&pool, &mat, BLOCK_A, FIXED_DELETED_AT)
            .await
            .unwrap();
        assert_eq!(restored, 0);
    }

    // ======================================================================
    // Helper functions: is_deleted
    // ======================================================================
    //
    // `get_descendants` was removed in MAINT-113 M1 (2026-05-02). See the
    // module-level comment for rationale.

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
    async fn restore_block_with_wrong_deleted_at_ref() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        let (real_ts, count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        assert_eq!(count, 2);
        let wrong_ts: i64 = 915_148_800_000;
        let restored = restore_block(&pool, &mat, PARENT, wrong_ts).await.unwrap();
        assert_eq!(restored, 0);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(real_ts));
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
        let (pool, mat, _dir) = test_pool_and_mat().await;
        insert_block(&pool, PARENT, "page", "parent", None, Some(1)).await;
        insert_block(&pool, CHILD, "content", "child", Some(PARENT), Some(1)).await;
        let (real_ts, count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        assert_eq!(count, 2);

        let wrong_ts: i64 = 915_148_800_000;
        let restored = restore_block(&pool, &mat, PARENT, wrong_ts).await.unwrap();

        // Contract: wrong token is a silent no-op at the return-value level.
        // The warn breadcrumb is emitted as a side effect (verified by code
        // review, not captured here).
        assert_eq!(restored, 0);
        // And the original deletion is preserved.
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(real_ts));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(real_ts));
    }

    #[tokio::test]
    async fn double_cascade_soft_delete_is_idempotent() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
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
        let (ts1, count1) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        assert_eq!(count1, 3);
        let (_ts2, count2) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, PARENT)
            .await
            .unwrap();
        assert_eq!(count2, 0);
        assert_eq!(get_deleted_at(&pool, PARENT).await, Some(ts1));
        assert_eq!(get_deleted_at(&pool, CHILD).await, Some(ts1));
        assert_eq!(get_deleted_at(&pool, GRANDCHILD).await, Some(ts1));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_deletes_dont_panic() {
        let (pool, mat, _dir) = test_pool_and_mat().await;
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
            let mat = mat.clone();
            handles.push(tokio::spawn(async move {
                let id = format!("CCHD{i:02}");
                cascade_soft_delete(&pool, &mat, TEST_DEVICE, &id).await
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

    // ======================================================================
    // PEND-26 N2 — cascade-depth saturation detection
    // ======================================================================

    /// Capture-into-`Vec<u8>` writer used to assert that a `tracing::warn!`
    /// fires during a cascade. Mirrors the `LogBufWriter` pattern from
    /// `materializer/tests.rs`.
    #[derive(Clone, Default)]
    struct LogBufWriter(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl LogBufWriter {
        fn contents(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    impl std::io::Write for LogBufWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBufWriter {
        type Writer = LogBufWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// PEND-26 N2: a 105-level tree saturates the depth-100 cap on the
    /// soft-delete cascade. The helper must report `true` AND
    /// `cascade_soft_delete` must emit the operator-visible warn.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cascade_soft_delete_warns_on_depth_saturated_subtree_pend26n2() {
        use tracing_subscriber::layer::SubscriberExt;

        let (pool, mat, _dir) = test_pool_and_mat().await;

        // Build 105-block linear chain rooted at PEND26N2_DEEP_R.
        insert_block(&pool, "PEND26N2_DEEP_R", "page", "root", None, Some(1)).await;
        for i in 1..=104 {
            let id = format!("PEND26N2_DEEP_{i}");
            let parent = if i == 1 {
                "PEND26N2_DEEP_R".to_string()
            } else {
                format!("PEND26N2_DEEP_{}", i - 1)
            };
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

        let writer = LogBufWriter::default();
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_level(true)
                .with_target(false),
        );
        let _guard = tracing::subscriber::set_default(subscriber);

        let (_ts, _count) = cascade_soft_delete(&pool, &mat, TEST_DEVICE, "PEND26N2_DEEP_R")
            .await
            .unwrap();

        // Drop the guard before reading so any buffered output flushes.
        drop(_guard);

        // The helper itself agrees on the saturation status.
        let saturated = crate::block_descendants::cascade_depth_saturated(&pool, "PEND26N2_DEEP_R")
            .await
            .unwrap();
        assert!(
            saturated,
            "PEND-26 N2: helper must report saturation on a 105-block chain"
        );

        // The warn message must have been written by `cascade_soft_delete`.
        let logs = writer.contents();
        assert!(
            logs.contains("PEND-26 N2"),
            "PEND-26 N2: cascade_soft_delete must emit the saturation warn; got log buffer: {logs}",
        );
        assert!(
            logs.contains("WARN"),
            "PEND-26 N2: emitted log entry must be at WARN level; got: {logs}",
        );
    }

    /// PEND-26 N2: a 99-level tree (max depth 98) does NOT saturate.
    /// `cascade_soft_delete` must complete normally with no warn.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cascade_soft_delete_does_not_warn_under_threshold_pend26n2() {
        use tracing_subscriber::layer::SubscriberExt;

        let (pool, mat, _dir) = test_pool_and_mat().await;

        // Build 99-block linear chain (depths 0..98).
        insert_block(&pool, "PEND26N2_OK_R", "page", "root", None, Some(1)).await;
        for i in 1..=98 {
            let id = format!("PEND26N2_OK_{i}");
            let parent = if i == 1 {
                "PEND26N2_OK_R".to_string()
            } else {
                format!("PEND26N2_OK_{}", i - 1)
            };
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

        let writer = LogBufWriter::default();
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_writer(writer.clone())
                .with_ansi(false)
                .with_level(true)
                .with_target(false),
        );
        let _guard = tracing::subscriber::set_default(subscriber);

        let _ = cascade_soft_delete(&pool, &mat, TEST_DEVICE, "PEND26N2_OK_R")
            .await
            .unwrap();

        drop(_guard);

        let saturated = crate::block_descendants::cascade_depth_saturated(&pool, "PEND26N2_OK_R")
            .await
            .unwrap();
        assert!(
            !saturated,
            "PEND-26 N2: helper must NOT report saturation on a 99-block chain"
        );

        let logs = writer.contents();
        assert!(
            !logs.contains("PEND-26 N2"),
            "PEND-26 N2: cascade_soft_delete must NOT emit the saturation \
             warn on a 99-block chain; got log buffer: {logs}",
        );
    }
}
