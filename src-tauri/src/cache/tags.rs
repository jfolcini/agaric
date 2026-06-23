use futures_util::TryStreamExt;
use sqlx::SqlitePool;
use std::cmp::Ordering;
use std::collections::HashSet;

use crate::db::MAX_SQL_PARAMS;
use crate::error::AppError;
use crate::tag_norm::normalize_tag_name;

// `tags_cache` has 4 columns per row (tag_id, name, usage_count,
// updated_at) → `MAX_SQL_PARAMS / 4 = 249` rows per chunk for INSERT.
// DELETE binds 1 column (tag_id) → `MAX_SQL_PARAMS / 1 = 999` rows per
// chunk.
const INSERT_CHUNK: usize = MAX_SQL_PARAMS / 4; // 249
const DELETE_CHUNK: usize = MAX_SQL_PARAMS; // 999

// ---------------------------------------------------------------------------
// Desired-state SQL
// ---------------------------------------------------------------------------

/// Projection that computes the desired state of `tags_cache` from the
/// live database. Bound from both [`rebuild_tags_cache_impl`] (single
/// pool) and [`rebuild_tags_cache_split_impl`] (read/write split) so
/// the two implementations cannot silently diverge.
///
/// Semantics (preserved verbatim from the pre-M-2 full rebuild):
///   - `usage_count` counts DISTINCT `block_id`s from the UNION of
///     `block_tags` (explicit) ∪ `block_tag_refs` (inline `#[ULID]`).
///   - Both joins enforce `deleted_at IS NULL` on the referenced block.
///   - Tags with zero usage are included via the LEFT JOIN + COALESCE.
///
/// Output is sorted by `b.id ASC` so the sort-merge diff in
/// [`apply_sort_merge_rebuild`] can walk this stream alongside
/// `tags_cache` (also `ORDER BY tag_id ASC`) in lockstep.
///
/// **Duplicate-name de-duplication (#626).** `tags_cache.name` is UNIQUE
/// (migration 0061:195) but `blocks.content` has no uniqueness for
/// `block_type='tag'`: two live tags can legitimately share a name (a
/// rename collision, or two devices independently creating `#project`
/// then syncing). If both were emitted into the desired state, the
/// rebuild's INSERT would have to resolve the UNIQUE(name) collision on
/// *every* run, and `INSERT OR REPLACE` made the two rows flip-flop
/// forever (each rebuild evicted whichever one the previous rebuild had
/// inserted → `changed >= 1` perpetually, one tag permanently invisible).
///
/// We instead de-duplicate by name *deterministically*: among all live
/// tags sharing a name, only the one with the smallest `id` (ULID →
/// earliest-created) survives.
///
/// **#1990 — normalize-consistent identity.** Tag identity is defined by
/// [`crate::tag_norm::normalize_tag_name`] (NFC → full-Unicode lowercase
/// → NFC) — the SAME key the Loro sync engine stores its tag map under
/// (`loro/engine/apply.rs::tag_map_key_for`). The previous dedup used
/// `PARTITION BY content COLLATE NOCASE`, but SQLite's NOCASE folds only
/// ASCII A–Z, so non-ASCII case-variants (`#Σ`/`#σ`) were merged by the
/// engine yet SPLIT into two cache rows — a latent multi-device hazard.
/// SQLite cannot compute `normalize_tag_name`, so this SQL no longer
/// de-duplicates at all: it emits EVERY live tag (id, content, cnt)
/// ordered by `id ASC`, and [`next_desired_winner`] picks
/// the smallest-id winner per normalized name in Rust. Because the stream
/// is `id`-ordered, the first row for a normalized name IS the winner and
/// later same-name rows are dropped. The winner is a pure function of the
/// source rows, so the desired stream is stable across rebuilds → the
/// cache converges (a settled rebuild reports `changed == 0`) and the
/// same tag wins every time. The loser is omitted from the cache (it has
/// no UNIQUE slot to occupy); it remains fully live in `blocks` and is
/// recoverable by a rename. The ASCII case behaviour is unchanged — it is
/// a strict subset of the Unicode fold (pinned by
/// `tag_norm::ascii_fold_matches_sqlite_nocase`).
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

