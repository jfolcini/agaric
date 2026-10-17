//! #5707 — the boot rehydrate's two halves at 10K and 100K blocks.
//!
//! Boot rehydrate (`rehydrate_registry`) imports each space's snapshot, then
//! rebuilds that engine's `block_id → TreeID` index; `scripts/measure-boot.mjs`
//! reports the two as separate steps. This group times the same two calls on
//! one space's doc of `n` blocks (a page per 100 blocks, built through the
//! engine's write path) so a regression in either shows here first.
//!
//! Every sample starts from a fresh engine: Loro decodes imported state lazily,
//! so a second walk of the same doc would skip the decode the boot pays.
//! `index_rebuild` ends with one block read, the work boot replay does next,
//! so deferring the walk past the rehydrate cannot read as a win.

use std::hint::black_box;

use agaric_engine::loro::engine::LoroEngine;
use criterion::{BatchSize, BenchmarkId, Criterion, SamplingMode, criterion_group};

/// Device id the fixture is written and re-imported under, as at boot.
const BENCH_DEVICE: &str = "01REHYDRATEBENCHDEVICE0001";
/// One page per this many blocks; the rest are its children.
const BLOCKS_PER_PAGE: usize = 100;
const SCALES: &[usize] = &[10_000, 100_000];
/// Each 100K sample imports or walks the whole doc, so keep the count low.
const SAMPLE_SIZE: usize = 10;

fn block_id(i: usize) -> String {
    format!("01REHYDRATEBENCH{i:010}")
}

/// The snapshot of a doc holding `n` blocks, and their ids.
fn seed_snapshot(n: usize) -> (Vec<u8>, Vec<String>) {
    let mut engine = LoroEngine::with_peer_id(BENCH_DEVICE).expect("engine");
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
    (engine.export_snapshot().expect("export snapshot"), ids)
}

fn fresh_engine() -> LoroEngine {
    LoroEngine::with_peer_id(BENCH_DEVICE).expect("engine")
}

fn imported(snapshot: &[u8]) -> LoroEngine {
    let mut engine = fresh_engine();
    engine.import_deferring_index(snapshot).expect("import");
    engine
}

fn bench_rehydrate(c: &mut Criterion) {
    for &n in SCALES {
        let (snapshot, ids) = seed_snapshot(n);
        let read_id = ids[n / 2].clone();

        // Shape probe: the rebuilt index resolves every seeded block.
        let mut probe = imported(&snapshot);
        probe.rebuild_index_after_import();
        let indexed = ids.iter().filter(|id| probe.contains_block(id)).count();
        assert_eq!(indexed, n, "the rebuilt index holds every seeded block");
        drop(probe);

        let mut group = c.benchmark_group("rehydrate");
        group.sample_size(SAMPLE_SIZE);
        group.sampling_mode(SamplingMode::Flat);
        group.bench_with_input(
            BenchmarkId::new("snapshot_import", n),
            &snapshot,
            |b, snapshot| {
                b.iter_batched(
                    fresh_engine,
                    |mut engine| {
                        black_box(engine.import_deferring_index(snapshot).expect("import"));
                        engine
                    },
                    BatchSize::PerIteration,
                );
            },
        );
        group.bench_with_input(
            BenchmarkId::new("index_rebuild", n),
            &snapshot,
            |b, snapshot| {
                b.iter_batched(
                    || imported(snapshot),
                    |mut engine| {
                        engine.rebuild_index_after_import();
                        black_box(engine.read_block(&read_id).expect("read"));
                        engine
                    },
                    BatchSize::PerIteration,
                );
            },
        );
        group.finish();
    }
}

criterion_group!(benches, bench_rehydrate);
