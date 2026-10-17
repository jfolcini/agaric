// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]
#![allow(clippy::cast_precision_loss)]

//! #5712 — what the session-end sweep costs a pull.
//!
//! A pull's imports record the blocks they take out of a doc in
//! `sync_deferred_purges`, and the session's end purges the ones no engine
//! holds (`loro_sync::sweep_deferred_purges`). Device B holds `TOTAL_BLOCKS`
//! blocks over three spaces, in SQL and in its engines, and the page
//! `P_MOVE` (`PAGE_BLOCKS` blocks) is the one that leaves a doc:
//!
//! - `prune_import` — (a) B imports the doc that drops the page. Pass D
//!   records its ids instead of purging them.
//! - `prune_import_then_sweep` — (a) the same import, then the sweep that
//!   purges the page: the work a real purge costs a pull now, which the import
//!   did inline before.
//! - `claim_import_then_sweep` — (b) B imports the doc the page moved into,
//!   then the sweep, which finds every deferred id claimed and purges nothing.
//! - `sweep_unheld` — (c) a sweep that purges the `UNHELD_PAGES` pages of
//!   space 2 that its doc no longer holds.
//! - `sweep_empty` — (d) what every other pull pays: a sweep with nothing
//!   deferred.
//!
//! Measurement only: each case prints `sync_import_bench: <case> @ 100K = …`
//! and has no budget. Each case's effect is asserted once, untimed, before
//! the timed loops; each timed iteration restores the state it consumed,
//! untimed.

use std::cell::Cell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use agaric_engine::loro::engine::LoroEngine;
use agaric_engine::loro::registry::LoroEngineRegistry;
use agaric_lib::db::init_pool;
use agaric_store::space::SpaceId;
use agaric_sync::sync_protocol::loro_sync::{ApplyOutcome, apply_remote, sweep_deferred_purges};
use agaric_sync::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};
use criterion::{Criterion, criterion_group};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

const SPACES: [&str; 3] = [
    "01SYNCIMPORTBENCHSPACE0000",
    "01SYNCIMPORTBENCHSPACE0001",
    "01SYNCIMPORTBENCHSPACE0002",
];
/// Pages per space; each holds `PAGE_BLOCKS` blocks, itself included.
const PAGES_PER_SPACE: [usize; 3] = [34, 33, 33];
const PAGE_BLOCKS: usize = 1_000;
const TOTAL_BLOCKS: usize = 100_000;
/// Space 2's first pages, which its doc no longer holds: case (c)'s ids.
const UNHELD_PAGES: usize = 10;
const DEVICE_A: &str = "sync-import-bench-device-a";
const DEVICE_B: &str = "sync-import-bench-device-b";

/// Page `p` (numbered across all spaces) or its `c`-th block; `c = 0` is the
/// page itself.
fn block_id(p: usize, c: usize) -> String {
    format!("01SIB{p:03}{c:04}00000000000000")
}

/// The page that leaves space 0.
fn p_move() -> String {
    block_id(0, 0)
}

/// The first page of `space`, numbered across all spaces.
fn first_page(space: usize) -> usize {
    PAGES_PER_SPACE[..space].iter().sum()
}

fn unheld_pages() -> std::ops::Range<usize> {
    first_page(2)..first_page(2) + UNHELD_PAGES
}

// ---------------------------------------------------------------------------
// Elapsed accumulator (mirrors `interactive_slo::Acc`)
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Acc {
    total: Rc<Cell<Duration>>,
    iters: Rc<Cell<u64>>,
}

impl Acc {
    fn record(&self, elapsed: Duration, iters: u64) {
        self.total.set(self.total.get() + elapsed);
        self.iters.set(self.iters.get() + iters);
    }
}

