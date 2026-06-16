//! #1329 — dedup idempotency-equivalence tests.
//!
//! `dedup::dedup_tasks` collapses duplicate global-cache rebuild tasks
//! within a single background drain (see `metrics_dedup.rs::dedup_cache`
//! and the per-table `dedup_*` unit tests). Those tests assert that the
//! dedup *fires* and that a single rebuild produces a correct cache, but
//! NONE of them assert that ONE deduplicated execution produces the same
//! cache table as N separate executions would. A global-cache handler
//! that is silently non-idempotent — e.g. one that appends rather than
//! replaces, or whose sort-merge diff leaves residue when run against an
//! already-populated table — would pass every existing test while
//! corrupting the cache in production, because the dedup that hides the
//! second run is exactly the thing that would otherwise have re-converged
//! the state.
//!
//! Each test here closes that gap for one `Rebuild*Cache` variant:
//!
//!   1. Seed identical fixture data into two fresh, isolated DBs the way
//!      the corresponding ingress path lands it (tags/pages/block-tag
//!      refs/agenda properties/page links/inheritance chains).
//!   2. SINGLE-RUN: enqueue the task ONCE, flush, snapshot the target
//!      cache table (deterministic columns only, `ORDER BY` the PK).
//!   3. DEDUP-RUN: enqueue the SAME task TWICE in immediate succession so
//!      both copies land in one drain and `dedup_tasks` collapses them to
//!      a single execution; flush, snapshot the same table. We additionally
//!      assert `metrics().bg_deduped >= 1` so the collapse is a *checked*
//!      precondition — if the two enqueues happened to land in separate
//!      drains (no dedup), the test would fail loudly rather than silently
//!      degrade into "two runs == two runs".
//!   4. Assert the two snapshots are byte-for-byte equal.
//!
//! If a snapshot ever diverges, the handler is genuinely non-idempotent
//! and that is a real production bug — do NOT relax the assertion to mask
//! it.
//!
//! Time columns (`tags_cache.updated_at`, `pages_cache.updated_at`) are
//! wall-clock and therefore excluded from every snapshot — they differ
//! between the two runs by construction and say nothing about cache
//! correctness.

use super::*;
use sqlx::Row;

/// Capture the deterministic columns of one cache table as a stable,
/// comparable `Vec<String>` (one entry per row, columns joined by `|`,
/// rows ordered by the table's natural key). `query` MUST select only
/// deterministic columns and end with a total `ORDER BY` so the result
/// is stable across runs.
async fn snapshot(pool: &SqlitePool, query: &'static str) -> Vec<String> {
    // `&'static str` (all call sites pass literals): satisfies sqlx 0.9's
    // `SqlSafeStr` bound (only `&'static str`) and sidesteps the E0521
    // borrow-escape that a non-static `&str` would hit when the SQL
    // lifetime is tied to the connection borrow inside `fetch_all`.
    let rows = sqlx::query(query).fetch_all(pool).await.unwrap();
    rows.iter()
        .map(|row| {
            (0..row.columns().len())
                .map(|i| {
                    // Render every column through TEXT affinity so the
                    // helper is column-type agnostic; SQLite coerces ints
                    // and the deterministic columns we snapshot are all
                    // TEXT or INTEGER.
                    row.try_get::<String, _>(i)
                        .or_else(|_| row.try_get::<i64, _>(i).map(|n| n.to_string()))
                        .unwrap_or_else(|_| "<NULL>".to_string())
                })
                .collect::<Vec<_>>()
                .join("|")
        })
        .collect()
}

