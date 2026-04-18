//! Expression resolution: `TagExpr` -> set of `block_id`s.

use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::TagExpr;
use crate::error::AppError;
use crate::sql_utils::escape_like;

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
            TagExpr::Tag(tag_id) => {
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
                         WHERE bti.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0",
                    )
                    .bind(tag_id)
                    .fetch_all(pool)
                    .await?;
                    Ok(rows.into_iter().collect())
                } else {
                    let rows = sqlx::query_scalar!(
                        "SELECT bt.block_id FROM block_tags bt \
                         JOIN blocks b ON b.id = bt.block_id \
                         WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0",
                        tag_id
                    )
                    .fetch_all(pool)
                    .await?;
                    Ok(rows.into_iter().collect())
                }
            }
            TagExpr::Prefix(prefix) => {
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
                           AND b.deleted_at IS NULL AND b.is_conflict = 0",
                    )
                    .bind(&escaped)
                    .fetch_all(pool)
                    .await?;
                    Ok(rows.into_iter().collect())
                } else {
                    let rows = sqlx::query_scalar!(
                        "SELECT DISTINCT bt.block_id \
                         FROM tags_cache tc \
                         JOIN block_tags bt ON bt.tag_id = tc.tag_id \
                         JOIN blocks b ON b.id = bt.block_id \
                         WHERE tc.name LIKE ?1 ESCAPE '\\' \
                           AND b.deleted_at IS NULL AND b.is_conflict = 0",
                        escaped
                    )
                    .fetch_all(pool)
                    .await?;
                    Ok(rows.into_iter().collect())
                }
            }
            TagExpr::And(exprs) => {
                if exprs.is_empty() {
                    return Ok(FxHashSet::default());
                }
                let mut iter = exprs.iter();
                let mut result: FxHashSet<String> =
                    resolve_expr(pool, iter.next().unwrap(), include_inherited).await?;
                for e in iter {
                    let set: FxHashSet<String> = resolve_expr(pool, e, include_inherited).await?;
                    result.retain(|id| set.contains(id));
                }
                Ok(result)
            }
            TagExpr::Or(exprs) => {
                let mut result: FxHashSet<String> = FxHashSet::default();
                for e in exprs {
                    let set: FxHashSet<String> = resolve_expr(pool, e, include_inherited).await?;
                    result.extend(set);
                }
                Ok(result)
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
                let rows = sqlx::query_scalar::<_, String>(
                    "WITH RECURSIVE tagged_tree AS ( \
                         SELECT bt.block_id AS id \
                         FROM block_tags bt \
                         JOIN blocks b ON b.id = bt.block_id \
                         WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
                         UNION ALL \
                         SELECT b.id \
                         FROM blocks b \
                         JOIN tagged_tree tt ON b.parent_id = tt.id \
                         WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
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
                let rows = sqlx::query_scalar::<_, String>(
                    "WITH RECURSIVE tagged_tree AS ( \
                         SELECT DISTINCT bt.block_id AS id \
                         FROM tags_cache tc \
                         JOIN block_tags bt ON bt.tag_id = tc.tag_id \
                         JOIN blocks b ON b.id = bt.block_id \
                         WHERE tc.name LIKE ?1 ESCAPE '\\' \
                           AND b.deleted_at IS NULL AND b.is_conflict = 0 \
                         UNION ALL \
                         SELECT b.id \
                         FROM blocks b \
                         JOIN tagged_tree tt ON b.parent_id = tt.id \
                         WHERE b.deleted_at IS NULL AND b.is_conflict = 0 \
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
