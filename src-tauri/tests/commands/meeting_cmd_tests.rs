//! `add_meeting_inner` (#5364): a meeting page, its template, tag, date,
//! link and recording files in one transaction.

use crate::prelude::*;
use agaric_core::ulid::ActiveBlockId;
use agaric_lib::commands::meeting_attachments::{
    AddMeetingRequest, MeetingFile, MeetingLink, MeetingResult, MeetingSummary, MeetingTarget,
    add_meeting_inner,
};
use chrono::NaiveDate;
use tempfile::TempDir;

/// A day far from the clock, so a variable expanded against today shows.
fn day() -> NaiveDate {
    NaiveDate::from_ymd_opt(2031, 3, 14).unwrap()
}

struct Fixture {
    pool: SqlitePool,
    mat: Materializer,
    _db: TempDir,
    data: TempDir,
}

async fn fixture() -> Fixture {
    let (pool, db) = test_pool().await;
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    let mat = Materializer::new(pool.clone());
    Fixture {
        pool,
        mat,
        _db: db,
        data: TempDir::new().unwrap(),
    }
}

impl Fixture {
    async fn page(&self, title: &str) -> BlockId {
        create_page_in_space_inner(
            &self.pool,
            DEV,
            &self.mat,
            None,
            title.into(),
            TEST_SPACE_ID.into(),
        )
        .await
        .unwrap()
    }

    async fn block(&self, parent: &BlockId, content: &str) -> BlockId {
        create_block_inner(
            &self.pool,
            DEV,
            &self.mat,
            "content".into(),
            content.into(),
            Some(parent.clone()),
            None,
        )
        .await
        .unwrap()
        .id
    }

