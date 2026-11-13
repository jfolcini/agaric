use sqlx::SqlitePool;

use agaric_core::error::AppError;

// ---------------------------------------------------------------------------
// Set-based rebuild core (issue #112 sub-item 2)
// ---------------------------------------------------------------------------

/// The page rows that are new, retitled, still at migration 0123's unfilled
/// defaults, or whose `space_id` no longer is the page's, as the [`PageRow`]
/// each is upserted with: over every page, or with `among <a JSON id array>`
/// over those pages. One text, so the pages the read half finds are the pages
/// the write half rewrites.
///
/// `newest_op_ms` is the per-block MAX over `idx_op_log_block_created`,
/// folded per page, and is only computed for a row whose `last_edited_ms` is
/// unfilled. A row is born with `last_edited_ms` = its page's newest op, else
/// the page's ULID creation time, floored at 1; an existing row only ever has
/// it raised (#5371).
macro_rules! stale_page_rows {
    () => {
        stale_page_rows!(@scoped "")
    };
    (among $ids_json:expr) => {
        stale_page_rows!(@scoped " AND b.id IN (SELECT value FROM json_each(?))", $ids_json)
    };
    (@scoped $scope:literal $(, $ids_json:expr)?) => {
        sqlx::query!(
            r#"SELECT b.id AS "id!", b.content AS "title!", b.space_id AS "space_id?",
                  COALESCE(pc.last_edited_ms, 0) = 0 AS "unfilled!: bool",
                  CASE WHEN COALESCE(pc.last_edited_ms, 0) = 0 THEN
                      (SELECT MAX((SELECT MAX(o.created_at) FROM op_log o
                                    WHERE o.block_id = d.id))
                         FROM blocks d WHERE d.page_id = b.id)
                  END AS "newest_op_ms?: i64"
             FROM blocks b
             LEFT JOIN pages_cache pc ON pc.page_id = b.id
            WHERE b.block_type = 'page' AND b.deleted_at IS NULL AND b.content IS NOT NULL
              AND (pc.page_id IS NULL
                   OR pc.title != b.content
                   OR (pc.title_sort_key = '' AND b.content != '')
                   OR pc.last_edited_ms = 0
                   OR pc.space_id IS NOT b.space_id)"#
                + $scope
            $(, $ids_json)?
        )
        .map(|r| page_row(r.id, r.title, r.space_id, r.unfilled, r.newest_op_ms))
    };
}

/// The `pages_cache` rows `pc` whose source block was soft deleted, hard
/// deleted, demoted from `block_type = 'page'`, or had its content cleared:
/// `select` reads the ids of all of them, `delete among <a JSON id array>`
/// deletes the ones among those ids. One predicate for the read half and the
/// write half. It seeks each row's block by id.
macro_rules! orphaned_page_rows {
    (select) => {
        orphaned_page_rows!(
            @statement query_scalar,
            "SELECT pc.page_id AS \"page_id!\" FROM pages_cache pc WHERE"
        )
    };
    (delete among $ids_json:expr) => {
        orphaned_page_rows!(
            @statement query,
            "DELETE FROM pages_cache AS pc \
             WHERE pc.page_id IN (SELECT value FROM json_each(?)) AND",
            $ids_json
        )
    };
    (@statement $query:ident, $head:literal $(, $ids_json:expr)?) => {
        sqlx::$query!(
            $head
                + " NOT EXISTS ( \
                     SELECT 1 FROM blocks b \
                     WHERE b.id = pc.page_id AND b.block_type = 'page' \
                       AND b.deleted_at IS NULL AND b.content IS NOT NULL)"
            $(, $ids_json)?
        )
    };
}

/// The write half of [`rebuild_pages_cache_split`]: UPSERT the pages among
/// `stale_json` that are still stale, with keys computed in Rust (an NFKD
/// `title_sort_key` has no SQL spelling), then delete the rows among
/// `orphans_json` that are still orphans. Both read their blocks again under
/// the writer lock, so a write that landed since the read half is never
/// undone.
///
/// The "skip unchanged → preserve `updated_at`" semantic is kept: an UPSERT
/// hit refreshes `updated_at` only when the title changed, and a hit that
/// changes nothing at all writes nothing.
///
/// Returns the rows inserted, updated, or deleted.
async fn rederive_page_rows_of(
    write_conn: &mut sqlx::SqliteConnection,
    stale_json: &str,
    orphans_json: &str,
    now: i64,
) -> Result<u64, AppError> {
    let rows = stale_page_rows!(among stale_json)
        .fetch_all(&mut *write_conn)
        .await?;
    let upserted = upsert_page_rows(&mut *write_conn, &rows, now).await?;

    let delete = orphaned_page_rows!(delete among orphans_json)
        .execute(&mut *write_conn)
        .await?;

    // #417: the count recompute was REMOVED from this title/orphan
    // rebuild. It used to run an UNCONDITIONAL full-table correlated-
    // subquery UPDATE here on every `RebuildPagesCache` task — which is
    // enqueued on every per-op page mutation (create / edit-title /
    // delete / restore / purge / move), i.e. O(pages) correlated
    // subqueries on every page edit. For ordinary per-op rebuilds the
    // affected pages' counts are now maintained in-tx (sync `ApplyOp`
    // via `maintain_pages_cache_counts_after_op`; local command paths
    // via `recompute_pages_cache_counts_for_pages`), so the full-table
    // pass was pure redundant work. It is only genuinely required after
    // a snapshot/sync RESET that wiped `pages_cache` (counts default to
    // 0), which now enqueues the dedicated `RebuildPagesCacheCounts`
    // task (-> [`rebuild_pages_cache_counts`]) separately.
    Ok(upserted + delete.rows_affected())
}

/// A page row as [`upsert_page_rows`] writes it: id, title, title sort key,
/// `last_edited_ms`, `space_id`.
type PageRow = (String, String, String, i64, Option<String>);

