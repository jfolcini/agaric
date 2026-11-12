//! Copies of attachments in the mirror's folder (#5363 setting 3): the names
//! they take, which folders are copies', how a page links them, and what the
//! mirror's ticks write, remove and read back with copying on and off.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sqlx::SqlitePool;
use tempfile::TempDir;

use super::*;
use crate::commands::attachments::{
    add_attachment_with_bytes_inner, delete_attachment_inner, rename_attachment_inner,
};
use crate::commands::mirror::{
    get_mirror_status_inner, set_mirror_copy_files_inner, set_mirror_folder_inner,
};
use crate::commands::tests::common::{
    DEV, TEST_SPACE_ID, ensure_test_space, mark_block_as_space, settle,
};
use crate::commands::{create_block_inner, create_page_in_space_inner, edit_block_inner};
use crate::db::init_pool;
use crate::materializer::Materializer;
use crate::mirror::ingest::Ingest;
use crate::mirror::{Mirror, MirrorState, MirrorStatus};
use agaric_core::ulid::{AttachmentId, BlockId};

#[derive(serde::Deserialize)]
struct AssetNameCase {
    name: String,
    filename: String,
    asset: String,
}

/// The rows `src/lib/__tests__/asset-names.test.ts` asserts of the export's
/// `assetName`.
#[test]
fn asset_names_match_the_export_vectors() {
    #[derive(serde::Deserialize)]
    struct Vectors {
        cases: Vec<AssetNameCase>,
    }
    let vectors: Vectors = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../conformance/asset-names.vectors.json"
    )))
    .expect("the vectors parse");
    assert!(vectors.cases.len() > 20, "every row is read");
    for case in vectors.cases {
        assert_eq!(asset_name(&case.filename), case.asset, "{}", case.name);
    }
}

#[test]
fn only_a_space_folders_assets_id_folder_holds_a_copy() {
    let id = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
    assert!(is_copy_dir(Path::new(&format!("Space/assets/{id}"))));
    for not in [
        format!("assets/{id}"),
        format!("Space/assets/{id}/deeper"),
        format!("Space/notes/{id}"),
        "Space/assets/x".to_owned(),
        "Space/assets".to_owned(),
        format!("Space/assets/{}", id.to_lowercase()),
        "Space/assets/01HZZZZZZZZZZZZZZZZZZZZZZI".to_owned(),
    ] {
        assert!(!is_copy_dir(Path::new(&not)), "{not}");
    }
}

fn file(text: &str) -> PageFile {
    PageFile {
        text: text.to_owned(),
        line_ids: vec![None; text.split('\n').count()],
        buffer: String::new(),
    }
}

#[test]
fn a_page_links_each_copy_from_its_own_depth_and_the_rest_as_rendered() {
    let id = "01HAAAAAAAAAAAAAAAAAAAAAAA";
    let other = "01HBBBBBBBBBBBBBBBBBBBBBBB";
    let copies = || {
        HashMap::from([
            (id.to_owned(), format!("assets/{id}/cat.png")),
            (other.to_owned(), format!("assets/{other}/my file (1).pdf")),
        ])
    };
    let text = format!(
        "![a cat](attachment:{id})\n\n[doc](attachment:{other})\n\n[gone](attachment:01HCCCCCCCCCCCCCCCCCCCCCCC)\n"
    );

    let top = Links::for_page("Space/Alpha.md", copies()).localize(file(&text));
    assert_eq!(
        top.text,
        format!(
            "![a cat](assets/{id}/cat.png)\n\n[doc](<assets/{other}/my file (1).pdf>)\n\n[gone](attachment:01HCCCCCCCCCCCCCCCCCCCCCCC)\n"
        )
    );
    assert_eq!(
        top.line_ids.len(),
        top.text.split('\n').count(),
        "lines kept"
    );

    let nested = Links::for_page("Space/A/B/Gamma.md", copies()).localize(file(&text));
    assert!(
        nested
            .text
            .starts_with(&format!("![a cat](../../assets/{id}/cat.png)")),
        "{}",
        nested.text
    );
    assert_eq!(
        Links::default().localize(file(&text)).text,
        text,
        "no copies, no change"
    );
}

#[test]
fn linked_lists_each_attachment_once_in_order() {
    let a = "01HAAAAAAAAAAAAAAAAAAAAAAA";
    let b = "01HBBBBBBBBBBBBBBBBBBBBBBB";
    let text =
        format!("[x](attachment:{b}) ![y](attachment:{a}) [z](attachment:{b}) attachment:{a}");
    assert_eq!(linked(&text), [b, a]);
}

