//! Saving a page edited as its source buffer (#5140): [`apply_page_source`].
//!
//! The save parses two buffers: the page's current source (T0), rendered as
//! `get_page_source` renders it, and the buffer the user edited (T1). Blocks
//! pair by their `^ID` anchor, and only what differs between the two parses is
//! written, compared before any name is resolved. So an unchanged buffer writes
//! nothing, and a name the block already held keeps the meaning its render
//! gave it.

use std::collections::{BTreeMap, BTreeSet};

use agaric_core::error::ValidationCode;
use serde::Serialize;

use super::*;
use crate::commands::blocks::crud::{
    DeleteInTx, delete_block_in_tx, delete_property_in_tx, edit_block_in_tx,
};
use crate::commands::blocks::move_ops::{move_block_in_tx, ordered_live_children};
use crate::commands::pages::inline_query_md::{query_page_names, query_tag_names};
use crate::commands::properties::{
    PriorTaskState, resolve_prior_task_states_batch, set_todo_state_in_tx,
};

/// What [`apply_page_source`] wrote.
#[derive(Debug, Clone, Default, Serialize, Type)]
pub struct PageSourceReport {
    /// Blocks created from the buffer: new bullets, and anchors a forced save
    /// kept as new blocks.
    pub created: u32,
    /// Blocks of the page whose content was rewritten.
    pub edited: u32,
    /// Blocks moved to another parent or slot.
    pub moved: u32,
    /// Blocks of the page the buffer no longer holds, each deleted with the
    /// blocks under it.
    pub deleted: u32,
    /// Properties set on blocks the page already had, task state included.
    pub properties_set: u32,
    /// Properties removed from blocks the page already had.
    pub properties_deleted: u32,
    /// The pages and tags created for names the buffer newly wrote.
    pub names_created: Vec<BlockRow>,
    /// What the save could not keep as written.
    pub warnings: Vec<String>,
}

/// Save `source`, the page's source buffer as the user edited it, over the
/// page (#5140), as one transaction and so one undo. `base_source` is the
/// source the edit started from: when it is not the page's source now, the
/// save is refused as stale, whatever `force` says, unless `merge`: then the
/// changes the page took since are folded into the buffer first
/// (`merge::merge_outlines`), and a block both sides changed differently is
/// kept twice, the buffer's version as a new block directly before the page's,
/// with a warning.
///
/// Blocks pair with the page's by their `^ID` anchor. A paired block gets the
/// content, properties, parent and slot the buffer gives it, each written only
/// when it differs from the page's source; a bullet with no anchor is created;
/// a block of the page the buffer no longer holds is deleted. A name typed into
/// a block is resolved in the page's space as an import resolves it, creating
/// the page or tag no name there matches. A checkbox does what a click on it
/// does: the #5074 stamps and, on the edge into DONE, the next occurrence.
///
/// # Errors
///
/// - [`AppError::Ulid`] — `page_id` is not a ULID
/// - [`AppError::NotFound`] — no live page has that id
/// - [`AppError::Validation`] — `page_id` is not a page; with code
///   [`ValidationCode::RequiresRefresh`] when `base_source` is not the page's
///   source and `merge` is false; the page's source does not read back as its
///   blocks (a property value with a line break); an anchor is written twice,
///   or names no block of the page and `force` is false; a block the save
///   would delete holds a nested page; a block would be nested past
///   `MAX_BLOCK_DEPTH`; or the save would append more ops than one undo
///   reverts
#[expect(clippy::too_many_arguments)]
#[instrument(skip(pool, device_id, materializer, source, base_source), err)]
pub async fn apply_page_source_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: &str,
    source: String,
    base_source: String,
    force: bool,
    merge: bool,
) -> Result<PageSourceReport, AppError> {
    let page_id = BlockId::from_string(page_id)?;
    let mut tx = CommandTx::begin_immediate(pool, "apply_page_source").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let mut data = load_page_export_data(&mut tx, page_id.as_str()).await?;
    data.name_snapshot = load_name_snapshot(&mut tx, &data).await?;
    let (base, stale) = read_base(&data, &base_source, merge)?;
    let parsed = import::parse_source_outline(&source);
    let mut warnings = parsed.warnings;
    let blocks = if stale {
        let older = import::parse_source_outline(&base_source).blocks;
        merge::merge_outlines(older, &base.blocks, parsed.blocks, &mut warnings)?
    } else {
        parsed.blocks
    };
    let mut buffer = pair_blocks(&base, blocks, force, &mut warnings)?;
    // Boxed for the reason `duplicate_block_inner` gives.
    let (mut tx, names_created) = Box::pin(resolve_buffer_names(
        tx,
        materializer,
        device_id,
        &data,
        &base,
        &mut buffer,
        &mut warnings,
    ))
    .await?;
    let mut save = Save {
        materializer,
        device_id,
        ids: buffer
            .base
            .iter()
            .map(|slot| slot.map(|slot| base.ids[slot].clone()))
            .collect(),
        report: PageSourceReport::default(),
    };
    Box::pin(place_blocks(
        &mut tx,
        &mut save,
        page_id.as_str(),
        &base,
        &buffer,
    ))
    .await?;
    Box::pin(write_changes(&mut tx, &mut save, &data, &base, &buffer)).await?;
    let deletes = Box::pin(delete_dropped(&mut tx, &mut save, &base, &buffer)).await?;
    tx.commit_and_dispatch(materializer).await?;
    // The post-commit fan-out `delete_block_inner` runs, per delete.
    for deleted in &deletes {
        crate::materializer::dispatch_delete_descendants(
            &deleted.op_record,
            &deleted.effects.deleted_cohort,
            deleted.effects.delete_space_id.as_ref(),
            materializer.loro_state(),
        )
        .await;
        crate::materializer::remove_deleted_cohort_fts(pool, &deleted.effects.deleted_cohort).await;
    }
    save.report.names_created = names_created;
    save.report.warnings = warnings;
    Ok(save.report)
}

