use crate::db::{CommandTx, WritePool};
use crate::device::DeviceId;
use crate::op::{
    validate_set_property, CreateBlockPayload, DeleteBlockPayload, DeletePropertyPayload,
    EditBlockPayload, PurgeBlockPayload, RestoreBlockPayload, SetPropertyPayload,
};

use tracing::instrument;

use super::super::*;

/// Create a new block.
///
/// Validates block type and optional parent, generates a ULID, appends a
/// `CreateBlock` op, inserts the row into `blocks`, and dispatches
/// background cache tasks.
///
/// # Errors
///
/// - [`AppError::Validation`] — unknown `block_type` or non-positive `position`
/// - [`AppError::NotFound`] — `parent_id` does not refer to a live block
///
/// # Rate limiting (F07)
///
/// No server-side rate limiting is implemented. This is acceptable for a
/// single-user desktop app where the caller is always the local UI. If the
/// app ever gains a network-facing API, rate limiting should be added at the
/// transport layer.
/// Create a new block inside an existing transaction.
///
/// This is the core implementation shared by [`create_block_inner`] (which
/// wraps it in its own transaction) and the recurrence path in
/// [`set_todo_state_inner`] (which batches multiple operations in one tx).
///
/// Returns the new [`BlockRow`] and the [`op_log::OpRecord`] so the caller
/// can commit the transaction and dispatch background work afterward.
pub(crate) async fn create_block_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
) -> Result<(BlockRow, op_log::OpRecord), AppError> {
    // 1. Validate block_type
    match block_type.as_str() {
        "content" | "tag" | "page" => {}
        _ => {
            return Err(AppError::Validation(format!(
                "unknown block_type '{block_type}': must be 'content', 'tag', or 'page'"
            )));
        }
    }

    // 1b. Validate position is positive (1-based) when provided
    if let Some(pos) = position {
        if pos <= 0 {
            return Err(AppError::Validation(format!(
                "position must be positive (1-based), got {pos}"
            )));
        }
    }

    // 1c. Validate content length
    if content.len() > MAX_CONTENT_LENGTH {
        return Err(AppError::Validation(format!(
            "content length {} exceeds maximum {MAX_CONTENT_LENGTH}",
            content.len()
        )));
    }

    // 2. Generate new BlockId
    let block_id = BlockId::new();

    // F01: Validate parent_id inside the transaction to prevent TOCTOU race.
    // A concurrent purge_block could physically delete the parent between
    // our check and the INSERT, violating the FK constraint.
    if let Some(ref pid) = parent_id {
        let exists = sqlx::query!(
            r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
            pid
        )
        .fetch_optional(&mut **tx)
        .await?;
        if exists.is_none() {
            return Err(AppError::NotFound(format!("parent block '{pid}'")));
        }

        // L-37: Enforce `MAX_BLOCK_DEPTH` on the create path. The new block
        // will live at depth = parent_depth + 1, so reject when that exceeds
        // the documented limit (ARCHITECTURE.md §20). Without this guard
        // a user could repeatedly create blocks under the deepest leaf and
        // drift past the bound — `move_block_inner` already enforces the
        // same limit; the asymmetry was the loophole.
        //
        // The recursive member filters `is_conflict = 0` and bounds
        // `depth < 100` (invariant #9) — same shape as the depth-check CTE
        // in `move_block_inner` (move_ops.rs).
        let parent_depth = sqlx::query_scalar!(
            r#"WITH RECURSIVE path(id, depth) AS (
                 SELECT ?, 0
                 UNION ALL
                 SELECT b.parent_id, p.depth + 1
                 FROM path p JOIN blocks b ON b.id = p.id
                 WHERE b.parent_id IS NOT NULL AND b.is_conflict = 0 AND p.depth < 100
               )
               SELECT MAX(depth) as "depth: i64" FROM path"#,
            pid,
        )
        .fetch_one(&mut **tx)
        .await?;

        if parent_depth + 1 > MAX_BLOCK_DEPTH {
            return Err(AppError::Validation(format!(
                "maximum nesting depth of {MAX_BLOCK_DEPTH} exceeded"
            )));
        }
    }

    // Compute next position when none provided: append after last sibling
    let effective_position = match position {
        Some(p) => p,
        None => {
            let row = sqlx::query!(
                "SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM blocks \
                 WHERE parent_id IS ? AND deleted_at IS NULL AND position < 9223372036854775807",
                parent_id
            )
            .fetch_optional(&mut **tx)
            .await?;
            row.map(|r| r.next_pos).unwrap_or(1)
        }
    };

    // 3b. Build OpPayload with the resolved position
    let parent_block_id = parent_id.as_ref().map(|s| BlockId::from_trusted(s));
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: block_id.clone(),
        block_type: block_type.clone(),
        parent_id: parent_block_id,
        position: Some(effective_position),
        content: content.clone(),
    });

    let op_record = op_log::append_local_op_in_tx(tx, device_id, payload, now_rfc3339()).await?;

    // Compute page_id: if this block IS a page, page_id = self.
    // Otherwise, inherit from parent's page_id (or parent itself if parent is a page).
    let page_id: Option<String> = if block_type == "page" {
        Some(block_id.as_str().to_string())
    } else if let Some(ref pid) = parent_id {
        // Look up parent's page_id. If parent is a page, use parent's id.
        let parent_page = sqlx::query_scalar::<_, Option<String>>(
            "SELECT CASE WHEN block_type = 'page' THEN id ELSE page_id END FROM blocks WHERE id = ?"
        )
        .bind(pid)
        .fetch_optional(&mut **tx)
        .await?
        .flatten();
        parent_page
    } else {
        None
    };

    // 5. Insert into blocks table within same transaction
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(block_id.as_str())
    .bind(&block_type)
    .bind(&content)
    .bind(&parent_id)
    .bind(effective_position)
    .bind(&page_id)
    .execute(&mut **tx)
    .await?;

    // P-4: Inherit parent tags for the new block
    crate::tag_inheritance::inherit_parent_tags(tx, block_id.as_str(), parent_id.as_deref())
        .await?;

    // Return block + op record; caller is responsible for commit + dispatch.
    Ok((
        BlockRow {
            id: block_id.into_string(),
            block_type,
            content: Some(content),
            parent_id,
            position: Some(effective_position),
            deleted_at: None,
            is_conflict: false,
            conflict_type: None,
            todo_state: None,
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id,
        },
        op_record,
    ))
}

