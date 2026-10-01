//! Saving a page edited as its source buffer (#5140): [`apply_page_source`].
//!
//! The save parses two buffers: the page's current source (T0), rendered as
//! `get_page_source` renders it and read as the text `get_page_buffer` gives,
//! and the text the user edited (T1). Blocks pair by the id beside the line
//! each starts on, and only what differs between the two parses is written,
//! compared before any name is resolved. So an unchanged buffer writes
//! nothing, and a name the block already held keeps the meaning its render
//! gave it.

use std::collections::hash_map::Entry;
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
    PriorTaskState, delete_repeat_bounds_in_tx, resolve_prior_task_states_batch,
    set_todo_state_in_tx,
};

/// How [`apply_page_source_inner`] reads the buffer.
#[derive(Debug, Clone)]
pub struct SourceSaveFlags {
    /// Fold the changes the page took since `base_source` into the buffer
    /// instead of refusing the save as stale.
    pub merge: bool,
    /// The id each line of the buffer carries, one entry per line
    /// (`get_page_buffer_inner`, #5160 A).
    pub line_ids: Vec<Option<String>>,
}

/// What [`apply_page_source`] wrote.
#[derive(Debug, Clone, Default, Serialize, Type)]
pub struct PageSourceReport {
    /// Blocks created from the buffer: new bullets, and lines carrying a copied
    /// or foreign id (#5160 D15).
    pub created: u32,
    /// Blocks of the page whose content was rewritten.
    pub edited: u32,
    /// Blocks moved to another parent or slot.
    pub moved: u32,
    /// Blocks of the page the buffer no longer holds, each deleted with the
    /// blocks under it.
    pub deleted: u32,
    /// Properties set on the page and on blocks it already had, task state
    /// included.
    pub properties_set: u32,
    /// Properties removed from the page and from blocks it already had.
    pub properties_deleted: u32,
    /// The pages and tags created for names the buffer newly wrote.
    pub names_created: Vec<BlockRow>,
    /// What the save could not keep as written.
    pub warnings: Vec<String>,
}

