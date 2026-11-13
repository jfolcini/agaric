//! `block_tag_refs` — derived-state cache for inline `#[ULID]` tag
//! references found inside block content (Option A).
//!
//! Mirrors the shape of `block_links` but:
//! - scans for `#[ULID]` tokens via [`super::tag_ref_re`]
//! - only inserts rows whose target is actually a `tag` block
//!   (stray IDs that happen to match the regex but point at content/page
//!   blocks are filtered out on INSERT)
//! - explicit tag associations remain in `block_tags`; inline references
//!   stay here so the explicit-vs-inline origin is preserved.  Readers
//!   that want "any kind of reference" UNION the two tables.

use futures_util::TryStreamExt;
use sqlx::SqlitePool;
use std::collections::{BTreeSet, HashMap, HashSet};

use crate::db::MAX_SQL_PARAMS;
use agaric_core::error::AppError;

/// block_tag_refs has 2 columns per row.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 2; // 499

// ---------------------------------------------------------------------------
// reindex_block_tag_refs (per-block, incremental)
// ---------------------------------------------------------------------------

/// Incremental reindex of `block_tag_refs` for a single block.
///
/// 1. Read the block's current content (single transaction, consistent
///    snapshot).
/// 2. Parse all `#[ULID]` tokens via `super::tag_ref_re`.
/// 3. Diff against existing rows; DELETE removed, INSERT added.
///
/// Guards: INSERTs use `WHERE EXISTS (SELECT 1 FROM blocks WHERE id = ?
/// AND block_type = 'tag')` so only actual tag blocks land in the table.
/// A stray `#[ULID]` pointing at a content/page block produces no row.
///
/// Soft-deleted or purged tags produce no INSERT — but a pre-existing
/// row whose tag gets purged stays (FK ON DELETE CASCADE handles it at
/// purge time). Soft-deleted source blocks clear their rows as their
/// content is unreadable under the `WHERE deleted_at IS NULL` filter.
///
/// #2659: returns the set of tag ids whose ref set changed (the symmetric
/// difference of the block's old and new inline `#[ULID]` targets — i.e.
/// `to_insert ∪ to_delete`). The `ReindexBlockTagRefs` handler feeds these
/// into the scoped `refresh_tag_usage_count` (#676) so each affected tag's
/// `tags_cache.usage_count` is recomputed; this function itself only
/// rewrites the `block_tag_refs` TABLE and never touches `tags_cache`. An
/// empty vec means the refs were already correct (no count refresh needed).
pub async fn reindex_block_tag_refs(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_block_tag_refs_reindex").await?;
    let changed_tags = reindex_block_tag_refs_in_tx(&mut tx, block_id).await?;
    // Empty diff performed no writes; skip the commit (rollback-on-drop is a
    // no-op) to match the pre-#2831 lazy-commit behaviour.
    if !changed_tags.is_empty() {
        tx.commit().await?;
    }
    Ok(changed_tags)
}

/// #2831: transactional core of [`reindex_block_tag_refs`].
///
/// Runs the read → diff → DELETE/INSERT of the `block_tag_refs` rewrite
/// against the caller-provided connection (typically a `BEGIN IMMEDIATE`
/// transaction) and returns the set of tag ids whose ref set changed —
/// WITHOUT committing. Exposing the core lets the `ReindexBlockTagRefs`
/// materializer handler seed the durable `usage_count`-refresh obligation
/// (`RetryKind::RefreshTagUsageCount`) into the SAME transaction that
/// commits this diff, so a crash or error between the diff commit and the
/// dependent refresh cannot strand a stale `tags_cache.usage_count` (the
/// #2831 recoverability hole: a *retry's* diff is empty, so a diff-coupled
/// refresh would silently no-op). The empty-diff case performs no writes
/// and returns an empty vec.
pub async fn reindex_block_tag_refs_in_tx(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(&mut *conn)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        // Block not found or deleted — remove all rows.
        None => String::new(),
    };

    let new_targets: HashSet<String> = super::tag_ref_re()
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    let existing_rows = sqlx::query!(
        "SELECT tag_id FROM block_tag_refs WHERE source_id = ?",
        block_id,
    )
    .fetch_all(&mut *conn)
    .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|r| r.tag_id).collect();

    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    // Phase 3 — filter out cross-space tag-refs before inserting.
    // Tags are space-scoped (Path A); the write-time gate rejects
    // cross-space tag refs, and the cache must mirror that invariant.
    //
    // P6 (#346): the source space is resolved once; the per-tag space
    // resolution that used to run in a Rust loop is pushed into the
    // INSERT's correlated subquery below (one set-based statement instead
    // of N+1 round-trips). The subquery is a verbatim copy of
    // `space::resolve_block_space`'s SQL and KEEPS both soft-delete
    // guards (invariant #9): the input-block `page_id` lookup and the
    // holder join.
    let source_space: Option<String> = if to_insert.is_empty() {
        None
    } else {
        let source_block_id = agaric_core::ulid::BlockId::from_trusted(block_id);
        crate::space::resolve_block_space(&mut *conn, &source_block_id)
            .await?
            .map(|s| s.as_str().to_owned())
    };

    if to_delete.is_empty() && to_insert.is_empty() {
        // No changes — the caller commits nothing on an empty diff.
        // No tag's usage_count can have shifted, so nothing to refresh.
        return Ok(Vec::new());
    }

    write_block_tag_ref_diff(conn, block_id, &to_delete, &to_insert, source_space).await?;

    // #2659: report the changed tags (added ∪ removed) so the caller can
    // refresh exactly their `usage_count` (and, #2831, seed a durable refresh
    // obligation before committing). Computed from the in-memory diff sets, so
    // it costs nothing extra. A candidate that turned out not to be a live tag
    // (stray `#[ULID]`, cross-space, purged) is harmless: `refresh_tag_usage_count`
    // no-ops for it.
    let changed_tags: Vec<String> = new_targets
        .symmetric_difference(&old_targets)
        .cloned()
        .collect();
    Ok(changed_tags)
}

