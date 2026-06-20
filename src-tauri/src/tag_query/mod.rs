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

use serde::{Deserialize, Serialize};

/// Boolean expression tree for tag queries.
///
/// # IPC wire format (#1472)
///
/// Adjacently-tagged via `#[serde(tag = "type", content = "value")]`, the
/// same shape `SpaceScope` (`space.rs`) and `CursorValue` (`query/engine.rs`)
/// use for tuple/newtype variants. Internal tagging (`#[serde(tag = "type")]`,
/// as `FilterExpr` uses) cannot wrap the non-struct newtype payloads here
/// (`Tag(String)` / `Not(Box<TagExpr>)`); adjacent tagging keeps the existing
/// tuple-variant shape — so every in-tree constructor (`TagExpr::Tag(..)`,
/// `TagExpr::And(vec![..])`, …) is unchanged — while still emitting a
/// specta-expressible, self-describing TS discriminated union:
///
/// - `Tag("urgent")`      → `{ "type": "Tag",    "value": "urgent" }`
/// - `Prefix("work/")`    → `{ "type": "Prefix", "value": "work/" }`
/// - `And([a, b])`        → `{ "type": "And",    "value": [a, b] }`
/// - `Or([a, b])`         → `{ "type": "Or",     "value": [a, b] }`
/// - `Not(a)`             → `{ "type": "Not",    "value": a }`
///
/// The recursion bottoms out at the `Tag`/`Prefix` leaves, so the type is a
/// self-referential discriminated union specta emits losslessly. Untrusted
/// trees deserialised at the IPC boundary MUST be passed through
/// [`TagExpr::validate_depth`] before resolution — `query_by_tag_expr`
/// (`commands/tags.rs`) is the gate (see also `eval_tag_query`'s own
/// `validate_depth` call for the And/Or/Not arms).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type", content = "value")]
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

    /// #1622 — maximum boolean-tree depth for which `eval_tag_query`
    /// compiles the expression to a SINGLE pushed-down candidate subquery
    /// (`And→INTERSECT`, `Or→UNION`, `Not→NOT IN`). Beyond this depth the
    /// query falls back to the legacy `resolve_expr` materialisation so it
    /// stays correct.
    ///
    /// **Why a cap is required (not imagined — measured).** Each nesting
    /// level wraps the inner subquery in another `NOT IN (...)` / `SELECT
    /// FROM (...)`, growing SQLite's parser expression tree. A pure `Not`
    /// chain is the worst case: SQLite's hard `SQLITE_MAX_EXPR_DEPTH = 1000`
    /// is hit at a chain of 23 nested `Not`s (measured), so a depth-50
    /// `MAX_DEPTH` tree could blow the SQL parser. `15` sits well under the
    /// observed 22-level ceiling (≈645/1000 expr-depth used) with ample
    /// headroom, and real tag queries are far shallower (a handful of
    /// And/Or leaves, a single Not), so the fallback is effectively never
    /// taken in practice.
    pub const MAX_PUSHDOWN_DEPTH: usize = 15;

    /// Boolean-tree nesting depth (leaves are depth 0; each `And`/`Or`/`Not`
    /// adds one over its deepest child). Used to decide whether the pushed-
    /// down candidate-subquery compilation is safe (`<= MAX_PUSHDOWN_DEPTH`)
    /// or the legacy materialisation fallback must be used.
    pub fn depth(&self) -> usize {
        match self {
            TagExpr::Tag(_) | TagExpr::Prefix(_) => 0,
            TagExpr::And(exprs) | TagExpr::Or(exprs) => {
                1 + exprs.iter().map(TagExpr::depth).max().unwrap_or(0)
            }
            TagExpr::Not(inner) => 1 + inner.depth(),
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
