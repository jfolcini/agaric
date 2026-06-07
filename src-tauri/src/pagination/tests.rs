//! Tests for cursor-based keyset pagination — cursor codec, page request
//! validation, and all eleven paginated query functions (list_children,
//! list_by_type, list_trash, list_by_tag, list_agenda, list_agenda_range,
//! list_backlinks, list_block_history, list_page_history,
//! list_unfinished_tasks, list_undated_tasks).  Covers first-page,
//! cursor-continuation, last-page, empty results, ordering, tiebreakers,
//! soft-delete exclusion, cursor stability after inserts, exhaustive walks,
//! seq-field backward compatibility, and all op types in history.

use super::*;
use crate::db::init_pool;
use sqlx::SqlitePool;
use tempfile::TempDir;

// ── Deterministic test fixtures ─────────────────────────────────────

const FIXED_DELETED_AT: &str = "2025-01-15T00:00:00+00:00";

// ── Helpers ─────────────────────────────────────────────────────────

/// Create a fresh SQLite pool with migrations applied (temp directory).
async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Insert a block with optional parent and position.
///
/// SQL-review §5.3 — stamps `page_id` per post-migration-0066 invariant.
async fn insert_block(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: Option<i64>,
) {
    let page_id: Option<String> = if block_type == "page" {
        Some(id.to_string())
    } else {
        Some(parent_id.unwrap_or(id).to_string())
    };
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(content)
    .bind(parent_id)
    .bind(position)
    .bind(page_id)
    .execute(pool)
    .await
    .unwrap();
}

/// Associate a block with a tag via `block_tags`.
async fn insert_tag_association(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Insert an agenda cache entry directly.
async fn insert_agenda_entry(pool: &SqlitePool, date: &str, block_id: &str, source: &str) {
    sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
        .bind(date)
        .bind(block_id)
        .bind(source)
        .execute(pool)
        .await
        .unwrap();
}

/// Soft-delete a block with a deterministic timestamp.
async fn soft_delete_block(pool: &SqlitePool, id: &str, deleted_at: &str) {
    // #109 Phase 2: blocks.deleted_at is now INTEGER epoch-ms. Callers pass
    // ISO-8601 strings for readability; convert to ms here, preserving the
    // exact monotonic ordering those strings encode.
    let deleted_at_ms = chrono::DateTime::parse_from_rfc3339(deleted_at)
        .unwrap()
        .timestamp_millis();
    sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
        .bind(deleted_at_ms)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

/// Drives the shared 5-items / 3-pages-of-2 cursor walk used by every
/// `*_paginates_with_cursor` test in this module.
///
/// Calls `list_fn` three times — with `None`, then `r1.next_cursor`, then
/// `r2.next_cursor` — at `limit = 2`, and asserts the page sizes (2, 2, 1),
/// `has_more` flags (true, true, false), absence of a trailing cursor, and
/// that the items appear in `expected_ids` order across pages.
trait RowIdStr {
    fn id_str(&self) -> &str;
}

impl RowIdStr for BlockRow {
    fn id_str(&self) -> &str {
        self.id.as_str()
    }
}

impl RowIdStr for ActiveBlockRow {
    fn id_str(&self) -> &str {
        self.id.as_str()
    }
}

async fn assert_paginates_with_cursor<F, R>(pool: &SqlitePool, expected_ids: [&str; 5], list_fn: F)
where
    F: AsyncFn(&SqlitePool, PageRequest) -> Result<PageResponse<R>, AppError>,
    R: RowIdStr + specta::Type,
{
    let r1 = list_fn(pool, PageRequest::new(None, Some(2)).unwrap())
        .await
        .unwrap();
    assert_eq!(r1.items.len(), 2, "page 1 should return 2 items");
    assert!(r1.has_more, "page 1 should indicate more pages");
    assert_eq!(r1.items[0].id_str(), expected_ids[0], "page 1 first item");
    assert_eq!(r1.items[1].id_str(), expected_ids[1], "page 1 second item");

    let r2 = list_fn(pool, PageRequest::new(r1.next_cursor, Some(2)).unwrap())
        .await
        .unwrap();
    assert_eq!(r2.items.len(), 2, "page 2 should return 2 items");
    assert!(r2.has_more, "page 2 should indicate more pages");
    assert_eq!(r2.items[0].id_str(), expected_ids[2], "page 2 first item");
    assert_eq!(r2.items[1].id_str(), expected_ids[3], "page 2 second item");

    let r3 = list_fn(pool, PageRequest::new(r2.next_cursor, Some(2)).unwrap())
        .await
        .unwrap();
    assert_eq!(r3.items.len(), 1, "last page should return 1 item");
    assert!(!r3.has_more, "last page should not indicate more");
    assert!(r3.next_cursor.is_none(), "last page should have no cursor");
    assert_eq!(r3.items[0].id_str(), expected_ids[4], "last page item");
}

// ====================================================================
// Cursor codec
// ====================================================================

#[test]
fn cursor_encode_decode_roundtrip() {
    let cursor = Cursor {
        id: "01HZ0000000000000000000001".into(),
        position: Some(3),
        deleted_at: None,
        seq: None,
        rank: None,
    };
    let encoded = cursor.encode().unwrap();
    let decoded = Cursor::decode(&encoded).unwrap();
    assert_eq!(
        cursor, decoded,
        "cursor must survive encode/decode roundtrip"
    );
}

#[test]
fn cursor_encode_decode_with_deleted_at() {
    let cursor = Cursor {
        id: "01HZ0000000000000000000001".into(),
        position: None,
        deleted_at: Some("2025-01-15T12:00:00+00:00".into()),
        seq: None,
        rank: None,
    };
    let encoded = cursor.encode().unwrap();
    let decoded = Cursor::decode(&encoded).unwrap();
    assert_eq!(
        cursor, decoded,
        "cursor with deleted_at must survive roundtrip"
    );
}

#[test]
fn cursor_encode_decode_with_seq() {
    let cursor = Cursor {
        id: String::new(),
        position: None,
        deleted_at: None,
        seq: Some(42),
        rank: None,
    };
    let encoded = cursor.encode().unwrap();
    let decoded = Cursor::decode(&encoded).unwrap();
    assert_eq!(cursor, decoded, "cursor with seq must survive roundtrip");
}

#[test]
fn cursor_decode_without_seq_defaults_to_none() {
    // Simulate a pre-Phase-2 cursor that doesn't have the seq field
    let old_json = r#"{"id":"01HZ0000000000000000000001","position":3}"#;
    let encoded = URL_SAFE_NO_PAD.encode(old_json.as_bytes());
    let decoded = Cursor::decode(&encoded).unwrap();
    assert_eq!(
        decoded.id, "01HZ0000000000000000000001",
        "id must be preserved from old cursor"
    );
    assert_eq!(
        decoded.position,
        Some(3),
        "position must be preserved from old cursor"
    );
    assert_eq!(
        decoded.seq, None,
        "old cursor without seq field must default to None"
    );
}

#[test]
fn cursor_decode_rejects_invalid_base64() {
    let result = Cursor::decode("not-valid-base64!!!");
    assert!(result.is_err(), "invalid base64 must be rejected");
    assert!(
        result.unwrap_err().to_string().contains("invalid cursor"),
        "error message must mention 'invalid cursor'"
    );
}

#[test]
fn cursor_encode_decode_preserves_special_characters() {
    let cursor = Cursor {
        id: "id-with-\u{e9}mojis-\u{1f389}-and-\"quotes\"".into(),
        position: Some(42),
        deleted_at: Some("2025-06-01T00:00:00+00:00".into()),
        seq: None,
        rank: None,
    };
    let encoded = cursor.encode().unwrap();
    let decoded = Cursor::decode(&encoded).unwrap();
    assert_eq!(cursor, decoded, "special characters must survive roundtrip");
}

// ── L-18: cursor version tag ────────────────────────────────────────

#[test]
fn cursor_decode_rejects_unknown_version() {
    // A well-formed cursor JSON tagged with a future schema version must
    // be rejected by [`Cursor::decode`] with `AppError::Validation` so
    // clients fall back to page-1 pagination instead of silently
    // consuming a cursor that may have a different field layout.
    let bad_json = r#"{"id":"01HZ0000000000000000000001","position":3,"version":99}"#;
    let encoded = URL_SAFE_NO_PAD.encode(bad_json.as_bytes());
    let result = Cursor::decode(&encoded);
    assert!(
        result.is_err(),
        "cursor with unknown version must be rejected"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("version"),
        "validation error must mention 'version', got: {err_msg}"
    );
    assert!(
        matches!(Cursor::decode(&encoded), Err(AppError::Validation(_))),
        "must be an AppError::Validation"
    );
}

#[test]
fn cursor_encode_sets_version_1() {
    // Round-trip a cursor through encode and verify the raw JSON inside
    // the base64 payload contains `"version":1`.  This pins the seating
    // commit's wire format so any future bump becomes explicit.
    let cursor = Cursor {
        id: "01HZ0000000000000000000001".into(),
        position: Some(7),
        deleted_at: None,
        seq: None,
        rank: None,
    };
    let encoded = cursor.encode().unwrap();
    let raw_bytes = URL_SAFE_NO_PAD.decode(&encoded).unwrap();
    let raw_json = String::from_utf8(raw_bytes).unwrap();
    assert!(
        raw_json.contains("\"version\":1"),
        "encoded cursor JSON must contain \"version\":1, got: {raw_json}"
    );
    // And the decode round-trip still works.
    let decoded = Cursor::decode(&encoded).unwrap();
    assert_eq!(decoded, cursor, "round-trip must preserve cursor fields");
}

#[test]
fn cursor_decode_old_format_assumes_version_1() {
    // Pre-versioning cursors emitted before L-18 do not carry a
    // `version` key.  They must continue to decode cleanly under the
    // current schema (treated as version 1).
    let old_json = r#"{"id":"01HZ0000000000000000000001","position":3}"#;
    let encoded = URL_SAFE_NO_PAD.encode(old_json.as_bytes());
    let decoded = Cursor::decode(&encoded).expect("pre-versioning cursor must decode as version 1");
    assert_eq!(decoded.id, "01HZ0000000000000000000001");
    assert_eq!(decoded.position, Some(3));
}

// ====================================================================
// PageRequest
// ====================================================================

#[test]
fn page_request_defaults_to_limit_50() {
    let pr = PageRequest::new(None, None).unwrap();
    assert!(pr.after.is_none(), "default request should have no cursor");
    assert_eq!(pr.limit, 50, "default limit must be 50");
}

#[test]
fn page_request_rejects_limits_outside_valid_range() {
    // limit-clamp-followup Phase 1: out-of-range limits surface as
    // `AppError::Validation` rather than silently clamping.
    let high = PageRequest::new(None, Some(999));
    assert!(high.is_err(), "limit above MAX_PAGE_SIZE must be rejected");
    let high_msg = format!("{:?}", high.unwrap_err());
    assert!(
        high_msg.contains("Validation") && high_msg.contains("[1, 200]"),
        "expected `[1, 200]` Validation error, got: {high_msg}",
    );

    let low = PageRequest::new(None, Some(-5));
    assert!(low.is_err(), "negative limit must be rejected");

    let zero = PageRequest::new(None, Some(0));
    assert!(zero.is_err(), "zero limit must be rejected");
}

#[test]
fn page_request_rejects_invalid_cursors() {
    let result = PageRequest::new(Some("not-a-valid-cursor!!!".into()), Some(10));
    assert!(result.is_err(), "invalid base64 cursor must be rejected");

    let bad_json = URL_SAFE_NO_PAD.encode(b"this is not json");
    let result = PageRequest::new(Some(bad_json), Some(10));
    assert!(result.is_err(), "non-JSON cursor must be rejected");

    let missing_id = URL_SAFE_NO_PAD.encode(b"{\"position\":1}");
    let result = PageRequest::new(Some(missing_id), Some(10));
    assert!(result.is_err(), "cursor missing 'id' must be rejected");
}

// ====================================================================
// list_children
// ====================================================================

#[tokio::test]
async fn list_children_returns_first_page() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
    for i in 1..=5_i64 {
        let id = format!("CHILD{i:03}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("child {i}"),
            Some("PARENT01"),
            Some(i),
        )
        .await;
    }

    let page = PageRequest::new(None, Some(2)).unwrap();
    let resp = list_children(&pool, Some("PARENT01"), &page, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "page size must be respected");
    assert!(resp.has_more, "more items remain");
    assert!(
        resp.next_cursor.is_some(),
        "cursor must be provided when has_more"
    );
    assert_eq!(
        resp.items[0].id, "CHILD001",
        "first item should be CHILD001"
    );
    assert_eq!(
        resp.items[1].id, "CHILD002",
        "second item should be CHILD002"
    );
}

#[tokio::test]
async fn list_children_continues_from_cursor() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
    for i in 1..=5_i64 {
        let id = format!("CHILD{i:03}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("child {i}"),
            Some("PARENT01"),
            Some(i),
        )
        .await;
    }

    let p1 = PageRequest::new(None, Some(2)).unwrap();
    let r1 = list_children(&pool, Some("PARENT01"), &p1, None)
        .await
        .unwrap();

    let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
    let r2 = list_children(&pool, Some("PARENT01"), &p2, None)
        .await
        .unwrap();

    assert_eq!(r2.items.len(), 2, "second page should return 2 items");
    assert!(r2.has_more, "more items remain after second page");
    assert_eq!(
        r2.items[0].id, "CHILD003",
        "cursor must skip past first page"
    );
    assert_eq!(
        r2.items[1].id, "CHILD004",
        "second page second item should be CHILD004"
    );
}

#[tokio::test]
async fn list_children_last_page_has_no_cursor() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
    for i in 1..=5_i64 {
        let id = format!("CHILD{i:03}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("child {i}"),
            Some("PARENT01"),
            Some(i),
        )
        .await;
    }

    let r1 = list_children(
        &pool,
        Some("PARENT01"),
        &PageRequest::new(None, Some(2)).unwrap(),
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();
    let r2 = list_children(
        &pool,
        Some("PARENT01"),
        &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();
    let r3 = list_children(
        &pool,
        Some("PARENT01"),
        &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    assert_eq!(r3.items.len(), 1, "last page must contain remaining item");
    assert!(!r3.has_more, "last page must have has_more = false");
    assert!(r3.next_cursor.is_none(), "last page must have no cursor");
    assert_eq!(
        r3.items[0].id, "CHILD005",
        "last page should contain CHILD005"
    );
}

#[tokio::test]
async fn list_children_returns_empty_when_parent_has_no_children() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_children(&pool, Some("PARENT01"), &page, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "childless parent must return empty");
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
async fn list_children_lists_top_level_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TOPLVL01", "page", "page 1", None, Some(1)).await;
    insert_block(&pool, "TOPLVL02", "page", "page 2", None, Some(2)).await;
    insert_block(
        &pool,
        "CHILD001",
        "content",
        "child",
        Some("TOPLVL01"),
        Some(1),
    )
    .await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_children(&pool, None, &page, None).await.unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "only top-level blocks (parent_id IS NULL)"
    );
    assert_eq!(
        resp.items[0].id, "TOPLVL01",
        "first top-level block by position"
    );
    assert_eq!(
        resp.items[1].id, "TOPLVL02",
        "second top-level block by position"
    );
}

#[tokio::test]
async fn list_children_excludes_soft_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
    insert_block(
        &pool,
        "CHILD001",
        "content",
        "alive",
        Some("PARENT01"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "CHILD002",
        "content",
        "deleted",
        Some("PARENT01"),
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "CHILD003",
        "content",
        "alive too",
        Some("PARENT01"),
        Some(3),
    )
    .await;
    soft_delete_block(&pool, "CHILD002", FIXED_DELETED_AT).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_children(&pool, Some("PARENT01"), &page, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "soft-deleted child must be excluded");
    assert_eq!(resp.items[0].id, "CHILD001", "first alive child present");
    assert_eq!(
        resp.items[1].id, "CHILD003",
        "second alive child present, CHILD002 excluded"
    );
}

#[tokio::test]
async fn list_children_sentinel_positions_sort_after_positioned() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
    insert_block(
        &pool,
        "CHILD001",
        "content",
        "c1",
        Some("PARENT01"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "CHILD002",
        "content",
        "c2",
        Some("PARENT01"),
        Some(2),
    )
    .await;
    // P-18: Use sentinel value instead of NULL for tag-like blocks
    insert_block(
        &pool,
        "TAG00001",
        "tag",
        "tag1",
        Some("PARENT01"),
        Some(NULL_POSITION_SENTINEL),
    )
    .await;
    insert_block(
        &pool,
        "TAG00002",
        "tag",
        "tag2",
        Some("PARENT01"),
        Some(NULL_POSITION_SENTINEL),
    )
    .await;

    // Page 1: positioned children first
    let p1 = PageRequest::new(None, Some(2)).unwrap();
    let r1 = list_children(&pool, Some("PARENT01"), &p1, None)
        .await
        .unwrap();
    assert_eq!(
        r1.items.len(),
        2,
        "page 1 should return 2 positioned children"
    );
    assert!(r1.has_more, "page 1 should have more items");
    assert_eq!(r1.items[0].id, "CHILD001", "positioned children come first");
    assert_eq!(r1.items[1].id, "CHILD002", "second positioned child");

    // Page 2: sentinel-position children via cursor
    let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
    let r2 = list_children(&pool, Some("PARENT01"), &p2, None)
        .await
        .unwrap();
    assert_eq!(
        r2.items.len(),
        2,
        "page 2 should return 2 sentinel-position items"
    );
    assert!(!r2.has_more, "page 2 should be the last page");
    assert_eq!(
        r2.items[0].id, "TAG00001",
        "sentinel-position items come after"
    );
    assert_eq!(r2.items[1].id, "TAG00002", "second sentinel-position item");
}

#[tokio::test]
async fn list_children_same_position_tiebreaks_by_id() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
    insert_block(&pool, "CHILD_AA", "content", "a", Some("PARENT01"), Some(5)).await;
    insert_block(&pool, "CHILD_BB", "content", "b", Some("PARENT01"), Some(5)).await;
    insert_block(&pool, "CHILD_CC", "content", "c", Some("PARENT01"), Some(5)).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_children(&pool, Some("PARENT01"), &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        3,
        "all three same-position items returned"
    );
    assert_eq!(resp.items[0].id, "CHILD_AA", "id ASC tiebreaker");
    assert_eq!(resp.items[1].id, "CHILD_BB", "second by id tiebreaker");
    assert_eq!(resp.items[2].id, "CHILD_CC", "third by id tiebreaker");
}

#[tokio::test]
async fn list_children_exhaustive_walk_returns_all_items_once() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
    for i in 1..=13_i64 {
        let id = format!("CHILD{i:03}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("c{i}"),
            Some("PARENT01"),
            Some(i),
        )
        .await;
    }

    let mut all_ids = Vec::new();
    let mut cursor = None;
    loop {
        let page = PageRequest::new(cursor, Some(3)).unwrap();
        let resp = list_children(&pool, Some("PARENT01"), &page, None)
            .await
            .unwrap();
        all_ids.extend(resp.items.iter().map(|b| b.id.as_str().to_string()));
        if !resp.has_more {
            break;
        }
        cursor = resp.next_cursor;
    }

    let expected: Vec<String> = (1..=13).map(|i| format!("CHILD{i:03}")).collect();
    assert_eq!(
        all_ids, expected,
        "exhaustive walk must return every child exactly once, in order"
    );
}

// ====================================================================
// list_by_type
// ====================================================================

