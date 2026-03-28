use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use block_notes_lib::db::init_pool;
use block_notes_lib::op::*;
use block_notes_lib::op_log::append_local_op;

use tempfile::TempDir;
use tokio::runtime::Runtime;

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
                    block_id: "BLK001".into(),
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

    c.bench_function("append_local_op_batch_100", |b| {
        b.to_async(&rt).iter(|| {
            let pool = pool.clone();
            async move {
                for i in 0..100 {
                    let payload = OpPayload::CreateBlock(CreateBlockPayload {
                        block_id: format!("BLK{i:04}"),
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
                        block_id: "BLK001".into(),
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

criterion_group!(
    benches,
    bench_append_single_op,
    bench_append_batch_100,
    bench_append_varying_payload_size,
);
criterion_main!(benches);
