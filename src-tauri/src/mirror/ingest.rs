//! Reading an edit made to a page's file outside Agaric into the page (#5363
//! slice 2, #6277 H2): [`ingest`].
//!
//! The file is read as Edit as Markdown reads a buffer saved over a page that
//! changed meanwhile: each line takes the id its `^ID` anchor gives, or else
//! the id of the block it pairs with in the text last written that is closest
//! to the file ([`pair_unanchored_lines`]), and [`apply_page_source_inner`]
//! saves it with `merge`, against the page's buffer as that text was written
//! from, so what Agaric changed since is folded in, not undone. It is one
//! command, so one undo reverts it; one the op cap refuses leaves the page and
//! the file alone.

use std::collections::HashSet;
use std::sync::Arc;

use serde::Serialize;
use sqlx::SqlitePool;

use agaric_core::error::AppError;
use agaric_core::word_diff::equal_pairs;
use agaric_store::op::OpRef;

use super::splice::splice;
use super::store::{PageState, Shadow};
use crate::commands::pages::{
    PageFile, PageSourceReport, SourceSaveFlags, anchor_free_kept, apply_page_source_inner,
    get_page_file_inner, pair_unanchored_lines,
};
use crate::commands::{WithOps, capture_op_refs};
use crate::materializer::Materializer;

/// The event an ingest emits: the ops it appended, for the page's undo, and
/// what it wrote.
pub const EVENT_MIRROR_INGESTED: &str = "mirror:ingested";

/// Typed by hand in `useMirrorIngestEvents.ts`: the bindings carry commands,
/// not event payloads.
#[derive(Debug, Clone, Serialize)]
pub struct MirrorIngested {
    pub page_id: String,
    pub path: String,
    pub op_refs: Vec<OpRef>,
    pub report: PageSourceReport,
}

/// What the mirror needs to write a file's edit into its page.
#[derive(Clone)]
pub struct Ingest {
    /// The write pool.
    pub pool: SqlitePool,
    pub materializer: Materializer,
    pub notify: Arc<dyn Fn(MirrorIngested) + Send + Sync>,
}

impl Ingest {
    /// The app's: each ingest is sent to the webview as
    /// [`EVENT_MIRROR_INGESTED`], and its page as changed.
    pub fn for_app<R: tauri::Runtime>(
        handle: tauri::AppHandle<R>,
        pool: SqlitePool,
        materializer: Materializer,
    ) -> Self {
        use crate::mcp::view_notify::{TauriViewChangeEmitter, ViewChangeEmitter};
        let notify = move |event: MirrorIngested| {
            let page_id = event.page_id.clone();
            crate::main_thread::emit(&handle, EVENT_MIRROR_INGESTED, event);
            TauriViewChangeEmitter::new(handle.clone()).emit_blocks_changed(vec![page_id]);
        };
        Self {
            pool,
            materializer,
            notify: Arc::new(notify),
        }
    }
}

/// Why a file was not ingested.
#[derive(Debug)]
pub enum NotIngested {
    /// No text written for the page can be its base: the file stays as it
    /// is, listed as diverged.
    NoBase,
    /// The file or the save was refused, and why: the page is unchanged.
    Refused(String),
}

/// An ingested file as it is to be written back: the file with the anchors
/// the page now needs added or dropped and every other block's lines kept,
/// its line ids, and the page's buffer from the same read.
pub struct Ingested {
    /// `None` when the page could not be read back after the save: the file
    /// is left for the next pass.
    pub shadow: Option<Shadow>,
    pub event: MirrorIngested,
}

/// The file's text as it is read: UTF-8, a leading BOM dropped, line ends
/// LF. Refused when it is not UTF-8, or holds nothing, as a file emptied mid
/// save does, which would otherwise delete every block.
pub fn file_text(bytes: &[u8]) -> Result<String, NotIngested> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| NotIngested::Refused("the file is not UTF-8".into()))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim().is_empty() {
        return Err(NotIngested::Refused(
            "the file is empty; its page keeps its blocks".into(),
        ));
    }
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}

