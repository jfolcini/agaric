//! Boot driver for [`agaric_engine::repair`] (#4728, #4715, #5074, #5387, #5670, #5608).
//!
//! Runs once per boot, after `bootstrap_spaces` and the empty-block sweep,
//! and never fails boot. Each repair gets a `CommandTx` of its own with the
//! engine rollback armed (#2604), so a failure in one — a busy
//! writer, one block whose apply refuses — rolls that repair back whole,
//! logs, and leaves the others and the boot itself untouched; the next
//! boot retries the same population. `bootstrap_spaces` is boot-fatal by
//! design; sharing its transaction would have made a repair boot-fatal too.
//!
//! The one-shot #5670 engine hydration follows them, with the same
//! contract: see `hydrate_engine_missing_blocks_once`. The #5608 attachment
//! backfill runs after it: the backfill creates an engine for a space that
//! had none, and the hydration, which skips a space with no engine, would
//! then seed that space whole.
//!
//! The one-shot #5074 agenda rewrite follows the repairs, whatever they
//! found: `DESIRED_AGENDA_SQL` changed under rows already in `agenda_cache`
//! and only a rebuild rewrites them. An `app_settings` marker retires it once
//! it has committed.
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
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_engine::apply::kernel::ApplyEffects;
use agaric_engine::repair::RepairOp;
use agaric_engine::repair::attachments::hydrate_attachments_into_engine;
use agaric_engine::repair::completed_at::repair_completed_at;
use agaric_engine::repair::engine_missing_blocks::hydrate_engine_missing_blocks;
use agaric_engine::repair::journal_duplicates::repair_journal_duplicates;
use agaric_engine::repair::orphans::repair_orphans;
use agaric_engine::repair::page_aliases::repair_page_aliases;
use agaric_store::op_log::OpRecord;

/// The repairs. The op-emitting ones run first, in [`Repair::OPS`] order,
/// which is only the order the issues were filed in; `Attachments` runs after
/// the #5670 hydration (see the module docs).
#[derive(Debug, Clone, Copy)]
enum Repair {
    Orphans,
    JournalDuplicates,
    CompletedAt,
    PageAliases,
    Attachments,
}

impl Repair {
    const OPS: [Self; 4] = [
        Self::Orphans,
        Self::JournalDuplicates,
        Self::CompletedAt,
        Self::PageAliases,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::Orphans => "repair_orphans",
            Self::JournalDuplicates => "repair_journal_duplicates",
            Self::CompletedAt => "repair_completed_at",
            Self::PageAliases => "repair_page_aliases",
            Self::Attachments => "hydrate_attachments_into_engine",
        }
    }
}

/// Run every repair, logging each outcome. Never fails: an error is logged
/// and boot continues; the next boot retries that repair.
pub async fn repair_unreachable_content_at_boot(
    pool: &SqlitePool,
    read_pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) {
    for repair in Repair::OPS {
        run_or_log(pool, device_id, materializer, repair).await;
    }

    match hydrate_engine_missing_blocks_once(pool, device_id, materializer).await {
        Ok(Some(missing)) => tracing::info!(missing, "engine hydration repair ran (#5670)"),
        Ok(None) => {}
        Err(e) => tracing::error!(
            error = %e,
            "engine hydration repair failed — boot continues; the next boot retries it (#5670)"
        ),
    }

    run_or_log(pool, device_id, materializer, Repair::Attachments).await;

    // Whatever the repairs found — a vault whose repairs find nothing is
    // exactly the one whose junk agenda rows would otherwise never clear.
    match agaric_store::cache::rewrite_agenda_cache_once(pool, read_pool).await {
        Ok(true) => tracing::info!("agenda cache rewrite ran (#5074)"),
        Ok(false) => {}
        Err(e) => tracing::error!(
            error = %e,
            "agenda cache rewrite failed — boot continues; the next boot retries it (#5074)"
        ),
    }
}

