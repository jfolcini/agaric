//! Tests for `import_bibliography_inner` (#1454 tier a) — BibTeX / CSL-JSON
//! bibliography import as reference pages with typed properties.
//!
//! Pure-parser unit tests live in `agaric_engine::bibliography`; these exercise the
//! transactional apply: page creation, typed property stamping, dedup /
//! idempotence, title collisions, chunking, and space validation.

use crate::prelude::*;
use agaric_core::error::AppError;
use agaric_lib::materializer::Materializer;

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
    use agaric_lib::commands::pages::bibliography::IMPORT_BIB_CHUNK_ENTRIES;

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

// ======================================================================
// property-definition ownership (#4382)
// ======================================================================

/// The `property_definitions.value_type` for `key`, or `None` when the key
/// is undeclared. `property_definitions` is keyed by `key` ALONE, so this
/// is a vault-global fact, not a per-block one.
async fn property_def_type(pool: &sqlx::SqlitePool, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT value_type FROM property_definitions WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .unwrap()
}

const ONE_ENTRY_BIBTEX_1920: &str = r"
@book{old1920,
  title  = {An Old Book},
  author = {Doe, Jane},
  year   = {1920},
}
";

/// #4382 — an import must NOT declare a global type for a key whose values
/// the user is already keeping in another shape.
///
/// The trap this pins: `year` is declared `number` vault-wide, so (1) every
/// later text write to `year` on any block is rejected, (2) inbound sync
/// drops those rows row-absent because `parse::<f64>()` fails, and (3) the
/// declaration cannot be deleted while rows reference the key — and the
/// remedy `delete_property_def_inner` names, `set_property(value = None)`,
/// is itself rejected for a non-reserved key. Un-exitable short of deleting
/// the property from every affected block.
///
/// Paired with `import_bibliography_declares_year_as_number_when_unused_4382`
/// below: a fix that simply stopped declaring anything would pass this test
/// and fail that one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_leaves_in_use_key_undeclared_4382() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // The user's pre-existing state: a block carrying `year` as free text,
    // with NO `property_definitions` row. That is the ORDINARY state for a
    // custom key — undeclared keys are fully permissive — which is exactly
    // why `INSERT OR IGNORE` does not protect it: there is nothing to
    // ignore.
    const EXISTING: &str = "01AAAAYEAR0000000000000001";
    insert_block(
        &pool,
        EXISTING,
        "content",
        "a note on an old book",
        None,
        None,
    )
    .await;
    assign_to_test_space(&pool, EXISTING).await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        EXISTING.into(),
        "year".into(),
        Some("circa 1920".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("an undeclared key must accept free text");
    settle(&mat).await;
    assert_eq!(
        property_def_type(&pool, "year").await,
        None,
        "seed precondition: the trap needs `year` to be IN USE but UNDECLARED"
    );

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        ONE_ENTRY_BIBTEX_1920.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 1, "warnings: {:?}", result.warnings);
    settle(&mat).await;

    // 1. The import did not invent a global declaration for the in-use key.
    assert_eq!(
        property_def_type(&pool, "year").await,
        None,
        "import must not declare a global type for a key that already has values"
    );

    // 2. The user's existing value is untouched and still text.
    let existing_props = props_of(&pool, EXISTING).await;
    assert_eq!(
        existing_props["year"].value_text.as_deref(),
        Some("circa 1920"),
        "pre-existing value must survive the import: {existing_props:?}"
    );

    // 3. The escape hatch stays open: a later TEXT write to `year`, on a
    //    block that has nothing to do with the import, still succeeds. This
    //    is the assertion that fails loudly under the bug, with
    //    "Property 'year' expects type 'number', got 'text'."
    const OTHER: &str = "01AAAAYEAR0000000000000002";
    insert_block(&pool, OTHER, "content", "another note", None, None).await;
    assign_to_test_space(&pool, OTHER).await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        OTHER.into(),
        "year".into(),
        Some("n.d.".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("a text write to `year` must still be accepted after the import");
    settle(&mat).await;

    // 4. The import's OWN `year` value was coerced to the vault's existing
    //    (undeclared, permissive) shape rather than dragging the vault to
    //    the import's preferred one.
    let page = page_id_by_title(&pool, "Doe 1920")
        .await
        .expect("Doe 1920 page");
    let props = props_of(&pool, &page).await;
    assert_eq!(
        props["year"].value_text.as_deref(),
        Some("1920"),
        "an undeclared key routes to value_text: {props:?}"
    );
    assert_eq!(
        props["year"].value_num, None,
        "value_num is for a `number` declaration, which was deliberately not made: {props:?}"
    );

    // 5. The skip is REPORTED, not silent — the decision is visible to the
    //    caller through the existing warnings channel.
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.contains("'year'") && w.contains("undeclared")),
        "the skipped declaration must be surfaced: {:?}",
        result.warnings
    );

    // 6. Only the in-use key is skipped. The other seven, unused, are
    //    declared exactly as before — a fix that skipped everything would
    //    otherwise pass this test.
    assert_eq!(
        property_def_type(&pool, "citation-key").await.as_deref(),
        Some("text"),
        "an UNUSED key must still be declared"
    );
    assert_eq!(
        property_def_type(&pool, "authors").await.as_deref(),
        Some("text"),
        "an UNUSED key must still be declared"
    );
    assert_eq!(
        props["citation-key"].value_text.as_deref(),
        Some("old1920"),
        "{props:?}"
    );

    mat.shutdown();
}