/// The row a stale or missing page is upserted with: its title's key in
/// Rust, since an NFKD `title_sort_key` has no SQL spelling.
fn page_row(
    id: String,
    title: String,
    space_id: Option<String>,
    unfilled: bool,
    newest_op_ms: Option<i64>,
) -> PageRow {
    let key = agaric_core::title_sort::title_sort_key(&title);
    let last_edited = upsert_last_edited_ms(unfilled, newest_op_ms, &id);
    (id, title, key, last_edited, space_id)
}

/// UPSERT `rows`. A hit refreshes `updated_at` only when the title changed,
/// only ever raises `last_edited_ms`, and writes nothing when nothing
/// changed. Returns the rows written.
async fn upsert_page_rows(
    conn: &mut sqlx::SqliteConnection,
    rows: &[PageRow],
    now: i64,
) -> Result<u64, AppError> {
    if rows.is_empty() {
        return Ok(0);
    }
    let rows_json = serde_json::to_string(rows)?;
    // `WHERE true`: an UPSERT's SELECT needs a WHERE, or SQLite parses
    // `ON CONFLICT` as a join constraint.
    Ok(sqlx::query!(
        "INSERT INTO pages_cache \
             (page_id, title, title_sort_key, last_edited_ms, space_id, updated_at) \
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), \
                json_extract(value, '$[2]'), json_extract(value, '$[3]'), \
                json_extract(value, '$[4]'), ?1 \
           FROM json_each(?2) \
          WHERE true \
         ON CONFLICT(page_id) DO UPDATE SET \
             title          = excluded.title, \
             title_sort_key = excluded.title_sort_key, \
             last_edited_ms = MAX(pages_cache.last_edited_ms, excluded.last_edited_ms), \
             space_id       = excluded.space_id, \
             updated_at     = CASE WHEN pages_cache.title != excluded.title \
                                   THEN excluded.updated_at ELSE pages_cache.updated_at END \
          WHERE pages_cache.title != excluded.title \
             OR pages_cache.title_sort_key != excluded.title_sort_key \
             OR pages_cache.last_edited_ms < excluded.last_edited_ms \
             OR pages_cache.space_id IS NOT excluded.space_id",
        now,
        rows_json,
    )
    .execute(&mut *conn)
    .await?
    .rows_affected())
}

/// Give each live, titled page among `ids` that has no `pages_cache` row its
/// row, in the caller's transaction (#5371). The page-row rebuild sweeps a
/// trashed page's row and the Pages list reads its rows from `pages_cache`,
/// so every restore path calls this over the blocks it brought back, or a
/// restored page stays off the list until the debounced rebuild lands. The
/// row is born as the rebuild births one; its counts are left to the
/// restore's `RebuildPagesCacheCounts`.
pub async fn insert_missing_pages_cache_rows<S: AsRef<str> + Sync>(
    conn: &mut sqlx::SqliteConnection,
    ids: &[S],
) -> Result<(), AppError> {
    let ids: Vec<&str> = ids.iter().map(AsRef::as_ref).collect();
    let ids_json = serde_json::to_string(&ids)?;
    let missing = sqlx::query!(
        r#"SELECT b.id AS "id!", b.content AS "title!", b.space_id AS "space_id?",
                  (SELECT MAX((SELECT MAX(o.created_at) FROM op_log o
                                WHERE o.block_id = d.id))
                     FROM blocks d WHERE d.page_id = b.id) AS "newest_op_ms?: i64"
             FROM blocks b
            WHERE b.id IN (SELECT value FROM json_each(?))
              AND b.block_type = 'page' AND b.deleted_at IS NULL AND b.content IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM pages_cache pc WHERE pc.page_id = b.id)"#,
        ids_json,
    )
    .fetch_all(&mut *conn)
    .await?;
    let rows: Vec<PageRow> = missing
        .into_iter()
        .map(|r| page_row(r.id, r.title, r.space_id, true, r.newest_op_ms))
        .collect();
    upsert_page_rows(conn, &rows, crate::db::now_ms()).await?;
    Ok(())
}

/// The `last_edited_ms` a stale row is upserted with. 0 leaves a filled row's
/// value alone: the UPSERT keeps the MAX. A born value is at least 1 so 0
/// stays the unfilled marker: a seeded space page's ULID time is 0, and once
/// compaction drops its ops, boot would otherwise reschedule this rebuild
/// forever.
fn upsert_last_edited_ms(unfilled: bool, newest_op_ms: Option<i64>, id: &str) -> i64 {
    if unfilled {
        newest_op_ms.unwrap_or_else(|| ulid_created_ms(id)).max(1)
    } else {
        0
    }
}

/// The creation time in a ULID page id; 0 for an id that is not one.
fn ulid_created_ms(id: &str) -> i64 {
    ulid::Ulid::from_string(id)
        .ok()
        .and_then(|u| i64::try_from(u.timestamp_ms()).ok())
        .unwrap_or(0)
}