/// Scoped desired-state SQL for a SINGLE tag (#676).
///
/// Computes the `(name, usage_count)` a full [`DESIRED_TAGS_SQL`] rebuild
/// would emit for exactly one `tag_id`, reusing the **identical** usage
/// subquery (`block_tags` ∪ `block_tag_refs`, both filtered to live source
/// blocks) and the **identical** name de-duplication rule. The single bind
/// parameter `?` is the candidate tag's id.
///
/// The de-dup guard is the load-bearing difference from a naive
/// `WHERE b.id = ?`: in a full rebuild, among all live tags sharing a
/// normalized name (#1990 — [`normalize_tag_name`], the engine's tag
/// identity key) only the smallest-id tag occupies the cache slot; the
/// rest are omitted. So this query emits a row **only if** the candidate
/// is that smallest-id winner — i.e. no live tag with the same normalized
/// name has a smaller id.
///
/// **SQLite cannot compute `normalize_tag_name`.** Earlier this guard was
/// an SQL `NOT EXISTS … o.content = b.content COLLATE NOCASE`, but NOCASE
/// folds only ASCII, so a non-ASCII case-variant loser would wrongly be
/// treated as a winner. Instead this query returns the candidate's own
/// `(content, cnt)` plus the smallest live-tag `id` sharing its content
/// under NOCASE (a cheap superset prefilter); the Rust caller
/// ([`refresh_tag_usage_count_impl`]) confirms the true smallest-id winner
/// among the full-Unicode-normalized siblings. If the candidate is a name
/// *loser*, was deleted, or isn't a tag block, the caller leaves the cache
/// untouched (exactly what a full rebuild does for that tag).
///
/// Because `add_tag`/`remove_tag` mutate only `block_tags` (never
/// `blocks.content`, never which tag blocks exist), the *winner* for any
/// name and the *set* of cached tag rows are invariant under these ops — only
/// the winner's `usage_count` can move. Recomputing just this one row is
/// therefore provably identical to the full rebuild's effect for the op.
const DESIRED_TAG_USAGE_SQL: &str = "SELECT b.content AS name, COALESCE(t.cnt, 0) AS cnt
         FROM blocks b
         LEFT JOIN (
             SELECT COUNT(*) AS cnt FROM (
                 SELECT bt.block_id
                 FROM block_tags bt
                 JOIN blocks blk ON blk.id = bt.block_id
                 WHERE blk.deleted_at IS NULL AND bt.tag_id = ?1
                 UNION
                 SELECT btr.source_id AS block_id
                 FROM block_tag_refs btr
                 JOIN blocks blk ON blk.id = btr.source_id
                 WHERE blk.deleted_at IS NULL AND btr.tag_id = ?1
             )
         ) t
         WHERE b.id = ?1
           AND b.block_type = 'tag'
           AND b.deleted_at IS NULL
           AND b.content IS NOT NULL";

/// All live tag blocks (id, content), ordered by `id ASC`, used by the
/// scoped refresh to confirm the smallest-id winner for a candidate's
/// normalized name in Rust (#1990). SQLite's NOCASE folds only ASCII, so a
/// SQL prefilter on `content = ? COLLATE NOCASE` would MISS a non-ASCII
/// case-variant sibling (`#Σ` for a `#σ` candidate) — the exact relationship
/// the winner check must detect. So we scan every live tag and confirm the
/// full-Unicode `normalize_tag_name` equality in Rust. Tag count is bounded
/// by the user's vocabulary (cf. the no-clamp `list_all_tags_in_space`), so
/// the scan is cheap. The first `id`-ordered tag whose normalized name
/// matches the candidate's is the winner.
const ALL_LIVE_TAGS_SQL: &str = "SELECT id, content
         FROM blocks
         WHERE block_type = 'tag'
           AND deleted_at IS NULL
           AND content IS NOT NULL
         ORDER BY id ASC";

