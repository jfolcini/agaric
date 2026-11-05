//! Markdown export / import command handlers (#644 split).
//!
//! `export_page_markdown`, `import_markdown` and their `*_inner` cores plus
//! the progress-streaming import variant and the ULID-resolution helper.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::import::ImportProgressSink;
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_core::ulid::{BlockId, PageId};
use agaric_engine::import;
use agaric_engine::import::{
    ImportAnchor, ImportDialect, ImportProgressUpdate, ImportResult, VaultFile, is_escaped,
    percent_decode,
};
use agaric_store::pagination::{BlockRow, Cursor, NULL_POSITION_SENTINEL, PageRequest};
use agaric_store::space::SpaceId;

use super::super::*;
// The moved seam modules name these by `super::` paths.
use super::{aliases, inline_query_md, markdown_yaml};

/// Export a page and its full descendant subtree as a Markdown string with
/// human-readable tag/page references and optional YAML frontmatter.
///
/// 1. If the page has properties, emits a `---` YAML frontmatter block
/// 2. Emits `# Page Title`
/// 3. For each descendant block — direct children **and** transitively
///    nested blocks — ordered by `(position, id)` over the keyset,
///    resolves `#[ULID]` and `[[ULID]]` references to their human-readable
///    names, preserving all markdown formatting.
///
/// The descendant walk is cursor-paginated through the denormalized
/// `page_id` column (`idx_blocks_page_id`) and accumulates every page of
/// rows into a single `Vec<BlockRow>` — there is no silent truncation.
/// Tag and page reference targets are resolved with one batched
/// `json_each(?)` query: pre-fix the function loaded *every*
/// non-deleted tag and page in the vault on every export.
///
/// # Errors
///
/// - [`AppError::Validation`] — `page_id` does not refer to a `page` block
/// - [`AppError::NotFound`] — block not found
#[instrument(skip(pool), err)]
pub async fn export_page_markdown_inner(
    pool: &SqlitePool,
    page_id: &str,
) -> Result<String, AppError> {
    // Validate ULID format upfront so malformed inputs surface
    // `AppError::Ulid` rather than the imprecise `AppError::NotFound`
    // that the SQL `WHERE id = ?` lookup would otherwise produce.
    BlockId::from_string(page_id)?;

    // #660 — open ONE read transaction and run every read below through
    // it so the entire export observes a single, consistent WAL
    // snapshot. Pre-fix the keyset descendant walk issued N independent
    // `fetch_all(pool)` calls, each taking its own snapshot; a
    // concurrent edit/move/delete landing between two pages of the
    // keyset could skip or duplicate blocks in the exported markdown.
    // `pool.begin()` opens a `BEGIN DEFERRED` transaction (read-only —
    // every statement here is a SELECT, so no writer lock is taken);
    // SQLite pins the snapshot at the first read and holds it until the
    // tx drops. The page-row lookup, descendant walk, reference
    // resolution and property reads all execute against `&mut *tx`, so
    // they cannot interleave with a concurrent writer's commit.
    let mut tx = pool.begin().await?;
    let data = load_page_export_data(&mut tx, page_id, PageRead::Export).await?;

    // #660 — all reads are done; release the snapshot tx. A read-only
    // `BEGIN DEFERRED` tx takes no writer lock, so the `commit` here is
    // effectively a rollback (nothing was written); committing rather
    // than letting the tx drop makes the snapshot-release point explicit
    // and returns the connection to the pool promptly.
    tx.commit().await?;

    // 5. Render. The read half above is the only thing that touches the
    //    database; everything below is a pure function of what it resolved
    //    (#4639).
    Ok(render_page_markdown(page_id, &data))
}

/// The page as the MCP `get_page_markdown` tool returns it (#5375, #6277 E4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPage {
    /// The page's title, which the Markdown has no line for.
    pub title: String,
    /// The page's buffer ([`get_page_buffer_inner`]'s `source`), a stretch at a
    /// time.
    pub markdown: String,
    /// The block the next stretch starts at, `None` at the end of the page.
    pub next_cursor: Option<String>,
}

/// The page's buffer, the text Edit as Markdown edits and `edit_page_markdown`
/// takes as its base, a stretch at a time (#5402): from `cursor`'s block, or
/// from the top, cut at a block boundary within `max_bytes` but never short of
/// one block. Read in turn, the stretches are the buffer.
///
/// # Errors
///
/// As [`export_page_markdown_inner`], and [`AppError::Validation`] for a
/// cursor whose block is no longer on the page, rather than skipping the
/// blocks after it.
#[instrument(skip(pool), err)]
pub async fn get_page_for_agent_inner(
    pool: &SqlitePool,
    page_id: &str,
    cursor: Option<&str>,
    max_bytes: usize,
) -> Result<AgentPage, AppError> {
    BlockId::from_string(page_id)?;
    let mut tx = pool.begin().await?;
    let data = load_page_export_data(&mut tx, page_id, PageRead::Buffer).await?;
    tx.commit().await?;
    let (source, starts) = render_page_document_spans(&data);
    let (markdown, next_cursor) = agent_markdown_stretch(&source, &starts, cursor, max_bytes)?;
    Ok(AgentPage {
        title: data.page.content.unwrap_or_default(),
        markdown,
        next_cursor,
    })
}

/// A page's source buffer as the ids-beside-the-text editor reads it (#5160
/// A): the anchored `source`, which a save sends back as its `base_source`,
/// and the same buffer as `text`, its anchors removed, with the id each line
/// of the text carries in `line_ids`, one entry per line.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PageBuffer {
    pub source: String,
    pub text: String,
    /// `Some` on the line a block starts on; `None` on a continuation,
    /// property or blank line.
    pub line_ids: Vec<Option<String>>,
}

/// The page's buffer (#5140), in the Document dialect (#5691), with each
/// block's id beside its text rather than in it (#5160 A): the page's front
/// matter and block tree, every block with its `^ID`, and the same buffer less
/// its anchors, with the id each line carries. The page and tag names it may
/// write are resolved in the same read snapshot as the content.
///
/// # Errors
///
/// As [`export_page_markdown_inner`].
#[instrument(skip(pool), err)]
pub async fn get_page_buffer_inner(
    pool: &SqlitePool,
    page_id: &str,
) -> Result<PageBuffer, AppError> {
    BlockId::from_string(page_id)?;
    let mut tx = pool.begin().await?;
    let data = load_page_export_data(&mut tx, page_id, PageRead::Buffer).await?;
    tx.commit().await?;
    let (source, _) = render_page_document(&data);
    let (text, line_ids) = anchor_free(&source);
    Ok(PageBuffer {
        source,
        text,
        line_ids,
    })
}

/// The page as the Markdown mirror writes its file (#5363), read in one
/// snapshot as the buffer is, with the names the buffer may write.
///
/// # Errors
///
/// As [`export_page_markdown_inner`].
#[instrument(skip(pool), err)]
pub async fn get_page_file_inner(pool: &SqlitePool, page_id: &str) -> Result<PageFile, AppError> {
    BlockId::from_string(page_id)?;
    let mut tx = pool.begin().await?;
    let data = load_page_export_data(&mut tx, page_id, PageRead::File).await?;
    tx.commit().await?;
    Ok(render_page_file(&data))
}

/// The blocks `block_ids` names as the clipboard carries them (#5140): the
/// page's buffer in the Document dialect (#6190), which a paste reads back,
/// for just those blocks, each with its subtree unless `with_children` is
/// false, in document order, and with a `^ID` only where a block needs one to
/// read back. The page is the first live content block's;
/// an id that is not a live content block of that page is skipped, and so is
/// one under another selected block, which carries it. Nothing to copy is `""`.
///
/// # Errors
///
/// - [`AppError::Validation`] — more ids than one batch takes
#[instrument(skip(pool, block_ids), err)]
pub async fn get_blocks_source_inner(
    pool: &SqlitePool,
    block_ids: Vec<BlockId>,
    with_children: bool,
) -> Result<String, AppError> {
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;
    let ids: Vec<String> = block_ids.into_iter().map(BlockId::into_string).collect();
    let ids_json = serde_json::to_string(&ids)?;
    let mut tx = pool.begin().await?;
    let page_id = sqlx::query_scalar!(
        r#"SELECT b.page_id AS "page_id!: String"
             FROM json_each(?1) je
             JOIN blocks b ON b.id = je.value
            WHERE b.deleted_at IS NULL
              AND b.block_type = 'content'
              AND b.page_id IS NOT NULL
            ORDER BY je.key
            LIMIT 1"#,
        ids_json,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(page_id) = page_id else {
        return Ok(String::new());
    };
    let data = load_page_export_data(&mut tx, &page_id, PageRead::Buffer).await?;
    tx.commit().await?;
    Ok(render_clipboard_source(&data, &ids, with_children))
}

/// Copy a content block and its content subtree to right after the original
/// (#5140), as one transaction and so one undo. The subtree is rendered as a
/// Document buffer (#6190) and parsed back, so the copy carries what that
/// buffer carries: content verbatim with its raw refs, the list marker, the
/// task state, priority and dates, and the custom properties. A task has no
/// list style there (#5691 D3), so the copy of a block holding both is a task
/// without one. A nested page is not copied. Returns every created row, the
/// root copy first, then its descendants depth-first.
///
/// # Errors
///
/// - [`AppError::Ulid`] — `block_id` is not a ULID
/// - [`AppError::NotFound`] — no block has that id
/// - [`AppError::Validation`] — the block is soft-deleted or not a content
///   block, a copied value doesn't read back from the buffer's grammar (a
///   carriage return in the text), the copy would append more ops than one
///   undo reverts, or a copied block would be nested past `MAX_BLOCK_DEPTH`
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn duplicate_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
) -> Result<Vec<BlockRow>, AppError> {
    let block_id = BlockId::from_string(block_id.into_string())?;
    let mut tx = CommandTx::begin_immediate(pool, "duplicate_block").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let root = agaric_engine::block_ops::fetch_live_block_in_tx(&mut tx, block_id.as_str()).await?;
    if root.block_type != "content" {
        return Err(AppError::validation(format!(
            "only a content block can be duplicated, not a '{}'",
            root.block_type
        )));
    }
    let page_id = root
        .page_id
        .clone()
        .ok_or_else(|| AppError::validation(format!("block '{block_id}' is on no page")))?;
    let data = load_page_export_data(&mut tx, page_id.as_str(), PageRead::Duplicate).await?;
    let (source, ids) = render_subtree(&data, &root);
    let parsed = import::parse_document_outline(&source);
    // A value the grammar cannot carry, such as a carriage return in the
    // text, reads back as extra text or an extra block: refuse, never write a
    // mangled copy.
    let anchors = parsed.blocks.iter().map(|b| b.block_anchor.as_deref());
    if !anchors.eq(ids.iter().map(|id| Some(id.as_str()))) {
        return Err(AppError::validation(format!(
            "block '{block_id}' holds a value Duplicate cannot copy"
        )));
    }
    let lines = PropertyLines::load_for_block(&mut tx, &page_id, PropertyWrite::Copy).await?;
    let parent_id = root.parent_id.map(BlockId::into_string);
    let siblings =
        super::super::blocks::move_ops::ordered_live_children(&mut tx, parent_id.as_deref())
            .await?;
    let index = siblings
        .iter()
        .position(|id| id == block_id.as_str())
        .map(|slot| i64::try_from(slot + 1).expect("a Vec index fits in i64"));
    // Boxed: inline, the copy loop's future makes this one too large for the
    // stack (`clippy::large_futures`).
    let created = Box::pin(create_parsed_blocks(
        &mut tx,
        materializer,
        device_id,
        parent_id,
        index,
        &parsed.blocks,
        &lines,
    ))
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(created)
}

