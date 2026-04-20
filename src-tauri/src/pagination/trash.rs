use std::collections::HashMap;

use sqlx::SqlitePool;

use super::{build_page_response, BlockRow, Cursor, PageRequest, PageResponse};
use crate::error::AppError;

/// List soft-deleted blocks (trash view), paginated.
///
/// Returns only the **roots** of each deletion batch — a block is a root if
/// either its `parent_id` is NULL or its parent does not share the same
/// `deleted_at` timestamp (i.e., the parent is alive, or was deleted in a
/// different batch and is itself a root). This mirrors the predicate used by
/// `purge_all_deleted_inner` / `restore_all_deleted_inner` and matches the
/// op-log model where `DeleteBlock` / `RestoreBlock` / `PurgeBlock` only
/// record the root id (descendants cascade transparently).
///
/// Ordered by `(deleted_at DESC, id ASC)` — most recently deleted first.
/// Excludes conflict blocks (`is_conflict = 0`).
pub async fn list_trash(
    pool: &SqlitePool,
    page: &PageRequest,
) -> Result<PageResponse<BlockRow>, AppError> {
    let fetch_limit = page.limit + 1;

    let (cursor_flag, cursor_del, cursor_id): (Option<i64>, &str, &str) = match page.after.as_ref()
    {
        Some(c) => {
            let del = c.deleted_at.as_deref().ok_or_else(|| {
                AppError::Validation("cursor missing deleted_at for trash query".into())
            })?;
            (Some(1), del, &c.id)
        }
        None => (None, "", ""),
    };

    let rows = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position,
                deleted_at, is_conflict as "is_conflict: bool",
                conflict_type, todo_state, priority, due_date, scheduled_date,
                page_id
         FROM blocks b
         WHERE b.deleted_at IS NOT NULL AND b.is_conflict = 0
           AND (
                b.parent_id IS NULL
                OR NOT EXISTS (
                    SELECT 1 FROM blocks p
                    WHERE p.id = b.parent_id AND p.deleted_at = b.deleted_at
                )
           )
           AND (?1 IS NULL OR (
                b.deleted_at < ?2 OR (b.deleted_at = ?2 AND b.id > ?3)))
         ORDER BY b.deleted_at DESC, b.id ASC
         LIMIT ?4"#,
        cursor_flag, // ?1
        cursor_del,  // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| Cursor {
        id: last.id.clone(),
        position: None,
        deleted_at: last.deleted_at.clone(),
        seq: None,
        rank: None,
    })
}

/// For each root in `root_ids`, return the count of descendants that share
/// the root's `deleted_at` timestamp (i.e., were cascade-deleted together).
///
/// Roots with zero descendants are omitted from the map — callers should
/// default to `0` when a root id is not present. Non-existent ids and ids
/// that aren't actually soft-deleted yield no entry. Conflict blocks
/// (`is_conflict = 1`) are excluded from both the root lookup and the
/// descendant count, matching `list_trash` semantics.
///
/// Uses a single `json_each()`-driven query — no N+1 (AGENTS.md Backend
/// Pattern #3).
///
/// # Errors
///
/// - [`AppError::Json`] — failed to serialize `root_ids`.
/// - [`AppError::Database`] — propagated from sqlx.
pub async fn trash_descendant_counts(
    pool: &SqlitePool,
    root_ids: &[String],
) -> Result<HashMap<String, u64>, AppError> {
    if root_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let ids_json = serde_json::to_string(root_ids)?;

    // For each requested root, join blocks (rb) to blocks (d) on the shared
    // `deleted_at` timestamp — this picks up every block in the same
    // cascade_soft_delete batch. COUNT(d.id) - 1 subtracts the root itself.
    // Roots that aren't soft-deleted (no matching rb row) are filtered by
    // the WHERE predicate. `is_conflict = 0` on both sides matches
    // `list_trash`.
    let rows = sqlx::query!(
        r#"SELECT rb.id AS "root_id!: String",
                  (COUNT(d.id) - 1) AS "descendant_count!: i64"
           FROM blocks rb
           JOIN blocks d
             ON d.deleted_at = rb.deleted_at
            AND d.is_conflict = 0
           WHERE rb.id IN (SELECT value FROM json_each(?1))
             AND rb.deleted_at IS NOT NULL
             AND rb.is_conflict = 0
           GROUP BY rb.id"#,
        ids_json,
    )
    .fetch_all(pool)
    .await?;

    let mut out: HashMap<String, u64> = HashMap::new();
    for row in rows {
        // Clamp at zero: COUNT(d.id) is always >= 1 because rb itself matches
        // the d-side join (same deleted_at, non-conflict). Subtracting 1
        // yields the descendant count. Never negative in practice, but we
        // guard to keep the u64 conversion total.
        let count = u64::try_from(row.descendant_count.max(0)).unwrap_or(0);
        if count > 0 {
            out.insert(row.root_id, count);
        }
    }
    Ok(out)
}
