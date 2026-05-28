use futures_util::TryStreamExt;
use sqlx::SqlitePool;
use std::cmp::Ordering;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

// `pages_cache` has 3 columns per row (page_id, title, updated_at) →
// `MAX_SQL_PARAMS / 3 = 333` rows per chunk for INSERT. DELETE binds 1
// column (page_id) → `MAX_SQL_PARAMS / 1 = 999` rows per chunk.
const INSERT_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333
const DELETE_CHUNK: usize = MAX_SQL_PARAMS; // 999

// ---------------------------------------------------------------------------
// Desired-state SQL (M-2)
// ---------------------------------------------------------------------------

/// Projection that computes the desired state of `pages_cache` from the
/// live database. Bound from both [`rebuild_pages_cache_impl`] (single
/// pool) and [`rebuild_pages_cache_split_impl`] (read/write split) so
/// the two implementations cannot silently diverge.
///
/// Filter: `block_type = 'page'`, not soft-deleted, non-NULL content.
/// Output is sorted by `id ASC` so the sort-merge diff in
/// [`apply_sort_merge_rebuild`] can walk this stream alongside
/// `pages_cache` (also `ORDER BY page_id ASC`) in lockstep.
const DESIRED_PAGES_SQL: &str = "SELECT id, content
         FROM blocks
         WHERE block_type = 'page' AND deleted_at IS NULL AND content IS NOT NULL
         ORDER BY id ASC";

const CURRENT_PAGES_SQL: &str = "SELECT page_id, title FROM pages_cache ORDER BY page_id ASC";

// ---------------------------------------------------------------------------
// Apply diff (M-2)
// ---------------------------------------------------------------------------

