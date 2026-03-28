//! Cursor-based keyset pagination for block queries.
//!
//! All list queries use cursor/keyset pagination — offset pagination is banned
//! per the ADR.  The cursor is an opaque base64-encoded JSON string.
//!
//! ## Design notes
//!
//! **`total_count` is intentionally omitted** from [`PageResponse`]. Cursor/keyset
//! pagination doesn't require or benefit from a total count (which would need an
//! extra `COUNT(*)` query on every request), and clients detect the end of results
//! via `has_more = false`.
//!
//! **Cursor type**: a single [`Cursor`] struct is used for all query types.  The
//! `position` and `deleted_at` fields are only populated by the queries that key
//! on those columns (`list_children` and `list_trash`, respectively).  This keeps
//! the API surface small and the cursor remains opaque to callers anyway.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Sentinel substituted for NULL `position` in keyset comparisons.
///
/// Children with `position = NULL` (e.g. tag associations) are sorted *after*
/// all positioned siblings.  `i64::MAX` is safe because no real block list will
/// approach 2^63 children, and SQLite natively handles 64-bit signed integers.
const NULL_POSITION_SENTINEL: i64 = i64::MAX;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Row returned by paginated block queries.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct BlockRow {
    pub id: String,
    pub block_type: String,
    pub content: Option<String>,
    pub parent_id: Option<String>,
    pub position: Option<i64>,
    pub deleted_at: Option<String>,
    pub archived_at: Option<String>,
    pub is_conflict: bool,
}

/// Internal cursor for keyset pagination.
/// Opaque to callers; serialised as base64-encoded JSON.
///
/// A single cursor type is shared across all queries:
/// - `position` — set by `list_children` (keyset on `position, id`).
/// - `deleted_at` — set by `list_trash` (keyset on `deleted_at, id`).
/// - `id` — always present; serves as the tie-breaker in every keyset.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Cursor {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

/// Pagination request from the client.
#[derive(Debug, Clone)]
pub struct PageRequest {
    pub after: Option<Cursor>,
    pub limit: i64,
}

/// Paginated response.
///
/// `total_count` is intentionally omitted — see module docs.
#[derive(Debug, Clone, Serialize)]
pub struct PageResponse<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

// ---------------------------------------------------------------------------
// Cursor codec
// ---------------------------------------------------------------------------

impl Cursor {
    /// Encode to opaque base64 representation.
    pub fn encode(&self) -> Result<String, AppError> {
        let json = serde_json::to_string(self)?;
        Ok(URL_SAFE_NO_PAD.encode(json.as_bytes()))
    }

    /// Decode an opaque cursor string.
    pub fn decode(s: &str) -> Result<Self, AppError> {
        let bytes = URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|e| AppError::Validation(format!("invalid cursor: {e}")))?;
        let json = String::from_utf8(bytes)
            .map_err(|e| AppError::Validation(format!("invalid cursor UTF-8: {e}")))?;
        serde_json::from_str(&json)
            .map_err(|e| AppError::Validation(format!("invalid cursor JSON: {e}")))
    }
}

impl PageRequest {
    /// Build a page request, clamping `limit` to \[1, 200\] (default 50).
    pub fn new(after: Option<String>, limit: Option<i64>) -> Result<Self, AppError> {
        let limit = limit.unwrap_or(50).clamp(1, 200);
        let after = match after {
            Some(s) => Some(Cursor::decode(&s)?),
            None => None,
        };
        Ok(Self { after, limit })
    }
}

// ---------------------------------------------------------------------------
// Shared pagination helper
// ---------------------------------------------------------------------------

/// Build a [`PageResponse`] from a result set that fetched `limit + 1` rows.
///
/// The extra row is used solely to detect `has_more`; it is trimmed before
/// returning.  `cursor_from_last` constructs the cursor from the last item on
/// the page.
fn build_page_response<T>(
    mut rows: Vec<T>,
    limit: i64,
    cursor_from_last: impl FnOnce(&T) -> Cursor,
) -> Result<PageResponse<T>, AppError> {
    let has_more = rows.len() as i64 > limit;
    if has_more {
        rows.truncate(limit as usize);
    }
    let next_cursor = if has_more {
        let last = rows.last().expect("has_more implies non-empty");
        Some(cursor_from_last(last).encode()?)
    } else {
        None
    };
    Ok(PageResponse {
        items: rows,
        next_cursor,
        has_more,
    })
}

