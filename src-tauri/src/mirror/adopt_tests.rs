//! Adopting a folder of notes in place (#6540), against a test pool and a
//! temporary folder: each note imported with the folder import, then the
//! folder adopted as the space's mirror folder.

use std::path::PathBuf;
use std::sync::Arc;

use tempfile::TempDir;

use super::super::ingest::Ingest;
use super::super::{Mirror, MirrorState};
use super::*;
use crate::commands::edit_block_inner;
use crate::commands::mirror::{
    adopt_mirror_folder_inner, get_mirror_status_inner, preview_mirror_adoption_inner,
    set_mirror_folder_inner,
};
use crate::commands::pages::import_markdown_inner;
use crate::commands::tests::common::{
    DEV, TEST_SPACE_ID, ensure_test_space, mark_block_as_space, settle,
};
use crate::db::init_pool;
use crate::materializer::Materializer;
use agaric_core::ulid::BlockId;

/// A note as another editor writes it: its own front matter order, `*`
/// bullets, a nested list in four-space indents, and a link to a note the
/// folder does not hold.
const PLAN: &str = "---\ntags: [work]\naliases: [Roadmap]\n---\n* First step\n    * Its detail\n* Second step, see [[Missing note]]\n";

struct Fx {
    pool: SqlitePool,
    mat: Materializer,
    state: MirrorState,
    vault: PathBuf,
    data: PathBuf,
    _dirs: [TempDir; 3],
}

