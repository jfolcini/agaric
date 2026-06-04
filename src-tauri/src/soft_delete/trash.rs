//! Soft-delete: `soft_delete_block`, `cascade_soft_delete`.

use sqlx::SqlitePool;

use crate::db::CommandTx;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op_log::OpRecord;

/// Soft-delete a single block (no cascade).
pub async fn soft_delete_block(pool: &SqlitePool, block_id: &str) -> Result<Option<i64>, AppError> {
    let now = crate::db::now_ms();
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
/// **Currently exercised only by tests.** As of #386 this primitive has
/// no non-test callers — the production delete path is
/// `commands::blocks::crud::delete_block_inner` (which uses the
/// `descendants_cte_active!()` macro directly), and every call site of
/// `cascade_soft_delete` lives in a `#[cfg(test)]` module. The
/// `&Materializer` / op-dispatch contract documented below describes the
/// behaviour those tests assert and the shape a future production caller
/// would inherit; it is not, today, a load-bearing production path.
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
/// agenda_cache, block_tag_refs, etc.) silently. The fan-out is routed
/// through the canonical `delete_block` op-type dispatch (a synthesized
/// minimal [`OpRecord`] enqueued on the [`CommandTx`]), so the dispatched
/// task set is *exactly* what `materializer::dispatch::invalidations_for_op`
/// produces for a `delete_block` op (FULL_CACHE_REBUILD_TASKS, incl.
/// `RebuildPageLinkCache`, + `RemoveFtsBlock`) and can never drift from
/// it. See [`synthesize_delete_op`].
pub async fn cascade_soft_delete(
    pool: &SqlitePool,
    materializer: &Materializer,
    _device_id: &str,
    block_id: &str,
) -> Result<(i64, u64), AppError> {
    tracing::debug!(seed_block_id = %block_id, "cascade soft-delete starting");
    let now = crate::db::now_ms();
    // MAINT-112: `CommandTx::begin_immediate` inherits the slow-acquire
    // tracing from `begin_immediate_logged` AND couples commit +
    // post-commit cache dispatch (see the synthesized `delete_block` op
    // enqueued below).
    let mut tx = CommandTx::begin_immediate(pool, "soft_delete_cascade").await?;

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
    .execute(&mut **tx)
    .await?;

    // PEND-26 N2: warn when the cascade walk hit the depth-100 cap so an
    // operator has a breadcrumb if a pathological tree silently truncated
    // the soft-delete. The cap (invariant #9) is preserved; we only ADD
    // detection + surfacing here. The standard-variant helper is
    // invariant to whether the cascade has run, so this works post-UPDATE.
    if crate::block_descendants::cascade_depth_saturated(&mut **tx, block_id).await? {
        tracing::warn!(
            seed_block_id = %block_id,
            op = "cascade_soft_delete",
            "PEND-26 N2: cascade-depth cap reached (>=99 levels); descendants \
             below depth 100 were not soft-deleted. Tree is pathologically deep.",
        );
    }

    let count = result.rows_affected();

    // SQL-review M-3 + MAINT-112: route the cache-rebuild fan-out through
    // the canonical `delete_block` op-type dispatch. Enqueueing a
    // synthesized minimal `OpRecord` on the `CommandTx` means
    // `commit_and_dispatch` fires *exactly* the task set
    // `invalidations_for_op` produces for a `delete_block` op
    // (FULL_CACHE_REBUILD_TASKS, incl. `RebuildPageLinkCache`, +
    // `RemoveFtsBlock`) — the set can never drift from the dispatch
    // table. Dispatch is fire-and-forget; enqueue failures are
    // warn-logged inside `commit_and_dispatch` because the SQL write has
    // already been durably committed.
    tx.enqueue_background(synthesize_delete_op(block_id));
    tx.commit_and_dispatch(materializer).await?;
    tracing::info!(
        seed_block_id = %block_id,
        descendants_marked = count,
        deleted_at = %now,
        "cascade soft-delete"
    );

    Ok((now, count))
}

/// Build a minimal `delete_block` [`OpRecord`] purely to drive the
/// canonical cache-rebuild fan-out via
/// [`crate::materializer::dispatch::invalidations_for_op`].
///
/// MAINT-112 / decision-b: this primitive is *not* a command — it does
/// not append to `op_log`, so it has no real `OpRecord`. The
/// `delete_block` arm of `invalidations_for_op` reads **only**
/// `record.op_type` and `record.block_id` (it ignores `seq`, `hash`,
/// `payload`, `device_id`, …), so every other field is a harmless
/// placeholder. Routing through this synthesized record (rather than a
/// hand-maintained task array) guarantees the dispatched set stays
/// identical to the dispatch table — including `RebuildPageLinkCache`
/// and any cache appended to `FULL_CACHE_REBUILD_TASKS` in the future.
fn synthesize_delete_op(block_id: &str) -> OpRecord {
    OpRecord {
        device_id: String::new(),
        seq: 0,
        parent_seqs: None,
        hash: String::new(),
        op_type: "delete_block".to_owned(),
        payload: String::new(),
        created_at: 0,
        block_id: Some(block_id.to_owned()),
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
    ///
    /// MAINT-112: also asserts a stale `page_link_cache` row was rebuilt
    /// away — proving `cascade_soft_delete` dispatched
    /// `RebuildPageLinkCache` (the 8th task in `FULL_CACHE_REBUILD_TASKS`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cascade_soft_delete_dispatches_materializer() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        // Seed a page block.
        let page_id = "M3PAGE01";
        let link_page_id = "M3PAGE02";
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'page', 'cascade dispatch test', NULL, 1)",
        )
        .bind(page_id)
        .execute(&pool)
        .await
        .unwrap();
        // A second live page so the stale `page_link_cache` row below has
        // valid source/target FKs that survive the soft-delete (only
        // `page_id` is deleted), isolating the assertion to the rebuild.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'page', 'cascade link page', NULL, 2)",
        )
        .bind(link_page_id)
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

        // MAINT-112: plant a stale `page_link_cache` edge with no backing
        // `block_links` row. `RebuildPageLinkCache` does a full
        // DELETE-all + re-INSERT-from-`block_links`, so after the fan-out
        // drains this edge must be gone (no `block_links` to re-derive
        // it). If `RebuildPageLinkCache` is NOT dispatched, the stale
        // edge survives and the assertion below fails. Source/target are
        // the *second* live page so the FK rows aren't soft-deleted.
        sqlx::query(
            "INSERT INTO page_link_cache (source_page_id, target_page_id, edge_count) \
             VALUES (?, ?, 99)",
        )
        .bind(link_page_id)
        .bind(link_page_id)
        .execute(&pool)
        .await
        .unwrap();

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

        // MAINT-112: the stale page-link edge must be gone, proving
        // `RebuildPageLinkCache` was in the dispatched fan-out.
        let stale_links: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM page_link_cache WHERE source_page_id = ? AND target_page_id = ?",
        )
        .bind(link_page_id)
        .bind(link_page_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            stale_links, 0,
            "MAINT-112: page_link_cache must reflect the soft-delete after \
             flush_background — proving cascade_soft_delete dispatched \
             RebuildPageLinkCache (the 8th FULL_CACHE_REBUILD task)."
        );
    }
}
