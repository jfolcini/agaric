//! A meeting page with its recording (#5364): `add_meeting_inner` creates
//! the page `<Title> <YYYY-MM-DD>`, tagged `#meeting` with `meeting_date`,
//! copies the chosen template, and puts the audio, transcript and summary on
//! one recording block, all in one transaction. The MCP `add_meeting` tool
//! calls it, so a meeting comes out the same from either.

use std::path::{Path, PathBuf};

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_engine::block_ops::{create_block_in_tx, set_property_in_tx};
use agaric_store::pagination::BlockRow;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tracing::instrument;

use super::AttachmentRow;
use super::attachments::{
    StoredBytes, cleanup_rejected_attachment, mime_for_extension, persist_attachment_in_tx,
    validate_new_attachment, write_attachment_bytes,
};
use super::blocks::crud::{TagInSpace, create_tag_in_space_in_tx};
use crate::db::CommandTx;
use crate::materializer::Materializer;

/// The title a meeting gets when none is given.
pub const DEFAULT_MEETING_TITLE: &str = "Meeting";

/// The tag every meeting page carries.
pub const MEETING_TAG: &str = "meeting";

/// One file of a meeting, as its bytes and the name it was picked as.
#[derive(Debug, Clone)]
pub struct MeetingFile {
    pub filename: String,
    pub bytes: Vec<u8>,
}

/// A meeting's summary: page content, or a Markdown attachment.
#[derive(Debug, Clone)]
pub enum MeetingSummary {
    Text(String),
    File(MeetingFile),
}

/// Where a new meeting's page is linked from.
#[derive(Debug, Clone)]
pub enum MeetingLink {
    /// The end of this block's content (`/meeting` in a block).
    Block(BlockId),
    /// A new block at the end of this day's journal, created if missing.
    Journal(NaiveDate),
}

/// What [`add_meeting_inner`] writes to.
#[derive(Debug, Clone)]
pub enum MeetingTarget {
    /// A new meeting page.
    New {
        /// Trimmed; empty means [`DEFAULT_MEETING_TITLE`].
        title: String,
        date: NaiveDate,
        /// A template page of the space, copied under the meeting page.
        template_id: Option<BlockId>,
        link: MeetingLink,
    },
    /// The files go onto this block, the recording block of a meeting.
    Block(BlockId),
    /// The files go onto this meeting page's recording block: its first block
    /// holding an attachment, else a new block at its top.
    Page(BlockId),
}

/// One call of [`add_meeting_inner`].
#[derive(Debug, Clone)]
pub struct AddMeetingRequest {
    pub space_id: String,
    pub target: MeetingTarget,
    pub audio: Option<MeetingFile>,
    pub transcript: Option<MeetingFile>,
    pub summary: Option<MeetingSummary>,
}

/// What [`add_meeting_inner`] wrote.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct MeetingResult {
    pub page_id: BlockId,
    pub recording_block_id: BlockId,
    /// The block linking the page, for a new meeting.
    pub link_block_id: Option<BlockId>,
    /// The audio, then the transcript, then the summary, those given.
    pub attachments: Vec<AttachmentRow>,
}

/// One file of [`AddMeetingInput`].
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct MeetingFileInput {
    pub filename: String,
    pub bytes: Vec<u8>,
}

/// The app's *New meeting* (#5364): a new meeting page, linked from
/// `link_block_id` or, without one, from the day's journal. Every file is
/// optional; `summary_text` and `summary_file` are one or the other.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct AddMeetingInput {
    pub space_id: String,
    #[serde(default)]
    pub title: String,
    /// `YYYY-MM-DD`.
    pub date: String,
    #[serde(default)]
    pub template_id: Option<BlockId>,
    #[serde(default)]
    pub link_block_id: Option<BlockId>,
    #[serde(default)]
    pub audio: Option<MeetingFileInput>,
    #[serde(default)]
    pub transcript: Option<MeetingFileInput>,
    #[serde(default)]
    pub summary_text: Option<String>,
    #[serde(default)]
    pub summary_file: Option<MeetingFileInput>,
}

