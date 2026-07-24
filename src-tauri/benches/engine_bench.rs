//! Themed bench binary: engine / apply / history / undo-redo / op-log domain.
//!
//! Consolidated from formerly-separate `[[bench]]` binaries to cut Rust
//! build/link time (#2879): 30 bench crates → a handful of themed crates. Each
//! former bench file is included verbatim as a `mod` under `benches/groups/`,
//! so every criterion `benchmark_group`/`bench_function` id string is unchanged
//! and historical criterion baselines (keyed by id, in the shared
//! `target/criterion/` tree — independent of which binary emits them) keep
//! resolving. Only the per-file `criterion_main!`/`criterion_main` import were
//! dropped; all groups are re-exported through the single `criterion_main!`
//! below. The #978 `--test` seed/fixture smoke gate still runs every group
//! (one binary now runs them all).

#[path = "groups/compaction_bench.rs"]
mod compaction_bench;
#[path = "groups/engine_checkpoint_bench.rs"]
mod engine_checkpoint_bench;
#[path = "groups/history_bench.rs"]
mod history_bench;
#[path = "groups/op_log_bench.rs"]
mod op_log_bench;
#[path = "groups/snapshot_bench.rs"]
mod snapshot_bench;
#[path = "groups/soft_delete_bench.rs"]
mod soft_delete_bench;
#[path = "groups/undo_redo.rs"]
mod undo_redo;

use criterion::criterion_main;

criterion_main!(
    engine_checkpoint_bench::benches,
    undo_redo::reverse_benches,
    undo_redo::page_history_benches,
    undo_redo::undo_benches,
    undo_redo::revert_benches,
    undo_redo::restore_benches,
    undo_redo::redo_benches,
    undo_redo::diff_benches,
    history_bench::benches,
    snapshot_bench::snapshot_create_benches,
    snapshot_bench::snapshot_apply_benches,
    snapshot_bench::snapshot_apply_vault_scale_benches,
    snapshot_bench::snapshot_codec_benches,
    compaction_bench::status_benches,
    compaction_bench::compact_benches,
    op_log_bench::benches,
    soft_delete_bench::benches,
);
