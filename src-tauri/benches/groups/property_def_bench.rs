// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmarks for property-definition CRUD operations.
//!
//! Benches:
//!   1. `create_property_def`          — create a new definition
//!   2. `list_property_defs`           — list all definitions
//!   3. `update_property_def_options`  — update options on a select-type def
//!   4. `delete_property_def`          — delete a definition (re-insert between iterations)
//!   5. `create_property_def_over_held_values` — declare `date` over N values a
//!      space holds: the whole command, which holds the writer lock while it
//!      re-types every value (#5841)
//!   6. `import_property_def_change`   — a peer imports that declaration over
//!      its own N values and re-types them (#5841)
//!   7. `rename_property_key`          — rename a key N values hold: the whole
//!      command, which holds the writer lock (#5841)
//!   8. `merge_property_key`           — merge a key N values hold into one half
//!      of them also hold: the whole command (#5841)
//!   9. `import_rename_property_key`   — a peer imports a rename of the key its
//!      own N values hold (#5841)
//!
//! Benches 5 to 9 print, once and untimed, the op log payload and the Loro
//! update their op costs.

use std::time::{Duration, Instant};

use criterion::{BenchmarkId, Criterion, Throughput, criterion_group};

use agaric_engine::loro::engine::LoroEngine;
use agaric_engine::loro::registry::LoroEngineRegistry;
use agaric_lib::commands::{
    PropertyMergeCounts, capture_op_refs, create_property_def_inner, delete_property_def_inner,
    list_property_defs_inner, merge_property_key_inner, rename_property_key_inner, undo_ops_inner,
    update_property_def_options_inner,
};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_store::op::PropertyDefState;
use agaric_store::space::SpaceId;
use agaric_sync::sync_protocol::loro_sync::{ApplyOutcome, apply_remote};
use agaric_sync::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The space every bench declares its definitions in (#5841: per space).
const BENCH_SPACE: &str = "01BENCHSPACE00000000000000";
/// The device the benches write as.
const BENCH_DEVICE: &str = "property-def-bench-device";

async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Seed N property definitions via direct SQL for speed.
/// Keys are `bench_prop_000`, `bench_prop_001`, etc.
/// All are select-type with a default options array.
async fn seed_property_defs(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut keys = Vec::with_capacity(n);
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let key = format!("bench-prop-{i:06}");
        sqlx::query(
            "INSERT OR IGNORE INTO property_definitions \
             (space_id, key, value_type, options, created_at) \
             VALUES (?, ?, 'select', '[\"a\",\"b\",\"c\"]', '2026-01-01T00:00:00.000Z')",
        )
        .bind(BENCH_SPACE)
        .bind(&key)
        .execute(&mut *tx)
        .await
        .unwrap();
        keys.push(key);
    }
    tx.commit().await.unwrap();
    keys
}

// ===========================================================================
// 1. bench_create_property_def — create a unique key each iteration
// ===========================================================================

fn bench_create_property_def(c: &mut Criterion) {
    let mut group = c.benchmark_group("create_property_def");

    for existing_count in [10, 50, 100] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("create_pd_{existing_count}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

        // Seed existing definitions
        rt.block_on(seed_property_defs(&pool, existing_count));

        let mut counter = 0u64;

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{existing_count}_defs")),
            &existing_count,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    counter += 1;
                    let pool = pool.clone();
                    let materializer = &materializer;
                    async move {
                        create_property_def_inner(
                            &pool,
                            BENCH_DEVICE,
                            materializer,
                            BENCH_SPACE,
                            format!("new-key-{counter}"),
                            "text".into(),
                            None,
                        )
                        .await
                        .unwrap();
                    }
                });
            },
        );
        materializer.shutdown();
    }
    group.finish();
}

// ===========================================================================
// 2. bench_list_property_defs — list all definitions
// ===========================================================================

