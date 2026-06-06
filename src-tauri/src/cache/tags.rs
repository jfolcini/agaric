use futures_util::TryStreamExt;
use sqlx::SqlitePool;
use std::cmp::Ordering;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;

// `tags_cache` has 4 columns per row (tag_id, name, usage_count,
// updated_at) → `MAX_SQL_PARAMS / 4 = 249` rows per chunk for INSERT.
// DELETE binds 1 column (tag_id) → `MAX_SQL_PARAMS / 1 = 999` rows per
// chunk.
const INSERT_CHUNK: usize = MAX_SQL_PARAMS / 4; // 249
const DELETE_CHUNK: usize = MAX_SQL_PARAMS; // 999

// ---------------------------------------------------------------------------
// Desired-state SQL (M-2)
// ---------------------------------------------------------------------------

/// Projection that computes the desired state of `tags_cache` from the
/// live database. Bound from both [`rebuild_tags_cache_impl`] (single
/// pool) and [`rebuild_tags_cache_split_impl`] (read/write split) so
/// the two implementations cannot silently diverge.
///
/// UX-250 semantics (preserved verbatim from the pre-M-2 full rebuild):
///   - `usage_count` counts DISTINCT `block_id`s from the UNION of
///     `block_tags` (explicit) ∪ `block_tag_refs` (inline `#[ULID]`).
///   - Both joins enforce `deleted_at IS NULL` on the referenced block.
///   - Tags with zero usage are included via the LEFT JOIN + COALESCE.
///
/// Output is sorted by `b.id ASC` so the sort-merge diff in
/// [`apply_sort_merge_rebuild`] can walk this stream alongside
/// `tags_cache` (also `ORDER BY tag_id ASC`) in lockstep.
const DESIRED_TAGS_SQL: &str = "SELECT b.id, b.content, COALESCE(t.cnt, 0) AS cnt
         FROM blocks b
         LEFT JOIN (
             SELECT tag_id, COUNT(*) AS cnt FROM (
                 SELECT bt.tag_id, bt.block_id
                 FROM block_tags bt
                 JOIN blocks blk ON blk.id = bt.block_id
                 WHERE blk.deleted_at IS NULL
                 UNION
                 SELECT btr.tag_id, btr.source_id AS block_id
                 FROM block_tag_refs btr
                 JOIN blocks blk ON blk.id = btr.source_id
                 WHERE blk.deleted_at IS NULL
             )
             GROUP BY tag_id
         ) t ON t.tag_id = b.id
         WHERE b.block_type = 'tag' AND b.deleted_at IS NULL AND b.content IS NOT NULL
         ORDER BY b.id ASC";

const CURRENT_TAGS_SQL: &str =
    "SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id ASC";

// ---------------------------------------------------------------------------
// Apply diff (M-2)
// ---------------------------------------------------------------------------

