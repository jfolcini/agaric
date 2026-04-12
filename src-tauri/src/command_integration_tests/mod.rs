//! Command-layer integration tests — bulletproof API surface coverage.
//!
//! These tests exercise every Tauri command `_inner` function as an API
//! contract.  They complement:
//! - **Unit tests** (per-module, in each `mod tests`)
//! - **Integration tests** (cross-module pipelines in `integration_tests.rs`)
//!
//! Focus: verify every command's happy path, error variants, edge cases,
//! and cross-cutting lifecycle interactions at the command boundary.

mod backlink_integration;
mod block_integration;
mod common;
mod lifecycle_integration;
mod page_integration;
mod property_integration;
mod sync_integration;
mod tag_integration;
mod trash_integration;
mod undo_integration;
