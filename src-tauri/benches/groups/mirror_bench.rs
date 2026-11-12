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
//!     one stat per file and per folder, paid every `TICK`; once per
//!     setting: as set by default, reading back off, copying on, and a
//!     second space turned off
//!   - `mirror_catchup_pass` — the full pass a snapshot catch-up asks for
//!     (a sync naming no page) at 100K blocks
//!   - `mirror_copy_first` — the first full pass with copying on, every
//!     page written and every attachment it links copied into the folder
//!   - `mirror_copy_unchanged` — a full pass with every copy in place, which
//!     copies nothing
//!   - `mirror_ingest_merge` — `apply_page_source_inner` with `merge`, as an
//!     ingest saves, on one large page

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use criterion::{BenchmarkId, Criterion, criterion_group};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

use agaric_core::ulid::BlockId;
use agaric_lib::commands::add_attachment_with_bytes_inner;
use agaric_lib::commands::mirror::{
    get_mirror_status_inner, set_mirror_copy_files_inner, set_mirror_folder_inner,
    set_mirror_read_back_inner, set_mirror_space_inner,
};
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
const OTHER_SPACE: &str = "01SPACE0000000000000000002";

/// A vault of `pages` pages of `blocks_per_page` blocks each in one space,
/// and a mirror over an empty folder, with the ingest on as the app runs it.
struct Vault {
    pool: SqlitePool,
    mat: Materializer,
    state: MirrorState,
    folder: TempDir,
    data: TempDir,
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
    insert_space(&mut tx, SPACE, SPACE_NAME, 0..pages, blocks_per_page).await;
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
        data,
        _db: db,
    }
}

/// The space `id`, named `name`, holding pages `numbers` of `blocks_per_page`
/// blocks each.
async fn insert_space(
    tx: &mut sqlx::SqliteConnection,
    id: &str,
    name: &str,
    numbers: std::ops::Range<usize>,
    blocks_per_page: usize,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, NULL, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(id)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query("INSERT INTO spaces (id) VALUES (?)")
        .bind(id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .unwrap();
    for p in numbers {
        let page = page_id(p);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, page_id, space_id) \
             VALUES (?, 'page', ?, ?, ?, ?)",
        )
        .bind(&page)
        .bind(format!("Page {p}"))
        .bind(p as i64 + 1)
        .bind(&page)
        .bind(id)
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
            .bind(id)
            .execute(&mut *tx)
            .await
            .unwrap();
        }
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
        copy_files: false,
        unmirrored: Vec::new(),
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

