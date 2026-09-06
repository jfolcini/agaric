use sqlx::{SqliteConnection, SqlitePool};
use std::collections::BTreeMap;

use agaric_core::error::AppError;

/// Compute the op frontier: `device_id → max seq` and the hash of the latest op.
///
/// Returns `(BTreeMap::new(), String::new())` on an empty op_log rather than
/// erroring. [`compact_op_log`] gates the call behind its own row-count check,
/// so that shape is only reachable from tests today.
///
/// # `up_to_hash` is opaque, `up_to_seqs` is the real causal anchor
///
/// Note for anyone grepping the tree for op-log ordering after #4402: #4402
/// canonicalised the sweep/history/reverse comparators
/// (`agaric_store::op_log::BlockEditScan`, `commands::history`, `reverse::*`)
/// onto `(created_at, seq, device_id)` and left none of the
/// `device_id`-before-`seq` shape behind in those layers. This `ORDER BY` — in
/// the compaction layer, not one of them — keeps that shape deliberately, and
/// the rest of this section says why: the value is opaque and never compared
/// across devices, so it is not an LWW decision at all.
///
/// This does NOT mean `(created_at, device_id, seq)` is extinct elsewhere:
/// `db::recovery` replays in that order as its own LWW convention
/// (`recover_blocks_from_op_log`, `recover_derived_state_from_op_log` and
/// `recover_attachments_from_op_log`).
///
/// The "latest hash" returned here is selected via `ORDER BY created_at DESC,
/// device_id DESC, seq DESC LIMIT 1` — i.e. wall-clock-ordered. Because two
/// devices' clocks can disagree by seconds (and the op log has no global
/// monotonic clock), the hash returned depends on which device's wall clock
/// happened to run ahead of the other.
///
/// That is **deliberate, not a bug**: the value is written to
/// `compaction_watermark.up_to_hash` as a record of what the purge reached and
/// is read by nothing. The **real causal anchor is `up_to_seqs`** — a
/// per-device-id `MAX(seq)` map that behaves like a vector clock, and the
/// bound [`compact_op_log`]'s DELETE runs against.
///
/// # #2481 phase 1 — deliberately UNFILTERED on `is_replicated`
///
/// Unlike boot replay / the apply cursor (`recovery::replay`), this query does
/// NOT add `WHERE is_replicated = 0`. That is intentional for
/// [`compact_op_log`]'s DELETE frontier: per the #2481 design (issue body,
/// "Compaction: foreign-device ops age out under the same 90-day
/// snapshot-frontier policy"), replicated foreign-device audit rows are meant
/// to be purged by the same retention sweep as locally-authored ones.
///
/// #3487 removed the only consumer that read `up_to_seqs[device]` as a proxy
/// for state coverage, so the #2481-phase-2 hazard that block described — a
/// replicated audit seq passing a coverage check it says nothing about — is no
/// longer reachable from here.
pub async fn collect_frontier(
    conn: &mut SqliteConnection,
) -> Result<(BTreeMap<String, i64>, String), AppError> {
    let rows = sqlx::query!("SELECT device_id, MAX(seq) as max_seq FROM op_log GROUP BY device_id")
        .fetch_all(&mut *conn)
        .await?;

    if rows.is_empty() {
        return Ok((BTreeMap::new(), String::new()));
    }

    let mut frontier = BTreeMap::new();
    for row in &rows {
        // device_id is NOT NULL but sqlx infers Option in GROUP BY context
        if let Some(ref device_id) = row.device_id {
            frontier.insert(device_id.clone(), row.max_seq);
        }
    }

    // Get the hash of the overall latest op (by created_at DESC, then device_id, seq)
    // Safe to use fetch_one here: we verified above that at least one row exists.
    let latest_hash: String = sqlx::query_scalar!(
        "SELECT hash FROM op_log ORDER BY created_at DESC, device_id DESC, seq DESC LIMIT 1"
    )
    .fetch_one(&mut *conn)
    .await?;

    Ok((frontier, latest_hash))
}

/// Default retention period for op log compaction (90 days).
pub const DEFAULT_RETENTION_DAYS: u64 = 90;