#[instrument(skip(pool, device_id, materializer, content), err)]
pub async fn create_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
) -> Result<BlockRow, AppError> {
    // MAINT-112: CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "create_block").await?;
    let (block, op_record) =
        create_block_in_tx(&mut tx, device_id, block_type, content, parent_id, position).await?;
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;
    Ok(block)
}

/// BUG-1 / H-3a — IPC-tightened `create_block`.
///
/// Wraps [`create_block_inner`] with the FEAT-3 invariant
/// "every page belongs to a space". When `block_type == "page"`:
///
/// * `space_id is None` → return [`AppError::Validation`]; the caller
///   must use [`create_page_in_space_inner`] semantics or pass the
///   active space's ULID through this IPC. No op is appended, the
///   page is rejected at the IPC boundary so a misbehaving frontend
///   (e.g. a stale `createBlock({ blockType: 'page' })` callsite)
///   cannot leak unscoped pages into the materialized state.
/// * `space_id is Some(sid)` → delegates to
///   [`crate::commands::spaces::create_page_in_space_inner`] which
///   emits `CreateBlock` + `SetProperty(space=<sid>)` inside a single
///   `BEGIN IMMEDIATE` transaction.
///
/// Other block types (`content`, `tag`) ignore the parameter and
/// pass through to [`create_block_inner`] unchanged.
///
/// Returns a [`BlockRow`] for the new block — for the page path, the
/// row is re-fetched after the transaction commits so it carries the
/// freshly-materialized state (`page_id = self`, etc.).
///
/// # Errors
///
/// - [`AppError::Validation`] — `block_type == "page"` AND
///   `space_id is None`, or `space_id` does not refer to a live space
///   block (propagated from `create_page_in_space_inner`).
/// - All errors from [`create_block_inner`] propagate unchanged for
///   non-page block types.
// 8 args (one over the clippy threshold of 7) — adding `space_id` to the
// existing 7-arg `create_block_inner` shape is the cleanest way to satisfy
// the BUG-1 invariant without forcing every non-page caller to flip to a
// builder pattern. Restructuring into an args struct would touch hundreds
// of callsites for zero behavioural gain.
#[allow(clippy::too_many_arguments)]
#[instrument(skip(pool, device_id, materializer, content), err)]
pub async fn create_block_inner_with_space(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
    space_id: Option<String>,
) -> Result<BlockRow, AppError> {
    if block_type == "page" {
        let Some(sid) = space_id else {
            return Err(AppError::Validation(
                "page blocks require space_id (BUG-1 / H-3a): \
                 use createPageInSpace or pass the active space's ULID"
                    .to_owned(),
            ));
        };

        // Delegate to the atomic 2-op helper. It emits `CreateBlock` +
        // `SetProperty(space = <sid>)` inside a single
        // `BEGIN IMMEDIATE` transaction so a page never exists without
        // its space property — the FEAT-3 "nothing outside of spaces"
        // invariant. `position` is intentionally NOT threaded through:
        // `create_page_in_space_inner` mirrors PageBrowser's "New page"
        // semantics (append after last sibling). If a future caller
        // needs explicit positioning for top-level pages we can extend
        // the helper; today no callsite uses it.
        //
        // MAINT-112: `_inner` now dispatches background cache rebuilds
        // via `CommandTx::commit_and_dispatch`; the previous re-fetch
        // + loop is gone because the op records never leave the
        // transaction scope.
        let _position = position;
        let new_page_id = crate::commands::create_page_in_space_inner(
            pool,
            device_id,
            materializer,
            parent_id,
            content,
            sid,
        )
        .await?;

        // Re-fetch the materialized BlockRow so the caller (Tauri IPC)
        // can return the same shape `create_block_inner` would.
        return get_block_inner(pool, new_page_id.into_string()).await;
    }

    // Non-page block types ignore `space_id` and follow the legacy
    // path — `content`, `tag` blocks have no space invariant.
    let _ignore_space_id = space_id;
    create_block_inner(
        pool,
        device_id,
        materializer,
        block_type,
        content,
        parent_id,
        position,
    )
    .await
}

/// Edit a block's content.
///
/// Validates the block exists and is not deleted, looks up the previous edit
/// reference for conflict detection, appends an `EditBlock` op, updates the
/// `blocks` table, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist or is soft-deleted
#[instrument(skip(pool, device_id, materializer, to_text), err)]
pub async fn edit_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    to_text: String,
) -> Result<BlockRow, AppError> {
    // F02: Begin IMMEDIATE transaction for atomic validation + op_log + blocks write.
    // All reads (block existence, prev_edit lookup) happen inside the tx
    // to prevent TOCTOU races (a concurrent delete_block could soft-delete
    // the block between validation and update, and another edit could make
    // the prev_edit reference stale). MAINT-112: CommandTx couples commit
    // + post-commit dispatch via `enqueue_edit_background` (the
    // block-type-aware variant that restricts the cache rebuild fan-out).
    let mut tx = CommandTx::begin_immediate(pool, "edit_block").await?;

    // 1. Validate block exists and is not deleted (inside tx = TOCTOU-safe)
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;
    let block_type = existing.block_type;
    let parent_id = existing.parent_id;
    let position = existing.position;

    // 1b. Validate content length
    if to_text.len() > MAX_CONTENT_LENGTH {
        return Err(AppError::Validation(format!(
            "content length {} exceeds maximum {MAX_CONTENT_LENGTH}",
            to_text.len()
        )));
    }

    // FEAT-5i — snapshot pre-mutation dates so the post-commit
    // `notify_gcal_for_op` call can emit a `DirtyEvent` for blocks
    // that appear on the agenda (have `due_date` / `scheduled_date`).
    let gcal_snapshot = if materializer.is_gcal_hook_active() {
        Some(crate::gcal_push::dirty_producer::snapshot_block(&mut tx, &block_id).await?)
    } else {
        None
    };

    // 2. Find prev_edit inside transaction (inlined from recovery::find_prev_edit)
    let prev_edit_row = sqlx::query!(
        "SELECT device_id, seq FROM op_log \
         WHERE json_extract(payload, '$.block_id') = ? \
         AND op_type IN ('edit_block', 'create_block') \
         ORDER BY created_at DESC \
         LIMIT 1",
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;
    let prev_edit = prev_edit_row.map(|r| (r.device_id, r.seq));

    // 3. Build OpPayload
    let block_id_ulid = BlockId::from_trusted(&block_id);
    let payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: block_id_ulid,
        to_text: to_text.clone(),
        prev_edit,
    });

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // 4. Update blocks table within same transaction.
    // `AND deleted_at IS NULL` guard prevents overwriting content on a
    // block that was concurrently soft-deleted.
    sqlx::query("UPDATE blocks SET content = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(&to_text)
        .bind(&block_id)
        .execute(&mut **tx)
        .await?;

    // 5. Commit + dispatch edit background cache tasks (fire-and-forget).
    //    The `block_type` hint restricts the rebuild fan-out so content
    //    blocks skip tags/pages cache work.
    //
    //    Clone `op_record` for the dispatch queue so the post-commit
    //    `notify_gcal_for_op` call still has the original.
    tx.enqueue_edit_background(op_record.clone(), block_type.clone());
    tx.commit_and_dispatch(materializer).await?;

    // FEAT-5i — notify GCal connector post-commit.
    if let Some(snapshot) = gcal_snapshot {
        materializer.notify_gcal_for_op(&op_record, &snapshot);
    }

    // 6. Return response
    Ok(BlockRow {
        id: block_id,
        block_type,
        content: Some(to_text),
        parent_id,
        position,
        deleted_at: None,
        is_conflict: false,
        conflict_type: None,
        todo_state: None,
        priority: None,
        due_date: None,
        scheduled_date: None,
        page_id: existing.page_id,
    })
}

