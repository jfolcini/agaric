use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use agaric_lib::commands::purge_block_inner;
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::soft_delete::{cascade_soft_delete, restore_block};
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------

/// Create a tree of given `depth` levels and `width` children per node.
///
/// Total nodes = 1 + w + w² + … + w^(depth-1).
/// Returns the root block ID.
async fn seed_tree(pool: &sqlx::SqlitePool, depth: usize, width: usize) -> String {
    let root_id = "ROOT00000000000000000000";
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'root')")
        .bind(root_id)
        .execute(pool)
        .await
        .unwrap();

    let mut parents = vec![root_id.to_string()];
    for level in 1..depth {
        let mut next_parents = Vec::new();
        for (pi, parent) in parents.iter().enumerate() {
            for ci in 0..width {
                let id = format!("L{level:03}P{pi:04}C{ci:03}000000000");
                sqlx::query(
                    "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                     VALUES (?, 'content', 'x', ?, ?)",
                )
                .bind(&id)
                .bind(parent)
                .bind(ci as i64 + 1)
                .execute(pool)
                .await
                .unwrap();
                next_parents.push(id);
            }
        }
        parents = next_parents;
    }
    root_id.to_string()
}

const ROOT_ID: &str = "ROOT00000000000000000000";

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

fn bench_cascade_soft_delete(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("cascade_soft_delete");

    for (depth, width) in [(3, 5), (5, 3), (3, 20)] {
        group.bench_with_input(
            BenchmarkId::new(format!("d{depth}_w{width}"), depth * width),
            &(depth, width),
            |b, &(d, w)| {
                b.iter_batched(
                    || {
                        let dir = TempDir::new().unwrap();
                        let pool = rt.block_on(async {
                            let p = init_pool(&dir.path().join("b.db")).await.unwrap();
                            seed_tree(&p, d, w).await;
                            p
                        });
                        (pool, dir)
                    },
                    |(pool, _dir)| rt.block_on(cascade_soft_delete(&pool, ROOT_ID)),
                    criterion::BatchSize::SmallInput,
                );
            },
        );
    }
    group.finish();
}

fn bench_purge_block(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("purge_block");

    for (depth, width) in [(3, 5), (5, 3), (3, 20)] {
        group.bench_with_input(
            BenchmarkId::new(format!("d{depth}_w{width}"), depth * width),
            &(depth, width),
            |b, &(d, w)| {
                b.iter_batched(
                    || {
                        let dir = TempDir::new().unwrap();
                        let (pool, materializer) = rt.block_on(async {
                            let p = init_pool(&dir.path().join("b.db")).await.unwrap();
                            seed_tree(&p, d, w).await;
                            // Soft-delete first so purge exercises the full path.
                            cascade_soft_delete(&p, ROOT_ID).await.unwrap();
                            let m = Materializer::new(p.clone());
                            (p, m)
                        });
                        (pool, dir, materializer)
                    },
                    |(pool, _dir, materializer)| {
                        let _ = rt.block_on(purge_block_inner(
                            &pool,
                            "dev-bench",
                            &materializer,
                            ROOT_ID.to_string(),
                        ));
                    },
                    criterion::BatchSize::SmallInput,
                );
            },
        );
    }
    group.finish();
}

fn bench_restore_block(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("restore_block");

    for (depth, width) in [(3, 5), (5, 3), (3, 20)] {
        group.bench_with_input(
            BenchmarkId::new(format!("d{depth}_w{width}"), depth * width),
            &(depth, width),
            |b, &(d, w)| {
                b.iter_batched(
                    || {
                        let dir = TempDir::new().unwrap();
                        let (pool, ts) = rt.block_on(async {
                            let p = init_pool(&dir.path().join("b.db")).await.unwrap();
                            seed_tree(&p, d, w).await;
                            let (ts, _) = cascade_soft_delete(&p, ROOT_ID).await.unwrap();
                            (p, ts)
                        });
                        (pool, dir, ts)
                    },
                    |(pool, _dir, ts)| rt.block_on(restore_block(&pool, ROOT_ID, &ts)),
                    criterion::BatchSize::SmallInput,
                );
            },
        );
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_cascade_soft_delete,
    bench_purge_block,
    bench_restore_block
);
criterion_main!(benches);
