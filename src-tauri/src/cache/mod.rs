//! Cache materializer functions.
//!
//! Full-recompute rebuilds for the two read-path caches (`tags_cache`,
//! `pages_cache`), an incremental diff-based rebuild for `agenda_cache`,
//! and incremental diff-based reindexing of `block_links`.
//!
//! `rebuild_agenda_cache` computes the desired state, reads the current DB
//! state, then inserts only missing rows and deletes only stale rows —
//! reducing write amplification for large datasets.
//!
//! `rebuild_tags_cache` and `rebuild_pages_cache` still use a full
//! DELETE + INSERT cycle wrapped in a transaction for atomicity.

mod agenda;
mod block_links;
mod page_id;
mod pages;
mod projected_agenda;
mod tags;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Regex for [[ULID]] and ((ULID)) tokens
// ---------------------------------------------------------------------------
//
// ULIDs are encoded in Crockford base-32: exactly 26 uppercase alphanumeric
// characters (digits 0-9 and letters A-Z).  The regex captures the inner
// ULID from wiki-style `[[ULID]]` link tokens and block-reference
// `((ULID))` tokens.
//
// The regex intentionally allows mixed delimiters (e.g. `[[ULID))`) but
// that is harmless — the ULID validation is what matters, not delimiter
// matching.  In practice the serializer always produces matching pairs.
//
// Lowercase characters are intentionally excluded — ULIDs are always
// uppercase in canonical form.

use regex::Regex;
use std::sync::LazyLock;

static ULID_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\[\[|\(\()([0-9A-Z]{26})(?:\]\]|\)\))").expect("invalid ULID link regex")
});

/// Returns a reference to the lazily-compiled ULID-link regex.
#[inline]
fn ulid_link_re() -> &'static Regex {
    &ULID_LINK_RE
}

// ---------------------------------------------------------------------------
// Re-exports — preserve the public API surface
// ---------------------------------------------------------------------------

pub use agenda::{rebuild_agenda_cache, rebuild_agenda_cache_split};
pub use block_links::{reindex_block_links, reindex_block_links_split};
pub use page_id::{rebuild_page_ids, rebuild_page_ids_split};
pub use pages::{rebuild_pages_cache, rebuild_pages_cache_split};
pub use projected_agenda::{rebuild_projected_agenda_cache, rebuild_projected_agenda_cache_split};
pub use tags::{rebuild_tags_cache, rebuild_tags_cache_split};

// ---------------------------------------------------------------------------
// rebuild_all_caches — convenience wrapper
// ---------------------------------------------------------------------------

use crate::error::AppError;
use sqlx::SqlitePool;

/// Rebuilds all four read-path caches in sequence.
///
/// Calls [`rebuild_tags_cache`], [`rebuild_pages_cache`],
/// [`rebuild_agenda_cache`], and [`rebuild_projected_agenda_cache`].
/// Each runs in its own transaction so a failure in a later cache does
/// not roll back earlier ones.
///
/// Note: `reindex_block_links` is *not* included because it operates on a
/// single block and is called per-block during materialisation.
pub async fn rebuild_all_caches(pool: &SqlitePool) -> Result<(), AppError> {
    rebuild_tags_cache(pool).await?;
    rebuild_pages_cache(pool).await?;
    rebuild_agenda_cache(pool).await?;
    rebuild_projected_agenda_cache(pool).await?;
    rebuild_page_ids(pool).await?;
    Ok(())
}