fn bench_list_property_defs(c: &mut Criterion) {
    let mut group = c.benchmark_group("list_property_defs");

    // Cap intentional (#1231): `count` = distinct property *definitions*,
    // which is schema-like / human-bounded — ~100 is realistic, 100K is not.
    for count in [10, 50, 100] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("list_pd_{count}")));

        // The list returns the built-ins plus our seeded keys. Measure the
        // baseline before seeding and assert against `baseline + count` rather
        // than a fixed total that silently breaks whenever the built-in set
        // changes.
        let baseline = rt
            .block_on(list_property_defs_inner(
                &pool,
                BENCH_SPACE,
                None,
                Some(200),
            ))
            .unwrap()
            .items
            .len();

        rt.block_on(seed_property_defs(&pool, count));
        let expected = baseline + count;

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{count}_defs")),
            &count,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        // Returns a `PageResponse<T>`; the bench
                        // intentionally consumes only the first page —
                        // pagination cost is constant per page and the
                        // throughput metric tracks one page worth of work.
                        let page = list_property_defs_inner(&pool, BENCH_SPACE, None, Some(200))
                            .await
                            .unwrap();
                        assert_eq!(
                            page.items.len(),
                            expected,
                            "expected {expected} property definitions \
                             (baseline {baseline} + {count} seeded)"
                        );
                    }
                });
            },
        );
    }
    group.finish();
}

// ===========================================================================
// 3. bench_update_property_def_options — update options on one select-type def
// ===========================================================================

fn bench_update_property_def_options(c: &mut Criterion) {
    let mut group = c.benchmark_group("update_property_def_options");

    // Cap intentional (#1231): `count` = distinct property *definitions*,
    // which is schema-like / human-bounded — ~100 is realistic, 100K is not.
    for count in [10, 50, 100] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("upd_pd_{count}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

        let keys = rt.block_on(seed_property_defs(&pool, count));
        let target_key = keys[count / 2].clone();

        let mut counter = 0u64;

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{count}_defs")),
            &count,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    counter += 1;
                    let pool = pool.clone();
                    let target_key = target_key.clone();
                    let materializer = &materializer;
                    async move {
                        update_property_def_options_inner(
                            &pool,
                            BENCH_DEVICE,
                            materializer,
                            BENCH_SPACE,
                            target_key,
                            format!("[\"opt_{counter}\",\"x\",\"y\"]"),
                        )
                        .await
                        .unwrap();
                    }
                });
            },
        );
        materializer.shutdown();
    }
    group.finish();
}

// ===========================================================================
// 4. bench_delete_property_def — delete one def per iteration
//    Uses iter_custom to re-insert between iterations.
// ===========================================================================

fn bench_delete_property_def(c: &mut Criterion) {
    let mut group = c.benchmark_group("delete_property_def");

    // Cap intentional (#1231): `count` = distinct property *definitions*,
    // which is schema-like / human-bounded — ~100 is realistic, 100K is not.
    for count in [10, 50, 100] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("del_pd_{count}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });

        rt.block_on(seed_property_defs(&pool, count));

        let target_key = "deletable-key".to_string();

        // Seed the deletable key
        rt.block_on(async {
            sqlx::query(
                "INSERT OR IGNORE INTO property_definitions \
                 (space_id, key, value_type, options, created_at) \
                 VALUES (?, ?, 'text', NULL, '2026-01-01T00:00:00.000Z')",
            )
            .bind(BENCH_SPACE)
            .bind(&target_key)
            .execute(&pool)
            .await
            .unwrap();
        });

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{count}_defs")),
            &count,
            |b, _| {
                b.to_async(&rt).iter_custom(|iters| {
                    let pool = pool.clone();
                    let target_key = target_key.clone();
                    let materializer = &materializer;
                    async move {
                        let start = std::time::Instant::now();
                        for _ in 0..iters {
                            // Re-insert so there is something to delete
                            sqlx::query(
                                "INSERT OR IGNORE INTO property_definitions \
                                 (space_id, key, value_type, options, created_at) \
                                 VALUES (?, ?, 'text', NULL, '2026-01-01T00:00:00.000Z')",
                            )
                            .bind(BENCH_SPACE)
                            .bind(&target_key)
                            .execute(&pool)
                            .await
                            .unwrap();

                            delete_property_def_inner(
                                &pool,
                                BENCH_DEVICE,
                                materializer,
                                BENCH_SPACE,
                                target_key.clone(),
                            )
                            .await
                            .unwrap();
                        }
                        start.elapsed()
                    }
                });
            },
        );
        materializer.shutdown();
    }
    group.finish();
}