/// #3310 — clamp `materializer_apply_cursor` down to the surviving
/// `MAX(seq) WHERE is_replicated = 0`. Runs inside [`compact_op_log`]'s purge
/// transaction.
///
/// A cursor pointing past the end of the log is the H-4 impossible state.
/// Compaction used to reset only the log: a vault whose newest op predates the
/// retention window is purged to zero rows while the cursor still holds e.g.
/// 50_000, and the next boot's `read_apply_cursor` (`recovery/replay.rs`) logs
/// "impossible-state corruption" on a perfectly healthy vault. Clamping here
/// makes that log line mean what it says again.
///
/// CLAMP TARGET — the surviving `MAX(seq) WHERE is_replicated = 0`,
/// byte-for-byte the ceiling that `read_apply_cursor` and
/// `heal_orphaned_apply_cursor` compare against. The `is_replicated = 0` scope
/// is load-bearing (#2481): replicated audit rows are never applied and never
/// advance the cursor, so they must not raise its legitimate ceiling either —
/// clamping to an UNSCOPED `MAX(seq)` would leave the boot warn firing whenever
/// a replicated row sat above the local frontier. `NULL` (log now empty)
/// collapses to 0.
///
/// ONLY EVER LOWERS. The `WHERE materialized_through_seq > ?1` guard makes a
/// compaction that removed nothing above the cursor — the overwhelmingly common
/// case, since the purge deletes the OLDEST rows and therefore normally moves
/// `MIN(seq)`, not `MAX(seq)` — a strict no-op, and can never raise the cursor
/// over ops that were not in fact materialised.
///
/// LOWERING CANNOT LOSE WORK. The cursor means "everything at or below this seq
/// is materialised", so a lower value can only cause RE-application, never
/// skipping; and re-application on this path is idempotent
/// (`advance_apply_cursor` is `MAX(materialized_through_seq, ?)`, the
/// projections are `INSERT OR IGNORE` / `INSERT OR REPLACE` / keyed `UPDATE`,
/// per `heal_orphaned_apply_cursor`'s documented contract). Here it cannot even
/// cause re-application: the boot replay walk is
/// `WHERE is_replicated = 0 AND seq > cursor` and we clamp to exactly the
/// largest such seq, so the post-clamp walk selects zero rows.
async fn clamp_apply_cursor_to_surviving_max(conn: &mut SqliteConnection) -> Result<(), AppError> {
    let surviving_max: i64 = sqlx::query_scalar!(
        r#"SELECT MAX(seq) as "max_seq: i64" FROM op_log WHERE is_replicated = 0"#,
    )
    .fetch_one(&mut *conn)
    .await?
    .unwrap_or(0);
    let cursor_clamped_at = agaric_store::db::now_ms();
    let clamped_rows = sqlx::query!(
        "UPDATE materializer_apply_cursor \
         SET materialized_through_seq = ?1, \
             updated_at = ?2 \
         WHERE id = 1 AND materialized_through_seq > ?1",
        surviving_max,
        cursor_clamped_at,
    )
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if clamped_rows > 0 {
        tracing::info!(
            surviving_max_seq = surviving_max,
            "compaction: clamped materializer_apply_cursor down to the surviving \
             MAX(op_log.seq) (#3310); the purge removed every op the cursor \
             pointed at, and a cursor past the end of the log is the H-4 \
             impossible state the boot clamp exists to flag"
        );
    }
    Ok(())
}

