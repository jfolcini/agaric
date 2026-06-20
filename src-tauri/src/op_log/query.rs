use crate::db::ReadPool;
use crate::error::AppError;

use super::record::OpRecord;

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/// Fetch a single op log record by `(device_id, seq)`.
///
/// Returns [`AppError::NotFound`] if no such row exists.
pub async fn get_op_by_seq(
    pool: &ReadPool,
    device_id: &str,
    seq: i64,
) -> Result<OpRecord, AppError> {
    // Include the indexed `block_id` column (migration 0030) so
    // the read path populates the cached sidecar field with no JSON
    // parse on either the local-append origin or post-restore reads.
    sqlx::query_as!(
        OpRecord,
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id \
         FROM op_log WHERE device_id = ? AND seq = ?",
        device_id,
        seq,
    )
    .fetch_optional(&pool.0)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("op_log ({device_id}, {seq})")))
}

/// Return the latest sequence number for a device, or 0 if none exist.
pub async fn get_latest_seq(pool: &ReadPool, device_id: &str) -> Result<i64, AppError> {
    let row = sqlx::query!(
        r#"SELECT COALESCE(MAX(seq), 0) as "latest_seq!: i64" FROM op_log WHERE device_id = ?"#,
        device_id,
    )
    .fetch_one(&pool.0)
    .await?;
    Ok(row.latest_seq)
}

/// Return all ops for a device with `seq > after_seq`, ordered ascending.
///
/// Useful for pagination and sync — a consumer can persist the last-seen seq
/// and call this to fetch only newer entries.
pub async fn get_ops_since(
    pool: &ReadPool,
    device_id: &str,
    after_seq: i64,
) -> Result<Vec<OpRecord>, AppError> {
    // Include the indexed `block_id` column (migration 0030) so
    // every row in the result set carries the cached sidecar field —
    // the materializer / sync-stream consumer never needs to re-parse
    // `payload` for the same value.
    let rows = sqlx::query_as!(
        OpRecord,
        "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id \
         FROM op_log WHERE device_id = ? AND seq > ? ORDER BY seq ASC",
        device_id,
        after_seq,
    )
    .fetch_all(&pool.0)
    .await?;
    Ok(rows)
}
