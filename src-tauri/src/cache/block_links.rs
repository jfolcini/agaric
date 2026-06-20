use sqlx::SqlitePool;
use std::collections::HashSet;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// reindex_block_links (p1-t21)
// ---------------------------------------------------------------------------

/// Incremental reindex of `block_links` for a single block.
///
/// 1. Opens a transaction for a consistent read snapshot.
/// 2. Reads the block's current `content` and its existing outbound links.
/// 3. Parses all `[[ULID]]` and `((ULID))` tokens via regex.
/// 4. Diffs: deletes removed links, inserts added links within the same tx.
pub async fn reindex_block_links(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_block_links_reindex").await?;
    reindex_block_links_conn(&mut tx, block_id).await?;
    tx.commit().await?;
    Ok(())
}

/// Connection-scoped core of [`reindex_block_links`]: runs the
/// read → diff → DELETE/INSERT of a single block's outbound `block_links`
/// edges against an already-open connection/transaction, WITHOUT opening or
/// committing its own transaction. The caller controls the transaction
/// boundary.
///
/// This is the diff engine shared between the background
/// `ReindexBlockLinks` task (via [`reindex_block_links`], which wraps this in
/// its own tx) and the foreground per-op `pages_cache` count maintenance
/// hook (`materializer::handlers::pages_cache`), which calls it INSIDE the
/// apply-op transaction so the in-tx `inbound_link_count` recompute observes
/// the just-written edges immediately rather than after the async reindex
/// catches up (#1548).
///
/// Idempotent by construction: it diffs the parsed content tokens against the
/// rows currently in `block_links`, so a second run (e.g. the background
/// `ReindexBlockLinks` after the foreground hook already applied the edges)
/// finds an empty diff and is a no-op — the synchronous update and the
/// backstop rebuild converge on the same edge set with no double-count.
pub async fn reindex_block_links_conn(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<(), AppError> {
    // 1. Get current content (combined with step 2 in the same tx to
    //    avoid an extra connection round-trip). Soft-deleted blocks
    //    do not contribute outbound links to `block_links` (M-14).
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(&mut *conn)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        // Block not found or deleted — remove all links
        None => String::new(),
    };

    // 2. Parse [[ULID]] and ((ULID)) tokens
    let new_targets: HashSet<String> = super::ulid_link_re()
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    // 3. Get existing outbound links (same tx — consistent snapshot)
    let existing_rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ?",
        block_id,
    )
    .fetch_all(&mut *conn)
    .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|r| r.target_id).collect();

    // 4. Diff
    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    // PEND-15 Phase 3 — filter out cross-space targets before inserting.
    // The write-time enforcement gate (Phase 2) rejects new cross-space
    // references, but the materializer rebuild path also processes content
    // that may contain legacy tokens. Filtering here ensures the cache
    // never holds cross-space rows even if a legacy token survives.
    //
    // P6 (#346): the source space is resolved once (one query); the
    // per-target space resolution that used to run in a Rust loop is
    // pushed into the INSERT's correlated subquery below, so the whole
    // cross-space filter costs one set-based statement instead of N+1
    // round-trips. The subquery is a verbatim copy of
    // `space::resolve_block_space`'s SQL and KEEPS both soft-delete
    // guards (invariant #9): the input-block `page_id` lookup
    // (`AND deleted_at IS NULL`) and the holder join
    // (`tgt.deleted_at IS NULL`).
    let source_space: Option<String> = if to_insert.is_empty() {
        None
    } else {
        let source_block_id = crate::ulid::BlockId::from_trusted(block_id);
        crate::space::resolve_block_space(&mut *conn, &source_block_id)
            .await?
            .map(|s| s.as_str().to_owned())
    };

    if to_delete.is_empty() && to_insert.is_empty() {
        // No changes — leave the caller's transaction untouched.
        return Ok(());
    }

    // L-24: batch DELETE/INSERT via `json_each` — one round-trip per side
    // regardless of the number of changed targets, replacing the previous
    // 2N round-trip per-target loops.
    if !to_delete.is_empty() {
        let delete_json = serde_json::to_string(&to_delete)?;
        sqlx::query(
            "DELETE FROM block_links \
             WHERE source_id = ? \
               AND target_id IN (SELECT value FROM json_each(?))",
        )
        .bind(block_id)
        .bind(&delete_json)
        .execute(&mut *conn)
        .await?;
    }

    if !to_insert.is_empty() {
        // INSERT OR IGNORE skips PK/UNIQUE conflicts but does NOT suppress FK
        // violations — the `WHERE EXISTS` filter on `blocks` keeps dangling
        // targets out of the result set instead of relying on the FK.
        // SQL/C9 (#345): the EXISTS guard also requires `deleted_at IS NULL`
        // so a link to a soft-deleted (tombstoned) target is never created
        // — invariant #9 (tombstones must not participate in derived state).
        //
        // P6 (#346): the `(?3 IS NULL OR target_space = ?3)` clause is the
        // pushed-down cross-space filter. When the source has no resolved
        // space (`?3 IS NULL`) every target passes (mirrors the old
        // `if source_space.is_some()` skip). Otherwise a target is kept
        // only if its own resolved space equals the source's; targets
        // whose space is NULL (unresolvable / soft-deleted holder) yield
        // `NULL = ?3` → falsy → dropped, exactly as the prior loop did
        // (it only pushed `Ok(Some(space))` matches).
        let insert_json = serde_json::to_string(&to_insert)?;
        sqlx::query(
            "INSERT OR IGNORE INTO block_links (source_id, target_id) \
             SELECT ?1, je.value FROM json_each(?2) je \
             WHERE EXISTS (SELECT 1 FROM blocks WHERE id = je.value AND deleted_at IS NULL) \
               AND (?3 IS NULL OR ?3 = ( \
                   SELECT space_id FROM blocks \
                   WHERE id = je.value AND deleted_at IS NULL \
                   LIMIT 1))",
        )
        .bind(block_id)
        .bind(&insert_json)
        .bind(&source_space)
        .execute(&mut *conn)
        .await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Read/write split variant (Phase 1A)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`reindex_block_links`].