/// The page's current source as the save reads it: the ids of the blocks the
/// render holds, in order, and its parse (T0), block for block, with each
/// block's parent among them.
struct Base {
    ids: Vec<String>,
    blocks: Vec<import::ParsedBlock>,
    parents: Vec<Option<usize>>,
}

/// The page's source, and whether it is stale: not `base_source`, which is
/// refused unless `merge`. Refused too when it does not read back as the
/// blocks it renders: a value the grammar cannot carry, such as a property
/// value with a line break, reads back as other content or another block, and
/// saving over it would rewrite the block.
fn read_base(
    data: &PageExportData,
    base_source: &str,
    merge: bool,
) -> Result<(Base, bool), AppError> {
    let (current, ids) = render_page_source_ids(data);
    let stale = current != base_source;
    if stale && !merge {
        return Err(AppError::validation_coded(
            ValidationCode::RequiresRefresh,
            "the page changed after its source was read",
        ));
    }
    let blocks = import::parse_source_outline(&current).blocks;
    let unread = (0..blocks.len().max(ids.len())).find(|&i| {
        blocks.get(i).map(|block| block.block_anchor.as_deref())
            != ids.get(i).map(|id| Some(id.as_str()))
    });
    if let Some(at) = unread {
        let id = ids.get(at).or(ids.last()).map_or("", String::as_str);
        return Err(AppError::validation(format!(
            "block '{id}' holds a value the page's source cannot carry, such as a property \
             value with a line break"
        )));
    }
    Ok((
        Base {
            parents: outline_parents(&blocks),
            ids,
            blocks,
        },
        stale,
    ))
}

/// The edited buffer (T1): its blocks, each one's parent among them, the base
/// block its anchor pairs it with, and whether a paired block's content
/// differs from its base block's, read before any name in it is resolved.
struct Buffer {
    blocks: Vec<import::ParsedBlock>,
    parents: Vec<Option<usize>>,
    base: Vec<Option<usize>>,
    edited: Vec<bool>,
}