/// The idle tick under each setting, over one vault: 10K pages in one space
/// and 100 in a second, the space `space_off` turns off.
fn bench_idle_tick(c: &mut Criterion) {
    const PAGES: usize = 10_000;
    const OTHER: usize = 100;
    let mut group = c.benchmark_group("mirror_idle_tick");
    group.sample_size(20);
    for setting in ["default", "read_back_off", "copy_files_on", "space_off"] {
        let rt = Runtime::new().unwrap();
        let vault = rt.block_on(async {
            let vault = vault(PAGES, 5).await;
            let mut conn = vault.pool.acquire().await.unwrap();
            insert_space(&mut conn, OTHER_SPACE, "Other", PAGES..PAGES + OTHER, 5).await;
            drop(conn);
            let (pool, state) = (&vault.pool, &vault.state);
            match setting {
                "read_back_off" => set_mirror_read_back_inner(pool, DEV, state, false, &[]).await,
                "copy_files_on" => set_mirror_copy_files_inner(pool, DEV, state, true).await,
                "space_off" => set_mirror_space_inner(pool, DEV, state, OTHER_SPACE, false).await,
                _ => get_mirror_status_inner(pool, DEV, state).await,
            }
            .unwrap();
            vault
        });
        let mut mirror = rt.block_on(vault.open());
        // A first pass writes every page; a second lists every folder once,
        // as a running mirror has.
        rt.block_on(mirror.tick()).unwrap();
        rt.block_on(mirror.tick()).unwrap();
        let files = if setting == "space_off" {
            PAGES
        } else {
            PAGES + OTHER
        };
        assert_eq!(
            file_count(vault.folder.path()),
            files,
            "{setting}: one file per page"
        );
        group.bench_function(BenchmarkId::new(setting, PAGES), |b| {
            b.iter(|| rt.block_on(mirror.tick()).unwrap());
        });
        assert_eq!(
            file_count(vault.folder.path()),
            files,
            "{setting}: an idle tick writes nothing"
        );
        rt.block_on(async { vault.mat.shutdown() });
    }
    group.finish();
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

/// The copies below `root`'s `assets/<id>/` folders.
fn copy_count(root: &Path) -> usize {
    let assets = root.join(SPACE_NAME).join("assets");
    std::fs::read_dir(assets).map_or(0, |dirs| {
        dirs.flatten()
            .map(|dir| std::fs::read_dir(dir.path()).map_or(0, Iterator::count))
            .sum()
    })
}

/// A vault of `pages` pages whose one block links an attachment of its own
/// of `size` bytes, with copying on.
async fn with_attachments(pages: usize, size: usize) -> Vault {
    let vault = vault(pages, 1).await;
    for p in 0..pages {
        let attachment = add_attachment_with_bytes_inner(
            &vault.pool,
            DEV,
            &vault.mat,
            vault.data.path(),
            BlockId::from_trusted(&block_id(p, 0)),
            format!("picture {p}.png"),
            "image/png".into(),
            vec![u8::try_from(p % 251).unwrap(); size],
        )
        .await
        .unwrap()
        .id;
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind(format!("![picture](attachment:{attachment})"))
            .bind(block_id(p, 0))
            .execute(&vault.pool)
            .await
            .unwrap();
    }
    set_mirror_copy_files_inner(&vault.pool, DEV, &vault.state, true)
        .await
        .unwrap();
    vault
}

fn bench_copy_passes(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    const PAGES: usize = 500;
    const SIZE: usize = 64 * 1024;
    let vault = rt.block_on(with_attachments(PAGES, SIZE));
    let mut group = c.benchmark_group("mirror_copy_first");
    group.sample_size(10);
    // A name filter skips the timed loop but not the checks after it.
    let timed = std::cell::Cell::new(0u64);
    group.bench_function(BenchmarkId::from_parameter(PAGES), |b| {
        b.iter_custom(|iters| {
            timed.set(timed.get() + iters);
            rt.block_on(async {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    // A first pass: no state and an empty folder.
                    let mirror_state = vault.data.path().join("mirror");
                    let _ = std::fs::remove_dir_all(&mirror_state);
                    for entry in std::fs::read_dir(vault.folder.path()).unwrap() {
                        let path = entry.unwrap().path();
                        if path.is_dir() {
                            std::fs::remove_dir_all(path).unwrap();
                        }
                    }
                    let mut mirror = vault.open().await;
                    let start = Instant::now();
                    mirror.tick().await.unwrap();
                    total += start.elapsed();
                }
                total
            })
        });
    });
    group.finish();
    assert!(
        timed.get() == 0 || copy_count(vault.folder.path()) == PAGES,
        "every attachment is copied: {}",
        copy_count(vault.folder.path())
    );

    // The pass after it, with every copy in place.
    let mut mirror = rt.block_on(vault.open());
    rt.block_on(mirror.tick()).unwrap();
    assert_eq!(
        copy_count(vault.folder.path()),
        PAGES,
        "the copies are in place"
    );
    let mut group = c.benchmark_group("mirror_copy_unchanged");
    group.sample_size(10);
    group.bench_function(BenchmarkId::from_parameter(PAGES), |b| {
        b.iter(|| {
            vault.state.restart();
            rt.block_on(mirror.tick()).unwrap();
        });
    });
    group.finish();
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
    bench_copy_passes,
);
