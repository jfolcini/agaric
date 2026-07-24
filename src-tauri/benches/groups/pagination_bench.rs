// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

use criterion::{BenchmarkId, Criterion, criterion_group};

use agaric_lib::db::init_pool;
use agaric_store::pagination::*;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Helpers — transaction-wrapped for fast bulk inserts
// ---------------------------------------------------------------------------

/// Seed a parent block and `n` children with sequential positions.
async fn seed_children(pool: &sqlx::SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();
    // A 'page' block must set `page_id = id` (migration 0073 CHECK).
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, page_id) VALUES ('PARENT', 'page', 'p', 'PARENT')",
    )
    .execute(&mut *tx)
    .await
    .unwrap();

    for i in 0..n {
        let id = format!("CHILD{i:020}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', ?, 'PARENT', ?)",
        )
        .bind(&id)
        .bind(format!("c{i}"))
        .bind(i as i64 + 1)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

/// Seed `n` blocks of a given type.
async fn seed_typed_blocks(pool: &sqlx::SqlitePool, block_type: &str, n: usize) {
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("BLK{i:020}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(block_type)
            .bind(format!("content {i}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
}

/// Seed `n` soft-deleted blocks with distinct timestamps.
async fn seed_trash(pool: &sqlx::SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();
    // `blocks.deleted_at` is INTEGER epoch-ms since migration 0080; seed a
    // distinct, monotonically increasing timestamp per row (base = 2025-01-01
    // UTC) so trash ordering / cursor pagination stays deterministic.
    const BASE_MS: i64 = 1_735_689_600_000;
    for i in 0..n {
        let id = format!("TRASH{i:020}");
        let ts = BASE_MS + i as i64;
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, deleted_at) VALUES (?, 'content', ?, ?)",
        )
        .bind(&id)
        .bind(format!("trash {i}"))
        .bind(ts)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

/// Seed `n` blocks with `todo_state` but no `due_date` or `scheduled_date`.
async fn seed_undated_tasks(pool: &sqlx::SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();
    for i in 0..n {
        let id = format!("UNDATED{i:020}");
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, todo_state) \
             VALUES (?, 'content', ?, 'TODO')",
        )
        .bind(&id)
        .bind(format!("undated task {i}"))
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    tx.commit().await.unwrap();
}

/// Seed `n` blocks and tag them all with a single tag.
async fn seed_tagged_blocks(pool: &sqlx::SqlitePool, n: usize) {
    let mut tx = pool.begin().await.unwrap();

    // Create the tag
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content) VALUES ('TAG01', 'tag', 'bench-tag')",
    )
    .execute(&mut *tx)
    .await
    .unwrap();

    for i in 0..n {
        let id = format!("TAGGED{i:020}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
            .bind(&id)
            .bind(format!("tagged {i}"))
            .execute(&mut *tx)
            .await
            .unwrap();

        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, 'TAG01')")
            .bind(&id)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
}

/// Walk keyset pages (each capped at `MAX_PAGE_SIZE` = 200) until roughly the
/// middle of the dataset, returning a mid-list cursor for the `cursor_page`
/// benchmarks. A single `PageRequest` may not exceed 200 rows, so we page
/// forward instead of requesting `total / 2` in one shot (which now surfaces
/// as `AppError::Validation`). `fetch` returns `(items_returned, next_cursor)`.
async fn walk_to_mid<F, Fut>(total: usize, mut fetch: F) -> Option<String>
where
    F: FnMut(Option<String>, i64) -> Fut,
    Fut: std::future::Future<Output = (usize, Option<String>)>,
{
    let target = total / 2;
    let mut cursor: Option<String> = None;
    let mut seen = 0usize;
    while seen < target {
        let step = (target - seen).min(200) as i64;
        let (n, next) = fetch(cursor.clone(), step).await;
        seen += n;
        cursor = next;
        if cursor.is_none() {
            break;
        }
    }
    cursor
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

fn bench_list_children(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_children");

    for total in [10, 100, 1_000, 10_000, 100_000] {
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
                .iter(|| list_children(&pool, Some("PARENT"), &page, None));
        });

        // Mid-point cursor page
        let mid_cursor = rt.block_on(walk_to_mid(total, |cur, step| {
            let pool = &pool;
            async move {
                let page = PageRequest::new(cur, Some(step)).unwrap();
                let resp = list_children(pool, Some("PARENT"), &page, None)
                    .await
                    .unwrap();
                (resp.items.len(), resp.next_cursor)
            }
        }));

        if mid_cursor.is_some() {
            group.bench_with_input(BenchmarkId::new("cursor_page", total), &total, |b, _| {
                let page = PageRequest::new(mid_cursor.clone(), Some(50)).unwrap();
                b.to_async(&rt)
                    .iter(|| list_children(&pool, Some("PARENT"), &page, None));
            });
        }
    }
    group.finish();
}

fn bench_list_by_type(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_by_type");

    for total in [10, 100, 1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(async {
            let pool = init_pool(&dir.path().join("bench.db")).await.unwrap();
            seed_typed_blocks(&pool, "page", total).await;
            pool
        });

        group.bench_with_input(BenchmarkId::new("first_page", total), &total, |b, _| {
            let page = PageRequest::new(None, Some(50)).unwrap();
            b.to_async(&rt)
                .iter(|| list_by_type(&pool, "page", &page, None));
        });

        let mid_cursor = rt.block_on(walk_to_mid(total, |cur, step| {
            let pool = &pool;
            async move {
                let page = PageRequest::new(cur, Some(step)).unwrap();
                let resp = list_by_type(pool, "page", &page, None).await.unwrap();
                (resp.items.len(), resp.next_cursor)
            }
        }));

        if mid_cursor.is_some() {
            group.bench_with_input(BenchmarkId::new("cursor_page", total), &total, |b, _| {
                let page = PageRequest::new(mid_cursor.clone(), Some(50)).unwrap();
                b.to_async(&rt)
                    .iter(|| list_by_type(&pool, "page", &page, None));
            });
        }
    }
    group.finish();
}

fn bench_list_trash(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_trash");

    for total in [10, 100, 1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(async {
            let pool = init_pool(&dir.path().join("bench.db")).await.unwrap();
            seed_trash(&pool, total).await;
            pool
        });

        group.bench_with_input(BenchmarkId::new("first_page", total), &total, |b, _| {
            let page = PageRequest::new(None, Some(50)).unwrap();
            b.to_async(&rt).iter(|| list_trash(&pool, &page, None));
        });

        let mid_cursor = rt.block_on(walk_to_mid(total, |cur, step| {
            let pool = &pool;
            async move {
                let page = PageRequest::new(cur, Some(step)).unwrap();
                let resp = list_trash(pool, &page, None).await.unwrap();
                (resp.items.len(), resp.next_cursor)
            }
        }));

        if mid_cursor.is_some() {
            group.bench_with_input(BenchmarkId::new("cursor_page", total), &total, |b, _| {
                let page = PageRequest::new(mid_cursor.clone(), Some(50)).unwrap();
                b.to_async(&rt).iter(|| list_trash(&pool, &page, None));
            });
        }
    }
    group.finish();
}

fn bench_list_by_tag(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_by_tag");

    for total in [10, 100, 1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(async {
            let pool = init_pool(&dir.path().join("bench.db")).await.unwrap();
            seed_tagged_blocks(&pool, total).await;
            pool
        });

        group.bench_with_input(BenchmarkId::new("first_page", total), &total, |b, _| {
            let page = PageRequest::new(None, Some(50)).unwrap();
            b.to_async(&rt)
                .iter(|| list_by_tag(&pool, "TAG01", &page, None));
        });

        let mid_cursor = rt.block_on(walk_to_mid(total, |cur, step| {
            let pool = &pool;
            async move {
                let page = PageRequest::new(cur, Some(step)).unwrap();
                let resp = list_by_tag(pool, "TAG01", &page, None).await.unwrap();
                (resp.items.len(), resp.next_cursor)
            }
        }));

        if mid_cursor.is_some() {
            group.bench_with_input(BenchmarkId::new("cursor_page", total), &total, |b, _| {
                let page = PageRequest::new(mid_cursor.clone(), Some(50)).unwrap();
                b.to_async(&rt)
                    .iter(|| list_by_tag(&pool, "TAG01", &page, None));
            });
        }
    }
    group.finish();
}

fn bench_list_undated_tasks(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("list_undated_tasks");

    for total in [100, 1_000, 10_000, 100_000] {
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(async {
            let pool = init_pool(&dir.path().join("bench.db")).await.unwrap();
            seed_undated_tasks(&pool, total).await;
            pool
        });

        group.bench_with_input(BenchmarkId::new("first_page", total), &total, |b, _| {
            let page = PageRequest::new(None, Some(50)).unwrap();
            b.to_async(&rt)
                .iter(|| list_undated_tasks(&pool, &page, None));
        });

        let mid_cursor = rt.block_on(walk_to_mid(total, |cur, step| {
            let pool = &pool;
            async move {
                let page = PageRequest::new(cur, Some(step)).unwrap();
                let resp = list_undated_tasks(pool, &page, None).await.unwrap();
                (resp.items.len(), resp.next_cursor)
            }
        }));

        if mid_cursor.is_some() {
            group.bench_with_input(BenchmarkId::new("cursor_page", total), &total, |b, _| {
                let page = PageRequest::new(mid_cursor.clone(), Some(50)).unwrap();
                b.to_async(&rt)
                    .iter(|| list_undated_tasks(&pool, &page, None));
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
    bench_list_by_tag,
    bench_list_undated_tasks
);
