//! Cursor-based keyset pagination for block queries.
//!
//! All list queries use cursor/keyset pagination -- offset pagination is banned
//! per the ADR.  The cursor is an opaque base64-encoded JSON string.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppError;

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
}

/// Internal cursor for keyset pagination.
/// Opaque to callers; serialised as base64-encoded JSON.
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
// Paginated queries
// ---------------------------------------------------------------------------

/// List children of `parent_id` (or top-level blocks when `None`), paginated.
///
/// Ordered by `(position ASC, id ASC)`.
/// Uses index `idx_blocks_parent(parent_id, deleted_at)`.
///
/// NOTE: assumes children always have a non-NULL `position` column.
pub async fn list_children(
    pool: &SqlitePool,
    parent_id: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let mut rows = if let Some(ref cursor) = page.after {
        let pos = cursor.position.unwrap_or(0);
        sqlx::query_as::<_, BlockRow>(
            "SELECT id, block_type, content, parent_id, position, deleted_at, archived_at \
             FROM blocks \
             WHERE parent_id IS ? AND deleted_at IS NULL \
               AND (position > ? OR (position = ? AND id > ?)) \
             ORDER BY position ASC, id ASC \
             LIMIT ?",
        )
        .bind(parent_id)
        .bind(pos)
        .bind(pos)
        .bind(&cursor.id)
        .bind(fetch_limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, BlockRow>(
            "SELECT id, block_type, content, parent_id, position, deleted_at, archived_at \
             FROM blocks \
             WHERE parent_id IS ? AND deleted_at IS NULL \
             ORDER BY position ASC, id ASC \
             LIMIT ?",
        )
        .bind(parent_id)
        .bind(fetch_limit)
        .fetch_all(pool)
        .await?
    };

    let has_more = rows.len() as i64 > page.limit;
    if has_more {
        rows.truncate(page.limit as usize);
    }

    let next_cursor = if has_more {
        let last = rows.last().expect("has_more implies non-empty");
        Some(
            Cursor {
                id: last.id.clone(),
                position: last.position,
                deleted_at: None,
            }
            .encode()?,
        )
    } else {
        None
    };

    Ok(PageResponse {
        items: rows,
        next_cursor,
        has_more,
    })
}

/// List blocks by `block_type`, paginated.
///
/// Ordered by `id ASC` (ULID = chronological).
/// Uses index `idx_blocks_type(block_type, deleted_at)`.
pub async fn list_by_type(
    pool: &SqlitePool,
    block_type: &str,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let mut rows = if let Some(ref cursor) = page.after {
        sqlx::query_as::<_, BlockRow>(
            "SELECT id, block_type, content, parent_id, position, deleted_at, archived_at \
             FROM blocks \
             WHERE block_type = ? AND deleted_at IS NULL AND id > ? \
             ORDER BY id ASC \
             LIMIT ?",
        )
        .bind(block_type)
        .bind(&cursor.id)
        .bind(fetch_limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, BlockRow>(
            "SELECT id, block_type, content, parent_id, position, deleted_at, archived_at \
             FROM blocks \
             WHERE block_type = ? AND deleted_at IS NULL \
             ORDER BY id ASC \
             LIMIT ?",
        )
        .bind(block_type)
        .bind(fetch_limit)
        .fetch_all(pool)
        .await?
    };

    let has_more = rows.len() as i64 > page.limit;
    if has_more {
        rows.truncate(page.limit as usize);
    }

    let next_cursor = if has_more {
        let last = rows.last().expect("has_more implies non-empty");
        Some(
            Cursor {
                id: last.id.clone(),
                position: None,
                deleted_at: None,
            }
            .encode()?,
        )
    } else {
        None
    };

    Ok(PageResponse {
        items: rows,
        next_cursor,
        has_more,
    })
}

/// List soft-deleted blocks (trash view), paginated.
///
/// Ordered by `(deleted_at DESC, id ASC)` -- most recently deleted first.
/// Excludes conflict blocks (`is_conflict = 0`).
pub async fn list_trash(
    pool: &SqlitePool,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let mut rows = if let Some(ref cursor) = page.after {
        let del_at = cursor.deleted_at.as_deref().unwrap_or("");
        sqlx::query_as::<_, BlockRow>(
            "SELECT id, block_type, content, parent_id, position, deleted_at, archived_at \
             FROM blocks \
             WHERE deleted_at IS NOT NULL AND is_conflict = 0 \
               AND (deleted_at < ? OR (deleted_at = ? AND id > ?)) \
             ORDER BY deleted_at DESC, id ASC \
             LIMIT ?",
        )
        .bind(del_at)
        .bind(del_at)
        .bind(&cursor.id)
        .bind(fetch_limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, BlockRow>(
            "SELECT id, block_type, content, parent_id, position, deleted_at, archived_at \
             FROM blocks \
             WHERE deleted_at IS NOT NULL AND is_conflict = 0 \
             ORDER BY deleted_at DESC, id ASC \
             LIMIT ?",
        )
        .bind(fetch_limit)
        .fetch_all(pool)
        .await?
    };

    let has_more = rows.len() as i64 > page.limit;
    if has_more {
        rows.truncate(page.limit as usize);
    }

    let next_cursor = if has_more {
        let last = rows.last().expect("has_more implies non-empty");
        Some(
            Cursor {
                id: last.id.clone(),
                position: None,
                deleted_at: last.deleted_at.clone(),
            }
            .encode()?,
        )
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
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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

    // ======================================================================
    // Cursor unit tests
    // ======================================================================

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

    // ======================================================================
    // list_children tests
    // ======================================================================

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
        // A child block -- should NOT appear in top-level listing
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

    // ======================================================================
    // list_by_type tests
    // ======================================================================

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

        // Insert 5 pages with ULID-like ids (sorted lexicographically)
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

    // ======================================================================
    // list_trash tests
    // ======================================================================

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
}
