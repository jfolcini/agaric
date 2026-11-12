//! Importing a file whose title names a page that holds blocks (#6277
//! decision 7): [`ImportFile`], [`MergeRule`], [`import_target`],
//! [`merge_into_page`], and the read the import dialog lists those pages
//! through, [`list_import_merges`].

use super::*;
use crate::commands::spaces::SpacePageNames;

/// A file an import places ([`create_import_page`]): the space it lands in,
/// the title it imports as, its text, and whether it may merge.
pub(super) struct ImportFile<'a> {
    pub(super) space_id: &'a str,
    pub(super) title: &'a str,
    pub(super) content: &'a str,
    pub(super) rule: MergeRule<'a>,
    /// The titles of the notes of a folder pick, this file's among them;
    /// empty for any other import.
    pub(super) notes: &'a [String],
    /// The files sent with the file, which a merge maps onto the page's own.
    pub(super) vault_files: &'a [VaultFile],
    /// A folder's note: the paths of the pick's notes.
    pub(super) vault_notes: Option<&'a [String]>,
}

/// The page an import writes its file into, open in `tx`: the page it
/// created, titled `title`, or the empty page of the file's title it
/// adopted, with how its property lines read.
pub(super) struct OpenPage {
    pub(super) tx: CommandTx,
    pub(super) page_id: String,
    pub(super) title: String,
    pub(super) lines: PropertyLines,
}

/// Where an import writes its file ([`create_import_page`]).
pub(super) enum ImportPage {
    /// Into this page.
    Write(Box<OpenPage>),
    /// The file merged into the page of its title, which held blocks.
    Merged(Box<MergedPage>),
}

/// A merge's save, and what the file says that the save did not read.
pub(super) struct MergedPage {
    pub(super) page_id: String,
    pub(super) title: String,
    pub(super) saved: WithOps<PageSourceReport>,
    pub(super) source: MergeSource,
}

/// Whether a file merges into the page of its title that holds blocks.
pub(super) struct MergeRule<'a> {
    /// Whether the import reads the file as an outline, a Logseq or Org
    /// file, which merges as its render ([`render_outline`]).
    pub(super) outline: bool,
    /// The pages earlier files of the import's run created or merged into:
    /// two notes of one title in a run are two pages.
    run_pages: &'a [String],
}

impl<'a> MergeRule<'a> {
    /// The rule for a file read in `dialect`, after the files of its run that
    /// wrote `run_pages`.
    pub(super) fn new(dialect: ImportDialect, run_pages: &'a [String]) -> Self {
        Self {
            outline: dialect == ImportDialect::LogseqOrg,
            run_pages,
        }
    }

    fn merges(&self, page_id: &str) -> bool {
        !self.run_pages.iter().any(|id| id == page_id)
    }
}

/// The page a file's title names in a space ([`title_pages`]).
struct TitlePage {
    id: String,
    title: String,
    has_blocks: bool,
}

/// The page each of `titles` names in `space_id` as a file's title (#5160
/// D12): the live page whose title is it under `name_key`, the lowest id
/// where several are, never one holding it as an alias, which names a page
/// of another title.
async fn title_pages(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    titles: &[String],
) -> Result<Vec<Option<TitlePage>>, AppError> {
    let matches = snapshot_page_link_matches(conn, space_id, titles).await?;
    let ids: Vec<Option<&String>> = titles
        .iter()
        .map(|title| matches.folded.get(&agaric_core::tag_norm::name_key(title)))
        .collect();
    let ids_json = serde_json::to_string(&ids.iter().flatten().collect::<Vec<_>>())?;
    let with_blocks: HashSet<String> = sqlx::query_scalar!(
        r#"SELECT DISTINCT parent_id AS "id!: String" FROM blocks
           WHERE parent_id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL"#,
        ids_json,
    )
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    Ok(ids
        .into_iter()
        .map(|id| {
            id.map(|id| TitlePage {
                id: id.clone(),
                title: matches.titles[id].clone(),
                has_blocks: with_blocks.contains(id),
            })
        })
        .collect())
}