/// Paste `input` right after the anchor block (#5140), as one transaction and
/// so one undo. Text is read by [`import::parse_pasted_text`]; each of
/// `blocks` is one block as it comes. A page link or tag written as a name is
/// resolved in the anchor's space as an import resolves it, creating the page
/// or tag when no name there matches; ids and block refs stay as written, but
/// one whose target is in another space is written as the text its chip shows
/// (#6277 B2), and an `^anchor` in the text never pairs with a block. The
/// top-level blocks land in order right after the anchor among its siblings,
/// each deeper one under its parsed parent, with its task state, priority,
/// dates, list style and properties. Returns the pages and tags the names
/// created, then the pasted blocks in document order.
///
/// With a `splice`, the paste goes into the anchor's text (#5160 D4). The
/// anchor becomes the first block, `before` + its content, and keeps its id,
/// place, other properties and children: with nothing before the cursor, as
/// at the start of a plain paragraph, it takes the first block's properties;
/// after text it takes the block as the text it was pasted as. A heading's or
/// a quote's marker is text before the cursor, so such a block keeps its type
/// and takes the first line as text. The first block's children follow the
/// anchor's own; `after` ends the last block, or follows a last block that is
/// code as a block of its own. The anchor is then the first pasted block
/// returned. The names in `before` and `after` are left as they are.
///
/// A property line a definition refuses stays text at the end of its block,
/// and the reply's warnings name each (#5160 D11) and count the refs
/// written as text.
///
/// # Errors
///
/// - [`AppError::Ulid`] — `anchor_block_id` is not a ULID
/// - [`AppError::NotFound`] — no block has that id
/// - [`AppError::Validation`] — the input holds no block, the anchor is
///   soft-deleted or not a content block, the paste would append more ops
///   than one undo reverts, or a block would be nested past `MAX_BLOCK_DEPTH`
#[instrument(skip(pool, device_id, materializer, input, splice), err)]
pub async fn paste_blocks_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    anchor_block_id: BlockId,
    input: PasteInput,
    splice: Option<PasteSplice>,
) -> Result<PastedBlocks, AppError> {
    let anchor_id = BlockId::from_string(anchor_block_id.into_string())?;
    let (mut blocks, read_warnings) =
        input.into_blocks(splice.as_ref().is_some_and(|s| !s.before.is_empty()));
    if blocks.is_empty() {
        return Err(AppError::validation("there is nothing to paste".into()));
    }
    if let Some(splice) = &splice {
        splice.inline_joined_blocks(&mut blocks);
    }
    let mut tx = CommandTx::begin_immediate(pool, "paste_blocks").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let anchor =
        agaric_engine::block_ops::fetch_live_block_in_tx(&mut tx, anchor_id.as_str()).await?;
    if anchor.block_type != "content" {
        return Err(AppError::validation(format!(
            "blocks can only be pasted after a content block, not a '{}'",
            anchor.block_type
        )));
    }
    let (mut tx, lines, warnings, mut created) = Box::pin(read_pasted_blocks(
        tx,
        materializer,
        device_id,
        &anchor,
        &mut blocks,
    ))
    .await?;
    let parent_id = anchor.parent_id.map(BlockId::into_string);
    let siblings =
        super::super::blocks::move_ops::ordered_live_children(&mut tx, parent_id.as_deref())
            .await?;
    let index = siblings
        .iter()
        .position(|id| id == anchor_id.as_str())
        .map(|slot| i64::try_from(slot + 1).expect("a Vec index fits in i64"));
    let spliced = match splice {
        Some(splice) => {
            splice.join(&mut blocks);
            let into = Box::pin(splice_into_anchor(
                &mut tx,
                materializer,
                &lines,
                device_id,
                &anchor_id,
                &blocks,
            ));
            into.await?
        }
        None => Vec::new(),
    };
    let pasted = Box::pin(create_parsed_blocks(
        &mut tx,
        materializer,
        device_id,
        parent_id,
        index,
        &blocks[spliced.len()..],
        &lines,
    ))
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    created.extend(spliced);
    created.extend(pasted);
    Ok(PastedBlocks {
        blocks: created,
        warnings: [read_warnings, warnings].concat(),
    })
}

/// Append `markdown` under `parent_id` (#5376) exactly as a paste lands it,
/// as one transaction and so one undo: read by [`import::parse_pasted_text`],
/// names resolved in the parent's space, creating the page or tag no name
/// there matches, and property lines read as [`paste_blocks_inner`] reads
/// them. The top-level blocks land in order from the 0-based `index` among
/// the parent's children, or at the end with none; each deeper one under its
/// parsed parent. Returns the pages and tags the names created, then the
/// appended blocks in document order.
///
/// # Errors
///
/// - [`AppError::Ulid`] — `parent_id` is not a ULID
/// - [`AppError::NotFound`] — no block has that id
/// - [`AppError::Validation`] — the markdown holds no block, the parent is
///   soft-deleted, the append would append more ops than one undo reverts,
///   or a block would be nested past `MAX_BLOCK_DEPTH`
#[instrument(skip(pool, device_id, materializer, markdown), err)]
pub async fn append_markdown_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    parent_id: BlockId,
    markdown: &str,
    index: Option<i64>,
) -> Result<PastedBlocks, AppError> {
    let parent_id = BlockId::from_string(parent_id.into_string())?;
    let mut tx = CommandTx::begin_immediate(pool, "append_markdown").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let (tx, appended) = Box::pin(append_markdown_in_tx(
        tx,
        materializer,
        device_id,
        &parent_id,
        markdown,
        index,
    ))
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(appended)
}

/// Import a Markdown file as a page with block hierarchy, read as a paste
/// reads text (`ImportDialect::Markdown`, #6277 decision 1).
///
/// Creates a page from the filename (or first heading), then creates
/// blocks following the indentation hierarchy. Properties are set via
/// SetProperty ops. Returns import statistics.
///
/// #662 — Chunked, atomic-subtree semantics (relaxes the original
/// single-transaction contract). The import is split into a sequence of
/// `BEGIN IMMEDIATE` transactions so the single SQLite writer lock is
/// acquired and released per chunk rather than held for the whole
/// (unbounded) import — interleaved writes and the UI can proceed between
/// chunks. See [`import_markdown_with_progress`] for the full chunk-
/// boundary and partial-import contract. A failure anywhere still surfaces
/// as `Err(AppError)`; `result.warnings` is reserved for non-transactional
/// parse diagnostics from [`import::parse_markdown_file`] (e.g. depth
/// clamping). Savepoint-based partial recovery was considered and rejected
/// as too invasive for the available signal.
#[instrument(
    skip(pool, device_id, materializer, content, app_data_dir, vault_files),
    err
)]
#[allow(clippy::too_many_arguments)]
pub async fn import_markdown_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &std::path::Path,
    content: String,
    filename: Option<String>,
    space_id: String,
    // #1925 — referenced sibling files' bytes. `None`/empty ⇒ exactly the
    // pre-#1925 behaviour (no attachment ingest).
    vault_files: Option<Vec<VaultFile>>,
) -> Result<ImportResult, AppError> {
    // Progress-free path (MCP tools, sync replay, scripted imports, tests
    // / benches). The Tauri command calls
    // [`import_markdown_with_progress`] with a live channel sink instead.
    import_markdown_with_progress(
        pool,
        device_id,
        materializer,
        app_data_dir,
        content,
        filename,
        space_id,
        ImportDialect::Markdown,
        vault_files,
        None,
        None,
    )
    .await
}

