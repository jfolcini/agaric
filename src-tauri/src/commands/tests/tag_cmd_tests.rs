use super::super::*;
use super::common::*;
use crate::soft_delete;

// ======================================================================
// add_tag
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_success() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "AT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "AT_TAG", "tag", "urgent", None, None).await;

    let resp = add_tag_inner(&pool, DEV, &mat, "AT_BLK".into(), "AT_TAG".into())
        .await
        .unwrap();

    assert_eq!(resp.block_id, "AT_BLK", "response block_id should match");
    assert_eq!(resp.tag_id, "AT_TAG", "response tag_id should match");

    // Verify block_tags row
    let row = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        "AT_BLK",
        "AT_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(row.is_some(), "block_tags row should exist after add_tag");

    // Verify op_log row was written with op_type='add_tag' (TEST-41)
    let block_id = "AT_BLK";
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'add_tag' \
         AND json_extract(payload, '$.block_id') = ?",
    )
    .bind(block_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "add_tag should have written exactly one op_log row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_duplicate_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ATD_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATD_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "ATD_BLK".into(), "ATD_TAG".into())
        .await
        .unwrap();

    let result = add_tag_inner(&pool, DEV, &mat, "ATD_BLK".into(), "ATD_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "adding same tag twice should return InvalidOperation"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("tag already applied"),
        "error message should mention tag already applied"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_nonexistent_block_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ATN_TAG", "tag", "urgent", None, None).await;

    let result = add_tag_inner(&pool, DEV, &mat, "NONEXISTENT".into(), "ATN_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding tag to nonexistent block should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_nonexistent_tag_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ATNT_BLK", "content", "my block", None, Some(1)).await;

    let result = add_tag_inner(&pool, DEV, &mat, "ATNT_BLK".into(), "NONEXISTENT".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "adding nonexistent tag should return NotFound"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_non_tag_block_type_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ATNBT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATNBT_CONT", "content", "not a tag", None, Some(2)).await;

    let result = add_tag_inner(&pool, DEV, &mat, "ATNBT_BLK".into(), "ATNBT_CONT".into()).await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "using a content block as tag_id should return InvalidOperation"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("expected 'tag'"),
        "error message should mention expected tag type"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_self_returns_invalid_operation() {
    // L-34 regression: a block cannot tag itself. The guard rejects the call
    // before any DB work, regardless of whether the block exists or its type.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "AT_SELF", "tag", "self", None, None).await;

    let result = add_tag_inner(&pool, DEV, &mat, "AT_SELF".into(), "AT_SELF".into()).await;

    assert!(
        matches!(result, Err(AppError::InvalidOperation(_))),
        "self-tagging should return InvalidOperation, got {result:?}"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("a block cannot tag itself"),
        "error message should mention self-tag guard, got {err}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_deleted_block_returns_not_found() {
    // TEST-40: soft-deleted block must reject add_tag with NotFound. The
    // block-existence check in `add_tag_inner` filters `deleted_at IS NULL`,
    // so a cascaded soft-delete must surface as NotFound (not a stale row).
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ATDEL_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "ATDEL_TAG", "tag", "urgent", None, None).await;

    soft_delete::cascade_soft_delete(&pool, &mat, DEV, "ATDEL_BLK")
        .await
        .unwrap();

    let result = add_tag_inner(&pool, DEV, &mat, "ATDEL_BLK".into(), "ATDEL_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "add_tag on soft-deleted block should return NotFound, got: {result:?}"
    );
}

// ======================================================================
// remove_tag
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_success() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "RT_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RT_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
        .await
        .unwrap();

    let resp = remove_tag_inner(&pool, DEV, &mat, "RT_BLK".into(), "RT_TAG".into())
        .await
        .unwrap();

    assert_eq!(resp.block_id, "RT_BLK", "response block_id should match");
    assert_eq!(resp.tag_id, "RT_TAG", "response tag_id should match");

    // Verify block_tags is empty
    let row = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        "RT_BLK",
        "RT_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        row.is_none(),
        "block_tags row should be gone after remove_tag"
    );

    // Verify op_log row was written with op_type='remove_tag' (TEST-41)
    let block_id = "RT_BLK";
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM op_log WHERE op_type = 'remove_tag' \
         AND json_extract(payload, '$.block_id') = ?",
    )
    .bind(block_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        count, 1,
        "remove_tag should have written exactly one op_log row"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_not_applied_returns_error() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "RTNA_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RTNA_TAG", "tag", "urgent", None, None).await;

    let result = remove_tag_inner(&pool, DEV, &mat, "RTNA_BLK".into(), "RTNA_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "removing a tag that was never applied should return NotFound"
    );
    let err = result.unwrap_err();
    assert!(
        err.to_string().contains("tag association"),
        "error message should mention tag association"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remove_tag_deleted_block_returns_not_found() {
    // TEST-40: soft-deleted block must reject remove_tag with NotFound. The
    // block-existence check in `remove_tag_inner` filters `deleted_at IS NULL`
    // before the association lookup, so the cascade-deleted block surfaces
    // as NotFound even though the `block_tags` row physically still exists.
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "RTDEL_BLK", "content", "my block", None, Some(1)).await;
    insert_block(&pool, "RTDEL_TAG", "tag", "urgent", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "RTDEL_BLK".into(), "RTDEL_TAG".into())
        .await
        .unwrap();

    soft_delete::cascade_soft_delete(&pool, &mat, DEV, "RTDEL_BLK")
        .await
        .unwrap();

    let result = remove_tag_inner(&pool, DEV, &mat, "RTDEL_BLK".into(), "RTDEL_TAG".into()).await;

    assert!(
        matches!(result, Err(AppError::NotFound(_))),
        "remove_tag on soft-deleted block should return NotFound, got: {result:?}"
    );
}

// ======================================================================
// list_tags_by_prefix_inner
// ======================================================================

/// Helper: insert a tag_cache entry for command-level tests.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_by_prefix_inner_returns_matching() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG_WM", "tag", "work/meeting", None, None).await;
    insert_block(&pool, "TAG_WE", "tag", "work/email", None, None).await;
    insert_block(&pool, "TAG_P", "tag", "personal", None, None).await;

    insert_tag_cache(&pool, "TAG_WM", "work/meeting", 5).await;
    insert_tag_cache(&pool, "TAG_WE", "work/email", 3).await;
    insert_tag_cache(&pool, "TAG_P", "personal", 10).await;

    let result = list_tags_by_prefix_inner(&pool, "work/".into(), None)
        .await
        .unwrap();

    assert_eq!(result.len(), 2, "should match both work/ tags");
    assert_eq!(
        result[0].name, "work/email",
        "first tag should be work/email"
    );
    assert_eq!(
        result[1].name, "work/meeting",
        "second tag should be work/meeting"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_by_prefix_inner_empty_returns_empty() {
    let (pool, _dir) = test_pool().await;

    let result = list_tags_by_prefix_inner(&pool, "nonexistent/".into(), None)
        .await
        .unwrap();

    assert!(
        result.is_empty(),
        "nonexistent prefix should return no tags"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_by_prefix_inner_respects_limit() {
    let (pool, _dir) = test_pool().await;

    for i in 0..5 {
        insert_block(
            &pool,
            &format!("TAG_A{i}"),
            "tag",
            &format!("alpha{i}"),
            None,
            None,
        )
        .await;
        insert_tag_cache(&pool, &format!("TAG_A{i}"), &format!("alpha{i}"), 1).await;
    }

    let result = list_tags_by_prefix_inner(&pool, "alpha".into(), Some(2))
        .await
        .unwrap();
    assert_eq!(result.len(), 2, "limit=2 should return exactly 2 tags");
}

// ======================================================================
// list_tags_inner — cursor pagination (M-85)
// ======================================================================
//
// `list_tags_inner` migrated from a flat `Vec<TagCacheRow>` to a
// `PageResponse<TagCacheRow>` so the FEAT-4c MCP `list_tags` tool exposes
// the canonical cursor surface (AGENTS.md invariant #3). Ordered by
// `tag_id ASC` so the keyset cursor (`Cursor::for_id(tag_id)`) is
// monotonic. These four tests pin the contract end-to-end:
// limit-overflow → cursor; multi-page walk → strict ordering, no dup;
// no-cursor first-page; empty fixture → `has_more=false`.

/// Helper: seed `count` tag rows with deterministic ULID-shaped ids
/// (`TAG_M85_<ASCII-letters>`) so the keyset ordering is predictable.
/// Uses `insert_tag_cache` directly so we control the row count exactly
/// — avoids the materializer-driven create_block path which would
/// also touch op_log + block_tags and slow the test.
async fn seed_m85_tags(pool: &SqlitePool, count: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(count);
    for i in 0..count {
        // Stable ASCII-letter suffix so ordering is bytes-lex == numeric.
        let suffix = format!("{:03}", i);
        let id = format!("TAG_M85_{suffix}");
        let name = format!("tag-m85-{suffix}");
        insert_block(pool, &id, "tag", &name, None, None).await;
        insert_tag_cache(pool, &id, &name, 0).await;
        ids.push(id);
    }
    ids
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_returns_next_cursor_when_capped_m85() {
    let (pool, _dir) = test_pool().await;
    // Seed 8 tag rows; with limit=5 the first page must overflow and
    // surface a cursor.
    seed_m85_tags(&pool, 8).await;

    let page = list_tags_inner(&pool, None, Some(5)).await.unwrap();
    assert_eq!(
        page.items.len(),
        5,
        "first page should contain exactly the requested 5 entries (got {})",
        page.items.len()
    );
    assert!(
        page.has_more,
        "has_more must be true when more entries remain past the page cap (M-85)"
    );
    assert!(
        page.next_cursor.is_some(),
        "next_cursor must be populated when has_more is true so callers can page (M-85)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_walks_pages_correctly_m85() {
    let (pool, _dir) = test_pool().await;
    // Seed exactly 10 rows; with limit=4 we expect three pages: 4 + 4 + 2.
    let ids = seed_m85_tags(&pool, 10).await;

    let mut walked: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut iterations = 0;
    loop {
        iterations += 1;
        assert!(iterations < 10, "pagination must terminate (loop guard)");
        let page = list_tags_inner(&pool, cursor, Some(4)).await.unwrap();
        for row in &page.items {
            walked.push(row.tag_id.clone());
        }
        if !page.has_more {
            assert!(
                page.next_cursor.is_none(),
                "final page must not carry a next_cursor"
            );
            break;
        }
        cursor = page.next_cursor;
        assert!(cursor.is_some(), "intermediate page must have next_cursor");
    }

    assert_eq!(
        walked.len(),
        ids.len(),
        "walking all pages must yield exactly {} entries (one per seeded tag), got {}",
        ids.len(),
        walked.len()
    );

    // Strictly increasing on tag_id (ULID-shaped keyset).
    for window in walked.windows(2) {
        assert!(
            window[0] < window[1],
            "pagination must yield strictly-increasing tag_ids; \
             saw {} → {}",
            window[0],
            window[1],
        );
    }

    // No duplicates across pages.
    let mut seen = std::collections::HashSet::new();
    for tag_id in &walked {
        assert!(
            seen.insert(tag_id.clone()),
            "duplicate tag_id across pages: {tag_id}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_with_no_cursor_returns_first_page_m85() {
    let (pool, _dir) = test_pool().await;
    let ids = seed_m85_tags(&pool, 3).await;

    let page = list_tags_inner(&pool, None, None).await.unwrap();
    assert_eq!(
        page.items.len(),
        3,
        "small fixture must fit on the first page under the default limit",
    );
    assert!(!page.has_more, "no second page expected for 3-row fixture");
    assert!(page.next_cursor.is_none(), "no cursor when has_more=false");
    // First page rows must match the seeded ids in monotonic order.
    let returned: Vec<String> = page.items.iter().map(|r| r.tag_id.clone()).collect();
    assert_eq!(returned, ids, "first page rows must match seed order");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_tags_empty_result_returns_no_cursor_m85() {
    let (pool, _dir) = test_pool().await;
    // No tags seeded — the result must be empty with no cursor and
    // `has_more = false` (M-85).
    let page = list_tags_inner(&pool, None, Some(5)).await.unwrap();
    assert_eq!(page.items.len(), 0, "no rows should yield an empty page");
    assert!(page.next_cursor.is_none(), "empty result must not paginate");
    assert!(!page.has_more, "empty result must report has_more=false");
}

// ======================================================================
// PEND-18 Phase 2 — SpaceScope parity test
// ======================================================================
//
// Asserts that `query_by_tags_inner` honours the `&SpaceScope` boundary:
// `Global` returns the union across spaces, `Active(SpaceId)` returns
// only the named space's subset.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pend18_query_by_tags_scope_parity() {
    use crate::space::{SpaceId, SpaceScope};
    let (pool, _dir) = test_pool().await;

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    insert_block(&pool, "P18_TG_T", "tag", "shared", None, None).await;
    insert_block(&pool, "P18_TG_A", "content", "block A", None, None).await;
    insert_block(&pool, "P18_TG_B", "content", "block B", None, None).await;

    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind("P18_TG_A")
        .bind("P18_TG_T")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind("P18_TG_B")
        .bind("P18_TG_T")
        .execute(&pool)
        .await
        .unwrap();

    assign_to_space(&pool, "P18_TG_A", TEST_SPACE_ID).await;
    assign_to_space(&pool, "P18_TG_B", TEST_SPACE_B_ID).await;

    let global = query_by_tags_inner(
        &pool,
        vec!["P18_TG_T".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Global,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        global.items.len(),
        2,
        "Global must surface both spaces' blocks; got {global:?}"
    );

    let active_a = query_by_tags_inner(
        &pool,
        vec!["P18_TG_T".into()],
        vec![],
        "or".into(),
        None,
        None,
        None,
        &SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID)),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        active_a.items.len(),
        1,
        "Active(TEST_SPACE_ID) must surface only space A's block; got {active_a:?}"
    );
    assert_eq!(active_a.items[0].id, "P18_TG_A");
}

// ======================================================================
// PEND-76 F4 — orphan-tag adoption on add_tag
// ======================================================================

/// A tag with no space yet (e.g. created mid-session) applied to a block
/// in a non-default space is ADOPTED into that space rather than rejected
/// as cross-space.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_adopts_orphan_tag_into_source_space() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    ensure_test_space(&pool).await;
    insert_block(&pool, "F4_BLK", "content", "in test space", None, Some(1)).await;
    assign_to_space(&pool, "F4_BLK", TEST_SPACE_ID).await;
    // Orphan tag — deliberately no `space` property.
    insert_block(&pool, "F4_TAG", "tag", "fresh-tag", None, None).await;

    add_tag_inner(&pool, DEV, &mat, "F4_BLK".into(), "F4_TAG".into())
        .await
        .expect("add_tag should adopt the orphan tag, not reject it");

    let tagged = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        "F4_BLK",
        "F4_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(tagged.is_some(), "block_tags row must be written");

    // #533 Phase 2: the tag was adopted into the source block's space via
    // the `blocks.space_id` column (the sole source of truth).
    let space_ref: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT space_id FROM blocks WHERE id = ?")
            .bind("F4_TAG")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        space_ref.as_deref(),
        Some(TEST_SPACE_ID),
        "the orphan tag must be adopted into the source block's space"
    );
}

/// A tag that already belongs to a *different* space is still rejected —
/// only orphan (space-less) tags are adopted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tag_rejects_genuine_cross_space_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    insert_block(&pool, "F4X_BLK", "content", "in space A", None, Some(1)).await;
    assign_to_space(&pool, "F4X_BLK", TEST_SPACE_ID).await;
    insert_block(&pool, "F4X_TAG", "tag", "space-B-tag", None, None).await;
    assign_to_space(&pool, "F4X_TAG", TEST_SPACE_B_ID).await;

    let result = add_tag_inner(&pool, DEV, &mat, "F4X_BLK".into(), "F4X_TAG".into()).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "a tag from a different space must still be rejected, got {result:?}"
    );
}

// ======================================================================
// #81 / PEND-57 — add_tags_by_ids (bulk add-tag)
// ======================================================================

/// Happy path: ONE tag applied to N blocks writes N `add_tag` ops in a
/// single contiguous seq range and N `block_tags` rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tags_by_ids_tags_all_blocks_in_one_tx() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ABI_TAG", "tag", "urgent", None, None).await;
    let mut ids: Vec<BlockId> = Vec::new();
    for i in 0..4 {
        let id = format!("ABI_BLK_{i}");
        insert_block(&pool, &id, "content", "blk", None, Some(i + 1)).await;
        ids.push(BlockId::from(id));
    }

    let pre_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let tagged = add_tags_by_ids_inner(&pool, DEV, &mat, ids.clone(), "ABI_TAG".into())
        .await
        .unwrap();
    assert_eq!(tagged, 4, "all four blocks should be reported as tagged");

    let post_max: i64 = sqlx::query_scalar!(
        "SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?",
        DEV
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        post_max - pre_max,
        4,
        "the 4 add_tag ops must occupy a single contiguous seq range"
    );

    for id in &ids {
        let id_str = id.as_str();
        let row = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
            id_str,
            "ABI_TAG"
        )
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert!(row.is_some(), "block_tags row for {id} must exist");
    }
}

/// Lenient batch: missing / soft-deleted / self / already-tagged ids are
/// silently skipped; only the genuinely-new live associations count.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tags_by_ids_skips_missing_deleted_self_and_duplicate() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ABI2_TAG", "tag", "urgent", None, None).await;
    insert_block(&pool, "ABI2_LIVE", "content", "live", None, Some(1)).await;
    insert_block(&pool, "ABI2_DUP", "content", "already", None, Some(2)).await;
    insert_block(&pool, "ABI2_DEL", "content", "gone", None, Some(3)).await;

    // Pre-tag the duplicate so the batch must skip it.
    add_tag_inner(&pool, DEV, &mat, "ABI2_DUP".into(), "ABI2_TAG".into())
        .await
        .unwrap();
    settle(&mat).await;
    // Soft-delete one block so the batch must skip it.
    delete_block_inner(&pool, DEV, &mat, "ABI2_DEL".into())
        .await
        .unwrap();
    settle(&mat).await;

    let tagged = add_tags_by_ids_inner(
        &pool,
        DEV,
        &mat,
        vec![
            "ABI2_LIVE".into(),
            "ABI2_DUP".into(),   // already tagged -> skip
            "ABI2_DEL".into(),   // soft-deleted -> skip
            "ABI2_TAG".into(),   // self-tag -> skip
            "ABI2_GHOST".into(), // missing -> skip
        ],
        "ABI2_TAG".into(),
    )
    .await
    .unwrap();
    assert_eq!(tagged, 1, "only the one fresh live association counts");

    let row = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        "ABI2_LIVE",
        "ABI2_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(row.is_some(), "the live block must be tagged");
}