/// Write `bytes`, the page's file at `path` as edited outside Agaric, into
/// the page, whose file was last written as `state`'s texts and renders now
/// as `render`.
#[allow(clippy::too_many_arguments)]
pub async fn ingest(
    read_pool: &SqlitePool,
    ingest: &Ingest,
    device_id: &str,
    page_id: &str,
    path: &str,
    state: &PageState,
    bytes: &[u8],
    render: &PageFile,
) -> Result<Ingested, NotIngested> {
    let refused = |e: AppError| NotIngested::Refused(e.to_string());
    let text = file_text(bytes)?;
    let shadow = closest(&state.shadows, &text).ok_or(NotIngested::NoBase)?;
    // A text written before ingests kept no buffer: the page's own serves
    // while the page still renders as that text.
    let base = match &shadow.buffer {
        Some(buffer) => buffer.clone(),
        None if shadow.text == render.text => render.buffer.clone(),
        None => return Err(NotIngested::NoBase),
    };
    let (edited, anchors, kept) = anchor_free_kept(&text);
    let known: HashSet<&str> = shadow
        .line_ids
        .iter()
        .chain(&render.line_ids)
        .flatten()
        .map(String::as_str)
        .collect();
    let anchors = only(anchors, &known);
    let (written, written_ids) = free_of(&shadow.text, &shadow.line_ids);
    let line_ids = pair_unanchored_lines(&written, &written_ids, &edited, &anchors);
    let saved = capture_op_refs(Box::pin(apply_page_source_inner(
        &ingest.pool,
        device_id,
        &ingest.materializer,
        page_id,
        edited.clone(),
        base,
        SourceSaveFlags {
            merge: true,
            line_ids: line_ids.clone(),
        },
    )))
    .await
    .map_err(refused)?;
    let WithOps {
        inner: report,
        op_refs,
    } = saved;
    let event = MirrorIngested {
        page_id: page_id.to_owned(),
        path: path.to_owned(),
        op_refs,
        report,
    };
    // The ops are in: from here a failure still reports them.
    let shadow = match get_page_file_inner(read_pool, page_id).await {
        Ok(now) => Some(write_back(&text, &edited, &kept, &line_ids, &now)),
        Err(e) => {
            tracing::warn!(page_id, error = %e, "cannot render a page after its ingest");
            None
        }
    };
    Ok(Ingested { shadow, event })
}

/// The file `text` (`edited` its anchor-free form, `kept` the line of `text`
/// each of its lines is, `saved_ids` the ids it was saved with) spliced with
/// `now`, the page's render after the save: the blocks the save created get
/// their ids by pairing against the render, and only the blocks the render
/// writes differently, an anchor added or dropped, take its lines.
fn write_back(
    text: &str,
    edited: &str,
    kept: &[usize],
    saved_ids: &[Option<String>],
    now: &PageFile,
) -> Shadow {
    let (rendered, rendered_ids) = free_of(&now.text, &now.line_ids);
    let live: HashSet<&str> = now.line_ids.iter().flatten().map(String::as_str).collect();
    let saved = only(saved_ids.to_vec(), &live);
    let paired = pair_unanchored_lines(&rendered, &rendered_ids, edited, &saved);
    let mut ids = vec![None; text.split('\n').count()];
    for (line, id) in kept.iter().zip(paired) {
        if let Some(slot) = ids.get_mut(*line) {
            *slot = id;
        }
    }
    let (text, line_ids) = splice(text, &ids, &now.text, &now.line_ids);
    Shadow {
        text,
        line_ids,
        buffer: Some(now.buffer.clone()),
    }
}

/// `ids` with every id `known` does not hold dropped.
fn only(mut ids: Vec<Option<String>>, known: &HashSet<&str>) -> Vec<Option<String>> {
    for id in &mut ids {
        if id.as_deref().is_some_and(|id| !known.contains(id)) {
            *id = None;
        }
    }
    ids
}

/// A text written by the mirror as its anchor-free text, with the ids of its
/// lines carried onto the lines they were kept as.
fn free_of(text: &str, line_ids: &[Option<String>]) -> (String, Vec<Option<String>>) {
    let (free, _, kept) = anchor_free_kept(text);
    let ids = kept
        .iter()
        .map(|&line| line_ids.get(line).cloned().flatten())
        .collect();
    (free, ids)
}

/// The text written that differs from `text` in the fewest lines, the newest
/// of equals: the base of an editor that kept an older text open, whose save
/// reads as undoing what Agaric wrote since against any newer one.
fn closest<'a>(shadows: &'a [Shadow], text: &str) -> Option<&'a Shadow> {
    let lines: Vec<&str> = text.split('\n').collect();
    shadows.iter().rev().min_by_key(|shadow| {
        let written: Vec<&str> = shadow.text.split('\n').collect();
        written.len() + lines.len() - 2 * equal_pairs(&written, &lines).len()
    })
}

#[cfg(test)]
#[path = "ingest_tests.rs"]
mod tests;
