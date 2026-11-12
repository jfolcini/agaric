//! #6277 G5 — a merged file's Obsidian `^name` markers. An import takes a
//! marker out of its block's text and makes the file's links to it refs to
//! that block; a buffer save reads neither, so a merge does both around it.

use super::*;

/// An Obsidian link to a named block of a page: `[[Title#^name]]`, or
/// `[[#^name]]` for the note's own, with an optional label.
static NAMED_LINK_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(!?)\[\[([^\]|#]*)#\^([A-Za-z0-9-]+)(?:\|[^\]]*)?\]\]")
        .expect("invalid named-anchor link regex")
});

/// A name on a block the save creates: the placeholder id its links carry
/// until [`link_new_named_blocks`] knows the block, and the block's content.
pub(super) struct NewNamedBlock {
    placeholder: String,
    content: String,
}

/// `text` with each Obsidian `^name` marker taken off the block it ends, and
/// each such block's name by the line it starts on. A page's own id is no
/// name: [`anchor_free`] has read those.
pub(super) fn strip_named_anchors(text: &str) -> (String, Vec<(usize, String)>) {
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    let mut named = Vec::new();
    for block in import::parse_document_outline(text).blocks {
        let (Some(name), Some(start)) = (block.block_anchor, block.line) else {
            continue;
        };
        if block.is_code || BlockId::from_string(&name).is_ok() {
            continue;
        }
        let last = start - 1 + block.content.split('\n').count() - 1;
        let marker = format!(" ^{name}");
        if let Some(line) = lines.get_mut(last)
            && let Some(kept) = line.trim_end().strip_suffix(&marker)
        {
            *line = kept.to_owned();
            named.push((start - 1, name));
        }
    }
    (lines.join("\n"), named)
}

/// `text` with each link to a `named` block of the page titled `title` a ref
/// to it: the block its line pairs with (`line_ids`), or a placeholder for a
/// block the save creates, returned with that block's content. Code is kept.
pub(super) fn link_named_anchors(
    text: &str,
    title: &str,
    named: &[(usize, String)],
    line_ids: &[Option<String>],
) -> (String, Vec<NewNamedBlock>) {
    let mut fresh = Vec::new();
    let ids: HashMap<&str, String> = named
        .iter()
        .map(|(line, name)| {
            let id = line_ids.get(*line).cloned().flatten().unwrap_or_else(|| {
                let placeholder = BlockId::new().into_string();
                fresh.push((*line, placeholder.clone()));
                placeholder
            });
            (name.as_str(), id)
        })
        .collect();
    let outline = import::parse_document_outline(text).blocks;
    let code: HashSet<usize> = outline
        .iter()
        .filter(|block| block.is_code)
        .filter_map(|block| block.line.map(|start| (block, start - 1)))
        .flat_map(|(block, start)| start..start + block.content.split('\n').count())
        .collect();
    let title = title.to_lowercase();
    let linked: Vec<String> = text
        .split('\n')
        .enumerate()
        .map(|(i, line)| {
            if code.contains(&i) {
                line.to_owned()
            } else {
                link_line(line, &title, &ids)
            }
        })
        .collect();
    let linked = linked.join("\n");
    let contents = import::parse_document_outline(&linked).blocks;
    let fresh = fresh
        .into_iter()
        .filter_map(|(line, placeholder)| {
            let block = contents.iter().find(|block| block.line == Some(line + 1))?;
            Some(NewNamedBlock {
                placeholder,
                content: block.content.clone(),
            })
        })
        .collect();
    (linked, fresh)
}

/// `line` with each link to one of `ids`' names on the page titled `title`
/// (lowercased) a ref to its block; an embed or a link in inline code is kept.
fn link_line(line: &str, title: &str, ids: &HashMap<&str, String>) -> String {
    let spans = import::inline_code_spans(line);
    NAMED_LINK_RE
        .replace_all(line, |caps: &regex::Captures<'_>| {
            let whole = caps.get(0).expect("group 0 always present");
            let base = caps[2].trim().to_lowercase();
            let in_code = spans
                .iter()
                .any(|&(start, end)| whole.start() >= start && whole.start() < end);
            match ids.get(&caps[3]) {
                Some(id)
                    if caps[1].is_empty() && !in_code && (base.is_empty() || base == title) =>
                {
                    format!("(({id}))")
                }
                _ => whole.as_str().to_owned(),
            }
        })
        .into_owned()
}

/// Once the save is done, each placeholder of a [`NewNamedBlock`] becomes a
/// ref to the block the save made of its content, found in the page's buffer;
/// one no block holds alone becomes a link to the page, with a warning, as an
/// import leaves a name it cannot find. Returns the edits' ops.
pub(super) async fn link_new_named_blocks(
    ctx: &mut ImportCtx<'_>,
    fresh: &[NewNamedBlock],
) -> Result<Vec<agaric_store::op::OpRef>, AppError> {
    let mut op_refs = Vec::new();
    if fresh.is_empty() {
        return Ok(op_refs);
    }
    let buffer = get_page_buffer_inner(ctx.pool, &ctx.page_id).await?;
    let blocks = import::parse_document_outline(&buffer.text).blocks;
    for named in fresh {
        let mut holders = blocks.iter().filter(|block| block.content == named.content);
        let target = match (holders.next(), holders.next()) {
            (Some(block), None) => block
                .line
                .and_then(|line| buffer.line_ids.get(line - 1).cloned().flatten()),
            _ => None,
        };
        let token = format!("(({}))", named.placeholder);
        let link = if let Some(id) = &target {
            format!("(({id}))")
        } else {
            ctx.warnings.push(format!(
                "a wikilink block-anchor (`#^name`) could not be matched to a block of \
                 '{}'; left as a page link",
                ctx.page_title
            ));
            format!("[[{}]]", ctx.page_id)
        };
        op_refs.extend(replace_in_page(ctx, &token, &link).await?);
    }
    Ok(op_refs)
}

/// Replace `token` with `with` in each block of the page whose text holds it.
async fn replace_in_page(
    ctx: &ImportCtx<'_>,
    token: &str,
    with: &str,
) -> Result<Vec<agaric_store::op::OpRef>, AppError> {
    let page = ctx.page_id.as_str();
    let holders = sqlx::query!(
        r#"SELECT id AS "id!", content AS "content!" FROM blocks
           WHERE page_id = ?1 AND deleted_at IS NULL AND instr(content, ?2) > 0"#,
        page,
        token,
    )
    .fetch_all(ctx.pool)
    .await?;
    let mut op_refs = Vec::new();
    for holder in holders {
        let edit = crate::commands::blocks::crud::edit_block_inner(
            ctx.pool,
            ctx.device_id,
            ctx.materializer,
            BlockId::from_trusted(&holder.id),
            holder.content.replace(token, with),
        );
        op_refs.extend(capture_op_refs(edit).await?.op_refs);
    }
    Ok(op_refs)
}