    /// A template page holding `contents` as top-level blocks.
    async fn template(&self, title: &str, contents: &[&str]) -> BlockId {
        let page = self.page(title).await;
        set_property_inner(
            &self.pool,
            DEV,
            &self.mat,
            ActiveBlockId::from(page.as_str().to_owned()),
            "template".into(),
            Some("true".into()),
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        for content in contents {
            self.block(&page, content).await;
        }
        page
    }

    async fn add(&self, req: AddMeetingRequest) -> Result<MeetingResult, AppError> {
        add_meeting_inner(&self.pool, DEV, &self.mat, self.data.path(), req).await
    }

    async fn children(&self, parent: &BlockId) -> Vec<(String, String)> {
        sqlx::query_as(
            "SELECT id, COALESCE(content, '') FROM blocks \
             WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id",
        )
        .bind(parent.as_str())
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    async fn content(&self, id: &BlockId) -> String {
        sqlx::query_scalar("SELECT COALESCE(content, '') FROM blocks WHERE id = ?")
            .bind(id.as_str())
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn files(&self, block: &BlockId) -> Vec<(String, String)> {
        sqlx::query_as(
            "SELECT filename, mime_type FROM attachments WHERE block_id = ? ORDER BY filename",
        )
        .bind(block.as_str())
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    async fn tags(&self, block: &BlockId) -> Vec<String> {
        sqlx::query_scalar(
            "SELECT t.content FROM block_tags bt JOIN blocks t ON t.id = bt.tag_id \
             WHERE bt.block_id = ?",
        )
        .bind(block.as_str())
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    async fn meeting_date(&self, page: &BlockId) -> Option<String> {
        sqlx::query_scalar(
            "SELECT value_date FROM block_properties WHERE block_id = ? AND key = 'meeting_date'",
        )
        .bind(page.as_str())
        .fetch_optional(&self.pool)
        .await
        .unwrap()
        .flatten()
    }

    async fn live_pages_titled(&self, title: &str) -> i64 {
        sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks \
             WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL",
        )
        .bind(title)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    /// Every file under the vault's attachment directory.
    fn files_on_disk(&self) -> usize {
        let dir = self.data.path().join("attachments");
        std::fs::read_dir(dir).map_or(0, Iterator::count)
    }
}

fn file(filename: &str, bytes: &[u8]) -> MeetingFile {
    MeetingFile {
        filename: filename.into(),
        bytes: bytes.to_vec(),
    }
}

fn new_meeting(title: &str, template_id: Option<BlockId>, link: MeetingLink) -> MeetingTarget {
    MeetingTarget::New {
        title: title.into(),
        date: day(),
        template_id,
        link,
    }
}

fn request(target: MeetingTarget) -> AddMeetingRequest {
    AddMeetingRequest {
        space_id: TEST_SPACE_ID.into(),
        target,
        audio: None,
        transcript: None,
        summary: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_meeting_is_a_tagged_dated_page_linked_from_the_block_5364() {
    let f = fixture().await;
    let notes = f.page("Notes").await;
    let source = f.block(&notes, "Standup").await;
    let mut req = request(new_meeting(
        "  Design review ",
        None,
        MeetingLink::Block(source.clone()),
    ));
    req.audio = Some(file("call.ogg", b"OggS audio"));
    req.transcript = Some(file("notes.md", b"[00:00:04] **Alice:** Hi."));
    req.summary = Some(MeetingSummary::File(file("recap.txt", b"Shipped.")));

    let meeting = f.add(req).await.unwrap();

    assert_eq!(
        f.content(&meeting.page_id).await,
        "Design review 2031-03-14"
    );
    assert_eq!(f.tags(&meeting.page_id).await, vec!["meeting".to_owned()]);
    assert_eq!(
        f.meeting_date(&meeting.page_id).await.as_deref(),
        Some("2031-03-14")
    );
    let children = f.children(&meeting.page_id).await;
    assert_eq!(
        children,
        vec![(
            meeting.recording_block_id.as_str().to_owned(),
            String::new()
        )],
        "with no template the page holds the recording block alone"
    );
    assert_eq!(
        f.files(&meeting.recording_block_id).await,
        vec![
            ("call.ogg".to_owned(), "audio/ogg".to_owned()),
            ("notes.transcript.md".to_owned(), "text/markdown".to_owned()),
            ("recap.summary.md".to_owned(), "text/markdown".to_owned()),
        ]
    );
    assert_eq!(meeting.link_block_id.as_ref(), Some(&source));
    assert_eq!(
        f.content(&source).await,
        format!("Standup [[{}]]", meeting.page_id)
    );
    assert_eq!(f.files_on_disk(), 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_template_is_copied_for_the_meeting_and_places_the_recording_5364() {
    let f = fixture().await;
    let template = f
        .template(
            "Meeting template",
            &[
                "Attendees of <% page title %>",
                "On <% today %>, <% weekday %>",
                "<% recording %>",
                "Action items",
            ],
        )
        .await;
    let notes = f.page("Notes").await;
    let source = f.block(&notes, "").await;
    let mut req = request(new_meeting(
        "Sync",
        Some(template),
        MeetingLink::Block(source.clone()),
    ));
    req.summary = Some(MeetingSummary::Text("Decided to ship.".into()));

    let meeting = f.add(req).await.unwrap();

    let contents: Vec<String> = f
        .children(&meeting.page_id)
        .await
        .into_iter()
        .map(|(_, content)| content)
        .collect();
    assert_eq!(
        contents,
        vec![
            "Attendees of Sync 2031-03-14".to_owned(),
            "On 2031-03-14, Friday".to_owned(),
            "Decided to ship.".to_owned(),
            String::new(),
            "Action items".to_owned(),
        ],
        "the variables read the meeting, and the summary sits above the recording block"
    );
    let recording = &f.children(&meeting.page_id).await[3].0;
    assert_eq!(recording, meeting.recording_block_id.as_str());
    assert_eq!(f.content(&source).await, format!("[[{}]]", meeting.page_id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_a_placeholder_the_summary_and_recording_open_the_page_5364() {
    let f = fixture().await;
    let template = f.template("Plain template", &["Agenda"]).await;
    let notes = f.page("Notes").await;
    let source = f.block(&notes, "x").await;
    let mut req = request(new_meeting("", Some(template), MeetingLink::Block(source)));
    req.summary = Some(MeetingSummary::Text("Short.".into()));

    let meeting = f.add(req).await.unwrap();

    assert_eq!(f.content(&meeting.page_id).await, "Meeting 2031-03-14");
    let children = f.children(&meeting.page_id).await;
    let contents: Vec<&str> = children.iter().map(|(_, c)| c.as_str()).collect();
    assert_eq!(contents, vec!["Short.", "", "Agenda"]);
    assert_eq!(children[1].0, meeting.recording_block_id.as_str());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_meeting_linked_from_a_journal_day_ends_that_day_5364() {
    let f = fixture().await;
    let journal = f.page("2031-03-14").await;
    f.block(&journal, "Morning").await;

    let meeting = f
        .add(request(new_meeting(
            "Retro",
            None,
            MeetingLink::Journal(day()),
        )))
        .await
        .unwrap();

    let contents: Vec<String> = f
        .children(&journal)
        .await
        .into_iter()
        .map(|(_, content)| content)
        .collect();
    assert_eq!(
        contents,
        vec!["Morning".to_owned(), format!("[[{}]]", meeting.page_id)]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_journal_day_is_created_for_the_link_5364() {
    let f = fixture().await;

    let meeting = f
        .add(request(new_meeting(
            "Retro",
            None,
            MeetingLink::Journal(day()),
        )))
        .await
        .unwrap();

    assert_eq!(f.live_pages_titled("2031-03-14").await, 1);
    let link = meeting.link_block_id.unwrap();
    assert_eq!(f.content(&link).await, format!("[[{}]]", meeting.page_id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_revert_takes_the_whole_meeting_back_5364() {
    let f = fixture().await;
    let template = f.template("T", &["<% recording %>", "Notes"]).await;
    let notes = f.page("Notes").await;
    let source = f.block(&notes, "Standup").await;
    let mut req = request(new_meeting(
        "Sync",
        Some(template),
        MeetingLink::Block(source.clone()),
    ));
    req.audio = Some(file("call.ogg", b"OggS audio"));
    req.summary = Some(MeetingSummary::Text("Recap.".into()));

    let with_ops = capture_op_refs(f.add(req)).await.unwrap();
    revert_ops_inner(&f.pool, DEV, &f.mat, with_ops.op_refs)
        .await
        .unwrap();

    assert_eq!(f.live_pages_titled("Sync 2031-03-14").await, 0);
    assert_eq!(f.content(&source).await, "Standup");
    assert_eq!(f.files(&with_ops.inner.recording_block_id).await, vec![]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_meeting_writes_nothing_and_leaves_no_bytes_5364() {
    let f = fixture().await;
    let not_a_template = f.page("Ordinary").await;
    let notes = f.page("Notes").await;
    let source = f.block(&notes, "Standup").await;
    let mut req = request(new_meeting(
        "Sync",
        Some(not_a_template),
        MeetingLink::Block(source.clone()),
    ));
    req.audio = Some(file("call.ogg", b"OggS audio"));
    req.transcript = Some(file("t.md", b"[00:01] Hi."));

    let err = f.add(req).await.unwrap_err();

    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert_eq!(f.live_pages_titled("Sync 2031-03-14").await, 0);
    assert_eq!(f.content(&source).await, "Standup");
    assert_eq!(f.files_on_disk(), 0, "the written bytes are removed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audio_that_is_not_audio_is_refused_before_a_byte_is_written_5364() {
    let f = fixture().await;
    let notes = f.page("Notes").await;
    let source = f.block(&notes, "x").await;
    let mut req = request(new_meeting("Sync", None, MeetingLink::Block(source)));
    req.audio = Some(file("slides.pdf", b"%PDF"));

    let err = f.add(req).await.unwrap_err();

    assert!(
        matches!(&err, AppError::Validation { .. } if err.to_string().contains("not an audio file")),
        "got {err:?}"
    );
    assert_eq!(f.files_on_disk(), 0);
    assert_eq!(f.live_pages_titled("Sync 2031-03-14").await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_taken_title_is_refused_5364() {
    let f = fixture().await;
    f.page("Sync 2031-03-14").await;
    let notes = f.page("Notes").await;
    let source = f.block(&notes, "x").await;

    let err = f
        .add(request(new_meeting(
            "Sync",
            None,
            MeetingLink::Block(source),
        )))
        .await
        .unwrap_err();

    assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
    assert_eq!(f.live_pages_titled("Sync 2031-03-14").await, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_join_an_existing_meeting_by_block_or_by_page_5364() {
    let f = fixture().await;
    let notes = f.page("Notes").await;
    let source = f.block(&notes, "x").await;
    let mut req = request(new_meeting("Sync", None, MeetingLink::Block(source)));
    req.audio = Some(file("call.ogg", b"OggS audio"));
    let meeting = f.add(req).await.unwrap();

    let mut by_page = request(MeetingTarget::Page(meeting.page_id.clone()));
    by_page.transcript = Some(file("call.md", b"[00:01] Hi."));
    let joined = f.add(by_page).await.unwrap();
    assert_eq!(
        joined.recording_block_id, meeting.recording_block_id,
        "the page's block holding a file is its recording block"
    );

    let mut by_block = request(MeetingTarget::Block(meeting.recording_block_id.clone()));
    by_block.summary = Some(MeetingSummary::File(file("call.md", b"Shipped.")));
    f.add(by_block).await.unwrap();

    assert_eq!(
        f.files(&meeting.recording_block_id).await,
        vec![
            ("call.ogg".to_owned(), "audio/ogg".to_owned()),
            ("call.summary.md".to_owned(), "text/markdown".to_owned()),
            ("call.transcript.md".to_owned(), "text/markdown".to_owned()),
        ]
    );
    assert_eq!(f.children(&meeting.page_id).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_with_no_file_gets_a_recording_block_at_its_top_5364() {
    let f = fixture().await;
    let page = f.page("Old meeting").await;
    f.block(&page, "Agenda").await;
    let mut req = request(MeetingTarget::Page(page.clone()));
    req.audio = Some(file("call.mp3", b"ID3"));

    let joined = f.add(req).await.unwrap();

    let children = f.children(&page).await;
    assert_eq!(children[0].0, joined.recording_block_id.as_str());
    assert_eq!(children.len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_target_in_another_space_is_refused_5364() {
    let f = fixture().await;
    let notes = f.page("Notes").await;
    let source = f.block(&notes, "x").await;
    let mut req = request(MeetingTarget::Block(source));
    req.space_id = TEST_SPACE_B_ID.into();
    ensure_test_space_b(&f.pool).await;
    req.audio = Some(file("call.ogg", b"OggS"));

    let err = f.add(req).await.unwrap_err();

    assert!(
        matches!(err, AppError::Validation { .. } | AppError::NotFound(_)),
        "got {err:?}"
    );
    assert_eq!(f.files_on_disk(), 0);
}