/// Soft-delete a block and all its descendants (cascade).
///
/// Validates the block exists and is not already deleted, appends a
/// `DeleteBlock` op, sets `deleted_at` on the block and all descendants
/// via recursive CTE, and dispatches background cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist
/// - [`AppError::InvalidOperation`] — block is already soft-deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn delete_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
) -> Result<DeleteResponse, AppError> {
    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
    });

    // Single IMMEDIATE transaction: validation + op_log + cascade soft-delete.
    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    // and the actual mutation.
    //
    // MAINT-30 + MAINT-112: `CommandTx::begin_immediate` inherits the
    // slow-acquire tracing from `begin_immediate_logged` AND couples
    // commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "cmd_delete_block").await?;

    // Validate inside transaction (TOCTOU-safe)
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", block_id)
        .fetch_optional(&mut **tx)
        .await?;
    let row = row.ok_or_else(|| AppError::NotFound(format!("block '{block_id}'")))?;
    if row.deleted_at.is_some() {
        return Err(AppError::InvalidOperation(format!(
            "block '{block_id}' is already deleted"
        )));
    }

    // FEAT-3p6 — refuse to delete a non-empty space. The frontend
    // SpaceManageDialog already disables the delete button until the space
    // is empty, but a concurrent device creating a page in the same space
    // between the frontend probe and this IPC would otherwise leave the
    // space soft-deleted with orphan pages whose `space` ref now dangles.
    // The check runs INSIDE this BEGIN IMMEDIATE tx so no concurrent
    // CreateBlock-with-space-property can sneak in between the count and
    // the cascade. Spaces are page blocks carrying `is_space = "true"`;
    // child membership is a `space` ref property on each page.
    let is_space_block = sqlx::query_scalar!(
        "SELECT 1 AS \"flag!: i64\" FROM block_properties \
         WHERE block_id = ? AND key = 'is_space' AND value_text = 'true'",
        block_id,
    )
    .fetch_optional(&mut **tx)
    .await?
    .is_some();
    if is_space_block {
        let child_count: i64 = sqlx::query_scalar!(
            "SELECT COUNT(*) AS \"n!: i64\" FROM blocks b \
             WHERE b.deleted_at IS NULL \
             AND b.is_conflict = 0 \
             AND EXISTS ( \
                 SELECT 1 FROM block_properties p \
                 WHERE p.block_id = b.id \
                 AND p.key = 'space' \
                 AND p.value_ref = ? \
             )",
            block_id,
        )
        .fetch_one(&mut **tx)
        .await?;
        if child_count > 0 {
            return Err(AppError::InvalidOperation(format!(
                "cannot delete space '{block_id}': it contains {child_count} pages"
            )));
        }
    }

    // FEAT-5i — snapshot pre-delete dates so the post-commit
    // `notify_gcal_for_op` call can emit `old_affected_dates = {...},
    // new_affected_dates = []`.
    let gcal_snapshot = if materializer.is_gcal_hook_active() {
        Some(crate::gcal_push::dirty_producer::snapshot_block(&mut tx, &block_id).await?)
    } else {
        None
    };

    // Single timestamp for both op_log and blocks — reverse_delete_block uses
    // record.created_at as deleted_at_ref, so they must match exactly.
    let now = now_rfc3339();

    // Append to op_log within transaction
    let op_record = op_log::append_local_op_in_tx(&mut tx, device_id, payload, now.clone()).await?;

    // Cascade soft-delete within same transaction.
    //
    // `descendants_cte_active!()` filters `is_conflict = 0` AND
    // `deleted_at IS NULL` in the recursive member — conflict copies have
    // independent lifecycles (invariant #9) and already-deleted subtrees
    // must keep their original `deleted_at` timestamp. The shared CTE lives
    // in `crate::block_descendants`.
    let result = sqlx::query(concat!(
        crate::descendants_cte_active!(),
        "UPDATE blocks SET deleted_at = ? \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at IS NULL",
    ))
    .bind(&block_id)
    .bind(&now)
    .execute(&mut **tx)
    .await?;

    // P-4: Remove inherited entries for soft-deleted subtree
    crate::tag_inheritance::remove_subtree_inherited(&mut tx, &block_id).await?;

    // Commit + fire-and-forget background cache dispatch.
    // Clone op_record for the queue so the post-commit
    // `notify_gcal_for_op` call still has the original.
    tx.enqueue_background(op_record.clone());
    tx.commit_and_dispatch(materializer).await?;

    // FEAT-5i — notify GCal connector post-commit.
    if let Some(snapshot) = gcal_snapshot {
        materializer.notify_gcal_for_op(&op_record, &snapshot);
    }

    Ok(DeleteResponse {
        block_id,
        deleted_at: now,
        descendants_affected: result.rows_affected(),
    })
}

