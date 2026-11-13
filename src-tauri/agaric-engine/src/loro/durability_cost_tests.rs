//! #6521 — what each way of making engine state durable costs, measured on
//! one space of `n` blocks whose every block was edited `m` times.
//!
//! Three designs are compared:
//!
//! - the snapshot pass in use: `export_snapshot` of the whole space, written
//!   as one `loro_doc_state` row;
//! - a delta per write: `export_update_since` of the op just applied, written
//!   as one small blob row in the op's own transaction;
//! - a kept sync blob: the update a session brought stays in `loro_sync_inbox`
//!   until a snapshot covers it.
//!
//! The delta row is written to `loro_sync_inbox`, the one table that already
//! takes a Loro blob beside a space id, so the harness needs no table of its
//! own. Every timing prints as `durability_cost: <case> @ <n>x<m> = median
//! [min–max]`. Nothing is budgeted; the assertions are on what a rebuilt
//! engine holds.
//!
//! ```sh
//! DURABILITY_COST_FULL=1 CARGO_PROFILE_RELEASE_LTO=off \
//!   CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 cargo test --release \
//!   -p agaric-engine --lib durability_cost -- --ignored --nocapture
//! ```
//!
//! Without `DURABILITY_COST_FULL` it runs at 1K blocks, which is what the
//! weekly `--run-ignored=only` sweep can afford in a debug build.

use std::time::{Duration, Instant};

use super::engine::{LoroEngine, PropertyValue};

const DEVICE: &str = "durability-cost-device";
const SPACE: &str = "01DURABILITYCOSTSPACE00001";
/// One page per this many blocks, as `loro_snapshot_bench` seeds.
const BLOCKS_PER_PAGE: usize = 100;
const EDIT: &str = "word ";
const SAMPLES: usize = 15;
/// Deltas a boot would import after a snapshot.
const TAIL: usize = 1_000;

fn block_id(i: usize) -> String {
    format!("01DURABILITYCOST{i:010}")
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
    if engine.import_deferring_index(snapshot).expect("import") {
        engine.rebuild_index_after_import();
    }
    engine
}

struct Timings(Vec<Duration>);

impl Timings {
    fn of(samples: usize, mut run: impl FnMut() -> Duration) -> Self {
        let mut all: Vec<Duration> = (0..samples).map(|_| run()).collect();
        all.sort();
        Self(all)
    }

    fn report(&self, case: &str, scale: &str, detail: &str) {
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        println!(
            "durability_cost: {case} @ {scale} = {:.3} ms [{:.3}–{:.3}]{detail}",
            ms(self.0[self.0.len() / 2]),
            ms(self.0[0]),
            ms(self.0[self.0.len() - 1]),
        );
    }
}

fn timed<T>(run: impl FnOnce() -> T) -> (T, Duration) {
    let start = Instant::now();
    let out = run();
    (out, start.elapsed())
}

/// One snapshot pass over the space: the export and the row.
async fn snapshot_pass(pool: &sqlx::SqlitePool, engine: &LoroEngine, scale: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    Timings::of(SAMPLES, || {
        let (out, took) = timed(|| engine.export_snapshot().expect("export"));
        bytes = out;
        took
    })
    .report(
        "snapshot export",
        scale,
        &format!(", {} bytes", bytes.len()),
    );

    let mut writes = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let blob = bytes.clone();
        let start = Instant::now();
        sqlx::query(
            "INSERT OR REPLACE INTO loro_doc_state \
             (space_id, snapshot, updated_at, op_count, applied_through_seq) VALUES (?, ?, 0, 0, 0)",
        )
        .bind(SPACE)
        .bind(blob)
        .execute(pool)
        .await
        .expect("write the snapshot row");
        writes.push(start.elapsed());
    }
    writes.sort();
    Timings(writes).report("snapshot row write", scale, "");
    bytes
}

/// What `op` adds to the export: the version vector before it and the update
/// since, timed together.
fn delta_export(
    engine: &mut LoroEngine,
    name: &str,
    scale: &str,
    mut op: impl FnMut(&mut LoroEngine),
) {
    let mut bytes = 0usize;
    Timings::of(SAMPLES, || {
        let (since, vv_took) = timed(|| engine.version_vector());
        op(engine);
        let (delta, export_took) = timed(|| engine.export_update_since(&since).expect("delta"));
        bytes = delta.len();
        vv_took + export_took
    })
    .report(
        &format!("delta export, {name}"),
        scale,
        &format!(", {bytes} bytes"),
    );
}

