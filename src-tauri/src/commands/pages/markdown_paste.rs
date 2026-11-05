//! Writing parsed Markdown blocks into a page for paste, append and duplicate:
//! [`PasteInput`], [`PasteSplice`], [`copy_page_blocks_in_tx`],
//! [`append_markdown_in_tx`], the `*_resolving_names` writers,
//! [`resolve_pasted_names`] and [`create_parsed_blocks`].

use super::*;

/// Copy `source_page_id`'s blocks under `dest_page_id` as Duplicate copies a
/// subtree (#5395): rendered as a Document buffer and parsed back, so the copy
/// carries content with its raw refs, list markers, task states, dates and
/// custom properties, nesting included; a nested page is not copied. `expand`
/// rewrites each block's content before it is written. Every op rides the
/// caller's transaction, so the copy lands or rolls back with whatever the
/// caller writes, and one undo reverts both. Returns the created rows,
/// depth-first.
///
/// The copy refuses BEFORE its first insert, as `Ok(Err(why))`, when a
/// copied value doesn't read back from the buffer's grammar (a carriage return
/// in the text) or when the copy would append more ops than one undo
/// reverts: the caller's transaction holds nothing of the copy then, so the
/// caller may go on without it. The op count never falls short for the fresh
/// blocks the copy creates: the block, each property, and at most one stamp a
/// task state writes (`created_at` or `completed_at`).
///
/// # Errors
///
/// - [`AppError::NotFound`] — `source_page_id` is not a live page
/// - [`AppError::Validation`] — a copied block would be nested past
///   `MAX_BLOCK_DEPTH`
pub(crate) async fn copy_page_blocks_in_tx(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    source_page_id: &str,
    dest_page_id: &str,
    expand: impl Fn(&str) -> String,
) -> Result<Result<Vec<BlockRow>, String>, AppError> {
    let data = load_page_export_data(tx, source_page_id, PageRead::Duplicate).await?;
    let mut source = String::new();
    let ids: Vec<String> =
        render_block_tree(&mut source, source_page_id, &data, RenderMode::Document)
            .into_iter()
            .map(|(id, _)| id)
            .collect();
    if ids.is_empty() {
        return Ok(Ok(Vec::new()));
    }
    let mut parsed = import::parse_document_outline(&source);
    let anchors = parsed.blocks.iter().map(|b| b.block_anchor.as_deref());
    if !anchors.eq(ids.iter().map(|id| Some(id.as_str()))) {
        return Ok(Err(format!(
            "page '{source_page_id}' holds a value that cannot be copied"
        )));
    }
    let ops: usize = parsed
        .blocks
        .iter()
        .map(|b| 1 + b.properties.len() + usize::from(parsed_todo_state(b).is_some()))
        .sum();
    if let Err(e) = crate::commands::ensure_batch_within_cap("ops", tx.pending_len() + ops) {
        return Ok(Err(e.to_string()));
    }
    for block in &mut parsed.blocks {
        block.content = expand(&block.content);
    }
    let dest = BlockId::from_trusted(dest_page_id);
    let lines = PropertyLines::load_for_block(tx, &dest, PropertyWrite::Copy).await?;
    Box::pin(create_parsed_blocks(
        tx,
        materializer,
        device_id,
        Some(dest_page_id.to_owned()),
        None,
        &parsed.blocks,
        &lines,
    ))
    .await
    .map(Ok)
}

/// What a paste carries: clipboard text, or blocks already split.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PasteInput {
    Text { text: String },
    Blocks { blocks: Vec<PastedBlock> },
}

/// One pasted block: its content verbatim and its depth under the paste.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct PastedBlock {
    pub content: String,
    pub depth: u32,
}

impl PasteInput {
    /// The blocks the input holds, and the warnings of reading them. After
    /// text (#5160 D4) the first of an HTML paste's blocks is the text it was
    /// pasted as, so its `- [ ] ` checkbox stays text as a plain item's `- `
    /// does.
    pub(super) fn into_blocks(self, after_text: bool) -> (Vec<import::ParsedBlock>, Vec<String>) {
        match self {
            Self::Text { text } => {
                let read = import::read_pasted_text(&text);
                (read.blocks, read.warnings)
            }
            Self::Blocks { blocks } => {
                let blocks = blocks.into_iter().enumerate().map(|(at, block)| {
                    let depth = block.depth as usize;
                    if at == 0 && after_text {
                        import::verbatim_block(block.content, depth)
                    } else {
                        import::pasted_block(block.content, depth)
                    }
                });
                (blocks.collect(), Vec::new())
            }
        }
    }
}