#[tokio::test]
async fn list_by_type_returns_only_matching_type() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE0001", "page", "Page 1", None, None).await;
    insert_block(&pool, "PAGE0002", "page", "Page 2", None, None).await;
    insert_block(&pool, "CONT0001", "content", "Content 1", None, None).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_by_type(&pool, "page", &page, None).await.unwrap();

    assert_eq!(resp.items.len(), 2, "only page-type blocks");
    assert!(
        resp.items.iter().all(|b| b.block_type == "page"),
        "all items must be page type"
    );
}

#[tokio::test]
async fn list_by_type_paginates_with_cursor() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=5_i64 {
        let id = format!("PAGE{i:04}");
        insert_block(&pool, &id, "page", &format!("Page {i}"), None, None).await;
    }

    assert_paginates_with_cursor(
        &pool,
        ["PAGE0001", "PAGE0002", "PAGE0003", "PAGE0004", "PAGE0005"],
        async |pool, page| list_by_type(pool, "page", &page, None).await,
    )
    .await;
}

#[tokio::test]
async fn list_by_type_excludes_soft_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE0001", "page", "Page 1", None, None).await;
    insert_block(&pool, "PAGE0002", "page", "Page 2", None, None).await;
    insert_block(&pool, "PAGE0003", "page", "Page 3", None, None).await;
    soft_delete_block(&pool, "PAGE0002", FIXED_DELETED_AT).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_by_type(&pool, "page", &page, None).await.unwrap();

    assert_eq!(resp.items.len(), 2, "soft-deleted block must be excluded");
    assert_eq!(resp.items[0].id, "PAGE0001", "first alive page block");
    assert_eq!(
        resp.items[1].id, "PAGE0003",
        "second alive page block, PAGE0002 excluded"
    );
}

#[tokio::test]
async fn list_by_type_returns_empty_for_unknown_type() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE0001", "page", "Page 1", None, None).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_by_type(&pool, "nonexistent_type", &page, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "unknown type must return empty");
    assert!(!resp.has_more, "empty result should not indicate more");
    assert!(
        resp.next_cursor.is_none(),
        "empty result should have no cursor"
    );
}

// ====================================================================
// list_trash
// ====================================================================

#[tokio::test]
async fn list_trash_returns_empty_when_nothing_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLOCK001", "content", "alive", None, None).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_trash(&pool, &page, None).await.unwrap();

    assert!(
        resp.items.is_empty(),
        "no deleted blocks \u{2192} empty trash"
    );
    assert!(!resp.has_more, "empty trash should not indicate more");
    assert!(
        resp.next_cursor.is_none(),
        "empty trash should have no cursor"
    );
}

#[tokio::test]
async fn list_trash_orders_by_deleted_at_descending() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TRASH001", "content", "a", None, None).await;
    insert_block(&pool, "TRASH002", "content", "b", None, None).await;
    insert_block(&pool, "TRASH003", "content", "c", None, None).await;

    soft_delete_block(&pool, "TRASH001", "2025-01-01T00:00:00+00:00").await;
    soft_delete_block(&pool, "TRASH002", "2025-01-03T00:00:00+00:00").await;
    soft_delete_block(&pool, "TRASH003", "2025-01-02T00:00:00+00:00").await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_trash(&pool, &page, None).await.unwrap();

    assert_eq!(resp.items.len(), 3, "all deleted blocks should be returned");
    assert_eq!(resp.items[0].id, "TRASH002", "most recently deleted first");
    assert_eq!(resp.items[1].id, "TRASH003", "second most recently deleted");
    assert_eq!(resp.items[2].id, "TRASH001", "earliest deleted last");
}

#[tokio::test]
async fn list_trash_paginates_with_cursor() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=5_i64 {
        let id = format!("TRASH{i:03}");
        insert_block(&pool, &id, "content", &format!("trash {i}"), None, None).await;
        let ts = format!("2025-01-{i:02}T00:00:00+00:00");
        soft_delete_block(&pool, &id, &ts).await;
    }

    // Trash sorts most-recently-deleted first, so order is reversed.
    assert_paginates_with_cursor(
        &pool,
        ["TRASH005", "TRASH004", "TRASH003", "TRASH002", "TRASH001"],
        async |pool, page| list_trash(pool, &page, None).await,
    )
    .await;
}

// ── UX-243: roots-only trash listing ────────────────────────────────

#[tokio::test]
async fn list_trash_deleted_page_with_children_returns_only_root() {
    // A deleted page with N children (all sharing `deleted_at` per
    // cascade_soft_delete) must appear as a single root row — descendants
    // must NOT leak into the list view.
    let (pool, _dir) = test_pool().await;

    let ts = "2025-03-10T12:00:00+00:00";
    insert_block(&pool, "PAGE0001", "page", "root page", None, Some(1)).await;
    insert_block(
        &pool,
        "CHILD001",
        "content",
        "c1",
        Some("PAGE0001"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "CHILD002",
        "content",
        "c2",
        Some("PAGE0001"),
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "CHILD003",
        "content",
        "c3",
        Some("PAGE0001"),
        Some(3),
    )
    .await;

    // Simulate cascade_soft_delete: same `deleted_at` on page + every child.
    soft_delete_block(&pool, "PAGE0001", ts).await;
    soft_delete_block(&pool, "CHILD001", ts).await;
    soft_delete_block(&pool, "CHILD002", ts).await;
    soft_delete_block(&pool, "CHILD003", ts).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_trash(&pool, &page, None).await.unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "only the page root must appear, descendants filtered out"
    );
    assert_eq!(resp.items[0].id, "PAGE0001", "root must be the page");
    assert!(
        !resp.has_more,
        "single-root page must fit on the first page"
    );
}

#[tokio::test]
async fn list_trash_loose_content_block_with_alive_parent_appears_as_root() {
    // A content block deleted from inside an alive parent page is itself a
    // root (parent is not in the deleted set at all).
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "ALIVEPAG", "page", "alive page", None, Some(1)).await;
    insert_block(
        &pool,
        "LOOSE001",
        "content",
        "loose deleted",
        Some("ALIVEPAG"),
        Some(1),
    )
    .await;

    soft_delete_block(&pool, "LOOSE001", "2025-04-01T00:00:00+00:00").await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_trash(&pool, &page, None).await.unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "loose deleted content with alive parent must appear"
    );
    assert_eq!(resp.items[0].id, "LOOSE001");
}

#[tokio::test]
async fn list_trash_loose_deleted_block_with_different_batch_parent_appears() {
    // A content block whose parent was *also* deleted but in a different
    // batch (different `deleted_at`) is a root of its own batch — must
    // appear in the trash list.
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
    insert_block(
        &pool,
        "CHILD001",
        "content",
        "child",
        Some("PARENT01"),
        Some(1),
    )
    .await;

    // Parent deleted on 2025-05-01 — e.g. via a direct soft-delete of just
    // the parent row (not cascade_soft_delete, which would share the ts).
    soft_delete_block(&pool, "PARENT01", "2025-05-01T00:00:00+00:00").await;
    // Child deleted separately on 2025-06-01 — different batch.
    soft_delete_block(&pool, "CHILD001", "2025-06-01T00:00:00+00:00").await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_trash(&pool, &page, None).await.unwrap();

    // Both are roots of their own batches.
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(resp.items.len(), 2, "two independent roots expected");
    assert!(
        ids.contains(&"PARENT01") && ids.contains(&"CHILD001"),
        "both parent (own batch) and child (own batch) must appear; got {ids:?}"
    );
}

#[tokio::test]
async fn list_trash_pagination_cursor_with_mixed_root_sizes() {
    // Pagination cursor round-trips across pages even when some roots have
    // many descendants (which stay filtered out of the list).
    let (pool, _dir) = test_pool().await;

    // 5 deleted roots, each at a distinct timestamp. Some of them also have
    // a descendant sharing the timestamp — those descendants must NOT show
    // up in the list, only the 5 roots.
    for i in 1..=5_i64 {
        let root_id = format!("ROOT{i:04}");
        insert_block(&pool, &root_id, "page", &format!("root {i}"), None, None).await;
        let ts = format!("2025-07-{i:02}T00:00:00+00:00");
        soft_delete_block(&pool, &root_id, &ts).await;

        // First 3 roots also have a descendant in the same batch.
        if i <= 3 {
            let child_id = format!("CHD_{i:04}");
            insert_block(
                &pool,
                &child_id,
                "content",
                &format!("child of {i}"),
                Some(&root_id),
                Some(1),
            )
            .await;
            soft_delete_block(&pool, &child_id, &ts).await;
        }
    }

    // First page (limit 2) — expect ROOT0005, ROOT0004 (most recent first).
    let r1 = list_trash(&pool, &PageRequest::new(None, Some(2)).unwrap(), None)
        .await
        .unwrap();
    assert_eq!(r1.items.len(), 2, "first page must have exactly 2 roots");
    assert!(r1.has_more, "more roots remain");
    assert_eq!(r1.items[0].id, "ROOT0005");
    assert_eq!(r1.items[1].id, "ROOT0004");

    // Second page — expect ROOT0003, ROOT0002.
    let r2 = list_trash(
        &pool,
        &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(r2.items.len(), 2, "second page must have exactly 2 roots");
    assert!(r2.has_more, "still one root left");
    assert_eq!(r2.items[0].id, "ROOT0003");
    assert_eq!(r2.items[1].id, "ROOT0002");

    // Last page — expect ROOT0001 only.
    let r3 = list_trash(
        &pool,
        &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(r3.items.len(), 1, "last page must have 1 root");
    assert!(!r3.has_more, "last page reached");
    assert!(r3.next_cursor.is_none(), "no cursor after last page");
    assert_eq!(r3.items[0].id, "ROOT0001");
}

/// #386 — trash same-`deleted_at` tie-break across page boundaries.
///
/// `list_trash` keysets on `(deleted_at DESC, id ASC)` with the predicate
/// `deleted_at < ?2 OR (deleted_at = ?2 AND id > ?3)`. When several
/// independent roots share a *single* `deleted_at`, the entire walk lives
/// inside one `deleted_at` bucket, so correctness rests entirely on the
/// `id ASC` tie-break carrying across page boundaries (the `id > ?3` arm).
/// This exhaustive walk soft-deletes 6 independent roots at one shared
/// timestamp, paginates at limit=2, and asserts no duplicates, no gaps,
/// and a globally non-increasing `(deleted_at DESC, id ASC)` order.
#[tokio::test]
async fn list_trash_exhaustive_walk_shared_deleted_at_no_dupes_or_gaps_386() {
    let (pool, _dir) = test_pool().await;

    // 6 independent roots, all soft-deleted at the SAME instant. IDs are
    // seeded out of sort order so the `id ASC` tie-break — not insertion
    // order — is the only thing that can produce the expected sequence.
    let shared_ts = "2025-08-15T12:00:00+00:00";
    let root_ids = [
        "TRSHARE_D",
        "TRSHARE_A",
        "TRSHARE_F",
        "TRSHARE_C",
        "TRSHARE_E",
        "TRSHARE_B",
    ];
    for id in &root_ids {
        insert_block(&pool, id, "page", &format!("root {id}"), None, None).await;
        soft_delete_block(&pool, id, shared_ts).await;
    }

    // Walk every page at limit=2.
    let shared_ts_ms = chrono::DateTime::parse_from_rfc3339(shared_ts)
        .unwrap()
        .timestamp_millis();
    let mut collected: Vec<(i64, String)> = Vec::new(); // (deleted_at_ms, id)
    let mut cursor = None;
    let mut page_count = 0;
    loop {
        let page = PageRequest::new(cursor, Some(2)).unwrap();
        let resp = list_trash(&pool, &page, None).await.unwrap();
        assert!(
            resp.items.len() <= 2,
            "page must not exceed the requested limit"
        );
        for item in &resp.items {
            let del = item.deleted_at.expect("trash rows always carry deleted_at");
            assert_eq!(
                del, shared_ts_ms,
                "every root was deleted at the single shared timestamp"
            );
            collected.push((del, item.id.as_str().to_string()));
        }
        page_count += 1;
        if !resp.has_more {
            assert!(
                resp.next_cursor.is_none(),
                "last page must not carry a cursor"
            );
            break;
        }
        cursor = resp.next_cursor;
        assert!(page_count < 20, "walk failed to terminate");
    }

    // No gaps: every seeded root appears exactly once.
    let mut ids: Vec<&str> = collected.iter().map(|(_, id)| id.as_str()).collect();
    ids.sort_unstable();
    let mut expected: Vec<&str> = root_ids.to_vec();
    expected.sort_unstable();
    assert_eq!(
        ids, expected,
        "exhaustive walk must return every shared-deleted_at root once"
    );

    // No duplicates.
    let unique: std::collections::HashSet<&str> = ids.iter().copied().collect();
    assert_eq!(unique.len(), ids.len(), "no root may appear twice");

    // Globally non-increasing on (deleted_at DESC, id ASC) — exactly the
    // SQL ORDER BY. With a shared deleted_at this reduces to a strictly
    // ascending id sequence carried across every page boundary.
    for win in collected.windows(2) {
        let (a, b) = (&win[0], &win[1]);
        assert!(
            a.0 > b.0 || (a.0 == b.0 && a.1 < b.1),
            "ordering must be (deleted_at DESC, id ASC): {a:?} then {b:?}"
        );
    }

    assert_eq!(
        page_count, 3,
        "6 roots at limit 2 must span exactly 3 pages, got {page_count}"
    );
}

// ── UX-243: trash_descendant_counts helper ──────────────────────────

#[tokio::test]
async fn trash_descendant_counts_returns_per_root_counts() {
    let (pool, _dir) = test_pool().await;

    // ROOTA: 3 descendants. ROOTB: 0 descendants. ROOTC: not deleted.
    let ts_a = "2025-09-01T00:00:00+00:00";
    let ts_b = "2025-09-02T00:00:00+00:00";
    insert_block(&pool, "ROOTA001", "page", "a", None, Some(1)).await;
    insert_block(
        &pool,
        "A_CHD001",
        "content",
        "a1",
        Some("ROOTA001"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "A_CHD002",
        "content",
        "a2",
        Some("ROOTA001"),
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "A_CHD003",
        "content",
        "a3",
        Some("ROOTA001"),
        Some(3),
    )
    .await;
    soft_delete_block(&pool, "ROOTA001", ts_a).await;
    soft_delete_block(&pool, "A_CHD001", ts_a).await;
    soft_delete_block(&pool, "A_CHD002", ts_a).await;
    soft_delete_block(&pool, "A_CHD003", ts_a).await;

    insert_block(&pool, "ROOTB001", "content", "b", None, None).await;
    soft_delete_block(&pool, "ROOTB001", ts_b).await;

    insert_block(&pool, "ROOTC001", "content", "c alive", None, None).await;

    let counts = trash_descendant_counts(
        &pool,
        &[
            "ROOTA001".to_string(),
            "ROOTB001".to_string(),
            "ROOTC001".to_string(),
        ],
    )
    .await
    .unwrap();

    assert_eq!(
        counts.get("ROOTA001").copied(),
        Some(3),
        "ROOTA001 must report 3 descendants, got {counts:?}"
    );
    // Zero-descendant roots and alive blocks are omitted — callers default to 0.
    assert!(
        !counts.contains_key("ROOTB001"),
        "zero-descendant root must be omitted, got {counts:?}"
    );
    assert!(
        !counts.contains_key("ROOTC001"),
        "alive block must be omitted, got {counts:?}"
    );
}

#[tokio::test]
async fn trash_descendant_counts_empty_input_returns_empty_map() {
    let (pool, _dir) = test_pool().await;
    let counts = trash_descendant_counts(&pool, &[]).await.unwrap();
    assert!(counts.is_empty(), "empty input must return empty map");
}

#[tokio::test]
async fn trash_descendant_counts_isolates_unrelated_roots_sharing_deleted_at() {
    // M-16 regression: two unrelated trees soft-deleted at the *same*
    // `deleted_at` (e.g. millisecond collision in cascade_soft_delete or a
    // shared FIXED_DELETED_AT in tests) must not contaminate each other's
    // descendant count. Pre-fix, the bare deleted_at join saw all 6 deleted
    // rows for both roots (each reporting 5 descendants instead of 2).
    let (pool, _dir) = test_pool().await;

    let ts = FIXED_DELETED_AT;

    // Tree A: root_a + a_child1 + a_child2 (siblings under root_a).
    insert_block(&pool, "ROOT_AAA", "page", "tree A", None, Some(1)).await;
    insert_block(
        &pool,
        "A_CHILD1",
        "content",
        "a child 1",
        Some("ROOT_AAA"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "A_CHILD2",
        "content",
        "a child 2",
        Some("ROOT_AAA"),
        Some(2),
    )
    .await;

    // Tree B: root_b + b_child1 + b_child2 (siblings under root_b).
    insert_block(&pool, "ROOT_BBB", "page", "tree B", None, Some(1)).await;
    insert_block(
        &pool,
        "B_CHILD1",
        "content",
        "b child 1",
        Some("ROOT_BBB"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "B_CHILD2",
        "content",
        "b child 2",
        Some("ROOT_BBB"),
        Some(2),
    )
    .await;

    // Soft-delete every block in both trees with the SAME timestamp.
    soft_delete_block(&pool, "ROOT_AAA", ts).await;
    soft_delete_block(&pool, "A_CHILD1", ts).await;
    soft_delete_block(&pool, "A_CHILD2", ts).await;
    soft_delete_block(&pool, "ROOT_BBB", ts).await;
    soft_delete_block(&pool, "B_CHILD1", ts).await;
    soft_delete_block(&pool, "B_CHILD2", ts).await;

    let counts = trash_descendant_counts(&pool, &["ROOT_AAA".to_string(), "ROOT_BBB".to_string()])
        .await
        .unwrap();

    assert_eq!(
        counts.get("ROOT_AAA").copied(),
        Some(2),
        "ROOT_AAA must report only its own 2 descendants, not 5; got {counts:?}"
    );
    assert_eq!(
        counts.get("ROOT_BBB").copied(),
        Some(2),
        "ROOT_BBB must report only its own 2 descendants, not 5; got {counts:?}"
    );
}

#[tokio::test]
async fn trash_descendant_counts_walks_multiple_levels_of_descendants() {
    // Happy-path: nested grandchildren that share the root's deleted_at
    // are counted (the recursive CTE walks through every level, bounded
    // at depth 100 per AGENTS.md invariant #9).
    let (pool, _dir) = test_pool().await;

    let ts = "2025-11-01T00:00:00+00:00";

    // root → child → grandchild (3-level chain).
    insert_block(&pool, "DEEPROOT", "page", "deep root", None, Some(1)).await;
    insert_block(
        &pool,
        "DEEPCHLD",
        "content",
        "child",
        Some("DEEPROOT"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "DEEPGCHD",
        "content",
        "grandchild",
        Some("DEEPCHLD"),
        Some(1),
    )
    .await;

    soft_delete_block(&pool, "DEEPROOT", ts).await;
    soft_delete_block(&pool, "DEEPCHLD", ts).await;
    soft_delete_block(&pool, "DEEPGCHD", ts).await;

    let counts = trash_descendant_counts(&pool, &["DEEPROOT".to_string()])
        .await
        .unwrap();

    assert_eq!(
        counts.get("DEEPROOT").copied(),
        Some(2),
        "DEEPROOT must include both child and grandchild; got {counts:?}"
    );
}

// ====================================================================
// Cursor stability
// ====================================================================

#[tokio::test]
async fn cursor_stable_after_concurrent_inserts() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
    for i in 1..=5_i64 {
        let id = format!("CHILD{i:03}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("c{i}"),
            Some("PARENT01"),
            Some(i * 2),
        )
        .await;
    }

    // Get first page → CHILD001(pos=2), CHILD002(pos=4)
    let r1 = list_children(
        &pool,
        Some("PARENT01"),
        &PageRequest::new(None, Some(2)).unwrap(),
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();
    assert_eq!(
        r1.items[0].id, "CHILD001",
        "page 1 first item before insert"
    );
    assert_eq!(
        r1.items[1].id, "CHILD002",
        "page 1 second item before insert"
    );
    let saved_cursor = r1.next_cursor.clone();

    // Insert before cursor (pos=3) and after (pos=100)
    insert_block(
        &pool,
        "NEWCHILD",
        "content",
        "new",
        Some("PARENT01"),
        Some(3),
    )
    .await;
    insert_block(
        &pool,
        "NEWCHLD2",
        "content",
        "new2",
        Some("PARENT01"),
        Some(100),
    )
    .await;

    // Resume with old cursor — must skip past pos=4
    let r2 = list_children(
        &pool,
        Some("PARENT01"),
        &PageRequest::new(saved_cursor, Some(10)).unwrap(),
        None, // FEAT-3 Phase 2: space_id unscoped
    )
    .await
    .unwrap();

    let ids: Vec<&str> = r2.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        !ids.contains(&"CHILD001"),
        "cursor must skip already-seen items"
    );
    assert!(
        !ids.contains(&"CHILD002"),
        "CHILD002 was already seen in page 1"
    );
    assert!(
        !ids.contains(&"NEWCHILD"),
        "items before cursor position must be skipped"
    );
    assert!(
        ids.contains(&"CHILD003"),
        "CHILD003 should appear after cursor"
    );
    assert!(
        ids.contains(&"CHILD004"),
        "CHILD004 should appear after cursor"
    );
    assert!(
        ids.contains(&"CHILD005"),
        "CHILD005 should appear after cursor"
    );
    assert!(ids.contains(&"NEWCHLD2"), "items after cursor must appear");
}

// ====================================================================
// list_by_tag
// ====================================================================

#[tokio::test]
async fn list_by_tag_returns_only_tagged_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG00001", "tag", "important", None, None).await;
    insert_block(&pool, "BLOCK001", "content", "block 1", None, None).await;
    insert_block(&pool, "BLOCK002", "content", "block 2", None, None).await;
    insert_block(&pool, "BLOCK003", "content", "block 3", None, None).await;

    insert_tag_association(&pool, "BLOCK001", "TAG00001").await;
    insert_tag_association(&pool, "BLOCK003", "TAG00001").await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_by_tag(&pool, "TAG00001", &page, None).await.unwrap();

    assert_eq!(resp.items.len(), 2, "only tagged blocks must be returned");
    assert_eq!(resp.items[0].id, "BLOCK001", "first tagged block");
    assert_eq!(resp.items[1].id, "BLOCK003", "second tagged block");
}

#[tokio::test]
async fn list_by_tag_paginates_with_cursor() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG00001", "tag", "important", None, None).await;
    for i in 1..=5_i64 {
        let id = format!("BLOCK{i:03}");
        insert_block(&pool, &id, "content", &format!("b{i}"), None, None).await;
        insert_tag_association(&pool, &id, "TAG00001").await;
    }

    assert_paginates_with_cursor(
        &pool,
        ["BLOCK001", "BLOCK002", "BLOCK003", "BLOCK004", "BLOCK005"],
        async |pool, page| list_by_tag(pool, "TAG00001", &page, None).await,
    )
    .await;
}

#[tokio::test]
async fn list_by_tag_excludes_soft_deleted_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TAG00001", "tag", "important", None, None).await;
    insert_block(&pool, "BLOCK001", "content", "alive", None, None).await;
    insert_block(&pool, "BLOCK002", "content", "deleted", None, None).await;

    insert_tag_association(&pool, "BLOCK001", "TAG00001").await;
    insert_tag_association(&pool, "BLOCK002", "TAG00001").await;
    soft_delete_block(&pool, "BLOCK002", FIXED_DELETED_AT).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_by_tag(&pool, "TAG00001", &page, None).await.unwrap();

    assert_eq!(resp.items.len(), 1, "soft-deleted block must be excluded");
    assert_eq!(
        resp.items[0].id, "BLOCK001",
        "only alive tagged block returned"
    );
}

#[tokio::test]
async fn list_by_tag_returns_empty_for_unknown_tag() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLOCK001", "content", "untagged", None, None).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_by_tag(&pool, "NONEXISTENT_TAG", &page, None)
        .await
        .unwrap();

    assert!(resp.items.is_empty(), "unknown tag must return empty");
    assert!(!resp.has_more, "empty tag result should not indicate more");
}

// ====================================================================
// query_by_property
// ====================================================================

/// Helper: insert a block_properties row directly.
async fn insert_property(pool: &SqlitePool, block_id: &str, key: &str, value_text: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value_text)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn query_by_property_returns_matching_blocks() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLOCK001", "content", "task 1", None, None).await;
    insert_block(&pool, "BLOCK002", "content", "task 2", None, None).await;
    insert_block(&pool, "BLOCK003", "content", "no prop", None, None).await;

    insert_property(&pool, "BLOCK001", "todo", "TODO").await;
    insert_property(&pool, "BLOCK002", "todo", "DONE").await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = query_by_property(
        &pool,
        "todo",
        None,
        None,
        "eq",
        &page,
        None,
        None,
        false,
        None,
        &[],
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 2, "only blocks with 'todo' property");
    assert_eq!(
        resp.items[0].id, "BLOCK001",
        "first block with todo property"
    );
    assert_eq!(
        resp.items[1].id, "BLOCK002",
        "second block with todo property"
    );
}

