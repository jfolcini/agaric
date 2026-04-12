use sqlx::SqlitePool;

use super::types::*;
use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};
use crate::merge;
use crate::op_log::{self, OpRecord};
use crate::peer_refs;

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/// Get the latest `(device_id, seq, hash)` per device in the op log.
pub async fn get_local_heads(pool: &SqlitePool) -> Result<Vec<DeviceHead>, AppError> {
    let heads = sqlx::query_as::<_, DeviceHead>(
        "SELECT device_id, seq, hash FROM op_log \
         WHERE (device_id, seq) IN \
           (SELECT device_id, MAX(seq) FROM op_log GROUP BY device_id) \
         ORDER BY device_id",
    )
    .fetch_all(pool)
    .await?;
    Ok(heads)
}

/// Compute the set of [`OpRecord`]s to send to a remote peer based on their
/// advertised heads.
///
/// For each device we have ops for:
/// - If remote knows about this device: send ops with `seq > remote_seq`.
/// - If remote doesn't know: send ALL ops for that device.
pub async fn compute_ops_to_send(
    pool: &SqlitePool,
    remote_heads: &[DeviceHead],
) -> Result<Vec<OpRecord>, AppError> {
    let local_heads = get_local_heads(pool).await?;
    let mut ops: Vec<OpRecord> = Vec::new();

    for local_head in &local_heads {
        let after_seq = remote_heads
            .iter()
            .find(|rh| rh.device_id == local_head.device_id)
            .map(|rh| rh.seq)
            .unwrap_or(0);

        if after_seq >= local_head.seq {
            continue; // remote is up-to-date for this device
        }

        let device_ops = op_log::get_ops_since(pool, &local_head.device_id, after_seq).await?;
        ops.extend(device_ops);
    }

    Ok(ops)
}

