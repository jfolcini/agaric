//! The mirror's ingest against a test pool and a temporary folder (#5363
//! slice 2): a file edited outside Agaric is read into its page once it
//! settles, as one undoable save, and written back keeping its own bytes.

use std::sync::Mutex;

use proptest::prelude::*;
use tempfile::TempDir;

use super::super::*;
use super::*;
use crate::commands::history::undo_ops_inner;
use crate::commands::mirror::{get_mirror_status_inner, set_mirror_folder_inner};
use crate::commands::tests::common::{
    DEV, TEST_SPACE_ID, ensure_test_space, mark_block_as_space, settle,
};
use crate::commands::{create_block_inner, create_page_in_space_inner, edit_block_inner};
use crate::db::init_pool;
use agaric_core::ulid::BlockId;

const ALPHA: &str = "TestSpace/Alpha.md";

/// What a test runs when an ingest's event is sent.
type Hook = Arc<Mutex<Option<Box<dyn FnMut() + Send>>>>;

struct Fx {
    pool: SqlitePool,
    mat: Materializer,
    state: MirrorState,
    mirror: Mirror,
    root: PathBuf,
    events: Arc<Mutex<Vec<MirrorIngested>>>,
    /// Each list of held space folders the mirror told, in order.
    told_held: Arc<Mutex<Vec<Vec<String>>>>,
    /// Run when an ingest's event is sent, before the file is written back.
    on_event: Hook,
    _dirs: [TempDir; 3],
}

impl Fx {
    /// A vault with the test space, and the mirror on, ingesting, in an
    /// empty folder.
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
        set_mirror_folder_inner(
            &pool,
            DEV,
            &state,
            Some(root.to_str().unwrap().to_owned()),
            true,
        )
        .await
        .unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&events);
        let on_event: Hook = Arc::default();
        let hook = Arc::clone(&on_event);
        let told_held = Arc::new(Mutex::new(Vec::new()));
        let told = Arc::clone(&told_held);
        let ingest = Ingest {
            pool: pool.clone(),
            materializer: mat.clone(),
            notify: Arc::new(move |event| {
                seen.lock().unwrap().push(event);
                if let Some(hook) = hook.lock().unwrap().as_mut() {
                    hook();
                }
            }),
            notify_held: Arc::new(move |folders| told.lock().unwrap().push(folders)),
        };
        let mirror = Mirror::open(pool.clone(), DEV.to_owned(), state.clone())
            .await
            .unwrap()
            .with_ingest(ingest);
        Self {
            pool,
            mat,
            state,
            mirror,
            root,
            events,
            told_held,
            on_event,
            _dirs: [db, data, folder],
        }
    }

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
            let row = create_block_inner(
                &self.pool,
                DEV,
                &self.mat,
                "content".into(),
                (*content).into(),
                Some(BlockId::from_trusted(&page)),
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
        settle(&self.mat).await;
    }

    /// Two ticks: the first sees the file, the second reads it in.
    async fn settle_file(&mut self) {
        self.tick().await;
        self.tick().await;
    }

    fn read(&self) -> String {
        std::fs::read_to_string(self.root.join(ALPHA)).unwrap()
    }

    fn write(&self, bytes: impl AsRef<[u8]>) {
        std::fs::write(self.root.join(ALPHA), bytes).unwrap();
    }

    /// The page's live blocks, `(id, content)` in document order.
    async fn blocks(&self, page: &str) -> Vec<(String, String)> {
        sqlx::query_as::<_, (String, String)>(
            "SELECT id, COALESCE(content, '') FROM blocks
              WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id",
        )
        .bind(page)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    async fn contents(&self, page: &str) -> Vec<String> {
        self.blocks(page)
            .await
            .into_iter()
            .map(|(_, c)| c)
            .collect()
    }

    async fn status(&self) -> MirrorStatus {
        get_mirror_status_inner(&self.pool, DEV, &self.state)
            .await
            .unwrap()
    }

    fn events(&self) -> Vec<MirrorIngested> {
        self.events.lock().unwrap().clone()
    }

    fn told_held(&self) -> Vec<Vec<String>> {
        self.told_held.lock().unwrap().clone()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_outside_agaric_is_read_into_the_page_and_one_undo_reverts_it() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["hello", "world"]).await;
    fx.tick().await;
    let edited = fx.read().replace("world", "there");
    fx.write(&edited);

    fx.tick().await;
    assert_eq!(
        fx.contents(&page).await,
        ["hello", "world"],
        "read only once it settles"
    );
    assert_eq!(fx.status().await.diverged.len(), 1);

    fx.tick().await;
    assert_eq!(fx.contents(&page).await, ["hello", "there"]);
    assert_eq!(fx.read(), edited, "nothing to write back");
    assert!(fx.status().await.diverged.is_empty());
    let events = fx.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, IngestKind::Edited);
    assert_eq!(events[0].page_id, page);
    assert_eq!(events[0].report.edited, 1);
    assert_eq!(
        fx.blocks(&page).await[1].0,
        blocks[1],
        "the block keeps its id"
    );

    undo_ops_inner(&fx.pool, DEV, &fx.mat, events[0].op_refs.clone())
        .await
        .unwrap();
    settle(&fx.mat).await;
    assert_eq!(fx.contents(&page).await, ["hello", "world"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_next_agaric_edit_rewrites_only_that_blocks_lines() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one", "two", "three"]).await;
    fx.tick().await;
    let own = "* one\n* two\n* three\n";
    fx.write(own);
    fx.settle_file().await;
    assert_eq!(fx.contents(&page).await, ["one", "two", "three"]);
    assert_eq!(fx.read(), own, "a file reading as its page is kept");

    let two = fx.blocks(&page).await[1].0.clone();
    fx.edit(&two, "TWO").await;
    fx.tick().await;

    let lines: Vec<String> = fx.read().split('\n').map(str::to_owned).collect();
    assert_eq!(lines[0], "* one");
    assert!(lines[1].contains("TWO"), "{lines:?}");
    assert_eq!(lines[2], "* three");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_renamed_in_agaric_takes_its_files_own_lines_to_the_new_path() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;
    let own = "* one\n* two\n";
    fx.write(own);
    fx.settle_file().await;
    assert_eq!(fx.read(), own, "a file reading as its page is kept");

    fx.edit(&page, "Gamma").await;
    fx.tick().await;

    assert!(!fx.root.join(ALPHA).exists(), "the old file goes");
    let moved = std::fs::read_to_string(fx.root.join("TestSpace/Gamma.md")).unwrap();
    assert_eq!(moved, own);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_from_a_stale_editor_does_not_undo_what_agaric_wrote_since() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["a", "b", "c"]).await;
    fx.tick().await;
    let opened = fx.read();
    fx.edit(&blocks[0], "A").await;
    fx.tick().await;
    assert!(fx.read().contains('A'));

    fx.write(opened.replace("\nb", "\nB"));
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["A", "B", "c"]);
}

/// A stale save that only deletes lines explains itself against both texts:
/// the older one is still its base, so a block Agaric added since is kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_save_that_only_deletes_lines_keeps_a_block_agaric_added_since() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["a", "b", "c"]).await;
    fx.tick().await;
    let opened = fx.read();
    create_block_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        "content".into(),
        "d".into(),
        Some(BlockId::from_trusted(&page)),
        None,
    )
    .await
    .unwrap();
    fx.tick().await;
    assert!(fx.read().contains("\nd"), "{}", fx.read());

    fx.write(opened.replacen("b\n\n", "", 1));
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["a", "c", "d"]);
}

/// A save that keeps a line only the newest text holds is an edit of that
/// text, however many blank lines an older one shares with it: read against
/// the older text, its lines would pair with that text's blocks, and the kept
/// line would turn up twice.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_keeping_a_line_only_the_newest_text_holds_is_read_against_it() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["a", "b", "c"]).await;
    fx.tick().await;
    for word in ["d", "e"] {
        create_block_inner(
            &fx.pool,
            DEV,
            &fx.mat,
            "content".into(),
            word.into(),
            Some(BlockId::from_trusted(&page)),
            None,
        )
        .await
        .unwrap();
    }
    fx.tick().await;
    assert!(fx.read().contains("\ne"), "{}", fx.read());

    fx.write("x\n\ne\n\ny\n");
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["x", "e", "y"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_line_is_a_new_block_and_saving_the_file_again_adds_no_twin() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    let added = format!("{}\n\n* new\n", fx.read().trim_end());
    fx.write(&added);
    fx.settle_file().await;
    assert_eq!(fx.contents(&page).await, ["one", "new"]);
    assert_eq!(
        fx.read(),
        added,
        "a new block keeps its own line, with no anchor"
    );
    let new = fx.blocks(&page).await[1].0.clone();

    fx.write(added.replace("one", "ONE"));
    fx.settle_file().await;
    assert_eq!(fx.contents(&page).await, ["ONE", "new"]);
    assert_eq!(
        fx.blocks(&page).await[1].0,
        new,
        "the new block keeps its id"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_saved_with_crlf_and_a_bom_reads_as_its_page() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;
    let written = fx.read();
    fx.write(format!("\u{feff}{}", written.replace('\n', "\r\n")));
    fx.settle_file().await;

    assert_eq!(fx.events()[0].op_refs, Vec::new(), "nothing to save");
    assert_eq!(
        fx.blocks(&page).await,
        vec![
            (blocks[0].clone(), "one".to_owned()),
            (blocks[1].clone(), "two".to_owned()),
        ]
    );
    assert_eq!(fx.read(), written, "written back as UTF-8 with LF");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_landing_during_an_ingest_is_not_written_over() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    // CRLF, so the ingest has a write-back to make.
    fx.write(fx.read().replace("one", "uno").replace('\n', "\r\n"));
    let newer = fx.root.join(ALPHA);
    *fx.on_event.lock().unwrap() =
        Some(Box::new(move || std::fs::write(&newer, "newer\n").unwrap()));
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["uno"]);
    assert_eq!(
        fx.read(),
        "newer\n",
        "the newer save is kept, to be read next"
    );
}