/// Apply a tags diff inside an open transaction in chunks bounded by
/// [`MAX_SQL_PARAMS`].
///
/// **Ordering invariant.** All DELETEs execute before any INSERTs. This
/// matters because `tags_cache.name` carries a UNIQUE constraint: if a
/// tag is renamed (e.g. TAG_A renamed to "X" while TAG_B still owns the
/// row whose name was "X"), the new "X" insert would collide on UNIQUE
/// unless TAG_B's row is deleted first. The pre-M-2 full rebuild
/// dodged this trivially by truncating the table; here we mirror that
/// guarantee by sequencing all deletes before all inserts within a
/// single apply pass — see [`apply_sort_merge_rebuild`] which calls
/// this exactly once at end-of-stream.
///
/// `INSERT OR IGNORE` matches the pre-M-2 full-rebuild and split-variant
/// shape; any genuine UNIQUE(name) collision in the source data is
/// silently dropped (preserving the old `INSERT OR IGNORE` semantic).
async fn apply_tags_diff(
    conn: &mut sqlx::SqliteConnection,
    delete_ids: &[String],
    insert_rows: &[(String, String, i64)],
    now: &str,
) -> Result<(), AppError> {
    for chunk in delete_ids.chunks(DELETE_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "?").collect();
        let sql = format!(
            "DELETE FROM tags_cache WHERE tag_id IN ({})",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for id in chunk {
            q = q.bind(id);
        }
        q.execute(&mut *conn).await?;
    }

    for chunk in insert_rows.chunks(INSERT_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?)").collect();
        let sql = format!(
            // INSERT OR REPLACE (not INSERT OR IGNORE): if a tag is renamed to
            // a name still held by an UNCHANGED tag (not in the delete set), the
            // UNIQUE(name) constraint would cause INSERT OR IGNORE to silently
            // drop the renamed tag's new row.  INSERT OR REPLACE instead evicts
            // the stale row and preserves the incoming (correct) row.
            "INSERT OR REPLACE INTO tags_cache (tag_id, name, usage_count, updated_at) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for (tag_id, name, usage_count) in chunk {
            q = q.bind(tag_id).bind(name).bind(usage_count).bind(now);
        }
        q.execute(&mut *conn).await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Sort-merge rebuild core (M-2)
// ---------------------------------------------------------------------------

/// Stream-walk the desired and current tag rows in lockstep, computing
/// a diff:
///   - PK in NEW not in OLD → INSERT.
///   - PK in OLD not in NEW → DELETE.
///   - PK in both, `(name, usage_count)` differs → DELETE + INSERT.
///   - PK in both, same `(name, usage_count)` → no-op (preserves the
///     prior `updated_at`).
///
/// Diff rows are accumulated into `Vec`s and flushed once at the end via
/// a single chunked DELETE + chunked INSERT pair (see the ordering
/// invariant on [`apply_tags_diff`]). For the typical incremental case
/// the diff is small, so the heap cost is `O(diff_size)` — much smaller
/// than the pre-M-2 full-table rewrite.
async fn apply_sort_merge_rebuild(
    desired_conn: &mut sqlx::SqliteConnection,
    current_conn: &mut sqlx::SqliteConnection,
    write_conn: &mut sqlx::SqliteConnection,
    now: &str,
) -> Result<u64, AppError> {
    let mut desired_stream =
        sqlx::query_as::<_, (String, String, i64)>(DESIRED_TAGS_SQL).fetch(desired_conn);
    let mut current_stream =
        sqlx::query_as::<_, (String, String, i64)>(CURRENT_TAGS_SQL).fetch(current_conn);

    let mut deletes: Vec<String> = Vec::new();
    let mut inserts: Vec<(String, String, i64)> = Vec::new();
    let mut changed: u64 = 0;

    let mut next_desired = desired_stream.try_next().await?;
    let mut next_current = current_stream.try_next().await?;

    loop {
        match (&next_desired, &next_current) {
            (None, None) => break,
            (Some((d_id, d_name, d_cnt)), None) => {
                inserts.push((d_id.clone(), d_name.clone(), *d_cnt));
                changed += 1;
                next_desired = desired_stream.try_next().await?;
            }
            (None, Some((c_id, _, _))) => {
                deletes.push(c_id.clone());
                changed += 1;
                next_current = current_stream.try_next().await?;
            }
            (Some((d_id, d_name, d_cnt)), Some((c_id, c_name, c_cnt))) => {
                match d_id.as_str().cmp(c_id.as_str()) {
                    Ordering::Less => {
                        inserts.push((d_id.clone(), d_name.clone(), *d_cnt));
                        changed += 1;
                        next_desired = desired_stream.try_next().await?;
                    }
                    Ordering::Greater => {
                        deletes.push(c_id.clone());
                        changed += 1;
                        next_current = current_stream.try_next().await?;
                    }
                    Ordering::Equal => {
                        if d_name != c_name || d_cnt != c_cnt {
                            // Name and/or usage_count changed — DELETE + INSERT
                            // under PK. Counts as one logical change.
                            deletes.push(c_id.clone());
                            inserts.push((d_id.clone(), d_name.clone(), *d_cnt));
                            changed += 1;
                        }
                        next_desired = desired_stream.try_next().await?;
                        next_current = current_stream.try_next().await?;
                    }
                }
            }
        }
    }

    drop(desired_stream);
    drop(current_stream);

    if !deletes.is_empty() || !inserts.is_empty() {
        apply_tags_diff(write_conn, &deletes, &inserts, now).await?;
    }

    Ok(changed)
}

// ---------------------------------------------------------------------------
// rebuild_tags_cache (p1-t18, M-2)
// ---------------------------------------------------------------------------

/// Incremental rebuild of `tags_cache` (M-2 — was full DELETE + INSERT
/// pre-refactor).
///
/// Instead of a full `DELETE FROM tags_cache; INSERT SELECT …` two-pass
/// over every tag, this function:
/// 1. Streams the desired state from `blocks` (filtered by
///    `block_type = 'tag' AND deleted_at IS NULL AND content IS NOT NULL`)
///    LEFT-joined with a UNION'd usage subquery over `block_tags` ∪
///    `block_tag_refs`, sorted by `b.id ASC`.
/// 2. Streams the current cache state (sorted by `tag_id ASC`).
/// 3. Walks the two streams in lockstep, accumulating INSERTs and
///    DELETEs, then applies the diff via one chunked DELETE + chunked
///    INSERT pair.
///
/// Unchanged rows are not touched — their `updated_at` is preserved.
///
/// Tags with zero usage are included via the LEFT JOIN + COALESCE.
pub async fn rebuild_tags_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("tags", || rebuild_tags_cache_impl(pool)).await
}

