// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! #6563 for #6811 — a write on a vault built from a peer's changes, beside the
//! same write on the vault that wrote them.
//!
//! The fixture is the shape #6811 reports: one space of about 3K blocks, one
//! page of `PAGE_CHILDREN` blocks and a second page of filler, written by
//! commands on device A (the app-written arm). Device B's vault starts empty
//! and receives A's space snapshot through `apply_remote`, as a first sync
//! does (the pulled arm); its commands then run under B's own device id.
//!
//! Two writes, each timed on both arms with the arms interleaved sample by
//! sample so drift lands on both:
//!
//! - `split` — `create_block_inner` at the middle sibling slot of the big
//!   page, the create an Enter in the middle of a line makes;
//! - `paste` — `create_blocks_batch_inner` of `PASTE_BLOCKS` blocks appended to
//!   it, the create a page-mode paste makes.
//!
//! Every timing prints as `pulled_vault_bench: <write> @ <arm> = median [min –
//! max] n=<samples>`, then the pulled arm over the app-written one as the
//! median and range of the per-sample ratios. The page grows with every
//! sample, by one block for a split and by `PASTE_BLOCKS` for a paste, so a
//! write's timings drift upward through a run on both arms alike; the ratio of
//! a pair taken in turn is the figure that cancels it. A ratio range that
//! holds 1.0 is no difference. Measurement only: no budget.
//!
//! This is the command path over a real pool and the engine, not the app: no
//! IPC, no UI, no paired peer, and a release build, where #6811's table is a
//! debug build in the real-backend lane.

use std::time::{Duration, Instant};

use agaric_engine::loro::engine::LoroEngine;
use agaric_lib::commands::tests::common::{
    DEV, TEST_SPACE_ID, assign_all_to_test_space, ensure_test_space, mark_block_as_space,
    space_page,
};
use agaric_lib::commands::{CreateBlockSpec, create_block_inner, create_blocks_batch_inner};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_store::space::SpaceId;
use agaric_sync::sync_protocol::loro_sync::{ApplyOutcome, apply_remote};
use agaric_sync::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};
use criterion::{BenchmarkId, Criterion, SamplingMode, criterion_group};
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

use crate::loro_snapshot_bench::{Samples, report};

const GROUP: &str = "pulled_vault_bench";
/// The device that receives the space; A's is the shared fixture's `DEV`.
const DEVICE_B: &str = "01PULLEDVAULTBENCHDEVICEB1";
/// Children of the page the writes land on, and of the filler page: about 3K
/// blocks in all.
const PAGE_CHILDREN: usize = 1_100;
const FILLER_CHILDREN: usize = 1_900;
/// `MAX_BATCH_BLOCK_IDS` caps one batch at 1000.
const SEED_BATCH: usize = 1_000;
/// Lines of the paste #6811 times.
const PASTE_BLOCKS: usize = 300;
const SAMPLE_SIZE: usize = 10;

struct Vault {
    pool: SqlitePool,
    mat: Materializer,
    device: &'static str,
    /// The page the writes land on.
    page: String,
    _dir: TempDir,
}

fn spec(parent: &str, content: String) -> CreateBlockSpec {
    CreateBlockSpec {
        block_type: "content".into(),
        content,
        parent_id: Some(parent.to_owned().into()),
        parent_index: None,
        block_id: None,
        position: None,
        properties: std::collections::HashMap::new(),
        typed_properties: std::collections::HashMap::new(),
    }
}

async fn append_children(vault: &Vault, parent: &str, count: usize, batch: usize) {
    let mut left = count;
    while left > 0 {
        let take = left.min(batch);
        let specs = (0..take)
            .map(|i| spec(parent, format!("lorem ipsum {i}")))
            .collect();
        create_blocks_batch_inner(&vault.pool, vault.device, &vault.mat, specs)
            .await
            .expect("append children");
        left -= take;
    }
}

/// A's vault: the space, the big page and the filler page, all written by
/// commands.
async fn app_written_vault() -> Vault {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("a.db")).await.unwrap();
    let mat = Materializer::new(pool.clone());
    let page = space_page(&pool, &mat).await.into_string();
    let filler = agaric_lib::commands::create_page_in_space_inner(
        &pool,
        DEV,
        &mat,
        None,
        "Filler".into(),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap()
    .into_string();
    let vault = Vault {
        pool,
        mat,
        device: DEV,
        page,
        _dir: dir,
    };
    append_children(&vault, &vault.page, PAGE_CHILDREN, SEED_BATCH).await;
    append_children(&vault, &filler, FILLER_CHILDREN, SEED_BATCH).await;
    vault
}

fn export_space(vault: &Vault) -> Vec<u8> {
    vault
        .mat
        .loro_state()
        .registry
        .with_engine(&SpaceId::from_trusted(TEST_SPACE_ID), vault.device, |e| {
            LoroEngine::export_snapshot(e)
        })
        .expect("engine")
        .expect("export snapshot")
}