/// Apply a pages diff inside an open transaction in chunks bounded by
/// [`MAX_SQL_PARAMS`].
///
/// `delete_ids` and `insert_rows` are caller-owned and may be empty.
/// DELETEs run first then INSERTs so an UPDATE encoded as DELETE+INSERT
/// is safe under the PK (`page_id`).
///
/// `INSERT OR IGNORE` matches the pre-M-2 full-rebuild and split-variant
/// shape; the preceding DELETE for any UPDATEd PK ensures no PK conflict
/// in practice, but the IGNORE form documents intent and stays robust
/// against split-pool TOCTOU drift (a row another writer just inserted).
async fn apply_pages_diff(
    conn: &mut sqlx::SqliteConnection,
    delete_ids: &[String],
    insert_rows: &[(String, String)],
    now: &str,
) -> Result<(), AppError> {
    for chunk in delete_ids.chunks(DELETE_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "?").collect();
        let sql = format!(
            "DELETE FROM pages_cache WHERE page_id IN ({})",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for id in chunk {
            q = q.bind(id);
        }
        q.execute(&mut *conn).await?;
    }

    for chunk in insert_rows.chunks(INSERT_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO pages_cache (page_id, title, updated_at) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for (page_id, title) in chunk {
            q = q.bind(page_id).bind(title).bind(now);
        }
        q.execute(&mut *conn).await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Sort-merge rebuild core (M-2)
// ---------------------------------------------------------------------------

/// Stream-walk the desired and current pages rows in lockstep, computing
/// a diff:
///   - PK in NEW not in OLD → INSERT.
///   - PK in OLD not in NEW → DELETE.
///   - PK in both, title differs → DELETE + INSERT (UPDATE via the PK).
///   - PK in both, title equal → no-op (preserves the prior `updated_at`,
///     which is the whole point of incremental: writes are skipped for
///     unchanged rows).
///
/// Both streams share the sort key `page_id ASC` so the merge runs in
/// `O(n)` time. Diff rows are accumulated into `Vec`s and flushed once
/// at the end via a single chunked DELETE + chunked INSERT pair — this
/// keeps the apply phase one logical DELETE+INSERT (matching pre-M-2
/// semantics) and avoids any mid-stream ordering hazards when an UPDATE
/// is encoded as DELETE+INSERT.
async fn apply_sort_merge_rebuild(
    desired_conn: &mut sqlx::SqliteConnection,
    current_conn: &mut sqlx::SqliteConnection,
    write_conn: &mut sqlx::SqliteConnection,
    now: &str,
) -> Result<u64, AppError> {
    let mut desired_stream =
        sqlx::query_as::<_, (String, String)>(DESIRED_PAGES_SQL).fetch(desired_conn);
    let mut current_stream =
        sqlx::query_as::<_, (String, String)>(CURRENT_PAGES_SQL).fetch(current_conn);

    let mut deletes: Vec<String> = Vec::new();
    let mut inserts: Vec<(String, String)> = Vec::new();
    let mut changed: u64 = 0;

    let mut next_desired = desired_stream.try_next().await?;
    let mut next_current = current_stream.try_next().await?;

    loop {
        match (&next_desired, &next_current) {
            (None, None) => break,
            (Some((d_id, d_title)), None) => {
                // Current exhausted — pure INSERT.
                inserts.push((d_id.clone(), d_title.clone()));
                changed += 1;
                next_desired = desired_stream.try_next().await?;
            }
            (None, Some((c_id, _))) => {
                // Desired exhausted — pure DELETE.
                deletes.push(c_id.clone());
                changed += 1;
                next_current = current_stream.try_next().await?;
            }
            (Some((d_id, d_title)), Some((c_id, c_title))) => {
                match d_id.as_str().cmp(c_id.as_str()) {
                    Ordering::Less => {
                        inserts.push((d_id.clone(), d_title.clone()));
                        changed += 1;
                        next_desired = desired_stream.try_next().await?;
                    }
                    Ordering::Greater => {
                        deletes.push(c_id.clone());
                        changed += 1;
                        next_current = current_stream.try_next().await?;
                    }
                    Ordering::Equal => {
                        if d_title != c_title {
                            // Title changed — DELETE + INSERT under PK.
                            // Counted as one logical change.
                            deletes.push(c_id.clone());
                            inserts.push((d_id.clone(), d_title.clone()));
                            changed += 1;
                        }
                        next_desired = desired_stream.try_next().await?;
                        next_current = current_stream.try_next().await?;
                    }
                }
            }
        }
    }

    // Drop readers before the apply phase.
    drop(desired_stream);
    drop(current_stream);

    if !deletes.is_empty() || !inserts.is_empty() {
        apply_pages_diff(write_conn, &deletes, &inserts, now).await?;
    }

    Ok(changed)
}

// ---------------------------------------------------------------------------
// rebuild_pages_cache (p1-t19, M-2)
// ---------------------------------------------------------------------------

/// Incremental rebuild of `pages_cache` (M-2 — was full DELETE + INSERT
/// pre-refactor).
///
/// Instead of a full `DELETE FROM pages_cache; INSERT SELECT …` two-pass
/// over every row, this function:
/// 1. Streams the desired state from `blocks` (filtered by
///    `block_type = 'page' AND deleted_at IS NULL AND content IS NOT NULL`,
///    sorted by `id ASC`).
/// 2. Streams the current cache state (sorted by `page_id ASC`).
/// 3. Walks the two streams in lockstep, accumulating INSERTs and
///    DELETEs, then applies the diff via chunked statements.
///
/// Unchanged rows are not touched — their `updated_at` is preserved.
pub async fn rebuild_pages_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("pages", || rebuild_pages_cache_impl(pool)).await
}

async fn rebuild_pages_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let now = crate::now_rfc3339();
    // Three independent connections — two readers (desired + current
    // state streams) plus one writer for the diff transaction. Distinct
    // connections are required so the streams' mutable borrows don't
    // conflict. Snapshot consistency across the three connections is not
    // required: same stale-while-revalidate semantics as
    // `rebuild_agenda_cache_impl` (M-19b).
    let mut desired_conn = pool.acquire().await?;
    let mut current_conn = pool.acquire().await?;
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_pages_rebuild").await?;

    let changed =
        apply_sort_merge_rebuild(&mut desired_conn, &mut current_conn, &mut tx, &now).await?;

    if changed == 0 {
        // No changes — transaction is rolled back on drop.
        return Ok(0);
    }

    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Read/write split variant (Phase 1A)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`rebuild_pages_cache`] (M-17, M-2).