/// Check whether a full reset is required for sync with a remote peer.
///
/// Returns `true` if the remote advertises a `(device_id, seq)` that we no
/// longer have in our op log (e.g. after compaction).
pub async fn check_reset_required(
    pool: &SqlitePool,
    remote_heads: &[DeviceHead],
) -> Result<bool, AppError> {
    for head in remote_heads {
        match op_log::get_op_by_seq(pool, &head.device_id, head.seq).await {
            Ok(_) => {}
            Err(AppError::NotFound(_)) => return Ok(true),
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

/// Insert remote ops into the local op log and enqueue materialisation.
///
/// All ops are inserted inside a **single explicit transaction** to amortise
/// the per-op `BEGIN IMMEDIATE` / `COMMIT` overhead.  Materialisation tasks
/// are enqueued only *after* the transaction commits, guaranteeing that every
/// op is durable before any of them are processed.
///
/// Duplicates are detected via `INSERT OR IGNORE` on the composite PK
/// `(device_id, seq)` — zero `rows_affected` means the op was already
/// present.
pub async fn apply_remote_ops(
    pool: &SqlitePool,
    materializer: &Materializer,
    ops: Vec<OpTransfer>,
) -> Result<ApplyResult, AppError> {
    use crate::hash::verify_op_record;

    let mut result = ApplyResult {
        inserted: 0,
        duplicates: 0,
        hash_mismatches: 0,
    };
    let mut to_materialize = Vec::new();

    // Convert all transfers to records and verify hashes upfront.
    // Reject the entire batch on the first mismatch.
    let records: Vec<OpRecord> = ops.into_iter().map(OpRecord::from).collect();
    for record in &records {
        verify_op_record(record).map_err(|msg| {
            tracing::warn!(
                device_id = %record.device_id,
                seq = record.seq,
                "integrity check failed during sync: {msg}"
            );
            AppError::InvalidOperation(format!("integrity check failed: {msg}"))
        })?;
    }

    // Wrap all inserts in a single transaction to reduce per-op overhead.
    let mut tx = pool.begin().await?;

    for record in records {
        // Validate payload is well-formed JSON before insertion
        if let Err(e) = serde_json::from_str::<serde_json::Value>(&record.payload) {
            tracing::warn!(
                device_id = %record.device_id,
                seq = record.seq,
                "skipping op with invalid payload: {e}"
            );
            continue;
        }

        // INSERT OR IGNORE — duplicate delivery is a no-op
        let r = sqlx::query(
            "INSERT OR IGNORE INTO op_log \
             (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.device_id)
        .bind(record.seq)
        .bind(&record.parent_seqs)
        .bind(&record.hash)
        .bind(&record.op_type)
        .bind(&record.payload)
        .bind(&record.created_at)
        .execute(&mut *tx)
        .await?;

        if r.rows_affected() > 0 {
            to_materialize.push(record);
            result.inserted += 1;
        } else {
            result.duplicates += 1;
        }
    }

    tx.commit().await?;

    // Enqueue materialization AFTER commit — ensures all ops are durable
    // before any are processed.
    if !to_materialize.is_empty() {
        materializer
            .enqueue_foreground(MaterializeTask::BatchApplyOps(to_materialize))
            .await?;
    }

    Ok(result)
}

/// After receiving all ops, merge blocks that have diverged between two
/// devices.
///
/// Handles four kinds of concurrent-edit conflicts:
///
/// 1. **`edit_block` divergence** — finds blocks with concurrent edits from
///    both devices, performs three-way text merge via [`merge::merge_block`].
/// 2. **`set_property` conflicts** — concurrent property changes on the same
///    `(block_id, key)` pair are resolved via Last-Writer-Wins
///    ([`merge::resolve_property_conflict`]).
/// 3. **`move_block` conflicts** — concurrent reparenting of the same block
///    is resolved via LWW (later `created_at` wins, with `device_id`
///    tiebreaker).
/// 4. **`delete_block` vs `edit_block`** — if one device deleted a block
///    while the other edited it, the edit wins and the block is resurrected
///    via a `restore_block` op.
///
/// **Not handled as a conflict: `move_block` vs `delete_block`.**  Both ops
/// apply in sequence and the block ends up deleted regardless of order
/// (commutativity).  A move to a new parent followed by a delete still
/// soft-deletes the block; a delete followed by a move updates a
/// soft-deleted row's parent (harmless).  No resolution op is needed.
pub async fn merge_diverged_blocks(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    remote_device_id: &str,
) -> Result<MergeResults, AppError> {
    use crate::dag;
    use sqlx::Row;

    let mut results = MergeResults {
        clean_merges: 0,
        conflicts: 0,
        already_up_to_date: 0,
        property_lww: 0,
        move_lww: 0,
        delete_edit_resurrect: 0,
    };

    // ── 1. edit_block divergence ──────────────────────────────────────────
    let rows = sqlx::query(
        "SELECT json_extract(payload, '$.block_id') as block_id \
         FROM op_log WHERE device_id IN (?, ?) AND op_type = 'edit_block' \
         GROUP BY json_extract(payload, '$.block_id') \
         HAVING COUNT(DISTINCT device_id) > 1",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    for row in rows {
        let block_id: String = row.try_get("block_id")?;

        let heads = dag::get_block_edit_heads(pool, &block_id).await?;
        if heads.len() < 2 {
            continue;
        }

        // Find our head and their head
        let our_head = heads.iter().find(|(d, _)| d == device_id);
        let their_head = heads
            .iter()
            .find(|(d, _)| d == remote_device_id)
            .or_else(|| heads.iter().find(|(d, _)| d != device_id));

        if let (Some(ours), Some(theirs)) = (our_head, their_head) {
            // Idempotency guard (S-10): skip if a previous merge op already
            // integrated their head.  After a merge, get_block_edit_heads
            // still returns 2 heads (one per device) because the merge op
            // only advances the LOCAL device's max seq.  Without this
            // check, merge_block would be called again on every subsequent
            // sync, creating duplicate merge ops.
            if dag::has_merge_for_heads(pool, &block_id, theirs).await? {
                results.already_up_to_date += 1;
                continue;
            }

            let outcome = merge::merge_block(pool, device_id, &block_id, ours, theirs).await?;

            match outcome {
                merge::MergeOutcome::Merged(ref record) => {
                    materializer
                        .enqueue_foreground(MaterializeTask::ApplyOp(record.clone()))
                        .await?;
                    results.clean_merges += 1;
                }
                merge::MergeOutcome::ConflictCopy {
                    ref conflict_block_op,
                    ..
                } => {
                    materializer
                        .enqueue_foreground(MaterializeTask::ApplyOp(conflict_block_op.clone()))
                        .await?;
                    results.conflicts += 1;
                }
                merge::MergeOutcome::AlreadyUpToDate => {
                    results.already_up_to_date += 1;
                }
            }
        }
    }

    // ── 2. set_property conflicts (LWW) ──────────────────────────────────
    // Batch query: find all conflicting (block_id, key) pairs AND fetch the
    // latest op per device per pair in a single pass using ROW_NUMBER().
    // This replaces the former N+1 pattern (1 query to find pairs + 2
    // queries per pair).
    let prop_op_rows = sqlx::query(
        "WITH conflict_keys AS ( \
             SELECT json_extract(payload, '$.block_id') as block_id, \
                    json_extract(payload, '$.key') as prop_key \
             FROM op_log \
             WHERE device_id IN (?, ?) AND op_type = 'set_property' \
             GROUP BY json_extract(payload, '$.block_id'), \
                      json_extract(payload, '$.key') \
             HAVING COUNT(DISTINCT device_id) > 1 \
         ), \
         ranked AS ( \
             SELECT o.device_id, o.seq, o.parent_seqs, o.hash, o.op_type, \
                    o.payload, o.created_at, \
                    json_extract(o.payload, '$.block_id') as block_id, \
                    json_extract(o.payload, '$.key') as prop_key, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY o.device_id, \
                            json_extract(o.payload, '$.block_id'), \
                            json_extract(o.payload, '$.key') \
                        ORDER BY o.seq DESC \
                    ) as rn \
             FROM op_log o \
             INNER JOIN conflict_keys ck \
               ON json_extract(o.payload, '$.block_id') = ck.block_id \
              AND json_extract(o.payload, '$.key') = ck.prop_key \
             WHERE o.device_id IN (?, ?) AND o.op_type = 'set_property' \
         ) \
         SELECT device_id, seq, parent_seqs, hash, op_type, payload, \
                created_at, block_id, prop_key \
         FROM ranked WHERE rn = 1 \
         ORDER BY block_id, prop_key, device_id",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    // Group batch rows by (block_id, prop_key), then resolve each conflict.
    {
        use std::collections::HashMap;
        let mut groups: HashMap<(String, String), (Option<OpRecord>, Option<OpRecord>)> =
            HashMap::new();
        for row in &prop_op_rows {
            let bid: String = row.try_get("block_id")?;
            let pk: String = row.try_get("prop_key")?;
            let dev: String = row.try_get("device_id")?;
            let op = OpRecord {
                device_id: dev.clone(),
                seq: row.try_get::<i64, _>("seq")?,
                parent_seqs: row.try_get::<Option<String>, _>("parent_seqs")?,
                hash: row.try_get::<String, _>("hash")?,
                op_type: row.try_get::<String, _>("op_type")?,
                payload: row.try_get::<String, _>("payload")?,
                created_at: row.try_get::<String, _>("created_at")?,
            };
            let entry = groups.entry((bid, pk)).or_insert((None, None));
            if dev == device_id {
                entry.0 = Some(op);
            } else {
                entry.1 = Some(op);
            }
        }

        for ((bid, pk), (op_a_opt, op_b_opt)) in groups {
            if let (Some(op_a), Some(op_b)) = (op_a_opt, op_b_opt) {
                let resolution = merge::resolve_property_conflict(&op_a, &op_b)?;

                // Idempotent guard: skip if the local device already has the
                // winning value (e.g. from a previous merge pass).  Without
                // this check we would append a redundant resolution op on
                // every subsequent sync because the historical ops still
                // satisfy the HAVING clause.
                let current_local: crate::op::SetPropertyPayload =
                    serde_json::from_str(&op_a.payload)?;
                if current_local == resolution.winner_value {
                    continue;
                }

                // Apply the winner by appending a new set_property op
                let winning_payload = crate::op::OpPayload::SetProperty(resolution.winner_value);
                let new_record = op_log::append_local_op_at(
                    pool,
                    device_id,
                    winning_payload,
                    crate::now_rfc3339(),
                )
                .await?;

                tracing::debug!(
                    "LWW auto-resolved property conflict for block {} key {}",
                    bid,
                    pk
                );

                materializer
                    .enqueue_foreground(MaterializeTask::ApplyOp(new_record))
                    .await?;
                results.property_lww += 1;
            }
        }
    }

    // ── 3. move_block conflicts (LWW) ────────────────────────────────────
    // Batch query: find all conflicting block_ids AND fetch the latest
    // move_block op per device per block in a single pass using
    // ROW_NUMBER().  Replaces the former N+1 pattern.
    let move_op_rows = sqlx::query(
        "WITH conflict_blocks AS ( \
             SELECT json_extract(payload, '$.block_id') as block_id \
             FROM op_log \
             WHERE device_id IN (?, ?) AND op_type = 'move_block' \
             GROUP BY json_extract(payload, '$.block_id') \
             HAVING COUNT(DISTINCT device_id) > 1 \
         ), \
         ranked AS ( \
             SELECT o.device_id, o.seq, o.parent_seqs, o.hash, o.op_type, \
                    o.payload, o.created_at, \
                    json_extract(o.payload, '$.block_id') as block_id, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY o.device_id, \
                            json_extract(o.payload, '$.block_id') \
                        ORDER BY o.seq DESC \
                    ) as rn \
             FROM op_log o \
             INNER JOIN conflict_blocks cb \
               ON json_extract(o.payload, '$.block_id') = cb.block_id \
             WHERE o.device_id IN (?, ?) AND o.op_type = 'move_block' \
         ) \
         SELECT device_id, seq, parent_seqs, hash, op_type, payload, \
                created_at, block_id \
         FROM ranked WHERE rn = 1 \
         ORDER BY block_id, device_id",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    // Group batch rows by block_id, then resolve each conflict.
    {
        use std::collections::HashMap;
        let mut groups: HashMap<String, (Option<OpRecord>, Option<OpRecord>)> = HashMap::new();
        for row in &move_op_rows {
            let bid: String = row.try_get("block_id")?;
            let dev: String = row.try_get("device_id")?;
            let op = OpRecord {
                device_id: dev.clone(),
                seq: row.try_get::<i64, _>("seq")?,
                parent_seqs: row.try_get::<Option<String>, _>("parent_seqs")?,
                hash: row.try_get::<String, _>("hash")?,
                op_type: row.try_get::<String, _>("op_type")?,
                payload: row.try_get::<String, _>("payload")?,
                created_at: row.try_get::<String, _>("created_at")?,
            };
            let entry = groups.entry(bid).or_insert((None, None));
            if dev == device_id {
                entry.0 = Some(op);
            } else {
                entry.1 = Some(op);
            }
        }

        for (bid, (op_a_opt, op_b_opt)) in groups {
            if let (Some(op_a), Some(op_b)) = (op_a_opt, op_b_opt) {
                // LWW: later created_at wins, with device_id tiebreaker
                let winner = match op_a.created_at.cmp(&op_b.created_at) {
                    std::cmp::Ordering::Greater => &op_a,
                    std::cmp::Ordering::Less => &op_b,
                    std::cmp::Ordering::Equal => {
                        if op_a.device_id >= op_b.device_id {
                            &op_a
                        } else {
                            &op_b
                        }
                    }
                };

                let winner_move: crate::op::MoveBlockPayload =
                    serde_json::from_str(&winner.payload)?;

                // Idempotent guard: skip if the local device's latest move
                // already matches the winning move (avoids infinite
                // re-resolution).
                let local_move: crate::op::MoveBlockPayload = serde_json::from_str(&op_a.payload)?;
                if local_move == winner_move {
                    continue;
                }

                let move_payload = crate::op::OpPayload::MoveBlock(winner_move);
                let new_record =
                    op_log::append_local_op_at(pool, device_id, move_payload, crate::now_rfc3339())
                        .await?;

                tracing::debug!("LWW auto-resolved move conflict for block {}", bid);

                materializer
                    .enqueue_foreground(MaterializeTask::ApplyOp(new_record))
                    .await?;
                results.move_lww += 1;
            }
        }
    }

    // ── 4. delete_block vs edit_block (edit wins → resurrect) ────────────
    let del_edit_rows = sqlx::query(
        "SELECT json_extract(payload, '$.block_id') as block_id \
         FROM op_log \
         WHERE device_id IN (?, ?) AND op_type IN ('delete_block', 'edit_block') \
         GROUP BY json_extract(payload, '$.block_id') \
         HAVING COUNT(DISTINCT op_type) > 1 AND COUNT(DISTINCT device_id) > 1",
    )
    .bind(device_id)
    .bind(remote_device_id)
    .fetch_all(pool)
    .await?;

    for row in del_edit_rows {
        let block_id: String = row.try_get("block_id")?;

        // Fetch the block's deleted_at to build the RestoreBlockPayload
        let block_row = sqlx::query("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(&block_id)
            .fetch_optional(pool)
            .await?;

        let deleted_at_value: String = match block_row {
            Some(ref r) => r
                .try_get::<Option<String>, _>("deleted_at")?
                .unwrap_or_default(),
            None => String::new(),
        };

        // Idempotent guard: only resurrect if the block is actually deleted
        // in the materialized table.  On repeated syncs the delete_block and
        // edit_block ops still sit in op_log (satisfying the HAVING clause)
        // even after a previous restore.  Without this check we would emit
        // a redundant restore_block op on every subsequent sync.
        // This also handles the race where the delete hasn't been materialised
        // yet — we correctly skip and let the materialiser process in order.
        if deleted_at_value.is_empty() {
            continue;
        }

        // Edit wins — resurrect the block
        let restore_payload = crate::op::OpPayload::RestoreBlock(crate::op::RestoreBlockPayload {
            block_id: crate::ulid::BlockId::from_trusted(&block_id),
            deleted_at_ref: deleted_at_value,
        });
        let new_record =
            op_log::append_local_op_at(pool, device_id, restore_payload, crate::now_rfc3339())
                .await?;

        materializer
            .enqueue_foreground(MaterializeTask::ApplyOp(new_record))
            .await?;
        results.delete_edit_resurrect += 1;
    }

    Ok(results)
}

/// Complete a sync session — update peer_refs with the final hashes.
pub async fn complete_sync(
    pool: &SqlitePool,
    peer_id: &str,
    last_received_hash: &str,
    last_sent_hash: &str,
) -> Result<(), AppError> {
    peer_refs::update_on_sync(pool, peer_id, last_received_hash, last_sent_hash).await
}