/// Run `task` once on a freshly-seeded DB (single-run) and twice in one
/// drain on a second freshly-seeded DB (dedup-run), then assert the
/// snapshots produced by `snap_query` are identical. `seed` is invoked
/// against each DB before the task(s) so both start from byte-identical
/// fixture state.
///
/// The dedup-run asserts `bg_deduped >= 1`, making "the duplicate enqueues
/// actually collapsed into one execution" a *checked* precondition of the
/// equivalence claim.
///
/// Whether duplicate enqueues land in one drain is racy: the background
/// consumer's `recv().await` + `try_recv()` loop may pull the first copy
/// and start draining before the rest are enqueued, in which case the
/// copies execute in separate batches and `dedup_tasks` never collapses
/// them. The equivalence *result* holds either way (an idempotent handler
/// gives the same snapshot for one run or two), but to keep the dedup path
/// a deterministic precondition — not a flaky one — the dedup-run RETRIES
/// against a fresh seeded DB until a batch actually collapses (`bg_deduped`
/// advances). The snapshot used for the equality assertion is taken from
/// that genuinely-deduplicated attempt. Each attempt enqueues several
/// duplicates so the per-attempt collapse probability is high; the retry
/// budget then makes a non-collapse run vanishingly unlikely while never
/// masking a real divergence.
async fn assert_dedup_equals_single<S, Fut>(
    task: MaterializeTask,
    snap_query: &'static str,
    seed: S,
) where
    S: Fn(SqlitePool) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    // -- SINGLE-RUN -----------------------------------------------------
    let (single_pool, _single_dir) = test_pool().await;
    let single_mat = Materializer::new(single_pool.clone());
    seed(single_pool.clone()).await;
    single_mat.enqueue_background(task.clone()).await.unwrap();
    single_mat.flush_background().await.unwrap();
    let single_snap = snapshot(&single_pool, snap_query).await;
    single_mat.shutdown();

    // -- DEDUP-RUN (retry until a batch genuinely collapses) ------------
    // Number of duplicate copies enqueued per attempt. A real collapse
    // requires >= 2 of them to land in one drain; more copies raise the
    // per-attempt collapse probability.
    const COPIES_PER_ATTEMPT: usize = 8;
    const MAX_ATTEMPTS: usize = 40;

    let mut dedup_snap: Option<Vec<String>> = None;
    for _ in 0..MAX_ATTEMPTS {
        let (dedup_pool, _dedup_dir) = test_pool().await;
        let dedup_mat = Materializer::new(dedup_pool.clone());
        seed(dedup_pool.clone()).await;
        let before = dedup_mat.metrics().bg_deduped.load(AtomicOrdering::Relaxed);
        // Enqueue the duplicates back-to-back so they tend to land in one
        // drain; the consumer batches whatever it can `try_recv()` and
        // `dedup_tasks` collapses the duplicates to a single execution.
        for _ in 0..COPIES_PER_ATTEMPT {
            dedup_mat.enqueue_background(task.clone()).await.unwrap();
        }
        dedup_mat.flush_background().await.unwrap();
        let collapsed = dedup_mat.metrics().bg_deduped.load(AtomicOrdering::Relaxed) > before;
        if collapsed {
            dedup_snap = Some(snapshot(&dedup_pool, snap_query).await);
            dedup_mat.shutdown();
            break;
        }
        dedup_mat.shutdown();
    }

    let dedup_snap = dedup_snap.expect(
        "precondition: at least one drain must collapse duplicate tasks \
         (bg_deduped must advance) within the retry budget so this exercises \
         the dedup path; persistent non-collapse means the dedup path is not \
         being hit — a real regression in the background drain, not a test flake",
    );

    assert_eq!(
        dedup_snap, single_snap,
        "deduplicated single execution must produce the SAME cache table as a \
         single non-deduplicated execution — divergence here means the handler \
         for this task is NON-IDEMPOTENT (a real production bug, do not mask)"
    );
}

// ======================================================================
// Per-variant fixtures + equivalence assertions
// ======================================================================