/// [`run`], logging a failure instead of returning it.
async fn run_or_log(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    repair: Repair,
) {
    if let Err(e) = run(pool, device_id, materializer, repair).await {
        tracing::error!(
            error = %e,
            repair = repair.label(),
            "content repair failed — boot continues; the next boot retries it \
             (#4728 / #4715 / #5074 / #5608)"
        );
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
        Repair::PageAliases => {
            let r = repair_page_aliases(&mut tx, state, device_id).await?;
            let summary = format!("backfilled = {}", r.ops.len());
            (r.ops, summary)
        }
        Repair::Attachments => {
            let r = hydrate_attachments_into_engine(&mut tx, state, device_id).await?;
            (Vec::new(), format!("hydrated = {}", r.hydrated))
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
                deletes.push((record, *effects));
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

/// `app_settings` key retiring [`hydrate_engine_missing_blocks_once`].
const ENGINE_MISSING_BLOCKS_MARKER: &str = "repair.engine_missing_live_blocks.v1";

/// #5670 — hydrate the live blocks their space's engine lost, once. Returns
/// how many were missing, or `None` when the marker says it already ran.
///
/// One-shot because it repairs what the pre-#5418 replays left; drift that
/// arises later is for the integrity check (#5628) to report, not for a boot
/// pass to hide. The hydration is in memory until a snapshot persists it and
/// no op replays it, so the marker is written after the save: a crash in
/// between leaves the repair to the next boot.
async fn hydrate_engine_missing_blocks_once(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> Result<Option<usize>, AppError> {
    let done: Option<String> = sqlx::query_scalar!(
        "SELECT value FROM app_settings WHERE key = ?",
        ENGINE_MISSING_BLOCKS_MARKER,
    )
    .fetch_optional(pool)
    .await?;
    if done.is_some() {
        return Ok(None);
    }
    let state = materializer.loro_state();
    let mut tx = CommandTx::begin_immediate(pool, "repair_engine_missing_blocks").await?;
    tx.arm_engine_rollback(state);
    let missing = hydrate_engine_missing_blocks(&mut tx, state, device_id).await?;
    tx.commit_and_dispatch(materializer).await?;
    if missing > 0
        && agaric_engine::loro::snapshot::save_all_engines(pool, &state.registry)
            .await
            .persisted_through
            .is_none()
    {
        return Err(AppError::Snapshot(
            "the hydrated engines were not persisted".to_owned(),
        ));
    }
    let now = crate::db::now_ms();
    let count = missing.to_string();
    sqlx::query!(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
        ENGINE_MISSING_BLOCKS_MARKER,
        count,
        now,
    )
    .execute(pool)
    .await?;
    Ok(Some(missing))
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
        repair_unreachable_content_at_boot(&pool, &pool, DEV, &mat).await;
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
        repair_unreachable_content_at_boot(&pool, &pool, DEV, &mat).await;
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

    /// #5608 — boot runs the attachment backfill: a row written before
    /// attachments were in the engine has its entry in the block's doc after.
    /// It runs after the #5670 hydration, which leaves a space with no engine
    /// alone.
    #[tokio::test]
    async fn boot_hydrates_legacy_attachment_rows_into_the_engine_5608() {
        let (pool, _tmp) = test_pool().await;
        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();
        let page = insert_page(&pool, "Photos").await;
        sqlx::query(
            "INSERT INTO attachments (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
             VALUES ('ATT5608', ?, 'image/png', 'a.png', 4, 'attachments/ATT5608', 1000)",
        )
        .bind(&page)
        .execute(&pool)
        .await
        .unwrap();

        let mat = Materializer::new(pool.clone());
        repair_unreachable_content_at_boot(&pool, &pool, DEV, &mat).await;
        let held = {
            let space = agaric_store::space::SpaceId::from_trusted(SPACE_WORK_ULID);
            let mut guard = mat.loro_state().registry.for_space(&space, DEV).unwrap();
            guard.engine_mut().read_attachments(&page).unwrap()
        };
        mat.shutdown();

        let held: Vec<(String, bool)> = held
            .unwrap_or_default()
            .into_iter()
            .map(|e| (e.attachment_id, e.deleted_at.is_some()))
            .collect();
        assert_eq!(
            held,
            vec![("ATT5608".to_owned(), false)],
            "the row is a live entry in Work's doc"
        );
        assert_eq!(
            marker(&pool).await.as_deref(),
            Some("0"),
            "the #5670 hydration ran before the backfill gave Work an engine, \
             so it seeded none of Work's blocks"
        );
    }

    /// The cache as the pre-#5074 projection left it for `done`: a
    /// `completed_at` lifecycle row.
    async fn insert_lifecycle_agenda_row(pool: &SqlitePool, done: &str) {
        sqlx::query(
            "INSERT INTO agenda_cache (date, block_id, source) \
             VALUES ('2026-03-03', ?, 'property:completed_at')",
        )
        .bind(done)
        .execute(pool)
        .await
        .unwrap();
    }

    /// #5074 — `DESIRED_AGENDA_SQL` stopped projecting `created_at` /
    /// `completed_at` / `repeat-until`, but nothing rewrites the
    /// `agenda_cache` rows the old shape left. The rewrite runs whatever the
    /// repairs found, so the vault that has NOTHING to repair — the one that
    /// would otherwise never see the fix — still loses the junk rows and
    /// gains the real ones. #5420: once — a second boot leaves the cache
    /// alone.
    #[tokio::test]
    async fn boot_rewrites_the_agenda_cache_once_with_no_repair_candidate() {
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
        // The lifecycle row present, the due row not yet written.
        insert_lifecycle_agenda_row(&pool, &done).await;
        let ops_before = op_log_rows(&pool).await;

        let mat = Materializer::new(pool.clone());
        repair_unreachable_content_at_boot(&pool, &pool, DEV, &mat).await;
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
        let rewritten = vec![("2026-03-05".to_owned(), due, "column:due_date".to_owned())];
        assert_eq!(
            agenda_rows(&pool).await,
            rewritten,
            "the lifecycle row is gone and the due row is in — the rewrite ran"
        );

        // A row only a rewrite would remove: the second boot must not run one.
        insert_lifecycle_agenda_row(&pool, &done).await;
        let mut expected = rewritten;
        expected.insert(
            0,
            (
                "2026-03-03".to_owned(),
                done.clone(),
                "property:completed_at".to_owned(),
            ),
        );
        let mat = Materializer::new(pool.clone());
        repair_unreachable_content_at_boot(&pool, &pool, DEV, &mat).await;
        mat.flush_background().await.unwrap();
        mat.shutdown();
        assert_eq!(
            agenda_rows(&pool).await,
            expected,
            "the marker retires the rewrite: the second boot leaves the cache alone"
        );
    }

    /// #5420 — the marker is written only once the rewrite commits: a rewrite
    /// that fails leaves it unset, and the next boot runs the rewrite.
    #[tokio::test]
    async fn a_failed_agenda_rewrite_is_retried_by_the_next_boot() {
        let (pool, _tmp) = test_pool().await;
        bootstrap_spaces_for_test(&pool, DEV).await.unwrap();
        let page = insert_page(&pool, "Tasks").await;
        let due = insert_due_task(&pool, &page, "2026-03-05").await;
        sqlx::query(
            "CREATE TRIGGER fail_agenda_rewrite BEFORE INSERT ON agenda_cache \
             BEGIN SELECT RAISE(ABORT, 'injected agenda rewrite failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let mat = Materializer::new(pool.clone());
        repair_unreachable_content_at_boot(&pool, &pool, DEV, &mat).await;
        mat.shutdown();
        assert_eq!(
            agenda_rows(&pool).await,
            vec![],
            "the failed rewrite rolled back"
        );

        sqlx::query("DROP TRIGGER fail_agenda_rewrite")
            .execute(&pool)
            .await
            .unwrap();
        let mat = Materializer::new(pool.clone());
        repair_unreachable_content_at_boot(&pool, &pool, DEV, &mat).await;
        mat.shutdown();
        assert_eq!(
            agenda_rows(&pool).await,
            vec![("2026-03-05".to_owned(), due, "column:due_date".to_owned())],
            "the failed pass left no marker, so the next boot rewrote the cache"
        );
    }

    /// A user space's page holding `parent`, which holds three children, all
    /// made through the commands. Returns `(space, parent, children)`.
    async fn vault_in_a_space(
        pool: &SqlitePool,
        mat: &Materializer,
    ) -> (String, String, Vec<String>) {
        use crate::commands::blocks::crud::create_block_inner;
        use crate::commands::spaces::{create_page_in_space_inner, create_space_inner};
        let space = create_space_inner(pool, DEV, mat, "Work".to_owned(), None)
            .await
            .unwrap()
            .to_string();
        let page =
            create_page_in_space_inner(pool, DEV, mat, None, "Page".to_owned(), space.clone())
                .await
                .unwrap();
        let child = |parent: agaric_core::ulid::BlockId, text: &'static str| async move {
            create_block_inner(
                pool,
                DEV,
                mat,
                "content".to_owned(),
                text.to_owned(),
                Some(parent),
                None,
            )
            .await
            .unwrap()
            .id
        };
        let parent = child(page, "parent").await;
        let mut children = Vec::new();
        for text in ["first", "middle", "last"] {
            children.push(child(parent.clone(), text).await.to_string());
        }
        mat.flush_background().await.unwrap();
        (space, parent.to_string(), children)
    }

    fn engine_of(mat: &Materializer, space: &str) -> agaric_engine::loro::registry::EngineGuard {
        let space = agaric_store::space::SpaceId::from_trusted(space);
        mat.loro_state().registry.for_space(&space, DEV).unwrap()
    }

    /// Drop `block` from its space's engine and nowhere else: a purge of the
    /// parent the engine still had it under, as in #5670's vault.
    fn lose_from_engine(mat: &Materializer, space: &str, block: &str) {
        engine_of(mat, space)
            .engine_mut()
            .apply_purge_block(block)
            .unwrap();
    }

    fn engine_children(mat: &Materializer, space: &str, parent: &str) -> Vec<String> {
        engine_of(mat, space)
            .engine_mut()
            .children_ordered_block_ids(Some(parent))
            .unwrap()
    }

    /// The live nodes carrying `block`'s id in its space's doc, read the way a
    /// peer or the next boot imports it.
    fn nodes_in_export(mat: &Materializer, space: &str, block: &str) -> usize {
        let (_, bytes) = mat
            .loro_state()
            .registry
            .snapshot_all_engines()
            .into_iter()
            .find(|(s, _)| s.as_str() == space)
            .unwrap();
        let mut engine = agaric_engine::loro::engine::LoroEngine::new();
        engine.import(&bytes.unwrap()).unwrap();
        engine
            .live_blocks_preorder()
            .iter()
            .filter(|b| b.as_str() == block)
            .count()
    }

    /// The integrity check's engine divergences, as `(artefact, key)`.
    async fn engine_divergences(pool: &SqlitePool, mat: &Materializer) -> Vec<(String, String)> {
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 17).unwrap();
        crate::reconciliation_oracle::reconcile_all(pool, mat.loro_state(), today)
            .await
            .unwrap()
            .into_iter()
            .filter(|d| d.artefact.starts_with("engine."))
            .map(|d| (d.artefact.to_owned(), d.key))
            .collect()
    }

    /// Every `blocks` row: id, parent, position, deleted.
    async fn sql_blocks(pool: &SqlitePool) -> Vec<(String, Option<String>, Option<i64>, bool)> {
        sqlx::query_as(
            "SELECT id, parent_id, position, deleted_at IS NOT NULL FROM blocks ORDER BY id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    async fn marker(pool: &SqlitePool) -> Option<String> {
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
            .bind(ENGINE_MISSING_BLOCKS_MARKER)
            .fetch_optional(pool)
            .await
            .unwrap()
    }

    /// #5670 — a live block its space's engine lost comes back under its SQL
    /// parent at its SQL place, as the doc's one live node for that id, and
    /// persisted before the marker is. SQL is left as it was, and the
    /// integrity check then finds the engine and SQL agree.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_block_the_engine_lost_comes_back_under_its_parent_in_order_5670() {
        let (pool, _tmp) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let (space, parent, children) = vault_in_a_space(&pool, &mat).await;
        let lost = &children[1];
        lose_from_engine(&mat, &space, lost);
        assert_eq!(
            engine_divergences(&pool, &mat).await,
            vec![("engine.blocks.row".to_owned(), format!("{space} / {lost}"))],
            "the fixture is #5670's vault: one live block its engine lacks"
        );
        let sql_before = sql_blocks(&pool).await;

        let missing = hydrate_engine_missing_blocks_once(&pool, DEV, &mat)
            .await
            .unwrap();

        assert_eq!(missing, Some(1), "one block was missing");
        assert_eq!(
            engine_children(&mat, &space, &parent),
            children,
            "back under its parent, between its siblings"
        );
        assert_eq!(
            nodes_in_export(&mat, &space, lost),
            1,
            "one live node for the id, beside the purged one"
        );
        assert_eq!(sql_blocks(&pool).await, sql_before, "SQL is untouched");
        assert_eq!(
            engine_divergences(&pool, &mat).await,
            Vec::<(String, String)>::new(),
            "the engine and SQL agree"
        );
        let rebooted = agaric_engine::loro::registry::LoroEngineRegistry::new();
        agaric_engine::loro::snapshot::rehydrate_registry(&pool, &rebooted, DEV).await;
        let space_id = agaric_store::space::SpaceId::from_trusted(&space);
        assert!(
            rebooted
                .for_space(&space_id, DEV)
                .unwrap()
                .engine_mut()
                .contains_block(lost),
            "the hydrated engine was persisted"
        );
        assert_eq!(marker(&pool).await.as_deref(), Some("1"));
        mat.shutdown();
    }

    /// #5670 — the marker retires the repair: a block lost again after it ran
    /// stays lost, for the integrity check to report.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_second_run_is_a_no_op_5670() {
        let (pool, _tmp) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let (space, parent, children) = vault_in_a_space(&pool, &mat).await;
        let lost = &children[1];
        lose_from_engine(&mat, &space, lost);
        assert_eq!(
            hydrate_engine_missing_blocks_once(&pool, DEV, &mat)
                .await
                .unwrap(),
            Some(1)
        );

        lose_from_engine(&mat, &space, lost);
        let again = hydrate_engine_missing_blocks_once(&pool, DEV, &mat)
            .await
            .unwrap();

        assert_eq!(again, None, "the marker says it ran");
        assert!(
            !engine_children(&mat, &space, &parent).contains(lost),
            "the second run hydrated nothing"
        );
        mat.shutdown();
    }

    /// #5670 — on a vault whose engines hold every live block the repair
    /// appends no op and writes no block, no snapshot and no engine change:
    /// only its marker.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_vault_with_nothing_missing_writes_nothing_5670() {
        let (pool, _tmp) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let (space, _, _) = vault_in_a_space(&pool, &mat).await;
        let space_id = agaric_store::space::SpaceId::from_trusted(&space);
        let snapshots = || async {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM loro_doc_state")
                .fetch_one(&pool)
                .await
                .unwrap()
        };
        let before = (
            op_log_rows(&pool).await,
            sql_blocks(&pool).await,
            snapshots().await,
            mat.loro_state().registry.loro_vv(&space_id),
        );

        let missing = hydrate_engine_missing_blocks_once(&pool, DEV, &mat)
            .await
            .unwrap();

        assert_eq!(missing, Some(0));
        assert_eq!(
            (
                op_log_rows(&pool).await,
                sql_blocks(&pool).await,
                snapshots().await,
                mat.loro_state().registry.loro_vv(&space_id),
            ),
            before,
            "no op, no block row, no snapshot, no engine change"
        );
        assert_eq!(marker(&pool).await.as_deref(), Some("0"));
        mat.shutdown();
    }

    /// #5670 — a failure inside the repair's transaction rolls the engine seed
    /// back with the SQL, leaves no marker, and boot carries on; the next boot
    /// repairs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_hydration_rolls_back_and_does_not_fail_boot_5670() {
        let (pool, _tmp) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let (space, parent, children) = vault_in_a_space(&pool, &mat).await;
        let lost = &children[1];
        lose_from_engine(&mat, &space, lost);
        // A rank gap with the order kept, as a purge leaves: the seed's dense
        // reprojection closes it, and the trigger fails that write.
        sqlx::query("UPDATE blocks SET position = 9 WHERE id = ?")
            .bind(&children[2])
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TRIGGER fail_hydration BEFORE UPDATE OF position ON blocks \
             BEGIN SELECT RAISE(ABORT, 'injected hydration failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        repair_unreachable_content_at_boot(&pool, &pool, DEV, &mat).await;

        assert!(
            !engine_children(&mat, &space, &parent).contains(lost),
            "the engine seed rolled back with the transaction"
        );
        let position = |id: String| {
            let pool = pool.clone();
            async move {
                sqlx::query_scalar::<_, i64>("SELECT position FROM blocks WHERE id = ?")
                    .bind(id)
                    .fetch_one(&pool)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(position(children[2].clone()).await, 9, "SQL rolled back");
        assert_eq!(
            marker(&pool).await,
            None,
            "no marker, so the next boot retries"
        );

        sqlx::query("DROP TRIGGER fail_hydration")
            .execute(&pool)
            .await
            .unwrap();
        repair_unreachable_content_at_boot(&pool, &pool, DEV, &mat).await;
        assert_eq!(engine_children(&mat, &space, &parent), children);
        assert_eq!(marker(&pool).await.as_deref(), Some("1"));
        mat.shutdown();
    }

    /// #5670 — the marker retires the repair only once the engines are saved:
    /// the hydration lives in memory until then, and a boot that loses it
    /// without a marker repairs again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_save_leaves_no_marker_5670() {
        let (pool, _tmp) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        let (space, _, children) = vault_in_a_space(&pool, &mat).await;
        lose_from_engine(&mat, &space, &children[1]);
        sqlx::query(
            "CREATE TRIGGER fail_save BEFORE INSERT ON loro_doc_state \
             BEGIN SELECT RAISE(ABORT, 'injected save failure'); END",
        )
        .execute(&pool)
        .await
        .unwrap();

        let outcome = hydrate_engine_missing_blocks_once(&pool, DEV, &mat).await;

        assert!(
            matches!(outcome, Err(AppError::Snapshot(_))),
            "the failed save is the repair's error, got {outcome:?}"
        );
        assert_eq!(
            marker(&pool).await,
            None,
            "the engines were not saved, so the repair is not retired"
        );
        mat.shutdown();
    }
}
