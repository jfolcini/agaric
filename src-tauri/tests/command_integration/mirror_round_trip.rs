//! The Markdown mirror's round trip (#5363): every page the mirror writes,
//! saved again by an editor that only re-encodes it (CRLF, a BOM), reads back
//! through the ingest as the page it is, with no op appended.
//!
//! Bytes equal to the text last written never reach the ingest, so the
//! re-encoding is what sends the file through it: the file form (names, a
//! `^ID` only on an addressed block), each line paired against the shadow,
//! and the save against the shadow's buffer. The pages are the
//! `markdown-corpus` documents, imported, and a generated tree whose blocks
//! repeat their contents, so a line has twins to be paired with.

use std::path::Path;
use std::sync::{Arc, Mutex};

use proptest::prelude::*;
use tokio::runtime::Runtime;

use agaric_core::ulid::BlockId;
use agaric_lib::commands::mirror::{get_mirror_status_inner, set_mirror_folder_inner};
use agaric_lib::commands::tests::common::{
    DEV, TEST_SPACE_ID, ensure_test_space, mark_block_as_space, settle,
};
use agaric_lib::commands::{create_block_inner, create_page_in_space_inner, import_markdown_inner};
use agaric_lib::db::init_pool;
use agaric_lib::materializer::Materializer;
use agaric_lib::mirror::ingest::{Ingest, MirrorIngested};
use agaric_lib::mirror::{Mirror, MirrorState};
use sqlx::SqlitePool;
use tempfile::TempDir;

const CORPUS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/agaric-engine/tests/markdown-corpus"
);

/// A block of the generated page: how far it nests below the block before it
/// (clamped to one level deeper at most), and which corpus block's content it
/// copies, modulo their count.
type Spec = (usize, usize);

/// `bytes` saved as an editor that writes CRLF line ends, a BOM, or both
/// would save them.
fn re_encoded(bytes: &[u8], (crlf, bom): (bool, bool)) -> Vec<u8> {
    let text = std::str::from_utf8(bytes).expect("the mirror writes UTF-8");
    let text = if crlf {
        text.replace('\n', "\r\n")
    } else {
        text.to_owned()
    };
    let text = if bom { format!("\u{feff}{text}") } else { text };
    text.into_bytes()
}

/// Every `.md` file below `root`, as `(path, bytes)` in path order.
fn files(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "md") {
                let name = path.strip_prefix(root).unwrap().display().to_string();
                found.push((name, std::fs::read(&path).unwrap()));
            }
        }
    }
    found.sort();
    found
}

async fn op_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Import every corpus document into the test space, then add a page holding
/// `specs` as a tree of copies of the imported blocks' contents.
async fn seed(pool: &SqlitePool, mat: &Materializer, data: &Path, specs: &[Spec]) {
    let mut corpus: Vec<_> = std::fs::read_dir(CORPUS)
        .expect("the corpus directory")
        .map(|entry| entry.unwrap().path())
        .collect();
    corpus.sort();
    for path in corpus {
        let name = path.file_stem().unwrap().to_str().unwrap().to_owned();
        let text = std::fs::read_to_string(&path).expect("a UTF-8 document");
        import_markdown_inner(
            pool,
            DEV,
            mat,
            data,
            text,
            Some(format!("{name}.md")),
            TEST_SPACE_ID.into(),
            None,
        )
        .await
        .unwrap_or_else(|e| panic!("{name} imports: {e}"));
        settle(mat).await;
    }
    let contents: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM blocks
          WHERE block_type = 'content' AND deleted_at IS NULL
            AND content IS NOT NULL AND content != ''
          ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(!contents.is_empty(), "the corpus imports blocks");
    let page = create_page_in_space_inner(
        pool,
        DEV,
        mat,
        None,
        "Generated".into(),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    // `parents[d]` is the block a block at depth `d` nests under.
    let mut parents = vec![page];
    for (nest, pick) in specs {
        let depth = (*nest).min(parents.len() - 1);
        parents.truncate(depth + 1);
        let row = create_block_inner(
            pool,
            DEV,
            mat,
            "content".into(),
            contents[pick % contents.len()].clone(),
            Some(parents[depth].clone()),
            None,
        )
        .await
        .unwrap();
        parents.push(BlockId::from_trusted(row.id.as_str()));
    }
    settle(mat).await;
}

async fn round_trip(specs: Vec<Spec>, encoding: (bool, bool)) -> Result<(), TestCaseError> {
    let db = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let folder = TempDir::new().unwrap();
    let pool = init_pool(&db.path().join("test.db")).await.unwrap();
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    seed(&pool, &mat, data.path(), &specs).await;

    let state = MirrorState::new(data.path().to_path_buf());
    let root = folder.path().to_path_buf();
    set_mirror_folder_inner(&pool, DEV, &state, Some(root.display().to_string()), true)
        .await
        .unwrap();
    let events: Arc<Mutex<Vec<MirrorIngested>>> = Arc::default();
    let seen = Arc::clone(&events);
    let ingest = Ingest {
        pool: pool.clone(),
        materializer: mat.clone(),
        notify: Arc::new(move |event| seen.lock().unwrap().push(event)),
    };
    let mut mirror = Mirror::open(pool.clone(), DEV.to_owned(), state.clone())
        .await
        .unwrap()
        .with_ingest(ingest);
    mirror.tick().await.unwrap();
    settle(&mat).await;
    let all = files(&root);
    prop_assert!(all.len() > 1, "every page is written: {all:?}");
    let written = all.clone();
    // An empty page's file re-saved blank changes nothing to read in (#6506).
    let read_in = written
        .iter()
        .filter(|(_, bytes)| !bytes.is_empty())
        .count();

    let before = op_count(&pool).await;
    for (path, bytes) in &written {
        std::fs::write(root.join(path), re_encoded(bytes, encoding)).unwrap();
    }
    // One tick sees each file changed, the next reads it in.
    for _ in 0..2 {
        mirror.tick().await.unwrap();
        settle(&mat).await;
    }

    let events = events.lock().unwrap().clone();
    prop_assert_eq!(
        events.len(),
        read_in,
        "every file is read back: {:?}",
        events.iter().map(|e| &e.path).collect::<Vec<_>>()
    );
    for event in &events {
        prop_assert!(
            event.op_refs.is_empty(),
            "{} reads back as its page, yet saved {:?}\n{}",
            event.path,
            event.report,
            String::from_utf8_lossy(
                &written
                    .iter()
                    .find(|(path, _)| *path == event.path)
                    .unwrap()
                    .1
            )
        );
    }
    prop_assert_eq!(op_count(&pool).await, before, "no op is appended");
    let status = get_mirror_status_inner(&pool, DEV, &state).await.unwrap();
    prop_assert!(status.diverged.is_empty(), "{:?}", status.diverged);
    prop_assert!(status.failed.is_empty(), "{:?}", status.failed);
    prop_assert_eq!(files(&root), all, "each file is written back as it was");
    Ok(())
}

fn arb_specs() -> impl Strategy<Value = Vec<Spec>> {
    prop::collection::vec((0usize..4, any::<usize>()), 1..24)
}

fn arb_encoding() -> impl Strategy<Value = (bool, bool)> {
    prop_oneof![Just((true, false)), Just((false, true)), Just((true, true))]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(8))]

    #[test]
    fn every_mirrored_file_re_encoded_reads_back_with_no_op(
        specs in arb_specs(),
        encoding in arb_encoding(),
    ) {
        Runtime::new().unwrap().block_on(round_trip(specs, encoding))?;
    }
}