// ── The mirror's ticks ──────────────────────────────────────────────────

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot really an image";

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
    /// A vault with the test space, and the mirror on, reading back, with
    /// copying set to `copy_files`, or left unset with `None`.
    async fn new(copy_files: Option<bool>) -> Self {
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
        if let Some(on) = copy_files {
            set_mirror_copy_files_inner(&pool, DEV, &state, on)
                .await
                .unwrap();
        }
        let ingest = Ingest {
            pool: pool.clone(),
            materializer: mat.clone(),
            notify: Arc::new(|_| {}),
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
            data: data.path().to_path_buf(),
            _dirs: [db, data, folder],
        }
    }

    async fn page(&self, title: &str) -> String {
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
        .into_string()
    }

    async fn block(&self, page: &str, content: &str) -> String {
        create_block_inner(
            &self.pool,
            DEV,
            &self.mat,
            "content".into(),
            content.into(),
            Some(BlockId::from_trusted(page)),
            None,
        )
        .await
        .unwrap()
        .id
        .into_string()
    }

    /// A page `title` with one block holding an image of `bytes` named
    /// `filename`, linked inline. Returns the page, the block and the
    /// attachment.
    async fn page_with_image(
        &self,
        title: &str,
        filename: &str,
        bytes: &[u8],
    ) -> (String, String, String) {
        let page = self.page(title).await;
        let block = self.block(&page, "image").await;
        let attachment = add_attachment_with_bytes_inner(
            &self.pool,
            DEV,
            &self.mat,
            &self.data,
            BlockId::from_trusted(&block),
            filename.into(),
            "image/png".into(),
            bytes.to_vec(),
        )
        .await
        .unwrap()
        .id
        .into_string();
        self.edit(&block, &format!("![a picture](attachment:{attachment})"))
            .await;
        (page, block, attachment)
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

    async fn ticks(&mut self, n: usize) {
        for _ in 0..n {
            self.tick().await;
        }
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.root.join(path)).ok()
    }

    fn text(&self, path: &str) -> String {
        String::from_utf8(self.read(path).unwrap()).unwrap()
    }

    async fn copy_files(&self, on: bool) {
        set_mirror_copy_files_inner(&self.pool, DEV, &self.state, on)
            .await
            .unwrap();
    }

    async fn status(&self) -> MirrorStatus {
        get_mirror_status_inner(&self.pool, DEV, &self.state)
            .await
            .unwrap()
    }

    async fn content(&self, block: &str) -> String {
        sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
            .bind(block)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn pages_titled(&self, title: &str) -> usize {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM blocks
              WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL",
        )
        .bind(title)
        .fetch_one(&self.pool)
        .await
        .unwrap()
        .try_into()
        .unwrap()
    }
}

