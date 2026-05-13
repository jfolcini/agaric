//! Restore: `restore_block`.

use sqlx::SqlitePool;

use crate::error::AppError;

/// Restore a soft-deleted block and descendants sharing the same `deleted_at`
/// timestamp.
///
/// Recursive member bounds the walk with `depth < 100` (invariant
/// #9).
///
/// Canonical CTE in `crate::block_descendants::DESCENDANTS_CTE_STANDARD`.
/// This site inlines the SQL because `sqlx::query!` requires a string
/// literal and cannot accept `concat!()` of a `macro_rules!` expansion.
pub async fn restore_block(
    pool: &SqlitePool,
    block_id: &str,
    deleted_at_ref: &str,
) -> Result<u64, AppError> {
    // L-107: IMMEDIATE is intentional. The recursive-CTE traversal walks the
    // same `blocks` rows that `cascade_soft_delete` may be writing concurrently
    // (it also uses BEGIN IMMEDIATE). Acquiring the reserved lock up-front
    // serializes restore against cascade-soft-delete writers and prevents the
    // CTE from reading a half-cascaded subtree.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let result = sqlx::query!(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT id, 0 FROM blocks WHERE id = ? \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             INNER JOIN descendants d ON b.parent_id = d.id \
             WHERE d.depth < 100 \
         ) \
         UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) \
           AND deleted_at = ?",
        block_id,
        deleted_at_ref,
    )
    .execute(&mut *tx)
    .await?;

    // PEND-26 N2: warn when the cascade walk hit the depth-100 cap so an
    // operator has a breadcrumb if a pathological tree silently truncated
    // the restore. The cap (invariant #9) is preserved; we only ADD
    // detection + surfacing here. Standard-variant helper is invariant
    // to deleted_at state, so post-cascade it walks the now-restored
    // subtree and reports MAX depth correctly.
    if crate::block_descendants::cascade_depth_saturated(&mut *tx, block_id).await? {
        tracing::warn!(
            block_id = %block_id,
            op = "restore_block",
            "PEND-26 N2: cascade-depth cap reached (>=99 levels); descendants \
             below depth 100 were not restored. Tree is pathologically deep.",
        );
    }

    tx.commit().await?;

    // L-102: a wrong-token call (stale `deleted_at_ref` from a UI undo retry,
    // a typo in an MCP call, or a bug in the caller) is a silent no-op
    // otherwise. Emit a warn breadcrumb with both identifiers so triage has
    // something to grep for. Intentionally NOT promoted to `Err` — callers
    // (e.g. undo-redo) rely on `Ok(0)` for idempotent retries.
    let rows = result.rows_affected();
    if rows == 0 {
        tracing::warn!(
            block_id = %block_id,
            deleted_at_ref = %deleted_at_ref,
            "restore_block matched no rows",
        );
    }
    Ok(rows)
}