/// Progress-streaming core of [`import_markdown_inner`] (#128).
///
/// # #662 — chunked writer-lock release
///
/// The import is written as a *sequence* of `BEGIN IMMEDIATE`
/// transactions (chunks) instead of one transaction spanning the whole
/// file. Each chunk acquires the single SQLite writer lock, commits, and
/// releases it; between chunks the lock is free, so a multi-MB import no
/// longer blocks every other write (or the UI) for its full duration.
///
/// ## Chunk boundaries — never split a subtree
///
/// A chunk is only ever closed at a **top-level (depth-0) subtree
/// boundary**: blocks accumulate into the open transaction and the chunk
/// is flushed (committed) only once it holds at least
/// [`IMPORT_CHUNK_BLOCKS`] blocks *and* the next parsed block starts a new
/// depth-0 subtree. Consequently a parent block and every one of its
/// descendants always land in the **same** transaction — a child is never
/// committed without its parent, and a parent is never committed missing
/// any of its (parsed) children. The page block + its `space` property are
/// written in the first chunk together with the first subtree(s).
///
/// Cross-chunk parent references are sound: a block's `parent_id` may point
/// at a block committed in an *earlier* chunk (e.g. the page itself, or a
/// preceding top-level subtree's root is never a parent of a later one), and
/// `create_block_in_tx`'s `WHERE id = ? AND deleted_at IS NULL` parent check
/// sees the committed row.
///
/// ## Partial-import semantics
///
/// If the import is interrupted mid-way (process crash, or an in-tx error
/// that rolls back the *current* chunk), the visible, durable state is the
/// page plus a **prefix of its complete top-level subtrees** — every
/// committed subtree is whole and navigable, and no half-written subtree,
/// orphaned child, or parent-missing-children state is ever exposed. This
/// Relaxes the original "all-or-nothing for the whole file" contract
/// to "all-or-nothing per chunk" (a deliberate trade for the lock-hold fix
/// — see #662). Imports small enough to fit in a single chunk (the common
/// case, `<= IMPORT_CHUNK_BLOCKS` blocks) keep the original whole-import
/// atomicity: there is exactly one chunk, so a mid-import error rolls back
/// everything including the page.
///
/// ## Op-log / materializer correctness
///
/// Each chunk's ops still go through the normal `append_local_op_in_tx`
/// path inside the chunk's transaction and are dispatched (in FIFO order)
/// by that chunk's `commit_and_dispatch` only *after* the chunk commits —
/// identical to the single-transaction path, just repeated per chunk.
/// Global op ordering is preserved because chunks commit strictly in
/// sequence (the next chunk's `BEGIN IMMEDIATE` cannot start until the
/// previous chunk has committed and released the lock).
///
/// ## Progress events
///
/// When `progress` is `Some`, the function emits:
///
///   1. one [`ImportProgressUpdate::Started`] before any block is written,
///   2. one [`ImportProgressUpdate::Progress`] after each block create,
///   3. one [`ImportProgressUpdate::Complete`] **after the final chunk
///      commits** — never before, so a `Complete` event always implies the
///      whole import is durable.
///
/// On any error the function returns `Err` before reaching the `Complete`
/// emit, so a consumer that sees `Started` but no `Complete` must treat the
/// import as failed (possibly partially-applied per the chunk semantics
/// above). Sends are best-effort (see [`ImportProgressSink`]).
// #1934 — declare identifying span fields up front so the import span can be
// filtered/grouped by target space and size. `content`, `progress`, and the
// heavy handles are `skip`-ped; `space_id` is recorded here (it is an arg)
// while `blocks_total` is derived inside and back-filled via
// `Span::current().record(...)` once known.
//
// #3317 — `page_title` used to be a third span field here. It is user content:
// the title is derived from the imported filename, so it is a real name (often
// a real vault path) out of the user's notes. A span attribute has NO redaction
// boundary in front of it — `agaric_observability::exporter::format_span`
// writes attributes verbatim into `traces/*.log`, and the opt-in OTLP exporter
// ships them to the collector — while SECURITY.md promises spans carry "opaque
// ids / counts / enums / durations / booleans only, never note content". The
// title is still logged as a `tracing::info!` FIELD below, where the
// bug-report redactor's deny-by-default pass covers it in both `agaric.log`
// (JSON path) and `otel-logs/` (key=value path). Enforced by
// `commands::observability::tests::span_fields_stay_on_the_pii_allowlist`.
#[instrument(
    skip(
        pool,
        device_id,
        materializer,
        content,
        progress,
        app_data_dir,
        vault_files,
        vault_notes
    ),
    fields(blocks_total = tracing::field::Empty, space = %space_id),
    err
)]
#[allow(clippy::too_many_arguments)]
pub async fn import_markdown_with_progress(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &std::path::Path,
    content: String,
    filename: Option<String>,
    space_id: String,
    dialect: ImportDialect,
    // #1925 — referenced sibling files' bytes. `None`/empty ⇒ no attachment
    // ingest (exact pre-#1925 behaviour).
    vault_files: Option<Vec<VaultFile>>,
    // #5740 — the folder pick's `.md` paths a `[[Name]]` here may name.
    vault_notes: Option<Vec<String>>,
    progress: Option<&dyn ImportProgressSink>,
) -> Result<ImportResult, AppError> {
    // #1934 — wall-clock measurement of the whole import so duration is
    // observable in the field. Paired with the completion summary log below.
    let started_at = std::time::Instant::now();

    // Normalize ULID to uppercase per AGENTS.md
    // invariant #8. Mirrors `create_page_in_space_inner` so a raw String
    // arg from MCP tools / sync replay / scripted imports can never land
    // a page whose `space` ref disagrees with the case-sensitive
    // `block_properties.value_ref` lookup downstream.
    let space_id = space_id.to_ascii_uppercase();

    let (mut parse_output, page_title) = parse_import_payload(
        &content,
        filename,
        dialect,
        vault_files.as_deref(),
        vault_notes.as_deref(),
    )?;
    let blocks_total = parse_output.blocks.len() as u64;
    announce_import_start(
        progress,
        &page_title,
        blocks_total,
        &space_id,
        dialect,
        parse_output.warnings.len(),
    );

    let (mut tx, page_id) = create_import_page(
        pool,
        materializer,
        device_id,
        &space_id,
        &page_title,
        &mut parse_output.warnings,
    )
    .await?;
    let mut lines =
        PropertyLines::load(&mut tx, Some(space_id.as_str()), PropertyWrite::Import).await?;
    let values = parse_output
        .blocks
        .iter()
        .flat_map(|block| &block.properties);
    lines.resolve_refs(&mut tx, Some(&space_id), values).await?;
    lines.keep_refused_as_text(&mut parse_output.blocks, &mut parse_output.warnings);

    let mut counters = ImportCounters::default();
    // Bundle the read-only handles + derived identity + the running `warnings`
    // list that every phase appends to, so the phase helpers below take one
    // `&mut ImportCtx` instead of a long, repeated argument list. `warnings` is
    // seeded from the parser's diagnostics (`std::mem::take` leaves the parsed
    // struct otherwise intact so its other fields are still read by the phases).
    let mut ctx = ImportCtx {
        pool,
        device_id,
        materializer,
        app_data_dir,
        progress,
        started_at,
        space_id,
        page_id,
        page_title,
        blocks_total,
        lines,
        warnings: std::mem::take(&mut parse_output.warnings),
        folder: vault_notes.is_some(),
        deferred: Vec::new(),
    };

    let (tx, refs) = resolve_document_refs(&mut ctx, tx, &parse_output, &mut counters).await?;

    // #2724 — the post-commit ingest (`ingest_attachments`) takes ownership of
    // these files so it can MOVE each single-attempt file's bytes out
    // (`std::mem::take`) on its last ingest instead of cloning them.
    let vault_files: Vec<VaultFile> = vault_files.unwrap_or_default();

    // #662 — chunked block insertion.
    let (created_block_ids, pending_attachments) = insert_blocks(
        &mut ctx,
        tx,
        &parse_output,
        &refs,
        &vault_files,
        &mut counters,
    )
    .await?;

    // #2510 / #2567 — post-commit anchor resolution + block-ref rewrite.
    resolve_anchor_links(&mut ctx, &parse_output, &created_block_ids, &refs).await;

    // #1925 — post-commit attachment ingest + content rewrite.
    ingest_attachments(&mut ctx, vault_files, pending_attachments).await;

    let (collapsed, anchors) = marked_blocks(&ctx.page_id, &parse_output, &created_block_ids);
    // #128 / #1932 / #1934 — completion event + diagnostics/telemetry logging.
    Ok(finish(ctx, &counters, collapsed, anchors))
}

/// The end of a folder import: link each reference its notes' imports left in
/// `blocks` ([`ImportResult::deferred`]), once every note's blocks exist. A
/// `[[ULID#anchor]]` link (`DEFERRED_LINK_RE`) is a ref to the block its
/// anchor names on that page: the block of that `^id` among `anchors`, the
/// notes' [`ImportResult::anchors`], else what an import finds there, the
/// first heading of that text or the block of that id; else it links the
/// page, with its label. A Logseq `((uuid))` is a ref to the block whose
/// `id::` names it among `anchors`, else stripped as an import strips it. A
/// block not live in `space_id` is left alone. Each block that changes is
/// edited once, and one that cannot be is warned of rather than failing the
/// pass, which runs after the imports are durable. Returns the warnings.
#[instrument(skip(pool, device_id, materializer, anchors, blocks), err)]
pub async fn link_import_anchors_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    anchors: &[ImportAnchor],
    blocks: &[BlockId],
) -> Result<Vec<String>, AppError> {
    let contents = live_contents(pool, space_id, blocks).await?;
    let pages: HashSet<&str> = contents
        .iter()
        .flat_map(|(_, content)| DEFERRED_LINK_RE.captures_iter(content))
        .map(|caps| caps.get(1).expect("group 1 always present").as_str())
        .collect();
    let candidates = load_anchor_candidates(&mut *pool.acquire().await?, &pages).await?;
    let by_id: HashMap<&str, &AnchorCandidate> =
        candidates.iter().map(|c| (c.id.as_str(), c)).collect();
    let named: HashMap<(&str, &str), &str> = anchors
        .iter()
        .map(|a| ((a.page_id.as_str(), a.anchor.as_str()), a.block_id.as_str()))
        .collect();
    let by_uuid: HashMap<&str, &str> = anchors
        .iter()
        .map(|a| (a.anchor.as_str(), a.block_id.as_str()))
        .collect();
    let target = |page: &str, anchor: &str| {
        obsidian_block_anchor_id(anchor)
            .and_then(|id| named.get(&(page, id)).copied())
            .or_else(|| anchor_block(&candidates, &by_id, page, anchor))
            .map(str::to_string)
    };
    let mut outcomes = DeferredOutcomes::default();
    let mut warnings = Vec::new();
    for (id, content) in &contents {
        let linked = link_deferred_links(content, target, &mut outcomes);
        let (linked, stripped) = import::link_logseq_refs(&linked, |uuid| {
            by_uuid.get(uuid).copied().map(str::to_string)
        });
        outcomes.stripped_refs += stripped;
        if linked == *content {
            continue;
        }
        let block = BlockId::from_trusted(id);
        if let Err(e) = crate::commands::blocks::crud::edit_block_inner(
            pool,
            device_id,
            materializer,
            block,
            linked,
        )
        .await
        {
            tracing::warn!(block_id = %id, error = %e, "import: deferred link rewrite failed");
            warnings.push(format!(
                "block '{id}' link(s) into other notes could not be rewritten ({e})"
            ));
        }
    }
    warn_dropped_anchors(&mut warnings, outcomes.dropped_anchors);
    warn_dropped_labels(&mut warnings, outcomes.dropped_labels);
    if outcomes.stripped_refs > 0 {
        warnings.push(format!(
            "{} ((block-ref)) reference(s) were stripped from imported content and could not be \
             preserved",
            outcomes.stripped_refs
        ));
    }
    Ok(warnings)
}

