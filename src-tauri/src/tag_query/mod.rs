//! Boolean tag query evaluation (p3-t7, p3-t8).

mod query;
mod resolve;

pub use query::{eval_tag_query, list_tags_by_prefix, list_tags_for_block};
// MAINT-143: Shared leaf-resolution helpers — `backlink::filters` calls
// these to stay in lockstep with `resolve_expr`'s UX-250 inline-ref
// union semantics. See `resolve.rs` for the canonical SQL.
pub(crate) use resolve::{resolve_tag_leaves, resolve_tag_prefix_leaves};

use serde::Serialize;

/// Boolean expression tree for tag queries.
#[derive(Debug, Clone, PartialEq)]
pub enum TagExpr {
    Tag(String),
    Prefix(String),
    And(Vec<TagExpr>),
    Or(Vec<TagExpr>),
    Not(Box<TagExpr>),
}

/// Row from `tags_cache`, used by `list_tags_by_prefix`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct TagCacheRow {
    pub tag_id: String,
    pub name: String,
    pub usage_count: i64,
    pub updated_at: String,
}
