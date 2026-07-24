// Bench helpers cast small loop indices between usize/i64/u64 freely.
#![allow(clippy::cast_possible_wrap, clippy::cast_possible_truncation)]

//! Criterion benchmarks for snapshot creation and application:
//!   1. `create_snapshot`  — snapshot creation at varying DB sizes (10, 100, 1000 blocks)
//!   2. `apply_snapshot`   — snapshot application to a fresh DB at varying sizes

use std::hint::black_box;

use criterion::{BatchSize, BenchmarkId, Criterion, Throughput, criterion_group};

use agaric_core::ulid::BlockId;
use agaric_lib::commands::create_block_inner;
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_sync::snapshot::{
    BlockPropertySnapshot, BlockSnapshot, SnapshotData, SnapshotTables, apply_snapshot,
    create_snapshot, decode_snapshot, encode_snapshot, get_latest_snapshot,
};

use std::collections::BTreeMap;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEV_BENCH: &str = "dev-bench";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Seed `n` content blocks via `create_block_inner` (populates both `blocks`
/// and `op_log` tables for realistic DB state).
async fn seed_blocks(pool: &SqlitePool, materializer: &Materializer, n: usize) {
    for i in 0..n {
        create_block_inner(
            pool,
            DEV_BENCH,
            materializer,
            "content".into(),
            format!(
                "Seeded block number {i} with some placeholder content for snapshot benchmarks."
            ),
            None,
            Some(i as i64 + 1),
        )
        .await
        .unwrap();
    }
}

// ===========================================================================
// Benchmark 1: Snapshot creation at varying DB sizes
// ===========================================================================

/// Benchmark `create_snapshot` with N blocks in the DB (10, 100, 1000).
///
/// Pre-populates the database via `create_block_inner` so both `blocks` and
/// `op_log` tables contain realistic data.  Uses `Throughput::Elements(N)`
/// so Criterion reports blocks/sec.
fn bench_create_snapshot(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("create_snapshot");

    for n in [10u64, 100, 1000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("snap_create_{n}")));
        let materializer = Materializer::new(pool.clone());

        // Seed the DB with n blocks
        rt.block_on(seed_blocks(&pool, &materializer, n as usize));

        group.throughput(Throughput::Elements(n));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_blocks")),
            &n,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        create_snapshot(&pool, DEV_BENCH).await.unwrap();
                    }
                });
            },
        );

        // Shut down the background materializer before the next iteration
        // so its task doesn't outlive this benchmark.
        rt.block_on(async { materializer.shutdown() });
    }

    group.finish();
}

// ===========================================================================
// Benchmark 2: Snapshot application at varying sizes
// ===========================================================================

/// Benchmark `apply_snapshot` with snapshots captured from databases of
/// N blocks (10, 100, 1000).
///
/// For each size, a snapshot is created from a populated database, then the
/// benchmark applies that snapshot repeatedly.  `apply_snapshot` wipes all
/// core tables before inserting, so each iteration starts from a clean slate.
fn bench_apply_snapshot(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("apply_snapshot");

    for n in [10u64, 100, 1000] {
        let dir = TempDir::new().unwrap();

        // Create and populate a source DB, then capture a snapshot
        let source_pool = rt.block_on(fresh_pool(&dir, &format!("snap_src_{n}")));
        let materializer = Materializer::new(source_pool.clone());
        rt.block_on(seed_blocks(&source_pool, &materializer, n as usize));
        rt.block_on(create_snapshot(&source_pool, DEV_BENCH))
            .unwrap();

        // Retrieve the compressed snapshot data
        let (_snap_id, compressed) = rt
            .block_on(get_latest_snapshot(&source_pool))
            .unwrap()
            .expect("snapshot should exist after create_snapshot");

        // Target pool for applying the snapshot
        let target_pool = rt.block_on(fresh_pool(&dir, &format!("snap_tgt_{n}")));
        let target_mat = Materializer::new(target_pool.clone());

        group.throughput(Throughput::Elements(n));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_blocks")),
            &n,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = target_pool.clone();
                    let mat = target_mat.clone();
                    let data = compressed.clone();
                    async move {
                        apply_snapshot(&pool, &mat, &data[..]).await.unwrap();
                    }
                });
            },
        );

        // Shut down both materializers so their background tasks don't
        // outlive this benchmark iteration.
        rt.block_on(async {
            materializer.shutdown();
            target_mat.shutdown();
        });
    }

    group.finish();
}

// ===========================================================================
// Benchmark 3: codec encode/decode at vault scale (#416)
// ===========================================================================

