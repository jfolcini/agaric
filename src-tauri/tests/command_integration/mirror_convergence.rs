//! The Markdown mirror under edits from both sides (#5363): a page edited in
//! Agaric and its file edited outside it, interleaved with the mirror's ticks
//! in any order, settles on a file that reads as the page. No block is
//! duplicated, and undoing an ingest, with nothing done since, puts the page
//! back as it was before that ingest.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use proptest::prelude::*;
use tokio::runtime::Runtime;

use agaric_core::ulid::BlockId;
use agaric_lib::commands::history::undo_ops_inner;
use agaric_lib::commands::mirror::{get_mirror_status_inner, set_mirror_folder_inner};
use agaric_lib::commands::tests::common::{
    DEV, TEST_SPACE_ID, ensure_test_space, mark_block_as_space, settle,
};
use agaric_lib::commands::{
    create_block_inner, create_page_in_space_inner, delete_block_inner, edit_block_inner,
};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::mirror::ingest::{Ingest, MirrorIngested};
use agaric_lib::mirror::{Mirror, MirrorState};
use sqlx::SqlitePool;
use tempfile::TempDir;

const FILE: &str = "TestSpace/Alpha.md";

/// One step. An index picks a block or a file paragraph modulo their count,
/// and a step with nothing to pick does nothing.
#[derive(Debug, Clone)]
enum Step {
    EditBlock(usize),
    AddBlock,
    DeleteBlock(usize),
    EditFile(usize),
    AddToFile,
    DeleteFromFile(usize),
    /// A tick; with `undo`, an ingest it runs is undone straight after.
    Tick {
        undo: bool,
    },
}

fn arb_step() -> impl Strategy<Value = Step> {
    prop_oneof![
        2 => any::<usize>().prop_map(Step::EditBlock),
        1 => Just(Step::AddBlock),
        1 => any::<usize>().prop_map(Step::DeleteBlock),
        2 => any::<usize>().prop_map(Step::EditFile),
        1 => Just(Step::AddToFile),
        1 => any::<usize>().prop_map(Step::DeleteFromFile),
        4 => any::<bool>().prop_map(|undo| Step::Tick { undo }),
    ]
}

struct Fx {
    pool: SqlitePool,
    mat: Materializer,
    state: MirrorState,
    mirror: Mirror,
    page: String,
    file: PathBuf,
    events: Arc<Mutex<Vec<MirrorIngested>>>,
    _dirs: [TempDir; 3],
}

impl Fx {
    /// A page holding `w0`..`w2`, written to its file by a first tick.
    async fn new() -> Self {
        let db = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        let folder = TempDir::new().unwrap();
        let pool = init_pool(&db.path().join("test.db")).await.unwrap();
        let mat = Materializer::new(pool.clone());
        ensure_test_space(&pool).await;
        mark_block_as_space(&pool, TEST_SPACE_ID).await;
        let page = create_page_in_space_inner(
            &pool,
            DEV,
            &mat,
            None,
            "Alpha".into(),
            TEST_SPACE_ID.into(),
        )
        .await
        .unwrap()
        .into_string();
        let state = MirrorState::new(data.path().to_path_buf());
        set_mirror_folder_inner(
            &pool,
            DEV,
            &state,
            Some(folder.path().display().to_string()),
            true,
        )
        .await
        .unwrap();
        let events: Arc<Mutex<Vec<MirrorIngested>>> = Arc::default();
        let seen = Arc::clone(&events);
        let ingest = Ingest {
            pool: pool.clone(),
            materializer: mat.clone(),
            notify: Arc::new(move |event| seen.lock().unwrap().push(event)),
        };
        let mirror = Mirror::open(pool.clone(), DEV.to_owned(), state.clone())
            .await
            .unwrap()
            .with_ingest(ingest);
        let mut fx = Self {
            pool,
            mat,
            state,
            mirror,
            page,
            file: folder.path().join(FILE),
            events,
            _dirs: [db, data, folder],
        };
        for word in ["w0", "w1", "w2"] {
            fx.add_block(word).await;
        }
        fx.tick().await;
        fx
    }

    async fn tick(&mut self) {
        settle(&self.mat).await;
        self.mirror.tick().await.unwrap();
        settle(&self.mat).await;
    }

    /// The page's live blocks, `(id, content)` in order.
    async fn blocks(&self) -> Vec<(String, String)> {
        sqlx::query_as(
            "SELECT id, COALESCE(content, '') FROM blocks
              WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id",
        )
        .bind(&self.page)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }

    async fn add_block(&self, word: &str) {
        create_block_inner(
            &self.pool,
            DEV,
            &self.mat,
            "content".into(),
            word.into(),
            Some(BlockId::from_trusted(&self.page)),
            None,
        )
        .await
        .unwrap();
    }

    /// The block `at` picks, `None` on an empty page.
    async fn pick(&self, at: usize) -> Option<BlockId> {
        let blocks = self.blocks().await;
        let (id, _) = blocks.get(at % blocks.len().max(1))?;
        Some(BlockId::from_trusted(id))
    }

