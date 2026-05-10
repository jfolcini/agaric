//! PEND-09 Phase 1 — production-side Loro CRDT scaffold.
//!
//! As of Phase 3 day-9 the `loro-shadow` feature gate is retired and
//! this module compiles unconditionally; the Loro engine is the only
//! materializer path.  When this module first landed it was gated
//! behind `feature = "loro-shadow"` so default builds were
//! byte-identical to the diffy era; the cutover-flag fork (day-8) and
//! the feature-gate retire (day-9) collapse those two build modes
//! into one.
//!
//! The module exposes the surface the materializer + sync layers need
//! to drive the per-space `LoroEngine`:
//!
//! * [`engine::LoroEngine`] — the CRDT engine ported from the
//!   spike's `src/lib.rs` (the spike crate was archived in Phase-2
//!   day-8; see git tag `pend-09/spike-archive`), adapted to use
//!   [`crate::error::AppError`] instead of `anyhow::Result` (the
//!   spike's throwaway error type).
//! * [`engine::BlockSnapshot`] — the read-back projection of a block
//!   from the Loro doc, sufficient for parity-equality checks.
//! * [`engine::peer_id_from_device_id`] — derives a stable Loro
//!   `PeerID` from the device's UUID-v4 `device_id` via `xxh3_64`
//!   (Phase-1 day-7 swap from the spike's `std::hash::DefaultHasher`,
//!   per readiness-checklist item 1 / notebook Q13).  The hash is
//!   deterministic across runs, devices, and Rust toolchain versions;
//!   see the function's stability-contract docstring before changing
//!   it.
//! * [`parity::ShadowParitySampler`] — in-memory ring buffer for the
//!   first parity-logging sink.

pub mod classifier;

pub mod engine;

pub mod envelope;

pub mod flush_task;

pub mod parity;

pub mod parity_sink;

// PEND-09 Phase 2 day-11 — projection helpers that write SQL rows
// from post-apply Loro engine state.  Each per-op-type helper takes a
// `&mut SqliteConnection` and a typed payload (or read-back snapshot)
// and writes the SQL row mirroring the engine's view.
pub mod projection;

pub mod registry;

pub mod shared;

// PEND-09 Phase 2 day-6 — per-space LoroDoc snapshot persistence.  The
// `loro_doc_state` table is created by migration `0052`; this module
// exposes save / load / scheduler helpers.
pub mod snapshot;

#[cfg(test)]
mod tests;

// PEND-09 Phase 1 day-8 — proptest-augmented parity streams.  Asserts
// kill-criterion #2 (bucket D must stay at zero) over thousands of
// randomised single-author op streams.
#[cfg(test)]
mod parity_proptest;