///
/// Reads block content and existing links from `read_pool`, computes a diff,
/// and applies inserts/deletes on `write_pool`.
/// Used by the materializer when a separate read pool is available.
pub async fn reindex_block_links_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    // Read phase from read_pool

    // 1. Get current content. Soft-deleted blocks do not contribute
    //    outbound links to `block_links` (M-14).
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(read_pool)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        // Block not found or deleted — remove all links
        None => String::new(),
    };

    // 2. Parse [[ULID]] and ((ULID)) tokens
    let new_targets: HashSet<String> = super::ulid_link_re()
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    // 3. Get existing outbound links from read pool
    let existing_rows = sqlx::query!(
        "SELECT target_id FROM block_links WHERE source_id = ?",
        block_id,
    )
    .fetch_all(read_pool)
    .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|r| r.target_id).collect();

    // 4. Diff
    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    // #375: resolve the source space so the INSERT below can exclude
    // cross-space targets, identically to the single-pool `reindex_block_links`
    // (PEND-15 Phase 3 / #345/#346). The split path reads from `read_pool`, so
    // the resolution does too (consistent with the content/target reads above).
    // Without this the production split path silently re-admits exactly the
    // cross-space rows the canonical path is careful to exclude.
    let source_space: Option<String> = if to_insert.is_empty() {
        None
    } else {
        let source_block_id = crate::ulid::BlockId::from_trusted(block_id);
        crate::space::resolve_block_space(read_pool, &source_block_id)
            .await?
            .map(|s| s.as_str().to_owned())
    };

    if to_delete.is_empty() && to_insert.is_empty() {
        // No changes — nothing to write.
        return Ok(());
    }

    // Write phase on write pool
    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_block_links_reindex_write").await?;

    // L-24: batch DELETE/INSERT via `json_each` — one round-trip per side
    // regardless of the number of changed targets, replacing the previous
    // 2N round-trip per-target loops.
    if !to_delete.is_empty() {
        let delete_json = serde_json::to_string(&to_delete)?;
        sqlx::query(
            "DELETE FROM block_links \
             WHERE source_id = ? \
               AND target_id IN (SELECT value FROM json_each(?))",
        )
        .bind(block_id)
        .bind(&delete_json)
        .execute(&mut *tx)
        .await?;
    }

    if !to_insert.is_empty() {
        // INSERT OR IGNORE skips PK/UNIQUE conflicts but does NOT suppress FK
        // violations — the `WHERE EXISTS` filter on `blocks` keeps dangling
        // targets out of the result set instead of relying on the FK.
        // SQL/C9 (#345): the EXISTS guard also requires `deleted_at IS NULL`
        // so a link to a soft-deleted (tombstoned) target is never created
        // — invariant #9 (tombstones must not participate in derived state).
        //
        // #375: the `(?3 IS NULL OR ?3 = (…))` clause is the pushed-down
        // cross-space filter — a verbatim copy of the single-pool variant's
        // (and `space::resolve_block_space`'s) SQL. Source has no space
        // (`?3 IS NULL`) ⇒ every target passes; otherwise a target is kept only
        // if its own resolved space equals the source's (a NULL target space
        // yields `NULL = ?3` → dropped).
        let insert_json = serde_json::to_string(&to_insert)?;
        sqlx::query(
            "INSERT OR IGNORE INTO block_links (source_id, target_id) \
             SELECT ?1, je.value FROM json_each(?2) je \
             WHERE EXISTS (SELECT 1 FROM blocks WHERE id = je.value AND deleted_at IS NULL) \
               AND (?3 IS NULL OR ?3 = ( \
                   SELECT space_id FROM blocks \
                   WHERE id = je.value AND deleted_at IS NULL \
                   LIMIT 1))",
        )
        .bind(block_id)
        .bind(&insert_json)
        .bind(&source_space)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}
