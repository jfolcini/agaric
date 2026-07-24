//! Themed bench binary: read / query / index domain (backlinks, tags,
//! pagination, graph, FTS, properties, aliases).
//!
//! Consolidated from formerly-separate `[[bench]]` binaries to cut Rust
//! build/link time (#2879). Each former bench file is included verbatim as a
//! `mod` under `benches/groups/`; every criterion id string is unchanged so
//! historical baselines keep resolving. Only per-file `criterion_main!` and the
//! `criterion_main` import were dropped; all groups are re-exported below.

#[path = "groups/alias_bench.rs"]
mod alias_bench;
#[path = "groups/backlink_query_bench.rs"]
mod backlink_query_bench;
#[path = "groups/fts_bench.rs"]
mod fts_bench;
#[path = "groups/graph_bench.rs"]
mod graph_bench;
#[path = "groups/pagination_bench.rs"]
mod pagination_bench;
#[path = "groups/property_bench.rs"]
mod property_bench;
#[path = "groups/property_def_bench.rs"]
mod property_def_bench;
#[path = "groups/tag_query_bench.rs"]
mod tag_query_bench;

use criterion::criterion_main;

criterion_main!(
    backlink_query_bench::eval_query_benches,
    backlink_query_bench::filter_benches,
    backlink_query_bench::sort_benches,
    backlink_query_bench::pagination_benches,
    backlink_query_bench::property_keys_benches,
    backlink_query_bench::scale_benches,
    backlink_query_bench::batch_benches,
    backlink_query_bench::unlinked_benches,
    backlink_query_bench::property_sort_scale_benches,
    tag_query_bench::benches,
    pagination_bench::benches,
    graph_bench::graph_benches,
    fts_bench::benches,
    property_bench::benches,
    property_def_bench::property_def_benches,
    alias_bench::alias_benches,
);
