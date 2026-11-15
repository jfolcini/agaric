// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]
#![allow(clippy::cast_precision_loss)]

//! #6563 — what one space's Loro state costs as its history grows, and what
//! the first sync of that space costs the device receiving it.
//!
//! The fixture is one space of `n` blocks (a page per 100 blocks, built through
//! the engine's write path, as `rehydrate_bench` does), then `m` rounds of one
//! edit to every block, so the doc carries `n × m` text ops of history. For
//! each `n × m` it prints, untimed:
//!
//! - `snapshot bytes` — what `export_snapshot` writes to `loro_doc_state` and
//!   ships on a snapshot catch-up;
//! - `heap after rehydrate` — the heap a fresh engine still holds after the
//!   boot rehydrate (import, index rebuild, one block read), read by the
//!   counting allocator `loro_wire_bench` installs for this binary; `peak` is
//!   the most it held at once on the way.
//!
//! and times, each case printed as `loro_snapshot_bench: <case> @ <n>x<m> = …`:
//!
//! - `export` — `export_snapshot` of the seeded engine;
//! - `rehydrate` — import into an empty engine, index rebuild, one block read;
//! - `cold_first_sync` — `apply_remote` of the snapshot into a fresh vault with
//!   no engine for the space: inbox write, import, and the SQL projection of
//!   every block. One such call is one sync dispatch, so it is printed next to
//!   `HANDSHAKE_TIMEOUT`, the dispatch limit it must fit.
//!
//! `attachment_scan` times `find_missing_attachments` over `ATTACHMENTS` live
//! rows whose files are all present: the stat of every attachment the receive
//! phase of every sync session pays before it requests any file.
//!
//! Measurement only: no budget. Each case's effect is asserted once, untimed,
//! before its timed loop. A timing prints as its median with the lowest and
//! highest sample and the sample count: that range is the noise band, and a
//! difference inside it is not a difference.
//!
//! `LORO_SNAPSHOT_MAX_BLOCKS=<n>` skips the scales above `n`, for a run that
//! must fit a short budget. The command that regenerates the numbers in
//! `docs/architecture/operations.md` § Loro engine cost is in that section.

use std::cell::RefCell;
use std::hint::black_box;
use std::rc::Rc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use agaric_engine::loro::engine::LoroEngine;
use agaric_engine::loro::registry::LoroEngineRegistry;
use agaric_lib::db::init_pool;
use agaric_store::space::SpaceId;
use agaric_sync::sync_constants::HANDSHAKE_TIMEOUT;
use agaric_sync::sync_files::find_missing_attachments;
use agaric_sync::sync_protocol::loro_sync::{ApplyOutcome, apply_remote};
use agaric_sync::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};
use criterion::{BatchSize, BenchmarkId, Criterion, SamplingMode, criterion_group};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

use crate::loro_wire_bench::{LIVE, PEAK, TRACKING};

/// The device that writes the space, and the one that receives it cold.
const DEVICE_A: &str = "01LOROSNAPBENCHDEVICEA0001";
const DEVICE_B: &str = "01LOROSNAPBENCHDEVICEB0001";
const SPACE: &str = "01LOROSNAPBENCHSPACE000001";
/// One page per this many blocks; the rest are its children.
const BLOCKS_PER_PAGE: usize = 100;
/// The scales `rehydrate_bench` builds.
const SCALES: &[usize] = &[10_000, 100_000];
/// Rounds of one edit to every block: none, and a doc whose history outweighs
/// its live text.
const EDIT_ROUNDS: &[usize] = &[0, 10];
/// What each edit prepends, about one typed word.
const EDIT: &str = "word ";
const ATTACHMENTS: usize = 10_000;
/// Each 100K sample moves or projects the whole space, so keep the count low.
const SAMPLE_SIZE: usize = 10;
const GROUP: &str = "loro_snapshot_bench";

fn block_id(i: usize) -> String {
    format!("01LOROSNAPBENCH{i:011}")
}

/// Every timed call of one case, in order.
#[derive(Clone, Default)]
pub(crate) struct Samples(Rc<RefCell<Vec<Duration>>>);

impl Samples {
    pub(crate) fn record(&self, elapsed: Duration) {
        self.0.borrow_mut().push(elapsed);
    }