/// Save the page's file from outside, `from` replaced by `to`, when the
/// mirror reaches the race this is set as. The save changes the file's
/// length, so no timestamp's resolution hides it.
fn save_outside(from: &'static str, to: &'static str) -> Option<Race> {
    Some(Box::new(move |file| {
        let text = std::fs::read_to_string(file).unwrap();
        std::fs::write(file, text.replace(from, to)).unwrap();
    }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_landing_right_after_a_write_is_read_in() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    fx.edit(&blocks[0], "two").await;
    fx.mirror.races.after_write = save_outside("two", "outside");
    fx.tick().await;
    fx.mirror.races.after_write = None;
    let saved = fx.read();
    assert!(saved.contains("outside"), "{saved}");

    fx.settle_file().await;
    assert_eq!(fx.contents(&page).await, ["outside"]);
    assert_eq!(fx.read(), saved);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_landing_right_after_an_unchanged_file_is_read_is_read_in() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    // A full pass reads every page's file, and writes none here.
    fx.mirror.full_due = true;
    fx.mirror.races.after_read = save_outside("one", "outside");
    fx.tick().await;
    fx.mirror.races.after_read = None;
    let saved = fx.read();
    assert!(saved.contains("outside"), "{saved}");

    fx.settle_file().await;
    assert_eq!(fx.contents(&page).await, ["outside"]);
    assert_eq!(fx.read(), saved);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_write_leaves_its_file_unchanged_to_the_next_tick() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    assert_eq!(fx.mirror.changed_files(&fx.root), Vec::<String>::new());
    fx.edit(&blocks[0], "two").await;
    fx.tick().await;
    assert_eq!(fx.mirror.changed_files(&fx.root), Vec::<String>::new());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_landing_between_the_read_and_the_write_is_kept_and_read_in() {
    let mut fx = Fx::new().await;
    let (page, blocks) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;
    fx.edit(&blocks[0], "uno").await;
    fx.mirror.races.after_read = save_outside("two", "outside");
    fx.tick().await;
    fx.mirror.races.after_read = None;
    let saved = fx.read();
    assert!(
        saved.contains("one") && saved.contains("outside"),
        "{saved}"
    );
    // Dirty by its file alone, and listed until it is read.
    assert_eq!(
        fx.mirror.changed_files(&fx.root),
        std::slice::from_ref(&page)
    );
    assert_eq!(fx.status().await.diverged.len(), 1);
    let left: Vec<_> = std::fs::read_dir(fx.root.join("TestSpace"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, ["Alpha.md"], "the text not written leaves no file");

    fx.settle_file().await;
    assert_eq!(fx.contents(&page).await, ["uno", "outside"]);
    assert_eq!(fx.read(), saved.replace("one", "uno"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_landing_as_an_empty_pages_blank_file_is_written_back_is_kept_and_read_in() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &[]).await;
    fx.tick().await;
    fx.write("\n");
    fx.mirror.races.after_read = save_outside("\n", "typed\n");
    fx.tick().await;
    fx.mirror.races.after_read = None;
    assert_eq!(fx.read(), "typed\n");
    assert_eq!(fx.status().await.diverged.len(), 1);

    fx.settle_file().await;
    assert_eq!(fx.contents(&page).await, ["typed"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_landing_as_an_ingest_writes_back_is_kept_and_read_in() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;
    // CRLF, so the ingest has a write-back to make.
    fx.write(fx.read().replace("one", "uno").replace('\n', "\r\n"));
    fx.tick().await;
    fx.mirror.races.before_write = save_outside("two", "newer");
    fx.tick().await;
    fx.mirror.races.before_write = None;
    let saved = fx.read();
    assert!(saved.contains("newer") && saved.contains('\r'), "{saved:?}");
    assert_eq!(fx.status().await.diverged.len(), 1);

    fx.settle_file().await;
    assert_eq!(fx.contents(&page).await, ["uno", "newer"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_landing_as_a_new_file_is_written_back_is_kept_and_read_in() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    // CRLF, so the read has a write-back to make.
    write_at(&fx, "TestSpace/Delta.md", "one\r\n\r\ntwo\r\n");
    fx.tick().await;
    fx.mirror.races.before_write = save_outside("two", "newer");
    fx.tick().await;
    fx.mirror.races.before_write = None;
    let saved = std::fs::read_to_string(fx.root.join("TestSpace/Delta.md")).unwrap();
    assert_eq!(saved, "one\r\n\r\nnewer\r\n");

    fx.settle_file().await;
    let pages = pages_titled(&fx, "Delta").await;
    assert_eq!(fx.contents(&pages[0]).await, ["one", "newer"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_emptied_or_undecodable_file_is_refused_and_left_alone() {
    for bytes in [&b""[..], b"\n  \n", b"caf\xe9\n"] {
        let mut fx = Fx::new().await;
        let (page, _) = fx.page("Alpha", &["one"]).await;
        fx.tick().await;
        fx.write(bytes);
        fx.settle_file().await;

        assert_eq!(fx.contents(&page).await, ["one"], "{bytes:?}");
        assert_eq!(std::fs::read(fx.root.join(ALPHA)).unwrap(), bytes);
        let failed = fx.status().await.failed;
        assert_eq!(failed.len(), 1, "{bytes:?}");
        assert_eq!(failed[0].page_id, page);
        assert!(fx.events().is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_ingest_one_undo_could_not_revert_is_refused_and_left_alone() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    let huge: String = (0..1200).map(|n| format!("line {n}\n\n")).collect();
    let file = format!("{}\n\n{huge}", fx.read().trim_end());
    fx.write(&file);
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["one"]);
    assert_eq!(fx.read(), file);
    let failed = fx.status().await.failed;
    assert_eq!(failed.len(), 1);
    assert!(failed[0].message.contains("exceeds maximum"), "{failed:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_still_being_written_is_not_read_until_it_settles() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    let written = fx.read();
    fx.write(written.replace("one", "on"));
    fx.tick().await;
    fx.write(written.replace("one", "one more"));
    fx.tick().await;
    assert_eq!(fx.contents(&page).await, ["one"]);

    fx.tick().await;
    assert_eq!(fx.contents(&page).await, ["one more"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_edited_while_its_page_was_not_is_still_read() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    fx.tick().await;
    fx.write(fx.read().replace("one", "uno"));
    fx.settle_file().await;
    assert_eq!(fx.contents(&page).await, ["uno"]);
}

/// The other page's block that refers to `target`, so the mirror anchors it.
async fn refer_to(fx: &Fx, target: &str) {
    fx.page("Beta", &[&format!("see (({target}))")]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_ref_to_a_block_anchors_it_in_the_file_and_keeps_the_other_lines() {
    let mut fx = Fx::new().await;
    let (_, blocks) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;
    fx.write("* one\n* two\n");
    fx.settle_file().await;

    refer_to(&fx, &blocks[1]).await;
    fx.tick().await;
    fx.tick().await;

    let file = fx.read();
    let lines: Vec<&str> = file.split('\n').collect();
    assert_eq!(lines[0], "* one", "{file}");
    assert!(lines[1].ends_with(&format!(" ^{}", blocks[1])), "{file}");
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 12, ..ProptestConfig::default() })]

    /// Any edit outside Agaric to the other lines of a page keeps the id of
    /// the block another page refers to, and the blocks it left untouched
    /// keep theirs.
    #[test]
    fn anchored_and_untouched_blocks_keep_their_ids(
        edits in prop::collection::vec((0usize..6, 0u8..3, "[a-z]{1,6}"), 1..5),
    ) {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let mut fx = Fx::new().await;
                let names = ["b0", "b1", "b2", "b3", "b4", "b5"];
                let (page, ids) = fx.page("Alpha", &names).await;
                refer_to(&fx, &ids[2]).await;
                fx.tick().await;
                let mut lines: Vec<Option<String>> = names.iter().map(|n| Some((*n).to_owned())).collect();
                for (at, kind, word) in &edits {
                    if *at == 2 { continue; }
                    match kind {
                        0 => lines[*at] = Some(format!("{word} edited")),
                        1 => lines[*at] = None,
                        _ => lines.push(Some(format!("new {word}"))),
                    }
                }
                let file = fx.read();
                let anchored = file.split("\n\n").find(|b| b.starts_with("b2")).unwrap().to_owned();
                let text: Vec<String> = lines.iter().enumerate().filter_map(|(i, l)| {
                    l.as_ref().map(|l| if i == 2 { anchored.clone() } else { l.clone() })
                }).collect();
                fx.write(format!("{}\n", text.join("\n\n")));
                fx.settle_file().await;

                let now = fx.blocks(&page).await;
                prop_assert!(now.contains(&(ids[2].clone(), "b2".to_owned())), "{now:?}");
                for (i, line) in lines.iter().enumerate().take(names.len()) {
                    if line.as_deref() == Some(names[i]) {
                        prop_assert!(now.contains(&(ids[i].clone(), names[i].to_owned())), "{i}: {now:?}");
                    }
                }
                Ok(())
            })?;
    }
}

/// The live pages titled `title`.
async fn pages_titled(fx: &Fx, title: &str) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT id FROM blocks
          WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL",
    )
    .bind(title)
    .fetch_all(&fx.pool)
    .await
    .unwrap()
}

fn write_at(fx: &Fx, path: &str, bytes: impl AsRef<[u8]>) {
    let file = fx.root.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, bytes).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_in_a_space_folder_becomes_a_page_one_undo_removes() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    let own = "* first\n\nsecond\n";
    write_at(&fx, "TestSpace/Gamma.md", own);

    fx.tick().await;
    assert!(
        pages_titled(&fx, "Gamma").await.is_empty(),
        "read once it settles"
    );
    fx.tick().await;

    let pages = pages_titled(&fx, "Gamma").await;
    assert_eq!(pages.len(), 1);
    assert_eq!(fx.contents(&pages[0]).await, ["first", "second"]);
    let file = std::fs::read_to_string(fx.root.join("TestSpace/Gamma.md")).unwrap();
    assert_eq!(file, own, "the file keeps its bytes");
    fx.tick().await;
    fx.tick().await;
    assert_eq!(pages_titled(&fx, "Gamma").await, pages, "no twin");

    let event = fx.events().pop().unwrap();
    assert_eq!(event.kind, IngestKind::Created);
    assert_eq!(event.page_id, pages[0]);
    undo_ops_inner(&fx.pool, DEV, &fx.mat, event.op_refs)
        .await
        .unwrap();
    settle(&fx.mat).await;
    assert!(pages_titled(&fx, "Gamma").await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_in_a_subfolder_is_a_namespaced_page_and_its_saves_edit_it() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    write_at(&fx, "TestSpace/Projects/Plan.md", "one\n");
    fx.settle_file().await;
    let pages = pages_titled(&fx, "Projects/Plan").await;
    assert_eq!(pages.len(), 1);

    write_at(&fx, "TestSpace/Projects/Plan.md", "uno\n");
    fx.settle_file().await;
    assert_eq!(pages_titled(&fx, "Projects/Plan").await, pages);
    assert_eq!(fx.contents(&pages[0]).await, ["uno"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_titled_as_a_page_of_the_space_is_refused_and_left_alone() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    write_at(&fx, "TestSpace/alpha.md", "other\n");
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["one"]);
    assert_eq!(pages_titled(&fx, "alpha").await, Vec::<String>::new());
    let file = std::fs::read_to_string(fx.root.join("TestSpace/alpha.md")).unwrap();
    assert_eq!(file, "other\n");
    let failed = fx.status().await.failed;
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0].path, "TestSpace/alpha.md");
    assert!(fx.events().is_empty());

    std::fs::remove_file(fx.root.join("TestSpace/alpha.md")).unwrap();
    fx.tick().await;
    assert!(
        fx.status().await.failed.is_empty(),
        "a file gone is no failure"
    );
}

/// #6755 — a page under `Tag/` is made through its tag, a file included.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_under_the_tag_path_is_refused_and_left_alone() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    write_at(&fx, "TestSpace/Tag/book.md", "one\n");
    fx.settle_file().await;

    assert_eq!(pages_titled(&fx, "Tag/book").await, Vec::<String>::new());
    let failed = fx.status().await.failed;
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0].path, "TestSpace/Tag/book.md");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_outside_every_space_folder_or_hidden_is_left_alone() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    write_at(&fx, "loose.md", "loose\n");
    write_at(&fx, "Elsewhere/Note.md", "note\n");
    write_at(&fx, "TestSpace/.Hidden.md", "hidden\n");
    write_at(&fx, "TestSpace/notes.txt", "text\n");
    fx.settle_file().await;

    for title in [
        "loose",
        "Note",
        "Elsewhere/Note",
        ".Hidden",
        "Hidden",
        "notes",
    ] {
        assert!(pages_titled(&fx, title).await.is_empty(), "{title}");
    }
    assert!(fx.events().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_one_undo_could_not_revert_leaves_no_page() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    let huge: String = (0..1200).map(|n| format!("line {n}\n\n")).collect();
    write_at(&fx, "TestSpace/Huge.md", &huge);
    fx.settle_file().await;

    assert!(pages_titled(&fx, "Huge").await.is_empty());
    let failed = fx.status().await.failed;
    assert_eq!(failed.len(), 1);
    assert!(failed[0].message.contains("exceeds maximum"), "{failed:?}");
    let file = std::fs::read_to_string(fx.root.join("TestSpace/Huge.md")).unwrap();
    assert_eq!(file, huge);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_landing_while_a_new_file_is_read_is_not_written_over() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    // CRLF, so the read has a write-back to make.
    write_at(&fx, "TestSpace/Delta.md", "one\r\n");
    let newer = fx.root.join("TestSpace/Delta.md");
    *fx.on_event.lock().unwrap() =
        Some(Box::new(move || std::fs::write(&newer, "newer\n").unwrap()));
    fx.settle_file().await;

    let pages = pages_titled(&fx, "Delta").await;
    assert_eq!(pages.len(), 1);
    assert_eq!(fx.contents(&pages[0]).await, ["one"]);
    let file = std::fs::read_to_string(fx.root.join("TestSpace/Delta.md")).unwrap();
    assert_eq!(file, "newer\n", "the newer save is kept, to be read next");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn choosing_another_folder_forgets_the_old_folders_new_file_failures() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    write_at(&fx, "TestSpace/alpha.md", "other\n");
    fx.settle_file().await;
    assert_eq!(fx.status().await.failed.len(), 1);

    let other = TempDir::new().unwrap();
    set_mirror_folder_inner(
        &fx.pool,
        DEV,
        &fx.state,
        Some(other.path().to_str().unwrap().to_owned()),
        true,
    )
    .await
    .unwrap();

    assert!(
        fx.status().await.failed.is_empty(),
        "{:?}",
        fx.status().await.failed
    );
}

/// Rename the file at `from` to `to` below the mirror's folder, as a file
/// manager does.
fn rename_at(fx: &Fx, from: &str, to: &str) {
    let to = fx.root.join(to);
    std::fs::create_dir_all(to.parent().unwrap()).unwrap();
    std::fs::rename(fx.root.join(from), to).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_renamed_outside_agaric_renames_its_page() {
    let mut fx = Fx::new().await;
    let (page, ids) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;

    rename_at(&fx, ALPHA, "TestSpace/Gamma.md");
    fx.settle_file().await;
    fx.tick().await;

    assert_eq!(
        pages_titled(&fx, "Gamma").await,
        std::slice::from_ref(&page),
        "no second page"
    );
    assert!(pages_titled(&fx, "Alpha").await.is_empty());
    let kept: Vec<String> = fx
        .blocks(&page)
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    assert_eq!(kept, ids, "every block keeps its id");
    assert!(
        !fx.root.join(ALPHA).exists(),
        "the old file is not written again"
    );
    assert!(fx.status().await.failed.is_empty());
}

/// The pages `source`'s blocks link to.
async fn linked_from(fx: &Fx, source: &str) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT l.target_id FROM block_links l JOIN blocks s ON s.id = l.source_id
          WHERE s.page_id = ? AND s.deleted_at IS NULL",
    )
    .bind(source)
    .fetch_all(&fx.pool)
    .await
    .unwrap()
}

/// Obsidian rewrites the files linking to a file as it renames it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_and_the_links_rewritten_with_it_keep_one_page_and_its_backlinks() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    let (beta, _) = fx.page("Beta", &[&format!("see [[{alpha}]]")]).await;
    fx.tick().await;
    let linking = std::fs::read_to_string(fx.root.join("TestSpace/Beta.md")).unwrap();
    assert!(linking.contains("[[Alpha]]"), "{linking}");

    rename_at(&fx, ALPHA, "TestSpace/Gamma.md");
    write_at(
        &fx,
        "TestSpace/Beta.md",
        linking.replace("[[Alpha]]", "[[Gamma]]"),
    );
    fx.settle_file().await;
    fx.tick().await;

    assert_eq!(
        pages_titled(&fx, "Gamma").await,
        std::slice::from_ref(&alpha),
        "one page"
    );
    assert_eq!(linked_from(&fx, &beta).await, [alpha]);
}

/// Obsidian makes a note from a link to a page nobody wrote yet.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_and_a_link_to_it_written_together_make_one_page() {
    let mut fx = Fx::new().await;
    let (beta, _) = fx.page("Beta", &["see"]).await;
    fx.tick().await;
    let linking = std::fs::read_to_string(fx.root.join("TestSpace/Beta.md")).unwrap();

    write_at(&fx, "TestSpace/Gamma.md", "written\n");
    write_at(
        &fx,
        "TestSpace/Beta.md",
        linking.replace("see", "see [[Gamma]]"),
    );
    fx.settle_file().await;
    fx.tick().await;

    let gamma = pages_titled(&fx, "Gamma").await;
    assert_eq!(gamma.len(), 1, "one page");
    assert_eq!(fx.contents(&gamma[0]).await, ["written"], "the file's");
    assert_eq!(linked_from(&fx, &beta).await, gamma);
    assert!(
        fx.status().await.failed.is_empty(),
        "{:?}",
        fx.status().await.failed
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_that_cannot_be_read_stops_no_write() {
    let mut fx = Fx::new().await;
    let (_, ids) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    let unreadable = fx.root.join("TestSpace/Loop.md");
    std::os::unix::fs::symlink(&unreadable, &unreadable).unwrap();

    fx.edit(&ids[0], "uno").await;
    fx.tick().await;

    assert!(fx.read().contains("uno"), "{}", fx.read());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_that_cannot_be_read_is_listed_and_stops_no_other_new_file() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    // Below the unreadable file's folder, so the scan lists it after that file.
    write_at(&fx, "TestSpace/Sub/Gamma.md", "gamma\n");
    let unreadable = fx.root.join("TestSpace/Loop.md");
    std::os::unix::fs::symlink(&unreadable, &unreadable).unwrap();

    fx.settle_file().await;

    assert_eq!(pages_titled(&fx, "Sub/Gamma").await.len(), 1);
    let failed = failed_files(&fx).await;
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0].0, "TestSpace/Loop.md");
    assert!(failed[0].1.contains("cannot be read"), "{failed:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_renamed_and_edited_is_matched_by_its_anchors() {
    let mut fx = Fx::new().await;
    let (page, ids) = fx.page("Alpha", &["one", "two"]).await;
    refer_to(&fx, &ids[0]).await;
    fx.tick().await;
    fx.tick().await;
    let written = fx.read();
    assert!(written.contains(&format!("^{}", ids[0])), "{written}");

    rename_at(&fx, ALPHA, "TestSpace/Gamma.md");
    write_at(&fx, "TestSpace/Gamma.md", written.replace("two", "dos"));
    for _ in 0..4 {
        fx.tick().await;
    }

    assert_eq!(
        pages_titled(&fx, "Gamma").await,
        std::slice::from_ref(&page),
        "no second page"
    );
    assert_eq!(
        fx.blocks(&page).await,
        [
            (ids[0].clone(), "one".to_owned()),
            (ids[1].clone(), "dos".to_owned())
        ],
        "the edit is read into the renamed page"
    );
    assert!(!fx.root.join(ALPHA).exists());
}

/// A second space, `TestSpaceB`, mirrored to its folder of that name.
async fn space_b(fx: &Fx) {
    use crate::commands::tests::common::{TEST_SPACE_B_ID, ensure_test_space_b};
    ensure_test_space_b(&fx.pool).await;
    mark_block_as_space(&fx.pool, TEST_SPACE_B_ID).await;
}

async fn space_of(fx: &Fx, page: &str) -> String {
    sqlx::query_scalar::<_, String>("SELECT space_id FROM blocks WHERE id = ?")
        .bind(page)
        .fetch_one(&fx.pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_moved_into_another_space_folder_moves_its_page_one_undo_moves_it_back() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    space_b(&fx).await;
    let (page, ids) = fx.page("Alpha", &["one"]).await;
    refer_to(&fx, &ids[0]).await;
    fx.tick().await;
    fx.tick().await;

    rename_at(&fx, ALPHA, "TestSpaceB/Alpha.md");
    fx.settle_file().await;
    fx.tick().await;

    assert_eq!(space_of(&fx, &page).await, TEST_SPACE_B_ID);
    assert_eq!(
        pages_titled(&fx, "Alpha").await,
        std::slice::from_ref(&page),
        "no second page"
    );
    assert!(
        !fx.root.join(ALPHA).exists(),
        "the old file is not written again"
    );
    assert!(
        fx.status().await.failed.is_empty(),
        "{:?}",
        fx.status().await.failed
    );

    let event = fx.events().pop().unwrap();
    assert_eq!(event.kind, IngestKind::Renamed);
    assert_eq!(event.page_id, page);
    undo_ops_inner(&fx.pool, DEV, &fx.mat, event.op_refs)
        .await
        .unwrap();
    settle(&fx.mat).await;
    assert_eq!(space_of(&fx, &page).await, TEST_SPACE_ID);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_into_a_space_holding_the_title_is_refused_and_the_file_left_alone() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    space_b(&fx).await;
    let (page, ids) = fx.page("Alpha", &["one"]).await;
    refer_to(&fx, &ids[0]).await;
    create_page_in_space_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        None,
        "ALPHA".into(),
        TEST_SPACE_B_ID.into(),
    )
    .await
    .unwrap();
    fx.tick().await;
    fx.tick().await;
    let moved = std::fs::read(fx.root.join(ALPHA)).unwrap();

    rename_at(&fx, ALPHA, "TestSpaceB/Alpha.md");
    fx.settle_file().await;

    assert_eq!(space_of(&fx, &page).await, TEST_SPACE_ID);
    let failed = fx.status().await.failed;
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0].path, "TestSpaceB/Alpha.md");
    assert_eq!(
        std::fs::read(fx.root.join("TestSpaceB/Alpha.md")).unwrap(),
        moved
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_move_whose_new_title_the_space_holds_leaves_the_page_where_it_was() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    space_b(&fx).await;
    let (page, ids) = fx.page("Alpha", &["one"]).await;
    refer_to(&fx, &ids[0]).await;
    create_page_in_space_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        None,
        "GAMMA".into(),
        TEST_SPACE_B_ID.into(),
    )
    .await
    .unwrap();
    fx.tick().await;
    fx.tick().await;

    rename_at(&fx, ALPHA, "TestSpaceB/Gamma.md");
    fx.settle_file().await;

    assert_eq!(space_of(&fx, &page).await, TEST_SPACE_ID, "moved back");
    assert_eq!(pages_titled(&fx, "Alpha").await, [page]);
    let failed = fx.status().await.failed;
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0].path, "TestSpaceB/Gamma.md");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_reading_back_off_a_vanished_file_stays_gone_and_is_listed_as_pending() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    read_back(&fx, false, false).await.unwrap();

    std::fs::remove_file(fx.root.join(ALPHA)).unwrap();
    for _ in 0..5 {
        fx.tick().await;
    }

    assert!(!fx.root.join(ALPHA).exists(), "not written again");
    assert!(!is_trashed(&fx, &page).await, "nor read in");
    assert_eq!(paths(&fx.status().await.pending), [ALPHA]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_that_two_vanished_pages_last_wrote_is_a_new_page() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["same"]).await;
    let (beta, _) = fx.page("Beta", &["same"]).await;
    fx.tick().await;
    let written = fx.read();
    assert_eq!(
        std::fs::read_to_string(fx.root.join("TestSpace/Beta.md")).unwrap(),
        written
    );

    std::fs::remove_file(fx.root.join(ALPHA)).unwrap();
    rename_at(&fx, "TestSpace/Beta.md", "TestSpace/Gamma.md");
    fx.settle_file().await;

    let gamma = pages_titled(&fx, "Gamma").await;
    assert_eq!(gamma.len(), 1);
    assert!(
        gamma[0] != alpha && gamma[0] != beta,
        "neither page is taken for it"
    );
    assert_eq!(pages_titled(&fx, "Alpha").await, [alpha]);
    assert_eq!(pages_titled(&fx, "Beta").await, [beta]);
}

// ── Reading back off (#5363 setting 1) ──────────────────────────────────

use crate::commands::mirror::set_mirror_read_back_inner;

async fn op_count(fx: &Fx) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM op_log")
        .fetch_one(&fx.pool)
        .await
        .unwrap()
}

/// The pending files' paths, as the dialog confirms them.
fn paths(pending: &[read_back::MirrorPending]) -> Vec<String> {
    pending.iter().map(|file| file.path.clone()).collect()
}

/// Turn reading back on or off; `read_pending` confirms what the status
/// lists as pending now, as the dialog does.
async fn read_back(fx: &Fx, on: bool, read_pending: bool) -> Result<MirrorStatus, AppError> {
    let shown = if read_pending {
        paths(&fx.status().await.pending)
    } else {
        Vec::new()
    };
    set_mirror_read_back_inner(&fx.pool, DEV, &fx.state, on, &shown).await
}

/// Alpha and Beta mirrored, reading back turned off, then the folder changed
/// the four ways an outside tool changes it: Alpha edited, Beta renamed to
/// Gamma, and a new Delta. Returns Alpha's page, what was written to it, and
/// the op count when reading back was turned off.
async fn changed_while_off(fx: &mut Fx) -> (String, String, i64) {
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.page("Beta", &["two"]).await;
    fx.tick().await;
    read_back(fx, false, false).await.unwrap();
    let ops = op_count(fx).await;
    let edited = fx.read().replace("one", "uno");
    fx.write(&edited);
    rename_at(fx, "TestSpace/Beta.md", "TestSpace/Gamma.md");
    write_at(fx, "TestSpace/Delta.md", "new\n");
    for _ in 0..4 {
        fx.tick().await;
    }
    (alpha, edited, ops)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_reading_back_off_no_outside_change_reaches_agaric() {
    let mut fx = Fx::new().await;
    let (alpha, edited, ops) = changed_while_off(&mut fx).await;

    assert_eq!(op_count(&fx).await, ops);
    assert_eq!(fx.contents(&alpha).await, ["one"]);
    assert_eq!(fx.read(), edited, "the edited file is not written over");
    assert!(pages_titled(&fx, "Gamma").await.is_empty());
    assert!(pages_titled(&fx, "Delta").await.is_empty());
    assert_eq!(pages_titled(&fx, "Beta").await.len(), 1);
    assert!(
        !fx.root.join("TestSpace/Beta.md").exists(),
        "a vanished file is not written again"
    );
    let status = fx.status().await;
    assert!(!status.read_back);
    assert_eq!(status.diverged.len(), 1, "{:?}", status.diverged);
    let kinds: Vec<(&str, read_back::MirrorPendingKind)> = status
        .pending
        .iter()
        .map(|file| (file.path.as_str(), file.kind))
        .collect();
    assert_eq!(
        kinds,
        [
            ("TestSpace/Alpha.md", read_back::MirrorPendingKind::Edited),
            ("TestSpace/Beta.md", read_back::MirrorPendingKind::Gone),
            ("TestSpace/Delta.md", read_back::MirrorPendingKind::New),
            ("TestSpace/Gamma.md", read_back::MirrorPendingKind::New),
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_back_turned_on_reads_nothing_until_the_user_chooses_to() {
    let mut fx = Fx::new().await;
    let (alpha, _, ops) = changed_while_off(&mut fx).await;

    let refused = read_back(&fx, true, false).await;
    assert!(
        matches!(&refused, Err(e) if e.to_string().contains("4 files")),
        "{refused:?}"
    );
    for _ in 0..3 {
        fx.tick().await;
    }
    assert_eq!(op_count(&fx).await, ops, "nothing read in");
    assert!(!fx.status().await.read_back);

    let status = read_back(&fx, true, true).await.unwrap();
    assert!(status.read_back);
    assert!(status.pending.is_empty());
    for _ in 0..3 {
        fx.tick().await;
    }
    assert_eq!(fx.contents(&alpha).await, ["uno"], "now read in");
    assert_eq!(pages_titled(&fx, "Delta").await.len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_back_turns_on_without_a_choice_when_nothing_changed() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    read_back(&fx, false, false).await.unwrap();
    fx.tick().await;

    let status = read_back(&fx, true, false).await.unwrap();
    assert!(status.read_back);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_back_is_not_turned_on_while_the_folder_cannot_be_read() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    read_back(&fx, false, false).await.unwrap();
    std::fs::remove_file(fx.root.join(store::MARKER_NAME)).unwrap();

    let refused = read_back(&fx, true, false).await;
    assert!(
        matches!(&refused, Err(e) if e.to_string().contains("marker")),
        "{refused:?}"
    );
    assert!(!fx.status().await.read_back);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_chosen_with_reading_back_off_reads_nothing_from_the_first_tick() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    let folder = fx.root.to_str().unwrap().to_owned();
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, None, true)
        .await
        .unwrap();
    fx.write(fx.read().replace("one", "uno"));
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(folder), false)
        .await
        .unwrap();

    for _ in 0..3 {
        fx.tick().await;
    }
    assert_eq!(fx.contents(&page).await, ["one"]);
    assert_eq!(paths(&fx.status().await.pending), [ALPHA]);
}

/// The folder chosen again after Turn off, with reading back asked for:
/// what changed there meanwhile is listed for the user to choose, not read
/// in, so an edit is not taken and a deleted file trashes no page.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_changed_while_off_and_chosen_again_turns_reading_back_off() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    let (beta, _) = fx.page("Beta", &["two"]).await;
    fx.tick().await;
    let folder = fx.root.to_str().unwrap().to_owned();
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, None, true)
        .await
        .unwrap();
    fx.write(fx.read().replace("one", "uno"));
    std::fs::remove_file(fx.root.join("TestSpace/Beta.md")).unwrap();

    let status = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(folder), true)
        .await
        .unwrap();
    assert!(!status.read_back);
    assert_eq!(paths(&status.pending), [ALPHA, "TestSpace/Beta.md"]);

    for _ in 0..5 {
        fx.tick().await;
    }
    assert_eq!(fx.contents(&alpha).await, ["one"]);
    assert!(!is_trashed(&fx, &beta).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_unchanged_while_off_and_chosen_again_keeps_reading_back_on() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    let folder = fx.root.to_str().unwrap().to_owned();
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, None, true)
        .await
        .unwrap();

    let status = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(folder), true)
        .await
        .unwrap();
    assert!(status.read_back);
}

