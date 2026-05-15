// Bench helpers cast small loop indices between usize/i64 freely.
#![allow(clippy::cast_possible_wrap)]

//! Criterion benchmarks for history + undo/redo commands at scale.
//!
//! Phase 2 §B.1 of `pending/scale-benchmarks-100k-2026-05-14.md`.
//!
//! Covers the four user-facing history Tauri commands at scale, none of
//! which have a direct bench today (the existing `undo_redo.rs` measures
//! `compute_reverse` — the op-log primitive — and one-off configurations
//! of these commands; it does not sweep `[1K, 10K, 100K]` ops on a single
//! page):
//!
//!   1. `list_page_history_inner` — page-scoped history pagination
//!   2. `revert_ops_inner` — batch revert of 50 ops (200 ms budget gated
//!      in `interactive_slo.rs::bench_revert_ops_50op_at_100k`)
//!   3. `undo_page_op_inner` — single page undo (depth 0)
//!   4. `redo_page_op_inner` — single page redo (after one undo)
//!
//! Each is swept over `[1_000, 10_000, 100_000]` total ops on a single
//! page. Runs via `cargo bench --bench history_bench` — standard Criterion
//! timing; no in-bench assertions. The 200 ms regression gate for the
//! 50-op revert at 100K lives in `interactive_slo.rs` (Phase 1 file)
//! per Phase 2's "each new bench gets a row in interactive_slo.rs"
//! convention.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use agaric_lib::commands::{
    list_page_history_inner, redo_page_op_inner, revert_ops_inner, undo_page_op_inner,
};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::op::OpRef;
use agaric_lib::space::SpaceScope;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BENCH_DEVICE: &str = "bench-device";

/// Op-log sweep points — single page, [1K, 10K, 100K] total ops.
const SWEEP_SIZES: [usize; 3] = [1_000, 10_000, 100_000];

// ---------------------------------------------------------------------------
// Fixture helpers — duplicated rather than extracted to a shared module
// because Cargo's `[[bench]]` layout makes cross-bench module sharing
// painful (each bench is its own crate root). Same convention as
// `interactive_slo.rs`. Pattern modelled on `undo_redo.rs::seed_flat_page`,
// but specialised to "exactly N total ops on a single page" so the sweep
// parameter is the X-axis directly.
// ---------------------------------------------------------------------------

/// Create a fresh pool in a temp dir.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Build a deterministic, valid RFC-3339 timestamp from a monotonically
/// increasing seq counter. Mirrors the `% 24` modulo in
/// `undo_redo.rs::seed_deep_page` (the flat seeder there overflows hours
/// at 100K, which we cannot tolerate at this scale).
fn ts_for(seq: i64) -> String {
    format!(
        "2025-01-15T{:02}:{:02}:{:02}.{:03}Z",
        (seq / 3600) % 24,
        (seq / 60) % 60,
        seq % 60,
        seq % 1000
    )
}

