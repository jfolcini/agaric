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

    build_page_response(rows, page.limit, |last| {
        // device_id as tie-breaker
        Cursor::for_history_seq(last.device_id.clone(), last.seq)
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
///
/// FEAT-3 Phase 8 — when `page_id == "__all__"` and `space_id` is `Some`,
/// the global query is additionally filtered to only ops whose
/// `payload.block_id` resolves (via `block_properties.key = 'space'`) to
/// the requested space. When `space_id` is `None`, behaviour is identical
/// to before — every op in `op_log` is returned. When `page_id` is a real
/// ULID (per-page mode), `space_id` is ignored: a page is itself
/// space-bound, so the existing recursive CTE already scopes correctly.
pub async fn list_page_history(
    pool: &SqlitePool,
    page_id: &str,
    op_type_filter: Option<&str>,
    space_id: Option<&str>,
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
        // Global history: query all ops without page-scoping CTE.
        // FEAT-3 Phase 8 — when `space_id` is `Some`, narrow to ops whose
        // `payload.block_id` belongs to the requested space (matching the
        // pattern used in `pagination/hierarchy.rs:113-134`).
        let rows = sqlx::query_as::<_, HistoryEntry>(
            "SELECT ol.device_id, ol.seq, ol.op_type, ol.payload, ol.created_at \
             FROM op_log ol \
             WHERE (?1 IS NULL OR ol.op_type = ?1) \
               AND (?2 IS NULL OR ( \
                    ol.created_at < ?3 \
                    OR (ol.created_at = ?3 AND ol.seq < ?4) \
                    OR (ol.created_at = ?3 AND ol.seq = ?4 AND ol.device_id < ?6))) \
               AND (?7 IS NULL OR json_extract(ol.payload, '$.block_id') IN ( \
                    SELECT bp.block_id FROM block_properties bp \
                    WHERE bp.key = 'space' AND bp.value_ref = ?7)) \
             ORDER BY ol.created_at DESC, ol.seq DESC, ol.device_id DESC \
             LIMIT ?5",
        )
        .bind(op_type_filter) // ?1
        .bind(cursor_flag) // ?2
        .bind(cursor_created_at) // ?3
        .bind(cursor_seq) // ?4
        .bind(fetch_limit) // ?5
        .bind(cursor_device_id) // ?6
        .bind(space_id) // ?7
        .fetch_all(pool)
        .await?;

        return build_page_response(rows, page.limit, |last| {
            Cursor::for_history_full(last.device_id.clone(), last.created_at.clone(), last.seq)
        });
    }

    // Recursive CTE must filter `is_conflict = 0` in the recursive member —
    // conflict copies inherit `parent_id` from the original block and would
    // otherwise leak into page-scoped results. `depth < 100` bounds the walk
    // against runaway recursion on corrupted data (invariant #9).
    let rows = sqlx::query_as!(
        HistoryEntry,
        "WITH RECURSIVE page_blocks(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ?1 AND is_conflict = 0 \
             UNION ALL \
             SELECT b.id, pb.depth + 1 FROM blocks b JOIN page_blocks pb ON b.parent_id = pb.id \
             WHERE b.is_conflict = 0 AND pb.depth < 100 \
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

    build_page_response(rows, page.limit, |last| {
        // reuse deleted_at slot for created_at — see Cursor docs
        Cursor::for_history_full(last.device_id.clone(), last.created_at.clone(), last.seq)
    })
}