// ===========================================================================
// 5 / 6. Declaring a type over held values (#5841)
// ===========================================================================

/// How many values the space holds under [`RETYPE_KEY`].
const RETYPE_SIZES: [usize; 2] = [10_000, 100_000];
const RETYPE_SPACE: &str = "01BRTSPACE0000000000000000";
const RETYPE_KEY: &str = "due2";
const RETYPE_VALUE: &str = "2026-11-03";
/// Blocks a page holds: siblings place themselves among each other, so one
/// page of 100K blocks would build quadratically.
const RETYPE_PAGE_BLOCKS: usize = 1_000;
/// The peer whose declaration bench 6 imports.
const PEER_DEVICE: &str = "property-def-bench-peer";

fn page_id(p: usize) -> String {
    format!("01BRP{p:07}00000000000000")
}

/// Holder `i`, the `i % RETYPE_PAGE_BLOCKS`-th block of page
/// `i / RETYPE_PAGE_BLOCKS`.
fn holder_id(i: usize) -> String {
    format!("01BRT{i:07}00000000000000")
}

/// The space's doc: `n` blocks over pages of [`RETYPE_PAGE_BLOCKS`], each
/// holding [`RETYPE_VALUE`] under [`RETYPE_KEY`], as a string, the way the
/// engine holds a date.
fn holders_engine(device: &str, n: usize) -> LoroEngine {
    let mut engine = LoroEngine::with_peer_id(device).expect("engine");
    for p in 0..n.div_ceil(RETYPE_PAGE_BLOCKS) {
        let page = page_id(p);
        engine
            .apply_create_block(&page, "page", "Retype", None, p as i64)
            .expect("page");
        for i in p * RETYPE_PAGE_BLOCKS..((p + 1) * RETYPE_PAGE_BLOCKS).min(n) {
            let id = holder_id(i);
            engine
                .apply_create_block(&id, "content", "x", Some(&page), i as i64)
                .expect("block");
            engine
                .apply_set_property(&id, RETYPE_KEY, Some(RETYPE_VALUE))
                .expect("value");
        }
    }
    engine
}

/// The space's rows: the doc's blocks, each value in `column`.
async fn seed_holders(pool: &SqlitePool, n: usize, column: &str) {
    for sql in [
        "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?1, 'page', 'Retype', ?1)",
        "INSERT OR IGNORE INTO spaces (id) VALUES (?1)",
    ] {
        sqlx::query(sql)
            .bind(RETYPE_SPACE)
            .execute(pool)
            .await
            .unwrap();
    }
    let mut tx = pool.begin().await.unwrap();
    for p in 0..n.div_ceil(RETYPE_PAGE_BLOCKS) {
        let page = page_id(p);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, page_id, space_id) \
             VALUES (?1, 'page', 'Retype', ?2, ?1, ?3)",
        )
        .bind(&page)
        .bind(p as i64 + 1)
        .bind(RETYPE_SPACE)
        .execute(&mut *tx)
        .await
        .unwrap();
        const CHUNK: usize = 250;
        let first = p * RETYPE_PAGE_BLOCKS;
        let last = ((p + 1) * RETYPE_PAGE_BLOCKS).min(n);
        for start in (first..last).step_by(CHUNK) {
            let rows = start..(start + CHUNK).min(last);
            let blocks = format!(
                "INSERT INTO blocks \
                 (id, block_type, content, parent_id, position, page_id, space_id) VALUES {}",
                vec!["(?, 'content', 'x', ?, ?, ?, ?)"; rows.len()].join(", ")
            );
            let values = format!(
                "INSERT INTO block_properties (block_id, key, {column}) VALUES {}",
                vec!["(?, ?, ?)"; rows.len()].join(", ")
            );
            let mut q = sqlx::query(sqlx::AssertSqlSafe(blocks.as_str()));
            let mut v = sqlx::query(sqlx::AssertSqlSafe(values.as_str()));
            for i in rows {
                q = q
                    .bind(holder_id(i))
                    .bind(&page)
                    .bind((i - first) as i64 + 1)
                    .bind(&page)
                    .bind(RETYPE_SPACE);
                v = v.bind(holder_id(i)).bind(RETYPE_KEY).bind(RETYPE_VALUE);
            }
            q.execute(&mut *tx).await.unwrap();
            v.execute(&mut *tx).await.unwrap();
        }
    }
    tx.commit().await.unwrap();
}