/// Print-only, like `interactive_slo::report_measurement_only`: no budget until
/// a warm run has measured the case.
fn report_measurement_only(case: &str, acc: &Acc) {
    let iters = acc.iters.get();
    assert!(
        iters > 0,
        "sync_import_bench: {case} ran zero iterations (Criterion harness bug?)"
    );
    let mean_ms = (acc.total.get().as_secs_f64() * 1000.0) / iters as f64;
    println!("sync_import_bench: {case} @ 100K = {mean_ms:.2} ms (measurement only — no budget)");
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// A's docs as B sees them, and the two updates the cases import.
struct Docs {
    /// B's engines before anything left a doc.
    s0_full: LoroEngine,
    /// Space 0 after B imported `prune`.
    s0_pruned: LoroEngine,
    /// Space 1 before the page arrived.
    s1_before: LoroEngine,
    /// Space 2 without its `UNHELD_PAGES` pages.
    s2: LoroEngine,
    /// Space 0's update that drops `P_MOVE`, from `prune_from`.
    prune: Vec<u8>,
    prune_from: Vec<u8>,
    /// Space 1's update that brings `P_MOVE`, from `claim_from`.
    claim: Vec<u8>,
    claim_from: Vec<u8>,
}

/// One page and its blocks, through the engine's own create path.
fn create_page(engine: &mut LoroEngine, p: usize) {
    let page = block_id(p, 0);
    engine
        .apply_create_block(&page, "page", &format!("Page {p}"), None, p as i64)
        .expect("create page");
    for c in 1..PAGE_BLOCKS {
        engine
            .apply_create_block(&block_id(p, c), "content", "x", Some(&page), c as i64)
            .expect("create block");
    }
}

fn engine_from(bytes: &[u8]) -> LoroEngine {
    let mut engine = LoroEngine::with_peer_id(DEVICE_B).expect("engine");
    engine.import(bytes).expect("import");
    engine
}

fn build_docs() -> Docs {
    let mut a: Vec<LoroEngine> = (0..3)
        .map(|_| LoroEngine::with_peer_id(DEVICE_A).expect("engine"))
        .collect();
    for (space, engine) in a.iter_mut().enumerate() {
        for p in first_page(space)..first_page(space) + PAGES_PER_SPACE[space] {
            create_page(engine, p);
        }
    }
    let s0_full = engine_from(&a[0].export_snapshot().expect("snapshot"));
    let s1_before = engine_from(&a[1].export_snapshot().expect("snapshot"));

    let prune_from = a[0].version_vector();
    a[0].apply_purge_block(&p_move()).expect("prune");
    let prune = a[0].export_update_since(&prune_from).expect("prune update");
    let mut s0_pruned = s0_full.fork_staging().expect("fork");
    s0_pruned.import(&prune).expect("import prune");

    let claim_from = a[1].version_vector();
    create_page(&mut a[1], 0);
    let claim = a[1].export_update_since(&claim_from).expect("claim update");

    for p in unheld_pages() {
        a[2].apply_purge_block(&block_id(p, 0)).expect("purge");
    }
    let s2 = engine_from(&a[2].export_snapshot().expect("snapshot"));
    Docs {
        s0_full,
        s0_pruned,
        s1_before,
        s2,
        prune,
        prune_from,
        claim,
        claim_from,
    }
}

/// B's SQL: the three spaces and every block of every page, as the docs had
/// them before anything left one. `bench_p_move` and `bench_unheld` keep
/// copies of the rows a case deletes, for its teardown.
async fn seed_sql(pool: &SqlitePool) {
    for space in SPACES {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', 'space', ?)",
        )
        .bind(space)
        .bind(space)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT OR IGNORE INTO spaces (id) VALUES (?)")
            .bind(space)
            .execute(pool)
            .await
            .unwrap();
    }
    const CHUNK: usize = 500;
    let mut tx = pool.begin().await.unwrap();
    for (space, space_id) in SPACES.iter().enumerate() {
        for p in first_page(space)..first_page(space) + PAGES_PER_SPACE[space] {
            let page = block_id(p, 0);
            for start in (0..PAGE_BLOCKS).step_by(CHUNK) {
                let rows = start..(start + CHUNK).min(PAGE_BLOCKS);
                let sql = format!(
                    "INSERT INTO blocks \
                     (id, block_type, content, parent_id, position, page_id, space_id) VALUES {}",
                    vec!["(?, ?, ?, ?, ?, ?, ?)"; rows.len()].join(", ")
                );
                let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
                for c in rows {
                    let (block_type, content, parent) = if c == 0 {
                        ("page", format!("Page {p}"), None)
                    } else {
                        ("content", "x".to_owned(), Some(page.clone()))
                    };
                    let position = if c == 0 { p as i64 } else { c as i64 };
                    q = q
                        .bind(block_id(p, c))
                        .bind(block_type)
                        .bind(content)
                        .bind(parent)
                        .bind(position)
                        .bind(page.clone())
                        .bind(*space_id);
                }
                q.execute(&mut *tx).await.unwrap();
            }
        }
    }
    tx.commit().await.unwrap();
    let unheld: Vec<String> = unheld_pages().map(|p| block_id(p, 0)).collect();
    sqlx::query("CREATE TABLE bench_p_move AS SELECT * FROM blocks WHERE page_id = ?")
        .bind(p_move())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TABLE bench_unheld AS SELECT * FROM blocks \
         WHERE page_id IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(&unheld).unwrap())
    .execute(pool)
    .await
    .unwrap();
}

