//! Shared command-test fixture (#4499 phase 0d).
//!
//! The 25 domain suites that used to live here moved to the `commands`
//! integration-test binary (`src-tauri/tests/commands/`). Only [`common`]
//! stays: `crate::integration_tests` and `crate::mcp::tools_ro::tests` are
//! still in-lib `#[cfg(test)]` modules that consume it, so moving it out would
//! fork the fixture in two. It is reachable from the test binaries as
//! `agaric_lib::commands::tests::common` via the `test-util` feature.

pub mod common;