/// Save `source`, the text of the page's source buffer as the user edited it,
/// over the page (#5140), as one transaction and so one undo. `flags.line_ids`
/// holds the id each of its lines carries (#5160 A). `base_source` is the
/// source the edit started from, `get_page_buffer`'s `source`: when it is not
/// the page's source now, the save is refused as stale, unless `flags.merge`:
/// then the changes the page took since are folded into the buffer first
/// (`merge::merge_outlines`), and a block both sides changed differently is
/// kept twice, the buffer's version as a new block directly before the page's,
/// with a warning.
///
/// A block is the one whose id the line it starts on carries; no `^ID` in the
/// text is read. A paired block gets the content, properties, parent and slot
/// the buffer gives it, each written only when it differs from the page's
/// source; a bullet whose line carries no id is created; a block of the page
/// the buffer no longer holds is deleted. A copy is a new block and a cut is a
/// move (D15): an id on more than one line stays with the first, and one that
/// names no block of the page is a new block, each with a warning naming the
/// line. A fence left open ends before the next line that carries an id, with
/// a warning (D5). The page's own source is read the same way, so its own text
/// saves as nothing.
///
/// A name typed into a block is resolved in the page's space as an import
/// resolves it, creating the page or tag no name there matches. A checkbox
/// does what a click on it does: the #5074 stamps and, on the edge into DONE,
/// the next occurrence.
///
/// A property key names the reserved key or definition it folds to (#5160
/// D13), a `key::` line with no value deletes the property (P7), and a ref
/// value is a block id or a page title in the space (D11).
///
/// The page's own properties, aliases and tags are the front matter the
/// buffer opens with (#5160 S8), written as their drawers write them: a key
/// the front matter no longer holds is deleted, and a tag name no tag of the
/// space has is created.
///
/// # Errors
///
/// - [`AppError::Ulid`] — `page_id` is not a ULID
/// - [`AppError::NotFound`] — no live page has that id
/// - [`AppError::Validation`] — `page_id` is not a page; with code
///   [`ValidationCode::RequiresRefresh`] when `base_source` is not the page's
///   source and `flags.merge` is false; the page's source does not read back as
///   its blocks (a carriage return in a block's text); `flags.line_ids` does
///   not hold one entry per line of `source`; a property line sets a value its
///   definition refuses, named in the message; a front matter line holds no
///   page property, or a value its definition refuses, named by its line; a
///   block the save would delete holds a nested page; a block would be nested
///   past `MAX_BLOCK_DEPTH`; or the save would append more ops than one undo
///   reverts. A refusal at a block of the buffer starts with its line,
///   `line N: ` (#5160 X3).
#[instrument(skip(pool, device_id, materializer, source, base_source), err)]
pub async fn apply_page_source_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: &str,
    source: String,
    base_source: String,
    flags: SourceSaveFlags,
) -> Result<PageSourceReport, AppError> {
    let page_id = BlockId::from_string(page_id)?;
    let mut tx = CommandTx::begin_immediate(pool, "apply_page_source").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let data = load_page_export_data(&mut tx, page_id.as_str(), PageRead::Source).await?;
    let (base, stale) = read_base(&data, &base_source, flags.merge)?;
    let mut lines = PropertyLines::load(&mut tx, PropertyWrite::Edit).await?;
    let mut warnings = Vec::new();
    let (blocks, front) = read_buffer(
        &source,
        &flags.line_ids,
        &base_source,
        &base,
        stale,
        &mut lines,
        &mut warnings,
    )?;
    let mut buffer = pair_blocks(&base, blocks)?;
    resolve_value_refs(&mut tx, &page_id, &mut lines, &buffer, &front).await?;
    // Boxed for the reason `duplicate_block_inner` gives.
    let (mut tx, mut names_created) = Box::pin(resolve_buffer_names(
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
        lines: &lines,
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
    let (mut tx, tags) = Box::pin(front_matter::write_front_matter(
        tx,
        &mut save,
        &data,
        &base.front_matter,
        front,
        &mut warnings,
    ))
    .await?;
    names_created.extend(tags);
    let deletes = Box::pin(delete_dropped(&mut tx, &mut save, &base, &buffer)).await?;
    tx.commit_and_dispatch(materializer).await?;
    dispatch_deletes(pool, materializer, &deletes).await;
    save.report.names_created = names_created;
    save.report.warnings = warnings;
    Ok(save.report)
}

/// Resolve in the page's space the ref values the buffer's blocks and its
/// front matter write.
async fn resolve_value_refs(
    tx: &mut CommandTx,
    page_id: &BlockId,
    lines: &mut PropertyLines,
    buffer: &Buffer,
    front: &front_matter::FrontMatterEdit,
) -> Result<(), AppError> {
    let space = agaric_store::space::resolve_block_space(&mut ***tx, page_id).await?;
    let space = space.as_ref().map(agaric_store::space::SpaceId::as_str);
    let values = buffer.blocks.iter().flat_map(|block| &block.properties);
    lines
        .resolve_refs(tx, space, values.chain(front.values()))
        .await
}

/// The post-commit fan-out `delete_block_inner` runs, per delete.
async fn dispatch_deletes(pool: &SqlitePool, materializer: &Materializer, deletes: &[DeleteInTx]) {
    for deleted in deletes {
        crate::materializer::dispatch_delete_descendants(
            &deleted.op_record,
            &deleted.effects.deleted_cohort,
            deleted.effects.delete_space_id.as_ref(),
            materializer.loro_state(),
        )
        .await;
        crate::materializer::remove_deleted_cohort_fts(pool, &deleted.effects.deleted_cohort).await;
    }
}

/// The page's current source as the save reads it: the ids of the blocks the
/// render holds, in order, and its parse (T0), block for block, with each
/// block's parent among them, and the front matter it opens with.
struct Base {
    ids: Vec<String>,
    blocks: Vec<import::ParsedBlock>,
    parents: Vec<Option<usize>>,
    front_matter: front_matter::FrontMatter,
}

/// The page's source, read as its text is ([`read_own_source`]), and whether
/// it is stale: not `base_source`, which is refused unless `merge`. Refused
/// too when it does not read back as the blocks it renders: text the grammar
/// cannot carry, such as a carriage return, reads back as other content or
/// another block, and saving over it would rewrite the block.
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
    let parsed = read_own_source(&current);
    let front_matter = front_matter::FrontMatter::of(&parsed);
    let blocks = parsed.blocks;
    let unread = (0..blocks.len().max(ids.len())).find(|&i| {
        blocks.get(i).map(|block| block.block_anchor.as_deref())
            != ids.get(i).map(|id| Some(id.as_str()))
    });
    if let Some(at) = unread {
        let id = ids.get(at).or(ids.last()).map_or("", String::as_str);
        return Err(AppError::validation(format!(
            "block '{id}' holds text the page's source cannot carry, such as a carriage return"
        )));
    }
    Ok((
        Base {
            parents: outline_parents(&blocks),
            ids,
            blocks,
            front_matter,
        },
        stale,
    ))
}

/// `source`, a page's source as `get_page_source` renders it, read as the text
/// [`anchor_free`] makes of it, each block under the id the line it starts on
/// carries. The text cannot carry the few blocks its anchors keep apart, a
/// block's content ending in a blank line or leaving a fence open before its
/// property lines, so the save compares the buffer with this reading, not with
/// the anchored one: the page's own text writes nothing.
fn read_own_source(source: &str) -> import::ParseOutput {
    let (text, line_ids) = anchor_free(source);
    let mut parsed = import::parse_source_text(&text, &id_lines(&line_ids));
    for block in &mut parsed.blocks {
        block.block_anchor = block
            .line
            .and_then(|line| line_ids.get(line - 1))
            .cloned()
            .flatten();
    }
    parsed
}

/// The lines, counted from 1, that carry an id.
fn id_lines(line_ids: &[Option<String>]) -> HashSet<usize> {
    line_ids
        .iter()
        .enumerate()
        .filter_map(|(i, id)| id.is_some().then_some(i + 1))
        .collect()
}

/// The edited buffer (T1): its blocks, each one's parent among them, the base
/// block its id pairs it with, and whether a paired block's content differs
/// from its base block's, read before any name in it is resolved.
struct Buffer {
    blocks: Vec<import::ParsedBlock>,
    parents: Vec<Option<usize>>,
    base: Vec<Option<usize>>,
    edited: Vec<bool>,
}

/// The buffer's blocks, each under the id beside the line it starts on
/// ([`read_by_line`]), against the blocks of `base_source`, the source the
/// edit started from. Then, when the page changed since (`stale`), its changes
/// are folded in. A property key is read as the one `lines` fold it to (#5160
/// D13) before anything is compared, unless its block held it as written in
/// the source the edit started from, and a `key::` line for a key it did not
/// hold is text (P7). The front matter is read against the one the edit
/// started from, as the page's properties.
fn read_buffer(
    text: &str,
    line_ids: &[Option<String>],
    base_source: &str,
    base: &Base,
    stale: bool,
    lines: &mut PropertyLines,
    warnings: &mut Vec<String>,
) -> Result<(Vec<import::ParsedBlock>, front_matter::FrontMatterEdit), AppError> {
    let older = stale.then(|| read_own_source(base_source));
    let from = older
        .as_ref()
        .map_or_else(|| base.front_matter.clone(), front_matter::FrontMatter::of);
    let older = older.map(|older| older.blocks);
    let edited_from = older.as_ref().unwrap_or(&base.blocks);
    let known: HashSet<&str> = edited_from
        .iter()
        .filter_map(|block| block.block_anchor.as_deref())
        .chain(base.ids.iter().map(String::as_str))
        .collect();
    let parsed = read_by_line(text, line_ids, &known, warnings)?;
    let front = front_matter::FrontMatterEdit::read(&parsed, from, lines)?;
    let mut blocks = parsed.blocks;
    lines.canonicalize(&mut blocks, edited_from);
    let blocks = match older {
        Some(older) => merge::merge_outlines(older, &base.blocks, blocks, warnings),
        None => blocks,
    };
    Ok((blocks, front))
}

/// `text` read into blocks, each under the id `line_ids` gives the line it
/// starts on (#5160 A); `line_ids` must hold one entry per line. A copy is a
/// new block and a cut is a move (D15): an id on more than one line stays with
/// the first, and one that names no block `known` holds, the page's, is read
/// as none, each with a warning naming the line.
fn read_by_line(
    text: &str,
    line_ids: &[Option<String>],
    known: &HashSet<&str>,
    warnings: &mut Vec<String>,
) -> Result<import::ParseOutput, AppError> {
    // Counted as the parser counts them, a lone carriage return a line end.
    let lines = text.replace("\r\n", "\n").split(['\n', '\r']).count();
    if line_ids.len() != lines {
        return Err(AppError::validation(format!(
            "line_ids holds {} entries for the {lines} lines of the text",
            line_ids.len()
        )));
    }
    let mut parsed = import::parse_source_text(text, &id_lines(line_ids));
    warnings.append(&mut parsed.warnings);
    let mut first: HashMap<String, usize> = HashMap::new();
    for block in &mut parsed.blocks {
        let Some(line) = block.line else {
            continue;
        };
        let Some(Some(carried)) = line_ids.get(line - 1) else {
            continue;
        };
        match BlockId::from_string(carried).map(BlockId::into_string) {
            Ok(id) if known.contains(id.as_str()) => match first.entry(id) {
                Entry::Occupied(at) => warnings.push(format!(
                    "line {line}: a copy of the block on line {}; saved as a new block",
                    at.get()
                )),
                Entry::Vacant(slot) => {
                    block.block_anchor = Some(slot.key().clone());
                    slot.insert(line);
                }
            },
            _ => warnings.push(format!(
                "line {line}: not a block of this page; saved as a new block"
            )),
        }
    }
    Ok(parsed)
}

/// `blocks` paired with the base by the id each carries. [`read_by_line`]
/// gives a block of the page to one block at most, and the merge keeps no
/// other id, so each id names a block of the page's source, once. One that
/// does not refuses the save rather than aborting the app.
fn pair_blocks(base: &Base, blocks: Vec<import::ParsedBlock>) -> Result<Buffer, AppError> {
    let slots: HashMap<&str, usize> = base
        .ids
        .iter()
        .enumerate()
        .map(|(slot, id)| (id.as_str(), slot))
        .collect();
    let paired = blocks
        .iter()
        .map(|block| {
            block.block_anchor.as_deref().map_or(Ok(None), |id| {
                slots.get(id).copied().map(Some).ok_or_else(|| {
                    AppError::Internal(format!("buffer block {id} is not a block of the page"))
                })
            })
        })
        .collect::<Result<Vec<Option<usize>>, AppError>>()?;
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

/// `err` naming the buffer line it was refused at, `line N: ` before its
/// message (#5160 X3), when it is a refusal and the block has a line.
pub(super) fn at_line(line: Option<usize>, err: AppError) -> AppError {
    match (line, err) {
        (Some(line), AppError::Validation { code, message }) => AppError::Validation {
            code,
            message: format!("line {line}: {message}"),
        },
        (_, err) => err,
    }
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

/// The page-link bodies, inline-query page names and tag names a block
/// writes, as the importer collects them.
#[derive(Default)]
struct Names {
    links: BTreeSet<String>,
    queries: BTreeSet<String>,
    tags: BTreeSet<String>,
}

impl Names {
    fn of(block: &import::ParsedBlock) -> Self {
        let one = std::slice::from_ref(block);
        Self {
            links: collect_inbound_page_link_bodies(one).into_iter().collect(),
            queries: query_page_names(one).into_iter().collect(),
            tags: collect_inbound_tag_names(one)
                .into_iter()
                .chain(query_tag_names(one))
                .collect(),
        }
    }

    /// The names in `self` that `other` holds, when `held`, or that it does
    /// not.
    fn split(&self, other: &Self, held: bool) -> Self {
        let pick = |mine: &BTreeSet<String>, theirs: &BTreeSet<String>| {
            mine.iter()
                .filter(|name| theirs.contains(*name) == held)
                .cloned()
                .collect()
        };
        Self {
            links: pick(&self.links, &other.links),
            queries: pick(&self.queries, &other.queries),
            tags: pick(&self.tags, &other.tags),
        }
    }
}

/// A block the save writes names for: its row in the buffer, what the names
/// it already held map to, and the names new to it.
struct NamePlan {
    row: usize,
    links: PageLinks,
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
        // A query names no page here: source mode writes a stored query as
        // its `v2:` payload, ids and all, so only links and tags were rendered
        // by name.
        let (links, tags) = if humanised {
            let snapshot = &data.name_snapshot;
            (
                snapshot.page_links(kept.links),
                snapshot.tags(kept.tags.into_iter().collect()),
            )
        } else {
            (PageLinks::default(), HashMap::new())
        };
        let new = names.split(&held, false);
        new_names.links.extend(new.links.iter().cloned());
        new_names.queries.extend(new.queries.iter().cloned());
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
    // A label equal to its page's title is not stored (#5160 D9): the page's
    // rendered titles cover the names a block held, the pass's the new ones.
    let mut titles = data.page_titles.clone();
    titles.extend(resolved.titles);
    for mut plan in plans {
        plan.links
            .extend_from(&resolved.links, &plan.new.links, &plan.new.queries);
        plan.tags.extend(
            plan.new
                .tags
                .iter()
                .filter_map(|n| Some((n.clone(), resolved.tags.get(n)?.clone()))),
        );
        let block = &mut buffer.blocks[plan.row];
        block.content = rewrite_block_content_for_import(block, &plan.links, &titles, &plan.tags);
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

/// What [`resolve_new_names`] resolved: each link body's reading and each
/// name's id, and the pages and tags it created.
#[derive(Default)]
struct ResolvedNames {
    links: PageLinks,
    /// Each linked page's title by id.
    titles: HashMap<String, String>,
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
    if names.links.is_empty() && names.queries.is_empty() && names.tags.is_empty() {
        return Ok((tx, ResolvedNames::default()));
    }
    let Some(space) = agaric_store::space::resolve_block_space(&mut **tx, &page.id).await? else {
        return Ok((tx, ResolvedNames::default()));
    };
    let mut ctx = NameCtx {
        materializer,
        device_id,
        space_id: space.as_str(),
        file_page: None,
        warnings,
        created: Vec::new(),
    };
    let bodies = names.links.into_iter().collect();
    let queries = names.queries.into_iter().collect();
    let (tx, links) = resolve_page_refs(&mut ctx, tx, bodies, queries).await?;
    warn_dropped_labels(ctx.warnings, links.dropped_labels);
    let (tx, _, tags, _) =
        resolve_tag_names(&mut ctx, tx, names.tags.into_iter().collect()).await?;
    Ok((
        tx,
        ResolvedNames {
            links: links.page_links,
            titles: links.titles,
            tags,
            created: ctx.created,
        },
    ))
}

/// The save's running state: each buffer block's id once it has one, and the
/// report so far.
struct Save<'a> {
    materializer: &'a Materializer,
    lines: &'a PropertyLines,
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
        if children.is_empty() {
            continue;
        }
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
        let slot = i64::try_from(index).expect("a Vec index fits in i64");
        let line = buffer.blocks[row].line;
        let at = |err| at_line(line, err);
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
                .await
                .map_err(at)?;
                save.report.moved += 1;
                crate::commands::ensure_batch_within_cap("ops", tx.pending_len()).map_err(at)?;
                id
            }
            None => create_child(tx, save, parent, slot, &buffer.blocks[row])
                .await
                .map_err(at)?,
        };
        current.insert(index, id.clone());
        save.ids[row] = Some(id.clone());
        previous = Some(id);
    }
    Ok(())
}

/// Create `block` under `parent` at `slot`, as a paste creates it. Returns its
/// id. A new block has no property for a `key::` line to clear.
async fn create_child(
    tx: &mut CommandTx,
    save: &mut Save<'_>,
    parent: &str,
    slot: i64,
    block: &import::ParsedBlock,
) -> Result<String, AppError> {
    let mut block = block.clone();
    block.properties.retain(|(_, value)| !value.is_empty());
    let created = Box::pin(create_parsed_blocks(
        tx,
        save.materializer,
        save.device_id,
        Some(parent.to_owned()),
        Some(slot),
        std::slice::from_ref(&block),
        save.lines,
    ))
    .await?;
    save.report.created += 1;
    Ok(created[0].id.clone().into_string())
}

/// A paired block's property changes: the last line for a key wins, and one
/// with no value (`key::`) deletes the property (#5160 P7).
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
        let (old, mut new) = (map(before), map(after));
        new.retain(|_, value| !value.is_empty());
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
        let import::ParsedBlock { content, line, .. } = &buffer.blocks[row];
        let at = |err| at_line(*line, err);
        if buffer.edited[row] && stored.get(id) != Some(&content.as_str()) {
            let loro = save.materializer.loro_state();
            edit_block_in_tx(tx, loro, save.device_id, id.to_owned(), content.clone())
                .await
                .map_err(at)?;
            save.report.edited += 1;
        }
        let prior = priors.get(id).cloned().unwrap_or_default();
        Box::pin(write_properties(tx, save, id, changes, &prior))
            .await
            .map_err(at)?;
        crate::commands::ensure_batch_within_cap("ops", tx.pending_len()).map_err(at)?;
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
    if changes.deleted.iter().any(|key| key == "repeat") {
        for _ in delete_repeat_bounds_in_tx(tx, loro, save.device_id, id).await? {
            save.report.properties_deleted += 1;
        }
    }
    let set = apply_block_properties(
        tx,
        save.materializer,
        save.device_id,
        id,
        &changes.set,
        save.lines,
    )
    .await?;
    save.report.properties_set += set;
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
    merge: bool,
    line_ids: Vec<Option<String>>,
) -> Result<WithOps<PageSourceReport>, AppError> {
    capture_op_refs(apply_page_source_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        page_id.as_str(),
        source,
        base_source,
        SourceSaveFlags { merge, line_ids },
    ))
    .await
    .map_err(sanitize_internal_error)
}