/// #4382 (the other half of the pair) — when `year` is NOT already in use,
/// the import declares it `number` exactly as it always did, and the value
/// lands in `value_num`. Guards against "fix" the guard by never declaring.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_declares_year_as_number_when_unused_4382() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    assert_eq!(
        property_def_type(&pool, "year").await,
        None,
        "seed precondition: `year` starts undeclared and unused"
    );

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        ONE_ENTRY_BIBTEX_1920.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 1, "warnings: {:?}", result.warnings);
    assert!(
        result.warnings.is_empty(),
        "an unused key is declared silently: {:?}",
        result.warnings
    );
    settle(&mat).await;

    assert_eq!(
        property_def_type(&pool, "year").await.as_deref(),
        Some("number"),
        "an unused `year` must still be declared `number`"
    );
    let page = page_id_by_title(&pool, "Doe 1920")
        .await
        .expect("Doe 1920 page");
    let props = props_of(&pool, &page).await;
    assert_eq!(
        props["year"].value_num,
        Some(1920.0),
        "the declaration must route the value to value_num: {props:?}"
    );
    assert_eq!(props["year"].value_text, None, "{props:?}");

    mat.shutdown();
}

/// #4382 — a user's pre-existing DECLARATION still wins, unchanged. The
/// guard must not regress the behaviour the old comment described.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_keeps_existing_year_declaration_4382() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    create_property_def_inner(&pool, "year".into(), "text".into(), None)
        .await
        .unwrap();

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        ONE_ENTRY_BIBTEX_1920.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 1, "warnings: {:?}", result.warnings);
    assert!(
        result.warnings.is_empty(),
        "a declared key is not a skip — nothing to report: {:?}",
        result.warnings
    );
    settle(&mat).await;

    assert_eq!(
        property_def_type(&pool, "year").await.as_deref(),
        Some("text"),
        "the user's declaration must not be overwritten"
    );
    let page = page_id_by_title(&pool, "Doe 1920")
        .await
        .expect("Doe 1920 page");
    let props = props_of(&pool, &page).await;
    assert_eq!(
        props["year"].value_text.as_deref(),
        Some("1920"),
        "{props:?}"
    );

    mat.shutdown();
}

