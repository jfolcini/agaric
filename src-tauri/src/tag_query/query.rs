//! Public query API: `eval_tag_query`, `list_tags_by_prefix`, `list_tags_for_block`.

use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::resolve::resolve_expr;
use super::{TagCacheRow, TagExpr};
use crate::error::AppError;
use crate::pagination::{BlockRow, Cursor, PageRequest, PageResponse};
use crate::sql_utils::escape_like;

/// Evaluate a boolean tag expression and return a paginated set of blocks.
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
    let mut sorted_ids: Vec<&str> = block_ids.iter().map(String::as_str).collect();
    sorted_ids.sort();
    let start_after = page.after.as_ref().map(|c| c.id.as_str());
    let filtered: Vec<&str> = if let Some(after_id) = start_after {
        sorted_ids.into_iter().filter(|id| *id > after_id).collect()
    } else {
        sorted_ids
    };
    // page.limit is a validated positive pagination bound; safe to convert
    let limit_usize = usize::try_from(page.limit).unwrap_or(usize::MAX);
    let fetch_limit = limit_usize.saturating_add(1);
    let page_ids: Vec<&str> = filtered.into_iter().take(fetch_limit).collect();
    let has_more = page_ids.len() > limit_usize;
    let actual_ids: Vec<&str> = if has_more {
        page_ids[..limit_usize].to_vec()
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
    let placeholders = actual_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    // I-Search-14: defense-in-depth — `cache::rebuild_tags_cache` and the
    // production tag-resolve paths already exclude conflict copies and
    // soft-deleted rows at the leaves, but making the dependency explicit
    // in the final projection means a future change to `resolve_expr`
    // (e.g. a new `TagExpr` variant that re-includes the universe) cannot
    // accidentally surface a conflict copy in the response. Mirrors the
    // `is_conflict = 0` / `deleted_at IS NULL` filters used in
    // `cache::rebuild_tags_cache` and other production read paths.
    let query_str = format!(
        "SELECT id, block_type, content, parent_id, position, \
         deleted_at, is_conflict, conflict_type, \
         todo_state, priority, due_date, scheduled_date, page_id \
         FROM blocks \
         WHERE id IN ({placeholders}) \
           AND deleted_at IS NULL \
           AND is_conflict = 0 \
         ORDER BY id"
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

const MAX_TAGS_PREFIX: i64 = 200;

/// List all tags whose name starts with `prefix`, ordered by name.
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

/// List all tag_ids associated with a block.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::pagination::Cursor;
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
    async fn eval_tag_query_paginates_results() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_X", "tag", "x-tag").await;
        for suffix in &["A", "B", "C", "D", "E"] {
            let id = format!("BLK_{suffix}");
            insert_block(&pool, &id, "content", &format!("block {suffix}")).await;
            insert_tag_assoc(&pool, &id, "TAG_X").await;
        }
        let expr = TagExpr::Tag("TAG_X".into());
        let page1 = PageRequest::new(None, Some(2)).unwrap();
        let resp1 = eval_tag_query(&pool, &expr, &page1, false).await.unwrap();
        assert_eq!(resp1.items.len(), 2);
        assert_eq!(resp1.items[0].id, "BLK_A");
        assert_eq!(resp1.items[1].id, "BLK_B");
        assert!(resp1.has_more);
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_tag_query(&pool, &expr, &page2, false).await.unwrap();
        assert_eq!(resp2.items.len(), 2);
        assert_eq!(resp2.items[0].id, "BLK_C");
        assert_eq!(resp2.items[1].id, "BLK_D");
        let page3 = PageRequest::new(resp2.next_cursor, Some(2)).unwrap();
        let resp3 = eval_tag_query(&pool, &expr, &page3, false).await.unwrap();
        assert_eq!(resp3.items.len(), 1);
        assert_eq!(resp3.items[0].id, "BLK_E");
        assert!(!resp3.has_more);
        assert!(resp3.next_cursor.is_none());
    }
    #[tokio::test]
    async fn eval_tag_query_empty_result() {
        let (pool, _dir) = test_pool().await;
        let expr = TagExpr::Tag("NONEXISTENT".into());
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false).await.unwrap();
        assert!(resp.items.is_empty());
        assert!(!resp.has_more);
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
        assert_eq!(resp.items.len(), 1);
        let row = &resp.items[0];
        assert_eq!(row.id, "BLK_1");
        assert_eq!(row.block_type, "content");
        assert_eq!(row.content, Some("hello world".into()));
        assert!(row.deleted_at.is_none());
        assert!(!row.is_conflict);
    }
    #[tokio::test]
    async fn eval_tag_query_cursor_past_all_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "BLK_1", "content", "one").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        let expr = TagExpr::Tag("TAG_A".into());
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
        assert!(resp.items.is_empty());
        assert!(!resp.has_more);
    }
    #[tokio::test]
    async fn eval_tag_query_with_inheritance_paginates() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_PG", "tag", "pg").await;
        insert_block(&pool, "PAGE_PG", "page", "paginated page").await;
        insert_tag_assoc(&pool, "PAGE_PG", "TAG_PG").await;
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
        let page1 = PageRequest::new(None, Some(2)).unwrap();
        let resp1 = eval_tag_query(&pool, &expr, &page1, true).await.unwrap();
        assert_eq!(resp1.items.len(), 2);
        assert!(resp1.has_more);
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_tag_query(&pool, &expr, &page2, true).await.unwrap();
        assert_eq!(resp2.items.len(), 2);
        let page3 = PageRequest::new(resp2.next_cursor, Some(2)).unwrap();
        let resp3 = eval_tag_query(&pool, &expr, &page3, true).await.unwrap();
        assert_eq!(resp3.items.len(), 1);
        assert!(!resp3.has_more);
        let total = resp1.items.len() + resp2.items.len() + resp3.items.len();
        assert_eq!(total, 5);
    }
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
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "work/email");
        assert_eq!(result[1].name, "work/meeting");
    }
    #[tokio::test]
    async fn list_tags_by_prefix_empty_prefix_returns_all() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;
        insert_tag_cache(&pool, "TAG_B", "beta", 2).await;
        let result = list_tags_by_prefix(&pool, "", None).await.unwrap();
        assert_eq!(result.len(), 2);
    }
    #[tokio::test]
    async fn list_tags_by_prefix_no_match_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;
        let result = list_tags_by_prefix(&pool, "zzz", None).await.unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn list_tags_by_prefix_escapes_percent_in_prefix() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "100%_done").await;
        insert_block(&pool, "TAG_B", "tag", "alpha").await;
        insert_tag_cache(&pool, "TAG_A", "100%_done", 1).await;
        insert_tag_cache(&pool, "TAG_B", "alpha", 2).await;
        let result = list_tags_by_prefix(&pool, "%", None).await.unwrap();
        assert_eq!(result.len(), 0);
        let result = list_tags_by_prefix(&pool, "100%", None).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "100%_done");
    }
    #[tokio::test]
    async fn list_tags_for_block_returns_tag_ids() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_block(&pool, "BLK_1", "content", "hello").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_A").await;
        insert_tag_assoc(&pool, "BLK_1", "TAG_B").await;
        let result = list_tags_for_block(&pool, "BLK_1").await.unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0], "TAG_A");
        assert_eq!(result[1], "TAG_B");
    }
    #[tokio::test]
    async fn list_tags_for_block_no_tags_returns_empty() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "BLK_1", "content", "no tags").await;
        let result = list_tags_for_block(&pool, "BLK_1").await.unwrap();
        assert!(result.is_empty());
    }
    #[tokio::test]
    async fn list_tags_for_block_nonexistent_block_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = list_tags_for_block(&pool, "DOES_NOT_EXIST").await.unwrap();
        assert!(result.is_empty());
    }

    /// I-Search-14 — defense-in-depth: the final projection SELECT in
    /// `eval_tag_query` filters `is_conflict = 0` and `deleted_at IS NULL`.
    /// `resolve_expr` already excludes conflict copies and soft-deleted
    /// blocks at the leaves, but the defensive filter on the final SELECT
    /// guards against future regressions where the resolver might re-include
    /// the universe (e.g. an extension to `TagExpr::Not`).
    ///
    /// We exercise the contract by populating `block_tags` for a conflict
    /// block and a soft-deleted block and asserting `eval_tag_query`
    /// returns neither — even though `resolve_expr` is what excludes them
    /// today, mutating the projection to drop the defensive filter would
    /// fail this test the moment the resolver was relaxed.
    #[tokio::test]
    async fn eval_tag_query_excludes_conflict_and_deleted_blocks() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "TAG_X", "tag", "x").await;
        insert_block(&pool, "BLK_KEEP", "content", "keep me").await;
        insert_tag_assoc(&pool, "BLK_KEEP", "TAG_X").await;

        // Soft-deleted block tagged with TAG_X.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, deleted_at) \
             VALUES (?, 'content', 'soft-deleted', '2025-01-15T12:00:00+00:00')",
        )
        .bind("BLK_DEL")
        .execute(&pool)
        .await
        .unwrap();
        insert_tag_assoc(&pool, "BLK_DEL", "TAG_X").await;

        // Conflict-copy block tagged with TAG_X.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, is_conflict, conflict_type) \
             VALUES (?, 'content', 'conflict copy', 1, 'concurrent_edit')",
        )
        .bind("BLK_CONFLICT")
        .execute(&pool)
        .await
        .unwrap();
        insert_tag_assoc(&pool, "BLK_CONFLICT", "TAG_X").await;

        let expr = TagExpr::Tag("TAG_X".into());
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false).await.unwrap();
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["BLK_KEEP"],
            "eval_tag_query must exclude both conflict copies and soft-deleted \
             blocks via the defensive `is_conflict = 0` / `deleted_at IS NULL` \
             filter on the final projection (I-Search-14)"
        );
    }
}