/// Seed a single page with exactly `total_ops` ops in its history.
///
/// Layout:
///   - seq=1: `create_block` for the page
///   - seq=2: `create_block` for a single child block
///   - seq=3..=total_ops: `edit_block` ops against that child block
///
/// Returns `(page_id, child_block_id, last_seq)`. `last_seq == total_ops`.
///
/// All ops use `BENCH_DEVICE` so the most-recent-50 selector in callers
/// can use the `[last_seq - 49 ..= last_seq]` range without scanning the
/// op_log.
async fn seed_single_page_history(pool: &SqlitePool, total_ops: usize) -> (String, String, i64) {
    assert!(
        total_ops >= 52,
        "seed_single_page_history needs >=52 ops (2 creates + 50-op revert window)"
    );

    let page_id = format!("PAGE{:020}", 0);
    let block_id = format!("BLK{:020}", 0);
    let mut seq: i64 = 0;

    let mut tx = pool.begin().await.unwrap();

    // 1. Page block + create_block op
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, position) \
         VALUES (?, 'page', 'Bench Page', 1)",
    )
    .bind(&page_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    seq += 1;
    let page_create_json = format!(
        r#"{{"block_id":"{page_id}","block_type":"page","parent_id":null,"position":1,"content":"Bench Page"}}"#
    );
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
         VALUES (?, ?, 'fakehash', 'create_block', ?, ?)",
    )
    .bind(BENCH_DEVICE)
    .bind(seq)
    .bind(&page_create_json)
    .bind(ts_for(seq))
    .execute(&mut *tx)
    .await
    .unwrap();

    // 2. Single child content block + create_block op
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position) \
         VALUES (?, 'content', 'initial', ?, 1)",
    )
    .bind(&block_id)
    .bind(&page_id)
    .execute(&mut *tx)
    .await
    .unwrap();

    seq += 1;
    let child_create_json = format!(
        r#"{{"block_id":"{block_id}","block_type":"content","parent_id":"{page_id}","position":1,"content":"initial"}}"#
    );
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
         VALUES (?, ?, 'fakehash', 'create_block', ?, ?)",
    )
    .bind(BENCH_DEVICE)
    .bind(seq)
    .bind(&child_create_json)
    .bind(ts_for(seq))
    .execute(&mut *tx)
    .await
    .unwrap();

    // 3. Fill remainder of the op log with edit_block ops against the
    //    single child. Each carries a unique `to_text` so `compute_reverse`
    //    won't short-circuit on identical content.
    let remaining = (total_ops as i64) - seq;
    for j in 0..remaining {
        seq += 1;
        let edit_json =
            format!(r#"{{"block_id":"{block_id}","to_text":"edit-{j}","prev_edit":null}}"#);
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at) \
             VALUES (?, ?, 'fakehash', 'edit_block', ?, ?)",
        )
        .bind(BENCH_DEVICE)
        .bind(seq)
        .bind(&edit_json)
        .bind(ts_for(seq))
        .execute(&mut *tx)
        .await
        .unwrap();
    }

    // Sync the block-row content to the most recent edit so reverse-op
    // computation has the expected current state to walk back from.
    if remaining > 0 {
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind(format!("edit-{}", remaining - 1))
            .bind(&block_id)
            .execute(&mut *tx)
            .await
            .unwrap();
    }

    tx.commit().await.unwrap();
    assert_eq!(seq, total_ops as i64);
    (page_id, block_id, seq)
}

// ===========================================================================
// Bench 1: list_page_history_inner (paginated, page size 50)
// ===========================================================================

/// `list_page_history_inner` — first paginated page of 50 history rows.
/// Sweeps [1K, 10K, 100K] ops on a single page.
fn bench_list_page_history(c: &mut Criterion) {
    let mut group = c.benchmark_group("list_page_history");

    for &total_ops in &SWEEP_SIZES {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("hist_list_{total_ops}")));
        let (page_id, _block_id, _last_seq) =
            rt.block_on(seed_single_page_history(&pool, total_ops));

        group.bench_with_input(
            BenchmarkId::from_parameter(total_ops),
            &total_ops,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let page_id = page_id.clone();
                    async move {
                        list_page_history_inner(
                            &pool,
                            page_id,
                            None,
                            &SpaceScope::Global,
                            None,
                            Some(50),
                        )
                        .await
                        .unwrap()
                    }
                })
            },
        );
    }
    group.finish();
}

// ===========================================================================
// Bench 2: revert_ops_inner — batch revert of 50 most-recent ops
// ===========================================================================

