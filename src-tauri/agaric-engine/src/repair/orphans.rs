//! Repair 1 (#4728) — re-home orphaned content under an `Unreachable` page.
//!
//! The recovery orphan cleanup (`db/recovery.rs`) NULLs the `parent_id` of a
//! block whose parent row is missing, which promotes a damaged block to a
//! live top-level row: no page, no parent, in the FTS index, on no view. A
//! measured vault carried 225 of them, two of them unfinished todos.
//!
//! # The predicate
//!
//! A candidate is a live `content` block with `parent_id IS NULL AND page_id
//! IS NULL` that **carries something**: non-blank content (blank per the
//! frontend's `trim`, [`JS_TRIM_WHITESPACE`]), any of `todo_state` /
//! `priority` / `due_date` / `scheduled_date`, a `block_properties` row, a
//! `block_tags` row, or a live child (a bare block holding real content
//! below it is carrying that content). Measured: 166 of the 225.
//!
//! The remaining bare orphans are deliberately NOT a candidate here: they are
//! exactly the leaked-empty-block sweep's population
//! ([`crate::empty_blocks`]), which soft-deletes them into Trash once they
//! are old enough. Re-homing them would only move junk onto the page.
//!
//! `block_type = 'tag'` rows are parentless by design and never touched.
//!
//! # Destination
//!
//! One `Unreachable` page per space that has orphans, found by title or
//! created through `create_block_in_tx`, then stamped with `SetProperty(space)`
//! after the moves (why the order matters: `UnreachablePage::finish`). An
//! orphan with `space_id IS NULL` (200 of the 225) goes to **Personal**, the
//! same space the boot backfill assigns to every space-less page (see
//! `destination_space` in the parent module).
//! Orphans are appended in `id` order: ULIDs are creation-ordered, so this
//! preserves the order they were written in.

use agaric_core::error::AppError;
use agaric_store::task_locals::ACTOR;

use super::{RepairOp, UnreachablePage, append_under, destination_space, housekeeping};
use crate::empty_blocks::JS_TRIM_WHITESPACE;
use crate::loro::shared::LoroState;

/// What one run of the orphan repair did.
#[derive(Debug, Default)]
pub struct OrphanRepair {
    /// Ops emitted, in append order, for the driver to dispatch after commit.
    pub ops: Vec<RepairOp>,
    /// Orphans moved under an `Unreachable` page this run.
    pub rehomed: usize,
    /// `Unreachable` pages created this run (at most one per space).
    pub pages_created: usize,
}

/// A carrying orphan and the space its row names (often none).
#[derive(Debug)]
struct Orphan {
    id: String,
    space_id: Option<String>,
}

/// Carrying orphans, in id (creation) order.
async fn select_orphans(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<Orphan>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT b.id AS "id!: String", b.space_id
           FROM blocks b
           WHERE b.block_type = 'content'
             AND b.deleted_at IS NULL
             AND b.parent_id IS NULL
             AND b.page_id IS NULL
             AND (
                    TRIM(COALESCE(b.content, ''), ?1) <> ''
                 OR b.todo_state IS NOT NULL
                 OR b.priority IS NOT NULL
                 OR b.due_date IS NOT NULL
                 OR b.scheduled_date IS NOT NULL
                 OR EXISTS (SELECT 1 FROM block_properties p WHERE p.block_id = b.id)
                 OR EXISTS (SELECT 1 FROM block_tags t WHERE t.block_id = b.id)
                 OR EXISTS (
                     SELECT 1 FROM blocks k
                     WHERE k.parent_id = b.id AND k.deleted_at IS NULL
                 )
             )
           ORDER BY b.id"#,
        JS_TRIM_WHITESPACE,
    )
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| Orphan {
            id: r.id,
            space_id: r.space_id,
        })
        .collect())
}