/// Read/write split variant of [`reindex_block_tag_refs`].
///
/// Reads content and existing rows from `read_pool`; diffs and applies
/// inserts/deletes on `write_pool`. Matches the shape of
/// [`super::reindex_block_links_split`].
///
/// #2659: returns the changed tag ids (symmetric difference of old/new
/// targets), same contract as [`reindex_block_tag_refs`].
pub async fn reindex_block_tag_refs_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_block_tag_refs_reindex_write").await?;
    let changed_tags = reindex_block_tag_refs_split_in_tx(&mut tx, read_pool, block_id).await?;
    // Empty diff performed no writes; skip the commit to match the pre-#2831
    // lazy-commit behaviour (rollback-on-drop is a no-op).
    if !changed_tags.is_empty() {
        tx.commit().await?;
    }
    Ok(changed_tags)
}

/// #2831: transactional core of [`reindex_block_tag_refs_split`].
///
/// Reads the block's content, existing refs, and source space from
/// `read_pool`; applies the DELETE/INSERT diff on the caller-provided
/// `write_conn` (a `BEGIN IMMEDIATE` transaction on the write pool) and
/// returns the changed tag ids WITHOUT committing — so the
/// `ReindexBlockTagRefs` handler can seed the durable
/// `RetryKind::RefreshTagUsageCount` obligation atomically with the diff.
/// Mirrors [`reindex_block_tag_refs_in_tx`] for the read/write-split pool
/// configuration. Same contract otherwise as [`reindex_block_tag_refs_split`].
pub async fn reindex_block_tag_refs_split_in_tx(
    write_conn: &mut sqlx::SqliteConnection,
    read_pool: &SqlitePool,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    // Read phase from read_pool.
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(read_pool)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        None => String::new(),
    };

    let new_targets: HashSet<String> = super::tag_ref_re()
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();

    let existing_rows = sqlx::query!(
        "SELECT tag_id FROM block_tag_refs WHERE source_id = ?",
        block_id,
    )
    .fetch_all(read_pool)
    .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|r| r.tag_id).collect();

    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    // #375: resolve the source space so the INSERT excludes cross-space tags,
    // identically to the single-pool `reindex_block_tag_refs`. The split path
    // reads from `read_pool`, so the resolution does too.
    let source_space: Option<String> = if to_insert.is_empty() {
        None
    } else {
        let source_block_id = agaric_core::ulid::BlockId::from_trusted(block_id);
        crate::space::resolve_block_space(read_pool, &source_block_id)
            .await?
            .map(|s| s.as_str().to_owned())
    };

    if to_delete.is_empty() && to_insert.is_empty() {
        return Ok(Vec::new());
    }

    write_block_tag_ref_diff(write_conn, block_id, &to_delete, &to_insert, source_space).await?;

    // #2659 / #2831: same as the single-pool variant — report changed tags so
    // the handler can refresh their `usage_count` and seed the durable refresh
    // obligation before committing this transaction.
    let changed_tags: Vec<String> = new_targets
        .symmetric_difference(&old_targets)
        .cloned()
        .collect();
    Ok(changed_tags)
}

/// The `block_tag_refs` DELETE/INSERT half of both reindex paths. The caller
/// keeps the transaction and the commit; this only writes. The two reindex
/// ROOTS stay independent, but this half is handed a connection and cannot
/// tell which of them handed it over — and #375 already required their SQL to
/// be byte-identical.
async fn write_block_tag_ref_diff(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
    to_delete: &[&String],
    to_insert: &[&String],
    source_space: Option<String>,
) -> Result<(), AppError> {
    // Batch DELETE/INSERT via `json_each` — one round-trip per
    // side regardless of the number of changed targets, replacing the
    // previous 2N round-trip per-target loops. Mirrors the
    // `cache/block_links.rs` pattern.
    if !to_delete.is_empty() {
        let delete_json = serde_json::to_string(&to_delete)?;
        sqlx::query!(
            "DELETE FROM block_tag_refs \
             WHERE source_id = ? \
               AND tag_id IN (SELECT value FROM json_each(?))",
            block_id,
            delete_json,
        )
        .execute(&mut *conn)
        .await?;
    }

    if !to_insert.is_empty() {
        // INSERT ... SELECT ... WHERE EXISTS — only link to blocks that
        // are actually tags. Non-tag candidates (stray IDs that happen to
        // match the regex but point at content/page blocks) are silently
        // dropped. `INSERT OR IGNORE` handles the already-present case
        // if two insert passes race (shouldn't happen inside a tx, but
        // keeps the statement idempotent).
        //
        // The tag-existence guard also requires `deleted_at IS NULL` so a
        // soft-deleted tag never produces a ref (invariant #9 — matches
        // the prior loop, whose `resolve_block_space` soft-delete guards
        // dropped tombstoned holders).
        //
        // P6 (#346): the `(?3 IS NULL OR target_space = ?3)` clause is the
        // pushed-down cross-space filter. When the source has no resolved
        // space (`?3 IS NULL`) every tag passes (mirrors the old
        // `if source_space.is_some()` skip). Otherwise a tag is kept only
        // if its own resolved space equals the source's; tags whose space
        // is NULL yield `NULL = ?3` → falsy → dropped, exactly as the
        // prior loop did. The space subquery is a verbatim copy of
        // `space::resolve_block_space` and KEEPS both soft-delete guards.
        let insert_json = serde_json::to_string(&to_insert)?;
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) \
             SELECT ?1, je.value FROM json_each(?2) je \
             WHERE EXISTS \
                 (SELECT 1 FROM blocks WHERE id = je.value AND block_type = 'tag' AND deleted_at IS NULL) \
               AND (?3 IS NULL OR ?3 = ( \
                   SELECT space_id FROM blocks \
                   WHERE id = je.value AND deleted_at IS NULL \
                   LIMIT 1))",
            block_id,
            insert_json,
            source_space,
        )
        .execute(&mut *conn)
        .await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Rebuild_block_tag_refs_cache — incremental sort-merge