impl AddMeetingInput {
    /// The [`AddMeetingRequest`] this asks for, refused when the date is not
    /// `YYYY-MM-DD` or both summaries are given.
    pub fn into_request(self) -> Result<AddMeetingRequest, AppError> {
        let date = NaiveDate::parse_from_str(&self.date, "%Y-%m-%d").map_err(|_| {
            AppError::validation(format!("expected YYYY-MM-DD, got '{}'", self.date))
        })?;
        let file = |input: MeetingFileInput| MeetingFile {
            filename: input.filename,
            bytes: input.bytes,
        };
        let summary = match (self.summary_text, self.summary_file) {
            (Some(_), Some(_)) => {
                return Err(AppError::validation(
                    "a summary is text or a file, not both".into(),
                ));
            }
            (Some(text), None) => Some(MeetingSummary::Text(text)),
            (None, Some(input)) => Some(MeetingSummary::File(file(input))),
            (None, None) => None,
        };
        let link = match self.link_block_id {
            Some(block_id) => MeetingLink::Block(block_id),
            None => MeetingLink::Journal(date),
        };
        Ok(AddMeetingRequest {
            space_id: self.space_id,
            target: MeetingTarget::New {
                title: self.title,
                date,
                template_id: self.template_id,
                link,
            },
            audio: self.audio.map(file),
            transcript: self.transcript.map(file),
            summary,
        })
    }
}

/// Tauri command: the app's *New meeting* (#5364). Delegates to
/// [`add_meeting_inner`], and returns the ops it wrote so one Undo reverts
/// the whole meeting.
#[tauri::command]
#[specta::specta]
pub async fn add_meeting(
    app: tauri::AppHandle,
    ctx: tauri::State<'_, crate::db::WriteCtx>,
    input: AddMeetingInput,
) -> Result<super::WithOps<MeetingResult>, AppError> {
    // #3334 — the same `app_paths` seam the attachment writes use.
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    let req = input.into_request()?;
    super::capture_op_refs(add_meeting_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        &app_data_dir,
        req,
    ))
    .await
    .map_err(super::sanitize_internal_error)
}

/// The kind of file a meeting holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Audio,
    Transcript,
    Summary,
}

/// The name `filename` is stored under as `role` (#5364): a transcript is
/// `<name>.transcript.md` and a summary `<name>.summary.md`, so the layout
/// tells them apart. A trailing `.md`, `.markdown` or `.txt` is replaced; a
/// name that already ends in the role's suffix is kept. Audio keeps its name.
fn role_filename(filename: &str, role: Role) -> String {
    let suffix = match role {
        Role::Audio => return filename.trim().to_owned(),
        Role::Transcript => ".transcript.md",
        Role::Summary => ".summary.md",
    };
    let name = filename.trim();
    if ends_with_ignore_case(name, suffix) {
        return name.to_owned();
    }
    let stem = [".markdown", ".md", ".txt"]
        .iter()
        .find(|ext| ends_with_ignore_case(name, ext))
        .map_or(name, |ext| &name[..name.len() - ext.len()]);
    format!("{stem}{suffix}")
}

