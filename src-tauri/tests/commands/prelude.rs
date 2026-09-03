//! What `use super::super::*;` used to mean (#4499 phase 0d).
//!
//! These suites lived at `crate::commands::tests::*`, so their `super::super`
//! glob reached `commands` from *inside* it and pulled in the module's private
//! imports (`SqlitePool`, `AppError`, `op_log`, …) alongside its public API.
//! From a test binary the crate is external and only `pub` items come through,
//! so the private half is re-listed here against each name's home crate —
//! `commands/mod.rs`'s two `use` blocks — the crate-private imports at the top
//! of the file and the `pub use` re-exports below the submodule list — are the
//! source of truth to mirror when either list changes.
//!
//! `allow(unused_imports)`: a prelude is re-exports; a name no longer used by
//! any suite is dead weight, not a defect, and the lint cannot tell them apart
//! across 25 modules.
#![allow(unused_imports)]

pub use agaric_lib::commands::tests::common::*;
pub use agaric_lib::commands::*;

pub use std::sync::{Arc, Mutex};

pub use sqlx::SqlitePool;
pub use tauri::State;

pub use agaric_lib::db::{CommandTx, ReadPool};
pub use agaric_lib::materializer::Materializer;

pub use agaric_core::error::AppError;
pub use agaric_core::ulid::BlockId;
pub use agaric_store::op::{
    DeletePropertyPayload, OpPayload, UndoResult, is_reserved_property_key,
};
pub use agaric_store::op_log;
pub use agaric_store::pagination::{self, BlockRow, HistoryEntry, PageResponse};
pub use agaric_sync::pairing::PairingSession;

// `commands` re-exports these from `agaric_engine::block_ops` as `pub(crate)`
// (#882, #642), which an external test binary cannot see; take them from the
// engine directly rather than widening a re-export nothing outside the lib
// needs.
pub use agaric_engine::block_ops::{
    MAX_BLOCK_DEPTH, MAX_CONTENT_LENGTH, create_block_in_tx, is_valid_iso_date, set_property_in_tx,
    validate_date_format,
};
