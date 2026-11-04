//! The mirror's task and commands against a test pool and a temporary folder:
//! what each tick writes, what it leaves alone, and what the folder commands
//! refuse.

use std::time::SystemTime;

use tauri::Manager;
use tempfile::TempDir;

use super::*;
use crate::commands::mirror::{get_mirror_status_inner, set_mirror_folder_inner};
use crate::commands::tests::common::{
    DEV, TEST_SPACE_ID, ensure_test_space, mark_block_as_space, settle,
};
use crate::commands::{
    create_block_inner, create_page_in_space_inner, delete_block_inner, edit_block_inner,
    move_block_inner,
};
use crate::db::init_pool;
use crate::materializer::Materializer;
use crate::sync_event_sinks::TauriEventSink;
use agaric_core::ulid::BlockId;
use agaric_store::op::{EditBlockPayload, OpPayload};
use agaric_sync::sync_events::SyncEventSink;

const ALPHA: &str = "TestSpace/Alpha.md";
const BETA: &str = "TestSpace/Beta.md";

struct Fx {
    pool: SqlitePool,
    mat: Materializer,
    state: MirrorState,
    mirror: Mirror,
    root: PathBuf,
    data: PathBuf,
    _dirs: [TempDir; 3],
}

impl Fx {
    /// A vault with the test space, and the mirror on in an empty folder.
    async fn new() -> Self {
        let db = TempDir::new().unwrap();
        let pool = init_pool(&db.path().join("test.db")).await.unwrap();
        let mat = Materializer::new(pool.clone());
        ensure_test_space(&pool).await;
        mark_block_as_space(&pool, TEST_SPACE_ID).await;
        let data = TempDir::new().unwrap();
        let folder = TempDir::new().unwrap();
        let state = MirrorState::new(data.path().to_path_buf());
        let root = folder.path().to_path_buf();
        set_mirror_folder_inner(&pool, DEV, &state, Some(path_string(&root)))
            .await
            .unwrap();
        let mirror = Mirror::open(pool.clone(), DEV.to_owned(), state.clone())
            .await
            .unwrap();
        Self {
            pool,
            mat,
            state,
            mirror,
            root,
            data: data.path().to_path_buf(),
            _dirs: [db, data, folder],
        }
    }

    /// A page of the test space titled `title`, holding `blocks` in order.
    async fn page(&self, title: &str, blocks: &[&str]) -> (String, Vec<String>) {
        let page = create_page_in_space_inner(
            &self.pool,
            DEV,
            &self.mat,
            None,
            title.into(),
            TEST_SPACE_ID.into(),
        )
        .await
        .unwrap()
        .into_string();
        let mut ids = Vec::new();
        for content in blocks {
            let parent = Some(BlockId::from_trusted(&page));
            let row = create_block_inner(
                &self.pool,
                DEV,
                &self.mat,
                "content".into(),
                (*content).into(),
                parent,
                None,
            )
            .await
            .unwrap();
            ids.push(row.id.into_string());
        }
        (page, ids)
    }

    async fn edit(&self, block: &str, text: &str) {
        edit_block_inner(
            &self.pool,
            DEV,
            &self.mat,
            BlockId::from_trusted(block),
            text.into(),
        )
        .await
        .unwrap();
    }

    async fn tick(&mut self) {
        settle(&self.mat).await;
        self.mirror.tick().await.unwrap();
    }

    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.root.join(path)).ok()
    }

    async fn render(&self, page: &str) -> String {
        get_page_file_inner(&self.pool, page).await.unwrap().text
    }

    async fn status(&self) -> MirrorStatus {
        get_mirror_status_inner(&self.pool, &self.state)
            .await
            .unwrap()
    }

    fn saved_state(&self, page: &str) -> Option<PageState> {
        let file = self.data.join(format!("mirror/state/{page}.json"));
        let bytes = std::fs::read(file).ok()?;
        Some(serde_json::from_slice(&bytes).unwrap())
    }

    /// Deliver a completed sync naming `changed_page_ids` through the app's
    /// sync sink, as a sync does.
    fn sync(&self, changed_page_ids: Vec<String>, changed_blocks: Option<usize>) {
        let app = tauri::test::mock_app();
        app.manage(self.state.clone());
        TauriEventSink(app.handle().clone()).on_sync_event(SyncEvent::Complete {
            remote_device_id: "peer-device".into(),
            ops_received: 1,
            ops_sent: 0,
            changed_page_ids,
            changed_blocks,
        });
    }

    /// Change a block's text as a sync does: in the tables, with no op of
    /// this device.
    async fn change_unseen(&self, block: &str, text: &str) {
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind(text)
            .bind(block)
            .execute(&self.pool)
            .await
            .unwrap();
    }
}

