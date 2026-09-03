// Test and bench bodies are exempt from the 70-code-line ceiling (AGENTS.md item 6).
#![allow(clippy::too_many_lines)]
//! Crate-root app tests (#4499 phase 0d) — one integration-test binary for the
//! five `*_app_tests.rs` suites that used to be `#[cfg(test)] mod`s in
//! `src/lib.rs`, plus the reverse tests that need the app's `Materializer`
//! (phase 1). Each covers the app-crate half of a facility whose store-side
//! tests already live down in `agaric-store` or `agaric-engine`.
//!
//! Consolidated for the same reason as `tests/commands/`: six roots would
//! link `agaric_lib` six times.

mod cache_app_tests;
mod fts_app_tests;
mod op_log_app_tests;
mod pagination_app_tests;
mod peer_refs_app_tests;
mod reverse_tests;
