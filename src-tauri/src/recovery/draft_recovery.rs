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
    // F07 / L-135: If the block has been soft-deleted or doesn't exist in
    // the blocks table, the draft is orphan noise — skip the synthetic op
    // and report "already flushed" so the caller deletes the draft row.
    //
    // Uses the pre-computed set from the batch query in recover_at_boot
    // instead of a per-draft SELECT COUNT(*) — avoids the N+1 problem.
    //
    // Logged at warn level (not info) because an orphan draft for a
    // missing/deleted block usually means the parent was soft-deleted
    // before the periodic `spawn_orphan_drafts_sweeper` (PEND-28a M1,
    // wired session 671) ran — worth a breadcrumb.
    if !existing_block_ids.contains(draft.block_id.as_str()) {
        tracing::warn!(block_id = %draft.block_id, "skipping draft for missing/deleted block");
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
    .await?;

    if !parent_valid {
        tracing::info!(block_id = %draft.block_id, "skipping draft: parent block is deleted or missing");
        return Ok(false);
    }

    // Check if an edit_block or create_block op exists for this block_id
    // that supersedes the draft.
    //
    // #384 — same-ms disambiguation by op provenance. `op_log.created_at`
    // and `block_drafts.updated_at` are both INTEGER epoch-ms from
    // `now_ms()`, so a real edit and a draft autosave can land in the SAME
    // millisecond. The previous strict `created_at > draft.updated_at`
    // missed a same-ms edit entirely, so recovery would re-apply the (older)
    // draft content over the newer edit — a silent clobber.
    //
    // The draft row carries no seq/device anchor (block_drafts is just
    // block_id/content/updated_at), so we disambiguate same-ms collisions
    // by *content provenance* instead of timestamp alone:
    //
    //   * Any op with created_at STRICTLY AFTER the draft supersedes it.
    //   * An op at the EXACT same ms supersedes the draft only when its
    //     resulting content DIFFERS from the draft content — that signals a
    //     genuine concurrent/newer edit which must not be clobbered. A
    //     same-ms op whose content EQUALS the draft is this draft's own
    //     flush (harmless), and an equal-content same-ms op does not need to
    //     block recovery (re-applying identical content is a no-op).
    //
    // A bare `>=` is deliberately avoided: it would treat the draft's own
    // same-ms flush (identical content) as "newer" purely on the timestamp,
    // conflating a no-op flush with a real superseding edit. Keying the
    // same-ms case on content difference is the precise signal.
    //
    // The resulting content lives in `$.to_text` for edit_block and
    // `$.content` for create_block, so COALESCE across both reads the right
    // field for either op_type.
    //
    // PERF-26: uses the indexed op_log.block_id column (migration 0030)
    // for O(log N) block-scoped lookups instead of json_extract across the
    // full table. block_id is populated on insert by append_local_op_in_tx
    // and insert_remote_op using OpPayload::block_id() / JSON extraction.
    debug_assert!(
        !draft.block_id.as_str().is_empty()
            && draft
                .block_id
                .as_str()
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "block_id must be alphanumeric (ULID format), got: '{}'",
        draft.block_id,
    );
    // Normalize to uppercase — BlockId serializes uppercase, but the draft
    // table stores the raw string that may differ in case.
    let bid_upper = draft.block_id.as_str().to_ascii_uppercase();
    let row: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE block_id = ?1 \
         AND op_type IN ('edit_block', 'create_block') \
         AND ( \
             created_at > ?2 \
             OR ( \
                 created_at = ?2 \
                 AND COALESCE( \
                     json_extract(payload, '$.to_text'), \
                     json_extract(payload, '$.content') \
                 ) IS NOT ?3 \
             ) \
         )",
        bid_upper,
        draft.updated_at,
        draft.content
    )
    .fetch_one(pool)
    .await?;
    let matching_ops = row;

    if matching_ops == 0 {
        // Draft was NOT flushed — recover it.
        let prev_edit = find_prev_edit(pool, draft.block_id.as_str(), device_id).await?;

        let op = OpPayload::EditBlock(EditBlockPayload {
            block_id: BlockId::from_trusted(draft.block_id.as_str()),
            to_text: draft.content.clone(),
            prev_edit,
        });

        // F01: Use a single IMMEDIATE transaction to atomically write the
        // synthetic op AND update blocks.content — same pattern as
        // commands::edit_block_inner.
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        append_local_op_in_tx(&mut tx, device_id, op, crate::db::now_ms()).await?;
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
///
/// PERF-26: the create_block fallback path uses the indexed op_log.block_id
/// column (migration 0030) for O(log N) lookups instead of json_extract
/// across the full table.
pub async fn find_prev_edit(
    pool: &SqlitePool,
    block_id: &str,
    device_id: &str,
) -> Result<Option<(String, i64)>, AppError> {
    // Sanity check: block_id is expected to be a ULID (alphanumeric).
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
                 WHERE block_id = ? \
                 AND op_type = 'create_block' \
                 LIMIT 1",
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
                // No local head among the edit heads — pick one
                // deterministically.
                //
                // M6 (#348): this is a DAG-frontier tie-break, NOT a
                // causal ordering. The heads are a concurrent frontier
                // across devices, so per-device `seq`s are not comparable
                // (device A's seq 5 and device B's seq 5 are causally
                // unrelated); the old `max_by_key(seq)` therefore picked
                // an arbitrary, device-naming-dependent head. We instead
                // sort on the full `(device_id, seq)` key so the choice is
                // explicit and reproducible across runs. This branch does
                // NOT occur during normal local crash recovery (the local
                // device owns at least one edit head whenever it has a
                // draft to recover, so the `find` above wins); it is a
                // defensive heuristic for a multi-device divergent frontier
                // that real sync-merge logic will eventually own.
                Ok(heads
                    .into_iter()
                    .max_by(|a, b| (a.0.as_str(), a.1).cmp(&(b.0.as_str(), b.1))))
            }
        }
    }
}