/// What an import does with the page of its file's title ([`import_target`]).
pub(super) enum ImportTarget {
    /// Create a page titled this.
    Create(String),
    /// Write into this page, which has no blocks.
    Adopt(String),
    /// Merge into `page_id`, titled `title`.
    Merge { page_id: String, title: String },
}

/// What `file` does with the page of its title in its space. It adopts one
/// with no blocks (the placeholder a `[[link]]` in an earlier file created),
/// so the links to it resolve (#5160 D12). It merges into one with blocks
/// when its rule lets it (#6277 decision 7); otherwise it is a new page under
/// the first free `Title (n)`, with a warning, and leaves the page of its
/// title alone. With no page of that title, it is a new page of its title.
pub(super) async fn import_target(
    conn: &mut sqlx::SqliteConnection,
    file: &ImportFile<'_>,
    warnings: &mut Vec<String>,
) -> Result<ImportTarget, AppError> {
    let (space_id, title, rule) = (file.space_id, file.title, &file.rule);
    let page = title_pages(conn, space_id, &[title.to_owned()])
        .await?
        .pop();
    Ok(match page.flatten() {
        None => ImportTarget::Create(title.to_owned()),
        Some(page) if !page.has_blocks => ImportTarget::Adopt(page.id),
        Some(page) if rule.merges(&page.id) => ImportTarget::Merge {
            page_id: page.id,
            title: page.title,
        },
        Some(_) => {
            let names = SpacePageNames::read(conn, space_id).await?;
            let free = crate::repair::name_collisions::first_free_title(&names, title);
            warnings.push(format!(
                "an earlier file of this import wrote the page '{title}'; the file was imported \
                 as '{free}'"
            ));
            ImportTarget::Create(free)
        }
    })
}

/// Merge `file` into the page `page_id` as an Edit as Markdown save writes
/// its buffer (#6277 decision 7): the page is rendered as its buffer, each
/// line of the file gets the id of the block it pairs with, by its anchor
/// where that names a block of the page and else by
/// [`pair_unanchored_lines`], and [`apply_page_source_inner`] saves the file
/// over the buffer, as one transaction and so one undo, which the op cap
/// refuses as it refuses any save. The file's `# Title` line is its title, as
/// on import, and the file is read as [`merge_source`] reads it; a file read
/// as an outline is its `outline` render. Returns the save's report and the
/// ops it appended, and what the save did not read.
pub(super) async fn merge_into_page(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    page_id: &str,
    file: &ImportFile<'_>,
    outline: Option<&OutlineRender>,
) -> Result<(WithOps<PageSourceReport>, MergeSource), AppError> {
    let buffer = get_page_buffer_inner(pool, page_id).await?;
    let held = held_files(&mut *pool.acquire().await?, page_id).await?;
    let vault = MergeVault {
        files: file.vault_files,
        dir: file.title.rsplit_once('/').map_or("", |(dir, _)| dir),
        notes: file.vault_notes.map(vault_note_titles),
    };
    // An anchor naming no block of the page carries no identity here: the
    // line pairs by its text, as an unanchored one does, and its files are
    // that new block's.
    let own: HashSet<&str> = buffer
        .line_ids
        .iter()
        .flatten()
        .map(String::as_str)
        .collect();
    let content = outline.map_or(file.content, |outline| outline.text.as_str());
    let stripped = import::strip_title_heading(content, file.title);
    let mut source = merge_source(&stripped, &vault, &held, &own);
    let (text, mut anchors) = anchor_free(&source.text);
    let placeholders = outline.map(|_| anchors.clone());
    for anchor in &mut anchors {
        if anchor.as_deref().is_some_and(|id| !own.contains(id)) {
            *anchor = None;
        }
    }
    let (text, named) = strip_named_anchors(&text);
    let mut line_ids = pair_unanchored_lines(&buffer.text, &buffer.line_ids, &text, &anchors);
    let mut text = text;
    if !named.is_empty() {
        // The links to a name are refs to its block once its line has paired,
        // and the lines holding them pair again as refs.
        let (linked, fresh) = link_named_anchors(&text, file.title, &named, &line_ids);
        line_ids = pair_unanchored_lines(&buffer.text, &buffer.line_ids, &linked, &anchors);
        (text, source.named) = (linked, fresh);
    }
    if let (Some(outline), Some(placeholders)) = (outline, &placeholders) {
        // A block's placeholder is the id of the block its line paired with,
        // and the lines holding refs to it pair again as refs.
        let (linked, fresh, folds) =
            link_outline_ids(&text, placeholders, &line_ids, &outline.collapsed);
        line_ids = pair_unanchored_lines(&buffer.text, &buffer.line_ids, &linked, &anchors);
        text = linked;
        source.named.extend(fresh);
        source.collapsed = folds;
    }
    let flags = SourceSaveFlags {
        merge: false,
        line_ids,
    };
    let saved = capture_op_refs(Box::pin(apply_page_source_inner(
        pool,
        device_id,
        materializer,
        page_id,
        text,
        buffer.source,
        flags,
    )))
    .await?;
    Ok((saved, source))
}