/// #4382 / #4395 review note 2 — an in-use **text** key is skipped too, and
/// the warning tells the truth about what declaring it would have cost.
///
/// Seven of the eight [`BIB_PROPERTY_DEFS`] keys prefer `text`, and for
/// those the `year` wording ("would reject every later text edit") is
/// false: a `text` declaration accepts `value_text` happily. What a `text`
/// declaration *does* reject is a `value_num` / `value_date` / `value_bool`
/// write — and those rows are reachable under an undeclared key, because
/// `validate_property_value` skips its type check when `declaration` is
/// `None` and both `set_property` and the MCP `set_property` tool expose
/// all five typed slots. That is the reachability this test pins: the seed
/// writes `authors` as a NUMBER through the ordinary command path, and the
/// post-import escape hatch writes another one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_leaves_in_use_text_key_undeclared_4382() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    // The user's pre-existing state: `authors` in use, undeclared, and
    // holding a value the import's preferred `text` type would forbid.
    const EXISTING: &str = "01AAAAAUTH0000000000000001";
    insert_block(&pool, EXISTING, "content", "a headcount note", None, None).await;
    assign_to_test_space(&pool, EXISTING).await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        EXISTING.into(),
        "authors".into(),
        None,
        Some(3.0),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("an undeclared key must accept a number — this is the reachability the guard needs");
    settle(&mat).await;
    assert_eq!(
        property_def_type(&pool, "authors").await,
        None,
        "seed precondition: `authors` must be IN USE but UNDECLARED"
    );

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        ONE_ENTRY_BIBTEX_1920.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 1, "warnings: {:?}", result.warnings);
    settle(&mat).await;

    // 1. The in-use text key is skipped, exactly like the number key.
    assert_eq!(
        property_def_type(&pool, "authors").await,
        None,
        "an in-use TEXT key must be skipped too, not just the `number` one"
    );

    // 2. The user's existing non-text value survives untouched.
    let existing_props = props_of(&pool, EXISTING).await;
    assert_eq!(
        existing_props["authors"].value_num,
        Some(3.0),
        "pre-existing value must survive the import: {existing_props:?}"
    );

    // 3. The escape hatch stays open: a later NUMBER write to `authors`
    //    still succeeds. This is the assertion that fails loudly if the
    //    guard is narrowed to non-text preferred types, with
    //    "Property 'authors' expects type 'text', got 'number'."
    const OTHER: &str = "01AAAAAUTH0000000000000002";
    insert_block(&pool, OTHER, "content", "another headcount", None, None).await;
    assign_to_test_space(&pool, OTHER).await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        OTHER.into(),
        "authors".into(),
        None,
        Some(7.0),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("a number write to `authors` must still be accepted after the import");
    settle(&mat).await;

    // 4. The warning states the consequence that is TRUE for a text key,
    //    and not the `year` one, which is false for it.
    let warning = result
        .warnings
        .iter()
        .find(|w| w.contains("'authors'"))
        .unwrap_or_else(|| {
            panic!(
                "the skipped declaration must be surfaced: {:?}",
                result.warnings
            )
        });
    assert!(
        warning.contains("undeclared") && warning.contains("number, date or boolean"),
        "a text key's warning must name the writes a 'text' declaration would actually \
         reject: {warning}"
    );
    assert!(
        !warning.contains("text edit"),
        "declaring `authors` 'text' would NOT reject a later text edit — the `year` wording \
         must not be reused for a text key: {warning}"
    );

    // 5. The import's own `authors` value still lands, as text.
    let page = page_id_by_title(&pool, "Doe 1920")
        .await
        .expect("Doe 1920 page");
    let props = props_of(&pool, &page).await;
    assert_eq!(
        props["authors"].value_text.as_deref(),
        Some("Doe, Jane"),
        "{props:?}"
    );

    // 6. Only the in-use key is skipped — `year`, unused here, is still
    //    declared `number`, so this is not a "skip everything" pass.
    assert_eq!(
        property_def_type(&pool, "year").await.as_deref(),
        Some("number"),
        "an UNUSED key must still be declared"
    );

    mat.shutdown();
}

/// #4382 / #4395 review note 3 — a key whose only values live on a
/// SOFT-DELETED block is still in use, and still skipped.
///
/// The probe in `declare_bib_property_defs` deliberately does not filter
/// `blocks.deleted_at`, because the blocking `COUNT(*)` in
/// `delete_property_def_inner` does not either: a declaration created over
/// a soft-deleted block's values is just as un-removable as one created
/// over a live block's, and the values come back if the block is restored.
/// Until now that omission was asserted only in a comment. Adding
/// `JOIN blocks … WHERE deleted_at IS NULL` to the probe — the obvious
/// "tidy-up" — reopens #4382 through this door, and reddens here.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn import_bibliography_treats_soft_deleted_values_as_in_use_4382() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    ensure_test_space(&pool).await;
    mark_block_as_space(&pool, TEST_SPACE_ID).await;

    const TRASHED: &str = "01AAAATRSH0000000000000001";
    insert_block(
        &pool,
        TRASHED,
        "content",
        "a note on an old book",
        None,
        None,
    )
    .await;
    assign_to_test_space(&pool, TRASHED).await;
    set_property_inner(
        &pool,
        DEV,
        &mat,
        TRASHED.into(),
        "year".into(),
        Some("circa 1920".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    settle(&mat).await;

    delete_block_inner(&pool, DEV, &mat, TRASHED.into())
        .await
        .expect("soft-delete the only block holding a `year` value");
    settle(&mat).await;

    // The premise the probe rests on: a soft delete leaves the
    // `block_properties` row in place, which is why
    // `delete_property_def_inner`'s unfiltered COUNT(*) would still block a
    // later attempt to remove the declaration.
    let surviving: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM block_properties WHERE key = 'year'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        surviving, 1,
        "seed precondition: the soft-deleted block's `year` row must survive the delete"
    );
    let deleted_at: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM blocks WHERE id = ?")
        .bind(TRASHED)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        deleted_at.is_some(),
        "seed precondition: the block must actually be soft-deleted"
    );

    let result = import_bibliography_inner(
        &pool,
        DEV,
        &mat,
        ONE_ENTRY_BIBTEX_1920.into(),
        Some("bibtex".into()),
        TEST_SPACE_ID.into(),
    )
    .await
    .unwrap();
    assert_eq!(result.pages_created, 1, "warnings: {:?}", result.warnings);
    settle(&mat).await;

    assert_eq!(
        property_def_type(&pool, "year").await,
        None,
        "a `year` value on a soft-deleted block still makes the key in-use: declaring it \
         would be just as un-removable, since `delete_property_def_inner` counts that row too"
    );
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.contains("'year'") && w.contains("undeclared")),
        "the skip must be reported here too: {:?}",
        result.warnings
    );

    mat.shutdown();
}
