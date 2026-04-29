use crate::db::{CommandTx, WritePool};
use crate::device::DeviceId;
use crate::op::MoveBlockPayload;
use tracing::instrument;

use super::super::*;

/// Move a block to a new parent at a specific position.
///
/// Validates the block and optional new parent exist, detects cycles via
/// ancestor-walking CTE, appends a `MoveBlock` op, updates `parent_id` and
/// `position` in the `blocks` table, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::InvalidOperation`] — block cannot be its own parent
/// - [`AppError::Validation`] — non-positive position, or cycle detected
/// - [`AppError::NotFound`] — block or new parent does not exist or is deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn move_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    new_parent_id: Option<String>,
    new_position: i64,
) -> Result<MoveResponse, AppError> {
    // I-CommandsCRUD-2: normalise to canonical uppercase form. AGENTS.md
    // invariant #8 requires ULID uppercase for blake3 hash determinism;
    // SQLite text comparison is byte-exact, so a lowercase caller would
    // silently get NotFound. BlockId::from_trusted normalises on
    // construction (op_log path), but raw String args from MCP tools /
    // sync replay / scripted imports must be normalised here. Both
    // `block_id` and `new_parent_id` are matched against `blocks.id`.
    let block_id = block_id.to_ascii_uppercase();
    let new_parent_id = new_parent_id.map(|s| s.to_ascii_uppercase());

    // 1. Validate block cannot become its own parent (pure-logic check, no DB)
    if let Some(ref pid) = new_parent_id {
        if pid == &block_id {
            return Err(AppError::InvalidOperation(format!(
                "block '{block_id}' cannot be its own parent"
            )));
        }
    }

    // 1b. Validate position is positive (1-based)
    if new_position <= 0 {
        return Err(AppError::Validation(format!(
            "position must be positive (1-based), got {new_position}"
        )));
    }

    // 2. Build OpPayload
    let new_parent_block_id = new_parent_id.as_ref().map(|s| BlockId::from_trusted(s));
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
        new_parent_id: new_parent_block_id.clone(),
        new_position,
    });

    // 3. Single IMMEDIATE transaction: validation + op_log + move.
    //    BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    //    SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    //    and the actual mutation. MAINT-112: CommandTx couples commit
    //    + post-commit dispatch so a failed commit never leaks the
    //    op_record to the materializer.
    let mut tx = CommandTx::begin_immediate(pool, "move_block").await?;

    // Validate block exists and is not deleted (TOCTOU-safe)
    let existing = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;
    if existing.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // Validate new parent exists and is not deleted (TOCTOU-safe)
    if let Some(ref pid) = new_parent_id {
        let exists = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            pid
        )
        .fetch_optional(&mut **tx)
        .await?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("parent block '{pid}'")));
        }

        // Cycle detection: walk all ancestors of the new parent using a
        // recursive CTE. If block_id appears among the ancestors, reparenting
        // would create a cycle (e.g. moving A under its own grandchild C in
        // a chain A→B→C).
        //
        // Recursive member filters `is_conflict = 0` and bounds `depth < 100`
        // (invariant #9). Without these, a conflict copy along the parent
        // chain would falsely report a cycle, and a corrupted parent_id chain
        // could run unbounded recursion. Same pattern as the depth-check CTE
        // below.
        let cycle = sqlx::query!(
            r#"WITH RECURSIVE ancestors(id, depth) AS (
                 SELECT parent_id, 0 FROM blocks WHERE id = ?
                 UNION ALL
                 SELECT b.parent_id, a.depth + 1 FROM blocks b
                 INNER JOIN ancestors a ON b.id = a.id
                 WHERE a.id IS NOT NULL AND b.is_conflict = 0 AND a.depth < 100
             )
             SELECT 1 as "v: i32" FROM ancestors WHERE id = ?"#,
            pid,
            block_id
        )
        .fetch_optional(&mut **tx)
        .await?;
        if cycle.is_some() {
            return Err(AppError::Validation("cycle detected".into()));
        }

        // Depth check: count ancestors of the target parent (its depth from
        // root) and the max descendant depth of the block being moved. The
        // deepest descendant will end up at parent_depth + 1 + subtree_depth.
        //
        // Recursive members filter `is_conflict = 0` — conflict copies inherit
        // `parent_id` from the original and would otherwise inflate depth counts
        // (invariant #9). `depth < 100` bounds each walk.
        let depths = sqlx::query!(
            r#"WITH RECURSIVE
               path(id, depth) AS (
                 SELECT ?, 0
                 UNION ALL
                 SELECT b.parent_id, p.depth + 1
                 FROM path p JOIN blocks b ON b.id = p.id
                 WHERE b.parent_id IS NOT NULL AND b.is_conflict = 0 AND p.depth < 100
               ),
               descendants(id, depth) AS (
                 SELECT ?, 0
                 UNION ALL
                 SELECT b.id, d.depth + 1
                 FROM descendants d JOIN blocks b ON b.parent_id = d.id
                 WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100
               )
             SELECT
               (SELECT MAX(depth) FROM path) as "parent_depth: i64",
               (SELECT MAX(depth) FROM descendants) as "subtree_depth: i64""#,
            pid,
            block_id
        )
        .fetch_one(&mut **tx)
        .await?;

        let parent_depth = depths.parent_depth;
        let subtree_depth = depths.subtree_depth;

        if parent_depth + 1 + subtree_depth > MAX_BLOCK_DEPTH {
            return Err(AppError::Validation(format!(
                "maximum nesting depth of {MAX_BLOCK_DEPTH} exceeded"
            )));
        }
    }

    // 4. Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 5. Update blocks table within same transaction
    sqlx::query("UPDATE blocks SET parent_id = ?, position = ? WHERE id = ?")
        .bind(&new_parent_id)
        .bind(new_position)
        .bind(&block_id)
        .execute(&mut **tx)
        .await?;

    // Update page_id for the moved block and all its descendants.
    // First, compute the new page_id based on the new parent.
    let new_page_id: Option<String> = if let Some(ref pid) = new_parent_id {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END FROM blocks WHERE id = ?"
        )
        .bind(pid)
        .fetch_optional(&mut **tx)
        .await?
        .flatten()
    } else {
        None
    };

    // Update the moved block itself (unless it's a page — pages always have page_id = self)
    let is_page: bool =
        sqlx::query_scalar::<_, String>("SELECT block_type FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_one(&mut **tx)
            .await?
            == "page";

    if !is_page {
        sqlx::query("UPDATE blocks SET page_id = ? WHERE id = ?")
            .bind(&new_page_id)
            .bind(&block_id)
            .execute(&mut **tx)
            .await?;
    }

    // Update all non-page descendants to inherit the moved block's page_id.
    // Pages keep their own id as page_id regardless of parent.
    //
    // Recursive CTE filters `is_conflict = 0` in both members — conflict
    // copies inherit `parent_id` from the original and would otherwise be
    // reparented under the moved subtree. `depth < 100` bounds the walk
    // (invariant #9).
    let effective_page_id = if is_page {
        Some(block_id.clone())
    } else {
        new_page_id
    };
    sqlx::query(
        "WITH RECURSIVE descendants(id, depth) AS ( \
             SELECT b.id, 0 FROM blocks b \
             WHERE b.parent_id = ?1 AND b.deleted_at IS NULL AND b.is_conflict = 0 \
             UNION ALL \
             SELECT b.id, d.depth + 1 FROM blocks b \
             JOIN descendants d ON b.parent_id = d.id \
             WHERE b.deleted_at IS NULL AND b.is_conflict = 0 AND d.depth < 100 \
         ) \
         UPDATE blocks SET page_id = ?2 \
         WHERE id IN (SELECT id FROM descendants) AND block_type != 'page'",
    )
    .bind(&block_id)
    .bind(&effective_page_id)
    .execute(&mut **tx)
    .await?;

    // P-4: Recompute inherited tags for moved subtree
    crate::tag_inheritance::recompute_subtree_inheritance(&mut tx, &block_id).await?;

    // 6. Commit + dispatch background cache tasks (fire-and-forget).
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    // 7. Return response
    Ok(MoveResponse {
        block_id,
        new_parent_id,
        new_position,
    })
}

/// Tauri command: move a block to a new parent at a given position. Delegates to [`move_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn move_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    new_parent_id: Option<String>,
    new_position: i64,
) -> Result<MoveResponse, AppError> {
    move_block_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id,
        new_parent_id,
        new_position,
    )
    .await
    .map_err(sanitize_internal_error)
}
