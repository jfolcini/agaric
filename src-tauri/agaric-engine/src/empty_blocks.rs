//! Boot-time sweep of leaked empty blocks (#4729, part 2).
//!
//! Nothing ever deleted an empty block: a measured vault carried 508 live
//! content blocks with blank content, 106 of them stranded between real
//! blocks mid-page. The frontend now drops an empty block on blur (part 1);
//! this sweep clears the backlog and backstops whatever blur misses — a
//! crash, or a peer on an older build.
//!
//! The sweep only ever SOFT-deletes, and only through a `DeleteBlock` op on
//! the normal pipeline. `blocks` is a projection of the Loro doc + op log;
//! a raw `UPDATE blocks SET deleted_at` would be reverted on the next
//! replay or conflict on sync. Soft rather than purge so a wrong call is a
//! Trash entry, not data loss.
//!
//! # The predicate
//!
//! "Empty" cannot mean "blank content": a block with no text can still
//! carry meaning. A block is a candidate only if ALL of:
//!
//! 1. `block_type = 'content'` and `deleted_at IS NULL`
//! 2. content is blank once JavaScript's `String.prototype.trim` whitespace
//!    set is stripped (`JS_TRIM_WHITESPACE`; NULL counts as blank)
//! 3. no live children
//! 4. `todo_state`, `priority`, `due_date`, `scheduled_date` all NULL
//! 5. no `block_properties` row
//! 6. no `block_tags` row as `block_id`, no `block_tag_refs` row as `source_id`
//! 7. not referenced by any live block's content — no `((id))`, no `[[id]]`
//! 8. not the last live child of a PAGE (see `hold_back_last_page_children`)
//!
//! plus an age floor (`SWEEP_MIN_AGE`: created before it AND no op on the
//! block since it) and a per-boot cap (`SWEEP_BATCH_CAP`). Guards 3–8 are
//! not exercised by the measured vault (all 508 pass them); the tests
//! construct each case explicitly.

use std::collections::HashMap;

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::db::{next_delete_ms, now_ms};
use agaric_store::op::{DeleteBlockPayload, OpPayload};
use agaric_store::op_log::{self, OpRecord};

use crate::apply::kernel::ApplyEffects;
use crate::loro::shared::LoroState;
use crate::materializer::apply_op_projected;

/// Most `DeleteBlock` ops one boot may emit.
///
/// The measured backlog is 385 deletable blocks, so 500 clears a real vault
/// in one boot with headroom. The cap exists for a vault far more damaged
/// than that one: every delete is an op-log append plus the engine apply and
/// SQL projection inside ONE `BEGIN IMMEDIATE` transaction, and each record
/// then fans out to the background cache rebuilds and to sync. Observed in
/// `batch_cap_holds_and_the_remainder_sweeps_on_the_next_boot` (600 seeded,
/// unoptimised build, three runs): 500 ops in 156–190 ms, 0.31–0.38 ms per
/// op — so a full batch holds the boot write lock for well under a second.
/// Anything past the cap is picked up by the next boot's range (the cursor
/// stops at the last examined id).
pub const SWEEP_BATCH_CAP: usize = 500;

/// Only blocks whose ULID is older than this are examined.
///
/// A block that is empty NOW may be the caret position on another device
/// mid-edit; deleting it yanks the block from under that user (recoverably —
/// it is a soft delete — but still). Seven days is longer than any editing
/// session and covers a laptop left open on an empty block over a weekend;
/// a device offline for longer than that with an empty caret block would
/// have dropped it itself on blur once it reconnects. There is no cost to
/// waiting longer: blur-drop handles the live case, this is the backstop.
///
/// The floor has two arms, both indexed. ULIDs are time-ordered, so
/// "created before" is the range `id < ulid(now - SWEEP_MIN_AGE)` on
/// `idx_blocks_type`. But a block's id says when it was CREATED, not when it
/// was last touched: a month-old block whose text was cleared yesterday on
/// another device — the caret still in it — is exactly the case the floor
/// exists for, and its id is old. So a candidate must also have no `op_log`
/// row at all since the cutoff (`idx_op_log_block_created`); an edit that
/// blanked it, a restore, a move — any op — keeps it for a week. A block
/// that fails only this arm is behind the cursor afterwards and is left to
/// blur-drop, like every other late change (see the cursor note).
pub const SWEEP_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// The characters JavaScript's `String.prototype.trim` strips (ECMA-262
/// WhiteSpace + LineTerminator), bound as `TRIM(content, ?)`'s second
/// argument so guard 2 gives the same verdict as the frontend half's
/// `content.trim() === ''` (`src/lib/empty-block-cleanup.ts`). SQLite's
/// one-argument `TRIM` strips only U+0020, so a block holding a lone `\n`
/// or NBSP would be "empty" on blur and "not empty" here — two verdicts for
/// one block.
pub const JS_TRIM_WHITESPACE: &str = "\u{9}\u{A}\u{B}\u{C}\u{D}\u{20}\u{A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

