//! #6277 G5 — a file whose title names a page with blocks merges into that
//! page as an Edit as Markdown save writes its buffer (decision 7).

use crate::prelude::*;
use agaric_engine::import::{ImportDialect, ImportResult, VaultFile};

use super::page_cmd_tests::{dup_child, dup_page};

/// `md` imported as `name` into the test space, as a single file is.
async fn import(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
    name: &str,
    md: &str,
) -> Result<ImportResult, AppError> {
    let result = import_markdown_inner(
        pool,
        DEV,
        mat,
        dir,
        md.into(),
        Some(name.into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await;
    settle(mat).await;
    result
}

/// The live pages of the test space titled `title`.
async fn pages_titled(pool: &SqlitePool, title: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL \
         AND content = ? AND space_id = ? ORDER BY id",
    )
    .bind(title)
    .bind(TEST_SPACE_ID)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// A block's id, parent, slot and text.
type StoredBlock = (String, Option<String>, Option<i64>, Option<String>);

/// Everything a re-import may change on `page`: each live block's id,
/// parent, slot and text, its property rows, the links it writes, and the
/// page's aliases.
async fn page_state(pool: &SqlitePool, page: &str) -> Vec<String> {
    let blocks: Vec<StoredBlock> = sqlx::query_as(
        "SELECT id, parent_id, position, content FROM blocks \
         WHERE page_id = ?1 AND id != ?1 AND deleted_at IS NULL ORDER BY id",
    )
    .bind(page)
    .fetch_all(pool)
    .await
    .unwrap();
    let properties: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT p.block_id, p.key, p.value_text FROM block_properties p \
         JOIN blocks b ON b.id = p.block_id WHERE b.page_id = ?1 ORDER BY p.block_id, p.key",
    )
    .bind(page)
    .fetch_all(pool)
    .await
    .unwrap();
    let links: Vec<(String, String)> = sqlx::query_as(
        "SELECT l.source_id, l.target_id FROM block_links l \
         JOIN blocks b ON b.id = l.source_id WHERE b.page_id = ?1 ORDER BY 1, 2",
    )
    .bind(page)
    .fetch_all(pool)
    .await
    .unwrap();
    let aliases: Vec<String> =
        sqlx::query_scalar("SELECT alias FROM page_aliases WHERE page_id = ? ORDER BY alias")
            .bind(page)
            .fetch_all(pool)
            .await
            .unwrap();
    let mut state: Vec<String> = blocks.iter().map(|b| format!("block {b:?}")).collect();
    state.extend(properties.iter().map(|p| format!("property {p:?}")));
    state.extend(links.iter().map(|l| format!("link {l:?}")));
    state.extend(aliases.iter().map(|a| format!("alias {a}")));
    state
}

/// The live contents under `page`, in document order.
async fn contents(pool: &SqlitePool, page: &str) -> Vec<String> {
    let id = BlockId::from_trusted(page);
    super::page_cmd_tests::dup_children(pool, &id)
        .await
        .into_iter()
        .map(|(_, content)| content)
        .collect()
}

/// The live content blocks under `page` as `(id, content)`, in document order.
async fn children(pool: &SqlitePool, page: &str) -> Vec<(String, String)> {
    super::page_cmd_tests::dup_children(pool, &BlockId::from_trusted(page)).await
}

const NOTES: &str = "---\naliases: [nb]\n---\n- see [[Target]]\n  - child #work\n\nlast line\n";

/// Red: importing a file twice leaves one page, its blocks' ids, its aliases
/// and its links as the first import wrote them, and so does importing the
/// page's own export, whose anchor names the block another page refers to.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn importing_a_file_twice_keeps_its_page_ids_aliases_links_and_anchors() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    dup_page(&pool, &mat, "Target").await;
    let first = import(&pool, &mat, dir.path(), "Notes.md", NOTES)
        .await
        .unwrap();
    let before = page_state(&pool, &first.page_id).await;
    assert_eq!(before.iter().filter(|s| s.starts_with("block")).count(), 3);

    let again = import(&pool, &mat, dir.path(), "Notes.md", NOTES)
        .await
        .unwrap();

    assert_eq!(pages_titled(&pool, "Notes").await, [first.page_id.as_str()]);
    assert_eq!(again.page_id, first.page_id, "the import reports that page");
    assert_eq!(page_state(&pool, &first.page_id).await, before);
    assert_eq!(again.warnings, Vec::<String>::new());

    // An anchor is written on a block something addresses (decision 6).
    let (last, _) = children(&pool, &first.page_id).await.pop().unwrap();
    let other = dup_page(&pool, &mat, "Other").await;
    let referrer = dup_child(&pool, &mat, &other, &format!("see (({last}))")).await;
    settle(&mat).await;
    let export = export_page_markdown_inner(&pool, &first.page_id)
        .await
        .unwrap();
    assert!(export.contains(&format!("last line ^{last}")), "{export}");
    let before = page_state(&pool, &first.page_id).await;

    let restored = import(&pool, &mat, dir.path(), "Notes.md", &export)
        .await
        .unwrap();

    assert_eq!(restored.page_id, first.page_id);
    assert_eq!(page_state(&pool, &first.page_id).await, before);
    let content: String = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(referrer.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(content, format!("see (({last}))"));
    mat.shutdown();
}

/// Red: a file edited elsewhere updates its page in place: a line edited
/// between unchanged ones keeps its block, a dropped line goes to the Trash
/// and a new one adds a block.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reimporting_an_edited_file_updates_its_page_in_place() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    let md = "alpha\n\nbeta\n\ngamma\n\ndelta\n";
    let first = import(&pool, &mat, dir.path(), "Log.md", md).await.unwrap();
    let ids: Vec<String> = children(&pool, &first.page_id)
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect();

    let edited = "alpha\n\nbeta edited\n\ngamma\n\nepsilon\n\nzeta\n";
    let result = import(&pool, &mat, dir.path(), "Log.md", edited)
        .await
        .unwrap();

    assert_eq!(pages_titled(&pool, "Log").await, [first.page_id.as_str()]);
    let now = children(&pool, &first.page_id).await;
    let texts: Vec<&str> = now.iter().map(|(_, c)| c.as_str()).collect();
    assert_eq!(texts, ["alpha", "beta edited", "gamma", "epsilon", "zeta"]);
    let kept: Vec<&str> = now[..3].iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(kept, [&ids[0], &ids[1], &ids[2]], "edited in place");
    assert!(
        !ids.contains(&now[3].0) && !ids.contains(&now[4].0),
        "new blocks"
    );
    let trashed: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(&ids[3])
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(trashed.is_some(), "delta went to the Trash");
    assert_eq!(result.page_id, first.page_id);
    assert_eq!(result.blocks_created, 2);
    mat.shutdown();
}