async fn values_in(pool: &SqlitePool, column: &str) -> i64 {
    let sql =
        format!("SELECT COUNT(*) FROM block_properties WHERE key = ? AND {column} IS NOT NULL");
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(RETYPE_KEY)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn date_def() -> PropertyDefState {
    PropertyDefState {
        value_type: "date".into(),
        options: None,
    }
}

async fn declare_date(pool: &SqlitePool, materializer: &Materializer) {
    create_property_def_inner(
        pool,
        BENCH_DEVICE,
        materializer,
        RETYPE_SPACE,
        RETYPE_KEY.into(),
        "date".into(),
        None,
    )
    .await
    .unwrap();
}

/// Take the declaration back out of the row and the doc, untimed, so the next
/// iteration declares over undeclared values again.
async fn undeclare(pool: &SqlitePool, registry: &LoroEngineRegistry) {
    sqlx::query("DELETE FROM property_definitions WHERE space_id = ? AND key = ?")
        .bind(RETYPE_SPACE)
        .bind(RETYPE_KEY)
        .execute(pool)
        .await
        .unwrap();
    registry
        .for_space(&SpaceId::from_trusted(RETYPE_SPACE), BENCH_DEVICE)
        .unwrap()
        .engine_mut()
        .apply_set_property_def(RETYPE_KEY, None)
        .unwrap();
}

fn bench_create_property_def_over_held_values(c: &mut Criterion) {
    let mut group = c.benchmark_group("create_property_def_over_held_values");
    group.sample_size(10);
    for n in RETYPE_SIZES {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("retype_create_{n}")));
        // Held in `value_date`, as an undeclared key's date writes leave them,
        // so the declaration is not refused over them.
        rt.block_on(seed_holders(&pool, n, "value_date"));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let registry = &materializer.loro_state().registry;
        registry.install_engine(
            SpaceId::from_trusted(RETYPE_SPACE),
            holders_engine(BENCH_DEVICE, n),
        );

        // Shape probe: the doc holds the `n` values the declaration re-types,
        // and the rewrite keeps every one.
        rt.block_on(async {
            let held = registry
                .for_space(&SpaceId::from_trusted(RETYPE_SPACE), BENCH_DEVICE)
                .unwrap()
                .engine_mut()
                .read_property_holders(RETYPE_KEY)
                .unwrap()
                .len();
            assert_eq!(held, n, "the doc holds the values to re-type");
            declare_date(&pool, &materializer).await;
            assert_eq!(
                values_in(&pool, "value_date").await,
                n as i64,
                "every value is rewritten into value_date"
            );
            let payload: i64 = sqlx::query_scalar(
                "SELECT length(payload) FROM op_log WHERE op_type = 'set_property_def'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            println!("property_def_bench: set_property_def op log payload = {payload} bytes");
            materializer.flush_background().await.unwrap();
            undeclare(&pool, registry).await;
        });

        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {
            b.iter_custom(|iters| {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    let start = Instant::now();
                    rt.block_on(declare_date(&pool, &materializer));
                    total += start.elapsed();
                    rt.block_on(async {
                        materializer.flush_background().await.unwrap();
                        undeclare(&pool, registry).await;
                    });
                }
                total
            });
        });
        materializer.shutdown();
    }
    group.finish();
}

