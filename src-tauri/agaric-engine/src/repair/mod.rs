//! Boot-time repairs that make historically-unreachable content reachable
//! again (#4728, #4715).
//!
//! Two populations were measured on a real vault, each left behind by a
//! write-side defect that is itself already closed:
//!
//! * [`orphans`](crate::repair::orphans) — live `content` blocks with neither a parent nor a page,
//!   promoted to top level by the recovery orphan cleanup (#4728). They are in
//!   the FTS index but no view can open them. The ones that carry something
//!   are re-homed under an `Unreachable` page in their space.
//! * [`journal_duplicates`](crate::repair::journal_duplicates) — several live journal pages for one date in one
//!   space, minted while the journal lookup could not see a space-less page
//!   (#4715). Their children are folded onto the oldest page and the emptied
//!   duplicates are soft-deleted.
//!
//! # Every change is an op
//!
//! `blocks` is a projection of the per-space Loro docs plus the op log. A raw
//! `UPDATE`/`DELETE` here would be undone by the next replay and would
//! diverge from every peer, so each repair emits real `MoveBlock` /
//! `DeleteBlock` / `CreateBlock` / `SetProperty` ops through
//! [`agaric_store::op_log::append_local_op_in_tx`] and applies them through
//! [`crate::apply::kernel::apply_op_projected`] — the same entry point the
//! interactive commands and sync replay use. Deletes are soft, never purges.
//!
//! # Housekeeping, not the user's edits
//!
//! Every op is appended under [`Actor::Housekeeping`](agaric_store::task_locals::Actor::Housekeeping) (#4741), so
//! `op_log.origin = 'housekeeping'`. The positional undo in
//! `commands::history` admits only `'user'` / `'agent:%'` rows, so a Ctrl+Z
//! after boot cannot revert a repair. The ops still replay, sync, list in
//! History and restore from Trash like any other.
//!
//! # Not boot-fatal, idempotent by construction
//!
//! The app's `repair` module drives each repair in a `CommandTx` of its own
//! and logs-and-swallows an error, so a repair can never keep the app from
//! starting; a failed batch rolls back whole and the next boot retries.
//! Neither needs a marker: a re-homed orphan has a `page_id` and a merged
//! duplicate is tombstoned, so each selection query returns nothing the
//! second time, and each is an indexed probe over a population that is small
//! by construction.

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::db::{next_delete_ms, now_ms};
use agaric_store::op::{DeleteBlockPayload, MoveBlockPayload, OpPayload};
use agaric_store::op_log::{self, OpRecord};
use agaric_store::task_locals::{Actor, ActorContext};

use crate::apply::kernel::{ApplyEffects, apply_op_projected};
use crate::block_ops::{create_block_in_tx, set_property_in_tx};
use crate::loro::shared::LoroState;
use crate::spaces::SPACE_PERSONAL_ULID;

pub mod journal_duplicates;
pub mod orphans;

/// Title of the per-space page that re-homed content lands under. Looked up
/// by title within the space on every run, so one page per space accumulates
/// everything a later boot finds — a user renaming it simply retires it.
pub const UNREACHABLE_PAGE_TITLE: &str = "Unreachable";

/// One op a repair emitted, with what the app driver needs to dispatch it
/// after commit. The engine crate has no `CommandTx`, so the driver owns the
/// enqueue → commit → fan-out sequence; this is the hand-off.
#[derive(Debug)]
pub enum RepairOp {
    /// `CreateBlock` / `SetProperty` for the `Unreachable` page — plain
    /// background dispatch, as `create_page_in_space_inner` does.
    Plain(OpRecord),
    /// A `MoveBlock`. Never a same-page move (the subject left a page it did
    /// not have, or a duplicate page), so the driver passes `same_page =
    /// false` and the full `page_id`-derived rebuild set runs.
    Move(OpRecord),
    /// A `DeleteBlock` (an emptied duplicate journal page): the lifecycle
    /// dispatch keyed by `block_type`, then the post-commit engine cohort
    /// fan-out from `effects`, exactly as `delete_block_inner` runs them.
    Delete {
        record: OpRecord,
        block_type: String,
        effects: ApplyEffects,
    },
}

/// The [`ActorContext`] every repair runs under (#4741). Set inside each
/// repair rather than in the boot driver, so any caller gets it.
fn housekeeping(label: &str) -> ActorContext {
    ActorContext {
        actor: Actor::Housekeeping,
        request_id: format!("repair:{label}:{}", now_ms()),
    }
}

/// `space_id` if it is a live, registered space; else Personal — the same
/// choice the boot backfill makes for a space-less page (`pages_without_space`
/// → `migrate_pages_to_personal_space_batched`). A block with no space
/// therefore goes where the rest of its era's space-less content went.
async fn destination_space(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    space_id: Option<&str>,
) -> Result<String, AppError> {
    if let Some(space) = space_id {
        let live = sqlx::query_scalar!(
            r#"SELECT 1 AS "ok: i32" FROM spaces s
               JOIN blocks b ON b.id = s.id
               WHERE s.id = ? AND b.deleted_at IS NULL"#,
            space,
        )
        .fetch_optional(&mut **tx)
        .await?
        .is_some();
        if live {
            return Ok(space.to_owned());
        }
    }
    Ok(SPACE_PERSONAL_ULID.to_owned())
}

