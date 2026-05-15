//! `block_tag_refs` — derived-state cache for inline `#[ULID]` tag
//! references found inside block content (UX-250 Option A).
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
use std::collections::HashSet;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

/// block_tag_refs has 2 columns per row.
const REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 2; // 499

// ---------------------------------------------------------------------------
// reindex_block_tag_refs (per-block, incremental)
// ---------------------------------------------------------------------------

/// Incremental reindex of `block_tag_refs` for a single block.
///
/// 1. Read the block's current content (single transaction, consistent
///    snapshot).
/// 2. Parse all `#[ULID]` tokens via [`super::tag_ref_re`].
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
pub async fn reindex_block_tag_refs(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    let mut tx = pool.begin().await?;

    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(&mut *tx)
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
    .fetch_all(&mut *tx)
    .await?;

    let old_targets: HashSet<String> = existing_rows.into_iter().map(|r| r.tag_id).collect();

    let to_delete: Vec<&String> = old_targets.difference(&new_targets).collect();
    let mut to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    // PEND-15 Phase 3 — filter out cross-space tag-refs before inserting.
    // Tags are space-scoped (Path A); the write-time gate rejects
    // cross-space tag refs, and the cache must mirror that invariant.
    if !to_insert.is_empty() {
        let source_block_id = crate::ulid::BlockId::from_trusted(block_id);
        let source_space = crate::space::resolve_block_space(&mut *tx, &source_block_id).await?;
        if source_space.is_some() {
            let mut same_space: Vec<&String> = Vec::with_capacity(to_insert.len());
            for tag_id in &to_insert {
                let tag_block_id = crate::ulid::BlockId::from_trusted(tag_id);
                if let Ok(Some(tag_space)) =
                    crate::space::resolve_block_space(&mut *tx, &tag_block_id).await
                {
                    if Some(&tag_space) == source_space.as_ref() {
                        same_space.push(tag_id);
                    }
                }
            }
            to_insert = same_space;
        }
    }

    if to_delete.is_empty() && to_insert.is_empty() {
        // No changes — transaction rolls back on drop (no commit needed).
        return Ok(());
    }

    // PERF-24: batch DELETE/INSERT via `json_each` — one round-trip per
    // side regardless of the number of changed targets, replacing the
    // previous 2N round-trip per-target loops. Mirrors the
    // `cache/block_links.rs` pattern.
    if !to_delete.is_empty() {
        let delete_json = serde_json::to_string(&to_delete)?;
        sqlx::query(
            "DELETE FROM block_tag_refs \
             WHERE source_id = ? \
               AND tag_id IN (SELECT value FROM json_each(?))",
        )
        .bind(block_id)
        .bind(&delete_json)
        .execute(&mut *tx)
        .await?;
    }

    if !to_insert.is_empty() {
        // INSERT ... SELECT ... WHERE EXISTS — only link to blocks that
        // are actually tags. Non-tag candidates (stray IDs that happen to
        // match the regex but point at content/page blocks) are silently
        // dropped. `INSERT OR IGNORE` handles the already-present case
        // if two insert passes race (shouldn't happen inside a tx, but
        // keeps the statement idempotent).
        let insert_json = serde_json::to_string(&to_insert)?;
        sqlx::query(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) \
             SELECT ?, value FROM json_each(?) \
             WHERE EXISTS \
                 (SELECT 1 FROM blocks WHERE id = value AND block_type = 'tag')",
        )
        .bind(block_id)
        .bind(&insert_json)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

/// Read/write split variant of [`reindex_block_tag_refs`].
///
/// Reads content and existing rows from `read_pool`; diffs and applies
/// inserts/deletes on `write_pool`. Matches the shape of
/// [`super::reindex_block_links_split`].
pub async fn reindex_block_tag_refs_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
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

    if to_delete.is_empty() && to_insert.is_empty() {
        return Ok(());
    }

    // Write phase on write_pool.
    let mut tx = write_pool.begin().await?;

    // PERF-24: batch DELETE/INSERT via `json_each` — one round-trip per
    // side regardless of the number of changed targets, replacing the
    // previous 2N round-trip per-target loops. Mirrors the
    // `cache/block_links.rs` pattern.
    if !to_delete.is_empty() {
        let delete_json = serde_json::to_string(&to_delete)?;
        sqlx::query(
            "DELETE FROM block_tag_refs \
             WHERE source_id = ? \
               AND tag_id IN (SELECT value FROM json_each(?))",
        )
        .bind(block_id)
        .bind(&delete_json)
        .execute(&mut *tx)
        .await?;
    }

    if !to_insert.is_empty() {
        // INSERT ... SELECT ... WHERE EXISTS — only link to blocks that
        // are actually tags. Non-tag candidates (stray IDs that happen to
        // match the regex but point at content/page blocks) are silently
        // dropped.
        let insert_json = serde_json::to_string(&to_insert)?;
        sqlx::query(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) \
             SELECT ?, value FROM json_each(?) \
             WHERE EXISTS \
                 (SELECT 1 FROM blocks WHERE id = value AND block_type = 'tag')",
        )
        .bind(block_id)
        .bind(&insert_json)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// rebuild_block_tag_refs_cache — incremental sort-merge (M-2)
// ---------------------------------------------------------------------------

// DELETE binds 2 cols per row (source_id, tag_id) → `MAX_SQL_PARAMS / 2 = 499`.
// INSERT binds 2 cols per row → same 499. (REBUILD_CHUNK above is already 499.)
const DELETE_CHUNK: usize = MAX_SQL_PARAMS / 2; // 499

/// Compute the desired set of `(source_id, tag_id)` pairs from the live
/// database. Returns a `Vec` sorted by `(source_id, tag_id)` so the
/// sort-merge diff can walk it alongside the current cache stream
/// (which the SQL `ORDER BY` sorts identically).
///
/// Streams `(id, content)` rows (M-19a) so the peak working set is
/// `O(actual ref count + tag-id set)` rather than `O(total content bytes)`.
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

    let re = super::tag_ref_re();
    let mut pairs: HashSet<(String, String)> = HashSet::new();
    {
        let mut stream = sqlx::query!(
            "SELECT id, content FROM blocks \
             WHERE deleted_at IS NULL AND content IS NOT NULL"
        )
        .fetch(&mut *conn);
        while let Some(row) = stream.try_next().await? {
            let content = row.content.as_deref().unwrap_or("");
            for cap in re.captures_iter(content) {
                let tag_id = cap[1].to_string();
                if tag_ids.contains(&tag_id) {
                    pairs.insert((row.id.clone(), tag_id));
                }
            }
        }
    }

    let mut sorted: Vec<(String, String)> = pairs.into_iter().collect();
    sorted.sort();
    Ok(sorted)
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
        let mut q = sqlx::query(&sql);
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
        let mut q = sqlx::query(&sql);
        for (source, tag) in chunk {
            q = q.bind(source).bind(tag);
        }
        q.execute(&mut *conn).await?;
    }

    Ok(())
}

