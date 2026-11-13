//! #6521 stage A — what saving a delta adds to a write, measured against the
//! same write without it, on one space of `n` blocks whose every block was
//! edited `m` times.
//!
//! Two writes are timed, each with and without its delta, the two arms
//! interleaved sample by sample:
//!
//! - one edit's transaction: `BEGIN IMMEDIATE`, the engine edit, the commit;
//!   with the delta it goes through the rollback log and
//!   [`commit_with_deltas`](super::delta::commit_with_deltas), as a command's
//!   transaction does;
//! - a sync import of one update of `TAIL` edits into a rehydrated engine;
//!   with the delta it runs under
//!   [`capturing_delta`](super::engine::LoroEngine::capturing_delta) and the
//!   row is inserted, as `import_and_project` does.
//!
//! Every timing prints as `delta_cost: <case> @ <n>x<m> = median [min–max]`.
//! Nothing is budgeted; the assertions are that the delta arm saved its row.
//!
//! ```sh
//! DELTA_COST_FULL=1 CARGO_PROFILE_RELEASE_LTO=off \
//!   CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 cargo test --release \
//!   -p agaric-engine --lib delta_cost -- --ignored --nocapture
//! ```
//!
//! Without `DELTA_COST_FULL` it runs at 1K blocks, which is what the weekly
//! `--run-ignored=only` sweep can afford in a debug build.

use std::time::{Duration, Instant};

use sqlx::SqlitePool;

use super::engine::LoroEngine;
use super::revert::RevertScope;
use super::shared::LoroState;
use agaric_store::space::SpaceId;

const DEVICE: &str = "delta-cost-device";
const PEER: &str = "delta-cost-peer";
const SPACE: &str = "01DELTACOSTSPACE0000000001";
const BLOCKS_PER_PAGE: usize = 100;
const EDIT: &str = "word ";
const SAMPLES: usize = 15;
/// Edits in the imported update.
const TAIL: usize = 1_000;

fn block_id(i: usize) -> String {
    format!("01DELTACOSTBLOCK{i:010}")
}

