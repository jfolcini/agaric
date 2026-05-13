//! Public query API: `eval_tag_query`, `list_tags_by_prefix`, `list_tags_for_block`.

use rustc_hash::FxHashSet;
use sqlx::SqlitePool;

use super::resolve::resolve_expr;
use super::{TagCacheRow, TagExpr};
use crate::error::AppError;
use crate::pagination::{ActiveBlockRow, Cursor, PageRequest, PageResponse};
use crate::sql_utils::escape_like;

/// Evaluate a boolean tag expression and return a paginated set of blocks.
///
/// `space_id` (FEAT-3p4) — when `Some`, the final projection restricts
/// results to blocks whose owning page (`COALESCE(b.page_id, b.id)`)
/// carries `space = ?space_id`. `None` is the unscoped (pre-FEAT-3)
/// behaviour. The space filter is applied at the projection step (after
/// the tag resolver) so the tag expression continues to operate on the
/// full universe and only the visible result set is space-scoped.
///
/// `block_type` (PEND-35 Tier 3.4) — when `Some`, restricts the result
/// set to blocks whose `block_type` equals the supplied value. `None`
/// is the unfiltered (pre-Tier-3.4) behaviour. Pushes GraphView's
/// JS-side `pagesResp.items.filter(p => p.block_type === 'page')`
/// predicate into SQL so the unbounded `limit:5000` over-fetch and
/// post-filter discard collapses into one paginated query.
pub async fn eval_tag_query(
    pool: &SqlitePool,
    expr: &TagExpr,
    page: &PageRequest,
    include_inherited: bool,
    space_id: Option<&str>,
    block_type: Option<&str>,
) -> Result<PageResponse<ActiveBlockRow>, AppError> {
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
    // production tag-resolve paths already exclude soft-deleted rows
    // at the leaves, but making the dependency explicit in the final
    // projection means a future change to `resolve_expr` (e.g. a new
    // `TagExpr` variant that re-includes the universe) cannot
    // accidentally surface a soft-deleted row in the response.
    // Mirrors the `deleted_at IS NULL` filter used in
    // `cache::rebuild_tags_cache` and other production read paths.
    //
    // FEAT-3p4 — the trailing `(? IS NULL OR COALESCE(...))` clause
    // mirrors `crate::space_filter_clause!`. Resolves the candidate
    // block to its owning page via `COALESCE(b.page_id, b.id)` and
    // intersects against `block_properties(key = 'space').value_ref`
    // when `space_id` is `Some`. The single `?` is bound after the
    // ID-list placeholders below.
    // PEND-35 Tier 3.4 — `(? IS NULL OR b.block_type = ?)` push-down so
    // GraphView's `pagesResp.items.filter(p => p.block_type === 'page')`
    // post-filter is replaced by a SQL clause. Bound after the space
    // filter (two more trailing `?` placeholders).
    let query_str = format!(
        "SELECT {} \
         FROM blocks b \
         WHERE id IN ({placeholders}) \
           AND deleted_at IS NULL \
           AND (? IS NULL OR COALESCE(b.page_id, b.id) IN ( \
                SELECT bp.block_id FROM block_properties bp \
                WHERE bp.key = 'space' AND bp.value_ref = ?)) \
           AND (? IS NULL OR b.block_type = ?) \
         ORDER BY id",
        crate::pagination::block_row_columns::BLOCK_ROW_RUNTIME_SELECT,
    );
    // MAINT-113 M2 — query the rows as ActiveBlockRow directly. The SQL
    // above filters `deleted_at IS NULL` (lines
    // ~82-83), so every row sqlx hydrates is active. The
    // `id as "id: ActiveBlockId"` cast is implicit — sqlx::query_as
    // calls FromRow which decodes via `sqlx::Type` for ActiveBlockId
    // (transparent over String).
    let mut query = sqlx::query_as::<_, ActiveBlockRow>(&query_str);
    for id in &actual_ids {
        query = query.bind(*id);
    }
    // The trailing `?` placeholders for the space filter are bound twice
    // (once for the NULL guard, once for the value comparison) so the
    // dynamic-SQL form keeps the `(? IS NULL OR …)` short-circuit. The
    // `block_type` push-down (Tier 3.4) follows the same pattern.
    query = query
        .bind(space_id)
        .bind(space_id)
        .bind(block_type)
        .bind(block_type);
    let items: Vec<ActiveBlockRow> = query.fetch_all(pool).await?;
    let next_cursor = if has_more {
        let last = items.last().expect("has_more implies non-empty");
        Some(Cursor::for_id(last.id.as_str().to_string()).encode()?)
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
///
/// `limit` must be in `[1, MAX_TAGS_PREFIX]` when supplied; a value
/// outside that range surfaces as `AppError::Validation`
/// (limit-clamp-followup Phase 1).  `None` falls through to
/// `MAX_TAGS_PREFIX` as the default cap.
pub async fn list_tags_by_prefix(
    pool: &SqlitePool,
    prefix: &str,
    limit: Option<i64>,
) -> Result<Vec<TagCacheRow>, AppError> {
    let like_pattern = format!("{}%", escape_like(prefix));
    let effective_limit = match limit {
        Some(l) if (1..=MAX_TAGS_PREFIX).contains(&l) => l,
        Some(l) => {
            return Err(AppError::Validation(format!(
                "list_tags_by_prefix limit must be in [1, {MAX_TAGS_PREFIX}]; got {l}. \
                 Tag listings are typeahead-style — clamp your input to a sensible \
                 upper bound."
            )));
        }
        None => MAX_TAGS_PREFIX,
    };
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

/// Return every tag in `space_id`, ordered by name. No pagination, no
/// clamp.
///
/// Tags are space-scoped: each tag block (`block_type = 'tag'`) carries
/// its own `block_properties(key = 'space', value_ref = <space_id>)`
/// row (see `spaces::cross_space_validation` and the `add_tag` cross-
/// space guard at `commands/tags.rs:116`). The space filter therefore
/// applies the same `value_ref` predicate used by
/// `list_all_pages_in_space_inner` but keyed on the tag block itself
/// rather than on a page's owning block.
///
/// The result set is bounded by the space's intrinsic tag count
/// (workspaces typically have tens to hundreds of distinct tags). Use
/// this when the caller genuinely needs every tag (the tag-management
/// list view); use the prefix-paginated `list_tags_by_prefix` for
/// typeahead pickers.
pub async fn list_all_tags_in_space(
    pool: &SqlitePool,
    space_id: &str,
) -> Result<Vec<TagCacheRow>, AppError> {
    let rows = sqlx::query_as!(
        TagCacheRow,
        r#"SELECT tc.tag_id, tc.name, tc.usage_count, tc.updated_at
         FROM tags_cache tc
         WHERE tc.tag_id IN (
             SELECT bp.block_id FROM block_properties bp
             WHERE bp.key = 'space' AND bp.value_ref = ?1
         )
         ORDER BY tc.name"#,
        space_id,
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
        let resp1 = eval_tag_query(&pool, &expr, &page1, false, None, None)
            .await
            .unwrap();
        assert_eq!(resp1.items.len(), 2);
        assert_eq!(resp1.items[0].id, "BLK_A");
        assert_eq!(resp1.items[1].id, "BLK_B");
        assert!(resp1.has_more);
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_tag_query(&pool, &expr, &page2, false, None, None)
            .await
            .unwrap();
        assert_eq!(resp2.items.len(), 2);
        assert_eq!(resp2.items[0].id, "BLK_C");
        assert_eq!(resp2.items[1].id, "BLK_D");
        let page3 = PageRequest::new(resp2.next_cursor, Some(2)).unwrap();
        let resp3 = eval_tag_query(&pool, &expr, &page3, false, None, None)
            .await
            .unwrap();
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
        let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
            .await
            .unwrap();
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
        let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
            .await
            .unwrap();
        assert_eq!(resp.items.len(), 1);
        let row = &resp.items[0];
        assert_eq!(row.id, "BLK_1");
        assert_eq!(row.block_type, "content");
        assert_eq!(row.content, Some("hello world".into()));
        assert!(row.deleted_at.is_none());
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
        let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
            .await
            .unwrap();
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
        let resp1 = eval_tag_query(&pool, &expr, &page1, true, None, None)
            .await
            .unwrap();
        assert_eq!(resp1.items.len(), 2);
        assert!(resp1.has_more);
        let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
        let resp2 = eval_tag_query(&pool, &expr, &page2, true, None, None)
            .await
            .unwrap();
        assert_eq!(resp2.items.len(), 2);
        let page3 = PageRequest::new(resp2.next_cursor, Some(2)).unwrap();
        let resp3 = eval_tag_query(&pool, &expr, &page3, true, None, None)
            .await
            .unwrap();
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

    /// PEND-35 Tier 3.3 — the LIKE-prefix query in `list_tags_by_prefix`
    /// (`WHERE name LIKE ?1 ESCAPE '\' ORDER BY name LIMIT ?2`) is hit
    /// on every keystroke of every tag picker. SQLite's default LIKE is
    /// case-insensitive on ASCII, so the implicit BINARY index from
    /// `tags_cache.name UNIQUE` cannot satisfy the query. Migration 0050
    /// adds `idx_tags_cache_name_nocase ON tags_cache(name COLLATE
    /// NOCASE)` so the planner can do a NOCASE prefix range-scan.
    ///
    /// This test pins that the planner picks `idx_tags_cache_name_nocase`
    /// for that exact query shape — regressing the index (drop, rename,
    /// or accidentally dropping the `COLLATE NOCASE` clause) would flip
    /// the plan back to a full scan and fail this test.
    #[tokio::test]
    async fn list_tags_by_prefix_uses_nocase_index() {
        use sqlx::Row as _;
        let (pool, _dir) = test_pool().await;
        // Populate a few rows so the planner has stats to reason about
        // (also makes the test fail loudly if it ever returned wrong rows).
        insert_block(&pool, "TAG_A", "tag", "alpha").await;
        insert_block(&pool, "TAG_B", "tag", "beta").await;
        insert_tag_cache(&pool, "TAG_A", "alpha", 1).await;
        insert_tag_cache(&pool, "TAG_B", "beta", 2).await;

        // Mirror the exact query shape from `list_tags_by_prefix`. Use
        // dynamic `sqlx::query` (not `query!`) so the EXPLAIN prefix
        // doesn't get type-checked against the offline cache.
        let rows = sqlx::query(
            r#"EXPLAIN QUERY PLAN
               SELECT tag_id, name, usage_count, updated_at
               FROM tags_cache WHERE name LIKE ?1 ESCAPE '\' ORDER BY name LIMIT ?2"#,
        )
        .bind("a%")
        .bind(50_i64)
        .fetch_all(&pool)
        .await
        .unwrap();

        let plan: String = rows
            .iter()
            .map(|r| r.try_get::<String, _>("detail").unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            plan.contains("idx_tags_cache_name_nocase"),
            "expected query plan to use the NOCASE index added by \
             migration 0050, got plan:\n{plan}"
        );
    }

    /// Helper: assign a `space` property to a tag block (mirrors
    /// `block_properties` rows the materializer would normally write).
    async fn assign_tag_to_space(pool: &SqlitePool, tag_id: &str, space_id: &str) {
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) \
             VALUES (?, 'space', ?)",
        )
        .bind(tag_id)
        .bind(space_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Seed the space block so the FK on `block_properties.value_ref →
    /// blocks(id)` is satisfied.  Idempotent.
    async fn ensure_space_block(pool: &SqlitePool, space_id: &str) {
        sqlx::query(
            "INSERT OR IGNORE INTO blocks (id, block_type, content) \
             VALUES (?, 'page', 'Space')",
        )
        .bind(space_id)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn list_all_tags_in_space_returns_every_tag_in_scope() {
        let (pool, _dir) = test_pool().await;
        let space_a = "01TAGSPACEA0000000000000001";
        ensure_space_block(&pool, space_a).await;

        // Seed 350 tag rows in space_a — well above the
        // `MAX_TAGS_PREFIX = 200` cap that `list_tags_by_prefix`
        // applies, to prove this path is unclamped.
        for i in 0..350 {
            let id = format!("TAG_{i:04}");
            let name = format!("tag-{i:04}");
            insert_block(&pool, &id, "tag", &name).await;
            insert_tag_cache(&pool, &id, &name, 1).await;
            assign_tag_to_space(&pool, &id, space_a).await;
        }

        let result = list_all_tags_in_space(&pool, space_a).await.unwrap();
        assert_eq!(
            result.len(),
            350,
            "must return every tag in the space (no clamp); got {} rows",
            result.len()
        );
        // ORDER BY name keeps the result deterministic.
        assert_eq!(result[0].name, "tag-0000");
        assert_eq!(result[349].name, "tag-0349");
    }

    #[tokio::test]
    async fn list_all_tags_in_space_excludes_other_spaces() {
        let (pool, _dir) = test_pool().await;
        let space_a = "01TAGSPACEA0000000000000001";
        let space_b = "01TAGSPACEB0000000000000002";
        ensure_space_block(&pool, space_a).await;
        ensure_space_block(&pool, space_b).await;

        insert_block(&pool, "TAG_AA", "tag", "alpha").await;
        insert_tag_cache(&pool, "TAG_AA", "alpha", 3).await;
        assign_tag_to_space(&pool, "TAG_AA", space_a).await;

        insert_block(&pool, "TAG_AB", "tag", "beta").await;
        insert_tag_cache(&pool, "TAG_AB", "beta", 2).await;
        assign_tag_to_space(&pool, "TAG_AB", space_a).await;

        insert_block(&pool, "TAG_BB", "tag", "bravo").await;
        insert_tag_cache(&pool, "TAG_BB", "bravo", 5).await;
        assign_tag_to_space(&pool, "TAG_BB", space_b).await;

        // Unscoped tag — must be excluded from every space result.
        insert_block(&pool, "TAG_OO", "tag", "orphan").await;
        insert_tag_cache(&pool, "TAG_OO", "orphan", 1).await;

        let in_a = list_all_tags_in_space(&pool, space_a).await.unwrap();
        let ids_a: Vec<&str> = in_a.iter().map(|r| r.tag_id.as_str()).collect();
        assert_eq!(
            ids_a,
            vec!["TAG_AA", "TAG_AB"],
            "space A must surface only its own tags, ordered by name; \
             must exclude space B's tag and the unscoped orphan",
        );

        let in_b = list_all_tags_in_space(&pool, space_b).await.unwrap();
        let ids_b: Vec<&str> = in_b.iter().map(|r| r.tag_id.as_str()).collect();
        assert_eq!(
            ids_b,
            vec!["TAG_BB"],
            "space B must surface only its own tag",
        );
    }

    #[tokio::test]
    async fn list_all_tags_in_space_empty_space_returns_empty() {
        let (pool, _dir) = test_pool().await;
        let result = list_all_tags_in_space(&pool, "01NOSUCHSPACE00000000000000")
            .await
            .unwrap();
        assert!(
            result.is_empty(),
            "unknown space must return empty; got {result:?}"
        );
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
    /// `eval_tag_query` filters `deleted_at IS NULL`.
    /// `resolve_expr` already excludes soft-deleted blocks at the
    /// leaves, but the defensive filter on the final SELECT guards
    /// against future regressions where the resolver might re-include
    /// the universe (e.g. an extension to `TagExpr::Not`).
    #[tokio::test]
    async fn eval_tag_query_excludes_deleted_blocks() {
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

        let expr = TagExpr::Tag("TAG_X".into());
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = eval_tag_query(&pool, &expr, &page, false, None, None)
            .await
            .unwrap();
        let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["BLK_KEEP"],
            "eval_tag_query must exclude soft-deleted blocks via the \
             defensive `deleted_at IS NULL` filter on the final \
             projection (I-Search-14)"
        );
    }
}
