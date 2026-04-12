use sqlx::SqlitePool;

use super::{build_page_response, Cursor, HistoryEntry, PageRequest, PageResponse};
use crate::error::AppError;

/// List op-log history for a specific block, paginated.
///
/// Returns all ops whose payload contains the given `block_id`, ordered by
/// `(seq DESC, device_id DESC)` (newest first).  The cursor stores `seq` and
/// `device_id` (in the `id` field) for correct keyset pagination across
/// multiple devices — the op_log PK is `(device_id, seq)` and `seq` alone
/// is not globally unique.
///
/// A `LIKE` pre-filter narrows candidates before `json_extract` to avoid
/// full-table JSON parsing (same pattern as `recovery.rs`).
///
/// Note: This queries ALL op types for a block (create, edit, add_tag,
/// remove_tag, move, set_property, etc.).
pub async fn list_block_history(
    pool: &SqlitePool,
    block_id: &str,
    page: &PageRequest,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let fetch_limit = page.limit + 1;

    // `id` in the cursor stores `device_id` for history queries — it is the
    // tie-breaker because the op_log PK is `(device_id, seq)`.
    let (cursor_flag, cursor_seq, cursor_device_id): (Option<i64>, i64, &str) =
        match page.after.as_ref() {
            Some(c) => (Some(1), c.seq.unwrap_or(0), &c.id),
            None => (None, 0, ""),
        };

    let rows = sqlx::query_as!(
        HistoryEntry,
        "SELECT device_id, seq, op_type, payload, created_at \
         FROM op_log \
         WHERE payload LIKE '%\"block_id\":\"' || ?1 || '\"%' \
           AND json_extract(payload, '$.block_id') = ?1 \
           AND (?2 IS NULL OR (\
                seq < ?3 OR (seq = ?3 AND device_id < ?5))) \
         ORDER BY seq DESC, device_id DESC \
         LIMIT ?4",
        block_id,         // ?1
        cursor_flag,      // ?2
        cursor_seq,       // ?3
        fetch_limit,      // ?4
        cursor_device_id, // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.device_id.clone(), // device_id as tie-breaker
        position: None,
        deleted_at: None,
        seq: Some(last.seq),
        rank: None,
    })
}

/// List op-log history for all blocks descended from a page, paginated.
///
/// Uses a recursive CTE to find all block IDs in the page subtree, then
/// queries the op_log for ops touching those blocks. Ordered by
/// `(created_at DESC, seq DESC)` (newest first). Optionally filters by
/// `op_type`.
///
/// The cursor stores `created_at` (in the `deleted_at` field, reused for
/// this timestamp purpose) and `seq` for correct keyset pagination.
pub async fn list_page_history(
    pool: &SqlitePool,
    page_id: &str,
    op_type_filter: Option<&str>,
    page: &PageRequest,
) -> Result<PageResponse<HistoryEntry>, AppError> {
    let fetch_limit = page.limit + 1;

    // Cursor: reuse `deleted_at` field for `created_at` and `seq` + `id` for device_id
    let (cursor_flag, cursor_created_at, cursor_seq, cursor_device_id): (
        Option<i64>,
        &str,
        i64,
        &str,
    ) = match page.after.as_ref() {
        Some(c) => {
            let created_at = c.deleted_at.as_deref().ok_or_else(|| {
                AppError::Validation("cursor missing created_at for page history query".into())
            })?;
            (Some(1), created_at, c.seq.unwrap_or(0), &c.id)
        }
        None => (None, "", 0, ""),
    };

    if page_id == "__all__" {
        // Global history: query all ops without page-scoping CTE
        let rows = sqlx::query_as::<_, HistoryEntry>(
            "SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at \
             FROM op_log ol \
             WHERE (?1 IS NULL OR ol.op_type = ?1) \
               AND (?2 IS NULL OR ( \
                    ol.created_at < ?3 \
                    OR (ol.created_at = ?3 AND ol.seq < ?4) \
                    OR (ol.created_at = ?3 AND ol.seq = ?4 AND ol.device_id < ?6))) \
             ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC \
             LIMIT ?5",
        )
        .bind(op_type_filter) // ?1
        .bind(cursor_flag) // ?2
        .bind(cursor_created_at) // ?3
        .bind(cursor_seq) // ?4
        .bind(fetch_limit) // ?5
        .bind(cursor_device_id) // ?6
        .fetch_all(pool)
        .await?;

        return build_page_response(rows, page.limit, |last| Cursor {
            id: last.device_id.clone(),
            position: None,
            deleted_at: Some(last.created_at.clone()),
            seq: Some(last.seq),
            rank: None,
        });
    }

    let rows = sqlx::query_as!(
        HistoryEntry,
        "WITH RECURSIVE page_blocks(id) AS ( \
             SELECT id FROM blocks WHERE id = ?1 \
             UNION ALL \
             SELECT b.id FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
         ) \
         SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at \
         FROM op_log ol \
         WHERE json_extract(ol.payload, '$.block_id') IN (SELECT id FROM page_blocks) \
           AND (?2 IS NULL OR ol.op_type = ?2) \
           AND (?3 IS NULL OR ( \
                ol.created_at < ?4 \
                OR (ol.created_at = ?4 AND ol.seq < ?5) \
                OR (ol.created_at = ?4 AND ol.seq = ?5 AND ol.device_id < ?7))) \
         ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC \
         LIMIT ?6",
        page_id,           // ?1
        op_type_filter,    // ?2
        cursor_flag,       // ?3
        cursor_created_at, // ?4
        cursor_seq,        // ?5
        fetch_limit,       // ?6
        cursor_device_id,  // ?7
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.device_id.clone(),
        position: None,
        deleted_at: Some(last.created_at.clone()), // reuse deleted_at for created_at
        seq: Some(last.seq),
        rank: None,
    })
}
