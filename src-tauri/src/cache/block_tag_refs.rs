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
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL AND is_conflict = 0",
        block_id,
    )
    .fetch_optional(&mut *tx)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        // Block not found, deleted, or a conflict copy — remove all rows.
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
    let to_insert: Vec<&String> = new_targets.difference(&old_targets).collect();

    if to_delete.is_empty() && to_insert.is_empty() {
        // No changes — transaction rolls back on drop (no commit needed).
        return Ok(());
    }

    for target in &to_delete {
        sqlx::query!(
            "DELETE FROM block_tag_refs WHERE source_id = ? AND tag_id = ?",
            block_id,
            *target,
        )
        .execute(&mut *tx)
        .await?;
    }

    for target in &to_insert {
        let t = *target;
        // INSERT ... SELECT ... WHERE EXISTS — only link to blocks that
        // are actually tags. Non-tag candidates (stray IDs that happen to
        // match the regex but point at content/page blocks) are silently
        // dropped. `INSERT OR IGNORE` handles the already-present case
        // if two insert passes race (shouldn't happen inside a tx, but
        // keeps the statement idempotent).
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) \
             SELECT ?, ? WHERE EXISTS \
                 (SELECT 1 FROM blocks WHERE id = ? AND block_type = 'tag')",
            block_id,
            t,
            t,
        )
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
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL AND is_conflict = 0",
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
    for target in &to_delete {
        sqlx::query!(
            "DELETE FROM block_tag_refs WHERE source_id = ? AND tag_id = ?",
            block_id,
            *target,
        )
        .execute(&mut *tx)
        .await?;
    }
    for target in &to_insert {
        let t = *target;
        sqlx::query!(
            "INSERT OR IGNORE INTO block_tag_refs (source_id, tag_id) \
             SELECT ?, ? WHERE EXISTS \
                 (SELECT 1 FROM blocks WHERE id = ? AND block_type = 'tag')",
            block_id,
            t,
            t,
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// rebuild_block_tag_refs_cache — full recompute
// ---------------------------------------------------------------------------

/// Full recompute of `block_tag_refs`.
///
/// Scans every non-deleted, non-conflict block's content, extracts
/// `#[ULID]` tokens, filters to candidates that are real tag blocks,
/// then DELETE + chunked INSERT replaces the whole table atomically.
///
/// Intended for: migration backfill, snapshot restore, explicit "rebuild
/// caches" actions. Per-block content edits go through
/// [`reindex_block_tag_refs`] instead.
pub async fn rebuild_block_tag_refs_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("block_tag_refs", || rebuild_block_tag_refs_cache_impl(pool)).await
}

async fn rebuild_block_tag_refs_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    // Read phase (inside the same tx so we observe a consistent snapshot
    // across the DELETE and the INSERTs).
    let mut tx = pool.begin().await?;

    let tag_ids: HashSet<String> = sqlx::query_scalar!(
        "SELECT id FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL AND is_conflict = 0"
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();

    // M-19a: stream `(id, content)` rows instead of materialising every
    // non-deleted/non-conflict block's content into a `Vec<SourceRow>`.
    // The peak Rust-heap working set drops from
    // `~content-bytes-per-block × block-count` (≈100 MB on a 100 K-block
    // vault with ~1 KB content) to one row's content at a time. The
    // `(source, tag)` HashSet is bounded by the actual ref count, which
    // is much smaller than total content bytes; it remains because
    // deduplication of repeated `#[ULID]` tokens within a single block
    // still needs cross-row state.
    let re = super::tag_ref_re();
    let mut rows: HashSet<(String, String)> = HashSet::new();
    {
        let mut stream = sqlx::query!(
            "SELECT id, content FROM blocks \
             WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL"
        )
        .fetch(&mut *tx);
        while let Some(row) = stream.try_next().await? {
            let content = row.content.as_deref().unwrap_or("");
            for cap in re.captures_iter(content) {
                let tag_id = cap[1].to_string();
                if tag_ids.contains(&tag_id) {
                    rows.insert((row.id.clone(), tag_id));
                }
            }
        }
    }

    sqlx::query!("DELETE FROM block_tag_refs")
        .execute(&mut *tx)
        .await?;

    let mut inserted: u64 = 0;
    let rows_vec: Vec<(String, String)> = rows.into_iter().collect();
    for chunk in rows_vec.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_tag_refs (source_id, tag_id) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (source, tag) in chunk {
            q = q.bind(source).bind(tag);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }

    tx.commit().await?;
    Ok(inserted)
}

/// Read/write split variant of [`rebuild_block_tag_refs_cache`].
///
/// Read phase (tag IDs + block content) runs against `read_pool`; the
/// final DELETE + chunked INSERT transaction runs on `write_pool`.
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
    // Read phase — from read_pool.
    let tag_ids: HashSet<String> = sqlx::query_scalar!(
        "SELECT id FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL AND is_conflict = 0"
    )
    .fetch_all(read_pool)
    .await?
    .into_iter()
    .collect();

    // M-19a: stream `(id, content)` rows from `read_pool` instead of
    // materialising every block's content. See `rebuild_block_tag_refs_cache_impl`
    // above for the full rationale.
    let re = super::tag_ref_re();
    let mut rows: HashSet<(String, String)> = HashSet::new();
    {
        let mut stream = sqlx::query!(
            "SELECT id, content FROM blocks \
             WHERE deleted_at IS NULL AND is_conflict = 0 AND content IS NOT NULL"
        )
        .fetch(read_pool);
        while let Some(row) = stream.try_next().await? {
            let content = row.content.as_deref().unwrap_or("");
            for cap in re.captures_iter(content) {
                let tag_id = cap[1].to_string();
                if tag_ids.contains(&tag_id) {
                    rows.insert((row.id.clone(), tag_id));
                }
            }
        }
    }

    // Write phase — DELETE + chunked INSERT on write_pool.
    let mut tx = write_pool.begin().await?;
    sqlx::query!("DELETE FROM block_tag_refs")
        .execute(&mut *tx)
        .await?;

    let mut inserted: u64 = 0;
    let rows_vec: Vec<(String, String)> = rows.into_iter().collect();
    for chunk in rows_vec.chunks(REBUILD_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "INSERT INTO block_tag_refs (source_id, tag_id) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(&sql);
        for (source, tag) in chunk {
            q = q.bind(source).bind(tag);
        }
        let res = q.execute(&mut *tx).await?;
        inserted += res.rows_affected();
    }
    tx.commit().await?;
    Ok(inserted)
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
    async fn rebuild_skips_deleted_and_conflict_blocks_m19a() {
        let (pool, _dir) = test_pool().await;

        let tag = ulid_like("TAGEE", 0);
        let healthy = ulid_like("HEALT", 0);
        let deleted = ulid_like("DELET", 0);
        let conflict = ulid_like("CONFL", 0);

        insert_block(&pool, &tag, "tag", "t").await;
        insert_block(&pool, &healthy, "content", &format!("#[{tag}]")).await;
        insert_block(&pool, &deleted, "content", &format!("#[{tag}]")).await;
        insert_block(&pool, &conflict, "content", &format!("#[{tag}]")).await;

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
        // Mark the other as a conflict copy.
        sqlx::query!("UPDATE blocks SET is_conflict = 1 WHERE id = ?", conflict)
            .execute(&pool)
            .await
            .unwrap();

        let inserted = rebuild_block_tag_refs_cache_impl(&pool).await.unwrap();

        assert_eq!(
            inserted, 1,
            "only the healthy source must produce a row (deleted + conflict excluded)"
        );
        let pairs = fetch_all_pairs(&pool).await;
        let mut expected = HashSet::new();
        expected.insert((healthy, tag));
        assert_eq!(
            pairs, expected,
            "row set must contain exactly the healthy source's reference"
        );
    }
}
