// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Cold-start / vault-open benchmark on a 100K-block vault (#1231 Phase 2).
//!
//! This measures the most user-visible scale metric that previously had ZERO
//! coverage: opening the app on a large vault and getting to a first usable
//! render. The latency benches (`interactive_slo`, `page_load`, …) all run
//! against an already-open, already-warm pool; nothing measured the *open*.
//!
//! The cold-start sequence we model, in order:
//!   1. `init_pool` — open the on-disk SQLite DB (runs migrations / WAL setup
//!      against a populated 100K-row file, not an empty one).
//!   2. `list_all_pages_in_space_inner` — the page-list load that fills the
//!      sidebar at open (must scan ~1000 page rows out of 100K blocks).
//!   3. `load_page_subtree_inner` — first-page render (the single-SELECT page
//!      loader; time-to-first-usable-render of the landing page).
//!   4. Initial materialization / cache rebuild — `rebuild_pages_cache`,
//!      `rebuild_tags_cache`, `rebuild_agenda_cache`, `rebuild_page_link_cache`
//!      — the set-based derived-state warm that a first open triggers. These
//!      are all GROUP-BY/set-based and cheap at 100K. We deliberately EXCLUDE
//!      `rebuild_page_ids`: it is a depth-bounded recursive ancestor-walk CTE
//!      over every block (pathologically slow at 100K) AND it is not part of a
//!      normal open — `page_id` is migration-backfilled (0066/0073) and
//!      maintained incrementally, not recomputed on each launch. Including it
//!      would model a maintenance reindex, not the cold open this bench targets.
//!
//! Each step is benched separately so a regression points at the offending
//! stage rather than one opaque "open" number. The fixture is seeded ONCE per
//! group into a persistent `TempDir`; the pool-open bench reopens that file
//! cold on each sample, while the read/rebuild benches reuse one open pool.
//!
//! ## Fixture schema-drift rules (benches/AGENTS.md)
//! Seeders mirror `interactive_slo.rs::seed_resolve_fixture` (now on main):
//! `op_log.created_at` is INTEGER epoch-ms (migration 0079); every `page`
//! block carries `page_id = id` (0073); space membership is the first-class
//! `blocks.space_id` column (0086) backed by a `spaces` registry row (0089);
//! no reserved property keys (0088). Ids are fixed-width so they sort.

use criterion::{Criterion, criterion_group, criterion_main};

use agaric_lib::cache::{
    rebuild_agenda_cache, rebuild_page_link_cache, rebuild_pages_cache, rebuild_tags_cache,
};
use agaric_lib::commands::{list_all_pages_in_space_inner, load_page_subtree_inner};
use agaric_lib::db::init_pool;
use agaric_lib::ulid::BlockId;

use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// 100K-block vault — the realistic ceiling the SLO is defined at (#1231).
const VAULT_SIZE: usize = 100_000;

/// ~1 page per 100 content blocks → 1000 pages at 100K total, matching the
/// real-world shape `interactive_slo` uses.
const PAGE_COUNT: usize = 1_000;

/// Space ULID for the seeded vault (Crockford base32, 26 chars).
const COLD_SPACE_ID: &str = "01COLDSTART0000000000000001";

/// Base `op_log.created_at`, epoch milliseconds (2025-01-15T12:00:00Z).
/// INTEGER-NOT-NULL since migration 0079; seeders add a monotonic offset.
const COLD_BASE_TS_MS: i64 = 1_736_942_400_000;

/// Cold-start is dominated by I/O and one-shot setup, not steady-state
/// throughput; keep the sample count low so the 100K seed + rebuilds finish
/// in a reasonable wall-clock budget.
const SAMPLE_SIZE: usize = 10;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async fn open_pool(db_path: &Path) -> SqlitePool {
    init_pool(db_path).await.unwrap()
}

/// Seed `VAULT_SIZE` blocks across `PAGE_COUNT` pages with `page_id` and
/// `space_id` set, plus one `op_log` row per content block. Mirrors
/// `interactive_slo.rs::seed_resolve_fixture`. Returns the id of the first
/// page (used as the "landing page" for the first-render bench).
async fn seed_vault(pool: &SqlitePool, n: usize) -> String {
    let mut tx = pool.begin().await.unwrap();

    // Space-owner page + `spaces` registry row. `blocks.space_id` REFERENCES
    // spaces(id) (migration 0089), so the owner must exist there first.
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'ColdStartSpace', NULL, NULL, ?)",
    )
    .bind(COLD_SPACE_ID)
    .bind(COLD_SPACE_ID)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
        .bind(COLD_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();

    // PAGE_COUNT pages, each `page_id = id` (migration 0073 CHECK) and in the
    // space (so the sidebar page-list load sees them). Page ids are real ULIDs
    // (`BlockId::new`) because `load_page_subtree_inner` runs the landing page
    // id through `BlockId::from_string` validation (a fixed-width filler id
    // would fail with "invalid ULID").
    let mut page_ids: Vec<String> = Vec::with_capacity(PAGE_COUNT);
    for p in 0..PAGE_COUNT {
        let page_id = BlockId::new().into_string();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', ?, NULL, ?, ?, ?)",
        )
        .bind(&page_id)
        .bind(format!("Cold-start vault page {p}"))
        .bind(p as i64 + 1)
        .bind(&page_id)
        .bind(COLD_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();
        page_ids.push(page_id);
    }

    // n content blocks distributed round-robin across the pages.
    for i in 0..n {
        let id = format!("CSBK{i:020}");
        let content = format!("Cold-start block {i} with some placeholder content.");
        let ts = COLD_BASE_TS_MS + i as i64;
        let owning_page = &page_ids[i % PAGE_COUNT];
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'content', ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&content)
        .bind(owning_page)
        .bind(i as i64 + 1)
        .bind(owning_page)
        .bind(COLD_SPACE_ID)
        .execute(&mut *tx)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES ('dev-bench', ?, 'fakehash', 'create_block', ?, ?)",
        )
        .bind(i as i64 + 1)
        .bind(format!(
            r#"{{"block_id":"{id}","block_type":"content","parent_id":"{owning_page}","content":"{content}"}}"#,
        ))
        .bind(ts)
        .execute(&mut *tx)
        .await
        .unwrap();
    }

    tx.commit().await.unwrap();
    page_ids[0].clone()
}