/// B's vault: empty, then the first sync of A's space.
async fn pulled_vault(snapshot: Vec<u8>, page: &str) -> Vault {
    let dir = TempDir::new().unwrap();
    let pool = init_pool(&dir.path().join("b.db")).await.unwrap();
    let mat = Materializer::new(pool.clone());
    // The space block is SQL-only on A's side, so it is not in the snapshot.
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    let msg = LoroSyncMessage::Snapshot {
        protocol_version: LORO_SYNC_PROTOCOL_VERSION,
        space_id: SpaceId::from_trusted(TEST_SPACE_ID),
        bytes: snapshot,
    };
    let outcome = apply_remote(&pool, &mat.loro_state().registry, DEVICE_B, msg)
        .await
        .expect("apply_remote");
    assert!(
        matches!(outcome, ApplyOutcome::Imported { .. }),
        "the snapshot imports, got {outcome:?}"
    );
    // The materializer stamps `space_id` after a sync; the bench has none.
    assign_all_to_test_space(&pool).await;
    Vault {
        pool,
        mat,
        device: DEVICE_B,
        page: page.to_owned(),
        _dir: dir,
    }
}

async fn live_children(vault: &Vault) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE parent_id = ? AND deleted_at IS NULL")
        .bind(&vault.page)
        .fetch_one(&vault.pool)
        .await
        .unwrap()
}

async fn split(vault: &Vault) {
    let children = live_children(vault).await;
    create_block_inner(
        &vault.pool,
        vault.device,
        &vault.mat,
        "content".into(),
        String::new(),
        Some(vault.page.clone().into()),
        Some(children / 2),
    )
    .await
    .expect("split");
}

async fn paste(vault: &Vault) {
    let specs = (0..PASTE_BLOCKS)
        .map(|i| spec(&vault.page, format!("pasted line {i}")))
        .collect();
    create_blocks_batch_inner(&vault.pool, vault.device, &vault.mat, specs)
        .await
        .expect("paste");
}

/// Both arms' timings of one write, the arms alternating within each call.
fn bench_write<'a, F>(
    group: &mut criterion::BenchmarkGroup<'_, criterion::measurement::WallTime>,
    rt: &'a Runtime,
    name: &str,
    app: &'a Vault,
    pulled: &'a Vault,
    write: impl Fn(&'a Vault) -> F + 'a,
) -> (Samples, Samples)
where
    F: std::future::Future<Output = ()> + 'a,
{
    let (app_samples, pulled_samples) = (Samples::default(), Samples::default());
    let (a, p) = (app_samples.clone(), pulled_samples.clone());
    group.bench_function(BenchmarkId::from_parameter(name), move |b| {
        b.iter_custom(|iters| {
            let mut total = Duration::ZERO;
            for _ in 0..iters {
                for (vault, samples) in [(app, &a), (pulled, &p)] {
                    let start = Instant::now();
                    rt.block_on(write(vault));
                    let elapsed = start.elapsed();
                    samples.record(elapsed);
                    total += elapsed;
                }
            }
            total
        });
    });
    (app_samples, pulled_samples)
}

fn bench_pulled_vault(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let app = rt.block_on(app_written_vault());
    let snapshot = export_space(&app);
    let pulled = rt.block_on(pulled_vault(snapshot, &app.page));

    // Shape probe: both vaults hold the same page, and the pulled engine holds
    // every block A wrote.
    let (app_children, pulled_children) =
        rt.block_on(async { (live_children(&app).await, live_children(&pulled).await) });
    let seeded = i64::try_from(PAGE_CHILDREN).unwrap();
    assert_eq!(app_children, seeded);
    assert_eq!(pulled_children, seeded);

    let mut group = c.benchmark_group("pulled_vault");
    group.sample_size(SAMPLE_SIZE);
    group.sampling_mode(SamplingMode::Flat);
    let (app_split, pulled_split) = bench_write(&mut group, &rt, "split", &app, &pulled, split);
    let (app_paste, pulled_paste) = bench_write(&mut group, &rt, "paste", &app, &pulled, paste);
    group.finish();

    for (write, app_samples, pulled_samples) in [
        ("split", &app_split, &pulled_split),
        ("paste", &app_paste, &pulled_paste),
    ] {
        report(GROUP, write, "app-written", app_samples);
        report(GROUP, write, "pulled", pulled_samples);
        if let Some((median, min, max)) = app_samples.ratio_to(pulled_samples) {
            println!(
                "{GROUP}: {write} pulled / app-written = median {median:.2} [{min:.2} – {max:.2}]"
            );
        }
    }

    // Durable growth, after the timed loops: every write each arm made is a
    // live child of the page.
    for (vault, splits, pastes) in [
        (&app, &app_split, &app_paste),
        (&pulled, &pulled_split, &pulled_paste),
    ] {
        let made = splits.count() + PASTE_BLOCKS * pastes.count();
        let expected = i64::try_from(PAGE_CHILDREN + made).unwrap();
        assert_eq!(rt.block_on(live_children(vault)), expected);
    }

    app.mat.shutdown();
    pulled.mat.shutdown();
}

criterion_group!(benches, bench_pulled_vault);
