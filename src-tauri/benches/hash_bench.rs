//! Criterion benchmarks for `compute_op_hash` and `verify_op_hash`.

use std::hint::black_box;

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use block_notes_lib::hash::{compute_op_hash, verify_op_hash};

// ---------------------------------------------------------------------------
// Individual benchmarks
// ---------------------------------------------------------------------------

fn bench_hash_small_payload(c: &mut Criterion) {
    c.bench_function("hash_small_payload", |b| {
        b.iter(|| {
            black_box(compute_op_hash(
                "device-123",
                42,
                Some(r#"[["dev-1",41]]"#),
                "edit_block",
                r#"{"block_id":"01HZ00000000000000000000AB","to_text":"hello"}"#,
            ))
        })
    });
}

fn bench_hash_large_payload(c: &mut Criterion) {
    let large = "x".repeat(100_000);
    c.bench_function("hash_large_payload_100k", |b| {
        b.iter(|| black_box(compute_op_hash("dev-1", 1, None, "create_block", &large)))
    });
}

fn bench_verify_op_hash(c: &mut Criterion) {
    let hash = compute_op_hash("dev-1", 1, None, "create_block", r#"{"ok":true}"#);
    c.bench_function("verify_op_hash_match", |b| {
        b.iter(|| {
            black_box(verify_op_hash(
                &hash,
                "dev-1",
                1,
                None,
                "create_block",
                r#"{"ok":true}"#,
            ))
        })
    });
}

fn bench_hash_no_parent_seqs(c: &mut Criterion) {
    c.bench_function("hash_no_parent_seqs", |b| {
        b.iter(|| black_box(compute_op_hash("dev-1", 1, None, "create_block", "{}")))
    });
}

// ---------------------------------------------------------------------------
// Parameterised group — payload sizes: 100 B, 1 KB, 10 KB, 100 KB
// ---------------------------------------------------------------------------

fn bench_hash_varying_payload(c: &mut Criterion) {
    let sizes: &[usize] = &[100, 1_000, 10_000, 100_000];

    let mut group = c.benchmark_group("hash_payload_size");
    for &size in sizes {
        let payload = "a".repeat(size);
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{size}B")),
            &payload,
            |b, p| {
                b.iter(|| compute_op_hash("device-abc", 99, Some(r#"[["d",1]]"#), "edit_block", p))
            },
        );
    }
    group.finish();
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

criterion_group!(
    benches,
    bench_hash_small_payload,
    bench_hash_large_payload,
    bench_verify_op_hash,
    bench_hash_no_parent_seqs,
    bench_hash_varying_payload,
);
criterion_main!(benches);
