use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::db::init_pool;
use agaric_lib::pagination::PageRequest;
use agaric_lib::tag_inheritance::rebuild_all;
use agaric_lib::tag_query::{eval_tag_query, TagExpr};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------

/// Seed a tree of blocks under a tagged root.
/// Returns the root page ID.
async fn seed_tagged_tree(
    pool: &SqlitePool,
    tag_id: &str,
    total_blocks: usize,
    depth: usize,
) -> String {
    let mut tx = pool.begin().await.unwrap();

    // Create tag block
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'tag', ?)")
        .bind(tag_id)
        .bind("bench-tag")
        .execute(&mut *tx)
        .await
        .unwrap();

    // Create root page and tag it
    let root_id = "ROOT_PAGE_00000000000000";
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', 'Root page')")
        .bind(root_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(root_id)
        .bind(tag_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) VALUES (?, 'bench-tag', 1, '2025-01-01T00:00:00Z')")
        .bind(tag_id)
        .execute(&mut *tx)
        .await
        .unwrap();

    // Create child blocks in a tree structure.
    // Strategy: BFS-level generation. Each level distributes remaining blocks.
    let mut parent_ids = vec![root_id.to_string()];
    let mut created = 0usize;
    let blocks_to_create = total_blocks.saturating_sub(1); // root already created

    for level in 0..depth {
        if created >= blocks_to_create {
            break;
        }
        let remaining = blocks_to_create - created;
        let children_per_parent = (remaining / parent_ids.len().max(1)).max(1);
        let mut next_parents = Vec::new();

        for parent in &parent_ids {
            for j in 0..children_per_parent {
                if created >= blocks_to_create {
                    break;
                }
                let child_id = format!("BLK{created:020}");
                sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, position) VALUES (?, 'content', ?, ?, ?)")
                    .bind(&child_id)
                    .bind(format!("Block {created} at depth {}", level + 1))
                    .bind(parent)
                    .bind(j as i64 + 1)
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                next_parents.push(child_id);
                created += 1;
            }
        }
        parent_ids = next_parents;
    }

    tx.commit().await.unwrap();
    root_id.to_string()
}

// ---------------------------------------------------------------------------
// Pool helper
// ---------------------------------------------------------------------------

fn make_pool(rt: &Runtime, dir: &TempDir) -> SqlitePool {
    rt.block_on(async { init_pool(&dir.path().join("bench.db")).await.unwrap() })
}

// ---------------------------------------------------------------------------
// 1. resolve_tag_no_inheritance — baseline without CTE
// ---------------------------------------------------------------------------

fn bench_resolve_tag_no_inheritance(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("resolve_tag_no_inheritance");

    for count in [100, 1_000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        let tag_id = "TAG_BENCH_0000000000000001";
        rt.block_on(seed_tagged_tree(&pool, tag_id, count, 3));

        let expr = TagExpr::Tag(tag_id.to_string());
        let page = PageRequest::new(None, Some(50)).unwrap();

        group.throughput(Throughput::Elements(count as u64));
        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt)
                .iter(|| eval_tag_query(&pool, &expr, &page, false));
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// 2. resolve_tag_with_inheritance — recursive CTE path
// ---------------------------------------------------------------------------

fn bench_resolve_tag_with_inheritance(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("resolve_tag_with_inheritance");

    for count in [100, 1_000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        let tag_id = "TAG_BENCH_0000000000000001";
        rt.block_on(seed_tagged_tree(&pool, tag_id, count, 3));
        rt.block_on(rebuild_all(&pool)).unwrap();

        let expr = TagExpr::Tag(tag_id.to_string());
        let page = PageRequest::new(None, Some(50)).unwrap();

        group.throughput(Throughput::Elements(count as u64));
        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt)
                .iter(|| eval_tag_query(&pool, &expr, &page, true));
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// 3. inheritance_varying_depth — fixed 1000 blocks, vary tree depth
// ---------------------------------------------------------------------------

fn bench_inheritance_varying_depth(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("inheritance_varying_depth");

    for depth in [1, 5, 10, 50, 100] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        let tag_id = "TAG_BENCH_0000000000000001";
        rt.block_on(seed_tagged_tree(&pool, tag_id, 1_000, depth));
        rt.block_on(rebuild_all(&pool)).unwrap();

        let expr = TagExpr::Tag(tag_id.to_string());
        let page = PageRequest::new(None, Some(50)).unwrap();

        group.throughput(Throughput::Elements(1_000));
        group.bench_with_input(BenchmarkId::new("depth", depth), &depth, |b, _| {
            b.to_async(&rt)
                .iter(|| eval_tag_query(&pool, &expr, &page, true));
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// 4. inheritance_wide_tree — fixed depth=3, vary width (children per node)
// ---------------------------------------------------------------------------

fn bench_inheritance_wide_tree(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("inheritance_wide_tree");

    for width in [2, 10, 50, 100] {
        // Compute total blocks: 1 root + width + width^2 (depth=3)
        let total: usize = 1 + width + width * width;
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        let tag_id = "TAG_BENCH_0000000000000001";
        rt.block_on(seed_tagged_tree(&pool, tag_id, total, 3));
        rt.block_on(rebuild_all(&pool)).unwrap();

        let expr = TagExpr::Tag(tag_id.to_string());
        let page = PageRequest::new(None, Some(50)).unwrap();

        group.throughput(Throughput::Elements(total as u64));
        group.bench_with_input(BenchmarkId::new("width", width), &width, |b, _| {
            b.to_async(&rt)
                .iter(|| eval_tag_query(&pool, &expr, &page, true));
        });
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// 5. eval_tag_query_with_inheritance_paginated — full pagination, 10K blocks
// ---------------------------------------------------------------------------

fn bench_eval_tag_query_paginated(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("eval_tag_query_paginated");

    let dir = TempDir::new().unwrap();
    let pool = make_pool(&rt, &dir);
    let tag_id = "TAG_BENCH_0000000000000001";
    rt.block_on(seed_tagged_tree(&pool, tag_id, 10_000, 5));
    rt.block_on(rebuild_all(&pool)).unwrap();

    let expr = TagExpr::Tag(tag_id.to_string());
    let page = PageRequest::new(None, Some(50)).unwrap();

    group.throughput(Throughput::Elements(10_000));
    group.bench_function("10k_inherited_page50", |b| {
        b.to_async(&rt)
            .iter(|| eval_tag_query(&pool, &expr, &page, true));
    });

    group.finish();
}

// ---------------------------------------------------------------------------
// Criterion harness
// ---------------------------------------------------------------------------

criterion_group!(
    benches,
    bench_resolve_tag_no_inheritance,
    bench_resolve_tag_with_inheritance,
    bench_inheritance_varying_depth,
    bench_inheritance_wide_tree,
    bench_eval_tag_query_paginated,
);
criterion_main!(benches);
