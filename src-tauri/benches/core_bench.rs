//! Themed bench binary: core commands / cache / cold-start / resource /
//! move-reorder / hash / page-load domain.
//!
//! Consolidated from formerly-separate `[[bench]]` binaries to cut Rust
//! build/link time (#2879). Each former bench file is included verbatim as a
//! `mod` under `benches/groups/`; every criterion id string is unchanged so
//! historical baselines keep resolving. Only per-file `criterion_main!` and the
//! `criterion_main` import were dropped; all groups are re-exported below.

#[path = "groups/cache_bench.rs"]
mod cache_bench;
#[path = "groups/cold_start_bench.rs"]
mod cold_start_bench;
#[path = "groups/commands_bench.rs"]
mod commands_bench;
#[path = "groups/hash_bench.rs"]
mod hash_bench;
#[path = "groups/move_reorder_bench.rs"]
mod move_reorder_bench;
#[path = "groups/page_load_bench.rs"]
mod page_load_bench;
#[path = "groups/resource_envelope_bench.rs"]
mod resource_envelope_bench;

use criterion::criterion_main;

criterion_main!(
    commands_bench::create_benches,
    commands_bench::edit_benches,
    commands_bench::list_benches,
    commands_bench::resolve_benches,
    commands_bench::properties_benches,
    commands_bench::scale_benches,
    commands_bench::read_benches,
    cache_bench::benches,
    cold_start_bench::cold_start_benches,
    resource_envelope_bench::resource_envelope_benches,
    move_reorder_bench::benches,
    hash_bench::benches,
    page_load_bench::page_load_benches,
);
