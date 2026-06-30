//! `page_link_cache` — derived-state cache for page-level link edges
//! (SQL-review §H-2).
//!
//! Each row holds a `(source_page_id, target_page_id, edge_count)`
//! tuple: the number of distinct `block_links` rows whose source rolls
//! up to `source_page_id` (via `blocks.page_id` — the denormalised
//! owning page, which is the source's own id when the source IS a page)
//! and whose target is `target_page_id`.
//!
//! SQL/C9 (#345): the roll-up prefers `blocks.page_id` over
//! `blocks.parent_id` — `COALESCE(page_id, parent_id, id)`. `parent_id`
//! is the *immediate* parent, so a link inside a block nested
//! two-or-more levels under a page was mis-attributed to the intermediate
//! block instead of the owning page. `page_id` (migration 0027/0066) is
//! the nearest page ancestor — self for page blocks. The `parent_id`
//! fallback preserves the prior single-step roll-up for rows where
//! `page_id` was never stamped (test fixtures / partial state); the final
//! `id` fallback covers top-level tags with neither.
//!
//! The read path (`list_page_links_inner`) selects from this table as a
//! single covering-index scan, replacing the previous 3-JOIN superlinear
//! `block_links × blocks × block_properties` shape that measured
//! ~1.3 s @ 100K in the interactive SLO bench. #2070 denormalised the
//! `deleted_at` / `block_type = 'page'` predicates into the
//! `src_deleted` / `tgt_deleted` / `tgt_is_page` flag columns (migration
//! 0096) so the unscoped read no longer needs even the two residual
//! `blocks` joins it carried after 0065.
//!
//! Two public entry points:
//!
//! - [`reindex_page_link_cache_for_block`] — called from the
//!   `ReindexBlockLinks` materializer handler after the per-block
//!   `block_links` diff has been written. Recomputes only the
//!   `(source_page, target_page)` pairs touched by the changed block
//!   (the block's own page + every page it currently and previously
//!   linked to), so the cost is proportional to the diff width, not
//!   the table size.
//!
//! - [`rebuild_page_link_cache`] — full recompute that walks every
//!   `block_links` row, rolls up the source to a page via
//!   `COALESCE(blocks.page_id, parent_id, source_id)`, groups by
//!   `(source_page, target_page)`, and DELETE + INSERTs the whole
//!   table. Used by snapshot restore, the boot-time "table is empty"
//!   fallback, and the delete/restore/purge FULL_CACHE_REBUILD_TASKS
//!   fan-out.
//!
//! The static-literal queries here use the compile-checked `query!` /
//! `query_as!` macros (#235), validated against the `.sqlx` offline cache.
//! The dynamic chunked upserts (variable `json_each`/placeholder counts)
//! remain runtime-checked [`sqlx::query`] via `AssertSqlSafe`, since the
//! macros require a single string literal. The schema-existence check
//! happens via the migration smoke test in
//! `op_log::tests::page_link_cache_table_post_migration_0065`.

use sqlx::SqlitePool;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

/// `page_link_cache` has 6 columns per row since #2070 denormalised the
/// `src_deleted` / `tgt_deleted` / `tgt_is_page` predicate flags
/// (migration 0096) → `MAX_SQL_PARAMS / 6 = 166` rows per chunk. Mirrors
/// the chunk-size derivation in `cache/pages.rs` and `cache/agenda.rs`.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 6; // 166

// ---------------------------------------------------------------------------
// Per-block incremental update
// ---------------------------------------------------------------------------