/// `app_settings` key holding the ULID high-water mark of examined blocks.
///
/// Versioned so a correction to the predicate can re-walk the vault by
/// bumping the suffix rather than needing a way to clear the old key.
const SWEEP_CURSOR_KEY: &str = "sweep.empty_blocks.v1.swept_to";

/// One block the sweep soft-deleted: its op record (for the post-commit
/// cache dispatch) and the apply effects (for the engine cohort fan-out).
#[derive(Debug)]
pub struct SweptBlock {
    pub record: OpRecord,
    pub effects: ApplyEffects,
}

/// What one boot's sweep did.
#[derive(Debug, Default)]
pub struct EmptyBlockSweep {
    /// Blocks soft-deleted this boot, in id order.
    pub swept: Vec<SweptBlock>,
    /// Candidates that passed guards 1–6 in the examined range.
    pub examined: usize,
    /// Candidates held back by guard 7 (referenced) or guard 8 (last child
    /// of a page).
    pub held_back: usize,
    /// `true` when the examined range reached the age cutoff, `false` when
    /// the batch cap stopped it early (the next boot continues).
    pub exhausted: bool,
}

/// A row from the candidate query — a block that passed guards 1–6.
#[derive(Debug)]
struct Candidate {
    id: String,
    parent_id: Option<String>,
    position: Option<i64>,
}

