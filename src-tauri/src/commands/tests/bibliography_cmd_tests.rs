//! Tests for `import_bibliography_inner` (#1454 tier a) — BibTeX / CSL-JSON
//! bibliography import as reference pages with typed properties.
//!
//! Pure-parser unit tests live in `crate::bibliography`; these exercise the
//! transactional apply: page creation, typed property stamping, dedup /
//! idempotence, title collisions, chunking, and space validation.

use super::super::*;
use super::common::*;
use crate::error::AppError;
use crate::materializer::Materializer;

/// One property row read back for assertions (columns mirror
/// `block_properties`).
#[derive(sqlx::FromRow, Debug)]
struct PropRow {
    key: String,
    value_text: Option<String>,
    value_num: Option<f64>,
}

async fn page_id_by_title(pool: &sqlx::SqlitePool, title: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT id FROM blocks WHERE block_type = 'page' AND content = ? AND deleted_at IS NULL",
    )
    .bind(title)
    .fetch_optional(pool)
    .await
    .unwrap()
}

async fn props_of(
    pool: &sqlx::SqlitePool,
    page_id: &str,
) -> std::collections::HashMap<String, PropRow> {
    let rows: Vec<PropRow> = sqlx::query_as(
        "SELECT key, value_text, value_num FROM block_properties \
         WHERE block_id = ? AND key != 'space' ORDER BY key",
    )
    .bind(page_id)
    .fetch_all(pool)
    .await
    .unwrap();
    rows.into_iter().map(|r| (r.key.clone(), r)).collect()
}