/// `blocks` paired with the base by anchor. An anchor written twice is
/// refused, and so is one that names no block of the page's source, unless
/// `force`: then its block is saved as a new one, with a warning, and the block
/// the anchor names, wherever it is, is left alone. An anchor that is not a
/// block id is text.
fn pair_blocks(
    base: &Base,
    mut blocks: Vec<import::ParsedBlock>,
    force: bool,
    warnings: &mut Vec<String>,
) -> Result<Buffer, AppError> {
    blocks.iter_mut().for_each(restore_text_anchor);
    let slots: HashMap<&str, usize> = base
        .ids
        .iter()
        .enumerate()
        .map(|(slot, id)| (id.as_str(), slot))
        .collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut paired = Vec::with_capacity(blocks.len());
    for block in &blocks {
        let Some(anchor) = block.block_anchor.as_deref() else {
            paired.push(None);
            continue;
        };
        if !seen.insert(anchor) {
            return Err(AppError::validation(format!(
                "^{anchor} is written on more than one block"
            )));
        }
        match slots.get(anchor) {
            Some(&slot) => paired.push(Some(slot)),
            None if force => {
                warnings.push(format!(
                    "^{anchor} no longer on this page; saved as a new block"
                ));
                paired.push(None);
            }
            None => {
                return Err(AppError::validation(format!(
                    "^{anchor} is not a block of this page"
                )));
            }
        }
    }
    let edited = blocks
        .iter()
        .zip(&paired)
        .map(|(block, slot)| slot.is_some_and(|slot| block.content != base.blocks[slot].content))
        .collect();
    Ok(Buffer {
        parents: outline_parents(&blocks),
        blocks,
        base: paired,
        edited,
    })
}

/// Put a trailing ` ^word` whose word is not a block id back into the block's
/// text: it names no block, so it is what the user wrote. The parse took the
/// whitespace around it, so a tab or line break before it comes back as a
/// space, and whitespace after it is lost.
fn restore_text_anchor(block: &mut import::ParsedBlock) {
    let Some(word) = block
        .block_anchor
        .take_if(|word| BlockId::from_string(word.as_str()).is_err())
    else {
        return;
    };
    let separator = if block.content.is_empty() { "" } else { " " };
    block.content = format!("{}{separator}^{word}", block.content);
}

/// Each block's parent among `blocks`, `None` for a top-level one, nested as
/// `create_parsed_blocks` nests them.
fn outline_parents(blocks: &[import::ParsedBlock]) -> Vec<Option<usize>> {
    let mut open: Vec<usize> = Vec::new();
    blocks
        .iter()
        .enumerate()
        .map(|(i, block)| {
            while open.last().is_some_and(|&j| blocks[j].depth >= block.depth) {
                open.pop();
            }
            let parent = open.last().copied();
            open.push(i);
            parent
        })
        .collect()
}

/// Each parent's children, in order: entry 0 is the page's, entry `i + 1`
/// block `i`'s.
fn children_of(parents: &[Option<usize>]) -> Vec<Vec<usize>> {
    let mut children = vec![Vec::new(); parents.len() + 1];
    for (i, parent) in parents.iter().enumerate() {
        children[parent.map_or(0, |parent| parent + 1)].push(i);
    }
    children
}

/// The page-link and tag names a block writes, as the importer collects them.
#[derive(Default)]
struct Names {
    links: BTreeSet<String>,
    tags: BTreeSet<String>,
}

impl Names {
    fn of(block: &import::ParsedBlock) -> Self {
        let one = std::slice::from_ref(block);
        Self {
            links: collect_inbound_page_link_names(one)
                .into_iter()
                .chain(query_page_names(one))
                .collect(),
            tags: collect_inbound_tag_names(one)
                .into_iter()
                .chain(query_tag_names(one))
                .collect(),
        }
    }

    /// The names in `self` that `other` holds, when `held`, or that it does
    /// not.
    fn split(&self, other: &Self, held: bool) -> Self {
        Self {
            links: self
                .links
                .iter()
                .filter(|name| other.links.contains(*name) == held)
                .cloned()
                .collect(),
            tags: self
                .tags
                .iter()
                .filter(|name| other.tags.contains(*name) == held)
                .cloned()
                .collect(),
        }
    }
}

/// A block the save writes names for: its row in the buffer, what the names
/// it already held map to, and the names new to it.
struct NamePlan {
    row: usize,
    links: HashMap<String, String>,
    tags: HashMap<String, String>,
    new: Names,
}