/// Another folder chosen while the mirror is on, then the first one again:
/// what changed there meanwhile is listed, not read in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_changed_while_another_was_mirrored_turns_reading_back_off() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    let home = fx.root.to_str().unwrap().to_owned();
    let other = TempDir::new().unwrap();
    let away = other.path().to_str().unwrap().to_owned();
    let status = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(away), true)
        .await
        .unwrap();
    assert!(status.read_back, "an empty folder holds no change");
    fx.tick().await;
    fx.write(fx.read().replace("one", "uno"));

    let status = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(home), true)
        .await
        .unwrap();
    assert!(!status.read_back);
    assert_eq!(paths(&status.pending), [ALPHA]);

    for _ in 0..5 {
        fx.tick().await;
    }
    assert_eq!(fx.contents(&alpha).await, ["one"]);
}

/// Reading back turned off stays off in another folder, whatever the choice
/// made when the mirror was turned on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_folder_chosen_while_mirroring_keeps_reading_back_off() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    read_back(&fx, false, false).await.unwrap();
    let other = TempDir::new().unwrap();
    let away = other.path().to_str().unwrap().to_owned();

    let status = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(away), true)
        .await
        .unwrap();

    assert!(!status.read_back);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 8, ..ProptestConfig::default() })]

    /// Whatever an outside tool does to the folder while reading back is
    /// off, and whether or not reading back is then asked to turn on
    /// without the user's choice, no op is appended and no file the tool
    /// wrote is written over.
    #[test]
    fn with_reading_back_off_outside_changes_append_no_op_and_are_never_written_over(
        changes in prop::collection::vec((0usize..3, 0u8..5, "[a-z]{1,6}"), 1..6),
        ask_to_turn_on in any::<bool>(),
    ) {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let mut fx = Fx::new().await;
                space_b(&fx).await;
                for title in ["P0", "P1", "P2"] {
                    fx.page(title, &["line"]).await;
                }
                fx.tick().await;
                read_back(&fx, false, false).await.unwrap();
                let ops = op_count(&fx).await;
                let mut written: HashMap<String, String> = HashMap::new();
                let mut deleted: Vec<String> = Vec::new();
                for (page, kind, word) in &changes {
                    let path = format!("TestSpace/P{page}.md");
                    match kind {
                        0 => {
                            let text = format!("{word}\n");
                            write_at(&fx, &path, &text);
                            written.insert(path, text);
                        }
                        1 => {
                            let new = format!("TestSpace/{word}.md");
                            if fx.root.join(&path).exists() && !fx.root.join(&new).exists() {
                                rename_at(&fx, &path, &new);
                                written.insert(new.clone(), std::fs::read_to_string(fx.root.join(&new)).unwrap());
                                written.remove(&path);
                            }
                        }
                        2 => {
                            let text = format!("{word} new\n");
                            write_at(&fx, &format!("TestSpace/new-{word}.md"), &text);
                            written.insert(format!("TestSpace/new-{word}.md"), text);
                        }
                        3 => {
                            // Moved into another space's folder.
                            let new = format!("TestSpaceB/P{page}.md");
                            if fx.root.join(&path).exists() && !fx.root.join(&new).exists() {
                                rename_at(&fx, &path, &new);
                                written.insert(new.clone(), std::fs::read_to_string(fx.root.join(&new)).unwrap());
                                written.remove(&path);
                            }
                        }
                        _ => {
                            if fx.root.join(&path).exists() {
                                std::fs::remove_file(fx.root.join(&path)).unwrap();
                                written.remove(&path);
                                deleted.push(path);
                            }
                        }
                    }
                    fx.tick().await;
                }
                if ask_to_turn_on {
                    prop_assert!(read_back(&fx, true, false).await.is_err());
                }
                for _ in 0..3 {
                    fx.tick().await;
                }
                prop_assert_eq!(op_count(&fx).await, ops);
                for (path, text) in &written {
                    let now = std::fs::read_to_string(fx.root.join(path)).ok();
                    prop_assert_eq!(now.as_deref(), Some(text.as_str()), "{}", path);
                }
                for path in &deleted {
                    if !written.contains_key(path) {
                        prop_assert!(!fx.root.join(path).exists(), "{} is not written again", path);
                    }
                }
                Ok(())
            })?;
    }
}

