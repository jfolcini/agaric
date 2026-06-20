//! C-2b: boot-time op-log replay for unmaterialized ops.
//!
//! On boot, walk `op_log WHERE seq > materialized_through_seq` and
//! enqueue each record as an `ApplyOp` task on the materializer's
//! foreground queue. The materializer applies them in order, advancing
//! the cursor as it goes. If the same crash recurs mid-replay, the next
//! boot picks up where this one stopped.
//!
//! Idempotency: every op handler in `materializer/handlers.rs::apply_op_tx`
//! already uses `INSERT OR IGNORE` / UPSERT semantics, so re-applying an
//! op that PARTIALLY succeeded (e.g., the apply landed but the cursor
//! advance got rolled back by a crash before commit) is a no-op for
//! primary state. The cursor's `MAX` semantics make the cursor advance
//! itself idempotent.
//!
//! Ordering: ops are walked in `(seq ASC, device_id ASC)` order so a
//! parent → child causal pair from the same device is always replayed
//! parent-first. Cross-device causal ordering during replay is best-
//! effort — the same idempotency guarantees that protect normal sync
//! ingest also cover replay.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::Arc;

use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};
use crate::op_log::OpRecord;

/// Chunk size for the op_log read pass. Bounded so a multi-thousand-op
/// replay does not load the entire op log into memory at once. The
/// foreground queue is drained at the end via a Barrier task, so the
/// per-chunk depth never exceeds `FOREGROUND_CAPACITY`.
pub(crate) const REPLAY_CHUNK_SIZE: i64 = 200;

/// Summary of a single replay pass returned to the caller.
///
/// `ops_replayed` counts every `ApplyOp` enqueued onto the foreground
/// queue. `replay_errors` accumulates non-fatal errors (e.g. a single
/// op failed to enqueue) — fatal errors propagate via `Result::Err`.
/// `ops_skipped_idempotent` is reserved for a future per-record
/// already-applied detection; today it is always zero because
/// per-record idempotency is handled inside `apply_op_tx` itself
/// (every handler is `INSERT OR IGNORE` / UPSERT) rather than via a
/// pre-check from this module.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReplayReport {
    /// Number of ops enqueued on the foreground queue for replay.
    pub ops_replayed: u64,
    /// Reserved for future use (per-record already-applied detection).
    /// Always 0 today — see module-level docs for rationale.
    pub ops_skipped_idempotent: u64,
    /// Non-fatal errors during replay (each entry: `"<context>: <err>"`).
    pub replay_errors: Vec<String>,
}