/// Write the names in each block the save creates or rewrites as ids. A name
/// the block already held keeps the meaning its render gave it: the id it was
/// humanised from, or none, as text, when the block rendered raw. A name new to
/// the block is resolved in the page's space as an import resolves it,
/// creating the page or tag no name there matches. Returns the pages and tags
/// created.
async fn resolve_buffer_names(
    tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    data: &PageExportData,
    base: &Base,
    buffer: &mut Buffer,
    warnings: &mut Vec<String>,
) -> Result<(CommandTx, Vec<BlockRow>), AppError> {
    let stored = stored_contents(data);
    let mut plans = Vec::new();
    let mut new_names = Names::default();
    for (row, block) in buffer.blocks.iter().enumerate() {
        let slot = buffer.base[row];
        if slot.is_some() && !buffer.edited[row] {
            continue;
        }
        let names = Names::of(block);
        let held = slot.map_or_else(Names::default, |slot| Names::of(&base.blocks[slot]));
        let kept = names.split(&held, true);
        let humanised = slot.is_some_and(|slot| {
            stored.get(base.ids[slot].as_str()) != Some(&base.blocks[slot].content.as_str())
        });
        let (links, tags) = if humanised {
            let snapshot = &data.name_snapshot;
            (
                snapshot.page_links(kept.links.into_iter().collect()),
                snapshot.tags(kept.tags.into_iter().collect()),
            )
        } else {
            (HashMap::new(), HashMap::new())
        };
        let new = names.split(&held, false);
        new_names.links.extend(new.links.iter().cloned());
        new_names.tags.extend(new.tags.iter().cloned());
        plans.push(NamePlan {
            row,
            links,
            tags,
            new,
        });
    }
    let (tx, resolved) = Box::pin(resolve_new_names(
        tx,
        materializer,
        device_id,
        &data.page,
        new_names,
        warnings,
    ))
    .await?;
    for mut plan in plans {
        for (names, map, ids) in [
            (&plan.new.links, &mut plan.links, &resolved.links),
            (&plan.new.tags, &mut plan.tags, &resolved.tags),
        ] {
            map.extend(
                names
                    .iter()
                    .filter_map(|n| Some((n.clone(), ids.get(n)?.clone()))),
            );
        }
        let block = &mut buffer.blocks[plan.row];
        block.content = rewrite_block_content_for_import(block, &plan.links, &plan.tags);
    }
    Ok((tx, resolved.created))
}

/// Each rendered block's stored content, by id.
fn stored_contents(data: &PageExportData) -> HashMap<&str, &str> {
    data.descendants
        .iter()
        .map(|block| (block.id.as_str(), block.content.as_deref().unwrap_or("")))
        .collect()
}

/// What [`resolve_new_names`] resolved: each name's id, and the pages and tags
/// it created.
#[derive(Default)]
struct ResolvedNames {
    links: HashMap<String, String>,
    tags: HashMap<String, String>,
    created: Vec<BlockRow>,
}

/// Resolve `names` in `page`'s space as an import resolves them, creating what
/// no name there matches. A page in no space resolves nothing: every name
/// stays text.
async fn resolve_new_names(
    mut tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    page: &BlockRow,
    names: Names,
    warnings: &mut Vec<String>,
) -> Result<(CommandTx, ResolvedNames), AppError> {
    if names.links.is_empty() && names.tags.is_empty() {
        return Ok((tx, ResolvedNames::default()));
    }
    let Some(space) = agaric_store::space::resolve_block_space(&mut **tx, &page.id).await? else {
        return Ok((tx, ResolvedNames::default()));
    };
    let mut ctx = NameCtx {
        materializer,
        device_id,
        space_id: space.as_str(),
        page_id: page.id.as_str(),
        warnings,
        created: Vec::new(),
    };
    let links: Vec<String> = names.links.into_iter().collect();
    let matches = snapshot_page_link_matches(&mut tx, space.as_str(), &links).await?;
    let (tx, links) = resolve_link_names(&mut ctx, tx, links, &matches).await?;
    let (tx, _, tags, _) =
        resolve_tag_names(&mut ctx, tx, names.tags.into_iter().collect()).await?;
    Ok((
        tx,
        ResolvedNames {
            links: links.page_links,
            tags,
            created: ctx.created,
        },
    ))
}

/// The save's running state: each buffer block's id once it has one, and the
/// report so far.
struct Save<'a> {
    materializer: &'a Materializer,
    device_id: &'a str,
    ids: Vec<Option<String>>,
    report: PageSourceReport,
}