/// Seed the vault once into a persistent `TempDir`, returning the dir (kept
/// alive by the caller so the file isn't deleted), the db path, and the
/// landing-page id. The pool is dropped after seeding so the on-disk file is
/// what a cold open sees.
fn seed_vault_on_disk(rt: &Runtime) -> (TempDir, PathBuf, String) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("cold_start_vault.db");
    let landing = rt.block_on(async {
        let pool = open_pool(&db_path).await;
        let landing = seed_vault(&pool, VAULT_SIZE).await;
        // Checkpoint + close so the cold-open bench reads a settled file.
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .execute(&pool)
            .await
            .ok();
        pool.close().await;
        landing
    });
    (dir, db_path, landing)
}

// ===========================================================================
// 1. open_pool — reopen the on-disk 100K-block DB (cold)
// ===========================================================================

fn bench_cold_open_pool(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let (_dir, db_path, _landing) = seed_vault_on_disk(&rt);

    let mut group = c.benchmark_group("cold_start");
    group.sample_size(SAMPLE_SIZE);
    group.bench_function("open_pool_100k", |b| {
        b.to_async(&rt).iter(|| {
            let db_path = db_path.clone();
            async move {
                let pool = open_pool(&db_path).await;
                pool.close().await;
            }
        });
    });
    group.finish();
}

// ===========================================================================
// 2. page-list load — fills the sidebar at open
// ===========================================================================

fn bench_cold_page_list_load(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let (_dir, db_path, _landing) = seed_vault_on_disk(&rt);
    let pool = rt.block_on(open_pool(&db_path));

    let mut group = c.benchmark_group("cold_start");
    group.sample_size(SAMPLE_SIZE);
    group.bench_function("page_list_load_100k", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                list_all_pages_in_space_inner(&pool, COLD_SPACE_ID, None)
                    .await
                    .unwrap()
            }
        });
    });
    group.finish();

    rt.block_on(async { pool.close().await });
}

// ===========================================================================
// 3. first-page render — time-to-first-usable-render of the landing page
// ===========================================================================

fn bench_cold_first_page_render(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let (_dir, db_path, landing) = seed_vault_on_disk(&rt);
    let pool = rt.block_on(open_pool(&db_path));

    let mut group = c.benchmark_group("cold_start");
    group.sample_size(SAMPLE_SIZE);
    group.bench_function("first_page_render_100k", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            let landing = landing.clone();
            async move {
                load_page_subtree_inner(&pool, &landing, COLD_SPACE_ID)
                    .await
                    .unwrap()
            }
        });
    });
    group.finish();

    rt.block_on(async { pool.close().await });
}

// ===========================================================================
// 4. initial materialization — the derived-state rebuild a first open triggers
// ===========================================================================

fn bench_cold_initial_materialization(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let (_dir, db_path, _landing) = seed_vault_on_disk(&rt);
    let pool = rt.block_on(open_pool(&db_path));

    let mut group = c.benchmark_group("cold_start");
    group.sample_size(SAMPLE_SIZE);
    // The set-based derived-state warm: pages/tags/agenda caches and the
    // page-link cache. This is what "rebuild caches on open" costs at 100K
    // blocks. Run as one combined unit since that's the user-facing cost.
    // (`rebuild_page_ids` is excluded — see the module doc comment.)
    group.bench_function("initial_materialization_100k", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                rebuild_pages_cache(&pool).await.unwrap();
                rebuild_tags_cache(&pool).await.unwrap();
                rebuild_agenda_cache(&pool).await.unwrap();
                rebuild_page_link_cache(&pool).await.unwrap();
            }
        });
    });
    group.finish();

    rt.block_on(async { pool.close().await });
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(
    cold_start_benches,
    bench_cold_open_pool,
    bench_cold_page_list_load,
    bench_cold_first_page_render,
    bench_cold_initial_materialization,
);
criterion_main!(cold_start_benches);