/// Recompute the `page_link_cache` rows whose `(source_page, target_page)`
/// pair could have been touched by a `ReindexBlockLinks(block_id)` task.
///
/// Called from `materializer::handlers::handle_background_task` AFTER
/// the `block_links` diff for `block_id` has been written so the
/// recompute sees the canonical `block_links` state.
///
/// Algorithm:
///   1. Resolve `source_page = COALESCE(page_id, parent_id, block_id)`
///      for `block_id`. If the block itself is a page, `page_id = id` so
///      `source_page = block_id`. If `block_id` is gone (purged),
///      `source_page` falls through to `block_id` and the recompute
///      naturally drops empty pairs.
///   2. Collect every distinct `target_page` that currently appears in
///      `block_links` under `source_id = block_id` OR rolls up to
///      `source_page` AND every `target_page` that previously appeared in
///      `page_link_cache` under `source_page_id = source_page` (so we pick
///      up edges that just dropped to zero).
///   3. For each `(source_page, target_page)` pair in the union, recompute
///      `edge_count = COUNT(*) FROM block_links bl JOIN blocks sb
///       ON sb.id = bl.source_id AND COALESCE(sb.page_id, sb.parent_id, sb.id) =
///       source_page WHERE bl.target_id = target_page`. UPSERT non-zero
///      counts; DELETE zero counts.
///
/// Single transaction so the cache and `block_links` stay coherent under
/// concurrent reads — `list_page_links_inner` joining `blocks` and
/// `page_link_cache` either observes the pre-update snapshot or the
/// post-update one, never a mid-update split state.
///
/// Cross-space isolation is inherited transitively: `block_links` is
/// Already filtered to same-space pairs by `reindex_block_links` (
/// Phase 3 guard at the write-time gate), so a roll-up over `block_links`
/// cannot manufacture a cross-space `page_link_cache` row.
pub async fn reindex_page_link_cache_for_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_page_links_reindex").await?;

    // Resolve the source page (the page the changed block lives on).
    // SQL/C9 (#345): prefer `page_id` (the denormalised owning page, set
    // by migration 0027/0066) over `parent_id` (the immediate parent).
    // For a content block nested several levels under a page, `parent_id`
    // is the intermediate block, not the page — keying edges by it
    // mis-attributes the link. `page_id` is the nearest page ancestor and
    // is `id` for page blocks. The `parent_id` fallback covers fixtures /
    // partial-state rows where `page_id` was not stamped (preserving the
    // pre-fix single-step roll-up), and the final `block_id` fallback
    // covers top-level tags (no parent, no page) and purged blocks.
    //
    // This `COALESCE(page_id, parent_id, id)` chain MUST stay identical to
    // the SQL roll-up below and in the full-rebuild query so the
    // Rust-resolved `source_page` matches what the SQL groups under.
    let source_page: String = match sqlx::query!(
        "SELECT page_id, parent_id FROM blocks WHERE id = ?",
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(r) => r
            .page_id
            .or(r.parent_id)
            .unwrap_or_else(|| block_id.to_owned()),
        // Block missing (purged). Fall back to block_id so the
        // recompute can still drop stale rows keyed under that id.
        None => block_id.to_owned(),
    };

    // Pairs touched: every target that currently appears in block_links
    // under any block whose roll-up == source_page, UNION every target
    // already in page_link_cache under source_page. This catches both
    // additions (new target appears in block_links) and removals (target
    // previously cached, now zero edges left). Soft-deleted source
    // blocks contribute zero to the count — mirrors the legacy
    // `JOIN blocks sb ON ... AND sb.deleted_at IS NULL` filter.
    let touched_targets: Vec<String> = sqlx::query!(
        "SELECT target_id AS \"target_id!\" FROM (
             SELECT DISTINCT bl.target_id
             FROM block_links bl
             JOIN blocks sb ON sb.id = bl.source_id
             WHERE COALESCE(sb.page_id, sb.parent_id, sb.id) = ?1
               AND sb.deleted_at IS NULL
             UNION
             SELECT target_page_id AS target_id
             FROM page_link_cache
             WHERE source_page_id = ?1
         )",
        source_page,
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|row| row.target_id)
    .collect();

    // B-C3 (issue #108): collapse the per-target COUNT + UPSERT/DELETE
    // loop into two statements regardless of K. The aggregate UPSERT
    // covers every touched target with a non-zero edge_count; targets
    // that no longer have any live edges don't appear in the GROUP BY
    // result and fall through to the zero-edge DELETE below. Net cost:
    // 2 round-trips instead of 2K, no Rust-side counting.
    if touched_targets.is_empty() {
        tx.commit().await?;
        return Ok(());
    }
    let targets_json = serde_json::to_string(&touched_targets)?;

    // #2070: also compute and write the denormalised predicate flags so
    // an incremental upsert never resurrects a row with stale default
    // flags. `src_deleted` is the soft-delete state of the source PAGE
    // (`?1`), looked up once; `tgt_deleted` / `tgt_is_page` come from the
    // target block joined per row. The `DO UPDATE SET` refreshes all
    // three alongside `edge_count`. `MAX`/`MIN` just satisfy the GROUP BY
    // (the flags are constant per target group).
    sqlx::query!(
        "WITH desired AS ( \
             SELECT bl.target_id AS target, \
                    COUNT(*) AS edge_count, \
                    MAX(tb.deleted_at IS NOT NULL) AS tgt_deleted, \
                    MIN(tb.block_type = 'page') AS tgt_is_page \
             FROM block_links bl \
             JOIN blocks sb ON sb.id = bl.source_id \
             JOIN blocks tb ON tb.id = bl.target_id \
             WHERE COALESCE(sb.page_id, sb.parent_id, sb.id) = ?1 \
               AND sb.deleted_at IS NULL \
               AND bl.target_id IN (SELECT value FROM json_each(?2)) \
             GROUP BY 1 \
         ) \
         INSERT INTO page_link_cache \
             (source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, tgt_is_page) \
         SELECT ?1, target, edge_count, \
                COALESCE((SELECT (b.deleted_at IS NOT NULL) FROM blocks b WHERE b.id = ?1), 1), \
                tgt_deleted, tgt_is_page \
         FROM desired WHERE true \
         ON CONFLICT(source_page_id, target_page_id) \
         DO UPDATE SET edge_count = excluded.edge_count, \
                       src_deleted = excluded.src_deleted, \
                       tgt_deleted = excluded.tgt_deleted, \
                       tgt_is_page = excluded.tgt_is_page",
        source_page,
        targets_json,
    )
    .execute(&mut *tx)
    .await?;

    // Zero-edge sweep: remove any touched target whose live edge count
    // is now zero. Inlined `NOT EXISTS` against `block_links` mirrors
    // the `desired` CTE's filter shape — using the CTE directly is not
    // an option here because CTEs don't outlive their statement.
    sqlx::query!(
        "DELETE FROM page_link_cache \
         WHERE source_page_id = ?1 \
           AND target_page_id IN (SELECT value FROM json_each(?2)) \
           AND NOT EXISTS ( \
               SELECT 1 FROM block_links bl \
               JOIN blocks sb ON sb.id = bl.source_id \
               WHERE COALESCE(sb.page_id, sb.parent_id, sb.id) = ?1 \
                 AND sb.deleted_at IS NULL \
                 AND bl.target_id = page_link_cache.target_page_id \
           )",
        source_page,
        targets_json,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Full recompute
// ---------------------------------------------------------------------------

/// Full recompute of `page_link_cache`.
///
/// Deletes all existing rows and re-populates by rolling up
/// `block_links` to the page level. Used by:
///
/// - snapshot restore (`apply_snapshot`),
/// - boot-time "table is empty" fallback (`recovery`),
/// - the delete/restore/purge `FULL_CACHE_REBUILD_TASKS` fan-out.
///
/// Per-content-edit invalidation goes through
/// [`reindex_page_link_cache_for_block`] from
/// `materializer::handlers::handle_background_task::ReindexBlockLinks`.
#[tracing::instrument(skip(pool), err)]
pub async fn rebuild_page_link_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("page_links", || rebuild_page_link_cache_impl(pool)).await
}

