//! Expression resolution: `TagExpr` -> set of `block_id`s.

use futures_util::future::try_join_all;
use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::TagExpr;
use crate::error::AppError;
use crate::sql_utils::escape_like;

/// Resolve a single tag id to the set of `block_id`s that match it,
/// honouring the UX-250 inline-ref union semantics.
///
/// **UX-250 semantics (shared with `backlink::filters`):** the result
/// always unions inline `#[ULID]` references from `block_tag_refs` into
/// the explicit `block_tags` set. Inline references are treated
/// identically to explicit associations for tag-view counts and tag
/// filtering. `block_tag_inherited` (materialised inheritance cache) is
/// only included when `include_inherited` is true — by design,
/// inheritance applies only to explicit tags; an inline ref on a page
/// does not propagate to child blocks.
///
/// Deleted (`deleted_at IS NOT NULL`) and conflict (`is_conflict = 1`)
/// blocks are excluded at every UNION arm.
///
/// This is the single source of truth for the leaf SQL — both
/// `resolve_expr` (here) and `BacklinkFilter::HasTag`
/// (`backlink/filters.rs`) call it. Any future change to the UX-250
/// union must happen here so both sites stay in lockstep (MAINT-143).
pub(crate) async fn resolve_tag_leaves(
    pool: &SqlitePool,
    tag_id: &str,
    include_inherited: bool,
) -> Result<Vec<String>, AppError> {
    if include_inherited {
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT bt.block_id \
             FROM block_tags bt \
             JOIN blocks b ON b.id = bt.block_id \
             WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION \
             SELECT bti.block_id \
             FROM block_tag_inherited bti \
             JOIN blocks b ON b.id = bti.block_id \
             WHERE bti.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION \
             SELECT btr.source_id AS block_id \
             FROM block_tag_refs btr \
             JOIN blocks b ON b.id = btr.source_id \
             WHERE btr.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0",
        )
        .bind(tag_id)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    } else {
        let rows = sqlx::query_scalar!(
            "SELECT bt.block_id FROM block_tags bt \
             JOIN blocks b ON b.id = bt.block_id \
             WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION \
             SELECT btr.source_id AS block_id \
             FROM block_tag_refs btr \
             JOIN blocks b ON b.id = btr.source_id \
             WHERE btr.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0",
            tag_id
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }
}

/// Resolve a tag-name prefix to the set of `block_id`s whose tags match
/// the prefix, honouring the UX-250 inline-ref union semantics.
///
/// `prefix` is the raw user-supplied prefix; LIKE wildcards (`%`, `_`,
/// `\`) inside it are escaped via [`escape_like`] before binding.
///
/// See [`resolve_tag_leaves`] for the shared UX-250 semantics. This is
/// the single source of truth for the prefix leaf SQL — both
/// `resolve_expr` (here) and `BacklinkFilter::HasTagPrefix`
/// (`backlink/filters.rs`) call it (MAINT-143).
///
/// **I-Search-10 — `tags_cache` conflict-tag invariant.** The query
/// joins `tags_cache → block_tags → blocks` and filters
/// `b.deleted_at IS NULL AND b.is_conflict = 0` on the *associating*
/// block (`b.id = bt.block_id`), NOT on the *tag* block
/// (`tc.tag_id`). Conflict-copy tag blocks would surface here if
/// `tags_cache` ever included them, but the cache-rebuild contract in
/// [`crate::cache::rebuild_tags_cache`] explicitly excludes
/// `is_conflict = 1` tag rows. The result is correct in practice; the
/// SQL contract just doesn't make that dependency explicit. If the
/// cache-rebuild rules ever change to include conflict tag rows, add a
/// defensive `JOIN blocks t ON t.id = tc.tag_id WHERE t.is_conflict = 0`
/// here (and in [`resolve_tag_leaves`] for `HasTag` parity).
pub(crate) async fn resolve_tag_prefix_leaves(
    pool: &SqlitePool,
    prefix: &str,
    include_inherited: bool,
) -> Result<Vec<String>, AppError> {
    let escaped = format!("{}%", escape_like(prefix));
    if include_inherited {
        let rows = sqlx::query_scalar::<_, String>(
            "SELECT DISTINCT bt.block_id \
             FROM tags_cache tc \
             JOIN block_tags bt ON bt.tag_id = tc.tag_id \
             JOIN blocks b ON b.id = bt.block_id \
             WHERE tc.name LIKE ?1 ESCAPE '\\' \
               AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION \
             SELECT DISTINCT bti.block_id \
             FROM tags_cache tc \
             JOIN block_tag_inherited bti ON bti.tag_id = tc.tag_id \
             JOIN blocks b ON b.id = bti.block_id \
             WHERE tc.name LIKE ?1 ESCAPE '\\' \
               AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION \
             SELECT DISTINCT btr.source_id AS block_id \
             FROM tags_cache tc \
             JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
             JOIN blocks b ON b.id = btr.source_id \
             WHERE tc.name LIKE ?1 ESCAPE '\\' \
               AND b.deleted_at IS NULL AND b.is_conflict = 0",
        )
        .bind(&escaped)
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
               AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION \
             SELECT DISTINCT btr.source_id AS block_id \
             FROM tags_cache tc \
             JOIN block_tag_refs btr ON btr.tag_id = tc.tag_id \
             JOIN blocks b ON b.id = btr.source_id \
             WHERE tc.name LIKE ?1 ESCAPE '\\' \
               AND b.deleted_at IS NULL AND b.is_conflict = 0",
            escaped
        )
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }
}