impl Fx {
    /// A vault with the test space, the mirror off, and a folder of notes.
    async fn new(notes: &[(&str, &str)]) -> Self {
        let db = TempDir::new().unwrap();
        let pool = init_pool(&db.path().join("test.db")).await.unwrap();
        let mat = Materializer::new(pool.clone());
        ensure_test_space(&pool).await;
        mark_block_as_space(&pool, TEST_SPACE_ID).await;
        let data = TempDir::new().unwrap();
        let folder = TempDir::new().unwrap();
        for (path, text) in notes {
            let file = folder.path().join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, text).unwrap();
        }
        Self {
            pool,
            mat,
            state: MirrorState::new(data.path().to_path_buf()),
            vault: folder.path().to_path_buf(),
            data: data.path().to_path_buf(),
            _dirs: [db, data, folder],
        }
    }

    fn folder(&self) -> String {
        self.vault.to_str().unwrap().to_owned()
    }

    /// Each of `paths` imported as the folder import imports it.
    async fn import(&self, paths: &[&str]) -> Vec<AdoptFile> {
        let mut files = Vec::new();
        for path in paths {
            let content = std::fs::read_to_string(self.vault.join(path)).unwrap();
            let imported = import_markdown_inner(
                &self.pool,
                DEV,
                &self.mat,
                &self.data,
                content,
                Some((*path).to_owned()),
                TEST_SPACE_ID.to_owned(),
                None,
            )
            .await
            .unwrap();
            files.push(AdoptFile {
                path: (*path).to_owned(),
                page_id: imported.page_id,
            });
        }
        settle(&self.mat).await;
        files
    }

    async fn adopt(&self, files: Vec<AdoptFile>) -> Result<super::super::MirrorStatus, AppError> {
        adopt_mirror_folder_inner(
            &self.pool,
            DEV,
            &self.state,
            self.folder(),
            TEST_SPACE_ID.to_owned(),
            files,
            true,
        )
        .await
    }

    async fn mirror(&self) -> Mirror {
        let ingest = Ingest {
            pool: self.pool.clone(),
            materializer: self.mat.clone(),
            notify: Arc::new(|_| {}),
        };
        Mirror::open(self.pool.clone(), DEV.to_owned(), self.state.clone())
            .await
            .unwrap()
            .with_ingest(ingest)
    }

    async fn ticks(&self, mirror: &mut Mirror, n: usize) {
        for _ in 0..n {
            settle(&self.mat).await;
            mirror.tick().await.unwrap();
            settle(&self.mat).await;
        }
    }

    /// Every file below the vault, hidden ones left out, with its text.
    fn files(&self) -> BTreeMap<String, String> {
        let mut found = Vec::new();
        files_below(&self.vault, &self.vault, &mut found).unwrap();
        found
            .into_iter()
            .map(|path| {
                let text = std::fs::read_to_string(self.vault.join(&path)).unwrap();
                (path, text)
            })
            .collect()
    }

    async fn first_block(&self, page_id: &str) -> String {
        sqlx::query_scalar!(
            r#"SELECT id AS "id!: String" FROM blocks
                WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position LIMIT 1"#,
            page_id,
        )
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn adopting_a_folder_rewrites_moves_and_adds_no_file() {
    let fx = Fx::new(&[
        ("Projects/Plan.md", PLAN),
        ("Inbox.md", "A loose thought\n"),
        // A name the mirror would write as `Why_.md`: it stays as it is.
        ("Why?.md", "A question\n"),
        ("diagram.png", "not really a png"),
    ])
    .await;
    let files = fx
        .import(&["Projects/Plan.md", "Inbox.md", "Why?.md"])
        .await;
    let before = fx.files();
    let status = fx.adopt(files).await.unwrap();
    assert_eq!(status.adopted_space.as_deref(), Some(TEST_SPACE_ID));
    let mut mirror = fx.mirror().await;
    fx.ticks(&mut mirror, 3).await;
    // No file for the page the link to a missing note created, and none of
    // the space folder a mirror of space folders would write.
    assert_eq!(fx.files(), before);
    assert_eq!(
        get_mirror_status_inner(&fx.pool, DEV, &fx.state)
            .await
            .unwrap()
            .diverged,
        Vec::new()
    );
}

#[tokio::test]
async fn an_edit_in_agaric_rewrites_only_its_lines_of_an_adopted_file() {
    let fx = Fx::new(&[("Projects/Plan.md", PLAN)]).await;
    let files = fx.import(&["Projects/Plan.md"]).await;
    let page = files[0].page_id.clone();
    fx.adopt(files).await.unwrap();
    let mut mirror = fx.mirror().await;
    fx.ticks(&mut mirror, 2).await;
    let first = fx.first_block(&page).await;
    edit_block_inner(
        &fx.pool,
        DEV,
        &fx.mat,
        BlockId::from_trusted(&first),
        "First step, done".into(),
    )
    .await
    .unwrap();
    fx.ticks(&mut mirror, 2).await;
    assert_eq!(
        fx.files()["Projects/Plan.md"],
        // The edited block's line in Agaric's form; every other line as written.
        PLAN.replace("* First step\n", "- First step, done\n")
    );
}

#[tokio::test]
async fn a_renamed_page_renames_its_adopted_file_in_its_folder() {
    let fx = Fx::new(&[("Projects/Plan.md", PLAN)]).await;
    let files = fx.import(&["Projects/Plan.md"]).await;
    let page = files[0].page_id.clone();
    fx.adopt(files).await.unwrap();
    let mut mirror = fx.mirror().await;
    fx.ticks(&mut mirror, 2).await;
    let rename = |title: &'static str| {
        edit_block_inner(
            &fx.pool,
            DEV,
            &fx.mat,
            BlockId::from_trusted(&page),
            title.into(),
        )
    };
    rename("Projects/Roadmap 2027").await.unwrap();
    fx.ticks(&mut mirror, 2).await;
    // Renamed where it is, with the user's own bytes.
    let files = fx.files();
    assert_eq!(files.get("Projects/Plan.md"), None);
    assert_eq!(files["Projects/Roadmap 2027.md"], PLAN);
    // Its namespace changed: it moves to the path the mirror names.
    rename("Archive/Roadmap 2027").await.unwrap();
    fx.ticks(&mut mirror, 2).await;
    let files = fx.files();
    assert_eq!(files.get("Projects/Roadmap 2027.md"), None);
    assert_eq!(files["Archive/Roadmap 2027.md"], PLAN);
}

#[tokio::test]
async fn an_outside_edit_to_an_adopted_file_is_read_into_its_page() {
    let fx = Fx::new(&[("Inbox.md", "A loose thought\n")]).await;
    let files = fx.import(&["Inbox.md"]).await;
    let page = files[0].page_id.clone();
    fx.adopt(files).await.unwrap();
    let mut mirror = fx.mirror().await;
    fx.ticks(&mut mirror, 2).await;
    std::fs::write(fx.vault.join("Inbox.md"), "A loose thought, kept\n").unwrap();
    fx.ticks(&mut mirror, 3).await;
    let first = fx.first_block(&page).await;
    let content = sqlx::query_scalar!("SELECT content FROM blocks WHERE id = ?", first)
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    assert_eq!(content.as_deref(), Some("A loose thought, kept"));
}

