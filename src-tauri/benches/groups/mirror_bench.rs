// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmarks for the Markdown mirror (#5363), the task that writes
//! every page to a folder and reads back edits made there:
//!   - `mirror_dirty_tick` — a tick writing N pages a sync named
//!   - `mirror_large_page_tick` — a tick writing one page of 2K blocks, the
//!     whole-page render each change of a large page costs
//!   - `mirror_startup_pass` — the first tick after a restart over a vault the
//!     mirror already wrote: a full pass that renders every page and compares
//!     it with the text last written, writing nothing
//!   - `mirror_idle_tick` — a tick with nothing to write: the polling scan,
//!     one stat per file and per folder, paid every `TICK`
//!   - `mirror_catchup_pass` — the full pass a snapshot catch-up asks for
//!     (a sync naming no page) at 100K blocks
//!   - `mirror_ingest_merge` — `apply_page_source_inner` with `merge`, as an
//!     ingest saves, on one large page

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use criterion::{BenchmarkId, Criterion, criterion_group};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

use agaric_lib::commands::mirror::set_mirror_folder_inner;
use agaric_lib::commands::pages::{
    SourceSaveFlags, apply_page_source_inner, get_page_buffer_inner,
};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::mirror::ingest::Ingest;
use agaric_lib::mirror::{Mirror, MirrorState};

const DEV: &str = "BENCH-MIRROR-DEVICE";
const SPACE: &str = "01SPACE0000000000000000001";
const SPACE_NAME: &str = "Bench";

/// A vault of `pages` pages of `blocks_per_page` blocks each in one space,
/// and a mirror over an empty folder, with the ingest on as the app runs it.
struct Vault {
    pool: SqlitePool,
    mat: Materializer,
    state: MirrorState,
    folder: TempDir,
    _data: TempDir,
    _db: TempDir,
}

fn page_id(n: usize) -> String {
    format!("01P{n:023}")
}

fn block_id(page: usize, n: usize) -> String {
    format!("01B{page:011}{n:012}")
}

async fn vault(pages: usize, blocks_per_page: usize) -> Vault {
    let db = TempDir::new().unwrap();
    let pool = init_pool(&db.path().join("bench.db")).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, NULL, ?)",
    )
    .bind(SPACE)
    .bind(SPACE_NAME)
    .bind(SPACE)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT INTO spaces (id) VALUES (?)")
        .bind(SPACE)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
    )
    .bind(SPACE)
    .execute(&mut *tx)
    .await
    .unwrap();
    for p in 0..pages {
        let page = page_id(p);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, page_id, space_id) \
             VALUES (?, 'page', ?, ?, ?, ?)",
        )
        .bind(&page)
        .bind(format!("Page {p}"))
        .bind(p as i64 + 1)
        .bind(&page)
        .bind(SPACE)
        .execute(&mut *tx)
        .await
        .unwrap();
        for b in 0..blocks_per_page {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
                 VALUES (?, 'content', ?, ?, ?, ?, ?)",
            )
            .bind(block_id(p, b))
            .bind(format!("Block {b} of page {p}: a sentence of ordinary note text."))
            .bind(&page)
            .bind(b as i64 + 1)
            .bind(&page)
            .bind(SPACE)
            .execute(&mut *tx)
            .await
            .unwrap();
        }
    }
    tx.commit().await.unwrap();

    let folder = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let state = MirrorState::new(data.path().to_path_buf());
    set_mirror_folder_inner(
        &pool,
        DEV,
        &state,
        Some(folder.path().display().to_string()),
        true,
    )
    .await
    .unwrap();
    let mat = Materializer::new(pool.clone());
    Vault {
        pool,
        mat,
        state,
        folder,
        _data: data,
        _db: db,
    }
}

impl Vault {
    /// The mirror's task as the app opens it.
    async fn open(&self) -> Mirror {
        let ingest = Ingest {
            pool: self.pool.clone(),
            materializer: self.mat.clone(),
            notify: Arc::new(|_| {}),
        };
        Mirror::open(self.pool.clone(), DEV.to_owned(), self.state.clone())
            .await
            .unwrap()
            .with_ingest(ingest)
    }
}

