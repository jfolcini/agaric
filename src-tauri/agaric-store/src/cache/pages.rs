use sqlx::SqlitePool;

use agaric_core::error::AppError;

// ---------------------------------------------------------------------------
// Set-based rebuild core (issue #112 sub-item 2)
// ---------------------------------------------------------------------------

/// Push the diff down to SQLite: find the page rows that are new, retitled,
/// still at migration 0123's unfilled defaults, or whose `space_id` no longer
/// is the page's, compute their keys in Rust (an NFKD `title_sort_key` has no
/// SQL spelling), UPSERT them, then sweep orphans. Only the stale rows cross
/// the process boundary.
///
/// The "skip unchanged → preserve `updated_at`" semantic is kept: an UPSERT
/// hit refreshes `updated_at` only when the title changed, and a hit that
/// changes nothing at all writes nothing.
///
/// A row is born with `last_edited_ms` = its page's newest op, else the
/// page's ULID creation time, floored at 1; an existing row only ever has it
/// raised (#5371).
///
/// Returns the rows inserted, updated, or deleted.
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

    let mut upserted = 0;
    if !stale.is_empty() {
        let rows: Vec<(String, String, String, i64, Option<String>)> = stale
            .into_iter()
            .map(|r| {
                let key = agaric_core::title_sort::title_sort_key(&r.title);
                let last_edited = upsert_last_edited_ms(r.unfilled, r.newest_op_ms, &r.id);
                (r.id, r.title, key, last_edited, r.space_id)
            })
            .collect();
        let rows_json = serde_json::to_string(&rows)?;
        // `WHERE true`: an UPSERT's SELECT needs a WHERE, or SQLite parses
        // `ON CONFLICT` as a join constraint.
        upserted = sqlx::query!(
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
        .execute(&mut *write_conn)
        .await?
        .rows_affected();
    }

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
    // task (-> [`recompute_all_pages_cache_counts`]) separately.
    Ok(upserted + delete.rows_affected())
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

/// #417: full-table recompute of both `pages_cache` count columns.
///
/// Extracted verbatim (#432-guarded form) from the former tail of
/// [`apply_sort_merge_rebuild`]. The correlated-subquery shape is the
/// exact one used by the per-op
/// `crate::materializer::recompute_pages_cache_counts_for_pages`
/// (the single source of truth for the two columns) with its
/// `WHERE page_id IN (...)` clause dropped so every page is touched —
/// the `rebuild_pages_cache_recomputes_counts_c2` parity test in
/// `cache/tests.rs` asserts these values equal the per-op recompute.
///
/// After a snapshot/sync RESET (which wipes `pages_cache` then
/// re-inserts), every page would read count = 0 until an unrelated
/// per-op edit happened to touch it, breaking MostLinked / MostContent
/// sorts, Orphan / HasNoInboundLinks filters, and the ↗N badge. This
/// recompute is the RESET-path repair, enqueued as the dedicated
/// `RebuildPagesCacheCounts` task (and called by the test-only
/// `rebuild_all_caches`).
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
pub(crate) async fn recompute_all_pages_cache_counts(
    write_conn: &mut sqlx::SqliteConnection,
) -> Result<u64, AppError> {
    // #469 L3: use a CTE so each correlated subquery is evaluated once
    // per pages_cache row rather than twice (once in SET, once in the
    // change-guard WHERE). SQLite does not CSE correlated subqueries
    // across SET and WHERE, so the pre-CTE form ran 4 subquery
    // evaluations per row instead of 2.
    // `+src.space_id`: the unary `+` keeps the planner from driving the inbound
    // count off `idx_blocks_space_type`, a scan of the whole space per page
    // (quadratic in the vault) instead of a walk of the page's own links.
    let counts = sqlx::query!(
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
             FROM pages_cache p \
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
    )
    .execute(&mut *write_conn)
    .await?;

    Ok(counts.rows_affected())
}

// ---------------------------------------------------------------------------
// Rebuild_pages_cache (p1-t19,; #112 set-based form)
// ---------------------------------------------------------------------------

/// Incremental rebuild of `pages_cache`.
///
/// 1. UPSERT the rows that are new, retitled, or still unfilled since
///    migration 0123 (see `apply_sort_merge_rebuild`). Unchanged hits are
///    no-ops, so their `updated_at` is preserved.
/// 2. `DELETE FROM pages_cache WHERE page_id NOT IN (live page IDs)` —
///    sweeps cache rows whose source block was soft-deleted, hard
///    deleted, demoted from `block_type = 'page'`, or had its content
///    cleared.
#[tracing::instrument(skip(pool), err)]
pub async fn rebuild_pages_cache(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("pages", || rebuild_pages_cache_impl(pool)).await
}

async fn rebuild_pages_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
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

// ---------------------------------------------------------------------------
// rebuild_pages_cache_counts (#417 — RESET-only full count recompute)
// ---------------------------------------------------------------------------

/// #417: full-table recompute of `pages_cache.{inbound_link_count,
/// child_block_count}` in its own write transaction. Background entry
/// point for the dedicated `MaterializeTask::RebuildPagesCacheCounts`.
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
///
/// Mirrors [`rebuild_pages_cache`]'s `begin_immediate_logged` +
/// `rebuild_with_timing` shape but runs the count-only
/// `recompute_all_pages_cache_counts`.
pub async fn rebuild_pages_cache_counts(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("pages_counts", || rebuild_pages_cache_counts_impl(pool)).await
}

async fn rebuild_pages_cache_counts_impl(pool: &SqlitePool) -> Result<u64, AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_pages_counts_rebuild").await?;
    let changed = recompute_all_pages_cache_counts(&mut tx).await?;
    if changed == 0 {
        // No count drift — transaction is rolled back on drop.
        return Ok(0);
    }
    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Read/write split variant (Phase 1A)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`rebuild_pages_cache`].
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
    _read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    let now = crate::db::now_ms();
    // The rebuild (UPSERT from `blocks` + delete-orphans) runs on a
    // single write transaction. SQLite
    // is one file regardless of pool split, so the write connection
    // already sees `blocks`; the read pool is unused under the new
    // shape but kept in the signature so call sites in
    // `rebuild_pages_cache_split` are stable.
    let mut tx = crate::db::begin_immediate_logged(write_pool, "cache_pages_rebuild_write").await?;

    let changed = apply_sort_merge_rebuild(&mut tx, now).await?;

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

        let baseline = rebuild_pages_cache_impl(&pool).await.unwrap();
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

        let touched = rebuild_pages_cache_impl(&pool).await.unwrap();
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

        rebuild_pages_cache_impl(&pool).await.unwrap();
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
}
