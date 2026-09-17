//! Repair 3 (#5074) — `completed_at` present iff `todo_state = 'DONE'`.
//!
//! `set_todo_state` maintained `completed_at` on only some of the edges into
//! and out of DONE, so it drifted both ways: `CANCELLED → DONE` and
//! `null → DONE` left a DONE task with no stamp, shown in no Completed panel,
//! and `DONE → CANCELLED` left the stamp on a task that is not done, which
//! `DonePanel` still lists under Completed because `queryByProperty` filters
//! on the date alone. The write side now holds the invariant on every edge;
//! this restores it on both directions of what was written before it did. A
//! measured vault carried 4 missing stamps of 32.
//!
//! # The backfilled value
//!
//! `created_at` — and, when that is absent too, the day encoded in the
//! block's own ULID. Both are true lower bounds rather than guesses: a task
//! cannot be completed before it became a task, or before its block existed.
//! Recovery from the op log is not an option: on the measured vault the log
//! starts after these blocks were created and carries no op on any of them.
//!
//! # Why not a migration
//!
//! `block_properties` is a projection; a raw SQL row would be erased by the
//! next `reproject_block_properties_from_engine` and would never reach the
//! other device. The `SetProperty` op emitted here is the same one the
//! interactive transition writes.
//!
//! Idempotent by construction: a backfilled block has a `completed_at` and a
//! cleared one has none, so neither is a candidate on the next run.

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::db::now_ms;
use agaric_store::op::{DeletePropertyPayload, OpPayload};
use agaric_store::op_log::{self, OpRecord};
use agaric_store::task_locals::ACTOR;

use super::{RepairOp, housekeeping};
use crate::apply::kernel::apply_op_projected;
use crate::block_ops::set_property_in_tx;
use crate::loro::shared::LoroState;

/// What one run of the `completed_at` repair did.
#[derive(Debug, Default)]
pub struct CompletedAtRepair {
    /// Ops emitted, in append order, for the driver to dispatch after commit.
    pub ops: Vec<RepairOp>,
    /// DONE blocks given a `completed_at` this run.
    pub backfilled: usize,
    /// Blocks that are not DONE whose stale `completed_at` this run removed.
    pub cleared: usize,
}

/// A live DONE block with no `completed_at`, and its `created_at` if it has
/// one.
#[derive(Debug)]
struct Candidate {
    id: String,
    created_at: Option<String>,
}

/// Candidates in id (creation) order.
async fn select_candidates(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<Candidate>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT b.id AS "id!: String", c.value_date AS created_at
           FROM blocks b
           LEFT JOIN block_properties c ON c.block_id = b.id AND c.key = 'created_at'
           WHERE b.todo_state = 'DONE'
             AND b.deleted_at IS NULL
             AND NOT EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id AND p.key = 'completed_at'
             )
           ORDER BY b.id"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Candidate {
            id: r.id,
            created_at: r.created_at,
        })
        .collect())
}

/// Live blocks that are not DONE but carry a `completed_at`, in id order.
async fn select_stale_stamps(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<String>, AppError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT b.id AS "id!: String"
           FROM blocks b
           WHERE (b.todo_state IS NULL OR b.todo_state <> 'DONE')
             AND b.deleted_at IS NULL
             AND EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id AND p.key = 'completed_at'
             )
           ORDER BY b.id"#,
    )
    .fetch_all(&mut **tx)
    .await?)
}

/// The local calendar day the ULID `id` was minted on — the same clock and
/// format `set_todo_state` stamps `created_at` / `completed_at` with.
fn ulid_day(id: &str) -> Result<String, AppError> {
    let ms = ulid::Ulid::from_string(id)
        .map_err(|e| {
            AppError::InvalidOperation(format!("repair: block id '{id}' is not a ULID: {e}"))
        })?
        .timestamp_ms();
    let ms = i64::try_from(ms)
        .ok()
        .and_then(chrono::DateTime::from_timestamp_millis)
        .ok_or_else(|| {
            AppError::InvalidOperation(format!(
                "repair: block id '{id}' has an out-of-range timestamp"
            ))
        })?;
    Ok(ms
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d")
        .to_string())
}

/// Remove `completed_at` from `block_id` through the same `DeleteProperty` op
/// the interactive edge out of DONE appends (`delete_property_in_tx`). The
/// engine crate has no `CommandTx`, so the op is appended and applied here and
/// the driver dispatches it after commit, as [`super::soft_delete`] does.
async fn clear_completed_at(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    block_id: &str,
) -> Result<OpRecord, AppError> {
    let payload = OpPayload::DeleteProperty(DeletePropertyPayload {
        block_id: BlockId::from_trusted(block_id),
        key: "completed_at".to_owned(),
    });
    let record = op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;
    apply_op_projected(tx, &record, state, false).await?;
    Ok(record)
}

