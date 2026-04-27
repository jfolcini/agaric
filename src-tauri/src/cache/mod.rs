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
mod block_tag_refs;
mod page_id;
mod pages;
mod projected_agenda;
mod tags;

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------------------
// Regex for [[ULID]], ((ULID)), and #[ULID] tokens (canonical home)
// ---------------------------------------------------------------------------
//
// MAINT-148e — the three ULID-token regexes are defined once here and
// re-exported by [`crate::fts`] so the materializer pipeline (cache
// rebuilds + FTS strip) shares a single source of truth. Pre-refactor,
// `TAG_REF_RE` and `PAGE_LINK_RE` were duplicated in `fts/strip.rs` with
// slightly different naming. Any future ULID-token change should land
// here only.
//
// ULIDs are encoded in Crockford base-32: exactly 26 uppercase alphanumeric
// characters (digits 0-9 and letters A-Z).  `ULID_LINK_RE` captures the
// inner ULID from wiki-style `[[ULID]]` link tokens and block-reference
// `((ULID))` tokens.
//
// `TAG_REF_RE` captures the inner ULID from inline tag-reference
// `#[ULID]` tokens. The `#` prefix is intentionally tight — this matches
// the markdown serializer's exact emission at
// `src/editor/markdown-serializer.ts`, which produces `#[ULID]` for every
// inline tag reference created by the TagRef TipTap extension. Loosening
// this regex (e.g. matching bare `[ULID]`) would conflict with wiki-style
// `[[ULID]]` handling and start capturing regular markdown link syntax.
//
// `PAGE_LINK_RE` is the page-link-only sibling (`[[ULID]]`); `ULID_LINK_RE`
// also matches block references `((ULID))` and is used by the per-block
// link reindexer.
//
// The ULID-link regex intentionally allows mixed delimiters (e.g.
// `[[ULID))`) but that is harmless — the ULID validation is what matters,
// not delimiter matching.  In practice the serializer always produces
// matching pairs.
//
// Lowercase characters are intentionally excluded — ULIDs are always
// uppercase in canonical form.

use regex::Regex;
use std::sync::LazyLock;

pub(crate) static ULID_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\[\[|\(\()([0-9A-Z]{26})(?:\]\]|\)\))").expect("invalid ULID link regex")
});

pub(crate) static TAG_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#\[([0-9A-Z]{26})\]").expect("invalid tag-ref regex"));

pub(crate) static PAGE_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([0-9A-Z]{26})\]\]").expect("invalid page-link regex"));

/// Returns a reference to the lazily-compiled ULID-link regex.
#[inline]
fn ulid_link_re() -> &'static Regex {
    &ULID_LINK_RE
}

/// Returns a reference to the lazily-compiled inline tag-reference regex
/// (`#[ULID]`).
#[inline]
fn tag_ref_re() -> &'static Regex {
    &TAG_REF_RE
}

// ---------------------------------------------------------------------------
// Shared cache-rebuild logging helper (MAINT-148b)
// ---------------------------------------------------------------------------

/// Wrap a cache-rebuild closure with the standard tracing instrumentation.
///
/// Emits `"rebuilding"` info at entry, `"rebuilt"` info at success (with
/// `rows_affected` and `duration_ms`), and `"rebuild failed"` warn on error.
/// `name` is the cache identifier (e.g. `"tags"`, `"agenda"`,
/// `"projected_agenda"`) and shows up in every emitted log line so the
/// pre-refactor message format (`"rebuilding <name> cache"` /
/// `"rebuilt <name> cache"` / `"rebuild failed for <name> cache"`) is
/// preserved verbatim.
///
/// The closure returns the rows-affected count; this helper translates that
/// to `Result<(), AppError>` so the public rebuild functions retain their
/// pre-refactor signature.
pub(super) async fn rebuild_with_timing<F, Fut>(
    name: &'static str,
    f: F,
) -> Result<(), crate::error::AppError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<u64, crate::error::AppError>>,
{
    tracing::info!(cache = name, "rebuilding {name} cache");
    let start = std::time::Instant::now();
    match f().await {
        Ok(rows_affected) => {
            tracing::info!(
                cache = name,
                rows_affected,
                duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
                "rebuilt {name} cache"
            );
            Ok(())
        }
        Err(e) => {
            tracing::warn!(cache = name, error = %e, "rebuild failed for {name} cache");
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Re-exports — preserve the public API surface
// ---------------------------------------------------------------------------

pub use agenda::{rebuild_agenda_cache, rebuild_agenda_cache_split};
pub use block_links::{reindex_block_links, reindex_block_links_split};
pub use block_tag_refs::{
    rebuild_block_tag_refs_cache, rebuild_block_tag_refs_cache_split, reindex_block_tag_refs,
    reindex_block_tag_refs_split,
};
pub use page_id::{rebuild_page_ids, rebuild_page_ids_split};
pub use pages::{rebuild_pages_cache, rebuild_pages_cache_split};
pub use projected_agenda::{rebuild_projected_agenda_cache, rebuild_projected_agenda_cache_split};
pub use tags::{rebuild_tags_cache, rebuild_tags_cache_split};

// ---------------------------------------------------------------------------
// rebuild_all_caches — convenience wrapper
// ---------------------------------------------------------------------------

#[cfg(test)]
use crate::error::AppError;
#[cfg(test)]
use sqlx::SqlitePool;

/// Rebuilds all read-path caches in sequence.
///
/// Calls [`rebuild_page_ids`], [`rebuild_block_tag_refs_cache`],
/// [`rebuild_tags_cache`], [`rebuild_pages_cache`], [`rebuild_agenda_cache`],
/// and [`rebuild_projected_agenda_cache`].
/// Each runs in its own transaction so a failure in a later cache does
/// not roll back earlier ones.
///
/// Note: `reindex_block_links` and `reindex_block_tag_refs` are *not*
/// included here — they operate on a single block and are called
/// per-block during materialisation.
///
/// Ordering note: `rebuild_page_ids` runs **first** (M-15) because
/// `rebuild_agenda_cache` and `rebuild_projected_agenda_cache` both
/// consult `b.page_id` to apply the FEAT-5a template-page exclusion
/// (`NOT EXISTS (... tp.block_id = b.page_id AND tp.key = 'template')`).
/// Running them before page_ids is populated would silently include or
/// exclude template-page blocks until something else triggered another
/// rebuild — eventual consistency, not data loss, but visible to the
/// user. The snapshot/restore enqueue array mirrors this ordering.
///
/// Ordering note: `rebuild_block_tag_refs_cache` runs **before**
/// `rebuild_tags_cache` because the tags-cache usage-count subquery
/// UNIONs `block_tag_refs` into the count — populating the inline-ref
/// rows first lets the tags-cache rebuild observe them on the same
/// invocation.
///
/// Test-only (L-19): production paths (snapshot restore, materializer)
/// enqueue individual `MaterializeTask::Rebuild*` variants per cache
/// rather than calling this convenience wrapper. Gating it behind
/// `#[cfg(test)]` keeps the test ergonomics while preventing accidental
/// production use that would bypass the materializer queue.
#[cfg(test)]
pub async fn rebuild_all_caches(pool: &SqlitePool) -> Result<(), AppError> {
    rebuild_page_ids(pool).await?;
    rebuild_block_tag_refs_cache(pool).await?;
    rebuild_tags_cache(pool).await?;
    rebuild_pages_cache(pool).await?;
    rebuild_agenda_cache(pool).await?;
    rebuild_projected_agenda_cache(pool).await?;
    Ok(())
}
