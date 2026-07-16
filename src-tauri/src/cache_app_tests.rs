//! App-layer cache tests — the three cache oracle/parity suites relocated out
//! of `agaric_store::cache`'s `tests.rs` (#2621, wave S4c). These call the
//! app-only command inner functions (`crate::commands::{
//! list_projected_agenda_on_the_fly, list_page_links_inner}`), which live above
//! the store layer and cannot move down with the cache read/rebuild module.
//! The rebuild/reindex entry points are reached through the store's public
//! surface (`agaric_store::cache::…`). Behaviour is unchanged from the pre-move
//! `cache/tests.rs`; helpers are copied verbatim from there.

use agaric_store::cache::{
    rebuild_page_link_cache, rebuild_projected_agenda_cache, reindex_page_link_cache_for_block,
};
use sqlx::SqlitePool;
use tempfile::TempDir;

// -- Deterministic test fixtures ------------------------------------------

const FIXED_DELETED_AT: i64 = 1_736_942_400_000;

// -- Helpers (copied verbatim from the pre-move `cache/tests.rs`) ----------

/// Create a fresh SQLite pool with migrations applied (temp directory).
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = crate::db::init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Insert a block with the given type and content.
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

#[allow(clippy::too_many_arguments)]
async fn insert_repeating_block(
    pool: &SqlitePool,
    id: &str,
    due_date: &str,
    scheduled_date: Option<&str>,
    repeat_rule: &str,
    repeat_until: Option<&str>,
    repeat_count: Option<f64>,
    repeat_seq: Option<f64>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, due_date, scheduled_date) \
         VALUES (?1, 'content', 'repeating task', ?2, ?3)",
    )
    .bind(id)
    .bind(due_date)
    .bind(scheduled_date)
    .execute(pool)
    .await
    .unwrap();

    // repeat property
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?1, 'repeat', ?2)",
    )
    .bind(id)
    .bind(repeat_rule)
    .execute(pool)
    .await
    .unwrap();

    // repeat-until
    if let Some(until) = repeat_until {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_date) VALUES (?1, 'repeat-until', ?2)",
        )
        .bind(id)
        .bind(until)
        .execute(pool)
        .await
        .unwrap();
    }

    // repeat-count
    if let Some(count) = repeat_count {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_num) VALUES (?1, 'repeat-count', ?2)",
        )
        .bind(id)
        .bind(count)
        .execute(pool)
        .await
        .unwrap();
    }

    // repeat-seq
    if let Some(seq) = repeat_seq {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_num) VALUES (?1, 'repeat-seq', ?2)",
        )
        .bind(id)
        .bind(seq)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn seed_page_link_fixture(
    pool: &SqlitePool,
    page_a: &str,
    page_b: &str,
    edges: i64,
) -> Vec<String> {
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'Page A')")
        .bind(page_a)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'Page B')")
        .bind(page_b)
        .execute(pool)
        .await
        .unwrap();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let mut children: Vec<String> = Vec::with_capacity(edges as usize);
    for i in 0..edges {
        let child_id = format!("C{i:025}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(&child_id)
        .bind(format!("link [[{page_b}]]"))
        .bind(page_a)
        .bind(i + 1)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&child_id)
            .bind(page_b)
            .execute(pool)
            .await
            .unwrap();
        children.push(child_id);
    }
    children
}

/// #2070: the legacy 3-JOIN oracle for the page-link read path. Mirrors
/// the SQL frozen in `page_link_cache_read_path_matches_legacy_query` —
/// it joins `blocks` live on both endpoints to enforce
/// `src.deleted_at IS NULL`, `tgt.deleted_at IS NULL`, and
/// `tgt.block_type = 'page'`. Since #2070 denormalised those three
/// predicates into the cache flags, the cache-backed read must still
/// produce exactly this set after a soft-delete / non-page target /
/// incremental edit. Returned sorted so callers can compare
/// order-insensitively.
async fn legacy_page_link_oracle(pool: &SqlitePool) -> Vec<(String, String, i64)> {
    let mut rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT
             COALESCE(sb.parent_id, bl.source_id) AS source_id,
             bl.target_id AS target_id,
             COUNT(*) AS ref_count
         FROM block_links bl
         JOIN blocks tb ON tb.id = bl.target_id
             AND tb.block_type = 'page'
             AND tb.deleted_at IS NULL
         JOIN blocks sb ON sb.id = bl.source_id
             AND sb.deleted_at IS NULL
         LEFT JOIN blocks pb ON pb.id = sb.parent_id
             AND pb.deleted_at IS NULL
             AND pb.block_type = 'page'
         WHERE COALESCE(sb.parent_id, bl.source_id) != bl.target_id
             AND (sb.parent_id IS NULL OR pb.id IS NOT NULL)
         GROUP BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    rows.sort();
    rows
}