/// Red: the op cap that refuses an oversize Edit as Markdown save refuses an
/// oversize merge, and the page is left as it was.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_oversize_merge_is_refused_by_the_op_cap() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Big").await;
    dup_child(&pool, &mat, &page, "only").await;
    settle(&mat).await;
    let md: String = (0..=pagination::MAX_BATCH_BLOCK_IDS)
        .map(|i| format!("p{i}\n\n"))
        .collect();

    let err = import(&pool, &mat, dir.path(), "Big.md", &md)
        .await
        .unwrap_err();

    assert!(
        matches!(&err, AppError::Validation { message, .. } if message.contains("exceeds maximum")),
        "{err:?}"
    );
    assert_eq!(pages_titled(&pool, "Big").await, [page.as_str().to_owned()]);
    assert_eq!(contents(&pool, page.as_str()).await, ["only"]);
    mat.shutdown();
}

/// Red: a Logseq or Org file does not merge, and makes no twin either: it is
/// the page `Title (2)`, with a warning, and the page of its title is left as
/// it was. A folder's note and a note with files merge into it (#6277 G5).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_logseq_file_is_title_2_and_a_folder_note_or_a_note_with_files_merges() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Plan").await;
    dup_child(&pool, &mat, &page, "kept").await;
    settle(&mat).await;

    let outline = import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        dir.path(),
        "- outline".into(),
        Some("Plan.md".into()),
        TEST_SPACE_ID.into(),
        ImportDialect::LogseqOrg,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(contents(&pool, page.as_str()).await, ["kept"]);
    assert_eq!(outline.page_title, "Plan (2)");
    assert_eq!(contents(&pool, &outline.page_id).await, ["outline"]);
    let why = "a page titled 'Plan' is in this space, and a Logseq or Org file does not \
               merge into it";
    assert_eq!(
        outline.warnings,
        [format!("{why}; the file was imported as 'Plan (2)'")]
    );

    let note = import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        dir.path(),
        "note".into(),
        Some("Plan.md".into()),
        TEST_SPACE_ID.into(),
        ImportDialect::Markdown,
        None,
        Some(Vec::new()),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    assert_eq!(note.page_id, page.as_str());
    assert!(note.merged.is_some());
    assert_eq!(contents(&pool, page.as_str()).await, ["note"]);

    let scan = import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        dir.path(),
        "scan ![[pic.png]]".into(),
        Some("Plan.md".into()),
        TEST_SPACE_ID.into(),
        ImportDialect::Markdown,
        Some(vec![VaultFile {
            path: "pic.png".into(),
            bytes: vec![0x89, b'P', b'N', b'G', 1, 2, 3, 4],
        }]),
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    assert_eq!(scan.page_id, page.as_str());
    assert!(scan.merged.is_some());
    assert_eq!(scan.warnings, Vec::<String>::new());
    let pic: String = sqlx::query_scalar("SELECT id FROM attachments WHERE filename = 'pic.png'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        contents(&pool, page.as_str()).await,
        [format!("scan ![](attachment:{pic})")]
    );
    assert_eq!(
        pages_titled(&pool, "Plan").await,
        [page.as_str().to_owned()]
    );
    mat.shutdown();
}