    pub(crate) fn count(&self) -> usize {
        self.0.borrow().len()
    }

    /// The median, lowest and highest of `other[i] / self[i]` over the samples
    /// both arms took in turn, or `None` when either has none.
    pub(crate) fn ratio_to(&self, other: &Samples) -> Option<(f64, f64, f64)> {
        let (base, other) = (self.0.borrow(), other.0.borrow());
        let mut ratios: Vec<f64> = base
            .iter()
            .zip(other.iter())
            .map(|(b, o)| o.as_secs_f64() / b.as_secs_f64())
            .collect();
        ratios.sort_unstable_by(f64::total_cmp);
        Some((
            *ratios.get(ratios.len() / 2)?,
            *ratios.first()?,
            *ratios.last()?,
        ))
    }

    /// Median, lowest and highest sample and their count, or `None` when a
    /// name filter left the case out.
    pub(crate) fn summary(&self) -> Option<Summary> {
        let mut sorted = self.0.borrow().clone();
        sorted.sort_unstable();
        Some(Summary {
            median: sorted.get(sorted.len() / 2).copied()?,
            min: *sorted.first()?,
            max: *sorted.last()?,
            n: sorted.len(),
        })
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Summary {
    pub(crate) median: Duration,
    min: Duration,
    max: Duration,
    n: usize,
}

impl std::fmt::Display for Summary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        write!(
            f,
            "{:.2} ms [{:.2} – {:.2}] n={}",
            ms(self.median),
            ms(self.min),
            ms(self.max),
            self.n
        )
    }
}

pub(crate) fn report(group: &str, case: &str, scale: &str, samples: &Samples) {
    match samples.summary() {
        Some(summary) => {
            println!("{group}: {case} @ {scale} = median {summary} (measurement only — no budget)");
        }
        None => println!("{group}: {case} @ {scale} not selected"),
    }
}

/// The largest scale this run builds.
fn max_blocks() -> usize {
    std::env::var("LORO_SNAPSHOT_MAX_BLOCKS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(usize::MAX)
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// A's engine holding `n` blocks after `rounds` edits to each.
fn seed_engine(n: usize, rounds: usize) -> (LoroEngine, Vec<String>) {
    let mut engine = LoroEngine::with_peer_id(DEVICE_A).expect("engine");
    let ids: Vec<String> = (0..n).map(block_id).collect();
    for (i, id) in ids.iter().enumerate() {
        let slot = i % BLOCKS_PER_PAGE;
        if slot == 0 {
            engine
                .apply_create_block_at(id, "page", "page", None, i / BLOCKS_PER_PAGE)
                .expect("seed page");
        } else {
            let page = &ids[i - slot];
            engine
                .apply_create_block_at(id, "content", "block content", Some(page), slot - 1)
                .expect("seed block");
        }
    }
    for _ in 0..rounds {
        for id in &ids {
            engine.apply_edit_content(id, 0, 0, EDIT).expect("edit");
        }
    }
    (engine, ids)
}

/// The boot rehydrate of `snapshot` on B, ending with one block read so a
/// lazily decoded doc pays its decode here.
fn rehydrate(snapshot: &[u8], read_id: &str) -> LoroEngine {
    let mut engine = LoroEngine::with_peer_id(DEVICE_B).expect("engine");
    engine.import_deferring_index(snapshot).expect("import");
    engine.rebuild_index_after_import();
    black_box(engine.read_block(read_id).expect("read"));
    engine
}

/// Heap still held by the rehydrated engine, and the most held on the way.
fn heap_after_rehydrate(snapshot: &[u8], read_id: &str) -> (isize, isize) {
    LIVE.store(0, Ordering::Relaxed);
    PEAK.store(0, Ordering::Relaxed);
    TRACKING.store(true, Ordering::Relaxed);
    let engine = rehydrate(snapshot, read_id);
    let held = LIVE.load(Ordering::Relaxed);
    TRACKING.store(false, Ordering::Relaxed);
    drop(engine);
    (held, PEAK.load(Ordering::Relaxed))
}

fn snapshot_message(snapshot: &[u8]) -> LoroSyncMessage {
    LoroSyncMessage::Snapshot {
        protocol_version: LORO_SYNC_PROTOCOL_VERSION,
        space_id: SpaceId::from_trusted(SPACE),
        bytes: snapshot.to_vec(),
    }
}

/// A vault on B that has never seen the space: a fresh database and no engine.
struct ColdVault {
    pool: SqlitePool,
    registry: LoroEngineRegistry,
    _dir: TempDir,
}

async fn cold_vault() -> ColdVault {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("cold.db")).await.unwrap();
    ColdVault {
        pool,
        registry: LoroEngineRegistry::new(),
        _dir: dir,
    }
}

async fn cold_first_sync(vault: &ColdVault, msg: LoroSyncMessage) {
    let outcome = apply_remote(&vault.pool, &vault.registry, DEVICE_B, msg)
        .await
        .expect("apply_remote");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "the snapshot imports, got {outcome:?}"
    );
}