#[path = "markdown_source_merge.rs"]
mod merge;

#[path = "markdown_source_front_matter.rs"]
mod front_matter;

#[cfg(test)]
mod tests {
    use agaric_engine::import::line_soup::arb_document;
    use proptest::prelude::*;

    use super::super::source_tests::{PAGE, page_data, row, text_property};
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

    /// `blocks` as a save stores them on an empty page, with their ids: each a
    /// new block under the parent [`outline_parents`] gives it. Of its last-wins
    /// properties, the task state goes to its column, `listStyle` to the list
    /// marker and the rest to property rows, as the save routes the keys the
    /// line soup can write.
    fn stored(blocks: &[import::ParsedBlock]) -> (PageExportData, Vec<String>) {
        let ids: Vec<String> = (0..blocks.len()).map(|i| format!("01J{i:023}")).collect();
        let mut data = page_data(Vec::new());
        let mut slots: HashMap<Option<usize>, i64> = HashMap::new();
        for ((block, parent), id) in blocks.iter().zip(outline_parents(blocks)).zip(&ids) {
            let slot = slots.entry(parent).or_insert(0);
            *slot += 1;
            let parent_id = parent.map_or(PAGE, |parent| ids[parent].as_str());
            let mut stored = row(id, parent_id, *slot, &block.content);
            let mut rows = Vec::new();
            let properties: BTreeMap<&str, &str> = block
                .properties
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect();
            for (key, value) in properties {
                match key {
                    "todo_state" => stored.todo_state = Some(value.to_string()),
                    "listStyle" => {
                        data.list_styles.insert(id.clone(), value.to_string());
                    }
                    _ => rows.push(text_property(key, value)),
                }
            }
            data.descendant_properties.insert(id.clone(), rows);
            data.descendants.push(stored);
        }
        (data, ids)
    }