/// The `Unreachable` page of one space (#4728), found or created this run and
/// stamped after its moves either way (see [`UnreachablePage::finish`]).
#[derive(Debug)]
struct UnreachablePage {
    id: String,
    space_id: String,
    /// `true` when this run created the page; reported, not acted on.
    created: bool,
}

impl UnreachablePage {
    /// Find the live `Unreachable` page of `space_id`, or create it (unstamped)
    /// through the same `create_block_in_tx` the create-page command uses.
    async fn find_or_create(
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        state: &LoroState,
        device_id: &str,
        space_id: String,
        ops: &mut Vec<RepairOp>,
    ) -> Result<Self, AppError> {
        let existing = sqlx::query_scalar!(
            r#"SELECT id AS "id!: String" FROM blocks
               WHERE block_type = 'page' AND deleted_at IS NULL
                 AND content = ?1 AND space_id = ?2
               ORDER BY id LIMIT 1"#,
            UNREACHABLE_PAGE_TITLE,
            space_id,
        )
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(id) = existing {
            return Ok(Self {
                id,
                space_id,
                created: false,
            });
        }
        let (block, record) = create_block_in_tx(
            tx,
            state,
            device_id,
            "page".to_owned(),
            UNREACHABLE_PAGE_TITLE.to_owned(),
            None,
            None,
            None,
        )
        .await?;
        ops.push(RepairOp::Plain(record));
        Ok(Self {
            id: block.id.into_string(),
            space_id,
            created: true,
        })
    }

    /// Stamp the page's space AFTER its moves — the `SetProperty(space)` half
    /// of `create_page_in_space_inner`, on a found page as much as a created
    /// one. The stamp's apply hydrates the page's LIVE subtree into the
    /// space's Loro doc (`hydrate_page_subtree_into_engine`, #2326; nodes
    /// already there are skipped), and that is what carries the re-homed
    /// blocks into the engine: their own move took the SQL-only fallback (no
    /// space to resolve, never in any doc), so without a stamp after them
    /// they would be reachable in SQL and absent from every export and peer.
    async fn finish(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        state: &LoroState,
        device_id: &str,
        ops: &mut Vec<RepairOp>,
    ) -> Result<(), AppError> {
        let (_block, record) = set_property_in_tx(
            tx,
            state,
            device_id,
            self.id.clone(),
            "space",
            None,
            None,
            None,
            Some(self.space_id.clone()),
            None,
        )
        .await?;
        ops.push(RepairOp::Plain(record));
        Ok(())
    }
}

/// Live children of `parent_id` — the append slot for the next move.
async fn live_child_count(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    parent_id: &str,
) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "n!: i64" FROM blocks
           WHERE parent_id = ? AND deleted_at IS NULL"#,
        parent_id,
    )
    .fetch_one(&mut **tx)
    .await?)
}

/// Append `block_id` as the last child of `new_parent_id` through a
/// `MoveBlock` op and the shared apply kernel.
///
/// The kernel's `PreOpState::Move` maintenance re-derives `page_id` and
/// `space_id` for the moved subtree whenever the parent changed
/// (`maintain_pages_cache_counts_after_op` → `rederive_page_and_space_ids`),
/// which it always has here — `project_move_block_to_sql` alone writes only
/// `parent_id`/`position`. That derivation is the whole point of the move, so
/// it is asserted rather than trusted: a subject still page-less afterwards
/// fails the batch (rolled back, retried next boot) instead of landing
/// unreachable under a page.
async fn append_under(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    block_id: &str,
    new_parent_id: &str,
) -> Result<OpRecord, AppError> {
    let new_index = live_child_count(tx, new_parent_id).await?;
    let payload = OpPayload::MoveBlock(MoveBlockPayload {
        block_id: BlockId::from_trusted(block_id),
        new_parent_id: Some(BlockId::from_trusted(new_parent_id)),
        new_position: agaric_store::pagination::index_to_provisional_position(new_index),
        new_index: Some(new_index),
    });
    let record = op_log::append_local_op_in_tx(tx, device_id, payload, now_ms()).await?;
    apply_op_projected(tx, &record, state, false).await?;

    let landed = sqlx::query!(
        "SELECT parent_id, page_id FROM blocks WHERE id = ?",
        block_id,
    )
    .fetch_one(&mut **tx)
    .await?;
    if landed.parent_id.as_deref() != Some(new_parent_id) || landed.page_id.is_none() {
        return Err(AppError::InvalidOperation(format!(
            "repair: block '{block_id}' did not land under '{new_parent_id}' with a page_id \
             (parent_id = {:?}, page_id = {:?})",
            landed.parent_id, landed.page_id
        )));
    }
    Ok(record)
}