// ---------------------------------------------------------------------------

// DELETE binds 2 cols per row (source_id, tag_id) → `MAX_SQL_PARAMS / 2 = 499`.
// INSERT binds 2 cols per row → same 499. (REBUILD_CHUNK above is already 499.)
const DELETE_CHUNK: usize = MAX_SQL_PARAMS / 2; // 499

/// A live tag's id → the space it resolves to (`None`: unscoped).
type TagSpaces = HashMap<String, Option<String>>;

/// The live tags, each with its resolved space: every one, or with
/// `among <a JSON id array>` the ones among those ids.
///
/// #678 — the space MUST mirror `space::resolve_block_space`'s SQL,
/// `COALESCE(b.space_id, p.space_id)` via a LEFT JOIN to the owning page with
/// the same `deleted_at IS NULL` guard, so the rebuild and the incremental
/// [`reindex_block_tag_refs`] resolve a block whose own `space_id` is not
/// stamped yet to the same space.
macro_rules! live_tag_spaces {
    () => {
        live_tag_spaces!(@scoped "")
    };
    (among $ids_json:expr) => {
        live_tag_spaces!(@scoped " AND b.id IN (SELECT value FROM json_each(?))", $ids_json)
    };
    (@scoped $scope:literal $(, $ids_json:expr)?) => {
        sqlx::query!(
            r#"SELECT b.id AS "id!", COALESCE(b.space_id, p.space_id) AS "space?"
               FROM blocks b
               LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
               WHERE b.block_type = 'tag' AND b.deleted_at IS NULL"#
                + $scope
            $(, $ids_json)?
        )
        .map(|r| (r.id, r.space))
    };
}

/// The live blocks that have content, as `(id, content, resolved space)`:
/// every one, or the ones among a JSON id array, scoped as
/// [`live_tag_spaces`] is. The space is resolved the same way.
macro_rules! live_sources {
    () => {
        live_sources!(@scoped "")
    };
    (among $ids_json:expr) => {
        live_sources!(@scoped " AND b.id IN (SELECT value FROM json_each(?))", $ids_json)
    };
    (@scoped $scope:literal $(, $ids_json:expr)?) => {
        sqlx::query!(
            r#"SELECT b.id AS "id!", b.content AS "content!",
                      COALESCE(b.space_id, p.space_id) AS "space?"
               FROM blocks b
               LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
               WHERE b.deleted_at IS NULL AND b.content IS NOT NULL"#
                + $scope
            $(, $ids_json)?
        )
        .map(|r| (r.id, r.content, r.space))
    };
}

/// The `#[ULID]` tokens in `content`, whether or not they name a tag.
fn tag_ref_candidates(content: &str) -> impl Iterator<Item = &str> {
    super::tag_ref_re()
        .captures_iter(content)
        .filter_map(|cap| cap.get(1).map(|id| id.as_str()))
}

/// Add the rows one source block should have: a pair per `#[ULID]` token in
/// its content that names a live tag of the source's space. The one rule both
/// halves of the rebuild derive rows by.
///
/// #375: an unscoped source (`None`) keeps every tag, mirroring the
/// incremental `?3 IS NULL` branch; otherwise a tag is kept only if its own
/// resolved space equals the source's (a NULL tag space is dropped, exactly
/// as `NULL = ?3` evaluates falsy).
fn push_desired_pairs(
    pairs: &mut BTreeSet<(String, String)>,
    source_id: &str,
    content: &str,
    source_space: Option<&str>,
    tag_spaces: &TagSpaces,
) {
    for tag_id in tag_ref_candidates(content) {
        let Some(tag_space) = tag_spaces.get(tag_id) else {
            continue;
        };
        if source_space.is_none() || tag_space.as_deref() == source_space {
            pairs.insert((source_id.to_owned(), tag_id.to_owned()));
        }
    }
}

/// The read half of [`rebuild_block_tag_refs_cache_split`]: the source blocks
/// with a pair on which the whole desired state and the whole cache disagree,
/// in id order.
///
/// Streams the sources (M-19a), so it holds the pairs and the tag map but
/// never every block's content.
async fn sources_with_stale_tag_refs(read_pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let mut conn = read_pool.acquire().await?;
    let tag_spaces: TagSpaces = live_tag_spaces!()
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();
    let mut desired = BTreeSet::new();
    {
        let mut sources = live_sources!().fetch(&mut *conn);
        while let Some((id, content, space)) = sources.try_next().await? {
            push_desired_pairs(&mut desired, &id, &content, space.as_deref(), &tag_spaces);
        }
    }
    let mut stale = BTreeSet::new();
    let mut current =
        sqlx::query!("SELECT source_id, tag_id FROM block_tag_refs").fetch(&mut *conn);
    while let Some(row) = current.try_next().await? {
        if !desired.remove(&(row.source_id.clone(), row.tag_id)) {
            stale.insert(row.source_id);
        }
    }
    // What is left of `desired` is missing from the cache.
    stale.extend(desired.into_iter().map(|(source_id, _)| source_id));
    Ok(stale.into_iter().collect())
}

/// Sources re-derived per statement by [`rederive_tag_refs_of`], which bounds
/// the content it holds at once when the whole cache is stale.
const REDERIVE_CHUNK: usize = 500;