/// Every block in the vault: a cold vault holds only what the sync projected,
/// and `space_id` is a derived column the materializer fills afterwards.
async fn count_blocks(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM blocks")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// What a vault holds of one space's saved engine.
struct SavedBytes {
    delta_rows: i64,
    delta_bytes: i64,
    state_rows: i64,
    state_bytes: i64,
}

async fn saved_bytes(pool: &SqlitePool) -> SavedBytes {
    let (delta_rows, delta_bytes): (i64, i64) =
        sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(length(bytes)), 0) FROM loro_doc_delta")
            .fetch_one(pool)
            .await
            .unwrap();
    let (state_rows, state_bytes): (i64, i64) =
        sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(length(snapshot)), 0) FROM loro_doc_state")
            .fetch_one(pool)
            .await
            .unwrap();
    SavedBytes {
        delta_rows,
        delta_bytes,
        state_rows,
        state_bytes,
    }
}

// ---------------------------------------------------------------------------
// Benches
// ---------------------------------------------------------------------------

fn bench_case(c: &mut Criterion, rt: &Runtime, n: usize, rounds: usize) {
    let scale = format!("{n}x{rounds}");
    let (engine, ids) = seed_engine(n, rounds);
    // A content block, not a page: `n / 2` starts a page at every scale.
    let read_id = ids[n / 2 + 1].clone();
    let snapshot = engine.export_snapshot().expect("export snapshot");

    // Shape probe: the rehydrated doc holds every block, with every edit.
    let probe = rehydrate(&snapshot, &read_id);
    let content = probe
        .read_block_content(&read_id)
        .expect("read")
        .expect("the middle block is present");
    assert_eq!(content, format!("{}block content", EDIT.repeat(rounds)));
    let indexed = ids.iter().filter(|id| probe.contains_block(id)).count();
    assert_eq!(indexed, n, "the rehydrated index holds every seeded block");
    drop(probe);

    // Shape probe: a cold first sync projects every block into SQL.
    let (projected, saved) = rt.block_on(async {
        let vault = cold_vault().await;
        cold_first_sync(&vault, snapshot_message(&snapshot)).await;
        (
            count_blocks(&vault.pool).await,
            saved_bytes(&vault.pool).await,
        )
    });
    assert_eq!(
        projected,
        i64::try_from(n).unwrap(),
        "a cold first sync projects every block"
    );
    println!(
        "{GROUP}: after a cold first sync @ {scale}: loro_doc_delta {} rows, {} bytes; \
         loro_doc_state {} rows, {} bytes",
        saved.delta_rows, saved.delta_bytes, saved.state_rows, saved.state_bytes
    );

    let (held, peak) = heap_after_rehydrate(&snapshot, &read_id);
    println!(
        "loro_snapshot_bench: snapshot bytes @ {scale} = {}; heap after rehydrate = {held} \
         bytes (peak {peak})",
        snapshot.len()
    );

    let (export, rehydrated, cold) = (Samples::default(), Samples::default(), Samples::default());
    let mut group = c.benchmark_group("loro_snapshot");
    group.sample_size(SAMPLE_SIZE);
    group.sampling_mode(SamplingMode::Flat);
    group.bench_function(BenchmarkId::new("export", &scale), |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                let start = Instant::now();
                black_box(engine.export_snapshot().expect("export snapshot"));
                let elapsed = start.elapsed();
                export.record(elapsed);
                total += elapsed;
            }
            total
        });
    });
    group.bench_function(BenchmarkId::new("rehydrate", &scale), |b| {
        b.iter_batched(
            || (),
            |()| {
                let start = Instant::now();
                let engine = rehydrate(&snapshot, &read_id);
                rehydrated.record(start.elapsed());
                engine
            },
            BatchSize::PerIteration,
        );
    });
    group.bench_function(BenchmarkId::new("cold_first_sync", &scale), |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                let vault = rt.block_on(cold_vault());
                let msg = snapshot_message(&snapshot);
                let start = Instant::now();
                rt.block_on(cold_first_sync(&vault, msg));
                let elapsed = start.elapsed();
                cold.record(elapsed);
                total += elapsed;
            }
            total
        });
    });
    group.finish();

    report(GROUP, "export", &scale, &export);
    report(GROUP, "rehydrate", &scale, &rehydrated);
    report(GROUP, "cold_first_sync", &scale, &cold);
    if let Some(summary) = cold.summary() {
        println!(
            "{GROUP}: cold_first_sync @ {scale} median is {:.1}% of the {} s dispatch limit",
            summary.median.as_secs_f64() * 100.0 / HANDSHAKE_TIMEOUT.as_secs_f64(),
            HANDSHAKE_TIMEOUT.as_secs()
        );
    }
}