fn path_string(path: &Path) -> String {
    path.to_str().unwrap().to_owned()
}

fn diverged(page: &str, path: &str) -> Vec<MirrorFile> {
    vec![MirrorFile {
        page_id: page.to_owned(),
        path: path.to_owned(),
    }]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_is_written_as_its_file_render_with_the_ids_of_its_lines() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["hello"]).await;

    fx.tick().await;

    let render = fx.render(&page).await;
    assert!(render.contains("hello"), "{render}");
    assert_eq!(
        fx.read(ALPHA).as_deref(),
        Some(render.as_str()),
        "the file is the render"
    );
    let state = fx.saved_state(&page).expect("the page's state is saved");
    assert_eq!(state.path, ALPHA);
    let shadow = state.newest().expect("one shadow");
    assert_eq!(shadow.text, render, "the shadow is the bytes written");
    let line = render
        .split('\n')
        .position(|l| l.starts_with("hello"))
        .unwrap();
    let expected: Vec<Option<String>> = (0..render.split('\n').count())
        .map(|i| (i == line).then(|| blocks[0].clone()))
        .collect();
    assert_eq!(
        shadow.line_ids, expected,
        "the block's id on the line it starts on"
    );
    assert_eq!(
        std::fs::read_to_string(fx.root.join(store::MARKER_NAME)).unwrap(),
        format!("{DEV}\n"),
        "the folder names this device"
    );
    let status = fx.status().await;
    assert_eq!(status.folder, Some(path_string(&fx.root)));
    assert!(status.last_pass_ms.is_some(), "{status:?}");
    assert!(
        status.diverged.is_empty() && status.failed.is_empty(),
        "{status:?}"
    );
}

