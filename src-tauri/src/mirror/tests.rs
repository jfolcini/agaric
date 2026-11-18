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
    _dirs: Vec<TempDir>,
}

impl Fx {
    /// A vault with the test space, its database in the data folder as the
    /// app's is, and the mirror on in an empty folder.
    async fn new() -> Self {
        let data = TempDir::new().unwrap();
        let pool = init_pool(&data.path().join("test.db")).await.unwrap();
        let mat = Materializer::new(pool.clone());
        ensure_test_space(&pool).await;
        mark_block_as_space(&pool, TEST_SPACE_ID).await;
        let folder = TempDir::new().unwrap();
        let state = MirrorState::new(data.path().to_path_buf());
        let root = folder.path().to_path_buf();
        set_mirror_folder_inner(&pool, DEV, &state, Some(path_string(&root)), true)
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
            _dirs: vec![data, folder],
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
        get_mirror_status_inner(&self.pool, DEV, &self.state)
            .await
            .unwrap()
    }

    /// Where the folder's states and its record of copies are saved, by the
    /// key `StateDir` derives.
    fn state_dir(&self) -> PathBuf {
        let key: String = blake3::hash(path_string(&self.root).as_bytes())
            .to_hex()
            .chars()
            .take(32)
            .collect();
        self.data.join("mirror/folders").join(key)
    }

    fn state_file(&self, page: &str) -> PathBuf {
        self.state_dir().join(format!("{page}.json"))
    }

