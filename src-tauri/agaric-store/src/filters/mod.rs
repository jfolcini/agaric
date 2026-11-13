//! Phase 1 — shared filter primitives module.
//!
//! Defines the cross-surface `FilterPrimitive` enum + a `Projection`
//! trait that per-surface back-ends (Pages, Search) implement to compile
//! a primitive into a `WhereClause` fragment. Future phases (
//! Phase 2–5) consume this module to deliver the Pages compound-filter
//! chip row and the corresponding Search vocabulary unification.
//!
//! **Scope of Phase 1 (this commit):** types + trait + per-surface stubs
//! with `ALLOWED_KEYS` discipline + unit tests. Wire-up against the
//! existing `SearchFilter` SQL composition is intentionally deferred to
//! a follow-up so this lands as a purely additive module — every
//! existing search / pages query continues to use today's SQL paths.
//!
//! The shared cross-surface vocabulary today: `tag:`, `path:`,
//! `has-property:`, `last-edited:`, `space:`, `priority:`. Pages adds
//! grooming facets (`orphan:`, `stub:`, `has-no-inbound-links:`); Search
//! keeps regex / case-sensitive / whole-word / snippet specialty.

pub mod assembly;
pub mod expr;
pub mod primitive;

pub use assembly::SqlFragment;
pub use expr::{CompileExpr, FilterExpr};
pub use primitive::{
    FilterPrimitive, LastEditedSpec, PAGES_ALLOWED_KEYS, PagesProjection, Projection,
    PropertyPredicate, PropertyValue, SEARCH_ALLOWED_KEYS, SearchProjection, WhereClause,
    last_edited_ms_sql,
};

/// Leaves out a saved view (#6544), a page carrying the internal `saved_view`
/// property, which the page lists, search and queries never show. Reads `b`;
/// a `query!` site writes the same text, since the macro takes a literal.
pub const NOT_SAVED_VIEW: &str =
    "b.id NOT IN (SELECT block_id FROM block_properties WHERE key = 'saved_view')";