/// Raise `last_edited_ms` for the page each `(block_id, created_at)` op
/// touched: the block's own `page_id`, which is the page itself for a page
/// block. Never lowers it, so a replayed or out-of-order op is a no-op (#5371).
/// One statement per call; every path that lands an op in `op_log` calls it
/// once in the same transaction: a local command's commit, the
/// materializer's single-op and batch apply, and a peer's replicated op.
///
/// A block that no longer exists (a purge) or whose page has no cache row
/// touches nothing: a row the rebuild inserts later is born from the op log.
pub async fn raise_pages_last_edited_ms(
    conn: &mut sqlx::SqliteConnection,
    touched: &[(&str, i64)],
) -> Result<(), sqlx::Error> {
    if touched.is_empty() {
        return Ok(());
    }
    let touched_json =
        serde_json::to_string(touched).map_err(|e| sqlx::Error::Encode(Box::new(e)))?;
    sqlx::query!(
        "UPDATE pages_cache SET last_edited_ms = touched.ms \
           FROM (SELECT b.page_id AS page_id, MAX(json_extract(j.value, '$[1]')) AS ms \
                   FROM json_each(?) AS j \
                   JOIN blocks b ON b.id = json_extract(j.value, '$[0]') \
                  GROUP BY b.page_id) AS touched \
          WHERE pages_cache.page_id = touched.page_id \
            AND touched.ms > pages_cache.last_edited_ms",
        touched_json,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Copy each page's `blocks.space_id` onto its `pages_cache` row, in the
/// caller's transaction, so a page a `space` write re-homes lists in its new
/// space at commit (#5371). Ids without a cache row touch nothing; the
/// page-row rebuild repairs every path that does not call this.
pub async fn sync_pages_cache_space_ids(
    conn: &mut sqlx::SqliteConnection,
    page_ids: &[&str],
) -> Result<(), AppError> {
    let ids_json = serde_json::to_string(page_ids)?;
    sqlx::query!(
        "UPDATE pages_cache \
            SET space_id = (SELECT b.space_id FROM blocks b WHERE b.id = pages_cache.page_id) \
          WHERE page_id IN (SELECT value FROM json_each(?))",
        ids_json,
    )
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// A statement that opens with `computed(page_id, new_inbound, new_child)`:
/// both count columns as a page's blocks and links give them now, for the
/// `pages_cache` rows `p` that `$tail` narrows. `$tail` closes the CTE and is
/// the statement proper. One text for the read half, the write half and the
/// oracle the split is tested against, so they cannot count differently.
///
/// `+src.space_id`: the unary `+` keeps the planner from driving the inbound
/// count off `idx_blocks_space_type`, a scan of the whole space per page
/// (quadratic in the vault) instead of a walk of the page's own links.
macro_rules! with_computed_page_counts {
    ($query:ident, $tail:literal $(, $page_ids_json:expr)?) => {
        sqlx::$query!(
            "WITH computed(page_id, new_inbound, new_child) AS ( \
                 SELECT p.page_id, \
                     ( \
                         SELECT COUNT(DISTINCT bl.source_id) FROM block_links bl \
                             JOIN blocks descendant ON bl.target_id = descendant.id \
                             JOIN blocks src ON src.id = bl.source_id \
                             JOIN blocks page ON page.id = p.page_id \
                             WHERE descendant.page_id = p.page_id \
                               AND descendant.deleted_at IS NULL \
                               AND src.deleted_at IS NULL \
                               AND src.page_id IS NOT NULL \
                               AND src.page_id != p.page_id \
                               AND +src.space_id IS page.space_id \
                     ), \
                     ( \
                         SELECT COUNT(*) FROM blocks descendant \
                             WHERE descendant.page_id = p.page_id \
                               AND descendant.deleted_at IS NULL \
                               AND descendant.id != p.page_id \
                     ) \
                 FROM pages_cache p "
                + $tail
            $(, $page_ids_json)?
        )
    };
}

/// Recompute both `pages_cache` count columns for the pages named in
/// `page_ids_json`: the write half of [`rebuild_pages_cache_counts_split`].
///
/// The correlated-subquery shape is the exact one used by the per-op
/// `crate::materializer::recompute_pages_cache_counts_for_pages`
/// (the single source of truth for the two columns) —
/// the `rebuild_pages_cache_recomputes_counts_c2` parity test in
/// `cache/tests.rs` asserts these values equal the per-op recompute.
///
/// After a snapshot/sync RESET (which wipes `pages_cache` then
/// re-inserts), every page would read count = 0 until an unrelated
/// per-op edit happened to touch it, breaking MostLinked / MostContent
/// sorts, Orphan / HasNoInboundLinks filters, and the ↗N badge. The
/// `RebuildPagesCacheCounts` task is that RESET-path repair.
///
/// # Why these two columns exist — KEEP (#2508, measured; drop rejected)
///
/// The #2508 audit flagged the `inbound_link_count` / `child_block_count`
/// columns as a possible drop ("read the canonical live SELECT instead").
/// They are **not** droppable: they are the sort keys for `MostLinked` /
/// `MostContent`, each read in order from its own index (migration 0124),
/// and the predicate for the `Orphan` / `Stub` / `HasNoInboundLinks` filters
/// (`commands/pages/metadata.rs` `keyset_for`, `filters/primitive.rs`), which
/// read the column for every candidate page — a cheap materialised-column
/// read per page. Migration `0069` created these columns precisely to replace the
/// per-row `COUNT(DISTINCT …) FROM block_links` correlated subquery;
/// dropping them re-introduces that O(N)-subquery cost (guarded today by
/// `most_linked_perf_gate_20k_pages` +
/// `most_linked_query_plan_uses_pages_cache_not_block_links`).
///
/// The #2508 `interactive_slo` probe measured the direct count query at
/// **0.96 ms @ 100K**, but only over a **50-page sample** (`WHERE page_id
/// IN (…50 ids…)`) — that is the badge-render cost for one visible Pages
/// page, NOT the sort/filter cost across the whole space. It does not
/// justify a drop; the justification for keeping is the O(N)-subquery
/// avoidance at sort/filter time. Verdict: **keep, justified.**
///
/// #432: the guard `WHERE inbound_link_count != (<subq>) OR
/// child_block_count != (<subq>)` makes the UPDATE touch ONLY rows whose
/// materialised value actually differs, so `rows_affected()` is exactly
/// the number of pages whose counts changed. This also keeps
/// `updated_at` stable: the count UPDATE never writes `updated_at`, so
/// The recency semantic is owned solely by the title UPSERT's
/// `WHERE title != excluded.title`.
async fn recompute_pages_cache_counts_of(
    write_conn: &mut sqlx::SqliteConnection,
    page_ids_json: &str,
) -> Result<u64, AppError> {
    let counts = with_computed_page_counts!(
        query,
        "WHERE p.page_id IN (SELECT value FROM json_each(?)) \
         ) \
         UPDATE pages_cache SET \
             inbound_link_count = c.new_inbound, \
             child_block_count  = c.new_child \
         FROM computed c \
         WHERE pages_cache.page_id = c.page_id \
           AND ( \
               pages_cache.inbound_link_count != c.new_inbound \
            OR pages_cache.child_block_count  != c.new_child \
           )",
        page_ids_json
    )
    .execute(&mut *write_conn)
    .await?;

    Ok(counts.rows_affected())
}

/// The pages whose cached counts differ from the counts their blocks and
/// links give now: the read half of [`rebuild_pages_cache_counts_split`].
async fn pages_with_stale_counts(read_pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    Ok(with_computed_page_counts!(
        query_scalar,
        ") \
         SELECT pc.page_id AS \"page_id!\" FROM computed c \
         JOIN pages_cache pc ON pc.page_id = c.page_id \
         WHERE pc.inbound_link_count != c.new_inbound \
            OR pc.child_block_count  != c.new_child"
    )
    .fetch_all(read_pool)
    .await?)
}

// ---------------------------------------------------------------------------
// Rebuild_pages_cache (p1-t19,; #112 set-based form)
// ---------------------------------------------------------------------------

/// Incremental rebuild of `pages_cache`: [`rebuild_pages_cache_split`] with
/// one pool for both halves.
#[tracing::instrument(skip(pool), err)]
pub async fn rebuild_pages_cache(pool: &SqlitePool) -> Result<(), AppError> {
    rebuild_pages_cache_split(pool, pool).await
}

/// Rebuild the `pages_cache` rows with the whole-vault comparison on
/// `read_pool`.
///
/// 1. Finds the pages whose row is missing, retitled, or still unfilled since
///    migration 0123 (`stale_page_rows`), and the cache rows whose source
///    block is no longer a live titled page (`orphaned_page_rows`).
/// 2. Takes the writer lock only when there are any, and under it UPSERTs
///    and deletes those rows ([`rederive_page_rows_of`]). Unchanged hits are
///    no-ops, so their `updated_at` is preserved.
///
/// A page that goes stale after step 1 read it is left to the rebuild its
/// own write enqueues, which runs after this one.
pub async fn rebuild_pages_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("pages", || rebuild_pages_cache_impl(write_pool, read_pool)).await
}

async fn rebuild_pages_cache_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    let stale: Vec<String> = stale_page_rows!()
        .fetch_all(read_pool)
        .await?
        .into_iter()
        .map(|(page_id, ..)| page_id)
        .collect();
    let orphans: Vec<String> = orphaned_page_rows!(select).fetch_all(read_pool).await?;
    if stale.is_empty() && orphans.is_empty() {
        return Ok(0);
    }
    let (stale_json, orphans_json) = (
        serde_json::to_string(&stale)?,
        serde_json::to_string(&orphans)?,
    );
    let now = crate::db::now_ms();
    let mut tx = crate::db::begin_immediate_logged(write_pool, "cache_pages_rebuild_write").await?;
    let changed = rederive_page_rows_of(&mut tx, &stale_json, &orphans_json, now).await?;
    tx.commit().await?;
    Ok(changed)
}

/// Rewrite every `pages_cache.title_sort_key` from its row's title in one
/// transaction, and record
/// [`Derivation::TitleSortKey`](crate::derivations::Derivation). The page-row
/// rebuild keys only a row whose title changed, so a change to
/// `title_sort_key` reaches the rows already cached only through this pass
/// (#6488). Returns the rows rewritten.
///
/// # Errors
/// Returns [`AppError`] if any statement fails; nothing is recorded then.
pub async fn rekey_title_sort_keys(pool: &SqlitePool) -> Result<u64, AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_pages_rekey").await?;
    let rows = sqlx::query!(r#"SELECT page_id AS "page_id!", title AS "title!" FROM pages_cache"#)
        .fetch_all(&mut *tx)
        .await?;
    let keyed: Vec<(String, String)> = rows
        .into_iter()
        .map(|r| {
            let key = agaric_core::title_sort::title_sort_key(&r.title);
            (r.page_id, key)
        })
        .collect();
    let keyed_json = serde_json::to_string(&keyed)?;
    let rewritten = sqlx::query!(
        "UPDATE pages_cache SET title_sort_key = json_extract(j.value, '$[1]') \
         FROM json_each(?) AS j \
         WHERE pages_cache.page_id = json_extract(j.value, '$[0]') \
           AND pages_cache.title_sort_key != json_extract(j.value, '$[1]')",
        keyed_json,
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    crate::derivations::record(&mut *tx, crate::derivations::Derivation::TitleSortKey).await?;
    tx.commit().await?;
    Ok(rewritten)
}

// ---------------------------------------------------------------------------
// rebuild_pages_cache_counts (#417 — RESET-only full count recompute)
// ---------------------------------------------------------------------------

/// #417: full-table recompute of `pages_cache.{inbound_link_count,
/// child_block_count}`. Background entry point for the dedicated
/// `MaterializeTask::RebuildPagesCacheCounts`.
///
/// Enqueue sites (as of #2042; the dispatch matrix in
/// `src-tauri/agaric-engine/src/materializer/dispatch.rs` is the single source of truth):
/// this task is a member of all three global-rebuild sets there, so it runs
/// on
///   - every local `delete` / `restore` / `purge` lifecycle op
///     (`FULL_CACHE_REBUILD_TASKS` / `CONTENT_LIFECYCLE_REBUILD_TASKS`),
///     now coalesced per burst by the #2935 local-lifecycle trailing
///     debounce rather than fired inline per op;
///   - the #2291 debounced inbound-sync fan-out
///     (`INBOUND_SYNC_CACHE_REBUILD_TASKS`); and
///   - the snapshot / sync RESET path (after `RebuildPagesCache` re-inserts
///     the page rows).
///
/// #2042 made it the background replacement for the former synchronous
/// foreground count recompute, which is why it now runs per lifecycle op and
/// not only on RESET.
pub async fn rebuild_pages_cache_counts(pool: &SqlitePool) -> Result<(), AppError> {
    rebuild_pages_cache_counts_split(pool, pool).await
}

/// [`rebuild_pages_cache_counts`] with the whole-vault count on `read_pool`.
/// The writer lock is taken only when a page's counts are stale, and held
/// only to recount those pages: counting them again under the lock, instead
/// of writing the read phase's numbers, keeps a count a foreground write
/// maintained in between from being overwritten with an older one.
pub async fn rebuild_pages_cache_counts_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("pages_counts", || {
        rebuild_pages_cache_counts_impl(write_pool, read_pool)
    })
    .await
}

async fn rebuild_pages_cache_counts_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    let stale = pages_with_stale_counts(read_pool).await?;
    if stale.is_empty() {
        return Ok(0);
    }
    let stale_json = serde_json::to_string(&stale)?;
    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_pages_counts_rebuild").await?;
    let changed = recompute_pages_cache_counts_of(&mut tx, &stale_json).await?;
    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Sort-merge tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests scoped to this file so the parent `cache::tests`
    //! module is not touched. Helpers are local copies of the patterns
    //! in `cache/tests.rs`.
    use super::*;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        crate::test_support::test_pool().await
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
            "UPDATE blocks SET deleted_at = 1767139200000 WHERE id = ?",
            id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn clear_page_content(pool: &SqlitePool, id: &str) {
        sqlx::query!("UPDATE blocks SET content = NULL WHERE id = ?", id)
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

    /// Three pages with children, links across and within pages, a deleted
    /// child and a deleted link source, then page rows whose counts are
    /// unset (A), wrong in one column (B) and right (C).
    async fn seed_count_drift(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, page_id, deleted_at) VALUES \
             ('PGA', 'page', 'A', NULL, 'PGA', NULL), \
             ('PGB', 'page', 'B', NULL, 'PGB', NULL), \
             ('PGC', 'page', 'C', NULL, 'PGC', NULL), \
             ('A1', 'content', 'a', 'PGA', 'PGA', NULL), \
             ('A2', 'content', 'a', 'A1',  'PGA', NULL), \
             ('A3', 'content', 'a', 'PGA', 'PGA', 1767139200000), \
             ('B1', 'content', 'b', 'PGB', 'PGB', NULL), \
             ('B2', 'content', 'b', 'PGB', 'PGB', 1767139200000), \
             ('C1', 'content', 'c', 'PGC', 'PGC', NULL)",
        )
        .execute(pool)
        .await
        .unwrap();
        // Into A: B1 and C1 count, the deleted B2 and the same-page A2 do
        // not. Into B: A1 and C1 (C1's two links are one source).
        sqlx::query(
            "INSERT INTO block_links (source_id, target_id) VALUES \
             ('B1', 'PGA'), ('C1', 'A2'), ('B2', 'A1'), ('A2', 'PGA'), \
             ('A1', 'B1'), ('C1', 'PGB'), ('C1', 'B1')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO pages_cache \
                 (page_id, title, updated_at, inbound_link_count, child_block_count) VALUES \
             ('PGA', 'A', 1, 0, 0), ('PGB', 'B', 1, 2, 9), ('PGC', 'C', 1, 0, 1)",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// The whole-vault recompute [`rebuild_pages_cache_counts_split`]
    /// replaced, which counted every page under the writer lock: the oracle
    /// the split is tested against.
    async fn recompute_all_pages_cache_counts(
        write_conn: &mut sqlx::SqliteConnection,
    ) -> Result<u64, AppError> {
        let counts = with_computed_page_counts!(
            query,
            ") \
             UPDATE pages_cache SET \
                 inbound_link_count = c.new_inbound, \
                 child_block_count  = c.new_child \
             FROM computed c \
             WHERE pages_cache.page_id = c.page_id \
               AND ( \
                   pages_cache.inbound_link_count != c.new_inbound \
                OR pages_cache.child_block_count  != c.new_child \
               )"
        )
        .execute(&mut *write_conn)
        .await?;
        Ok(counts.rows_affected())
    }

    async fn counts(pool: &SqlitePool) -> Vec<(String, i64, i64)> {
        sqlx::query_as(
            "SELECT page_id, inbound_link_count, child_block_count \
             FROM pages_cache ORDER BY page_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// #6522: the split rebuild leaves `pages_cache` where the whole-vault
    /// recompute it replaced does, and changes the same rows.
    #[tokio::test]
    async fn rebuild_pages_cache_counts_split_matches_the_whole_vault_recompute_6522() {
        let (oracle_pool, _oracle_dir) = test_pool().await;
        let (pool, _dir) = test_pool().await;
        seed_count_drift(&oracle_pool).await;
        seed_count_drift(&pool).await;

        let mut tx = oracle_pool.begin().await.unwrap();
        let oracle_changed = recompute_all_pages_cache_counts(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
        let changed = rebuild_pages_cache_counts_impl(&pool, &pool).await.unwrap();

        assert_eq!(oracle_changed, 2, "A and B drifted, C did not");
        assert_eq!(changed, oracle_changed);
        assert_eq!(counts(&pool).await, counts(&oracle_pool).await);
        assert_eq!(
            counts(&pool).await,
            vec![
                ("PGA".to_owned(), 2, 2),
                ("PGB".to_owned(), 2, 1),
                ("PGC".to_owned(), 0, 1),
            ],
        );
        assert_eq!(
            rebuild_pages_cache_counts_impl(&pool, &pool).await.unwrap(),
            0,
            "a second run finds nothing stale"
        );
    }

    /// #6522: the write half recounts only the pages it is handed, so the
    /// writer lock is not held for the rest of the vault.
    #[tokio::test]
    async fn recompute_pages_cache_counts_of_leaves_other_pages_alone_6522() {
        let (pool, _dir) = test_pool().await;
        seed_count_drift(&pool).await;

        let mut tx = pool.begin().await.unwrap();
        let changed = recompute_pages_cache_counts_of(&mut tx, r#"["PGA"]"#)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(changed, 1);
        assert_eq!(
            counts(&pool).await,
            vec![
                ("PGA".to_owned(), 2, 2),
                ("PGB".to_owned(), 2, 9),
                ("PGC".to_owned(), 0, 1),
            ],
            "B keeps its planted counts"
        );
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

        let first = rebuild_pages_cache_impl(&pool, &pool).await.unwrap();
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

        let touched = rebuild_pages_cache_impl(&pool, &pool).await.unwrap();
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
        let first = rebuild_pages_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(first, 50);
        let second = rebuild_pages_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(second, 0, "idempotent rebuild must produce zero diff ops");
        assert_eq!(snapshot(&pool).await.len(), 50);
    }

    async fn snapshot_with_ts(pool: &SqlitePool) -> Vec<(String, String, i64)> {
        sqlx::query_as::<_, (String, String, i64)>(
            "SELECT page_id, title, updated_at FROM pages_cache ORDER BY page_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// Issue #112 sub-item 2 — set-based rebuild parity. Seeds all five
    /// post-rebuild cases (title-changed, title-unchanged, new,
    /// soft-deleted, content-cleared) and verifies:
    ///   (a) `pages_cache` rows match the expected set,
    ///   (b) `updated_at` was refreshed **only** for the title-changed
    /// Row (semantic — the `WHERE pages_cache.title !=
    ///       excluded.title` predicate on the ON CONFLICT DO UPDATE is
    ///       what keeps cache recency from regressing).
    ///
    /// The content-cleared case exists so the DELETE's `content IS NOT
    /// NULL` filter doesn't quietly regress: the UPSERT already skips
    /// such blocks (its SELECT filters `content IS NOT NULL`), so
    /// without the DELETE-side filter the cache row would persist
    /// forever as a stale orphan.
    #[tokio::test]
    async fn rebuild_pages_cache_set_based_parity_112() {
        let (pool, _dir) = test_pool().await;

        // Seed four pages → baseline rebuild populates the cache.
        // - CHANGED: title will be edited before the second rebuild.
        // - SAME: title untouched → unchanged-title hit on second rebuild.
        // - GONE: will be soft-deleted before the second rebuild.
        // - CLEARED: will have content set to NULL before the second rebuild.
        // NEW is inserted *after* the baseline rebuild.
        insert_page(&pool, "PAGEAAAA", "Changed Title").await;
        insert_page(&pool, "PAGEBBBB", "Same Title").await;
        insert_page(&pool, "PAGECCCC", "Gone Title").await;
        insert_page(&pool, "PAGEEEEE", "Cleared Title").await;

        let baseline = rebuild_pages_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(baseline, 4, "baseline inserts 4 rows");

        // Capture the baseline timestamps so we can diff post-rebuild.
        let baseline_rows = snapshot_with_ts(&pool).await;
        assert_eq!(baseline_rows.len(), 4);
        let ts_for = |id: &str| -> i64 {
            baseline_rows
                .iter()
                .find(|(p, _, _)| p == id)
                .map_or_else(|| panic!("missing baseline row for {id}"), |(_, _, t)| *t)
        };
        let ts_changed_before = ts_for("PAGEAAAA");
        let ts_same_before = ts_for("PAGEBBBB");

        // Force a measurable gap between baseline and rebuild
        // `now_rfc3339()` calls — the timestamp has ms precision and a
        // same-ms collision would mask both a stale `updated_at` and a
        // spuriously-refreshed one.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;

        // Mutate to exercise all five diff cases:
        //   AAAA → title-changed, BBBB → untouched (unchanged-title hit),
        //   CCCC → soft-deleted, DDDD → new, EEEE → content-cleared.
        update_page_title(&pool, "PAGEAAAA", "Changed Title v2").await;
        soft_delete(&pool, "PAGECCCC").await;
        insert_page(&pool, "PAGEDDDD", "Brand New").await;
        clear_page_content(&pool, "PAGEEEEE").await;

        let touched = rebuild_pages_cache_impl(&pool, &pool).await.unwrap();
        // 1 upsert-update (title-changed) + 1 upsert-insert (new) +
        // 2 deletes (soft-deleted + content-cleared) = 4 rows_affected.
        // Unchanged-title hit is a no-op and must NOT contribute.
        assert_eq!(
            touched, 4,
            "expected exactly 1 title-update + 1 insert + 2 deletes; \
             unchanged-title hits must be no-ops"
        );

        // (a) Final row set matches expectation.
        let actual = snapshot(&pool).await;
        let expected = vec![
            ("PAGEAAAA".to_string(), "Changed Title v2".to_string()),
            ("PAGEBBBB".to_string(), "Same Title".to_string()),
            ("PAGEDDDD".to_string(), "Brand New".to_string()),
        ];
        assert_eq!(actual, expected, "cache must reflect mutated source");

        // (b) updated_at semantics: refreshed ONLY for the title-changed row.
        let after = snapshot_with_ts(&pool).await;
        let ts_after_for = |id: &str| -> i64 {
            after.iter().find(|(p, _, _)| p == id).map_or_else(
                || panic!("missing post-rebuild row for {id}"),
                |(_, _, t)| *t,
            )
        };

        assert_ne!(
            ts_after_for("PAGEAAAA"),
            ts_changed_before,
            "title-changed row must have its updated_at refreshed",
        );
        assert_eq!(
            ts_after_for("PAGEBBBB"),
            ts_same_before,
            "title-unchanged row must preserve its prior updated_at \
             (invariant — the `WHERE title != excluded.title` \
             predicate on ON CONFLICT DO UPDATE is mandatory)",
        );
    }

    async fn last_edited(pool: &SqlitePool, page: &str) -> i64 {
        sqlx::query_scalar("SELECT last_edited_ms FROM pages_cache WHERE page_id = ?")
            .bind(page)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// #5371 — a page row with no op is born at its ULID creation time; an
    /// op on the page or any of its blocks then raises it, and an older op
    /// never lowers it.
    #[tokio::test]
    async fn last_edited_ms_is_born_at_creation_then_only_raised_5371() {
        let (pool, _dir) = test_pool().await;
        let page = "01J00000000000000000PAGE5D";
        let child = "01J00000000000000000CHDX5D";
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', 'P', ?)",
        )
        .bind(page)
        .bind(page)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, page_id) \
             VALUES (?, 'content', 'c', ?, ?)",
        )
        .bind(child)
        .bind(page)
        .bind(page)
        .execute(&pool)
        .await
        .unwrap();

        rebuild_pages_cache_impl(&pool, &pool).await.unwrap();
        let created = ulid_created_ms(page);
        assert_eq!(
            last_edited(&pool, page).await,
            created,
            "no op: creation time"
        );

        let mut conn = pool.acquire().await.unwrap();
        raise_pages_last_edited_ms(&mut conn, &[(page, created + 5), (child, created + 10)])
            .await
            .unwrap();
        assert_eq!(
            last_edited(&pool, page).await,
            created + 10,
            "the newest op on any block of the page"
        );
        raise_pages_last_edited_ms(&mut conn, &[(child, created + 1)])
            .await
            .unwrap();
        assert_eq!(
            last_edited(&pool, page).await,
            created + 10,
            "an older op never lowers it"
        );
    }

    /// The rebuild [`rebuild_pages_cache_split`] replaced, as it was: it took
    /// the writer lock, then found the stale and the orphaned rows over the
    /// whole vault and wrote them. The oracle the split is tested against
    /// (#6522).
    mod replaced {
        use super::super::*;

        async fn apply_sort_merge_rebuild(
            write_conn: &mut sqlx::SqliteConnection,
            now: i64,
        ) -> Result<u64, AppError> {
            // `newest_op_ms` is the per-block MAX over `idx_op_log_block_created`,
            // folded per page, and is only computed for a row whose
            // `last_edited_ms` is unfilled.
            let stale = sqlx::query!(
                r#"SELECT b.id AS "id!", b.content AS "title!", b.space_id AS "space_id?",
                          COALESCE(pc.last_edited_ms, 0) = 0 AS "unfilled!: bool",
                          CASE WHEN COALESCE(pc.last_edited_ms, 0) = 0 THEN
                              (SELECT MAX((SELECT MAX(o.created_at) FROM op_log o
                                            WHERE o.block_id = d.id))
                                 FROM blocks d WHERE d.page_id = b.id)
                          END AS "newest_op_ms?: i64"
                     FROM blocks b
                     LEFT JOIN pages_cache pc ON pc.page_id = b.id
                    WHERE b.block_type = 'page' AND b.deleted_at IS NULL AND b.content IS NOT NULL
                      AND (pc.page_id IS NULL
                           OR pc.title != b.content
                           OR (pc.title_sort_key = '' AND b.content != '')
                           OR pc.last_edited_ms = 0
                           OR pc.space_id IS NOT b.space_id)"#,
            )
            .fetch_all(&mut *write_conn)
            .await?;

            let rows: Vec<PageRow> = stale
                .into_iter()
                .map(|r| page_row(r.id, r.title, r.space_id, r.unfilled, r.newest_op_ms))
                .collect();
            let upserted = upsert_page_rows(&mut *write_conn, &rows, now).await?;

            let delete = sqlx::query!(
                "DELETE FROM pages_cache \
                 WHERE page_id NOT IN ( \
                     SELECT id FROM blocks \
                     WHERE block_type = 'page' AND deleted_at IS NULL AND content IS NOT NULL \
                 )",
            )
            .execute(&mut *write_conn)
            .await?;

            // #417: the count recompute was REMOVED from this title/orphan
            // rebuild. It used to run an UNCONDITIONAL full-table correlated-
            // subquery UPDATE here on every `RebuildPagesCache` task — which is
            // enqueued on every per-op page mutation (create / edit-title /
            // delete / restore / purge / move), i.e. O(pages) correlated
            // subqueries on every page edit. For ordinary per-op rebuilds the
            // affected pages' counts are now maintained in-tx (sync `ApplyOp`
            // via `maintain_pages_cache_counts_after_op`; local command paths
            // via `recompute_pages_cache_counts_for_pages`), so the full-table
            // pass was pure redundant work. It is only genuinely required after
            // a snapshot/sync RESET that wiped `pages_cache` (counts default to
            // 0), which now enqueues the dedicated `RebuildPagesCacheCounts`
            // task (-> [`rebuild_pages_cache_counts`]) separately.
            Ok(upserted + delete.rows_affected())
        }

        pub(super) async fn rebuild_pages_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
            let now = crate::db::now_ms();
            // Single write connection — the rebuild reads `blocks` and writes
            // `pages_cache` on the same transaction. No separate reader
            // connections are needed.
            let mut tx = crate::db::begin_immediate_logged(pool, "cache_pages_rebuild").await?;

            let changed = apply_sort_merge_rebuild(&mut tx, now).await?;

            if changed == 0 {
                // No changes — transaction is rolled back on drop.
                return Ok(0);
            }

            tx.commit().await?;
            Ok(changed)
        }
    }

    /// Five pages and cache rows that are missing (NEW's), retitled (OLD's),
    /// right (SAME's), and orphaned by a soft delete (GONE's), a cleared
    /// title (BLANK's) and a block that is not a page (NOTE's).
    async fn seed_page_row_drift(pool: &SqlitePool) {
        for (id, title) in [
            ("NEW", "New"),
            ("OLD", "Retitled"),
            ("SAME", "Same"),
            ("GONE", "Gone"),
            ("BLANK", "Blank"),
        ] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', ?, ?)",
            )
            .bind(id)
            .bind(title)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('NOTE', 'content', 'n')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO pages_cache (page_id, title, title_sort_key, last_edited_ms, updated_at) \
             VALUES ('OLD', 'Old', 'old', 5, 1), ('SAME', 'Same', 'same', 5, 1), \
                    ('GONE', 'Gone', 'gone', 5, 1), ('BLANK', 'Blank', 'blank', 5, 1), \
                    ('NOTE', 'Note', 'note', 5, 1)",
        )
        .execute(pool)
        .await
        .unwrap();
        soft_delete(pool, "GONE").await;
        clear_page_content(pool, "BLANK").await;
    }

    /// #6522: the split rebuild leaves the `pages_cache` rows where the
    /// rebuild it replaced does, and changes the same rows.
    #[tokio::test]
    async fn rebuild_pages_cache_split_matches_the_rebuild_it_replaced_6522() {
        let (oracle_pool, _oracle_dir) = test_pool().await;
        let (pool, _dir) = test_pool().await;
        seed_page_row_drift(&oracle_pool).await;
        seed_page_row_drift(&pool).await;

        let oracle_changed = replaced::rebuild_pages_cache_impl(&oracle_pool)
            .await
            .unwrap();
        let changed = rebuild_pages_cache_impl(&pool, &pool).await.unwrap();

        assert_eq!(
            oracle_changed, 5,
            "NEW inserted, OLD retitled, GONE, BLANK and NOTE swept"
        );
        assert_eq!(changed, oracle_changed);
        assert_eq!(snapshot(&pool).await, snapshot(&oracle_pool).await);
        let titled = |id: &str, title: &str| (id.to_owned(), title.to_owned());
        assert_eq!(
            snapshot(&pool).await,
            vec![
                titled("NEW", "New"),
                titled("OLD", "Retitled"),
                titled("SAME", "Same"),
            ],
        );
        assert_eq!(
            rebuild_pages_cache_impl(&pool, &pool).await.unwrap(),
            0,
            "a second run finds nothing stale"
        );
    }

    /// #6522: the same, after every round of random writes to the tables the
    /// rebuild reads and to the cache itself.
    #[tokio::test]
    async fn rebuild_pages_cache_split_matches_the_rebuild_it_replaced_on_random_vaults_6522() {
        crate::cache::random_vault_tests::assert_rebuild_matches_oracle(
            "pages_cache",
            "page_id, title, title_sort_key, last_edited_ms, space_id",
            async |pool| replaced::rebuild_pages_cache_impl(pool).await.unwrap(),
            async |pool| rebuild_pages_cache_impl(pool, pool).await.unwrap(),
        )
        .await;
    }

    /// #6522: the split count rebuild and the whole-vault recompute it
    /// replaced agree after every round of random writes. Both are built from
    /// one count text, so this holds the read half's choice of pages, not the
    /// counts, to the oracle.
    #[tokio::test]
    async fn rebuild_pages_cache_counts_split_matches_the_whole_vault_recompute_on_random_vaults_6522()
     {
        crate::cache::random_vault_tests::assert_rebuild_matches_oracle(
            "pages_cache",
            "page_id, inbound_link_count, child_block_count",
            async |pool| {
                rebuild_pages_cache_impl(pool, pool).await.unwrap();
                let mut tx = pool.begin().await.unwrap();
                let changed = recompute_all_pages_cache_counts(&mut tx).await.unwrap();
                tx.commit().await.unwrap();
                changed
            },
            async |pool| {
                rebuild_pages_cache_impl(pool, pool).await.unwrap();
                rebuild_pages_cache_counts_impl(pool, pool).await.unwrap()
            },
        )
        .await;
    }

    /// #6522: the write half rewrites only the rows it is handed, from what
    /// the tables hold when it runs.
    #[tokio::test]
    async fn rederive_page_rows_of_touches_only_the_rows_named_6522() {
        let (pool, _dir) = test_pool().await;
        seed_page_row_drift(&pool).await;
        // Writes land after the read half: OLD is retitled again, and GONE
        // comes back from the trash.
        update_page_title(&pool, "OLD", "Retitled twice").await;
        sqlx::query("UPDATE blocks SET deleted_at = NULL WHERE id = 'GONE'")
            .execute(&pool)
            .await
            .unwrap();

        let mut tx = pool.begin().await.unwrap();
        let changed = rederive_page_rows_of(&mut tx, r#"["OLD","SAME"]"#, r#"["GONE","NOTE"]"#, 9)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(changed, 2, "OLD upserted and NOTE swept");
        let titled = |id: &str, title: &str| (id.to_owned(), title.to_owned());
        assert_eq!(
            snapshot(&pool).await,
            vec![
                titled("BLANK", "Blank"),
                titled("GONE", "Gone"),
                titled("OLD", "Retitled twice"),
                titled("SAME", "Same"),
            ],
            "OLD takes the title it has now, GONE is a live page again and keeps its row, \
             and NEW and BLANK, not named, are left as they were"
        );
    }

    /// #6522: with nothing stale neither rebuild asks for the writer lock, so
    /// both finish while another connection holds it.
    #[tokio::test]
    async fn rebuild_pages_cache_takes_no_writer_lock_when_nothing_is_stale_6522() {
        let (pool, _dir) = test_pool().await;
        seed_page_row_drift(&pool).await;
        rebuild_pages_cache(&pool).await.unwrap();
        rebuild_pages_cache_counts(&pool).await.unwrap();

        let _writer = crate::db::begin_immediate_logged(&pool, "test_holds_the_lock")
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            rebuild_pages_cache(&pool).await.unwrap();
            rebuild_pages_cache_counts(&pool).await.unwrap();
        })
        .await
        .expect("the rebuilds must not wait for the writer lock");
    }

    /// #6522: what runs under the writer lock seeks the stale and the
    /// orphaned rows by id; it never scans `blocks` or `pages_cache`.
    #[tokio::test]
    async fn rederive_page_rows_of_never_scans_a_table_6522() {
        use sqlx::Execute as _;
        let (pool, _dir) = test_pool().await;
        let ids = "[]".to_owned();
        let statements = [
            stale_page_rows!(among ids).sql().as_str().to_owned(),
            orphaned_page_rows!(delete among ids)
                .sql()
                .as_str()
                .to_owned(),
        ];
        for sql in statements {
            let plan: Vec<(i64, i64, i64, String)> =
                sqlx::query_as(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")))
                    .bind("[]")
                    .fetch_all(&pool)
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
