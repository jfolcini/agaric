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
/// ## Materializer note (F04 / #620)
///
/// `recover_at_boot` receives the already-created materializer, and the
/// boot-time op-log replay (step 1.5) has fully drained the foreground
/// queue before the draft loop runs. The synthetic op is therefore
/// dispatched as a foreground `ApplyOp` after the recovery tx commits, so
/// the per-space `LoroEngine` (authoritative per `loro/snapshot.rs`)
/// observes the recovered content and the apply cursor advances over the
/// synthetic seq. Without this dispatch the engine misses the recovered
/// text permanently once a later op's `MAX`-semantics cursor advance leaps
/// past the synthetic seq — risking old-text resurrection on a later CRDT
/// merge or `save_all_engines`. Background cache rebuilds (tags, pages,
/// FTS, block_links) are still handled separately by
/// `refresh_caches_for_recovered_drafts`.
pub(super) async fn recover_single_draft(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &crate::materializer::Materializer,
    draft: &crate::draft::Draft,
    existing_block_ids: &HashSet<String>,
) -> Result<bool, AppError> {
    // F07 / If the block has been soft-deleted or doesn't exist in
    // the blocks table, the draft is orphan noise — skip the synthetic op
    // and report "already flushed" so the caller deletes the draft row.
    //
    // Uses the pre-computed set from the batch query in recover_at_boot
    // instead of a per-draft SELECT COUNT(*) — avoids the N+1 problem.
    //
    // Logged at warn level (not info) because an orphan draft for a
    // missing/deleted block usually means the parent was soft-deleted
    // Before the periodic `spawn_orphan_drafts_sweeper` (
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
    // #1256 — MONOTONIC supersession anchor (replaces the #384 wall-clock
    // comparison). `op_log.created_at` and `block_drafts.updated_at` are both
    // INTEGER epoch-ms from `now_ms()`, which `db/pool.rs` documents as
    // NON-monotonic: it steps BACKWARD on an NTP correction or a manual clock
    // change. The old check counted ops with `created_at > draft.updated_at`
    // (plus a same-ms content tie-breaker). A backward step > 1 ms between the
    // last `save_draft` and the superseding flush op made the flush op's
    // `created_at < draft.updated_at` → 0 matching ops → recovery re-applied
    // the OLDER draft as a fresh `edit_block`, clobbering the newer edit.
    //
    // The fix: each draft now carries `(draft_anchor_device, draft_anchor_seq)`
    // — the local device's op-log high-water `MAX(seq)` captured at save time
    // (migration 0092, written by `draft::save_draft`). `seq` is a per-device
    // strictly-increasing counter (`op_log` PRIMARY KEY `(device_id, seq)`,
    // assigned via `COALESCE(MAX(seq),0)+1`), so it is immune to wall-clock
    // motion. A draft is SUPERSEDED iff a block-scoped op exists with
    //
    //     device_id = <anchor device>  AND  seq > draft_anchor_seq
    //
    // — i.e. an op the draft's view had not yet seen. This is a pure integer
    // comparison within a single per-device seq space; no timestamps, no
    // content tie-breaker, clock-independent.
    //
    // Multi-device note: `seq` is only comparable WITHIN one device's space
    // (device A's seq 5 and device B's seq 5 are causally unrelated). Drafts
    // are device-local and never synced, so the anchor device IS the local
    // device that typed the draft; the superseding flush comes from that same
    // device. We therefore scope the comparison to `draft_anchor_device`. A
    // NULL anchor device (a draft that survived the 0092 upgrade with the
    // backfill default) falls back to the recovering `device_id`, and the
    // anchor seq backfills to 0, so ANY existing op on the local device has
    // `seq > 0` and supersedes it — the safe bias that defers to existing ops.
    //
    // Uses the indexed op_log.block_id column (migration 0030)
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
    // A NULL anchor device (legacy/backfilled draft) is treated as the
    // recovering device's seq space.
    let anchor_device = draft.draft_anchor_device.as_deref().unwrap_or(device_id);
    let row: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log \
         WHERE block_id = ?1 \
         AND op_type IN ('edit_block', 'create_block') \
         AND device_id = ?2 \
         AND seq > ?3",
        bid_upper,
        anchor_device,
        draft.draft_anchor_seq
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
        // commands::edit_block_inner. The direct content UPDATE keeps SQL
        // consistent with op_log even if the engine dispatch below fails.
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        let record = append_local_op_in_tx(&mut tx, device_id, op, crate::db::now_ms()).await?;
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind(&draft.content)
            .bind(&draft.block_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;

        // #620 / #1322: dispatch the synthetic record to the materializer as a
        // foreground ApplyOp so the Loro engine applies the recovered content
        // and the apply cursor advances over the synthetic seq. The apply is
        // idempotent over the direct SQL write above (the EditBlock projection
        // writes the same content).
        //
        // #1322: if the enqueue fails, the op is committed to op_log but the
        // engine never observes it — it sits with `seq > cursor`, unapplied.
        // Returning `Ok(true)` here would let the caller push this block into
        // `drafts_recovered` and report a phantom success while the engine is
        // silently stale. Instead we escalate to `error!` and return `Err`, so
        // the caller funnels it into `draft_errors` (an honest failure report).
        // The committed op_log row is NOT rolled back — the SQL recovery is
        // intact and a later boot replay can still apply it; only the
        // success-claim is withheld.
        if let Err(e) = materializer
            .enqueue_foreground(crate::materializer::MaterializeTask::ApplyOp(
                std::sync::Arc::new(record),
            ))
            .await
        {
            tracing::error!(
                block_id = %draft.block_id,
                error = %e,
                "draft recovery: failed to enqueue synthetic edit op for engine \
                 apply — the Loro engine has not observed the recovered content; \
                 reporting recovery as failed rather than a phantom success (#1322)"
            );
            return Err(AppError::Channel(format!(
                "draft recovery: failed to enqueue synthetic edit op for block {}: {e}",
                draft.block_id
            )));
        }

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
/// The create_block fallback path uses the indexed op_log.block_id
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
            // #383: deterministic LIMIT 1 — without an ORDER BY, SQLite is
            // free to return any matching row, so the create_block "chain
            // root" picked here could vary between runs. Order by
            // (created_at, device_id, seq) ascending so the earliest create
            // op (the true chain root) is always selected.
            let maybe_create = sqlx::query!(
                "SELECT device_id, seq FROM op_log \
                 WHERE block_id = ? \
                 AND op_type = 'create_block' \
                 ORDER BY created_at ASC, device_id ASC, seq ASC \
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