/// Red: an anchor names the block a line updates, whatever the line says:
/// two blocks that swap places and change their text keep their ids, which
/// only their anchors tell apart (by text they would pair the other way).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_anchored_line_updates_the_block_its_anchor_names() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Anchors").await;
    let alpha = dup_child(&pool, &mat, &page, "alpha").await;
    let beta = dup_child(&pool, &mat, &page, "beta").await;
    settle(&mat).await;

    let md = format!("two ^{beta}\n\none ^{alpha}\n");
    let result = import(&pool, &mat, dir.path(), "Anchors.md", &md)
        .await
        .unwrap();

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(
        children(&pool, page.as_str()).await,
        [
            (beta.as_str().to_owned(), "two".to_owned()),
            (alpha.as_str().to_owned(), "one".to_owned())
        ]
    );
    mat.shutdown();
}

/// One file of an import run, after the files that wrote `run_pages`.
async fn import_in_run(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
    (name, md): (&str, &str),
    run_pages: &[String],
) -> ImportResult {
    let result = import_markdown_in_run(
        pool,
        DEV,
        mat,
        dir,
        md.into(),
        Some(name.into()),
        TEST_SPACE_ID.into(),
        ImportDialect::Markdown,
        None,
        None,
        run_pages,
        None,
    )
    .await
    .unwrap();
    settle(mat).await;
    result
}