#[tokio::test]
async fn query_by_property_filters_by_value() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLOCK001", "content", "task 1", None, None).await;
    insert_block(&pool, "BLOCK002", "content", "task 2", None, None).await;

    insert_property(&pool, "BLOCK001", "todo", "TODO").await;
    insert_property(&pool, "BLOCK002", "todo", "DONE").await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = query_by_property(
        &pool,
        "todo",
        Some("TODO"),
        None,
        "eq",
        &page,
        None,
        None,
        false,
        None,
        &[],
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 1, "only block with todo=TODO");
    assert_eq!(resp.items[0].id, "BLOCK001", "block matching value filter");
}

/// #384 regression: a `neq` filter must NOT silently drop rows whose value
/// lives in the OTHER value column. A `block_properties` row stores its value
/// in exactly one of `value_text` / `value_date`, leaving the sibling NULL.
/// Before the fix, `neq` combined `(?3 IS NULL OR bp.value_date != ?3)`, and for
/// a row whose value is in `value_text` (so `value_date` is NULL) the
/// predicate evaluated `NULL != 'X'` → NULL (not TRUE), excluding it.
#[tokio::test]
async fn query_by_property_neq_keeps_other_column_rows() {
    let (pool, _dir) = test_pool().await;

    // Two rows store the value in value_text, two in value_date — all under
    // the same key.
    insert_block(&pool, "BLOCKTXT1", "content", "t1", None, None).await;
    insert_block(&pool, "BLOCKTXT2", "content", "t2", None, None).await;
    insert_block(&pool, "BLOCKDAT1", "content", "d1", None, None).await;
    insert_block(&pool, "BLOCKDAT2", "content", "d2", None, None).await;

    insert_property(&pool, "BLOCKTXT1", "when", "sometext").await;
    insert_property(&pool, "BLOCKTXT2", "when", "othertext").await;
    sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, 'when', ?)")
        .bind("BLOCKDAT1")
        .bind("2026-01-01")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO block_properties (block_id, key, value_date) VALUES (?, 'when', ?)")
        .bind("BLOCKDAT2")
        .bind("2026-02-02")
        .execute(&pool)
        .await
        .unwrap();

    // neq against a value_date target: must return the two text rows (their
    // value_date is NULL — different column) AND the one date row whose date
    // differs, while EXCLUDING the date row equal to the target.
    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = query_by_property(
        &pool,
        "when",
        None,
        Some("2026-01-01"),
        "neq",
        &page,
        None,
        None,
        false,
        None,
        &[],
        None,
    )
    .await
    .unwrap();

    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        ids.contains(&"BLOCKTXT1") && ids.contains(&"BLOCKTXT2"),
        "neq must keep rows whose value is in the OTHER (value_text) column; got {ids:?}"
    );
    assert!(
        ids.contains(&"BLOCKDAT2"),
        "neq must keep the date row whose value differs from the target; got {ids:?}"
    );
    assert!(
        !ids.contains(&"BLOCKDAT1"),
        "neq must exclude the date row equal to the target; got {ids:?}"
    );
    assert_eq!(
        resp.items.len(),
        3,
        "expected 3 rows (2 text + 1 differing date)"
    );
}

#[tokio::test]
async fn query_by_property_paginates_with_cursor() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=5_i64 {
        let id = format!("BLOCK{i:03}");
        insert_block(&pool, &id, "content", &format!("b{i}"), None, None).await;
        insert_property(&pool, &id, "status", "active").await;
    }

    assert_paginates_with_cursor(
        &pool,
        ["BLOCK001", "BLOCK002", "BLOCK003", "BLOCK004", "BLOCK005"],
        async |pool, page| {
            query_by_property(
                pool,
                "status",
                None,
                None,
                "eq",
                &page,
                None,
                None,
                false,
                None,
                &[],
                None,
            )
            .await
        },
    )
    .await;
}

#[tokio::test]
async fn query_by_property_returns_empty_for_nonexistent_key() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLOCK001", "content", "no props", None, None).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = query_by_property(
        &pool,
        "nonexistent_key",
        None,
        None,
        "eq",
        &page,
        None,
        None,
        false,
        None,
        &[],
        None,
    )
    .await
    .unwrap();

    assert!(resp.items.is_empty(), "nonexistent key must return empty");
    assert!(
        !resp.has_more,
        "empty property result should not indicate more"
    );
    assert!(
        resp.next_cursor.is_none(),
        "empty property result should have no cursor"
    );
}

#[tokio::test]
async fn query_by_property_excludes_soft_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLOCK001", "content", "alive", None, None).await;
    insert_block(&pool, "BLOCK002", "content", "deleted", None, None).await;

    insert_property(&pool, "BLOCK001", "todo", "TODO").await;
    insert_property(&pool, "BLOCK002", "todo", "TODO").await;
    soft_delete_block(&pool, "BLOCK002", FIXED_DELETED_AT).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = query_by_property(
        &pool,
        "todo",
        None,
        None,
        "eq",
        &page,
        None,
        None,
        false,
        None,
        &[],
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 1, "soft-deleted block must be excluded");
    assert_eq!(
        resp.items[0].id, "BLOCK001",
        "only alive block with property"
    );
}

#[tokio::test]
async fn query_by_property_rejects_both_value_filters() {
    // L-23: passing both value_text and value_date is ambiguous because
    // the reserved-column and non-reserved-row paths historically applied
    // different precedence rules. Reject at the boundary instead.
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLOCK001", "content", "task", None, None).await;
    insert_property(&pool, "BLOCK001", "todo", "TODO").await;

    let page = PageRequest::new(None, Some(10)).unwrap();

    // Non-reserved key: AND-of-two-bindings shape used to silently empty.
    let err = query_by_property(
        &pool,
        "todo",
        Some("TODO"),
        Some("2025-01-01"),
        "eq",
        &page,
        None,
        None,
        false,
        None,
        &[],
        None,
    )
    .await
    .expect_err("both value filters must be rejected");
    match err {
        crate::error::AppError::Validation(msg) => {
            assert!(
                msg.contains("value_text") && msg.contains("value_date"),
                "validation message must name both inputs; got {msg:?}"
            );
        }
        other => panic!("expected Validation, got {other:?}"),
    }

    // Reserved key (date column): historical silent precedence path.
    let err = query_by_property(
        &pool,
        "due_date",
        Some("anything"),
        Some("2025-01-01"),
        "eq",
        &page,
        None,
        None,
        false,
        None,
        &[],
        None,
    )
    .await
    .expect_err("both value filters must be rejected on reserved-key path too");
    assert!(matches!(err, crate::error::AppError::Validation(_)));
}

// ====================================================================
// list_agenda
// ====================================================================

#[tokio::test]
async fn list_agenda_returns_blocks_for_matching_date() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLOCK001", "content", "meeting", None, None).await;
    insert_block(&pool, "BLOCK002", "content", "deadline", None, None).await;
    insert_block(&pool, "BLOCK003", "content", "other day", None, None).await;

    insert_agenda_entry(&pool, "2025-01-15", "BLOCK001", "property:scheduled").await;
    insert_agenda_entry(&pool, "2025-01-15", "BLOCK002", "property:deadline").await;
    insert_agenda_entry(&pool, "2025-01-16", "BLOCK003", "property:scheduled").await;

    let page = PageRequest::new(None, Some(10)).unwrap();

    let resp = list_agenda(&pool, "2025-01-15", None, &page, None)
        .await
        .unwrap();
    assert_eq!(resp.items.len(), 2, "only blocks for Jan 15");
    assert_eq!(
        resp.items[0].id, "BLOCK001",
        "first agenda block for Jan 15"
    );
    assert_eq!(
        resp.items[1].id, "BLOCK002",
        "second agenda block for Jan 15"
    );

    let resp2 = list_agenda(&pool, "2025-01-16", None, &page, None)
        .await
        .unwrap();
    assert_eq!(resp2.items.len(), 1, "only blocks for Jan 16");
    assert_eq!(resp2.items[0].id, "BLOCK003", "agenda block for Jan 16");
}

#[tokio::test]
async fn list_agenda_returns_empty_for_date_with_no_entries() {
    let (pool, _dir) = test_pool().await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_agenda(&pool, "2025-12-31", None, &page, None)
        .await
        .unwrap();

    assert!(
        resp.items.is_empty(),
        "date with no entries must return empty"
    );
    assert!(!resp.has_more, "empty agenda should not indicate more");
}

#[tokio::test]
async fn list_agenda_paginates_with_cursor() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=5_i64 {
        let id = format!("BLOCK{i:03}");
        insert_block(&pool, &id, "content", &format!("event {i}"), None, None).await;
        insert_agenda_entry(&pool, "2025-01-15", &id, "property:due").await;
    }

    assert_paginates_with_cursor(
        &pool,
        ["BLOCK001", "BLOCK002", "BLOCK003", "BLOCK004", "BLOCK005"],
        async |pool, page| list_agenda(pool, "2025-01-15", None, &page, None).await,
    )
    .await;
}

#[tokio::test]
async fn list_agenda_excludes_soft_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "BLOCK001", "content", "meeting", None, None).await;
    insert_block(&pool, "BLOCK002", "content", "cancelled", None, None).await;
    insert_block(&pool, "BLOCK003", "content", "deadline", None, None).await;

    insert_agenda_entry(&pool, "2025-01-15", "BLOCK001", "property:scheduled").await;
    insert_agenda_entry(&pool, "2025-01-15", "BLOCK002", "property:scheduled").await;
    insert_agenda_entry(&pool, "2025-01-15", "BLOCK003", "property:deadline").await;

    soft_delete_block(&pool, "BLOCK002", FIXED_DELETED_AT).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_agenda(&pool, "2025-01-15", None, &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "soft-deleted block must be excluded from agenda"
    );
    assert_eq!(resp.items[0].id, "BLOCK001", "first alive agenda block");
    assert_eq!(
        resp.items[1].id, "BLOCK003",
        "second alive agenda block, BLOCK002 excluded"
    );
}

// ====================================================================
// list_agenda_range
// ====================================================================

#[tokio::test]
async fn list_agenda_range_returns_blocks_in_date_range() {
    let (pool, _dir) = test_pool().await;

    // Create blocks for dates 2025-01-10 through 2025-01-15.
    for day in 10..=15_i64 {
        let id = format!("BLOCK0{day}");
        let date = format!("2025-01-{day}");
        insert_block(&pool, &id, "content", &format!("event {day}"), None, None).await;
        insert_agenda_entry(&pool, &date, &id, "property:due_date").await;
        sqlx::query("UPDATE blocks SET due_date = ? WHERE id = ?")
            .bind(&date)
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
    }

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_agenda_range(&pool, "2025-01-11", "2025-01-13", None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 3, "only blocks for Jan 11-13");
    assert_eq!(resp.items[0].id, "BLOCK011", "first in range (Jan 11)");
    assert_eq!(resp.items[1].id, "BLOCK012", "second in range (Jan 12)");
    assert_eq!(resp.items[2].id, "BLOCK013", "third in range (Jan 13)");
    assert!(!resp.has_more, "all items fit in one page");
}

#[tokio::test]
async fn list_agenda_range_paginates_with_cursor() {
    let (pool, _dir) = test_pool().await;

    // 5 entries spread across dates so ordering is (date ASC, id ASC).
    let entries = [
        ("AGBLK001", "2025-02-01"),
        ("AGBLK002", "2025-02-01"),
        ("AGBLK003", "2025-02-02"),
        ("AGBLK004", "2025-02-03"),
        ("AGBLK005", "2025-02-03"),
    ];
    for (id, date) in &entries {
        insert_block(&pool, id, "content", &format!("ev {id}"), None, None).await;
        insert_agenda_entry(&pool, date, id, "property:due_date").await;
        sqlx::query("UPDATE blocks SET due_date = ? WHERE id = ?")
            .bind(date)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }

    assert_paginates_with_cursor(
        &pool,
        ["AGBLK001", "AGBLK002", "AGBLK003", "AGBLK004", "AGBLK005"],
        async |pool, page| {
            list_agenda_range(pool, "2025-02-01", "2025-02-03", None, &page, None).await
        },
    )
    .await;
}

