//! #6277 G3 — a page's template flag, a task's done date and where each of
//! its files hangs survive an export restored by a folder import (decision 8).

use crate::prelude::*;
use agaric_engine::import::{ImportDialect, VaultFile};

use super::page_cmd_tests::{
    dup_child, dup_page, dup_storage, page_source, paste, paste_text, save_source, with,
};

const PAGE: &str = "01AAAAAAAAAAAAAAAAAA6277G3";
const TASK: &str = "01AAAAAAAAAAAAAAAAA6277G3T";
const HOLDER: &str = "01AAAAAAAAAAAAAAAAA6277G3H";
const REPORT: &str = "01ATT00000000000000006277R";
const COVER: &str = "01ATT00000000000000006277C";

async fn insert_attachment(pool: &SqlitePool, id: &str, block_id: &str, filename: &str) {
    sqlx::query(
        "INSERT INTO attachments \
         (id, block_id, mime_type, filename, size_bytes, fs_path, created_at) \
         VALUES (?, ?, 'application/pdf', ?, 3, 'attachments/x', 1)",
    )
    .bind(id)
    .bind(block_id)
    .bind(filename)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_property(pool: &SqlitePool, block_id: &str, key: &str, value: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .unwrap();
}

/// A template page holding a task done on 2026-06-01, a block with a file
/// of its own, and a file of the page's own; its export as the ZIP writes
/// it, each `attachment:<id>` link pointing at `assets/<id>/<name>`.
async fn exported_page() -> String {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, PAGE, "page", "Weekly Review", None, Some(1)).await;
    insert_block(
        &pool,
        TASK,
        "content",
        "Close the books",
        Some(PAGE),
        Some(1),
    )
    .await;
    insert_block(
        &pool,
        HOLDER,
        "content",
        "See the report",
        Some(PAGE),
        Some(2),
    )
    .await;
    sqlx::query("UPDATE blocks SET todo_state = 'DONE' WHERE id = ?")
        .bind(TASK)
        .execute(&pool)
        .await
        .unwrap();
    insert_property(&pool, PAGE, "template", "true").await;
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_date) \
         VALUES (?, 'completed_at', '2026-06-01')",
    )
    .bind(TASK)
    .execute(&pool)
    .await
    .unwrap();
    insert_attachment(&pool, REPORT, HOLDER, "report.pdf").await;
    insert_attachment(&pool, COVER, PAGE, "cover.pdf").await;
    agaric_store::cache::rebuild_page_ids(&pool).await.unwrap();

    export_page_markdown_inner(&pool, PAGE)
        .await
        .unwrap()
        .replace(
            &format!("attachment:{REPORT}"),
            &format!("assets/{REPORT}/report.pdf"),
        )
        .replace(
            &format!("attachment:{COVER}"),
            &format!("assets/{COVER}/cover.pdf"),
        )
}

/// The page titled `title` and its live content blocks' ids and texts.
async fn restored(pool: &SqlitePool, title: &str) -> (String, Vec<(String, String)>) {
    let page: String = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL",
    )
    .bind(title)
    .fetch_one(pool)
    .await
    .unwrap();
    let blocks = sqlx::query_as(
        "SELECT id, content FROM blocks WHERE page_id = ?1 AND id != ?1 \
         AND deleted_at IS NULL ORDER BY position, id",
    )
    .bind(&page)
    .fetch_all(pool)
    .await
    .unwrap();
    (page, blocks)
}

async fn property(pool: &SqlitePool, block_id: &str, key: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT COALESCE(value_text, value_date) FROM block_properties \
         WHERE block_id = ? AND key = ?",
    )
    .bind(block_id)
    .bind(key)
    .fetch_optional(pool)
    .await
    .unwrap()
    .flatten()
}

async fn attachment_names(pool: &SqlitePool, block_id: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT filename FROM attachments WHERE block_id = ? AND deleted_at IS NULL")
        .bind(block_id)
        .fetch_all(pool)
        .await
        .unwrap()
}