/// Red: a title an earlier file of the same run created or merged into is
/// not merged again: two notes called "Meeting" in one run are two pages, the
/// second `Meeting (2)`, with a warning, and the first keeps its blocks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_title_an_earlier_file_of_the_run_wrote_is_imported_as_title_2() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let standup = dup_page(&pool, &mat, "Standup").await;
    dup_child(&pool, &mat, &standup, "old").await;
    settle(&mat).await;
    let dir = dir.path();

    let created = import_in_run(&pool, &mat, dir, ("Meeting.md", "first note"), &[]).await;
    let merged = import_in_run(&pool, &mat, dir, ("Standup.md", "new"), &[]).await;
    let run = [created.page_id.clone(), merged.page_id.clone()];
    let second = import_in_run(&pool, &mat, dir, ("Meeting.md", "second note"), &run).await;
    let again = import_in_run(&pool, &mat, dir, ("Standup.md", "again"), &run).await;

    assert_eq!(merged.page_id, standup.as_str(), "the first Standup merged");
    assert_eq!(contents(&pool, &created.page_id).await, ["first note"]);
    assert_eq!(contents(&pool, standup.as_str()).await, ["new"]);
    assert_eq!(second.page_title, "Meeting (2)");
    assert_eq!(contents(&pool, &second.page_id).await, ["second note"]);
    assert_eq!(again.page_title, "Standup (2)");
    assert_eq!(contents(&pool, &again.page_id).await, ["again"]);
    assert_eq!(
        second.warnings,
        [
            "an earlier file of this import wrote the page 'Meeting'; the file was imported as \
             'Meeting (2)'"
        ]
    );
    assert_eq!((second.merged, again.merged), (None, None));
    mat.shutdown();
}

/// The import dialog's read lists the pages an import of the files merges
/// into: each file's title's page that holds blocks, matched as the import
/// matches it (case-folded, never by alias), once each, in file order.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_import_merges_lists_the_pages_with_blocks_the_files_name() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let plan = dup_page(&pool, &mat, "Plan").await;
    dup_child(&pool, &mat, &plan, "body").await;
    let sub = dup_page(&pool, &mat, "dir/Sub").await;
    dup_child(&pool, &mat, &sub, "body").await;
    dup_page(&pool, &mat, "Empty").await;
    let roadmap = dup_page(&pool, &mat, "Roadmap").await;
    dup_child(&pool, &mat, &roadmap, "body").await;
    set_page_aliases_inner(&pool, DEV, &mat, roadmap.as_str(), vec!["Later".into()])
        .await
        .unwrap();
    settle(&mat).await;
    let files = [
        "dir/Sub.md",
        "Plan.md",
        "plan.md",
        "Empty.md",
        "Later.md",
        "New.md",
    ];

    let merges = list_import_merges_inner(&pool, TEST_SPACE_ID, files.map(String::from).to_vec())
        .await
        .unwrap();

    let listed: Vec<(&str, &str)> = merges
        .iter()
        .map(|m| (m.page_id.as_str(), m.title.as_str()))
        .collect();
    assert_eq!(listed, [(sub.as_str(), "dir/Sub"), (plan.as_str(), "Plan")]);
    mat.shutdown();
}

/// A merge is one undo step, as an Edit as Markdown save is: undoing the ops
/// it reports gives the page back its blocks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn undoing_a_merges_ops_restores_its_page() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Draft").await;
    dup_child(&pool, &mat, &page, "one").await;
    dup_child(&pool, &mat, &page, "two").await;
    settle(&mat).await;
    let before = children(&pool, page.as_str()).await;

    let result = import(&pool, &mat, dir.path(), "Draft.md", "uno\n\nthree\n")
        .await
        .unwrap();
    let ops = result.merged.expect("the file merged into Draft");
    assert_eq!(contents(&pool, page.as_str()).await, ["uno", "three"]);

    undo_ops_inner(&pool, DEV, &mat, ops).await.unwrap();
    settle(&mat).await;

    assert_eq!(children(&pool, page.as_str()).await, before);
    mat.shutdown();
}

/// An anchor naming a block of another page carries no identity on this one:
/// a file whose anchors name another page's blocks, imported twice, pairs its
/// lines by their text the second time and changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_whose_anchors_name_another_page_reimports_unchanged() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let src = dup_page(&pool, &mat, "Src").await;
    let anchored = dup_child(&pool, &mat, &src, "anchored line").await;
    let other = dup_page(&pool, &mat, "Other").await;
    dup_child(&pool, &mat, &other, &format!("see (({anchored}))")).await;
    settle(&mat).await;
    let export = export_page_markdown_inner(&pool, src.as_str())
        .await
        .unwrap();
    assert!(
        export.contains(&format!("anchored line ^{anchored}")),
        "{export}"
    );
    let first = import(&pool, &mat, dir.path(), "Copy.md", &export)
        .await
        .unwrap();
    let before = page_state(&pool, &first.page_id).await;

    let again = import(&pool, &mat, dir.path(), "Copy.md", &export)
        .await
        .unwrap();

    assert_eq!(again.page_id, first.page_id);
    assert_eq!(page_state(&pool, &first.page_id).await, before);
    assert_eq!(again.warnings, Vec::<String>::new());
    assert_eq!(again.merged, Some(Vec::new()), "the merge appended nothing");
    mat.shutdown();
}