    /// The file's paragraphs, each block's text with no anchor.
    fn paragraphs(&self) -> Vec<String> {
        let text = std::fs::read_to_string(&self.file).unwrap_or_default();
        text.split("\n\n")
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| p.split(" ^").next().unwrap_or(p).to_owned())
            .collect()
    }

    fn write_paragraphs(&self, paragraphs: &[String]) {
        std::fs::write(&self.file, format!("{}\n", paragraphs.join("\n\n"))).unwrap();
    }

    async fn run(&mut self, n: usize, step: &Step) -> Result<(), TestCaseError> {
        let word = format!("s{n}");
        match step {
            Step::EditBlock(at) => {
                if let Some(id) = self.pick(*at).await {
                    edit_block_inner(&self.pool, DEV, &self.mat, id, word)
                        .await
                        .unwrap();
                }
            }
            Step::DeleteBlock(at) => {
                if let Some(id) = self.pick(*at).await {
                    delete_block_inner(&self.pool, DEV, &self.mat, id)
                        .await
                        .unwrap();
                }
            }
            Step::AddBlock => self.add_block(&word).await,
            Step::EditFile(at) | Step::DeleteFromFile(at) => {
                let mut paragraphs = self.paragraphs();
                // Emptying the file is refused by design, so one stays.
                let floor = if matches!(step, Step::DeleteFromFile(_)) {
                    2
                } else {
                    1
                };
                if paragraphs.len() < floor {
                    return Ok(());
                }
                let at = at % paragraphs.len();
                if matches!(step, Step::EditFile(_)) {
                    paragraphs[at] = word;
                } else {
                    paragraphs.remove(at);
                }
                self.write_paragraphs(&paragraphs);
            }
            Step::AddToFile => {
                let mut paragraphs = self.paragraphs();
                paragraphs.push(word);
                self.write_paragraphs(&paragraphs);
            }
            Step::Tick { undo } => {
                let before = self.blocks().await;
                let seen = self.events.lock().unwrap().len();
                self.tick().await;
                let new: Vec<MirrorIngested> = self.events.lock().unwrap()[seen..].to_vec();
                prop_assert!(new.len() <= 1, "one file, one ingest a tick: {new:?}");
                if let (true, Some(event)) = (*undo, new.first())
                    && !event.op_refs.is_empty()
                {
                    undo_ops_inner(&self.pool, DEV, &self.mat, event.op_refs.clone())
                        .await
                        .unwrap();
                    settle(&self.mat).await;
                    prop_assert_eq!(
                        self.blocks().await,
                        before,
                        "one undo reverts the ingest {:?}",
                        event.report
                    );
                }
            }
        }
        Ok(())
    }
}

async fn converges(steps: Vec<Step>) -> Result<(), TestCaseError> {
    let mut fx = Fx::new().await;
    for (n, step) in steps.iter().enumerate() {
        fx.run(n, step).await?;
    }
    // Settled once two ticks in a row read nothing in and write nothing.
    let mut quiet = 0;
    for _ in 0..12 {
        let file = std::fs::read(&fx.file).ok();
        let seen = fx.events.lock().unwrap().len();
        fx.tick().await;
        let still = std::fs::read(&fx.file).ok() == file && fx.events.lock().unwrap().len() == seen;
        quiet = if still { quiet + 1 } else { 0 };
        if quiet == 2 {
            break;
        }
    }
    prop_assert_eq!(quiet, 2, "the mirror settles");
    let status = get_mirror_status_inner(&fx.pool, DEV, &fx.state)
        .await
        .unwrap();
    prop_assert!(status.diverged.is_empty(), "{:?}", status.diverged);
    prop_assert!(status.failed.is_empty(), "{:?}", status.failed);
    let contents: Vec<String> = fx.blocks().await.into_iter().map(|(_, c)| c).collect();
    prop_assert_eq!(
        fx.paragraphs(),
        contents.clone(),
        "the file reads as the page"
    );
    let mut unique = contents.clone();
    unique.sort();
    unique.dedup();
    prop_assert_eq!(
        unique.len(),
        contents.len(),
        "no block is duplicated: {:?}",
        contents
    );
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn edits_from_both_sides_converge_with_no_duplicate_and_each_ingest_undoes(
        steps in prop::collection::vec(arb_step(), 1..30),
    ) {
        Runtime::new().unwrap().block_on(converges(steps))?;
    }
}

/// The case the proptest shrank to: two blocks added in Agaric, a tick, then
/// three paragraphs deleted from the file in a row.
#[test]
fn deleting_paragraphs_after_two_added_blocks_duplicates_none() {
    Runtime::new()
        .unwrap()
        .block_on(converges(vec![
            Step::EditBlock(16_094_957_617_744_931_308),
            Step::AddBlock,
            Step::AddBlock,
            Step::Tick { undo: false },
            Step::DeleteFromFile(871_752_782_241_211_427),
            Step::DeleteFromFile(39_931_202_784_980_681),
            Step::DeleteFromFile(385_241_135_033_025_694),
        ]))
        .unwrap();
}