/// The template flag is front matter, the done date the task's `✅` and each
/// file an `attachments` value at the block it hangs on, so a restore gives
/// a template page, a task done that day, and each file on its block under
/// its own name: no block for a file, no `attachments` property.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restore_keeps_the_template_flag_the_done_date_and_where_each_file_hangs() {
    let md = exported_page().await;
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    let files = vec![
        VaultFile {
            path: format!("assets/{REPORT}/report.pdf"),
            bytes: b"pdf".to_vec().into(),
        },
        VaultFile {
            path: format!("assets/{COVER}/cover.pdf"),
            bytes: b"pdf".to_vec().into(),
        },
    ];
    let result = import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        dir.path(),
        md.clone(),
        Some("Weekly Review.md".into()),
        TEST_SPACE_ID.into(),
        ImportDialect::Markdown,
        Some(files),
        Some(vec!["Weekly Review.md".into()]),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    assert_eq!(result.warnings, Vec::<String>::new(), "export:\n{md}");

    let (page, blocks) = restored(&pool, "Weekly Review").await;
    let texts: Vec<&str> = blocks.iter().map(|(_, text)| text.as_str()).collect();
    assert_eq!(
        texts,
        ["Close the books", "See the report"],
        "export:\n{md}"
    );
    let (task, holder) = (&blocks[0].0, &blocks[1].0);

    assert_eq!(
        property(&pool, &page, "template").await.as_deref(),
        Some("true")
    );
    assert_eq!(
        property(&pool, task, "completed_at").await.as_deref(),
        Some("2026-06-01")
    );
    assert_eq!(attachment_names(&pool, holder).await, ["report.pdf"]);
    assert_eq!(attachment_names(&pool, &page).await, ["cover.pdf"]);
    let stored: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_properties WHERE key = 'attachments'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, 0, "an `attachments` value is never a property");
    mat.shutdown();
}

/// A file an `attachments::` line names that the import does not bring is
/// left out with a warning naming it, never kept as a property.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attachments_line_naming_no_imported_file_is_left_out_with_a_warning() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    let md = "See the report\n  attachments:: [report.pdf](assets/X/report.pdf)\n";
    let result = import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        dir.path(),
        md.into(),
        Some("Lonely.md".into()),
        TEST_SPACE_ID.into(),
        ImportDialect::Markdown,
        Some(vec![VaultFile {
            path: "assets/Y/other.pdf".into(),
            bytes: b"pdf".to_vec().into(),
        }]),
        Some(vec!["Lonely.md".into()]),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    assert_eq!(
        result.warnings,
        ["attachment 'assets/X/report.pdf' was not found among the imported files; left out"]
    );
    let (_, blocks) = restored(&pool, "Lonely").await;
    assert_eq!(blocks.len(), 1);
    assert_eq!(property(&pool, &blocks[0].0, "attachments").await, None);
    assert!(attachment_names(&pool, &blocks[0].0).await.is_empty());
    mat.shutdown();
}

/// Only a file import brings the files an `attachments::` line names, so a
/// paste keeps the line as text, as it keeps a `template::` one: never a
/// property nobody sees.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pasted_attachments_line_stays_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Dest").await;
    let anchor = dup_child(&pool, &mat, &page, "anchor").await;
    settle(&mat).await;

    let rows = paste(
        &pool,
        &mat,
        &anchor,
        paste_text("See it\nattachments:: [report.pdf](assets/X/report.pdf)\n"),
    )
    .await;

    let contents: Vec<Option<&str>> = rows.iter().map(|r| r.content.as_deref()).collect();
    assert_eq!(
        contents,
        [Some(
            "See it\nattachments:: [report.pdf](assets/X/report.pdf)"
        )]
    );
    assert_eq!(
        dup_storage(&pool, &rows[0].id).await,
        ["columns todo=None priority=None scheduled=None due=None"]
    );
}

/// An Edit as Markdown save keeps an `attachments::` line as the block's text.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_attachments_line_saved_from_edit_as_markdown_stays_text() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    let page = dup_page(&pool, &mat, "Buffer").await;
    let body = dup_child(&pool, &mat, &page, "body").await;
    settle(&mat).await;
    let base = page_source(&pool, &page).await;
    let source = with(
        &base,
        &format!("body ^{body}"),
        &format!("body\nattachments:: [report.pdf](report.pdf) ^{body}"),
    );

    save_source(&pool, &mat, &page, &source, &base)
        .await
        .unwrap();
    settle(&mat).await;

    let content: Option<String> = sqlx::query_scalar("SELECT content FROM blocks WHERE id = ?")
        .bind(body.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        content.as_deref(),
        Some("body\nattachments:: [report.pdf](report.pdf)")
    );
    assert_eq!(
        dup_storage(&pool, &body).await,
        ["columns todo=None priority=None scheduled=None due=None"]
    );
}

