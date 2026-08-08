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

/// Which candidate row a block-edit scan should return (#3280 / #3281 /
/// #3644).
///
/// The eligibility predicate — `block_id` and `op_type IN ('edit_block',
/// 'create_block')` — is identical for every variant and lives once, in
/// [`latest_block_edit_before`]. The bound, the sort order and the
/// PROVENANCE policy differ per variant; each documents why.
///
/// # The provenance split
///
/// `is_replicated = 0` is NOT a blanket policy. It is scoped to the one
/// variant that GUESSES which op the caller meant:
///
/// * [`StrictlyBefore`](BlockEditScan::StrictlyBefore) is a blind backwards
///   walk — "whatever row happens to sort just under this bound". Letting it
///   land on a replicated audit row means reconstructing prior state from a
///   row nobody named, and that guess can surface content this device never
///   applied. It keeps the guard (#2549/#2495).
/// * [`LatestCausal`](BlockEditScan::LatestCausal) and
///   [`AtOrBefore`](BlockEditScan::AtOrBefore) are ANCHORED. The first
///   answers "what is the live value of this block right now", at the moment
///   a local edit is authored — and a peer's edit that arrived through Loro
///   genuinely IS part of the live value, so excluding it would stamp the
///   pointer at superseded text. The second snaps to the op the user picked
///   out of the history list, which `get_block_history` deliberately shows
///   replicated rows in (#2481). Filtering either one does not prevent a bad
///   guess; it discards the answer.
#[derive(Debug, Clone, Copy)]
pub enum BlockEditScan<'a> {
    /// Unbounded, ordered by the CAUSAL key `(seq, device_id)` DESC.
    /// Provenance: ALL rows, replicated included — see the type-level note.
    ///
    /// Used to STAMP `EditBlockPayload::prev_edit`. #1526: `seq` is the
    /// per-device causal counter, and the pointer must name the op that was
    /// the live value when the edit was authored — deliberately NOT the
    /// wall-clock-nearest op, which is what makes the pointer trustworthy
    /// under cross-device clock skew.
    LatestCausal,
    /// Strictly before `(created_at, seq, device_id)` in the canonical
    /// `(created_at, seq, device_id)` total order.
    /// Provenance: LOCALLY-AUTHORED ONLY (`is_replicated = 0`, #2549).
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
    /// Provenance: ALL rows, replicated included — see the type-level note.
    ///
    /// Used to snap to the state PRODUCED by a historical op (rather than
    /// the one before it) — the restore-preview diff.
    AtOrBefore { created_at: i64, seq: i64 },
}

/// The single block-edit scan primitive (#3280 / #3281 / #3644).
///
/// Every caller that reconstructs "what this block's text was" goes through
/// here, so the policies that must never drift apart are stated once:
///
/// * **Provenance, scoped per variant** — see the [`BlockEditScan`]
///   type-level note. `is_replicated = 0` (#2549/#2495) belongs to the blind
///   [`StrictlyBefore`](BlockEditScan::StrictlyBefore) walk, not to the two
///   anchored variants. #3281 originally prescribed the guard everywhere;
///   #3644 narrowed it after a uniform guard broke Ctrl+Z on every block
///   that arrived via sync.
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
/// `(op_type, payload)`, or `None` when the row is gone — op-log compaction
/// being the only way that happens (#3280 / #3281 / #3644).
///
/// # Why this does NOT filter `is_replicated = 0`
///
/// The sibling prior-state SCANS do, and a future reader will read that as
/// an inconsistency to tidy up. It is not. The guard is scoped to guessing,
/// not to provenance per se (see [`BlockEditScan`]):
///
/// * `prev_edit` is authored LOCALLY, by this device, at the moment of the
///   edit, and names ONE specific op. It is a recorded fact, not a scan
///   result — nothing about it can drift onto the wrong row.
/// * The op it names, replicated or not, is by construction the value this
///   block HELD when the edit was authored. For a peer-originated block that
///   value only ever existed as an audit row plus Loro state
///   (`insert_replicated_op`), so refusing the pointer does not protect the
///   user from foreign content — it just leaves the edit with no
///   reconstruction source at all and turns Ctrl+Z into a hard error (#3644).
///
/// The blind `StrictlyBefore` walk keeps its guard precisely because it has
/// no such anchor: it takes whatever sorts nearest, which really can be a
/// row nobody's edit ever pointed at.
pub async fn resolve_prev_edit_target(
    pool: &ReadPool,
    device_id: &str,
    seq: i64,
) -> Result<Option<(String, String)>, AppError> {
    let row = sqlx::query!(
        "SELECT op_type, payload FROM op_log WHERE device_id = ?1 AND seq = ?2",
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
