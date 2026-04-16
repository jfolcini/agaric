use chrono::DateTime;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::op::*;
use crate::op_log::{self, OpRecord};
use crate::pagination::NULL_POSITION_SENTINEL;
use crate::ulid::BlockId;

use super::types::PropertyConflictResolution;

/// Create a conflict-copy block when merge fails.
///
/// 1. Generates a new ULID for the conflict copy.
/// 2. Queries the original block for its `block_type` and `parent_id`.
/// 3. Appends a `create_block` op to the op log.
/// 4. Inserts the block into the `blocks` table with `is_conflict = 1`
///    and `conflict_source` pointing to the original block.
/// 5. Returns the op record.
pub async fn create_conflict_copy(
    pool: &SqlitePool,
    device_id: &str,
    original_block_id: &str,
    conflict_content: &str,
    conflict_type: &str,
) -> Result<OpRecord, AppError> {
    // 1. Query the original block for metadata
    let original = sqlx::query!(
        "SELECT block_type, parent_id, position, todo_state, priority, due_date, scheduled_date FROM blocks WHERE id = ?",
        original_block_id
    )
    .fetch_optional(pool)
    .await?;

    let original = original.ok_or_else(|| {
        AppError::NotFound(format!(
            "original block '{original_block_id}' for conflict copy"
        ))
    })?;
    let block_type = original.block_type;
    let parent_id = original.parent_id;
    let position = original.position;
    let todo_state = original.todo_state;
    let priority = original.priority;
    let due_date = original.due_date;
    let scheduled_date = original.scheduled_date;

    // 2. Generate a new block ID
    let new_block_id = BlockId::new();
    tracing::info!(original_block_id, new_block_id = %new_block_id, conflict_type, "creating conflict copy");
    // M-13: Use MAX(position) + 1 among siblings to avoid position collision.
    // Previous approach used position + 1 which could collide with existing siblings.
    // P-18: When original position is the sentinel (or NULL before migration),
    // keep the sentinel instead of incrementing (which would overflow i64::MAX).
    let new_position = match position {
        Some(p) if p == NULL_POSITION_SENTINEL => Some(NULL_POSITION_SENTINEL),
        Some(_p) => {
            let max_pos: Option<i64> = sqlx::query_scalar(
                "SELECT MAX(position) FROM blocks WHERE parent_id IS ? AND deleted_at IS NULL",
            )
            .bind(parent_id.as_deref())
            .fetch_one(pool)
            .await?;
            Some(max_pos.unwrap_or(0) + 1)
        }
        None => Some(NULL_POSITION_SENTINEL),
    };

    // 3. Build the CreateBlock payload
    let payload = OpPayload::CreateBlock(CreateBlockPayload {
        block_id: new_block_id.clone(),
        block_type: block_type.clone(),
        parent_id: parent_id.as_deref().map(BlockId::from_trusted),
        position: new_position,
        content: conflict_content.to_owned(),
    });

    // 4. Append op and insert block in an IMMEDIATE transaction
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;

    let op_record =
        op_log::append_local_op_in_tx(&mut tx, device_id, payload, crate::now_rfc3339()).await?;

    // Insert into blocks table
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, is_conflict, conflict_source, conflict_type, todo_state, priority, due_date, scheduled_date) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
    )
    .bind(new_block_id.as_str())
    .bind(&block_type)
    .bind(conflict_content)
    .bind(&parent_id)
    .bind(new_position)
    .bind(original_block_id)
    .bind(conflict_type)
    .bind(&todo_state)
    .bind(&priority)
    .bind(&due_date)
    .bind(&scheduled_date)
    .execute(&mut *tx)
    .await?;

    // Copy tags from the original block
    sqlx::query(
        "INSERT INTO block_tags (block_id, tag_id) \
         SELECT ?1, tag_id FROM block_tags WHERE block_id = ?2",
    )
    .bind(new_block_id.as_str())
    .bind(original_block_id)
    .execute(&mut *tx)
    .await?;

    // Copy properties from the original block
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text, value_num, value_date, value_ref) \
         SELECT ?1, key, value_text, value_num, value_date, value_ref \
         FROM block_properties WHERE block_id = ?2"
    )
    .bind(new_block_id.as_str())
    .bind(original_block_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(op_record)
}