/// Tauri command: export a page as Markdown. Delegates to [`export_page_markdown_inner`].
#[tauri::command]
#[specta::specta]
pub async fn export_page_markdown(
    read_pool: State<'_, ReadPool>,
    page_id: PageId,
) -> Result<String, AppError> {
    export_page_markdown_inner(&read_pool.0, page_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: a page's buffer with each block's id beside its text.
/// Delegates to [`get_page_buffer_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_page_buffer(
    read_pool: State<'_, ReadPool>,
    page_id: PageId,
) -> Result<PageBuffer, AppError> {
    get_page_buffer_inner(&read_pool.0, page_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: render blocks as clipboard markdown. Delegates to
/// [`get_blocks_source_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_blocks_source(
    read_pool: State<'_, ReadPool>,
    block_ids: Vec<BlockId>,
    with_children: bool,
) -> Result<String, AppError> {
    get_blocks_source_inner(&read_pool.0, block_ids, with_children)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: duplicate a block and its content subtree right after the
/// original. Delegates to [`duplicate_block_inner`].
#[tauri::command]
#[specta::specta]
pub async fn duplicate_block(
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
) -> Result<WithOps<CreatedBlocks>, AppError> {
    capture_op_refs(async {
        duplicate_block_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), block_id)
            .await
            .map(|blocks| CreatedBlocks { blocks })
    })
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: paste clipboard text or structured blocks right after the
/// anchor block, or into its text with a `splice`. Delegates to
/// [`paste_blocks_inner`].
#[tauri::command]
#[specta::specta]
pub async fn paste_blocks(
    ctx: State<'_, WriteCtx>,
    anchor_block_id: BlockId,
    input: PasteInput,
    splice: Option<PasteSplice>,
) -> Result<WithOps<PastedBlocks>, AppError> {
    capture_op_refs(paste_blocks_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        anchor_block_id,
        input,
        splice,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// What a folder pick sends with one of its notes ([`import_markdown`]). A note
/// sent with it leaves its references into other notes for
/// [`link_import_anchors`], which the pick calls once every note is imported.
#[derive(Debug, Deserialize, Type)]
pub struct VaultImport {
    /// The bytes of the sibling files the note references (#1925).
    #[serde(default)]
    pub files: Vec<VaultFile>,
    /// The pick's `.md` paths, as `filename` gives them, a `[[Name]]` in the
    /// note may name (#5740).
    #[serde(default)]
    pub notes: Vec<String>,
}

/// Tauri command: import a Markdown, Logseq or Org file, in the `dialect` its
/// front end read it as, as a page with block hierarchy. Delegates to
/// [`import_markdown_with_progress`].
///
/// `space_id` is required. The imported page is
/// stamped with `space = ?space_id` inside the same transaction as the
/// `CreateBlock` op, so an imported page can never exist in the op log
/// Without its space property (invariant). Validation against a
/// live space block happens TOCTOU-safe inside the same transaction.
///
/// #128 — `progress` streams per-block import
/// progress to the frontend. The frontend always supplies a
/// `Channel<ImportProgressUpdate>` (mirroring `start_sync`); sends are
/// best-effort, so a dropped channel never aborts the import.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn import_markdown(
    app: tauri::AppHandle,
    content: String,
    filename: Option<String>,
    space_id: SpaceId,
    // Which reading the source is for (#6277 E1).
    dialect: ImportDialect,
    // `None`/omitted ⇒ no attachment ingest and no note names (a plain pick).
    vault: Option<VaultImport>,
    progress: tauri::ipc::Channel<ImportProgressUpdate>,
    ctx: State<'_, WriteCtx>,
) -> Result<ImportResult, AppError> {
    // b2 (#2248): required-target-space commands take the `SpaceId` newtype at
    // the wire boundary. The lenient `Deserialize` only uppercases, so reject a
    // malformed id here rather than letting a never-matching filter reach the
    // in-transaction space-existence check with an opaque error.
    space_id.validate_shape()?;
    // #3334 — the `app_paths` seam: imported vault files' bytes must land in
    // the same directory this process opened `notes.db` in.
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    let (vault_files, vault_notes) =
        vault.map_or((None, None), |vault| (Some(vault.files), Some(vault.notes)));
    import_markdown_with_progress(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        &app_data_dir,
        content,
        filename,
        space_id.into_string(),
        dialect,
        vault_files,
        vault_notes,
        Some(&crate::main_thread::UiChannel::new(app, progress)),
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: the end of a folder import, linking the references its notes
/// left (`ImportResult::deferred`) to the blocks their anchors name
/// (`ImportResult::anchors`). Delegates to [`link_import_anchors_inner`];
/// returns its warnings.
#[tauri::command]
#[specta::specta]
pub async fn link_import_anchors(
    space_id: SpaceId,
    anchors: Vec<ImportAnchor>,
    blocks: Vec<BlockId>,
    ctx: State<'_, WriteCtx>,
) -> Result<Vec<String>, AppError> {
    space_id.validate_shape()?;
    link_import_anchors_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        &anchors,
        &blocks,
    )
    .await
    .map_err(sanitize_internal_error)
}

#[path = "markdown_links.rs"]
mod link_helpers;
pub use link_helpers::*;

#[path = "markdown_export.rs"]
mod export;
pub use export::*;

#[path = "markdown_paste.rs"]
mod paste;
pub use paste::*;

#[path = "markdown_import.rs"]
mod import_core;
pub use import_core::*;

#[path = "markdown_import_front_matter.rs"]
mod import_front_matter;
use import_front_matter::*;

#[path = "markdown_import_links.rs"]
mod import_links;
pub(crate) use import_links::*;

#[path = "markdown_import_anchors.rs"]
mod import_anchors;
use import_anchors::*;

#[path = "markdown_import_attachments.rs"]
mod import_attachments;
pub use import_attachments::*;

#[path = "markdown_properties.rs"]
mod property_lines;
use property_lines::PropertyLines;
pub(crate) use property_lines::read_typed_ref;

#[path = "markdown_source_apply.rs"]
mod source_apply;
pub use source_apply::*;

#[cfg(test)]
#[path = "markdown_source_tests.rs"]
mod source_tests;

#[cfg(test)]
mod tests {
    use super::*;

    /// #2724 — the aggregate attachment-budget check rejects an over-cap file
    /// COUNT or aggregate BYTE total and accepts anything within budget,
    /// including the exact boundary. Exercised against fabricated numbers so
    /// the byte cap is verified WITHOUT allocating hundreds of MB.
    #[test]
    fn check_attachment_budget_enforces_caps_2724() {
        let byte_cap = crate::commands::MAX_TOTAL_ATTACHMENT_BYTES as u64;
        let count_cap = crate::commands::MAX_ATTACHMENT_FILE_COUNT;

        // Comfortably within both budgets.
        assert!(check_attachment_budget(3, 10 * 1024 * 1024).is_ok());
        // Empty payload is fine.
        assert!(check_attachment_budget(0, 0).is_ok());

        // Boundaries are inclusive (`> cap` rejects, `== cap` allows).
        assert!(check_attachment_budget(count_cap, 0).is_ok());
        assert!(check_attachment_budget(1, byte_cap).is_ok());

        // File count over the cap → Err.
        assert!(matches!(
            check_attachment_budget(count_cap + 1, 0),
            Err(AppError::Validation { .. })
        ));
        // Aggregate bytes over the cap → Err (fabricated total, no allocation).
        assert!(matches!(
            check_attachment_budget(1, byte_cap + 1),
            Err(AppError::Validation { .. })
        ));
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ReferenceTokenVectors {
        page_resolutions: HashMap<String, String>,
        tag_resolutions: HashMap<String, String>,
        humanize_cases: Vec<HumanizeTagCase>,
        code_fence_cases: Vec<CodeFenceCase>,
        cases: Vec<ReferenceTokenCase>,
        name_rule_cases: Vec<NameRuleCase>,
        page_name_fold_cases: Vec<PageNameFoldCase>,
        page_tie_cases: Vec<PageTieCase>,
        heading_anchors: HeadingAnchors,
    }

    /// #6033 — whether the anchor of `[[Page#anchor]]` names a page's block,
    /// `block_id`, holding `content`. `reference-tokens-conformance.test.ts`
    /// drives the editor's matcher for a typed anchor over the same rows.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HeadingAnchors {
        block_id: String,
        cases: Vec<HeadingAnchorCase>,
    }

    #[derive(serde::Deserialize)]
    struct HeadingAnchorCase {
        name: String,
        content: String,
        anchor: String,
        matches: bool,
    }

    /// #6052 — whether `[[link]]` names the one page, titled `title`, when the
    /// two differ by case, normalisation or edge whitespace (#6278).
    /// `names.test.ts` drives the mock's paste and
    /// `block-link-picker-match.test.ts` the editor's match over the same rows.
    #[derive(serde::Deserialize)]
    struct PageNameFoldCase {
        name: String,
        title: String,
        link: String,
        resolves: bool,
    }

    /// #6278 — the page `[[link]]` names when several pages hold the name: the
    /// lowest id under the first rule that matches. `names.test.ts` drives the
    /// mock's paste and `block-link-picker-match.test.ts` the editor's match
    /// over the same rows.
    #[derive(serde::Deserialize)]
    struct PageTieCase {
        name: String,
        pages: Vec<TiedPage>,
        link: String,
        holder: String,
    }

    #[derive(serde::Deserialize)]
    struct TiedPage {
        id: String,
        title: String,
        #[serde(default)]
        aliases: Vec<String>,
    }

    /// #5160 — what the name pass of import, paste and the buffer does with
    /// one block of text. The page names are the titles it looks up or
    /// creates: the whole link text when a page of that title exists, else
    /// the text before its first `#`. A row that still differs from the
    /// decided grammar carries its finding id, and
    /// `reference-tokens-conformance.test.ts` pins how the editor reads
    /// `transformed` and that the mock's scanner asks for the same names.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NameRuleCase {
        name: String,
        input: String,
        requested_page_names: Vec<String>,
        requested_tag_names: Vec<String>,
        transformed: String,
    }

    /// #3599 — a PARSER-DRIVEN vector. `cases` supplies `is_code` itself, so it
    /// cannot pin how the parser decides it. These vectors feed the raw text to
    /// `parse_logseq_markdown` and compare the SET of page and tag names the
    /// resolvers are asked to create. Rewrite output is not compared, because
    /// the parser rewrites block content (stripping bullets and indentation);
    /// the `cases` corpus and the unit tests pin that half.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CodeFenceCase {
        name: String,
        input: String,
        /// #3605 — the page-link resolver's side effects, on the same footing
        /// as the tag ones. `default` so a vector that omits it asserts ZERO
        /// page requests, which is the truth for every vector predating it.
        #[serde(default)]
        requested_page_names: Vec<String>,
        requested_tag_names: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HumanizeTagCase {
        name: String,
        tag_ulid: String,
        tag_name: String,
        expected: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ReferenceTokenCase {
        name: String,
        input: String,
        /// #3599 — drive the vector through the CODE-BLOCK path: fenced code is
        /// protected at BLOCK granularity, as a block the parser flagged
        /// `is_code`.
        #[serde(default)]
        is_code: bool,
        expected: ReferenceTokenExpected,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ReferenceTokenExpected {
        page_captures: Vec<String>,
        multiword_tag_captures: Vec<String>,
        requested_page_names: Vec<String>,
        requested_tag_names: Vec<String>,
        transformed: String,
    }

    /// #1920/#3261 — the regexes, collectors, and rewriters import and paste
    /// share, pinned over one golden fixture. This pins the prefix-sensitive
    /// distinction between `[[page]]`, `#[[tag]]`,
    /// and `![[embed]]`, as well as canonical-ULID exclusion and final output.
    #[test]
    fn page_link_re_parity_boundaries_1920() {
        let vectors: ReferenceTokenVectors = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../conformance/reference-tokens.vectors.json"
        )))
        .expect("reference-token conformance fixture must be valid JSON");

        for vector in &vectors.humanize_cases {
            let tag_names = HashMap::from([(vector.tag_ulid.clone(), vector.tag_name.clone())]);
            let transformed = resolve_ulids_for_export(
                &format!("#[{}]", vector.tag_ulid),
                &tag_names,
                &HashMap::new(),
                &HashMap::new(),
            );
            assert_eq!(
                transformed, vector.expected,
                "humanized tag for {:?}",
                vector.name
            );
        }

        // #3599 — the code-fence mechanism vectors, driven through the REAL
        // importer parser so the fixture never has to be told what is code.
        for vector in &vectors.code_fence_cases {
            let parsed = import::parse_logseq_markdown(&vector.input);
            assert!(
                !parsed.blocks.is_empty(),
                "code-fence vector {:?} parsed to no blocks — the assertion below \
                 would be vacuous",
                vector.name
            );
            // #3605 — the page-link resolver is held to the same contract as
            // the tag one: a link inside a protected code range is never even
            // looked up, so no page is created for it.
            let requested_pages = requested_page_names(&parsed.blocks);
            assert_eq!(
                requested_pages.len(),
                vector.requested_page_names.len(),
                "code-fence requested page count for {:?}: {requested_pages:?}",
                vector.name
            );
            assert_eq!(
                requested_pages
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<String>>(),
                vector
                    .requested_page_names
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<String>>(),
                "code-fence requested page names for {:?}",
                vector.name
            );
            let requested = collect_inbound_tag_names(&parsed.blocks);
            assert_eq!(
                requested.len(),
                vector.requested_tag_names.len(),
                "code-fence requested tag count for {:?}: {requested:?}",
                vector.name
            );
            assert_eq!(
                requested
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<String>>(),
                vector
                    .requested_tag_names
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<String>>(),
                "code-fence requested tag names for {:?}",
                vector.name
            );
        }

        for vector in vectors.cases {
            // #3599 — `isCode` is a routing hint the fixture supplies, so pin it
            // to what the REAL parser says: an unchecked hint would let a vector
            // assert each side against its own expectations instead of a shared
            // truth. (A future vector whose text parses to MIXED flags trips
            // this and must move to `codeFenceCases`, which needs no hint.)
            let parsed = import::parse_logseq_markdown(&vector.input);
            assert!(
                !parsed.blocks.is_empty(),
                "vector {:?} parsed to no blocks",
                vector.name
            );
            assert!(
                parsed.blocks.iter().all(|b| b.is_code == vector.is_code),
                "fixture isCode={} disagrees with the importer for {:?}: {:?}",
                vector.is_code,
                vector.name,
                parsed
                    .blocks
                    .iter()
                    .map(|b| (b.content.clone(), b.is_code))
                    .collect::<Vec<_>>()
            );

            let page_captures: Vec<String> = HUMAN_PAGE_LINK_RE
                .captures_iter(&vector.input)
                .map(|c| c[1].to_string())
                .collect();
            assert_eq!(
                page_captures, vector.expected.page_captures,
                "page captures for {:?}",
                vector.name
            );

            let multiword_tag_captures: Vec<String> = HUMAN_MULTIWORD_TAG_RE
                .captures_iter(&vector.input)
                .map(|c| c[1].to_string())
                .collect();
            assert_eq!(
                multiword_tag_captures, vector.expected.multiword_tag_captures,
                "multi-word tag captures for {:?}",
                vector.name
            );

            let blocks = vec![import::ParsedBlock {
                content: vector.input.clone(),
                depth: 0,
                properties: Vec::new(),
                is_code: vector.is_code,
                block_anchor: None,
                line: None,
            }];
            // #3599 — the contract is the SET of distinct names each side asks
            // its resolver for, not an encounter order. Rust collects through a
            // sorted `BTreeSet` and the frontend resolves in first-occurrence
            // order; asserting the ordered vectors only ever passed because the
            // two coincided. Compare as sets, plus the count so a duplicate
            // request (an extra create-if-missing round trip) still fails.
            let as_set = |names: &[String]| -> std::collections::BTreeSet<String> {
                names.iter().cloned().collect()
            };
            let requested_pages = requested_page_names(&blocks);
            assert_eq!(
                requested_pages.len(),
                vector.expected.requested_page_names.len(),
                "requested page name count for {:?}: {requested_pages:?}",
                vector.name
            );
            assert_eq!(
                as_set(&requested_pages),
                as_set(&vector.expected.requested_page_names),
                "requested page names for {:?}",
                vector.name
            );
            let requested_tags = collect_inbound_tag_names(&blocks);
            assert_eq!(
                requested_tags.len(),
                vector.expected.requested_tag_names.len(),
                "requested tag name count for {:?}: {requested_tags:?}",
                vector.name
            );
            assert_eq!(
                as_set(&requested_tags),
                as_set(&vector.expected.requested_tag_names),
                "requested tag names for {:?}",
                vector.name
            );

            let with_pages = rewrite_inbound_page_links(
                &vector.input,
                &page_links_for(&vector.input, &vectors.page_resolutions),
                &invert(&vectors.page_resolutions),
            );
            // Mirror the production caller (`import_markdown`): the tag rewrite
            // is skipped outright for an `is_code` block.
            let transformed = if vector.is_code {
                with_pages
            } else {
                rewrite_inbound_tags(&with_pages, &vectors.tag_resolutions)
            };
            assert_eq!(
                transformed, vector.expected.transformed,
                "transformed reference tokens for {:?}",
                vector.name
            );
        }
    }

    /// #5160 — the name rules each text surface applies, with the names
    /// resolved from the fixture's maps as `resolve_link_names` keys them: by
    /// the whole name a body reads as, to the page the whole title names (D10)
    /// or else its base names.
    #[test]
    fn name_rule_vectors_pin_the_name_pass() {
        let vectors: ReferenceTokenVectors = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../conformance/reference-tokens.vectors.json"
        )))
        .expect("reference-token conformance fixture must be valid JSON");
        let as_set = |names: &[String]| -> std::collections::BTreeSet<String> {
            names.iter().cloned().collect()
        };
        for vector in &vectors.name_rule_cases {
            let parsed = import::parse_logseq_markdown(&vector.input);
            assert_eq!(parsed.blocks.len(), 1, "{:?}", vector.name);
            let block = &parsed.blocks[0];
            assert_eq!(
                block.content, vector.input,
                "the importer rewrote {:?}, so the row is not about names",
                vector.name
            );
            let blocks = std::slice::from_ref(block);

            let mut page_names = std::collections::BTreeSet::new();
            let mut page_links = page_links_for(&block.content, &vectors.page_resolutions);
            for (name, _) in page_links.readings.values() {
                let (base, anchor) = split_wikilink_anchor(name);
                let title = if anchor.is_some() && vectors.page_resolutions.contains_key(name) {
                    name
                } else {
                    base
                };
                if let Some(id) = vectors.page_resolutions.get(title) {
                    page_links.ids.insert(name.clone(), id.clone());
                }
                page_names.insert(title.to_string());
            }
            assert_eq!(
                page_names,
                as_set(&vector.requested_page_names),
                "requested pages for {:?}",
                vector.name
            );
            assert_eq!(
                as_set(&collect_inbound_tag_names(blocks)),
                as_set(&vector.requested_tag_names),
                "requested tags for {:?}",
                vector.name
            );
            assert_eq!(
                rewrite_block_content_for_import(
                    block,
                    &page_links,
                    &invert(&vectors.page_resolutions),
                    &vectors.tag_resolutions
                ),
                vector.transformed,
                "stored content for {:?}",
                vector.name
            );
        }
    }

    #[test]
    fn heading_anchor_vectors_pin_which_block_an_anchor_names() {
        let vectors: ReferenceTokenVectors = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../conformance/reference-tokens.vectors.json"
        )))
        .expect("reference-token conformance fixture must be valid JSON");
        let HeadingAnchors { block_id, cases } = vectors.heading_anchors;
        assert!(!cases.is_empty());
        for row in cases {
            let candidates = [AnchorCandidate {
                id: block_id.clone(),
                page_id: "PAGE".into(),
                parent_id: None,
                position: Some(1),
                content: row.content,
            }];
            let by_id = HashMap::from([(block_id.as_str(), &candidates[0])]);
            assert_eq!(
                anchor_block(&candidates, &by_id, "PAGE", &row.anchor).is_some(),
                row.matches,
                "{:?}",
                row.name
            );
        }
    }

    #[test]
    fn page_name_fold_vectors_pin_which_titles_a_link_names() {
        let vectors: ReferenceTokenVectors = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../conformance/reference-tokens.vectors.json"
        )))
        .expect("reference-token conformance fixture must be valid JSON");
        assert!(!vectors.page_name_fold_cases.is_empty());
        for row in &vectors.page_name_fold_cases {
            const PAGE: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
            let matches = fixture_matches(&HashMap::from([(row.title.clone(), PAGE.into())]));
            assert_eq!(
                matches.find(&row.link) == Some(PAGE),
                row.resolves,
                "{:?}",
                row.name
            );
        }
    }

    #[test]
    fn page_tie_vectors_pin_the_lowest_id_as_the_page_a_shared_name_links() {
        use agaric_core::tag_norm::name_key;
        let vectors: ReferenceTokenVectors = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../conformance/reference-tokens.vectors.json"
        )))
        .expect("reference-token conformance fixture must be valid JSON");
        assert!(!vectors.page_tie_cases.is_empty());
        for row in &vectors.page_tie_cases {
            let mut matches = LinkMatches::default();
            for page in &row.pages {
                let id = page.id.clone();
                LinkMatches::push(&mut matches.folded, name_key(&page.title), id.clone());
                for alias in &page.aliases {
                    LinkMatches::push(&mut matches.aliases, name_key(alias), id.clone());
                }
            }
            assert_eq!(
                matches.find(&row.link),
                Some(row.holder.as_str()),
                "{:?}",
                row.name
            );
        }
    }

    /// The fixture's `title → id` map as `id → title`, the shape the rewrite
    /// reads titles in.
    fn invert(names: &HashMap<String, String>) -> HashMap<String, String> {
        names.iter().map(|(k, v)| (v.clone(), k.clone())).collect()
    }

    /// The names the name pass asks for when no page holds a longer reading
    /// of a body: each body's split on its first `|` (#5160 D10).
    fn requested_page_names(blocks: &[import::ParsedBlock]) -> Vec<String> {
        let names: std::collections::BTreeSet<String> = collect_inbound_page_link_bodies(blocks)
            .iter()
            .filter_map(|body| link_body_readings(body).last().map(|(n, _)| n.to_string()))
            .filter(|name| !name.is_empty())
            .collect();
        names.into_iter().collect()
    }

    /// Page links in which each of `pages`' titles (`title → id`) reads as
    /// itself and links its page.
    fn links_to(pages: &HashMap<String, String>) -> PageLinks {
        PageLinks {
            readings: pages
                .keys()
                .map(|title| (title.clone(), (title.clone(), None)))
                .collect(),
            ids: pages.clone(),
            ..PageLinks::default()
        }
    }

    /// The fixture's pages, `title → id`, as the name pass's snapshot holds
    /// them.
    fn fixture_matches(pages: &HashMap<String, String>) -> LinkMatches {
        let mut matches = LinkMatches::default();
        for (title, id) in pages {
            LinkMatches::push(
                &mut matches.folded,
                agaric_core::tag_norm::name_key(title),
                id.clone(),
            );
        }
        matches
    }

    /// What the name pass makes of the links in `content` when `pages`
    /// (`title → id`) are the space's pages: each body read against them, and
    /// each title's page.
    fn page_links_for(content: &str, pages: &HashMap<String, String>) -> PageLinks {
        let block = import::ParsedBlock {
            content: content.to_string(),
            depth: 0,
            properties: Vec::new(),
            is_code: false,
            block_anchor: None,
            line: None,
        };
        let matches = fixture_matches(pages);
        let mut links = PageLinks {
            ids: pages.clone(),
            ..PageLinks::default()
        };
        for body in collect_inbound_page_link_bodies(std::slice::from_ref(&block)) {
            let (name, label) = read_link_body(&body, &matches);
            let reading = (name.to_string(), label.map(str::to_string));
            links.readings.insert(body, reading);
        }
        links
    }

    /// #5160 D9, D10 — a link body reads whole, then as each prefix before a
    /// `|`, longest first, labelled with the rest; the last reading splits on
    /// the first `|`, and its name is what the anchor split then reads.
    #[test]
    fn a_link_body_reads_whole_then_before_each_pipe() {
        assert_eq!(link_body_readings(" Page "), [("Page", None)]);
        assert_eq!(
            link_body_readings(" A | B | c "),
            [
                ("A | B | c", None),
                ("A | B", Some("c")),
                ("A", Some("B | c"))
            ]
        );
        assert_eq!(
            link_body_readings("Page|"),
            [("Page|", None), ("Page", None)]
        );
        assert_eq!(
            split_wikilink_anchor(link_body_readings("A#B|see")[1].0),
            ("A", Some("B"))
        );
    }

    /// #5160 D10 — the first reading that names a page wins, a tie included
    /// (#6278), a `|` after a `#` starts the label, and with no page the body
    /// splits on its first `|`.
    #[test]
    fn a_link_body_reads_as_the_longest_name_a_page_has() {
        let pages = HashMap::from([
            (
                "A | B".to_string(),
                "01ARZ3NDEKTSV4RRFFQ69G5FAV".to_string(),
            ),
            (
                "X | Y".to_string(),
                "01ARZ3NDEKTSV4RRFFQ69G5FB0".to_string(),
            ),
            (
                "x | y".to_string(),
                "01ARZ3NDEKTSV4RRFFQ69G5FB1".to_string(),
            ),
        ]);
        let matches = fixture_matches(&pages);
        let read = |body| read_link_body(body, &matches);
        assert_eq!(read("A | B"), ("A | B", None));
        assert_eq!(read("a | b|see"), ("a | b", Some("see")));
        assert_eq!(read("A | B#Heading"), ("A | B#Heading", None));
        assert_eq!(read("A | B#Heading|x"), ("A | B#Heading", Some("x")));
        assert_eq!(read("A#x | B"), ("A#x", Some("B")));
        assert_eq!(read("C | D"), ("C", Some("D")));
        assert_eq!(read("X | y|see"), ("X | y", Some("see")));
        assert_eq!(read("X | Y|see"), ("X | Y", Some("see")));
    }

    /// #5160 D9 — the stored token keeps a label unless it is the target's
    /// title, and the writers put it back on the title.
    #[test]
    fn a_label_is_stored_unless_it_is_the_title_and_written_back() {
        const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        assert_eq!(
            stored_page_link(ULID, Some("plan"), Some("Plan")),
            format!("[[{ULID}|plan]]")
        );
        assert_eq!(
            stored_page_link(ULID, Some("Plan"), Some("Plan")),
            format!("[[{ULID}]]")
        );
        assert_eq!(stored_page_link(ULID, None, None), format!("[[{ULID}]]"));
        let pages = HashMap::from([("Plan".to_string(), ULID.to_string())]);
        let titles = invert(&pages);
        let content = "[[Plan|the plan]] [[Plan|Plan]] [the plan]([[Plan]]) `[x]([[Plan]])` [[Plan|see #x|y]]";
        assert_eq!(
            rewrite_inbound_page_links(content, &page_links_for(content, &pages), &titles),
            format!(
                "[[{ULID}|the plan]] [[{ULID}]] [[{ULID}|the plan]] `[x]([[Plan]])` [[{ULID}|see #x|y]]"
            )
        );
        let named = humanise_tag_and_page_refs(
            &format!("[[{ULID}|the plan]] [[{ULID}]] [[{ULID}|]]"),
            &HashMap::new(),
            &titles,
        );
        assert_eq!(named, "[[Plan|the plan]] [[Plan]] [[Plan]]");
        let unknown = format!("[[{ULID}|x]]");
        assert_eq!(
            humanise_tag_and_page_refs(&unknown, &HashMap::new(), &HashMap::new()),
            unknown
        );
    }

    /// #5160 N3 — an odd run of backslashes escapes the token, an even run is
    /// literal backslashes before a token.
    #[test]
    fn an_odd_backslash_run_escapes_the_token() {
        assert!(is_escaped(r"\#tag", 1));
        assert!(!is_escaped(r"\\#tag", 2));
        assert!(is_escaped(r"a \\\[[P]]", 5));
        assert!(!is_escaped("#tag", 0));
    }

    /// #5160 N1/N8 — a tag name needs a non-digit, and a name is written bare
    /// only when the bare form reads back whole.
    #[test]
    fn a_tag_name_needs_a_non_digit_and_reads_back_bare_only_when_whole() {
        assert!(!is_tag_name("42"));
        assert!(is_tag_name("v1"));
        assert!(is_tag_name("2024-plan"));
        assert!(tag_reads_back_bare("", "v1", ""));
        assert!(tag_reads_back_bare("see ", "cafe\u{301}/sub", " now"));
        for name in ["42", "C++", "v1.2", "Q&A", "deep work", "a\u{85}b"] {
            assert!(!tag_reads_back_bare("", name, ""), "{name:?}");
        }
    }

    /// #5160 N8 — a tag written where a bare `#name` would not read back as
    /// that tag (after anything but whitespace, or before a name char) is
    /// bracketed; what was written just before it is what the reader sees.
    #[test]
    fn a_tag_next_to_a_non_boundary_is_bracketed() {
        const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let tags = HashMap::from([(ULID.to_string(), "work".to_string())]);
        let content = format!(
            "[#[{ULID}]] #[{ULID}] #[{ULID}]#[{ULID}] #[{ULID}]s x#[{ULID}] x/#[{ULID}] \
             (#[{ULID}]) \"#[{ULID}] **#[{ULID}]**\n#[{ULID}]\u{a0}#[{ULID}]"
        );
        let named = humanise_tag_and_page_refs(&content, &tags, &HashMap::new());
        assert_eq!(
            named,
            "[#[[work]]] #work #work#[[work]] #[[work]]s x#[[work]] x/#[[work]] \
             (#[[work]]) \"#[[work]] **#[[work]]**\n#work\u{a0}#work"
        );
        assert_eq!(
            rewrite_inbound_tags(
                &named,
                &HashMap::from([("work".to_string(), ULID.to_string())])
            ),
            content,
            "every written tag reads back as the one it named"
        );
    }

    /// #5160 N1 — a `#` inside a bare URL or a link destination is a fragment.
    #[test]
    fn a_hash_inside_a_url_or_link_destination_is_guarded() {
        let content = "see https://docs.rs/x/#install and [d](https://x.dev/#s) `#c` #real";
        let guards = tag_guard_spans(content);
        for probe in ["#install", "#s", "#c"] {
            let pos = content.find(probe).unwrap();
            assert!(is_in_span(pos, &guards), "{probe} is guarded");
        }
        assert!(!is_in_span(content.find("#real").unwrap(), &guards));
    }

    /// #5160 D10 — the whole token of an anchored link is looked up as well as
    /// its base; an anchor-only link looks up nothing.
    #[test]
    fn link_lookup_names_add_the_whole_anchored_token() {
        let names = ["C# Notes".to_string(), "Page".into(), "#heading".into()];
        assert_eq!(link_lookup_names(&names), ["C", "C# Notes", "Page"]);
    }

    /// #5160 N10 — a relative `.md` destination, percent-decoded and resolved
    /// against the linking file's folder, names the page that file imports as.
    #[test]
    fn a_relative_md_link_names_the_page_its_file_imports_as() {
        assert_eq!(percent_decode("Other%20note.md"), "Other note.md");
        assert_eq!(percent_decode("caf%C3%A9 %zz%2"), "café %zz%2");
        assert_eq!(
            relative_md_link_title("Other%20note.md", "notes").as_deref(),
            Some("notes/Other note")
        );
        assert_eq!(
            relative_md_link_title("sub/Other note.MD", "").as_deref(),
            Some("sub/Other note")
        );
        assert_eq!(
            relative_md_link_title("../Top.md", "notes").as_deref(),
            Some("Top")
        );
        assert_eq!(
            relative_md_link_title("../../Top.md", "a/b").as_deref(),
            Some("Top")
        );
        for (dest, dir) in [
            ("../Out.md", ""),
            ("../../Out.md", "a"),
            ("https://x.dev/a.md", ""),
            ("/abs.md", ""),
            ("img.png", ""),
            ("a.md/", ""),
        ] {
            assert_eq!(
                relative_md_link_title(dest, dir),
                None,
                "{dest} from {dir:?}"
            );
        }
        assert_eq!(
            rewrite_relative_md_links(
                "[t](Other.md) ![i](pic.md) `[c](Code.md)` [w](https://x/a.md) [](A.md) [v/A](A.md)",
                "v"
            ),
            "[[v/Other|t]] ![i](pic.md) `[c](Code.md)` [w](https://x/a.md) [[v/A]] [[v/A]]",
            "the link text is the label unless empty or the title (#5160 D9)"
        );
    }

    /// #6032 — a link to a note of any extension, `<…>` or titled, is a page
    /// link; its `#fragment`, split off before decoding, is its anchor.
    #[test]
    fn a_relative_link_to_any_note_extension_keeps_its_anchor() {
        for dest in ["r.txt", "r.MARKDOWN", "r.mdx", "r.Org"] {
            assert_eq!(
                relative_md_link_title(dest, "v").as_deref(),
                Some("v/r"),
                "{dest}"
            );
        }
        assert_eq!(relative_md_link_title("r.pdf", "v"), None);
        assert_eq!(relative_md_link_title("noext", "v"), None);
        assert_eq!(
            relative_md_link_title("mailto:jane@example.org", "v"),
            None,
            "a mail address at an .org domain is no note"
        );
        assert_eq!(
            rewrite_relative_md_links(
                "[t](r.txt) [h](O.md#My%20Heading) [b](O.md#^id) [v/O](O.md#H) [e](O.md#) \
                 [a](<Other note.md> 'T') [q](O.md \"T\") [c](C%23%20Notes.md) [s](#own) \
                 \\[x](O.md) ![i](p.txt)",
                "v"
            ),
            "[[v/r|t]] [[v/O#My Heading|h]] [[v/O#^id|b]] [[v/O#H]] [[v/O|e]] \
             [[v/Other note|a]] [[v/O|q]] [[v/C# Notes|c]] [s](#own) \
             \\[x](O.md) ![i](p.txt)"
        );
    }

    /// #5740 — a folder import writes a bare `[[Name]]` naming one of its notes
    /// as that note's title, and so the link a note embed among text reads as;
    /// a name no note has, a title, and a token in code (inline or fenced), a
    /// file embed, a tag or an escape stay as written.
    #[test]
    fn a_bare_wikilink_names_the_vault_note_of_that_name() {
        let notes: Vec<String> = vec!["v/sub/Topic.md".into(), "v/Über.md".into()];
        let (parsed, _) = parse_import_payload(
            "- é[[topic]] [[ Topic |l]] [[Topic#h]] [[v/sub/Topic]] [[none]] [[Über]] [[über]]\n\
             - ![[Topic]] ![[topic.png]] #[[Topic]] \\[[Topic]] `[[Topic]]`\n\
             - ````\n  ![[Topic]] [[Topic]]\n  ````\n",
            Some("v/home.md".into()),
            ImportDialect::Markdown,
            None,
            Some(&notes),
        )
        .unwrap();
        let contents: Vec<&str> = parsed.blocks.iter().map(|b| b.content.as_str()).collect();
        assert_eq!(
            contents,
            [
                "é[[v/sub/Topic]] [[v/sub/Topic|l]] [[v/sub/Topic#h]] [[v/sub/Topic]] [[none]] [[v/Über]] [[v/Über]]",
                "[[v/sub/Topic]] ![[topic.png]] #[[Topic]] \\[[Topic]] `[[Topic]]`",
                "````\n![[Topic]] [[Topic]]\n````",
            ]
        );
    }

    /// #1282 (Obsidian slice) — `split_wikilink_anchor` splits a wiki-link
    /// target on its FIRST `#` into `(base, Some(anchor))`, trims the base,
    /// yields `(name, None)` when there is no `#`, and reports an EMPTY base for
    /// an anchor-only link (`[[#heading]]`) so the caller leaves it literal.
    #[test]
    fn split_wikilink_anchor_splits_on_first_hash_1282() {
        // Base only (no `#`) — plain `[[Page]]`, unchanged pre-#1282 behaviour.
        assert_eq!(split_wikilink_anchor("Page"), ("Page", None));
        assert_eq!(
            split_wikilink_anchor("Project/Backend/API"),
            ("Project/Backend/API", None)
        );
        // Base + heading anchor.
        assert_eq!(
            split_wikilink_anchor("Target#Some Heading"),
            ("Target", Some("Some Heading"))
        );
        // Base + `^block` id anchor (the `^` stays part of the anchor).
        assert_eq!(
            split_wikilink_anchor("Target#^block123"),
            ("Target", Some("^block123"))
        );
        // Empty base — anchor-only intra-note link: "no page target".
        assert_eq!(split_wikilink_anchor("#heading"), ("", Some("heading")));
        // Multiple `#` — split on the FIRST; the rest is the anchor verbatim.
        assert_eq!(split_wikilink_anchor("Page#a#b"), ("Page", Some("a#b")));
        // Base whitespace is trimmed (matching the existing page-name handling).
        assert_eq!(split_wikilink_anchor(" Page #h1"), ("Page", Some("h1")));
    }

    /// #2510 — `obsidian_block_anchor_id` recognizes a `^`-prefixed sub-anchor
    /// as an Obsidian BLOCK anchor and returns the id (without the `^`);
    /// returns `None` for a heading anchor (no `^`) or a bare `^` with
    /// nothing after it (not a valid block id).
    #[test]
    fn obsidian_block_anchor_id_recognizes_caret_prefix_2510() {
        assert_eq!(obsidian_block_anchor_id("^block123"), Some("block123"));
        assert_eq!(
            obsidian_block_anchor_id("^my-block-id"),
            Some("my-block-id")
        );
        // Heading anchor — no leading `^`.
        assert_eq!(obsidian_block_anchor_id("Some Heading"), None);
        // A bare `^` with nothing after it is not a valid block id.
        assert_eq!(obsidian_block_anchor_id("^"), None);
    }

    /// #2567 — `obsidian_heading_text` recognizes a block whose first line is an
    /// ATX heading (1–6 `#` + whitespace + text) and returns the trimmed label;
    /// a `#tag` (no space), an over-deep `#######`, an empty heading, and plain
    /// text all return `None`. Only the first line is inspected.
    #[test]
    fn obsidian_heading_text_recognizes_atx_headings_2567() {
        assert_eq!(obsidian_heading_text("# Heading"), Some("Heading"));
        assert_eq!(obsidian_heading_text("###### Deep"), Some("Deep"));
        assert_eq!(obsidian_heading_text("##   Padded  "), Some("Padded"));
        // Multi-line heading block: only the first line is the heading.
        assert_eq!(
            obsidian_heading_text("## My Heading\nbody line"),
            Some("My Heading")
        );
        // `#tag` — no space after the `#` run — is NOT a heading.
        assert_eq!(obsidian_heading_text("#tag"), None);
        // Seven `#` exceeds ATX's max depth of 6.
        assert_eq!(obsidian_heading_text("####### Nope"), None);
        // A `#` run with no following text is not a heading.
        assert_eq!(obsidian_heading_text("## "), None);
        // Plain content is not a heading.
        assert_eq!(obsidian_heading_text("just text"), None);
    }

    /// #2567 — `normalize_heading_anchor` trims, collapses internal whitespace,
    /// and lowercases so a heading block's label and a wiki-link's `#…`
    /// sub-anchor compare equal despite incidental case/whitespace differences.
    #[test]
    fn normalize_heading_anchor_collapses_case_and_whitespace_2567() {
        assert_eq!(normalize_heading_anchor("  My  Heading "), "my heading");
        assert_eq!(
            normalize_heading_anchor("My Heading"),
            normalize_heading_anchor("my   heading")
        );
        assert_eq!(normalize_heading_anchor("A\tB"), "a b");
    }

    /// #2567 — the inline-tag pass must NOT treat a `[[#Heading]]` wikilink
    /// heading anchor as a tag: no tag name is collected and the token is left
    /// verbatim by the rewrite, so the heading-anchor resolution pass can match
    /// it. A genuine `#tag` elsewhere in the same block is still collected.
    #[test]
    fn tag_pass_skips_wikilink_heading_anchor_2567() {
        let blocks = vec![import::ParsedBlock {
            content: "See [[#My Heading]] and a #realtag".to_string(),
            depth: 0,
            properties: Vec::new(),
            is_code: false,
            block_anchor: None,
            line: None,
        }];
        // Only the genuine `#realtag` is collected; the `#My` inside `[[…]]` is
        // NOT (it is a heading anchor, not a tag).
        let names = collect_inbound_tag_names(&blocks);
        assert_eq!(names, vec!["realtag".to_string()], "got {names:?}");

        // Rewrite: the `[[#My Heading]]` token survives untouched; the real tag
        // is rewritten to its `#[ULID]` ref.
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "realtag".to_string(),
            "01TAG00000000000000000TAG0".to_string(),
        );
        let out = rewrite_inbound_tags(&blocks[0].content, &resolved);
        assert_eq!(
            out, "See [[#My Heading]] and a #[01TAG00000000000000000TAG0]",
            "the `[[#Heading]]` anchor must be left intact for heading resolution; got {out:?}"
        );
    }

    /// #3598 — a bare `#tag` inside an UNRESOLVED human wiki link is part of the
    /// page NAME, not a tag. It must be skipped by BOTH the collector (no
    /// spurious tag is created) and the rewriter (the token stays
    /// byte-identical, instead of being corrupted into `[[Project #[ULID]]]`).
    /// Falsifies the collector and the rewriter independently: `alpha` is in the
    /// resolved map, so a leak shows up in the output as well as in the names.
    #[test]
    fn tag_pass_skips_bare_tag_inside_unresolved_wiki_link_3598() {
        let blocks = vec![import::ParsedBlock {
            content: "[[Project #alpha]] #real".to_string(),
            depth: 0,
            properties: Vec::new(),
            is_code: false,
            block_anchor: None,
            line: None,
        }];
        let names = collect_inbound_tag_names(&blocks);
        assert_eq!(
            names,
            vec!["real".to_string()],
            "only the tag OUTSIDE the wiki link may be collected; got {names:?}"
        );

        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "alpha".to_string(),
            "01TAG0000000000000000ALFA0".to_string(),
        );
        resolved.insert("real".to_string(), "01TAG00000000000000000TAG0".to_string());
        let out = rewrite_inbound_tags(&blocks[0].content, &resolved);
        assert_eq!(
            out, "[[Project #alpha]] #[01TAG00000000000000000TAG0]",
            "the unresolved wiki link must stay byte-identical; got {out:?}"
        );
    }

    /// #3598 — the wiki-link span guard in `rewrite_inbound_tags` pass 2 must be
    /// computed against the POST-multi-word-rewrite string. `#[[Tag With Space]]`
    /// (19 bytes) collapses to `#[ULID]` (29 bytes), sliding the following
    /// `[[Project #alpha]]` ten bytes to the right; spans computed over the
    /// original content would no longer cover `#alpha`, and the rewrite would
    /// corrupt the link exactly as it did before the fix.
    #[test]
    fn tag_rewrite_recomputes_wiki_link_spans_after_multiword_pass_3598() {
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "Tag With Space".to_string(),
            "01TAG0000000000000000MW000".to_string(),
        );
        resolved.insert(
            "alpha".to_string(),
            "01TAG0000000000000000ALFA0".to_string(),
        );
        resolved.insert("real".to_string(), "01TAG00000000000000000TAG0".to_string());
        let out = rewrite_inbound_tags("#[[Tag With Space]] [[Project #alpha]] #real", &resolved);
        assert_eq!(
            out, "#[01TAG0000000000000000MW000] [[Project #alpha]] #[01TAG00000000000000000TAG0]",
            "stale spans from before the multi-word rewrite must not expose `#alpha`; got {out:?}"
        );
    }

    /// #3599 — a bare `#tag` inside a MULTI-WORD tag name (`#[[Alpha #b]]`) is
    /// part of that name: the collector must not create a stray tag `b` for it,
    /// even when the rendered output would not show one. Both
    /// the resolved and the unresolved multi-word name are pinned, because only
    /// the unresolved one also exercises the rewriter.
    #[test]
    fn tag_pass_does_not_leak_bare_tag_inside_multiword_tag_name_3599() {
        let blocks = vec![
            import::ParsedBlock {
                content: "#[[Alpha #b]]".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: false,
                block_anchor: None,
                line: None,
            },
            import::ParsedBlock {
                content: "#[[Unknown #b]] #real".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: false,
                block_anchor: None,
                line: None,
            },
        ];
        let names = collect_inbound_tag_names(&blocks);
        assert_eq!(
            names,
            vec![
                "Alpha #b".to_string(),
                "Unknown #b".to_string(),
                "real".to_string()
            ],
            "the inner `#b` is part of the multi-word tag NAME, never its own tag; got {names:?}"
        );

        // Unresolved multi-word name: pass 1 leaves the token, so pass 2 sees the
        // inner `#b` and must still leave it alone even though `b` resolves.
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert("b".to_string(), "01TAG00000000000000000BEE0".to_string());
        resolved.insert("real".to_string(), "01TAG00000000000000000TAG0".to_string());
        let out = rewrite_inbound_tags(&blocks[1].content, &resolved);
        assert_eq!(
            out, "#[[Unknown #b]] #[01TAG00000000000000000TAG0]",
            "the unresolved multi-word tag token must stay byte-identical; got {out:?}"
        );
    }

    /// #1950 — the page-link collect/rewrite guard skips a `[[...]]` that is
    /// immediately preceded by `#` (the `#[[Tag]]` multi-word tag form), so it
    /// is neither collected as a page name nor rewritten as a page ref. A plain
    /// `[[...]]` (no `#`) is still collected/rewritten as a page.
    #[test]
    fn page_link_guard_skips_hash_prefixed_brackets_1950() {
        let blocks = vec![import::ParsedBlock {
            content: "a #[[Tag With Space]] and [[Real Page]]".to_string(),
            depth: 0,
            properties: Vec::new(),
            is_code: false,
            block_anchor: None,
            line: None,
        }];
        // Only the un-prefixed `[[Real Page]]` is collected as a page name.
        let names = collect_inbound_page_link_bodies(&blocks);
        assert_eq!(names, vec!["Real Page".to_string()], "got {names:?}");

        // Rewrite: the `#[[Tag With Space]]` token survives untouched; the page
        // link is rewritten to its ULID.
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "Real Page".to_string(),
            "01PAGE0000000000000000PAGE".to_string(),
        );
        let out =
            rewrite_inbound_page_links(&blocks[0].content, &links_to(&resolved), &HashMap::new());
        assert_eq!(
            out, "a #[[Tag With Space]] and [[01PAGE0000000000000000PAGE]]",
            "the `#[[...]]` must be left for the tag pass; got {out:?}"
        );
    }

    /// #1924 — `collect_inbound_tag_names` gathers both bare and multi-word
    /// tags, skips `is_code` blocks entirely, skips inline-code spans, ignores
    /// `# heading`, and never collects a canonical `#[ULID]` ref.
    #[test]
    fn collect_inbound_tag_names_covers_forms_and_skips_1924() {
        let ulid = "01TAG00000000000000000TAG0";
        let blocks = vec![
            import::ParsedBlock {
                content: format!(
                    "see #projectx and #[[my tag]] not # heading nor `#incode` nor #[{ulid}]"
                ),
                depth: 0,
                properties: Vec::new(),
                is_code: false,
                block_anchor: None,
                line: None,
            },
            import::ParsedBlock {
                content: "fenced #shouldskip".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: true,
                block_anchor: None,
                line: None,
            },
        ];
        let names = collect_inbound_tag_names(&blocks);
        assert_eq!(
            names,
            vec!["my tag".to_string(), "projectx".to_string()],
            "bare + multi-word collected; heading/inline-code/canonical/code-block skipped; \
             got {names:?}"
        );
    }

    /// #1924 — `rewrite_inbound_tags` rewrites resolved tokens to `#[ULID]`,
    /// leaves unresolved tokens literal, and never touches a `#[ULID]` already
    /// present.
    #[test]
    fn rewrite_inbound_tags_rewrites_and_degrades_1924() {
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "known".to_string(),
            "01KNOWN000000000000000TAG0".to_string(),
        );
        resolved.insert(
            "my tag".to_string(),
            "01MULTI000000000000000TAG0".to_string(),
        );
        let out = rewrite_inbound_tags("a #known b #[[my tag]] c #unknown d", &resolved);
        assert_eq!(
            out, "a #[01KNOWN000000000000000TAG0] b #[01MULTI000000000000000TAG0] c #unknown d",
            "resolved tokens rewrite; unknown stays literal; got {out:?}"
        );
    }

    /// #1921 — a block with no `[[` is returned UNCHANGED by
    /// `rewrite_inbound_page_links` (the fast path), with no allocation-visible
    /// difference in the result.
    #[test]
    fn rewrite_inbound_page_links_fast_path_returns_unchanged_1921() {
        let resolved: HashMap<String, String> = HashMap::new();
        let content = "a plain block with no wiki link, just #tag-ish text";
        assert_eq!(
            rewrite_inbound_page_links(content, &links_to(&resolved), &HashMap::new()),
            content,
            "a link-free block must be returned unchanged"
        );
        // And a block WITH a link still rewrites via the resolved map.
        let mut resolved2: HashMap<String, String> = HashMap::new();
        resolved2.insert("Target".to_string(), "01ABC".to_string());
        assert_eq!(
            rewrite_inbound_page_links(
                "see [[Target]] here",
                &links_to(&resolved2),
                &HashMap::new()
            ),
            "see [[01ABC]] here",
            "a resolved name must be rewritten to its ULID ref"
        );
    }

    /// #3605 — a `[[Page]]` inside a protected code range is literal on the
    /// IMPORTER side too: never collected (so never created) and never
    /// rewritten. The fenced half is a `is_code` block, the inline half an
    /// `inline_code_spans` range — the same two mechanisms `#tag` has used
    /// since #3598/#3599.
    #[test]
    fn page_links_inside_code_are_literal_3605() {
        let blocks = vec![
            import::ParsedBlock {
                content: "```\nlink syntax: [[Fenced Page]]\n```".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: true,
                block_anchor: None,
                line: None,
            },
            import::ParsedBlock {
                content: "see `[[Quoted Page]]` vs [[Live Page]]".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: false,
                block_anchor: None,
                line: None,
            },
        ];

        let names = collect_inbound_page_link_bodies(&blocks);
        assert_eq!(
            names,
            vec!["Live Page".to_string()],
            "only the link outside any code range may be resolved/created; got {names:?}"
        );

        // The rewrite half. `Quoted Page` and `Fenced Page` are BOTH in the
        // resolved map, so a byte-identical result proves the guard rather than
        // an unresolvable name falling back to its own token.
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "Quoted Page".to_string(),
            "01QUOTED0000000000000PAGE0".to_string(),
        );
        resolved.insert(
            "Fenced Page".to_string(),
            "01FENCED0000000000000PAGE0".to_string(),
        );
        resolved.insert(
            "Live Page".to_string(),
            "01LIVE00000000000000PAGE00".to_string(),
        );

        let out =
            rewrite_inbound_page_links(&blocks[1].content, &links_to(&resolved), &HashMap::new());
        assert_eq!(
            out, "see `[[Quoted Page]]` vs [[01LIVE00000000000000PAGE00]]",
            "the inline-code link must stay byte-identical while its neighbour rewrites; \
             got {out:?}"
        );
    }

    /// #3605 — the `is_code` half of the guard lives at the CALL SITE (as it
    /// does for tags), so pin it through the real importer: a fenced block
    /// whose `#tag`s the importer already leaves literal must keep its
    /// `[[Page]]` text literal too.
    #[test]
    fn parsed_code_block_page_links_are_not_collected_3605() {
        let parsed =
            import::parse_logseq_markdown("- ```\n  see [[Fenced Page]] #fencedtag\n  ```");
        assert!(
            parsed.blocks.iter().any(|b| b.is_code),
            "the vector must actually produce a code block: {:?}",
            parsed.blocks
        );
        assert!(
            collect_inbound_page_link_bodies(&parsed.blocks).is_empty(),
            "a fenced block must ask for no page: {:?}",
            collect_inbound_page_link_bodies(&parsed.blocks)
        );
        assert!(
            collect_inbound_tag_names(&parsed.blocks).is_empty(),
            "…and no tag either, which was already true — the two must agree"
        );
    }
}