/// Reply of [`paste_blocks`], in the envelope [`CreatedBlocks`] uses.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PastedBlocks {
    /// The pages and tags the paste created, then the pasted blocks in
    /// document order.
    pub blocks: Vec<BlockRow>,
    /// Each property line the paste kept as text and each name it left as
    /// text, named (#5160 D11).
    pub warnings: Vec<String>,
}

/// A paste into the anchor block's text (#5160 D4): its content before and
/// after the cursor, with any selection already cut out.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct PasteSplice {
    pub before: String,
    pub after: String,
}

impl PasteSplice {
    /// Write the blocks [`Self::join`] joins to text, the first after `before`
    /// and the last before `after`, as they read among text, even one that is
    /// a whole block as pasted: each Obsidian note embed as the link
    /// ([`import::link_obsidian_note_embeds`]), and display math of one line
    /// as inline math ([`display_math_as_inline`]).
    pub(super) fn inline_joined_blocks(&self, blocks: &mut [import::ParsedBlock]) {
        let last = blocks.len().saturating_sub(1);
        for (at, block) in blocks.iter_mut().enumerate() {
            let joined =
                (at == 0 && !self.before.is_empty()) || (at == last && !self.after.is_empty());
            if !joined {
                continue;
            }
            if !block.is_code {
                block.content =
                    import::link_obsidian_note_embeds(&block.content, import::embed_names_note);
            }
            if let Some(math) =
                display_math_as_inline(&import::normalize_foreign_inline(&block.content))
            {
                block.content = math;
                block.is_code = false;
            }
        }
    }

    /// Join the pasted blocks into the anchor's text as a text editor does:
    /// the text before the cursor starts the first block, the text after it
    /// ends the last. After text, the first block joins as the text it was
    /// pasted as ([`pasted_as_text`]), so the anchor stays what it is. After
    /// a last block that is code, the text after the cursor is a block of its
    /// own at its depth, so the fence keeps its closing line.
    pub(super) fn join(self, blocks: &mut Vec<import::ParsedBlock>) {
        let Self { before, after } = self;
        if let Some(first) = blocks.first_mut()
            && !before.is_empty()
        {
            first.content = pasted_as_text(first, before.ends_with('\n'));
            first.properties.clear();
        }
        match blocks.last_mut() {
            Some(last) if last.is_code && !after.is_empty() => {
                let depth = last.depth;
                blocks.push(import::verbatim_block(after, depth));
            }
            Some(last) => last.content.push_str(&after),
            None => {}
        }
        if let Some(first) = blocks.first_mut() {
            first.content.insert_str(0, &before);
        }
    }
}

/// `content` as inline math when it is a `$$` block of one line of LaTeX, for
/// a block joined to text (#6033): mid-text a `$$` line opens no block, so the
/// editor would show both fences as text. A digit first is braced, as import
/// writes `\(2x\)`, since `$2` reads as currency. LaTeX of several lines stays
/// a `$$` block: joined onto one line, a `%` comment on any line but the last
/// would swallow the lines after it.
fn display_math_as_inline(content: &str) -> Option<String> {
    let latex = content.strip_prefix("$$\n")?.strip_suffix("\n$$")?.trim();
    if latex.is_empty() || latex.contains(['\n', '$']) {
        return None;
    }
    Some(if latex.starts_with(|c: char| c.is_ascii_digit()) {
        format!("${{{latex}}}$")
    } else {
        format!("${latex}$")
    })
}