/// ULID normalisation: a lowercase block id still resolves and tags.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tags_by_ids_normalises_lowercase_ids() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ABI3_TAG", "tag", "urgent", None, None).await;
    insert_block(&pool, "ABI3_BLK01", "content", "blk", None, Some(1)).await;

    let tagged = add_tags_by_ids_inner(
        &pool,
        DEV,
        &mat,
        vec!["abi3_blk01".into()],
        "abi3_tag".into(),
    )
    .await
    .unwrap();
    assert_eq!(tagged, 1);

    let row = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM block_tags WHERE block_id = ? AND tag_id = ?"#,
        "ABI3_BLK01",
        "ABI3_TAG"
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        row.is_some(),
        "lowercase ids must normalise to uppercase match"
    );
}

/// Empty input list is rejected up-front (caller error, not data drift).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tags_by_ids_rejects_empty_list() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block(&pool, "ABI4_TAG", "tag", "urgent", None, None).await;

    let result = add_tags_by_ids_inner(&pool, DEV, &mat, vec![], "ABI4_TAG".into()).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "empty block_ids must be rejected, got {result:?}"
    );
}

/// Over-cap input list is rejected up-front.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tags_by_ids_rejects_oversize_list() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    insert_block(&pool, "ABI5_TAG", "tag", "urgent", None, None).await;

    let oversize: Vec<BlockId> = (0..(crate::commands::MAX_BATCH_BLOCK_IDS + 1))
        .map(|i| BlockId::from(format!("ABI5_{i:026}")))
        .collect();
    let result = add_tags_by_ids_inner(&pool, DEV, &mat, oversize, "ABI5_TAG".into()).await;
    assert!(
        matches!(result, Err(AppError::Validation(_))),
        "oversize block_ids must be rejected, got {result:?}"
    );
}

