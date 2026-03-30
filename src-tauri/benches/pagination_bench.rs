use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use block_notes_lib::{db::init_pool, pagination::*};
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Seed a parent block and `n` children with sequential positions.
async fn seed_children(pool: &sqlx::SqlitePool, n: usize) {
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('PARENT', 'page', 'p')")
        .execute(pool)
        .await
        .unwrap();

    for i in 0..n {
        let id = format!("CHILD{i:020}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, 'PARENT', ?)",
        )
        .bind(&id)
        .bind(&format!("c{i}"))
        .bind(i as i64 + 1)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Seed `n` blocks of a given type.
async fn seed_typed_blocks(pool: &sqlx::SqlitePool, block_type: &str, n: usize) {
    for i in 0..n {
        let id = format!("BLK{i:020}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(block_type)
            .bind(&format!("content {i}"))
            .execute(pool)
            .await
            .unwrap();
    }
}

/// Seed `n` soft-deleted blocks with distinct timestamps.
async fn seed_trash(pool: &sqlx::SqlitePool, n: usize) {
    for i in 0..n {
        let id = format!("TRASH{i:020}");
        let ts = format!("2025-01-15T12:{:02}:{:02}+00:00", i / 60, i % 60);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, deleted_at) VALUES (?, 'content', ?, ?)",
        )
        .bind(&id)
        .bind(&format!("trash {i}"))
        .bind(&ts)
        .execute(pool)
        .await
        .unwrap();
    }
}

/// Seed `n` blocks and tag them all with a single tag.
async fn seed_tagged_blocks(pool: &sqlx::SqlitePool, n: usize) {
    // Create the tag
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('TAG01', 'tag', 'bench-tag')",
    )
    .execute(pool)
    .await
    .unwrap();

    for i in 0..n {
        let id = format!("TAGGED{i:020}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
            .bind(&id)
            .bind(&format!("tagged {i}"))
            .execute(pool)
            .await
            .unwrap();

        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, 'TAG01')")
            .bind(&id)
            .execute(pool)
            .await
            .unwrap();
    }
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

fn bench_list_children(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_children");

    for total in [10, 100, 1000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(async {
            let pool = init_pool(&dir.path().join("bench.db")).await.unwrap();
            seed_children(&pool, total).await;
            pool
        });

        // First page (no cursor)
        group.bench_with_input(BenchmarkId::new("first_page", total), &total, |b, _| {
            let page = PageRequest::new(None, Some(50)).unwrap();
            b.to_async(&rt)
                .iter(|| list_children(&pool, Some("PARENT"), &page));
        });

        // Mid-point cursor page
        let mid_cursor = rt.block_on(async {
            let half = PageRequest::new(None, Some((total / 2) as i64)).unwrap();
            let resp = list_children(&pool, Some("PARENT"), &half).await.unwrap();
            resp.next_cursor
        });

        if mid_cursor.is_some() {
            group.bench_with_input(BenchmarkId::new("cursor_page", total), &total, |b, _| {
                let page = PageRequest::new(mid_cursor.clone(), Some(50)).unwrap();
                b.to_async(&rt)
                    .iter(|| list_children(&pool, Some("PARENT"), &page));
            });
        }
    }
    group.finish();
}

fn bench_list_by_type(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_by_type");

    for total in [10, 100, 1000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(async {
            let pool = init_pool(&dir.path().join("bench.db")).await.unwrap();
            seed_typed_blocks(&pool, "page", total).await;
            pool
        });

        group.bench_with_input(BenchmarkId::new("first_page", total), &total, |b, _| {
            let page = PageRequest::new(None, Some(50)).unwrap();
            b.to_async(&rt).iter(|| list_by_type(&pool, "page", &page));
        });

        let mid_cursor = rt.block_on(async {
            let half = PageRequest::new(None, Some((total / 2) as i64)).unwrap();
            let resp = list_by_type(&pool, "page", &half).await.unwrap();
            resp.next_cursor
        });

        if mid_cursor.is_some() {
            group.bench_with_input(BenchmarkId::new("cursor_page", total), &total, |b, _| {
                let page = PageRequest::new(mid_cursor.clone(), Some(50)).unwrap();
                b.to_async(&rt).iter(|| list_by_type(&pool, "page", &page));
            });
        }
    }
    group.finish();
}

fn bench_list_trash(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_trash");

    for total in [10, 100, 1000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(async {
            let pool = init_pool(&dir.path().join("bench.db")).await.unwrap();
            seed_trash(&pool, total).await;
            pool
        });

        group.bench_with_input(BenchmarkId::new("first_page", total), &total, |b, _| {
            let page = PageRequest::new(None, Some(50)).unwrap();
            b.to_async(&rt).iter(|| list_trash(&pool, &page));
        });

        let mid_cursor = rt.block_on(async {
            let half = PageRequest::new(None, Some((total / 2) as i64)).unwrap();
            let resp = list_trash(&pool, &half).await.unwrap();
            resp.next_cursor
        });

        if mid_cursor.is_some() {
            group.bench_with_input(BenchmarkId::new("cursor_page", total), &total, |b, _| {
                let page = PageRequest::new(mid_cursor.clone(), Some(50)).unwrap();
                b.to_async(&rt).iter(|| list_trash(&pool, &page));
            });
        }
    }
    group.finish();
}

fn bench_list_by_tag(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_by_tag");

    for total in [10, 100, 1000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(async {
            let pool = init_pool(&dir.path().join("bench.db")).await.unwrap();
            seed_tagged_blocks(&pool, total).await;
            pool
        });

        group.bench_with_input(BenchmarkId::new("first_page", total), &total, |b, _| {
            let page = PageRequest::new(None, Some(50)).unwrap();
            b.to_async(&rt).iter(|| list_by_tag(&pool, "TAG01", &page));
        });

        let mid_cursor = rt.block_on(async {
            let half = PageRequest::new(None, Some((total / 2) as i64)).unwrap();
            let resp = list_by_tag(&pool, "TAG01", &half).await.unwrap();
            resp.next_cursor
        });

        if mid_cursor.is_some() {
            group.bench_with_input(BenchmarkId::new("cursor_page", total), &total, |b, _| {
                let page = PageRequest::new(mid_cursor.clone(), Some(50)).unwrap();
                b.to_async(&rt).iter(|| list_by_tag(&pool, "TAG01", &page));
            });
        }
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_list_children,
    bench_list_by_type,
    bench_list_trash,
    bench_list_by_tag
);
criterion_main!(benches);
