//! #6278 — the collision pass: two live pages or two live tags of one space
//! whose names fold to one [`name_key`](agaric_core::tag_norm::name_key).
//!
//! Every write path refuses a folded clash (#6278 I1), but two devices that
//! each create `Foo` offline, a journal day or a bibliography import (which
//! compare exact titles) can still leave one, and a vault can carry one from
//! before. The lowest id holds the name on every read path (I2); this pass
//! clears the tie itself. It runs at boot and after each sync session that
//! changed something.
//!
//! # Only the creator acts
//!
//! A tie is acted on by the device that created its later member: the one
//! whose engine minted that block's tree node ([`LoroEngineRegistry::created_here`],
//! the node's `TreeID.peer`). A rename is a text splice, so two devices that
//! each appended ` (2)` would merge to `Foo (2) (2)`; one actor cannot. A tie
//! whose creator is gone stays, and the lowest id still holds the name.
//!
//! - **Pages**: the later page is renamed to the first free `Title (n)`, free
//!   against the space's titles and aliases, by one ordinary `EditBlock`. A
//!   page is renamed, not merged: a merge would leave every referrer pointing
//!   into the Trash and fold together pages meant as different (two
//!   `Untitled`). A journal-titled page is never renamed; the journal repair
//!   merges those. The renames are this device's notice
//!   ([`EVENT_PAGES_RENAMED`]).
//! - **Tags**: the later tag merges into the keeper. Each live holder gets the
//!   keeper and loses the later tag (`AddTag`, `RemoveTag`), each live block
//!   whose content holds `#[LATER]` is rewritten to `#[KEEPER]` (`EditBlock`),
//!   and the emptied tag is soft-deleted (`DeleteBlock`). The holders and the
//!   referrers move `TAG_MERGE_CHUNK` to a transaction behind a cursor, so a
//!   large tag never holds the writer long; a failure keeps the chunks before
//!   it, and the next run carries on from what is left. A tie whose later tag
//!   a block of another space holds or names is left whole
//!   (`used_outside_its_space`).
//!
//! Every op is appended under [`Actor::Housekeeping`], so it syncs and lists
//! in History but is outside positional undo. Each transaction re-reads the
//! tie before acting, so a second run, or a run racing another, changes
//! nothing. A failure rolls back its own transaction, is logged, and leaves
//! the rest of the pass running.

use std::collections::BTreeMap;
use std::future::Future;

use serde::Serialize;
use sqlx::SqlitePool;

use crate::commands::blocks::crud::{
    delete_block_in_tx, dispatch_deletes, edit_block_in_tx, space_tag_names,
};
use crate::commands::spaces::{SpacePageNames, list_spaces_inner};
use crate::commands::tags::{apply_tag_to_block_in_tx, remove_tag_in_tx};
use crate::db::CommandTx;
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_engine::loro::registry::LoroEngineRegistry;
use agaric_store::op::{AddTagPayload, OpPayload};
use agaric_store::space::SpaceId;
use agaric_store::task_locals::{ACTOR, Actor, ActorContext};

/// The event a device emits for the pages its pass renamed, payload
/// `Vec<PageRenamed>`; `src/hooks/usePageRenameNotices.ts` shows it.
pub const EVENT_PAGES_RENAMED: &str = "pages:renamed";

/// Holders, or referrers, a tag merge moves per transaction.
const TAG_MERGE_CHUNK: i64 = 200;

/// One page the pass renamed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageRenamed {
    pub page_id: String,
    pub from: String,
    pub to: String,
}

/// What one run did.
#[derive(Debug, Default)]
pub struct NameCollisionRepair {
    pub renamed: Vec<PageRenamed>,
    /// Later tags merged into their keeper and deleted.
    pub tags_merged: usize,
}

impl NameCollisionRepair {
    pub fn changed(&self) -> bool {
        !self.renamed.is_empty() || self.tags_merged > 0
    }
}

/// Run the pass over every space. Never fails: each failure is logged and the
/// rest of the pass runs.
pub async fn repair_name_collisions(
    pool: &SqlitePool,
    read_pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
) -> NameCollisionRepair {
    repair_in_chunks(pool, read_pool, device_id, materializer, TAG_MERGE_CHUNK).await
}

