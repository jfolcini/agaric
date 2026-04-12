use sqlx::SqlitePool;
use std::collections::HashSet;

use crate::error::AppError;
use crate::op::{EditBlockPayload, OpPayload};
use crate::op_log::append_local_op_in_tx;
use crate::ulid::BlockId;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Process a single draft: returns `Ok(true)` if the draft was recovered
/// (synthetic op created), `Ok(false)` if it was already flushed.
///
/// When recovering, both the op_log append and the `blocks.content` update
/// are wrapped in a single IMMEDIATE transaction — mirroring the production
/// path in `commands::edit_block_inner`. This ensures `blocks.content` is
/// always consistent with the op_log after recovery.
///
/// ## Materializer note (F04)
///
/// Recovery runs **before** the materializer is created in the boot sequence
/// (see `lib.rs`), so we cannot dispatch background cache-rebuild tasks
/// here. Caches (tags, pages, FTS, block_links) will be rebuilt on the
/// first materializer dispatch after boot. This is by design — the
/// materializer's stale-while-revalidate pattern handles it.
pub(super) async fn recover_single_draft(
    pool: &SqlitePool,
    device_id: &str,
    draft: &crate::draft::Draft,
    existing_block_ids: &HashSet<String>,
) -> Result<bool, AppError> {
    // F07: If the block has been soft-deleted or doesn't exist in the blocks
    // table, the draft is irrelevant. Just report it as "already flushed" so
    // it gets cleaned up (the caller deletes all draft rows regardless of
    // outcome).
    //
    // Uses the pre-computed set from the batch query in recover_at_boot
    // instead of a per-draft SELECT COUNT(*) — avoids the N+1 problem.
    if !existing_block_ids.contains(&draft.block_id) {
        tracing::info!(block_id = %draft.block_id, "skipping draft for missing/deleted block");
        return Ok(false);
    }

    // F08: If the block's parent has been soft-deleted, skip recovery to avoid
    // creating an orphan block.
    let parent_valid: bool = sqlx::query_scalar!(
        r#"SELECT CASE
            WHEN b.parent_id IS NULL THEN 1
            WHEN EXISTS (SELECT 1 FROM blocks p WHERE p.id = b.parent_id AND p.deleted_at IS NULL) THEN 1
            ELSE 0
        END AS "valid: bool"
        FROM blocks b WHERE b.id = ?"#,
        draft.block_id
    )
    .fetch_one(pool)
    .await?
    .unwrap_or(false);

    if !parent_valid {
        tracing::info!(block_id = %draft.block_id, "skipping draft: parent block is deleted or missing");
        return Ok(false);
    }

    // Check if an edit_block or create_block op exists for this block_id
    // with created_at strictly after the draft's updated_at.
    //
    // TODO: add index or extracted column for production scale — the
    // json_extract() call forces a full table scan with JSON parsing per row.
    // A LIKE pre-filter narrows candidates before the expensive json_extract.
    //
    // Safety: block_id is expected to be a ULID (alphanumeric, no LIKE
    // wildcards or JSON escape characters). Assert this so the LIKE
    // pre-filter is correct.
    debug_assert!(
        !draft.block_id.is_empty()
            && draft
                .block_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "block_id must be alphanumeric (ULID format), got: '{}'",
        draft.block_id,
    );
    // Normalize to uppercase — BlockId serializes uppercase, but the draft
    // table stores the raw string that may differ in case.
    let bid_upper = draft.block_id.to_ascii_uppercase();
    let row: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE payload LIKE '%\"block_id\":\"' || ? || '\"%' \
         AND json_extract(payload, '$.block_id') = ? \
         AND op_type IN ('edit_block', 'create_block') \
         AND created_at > ?",
        bid_upper,
        bid_upper,
        draft.updated_at
    )
    .fetch_one(pool)
    .await?;
    let matching_ops = row;

    if matching_ops == 0 {
        // Draft was NOT flushed — recover it.
        let prev_edit = find_prev_edit(pool, &draft.block_id, device_id).await?;

        let op = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(&draft.block_id),
            to_text: draft.content.clone(),
            prev_edit,
        });

        // F01: Use a single IMMEDIATE transaction to atomically write the
        // synthetic op AND update blocks.content — same pattern as
        // commands::edit_block_inner.
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        append_local_op_in_tx(&mut tx, device_id, op, crate::now_rfc3339()).await?;
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind(&draft.content)
            .bind(&draft.block_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        tracing::info!(block_id = %draft.block_id, "recovered unflushed draft");
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Find the most recent edit head for a given block using DAG-based resolution.
///
/// ## Phase 4 DAG-based resolution (replaces `ORDER BY created_at DESC`)
///
/// Uses [`crate::dag::get_block_edit_heads`] to discover all `edit_block`
/// heads across devices, then resolves to a single `(device_id, seq)`:
///
/// - **No edit heads**: falls back to the `create_block` op for the block
///   (the root of the edit chain). Returns `None` if no ops exist at all.
/// - **Single head**: returns it directly — the common single-device case.
/// - **Multiple heads** (concurrent edits from different devices): prefers
///   the local device's head (since this runs during crash recovery of a
///   local draft). Falls back to the highest-seq head if no local head
///   exists (defensive — shouldn't occur during local crash recovery).
///   Emits a `tracing::warn` for observability.
///
/// This replaces the Phase 1 `ORDER BY created_at DESC` approach, which
/// could select a causally-earlier op from a device with a faster clock
/// over a causally-later op from a device with a slower clock.
// TODO: add index or extracted column for production scale — json_extract()
// forces a full table scan with JSON parsing per row. A LIKE pre-filter
// narrows candidates before the expensive json_extract (in the
// create_block fallback path).
pub async fn find_prev_edit(
    pool: &SqlitePool,
    block_id: &str,
    device_id: &str,
) -> Result<Option<(String, i64)>, AppError> {
    // Safety: block_id is expected to be a ULID (alphanumeric, no LIKE
    // wildcards or JSON escape characters). Assert this so the LIKE
    // pre-filter is correct.
    debug_assert!(
        !block_id.is_empty()
            && block_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "block_id must be alphanumeric (ULID format), got: '{block_id}'",
    );
    // Normalize to uppercase — BlockId serializes uppercase in JSON payloads.
    let bid_upper = block_id.to_ascii_uppercase();

    // Phase 4: Use DAG-based head resolution instead of created_at ordering.
    let heads = crate::dag::get_block_edit_heads(pool, &bid_upper).await?;

    match heads.len() {
        0 => {
            // No edit_block heads — fall back to the create_block op (root
            // of the edit chain). If no create_block exists either, there
            // are no ops for this block and prev_edit is None.
            let maybe_create = sqlx::query!(
                "SELECT device_id, seq FROM op_log \
                 WHERE payload LIKE '%\"block_id\":\"' || ? || '\"%' \
                 AND json_extract(payload, '$.block_id') = ? \
                 AND op_type = 'create_block' \
                 LIMIT 1",
                bid_upper,
                bid_upper
            )
            .fetch_optional(pool)
            .await?;
            Ok(maybe_create.map(|r| (r.device_id, r.seq)))
        }
        1 => {
            // Single head — use it directly. Common single-device case.
            Ok(Some(heads.into_iter().next().unwrap()))
        }
        _ => {
            // Multiple heads: concurrent edits from different devices.
            // For crash recovery, prefer the local device's head since we
            // are recovering a local draft. The sync orchestrator (when
            // built later) will handle merging divergent heads.
            tracing::warn!(
                block_id = %bid_upper,
                head_count = heads.len(),
                "multiple edit heads detected during crash recovery; \
                 preferring local device head"
            );

            if let Some(local_head) = heads.iter().find(|(dev, _)| dev == device_id) {
                Ok(Some(local_head.clone()))
            } else {
                // No local head among the edit heads — fall back to highest
                // seq. This case shouldn't happen during local crash recovery
                // (the local device should have at least one edit head if it
                // has a draft to recover), but handle it defensively.
                Ok(heads.into_iter().max_by_key(|(_, seq)| *seq))
            }
        }
    }
}