#[tokio::test]
async fn list_agenda_range_last_page_has_no_cursor() {
    let (pool, _dir) = test_pool().await;

    let entries = [
        ("LPBLK001", "2025-03-01"),
        ("LPBLK002", "2025-03-02"),
        ("LPBLK003", "2025-03-02"),
        ("LPBLK004", "2025-03-03"),
        ("LPBLK005", "2025-03-03"),
    ];
    for (id, date) in &entries {
        insert_block(&pool, id, "content", &format!("ev {id}"), None, None).await;
        insert_agenda_entry(&pool, date, id, "property:due_date").await;
        sqlx::query("UPDATE blocks SET due_date = ? WHERE id = ?")
            .bind(date)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }

    let r1 = list_agenda_range(
        &pool,
        "2025-03-01",
        "2025-03-03",
        None,
        &PageRequest::new(None, Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();
    let r2 = list_agenda_range(
        &pool,
        "2025-03-01",
        "2025-03-03",
        None,
        &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();
    let r3 = list_agenda_range(
        &pool,
        "2025-03-01",
        "2025-03-03",
        None,
        &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();

    assert_eq!(r3.items.len(), 1, "last page must contain remaining item");
    assert!(!r3.has_more, "last page must have has_more = false");
    assert!(r3.next_cursor.is_none(), "last page must have no cursor");
    assert_eq!(r3.items[0].id, "LPBLK005", "last page item");
}

#[tokio::test]
async fn list_agenda_range_returns_empty_for_range_with_no_entries() {
    let (pool, _dir) = test_pool().await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_agenda_range(&pool, "2025-06-01", "2025-06-30", None, &page, None)
        .await
        .unwrap();

    assert!(
        resp.items.is_empty(),
        "range with no entries must return empty"
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
async fn list_agenda_range_excludes_soft_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "SDBLK001", "content", "alive 1", None, None).await;
    insert_block(&pool, "SDBLK002", "content", "deleted", None, None).await;
    insert_block(&pool, "SDBLK003", "content", "alive 2", None, None).await;

    for id in &["SDBLK001", "SDBLK002", "SDBLK003"] {
        insert_agenda_entry(&pool, "2025-04-10", id, "property:due_date").await;
        sqlx::query("UPDATE blocks SET due_date = ? WHERE id = ?")
            .bind("2025-04-10")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }

    soft_delete_block(&pool, "SDBLK002", FIXED_DELETED_AT).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_agenda_range(&pool, "2025-04-10", "2025-04-10", None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "soft-deleted block must be excluded");
    assert_eq!(resp.items[0].id, "SDBLK001", "first alive block");
    assert_eq!(
        resp.items[1].id, "SDBLK003",
        "second alive block, SDBLK002 excluded"
    );
}

#[tokio::test]
async fn list_agenda_range_respects_source_filter() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "SFBLK001", "content", "due item 1", None, None).await;
    insert_block(&pool, "SFBLK002", "content", "sched item", None, None).await;
    insert_block(&pool, "SFBLK003", "content", "due item 2", None, None).await;

    insert_agenda_entry(&pool, "2025-05-01", "SFBLK001", "property:due_date").await;
    insert_agenda_entry(&pool, "2025-05-01", "SFBLK002", "property:scheduled_date").await;
    insert_agenda_entry(&pool, "2025-05-02", "SFBLK003", "property:due_date").await;

    sqlx::query("UPDATE blocks SET due_date = '2025-05-01' WHERE id = 'SFBLK001'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET scheduled_date = '2025-05-01' WHERE id = 'SFBLK002'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET due_date = '2025-05-02' WHERE id = 'SFBLK003'")
        .execute(&pool)
        .await
        .unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_agenda_range(
        &pool,
        "2025-05-01",
        "2025-05-02",
        Some("property:due_date"),
        &page,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 2, "only due_date entries returned");
    assert_eq!(resp.items[0].id, "SFBLK001", "first due_date entry");
    assert_eq!(resp.items[1].id, "SFBLK003", "second due_date entry");
}

#[tokio::test]
async fn list_agenda_range_exhaustive_walk_returns_all_items_once() {
    let (pool, _dir) = test_pool().await;

    // 13 entries across multiple dates, ordered by (date ASC, id ASC).
    let entries = [
        ("EWBLK001", "2025-06-01"),
        ("EWBLK002", "2025-06-01"),
        ("EWBLK003", "2025-06-01"),
        ("EWBLK004", "2025-06-02"),
        ("EWBLK005", "2025-06-02"),
        ("EWBLK006", "2025-06-03"),
        ("EWBLK007", "2025-06-03"),
        ("EWBLK008", "2025-06-03"),
        ("EWBLK009", "2025-06-03"),
        ("EWBLK010", "2025-06-04"),
        ("EWBLK011", "2025-06-05"),
        ("EWBLK012", "2025-06-05"),
        ("EWBLK013", "2025-06-05"),
    ];
    for (id, date) in &entries {
        insert_block(&pool, id, "content", &format!("ev {id}"), None, None).await;
        insert_agenda_entry(&pool, date, id, "property:due_date").await;
        sqlx::query("UPDATE blocks SET due_date = ? WHERE id = ?")
            .bind(date)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }

    let mut all_ids = Vec::new();
    let mut cursor = None;
    loop {
        let page = PageRequest::new(cursor, Some(3)).unwrap();
        let resp = list_agenda_range(&pool, "2025-06-01", "2025-06-05", None, &page, None)
            .await
            .unwrap();
        all_ids.extend(resp.items.iter().map(|b| b.id.as_str().to_string()));
        if !resp.has_more {
            break;
        }
        cursor = resp.next_cursor;
    }

    let expected: Vec<String> = entries.iter().map(|(id, _)| id.to_string()).collect();
    assert_eq!(
        all_ids, expected,
        "exhaustive walk must return every item exactly once, in (date, id) order"
    );
}

#[tokio::test]
async fn list_agenda_range_cursor_uses_ac_date_not_block_dates_h8() {
    // H-8 regression: the cursor must encode `ac.date`, not
    // `b.due_date` / `b.scheduled_date`. When an agenda_cache row's
    // date comes from a non-column source (e.g. a property), the
    // cursor would otherwise drift and page 2 would skip or duplicate
    // entries at the page boundary.
    //
    // Setup: 3 blocks all with `b.due_date = '2025-01-01'` (the
    // "wrong" date that the old extract_date_for_cursor would pick)
    // but `agenda_cache.date` set to '2025-03-10', '2025-03-11',
    // '2025-03-12' respectively, with `source = 'property:custom_due'`.
    // Page 1 (limit 2) returns the first two. Page 2 with the cursor
    // must return ONLY the third — neither skipping it nor
    // re-returning the second.
    let (pool, _dir) = test_pool().await;

    // ULIDs ordered such that lexicographic comparison is stable.
    let entries = [
        ("01J0000000000000000000000A", "2025-03-10"),
        ("01J0000000000000000000000B", "2025-03-11"),
        ("01J0000000000000000000000C", "2025-03-12"),
    ];
    for (id, ac_date) in &entries {
        // Block has the "wrong" due_date — the cursor MUST NOT pick this up.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, due_date, page_id) \
             VALUES (?, 'content', ?, '2025-01-01', NULL)",
        )
        .bind(id)
        .bind(format!("event {id}"))
        .execute(&pool)
        .await
        .unwrap();
        // agenda_cache uses a non-column source: a custom property.
        insert_agenda_entry(&pool, ac_date, id, "property:custom_due").await;
    }

    // Page 1: limit 2 → expect A, B with a non-null cursor.
    let r1 = list_agenda_range(
        &pool,
        "2025-03-01",
        "2025-03-31",
        None,
        &PageRequest::new(None, Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(r1.items.len(), 2, "page 1 must contain 2 rows");
    assert!(r1.has_more, "page 1 must indicate more pages");
    assert_eq!(r1.items[0].id, "01J0000000000000000000000A");
    assert_eq!(r1.items[1].id, "01J0000000000000000000000B");
    let cursor_str = r1.next_cursor.expect("page 1 must yield a cursor");

    // Decode the cursor and assert it stashed the SECOND row's
    // `ac.date` ('2025-03-11'), NOT the block's `due_date` ('2025-01-01').
    let cursor = Cursor::decode(&cursor_str).expect("cursor must decode");
    assert_eq!(
        cursor.deleted_at.as_deref(),
        Some("2025-03-11"),
        "cursor.deleted_at must encode ac.date, not b.due_date — \
         this is the H-8 regression"
    );
    assert_eq!(
        cursor.id, "01J0000000000000000000000B",
        "cursor.id must be the second row's id"
    );

    // Page 2: feed the cursor back. Must return ONLY the third row.
    let r2 = list_agenda_range(
        &pool,
        "2025-03-01",
        "2025-03-31",
        None,
        &PageRequest::new(Some(cursor_str), Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        r2.items.len(),
        1,
        "page 2 must return exactly the remaining row — \
         not skipped, not duplicated"
    );
    assert!(!r2.has_more, "page 2 must be terminal");
    assert!(
        r2.next_cursor.is_none(),
        "terminal page must have no cursor"
    );
    assert_eq!(
        r2.items[0].id, "01J0000000000000000000000C",
        "page 2 must contain the third row"
    );
}

// ====================================================================
// insta snapshot tests — BlockRow and PageResponse
// ====================================================================

/// Snapshot a PageResponse<BlockRow> from list_children.
/// All data is deterministic (manually inserted IDs/content).
#[tokio::test]
async fn snapshot_page_response_list_children() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "SNAP_PAR", "page", "parent page", None, Some(0)).await;
    insert_block(
        &pool,
        "SNAP_CH1",
        "content",
        "first child",
        Some("SNAP_PAR"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "SNAP_CH2",
        "content",
        "second child",
        Some("SNAP_PAR"),
        Some(2),
    )
    .await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_children(&pool, Some("SNAP_PAR"), &page, None)
        .await
        .unwrap();

    insta::assert_yaml_snapshot!(resp);
}

/// Snapshot a PageResponse<BlockRow> with pagination (has_more = true).
#[tokio::test]
async fn snapshot_page_response_with_cursor() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "SNAP_PAR2", "page", "parent", None, Some(0)).await;
    for i in 1..=3_i64 {
        let id = format!("SNAP_C{i:02}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("child {i}"),
            Some("SNAP_PAR2"),
            Some(i),
        )
        .await;
    }

    let page = PageRequest::new(None, Some(2)).unwrap();
    let resp = list_children(&pool, Some("SNAP_PAR2"), &page, None)
        .await
        .unwrap();

    insta::assert_yaml_snapshot!(resp, {
        ".next_cursor" => "[CURSOR]",
    });
}

// ====================================================================
// list_backlinks
// ====================================================================

/// Insert a block_links row directly.
async fn insert_block_link(pool: &SqlitePool, source_id: &str, target_id: &str) {
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(source_id)
        .bind(target_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Insert an op_log entry directly for history tests.
///
/// PEND-20 B.2 — `list_block_history` now queries the native `block_id`
/// column (migration 0030) instead of `json_extract(payload, '$.block_id')`,
/// so test inserts must populate `block_id` from the payload to match
/// production rows. Production-side this happens automatically in
/// `op_log::append_local_op_in_tx`; tests that bypass that path use
/// this helper.
async fn insert_op_log_entry(
    pool: &SqlitePool,
    device_id: &str,
    seq: i64,
    op_type: &str,
    payload: &str,
    created_at: &str,
) {
    // #109 Phase 2: op_log.created_at is now INTEGER epoch-ms. Callers pass
    // ISO-8601 strings for readability; convert to ms here, preserving the
    // exact monotonic ordering those strings encode.
    let created_at_ms = chrono::DateTime::parse_from_rfc3339(created_at)
        .unwrap()
        .timestamp_millis();
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, ?, ?, ?, ?, json_extract(?, '$.block_id'))",
    )
    .bind(device_id)
    .bind(seq)
    .bind("test-hash-placeholder")
    .bind(op_type)
    .bind(payload)
    .bind(created_at_ms)
    .bind(payload)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn test_list_backlinks_basic() {
    let (pool, _dir) = test_pool().await;

    // Target block and source blocks
    insert_block(&pool, "TARGET01", "page", "target page", None, None).await;
    insert_block(&pool, "SOURCE01", "content", "links to target", None, None).await;
    insert_block(&pool, "SOURCE02", "content", "also links", None, None).await;
    insert_block(&pool, "UNLINKED", "content", "no link", None, None).await;

    insert_block_link(&pool, "SOURCE01", "TARGET01").await;
    insert_block_link(&pool, "SOURCE02", "TARGET01").await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_backlinks(&pool, "TARGET01", &page, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "only linked blocks must be returned");
    assert_eq!(resp.items[0].id, "SOURCE01", "first backlink source");
    assert_eq!(resp.items[1].id, "SOURCE02", "second backlink source");
    assert!(!resp.has_more, "all backlinks fit in one page");
    assert!(
        resp.next_cursor.is_none(),
        "single page should have no cursor"
    );
}

#[tokio::test]
async fn test_list_backlinks_pagination() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TARGET01", "page", "target", None, None).await;
    for i in 1..=5_i64 {
        let id = format!("SRC{i:05}");
        insert_block(&pool, &id, "content", &format!("source {i}"), None, None).await;
        insert_block_link(&pool, &id, "TARGET01").await;
    }

    // Page 1
    let r1 = list_backlinks(
        &pool,
        "TARGET01",
        &PageRequest::new(None, Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(r1.items.len(), 2, "backlinks page 1 should return 2 items");
    assert!(r1.has_more, "backlinks page 1 should indicate more");
    assert_eq!(r1.items[0].id, "SRC00001", "backlinks page 1 first item");
    assert_eq!(r1.items[1].id, "SRC00002", "backlinks page 1 second item");

    // Page 2
    let r2 = list_backlinks(
        &pool,
        "TARGET01",
        &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(r2.items.len(), 2, "backlinks page 2 should return 2 items");
    assert!(r2.has_more, "backlinks page 2 should indicate more");
    assert_eq!(r2.items[0].id, "SRC00003", "backlinks page 2 first item");
    assert_eq!(r2.items[1].id, "SRC00004", "backlinks page 2 second item");

    // Page 3 (last)
    let r3 = list_backlinks(
        &pool,
        "TARGET01",
        &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        r3.items.len(),
        1,
        "backlinks last page should return 1 item"
    );
    assert!(!r3.has_more, "backlinks last page should not indicate more");
    assert!(
        r3.next_cursor.is_none(),
        "backlinks last page should have no cursor"
    );
    assert_eq!(r3.items[0].id, "SRC00005", "backlinks last page item");
}

#[tokio::test]
async fn test_list_backlinks_excludes_deleted() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TARGET01", "page", "target", None, None).await;
    insert_block(&pool, "SOURCE01", "content", "alive", None, None).await;
    insert_block(&pool, "SOURCE02", "content", "deleted", None, None).await;
    insert_block(&pool, "SOURCE03", "content", "alive too", None, None).await;

    insert_block_link(&pool, "SOURCE01", "TARGET01").await;
    insert_block_link(&pool, "SOURCE02", "TARGET01").await;
    insert_block_link(&pool, "SOURCE03", "TARGET01").await;

    soft_delete_block(&pool, "SOURCE02", FIXED_DELETED_AT).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_backlinks(&pool, "TARGET01", &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "soft-deleted source block must be excluded"
    );
    assert_eq!(resp.items[0].id, "SOURCE01", "first alive backlink source");
    assert_eq!(resp.items[1].id, "SOURCE03", "second alive backlink source");
}

#[tokio::test]
async fn test_list_backlinks_empty() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "TARGET01", "page", "target page", None, None).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_backlinks(&pool, "TARGET01", &page, None)
        .await
        .unwrap();

    assert!(
        resp.items.is_empty(),
        "target with no links must return empty"
    );
    assert!(!resp.has_more, "empty backlinks should not indicate more");
    assert!(
        resp.next_cursor.is_none(),
        "empty backlinks should have no cursor"
    );
}

// ====================================================================
// list_block_history
// ====================================================================

#[tokio::test]
async fn test_list_block_history_basic() {
    let (pool, _dir) = test_pool().await;

    let payload = r#"{"block_id":"HIST_BLK","block_type":"content","content":"hello"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        1,
        "create_block",
        payload,
        "2025-01-01T00:00:00Z",
    )
    .await;

    let edit_payload = r#"{"block_id":"HIST_BLK","to_text":"updated"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        2,
        "edit_block",
        edit_payload,
        "2025-01-01T01:00:00Z",
    )
    .await;

    // Unrelated op (different block)
    let other_payload = r#"{"block_id":"OTHER_BLK","content":"other"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        3,
        "create_block",
        other_payload,
        "2025-01-01T02:00:00Z",
    )
    .await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_block_history(&pool, "HIST_BLK", None, &page)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "only ops for HIST_BLK");
    // Newest first (seq DESC)
    assert_eq!(resp.items[0].seq, 2, "newest op first");
    assert_eq!(
        resp.items[0].op_type, "edit_block",
        "newest op should be edit_block"
    );
    assert_eq!(resp.items[1].seq, 1, "oldest op seq should be 1");
    assert_eq!(
        resp.items[1].op_type, "create_block",
        "oldest op should be create_block"
    );
    assert!(!resp.has_more, "all history fits in one page");
}

