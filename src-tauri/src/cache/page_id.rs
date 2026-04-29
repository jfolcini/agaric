//! Rebuild the denormalized `page_id` column on `blocks`.

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;
use sqlx::SqlitePool;

// The split rebuild's chunked CASE-expression UPDATE binds 2 params per
// row in the `CASE id WHEN ? THEN ? ...` clause plus 1 param per row in
// the trailing `WHERE id IN (?, ?, ...)` list — total 3 params per row,
// so each statement binds at most `REBUILD_CHUNK * 3 ≤ MAX_SQL_PARAMS`.
// Mirrors the chunk-size derivation in `cache/pages.rs`,
// `cache/agenda.rs`, and the M-18 chunked-INSERT convention.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

/// Full rebuild of `page_id` for all blocks using a recursive CTE.
pub async fn rebuild_page_ids(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("page_id", || rebuild_page_ids_impl(pool)).await
}

async fn rebuild_page_ids_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    // Invariant #9: recursive CTE over `blocks` must filter `is_conflict = 0`
    // in both members and bound `depth < 100`. Conflict copies share
    // `parent_id` with the original and must not be walked through (or the
    // rebuild would compute a page ancestor via the original's parent chain,
    // then rewrite `page_id` — which is exactly the bug fixed here). Their
    // `page_id` is assigned at conflict-creation time and must be preserved
    // by the rebuild.
    let result = sqlx::query(
        "WITH RECURSIVE ancestors(block_id, cur_id, cur_type, depth) AS ( \
             SELECT b.id, b.id, b.block_type, 0 FROM blocks b \
             WHERE b.is_conflict = 0 \
             UNION ALL \
             SELECT a.block_id, parent.id, parent.block_type, a.depth + 1 \
             FROM ancestors a \
             JOIN blocks child ON child.id = a.cur_id \
             JOIN blocks parent ON parent.id = child.parent_id \
             WHERE a.cur_type != 'page' \
               AND child.is_conflict = 0 \
               AND parent.is_conflict = 0 \
               AND a.depth < 100 \
         ), \
         page_ancestors AS ( \
             SELECT block_id, cur_id AS page_id \
             FROM ancestors \
             WHERE cur_type = 'page' \
         ) \
         UPDATE blocks SET page_id = ( \
             SELECT pa.page_id FROM page_ancestors pa WHERE pa.block_id = blocks.id \
         ) \
         WHERE is_conflict = 0",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

// ---------------------------------------------------------------------------
// Read/write split variant (M-17)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`rebuild_page_ids`] (M-17).
///
/// Runs the recursive ancestor-walk CTE as a SELECT on `read_pool`
/// inside a snapshot-isolated transaction, materialises the
/// `(block_id, page_id)` pairs into memory, then resets every non-
/// conflict block's `page_id` to NULL and applies a chunked CASE-
/// expression UPDATE on `write_pool` so the writer is held only for
/// the final write transaction.
///
/// Stale-while-revalidate: between dropping the read tx and beginning
/// the write tx another writer may mutate `blocks`. The next rebuild
/// reconciles any churn — cache rebuilds are background, eventually
/// consistent (AGENTS.md "Performance Conventions / Split read/write
/// pool pattern").
///
/// Invariant #9: the read-side CTE filters `is_conflict = 0` on every
/// member (seed + both endpoints of the recursive join) and bounds
/// `depth < 100`. The write-side UPDATE keeps `WHERE is_conflict = 0`
/// so conflict copies' pre-assigned `page_id` is preserved.
pub async fn rebuild_page_ids_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("page_id", || {
        rebuild_page_ids_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_page_ids_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // Read phase — snapshot-isolated SELECT on `read_pool`. Same recursive
    // CTE shape as `rebuild_page_ids_impl` but materialises the
    // `(block_id, page_id)` mapping instead of folding into an inline
    // UPDATE. Invariant #9 filters apply identically.
    let mut read_tx = read_pool.begin().await?;
    let pairs: Vec<(String, String)> = sqlx::query_as(
        "WITH RECURSIVE ancestors(block_id, cur_id, cur_type, depth) AS ( \
             SELECT b.id, b.id, b.block_type, 0 FROM blocks b \
             WHERE b.is_conflict = 0 \
             UNION ALL \
             SELECT a.block_id, parent.id, parent.block_type, a.depth + 1 \
             FROM ancestors a \
             JOIN blocks child ON child.id = a.cur_id \
             JOIN blocks parent ON parent.id = child.parent_id \
             WHERE a.cur_type != 'page' \
               AND child.is_conflict = 0 \
               AND parent.is_conflict = 0 \
               AND a.depth < 100 \
         ) \
         SELECT block_id, cur_id AS page_id \
         FROM ancestors \
         WHERE cur_type = 'page'",
    )
    .fetch_all(&mut *read_tx)
    .await?;
    drop(read_tx);

    // Write phase — single tx wrapping the NULL-reset and every chunked
    // UPDATE. Mirrors the single-pool variant's atomic semantics.
    let mut tx = write_pool.begin().await?;

    // Reset every non-conflict block's `page_id` to NULL. Mirrors the
    // single-pool UPDATE semantics: blocks not present in the CTE
    // result (orphans, conflict-only descendants) get `page_id = NULL`
    // because the correlated subquery returns NULL for them. The reset
    // keeps `WHERE is_conflict = 0` so conflict copies' `page_id` is
    // preserved (invariant #9).
    let reset = sqlx::query!("UPDATE blocks SET page_id = NULL WHERE is_conflict = 0")
        .execute(&mut *tx)
        .await?;
    let mut updated: u64 = reset.rows_affected();

    // Chunked CASE-expression UPDATE: 2 binds per row in the CASE +
    // 1 bind per row in the trailing IN list = 3 binds per row,
    // bounded by `REBUILD_CHUNK * 3 ≤ MAX_SQL_PARAMS`. The IN clause
    // restricts the UPDATE to the chunk's rows so we do not rewrite
    // unrelated blocks via the CASE's `ELSE page_id` no-op. The
    // `AND is_conflict = 0` guard preserves invariant #9 even if the
    // DB state shifted between the read and write phases.
    for chunk in pairs.chunks(REBUILD_CHUNK) {
        let case_clauses: String = std::iter::repeat_n("WHEN ? THEN ?", chunk.len())
            .collect::<Vec<_>>()
            .join(" ");
        let in_placeholders: String = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE blocks SET page_id = CASE id {case_clauses} ELSE page_id END \
             WHERE id IN ({in_placeholders}) AND is_conflict = 0",
        );
        let mut q = sqlx::query(&sql);
        // CASE binds: (block_id, page_id) per row.
        for (block_id, page_id) in chunk {
            q = q.bind(block_id).bind(page_id);
        }
        // IN-list binds: just the block ids, in the same order.
        for (block_id, _) in chunk {
            q = q.bind(block_id);
        }
        let res = q.execute(&mut *tx).await?;
        updated += res.rows_affected();
    }

    tx.commit().await?;
    Ok(updated)
}