/// The [`ImportResult`] of a merge into `page_id`, titled `title`, after its
/// `Complete` event.
pub(super) fn merged_result(
    progress: Option<&dyn ImportProgressSink>,
    page_id: String,
    title: String,
    merged: WithOps<PageSourceReport>,
) -> ImportResult {
    let WithOps {
        inner: report,
        op_refs,
    } = merged;
    let (blocks_created, properties_set) = (report.created.into(), report.properties_set.into());
    if let Some(sink) = progress {
        sink.emit(ImportProgressUpdate::Complete {
            page_title: title.clone(),
            blocks_created,
            properties_set,
        });
    }
    tracing::info!(
        page = %title,
        blocks_created,
        edited = report.edited,
        deleted = report.deleted,
        warnings = report.warnings.len(),
        "import: merged into the page of its title"
    );
    ImportResult {
        page_title: title,
        page_id,
        blocks_created,
        properties_set,
        collapsed: Vec::new(),
        warnings: report.warnings,
        anchors: Vec::new(),
        deferred: Vec::new(),
        merged: Some(op_refs),
    }
}

/// A page an import merges a file into (#6277 decision 7).
#[derive(Debug, Clone, Serialize, Type)]
pub struct ImportMerge {
    pub page_id: String,
    pub title: String,
}

/// The pages of `space_id` that importing `filenames`, each a Markdown file
/// sent with no vault, merges into, as the import dialog lists them: the page
/// each file's title names that holds blocks, once each, in the order the
/// files name them.
///
/// # Errors
///
/// [`AppError::Database`] when the read fails.
#[instrument(skip(pool, filenames), err)]
pub async fn list_import_merges_inner(
    pool: &SqlitePool,
    space_id: &str,
    filenames: Vec<String>,
) -> Result<Vec<ImportMerge>, AppError> {
    let titles: Vec<String> = filenames
        .into_iter()
        .map(|name| import_title(Some(name)))
        .collect();
    let mut tx = pool.begin().await?;
    let pages = title_pages(&mut tx, space_id, &titles).await?;
    tx.commit().await?;
    let mut listed = HashSet::new();
    Ok(pages
        .into_iter()
        .flatten()
        .filter(|page| page.has_blocks && listed.insert(page.id.clone()))
        .map(|page| ImportMerge {
            page_id: page.id,
            title: page.title,
        })
        .collect())
}

/// Tauri command: the pages an import of `filenames` merges into. Delegates to
/// [`list_import_merges_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_import_merges(
    read_pool: State<'_, ReadPool>,
    space_id: SpaceId,
    filenames: Vec<String>,
) -> Result<Vec<ImportMerge>, AppError> {
    space_id.validate_shape()?;
    list_import_merges_inner(&read_pool.0, space_id.as_str(), filenames)
        .await
        .map_err(sanitize_internal_error)
}
