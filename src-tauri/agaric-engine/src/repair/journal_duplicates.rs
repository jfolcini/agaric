//! Repair 2 (#4715) — merge duplicate journal pages onto the oldest one.
//!
//! `resolve_or_create_journal_page` looks a date up with `AND b.space_id = ?`.
//! While a freshly created page could still be space-less, that lookup could
//! not see it, so the next visit to the same date minted another page — no
//! race required. The write side has been closed (#3081 stamps the space
//! atomically), but a measured vault still carries the damage: four dates in
//! one space split across 31 extra pages holding 37 live blocks, of which the
//! UI shows one page's worth.
//!
//! # The predicate
//!
//! Live `page` blocks whose title is a date, grouped by `(space_id, title)`,
//! with more than one member. "Is a date" is the digit mask
//! `GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`; the `LIKE '____-__-__'`
//! beside it only lets the planner serve the probe from
//! `idx_blocks_journal_date`, whose partial-index predicate it repeats. `LIKE`
//! alone would not do — `_` matches any character, so a ten-character title
//! such as `note-on-me` would be swept in. Space blocks are excluded outright.
//!
//! # Keeper and order
//!
//! The keeper is `MIN(id)`: ULIDs are creation-ordered, so it is the oldest
//! page — the one the journal lookup returns today. Every other member's live
//! children are appended to the keeper in `id` (creation) order, then the
//! emptied member is soft-deleted.
//!
//! **Children move before the page is deleted.** `DeleteBlock` tombstones the
//! page *and its live descendants* as one cohort; deleting first would trash
//! the very blocks this exists to preserve, and a later restore would bring
//! the duplicate page back with them. The order is asserted, not assumed: a
//! member that still has a live child when its turn to be deleted comes
//! fails the batch.

use agaric_core::error::AppError;
use agaric_store::task_locals::ACTOR;

use super::{RepairOp, append_under, housekeeping, live_child_count, soft_delete};
use crate::loro::shared::LoroState;

/// What one run of the journal-duplicate repair did.
#[derive(Debug, Default)]
pub struct JournalDuplicateRepair {
    /// Ops emitted, in append order, for the driver to dispatch after commit.
    pub ops: Vec<RepairOp>,
    /// `(space, date)` groups that had more than one live page.
    pub dates_merged: usize,
    /// Duplicate pages soft-deleted after their children moved.
    pub pages_merged: usize,
    /// Live children moved onto a keeper.
    pub children_moved: usize,
}

/// One `(space, date)` with more than one live page.
#[derive(Debug)]
struct DuplicateGroup {
    space_id: Option<String>,
    date: String,
    keeper: String,
}

/// Every `(space, date)` holding more than one live journal page, with its
/// keeper, in a stable order.
async fn select_groups(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<DuplicateGroup>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT b.space_id, b.content AS "date!: String", MIN(b.id) AS "keeper!: String"
           FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.content LIKE '____-__-__'
             AND b.content GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
             AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = b.id)
           GROUP BY b.space_id, b.content
           HAVING COUNT(*) > 1
           ORDER BY b.space_id, b.content"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| DuplicateGroup {
            space_id: r.space_id,
            date: r.date,
            keeper: r.keeper,
        })
        .collect())
}

/// The group's members other than the keeper, oldest first.
async fn select_duplicates(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    group: &DuplicateGroup,
) -> Result<Vec<String>, AppError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT id AS "id!: String" FROM blocks b
           WHERE b.block_type = 'page'
             AND b.deleted_at IS NULL
             AND b.content = ?1
             AND b.space_id IS ?2
             AND b.id <> ?3
             AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = b.id)
           ORDER BY b.id"#,
        group.date,
        group.space_id,
        group.keeper,
    )
    .fetch_all(&mut **tx)
    .await?)
}

/// The live children of every page in `pages`, in creation (id) order across
/// all of them.
async fn select_children(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    pages: &[String],
) -> Result<Vec<String>, AppError> {
    let pages_json = serde_json::to_string(pages)?;
    Ok(sqlx::query_scalar!(
        r#"SELECT c.id AS "id!: String" FROM blocks c
           WHERE c.deleted_at IS NULL
             AND c.parent_id IN (SELECT value FROM json_each(?1))
           ORDER BY c.id"#,
        pages_json,
    )
    .fetch_all(&mut **tx)
    .await?)
}

