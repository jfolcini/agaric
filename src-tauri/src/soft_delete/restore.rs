//! Restore: `restore_block`.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};

/// Restore a soft-deleted block and descendants sharing the same `deleted_at`
/// timestamp.
///
/// Recursive member bounds the walk with `depth < 100` (invariant
/// #9).
///
/// Canonical CTE in `crate::block_descendants::DESCENDANTS_CTE_STANDARD`.
/// This site inlines the SQL because `sqlx::query!` requires a string
/// literal and cannot accept `concat!()` of a `macro_rules!` expansion.
///
/// SQL-review M-3: takes `materializer: &Materializer` so the cache-
/// invalidation fan-out is enforced by the type system. Any caller of
/// this primitive **must** hold a `&Materializer` and post-commit the
/// fan-out fires automatically. The dispatched task set mirrors what
/// `materializer::dispatch::invalidations_for_op` produces for a
/// `restore_block` op (FULL_CACHE_REBUILD_TASKS + `UpdateFtsBlock`).
pub async fn restore_block(
    pool: &SqlitePool,
    materializer: &Materializer,
    block_id: &str,
    deleted_at_ref: &str,
) -> Result<u64, AppError> {
    // L-107: IMMEDIATE is intentional. The recursive-CTE traversal walks the
    // same `blocks` rows that `cascade_soft_delete` may be writing concurrently
    // (it also uses BEGIN IMMEDIATE). Acquiring the reserved lock up-front
    // serializes restore against cascade-soft-delete writers and prevents the
    // CTE from reading a half-cascaded subtree.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let result = sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE d.depth < 100 \
         ) \
         UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at = ?",
        block_id,
        deleted_at_ref,
    )
    .execute(&mut *tx)
    .await?;

    // PEND-26 N2: warn when the cascade walk hit the depth-100 cap so an
    // operator has a breadcrumb if a pathological tree silently truncated
    // the restore. The cap (invariant #9) is preserved; we only ADD
    // detection + surfacing here. Standard-variant helper is invariant
    // to deleted_at state, so post-cascade it walks the now-restored
    // subtree and reports MAX depth correctly.
    if crate::block_descendants::cascade_depth_saturated(&mut *tx, block_id).await? {
        tracing::warn!(
            block_id = %block_id,
            op = "restore_block",
            "PEND-26 N2: cascade-depth cap reached (>=99 levels); descendants \
             below depth 100 were not restored. Tree is pathologically deep.",
        );
    }

    tx.commit().await?;

    // L-102: a wrong-token call (stale `deleted_at_ref` from a UI undo retry,
    // a typo in an MCP call, or a bug in the caller) is a silent no-op
    // otherwise. Emit a warn breadcrumb with both identifiers so triage has
    // something to grep for. Intentionally NOT promoted to `Err` — callers
    // (e.g. undo-redo) rely on `Ok(0)` for idempotent retries.
    let rows = result.rows_affected();
    if rows == 0 {
        tracing::warn!(
            block_id = %block_id,
            deleted_at_ref = %deleted_at_ref,
            "restore_block matched no rows",
        );
    }

    // SQL-review M-3: dispatch the same cache-rebuild fan-out that the
    // `restore_block` op-type dispatch would produce (see
    // `materializer::dispatch::invalidations_for_op`). Fire-and-forget;
    // enqueue failures are warn-logged because the SQL is already
    // committed.
    dispatch_cache_rebuild_after_restore(materializer, block_id);

    Ok(rows)
}

/// Enqueue the cache-rebuild fan-out for a `restore_block`.
///
/// Mirrors the `restore_block` arm of
/// [`crate::materializer::dispatch::invalidations_for_op`]:
/// FULL_CACHE_REBUILD_TASKS (RebuildTagsCache, RebuildPagesCache,
/// RebuildAgendaCache, RebuildProjectedAgendaCache,
/// RebuildTagInheritanceCache, RebuildPageIds, RebuildBlockTagRefsCache)
/// followed by `UpdateFtsBlock { block_id }`.
///
/// Enqueue failures are logged at warn level — the SQL is already
/// committed and the next mutation re-dispatches the same fan-out.
fn dispatch_cache_rebuild_after_restore(materializer: &Materializer, block_id: &str) {
    let tasks = [
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::RebuildPagesCache,
        MaterializeTask::RebuildAgendaCache,
        MaterializeTask::RebuildProjectedAgendaCache,
        MaterializeTask::RebuildTagInheritanceCache,
        MaterializeTask::RebuildPageIds,
        MaterializeTask::RebuildBlockTagRefsCache,
        MaterializeTask::UpdateFtsBlock {
            block_id: Arc::from(block_id),
        },
    ];
    for task in tasks {
        if let Err(e) = materializer.try_enqueue_background(task) {
            tracing::warn!(
                block_id = %block_id,
                error = %e,
                "restore_block: failed to enqueue background cache task",
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    /// SQL-review M-3 regression: `restore_block` MUST dispatch the
    /// cache-rebuild fan-out itself so the type system enforces it.
    ///
    /// Strategy mirrors `cascade_soft_delete_dispatches_materializer`:
    /// 1. Seed a `page`, soft-delete it directly via SQL (NOT through
    ///    `cascade_soft_delete`, to avoid relying on its dispatch).
    /// 2. Baseline `RebuildPagesCache` confirms the soft-deleted page
    ///    is NOT in `pages_cache`.
    /// 3. Restore via `restore_block(pool, &mat, …)`.
    /// 4. `flush_background()` drains the dispatched fan-out.
    /// 5. Assert `pages_cache` now contains the restored page —
    ///    proving `restore_block` dispatched `RebuildPagesCache` itself.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_block_dispatches_materializer() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        let page_id = "M3RPAGE01";
        let deleted_ts = "2025-01-01T00:00:00+00:00";

        // Seed a soft-deleted page (deleted_at set inline so we don't
        // depend on cascade_soft_delete's dispatch in this test).
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, deleted_at) \
             VALUES (?, 'page', 'restore dispatch test', NULL, 1, ?)",
        )
        .bind(page_id)
        .bind(deleted_ts)
        .execute(&pool)
        .await
        .unwrap();

        // Baseline: `pages_cache` filters `deleted_at IS NULL`, so the
        // seed page is absent.
        crate::cache::rebuild_pages_cache(&pool).await.unwrap();
        let pre_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache WHERE page_id = ?")
                .bind(page_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            pre_count, 0,
            "baseline: pages_cache must NOT contain the soft-deleted page before restore"
        );

        // Restore. The primitive dispatches the cache-rebuild fan-out
        // itself (SQL-review M-3).
        let restored = restore_block(&pool, &mat, page_id, deleted_ts)
            .await
            .unwrap();
        assert_eq!(restored, 1, "restore must clear exactly the seeded page");

        // Drain the dispatched background queue.
        mat.flush_background().await.unwrap();

        // The dispatched rebuild must have re-populated `pages_cache`
        // from the now-active page. If `restore_block` failed to
        // dispatch, this row would still be missing.
        let post_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache WHERE page_id = ?")
                .bind(page_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            post_count, 1,
            "SQL-review M-3: pages_cache must reflect the restore after \
             flush_background — proving restore_block dispatched \
             RebuildPagesCache itself."
        );
    }
}
