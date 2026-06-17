//! #1280 — [`QueryProjection`]: the advanced-query surface's
//! [`Projection`] impl.
//!
//! The advanced query runs over `FROM blocks b` (the `b` alias), exactly
//! like [`PagesProjection`]. Every shared + metadata leaf therefore
//! DELEGATES to `PagesProjection`'s compiler so the SQL is byte-shape-
//! identical to the Pages surface (mirroring how
//! [`crate::filters::SearchProjection`] delegates
//! `compile_has_property` / `compile_last_edited` / `compile_space`).
//!
//! What the advanced query supports:
//!
//! * **Shared:** `tag`, `path`, `has-property` (incl. typed Num/Date and the
//!   ordered/`Contains`/`StartsWith` predicates), `last-edited`, `space`,
//!   `priority`.
//! * **Metadata (#1280):** `state`, `block-type`, `due-date`, `scheduled`,
//!   `created`.
//!
//! What it does NOT support (kept as the trait default `unsupported()`):
//!
//! * **Pages-only physical leaves** — `orphan`, `stub`,
//!   `has-no-inbound-links`. These read a `pc.*` (`pages_cache`) alias that
//!   the advanced-query `FROM blocks b` does not join, AND they are
//!   page-grain predicates that don't generalise to arbitrary block rows.
//! * **Search-only leaves** — `regex`, `case-sensitive`, `whole-word`,
//!   `snippet`. Those belong to the full-text fast-follow.

use std::collections::HashSet;

use crate::filters::primitive::DatePredicate;
use crate::filters::{LastEditedSpec, PagesProjection, Projection, PropertyPredicate, WhereClause};

/// The advanced-query projection. Compiles every shared + #1280-metadata
/// leaf by delegating to [`PagesProjection`] (both compile on the `b`
/// alias). Pages-only physical leaves and Search-only leaves fall through to
/// the trait's `unsupported()` default.
#[derive(Debug, Clone, Copy, Default)]
pub struct QueryProjection;

/// The keys an advanced query accepts: the shared vocabulary plus the #1280
/// metadata leaves. Deliberately EXCLUDES the Pages-only surface-physical
/// leaves (`orphan` / `stub` / `has-no-inbound-links`) and the Search-only
/// leaves — both groups compile to `unsupported()` on this surface, and the
/// engine's allow-list gate rejects them before compilation with a typed
/// validation error.
pub static QUERY_ALLOWED_KEYS: std::sync::LazyLock<HashSet<&'static str>> =
    std::sync::LazyLock::new(|| {
        HashSet::from([
            // Shared.
            "tag",
            "path",
            "has-property",
            "last-edited",
            "space",
            "priority",
            // #1280 metadata.
            "state",
            "block-type",
            "due-date",
            "scheduled",
            "created",
        ])
    });

impl Projection for QueryProjection {
    fn allowed_keys() -> &'static HashSet<&'static str> {
        &QUERY_ALLOWED_KEYS
    }

    // ── Shared leaves — delegate to PagesProjection (same `b` alias). ──
    fn compile_tag(&self, tag: &str) -> WhereClause {
        PagesProjection.compile_tag(tag)
    }
    fn compile_path_glob(&self, pattern: &str, exclude: bool) -> WhereClause {
        PagesProjection.compile_path_glob(pattern, exclude)
    }
    fn compile_has_property(&self, key: &str, predicate: &PropertyPredicate) -> WhereClause {
        PagesProjection.compile_has_property(key, predicate)
    }
    fn compile_last_edited(&self, spec: &LastEditedSpec) -> WhereClause {
        PagesProjection.compile_last_edited(spec)
    }
    fn compile_space(&self, space_id: &str) -> WhereClause {
        PagesProjection.compile_space(space_id)
    }
    fn compile_priority(&self, priority: &str) -> WhereClause {
        PagesProjection.compile_priority(priority)
    }

    // ── #1280 metadata leaves — delegate to PagesProjection. ──
    fn compile_state(&self, values: &[String], is_null: bool, exclude: bool) -> WhereClause {
        PagesProjection.compile_state(values, is_null, exclude)
    }
    fn compile_block_type(&self, values: &[String], exclude: bool) -> WhereClause {
        PagesProjection.compile_block_type(values, exclude)
    }
    fn compile_due_date(&self, predicate: &DatePredicate) -> WhereClause {
        PagesProjection.compile_due_date(predicate)
    }
    fn compile_scheduled(&self, predicate: &DatePredicate) -> WhereClause {
        PagesProjection.compile_scheduled(predicate)
    }
    fn compile_created(&self, after: Option<&str>, before: Option<&str>) -> WhereClause {
        PagesProjection.compile_created(after, before)
    }

    // Pages-only physical leaves (orphan / stub / has-no-inbound-links) and
    // Search-only leaves keep the trait's `unsupported()` default — the
    // advanced-query `FROM blocks b` does not join `pages_cache`, and those
    // primitives are page-grain / full-text concerns. The engine's
    // allow-list gate rejects their keys before they reach `compile`.
}