/// Incremental, single-tag refresh of `tags_cache.usage_count` (#676).
///
/// `add_tag` / `remove_tag` mutate exactly one `(block_id, tag_id)` edge in
/// `block_tags`. The only `tags_cache` column that can change as a result is
/// the affected tag's `usage_count`; neither the tag's `name` nor the *set*
/// of cached tags can move (see [`DESIRED_TAG_USAGE_SQL`]). So instead of the
/// former full O(vault) [`rebuild_tags_cache`] (which streams every tag block
/// and the whole `block_tags`/`block_tag_refs` union to sort-merge-diff the
/// entire cache), this recomputes the desired row for just `tag_id` and:
///   - if the tag is the name-winner → `INSERT OR REPLACE` its row with the
///     freshly computed `usage_count` (UPSERT — robust if the row hasn't been
///     materialized yet under eventual consistency);
///   - if the tag is a name-loser / deleted / not a tag → the desired query
///     returns no row, so the cache is left untouched (identical to a full
///     rebuild's treatment of that tag).
///
/// `INSERT OR REPLACE` is safe here for the same reason as in the full
/// rebuild ([`apply_tags_diff`]): the candidate is, by the de-dup guard, the
/// sole owner of its `UNIQUE(name)` slot among live tags, so no unchanged tag
/// can collide on the name.
pub async fn refresh_tag_usage_count(pool: &SqlitePool, tag_id: &str) -> Result<(), AppError> {
    super::rebuild_with_timing("tags", || refresh_tag_usage_count_impl(pool, tag_id)).await
}

