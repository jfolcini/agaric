// Test and bench bodies are exempt from the 70-code-line ceiling (AGENTS.md item 6).
#![allow(clippy::too_many_lines)]
//! Command-layer integration tests — bulletproof API surface coverage.
//!
//! These tests exercise every Tauri command `_inner` function as an API
//! contract.  They complement:
//! - **Unit tests** (per-module, in each `mod tests`)
//! - **Integration tests** (cross-module pipelines in `integration_tests.rs`)
//!
//! Focus: verify every command's happy path, error variants, edge cases,
//! and cross-cutting lifecycle interactions at the command boundary.
//!
//! #4499 phase 0d moved this suite out of `src/command_integration_tests/` into
//! one integration-test binary: the module tree is unchanged (every `super::`
//! still names a sibling here), only the crate root moved, so `crate::` paths
//! became `agaric_lib::`. One binary rather than fifteen — each integration-test
//! root links `agaric_lib` afresh.

mod backlink_integration;
mod block_integration;
mod common;
mod conformance;
mod conformance_query;
mod conformance_snapshot;
mod draft_flush_integration;
mod lifecycle_integration;
mod page_integration;
mod pages_cache_counts;
mod property_integration;
mod sync_integration;
mod tag_integration;
mod trash_integration;
mod undo_integration;
