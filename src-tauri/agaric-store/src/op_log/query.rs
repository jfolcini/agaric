use crate::db::ReadPool;
use agaric_core::error::AppError;

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

/// One `edit_block` / `create_block` row, as returned by
/// [`latest_block_edit_before`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockEditRow {
    pub device_id: String,
    pub seq: i64,
    pub op_type: String,
    pub payload: String,
}

/// Which candidate row a block-edit scan should return (#3280 / #3281).
///
/// The eligibility predicate — `block_id`, `op_type IN ('edit_block',
/// 'create_block')` and the `is_replicated = 0` policy — is identical for
/// every variant and lives once, in [`latest_block_edit_before`]. Only the
/// upper bound and the sort order differ, and each variant documents why.
#[derive(Debug, Clone, Copy)]
pub enum BlockEditScan<'a> {
    /// Unbounded, ordered by the CAUSAL key `(seq, device_id)` DESC.
    ///
    /// Used to STAMP `EditBlockPayload::prev_edit`. #1526: `seq` is the
    /// per-device causal counter, and the pointer must name the op that was
    /// the live value when the edit was authored — deliberately NOT the
    /// wall-clock-nearest op, which is what makes the pointer trustworthy
    /// under cross-device clock skew.
    LatestCausal,
    /// Strictly before `(created_at, seq, device_id)` in the canonical
    /// `(created_at, seq, device_id)` total order.
    ///
    /// Used to reconstruct the state IMMEDIATELY BEFORE a given op — the
    /// timestamp-ordered fallback when no causal pointer is available.
    /// #382: the op_log PK is `(device_id, seq)` and `seq` is per-device, so
    /// the bound must carry `device_id` or an equal-`(created_at, seq)` op
    /// could fall on either side of the boundary.
    StrictlyBefore {
        created_at: i64,
        seq: i64,
        device_id: &'a str,
    },
    /// At or before `(created_at, seq)` in the canonical order.
    ///
    /// Used to snap to the state PRODUCED by a historical op (rather than
    /// the one before it) — the restore-preview diff.
    AtOrBefore { created_at: i64, seq: i64 },
}

/// The single block-edit scan primitive (#3280 / #3281).
///
/// Every caller that reconstructs "what this block's text was" goes through
/// here, so the two policies that must never drift apart are stated once:
///
/// * **Locally-authored ops only** (`is_replicated = 0`, #2549/#2495).
///   Replicated rows are audit-only provenance: they land in `op_log` but
///   are NEVER applied to local state, so reconstructing "prior state" from
///   one fabricates content this device never held. This guard had been
///   hand-copied into four `reverse/` scans and MISSED by
///   `find_prev_edit_in_tx` — which is what STAMPS the causal pointer, so
///   the pointer itself could be born naming an audit row (#3281).
/// * **The canonical `(created_at, seq, device_id)` total order** for the
///   bounded variants, including the `device_id` tie-break that makes an
///   equal-`(created_at, seq)` cross-device collision resolve
///   deterministically (#382).
///
/// AGENTS.md invariant #8: ULIDs are stored uppercase, so `block_id` is
/// normalized here rather than at each call site.
///
/// The batched `reverse::batch` fetches necessarily keep their own UNION-ALL
/// SQL — collapsing N round-trips into one is the entire point of that
/// module — but they mirror this predicate, and the
/// `compute_reverse_batch_matches_per_op_loop` parity oracle is what holds
/// them to it.
pub async fn latest_block_edit_before<'e, E>(
    executor: E,
    block_id: &str,
    scan: BlockEditScan<'_>,
) -> Result<Option<BlockEditRow>, AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let bid = block_id.to_ascii_uppercase();
    let row = match scan {
        BlockEditScan::LatestCausal => {
            sqlx::query_as!(
                BlockEditRow,
                "SELECT device_id, seq, op_type, payload FROM op_log \
                 WHERE block_id = ?1 \
                   AND op_type IN ('edit_block', 'create_block') \
                   AND is_replicated = 0 \
                 ORDER BY seq DESC, device_id DESC \
                 LIMIT 1",
                bid,
            )
            .fetch_optional(executor)
            .await?
        }
        BlockEditScan::StrictlyBefore {
            created_at,
            seq,
            device_id,
        } => {
            sqlx::query_as!(
                BlockEditRow,
                "SELECT device_id, seq, op_type, payload FROM op_log \
                 WHERE block_id = ?1 \
                   AND op_type IN ('edit_block', 'create_block') \
                   AND is_replicated = 0 \
                   AND (created_at < ?2 \
                        OR (created_at = ?2 AND (seq < ?3 OR (seq = ?3 AND device_id < ?4)))) \
                 ORDER BY created_at DESC, seq DESC, device_id DESC \
                 LIMIT 1",
                bid,
                created_at,
                seq,
                device_id,
            )
            .fetch_optional(executor)
            .await?
        }
        BlockEditScan::AtOrBefore { created_at, seq } => {
            sqlx::query_as!(
                BlockEditRow,
                "SELECT device_id, seq, op_type, payload FROM op_log \
                 WHERE block_id = ?1 \
                   AND op_type IN ('edit_block', 'create_block') \
                   AND is_replicated = 0 \
                   AND (created_at < ?2 OR (created_at = ?2 AND seq <= ?3)) \
                 ORDER BY created_at DESC, seq DESC, device_id DESC \
                 LIMIT 1",
                bid,
                created_at,
                seq,
            )
            .fetch_optional(executor)
            .await?
        }
    };
    Ok(row)
}

/// Resolve an `EditBlockPayload::prev_edit` pointer to the pointed-at op's
/// `(op_type, payload)`, or `None` when the pointer does not name a usable
/// LOCAL row (#3280 / #3281).
///
/// `None` deliberately conflates the two ways a pointer can fail to resolve,
/// because both mean the same thing to the caller — "fall back to the
/// timestamp scan":
///
/// * the row is gone (op-log compaction), and
/// * the row is a REPLICATED audit row (#3281). Following one would restore
///   content this device never applied, which is precisely what the
///   `is_replicated = 0` guard on the prior-state scans exists to prevent;
///   a pointer into that space is no more usable than a dangling one.
pub async fn resolve_prev_edit_target(
    pool: &ReadPool,
    device_id: &str,
    seq: i64,
) -> Result<Option<(String, String)>, AppError> {
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log \
         WHERE device_id = ?1 AND seq = ?2 AND is_replicated = 0",
        device_id,
        seq,
    )
    .fetch_optional(&pool.0)
    .await?;
    Ok(row.map(|r| (r.op_type, r.payload)))
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