    fn saved_state(&self, page: &str) -> Option<PageState> {
        let bytes = std::fs::read(self.state_file(page)).ok()?;
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
    let paused = fx.status().await.paused;
    assert!(
        paused.as_ref().is_some_and(
            |why| why.contains("no .agaric-mirror marker") && why.contains("put the file back")
        ),
        "the status says why, and the way out: {paused:?}"
    );

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
        async move { set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(path), true).await }
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
    for folder in [foreign.path(), full.path()] {
        let Err(AppError::Validation { message, .. }) = refusal(folder).await else {
            panic!("{folder:?} must be refused");
        };
        assert!(
            message.contains("choose an empty folder"),
            "the way out: {message}"
        );
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
async fn set_mirror_folder_takes_a_folder_holding_only_hidden_entries() {
    let fx = Fx::new().await;
    let fresh = TempDir::new().unwrap();
    std::fs::create_dir(fresh.path().join(".git")).unwrap();
    std::fs::write(fresh.path().join(".DS_Store"), "").unwrap();

    set_mirror_folder_inner(
        &fx.pool,
        DEV,
        &fx.state,
        Some(path_string(fresh.path())),
        true,
    )
    .await
    .unwrap();

    assert_eq!(
        store::marker_device(fresh.path()).unwrap().as_deref(),
        Some(DEV)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_the_mirror_off_leaves_its_files_and_writes_no_more() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;
    let written = fx.read(ALPHA);

    let status = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, None, true)
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
        buffer: None,
        render: None,
    };
    let mut state = PageState {
        path: ALPHA.to_owned(),
        ..PageState::default()
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
    let state_file = fx.state_file(&page);
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
        status.paused.as_ref().is_some_and(
            |why| why.contains("another device") && why.contains("choose an empty folder")
        ),
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

/// A block ref is written as `[[Title#^ID]]` (#6277 F2), so it resolves only
/// while the target's file carries `^ID` and the link names the target's
/// page: a new ref rewrites the target's page, and the target's page rename
/// or move rewrites the referring page.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_block_ref_anchors_its_target_in_the_next_pass() {
    let mut fx = Fx::new().await;
    let (alpha, blocks) = fx.page("Alpha", &["target"]).await;
    let (_, refs) = fx.page("Beta", &["plain"]).await;
    fx.tick().await;
    assert!(
        !fx.read(ALPHA).unwrap().contains('^'),
        "{:?}",
        fx.read(ALPHA)
    );

    fx.edit(&refs[0], &format!("see (({}))", blocks[0])).await;
    fx.tick().await;

    assert_eq!(fx.read(ALPHA), Some(fx.render(&alpha).await));
    assert!(
        fx.read(ALPHA)
            .unwrap()
            .contains(&format!("target ^{}", blocks[0])),
        "{:?}",
        fx.read(ALPHA)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_rewrites_the_pages_referring_to_its_blocks() {
    let mut fx = Fx::new().await;
    let (alpha, blocks) = fx.page("Alpha", &["target"]).await;
    let (beta, _) = fx.page("Beta", &[&format!("see (({}))", blocks[0])]).await;
    fx.tick().await;
    let before = format!("[[Alpha#^{}]]", blocks[0]);
    assert!(
        fx.read(BETA).unwrap().contains(&before),
        "{:?}",
        fx.read(BETA)
    );

    fx.edit(&alpha, "Gamma").await;
    fx.tick().await;

    assert_eq!(fx.read(BETA), Some(fx.render(&beta).await));
    let after = format!("[[Gamma#^{}]]", blocks[0]);
    assert!(
        fx.read(BETA).unwrap().contains(&after),
        "{:?}",
        fx.read(BETA)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_moved_block_rewrites_the_pages_referring_to_it() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["target"]).await;
    let (gamma, _) = fx.page("Gamma", &["there"]).await;
    let (beta, _) = fx.page("Beta", &[&format!("see (({}))", blocks[0])]).await;
    fx.tick().await;

    let to = Some(BlockId::from_trusted(&gamma));
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

    assert_eq!(fx.read(BETA), Some(fx.render(&beta).await));
    let after = format!("[[Gamma#^{}]]", blocks[0]);
    assert!(
        fx.read(BETA).unwrap().contains(&after),
        "{:?}",
        fx.read(BETA)
    );
}

fn one_state(text: &str) -> PageState {
    PageState {
        path: "TestSpace/Alpha.md".into(),
        shadows: vec![Shadow {
            text: text.into(),
            line_ids: vec![None],
            buffer: None,
            render: None,
        }],
        ..PageState::default()
    }
}

/// Each folder keeps its own states: binding another moves none of them, so
/// a crash at any point of a folder change loses none.
#[test]
fn each_folder_keeps_its_own_states() {
    let data = TempDir::new().unwrap();
    let mut states = StateDir::new(data.path());
    assert!(states.bind("/folder/a").unwrap());
    states.save("PAGE", &one_state("a\n")).unwrap();
    assert!(states.bind("/folder/b").unwrap());
    assert_eq!(
        states.load().unwrap().get("PAGE"),
        None,
        "b has none of a's"
    );
    states.save("PAGE", &one_state("b\n")).unwrap();
    assert!(!states.bind("/folder/b").unwrap(), "already bound");

    // A new start, as after a crash: a fresh `StateDir` finds each as left.
    let mut again = StateDir::new(data.path());
    again.bind("/folder/a").unwrap();
    assert_eq!(again.load().unwrap().get("PAGE"), Some(&one_state("a\n")));
    again.bind("/folder/b").unwrap();
    assert_eq!(again.load().unwrap().get("PAGE"), Some(&one_state("b\n")));
}

/// A fresh start drops a folder's states and head and keeps its record of
/// copies: they are still the copies the mirror wrote there.
#[test]
fn forgetting_a_folder_keeps_its_record_of_copies_alone() {
    let data = TempDir::new().unwrap();
    let mut states = StateDir::new(data.path());
    states.bind("/folder/a").unwrap();
    states.save("PAGE", &one_state("a\n")).unwrap();
    let head = Head {
        seq: 1,
        hash: None,
        older: false,
    };
    states.save_head(&head).unwrap();
    let copies = states.copies_file("/folder/a");
    std::fs::write(&copies, b"{}").unwrap();

    states.forget("/folder/a").unwrap();

    assert!(states.load().unwrap().is_empty());
    assert_eq!(states.head().unwrap(), None);
    assert!(copies.exists(), "the record of copies stays");
}

/// States from before each folder kept its own directory are the folder
/// `mirror/folder` names, or the one bound when it names none, and an
/// adoption cut short is finished by the next bind.
#[test]
fn states_of_the_earlier_layout_are_adopted_by_their_folder() {
    let data = TempDir::new().unwrap();
    let legacy = data.path().join("mirror/state");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::write(
        legacy.join("PAGE.json"),
        serde_json::to_vec(&one_state("a\n")).unwrap(),
    )
    .unwrap();
    std::fs::write(data.path().join("mirror/folder"), "/folder/a").unwrap();

    let mut states = StateDir::new(data.path());
    states.bind("/folder/b").unwrap();
    assert_eq!(states.load().unwrap().get("PAGE"), None, "they are a's");
    states.bind("/folder/a").unwrap();
    assert_eq!(states.load().unwrap().get("PAGE"), Some(&one_state("a\n")));
    assert!(!legacy.exists());
    assert!(!data.path().join("mirror/folder").exists());

    // Naming no folder, they are the one bound.
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::write(
        legacy.join("OTHER.json"),
        serde_json::to_vec(&one_state("c\n")).unwrap(),
    )
    .unwrap();
    let mut fresh = StateDir::new(data.path());
    fresh.bind("/folder/c").unwrap();
    assert_eq!(fresh.load().unwrap().get("OTHER"), Some(&one_state("c\n")));

    // Renamed, then a crash before `mirror/folder` went: the next bind ends it.
    std::fs::write(data.path().join("mirror/folder"), "/folder/c").unwrap();
    let mut resumed = StateDir::new(data.path());
    resumed.bind("/folder/c").unwrap();
    assert_eq!(
        resumed.load().unwrap().get("OTHER"),
        Some(&one_state("c\n"))
    );
    assert!(!data.path().join("mirror/folder").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_renamed_page_s_state_follows_its_file() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["hello"]).await;
    fx.tick().await;

    fx.edit(&page, "Gamma").await;
    fx.tick().await;

    assert_eq!(fx.saved_state(&page).unwrap().path, "TestSpace/Gamma.md");
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot really";

impl Fx {
    /// Copying on, and `block` holding an image `cat.png`; returns the copy's
    /// path below the folder.
    async fn image_in(&self, block: &str) -> String {
        crate::commands::mirror::set_mirror_copy_files_inner(&self.pool, DEV, &self.state, true)
            .await
            .unwrap();
        let attachment = crate::commands::add_attachment_with_bytes_inner(
            &self.pool,
            DEV,
            &self.mat,
            &self.data,
            BlockId::from_trusted(block),
            "cat.png".into(),
            "image/png".into(),
            PNG.to_vec(),
        )
        .await
        .unwrap()
        .id
        .into_string();
        self.edit(block, &format!("![a cat](attachment:{attachment})"))
            .await;
        format!("TestSpace/assets/{attachment}/cat.png")
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pass_writing_another_page_keeps_an_unchanged_page_s_copy() {
    let mut fx = Fx::new().await;
    let (_, alpha) = fx.page("Alpha", &["a"]).await;
    let (_, beta) = fx.page("Beta", &["b"]).await;
    let copy = fx.image_in(&alpha[0]).await;
    fx.tick().await;
    assert!(fx.root.join(&copy).exists());

    fx.edit(&beta[0], "B").await;
    fx.tick().await;

    assert!(fx.root.join(&copy).exists(), "only a full pass sweeps");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_pass_leaving_a_page_frozen_keeps_its_copy() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["a"]).await;
    let copy = fx.image_in(&blocks[0]).await;
    fx.tick().await;
    let edited = fx.read(ALPHA).unwrap().replace("a cat", "the cat");
    std::fs::write(fx.root.join(ALPHA), edited).unwrap();
    fx.edit(&page, "Gamma").await;
    fx.tick().await;
    assert_eq!(fx.status().await.diverged, diverged(&page, ALPHA));

    fx.sync(Vec::new(), None);
    fx.tick().await;

    assert!(
        fx.root.join(&copy).exists(),
        "a pass that renders no frozen page cannot tell its copies unlinked"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_copy_that_cannot_be_written_is_listed_while_copying_is_on() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["a"]).await;
    let copy = fx.image_in(&blocks[0]).await;
    let stored: String = sqlx::query_scalar("SELECT fs_path FROM attachments")
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    std::fs::remove_file(fx.data.join(stored)).unwrap();

    fx.tick().await;

    let failed: Vec<String> = fx
        .status()
        .await
        .failed
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(failed, [copy]);
}

/// A record of copies written when one was kept for every folder,
/// `mirror/copies.json` (#6963), is the record of the folder mirrored when it
/// is found: a copy changed there is still left as the user made it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_of_copies_kept_for_every_folder_becomes_the_mirrored_folder_s_6963() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["one"]).await;
    let copy = fx.image_in(&blocks[0]).await;
    let attachment = copy.split('/').nth(2).unwrap();
    // As that version left them: the copy, drawn over since, and its record.
    let file = fx.root.join(&copy);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, b"drawn over").unwrap();
    let legacy = fx.data.join("mirror/copies.json");
    let record = serde_json::json!({
        copy.as_str(): { "id": attachment, "len": PNG.len(), "modified_ms": 1 },
    });
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::fs::write(&legacy, record.to_string()).unwrap();
    fx.reopen().await;

    fx.tick().await;
    fx.tick().await;

    assert_eq!(std::fs::read(&file).unwrap(), b"drawn over");
    let listed: Vec<String> = fx
        .status()
        .await
        .diverged
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(listed, [copy], "recorded, it is listed as changed");
    assert!(
        !legacy.exists(),
        "the record is the folder's own from now on"
    );
}

// ── A vault older than its folder (#6887) ───────────────────────────────

impl Fx {
    /// The vault as it is now, as a backup holds it.
    async fn backup(&self) -> TempDir {
        settle(&self.mat).await;
        let dir = TempDir::new().unwrap();
        sqlx::query("VACUUM INTO ?")
            .bind(path_string(&dir.path().join("test.db")))
            .execute(&self.pool)
            .await
            .unwrap();
        dir
    }

    /// The mirror as the app's next start opens it.
    async fn reopen(&mut self) {
        self.state = MirrorState::new(self.data.clone());
        self.mirror = Mirror::open(self.pool.clone(), DEV.to_owned(), self.state.clone())
            .await
            .unwrap();
    }

    /// Agaric started over the vault in `db`, a restored backup or none yet,
    /// with the data folder and the device it had.
    async fn start_over(&mut self, db: TempDir) {
        self.mat.shutdown();
        self.pool = init_pool(&db.path().join("test.db")).await.unwrap();
        self.mat = Materializer::new(self.pool.clone());
        let registry = &self.mat.loro_state().registry;
        agaric_engine::loro::snapshot::rehydrate_registry(&self.pool, registry, DEV)
            .await
            .unwrap();
        self._dirs.push(db);
        self.reopen().await;
    }

    /// This device's last op.
    async fn head(&self) -> i64 {
        sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) FROM op_log WHERE device_id = ?")
            .bind(DEV)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// Compaction with none of this device's ops left.
    async fn compact(&self) {
        let mut tx = self.pool.begin().await.unwrap();
        agaric_store::op_log::prune(&mut tx, i64::MAX, DEV, i64::MAX)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(self.head().await, 0, "the fixture: no op is left");
    }

    async fn paused_as_older(&self) -> bool {
        let status = self.status().await;
        status
            .paused
            .is_some_and(|why| why.contains("older than the folder"))
    }

    /// Alpha and Beta written to the folder, then the vault restored from a
    /// backup that holds Alpha as it was before an edit and lacks Beta.
    async fn restored() -> (Self, Folder) {
        let mut fx = Self::new().await;
        let (page, blocks) = fx.page("Alpha", &["one"]).await;
        fx.tick().await;
        let backup = fx.backup().await;
        fx.edit(&blocks[0], "one, edited since").await;
        fx.page("Beta", &["two"]).await;
        fx.tick().await;
        let folder = Folder {
            page,
            files: fx.files(),
            head: fx.head().await,
        };
        let [alpha, beta] = &folder.files;
        let edited = alpha.as_ref().is_some_and(|text| text.contains("since"));
        assert!(edited && beta.is_some(), "the fixture: {:?}", folder.files);
        fx.start_over(backup).await;
        (fx, folder)
    }

    /// Alpha's file and Beta's.
    fn files(&self) -> [Option<String>; 2] {
        [self.read(ALPHA), self.read(BETA)]
    }
}

/// The folder as the vault since restored last wrote it: Alpha's page, both
/// files, of which the restored vault holds Alpha's page older and lacks
/// Beta's, and the vault's last op then.
struct Folder {
    page: String,
    files: [Option<String>; 2],
    head: i64,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restored_vault_pauses_the_mirror_and_changes_no_file() {
    let (mut fx, folder) = Fx::restored().await;

    for _ in 0..3 {
        fx.tick().await;
    }

    assert_eq!(fx.files(), folder.files);
    assert!(fx.paused_as_older().await, "{:?}", fx.status().await);
}

/// A restored vault's own ops soon number more than the folder's last: it is
/// told from the vault that wrote the folder by that op's hash.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restored_vault_written_past_the_folder_s_last_op_stays_paused() {
    let (mut fx, folder) = Fx::restored().await;
    let (_, blocks) = fx.page("Gamma", &["three"]).await;
    for text in ["four", "five", "six", "seven"] {
        fx.edit(&blocks[0], text).await;
    }
    assert!(
        fx.head().await > folder.head,
        "the fixture: past the folder"
    );
    for _ in 0..3 {
        fx.tick().await;
    }

    assert_eq!(fx.files(), folder.files);
    assert!(fx.paused_as_older().await, "{:?}", fx.status().await);
    assert_eq!(fx.read("TestSpace/Gamma.md"), None, "nothing is written");
}

/// The way out of the pause: the folder chosen again takes the vault's pages
/// as new ones, and keeps every file the vault lacks or holds otherwise.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_chosen_again_for_a_restored_vault_keeps_every_file() {
    let (mut fx, folder) = Fx::restored().await;
    fx.tick().await;
    assert!(fx.paused_as_older().await, "{:?}", fx.status().await);
    fx.page("Gamma", &["three"]).await;

    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(path_string(&fx.root)), true)
        .await
        .unwrap();
    for _ in 0..4 {
        fx.tick().await;
    }

    let status = fx.status().await;
    assert_eq!(status.paused, None);
    assert_eq!(fx.files(), folder.files);
    assert_eq!(status.diverged, diverged(&folder.page, ALPHA));
    assert!(
        fx.read("TestSpace/Gamma.md").is_some(),
        "the vault's own pages are written"
    );
}

/// Another folder chosen ends the pause too: chosen again before a tick, it
/// is not taken for the folder the vault is older than, and started fresh.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_folder_chosen_ends_the_older_vault_pause() {
    let (mut fx, _) = Fx::restored().await;
    fx.tick().await;
    assert!(fx.state.is_behind(), "the fixture: {:?}", fx.status().await);

    let other = TempDir::new().unwrap();
    let chosen = Some(path_string(other.path()));
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, chosen, true)
        .await
        .unwrap();

