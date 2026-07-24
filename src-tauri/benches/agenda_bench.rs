//! Themed bench binary: agenda / scheduled-item domain.
//!
//! Consolidated from formerly-separate `[[bench]]` binaries to cut Rust
//! build/link time (#2879). Each former bench file is included verbatim as a
//! `mod` under `benches/groups/`; every criterion id string is unchanged so
//! historical baselines keep resolving. Only per-file `criterion_main!` and the
//! `criterion_main` import were dropped; all groups are re-exported below.

#[path = "groups/agenda_bench.rs"]
mod agenda_bench;
#[path = "groups/agenda_expansion_bench.rs"]
mod agenda_expansion_bench;

use criterion::criterion_main;

criterion_main!(agenda_bench::benches, agenda_expansion_bench::benches);