/// Give every parent in the buffer the children the buffer gives it: the page
/// first, then its blocks in order. A parent comes before its children, so its
/// own place is final by the time they move under it, and no move can make a
/// block its own ancestor. A parent whose children the buffer leaves as they
/// were is not touched.
async fn place_blocks(
    tx: &mut CommandTx,
    save: &mut Save<'_>,
    page_id: &str,
    base: &Base,
    buffer: &Buffer,
) -> Result<(), AppError> {
    let base_children = children_of(&base.parents);
    for (entry, children) in children_of(&buffer.parents).iter().enumerate() {
        let (parent, before) = match entry.checked_sub(1) {
            None => (page_id.to_owned(), Some(&base_children[0])),
            Some(row) => (
                save.ids[row]
                    .clone()
                    .expect("a block is placed before its children"),
                buffer.base[row].map(|slot| &base_children[slot + 1]),
            ),
        };
        let wanted = children
            .iter()
            .map(|&row| buffer.base[row].map(|slot| base.ids[slot].as_str()));
        if let Some(before) = before
            && wanted.eq(before.iter().map(|&slot| Some(base.ids[slot].as_str())))
        {
            continue;
        }
        let live = match before {
            Some(_) => ordered_live_children(tx, Some(&parent)).await?,
            None => Vec::new(),
        };
        place_children(tx, save, &parent, live, children, buffer).await?;
    }
    Ok(())
}

/// Which of a parent's buffer children (their ids, for those that exist) stay
/// where they are: those already among its `live` children, in the longest run
/// whose order the buffer keeps. A live child the page's source does not show,
/// such as a nested page, is in no buffer, so it decides nothing.
fn staying(live: &[String], children: &[Option<String>]) -> Vec<bool> {
    let live_slot: HashMap<&str, usize> = live
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let under: Vec<(usize, usize)> = children
        .iter()
        .enumerate()
        .filter_map(|(at, id)| Some((at, *live_slot.get(id.as_deref()?)?)))
        .collect();
    let slots: Vec<usize> = under.iter().map(|&(_, from)| from).collect();
    let mut stays = vec![false; children.len()];
    for i in longest_increasing(&slots) {
        stays[under[i].0] = true;
    }
    stays
}

/// The indices of a longest strictly increasing subsequence of `values`.
fn longest_increasing(values: &[usize]) -> Vec<usize> {
    // `tails[k]`: the index ending the increasing run of length `k + 1` with
    // the smallest last value seen so far.
    let mut tails: Vec<usize> = Vec::new();
    let mut previous: Vec<Option<usize>> = vec![None; values.len()];
    for (i, &value) in values.iter().enumerate() {
        let k = tails.partition_point(|&j| values[j] < value);
        previous[i] = k.checked_sub(1).map(|k| tails[k]);
        if k == tails.len() {
            tails.push(i);
        } else {
            tails[k] = i;
        }
    }
    let mut run = Vec::with_capacity(tails.len());
    let mut next = tails.last().copied();
    while let Some(i) = next {
        run.push(i);
        next = previous[i];
    }
    run.reverse();
    run
}

/// Give `parent`, whose live children are `live`, the buffer's `children`:
/// walking them, each one [`staying`] does not keep is moved or created right
/// after the child before it in the buffer, or first when none is. Every child
/// that stays comes after that first one, so slot 0 puts none out of order, and
/// no op names a child the source does not show. The slot a move or create
/// takes is counted among the parent's other live children, as
/// `move_block_in_tx` and `create_block_in_tx` count it, over the list as the
/// walk has left it.
async fn place_children(
    tx: &mut CommandTx,
    save: &mut Save<'_>,
    parent: &str,
    live: Vec<String>,
    children: &[usize],
    buffer: &Buffer,
) -> Result<(), AppError> {
    let ids: Vec<Option<String>> = children.iter().map(|&row| save.ids[row].clone()).collect();
    let stays = staying(&live, &ids);
    let mut current = live;
    let mut previous: Option<String> = None;
    for (&row, stays) in children.iter().zip(stays) {
        if stays {
            previous.clone_from(&save.ids[row]);
            continue;
        }
        let moving = save.ids[row].clone();
        current.retain(|id| Some(id) != moving.as_ref());
        let index = previous.as_ref().map_or(0, |previous| {
            1 + current
                .iter()
                .position(|id| id == previous)
                .expect("the child before is under the parent")
        });
        let slot = i64::try_from(index).unwrap_or(i64::MAX);
        let id = match moving {
            Some(id) => {
                move_block_in_tx(
                    tx,
                    save.materializer.loro_state(),
                    save.device_id,
                    id.clone(),
                    Some(parent.to_owned()),
                    slot,
                )
                .await?;
                save.report.moved += 1;
                crate::commands::ensure_batch_within_cap("ops", tx.pending_len())?;
                id
            }
            None => create_child(tx, save, parent, slot, &buffer.blocks[row]).await?,
        };
        current.insert(index, id.clone());
        save.ids[row] = Some(id.clone());
        previous = Some(id);
    }
    Ok(())
}

