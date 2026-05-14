//! Soft-delete: `soft_delete_block`, `cascade_soft_delete`.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};

/// Soft-delete a single block (no cascade).
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
/// Recursive member filters `deleted_at IS NULL` so already-deleted
/// subtrees keep their original tombstone timestamp. `depth < 100`
/// bounds the walk against runaway recursion on corrupted parent_id
/// chains.
///
/// Canonical CTE in `crate::block_descendants::DESCENDANTS_CTE_ACTIVE`.
/// This site inlines the SQL because `sqlx::query!` requires a string
/// literal and cannot accept `concat!()` of a `macro_rules!` expansion.
///
/// L-101: Emits `tracing::debug!` at entry and `tracing::info!` after
/// the cascade UPDATE so a user-reported "I lost a tree of blocks"
/// triage has a log record of the seed block_id, the cascade size, and
/// the timestamp.
///
/// SQL-review M-3: takes `materializer: &Materializer` so the cache-
/// invalidation fan-out is enforced by the type system. Any caller of
/// this primitive **must** hold a `&Materializer` and post-commit the
/// fan-out fires automatically. The previous convention — callers
/// dispatch on the primitive's behalf — was a hidden coupling: a future
/// caller that forgot the dispatch would leave caches stale (pages_cache,
/// agenda_cache, block_tag_refs, etc.) silently. The dispatched task
/// set mirrors what `materializer::dispatch::invalidations_for_op`
/// produces for a `delete_block` op (FULL_CACHE_REBUILD_TASKS +
/// `RemoveFtsBlock`).
pub async fn cascade_soft_delete(
    pool: &SqlitePool,
    materializer: &Materializer,
    _device_id: &str,
    block_id: &str,
) -> Result<(String, u64), AppError> {
    tracing::debug!(seed_block_id = %block_id, "cascade soft-delete starting");
    let now = crate::now_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let result = sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND d.depth < 100 \
         ) \
         UPDATE blocks SET deleted_at = ? \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at IS NULL",
        block_id,
        now,
    )
    .execute(&mut *tx)
    .await?;

    // PEND-26 N2: warn when the cascade walk hit the depth-100 cap so an
    // operator has a breadcrumb if a pathological tree silently truncated
    // the soft-delete. The cap (invariant #9) is preserved; we only ADD
    // detection + surfacing here. The standard-variant helper is
    // invariant to whether the cascade has run, so this works post-UPDATE.
    if crate::block_descendants::cascade_depth_saturated(&mut *tx, block_id).await? {
        tracing::warn!(
            seed_block_id = %block_id,
            op = "cascade_soft_delete",
            "PEND-26 N2: cascade-depth cap reached (>=99 levels); descendants \
             below depth 100 were not soft-deleted. Tree is pathologically deep.",
        );
    }

    let count = result.rows_affected();
    tx.commit().await?;
    tracing::info!(
        seed_block_id = %block_id,
        descendants_marked = count,
        deleted_at = %now,
        "cascade soft-delete"
    );

    // SQL-review M-3: dispatch the same cache-rebuild fan-out that the
    // `delete_block` op-type dispatch would produce (see
    // `materializer::dispatch::invalidations_for_op`). The fan-out is
    // fire-and-forget; enqueue failures (queue full, queue closed) are
    // logged at warn level because the SQL write has already been
    // durably committed and the next mutation re-dispatches the same
    // tasks.
    dispatch_cache_rebuild_after_soft_delete(materializer, block_id);

    Ok((now, count))
}

