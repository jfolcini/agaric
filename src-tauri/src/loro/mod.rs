//! PEND-09 Phase 1 — production-side Loro CRDT scaffold.
//!
//! This module is **feature-gated** behind `feature = "loro-shadow"`.
//! When the feature is off (the default for every build today,
//! including `cargo nextest run -p agaric`) the module body does not
//! compile; the declaration in `lib.rs` collapses to an empty module
//! and the `loro` crate is not linked.  Production behaviour is
//! unchanged.
//!
//! When the feature is on, this module exposes the minimum surface
//! needed by `merge::shadow_apply` to drive a `LoroEngine` alongside
//! the existing diffy merge:
//!
//! * [`engine::LoroEngine`] — the CRDT engine ported from
//!   `crates/loro-spike/src/lib.rs`, adapted to use [`crate::error::AppError`]
//!   instead of `anyhow::Result` (the spike's throwaway error type).
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
//!   first parity-logging sink.  No DB table yet; that's a later
//!   Phase-1 day's deliverable.
//!
//! ## What's NOT here yet (future Phase-1 days)
//!
//! - Bucket A/B/C/D classifier for the parity log.  Day-4 landed the
//!   data layer (`parity_sink::flush_to_sqlite` plus `parity_sink::purge_old`,
//!   plus migration `0051_pend_09_merge_parity_log.sql`); day-5 wired the
//!   periodic flush plus purge into a tokio background task spawned at app
//!   setup (`flush_task::run_periodic_flush`); day-6 added the bucket
//!   classifier (`classifier::classify_unbucketed`) — runs on every flush
//!   tick to fill the `bucket` column of newly-flushed rows.
//! - The remaining ~5 unported integration parity tests + proptest
//!   augmentation (items 7-8 on the checklist).
//! - The macOS RSS measurement in the replay benchmark (item 11).
//! - The `loro_doc_state` table schema (item 12, Phase-2 entry).
//!
//! Each is tracked in the spike report's §6 readiness checklist.

#[cfg(feature = "loro-shadow")]
pub mod classifier;

#[cfg(feature = "loro-shadow")]
pub mod engine;

#[cfg(feature = "loro-shadow")]
pub mod envelope;

#[cfg(feature = "loro-shadow")]
pub mod flush_task;

#[cfg(feature = "loro-shadow")]
pub mod parity;

#[cfg(feature = "loro-shadow")]
pub mod parity_sink;

#[cfg(feature = "loro-shadow")]
pub mod registry;

#[cfg(feature = "loro-shadow")]
pub mod shared;

// PEND-09 Phase 2 day-6 — per-space LoroDoc snapshot persistence.  The
// `loro_doc_state` table is created by migration `0052`; this module
// exposes save / load / scheduler helpers.  See the module docstring
// for the (a / b / c) "how does the registry rehydrate" decision.
#[cfg(feature = "loro-shadow")]
pub mod snapshot;

#[cfg(all(test, feature = "loro-shadow"))]
mod tests;

// PEND-09 Phase 1 day-8 — proptest-augmented parity streams.  Replaces
// the hand-curated 53-case parity corpus's "we thought of these
// scenarios" with proptest's "the shrinker actively searches for
// counter-examples".  Asserts kill-criterion #2 (bucket D must stay
// at zero) over thousands of randomised single-author op streams.
// See the file's module docstring for the why and the configuration
// notes.  Two-device concurrent-merge proptest extension is scheduled
// for a later Phase-1 day; see SPIKE-REPORT.md §6 item 8.
#[cfg(all(test, feature = "loro-shadow"))]
mod parity_proptest;