/// [`repair_name_collisions`] with the tag merge's chunk size.
pub(crate) async fn repair_in_chunks(
    pool: &SqlitePool,
    read_pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    chunk: i64,
) -> NameCollisionRepair {
    let mut report = NameCollisionRepair::default();
    let due = match collisions_due(read_pool, &materializer.loro_state().registry).await {
        Ok(due) => due,
        Err(e) => {
            tracing::error!(error = %e, "name collision probe failed; the next run retries (#6278)");
            return report;
        }
    };
    for space in due {
        if space.renames {
            match rename_later_pages(pool, device_id, materializer, &space.id).await {
                Ok(renamed) => report.renamed.extend(renamed),
                Err(e) => tracing::error!(
                    error = %e, space_id = %space.id,
                    "page name collision repair failed; the next run retries (#6278)"
                ),
            }
        }
        for tie in space.merges {
            match merge_tag(pool, device_id, materializer, &tie, chunk).await {
                Ok(true) => report.tags_merged += 1,
                Ok(false) => {}
                Err(e) => tracing::error!(
                    error = %e, tag_id = %tie.later, keeper = %tie.keeper,
                    "tag name collision repair failed; the next run carries on (#6278)"
                ),
            }
        }
    }
    report
}

/// One space with something for this device to do.
struct SpaceDue {
    id: String,
    renames: bool,
    merges: Vec<TagTie>,
}

/// The read the pass probes on before it takes the writer.
async fn collisions_due(
    read_pool: &SqlitePool,
    registry: &LoroEngineRegistry,
) -> Result<Vec<SpaceDue>, AppError> {
    let spaces = list_spaces_inner(read_pool).await?;
    let mut conn = read_pool.acquire().await?;
    let mut due = Vec::new();
    for space in spaces {
        let space_id = SpaceId::from_trusted(&space.id);
        let names = SpacePageNames::read(&mut conn, &space.id).await?;
        let renames = !renames_due(&names, registry, &space_id).is_empty();
        let tags = space_tag_names(&mut conn, &space.id).await?;
        let mut merges = Vec::new();
        for tie in merges_due(&space.id, tags, registry) {
            if used_outside_its_space(&mut conn, &tie).await? {
                tracing::debug!(
                    tag_id = %tie.later, keeper = %tie.keeper,
                    "left a tag name tie: a block of another space holds or names the later tag (#6278)"
                );
            } else {
                merges.push(tie);
            }
        }
        if renames || !merges.is_empty() {
            due.push(SpaceDue {
                id: space.id,
                renames,
                merges,
            });
        }
    }
    Ok(due)
}

/// The later pages of `names`' ties this device created, as `(page_id, title)`.
fn renames_due(
    names: &SpacePageNames,
    registry: &LoroEngineRegistry,
    space_id: &SpaceId,
) -> Vec<(String, String)> {
    names
        .title_ties()
        .into_iter()
        .flat_map(|tie| tie.into_iter().skip(1))
        .filter(|(page_id, title)| {
            !is_journal_title(title) && registry.created_here(space_id, page_id)
        })
        .collect()
}

