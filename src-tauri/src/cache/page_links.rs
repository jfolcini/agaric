//! `page_link_cache` — derived-state cache for page-level link edges
//! (SQL-review §H-2).
//!
//! Each row holds a `(source_page_id, target_page_id, edge_count)`
//! tuple: the number of distinct `block_links` rows whose source rolls
//! up to `source_page_id` (via `blocks.parent_id` when the source is a
//! content block, or directly when the source is a page) and whose
//! target is `target_page_id`.
//!
//! The read path (`list_page_links_inner`) selects from this table
//! plus a `blocks` join on each endpoint to enforce
//! `deleted_at IS NULL`, replacing the previous 3-JOIN superlinear
//! `block_links × blocks × block_properties` shape that measured
//! ~1.3 s @ 100K in the interactive SLO bench.
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
//!   `COALESCE(parent_id, source_id)`, groups by
//!   `(source_page, target_page)`, and DELETE + INSERTs the whole
//!   table. Used by snapshot restore, the boot-time "table is empty"
//!   fallback, and the delete/restore/purge FULL_CACHE_REBUILD_TASKS
//!   fan-out.
//!
//! All queries here use runtime-checked [`sqlx::query`] / [`sqlx::query_as`]
//! rather than the compile-checked `query!` / `query_as!` macros, so the
//! migration that creates `page_link_cache` does not need to land in the
//! `.sqlx` offline cache for the crate to build. Bind parameters are
//! still typed-checked at SQLite-prepare time at first call; the
//! schema-existence check happens via the migration smoke test in
//! `op_log::tests::page_link_cache_table_post_migration_0065`.

use sqlx::SqlitePool;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

/// `page_link_cache` has 3 columns per row → `MAX_SQL_PARAMS / 3 = 333`
/// rows per chunk. Mirrors the chunk-size derivation in
/// `cache/pages.rs` and `cache/agenda.rs`.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

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
///   1. Resolve `source_page = COALESCE(blocks.parent_id, block_id)` for
///      `block_id`. If the block itself is a page, `source_page = block_id`.
///      If `block_id` is gone (purged), `source_page` falls through to
///      `block_id` and the recompute naturally drops empty pairs.
///   2. Collect every distinct `target_page` that currently appears in
///      `block_links` under `source_id = block_id` OR rolls up to
///      `source_page` AND every `target_page` that previously appeared in
///      `page_link_cache` under `source_page_id = source_page` (so we pick
///      up edges that just dropped to zero).
///   3. For each `(source_page, target_page)` pair in the union, recompute
///      `edge_count = COUNT(*) FROM block_links bl JOIN blocks sb
///       ON sb.id = bl.source_id AND COALESCE(sb.parent_id, sb.id) =
///       source_page WHERE bl.target_id = target_page`. UPSERT non-zero
///      counts; DELETE zero counts.
///
/// Single transaction so the cache and `block_links` stay coherent under
/// concurrent reads — `list_page_links_inner` joining `blocks` and
/// `page_link_cache` either observes the pre-update snapshot or the
/// post-update one, never a mid-update split state.
///
/// Cross-space isolation is inherited transitively: `block_links` is
/// already filtered to same-space pairs by `reindex_block_links` (PEND-15
/// Phase 3 guard at the write-time gate), so a roll-up over `block_links`
/// cannot manufacture a cross-space `page_link_cache` row.
pub async fn reindex_page_link_cache_for_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    // Resolve the source page (the page the changed block lives on).
    // `parent_id` is the immediate parent — for content blocks under a
    // page that is exactly the page id. For nested content blocks
    // (block under block) we still roll up to the *immediate* parent
    // because the read query in `list_page_links_inner` uses
    // `COALESCE(sb.parent_id, bl.source_id)` (single-step roll-up); we
    // mirror that exact shape here so the cache and the legacy query
    // agree byte-for-byte on what "source page" means.
    let source_page: String =
        match sqlx::query_as::<_, (Option<String>,)>("SELECT parent_id FROM blocks WHERE id = ?")
            .bind(block_id)
            .fetch_optional(&mut *tx)
            .await?
        {
            Some((Some(parent),)) => parent,
            // `parent_id IS NULL` → block is its own page (or a top-level
            // tag with no parent). Source page = block_id.
            Some((None,)) => block_id.to_owned(),
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
    let touched_targets: Vec<String> = sqlx::query_as::<_, (String,)>(
        "SELECT target_id FROM (
             SELECT DISTINCT bl.target_id
             FROM block_links bl
             JOIN blocks sb ON sb.id = bl.source_id
             WHERE COALESCE(sb.parent_id, sb.id) = ?1
               AND sb.deleted_at IS NULL
             UNION
             SELECT target_page_id AS target_id
             FROM page_link_cache
             WHERE source_page_id = ?1
         )",
    )
    .bind(&source_page)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(t,)| t)
    .collect();

    // Recompute edge counts for each touched pair. Bounded by the
    // touched-targets set (one source page → ≤ K targets, where K is
    // the page's distinct outbound page edges) so this is O(K) round
    // trips, not O(N) on the whole link table.
    for target in &touched_targets {
        let (edge_count,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM block_links bl
             JOIN blocks sb ON sb.id = bl.source_id
             WHERE COALESCE(sb.parent_id, sb.id) = ?
               AND bl.target_id = ?
               AND sb.deleted_at IS NULL",
        )
        .bind(&source_page)
        .bind(target)
        .fetch_one(&mut *tx)
        .await?;

        if edge_count == 0 {
            sqlx::query(
                "DELETE FROM page_link_cache \
                 WHERE source_page_id = ? AND target_page_id = ?",
            )
            .bind(&source_page)
            .bind(target)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(
                "INSERT INTO page_link_cache (source_page_id, target_page_id, edge_count) \
                 VALUES (?, ?, ?) \
                 ON CONFLICT(source_page_id, target_page_id) \
                 DO UPDATE SET edge_count = excluded.edge_count",
            )
            .bind(&source_page)
            .bind(target)
            .bind(edge_count)
            .execute(&mut *tx)
            .await?;
        }
    }

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
pub async fn rebuild_page_link_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("page_links", || rebuild_page_link_cache_impl(pool)).await
}