/// Enqueue the cache-rebuild fan-out for a `cascade_soft_delete`.
///
/// Mirrors the `delete_block` arm of
/// [`crate::materializer::dispatch::invalidations_for_op`]:
/// FULL_CACHE_REBUILD_TASKS (RebuildTagsCache, RebuildPagesCache,
/// RebuildAgendaCache, RebuildProjectedAgendaCache,
/// RebuildTagInheritanceCache, RebuildPageIds, RebuildBlockTagRefsCache)
/// followed by `RemoveFtsBlock { block_id }`.
///
/// Enqueue failures are logged at warn level — the SQL is already
/// committed and the next mutation re-dispatches the same fan-out.
fn dispatch_cache_rebuild_after_soft_delete(materializer: &Materializer, block_id: &str) {
    let tasks = [
        MaterializeTask::RebuildTagsCache,
        MaterializeTask::RebuildPagesCache,
        MaterializeTask::RebuildAgendaCache,
        MaterializeTask::RebuildProjectedAgendaCache,
        MaterializeTask::RebuildTagInheritanceCache,
        MaterializeTask::RebuildPageIds,
        MaterializeTask::RebuildBlockTagRefsCache,
        MaterializeTask::RemoveFtsBlock {
            block_id: Arc::from(block_id),
        },
    ];
    for task in tasks {
        if let Err(e) = materializer.try_enqueue_background(task) {
            tracing::warn!(
                seed_block_id = %block_id,
                error = %e,
                "cascade_soft_delete: failed to enqueue background cache task",
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    /// SQL-review M-3 regression: `cascade_soft_delete` MUST dispatch
    /// the cache-rebuild fan-out itself so the type system enforces it
    /// (no caller-by-caller convention).
    ///
    /// Strategy:
    /// 1. Seed a `page` block that lands in `pages_cache` after the
    ///    materializer's `RebuildPagesCache` task runs.
    /// 2. Drive a baseline `RebuildPagesCache` so `pages_cache` is
    ///    populated with the live page.
    /// 3. Soft-delete the page via `cascade_soft_delete(pool, &mat, …)`.
    /// 4. `flush_background()` on the materializer so the dispatched
    ///    fan-out (which includes `RebuildPagesCache`) drains.
    /// 5. Assert `pages_cache` no longer holds the soft-deleted row.
    ///    The only way `pages_cache` reflects the soft-delete is if
    ///    `cascade_soft_delete` itself dispatched the rebuild — the
    ///    test caller does NOT touch the materializer between the
    ///    cascade and the assertion.
    ///
    /// If a future contributor removes the dispatch from
    /// `cascade_soft_delete`, `pages_cache` will still contain the
    /// soft-deleted page and this assertion fails.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cascade_soft_delete_dispatches_materializer() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        // Seed a page block.
        let page_id = "M3PAGE01";
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'page', 'cascade dispatch test', NULL, 1)",
        )
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();

        // Baseline: populate `pages_cache` so the soft-delete removal
        // is observable (vs starting from an empty cache).
        crate::cache::rebuild_pages_cache(&pool).await.unwrap();
        let pre_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache WHERE page_id = ?")
                .bind(page_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            pre_count, 1,
            "baseline: pages_cache must contain the seeded page before soft-delete"
        );

        // Soft-delete via the primitive. The function dispatches the
        // cache-rebuild fan-out itself (SQL-review M-3).
        let (_ts, count) = cascade_soft_delete(&pool, &mat, "m3-test-device", page_id)
            .await
            .unwrap();
        assert_eq!(count, 1, "cascade must mark exactly the seeded page");

        // Drain the background queue so the dispatched
        // `RebuildPagesCache` task runs to completion.
        mat.flush_background().await.unwrap();

        // The dispatched rebuild must have rebuilt `pages_cache` from
        // `blocks WHERE deleted_at IS NULL`, removing the soft-deleted
        // page. If `cascade_soft_delete` failed to dispatch, this row
        // would still be present.
        let post_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache WHERE page_id = ?")
                .bind(page_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            post_count, 0,
            "SQL-review M-3: pages_cache must reflect the soft-delete after \
             flush_background — proving cascade_soft_delete dispatched \
             RebuildPagesCache itself (no caller dispatched on its behalf)."
        );
    }
}