fn ends_with_ignore_case(name: &str, suffix: &str) -> bool {
    name.len() >= suffix.len()
        && name.is_char_boundary(name.len() - suffix.len())
        && name[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// The stored name and MIME type of a file given as `role`, refused when
/// audio is not an audio file.
fn file_identity(file: &MeetingFile, role: Role) -> Result<(String, String), AppError> {
    let filename = role_filename(&file.filename, role);
    if role != Role::Audio {
        return Ok((filename, "text/markdown".to_owned()));
    }
    let extension = filename.rsplit_once('.').map_or("", |(_, ext)| ext);
    match mime_for_extension(extension) {
        Some(mime) if mime.starts_with("audio/") => Ok((filename, mime.to_owned())),
        _ => Err(AppError::validation(format!(
            "the audio '{filename}' is not an audio file; its extension must be an audio type"
        ))),
    }
}

/// Whether `content` is the `<% recording %>` placeholder, which marks where
/// a template puts the recording block.
pub(crate) fn is_recording_placeholder(content: &str) -> bool {
    content
        .trim()
        .strip_prefix("<%")
        .and_then(|rest| rest.strip_suffix("%>"))
        .is_some_and(|name| name.trim().eq_ignore_ascii_case("recording"))
}

/// A file written to disk before the transaction, kept for the commit or for
/// cleanup when the transaction fails.
struct Written {
    stored: StoredBytes,
    full_path: PathBuf,
}

/// Write every file of `req` to disk, refusing before the first write when
/// one is not a valid attachment. A failed write removes what was written.
async fn write_meeting_files(
    app_data_dir: &Path,
    req: &AddMeetingRequest,
) -> Result<Vec<Written>, AppError> {
    let summary_file = match &req.summary {
        Some(MeetingSummary::File(file)) => Some(file),
        _ => None,
    };
    let files: Vec<(Role, &MeetingFile)> = [
        (Role::Audio, req.audio.as_ref()),
        (Role::Transcript, req.transcript.as_ref()),
        (Role::Summary, summary_file),
    ]
    .into_iter()
    .filter_map(|(role, file)| file.map(|file| (role, file)))
    .collect();
    let mut checked = Vec::with_capacity(files.len());
    for (role, file) in files {
        let (filename, mime_type) = file_identity(file, role)?;
        let size_bytes = i64::try_from(file.bytes.len()).unwrap_or(i64::MAX);
        let filename = validate_new_attachment(&filename, &mime_type, size_bytes)?;
        checked.push((file, filename, mime_type, size_bytes));
    }
    let mut written: Vec<Written> = Vec::with_capacity(checked.len());
    for (file, filename, mime_type, size_bytes) in checked {
        match write_attachment_bytes(app_data_dir, file.bytes.clone(), size_bytes).await {
            Ok((fs_path, content_hash)) => written.push(Written {
                full_path: app_data_dir.join(&fs_path),
                stored: StoredBytes {
                    filename,
                    mime_type,
                    size_bytes,
                    fs_path,
                    content_hash,
                },
            }),
            Err(e) => {
                cleanup_written(&written).await;
                return Err(e);
            }
        }
    }
    Ok(written)
}

async fn cleanup_written(written: &[Written]) {
    for file in written {
        cleanup_rejected_attachment(&file.full_path).await;
    }
}

/// Add a meeting (#5364), as one transaction and one undo: a new meeting page
/// with its template, tag, `meeting_date`, link and files, or the files onto
/// an existing meeting. Every file is optional; a summary given as text is
/// written as blocks just above the recording block.
///
/// The files are written to disk before the transaction and removed when it
/// fails, so a refused meeting leaves nothing behind.
///
/// # Errors
///
/// - [`AppError::Validation`] — a file is not a valid attachment, the audio is
///   not audio, the title is taken in the space, the template is not a
///   template page of the space or cannot be copied, the summary text holds no
///   block, or `space_id` is not a live space
/// - [`AppError::NotFound`] — the target or link block is missing or deleted
#[instrument(skip(pool, device_id, materializer, app_data_dir, req), err)]
pub async fn add_meeting_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &Path,
    req: AddMeetingRequest,
) -> Result<MeetingResult, AppError> {
    let written = write_meeting_files(app_data_dir, &req).await?;
    let paths: Vec<PathBuf> = written.iter().map(|w| w.full_path.clone()).collect();
    match Box::pin(add_meeting_in_new_tx(
        pool,
        device_id,
        materializer,
        req,
        written,
    ))
    .await
    {
        Ok(result) => Ok(result),
        Err(e) => {
            for path in &paths {
                cleanup_rejected_attachment(path).await;
            }
            Err(e)
        }
    }
}

async fn add_meeting_in_new_tx(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    req: AddMeetingRequest,
    written: Vec<Written>,
) -> Result<MeetingResult, AppError> {
    let space_id = req.space_id.to_ascii_uppercase();
    let mut tx = CommandTx::begin_immediate(pool, "add_meeting").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    crate::commands::spaces::require_live_space_in_tx(&mut tx, &space_id).await?;
    let (page_id, recording, link_block_id) = Box::pin(resolve_target_in_tx(
        &mut tx,
        device_id,
        materializer,
        &space_id,
        req.target,
    ))
    .await?;
    let mut tx = match req.summary {
        Some(MeetingSummary::Text(text)) => {
            Box::pin(write_summary_above_in_tx(
                tx,
                device_id,
                materializer,
                &recording,
                &text,
            ))
            .await?
        }
        _ => tx,
    };
    let mut attachments = Vec::with_capacity(written.len());
    for file in written {
        let row = persist_attachment_in_tx(
            &mut tx,
            materializer,
            device_id,
            recording.id.clone(),
            file.stored,
        )
        .await?;
        attachments.push(row);
    }
    tx.commit_and_dispatch(materializer).await?;
    Ok(MeetingResult {
        page_id,
        recording_block_id: recording.id,
        link_block_id,
        attachments,
    })
}

/// The meeting page, its recording block and the linking block `target`
/// names, creating a new meeting's.
async fn resolve_target_in_tx(
    tx: &mut CommandTx,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    target: MeetingTarget,
) -> Result<(BlockId, BlockRow, Option<BlockId>), AppError> {
    match target {
        MeetingTarget::New {
            title,
            date,
            template_id,
            link,
        } => {
            let (page_id, recording) = Box::pin(create_meeting_page_in_tx(
                tx,
                device_id,
                materializer,
                space_id,
                &title,
                date,
                template_id.as_ref(),
            ))
            .await?;
            let link_block = Box::pin(link_meeting_in_tx(
                tx,
                device_id,
                materializer,
                space_id,
                &page_id,
                link,
            ))
            .await?;
            Ok((page_id, recording, Some(link_block)))
        }
        MeetingTarget::Block(block_id) => {
            let block = require_block_in_space_in_tx(tx, &block_id, space_id).await?;
            let page_id = block.page_id.clone().unwrap_or_else(|| block.id.clone());
            Ok((page_id, block, None))
        }
        MeetingTarget::Page(page_id) => {
            let page = require_block_in_space_in_tx(tx, &page_id, space_id).await?;
            if page.block_type != "page" {
                return Err(AppError::validation(format!(
                    "'{page_id}' is not a page; pass a block to add to it"
                )));
            }
            let recording =
                page_recording_block_in_tx(tx, device_id, materializer, &page_id).await?;
            Ok((page_id, recording, None))
        }
    }
}

/// Create the meeting page `<title> <date>` in `space_id`, tagged
/// [`MEETING_TAG`] with `meeting_date`, with `template_id` copied under it.
/// Returns the page and its recording block.
async fn create_meeting_page_in_tx(
    tx: &mut CommandTx,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    title: &str,
    date: NaiveDate,
    template_id: Option<&BlockId>,
) -> Result<(BlockId, BlockRow), AppError> {
    let title = match title.trim() {
        "" => DEFAULT_MEETING_TITLE,
        trimmed => trimmed,
    };
    let day = date.format("%Y-%m-%d").to_string();
    let page_title = format!("{title} {day}");
    if crate::commands::spaces::find_live_page_by_name(tx, space_id, &page_title, None)
        .await?
        .is_some()
    {
        return Err(AppError::validation(format!(
            "a page named '{page_title}' already exists in the space; add the files to it \
             instead"
        )));
    }
    if let Some(template_id) = template_id {
        require_template_in_tx(tx, template_id, space_id).await?;
    }
    let page =
        create_tagged_page_in_tx(tx, device_id, materializer, space_id, &page_title, &day).await?;
    let copied = match template_id {
        Some(template_id) => {
            let time = chrono::Local::now().time();
            Box::pin(crate::commands::pages::copy_page_blocks_in_tx(
                tx,
                materializer,
                device_id,
                template_id.as_str(),
                page.as_str(),
                |content| {
                    crate::commands::journal::expand_template_variables(
                        content,
                        date,
                        time,
                        &page_title,
                    )
                },
            ))
            .await?
            .map_err(|why| AppError::validation(format!("the template cannot be copied: {why}")))?
        }
        None => Vec::new(),
    };
    let recording = match copied.into_iter().find(|block| {
        block
            .content
            .as_deref()
            .is_some_and(is_recording_placeholder)
    }) {
        Some(placeholder) => {
            crate::commands::blocks::crud::edit_block_in_tx(
                tx,
                materializer.loro_state(),
                device_id,
                placeholder.id.as_str().to_owned(),
                String::new(),
            )
            .await?
        }
        None => new_recording_block_in_tx(tx, device_id, materializer, &page).await?,
    };
    Ok((page, recording))
}

/// The page `page_title` in `space_id`, with `meeting_date` = `day` and the
/// [`MEETING_TAG`] tag, made if the space has none.
async fn create_tagged_page_in_tx(
    tx: &mut CommandTx,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    page_title: &str,
    day: &str,
) -> Result<BlockId, AppError> {
    let state = materializer.loro_state();
    let (page, page_op) = create_block_in_tx(
        tx,
        state,
        device_id,
        "page".into(),
        page_title.to_owned(),
        None,
        None,
        None,
    )
    .await?;
    tx.enqueue_background(page_op);
    let id = page.id.as_str().to_owned();
    // Not dispatched: a fresh block has nothing to re-scope (#5275).
    let (_, space_op) = set_property_in_tx(
        tx,
        state,
        device_id,
        id.clone(),
        "space",
        None,
        None,
        None,
        Some(space_id.to_owned()),
        None,
    )
    .await?;
    tx.enqueue_without_dispatch(space_op);
    let (_, date_op) = set_property_in_tx(
        tx,
        state,
        device_id,
        id,
        "meeting_date",
        None,
        None,
        Some(day.to_owned()),
        None,
        None,
    )
    .await?;
    tx.enqueue_background(date_op);
    let tag = Box::pin(create_tag_in_space_in_tx(
        tx,
        device_id,
        materializer,
        MEETING_TAG.to_owned(),
        None,
        None,
        space_id,
        None,
    ))
    .await?;
    let tag_id = match tag {
        TagInSpace::Existing(id) => BlockId::from_trusted(&id),
        TagInSpace::Created(tag) => tag.id,
    };
    crate::commands::tags::add_tag_in_tx(tx, state, device_id, &page.id, &tag_id).await?;
    Ok(page.id)
}

/// An empty block at the top of `page_id`, the recording block.
async fn new_recording_block_in_tx(
    tx: &mut CommandTx,
    device_id: &str,
    materializer: &Materializer,
    page_id: &BlockId,
) -> Result<BlockRow, AppError> {
    let (block, op) = create_block_in_tx(
        tx,
        materializer.loro_state(),
        device_id,
        "content".into(),
        String::new(),
        Some(page_id.as_str().to_owned()),
        Some(0),
        None,
    )
    .await?;
    tx.enqueue_background(op);
    Ok(block)
}

/// `template_id` is a live template page (`template = true`) of `space_id`.
async fn require_template_in_tx(
    tx: &mut CommandTx,
    template_id: &BlockId,
    space_id: &str,
) -> Result<(), AppError> {
    let id = template_id.as_str();
    let found = sqlx::query_scalar!(
        r#"SELECT 1 AS "ok!: i64"
           FROM blocks b
           JOIN block_properties bp
             ON bp.block_id = b.id AND bp.key = 'template' AND bp.value_text = 'true'
           WHERE b.id = ?1 AND b.block_type = 'page' AND b.deleted_at IS NULL
             AND b.space_id = ?2"#,
        id,
        space_id,
    )
    .fetch_optional(&mut ***tx)
    .await?;
    if found.is_none() {
        return Err(AppError::validation(format!(
            "'{template_id}' is not a template page of the space"
        )));
    }
    Ok(())
}

/// The live block `block_id` of `space_id`.
async fn require_block_in_space_in_tx(
    tx: &mut CommandTx,
    block_id: &BlockId,
    space_id: &str,
) -> Result<BlockRow, AppError> {
    let block = agaric_engine::block_ops::fetch_live_block_in_tx(tx, block_id.as_str()).await?;
    crate::db::validate_block_in_space(&mut ***tx, block_id.as_str(), space_id).await?;
    Ok(block)
}

/// The recording block of the meeting page `page_id`: its first block, in
/// page order, that holds an attachment, else a new block at its top.
async fn page_recording_block_in_tx(
    tx: &mut CommandTx,
    device_id: &str,
    materializer: &Materializer,
    page_id: &BlockId,
) -> Result<BlockRow, AppError> {
    let page = page_id.as_str();
    let holder = sqlx::query_scalar!(
        r#"WITH RECURSIVE tree(id, path, depth) AS (
               SELECT b.id, printf('%020d', b.position) || b.id, 0
                 FROM blocks b
                WHERE b.parent_id = ?1 AND b.deleted_at IS NULL
               UNION ALL
               SELECT c.id, t.path || '/' || printf('%020d', c.position) || c.id, t.depth + 1
                 FROM blocks c JOIN tree t ON c.parent_id = t.id
                WHERE c.deleted_at IS NULL AND t.depth < 100
           )
           SELECT t.id AS "id!: String"
             FROM tree t
            WHERE EXISTS (SELECT 1 FROM attachments a WHERE a.block_id = t.id)
            ORDER BY t.path
            LIMIT 1"#,
        page,
    )
    .fetch_optional(&mut ***tx)
    .await?;
    match holder {
        Some(id) => agaric_engine::block_ops::fetch_live_block_in_tx(tx, &id).await,
        None => new_recording_block_in_tx(tx, device_id, materializer, page_id).await,
    }
}

