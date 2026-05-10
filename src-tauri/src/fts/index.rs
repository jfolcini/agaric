//! FTS index management — create, update, remove, and rebuild FTS entries.

use sqlx::{QueryBuilder, Row, Sqlite, SqlitePool};

use super::strip::{load_ref_maps, strip_for_fts_with_maps};
use crate::error::AppError;

/// L-92: chunk size for [`reindex_fts_references`].
///
/// Renaming a popular tag (e.g. `#todo` referenced from 50 000+ blocks) used
/// to hold a single writer transaction for the entire batch, blocking all
/// other writers for many seconds. The reindex is now split into chunks of
/// this many ids per transaction so other writers can interleave.
pub(crate) const FTS_REINDEX_CHUNK: usize = 1000;

/// PEND-25 L7: rows-per-statement for multi-row `INSERT INTO fts_blocks`.
///
/// SQLite's compiled-in expression-tree limit (`SQLITE_MAX_COMPOUND_SELECT`
/// / `SQLITE_LIMIT_VARIABLE_NUMBER`) defaults to 999 bound variables per
/// statement. Each row binds 2 placeholders (`block_id`, `stripped`), so
/// staying at 200 rows per statement (≈400 placeholders) keeps a wide
/// margin and amortises the per-statement overhead the previous per-row
/// loop paid for every block.
const FTS_INSERT_BATCH: usize = 200;

