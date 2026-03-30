use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use block_notes_lib::cache::{
    rebuild_agenda_cache, rebuild_pages_cache, rebuild_tags_cache, reindex_block_links,
};
use block_notes_lib::db::init_pool;
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/// Insert `count` tag blocks, each used by one content block.
async fn seed_tags(pool: &SqlitePool, count: usize) {
    for i in 0..count {
        let tag_id = format!("TAG{i:020}");
        let blk_id = format!("BLK{i:020}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'tag', ?)")
            .bind(&tag_id)
            .bind(&format!("tag-{i}"))
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
            .bind(&blk_id)
            .bind(&format!("note {i}"))
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(&blk_id)
            .bind(&tag_id)
            .execute(pool)
            .await
            .unwrap();
    }
}

/// Insert `count` page blocks.
async fn seed_pages(pool: &SqlitePool, count: usize) {
    for i in 0..count {
        let id = format!("PG{i:021}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'page', ?)")
            .bind(&id)
            .bind(&format!("Page Title {i}"))
            .execute(pool)
            .await
            .unwrap();
    }
}

/// Insert `count` content blocks, each with a date property and a date tag.
async fn seed_agenda(pool: &SqlitePool, count: usize) {
    // One shared date tag
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('ADTAG0000000000000000000', 'tag', 'date/2025-07-01')")
        .execute(pool)
        .await
        .unwrap();

    for i in 0..count {
        let id = format!("AB{i:021}");
        let date = format!("2025-{:02}-{:02}", (i % 12) + 1, (i % 28) + 1);
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)")
            .bind(&id)
            .bind(&format!("agenda item {i}"))
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_date) VALUES (?, 'due', ?)",
        )
        .bind(&id)
        .bind(&date)
        .execute(pool)
        .await
        .unwrap();
        // Tag every 5th block with the shared date tag
        if i % 5 == 0 {
            sqlx::query(
                "INSERT INTO block_tags (block_id, tag_id) VALUES (?, 'ADTAG0000000000000000000')",
            )
            .bind(&id)
            .execute(pool)
            .await
            .unwrap();
        }
    }
}

/// Insert a source block referencing `link_count` target blocks via [[ULID]].
async fn seed_links(pool: &SqlitePool, link_count: usize) {
    let mut content = String::new();
    for i in 0..link_count {
        // Generate a valid 26-char uppercase alphanumeric id
        let target_id = format!("01HZ0000000000000000{i:06}");
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', 'target')")
            .bind(&target_id)
            .execute(pool)
            .await
            .unwrap();
        content.push_str(&format!("[[{target_id}]] "));
    }
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('LINKSRC00000000000000000', 'content', ?)")
        .bind(&content)
        .execute(pool)
        .await
        .unwrap();
}

// ---------------------------------------------------------------------------
// Helper: create a temporary pool
// ---------------------------------------------------------------------------

fn make_pool(rt: &Runtime, dir: &TempDir) -> SqlitePool {
    rt.block_on(async { init_pool(&dir.path().join("bench.db")).await.unwrap() })
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

fn bench_rebuild_tags_cache(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("rebuild_tags_cache");

    for count in [10, 100, 1000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        rt.block_on(seed_tags(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt).iter(|| rebuild_tags_cache(&pool));
        });
    }
    group.finish();
}

fn bench_rebuild_pages_cache(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("rebuild_pages_cache");

    for count in [10, 100, 1000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        rt.block_on(seed_pages(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt).iter(|| rebuild_pages_cache(&pool));
        });
    }
    group.finish();
}

fn bench_rebuild_agenda_cache(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("rebuild_agenda_cache");

    for count in [10, 100, 1000, 10_000] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        rt.block_on(seed_agenda(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt).iter(|| rebuild_agenda_cache(&pool));
        });
    }
    group.finish();
}

fn bench_reindex_block_links(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("reindex_block_links");

    for count in [5, 50, 200] {
        let dir = TempDir::new().unwrap();
        let pool = make_pool(&rt, &dir);
        rt.block_on(seed_links(&pool, count));

        group.bench_with_input(BenchmarkId::from_parameter(count), &count, |b, _| {
            b.to_async(&rt)
                .iter(|| reindex_block_links(&pool, "LINKSRC00000000000000000"));
        });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_rebuild_tags_cache,
    bench_rebuild_pages_cache,
    bench_rebuild_agenda_cache,
    bench_reindex_block_links,
);
criterion_main!(benches);