/// Last-Writer-Wins resolution for concurrent property changes.
///
/// Compares two `set_property` ops and returns the winning op's info.
/// - Primary: later `created_at` timestamp wins (parsed via `chrono::DateTime::parse_from_rfc3339`).
/// - Tiebreaker 1: lexicographically larger `device_id` wins.
/// - Tiebreaker 2: larger `seq` wins.
///
/// Timestamps are parsed as RFC 3339 values, so mixed UTC suffixes
/// (`Z` vs `+00:00`) are handled correctly.  If parsing fails, falls
/// back to lexicographic string comparison with a warning.
#[must_use = "conflict resolution result must be applied"]
pub fn resolve_property_conflict(
    op_a: &OpRecord,
    op_b: &OpRecord,
) -> Result<PropertyConflictResolution, AppError> {
    // Validate both are set_property ops
    if op_a.op_type != "set_property" {
        return Err(AppError::InvalidOperation(format!(
            "expected set_property op, got '{}'",
            op_a.op_type,
        )));
    }
    if op_b.op_type != "set_property" {
        return Err(AppError::InvalidOperation(format!(
            "expected set_property op, got '{}'",
            op_b.op_type,
        )));
    }

    // Parse both payloads
    let payload_a: SetPropertyPayload = serde_json::from_str(&op_a.payload)?;
    let payload_b: SetPropertyPayload = serde_json::from_str(&op_b.payload)?;

    // Compare timestamps by parsing them as RFC 3339 DateTimes.  This handles
    // mixed UTC suffixes (`Z` vs `+00:00`) correctly, unlike the previous
    // lexicographic string comparison which was only valid when all timestamps
    // shared the same suffix format.
    let ts_ours = &op_a.created_at;
    let ts_theirs = &op_b.created_at;
    let ts_cmp = match (
        DateTime::parse_from_rfc3339(ts_ours),
        DateTime::parse_from_rfc3339(ts_theirs),
    ) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        (Err(e), _) | (_, Err(e)) => {
            tracing::warn!(
                ts_a = %ts_ours,
                ts_b = %ts_theirs,
                error = %e,
                "failed to parse RFC 3339 timestamp in LWW comparison; falling back to lexicographic order"
            );
            ts_ours.cmp(ts_theirs)
        }
    };
    let winner_is_b = match ts_cmp {
        std::cmp::Ordering::Less => true,     // B is later
        std::cmp::Ordering::Greater => false, // A is later
        std::cmp::Ordering::Equal => {
            // Tiebreaker 1: larger device_id wins
            match op_b.device_id.cmp(&op_a.device_id) {
                std::cmp::Ordering::Greater => true,
                std::cmp::Ordering::Less => false,
                // Tiebreaker 2: larger seq wins (ensures commutativity when
                // both timestamp and device_id are identical)
                std::cmp::Ordering::Equal => op_b.seq > op_a.seq,
            }
        }
    };

    if winner_is_b {
        tracing::info!(winner_device = %op_b.device_id, winner_seq = op_b.seq, "property conflict resolved via LWW");
        Ok(PropertyConflictResolution {
            winner_device: op_b.device_id.clone(),
            winner_seq: op_b.seq,
            winner_value: payload_b,
        })
    } else {
        tracing::info!(winner_device = %op_a.device_id, winner_seq = op_a.seq, "property conflict resolved via LWW");
        Ok(PropertyConflictResolution {
            winner_device: op_a.device_id.clone(),
            winner_seq: op_a.seq,
            winner_value: payload_a,
        })
    }
}