/// The `.md` files below `root`.
fn file_count(root: &Path) -> usize {
    let mut count = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "md") {
                count += 1;
            }
        }
    }
    count
}

/// A vault whose pages the mirror has written, with that first pass checked:
/// one file per page, and nothing diverged or failed.
async fn mirrored(pages: usize, blocks_per_page: usize) -> (Vault, Mirror) {
    let vault = vault(pages, blocks_per_page).await;
    let mut mirror = vault.open().await;
    mirror.tick().await.unwrap();
    assert_eq!(
        file_count(vault.folder.path()),
        pages,
        "the first pass writes one file per page"
    );
    let settings = agaric_lib::mirror::store::Settings {
        folder: Some(String::new()),
        read_back: true,
    };
    let status = vault.state.status(settings, Vec::new());
    assert!(
        status.diverged.is_empty() && status.failed.is_empty(),
        "{status:?}"
    );
    (vault, mirror)
}

fn bench_dirty_tick(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    const PAGES: usize = 1000;
    let (vault, mut mirror) = rt.block_on(mirrored(PAGES, 10));
    let mut group = c.benchmark_group("mirror_dirty_tick");
    // A name filter skips the timed loop but not the checks after it.
    let timed = std::cell::Cell::new(0u64);
    group.sample_size(10);
    for dirty in [10usize, 100, 1000] {
        group.bench_with_input(BenchmarkId::from_parameter(dirty), &dirty, |b, &dirty| {
            b.iter_custom(|iters| {
                timed.set(timed.get() + iters);
                rt.block_on(async {
                    let mut total = Duration::ZERO;
                    for round in 0..iters {
                        let ids: Vec<String> = (0..dirty).map(page_id).collect();
                        for p in 0..dirty {
                            sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
                                .bind(format!("Edited {round} of page {p}"))
                                .bind(block_id(p, 0))
                                .execute(&vault.pool)
                                .await
                                .unwrap();
                        }
                        vault.state.note_sync(&ids, Some(dirty));
                        let start = Instant::now();
                        mirror.tick().await.unwrap();
                        total += start.elapsed();
                    }
                    total
                })
            });
        });
    }
    group.finish();
    // Durable effect: the last round's edits are on disk.
    let file = vault.folder.path().join(SPACE_NAME).join("Page 0.md");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        timed.get() == 0 || text.contains("Edited "),
        "the dirty pages were written: {text}"
    );
    rt.block_on(async { vault.mat.shutdown() });
}

fn bench_large_page_tick(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    const BLOCKS: usize = 2_000;
    let (vault, mut mirror) = rt.block_on(mirrored(1, BLOCKS));
    let mut group = c.benchmark_group("mirror_large_page_tick");
    // A name filter skips the timed loop but not the checks after it.
    let timed = std::cell::Cell::new(0u64);
    group.sample_size(10);
    group.bench_function(BenchmarkId::from_parameter(BLOCKS), |b| {
        b.iter_custom(|iters| {
            timed.set(timed.get() + iters);
            rt.block_on(async {
                let mut total = Duration::ZERO;
                for round in 0..iters {
                    sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
                        .bind(format!("Edited {round}"))
                        .bind(block_id(0, usize::try_from(round).unwrap() % BLOCKS))
                        .execute(&vault.pool)
                        .await
                        .unwrap();
                    vault.state.note_sync(&[page_id(0)], Some(1));
                    let start = Instant::now();
                    mirror.tick().await.unwrap();
                    total += start.elapsed();
                }
                total
            })
        });
    });
    group.finish();
    let file = vault.folder.path().join(SPACE_NAME).join("Page 0.md");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(
        timed.get() == 0 || text.contains("Edited "),
        "the page was written: {}",
        text.len()
    );
    rt.block_on(async { vault.mat.shutdown() });
}

