// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::db::init_pool;
use agaric_lib::op::*;
use agaric_lib::op_log::append_local_op;
use agaric_lib::ulid::BlockId;

use tempfile::TempDir;
use tokio::runtime::Runtime;

/// Pre-populate an op log with `count` CreateBlock ops via raw SQL (fast,
/// bypasses normal payload construction).
async fn seed_op_log(pool: &sqlx::SqlitePool, count: usize) {
    for i in 0..count {
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, op_type, payload, hash)
             VALUES ('seed', ?1, 'create_block',
                     json_object('block_id', printf('SEED%04d', ?1),
                                 'block_type', 'content',
                                 'parent_id', NULL,
                                 'position', ?1,
                                 'content', 'seed'),
                     hex(randomblob(32)))",
        )
        .bind(i as i64)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Benchmark: append a single CreateBlock op (incremental seq numbers).
fn bench_append_single_op(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("bench_single.db");
    let pool = rt.block_on(init_pool(&db_path)).unwrap();

    c.bench_function("append_local_op_single", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                let payload = OpPayload::CreateBlock(CreateBlockPayload {
                    block_id: BlockId::from_trusted("BLK001"),
                    block_type: "content".into(),
                    parent_id: None,
                    position: Some(0),
                    content: "hello world".into(),
                });
                append_local_op(&pool, "dev-bench", payload).await.unwrap();
            }
        })
    });
}

/// Benchmark: append 100 ops in sequence (measures sustained write throughput).
fn bench_append_batch_100(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("bench_batch.db");
    let pool = rt.block_on(init_pool(&db_path)).unwrap();

    let mut group = c.benchmark_group("append_local_op_batch");
    group.throughput(Throughput::Elements(100));
    group.bench_function("100", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                for i in 0..100 {
                    let payload = OpPayload::CreateBlock(CreateBlockPayload {
                        block_id: BlockId::from_trusted(&format!("BLK{i:04}")),
                        block_type: "content".into(),
                        parent_id: None,
                        position: Some(i),
                        content: format!("content {i}"),
                    });
                    append_local_op(&pool, "dev-batch", payload).await.unwrap();
                }
            }
        })
    });
    group.finish();
}

/// Benchmark: append ops with varying payload content sizes (10 B → 10 KB).
fn bench_append_varying_payload_size(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let mut group = c.benchmark_group("append_payload_size");
    for size in [10, 100, 1_000, 10_000] {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("bench_size.db");
        let pool = rt.block_on(init_pool(&db_path)).unwrap();

        let content: String = "x".repeat(size);

        group.bench_with_input(BenchmarkId::new("bytes", size), &content, |b, content| {
            b.to_async(&rt).iter(|| {
                let pool = pool.clone();
                let content = content.clone();
                async move {
                    let payload = OpPayload::CreateBlock(CreateBlockPayload {
                        block_id: BlockId::from_trusted("BLK001"),
                        block_type: "content".into(),
                        parent_id: None,
                        position: Some(0),
                        content,
                    });
                    append_local_op(&pool, "dev-size", payload).await.unwrap();
                }
            })
        });
    }
    group.finish();
}

/// Benchmark: append latency with a pre-populated op log (1k / 10k / 100k ops).
fn bench_append_to_populated(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();

    let mut group = c.benchmark_group("append_to_populated");
    for pre_existing in [1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("bench_pop.db");
        let pool = rt.block_on(init_pool(&db_path)).unwrap();

        rt.block_on(seed_op_log(&pool, pre_existing));

        group.bench_with_input(
            BenchmarkId::new("ops", pre_existing),
            &pre_existing,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    async move {
                        let payload = OpPayload::CreateBlock(CreateBlockPayload {
                            block_id: BlockId::from_trusted("BLK_NEW"),
                            block_type: "content".into(),
                            parent_id: None,
                            position: Some(0),
                            content: "new op".into(),
                        });
                        append_local_op(&pool, "dev-pop", payload).await.unwrap();
                    }
                })
            },
        );
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_append_single_op,
    bench_append_batch_100,
    bench_append_varying_payload_size,
    bench_append_to_populated,
);
criterion_main!(benches);
