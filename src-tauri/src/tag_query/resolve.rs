//! Expression resolution: `TagExpr` -> set of `block_id`s.

use futures_util::future::try_join_all;
use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::TagExpr;
use crate::error::AppError;
use crate::sql_utils::escape_like;

/// Resolve a single tag id to the set of `block_id`s that match it,
/// Honouring the inline-ref union semantics.
///
/// ** semantics (shared with `backlink::filters`):** the result
/// always unions inline `#[ULID]` references from `block_tag_refs` into
/// the explicit `block_tags` set. Inline references are treated
/// identically to explicit associations for tag-view counts and tag
/// filtering. `block_tag_inherited` (materialised inheritance cache) is
/// only included when `include_inherited` is true — by design,
/// inheritance applies only to explicit tags; an inline ref on a page
/// does not propagate to child blocks.
///
/// Deleted (`deleted_at IS NOT NULL`) blocks are excluded at every
/// UNION arm.
///
/// This is the single source of truth for the leaf SQL — both
/// `resolve_expr` (here) and `BacklinkFilter::HasTag`
/// (`backlink/filters.rs`) call it. Any future change to the
/// Union must happen here so both sites stay in lockstep.
pub(crate) async fn resolve_tag_leaves(
    pool: &SqlitePool,
    tag_id: &str,
    include_inherited: bool,
) -> Result<Vec<String>, AppError> {
    if include_inherited {
        let rows = sqlx::query_scalar!(
            "SELECT bt.block_id \
             FROM block_tags bt \
             JOIN blocks b ON b.id = bt.block_id \
             WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL \
             UNION \
             SELECT bti.block_id \
             FROM block_tag_inherited bti \
             JOIN blocks b ON b.id = bti.block_id \
             WHERE bti.tag_id = ?1 AND b.deleted_at IS NULL \
             UNION \
             SELECT btr.source_id AS block_id \
             FROM block_tag_refs btr \
             JOIN blocks b ON b.id = btr.source_id \
             WHERE btr.tag_id = ?1 AND b.deleted_at IS NULL",
            tag_id
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    } else {
        let rows = sqlx::query_scalar!(
            "SELECT bt.block_id FROM block_tags bt \
             JOIN blocks b ON b.id = bt.block_id \
             WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL \
             UNION \
             SELECT btr.source_id AS block_id \
             FROM block_tag_refs btr \
             JOIN blocks b ON b.id = btr.source_id \
             WHERE btr.tag_id = ?1 AND b.deleted_at IS NULL",
            tag_id
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }
}

/// Resolve a tag-name prefix to the set of `block_id`s whose tags match
/// The prefix, honouring the inline-ref union semantics.
///
/// `prefix` is the raw user-supplied prefix; LIKE wildcards (`%`, `_`,
/// `\`) inside it are escaped via [`escape_like`] before binding.
///
/// See [`resolve_tag_leaves`] for the shared semantics. This is
/// the single source of truth for the prefix leaf SQL — both
/// `resolve_expr` (here) and `BacklinkFilter::HasTagPrefix`
/// (`backlink/filters.rs`) call it.
///
/// **I-Search-10 — `tags_cache` lookup contract.** The query joins
/// `tags_cache → block_tags → blocks` and filters
/// `b.deleted_at IS NULL` on the *associating* block
/// (`b.id = bt.block_id`), NOT on the *tag* block (`tc.tag_id`). The
/// cache-rebuild contract in [`crate::cache::rebuild_tags_cache`]
/// owns the upstream filter set; this query trusts it.
pub(crate) async fn resolve_tag_prefix_leaves(
    pool: &SqlitePool,
    prefix: &str,
    include_inherited: bool,
) -> Result<Vec<String>, AppError> {
    let escaped = format!("{}%", escape_like(prefix));
    if include_inherited {
        let rows = sqlx::query_scalar!(
            "SELECT DISTINCT bt.block_id \
             FROM tags_cache tc \
             JOIN block_tags bt ON bt.tag_id = tc.tag_id \
             JOIN blocks b ON b.id = bt.block_id \
             WHERE tc.name LIKE ?1 ESCAPE '\\' \
               AND b.deleted_at IS NULL \
             UNION \
             SELECT DISTINCT bti.block_id \
             FROM tags_cache tc \
             JOIN block_tag_inherited bti ON bti.tag_id = tc.tag_id \
             JOIN blocks b ON b.id = bti.block_id \
             WHERE tc.name LIKE ?1 ESCAPE '\\' \
               AND b.deleted_at IS NULL \
             UNION \
             SELECT DISTINCT btr.source_id AS block_id \
             FROM tags_cache tc \
             JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
             JOIN blocks b ON b.id = btr.source_id \
             WHERE tc.name LIKE ?1 ESCAPE '\\' \
               AND b.deleted_at IS NULL",
            escaped
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    } else {
        let rows = sqlx::query_scalar!(
            "SELECT DISTINCT bt.block_id \
             FROM tags_cache tc \
             JOIN block_tags bt ON bt.tag_id = tc.tag_id \
             JOIN blocks b ON b.id = bt.block_id \
             WHERE tc.name LIKE ?1 ESCAPE '\\' \
               AND b.deleted_at IS NULL \
             UNION \
             SELECT DISTINCT btr.source_id AS block_id \
             FROM tags_cache tc \
             JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
             JOIN blocks b ON b.id = btr.source_id \
             WHERE tc.name LIKE ?1 ESCAPE '\\' \
               AND b.deleted_at IS NULL",
            escaped
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }
}

/// #1622 — bare id-set subquery (no `b.id IN (...)` wrapper) for a single
/// `TagExpr::Tag` leaf, suitable for composition under SQLite set
/// operators (`INTERSECT`/`UNION`/`EXCEPT`). Mirrors
/// [`resolve_tag_leaves`] EXACTLY — `block_tags` ∪ `block_tag_refs`
/// (∪ `block_tag_inherited` when inherited), each arm joining `blocks`
/// and filtering `b.deleted_at IS NULL`. `tag_id` is bound once per arm
/// (the compiler pushes 2 non-inherited / 3 inherited binds, in order).
///
/// Returns a column named `block_id` so the same shape composes whether
/// it is the only term or one term of a larger set expression.
///
/// #1661 — `pub(crate)` so the #414 leaf fast path in `query.rs` wraps
/// THIS exact body as `b.id IN (<body>)` instead of hand-duplicating the
/// SQL. The `tag_leaf_fast_path_clause_matches_shared_body` drift guard
/// pins that single-source invariant.
pub(crate) fn tag_leaf_subquery_body(include_inherited: bool) -> &'static str {
    if include_inherited {
        "SELECT bt.block_id \
         FROM block_tags bt JOIN blocks b ON b.id = bt.block_id \
         WHERE bt.tag_id = ? AND b.deleted_at IS NULL \
         UNION \
         SELECT btr.source_id \
         FROM block_tag_refs btr JOIN blocks b ON b.id = btr.source_id \
         WHERE btr.tag_id = ? AND b.deleted_at IS NULL \
         UNION \
         SELECT bti.block_id \
         FROM block_tag_inherited bti JOIN blocks b ON b.id = bti.block_id \
         WHERE bti.tag_id = ? AND b.deleted_at IS NULL"
    } else {
        "SELECT bt.block_id \
         FROM block_tags bt JOIN blocks b ON b.id = bt.block_id \
         WHERE bt.tag_id = ? AND b.deleted_at IS NULL \
         UNION \
         SELECT btr.source_id \
         FROM block_tag_refs btr JOIN blocks b ON b.id = btr.source_id \
         WHERE btr.tag_id = ? AND b.deleted_at IS NULL"
    }
}

/// #1622 — bare id-set subquery for a single `TagExpr::Prefix` leaf.
/// Mirrors [`resolve_tag_prefix_leaves`] EXACTLY: same UNION shape as the
/// tag leaf but joining `tags_cache tc` with `tc.name LIKE ? ESCAPE '\'`
/// and `SELECT DISTINCT`. The LIKE pattern is bound once per arm.
///
/// #1661 — `pub(crate)` so the #414 prefix-leaf fast path in `query.rs`
/// wraps THIS exact body (see [`tag_leaf_subquery_body`]).
pub(crate) fn prefix_leaf_subquery_body(include_inherited: bool) -> &'static str {
    if include_inherited {
        "SELECT DISTINCT bt.block_id \
         FROM tags_cache tc \
         JOIN block_tags bt ON bt.tag_id = tc.tag_id \
         JOIN blocks b ON b.id = bt.block_id \
         WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL \
         UNION \
         SELECT DISTINCT btr.source_id \
         FROM tags_cache tc \
         JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
         JOIN blocks b ON b.id = btr.source_id \
         WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL \
         UNION \
         SELECT DISTINCT bti.block_id \
         FROM tags_cache tc \
         JOIN block_tag_inherited bti ON bti.tag_id = tc.tag_id \
         JOIN blocks b ON b.id = bti.block_id \
         WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL"
    } else {
        "SELECT DISTINCT bt.block_id \
         FROM tags_cache tc \
         JOIN block_tags bt ON bt.tag_id = tc.tag_id \
         JOIN blocks b ON b.id = bt.block_id \
         WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL \
         UNION \
         SELECT DISTINCT btr.source_id \
         FROM tags_cache tc \
         JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
         JOIN blocks b ON b.id = btr.source_id \
         WHERE tc.name LIKE ? ESCAPE '\\' AND b.deleted_at IS NULL"
    }
}

/// #1622 — recursively compile a `TagExpr` boolean tree into a SINGLE
/// id-set subquery (the SELECT body, no surrounding parentheses) plus the
/// ordered list of bind values for its leaf placeholders.
///
/// The returned subquery yields exactly the id set that `resolve_expr`
/// would compute for the same expression, expressed entirely in SQL so
/// that the caller can wrap it as `b.id IN (<subquery>)` and let SQLite
/// apply the cursor/`LIMIT` keyset without ever materialising the full
/// set into Rust + JSON. The compilation scheme is:
///
///   * `Tag` / `Prefix`  → the leaf UNION body (`tag_leaf_subquery_body` /
///     `prefix_leaf_subquery_body`).
///   * `And(children)`   → `<c0> INTERSECT <c1> INTERSECT …` — each child
///     wrapped as `SELECT block_id FROM (<child>)` so SQLite's flat,
///     equal-precedence, left-associative compound-SELECT grammar cannot
///     mis-associate a child that is itself a compound (e.g. an inner
///     `Or`). An empty `And` resolves to the EMPTY set (matches
///     `resolve_expr`).
///   * `Or(children)`    → `<c0> UNION <c1> UNION …` (same wrapping). An
///     empty `Or` resolves to the EMPTY set.
///   * `Not(inner)`      → `SELECT id AS block_id FROM blocks WHERE
///     b.deleted_at IS NULL AND id NOT IN (<inner>)` — the complement
///     universe is precisely "all non-deleted blocks", byte-identical to
///     `resolve_expr`'s `Not` (including the empty-inner case, where
///     `NOT IN (<empty>)` is true for every row → the whole universe).
///     `blocks.id` and every leaf id column are NOT NULL, so the
///     `NOT IN`/NULL footgun cannot arise.
///
/// All leaf values (`tag_id`, the LIKE pattern) are BOUND positionally in
/// traversal order — never string-interpolated — so the assembled SQL is
/// injection-safe. The caller MUST bind `binds` in the returned order
/// before the shared projection binds.
pub(crate) fn compile_candidate_subquery(
    expr: &TagExpr,
    include_inherited: bool,
) -> (String, Vec<String>) {
    let mut binds: Vec<String> = Vec::new();
    let sql = build_subquery(expr, include_inherited, &mut binds);
    (sql, binds)
}

/// The empty id-set subquery (zero rows). Used for empty `And`/`Or`,
/// which `resolve_expr` resolves to the empty set.
const EMPTY_SUBQUERY: &str = "SELECT block_id FROM (SELECT NULL AS block_id) WHERE 0";

fn build_subquery(expr: &TagExpr, include_inherited: bool, binds: &mut Vec<String>) -> String {
    match expr {
        TagExpr::Tag(tag_id) => {
            let arms = if include_inherited { 3 } else { 2 };
            for _ in 0..arms {
                binds.push(tag_id.clone());
            }
            tag_leaf_subquery_body(include_inherited).to_string()
        }
        TagExpr::Prefix(prefix) => {
            let escaped = format!("{}%", escape_like(prefix));
            let arms = if include_inherited { 3 } else { 2 };
            for _ in 0..arms {
                binds.push(escaped.clone());
            }
            prefix_leaf_subquery_body(include_inherited).to_string()
        }
        TagExpr::And(children) => compose_set_op(children, include_inherited, binds, "INTERSECT"),
        TagExpr::Or(children) => compose_set_op(children, include_inherited, binds, "UNION"),
        TagExpr::Not(inner) => {
            // The inner ids are EXCLUDED from the full non-deleted block
            // universe. Wrapping `inner` as `(<inner>)` keeps a compound
            // inner (e.g. `Or`) correctly scoped inside `NOT IN`.
            let inner_sql = build_subquery(inner, include_inherited, binds);
            format!(
                "SELECT b.id AS block_id FROM blocks b \
                 WHERE b.deleted_at IS NULL \
                 AND b.id NOT IN ({inner_sql})"
            )
        }
    }
}

/// Compose a list of child subqueries with a SQLite set operator,
/// wrapping each child as `SELECT block_id FROM (<child>)` so that a
/// child which is itself a compound SELECT associates correctly under
/// SQLite's flat compound-SELECT grammar.
fn compose_set_op(
    children: &[TagExpr],
    include_inherited: bool,
    binds: &mut Vec<String>,
    op: &str,
) -> String {
    if children.is_empty() {
        return EMPTY_SUBQUERY.to_string();
    }
    let mut parts: Vec<String> = Vec::with_capacity(children.len());
    for child in children {
        let child_sql = build_subquery(child, include_inherited, binds);
        parts.push(format!("SELECT block_id FROM ({child_sql})"));
    }
    parts.join(&format!(" {op} "))
}

/// Resolve a `TagExpr` into the set of matching `block_id`s.
///
/// #1622 — `eval_tag_query` now compiles shallow boolean trees
/// (`depth <= TagExpr::MAX_PUSHDOWN_DEPTH`) to a single pushed-down
/// candidate subquery via [`compile_candidate_subquery`], so the full set
/// is never materialised in Rust for those. This resolver remains the
/// canonical SEMANTICS, the FALLBACK for trees too deep to express safely
/// as nested SQL (SQLite's `SQLITE_MAX_EXPR_DEPTH`), and the
/// differential-test ORACLE the pushed-down path is proven identical to.
pub fn resolve_expr<'a>(
    pool: &'a SqlitePool,
    expr: &'a TagExpr,
    include_inherited: bool,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<FxHashSet<String>, AppError>> + Send + 'a>,
> {
    Box::pin(async move {
        match expr {
            // Leaf SQL lives in `resolve_tag_leaves` /
            // `resolve_tag_prefix_leaves` so backlink filters share
            // the same union semantics. See those helpers for details.
            TagExpr::Tag(tag_id) => {
                let rows = resolve_tag_leaves(pool, tag_id, include_inherited).await?;
                Ok(rows.into_iter().collect())
            }
            TagExpr::Prefix(prefix) => {
                let rows = resolve_tag_prefix_leaves(pool, prefix, include_inherited).await?;
                Ok(rows.into_iter().collect())
            }
            TagExpr::And(exprs) => {
                if exprs.is_empty() {
                    return Ok(FxHashSet::default());
                }
                // Resolve all sub-expressions concurrently (mirrors
                // `BacklinkFilter::And` in `backlink::filters`), turning N
                // serial DB round-trips into N concurrent ones. The final
                // intersection is order-independent, so a different completion
                // Order from the join still yields the same set.
                let futures = exprs
                    .iter()
                    .map(|e| resolve_expr(pool, e, include_inherited));
                let results = try_join_all(futures).await?;
                let mut iter = results.into_iter();
                let mut result = iter.next().unwrap();
                for set in iter {
                    result.retain(|id| set.contains(id));
                }
                Ok(result)
            }
            TagExpr::Or(exprs) => {
                // Resolve all sub-expressions concurrently (mirrors
                // `BacklinkFilter::Or` in `backlink::filters`). Union is
                // Commutative, so completion order is irrelevant.
                let futures = exprs
                    .iter()
                    .map(|e| resolve_expr(pool, e, include_inherited));
                let results = try_join_all(futures).await?;
                let mut combined: FxHashSet<String> = FxHashSet::default();
                for set in results {
                    combined.extend(set);
                }
                Ok(combined)
            }
            TagExpr::Not(inner) => {
                let inner_set: FxHashSet<String> =
                    resolve_expr(pool, inner, include_inherited).await?;
                if inner_set.is_empty() {
                    let rows =
                        sqlx::query_scalar!("SELECT id FROM blocks WHERE deleted_at IS NULL",)
                            .fetch_all(pool)
                            .await?;
                    return Ok(rows.into_iter().collect());
                }
                let json_ids = serde_json::to_string(&inner_set.iter().collect::<Vec<_>>())
                    .map_err(|e| AppError::InvalidOperation(e.to_string()))?;
                Ok(sqlx::query_scalar!(
                    "SELECT id FROM blocks WHERE deleted_at IS NULL \
                     AND id NOT IN (SELECT value FROM json_each(?))",
                    json_ids
                )
                .fetch_all(pool)
                .await?
                .into_iter()
                .collect())
            }
        }
    })
}

/// CTE-based tag resolution — kept as correctness oracle for the
/// P-4 materialized `block_tag_inherited` table.
///
/// Note: this oracle intentionally does NOT UNION
/// `block_tag_refs` into the result set. It remains the oracle of the
/// **explicit-only + inherited** semantics (i.e. what the world looked
/// Like before). The existing oracle tests never insert
/// `block_tag_refs` rows, so they continue to produce identical results
/// between the oracle and `resolve_expr`. New targeted tests that
/// exercise the union behaviour assert against `resolve_expr` directly
/// instead of through the oracle — this keeps the oracle's scope
/// narrowly focused on the `block_tag_inherited` materialisation
/// correctness question it was designed to answer.
#[cfg(test)]
pub(crate) fn resolve_expr_cte<'a>(
    pool: &'a SqlitePool,
    expr: &'a TagExpr,
    include_inherited: bool,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<FxHashSet<String>, AppError>> + Send + 'a>,
> {
    Box::pin(async move {
        match expr {
            TagExpr::Tag(tag_id) if include_inherited => {
                // Bound `depth < 100` on the recursive member to match
                // `tag_inheritance::rebuild_all` and AGENTS.md invariant #9
                // (no runaway recursion on corrupted parent_id chains).
                let rows = sqlx::query_scalar::<_, String>(
                    "WITH RECURSIVE tagged_tree(id, depth) AS ( \
                         SELECT bt.block_id AS id, 0 AS depth \
                         FROM block_tags bt \
                         JOIN blocks b ON b.id = bt.block_id \
                         WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL \
                         UNION ALL \
                         SELECT b.id, tt.depth + 1 \
                         FROM blocks b \
                         JOIN tagged_tree tt ON b.parent_id = tt.id \
                         WHERE b.deleted_at IS NULL AND tt.depth < 100 \
                     ) \
                     SELECT DISTINCT id FROM tagged_tree",
                )
                .bind(tag_id)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
            }
            TagExpr::Prefix(prefix) if include_inherited => {
                let escaped = format!("{}%", escape_like(prefix));
                // Bound `depth < 100` on the recursive member — see comment in
                // The `Tag` branch above.
                let rows = sqlx::query_scalar::<_, String>(
                    "WITH RECURSIVE tagged_tree(id, depth) AS ( \
                         SELECT DISTINCT bt.block_id AS id, 0 AS depth \
                         FROM tags_cache tc \
                         JOIN block_tags bt ON bt.tag_id = tc.tag_id \
                         JOIN blocks b ON b.id = bt.block_id \
                         WHERE tc.name LIKE ?1 ESCAPE '\\' \
                           AND b.deleted_at IS NULL \
                         UNION ALL \
                         SELECT b.id, tt.depth + 1 \
                         FROM blocks b \
                         JOIN tagged_tree tt ON b.parent_id = tt.id \
                         WHERE b.deleted_at IS NULL AND tt.depth < 100 \
                     ) \
                     SELECT DISTINCT id FROM tagged_tree",
                )
                .bind(&escaped)
                .fetch_all(pool)
                .await?;
                Ok(rows.into_iter().collect())
            }
            _ => resolve_expr(pool, expr, include_inherited).await,
        }
    })
}

#[cfg(test)]
mod tests;