/// B imports the peer's update of the space: a declaration of [`RETYPE_KEY`]
/// as a date, or its rename.
async fn import_declaration(
    pool: &SqlitePool,
    registry: &LoroEngineRegistry,
    from_vv: &[u8],
    bytes: &[u8],
) {
    let outcome = apply_remote(
        pool,
        registry,
        BENCH_DEVICE,
        LoroSyncMessage::Update {
            protocol_version: LORO_SYNC_PROTOCOL_VERSION,
            space_id: SpaceId::from_trusted(RETYPE_SPACE),
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

/// Put B back as it was before the import, untimed: its values in
/// `value_text`, no row, and its doc without the declaration.
async fn unimport(pool: &SqlitePool, registry: &LoroEngineRegistry, b: &LoroEngine) {
    sqlx::query(
        "UPDATE block_properties SET value_text = COALESCE(value_date, value_text), \
         value_date = NULL WHERE key = ?",
    )
    .bind(RETYPE_KEY)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM property_definitions WHERE space_id = ?")
        .bind(RETYPE_SPACE)
        .execute(pool)
        .await
        .unwrap();
    registry.install_engine(
        SpaceId::from_trusted(RETYPE_SPACE),
        b.fork_staging().unwrap(),
    );
}

fn bench_import_property_def_change(c: &mut Criterion) {
    let mut group = c.benchmark_group("import_property_def_change");
    group.sample_size(10);
    for n in RETYPE_SIZES {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("retype_import_{n}")));
        // Undeclared on B, so its values were projected as text.
        rt.block_on(seed_holders(&pool, n, "value_text"));
        let mut peer = holders_engine(PEER_DEVICE, n);
        let mut b = LoroEngine::with_peer_id(BENCH_DEVICE).unwrap();
        b.import(&peer.export_snapshot().unwrap()).unwrap();
        let from_vv = b.version_vector();
        peer.apply_set_property_def(RETYPE_KEY, Some(&date_def()))
            .unwrap();
        let update = peer.export_update_since(&from_vv).unwrap();
        println!(
            "property_def_bench: the declaration's Loro update = {} bytes",
            update.len()
        );
        let registry = LoroEngineRegistry::new();

        // Shape probe: the import re-types every value of B's.
        rt.block_on(async {
            unimport(&pool, &registry, &b).await;
            import_declaration(&pool, &registry, &from_vv, &update).await;
            assert_eq!(
                values_in(&pool, "value_date").await,
                n as i64,
                "B's values end in value_date"
            );
            unimport(&pool, &registry, &b).await;
            assert_eq!(values_in(&pool, "value_text").await, n as i64, "restored");
        });

        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |bencher, _| {
            bencher.iter_custom(|iters| {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    let start = Instant::now();
                    rt.block_on(import_declaration(&pool, &registry, &from_vv, &update));
                    total += start.elapsed();
                    rt.block_on(unimport(&pool, &registry, &b));
                }
                total
            });
        });
    }
    group.finish();
}

// ===========================================================================
// 7 / 8 / 9. Renaming and merging a key (#5841)
// ===========================================================================

/// The key [`RETYPE_KEY`] is renamed or merged into.
const TARGET_KEY: &str = "area";

async fn declare_text(pool: &SqlitePool, materializer: &Materializer, key: &str) {
    create_property_def_inner(
        pool,
        BENCH_DEVICE,
        materializer,
        RETYPE_SPACE,
        key.into(),
        "text".into(),
        None,
    )
    .await
    .unwrap();
}

async fn rename(pool: &SqlitePool, materializer: &Materializer, from: &str, to: &str) {
    rename_property_key_inner(
        pool,
        BENCH_DEVICE,
        materializer,
        RETYPE_SPACE,
        from.into(),
        to.into(),
    )
    .await
    .unwrap();
}

