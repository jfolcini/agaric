//! The import core: [`IMPORT_CHUNK_BLOCKS`], [`parse_import_payload`],
//! [`import_title`], [`create_import_page`], [`resolve_document_refs`], [`ImportCtx`],
//! [`NameCtx`], [`insert_blocks`], the chunk commits and [`finish`].

use super::*;

/// #662 — minimum number of content blocks written into one import chunk
/// before the import is allowed to flush (commit + release the writer
/// lock) at the next top-level (depth-0) subtree boundary.
///
/// Tuning rationale (see #662): a hard *cap* on import size was rejected
/// because it would break legitimate large imports, and the verified bug
/// is the writer-lock *hold time*, not the row count. A chunk size of 500
/// keeps the common case — the import benches exercise 100 / 1000 / 5000
/// blocks — single-transaction at 100 blocks (preserving the original
/// whole-import atomicity for typical files) while splitting a 5000-block
/// import into ~10 chunks, so the writer lock is released ~10 times mid-
/// import instead of being held throughout. It is a `usize` because it is
/// compared against the per-chunk `chunk_blocks` counter.
///
/// Note this is a *floor*, not a cap: a chunk may exceed it when a single
/// top-level subtree is itself larger than the floor — the subtree is
/// never split, so correctness (no half-written subtree) always wins over
/// the size target.
///
/// `pub(crate)` so chunk-boundary tests can size a multi-chunk import
/// relative to the threshold instead of hardcoding the number.
///
/// #1921 — chunking bounds only the writer-lock *hold time* (it commits +
/// releases the lock periodically); it does NOT bound the per-block
/// sibling-reproject cost incurred when each block is created. That reproject
/// cost is a separate concern tracked on its own and is unaffected by this
/// threshold.
pub const IMPORT_CHUNK_BLOCKS: usize = 500;

/// The created blocks the parse marked: those its Logseq `collapsed::` lines
/// fold, and the one each anchor names ([`ImportResult::collapsed`],
/// [`ImportResult::anchors`]). A block the import skipped (#1918) is neither.
pub(super) fn marked_blocks(
    page_id: &str,
    parse_output: &import::ParseOutput,
    created_block_ids: &[Option<String>],
) -> (Vec<String>, Vec<ImportAnchor>) {
    let collapsed = parse_output
        .collapsed
        .iter()
        .filter_map(|&index| created_block_ids[index].clone())
        .collect();
    let anchors = parse_output.blocks.iter().zip(created_block_ids);
    let anchors = anchors
        .filter_map(|(block, id)| {
            Some(ImportAnchor {
                page_id: page_id.to_string(),
                anchor: block.block_anchor.clone()?,
                block_id: id.clone()?,
            })
        })
        .collect();
    (collapsed, anchors)
}

/// Guard the payload, parse it, and derive the page title.
///
/// #2724 — the AGGREGATE attachment budget is enforced ONCE here, at the command
/// boundary, before any parsing or ingest. `vault_files` arrives over IPC with
/// every referenced file's full bytes resident in memory and is retained for the
/// whole chunked import; the per-file `MAX_ATTACHMENT_SIZE` guard (applied later,
/// per ingest) does NOTHING to bound the aggregate. An over-budget payload is
/// rejected up front — a clear error, no partial write and no ingest attempted —
/// rather than letting a multi-hundred-MB `Vec` push the process toward OOM.
/// `None`/empty ⇒ the whole check is a no-op, so the pre-#2724 no-attachment
/// path is byte-for-byte unchanged. (The frontend `DataTab` should pre-check the
/// same budget for a nicer UX, but THIS backend cap is the load-bearing guard —
/// it protects the MCP / test / scripted paths that never touch the frontend.)
///
/// #1446 Part B — the title comes from the filename (folder → namespace). The
/// caller may pass either a bare basename (`API.md`) or a relative path within
/// the imported folder/vault (`Project/Backend/API.md`, e.g. a browser
/// `webkitRelativePath`). We strip the `.md` extension and keep the
/// `/`-delimited path AS the namespaced page title, the inverse of the
/// namespaced export (Part A). Backslash separators (Windows-authored paths) are
/// normalised to `/` first, and empty path segments (leading/trailing or doubled
/// separators) are dropped so a stray slash never yields a blank namespace.
pub(super) fn parse_import_payload(
    content: &str,
    filename: Option<String>,
    dialect: ImportDialect,
    vault_files: Option<&[VaultFile]>,
    vault_notes: Option<&[String]>,
) -> Result<(import::ParseOutput, String), AppError> {
    if let Some(files) = vault_files {
        // Sum as u64 to avoid any `usize as i64` wrap on a pathological length.
        let total_bytes: u64 = files.iter().map(|f| f.bytes.len() as u64).sum();
        check_attachment_budget(files.len(), total_bytes)?;
    }
    let page_title = import_title(filename);
    // Agaric's own export writes the title as a `# Title` line, which would
    // otherwise come back as a block repeating it (#5160 S6). A Markdown file
    // reads as a paste does (#6277 decision 1); a Logseq or Org note of a
    // folder import keeps its `((uuid))` refs to other notes for
    // `link_import_anchors`.
    let text = import::strip_title_heading(content, &page_title);
    let mut parse_output = match dialect {
        ImportDialect::Markdown => import::parse_markdown_file(&text),
        ImportDialect::LogseqOrg if vault_notes.is_some() => import::parse_vault_markdown(&text),
        ImportDialect::LogseqOrg => import::parse_logseq_markdown(&text),
    };
    // A Logseq or Org file's `#+BEGIN_X` blocks (#6033 S3); a Markdown file
    // keeps them as written (#6277 E1). Every block, code too: the rewrite
    // skips the lines of its code fences.
    if dialect == ImportDialect::LogseqOrg {
        for block in &mut parse_output.blocks {
            block.content = import::rewrite_org_blocks(&block.content);
        }
    }
    // A folder import links its notes by relative path (#5160 N10); a lone
    // file has no vault to be relative to. The title is the note's path below
    // the picked folder (#6277 decision 8), so a top-level note's folder is "".
    if vault_notes.is_some() {
        let dir = page_title.rsplit_once('/').map_or("", |(dir, _)| dir);
        for block in parse_output.blocks.iter_mut().filter(|b| !b.is_code) {
            block.content = rewrite_relative_md_links(&block.content, dir);
        }
    }
    let notes = vault_note_titles(vault_notes.unwrap_or_default());
    // A note of the folder is a note whatever its name looks like.
    let names_note =
        |name: &str| import::embed_names_note(name) || notes.contains_key(&name.to_lowercase());
    for block in parse_output.blocks.iter_mut().filter(|b| !b.is_code) {
        block.content = import::rewrite_logseq_image_sizes(&block.content);
    }
    normalize_foreign_forms(&mut parse_output.blocks, names_note);
    if !notes.is_empty() {
        for block in parse_output.blocks.iter_mut().filter(|b| !b.is_code) {
            block.content = rewrite_vault_wikilinks(&block.content, &notes);
        }
    }
    Ok((parse_output, page_title))
}