/// #6506: an editor saves an empty page's empty file with a final newline or
/// a BOM. A page with no blocks has nothing such a file could delete.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_pages_file_saved_with_only_a_newline_or_bom_keeps_mirroring() {
    for saved in ["\n", "\u{feff}", "\u{feff}\r\n"] {
        let mut fx = Fx::new().await;
        let (page, _) = fx.page("Alpha", &[]).await;
        fx.tick().await;
        assert_eq!(fx.read(), "", "an empty page writes an empty file");

        fx.write(saved);
        fx.settle_file().await;
        let status = fx.status().await;
        assert!(status.failed.is_empty(), "{saved:?}: {:?}", status.failed);
        assert!(
            status.diverged.is_empty(),
            "{saved:?}: {:?}",
            status.diverged
        );

        let row = create_block_inner(
            &fx.pool,
            DEV,
            &fx.mat,
            "content".into(),
            "later".into(),
            Some(BlockId::from_trusted(&page)),
            None,
        )
        .await
        .unwrap();
        fx.tick().await;
        assert!(fx.read().contains("later"), "{saved:?}: {}", fx.read());
        assert_eq!(
            fx.blocks(&page).await,
            [(row.id.into_string(), "later".to_owned())]
        );
    }
}

/// A refused rename leaves the renamed file where it is and the page's old
/// file gone, so one page has one file; renamed again, it is read as a rename.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_rename_writes_no_second_file_and_a_retry_renames_the_page() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    space_b(&fx).await;
    let (page, ids) = fx.page("Alpha", &["one"]).await;
    refer_to(&fx, &ids[0]).await;
    create_page_in_space_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        None,
        "ALPHA".into(),
        TEST_SPACE_B_ID.into(),
    )
    .await
    .unwrap();
    fx.tick().await;
    fx.tick().await;

    rename_at(&fx, ALPHA, "TestSpaceB/Alpha.md");
    for _ in 0..5 {
        fx.tick().await;
    }
    assert!(!fx.root.join(ALPHA).exists(), "no second file for the page");
    assert_eq!(fx.status().await.failed.len(), 1);

    rename_at(&fx, "TestSpaceB/Alpha.md", "TestSpace/Gamma.md");
    fx.settle_file().await;
    fx.tick().await;
    assert_eq!(pages_titled(&fx, "Gamma").await, [page]);
    assert!(
        fx.status().await.failed.is_empty(),
        "{:?}",
        fx.status().await.failed
    );
}