async fn rows_under(pool: &SqlitePool, key: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM block_properties WHERE key = ?")
        .bind(key)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The newest `op_type` op's payload length, and the Loro update the space's
/// doc grew by since `vv`.
async fn print_op_cost(pool: &SqlitePool, registry: &LoroEngineRegistry, op_type: &str, vv: &[u8]) {
    let payload: i64 = sqlx::query_scalar(
        "SELECT length(payload) FROM op_log WHERE op_type = ? ORDER BY seq DESC LIMIT 1",
    )
    .bind(op_type)
    .fetch_one(pool)
    .await
    .unwrap();
    let update = registry
        .for_space(&SpaceId::from_trusted(RETYPE_SPACE), BENCH_DEVICE)
        .unwrap()
        .engine_mut()
        .export_update_since(vv)
        .unwrap()
        .len();
    println!(
        "property_def_bench: {op_type} op log payload = {payload} bytes, Loro update = {update} bytes"
    );
}

fn doc_vv(registry: &LoroEngineRegistry) -> Vec<u8> {
    registry
        .for_space(&SpaceId::from_trusted(RETYPE_SPACE), BENCH_DEVICE)
        .unwrap()
        .engine_mut()
        .version_vector()
}

fn bench_rename_property_key(c: &mut Criterion) {
    let mut group = c.benchmark_group("rename_property_key");
    group.sample_size(10);
    for n in RETYPE_SIZES {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("rename_{n}")));
        rt.block_on(seed_holders(&pool, n, "value_text"));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let registry = &materializer.loro_state().registry;
        registry.install_engine(
            SpaceId::from_trusted(RETYPE_SPACE),
            holders_engine(BENCH_DEVICE, n),
        );
        rt.block_on(declare_text(&pool, &materializer, RETYPE_KEY));

        // Shape probe: the rename moves all `n` rows, and the rename back
        // returns them.
        rt.block_on(async {
            let vv = doc_vv(registry);
            rename(&pool, &materializer, RETYPE_KEY, TARGET_KEY).await;
            assert_eq!(
                rows_under(&pool, TARGET_KEY).await,
                n as i64,
                "every row moved"
            );
            print_op_cost(&pool, registry, "rename_property_key", &vv).await;
            rename(&pool, &materializer, TARGET_KEY, RETYPE_KEY).await;
            assert_eq!(rows_under(&pool, RETYPE_KEY).await, n as i64, "and back");
            materializer.flush_background().await.unwrap();
        });

        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, _| {
            b.iter_custom(|iters| {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    let start = Instant::now();
                    rt.block_on(rename(&pool, &materializer, RETYPE_KEY, TARGET_KEY));
                    total += start.elapsed();
                    rt.block_on(async {
                        rename(&pool, &materializer, TARGET_KEY, RETYPE_KEY).await;
                        materializer.flush_background().await.unwrap();
                    });
                }
                total
            });
        });
        materializer.shutdown();
    }
    group.finish();
}

/// Every even holder also holds [`TARGET_KEY`], in its row and in `engine`.
async fn hold_target_on_even_holders(pool: &SqlitePool, engine: &mut LoroEngine, n: usize) {
    for i in (0..n).step_by(2) {
        engine
            .apply_set_property(&holder_id(i), TARGET_KEY, Some("kept"))
            .unwrap();
    }
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) \
         SELECT block_id, ?, 'kept' FROM block_properties \
         WHERE key = ? AND CAST(substr(block_id, 6, 7) AS INTEGER) % 2 = 0",
    )
    .bind(TARGET_KEY)
    .bind(RETYPE_KEY)
    .execute(pool)
    .await
    .unwrap();
}

/// Merge [`RETYPE_KEY`] into [`TARGET_KEY`]; the merge's op refs.
async fn merge(
    pool: &SqlitePool,
    materializer: &Materializer,
    n: usize,
) -> Vec<agaric_store::op::OpRef> {
    let acknowledged = PropertyMergeCounts {
        moved: (n / 2) as i64,
        dropped: n.div_ceil(2) as i64,
    };
    capture_op_refs(merge_property_key_inner(
        pool,
        BENCH_DEVICE,
        materializer,
        RETYPE_SPACE,
        RETYPE_KEY.into(),
        TARGET_KEY.into(),
        acknowledged,
    ))
    .await
    .unwrap()
    .op_refs
}

async fn undo(pool: &SqlitePool, materializer: &Materializer, ops: Vec<agaric_store::op::OpRef>) {
    undo_ops_inner(pool, BENCH_DEVICE, materializer, ops)
        .await
        .unwrap();
    materializer.flush_background().await.unwrap();
}