fn bench_startup_pass(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    const PAGES: usize = 10_000;
    let (vault, _first) = rt.block_on(mirrored(PAGES, 5));
    let mut group = c.benchmark_group("mirror_startup_pass");
    group.sample_size(10);
    group.bench_function(BenchmarkId::from_parameter(PAGES), |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    let start = Instant::now();
                    let mut mirror = vault.open().await;
                    mirror.tick().await.unwrap();
                    total += start.elapsed();
                }
                total
            })
        });
    });
    group.finish();
    rt.block_on(async { vault.mat.shutdown() });
}

fn bench_idle_tick(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    const PAGES: usize = 10_000;
    let (vault, mut mirror) = rt.block_on(mirrored(PAGES, 5));
    // A second tick lists every folder once, as a running mirror has.
    rt.block_on(mirror.tick()).unwrap();
    let mut group = c.benchmark_group("mirror_idle_tick");
    group.sample_size(20);
    group.bench_function(BenchmarkId::from_parameter(PAGES), |b| {
        b.iter(|| rt.block_on(mirror.tick()).unwrap());
    });
    group.finish();
    assert_eq!(
        file_count(vault.folder.path()),
        PAGES,
        "an idle tick writes nothing"
    );
    rt.block_on(async { vault.mat.shutdown() });
}

fn bench_catchup_pass(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    const PAGES: usize = 2_000;
    const BLOCKS_PER_PAGE: usize = 50;
    let (vault, mut mirror) = rt.block_on(mirrored(PAGES, BLOCKS_PER_PAGE));
    let mut group = c.benchmark_group("mirror_catchup_pass");
    group.sample_size(10);
    group.bench_function(BenchmarkId::from_parameter(PAGES * BLOCKS_PER_PAGE), |b| {
        b.iter(|| {
            vault.state.note_sync(&[], None);
            rt.block_on(mirror.tick()).unwrap();
        });
    });
    group.finish();
    rt.block_on(async { vault.mat.shutdown() });
}

fn bench_ingest_merge(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    const BLOCKS: usize = 2_000;
    let vault = rt.block_on(vault(1, BLOCKS));
    let page = page_id(0);
    let first = rt
        .block_on(get_page_buffer_inner(&vault.pool, &page))
        .unwrap();
    let lines = first.text.split('\n').count();
    assert!(
        lines >= BLOCKS,
        "the page renders every block: {lines} lines"
    );
    let mut group = c.benchmark_group("mirror_ingest_merge");
    // A name filter skips the timed loop but not the checks after it.
    let timed = std::cell::Cell::new(0u64);
    group.sample_size(10);
    group.bench_function(BenchmarkId::from_parameter(BLOCKS), |b| {
        let mut round = 0usize;
        b.iter_custom(|iters| {
            timed.set(timed.get() + iters);
            rt.block_on(async {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    round += 1;
                    let buffer = get_page_buffer_inner(&vault.pool, &page).await.unwrap();
                    let at = round % BLOCKS;
                    let text = buffer.text.replacen(
                        &format!("Block {at} of page 0:"),
                        &format!("Block {at} of page 0 (edit {round}):"),
                        1,
                    );
                    let start = Instant::now();
                    apply_page_source_inner(
                        &vault.pool,
                        DEV,
                        &vault.mat,
                        &page,
                        text,
                        buffer.source,
                        SourceSaveFlags {
                            merge: true,
                            line_ids: buffer.line_ids,
                        },
                    )
                    .await
                    .unwrap();
                    total += start.elapsed();
                }
                total
            })
        });
    });
    group.finish();
    let edited: i64 = rt
        .block_on(
            sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE content LIKE '%(edit %'")
                .fetch_one(&vault.pool),
        )
        .unwrap();
    assert!(timed.get() == 0 || edited > 0, "the saves landed");
    rt.block_on(async { vault.mat.shutdown() });
}

criterion_group!(
    mirror_benches,
    bench_dirty_tick,
    bench_large_page_tick,
    bench_startup_pass,
    bench_idle_tick,
    bench_catchup_pass,
    bench_ingest_merge,
);
