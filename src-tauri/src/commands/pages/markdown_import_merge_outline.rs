//! #6277 G5 — a Logseq or Org file merged into the page of its title. The
//! outline reader's blocks are rendered as the page's buffer writes a page
//! (the Document writer), and that text is paired and saved as any other
//! merge (the maintainer's decision, 2026-11-11). Each block carries a minted
//! placeholder id as its anchor, and a `((uuid))` ref to a block of the file
//! a ref to that placeholder, which the merge makes the id of the block the
//! line pairs with or the save creates.

use std::collections::BTreeMap;

use super::*;

/// A file read as an outline, rendered as a page's buffer is.
pub(super) struct OutlineRender {
    /// The buffer text, each block anchored with its placeholder id.
    pub(super) text: String,
    /// The placeholder of each block the file folds (`collapsed::`).
    pub(super) collapsed: Vec<String>,
}

/// The blocks `parsed` read from a file, titled `title`, as the buffer of the
/// page `page_id` would write them had an import stored them: task state,
/// priority and planning dates in their columns, list styles, the other
/// properties as rows, the file's page properties, aliases and tags as front
/// matter.
pub(super) fn render_outline(
    page_id: &str,
    title: &str,
    parsed: &import::ParseOutput,
) -> OutlineRender {
    let ids: Vec<String> = parsed
        .blocks
        .iter()
        .map(|_| BlockId::new().into_string())
        .collect();
    let anchors: HashMap<&str, &str> = parsed
        .blocks
        .iter()
        .zip(&ids)
        .filter_map(|(block, id)| Some((block.block_anchor.as_deref()?, id.as_str())))
        .collect();
    let mut data = outline_page(page_id, title, parsed);
    let mut slots: HashMap<Option<usize>, i64> = HashMap::new();
    for ((block, parent), id) in parsed
        .blocks
        .iter()
        .zip(outline_parents(&parsed.blocks))
        .zip(&ids)
    {
        let slot = slots.entry(parent).or_insert(0);
        *slot += 1;
        let parent_id = parent.map_or(page_id, |parent| ids[parent].as_str());
        let content = match block.is_code {
            true => None,
            false => import::resolve_logseq_refs(&block.content, |uuid| {
                anchors.get(uuid).map(|id| (*id).to_owned())
            }),
        };
        let mut row = outline_row(id, parent_id, page_id, *slot);
        row.content = Some(content.unwrap_or_else(|| block.content.clone()));
        let rows = outline_properties(block, &mut row, &mut data.list_styles, id);
        data.descendant_properties.insert(id.clone(), rows);
        data.descendants.push(row);
    }
    let (text, _) = render_page_document(&data);
    let collapsed = parsed
        .collapsed
        .iter()
        .filter_map(|&i| ids.get(i).cloned())
        .collect();
    OutlineRender { text, collapsed }
}

/// The page row and front matter of [`render_outline`]'s data: the file's
/// `aliases` and `tags` as the page's, its other page properties as rows.
fn outline_page(page_id: &str, title: &str, parsed: &import::ParseOutput) -> PageExportData {
    let mut page = outline_row(page_id, page_id, page_id, 0);
    page.block_type = "page".into();
    page.parent_id = None;
    page.content = Some(title.to_owned());
    let items = |key: &str, value: &str| -> Vec<String> {
        parsed
            .frontmatter_list_items
            .get(key)
            .cloned()
            .unwrap_or_else(|| {
                value
                    .split(',')
                    .map(|item| item.trim().to_owned())
                    .filter(|item| !item.is_empty())
                    .collect()
            })
    };
    let (mut aliases, mut tags, mut properties) = (Vec::new(), Vec::new(), Vec::new());
    for (key, value) in &parsed.frontmatter {
        match key.as_str() {
            "aliases" => aliases.extend(items(key, value)),
            "tags" => tags.extend(items(key, value)),
            _ => properties.push(text_row(key, value)),
        }
    }
    PageExportData {
        page,
        descendants: Vec::new(),
        attachments_by_block: HashMap::new(),
        tag_names: HashMap::new(),
        page_titles: HashMap::new(),
        block_ref_replacement: HashMap::new(),
        addressed_blocks: HashSet::new(),
        descendant_properties: HashMap::new(),
        list_styles: HashMap::new(),
        ref_titles: HashMap::new(),
        properties,
        aliases,
        tag_names_fm: tags,
        name_snapshot: NameSnapshot::default(),
    }
}