fn bench_merge_property_key(c: &mut Criterion) {
    let mut group = c.benchmark_group("merge_property_key");
    group.sample_size(10);
    for n in RETYPE_SIZES {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("merge_{n}")));
        rt.block_on(seed_holders(&pool, n, "value_text"));
        let mut engine = holders_engine(BENCH_DEVICE, n);
        rt.block_on(hold_target_on_even_holders(&pool, &mut engine, n));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let registry = &materializer.loro_state().registry;
        registry.install_engine(SpaceId::from_trusted(RETYPE_SPACE), engine);
        rt.block_on(async {
            declare_text(&pool, &materializer, RETYPE_KEY).await;
            declare_text(&pool, &materializer, TARGET_KEY).await;
        });

        // Shape probe: every row ends under the target, half of them moved,
        // and the undo puts the merged key's rows back.
        rt.block_on(async {
            let vv = doc_vv(registry);
            let ops = merge(&pool, &materializer, n).await;
            assert_eq!(
                rows_under(&pool, TARGET_KEY).await,
                n as i64,
                "one row a block"
            );
            assert_eq!(rows_under(&pool, RETYPE_KEY).await, 0, "none left behind");
            print_op_cost(&pool, registry, "rewrite_properties", &vv).await;
            undo(&pool, &materializer, ops).await;
            assert_eq!(rows_under(&pool, RETYPE_KEY).await, n as i64, "undone");
        });

        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |b, &n| {
            b.iter_custom(|iters| {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    let start = Instant::now();
                    let ops = rt.block_on(merge(&pool, &materializer, n));
                    total += start.elapsed();
                    rt.block_on(undo(&pool, &materializer, ops));
                }
                total
            });
        });
        materializer.shutdown();
    }
    group.finish();
}

/// Put B back as it was before the rename, untimed: its rows and definition
/// under [`RETYPE_KEY`], and its doc without the rename.
async fn unrename(pool: &SqlitePool, registry: &LoroEngineRegistry, b: &LoroEngine) {
    for sql in [
        "UPDATE block_properties SET key = ?2 WHERE key = ?1",
        "UPDATE property_definitions SET key = ?2 WHERE key = ?1",
    ] {
        sqlx::query(sql)
            .bind(TARGET_KEY)
            .bind(RETYPE_KEY)
            .execute(pool)
            .await
            .unwrap();
    }
    registry.install_engine(
        SpaceId::from_trusted(RETYPE_SPACE),
        b.fork_staging().unwrap(),
    );
}

fn bench_import_rename_property_key(c: &mut Criterion) {
    let mut group = c.benchmark_group("import_rename_property_key");
    group.sample_size(10);
    for n in RETYPE_SIZES {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("rename_import_{n}")));
        rt.block_on(async {
            seed_holders(&pool, n, "value_text").await;
            sqlx::query(
                "INSERT INTO property_definitions (space_id, key, value_type, created_at) \
                 VALUES (?, ?, 'text', '2026-01-01T00:00:00.000Z')",
            )
            .bind(RETYPE_SPACE)
            .bind(RETYPE_KEY)
            .execute(&pool)
            .await
            .unwrap();
        });
        let text = PropertyDefState {
            value_type: "text".into(),
            options: None,
        };
        let mut peer = holders_engine(PEER_DEVICE, n);
        peer.apply_set_property_def(RETYPE_KEY, Some(&text))
            .unwrap();
        let mut b = LoroEngine::with_peer_id(BENCH_DEVICE).unwrap();
        b.import(&peer.export_snapshot().unwrap()).unwrap();
        let from_vv = b.version_vector();
        peer.apply_rename_property_key(RETYPE_KEY, TARGET_KEY)
            .unwrap();
        let update = peer.export_update_since(&from_vv).unwrap();
        println!(
            "property_def_bench: the rename's Loro update = {} bytes",
            update.len()
        );
        let registry = LoroEngineRegistry::new();

        // Shape probe: the import moves every row of B's.
        rt.block_on(async {
            unrename(&pool, &registry, &b).await;
            import_declaration(&pool, &registry, &from_vv, &update).await;
            assert_eq!(
                rows_under(&pool, TARGET_KEY).await,
                n as i64,
                "B's rows moved"
            );
            assert_eq!(rows_under(&pool, RETYPE_KEY).await, 0, "none left behind");
            unrename(&pool, &registry, &b).await;
        });

        group.bench_with_input(BenchmarkId::from_parameter(n), &n, |bencher, _| {
            bencher.iter_custom(|iters| {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    let start = Instant::now();
                    rt.block_on(import_declaration(&pool, &registry, &from_vv, &update));
                    total += start.elapsed();
                    rt.block_on(unrename(&pool, &registry, &b));
                }
                total
            });
        });
    }
    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(
    property_def_benches,
    bench_create_property_def,
    bench_list_property_defs,
    bench_update_property_def_options,
    bench_delete_property_def,
    bench_create_property_def_over_held_values,
    bench_import_property_def_change,
    bench_rename_property_key,
    bench_merge_property_key,
    bench_import_rename_property_key,
);
