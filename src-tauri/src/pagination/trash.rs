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
///
/// When `space_id` is `Some`, only trash roots whose owning page carries
/// `space = ?space_id` are returned. Note that a soft-deleted block
/// retains its `page_id` column value, so the filter applies identically
/// to live and deleted blocks. See [`crate::space_filter_clause`].
pub async fn list_trash(
    pool: &SqlitePool,
    page: &PageRequest,
    space_id: Option<&str>,
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

    // FEAT-3 Phase 2 — ?5 (space_id) drives the shared space filter.
    // The clause is inlined here (rather than composed via
    // `crate::space_filter_clause!`) because `sqlx::query_as!` requires
    // a string literal and does not accept `concat!()`. Mirror any
    // change to the filter SQL across every inlined copy.
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
           AND (?5 IS NULL OR COALESCE(b.page_id, b.id) IN (
                SELECT bp.block_id FROM block_properties bp
                WHERE bp.key = 'space' AND bp.value_ref = ?5))
         ORDER BY b.deleted_at DESC, b.id ASC
         LIMIT ?4"#,
        cursor_flag, // ?1
        cursor_del,  // ?2
        cursor_id,   // ?3
        fetch_limit, // ?4
        space_id,    // ?5
    )
    .fetch_all(pool)
    .await?;

    build_page_response(rows, page.limit, |last| {
        Cursor::for_id_and_deleted_at(last.id.clone(), last.deleted_at.clone())
    })
}

/// For each root in `root_ids`, return the count of descendants that share
/// the root's `deleted_at` timestamp (i.e., were cascade-deleted together).
///
/// Descendants are walked via a recursive CTE rooted at each requested id,
/// following `parent_id` links and requiring the same `deleted_at` on every
/// hop — so two unrelated roots that happen to share a `deleted_at`
/// timestamp do not pollute each other's counts.
///
/// Roots with zero descendants are omitted from the map — callers should
/// default to `0` when a root id is not present. Non-existent ids and ids
/// that aren't actually soft-deleted yield no entry. Conflict blocks
/// (`is_conflict = 1`) are excluded from both the root lookup and the
/// recursive descendant walk, matching `list_trash` semantics. Recursion
/// is bounded at depth 100 per AGENTS.md invariant #9.
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

    // Per-root recursive CTE: each requested root seeds the walk with
    // (root_id, root_id, deleted_at, depth=0) and the recursive member
    // follows `parent_id` edges that share the root's `deleted_at`. This
    // enforces actual ancestry, so two unrelated roots that happen to share
    // a `deleted_at` (e.g. millisecond collisions in `cascade_soft_delete`,
    // or test fixtures with `FIXED_DELETED_AT`) do not contaminate each
    // other's counts. `is_conflict = 0` on the recursive member and the
    // seed matches `list_trash`. Depth is bounded at 100 per AGENTS.md
    // invariant #9. `COUNT(*) - 1` subtracts the root row itself so the
    // result is the descendant count (excluding the root).
    let rows = sqlx::query!(
        r#"WITH RECURSIVE descendants AS (
               SELECT rb.id AS root_id, rb.id AS desc_id,
                      rb.deleted_at AS batch_deleted_at, 0 AS depth
               FROM blocks rb
               WHERE rb.id IN (SELECT value FROM json_each(?1))
                 AND rb.deleted_at IS NOT NULL
                 AND rb.is_conflict = 0
               UNION ALL
               SELECT d.root_id, c.id, d.batch_deleted_at, d.depth + 1
               FROM descendants d
               JOIN blocks c
                 ON c.parent_id = d.desc_id
                AND c.deleted_at = d.batch_deleted_at
                AND c.is_conflict = 0
               WHERE d.depth < 100
           )
           SELECT root_id AS "root_id!: String",
                  (COUNT(*) - 1) AS "descendant_count!: i64"
           FROM descendants
           GROUP BY root_id"#,
        ids_json,
    )
    .fetch_all(pool)
    .await?;

    let mut out: HashMap<String, u64> = HashMap::new();
    for row in rows {
        // Clamp at zero: COUNT(*) is always >= 1 because the root itself
        // seeds the CTE. Subtracting 1 yields the descendant count. Never
        // negative in practice, but we guard to keep the u64 conversion
        // total.
        let count = u64::try_from(row.descendant_count.max(0)).unwrap_or(0);
        if count > 0 {
            out.insert(row.root_id, count);
        }
    }
    Ok(out)
}
