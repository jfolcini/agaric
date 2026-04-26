//! Async recurrence flow: when a task transitions to DONE, read its repeat
//! properties, evaluate end conditions, and create the next sibling occurrence.

use sqlx::SqlitePool;

use super::parser::shift_date;
use crate::commands::{create_block_in_tx, get_block_inner, is_valid_iso_date, set_property_in_tx};
use crate::materializer::Materializer;
use crate::op_log;
use crate::pagination::NULL_POSITION_SENTINEL;

/// Handle recurrence when a task transitions to DONE.
///
/// This checks for a `repeat` property on the block and, if present:
/// 1. Pre-computes shifted dates for end-condition checks
/// 2. Evaluates end conditions (`repeat-until`, `repeat-count`/`repeat-seq`)
/// 3. Creates a new sibling block with TODO state and shifted dates
/// 4. Copies recurrence properties to the new block
///
/// Returns `Ok(true)` if a sibling was created, `Ok(false)` if recurrence
/// was skipped (no repeat rule, end condition met, etc.).
pub(crate) async fn handle_recurrence(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: &str,
) -> Result<bool, crate::error::AppError> {
    // Check for repeat property
    let repeat_rule: Option<String> = sqlx::query_scalar(
        "SELECT value_text FROM block_properties WHERE block_id = ?1 AND key = 'repeat'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;

    let Some(rule) = repeat_rule else {
        return Ok(false);
    };

    // Fetch the original block (with updated DONE state)
    let original = get_block_inner(pool, block_id.to_string()).await?;

    // Pre-compute shifted dates for end-condition checks
    let shifted_due = original
        .due_date
        .as_ref()
        .and_then(|d| shift_date(d, &rule));
    let shifted_sched = original
        .scheduled_date
        .as_ref()
        .and_then(|d| shift_date(d, &rule));

    // The "reference" shifted date used for end-condition comparison:
    // prefer due_date, fall back to scheduled_date.
    let reference_date = shifted_due.as_deref().or(shifted_sched.as_deref());

    // --- End condition: repeat-until ---
    let repeat_until: Option<String> = sqlx::query_scalar(
        "SELECT value_date FROM block_properties WHERE block_id = ?1 AND key = 'repeat-until'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;

    if let Some(ref until_str) = repeat_until {
        if let Some(ref_date) = reference_date {
            // Simple lexicographic comparison works for YYYY-MM-DD strings
            if ref_date > until_str.as_str() {
                // Shifted date is past the repeat-until deadline — stop recurring
                return Ok(false);
            }
        }
    }

    // --- End condition: repeat-count / repeat-seq ---
    let repeat_count: Option<f64> = sqlx::query_scalar(
        "SELECT value_num FROM block_properties WHERE block_id = ?1 AND key = 'repeat-count'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;

    let repeat_seq: Option<f64> = sqlx::query_scalar(
        "SELECT value_num FROM block_properties WHERE block_id = ?1 AND key = 'repeat-seq'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;

    if let Some(count) = repeat_count {
        // repeat_seq and repeat_count are non-negative whole numbers stored as f64
        #[allow(clippy::cast_possible_truncation)]
        let current_seq = repeat_seq.unwrap_or(0.0) as i64;
        #[allow(clippy::cast_possible_truncation)]
        let max_count = count as i64;
        if current_seq >= max_count {
            // Already exhausted the repeat count — stop recurring
            return Ok(false);
        }
    }

    // --- Resolve repeat-origin for the chain ---
    let repeat_origin: Option<String> = sqlx::query_scalar(
        "SELECT value_ref FROM block_properties WHERE block_id = ?1 AND key = 'repeat-origin'",
    )
    .bind(block_id)
    .fetch_optional(pool)
    .await?;
    // Use existing origin, or this block is the first in the chain
    let origin_id = repeat_origin.unwrap_or_else(|| block_id.to_string());

    // --- Create the recurrence sibling ---
    // Single transaction for entire recurrence sequence
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut op_records: Vec<op_log::OpRecord> = Vec::new();

    // M-78: Use MAX(position) + 1 among living siblings to avoid collision.
    // Naive `original.position + 1` collides with whatever sibling already
    // occupies that slot, leaving two siblings sharing one position and the
    // agenda's order non-deterministic. Mirrors the BUG-24 fix in
    // `merge/resolve.rs::create_conflict_copy`.
    //
    // - If the original carries the NULL_POSITION_SENTINEL, the sibling
    //   keeps the sentinel (incrementing would overflow i64::MAX).
    // - Sentinel-bearing siblings are excluded from the MAX scan to avoid
    //   the same overflow.
    let new_position = match original.position {
        Some(p) if p == NULL_POSITION_SENTINEL => Some(NULL_POSITION_SENTINEL),
        Some(_) => {
            let max_pos: Option<i64> = sqlx::query_scalar(
                "SELECT MAX(position) FROM blocks \
                 WHERE parent_id IS ? AND deleted_at IS NULL AND position != ?",
            )
            .bind(original.parent_id.as_deref())
            .bind(NULL_POSITION_SENTINEL)
            .fetch_one(&mut *tx)
            .await?;
            Some(max_pos.unwrap_or(0) + 1)
        }
        None => Some(NULL_POSITION_SENTINEL),
    };

    // Create next occurrence as a sibling
    let (new_block, op) = create_block_in_tx(
        &mut tx,
        device_id,
        original.block_type.clone(),
        original.content.unwrap_or_default(),
        original.parent_id.clone(),
        new_position,
    )
    .await?;
    op_records.push(op);

    // Set TODO state on new block
    let (_, op) = set_property_in_tx(
        &mut tx,
        device_id,
        new_block.id.clone(),
        "todo_state",
        Some("TODO".to_string()),
        None,
        None,
        None,
    )
    .await?;
    op_records.push(op);

    // Copy repeat property to new block
    let (_, op) = set_property_in_tx(
        &mut tx,
        device_id,
        new_block.id.clone(),
        "repeat",
        Some(rule.clone()),
        None,
        None,
        None,
    )
    .await?;
    op_records.push(op);

    // Shift due_date if present
    if let Some(shifted) = shifted_due {
        if !is_valid_iso_date(&shifted) {
            tracing::warn!(
                block_id,
                new_block_id = %new_block.id,
                shifted = %shifted,
                "shifted due_date is not valid YYYY-MM-DD, skipping"
            );
        } else {
            match set_property_in_tx(
                &mut tx,
                device_id,
                new_block.id.clone(),
                "due_date",
                None,
                None,
                Some(shifted),
                None,
            )
            .await
            {
                Ok((_, op)) => op_records.push(op),
                Err(e) => {
                    tracing::warn!(
                        block_id,
                        new_block_id = %new_block.id,
                        device_id,
                        error = %e,
                        "failed to shift due_date for recurring block"
                    );
                }
            }
        }
    }

    // Shift scheduled_date if present
    if let Some(shifted) = shifted_sched {
        if !is_valid_iso_date(&shifted) {
            tracing::warn!(
                block_id,
                new_block_id = %new_block.id,
                shifted = %shifted,
                "shifted scheduled_date is not valid YYYY-MM-DD, skipping"
            );
        } else {
            match set_property_in_tx(
                &mut tx,
                device_id,
                new_block.id.clone(),
                "scheduled_date",
                None,
                None,
                Some(shifted),
                None,
            )
            .await
            {
                Ok((_, op)) => op_records.push(op),
                Err(e) => {
                    tracing::warn!(
                        block_id,
                        new_block_id = %new_block.id,
                        device_id,
                        error = %e,
                        "failed to shift scheduled_date for recurring block"
                    );
                }
            }
        }
    }

    // Copy repeat-until to new block if present
    if let Some(ref until_str) = repeat_until {
        match set_property_in_tx(
            &mut tx,
            device_id,
            new_block.id.clone(),
            "repeat-until",
            None,
            None,
            Some(until_str.clone()),
            None,
        )
        .await
        {
            Ok((_, op)) => op_records.push(op),
            Err(e) => {
                tracing::warn!(
                    block_id,
                    new_block_id = %new_block.id,
                    device_id,
                    error = %e,
                    "failed to copy repeat-until to recurring block"
                );
            }
        }
    }

    // Copy repeat-count and increment repeat-seq on new block
    if let Some(count) = repeat_count {
        // repeat_seq is a non-negative whole number stored as f64; safe to truncate
        #[allow(clippy::cast_possible_truncation)]
        let current_seq = repeat_seq.unwrap_or(0.0) as i64;
        let next_seq = current_seq + 1;

        // Copy repeat-count
        match set_property_in_tx(
            &mut tx,
            device_id,
            new_block.id.clone(),
            "repeat-count",
            None,
            Some(count),
            None,
            None,
        )
        .await
        {
            Ok((_, op)) => op_records.push(op),
            Err(e) => {
                tracing::warn!(
                    block_id,
                    new_block_id = %new_block.id,
                    device_id,
                    error = %e,
                    "failed to copy repeat-count to recurring block"
                );
            }
        }

        // Set incremented repeat-seq
        match set_property_in_tx(
            &mut tx,
            device_id,
            new_block.id.clone(),
            "repeat-seq",
            None,
            Some(next_seq as f64),
            None,
            None,
        )
        .await
        {
            Ok((_, op)) => op_records.push(op),
            Err(e) => {
                tracing::warn!(
                    block_id,
                    new_block_id = %new_block.id,
                    device_id,
                    error = %e,
                    "failed to set repeat-seq on recurring block"
                );
            }
        }
    }

    // Set repeat-origin on new block (points to original block in chain)
    match set_property_in_tx(
        &mut tx,
        device_id,
        new_block.id.clone(),
        "repeat-origin",
        None,
        None,
        None,
        Some(origin_id),
    )
    .await
    {
        Ok((_, op)) => op_records.push(op),
        Err(e) => {
            tracing::warn!(
                block_id,
                new_block_id = %new_block.id,
                device_id,
                error = %e,
                "failed to set repeat-origin on recurring block"
            );
        }
    }

    tx.commit().await?;

    // Dispatch all ops after commit
    for op in &op_records {
        if let Err(e) = materializer.dispatch_background(op) {
            tracing::warn!(
                block_id,
                new_block_id = %new_block.id,
                device_id = %op.device_id,
                seq = op.seq,
                op_type = %op.op_type,
                error = %e,
                "failed to dispatch background cache task"
            );
        }
    }

    Ok(true)
}