/// The write half of [`rebuild_block_tag_refs_cache_split`]: bring the rows of
/// the source blocks in `source_ids` to what their content gives now. It
/// reads the sources, the tags they name and the cached rows again under the
/// writer lock instead of applying what the read phase saw, so a write that
/// landed in between is never undone. Every read seeks by id. Returns the
/// pairs changed.
async fn rederive_tag_refs_of(
    conn: &mut sqlx::SqliteConnection,
    source_ids: &[String],
) -> Result<u64, AppError> {
    let mut changed = 0;
    for chunk in source_ids.chunks(REDERIVE_CHUNK) {
        let ids_json = serde_json::to_string(chunk)?;
        let sources = live_sources!(among ids_json).fetch_all(&mut *conn).await?;
        let candidates: BTreeSet<&str> = sources
            .iter()
            .flat_map(|(_, content, _)| tag_ref_candidates(content))
            .collect();
        let candidates_json = serde_json::to_string(&candidates)?;
        let tag_spaces: TagSpaces = live_tag_spaces!(among candidates_json)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
        let mut desired = BTreeSet::new();
        for (id, content, space) in &sources {
            push_desired_pairs(&mut desired, id, content, space.as_deref(), &tag_spaces);
        }

        let current: BTreeSet<(String, String)> = sqlx::query!(
            "SELECT source_id, tag_id FROM block_tag_refs \
             WHERE source_id IN (SELECT value FROM json_each(?))",
            ids_json
        )
        .map(|r| (r.source_id, r.tag_id))
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();

        let deletes: Vec<_> = current.difference(&desired).cloned().collect();
        let inserts: Vec<_> = desired.difference(&current).cloned().collect();
        changed += u64::try_from(deletes.len() + inserts.len()).unwrap_or(u64::MAX);
        apply_block_tag_refs_diff(conn, &deletes, &inserts).await?;
    }
    Ok(changed)
}

/// Apply a `block_tag_refs` diff inside an open transaction in chunks
/// bounded by [`MAX_SQL_PARAMS`].
///
/// `delete_rows` and `insert_rows` are caller-owned and may be empty.
/// DELETEs run before INSERTs (defensive — the PK is `(source_id,
/// tag_id)` and the diff never emits the same pair on both sides, so
/// ordering is not strictly required, but matches the apply-style of
/// the agenda / pages / tags caches).
///
/// `INSERT OR IGNORE` matches the pre-M-2 split-variant shape (the
/// single-pool variant used plain `INSERT`, but our diff filter
/// guarantees no PK collision so the two forms are equivalent here).
async fn apply_block_tag_refs_diff(
    conn: &mut sqlx::SqliteConnection,
    delete_rows: &[(String, String)],
    insert_rows: &[(String, String)],
) -> Result<(), AppError> {
    for chunk in delete_rows.chunks(DELETE_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "DELETE FROM block_tag_refs WHERE (source_id, tag_id) IN ({})",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for (source, tag) in chunk {
            q = q.bind(source).bind(tag);
        }
        q.execute(&mut *conn).await?;
    }

    for chunk in insert_rows.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for (source, tag) in chunk {
            q = q.bind(source).bind(tag);
        }
        q.execute(&mut *conn).await?;
    }

    Ok(())
}

/// Incremental rebuild of `block_tag_refs`:
/// [`rebuild_block_tag_refs_cache_split`] with one pool for both halves.
///
/// Intended for: migration backfill, snapshot restore, explicit "rebuild
/// caches" actions. Per-block content edits still go through
/// [`reindex_block_tag_refs`] instead.
#[tracing::instrument(skip(pool), err)]
pub async fn rebuild_block_tag_refs_cache(pool: &SqlitePool) -> Result<(), AppError> {
    rebuild_block_tag_refs_cache_split(pool, pool).await
}

/// Rebuild `block_tag_refs` with the whole-vault comparison on `read_pool`.
///
/// 1. Scans every live block's content for `#[ULID]` tokens that name a live
///    tag of the block's space, compares the pairs with the cache, and keeps
///    the ids of the source blocks they disagree on.
/// 2. Takes the writer lock only when there are any, and under it re-derives
///    those sources' rows ([`rederive_tag_refs_of`]).
///
/// A source that goes stale after step 1 read it is left to the reindex or
/// rebuild its own write enqueues, which runs after this one.
pub async fn rebuild_block_tag_refs_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("block_tag_refs", || {
        rebuild_block_tag_refs_cache_impl(write_pool, read_pool)
    })
    .await?;
    crate::derivations::record_split(
        write_pool,
        read_pool,
        crate::derivations::Derivation::TagRefTokens,
    )
    .await
}

async fn rebuild_block_tag_refs_cache_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    let stale = sources_with_stale_tag_refs(read_pool).await?;
    if stale.is_empty() {
        return Ok(0);
    }
    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_block_tag_refs_rebuild_write").await?;
    let changed = rederive_tag_refs_of(&mut tx, &stale).await?;
    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// M-19a — streaming-rebuild correctness tests
