// Bench helpers cast small loop indices between usize/i64/u64 freely.
#![allow(clippy::cast_possible_wrap, clippy::cast_possible_truncation)]

//! Criterion benchmarks for attachment CRUD operations.
//!
//! Benches:
//!   1. `add_attachment`    — add a file attachment to a random block
//!   2. `delete_attachment` — delete an attachment (re-insert between iterations)
//!   3. `list_attachments`  — list attachments for a target block

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::commands::{add_attachment_inner, delete_attachment_inner, list_attachments_inner};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Bulk-seed N blocks via direct SQL for speed.
async fn seed_blocks_bulk(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("BNCH{i:020}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'seed')")
            .bind(&id)
            .execute(&mut *tx)
            .await
            .unwrap();
        ids.push(id);
    }
    tx.commit().await.unwrap();
    ids
}

/// Insert M attachments on a given block via direct SQL.
async fn seed_attachments_for_block(pool: &SqlitePool, block_id: &str, m: usize) {
    let mut tx = pool.begin().await.unwrap();
    for i in 0..m {
        let att_id = format!("ATT{block_id}{i:06}");
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES (?, ?, 'text/plain', 'file.txt', 1024, '/tmp/bench_file.txt', '2026-01-01T00:00:00.000Z')",
        )
        .bind(&att_id)
        .bind(block_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

// ===========================================================================
// 1. bench_add_attachment — add one attachment per iteration to a random block
// ===========================================================================

fn bench_add_attachment(c: &mut Criterion) {
    let mut group = c.benchmark_group("add_attachment");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("add_att_{size}")));
        let mat = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));

        // M-29: `add_attachment_inner` now stat-checks the file under
        // `app_data_dir`, so create the bench fixture once and reuse it
        // for every iteration. The bench measures DB-write cost, not
        // filesystem cost — a single zero-byte file is enough.
        let app_data_dir = dir.path().to_path_buf();
        let attachments_dir = app_data_dir.join("attachments");
        std::fs::create_dir_all(&attachments_dir).unwrap();
        let bench_fs_path = "attachments/bench_file.txt".to_string();
        std::fs::write(app_data_dir.join(&bench_fs_path), b"").unwrap();

        let mut counter = 0u64;

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    counter += 1;
                    let pool = pool.clone();
                    let mat_ref = &mat;
                    let block_id = ids[counter as usize % ids.len()].clone();
                    let app_data_dir = app_data_dir.clone();
                    let bench_fs_path = bench_fs_path.clone();
                    async move {
                        add_attachment_inner(
                            &pool,
                            "dev-bench",
                            mat_ref,
                            &app_data_dir,
                            block_id,
                            format!("file_{counter}.txt"),
                            "text/plain".into(),
                            0,
                            bench_fs_path,
                        )
                        .await
                        .unwrap();
                    }
                })
            },
        );

        rt.block_on(async { mat.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// 2. bench_delete_attachment — delete one attachment per iteration
//    Uses iter_custom to re-insert between iterations.
// ===========================================================================

fn bench_delete_attachment(c: &mut Criterion) {
    let mut group = c.benchmark_group("delete_attachment");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("del_att_{size}")));
        let mat = rt.block_on(async { Materializer::new(pool.clone()) });
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));

        let target_block = ids[size / 2].clone();
        let target_att_id = format!("DELATT{:020}", 0);

        // C-3b: `delete_attachment_inner` now unlinks `app_data_dir.join(fs_path)`
        // after the commit. Use a path under the bench's TempDir so the
        // unlink target is predictable; we recreate the stub file before
        // each iteration since the previous iter unlinked it.
        let app_data_dir = dir.path().to_path_buf();
        let attachments_dir = app_data_dir.join("attachments");
        std::fs::create_dir_all(&attachments_dir).unwrap();
        let bench_fs_path = "attachments/bench_file.txt".to_string();
        let bench_file_full = app_data_dir.join(&bench_fs_path);

        // Seed initial attachment row + file
        rt.block_on(async {
            sqlx::query(
                "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
                 VALUES (?, ?, 'text/plain', 'file.txt', 1024, ?, '2026-01-01T00:00:00.000Z')",
            )
            .bind(&target_att_id)
            .bind(&target_block)
            .bind(&bench_fs_path)
            .execute(&pool)
            .await
            .unwrap();
        });
        std::fs::write(&bench_file_full, b"").unwrap();

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter_custom(|iters| {
                    let pool = pool.clone();
                    let mat_ref = &mat;
                    let target_block = target_block.clone();
                    let target_att_id = target_att_id.clone();
                    let app_data_dir = app_data_dir.clone();
                    let bench_fs_path = bench_fs_path.clone();
                    let bench_file_full = bench_file_full.clone();
                    async move {
                        let start = std::time::Instant::now();
                        for _ in 0..iters {
                            // Re-insert so there is something to delete
                            sqlx::query(
                                "INSERT OR REPLACE INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
                                 VALUES (?, ?, 'text/plain', 'file.txt', 1024, ?, '2026-01-01T00:00:00.000Z')",
                            )
                            .bind(&target_att_id)
                            .bind(&target_block)
                            .bind(&bench_fs_path)
                            .execute(&pool)
                            .await
                            .unwrap();
                            // Recreate the on-disk file (previous iter unlinked it).
                            tokio::fs::write(&bench_file_full, b"").await.unwrap();

                            delete_attachment_inner(
                                &pool,
                                "dev-bench",
                                mat_ref,
                                &app_data_dir,
                                target_att_id.clone(),
                            )
                            .await
                            .unwrap();
                        }
                        start.elapsed()
                    }
                })
            },
        );

        rt.block_on(async { mat.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// 3. bench_list_attachments — list attachments for a target block
//    The target block has 10 attachments; N total blocks exist.
// ===========================================================================

fn bench_list_attachments(c: &mut Criterion) {
    let mut group = c.benchmark_group("list_attachments");

    for size in [100, 1_000, 10_000] {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("list_att_{size}")));
        let ids = rt.block_on(seed_blocks_bulk(&pool, size));

        let target_block = ids[size / 2].clone();

        // Seed 10 attachments on the target block
        rt.block_on(seed_attachments_for_block(&pool, &target_block, 10));

        group.throughput(Throughput::Elements(1));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}_blocks")),
            &size,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let target_block = target_block.clone();
                    async move {
                        let rows = list_attachments_inner(&pool, target_block).await.unwrap();
                        assert_eq!(rows.len(), 10);
                    }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(
    attachment_benches,
    bench_add_attachment,
    bench_delete_attachment,
    bench_list_attachments,
);

criterion_main!(attachment_benches);