/// [`exported_page_with_files_as`] for a template page.
async fn exported_page_with_files(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
) -> (String, String, Vec<VaultFile>) {
    exported_page_with_files_as(pool, mat, dir, true).await
}

/// A page, a template one when `template`, holding a block with a file of
/// its own and an inline image, a file of the page's own and a done task, and
/// its export as the ZIP writes it, with the files at `assets/<id>/<name>`.
/// Returns the page and the export's note and files.
async fn exported_page_with_files_as(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
    template: bool,
) -> (String, String, Vec<VaultFile>) {
    let page = dup_page(pool, mat, "Review").await;
    let holder = dup_child(pool, mat, &page, "See the report").await;
    let task = dup_child(pool, mat, &page, "Close the books").await;
    dup_child(pool, mat, &page, "Notes end").await;
    set_todo_state_inner(
        pool,
        DEV,
        mat,
        task.as_str().to_string().into(),
        Some("DONE".into()),
    )
    .await
    .unwrap();
    if template {
        set_property_inner(
            pool,
            DEV,
            mat,
            page.as_str().to_string().into(),
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
    }
    let attach = |owner: BlockId, name: &'static str, mime: &'static str| async move {
        add_attachment_with_bytes_inner(
            pool,
            DEV,
            mat,
            dir,
            owner,
            name.into(),
            mime.into(),
            name.as_bytes().to_vec(),
        )
        .await
        .unwrap()
        .id
        .into_string()
    };
    attach(holder.clone(), "report.pdf", "application/pdf").await;
    attach(page.clone(), "cover.pdf", "application/pdf").await;
    let image = attach(holder.clone(), "pic.png", "image/png").await;
    edit_block_inner(
        pool,
        DEV,
        mat,
        holder,
        format!("See the report ![pic](attachment:{image})"),
    )
    .await
    .unwrap();
    settle(mat).await;

    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, filename FROM attachments WHERE deleted_at IS NULL")
            .fetch_all(pool)
            .await
            .unwrap();
    let mut md = export_page_markdown_inner(pool, page.as_str())
        .await
        .unwrap();
    let mut files = Vec::new();
    for (id, name) in rows {
        let path = format!("assets/{id}/{name}");
        md = md.replace(&format!("attachment:{id}"), &path);
        files.push(VaultFile {
            path,
            bytes: name.as_bytes().to_vec(),
        });
    }
    (page.into_string(), md, files)
}

/// Each live attachment's owner and file name, sorted.
async fn attachments(pool: &SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT block_id, filename FROM attachments WHERE deleted_at IS NULL ORDER BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

/// `md` imported as a folder's note, carrying `files`.
async fn import_note(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &std::path::Path,
    md: &str,
    files: &[VaultFile],
) -> Result<ImportResult, AppError> {
    let result = import_markdown_with_progress(
        pool,
        DEV,
        mat,
        dir,
        md.into(),
        Some("Review.md".into()),
        TEST_SPACE_ID.into(),
        ImportDialect::Markdown,
        Some(files.to_vec()),
        Some(vec!["Review.md".into()]),
        None,
    )
    .await;
    settle(mat).await;
    result
}

/// Red (#6277 G5): a page's own export re-imported as a lone file merges
/// into it unchanged, its template flag, done date and files included.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reimporting_a_template_pages_export_leaves_it_as_it_was() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _, _) = exported_page_with_files(&pool, &mat, dir.path()).await;
    let md = export_page_markdown_inner(&pool, &page).await.unwrap();
    let before = (page_state(&pool, &page).await, attachments(&pool).await);

    let result = import(&pool, &mat, dir.path(), "Review.md", &md)
        .await
        .unwrap();

    assert_eq!(result.page_id, page);
    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(pages_titled(&pool, "Review").await, [page.as_str()]);
    assert_eq!(
        (page_state(&pool, &page).await, attachments(&pool).await),
        before
    );
    mat.shutdown();
}

/// A file with no `template:` front matter merged onto a template page
/// leaves it a template; `template: false` makes it a page again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_merged_file_changes_the_template_flag_only_when_it_says_so() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _, _) = exported_page_with_files(&pool, &mat, dir.path()).await;
    let flag = || async {
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT value_text FROM block_properties WHERE block_id = ?1 AND key = 'template'",
        )
        .bind(&page)
        .fetch_optional(&pool)
        .await
        .unwrap()
        .flatten()
    };
    assert_eq!(flag().await.as_deref(), Some("true"));

    import(&pool, &mat, dir.path(), "Review.md", "- See the report\n")
        .await
        .unwrap();
    assert_eq!(flag().await.as_deref(), Some("true"));

    let unflagged = "---\ntemplate: false\n---\n- See the report\n";
    import(&pool, &mat, dir.path(), "Review.md", unflagged)
        .await
        .unwrap();
    assert_eq!(flag().await, None);
    mat.shutdown();
}