// ---------------------------------------------------------------------------
//
// These tests are intentionally local to this file rather than appended
// To `cache/tests.rs` so that sibling subagents (agenda /
// projected_agenda) can append their own `_m19*` tests without merge
// contention against this slice. The fixtures here are deliberately
// minimal — broader coverage (cross-cache UNION semantics, idempotency,
// etc.) lives in `cache/tests.rs`.
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tempfile::TempDir;

    /// Fresh in-temp-dir SQLite pool with all migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        crate::test_support::test_pool().await
    }

    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            id,
            block_type,
            content,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn fetch_all_pairs(pool: &SqlitePool) -> HashSet<(String, String)> {
        sqlx::query!("SELECT source_id, tag_id FROM block_tag_refs")
            .fetch_all(pool)
            .await
            .unwrap()
            .into_iter()
            .map(|r| (r.source_id, r.tag_id))
            .collect()
    }

    /// Build a 26-char ULID-shaped id from a 5-char prefix.
    fn ulid_like(prefix: &str, n: usize) -> String {
        // Pad with `0` to reach 26 chars; the last 6 chars encode `n` as
        // base-32 Crockford-compatible digits (0-9, A-Z minus IOLU). For
        // n < 32^6 (1B), this is unique and matches the regex
        // `[0-9A-Z]{26}`.
        let alphabet = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        let mut suffix = [b'0'; 6];
        let mut v = n;
        for ch in suffix.iter_mut().rev() {
            *ch = alphabet[v % 32];
            v /= 32;
        }
        let suffix = std::str::from_utf8(&suffix).unwrap();
        let core = format!("{prefix}{suffix}");
        // Pad to 26 with leading zeros after the prefix.
        format!("{core:0>26}")
    }

    // ----- M-19a tests -----------------------------------------------------

    #[tokio::test]
    async fn rebuild_streams_rows_without_full_vec_materialization_m19a() {
        let (pool, _dir) = test_pool().await;

        // Three real tag blocks; every source block references one or
        // two of them inline.
        let tag_a = ulid_like("TAGAA", 0);
        let tag_b = ulid_like("TAGBB", 0);
        let tag_c = ulid_like("TAGCC", 0);
        for tag in [&tag_a, &tag_b, &tag_c] {
            insert_block(&pool, tag, "tag", "tag-name").await;
        }

        // 200 source blocks. Build the expected (source_id, tag_id)
        // pairs in lockstep so we can cross-check the rebuild output
        // against the fixture data — the streaming path must produce
        // the identical set as the prior `fetch_all`-into-`Vec` path.
        let mut expected: HashSet<(String, String)> = HashSet::new();
        for i in 0..200 {
            let src = ulid_like("BLK00", i);
            // Pattern: every block references tag_a; every 3rd also
            // references tag_b; every 5th also references tag_c.
            let mut content = format!("note {i} #[{tag_a}]");
            if i % 3 == 0 {
                content.push_str(&format!(" #[{tag_b}]"));
                expected.insert((src.clone(), tag_b.clone()));
            }
            if i % 5 == 0 {
                content.push_str(&format!(" #[{tag_c}]"));
                expected.insert((src.clone(), tag_c.clone()));
            }
            insert_block(&pool, &src, "content", &content).await;
            expected.insert((src, tag_a.clone()));
        }

        let inserted = rebuild_block_tag_refs_cache_impl(&pool, &pool)
            .await
            .unwrap();

        let actual = fetch_all_pairs(&pool).await;
        assert_eq!(
            actual, expected,
            "streamed rebuild must produce the identical (source_id, tag_id) set"
        );
        assert_eq!(
            usize::try_from(inserted).expect("inserted count fits usize"),
            expected.len(),
            "inserted count must equal the number of distinct pairs"
        );
    }

    #[tokio::test]
    async fn rebuild_with_no_blocks_emits_zero_rows_m19a() {
        let (pool, _dir) = test_pool().await;

        let inserted = rebuild_block_tag_refs_cache_impl(&pool, &pool)
            .await
            .unwrap();

        assert_eq!(inserted, 0, "empty fixture must insert zero rows");
        let count: i64 = sqlx::query_scalar!("SELECT COUNT(*) FROM block_tag_refs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0, "block_tag_refs must be empty after rebuild");
    }

    #[tokio::test]
    async fn rebuild_dedupes_repeated_refs_in_same_block_m19a() {
        let (pool, _dir) = test_pool().await;

        let tag_x = ulid_like("TAGXX", 0);
        let src = ulid_like("SRCDD", 0);
        insert_block(&pool, &tag_x, "tag", "x").await;
        // Three references to the same tag inside one block.
        let content = format!("#[{tag_x}] #[{tag_x}] #[{tag_x}]");
        insert_block(&pool, &src, "content", &content).await;

        let inserted = rebuild_block_tag_refs_cache_impl(&pool, &pool)
            .await
            .unwrap();

        assert_eq!(
            inserted, 1,
            "repeated `#[ULID]` tokens in the same block must collapse to one row"
        );
        let pairs = fetch_all_pairs(&pool).await;
        let mut expected = HashSet::new();
        expected.insert((src, tag_x));
        assert_eq!(pairs, expected, "exactly one (source, tag) row");
    }

    #[tokio::test]
    async fn rebuild_skips_deleted_blocks_m19a() {
        let (pool, _dir) = test_pool().await;

        let tag = ulid_like("TAGEE", 0);
        let healthy = ulid_like("HEALT", 0);
        let deleted = ulid_like("DELET", 0);

        insert_block(&pool, &tag, "tag", "t").await;
        insert_block(&pool, &healthy, "content", &format!("#[{tag}]")).await;
        insert_block(&pool, &deleted, "content", &format!("#[{tag}]")).await;

        // Soft-delete one source.
        let now: i64 = 1_736_942_400_000;
        sqlx::query!(
            "UPDATE blocks SET deleted_at = ? WHERE id = ?",
            now,
            deleted,
        )
        .execute(&pool)
        .await
        .unwrap();

        let inserted = rebuild_block_tag_refs_cache_impl(&pool, &pool)
            .await
            .unwrap();

        assert_eq!(
            inserted, 1,
            "only the healthy source must produce a row (deleted excluded)"
        );
        let pairs = fetch_all_pairs(&pool).await;
        let mut expected = HashSet::new();
        expected.insert((healthy, tag));
        assert_eq!(
            pairs, expected,
            "row set must contain exactly the healthy source's reference"
        );
    }

    // ----- tests --------------------------------------------------------

    /// Seed 100 source blocks each referencing one tag → rebuild →
    /// mutate (some add new refs, some remove refs, some keep refs) →
    /// rebuild → assert cache reflects new source state and that only
    /// the diff is touched.
    #[tokio::test]
    async fn rebuild_block_tag_refs_incremental_parity_m2() {
        let (pool, _dir) = test_pool().await;

        // 5 real tag blocks.
        let tag_a = ulid_like("TAGAA", 0);
        let tag_b = ulid_like("TAGBB", 0);
        let tag_c = ulid_like("TAGCC", 0);
        let tag_d = ulid_like("TAGDD", 0);
        let tag_e = ulid_like("TAGEE", 0);
        for tag in [&tag_a, &tag_b, &tag_c, &tag_d, &tag_e] {
            insert_block(&pool, tag, "tag", "tag-name").await;
        }

        // 100 source blocks each referencing tag_a.
        let mut sources: Vec<String> = Vec::with_capacity(100);
        for i in 0..100 {
            let src = ulid_like("BLKM2", i);
            insert_block(&pool, &src, "content", &format!("note {i} #[{tag_a}]")).await;
            sources.push(src);
        }

        // Baseline rebuild.
        let first = rebuild_block_tag_refs_cache_impl(&pool, &pool)
            .await
            .unwrap();
        assert_eq!(first, 100, "baseline inserts 100 rows");
        let baseline = fetch_all_pairs(&pool).await;
        assert_eq!(baseline.len(), 100, "baseline cache has 100 pairs");

        // Mutate the source data:
        //   A) sources[0..10] gain an additional ref to tag_b.
        //      → 10 new rows (existing rows unchanged).
        //   B) sources[10..20] gain refs to tag_c AND tag_d.
        //      → 20 new rows.
        //   C) sources[20..25] lose tag_a (content rewritten without
        //      the `#[ULID]` token) → 5 deletes.
        //   D) 5 brand-new source blocks added (each referencing tag_e).
        //      → 5 new rows.
        for (i, src) in sources.iter().enumerate().take(10) {
            let content = format!("note {i} #[{tag_a}] #[{tag_b}]");
            sqlx::query!("UPDATE blocks SET content = ? WHERE id = ?", content, src,)
                .execute(&pool)
                .await
                .unwrap();
        }
        for (i, src) in sources.iter().enumerate().take(20).skip(10) {
            let content = format!("note {i} #[{tag_a}] #[{tag_c}] #[{tag_d}]");
            sqlx::query!("UPDATE blocks SET content = ? WHERE id = ?", content, src,)
                .execute(&pool)
                .await
                .unwrap();
        }
        for (i, src) in sources.iter().enumerate().take(25).skip(20) {
            let content = format!("note {i} (no refs anymore)");
            sqlx::query!("UPDATE blocks SET content = ? WHERE id = ?", content, src,)
                .execute(&pool)
                .await
                .unwrap();
        }
        let mut new_sources: Vec<String> = Vec::with_capacity(5);
        for i in 0..5 {
            let src = ulid_like("NEWM2", i);
            insert_block(&pool, &src, "content", &format!("new {i} #[{tag_e}]")).await;
            new_sources.push(src);
        }

        // Incremental rebuild:
        //   inserts: 10 (A) + 20 (B) + 5 (D) = 35
        //   deletes: 5 (C — sources 20..25 lose tag_a)
        //   total logical changes: 40
        let touched = rebuild_block_tag_refs_cache_impl(&pool, &pool)
            .await
            .unwrap();
        assert_eq!(touched, 40, "diff = 35 inserts + 5 deletes");

        // Build the expected set straight from the mutated source data.
        let mut expected: HashSet<(String, String)> = HashSet::new();
        for (i, src) in sources.iter().enumerate() {
            if (20..25).contains(&i) {
                continue; // tag_a removed, no other refs.
            }
            expected.insert((src.clone(), tag_a.clone()));
            if i < 10 {
                expected.insert((src.clone(), tag_b.clone()));
            }
            if (10..20).contains(&i) {
                expected.insert((src.clone(), tag_c.clone()));
                expected.insert((src.clone(), tag_d.clone()));
            }
        }
        for src in &new_sources {
            expected.insert((src.clone(), tag_e.clone()));
        }

        let actual = fetch_all_pairs(&pool).await;
        assert_eq!(
            actual, expected,
            "cache must reflect mutated source state exactly"
        );
    }

    /// Rebuild on unchanged source produces zero diff ops.
    #[tokio::test]
    async fn rebuild_block_tag_refs_idempotent_m2() {
        let (pool, _dir) = test_pool().await;

        let tag = ulid_like("TAGID", 0);
        insert_block(&pool, &tag, "tag", "t").await;
        for i in 0..30 {
            let src = ulid_like("IDEMS", i);
            insert_block(&pool, &src, "content", &format!("#[{tag}]")).await;
        }

        let first = rebuild_block_tag_refs_cache_impl(&pool, &pool)
            .await
            .unwrap();
        assert_eq!(first, 30, "baseline inserts 30 rows");

        let second = rebuild_block_tag_refs_cache_impl(&pool, &pool)
            .await
            .unwrap();
        assert_eq!(second, 0, "idempotent rebuild must produce zero diff ops");
        assert_eq!(
            fetch_all_pairs(&pool).await.len(),
            30,
            "row count preserved on idempotent rebuild"
        );
    }

    /// The rebuild [`rebuild_block_tag_refs_cache_split`] replaced, as it
    /// was: it took the writer lock, then scanned every block and the whole
    /// cache and wrote the difference. The oracle the split is tested
    /// against (#6522).
    mod replaced {
        use super::super::*;

        async fn compute_desired_pairs(
            conn: &mut sqlx::SqliteConnection,
        ) -> Result<Vec<(String, String)>, AppError> {
            let tag_ids: HashSet<String> = sqlx::query_scalar!(
                "SELECT id FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL"
            )
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();

            // #375 / #678: resolve every live block's space once so the full rebuild
            // applies the SAME cross-space exclusion the incremental
            // `reindex_block_tag_refs` pushes into its INSERT. Without this, a full
            // rebuild (snapshot restore, boot empty-table fallback, explicit "rebuild
            // caches") re-admits exactly the cross-space tag-refs the incremental path
            // is careful to exclude.
            //
            // #678 — this query MUST mirror `space::resolve_block_space`'s SQL, which
            // is `COALESCE(b.space_id, p.space_id)` via a LEFT JOIN to the owning page
            // (`blocks.page_id`). The previous bare `b.space_id` lacked that page
            // fallback its own comment claimed, so a block whose own `space_id` is not
            // yet materialised — e.g. inside the brief space-propagation gap post-#533,
            // where `page_id` is stamped but `space_id` is set by a later task —
            // resolved NULL ("unscoped") in the rebuild while the incremental path
            // resolved the page's space. That is precisely the rebuild-vs-incremental
            // divergence the #375 comment says this code exists to prevent. The page
            // join carries the same `deleted_at IS NULL` guard as `resolve_block_space`.
            // A NULL space means "unscoped".
            let space_of: std::collections::HashMap<String, Option<String>> = sqlx::query!(
                r#"SELECT b.id AS "id!", COALESCE(b.space_id, p.space_id) AS "space?"
                   FROM blocks b
                   LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
                   WHERE b.deleted_at IS NULL"#
            )
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .map(|r| (r.id, r.space))
            .collect();

            let re = crate::cache::tag_ref_re();
            let mut pairs: HashSet<(String, String)> = HashSet::new();
            {
                let mut stream = sqlx::query!(
                    "SELECT id, content FROM blocks \
                     WHERE deleted_at IS NULL AND content IS NOT NULL"
                )
                .fetch(&mut *conn);
                while let Some(row) = stream.try_next().await? {
                    let content = row.content.as_deref().unwrap_or("");
                    // Source space: `None` (unscoped) keeps every tag, mirroring the
                    // incremental `?3 IS NULL` branch; otherwise a tag is kept only if
                    // its own resolved space equals the source's (a NULL tag space is
                    // dropped, exactly as `NULL = ?3` evaluates falsy).
                    let src_space = space_of.get(&row.id).cloned().flatten();
                    for cap in re.captures_iter(content) {
                        let tag_id = cap[1].to_string();
                        if !tag_ids.contains(&tag_id) {
                            continue;
                        }
                        let same_space = match &src_space {
                            None => true,
                            Some(s) => space_of.get(&tag_id).and_then(Option::as_ref) == Some(s),
                        };
                        if same_space {
                            pairs.insert((row.id.clone(), tag_id));
                        }
                    }
                }
            }

            let mut sorted: Vec<(String, String)> = pairs.into_iter().collect();
            sorted.sort();
            Ok(sorted)
        }

        async fn diff_against_current(
            desired_sorted: &[(String, String)],
            current_conn: &mut sqlx::SqliteConnection,
            write_conn: &mut sqlx::SqliteConnection,
        ) -> Result<u64, AppError> {
            let mut current_stream = sqlx::query!(
                "SELECT source_id, tag_id FROM block_tag_refs ORDER BY source_id ASC, tag_id ASC",
            )
            .map(|r| (r.source_id, r.tag_id))
            .fetch(current_conn);

            let mut deletes: Vec<(String, String)> = Vec::new();
            let mut inserts: Vec<(String, String)> = Vec::new();
            let mut changed: u64 = 0;

            let mut d_iter = desired_sorted.iter();
            let mut next_desired: Option<&(String, String)> = d_iter.next();
            let mut next_current: Option<(String, String)> = current_stream.try_next().await?;

            loop {
                match (next_desired, &next_current) {
                    (None, None) => break,
                    (Some(d), None) => {
                        inserts.push(d.clone());
                        changed += 1;
                        next_desired = d_iter.next();
                    }
                    (None, Some(c)) => {
                        deletes.push(c.clone());
                        changed += 1;
                        next_current = current_stream.try_next().await?;
                    }
                    (Some(d), Some(c)) => match d.cmp(c) {
                        std::cmp::Ordering::Less => {
                            inserts.push(d.clone());
                            changed += 1;
                            next_desired = d_iter.next();
                        }
                        std::cmp::Ordering::Greater => {
                            deletes.push(c.clone());
                            changed += 1;
                            next_current = current_stream.try_next().await?;
                        }
                        std::cmp::Ordering::Equal => {
                            next_desired = d_iter.next();
                            next_current = current_stream.try_next().await?;
                        }
                    },
                }
            }

            drop(current_stream);

            if !deletes.is_empty() || !inserts.is_empty() {
                apply_block_tag_refs_diff(write_conn, &deletes, &inserts).await?;
            }

            Ok(changed)
        }

        pub(super) async fn rebuild_block_tag_refs_cache_impl(
            pool: &SqlitePool,
        ) -> Result<u64, AppError> {
            // Two readers (desired-pairs computation + current cache stream)
            // plus a writer tx. Distinct connections required so the streams'
            // mutable borrows don't conflict. Snapshot consistency across the
            // three is not required: same stale-while-revalidate semantics as
            // `rebuild_agenda_cache_impl` (M-19b).
            let mut desired_conn = pool.acquire().await?;
            let mut current_conn = pool.acquire().await?;
            let mut tx =
                crate::db::begin_immediate_logged(pool, "cache_block_tag_refs_rebuild").await?;

            let desired_sorted = compute_desired_pairs(&mut desired_conn).await?;
            let changed = diff_against_current(&desired_sorted, &mut current_conn, &mut tx).await?;

            if changed == 0 {
                return Ok(0);
            }

            tx.commit().await?;
            Ok(changed)
        }
    }

    /// Two tags in one space and one in another, sources that name them, and
    /// cache rows that are missing (SRC's), left behind (GONE's, for a tag it
    /// no longer names) and right (KEPT's).
    async fn seed_tag_ref_drift(pool: &SqlitePool) -> [String; 3] {
        let tags = [
            ulid_like("TAGAA", 0),
            ulid_like("TAGBB", 0),
            ulid_like("TAGCC", 0),
        ];
        let [tag_a, tag_b, tag_other] = &tags;
        sqlx::query("INSERT INTO blocks (id, block_type, content, page_id) VALUES ('SPA', 'page', 'a', 'SPA'), ('SPB', 'page', 'b', 'SPB')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO spaces (id) VALUES ('SPA'), ('SPB')")
            .execute(pool)
            .await
            .unwrap();
        for (id, block_type, content, space) in [
            (tag_a.as_str(), "tag", "a".to_owned(), "SPA"),
            (tag_b.as_str(), "tag", "b".to_owned(), "SPA"),
            (tag_other.as_str(), "tag", "other".to_owned(), "SPB"),
            (
                "SRC",
                "content",
                format!("#[{tag_a}] #[{tag_b}] #[{tag_other}]"),
                "SPA",
            ),
            ("GONE", "content", format!("#[{tag_a}]"), "SPA"),
            ("KEPT", "content", format!("#[{tag_b}]"), "SPA"),
        ] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, space_id) VALUES (?, ?, ?, ?)",
            )
            .bind(id)
            .bind(block_type)
            .bind(content)
            .bind(space)
            .execute(pool)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES ('GONE', ?), ('GONE', ?), ('KEPT', ?)")
            .bind(tag_a)
            .bind(tag_b)
            .bind(tag_b)
            .execute(pool)
            .await
            .unwrap();
        tags
    }

    async fn sorted_pairs(pool: &SqlitePool) -> Vec<(String, String)> {
        let mut pairs: Vec<_> = fetch_all_pairs(pool).await.into_iter().collect();
        pairs.sort();
        pairs
    }

    /// #6522: the split rebuild leaves `block_tag_refs` where the rebuild it
    /// replaced does, and changes the same pairs.
    #[tokio::test]
    async fn rebuild_block_tag_refs_split_matches_the_rebuild_it_replaced_6522() {
        let (oracle_pool, _oracle_dir) = test_pool().await;
        let (pool, _dir) = test_pool().await;
        seed_tag_ref_drift(&oracle_pool).await;
        let [tag_a, tag_b, _] = seed_tag_ref_drift(&pool).await;

        let oracle_changed = replaced::rebuild_block_tag_refs_cache_impl(&oracle_pool)
            .await
            .unwrap();
        let changed = rebuild_block_tag_refs_cache_impl(&pool, &pool)
            .await
            .unwrap();

        assert_eq!(
            oracle_changed, 3,
            "SRC's two same-space pairs, and GONE's pair for the tag it does not name"
        );
        assert_eq!(changed, oracle_changed);
        assert_eq!(sorted_pairs(&pool).await, sorted_pairs(&oracle_pool).await);
        let pair = |source: &str, tag: &String| (source.to_owned(), tag.clone());
        assert_eq!(
            sorted_pairs(&pool).await,
            vec![
                pair("GONE", &tag_a),
                pair("KEPT", &tag_b),
                pair("SRC", &tag_a),
                pair("SRC", &tag_b),
            ],
        );
        assert_eq!(
            rebuild_block_tag_refs_cache_impl(&pool, &pool)
                .await
                .unwrap(),
            0,
            "a second run finds nothing stale"
        );
    }

    /// #6522: the same, after every round of random writes to the tables the
    /// rebuild reads and to the cache itself.
    #[tokio::test]
    async fn rebuild_block_tag_refs_split_matches_the_rebuild_it_replaced_on_random_vaults_6522() {
        crate::cache::random_vault_tests::assert_rebuild_matches_oracle(
            "block_tag_refs",
            "source_id, tag_id",
            async |pool| {
                replaced::rebuild_block_tag_refs_cache_impl(pool)
                    .await
                    .unwrap()
            },
            async |pool| rebuild_block_tag_refs_cache_impl(pool, pool).await.unwrap(),
        )
        .await;
    }

    /// #6522: the write half re-derives only the sources it is handed, from
    /// the content they hold when it runs.
    #[tokio::test]
    async fn rederive_tag_refs_of_touches_only_the_sources_named_6522() {
        let (pool, _dir) = test_pool().await;
        let [tag_a, tag_b, _] = seed_tag_ref_drift(&pool).await;
        assert_eq!(
            sources_with_stale_tag_refs(&pool).await.unwrap(),
            ["GONE", "SRC"]
        );
        // A write lands after the read half: SRC stops naming tag B.
        sqlx::query("UPDATE blocks SET content = ? WHERE id = 'SRC'")
            .bind(format!("#[{tag_a}]"))
            .execute(&pool)
            .await
            .unwrap();

        let mut tx = pool.begin().await.unwrap();
        let changed = rederive_tag_refs_of(&mut tx, &["SRC".to_owned(), "KEPT".to_owned()])
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(changed, 1, "SRC's one pair; KEPT was not stale");
        let pair = |source: &str, tag: &String| (source.to_owned(), tag.clone());
        assert_eq!(
            sorted_pairs(&pool).await,
            vec![
                pair("GONE", &tag_a),
                pair("GONE", &tag_b),
                pair("KEPT", &tag_b),
                pair("SRC", &tag_a),
            ],
            "SRC takes the pairs its content gives now, and GONE, not named, keeps its planted pair"
        );
    }

    /// #6522: with nothing stale the rebuild never asks for the writer lock,
    /// so it finishes while another connection holds it.
    #[tokio::test]
    async fn rebuild_block_tag_refs_takes_no_writer_lock_when_nothing_is_stale_6522() {
        let (pool, _dir) = test_pool().await;
        seed_tag_ref_drift(&pool).await;
        rebuild_block_tag_refs_cache(&pool).await.unwrap();

        let _writer = crate::db::begin_immediate_logged(&pool, "test_holds_the_lock")
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            rebuild_block_tag_refs_cache(&pool),
        )
        .await
        .expect("the rebuild must not wait for the writer lock")
        .unwrap();
    }

    /// #6522: what runs under the writer lock seeks the stale sources and
    /// the tags they name by id; it never scans a table.
    #[tokio::test]
    async fn rederive_tag_refs_of_never_scans_a_table_6522() {
        use sqlx::Execute as _;
        let (pool, _dir) = test_pool().await;
        let ids = "[]".to_owned();
        let mut conn = pool.acquire().await.unwrap();
        let statements = [
            live_sources!(among ids).sql().as_str().to_owned(),
            live_tag_spaces!(among ids).sql().as_str().to_owned(),
        ];
        for sql in statements {
            let plan: Vec<(i64, i64, i64, String)> =
                sqlx::query_as(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")))
                    .bind("[]")
                    .fetch_all(&mut *conn)
                    .await
                    .unwrap();
            let scans: Vec<&str> = plan
                .iter()
                .map(|row| row.3.as_str())
                .filter(|detail| {
                    detail.starts_with("SCAN")
                        && !detail.starts_with("SCAN (subquery")
                        && !detail.contains("json_each")
                })
                .collect();
            assert!(
                scans.is_empty(),
                "scans under the writer lock in `{sql}`: {scans:?}"
            );
        }
    }
}
