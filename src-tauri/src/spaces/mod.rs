//! FEAT-3 Phase 1: Spaces.
//!
//! A "space" is a top-level page block marked with `is_space = "true"` that
//! partitions user content into independent contexts (e.g. "Personal",
//! "Work"). Every non-space page carries a `space` ref property pointing at
//! the space block it belongs to.
//!
//! This module owns the boot-time bootstrap that seeds the two default
//! spaces (Personal + Work) with deterministic reserved ULIDs and migrates
//! any pre-existing pages into the Personal space. Subsequent phases add
//! query scoping, pickers, and UI for managing spaces.
//!
//! The seeded ULIDs are hard-coded Crockford-base32 strings so every device
//! converges on the same space block via the materializer's
//! `INSERT OR IGNORE` — op hashes differ per-device (device_id is part of
//! the hash preimage) but the derived-state row converges on the ULID.

pub mod bootstrap;

pub use bootstrap::{
    bootstrap_spaces, migrate_personal_pages_to_work, MIGRATION_THRESHOLD_ULID,
    SPACE_PERSONAL_ULID, SPACE_WORK_ULID,
};

#[cfg(test)]
mod tests;
