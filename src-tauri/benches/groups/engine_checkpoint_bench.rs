// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]
#![allow(clippy::cast_precision_loss)]

//! #2604 — per-op checkpoint / fork overhead for the rollback-safe engine apply.
//!
//! ## What this answers
//!
//! #2604 proposes making the in-memory Loro engine apply
//! transactional-by-construction: stage each op against a checkpoint / **fork**
//! of the per-space `LoroDoc`, and PROMOTE it to the canonical engine only after
//! SQL COMMIT succeeds (DISCARD on abort). Its gating design question is the
//! per-op cost of that checkpoint: `LoroDoc::fork` is documented `O(n)` in time
//! and space, so a fork PER op could blow the interactive SLO
//! (`docs/architecture/operations.md` § Product SLO — interactive commands
//! ≤ 200 ms p95 @ 100K). This bench measures that cost at 100 / 1K / 10K / 100K
//! blocks so the mechanism (full-fork promote vs. a lighter capture-delta /
//! replay-inverse scheme) can be chosen from data BEFORE the write-path surgery
//! lands. It is the Acceptance item "bench at 100/1K/10K/100K".
//!
//! ## The four measurements (all operate on THROWAWAY forks so the fixture is
//! immutable and iterations are independent)
//!
//! - **`fork_only`** — `engine.fork_staging()` alone: the `O(n)` fork tax a
//!   lighter checkpoint scheme would avoid.
//! - **`stage_op`** — fork + apply one `CreateBlock` on the fork + export the
//!   promotable delta (`export_update_since`): the FULL added pre-commit latency
//!   of the full-fork staging scheme, i.e. what lands on the interactive path.
//! - **`promote_import`** — fork + import a precomputed 1-op delta: subtract
//!   `fork_only` to read the post-commit promote (`import`) cost.
//! - **`snapshot_export`** — `engine.export_snapshot()`: the per-op cost of the
//!   naive "capture a full restore point per op" discard mechanism, for
//!   reference (why per-op snapshotting is a non-starter at scale).
//!
//! ## Scales & running
//!
//! The 10K / 100K scales are gated behind `ENGINE_CHECKPOINT_FULL=1` so the CI
//! `--test` fixture-smoke gate (which runs every bench once) stays cheap — the
//! default / `--test` run builds only the 100 and 1K fixtures. To reproduce the
//! full table:
//!
//! ```text
//! ENGINE_CHECKPOINT_FULL=1 cargo bench --bench engine_checkpoint_bench
//! ```
//!
//! This is a MEASUREMENT bench (no timing budget / `assert`) — it reports
//! per-op numbers for the #2604 design note; it does not gate CI on a threshold.

use std::cell::Cell;
use std::hint::black_box;
use std::rc::Rc;
use std::time::{Duration, Instant};

use agaric_engine::loro::engine::LoroEngine;
use criterion::{Criterion, criterion_group};

/// Device id whose deterministic peer id every fixture engine is built under.
const BENCH_DEVICE: &str = "01ENGINECHECKPOINTBENCHDEV1";
/// Page the fixture blocks hang under (so creates take the parented path).
const PAGE_ID: &str = "01ENGINECHECKPOINTBENCHPAGE";

/// Block scales the bench builds fixtures at. 10K / 100K are gated (see below).
const SMALL_SCALES: &[usize] = &[100, 1_000];
const LARGE_SCALES: &[usize] = &[10_000, 100_000];

/// Sample count per measurement — kept low (like `interactive_slo`) so the
/// 100K fork/apply cycles finish in seconds, not minutes.
const SAMPLE_SIZE: usize = 10;

// ---------------------------------------------------------------------------
// Elapsed accumulator (mirrors `interactive_slo::Acc`) — Criterion calls the
// closure once per sample, so the closure move-captures a clone each call.
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
struct Acc {
    total: Rc<Cell<Duration>>,
    iters: Rc<Cell<u64>>,
}

impl Acc {
    fn new() -> Self {
        Self {
            total: Rc::new(Cell::new(Duration::ZERO)),
            iters: Rc::new(Cell::new(0)),
        }
    }
    fn record(&self, elapsed: Duration, iters: u64) {
        self.total.set(self.total.get() + elapsed);
        self.iters.set(self.iters.get() + iters);
    }
    fn per_op_us(&self) -> f64 {
        let iters = self.iters.get();
        if iters == 0 {
            return f64::NAN;
        }
        (self.total.get().as_secs_f64() * 1_000_000.0) / iters as f64
    }
}