/// `block` as the text it was pasted as, for a paste after text (#5160 D4):
/// the list marker and checkbox the parse read into properties back before
/// its text, and its other properties back as `key:: value` lines. Text that
/// `starts_line` is escaped as a block's text escapes a list marker or a
/// checkbox, so no marker in it is read back.
fn pasted_as_text(block: &import::ParsedBlock, starts_line: bool) -> String {
    // The last value of a key is the one a paste writes.
    let mut properties: Vec<(&str, &str)> = Vec::new();
    for (key, value) in &block.properties {
        properties.retain(|(k, _)| k != key);
        properties.push((key.as_str(), value.as_str()));
    }
    let mut marker = |key: &str, write: fn(&str) -> Option<String>| {
        let at = properties.iter().position(|(k, _)| *k == key)?;
        let marker = write(properties[at].1)?;
        properties.remove(at);
        Some(marker)
    };
    let list = marker(import::LIST_STYLE_KEY, |style| match style {
        import::LIST_STYLE_BULLET => Some("- ".to_owned()),
        import::LIST_STYLE_ORDERED => Some("1. ".to_owned()),
        _ => None,
    });
    let task = marker("todo_state", |state| {
        import::task_marker_for(state).map(|c| format!("[{c}] "))
    });
    let markers = format!("{}{}", list.unwrap_or_default(), task.unwrap_or_default());
    let mut text = if block.content.is_empty() {
        markers.trim_end().to_owned()
    } else {
        markers + &block.content
    };
    if starts_line
        && (import::needs_list_marker_escape(&text) || import::needs_task_marker_escape(&text))
    {
        text.insert(0, '\\');
    }
    for (key, value) in properties {
        text.push_str(&format!("\n{key}:: {value}"));
    }
    text
}

/// [`append_markdown_inner`] inside the caller's rollback-armed transaction,
/// for a caller that writes the parent in the same transaction (MCP
/// `capture`, #5396).
pub(crate) async fn append_markdown_in_tx(
    mut tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    parent_id: &BlockId,
    markdown: &str,
    index: Option<i64>,
) -> Result<(CommandTx, PastedBlocks), AppError> {
    let import::ParseOutput {
        mut blocks,
        warnings: read_warnings,
        ..
    } = import::read_pasted_text(markdown);
    if blocks.is_empty() {
        return Err(AppError::validation("there is nothing to append".into()));
    }
    let parent =
        agaric_engine::block_ops::fetch_live_block_in_tx(&mut tx, parent_id.as_str()).await?;
    let (mut tx, lines, warnings, mut created) = Box::pin(read_pasted_blocks(
        tx,
        materializer,
        device_id,
        &parent,
        &mut blocks,
    ))
    .await?;
    let appended = Box::pin(create_parsed_blocks(
        &mut tx,
        materializer,
        device_id,
        Some(parent_id.as_str().to_owned()),
        index,
        &blocks,
        &lines,
    ))
    .await?;
    created.extend(appended);
    Ok((
        tx,
        PastedBlocks {
            blocks: created,
            warnings: [read_warnings, warnings].concat(),
        },
    ))
}

/// A content block holding `content` appended under `parent_id` at the 0-based
/// `index`, or at the end with none, as one transaction (MCP `append_block`,
/// #5397). Its `[[Name]]` and `#name` are resolved in the parent's space as a
/// paste resolves them, creating the page or tag no name there matches; the
/// rest stays as written. Returns the block and the warnings the name pass
/// gave (a dropped anchor or label).
pub(crate) async fn append_block_resolving_names(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    parent_id: &BlockId,
    content: String,
    index: Option<i64>,
) -> Result<(BlockRow, Vec<String>), AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "append_block").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let (tx, block, warnings) = Box::pin(append_block_resolving_names_in_tx(
        tx,
        materializer,
        device_id,
        parent_id,
        content,
        index,
    ))
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok((block, warnings))
}

/// [`append_block_resolving_names`] inside the caller's rollback-armed
/// transaction (MCP `batch`, #5399).
pub(crate) async fn append_block_resolving_names_in_tx(
    tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    parent_id: &BlockId,
    content: String,
    index: Option<i64>,
) -> Result<(CommandTx, BlockRow, Vec<String>), AppError> {
    let (mut tx, content, warnings) = Box::pin(resolve_block_names(
        tx,
        materializer,
        device_id,
        parent_id,
        content,
    ))
    .await?;
    let (block, op) = create_block_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        "content".into(),
        content,
        Some(parent_id.as_str().to_owned()),
        index,
        None,
    )
    .await?;
    tx.enqueue_background(op);
    Ok((tx, block, warnings))
}

/// Replace `block_id`'s content, as one transaction (MCP
/// `update_block_content`, #5397). A content block's `[[Name]]` and `#name`
/// are resolved as [`append_block_resolving_names`] resolves them; a page's
/// title and a tag's name are kept as written. Returns the block and the
/// warnings the name pass gave.
pub(crate) async fn edit_block_resolving_names(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: &BlockId,
    content: String,
) -> Result<(BlockRow, Vec<String>), AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "edit_block").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let (tx, row, warnings) = Box::pin(edit_block_resolving_names_in_tx(
        tx,
        materializer,
        device_id,
        block_id,
        content,
    ))
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok((row, warnings))
}