#[tokio::test]
async fn test_list_block_history_pagination() {
    let (pool, _dir) = test_pool().await;

    for i in 1..=5_i64 {
        let payload = format!(r#"{{"block_id":"HIST_BLK","to_text":"v{i}"}}"#);
        insert_op_log_entry(
            &pool,
            "device-1",
            i,
            "edit_block",
            &payload,
            &format!("2025-01-01T{i:02}:00:00Z"),
        )
        .await;
    }

    // Page 1: newest first → seq 5, 4
    let r1 = list_block_history(
        &pool,
        "HIST_BLK",
        None,
        &PageRequest::new(None, Some(2)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(r1.items.len(), 2, "history page 1 should return 2 items");
    assert!(r1.has_more, "history page 1 should indicate more");
    assert_eq!(r1.items[0].seq, 5, "history page 1 first seq");
    assert_eq!(r1.items[1].seq, 4, "history page 1 second seq");

    // Page 2: seq 3, 2
    let r2 = list_block_history(
        &pool,
        "HIST_BLK",
        None,
        &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(r2.items.len(), 2, "history page 2 should return 2 items");
    assert!(r2.has_more, "history page 2 should indicate more");
    assert_eq!(r2.items[0].seq, 3, "history page 2 first seq");
    assert_eq!(r2.items[1].seq, 2, "history page 2 second seq");

    // Page 3 (last): seq 1
    let r3 = list_block_history(
        &pool,
        "HIST_BLK",
        None,
        &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(r3.items.len(), 1, "history last page should return 1 item");
    assert!(!r3.has_more, "history last page should not indicate more");
    assert!(
        r3.next_cursor.is_none(),
        "history last page should have no cursor"
    );
    assert_eq!(r3.items[0].seq, 1, "history last page seq");
}

#[tokio::test]
async fn test_list_block_history_empty() {
    let (pool, _dir) = test_pool().await;

    // No ops in op_log at all
    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_block_history(&pool, "NONEXISTENT", None, &page)
        .await
        .unwrap();

    assert!(
        resp.items.is_empty(),
        "block with no history must return empty"
    );
    assert!(!resp.has_more, "empty history should not indicate more");
    assert!(
        resp.next_cursor.is_none(),
        "empty history should have no cursor"
    );
}

#[tokio::test]
async fn test_list_block_history_all_op_types() {
    let (pool, _dir) = test_pool().await;

    let ops = [
        (
            1,
            "create_block",
            r#"{"block_id":"BLK01","block_type":"content","content":"hi"}"#,
        ),
        (
            2,
            "edit_block",
            r#"{"block_id":"BLK01","to_text":"updated"}"#,
        ),
        (3, "add_tag", r#"{"block_id":"BLK01","tag_id":"TAG01"}"#),
        (4, "remove_tag", r#"{"block_id":"BLK01","tag_id":"TAG01"}"#),
        (
            5,
            "move_block",
            r#"{"block_id":"BLK01","new_parent_id":null,"new_position":1}"#,
        ),
    ];

    for (seq, op_type, payload) in &ops {
        insert_op_log_entry(
            &pool,
            "device-1",
            *seq,
            op_type,
            payload,
            "2025-01-01T00:00:00Z",
        )
        .await;
    }

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_block_history(&pool, "BLK01", None, &page)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        5,
        "all op types for the block must be returned"
    );
    let op_types: Vec<&str> = resp.items.iter().map(|e| e.op_type.as_str()).collect();
    assert!(
        op_types.contains(&"create_block"),
        "create_block op should appear"
    );
    assert!(
        op_types.contains(&"edit_block"),
        "edit_block op should appear"
    );
    assert!(op_types.contains(&"add_tag"), "add_tag op should appear");
    assert!(
        op_types.contains(&"remove_tag"),
        "remove_tag op should appear"
    );
    assert!(
        op_types.contains(&"move_block"),
        "move_block op should appear"
    );
}

/// PEND-35 Tier 1.3 — `op_type_filter = Some("edit_block")` must restrict
/// the result set to ops of that type at the SQL layer, so cursor pages
/// arrive pre-filtered (the FE no longer drops rows post-pagination).
#[tokio::test]
async fn list_block_history_filters_by_op_type() {
    let (pool, _dir) = test_pool().await;

    // Mixed ops for the same block (matches the canonical strings used
    // by the FE filter dropdown in `HistoryFilterBar`).
    let ops = [
        (
            1,
            "create_block",
            r#"{"block_id":"FILT_BLK","block_type":"content","content":"hi"}"#,
        ),
        (2, "edit_block", r#"{"block_id":"FILT_BLK","to_text":"v2"}"#),
        (3, "add_tag", r#"{"block_id":"FILT_BLK","tag_id":"TAG01"}"#),
        (4, "edit_block", r#"{"block_id":"FILT_BLK","to_text":"v3"}"#),
        (
            5,
            "remove_tag",
            r#"{"block_id":"FILT_BLK","tag_id":"TAG01"}"#,
        ),
    ];
    for (seq, op_type, payload) in &ops {
        insert_op_log_entry(
            &pool,
            "device-1",
            *seq,
            op_type,
            payload,
            &format!("2025-01-01T{seq:02}:00:00Z"),
        )
        .await;
    }

    let page = PageRequest::new(None, Some(10)).unwrap();

    // Filter to edit_block — only the two edit ops should come back.
    let resp = list_block_history(&pool, "FILT_BLK", Some("edit_block"), &page)
        .await
        .unwrap();
    assert_eq!(
        resp.items.len(),
        2,
        "only edit_block ops should be returned"
    );
    assert!(
        resp.items.iter().all(|e| e.op_type == "edit_block"),
        "every returned op must be edit_block"
    );

    // Filter to add_tag — only the single add_tag op.
    let resp_tag = list_block_history(&pool, "FILT_BLK", Some("add_tag"), &page)
        .await
        .unwrap();
    assert_eq!(resp_tag.items.len(), 1, "only one add_tag op");
    assert_eq!(resp_tag.items[0].op_type, "add_tag");

    // Filter to a type that's absent — empty result.
    let resp_none = list_block_history(&pool, "FILT_BLK", Some("move_block"), &page)
        .await
        .unwrap();
    assert!(
        resp_none.items.is_empty(),
        "no move_block ops were inserted"
    );
}

/// PEND-35 Tier 1.3 control — without an `op_type_filter`, every op for
/// the block is returned (parity with the pre-filter behaviour).
#[tokio::test]
async fn list_block_history_no_filter_returns_all() {
    let (pool, _dir) = test_pool().await;

    let ops = [
        (
            1,
            "create_block",
            r#"{"block_id":"NOFLT_BLK","block_type":"content","content":"hi"}"#,
        ),
        (
            2,
            "edit_block",
            r#"{"block_id":"NOFLT_BLK","to_text":"v2"}"#,
        ),
        (3, "add_tag", r#"{"block_id":"NOFLT_BLK","tag_id":"TAG01"}"#),
    ];
    for (seq, op_type, payload) in &ops {
        insert_op_log_entry(
            &pool,
            "device-1",
            *seq,
            op_type,
            payload,
            &format!("2025-01-01T{seq:02}:00:00Z"),
        )
        .await;
    }

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_block_history(&pool, "NOFLT_BLK", None, &page)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        3,
        "no filter must return every op for the block"
    );
}

/// PEND-35 Tier 1.3 — cursor pagination must remain consistent under an
/// active `op_type_filter`. The pre-PEND-35 anti-pattern was: 50-row
/// cursor page returned, FE drops the non-matching rows, page appears
/// empty even though `next_cursor` is set. With the SQL-level filter,
/// a small cursor `limit` over a sparsely-matching dataset must still
/// walk every matching row across multiple pages without skipping or
/// duplicating any.
#[tokio::test]
async fn list_block_history_paginates_under_op_type_filter() {
    let (pool, _dir) = test_pool().await;

    // 5 ops alternating types — 3 edit_block + 2 other. With limit = 1
    // and filter = "edit_block" we expect exactly 3 pages of 1 row.
    let ops = [
        (
            1,
            "create_block",
            r#"{"block_id":"PG_FILT","content":"v1"}"#,
        ),
        (2, "edit_block", r#"{"block_id":"PG_FILT","to_text":"v2"}"#),
        (3, "add_tag", r#"{"block_id":"PG_FILT","tag_id":"TAG01"}"#),
        (4, "edit_block", r#"{"block_id":"PG_FILT","to_text":"v3"}"#),
        (5, "edit_block", r#"{"block_id":"PG_FILT","to_text":"v4"}"#),
    ];
    for (seq, op_type, payload) in &ops {
        insert_op_log_entry(
            &pool,
            "device-1",
            *seq,
            op_type,
            payload,
            &format!("2025-01-01T{seq:02}:00:00Z"),
        )
        .await;
    }

    // Page 1 — limit 1, expect the newest edit_block (seq 5).
    let r1 = list_block_history(
        &pool,
        "PG_FILT",
        Some("edit_block"),
        &PageRequest::new(None, Some(1)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(r1.items.len(), 1, "page 1 must return exactly 1 row");
    assert_eq!(r1.items[0].seq, 5, "page 1 newest matching seq");
    assert!(r1.has_more, "filter sees 3 matching rows; more remain");
    assert!(r1.next_cursor.is_some(), "page 1 must yield a cursor");
    let r1_seq = r1.items[0].seq;
    let r1_cursor = r1.next_cursor;

    // Page 2 — using r1.next_cursor, expect seq 4.
    let r2 = list_block_history(
        &pool,
        "PG_FILT",
        Some("edit_block"),
        &PageRequest::new(r1_cursor, Some(1)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(r2.items.len(), 1, "page 2 must return exactly 1 row");
    assert_eq!(
        r2.items[0].seq, 4,
        "page 2 must skip non-matching rows (seq 3 is add_tag)"
    );
    assert!(r2.has_more, "one more matching row remains");
    let r2_seq = r2.items[0].seq;
    let r2_cursor = r2.next_cursor;

    // Page 3 — final matching row (seq 2). Must NOT include seq 1
    // (create_block) because the filter pushes through every page.
    let r3 = list_block_history(
        &pool,
        "PG_FILT",
        Some("edit_block"),
        &PageRequest::new(r2_cursor, Some(1)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        r3.items.len(),
        1,
        "page 3 must return the last matching row"
    );
    assert_eq!(r3.items[0].seq, 2, "page 3 must be the oldest edit_block");
    assert!(!r3.has_more, "no more matching rows");
    assert!(r3.next_cursor.is_none(), "no further cursor");

    // Across all 3 pages we visited every edit_block exactly once.
    let seen = vec![r1_seq, r2_seq, r3.items[0].seq];
    assert_eq!(seen, vec![5, 4, 2], "filtered cursor walk hits every match");
}

/// PEND-20 B.2 parity: rows whose `block_id` column is unset must NOT
/// surface in `list_block_history` after the rewrite to native column
/// lookups, even if their JSON payload contains the right block_id.
/// This anchors the contract that the index is the source of truth and
/// `json_extract` is no longer consulted.
#[tokio::test]
async fn test_list_block_history_uses_native_block_id_column() {
    let (pool, _dir) = test_pool().await;

    // Row A: block_id column populated (matches the search) — should appear.
    insert_op_log_entry(
        &pool,
        "device-1",
        1,
        "create_block",
        r#"{"block_id":"PEND20B2","content":"hello"}"#,
        "2025-01-01T00:00:00Z",
    )
    .await;

    // Row B: payload contains block_id but column is NULL — must NOT appear.
    sqlx::query(
        "INSERT INTO op_log (device_id, seq, hash, op_type, payload, created_at, block_id) \
         VALUES (?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind("device-1")
    .bind(2_i64)
    .bind("test-hash-payload-only")
    .bind("edit_block")
    .bind(r#"{"block_id":"PEND20B2","to_text":"updated"}"#)
    .bind(1_735_693_200_000_i64)
    .execute(&pool)
    .await
    .unwrap();

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_block_history(&pool, "PEND20B2", None, &page)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "PEND-20 B.2: only the row with native block_id set should match"
    );
    assert_eq!(
        resp.items[0].seq, 1,
        "PEND-20 B.2: row A (block_id populated) is the match"
    );
}

// ====================================================================
// insta snapshot tests — HistoryEntry
// ====================================================================

/// Snapshot a PageResponse<HistoryEntry> from list_block_history.
#[tokio::test]
async fn snapshot_history_entry_response() {
    let (pool, _dir) = test_pool().await;

    let payload = r#"{"block_id":"SNAP_HIS","block_type":"content","content":"snap"}"#;
    insert_op_log_entry(
        &pool,
        "snap-device",
        1,
        "create_block",
        payload,
        "2025-06-15T12:00:00Z",
    )
    .await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_block_history(&pool, "SNAP_HIS", None, &page)
        .await
        .unwrap();

    // TEST-10: exhaustive redactions covering every non-deterministic field
    // surfaced by `PageResponse<HistoryEntry>` — `created_at` is an RFC 3339
    // timestamp and `next_cursor` is an opaque base64 cursor. Both must be
    // redacted unconditionally so the snapshot stays stable across runs.
    insta::assert_yaml_snapshot!(resp, {
        ".items[].created_at" => "[TIMESTAMP]",
        ".next_cursor"        => "[CURSOR]",
    });
}

// ====================================================================
// F01-fix: multi-device list_block_history
// ====================================================================

#[tokio::test]
async fn test_list_block_history_multi_device_pagination() {
    let (pool, _dir) = test_pool().await;

    // Two devices with OVERLAPPING seq values for the same block.
    // PK is (device_id, seq), so seq alone is NOT globally unique.
    let payload = r#"{"block_id":"MULTI_BLK","block_type":"content","content":"hello"}"#;

    // device-A: seq 1, 2
    insert_op_log_entry(
        &pool,
        "device-A",
        1,
        "create_block",
        payload,
        "2025-01-01T00:00:00Z",
    )
    .await;
    insert_op_log_entry(
        &pool,
        "device-A",
        2,
        "edit_block",
        r#"{"block_id":"MULTI_BLK","to_text":"v2"}"#,
        "2025-01-01T01:00:00Z",
    )
    .await;

    // device-B: seq 1, 2 (same seq values, different device)
    insert_op_log_entry(
        &pool,
        "device-B",
        1,
        "edit_block",
        r#"{"block_id":"MULTI_BLK","to_text":"v3"}"#,
        "2025-01-01T02:00:00Z",
    )
    .await;
    insert_op_log_entry(
        &pool,
        "device-B",
        2,
        "edit_block",
        r#"{"block_id":"MULTI_BLK","to_text":"v4"}"#,
        "2025-01-01T03:00:00Z",
    )
    .await;

    // Paginate with limit=1 so every op lands on its own page.
    // Expected order: (seq DESC, device_id DESC) → (2,B), (2,A), (1,B), (1,A)
    let mut all_entries: Vec<(i64, String)> = Vec::new();
    let mut cursor = None;
    loop {
        let page = PageRequest::new(cursor, Some(1)).unwrap();
        let resp = list_block_history(&pool, "MULTI_BLK", None, &page)
            .await
            .unwrap();
        for entry in &resp.items {
            all_entries.push((entry.seq, entry.device_id.clone()));
        }
        if !resp.has_more {
            break;
        }
        cursor = resp.next_cursor;
    }

    assert_eq!(
        all_entries.len(),
        4,
        "all 4 ops must be returned (2 devices \u{d7} 2 seq values)"
    );
    // Ordered by (seq DESC, device_id DESC)
    assert_eq!(
        all_entries[0],
        (2, "device-B".into()),
        "first: seq=2, device-B"
    );
    assert_eq!(
        all_entries[1],
        (2, "device-A".into()),
        "second: seq=2, device-A"
    );
    assert_eq!(
        all_entries[2],
        (1, "device-B".into()),
        "third: seq=1, device-B"
    );
    assert_eq!(
        all_entries[3],
        (1, "device-A".into()),
        "fourth: seq=1, device-A"
    );
}

// ====================================================================
// F08-fix: cursor validation for list_trash
// ====================================================================

#[tokio::test]
async fn list_trash_rejects_cursor_without_deleted_at() {
    let (pool, _dir) = test_pool().await;

    // A cursor that has no deleted_at — e.g. from a non-trash query.
    let bad_cursor = Cursor {
        id: "BLOCK001".into(),
        position: None,
        deleted_at: None, // missing!
        seq: None,
        rank: None,
    }
    .encode()
    .unwrap();

    let page = PageRequest::new(Some(bad_cursor), Some(10)).unwrap();
    let result = list_trash(&pool, &page, None).await;

    assert!(
        result.is_err(),
        "cursor without deleted_at must be rejected for trash query"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("cursor missing deleted_at"),
        "error message must mention missing deleted_at, got: {err_msg}"
    );
}

// ====================================================================
// Cursor stability after deletes (#37)
// ====================================================================

/// Cursor-based keyset pagination must remain stable when rows are
/// soft-deleted between page fetches.
#[tokio::test]
async fn cursor_stability_after_delete() {
    let (pool, _dir) = test_pool().await;

    // Create parent + 10 children
    insert_block(&pool, "CSPAR001", "page", "parent", None, Some(0)).await;
    for i in 1..=10_i64 {
        let id = format!("CS_C{i:03}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("child {i}"),
            Some("CSPAR001"),
            Some(i),
        )
        .await;
    }

    // Page 1: fetch first 5 children (limit=5)
    let p1 = PageRequest::new(None, Some(5)).unwrap();
    let r1 = list_children(&pool, Some("CSPAR001"), &p1, None)
        .await
        .unwrap();

    assert_eq!(r1.items.len(), 5, "page 1 must return 5 items");
    assert!(r1.has_more, "page 1 must have more items");
    assert_eq!(r1.items[0].id, "CS_C001", "page 1 should start at C001");
    assert_eq!(r1.items[4].id, "CS_C005", "page 1 should end at C005");

    // Soft-delete C03 (a block BEFORE the cursor position).
    soft_delete_block(&pool, "CS_C003", FIXED_DELETED_AT).await;

    // Page 2: continue from cursor — must see C06..C10
    let p2 = PageRequest::new(r1.next_cursor, Some(5)).unwrap();
    let r2 = list_children(&pool, Some("CSPAR001"), &p2, None)
        .await
        .unwrap();

    assert_eq!(
        r2.items.len(),
        5,
        "page 2 must return 5 items (C06\u{2013}C10)"
    );
    assert!(!r2.has_more, "page 2 is the last page");
    assert_eq!(r2.items[0].id, "CS_C006", "page 2 must start at C06");
    assert_eq!(r2.items[4].id, "CS_C010", "page 2 must end at C10");

    // C03 must NOT appear in page 2
    let page2_ids: Vec<&str> = r2.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        !page2_ids.contains(&"CS_C003"),
        "soft-deleted C03 must not appear in page 2"
    );

    // Verify no duplicates between page 1 and page 2
    let mut all_ids: Vec<String> = r1.items.iter().map(|b| b.id.as_str().to_string()).collect();
    all_ids.extend(r2.items.iter().map(|b| b.id.as_str().to_string()));
    let unique_count = {
        let mut set = std::collections::HashSet::new();
        all_ids
            .iter()
            .filter(|id| set.insert((*id).clone()))
            .count()
    };
    assert_eq!(unique_count, all_ids.len(), "no duplicate IDs across pages");

    // Verify a fresh full walk (no cursor) skips the deleted C03
    let fresh_page = PageRequest::new(None, Some(20)).unwrap();
    let fresh = list_children(&pool, Some("CSPAR001"), &fresh_page, None)
        .await
        .unwrap();
    assert_eq!(
        fresh.items.len(),
        9,
        "full walk after delete must return 9 items (C01\u{2013}C10 minus C03)"
    );
    let fresh_ids: Vec<&str> = fresh.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        !fresh_ids.contains(&"CS_C003"),
        "deleted C03 must be excluded from fresh walk"
    );
}

// ======================================================================
// list_children: next_cursor with exactly limit+1 items (line 174)
// ======================================================================

#[tokio::test]
async fn list_children_exactly_limit_plus_one_returns_next_cursor() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LP_PAR", "page", "parent", None, Some(1)).await;

    // Insert exactly 3 children (limit will be 2 → 3 = limit + 1)
    for i in 1..=3_i64 {
        let id = format!("LP_C{i:03}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("child {i}"),
            Some("LP_PAR"),
            Some(i),
        )
        .await;
    }

    let page = PageRequest::new(None, Some(2)).unwrap();
    let resp = list_children(&pool, Some("LP_PAR"), &page, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "should return exactly limit items");
    assert!(resp.has_more, "has_more must be true with limit+1 items");
    assert!(
        resp.next_cursor.is_some(),
        "next_cursor must be set when has_more is true"
    );
}

#[tokio::test]
async fn list_children_exactly_limit_items_returns_no_next_cursor() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "LE_PAR", "page", "parent", None, Some(1)).await;

    // Insert exactly 2 children (limit = 2 → fetch 3, get 2 → no overflow)
    for i in 1..=2_i64 {
        let id = format!("LE_C{i:03}");
        insert_block(
            &pool,
            &id,
            "content",
            &format!("child {i}"),
            Some("LE_PAR"),
            Some(i),
        )
        .await;
    }

    let page = PageRequest::new(None, Some(2)).unwrap();
    let resp = list_children(&pool, Some("LE_PAR"), &page, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "should return all 2 items");
    assert!(!resp.has_more, "has_more must be false when no overflow");
    assert!(
        resp.next_cursor.is_none(),
        "next_cursor must be None when has_more is false"
    );
}

// ====================================================================
// CTE oracle: verify optimized (no IFNULL) query matches original
// ====================================================================

/// Oracle: the old IFNULL-based list_children query (pre-P-18).
async fn list_children_ifnull_oracle(
    pool: &SqlitePool,
    parent_id: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) = match page.after.as_ref() {
        Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
        None => (None, 0, ""),
    };

    let rows = sqlx::query_as::<_, BlockRow>(
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at,
                 todo_state, priority, due_date, scheduled_date, page_id
         FROM blocks
         WHERE parent_id IS ?1 AND deleted_at IS NULL
           AND (?2 IS NULL OR (
                IFNULL(position, ?6) > ?3
                OR (IFNULL(position, ?6) = ?3 AND id > ?4)))
         ORDER BY IFNULL(position, ?6) ASC, id ASC
         LIMIT ?5"#,
    )
    .bind(parent_id)
    .bind(cursor_flag)
    .bind(cursor_pos)
    .bind(cursor_id)
    .bind(fetch_limit)
    .bind(NULL_POSITION_SENTINEL)
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.to_string(),
        position: Some(last.position.unwrap_or(NULL_POSITION_SENTINEL)),
        deleted_at: None,
        seq: None,
        rank: None,
    })
}

#[tokio::test]
async fn list_children_optimized_matches_ifnull_oracle() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;

    // Mix of positioned and sentinel-positioned blocks
    insert_block(
        &pool,
        "CHILD001",
        "content",
        "c1",
        Some("PARENT01"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "CHILD002",
        "content",
        "c2",
        Some("PARENT01"),
        Some(2),
    )
    .await;
    insert_block(
        &pool,
        "CHILD003",
        "content",
        "c3",
        Some("PARENT01"),
        Some(5),
    )
    .await;
    insert_block(
        &pool,
        "CHILD004",
        "content",
        "c4",
        Some("PARENT01"),
        Some(5),
    )
    .await;
    // Sentinel-positioned blocks (simulating former NULL positions after migration)
    insert_block(
        &pool,
        "TAG00001",
        "tag",
        "tag1",
        Some("PARENT01"),
        Some(NULL_POSITION_SENTINEL),
    )
    .await;
    insert_block(
        &pool,
        "TAG00002",
        "tag",
        "tag2",
        Some("PARENT01"),
        Some(NULL_POSITION_SENTINEL),
    )
    .await;

    // Walk all pages with both implementations and collect results
    let mut new_ids = Vec::new();
    let mut old_ids = Vec::new();
    let mut new_cursor = None;
    let mut old_cursor = None;
    loop {
        let new_page = PageRequest::new(new_cursor.clone(), Some(2)).unwrap();
        let old_page = PageRequest::new(old_cursor.clone(), Some(2)).unwrap();

        let new_resp = list_children(&pool, Some("PARENT01"), &new_page, None)
            .await
            .unwrap();
        let old_resp = list_children_ifnull_oracle(&pool, Some("PARENT01"), &old_page)
            .await
            .unwrap();

        // Each page should return the same items
        let new_page_ids: Vec<&str> = new_resp.items.iter().map(|b| b.id.as_str()).collect();
        let old_page_ids: Vec<&str> = old_resp.items.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(
            new_page_ids, old_page_ids,
            "page results must match between optimized and oracle query"
        );

        new_ids.extend(new_page_ids.iter().map(ToString::to_string));
        old_ids.extend(old_page_ids.iter().map(ToString::to_string));

        assert_eq!(
            new_resp.has_more, old_resp.has_more,
            "has_more must match between optimized and oracle query"
        );

        if !new_resp.has_more {
            break;
        }
        new_cursor = new_resp.next_cursor;
        old_cursor = old_resp.next_cursor;
    }

    assert_eq!(
        new_ids, old_ids,
        "full walk must produce identical results for optimized and oracle queries"
    );
    assert_eq!(new_ids.len(), 6, "must return all 6 blocks");
}

// ====================================================================
// list_page_history
// ====================================================================

#[tokio::test]
async fn test_list_page_history_basic_pagination() {
    let (pool, _dir) = test_pool().await;

    // Create a page and a child block
    insert_block(&pool, "PH_PAGE1", "page", "history page", None, Some(1)).await;
    insert_block(
        &pool,
        "PH_CHILD",
        "content",
        "child block",
        Some("PH_PAGE1"),
        Some(1),
    )
    .await;

    // Insert op_log entries for blocks in the page subtree
    let payload_page = r#"{"block_id":"PH_PAGE1","block_type":"page","content":"history page"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        1,
        "create_block",
        payload_page,
        "2025-01-01T00:00:00Z",
    )
    .await;
    let payload_child = r#"{"block_id":"PH_CHILD","block_type":"content","content":"child block"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        2,
        "create_block",
        payload_child,
        "2025-01-02T00:00:00Z",
    )
    .await;
    let edit_payload = r#"{"block_id":"PH_CHILD","to_text":"updated child"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        3,
        "edit_block",
        edit_payload,
        "2025-01-03T00:00:00Z",
    )
    .await;

    let page = PageRequest::new(None, Some(2)).unwrap();
    let resp = list_page_history(&pool, "PH_PAGE1", None, None, &page)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "page size must be respected");
    assert!(resp.has_more, "more items remain");
    assert!(
        resp.next_cursor.is_some(),
        "cursor must be provided when has_more"
    );
    // Ordered by created_at DESC, seq DESC → newest first
    assert_eq!(
        resp.items[0].seq, 3,
        "first item should be the most recent op"
    );
    assert_eq!(
        resp.items[1].seq, 2,
        "second item should be the second most recent op"
    );
}

#[tokio::test]
async fn test_list_page_history_empty_result() {
    let (pool, _dir) = test_pool().await;

    // Page exists but has no ops in op_log
    insert_block(&pool, "PH_EMPTY", "page", "empty page", None, Some(1)).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_page_history(&pool, "PH_EMPTY", None, None, &page)
        .await
        .unwrap();

    assert!(
        resp.items.is_empty(),
        "page with no history must return empty"
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
async fn test_list_page_history_cursor_continuation() {
    let (pool, _dir) = test_pool().await;

    // Create a page with child blocks
    insert_block(&pool, "PH_PAG2", "page", "page", None, Some(1)).await;
    insert_block(
        &pool,
        "PH_CHD2",
        "content",
        "child",
        Some("PH_PAG2"),
        Some(1),
    )
    .await;

    // Insert 5 ops for blocks in the subtree
    for i in 1..=5_i64 {
        let payload = format!(r#"{{"block_id":"PH_CHD2","to_text":"edit {i}"}}"#);
        let ts = format!("2025-01-{i:02}T00:00:00Z");
        insert_op_log_entry(&pool, "device-1", i, "edit_block", &payload, &ts).await;
    }

    // Page 1: limit=2
    let r1 = list_page_history(
        &pool,
        "PH_PAG2",
        None,
        None,
        &PageRequest::new(None, Some(2)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(r1.items.len(), 2, "page 1 should return 2 items");
    assert!(r1.has_more, "page 1 should indicate more");
    // Ordered by created_at DESC → seq 5, 4
    assert_eq!(r1.items[0].seq, 5, "page 1 first item: newest op");
    assert_eq!(r1.items[1].seq, 4, "page 1 second item");

    // Page 2: continue from cursor
    let r2 = list_page_history(
        &pool,
        "PH_PAG2",
        None,
        None,
        &PageRequest::new(r1.next_cursor, Some(2)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(r2.items.len(), 2, "page 2 should return 2 items");
    assert!(r2.has_more, "page 2 should indicate more");
    assert_eq!(r2.items[0].seq, 3, "page 2 first item");
    assert_eq!(r2.items[1].seq, 2, "page 2 second item");

    // Page 3 (last): remaining items
    let r3 = list_page_history(
        &pool,
        "PH_PAG2",
        None,
        None,
        &PageRequest::new(r2.next_cursor, Some(2)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(r3.items.len(), 1, "last page should return 1 item");
    assert!(!r3.has_more, "last page should not indicate more");
    assert!(r3.next_cursor.is_none(), "last page should have no cursor");
    assert_eq!(r3.items[0].seq, 1, "last page: oldest op");
}

#[tokio::test]
async fn test_list_page_history_op_type_filter() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PH_PAG3", "page", "page", None, Some(1)).await;
    insert_block(
        &pool,
        "PH_CHD3",
        "content",
        "child",
        Some("PH_PAG3"),
        Some(1),
    )
    .await;

    // Insert mixed op types
    let create_payload = r#"{"block_id":"PH_CHD3","block_type":"content","content":"child"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        1,
        "create_block",
        create_payload,
        "2025-01-01T00:00:00Z",
    )
    .await;
    let edit_payload = r#"{"block_id":"PH_CHD3","to_text":"edited"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        2,
        "edit_block",
        edit_payload,
        "2025-01-02T00:00:00Z",
    )
    .await;
    let tag_payload = r#"{"block_id":"PH_CHD3","tag_id":"TAG01"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        3,
        "add_tag",
        tag_payload,
        "2025-01-03T00:00:00Z",
    )
    .await;

    // Filter by edit_block only
    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_page_history(&pool, "PH_PAG3", Some("edit_block"), None, &page)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "only edit_block ops should be returned"
    );
    assert_eq!(
        resp.items[0].op_type, "edit_block",
        "returned op must be edit_block"
    );
    assert_eq!(resp.items[0].seq, 2, "edit_block op is seq 2");

    // Filter by create_block only
    let resp2 = list_page_history(&pool, "PH_PAG3", Some("create_block"), None, &page)
        .await
        .unwrap();
    assert_eq!(
        resp2.items.len(),
        1,
        "only create_block ops should be returned"
    );
    assert_eq!(
        resp2.items[0].op_type, "create_block",
        "must be create_block"
    );

    // No filter → all 3
    let resp_all = list_page_history(&pool, "PH_PAG3", None, None, &page)
        .await
        .unwrap();
    assert_eq!(resp_all.items.len(), 3, "no filter returns all op types");
}

#[tokio::test]
async fn test_list_page_history_global_all_pages() {
    let (pool, _dir) = test_pool().await;

    // Insert ops for different blocks (global history doesn't need subtree)
    let payload_a = r#"{"block_id":"GLOB_A","block_type":"page","content":"page A"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        1,
        "create_block",
        payload_a,
        "2025-01-01T00:00:00Z",
    )
    .await;
    let payload_b = r#"{"block_id":"GLOB_B","block_type":"page","content":"page B"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        2,
        "create_block",
        payload_b,
        "2025-01-02T00:00:00Z",
    )
    .await;
    let payload_c = r#"{"block_id":"GLOB_C","block_type":"content","content":"content C"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        3,
        "create_block",
        payload_c,
        "2025-01-03T00:00:00Z",
    )
    .await;

    // Use __all__ sentinel for global history
    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_page_history(&pool, "__all__", None, None, &page)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 3, "global history should return all ops");
    // Ordered by created_at DESC → seq 3, 2, 1
    assert_eq!(resp.items[0].seq, 3, "newest op first");
    assert_eq!(resp.items[1].seq, 2, "second newest");
    assert_eq!(resp.items[2].seq, 1, "oldest op last");
}

#[tokio::test]
async fn test_list_page_history_global_pagination() {
    let (pool, _dir) = test_pool().await;

    // Insert 5 ops for global history
    for i in 1..=5_i64 {
        let payload =
            format!(r#"{{"block_id":"GP_BLK{i}","block_type":"content","content":"b{i}"}}"#);
        let ts = format!("2025-01-{i:02}T00:00:00Z");
        insert_op_log_entry(&pool, "device-1", i, "create_block", &payload, &ts).await;
    }

    // Walk all pages with limit=2
    let mut all_seqs = Vec::new();
    let mut cursor = None;
    loop {
        let page = PageRequest::new(cursor, Some(2)).unwrap();
        let resp = list_page_history(&pool, "__all__", None, None, &page)
            .await
            .unwrap();
        for entry in &resp.items {
            all_seqs.push(entry.seq);
        }
        if !resp.has_more {
            break;
        }
        cursor = resp.next_cursor;
    }

    assert_eq!(
        all_seqs,
        vec![5, 4, 3, 2, 1],
        "exhaustive walk of global history must return all ops newest-first"
    );
}

#[tokio::test]
async fn test_list_page_history_global_op_type_filter() {
    let (pool, _dir) = test_pool().await;

    let create_payload = r#"{"block_id":"GF_BLK1","block_type":"content","content":"c"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        1,
        "create_block",
        create_payload,
        "2025-01-01T00:00:00Z",
    )
    .await;
    let edit_payload = r#"{"block_id":"GF_BLK1","to_text":"edited"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        2,
        "edit_block",
        edit_payload,
        "2025-01-02T00:00:00Z",
    )
    .await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_page_history(&pool, "__all__", Some("edit_block"), None, &page)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "global filter should return only matching op type"
    );
    assert_eq!(resp.items[0].op_type, "edit_block", "must be edit_block");
}

#[tokio::test]
async fn test_list_page_history_includes_nested_children() {
    let (pool, _dir) = test_pool().await;

    // Create nested page → child → grandchild
    insert_block(&pool, "PH_ROOT", "page", "root page", None, Some(1)).await;
    insert_block(
        &pool,
        "PH_LVL1",
        "content",
        "level 1",
        Some("PH_ROOT"),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        "PH_LVL2",
        "content",
        "level 2",
        Some("PH_LVL1"),
        Some(1),
    )
    .await;

    // Ops for each level
    let p_root = r#"{"block_id":"PH_ROOT","block_type":"page","content":"root page"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        1,
        "create_block",
        p_root,
        "2025-01-01T00:00:00Z",
    )
    .await;

    let p_lvl1 = r#"{"block_id":"PH_LVL1","block_type":"content","content":"level 1"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        2,
        "create_block",
        p_lvl1,
        "2025-01-02T00:00:00Z",
    )
    .await;

    let p_lvl2 = r#"{"block_id":"PH_LVL2","block_type":"content","content":"level 2"}"#;
    insert_op_log_entry(
        &pool,
        "device-1",
        3,
        "create_block",
        p_lvl2,
        "2025-01-03T00:00:00Z",
    )
    .await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = list_page_history(&pool, "PH_ROOT", None, None, &page)
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        3,
        "page history must include ops for nested descendants"
    );
}

// ====================================================================
// #476 L2 — list_page_history device_id tiebreaker
// ====================================================================

/// Verifies the 3-way `(created_at DESC, seq DESC, device_id DESC)` keyset
/// cursor when two devices share BOTH `created_at` and `seq`.
///
/// Without the `device_id` arm the cursor would be ambiguous and one of the
/// tied rows would either be duplicated on the next page or silently dropped.
#[tokio::test]
async fn test_list_page_history_multi_device_cursor() {
    let (pool, _dir) = test_pool().await;

    // One page block — all ops reference this page.
    insert_block(&pool, "PHD_PAGE", "page", "test page", None, Some(1)).await;

    // Two devices that produce ops with the SAME created_at AND seq value
    // for the same block. PK is (device_id, seq), so both rows are unique.
    let payload = r#"{"block_id":"PHD_PAGE","block_type":"page","content":"test page"}"#;

    // device-A and device-B both emit seq=1 at the SAME millisecond timestamp.
    // We pick a fixed ISO-8601 string that maps to a unique ms value and insert
    // both rows — the DB primary key (device_id, seq) allows this.
    insert_op_log_entry(
        &pool,
        "device-A",
        1,
        "create_block",
        payload,
        "2025-03-01T00:00:00Z",
    )
    .await;
    insert_op_log_entry(
        &pool,
        "device-B",
        1,
        "edit_block",
        r#"{"block_id":"PHD_PAGE","to_text":"edited"}"#,
        "2025-03-01T00:00:00Z", // same created_at AND same seq → device_id is the tiebreaker
    )
    .await;

    // Also add a third op with a different created_at so we can verify the
    // cursor crosses the (created_at, seq, device_id) boundary correctly.
    insert_op_log_entry(
        &pool,
        "device-A",
        2,
        "edit_block",
        r#"{"block_id":"PHD_PAGE","to_text":"v2"}"#,
        "2025-03-02T00:00:00Z",
    )
    .await;

    // Paginate with limit=1 so every op lands on its own page.
    // Expected order (created_at DESC, seq DESC, device_id DESC):
    //   1. (2025-03-02, seq=2, device-A) — highest created_at
    //   2. (2025-03-01, seq=1, device-B) — tied created_at+seq, device-B wins DESC
    //   3. (2025-03-01, seq=1, device-A) — device_id tiebreaker
    let mut all_entries: Vec<(i64, String)> = Vec::new();
    let mut cursor = None;
    loop {
        let page = PageRequest::new(cursor, Some(1)).unwrap();
        let resp = list_page_history(&pool, "PHD_PAGE", None, None, &page)
            .await
            .unwrap();
        for entry in &resp.items {
            all_entries.push((entry.seq, entry.device_id.clone()));
        }
        if !resp.has_more {
            break;
        }
        cursor = resp.next_cursor;
    }

    assert_eq!(
        all_entries.len(),
        3,
        "all 3 ops must be returned across pages"
    );

    // Verify no duplicates
    let mut seen = std::collections::HashSet::new();
    for entry in &all_entries {
        assert!(
            seen.insert(entry.clone()),
            "duplicate entry found: {entry:?}"
        );
    }

    // Verify ordering: device-B before device-A for the tied (created_at, seq) pair
    assert_eq!(
        all_entries[0],
        (2, "device-A".into()),
        "first: seq=2, device-A"
    );
    assert_eq!(
        all_entries[1],
        (1, "device-B".into()),
        "second: seq=1, device-B (device_id tiebreaker)"
    );
    assert_eq!(
        all_entries[2],
        (1, "device-A".into()),
        "third: seq=1, device-A"
    );
}

// ====================================================================
// FEAT-3 Phase 2 — space filtering
// ====================================================================
//
// These tests exercise the `Some(space_id)` path of `list_by_type`,
// `list_children`, and `list_trash` end-to-end so the shared
// `AND (?N IS NULL OR COALESCE(b.page_id, b.id) IN (SELECT bp.block_id
// FROM block_properties bp WHERE bp.key = 'space' AND bp.value_ref = ?N))`
// SQL fragment is verified against live data. The existing coverage only
// passes `None` for every call, so a regression in the filter SQL would
// not be caught.
//
// Test-scoped helpers are defined inline to keep each test self-contained
// (matches the existing module convention — see `insert_block`,
// `soft_delete_block`). IDs are bare strings rather than real ULIDs:
// `blocks.id` is TEXT and the command-layer ULID validation is bypassed
// when we insert via raw SQL.

/// ID used for the synthetic "SPACE_A" space block (satisfies the
/// `block_properties.value_ref → blocks(id)` FK).
const SPACE_A_ID: &str = "SPACE_AA";
/// ID used for the synthetic "SPACE_B" space block.
const SPACE_B_ID: &str = "SPACE_BB";

/// Insert a page block that is itself a space (`is_space = 'true'`). The
/// page row must exist for the `block_properties.value_ref` FK to
/// succeed when a later page is assigned to this space.
async fn insert_space_block(pool: &SqlitePool, id: &str, name: &str) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, 1, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
    )
    .bind(id)
    .execute(pool)
    .await
    .unwrap();
}