    assert!(!fx.state.is_behind());
}

/// The folder chosen again keeps its copies too: one whose attachment the
/// vault lacks may be the only copy of that file left, and one changed in
/// the folder is the user's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_chosen_again_for_a_restored_vault_keeps_every_copy() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["one", "two"]).await;
    let held = fx.image_in(&blocks[0]).await;
    fx.tick().await;
    let backup = fx.backup().await;
    let lacked = fx.image_in(&blocks[1]).await;
    fx.tick().await;
    std::fs::write(fx.root.join(&held), b"drawn over").unwrap();
    fx.start_over(backup).await;
    fx.tick().await;
    assert!(fx.paused_as_older().await, "{:?}", fx.status().await);

    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(path_string(&fx.root)), true)
        .await
        .unwrap();
    for _ in 0..4 {
        fx.tick().await;
    }

    assert_eq!(fx.status().await.paused, None);
    let copy = |path: &str| std::fs::read(fx.root.join(path)).ok();
    assert_eq!(copy(&lacked).as_deref(), Some(PNG), "the vault lacks it");
    assert_eq!(copy(&held).as_deref(), Some(&b"drawn over"[..]));
}

/// A fresh start that fails part way, its states dropped but its copies not
/// yet forgotten, is made again on the next tick: the states still in memory,
/// with no head left to tell the vault older, would roll the folder back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fresh_start_that_fails_part_way_is_made_again() {
    let (mut fx, folder) = Fx::restored().await;
    fx.tick().await;
    assert!(fx.paused_as_older().await, "{:?}", fx.status().await);
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(path_string(&fx.root)), true)
        .await
        .unwrap();
    // The record of copies cannot be saved, for one tick.
    let copies = fx.state_dir().join("copies");
    assert!(!copies.exists(), "the fixture: no copy is recorded");
    std::fs::create_dir(&copies).unwrap();
    settle(&fx.mat).await;
    assert!(fx.mirror.tick().await.is_err(), "the fixture: it fails");
    std::fs::remove_dir(&copies).unwrap();

    for _ in 0..4 {
        fx.tick().await;
    }

    assert_eq!(fx.files(), folder.files);
}