/// Read the current `materialized_through_seq` from the cursor table.
///
/// Migration `0040` seeds the row at boot, so this lookup always
/// returns a value (defaulting to 0 on a fresh install).
///
/// # SQL-review H-4 — boot-time sanity check
///
/// The cursor advance path (`materializer/handlers.rs::advance_apply_cursor`)
/// is gated by `MAX(materialized_through_seq, ?)` and only ever bumps the
/// cursor up to `op_log.seq` values that exist. Therefore the invariant
/// `cursor <= MAX(op_log.seq)` holds for every successful apply. If at
/// boot we observe `cursor > MAX(op_log.seq)`, the cursor is in an
/// impossible state — most likely a hand-edit, a partial restore, or a
/// rolled-back op_log without a matching rolled-back cursor. Left alone,
/// the next `replay_unmaterialized_ops` walk would silently do nothing
/// and any unmaterialized ops would never be applied. Worse, an
/// adversarially corrupted *under*-shoot value (e.g. 0) would trigger a
/// full op_log replay at boot — not data loss, but a multi-second
/// boot-stall.
///
/// This function therefore performs one cheap impossible-state check on
/// the read path: if `cursor > MAX(op_log.seq)` we reset the cursor to
/// `MAX(op_log.seq)` (or 0 if the log is empty), log a warning, and
/// return the corrected value. We deliberately do NOT try to detect
/// under-shoot corruption: there is no surviving "expected cursor"
/// signal to compare against (the cursor row has no timestamp-of-last-op
/// field), and `MAX(materialized_through_seq, ?)` per-op idempotency
/// already prevents an under-shoot from causing incorrect state — only
/// the wasted boot time.
async fn read_apply_cursor(pool: &SqlitePool) -> Result<i64, AppError> {
    let row = sqlx::query!(
        r#"SELECT materialized_through_seq as "seq!: i64" FROM materializer_apply_cursor WHERE id = 1"#,
    )
    .fetch_one(pool)
    .await?;
    let cursor = row.seq;

    // SQL-review H-4: sanity-check against MAX(op_log.seq). The op_log
    // is append-only per AGENTS.md invariant #1, so MAX(seq) is the
    // strict upper bound for any legitimate cursor value.
    //
    // #1538 (scope note): `materialized_through_seq` is a SINGLE GLOBAL
    // scalar (table `materializer_apply_cursor`, one `id = 1` row, no
    // `device_id`), while `op_log.seq` is a PER-DEVICE counter (PK
    // `(device_id, seq)`). `advance_apply_cursor` bumps the global cursor
    // via `MAX(materialized_through_seq, seq)` for *every* applied op
    // regardless of device, so the cursor's legitimate ceiling is the
    // GLOBAL `MAX(seq)` across all devices — which is exactly what we
    // compare against here. Crucially, this means the ceiling must NOT be
    // narrowed to a per-device `MAX(seq) WHERE device_id = ?`: with the
    // current global cursor that would lower the bound below seqs the
    // cursor legitimately reached on other devices and FALSE-flag a valid
    // cursor. The per-device fix belongs to the per-device cursor
    // partitioning (#412), which adds a `device_id` to the cursor row and
    // a `WHERE device_id = ?` replay walk; only then does a per-device
    // ceiling become correct. Until #412 lands this check intentionally
    // assumes a single-device op_log (the multi-device hard-abort guard in
    // `replay_unmaterialized_ops` enforces that downstream), so it is NOT
    // multi-device-safe in any sense beyond "the global ceiling is still
    // the right ceiling for a global cursor".
    let max_seq: Option<i64> =
        sqlx::query_scalar!(r#"SELECT MAX(seq) as "max_seq: i64" FROM op_log"#,)
            .fetch_one(pool)
            .await?;
    let max_seq = max_seq.unwrap_or(0);

    if cursor > max_seq {
        tracing::warn!(
            cursor,
            max_seq,
            "replay: materializer_apply_cursor exceeds MAX(op_log.seq) — \
             impossible-state corruption; resetting cursor to MAX(op_log.seq)"
        );
        let updated_at = crate::db::now_ms();
        sqlx::query!(
            "UPDATE materializer_apply_cursor \
             SET materialized_through_seq = ?, \
                 updated_at = ? \
             WHERE id = 1",
            max_seq,
            updated_at,
        )
        .execute(pool)
        .await?;
        return Ok(max_seq);
    }

    Ok(cursor)
}

/// #619: does rewinding the apply cursor to `reset_to` under-rebuild
/// because the op-log head below the rewind target was compacted away?
///
/// `compact_op_log` deletes rows older than the retention window, so after
/// at least one compaction the oldest surviving seq is `> 1`. A replay walk
/// (`seq > reset_to`) is only a genuine rebuild when every op in
/// `(reset_to, oldest-surviving-seq)` still exists — i.e. when
/// `reset_to >= oldest_surviving_seq - 1`. Anything lower silently
/// reconstructs the engines from the surviving tail only.
///
/// #851 (per-device floor): `op_log.seq` is a PER-DEVICE counter
/// (PK `(device_id, seq)`), and `compact_op_log` purges per device. A
/// GLOBAL `MIN(seq)` therefore false-negatives the floor: if device A was
/// compacted up to seq 100 but a freshly-paired device B still has its
/// seq 1, the global `MIN(seq) = 1` makes the check believe nothing was
/// purged — while device A's head (seqs 1..=99) is gone. The floor must be
/// evaluated PER DEVICE: a rewind under-rebuilds iff ANY device's oldest
/// surviving seq sits above `reset_to + 1`, i.e. the binding floor is the
/// MAX over devices of `MIN(seq)`. (Today the replay walk itself is single
/// device per the #412 guard, but the detection is the correctness surface
/// here and must be right ahead of multi-device sync shipping.)
///
/// Split out of [`heal_orphaned_apply_cursor`] so the floor predicate is
/// directly unit-testable without staging a full heal scenario.
pub(super) async fn compacted_floor_above(
    pool: &SqlitePool,
    reset_to: i64,
) -> Result<bool, AppError> {
    // Per-device floor: for each device take its oldest surviving seq
    // (`MIN(seq)`), then take the MAX of those per-device minima. That
    // largest per-device head is the binding compaction floor — a rewind
    // below it leaves at least one device's purged head unrecoverable.
    let floor: Option<i64> = sqlx::query_scalar!(
        r#"SELECT MAX(device_min) as "floor: i64"
           FROM (SELECT MIN(seq) AS device_min FROM op_log GROUP BY device_id)"#
    )
    .fetch_one(pool)
    .await?;
    let Some(floor) = floor else {
        // Empty op_log — nothing to rebuild from, but also nothing was
        // compacted "above" the target; the caller's `max_seq == 0` guard
        // bails out before this matters.
        return Ok(false);
    };
    Ok(reset_to < floor - 1)
}

/// Boot-only self-heal for an orphaned / stale apply cursor.
///
/// `loro_doc_state` holds one persisted Loro engine snapshot per space,
/// rehydrated into the in-memory engines at boot (see `lib.rs`). Two
/// failure modes leave an engine behind the global apply cursor
/// (`materializer_apply_cursor.materialized_through_seq`), so the
/// incremental replay walk (`seq > cursor`) replays nothing into it and
/// every later edit/move apply fails "loro: block not found":
///
///  1. **Missing snapshot** — the table is empty (e.g. the snapshot
///     scheduler was disabled in 8c2c5ddf) while the cursor advanced; the
///     engine boots empty. Reset the cursor to 0 → full replay rebuilds it.
/// 2. **Stale snapshot (C2)** — a snapshot blob reflects ops
///    only up to its `applied_through_seq` watermark, but a crash let the
///    cursor run ahead (snapshots are periodic, the cursor is per-op).
///    Reset the cursor down to `MIN(applied_through_seq)` so replay
///    re-applies the unmaterialized tail onto the behind engines.
///
/// In both cases the op_log is the append-only source of truth and every
/// apply handler is idempotent (`MAX(materialized_through_seq, ?)` +
/// `INSERT OR IGNORE/REPLACE` / keyed `UPDATE` projections + in-order
/// engine re-apply), so re-applying over already-materialized SQL and
/// already-caught-up engines is safe. The reset target is the most-stale
/// watermark across all spaces; because `save_all_engines` refreshes every
/// snapshot each pass, that is bounded by ~one snapshot interval of ops.
///
/// MUST be called at boot only (after snapshot rehydrate, before the
/// replay walk).
///
/// Returns `true` if it reset the cursor.
pub(super) async fn heal_orphaned_apply_cursor(pool: &SqlitePool) -> Result<bool, AppError> {
    let cursor: i64 = sqlx::query_scalar!(
        r#"SELECT materialized_through_seq as "seq!: i64" FROM materializer_apply_cursor WHERE id = 1"#,
    )
    .fetch_one(pool)
    .await?;
    if cursor == 0 {
        return Ok(false);
    }

    let max_seq: i64 = sqlx::query_scalar!(r#"SELECT MAX(seq) as "max_seq: i64" FROM op_log"#,)
        .fetch_one(pool)
        .await?
        .unwrap_or(0);
    if max_seq == 0 {
        return Ok(false);
    }

    let snapshot_count: i64 =
        sqlx::query_scalar!(r#"SELECT COUNT(*) as "n!: i64" FROM loro_doc_state"#,)
            .fetch_one(pool)
            .await?;

    // How far back to rewind the cursor so replay catches every behind
    // engine up to the materialised frontier.
    let reset_to: i64 = if snapshot_count == 0 {
        // No persisted snapshot at all — every engine boots empty; rebuild
        // the whole op-log.
        0
    } else {
        // Snapshots exist. Each reflects ops only up to its
        // `applied_through_seq`; the most-stale one bounds what replay must
        // re-apply. A backfilled/legacy `0` watermark forces a full rebuild
        // for that space, which is correct (one-time cost after migration).
        let min_watermark: i64 = sqlx::query_scalar!(
            r#"SELECT MIN(applied_through_seq) as "wm!: i64" FROM loro_doc_state"#,
        )
        .fetch_one(pool)
        .await?;
        if cursor <= min_watermark {
            // Every snapshot already covers the cursor — nothing to heal.
            return Ok(false);
        }
        min_watermark
    };

    // #619: compaction-floor check. `compact_op_log` purges ops below the
    // retention frontier, so the oldest surviving row is NOT necessarily
    // seq 1. A `reset_to` below the per-device compaction floor (#851 —
    // `MAX` over devices of each device's `MIN(seq)`) means the replay walk
    // (`seq > reset_to`) can only reconstruct the surviving TAIL: blocks
    // created before the retention window exist in SQL but will be missing
    // from the rebuilt engines — the exact "loro: block not found" wedge
    // this heal exists to fix, plus an old-data-loss hazard if the partial
    // engines are later persisted as authoritative snapshots. We still
    // rewind (replaying the tail heals strictly more than leaving the
    // engines empty/stale), but surface the under-rebuild LOUDLY instead of
    // logging it as a routine heal.
    if compacted_floor_above(pool, reset_to).await? {
        tracing::error!(
            cursor,
            max_seq,
            reset_to,
            snapshot_count,
            "recovery: engine rebuild target is below the op-log compaction \
             floor — the op-log head was compacted away, so the rebuilt \
             engines will only contain the surviving tail. Blocks older than \
             the retention window remain in SQL but NOT in the Loro engines; \
             edits to them will fail until a full engine rebuild from a \
             snapshot/SQL import. (#619)"
        );
    }

    tracing::warn!(
        cursor,
        max_seq,
        reset_to,
        snapshot_count,
        "recovery: apply cursor is ahead of the Loro snapshot watermark \
         (missing or stale snapshot) — rewinding the cursor so replay \
         rebuilds the behind engines from the op-log"
    );
    let updated_at = crate::db::now_ms();
    sqlx::query!(
        "UPDATE materializer_apply_cursor \
         SET materialized_through_seq = ?, \
             updated_at = ? \
         WHERE id = 1",
        reset_to,
        updated_at,
    )
    .execute(pool)
    .await?;
    Ok(true)
}

/// Walk `op_log WHERE seq > cursor` and enqueue each row as an
/// `ApplyOp` task on the materializer's foreground queue.
///
/// Returns a [`ReplayReport`] summarising the pass. The function blocks
/// until every enqueued op has been processed (via a foreground
/// `Barrier` task), so callers see a fully-drained queue on return.
///
/// `pool` is a `SqlitePool` — typically the writer pool, since the
/// boot sequence runs before reader-pool consumers wake up. Reading
/// from the writer is fine here: we are pre-UI and have exclusive
/// access.
///
/// No-op when the op log has no rows past the cursor.
pub async fn replay_unmaterialized_ops(
    pool: &SqlitePool,
    materializer: &Materializer,
) -> Result<ReplayReport, AppError> {
    let cursor = read_apply_cursor(pool).await?;

    // #412: the apply cursor is a SINGLE GLOBAL scalar, but `op_log.seq` is a
    // PER-DEVICE counter (PK `(device_id, seq)`). The `WHERE seq > cursor` walk
    // below is only sound when the entire op_log belongs to ONE device — with
    // two devices, device B's low seqs sit `<= cursor` and are silently never
    // replayed (ops dropped on the floor at boot). Multi-device sync is not yet
    // shipped (the remote-apply path is test-only and the SyncDaemon is dormant
    // until a peer is paired), so a multi-device op_log reaching here means
    // multi-device sync was enabled BEFORE the per-device watermark cursor
    // landed. The batch-apply path already has a `debug_assert!` for the write
    // side; this is the release-build guard for the read/replay side — fail
    // loudly rather than silently diverge. The full fix (a per-device cursor +
    // `WHERE device_id = ? AND seq > ?` replay) is deferred to when
    // multi-device sync ships (schema migration, AGENTS.md arch-stability gate).
    let distinct_devices: i64 =
        sqlx::query_scalar!(r#"SELECT COUNT(DISTINCT device_id) AS "n!: i64" FROM op_log"#)
            .fetch_one(pool)
            .await?;
    if distinct_devices > 1 {
        tracing::error!(
            distinct_devices,
            "replay: op_log spans multiple devices but the materializer apply \
             cursor is a single global scalar — replay would silently drop other \
             devices' ops. The per-device watermark cursor (#412) must land before \
             multi-device sync is enabled."
        );
        return Err(AppError::InvalidOperation(format!(
            "op_log spans {distinct_devices} devices but the materializer apply \
             cursor is a single global scalar; per-device cursor partitioning is \
             required before multi-device replay (backend audit #412)"
        )));
    }

    // Count first so we can log the size before kicking off the walk.
    // The reader pool would be marginally cheaper but the writer pool
    // is the one we own at boot — see fn-level docs.
    let total: i64 = sqlx::query_scalar!(
        r#"SELECT COUNT(*) as "n!: i64" FROM op_log WHERE seq > ?"#,
        cursor,
    )
    .fetch_one(pool)
    .await?;

    if total == 0 {
        tracing::debug!(cursor, "replay: no unmaterialized ops");
        return Ok(ReplayReport::default());
    }

    tracing::info!(
        cursor,
        ops_to_replay = total,
        "replay: enqueuing unmaterialized ops on foreground queue"
    );

    let mut report = ReplayReport::default();
    let mut last_seen: i64 = cursor;

    // Walk the op log in seq-ascending chunks. We re-read each chunk
    // by `seq > last_seen` so the iteration is stateless across chunks
    // — no offset cursor to drift if a concurrent writer (there is
    // none at boot, but defence in depth) committed mid-walk.
    loop {
        let rows: Vec<OpRecord> = sqlx::query_as!(
            OpRecord,
            "SELECT device_id, seq, parent_seqs, hash, op_type, payload, created_at, block_id \
             FROM op_log \
             WHERE seq > ? \
             ORDER BY seq ASC, device_id ASC \
             LIMIT ?",
            last_seen,
            REPLAY_CHUNK_SIZE,
        )
        .fetch_all(pool)
        .await?;

        if rows.is_empty() {
            break;
        }

        for record in rows {
            last_seen = last_seen.max(record.seq);
            let task = MaterializeTask::ApplyOp(Arc::new(record));
            match materializer.enqueue_foreground(task).await {
                Ok(()) => {
                    report.ops_replayed += 1;
                }
                Err(e) => {
                    // Enqueue failure is non-fatal — log and continue.
                    // The next boot's replay will re-attempt because
                    // the cursor only advances on successful apply.
                    tracing::warn!(
                        error = %e,
                        "replay: failed to enqueue ApplyOp — will retry on next boot"
                    );
                    report.replay_errors.push(format!("enqueue: {e}"));
                }
            }
        }
    }

    // Drain the foreground queue via a Barrier so the caller observes
    // a fully-applied state on return. Without this, recover_at_boot's
    // step 2 (drafts) could enqueue synthetic edit_block ops that
    // interleave with the replayed real ops.
    materializer.flush_foreground().await?;

    tracing::info!(
        ops_replayed = report.ops_replayed,
        replay_errors = report.replay_errors.len(),
        "replay: complete"
    );

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use tempfile::TempDir;

    /// Create a temp-file-backed SQLite pool with migrations applied.
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// SQL-review H-4: when the cursor row stores a `materialized_through_seq`
    /// value greater than `MAX(op_log.seq)` (which the apply path
    /// guarantees can never happen by `MAX(materialized_through_seq, ?)`
    /// semantics, but could arise from a hand-edit / partial restore /
    /// rolled-back op_log), `read_apply_cursor` must detect the
    /// impossible state, log a warning, and reset the cursor down to
    /// `MAX(op_log.seq)` so the next replay walk does not silently miss
    /// unmaterialized ops.
    #[tokio::test]
    async fn apply_cursor_sanity_resets_when_cursor_exceeds_max_seq() {
        let (pool, _dir) = test_pool().await;

        // Insert 3 op_log rows (seqs 1..=3) directly. We bypass
        // `append_local_op` because this test is about cursor sanity, not
        // op-log construction — raw INSERTs with valid column values are
        // simpler and don't drag in OpPayload fixtures.
        for seq in 1..=3i64 {
            sqlx::query(
                "INSERT INTO op_log \
                 (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                 VALUES (?, ?, NULL, ?, 'create_block', '{}', 1767225600000)",
            )
            .bind("test-device")
            .bind(seq)
            .bind(format!("hash-{seq}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        // Corrupt the cursor: set it well past MAX(op_log.seq) = 3.
        sqlx::query(
            "UPDATE materializer_apply_cursor \
             SET materialized_through_seq = ?, \
                 updated_at = 1767225600000 \
             WHERE id = 1",
        )
        .bind(9999i64)
        .execute(&pool)
        .await
        .unwrap();

        // Call the function under test.
        let returned = read_apply_cursor(&pool).await.unwrap();
        assert_eq!(
            returned, 3,
            "read_apply_cursor should clamp an over-shoot cursor down to MAX(op_log.seq)"
        );

        // The DB row must have been rewritten — otherwise the next boot
        // would observe the same corruption.
        let row_seq: i64 = sqlx::query_scalar(
            "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row_seq, 3,
            "materializer_apply_cursor row must be reset to MAX(op_log.seq) on disk, \
             not just in the return value"
        );
    }

    /// Self-heal: when `loro_doc_state` is empty (the persisted Loro
    /// snapshot is missing) but the apply cursor is non-zero, the
    /// in-memory engine cannot be rebuilt from the snapshot, so
    /// `heal_orphaned_apply_cursor` must reset the cursor to 0 — forcing a full
    /// op-log replay that reconstructs the engine. Regression guard for
    /// the deleted snapshot scheduler that left `loro_doc_state` empty
    /// while the cursor advanced, wedging every edit on "block not found".
    #[tokio::test]
    async fn apply_cursor_resets_to_zero_when_snapshot_missing() {
        let (pool, _dir) = test_pool().await;

        // Insert 3 op_log rows (seqs 1..=3); leave `loro_doc_state` empty.
        for seq in 1..=3i64 {
            sqlx::query(
                "INSERT INTO op_log \
                 (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                 VALUES (?, ?, NULL, ?, 'create_block', '{}', 1767225600000)",
            )
            .bind("test-device")
            .bind(seq)
            .bind(format!("hash-{seq}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        // Cursor claims everything is materialized (== MAX(op_log.seq)),
        // so the over-shoot guard does NOT fire — only the snapshot-empty
        // guard should.
        sqlx::query(
            "UPDATE materializer_apply_cursor \
             SET materialized_through_seq = 3, \
                 updated_at = 1767225600000 \
             WHERE id = 1",
        )
        .execute(&pool)
        .await
        .unwrap();

        let healed = heal_orphaned_apply_cursor(&pool).await.unwrap();
        assert!(
            healed,
            "heal must reset the cursor when loro_doc_state is empty"
        );

        let row_seq: i64 = sqlx::query_scalar(
            "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row_seq, 0,
            "materializer_apply_cursor row must be reset to 0 on disk for a full rebuild"
        );
    }

    /// A snapshot whose watermark already covers the cursor (the snapshot
    /// is current) must NOT trigger a reset — the normal incremental replay
    /// (`seq > cursor`) applies and the cursor is returned as-is.
    #[tokio::test]
    async fn apply_cursor_preserved_when_snapshot_current() {
        let (pool, _dir) = test_pool().await;

        for seq in 1..=3i64 {
            sqlx::query(
                "INSERT INTO op_log \
                 (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                 VALUES (?, ?, NULL, ?, 'create_block', '{}', 1767225600000)",
            )
            .bind("test-device")
            .bind(seq)
            .bind(format!("hash-{seq}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        // Seed a snapshot whose watermark (2) >= the cursor (2): the
        // snapshot already reflects everything the cursor claims, so the
        // heal must leave the cursor alone.
        sqlx::query(
            "INSERT INTO loro_doc_state \
             (space_id, snapshot, updated_at, op_count, applied_through_seq) \
             VALUES ('test-space', X'00', 0, 0, 2)",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "UPDATE materializer_apply_cursor \
             SET materialized_through_seq = 2, \
                 updated_at = 1767225600000 \
             WHERE id = 1",
        )
        .execute(&pool)
        .await
        .unwrap();

        let healed = heal_orphaned_apply_cursor(&pool).await.unwrap();
        assert!(
            !healed,
            "heal must be a no-op when the snapshot watermark covers the cursor"
        );
        let row_seq: i64 = sqlx::query_scalar(
            "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row_seq, 2,
            "cursor must be preserved when the snapshot watermark covers it"
        );
    }

    /// /C2 repro: a snapshot that is *present but stale*
    /// (`applied_through_seq` < cursor — the crash let the cursor run ahead
    /// of the last periodic snapshot) must rewind the cursor down to the
    /// watermark so replay re-applies the unmaterialized tail onto the
    /// behind engine. The old `COUNT(*) > 0` gate left the cursor ahead and
    /// wedged every later edit on "block not found".
    #[tokio::test]
    async fn apply_cursor_rewinds_to_watermark_when_snapshot_stale() {
        let (pool, _dir) = test_pool().await;

        for seq in 1..=3i64 {
            sqlx::query(
                "INSERT INTO op_log \
                 (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                 VALUES (?, ?, NULL, ?, 'create_block', '{}', 1767225600000)",
            )
            .bind("test-device")
            .bind(seq)
            .bind(format!("hash-{seq}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        // Snapshot reflects ops only through seq 1, but the cursor advanced
        // to 3 (two ops applied after the last snapshot, then a crash).
        sqlx::query(
            "INSERT INTO loro_doc_state \
             (space_id, snapshot, updated_at, op_count, applied_through_seq) \
             VALUES ('test-space', X'00', 0, 0, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE materializer_apply_cursor \
             SET materialized_through_seq = 3, \
                 updated_at = 1767225600000 \
             WHERE id = 1",
        )
        .execute(&pool)
        .await
        .unwrap();

        let healed = heal_orphaned_apply_cursor(&pool).await.unwrap();
        assert!(healed, "heal must rewind the cursor for a stale snapshot");

        let row_seq: i64 = sqlx::query_scalar(
            "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row_seq, 1,
            "cursor must rewind to the snapshot watermark so replay re-applies seq 2..3"
        );
    }

    /// #619: the compaction-floor predicate. A "full rebuild" rewind target
    /// below `MIN(op_log.seq) - 1` means the op-log head was compacted away
    /// and the replay can only reconstruct the surviving tail.
    #[tokio::test]
    async fn compacted_floor_above_detects_purged_op_log_head_619() {
        let (pool, _dir) = test_pool().await;

        // Empty op_log: nothing was compacted "above" any target.
        assert!(
            !compacted_floor_above(&pool, 0).await.unwrap(),
            "empty op_log must not flag a floor violation"
        );

        // Simulate a compacted log: seqs 5..=8 survive (1..=4 purged).
        for seq in 5..=8i64 {
            sqlx::query(
                "INSERT INTO op_log \
                 (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                 VALUES (?, ?, NULL, ?, 'create_block', '{}', 1767225600000)",
            )
            .bind("test-device")
            .bind(seq)
            .bind(format!("hash-{seq}"))
            .execute(&pool)
            .await
            .unwrap();
        }

        assert!(
            compacted_floor_above(&pool, 0).await.unwrap(),
            "rewind-to-0 against a compacted log under-rebuilds (#619)"
        );
        assert!(
            compacted_floor_above(&pool, 3).await.unwrap(),
            "a target below MIN(seq)-1 still misses compacted ops"
        );
        assert!(
            !compacted_floor_above(&pool, 4).await.unwrap(),
            "target == MIN(seq)-1 covers every surviving op — no violation"
        );
        assert!(
            !compacted_floor_above(&pool, 7).await.unwrap(),
            "targets above the floor are fine"
        );
    }

    /// #851: the compaction floor is PER DEVICE, not global. `op_log.seq` is
    /// per-device (PK `(device_id, seq)`); `compact_op_log` purges per device.
    /// A device compacted up to a high head must trip the floor even when
    /// another device's freshly-paired low seq keeps the GLOBAL `MIN(seq)`
    /// at 1 (the old global query false-negatived this).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn compacted_floor_is_per_device_not_global_851() {
        let (pool, _dir) = test_pool().await;

        let insert = |dev: &'static str, seq: i64| {
            let pool = pool.clone();
            async move {
                sqlx::query(
                    "INSERT INTO op_log \
                     (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                     VALUES (?, ?, NULL, ?, 'create_block', '{}', 1767225600000)",
                )
                .bind(dev)
                .bind(seq)
                .bind(format!("{dev}-hash-{seq}"))
                .execute(&pool)
                .await
                .unwrap();
            }
        };

        // Device A was compacted: only seqs 100..=102 survive (1..=99 purged).
        // Device B is freshly paired: its seqs start at 1 and are intact.
        for seq in 100..=102i64 {
            insert("device-A", seq).await;
        }
        for seq in 1..=3i64 {
            insert("device-B", seq).await;
        }

        // GLOBAL MIN(seq) is 1 (device B). The OLD global check would compute
        // `reset_to < 1 - 1 = 0` and FALSE-NEGATIVE every non-negative target.
        // The per-device floor is MAX(MIN over devices) = MIN(seq) of device A
        // = 100, so the binding floor-minus-one is 99.
        assert!(
            compacted_floor_above(&pool, 0).await.unwrap(),
            "rewind-to-0 must trip the per-device floor (device A head purged) — \
             the global MIN(seq)=1 must NOT mask it (#851)"
        );
        assert!(
            compacted_floor_above(&pool, 98).await.unwrap(),
            "a target below device A's MIN(seq)-1 (=99) still misses device A's purged head"
        );
        assert!(
            !compacted_floor_above(&pool, 99).await.unwrap(),
            "target == device A's MIN(seq)-1 covers every surviving op — no violation"
        );
        assert!(
            !compacted_floor_above(&pool, 200).await.unwrap(),
            "targets above the floor are fine"
        );
    }

    /// #851: a genuinely non-compacted multi-device log (every device's head
    /// starts at seq 1) must NOT trip the floor — the per-device fix must not
    /// over-fire on a healthy multi-device op_log.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn per_device_floor_no_false_positive_when_uncompacted_851() {
        let (pool, _dir) = test_pool().await;

        for (dev, max) in [("device-A", 3i64), ("device-B", 5i64)] {
            for seq in 1..=max {
                sqlx::query(
                    "INSERT INTO op_log \
                     (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                     VALUES (?, ?, NULL, ?, 'create_block', '{}', 1767225600000)",
                )
                .bind(dev)
                .bind(seq)
                .bind(format!("{dev}-hash-{seq}"))
                .execute(&pool)
                .await
                .unwrap();
            }
        }

        // Every device's MIN(seq) is 1, so MAX(MIN) = 1 and the floor-minus-one
        // is 0: a full rebuild from 0 is genuine, no violation.
        assert!(
            !compacted_floor_above(&pool, 0).await.unwrap(),
            "an uncompacted multi-device log must not false-positive the floor (#851)"
        );
    }

    /// #619: the heal still rewinds on a compacted log (replaying the tail
    /// heals strictly more than leaving the engines empty) — the floor
    /// violation is surfaced via `error!`, not by aborting the heal. Pins
    /// the rewind-still-happens behaviour the loud log documents.
    #[tokio::test]
    async fn heal_still_rewinds_when_op_log_head_compacted_619() {
        let (pool, _dir) = test_pool().await;

        // Compacted log (head purged), empty loro_doc_state, cursor ahead.
        for seq in 5..=8i64 {
            sqlx::query(
                "INSERT INTO op_log \
                 (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
                 VALUES (?, ?, NULL, ?, 'create_block', '{}', 1767225600000)",
            )
            .bind("test-device")
            .bind(seq)
            .bind(format!("hash-{seq}"))
            .execute(&pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "UPDATE materializer_apply_cursor \
             SET materialized_through_seq = 8, \
                 updated_at = 1767225600000 \
             WHERE id = 1",
        )
        .execute(&pool)
        .await
        .unwrap();

        let healed = heal_orphaned_apply_cursor(&pool).await.unwrap();
        assert!(healed, "heal must still rewind on a compacted op_log");

        let row_seq: i64 = sqlx::query_scalar(
            "SELECT materialized_through_seq FROM materializer_apply_cursor WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row_seq, 0,
            "the rewind target is unchanged — the floor violation is a loud \
             error!, not a behaviour change (#619)"
        );
    }
}