/// The page title a file imports as: its `filename`'s path, `.md` dropped
/// (#1446 Part B), else `Imported Page`.
pub(super) fn import_title(filename: Option<String>) -> String {
    filename
        .map(|f| folder_path_to_namespace_title(&f))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Imported Page".to_string())
}

/// Each block's Obsidian note embeds ([`import::rewrite_obsidian_note_embeds`],
/// `names_note` telling a note from a file) and foreign highlight and math
/// ([`import::normalize_foreign_inline`]) in Agaric's form, as import, paste,
/// every MCP content write and Edit as Markdown take text in (#6033). A code
/// block keeps its embeds.
pub(super) fn normalize_foreign_forms(
    blocks: &mut [import::ParsedBlock],
    names_note: impl Fn(&str) -> bool,
) {
    for block in blocks {
        if !block.is_code {
            block.content = import::rewrite_obsidian_note_embeds(&block.content, &names_note);
        }
        if let std::borrow::Cow::Owned(content) = import::normalize_foreign_inline(&block.content) {
            block.content = content;
        }
    }
}

/// The page title each of a folder pick's `.md` paths imports as, keyed by its
/// file name lowercased in full Unicode, as the frontend's `linkedNotePaths`
/// keys the notes it ships: the note a bare `[[Name]]` names wherever it sits
/// in the vault, as Obsidian reads it (#5740). Of two notes of one name the one
/// nearer the vault root wins, then the one whose title sorts first, so every
/// file of the pick reads a name alike whichever order the files import in.
fn vault_note_titles(paths: &[String]) -> HashMap<String, String> {
    let depth = |title: &str| title.matches('/').count();
    let mut notes: HashMap<String, String> = HashMap::new();
    for path in paths {
        let title = folder_path_to_namespace_title(path);
        let name = title.rsplit('/').next().unwrap_or_default();
        let name = name.to_lowercase();
        if name.is_empty() {
            continue;
        }
        let kept = notes.get(&name);
        if kept.is_none_or(|kept| (depth(&title), &title) < (depth(kept), kept)) {
            notes.insert(name, title);
        }
    }
    notes
}

/// `content` with the name of each `[[Name]]`, `[[Name|label]]` or
/// `[[Name#anchor]]` link that names one of `notes` written as that note's
/// title, so the link resolves to the page the note imports as, or creates
/// the page the note's own import then fills (#5160 D12). The name is the text
/// before the first `|` or `#`, which an Obsidian note name never holds. Tokens
/// in code, tags, embeds and escaped links are untouched.
fn rewrite_vault_wikilinks(content: &str, notes: &HashMap<String, String>) -> String {
    if !content.contains("[[") {
        return content.to_string();
    }
    let code_spans = import::inline_code_spans(content);
    HUMAN_PAGE_LINK_RE
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("group 0 always present");
            let body = &caps[1];
            let (name, rest) = body.split_at(body.find(['|', '#']).unwrap_or(body.len()));
            // A table cell's `\|` (`unescape_link_pipes`) keeps its backslash.
            let (name, rest) = match name.strip_suffix('\\') {
                Some(name) if rest.starts_with('|') => (name, &body[name.len()..]),
                _ => (name, rest),
            };
            match notes.get(&name.trim().to_lowercase()) {
                Some(title) if page_link_is_token(content, m.start(), &code_spans) => {
                    format!("[[{title}{rest}]]")
                }
                _ => m.as_str().to_string(),
            }
        })
        .into_owned()
}

