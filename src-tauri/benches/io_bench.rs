//! Themed bench binary: import / export / attachment / draft I/O domain.
//!
//! Consolidated from formerly-separate `[[bench]]` binaries to cut Rust
//! build/link time (#2879). Each former bench file is included verbatim as a
//! `mod` under `benches/groups/`; every criterion id string is unchanged so
//! historical baselines keep resolving. Only per-file `criterion_main!` and the
//! `criterion_main` import were dropped; all groups are re-exported below.

#[path = "groups/attachment_bench.rs"]
mod attachment_bench;
#[path = "groups/draft_bench.rs"]
mod draft_bench;
#[path = "groups/export_bench.rs"]
mod export_bench;
#[path = "groups/import_bench.rs"]
mod import_bench;

use criterion::criterion_main;

criterion_main!(
    import_bench::parse_benches,
    import_bench::import_benches,
    export_bench::export_benches,
    attachment_bench::attachment_benches,
    draft_bench::save_benches,
    draft_bench::flush_benches,
    draft_bench::scale_benches,
    draft_bench::crud_benches,
);
