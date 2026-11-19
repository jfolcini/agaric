//! #6755 — an import that makes a page under `Tag/` makes its tag too, in the
//! same transaction, so a tag's page never lands without its tag: a file, a
//! link stub, a folder ref value's page and a bibliography entry alike. A tag
//! the space already holds is the page's, and a name a new tag cannot take
//! (whitespace) is dashed, title included.

use super::prelude::*;
use agaric_engine::import::{ImportDialect, ImportResult};

async fn fixture() -> (SqlitePool, Materializer, tempfile::TempDir) {
    let (pool, dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;
    (pool, mat, dir)
}

/// `md` imported as the single file `name` into the test space.
async fn import(
    pool: &SqlitePool,
    mat: &Materializer,
    dir: &tempfile::TempDir,
    name: &str,
    md: &str,
) -> ImportResult {
    let result = import_markdown_inner(
        pool,
        DEV,
        mat,
        dir.path(),
        md.into(),
        Some(name.into()),
        TEST_SPACE_ID.into(),
        None,
    )
    .await
    .unwrap();
    settle(mat).await;
    result
}

/// The live tags of the test space, `(id, name)` by name.
async fn tags(pool: &SqlitePool) -> Vec<(String, String)> {
    sqlx::query_as(
        "SELECT id, content FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL \
         AND space_id = ? ORDER BY content",
    )
    .bind(TEST_SPACE_ID)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// The live pages of the test space, by title.
async fn page_titles(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT content FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL \
         AND space_id = ?1 AND id != ?1 ORDER BY content",
    )
    .bind(TEST_SPACE_ID)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// A tag of the test space named `name`, made as the Tags view makes one.
async fn make_tag(pool: &SqlitePool, mat: &Materializer, name: &str) -> String {
    let tag = create_block_inner_with_space(
        pool,
        DEV,
        mat,
        "tag".into(),
        name.into(),
        None,
        None,
        &test_space_scope(),
        None,
    )
    .await
    .unwrap();
    settle(mat).await;
    tag.id.into_string()
}

/// The page the tag `tag` is paired with: asking it for one answers the page
/// already holding its title.
async fn tag_page(pool: &SqlitePool, mat: &Materializer, tag: &str) -> String {
    let page = create_tag_page_inner(pool, DEV, mat, BlockId::from_trusted(tag))
        .await
        .unwrap();
    settle(mat).await;
    page.id.into_string()
}

fn names(tags: &[(String, String)]) -> Vec<&str> {
    tags.iter().map(|(_, name)| name.as_str()).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_titled_under_the_path_makes_its_tag() {
    let (pool, mat, dir) = fixture().await;
    let result = import(&pool, &mat, &dir, "Tag/project.md", "- plan\n").await;
    assert_eq!(result.page_title, "Tag/project");
    assert_eq!(names(&tags(&pool).await), ["project"]);
    assert_eq!(page_titles(&pool).await, ["Tag/project"]);
    let tag = tags(&pool).await.remove(0).0;
    assert_eq!(tag_page(&pool, &mat, &tag).await, result.page_id);
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_under_the_path_pairs_with_the_tag_the_space_holds() {
    let (pool, mat, dir) = fixture().await;
    let tag = make_tag(&pool, &mat, "project").await;
    let result = import(&pool, &mat, &dir, "Tag/Project.md", "- plan\n").await;
    assert_eq!(tags(&pool).await, [(tag.clone(), "project".to_owned())]);
    assert_eq!(page_titles(&pool).await, ["Tag/Project"]);
    assert_eq!(tag_page(&pool, &mat, &tag).await, result.page_id);
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_re_imported_under_the_path_updates_its_page_and_keeps_one_tag() {
    let (pool, mat, dir) = fixture().await;
    let first = import(&pool, &mat, &dir, "Tag/project.md", "- plan\n").await;
    let tag = tags(&pool).await;
    let again = import(&pool, &mat, &dir, "Tag/project.md", "- plan\n- more\n").await;
    assert_eq!(again.page_id, first.page_id);
    assert!(again.merged.is_some(), "the second import merged");
    assert_eq!(tags(&pool).await, tag);
    assert_eq!(page_titles(&pool).await, ["Tag/project"]);
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_link_stub_under_the_path_makes_its_tag() {
    let (pool, mat, dir) = fixture().await;
    import(&pool, &mat, &dir, "Notes.md", "- see [[Tag/idea]]\n").await;
    assert_eq!(names(&tags(&pool).await), ["idea"]);
    assert_eq!(page_titles(&pool).await, ["Notes", "Tag/idea"]);
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_spaced_name_under_the_path_is_dashed_and_re_imports_into_its_page() {
    let (pool, mat, dir) = fixture().await;
    let first = import(&pool, &mat, &dir, "Tag/deep work.md", "- focus\n").await;
    assert_eq!(first.page_title, "Tag/deep-work");
    assert!(
        first.warnings.contains(
            &"the page 'Tag/deep work' was imported as 'Tag/deep-work': a tag name holds no \
              whitespace"
                .to_owned()
        ),
        "{:?}",
        first.warnings
    );
    assert_eq!(names(&tags(&pool).await), ["deep-work"]);
    let again = import(&pool, &mat, &dir, "Tag/deep work.md", "- focus\n").await;
    assert_eq!(again.page_id, first.page_id);
    assert_eq!(names(&tags(&pool).await), ["deep-work"]);
    assert_eq!(page_titles(&pool).await, ["Tag/deep-work"]);
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_spaced_link_stub_under_the_path_is_dashed_once() {
    let (pool, mat, dir) = fixture().await;
    import(
        &pool,
        &mat,
        &dir,
        "Notes.md",
        "- [[Tag/deep work]]\n- [[Tag/deep  work]]\n",
    )
    .await;
    import(&pool, &mat, &dir, "More.md", "- [[Tag/deep work]]\n").await;
    assert_eq!(names(&tags(&pool).await), ["deep-work"]);
    assert_eq!(page_titles(&pool).await, ["More", "Notes", "Tag/deep-work"]);
    mat.shutdown();
}

/// A ref value naming a later note of the folder makes that note's page
/// (#6277 G6), and so its tag.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_ref_value_naming_a_later_note_under_the_path_makes_its_tag() {
    let (pool, mat, dir) = fixture().await;
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
    let paths = vec!["Alpha.md".to_owned(), "Tag/beta.md".to_owned()];
    import_markdown_with_progress(
        &pool,
        DEV,
        &mat,
        dir.path(),
        "milk\n  owner:: [[Tag/beta]]\n".into(),
        Some("Alpha.md".into()),
        TEST_SPACE_ID.into(),
        ImportDialect::Markdown,
        Some(Vec::new()),
        Some(paths),
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;
    assert_eq!(names(&tags(&pool).await), ["beta"]);
    assert_eq!(page_titles(&pool).await, ["Alpha", "Tag/beta"]);
    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bibliography_entry_titled_under_the_path_makes_its_tag() {
    let (pool, mat, _dir) = fixture().await;
    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        r#"[{"id": "Tag/survey", "type": "article", "title": "A Survey"}]"#.into(),
        Some("csl-json".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    settle(&mat).await;
    assert_eq!(result.pages_created, 1, "{:?}", result.warnings);
    assert_eq!(names(&tags(&pool).await), ["survey"]);
    assert_eq!(page_titles(&pool).await, ["Tag/survey"]);
    mat.shutdown();
}

/// A paste names pages as an import does, so its `[[Tag/x]]` link stub brings
/// its tag too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pasted_link_stub_under_the_path_makes_its_tag() {
    use super::page_cmd_tests::{dup_child, dup_page, paste, paste_text};
    let (pool, mat, _dir) = fixture().await;
    let page = dup_page(&pool, &mat, "Notes").await;
    let anchor = dup_child(&pool, &mat, &page, "anchor").await;
    paste(&pool, &mat, &anchor, paste_text("see [[Tag/pasted]]")).await;
    assert_eq!(names(&tags(&pool).await), ["pasted"]);
    assert_eq!(page_titles(&pool).await, ["Notes", "Tag/pasted"]);
    mat.shutdown();
}

/// A re-import into the page `Tag/x` whose tag was deleted brings the tag
/// back, as a first import makes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_re_import_under_the_path_brings_back_a_deleted_tag() {
    let (pool, mat, dir) = fixture().await;
    let first = import(&pool, &mat, &dir, "Tag/project.md", "- plan\n").await;
    let tag = tags(&pool).await.remove(0).0;
    delete_block_inner(&pool, DEV, &mat, BlockId::from_trusted(&tag))
        .await
        .unwrap();
    settle(&mat).await;
    assert_eq!(tags(&pool).await, [], "the tag is deleted");

    let again = import(&pool, &mat, &dir, "Tag/project.md", "- plan\n- more\n").await;

    assert!(again.merged.is_some(), "the second import merged");
    assert_eq!(names(&tags(&pool).await), ["project"]);
    let tag = tags(&pool).await.remove(0).0;
    assert_eq!(tag_page(&pool, &mat, &tag).await, first.page_id);
    mat.shutdown();
}

/// The pages an import will update, listed before it runs, name the page a
/// spaced title under `Tag/` merges into under its dashed title.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_merges_listed_name_the_dashed_page_a_spaced_title_updates() {
    let (pool, mat, dir) = fixture().await;
    let first = import(&pool, &mat, &dir, "Tag/deep work.md", "- focus\n").await;

    let merges = list_import_merges_inner(&pool, TEST_SPACE_ID, vec!["Tag/deep work.md".into()])
        .await
        .unwrap();

    let listed: Vec<(&str, &str)> = merges
        .iter()
        .map(|merge| (merge.page_id.as_str(), merge.title.as_str()))
        .collect();
    assert_eq!(listed, [(first.page_id.as_str(), "Tag/deep-work")]);
    mat.shutdown();
}