/// Choosing a folder while the mirror is on keeps reading back as it is: the
/// choice made when turning the mirror on would otherwise turn it on with
/// no question asked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn choosing_a_folder_while_mirroring_keeps_reading_back_off() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    read_back(&fx, false, false).await.unwrap();
    fx.write(fx.read().replace("one", "uno"));
    let folder = fx.root.to_str().unwrap().to_owned();

    let status = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(folder), true)
        .await
        .unwrap();
    for _ in 0..3 {
        fx.tick().await;
    }

    assert!(!status.read_back);
    assert_eq!(fx.contents(&page).await, ["one"], "nothing read in");
}

// ── External deletes (#5363 slice 3, PR 2) ──────────────────────────────

async fn is_trashed(fx: &Fx, page: &str) -> bool {
    sqlx::query_scalar::<_, Option<i64>>("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(page)
        .fetch_one(&fx.pool)
        .await
        .unwrap()
        .is_some()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_deleted_outside_agaric_trashes_its_page_and_one_undo_restores_it() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    let (beta, _) = fx.page("Beta", &["two"]).await;
    fx.tick().await;

    std::fs::remove_file(fx.root.join(ALPHA)).unwrap();
    fx.tick().await;
    fx.tick().await;
    assert!(
        !is_trashed(&fx, &alpha).await,
        "held while it may yet turn up renamed"
    );
    fx.tick().await;
    fx.tick().await;

    assert!(is_trashed(&fx, &alpha).await, "to the Trash");
    assert!(!is_trashed(&fx, &beta).await);
    assert!(!fx.root.join(ALPHA).exists(), "not written again");
    let event = fx.events().pop().unwrap();
    assert_eq!(event.kind, IngestKind::Trashed);
    assert_eq!(event.page_id, alpha);
    undo_ops_inner(&fx.pool, DEV, &fx.mat, event.op_refs)
        .await
        .unwrap();
    settle(&fx.mat).await;
    assert!(!is_trashed(&fx, &alpha).await, "one undo restores it");
    fx.tick().await;
    assert!(
        fx.root.join(ALPHA).exists(),
        "and its file is written again"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_emptied_folder_trashes_nothing_and_pauses_the_mirror() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;

    std::fs::remove_dir_all(fx.root.join("TestSpace")).unwrap();
    for _ in 0..5 {
        fx.tick().await;
    }

    assert!(!is_trashed(&fx, &alpha).await);
    let status = fx.status().await;
    assert!(
        status
            .paused
            .as_ref()
            .is_some_and(|why| why.contains("empty")),
        "{status:?}"
    );
    assert!(
        !fx.root.join("TestSpace").exists(),
        "nothing written into it either"
    );
}

/// The way out of the pause: the emptied folder chosen again is filled,
/// every page written as new, and nothing trashed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_emptied_folder_chosen_again_is_filled_and_trashes_nothing() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    std::fs::remove_dir_all(fx.root.join("TestSpace")).unwrap();
    fx.tick().await;
    assert!(fx.status().await.paused.is_some(), "paused on it");

    let folder = fx.root.to_str().unwrap().to_owned();
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(folder), true)
        .await
        .unwrap();
    for _ in 0..4 {
        fx.tick().await;
    }

    assert_eq!(fx.status().await.paused, None);
    assert!(fx.root.join(ALPHA).exists(), "written there again");
    assert!(!is_trashed(&fx, &alpha).await);
}

