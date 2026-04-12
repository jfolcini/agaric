//! Expression resolution: `TagExpr` -> set of `block_id`s.

use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::{escape_like, TagExpr};
use crate::error::AppError;

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
mod tests {
    use super::super::TagExpr;
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }
    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .execute(pool)
            .await
            .unwrap();
    }
    async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }
    async fn insert_tag_cache(pool: &SqlitePool, tag_id: &str, name: &str, usage_count: i64) {
        sqlx::query("INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) VALUES (?, ?, ?, '2025-01-01T00:00:00Z')")
            .bind(tag_id).bind(name).bind(usage_count).execute(pool).await.unwrap();
    }
    async fn soft_delete(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }
    async fn mark_conflict(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }
    async fn insert_child_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: &str,
    ) {
        sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, position) VALUES (?, ?, ?, ?, 1)")
            .bind(id).bind(block_type).bind(content).bind(parent_id).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn resolve_tag_returns_correct_block_ids() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_block(&pool, "BLK_3", "content", "three").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Tag("TAG_A".into()), false)
            .await
            .unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.contains("BLK_1"));
        assert!(result.contains("BLK_2"));
        assert!(!result.contains("BLK_3"));
    }
    #[tokio::test]
    async fn resolve_tag_excludes_deleted_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        soft_delete(&pool, "BLK_2").await;
        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Tag("TAG_A".into()), false)
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert!(result.contains("BLK_1"));
    }
    #[tokio::test]
    async fn resolve_tag_excludes_conflict_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        mark_conflict(&pool, "BLK_2").await;
        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Tag("TAG_A".into()), false)
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert!(result.contains("BLK_1"));
    }
    #[tokio::test]
    async fn resolve_tag_unknown_tag_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result: FxHashSet<String> =
            resolve_expr(&pool, &TagExpr::Tag("NONEXISTENT".into()), false)
                .await
                .unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn resolve_prefix_matches_hierarchical_tags() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
        insert_block(&pool, "TAG_WE", "tag", "work/email").await;
        insert_block(&pool, "TAG_P", "tag", "personal").await;
        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 2).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 1).await;
        insert_tag_cache(&pool, "TAG_P", "personal", 3).await;
        insert_block(&pool, "BLK_1", "content", "meeting notes").await;
        insert_block(&pool, "BLK_2", "content", "email draft").await;
        insert_block(&pool, "BLK_3", "content", "personal diary").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_WM").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_WE").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_P").await;
        let result: FxHashSet<String> =
            resolve_expr(&pool, &TagExpr::Prefix("work/".into()), false)
                .await
                .unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.contains("BLK_1"));
        assert!(result.contains("BLK_2"));
    }
    #[tokio::test]
    async fn resolve_prefix_no_match_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;
        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Prefix("zzz_".into()), false)
            .await
            .unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn resolve_prefix_unions_block_ids_across_tags() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
        insert_block(&pool, "TAG_WE", "tag", "work/email").await;
        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 1).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 1).await;
        insert_block(&pool, "BLK_1", "content", "overlap").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_WM").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_WE").await;
        let result: FxHashSet<String> =
            resolve_expr(&pool, &TagExpr::Prefix("work/".into()), false)
                .await
                .unwrap();
        assert_eq!(result.len(), 1);
    }
    #[tokio::test]
    async fn resolve_and_returns_intersection() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_block(&pool, "BLK_3", "content", "three").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_B").await;
        let expr = TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ]);
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(result.len(), 1);
        assert!(result.contains("BLK_1"));
    }
    #[tokio::test]
    async fn resolve_and_empty_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::And(vec![]), false)
            .await
            .unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn resolve_and_disjoint_tags_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;
        let expr = TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ]);
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn resolve_or_returns_union() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;
        let expr = TagExpr::Or(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ]);
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(result.len(), 2);
    }
    #[tokio::test]
    async fn resolve_or_empty_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Or(vec![]), false)
            .await
            .unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn resolve_or_deduplicates_shared_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "shared").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        let expr = TagExpr::Or(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ]);
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(result.len(), 1);
    }
    #[tokio::test]
    async fn resolve_not_returns_complement() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "tagged").await;
        insert_block(&pool, "BLK_2", "content", "untagged").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        let expr = TagExpr::Not(Box::new(TagExpr::Tag("TAG_A".into())));
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();
        assert!(result.contains("BLK_2"));
        assert!(result.contains("TAG_A"));
        assert!(!result.contains("BLK_1"));
    }
    #[tokio::test]
    async fn resolve_not_excludes_deleted_from_universal_set() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "tagged").await;
        insert_block(&pool, "BLK_2", "content", "deleted").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        soft_delete(&pool, "BLK_2").await;
        let expr = TagExpr::Not(Box::new(TagExpr::Tag("TAG_A".into())));
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();
        assert!(!result.contains("BLK_2"));
    }
    #[tokio::test]
    async fn resolve_nested_and_or() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "TAG_C", "tag", "gamma").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_block(&pool, "BLK_3", "content", "three").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_C").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_A").await;
        let expr = TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Or(vec![
                TagExpr::Tag("TAG_B".into()),
                TagExpr::Tag("TAG_C".into()),
            ]),
        ]);
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.contains("BLK_1"));
        assert!(result.contains("BLK_2"));
        assert!(!result.contains("BLK_3"));
    }
    #[tokio::test]
    async fn resolve_expr_tag_single_match() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_SINGLE", "tag", "solo").await;
        insert_block(&pool, "BLK_SOLO", "content", "only one").await;
        insert_tag_assoc(&pool, "BLK_SOLO", "TAG_SINGLE").await;
        let result = resolve_expr(&pool, &TagExpr::Tag("TAG_SINGLE".into()), false)
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert!(result.contains("BLK_SOLO"));
    }
    #[tokio::test]
    async fn resolve_expr_prefix_direct() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_PD1", "tag", "proj/alpha").await;
        insert_tag_cache(&pool, "TAG_PD1", "proj/alpha", 1).await;
        insert_block(&pool, "BLK_PD1", "content", "alpha work").await;
        insert_tag_assoc(&pool, "BLK_PD1", "TAG_PD1").await;
        let result = resolve_expr(&pool, &TagExpr::Prefix("proj/".into()), false)
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert!(result.contains("BLK_PD1"));
    }
    #[tokio::test]
    async fn resolve_expr_and_empty_direct() {
        let (pool, _dir) = test_pool().await;
        let result = resolve_expr(&pool, &TagExpr::And(vec![]), false)
            .await
            .unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn resolve_expr_not_direct() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_ND", "tag", "exclude-me").await;
        insert_block(&pool, "BLK_ND1", "content", "tagged").await;
        insert_block(&pool, "BLK_ND2", "content", "untagged").await;
        insert_tag_assoc(&pool, "BLK_ND1", "TAG_ND").await;
        let expr = TagExpr::Not(Box::new(TagExpr::Tag("TAG_ND".into())));
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert!(!result.contains("BLK_ND1"));
        assert!(result.contains("BLK_ND2"));
        assert!(result.contains("TAG_ND"));
    }
    #[tokio::test]
    async fn resolve_prefix_escapes_like_wildcards() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "100%_special").await;
        insert_block(&pool, "TAG_B", "tag", "10099_other").await;
        insert_tag_cache(&pool, "TAG_A", "100%_special", 1).await;
        insert_tag_cache(&pool, "TAG_B", "10099_other", 2).await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;
        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Prefix("100%".into()), false)
            .await
            .unwrap();
        assert_eq!(result.len(), 1);
        assert!(result.contains("BLK_1"));
        assert!(!result.contains("BLK_2"));
    }
    #[tokio::test]
    async fn resolve_tag_with_inheritance_includes_descendants() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_T1", "tag", "t1").await;
        insert_block(&pool, "PAGE_A", "page", "tagged page").await;
        insert_child_block(&pool, "CHILD_1", "content", "child one", "PAGE_A").await;
        insert_child_block(&pool, "CHILD_2", "content", "child two", "PAGE_A").await;
        insert_tag_assoc(&pool, "PAGE_A", "TAG_T1").await;
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();
        let result_inherited = resolve_expr(&pool, &TagExpr::Tag("TAG_T1".into()), true)
            .await
            .unwrap();
        assert!(result_inherited.contains("PAGE_A"));
        assert!(result_inherited.contains("CHILD_1"));
        assert!(result_inherited.contains("CHILD_2"));
        assert_eq!(result_inherited.len(), 3);
        let result_direct = resolve_expr(&pool, &TagExpr::Tag("TAG_T1".into()), false)
            .await
            .unwrap();
        assert_eq!(result_direct.len(), 1);
    }
    #[tokio::test]
    async fn resolve_tag_with_inheritance_multi_level() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_T2", "tag", "t2").await;
        insert_block(&pool, "PAGE_B", "page", "root page").await;
        insert_child_block(&pool, "CHILD_B1", "content", "child", "PAGE_B").await;
        insert_child_block(&pool, "GRAND_B1", "content", "grandchild", "CHILD_B1").await;
        insert_tag_assoc(&pool, "PAGE_B", "TAG_T2").await;
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();
        let result = resolve_expr(&pool, &TagExpr::Tag("TAG_T2".into()), true)
            .await
            .unwrap();
        assert_eq!(result.len(), 3);
    }
    #[tokio::test]
    async fn resolve_tag_with_inheritance_does_not_include_siblings() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_T3", "tag", "t3").await;
        insert_block(&pool, "PAGE_C1", "page", "tagged page").await;
        insert_block(&pool, "PAGE_C2", "page", "untagged page").await;
        insert_child_block(&pool, "CHILD_C1", "content", "tagged child", "PAGE_C1").await;
        insert_child_block(&pool, "CHILD_C2", "content", "untagged child", "PAGE_C2").await;
        insert_tag_assoc(&pool, "PAGE_C1", "TAG_T3").await;
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();
        let result = resolve_expr(&pool, &TagExpr::Tag("TAG_T3".into()), true)
            .await
            .unwrap();
        assert_eq!(result.len(), 2);
        assert!(!result.contains("PAGE_C2"));
        assert!(!result.contains("CHILD_C2"));
    }
    #[tokio::test]
    async fn resolve_prefix_with_inheritance() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_WI", "tag", "work/inherit").await;
        insert_tag_cache(&pool, "TAG_WI", "work/inherit", 1).await;
        insert_block(&pool, "PAGE_D", "page", "work page").await;
        insert_child_block(&pool, "CHILD_D1", "content", "work child", "PAGE_D").await;
        insert_tag_assoc(&pool, "PAGE_D", "TAG_WI").await;
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();
        let result_inherited = resolve_expr(&pool, &TagExpr::Prefix("work/".into()), true)
            .await
            .unwrap();
        assert_eq!(result_inherited.len(), 2);
        let result_direct = resolve_expr(&pool, &TagExpr::Prefix("work/".into()), false)
            .await
            .unwrap();
        assert_eq!(result_direct.len(), 1);
    }
    #[tokio::test]
    async fn materialized_matches_cte_oracle() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG1", "tag", "tag1").await;
        insert_block(&pool, "TAG2", "tag", "tag2").await;
        insert_tag_cache(&pool, "TAG1", "tag1", 1).await;
        insert_tag_cache(&pool, "TAG2", "tag2", 1).await;
        insert_block(&pool, "PAGE_O", "page", "oracle page").await;
        insert_child_block(&pool, "CHILD_O1", "content", "child one", "PAGE_O").await;
        insert_child_block(&pool, "CHILD_O2", "content", "child two", "PAGE_O").await;
        insert_child_block(&pool, "GRAND_O1", "content", "grandchild one", "CHILD_O2").await;
        insert_tag_assoc(&pool, "PAGE_O", "TAG1").await;
        insert_tag_assoc(&pool, "CHILD_O2", "TAG2").await;
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();
        for tag in &["TAG1", "TAG2"] {
            let expr = TagExpr::Tag((*tag).to_string());
            let mat = resolve_expr(&pool, &expr, true).await.unwrap();
            let cte = resolve_expr_cte(&pool, &expr, true).await.unwrap();
            assert_eq!(mat, cte, "Tag({tag}) mismatch");
        }
        let prefix_expr = TagExpr::Prefix("tag".into());
        assert_eq!(
            resolve_expr(&pool, &prefix_expr, true).await.unwrap(),
            resolve_expr_cte(&pool, &prefix_expr, true).await.unwrap()
        );
        let and_expr = TagExpr::And(vec![
            TagExpr::Tag("TAG1".into()),
            TagExpr::Tag("TAG2".into()),
        ]);
        assert_eq!(
            resolve_expr(&pool, &and_expr, true).await.unwrap(),
            resolve_expr_cte(&pool, &and_expr, true).await.unwrap()
        );
        let or_expr = TagExpr::Or(vec![
            TagExpr::Tag("TAG1".into()),
            TagExpr::Tag("TAG2".into()),
        ]);
        assert_eq!(
            resolve_expr(&pool, &or_expr, true).await.unwrap(),
            resolve_expr_cte(&pool, &or_expr, true).await.unwrap()
        );
        let not_expr = TagExpr::Not(Box::new(TagExpr::Tag("TAG1".into())));
        assert_eq!(
            resolve_expr(&pool, &not_expr, true).await.unwrap(),
            resolve_expr_cte(&pool, &not_expr, true).await.unwrap()
        );
    }

    // ── Boolean combinator tests ─────────────────────────────────────

    #[tokio::test]
    async fn and_three_tags_returns_triple_intersection() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "TAG_C", "tag", "gamma").await;
        insert_block(&pool, "BLK_1", "content", "has all three").await;
        insert_block(&pool, "BLK_2", "content", "has a and b").await;
        insert_block(&pool, "BLK_3", "content", "has a and c").await;
        insert_block(&pool, "BLK_4", "content", "has only a").await;
        // BLK_1: A, B, C
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_C").await;
        // BLK_2: A, B
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;
        // BLK_3: A, C
        insert_tag_assoc(&pool, "BLK_3", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_C").await;
        // BLK_4: A only
        insert_tag_assoc(&pool, "BLK_4", "TAG_A").await;

        let expr = TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
            TagExpr::Tag("TAG_C".into()),
        ]);
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(result.len(), 1, "only BLK_1 has all three tags");
        assert!(result.contains("BLK_1"), "BLK_1 should match");
        assert!(!result.contains("BLK_2"), "BLK_2 missing TAG_C");
        assert!(!result.contains("BLK_3"), "BLK_3 missing TAG_B");
        assert!(!result.contains("BLK_4"), "BLK_4 missing TAG_B and TAG_C");
    }

    #[tokio::test]
    async fn or_three_tags_returns_union() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "TAG_C", "tag", "gamma").await;
        insert_block(&pool, "BLK_1", "content", "has a").await;
        insert_block(&pool, "BLK_2", "content", "has b").await;
        insert_block(&pool, "BLK_3", "content", "has c").await;
        insert_block(&pool, "BLK_4", "content", "no tags").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_C").await;

        let expr = TagExpr::Or(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
            TagExpr::Tag("TAG_C".into()),
        ]);
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(
            result.len(),
            3,
            "three blocks each have one of the three tags"
        );
        assert!(result.contains("BLK_1"), "BLK_1 has TAG_A");
        assert!(result.contains("BLK_2"), "BLK_2 has TAG_B");
        assert!(result.contains("BLK_3"), "BLK_3 has TAG_C");
        assert!(!result.contains("BLK_4"), "BLK_4 has no tags");
    }

    #[tokio::test]
    async fn not_and_returns_complement() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "has both").await;
        insert_block(&pool, "BLK_2", "content", "has only a").await;
        insert_block(&pool, "BLK_3", "content", "no tags").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;

        let expr = TagExpr::Not(Box::new(TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ])));
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        // BLK_1 has both → excluded by NOT(AND)
        assert!(
            !result.contains("BLK_1"),
            "BLK_1 has both tags, excluded by NOT(AND)"
        );
        assert!(
            result.contains("BLK_2"),
            "BLK_2 only has TAG_A, should be in result"
        );
        assert!(
            result.contains("BLK_3"),
            "BLK_3 has no tags, should be in result"
        );
    }

    #[tokio::test]
    async fn not_or_returns_blocks_with_neither_tag() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "has a").await;
        insert_block(&pool, "BLK_2", "content", "has b").await;
        insert_block(&pool, "BLK_3", "content", "has neither").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;

        let expr = TagExpr::Not(Box::new(TagExpr::Or(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ])));
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert!(!result.contains("BLK_1"), "BLK_1 has TAG_A, excluded");
        assert!(!result.contains("BLK_2"), "BLK_2 has TAG_B, excluded");
        assert!(result.contains("BLK_3"), "BLK_3 has neither tag");
        // Tag blocks themselves (TAG_A, TAG_B) have no tag associations, so they appear
        assert!(
            result.contains("TAG_A"),
            "TAG_A block has neither tag assoc"
        );
        assert!(
            result.contains("TAG_B"),
            "TAG_B block has neither tag assoc"
        );
    }

    #[tokio::test]
    async fn not_not_equals_original_tag() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "tagged").await;
        insert_block(&pool, "BLK_2", "content", "untagged").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;

        let single = TagExpr::Tag("TAG_A".into());
        let double_neg = TagExpr::Not(Box::new(TagExpr::Not(Box::new(TagExpr::Tag(
            "TAG_A".into(),
        )))));

        let result_single = resolve_expr(&pool, &single, false).await.unwrap();
        let result_double = resolve_expr(&pool, &double_neg, false).await.unwrap();
        assert_eq!(
            result_single, result_double,
            "NOT(NOT(a)) should equal Tag(a)"
        );
    }

    #[tokio::test]
    async fn and_prefix_with_exact_tag() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_PA", "tag", "proj/alpha").await;
        insert_block(&pool, "TAG_PB", "tag", "proj/beta").await;
        insert_block(&pool, "TAG_X", "tag", "extra").await;
        insert_tag_cache(&pool, "TAG_PA", "proj/alpha", 1).await;
        insert_tag_cache(&pool, "TAG_PB", "proj/beta", 1).await;
        insert_tag_cache(&pool, "TAG_X", "extra", 1).await;
        insert_block(&pool, "BLK_1", "content", "proj+extra").await;
        insert_block(&pool, "BLK_2", "content", "proj only").await;
        insert_block(&pool, "BLK_3", "content", "extra only").await;
        // BLK_1: proj/alpha + extra
        insert_tag_assoc(&pool, "BLK_1", "TAG_PA").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_X").await;
        // BLK_2: proj/beta
        insert_tag_assoc(&pool, "BLK_2", "TAG_PB").await;
        // BLK_3: extra
        insert_tag_assoc(&pool, "BLK_3", "TAG_X").await;

        let expr = TagExpr::And(vec![
            TagExpr::Prefix("proj/".into()),
            TagExpr::Tag("TAG_X".into()),
        ]);
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(result.len(), 1, "only BLK_1 has both a proj/ tag and TAG_X");
        assert!(
            result.contains("BLK_1"),
            "BLK_1 matches prefix AND exact tag"
        );
        assert!(!result.contains("BLK_2"), "BLK_2 missing TAG_X");
        assert!(!result.contains("BLK_3"), "BLK_3 missing proj/ prefix");
    }

    #[tokio::test]
    async fn or_prefix_with_exact_tag() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_PA", "tag", "proj/alpha").await;
        insert_block(&pool, "TAG_X", "tag", "extra").await;
        insert_tag_cache(&pool, "TAG_PA", "proj/alpha", 1).await;
        insert_tag_cache(&pool, "TAG_X", "extra", 1).await;
        insert_block(&pool, "BLK_1", "content", "proj only").await;
        insert_block(&pool, "BLK_2", "content", "extra only").await;
        insert_block(&pool, "BLK_3", "content", "no tags").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_PA").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_X").await;

        let expr = TagExpr::Or(vec![
            TagExpr::Prefix("proj/".into()),
            TagExpr::Tag("TAG_X".into()),
        ]);
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(result.len(), 2, "BLK_1 and BLK_2 each match one arm");
        assert!(result.contains("BLK_1"), "BLK_1 matches proj/ prefix");
        assert!(result.contains("BLK_2"), "BLK_2 matches TAG_X");
        assert!(!result.contains("BLK_3"), "BLK_3 has no tags");
    }

    #[tokio::test]
    async fn complex_nesting_and_or_not() {
        // AND(OR(Tag(a), Tag(b)), NOT(Tag(c)))
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "TAG_C", "tag", "gamma").await;
        insert_block(&pool, "BLK_1", "content", "a only").await;
        insert_block(&pool, "BLK_2", "content", "b only").await;
        insert_block(&pool, "BLK_3", "content", "a and c").await;
        insert_block(&pool, "BLK_4", "content", "no tags").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_C").await;

        let expr = TagExpr::And(vec![
            TagExpr::Or(vec![
                TagExpr::Tag("TAG_A".into()),
                TagExpr::Tag("TAG_B".into()),
            ]),
            TagExpr::Not(Box::new(TagExpr::Tag("TAG_C".into()))),
        ]);
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        // (a OR b) AND NOT c: BLK_1(a, no c) ✓, BLK_2(b, no c) ✓, BLK_3(a, has c) ✗
        assert!(result.contains("BLK_1"), "BLK_1 has a, not c");
        assert!(result.contains("BLK_2"), "BLK_2 has b, not c");
        assert!(!result.contains("BLK_3"), "BLK_3 has c, excluded by NOT");
        assert!(!result.contains("BLK_4"), "BLK_4 has neither a nor b");
        assert_eq!(result.len(), 2);
    }

    #[tokio::test]
    async fn and_with_empty_intersection() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "has a").await;
        insert_block(&pool, "BLK_2", "content", "has b").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_B").await;

        let expr = TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ]);
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert!(
            result.is_empty(),
            "no block has both tags, intersection should be empty"
        );
    }

    #[tokio::test]
    async fn or_with_overlapping_tags_deduplicates() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "has both").await;
        insert_block(&pool, "BLK_2", "content", "has a only").await;
        insert_block(&pool, "BLK_3", "content", "has b only").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_B").await;

        let expr = TagExpr::Or(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ]);
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(
            result.len(),
            3,
            "BLK_1 appears once despite matching both OR arms"
        );
        assert!(result.contains("BLK_1"), "BLK_1 appears exactly once");
        assert!(result.contains("BLK_2"), "BLK_2 has TAG_A");
        assert!(result.contains("BLK_3"), "BLK_3 has TAG_B");
    }

    #[tokio::test]
    async fn not_nonexistent_tag_returns_all_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_block(&pool, "BLK_3", "content", "three").await;

        let expr = TagExpr::Not(Box::new(TagExpr::Tag("NONEXISTENT".into())));
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert_eq!(
            result.len(),
            3,
            "NOT of nonexistent tag should return all non-deleted, non-conflict blocks"
        );
        assert!(result.contains("BLK_1"), "BLK_1 should be included");
        assert!(result.contains("BLK_2"), "BLK_2 should be included");
        assert!(result.contains("BLK_3"), "BLK_3 should be included");
    }

    #[tokio::test]
    async fn and_single_element_equals_tag() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "tagged").await;
        insert_block(&pool, "BLK_2", "content", "untagged").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;

        let tag_expr = TagExpr::Tag("TAG_A".into());
        let and_expr = TagExpr::And(vec![TagExpr::Tag("TAG_A".into())]);
        let result_tag = resolve_expr(&pool, &tag_expr, false).await.unwrap();
        let result_and = resolve_expr(&pool, &and_expr, false).await.unwrap();
        assert_eq!(
            result_tag, result_and,
            "AND with single element should equal Tag"
        );
    }

    #[tokio::test]
    async fn or_single_element_equals_tag() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "tagged").await;
        insert_block(&pool, "BLK_2", "content", "untagged").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;

        let tag_expr = TagExpr::Tag("TAG_A".into());
        let or_expr = TagExpr::Or(vec![TagExpr::Tag("TAG_A".into())]);
        let result_tag = resolve_expr(&pool, &tag_expr, false).await.unwrap();
        let result_or = resolve_expr(&pool, &or_expr, false).await.unwrap();
        assert_eq!(
            result_tag, result_or,
            "OR with single element should equal Tag"
        );
    }

    #[tokio::test]
    async fn deep_nesting_not_and_or_not() {
        // NOT(AND(OR(a,b), NOT(c)))
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "TAG_C", "tag", "gamma").await;
        insert_block(&pool, "BLK_1", "content", "a only").await;
        insert_block(&pool, "BLK_2", "content", "a and c").await;
        insert_block(&pool, "BLK_3", "content", "b only").await;
        insert_block(&pool, "BLK_4", "content", "c only").await;
        insert_block(&pool, "BLK_5", "content", "no tags").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_C").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_4", "TAG_C").await;

        // Inner: AND(OR(a,b), NOT(c))
        //   OR(a,b) = {BLK_1, BLK_2, BLK_3}
        //   NOT(c) = everything except {BLK_2, BLK_4}
        //   AND = {BLK_1, BLK_3}
        // NOT of that = everything except {BLK_1, BLK_3}
        let expr = TagExpr::Not(Box::new(TagExpr::And(vec![
            TagExpr::Or(vec![
                TagExpr::Tag("TAG_A".into()),
                TagExpr::Tag("TAG_B".into()),
            ]),
            TagExpr::Not(Box::new(TagExpr::Tag("TAG_C".into()))),
        ])));
        let result = resolve_expr(&pool, &expr, false).await.unwrap();
        assert!(!result.contains("BLK_1"), "BLK_1 is in inner set, excluded");
        assert!(!result.contains("BLK_3"), "BLK_3 is in inner set, excluded");
        assert!(result.contains("BLK_2"), "BLK_2 not in inner set (has c)");
        assert!(result.contains("BLK_4"), "BLK_4 not in inner set (no a/b)");
        assert!(result.contains("BLK_5"), "BLK_5 not in inner set (no tags)");
    }

    #[tokio::test]
    async fn oracle_validates_complex_boolean_expressions() {
        let (pool, _dir) = test_pool().await;
        // Set up blocks with parent-child for inheritance
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "TAG_C", "tag", "gamma").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 3).await;
        insert_tag_cache(&pool, "TAG_B", "beta", 2).await;
        insert_tag_cache(&pool, "TAG_C", "gamma", 1).await;
        insert_block(&pool, "PAGE_1", "page", "page one").await;
        insert_child_block(&pool, "BLK_1", "content", "child one", "PAGE_1").await;
        insert_block(&pool, "PAGE_2", "page", "page two").await;
        insert_child_block(&pool, "BLK_2", "content", "child two", "PAGE_2").await;
        insert_block(&pool, "BLK_3", "content", "standalone").await;
        // TAG_A on PAGE_1 (inherits to BLK_1)
        insert_tag_assoc(&pool, "PAGE_1", "TAG_A").await;
        // TAG_B on PAGE_2 (inherits to BLK_2)
        insert_tag_assoc(&pool, "PAGE_2", "TAG_B").await;
        // TAG_C on BLK_3
        insert_tag_assoc(&pool, "BLK_3", "TAG_C").await;
        // TAG_A also on PAGE_2 (so PAGE_2 has A and B)
        insert_tag_assoc(&pool, "PAGE_2", "TAG_A").await;

        // Rebuild materialized inheritance table for oracle comparison
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();

        // Expression 1: AND with 3 tags
        let expr_and3 = TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
            TagExpr::Tag("TAG_C".into()),
        ]);
        assert_eq!(
            resolve_expr(&pool, &expr_and3, true).await.unwrap(),
            resolve_expr_cte(&pool, &expr_and3, true).await.unwrap(),
            "oracle mismatch: AND(a,b,c)"
        );

        // Expression 2: OR with 3 tags
        let expr_or3 = TagExpr::Or(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
            TagExpr::Tag("TAG_C".into()),
        ]);
        assert_eq!(
            resolve_expr(&pool, &expr_or3, true).await.unwrap(),
            resolve_expr_cte(&pool, &expr_or3, true).await.unwrap(),
            "oracle mismatch: OR(a,b,c)"
        );

        // Expression 3: NOT(AND(a,b))
        let expr_not_and = TagExpr::Not(Box::new(TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ])));
        assert_eq!(
            resolve_expr(&pool, &expr_not_and, true).await.unwrap(),
            resolve_expr_cte(&pool, &expr_not_and, true).await.unwrap(),
            "oracle mismatch: NOT(AND(a,b))"
        );

        // Expression 4: NOT(OR(a,b))
        let expr_not_or = TagExpr::Not(Box::new(TagExpr::Or(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ])));
        assert_eq!(
            resolve_expr(&pool, &expr_not_or, true).await.unwrap(),
            resolve_expr_cte(&pool, &expr_not_or, true).await.unwrap(),
            "oracle mismatch: NOT(OR(a,b))"
        );

        // Expression 5: NOT(NOT(a))
        let expr_double_neg = TagExpr::Not(Box::new(TagExpr::Not(Box::new(TagExpr::Tag(
            "TAG_A".into(),
        )))));
        assert_eq!(
            resolve_expr(&pool, &expr_double_neg, true).await.unwrap(),
            resolve_expr_cte(&pool, &expr_double_neg, true)
                .await
                .unwrap(),
            "oracle mismatch: NOT(NOT(a))"
        );

        // Expression 6: AND(OR(a,b), NOT(c))
        let expr_complex = TagExpr::And(vec![
            TagExpr::Or(vec![
                TagExpr::Tag("TAG_A".into()),
                TagExpr::Tag("TAG_B".into()),
            ]),
            TagExpr::Not(Box::new(TagExpr::Tag("TAG_C".into()))),
        ]);
        assert_eq!(
            resolve_expr(&pool, &expr_complex, true).await.unwrap(),
            resolve_expr_cte(&pool, &expr_complex, true).await.unwrap(),
            "oracle mismatch: AND(OR(a,b), NOT(c))"
        );

        // Expression 7: NOT(AND(OR(a,b), NOT(c))) — deep nesting
        let expr_deep = TagExpr::Not(Box::new(TagExpr::And(vec![
            TagExpr::Or(vec![
                TagExpr::Tag("TAG_A".into()),
                TagExpr::Tag("TAG_B".into()),
            ]),
            TagExpr::Not(Box::new(TagExpr::Tag("TAG_C".into()))),
        ])));
        assert_eq!(
            resolve_expr(&pool, &expr_deep, true).await.unwrap(),
            resolve_expr_cte(&pool, &expr_deep, true).await.unwrap(),
            "oracle mismatch: NOT(AND(OR(a,b), NOT(c)))"
        );

        // Expression 8: AND(Prefix("alpha"), Tag(TAG_B)) — prefix in boolean
        let expr_prefix_and = TagExpr::And(vec![
            TagExpr::Prefix("alpha".into()),
            TagExpr::Tag("TAG_B".into()),
        ]);
        assert_eq!(
            resolve_expr(&pool, &expr_prefix_and, true).await.unwrap(),
            resolve_expr_cte(&pool, &expr_prefix_and, true)
                .await
                .unwrap(),
            "oracle mismatch: AND(Prefix(alpha), Tag(b))"
        );

        // Expression 9: OR(Prefix("beta"), Tag(TAG_C)) — prefix in OR
        let expr_prefix_or = TagExpr::Or(vec![
            TagExpr::Prefix("beta".into()),
            TagExpr::Tag("TAG_C".into()),
        ]);
        assert_eq!(
            resolve_expr(&pool, &expr_prefix_or, true).await.unwrap(),
            resolve_expr_cte(&pool, &expr_prefix_or, true)
                .await
                .unwrap(),
            "oracle mismatch: OR(Prefix(beta), Tag(c))"
        );
    }
}