/// Re-home every carrying orphan under its space's `Unreachable` page.
///
/// Idempotent by construction: a moved block has a `page_id`, so it is not a
/// candidate on the next run, and the page is found by title rather than
/// created again.
pub async fn repair_orphans(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<OrphanRepair, AppError> {
    let orphans = select_orphans(tx).await?;
    ACTOR
        .scope(housekeeping("orphans"), async {
            let mut report = OrphanRepair::default();
            // Group by destination space, preserving id order within each
            // group. The page for a space is resolved once and stamped after
            // its moves — see `UnreachablePage::finish`.
            let mut pages: Vec<UnreachablePage> = Vec::new();
            for orphan in &orphans {
                let space = destination_space(tx, orphan.space_id.as_deref()).await?;
                let idx = match pages.iter().position(|p| p.space_id == space) {
                    Some(i) => i,
                    None => {
                        let page = UnreachablePage::find_or_create(
                            tx,
                            state,
                            device_id,
                            space,
                            &mut report.ops,
                        )
                        .await?;
                        if page.created {
                            report.pages_created += 1;
                        }
                        pages.push(page);
                        pages.len() - 1
                    }
                };
                let page = &pages[idx];
                let record = append_under(tx, state, device_id, &orphan.id, &page.id).await?;
                report.ops.push(RepairOp::Move(record));
                report.rehomed += 1;
            }
            for page in &pages {
                page.finish(tx, state, device_id, &mut report.ops).await?;
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

    async fn run(pool: &SqlitePool, state: &LoroState) -> OrphanRepair {
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let report = repair_orphans(&mut tx, state, DEV).await.unwrap();
        tx.commit().await.unwrap();
        report
    }

    async fn insert_orphan(pool: &SqlitePool, content: &str, space: Option<&str>) -> String {
        let id = next_id();
        insert(
            pool,
            Row {
                id: &id,
                block_type: "content",
                content,
                parent_id: None,
                page_id: None,
                space_id: space,
                position: 7,
            },
        )
        .await;
        id
    }

    #[tokio::test]
    async fn carrying_orphan_lands_under_a_new_unreachable_page_in_personal() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let orphan = insert_orphan(&pool, "[Install sqlfluff](case/1232545)", None).await;

        let report = run(&pool, &state).await;

        assert_eq!(report.rehomed, 1);
        assert_eq!(report.pages_created, 1);
        let pages = unreachable_pages(&pool, SPACE_PERSONAL_ULID).await;
        assert_eq!(pages.len(), 1, "one Unreachable page, in Personal");
        let page = &pages[0];
        let b = block(&pool, &orphan).await;
        assert_eq!(b.parent_id.as_deref(), Some(page.as_str()));
        assert_eq!(
            b.page_id.as_deref(),
            Some(page.as_str()),
            "page_id re-derived"
        );
        assert_eq!(
            b.space_id.as_deref(),
            Some(SPACE_PERSONAL_ULID),
            "space_id re-derived from the page"
        );
        assert_eq!(b.deleted_at, None);
        // The page itself is a real space-stamped page.
        let p = block(&pool, page).await;
        assert_eq!(p.page_id.as_deref(), Some(page.as_str()));
        assert_eq!(p.space_id.as_deref(), Some(SPACE_PERSONAL_ULID));
        // Ops, not raw writes: create + space stamp on the page, a move on
        // the orphan — all housekeeping.
        assert_eq!(
            ops_on(&pool, page).await,
            vec![
                ("create_block".to_owned(), Actor::Housekeeping.origin_tag()),
                ("set_property".to_owned(), Actor::Housekeeping.origin_tag()),
            ]
        );
        assert_eq!(
            ops_on(&pool, &orphan).await,
            vec![("move_block".to_owned(), Actor::Housekeeping.origin_tag())]
        );
        assert_eq!(report.ops.len(), 3);
        // The stamp ran after the move, so the hydrate carried the re-homed
        // block into the Personal doc along with the page.
        assert!(in_engine(&state, SPACE_PERSONAL_ULID, page));
        assert!(
            in_engine(&state, SPACE_PERSONAL_ULID, &orphan),
            "re-homed block must be engine-resident, not SQL-only"
        );
    }

    #[tokio::test]
    async fn orphan_with_its_own_space_goes_to_that_space() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let work = insert_orphan(&pool, "work note", Some(SPACE_WORK_ULID)).await;
        let personal = insert_orphan(&pool, "personal note", None).await;

        let report = run(&pool, &state).await;

        assert_eq!(report.rehomed, 2);
        assert_eq!(report.pages_created, 2, "one page per space with orphans");
        let work_page = &unreachable_pages(&pool, SPACE_WORK_ULID).await[0];
        let personal_page = &unreachable_pages(&pool, SPACE_PERSONAL_ULID).await[0];
        assert_eq!(
            block(&pool, &work).await.parent_id.as_deref(),
            Some(work_page.as_str())
        );
        assert_eq!(
            block(&pool, &work).await.space_id.as_deref(),
            Some(SPACE_WORK_ULID)
        );
        assert_eq!(
            block(&pool, &personal).await.parent_id.as_deref(),
            Some(personal_page.as_str())
        );
    }

    #[tokio::test]
    async fn orphans_are_appended_in_id_order_regardless_of_old_position() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        // Old positions run the other way round to id order; id order wins.
        let mut ids = Vec::new();
        for (i, text) in ["first", "second", "third"].iter().enumerate() {
            let id = next_id();
            insert(
                &pool,
                Row {
                    id: &id,
                    block_type: "content",
                    content: text,
                    parent_id: None,
                    page_id: None,
                    space_id: None,
                    position: 30 - i64::try_from(i).unwrap(),
                },
            )
            .await;
            ids.push(id);
        }

        run(&pool, &state).await;

        let page = &unreachable_pages(&pool, SPACE_PERSONAL_ULID).await[0];
        assert_eq!(children_in_order(&pool, page).await, ids);
    }

    /// Every arm of "carries something", one orphan each, in one vault.
    #[tokio::test]
    async fn each_carried_field_qualifies_an_otherwise_blank_orphan() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let tag = next_id();
        insert(
            &pool,
            Row {
                id: &tag,
                block_type: "tag",
                content: "t",
                parent_id: None,
                page_id: None,
                space_id: Some(SPACE_PERSONAL_ULID),
                position: 1,
            },
        )
        .await;
        let mut expected = Vec::new();
        for column in ["todo_state", "priority", "due_date", "scheduled_date"] {
            let id = insert_orphan(&pool, "", None).await;
            // dynamic-sql: test-only column-name interpolation over a fixed
            // four-name set (todo_state / priority / due_date / scheduled_date).
            sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE blocks SET {column} = 'X' WHERE id = ?"
            )))
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
            expected.push(id);
        }
        let with_property = insert_orphan(&pool, "", None).await;
        sqlx::query!(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'note', 'kept')",
            with_property,
        )
        .execute(&pool)
        .await
        .unwrap();
        expected.push(with_property.clone());
        let with_tag = insert_orphan(&pool, "", None).await;
        sqlx::query!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            with_tag,
            tag,
        )
        .execute(&pool)
        .await
        .unwrap();
        expected.push(with_tag.clone());
        let with_child = insert_orphan(&pool, "", None).await;
        let child = next_id();
        insert(
            &pool,
            Row {
                id: &child,
                block_type: "content",
                content: "the content is below the blank parent",
                parent_id: Some(&with_child),
                page_id: None,
                space_id: None,
                position: 1,
            },
        )
        .await;
        expected.push(with_child.clone());

        let report = run(&pool, &state).await;

        assert_eq!(report.rehomed, expected.len());
        let page = &unreachable_pages(&pool, SPACE_PERSONAL_ULID).await[0];
        assert_eq!(children_in_order(&pool, page).await, expected);
        // The child came along and is on the page too.
        assert_eq!(
            block(&pool, &child).await.page_id.as_deref(),
            Some(page.as_str())
        );
        assert_eq!(
            block(&pool, &child).await.parent_id.as_deref(),
            Some(with_child.as_str())
        );
    }

    // Guard: a bare orphan is the sweep's, not ours.
    #[tokio::test]
    async fn bare_orphan_is_left_to_the_empty_block_sweep() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let bare = insert_orphan(&pool, " \n\u{A0}", None).await;

        let report = run(&pool, &state).await;

        assert_eq!(report.rehomed, 0);
        assert_eq!(report.ops.len(), 0);
        assert_eq!(block(&pool, &bare).await.parent_id, None);
        assert!(
            unreachable_pages(&pool, SPACE_PERSONAL_ULID)
                .await
                .is_empty()
        );
        assert_eq!(op_count(&pool).await, 0, "no op may be emitted");
    }

    // Guard: tags are parentless by design.
    #[tokio::test]
    async fn a_tag_row_is_never_rehomed() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let tag = next_id();
        insert(
            &pool,
            Row {
                id: &tag,
                block_type: "tag",
                content: "bug",
                parent_id: None,
                page_id: None,
                space_id: None,
                position: 1,
            },
        )
        .await;

        let report = run(&pool, &state).await;

        assert_eq!(report.rehomed, 0);
        assert_eq!(block(&pool, &tag).await.parent_id, None);
        assert_eq!(op_count(&pool).await, 0);
    }

    #[tokio::test]
    async fn rerun_is_a_noop_and_a_later_orphan_reuses_the_page() {
        let (pool, _tmp) = pool_with_spaces().await;
        let state = LoroState::new();
        let first = insert_orphan(&pool, "first", None).await;
        run(&pool, &state).await;
        let ops_after_first = op_count(&pool).await;

        let again = run(&pool, &state).await;
        assert_eq!(again.rehomed, 0);
        assert_eq!(again.pages_created, 0);
        assert_eq!(
            op_count(&pool).await,
            ops_after_first,
            "a re-run emits nothing"
        );
        assert_eq!(
            ops_on(&pool, &first).await.len(),
            1,
            "exactly one move, ever"
        );

        // Damage found on a later boot lands on the SAME page.
        let later = insert_orphan(&pool, "later", None).await;
        let third = run(&pool, &state).await;
        assert_eq!(third.rehomed, 1);
        assert_eq!(third.pages_created, 0);
        let pages = unreachable_pages(&pool, SPACE_PERSONAL_ULID).await;
        assert_eq!(pages.len(), 1);
        assert_eq!(
            children_in_order(&pool, &pages[0]).await,
            vec![first, later.clone()]
        );
        // The found page was re-stamped after the move, so the later orphan
        // is in the doc too — not left SQL-only under an already-stamped page.
        assert!(in_engine(&state, SPACE_PERSONAL_ULID, &later));
    }
}