/// Print a grep-stable per-op line so the numbers can be pulled from CI logs
/// or a local run into the #2604 design note.
fn report(label: &str, n: usize, acc: &Acc) {
    println!(
        "engine_checkpoint: {label} @ {n} blocks = {:.2} µs/op",
        acc.per_op_us()
    );
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// Build a canonical engine of `n` blocks: one page plus `n - 1` content
/// children under it, all applied through the real engine op path so the doc
/// has a realistic op history (fork cost tracks history + state size).
fn build_engine(n: usize) -> LoroEngine {
    let mut engine = LoroEngine::with_peer_id(BENCH_DEVICE).expect("engine");
    engine
        .apply_create_block(PAGE_ID, "page", "bench page", None, 0)
        .expect("seed page");
    for i in 1..n {
        let id = format!("BENCHBLK{i:018}");
        engine
            .apply_create_block(&id, "content", "bench content", Some(PAGE_ID), i as i64)
            .expect("seed content");
    }
    engine
}

/// The next block id a `stage_op` iteration creates on its throwaway fork.
/// Always the same id (each iteration is an independent fork), so the doc's op
/// history is what varies with `n`, not the id.
fn staged_block_id() -> String {
    "BENCHSTAGEDBLOCK0000000001".to_string()
}

/// Precompute a 1-op delta (a single `CreateBlock` promoted since the canonical
/// frontier) so `promote_import` can time the import alone, not delta building.
fn one_op_delta(engine: &LoroEngine, checkpoint_vv: &[u8]) -> Vec<u8> {
    let mut staging = engine.fork_staging().expect("fork_staging");
    staging
        .apply_create_block(&staged_block_id(), "content", "staged", Some(PAGE_ID), 1)
        .expect("stage create");
    staging
        .export_update_since(checkpoint_vv)
        .expect("export delta")
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

fn scales() -> Vec<usize> {
    let mut v = SMALL_SCALES.to_vec();
    if std::env::var("ENGINE_CHECKPOINT_FULL").is_ok() {
        v.extend_from_slice(LARGE_SCALES);
    } else {
        println!(
            "engine_checkpoint: 10K/100K scales SKIPPED (set ENGINE_CHECKPOINT_FULL=1 to run \
             the full #2604 table)"
        );
    }
    v
}

fn bench_engine_checkpoint(c: &mut Criterion) {
    for &n in &scales() {
        let engine = build_engine(n);
        let checkpoint_vv = engine.version_vector();
        let delta = one_op_delta(&engine, &checkpoint_vv);

        let mut group = c.benchmark_group("engine_checkpoint");
        group.sample_size(SAMPLE_SIZE);

        // (1) fork_only — the O(n) fork tax.
        {
            let acc = Acc::new();
            let acc_bench = acc.clone();
            let engine_ref = &engine;
            group.bench_function(format!("fork_only_{n}"), |b| {
                let acc = acc_bench.clone();
                b.iter_custom(|iters| {
                    let start = Instant::now();
                    for _ in 0..iters {
                        let staged = engine_ref.fork_staging().expect("fork_staging");
                        black_box(&staged);
                    }
                    let elapsed = start.elapsed();
                    acc.record(elapsed, iters);
                    elapsed
                });
            });
            report("fork_only", n, &acc);
        }

        // (2) stage_op — fork + apply + export delta (full pre-commit overhead).
        {
            let acc = Acc::new();
            let acc_bench = acc.clone();
            let engine_ref = &engine;
            let vv = checkpoint_vv.clone();
            group.bench_function(format!("stage_op_{n}"), |b| {
                let acc = acc_bench.clone();
                let vv = vv.clone();
                b.iter_custom(move |iters| {
                    let start = Instant::now();
                    for _ in 0..iters {
                        let mut staged = engine_ref.fork_staging().expect("fork_staging");
                        staged
                            .apply_create_block(
                                &staged_block_id(),
                                "content",
                                "staged",
                                Some(PAGE_ID),
                                1,
                            )
                            .expect("stage create");
                        let delta = staged.export_update_since(&vv).expect("export delta");
                        black_box(&delta);
                    }
                    let elapsed = start.elapsed();
                    acc.record(elapsed, iters);
                    elapsed
                });
            });
            report("stage_op", n, &acc);
        }

        // (3) promote_import — fork + import a 1-op delta (subtract fork_only for
        //     the import cost). Import mutates, so each iteration imports into a
        //     fresh throwaway fork of the canonical engine.
        {
            let acc = Acc::new();
            let acc_bench = acc.clone();
            let engine_ref = &engine;
            let delta_ref = delta.clone();
            group.bench_function(format!("promote_import_{n}"), |b| {
                let acc = acc_bench.clone();
                let delta = delta_ref.clone();
                b.iter_custom(move |iters| {
                    let start = Instant::now();
                    for _ in 0..iters {
                        let mut target = engine_ref.fork_staging().expect("fork_staging");
                        target.import(&delta).expect("promote import");
                        black_box(&target);
                    }
                    let elapsed = start.elapsed();
                    acc.record(elapsed, iters);
                    elapsed
                });
            });
            report("promote_import", n, &acc);
        }

        // (4) snapshot_export — the naive per-op "full restore point" discard cost.
        {
            let acc = Acc::new();
            let acc_bench = acc.clone();
            let engine_ref = &engine;
            group.bench_function(format!("snapshot_export_{n}"), |b| {
                let acc = acc_bench.clone();
                b.iter_custom(|iters| {
                    let start = Instant::now();
                    for _ in 0..iters {
                        let snap = engine_ref.export_snapshot().expect("export snapshot");
                        black_box(&snap);
                    }
                    let elapsed = start.elapsed();
                    acc.record(elapsed, iters);
                    elapsed
                });
            });
            report("snapshot_export", n, &acc);
        }

        group.finish();
    }
}

criterion_group!(benches, bench_engine_checkpoint);
