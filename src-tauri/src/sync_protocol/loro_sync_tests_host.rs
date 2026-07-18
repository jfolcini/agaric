//! #2621 Sync-D wrapper: hosts the app-coupled `loro_sync_tests.rs`, which was
//! an inline child of the `loro_sync` submodule (Sync-C-prep). Its `use super::*`
//! reached that module's namespace, so this wrapper reconstructs it (`super` =
//! this module). Declared as a real file so the `#[path]` below resolves against
//! `src/sync_protocol/`.
#![allow(unused_imports)]

pub use agaric_sync::sync_protocol::loro_sync::*;
pub use agaric_sync::sync_protocol::loro_sync_types::{
    LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage,
};

pub use agaric_core::error::AppError;
pub use agaric_engine::loro::registry::LoroEngineRegistry;
pub use agaric_store::space::SpaceId;
pub use loro::VersionVector;
pub use sqlx::SqlitePool;

#[path = "loro_sync_tests.rs"]
mod loro_sync_tests;
