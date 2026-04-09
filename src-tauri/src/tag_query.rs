//! Boolean tag query evaluation (p3-t7, p3-t8).
//!
//! Provides a `TagExpr` tree for composing boolean tag queries (AND, OR, NOT,
//! single tag, prefix match) and evaluating them against the database.
//!
//! ## Evaluation strategy
//!
//! 1. **Resolve tag_ids** -- `Tag(id)` maps to a single id; `Prefix(name)`
//!    resolves via `LIKE 'name%'` on `tags_cache.name`.
//! 2. **Collect block_ids** -- For each resolved tag_id, query `block_tags`
//!    joined with `blocks` (excluding deleted/conflict).  Collect into
//!    `FxHashSet<String>`.
//! 3. **Set operations** -- AND = intersection, OR = union, NOT = complement
//!    relative to all non-deleted, non-conflict blocks.
//! 4. **Paginate** -- Sort the resulting id set, apply keyset cursor, fetch
//!    full `BlockRow` data.

use rustc_hash::FxHashSet;
use serde::Serialize;
use serde_json;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::pagination::{BlockRow, Cursor, PageRequest, PageResponse};

// ---------------------------------------------------------------------------
// LIKE-pattern escaping
// ---------------------------------------------------------------------------

/// Escape special LIKE pattern characters (`%`, `_`, `\`) so user-supplied
/// prefix strings match literally.  The escaped value must be used with
/// `LIKE ?1 ESCAPE '\'`.
#[must_use]
fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// TagExpr tree
// ---------------------------------------------------------------------------

/// Boolean expression tree for tag queries.
#[derive(Debug, Clone, PartialEq)]
pub enum TagExpr {
    /// Single tag by id.
    Tag(String),
    /// All tags whose name starts with `prefix` (e.g. `"work/"` matches
    /// `"work/meeting"`, `"work/email"`).
    Prefix(String),
    /// Intersection -- all sub-expressions must match.
    And(Vec<TagExpr>),
    /// Union -- any sub-expression may match.
    Or(Vec<TagExpr>),
    /// Complement -- blocks *not* in the inner set.
    Not(Box<TagExpr>),
}

// ---------------------------------------------------------------------------
// TagCacheRow
// ---------------------------------------------------------------------------

/// Row from `tags_cache`, used by `list_tags_by_prefix`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow, specta::Type)]
pub struct TagCacheRow {
    pub tag_id: String,
    pub name: String,
    pub usage_count: i64,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Internal: resolve TagExpr -> set of block_ids
// ---------------------------------------------------------------------------

/// Resolve a `TagExpr` into the set of matching `block_id`s.
///
/// Deleted and conflict blocks are excluded at the leaf level.
///
/// When `include_inherited` is true, leaf resolution (Tag and Prefix) expands
/// to include all descendants of directly-tagged blocks via a recursive CTE
/// on `blocks.parent_id`.  This implements block-level tag inheritance (F-15).
fn resolve_expr<'a>(
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
                    // P-4: Use materialized block_tag_inherited table instead of
                    // recursive CTE. Direct tags from block_tags UNION inherited
                    // tags from block_tag_inherited.
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
                // Single JOIN query: resolve all matching tags and collect
                // their block_ids in one round-trip (avoids N+1 per-tag
                // queries).
                let escaped = format!("{}%", escape_like(prefix));
                if include_inherited {
                    // P-4: Use materialized block_tag_inherited table instead of
                    // recursive CTE. Direct tags UNION inherited tags, both filtered
                    // by prefix via tags_cache.
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
                // Safe: is_empty() check above ensures at least one element
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
                    // Not of empty set = all non-deleted blocks
                    let rows = sqlx::query_scalar::<_, String>(
                        "SELECT id FROM blocks WHERE deleted_at IS NULL AND is_conflict = 0",
                    )
                    .fetch_all(pool)
                    .await?;
                    return Ok(rows.into_iter().collect());
                }

