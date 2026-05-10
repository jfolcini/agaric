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
//! Phase 3 day-10 deleted the parity sink + bucket classifier + flush
//! task + the in-memory `ShadowParitySampler` ring.  Their host table
//! `merge_parity_log` (migration `0051`) compared diffy-vs-Loro
//! results; with diffy gone the comparison has no meaning.  The
//! per-space LoroDoc snapshot scheduler that previously rode the
//! flush task's tick now has no host: the day-12 sync rebuild adds
//! a fresh scheduler back if it ends up load-bearing.  Until then
//! `loro::snapshot::save_all_engines` is callable directly from
//! shutdown / sync-pull paths.
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
//!   from the Loro doc.
//! * [`engine::peer_id_from_device_id`] — derives a stable Loro
//!   `PeerID` from the device's UUID-v4 `device_id` via `xxh3_64`
//!   (Phase-1 day-7 swap from the spike's `std::hash::DefaultHasher`,
//!   per readiness-checklist item 1 / notebook Q13).  The hash is
//!   deterministic across runs, devices, and Rust toolchain versions;
//!   see the function's stability-contract docstring before changing
//!   it.

pub mod engine;

pub mod envelope;

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

// PEND-09 Phase 1 day-8 — randomised LoroEngine regression streams.
// Phase 3 day-10 repurposed this module: with the parity sink gone
// the bucket-A/B/C/D classifier is no longer reachable, so the tests
// now assert direct convergence invariants (single-author replay,
// two-device snapshot exchange) on bare `LoroEngine` instances.
#[cfg(test)]
mod engine_proptest;