#[tokio::test]
async fn a_note_no_page_took_is_left_alone_until_it_changes() {
    let fx = Fx::new(&[
        ("Inbox.md", "A loose thought\n"),
        ("Skipped.md", "Not imported\n"),
    ])
    .await;
    let files = fx.import(&["Inbox.md"]).await;
    fx.adopt(files).await.unwrap();
    let mut mirror = fx.mirror().await;
    fx.ticks(&mut mirror, 3).await;
    let titles = || async {
        list_all_pages_in_space_inner(&fx.pool, TEST_SPACE_ID, None)
            .await
            .unwrap()
            .into_iter()
            .filter_map(|page| page.content)
            .collect::<Vec<_>>()
    };
    assert!(!titles().await.contains(&"Skipped".to_owned()));
    // Changed, it is a new note, read onto a page of the adopted space.
    std::fs::write(fx.vault.join("Skipped.md"), "Now wanted\n").unwrap();
    fx.ticks(&mut mirror, 3).await;
    assert!(titles().await.contains(&"Skipped".to_owned()));
}

#[tokio::test]
async fn the_preview_shows_what_a_later_write_changes_and_what_is_left_alone() {
    // An Obsidian `^id` marker no block refers to: the import takes it out of
    // its block's text, so Agaric writes the line without it.
    let messy = "A thought ^abc123\n";
    let fx = Fx::new(&[
        ("Clean.md", "A loose thought\n"),
        ("Messy.md", messy),
        ("notes.org", "* An org note\n"),
        ("Skipped.md", "Not imported\n"),
    ])
    .await;
    let files = fx.import(&["Clean.md", "Messy.md"]).await;
    let preview = preview_mirror_adoption_inner(
        &fx.pool,
        DEV,
        &fx.state,
        fx.folder(),
        TEST_SPACE_ID.to_owned(),
        files,
    )
    .await
    .unwrap();
    assert_eq!(
        preview
            .changes
            .iter()
            .map(|c| c.path.as_str())
            .collect::<Vec<_>>(),
        ["Messy.md"]
    );
    assert_eq!(preview.changes[0].before, messy);
    assert_ne!(preview.changes[0].after, messy);
    assert_eq!(preview.left_alone, ["Skipped.md", "notes.org"]);
}

#[tokio::test]
async fn adoption_refuses_a_file_outside_the_folder_and_a_mirror_already_on() {
    let fx = Fx::new(&[("Inbox.md", "A loose thought\n")]).await;
    let files = fx.import(&["Inbox.md"]).await;
    let page_id = files[0].page_id.clone();
    let escaping = vec![AdoptFile {
        path: "../Inbox.md".into(),
        page_id: page_id.clone(),
    }];
    assert!(matches!(
        fx.adopt(escaping).await,
        Err(AppError::Validation { message: why, .. }) if why.contains("no Markdown file of the folder")
    ));
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
    assert!(matches!(
        fx.adopt(files).await,
        Err(AppError::Validation { message: why, .. }) if why.contains("turn the mirror off")
    ));
}

#[tokio::test]
async fn turning_the_mirror_off_gives_an_adopted_folder_back() {
    let fx = Fx::new(&[("Inbox.md", "A loose thought\n")]).await;
    let files = fx.import(&["Inbox.md"]).await;
    fx.adopt(files).await.unwrap();
    assert!(fx.vault.join(store::MARKER_NAME).exists());
    let status = set_mirror_folder_inner(&fx.pool, DEV, &fx.state, None, true)
        .await
        .unwrap();
    assert_eq!(status.adopted_space, None);
    assert!(!fx.vault.join(store::MARKER_NAME).exists());
    // Never then taken for a folder of space folders, whose layout moves files.
    assert!(matches!(
        set_mirror_folder_inner(&fx.pool, DEV, &fx.state, Some(fx.folder()), true).await,
        Err(AppError::Validation { message: why, .. }) if why.contains("must be empty")
    ));
}

#[tokio::test]
async fn an_adopted_file_deleted_outside_agaric_moves_its_page_to_the_trash() {
    let fx = Fx::new(&[("Inbox.md", "A loose thought\n"), ("Other.md", "Kept\n")]).await;
    let files = fx.import(&["Inbox.md", "Other.md"]).await;
    let page = files[0].page_id.clone();
    fx.adopt(files).await.unwrap();
    let mut mirror = fx.mirror().await;
    fx.ticks(&mut mirror, 2).await;
    std::fs::remove_file(fx.vault.join("Inbox.md")).unwrap();
    fx.ticks(&mut mirror, 5).await;
    let deleted = sqlx::query_scalar!("SELECT deleted_at FROM blocks WHERE id = ?", page)
        .fetch_one(&fx.pool)
        .await
        .unwrap();
    assert!(deleted.is_some(), "the page is in the Trash");
    assert_eq!(
        fx.files().get("Inbox.md"),
        None,
        "and its file is not written again"
    );
}
