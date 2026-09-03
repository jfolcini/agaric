// Test and bench bodies are exempt from the 70-code-line ceiling (AGENTS.md item 6).
#![allow(clippy::too_many_lines)]
//! Domain command tests (#4499 phase 0d) — one integration-test binary for the
//! 25 per-domain suites that used to live in `src/commands/tests/`.
//!
//! Consolidated rather than one binary per file: each integration-test root is its
//! own crate that links `agaric_lib` afresh, so 25 roots would multiply link
//! time by 25 for no isolation the module tree does not already give.
//!
//! The shared fixture (`common`) stays in the lib behind the `test-util`
//! feature — `crate::integration_tests` and `crate::mcp::tools_ro::tests` still
//! consume it from inside the lib, and duplicating it here would fork it.
//! [`prelude`] re-exports it alongside the names the old
//! `use super::super::*;` glob pulled in from inside `commands`.

mod prelude;

mod agenda_cmd_tests;
mod bibliography_cmd_tests;
mod block_cmd_tests;
mod compaction_cmd_tests;
mod edge_case_tests;
mod engine_parity_tests;
mod glob_filter_tests;
mod history_cmd_tests;
mod list_pages_with_metadata_tests;
mod metadata_filter_tests;
mod page_cmd_tests;
mod pages_filter_primitive_conformance_tests;
mod pages_metadata_conformance_tests;
mod pages_orphan_conformance_tests;
mod pages_path_glob_conformance_tests;
mod pages_tag_property_conformance_tests;
mod property_cmd_tests;
mod query_cmd_tests;
mod search_blocks_struct_tests;
mod snapshot_tests;
mod status_cmd_tests;
mod sync_cmd_tests;
mod tag_cmd_tests;
mod toggle_filter_tests;
mod undo_redo_tests;
