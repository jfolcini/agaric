//! Boot driver for [`agaric_engine::empty_blocks`] (#4729 part 2).
//!
//! Runs once per boot, after `bootstrap_spaces`, in a `CommandTx` of its own,
//! and never fails boot. The sweep deletes real (if empty) user data and is
//! load-bearing for no invariant, so an error in it — one leaked block whose
//! apply fails, a busy writer — must be a log line and a retry on the next
//! boot, not a refusal to start. `bootstrap_spaces` is boot-fatal by design;
//! sharing its transaction would have made the sweep boot-fatal too.
//!
//! Each delete takes the same post-commit steps as
//! `commands::blocks::crud::delete_block_inner`: the content-narrowed
//! lifecycle cache rebuild, then the engine cohort fan-out. The engine
//! rollback is armed (#2604) so a tx abort part-way through a batch rewinds
//! the in-place engine applies along with the SQL.

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::db::CommandTx;
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_engine::apply::kernel::ApplyEffects;
use agaric_engine::empty_blocks::sweep_leaked_empty_blocks;
use agaric_store::op_log::OpRecord;

/// Sweep leaked empty blocks, logging the outcome. Never fails: an error is
/// logged and boot continues; the next boot retries the same range, since
/// the cursor is written in the transaction that failed.
pub async fn sweep_leaked_empty_blocks_at_boot(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) {
    if let Err(e) = run(pool, device_id, materializer).await {
        tracing::error!(
            error = %e,
            "empty-block sweep failed — boot continues; the next boot retries the same range (#4729)"
        );
    }
}

async fn run(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<(), AppError> {
    let state = materializer.loro_state();
    let mut tx = CommandTx::begin_immediate(pool, "sweep_empty_blocks").await?;
    tx.arm_engine_rollback(state);

    let sweep = sweep_leaked_empty_blocks(&mut tx, state, device_id).await?;

    let swept: Vec<(Arc<OpRecord>, ApplyEffects)> = sweep
        .swept
        .into_iter()
        .map(|s| (Arc::new(s.record), s.effects))
        .collect();
    for (record, _) in &swept {
        tx.enqueue_lifecycle_background(Arc::clone(record), "content");
    }
    tx.commit_and_dispatch(materializer).await?;
    for (record, effects) in &swept {
        crate::materializer::dispatch_delete_descendants(
            record,
            &effects.deleted_cohort,
            effects.delete_space_id.as_ref(),
            state,
        )
        .await;
    }

    tracing::info!(
        swept = swept.len(),
        examined = sweep.examined,
        held_back = sweep.held_back,
        exhausted = sweep.exhausted,
        "empty-block sweep complete"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::spaces::bootstrap_spaces_for_test;
    use tempfile::TempDir;

    const DEV: &str = "test-device";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        (pool, dir)
    }

    /// A page with two empty children old enough to sweep, so that a
    /// working sweep deletes exactly one (guard 8 keeps the other).
    async fn seed_page_with_two_old_empties(pool: &SqlitePool) -> (String, String) {
        let day_ms: u64 = 24 * 60 * 60 * 1000;
        let ts = u64::try_from(crate::db::now_ms()).unwrap() - 30 * day_ms;
        let page = ulid::Ulid::from_parts(ts, 1).to_string();
        let first = ulid::Ulid::from_parts(ts, 2).to_string();
        let second = ulid::Ulid::from_parts(ts, 3).to_string();
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?1, 'page', 'P', NULL, 1, ?1), \
                    (?2, 'content', '', ?1, 1, ?1), \
                    (?3, 'content', '', ?1, 2, ?1)",
            page,
            first,
            second,
        )
        .execute(pool)
        .await
        .unwrap();
        (first, second)
    }

    async fn live(pool: &SqlitePool, id: &str) -> bool {
        sqlx::query_scalar!("SELECT deleted_at FROM blocks WHERE id = ?", id)
            .fetch_one(pool)
            .await
            .unwrap()
            .is_none()
    }

    async fn cursor_written(pool: &SqlitePool) -> bool {
        sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM app_settings
               WHERE key = 'sweep.empty_blocks.v1.swept_to'"#
        )
        .fetch_one(pool)
        .await
        .unwrap()
            > 0
    }

    async fn delete_ops(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM op_log WHERE op_type = 'delete_block'"#
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// One boot sequence in three phases, on one vault, so each phase's
    /// assertions are pinned by the next rather than being true because the
    /// driver never ran at all:
    ///
    /// 1. `bootstrap_spaces` (the boot-fatal step) no longer sweeps.
    /// 2. A sweep that fails part-way returns normally — a log line, not a
    ///    failed boot — and leaves nothing behind (no tombstone, no op, no
    ///    cursor), so the next boot retries the same range.
    /// 3. The next boot, with the fault gone, sweeps that same range through
    ///    the same call: one empty deleted, guard 8 keeps the page's last
    ///    block, the cursor is written.
    #[tokio::test]
    async fn a_failing_sweep_does_not_fail_boot_and_the_next_boot_retries() {
        let (pool, _tmp) = test_pool().await;
        let (first, second) = seed_page_with_two_old_empties(&pool).await;

        // Phase 1.
        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();
        assert!(
            live(&pool, &first).await && live(&pool, &second).await,
            "bootstrap_spaces must not sweep: the sweep is not boot-fatal"
        );

        // Phase 2 — fail the sweep's first delete at the op-log append, i.e.
        // inside the transaction and after the candidate query ran.
        sqlx::query(
            "CREATE TRIGGER fail_sweep BEFORE INSERT ON op_log \
             WHEN NEW.op_type = 'delete_block' \
             BEGIN SELECT RAISE(ABORT, 'injected sweep failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();
        let mat = Materializer::new(pool.clone());
        sweep_leaked_empty_blocks_at_boot(&pool, DEV, &mat).await;
        mat.shutdown();
        assert!(live(&pool, &first).await, "the failed batch is rolled back");
        assert!(live(&pool, &second).await);
        assert!(
            !cursor_written(&pool).await,
            "the cursor rolls back with the batch so the next boot retries"
        );
        assert_eq!(delete_ops(&pool).await, 0);

        // Phase 3.
        sqlx::query("DROP TRIGGER fail_sweep")
            .execute(&pool)
            .await
            .unwrap();
        let mat = Materializer::new(pool.clone());
        sweep_leaked_empty_blocks_at_boot(&pool, DEV, &mat).await;
        mat.shutdown();
        assert!(
            !live(&pool, &first).await,
            "the retried range sweeps the lower-positioned empty"
        );
        assert!(
            live(&pool, &second).await,
            "guard 8 keeps the page's last block"
        );
        assert!(cursor_written(&pool).await, "the range is retired");
        assert_eq!(delete_ops(&pool).await, 1);
    }
}
