// Bench helpers cast small loop indices between usize/i64/u64 freely.
#![allow(clippy::cast_possible_wrap, clippy::cast_possible_truncation)]

//! Criterion benchmarks for merge logic and conflict resolution:
//!   1. `merge_text`                — three-way text merge at varying edit distances
//!   2. `resolve_property_conflict` — LWW conflict resolution at scale

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use agaric_lib::dag;
use agaric_lib::db::init_pool;
use agaric_lib::hash::compute_op_hash;
use agaric_lib::merge::{merge_text, resolve_property_conflict};
use agaric_lib::op::{CreateBlockPayload, EditBlockPayload, OpPayload};
use agaric_lib::op_log::{append_local_op_at, OpRecord};
use agaric_lib::ulid::BlockId;

use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::runtime::Runtime;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXED_TS: &str = "2025-01-15T12:00:00Z";
const DEV_A: &str = "device-A";
const DEV_B: &str = "device-B";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Spin up a fresh SQLite pool (with migrations) in a temp directory.
async fn fresh_pool(dir: &TempDir, name: &str) -> SqlitePool {
    let db_path = dir.path().join(format!("{name}.db"));
    init_pool(&db_path).await.unwrap()
}

/// Build a `CreateBlock` payload.
fn make_create(block_id: &str, content: &str) -> OpPayload {
    OpPayload::CreateBlock(CreateBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        block_type: "content".into(),
        parent_id: None,
        position: Some(0),
        content: content.into(),
    })
}

/// Build an `EditBlock` payload with a `prev_edit` pointer.
fn make_edit(block_id: &str, to_text: &str, prev_edit: Option<(String, i64)>) -> OpPayload {
    OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        to_text: to_text.into(),
        prev_edit,
    })
}

/// Build a valid remote `OpRecord` with a correct hash.
fn make_remote_record(
    device_id: &str,
    seq: i64,
    parent_seqs: Option<String>,
    op_type: &str,
    payload: &str,
    created_at: &str,
) -> OpRecord {
    let hash = compute_op_hash(device_id, seq, parent_seqs.as_deref(), op_type, payload);
    OpRecord {
        device_id: device_id.to_owned(),
        seq,
        parent_seqs,
        hash,
        op_type: op_type.to_owned(),
        payload: payload.to_owned(),
        created_at: created_at.to_owned(),
    }
}

/// Generate a multi-line text of approximately `n_lines` lines.
/// Each line is unique so diffy can align them.
fn generate_text(n_lines: usize, prefix: &str) -> String {
    let mut s = String::with_capacity(n_lines * 30);
    for i in 0..n_lines {
        s.push_str(&format!("{prefix} line {i}\n"));
    }
    s
}

/// Generate a "diverged" version of a base text.
/// Edits every `stride`-th line with the given tag, keeping others intact.
fn diverge_text(base_lines: &[&str], stride: usize, tag: &str) -> String {
    let mut s = String::new();
    for (i, line) in base_lines.iter().enumerate() {
        if i % stride == 0 {
            s.push_str(&format!("{tag} edited {i}\n"));
        } else {
            s.push_str(line);
            s.push('\n');
        }
    }
    s
}

/// Set up a merge scenario: create a block with `base_text`, then create two
/// divergent edits from DEV_A (local) and DEV_B (remote).
/// Returns (pool, our_head, their_head, block_id).
async fn setup_merge_scenario(
    dir: &TempDir,
    db_name: &str,
    block_id: &str,
    base_text: &str,
    ours_text: &str,
    theirs_text: &str,
) -> (SqlitePool, (String, i64), (String, i64)) {
    let pool = fresh_pool(dir, db_name).await;

    // Device A: create_block
    append_local_op_at(
        &pool,
        DEV_A,
        make_create(block_id, base_text),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    // Device A: edit_block (our edit)
    append_local_op_at(
        &pool,
        DEV_A,
        make_edit(block_id, ours_text, Some((DEV_A.into(), 1))),
        FIXED_TS.into(),
    )
    .await
    .unwrap();

    // Device B: remote edit_block (their edit), prev_edit points to the create
    let b_payload = serde_json::json!({
        "block_id": block_id,
        "to_text": theirs_text,
        "prev_edit": [DEV_A, 1]
    })
    .to_string();
    let b_record = make_remote_record(DEV_B, 1, None, "edit_block", &b_payload, FIXED_TS);
    dag::insert_remote_op(&pool, &b_record).await.unwrap();

    let our_head = (DEV_A.to_owned(), 2);
    let their_head = (DEV_B.to_owned(), 1);
    (pool, our_head, their_head)
}

// ===========================================================================
// Benchmark 1: Three-way text merge at varying sizes
// ===========================================================================

/// Benchmark `merge_text` with non-overlapping edits (clean merges) at
/// varying text sizes: 10, 100, 1000 lines.
///
/// Device A edits even-indexed lines, device B edits odd-indexed lines,
/// so diffy produces a clean merge every time.
fn bench_merge_text_clean(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("merge_text_clean");

    for n_lines in [10, 100, 1000] {
        let dir = TempDir::new().unwrap();
        let block_id = format!("MRGCLEAN{n_lines:06}");

        // Generate base text
        let base = generate_text(n_lines, "base");
        let base_lines: Vec<&str> = base.lines().collect();

        // Ours: edit even lines
        let ours = diverge_text(&base_lines, 2, "ours");
        // Theirs: edit odd lines (no overlap with ours — stride=2, offset=1)
        let mut theirs_lines = String::new();
        for (i, line) in base_lines.iter().enumerate() {
            if i % 2 == 1 {
                theirs_lines.push_str(&format!("theirs edited {i}\n"));
            } else {
                theirs_lines.push_str(line);
                theirs_lines.push('\n');
            }
        }

        let (pool, our_head, their_head) = rt.block_on(setup_merge_scenario(
            &dir,
            &format!("merge_clean_{n_lines}"),
            &block_id,
            &base,
            &ours,
            &theirs_lines,
        ));

        group.throughput(Throughput::Elements(n_lines as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n_lines}_lines")),
            &n_lines,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let block_id = block_id.clone();
                    let our_head = our_head.clone();
                    let their_head = their_head.clone();
                    async move {
                        merge_text(&pool, &block_id, &our_head, &their_head)
                            .await
                            .unwrap()
                    }
                })
            },
        );
    }

    group.finish();
}