/// Assign a block to a space by stamping the denormalized `blocks.space_id`
/// column directly. Bypasses `set_property_in_tx` intentionally — these
/// tests target the filter SQL, not the command layer.
async fn assign_to_space(pool: &SqlitePool, block_id: &str, space_id: &str) {
    // #533: stamp the denormalized `blocks.space_id` column — every block
    // whose owning page is `block_id` (pages carry `page_id = id`) is in
    // this space. Equivalent to the old `b.page_id IN (...)` filter.
    sqlx::query("UPDATE blocks SET space_id = ? WHERE page_id = ?")
        .bind(space_id)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Insert a block with an explicit `page_id` column value. Required for
/// content blocks under a space-scoped parent — the space filter uses
/// `COALESCE(b.page_id, b.id)` so children must carry the parent's id in
/// `page_id` for the filter to resolve through the parent's `space`
/// property.
async fn insert_block_with_page_id(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: Option<i64>,
    page_id: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(content)
    .bind(parent_id)
    .bind(position)
    .bind(page_id)
    .execute(pool)
    .await
    .unwrap();
    // #533: a block inherits the denormalized `space_id` of its owning
    // page (mirrors production `set_block_space_id_from_parent`), so tests
    // that assign the page's space before inserting children still resolve.
    sqlx::query("UPDATE blocks SET space_id = (SELECT p.space_id FROM blocks p WHERE p.id = ?) WHERE id = ?")
        .bind(page_id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn list_by_type_pages_filters_by_space() {
    let (pool, _dir) = test_pool().await;
    insert_space_block(&pool, SPACE_A_ID, "Personal").await;
    insert_space_block(&pool, SPACE_B_ID, "Work").await;

    // Three non-space pages: two in SPACE_A, one in SPACE_B.
    insert_block(&pool, "PAGE_AA1", "page", "Page A1", None, None).await;
    assign_to_space(&pool, "PAGE_AA1", SPACE_A_ID).await;
    insert_block(&pool, "PAGE_AA2", "page", "Page A2", None, None).await;
    assign_to_space(&pool, "PAGE_AA2", SPACE_A_ID).await;
    insert_block(&pool, "PAGE_BB1", "page", "Page B1", None, None).await;
    assign_to_space(&pool, "PAGE_BB1", SPACE_B_ID).await;

    let req = PageRequest::new(None, Some(50)).unwrap();
    let resp = list_by_type(&pool, "page", &req, Some(SPACE_A_ID))
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        2,
        "SPACE_A filter must return exactly the 2 pages assigned to it \
         (space blocks themselves carry `is_space`, not `space`, so are excluded)"
    );
    let ids: Vec<&str> = resp.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        ids.contains(&"PAGE_AA1"),
        "PAGE_AA1 (SPACE_A) must appear; got {ids:?}"
    );
    assert!(
        ids.contains(&"PAGE_AA2"),
        "PAGE_AA2 (SPACE_A) must appear; got {ids:?}"
    );
    assert!(
        !ids.contains(&"PAGE_BB1"),
        "PAGE_BB1 (SPACE_B) must not appear; got {ids:?}"
    );
}

#[tokio::test]
async fn list_by_type_pages_nonexistent_space_returns_empty() {
    let (pool, _dir) = test_pool().await;
    insert_space_block(&pool, SPACE_A_ID, "Personal").await;
    insert_block(&pool, "PAGE_AA1", "page", "Page A1", None, None).await;
    assign_to_space(&pool, "PAGE_AA1", SPACE_A_ID).await;

    let req = PageRequest::new(None, Some(50)).unwrap();
    let resp = list_by_type(&pool, "page", &req, Some("NONEXISTENT_SPACE"))
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        0,
        "nonexistent space id must return zero rows, not error"
    );
    assert!(!resp.has_more, "empty result must not indicate more pages");
    assert!(
        resp.next_cursor.is_none(),
        "empty result must have no cursor"
    );
}