/// The folder chosen again reads in no file the vault lacks unasked: with no
/// state left, such a file is no page's, read onto a new page while reading
/// back is on. It is turned off, and the file listed from the moment the
/// folder is chosen, for the user to read in or not.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_chosen_again_for_a_restored_vault_reads_in_nothing_unasked() {
    let (mut fx, _) = Fx::restored().await;
    let ingest = Ingest {
        pool: fx.pool.clone(),
        materializer: fx.mat.clone(),
        notify: Arc::new(|_| {}),
        notify_held: Arc::new(|_| {}),
    };
    fx.mirror = Mirror::open(fx.pool.clone(), DEV.to_owned(), fx.state.clone())
        .await
        .unwrap()
        .with_ingest(ingest);
    fx.tick().await;
    assert!(fx.paused_as_older().await, "{:?}", fx.status().await);

    let chosen =
        set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(path_string(&fx.root)), true)
            .await
            .unwrap();
    for _ in 0..4 {
        fx.tick().await;
    }

    let betas: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks
          WHERE block_type = 'page' AND content = 'Beta' AND deleted_at IS NULL",
    )
    .fetch_one(&fx.pool)
    .await
    .unwrap();
    assert_eq!(betas, 0, "Beta's file is read onto no page");
    assert!(
        chosen.pending.iter().any(|file| file.path == BETA),
        "{:?}",
        chosen.pending
    );
    let status = fx.status().await;
    assert!(!status.read_back);
    assert!(
        status.pending.iter().any(|file| file.path == BETA),
        "{:?}",
        status.pending
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_vault_given_its_old_folder_pauses_the_mirror_and_removes_no_file() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    let alpha = fx.read(ALPHA);
    assert!(alpha.is_some(), "the fixture: Alpha is written");

    fx.start_over(TempDir::new().unwrap()).await;
    ensure_test_space(&fx.pool).await;
    mark_block_as_space(&fx.pool, TEST_SPACE_ID).await;
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(path_string(&fx.root)), true)
        .await
        .unwrap();
    for _ in 0..3 {
        fx.tick().await;
    }

    assert_eq!(fx.read(ALPHA), alpha);
    assert!(fx.paused_as_older().await, "{:?}", fx.status().await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_same_vault_started_again_is_not_paused() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;

    fx.reopen().await;
    fx.tick().await;
    assert_eq!(fx.status().await.paused, None);

    fx.edit(&blocks[0], "uno").await;
    fx.tick().await;
    assert!(fx.read(ALPHA).unwrap().contains("uno"), "written on");
    assert_eq!(fx.status().await.paused, None);
}