/// Restore a soft-deleted block and its descendants.
///
/// Validates the block exists and is deleted with the expected `deleted_at`
/// timestamp (optimistic concurrency guard), appends a `RestoreBlock` op,
/// clears `deleted_at` on matching descendants, and dispatches background
/// cache tasks.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist
/// - [`AppError::InvalidOperation`] — block is not deleted, or `deleted_at` timestamp mismatch
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn restore_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
    deleted_at_ref: String,
) -> Result<RestoreResponse, AppError> {
    // Single IMMEDIATE transaction: validation + op_log + restore.
    // BEGIN IMMEDIATE eagerly acquires the write lock, preventing
    // SQLITE_BUSY_SNAPSHOT and fixing the TOCTOU window between validation
    // and the actual mutation.
    //
    // MAINT-30: slow-acquire timed via `begin_immediate_logged`.
    // MAINT-30 + MAINT-112: CommandTx inherits slow-acquire tracing from
    // begin_immediate_logged AND couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "cmd_restore_block").await?;

    // Validate inside transaction (TOCTOU-safe)
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", block_id)
        .fetch_optional(&mut **tx)
        .await?;

    match row {
        None => {
            return Err(AppError::NotFound(format!("block '{block_id}'")));
        }
        Some(ref r) if r.deleted_at.is_none() => {
            return Err(AppError::InvalidOperation(format!(
                "block '{block_id}' is not deleted"
            )));
        }
        Some(ref r) => {
            if let Some(ref actual_deleted_at) = r.deleted_at {
                if *actual_deleted_at != deleted_at_ref {
                    return Err(AppError::InvalidOperation(format!(
                        "block '{block_id}' deleted_at mismatch: expected '{}', got '{}'",
                        deleted_at_ref, actual_deleted_at
                    )));
                }
            }
        }
    }

    // FEAT-5i — snapshot pre-restore dates so the post-commit
    // `notify_gcal_for_op` call can emit `old_affected_dates = [],
    // new_affected_dates = {dates}`.  At snapshot time the block is
    // still soft-deleted so `was_deleted = true` — `compute_dirty_event`
    // relies on that to distinguish a real restore from a no-op.
    let gcal_snapshot = if materializer.is_gcal_hook_active() {
        Some(crate::gcal_push::dirty_producer::snapshot_block(&mut tx, &block_id).await?)
    } else {
        None
    };

    let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
        deleted_at_ref: deleted_at_ref.clone(),
    });

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // Restore within same transaction.
    //
    // `descendants_cte_standard!()` filters `is_conflict = 0` — conflict
    // copies have independent lifecycles and must not be bulk-restored with
    // the original (invariant #9). Shared CTE in `crate::block_descendants`.
    let result = sqlx::query(concat!(
        crate::descendants_cte_standard!(),
        "UPDATE blocks SET deleted_at = NULL \
         WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?",
    ))
    .bind(&block_id)
    .bind(&deleted_at_ref)
    .execute(&mut **tx)
    .await?;

    // P-4: Recompute inherited tags for restored subtree
    crate::tag_inheritance::recompute_subtree_inheritance(&mut tx, &block_id).await?;

    // Commit + fire-and-forget background cache dispatch. Clone
    // op_record for the queue so the post-commit `notify_gcal_for_op`
    // call still has the original.
    tx.enqueue_background(op_record.clone());
    tx.commit_and_dispatch(materializer).await?;

    // FEAT-5i — notify GCal connector post-commit.
    if let Some(snapshot) = gcal_snapshot {
        materializer.notify_gcal_for_op(&op_record, &snapshot);
    }

    Ok(RestoreResponse {
        block_id,
        restored_count: result.rows_affected(),
    })
}