/// `revert_ops_inner` — revert the 50 most recent ops in a single batch.
/// Sweeps [1K, 10K, 100K] ops on a single page. At N=100K this is the
/// budget point that feeds `interactive_slo::bench_revert_ops_50op_at_100k`
/// (200 ms gate).
///
/// Note: `revert_ops_inner` mutates state (appends 50 reverse ops). The
/// query and reverse-computation cost dominates the write cost, so the
/// growing op log across iterations within a sample doesn't materially
/// shift the measurement.
fn bench_revert_ops_50op(c: &mut Criterion) {
    let mut group = c.benchmark_group("revert_ops_50op");

    for &total_ops in &SWEEP_SIZES {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("hist_revert_{total_ops}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let (_page_id, _block_id, last_seq) =
            rt.block_on(seed_single_page_history(&pool, total_ops));

        // Most-recent-50 ops = [last_seq - 49 .. last_seq], all edit_block
        // ops against the same child block (see `seed_single_page_history`
        // doc comment). All ops share `BENCH_DEVICE`.
        let ops: Vec<OpRef> = (0..50)
            .map(|i| OpRef {
                device_id: BENCH_DEVICE.to_string(),
                seq: last_seq - i,
            })
            .collect();

        group.bench_with_input(
            BenchmarkId::from_parameter(total_ops),
            &total_ops,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let ops = ops.clone();
                    async move {
                        revert_ops_inner(&pool, BENCH_DEVICE, materializer_ref, ops)
                            .await
                            .unwrap()
                    }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// Bench 3: undo_page_op_inner — single undo at depth 0
// ===========================================================================

/// `undo_page_op_inner` at `undo_depth=0` (most recent op). Sweeps
/// [1K, 10K, 100K] ops on a single page. Measures the recursive-CTE
/// `page_blocks` lookup + reverse-compute + transactional apply path.
fn bench_undo_page_op(c: &mut Criterion) {
    let mut group = c.benchmark_group("undo_page_op");

    for &total_ops in &SWEEP_SIZES {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("hist_undo_{total_ops}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let (page_id, _block_id, _last_seq) =
            rt.block_on(seed_single_page_history(&pool, total_ops));

        group.bench_with_input(
            BenchmarkId::from_parameter(total_ops),
            &total_ops,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let page_id = page_id.clone();
                    async move {
                        undo_page_op_inner(&pool, BENCH_DEVICE, materializer_ref, page_id, 0)
                            .await
                            .unwrap()
                    }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

// ===========================================================================
// Bench 4: redo_page_op_inner — single redo (after one undo)
// ===========================================================================

/// `redo_page_op_inner`. Sweeps [1K, 10K, 100K] ops on a single page.
///
/// Each iteration undoes-then-redoes so there's always something to redo.
/// The undo cost is captured in `bench_undo_page_op` separately; this
/// bench's per-iteration cost is roughly `undo + redo`. Reads of the
/// op-log dominate at scale so the dual-call shape doesn't distort the
/// shape of the curve.
fn bench_redo_page_op(c: &mut Criterion) {
    let mut group = c.benchmark_group("redo_page_op");

    for &total_ops in &SWEEP_SIZES {
        let rt = Runtime::new().unwrap();
        let dir = TempDir::new().unwrap();
        let pool = rt.block_on(fresh_pool(&dir, &format!("hist_redo_{total_ops}")));
        let materializer = rt.block_on(async { Materializer::new(pool.clone()) });
        let (page_id, _block_id, _last_seq) =
            rt.block_on(seed_single_page_history(&pool, total_ops));

        group.bench_with_input(
            BenchmarkId::from_parameter(total_ops),
            &total_ops,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let materializer_ref = &materializer;
                    let page_id = page_id.clone();
                    async move {
                        // Undo most recent op so there's something to redo.
                        let undo_result =
                            undo_page_op_inner(&pool, BENCH_DEVICE, materializer_ref, page_id, 0)
                                .await
                                .unwrap();

                        // Redo by reversing the undo op.
                        redo_page_op_inner(
                            &pool,
                            BENCH_DEVICE,
                            materializer_ref,
                            undo_result.new_op_ref.device_id,
                            undo_result.new_op_ref.seq,
                        )
                        .await
                        .unwrap()
                    }
                })
            },
        );

        rt.block_on(async { materializer.shutdown() });
    }
    group.finish();
}

criterion_group!(
    benches,
    bench_list_page_history,
    bench_revert_ops_50op,
    bench_undo_page_op,
    bench_redo_page_op,
);
criterion_main!(benches);