/// Read the cache-backed path and project to sorted
/// `(source_id, target_id, ref_count)` tuples for order-insensitive
/// comparison against [`legacy_page_link_oracle`].
async fn read_page_links_sorted(pool: &SqlitePool) -> Vec<(String, String, i64)> {
    let mut rows: Vec<(String, String, i64)> =
        crate::commands::list_page_links_inner(pool, &crate::space::SpaceScope::Global, None)
            .await
            .unwrap()
            .edges
            .into_iter()
            .map(|l| {
                (
                    l.source_id.as_str().to_owned(),
                    l.target_id.as_str().to_owned(),
                    l.ref_count,
                )
            })
            .collect();
    rows.sort();
    rows
}

/// CTE oracle test: verifies that the cache produces identical entries
/// to the on-the-fly computation for the same date range.
#[tokio::test]
async fn projected_agenda_cache_oracle_matches_on_the_fly() {
    let (pool, _dir) = test_pool().await;

    let today = chrono::Local::now().date_naive();

    // Create several repeating blocks with various rules
    let due1 = (today - chrono::Duration::days(10))
        .format("%Y-%m-%d")
        .to_string();
    let due2 = today.format("%Y-%m-%d").to_string();
    let due3 = (today + chrono::Duration::days(5))
        .format("%Y-%m-%d")
        .to_string();
    let sched3 = (today + chrono::Duration::days(2))
        .format("%Y-%m-%d")
        .to_string();
    let until4 = (today + chrono::Duration::days(60))
        .format("%Y-%m-%d")
        .to_string();

    // Block 1: weekly repeat, due in the past
    insert_repeating_block(&pool, "ORC01", &due1, None, "weekly", None, None, None).await;

    // Block 2: daily repeat, due today
    insert_repeating_block(&pool, "ORC02", &due2, None, "daily", None, None, None).await;

    // Block 3: monthly repeat with both due_date and scheduled_date
    insert_repeating_block(
        &pool,
        "ORC03",
        &due3,
        Some(&sched3),
        "monthly",
        None,
        None,
        None,
    )
    .await;

    // Block 4: 3d repeat with repeat-until
    insert_repeating_block(&pool, "ORC04", &due2, None, "3d", Some(&until4), None, None).await;

    // Block 5: daily repeat with count limit (5 remaining = 8 count - 3 seq)
    insert_repeating_block(
        &pool,
        "ORC05",
        &due2,
        None,
        "daily",
        None,
        Some(8.0),
        Some(3.0),
    )
    .await;

    // Block 6: .+weekly (from-completion mode) — due today, projects weekly from today
    insert_repeating_block(&pool, "ORC06", &due2, None, ".+weekly", None, None, None).await;

    // Block 7: ++monthly (catch-up mode) — due 30 days ago, catches up to next future occurrence
    let due7 = (today - chrono::Duration::days(30))
        .format("%Y-%m-%d")
        .to_string();
    insert_repeating_block(&pool, "ORC07", &due7, None, "++monthly", None, None, None).await;

    // Block 8: +5d (custom Nd) — due 2 days ago, projects every 5 days
    let due8 = (today - chrono::Duration::days(2))
        .format("%Y-%m-%d")
        .to_string();
    insert_repeating_block(&pool, "ORC08", &due8, None, "+5d", None, None, None).await;

    // Block 9: +2w (custom Nw) — due today, projects every 14 days
    insert_repeating_block(&pool, "ORC09", &due2, None, "+2w", None, None, None).await;

    // Step 1: Rebuild the cache
    rebuild_projected_agenda_cache(&pool).await.unwrap();

    // Step 2: Query the cache for a 90-day window
    let start = today.format("%Y-%m-%d").to_string();
    let end_date = today + chrono::Duration::days(90);
    let end = end_date.format("%Y-%m-%d").to_string();

    let cached_rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT block_id, projected_date, source FROM projected_agenda_cache \
         WHERE projected_date >= ?1 AND projected_date <= ?2 \
         ORDER BY projected_date, block_id, source",
    )
    .bind(&start)
    .bind(&end)
    .fetch_all(&pool)
    .await
    .unwrap();

    // Step 3: Compute on-the-fly for the same range. Call the on-the-fly
    // projector DIRECTLY (not through `list_projected_agenda_inner`, whose
    // #2601 horizon guard would serve this in-horizon range from the cache
    // and turn the oracle into a cache-vs-cache tautology). Within the 90-day
    // window the count-capped cache and the range-clipped on-the-fly path must
    // agree occurrence-for-occurrence.
    let on_the_fly = crate::commands::list_projected_agenda_on_the_fly(
        &pool, today, end_date, 500, today, None, None,
    )
    .await
    .unwrap();

    // Convert on-the-fly results to comparable tuples, sorted
    let mut on_the_fly_tuples: Vec<(String, String, String)> = on_the_fly
        .items
        .iter()
        .map(|e| {
            (
                e.block.id.clone().into(),
                e.projected_date.clone(),
                e.source.clone(),
            )
        })
        .collect();
    on_the_fly_tuples.sort();

    let mut cached_sorted = cached_rows.clone();
    cached_sorted.sort();

    // Step 4: Verify they produce identical entries
    assert_eq!(
        cached_sorted.len(),
        on_the_fly_tuples.len(),
        "cache ({}) and on-the-fly ({}) must produce the same number of entries",
        cached_sorted.len(),
        on_the_fly_tuples.len()
    );

    for (i, (cached, on_fly)) in cached_sorted
        .iter()
        .zip(on_the_fly_tuples.iter())
        .enumerate()
    {
        assert_eq!(
            cached, on_fly,
            "entry {i} differs: cache={cached:?} vs on-the-fly={on_fly:?}"
        );
    }
}