/// A delta per write: what one op adds to the export, and to its transaction.
async fn delta_per_write(
    pool: &sqlx::SqlitePool,
    engine: &mut LoroEngine,
    ids: &[String],
    scale: &str,
) {
    let target = &ids[ids.len() / 2 + 1];
    let page = &ids[ids.len() / 2];
    delta_export(engine, "edit", scale, |e| type_a_word(e, target));
    let mut created = 0usize;
    delta_export(engine, "create", scale, |e| {
        created += 1;
        let id = format!("01DURABILITYNEW{created:011}");
        e.apply_create_block_at(&id, "content", "a new block", Some(page), 0)
            .expect("create");
    });
    let mut effort = 0usize;
    delta_export(engine, "set property", scale, |e| {
        effort += 1;
        e.apply_set_property_typed(target, "effort", &PropertyValue::Str(effort.to_string()))
            .expect("set property");
    });

    let since = engine.version_vector();
    type_a_word(engine, &ids[ids.len() / 2 + 1]);
    let delta = engine.export_update_since(&since).expect("delta");
    let mut tx = pool.begin().await.expect("begin");
    let mut writes = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let start = Instant::now();
        sqlx::query("INSERT INTO loro_sync_inbox (space_id, bytes, created_at) VALUES (?, ?, 0)")
            .bind(SPACE)
            .bind(delta.as_slice())
            .execute(&mut *tx)
            .await
            .expect("write the delta row");
        writes.push(start.elapsed());
    }
    tx.rollback().await.expect("rollback");
    writes.sort();
    Timings(writes).report("delta row write, in an open transaction", scale, "");
}

/// Boot under a delta per write: the snapshot, then `TAIL` deltas, against the
/// same tail re-applied op by op as boot replay does today. Returns the tail
/// as the one update a sync session would have delivered.
fn boot_with_a_tail(snapshot: &[u8], ids: &[String], scale: &str) -> Vec<u8> {
    let mut live = rehydrate(snapshot);
    let before = live.version_vector();
    let mut deltas = Vec::with_capacity(TAIL);
    let mut texts = Vec::with_capacity(TAIL);
    for i in 0..TAIL {
        let id = &ids[(i * 7 + 1) % ids.len()];
        let since = live.version_vector();
        type_a_word(&mut live, id);
        deltas.push(live.export_update_since(&since).expect("delta"));
        texts.push((
            id.clone(),
            live.read_block(id).expect("read").expect("block").content,
        ));
    }
    let delta_bytes: usize = deltas.iter().map(Vec::len).sum();
    let session = live.export_update_since(&before).expect("session update");

    let mut rebuilt = None;
    Timings::of(5, || {
        let (engine, took) = timed(|| {
            let mut engine = LoroEngine::with_peer_id(DEVICE).expect("engine");
            engine.import_deferring_index(snapshot).expect("import");
            for delta in &deltas {
                engine.import_deferring_index(delta).expect("import delta");
            }
            engine.rebuild_index_after_import();
            engine
        });
        rebuilt = Some(engine);
        took
    })
    .report(
        &format!("boot: snapshot + {TAIL} deltas"),
        scale,
        &format!(", {delta_bytes} delta bytes"),
    );
    let rebuilt = rebuilt.expect("one sample ran");
    assert_eq!(
        rebuilt.version_vector(),
        live.version_vector(),
        "the snapshot and its deltas rebuild the engine's whole history"
    );
    for (id, text) in texts.iter().rev().take(10) {
        assert_eq!(
            &rebuilt
                .read_block(id)
                .expect("read")
                .expect("block")
                .content,
            text
        );
    }

    Timings::of(5, || {
        timed(|| {
            let mut engine = rehydrate(snapshot);
            for (id, text) in &texts {
                engine.apply_edit_via_diff_splice(id, text).expect("replay");
            }
        })
        .1
    })
    .report(
        &format!("boot: snapshot + {TAIL} replayed edits (engine only)"),
        scale,
        "",
    );

    Timings::of(5, || timed(|| rehydrate(snapshot)).1).report("boot: snapshot alone", scale, "");
    session
}

/// A kept sync blob: the bytes one session's update holds, and its import at
/// boot into the engine the last snapshot rebuilt.
fn kept_sync_blob(snapshot: &[u8], session: &[u8], scale: &str) {
    Timings::of(5, || {
        let mut engine = rehydrate(snapshot);
        timed(|| engine.import(session).expect("import the kept blob")).1
    })
    .report(
        &format!("boot: import one kept blob of {TAIL} edits"),
        scale,
        &format!(", {} bytes", session.len()),
    );
}

async fn measure(n: usize, rounds: usize) {
    let scale = format!("{n}x{rounds}");
    let (pool, _dir) = agaric_store::test_support::test_pool().await;
    let (mut engine, ids) = seed(n, rounds);

    let snapshot = snapshot_pass(&pool, &engine, &scale).await;
    delta_per_write(&pool, &mut engine, &ids, &scale).await;

    // The first write after a boot, on a doc whose containers are not decoded.
    let mut cold = rehydrate(&snapshot);
    let (since, vv_took) = timed(|| cold.version_vector());
    type_a_word(&mut cold, &ids[ids.len() / 2 + 1]);
    let (delta, export_took) = timed(|| cold.export_update_since(&since).expect("delta"));
    println!(
        "durability_cost: delta export, first edit after a rehydrate @ {scale} = {:.3} ms, {} bytes (one sample)",
        (vv_took + export_took).as_secs_f64() * 1000.0,
        delta.len(),
    );

    let session = boot_with_a_tail(&snapshot, &ids, &scale);
    kept_sync_blob(&snapshot, &session, &scale);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "measurement harness (#6521); see the module doc for the command"]
async fn durability_cost() {
    let full = std::env::var_os("DURABILITY_COST_FULL").is_some();
    let scales: &[usize] = if full { &[10_000, 100_000] } else { &[1_000] };
    for &n in scales {
        for rounds in [0, 10] {
            measure(n, rounds).await;
        }
    }
}