/// `content` with each link to a relative note, a file of one of the
/// [`import::NOTE_EXTENSIONS`] resolved against `dir` (the linking file's
/// folder), written as a `[[title]]` link to the page that file imports as
/// (#5160 N10), with the link text as its label when it is not that title
/// (D9). A `#Heading` or `#^id` fragment is kept as the link's anchor. A `<…>`
/// or titled destination reads as a bare one. External links, links to other
/// file types, images and links in code or escaped are untouched.
pub(super) fn rewrite_relative_md_links(content: &str, dir: &str) -> String {
    if !content.contains("](") {
        return content.to_string();
    }
    let code_spans = import::inline_code_spans(content);
    let mut out = String::with_capacity(content.len());
    let mut copied = 0;
    for token in import::markdown_link_tokens(content) {
        if token.is_image
            || is_in_span(token.start, &code_spans)
            || is_escaped(content, token.start)
        {
            continue;
        }
        // Split before decoding: a `%23` is a `#` of the file's name.
        let (path, anchor) = match token.destination.split_once('#') {
            Some((path, anchor)) => (path, Some(percent_decode(anchor))),
            None => (token.destination, None),
        };
        let Some(title) = relative_md_link_title(path, dir) else {
            continue;
        };
        let target = match anchor.filter(|anchor| !anchor.is_empty()) {
            Some(anchor) => format!("{title}#{anchor}"),
            None => title.clone(),
        };
        let link = match token.text.trim() {
            "" => format!("[[{target}]]"),
            text if text == title => format!("[[{target}]]"),
            text => format!("[[{target}|{text}]]"),
        };
        out.push_str(&content[copied..token.start]);
        out.push_str(&link);
        copied = token.end;
    }
    out.push_str(&content[copied..]);
    out
}

/// The page title a relative note link's `path` (its destination before any
/// `#fragment`) imports as, resolved against `dir`, the linking note's folder
/// below the vault root: `Other%20note.md` from `notes` is `notes/Other note`,
/// and `../Top.txt` is `Top`. An Org file is named by its file name, not its
/// `#+TITLE`. `None` for a URL with a scheme (`mailto:a@b.org`), an absolute
/// path, a file that is no note or a path that climbs out of the vault.
pub(super) fn relative_md_link_title(path: &str, dir: &str) -> Option<String> {
    let path = percent_decode(path).replace('\\', "/");
    let (stem, extension) = path.rsplit_once('.')?;
    let names_note = import::NOTE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str());
    if import::URL_SCHEME_RE.is_match(&path) || path.starts_with('/') || !names_note {
        return None;
    }
    let path = import::resolve_vault_path(dir, stem)?;
    Some(folder_path_to_namespace_title(&path)).filter(|t| !t.is_empty())
}

/// #128 / #1932 / #1934 — announce the import before the transaction opens.
///
/// The `Started` event carries the parser's block count so the UI can render a
/// determinate progress bar from the first event; if the import later fails, the
/// consumer sees no `Complete` and treats it as failed. The same count back-fills
/// the identifying span field, so every event emitted within this span (and the
/// `err` line on failure) carries it — #3317 removed the `page_title` back-fill;
/// see the note on `import_markdown_with_progress`'s `#[instrument]` attribute.
/// The start log line uses structured fields (not interpolation) to match the
/// codebase logging baseline (e.g. `materializer/consumer.rs`); until #1932 the
/// entire backend import path emitted nothing on the happy path, leaving a
/// completed/partial import invisible in `agaric.log`.
pub(super) fn announce_import_start(
    progress: Option<&dyn ImportProgressSink>,
    page_title: &str,
    blocks_total: u64,
    space_id: &str,
    dialect: ImportDialect,
    parse_warnings: usize,
) {
    let span = tracing::Span::current();
    span.record("blocks_total", blocks_total);

    tracing::info!(
        page = %page_title,
        blocks_total,
        space = %space_id,
        ?dialect,
        parse_warnings,
        "import: starting markdown import"
    );

    if let Some(sink) = progress {
        sink.emit(ImportProgressUpdate::Started {
            page_title: page_title.to_string(),
            blocks_total,
        });
    }
}

/// Open the import's first chunk and create the page `file` writes into, or
/// adopt the empty same-title page an earlier file's link created (#5160
/// D12), returning the transaction, the page's ULID and title and how the
/// file's property lines read ([`import_property_lines`]). A file that merges
/// into the page of its title, which holds blocks ([`import_target`], #6277
/// decision 7), rolls the chunk back and merges ([`merge_into_page`]),
/// returning its result.
///
/// --- Chunked IMMEDIATE transactions (#662) --- `CommandTx` couples commit +
/// post-commit dispatch; op records enqueue per chunk and drain in FIFO order on
/// that chunk's commit. Pre-#662 this was a *single* IMMEDIATE transaction
/// spanning the whole (unbounded) import, so a multi-MB file held the single
/// SQLite writer lock — blocking every other write + the UI — for its entire
/// duration. The transaction is now flushed at top-level (depth-0) subtree
/// boundaries once it has accumulated at least `IMPORT_CHUNK_BLOCKS` blocks,
/// releasing and re-acquiring the writer lock between chunks so interleaved
/// writes can proceed. See `import_markdown_with_progress`'s doc comment for the
/// chunk-boundary + partial-import contract.
///
/// `space_id` is validated INSIDE the tx, identically to
/// `create_page_in_space_inner`: the target must exist as a live, non-conflict
/// block carrying `is_space = 'true'`, which inside the tx is TOCTOU-safe
/// against a concurrent delete. Rejecting here means the import never partially
/// writes a page + blocks before failing — the early `?` rolls the whole
/// transaction back. The page's own `space` ref is stamped straight after it is
/// created, so ops are emitted in the order (create-page → set-space) and a sync
/// peer materializes them in the same order, never observing a page without its
/// space property in steady state.
pub(super) async fn create_import_page(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    file: &ImportFile<'_>,
    progress: Option<&dyn ImportProgressSink>,
    parse_output: &mut import::ParseOutput,
) -> Result<ImportPage, AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "import_markdown").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort). Re-armed per
    // chunk when the block loop reopens the transaction.
    tx.arm_engine_rollback(materializer.loro_state());

    let space_id = file.space_id;
    crate::commands::spaces::require_live_space_in_tx(&mut tx, space_id).await?;

    let warnings = &mut parse_output.warnings;
    let (page_id, title) = match import_target(&mut tx, file, warnings).await? {
        ImportTarget::Adopt(page_id) => (page_id, file.title.to_string()),
        ImportTarget::Merge { page_id, title } => {
            tx.rollback().await?;
            let merge = merge_into_page(pool, device_id, materializer, &page_id, file);
            let merged = Box::pin(merge).await?;
            return Ok(ImportPage::Merged(merged_result(
                progress, page_id, title, merged,
            )));
        }
        ImportTarget::Create(title) => {
            let (page, page_op) = create_block_in_tx(
                &mut tx,
                materializer.loro_state(),
                device_id,
                "page".into(),
                title.clone(),
                None,
                None,
                // #2849 PR2: server-generated id.
                None,
            )
            .await?;
            tx.enqueue_background(page_op);
            let page_id = page.id.clone().into_string();
            stamp_space_property(&mut tx, materializer, device_id, page_id.clone(), space_id)
                .await?;
            (page_id, title)
        }
    };
    let lines = import_property_lines(&mut tx, space_id, parse_output).await?;
    Ok(ImportPage::Write(Box::new(OpenPage {
        tx,
        page_id,
        title,
        lines,
    })))
}