/// Resolve a `TagExpr` into the set of matching `block_id`s.
pub fn resolve_expr<'a>(
    pool: &'a SqlitePool,
    expr: &'a TagExpr,
    include_inherited: bool,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<FxHashSet<String>, AppError>> + Send + 'a>,
> {
    Box::pin(async move {
        match expr {
            // UX-250: leaf SQL lives in `resolve_tag_leaves` /
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
                // order from the join still yields the same set. (L-85)
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
                // commutative, so completion order is irrelevant. (L-85)
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
                    let rows = sqlx::query_scalar::<_, String>(
                        "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0",
                    )
                    .fetch_all(pool)
                    .await?;
                    return Ok(rows.into_iter().collect());
                }
                let json_ids = serde_json::to_string(&inner_set.iter().collect::<Vec<_>>())
                    .map_err(|e| AppError::InvalidOperation(e.to_string()))?;
                Ok(sqlx::query_scalar::<_, String>(
                    "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0 \
                     AND id NOT IN (SELECT value FROM json_each(?))",
                )
                .bind(&json_ids)
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
/// UX-250 note: this oracle intentionally does NOT UNION
/// `block_tag_refs` into the result set. It remains the oracle of the
/// **explicit-only + inherited** semantics (i.e. what the world looked
/// like before UX-250). The existing oracle tests never insert
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
                // (no runaway recursion on corrupted parent_id chains). (M-59)
                let rows = sqlx::query_scalar::<_, String>(
                    "WITH RECURSIVE tagged_tree(id, depth) AS ( \
                         SELECT bt.block_id AS id, 0 AS depth \
                         FROM block_tags bt \
                         JOIN blocks b ON b.id = bt.block_id \
                         WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
                         UNION ALL \
                         SELECT b.id, tt.depth + 1 \
                         FROM blocks b \
                         JOIN tagged_tree tt ON b.parent_id = tt.id \
                         WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND tt.depth < 100 \
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
                // the `Tag` branch above. (M-59)
                let rows = sqlx::query_scalar::<_, String>(
                    "WITH RECURSIVE tagged_tree(id, depth) AS ( \
                         SELECT DISTINCT bt.block_id AS id, 0 AS depth \
                         FROM tags_cache tc \
                         JOIN block_tags bt ON bt.tag_id = tc.tag_id \
                         JOIN blocks b ON b.id = bt.block_id \
                         WHERE tc.name LIKE ?1 ESCAPE '\\' \
                           AND b.deleted_at IS NULL AND b.is_conflict = 0 \
                         UNION ALL \
                         SELECT b.id, tt.depth + 1 \
                         FROM blocks b \
                         JOIN tagged_tree tt ON b.parent_id = tt.id \
                         WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND tt.depth < 100 \
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