/// Purge `op_log` rows older than `retention_days` and record the frontier the
/// purge ran to in `compaction_watermark`.
///
/// Returns `Some(deleted_count)` if compaction occurred, `None` if no ops
/// predate the cutoff.
///
/// # Two phases
///
/// 1. **Read phase** — a DEFERRED read transaction counts eligible ops and
///    collects the op frontier (`up_to_seqs`). No write lock is acquired.
/// 2. **Write phase** — one `BEGIN IMMEDIATE` transaction upserts the
///    watermark, deletes the old ops, and clamps the apply cursor down to the
///    surviving frontier.
///
/// **Stale-read safety**: between the phases new ops may arrive. The DELETE is
/// bounded by *both* `created_at < cutoff` *and* `seq <= up_to_seqs[device_id]`
/// from phase 1, so ops that were not yet visible during the read phase can
/// never be deleted.
///
/// **Cursor symmetry (#3310)**: the write transaction also runs
/// `clamp_apply_cursor_to_surviving_max`, without which purging a vault whose
/// newest op predates the retention window leaves `cursor >> MAX(seq)` — the
/// H-4 impossible state.
///
/// The returned count is the **actual** number of rows the per-device DELETE
/// affected, which the phase-2 frontier guard can legitimately make smaller
/// than a pre-flight eligibility count.
#[tracing::instrument(skip(pool), err)]
pub async fn compact_op_log(
    pool: &SqlitePool,
    retention_days: u64,
) -> Result<Option<u64>, AppError> {
    tracing::info!(retention_days, "compaction starting");
    let start = std::time::Instant::now();

    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days.cast_signed());
    // #109 Phase 2: op_log.created_at is INTEGER epoch-ms; compare against
    // the cutoff as milliseconds (numeric, not lexicographic RFC3339).
    let cutoff_ms = cutoff.timestamp_millis();

    // ── Phase 1: Read (DEFERRED read transaction, no write lock) ─────
    let mut read_tx = pool.begin().await?;

    let count: i64 = sqlx::query_scalar!(
        "SELECT COUNT(*) FROM op_log WHERE created_at < ?",
        cutoff_ms
    )
    .fetch_one(&mut *read_tx)
    .await?;

    tracing::debug!(eligible_ops = count, "compaction eligible ops identified");

    if count == 0 {
        read_tx.commit().await?;
        tracing::info!(retention_days, "compaction: no eligible ops, nothing to do");
        return Ok(None);
    }

    let (up_to_seqs, up_to_hash) = collect_frontier(&mut read_tx).await?;
    read_tx.commit().await?;

    // ── Phase 2: Write (one BEGIN IMMEDIATE transaction) ─────────────
    // `begin_immediate_logged` surfaces a stalled writer as a `warn`
    // instead of letting it disappear into the 5 s busy_timeout.
    let mut tx = agaric_store::db::begin_immediate_logged(pool, "compact_op_log_purge").await?;

    // Record the frontier this purge ran to. #4699: this replaced a
    // zstd-CBOR dump of every derived table. Only the ROW'S EXISTENCE is
    // read (by `agaric_engine::dag::find_lca`, to pick the
    // compaction-aware wording for a broken edit chain); the columns are
    // the durable record of how far the log was trimmed.
    //
    // Written INSIDE the purge transaction: a watermark without the purge
    // would claim a trim that did not happen, and a purge without the
    // watermark makes `find_lca` report a purged op as a plain NotFound.
    let up_to_seqs_json = serde_json::to_string(&up_to_seqs)
        .map_err(|e| AppError::Internal(format!("serialising the compaction frontier: {e}")))?;
    let compacted_at_ms = agaric_store::db::now_ms();
    sqlx::query!(
        "INSERT INTO compaction_watermark (id, up_to_seqs, up_to_hash, compacted_at_ms) \
         VALUES (1, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           up_to_seqs = excluded.up_to_seqs, \
           up_to_hash = excluded.up_to_hash, \
           compacted_at_ms = excluded.compacted_at_ms",
        up_to_seqs_json,
        up_to_hash,
        compacted_at_ms,
    )
    .execute(&mut *tx)
    .await?;

    // Purge old ops: bounded by BOTH the time cutoff AND the phase-1
    // frontier, so ops written after the read phase are never deleted.
    //
    // H-13: the BEFORE DELETE trigger on op_log (migration 0036) would ABORT
    // every per-device DELETE below without the mutation-bypass sentinel.
    // #2895 slice 4: `op_log::prune` ENCAPSULATES the enable → delete →
    // disable bracket per call, so this loop can't forget it — each DELETE
    // runs with the sentinel present and the bypass is DISABLED again on
    // return (never escaping this tx / leaking to sibling connections).
    let mut deleted_count: u64 = 0;
    for (dev_id, max_seq) in &up_to_seqs {
        deleted_count += agaric_store::op_log::prune(&mut tx, cutoff_ms, dev_id, *max_seq).await?;
    }

    clamp_apply_cursor_to_surviving_max(&mut tx).await?;

    tx.commit().await?;

    tracing::info!(
        ops_deleted = deleted_count,
        duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX),
        "compaction completed"
    );

    Ok(Some(deleted_count))
}