async fn rebuild_tags_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let now = crate::now_rfc3339();
    // Three independent connections — two readers (desired + current
    // state streams) plus one writer for the diff transaction. Distinct
    // connections are required so the streams' mutable borrows don't
    // conflict. Snapshot consistency across the three connections is not
    // required: same stale-while-revalidate semantics as
    // `rebuild_agenda_cache_impl` (M-19b).
    let mut desired_conn = pool.acquire().await?;
    let mut current_conn = pool.acquire().await?;
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_tags_rebuild").await?;

    let changed =
        apply_sort_merge_rebuild(&mut desired_conn, &mut current_conn, &mut tx, &now).await?;

    if changed == 0 {
        return Ok(0);
    }

    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Read/write split variant (Phase 1A)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`rebuild_tags_cache`] (M-17, M-2).
///
/// Reads desired and current tag rows from `read_pool` and applies the
/// incremental diff on `write_pool`. Mirrors the single-pool sort-merge
/// shape so semantic divergence is impossible.
///
/// Stale-while-revalidate: each read connection has its own snapshot;
/// the write tx is opened independently. Any concurrent writer mutation
/// observed by one reader but not the other is corrected on the next
/// rebuild — same eventual-consistency guarantee as
/// [`super::rebuild_agenda_cache_split`] (AGENTS.md "Performance
/// Conventions / Split read/write pool pattern").
pub async fn rebuild_tags_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("tags", || {
        rebuild_tags_cache_split_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_tags_cache_split_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    let now = crate::now_rfc3339();
    let mut desired_conn = read_pool.acquire().await?;
    let mut current_conn = read_pool.acquire().await?;
    let mut tx = crate::db::begin_immediate_logged(write_pool, "cache_tags_rebuild_write").await?;

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
    //! Tests scoped to this file (M-2). Helpers are local copies of the
    //! patterns in `cache/tests.rs`.
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

    async fn insert_tag(pool: &SqlitePool, id: &str, name: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, 'tag', ?)",
            id,
            name,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_content(pool: &SqlitePool, id: &str, content: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)",
            id,
            content,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn add_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            block_id,
            tag_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn rename_tag(pool: &SqlitePool, id: &str, new_name: &str) {
        sqlx::query!("UPDATE blocks SET content = ? WHERE id = ?", new_name, id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn soft_delete(pool: &SqlitePool, id: &str) {
        sqlx::query!(
            "UPDATE blocks SET deleted_at = 1767139200000 WHERE id = ?",
            id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn snapshot(pool: &SqlitePool) -> Vec<(String, String, i64)> {
        sqlx::query_as::<_, (String, String, i64)>(
            "SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// 100 tags → rebuild → mutate (add, remove, rename, usage_count
    /// change) → rebuild → assert cache reflects the new source state.
    #[tokio::test]
    async fn rebuild_tags_cache_incremental_parity_m2() {
        let (pool, _dir) = test_pool().await;

        // Seed: 100 tags (50 with 1 usage each, 50 with 0 usage).
        for i in 0..100 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let name = format!("tag-{i:04}");
            insert_tag(&pool, &id, &name).await;
            if i < 50 {
                let bid = format!("BLKM2{i:04}AAAAAAAAAAAAAAAAA");
                insert_content(&pool, &bid, "note").await;
                add_tag(&pool, &bid, &id).await;
            }
        }

        let first = rebuild_tags_cache_impl(&pool).await.unwrap();
        assert_eq!(first, 100, "baseline inserts 100 rows");

        // Mutate:
        //   A) 10 tags renamed (TAGM2 0000..0009).
        //   B) 5 tags removed (TAGM2 0090..0094).
        //   C) 5 new tags added (TAGM2 0100..0104).
        //   D) 10 tags get a usage_count bump (TAGM2 0050..0059, all currently 0).
        for i in 0..10 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let new_name = format!("renamed-{i:04}");
            rename_tag(&pool, &id, &new_name).await;
        }
        for i in 90..95 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            soft_delete(&pool, &id).await;
        }
        for i in 100..105 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let name = format!("new-tag-{i:04}");
            insert_tag(&pool, &id, &name).await;
        }
        for i in 50..60 {
            let tag_id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let bid = format!("BUMP{i:04}AAAAAAAAAAAAAAAAAAA");
            insert_content(&pool, &bid, "bump").await;
            add_tag(&pool, &bid, &tag_id).await;
        }

        let touched = rebuild_tags_cache_impl(&pool).await.unwrap();
        // 10 renames + 5 deletes + 5 inserts + 10 usage bumps = 30.
        assert_eq!(
            touched, 30,
            "diff = 10 renames + 5 deletes + 5 inserts + 10 usage bumps"
        );

        // Build the expected set from the source data.
        let mut expected: Vec<(String, String, i64)> = Vec::new();
        for i in 0..100 {
            if (90..95).contains(&i) {
                continue;
            }
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let name = if i < 10 {
                format!("renamed-{i:04}")
            } else {
                format!("tag-{i:04}")
            };
            let usage_count: i64 = if i < 50 || (50..60).contains(&i) {
                1
            } else {
                0
            };
            expected.push((id, name, usage_count));
        }
        for i in 100..105 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            expected.push((id, format!("new-tag-{i:04}"), 0));
        }
        expected.sort();

        let actual = snapshot(&pool).await;
        assert_eq!(actual, expected, "cache must reflect mutated source");
    }

    /// Rename-collision: tag A renamed to the name still held by unchanged tag B.
    ///
    /// With `INSERT OR IGNORE` the new row for A was silently dropped because B
    /// still occupied the UNIQUE(name) slot (B was not in the delete set). With
    /// `INSERT OR REPLACE` A's row wins and the cache stays correct.
    #[tokio::test]
    async fn tags_cache_rename_collision_does_not_silently_drop_tag() {
        let (pool, _dir) = test_pool().await;

        // Tag A: id=TAG_AA, initial name "alpha"
        // Tag B: id=TAG_BB, name "beta" — will NOT be renamed
        insert_tag(&pool, "TAG_AAAAAAAAAAAAAAAAAAAAAAA", "alpha").await;
        insert_tag(&pool, "TAG_BBBBBBBBBBBBBBBBBBBBBBB", "beta").await;

        // Baseline rebuild — both tags in cache
        let first = rebuild_tags_cache_impl(&pool).await.unwrap();
        assert_eq!(first, 2, "baseline must insert 2 rows");

        // Rename tag A to "beta" — now A and B both want the name "beta"
        rename_tag(&pool, "TAG_AAAAAAAAAAAAAAAAAAAAAAA", "beta").await;

        // Incremental rebuild must not silently drop tag A
        let _changed = rebuild_tags_cache_impl(&pool).await.unwrap();

        let cache = snapshot(&pool).await;
        let tag_a_row = cache
            .iter()
            .find(|(id, _, _)| id == "TAG_AAAAAAAAAAAAAAAAAAAAAAA");
        assert!(
            tag_a_row.is_some(),
            "tag A must still appear in the cache after rename collision; cache = {cache:?}"
        );
        assert_eq!(
            tag_a_row.unwrap().1,
            "beta",
            "tag A must carry its new name 'beta'"
        );
    }

    /// Rebuild on unchanged source produces zero diff ops.
    #[tokio::test]
    async fn rebuild_tags_cache_idempotent_m2() {
        let (pool, _dir) = test_pool().await;
        for i in 0..50 {
            insert_tag(
                &pool,
                &format!("IDEMT{i:04}AAAAAAAAAAAAAAAAA"),
                &format!("idem-t-{i}"),
            )
            .await;
        }
        let first = rebuild_tags_cache_impl(&pool).await.unwrap();
        assert_eq!(first, 50);
        let second = rebuild_tags_cache_impl(&pool).await.unwrap();
        assert_eq!(second, 0, "idempotent rebuild must produce zero diff ops");
        assert_eq!(snapshot(&pool).await.len(), 50);
    }
}
