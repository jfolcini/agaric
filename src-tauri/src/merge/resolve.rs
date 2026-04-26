use chrono::DateTime;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::materializer::{MaterializeTask, Materializer};
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

    // M-76: Verify the parent block is alive (not soft-deleted) before
    // creating the conflict copy. Without this guard, a merge that runs
    // concurrently with a soft-delete of the parent would produce an
    // orphan-under-tombstone block: the FK still passes (the parent row
    // exists with `deleted_at` set) but `cascade_soft_delete` will not
    // reach the new copy unless the user later re-deletes the parent,
    // leaving a phantom block in the trash hierarchy. Mirrors the
    // symmetric F08 guard in `recovery/draft_recovery.rs:46-64` for
    // synthetic edit_block recovery.
    if let Some(pid) = parent_id.as_deref() {
        let parent_alive = sqlx::query!(
            "SELECT id FROM blocks WHERE id = ? AND deleted_at IS NULL",
            pid
        )
        .fetch_optional(pool)
        .await?;
        if parent_alive.is_none() {
            return Err(AppError::InvalidOperation(format!(
                "cannot create conflict copy for block '{original_block_id}': \
                 parent '{pid}' is soft-deleted or missing"
            )));
        }
    }

    // 2. Generate a new block ID
    let new_block_id = BlockId::new();
    tracing::info!(original_block_id, new_block_id = %new_block_id, conflict_type, "creating conflict copy");
    // M-13: Use MAX(position) + 1 among siblings to avoid position collision.
    // Previous approach used position + 1 which could collide with existing siblings.
    // P-18: When original position is the sentinel (or NULL before migration),
    // keep the sentinel instead of incrementing (which would overflow i64::MAX).
    // BUG-24: Exclude sibling rows that already carry the sentinel from the
    // MAX() scan. Otherwise `max_pos + 1` would overflow i64::MAX when any
    // sibling (e.g. a NULL-position tag stored under the same parent) holds
    // the sentinel value.
    let new_position = match position {
        Some(p) if p == NULL_POSITION_SENTINEL => Some(NULL_POSITION_SENTINEL),
        Some(_p) => {
            let max_pos: Option<i64> = sqlx::query_scalar(
                "SELECT MAX(position) FROM blocks \
                 WHERE parent_id IS ? AND deleted_at IS NULL AND position != ?",
            )
            .bind(parent_id.as_deref())
            .bind(NULL_POSITION_SENTINEL)
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

    // Copy tags from the original block.
    // M-75: Filter out rows whose tag-block is soft-deleted or itself a
    // conflict copy, so the new conflict copy doesn't end up "tagged but
    // invisibly tagged" (the tags_cache rebuild would skip those rows).
    sqlx::query(
        "INSERT INTO block_tags (block_id, tag_id) \
         SELECT ?1, bt.tag_id \
         FROM block_tags bt \
         JOIN blocks t ON t.id = bt.tag_id \
         WHERE bt.block_id = ?2 \
           AND t.deleted_at IS NULL \
           AND t.is_conflict = 0",
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

/// M-74: Create a conflict-copy block AND enqueue a `ReindexBlockLinks`
/// task so the conflict copy gets graph context (forward links from any
/// `[[ULID]]` / `((ULID))` tokens in `conflict_content`) on the next
/// materializer dispatch instead of waiting for the periodic re-index
/// cycle. Without this enqueue, when the user clicks the conflict copy
/// in Status View, no references / backlinks display until the next
/// reindex cycle, making it hard to compare against the original.
///
/// Mirrors the synthetic-edit post-recovery handling in
/// `recovery/cache_refresh.rs:44-48`. The wrapped
/// [`create_conflict_copy`] commits the inner transaction first; the
/// background enqueue happens **after** the commit so the new block row
/// is durable before the materializer attempts to read it.
///
/// The enqueued task is idempotent and dedup'd by the materializer
/// (see `materializer::dedup`) — re-issuing it for the same block_id
/// is safe.
pub async fn create_conflict_copy_with_reindex(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    original_block_id: &str,
    conflict_content: &str,
    conflict_type: &str,
) -> Result<OpRecord, AppError> {
    let record = create_conflict_copy(
        pool,
        device_id,
        original_block_id,
        conflict_content,
        conflict_type,
    )
    .await?;

    // Extract the freshly minted block_id from the op record's payload.
    // `create_conflict_copy` always returns a `create_block` record, so
    // the JSON parse is infallible in practice — but propagate any
    // serde error rather than panicking, to match the rest of the
    // module's error-handling style.
    let payload: CreateBlockPayload = serde_json::from_str(&record.payload)?;
    let new_block_id = payload.block_id.into_string();

    materializer
        .enqueue_background(MaterializeTask::ReindexBlockLinks {
            block_id: new_block_id,
        })
        .await?;

    Ok(record)
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

// =====================================================================
// REVIEW-LATER M-74 + M-76 — `create_conflict_copy` regression coverage
// =====================================================================
//
// M-74: `create_conflict_copy` itself does NOT enqueue
// `MaterializeTask::ReindexBlockLinks`; the new wrapper
// [`create_conflict_copy_with_reindex`] handles the enqueue so the
// conflict copy gets graph context (forward links from any
// `[[ULID]]` / `((ULID))` tokens) on the next materializer dispatch
// instead of waiting for the periodic reindex cycle.
//
// M-76: `create_conflict_copy` rejects merges that would otherwise
// produce an orphan-under-tombstone block when the parent has been
// concurrently soft-deleted.  Mirrors the F08 guard already enforced
// for synthetic `edit_block` recovery in
// `recovery/draft_recovery.rs:46-64`.
#[cfg(test)]
mod tests_m74_m76 {
    use super::*;
    use crate::materializer::Materializer;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use tempfile::TempDir;

    const DEV_A: &str = "device-A";
    const SOFT_DEL_TS: &str = "2025-01-15T12:00:00Z";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = crate::db::init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn insert_block(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        content: &str,
        parent_id: Option<&str>,
        position: Option<i64>,
    ) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(parent_id)
        .bind(position)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn soft_delete(pool: &SqlitePool, id: &str) {
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(SOFT_DEL_TS)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn count_conflict_blocks(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks WHERE is_conflict = 1")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    // --- M-74 ---------------------------------------------------------

    /// `create_conflict_copy_with_reindex` must enqueue exactly one
    /// `ReindexBlockLinks` task on the materializer's background queue
    /// after committing the inner `create_conflict_copy` transaction.
    /// Verified via `bg_high_water` (incremented on
    /// `enqueue_background`) and via `bg_processed` after an explicit
    /// flush (covering both the enqueue and the consumer-side
    /// processing path).
    ///
    /// The conflict_content is `[[<TARGET>]]` so the token is real —
    /// even though the materializer's `reindex_block_links` filters
    /// `is_conflict = 0` (M-14, prevents conflict copies from
    /// contributing outbound links), the *enqueue* still happens and
    /// is what M-74 asks us to schedule.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_conflict_copy_enqueues_reindex_block_links() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        // Wait for the materializer's startup task (initial block-count
        // cache refresh) so it cannot race with our metric reads. That
        // task runs on the reader pool and never enqueues a background
        // task, but draining it first removes any ambiguity.
        mat.wait_for_initial_block_count_cache().await;

        // A real ULID-shaped target so `[[…]]` is a parseable token.
        let target = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        insert_block(&pool, target, "content", "target body", None, Some(0)).await;

        // The original block whose merge is being conflict-copied.
        insert_block(&pool, "ORIGINAL", "content", "ours", None, Some(1)).await;

        let conflict_content = format!("see [[{target}]]");

        let baseline_bg_high = mat.metrics().bg_high_water.load(Ordering::Relaxed);
        let baseline_bg_processed = mat.metrics().bg_processed.load(Ordering::Relaxed);

        let record = create_conflict_copy_with_reindex(
            &pool,
            DEV_A,
            &mat,
            "ORIGINAL",
            &conflict_content,
            "Text",
        )
        .await
        .expect("conflict copy with reindex should succeed");

        // The op must be a `create_block` op with a brand-new block_id
        // distinct from the original.
        assert_eq!(record.op_type, "create_block");
        let payload: CreateBlockPayload =
            serde_json::from_str(&record.payload).expect("payload parses");
        let new_block_id = payload.block_id.into_string();
        assert_ne!(new_block_id, "ORIGINAL");

        // bg_high_water is updated via fetch_max immediately on
        // enqueue_background (see coordinator.rs ~L506-509), so it
        // captures the peak depth even if the consumer drains the
        // task before this assertion runs.
        let bg_high = mat.metrics().bg_high_water.load(Ordering::Relaxed);
        assert!(
            bg_high >= baseline_bg_high + 1,
            "bg_high_water must advance by at least 1 after \
             create_conflict_copy_with_reindex (was {baseline_bg_high}, now {bg_high})"
        );

        // Drain the background queue so the spawned consumer has
        // demonstrably consumed our enqueued task (and the trailing
        // barrier that flush_background appends).
        mat.flush_background().await.unwrap();
        let bg_processed = mat.metrics().bg_processed.load(Ordering::Relaxed);
        assert!(
            bg_processed >= baseline_bg_processed + 1,
            "background consumer must have processed at least one task \
             (was {baseline_bg_processed}, now {bg_processed})"
        );
    }

    // --- M-76 ---------------------------------------------------------

    /// When the parent of the original block has been soft-deleted
    /// concurrently with the merge, `create_conflict_copy` must refuse
    /// to materialise a new conflict copy that would inherit the
    /// soft-deleted `parent_id`. Otherwise the FK passes (parent row
    /// exists with `deleted_at` set) but `cascade_soft_delete` will
    /// not reach the new copy unless the parent is later re-deleted —
    /// producing a phantom orphan-under-tombstone block.
    ///
    /// The error variant is `AppError::InvalidOperation`: the parent
    /// *exists* (so `NotFound` would be misleading) but the operation
    /// is rejected because executing it would violate the lifecycle
    /// invariant.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_conflict_copy_rejects_soft_deleted_parent() {
        let (pool, _dir) = test_pool().await;

        // Parent + child, then soft-delete the parent.
        insert_block(&pool, "PARENT", "page", "parent page", None, Some(0)).await;
        insert_block(
            &pool,
            "CHILD",
            "content",
            "child body",
            Some("PARENT"),
            Some(1),
        )
        .await;
        soft_delete(&pool, "PARENT").await;

        let before = count_conflict_blocks(&pool).await;

        let result = create_conflict_copy(&pool, DEV_A, "CHILD", "conflict text", "Text").await;

        let err =
            result.expect_err("create_conflict_copy must reject a soft-deleted parent (M-76)");
        match err {
            AppError::InvalidOperation(msg) => {
                assert!(
                    msg.contains("PARENT") && msg.contains("soft-deleted"),
                    "InvalidOperation message should name the parent and mention \
                     soft-delete (got: {msg})"
                );
            }
            other => {
                panic!("expected AppError::InvalidOperation for soft-deleted parent, got {other:?}")
            }
        }

        // No new conflict block must have been inserted.
        let after = count_conflict_blocks(&pool).await;
        assert_eq!(
            before, after,
            "no conflict block should be inserted when the parent is soft-deleted \
             (had {before}, now {after})"
        );
    }

    /// Sanity test: with a live (non-deleted) parent, `create_conflict_copy`
    /// continues to succeed and inserts a new conflict block whose
    /// `parent_id` matches the original. Guards against accidentally
    /// over-rejecting when the M-76 guard was added.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_conflict_copy_happy_path_alive_parent() {
        let (pool, _dir) = test_pool().await;

        insert_block(&pool, "PARENT", "page", "parent page", None, Some(0)).await;
        insert_block(
            &pool,
            "CHILD",
            "content",
            "child body",
            Some("PARENT"),
            Some(1),
        )
        .await;

        let before = count_conflict_blocks(&pool).await;

        let record = create_conflict_copy(&pool, DEV_A, "CHILD", "conflict text", "Text")
            .await
            .expect("conflict copy with alive parent must succeed");

        let payload: CreateBlockPayload =
            serde_json::from_str(&record.payload).expect("payload parses");
        let new_block_id = payload.block_id.into_string();
        assert_ne!(new_block_id, "CHILD");

        // The new conflict block exists, is flagged as a conflict copy,
        // points at the original block via `conflict_source`, and
        // inherits the (live) parent.
        let row = sqlx::query!(
            "SELECT parent_id, is_conflict, conflict_source \
             FROM blocks WHERE id = ?",
            new_block_id
        )
        .fetch_one(&pool)
        .await
        .expect("new conflict block row");
        assert_eq!(row.parent_id.as_deref(), Some("PARENT"));
        assert_eq!(row.is_conflict, 1);
        assert_eq!(row.conflict_source.as_deref(), Some("CHILD"));

        let after = count_conflict_blocks(&pool).await;
        assert_eq!(
            after,
            before + 1,
            "exactly one new conflict block must be inserted on the happy path \
             (had {before}, now {after})"
        );
    }
}