/// Compaction can leave the op log without this device's last op, or any:
/// the vault is no older for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_vault_whose_op_log_was_compacted_is_not_paused() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;

    fx.compact().await;
    fx.tick().await;

    assert_eq!(fx.status().await.paused, None);
}

/// The pause outlasts the op that told the vault older: compaction removing
/// it does not resume the mirror.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restored_vault_whose_op_log_was_compacted_stays_paused() {
    let (mut fx, folder) = Fx::restored().await;
    let (_, blocks) = fx.page("Gamma", &["three"]).await;
    for text in ["four", "five", "six", "seven"] {
        fx.edit(&blocks[0], text).await;
    }
    fx.tick().await;
    assert!(fx.paused_as_older().await, "{:?}", fx.status().await);

    fx.compact().await;
    for _ in 0..3 {
        fx.tick().await;
    }

    assert_eq!(fx.files(), folder.files);
    assert!(fx.paused_as_older().await, "{:?}", fx.status().await);
}

// ── A restore from a daily snapshot (#6744) ─────────────────────────────

/// What a restore leaves newer in the folder than in the notes: paths below
/// the folder, and the text of each page's file.
struct NewerThanTheNotes {
    /// The file of a page edited since the snapshot.
    edited: String,
    /// The file of a page made since.
    made: String,
    /// The copy of an attachment added since, copying turned on since too.
    copy: String,
}