/// Build a synthetic `SnapshotData` with `n` page-sized blocks plus one
/// `space` property per block — a cheap, DB-free stand-in for a vault of
/// `n` blocks so the codec can be exercised at 100k scale without paying
/// the per-block `create_block_inner` materialiser cost.
fn synthetic_snapshot(n: usize) -> SnapshotData {
    let mut blocks = Vec::with_capacity(n);
    let mut block_properties = Vec::with_capacity(n);
    // Space membership is column-backed since #533 (`blocks.space_id`); seed one
    // shared space so the codec measures the populated column. A generic
    // (non-reserved) property row per block keeps `block_properties`
    // serialization in the measured workload — reserved keys (#534) can no
    // longer live in that table.
    let space_id = BlockId::new();
    for i in 0..n {
        let id = BlockId::new();
        block_properties.push(BlockPropertySnapshot {
            block_id: id.clone(),
            key: "effort".to_string(),
            value_text: Some("medium".to_string()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        });
        blocks.push(BlockSnapshot {
            id,
            block_type: "content".to_string(),
            content: Some(format!(
                "Seeded block number {i} with some placeholder content for snapshot benchmarks."
            )),
            parent_id: None,
            position: Some(i as i64 + 1),
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            space_id: Some(space_id.clone()),
        });
    }
    SnapshotData {
        // SCHEMA_VERSION / MIN_SCHEMA_VERSION are crate-private; decode now
        // accepts only MIN_SCHEMA_VERSION..=SCHEMA_VERSION (currently 4..=6),
        // so this must be a version in that window. The value does not affect
        // encode/decode cost. Keep in sync if MIN_SCHEMA_VERSION advances.
        schema_version: 6,
        snapshot_device_id: "dev-bench".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: String::new(),
        tables: SnapshotTables {
            blocks,
            block_tags: Vec::new(),
            block_properties,
            block_links: Vec::new(),
            attachments: Vec::new(),
            property_definitions: Vec::new(),
            page_aliases: Vec::new(),
        },
    }
}

/// Benchmark `encode_snapshot` (the create-side codec, #416) and
/// `decode_snapshot` (the restore-side streaming codec) at 1k / 10k /
/// 100k blocks. The setup also prints the compressed payload size at
/// each size so the create-path memory budget can be reasoned about
/// from measured numbers rather than an estimate — gating the deferred
/// row-batched streaming *format* (a wire-format change) on real data.
fn bench_codec(c: &mut Criterion) {
    let mut group = c.benchmark_group("snapshot_codec");
    // 100k is the SNAPSHOT_WARN_ROW_COUNT threshold — the regime the
    // warn! was added to flag, and the stated mobile scaling target.
    for n in [1_000usize, 10_000, 100_000] {
        let data = synthetic_snapshot(n);
        let encoded = encode_snapshot(&data).unwrap();
        eprintln!(
            "[#416 snapshot_codec] {n} blocks -> compressed payload {} bytes ({:.2} MiB)",
            encoded.len(),
            encoded.len() as f64 / (1024.0 * 1024.0),
        );

        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(
            BenchmarkId::new("encode", format!("{n}_blocks")),
            &n,
            |b, _| b.iter(|| black_box(encode_snapshot(&data).unwrap())),
        );
        group.bench_with_input(
            BenchmarkId::new("decode", format!("{n}_blocks")),
            &n,
            |b, _| b.iter(|| black_box(decode_snapshot(&encoded[..]).unwrap())),
        );
    }
    group.finish();
}

// ===========================================================================
// Benchmark 4: apply_snapshot write-lock hold time at vault scale (#2470 item 1)
// ===========================================================================

/// Build a synthetic `SnapshotData` with `n` blocks, one `block_properties`
/// row per block, and NO `space_id` — the DB-free fixture for the
/// `apply_snapshot_vault_scale` group below. Mirrors
/// `snapshot::tests::vault_scale_snapshot_2470` byte-for-byte in shape (same
/// field values, same one-property-per-block ratio) so the criterion group
/// here and the `#[ignore]`d wall-time measurement in `src/snapshot/tests.rs`
/// report numbers for the *same* workload.
///
/// Deliberately NOT `synthetic_snapshot` above, even though the shapes look
/// similar: `synthetic_snapshot` sets every block's `space_id` to a shared id
/// that is never registered as a real space (fine for `bench_codec`, which
/// only exercises serialization — no DB write ever validates it). Run
/// through `apply_snapshot` for real, that dangling `space_id` triggers
/// restore.rs's `UPDATE blocks SET space_id = NULL WHERE space_id NOT IN
/// (SELECT id FROM spaces)` repair pass (#708) on literally every row — an
/// entire extra full-table rewrite that is not representative of a real
/// vault (where at most a handful of blocks are spaces, so the repair only
/// ever touches a small dangling minority). An earlier version of this
/// benchmark used `synthetic_snapshot` here and reported vault-scale numbers
/// wildly inconsistent with the DB-driven `bench_apply_snapshot` group above
/// and with the `#[ignore]`d test's wall-clock measurement — this
/// artificial 100%-dangling repair scan was the dominant cause. Leaving
/// `space_id` unset keeps this fixture on the representative path (repair
/// UPDATE matches 0 rows), matching how `bench_apply_snapshot`'s
/// `seed_blocks`/`create_block_inner`-built snapshots behave (no space
/// membership either).
fn vault_scale_snapshot(n: usize) -> SnapshotData {
    let mut blocks = Vec::with_capacity(n);
    let mut block_properties = Vec::with_capacity(n);
    for i in 0..n {
        let id = BlockId::new();
        block_properties.push(BlockPropertySnapshot {
            block_id: id.clone(),
            key: "effort".to_string(),
            value_text: Some("medium".to_string()),
            value_num: None,
            value_date: None,
            value_ref: None,
            value_bool: None,
        });
        blocks.push(BlockSnapshot {
            id,
            block_type: "content".to_string(),
            content: Some(format!(
                "Seeded block number {i} with some placeholder content for snapshot benchmarks."
            )),
            parent_id: None,
            position: Some(i as i64 + 1),
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            space_id: None,
        });
    }
    SnapshotData {
        schema_version: 6,
        snapshot_device_id: "dev-bench".to_string(),
        up_to_seqs: BTreeMap::new(),
        up_to_hash: String::new(),
        tables: SnapshotTables {
            blocks,
            block_tags: Vec::new(),
            block_properties,
            block_links: Vec::new(),
            attachments: Vec::new(),
            property_definitions: Vec::new(),
            page_aliases: Vec::new(),
        },
    }
}

/// Benchmark `apply_snapshot` restoring a pre-built snapshot into a pool at
/// vault scale — 1k / 10k / 100k blocks. Mirrors `bench_codec`'s sizes but
/// uses the dedicated `vault_scale_snapshot` fixture above (rather than
/// `bench_apply_snapshot` above, which seeds through `create_block_inner` —
/// fine at 10/100/1000 but far too slow to use for building a 100k-block
/// *source* DB here; only the *target* side is timed, so the source data is
/// synthesized directly).
///
/// Setup (untimed, per iteration): fresh pool + materializer in a fresh
/// `TempDir`. Routine (timed): `apply_snapshot` restoring the pre-encoded
/// payload into that fresh pool. Uses synchronous `iter_batched` (not
/// `to_async`) for the same reason as `import_bench.rs`'s
/// `bench_import_markdown_inner`: criterion's async bencher runs `setup`
/// *inside* `rt.block_on`, and a second nested `block_on` for per-iteration
/// pool creation would panic ("Cannot start a runtime from within a
/// runtime"). `sample_size(10)` keeps the 100k case's wall time sane —
/// `compaction_bench.rs`'s `bench_compact_op_log` (also per-iteration-fresh-DB
/// and destructive) sets the same precedent.
///
/// This measures apply_snapshot's *total* wall time. `decode_snapshot` runs
/// BEFORE `begin_immediate_logged` acquires the SQLite write lock and is
/// cheap relative to the wipe+insert work at these sizes (see `bench_codec`
/// above for decode cost in isolation), so the reported time is a tight
/// proxy for the write-lock hold time. For a direct empirical measurement of
/// what a concurrent writer observes while that lock is held, see
/// `snapshot::tests::measure_apply_snapshot_write_lock_hold_2470`
/// (`src/snapshot/tests.rs`, `#[ignore = "measurement for #2470"]`).
fn bench_apply_snapshot_vault_scale(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("apply_snapshot_vault_scale");
    // 100k applies take seconds each; keep the sample count small so the
    // whole group finishes in a reasonable time (see compaction_bench.rs's
    // bench_compact_op_log for the same tradeoff at the same scale).
    group.sample_size(10);

    for n in [1_000usize, 10_000, 100_000] {
        let data = vault_scale_snapshot(n);
        let encoded = encode_snapshot(&data).unwrap();

        group.throughput(Throughput::Elements(n as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_blocks")),
            &n,
            |b, _| {
                b.iter_batched(
                    || {
                        rt.block_on(async {
                            let dir = TempDir::new().unwrap();
                            let pool = fresh_pool(&dir, "apply_vault_scale").await;
                            let mat = Materializer::new(pool.clone());
                            (dir, pool, mat)
                        })
                    },
                    |(dir, pool, mat)| {
                        let encoded = encoded.clone();
                        rt.block_on(async move {
                            apply_snapshot(&pool, &mat, &encoded[..]).await.unwrap();
                            mat.shutdown();
                            // Keep the TempDir alive until the restore above
                            // has finished touching the DB file.
                            drop(dir);
                        });
                    },
                    BatchSize::SmallInput,
                );
            },
        );
    }

    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(snapshot_create_benches, bench_create_snapshot);
criterion_group!(snapshot_apply_benches, bench_apply_snapshot);
criterion_group!(
    snapshot_apply_vault_scale_benches,
    bench_apply_snapshot_vault_scale
);
criterion_group!(snapshot_codec_benches, bench_codec);