async fn refresh_tag_usage_count_impl(pool: &SqlitePool, tag_id: &str) -> Result<u64, AppError> {
    let now = crate::now_rfc3339();
    let desired: Option<(String, i64)> = sqlx::query_as::<_, (String, i64)>(DESIRED_TAG_USAGE_SQL)
        .bind(tag_id)
        .fetch_optional(pool)
        .await?;

    let Some((name, cnt)) = desired else {
        // Deleted / non-tag / NULL content: a full rebuild would not place this
        // id in the cache, so leave it untouched.
        return Ok(0);
    };

    // #1990 — confirm the candidate is the smallest-id winner among all live
    // tags sharing its NORMALIZED name (the engine's tag identity). SQLite
    // cannot compute `normalize_tag_name`, so we resolve the winner in Rust
    // (same fold the full rebuild's `dedup_desired_by_normalized_name` uses).
    // If the candidate is a name *loser*, it has no UNIQUE(name) cache slot —
    // identical to a full rebuild, which omits it — so leave the cache
    // untouched.
    let candidate_norm = normalize_tag_name(&name);
    let siblings = sqlx::query_as::<_, (String, Option<String>)>(ALL_LIVE_TAGS_SQL)
        .fetch_all(pool)
        .await?;
    let winner_id = siblings.iter().find_map(|(id, content)| {
        let c = content.as_deref()?;
        (normalize_tag_name(c) == candidate_norm).then_some(id.as_str())
    });
    if winner_id != Some(tag_id) {
        return Ok(0);
    }

    let mut tx = crate::db::begin_immediate_logged(pool, "cache_tags_refresh_one").await?;
    let res = sqlx::query(
        "INSERT OR REPLACE INTO tags_cache (tag_id, name, usage_count, updated_at) \
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(tag_id)
    .bind(&name)
    .bind(cnt)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(res.rows_affected())
}

// ---------------------------------------------------------------------------
// Apply diff
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
            //
            // The desired projection now de-duplicates names deterministically
            // (DESIRED_TAGS_SQL, #626), so each rebuild's insert set holds at
            // most one row per name and OR REPLACE no longer flip-flops between
            // two same-name tags: the same winner (smallest id) is inserted
            // every rebuild and the cache converges (changed == 0 once settled).
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
// Sort-merge rebuild core
// ---------------------------------------------------------------------------

/// Advance an `id`-ordered desired-tag stream to the next **name-winner**,
/// de-duplicating by [`normalize_tag_name`] in Rust (#1990).
///
/// [`DESIRED_TAGS_SQL`] emits EVERY live tag ordered by `id ASC` (SQLite
/// cannot compute the full-Unicode `normalize_tag_name`, so the dedup can no
/// longer live in SQL). For each candidate this folds its `content` to the
/// engine's identity key and keeps it only if that key is unseen — i.e. it is
/// the smallest-id tag for that normalized name. Later same-name rows (losers)
/// are skipped, mirroring the old `ROW_NUMBER() … rn = 1` projection but with
/// the Unicode-correct fold. `seen` accumulates the winning keys across the
/// whole stream; because the stream is `id`-ordered the first occurrence of a
/// key is always its smallest-id winner, so the result is a pure, stable
/// function of the source rows (the cache still converges to `changed == 0`).
async fn next_desired_winner(
    stream: &mut (impl futures_util::Stream<Item = Result<(String, String, i64), sqlx::Error>> + Unpin),
    seen: &mut HashSet<String>,
) -> Result<Option<(String, String, i64)>, AppError> {
    while let Some(row) = stream.try_next().await? {
        if seen.insert(normalize_tag_name(&row.1)) {
            return Ok(Some(row));
        }
        // Name-loser (a smaller-id tag already owns this normalized name) —
        // skip it; it has no UNIQUE(name) cache slot, exactly as the old SQL
        // `rn = 1` filter dropped it.
    }
    Ok(None)
}

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
    // #1990 — winning normalized names seen so far. The desired stream is
    // de-duplicated by `normalize_tag_name` in Rust (the smallest-id tag wins
    // each normalized name); `seen` tracks those winners as the stream
    // advances. The desired stream stays `id`-ordered after the filter (we
    // drop rows, never reorder), so the sort-merge below still walks both
    // streams in lockstep on `id`.
    let mut seen: HashSet<String> = HashSet::new();

    let mut next_desired = next_desired_winner(&mut desired_stream, &mut seen).await?;
    let mut next_current = current_stream.try_next().await?;

    loop {
        match (&next_desired, &next_current) {
            (None, None) => break,
            (Some((d_id, d_name, d_cnt)), None) => {
                inserts.push((d_id.clone(), d_name.clone(), *d_cnt));
                changed += 1;
                next_desired = next_desired_winner(&mut desired_stream, &mut seen).await?;
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
                        next_desired = next_desired_winner(&mut desired_stream, &mut seen).await?;
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
                        next_desired = next_desired_winner(&mut desired_stream, &mut seen).await?;
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
// Rebuild_tags_cache (p1-t18)
// ---------------------------------------------------------------------------

/// Incremental rebuild of `tags_cache` (was full DELETE + INSERT
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

/// Read/write split variant of [`rebuild_tags_cache`].
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
// Sort-merge tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests scoped to this file. Helpers are local copies of the
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
            let usage_count: i64 = i64::from(i < 50 || (50..60).contains(&i));
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
    /// the deterministic de-dup projection (#626), the smaller-id tag wins the
    /// shared name and the cache stays correct.
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

        // Rename tag A to "beta" — now A and B both want the name "beta".
        // A has the smaller id (TAG_AA... < TAG_BB...), so A deterministically
        // wins the "beta" slot.
        rename_tag(&pool, "TAG_AAAAAAAAAAAAAAAAAAAAAAA", "beta").await;

        // Incremental rebuild must not silently drop the winning tag A
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

    /// #626 — two LIVE tags sharing a name must NOT flip-flop forever.
    ///
    /// `tags_cache.name` is UNIQUE but two live tags can legitimately share a
    /// name (rename collision / two devices each create `#project` then sync).
    /// The old `INSERT OR REPLACE` rebuild evicted one and re-inserted the
    /// other on *every* rebuild → perpetual flip-flop (`changed >= 1` forever,
    /// one tag permanently invisible). With the deterministic de-dup projection
    /// the smaller-id tag wins the name on *every* rebuild, so the cache
    /// converges: the same winner each time, and the third rebuild is a no-op.
    #[tokio::test]
    async fn tags_cache_duplicate_name_converges_no_flip_flop() {
        let (pool, _dir) = test_pool().await;

        // Two live tags that share the name "project". A has the smaller id.
        insert_tag(&pool, "TAGDUPA0000000000000000000", "project").await;
        insert_tag(&pool, "TAGDUPB0000000000000000000", "project").await;
        // Give the LOSER (B) the higher usage so we can prove the winner is
        // chosen by id, not by usage_count.
        insert_content(&pool, "BLKDUP00000000000000000000", "note").await;
        add_tag(
            &pool,
            "BLKDUP00000000000000000000",
            "TAGDUPB0000000000000000000",
        )
        .await;

        // Rebuild three times. Capture the winner each time.
        let mut winners: Vec<(String, String, i64)> = Vec::new();
        let mut changes: Vec<u64> = Vec::new();
        for _ in 0..3 {
            let changed = rebuild_tags_cache_impl(&pool).await.unwrap();
            changes.push(changed);
            let cache = snapshot(&pool).await;
            // Exactly one row may occupy the UNIQUE(name) slot for "project".
            let project_rows: Vec<_> = cache
                .iter()
                .filter(|(_, name, _)| name == "project")
                .cloned()
                .collect();
            assert_eq!(
                project_rows.len(),
                1,
                "exactly one tag may hold the UNIQUE name 'project'; cache = {cache:?}"
            );
            winners.push(project_rows.into_iter().next().unwrap());
        }

        // (1) STABLE: the SAME tag (smaller id, A) wins all three rebuilds.
        assert!(
            winners
                .iter()
                .all(|(id, _, _)| id == "TAGDUPA0000000000000000000"),
            "the smaller-id tag must win every rebuild (deterministic); winners = {winners:?}"
        );

        // (2) CONVERGED: the third rebuild reports zero diff ops — no flip-flop.
        assert_eq!(
            changes[2], 0,
            "third rebuild must converge to changed == 0 (no perpetual flip-flop); changes = {changes:?}"
        );
    }

    /// #1990 — two live tags that are NON-ASCII case-variants (`#Σ` / `#σ`)
    /// share one normalized identity (`normalize_tag_name`, the engine's tag
    /// key) and must converge to ONE cache row deterministically — the
    /// smallest-id winner — WITHOUT a UNIQUE-violation crash or flip-flop. The
    /// old `PARTITION BY content COLLATE NOCASE` dedup folded only ASCII, so it
    /// SPLIT these into two rows. This guards the Unicode-correct dedup.
    #[tokio::test]
    async fn tags_cache_unicode_case_variants_converge_1990() {
        let (pool, _dir) = test_pool().await;

        // Two live tags: capital sigma `Σ` (smaller id A) and lowercase
        // sigma `σ` (larger id B). normalize_tag_name folds both to `σ`.
        insert_tag(&pool, "TAGSIGA0000000000000000000", "Σ").await;
        insert_tag(&pool, "TAGSIGB0000000000000000000", "σ").await;
        // Give the LOSER (B) the higher usage to prove the winner is chosen by
        // id, not usage_count.
        insert_content(&pool, "BLKSIG00000000000000000000", "note").await;
        add_tag(
            &pool,
            "BLKSIG00000000000000000000",
            "TAGSIGB0000000000000000000",
        )
        .await;

        let mut winners: Vec<(String, String, i64)> = Vec::new();
        let mut changes: Vec<u64> = Vec::new();
        for _ in 0..3 {
            // No UNIQUE(name) crash: the dedup keeps exactly one of the
            // case-variants out of the insert set.
            let changed = rebuild_tags_cache_impl(&pool).await.unwrap();
            changes.push(changed);
            let cache = snapshot(&pool).await;
            // Exactly ONE cache row exists across both case-variants (they share
            // a normalized identity). The other is omitted, not duplicated.
            assert_eq!(
                cache.len(),
                1,
                "Unicode case-variants `Σ`/`σ` must converge to one cache row; cache = {cache:?}"
            );
            winners.push(cache.into_iter().next().unwrap());
        }

        // STABLE: the SAME smaller-id tag (A, `Σ`) wins every rebuild.
        assert!(
            winners
                .iter()
                .all(|(id, name, _)| id == "TAGSIGA0000000000000000000" && name == "Σ"),
            "the smaller-id tag (Σ) must win every rebuild; winners = {winners:?}"
        );
        // CONVERGED: third rebuild is a no-op (no flip-flop).
        assert_eq!(
            changes[2], 0,
            "third rebuild must converge to changed == 0; changes = {changes:?}"
        );
    }

    /// #1990 — the existing ASCII behaviour (a strict subset of the Unicode
    /// fold) must still hold: `#Foo`/`#foo` converge to one row, smaller-id
    /// winner. Belt-and-braces alongside the NOCASE convergence tests, pinning
    /// that the dedup-mechanism swap did not regress ASCII case-folding.
    #[tokio::test]
    async fn tags_cache_ascii_case_variants_still_converge_1990() {
        let (pool, _dir) = test_pool().await;
        insert_tag(&pool, "TAGFOOA0000000000000000000", "Foo").await;
        insert_tag(&pool, "TAGFOOB0000000000000000000", "foo").await;

        let changed = rebuild_tags_cache_impl(&pool).await.unwrap();
        assert_eq!(changed, 1, "ASCII case-variants insert exactly one row");
        let cache = snapshot(&pool).await;
        assert_eq!(
            cache.len(),
            1,
            "Foo/foo converge to one row; cache = {cache:?}"
        );
        assert_eq!(
            cache[0].0, "TAGFOOA0000000000000000000",
            "smaller-id Foo wins"
        );
        // Idempotent second rebuild.
        assert_eq!(rebuild_tags_cache_impl(&pool).await.unwrap(), 0);
    }

    async fn remove_tag_edge(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query!(
            "DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?",
            block_id,
            tag_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Build a FRESH cache from scratch via the full rebuild, into a
    /// throwaway clone of the live state, so we can compare the scoped
    /// refresh's result against the authoritative full rebuild. Here we
    /// simply run the full rebuild on the same pool AFTER capturing the
    /// scoped-refresh snapshot, since the full rebuild is idempotent and
    /// converges to the canonical desired state.
    async fn full_rebuild_snapshot(pool: &SqlitePool) -> Vec<(String, String, i64)> {
        rebuild_tags_cache_impl(pool).await.unwrap();
        snapshot(pool).await
    }

    /// #676 — the scoped single-tag refresh must produce the SAME
    /// `tags_cache` as a full rebuild for add / remove / re-add (dedupe) /
    /// remove-missing, AND must not touch unrelated tags' rows.
    #[tokio::test]
    async fn refresh_tag_usage_count_matches_full_rebuild_all_cases() {
        let (pool, _dir) = test_pool().await;

        // Three tags; two content blocks.
        insert_tag(&pool, "TAGA0000000000000000000000", "alpha").await;
        insert_tag(&pool, "TAGB0000000000000000000000", "beta").await;
        insert_tag(&pool, "TAGC0000000000000000000000", "gamma").await;
        insert_content(&pool, "BLK10000000000000000000000", "n1").await;
        insert_content(&pool, "BLK20000000000000000000000", "n2").await;

        // Baseline: full rebuild seeds all three tags at usage 0.
        assert_eq!(rebuild_tags_cache_impl(&pool).await.unwrap(), 3);
        // Give beta a stable usage of 1 (unrelated to the tag we refresh)
        // and capture its row so we can prove it is never disturbed.
        add_tag(
            &pool,
            "BLK10000000000000000000000",
            "TAGB0000000000000000000000",
        )
        .await;
        rebuild_tags_cache_impl(&pool).await.unwrap();
        let beta_before = snapshot(&pool)
            .await
            .into_iter()
            .find(|(id, _, _)| id == "TAGB0000000000000000000000")
            .unwrap();
        assert_eq!(beta_before.2, 1);

        // ── ADD: add alpha to BLK1, refresh just alpha ───────────────────
        add_tag(
            &pool,
            "BLK10000000000000000000000",
            "TAGA0000000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGA0000000000000000000000")
            .await
            .unwrap();
        let after_add = snapshot(&pool).await;
        // Unrelated tag beta untouched.
        let beta_after = after_add
            .iter()
            .find(|(id, _, _)| id == "TAGB0000000000000000000000")
            .unwrap()
            .clone();
        assert_eq!(beta_after, beta_before, "ADD must not touch unrelated beta");
        // Identical to a full rebuild.
        assert_eq!(
            after_add,
            full_rebuild_snapshot(&pool).await,
            "ADD: scoped refresh must equal full rebuild"
        );

        // ── RE-ADD (dedupe): adding alpha to BLK2 → usage 2; re-adding the
        //    SAME (BLK2, alpha) edge is a PK-dup no-op at the op layer, so
        //    the count stays 2. Prove the scoped refresh agrees with a full
        //    rebuild after the second (deduped) add. ─────────────────────
        add_tag(
            &pool,
            "BLK20000000000000000000000",
            "TAGA0000000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGA0000000000000000000000")
            .await
            .unwrap();
        // Second add of the identical edge is suppressed by the (block_id,
        // tag_id) PK — simulate the op layer's idempotence by attempting it
        // and ignoring the unique violation.
        let _ = sqlx::query!(
            "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            "BLK20000000000000000000000",
            "TAGA0000000000000000000000",
        )
        .execute(&pool)
        .await
        .unwrap();
        refresh_tag_usage_count_impl(&pool, "TAGA0000000000000000000000")
            .await
            .unwrap();
        let after_readd = snapshot(&pool).await;
        let alpha_readd = after_readd
            .iter()
            .find(|(id, _, _)| id == "TAGA0000000000000000000000")
            .unwrap();
        assert_eq!(alpha_readd.2, 2, "RE-ADD must dedupe to usage 2, not 3");
        assert_eq!(
            after_readd,
            full_rebuild_snapshot(&pool).await,
            "RE-ADD: scoped refresh must equal full rebuild"
        );

        // ── REMOVE: drop alpha from BLK1 → usage back to 1 ──────────────
        remove_tag_edge(
            &pool,
            "BLK10000000000000000000000",
            "TAGA0000000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGA0000000000000000000000")
            .await
            .unwrap();
        let after_remove = snapshot(&pool).await;
        let alpha_remove = after_remove
            .iter()
            .find(|(id, _, _)| id == "TAGA0000000000000000000000")
            .unwrap();
        assert_eq!(alpha_remove.2, 1, "REMOVE must drop alpha usage to 1");
        assert_eq!(
            after_remove
                .iter()
                .find(|(id, _, _)| id == "TAGB0000000000000000000000")
                .unwrap()
                .clone(),
            beta_before,
            "REMOVE must not touch unrelated beta"
        );
        assert_eq!(
            after_remove,
            full_rebuild_snapshot(&pool).await,
            "REMOVE: scoped refresh must equal full rebuild"
        );

        // ── REMOVE-MISSING: remove a (block, tag) edge that does not exist
        //    (gamma was never added). The refresh must be a no-op that
        //    still equals a full rebuild (gamma stays at usage 0). ────────
        remove_tag_edge(
            &pool,
            "BLK10000000000000000000000",
            "TAGC0000000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGC0000000000000000000000")
            .await
            .unwrap();
        let after_missing = snapshot(&pool).await;
        let gamma = after_missing
            .iter()
            .find(|(id, _, _)| id == "TAGC0000000000000000000000")
            .unwrap();
        assert_eq!(gamma.2, 0, "REMOVE-MISSING: gamma stays at usage 0");
        assert_eq!(
            after_missing,
            full_rebuild_snapshot(&pool).await,
            "REMOVE-MISSING: scoped refresh must equal full rebuild"
        );
    }

    /// #676 — the scoped refresh must respect the same name-deduplication
    /// rule as the full rebuild: a name *loser* (a larger-id tag sharing a
    /// name with a smaller-id tag) has NO cache slot, so refreshing it must
    /// be a no-op that does not resurrect a row a full rebuild would omit.
    #[tokio::test]
    async fn refresh_tag_usage_count_respects_name_dedup_loser() {
        let (pool, _dir) = test_pool().await;
        // A (smaller id) and B (larger id) share the name "project".
        insert_tag(&pool, "TAGDUPA0000000000000000000", "project").await;
        insert_tag(&pool, "TAGDUPB0000000000000000000", "project").await;
        insert_content(&pool, "BLKZ0000000000000000000000", "note").await;

        // Full rebuild: only the winner A holds the "project" slot.
        rebuild_tags_cache_impl(&pool).await.unwrap();
        let cache = snapshot(&pool).await;
        assert!(
            cache
                .iter()
                .any(|(id, _, _)| id == "TAGDUPA0000000000000000000")
        );
        assert!(
            !cache
                .iter()
                .any(|(id, _, _)| id == "TAGDUPB0000000000000000000"),
            "loser B must not be in the cache"
        );

        // Add an edge to the LOSER B and refresh it. The scoped refresh must
        // NOT insert B (it has no UNIQUE(name) slot) — identical to a full
        // rebuild, which still omits B.
        add_tag(
            &pool,
            "BLKZ0000000000000000000000",
            "TAGDUPB0000000000000000000",
        )
        .await;
        let touched = refresh_tag_usage_count_impl(&pool, "TAGDUPB0000000000000000000")
            .await
            .unwrap();
        assert_eq!(touched, 0, "refreshing a name-loser must be a no-op");
        assert!(
            !snapshot(&pool)
                .await
                .iter()
                .any(|(id, _, _)| id == "TAGDUPB0000000000000000000"),
            "loser B must still be absent after a scoped refresh"
        );
        assert_eq!(
            snapshot(&pool).await,
            full_rebuild_snapshot(&pool).await,
            "loser refresh must equal full rebuild"
        );
    }

    /// #1990 — the scoped refresh's name-dedup must use the full-Unicode
    /// `normalize_tag_name`, not ASCII NOCASE. A NON-ASCII case-variant loser
    /// (`#σ`, larger id, sharing the normalized identity of the smaller-id
    /// `#Σ` winner) has NO cache slot, so refreshing it must be a no-op — and
    /// refreshing the WINNER must (re)materialize exactly one row. The old SQL
    /// `NOT EXISTS … COLLATE NOCASE` guard would wrongly treat `#σ` as a
    /// winner and resurrect a second row.
    #[tokio::test]
    async fn refresh_tag_usage_count_respects_unicode_name_dedup_1990() {
        let (pool, _dir) = test_pool().await;
        // A (smaller id, `Σ`) and B (larger id, `σ`) share the normalized
        // identity `σ`.
        insert_tag(&pool, "TAGSIGA0000000000000000000", "Σ").await;
        insert_tag(&pool, "TAGSIGB0000000000000000000", "σ").await;
        insert_content(&pool, "BLKSIG00000000000000000000", "note").await;

        // Full rebuild: only winner A holds the slot.
        rebuild_tags_cache_impl(&pool).await.unwrap();
        let cache = snapshot(&pool).await;
        assert_eq!(cache.len(), 1, "exactly one row; cache = {cache:?}");
        assert_eq!(cache[0].0, "TAGSIGA0000000000000000000");

        // Add an edge to the LOSER B and refresh it → must be a no-op (B has no
        // UNIQUE(name) slot under the Unicode fold).
        add_tag(
            &pool,
            "BLKSIG00000000000000000000",
            "TAGSIGB0000000000000000000",
        )
        .await;
        let touched = refresh_tag_usage_count_impl(&pool, "TAGSIGB0000000000000000000")
            .await
            .unwrap();
        assert_eq!(
            touched, 0,
            "refreshing the Unicode case-variant loser is a no-op"
        );
        let after = snapshot(&pool).await;
        assert_eq!(
            after.len(),
            1,
            "loser must not resurrect a second row; cache = {after:?}"
        );
        assert_eq!(
            after[0].0, "TAGSIGA0000000000000000000",
            "winner A still owns the slot"
        );

        // Refreshing the WINNER A is the live path.
        add_tag(
            &pool,
            "BLKSIG00000000000000000000",
            "TAGSIGA0000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGSIGA0000000000000000000")
            .await
            .unwrap();
        assert_eq!(
            snapshot(&pool).await,
            full_rebuild_snapshot(&pool).await,
            "winner refresh must equal full rebuild"
        );
    }

    /// #676 — the scoped refresh counts inline `#[ULID]` tag refs
    /// (`block_tag_refs`) in `usage_count`, exactly as the full rebuild's
    /// UNION does. Proves the two usage subqueries stay in lockstep.
    #[tokio::test]
    async fn refresh_tag_usage_count_includes_inline_refs_like_full_rebuild() {
        let (pool, _dir) = test_pool().await;
        insert_tag(&pool, "TAGREF00000000000000000000", "ref").await;
        insert_content(&pool, "SRC10000000000000000000000", "a").await;
        insert_content(&pool, "SRC20000000000000000000000", "b").await;
        rebuild_tags_cache_impl(&pool).await.unwrap();

        // One explicit edge + one inline ref → usage 2.
        add_tag(
            &pool,
            "SRC10000000000000000000000",
            "TAGREF00000000000000000000",
        )
        .await;
        sqlx::query!(
            "INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
            "SRC20000000000000000000000",
            "TAGREF00000000000000000000",
        )
        .execute(&pool)
        .await
        .unwrap();
        refresh_tag_usage_count_impl(&pool, "TAGREF00000000000000000000")
            .await
            .unwrap();
        let scoped = snapshot(&pool).await;
        assert_eq!(
            scoped
                .iter()
                .find(|(id, _, _)| id == "TAGREF00000000000000000000")
                .unwrap()
                .2,
            2,
            "usage must count explicit edge + inline ref"
        );
        assert_eq!(
            scoped,
            full_rebuild_snapshot(&pool).await,
            "inline-ref usage must equal full rebuild"
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