/// Red (#6277 G5): a page's own export re-imported as a lone file merges into
/// it unchanged when the page holds files, whose `attachments:` front matter
/// and `attachments::` lines a save reads as the app's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reimporting_the_export_of_a_page_with_files_leaves_it_as_it_was() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, _, _) = exported_page_with_files_as(&pool, &mat, dir.path(), false).await;
    let md = export_page_markdown_inner(&pool, &page).await.unwrap();
    assert!(md.contains("attachments: ["), "{md}");
    let before = (page_state(&pool, &page).await, attachments(&pool).await);

    let result = import(&pool, &mat, dir.path(), "Review.md", &md)
        .await
        .unwrap();

    assert_eq!(result.page_id, page);
    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(pages_titled(&pool, "Review").await, [page.as_str()]);
    assert_eq!(
        (page_state(&pool, &page).await, attachments(&pool).await),
        before
    );
    mat.shutdown();
}

/// Red (#6277 G5): an export's note folder-imported back into its space, its
/// files beside it, merges into its page unchanged: the same block ids, the
/// same attachments and no new file, the template flag kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reimporting_an_export_folder_into_its_space_leaves_it_as_it_was() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, md, files) = exported_page_with_files(&pool, &mat, dir.path()).await;
    let before = (page_state(&pool, &page).await, attachments(&pool).await);

    let result = import_note(&pool, &mat, dir.path(), &md, &files)
        .await
        .unwrap();

    assert_eq!(result.warnings, Vec::<String>::new(), "export:\n{md}");
    assert_eq!(pages_titled(&pool, "Review").await, [page.as_str()]);
    assert_eq!(result.page_id, page);
    assert_eq!(
        (page_state(&pool, &page).await, attachments(&pool).await),
        before
    );
    mat.shutdown();
}

/// Red (#6277 G5): an export's note edited elsewhere and folder-imported back
/// updates its page in place, its files kept on their blocks.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reimporting_an_edited_export_folder_updates_its_page_in_place() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, md, files) = exported_page_with_files(&pool, &mat, dir.path()).await;
    let ids: Vec<String> = children(&pool, &page)
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    let files_before = attachments(&pool).await;
    let edited = md.replace("Close the books", "Close the books today") + "\nA new line\n";

    let result = import_note(&pool, &mat, dir.path(), &edited, &files)
        .await
        .unwrap();

    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(pages_titled(&pool, "Review").await, [page.as_str()]);
    let now = children(&pool, &page).await;
    let kept: Vec<&str> = now[..3].iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(kept, [&ids[0], &ids[1], &ids[2]], "edited in place");
    assert_eq!(now[1].1, "Close the books today");
    assert_eq!(now[3].1, "A new line");
    assert_eq!(attachments(&pool).await, files_before);
    mat.shutdown();
}