/// Permanently purge a soft-deleted block and all its descendants.
///
/// Validates the block exists and is already soft-deleted, appends a
/// `PurgeBlock` op, then physically deletes the block, its descendants,
/// and all related rows (tags, properties, links, caches, FTS, drafts,
/// attachments) in a single deferred-FK transaction.
///
/// # Errors
///
/// - [`AppError::NotFound`] — block does not exist
/// - [`AppError::InvalidOperation`] — block is not soft-deleted
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn purge_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: String,
) -> Result<PurgeResponse, AppError> {
    // F03: Single IMMEDIATE transaction for validation + op_log + physical purge.
    // Previously the op_log write and the physical purge were split across two
    // transactions, meaning a crash between them left the op_log recording a
    // purge that never happened.  Now everything is in one atomic tx.
    //
    // MAINT-30: slow-acquire timed via `begin_immediate_logged`. Purge is
    // the most cascade-heavy write path and the most likely to show
    // contention under load.
    // MAINT-30 + MAINT-112: CommandTx inherits slow-acquire tracing from
    // begin_immediate_logged AND couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "cmd_purge_block").await?;

    // Validate inside transaction (TOCTOU-safe)
    let row = sqlx::query!("SELECT deleted_at FROM blocks WHERE id = ?", block_id)
        .fetch_optional(&mut **tx)
        .await?;

    match row {
        None => {
            return Err(AppError::NotFound(format!("block \'{block_id}\'")));
        }
        Some(ref r) if r.deleted_at.is_none() => {
            return Err(AppError::InvalidOperation(format!(
                "block \'{block_id}\' must be soft-deleted before purging"
            )));
        }
        Some(_) => {} // block is deleted, proceed with purge
    }

    let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
        block_id: BlockId::from_trusted(&block_id),
    });

    // Append to op_log within transaction
    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, now_rfc3339()).await?;

    // --- Inline physical purge (previously soft_delete::purge_block) ---
    // Defer FK checks until commit — the entire subtree will be gone by then
    // so no constraints will be violated.
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut **tx)
        .await?;

    // PURGE is the documented exception to invariant #9: the purge CTE
    // (`descendants_cte_purge!()`, defined in `crate::block_descendants`) is
    // the one recursive walk in the codebase that does NOT filter
    // `is_conflict = 0` — the goal is to erase every row descended from the
    // purged block, INCLUDING conflict copies. `depth < 100` still bounds
    // runaway recursion on corrupted parent_id chains. The materializer's
    // `OpType::PurgeBlock` handler mirrors this sequence for remote ops.

    // block_tags: either column may reference a descendant
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM block_tags \
         WHERE block_id IN (SELECT id FROM descendants) \
            OR tag_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // block_tag_inherited (P-4)
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM descendants) \
            OR tag_id IN (SELECT id FROM descendants) \
            OR inherited_from IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // block_properties: owned by descendants
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM block_properties \
         WHERE block_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // block_properties: value_ref pointing into the subtree (NULLify)
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "UPDATE block_properties SET value_ref = NULL \
         WHERE value_ref IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // block_links: either end may be in the subtree
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM block_links \
         WHERE source_id IN (SELECT id FROM descendants) \
            OR target_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // agenda_cache
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM agenda_cache \
         WHERE block_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // tags_cache
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM tags_cache \
         WHERE tag_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // pages_cache
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM pages_cache \
         WHERE page_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // attachments
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM attachments \
         WHERE block_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // block_drafts
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM block_drafts \
         WHERE block_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // Nullify conflict_source refs from blocks outside the subtree
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "UPDATE blocks SET conflict_source = NULL \
         WHERE conflict_source IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // fts_blocks (FTS5 virtual table — no FK, must be cleaned explicitly)
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM fts_blocks \
         WHERE block_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // page_aliases
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM page_aliases \
         WHERE page_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // projected_agenda_cache
    sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM projected_agenda_cache \
         WHERE block_id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    // Delete blocks (deferred FK allows single-statement batch)
    let result = sqlx::query(concat!(
        crate::descendants_cte_purge!(),
        "DELETE FROM blocks \
         WHERE id IN (SELECT id FROM descendants)",
    ))
    .bind(&block_id)
    .execute(&mut **tx)
    .await?;

    let count = result.rows_affected();

    // Commit + fire-and-forget background cache dispatch.
    tx.enqueue_background(op_record);
    tx.commit_and_dispatch(materializer).await?;

    Ok(PurgeResponse {
        block_id,
        purged_count: count,
    })
}

/// Restore ALL soft-deleted blocks in a single transaction.
///
/// Finds root-level deleted blocks (those whose parent is not deleted with the
/// same timestamp), creates a `RestoreBlock` op for each, then clears
/// `deleted_at` on ALL deleted blocks. Recomputes tag inheritance afterward.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn restore_all_deleted_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<BulkTrashResponse, AppError> {
    // MAINT-112: CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "bulk_restore_trash").await?;

    // Find root-level deleted blocks for op-log entries.
    // A "root" is a deleted block whose parent is either NULL, doesn't exist,
    // or has a different deleted_at (i.e., wasn't cascade-deleted together).
    let roots = sqlx::query!(
        "SELECT b.id, b.deleted_at FROM blocks b \
         WHERE b.deleted_at IS NOT NULL \
         AND ( \
           b.parent_id IS NULL \
           OR NOT EXISTS ( \
             SELECT 1 FROM blocks p \
             WHERE p.id = b.parent_id \
             AND p.deleted_at = b.deleted_at \
           ) \
         )"
    )
    .fetch_all(&mut **tx)
    .await?;

    if roots.is_empty() {
        return Ok(BulkTrashResponse { affected_count: 0 });
    }

    let now = now_rfc3339();
    // FEAT-5i — snapshot each root's pre-restore dates inside the tx
    // so the post-commit notifier can emit per-root `DirtyEvent`s.
    // A single root can contain a subtree of many blocks; the
    // connector only tracks the *root* because the agenda projection
    // is keyed on top-level blocks.
    let gcal_hook_active = materializer.is_gcal_hook_active();
    let mut gcal_snapshots: Vec<Option<crate::gcal_push::dirty_producer::BlockDateSnapshot>> =
        Vec::with_capacity(roots.len());
    for root in &roots {
        if gcal_hook_active {
            gcal_snapshots.push(Some(
                crate::gcal_push::dirty_producer::snapshot_block(&mut tx, &root.id).await?,
            ));
        } else {
            gcal_snapshots.push(None);
        }
    }

    let mut op_records = Vec::new();
    // Append one RestoreBlock op per root for sync compatibility.
    // Each op_record is both enqueued for post-commit background
    // dispatch AND retained (via clone) for the post-commit GCal
    // notify loop.
    for root in &roots {
        let deleted_at_ref = root
            .deleted_at
            .clone()
            .expect("query guarantees deleted_at IS NOT NULL");
        let payload = OpPayload::RestoreBlock(RestoreBlockPayload {
            block_id: BlockId::from_trusted(&root.id),
            deleted_at_ref,
        });
        let op_record =
            op_log::append_local_op_in_tx(&mut tx, device_id, payload, now.clone()).await?;
        tx.enqueue_background(op_record.clone());
        op_records.push(op_record);
    }

    // Bulk restore: clear deleted_at on ALL deleted blocks
    let result = sqlx::query!("UPDATE blocks SET deleted_at = NULL WHERE deleted_at IS NOT NULL")
        .execute(&mut **tx)
        .await?;

    let count = result.rows_affected();

    // Recompute tag inheritance for all restored root blocks
    for root in &roots {
        crate::tag_inheritance::recompute_subtree_inheritance(&mut tx, &root.id).await?;
    }

    // Commit + drain enqueued background dispatches in FIFO order.
    tx.commit_and_dispatch(materializer).await?;

    // FEAT-5i — notify GCal connector post-commit, one event per root.
    for (op_record, snapshot) in op_records.iter().zip(gcal_snapshots.iter()) {
        if let Some(snap) = snapshot {
            materializer.notify_gcal_for_op(op_record, snap);
        }
    }

    Ok(BulkTrashResponse {
        affected_count: count,
    })
}