/// A content block row of the page `page_id`, under `parent_id` at `position`.
fn outline_row(id: &str, parent_id: &str, page_id: &str, position: i64) -> BlockRow {
    BlockRow {
        id: BlockId::from_trusted(id),
        block_type: "content".into(),
        content: None,
        parent_id: Some(BlockId::from_trusted(parent_id)),
        position: Some(position),
        deleted_at: None,
        todo_state: None,
        priority: None,
        due_date: None,
        scheduled_date: None,
        page_id: Some(BlockId::from_trusted(page_id)),
    }
}

/// `block`'s last-wins properties as an import stores them: the promoted keys
/// on `row`, `listStyle` in `list_styles`, the rest returned as rows.
fn outline_properties(
    block: &import::ParsedBlock,
    row: &mut BlockRow,
    list_styles: &mut HashMap<String, String>,
    id: &str,
) -> Vec<FrontmatterRow> {
    let last: BTreeMap<&str, &str> = block
        .properties
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let mut rows = Vec::new();
    for (key, value) in last {
        match key {
            "todo_state" => row.todo_state = Some(value.to_owned()),
            "priority" => row.priority = Some(import_priority_value(value)),
            "due_date" => row.due_date = Some(value.to_owned()),
            "scheduled_date" => row.scheduled_date = Some(value.to_owned()),
            "listStyle" => {
                list_styles.insert(id.to_owned(), value.to_owned());
            }
            _ => rows.push(text_row(key, value)),
        }
    }
    rows
}

/// A text-valued property row.
fn text_row(key: &str, value: &str) -> FrontmatterRow {
    FrontmatterRow {
        key: key.to_owned(),
        value_text: Some(value.to_owned()),
        value_date: None,
        value_num: None,
        value_ref: None,
        value_bool: None,
    }
}

/// A block the file folds: the block its line paired with, or one the save
/// creates, found after it ([`fold_ids`]).
pub(super) enum Fold {
    Known(String),
    New(NewNamedBlock),
}

/// `text` with each `((placeholder))` of a block whose line paired
/// (`line_ids`) written as that block's id, and what only the save can name:
/// the new blocks the text refers to, and each of `collapsed` as a [`Fold`].
/// `anchors` holds the placeholder each line of `text` starts a block with.
pub(super) fn link_outline_ids(
    text: &str,
    anchors: &[Option<String>],
    line_ids: &[Option<String>],
    collapsed: &[String],
) -> (String, Vec<NewNamedBlock>, Vec<Fold>) {
    let mut linked = text.to_owned();
    let mut lines: HashMap<&str, usize> = HashMap::new();
    for (line, anchor) in anchors.iter().enumerate() {
        let Some(placeholder) = anchor else {
            continue;
        };
        lines.insert(placeholder, line);
        if let Some(Some(id)) = line_ids.get(line) {
            linked = linked.replace(&format!("(({placeholder}))"), &format!("(({id}))"));
        }
    }
    let blocks = import::parse_document_outline(&linked).blocks;
    let new_block = |placeholder: &str| -> Option<NewNamedBlock> {
        let line = *lines.get(placeholder)?;
        let block = blocks.iter().find(|block| block.line == Some(line + 1))?;
        Some(NewNamedBlock {
            placeholder: placeholder.to_owned(),
            content: block.content.clone(),
        })
    };
    let fresh = lines
        .iter()
        .filter(|&(_, &line)| line_ids.get(line).is_none_or(Option::is_none))
        .filter(|(placeholder, _)| linked.contains(&format!("(({placeholder}))")))
        .filter_map(|(placeholder, _)| new_block(placeholder))
        .collect();
    let folds = collapsed
        .iter()
        .filter_map(|placeholder| {
            let line = *lines.get(placeholder.as_str())?;
            match line_ids.get(line).cloned().flatten() {
                Some(id) => Some(Fold::Known(id)),
                None => new_block(placeholder).map(Fold::New),
            }
        })
        .collect();
    (linked, fresh, folds)
}

/// The ids of the blocks `folds` names once the save is done; a new block no
/// one block of the page holds is left out.
pub(super) async fn fold_ids(
    ctx: &ImportCtx<'_>,
    folds: Vec<Fold>,
) -> Result<Vec<String>, AppError> {
    let mut ids = Vec::new();
    let mut fresh = Vec::new();
    for fold in folds {
        match fold {
            Fold::Known(id) => ids.push(id),
            Fold::New(block) => fresh.push(block),
        }
    }
    ids.extend(new_block_ids(ctx, &fresh).await?.into_iter().flatten());
    Ok(ids)
}
