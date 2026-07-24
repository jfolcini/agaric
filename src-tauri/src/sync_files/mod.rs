//! #2621 Sync-D: production moved to [`agaric_sync::sync_files`]; this app-side
//! app-side module hosts app-coupled tests (production lives in `agaric_sync::sync_files`);
//! and hosts the app-coupled tests (`src/sync_files/tests.rs`, which reach into
//! the daemon / materializer glue that lives above `agaric-sync`).
//!
//! The hosted test uses `use super::*`; the production module's private imports
//! are re-declared below under `#[cfg(test)]` so that namespace resolves.
#![cfg_attr(test, allow(unused_imports))]

#[cfg(test)]
use agaric_sync::sync_files::*;

#[cfg(test)]
use agaric_core::error::AppError;
#[cfg(test)]
use agaric_sync::sync_constants::BINARY_FRAME_CHUNK_SIZE;
#[cfg(test)]
use agaric_sync::sync_net::SyncConnection;
#[cfg(test)]
use agaric_sync::sync_protocol::SyncMessage;
#[cfg(test)]
use sqlx::SqlitePool;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[cfg(test)]
mod tests;
