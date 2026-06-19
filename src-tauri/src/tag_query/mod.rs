//! Boolean tag query evaluation (p3-t7, p3-t8).

mod query;
mod resolve;

pub use query::{
    eval_tag_query, list_all_tags_in_space, list_inherited_tags_for_block, list_tags_by_prefix,
    list_tags_for_block,
};
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

impl TagExpr {
    /// Maximum boolean-tree nesting depth accepted from any caller (#1597).
    ///
    /// Mirrors `FilterExpr::MAX_DEPTH` (`filters/expr.rs`) so the two
    /// boolean-tree evaluators reject pathological nesting identically.
    /// `resolve_expr` recurses via `Box::pin` with `try_join_all` fan-out
    /// and is otherwise unbounded; this gate is checked at the resolution
    /// entry point so a too-deep tree is rejected before recursion begins.
    pub const MAX_DEPTH: usize = 50;

    /// Reject a `TagExpr` whose nesting exceeds [`TagExpr::MAX_DEPTH`]
    /// (#1597). Mirrors [`FilterExpr::validate_depth`]: the walk checks the
    /// bound at the TOP of each frame, BEFORE recursing into children, so it
    /// bounds its own recursion to `MAX_DEPTH + 1` frames and cannot itself
    /// overflow the stack on a pathologically deep tree.
    pub fn validate_depth(&self) -> Result<(), crate::error::AppError> {
        self.check_depth(0)
    }

    fn check_depth(&self, depth: usize) -> Result<(), crate::error::AppError> {
        if depth > Self::MAX_DEPTH {
            return Err(crate::error::AppError::Validation(format!(
                "Tag query nesting depth exceeds {}",
                Self::MAX_DEPTH
            )));
        }
        match self {
            TagExpr::Tag(_) | TagExpr::Prefix(_) => Ok(()),
            TagExpr::And(exprs) | TagExpr::Or(exprs) => {
                for e in exprs {
                    e.check_depth(depth + 1)?;
                }
                Ok(())
            }
            TagExpr::Not(inner) => inner.check_depth(depth + 1),
        }
    }
}

/// Row from `tags_cache`, used by `list_tags_by_prefix`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct TagCacheRow {
    pub tag_id: String,
    pub name: String,
    pub usage_count: i64,
    pub updated_at: String,
}