fn copy_of(attachment: &str, name: &str) -> String {
    format!("TestSpace/assets/{attachment}/{name}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copying_is_off_by_default_and_a_page_keeps_its_attachment_link() {
    let mut fx = Fx::new(None).await;
    let (_, _, attachment) = fx.page_with_image("Alpha", "cat.png", PNG).await;
    fx.tick().await;

    assert!(!fx.root.join("TestSpace/assets").exists(), "nothing copied");
    assert!(
        fx.text("TestSpace/Alpha.md")
            .contains(&format!("(attachment:{attachment})")),
        "{}",
        fx.text("TestSpace/Alpha.md")
    );
    assert!(!fx.status().await.copy_files);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copying_on_copies_each_linked_attachment_and_links_the_page_to_it() {
    let mut fx = Fx::new(Some(true)).await;
    let (_, _, attachment) = fx.page_with_image("Alpha", "cat.png", PNG).await;
    fx.tick().await;

    let copy = copy_of(&attachment, "cat.png");
    assert_eq!(fx.read(&copy).as_deref(), Some(PNG), "the bytes are copied");
    assert!(
        fx.text("TestSpace/Alpha.md")
            .contains(&format!("![a picture](assets/{attachment}/cat.png)")),
        "{}",
        fx.text("TestSpace/Alpha.md")
    );
    let status = fx.status().await;
    assert!(status.copy_files);
    assert!(
        status.diverged.is_empty() && status.failed.is_empty(),
        "{status:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_or_changed_copy_is_written_again() {
    let mut fx = Fx::new(Some(true)).await;
    let (_, block, attachment) = fx.page_with_image("Alpha", "cat.png", PNG).await;
    fx.tick().await;
    let copy = copy_of(&attachment, "cat.png");

    std::fs::remove_file(fx.root.join(&copy)).unwrap();
    fx.edit(&block, &format!("![renamed](attachment:{attachment})"))
        .await;
    fx.tick().await;
    assert_eq!(fx.read(&copy).as_deref(), Some(PNG), "a missing copy");

    std::fs::write(fx.root.join(&copy), b"scribbled over").unwrap();
    fx.state.restart();
    fx.tick().await;
    assert_eq!(fx.read(&copy).as_deref(), Some(PNG), "a changed copy");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_copying_off_removes_unchanged_copies_and_lists_a_changed_one() {
    let mut fx = Fx::new(Some(true)).await;
    let (_, _, kept) = fx.page_with_image("Alpha", "cat.png", PNG).await;
    let (_, _, gone) = fx.page_with_image("Beta", "dog.png", b"woof").await;
    fx.tick().await;
    std::fs::write(fx.root.join(copy_of(&kept, "cat.png")), b"edited").unwrap();

    fx.copy_files(false).await;
    fx.tick().await;

    assert!(
        !fx.root.join(format!("TestSpace/assets/{gone}")).exists(),
        "the unchanged copy and its folder go"
    );
    assert_eq!(
        fx.read(&copy_of(&kept, "cat.png")).as_deref(),
        Some(&b"edited"[..]),
        "the changed copy stays"
    );
    let paths: Vec<String> = fx
        .status()
        .await
        .diverged
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(paths, [copy_of(&kept, "cat.png")], "and is listed");
    assert!(
        fx.text("TestSpace/Alpha.md")
            .contains(&format!("(attachment:{kept})")),
        "the page links its attachment again: {}",
        fx.text("TestSpace/Alpha.md")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_removed_attachments_copy_is_removed() {
    let mut fx = Fx::new(Some(true)).await;
    let (_, _, attachment) = fx.page_with_image("Alpha", "cat.png", PNG).await;
    fx.tick().await;
    assert!(fx.read(&copy_of(&attachment, "cat.png")).is_some());

    delete_attachment_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        &fx.data,
        AttachmentId::from_trusted(&attachment),
    )
    .await
    .unwrap();
    fx.tick().await;

    assert!(
        !fx.root
            .join(format!("TestSpace/assets/{attachment}"))
            .exists(),
        "the copy goes with its attachment"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_beside_a_link_to_a_copy_keeps_the_attachment_link() {
    let mut fx = Fx::new(Some(true)).await;
    let (page, block, attachment) = fx.page_with_image("Alpha", "cat.png", PNG).await;
    fx.block(&page, "words").await;
    fx.tick().await;
    let written = fx.text("TestSpace/Alpha.md");

    std::fs::write(
        fx.root.join("TestSpace/Alpha.md"),
        written.replace("words", "other words"),
    )
    .unwrap();
    fx.ticks(2).await;

    assert_eq!(
        fx.content(&block).await,
        format!("![a picture](attachment:{attachment})"),
        "the link to the copy reads back as the attachment's"
    );
    assert_eq!(
        fx.text("TestSpace/Alpha.md"),
        written.replace("words", "other words"),
        "the file keeps its link to the copy"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_in_a_copy_folder_is_never_read_and_a_page_below_assets_is() {
    let mut fx = Fx::new(Some(true)).await;
    let (_, _, attachment) = fx
        .page_with_image("Alpha", "notes.md", b"- not a page\n")
        .await;
    fx.tick().await;
    assert!(fx.read(&copy_of(&attachment, "notes.md")).is_some());
    std::fs::write(
        fx.root
            .join(format!("TestSpace/assets/{attachment}/other.md")),
        "- nor this\n",
    )
    .unwrap();
    std::fs::write(fx.root.join("TestSpace/assets/x.md"), "- a page\n").unwrap();
    fx.ticks(3).await;

    assert_eq!(
        fx.pages_titled(&format!("assets/{attachment}/notes")).await,
        0
    );
    assert_eq!(
        fx.pages_titled(&format!("assets/{attachment}/other")).await,
        0
    );
    assert_eq!(
        fx.pages_titled("assets/x").await,
        1,
        "a page below assets/ is read"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_renamed_attachment_is_linked_at_its_new_copy_and_its_old_one_goes() {
    let mut fx = Fx::new(Some(true)).await;
    let (_, _, attachment) = fx.page_with_image("Alpha", "zebra.png", PNG).await;
    fx.tick().await;
    assert!(fx.read(&copy_of(&attachment, "zebra.png")).is_some());

    rename_attachment_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        AttachmentId::from_trusted(&attachment),
        "apple.png".into(),
    )
    .await
    .unwrap();
    fx.state.restart();
    fx.tick().await;

    assert_eq!(
        fx.read(&copy_of(&attachment, "apple.png")).as_deref(),
        Some(PNG)
    );
    assert!(
        fx.read(&copy_of(&attachment, "zebra.png")).is_none(),
        "the old name's copy goes"
    );
    assert!(
        fx.text("TestSpace/Alpha.md")
            .contains(&format!("(assets/{attachment}/apple.png)")),
        "the page links the copy that is there: {}",
        fx.text("TestSpace/Alpha.md")
    );
}