/// [`edit_block_resolving_names`] inside the caller's rollback-armed
/// transaction (MCP `batch`, #5399).
pub(crate) async fn edit_block_resolving_names_in_tx(
    mut tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    block_id: &BlockId,
    content: String,
) -> Result<(CommandTx, BlockRow, Vec<String>), AppError> {
    // A missing or deleted block is left to `edit_block_in_tx`, which refuses
    // it as the edit always has.
    let is_content = matches!(
        agaric_engine::block_ops::fetch_live_block_in_tx(&mut tx, block_id.as_str()).await,
        Ok(block) if block.block_type == "content"
    );
    let (mut tx, content, warnings) = if is_content {
        Box::pin(resolve_block_names(
            tx,
            materializer,
            device_id,
            block_id,
            content,
        ))
        .await?
    } else {
        (tx, content, Vec::new())
    };
    let row = super::super::blocks::crud::edit_block_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        block_id.as_str().to_owned(),
        content,
    )
    .await?;
    Ok((tx, row, warnings))
}

/// `content`, one block's text, with the names it writes resolved in
/// `anchor`'s space by [`resolve_pasted_names`], and the warnings it gave.
async fn resolve_block_names(
    tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    anchor: &BlockId,
    content: String,
) -> Result<(CommandTx, String, Vec<String>), AppError> {
    let mut blocks = [import::verbatim_block(content, 0)];
    let mut warnings = Vec::new();
    let (tx, _created) = Box::pin(resolve_pasted_names(
        tx,
        materializer,
        device_id,
        anchor,
        &mut blocks,
        &mut warnings,
    ))
    .await?;
    let [block] = blocks;
    Ok((tx, block.content, warnings))
}

/// Read the property lines of `blocks` and resolve the names they write, in
/// `placement`'s space: the lines, the warnings naming what stayed text, and
/// the pages and tags created.
pub(super) async fn read_pasted_blocks(
    mut tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    placement: &BlockRow,
    blocks: &mut [import::ParsedBlock],
) -> Result<(CommandTx, PropertyLines, Vec<String>, Vec<BlockRow>), AppError> {
    let (lines, mut warnings) = read_pasted_properties(&mut tx, placement, blocks).await?;
    // Boxed for the reason `duplicate_block_inner` gives.
    let (tx, created) = Box::pin(resolve_pasted_names(
        tx,
        materializer,
        device_id,
        &placement.id,
        blocks,
        &mut warnings,
    ))
    .await?;
    Ok((tx, lines, warnings, created))
}

/// Read the property lines of `blocks`, pasted after `anchor`, in its space
/// (#5160 D11, D13): each key canonical, and each value a definition refuses
/// kept as text, named in the returned warnings.
async fn read_pasted_properties(
    tx: &mut CommandTx,
    anchor: &BlockRow,
    blocks: &mut [import::ParsedBlock],
) -> Result<(PropertyLines, Vec<String>), AppError> {
    let space = agaric_store::space::resolve_block_space(&mut ***tx, &anchor.id).await?;
    let mut lines = PropertyLines::load(
        tx,
        space.as_ref().map(SpaceId::as_str),
        PropertyWrite::Paste,
    )
    .await?;
    let values = blocks.iter().flat_map(|block| &block.properties);
    lines
        .resolve_refs(tx, space.as_ref().map(SpaceId::as_str), values)
        .await?;
    let mut warnings = Vec::new();
    lines.keep_refused_as_text(blocks, &mut warnings);
    Ok((lines, warnings))
}