async fn rebuild_page_link_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_page_links_rebuild").await?;

    sqlx::query!("DELETE FROM page_link_cache")
        .execute(&mut *tx)
        .await?;

    // Materialise the rolled-up edge set into Rust memory then chunk
    // the INSERTs to respect `MAX_SQL_PARAMS`. The roll-up walks
    // `block_links` (~200K rows at 100K-block scale) joined with
    // `blocks` on the source side to read `parent_id`; output cardinality
    // is bounded by `min(distinct sources, distinct targets) ≤ #pages`,
    // typically a few thousand rows on a 100K-block vault.
    //
    // #2070 parity design: keep the legacy `WHERE sb.deleted_at IS NULL`
    // so `edge_count` counts only LIVE source blocks (a deleted source
    // block must not inflate the count — matches the legacy rebuild and
    // the incremental path). We denormalise the three READ-side
    // predicates as flags by also joining `blocks` for the target:
    //   - `src_deleted` is the source PAGE's delete state (the group
    //     key), NOT an aggregate over source blocks — mirroring the
    //     legacy read's `JOIN blocks src ON src.id = source_page_id AND
    //     src.deleted_at IS NULL`. It comes from the `LEFT JOIN blocks
    //     sp` on the rolled-up page id; a missing/purged source page
    //     (`sp.id IS NULL`) maps to deleted (`CASE WHEN sp.id IS NULL
    //     THEN 1 …`) so a dangling page reference is masked exactly like
    //     the legacy inner join and the incremental path drop it. So a
    //     page mid-cascade (deleted page, still-live block) is correctly
    //     masked even though its block survives the `deleted_at IS NULL`
    //     filter; a fully-deleted page produces no row at all (its blocks
    //     are filtered out), same as legacy. The page state is constant
    //     per `(source_page)` group, so the wrapping `MAX` is identity
    //     (just satisfies the GROUP BY aggregate requirement).
    //   - `tgt_deleted` / `tgt_is_page` come from the target block
    //     (`target_page_id = bl.target_id` is a single block, so the
    //     `MAX`/`MIN` are identity per group).
    let rows: Vec<(String, String, i64, i64, i64, i64)> = sqlx::query!(
        "SELECT
             COALESCE(sb.page_id, sb.parent_id, bl.source_id) AS \"source_page_id!: String\",
             bl.target_id AS \"target_page_id!: String\",
             COUNT(*) AS \"edge_count!: i64\",
             MAX(CASE WHEN sp.id IS NULL THEN 1 ELSE (sp.deleted_at IS NOT NULL) END) AS \"src_deleted!: i64\",
             MAX(tb.deleted_at IS NOT NULL) AS \"tgt_deleted!: i64\",
             MIN(tb.block_type = 'page') AS \"tgt_is_page!: i64\"
         FROM block_links bl
         JOIN blocks sb ON sb.id = bl.source_id
         JOIN blocks tb ON tb.id = bl.target_id
         LEFT JOIN blocks sp ON sp.id = COALESCE(sb.page_id, sb.parent_id, bl.source_id)
         WHERE sb.deleted_at IS NULL
         GROUP BY 1, 2",
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|r| {
        (
            r.source_page_id,
            r.target_page_id,
            r.edge_count,
            r.src_deleted,
            r.tgt_deleted,
            r.tgt_is_page,
        )
    })
    .collect();

    let mut inserted: u64 = 0;
    for chunk in rows.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO page_link_cache \
             (source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, tgt_is_page) \
             VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for (src, tgt, count, src_del, tgt_del, tgt_page) in chunk {
            q = q
                .bind(src)
                .bind(tgt)
                .bind(count)
                .bind(src_del)
                .bind(tgt_del)
                .bind(tgt_page);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }

    tx.commit().await?;
    Ok(inserted)
}