/// Soft-delete leaked empty blocks through the op pipeline, at most
/// `SWEEP_BATCH_CAP` per call.
///
/// # Why a cursor and not a once-only marker
///
/// `repair_misfiled_tag_spaces` is marker-gated because its population is
/// closed: nothing can produce a misfiled tag any more. This population is
/// NOT closed — a peer on an older build keeps leaking empties, and blur
/// cannot fire through a crash — so a once-only pass is wrong here.
///
/// But the cheap indexed precondition exists: candidates are keyed by
/// time-ordered ULID, and `idx_blocks_type(block_type, deleted_at, id)`
/// makes `id > cursor AND id < cutoff` an index range. The cursor records
/// the highest id already examined, so each boot walks only the blocks
/// created since the previous boot's cutoff — a handful of rows — instead
/// of every live content block. The first boot pays one full walk (capped,
/// resumed across boots); every boot after it is a primary-key lookup on
/// `app_settings` plus a near-empty range. Guard 7's scan of linking blocks
/// runs only when that range yields a candidate, never on a clean boot.
///
/// The cursor's assumption is that a leaked empty is created empty and stays
/// empty — which is how they leak (Enter, then navigate away). A block that
/// becomes empty LATER, or a peer's old block that syncs in after the cursor
/// passed its id, is behind the cursor and is left for blur-drop; bumping
/// `SWEEP_CURSOR_KEY`'s version re-walks the vault if that ever matters.
pub async fn sweep_leaked_empty_blocks(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<EmptyBlockSweep, AppError> {
    let cursor: String = sqlx::query_scalar!(
        "SELECT value FROM app_settings WHERE key = ?",
        SWEEP_CURSOR_KEY,
    )
    .fetch_optional(&mut **tx)
    .await?
    .unwrap_or_default();
    let (cutoff_ms, cutoff) = age_cutoff(now_ms());
    if cursor.as_str() >= cutoff.as_str() {
        return Ok(EmptyBlockSweep {
            exhausted: true,
            ..EmptyBlockSweep::default()
        });
    }

    let mut candidates = select_candidates(tx, &cursor, &cutoff, cutoff_ms).await?;
    let exhausted = candidates.len() <= SWEEP_BATCH_CAP;
    candidates.truncate(SWEEP_BATCH_CAP);
    let examined = candidates.len();
    // Everything up to the last row examined is covered, whether or not it
    // was deleted; when the range ran dry the cutoff itself is covered.
    let swept_to = if exhausted {
        cutoff
    } else {
        candidates.last().map(|c| c.id.clone()).unwrap_or(cutoff)
    };

    let referenced = referenced_candidate_ids(tx, &candidates).await?;
    candidates.retain(|c| !referenced.contains(&c.id));
    hold_back_last_page_children(tx, &mut candidates).await?;
    let held_back = examined - candidates.len();

    let mut swept = Vec::with_capacity(candidates.len());
    for candidate in &candidates {
        swept.push(soft_delete_through_pipeline(tx, state, device_id, &candidate.id).await?);
    }

    // Written even when nothing was found: the point is to retire the range,
    // not to record that work happened.
    let now = now_ms();
    sqlx::query!(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
        SWEEP_CURSOR_KEY,
        swept_to,
        now,
    )
    .execute(&mut **tx)
    .await?;

    Ok(EmptyBlockSweep {
        swept,
        examined,
        held_back,
        exhausted,
    })
}

/// `now - SWEEP_MIN_AGE` as epoch ms, and the smallest ULID a block created
/// at that instant could carry; every id below it is old enough to sweep.
fn age_cutoff(now: i64) -> (i64, String) {
    let age_ms = i64::try_from(SWEEP_MIN_AGE.as_millis()).unwrap_or(i64::MAX);
    let cutoff_ms = now.saturating_sub(age_ms);
    let ulid_ms = u64::try_from(cutoff_ms).unwrap_or(0);
    (cutoff_ms, ulid::Ulid::from_parts(ulid_ms, 0).to_string())
}

/// Guards 1–6 plus the age floor and cursor range, in id order, one row past
/// the cap so the caller can tell "range exhausted" from "cap hit".
async fn select_candidates(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    cursor: &str,
    cutoff: &str,
    cutoff_ms: i64,
) -> Result<Vec<Candidate>, AppError> {
    let limit = i64::try_from(SWEEP_BATCH_CAP + 1).unwrap_or(i64::MAX);
    let rows = sqlx::query!(
        r#"SELECT b.id AS "id!: String", b.parent_id, b.position
           FROM blocks b
           WHERE b.block_type = 'content'
             AND b.deleted_at IS NULL
             AND b.id > ?1 AND b.id < ?2
             AND TRIM(COALESCE(b.content, ''), ?3) = ''
             AND b.todo_state IS NULL
             AND b.priority IS NULL
             AND b.due_date IS NULL
             AND b.scheduled_date IS NULL
             AND NOT EXISTS (
                 SELECT 1 FROM blocks k
                 WHERE k.parent_id = b.id AND k.deleted_at IS NULL
             )
             AND NOT EXISTS (SELECT 1 FROM block_properties p WHERE p.block_id = b.id)
             AND NOT EXISTS (SELECT 1 FROM block_tags t WHERE t.block_id = b.id)
             AND NOT EXISTS (SELECT 1 FROM block_tag_refs r WHERE r.source_id = b.id)
             AND NOT EXISTS (
                 SELECT 1 FROM op_log o
                 WHERE o.block_id = b.id AND o.created_at >= ?4
             )
           ORDER BY b.id
           LIMIT ?5"#,
        cursor,
        cutoff,
        JS_TRIM_WHITESPACE,
        cutoff_ms,
        limit,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Candidate {
            id: r.id,
            parent_id: r.parent_id,
            position: r.position,
        })
        .collect())
}