/// How the file's property lines and front matter read against the space's
/// definitions: each ref value resolved, and each value a definition refuses
/// kept as text in its block, with a warning (#5160 D11).
pub(super) async fn import_property_lines(
    tx: &mut CommandTx,
    space_id: &str,
    parse_output: &mut import::ParseOutput,
) -> Result<PropertyLines, AppError> {
    let mut lines = PropertyLines::load(tx, Some(space_id), PropertyWrite::Import).await?;
    let values = parse_output
        .blocks
        .iter()
        .flat_map(|block| &block.properties)
        .chain(&parse_output.frontmatter);
    lines.resolve_refs(tx, Some(space_id), values).await?;
    lines.keep_refused_as_text(&mut parse_output.blocks, &mut parse_output.warnings);
    Ok(lines)
}

/// Everything the block loop and the post-commit anchor phase need to rewrite a
/// document's inbound references to this vault's ids.
pub(super) struct DocumentRefs {
    pub(super) links: InboundLinks,
    /// Original inline-tag token → tag ULID.
    tag_tokens: HashMap<String, String>,
    /// #2510 — Obsidian block-anchor id → the INDEX (into `parse_output.blocks`)
    /// of the block whose trailing `^block-id` marker the parser stripped (see
    /// `ParsedBlock::block_anchor`).
    pub(super) anchor_to_block_index: HashMap<String, usize>,
    /// #2567 — normalized heading text → INDEX (into `parse_output.blocks`) of
    /// the FIRST block whose content is that ATX heading.
    pub(super) heading_to_block_index: HashMap<String, usize>,
}

/// #2510 — map each Obsidian `^block-id` marker to the index of the block that
/// carried it, ready for the post-commit anchor pass to turn into a real ULID.
/// A duplicate anchor id within one document (a user/Obsidian authoring mistake)
/// last-write-wins, matching a plain map insert — not worth a dedicated
/// ambiguity warning.
fn index_block_anchors(blocks: &[import::ParsedBlock]) -> HashMap<String, usize> {
    blocks
        .iter()
        .enumerate()
        .filter_map(|(idx, b)| b.block_anchor.as_ref().map(|a| (a.clone(), idx)))
        .collect()
}

/// #2567 — map each normalized ATX heading label to the index of the block that
/// is that heading. A repeated label targets its first occurrence in document
/// order (`or_insert`), as Obsidian resolves a link to a repeated heading.
/// `is_code` blocks are skipped — a `# comment` inside a fenced code sample is
/// not a heading.
fn index_headings(blocks: &[import::ParsedBlock]) -> HashMap<String, usize> {
    let mut map: HashMap<String, usize> = HashMap::new();
    for (idx, b) in blocks.iter().enumerate() {
        if b.is_code {
            continue;
        }
        if let Some(text) = obsidian_heading_text(&b.content) {
            map.entry(normalize_heading_anchor(text)).or_insert(idx);
        }
    }
    map
}

/// The import's pre-commit phases: page-level frontmatter, then the wiki-link
/// and inline-tag resolve-or-create pre-passes, then the frontmatter tags. They
/// all run in the FIRST chunk's transaction, so everything they create shares
/// the page's atomic write, before the block loop opens any new chunk.
pub(super) async fn resolve_document_refs(
    ctx: &mut ImportCtx<'_>,
    tx: CommandTx,
    parse_output: &import::ParseOutput,
    counters: &mut ImportCounters,
) -> Result<(CommandTx, DocumentRefs), AppError> {
    // #1432 — leading YAML frontmatter → page-level properties.
    let tx = apply_frontmatter_properties(ctx, tx, parse_output, counters).await?;

    // #1446 Part B / #1921 — inbound `[[Page Name]]` wiki-link resolution pre-pass.
    let (tx, links) =
        resolve_inbound_page_links(&mut ctx.name_ctx(), tx, &parse_output.blocks).await?;

    // #1924 / #1950 — inbound inline-tag resolution pre-pass.
    let (tx, mut resolved_tag_norm, tag_tokens, existing_tag_by_norm) =
        resolve_inbound_tags(&mut ctx.name_ctx(), tx, &parse_output.blocks).await?;

    // #2722 — frontmatter `tags:` → real page→tag associations.
    let tx = apply_frontmatter_tags(
        ctx,
        tx,
        parse_output,
        &mut resolved_tag_norm,
        &existing_tag_by_norm,
    )
    .await?;

    Ok((
        tx,
        DocumentRefs {
            links,
            tag_tokens,
            anchor_to_block_index: index_block_anchors(&parse_output.blocks),
            heading_to_block_index: index_headings(&parse_output.blocks),
        },
    ))
}