impl NewerThanTheNotes {
    fn assert_kept(&self, fx: &Fx, when: &str) {
        assert_eq!(fx.read(BETA).as_ref(), Some(&self.made), "{when}");
        assert_eq!(fx.read(ALPHA).as_ref(), Some(&self.edited), "{when}");
        assert!(fx.root.join(&self.copy).exists(), "{when}");
    }
}

impl Fx {
    /// #6744: mirror a vault, snapshot it, change it and its folder, then
    /// restore the snapshot and open the vault as the next launch does, the
    /// mirror's task not yet opened. To the states kept from before, the
    /// file of each page made since is one to remove, each file edited since
    /// one to write the older text over, and each copy one to remove.
    async fn restored_under_newer_files() -> (Self, NewerThanTheNotes) {
        use crate::db::daily_snapshot::take_daily_snapshot;
        use crate::db::snapshot_restore::{request_restore, restore_pending};
        use agaric_engine::loro::peer_epoch::load_peer_epoch;
        use agaric_engine::loro::snapshot::rehydrate_registry;

        let mut fx = Fx::new().await;
        let (alpha_page, alpha) = fx.page("Alpha", &["as the snapshot has it"]).await;
        fx.tick().await;
        let db_path = fx.data.join("test.db");
        let day = chrono::NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        assert!(take_daily_snapshot(&db_path, day).await.unwrap());
        fx.edit(&alpha[0], "edited since").await;
        let (_, beta) = fx.page("Beta", &["made since"]).await;
        let copy = fx.image_in(&beta[0]).await;
        fx.tick().await;
        let newer = NewerThanTheNotes {
            edited: fx.read(ALPHA).unwrap(),
            made: fx.read(BETA).unwrap(),
            copy,
        };
        assert!(newer.edited.contains("edited since"), "{}", newer.edited);
        assert!(fx.root.join(&newer.copy).exists());
        assert!(fx.saved_state(&alpha_page).is_some());
        assert!(fx.state_dir().join("copies").exists());
        assert_eq!(
            saved_heads(&fx.data),
            1,
            "the pass saved the folder's head (#6887)"
        );

        settle(&fx.mat).await;
        fx.pool.close().await;
        request_restore(&db_path, day).unwrap();
        restore_pending(&db_path).await.unwrap();
        fx.pool = init_pool(&db_path).await.unwrap();
        fx.mat = Materializer::new(fx.pool.clone());
        let registry = &fx.mat.loro_state().registry;
        registry.set_peer_epoch(load_peer_epoch(&fx.pool).await.unwrap());
        rehydrate_registry(&fx.pool, registry, DEV).await.unwrap();
        fx.state = MirrorState::new(fx.data.clone());
        (fx, newer)
    }