    /// A block's parent, content and last-wins properties.
    type Shape<'a> = (Option<usize>, &'a str, BTreeMap<&'a str, &'a str>);

    /// Each block's [`Shape`].
    fn tree(blocks: &[import::ParsedBlock]) -> Vec<Shape<'_>> {
        blocks
            .iter()
            .zip(outline_parents(blocks))
            .map(|(block, parent)| {
                let properties = block
                    .properties
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str()))
                    .collect();
                (parent, block.content.as_str(), properties)
            })
            .collect()
    }

    /// Whether the text carries `block` once saved: not when its content ends
    /// in a blank line or leaves a fence open before its property lines, which
    /// only an anchor kept apart ([`read_own_source`]).
    fn text_carries(block: &import::ParsedBlock) -> bool {
        let last = |key: &str| {
            block
                .properties
                .iter()
                .rev()
                .find(|(k, _)| k == key)
                .map(|(_, value)| value.as_str())
        };
        let list_marker = match last("listStyle") {
            Some("bullet") => "- ",
            Some(_) => "1. ",
            None => "",
        };
        let task_marker = last("todo_state")
            .and_then(import::task_marker_for)
            .map(|c| format!("[{c}] "))
            .unwrap_or_default();
        let open = super::super::push_block_bullet(
            &mut String::new(),
            "",
            list_marker,
            &task_marker,
            &block.content,
            super::super::RenderMode::Source,
        )
        .open;
        let ends_blank = block
            .content
            .rsplit_once('\n')
            .is_some_and(|(_, last)| last.trim().is_empty());
        let property_lines = block.properties.iter().any(|(key, _)| key != "listStyle");
        !(ends_blank || (open && property_lines))
    }

    proptest! {
        /// #5160 — whatever a hand-written buffer reads as renders back to the
        /// same tree, content and properties, each block under its own id, once
        /// stored as [`stored`] models a save storing it and read back as its
        /// text: read ∘ render ∘ model ∘ read, with the model standing in for
        /// `apply_page_source`. Typed, no line carries an id; a buffer holding
        /// a block the text cannot carry ([`text_carries`]) is skipped.
        #[test]
        fn a_saved_buffer_renders_back_to_what_was_saved(text in arb_document()) {
            let saved = import::parse_source_text(&text, &HashSet::new()).blocks;
            prop_assume!(saved.iter().all(text_carries));
            let (data, ids) = stored(&saved);
            let md = render_page_source(&data);
            let again = read_own_source(&md).blocks;
            prop_assert_eq!(tree(&again), tree(&saved), "text: {:?}\nmd:\n{}", text, md);
            let anchors: Vec<Option<&str>> =
                again.iter().map(|block| block.block_anchor.as_deref()).collect();
            let ids: Vec<Option<&str>> = ids.iter().map(|id| Some(id.as_str())).collect();
            prop_assert_eq!(anchors, ids, "text: {:?}\nmd:\n{}", text, md);
        }
    }
}