/// Write the first of `blocks` into the anchor (#5160 D4): its content and
/// properties, with the task stamps its state change implies, and its children
/// after the anchor's own. Returns the anchor, then those children: one row for
/// each block it took.
pub(super) async fn splice_into_anchor(
    tx: &mut CommandTx,
    materializer: &Materializer,
    lines: &PropertyLines,
    device_id: &str,
    anchor_id: &BlockId,
    blocks: &[import::ParsedBlock],
) -> Result<Vec<BlockRow>, AppError> {
    let (first, rest) = blocks.split_first().expect("a paste holds a block");
    let id = anchor_id.as_str();
    let loro = materializer.loro_state();
    let prior = super::super::properties::resolve_prior_task_states_batch(
        tx,
        std::slice::from_ref(anchor_id),
    )
    .await?
    .remove(id)
    .unwrap_or_default();
    let anchor = super::super::blocks::crud::edit_block_in_tx(
        tx,
        loro,
        device_id,
        id.to_owned(),
        first.content.clone(),
    )
    .await?;
    apply_block_properties(tx, materializer, device_id, id, &first.properties, lines).await?;
    if let Some(state) = stamped_todo_state(first) {
        super::super::properties::write_todo_timestamp_transitions_in_tx(
            tx,
            loro,
            device_id,
            id,
            &prior,
            Some(state),
        )
        .await?;
    }
    crate::commands::ensure_batch_within_cap("ops", tx.pending_len())?;
    let children = rest.iter().take_while(|b| b.depth > first.depth).count();
    let mut rows = vec![anchor];
    rows.extend(
        Box::pin(create_parsed_blocks(
            tx,
            materializer,
            device_id,
            Some(id.to_owned()),
            None,
            &rest[..children],
            lines,
        ))
        .await?,
    );
    Ok(rows)
}

/// Write the note embeds, foreign highlight and math of `blocks` in Agaric's
/// form ([`normalize_foreign_forms`]), then resolve the page links and tags they
/// write as names in `anchor`'s space, creating what no name there matches,
/// and write each block's content with their ids, once each ref to another
/// space is written as the text it shows ([`write_foreign_refs_as_text`]).
/// Returns the pages and tags created; a dropped anchor or label is named in
/// `warnings`. With no space, every name stays text.
async fn resolve_pasted_names(
    mut tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    anchor: &BlockId,
    blocks: &mut [import::ParsedBlock],
    warnings: &mut Vec<String>,
) -> Result<(CommandTx, Vec<BlockRow>), AppError> {
    normalize_foreign_forms(blocks, import::embed_names_note);
    let Some(space) = agaric_store::space::resolve_block_space(&mut **tx, anchor).await? else {
        return Ok((tx, Vec::new()));
    };
    write_foreign_refs_as_text(&mut tx, &space, anchor, blocks, warnings).await?;
    let mut names = NameCtx {
        materializer,
        device_id,
        space_id: space.as_str(),
        file_page: None,
        defer_anchors: false,
        warnings,
        created: Vec::new(),
    };
    let (tx, links) = resolve_inbound_page_links(&mut names, tx, blocks).await?;
    warn_dropped_labels(names.warnings, links.dropped_labels);
    let (tx, _, tag_tokens, _) = resolve_inbound_tags(&mut names, tx, blocks).await?;
    for block in blocks.iter_mut() {
        block.content =
            rewrite_block_content_for_import(block, &links.page_links, &links.titles, &tag_tokens);
    }
    Ok((tx, names.created))
}

/// The `todo_state` whose stamps writing a parsed block takes: none for a done
/// task that brings its `completed_at`, a Tasks `✅` date (#6277 D2), which is
/// the stamp a move into DONE would write as today.
fn stamped_todo_state(block: &import::ParsedBlock) -> Option<&str> {
    let completed = block
        .properties
        .iter()
        .any(|(key, _)| key == "completed_at");
    parsed_todo_state(block).filter(|state| !(completed && *state == "DONE"))
}