fn seed(n: usize, rounds: usize) -> (LoroEngine, Vec<String>) {
    let mut engine = LoroEngine::with_peer_id(DEVICE).expect("engine");
    let ids: Vec<String> = (0..n).map(block_id).collect();
    for (i, id) in ids.iter().enumerate() {
        let slot = i % BLOCKS_PER_PAGE;
        if slot == 0 {
            engine
                .apply_create_block_at(id, "page", "page", None, i / BLOCKS_PER_PAGE)
                .expect("seed page");
        } else {
            engine
                .apply_create_block_at(
                    id,
                    "content",
                    "block content",
                    Some(&ids[i - slot]),
                    slot - 1,
                )
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

/// The edit a typed word makes, through the path a local `edit_block` takes.
fn type_a_word(engine: &mut LoroEngine, id: &str) {
    let text = engine.read_block(id).expect("read").expect("block").content;
    engine
        .apply_edit_via_diff_splice(id, &format!("{EDIT}{text}"))
        .expect("edit");
}

fn rehydrate(snapshot: &[u8]) -> LoroEngine {
    let mut engine = LoroEngine::with_peer_id(DEVICE).expect("engine");
    engine.import(snapshot).expect("import");
    engine
}

fn report(case: &str, scale: &str, mut samples: Vec<Duration>, detail: &str) {
    samples.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    println!(
        "delta_cost: {case} @ {scale} = {:.3} ms [{:.3}–{:.3}]{detail}",
        ms(samples[samples.len() / 2]),
        ms(samples[0]),
        ms(samples[samples.len() - 1]),
    );
}

async fn delta_rows(pool: &SqlitePool) -> (i64, i64) {
    sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(LENGTH(bytes)), 0) FROM loro_doc_delta")
        .fetch_one(pool)
        .await
        .expect("count the deltas")
}

/// One edit's transaction, without its delta and with it.
async fn one_edit(pool: &SqlitePool, state: &LoroState, target: &str, scale: &str) {
    let space = SpaceId::from_trusted(SPACE);
    let mut without = Vec::with_capacity(SAMPLES);
    let mut with = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        let tx = agaric_store::db::begin_immediate_logged(pool, "delta_cost")
            .await
            .expect("begin");
        type_a_word(
            state
                .registry
                .for_space(&space, DEVICE)
                .expect("engine")
                .engine_mut(),
            target,
        );
        tx.commit().await.expect("commit");
        without.push(start.elapsed());

        let start = Instant::now();
        let tx = agaric_store::db::begin_immediate_logged(pool, "delta_cost")
            .await
            .expect("begin");
        let scope = RevertScope::arm(state);
        type_a_word(
            state
                .registry
                .for_space_recording(&space, DEVICE, &state.revert)
                .expect("engine")
                .engine_mut(),
            target,
        );
        super::delta::commit_with_deltas(tx, &state.registry, scope.detach())
            .await
            .expect("commit");
        with.push(start.elapsed());
    }
    let (rows, bytes) = delta_rows(pool).await;
    assert_eq!(rows, SAMPLES as i64, "each edit with a delta saved one row");
    report("one edit, no delta", scale, without, "");
    report(
        "one edit, with its delta",
        scale,
        with,
        &format!(", {} bytes a row", bytes / rows),
    );
}

/// One update of `TAIL` edits imported into the engine `snapshot` rebuilds,
/// without its delta and with it.
async fn one_import(pool: &SqlitePool, snapshot: &[u8], ids: &[String], scale: &str) {
    let mut peer = LoroEngine::with_peer_id(PEER).expect("peer");
    peer.import(snapshot).expect("peer import");
    let since = peer.version_vector();
    for i in 0..TAIL {
        type_a_word(&mut peer, &ids[(i * 7 + 1) % ids.len()]);
    }
    let update = peer.export_update_since(&since).expect("update");
    let space = SpaceId::from_trusted(SPACE);
    let (rows_before, bytes_before) = delta_rows(pool).await;

    let mut without = Vec::with_capacity(5);
    let mut with = Vec::with_capacity(5);
    for _ in 0..5 {
        let mut engine = rehydrate(snapshot);
        let start = Instant::now();
        engine
            .import_with_changed_purged_tagscope(&update)
            .expect("import");
        without.push(start.elapsed());

        let mut engine = rehydrate(snapshot);
        let start = Instant::now();
        let (_, delta) = engine
            .capturing_delta(|engine| engine.import_with_changed_purged_tagscope(&update))
            .expect("import");
        let delta = delta.expect("the import added ops");
        let mut tx = agaric_store::db::begin_immediate_logged(pool, "delta_cost")
            .await
            .expect("begin");
        super::delta::insert_delta(&mut tx, &space, &delta)
            .await
            .expect("save the delta");
        tx.commit().await.expect("commit");
        with.push(start.elapsed());
    }
    let (rows, bytes) = delta_rows(pool).await;
    assert_eq!(
        rows - rows_before,
        5,
        "each import with a delta saved one row"
    );
    report(
        &format!("import of {TAIL} edits, no delta"),
        scale,
        without,
        &format!(", {} bytes inbound", update.len()),
    );
    report(
        &format!("import of {TAIL} edits, with its delta"),
        scale,
        with,
        &format!(", {} bytes a row", (bytes - bytes_before) / 5),
    );
}

async fn measure(n: usize, rounds: usize) {
    let scale = format!("{n}x{rounds}");
    let (pool, _dir) = agaric_store::test_support::test_pool().await;
    let (engine, ids) = seed(n, rounds);
    let snapshot = engine.export_snapshot().expect("snapshot");
    let state = LoroState::new();
    state
        .registry
        .install_engine(SpaceId::from_trusted(SPACE), engine);

    one_edit(&pool, &state, &ids[ids.len() / 2 + 1], &scale).await;
    one_import(&pool, &snapshot, &ids, &scale).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "measurement harness (#6521); see the module doc for the command"]
async fn delta_cost() {
    let full = std::env::var_os("DELTA_COST_FULL").is_some();
    let scales: &[usize] = if full { &[10_000, 100_000] } else { &[1_000] };
    for &n in scales {
        measure(n, 10).await;
    }
}