async fn count_pages_in_space(pool: &sqlx::SqlitePool, space_id: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM blocks \
         WHERE block_type = 'page' AND deleted_at IS NULL AND space_id = ? AND id != ?",
    )
    .bind(space_id)
    .bind(space_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

const TWO_ENTRY_BIBTEX: &str = r"
@article{doe2020,
  title    = {A Study of Things},
  author   = {Doe, Jane and Smith, John},
  year     = {2020},
  doi      = {10.1000/xyz},
  url      = {https://example.org/paper},
  journal  = {Journal of Tests},
  abstract = {We test things.},
}

@book{smith2021,
  title  = {Another Work},
  author = {Smith, John},
  year   = {2021},
}
";

// ======================================================================
// happy paths
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_bibtex_happy_path_creates_typed_pages_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        TWO_ENTRY_BIBTEX.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();

    assert_eq!(result.pages_created, 2, "warnings: {:?}", result.warnings);
    assert_eq!(result.entries_skipped, 0);
    // Entry 1 sets all 8 properties; entry 2 sets citation-key,
    // reference-type, authors, year = 4.
    assert_eq!(result.properties_set, 12, "warnings: {:?}", result.warnings);
    assert!(
        result.warnings.is_empty(),
        "clean input must import warning-free: {:?}",
        result.warnings
    );

    // Page titles are citation display names: "{family} {year}".
    let doe = page_id_by_title(&pool, "Doe 2020")
        .await
        .expect("Doe 2020 page");
    let smith = page_id_by_title(&pool, "Smith 2021")
        .await
        .expect("Smith 2021 page");

    let doe_props = props_of(&pool, &doe).await;
    assert_eq!(
        doe_props["citation-key"].value_text.as_deref(),
        Some("doe2020")
    );
    assert_eq!(
        doe_props["reference-type"].value_text.as_deref(),
        Some("article")
    );
    assert_eq!(
        doe_props["authors"].value_text.as_deref(),
        Some("Doe, Jane; Smith, John"),
        "authors must be '; '-joined"
    );
    assert_eq!(
        doe_props["year"].value_num,
        Some(2020.0),
        "year must land in value_num (declared 'number'): {doe_props:?}"
    );
    assert_eq!(doe_props["doi"].value_text.as_deref(), Some("10.1000/xyz"));
    assert_eq!(
        doe_props["url"].value_text.as_deref(),
        Some("https://example.org/paper")
    );
    assert_eq!(
        doe_props["journal"].value_text.as_deref(),
        Some("Journal of Tests")
    );
    assert_eq!(
        doe_props["abstract"].value_text.as_deref(),
        Some("We test things.")
    );

    let smith_props = props_of(&pool, &smith).await;
    assert_eq!(
        smith_props["citation-key"].value_text.as_deref(),
        Some("smith2021")
    );
    assert_eq!(
        smith_props["reference-type"].value_text.as_deref(),
        Some("book")
    );
    assert!(
        !smith_props.contains_key("doi"),
        "absent fields set nothing"
    );

    // Pages live in the target space.
    let space: Option<String> = sqlx::query_scalar("SELECT space_id FROM blocks WHERE id = ?")
        .bind(&doe)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(space.as_deref(), Some(TEST_SPACE_ID));

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_csl_json_happy_path_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let csl = r#"[
      {
        "id": "doe2020",
        "type": "article-journal",
        "title": "A Study of Things",
        "author": [{"family": "Doe", "given": "Jane"}],
        "issued": {"date-parts": [[2020, 4]]},
        "DOI": "10.1000/xyz",
        "URL": "https://example.org/paper",
        "container-title": "Journal of Tests",
        "abstract": "We test things."
      }
    ]"#;

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        csl.into(),
        Some("csl-json".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();

    assert_eq!(result.pages_created, 1, "warnings: {:?}", result.warnings);
    assert_eq!(result.properties_set, 8);

    let page = page_id_by_title(&pool, "Doe 2020")
        .await
        .expect("Doe 2020 page");
    let props = props_of(&pool, &page).await;
    assert_eq!(props["citation-key"].value_text.as_deref(), Some("doe2020"));
    assert_eq!(
        props["reference-type"].value_text.as_deref(),
        Some("article-journal")
    );
    assert_eq!(props["authors"].value_text.as_deref(), Some("Doe, Jane"));
    assert_eq!(props["year"].value_num, Some(2020.0));
    assert_eq!(
        props["journal"].value_text.as_deref(),
        Some("Journal of Tests"),
        "container-title must map to journal"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_auto_detects_both_formats_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // Leading '@' → BibTeX.
    let bib = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        "@misc{auto1, title={Auto Bib}, author={Doe, J.}, year={2001}}".into(),
        None,
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(bib.pages_created, 1, "warnings: {:?}", bib.warnings);
    assert!(page_id_by_title(&pool, "Doe 2001").await.is_some());

    // Leading '[' → CSL-JSON.
    let csl = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        r#"[{"id": "auto2", "author": [{"family": "Roe"}], "issued": {"date-parts": [[2002]]}}]"#
            .into(),
        None,
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(csl.pages_created, 1, "warnings: {:?}", csl.warnings);
    assert!(page_id_by_title(&pool, "Roe 2002").await.is_some());

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_unknown_format_is_validation_error_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let err = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        "@misc{k, title={T}}".into(),
        Some("ris".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation { .. }), "{err}");
    assert!(err.to_string().contains("'ris'"), "{err}");

    mat.shutdown();
}

// ======================================================================
// dedup / idempotence (#1454 acceptance)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_reimport_is_idempotent_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let first = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        TWO_ENTRY_BIBTEX.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(first.pages_created, 2);
    let pages_after_first = count_pages_in_space(&pool, TEST_SPACE_ID).await;

    // Re-import the SAME file: every entry must dedup on citation-key.
    let second = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        TWO_ENTRY_BIBTEX.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(second.pages_created, 0, "re-import must create nothing");
    assert_eq!(second.entries_skipped, 2);
    assert_eq!(second.properties_set, 0);
    assert_eq!(
        second
            .warnings
            .iter()
            .filter(|w| w.contains("citation-key"))
            .count(),
        2,
        "each skip must be surfaced: {:?}",
        second.warnings
    );
    assert_eq!(
        count_pages_in_space(&pool, TEST_SPACE_ID).await,
        pages_after_first,
        "page count must be unchanged by the re-import"
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_dedup_falls_back_to_doi_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        "@article{original, title={T}, doi={10.1000/dup}}".into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();

    // Different citation key, same DOI → skipped via the DOI fallback.
    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        "@article{renamed, title={T2}, doi={10.1000/dup}}".into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 0);
    assert_eq!(result.entries_skipped, 1);
    assert!(
        result.warnings.iter().any(|w| w.contains("10.1000/dup")),
        "{:?}",
        result.warnings
    );

    // Intra-file duplicate keys dedup too.
    let dup = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        "@misc{twice, title={A}}\n@misc{twice, title={B}}".into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(dup.pages_created, 1);
    assert_eq!(dup.entries_skipped, 1);

    mat.shutdown();
}

// ======================================================================
// title collisions
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_title_collision_appends_citation_key_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // Pre-existing page whose title collides with the citation display name.
    insert_block(
        &pool,
        "01COLLIDEPAGE0000000000001",
        "page",
        "Doe 2020",
        None,
        Some(1),
    )
    .await;
    assign_to_space(&pool, "01COLLIDEPAGE0000000000001", TEST_SPACE_ID).await;

    // Two entries that BOTH resolve to display name "Doe 2020": the first
    // collides with the existing page, the second with the first.
    let src = "@article{doeA, author={Doe, Jane}, year={2020}}\n\
               @article{doeB, author={Doe, John}, year={2020}}";
    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        src.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 2, "warnings: {:?}", result.warnings);

    assert!(
        page_id_by_title(&pool, "Doe 2020 (doeA)").await.is_some(),
        "existing-page collision must suffix the citation key"
    );
    assert!(
        page_id_by_title(&pool, "Doe 2020 (doeB)").await.is_some(),
        "within-import collision must suffix the citation key"
    );
    assert_eq!(
        result
            .warnings
            .iter()
            .filter(|w| w.contains("already exists"))
            .count(),
        2,
        "each rename must be surfaced: {:?}",
        result.warnings
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_falls_back_to_citation_key_title_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // No author → title falls back to the citation key; no year → same.
    let src = "@misc{no-author, title={T}, year={1999}}\n\
               @misc{no-year, title={T2}, author={Doe, Jane}}";
    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        src.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 2, "warnings: {:?}", result.warnings);
    assert!(page_id_by_title(&pool, "no-author").await.is_some());
    assert!(page_id_by_title(&pool, "no-year").await.is_some());

    mat.shutdown();
}