/// Write each raw `[[ULID]]`, `#[ULID]` and `((ULID))` of `blocks` that the
/// create would refuse, its target being in another space than `space`, as
/// the text its chip shows (#6277 B2), with one warning counting them: a link
/// as `[[Title]]` and a tag as `#name`, which the paste then resolves in
/// `space` as any name, and a block ref as its target's first line. That line
/// may hold refs of its own, so the pass repeats over what it wrote: a link or
/// tag is written as its name each time it is met, a block ref only in one
/// pass, so a block ref met again stays, and the create refuses it.
async fn write_foreign_refs_as_text(
    tx: &mut CommandTx,
    space: &SpaceId,
    anchor: &BlockId,
    blocks: &mut [import::ParsedBlock],
    warnings: &mut Vec<String>,
) -> Result<(), AppError> {
    use agaric_store::cross_space_validation::foreign_content_refs;
    let mut shown: HashMap<String, String> = HashMap::new();
    let mut expanded: HashSet<String> = HashSet::new();
    loop {
        let all: Vec<&str> = blocks.iter().map(|block| block.content.as_str()).collect();
        let ids = foreign_content_refs(tx, space, &all.join("\n"), anchor.as_str()).await?;
        if ids.is_empty() {
            break;
        }
        let fresh: Vec<String> = ids
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| !shown.contains_key(id))
            .collect();
        shown.extend(
            load_live_blocks(tx, &fresh)
                .await?
                .into_iter()
                .map(|(id, _, content)| {
                    let first = content.as_deref().unwrap_or_default().lines().next();
                    (id, first.unwrap_or_default().to_owned())
                }),
        );
        let newly = write_shown_text(blocks, &shown, &expanded);
        if fresh.is_empty() && newly.is_empty() {
            break;
        }
        expanded.extend(newly);
    }
    if !shown.is_empty() {
        warnings.push(format!(
            "references to {} target(s) in another space were written as the text they \
             show: a block cannot reference another space",
            shown.len()
        ));
    }
    Ok(())
}

/// Write each `[[ULID]]` and `#[ULID]` of `blocks` whose target `shown` holds
/// as its name, and each such `((ULID))` as its first line unless an earlier
/// pass wrote it (`expanded`). Returns the block refs written.
fn write_shown_text(
    blocks: &mut [import::ParsedBlock],
    shown: &HashMap<String, String>,
    expanded: &HashSet<String>,
) -> HashSet<String> {
    let mut written = HashSet::new();
    for block in blocks.iter_mut() {
        let named = humanise_tag_and_page_refs(&block.content, shown, shown);
        block.content = agaric_store::cache::BLOCK_REF_RE
            .replace_all(&named, |caps: &regex::Captures<'_>| {
                match shown.get(&caps[1]).filter(|_| !expanded.contains(&caps[1])) {
                    Some(line) => {
                        written.insert(caps[1].to_owned());
                        line.clone()
                    }
                    None => caps[0].to_owned(),
                }
            })
            .into_owned();
    }
    written
}

/// The `todo_state` a parsed block carries, from its checkbox or a property
/// line.
fn parsed_todo_state(block: &import::ParsedBlock) -> Option<&str> {
    block
        .properties
        .iter()
        .rev()
        .find(|(key, _)| key == "todo_state")
        .map(|(_, value)| value.as_str())
}

/// Create parsed blocks: the k-th depth-0 block at `index + k` among
/// `parent_id`'s children, each deeper block appended under its parsed parent.
/// A block's properties and task stamp are written right after it, so its ops
/// stay together in the log. Refused, and so rolled back, the moment the
/// transaction holds more ops than one undo reverts.
pub(super) async fn create_parsed_blocks(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    parent_id: Option<String>,
    index: Option<i64>,
    blocks: &[import::ParsedBlock],
    lines: &PropertyLines,
) -> Result<Vec<BlockRow>, AppError> {
    let mut created = Vec::with_capacity(blocks.len());
    let mut open: Vec<(usize, String)> = Vec::new();
    let mut top_level: i64 = 0;
    for block in blocks {
        while open.last().is_some_and(|(depth, _)| *depth >= block.depth) {
            open.pop();
        }
        let (parent, slot) = if let Some((_, id)) = open.last() {
            (Some(id.clone()), None)
        } else {
            let slot = index.map(|i| i.saturating_add(top_level));
            top_level += 1;
            (parent_id.clone(), slot)
        };
        let (row, op) = create_block_in_tx(
            tx,
            materializer.loro_state(),
            device_id,
            "content".into(),
            block.content.clone(),
            parent,
            slot,
            None,
        )
        .await?;
        tx.enqueue_background(op);
        let id = row.id.clone().into_string();
        apply_block_properties(tx, materializer, device_id, &id, &block.properties, lines).await?;
        if let Some(state) = stamped_todo_state(block) {
            super::super::properties::write_todo_timestamp_transitions_in_tx(
                tx,
                materializer.loro_state(),
                device_id,
                &id,
                &super::super::properties::PriorTaskState::default(),
                Some(state),
            )
            .await?;
        }
        crate::commands::ensure_batch_within_cap("ops", tx.pending_len())?;
        open.push((block.depth, id));
        created.push(row);
    }
    Ok(created)
}