#[tokio::test]
async fn page_link_cache_read_path_matches_legacy_query() {
    let (pool, _dir) = test_pool().await;
    let _children = seed_page_link_fixture(
        &pool,
        "PA000000000000000000000000",
        "PB000000000000000000000000",
        4,
    )
    .await;
    rebuild_page_link_cache(&pool).await.unwrap();

    // #2298: the read path orders by `edge_count DESC` (strongest edges
    // first, count-then-cap); re-sort to the legacy `(source, target)`
    // order for the positional zip below.
    let mut new_rows =
        crate::commands::list_page_links_inner(&pool, &crate::space::SpaceScope::Global, None)
            .await
            .unwrap()
            .edges;
    new_rows.sort();

    let legacy_rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT
             COALESCE(sb.parent_id, bl.source_id) AS source_id,
             bl.target_id AS target_id,
             COUNT(*) AS ref_count
         FROM block_links bl
         JOIN blocks tb ON tb.id = bl.target_id
             AND tb.block_type = 'page'
             AND tb.deleted_at IS NULL
         JOIN blocks sb ON sb.id = bl.source_id
             AND sb.deleted_at IS NULL
         LEFT JOIN blocks pb ON pb.id = sb.parent_id
             AND pb.deleted_at IS NULL
             AND pb.block_type = 'page'
         WHERE COALESCE(sb.parent_id, bl.source_id) != bl.target_id
             AND (sb.parent_id IS NULL OR pb.id IS NOT NULL)
         GROUP BY 1, 2
         ORDER BY 1, 2",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        new_rows.len(),
        legacy_rows.len(),
        "cache-backed read must return the same row count as the legacy rollup"
    );
    for (got, want) in new_rows.iter().zip(legacy_rows.iter()) {
        assert_eq!(got.source_id.as_str(), want.0, "source_id parity");
        assert_eq!(got.target_id.as_str(), want.1, "target_id parity");
        assert_eq!(got.ref_count, want.2, "ref_count parity");
    }
}