/// A title the journal repair owns: the `YYYY-MM-DD` digit mask it selects by.
fn is_journal_title(title: &str) -> bool {
    let bytes = title.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

/// The first `Title (n)`, from 2, no live page of the space holds as a title
/// or an alias.
///
/// Three devices that each renamed to `Foo (2)` before they met tie there
/// again, and the later page becomes `Foo (2) (2)`: still unique, and not worth
/// guessing whether a trailing `(n)` is the pass's own or the user's, as in
/// `Report (2024)`.
pub(crate) fn first_free_title(names: &SpacePageNames, title: &str) -> String {
    let base = title.trim();
    let mut n: u64 = 2;
    loop {
        let candidate = format!("{base} ({n})");
        if names.holder(&candidate, None).is_none() {
            return candidate;
        }
        n += 1;
    }
}

/// Rename every later page of `space_id`'s ties this device created, in one
/// transaction.
async fn rename_later_pages(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
) -> Result<Vec<PageRenamed>, AppError> {
    let state = materializer.loro_state();
    let space = SpaceId::from_trusted(space_id);
    let mut tx = CommandTx::begin_immediate(pool, "repair_page_name_collisions").await?;
    tx.arm_engine_rollback(state);
    let due = renames_due(
        &SpacePageNames::read(&mut tx, space_id).await?,
        &state.registry,
        &space,
    );
    let mut renamed = Vec::with_capacity(due.len());
    for (page_id, from) in due {
        // Read again after each rename: the next page must not take its name.
        let to = first_free_title(&SpacePageNames::read(&mut tx, space_id).await?, &from);
        as_housekeeping(edit_block_in_tx(
            &mut tx,
            state,
            device_id,
            page_id.clone(),
            to.clone(),
            None,
        ))
        .await?;
        tracing::info!(%page_id, %from, %to, "renamed the later page of a name tie (#6278)");
        renamed.push(PageRenamed { page_id, from, to });
    }
    tx.commit_and_dispatch(materializer).await?;
    Ok(renamed)
}

/// Two live tags of one space whose names fold together: `later` merges into
/// `keeper`, the smallest id.
struct TagTie {
    space_id: String,
    keeper: String,
    later: String,
}

impl TagTie {
    /// Whether both tags are still live in the space and still tie.
    async fn stands(&self, conn: &mut sqlx::SqliteConnection) -> Result<bool, AppError> {
        let tags = space_tag_names(conn, &self.space_id).await?;
        let key_of = |id: &str| tags.iter().find(|(tag, _)| tag == id).map(|(_, key)| key);
        Ok(matches!(
            (key_of(&self.keeper), key_of(&self.later)),
            (Some(keeper), Some(later)) if keeper == later
        ))
    }
}

/// The ties among `tags` (`(id, name_key)`) whose later tag this device made.
fn merges_due(
    space_id: &str,
    tags: Vec<(String, String)>,
    registry: &LoroEngineRegistry,
) -> Vec<TagTie> {
    let space = SpaceId::from_trusted(space_id);
    let mut by_key: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (id, key) in tags {
        by_key.entry(key).or_default().push(id);
    }
    let mut due = Vec::new();
    for mut ids in by_key.into_values().filter(|ids| ids.len() > 1) {
        ids.sort_unstable();
        let keeper = ids.remove(0);
        for later in ids {
            if registry.created_here(&space, &later) {
                due.push(TagTie {
                    space_id: space_id.to_owned(),
                    keeper: keeper.clone(),
                    later,
                });
            }
        }
    }
    due
}

/// Whether a live block outside `tie`'s space holds or names the later tag, as
/// [`resolve_block_space`](agaric_store::space::resolve_block_space) places it.
/// A tag may not cross spaces, so the keeper cannot be applied there and an
/// edit naming it is refused; such a tie is left whole, since a partial merge
/// would split the holders and still keep the later tag live.
async fn used_outside_its_space(
    conn: &mut sqlx::SqliteConnection,
    tie: &TagTie,
) -> Result<bool, AppError> {
    let token = format!("#[{}]", tie.later);
    Ok(sqlx::query_scalar!(
        r#"SELECT EXISTS (
               SELECT 1 FROM block_tags bt
               JOIN blocks b ON b.id = bt.block_id AND b.deleted_at IS NULL
               LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
               WHERE bt.tag_id = ?1 AND COALESCE(b.space_id, p.space_id) IS NOT ?2
           ) OR EXISTS (
               SELECT 1 FROM blocks b
               LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
               WHERE b.deleted_at IS NULL AND instr(b.content, ?3) > 0
                 AND COALESCE(b.space_id, p.space_id) IS NOT ?2
           ) AS "outside!: bool""#,
        tie.later,
        tie.space_id,
        token,
    )
    .fetch_one(conn)
    .await?)
}

/// Merge `tie.later` into `tie.keeper`: holders, then referrers, a chunk per
/// transaction, then the delete. `false` when the tie went away first.
async fn merge_tag(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    tie: &TagTie,
    chunk: i64,
) -> Result<bool, AppError> {
    let mut after = String::new();
    while let Some(last) = move_holders(pool, device_id, materializer, tie, &after, chunk).await? {
        after = last;
    }
    after.clear();
    while let Some(last) =
        rewrite_referrers(pool, device_id, materializer, tie, &after, chunk).await?
    {
        after = last;
    }
    delete_later_tag(pool, device_id, materializer, tie).await
}

/// Up to `chunk` live blocks holding `tag_id`, past `after`, in id order. A
/// Trash block keeps the later tag, as it keeps any tag deleted while it is
/// there: `edit_block_in_tx` and `AddTag` act on live blocks only.
async fn live_holders(
    conn: &mut sqlx::SqliteConnection,
    tag_id: &str,
    after: &str,
    chunk: i64,
) -> Result<Vec<String>, AppError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT bt.block_id AS "block_id!: String"
           FROM block_tags bt
           JOIN blocks b ON b.id = bt.block_id
           WHERE bt.tag_id = ?1 AND b.deleted_at IS NULL AND bt.block_id > ?2
           ORDER BY bt.block_id
           LIMIT ?3"#,
        tag_id,
        after,
        chunk,
    )
    .fetch_all(conn)
    .await?)
}

/// Up to `chunk` live blocks whose content holds `token`, past `after`, in id
/// order, with that content; live for the reason [`live_holders`] gives. The
/// content is the source of truth: the
/// `block_tag_refs` cache trails an edit, and a cursor over it could revisit
/// a block this pass already rewrote.
async fn live_referrers(
    conn: &mut sqlx::SqliteConnection,
    token: &str,
    after: &str,
    chunk: i64,
) -> Result<Vec<(String, String)>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT id AS "id!: String", content AS "content!: String"
           FROM blocks
           WHERE deleted_at IS NULL AND id > ?1 AND instr(content, ?2) > 0
           ORDER BY id
           LIMIT ?3"#,
        after,
        token,
        chunk,
    )
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().map(|row| (row.id, row.content)).collect())
}