/// #2928 — shared state for the `import_markdown_with_progress` phase helpers
/// below. Bundles the read-only handles, the derived page identity, and the
/// running `warnings` list that each phase appends to, so the decomposed phase
/// functions take a single `&mut ImportCtx` instead of re-threading a long
/// argument list. The chunked transaction (`CommandTx`) is deliberately NOT a
/// field: it borrows `pool` (also held here), which would make the struct
/// self-referential, so it is threaded through the pre-commit phases by value
/// instead.
pub(super) struct ImportCtx<'a> {
    pub(super) pool: &'a SqlitePool,
    pub(super) device_id: &'a str,
    pub(super) materializer: &'a Materializer,
    pub(super) app_data_dir: &'a std::path::Path,
    pub(super) progress: Option<&'a dyn ImportProgressSink>,
    pub(super) started_at: std::time::Instant,
    pub(super) space_id: String,
    pub(super) page_id: String,
    pub(super) page_title: String,
    pub(super) blocks_total: u64,
    /// How the file's property lines read against the definitions.
    pub(super) lines: PropertyLines,
    /// Parse-time + apply-time diagnostics, accumulated across every phase and
    /// returned in the final [`ImportResult`].
    pub(super) warnings: Vec<String>,
    /// A note of a folder import, whose references into other notes wait for
    /// `link_import_anchors` when the note they name is not imported yet.
    pub(super) folder: bool,
    /// The blocks holding such a reference ([`ImportResult::deferred`]).
    pub(super) deferred: Vec<String>,
}

impl ImportCtx<'_> {
    /// The name passes' view of this import: its page, in its space.
    fn name_ctx(&mut self) -> NameCtx<'_> {
        NameCtx {
            materializer: self.materializer,
            device_id: self.device_id,
            space_id: &self.space_id,
            file_page: Some(&self.page_id),
            defer_anchors: self.folder,
            warnings: &mut self.warnings,
            created: Vec::new(),
        }
    }
}

/// What the name passes ([`resolve_inbound_page_links`],
/// [`resolve_inbound_tags`]) need to resolve names in one space, creating a
/// page or tag no name there matches: import and paste each build one.
pub(super) struct NameCtx<'a> {
    pub(super) materializer: &'a Materializer,
    pub(super) device_id: &'a str,
    pub(super) space_id: &'a str,
    /// The page an import writes its file into: a link to it with a `#` anchor
    /// points into the file, which the same-file pass reads once its blocks
    /// exist. Paste and Edit as Markdown write into a page whose blocks are
    /// saved, so such a link is looked up there, as one into another page is.
    pub(super) file_page: Option<&'a str>,
    /// A folder import's: an anchor into another page that names no block yet
    /// is left for `link_import_anchors` ([`PageLinks::deferred`]) rather than
    /// dropped.
    pub(super) defer_anchors: bool,
    pub(super) warnings: &'a mut Vec<String>,
    /// The pages and tags the passes created, in creation order.
    pub(super) created: Vec<BlockRow>,
}

/// The running totals an import accumulates across its phases (`properties_set`
/// in the frontmatter apply and the block loop, `blocks_created` /
/// `chunks_committed` in the block loop) and reports in the final
/// [`ImportResult`].
// Not `Copy`: every user takes it by `&mut`, and a helper silently taking it
// by value would drop the increments.
#[derive(Default)]
pub(super) struct ImportCounters {
    blocks_created: u64,
    pub(super) properties_set: u64,
    chunks_committed: u64,
}

/// Stamp the reserved `space` ref property on a block the import just created.
///
/// Every block an import mints — the page itself, a create-if-missing wiki-link
/// page, a resolve-or-create tag — must carry it: a tag with no space resolves
/// to NO space and the cross-space gate in `reindex_block_tag_refs` then drops
/// the inline `#[ULID]` ref, and a page without it is not a member of the
/// import's space.
///
/// The op is not dispatched: a fresh block has nothing to re-scope (#5275, the
/// `space` arm of `push_property_op_invalidations`).
pub(super) async fn stamp_space_property(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    block_id: String,
    space_id: &str,
) -> Result<(), AppError> {
    let (_block, space_op) = set_property_in_tx(
        &mut *tx,
        materializer.loro_state(),
        device_id,
        block_id,
        "space",
        None,
        None,
        None,
        Some(space_id.to_string()),
        None,
    )
    .await?;
    tx.enqueue_without_dispatch(space_op);
    Ok(())
}

/// #662 — commit the open import chunk (draining its op queue in FIFO order,
/// releasing the writer lock) and open a fresh one. A commit failure here aborts
/// the import; chunks already committed survive (documented partial-import
/// semantics).
///
/// #1934 — the failure log carries import context (which chunk, how many blocks
/// were durable when the abort happened) instead of a bare `Database error: …`.
/// The error itself is routed through `AppError::from(sqlx::Error)` so the IPC
/// `kind` discrimination is preserved (a writer-busy `PoolTimedOut` stays
/// `pool_busy`, a `Conflict` stays `conflict`); flattening to `Internal` would
/// have collapsed every commit failure to one kind and lost the frontend's
/// retry affordance.
async fn commit_chunk_and_reopen(
    tx: CommandTx,
    materializer: &Materializer,
    pool: &SqlitePool,
    page_title: &str,
    counters: &mut ImportCounters,
) -> Result<CommandTx, AppError> {
    let (chunks_committed, blocks_created) = (counters.chunks_committed, counters.blocks_created);
    tx.commit_and_dispatch(materializer).await.map_err(|e| {
        tracing::error!(
            page = %page_title,
            chunks_committed,
            blocks_created,
            error = %e,
            "import: chunk commit failed; committed chunks remain durable"
        );
        AppError::from(e)
    })?;
    counters.chunks_committed += 1;
    // #1932 (OBS-LOG-05) — per-chunk durability signal so a partial
    // import is observable in the log.
    tracing::debug!(
        page = %page_title,
        chunks_committed = counters.chunks_committed,
        blocks_created,
        "import: chunk committed (writer lock released)"
    );
    let mut tx = CommandTx::begin_immediate(pool, "import_markdown").await?;
    // #2604 — re-arm rollback for the new per-chunk tx.
    tx.arm_engine_rollback(materializer.loro_state());
    Ok(tx)
}