/// Read/write split variant of [`rebuild_page_link_cache`].
///
/// Reads the rolled-up edge set from `read_pool` and applies the
/// DELETE + chunked INSERT on `write_pool`. Same stale-while-revalidate
/// semantics as the other `rebuild_*_split` variants.
pub async fn rebuild_page_link_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("page_links", || {
        rebuild_page_link_cache_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_page_link_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // #2070 parity design (see `rebuild_page_link_cache_impl`): keep the
    // legacy `WHERE sb.deleted_at IS NULL` so `edge_count` counts only
    // live source blocks, and denormalise the read-side predicates as
    // flags. `src_deleted` is the source PAGE's delete state (group key,
    // via the `LEFT JOIN blocks sp` on the rolled-up page id), NOT a
    // source-block aggregate; `tgt_deleted` / `tgt_is_page` come from the
    // single target block.
    // The `MAX`/`MIN` aggregates are identity per group, present only to
    // satisfy the GROUP BY.
    let rows: Vec<(String, String, i64, i64, i64, i64)> = sqlx::query!(
        "SELECT
             COALESCE(sb.page_id, sb.parent_id, bl.source_id) AS \"source_page_id!: String\",
             bl.target_id AS \"target_page_id!: String\",
             COUNT(*) AS \"edge_count!: i64\",
             MAX(CASE WHEN sp.id IS NULL THEN 1 ELSE (sp.deleted_at IS NOT NULL) END) AS \"src_deleted!: i64\",
             MAX(tb.deleted_at IS NOT NULL) AS \"tgt_deleted!: i64\",
             MIN(tb.block_type = 'page') AS \"tgt_is_page!: i64\"
         FROM block_links bl
         JOIN blocks sb ON sb.id = bl.source_id
         JOIN blocks tb ON tb.id = bl.target_id
         LEFT JOIN blocks sp ON sp.id = COALESCE(sb.page_id, sb.parent_id, bl.source_id)
         WHERE sb.deleted_at IS NULL
         GROUP BY 1, 2",
    )
    .fetch_all(read_pool)
    .await?
    .into_iter()
    .map(|r| {
        (
            r.source_page_id,
            r.target_page_id,
            r.edge_count,
            r.src_deleted,
            r.tgt_deleted,
            r.tgt_is_page,
        )
    })
    .collect();

    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_page_links_rebuild_write").await?;

    sqlx::query!("DELETE FROM page_link_cache")
        .execute(&mut *tx)
        .await?;

    let mut inserted: u64 = 0;
    for chunk in rows.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO page_link_cache \
             (source_page_id, target_page_id, edge_count, src_deleted, tgt_deleted, tgt_is_page) \
             VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for (src, tgt, count, src_del, tgt_del, tgt_page) in chunk {
            q = q
                .bind(src)
                .bind(tgt)
                .bind(count)
                .bind(src_del)
                .bind(tgt_del)
                .bind(tgt_page);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }

    tx.commit().await?;
    Ok(inserted)
}