/// Fold one group: children onto the keeper, then delete the emptied pages.
async fn merge_group(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    group: &DuplicateGroup,
    report: &mut JournalDuplicateRepair,
) -> Result<(), AppError> {
    let duplicates = select_duplicates(tx, group).await?;
    let children = select_children(tx, &duplicates).await?;
    for child in &children {
        let record = append_under(tx, state, device_id, child, &group.keeper).await?;
        report.ops.push(RepairOp::Move(record));
        report.children_moved += 1;
    }
    for page in &duplicates {
        // The invariant this repair exists for, checked on the write path
        // (AGENTS.md "Patterns caught in review" 5): nothing live may be
        // under the page when its delete cohort is captured.
        let left_behind = live_child_count(tx, page).await?;
        if left_behind != 0 {
            return Err(AppError::InvalidOperation(format!(
                "repair: duplicate journal page '{page}' ({}) still has {left_behind} live \
                 children after the merge; refusing to delete it",
                group.date
            )));
        }
        report
            .ops
            .push(soft_delete(tx, state, device_id, page, "page").await?);
        report.pages_merged += 1;
    }
    report.dates_merged += 1;
    Ok(())
}

/// Merge every duplicate journal page onto its date's oldest page.
///
/// Idempotent by construction: a merged page is tombstoned, so its date has
/// one live page and the group is gone on the next run.
pub async fn repair_journal_duplicates(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<JournalDuplicateRepair, AppError> {
    let groups = select_groups(tx).await?;
    if groups.is_empty() {
        return Ok(JournalDuplicateRepair::default());
    }
    ACTOR
        .scope(housekeeping("journal-duplicates"), async {
            let mut report = JournalDuplicateRepair::default();
            for group in &groups {
                merge_group(tx, state, device_id, group, &mut report).await?;
            }
            Ok(report)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;
    use crate::spaces::{SPACE_PERSONAL_ULID, SPACE_WORK_ULID};
    use agaric_store::task_locals::Actor;
    use sqlx::SqlitePool;

    async fn run(pool: &SqlitePool, state: &LoroState) -> JournalDuplicateRepair {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let report = repair_journal_duplicates(&mut tx, state, DEV)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        report
    }

    /// A page titled `title` in `space` with `n` children whose content is
    /// `"{label} {i}"`. Returns `(page, children)`.
    async fn page_with_children(
        pool: &SqlitePool,
        title: &str,
        space: &str,
        label: &str,
        n: i64,
    ) -> (String, Vec<String>) {
        let page = next_id();
        insert(
            pool,
            Row {
                id: &page,
                block_type: "page",
                content: title,
                parent_id: None,
                page_id: Some(&page),
                space_id: Some(space),
                position: 1,
            },
        )
        .await;
        let mut children = Vec::new();
        for i in 1..=n {
            let child = next_id();
            let text = format!("{label} {i}");
            insert(
                pool,
                Row {
                    id: &child,
                    block_type: "content",
                    content: &text,
                    parent_id: Some(&page),
                    page_id: Some(&page),
                    space_id: Some(space),
                    position: i,
                },
            )
            .await;
            children.push(child);
        }
        (page, children)
    }

    /// `(op_type, seq)` for every op, in seq order.
    async fn op_sequence(pool: &SqlitePool) -> Vec<(String, i64)> {
        sqlx::query_as::<_, (String, i64)>("SELECT op_type, seq FROM op_log ORDER BY seq")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn duplicates_fold_onto_the_oldest_page_in_creation_order() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        // The measured shape: the oldest page has a child of its own, later
        // pages each carry the day's real content.
        let (keeper, keeper_kids) =
            page_with_children(&pool, "2026-05-05", SPACE_WORK_ULID, "keeper", 1).await;
        let (dup_a, a_kids) =
            page_with_children(&pool, "2026-05-05", SPACE_WORK_ULID, "a", 2).await;
        let (dup_b, b_kids) =
            page_with_children(&pool, "2026-05-05", SPACE_WORK_ULID, "b", 1).await;

        let report = run(&pool, &state).await;

        assert_eq!(report.dates_merged, 1);
        assert_eq!(report.pages_merged, 2);
        assert_eq!(report.children_moved, 3);
        assert_eq!(block(&pool, &keeper).await.deleted_at, None);
        assert!(
            block(&pool, &dup_a).await.deleted_at.is_some(),
            "soft-deleted"
        );
        assert!(block(&pool, &dup_b).await.deleted_at.is_some());
        let expected: Vec<String> = keeper_kids
            .iter()
            .chain(a_kids.iter())
            .chain(b_kids.iter())
            .cloned()
            .collect();
        assert_eq!(
            children_in_order(&pool, &keeper).await,
            expected,
            "keeper ends with all children, its own first, then the rest in creation order"
        );
        for child in a_kids.iter().chain(b_kids.iter()) {
            let b = block(&pool, child).await;
            assert_eq!(b.deleted_at, None, "a moved child is live");
            assert_eq!(
                b.page_id.as_deref(),
                Some(keeper.as_str()),
                "page_id re-derived"
            );
            assert_eq!(b.space_id.as_deref(), Some(SPACE_WORK_ULID));
            assert_eq!(
                ops_on(&pool, child).await,
                vec![("move_block".to_owned(), Actor::Housekeeping.origin_tag())]
            );
        }
        assert_eq!(
            ops_on(&pool, &dup_a).await,
            vec![("delete_block".to_owned(), Actor::Housekeeping.origin_tag())]
        );
        // The rows still exist, tombstoned — never purged.
        assert_eq!(
            block(&pool, &dup_a).await.page_id.as_deref(),
            Some(dup_a.as_str())
        );
    }

    // Guard: children move BEFORE the delete, so the delete cohort is the
    // page alone and no child is ever tombstoned.
    #[tokio::test]
    async fn children_are_moved_before_the_page_is_deleted() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let (_keeper, _) =
            page_with_children(&pool, "2026-05-07", SPACE_WORK_ULID, "keeper", 1).await;
        let (dup, kids) = page_with_children(&pool, "2026-05-07", SPACE_WORK_ULID, "d", 3).await;

        let report = run(&pool, &state).await;

        // Every move precedes the delete in the op log.
        let seq = op_sequence(&pool).await;
        let delete_seq = seq
            .iter()
            .find(|(t, _)| t == "delete_block")
            .map(|(_, s)| *s)
            .expect("the duplicate was deleted");
        let moves: Vec<i64> = seq
            .iter()
            .filter(|(t, _)| t == "move_block")
            .map(|(_, s)| *s)
            .collect();
        assert_eq!(moves.len(), 3);
        assert!(
            moves.iter().all(|s| *s < delete_seq),
            "moves {moves:?} must all precede the delete at seq {delete_seq}"
        );
        // And the delete's cohort — what a restore would bring back — is the
        // page alone.
        let cohort = report
            .ops
            .iter()
            .find_map(|op| match op {
                RepairOp::Delete { effects, .. } => Some(effects.deleted_cohort.clone()),
                _ => None,
            })
            .expect("one delete op");
        assert_eq!(
            cohort,
            vec![dup.clone()],
            "cohort is the emptied page alone"
        );
        for kid in &kids {
            assert_eq!(block(&pool, kid).await.deleted_at, None);
        }
    }

    // Guard: the digit mask, not `LIKE '____-__-__'`. The title is exactly
    // ten characters in the date's shape — `_` matches any character, so
    // `LIKE` alone accepts it and only the `GLOB` digit mask refuses it. (An
    // eleven-character `notes-on-me` would fail the `LIKE` too and prove
    // nothing.)
    #[tokio::test]
    async fn date_shaped_but_not_a_date_is_not_merged() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        assert_eq!("note-on-me".len(), "2026-05-05".len());
        let (a, _) = page_with_children(&pool, "note-on-me", SPACE_WORK_ULID, "a", 1).await;
        let (b, _) = page_with_children(&pool, "note-on-me", SPACE_WORK_ULID, "b", 1).await;

        let report = run(&pool, &state).await;

        assert_eq!(report.dates_merged, 0);
        assert_eq!(block(&pool, &a).await.deleted_at, None);
        assert_eq!(block(&pool, &b).await.deleted_at, None);
        assert_eq!(op_count(&pool).await, 0, "no op may be emitted");
    }

    // Guard: spaces are namespaces — one date per space is not a duplicate.
    #[tokio::test]
    async fn the_same_date_in_two_spaces_is_not_merged() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let (work, _) = page_with_children(&pool, "2026-05-08", SPACE_WORK_ULID, "w", 1).await;
        let (personal, _) =
            page_with_children(&pool, "2026-05-08", SPACE_PERSONAL_ULID, "p", 1).await;

        let report = run(&pool, &state).await;

        assert_eq!(report.dates_merged, 0);
        assert_eq!(block(&pool, &work).await.deleted_at, None);
        assert_eq!(block(&pool, &personal).await.deleted_at, None);
        assert_eq!(op_count(&pool).await, 0);
    }

    #[tokio::test]
    async fn rerun_is_a_noop() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let (keeper, _) = page_with_children(&pool, "2026-05-06", SPACE_WORK_ULID, "k", 1).await;
        let (_dup, _) = page_with_children(&pool, "2026-05-06", SPACE_WORK_ULID, "d", 2).await;
        let first = run(&pool, &state).await;
        assert_eq!(first.pages_merged, 1);
        let ops_after_first = op_count(&pool).await;

        let again = run(&pool, &state).await;

        assert_eq!(again.dates_merged, 0);
        assert_eq!(again.pages_merged, 0);
        assert_eq!(again.children_moved, 0);
        assert_eq!(
            op_count(&pool).await,
            ops_after_first,
            "a re-run emits nothing"
        );
        assert_eq!(children_in_order(&pool, &keeper).await.len(), 3);
    }
}