/// Benchmark `merge_text` with overlapping edits (conflict path) at
/// varying text sizes: 10, 100, 1000 lines.
///
/// Both devices edit the same lines, forcing diffy into the conflict path.
fn bench_merge_text_conflict(c: &mut Criterion) {
    let rt = Runtime::new().unwrap();
    let mut group = c.benchmark_group("merge_text_conflict");

    for n_lines in [10, 100, 1000] {
        let dir = TempDir::new().unwrap();
        let block_id = format!("MRGCONF{n_lines:07}");

        // Single-line base per line — both devices rewrite every line
        let base = generate_text(n_lines, "base");
        let base_lines: Vec<&str> = base.lines().collect();
        let ours = diverge_text(&base_lines, 1, "ours");
        let theirs = diverge_text(&base_lines, 1, "theirs");

        let (pool, our_head, their_head) = rt.block_on(setup_merge_scenario(
            &dir,
            &format!("merge_conflict_{n_lines}"),
            &block_id,
            &base,
            &ours,
            &theirs,
        ));

        group.throughput(Throughput::Elements(n_lines as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n_lines}_lines")),
            &n_lines,
            |b, _| {
                b.to_async(&rt).iter(|| {
                    let pool = pool.clone();
                    let block_id = block_id.clone();
                    let our_head = our_head.clone();
                    let their_head = their_head.clone();
                    async move {
                        merge_text(&pool, &block_id, &our_head, &their_head)
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
// Benchmark 2: Property conflict resolution (LWW) at scale
// ===========================================================================

/// Build a pair of conflicting `set_property` OpRecords for a given block
/// with different timestamps so LWW resolution must compare them.
fn make_property_conflict_pair(index: usize) -> (OpRecord, OpRecord) {
    let block_id = format!("PROP{index:010}");
    let key = format!("key_{index}");

    let payload_a = serde_json::json!({
        "block_id": block_id,
        "key": key,
        "value_text": format!("value_a_{index}"),
        "value_num": null,
        "value_date": null,
        "value_ref": null,
    })
    .to_string();

    let payload_b = serde_json::json!({
        "block_id": block_id,
        "key": key,
        "value_text": format!("value_b_{index}"),
        "value_num": null,
        "value_date": null,
        "value_ref": null,
    })
    .to_string();

    // Give them slightly different timestamps so LWW has work to do
    let ts_a = format!("2025-01-15T12:{:02}:{:02}Z", index / 60 % 60, index % 60);
    let ts_b = format!("2025-01-15T13:{:02}:{:02}Z", index / 60 % 60, index % 60);

    let op_a = make_remote_record(
        DEV_A,
        (index * 2 + 1) as i64,
        None,
        "set_property",
        &payload_a,
        &ts_a,
    );
    let op_b = make_remote_record(
        DEV_B,
        (index * 2 + 2) as i64,
        None,
        "set_property",
        &payload_b,
        &ts_b,
    );

    (op_a, op_b)
}

/// Benchmark `resolve_property_conflict` resolving N conflicting property
/// ops from two devices.  Uses `Throughput::Elements(N)` so Criterion
/// reports ops/sec.
fn bench_resolve_property_conflict(c: &mut Criterion) {
    let mut group = c.benchmark_group("resolve_property_conflict");

    for n in [10u64, 100, 1000] {
        // Pre-build the conflict pairs
        let pairs: Vec<(OpRecord, OpRecord)> =
            (0..n as usize).map(make_property_conflict_pair).collect();

        group.throughput(Throughput::Elements(n));
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{n}_conflicts")),
            &n,
            |b, _| {
                b.iter(|| {
                    for (op_a, op_b) in &pairs {
                        resolve_property_conflict(op_a, op_b).unwrap();
                    }
                })
            },
        );
    }

    group.finish();
}

// ===========================================================================
// Harness
// ===========================================================================

criterion_group!(
    merge_text_benches,
    bench_merge_text_clean,
    bench_merge_text_conflict,
);

criterion_group!(conflict_resolution_benches, bench_resolve_property_conflict,);

criterion_main!(merge_text_benches, conflict_resolution_benches);
