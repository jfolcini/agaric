//! Production-side Loro CRDT scaffold. The Loro engine is the only
//! materializer path. `loro::snapshot::save_all_engines` is callable
//! directly from shutdown / sync-pull paths.
//!
//! The module exposes the surface the materializer + sync layers need
//! to drive the per-space `LoroEngine`:
//!
//! * [`engine::LoroEngine`] — the CRDT engine, using
//!   [`crate::error::AppError`] for fallible operations.
//! * [`engine::BlockSnapshot`] — the read-back projection of a block
//!   from the Loro doc.
//! * [`engine::peer_id_from_device_id`] — derives a stable Loro
//!   `PeerID` from the device's UUID-v4 `device_id` via `xxh3_64`.
//!   The hash is deterministic across runs, devices, and Rust
//!   toolchain versions; see the function's stability-contract
//!   docstring before changing it.

pub mod engine;

pub mod envelope;

// Projection helpers that write SQL rows from post-apply Loro engine
// state. Each per-op-type helper takes a `&mut SqliteConnection` and
// a typed payload (or read-back snapshot) and writes the SQL row
// mirroring the engine's view.
pub mod projection;

pub mod registry;

pub mod shared;

// Per-space LoroDoc snapshot persistence. The `loro_doc_state` table
// is created by migration `0052`; this module exposes save / load
// helpers.
pub mod snapshot;

#[cfg(test)]
mod tests;

// Randomised LoroEngine regression streams. Assert direct convergence
// invariants (single-author replay, two-device snapshot exchange) on
// bare `LoroEngine` instances.
#[cfg(test)]
mod engine_proptest;