#[tokio::test]
async fn list_by_type_pages_none_space_id_unscoped() {
    let (pool, _dir) = test_pool().await;
    insert_space_block(&pool, SPACE_A_ID, "Personal").await;
    insert_space_block(&pool, SPACE_B_ID, "Work").await;
    insert_block(&pool, "PAGE_AA1", "page", "Page A1", None, None).await;
    assign_to_space(&pool, "PAGE_AA1", SPACE_A_ID).await;
    insert_block(&pool, "PAGE_AA2", "page", "Page A2", None, None).await;
    assign_to_space(&pool, "PAGE_AA2", SPACE_A_ID).await;
    insert_block(&pool, "PAGE_BB1", "page", "Page B1", None, None).await;
    assign_to_space(&pool, "PAGE_BB1", SPACE_B_ID).await;

    let req = PageRequest::new(None, Some(50)).unwrap();
    let resp = list_by_type(&pool, "page", &req, None).await.unwrap();

    // 2 space blocks + 3 non-space pages = 5 `block_type = 'page'` rows.
    assert_eq!(
        resp.items.len(),
        5,
        "None space_id must return every page (2 spaces + 3 pages) — \
         existing unscoped behaviour is preserved"
    );
}

#[tokio::test]
async fn list_children_filters_by_space() {
    let (pool, _dir) = test_pool().await;
    insert_space_block(&pool, SPACE_A_ID, "Personal").await;
    insert_space_block(&pool, SPACE_B_ID, "Work").await;

    // Parent page in SPACE_A with two content-block children. Children
    // carry `page_id = parent_id` so the COALESCE(page_id, id) lookup
    // resolves to the parent — which carries `space = SPACE_A`.
    insert_block(&pool, "PARENT_A", "page", "Parent", None, Some(1)).await;
    assign_to_space(&pool, "PARENT_A", SPACE_A_ID).await;
    insert_block_with_page_id(
        &pool,
        "CHLD_AA1",
        "content",
        "child 1",
        Some("PARENT_A"),
        Some(1),
        Some("PARENT_A"),
    )
    .await;
    insert_block_with_page_id(
        &pool,
        "CHLD_AA2",
        "content",
        "child 2",
        Some("PARENT_A"),
        Some(2),
        Some("PARENT_A"),
    )
    .await;

    let req_a = PageRequest::new(None, Some(50)).unwrap();
    let resp_a = list_children(&pool, Some("PARENT_A"), &req_a, Some(SPACE_A_ID))
        .await
        .unwrap();
    assert_eq!(
        resp_a.items.len(),
        2,
        "SPACE_A filter must match the 2 children via their parent's space property"
    );
    let ids: Vec<&str> = resp_a.items.iter().map(|b| b.id.as_str()).collect();
    assert!(
        ids.contains(&"CHLD_AA1") && ids.contains(&"CHLD_AA2"),
        "both children must appear; got {ids:?}"
    );

    let req_b = PageRequest::new(None, Some(50)).unwrap();
    let resp_b = list_children(&pool, Some("PARENT_A"), &req_b, Some(SPACE_B_ID))
        .await
        .unwrap();
    assert_eq!(
        resp_b.items.len(),
        0,
        "SPACE_B filter must exclude children whose parent lives in SPACE_A"
    );
}

#[tokio::test]
async fn list_children_excludes_cross_space_page_ids() {
    let (pool, _dir) = test_pool().await;
    insert_space_block(&pool, SPACE_A_ID, "Personal").await;
    insert_space_block(&pool, SPACE_B_ID, "Work").await;

    // Two top-level pages (parent_id IS NULL) — one per space — each
    // with a child content block.
    insert_block(&pool, "PAR_A", "page", "Parent A", None, Some(10)).await;
    assign_to_space(&pool, "PAR_A", SPACE_A_ID).await;
    insert_block_with_page_id(
        &pool,
        "CHD_A1",
        "content",
        "c a1",
        Some("PAR_A"),
        Some(1),
        Some("PAR_A"),
    )
    .await;

    insert_block(&pool, "PAR_B", "page", "Parent B", None, Some(11)).await;
    assign_to_space(&pool, "PAR_B", SPACE_B_ID).await;
    insert_block_with_page_id(
        &pool,
        "CHD_B1",
        "content",
        "c b1",
        Some("PAR_B"),
        Some(1),
        Some("PAR_B"),
    )
    .await;

    // `parent_id = None` → top-level query. SPACE_A filter must only
    // surface PAR_A. The two space blocks themselves are also
    // parent_id IS NULL but carry `is_space`, not `space`, so are
    // excluded. PAR_B belongs to SPACE_B and must be excluded too.
    let req = PageRequest::new(None, Some(50)).unwrap();
    let resp = list_children(&pool, None, &req, Some(SPACE_A_ID))
        .await
        .unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "top-level list with SPACE_A must return exactly the SPACE_A parent"
    );
    assert_eq!(
        resp.items[0].id, "PAR_A",
        "SPACE_A parent is the only expected top-level row"
    );
}

#[tokio::test]
async fn list_trash_filters_by_space() {
    let (pool, _dir) = test_pool().await;
    insert_space_block(&pool, SPACE_A_ID, "Personal").await;
    insert_space_block(&pool, SPACE_B_ID, "Work").await;

    // Two soft-deleted pages, one per space. The space property is set
    // before soft-delete — `list_trash` resolves via
    // `COALESCE(page_id, id)` which is `id` for top-level pages, so
    // the filter remains valid after the delete.
    insert_block(&pool, "TRSH_A", "page", "Trash A", None, None).await;
    assign_to_space(&pool, "TRSH_A", SPACE_A_ID).await;
    soft_delete_block(&pool, "TRSH_A", "2025-02-01T00:00:00+00:00").await;

    insert_block(&pool, "TRSH_B", "page", "Trash B", None, None).await;
    assign_to_space(&pool, "TRSH_B", SPACE_B_ID).await;
    soft_delete_block(&pool, "TRSH_B", "2025-02-02T00:00:00+00:00").await;

    let req = PageRequest::new(None, Some(50)).unwrap();
    let resp = list_trash(&pool, &req, Some(SPACE_A_ID)).await.unwrap();

    assert_eq!(
        resp.items.len(),
        1,
        "SPACE_A filter on trash must return exactly the SPACE_A deleted page"
    );
    assert_eq!(
        resp.items[0].id, "TRSH_A",
        "SPACE_A trash row must be TRSH_A"
    );
}

// ====================================================================
// FEAT-3 Phase 8 — list_page_history space scoping
// ====================================================================
//
// `list_page_history(page_id, op_type_filter, space_id, page)` gains a new
// `space_id` parameter that filters the global (`page_id == "__all__"`)
// query to only the ops whose `payload.block_id` belongs to the requested
// space. When `space_id` is `None`, behaviour is identical to before
// (all ops). When `page_id` is a real ULID (per-page mode), `space_id`
// is ignored — the existing recursive CTE already scopes to a single
// space because every page belongs to exactly one space.

mod tests_p8 {
    use super::super::*;
    use super::{
        SPACE_A_ID, SPACE_B_ID, assign_to_space, insert_block, insert_op_log_entry,
        insert_space_block, test_pool,
    };
    use sqlx::SqlitePool;

    /// Seed a tiny corpus across two spaces:
    ///
    /// - SPACE_A_ID (Personal) — page `PG_AA` with one op.
    /// - SPACE_B_ID (Work)     — page `PG_BB` with one op.
    ///
    /// Ops are appended to `op_log` with a payload that refers to the
    /// page block_id directly (mirrors how the materializer records
    /// `create_block` for a page).
    async fn seed_two_spaces(pool: &SqlitePool) {
        insert_space_block(pool, SPACE_A_ID, "Personal").await;
        insert_space_block(pool, SPACE_B_ID, "Work").await;

        // SPACE_A page + op
        insert_block(pool, "PG_AA", "page", "Personal page", None, Some(1)).await;
        assign_to_space(pool, "PG_AA", SPACE_A_ID).await;
        let payload_a = r#"{"block_id":"PG_AA","block_type":"page","content":"Personal page"}"#;
        insert_op_log_entry(
            pool,
            "device-1",
            1,
            "create_block",
            payload_a,
            "2025-01-01T00:00:00Z",
        )
        .await;

        // SPACE_B page + op
        insert_block(pool, "PG_BB", "page", "Work page", None, Some(2)).await;
        assign_to_space(pool, "PG_BB", SPACE_B_ID).await;
        let payload_b = r#"{"block_id":"PG_BB","block_type":"page","content":"Work page"}"#;
        insert_op_log_entry(
            pool,
            "device-1",
            2,
            "create_block",
            payload_b,
            "2025-01-02T00:00:00Z",
        )
        .await;
    }

    /// Baseline: `space_id = None` and `page_id = "__all__"` returns every
    /// op (existing "All spaces" behaviour). This is the path the new
    /// "All spaces" toggle exercises in the UI.
    #[tokio::test]
    async fn list_page_history_all_pages_all_spaces_returns_every_op() {
        let (pool, _dir) = test_pool().await;
        seed_two_spaces(&pool).await;

        let page = PageRequest::new(None, Some(50)).unwrap();
        let resp = list_page_history(&pool, "__all__", None, None, &page)
            .await
            .unwrap();

        assert_eq!(
            resp.items.len(),
            2,
            "space_id = None must return ops from every space (baseline)"
        );
        let block_ids: Vec<String> = resp
            .items
            .iter()
            .map(|e| {
                let payload: serde_json::Value = serde_json::from_str(&e.payload).unwrap();
                payload["block_id"].as_str().unwrap().to_string()
            })
            .collect();
        assert!(
            block_ids.iter().any(|id| id == "PG_AA"),
            "PG_AA (SPACE_A) must appear; got {block_ids:?}"
        );
        assert!(
            block_ids.iter().any(|id| id == "PG_BB"),
            "PG_BB (SPACE_B) must appear; got {block_ids:?}"
        );
    }

    /// New behaviour: `space_id = Some(SPACE_A_ID)` and `page_id = "__all__"`
    /// must drop ops on pages outside SPACE_A — the count differs from the
    /// baseline by exactly the foreign-space ops.
    #[tokio::test]
    async fn list_page_history_all_pages_current_space_excludes_foreign_ops() {
        let (pool, _dir) = test_pool().await;
        seed_two_spaces(&pool).await;

        let page = PageRequest::new(None, Some(50)).unwrap();
        let unfiltered = list_page_history(&pool, "__all__", None, None, &page)
            .await
            .unwrap();
        let filtered = list_page_history(&pool, "__all__", None, Some(SPACE_A_ID), &page)
            .await
            .unwrap();

        // The corpus has exactly 1 foreign-space op (PG_BB on SPACE_B), so
        // filtered must drop exactly that op.
        assert_eq!(
            unfiltered.items.len() - filtered.items.len(),
            1,
            "filtered result must differ from unfiltered by exactly the foreign-space op count"
        );
        assert_eq!(
            filtered.items.len(),
            1,
            "SPACE_A filter must keep only the SPACE_A op"
        );
        let payload: serde_json::Value = serde_json::from_str(&filtered.items[0].payload).unwrap();
        assert_eq!(
            payload["block_id"].as_str().unwrap(),
            "PG_AA",
            "remaining op must be the SPACE_A op"
        );
    }

    /// `space_id` is ignored when `page_id` is a real ULID (per-page
    /// mode). The page itself belongs to exactly one space, so the
    /// existing recursive CTE already scopes correctly — passing a
    /// foreign `space_id` must NOT silently drop the page's own ops.
    #[tokio::test]
    async fn list_page_history_per_page_mode_ignores_space_id() {
        let (pool, _dir) = test_pool().await;
        seed_two_spaces(&pool).await;

        let page = PageRequest::new(None, Some(50)).unwrap();

        // Query PG_AA (SPACE_A page) but pass SPACE_B_ID as the filter.
        // Per-page mode must ignore `space_id` — the result must match
        // the same query with `space_id = None`.
        let with_foreign_space = list_page_history(&pool, "PG_AA", None, Some(SPACE_B_ID), &page)
            .await
            .unwrap();
        let without_space = list_page_history(&pool, "PG_AA", None, None, &page)
            .await
            .unwrap();

        assert_eq!(
            with_foreign_space.items.len(),
            without_space.items.len(),
            "per-page mode must ignore space_id; foreign space filter must not drop ops"
        );
        assert_eq!(
            with_foreign_space.items.len(),
            1,
            "PG_AA's own create_block op must remain present"
        );
        let payload: serde_json::Value =
            serde_json::from_str(&with_foreign_space.items[0].payload).unwrap();
        assert_eq!(
            payload["block_id"].as_str().unwrap(),
            "PG_AA",
            "per-page mode returns the page's own op even with a foreign space_id"
        );
    }
}

// ====================================================================
// FEAT-3 Phase 7 — cross-space link enforcement
// ====================================================================
//
// `batch_resolve_inner(ids, space_id)` and `get_page_inner(page_id,
// space_id, ...)` both gain a required `space_id` parameter that
// enforces space membership. The locked-in policy is "no live links
// between spaces, ever":
//
//   - `batch_resolve_inner` filters foreign-space targets out of the
//     result set so the chip falls into the "unknown id" branch on the
//     frontend → broken-link UX. Same `COALESCE(b.page_id, b.id) IN
//     (SELECT bp.block_id FROM block_properties bp WHERE bp.key='space'
//     AND bp.value_ref = ?)` filter shipped in Phase 2 for list paths.
//   - `get_page_inner` rejects with `AppError::Validation` when the
//     requested page's `space` property does not match `space_id` so
//     deep-linking into a foreign page from a different space's tab
//     stack is impossible.
//
// `list_block_history` (different from `list_page_history` — see
// `pagination::history`) is intentionally left unscoped: per-block
// history viewing is allowed across spaces (it's an admin/diagnostics
// surface, not a user-facing navigation entry-point). The umbrella
// FEAT-3 design explicitly carves it out.

mod tests_p7 {
    use super::{
        SPACE_A_ID, SPACE_B_ID, assign_to_space, insert_block, insert_block_with_page_id,
        insert_space_block, test_pool,
    };
    use crate::commands::{batch_resolve_inner, get_page_inner};
    use crate::error::AppError;
    use crate::space::{SpaceId, SpaceScope};

    /// Synthetic third space — required by the property-style regression
    /// test below to model "more than two spaces" without depending on
    /// the bootstrap-seeded Personal/Work pair.
    const SPACE_C_ID: &str = "SPACE_CC";

    /// Test 1 — cross-space resolution: a chip whose target lives in a
    /// foreign space silently drops out of the resolution result. The
    /// frontend's `useResolveStore` then renders the chip via the
    /// "unknown id" branch (broken-link UX).
    #[tokio::test]
    async fn batch_resolve_excludes_foreign_space_pages() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;
        insert_space_block(&pool, SPACE_B_ID, "Work").await;

        // One page per space.
        insert_block(&pool, "PG_A", "page", "Personal page", None, Some(1)).await;
        assign_to_space(&pool, "PG_A", SPACE_A_ID).await;
        insert_block(&pool, "PG_B", "page", "Work page", None, Some(2)).await;
        assign_to_space(&pool, "PG_B", SPACE_B_ID).await;

        // From inside SPACE_A, asking to resolve both PG_A and PG_B must
        // return PG_A only — PG_B is in a foreign space and falls out.
        let resolved = batch_resolve_inner(
            &pool,
            vec!["PG_A".into(), "PG_B".into()],
            &SpaceScope::Active(SpaceId::from_trusted(SPACE_A_ID)),
        )
        .await
        .unwrap();

        assert_eq!(
            resolved.len(),
            1,
            "exactly the SPACE_A page must surface; foreign target must be silently dropped"
        );
        assert_eq!(
            resolved[0].id, "PG_A",
            "the surviving entry must be the SPACE_A page"
        );
        assert!(
            !resolved.iter().any(|r| r.id == "PG_B"),
            "PG_B (foreign space) MUST NOT appear in the result"
        );
    }

    /// Test 2 — `get_page_inner` rejects deep-link/page-fetch attempts
    /// that cross a space boundary with `AppError::Validation`.
    #[tokio::test]
    async fn get_page_rejects_foreign_space_target() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;
        insert_space_block(&pool, SPACE_B_ID, "Work").await;

        insert_block(
            &pool,
            "01PAGEA0NKY00000000000000A",
            "page",
            "Personal-only",
            None,
            Some(1),
        )
        .await;
        assign_to_space(&pool, "01PAGEA0NKY00000000000000A", SPACE_A_ID).await;

        // Same-space fetch must succeed (sanity check the happy path
        // before testing the foreign-space branch).
        let ok = get_page_inner(
            &pool,
            "01PAGEA0NKY00000000000000A",
            SPACE_A_ID,
            None,
            Some(10),
        )
        .await
        .expect("same-space fetch must succeed");
        assert_eq!(ok.page.id, "01PAGEA0NKY00000000000000A");

        // Foreign-space fetch must be rejected.
        let err = get_page_inner(
            &pool,
            "01PAGEA0NKY00000000000000A",
            SPACE_B_ID,
            None,
            Some(10),
        )
        .await
        .expect_err("foreign-space fetch must be rejected");
        assert!(
            matches!(err, AppError::Validation(_)),
            "foreign-space rejection must be Validation, got {err:?}"
        );
    }

    /// Test 3 — there is no `get_block_with_children_inner` in this
    /// codebase. The single-block-with-subtree fetch surface is
    /// `get_page_inner` (the page editor / deep-link / journal nav
    /// entry-point). Bare `get_block_inner` returns a single row (no
    /// subtree) and is used by MCP / undo / batch-resolve paths where
    /// space scoping is enforced upstream.
    ///
    /// To keep the FEAT-3p7 contract honest we cover the related
    /// regression — a page that has no `space` property at all (legacy
    /// pre-Phase-2 vault content that bypassed bootstrap somehow) is
    /// also rejected by `get_page_inner` regardless of the requested
    /// space, because no row matches the membership subquery.
    #[tokio::test]
    async fn get_page_rejects_unscoped_target() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;

        // Page with NO space property — represents legacy / corrupted
        // state. The membership query has nothing to match on.
        insert_block(
            &pool,
            "01PAGENSPACE000000000000NS",
            "page",
            "Unscoped",
            None,
            Some(1),
        )
        .await;

        let err = get_page_inner(
            &pool,
            "01PAGENSPACE000000000000NS",
            SPACE_A_ID,
            None,
            Some(10),
        )
        .await
        .expect_err("unscoped page must be rejected from any space");
        assert!(
            matches!(err, AppError::Validation(_)),
            "unscoped page must be Validation, got {err:?}"
        );
    }

    /// Test 4 — deterministic property-style regression: 3 spaces × 5
    /// pages each (15 pages) × 2 foreign spaces per page (30 foreign
    /// pairs). Every foreign-space resolution MUST return None and
    /// every foreign-space `get_page_inner` MUST return Validation.
    /// Same-space queries MUST succeed (12 same-space pairs).
    ///
    /// The codebase has `proptest` available but a deterministic walk
    /// is sufficient for this regression — the predicate is a closed-form
    /// "for all (page, space)" assertion, not a search over a large
    /// state-space. Per the user's instruction (FEAT-3p7),
    /// ship the deterministic version for clarity and CI determinism.
    #[tokio::test]
    async fn property_no_cross_space_resolution_or_fetch() {
        let (pool, _dir) = test_pool().await;
        insert_space_block(&pool, SPACE_A_ID, "Personal").await;
        insert_space_block(&pool, SPACE_B_ID, "Work").await;
        insert_space_block(&pool, SPACE_C_ID, "Archive").await;

        let spaces: [&str; 3] = [SPACE_A_ID, SPACE_B_ID, SPACE_C_ID];
        // Seed 5 pages per space. Page IDs encode (space_index,
        // page_index) so failures pinpoint the offending pair.
        let mut all_pages: Vec<(String, &'static str)> = Vec::with_capacity(15);
        for (s_idx, space_id) in spaces.iter().enumerate() {
            for p_idx in 0..5 {
                let page_id = format!("01PAGE0000000000000000S{s_idx}P{p_idx}");
                insert_block(
                    &pool,
                    &page_id,
                    "page",
                    &format!("page {p_idx} in space {s_idx}"),
                    None,
                    Some(p_idx as i64 + 1),
                )
                .await;
                assign_to_space(&pool, &page_id, space_id).await;
                // Add one descendant per page so `get_page_inner`'s
                // subtree walk has something to chew on. The descendant
                // inherits its parent's space via the `page_id` column.
                let child_id = format!("01CHKD0000000000000000S{s_idx}P{p_idx}");
                insert_block_with_page_id(
                    &pool,
                    &child_id,
                    "content",
                    &format!("child of page {p_idx}"),
                    Some(&page_id),
                    Some(1),
                    Some(&page_id),
                )
                .await;
                all_pages.push((page_id, space_id));
            }
        }

        // For every (page, space) pair: same-space succeeds, foreign-space fails.
        for (page_id, owning_space) in &all_pages {
            for candidate_space in spaces.iter() {
                if candidate_space == owning_space {
                    // Same-space — both APIs must succeed.
                    let resolved = batch_resolve_inner(
                        &pool,
                        vec![page_id.clone().into()],
                        &SpaceScope::Active(SpaceId::from_trusted(candidate_space)),
                    )
                    .await
                    .expect("same-space resolve must succeed");
                    assert_eq!(
                        resolved.len(),
                        1,
                        "same-space resolve of {page_id} from {candidate_space} must return the page"
                    );
                    assert_eq!(resolved[0].id, *page_id);

                    let page_resp = get_page_inner(&pool, page_id, candidate_space, None, Some(10))
                        .await
                        .expect("same-space get_page must succeed");
                    assert_eq!(page_resp.page.id, *page_id);
                } else {
                    // Foreign-space — both APIs must reject.
                    let resolved = batch_resolve_inner(
                        &pool,
                        vec![page_id.clone().into()],
                        &SpaceScope::Active(SpaceId::from_trusted(candidate_space)),
                    )
                    .await
                    .expect("foreign-space resolve must not error, just drop the row");
                    assert!(
                        resolved.is_empty(),
                        "foreign-space resolve of {page_id} from {candidate_space} must return empty (got {} entries)",
                        resolved.len()
                    );

                    let err = get_page_inner(&pool, page_id, candidate_space, None, Some(10))
                        .await
                        .expect_err("foreign-space get_page must reject");
                    assert!(
                        matches!(err, AppError::Validation(_)),
                        "foreign-space get_page of {page_id} from {candidate_space} must be Validation, got {err:?}"
                    );
                }
            }
        }
    }
}