                // Push NOT into SQL via json_each() to avoid loading all
                // block IDs into memory at 100k+ scale.
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
/// Returns the same results as `resolve_expr` but uses recursive CTEs
/// instead of the pre-computed inheritance table. Used only in tests
/// to verify the materialized path produces identical results.
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
            _ => {
                // include_inherited=false or boolean operators: delegate to resolve_expr
                resolve_expr(pool, expr, include_inherited).await
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Public: eval_tag_query (paginated)
// ---------------------------------------------------------------------------

/// Evaluate a boolean tag expression and return a paginated set of blocks.
///
/// The result set is ordered by `id ASC` (ULID ~ chronological) with keyset
/// cursor pagination.
///
/// When `include_inherited` is true, leaf tag/prefix resolution includes
/// descendants of directly-tagged blocks (block-level tag inheritance, F-15).
///
/// ## Implementation note: in-memory set operations
///
/// The evaluation strategy collects all matching `block_id`s into in-memory
/// `FxHashSet`s and performs AND (intersection), OR (union), NOT (complement)
/// in Rust rather than composing a single SQL query. This is acceptable for a
/// personal notes app where the total block count is expected to stay well
/// under 100 k — set operations on that scale are sub-millisecond. A future
/// optimisation could push boolean logic into SQL CTEs if profiling shows this
/// becoming a bottleneck.
pub async fn eval_tag_query(
    pool: &SqlitePool,
    expr: &TagExpr,
    page: &PageRequest,
    include_inherited: bool,
) -> Result<PageResponse<BlockRow>, AppError> {
    let block_ids: FxHashSet<String> = resolve_expr(pool, expr, include_inherited).await?;
    if block_ids.is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
        });
    }

    // Sort for deterministic keyset pagination.
    let mut sorted_ids: Vec<&str> = block_ids.iter().map(|s| s.as_str()).collect();
    sorted_ids.sort();

    // Apply cursor (keyset on id).
    let start_after = page.after.as_ref().map(|c| c.id.as_str());
    let filtered: Vec<&str> = if let Some(after_id) = start_after {
        sorted_ids.into_iter().filter(|id| *id > after_id).collect()
    } else {
        sorted_ids
    };

    let fetch_limit = (page.limit + 1) as usize;
    let page_ids: Vec<&str> = filtered.into_iter().take(fetch_limit).collect();
    let has_more = page_ids.len() > page.limit as usize;
    let actual_ids: Vec<&str> = if has_more {
        page_ids[..page.limit as usize].to_vec()
    } else {
        page_ids
    };

    if actual_ids.is_empty() {
        return Ok(PageResponse {
            items: vec![],
            next_cursor: None,
            has_more: false,
        });
    }

    // Fetch full BlockRows via IN clause.
    let placeholders = actual_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let query_str = format!(
        "SELECT id, block_type, content, parent_id, position, \
         deleted_at, is_conflict, conflict_type, \
         todo_state, priority, due_date, scheduled_date \
         FROM blocks WHERE id IN ({placeholders}) ORDER BY id"
    );

    let mut query = sqlx::query_as::<_, BlockRow>(&query_str);
    for id in &actual_ids {
        query = query.bind(*id);
    }
    let items: Vec<BlockRow> = query.fetch_all(pool).await?;

    let next_cursor = if has_more {
        let last = items.last().expect("has_more implies non-empty");
        Some(
            Cursor {
                id: last.id.clone(),
                position: None,
                deleted_at: None,
                seq: None,
                rank: None,
            }
            .encode()?,
        )
    } else {
        None
    };

    Ok(PageResponse {
        items,
        next_cursor,
        has_more,
    })
}

// ---------------------------------------------------------------------------
// Public: list_tags_by_prefix (autocomplete / UI)
// ---------------------------------------------------------------------------

/// Maximum number of tags returned by [`list_tags_by_prefix`].
///
/// Prevents unbounded result sets when the prefix matches many tags.
const MAX_TAGS_PREFIX: i64 = 200;