/// #6277 G6 — a ref value naming a note the same folder pick imports later
/// names that note's page, as a link to it does: the note adopts the page the
/// value made, so the order a pick imports in loses no ref and makes no twin.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_ref_value_naming_a_later_note_names_its_page() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    create_property_def_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "owner".into(),
        "ref".into(),
        None,
    )
    .await
    .unwrap();
    let notes = [
        ("Alpha.md", "milk\n  owner:: [[Ns/Beta]]\n"),
        ("Ns/Beta.md", "eggs\n"),
    ];
    let paths: Vec<String> = notes.iter().map(|(path, _)| (*path).to_string()).collect();
    let mut warnings = Vec::new();
    for (path, md) in notes {
        let result = import_markdown_with_progress(
            &pool,
            DEV,
            &mat,
            dir.path(),
            md.into(),
            Some(path.into()),
            TEST_SPACE_ID.into(),
            ImportDialect::Markdown,
            Some(Vec::new()),
            Some(paths.clone()),
            None,
        )
        .await
        .unwrap();
        settle(&mat).await;
        warnings.extend(result.warnings);
    }

    assert_eq!(warnings, Vec::<String>::new());
    let (beta, beta_blocks) = restored(&pool, "Ns/Beta").await;
    let texts: Vec<&str> = beta_blocks.iter().map(|(_, text)| text.as_str()).collect();
    assert_eq!(texts, ["eggs"], "the note adopted the page its ref made");
    let (_, alpha_blocks) = restored(&pool, "Alpha").await;
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT value_ref FROM block_properties WHERE block_id = ? AND key = 'owner'",
    )
    .bind(&alpha_blocks[0].0)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(owner, Some(beta));
    mat.shutdown();
}

/// #6277 G6 review — a bare ref value naming a later note in a subfolder,
/// `[[Beta]]` for `Ns/Beta.md`, names that note's page, as a bare link does:
/// no empty `Beta` page is left beside it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bare_ref_value_names_a_later_note_in_a_subfolder() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    create_property_def_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "owner".into(),
        "ref".into(),
        None,
    )
    .await
    .unwrap();
    let notes = [
        ("Alpha.md", "milk\n  owner:: [[Beta]]\n"),
        ("Ns/Beta.md", "bread\n"),
    ];
    let paths: Vec<String> = notes.iter().map(|(path, _)| (*path).to_string()).collect();
    for (path, md) in notes {
        import_markdown_with_progress(
            &pool,
            DEV,
            &mat,
            dir.path(),
            md.into(),
            Some(path.into()),
            TEST_SPACE_ID.into(),
            ImportDialect::Markdown,
            Some(Vec::new()),
            Some(paths.clone()),
            None,
        )
        .await
        .unwrap();
        settle(&mat).await;
    }

    let pages: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL \
         AND lower(content) IN ('beta', 'ns/beta')",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(pages, ["Ns/Beta"], "one page for the note");
    let (beta, _) = restored(&pool, "Ns/Beta").await;
    let owners: Vec<Option<String>> =
        sqlx::query_scalar("SELECT value_ref FROM block_properties WHERE key = 'owner'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(owners, [Some(beta)]);
    mat.shutdown();
}

/// #6277 G6 review — two spellings of one later note in a ref value name one
/// page: the note adopts it, and no empty twin is left for either ref.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_spellings_of_a_later_note_in_ref_values_name_one_page() {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    create_property_def_inner(
        &pool,
        DEV,
        &mat,
        TEST_SPACE_ID,
        "owner".into(),
        "ref".into(),
        None,
    )
    .await
    .unwrap();
    let notes = [
        (
            "Alpha.md",
            "milk\n  owner:: [[Ns/Beta]]\n\neggs\n  owner:: [[ns/beta]]\n",
        ),
        ("Ns/Beta.md", "bread\n"),
    ];
    let paths: Vec<String> = notes.iter().map(|(path, _)| (*path).to_string()).collect();
    for (path, md) in notes {
        import_markdown_with_progress(
            &pool,
            DEV,
            &mat,
            dir.path(),
            md.into(),
            Some(path.into()),
            TEST_SPACE_ID.into(),
            ImportDialect::Markdown,
            Some(Vec::new()),
            Some(paths.clone()),
            None,
        )
        .await
        .unwrap();
        settle(&mat).await;
    }

    let pages: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL \
         AND lower(content) = 'ns/beta'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(pages, ["Ns/Beta"], "one page for the note");
    let (beta, _) = restored(&pool, "Ns/Beta").await;
    let owners: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT value_ref FROM block_properties WHERE key = 'owner' ORDER BY block_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(owners, [Some(beta.clone()), Some(beta)]);
    mat.shutdown();
}