/// One chunk of `tie.later`'s holders past `after` take the keeper and drop
/// the later tag. Returns the last holder moved, `None` once none is left or
/// the tie is gone.
async fn move_holders(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    tie: &TagTie,
    after: &str,
    chunk: i64,
) -> Result<Option<String>, AppError> {
    let state = materializer.loro_state();
    let mut tx = CommandTx::begin_immediate(pool, "repair_tag_name_collisions").await?;
    tx.arm_engine_rollback(state);
    if !tie.stands(&mut tx).await? {
        return Ok(None);
    }
    let holders = live_holders(&mut tx, &tie.later, after, chunk).await?;
    let Some(last) = holders.last().cloned() else {
        return Ok(None);
    };
    as_housekeeping(async {
        for holder in &holders {
            if *holder != tie.keeper {
                let add = OpPayload::AddTag(AddTagPayload {
                    block_id: BlockId::from_trusted(holder),
                    tag_id: BlockId::from_trusted(&tie.keeper),
                });
                let added =
                    apply_tag_to_block_in_tx(&mut tx, state, device_id, holder, &tie.keeper, add)
                        .await?;
                if let Some(record) = added {
                    tx.enqueue_background(record);
                }
            }
            if let Some(record) =
                remove_tag_in_tx(&mut tx, state, device_id, holder, &tie.later).await?
            {
                tx.enqueue_background(record);
            }
        }
        Ok::<_, AppError>(())
    })
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(Some(last))
}

/// One chunk of the live blocks past `after` whose content holds
/// `#[tie.later]` have it rewritten to `#[tie.keeper]`. Returns the last block
/// rewritten, `None` once none is left or the tie is gone.
async fn rewrite_referrers(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    tie: &TagTie,
    after: &str,
    chunk: i64,
) -> Result<Option<String>, AppError> {
    let state = materializer.loro_state();
    let later_ref = format!("#[{}]", tie.later);
    let keeper_ref = format!("#[{}]", tie.keeper);
    let mut tx = CommandTx::begin_immediate(pool, "repair_tag_name_collisions").await?;
    tx.arm_engine_rollback(state);
    if !tie.stands(&mut tx).await? {
        return Ok(None);
    }
    let referrers = live_referrers(&mut tx, &later_ref, after, chunk).await?;
    let Some(last) = referrers.last().map(|(id, _)| id.clone()) else {
        return Ok(None);
    };
    as_housekeeping(async {
        for (id, content) in referrers {
            let rewritten = content.replace(&later_ref, &keeper_ref);
            edit_block_in_tx(&mut tx, state, device_id, id, rewritten, None).await?;
        }
        Ok::<_, AppError>(())
    })
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(Some(last))
}

/// Soft-delete `tie.later` once nothing live holds or names it. `false` when
/// the tie is gone.
async fn delete_later_tag(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    tie: &TagTie,
) -> Result<bool, AppError> {
    let state = materializer.loro_state();
    let mut tx = CommandTx::begin_immediate(pool, "repair_tag_name_collisions").await?;
    tx.arm_engine_rollback(state);
    if !tie.stands(&mut tx).await? {
        return Ok(false);
    }
    // A block tagged or written while the chunks ran: the next run moves it.
    let held = !live_holders(&mut tx, &tie.later, "", 1).await?.is_empty();
    let named = !live_referrers(&mut tx, &format!("#[{}]", tie.later), "", 1)
        .await?
        .is_empty();
    if held || named {
        return Err(AppError::InvalidOperation(format!(
            "repair: tag '{}' is still held or named after its merge into '{}'; \
             refusing to delete it",
            tie.later, tie.keeper
        )));
    }
    let deleted = as_housekeeping(delete_block_in_tx(
        &mut tx,
        state,
        device_id,
        tie.later.clone(),
    ))
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    dispatch_deletes(pool, materializer, std::slice::from_ref(&deleted)).await;
    tracing::info!(
        tag_id = %tie.later, keeper = %tie.keeper,
        "merged the later tag of a name tie (#6278)"
    );
    Ok(true)
}

/// Run `work` with its ops appended as [`Actor::Housekeeping`].
async fn as_housekeeping<T>(work: impl Future<Output = T>) -> T {
    let context = ActorContext {
        actor: Actor::Housekeeping,
        request_id: format!("repair:name-collisions:{}", crate::db::now_ms()),
    };
    ACTOR.scope(context, work).await
}

#[cfg(test)]
mod tests;