/// List all tags whose name starts with `prefix`, ordered by name.
///
/// Useful for tag autocomplete and prefix-aware browsing (p3-t8).
/// Special LIKE characters (`%`, `_`) in the prefix are escaped so
/// user input matches literally.
///
/// Results are capped at [`MAX_TAGS_PREFIX`] (200) to prevent unbounded
/// result sets.
pub async fn list_tags_by_prefix(
    pool: &SqlitePool,
    prefix: &str,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    let like_pattern = format!("{}%", escape_like(prefix));
    let effective_limit = limit.unwrap_or(MAX_TAGS_PREFIX);
    let rows = sqlx::query_as!(
        TagCacheRow,
        r#"SELECT tag_id, name, usage_count, updated_at
         FROM tags_cache WHERE name LIKE ?1 ESCAPE '\' ORDER BY name LIMIT ?2"#,
        like_pattern,
        effective_limit
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Public: list_tags_for_block
// ---------------------------------------------------------------------------

/// List all tag_ids associated with a block.
///
/// Queries the `block_tags` join table (source of truth for tag associations)
/// and returns the tag_ids in sorted order. Returns an empty `Vec` when the
/// block has no tags or does not exist.
pub async fn list_tags_for_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query_scalar!(
        "SELECT tag_id FROM block_tags WHERE block_id = ?1 ORDER BY tag_id",
        block_id
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    // -- Helpers --

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert a block directly.
    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)")
            .bind(id)
            .bind(block_type)
            .bind(content)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Tag a block.
    async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Insert a tags_cache row.
    async fn insert_tag_cache(pool: &SqlitePool, tag_id: &str, name: &str, usage_count: i64) {
        sqlx::query(
            "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
             VALUES (?, ?, ?, '2025-01-01T00:00:00Z')",
        )
        .bind(tag_id)
        .bind(name)
        .bind(usage_count)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Soft-delete a block.
    async fn soft_delete(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Mark a block as conflict.
    async fn mark_conflict(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    // ======================================================================
    // resolve_expr: Tag
    // ======================================================================

    #[tokio::test]
    async fn resolve_tag_returns_correct_block_ids() {
        let (pool, _dir) = test_pool().await;

        // Create a tag block and two content blocks tagged with it
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_block(&pool, "BLK_3", "content", "three").await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        // BLK_3 is NOT tagged

        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Tag("TAG_A".into()), false)
            .await
            .unwrap();

        assert_eq!(result.len(), 2, "tag query should match exactly 2 blocks");
        assert!(
            result.contains("BLK_1"),
            "result should contain BLK_1 tagged with TAG_A"
        );
        assert!(
            result.contains("BLK_2"),
            "result should contain BLK_2 tagged with TAG_A"
        );
        assert!(
            !result.contains("BLK_3"),
            "result should not contain untagged BLK_3"
        );
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

        assert_eq!(
            result.len(),
            1,
            "deleted block should be excluded from results"
        );
        assert!(
            result.contains("BLK_1"),
            "non-deleted block should remain in results"
        );
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

        assert_eq!(
            result.len(),
            1,
            "conflict block should be excluded from results"
        );
        assert!(
            result.contains("BLK_1"),
            "non-conflict block should remain in results"
        );
    }

    #[tokio::test]
    async fn resolve_tag_unknown_tag_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let result: FxHashSet<String> =
            resolve_expr(&pool, &TagExpr::Tag("NONEXISTENT".into()), false)
                .await
                .unwrap();

        assert!(result.is_empty(), "unknown tag should return empty set");
    }

    // ======================================================================
    // resolve_expr: Prefix
    // ======================================================================

    #[tokio::test]
    async fn resolve_prefix_matches_hierarchical_tags() {
        let (pool, _dir) = test_pool().await;

        // Tags with hierarchical names
        insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
        insert_block(&pool, "TAG_WE", "tag", "work/email").await;
        insert_block(&pool, "TAG_P", "tag", "personal").await;

        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 2).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 1).await;
        insert_tag_cache(&pool, "TAG_P", "personal", 3).await;

        // Blocks tagged with these tags
        insert_block(&pool, "BLK_1", "content", "meeting notes").await;
        insert_block(&pool, "BLK_2", "content", "email draft").await;
        insert_block(&pool, "BLK_3", "content", "personal diary").await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_WM").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_WE").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_P").await;

        // Prefix "work/" should match both work/ sub-tags
        let result: FxHashSet<String> =
            resolve_expr(&pool, &TagExpr::Prefix("work/".into()), false)
                .await
                .unwrap();

        assert_eq!(result.len(), 2, "prefix 'work/' should match 2 blocks");
        assert!(
            result.contains("BLK_1"),
            "result should contain BLK_1 tagged with work/meeting"
        );
        assert!(
            result.contains("BLK_2"),
            "result should contain BLK_2 tagged with work/email"
        );
        assert!(
            !result.contains("BLK_3"),
            "result should not contain BLK_3 tagged with personal"
        );
    }

    #[tokio::test]
    async fn resolve_prefix_no_match_returns_empty() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;

        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Prefix("zzz_".into()), false)
            .await
            .unwrap();

        assert!(
            result.is_empty(),
            "non-matching prefix should return empty set"
        );
    }

    #[tokio::test]
    async fn resolve_prefix_unions_block_ids_across_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
        insert_block(&pool, "TAG_WE", "tag", "work/email").await;

        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 1).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 1).await;

        // Same block tagged with both work/ sub-tags
        insert_block(&pool, "BLK_1", "content", "overlap").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_WM").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_WE").await;

        let result: FxHashSet<String> =
            resolve_expr(&pool, &TagExpr::Prefix("work/".into()), false)
                .await
                .unwrap();

        // Should be deduplicated (union, not multi-set)
        assert_eq!(
            result.len(),
            1,
            "duplicate block ids should be deduplicated"
        );
        assert!(
            result.contains("BLK_1"),
            "result should contain the shared block"
        );
    }

    // ======================================================================
    // resolve_expr: And (intersection)
    // ======================================================================

    #[tokio::test]
    async fn resolve_and_returns_intersection() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;

        insert_block(&pool, "BLK_1", "content", "one").await; // tagged A + B
        insert_block(&pool, "BLK_2", "content", "two").await; // tagged A only
        insert_block(&pool, "BLK_3", "content", "three").await; // tagged B only

        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_B").await;

        let expr = TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ]);
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();

        assert_eq!(
            result.len(),
            1,
            "AND intersection should match exactly 1 block"
        );
        assert!(
            result.contains("BLK_1"),
            "result should contain block tagged with both A and B"
        );
    }

    #[tokio::test]
    async fn resolve_and_empty_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::And(vec![]), false)
            .await
            .unwrap();
        assert!(
            result.is_empty(),
            "AND with empty operands should return empty set"
        );
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

        assert!(
            result.is_empty(),
            "AND of disjoint tags should return empty set"
        );
    }

    // ======================================================================
    // resolve_expr: Or (union)
    // ======================================================================

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

        assert_eq!(result.len(), 2, "OR union should match 2 blocks");
        assert!(
            result.contains("BLK_1"),
            "OR result should contain BLK_1 tagged with A"
        );
        assert!(
            result.contains("BLK_2"),
            "OR result should contain BLK_2 tagged with B"
        );
    }

    #[tokio::test]
    async fn resolve_or_empty_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Or(vec![]), false)
            .await
            .unwrap();
        assert!(
            result.is_empty(),
            "OR with empty operands should return empty set"
        );
    }

    #[tokio::test]
    async fn resolve_or_deduplicates_shared_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;

        // Same block tagged with both
        insert_block(&pool, "BLK_1", "content", "shared").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;

        let expr = TagExpr::Or(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Tag("TAG_B".into()),
        ]);
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();

        assert_eq!(result.len(), 1, "OR should deduplicate shared blocks");
        assert!(
            result.contains("BLK_1"),
            "result should contain the shared block"
        );
    }

    // ======================================================================
    // resolve_expr: Not (complement)
    // ======================================================================

    #[tokio::test]
    async fn resolve_not_returns_complement() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "tagged").await;
        insert_block(&pool, "BLK_2", "content", "untagged").await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;

        let expr = TagExpr::Not(Box::new(TagExpr::Tag("TAG_A".into())));
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();

        // BLK_2 and TAG_A itself should be in the complement (everything not tagged A)
        assert!(
            result.contains("BLK_2"),
            "untagged block should be in NOT complement"
        );
        assert!(
            result.contains("TAG_A"),
            "tag block itself should be in NOT complement"
        );
        assert!(
            !result.contains("BLK_1"),
            "tagged block should be excluded from NOT complement"
        );
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

        // BLK_2 is deleted, should not appear in universal set
        assert!(
            !result.contains("BLK_2"),
            "deleted block should not appear in NOT universal set"
        );
    }

    // ======================================================================
    // resolve_expr: Nested (And + Or)
    // ======================================================================

    #[tokio::test]
    async fn resolve_nested_and_or() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "TAG_C", "tag", "gamma").await;

        // BLK_1: tagged A + B
        // BLK_2: tagged A + C
        // BLK_3: tagged A only
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_block(&pool, "BLK_2", "content", "two").await;
        insert_block(&pool, "BLK_3", "content", "three").await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_2", "TAG_C").await;
        insert_tag_assoc(&pool, "BLK_3", "TAG_A").await;

        // AND(A, OR(B, C)) => blocks tagged A AND (B or C)
        // BLK_1 has A+B, BLK_2 has A+C, BLK_3 has only A
        let expr = TagExpr::And(vec![
            TagExpr::Tag("TAG_A".into()),
            TagExpr::Or(vec![
                TagExpr::Tag("TAG_B".into()),
                TagExpr::Tag("TAG_C".into()),
            ]),
        ]);
        let result: FxHashSet<String> = resolve_expr(&pool, &expr, false).await.unwrap();

        assert_eq!(result.len(), 2, "AND(A, OR(B,C)) should match 2 blocks");
        assert!(
            result.contains("BLK_1"),
            "BLK_1 with A+B should match AND(A, OR(B,C))"
        );
        assert!(
            result.contains("BLK_2"),
            "BLK_2 with A+C should match AND(A, OR(B,C))"
        );
        assert!(
            !result.contains("BLK_3"),
            "BLK_3 with only A should not match AND(A, OR(B,C))"
        );
    }

    // ======================================================================
    // eval_tag_query: pagination
    // ======================================================================

    #[tokio::test]
    async fn eval_tag_query_paginates_results() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_X", "tag", "x-tag").await;

        // Create 5 blocks tagged with TAG_X (IDs sorted: BLK_A < BLK_B < ... < BLK_E)
        for suffix in &["A", "B", "C", "D", "E"] {
            let id = format!("BLK_{suffix}");
            insert_block(&pool, &id, "content", &format!("block {suffix}")).await;
            insert_tag_assoc(&pool, &id, "TAG_X").await;
        }

        let expr = TagExpr::Tag("TAG_X".into());

        // Page 1: limit 2
        let page1 = PageRequest::new(None, Some(2)).unwrap();
        let resp1 = eval_tag_query(&pool, &expr, &page1, false).await.unwrap();

        assert_eq!(resp1.items.len(), 2, "page 1 should return 2 items");
        assert_eq!(
            resp1.items[0].id, "BLK_A",
            "page 1 first item should be BLK_A"
        );
        assert_eq!(
            resp1.items[1].id, "BLK_B",
            "page 1 second item should be BLK_B"
        );
        assert!(resp1.has_more, "page 1 should indicate more pages");
        assert!(
            resp1.next_cursor.is_some(),
            "page 1 should provide a next cursor"
        );

        // Page 2: continue from cursor
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_tag_query(&pool, &expr, &page2, false).await.unwrap();

        assert_eq!(resp2.items.len(), 2, "page 2 should return 2 items");
        assert_eq!(
            resp2.items[0].id, "BLK_C",
            "page 2 first item should be BLK_C"
        );
        assert_eq!(
            resp2.items[1].id, "BLK_D",
            "page 2 second item should be BLK_D"
        );
        assert!(resp2.has_more, "page 2 should indicate more pages");

        // Page 3: last page
        let page3 = PageRequest::new(resp2.next_cursor, Some(2)).unwrap();
        let resp3 = eval_tag_query(&pool, &expr, &page3, false).await.unwrap();

        assert_eq!(
            resp3.items.len(),
            1,
            "page 3 should return 1 remaining item"
        );
        assert_eq!(resp3.items[0].id, "BLK_E", "page 3 should contain BLK_E");
        assert!(!resp3.has_more, "last page should not indicate more pages");
        assert!(
            resp3.next_cursor.is_none(),
            "last page should have no next cursor"
        );
    }

    #[tokio::test]
    async fn eval_tag_query_empty_result() {
        let (pool, _dir) = test_pool().await;

        let expr = TagExpr::Tag("NONEXISTENT".into());
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false).await.unwrap();

        assert!(
            resp.items.is_empty(),
            "nonexistent tag should return empty items"
        );
        assert!(
            !resp.has_more,
            "empty result should not indicate more pages"
        );
        assert!(
            resp.next_cursor.is_none(),
            "empty result should have no cursor"
        );
    }

    #[tokio::test]
    async fn eval_tag_query_returns_full_block_rows() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "hello world").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;

        let expr = TagExpr::Tag("TAG_A".into());
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false).await.unwrap();

        assert_eq!(
            resp.items.len(),
            1,
            "query should return exactly 1 block row"
        );
        let row = &resp.items[0];
        assert_eq!(row.id, "BLK_1", "returned row should have correct id");
        assert_eq!(
            row.block_type, "content",
            "returned row should have correct block_type"
        );
        assert_eq!(
            row.content,
            Some("hello world".into()),
            "returned row should have correct content"
        );
        assert!(
            row.deleted_at.is_none(),
            "returned row should not be deleted"
        );
        assert!(!row.is_conflict, "returned row should not be a conflict");
    }

    #[tokio::test]
    async fn eval_tag_query_cursor_past_all_returns_empty() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;

        let expr = TagExpr::Tag("TAG_A".into());

        // Cursor pointing past all existing ids
        let cursor = Cursor {
            id: "ZZZZZZZZZZ".into(),
            position: None,
            deleted_at: None,
            seq: None,
            rank: None,
        }
        .encode()
        .unwrap();
        let page = PageRequest::new(Some(cursor), Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false).await.unwrap();

        assert!(
            resp.items.is_empty(),
            "cursor past all ids should return empty items"
        );
        assert!(
            !resp.has_more,
            "cursor past all ids should not indicate more pages"
        );
    }

    // ======================================================================
    // list_tags_by_prefix
    // ======================================================================

    #[tokio::test]
    async fn list_tags_by_prefix_returns_matching_tags() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
        insert_block(&pool, "TAG_WE", "tag", "work/email").await;
        insert_block(&pool, "TAG_P", "tag", "personal").await;

        insert_tag_cache(&pool, "TAG_WM", "work/meeting", 5).await;
        insert_tag_cache(&pool, "TAG_WE", "work/email", 3).await;
        insert_tag_cache(&pool, "TAG_P", "personal", 10).await;

        let result = list_tags_by_prefix(&pool, "work/", None).await.unwrap();

        assert_eq!(result.len(), 2, "prefix 'work/' should match 2 tags");
        // Ordered by name
        assert_eq!(
            result[0].name, "work/email",
            "first tag should be work/email (alphabetical)"
        );
        assert_eq!(result[0].tag_id, "TAG_WE", "first tag_id should be TAG_WE");
        assert_eq!(
            result[0].usage_count, 3,
            "first tag usage_count should be 3"
        );
        assert_eq!(
            result[1].name, "work/meeting",
            "second tag should be work/meeting"
        );
        assert_eq!(result[1].tag_id, "TAG_WM", "second tag_id should be TAG_WM");
        assert_eq!(
            result[1].usage_count, 5,
            "second tag usage_count should be 5"
        );
    }

    #[tokio::test]
    async fn list_tags_by_prefix_empty_prefix_returns_all() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;

        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;
        insert_tag_cache(&pool, "TAG_B", "beta", 2).await;

        let result = list_tags_by_prefix(&pool, "", None).await.unwrap();

        assert_eq!(result.len(), 2, "empty prefix should return all tags");
        assert_eq!(
            result[0].name, "alpha",
            "first tag should be alpha (alphabetical)"
        );
        assert_eq!(result[1].name, "beta", "second tag should be beta");
    }

    #[tokio::test]
    async fn list_tags_by_prefix_no_match_returns_empty() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;

        let result = list_tags_by_prefix(&pool, "zzz", None).await.unwrap();

        assert!(
            result.is_empty(),
            "non-matching prefix should return empty list"
        );
    }

    // ======================================================================
    // escape_like
    // ======================================================================

    #[test]
    fn escape_like_leaves_plain_text_unchanged() {
        assert_eq!(
            escape_like("work/meeting"),
            "work/meeting",
            "plain text should pass through unchanged"
        );
    }

    #[test]
    fn escape_like_escapes_percent() {
        assert_eq!(
            escape_like("100%"),
            "100\\%",
            "percent should be backslash-escaped"
        );
    }

    #[test]
    fn escape_like_escapes_underscore() {
        assert_eq!(
            escape_like("a_b"),
            "a\\_b",
            "underscore should be backslash-escaped"
        );
    }

    #[test]
    fn escape_like_escapes_backslash() {
        assert_eq!(
            escape_like("a\\b"),
            "a\\\\b",
            "backslash should be double-escaped"
        );
    }

    #[test]
    fn escape_like_escapes_all_special_chars() {
        assert_eq!(
            escape_like("%_\\"),
            "\\%\\_\\\\",
            "all special chars should be escaped together"
        );
    }

    #[tokio::test]
    async fn list_tags_by_prefix_escapes_percent_in_prefix() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "100%_done").await;
        insert_block(&pool, "TAG_B", "tag", "alpha").await;

        insert_tag_cache(&pool, "TAG_A", "100%_done", 1).await;
        insert_tag_cache(&pool, "TAG_B", "alpha", 2).await;

        // Prefix "%" should NOT match all tags — it should be escaped to literal '%'
        let result = list_tags_by_prefix(&pool, "%", None).await.unwrap();
        assert_eq!(result.len(), 0, "literal % prefix should not match 'alpha'");

        // Prefix "100%" should match only the tag with literal '%'
        let result = list_tags_by_prefix(&pool, "100%", None).await.unwrap();
        assert_eq!(
            result.len(),
            1,
            "literal '100%%' prefix should match exactly 1 tag"
        );
        assert_eq!(
            result[0].name, "100%_done",
            "matched tag should be '100%%_done'"
        );
    }

    // ======================================================================
    // list_tags_for_block
    // ======================================================================

    #[tokio::test]
    async fn list_tags_for_block_returns_tag_ids() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "hello").await;

        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;

        let result = list_tags_for_block(&pool, "BLK_1").await.unwrap();

        assert_eq!(result.len(), 2, "block should have 2 associated tags");
        // Ordered by tag_id
        assert_eq!(result[0], "TAG_A", "first tag_id should be TAG_A");
        assert_eq!(result[1], "TAG_B", "second tag_id should be TAG_B");
    }

    #[tokio::test]
    async fn list_tags_for_block_no_tags_returns_empty() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLK_1", "content", "no tags").await;

        let result = list_tags_for_block(&pool, "BLK_1").await.unwrap();

        assert!(
            result.is_empty(),
            "block with no tags should return empty list"
        );
    }

    #[tokio::test]
    async fn list_tags_for_block_nonexistent_block_returns_empty() {
        let (pool, _dir) = test_pool().await;

        let result = list_tags_for_block(&pool, "DOES_NOT_EXIST").await.unwrap();

        assert!(
            result.is_empty(),
            "nonexistent block should return empty list"
        );
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

        // Without escaping, "100%" would match both tags via LIKE '100%%'.
        // With escaping, "100%" matches only "100%_special" (literal %).
        let result: FxHashSet<String> = resolve_expr(&pool, &TagExpr::Prefix("100%".into()), false)
            .await
            .unwrap();

        assert_eq!(
            result.len(),
            1,
            "should match only the tag with literal '%'"
        );
        assert!(
            result.contains("BLK_1"),
            "block tagged with literal '%' tag should match"
        );
        assert!(
            !result.contains("BLK_2"),
            "block tagged with non-literal-percent tag should not match"
        );
    }

    // ======================================================================
    // resolve_expr: direct TagExpr variant coverage
    // ======================================================================

    #[tokio::test]
    async fn resolve_expr_tag_single_match() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG_SINGLE", "tag", "solo").await;
        insert_block(&pool, "BLK_SOLO", "content", "only one").await;
        insert_tag_assoc(&pool, "BLK_SOLO", "TAG_SINGLE").await;

        let result = resolve_expr(&pool, &TagExpr::Tag("TAG_SINGLE".into()), false)
            .await
            .unwrap();
        assert_eq!(
            result.len(),
            1,
            "Tag variant should match exactly one block"
        );
        assert!(
            result.contains("BLK_SOLO"),
            "result should contain the tagged block"
        );
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
        assert_eq!(
            result.len(),
            1,
            "Prefix variant should match exactly one block"
        );
        assert!(
            result.contains("BLK_PD1"),
            "result should contain the prefix-matched block"
        );
    }

    #[tokio::test]
    async fn resolve_expr_and_empty_direct() {
        let (pool, _dir) = test_pool().await;

        let result = resolve_expr(&pool, &TagExpr::And(vec![]), false)
            .await
            .unwrap();
        assert!(result.is_empty(), "empty And must return empty set");
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

        assert!(
            !result.contains("BLK_ND1"),
            "tagged block should be excluded"
        );
        assert!(
            result.contains("BLK_ND2"),
            "untagged block should be included"
        );
        assert!(
            result.contains("TAG_ND"),
            "tag block itself should be in complement"
        );
    }

    // ======================================================================
    // Tag inheritance (F-15)
    // ======================================================================

    /// Insert a block with an explicit parent_id.
    async fn insert_child_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: &str,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, ?, ?, 1)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn resolve_tag_with_inheritance_includes_descendants() {
        let (pool, _dir) = test_pool().await;

        // Create a page tagged with T1, and child blocks under it.
        insert_block(&pool, "TAG_T1", "tag", "t1").await;
        insert_block(&pool, "PAGE_A", "page", "tagged page").await;
        insert_child_block(&pool, "CHILD_1", "content", "child one", "PAGE_A").await;
        insert_child_block(&pool, "CHILD_2", "content", "child two", "PAGE_A").await;

        insert_tag_assoc(&pool, "PAGE_A", "TAG_T1").await;
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();

        // With inheritance=true, all children should appear in T1 query.
        let result_inherited = resolve_expr(&pool, &TagExpr::Tag("TAG_T1".into()), true)
            .await
            .unwrap();

        assert!(
            result_inherited.contains("PAGE_A"),
            "inherited result should contain tagged page"
        );
        assert!(
            result_inherited.contains("CHILD_1"),
            "inherited result should contain child 1"
        );
        assert!(
            result_inherited.contains("CHILD_2"),
            "inherited result should contain child 2"
        );
        assert_eq!(
            result_inherited.len(),
            3,
            "inherited result should contain page + 2 children"
        );

        // With inheritance=false, only the page appears.
        let result_direct = resolve_expr(&pool, &TagExpr::Tag("TAG_T1".into()), false)
            .await
            .unwrap();

        assert!(
            result_direct.contains("PAGE_A"),
            "direct result should contain tagged page"
        );
        assert!(
            !result_direct.contains("CHILD_1"),
            "direct result should not contain child 1"
        );
        assert!(
            !result_direct.contains("CHILD_2"),
            "direct result should not contain child 2"
        );
        assert_eq!(
            result_direct.len(),
            1,
            "direct result should contain only the tagged page"
        );
    }

    #[tokio::test]
    async fn resolve_tag_with_inheritance_multi_level() {
        let (pool, _dir) = test_pool().await;

        // Page → child → grandchild. Tag the page.
        insert_block(&pool, "TAG_T2", "tag", "t2").await;
        insert_block(&pool, "PAGE_B", "page", "root page").await;
        insert_child_block(&pool, "CHILD_B1", "content", "child", "PAGE_B").await;
        insert_child_block(&pool, "GRAND_B1", "content", "grandchild", "CHILD_B1").await;

        insert_tag_assoc(&pool, "PAGE_B", "TAG_T2").await;
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();

        // All three levels should match with inheritance.
        let result = resolve_expr(&pool, &TagExpr::Tag("TAG_T2".into()), true)
            .await
            .unwrap();

        assert!(
            result.contains("PAGE_B"),
            "multi-level inheritance should include page"
        );
        assert!(
            result.contains("CHILD_B1"),
            "multi-level inheritance should include child"
        );
        assert!(
            result.contains("GRAND_B1"),
            "multi-level inheritance should include grandchild"
        );
        assert_eq!(
            result.len(),
            3,
            "multi-level inheritance should match 3 blocks"
        );
    }

    #[tokio::test]
    async fn resolve_tag_with_inheritance_does_not_include_siblings() {
        let (pool, _dir) = test_pool().await;

        // Two pages, only one tagged. Children of the untagged page should NOT appear.
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

        assert!(
            result.contains("PAGE_C1"),
            "tagged page should be in result"
        );
        assert!(
            result.contains("CHILD_C1"),
            "child of tagged page should be in result"
        );
        assert!(
            !result.contains("PAGE_C2"),
            "untagged sibling page should not be in result"
        );
        assert!(
            !result.contains("CHILD_C2"),
            "child of untagged page should not be in result"
        );
        assert_eq!(
            result.len(),
            2,
            "inheritance should not cross to sibling subtrees"
        );
    }

    #[tokio::test]
    async fn resolve_prefix_with_inheritance() {
        let (pool, _dir) = test_pool().await;

        // Same as resolve_tag_with_inheritance_includes_descendants but using Prefix.
        insert_block(&pool, "TAG_WI", "tag", "work/inherit").await;
        insert_tag_cache(&pool, "TAG_WI", "work/inherit", 1).await;

        insert_block(&pool, "PAGE_D", "page", "work page").await;
        insert_child_block(&pool, "CHILD_D1", "content", "work child", "PAGE_D").await;

        insert_tag_assoc(&pool, "PAGE_D", "TAG_WI").await;
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();

        // With inheritance=true, descendants should be included.
        let result_inherited = resolve_expr(&pool, &TagExpr::Prefix("work/".into()), true)
            .await
            .unwrap();

        assert!(
            result_inherited.contains("PAGE_D"),
            "prefix inherited should include tagged page"
        );
        assert!(
            result_inherited.contains("CHILD_D1"),
            "prefix inherited should include child"
        );
        assert_eq!(
            result_inherited.len(),
            2,
            "prefix inherited should match page + child"
        );

        // Without inheritance, only the directly tagged block.
        let result_direct = resolve_expr(&pool, &TagExpr::Prefix("work/".into()), false)
            .await
            .unwrap();

        assert!(
            result_direct.contains("PAGE_D"),
            "prefix direct should include tagged page"
        );
        assert!(
            !result_direct.contains("CHILD_D1"),
            "prefix direct should not include child"
        );
        assert_eq!(
            result_direct.len(),
            1,
            "prefix direct should match only the tagged page"
        );
    }

    #[tokio::test]
    async fn eval_tag_query_with_inheritance_paginates() {
        let (pool, _dir) = test_pool().await;

        // Create a tagged page with 4 children.
        insert_block(&pool, "TAG_PG", "tag", "pg").await;
        insert_block(&pool, "PAGE_PG", "page", "paginated page").await;
        insert_tag_assoc(&pool, "PAGE_PG", "TAG_PG").await;

        // Children with IDs that sort after PAGE_PG
        for suffix in &["PG_C1", "PG_C2", "PG_C3", "PG_C4"] {
            insert_child_block(
                &pool,
                suffix,
                "content",
                &format!("child {suffix}"),
                "PAGE_PG",
            )
            .await;
        }
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();

        let expr = TagExpr::Tag("TAG_PG".into());

        // Page 1: limit 2 (with inheritance)
        let page1 = PageRequest::new(None, Some(2)).unwrap();
        let resp1 = eval_tag_query(&pool, &expr, &page1, true).await.unwrap();
        assert_eq!(
            resp1.items.len(),
            2,
            "inherited page 1 should return 2 items"
        );
        assert!(
            resp1.has_more,
            "inherited page 1 should indicate more pages"
        );
        assert!(
            resp1.next_cursor.is_some(),
            "inherited page 1 should provide next cursor"
        );

        // Page 2: continue from cursor
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_tag_query(&pool, &expr, &page2, true).await.unwrap();
        assert_eq!(
            resp2.items.len(),
            2,
            "inherited page 2 should return 2 items"
        );
        assert!(
            resp2.has_more,
            "inherited page 2 should indicate more pages"
        );

        // Page 3: last page (1 remaining)
        let page3 = PageRequest::new(resp2.next_cursor, Some(2)).unwrap();
        let resp3 = eval_tag_query(&pool, &expr, &page3, true).await.unwrap();
        assert_eq!(
            resp3.items.len(),
            1,
            "inherited page 3 should return 1 remaining item"
        );
        assert!(
            !resp3.has_more,
            "inherited last page should not indicate more"
        );
        assert!(
            resp3.next_cursor.is_none(),
            "inherited last page should have no cursor"
        );

        // Total items across all pages = 5 (PAGE_PG + 4 children)
        let total = resp1.items.len() + resp2.items.len() + resp3.items.len();
        assert_eq!(total, 5, "total items across all pages should be 5");
    }

    // ======================================================================
    // CTE oracle vs materialized correctness verification
    // ======================================================================

    #[tokio::test]
    async fn materialized_matches_cte_oracle() {
        let (pool, _dir) = test_pool().await;

        // Build a multi-level tree: page -> child1, child2 -> grandchild1
        insert_block(&pool, "TAG1", "tag", "tag1").await;
        insert_block(&pool, "TAG2", "tag", "tag2").await;
        insert_tag_cache(&pool, "TAG1", "tag1", 1).await;
        insert_tag_cache(&pool, "TAG2", "tag2", 1).await;

        insert_block(&pool, "PAGE_O", "page", "oracle page").await;
        insert_child_block(&pool, "CHILD_O1", "content", "child one", "PAGE_O").await;
        insert_child_block(&pool, "CHILD_O2", "content", "child two", "PAGE_O").await;
        insert_child_block(&pool, "GRAND_O1", "content", "grandchild one", "CHILD_O2").await;

        // Tag the page with TAG1, child2 with TAG2
        insert_tag_assoc(&pool, "PAGE_O", "TAG1").await;
        insert_tag_assoc(&pool, "CHILD_O2", "TAG2").await;

        // Populate materialized table
        crate::tag_inheritance::rebuild_all(&pool).await.unwrap();

        // --- TagExpr::Tag with inheritance ---
        for tag in &["TAG1", "TAG2"] {
            let expr = TagExpr::Tag((*tag).to_string());
            let mat = resolve_expr(&pool, &expr, true).await.unwrap();
            let cte = resolve_expr_cte(&pool, &expr, true).await.unwrap();
            assert_eq!(
                mat, cte,
                "Tag({tag}) materialized vs CTE mismatch: mat={mat:?}, cte={cte:?}"
            );
        }

        // --- TagExpr::Prefix with inheritance ---
        let prefix_expr = TagExpr::Prefix("tag".into());
        let mat_prefix = resolve_expr(&pool, &prefix_expr, true).await.unwrap();
        let cte_prefix = resolve_expr_cte(&pool, &prefix_expr, true).await.unwrap();
        assert_eq!(
            mat_prefix, cte_prefix,
            "Prefix(\"tag\") materialized vs CTE mismatch: mat={mat_prefix:?}, cte={cte_prefix:?}"
        );

        // --- TagExpr::And ---
        let and_expr = TagExpr::And(vec![
            TagExpr::Tag("TAG1".into()),
            TagExpr::Tag("TAG2".into()),
        ]);
        let mat_and = resolve_expr(&pool, &and_expr, true).await.unwrap();
        let cte_and = resolve_expr_cte(&pool, &and_expr, true).await.unwrap();
        assert_eq!(
            mat_and, cte_and,
            "And(TAG1,TAG2) materialized vs CTE mismatch: mat={mat_and:?}, cte={cte_and:?}"
        );

        // --- TagExpr::Or ---
        let or_expr = TagExpr::Or(vec![
            TagExpr::Tag("TAG1".into()),
            TagExpr::Tag("TAG2".into()),
        ]);
        let mat_or = resolve_expr(&pool, &or_expr, true).await.unwrap();
        let cte_or = resolve_expr_cte(&pool, &or_expr, true).await.unwrap();
        assert_eq!(
            mat_or, cte_or,
            "Or(TAG1,TAG2) materialized vs CTE mismatch: mat={mat_or:?}, cte={cte_or:?}"
        );

        // --- TagExpr::Not ---
        let not_expr = TagExpr::Not(Box::new(TagExpr::Tag("TAG1".into())));
        let mat_not = resolve_expr(&pool, &not_expr, true).await.unwrap();
        let cte_not = resolve_expr_cte(&pool, &not_expr, true).await.unwrap();
        assert_eq!(
            mat_not, cte_not,
            "Not(TAG1) materialized vs CTE mismatch: mat={mat_not:?}, cte={cte_not:?}"
        );
    }
}