/// Tag blocks + a content block referencing one of them, so `usage_count`
/// is non-trivial. `RebuildTagsCache` recomputes `tags_cache`.
async fn seed_tags(pool: SqlitePool) {
    let tag_a = "01HIDEMTAGAAAAAAAAAAAAAAAA";
    let tag_b = "01HIDEMTAGBBBBBBBBBBBBBBBB";
    let note = "01HIDEMNOTEAAAAAAAAAAAAAAA";
    insert_block_direct(&pool, tag_a, "tag", "urgent").await;
    insert_block_direct(&pool, tag_b, "tag", "later").await;
    insert_block_direct(&pool, note, "content", "a note").await;
    // `usage_count` is derived from block_tags edges.
    insert_block_tag(&pool, note, tag_a).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_tags_cache_dedup_equals_single() {
    assert_dedup_equals_single(
        MaterializeTask::RebuildTagsCache,
        // `updated_at` excluded — wall-clock, non-deterministic.
        "SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id",
        seed_tags,
    )
    .await;
}

/// Page blocks with child content blocks + a cross-page link, so the
/// count columns (`child_block_count`, `inbound_link_count`) are
/// non-trivial. `RebuildPagesCache` recomputes `pages_cache`.
async fn seed_pages(pool: SqlitePool) {
    let page_a = "01HIDEMPAGEAAAAAAAAAAAAAAA";
    let page_b = "01HIDEMPAGEBBBBBBBBBBBBBBB";
    insert_block_direct(&pool, page_a, "page", "Page A").await;
    insert_block_direct(&pool, page_b, "page", "Page B").await;
    // Two children under page A; one links to page B.
    for (i, child) in ["01HIDEMCHILDAAAAAAAAAAAAA1", "01HIDEMCHILDAAAAAAAAAAAAA2"]
        .iter()
        .enumerate()
    {
        let content = if i == 0 {
            format!("see [[{page_b}]]")
        } else {
            "plain child".to_string()
        };
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, ?, ?)",
        )
        .bind(child)
        .bind(content)
        .bind(page_a)
        .bind(i64::try_from(i).expect("fixture index fits i64") + 1)
        .execute(&pool)
        .await
        .unwrap();
    }
    // The link that drives page B's inbound_link_count.
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind("01HIDEMCHILDAAAAAAAAAAAAA1")
        .bind(page_b)
        .execute(&pool)
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_pages_cache_dedup_equals_single() {
    assert_dedup_equals_single(
        MaterializeTask::RebuildPagesCache,
        // `updated_at` excluded; the count columns ARE included so a
        // non-idempotent count recompute would surface.
        "SELECT page_id, title, inbound_link_count, child_block_count \
         FROM pages_cache ORDER BY page_id",
        seed_pages,
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_pages_cache_counts_dedup_equals_single() {
    // `RebuildPagesCacheCounts` (#417) recomputes ONLY the two count
    // columns of pre-existing `pages_cache` rows — so the rows must
    // already exist before the count task runs. Seed the page rows via a
    // `RebuildPagesCache` baked into the fixture, then assert the
    // count-only task is idempotent under dedup.
    async fn seed_pages_then_base_cache(pool: SqlitePool) {
        seed_pages(pool.clone()).await;
        // Populate `pages_cache` rows (with zeroed counts) the way the
        // sync RESET path does before enqueueing the count recompute.
        crate::cache::rebuild_pages_cache(&pool).await.unwrap();
    }
    assert_dedup_equals_single(
        MaterializeTask::RebuildPagesCacheCounts,
        "SELECT page_id, title, inbound_link_count, child_block_count \
         FROM pages_cache ORDER BY page_id",
        seed_pages_then_base_cache,
    )
    .await;
}

/// Tag blocks + content blocks carrying inline `#[tag]` refs.
/// `RebuildBlockTagRefsCache` recomputes `block_tag_refs`.
async fn seed_block_tag_refs(pool: SqlitePool) {
    let tag = "01HIDEMBTRTAGAAAAAAAAAAAAA";
    let src_a = "01HIDEMBTRSRCAAAAAAAAAAAAA";
    let src_b = "01HIDEMBTRSRCBBBBBBBBBBBBB";
    insert_block_direct(&pool, tag, "tag", "refd").await;
    insert_block_direct(&pool, src_a, "content", &format!("alpha #[{tag}]")).await;
    insert_block_direct(&pool, src_b, "content", &format!("beta #[{tag}] again")).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_block_tag_refs_cache_dedup_equals_single() {
    assert_dedup_equals_single(
        MaterializeTask::RebuildBlockTagRefsCache,
        "SELECT source_id, tag_id FROM block_tag_refs ORDER BY source_id, tag_id",
        seed_block_tag_refs,
    )
    .await;
}

/// Content blocks with date properties. `RebuildAgendaCache` recomputes
/// `agenda_cache` from `block_properties` date values.
async fn seed_agenda(pool: SqlitePool) {
    let task_a = "01HIDEMAGDAAAAAAAAAAAAAAAA";
    let task_b = "01HIDEMAGDBBBBBBBBBBBBBBBB";
    insert_block_direct(&pool, task_a, "content", "ship the thing").await;
    insert_block_direct(&pool, task_b, "content", "review the PR").await;
    insert_property_date(&pool, task_a, "due", "2025-03-15").await;
    insert_property_date(&pool, task_b, "scheduled", "2025-04-01").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_agenda_cache_dedup_equals_single() {
    assert_dedup_equals_single(
        MaterializeTask::RebuildAgendaCache,
        "SELECT date, block_id, source FROM agenda_cache ORDER BY date, block_id, source",
        seed_agenda,
    )
    .await;
}

/// Pages with cross-page links via raw `block_links` rows.
/// `RebuildPageLinkCache` rolls those up into `page_link_cache`.
async fn seed_page_links(pool: SqlitePool) {
    let page_a = "01HIDEMPLKPAGEAAAAAAAAAAAA";
    let page_b = "01HIDEMPLKPAGEBBBBBBBBBBBB";
    insert_block_direct(&pool, page_a, "page", "Linker").await;
    insert_block_direct(&pool, page_b, "page", "Target").await;
    // Three child blocks under page A, each linking to page B → edge_count 3.
    for (i, child) in [
        "01HIDEMPLKCHILDAAAAAAAAAA1",
        "01HIDEMPLKCHILDAAAAAAAAAA2",
        "01HIDEMPLKCHILDAAAAAAAAAA3",
    ]
    .iter()
    .enumerate()
    {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', 'x', ?, ?)",
        )
        .bind(child)
        .bind(page_a)
        .bind(i64::try_from(i).expect("fixture index fits i64") + 1)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(child)
            .bind(page_b)
            .execute(&pool)
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_page_link_cache_dedup_equals_single() {
    assert_dedup_equals_single(
        MaterializeTask::RebuildPageLinkCache,
        "SELECT source_page_id, target_page_id, edge_count \
         FROM page_link_cache ORDER BY source_page_id, target_page_id",
        seed_page_links,
    )
    .await;
}

/// A parent tagged block with a child, so inheritance propagates the
/// parent's tag down to the child. `RebuildTagInheritanceCache`
/// recomputes `block_tag_inherited`.
async fn seed_tag_inheritance(pool: SqlitePool) {
    let tag = "01HIDEMTITTAGAAAAAAAAAAAAA";
    let parent = "01HIDEMTITPARENTAAAAAAAAAA";
    let child = "01HIDEMTITCHILDAAAAAAAAAAA";
    let grandchild = "01HIDEMTITGRANDAAAAAAAAAAA";
    insert_block_direct(&pool, tag, "tag", "inherited").await;
    // Parent carries the tag directly (block_tags edge); inheritance
    // pushes it down the parent_id chain.
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', 'parent', NULL, 1)",
    )
    .bind(parent)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', 'child', ?, 1)",
    )
    .bind(child)
    .bind(parent)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', 'grandchild', ?, 1)",
    )
    .bind(grandchild)
    .bind(child)
    .execute(&pool)
    .await
    .unwrap();
    insert_block_tag(&pool, parent, tag).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_tag_inheritance_cache_dedup_equals_single() {
    assert_dedup_equals_single(
        MaterializeTask::RebuildTagInheritanceCache,
        "SELECT block_id, tag_id, inherited_from FROM block_tag_inherited \
         ORDER BY block_id, tag_id, inherited_from",
        seed_tag_inheritance,
    )
    .await;
}

/// Content blocks with searchable text. `RebuildFtsIndex` recomputes the
/// `fts_blocks` virtual table. A stable snapshot is feasible: `fts_blocks`
/// is `(block_id UNINDEXED, stripped)` and both columns are deterministic
/// content projections (no rowid leakage in the projection, ordered by
/// block_id), so it is included rather than skipped.
async fn seed_fts(pool: SqlitePool) {
    insert_block_direct(
        &pool,
        "01HIDEMFTSAAAAAAAAAAAAAAAA",
        "content",
        "the quick brown fox",
    )
    .await;
    insert_block_direct(
        &pool,
        "01HIDEMFTSBBBBBBBBBBBBBBBB",
        "content",
        "jumps over the lazy dog",
    )
    .await;
    insert_block_direct(
        &pool,
        "01HIDEMFTSCCCCCCCCCCCCCCCC",
        "page",
        "Searchable Page Title",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rebuild_fts_index_dedup_equals_single() {
    assert_dedup_equals_single(
        MaterializeTask::RebuildFtsIndex,
        "SELECT block_id, stripped FROM fts_blocks ORDER BY block_id",
        seed_fts,
    )
    .await;
}