/// Guard 7 — candidate ids that some live block's content names as
/// `((id))` or `[[id]]`.
///
/// One pass over the blocks that contain a link opener at all, driven as
/// the outer loop (`CROSS JOIN` pins the order) against the candidate set,
/// so the content scan happens once rather than once per candidate. Content
/// is the source of truth here, not the derived `block_links` index.
async fn referenced_candidate_ids(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    candidates: &[Candidate],
) -> Result<std::collections::HashSet<String>, AppError> {
    if candidates.is_empty() {
        return Ok(std::collections::HashSet::new());
    }
    let ids_json = serde_json::to_string(&candidates.iter().map(|c| &c.id).collect::<Vec<_>>())?;
    let rows = sqlx::query_scalar!(
        r#"SELECT DISTINCT CAST(c.value AS TEXT) AS "id!: String"
           FROM blocks r CROSS JOIN json_each(?1) c
           WHERE r.deleted_at IS NULL
             AND (r.content LIKE '%((%' OR r.content LIKE '%[[%')
             AND (instr(r.content, '((' || c.value || '))') > 0
                  OR instr(r.content, '[[' || c.value || ']]') > 0)"#,
        ids_json,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Guard 8 — a page must keep at least one live block, or there is nothing
/// left to click into. When every live child of a page is in the candidate
/// set, the highest-positioned one is held back. A non-page parent survives
/// on its own, so its children need no such guard.
async fn hold_back_last_page_children(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    candidates: &mut Vec<Candidate>,
) -> Result<(), AppError> {
    let mut by_parent: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, c) in candidates.iter().enumerate() {
        if let Some(parent) = c.parent_id.as_deref() {
            by_parent.entry(parent).or_default().push(i);
        }
    }
    if by_parent.is_empty() {
        return Ok(());
    }
    let parents_json = serde_json::to_string(&by_parent.keys().collect::<Vec<_>>())?;
    let pages = sqlx::query!(
        r#"SELECT p.id AS "id!: String",
                  (SELECT COUNT(*) FROM blocks k
                   WHERE k.parent_id = p.id AND k.deleted_at IS NULL) AS "live_children!: i64"
           FROM blocks p
           WHERE p.id IN (SELECT value FROM json_each(?1))
             AND p.block_type = 'page'"#,
        parents_json,
    )
    .fetch_all(&mut **tx)
    .await?;

    let mut hold = Vec::new();
    for page in &pages {
        let Some(members) = by_parent.get(page.id.as_str()) else {
            continue;
        };
        let all_children_are_candidates =
            usize::try_from(page.live_children).is_ok_and(|n| n == members.len());
        if !all_children_are_candidates {
            continue;
        }
        if let Some(&keep) = members
            .iter()
            .max_by_key(|&&i| (candidates[i].position, candidates[i].id.as_str()))
        {
            hold.push(keep);
        }
    }
    hold.sort_unstable_by(|a, b| b.cmp(a));
    for i in hold {
        candidates.remove(i);
    }
    Ok(())
}

/// Emit the `DeleteBlock` op and run the same engine-apply + SQL projection
/// the delete command runs, in this transaction, so the row is tombstoned
/// the moment the boot transaction commits and replay/sync/undo see a
/// regular delete. A block's own delete clock stamps `created_at` (the
/// restore cohort identity) exactly as `delete_block_inner` does.
async fn soft_delete_through_pipeline(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    block_id: &str,
) -> Result<SweptBlock, AppError> {
    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(block_id),
    });
    let record = op_log::append_local_op_in_tx(tx, device_id, payload, next_delete_ms()).await?;
    let effects = apply_op_projected(tx, &record, state, false).await?;
    Ok(SweptBlock { record, effects })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const DEV: &str = "test-device";

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        agaric_store::test_support::test_pool().await
    }

    /// A ULID stamped `days` days in the past — old enough to sweep when
    /// `days > SWEEP_MIN_AGE`.
    fn ulid_days_ago(days: u64) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(1);
        let ts = u64::try_from(now_ms()).unwrap() - days * 24 * 60 * 60 * 1000;
        let unique = u128::from(SEQ.fetch_add(1, Ordering::Relaxed));
        ulid::Ulid::from_parts(ts, unique).to_string()
    }

    fn old_id() -> String {
        ulid_days_ago(30)
    }

    struct Row<'a> {
        id: &'a str,
        block_type: &'a str,
        content: &'a str,
        parent_id: Option<&'a str>,
        position: i64,
    }

    async fn insert(pool: &SqlitePool, row: Row<'_>) {
        let page_id = if row.block_type == "page" {
            row.id
        } else {
            row.parent_id.unwrap_or(row.id)
        };
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, ?, ?, ?, ?, ?)",
            row.id,
            row.block_type,
            row.content,
            row.parent_id,
            row.position,
            page_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// A page with one real block, so an empty sibling under it is never
    /// the page's last live child (guard 8 stays out of the way).
    async fn page_with_a_real_block(pool: &SqlitePool) -> String {
        let page = old_id();
        insert(
            pool,
            Row {
                id: &page,
                block_type: "page",
                content: "Page",
                parent_id: None,
                position: 1,
            },
        )
        .await;
        let real = old_id();
        insert(
            pool,
            Row {
                id: &real,
                block_type: "content",
                content: "real text",
                parent_id: Some(&page),
                position: 1,
            },
        )
        .await;
        page
    }

    async fn insert_old_empty(pool: &SqlitePool, parent: &str, position: i64) -> String {
        let id = old_id();
        insert(
            pool,
            Row {
                id: &id,
                block_type: "content",
                content: "",
                parent_id: Some(parent),
                position,
            },
        )
        .await;
        id
    }

    async fn run_sweep(pool: &SqlitePool) -> EmptyBlockSweep {
        let state = LoroState::new();
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let sweep = sweep_leaked_empty_blocks(&mut tx, &state, DEV)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        sweep
    }

    async fn deleted_at(pool: &SqlitePool, id: &str) -> Option<i64> {
        sqlx::query_scalar!("SELECT deleted_at FROM blocks WHERE id = ?", id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    async fn delete_ops_for(pool: &SqlitePool, id: &str) -> i64 {
        sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM op_log
               WHERE op_type = 'delete_block' AND block_id = ?"#,
            id,
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn assert_survives(pool: &SqlitePool, id: &str, why: &str) {
        assert_eq!(deleted_at(pool, id).await, None, "{why}: must survive");
        assert_eq!(
            delete_ops_for(pool, id).await,
            0,
            "{why}: no op may be emitted"
        );
    }

    #[tokio::test]
    async fn plain_leaked_empty_is_soft_deleted_through_an_op() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let leaked = insert_old_empty(&pool, &page, 2).await;

        let sweep = run_sweep(&pool).await;

        assert_eq!(sweep.swept.len(), 1);
        assert_eq!(sweep.swept[0].record.op_type, "delete_block");
        let stamped = deleted_at(&pool, &leaked).await;
        assert!(stamped.is_some(), "row must still exist, tombstoned");
        assert_eq!(
            stamped,
            Some(sweep.swept[0].record.created_at),
            "deleted_at must be the op's created_at (restore cohort identity)"
        );
        assert_eq!(delete_ops_for(&pool, &leaked).await, 1);
        assert!(sweep.exhausted);
    }

    #[tokio::test]
    async fn only_child_of_a_content_parent_is_deleted() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let parent = old_id();
        insert(
            &pool,
            Row {
                id: &parent,
                block_type: "content",
                content: "parent text",
                parent_id: Some(&page),
                position: 2,
            },
        )
        .await;
        let leaked = insert_old_empty(&pool, &parent, 1).await;

        run_sweep(&pool).await;

        assert!(deleted_at(&pool, &leaked).await.is_some());
        assert_eq!(deleted_at(&pool, &parent).await, None);
    }

    #[tokio::test]
    async fn parentless_empty_is_deleted() {
        let (pool, _tmp) = fresh_pool().await;
        let orphan = old_id();
        insert(
            &pool,
            Row {
                id: &orphan,
                block_type: "content",
                content: "   ",
                parent_id: None,
                position: 1,
            },
        )
        .await;

        run_sweep(&pool).await;

        assert!(deleted_at(&pool, &orphan).await.is_some());
    }

    // Guard 3
    #[tokio::test]
    async fn empty_with_a_live_child_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let parent = insert_old_empty(&pool, &page, 2).await;
        let child = old_id();
        insert(
            &pool,
            Row {
                id: &child,
                block_type: "content",
                content: "child text",
                parent_id: Some(&parent),
                position: 1,
            },
        )
        .await;

        run_sweep(&pool).await;

        assert_survives(&pool, &parent, "guard 3: has a live child").await;
    }

    // Guard 4, one column each
    async fn old_empty_with_column(pool: &SqlitePool, column: &str, value: &str) -> String {
        let page = page_with_a_real_block(pool).await;
        let id = insert_old_empty(pool, &page, 2).await;
        // dynamic-sql: test-only column-name interpolation over a fixed
        // four-name set (todo_state / priority / due_date / scheduled_date).
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE blocks SET {column} = ? WHERE id = ?"
        )))
        .bind(value)
        .bind(&id)
        .execute(pool)
        .await
        .unwrap();
        id
    }

    #[tokio::test]
    async fn empty_with_todo_state_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let id = old_empty_with_column(&pool, "todo_state", "TODO").await;
        run_sweep(&pool).await;
        assert_survives(&pool, &id, "guard 4: todo_state").await;
    }

    #[tokio::test]
    async fn empty_with_priority_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let id = old_empty_with_column(&pool, "priority", "A").await;
        run_sweep(&pool).await;
        assert_survives(&pool, &id, "guard 4: priority").await;
    }

    #[tokio::test]
    async fn empty_with_due_date_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let id = old_empty_with_column(&pool, "due_date", "2026-01-01").await;
        run_sweep(&pool).await;
        assert_survives(&pool, &id, "guard 4: due_date").await;
    }

    #[tokio::test]
    async fn empty_with_scheduled_date_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let id = old_empty_with_column(&pool, "scheduled_date", "2026-01-01").await;
        run_sweep(&pool).await;
        assert_survives(&pool, &id, "guard 4: scheduled_date").await;
    }

    // Guard 5
    #[tokio::test]
    async fn empty_with_a_property_row_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let id = insert_old_empty(&pool, &page, 2).await;
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'note', 'kept')",
            id,
        )
        .execute(&pool)
        .await
        .unwrap();

        run_sweep(&pool).await;

        assert_survives(&pool, &id, "guard 5: block_properties row").await;
    }

    async fn insert_tag(pool: &SqlitePool) -> String {
        let tag = old_id();
        insert(
            pool,
            Row {
                id: &tag,
                block_type: "tag",
                content: "sometag",
                parent_id: None,
                position: 1,
            },
        )
        .await;
        tag
    }

    // Guard 6a
    #[tokio::test]
    async fn empty_with_a_block_tags_row_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let id = insert_old_empty(&pool, &page, 2).await;
        let tag = insert_tag(&pool).await;
        sqlx::query!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            id,
            tag,
        )
        .execute(&pool)
        .await
        .unwrap();

        run_sweep(&pool).await;

        assert_survives(&pool, &id, "guard 6: block_tags row").await;
    }

    // Guard 6b
    #[tokio::test]
    async fn empty_with_a_block_tag_refs_row_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let id = insert_old_empty(&pool, &page, 2).await;
        let tag = insert_tag(&pool).await;
        sqlx::query!(
            "INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
            id,
            tag,
        )
        .execute(&pool)
        .await
        .unwrap();

        run_sweep(&pool).await;

        assert_survives(&pool, &id, "guard 6: block_tag_refs row").await;
    }

    async fn insert_referrer(pool: &SqlitePool, page: &str, content: &str) {
        let referrer = old_id();
        insert(
            pool,
            Row {
                id: &referrer,
                block_type: "content",
                content,
                parent_id: Some(page),
                position: 3,
            },
        )
        .await;
    }

    // Guard 7a
    #[tokio::test]
    async fn empty_referenced_by_a_block_ref_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let id = insert_old_empty(&pool, &page, 2).await;
        insert_referrer(&pool, &page, &format!("see (({id})) above")).await;

        run_sweep(&pool).await;

        assert_survives(&pool, &id, "guard 7: ((id)) reference").await;
    }

    // Guard 7b
    #[tokio::test]
    async fn empty_referenced_by_a_page_link_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let id = insert_old_empty(&pool, &page, 2).await;
        insert_referrer(&pool, &page, &format!("see [[{id}]] above")).await;

        run_sweep(&pool).await;

        assert_survives(&pool, &id, "guard 7: [[id]] link").await;
    }

    #[tokio::test]
    async fn reference_from_a_deleted_block_does_not_hold_back() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let id = insert_old_empty(&pool, &page, 2).await;
        let referrer = old_id();
        let content = format!("(({id}))");
        insert(
            &pool,
            Row {
                id: &referrer,
                block_type: "content",
                content: &content,
                parent_id: Some(&page),
                position: 3,
            },
        )
        .await;
        sqlx::query!("UPDATE blocks SET deleted_at = 1 WHERE id = ?", referrer)
            .execute(&pool)
            .await
            .unwrap();

        run_sweep(&pool).await;

        assert!(deleted_at(&pool, &id).await.is_some());
    }

    // Guard 8
    #[tokio::test]
    async fn last_live_child_of_a_page_is_held_back() {
        let (pool, _tmp) = fresh_pool().await;
        let page = old_id();
        insert(
            &pool,
            Row {
                id: &page,
                block_type: "page",
                content: "Only empties",
                parent_id: None,
                position: 1,
            },
        )
        .await;
        let first = insert_old_empty(&pool, &page, 1).await;
        let second = insert_old_empty(&pool, &page, 2).await;
        let last = insert_old_empty(&pool, &page, 3).await;

        let sweep = run_sweep(&pool).await;

        assert!(deleted_at(&pool, &first).await.is_some());
        assert!(deleted_at(&pool, &second).await.is_some());
        assert_survives(&pool, &last, "guard 8: last live child of a page").await;
        assert_eq!(sweep.held_back, 1);
        let live_children: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM blocks
               WHERE parent_id = ? AND deleted_at IS NULL"#,
            page,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(live_children, 1, "the page must keep a block");
    }

    #[tokio::test]
    async fn sole_empty_child_of_a_page_is_held_back() {
        let (pool, _tmp) = fresh_pool().await;
        let page = old_id();
        insert(
            &pool,
            Row {
                id: &page,
                block_type: "page",
                content: "One empty",
                parent_id: None,
                position: 1,
            },
        )
        .await;
        let only = insert_old_empty(&pool, &page, 1).await;

        run_sweep(&pool).await;

        assert_survives(&pool, &only, "guard 8: sole child of a page").await;
    }

    // Age threshold
    #[tokio::test]
    async fn empty_newer_than_the_age_threshold_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let fresh = BlockId::new().to_string();
        insert(
            &pool,
            Row {
                id: &fresh,
                block_type: "content",
                content: "",
                parent_id: Some(&page),
                position: 2,
            },
        )
        .await;
        let just_under = ulid_days_ago(6);
        insert(
            &pool,
            Row {
                id: &just_under,
                block_type: "content",
                content: "",
                parent_id: Some(&page),
                position: 3,
            },
        )
        .await;
        let just_over = ulid_days_ago(8);
        insert(
            &pool,
            Row {
                id: &just_over,
                block_type: "content",
                content: "",
                parent_id: Some(&page),
                position: 4,
            },
        )
        .await;

        run_sweep(&pool).await;

        assert_survives(&pool, &fresh, "age: created now").await;
        assert_survives(&pool, &just_under, "age: six days old").await;
        assert!(
            deleted_at(&pool, &just_over).await.is_some(),
            "age: eight days old is past the floor and must be swept"
        );
    }

    async fn append_edit_op(pool: &SqlitePool, block_id: &str, created_at: i64) {
        let mut tx = pool.begin().await.unwrap();
        op_log::append_local_op_in_tx(
            &mut tx,
            DEV,
            OpPayload::EditBlock(agaric_store::op::EditBlockPayload {
                block_id: BlockId::from_trusted(block_id),
                to_text: String::new(),
                prev_edit: None,
            }),
            created_at,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
    }

    // Age floor, second arm: the id says when a block was created, not when
    // it was last touched. A block emptied yesterday on another device is a
    // caret position, however old its id.
    #[tokio::test]
    async fn empty_with_an_op_inside_the_age_floor_survives() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let touched = insert_old_empty(&pool, &page, 2).await;
        let stale = insert_old_empty(&pool, &page, 3).await;
        let day_ms: i64 = 24 * 60 * 60 * 1000;
        append_edit_op(&pool, &touched, now_ms() - day_ms).await;
        append_edit_op(&pool, &stale, now_ms() - 8 * day_ms).await;

        run_sweep(&pool).await;

        assert_survives(&pool, &touched, "age: an op one day ago").await;
        assert!(
            deleted_at(&pool, &stale).await.is_some(),
            "age: an op eight days ago is outside the floor and must not hold back"
        );
    }

    // Guard 2 must agree with the frontend's `content.trim() === ''`: JS
    // strips every WhiteSpace/LineTerminator code point, SQLite's bare TRIM
    // only U+0020. Both arms pinned — the JS set is swept, a code point
    // outside it (zero-width space) is not.
    #[tokio::test]
    async fn whitespace_only_content_is_blank_the_way_the_frontend_sees_it() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let js_blank = old_id();
        insert(
            &pool,
            Row {
                id: &js_blank,
                block_type: "content",
                content: "\n\t\u{A0}\u{3000}\u{FEFF}",
                parent_id: Some(&page),
                position: 2,
            },
        )
        .await;
        let zero_width = old_id();
        insert(
            &pool,
            Row {
                id: &zero_width,
                block_type: "content",
                content: "\u{200B}",
                parent_id: Some(&page),
                position: 3,
            },
        )
        .await;

        run_sweep(&pool).await;

        assert!(
            deleted_at(&pool, &js_blank).await.is_some(),
            "guard 2: JS-whitespace-only content is blank"
        );
        assert_survives(&pool, &zero_width, "guard 2: U+200B is not JS whitespace").await;
    }

    // Guard 8 when the cap splits a page's children across two boots: the
    // first batch sees a strict subset of the page's live children (the live
    // count exceeds its members), so it holds nothing back; the second sees
    // the complete remainder and keeps one. The page ends with exactly one.
    #[tokio::test]
    async fn guard_8_holds_the_last_child_across_a_batch_boundary() {
        let (pool, _tmp) = fresh_pool().await;
        let page = old_id();
        insert(
            &pool,
            Row {
                id: &page,
                block_type: "page",
                content: "Only empties, more than a batch",
                parent_id: None,
                position: 1,
            },
        )
        .await;
        let total = SWEEP_BATCH_CAP + 3;
        for i in 0..total {
            insert_old_empty(&pool, &page, i64::try_from(i).unwrap() + 1).await;
        }

        let first = run_sweep(&pool).await;
        assert_eq!(first.swept.len(), SWEEP_BATCH_CAP);
        assert_eq!(
            first.held_back, 0,
            "a partial view of the page holds nothing"
        );

        let second = run_sweep(&pool).await;
        assert_eq!(second.swept.len(), 2);
        assert_eq!(second.held_back, 1);
        assert!(second.exhausted);

        let live: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM blocks
               WHERE parent_id = ? AND deleted_at IS NULL"#,
            page,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(live, 1, "the page must keep exactly one block");
    }

    #[tokio::test]
    async fn batch_cap_holds_and_the_remainder_sweeps_on_the_next_boot() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let total = SWEEP_BATCH_CAP + 100;
        let mut ids = Vec::with_capacity(total);
        for i in 0..total {
            ids.push(insert_old_empty(&pool, &page, i64::try_from(i).unwrap() + 2).await);
        }

        let started = std::time::Instant::now();
        let first = run_sweep(&pool).await;
        let elapsed = started.elapsed();
        eprintln!(
            "sweep of {} ops took {elapsed:?} ({:?}/op)",
            first.swept.len(),
            elapsed / u32::try_from(first.swept.len().max(1)).unwrap()
        );
        assert_eq!(
            first.swept.len(),
            SWEEP_BATCH_CAP,
            "first boot stops at the cap"
        );
        assert!(!first.exhausted);

        let second = run_sweep(&pool).await;
        assert_eq!(second.swept.len(), 100, "second boot sweeps the remainder");
        assert!(second.exhausted);

        let third = run_sweep(&pool).await;
        assert_eq!(third.swept.len(), 0);
        assert_eq!(third.examined, 0, "a clean boot examines nothing");

        let live: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM blocks
               WHERE parent_id = ? AND deleted_at IS NULL"#,
            page,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(live, 1, "only the real block remains");
        let ops: i64 = sqlx::query_scalar!(
            r#"SELECT COUNT(*) AS "n!: i64" FROM op_log WHERE op_type = 'delete_block'"#
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(ops, i64::try_from(total).unwrap());
    }

    #[tokio::test]
    async fn cursor_retires_the_range_so_a_clean_boot_examines_nothing() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let leaked = insert_old_empty(&pool, &page, 2).await;

        let first = run_sweep(&pool).await;
        assert_eq!(first.examined, 1);
        assert!(deleted_at(&pool, &leaked).await.is_some());

        // A block that appears BEHIND the cursor afterwards (a late-synced
        // peer block with an old id) is deliberately left to blur-drop —
        // the cursor is what keeps every later boot off the full walk.
        let behind = insert_old_empty(&pool, &page, 3).await;
        let second = run_sweep(&pool).await;
        assert_eq!(second.examined, 0, "the range must not be re-walked");
        assert_eq!(deleted_at(&pool, &behind).await, None);
    }

    #[tokio::test]
    async fn sweep_is_idempotent_on_a_second_boot() {
        let (pool, _tmp) = fresh_pool().await;
        let page = page_with_a_real_block(&pool).await;
        let leaked = insert_old_empty(&pool, &page, 2).await;

        run_sweep(&pool).await;
        run_sweep(&pool).await;

        assert_eq!(
            delete_ops_for(&pool, &leaked).await,
            1,
            "exactly one op, ever"
        );
    }
}