/// Permanently purge ALL soft-deleted blocks in a single transaction.
///
/// Creates `PurgeBlock` ops for root-level deleted blocks, then bulk-deletes
/// all dependent rows and the blocks themselves. Irreversible.
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn purge_all_deleted_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<BulkTrashResponse, AppError> {
    // MAINT-112: CommandTx couples commit + post-commit dispatch.
    let mut tx = CommandTx::begin_immediate(pool, "purge_all_deleted").await?;

    // Find root-level deleted blocks for op-log entries
    let roots = sqlx::query!(
        "SELECT b.id, b.deleted_at FROM blocks b \
         WHERE b.deleted_at IS NOT NULL \
         AND ( \
           b.parent_id IS NULL \
           OR NOT EXISTS ( \
             SELECT 1 FROM blocks p \
             WHERE p.id = b.parent_id \
             AND p.deleted_at = b.deleted_at \
           ) \
         )"
    )
    .fetch_all(&mut **tx)
    .await?;

    if roots.is_empty() {
        return Ok(BulkTrashResponse { affected_count: 0 });
    }

    let now = now_rfc3339();
    for root in &roots {
        let payload = OpPayload::PurgeBlock(PurgeBlockPayload {
            block_id: BlockId::from_trusted(&root.id),
        });
        let op_record =
            op_log::append_local_op_in_tx(&mut tx, device_id, payload, now.clone()).await?;
        tx.enqueue_background(op_record);
    }

    // Defer FK checks until commit
    sqlx::query("PRAGMA defer_foreign_keys = ON")
        .execute(&mut **tx)
        .await?;

    // Cleanup for every table referencing `blocks.id`: match any row whose
    // target block is soft-deleted. The old implementation interpolated a
    // `deleted_set` subquery at runtime via `sqlx::query(&format!(...))`;
    // each query is now inlined so `sqlx::query!` can validate it at compile
    // time. Since ALL deleted blocks (and their descendants — the cascade
    // already ran at the individual purge layer) carry `deleted_at IS NOT
    // NULL`, we do not need a recursive CTE here.

    // block_tags
    sqlx::query!(
        "DELETE FROM block_tags \
         WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL) \
            OR tag_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // block_tag_inherited
    sqlx::query!(
        "DELETE FROM block_tag_inherited \
         WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL) \
            OR tag_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL) \
            OR inherited_from IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // block_properties: owned by deleted blocks
    sqlx::query!(
        "DELETE FROM block_properties \
         WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // block_properties: value_ref pointing to deleted blocks
    sqlx::query!(
        "UPDATE block_properties SET value_ref = NULL \
         WHERE value_ref IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // block_links
    sqlx::query!(
        "DELETE FROM block_links \
         WHERE source_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL) \
            OR target_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // agenda_cache
    sqlx::query!(
        "DELETE FROM agenda_cache \
         WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // tags_cache
    sqlx::query!(
        "DELETE FROM tags_cache \
         WHERE tag_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // pages_cache
    sqlx::query!(
        "DELETE FROM pages_cache \
         WHERE page_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // Collect attachment paths BEFORE deleting rows
    let attachment_rows = sqlx::query_scalar!(
        "SELECT fs_path FROM attachments \
         WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .fetch_all(&mut **tx)
    .await?;

    // attachments
    sqlx::query!(
        "DELETE FROM attachments \
         WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // block_drafts
    sqlx::query!(
        "DELETE FROM block_drafts \
         WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // Nullify conflict_source refs from non-deleted blocks
    sqlx::query!(
        "UPDATE blocks SET conflict_source = NULL \
         WHERE conflict_source IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // fts_blocks
    sqlx::query!(
        "DELETE FROM fts_blocks \
         WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // page_aliases
    sqlx::query!(
        "DELETE FROM page_aliases \
         WHERE page_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // projected_agenda_cache
    sqlx::query!(
        "DELETE FROM projected_agenda_cache \
         WHERE block_id IN (SELECT id FROM blocks WHERE deleted_at IS NOT NULL)"
    )
    .execute(&mut **tx)
    .await?;

    // Delete all deleted blocks
    let result = sqlx::query!("DELETE FROM blocks WHERE deleted_at IS NOT NULL")
        .execute(&mut **tx)
        .await?;

    let count = result.rows_affected();
    // Commit + drain the queued PurgeBlock op records for background
    // dispatch. Attachment-file unlink runs after dispatch (cache
    // rebuilds are independent of the filesystem side effect).
    tx.commit_and_dispatch(materializer).await?;

    // Post-commit: delete physical attachment files
    for path in &attachment_rows {
        let p = std::path::Path::new(path.as_str());
        if p.is_absolute()
            || p.components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            let (path_hash, ext) = anonymize_attachment_path(path);
            tracing::warn!(
                path_hash = %path_hash,
                extension = %ext,
                "skipping attachment deletion: unsafe path"
            );
            continue;
        }
        if let Err(e) = std::fs::remove_file(path) {
            let (path_hash, ext) = anonymize_attachment_path(path);
            tracing::warn!(
                path_hash = %path_hash,
                extension = %ext,
                error = %e,
                "failed to remove attachment file after purge"
            );
        }
    }

    Ok(BulkTrashResponse {
        affected_count: count,
    })
}

/// Set (upsert) a property on a block inside an existing transaction.
///
/// This is the core implementation shared by [`set_property_inner`] (which
/// wraps it in its own transaction) and the recurrence path in
/// [`set_todo_state_inner`] (which batches multiple operations in one tx).
///
/// Returns the updated [`BlockRow`] and the [`op_log::OpRecord`] so the
/// caller can commit the transaction and dispatch background work afterward.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_property_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: String,
    key: &str,
    value_text: Option<String>,
    value_num: Option<f64>,
    value_date: Option<String>,
    value_ref: Option<String>,
) -> Result<(BlockRow, op_log::OpRecord), AppError> {
    // 1. Build and validate the payload before touching the DB
    let prop_payload = SetPropertyPayload {
        block_id: BlockId::from_trusted(&block_id),
        key: key.to_owned(),
        value_text: value_text.clone(),
        value_num,
        value_date: value_date.clone(),
        value_ref: value_ref.clone(),
    };
    validate_set_property(&prop_payload)?;

    // 1b. Date format validation
    if let Some(ref date_str) = value_date {
        if !is_valid_iso_date(date_str) {
            return Err(AppError::Validation(format!(
                "Invalid date format: '{}'. Expected YYYY-MM-DD.",
                date_str
            )));
        }
    }

    // 1c. Reserved key field validation (skip for clear operations where all values are None)
    let is_clear =
        value_text.is_none() && value_num.is_none() && value_date.is_none() && value_ref.is_none();
    if !is_clear {
        match key {
            "due_date" | "scheduled_date" if value_date.is_none() => {
                return Err(AppError::Validation(format!(
                    "Property '{}' requires value_date, not value_text/value_num/value_ref.",
                    key
                )));
            }
            "todo_state" | "priority" if value_text.is_none() => {
                return Err(AppError::Validation(format!(
                    "Property '{}' requires value_text, not value_date/value_num/value_ref.",
                    key
                )));
            }
            _ => {}
        }
    }

    // 1d. Type + options validation against property_definitions.
    //
    // Applies to both reserved (todo_state, priority, due_date, scheduled_date)
    // and non-reserved keys — the select/option check applies wherever a
    // property_definition row exists. The type check is skipped for reserved
    // keys because those values are mapped to fixed columns on `blocks` and
    // their field shape is already constrained by 1c above.
    if !is_clear {
        let def_meta = sqlx::query!(
            "SELECT value_type, options FROM property_definitions WHERE key = ?",
            key,
        )
        .fetch_optional(&mut **tx)
        .await?;

        if let Some(meta) = def_meta {
            let expected_type = meta.value_type;
            let options_json = meta.options;

            // Type validation — only for non-reserved keys. Reserved-key
            // field-shape is enforced by 1c above.
            if !is_reserved_property_key(key) {
                let type_matches = match expected_type.as_str() {
                    "text" | "select" => value_text.is_some() || value_ref.is_some(),
                    "ref" => value_ref.is_some(),
                    "number" => value_num.is_some(),
                    "date" => value_date.is_some(),
                    _ => true,
                };
                if !type_matches {
                    let actual_type = if value_text.is_some() {
                        "text"
                    } else if value_num.is_some() {
                        "number"
                    } else if value_date.is_some() {
                        "date"
                    } else if value_ref.is_some() {
                        "ref"
                    } else {
                        "unknown"
                    };
                    return Err(AppError::Validation(format!(
                        "Property '{}' expects type '{}', got '{}'.",
                        key, expected_type, actual_type
                    )));
                }
            }

            // BUG-20: Options membership validation for select-type
            // properties. When the definition declares a non-NULL options
            // array, the supplied value_text must be one of the listed
            // options. A NULL options column means "no restriction" — a
            // select-type definition without options is treated permissively
            // so custom keys stay flexible.
            if expected_type == "select" {
                if let Some(ref opts_json) = options_json {
                    if let Some(ref actual) = value_text {
                        let allowed: Vec<String> =
                            serde_json::from_str(opts_json).map_err(|e| {
                                AppError::Validation(format!(
                                    "Property '{key}' has malformed options JSON: {e}"
                                ))
                            })?;
                        if !allowed.iter().any(|a| a == actual) {
                            return Err(AppError::Validation(format!(
                                "Property '{key}' value '{actual}' is not in allowed options: {}",
                                allowed.join(", ")
                            )));
                        }
                    }
                }
            }
        }
    }

    // 2. Validate block exists and is not deleted (TOCTOU-safe inside tx)
    let existing: Option<BlockRow> = sqlx::query_as!(
        BlockRow,
        r#"SELECT id, block_type, content, parent_id, position, deleted_at, is_conflict as "is_conflict: bool", conflict_type, todo_state, priority, due_date, scheduled_date, page_id FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id
    )
    .fetch_optional(&mut **tx)
    .await?;

    let existing = existing
        .ok_or_else(|| AppError::NotFound(format!("block '{block_id}' (not found or deleted)")))?;

    // 3. Append SetProperty op to the op_log
    let payload = OpPayload::SetProperty(prop_payload);
    let op_record = op_log::append_local_op_in_tx(tx, device_id, payload, now_rfc3339()).await?;

    // 4. Materialize: route reserved keys to blocks columns, others to block_properties
    if is_reserved_property_key(key) {
        // Match-arms with explicit `sqlx::query!` per column — preserves
        // compile-time SQL validation instead of bypassing it with
        // runtime `sqlx::query(&format!(...))`. Reserved keys are a
        // closed set (see `is_reserved_property_key`) so the match is
        // exhaustive.
        match key {
            "todo_state" => {
                sqlx::query!(
                    "UPDATE blocks SET todo_state = ? WHERE id = ?",
                    value_text,
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            "priority" => {
                sqlx::query!(
                    "UPDATE blocks SET priority = ? WHERE id = ?",
                    value_text,
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            "due_date" => {
                sqlx::query!(
                    "UPDATE blocks SET due_date = ? WHERE id = ?",
                    value_date,
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            "scheduled_date" => {
                sqlx::query!(
                    "UPDATE blocks SET scheduled_date = ? WHERE id = ?",
                    value_date,
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            _ => unreachable!(
                "is_reserved_property_key('{key}') returned true for an unrecognised key"
            ),
        }
    } else {
        sqlx::query(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&block_id)
        .bind(key)
        .bind(&value_text)
        .bind(value_num)
        .bind(&value_date)
        .bind(&value_ref)
        .execute(&mut **tx)
        .await?;
    }

    // Return block + op record; caller is responsible for commit + dispatch.
    Ok((
        BlockRow {
            id: existing.id,
            block_type: existing.block_type,
            content: existing.content,
            parent_id: existing.parent_id,
            position: existing.position,
            deleted_at: existing.deleted_at,
            is_conflict: existing.is_conflict,
            conflict_type: existing.conflict_type,
            todo_state: if key == "todo_state" {
                value_text.clone()
            } else {
                existing.todo_state
            },
            priority: if key == "priority" {
                value_text.clone()
            } else {
                existing.priority
            },
            due_date: if key == "due_date" {
                value_date.clone()
            } else {
                existing.due_date
            },
            scheduled_date: if key == "scheduled_date" {
                value_date.clone()
            } else {
                existing.scheduled_date
            },
            page_id: existing.page_id,
        },
        op_record,
    ))
}

/// Delete (or clear) a property on a block inside an existing transaction.
///
/// Sibling of [`set_property_in_tx`] for the recurrence/timestamp paths in
/// [`set_todo_state_inner`] (H-4) that need to clear `created_at` /
/// `completed_at` as part of a multi-op atomic state transition. Unlike
/// [`delete_property_core`](super::super::delete_property_core) (which opens
/// its own `BEGIN IMMEDIATE` and dispatches background work on commit), this
/// helper runs entirely inside the caller's transaction. The caller is
/// responsible for `tx.enqueue_background(op)` + `tx.commit_and_dispatch(...)`.
///
/// Reserved keys (`todo_state` / `priority` / `due_date` / `scheduled_date`)
/// clear the matching column on `blocks`; non-reserved keys delete the row
/// from `block_properties`.
///
/// Returns the [`op_log::OpRecord`] for the appended `DeleteProperty` op so
/// the caller can queue background dispatch.
pub(crate) async fn delete_property_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    device_id: &str,
    block_id: &str,
    key: &str,
) -> Result<op_log::OpRecord, AppError> {
    // 1. Validate block exists (TOCTOU-safe — read inside the same tx as
    //    the write below).
    let exists = sqlx::query!(
        r#"SELECT 1 as "v: i32" FROM blocks WHERE id = ? AND deleted_at IS NULL"#,
        block_id,
    )
    .fetch_optional(&mut **tx)
    .await?;
    if exists.is_none() {
        return Err(AppError::NotFound(format!(
            "block '{block_id}' (not found or deleted)"
        )));
    }

    // 2. Append DeleteProperty op.
    let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
        block_id: BlockId::from_trusted(block_id),
        key: key.to_owned(),
    });
    let op_record =
        op_log::append_local_op_in_tx(&mut *tx, device_id, payload, now_rfc3339()).await?;

    // 3. Materialize: clear the column for reserved keys, otherwise delete
    //    the `block_properties` row. Mirrors `delete_property_core`.
    if is_reserved_property_key(key) {
        match key {
            "todo_state" => {
                sqlx::query!("UPDATE blocks SET todo_state = NULL WHERE id = ?", block_id)
                    .execute(&mut **tx)
                    .await?;
            }
            "priority" => {
                sqlx::query!("UPDATE blocks SET priority = NULL WHERE id = ?", block_id)
                    .execute(&mut **tx)
                    .await?;
            }
            "due_date" => {
                sqlx::query!("UPDATE blocks SET due_date = NULL WHERE id = ?", block_id)
                    .execute(&mut **tx)
                    .await?;
            }
            "scheduled_date" => {
                sqlx::query!(
                    "UPDATE blocks SET scheduled_date = NULL WHERE id = ?",
                    block_id
                )
                .execute(&mut **tx)
                .await?;
            }
            _ => unreachable!(
                "is_reserved_property_key('{key}') returned true for an unrecognised key"
            ),
        }
    } else {
        sqlx::query("DELETE FROM block_properties WHERE block_id = ? AND key = ?")
            .bind(block_id)
            .bind(key)
            .execute(&mut **tx)
            .await?;
    }

    Ok(op_record)
}

/// Tauri command: create a new block. Delegates to
/// [`create_block_inner_with_space`] which enforces the FEAT-3
/// "every page has a space" invariant at the IPC boundary
/// (BUG-1 / H-3a). The optional `space_id` is required when
/// `block_type == "page"` and ignored otherwise.
// Same 8-arg justification as the inner — see the comment above
// `create_block_inner_with_space`. Tauri command signatures match
// `_inner` shapes 1:1 by convention.
#[allow(clippy::too_many_arguments)]
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn create_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_type: String,
    content: String,
    parent_id: Option<String>,
    position: Option<i64>,
    space_id: Option<String>,
) -> Result<BlockRow, AppError> {
    create_block_inner_with_space(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_type,
        content,
        parent_id,
        position,
        space_id,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: edit a block's content. Delegates to [`edit_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn edit_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    to_text: String,
) -> Result<BlockRow, AppError> {
    edit_block_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id,
        to_text,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: soft-delete a block and descendants. Delegates to [`delete_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn delete_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
) -> Result<DeleteResponse, AppError> {
    delete_block_inner(&pool.0, device_id.as_str(), &materializer, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: restore a soft-deleted block. Delegates to [`restore_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn restore_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
    deleted_at_ref: String,
) -> Result<RestoreResponse, AppError> {
    restore_block_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        block_id,
        deleted_at_ref,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: permanently purge a soft-deleted block. Delegates to [`purge_block_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn purge_block(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
    block_id: String,
) -> Result<PurgeResponse, AppError> {
    purge_block_inner(&pool.0, device_id.as_str(), &materializer, block_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: restore all soft-deleted blocks. Delegates to [`restore_all_deleted_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn restore_all_deleted(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
) -> Result<BulkTrashResponse, AppError> {
    restore_all_deleted_inner(&pool.0, device_id.as_str(), &materializer)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: permanently purge all soft-deleted blocks. Delegates to [`purge_all_deleted_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn purge_all_deleted(
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
) -> Result<BulkTrashResponse, AppError> {
    purge_all_deleted_inner(&pool.0, device_id.as_str(), &materializer)
        .await
        .map_err(sanitize_internal_error)
}

/// Render an attachment path for structured logs without leaking the raw
/// filename.
///
/// Returns `(path_hash, extension)` where:
/// * `path_hash` is a 16-hex-char truncation of `blake3(path.as_bytes())`,
///   stable across runs so repeated failures for the same path correlate.
/// * `extension` is the lowercase file extension (or `""` when there is
///   none). The extension is retained because it's low-entropy and helps
///   diagnose "is this a PDF vs an image" problems without exposing the
///   user's chosen filename.
///
/// Used by the trash/purge paths (`purge_block_inner`,
/// `purge_all_deleted_inner`) where the full path would otherwise be
/// written to the log.
pub(crate) fn anonymize_attachment_path(path: &str) -> (String, String) {
    let hash = blake3::hash(path.as_bytes());
    // First 8 bytes == 16 hex chars is enough for correlation without
    // approaching brute-force reversibility concerns.
    let short_hash: String = hash
        .as_bytes()
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect();
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    (short_hash, extension)
}