/// Commit + dispatch the final chunk's queued ops in FIFO order, releasing the
/// writer lock.
///
/// #1934 — a final-commit failure carries import context (block count / chunks
/// already durable) in an `error!` log. The error is routed through
/// `AppError::from(sqlx::Error)` so the IPC `kind` is preserved (e.g. a
/// writer-busy `PoolTimedOut` stays `pool_busy`); flattening to `Internal` would
/// have collapsed the discrimination the frontend relies on.
async fn commit_final_chunk(
    tx: CommandTx,
    materializer: &Materializer,
    page_title: &str,
    counters: &ImportCounters,
) -> Result<(), AppError> {
    let (chunks_committed, blocks_created) = (counters.chunks_committed, counters.blocks_created);
    tx.commit_and_dispatch(materializer).await.map_err(|e| {
        tracing::error!(
            page = %page_title,
            chunks_committed,
            blocks_created,
            error = %e,
            "import: final chunk commit failed"
        );
        AppError::from(e)
    })?;
    Ok(())
}

/// The block a parsed block at `depth` hangs off: pop the stack until it holds a
/// parent shallower than `depth`, falling back to the imported page itself.
///
/// The stack survives chunk flushes unchanged — every id in it refers to a block
/// committed in this or an earlier chunk, so `create_block_in_tx`'s in-tx parent
/// check (which reads committed rows) resolves cross-chunk parents fine.
fn parent_for_depth(
    parent_stack: &mut Vec<(usize, String)>,
    depth: usize,
    page_id: &str,
) -> String {
    while parent_stack.len() > 1 && parent_stack.last().is_some_and(|(d, _)| *d >= depth) {
        parent_stack.pop();
    }
    parent_stack
        .last()
        .map_or_else(|| page_id.to_string(), |(_, id)| id.clone())
}

/// One parsed block's content in its stored form: inline queries first, then
/// inbound wiki-links, then inbound inline tags.
///
/// #2968 — a readable `{{query v2n:… names …}}` payload is converted back to the
/// canonical stored `{{query v2:…ULIDs…}}` form, remapping embedded tag/page
/// names to THIS vault's ids via the same resolve maps. It runs before the
/// `[[Page]]` / `#tag` rewrites so the resulting base64url token is inert for
/// them (its alphabet has no `[[` / `#[` sequences).
///
/// #3605 — a code block's `[[Page]]` and `#tag` text is literal, so both
/// rewrites skip it wholesale (inline-code spans within a non-code block are
/// skipped inside `rewrite_inbound_tags`). Leaving the link rewrite eager meant
/// the SAME block kept its `#tag`s verbatim while its wiki-links were swapped
/// for ULIDs — an inconsistency inside one importer, not just across the two
/// implementations. The page-link rewrite runs first and leaves a `#[[...]]`
/// token in place (its `#`-prefix guard), so the tag rewrite is the sole owner
/// of that token.
pub(super) fn rewrite_block_content_for_import(
    block: &import::ParsedBlock,
    page_links: &PageLinks,
    page_titles: &HashMap<String, String>,
    resolved_tag_tokens: &HashMap<String, String>,
) -> String {
    let content = super::inline_query_md::rewrite_inline_queries_for_import(
        &block.content,
        &page_links.ids,
        resolved_tag_tokens,
    );
    if block.is_code {
        return content;
    }
    let content = rewrite_inbound_page_links(&content, page_links, page_titles);
    rewrite_inbound_tags(&content, resolved_tag_tokens)
}

/// #1925 — the attachment refs in one block's (already tag/link-rewritten)
/// content, to be ingested + rewritten AFTER the import tx commits. A code block
/// keeps its `![[...]]` / `![](...)` text literal (mirroring the inline-tag
/// skip), and with no supplied vault files detection is a no-op.
fn detect_import_attachment_refs(
    content: &str,
    is_code: bool,
    vault_files: &[VaultFile],
) -> Vec<import::AttachmentRef> {
    if vault_files.is_empty() || is_code {
        return Vec::new();
    }
    let spans = import::inline_code_spans(content);
    import::detect_attachment_refs(content, &spans)
}

