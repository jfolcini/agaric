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
//!   `PeerID` from the device's UUID-v4 `device_id`.  Phase 1 day-1
//!   inherits the spike's `std::hash::DefaultHasher` implementation;
//!   notebook Q13 in the spike report flags swapping to
//!   `xxhash-rust = "0.8"` before Phase 2 sign-off so peer ids stay
//!   deterministic across Rust compiler upgrades.
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
//! - The `xxhash-rust` peer-id swap (item 1 / Q13).
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

#[cfg(all(test, feature = "loro-shadow"))]
mod tests;