/// Red (#6277 G5): a file an export's `attachments::` line gains elsewhere is
/// attached to that block when the folder is imported back, the block keeping
/// its id and its text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_added_to_an_attachments_line_is_attached_to_its_block() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, md, mut files) = exported_page_with_files(&pool, &mat, dir.path()).await;
    let before = children(&pool, &page).await;
    let line = md
        .lines()
        .find(|line| line.trim_start().starts_with("attachments::"))
        .unwrap();
    let md = md.replace(line, &format!("{line}, [new.pdf](new.pdf)"));
    files.push(VaultFile {
        path: "new.pdf".into(),
        bytes: b"new".to_vec(),
    });

    let result = import_note(&pool, &mat, dir.path(), &md, &files)
        .await
        .unwrap();

    assert_eq!(result.warnings, Vec::<String>::new(), "file:\n{md}");
    assert_eq!(children(&pool, &page).await, before);
    let holder = &before[0].0;
    let mut names: Vec<String> = attachments(&pool)
        .await
        .into_iter()
        .filter(|(owner, _)| owner == holder)
        .map(|(_, name)| name)
        .collect();
    names.sort();
    assert_eq!(names, ["new.pdf", "pic.png", "report.pdf"]);
    mat.shutdown();
}

/// An `attachments::` line under a new block, which has no `^id`, attaches
/// to that block what the page does not hold yet, and nothing the page holds
/// a second time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attachments_line_under_a_new_block_attaches_only_its_new_file_to_it() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (page, md, mut files) = exported_page_with_files(&pool, &mat, dir.path()).await;
    let held = attachments(&pool).await;
    let line = md
        .lines()
        .find(|line| line.trim_start().starts_with("attachments::"))
        .unwrap();
    let md = md.replace(
        line,
        &format!("{line}\n- Fresh block\n{line}, [new.pdf](new.pdf)"),
    );
    files.push(VaultFile {
        path: "new.pdf".into(),
        bytes: b"new".to_vec(),
    });

    let result = import_note(&pool, &mat, dir.path(), &md, &files)
        .await
        .unwrap();

    assert_eq!(result.warnings, Vec::<String>::new(), "file:\n{md}");
    let kids = children(&pool, &page).await;
    let fresh = kids
        .iter()
        .find(|(_, content)| content.starts_with("Fresh block"))
        .unwrap_or_else(|| panic!("no Fresh block in {kids:?}"))
        .0
        .clone();
    let mut expected = held;
    expected.push((fresh, "new.pdf".into()));
    expected.sort();
    assert_eq!(attachments(&pool).await, expected);
    mat.shutdown();
}

/// Red (#6277 G5): an export merged into another page of its title, its
/// anchors naming the blocks of the page it was exported from, attaches its
/// files to the page it merges into and leaves the other page's as they are.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_export_merged_into_another_page_of_its_title_attaches_its_files_there() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (old, md, files) = exported_page_with_files(&pool, &mat, dir.path()).await;
    edit_block_inner(
        &pool,
        DEV,
        &mat,
        BlockId::from_trusted(&old),
        "Archived".into(),
    )
    .await
    .unwrap();
    let page = dup_page(&pool, &mat, "Review").await;
    dup_child(&pool, &mat, &page, "Elsewhere").await;
    settle(&mat).await;
    let before = attachments(&pool).await;

    let result = import_note(&pool, &mat, dir.path(), &md, &files)
        .await
        .unwrap();

    assert_eq!(result.page_id, page.as_str());
    assert_files_came_to(&pool, page.as_str(), &before).await;
    mat.shutdown();
}