/// Chosen again while it holds its files, the folder keeps its states: a
/// file changed outside is still read back, not overwritten as new.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_holding_its_files_chosen_again_keeps_its_states() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    fx.write(fx.read().replace("one", "uno"));

    let folder = fx.root.to_str().unwrap().to_owned();
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(folder), true)
        .await
        .unwrap();
    for _ in 0..4 {
        fx.tick().await;
    }

    assert_eq!(fx.contents(&page).await, ["uno"], "read in as an edit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_space_folder_removed_trashes_none_of_its_pages() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    space_b(&fx).await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    create_page_in_space_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        None,
        "Other".into(),
        TEST_SPACE_B_ID.into(),
    )
    .await
    .unwrap();
    fx.tick().await;

    std::fs::remove_dir_all(fx.root.join("TestSpace")).unwrap();
    for _ in 0..5 {
        fx.tick().await;
    }

    assert!(!is_trashed(&fx, &alpha).await);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_with_no_states_of_its_own_starts_as_new_trashing_nothing() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;

    let other = TempDir::new().unwrap();
    set_mirror_folder_inner(
        &fx.pool,
        DEV,
        &fx.state,
        Some(other.path().to_str().unwrap().to_owned()),
        true,
    )
    .await
    .unwrap();
    for _ in 0..5 {
        fx.tick().await;
    }

    assert!(!is_trashed(&fx, &alpha).await);
    assert!(
        other.path().join(ALPHA).exists(),
        "the new folder holds the page"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_mirror_moved_away_and_back_finds_its_files_as_it_left_them() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    // The file in the user's own form, read in, so its bytes are not the render.
    fx.write("* one\n");
    fx.settle_file().await;
    let home = fx.root.to_str().unwrap().to_owned();

    let other = TempDir::new().unwrap();
    let away = other.path().to_str().unwrap().to_owned();
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(away), true)
        .await
        .unwrap();
    for _ in 0..4 {
        fx.tick().await;
    }
    set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(home), true)
        .await
        .unwrap();
    for _ in 0..4 {
        fx.tick().await;
    }

    assert!(!is_trashed(&fx, &alpha).await);
    assert_eq!(pages_titled(&fx, "Alpha").await, [alpha], "no twin");
    assert_eq!(fx.read(), "* one\n", "the file keeps its form");
    let status = fx.status().await;
    assert!(status.diverged.is_empty(), "{:?}", status.diverged);
    assert!(status.failed.is_empty(), "{:?}", status.failed);
}

/// Turn reading back on, confirming the files `shown` were listed to the user.
async fn confirm(fx: &Fx, shown: Vec<String>) -> Result<MirrorStatus, AppError> {
    set_mirror_read_back_inner(&fx.pool, DEV, &fx.state, true, &shown).await
}

/// The dialog's list goes stale when a file changes after it was read: the
/// confirm reads in only what the user saw.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_changed_after_the_list_was_shown_is_not_read_in_by_its_confirm() {
    let mut fx = Fx::new().await;
    let (alpha, _, ops) = changed_while_off(&mut fx).await;
    let shown = paths(&fx.status().await.pending);
    write_at(&fx, "TestSpace/Epsilon.md", "unseen\n");

    let refused = confirm(&fx, shown).await;
    assert!(
        matches!(&refused, Err(e) if e.to_string().contains("changed")),
        "{refused:?}"
    );
    for _ in 0..3 {
        fx.tick().await;
    }
    assert_eq!(op_count(&fx).await, ops, "nothing read in");
    assert_eq!(fx.contents(&alpha).await, ["one"]);

    let shown = paths(&fx.status().await.pending);
    assert!(
        shown.contains(&"TestSpace/Epsilon.md".to_owned()),
        "{shown:?}"
    );
    confirm(&fx, shown).await.unwrap();
    for _ in 0..3 {
        fx.tick().await;
    }
    assert_eq!(
        pages_titled(&fx, "Epsilon").await.len(),
        1,
        "read in once shown"
    );
}

/// A file renamed while reading back is off is read in as that rename once
/// the user chooses to, not as a second page beside the first.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_made_while_reading_back_was_off_is_read_in_as_a_rename() {
    let mut fx = Fx::new().await;
    changed_while_off(&mut fx).await;
    let beta = pages_titled(&fx, "Beta").await;
    assert_eq!(beta.len(), 1);
    assert!(
        !fx.root.join("TestSpace/Beta.md").exists(),
        "the renamed file's old place stays empty while reading back is off"
    );

    read_back(&fx, true, true).await.unwrap();
    for _ in 0..4 {
        fx.tick().await;
    }

    assert_eq!(
        pages_titled(&fx, "Gamma").await,
        beta,
        "the same page, renamed"
    );
    assert!(pages_titled(&fx, "Beta").await.is_empty());
    assert!(!fx.root.join("TestSpace/Beta.md").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_trashed_for_its_deleted_file_and_restored_from_the_trash_is_written_again() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.page("Beta", &["two"]).await;
    fx.tick().await;
    std::fs::remove_file(fx.root.join(ALPHA)).unwrap();
    // Restored at once, before another tick, as from the Trash list.
    for _ in 0..6 {
        fx.tick().await;
        if is_trashed(&fx, &alpha).await {
            break;
        }
    }
    assert!(is_trashed(&fx, &alpha).await);

    let deleted_at = sqlx::query_scalar::<_, i64>("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(&alpha)
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    crate::commands::restore_block_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        BlockId::from_trusted(&alpha),
        deleted_at,
    )
    .await
    .unwrap();
    for _ in 0..4 {
        fx.tick().await;
    }

    assert!(!is_trashed(&fx, &alpha).await, "restored");
    assert!(fx.root.join(ALPHA).exists(), "and written again");
}

// ── Which spaces are mirrored (#5363 slice 4, setting 2) ────────────────

use crate::commands::mirror::set_mirror_space_inner;