/// #2070: denormalised `src_deleted` / `tgt_deleted` / `tgt_is_page`
/// flags must keep the read path identical to the legacy live-join
/// oracle after a soft-delete (full rebuild), an incremental source
/// edit, and against a non-page target. Without the flags the read would
/// surface masked edges because the two `blocks` joins were dropped.
#[tokio::test]
async fn page_link_cache_denormalized_flags_match_legacy_after_mutation() {
    // (a) Soft-delete a TARGET page, FULL rebuild → masked, == oracle.
    {
        let (pool, _dir) = test_pool().await;
        seed_page_link_fixture(
            &pool,
            "PA000000000000000000000000",
            "PB000000000000000000000000",
            4,
        )
        .await;
        rebuild_page_link_cache(&pool).await.unwrap();
        // Baseline: edge surfaces before any deletion.
        assert_eq!(
            read_page_links_sorted(&pool).await,
            legacy_page_link_oracle(&pool).await,
            "baseline read must match the legacy oracle",
        );

        // Soft-delete the target page, then run the full rebuild (the
        // FULL_CACHE_REBUILD_TASKS path on delete cascades). The edge
        // must vanish from the read via tgt_deleted, exactly as the
        // legacy `tgt.deleted_at IS NULL` join did.
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(FIXED_DELETED_AT)
            .bind("PB000000000000000000000000")
            .execute(&pool)
            .await
            .unwrap();
        rebuild_page_link_cache(&pool).await.unwrap();
        let oracle = legacy_page_link_oracle(&pool).await;
        assert!(oracle.is_empty(), "oracle: deleted target masks the edge");
        assert_eq!(
            read_page_links_sorted(&pool).await,
            oracle,
            "deleted-target read must match the legacy oracle (edge masked)",
        );
    }

    // (b) Edit a SOURCE page, INCREMENTAL reindex → == oracle.
    {
        let (pool, _dir) = test_pool().await;
        let children = seed_page_link_fixture(
            &pool,
            "PA000000000000000000000000",
            "PB000000000000000000000000",
            3,
        )
        .await;
        // Incremental path: reindex the changed source block.
        reindex_page_link_cache_for_block(&pool, &children[0])
            .await
            .unwrap();
        assert_eq!(
            read_page_links_sorted(&pool).await,
            legacy_page_link_oracle(&pool).await,
            "incremental reindex read must match the legacy oracle",
        );

        // Soft-delete the SOURCE page, reindex its child block again.
        // The incremental upsert must refresh src_deleted so the read
        // masks the edge — matching the legacy `sb.deleted_at IS NULL`.
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(FIXED_DELETED_AT)
            .bind("PA000000000000000000000000")
            .execute(&pool)
            .await
            .unwrap();
        // Also soft-delete the child so the source-page roll-up has no
        // live contributor, mirroring a page-delete cascade.
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(FIXED_DELETED_AT)
            .bind(&children[0])
            .execute(&pool)
            .await
            .unwrap();
        reindex_page_link_cache_for_block(&pool, &children[0])
            .await
            .unwrap();
        assert_eq!(
            read_page_links_sorted(&pool).await,
            legacy_page_link_oracle(&pool).await,
            "incremental reindex after source delete must match the oracle",
        );
    }

    // (c) Non-page TARGET (tgt_is_page = 0) must be masked.
    {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "PA000000000000000000000000", "page", "Page A").await;
        // Target is a CONTENT block, not a page.
        insert_block(&pool, "TC000000000000000000000000", "content", "not a page").await;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind("CC000000000000000000000000")
        .bind("link [[TC000000000000000000000000]]")
        .bind("PA000000000000000000000000")
        .bind(1)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind("CC000000000000000000000000")
            .bind("TC000000000000000000000000")
            .execute(&pool)
            .await
            .unwrap();
        rebuild_page_link_cache(&pool).await.unwrap();
        let oracle = legacy_page_link_oracle(&pool).await;
        assert!(oracle.is_empty(), "oracle: non-page target masks the edge");
        assert_eq!(
            read_page_links_sorted(&pool).await,
            oracle,
            "non-page-target read must match the legacy oracle (edge masked)",
        );
    }

    // (d) MIXED partial block deletion under a LIVE source page. Two
    // source blocks on the alive page P both link target T; delete ONE.
    // Legacy semantics: the edge stays VISIBLE with ref_count = 1 (only
    // the surviving block counts) — `src_deleted` reflects the PAGE
    // (alive), NOT an aggregate over the blocks. This is the case that
    // catches a rebuild that wrongly counts deleted blocks (ref_count=2)
    // or masks on a block-level aggregate (src_deleted=1 → hidden).
    {
        let (pool, _dir) = test_pool().await;
        // Two child blocks on the SAME live page, both linking the same
        // target page (`seed_page_link_fixture` makes each edge a
        // distinct child block under page A → exactly this shape).
        let children = seed_page_link_fixture(
            &pool,
            "PA000000000000000000000000",
            "PB000000000000000000000000",
            2,
        )
        .await;
        // Soft-delete ONE of the two source blocks; the page stays alive.
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(FIXED_DELETED_AT)
            .bind(&children[0])
            .execute(&pool)
            .await
            .unwrap();

        // FULL rebuild → edge visible, ref_count = 1 (surviving block).
        rebuild_page_link_cache(&pool).await.unwrap();
        let oracle = legacy_page_link_oracle(&pool).await;
        assert_eq!(
            oracle,
            vec![(
                "PA000000000000000000000000".to_string(),
                "PB000000000000000000000000".to_string(),
                1,
            )],
            "oracle: live page with one deleted block → edge visible, ref_count=1",
        );
        assert_eq!(
            read_page_links_sorted(&pool).await,
            oracle,
            "rebuild: live page + partial block deletion must match the legacy \
             oracle — edge visible with ref_count=1 (deleted block excluded), \
             NOT ref_count=2 and NOT masked",
        );

        // Symmetric incremental path: reindex the surviving child block
        // (the change the materializer would enqueue) → same result.
        reindex_page_link_cache_for_block(&pool, &children[1])
            .await
            .unwrap();
        assert_eq!(
            read_page_links_sorted(&pool).await,
            oracle,
            "incremental reindex: live page + partial block deletion must \
             match the legacy oracle (ref_count=1, edge visible)",
        );
    }
}