/// Create `block` under `parent` at `slot`, as a paste creates it. Returns its
/// id.
async fn create_child(
    tx: &mut CommandTx,
    save: &mut Save<'_>,
    parent: &str,
    slot: i64,
    block: &import::ParsedBlock,
) -> Result<String, AppError> {
    let created = Box::pin(create_parsed_blocks(
        tx,
        save.materializer,
        save.device_id,
        Some(parent.to_owned()),
        Some(slot),
        std::slice::from_ref(block),
        PropertyWrite::Edit,
    ))
    .await?;
    save.report.created += 1;
    Ok(created[0].id.clone().into_string())
}

/// A paired block's property changes: the last line for a key wins.
#[derive(Default)]
struct PropertyChanges {
    set: Vec<(String, String)>,
    deleted: Vec<String>,
    /// `Some` when the task state changed: the new one, or `None` to clear it.
    todo_state: Option<Option<String>>,
}

impl PropertyChanges {
    fn between(before: &import::ParsedBlock, after: &import::ParsedBlock) -> Self {
        let map = |block: &import::ParsedBlock| -> BTreeMap<String, String> {
            block.properties.iter().cloned().collect()
        };
        let (old, new) = (map(before), map(after));
        let mut changes = Self::default();
        for (key, value) in &new {
            if old.get(key) == Some(value) {
                continue;
            }
            if key == "todo_state" {
                changes.todo_state = Some(Some(value.clone()));
            } else {
                changes.set.push((key.clone(), value.clone()));
            }
        }
        for key in old.keys().filter(|key| !new.contains_key(*key)) {
            if key == "todo_state" {
                changes.todo_state = Some(None);
            } else {
                changes.deleted.push(key.clone());
            }
        }
        changes
    }
}

/// Write each paired block's changes: its content, when the buffer changed it
/// and it differs from what is stored once its names are ids, then its removed
/// properties, its set ones, and its task state last, which may copy the block
/// into its next occurrence.
async fn write_changes(
    tx: &mut CommandTx,
    save: &mut Save<'_>,
    data: &PageExportData,
    base: &Base,
    buffer: &Buffer,
) -> Result<(), AppError> {
    let stored = stored_contents(data);
    let changes: Vec<(usize, &str, PropertyChanges)> = buffer
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(row, block)| {
            let slot = buffer.base[row]?;
            let changes = PropertyChanges::between(&base.blocks[slot], block);
            Some((row, base.ids[slot].as_str(), changes))
        })
        .collect();
    let tasks: Vec<BlockId> = changes
        .iter()
        .filter(|(.., changes)| changes.todo_state.is_some())
        .map(|(_, id, _)| BlockId::from_trusted(id))
        .collect();
    let priors = if tasks.is_empty() {
        HashMap::new()
    } else {
        resolve_prior_task_states_batch(tx, &tasks).await?
    };
    for (row, id, changes) in changes {
        let content = &buffer.blocks[row].content;
        if buffer.edited[row] && stored.get(id) != Some(&content.as_str()) {
            let loro = save.materializer.loro_state();
            edit_block_in_tx(tx, loro, save.device_id, id.to_owned(), content.clone()).await?;
            save.report.edited += 1;
        }
        let prior = priors.get(id).cloned().unwrap_or_default();
        Box::pin(write_properties(tx, save, id, changes, &prior)).await?;
        crate::commands::ensure_batch_within_cap("ops", tx.pending_len())?;
    }
    Ok(())
}