/// Stream-walk the desired and current `block_tag_refs` pairs in
/// lockstep against the current cache stream:
///   - PK in NEW not in OLD → INSERT.
///   - PK in OLD not in NEW → DELETE.
///   - PK in both → no-op (the table has no non-PK columns to update).
///
/// Both inputs share the sort key `(source_id, tag_id)`. Diff rows are
/// accumulated into `Vec`s and flushed at end-of-stream as one chunked
/// DELETE + chunked INSERT pair.
async fn diff_against_current(
    desired_sorted: &[(String, String)],
    current_conn: &mut sqlx::SqliteConnection,
    write_conn: &mut sqlx::SqliteConnection,
) -> Result<u64, AppError> {
    let mut current_stream = sqlx::query_as::<_, (String, String)>(
        "SELECT source_id, tag_id FROM block_tag_refs ORDER BY source_id ASC, tag_id ASC",
    )
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

/// Incremental rebuild of `block_tag_refs` (M-2 — was full DELETE +
/// INSERT pre-refactor).
///
/// Scans every non-deleted, non-conflict block's content, extracts
/// `#[ULID]` tokens, filters to candidates that are real tag blocks,
/// sorts the result, then sort-merge diffs against the current cache
/// and applies only the changed rows.
///
/// Intended for: migration backfill, snapshot restore, explicit "rebuild
/// caches" actions. Per-block content edits still go through
/// [`reindex_block_tag_refs`] instead.
pub async fn rebuild_block_tag_refs_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("block_tag_refs", || rebuild_block_tag_refs_cache_impl(pool)).await
}

