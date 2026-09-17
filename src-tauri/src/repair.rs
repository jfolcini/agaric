//! Boot driver for [`agaric_engine::repair`] (#4728, #4715, #5074).
//!
//! Runs once per boot, after `bootstrap_spaces` and the empty-block sweep,
//! and never fails boot. Each repair gets a `CommandTx` of its own with the
//! engine rollback armed (#2604), so a failure in one — a busy
//! writer, one block whose apply refuses — rolls that repair back whole,
//! logs, and leaves the others and the boot itself untouched; the next
//! boot retries the same population. `bootstrap_spaces` is boot-fatal by
//! design; sharing its transaction would have made a repair boot-fatal too.
//!
//! One `RebuildAgendaCache` follows the repairs, once per boot and whatever
//! they found: `DESIRED_AGENDA_SQL` changed under rows already in
//! `agenda_cache` and only a rebuild rewrites them (#5074).
//!
//! The engine side emits the ops and applies them in the transaction; this
//! side owns what only the app crate can do — the post-commit dispatch that
//! the interactive commands run: plain background dispatch for the
//! `Unreachable` page's create + space stamp (as `create_page_in_space_inner`)
//! and the `completed_at` stamp/clear (as `set_todo_state_inner`), the move
//! fan-out with `same_page = false` (`move_block_inner`), and for a delete the
//! content-narrowed lifecycle rebuild plus the engine cohort fan-out
//! (`delete_block_inner`).

use std::sync::Arc;

use sqlx::SqlitePool;

use crate::db::CommandTx;
use crate::materializer::{MaterializeTask, Materializer};
use agaric_core::error::AppError;
use agaric_engine::apply::kernel::ApplyEffects;
use agaric_engine::repair::RepairOp;
use agaric_engine::repair::completed_at::repair_completed_at;
use agaric_engine::repair::journal_duplicates::repair_journal_duplicates;
use agaric_engine::repair::orphans::repair_orphans;
use agaric_store::op_log::OpRecord;

/// The repairs, in the order they run. Each is independent of the others; the
/// order is only the order the issues were filed in.
#[derive(Debug, Clone, Copy)]
enum Repair {
    Orphans,
    JournalDuplicates,
    CompletedAt,
}

impl Repair {
    const ALL: [Self; 3] = [Self::Orphans, Self::JournalDuplicates, Self::CompletedAt];

    fn label(self) -> &'static str {
        match self {
            Self::Orphans => "repair_orphans",
            Self::JournalDuplicates => "repair_journal_duplicates",
            Self::CompletedAt => "repair_completed_at",
        }
    }
}

/// Run every repair, logging each outcome. Never fails: an error is logged
/// and boot continues; the next boot retries that repair.
pub async fn repair_unreachable_content_at_boot(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) {
    for repair in Repair::ALL {
        if let Err(e) = run(pool, device_id, materializer, repair).await {
            tracing::error!(
                error = %e,
                repair = repair.label(),
                "content repair failed — boot continues; the next boot retries it \
                 (#4728 / #4715 / #5074)"
            );
        }
    }

    // #5074 dropped `created_at` / `completed_at` / `repeat-until` from
    // `DESIRED_AGENDA_SQL`, but nothing rewrites rows already in
    // `agenda_cache`: the diff only runs when a task enqueues it. Once per
    // boot, unconditionally — a vault whose repairs find nothing is exactly
    // the one whose junk agenda rows would otherwise never clear.
    if let Err(e) = materializer.try_enqueue_background(MaterializeTask::RebuildAgendaCache) {
        tracing::warn!(error = %e, "failed to enqueue the agenda cache rebuild at boot (#5074)");
    }
}