/// Create one imported block inside the current chunk's transaction, queueing
/// its op for post-commit dispatch and returning its ULID.
///
/// #1918 — a SINGLE problematic block degrades gracefully (`Ok(None)`:
/// skip-and-warn) rather than `?`-aborting the whole chunk/import. Two
/// RECOVERABLE per-block validation conditions are skipped:
///
///   1. The block would exceed `MAX_BLOCK_DEPTH` (a deeply-nested import block
///      whose absolute depth lands over the create-path bound — the depth clamp
///      now leaves page-root headroom, but a residual over-deep block must
///      still skip, not abort).
///   2. The block's content exceeds `MAX_CONTENT_LENGTH` (a single huge block
///      must not strand the rest of the import).
///
/// Both are surfaced by `create_block_in_tx` as `AppError::Validation` with a
/// STABLE message, AND both checks run BEFORE any write inside it, so on
/// rejection the chunk transaction is still clean and the import continues. We
/// match ONLY those two messages: every other error (`AppError::Database` /
/// pool / connection / a NotFound parent / any other Validation) still
/// propagates and aborts as before — this is not a blanket catch-all.
async fn create_import_block(
    ctx: &mut ImportCtx<'_>,
    tx: &mut CommandTx,
    content: String,
    parent_id: String,
    depth: usize,
) -> Result<Option<String>, AppError> {
    let create_result = create_block_in_tx(
        &mut *tx,
        ctx.materializer.loro_state(),
        ctx.device_id,
        "content".into(),
        content,
        Some(parent_id),
        None,
        // #2849 PR2: server-generated id.
        None,
    )
    .await;
    match create_result {
        Ok((new_block, block_op)) => {
            tx.enqueue_background(block_op);
            Ok(Some(new_block.id.clone().into_string()))
        }
        Err(AppError::Validation { message: msg, .. })
            if msg.contains("maximum nesting depth")
                || (msg.contains("content length") && msg.contains("exceeds maximum")) =>
        {
            tracing::warn!(
                page = %ctx.page_title,
                depth,
                reason = %msg,
                "import: skipping block that failed a recoverable validation check (#1918)"
            );
            ctx.warnings.push(format!(
                "1 block skipped during import (recoverable validation failure: {msg})"
            ));
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// Whose property values [`apply_block_properties`] writes, which decides
/// how [`PropertyLines`] reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PropertyWrite {
    /// An imported file: a value its definition refuses stays text in the
    /// block, with a warning (#5160 D11).
    Import,
    /// Duplicate re-stores values a block already held, from a Document
    /// buffer: a `ref`-declared value is the raw id, and options the key has
    /// since retired or narrowed must not make the copy fail.
    Copy,
    /// Pasted text, read as an import reads a file (D11).
    Paste,
    /// A buffer save writes what the user typed: a value its definition
    /// refuses refuses the save, naming the line.
    Edit,
}

/// Set one block's properties, each under its canonical key, in the same
/// transaction as the block itself — an import never splits a block and its
/// properties across a chunk boundary (they are written before the next
/// depth-0 flush check). Returns how many it set.
///
/// Each value is typed by its key's declared `value_type` (#2982): a
/// number-, boolean- or date-typed custom property imports into the column it
/// exported from, a `ref`-declared one as the block its id or title names, and
/// the reserved date keys as `value_date` (#623). `lines` read the definitions
/// once for the whole surface; a line they refuse is an error here, which only
/// a source save reaches: an import and a paste keep such a line as text first
/// ([`PropertyLines::keep_refused_as_text`]).
pub(super) async fn apply_block_properties(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    block_id: &str,
    properties: &[(String, String)],
    lines: &PropertyLines,
) -> Result<u32, AppError> {
    let mut set: u32 = 0;
    for (key, value) in properties {
        let (value_text, value_num, value_date, value_ref, value_bool) =
            lines.read(key, value).map_err(|reason| {
                let line = lines.typed_line(key, value);
                AppError::validation(format!("`{line}` cannot be saved: {reason}"))
            })?;
        let (_block, prop_op) = agaric_engine::block_ops::set_property_in_tx_with_declaration(
            tx,
            materializer.loro_state(),
            device_id,
            block_id.to_string(),
            key,
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool,
            lines.declaration(key),
        )
        .await?;
        set += 1;
        tx.enqueue_background(prop_op);
    }
    Ok(set)
}

/// The `priority` an import stores for `value`: an Org priority letter, which
/// the parser writes for `[#A]`–`[#C]` (#5160 D7), is the first, second or
/// third built-in level, so a Logseq `[#A]` is what `Ctrl+Shift+1` sets. Any
/// other value is what was written.
pub(super) fn import_priority_value(value: &str) -> String {
    ["A", "B", "C"]
        .iter()
        .position(|letter| *letter == value)
        .and_then(|position| agaric_store::op::PRIORITY_LEVELS.get(position))
        .map_or_else(|| value.to_string(), |level| (*level).to_string())
}

/// #662 — chunked block-insertion loop + final commit. Accumulates into the
/// running counters and returns the per-block-index created ULIDs plus the
/// pending attachment refs consumed by the post-commit phases. Consumes `tx` (it
/// commits the final chunk).
#[allow(clippy::type_complexity)]
pub(super) async fn insert_blocks(
    ctx: &mut ImportCtx<'_>,
    mut tx: CommandTx,
    parse_output: &import::ParseOutput,
    refs: &DocumentRefs,
    vault_files: &[VaultFile],
    counters: &mut ImportCounters,
) -> Result<
    (
        Vec<Option<String>>,
        Vec<(String, Vec<import::AttachmentRef>)>,
    ),
    AppError,
> {
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let pool = ctx.pool;
    let page_id = ctx.page_id.clone();
    let page_title = ctx.page_title.clone();
    let blocks_total = ctx.blocks_total;
    let progress = ctx.progress;
    // #662 — number of blocks written into the *current* chunk's
    // transaction. Reset to 0 each time a chunk is flushed. A new chunk is
    // only opened at a top-level (depth-0) subtree boundary, so a chunk
    // never splits a subtree (parent + all descendants commit together).
    let mut chunk_blocks: usize = 0;
    // #1925 — attachment refs detected per committed content block, collected
    // DURING the block loop but ingested AFTER the import writer tx fully
    // commits (see the post-commit phase below). Each entry is (block_id,
    // detected refs in that block's content). The block content is written with
    // its ORIGINAL refs here; the post-commit phase ingests the matched bytes
    // and edits the block content to the canonical `attachment:<id>` form. This
    // sequencing is what avoids the deadlock: `add_attachment_with_bytes_inner`
    // is pool-based and opens its OWN writer tx, which would deadlock against
    // the held `import_markdown` IMMEDIATE tx — so NO attachment ingest runs
    // while any import chunk tx is open. `vault_files` empty/None ⇒ this stays
    // empty and the whole phase is a no-op.
    let mut pending_attachments: Vec<(String, Vec<import::AttachmentRef>)> = Vec::new();
    let mut parent_stack: Vec<(usize, String)> = vec![(0, page_id.clone())];
    // #2510 — index-aligned with `parse_output.blocks`: the created ULID of
    // each block, or `None` for one skipped by the #1918 recoverable-failure
    // path. Used by the block-anchor resolution pass after this loop to map
    // an anchor's owning `ParsedBlock` INDEX (`anchor_to_block_index`) to the
    // actual block it became.
    let mut created_block_ids: Vec<Option<String>> = vec![None; parse_output.blocks.len()];

    for (block_index, block) in parse_output.blocks.iter().enumerate() {
        // #662 — chunk-boundary flush. We may only break the import into a
        // new transaction at a top-level (depth-0) block: that guarantees
        // the chunk just closed holds whole subtrees (a parent and all its
        // descendants), never a half-written one. Flush when the open
        // chunk has reached the size threshold AND this block starts a new
        // depth-0 subtree. The page + space property written above count
        // toward neither threshold; `chunk_blocks` tracks content blocks.
        if block.depth == 0 && chunk_blocks >= IMPORT_CHUNK_BLOCKS {
            tx = commit_chunk_and_reopen(tx, materializer, pool, &page_title, counters).await?;
            chunk_blocks = 0;
        }

        let parent_id = parent_for_depth(&mut parent_stack, block.depth, &page_id);
        let content = rewrite_block_content_for_import(
            block,
            &refs.links.page_links,
            &refs.links.titles,
            &refs.tag_tokens,
        );
        let detected_attachment_refs =
            detect_import_attachment_refs(&content, block.is_code, vault_files);
        let deferred = ctx.folder && !block.is_code && holds_deferred_ref(&content);

        // The parent stack is NOT pushed for a #1918-skipped block, so any of
        // its children re-parent onto the nearest surviving ancestor (matching
        // the depth-clamp flattening semantics).
        let Some(new_block_id) =
            create_import_block(ctx, &mut tx, content, parent_id, block.depth).await?
        else {
            continue;
        };
        counters.blocks_created += 1;
        chunk_blocks += 1;
        // #2510 — record this ParsedBlock's created ULID by its original
        // document index, for the block-anchor resolution pass below.
        created_block_ids[block_index] = Some(new_block_id.clone());
        parent_stack.push((block.depth, new_block_id.clone()));
        if deferred {
            ctx.deferred.push(new_block_id.clone());
        }

        // #1925 — record this block's detected attachment refs against its now
        // committed-pending id. Ingested + rewritten in the post-commit phase.
        if !detected_attachment_refs.is_empty() {
            pending_attachments.push((new_block_id.clone(), detected_attachment_refs));
        }

        // #128 — per-block progress tick. Emitted inside the loop so a
        // large file shows forward motion; the rows are not yet committed
        // (the `Complete` event after `commit_and_dispatch` is the
        // durability signal).
        if let Some(sink) = progress {
            sink.emit(ImportProgressUpdate::Progress {
                blocks_done: counters.blocks_created,
                blocks_total,
            });
        }

        counters.properties_set += u64::from(
            apply_block_properties(
                &mut tx,
                materializer,
                device_id,
                &new_block_id,
                &block.properties,
                &ctx.lines,
            )
            .await?,
        );
    }

    commit_final_chunk(tx, materializer, &page_title, counters).await?;
    Ok((created_block_ids, pending_attachments))
}

/// #128 / #1932 / #1934 — emit the `Complete` progress event, log the collected
/// diagnostics + completion telemetry, and build the returned [`ImportResult`].
pub(super) fn finish(
    ctx: ImportCtx<'_>,
    counters: &ImportCounters,
    collapsed: Vec<String>,
    anchors: Vec<ImportAnchor>,
) -> ImportResult {
    let &ImportCounters {
        blocks_created,
        properties_set,
        chunks_committed,
    } = counters;
    let ImportCtx {
        progress,
        page_id,
        page_title,
        warnings,
        started_at,
        deferred,
        ..
    } = ctx;
    // #128 — `Complete` is emitted only after the final chunk commits, so
    // a consumer can treat it as the "whole import is durable" signal.
    // Mirrors the returned `ImportResult` counts.
    if let Some(sink) = progress {
        sink.emit(ImportProgressUpdate::Complete {
            page_title: page_title.clone(),
            blocks_created,
            properties_set,
        });
    }

    // #1932 (OBS-LOG-02) — log every collected diagnostic at WARN. Until now
    // warnings lived only in the returned struct (frontend toast), so once the
    // import dialog was dismissed there was no record that, e.g., blocks were
    // flattened or a property/block-ref was dropped. Logging them makes every
    // silently-skipped item recoverable from `agaric.log`.
    if !warnings.is_empty() {
        tracing::warn!(
            page = %page_title,
            count = warnings.len(),
            warnings = ?warnings,
            "import produced parse/apply diagnostics"
        );
    }

    // #1932 / #1934 — completion summary line with the final counts and the
    // measured elapsed time, so a completed import is no longer invisible in
    // logs and its duration/size are observable in the field.
    let elapsed_ms = started_at.elapsed().as_millis();
    tracing::info!(
        page = %page_title,
        blocks_created,
        properties_set,
        warnings = warnings.len(),
        chunks_committed = chunks_committed + 1,
        elapsed_ms,
        "import: completed markdown import"
    );

    ImportResult {
        page_title,
        page_id,
        blocks_created,
        properties_set,
        collapsed,
        warnings,
        anchors,
        deferred,
        merged: None,
    }
}