// ---------------------------------------------------------------------------
// Paginated queries
// ---------------------------------------------------------------------------
//
// Each query uses the `(?N IS NULL OR <keyset-condition>)` pattern so that a
// single SQL statement handles both the first-page (no cursor) and subsequent
// (with cursor) cases.  When `cursor_flag` is NULL the keyset condition
// short-circuits; when it is 1 the condition is evaluated normally.
// This eliminates the duplicated if/else branches that the original code had.

/// List children of `parent_id` (or top-level blocks when `None`), paginated.
///
/// Ordered by `(position ASC, id ASC)`.  Blocks with `NULL` position (e.g. tag
/// children) are sorted *after* all positioned blocks via
/// `IFNULL(position, <sentinel>)`.
///
/// Uses index `idx_blocks_parent(parent_id, deleted_at)`.
pub async fn list_children(
    pool: &SqlitePool,
    parent_id: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, String) = match page.after.as_ref()
    {
        Some(c) => (
            Some(1),
            c.position.unwrap_or(NULL_POSITION_SENTINEL),
            c.id.clone(),
        ),
        None => (None, 0, String::new()),
    };

    // ?6 = NULL_POSITION_SENTINEL, reused in IFNULL() for ORDER BY + keyset.
    let rows = sqlx::query_as::<_, BlockRow>(
        "SELECT id, block_type, content, parent_id, position, \
                deleted_at, archived_at, is_conflict \
         FROM blocks \
         WHERE parent_id IS ?1 AND deleted_at IS NULL \
           AND (?2 IS NULL OR (\
                IFNULL(position, ?6) > ?3 \
                OR (IFNULL(position, ?6) = ?3 AND id > ?4))) \
         ORDER BY IFNULL(position, ?6) ASC, id ASC \
         LIMIT ?5",
    )
    .bind(parent_id) // ?1
    .bind(cursor_flag) // ?2
    .bind(cursor_pos) // ?3
    .bind(&cursor_id) // ?4
    .bind(fetch_limit) // ?5
    .bind(NULL_POSITION_SENTINEL) // ?6
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: Some(last.position.unwrap_or(NULL_POSITION_SENTINEL)),
        deleted_at: None,
    })
}

/// List blocks by `block_type`, paginated.
///
/// Ordered by `id ASC` (ULID ≈ chronological).
/// Uses index `idx_blocks_type(block_type, deleted_at)`.
pub async fn list_by_type(
    pool: &SqlitePool,
    block_type: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, String) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.clone()),
        None => (None, String::new()),
    };

    let rows = sqlx::query_as::<_, BlockRow>(
        "SELECT id, block_type, content, parent_id, position, \
                deleted_at, archived_at, is_conflict \
         FROM blocks \
         WHERE block_type = ?1 AND deleted_at IS NULL \
           AND (?2 IS NULL OR id > ?3) \
         ORDER BY id ASC \
         LIMIT ?4",
    )
    .bind(block_type) // ?1
    .bind(cursor_flag) // ?2
    .bind(&cursor_id) // ?3
    .bind(fetch_limit) // ?4
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
    })
}

/// List soft-deleted blocks (trash view), paginated.
///
/// Ordered by `(deleted_at DESC, id ASC)` — most recently deleted first.
/// Excludes conflict blocks (`is_conflict = 0`).
pub async fn list_trash(
    pool: &SqlitePool,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_del, cursor_id): (Option<i64>, String, String) =
        match page.after.as_ref() {
            Some(c) => (
                Some(1),
                c.deleted_at.clone().unwrap_or_default(),
                c.id.clone(),
            ),
            None => (None, String::new(), String::new()),
        };

    let rows = sqlx::query_as::<_, BlockRow>(
        "SELECT id, block_type, content, parent_id, position, \
                deleted_at, archived_at, is_conflict \
         FROM blocks \
         WHERE deleted_at IS NOT NULL AND is_conflict = 0 \
           AND (?1 IS NULL OR (\
                deleted_at < ?2 OR (deleted_at = ?2 AND id > ?3))) \
         ORDER BY deleted_at DESC, id ASC \
         LIMIT ?4",
    )
    .bind(cursor_flag) // ?1
    .bind(&cursor_del) // ?2
    .bind(&cursor_id) // ?3
    .bind(fetch_limit) // ?4
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: last.deleted_at.clone(),
    })
}