// ======================================================================
// malformed input
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_unbalanced_braces_is_validation_error_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let err = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        "@misc{ok, title={fine}}\n@article{bad,\n  title = {never closed\n".into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation { .. }), "{err}");
    let msg = err.to_string();
    assert!(msg.contains("unbalanced braces"), "{msg}");
    assert!(msg.contains("line 2"), "must carry line info: {msg}");

    // Parse failure happens before any write — nothing was imported.
    assert_eq!(count_pages_in_space(&pool, TEST_SPACE_ID).await, 0);

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_empty_file_is_validation_error_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    for format in [
        None,
        Some("bibtex".to_string()),
        Some("csl-json".to_string()),
    ] {
        let err = import_bibliography_inner(
            &pool,
            DEV,
            &mat,
            "  \n\t ".into(),
            format.clone(),
            TEST_SPACE_ID.into(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, AppError::Validation { .. }),
            "format {format:?}: {err}"
        );
        assert!(err.to_string().contains("empty"), "{err}");
    }

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_missing_citation_key_skips_with_warning_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        "@article{, title={No Key}}\n@misc{good, title={Ok}}".into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 1, "warnings: {:?}", result.warnings);
    assert!(page_id_by_title(&pool, "good").await.is_some());
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.contains("missing or malformed citation key")),
        "{:?}",
        result.warnings
    );

    mat.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_directives_only_creates_nothing_with_warnings_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        "@string{jt = {Journal}}\n@comment{nothing here}\n@preamble{\"x\"}".into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 0);
    for directive in ["@string", "@comment", "@preamble"] {
        assert!(
            result.warnings.iter().any(|w| w.contains(directive)),
            "missing {directive} warning: {:?}",
            result.warnings
        );
    }
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.contains("no importable bibliography entries")),
        "{:?}",
        result.warnings
    );

    mat.shutdown();
}

// ======================================================================
// chunking (#2470 writer-lock contract)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_chunking_boundary_imports_all_entries_1454() {
    use crate::commands::pages::bibliography::IMPORT_BIB_CHUNK_ENTRIES;

    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // 1.25 chunks → exactly two chunks; every entry must survive the flush
    // boundary (page + all properties in the same chunk).
    let n = IMPORT_BIB_CHUNK_ENTRIES + IMPORT_BIB_CHUNK_ENTRIES / 4;
    let mut src = String::new();
    for i in 0..n {
        src.push_str(&format!(
            "@article{{key{i}, title={{Title {i}}}, author={{Author{i}, A.}}, year={{2000}}}}\n"
        ));
    }

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        src,
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(
        result.pages_created, n as u64,
        "warnings: {:?}",
        result.warnings
    );
    assert_eq!(result.entries_skipped, 0);
    assert_eq!(
        count_pages_in_space(&pool, TEST_SPACE_ID).await,
        i64::try_from(n).unwrap()
    );

    // Spot-check an entry from EACH chunk carries its properties.
    for i in [0, IMPORT_BIB_CHUNK_ENTRIES] {
        let page = page_id_by_title(&pool, &format!("Author{i} 2000"))
            .await
            .unwrap_or_else(|| panic!("page for entry {i} must exist"));
        let props = props_of(&pool, &page).await;
        assert_eq!(
            props["citation-key"].value_text.as_deref(),
            Some(format!("key{i}").as_str())
        );
        assert_eq!(props["year"].value_num, Some(2000.0));
    }

    mat.shutdown();
}

// ======================================================================
// space validation
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_rejects_invalid_space_1454() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    // Space block exists but is NOT marked `is_space = 'true'`.
    ensure_test_space(&pool).await;

    let err = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        "@misc{k1, title={T}}".into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation { .. }), "{err}");
    assert!(err.to_string().contains("is_space"), "{err}");

    // Nothing was written.
    let pages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM blocks WHERE block_type = 'page' AND id != ?")
            .bind(TEST_SPACE_ID)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(pages, 0, "failed space validation must import nothing");

    mat.shutdown();
}