// ====================================================================
// Proptest tests
// ====================================================================

mod proptest_tests {
    use super::super::*;
    use proptest::prelude::*;

    /// Strategy for arbitrary Cursor values.
    fn arb_cursor() -> impl Strategy<Value = Cursor> {
        (
            "[a-zA-Z0-9_-]{1,40}",                 // id
            proptest::option::of(0i64..=i64::MAX), // position
            proptest::option::of("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\+00:00"), // deleted_at
            proptest::option::of(1i64..100000),   // seq
            proptest::option::of(-100.0f64..0.0), // rank (FTS ranks are negative)
        )
            .prop_map(|(id, position, deleted_at, seq, rank)| Cursor {
                id,
                position,
                deleted_at,
                seq,
                rank,
            })
    }

    proptest! {
        /// Cursor encode/decode is a perfect round-trip for any valid cursor.
        #[test]
        fn cursor_encode_decode_roundtrip(cursor in arb_cursor()) {
            let encoded = cursor.encode().expect("encode must succeed");
            let decoded = Cursor::decode(&encoded).expect("decode must succeed");
            prop_assert_eq!(&cursor.id, &decoded.id);
            prop_assert_eq!(cursor.position, decoded.position);
            prop_assert_eq!(&cursor.deleted_at, &decoded.deleted_at);
            prop_assert_eq!(cursor.seq, decoded.seq);
            // Compare rank with tolerance for floating-point
            match (cursor.rank, decoded.rank) {
                (Some(a), Some(b)) => prop_assert!((a - b).abs() < 1e-9,
                    "rank mismatch: {} vs {}", a, b),
                (None, None) => {}
                _ => prop_assert!(false, "rank Some/None mismatch"),
            }
        }

        /// Encoding is deterministic: the same cursor always produces the same string.
        #[test]
        fn cursor_encode_deterministic(cursor in arb_cursor()) {
            let enc1 = cursor.encode().unwrap();
            let enc2 = cursor.encode().unwrap();
            prop_assert_eq!(&enc1, &enc2, "encoding must be deterministic");
        }
    }
}

// ============================================================================
// MAINT-113 M1.5 — ActiveBlockRow + ActiveProjectedAgendaEntry conversions
// ============================================================================

mod active_row_conversions {
    use super::*;
    use crate::ulid::{ActiveBlockId, BlockId};

    /// Build a non-trivial `ActiveBlockRow` covering every field. The data
    /// is intentionally noisy so any field-reordering in `From<ActiveBlockRow>
    /// for BlockRow` would surface as a mismatched assertion.
    fn fixture_active_row() -> ActiveBlockRow {
        ActiveBlockRow {
            id: ActiveBlockId::test_id("ACTROW01"),
            block_type: "content".to_string(),
            content: Some("hello".to_string()),
            parent_id: Some(BlockId::test_id("PAR_ABC")),
            position: Some(42),
            deleted_at: Some(1_704_067_200_000),
            todo_state: Some("TODO".to_string()),
            priority: Some("A".to_string()),
            due_date: Some("2024-12-31".to_string()),
            scheduled_date: Some("2024-12-25".to_string()),
            page_id: Some(BlockId::test_id("PAGE_XYZ")),
        }
    }

    /// Pin the always-safe `From<ActiveProjectedAgendaEntry> for
    /// ProjectedAgendaEntry` conversion. Same rationale as
    /// `from_active_block_row_preserves_every_field` — the
    /// `gcal_push::connector` downcast feeds the digest pipeline through
    /// this exact path, one entry at a time.
    #[test]
    fn from_active_projected_agenda_entry_preserves_every_field() {
        let active = ActiveProjectedAgendaEntry {
            block: fixture_active_row(),
            projected_date: "2024-12-25".to_string(),
            source: "due_date".to_string(),
        };

        let raw: ProjectedAgendaEntry = active.clone().into();

        assert_eq!(raw.block.id, active.block.id.as_str());
        assert_eq!(raw.block.block_type, active.block.block_type);
        assert_eq!(raw.projected_date, active.projected_date);
        assert_eq!(raw.source, active.source);
    }

    /// `from_block_row_unchecked` must apply the same uppercase
    /// normalisation contract as `BlockId::from_trusted` (AGENTS.md
    /// invariant #8). A lowercase ULID handed in must round-trip to
    /// canonical uppercase Crockford base32 so blake3 hashing stays
    /// deterministic if the value is later persisted.
    #[test]
    fn from_block_row_unchecked_uppercases_id() {
        let row = BlockRow {
            id: BlockId::from_trusted("01arz3ndektsv4rrffq69g5fav"), // lowercase ULID
            block_type: "content".to_string(),
            content: None,
            parent_id: None,
            position: None,
            deleted_at: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: None,
        };
        let active = ActiveBlockRow::from_block_row_unchecked(row);
        assert_eq!(
            active.id.as_str(),
            "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "from_block_row_unchecked must normalise the id to uppercase \
             via from_trusted_active",
        );
    }
}

#[tokio::test]
async fn test_list_unfinished_tasks_empty() {
    let (pool, _temp_dir) = test_pool().await;
    let page = PageRequest::new(None, None).unwrap();
    let states = vec!["TODO".to_string(), "DOING".to_string()];
    let res = super::tasks::list_unfinished_tasks(&pool, "2024-01-01", &states, &page, None)
        .await
        .unwrap();
    assert!(res.items.is_empty());
}

/// T1 (#349): exhaustive multi-page keyset walk of `list_unfinished_tasks`.
///
/// The keyset path (DESC ordering on `COALESCE(due_date, scheduled_date)`
/// with an `id DESC` tiebreak, plus the side-vector `sort_dates`
/// truncation) was previously only exercised by the empty-result test.
/// This walks every page at `limit = 3` over 13 tasks that deliberately
/// include:
///   - duplicate `COALESCE(due, scheduled)` dates (forcing the `id DESC`
///     tiebreak to drive ordering across a page boundary),
///   - mixed NULLs (due-only, scheduled-only — so COALESCE picks the
///     non-NULL column), and
///   - both `TODO` and `DOING` states.
/// Asserts: no duplicates, no gaps (every admitted task appears exactly
/// once), and a globally non-increasing `(sort_date, id)` ordering that is
/// stable across page boundaries.
#[tokio::test]
async fn list_unfinished_tasks_exhaustive_walk_no_dupes_or_gaps() {
    let (pool, _dir) = test_pool().await;

    // (id, due_date, scheduled_date, todo_state). NULLs are mixed; several
    // rows share the same COALESCE(due, scheduled) date so the id-DESC
    // tiebreak is the only ordering discriminator within a date bucket.
    let tasks: [(&str, Option<&str>, Option<&str>, &str); 13] = [
        ("UFTASK001", Some("2025-01-10"), None, "TODO"),
        ("UFTASK002", Some("2025-01-10"), None, "DOING"), // dup date w/ 001
        ("UFTASK003", None, Some("2025-01-10"), "TODO"),  // dup via scheduled
        ("UFTASK004", Some("2025-01-09"), Some("2025-01-01"), "TODO"), // due wins
        ("UFTASK005", Some("2025-01-09"), None, "DOING"), // dup date w/ 004
        ("UFTASK006", None, Some("2025-01-08"), "TODO"),
        ("UFTASK007", Some("2025-01-08"), None, "DOING"), // dup date w/ 006
        ("UFTASK008", Some("2025-01-08"), None, "TODO"),  // dup date w/ 006,007
        ("UFTASK009", None, Some("2025-01-07"), "DOING"),
        ("UFTASK010", Some("2025-01-06"), None, "TODO"),
        ("UFTASK011", Some("2025-01-05"), Some("2025-01-12"), "DOING"), // due wins
        ("UFTASK012", None, Some("2025-01-05"), "TODO"),                // dup w/ 011
        ("UFTASK013", Some("2025-01-04"), None, "TODO"),
    ];

    for (id, due, sched, state) in &tasks {
        insert_block(&pool, id, "content", &format!("task {id}"), None, None).await;
        sqlx::query(
            "UPDATE blocks SET due_date = ?, scheduled_date = ?, todo_state = ? WHERE id = ?",
        )
        .bind(due)
        .bind(sched)
        .bind(state)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }

    // `before_date` past every task's sort date so all 13 admit
    // (admission is `due < before OR scheduled < before`).
    let states = vec!["TODO".to_string(), "DOING".to_string()];
    let mut collected: Vec<(String, String)> = Vec::new(); // (sort_date, id)
    let mut cursor = None;
    let mut page_count = 0;
    loop {
        let page = PageRequest::new(cursor, Some(3)).unwrap();
        let resp = super::tasks::list_unfinished_tasks(&pool, "2025-12-31", &states, &page, None)
            .await
            .unwrap();
        for item in &resp.items {
            // Reconstruct the SQL sort key COALESCE(due, scheduled).
            let sort_date = item
                .due_date
                .clone()
                .or_else(|| item.scheduled_date.clone())
                .expect("each admitted task has at least one date");
            collected.push((sort_date, item.id.as_str().to_string()));
        }
        page_count += 1;
        if !resp.has_more {
            assert!(
                resp.next_cursor.is_none(),
                "last page must not carry a cursor"
            );
            break;
        }
        cursor = resp.next_cursor;
        assert!(page_count < 20, "walk failed to terminate");
    }

    // No gaps: every seeded task appears exactly once.
    let mut ids: Vec<&str> = collected.iter().map(|(_, id)| id.as_str()).collect();
    ids.sort_unstable();
    let mut expected: Vec<&str> = tasks.iter().map(|(id, ..)| *id).collect();
    expected.sort_unstable();
    assert_eq!(ids, expected, "exhaustive walk must return every task once");

    // No duplicates.
    let unique: std::collections::HashSet<&str> = ids.iter().copied().collect();
    assert_eq!(unique.len(), ids.len(), "no task may appear twice");

    // Stable ordering across page boundaries: globally non-increasing on
    // (sort_date DESC, id DESC) — exactly the SQL ORDER BY.
    for win in collected.windows(2) {
        let (a, b) = (&win[0], &win[1]);
        assert!(
            a >= b,
            "ordering must be non-increasing on (sort_date, id): {a:?} then {b:?}"
        );
    }

    assert!(
        page_count >= 5,
        "13 tasks at limit 3 should span at least 5 pages, got {page_count}"
    );
}

// ====================================================================
// SQL-review §5.3 — migration 0066 (COALESCE-removal backfill)
// ====================================================================
//
// NOTE: the plan body named this migration 0065; H-2 claimed 0065 first
// (`0065_page_link_cache.sql`), so §5.3 bumped to 0066.

#[tokio::test]
async fn blocks_page_id_for_pages_post_migration_0066() {
    let (pool, _dir) = test_pool().await;

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', ?, NULL, 1, NULL)",
    )
    .bind("LEGACY_PAGE_NULL")
    .bind("legacy")
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query("UPDATE blocks SET page_id = id WHERE block_type = 'page' AND page_id IS NULL")
        .execute(&pool)
        .await
        .unwrap();

    let null_pages: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks WHERE block_type = 'page' AND page_id IS NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        null_pages, 0,
        "migration 0066: no page block may have NULL page_id"
    );

    let backfilled: Option<String> =
        sqlx::query_scalar("SELECT page_id FROM blocks WHERE id = 'LEGACY_PAGE_NULL'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(backfilled.as_deref(), Some("LEGACY_PAGE_NULL"));
}

#[tokio::test]
async fn space_filter_does_not_scan_blocks_post_section_5_3() {
    let (pool, _dir) = test_pool().await;

    let plans: &[(&str, &str)] = &[
        (
            "list_backlinks-shape",
            "EXPLAIN QUERY PLAN \
             SELECT b.id, b.page_id \
             FROM block_links bl \
             JOIN blocks b ON b.id = bl.source_id \
             WHERE bl.target_id = ?1 AND b.deleted_at IS NULL \
               AND (?2 IS NULL OR b.page_id IN ( \
                    SELECT bp.block_id FROM block_properties bp \
                    WHERE bp.key = 'space' AND bp.value_ref = ?2))",
        ),
        (
            "list_by_type-shape",
            "EXPLAIN QUERY PLAN \
             SELECT b.id, b.page_id \
             FROM blocks b \
             WHERE block_type = ?1 AND deleted_at IS NULL \
               AND (?2 IS NULL OR b.page_id IN ( \
                    SELECT bp.block_id FROM block_properties bp \
                    WHERE bp.key = 'space' AND bp.value_ref = ?2))",
        ),
    ];

    for (label, sql) in plans {
        let plan_rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(sqlx::AssertSqlSafe(*sql))
            .bind("PLACEHOLDER_1")
            .bind(Some("PLACEHOLDER_2"))
            .fetch_all(&pool)
            .await
            .unwrap_or_else(|e| panic!("EXPLAIN QUERY PLAN ({label}) failed: {e}"));

        let plan_text = plan_rows
            .iter()
            .map(|(_, _, _, detail)| detail.as_str())
            .collect::<Vec<_>>()
            .join("\n");

        let bad = plan_text.lines().any(|line| {
            let trimmed = line.trim_start();
            (trimmed.starts_with("SCAN b ")
                || trimmed == "SCAN b"
                || trimmed.starts_with("SCAN blocks ")
                || trimmed == "SCAN blocks")
                && !line.contains("USING")
        });
        assert!(
            !bad,
            "post-§5.3 space-filter SQL ({label}) must not fall back to a \
             full SCAN of `blocks`. Got plan:\n{plan_text}"
        );
    }
}

#[tokio::test]
async fn space_filter_pre_and_post_section_5_3_match() {
    let (pool, _dir) = test_pool().await;

    const SPACE_X: &str = "SPACE_XX";
    const PAGE_IN_X: &str = "PAGE_IN_XX";
    const PAGE_NO_SPACE: &str = "PAGE_NO_SPACE";
    const CHILD_IN_X: &str = "CHILD_IN_XX";
    const CHILD_OUT: &str = "CHILD_OUT_XX";

    insert_block(&pool, SPACE_X, "page", "X", None, Some(1)).await;
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
    )
    .bind(SPACE_X)
    .execute(&pool)
    .await
    .unwrap();

    insert_block(&pool, PAGE_IN_X, "page", "In X", None, Some(2)).await;

    insert_block(&pool, PAGE_NO_SPACE, "page", "Orphan", None, Some(3)).await;

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'content', 'in', ?, 1, ?)",
    )
    .bind(CHILD_IN_X)
    .bind(PAGE_IN_X)
    .bind(PAGE_IN_X)
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'content', 'out', ?, 1, ?)",
    )
    .bind(CHILD_OUT)
    .bind(PAGE_NO_SPACE)
    .bind(PAGE_NO_SPACE)
    .execute(&pool)
    .await
    .unwrap();

    // #534: `space` is column-backed (`blocks.space_id`), the single source of
    // truth — a `block_properties` row for it is CHECK-forbidden. Assign the
    // page and its descendants to the space directly on the column, mirroring
    // the live `space` projection (`WHERE id = ? OR page_id = ?`).
    sqlx::query("UPDATE blocks SET space_id = ? WHERE id = ? OR page_id = ?")
        .bind(SPACE_X)
        .bind(PAGE_IN_X)
        .bind(PAGE_IN_X)
        .execute(&pool)
        .await
        .unwrap();

    let post: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM blocks b \
         WHERE deleted_at IS NULL \
           AND b.space_id = ?1 \
         ORDER BY id ASC",
    )
    .bind(SPACE_X)
    .fetch_all(&pool)
    .await
    .unwrap();

    // Pre-migration phrasing routed space membership through the owning page's
    // `block_properties(key='space')` row; post-§5.3 / #534 it reads the
    // denormalised `blocks.space_id` column. Both must yield the same id set.
    let pre: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM blocks b \
         WHERE deleted_at IS NULL \
           AND COALESCE(b.page_id, b.id) IN ( \
                SELECT p.id FROM blocks p WHERE p.space_id = ?1) \
         ORDER BY id ASC",
    )
    .bind(SPACE_X)
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        post, pre,
        "post-§5.3 `b.space_id = ?` must match the pre-migration \
         `COALESCE(b.page_id, b.id) IN (space pages)` id set (correctness guard)."
    );
    assert!(post.iter().any(|id| id == PAGE_IN_X));
    assert!(post.iter().any(|id| id == CHILD_IN_X));
    assert!(!post.iter().any(|id| id == PAGE_NO_SPACE));
    assert!(!post.iter().any(|id| id == CHILD_OUT));
}