/// PEND-25 L7: emit a multi-row `INSERT INTO fts_blocks (block_id, stripped)
/// VALUES …` for `rows`, against an in-flight transaction, in chunks of
/// [`FTS_INSERT_BATCH`].
///
/// Callers stage the (id, stripped) pairs for the current outer chunk and
/// hand them here. No-op when `rows` is empty (the QueryBuilder would
/// otherwise build an `INSERT … VALUES` with zero rows, which SQLite
/// rejects).
///
/// Uses [`sqlx::QueryBuilder`] so the SQL text is constructed at run
/// time and never participates in the `query!` macro's compile-time
/// cache (`.sqlx/`) — the schema-touching macro path remains unchanged.
async fn insert_fts_rows_tx(
    conn: &mut sqlx::SqliteConnection,
    rows: &[(String, String)],
) -> Result<(), AppError> {
    for chunk in rows.chunks(FTS_INSERT_BATCH) {
        if chunk.is_empty() {
            continue;
        }
        let mut qb: QueryBuilder<'_, Sqlite> =
            QueryBuilder::new("INSERT INTO fts_blocks(block_id, stripped) ");
        qb.push_values(chunk, |mut b, (id, stripped)| {
            b.push_bind(id).push_bind(stripped);
        });
        qb.build().execute(&mut *conn).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// FTS index management
// ---------------------------------------------------------------------------

/// Update FTS index for a single block (convenience wrapper).
///
/// PEND-20 E: this is the convenience entry point used by tests and
/// one-off callers (recovery, manual rebuilds). It loads the
/// tag/page reference maps from the DB on every call and delegates
/// to [`update_fts_for_block_with_maps`].
///
/// Hot-path callers (the materializer batch loop) should call
/// [`update_fts_for_block_with_maps`] directly with maps loaded once
/// per batch, avoiding the two redundant `SELECT block_type=…` queries
/// per block. See the module-level docs in `crate::fts` for the
/// rationale.
pub async fn update_fts_for_block(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    let (tag_names, page_titles) = load_ref_maps(pool).await?;
    update_fts_for_block_with_maps(pool, block_id, &tag_names, &page_titles).await
}

/// Update FTS for a single block, using pre-loaded reference maps.
///
/// PEND-20 E: the materializer batch loop loads `tag_names` /
/// `page_titles` once per batch and reuses them across every
/// `UpdateFtsBlock` task in the batch, eliminating the two
/// `SELECT id, content FROM blocks WHERE block_type = …` queries
/// that the old async [`strip_for_fts`] path issued for every block.
///
/// Reads the block, strips content via the sync
/// [`strip_for_fts_with_maps`] (no DB round-trips), and upserts the
/// FTS entry. If the block is deleted, conflict, or has no content,
/// removes it from the index instead.
pub async fn update_fts_for_block_with_maps(
    pool: &SqlitePool,
    block_id: &str,
    tag_names: &std::collections::HashMap<String, String>,
    page_titles: &std::collections::HashMap<String, String>,
) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    let row = sqlx::query!(
        r#"SELECT id, content, deleted_at FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    match row {
        None => {
            // Block doesn't exist — remove from FTS if present
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(ref r) if r.deleted_at.is_some() => {
            // deleted_at IS NOT NULL — remove from FTS
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(ref r) if r.content.is_none() => {
            // content IS NULL — remove from FTS
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;
        }
        Some(r) => {
            // Active block with content — strip via pre-loaded maps and index.
            let content = r.content.unwrap();
            let stripped = strip_for_fts_with_maps(&content, tag_names, page_titles);

            // Delete existing entry
            sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
                .bind(block_id)
                .execute(&mut *tx)
                .await?;

            // Insert new entry
            sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
                .bind(block_id)
                .bind(&stripped)
                .execute(&mut *tx)
                .await?;
        }
    }

    tx.commit().await?;
    Ok(())
}

/// Split-pool convenience wrapper. See [`update_fts_for_block`] for the
/// rationale.
pub async fn update_fts_for_block_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    let (tag_names, page_titles) = load_ref_maps(read_pool).await?;
    update_fts_for_block_split_with_maps(write_pool, read_pool, block_id, &tag_names, &page_titles)
        .await
}

/// Split-pool variant of [`update_fts_for_block_with_maps`]: reads from
/// `read_pool`, writes to `write_pool`. Reduces write-lock hold time for
/// background materializer tasks.
///
/// The read-write gap is acceptable because FTS indexing is eventually
/// consistent — if a block changes between read and write phases, the
/// next materializer task will correct the stale entry.
pub async fn update_fts_for_block_split_with_maps(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    block_id: &str,
    tag_names: &std::collections::HashMap<String, String>,
    page_titles: &std::collections::HashMap<String, String>,
) -> Result<(), AppError> {
    // Phase 1: Read — no write lock needed
    let row = sqlx::query!(
        r#"SELECT id, content, deleted_at FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_optional(read_pool)
    .await?;

    // Determine what to write
    let should_delete = match &row {
        None => true,
        Some(r) if r.deleted_at.is_some() => true,
        Some(r) if r.content.is_none() => true,
        _ => false,
    };

    if should_delete {
        // Phase 2a: Delete only — minimal write lock
        sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
            .bind(block_id)
            .execute(write_pool)
            .await?;
        return Ok(());
    }

    // Phase 1b: Strip content using pre-loaded maps (no read pool round-trip).
    let content = row.unwrap().content.unwrap();
    let stripped = strip_for_fts_with_maps(&content, tag_names, page_titles);

    // Phase 2b: Write — minimal transaction
    let mut tx = write_pool.begin().await?;
    sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
        .bind(block_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO fts_blocks(block_id, stripped) VALUES(?, ?)")
        .bind(block_id)
        .bind(&stripped)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Remove a block from the FTS index (for soft-delete/purge).
pub async fn remove_fts_for_block(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    sqlx::query("DELETE FROM fts_blocks WHERE block_id = ?")
        .bind(block_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Reindex FTS for all blocks that reference the given tag or page block.
///
/// When a tag/page is renamed (edited), the FTS entries for every block that
/// references it become stale because `strip_for_fts` resolves `#[ULID]` /
/// `[[ULID]]` tokens to human-readable names. This function finds all
/// referencing blocks and re-runs FTS indexing for each.
///
/// ## Performance
///
/// Pre-loads tag/page name maps once (2 queries), then uses `json_each()` to
/// batch the SELECT and DELETE into single queries per chunk. Only the INSERT
/// remains per-row (because `strip_for_fts_with_maps` processes each block
/// differently).
///
/// L-92: the work is split into chunks of [`FTS_REINDEX_CHUNK`] ids with a
/// fresh transaction per chunk so a tag-rename touching tens of thousands of
/// blocks does not hold a single writer transaction for many seconds. Chunks
/// commit independently — partial failure of a later chunk leaves earlier
/// chunks committed, which is acceptable since `fts_blocks` is an
/// eventually-consistent cache (the next `update_fts_for_block` /
/// `rebuild_fts_index` reconciles any stale rows).
pub async fn reindex_fts_references(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    // Find blocks referencing this ID via block_tags (for explicit tags)
    let tag_refs: Vec<String> =
        sqlx::query_scalar!("SELECT block_id FROM block_tags WHERE tag_id = ?", block_id)
            .fetch_all(pool)
            .await?;

    // Find blocks referencing this ID via block_links (for pages)
    let link_refs: Vec<String> = sqlx::query_scalar!(
        "SELECT source_id FROM block_links WHERE target_id = ?",
        block_id
    )
    .fetch_all(pool)
    .await?;

    // UX-250: find blocks whose content contains an inline `#[ULID]`
    // reference to this tag. Without this, a block that only references
    // the renamed tag inline (no explicit block_tags row, no block_links
    // row) would keep the stale resolved name in its FTS entry.
    let inline_tag_refs: Vec<String> = sqlx::query_scalar!(
        "SELECT source_id FROM block_tag_refs WHERE tag_id = ?",
        block_id
    )
    .fetch_all(pool)
    .await?;

    // Collect unique block IDs
    let mut seen = std::collections::HashSet::new();
    let unique_ids: Vec<String> = tag_refs
        .into_iter()
        .chain(link_refs)
        .chain(inline_tag_refs)
        .filter(|bid| seen.insert(bid.clone()))
        .collect();

    if unique_ids.is_empty() {
        return Ok(());
    }

    // Pre-load tag/page name maps once (2 queries instead of 2*N) — the maps
    // are reused across every chunk's transaction.
    let (tag_names, page_titles) = load_ref_maps(pool).await?;

    // L-92: chunk the reindex into FTS_REINDEX_CHUNK-sized batches with a
    // fresh transaction per chunk. See the function-level rustdoc for the
    // rationale and partial-failure semantics.
    for chunk in unique_ids.chunks(FTS_REINDEX_CHUNK) {
        let ids_json = serde_json::to_string(chunk)?;

        let mut tx = pool.begin().await?;

        // Batch fetch this chunk's block metadata (1 query per chunk)
        let rows = sqlx::query(
            r#"SELECT id, content, deleted_at FROM blocks
               WHERE id IN (SELECT value FROM json_each(?))"#,
        )
        .bind(&ids_json)
        .fetch_all(&mut *tx)
        .await?;

        // Batch delete this chunk's old FTS entries (1 query per chunk)
        sqlx::query("DELETE FROM fts_blocks WHERE block_id IN (SELECT value FROM json_each(?))")
            .bind(&ids_json)
            .execute(&mut *tx)
            .await?;

        // PEND-25 L7: stage (id, stripped) pairs for the chunk, then emit
        // multi-row `INSERT INTO fts_blocks` via QueryBuilder. The previous
        // implementation issued one INSERT statement per row; on a tag
        // referenced by tens of thousands of blocks the per-statement
        // overhead dominated. `strip_for_fts_with_maps` is sync, so the
        // staging loop is just an in-memory map.
        let mut to_insert: Vec<(String, String)> = Vec::with_capacity(rows.len());
        for row in &rows {
            let id: &str = row.get("id");
            let deleted_at: Option<&str> = row.get("deleted_at");
            let content: Option<&str> = row.get("content");

            if deleted_at.is_none() {
                if let Some(content) = content {
                    let stripped = strip_for_fts_with_maps(content, &tag_names, &page_titles);
                    to_insert.push((id.to_owned(), stripped));
                }
            }
        }
        insert_fts_rows_tx(&mut tx, &to_insert).await?;

        tx.commit().await?;
    }

    Ok(())
}

/// Full rebuild: clear fts_blocks, re-index all non-deleted, non-conflict blocks with content.
///
/// Batches tag/page lookups by loading all names/titles into HashMaps first.
///
/// ## Performance
///
/// This is an O(n) operation over all active blocks — it loads every block's
/// content into memory, strips it, and re-inserts into the FTS table.
/// This is the cold path: invoked at application boot and on explicit
/// user request (e.g. "rebuild search index"), never incrementally —
/// single-block updates go through [`update_fts_for_block`] instead.
///
/// PEND-20 D: the rebuild is split into [`FTS_REINDEX_CHUNK`]-sized batches
/// with a fresh `BEGIN…COMMIT` per chunk. Holding a single writer
/// transaction for a 100k-block vault used to block all other writers
/// for several seconds, which is bad for boot UX and worse on Android.
/// Chunked transactions release the writer lock between chunks so other
/// writers (e.g. user edits during a manual rebuild) can interleave.
///
/// The full DELETE happens once at the start in its own transaction, so
/// readers briefly see an empty index during the rebuild — same as the
/// previous single-tx behaviour from outside, since SQLite's WAL only
/// surfaces the rebuilt state on the final COMMIT either way (per-chunk
/// commits do publish intermediate state to readers, but the rebuild is
/// understood to be a transient inconsistent window — search results
/// are eventually-consistent during a rebuild).
pub async fn rebuild_fts_index(pool: &SqlitePool) -> Result<(), AppError> {
    tracing::info!("rebuilding fts_blocks cache");
    let start = std::time::Instant::now();
    let result = rebuild_fts_index_impl(pool).await;
    match result {
        Ok(rows_affected) => {
            tracing::info!(
                rows_affected,
                duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                "rebuilt fts_blocks cache"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "rebuild failed for fts_blocks cache");
            Err(e)
        }
    }
}

async fn rebuild_fts_index_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    // Pre-load tag/page name maps once — reused across every chunk.
    let (tag_names, page_titles) = load_ref_maps(pool).await?;

    // PEND-20 D: clear the index in its own transaction so the writer
    // lock is released before we begin the (potentially long) chunked
    // INSERT loop. The DELETE itself is one statement and commits in
    // milliseconds.
    {
        let mut tx = pool.begin().await?;
        sqlx::query("DELETE FROM fts_blocks")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }

    // Select all active blocks with content. We materialise the full set
    // up front (consistent with the previous implementation) so the
    // chunked writer loop sees a stable input even if the underlying
    // `blocks` table mutates between chunks.
    let blocks = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE deleted_at IS NULL AND content IS NOT NULL"
    )
    .fetch_all(pool)
    .await?;

    // PEND-20 D: chunked INSERT loop, fresh transaction per chunk.
    let mut total: u64 = 0;
    for chunk in blocks.chunks(FTS_REINDEX_CHUNK) {
        let mut to_insert: Vec<(String, String)> = Vec::with_capacity(chunk.len());
        for row in chunk {
            let content = row.content.as_deref().unwrap_or("");
            let stripped = strip_for_fts_with_maps(content, &tag_names, &page_titles);
            to_insert.push((row.id.clone(), stripped));
        }
        let mut tx = pool.begin().await?;
        // PEND-25 L7: multi-row INSERT.
        insert_fts_rows_tx(&mut tx, &to_insert).await?;
        tx.commit().await?;
        total += chunk.len() as u64;
    }

    Ok(total)
}

/// Read/write split variant of [`rebuild_fts_index`].
///
/// Reads block content and reference maps from `read_pool`, writes the
/// FTS index to `write_pool`. Used by the materializer when a separate
/// read pool is available.
pub async fn rebuild_fts_index_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    tracing::info!("rebuilding fts_blocks cache");
    let start = std::time::Instant::now();
    let result = rebuild_fts_index_split_impl(write_pool, read_pool).await;
    match result {
        Ok(rows_affected) => {
            tracing::info!(
                rows_affected,
                duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                "rebuilt fts_blocks cache"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(error = %e, "rebuild failed for fts_blocks cache");
            Err(e)
        }
    }
}

async fn rebuild_fts_index_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    // Read phase: load ref maps and block content from read_pool.
    let (tag_names, page_titles) = load_ref_maps(read_pool).await?;
    let blocks = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE deleted_at IS NULL AND content IS NOT NULL"
    )
    .fetch_all(read_pool)
    .await?;

    // PEND-20 D: clear in its own transaction (see `rebuild_fts_index_impl`).
    {
        let mut tx = write_pool.begin().await?;
        sqlx::query("DELETE FROM fts_blocks")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }

    // PEND-20 D: chunked INSERT loop, fresh transaction per chunk on the
    // write pool. PEND-25 L7: multi-row INSERT per chunk.
    let mut total: u64 = 0;
    for chunk in blocks.chunks(FTS_REINDEX_CHUNK) {
        let mut to_insert: Vec<(String, String)> = Vec::with_capacity(chunk.len());
        for row in chunk {
            let content = row.content.as_deref().unwrap_or("");
            let stripped = strip_for_fts_with_maps(content, &tag_names, &page_titles);
            to_insert.push((row.id.clone(), stripped));
        }
        let mut tx = write_pool.begin().await?;
        insert_fts_rows_tx(&mut tx, &to_insert).await?;
        tx.commit().await?;
        total += chunk.len() as u64;
    }
    Ok(total)
}

// ---------------------------------------------------------------------------
// FTS5 optimize
// ---------------------------------------------------------------------------

/// Run FTS5 optimize to merge segments.
pub async fn fts_optimize(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::query("INSERT INTO fts_blocks(fts_blocks) VALUES('optimize')")
        .execute(pool)
        .await?;
    Ok(())
}