///
/// Reads desired and current page rows from `read_pool` and applies the
/// incremental diff on `write_pool`. Mirrors the single-pool sort-merge
/// shape so semantic divergence is impossible.
///
/// Stale-while-revalidate: each read connection has its own snapshot;
/// the write tx is opened independently. Any concurrent writer mutation
/// observed by one reader but not the other is corrected on the next
/// rebuild — same eventual-consistency guarantee as
/// [`super::rebuild_agenda_cache_split`] (AGENTS.md "Performance
/// Conventions / Split read/write pool pattern").
pub async fn rebuild_pages_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("pages", || {
        rebuild_pages_cache_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_pages_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    let now = crate::now_rfc3339();
    let mut desired_conn = read_pool.acquire().await?;
    let mut current_conn = read_pool.acquire().await?;
    let mut tx = crate::db::begin_immediate_logged(write_pool, "cache_pages_rebuild_write").await?;

    let changed =
        apply_sort_merge_rebuild(&mut desired_conn, &mut current_conn, &mut tx, &now).await?;

    if changed == 0 {
        return Ok(0);
    }

    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// M-2 sort-merge tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests scoped to this file (M-2) so the parent `cache::tests`
    //! module is not touched. Helpers are local copies of the patterns
    //! in `cache/tests.rs`.
    use super::*;
    use crate::db::init_pool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn insert_page(pool: &SqlitePool, id: &str, title: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', ?)",
            id,
            title,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn update_page_title(pool: &SqlitePool, id: &str, title: &str) {
        sqlx::query!("UPDATE blocks SET content = ? WHERE id = ?", title, id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn soft_delete(pool: &SqlitePool, id: &str) {
        sqlx::query!(
            "UPDATE blocks SET deleted_at = '2025-12-31T00:00:00+00:00' WHERE id = ?",
            id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn snapshot(pool: &SqlitePool) -> Vec<(String, String)> {
        sqlx::query_as::<_, (String, String)>(
            "SELECT page_id, title FROM pages_cache ORDER BY page_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// 100 pages → rebuild → some add, some remove, some update →
    /// rebuild → assert cache reflects new source state.
    #[tokio::test]
    async fn rebuild_pages_cache_incremental_parity_m2() {
        let (pool, _dir) = test_pool().await;

        // Seed: 100 pages.
        for i in 0..100 {
            let id = format!("PAGE{i:04}");
            let title = format!("Page {i:04}");
            insert_page(&pool, &id, &title).await;
        }

        let first = rebuild_pages_cache_impl(&pool).await.unwrap();
        assert_eq!(first, 100, "baseline inserts 100 rows");
        assert_eq!(
            snapshot(&pool).await.len(),
            100,
            "baseline cache has 100 rows"
        );

        // Mutate: 5 add, 5 remove (soft-delete), 10 update title.
        for i in 0..10 {
            let id = format!("PAGE{i:04}");
            let title = format!("Renamed {i:04}");
            update_page_title(&pool, &id, &title).await;
        }
        for i in 90..95 {
            let id = format!("PAGE{i:04}");
            soft_delete(&pool, &id).await;
        }
        for i in 100..105 {
            let id = format!("PAGE{i:04}");
            let title = format!("New Page {i:04}");
            insert_page(&pool, &id, &title).await;
        }

        let touched = rebuild_pages_cache_impl(&pool).await.unwrap();
        // 10 updates + 5 deletes + 5 inserts = 20 logical changes.
        assert_eq!(touched, 20, "diff = 10 updates + 5 deletes + 5 inserts");

        // Build the expected set straight from the source data.
        let mut expected: Vec<(String, String)> = Vec::new();
        for i in 0..100 {
            let id = format!("PAGE{i:04}");
            if (90..95).contains(&i) {
                continue; // deleted
            }
            let title = if i < 10 {
                format!("Renamed {i:04}")
            } else {
                format!("Page {i:04}")
            };
            expected.push((id, title));
        }
        for i in 100..105 {
            let id = format!("PAGE{i:04}");
            expected.push((id, format!("New Page {i:04}")));
        }
        expected.sort();

        let actual = snapshot(&pool).await;
        assert_eq!(actual, expected, "cache must reflect mutated source");
    }

    /// Rebuild on unchanged source produces zero diff ops.
    #[tokio::test]
    async fn rebuild_pages_cache_idempotent_m2() {
        let (pool, _dir) = test_pool().await;
        for i in 0..50 {
            insert_page(&pool, &format!("IDEM{i:04}"), &format!("t{i}")).await;
        }
        let first = rebuild_pages_cache_impl(&pool).await.unwrap();
        assert_eq!(first, 50);
        let second = rebuild_pages_cache_impl(&pool).await.unwrap();
        assert_eq!(second, 0, "idempotent rebuild must produce zero diff ops");
        assert_eq!(snapshot(&pool).await.len(), 50);
    }
}
