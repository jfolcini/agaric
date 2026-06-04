//! Restore: `restore_block`.

use sqlx::SqlitePool;

use crate::db::CommandTx;
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::op_log::OpRecord;

/// Restore a soft-deleted block and descendants sharing the same `deleted_at`
/// timestamp.
///
/// **Currently exercised only by tests.** As of #386 this primitive has
/// no non-test callers — the production restore paths are
/// `loro::engine::apply_restore_block` /
/// `materializer::handlers::project_restore_block_to_sql`, and every call
/// site of `soft_delete::restore_block` lives in a `#[cfg(test)]` module.
/// The `&Materializer` / op-dispatch contract documented below describes
/// the behaviour those tests assert; it is not, today, a load-bearing
/// production path.
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
/// fan-out fires automatically. The fan-out is routed through the
/// canonical `restore_block` op-type dispatch (a synthesized minimal
/// [`OpRecord`] enqueued on the [`CommandTx`]), so the dispatched task
/// set is *exactly* what `materializer::dispatch::invalidations_for_op`
/// produces for a `restore_block` op (FULL_CACHE_REBUILD_TASKS, incl.
/// `RebuildPageLinkCache`, + `UpdateFtsBlock`) and can never drift from
/// it. See [`synthesize_restore_op`].
pub async fn restore_block(
    pool: &SqlitePool,
    materializer: &Materializer,
    block_id: &str,
    deleted_at_ref: i64,
) -> Result<u64, AppError> {
    // L-107: IMMEDIATE is intentional. The recursive-CTE traversal walks the
    // same `blocks` rows that `cascade_soft_delete` may be writing concurrently
    // (it also uses BEGIN IMMEDIATE). Acquiring the reserved lock up-front
    // serializes restore against cascade-soft-delete writers and prevents the
    // CTE from reading a half-cascaded subtree.
    //
    // MAINT-112: `CommandTx::begin_immediate` inherits the slow-acquire
    // tracing from `begin_immediate_logged` AND couples commit +
    // post-commit cache dispatch (see the synthesized `restore_block`
    // op enqueued below).
    let mut tx = CommandTx::begin_immediate(pool, "soft_delete_restore_block").await?;

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
    .execute(&mut **tx)
    .await?;

    // PEND-26 N2: warn when the cascade walk hit the depth-100 cap so an
    // operator has a breadcrumb if a pathological tree silently truncated
    // the restore. The cap (invariant #9) is preserved; we only ADD
    // detection + surfacing here. Standard-variant helper is invariant
    // to deleted_at state, so post-cascade it walks the now-restored
    // subtree and reports MAX depth correctly.
    if crate::block_descendants::cascade_depth_saturated(&mut **tx, block_id).await? {
        tracing::warn!(
            block_id = %block_id,
            op = "restore_block",
            "PEND-26 N2: cascade-depth cap reached (>=99 levels); descendants \
             below depth 100 were not restored. Tree is pathologically deep.",
        );
    }

    // SQL-review M-3 + MAINT-112: route the cache-rebuild fan-out through
    // the canonical `restore_block` op-type dispatch. Enqueueing a
    // synthesized minimal `OpRecord` on the `CommandTx` means
    // `commit_and_dispatch` fires *exactly* the task set
    // `invalidations_for_op` produces for a `restore_block` op
    // (FULL_CACHE_REBUILD_TASKS, incl. `RebuildPageLinkCache`, +
    // `UpdateFtsBlock`) — the set can never drift from the dispatch
    // table. Dispatch is fire-and-forget; enqueue failures are
    // warn-logged inside `commit_and_dispatch` because the SQL is
    // already committed.
    tx.enqueue_background(synthesize_restore_op(block_id));
    tx.commit_and_dispatch(materializer).await?;

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

    Ok(rows)
}

/// Build a minimal `restore_block` [`OpRecord`] purely to drive the
/// canonical cache-rebuild fan-out via
/// [`crate::materializer::dispatch::invalidations_for_op`].
///
/// MAINT-112 / decision-b: this primitive is *not* a command — it does
/// not append to `op_log`, so it has no real `OpRecord`. The
/// `restore_block` arm of `invalidations_for_op` reads **only**
/// `record.op_type` and `record.block_id` (it ignores `seq`, `hash`,
/// `payload`, `device_id`, …), so every other field is a harmless
/// placeholder. Routing through this synthesized record (rather than a
/// hand-maintained task array) guarantees the dispatched set stays
/// identical to the dispatch table — including `RebuildPageLinkCache`
/// and any cache appended to `FULL_CACHE_REBUILD_TASKS` in the future.
fn synthesize_restore_op(block_id: &str) -> OpRecord {
    OpRecord {
        device_id: String::new(),
        seq: 0,
        parent_seqs: None,
        hash: String::new(),
        op_type: "restore_block".to_owned(),
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
    /// 6. MAINT-112: assert a stale `page_link_cache` row was rebuilt
    ///    away — proving `restore_block` also dispatched
    ///    `RebuildPageLinkCache` (the 8th task in
    ///    `FULL_CACHE_REBUILD_TASKS`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn restore_block_dispatches_materializer() {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let mat = crate::materializer::Materializer::new(pool.clone());

        let page_id = "M3RPAGE01";
        let other_id = "M3RPAGE02";
        let deleted_ts: i64 = 1_735_689_600_000;

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
        // A live second page so the stale `page_link_cache` row below has
        // a valid `target_page_id` FK.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'page', 'restore link target', NULL, 2)",
        )
        .bind(other_id)
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

        // MAINT-112: plant a stale `page_link_cache` edge with no backing
        // `block_links` row. `RebuildPageLinkCache` does a full
        // DELETE-all + re-INSERT-from-`block_links`, so after the fan-out
        // drains this edge must be gone (there are no `block_links` to
        // re-derive it from). If `RebuildPageLinkCache` is NOT dispatched,
        // the stale edge survives and the assertion below fails.
        sqlx::query(
            "INSERT INTO page_link_cache (source_page_id, target_page_id, edge_count) \
             VALUES (?, ?, 99)",
        )
        .bind(page_id)
        .bind(other_id)
        .execute(&pool)
        .await
        .unwrap();

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

        // MAINT-112: the stale page-link edge must be gone, proving
        // `RebuildPageLinkCache` was in the dispatched fan-out.
        let stale_links: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM page_link_cache WHERE source_page_id = ? AND target_page_id = ?",
        )
        .bind(page_id)
        .bind(other_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            stale_links, 0,
            "MAINT-112: page_link_cache must reflect the restore after \
             flush_background — proving restore_block dispatched \
             RebuildPageLinkCache (the 8th FULL_CACHE_REBUILD task)."
        );
    }
}