/// Soft-delete `block_id` (and its live descendants, as one cohort) through
/// a `DeleteBlock` op — the empty-block sweep's shape, with the delete clock
/// stamping `created_at` so restore has its cohort identity. The journal
/// repair calls it only for a page it has already emptied.
async fn soft_delete(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
    block_id: &str,
    block_type: &str,
) -> Result<RepairOp, AppError> {
    let payload = OpPayload::DeleteBlock(DeleteBlockPayload {
        block_id: BlockId::from_trusted(block_id),
    });
    let record = op_log::append_local_op_in_tx(tx, device_id, payload, next_delete_ms()).await?;
    let effects = apply_op_projected(tx, &record, state, false).await?;
    Ok(RepairOp::Delete {
        record,
        block_type: block_type.to_owned(),
        effects,
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Fixture helpers shared by both repairs' tests.

    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use crate::spaces::{SPACE_PERSONAL_ULID, SPACE_WORK_ULID};

    pub const DEV: &str = "test-device";

    /// A migrated pool with Personal and Work seeded and registered (the
    /// `is_space` INSERT fires the registration trigger), as the production
    /// bootstrap leaves them.
    pub async fn pool_with_spaces() -> (SqlitePool, TempDir) {
        let (pool, tmp) = agaric_store::test_support::test_pool().await;
        for (id, name) in [(SPACE_PERSONAL_ULID, "Personal"), (SPACE_WORK_ULID, "Work")] {
            sqlx::query!(
                "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
                 VALUES (?, 'page', ?, NULL, 1, ?)",
                id,
                name,
                id,
            )
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query!(
                "INSERT OR IGNORE INTO block_properties (block_id, key, value_text) \
                 VALUES (?, 'is_space', 'true')",
                id,
            )
            .execute(&pool)
            .await
            .unwrap();
        }
        (pool, tmp)
    }

    /// A fresh, strictly increasing ULID — creation order is id order.
    pub fn next_id() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(1);
        let ts = u64::try_from(agaric_store::db::now_ms()).unwrap();
        let unique = u128::from(SEQ.fetch_add(1, Ordering::Relaxed));
        ulid::Ulid::from_parts(ts, unique).to_string()
    }

    pub struct Row<'a> {
        pub id: &'a str,
        pub block_type: &'a str,
        pub content: &'a str,
        pub parent_id: Option<&'a str>,
        pub page_id: Option<&'a str>,
        pub space_id: Option<&'a str>,
        pub position: i64,
    }

    pub async fn insert(pool: &SqlitePool, row: Row<'_>) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, space_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            row.id,
            row.block_type,
            row.content,
            row.parent_id,
            row.position,
            row.page_id,
            row.space_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    pub struct BlockState {
        pub parent_id: Option<String>,
        pub page_id: Option<String>,
        pub space_id: Option<String>,
        pub deleted_at: Option<i64>,
    }

    pub async fn block(pool: &SqlitePool, id: &str) -> BlockState {
        let r = sqlx::query!(
            "SELECT parent_id, page_id, space_id, deleted_at FROM blocks WHERE id = ?",
            id,
        )
        .fetch_one(pool)
        .await
        .unwrap();
        BlockState {
            parent_id: r.parent_id,
            page_id: r.page_id,
            space_id: r.space_id,
            deleted_at: r.deleted_at,
        }
    }

    /// `(op_type, origin)` of every op on `block_id`, in seq order.
    pub async fn ops_on(pool: &SqlitePool, block_id: &str) -> Vec<(String, String)> {
        sqlx::query_as::<_, (String, String)>(
            "SELECT op_type, origin FROM op_log WHERE block_id = ? ORDER BY seq",
        )
        .bind(block_id)
        .fetch_all(pool)
        .await
        .unwrap()
    }

    pub async fn op_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar!(r#"SELECT COUNT(*) AS "n!: i64" FROM op_log"#)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    /// The live `Unreachable` pages of `space`, oldest first.
    pub async fn unreachable_pages(pool: &SqlitePool, space: &str) -> Vec<String> {
        sqlx::query_scalar!(
            r#"SELECT id AS "id!: String" FROM blocks
               WHERE block_type = 'page' AND deleted_at IS NULL
                 AND content = ?1 AND space_id = ?2 ORDER BY id"#,
            super::UNREACHABLE_PAGE_TITLE,
            space,
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// Live children of `parent`, in the canonical `(position, id)` order.
    pub async fn children_in_order(pool: &SqlitePool, parent: &str) -> Vec<String> {
        sqlx::query_scalar!(
            r#"SELECT id AS "id!: String" FROM blocks
               WHERE parent_id = ? AND deleted_at IS NULL
               ORDER BY position, id"#,
            parent,
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// Whether `block_id` is a node of `space`'s Loro doc.
    pub fn in_engine(state: &crate::loro::shared::LoroState, space: &str, block_id: &str) -> bool {
        let space = agaric_store::space::SpaceId::from_trusted(space);
        let mut guard = state.registry.for_space(&space, DEV).unwrap();
        guard.engine_mut().read_block(block_id).unwrap().is_some()
    }
}