/// A nonexistent / non-`tag` `tag_id` aborts the whole batch (one shared
/// validation, mirroring the single path).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn add_tags_by_ids_rejects_bad_tag() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    insert_block(&pool, "ABI6_BLK", "content", "blk", None, Some(1)).await;
    // A plain content block masquerading as a tag target.
    insert_block(&pool, "ABI6_NOTTAG", "content", "not a tag", None, Some(2)).await;

    // Missing tag id -> NotFound.
    let missing = add_tags_by_ids_inner(
        &pool,
        DEV,
        &mat,
        vec!["ABI6_BLK".into()],
        "ABI6_MISSING".into(),
    )
    .await;
    assert!(
        matches!(missing, Err(AppError::NotFound(_))),
        "missing tag must be NotFound, got {missing:?}"
    );

    // Wrong block_type -> InvalidOperation.
    let wrong = add_tags_by_ids_inner(
        &pool,
        DEV,
        &mat,
        vec!["ABI6_BLK".into()],
        "ABI6_NOTTAG".into(),
    )
    .await;
    assert!(
        matches!(wrong, Err(AppError::InvalidOperation(_))),
        "non-tag block_type must be InvalidOperation, got {wrong:?}"
    );

    // No association was written by the aborted batch.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM block_tags WHERE block_id = ?")
        .bind("ABI6_BLK")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "aborted batch must write no block_tags rows");
}