async fn mirror_space(fx: &Fx, space: &str, mirrored: bool) -> MirrorStatus {
    set_mirror_space_inner(&fx.pool, DEV, &fx.state, space, mirrored)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_space_turned_off_loses_its_unchanged_files_and_keeps_its_changed_ones() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    space_b(&fx).await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.page("Beta", &["two"]).await;
    let other = create_page_in_space_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        None,
        "Other".into(),
        TEST_SPACE_B_ID.into(),
    )
    .await
    .unwrap()
    .into_string();
    fx.tick().await;
    write_at(&fx, "TestSpace/Beta.md", "changed outside\n");

    let status = mirror_space(&fx, TEST_SPACE_ID, false).await;
    assert_eq!(status.unmirrored_spaces, [TEST_SPACE_ID]);
    for _ in 0..4 {
        fx.tick().await;
    }

    assert!(!fx.root.join(ALPHA).exists(), "an unchanged file goes");
    let beta = std::fs::read_to_string(fx.root.join("TestSpace/Beta.md")).unwrap();
    assert_eq!(beta, "changed outside\n", "a changed one stays");
    let status = fx.status().await;
    assert_eq!(
        status.diverged.len(),
        1,
        "and is listed: {:?}",
        status.diverged
    );
    assert!(
        fx.root.join("TestSpaceB/Other.md").exists(),
        "the other space is still mirrored"
    );
    assert!(!is_trashed(&fx, &alpha).await);
    assert!(!is_trashed(&fx, &other).await);

    mirror_space(&fx, TEST_SPACE_ID, true).await;
    for _ in 0..2 {
        fx.tick().await;
    }
    assert!(
        fx.root.join(ALPHA).exists(),
        "turned on again, it is written"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_in_an_unmirrored_space_folder_is_left_alone() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    space_b(&fx).await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    mirror_space(&fx, TEST_SPACE_B_ID, false).await;
    write_at(&fx, "TestSpaceB/Gamma.md", "new\n");
    for _ in 0..4 {
        fx.tick().await;
    }

    assert!(pages_titled(&fx, "Gamma").await.is_empty());
    assert_eq!(
        std::fs::read_to_string(fx.root.join("TestSpaceB/Gamma.md")).unwrap(),
        "new\n"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_moved_into_an_unmirrored_space_folder_leaves_its_page_where_it_was() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    space_b(&fx).await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    mirror_space(&fx, TEST_SPACE_B_ID, false).await;
    fx.tick().await;

    rename_at(&fx, ALPHA, "TestSpaceB/Alpha.md");
    for _ in 0..6 {
        fx.tick().await;
    }

    assert!(!is_trashed(&fx, &alpha).await, "not trashed");
    assert_eq!(space_of(&fx, &alpha).await, TEST_SPACE_ID, "nor moved");
    assert!(
        fx.root.join("TestSpaceB/Alpha.md").exists(),
        "the file is left where it is"
    );
    assert!(!fx.root.join(ALPHA).exists(), "and not written twice");
    let failed = fx.status().await.failed;
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert!(failed[0].message.contains("not mirrored"), "{failed:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_moved_into_a_space_turned_back_on_moves_its_page_there() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    space_b(&fx).await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    mirror_space(&fx, TEST_SPACE_B_ID, false).await;
    fx.tick().await;
    rename_at(&fx, ALPHA, "TestSpaceB/Alpha.md");
    for _ in 0..6 {
        fx.tick().await;
    }

    mirror_space(&fx, TEST_SPACE_B_ID, true).await;
    for _ in 0..6 {
        fx.tick().await;
    }

    assert_eq!(space_of(&fx, &alpha).await, TEST_SPACE_B_ID, "moved");
    assert!(!is_trashed(&fx, &alpha).await, "not trashed");
    assert!(!fx.root.join(ALPHA).exists(), "and not written twice");
    assert_eq!(fx.status().await.failed, vec![], "no longer refused");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_space_made_after_others_were_turned_off_is_mirrored() {
    use crate::commands::tests::common::TEST_SPACE_B_ID;
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    mirror_space(&fx, TEST_SPACE_ID, false).await;
    space_b(&fx).await;
    create_page_in_space_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        None,
        "Other".into(),
        TEST_SPACE_B_ID.into(),
    )
    .await
    .unwrap();
    for _ in 0..2 {
        fx.tick().await;
    }

    assert!(fx.root.join("TestSpaceB/Other.md").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_change_in_an_unmirrored_space_is_not_pending_for_reading_back() {
    let mut fx = Fx::new().await;
    fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    read_back(&fx, false, false).await.unwrap();
    fx.write("changed outside\n");
    mirror_space(&fx, TEST_SPACE_ID, false).await;
    fx.tick().await;

    assert_eq!(paths(&fx.status().await.pending), Vec::<String>::new());
    assert!(read_back(&fx, true, false).await.unwrap().read_back);
}

#[test]
fn of_the_texts_explaining_a_file_as_well_the_shortest_is_its_base() {
    let shadow = |text: &str| Shadow {
        text: text.into(),
        line_ids: Vec::new(),
        buffer: None,
        render: None,
    };
    let shadows = [shadow("a\nb\nc"), shadow("a\nb\nc\nd")];
    assert_eq!(closest(&shadows, "a\nb").unwrap().text, "a\nb\nc");
    let tied = [shadow("a\nb\nc"), shadow("a\nb\nd")];
    assert_eq!(
        closest(&tied, "a\nb").unwrap().text,
        "a\nb\nd",
        "the newest of equals"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_anchored_block_moved_and_edited_keeps_its_id() {
    let mut fx = Fx::new().await;
    let (page, ids) = fx.page("Alpha", &["one", "two"]).await;
    refer_to(&fx, &ids[1]).await;
    fx.tick().await;
    fx.tick().await;
    assert!(
        fx.read().contains(&format!("two ^{}", ids[1])),
        "{}",
        fx.read()
    );

    fx.write(format!("TWO ^{}\n\nONE\n", ids[1]));
    fx.settle_file().await;

    let blocks = fx.blocks(&page).await;
    assert_eq!(
        blocks[0],
        (ids[1].clone(), "TWO".to_owned()),
        "the anchor names the block, not the line's place: {blocks:?}"
    );
}

/// The page's texts as a state written before ingests holds them: no buffer.
fn without_buffers(fx: &mut Fx, page: &str) {
    for shadow in &mut fx.mirror.pages.get_mut(page).unwrap().shadows {
        shadow.buffer = None;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_over_a_text_with_no_buffer_reads_against_the_page_while_it_renders_so() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;
    without_buffers(&mut fx, &page);

    fx.write(fx.read().replace("two", "TWO"));
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["one", "TWO"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_over_a_text_with_no_buffer_is_left_once_the_page_renders_otherwise() {
    let mut fx = Fx::new().await;
    let (page, ids) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;
    without_buffers(&mut fx, &page);

    fx.edit(&ids[0], "uno").await;
    fx.write(fx.read().replace("two", "TWO"));
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["uno", "two"], "no base, no read");
    let diverged: Vec<String> = fx
        .status()
        .await
        .diverged
        .into_iter()
        .map(|f| f.page_id)
        .collect();
    assert_eq!(diverged, [page]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn text_saved_in_the_file_of_a_page_with_no_blocks_is_read_in() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &[]).await;
    fx.tick().await;

    fx.write("hello\n");
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["hello"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_save_corrected_after_one_was_refused_is_read_in() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    fx.write("   \n");
    fx.settle_file().await;
    assert_eq!(
        fx.status().await.failed.len(),
        1,
        "an emptied file is refused"
    );

    fx.write("uno\n");
    fx.settle_file().await;

    assert_eq!(fx.contents(&page).await, ["uno"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_read_in_otherwise_than_saved_is_written_back_as_read() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    write_at(&fx, "TestSpace/Gamma.md", "one\r\n\r\ntwo\r\n");
    fx.settle_file().await;

    let pages = pages_titled(&fx, "Gamma").await;
    assert_eq!(fx.contents(&pages[0]).await, ["one", "two"]);
    let file = std::fs::read_to_string(fx.root.join("TestSpace/Gamma.md")).unwrap();
    assert!(!file.contains('\r'), "written back with LF: {file:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_anchoring_no_page_s_block_is_no_vanished_file_renamed() {
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;
    std::fs::remove_file(fx.root.join(ALPHA)).unwrap();
    write_at(
        &fx,
        "TestSpace/Gamma.md",
        "elsewhere ^01ARZ3NDEKTSV4RRFFQ69G5FAV\n",
    );
    fx.settle_file().await;

    let gamma = pages_titled(&fx, "Gamma").await;
    assert_eq!(gamma.len(), 1);
    assert_ne!(gamma[0], alpha, "Alpha's vanished file is not this one");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_refused_while_empty_is_read_once_it_holds_text() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    write_at(&fx, "TestSpace/Gamma.md", "   \n");
    fx.settle_file().await;
    assert!(pages_titled(&fx, "Gamma").await.is_empty(), "refused");

    write_at(&fx, "TestSpace/Gamma.md", "hello\n");
    fx.settle_file().await;

    let pages = pages_titled(&fx, "Gamma").await;
    assert_eq!(pages.len(), 1);
    assert_eq!(fx.contents(&pages[0]).await, ["hello"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_edited_as_its_page_is_renamed_is_read_in_then_moved() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;

    fx.write(fx.read().replace("one", "uno"));
    fx.edit(&page, "Gamma").await;
    for _ in 0..4 {
        fx.tick().await;
    }

    assert_eq!(fx.contents(&page).await, ["uno"], "read in at its old path");
    assert!(!fx.root.join(ALPHA).exists(), "then moved");
    let moved = std::fs::read_to_string(fx.root.join("TestSpace/Gamma.md")).unwrap();
    assert!(moved.contains("uno"), "{moved}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_a_renamed_page_s_edited_file_does_not_end_the_pass() {
    let mut fx = Fx::new().await;
    let (page, _) = fx.page("Alpha", &["one"]).await;
    let (_, beta) = fx.page("Beta", &["b"]).await;
    fx.tick().await;

    fx.write(fx.read().replace("one", "uno"));
    fx.edit(&page, "Gamma").await;
    fx.edit(&beta[0], "B").await;
    fx.tick().await;

    let file = std::fs::read_to_string(fx.root.join("TestSpace/Beta.md")).unwrap();
    assert!(
        file.lines().any(|line| line == "B"),
        "the same pass writes Beta: {file}"
    );
}

/// Alpha as `one` and `two`, its file saved with `*` bullets, which read the
/// same and are kept.
async fn alpha_with_own_bullets(fx: &mut Fx) -> (String, Vec<String>, String) {
    let (page, ids) = fx.page("Alpha", &["one", "two"]).await;
    fx.tick().await;
    let render = fx.read();
    fx.write("* one\n* two\n");
    fx.settle_file().await;
    assert_eq!(fx.read(), "* one\n* two\n", "the bullets are kept");
    (page, ids, render)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_saved_back_as_the_render_is_adopted_not_read() {
    let mut fx = Fx::new().await;
    let (page, _, _) = alpha_with_own_bullets(&mut fx).await;
    let events = fx.events().len();
    let render = get_page_file_inner(&fx.pool, &page).await.unwrap().text;
    assert_ne!(fx.read(), render, "the file keeps its own bullets");

    fx.write(&render);
    fx.tick().await;

    assert!(fx.status().await.diverged.is_empty(), "nothing to settle");
    assert_eq!(fx.events().len(), events, "nothing read in");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_written_before_its_state_was_saved_is_adopted_not_read() {
    let mut fx = Fx::new().await;
    let (page, ids, _) = alpha_with_own_bullets(&mut fx).await;
    let stale = fx.mirror.pages[&page].clone();
    let events = fx.events().len();

    fx.edit(&ids[1], "TWO").await;
    fx.tick().await;
    assert!(fx.read().starts_with("* one\n"), "{}", fx.read());
    fx.mirror.pages.insert(page.clone(), stale);
    // The pass a restart would run, over every page.
    fx.mirror.full_due = true;
    fx.tick().await;

    assert!(fx.status().await.diverged.is_empty(), "nothing to settle");
    assert_eq!(fx.events().len(), events, "nothing read in");
}

// ── Files moved outside the space folders, and mass changes (#6887 C) ───

use super::super::read_back::MASS_CHANGE;

/// The files listed as failed, each with why.
async fn failed_files(fx: &Fx) -> Vec<(String, String)> {
    let failed = fx.status().await.failed;
    failed.into_iter().map(|f| (f.path, f.message)).collect()
}

/// Alpha's file moved to `outside`, a place in no space's folder: its page is
/// held, the file listed, and moving it back lets the page be written again.
async fn moved_outside_the_space_folders(outside: &str) {
    let mut fx = Fx::new().await;
    let (alpha, blocks) = fx.page("Alpha", &["one"]).await;
    fx.tick().await;

    rename_at(&fx, ALPHA, outside);
    for _ in 0..MISSING_TICKS + 2 {
        fx.tick().await;
    }

    assert!(!is_trashed(&fx, &alpha).await, "not trashed");
    assert_eq!(pages_titled(&fx, "Alpha").await, [alpha], "nor renamed");
    assert!(fx.root.join(outside).exists(), "the file is left there");
    assert!(!fx.root.join(ALPHA).exists(), "and not written twice");
    let failed = failed_files(&fx).await;
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert_eq!(failed[0].0, outside);
    assert!(
        failed[0].1.contains("outside the space folders"),
        "{failed:?}"
    );

    rename_at(&fx, outside, ALPHA);
    fx.edit(&blocks[0], "uno").await;
    fx.settle_file().await;
    assert_eq!(failed_files(&fx).await, []);
    assert!(fx.read().contains("uno"), "moved back, it is written again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_moved_to_the_folder_root_holds_its_page_untrashed() {
    moved_outside_the_space_folders("Alpha.md").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_moved_into_a_folder_of_no_space_holds_its_page_untrashed() {
    moved_outside_the_space_folders("Elsewhere/Alpha.md").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_file_outside_every_space_folder_is_listed_as_not_read() {
    let mut fx = Fx::new().await;
    fx.tick().await;
    write_at(&fx, "loose.md", "loose\n");
    write_at(&fx, "Elsewhere/Note.md", "note\n");
    write_at(&fx, ".hidden.md", "hidden\n");
    fx.settle_file().await;

    let failed = failed_files(&fx).await;
    let paths: Vec<&str> = failed.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(paths, ["Elsewhere/Note.md", "loose.md"]);
    for (path, why) in &failed {
        assert!(
            why.contains("only inside a space's folder"),
            "{path}: {why}"
        );
    }

    std::fs::remove_file(fx.root.join("loose.md")).unwrap();
    fx.tick().await;
    let failed = failed_files(&fx).await;
    assert_eq!(failed.len(), 1, "a file gone is no longer listed");
    assert_eq!(failed[0].0, "Elsewhere/Note.md");
}

/// Alpha, then `count` more pages of the test space, each holding `text`,
/// mirrored: Alpha's block, and the others' pages and files.
async fn alpha_and_pages(fx: &mut Fx, count: usize) -> (String, Vec<(String, String)>) {
    let (_, blocks) = fx.page("Alpha", &["one"]).await;
    let mut made = Vec::new();
    for n in 0..count {
        let (page, _) = fx.page(&format!("Page {n}"), &["text"]).await;
        made.push((page, format!("TestSpace/Page {n}.md")));
    }
    fx.tick().await;
    (blocks[0].clone(), made)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn more_files_deleted_at_once_than_the_limit_trash_no_page_until_the_user_says_so() {
    let mut fx = Fx::new().await;
    let (block, made) = alpha_and_pages(&mut fx, MASS_CHANGE + 1).await;
    let files: Vec<String> = made.iter().map(|(_, file)| file.clone()).collect();

    for file in &files {
        std::fs::remove_file(fx.root.join(file)).unwrap();
    }
    fx.edit(&block, "uno").await;
    for _ in 0..MISSING_TICKS + 2 {
        fx.tick().await;
    }

    for (page, file) in &made {
        assert!(!is_trashed(&fx, page).await, "{file}: not trashed");
        assert!(!fx.root.join(file).exists(), "{file}: nor written again");
    }
    assert!(fx.events().is_empty());
    assert!(
        fx.read().contains("uno"),
        "an unchanged file is still written"
    );
    let status = fx.status().await;
    assert!(!status.read_back, "reading back waits for the user");
    assert_eq!(paths(&status.pending), files);
    let failed = failed_files(&fx).await;
    assert_eq!(failed.len(), 1, "{failed:?}");
    let (folder, why) = &failed[0];
    assert_eq!(folder, "TestSpace");
    assert!(
        why.contains("changed or vanished outside Agaric at once"),
        "{why}"
    );

    let status = confirm(&fx, paths(&status.pending)).await.unwrap();
    assert!(status.read_back);
    assert_eq!(status.failed, []);
    for _ in 0..MISSING_TICKS + 2 {
        fx.tick().await;
    }
    for (page, file) in &made {
        assert!(
            is_trashed(&fx, page).await,
            "{file}: trashed once confirmed"
        );
    }
    let status = fx.status().await;
    assert!(status.read_back, "and reading back stays on");
    assert_eq!(status.failed, []);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn as_many_files_deleted_at_once_as_the_limit_trash_their_pages_unasked() {
    let mut fx = Fx::new().await;
    let (_, made) = alpha_and_pages(&mut fx, MASS_CHANGE).await;

    for (_, file) in &made {
        std::fs::remove_file(fx.root.join(file)).unwrap();
    }
    for _ in 0..MISSING_TICKS + 2 {
        fx.tick().await;
    }

    for (page, file) in &made {
        assert!(is_trashed(&fx, page).await, "{file}");
    }
    let status = fx.status().await;
    assert!(status.read_back);
    assert_eq!(status.failed, []);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn more_files_edited_at_once_than_the_limit_are_read_in_only_once_the_user_says_so() {
    let mut fx = Fx::new().await;
    let (_, made) = alpha_and_pages(&mut fx, MASS_CHANGE + 1).await;
    let files: Vec<String> = made.iter().map(|(_, file)| file.clone()).collect();

    for file in &files {
        let edited = std::fs::read_to_string(fx.root.join(file)).unwrap();
        write_at(&fx, file, edited.replace("text", "edited"));
    }
    for _ in 0..3 {
        fx.tick().await;
    }

    for (page, file) in &made {
        assert_eq!(fx.contents(page).await, ["text"], "{file}: not read in");
    }
    let status = fx.status().await;
    assert!(!status.read_back, "reading back waits for the user");
    assert_eq!(paths(&status.pending), files);

    confirm(&fx, paths(&status.pending)).await.unwrap();
    for _ in 0..3 {
        fx.tick().await;
    }
    for (page, file) in &made {
        assert_eq!(fx.contents(page).await, ["edited"], "{file}: read in");
    }
    assert!(fx.status().await.read_back);

    // The choice was for the files as shown, not for their next change.
    for file in &files {
        let edited = std::fs::read_to_string(fx.root.join(file)).unwrap();
        write_at(&fx, file, edited.replace("edited", "again"));
    }
    for _ in 0..3 {
        fx.tick().await;
    }
    for (page, file) in &made {
        assert_eq!(fx.contents(page).await, ["edited"], "{file}: asked again");
    }
    assert!(!fx.status().await.read_back);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_put_back_as_they_were_turn_reading_back_on_again() {
    let mut fx = Fx::new().await;
    let (_, made) = alpha_and_pages(&mut fx, MASS_CHANGE + 1).await;
    let mut written = Vec::new();
    for (_, file) in &made {
        written.push(std::fs::read(fx.root.join(file)).unwrap());
        std::fs::remove_file(fx.root.join(file)).unwrap();
    }
    fx.settle_file().await;
    assert!(!fx.status().await.read_back);

    for ((_, file), bytes) in made.iter().zip(&written) {
        write_at(&fx, file, bytes);
    }
    fx.tick().await;

    let status = fx.status().await;
    assert!(status.read_back);
    assert_eq!(status.failed, []);
    for (page, file) in &made {
        assert!(!is_trashed(&fx, page).await, "{file}");
    }
}

/// A hold is told as it starts, naming its space's folder, and not again each
/// tick it lasts; its end is told too, here the user reading the files in,
/// so no notice of it outlives it (#6964).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hold_is_told_once_as_it_starts_and_once_as_it_ends() {
    let mut fx = Fx::new().await;
    let (_, made) = alpha_and_pages(&mut fx, MASS_CHANGE + 1).await;
    for (_, file) in &made {
        std::fs::remove_file(fx.root.join(file)).unwrap();
    }
    for _ in 0..MISSING_TICKS + 4 {
        fx.tick().await;
    }
    let status = fx.status().await;
    assert_eq!(status.held, ["TestSpace"], "the fixture: held");
    assert_eq!(fx.told_held(), [vec!["TestSpace".to_owned()]]);

    confirm(&fx, paths(&status.pending)).await.unwrap();
    fx.tick().await;
    fx.tick().await;

    assert_eq!(
        fx.told_held(),
        [vec!["TestSpace".to_owned()], Vec::<String>::new()]
    );
}

/// A hold the user ended is told ended even when the next tick holds the
/// same folder again, as edited files read in and deleted since do: the
/// notice and the card then show the new hold instead of none.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hold_ended_by_the_user_and_held_again_by_the_next_tick_is_told_again() {
    let mut fx = Fx::new().await;
    let (_, made) = alpha_and_pages(&mut fx, MASS_CHANGE + 1).await;
    for (_, file) in &made {
        write_at(&fx, file, "changed outside\n");
    }
    for _ in 0..3 {
        fx.tick().await;
    }
    let status = fx.status().await;
    assert_eq!(status.held, ["TestSpace"], "the fixture: held");
    confirm(&fx, status.pending).await.unwrap();
    for (_, file) in &made {
        std::fs::remove_file(fx.root.join(file)).unwrap();
    }

    fx.tick().await;

    let held = vec!["TestSpace".to_owned()];
    assert_eq!(fx.told_held(), [held.clone(), Vec::new(), held]);
}

/// The hold is kept in memory only: files deleted while Agaric was closed, or
/// before a restart, are asked about by the mirror that starts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn files_deleted_before_a_restart_trash_no_page_until_the_user_says_so() {
    let mut fx = Fx::new().await;
    let (_, made) = alpha_and_pages(&mut fx, MASS_CHANGE + 1).await;
    let files: Vec<String> = made.iter().map(|(_, file)| file.clone()).collect();
    for file in &files {
        std::fs::remove_file(fx.root.join(file)).unwrap();
    }

    fx.state = MirrorState::new(fx.state.app_data_dir().to_path_buf());
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
    for _ in 0..MISSING_TICKS + 2 {
        fx.tick().await;
    }

    for (page, file) in &made {
        assert!(!is_trashed(&fx, page).await, "{file}");
    }
    let status = fx.status().await;
    assert!(!status.read_back);
    assert_eq!(paths(&status.pending), files);
}

/// `read_back::pending` lists no file of an unmirrored space, so one held
/// for could never be confirmed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_changed_files_of_a_space_turned_off_hold_no_reading_back() {
    let mut fx = Fx::new().await;
    let (_, made) = alpha_and_pages(&mut fx, MASS_CHANGE + 1).await;
    for (_, file) in &made {
        write_at(&fx, file, "changed outside\n");
    }
    mirror_space(&fx, TEST_SPACE_ID, false).await;
    for _ in 0..3 {
        fx.tick().await;
    }

    let status = fx.status().await;
    assert_eq!(status.diverged.len(), MASS_CHANGE + 1, "kept and listed");
    assert!(status.read_back);
    assert_eq!(status.failed, []);
}

/// A hold is the folder's: turning the mirror off forgets it, so the switch
/// sent with the folder chosen next is reading back as the user left it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_the_mirror_off_forgets_its_hold() {
    let mut fx = Fx::new().await;
    let (_, made) = alpha_and_pages(&mut fx, MASS_CHANGE + 1).await;
    for (_, file) in &made {
        std::fs::remove_file(fx.root.join(file)).unwrap();
    }
    fx.settle_file().await;
    assert!(!fx.status().await.read_back, "the fixture: held");

    let off = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, None, false)
        .await
        .unwrap();

    assert!(off.read_back, "reading back is on, as the user left it");
}

/// Obsidian rewrites every file linking a note as it renames it, which is
/// more files changed at once than the mirror reads in unasked. Asking is a
/// setting, on by default: off, such a rename is read in unasked, and a
/// hold already shown ends at once.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rename_rewriting_many_links_asks_first_unless_asking_is_off() {
    use crate::commands::mirror::set_mirror_ask_mass_change_inner;
    let mut fx = Fx::new().await;
    let (alpha, _) = fx.page("Alpha", &["one"]).await;
    let mut linking = Vec::new();
    for n in 0..MASS_CHANGE {
        let link = format!("see [[{alpha}]]");
        fx.page(&format!("Page {n}"), &[&link]).await;
        linking.push(format!("TestSpace/Page {n}.md"));
    }
    fx.tick().await;
    assert!(fx.status().await.ask_mass_change, "on by default");

    rename_at(&fx, ALPHA, "TestSpace/Gamma.md");
    for file in &linking {
        let text = std::fs::read_to_string(fx.root.join(file)).unwrap();
        assert!(text.contains("[[Alpha]]"), "the fixture: {text}");
        write_at(&fx, file, text.replace("[[Alpha]]", "[[Gamma]]"));
    }
    fx.settle_file().await;
    fx.tick().await;
    let held = fx.status().await;
    assert!(!held.read_back, "asked first");
    assert_eq!(held.held, ["TestSpace"]);
    assert!(
        pages_titled(&fx, "Gamma").await.is_empty(),
        "nothing read in"
    );

    let off = set_mirror_ask_mass_change_inner(&fx.pool, DEV, &fx.state, false)
        .await
        .unwrap();
    assert!(!off.ask_mass_change);
    assert!(off.read_back, "the hold ends at once");
    assert_eq!(off.held, Vec::<String>::new());
    fx.settle_file().await;
    fx.tick().await;

    let status = fx.status().await;
    assert!(status.read_back, "{:?}", status.failed);
    assert_eq!(pages_titled(&fx, "Gamma").await, [alpha], "renamed");
    assert_eq!(status.diverged, [], "every edit read in");
}