/// Write the summary `text` as blocks just above `recording`, under its
/// parent.
async fn write_summary_above_in_tx(
    mut tx: CommandTx,
    device_id: &str,
    materializer: &Materializer,
    recording: &BlockRow,
    text: &str,
) -> Result<CommandTx, AppError> {
    let parent = recording.parent_id.clone().ok_or_else(|| {
        AppError::validation("the recording block has no parent to hold a summary".into())
    })?;
    let parent_str = parent.as_str();
    let id = recording.id.as_str();
    let index = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "n!: i64"
           FROM blocks s, blocks r
           WHERE r.id = ?2 AND s.parent_id = ?1 AND s.deleted_at IS NULL
             AND (s.position < r.position OR (s.position = r.position AND s.id < r.id))"#,
        parent_str,
        id,
    )
    .fetch_one(&mut **tx)
    .await?;
    let (tx, _) = Box::pin(crate::commands::pages::markdown::append_markdown_in_tx(
        tx,
        materializer,
        device_id,
        &parent,
        text,
        Some(index),
    ))
    .await?;
    Ok(tx)
}

/// Link `page_id` from `link` and return the linking block.
async fn link_meeting_in_tx(
    tx: &mut CommandTx,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    page_id: &BlockId,
    link: MeetingLink,
) -> Result<BlockId, AppError> {
    let page_link = format!("[[{page_id}]]");
    let state = materializer.loro_state();
    match link {
        MeetingLink::Block(block_id) => {
            let block = require_block_in_space_in_tx(tx, &block_id, space_id).await?;
            let content = match block.content.as_deref().map(str::trim_end) {
                None | Some("") => page_link,
                Some(text) => format!("{text} {page_link}"),
            };
            crate::commands::blocks::crud::edit_block_in_tx(
                tx,
                state,
                device_id,
                block_id.as_str().to_owned(),
                content,
            )
            .await?;
            Ok(block_id)
        }
        MeetingLink::Journal(date) => {
            let day = date.format("%Y-%m-%d").to_string();
            let journal = Box::pin(
                crate::commands::journal::resolve_or_create_journal_page_in_tx(
                    tx,
                    device_id,
                    materializer,
                    &day,
                    space_id,
                ),
            )
            .await?;
            let (block, op) = create_block_in_tx(
                tx,
                state,
                device_id,
                "content".into(),
                page_link,
                Some(journal.id.as_str().to_owned()),
                None,
                None,
            )
            .await?;
            tx.enqueue_background(op);
            Ok(block.id)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_filename_suffixes_a_transcript_and_a_summary_5364() {
        assert_eq!(
            role_filename("notes.md", Role::Transcript),
            "notes.transcript.md"
        );
        assert_eq!(
            role_filename("notes.TXT", Role::Transcript),
            "notes.transcript.md"
        );
        assert_eq!(
            role_filename("notes.markdown", Role::Summary),
            "notes.summary.md"
        );
        assert_eq!(role_filename("notes", Role::Summary), "notes.summary.md");
        assert_eq!(
            role_filename("call.transcript.md", Role::Transcript),
            "call.transcript.md"
        );
        assert_eq!(
            role_filename("call.Summary.MD", Role::Summary),
            "call.Summary.MD"
        );
        assert_eq!(
            role_filename("call.summary.md", Role::Transcript),
            "call.summary.transcript.md"
        );
        assert_eq!(role_filename(" call.ogg ", Role::Audio), "call.ogg");
    }

    fn input(date: &str, link_block_id: Option<&str>) -> AddMeetingInput {
        AddMeetingInput {
            space_id: "S".into(),
            title: "Sync".into(),
            date: date.into(),
            template_id: None,
            link_block_id: link_block_id.map(BlockId::from_trusted),
            audio: None,
            transcript: None,
            summary_text: None,
            summary_file: None,
        }
    }

    #[test]
    fn new_meeting_input_links_the_block_else_the_day_and_refuses_a_bad_date_5364() {
        let link = |req: AddMeetingRequest| match req.target {
            MeetingTarget::New { link, .. } => link,
            other => panic!("a new meeting, got {other:?}"),
        };
        let block = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        assert!(matches!(
            link(input("2031-03-14", Some(block)).into_request().unwrap()),
            MeetingLink::Block(id) if id.as_str() == block
        ));
        assert!(matches!(
            link(input("2031-03-14", None).into_request().unwrap()),
            MeetingLink::Journal(day) if day == NaiveDate::from_ymd_opt(2031, 3, 14).unwrap()
        ));
        let err = input("14/03/2031", None).into_request().unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    }

    #[test]
    fn recording_placeholder_matches_the_token_in_any_case_and_spacing_5364() {
        for content in ["<% recording %>", "<%recording%>", "  <%  Recording  %>  "] {
            assert!(is_recording_placeholder(content), "{content}");
        }
        for content in ["<% recording %> notes", "recording", "<% today %>", ""] {
            assert!(!is_recording_placeholder(content), "{content}");
        }
    }
}