async fn rebuild_page_link_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let mut tx = pool.begin().await?;

    sqlx::query("DELETE FROM page_link_cache")
        .execute(&mut *tx)
        .await?;

    // Materialise the rolled-up edge set into Rust memory then chunk
    // the INSERTs to respect `MAX_SQL_PARAMS`. The roll-up walks
    // `block_links` (~200K rows at 100K-block scale) joined with
    // `blocks` on the source side to read `parent_id`; output cardinality
    // is bounded by `min(distinct sources, distinct targets) ≤ #pages`,
    // typically a few thousand rows on a 100K-block vault.
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT
             COALESCE(sb.parent_id, bl.source_id) AS source_page_id,
             bl.target_id AS target_page_id,
             COUNT(*) AS edge_count
         FROM block_links bl
         JOIN blocks sb ON sb.id = bl.source_id
         WHERE sb.deleted_at IS NULL
         GROUP BY 1, 2",
    )
    .fetch_all(&mut *tx)
    .await?;

    let mut inserted: u64 = 0;
    for chunk in rows.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO page_link_cache (source_page_id, target_page_id, edge_count) \
             VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (src, tgt, count) in chunk {
            q = q.bind(src).bind(tgt).bind(count);
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
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT
             COALESCE(sb.parent_id, bl.source_id) AS source_page_id,
             bl.target_id AS target_page_id,
             COUNT(*) AS edge_count
         FROM block_links bl
         JOIN blocks sb ON sb.id = bl.source_id
         WHERE sb.deleted_at IS NULL
         GROUP BY 1, 2",
    )
    .fetch_all(read_pool)
    .await?;

    let mut tx = write_pool.begin().await?;

    sqlx::query("DELETE FROM page_link_cache")
        .execute(&mut *tx)
        .await?;

    let mut inserted: u64 = 0;
    for chunk in rows.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO page_link_cache (source_page_id, target_page_id, edge_count) \
             VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (src, tgt, count) in chunk {
            q = q.bind(src).bind(tgt).bind(count);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }

    tx.commit().await?;
    Ok(inserted)
}