async fn rebuild_block_tag_refs_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    // Two readers (desired-pairs computation + current cache stream)
    // plus a writer tx. Distinct connections required so the streams'
    // mutable borrows don't conflict. Snapshot consistency across the
    // three is not required: same stale-while-revalidate semantics as
    // `rebuild_agenda_cache_impl` (M-19b).
    let mut desired_conn = pool.acquire().await?;
    let mut current_conn = pool.acquire().await?;
    let mut tx = pool.begin().await?;

    let desired_sorted = compute_desired_pairs(&mut desired_conn).await?;
    let changed = diff_against_current(&desired_sorted, &mut current_conn, &mut tx).await?;

    if changed == 0 {
        return Ok(0);
    }

    tx.commit().await?;
    Ok(changed)
}

/// Read/write split variant of [`rebuild_block_tag_refs_cache`] (M-2).
///
/// Desired-pairs computation and the current-cache stream both read
/// from `read_pool`; the final chunked DELETE + INSERT transaction runs
/// on `write_pool`.
pub async fn rebuild_block_tag_refs_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("block_tag_refs", || {
        rebuild_block_tag_refs_cache_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_block_tag_refs_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    let mut desired_conn = read_pool.acquire().await?;
    let mut current_conn = read_pool.acquire().await?;
    let mut tx = write_pool.begin().await?;

    let desired_sorted = compute_desired_pairs(&mut desired_conn).await?;
    let changed = diff_against_current(&desired_sorted, &mut current_conn, &mut tx).await?;

    if changed == 0 {
        return Ok(0);
    }

    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// M-19a — streaming-rebuild correctness tests
// ---------------------------------------------------------------------------
//
// These tests are intentionally local to this file rather than appended
// to `cache/tests.rs` so that sibling M-19 subagents (agenda /
// projected_agenda) can append their own `_m19*` tests without merge
// contention against this slice. The fixtures here are deliberately
// minimal — broader coverage (cross-cache UNION semantics, idempotency,
// etc.) lives in `cache/tests.rs`.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Fresh in-temp-dir SQLite pool with all migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
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
        format!("{:0>26}", core)
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

        let inserted = rebuild_block_tag_refs_cache_impl(&pool).await.unwrap();

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

        let inserted = rebuild_block_tag_refs_cache_impl(&pool).await.unwrap();

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

        let inserted = rebuild_block_tag_refs_cache_impl(&pool).await.unwrap();

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
        let now = "2025-01-15T12:00:00+00:00";
        sqlx::query!(
            "UPDATE blocks SET deleted_at = ? WHERE id = ?",
            now,
            deleted,
        )
        .execute(&pool)
        .await
        .unwrap();

        let inserted = rebuild_block_tag_refs_cache_impl(&pool).await.unwrap();

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

    // ----- M-2 tests --------------------------------------------------------

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
        let first = rebuild_block_tag_refs_cache_impl(&pool).await.unwrap();
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
        let touched = rebuild_block_tag_refs_cache_impl(&pool).await.unwrap();
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

        let first = rebuild_block_tag_refs_cache_impl(&pool).await.unwrap();
        assert_eq!(first, 30, "baseline inserts 30 rows");

        let second = rebuild_block_tag_refs_cache_impl(&pool).await.unwrap();
        assert_eq!(second, 0, "idempotent rebuild must produce zero diff ops");
        assert_eq!(
            fetch_all_pairs(&pool).await.len(),
            30,
            "row count preserved on idempotent rebuild"
        );
    }
}