fn bench_loro_snapshot(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    for &n in SCALES.iter().filter(|&&n| n <= max_blocks()) {
        for &rounds in EDIT_ROUNDS {
            bench_case(c, &rt, n, rounds);
        }
    }
}

/// A vault with `ATTACHMENTS` live attachments on one block, each file
/// present on disk at the size its row records.
async fn seed_attachments(pool: &SqlitePool, app_data_dir: &std::path::Path) {
    let owner = block_id(0);
    sqlx::query("INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', 'p', ?)")
        .bind(&owner)
        .bind(&owner)
        .execute(pool)
        .await
        .unwrap();
    std::fs::create_dir_all(app_data_dir.join("attachments")).unwrap();
    const CHUNK: usize = 500;
    let mut tx = pool.begin().await.unwrap();
    for start in (0..ATTACHMENTS).step_by(CHUNK) {
        let rows = start..(start + CHUNK).min(ATTACHMENTS);
        let sql = format!(
            "INSERT INTO attachments \
             (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) VALUES {}",
            vec!["(?, ?, 'text/plain', 'a.txt', 1, ?, 0)"; rows.len()].join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for i in rows {
            let fs_path = format!("attachments/{i}.txt");
            std::fs::write(app_data_dir.join(&fs_path), b"x").unwrap();
            q = q
                .bind(format!("01LOROSNAPBENCHATT{i:08}"))
                .bind(&owner)
                .bind(fs_path);
        }
        q.execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
}

fn bench_attachment_scan(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let dir = TempDir::new().unwrap();
    let pool = rt
        .block_on(init_pool(&dir.path().join("attachments.db")))
        .unwrap();
    rt.block_on(seed_attachments(&pool, dir.path()));

    // Shape probe: every row is live and every file is present, so the scan
    // stats all of them and finds none missing.
    let live: i64 = rt.block_on(async {
        sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE deleted_at IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap()
    });
    assert_eq!(live, i64::try_from(ATTACHMENTS).unwrap());
    let missing = rt
        .block_on(find_missing_attachments(&pool, dir.path()))
        .unwrap();
    assert_eq!(missing.len(), 0, "every seeded file is present");

    let scan = Samples::default();
    let mut group = c.benchmark_group("loro_snapshot");
    group.sample_size(SAMPLE_SIZE);
    group.bench_function(BenchmarkId::new("attachment_scan", ATTACHMENTS), |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                let start = Instant::now();
                black_box(
                    rt.block_on(find_missing_attachments(&pool, dir.path()))
                        .unwrap(),
                );
                let elapsed = start.elapsed();
                scan.record(elapsed);
                total += elapsed;
            }
            total
        });
    });
    group.finish();
    report(GROUP, "attachment_scan", &ATTACHMENTS.to_string(), &scan);
}

criterion_group!(benches, bench_loro_snapshot, bench_attachment_scan);