async fn count(pool: &SqlitePool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn exec(pool: &SqlitePool, sql: &'static str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

fn install(registry: &LoroEngineRegistry, space: usize, template: &LoroEngine) {
    registry.install_engine(
        SpaceId::from_trusted(SPACES[space]),
        template.fork_staging().expect("fork"),
    );
}

async fn import(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    space: usize,
    from_vv: &[u8],
    bytes: &[u8],
) {
    let outcome = apply_remote(
        pool,
        registry,
        DEVICE_B,
        LoroSyncMessage::Update {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: SpaceId::from_trusted(SPACES[space]),
            from_vv: from_vv.to_vec(),
            bytes: bytes.to_vec(),
        },
    )
    .await
    .expect("apply_remote");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "the update imports, got {outcome:?}"
    );
}

const COUNT_BLOCKS: &str = "SELECT COUNT(*) FROM blocks";
const COUNT_DEFERRED: &str = "SELECT COUNT(*) FROM sync_deferred_purges";
/// The 3 space blocks beside the pages' blocks.
const SEEDED_ROWS: i64 = TOTAL_BLOCKS as i64 + 3;

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

/// Run `timed` `iters` times, each between an untimed `setup` and `teardown`,
/// and return the timed total.
fn timed_iters<S, T, D>(
    rt: &Runtime,
    iters: u64,
    acc: &Acc,
    mut setup: impl FnMut() -> S,
    mut timed: impl FnMut() -> T,
    mut teardown: impl FnMut() -> D,
) -> Duration
where
    S: std::future::Future<Output = ()>,
    T: std::future::Future<Output = ()>,
    D: std::future::Future<Output = ()>,
{
    let mut total = Duration::ZERO;
    for _ in 0..iters {
        rt.block_on(setup());
        let start = Instant::now();
        rt.block_on(timed());
        total += start.elapsed();
        rt.block_on(teardown());
    }
    acc.record(total, iters);
    total
}

fn bench_sync_import(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt
        .block_on(init_pool(&dir.path().join("sync_import.db")))
        .unwrap();
    rt.block_on(seed_sql(&pool));
    let docs = build_docs();
    let registry = LoroEngineRegistry::new();
    install(&registry, 0, &docs.s0_full);
    install(&registry, 1, &docs.s1_before);
    install(&registry, 2, &docs.s2);

    // Shape probes: each case's effect, once, untimed.
    rt.block_on(async {
        assert_eq!(
            count(&pool, COUNT_BLOCKS).await,
            SEEDED_ROWS,
            "B's SQL holds the vault"
        );
        let engine_blocks: Vec<usize> = (0..3)
            .map(|space| {
                registry
                    .for_space(&SpaceId::from_trusted(SPACES[space]), DEVICE_B)
                    .unwrap()
                    .engine_mut()
                    .live_block_ids()
                    .unwrap()
                    .len()
            })
            .collect();
        assert_eq!(
            engine_blocks,
            [
                PAGES_PER_SPACE[0] * PAGE_BLOCKS,
                PAGES_PER_SPACE[1] * PAGE_BLOCKS,
                (PAGES_PER_SPACE[2] - UNHELD_PAGES) * PAGE_BLOCKS,
            ],
            "B's engines hold every page but space 2's unheld ones"
        );

        import(&pool, &registry, 0, &docs.prune_from, &docs.prune).await;
        assert_eq!(
            (
                count(&pool, COUNT_DEFERRED).await,
                count(&pool, COUNT_BLOCKS).await
            ),
            (PAGE_BLOCKS as i64, SEEDED_ROWS),
            "(a) the prune import defers the page and deletes nothing"
        );
        let swept = sweep_deferred_purges(&pool, &registry).await.unwrap();
        assert_eq!(
            (swept.len(), count(&pool, COUNT_BLOCKS).await),
            (PAGE_BLOCKS, SEEDED_ROWS - PAGE_BLOCKS as i64),
            "(a) the sweep purges the page"
        );
        exec(&pool, "INSERT INTO blocks SELECT * FROM bench_p_move").await;

        install(&registry, 0, &docs.s0_pruned);
        exec(
            &pool,
            "INSERT INTO sync_deferred_purges (block_id) SELECT id FROM bench_p_move",
        )
        .await;
        import(&pool, &registry, 1, &docs.claim_from, &docs.claim).await;
        let swept = sweep_deferred_purges(&pool, &registry).await.unwrap();
        assert_eq!(
            (
                swept.len(),
                count(&pool, COUNT_DEFERRED).await,
                count(
                    &pool,
                    "SELECT COUNT(*) FROM blocks WHERE space_id = '01SYNCIMPORTBENCHSPACE0001' \
                     AND page_id = '01SIB000000000000000000000'"
                )
                .await,
            ),
            (0, 0, PAGE_BLOCKS as i64),
            "(b) the destination import claims the page and the sweep purges nothing"
        );
        exec(
            &pool,
            "UPDATE blocks SET space_id = '01SYNCIMPORTBENCHSPACE0000' \
             WHERE id IN (SELECT id FROM bench_p_move)",
        )
        .await;
        install(&registry, 0, &docs.s0_full);
        install(&registry, 1, &docs.s1_before);

        exec(
            &pool,
            "INSERT INTO sync_deferred_purges (block_id) SELECT id FROM bench_unheld",
        )
        .await;
        let swept = sweep_deferred_purges(&pool, &registry).await.unwrap();
        assert_eq!(
            (swept.len(), count(&pool, COUNT_BLOCKS).await),
            (
                UNHELD_PAGES * PAGE_BLOCKS,
                SEEDED_ROWS - (UNHELD_PAGES * PAGE_BLOCKS) as i64
            ),
            "(c) the sweep purges every unheld id"
        );
        exec(&pool, "INSERT INTO blocks SELECT * FROM bench_unheld").await;

        assert_eq!(
            sweep_deferred_purges(&pool, &registry).await.unwrap().len(),
            0,
            "(d) an empty table sweeps nothing"
        );
        assert_eq!(
            count(&pool, COUNT_BLOCKS).await,
            SEEDED_ROWS,
            "every case restored the vault"
        );
    });

    let accs: [(&str, Acc); 5] = [
        ("prune_import", Acc::default()),
        ("prune_import_then_sweep", Acc::default()),
        ("claim_import_then_sweep", Acc::default()),
        ("sweep_unheld", Acc::default()),
        ("sweep_empty", Acc::default()),
    ];
    let mut group = c.benchmark_group("sync_import_bench");
    group.sample_size(10);
    group.warm_up_time(Duration::from_secs(1));
    group.measurement_time(Duration::from_secs(5));

    group.bench_function(accs[0].0, |b| {
        b.iter_custom(|iters| {
            timed_iters(
                &rt,
                iters,
                &accs[0].1,
                || async { install(&registry, 0, &docs.s0_full) },
                || import(&pool, &registry, 0, &docs.prune_from, &docs.prune),
                || exec(&pool, "DELETE FROM sync_deferred_purges"),
            )
        });
    });
    group.bench_function(accs[1].0, |b| {
        b.iter_custom(|iters| {
            timed_iters(
                &rt,
                iters,
                &accs[1].1,
                || async { install(&registry, 0, &docs.s0_full) },
                || async {
                    import(&pool, &registry, 0, &docs.prune_from, &docs.prune).await;
                    sweep_deferred_purges(&pool, &registry).await.unwrap();
                },
                || exec(&pool, "INSERT INTO blocks SELECT * FROM bench_p_move"),
            )
        });
    });
    group.bench_function(accs[2].0, |b| {
        b.iter_custom(|iters| {
            timed_iters(
                &rt,
                iters,
                &accs[2].1,
                || async {
                    install(&registry, 0, &docs.s0_pruned);
                    install(&registry, 1, &docs.s1_before);
                    exec(
                        &pool,
                        "INSERT INTO sync_deferred_purges (block_id) SELECT id FROM bench_p_move",
                    )
                    .await;
                },
                || async {
                    import(&pool, &registry, 1, &docs.claim_from, &docs.claim).await;
                    sweep_deferred_purges(&pool, &registry).await.unwrap();
                },
                || async {
                    exec(
                        &pool,
                        "UPDATE blocks SET space_id = '01SYNCIMPORTBENCHSPACE0000' \
                         WHERE id IN (SELECT id FROM bench_p_move)",
                    )
                    .await;
                    install(&registry, 0, &docs.s0_full);
                    install(&registry, 1, &docs.s1_before);
                },
            )
        });
    });
    group.bench_function(accs[3].0, |b| {
        b.iter_custom(|iters| {
            timed_iters(
                &rt,
                iters,
                &accs[3].1,
                || {
                    exec(
                        &pool,
                        "INSERT INTO sync_deferred_purges (block_id) SELECT id FROM bench_unheld",
                    )
                },
                || async {
                    sweep_deferred_purges(&pool, &registry).await.unwrap();
                },
                || exec(&pool, "INSERT INTO blocks SELECT * FROM bench_unheld"),
            )
        });
    });
    group.bench_function(accs[4].0, |b| {
        b.iter_custom(|iters| {
            timed_iters(
                &rt,
                iters,
                &accs[4].1,
                || async {},
                || async {
                    sweep_deferred_purges(&pool, &registry).await.unwrap();
                },
                || async {},
            )
        });
    });
    group.finish();

    for (case, acc) in &accs {
        report_measurement_only(case, acc);
    }
}

criterion_group!(benches, bench_sync_import);