/// Only a block something addresses carries its `^ID` in the file (#6277
/// decision 6): here one a block of another page refers to.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_anchors_the_block_another_page_refers_to_and_no_other() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["target", "plain"]).await;
    fx.page("Beta", &[&format!("see (({}))", blocks[0])]).await;

    fx.tick().await;

    let file = fx.read(ALPHA).expect("Alpha is written");
    assert!(file.contains(&format!("target ^{}", blocks[0])), "{file}");
    assert!(!file.contains(&format!("^{}", blocks[1])), "{file}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unchanged_page_writes_nothing() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    let file = std::fs::File::options()
        .write(true)
        .open(fx.root.join(ALPHA))
        .unwrap();
    let old = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
    file.set_modified(old).unwrap();
    let path = fx.root.join(ALPHA);
    let modified = || std::fs::metadata(&path).unwrap().modified().unwrap();

    fx.state.restart();
    fx.mirror.tick().await.unwrap();
    assert_eq!(
        modified(),
        old,
        "a full pass leaves an unchanged file alone"
    );

    fx.edit(&blocks[0], "changed").await;
    fx.tick().await;
    assert_ne!(modified(), old, "an edit is written");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_external_edit_is_never_overwritten_and_is_listed_as_diverged() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    std::fs::write(fx.root.join(ALPHA), "edited outside\n").unwrap();

    fx.edit(&blocks[0], "edited inside").await;
    fx.tick().await;

    assert_eq!(fx.read(ALPHA).as_deref(), Some("edited outside\n"));
    assert_eq!(fx.status().await.diverged, diverged(&page, ALPHA));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_marker_pauses_the_mirror_until_it_is_back() {
    let mut fx = Fx::new().await;
    std::fs::remove_file(fx.root.join(store::MARKER_NAME)).unwrap();
    fx.page("Alpha", &["hello"]).await;

    fx.tick().await;
    assert!(!fx.root.join("TestSpace").exists(), "no folder is created");
    assert!(fx.status().await.paused.is_some(), "the status says why");

    store::write_marker(&fx.root, DEV).unwrap();
    fx.tick().await;
    assert!(fx.read(ALPHA).is_some(), "it resumes with a full pass");
    assert_eq!(fx.status().await.paused, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_folder_pauses_the_mirror_and_is_never_created() {
    let mut fx = Fx::new().await;
    std::fs::remove_dir_all(&fx.root).unwrap();
    fx.page("Alpha", &["hello"]).await;

    fx.tick().await;

    assert!(!fx.root.exists(), "the folder is not created again");
    let status = fx.status().await;
    assert!(
        status
            .paused
            .as_ref()
            .is_some_and(|why| why.contains("missing")),
        "{status:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_mirror_folder_refuses_a_folder_it_must_not_write_in() {
    let fx = Fx::new().await;
    let refusal = |path: &Path| {
        let path = path_string(path);
        let fx = &fx;
        async move { set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(path)).await }
    };
    let foreign = TempDir::new().unwrap();
    store::write_marker(foreign.path(), "another-device").unwrap();
    let full = TempDir::new().unwrap();
    std::fs::write(full.path().join("notes.md"), "mine").unwrap();
    let inside = fx.data.join("inside");
    std::fs::create_dir(&inside).unwrap();
    let missing = fx.data.join("missing");

    for (folder, why) in [
        (foreign.path(), "another device's mirror"),
        (full.path(), "must be empty"),
        (fx.data.as_path(), "Agaric's data"),
        (inside.as_path(), "Agaric's data"),
        (fx.data.parent().unwrap(), "Agaric's data"),
        (Path::new("relative/folder"), "absolute"),
        (missing.as_path(), "existing folder"),
    ] {
        match refusal(folder).await {
            Err(AppError::Validation { message, .. }) => {
                assert!(message.contains(why), "{folder:?}: {message}");
            }
            other => panic!("{folder:?} must be refused, got {other:?}"),
        }
    }
    assert_eq!(
        store::folder(&fx.pool).await.unwrap(),
        Some(path_string(&fx.root)),
        "a refusal keeps the folder"
    );
    assert_eq!(
        store::marker_device(full.path()).unwrap(),
        None,
        "nor marks one"
    );
    std::fs::write(fx.root.join("notes.md"), "mine").unwrap();
    assert!(
        refusal(&fx.root).await.is_ok(),
        "its own folder is taken back, files and all"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_the_mirror_off_leaves_its_files_and_writes_no_more() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    let written = fx.read(ALPHA);

    let status = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, None)
        .await
        .unwrap();
    fx.edit(&blocks[0], "changed").await;
    fx.tick().await;

    assert_eq!(status.folder, None);
    assert_eq!(fx.read(ALPHA), written, "the file stays as it was");
    assert!(fx.root.join(store::MARKER_NAME).exists(), "and the marker");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_moves_the_file_and_rewrites_the_pages_linking_to_it() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["hello"]).await;
    let (beta, _) = fx.page("Beta", &[&format!("see [[{alpha}]]")]).await;
    fx.tick().await;
    assert!(
        fx.read(BETA).unwrap().contains("[[Alpha]]"),
        "{:?}",
        fx.read(BETA)
    );

    fx.edit(&alpha, "Gamma").await;
    fx.tick().await;

    assert_eq!(fx.read(ALPHA), None, "the old file goes");
    assert_eq!(fx.read("TestSpace/Gamma.md"), Some(fx.render(&alpha).await));
    assert_eq!(fx.read(BETA), Some(fx.render(&beta).await));
    assert!(
        fx.read(BETA).unwrap().contains("[[Gamma]]"),
        "{:?}",
        fx.read(BETA)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_over_a_diverged_file_freezes_the_page_at_its_old_path() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    std::fs::write(fx.root.join(ALPHA), "edited outside\n").unwrap();

    fx.edit(&page, "Gamma").await;
    fx.tick().await;

    assert_eq!(fx.read(ALPHA).as_deref(), Some("edited outside\n"));
    assert_eq!(
        fx.read("TestSpace/Gamma.md"),
        None,
        "nothing is written elsewhere"
    );
    assert_eq!(fx.status().await.diverged, diverged(&page, ALPHA));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_page_has_its_file_and_its_state_removed() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;

    delete_block_inner(&fx.pool, DEV, &fx.mat, BlockId::from_trusted(&page))
        .await
        .unwrap();
    fx.tick().await;

    assert_eq!(fx.read(ALPHA), None);
    assert!(
        !fx.root.join("TestSpace").exists(),
        "its emptied folder goes too"
    );
    assert!(fx.root.is_dir(), "but never the mirror's folder");
    assert_eq!(fx.saved_state(&page), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_block_moved_to_another_page_leaves_its_old_file() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["moving", "staying"]).await;
    let (beta, _) = fx.page("Beta", &["there"]).await;
    fx.tick().await;

    let to = Some(BlockId::from_trusted(&beta));
    move_block_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        BlockId::from_trusted(&blocks[0]),
        to,
        0,
    )
    .await
    .unwrap();
    fx.tick().await;

    assert!(
        !fx.read(ALPHA).unwrap().contains("moving"),
        "{:?}",
        fx.read(ALPHA)
    );
    assert!(
        fx.read(BETA).unwrap().contains("moving"),
        "{:?}",
        fx.read(BETA)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_written_before_a_crash_left_its_state_stale_is_adopted() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    fx.edit(&blocks[0], "after the crash").await;
    let render = fx.render(&page).await;
    std::fs::write(fx.root.join(ALPHA), &render).unwrap();

    fx.tick().await;

    assert!(
        fx.status().await.diverged.is_empty(),
        "{:?}",
        fx.status().await
    );
    let state = fx.saved_state(&page).unwrap();
    assert_eq!(
        state.newest().map(|s| s.text.as_str()),
        Some(render.as_str())
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sync_rewrites_the_pages_it_names_and_one_naming_none_rescans() {
    let mut fx = Fx::new().await;
    let (alpha, a) = fx.page("Alpha", &["one"]).await;
    let (_, b) = fx.page("Beta", &["two"]).await;
    fx.tick().await;
    let contains = |fx: &Fx, path: &str, text: &str| fx.read(path).unwrap().contains(text);

    fx.change_unseen(&a[0], "synced one").await;
    fx.tick().await;
    assert!(
        !contains(&fx, ALPHA, "synced one"),
        "no op of this device names it"
    );
    fx.sync(vec![], Some(0));
    fx.tick().await;
    assert!(
        !contains(&fx, ALPHA, "synced one"),
        "a sync that changed nothing"
    );
    fx.sync(vec![alpha], Some(1));
    fx.tick().await;
    assert!(
        contains(&fx, ALPHA, "synced one"),
        "the page the sync named"
    );

    fx.change_unseen(&b[0], "synced two").await;
    fx.sync(vec![], None);
    fx.tick().await;
    assert!(
        contains(&fx, BETA, "synced two"),
        "a snapshot catch-up rescans"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_op_older_than_every_other_is_still_mirrored() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;

    let payload = OpPayload::EditBlock(EditBlockPayload {
        block_id: BlockId::from_trusted(&blocks[0]),
        to_text: "from the past".into(),
        prev_edit: None,
        prior_text: None,
    });
    agaric_store::op_log::append_local_op_at(&fx.pool, DEV, payload, 0)
        .await
        .unwrap();
    fx.change_unseen(&blocks[0], "from the past").await;
    fx.tick().await;

    assert!(
        fx.read(ALPHA).unwrap().contains("from the past"),
        "{:?}",
        fx.read(ALPHA)
    );
}

#[test]
fn a_state_keeps_the_last_three_texts_written_once_each() {
    let shadow = |n: usize| Shadow {
        text: format!("v{n}"),
        line_ids: vec![None],
    };
    let mut state = PageState {
        path: ALPHA.to_owned(),
        shadows: Vec::new(),
    };
    for n in 0..5 {
        state.record(ALPHA.to_owned(), shadow(n));
        state.record(ALPHA.to_owned(), shadow(n));
    }
    assert_eq!(state.shadows, vec![shadow(2), shadow(3), shadow(4)]);
}

#[test]
fn write_atomic_leaves_the_target_alone_when_it_cannot_finish() {
    let dir = TempDir::new().unwrap();
    let blocked = dir.path().join("blocked.md");
    std::fs::create_dir(&blocked).unwrap();
    std::fs::write(blocked.join("inside"), "kept").unwrap();
    let tmp = dir.path().join(".blocked.md.agaric-tmp");

    assert!(
        store::write_atomic(&blocked, b"new").is_err(),
        "the rename fails"
    );
    assert!(!tmp.exists(), "the temporary file is removed");
    assert_eq!(
        std::fs::read_to_string(blocked.join("inside")).unwrap(),
        "kept"
    );

    let file = dir.path().join("file.md");
    std::fs::write(&file, "old").unwrap();
    std::fs::create_dir_all(dir.path().join(".file.md.agaric-tmp/x")).unwrap();
    assert!(
        store::write_atomic(&file, b"new").is_err(),
        "no temporary file"
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "old",
        "the target is untouched until the new bytes are whole"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_that_cannot_be_written_records_no_shadow() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    let before = fx.saved_state(&page);

    std::fs::create_dir_all(fx.root.join("TestSpace/.Alpha.md.agaric-tmp/x")).unwrap();
    fx.edit(&blocks[0], "changed").await;
    fx.tick().await;

    assert_eq!(fx.saved_state(&page), before, "the state is unchanged");
    let failed = fx.status().await.failed;
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0].page_id, page);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_state_that_cannot_be_saved_is_saved_on_the_next_tick() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    let state_file = fx.data.join(format!("mirror/state/{page}.json"));
    std::fs::remove_file(&state_file).unwrap();
    std::fs::create_dir_all(state_file.join("x")).unwrap();

    fx.edit(&blocks[0], "changed").await;
    fx.tick().await;
    assert_eq!(fx.status().await.failed.len(), 1, "the save failed");

    std::fs::remove_dir_all(&state_file).unwrap();
    fx.tick().await;
    let render = fx.render(&page).await;
    assert_eq!(
        fx.saved_state(&page)
            .and_then(|s| s.newest().map(|s| s.text.clone())),
        Some(render),
        "the text on disk is recorded once the state can be saved"
    );
    assert!(fx.status().await.failed.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_marker_naming_another_device_pauses_the_mirror() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    let written = fx.read(ALPHA);

    store::write_marker(&fx.root, "another-device").unwrap();
    fx.edit(&blocks[0], "changed").await;
    fx.page("Beta", &["two"]).await;
    fx.tick().await;

    assert_eq!(fx.read(ALPHA), written, "nothing is written");
    assert_eq!(fx.read(BETA), None, "nor created");
    let status = fx.status().await;
    assert!(
        status
            .paused
            .as_ref()
            .is_some_and(|why| why.contains("another device")),
        "{status:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deleted_page_whose_file_was_edited_keeps_its_file_as_diverged() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    std::fs::write(fx.root.join(ALPHA), "edited outside\n").unwrap();

    delete_block_inner(&fx.pool, DEV, &fx.mat, BlockId::from_trusted(&page))
        .await
        .unwrap();
    fx.tick().await;

    assert_eq!(fx.read(ALPHA).as_deref(), Some("edited outside\n"));
    assert_eq!(fx.status().await.diverged, diverged(&page, ALPHA));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_diverged_file_restored_to_what_was_written_is_written_again() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    let written = fx.read(ALPHA).unwrap();
    std::fs::write(fx.root.join(ALPHA), "edited outside\n").unwrap();
    fx.edit(&blocks[0], "edited inside").await;
    fx.tick().await;
    assert_eq!(fx.status().await.diverged, diverged(&page, ALPHA));

    std::fs::write(fx.root.join(ALPHA), &written).unwrap();
    fx.tick().await;

    assert_eq!(fx.read(ALPHA), Some(fx.render(&page).await));
    assert!(fx.status().await.diverged.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_marker_lost_mid_pass_stops_it_before_any_folder_is_created() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["hello"]).await;
    settle(&fx.mat).await;
    std::fs::remove_file(fx.root.join(store::MARKER_NAME)).unwrap();

    // The tick checked the marker; it goes before the pass writes.
    let root = fx.root.clone();
    fx.mirror.pass(&root, true, HashSet::new()).await.unwrap();

    assert!(!fx.root.join("TestSpace").exists(), "no folder is created");
    assert!(fx.status().await.paused.is_some(), "the mirror is paused");
    assert!(fx.mirror.full_due, "and resumes with a full pass");
}