    /// Open the mirror's task as [`spawn`] does: reading files back, unless
    /// the setting is off.
    async fn open_mirror(&mut self) {
        let ingest = Ingest {
            pool: self.pool.clone(),
            materializer: self.mat.clone(),
            notify: std::sync::Arc::new(|_| {}),
            notify_held: std::sync::Arc::new(|_| {}),
        };
        self.mirror = Mirror::open(self.pool.clone(), DEV.to_owned(), self.state.clone())
            .await
            .unwrap()
            .with_ingest(ingest);
    }

    async fn pages_titled(&self, title: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE block_type = 'page' AND content = ?")
            .bind(title)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// Enough ticks for a file that vanished to count as gone, and for a new
    /// one to be read in.
    async fn ticks(&mut self) {
        for _ in 0..=MISSING_TICKS {
            self.tick().await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_from_a_snapshot_pauses_the_mirror_and_costs_the_folder_no_file_6744() {
    let (mut fx, newer) = Fx::restored_under_newer_files().await;
    fx.open_mirror().await;

    fx.ticks().await;
    newer.assert_kept(&fx, "paused, the mirror removes and writes nothing");
    assert_eq!(fx.status().await.paused.as_deref(), Some(RESTORED_PAUSE));

    // The folder chosen again.
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(path_string(&fx.root)), true)
        .await
        .unwrap();
    fx.ticks().await;
    assert_eq!(
        fx.pages_titled("Beta").await,
        0,
        "the file of a page made since the snapshot is not read in as a new page: \
         a paired device gives that page back"
    );
    newer.assert_kept(&fx, "resumed, it removes and overwrites nothing");
    let status = fx.status().await;
    assert_eq!(status.paused, None);
    assert!(
        !status.read_back,
        "reading back stays off until it is asked for"
    );
    let diverged: Vec<String> = status.diverged.into_iter().map(|f| f.path).collect();
    assert_eq!(diverged, [ALPHA]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_drops_the_mirrors_states_and_its_record_of_copies_6744() {
    let (fx, _) = Fx::restored_under_newer_files().await;
    assert_eq!(
        saved_heads(&fx.data),
        0,
        "the folder's head goes with its states"
    );
    assert!(!fx.data.join("mirror").exists());
}

/// The `head` files saved under each mirrored folder's states in `data`.
fn saved_heads(data: &Path) -> usize {
    std::fs::read_dir(data.join("mirror/folders")).map_or(0, |folders| {
        folders
            .filter(|folder| folder.as_ref().unwrap().path().join("head").exists())
            .count()
    })
}

/// A file holding a block that reads as other text than its render, as one
/// adopted from another editor (#6540): an edit to another block in Agaric
/// keeps its lines, since its render is still the one the file was written
/// from.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_block_that_reads_otherwise_keeps_its_lines_while_its_render_is_unchanged() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;
    let state = fx.mirror.pages.get(&page).unwrap().clone();
    let written = state.newest().unwrap().clone();
    let own = written.text.replace("one", "one ==as written elsewhere==");
    assert_ne!(own, written.text);
    let shadow = Shadow {
        text: own.clone(),
        ..written
    };
    let mut state = state;
    state.shadows = vec![shadow];
    fx.mirror.store.save(&page, &state).unwrap();
    fx.mirror.pages.insert(page.clone(), state);
    std::fs::write(fx.root.join(ALPHA), &own).unwrap();
    fx.mirror
        .seen
        .stats
        .insert(page.clone(), file_stat(&fx.root.join(ALPHA)));

    fx.edit(&blocks[1], "TWO").await;
    fx.tick().await;

    assert_eq!(fx.read(ALPHA), Some(own.replace("two", "TWO")));
}
