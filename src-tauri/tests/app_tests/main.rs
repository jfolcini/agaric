//! Crate-root app tests (#4499 phase 0d) — one integration-test binary for the
//! five `*_app_tests.rs` suites that used to be `#[cfg(test)] mod`s in
//! `src/lib.rs`. Each covers the app-crate half of a facility whose store-side
//! tests already live down in `agaric-store`.
//!
//! Consolidated for the same reason as `tests/commands/`: five roots would
//! link `agaric_lib` five times.

mod cache_app_tests;
mod fts_app_tests;
mod op_log_app_tests;
mod pagination_app_tests;
mod peer_refs_app_tests;
mod reverse_tests;