/// List blocks that carry a specific tag, paginated.
///
/// Ordered by `id ASC` (ULID ≈ chronological).
/// Uses index `idx_block_tags_tag(tag_id)`.
pub async fn list_by_tag(
    pool: &SqlitePool,
    tag_id: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, String) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.clone()),
        None => (None, String::new()),
    };

    let rows = sqlx::query_as::<_, BlockRow>(
        "SELECT b.id, b.block_type, b.content, b.parent_id, b.position, \
                b.deleted_at, b.archived_at, b.is_conflict \
         FROM block_tags bt \
         JOIN blocks b ON b.id = bt.block_id \
         WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL \
           AND (?2 IS NULL OR b.id > ?3) \
         ORDER BY b.id ASC \
         LIMIT ?4",
    )
    .bind(tag_id) // ?1
    .bind(cursor_flag) // ?2
    .bind(&cursor_id) // ?3
    .bind(fetch_limit) // ?4
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
    })
}

/// List blocks for a specific date from the agenda cache, paginated.
///
/// Ordered by `block_id ASC` (ULID ≈ chronological).
/// Uses index `idx_agenda_date(date)`.
///
/// `date` must be in `YYYY-MM-DD` format.
pub async fn list_agenda(
    pool: &SqlitePool,
    date: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_id): (Option<i64>, String) = match page.after.as_ref() {
        Some(c) => (Some(1), c.id.clone()),
        None => (None, String::new()),
    };

    let rows = sqlx::query_as::<_, BlockRow>(
        "SELECT b.id, b.block_type, b.content, b.parent_id, b.position, \
                b.deleted_at, b.archived_at, b.is_conflict \
         FROM agenda_cache ac \
         JOIN blocks b ON b.id = ac.block_id \
         WHERE ac.date = ?1 AND b.deleted_at IS NULL \
           AND (?2 IS NULL OR b.id > ?3) \
         ORDER BY b.id ASC \
         LIMIT ?4",
    )
    .bind(date) // ?1
    .bind(cursor_flag) // ?2
    .bind(&cursor_id) // ?3
    .bind(fetch_limit) // ?4
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: None,
    })
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

    // ── helpers ─────────────────────────────────────────────────────────

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn insert_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .bind(position)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_tag_association(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_agenda_entry(pool: &SqlitePool, date: &str, block_id: &str, source: &str) {
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind(date)
            .bind(block_id)
            .bind(source)
            .execute(pool)
            .await
            .unwrap();
    }

    // ====================================================================
    // Cursor unit tests
    // ====================================================================

    #[test]
    fn cursor_encode_decode_roundtrip() {
        let cursor = Cursor {
            id: "01HZ0000000000000000000001".into(),
            position: Some(3),
            deleted_at: None,
        };
        let encoded = cursor.encode().unwrap();
        let decoded = Cursor::decode(&encoded).unwrap();
        assert_eq!(cursor, decoded);
    }

    #[test]
    fn cursor_encode_decode_with_deleted_at() {
        let cursor = Cursor {
            id: "01HZ0000000000000000000001".into(),
            position: None,
            deleted_at: Some("2025-01-15T12:00:00+00:00".into()),
        };
        let encoded = cursor.encode().unwrap();
        let decoded = Cursor::decode(&encoded).unwrap();
        assert_eq!(cursor, decoded);
    }

    #[test]
    fn cursor_decode_invalid_base64() {
        let result = Cursor::decode("not-valid-base64!!!");
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("invalid cursor"));
    }

    #[test]
    fn cursor_special_characters() {
        let cursor = Cursor {
            id: "id-with-émojis-\u{1f389}-and-\"quotes\"".into(),
            position: Some(42),
            deleted_at: Some("2025-06-01T00:00:00+00:00".into()),
        };
        let encoded = cursor.encode().unwrap();
        let decoded = Cursor::decode(&encoded).unwrap();
        assert_eq!(cursor, decoded);
    }

    // ====================================================================
    // PageRequest tests
    // ====================================================================

    #[test]
    fn page_request_defaults() {
        let pr = PageRequest::new(None, None).unwrap();
        assert!(pr.after.is_none());
        assert_eq!(pr.limit, 50);
    }

    #[test]
    fn page_request_clamps_limit() {
        let high = PageRequest::new(None, Some(999)).unwrap();
        assert_eq!(high.limit, 200);

        let low = PageRequest::new(None, Some(-5)).unwrap();
        assert_eq!(low.limit, 1);

        let zero = PageRequest::new(None, Some(0)).unwrap();
        assert_eq!(zero.limit, 1);
    }

    #[test]
    fn page_request_invalid_cursor() {
        // Completely invalid base64
        let result = PageRequest::new(Some("not-a-valid-cursor!!!".into()), Some(10));
        assert!(result.is_err());

        // Valid base64 but not valid JSON
        let bad_json = URL_SAFE_NO_PAD.encode(b"this is not json");
        let result = PageRequest::new(Some(bad_json), Some(10));
        assert!(result.is_err());

        // Valid base64 + valid JSON but missing required `id` field
        let missing_id = URL_SAFE_NO_PAD.encode(b"{\"position\":1}");
        let result = PageRequest::new(Some(missing_id), Some(10));
        assert!(result.is_err());
    }

    // ====================================================================
    // list_children tests
    // ====================================================================

    #[tokio::test]
    async fn list_children_first_page() {
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
        let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();

        assert_eq!(resp.items.len(), 2);
        assert!(resp.has_more);
        assert!(resp.next_cursor.is_some());
        assert_eq!(resp.items[0].id, "CHILD001");
        assert_eq!(resp.items[1].id, "CHILD002");
    }

    #[tokio::test]
    async fn list_children_with_cursor() {
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

        // First page
        let p1 = PageRequest::new(None, Some(2)).unwrap();
        let r1 = list_children(&pool, Some("PARENT01"), &p1).await.unwrap();

        // Second page using cursor from first
        let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
        let r2 = list_children(&pool, Some("PARENT01"), &p2).await.unwrap();

        assert_eq!(r2.items.len(), 2);
        assert!(r2.has_more);
        assert_eq!(r2.items[0].id, "CHILD003");
        assert_eq!(r2.items[1].id, "CHILD004");
    }

    #[tokio::test]
    async fn list_children_last_page() {
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

        // Walk through all pages
        let p1 = PageRequest::new(None, Some(2)).unwrap();
        let r1 = list_children(&pool, Some("PARENT01"), &p1).await.unwrap();

        let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
        let r2 = list_children(&pool, Some("PARENT01"), &p2).await.unwrap();

        let p3 = PageRequest::new(r2.next_cursor, Some(2)).unwrap();
        let r3 = list_children(&pool, Some("PARENT01"), &p3).await.unwrap();

        assert_eq!(r3.items.len(), 1);
        assert!(!r3.has_more);
        assert!(r3.next_cursor.is_none());
        assert_eq!(r3.items[0].id, "CHILD005");
    }

    #[tokio::test]
    async fn list_children_empty() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();

        assert!(resp.items.is_empty());
        assert!(!resp.has_more);
        assert!(resp.next_cursor.is_none());
    }

    #[tokio::test]
    async fn list_children_top_level() {
        let (pool, _dir) = test_pool().await;

        // Two top-level blocks (parent_id = NULL)
        insert_block(&pool, "TOPLVL01", "page", "page 1", None, Some(1)).await;
        insert_block(&pool, "TOPLVL02", "page", "page 2", None, Some(2)).await;
        // A child block — should NOT appear in top-level listing
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
        let resp = list_children(&pool, None, &page).await.unwrap();

        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.items[0].id, "TOPLVL01");
        assert_eq!(resp.items[1].id, "TOPLVL02");
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

        // Soft-delete CHILD002
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-15T00:00:00+00:00' WHERE id = ?")
            .bind("CHILD002")
            .execute(&pool)
            .await
            .unwrap();

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();

        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.items[0].id, "CHILD001");
        assert_eq!(resp.items[1].id, "CHILD003");
    }

    #[tokio::test]
    async fn list_children_null_positions() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        // Positioned children
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
        // NULL-position children (e.g. tags stored as children)
        insert_block(&pool, "TAG00001", "tag", "tag1", Some("PARENT01"), None).await;
        insert_block(&pool, "TAG00002", "tag", "tag2", Some("PARENT01"), None).await;

        // Page 1 (size 2): positioned children come first
        let p1 = PageRequest::new(None, Some(2)).unwrap();
        let r1 = list_children(&pool, Some("PARENT01"), &p1).await.unwrap();
        assert_eq!(r1.items.len(), 2);
        assert!(r1.has_more);
        assert_eq!(r1.items[0].id, "CHILD001");
        assert_eq!(r1.items[1].id, "CHILD002");

        // Page 2: NULL-position children, cursor crosses the boundary correctly
        let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
        let r2 = list_children(&pool, Some("PARENT01"), &p2).await.unwrap();
        assert_eq!(r2.items.len(), 2);
        assert!(!r2.has_more);
        assert_eq!(r2.items[0].id, "TAG00001");
        assert_eq!(r2.items[1].id, "TAG00002");
    }

    #[tokio::test]
    async fn list_children_same_position_tiebreak() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        // Three children all at position 5 — tie-broken by id ASC
        insert_block(&pool, "CHILD_AA", "content", "a", Some("PARENT01"), Some(5)).await;
        insert_block(&pool, "CHILD_BB", "content", "b", Some("PARENT01"), Some(5)).await;
        insert_block(&pool, "CHILD_CC", "content", "c", Some("PARENT01"), Some(5)).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();

        assert_eq!(resp.items.len(), 3);
        assert_eq!(resp.items[0].id, "CHILD_AA");
        assert_eq!(resp.items[1].id, "CHILD_BB");
        assert_eq!(resp.items[2].id, "CHILD_CC");
    }

    #[tokio::test]
    async fn list_children_exhaustive_walk() {
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
            let resp = list_children(&pool, Some("PARENT01"), &page).await.unwrap();
            all_ids.extend(resp.items.iter().map(|b| b.id.clone()));
            if !resp.has_more {
                break;
            }
            cursor = resp.next_cursor;
        }

        // Every child returned exactly once, in order
        let expected: Vec<String> = (1..=13).map(|i| format!("CHILD{i:03}")).collect();
        assert_eq!(all_ids, expected);
    }

    // ====================================================================
    // list_by_type tests
    // ====================================================================

    #[tokio::test]
    async fn list_by_type_returns_only_matching_type() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE0001", "page", "Page 1", None, None).await;
        insert_block(&pool, "PAGE0002", "page", "Page 2", None, None).await;
        insert_block(&pool, "CONT0001", "content", "Content 1", None, None).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_type(&pool, "page", &page).await.unwrap();

        assert_eq!(resp.items.len(), 2);
        assert!(resp.items.iter().all(|b| b.block_type == "page"));
    }

    #[tokio::test]
    async fn list_by_type_with_cursor() {
        let (pool, _dir) = test_pool().await;

        // Insert 5 pages with sorted ids
        for i in 1..=5_i64 {
            let id = format!("PAGE{i:04}");
            insert_block(&pool, &id, "page", &format!("Page {i}"), None, None).await;
        }

        // First page: 2 items
        let p1 = PageRequest::new(None, Some(2)).unwrap();
        let r1 = list_by_type(&pool, "page", &p1).await.unwrap();

        assert_eq!(r1.items.len(), 2);
        assert!(r1.has_more);
        assert_eq!(r1.items[0].id, "PAGE0001");
        assert_eq!(r1.items[1].id, "PAGE0002");

        // Second page via cursor
        let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
        let r2 = list_by_type(&pool, "page", &p2).await.unwrap();

        assert_eq!(r2.items.len(), 2);
        assert!(r2.has_more);
        assert_eq!(r2.items[0].id, "PAGE0003");
        assert_eq!(r2.items[1].id, "PAGE0004");

        // Last page
        let p3 = PageRequest::new(r2.next_cursor, Some(2)).unwrap();
        let r3 = list_by_type(&pool, "page", &p3).await.unwrap();

        assert_eq!(r3.items.len(), 1);
        assert!(!r3.has_more);
        assert!(r3.next_cursor.is_none());
        assert_eq!(r3.items[0].id, "PAGE0005");
    }

    #[tokio::test]
    async fn list_by_type_excludes_soft_deleted() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE0001", "page", "Page 1", None, None).await;
        insert_block(&pool, "PAGE0002", "page", "Page 2", None, None).await;
        insert_block(&pool, "PAGE0003", "page", "Page 3", None, None).await;

        // Soft-delete PAGE0002
        sqlx::query("UPDATE blocks SET deleted_at = '2025-01-15T00:00:00+00:00' WHERE id = ?")
            .bind("PAGE0002")
            .execute(&pool)
            .await
            .unwrap();

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_type(&pool, "page", &page).await.unwrap();

        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.items[0].id, "PAGE0001");
        assert_eq!(resp.items[1].id, "PAGE0003");
    }

    #[tokio::test]
    async fn list_by_type_no_matching_type() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PAGE0001", "page", "Page 1", None, None).await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_type(&pool, "nonexistent_type", &page)
            .await
            .unwrap();

        assert!(resp.items.is_empty());
        assert!(!resp.has_more);
        assert!(resp.next_cursor.is_none());
    }

    // ====================================================================
    // list_trash tests
    // ====================================================================

    #[tokio::test]
    async fn list_trash_returns_deleted_desc_order() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TRASH001", "content", "a", None, None).await;
        insert_block(&pool, "TRASH002", "content", "b", None, None).await;
        insert_block(&pool, "TRASH003", "content", "c", None, None).await;

        // Set deleted_at with known timestamps
        for (id, ts) in [
            ("TRASH001", "2025-01-01T00:00:00+00:00"),
            ("TRASH002", "2025-01-03T00:00:00+00:00"),
            ("TRASH003", "2025-01-02T00:00:00+00:00"),
        ] {
            sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
                .bind(ts)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_trash(&pool, &page).await.unwrap();

        assert_eq!(resp.items.len(), 3);
        // Most recent first: TRASH002 (Jan 3), TRASH003 (Jan 2), TRASH001 (Jan 1)
        assert_eq!(resp.items[0].id, "TRASH002");
        assert_eq!(resp.items[1].id, "TRASH003");
        assert_eq!(resp.items[2].id, "TRASH001");
    }

    #[tokio::test]
    async fn list_trash_with_cursor() {
        let (pool, _dir) = test_pool().await;

        // 5 deleted blocks with distinct timestamps
        for i in 1..=5_i64 {
            let id = format!("TRASH{i:03}");
            insert_block(&pool, &id, "content", &format!("trash {i}"), None, None).await;
            let ts = format!("2025-01-{i:02}T00:00:00+00:00");
            sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
                .bind(&ts)
                .bind(&id)
                .execute(&pool)
                .await
                .unwrap();
        }

        // First page: 2 items (most recent first → TRASH005, TRASH004)
        let p1 = PageRequest::new(None, Some(2)).unwrap();
        let r1 = list_trash(&pool, &p1).await.unwrap();

        assert_eq!(r1.items.len(), 2);
        assert!(r1.has_more);
        assert_eq!(r1.items[0].id, "TRASH005");
        assert_eq!(r1.items[1].id, "TRASH004");

        // Second page via cursor → TRASH003, TRASH002
        let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
        let r2 = list_trash(&pool, &p2).await.unwrap();

        assert_eq!(r2.items.len(), 2);
        assert!(r2.has_more);
        assert_eq!(r2.items[0].id, "TRASH003");
        assert_eq!(r2.items[1].id, "TRASH002");

        // Last page → TRASH001
        let p3 = PageRequest::new(r2.next_cursor, Some(2)).unwrap();
        let r3 = list_trash(&pool, &p3).await.unwrap();

        assert_eq!(r3.items.len(), 1);
        assert!(!r3.has_more);
        assert!(r3.next_cursor.is_none());
        assert_eq!(r3.items[0].id, "TRASH001");
    }

    #[tokio::test]
    async fn list_trash_excludes_conflict_blocks() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "NORMAL01", "content", "normal", None, None).await;
        insert_block(&pool, "CONFLCT1", "content", "conflict", None, None).await;

        // Soft-delete both
        for id in ["NORMAL01", "CONFLCT1"] {
            sqlx::query("UPDATE blocks SET deleted_at = '2025-01-15T00:00:00+00:00' WHERE id = ?")
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }

        // Mark one as a conflict block
        sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = ?")
            .bind("CONFLCT1")
            .execute(&pool)
            .await
            .unwrap();

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_trash(&pool, &page).await.unwrap();

        // Only the non-conflict block appears in trash
        assert_eq!(resp.items.len(), 1);
        assert_eq!(resp.items[0].id, "NORMAL01");
    }

    #[tokio::test]
    async fn list_trash_many_deleted() {
        let (pool, _dir) = test_pool().await;

        // 20 deleted blocks with distinct timestamps (one per second)
        for i in 1..=20_i64 {
            let id = format!("TRASH{i:03}");
            insert_block(&pool, &id, "content", &format!("t{i}"), None, None).await;
            let ts = format!("2025-01-15T12:00:{i:02}+00:00");
            sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
                .bind(&ts)
                .bind(&id)
                .execute(&pool)
                .await
                .unwrap();
        }

        // Walk all pages with small page size
        let mut all_ids = Vec::new();
        let mut cursor = None;
        loop {
            let page = PageRequest::new(cursor, Some(3)).unwrap();
            let resp = list_trash(&pool, &page).await.unwrap();
            all_ids.extend(resp.items.iter().map(|b| b.id.clone()));
            if !resp.has_more {
                break;
            }
            cursor = resp.next_cursor;
        }

        assert_eq!(all_ids.len(), 20);
        // First item should be most recently deleted (TRASH020)
        assert_eq!(all_ids[0], "TRASH020");
        // Last item should be earliest deleted (TRASH001)
        assert_eq!(all_ids[19], "TRASH001");
        // All unique
        let mut deduped = all_ids.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(deduped.len(), 20);
    }

    // ====================================================================
    // Cursor stability tests
    // ====================================================================

    #[tokio::test]
    async fn cursor_stability_after_inserts() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT01", "page", "parent", None, Some(1)).await;
        // Children at positions 2, 4, 6, 8, 10
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
        let p1 = PageRequest::new(None, Some(2)).unwrap();
        let r1 = list_children(&pool, Some("PARENT01"), &p1).await.unwrap();
        assert_eq!(r1.items[0].id, "CHILD001");
        assert_eq!(r1.items[1].id, "CHILD002");
        let saved_cursor = r1.next_cursor.clone();

        // Insert new rows: one before cursor (pos=3), one after (pos=100)
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

        // Use the old cursor — should still skip past CHILD002 (pos=4)
        let p2 = PageRequest::new(saved_cursor, Some(10)).unwrap();
        let r2 = list_children(&pool, Some("PARENT01"), &p2).await.unwrap();

        // Must NOT re-include CHILD001, CHILD002, or NEWCHILD (pos=3 < cursor pos=4)
        let ids: Vec<&str> = r2.items.iter().map(|b| b.id.as_str()).collect();
        assert!(!ids.contains(&"CHILD001"));
        assert!(!ids.contains(&"CHILD002"));
        assert!(!ids.contains(&"NEWCHILD"));
        // Must include remaining children + new one at pos=100
        assert!(ids.contains(&"CHILD003"));
        assert!(ids.contains(&"CHILD004"));
        assert!(ids.contains(&"CHILD005"));
        assert!(ids.contains(&"NEWCHLD2"));
    }

    // ====================================================================
    // list_by_tag tests
    // ====================================================================

    #[tokio::test]
    async fn list_by_tag_basic() {
        let (pool, _dir) = test_pool().await;

        // Create a tag and some blocks
        insert_block(&pool, "TAG00001", "tag", "important", None, None).await;
        insert_block(&pool, "BLOCK001", "content", "block 1", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "block 2", None, None).await;
        insert_block(&pool, "BLOCK003", "content", "block 3", None, None).await;

        // Tag only blocks 1 and 3
        insert_tag_association(&pool, "BLOCK001", "TAG00001").await;
        insert_tag_association(&pool, "BLOCK003", "TAG00001").await;

        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_by_tag(&pool, "TAG00001", &page).await.unwrap();

        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.items[0].id, "BLOCK001");
        assert_eq!(resp.items[1].id, "BLOCK003");
    }

    #[tokio::test]
    async fn list_by_tag_with_cursor() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "TAG00001", "tag", "important", None, None).await;
        for i in 1..=5_i64 {
            let id = format!("BLOCK{i:03}");
            insert_block(&pool, &id, "content", &format!("b{i}"), None, None).await;
            insert_tag_association(&pool, &id, "TAG00001").await;
        }

        // Page 1 (size 2)
        let p1 = PageRequest::new(None, Some(2)).unwrap();
        let r1 = list_by_tag(&pool, "TAG00001", &p1).await.unwrap();
        assert_eq!(r1.items.len(), 2);
        assert!(r1.has_more);
        assert_eq!(r1.items[0].id, "BLOCK001");
        assert_eq!(r1.items[1].id, "BLOCK002");

        // Page 2
        let p2 = PageRequest::new(r1.next_cursor, Some(2)).unwrap();
        let r2 = list_by_tag(&pool, "TAG00001", &p2).await.unwrap();
        assert_eq!(r2.items.len(), 2);
        assert!(r2.has_more);
        assert_eq!(r2.items[0].id, "BLOCK003");
        assert_eq!(r2.items[1].id, "BLOCK004");

        // Page 3 (last)
        let p3 = PageRequest::new(r2.next_cursor, Some(2)).unwrap();
        let r3 = list_by_tag(&pool, "TAG00001", &p3).await.unwrap();
        assert_eq!(r3.items.len(), 1);
        assert!(!r3.has_more);
        assert!(r3.next_cursor.is_none());
        assert_eq!(r3.items[0].id, "BLOCK005");
    }

    // ====================================================================
    // list_agenda tests
    // ====================================================================

    #[tokio::test]
    async fn list_agenda_basic() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "BLOCK001", "content", "meeting", None, None).await;
        insert_block(&pool, "BLOCK002", "content", "deadline", None, None).await;
        insert_block(&pool, "BLOCK003", "content", "other day", None, None).await;

        insert_agenda_entry(&pool, "2025-01-15", "BLOCK001", "property:scheduled").await;
        insert_agenda_entry(&pool, "2025-01-15", "BLOCK002", "property:deadline").await;
        insert_agenda_entry(&pool, "2025-01-16", "BLOCK003", "property:scheduled").await;

        // Query Jan 15
        let page = PageRequest::new(None, Some(10)).unwrap();
        let resp = list_agenda(&pool, "2025-01-15", &page).await.unwrap();

        assert_eq!(resp.items.len(), 2);
        assert_eq!(resp.items[0].id, "BLOCK001");
        assert_eq!(resp.items[1].id, "BLOCK002");

        // Query Jan 16 — different date
        let resp2 = list_agenda(&pool, "2025-01-16", &page).await.unwrap();
        assert_eq!(resp2.items.len(), 1);
        assert_eq!(resp2.items[0].id, "BLOCK003");

        // Query a date with no entries
        let resp3 = list_agenda(&pool, "2025-12-31", &page).await.unwrap();
        assert!(resp3.items.is_empty());
        assert!(!resp3.has_more);
    }
}