/// One repair in one transaction: emit + apply in-tx, commit + dispatch, then
/// the post-commit engine fan-out for each delete.
async fn run(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    repair: Repair,
) -> Result<(), AppError> {
    let state = materializer.loro_state();
    let mut tx = CommandTx::begin_immediate(pool, repair.label()).await?;
    tx.arm_engine_rollback(state);

    let (ops, summary) = match repair {
        Repair::Orphans => {
            let r = repair_orphans(&mut tx, state, device_id).await?;
            let summary = format!(
                "rehomed = {}, pages_created = {}",
                r.rehomed, r.pages_created
            );
            (r.ops, summary)
        }
        Repair::JournalDuplicates => {
            let r = repair_journal_duplicates(&mut tx, state, device_id).await?;
            let summary = format!(
                "dates_merged = {}, pages_merged = {}, children_moved = {}",
                r.dates_merged, r.pages_merged, r.children_moved
            );
            (r.ops, summary)
        }
        Repair::CompletedAt => {
            let r = repair_completed_at(&mut tx, state, device_id).await?;
            (
                r.ops,
                format!("backfilled = {}, cleared = {}", r.backfilled, r.cleared),
            )
        }
    };
    let mut deletes: Vec<(Arc<OpRecord>, ApplyEffects)> = Vec::new();
    for op in ops {
        match op {
            RepairOp::Plain(record) => tx.enqueue_background(record),
            RepairOp::Move(record) => tx.enqueue_move_background(record, false),
            RepairOp::Delete {
                record,
                block_type,
                effects,
            } => {
                let record = Arc::new(record);
                tx.enqueue_lifecycle_background(Arc::clone(&record), block_type);
                deletes.push((record, effects));
            }
        }
    }
    tx.commit_and_dispatch(materializer).await?;
    for (record, effects) in &deletes {
        crate::materializer::dispatch_delete_descendants(
            record,
            &effects.deleted_cohort,
            effects.delete_space_id.as_ref(),
            state,
        )
        .await;
    }

    tracing::info!(repair = repair.label(), %summary, "content repair complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::history::undo_page_group_inner;
    use crate::db::init_pool;
    use crate::spaces::{SPACE_PERSONAL_ULID, SPACE_WORK_ULID, bootstrap_spaces_for_test};
    use agaric_engine::repair::UNREACHABLE_PAGE_TITLE;
    use tempfile::TempDir;

    const DEV: &str = "test-device";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        (pool, dir)
    }

    /// A fresh, strictly increasing ULID. `BlockId::new()` will not do for
    /// a fixture whose ORDER the repair reads: two ULIDs minted in the same
    /// millisecond order by their random low bits, so "the page inserted
    /// first" was not reliably `MIN(id)` — the keeper — and the test flaked.
    fn fresh_id() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(1);
        let ts = u64::try_from(crate::db::now_ms()).unwrap();
        let unique = u128::from(SEQ.fetch_add(1, Ordering::Relaxed));
        ulid::Ulid::from_parts(ts, unique).to_string()
    }

    async fn insert_orphan(pool: &SqlitePool, content: &str) -> String {
        let id = fresh_id();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, NULL, 5, NULL)",
        )
        .bind(&id)
        .bind(content)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    /// A journal date with a keeper (one child) and one duplicate (two
    /// children), all in Work. Returns `(keeper, duplicate, dup_children)`.
    async fn insert_duplicate_date(pool: &SqlitePool, date: &str) -> (String, String, Vec<String>) {
        let mut pages = Vec::new();
        let mut dup_children = Vec::new();
        for (n, label) in [(1, "keeper"), (2, "dup")] {
            let page = fresh_id();
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
                 VALUES (?, 'page', ?, NULL, 1, ?, ?)",
            )
            .bind(&page)
            .bind(date)
            .bind(&page)
            .bind(SPACE_WORK_ULID)
            .execute(pool)
            .await
            .unwrap();
            for i in 1..=n {
                let child = fresh_id();
                sqlx::query(
                    "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
                     VALUES (?, 'content', ?, ?, ?, ?, ?)",
                )
                .bind(&child)
                .bind(format!("{label} {i}"))
                .bind(&page)
                .bind(i)
                .bind(&page)
                .bind(SPACE_WORK_ULID)
                .execute(pool)
                .await
                .unwrap();
                if label == "dup" {
                    dup_children.push(child);
                }
            }
            pages.push(page);
        }
        let dup = pages.pop().unwrap();
        let keeper = pages.pop().unwrap();
        (keeper, dup, dup_children)
    }

    /// A DONE task on `page` with no `completed_at` — the #5074 population.
    async fn insert_done_task(pool: &SqlitePool, page: &str) -> String {
        let id = fresh_id();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id, todo_state) \
             VALUES (?, 'content', 'done', ?, 9, ?, ?, 'DONE')",
        )
        .bind(&id)
        .bind(page)
        .bind(page)
        .bind(SPACE_WORK_ULID)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn completed_at(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT value_date FROM block_properties WHERE block_id = ? AND key = 'completed_at'",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten()
    }

    async fn parent_of(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>("SELECT parent_id FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn deleted_at(pool: &SqlitePool, id: &str) -> Option<i64> {
        sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn unreachable_page(pool: &SqlitePool, space: &str) -> Option<String> {
        sqlx::query_scalar::<_, String>(
            "SELECT id FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL \
             AND content = ? AND space_id = ? ORDER BY id LIMIT 1",
        )
        .bind(UNREACHABLE_PAGE_TITLE)
        .bind(space)
        .fetch_optional(pool)
        .await
        .unwrap()
    }

    /// A page in Work.
    async fn insert_page(pool: &SqlitePool, title: &str) -> String {
        let id = fresh_id();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, 'page', ?, NULL, 1, ?, ?)",
        )
        .bind(&id)
        .bind(title)
        .bind(&id)
        .bind(SPACE_WORK_ULID)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    /// An open task on `page` with a `due_date` — an agenda row the rebuild
    /// must produce.
    async fn insert_due_task(pool: &SqlitePool, page: &str, due: &str) -> String {
        let id = fresh_id();
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id, todo_state, due_date) \
             VALUES (?, 'content', 'due', ?, 8, ?, ?, 'TODO', ?)",
        )
        .bind(&id)
        .bind(page)
        .bind(page)
        .bind(SPACE_WORK_ULID)
        .bind(due)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    async fn agenda_rows(pool: &SqlitePool) -> Vec<(String, String, String)> {
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT date, block_id, source FROM agenda_cache ORDER BY date, block_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    async fn op_log_rows(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn housekeeping_ops(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM op_log WHERE origin = 'housekeeping' \
             AND is_undo = 0 AND is_replicated = 0",
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    /// The boot sequence on one vault, in three phases, each pinned by the
    /// next:
    ///
    /// 1. A failing repair returns normally — a log line, not a failed boot
    ///    — and leaves nothing behind (no move, no page, no op), while the
    ///    OTHER repairs in the same boot still run in their own transactions.
    /// 2. The next boot, with the fault gone, repairs the same population.
    /// 3. The repairs' ops are housekeeping and outside positional undo: a
    ///    Ctrl+Z on the `Unreachable` page or the keeper finds nothing to
    ///    revert, and the content stays where the repair put it.
    #[tokio::test]
    async fn a_failing_repair_does_not_fail_boot_and_its_ops_are_outside_undo() {
        let (pool, _tmp) = test_pool().await;
        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();
        let orphan = insert_orphan(&pool, "[Add sqlfluff to the pipeline](case/1232544)").await;
        let (keeper, dup, dup_children) = insert_duplicate_date(&pool, "2026-05-05").await;
        let done = insert_done_task(&pool, &keeper).await;

        // Phase 1 — fail the orphan repair at its first move (inside the
        // transaction, after the candidate query ran). The journal repair
        // moves too, but its subjects are children of pages: the trigger is
        // keyed on the orphan's id so only the orphan repair trips.
        // dynamic-sql: test-only trigger DDL keyed on the fixture's id.
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "CREATE TRIGGER fail_repair BEFORE INSERT ON op_log \
             WHEN NEW.op_type = 'move_block' AND NEW.block_id = '{orphan}' \
             BEGIN SELECT RAISE(ABORT, 'injected repair failure'); END"
        )))
        .execute(&pool)
        .await
        .unwrap();
        let mat = Materializer::new(pool.clone());
        repair_unreachable_content_at_boot(&pool, DEV, &mat).await;
        mat.shutdown();
        assert_eq!(
            parent_of(&pool, &orphan).await,
            None,
            "the failed batch is rolled back"
        );
        assert_eq!(
            unreachable_page(&pool, SPACE_PERSONAL_ULID).await,
            None,
            "the page created in the failed batch rolled back with it"
        );
        assert!(
            deleted_at(&pool, &dup).await.is_some(),
            "the journal repair ran in its own transaction and was not rolled back \
             by the orphan repair's abort"
        );
        for child in &dup_children {
            assert_eq!(
                parent_of(&pool, child).await.as_deref(),
                Some(keeper.as_str())
            );
        }
        assert!(
            completed_at(&pool, &done).await.is_some(),
            "the completed_at repair ran in its own transaction too"
        );

        // Phase 2.
        sqlx::query("DROP TRIGGER fail_repair")
            .execute(&pool)
            .await
            .unwrap();
        let mat = Materializer::new(pool.clone());
        repair_unreachable_content_at_boot(&pool, DEV, &mat).await;
        let page = unreachable_page(&pool, SPACE_PERSONAL_ULID)
            .await
            .expect("the retried boot creates the page");
        assert_eq!(
            parent_of(&pool, &orphan).await.as_deref(),
            Some(page.as_str())
        );

        // Phase 3 — the ops exist (create + stamp + move on the page's side,
        // two moves + a delete on the journal side, one set_property for the
        // DONE task), satisfy every other positional filter, and are the
        // newest thing in the log; only `origin` keeps them out of Ctrl+Z.
        assert_eq!(housekeeping_ops(&pool).await, 7);
        let undone = undo_page_group_inner(&pool, DEV, &mat, page.clone(), 0, 10_000)
            .await
            .expect("an empty group is Ok(vec![]), not an error");
        assert!(
            undone.is_empty(),
            "nothing on the Unreachable page is undoable"
        );
        let undone = undo_page_group_inner(&pool, DEV, &mat, keeper.clone(), 0, 10_000)
            .await
            .unwrap();
        assert!(undone.is_empty(), "nothing on the keeper is undoable");
        mat.shutdown();
        assert!(completed_at(&pool, &done).await.is_some());
        assert_eq!(
            parent_of(&pool, &orphan).await.as_deref(),
            Some(page.as_str())
        );
        for child in &dup_children {
            assert_eq!(
                parent_of(&pool, child).await.as_deref(),
                Some(keeper.as_str())
            );
        }
        assert!(deleted_at(&pool, &dup).await.is_some());
    }

    /// #5074 — `DESIRED_AGENDA_SQL` stopped projecting `created_at` /
    /// `completed_at` / `repeat-until`, but nothing rewrites the
    /// `agenda_cache` rows the old shape left. The rebuild is enqueued once
    /// per boot whatever the repairs found, so the vault that has NOTHING to
    /// repair — the one that would otherwise never see the fix — still loses
    /// the junk rows and gains the real ones.
    #[tokio::test]
    async fn boot_rebuilds_the_agenda_cache_with_no_repair_candidate() {
        let (pool, _tmp) = test_pool().await;
        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();
        let page = insert_page(&pool, "Tasks").await;
        // Already on the right side of the #5074 invariant — DONE and
        // stamped — so neither direction of `repair_completed_at` has a
        // candidate, and neither do the other two repairs.
        let done = insert_done_task(&pool, &page).await;
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_date) \
             VALUES (?, 'completed_at', '2026-03-03')",
        )
        .bind(&done)
        .execute(&pool)
        .await
        .unwrap();
        let due = insert_due_task(&pool, &page, "2026-03-05").await;
        // The cache as the old projection left it: the lifecycle row present,
        // the due row not yet written.
        sqlx::query(
            "INSERT INTO agenda_cache (date, block_id, source) \
             VALUES ('2026-03-03', ?, 'property:completed_at')",
        )
        .bind(&done)
        .execute(&pool)
        .await
        .unwrap();
        let ops_before = op_log_rows(&pool).await;

        let mat = Materializer::new(pool.clone());
        repair_unreachable_content_at_boot(&pool, DEV, &mat).await;
        mat.flush_background().await.unwrap();
        mat.shutdown();

        assert_eq!(
            op_log_rows(&pool).await,
            ops_before,
            "no repair may have found a candidate — the rebuild is what is under test"
        );
        assert_eq!(
            completed_at(&pool, &done).await.as_deref(),
            Some("2026-03-03"),
            "the DONE task keeps its stamp"
        );
        assert_eq!(
            agenda_rows(&pool).await,
            vec![("2026-03-05".to_owned(), due, "column:due_date".to_owned())],
            "the lifecycle row is gone and the due row is in — the rebuild ran"
        );
    }
}