/// Write one block's property changes; its task state as the checkbox writes
/// it, from `prior`.
async fn write_properties(
    tx: &mut CommandTx,
    save: &mut Save<'_>,
    id: &str,
    changes: PropertyChanges,
    prior: &PriorTaskState,
) -> Result<(), AppError> {
    let loro = save.materializer.loro_state();
    for key in &changes.deleted {
        let op = delete_property_in_tx(tx, loro, save.device_id, id, key).await?;
        tx.enqueue_background(op);
        save.report.properties_deleted += 1;
    }
    if !changes.set.is_empty() {
        apply_block_properties(
            tx,
            save.materializer,
            save.device_id,
            id,
            &changes.set,
            PropertyWrite::Edit,
        )
        .await?;
        save.report.properties_set += u32::try_from(changes.set.len()).unwrap_or(u32::MAX);
    }
    if let Some(state) = changes.todo_state {
        let counter = if state.is_some() {
            &mut save.report.properties_set
        } else {
            &mut save.report.properties_deleted
        };
        *counter += 1;
        set_todo_state_in_tx(tx, loro, save.device_id, id.to_owned(), prior, state).await?;
    }
    Ok(())
}

/// Delete the page's blocks the buffer no longer holds, each topmost one with
/// the blocks under it. Every block the buffer holds has moved out from under
/// them by now, so what goes with them is what the buffer dropped, unless one
/// holds a nested page, which the save refuses to delete.
async fn delete_dropped(
    tx: &mut CommandTx,
    save: &mut Save<'_>,
    base: &Base,
    buffer: &Buffer,
) -> Result<Vec<DeleteInTx>, AppError> {
    let mut kept = vec![false; base.ids.len()];
    for &slot in buffer.base.iter().flatten() {
        kept[slot] = true;
    }
    let mut deletes = Vec::new();
    for (slot, id) in base.ids.iter().enumerate() {
        if kept[slot] {
            continue;
        }
        save.report.deleted += 1;
        if base.parents[slot].is_some_and(|parent| !kept[parent]) {
            continue;
        }
        let loro = save.materializer.loro_state();
        let deleted = delete_block_in_tx(tx, loro, save.device_id, id.clone()).await?;
        if let Some(page) = deleted.affected_page_ids.first() {
            return Err(AppError::validation(format!(
                "block '{id}' holds the page '{page}', which deleting the block would delete"
            )));
        }
        crate::commands::ensure_batch_within_cap("ops", tx.pending_len())?;
        deletes.push(deleted);
    }
    Ok(deletes)
}

/// Tauri command: save a page edited as its source buffer. Delegates to
/// [`apply_page_source_inner`].
#[tauri::command]
#[specta::specta]
pub async fn apply_page_source(
    ctx: State<'_, WriteCtx>,
    page_id: PageId,
    source: String,
    base_source: String,
    force: bool,
    merge: bool,
) -> Result<WithOps<PageSourceReport>, AppError> {
    capture_op_refs(apply_page_source_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        page_id.as_str(),
        source,
        base_source,
        force,
        merge,
    ))
    .await
    .map_err(sanitize_internal_error)
}

#[path = "markdown_source_merge.rs"]
mod merge;

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(ToString::to_string).collect()
    }

    fn children(values: &[Option<&str>]) -> Vec<Option<String>> {
        values
            .iter()
            .map(|id| id.map(ToString::to_string))
            .collect()
    }

    #[test]
    fn longest_increasing_picks_a_longest_run() {
        assert_eq!(longest_increasing(&[]), Vec::<usize>::new());
        assert_eq!(longest_increasing(&[2, 0, 1]), vec![1, 2]);
        assert_eq!(longest_increasing(&[3, 1, 4, 0, 5, 2, 6]), vec![1, 2, 4, 6]);
    }

    /// A nested page decides nothing: a new first child and a dropped one keep
    /// every shown child, and a swap across it moves only one of the two.
    #[test]
    fn a_hidden_child_decides_nothing() {
        let live = ids(&["A", "P", "B", "C"]);
        assert_eq!(
            staying(&live, &children(&[None, Some("A"), Some("B"), Some("C")])),
            [false, true, true, true],
            "a new first child"
        );
        assert_eq!(
            staying(&live, &children(&[Some("B"), Some("C")])),
            [true, true],
            "A dropped"
        );
        assert_eq!(
            staying(&live, &children(&[Some("B"), Some("A"), Some("C")])),
            [false, true, true],
            "A and B swapped across P"
        );
    }

    /// A child from elsewhere, and a new one, never stay.
    #[test]
    fn only_a_child_already_there_stays() {
        let live = ids(&["A", "GONE"]);
        assert_eq!(
            staying(&live, &children(&[Some("X"), Some("A"), None])),
            [false, true, false]
        );
    }
}