/// Restore `completed_at` present iff DONE, in both directions: stamp every
/// live DONE block that has none, clear it from every live block that is not
/// DONE and still carries one.
pub async fn repair_completed_at(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<CompletedAtRepair, AppError> {
    let candidates = select_candidates(tx).await?;
    let stale = select_stale_stamps(tx).await?;
    ACTOR
        .scope(housekeeping("completed_at"), async {
            let mut report = CompletedAtRepair::default();
            for candidate in candidates {
                let day = match candidate.created_at {
                    Some(day) => day,
                    None => ulid_day(&candidate.id)?,
                };
                let (_block, record) = set_property_in_tx(
                    tx,
                    state,
                    device_id,
                    candidate.id,
                    "completed_at",
                    None,
                    None,
                    Some(day),
                    None,
                    None,
                )
                .await?;
                report.ops.push(RepairOp::Plain(record));
                report.backfilled += 1;
            }
            for block_id in stale {
                let record = clear_completed_at(tx, state, device_id, &block_id).await?;
                report.ops.push(RepairOp::Plain(record));
                report.cleared += 1;
            }
            Ok(report)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use crate::spaces::SPACE_PERSONAL_ULID;
    use agaric_store::task_locals::Actor;
    use chrono::TimeZone;
    use sqlx::SqlitePool;

    async fn run(pool: &SqlitePool, state: &LoroState) -> CompletedAtRepair {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let report = repair_completed_at(&mut tx, state, DEV).await.unwrap();
        tx.commit().await.unwrap();
        report
    }

    /// A content block under Personal by a given id, with `todo_state` set
    /// (or left NULL — a block that is not a task at all).
    async fn insert_task(pool: &SqlitePool, id: &str, todo_state: Option<&str>) {
        insert(
            pool,
            Row {
                id,
                block_type: "content",
                content: "task",
                parent_id: Some(SPACE_PERSONAL_ULID),
                page_id: Some(SPACE_PERSONAL_ULID),
                space_id: Some(SPACE_PERSONAL_ULID),
                position: 1,
            },
        )
        .await;
        sqlx::query!(
            "UPDATE blocks SET todo_state = ? WHERE id = ?",
            todo_state,
            id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn date_property(pool: &SqlitePool, id: &str, key: &str, day: &str) {
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
            id,
            key,
            day,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn date_value(pool: &SqlitePool, id: &str, key: &str) -> Option<String> {
        sqlx::query_scalar!(
            "SELECT value_date FROM block_properties WHERE block_id = ? AND key = ?",
            id,
            key,
        )
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten()
    }

    async fn completed_at(pool: &SqlitePool, id: &str) -> Option<String> {
        date_value(pool, id, "completed_at").await
    }

    #[tokio::test]
    async fn done_without_completed_at_gets_its_created_at() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let id = next_id();
        insert_task(&pool, &id, Some("DONE")).await;
        date_property(&pool, &id, "created_at", "2026-04-15").await;

        let report = run(&pool, &state).await;

        assert_eq!(report.backfilled, 1);
        assert_eq!(report.cleared, 0, "the clear arm has nothing to do here");
        assert_eq!(report.ops.len(), 1);
        assert_eq!(
            completed_at(&pool, &id).await.as_deref(),
            Some("2026-04-15")
        );
        assert_eq!(
            ops_on(&pool, &id).await,
            vec![("set_property".to_owned(), Actor::Housekeeping.origin_tag())],
            "an op, not a raw row, and housekeeping so it is outside undo"
        );
    }

    #[tokio::test]
    async fn done_without_created_at_gets_the_day_its_ulid_was_minted() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        // Noon local, so the day is the same whichever zone the test runs in.
        let minted = chrono::Local
            .with_ymd_and_hms(2026, 4, 20, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis();
        let id = ulid::Ulid::from_parts(u64::try_from(minted).unwrap(), 7).to_string();
        insert_task(&pool, &id, Some("DONE")).await;

        let report = run(&pool, &state).await;

        assert_eq!(report.backfilled, 1);
        assert_eq!(
            completed_at(&pool, &id).await.as_deref(),
            Some("2026-04-20")
        );
    }

    /// Guards: not DONE, already stamped, or deleted — untouched, no op.
    #[tokio::test]
    async fn only_live_done_blocks_without_completed_at_are_candidates() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let todo = next_id();
        insert_task(&pool, &todo, Some("TODO")).await;
        let stamped = next_id();
        insert_task(&pool, &stamped, Some("DONE")).await;
        date_property(&pool, &stamped, "completed_at", "2026-01-01").await;
        let deleted = next_id();
        insert_task(&pool, &deleted, Some("DONE")).await;
        sqlx::query!("UPDATE blocks SET deleted_at = 1 WHERE id = ?", deleted)
            .execute(&pool)
            .await
            .unwrap();
        let deleted_stale = next_id();
        insert_task(&pool, &deleted_stale, None).await;
        date_property(&pool, &deleted_stale, "completed_at", "2026-01-02").await;
        sqlx::query!(
            "UPDATE blocks SET deleted_at = 1 WHERE id = ?",
            deleted_stale,
        )
        .execute(&pool)
        .await
        .unwrap();

        let report = run(&pool, &state).await;

        assert_eq!(report.backfilled, 0);
        assert_eq!(report.cleared, 0);
        assert_eq!(report.ops.len(), 0);
        assert_eq!(op_count(&pool).await, 0, "no op may be emitted");
        assert_eq!(completed_at(&pool, &todo).await, None);
        assert_eq!(
            completed_at(&pool, &stamped).await.as_deref(),
            Some("2026-01-01"),
            "an existing stamp is never overwritten"
        );
        assert_eq!(completed_at(&pool, &deleted).await, None);
        assert_eq!(
            completed_at(&pool, &deleted_stale).await.as_deref(),
            Some("2026-01-02"),
            "a soft-deleted block is out of scope in the clear direction too"
        );
    }

    /// The mirror population: not DONE, still stamped. `DonePanel` queries
    /// `completed_at` with no `todo_state` filter, so this row was listed
    /// under Completed until the stamp went away.
    #[tokio::test]
    async fn a_block_that_is_not_done_loses_its_completed_at() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let cancelled = next_id();
        insert_task(&pool, &cancelled, Some("CANCELLED")).await;
        date_property(&pool, &cancelled, "completed_at", "2026-03-03").await;
        date_property(&pool, &cancelled, "created_at", "2026-03-01").await;
        let untasked = next_id();
        insert_task(&pool, &untasked, None).await;
        date_property(&pool, &untasked, "completed_at", "2026-03-04").await;

        let report = run(&pool, &state).await;

        assert_eq!(report.cleared, 2);
        assert_eq!(
            report.backfilled, 0,
            "the backfill arm has nothing to do here"
        );
        assert_eq!(report.ops.len(), 2);
        assert_eq!(completed_at(&pool, &cancelled).await, None);
        assert_eq!(completed_at(&pool, &untasked).await, None);
        assert_eq!(
            date_value(&pool, &cancelled, "created_at").await.as_deref(),
            Some("2026-03-01"),
            "only `completed_at` is touched"
        );
        assert_eq!(
            ops_on(&pool, &cancelled).await,
            vec![(
                "delete_property".to_owned(),
                Actor::Housekeeping.origin_tag()
            )],
            "an op, not a raw DELETE, and housekeeping so it is outside undo"
        );
    }

    /// Error path: a clear the write refuses fails the whole repair, so the
    /// caller's rollback leaves the stale stamp for the next boot rather than
    /// a half-applied run.
    #[tokio::test]
    async fn a_refused_clear_fails_the_repair_and_leaves_the_stamp() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let stale = next_id();
        insert_task(&pool, &stale, Some("CANCELLED")).await;
        date_property(&pool, &stale, "completed_at", "2026-03-03").await;
        sqlx::query(
            "CREATE TRIGGER fail_clear BEFORE INSERT ON op_log \
             WHEN NEW.op_type = 'delete_property' \
             BEGIN SELECT RAISE(ABORT, 'injected clear failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let err = repair_completed_at(&mut tx, &state, DEV).await.unwrap_err();
        tx.rollback().await.unwrap();

        assert!(
            err.to_string().contains("injected clear failure"),
            "unexpected error: {err}"
        );
        assert_eq!(
            completed_at(&pool, &stale).await.as_deref(),
            Some("2026-03-03"),
            "the stamp survives for the next boot to retry"
        );
        assert_eq!(op_count(&pool).await, 0);
    }

    /// Idempotent in both directions: what the first run fixed is not a
    /// candidate for the second.
    #[tokio::test]
    async fn rerun_is_a_noop() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let id = next_id();
        insert_task(&pool, &id, Some("DONE")).await;
        let stale = next_id();
        insert_task(&pool, &stale, Some("CANCELLED")).await;
        date_property(&pool, &stale, "completed_at", "2026-03-03").await;
        let first = run(&pool, &state).await;
        assert_eq!((first.backfilled, first.cleared), (1, 1));
        let ops_after_first = op_count(&pool).await;

        let again = run(&pool, &state).await;

        assert_eq!(again.backfilled, 0);
        assert_eq!(again.cleared, 0);
        assert_eq!(
            op_count(&pool).await,
            ops_after_first,
            "a re-run emits nothing"
        );
        assert_eq!(
            ops_on(&pool, &id).await.len(),
            1,
            "exactly one set_property, ever"
        );
        assert_eq!(
            ops_on(&pool, &stale).await.len(),
            1,
            "exactly one delete_property, ever"
        );
        assert!(completed_at(&pool, &id).await.is_some());
        assert_eq!(completed_at(&pool, &stale).await, None);
    }
}