/// Red (#6277 G5): an export of one space merged into another space's page of
/// its title attaches its files there, the first space's blocks unchanged.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_export_merged_into_another_spaces_page_attaches_its_files_there() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let (_, md, files) = exported_page_with_files(&pool, &mat, dir.path()).await;
    let work = create_space_inner(&pool, DEV, &mat, "Work".into(), None)
        .await
        .unwrap();
    let page = create_page_in_space_inner(
        &pool,
        DEV,
        &mat,
        None,
        "Review".into(),
        work.as_str().into(),
    )
    .await
    .unwrap();
    dup_child(&pool, &mat, &page, "Elsewhere").await;
    settle(&mat).await;
    let before = attachments(&pool).await;

    let result = import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        dir.path(),
        md,
        Some("Review.md".into()),
        work.as_str().into(),
        ImportDialect::Markdown,
        Some(files),
        Some(vec!["Review.md".into()]),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(result.page_id, page.as_str());
    assert_files_came_to(&pool, page.as_str(), &before).await;
    mat.shutdown();
}

/// The attachments `before` a merge are as they were, and the merge added the
/// export's three files, each onto `page` or one of its blocks.
async fn assert_files_came_to(pool: &SqlitePool, page: &str, before: &[(String, String)]) {
    let after = attachments(pool).await;
    let kept: Vec<_> = after
        .iter()
        .filter(|row| before.contains(row))
        .cloned()
        .collect();
    assert_eq!(kept, before);
    let mut owners: Vec<String> = children(pool, page)
        .await
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    owners.push(page.to_owned());
    let mut added: Vec<(bool, String)> = after
        .into_iter()
        .filter(|row| !before.contains(row))
        .map(|(owner, name)| (owners.contains(&owner), name))
        .collect();
    added.sort();
    assert_eq!(
        added,
        [
            (true, "cover.pdf".to_owned()),
            (true, "pic.png".to_owned()),
            (true, "report.pdf".to_owned())
        ]
    );
}

/// Red (#6277 G5): a file with an Obsidian `^name` marker and a link to it,
/// imported twice, leaves its page as the first import wrote it: the marker
/// out of the text and the link a ref to its block.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_with_an_obsidian_anchor_reimports_unchanged() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    dup_page(&pool, &mat, "Elsewhere").await;
    let md = "- first ^one\n- see [[#^one]]\n- then [[Notes#^one]]\n";
    let first = import(&pool, &mat, dir.path(), "Notes.md", md)
        .await
        .unwrap();
    let before = page_state(&pool, &first.page_id).await;

    let second = import(&pool, &mat, dir.path(), "Notes.md", md)
        .await
        .unwrap();

    assert_eq!(second.page_id, first.page_id);
    assert_eq!(second.warnings, Vec::<String>::new());
    assert_eq!(page_state(&pool, &first.page_id).await, before);
    mat.shutdown();
}

/// Red (#6277 G5): a merged file's `^name` marker on a new block leaves its
/// text, and the file's links to it become refs to that block.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_merged_files_obsidian_anchor_on_a_new_block_is_its_ref() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Notes").await;
    dup_child(&pool, &mat, &page, "old").await;

    let md = "- old\n- fresh ^two\n- see [[Notes#^two]]\n";
    let result = import(&pool, &mat, dir.path(), "Notes.md", md)
        .await
        .unwrap();

    assert_eq!(result.page_id, page.as_str());
    assert_eq!(result.warnings, Vec::<String>::new());
    let kids = children(&pool, page.as_str()).await;
    let fresh = &kids[1].0;
    let texts: Vec<&str> = kids.iter().map(|(_, text)| text.as_str()).collect();
    assert_eq!(texts, ["old", "fresh", &format!("see (({fresh}))")]);
    mat.shutdown();
}

/// A `^name` on a new block whose text another new block repeats names no
/// one block the save made: its link is a link to the page, with a warning.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_merged_files_obsidian_anchor_on_a_repeated_new_block_links_its_page() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Notes").await;
    dup_child(&pool, &mat, &page, "old").await;

    let md = "- old\n- twin ^two\n- twin\n- see [[#^two]]\n";
    let result = import(&pool, &mat, dir.path(), "Notes.md", md)
        .await
        .unwrap();

    assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
    assert_eq!(
        contents(&pool, page.as_str()).await,
        ["old", "twin", "twin", &format!("see [[{page}]]")]
    );
    mat.shutdown();
}
