//! PEND-58 Phase 1 — shared filter primitives module.
//!
//! Defines the cross-surface `FilterPrimitive` enum + a `Projection`
//! trait that per-surface back-ends (Pages, Search) implement to compile
//! a primitive into a `WhereClause` fragment. Future phases (PEND-58
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

pub mod expr;
pub mod primitive;

pub use expr::{CompileExpr, FilterExpr};
pub use primitive::{
    FilterPrimitive, LastEditedSpec, PAGES_ALLOWED_KEYS, PagesProjection, Projection,
    PropertyPredicate, PropertyValue, SEARCH_ALLOWED_KEYS, SearchProjection, WhereClause,
};
