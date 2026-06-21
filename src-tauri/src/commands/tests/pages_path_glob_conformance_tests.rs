//! Conformance tests for the Pages `PathGlob` filter primitive (#1910),
//! driven by the SHARED golden fixture
//! `conformance/pages-metadata/path-glob.vectors.json`.
//!
//! The SAME fixture is asserted by the tauri-mock TS reimplementation
//! (`src/lib/search-query/__tests__/glob-conformance.test.ts`, driving
//! `pageGlobFilterMatches`). This side drives the REAL query path —
//! `list_pages_with_metadata_inner` with a `PathGlob` filter, which runs the
//! raw pattern through `prepare_globs` and binds it into
//! `LOWER(title) GLOB ?` (the SQLite GLOB dialect, #1320-A). If backend
//! semantics change, regenerate the fixture from THIS Rust side; the mock test
//! then fails until `glob-validate.ts` is realigned. See
//! `conformance/pages-metadata/README.md`.

#![cfg(test)]

use serde::Deserialize;
use sqlx::SqlitePool;

use crate::commands::pages::{
    ListPagesWithMetadataFilter, PageSort, list_pages_with_metadata_inner,
};
use crate::commands::tests::common::{
    TEST_SPACE_ID, assign_to_space, ensure_test_space, insert_block, test_pool,
};
use crate::filters::primitive::FilterPrimitive;

// serde ignores unknown top-level keys (`$comment*`) by default, so we do NOT
// use `deny_unknown_fields`.

#[derive(Deserialize)]
struct Vectors {
    rows: Vec<Row>,
    scenarios: Vec<Scenario>,
    invalid: Vec<Invalid>,
}

#[derive(Deserialize)]
struct Row {
    id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    name: String,
    pattern: String,
    exclude: bool,
    expected_matching_ids: Vec<String>,
}

#[derive(Deserialize)]
struct Invalid {
    name: String,
    pattern: String,
}

fn load_vectors() -> Vectors {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../conformance/pages-metadata/path-glob.vectors.json"
    ))
    .expect("read fixture");
    serde_json::from_str(&raw).expect("parse fixture")
}

/// Seed one fixture row as a page in [`TEST_SPACE_ID`], writing its `title`
/// into `pages_cache` (the column the `PathGlob` sub-select globs against:
/// `SELECT page_id FROM pages_cache WHERE LOWER(title) GLOB ?`).
async fn seed_glob_page(pool: &SqlitePool, row: &Row) {
    insert_block(pool, &row.id, "page", &row.title, None, Some(0)).await;
    assign_to_space(pool, &row.id, TEST_SPACE_ID).await;
    sqlx::query(
        "INSERT OR IGNORE INTO pages_cache \
             (page_id, title, updated_at, inbound_link_count, child_block_count) \
         VALUES (?, ?, 1735689600000, 0, 0)",
    )
    .bind(&row.id)
    .bind(&row.title)
    .execute(pool)
    .await
    .unwrap();
}

async fn seed_all(pool: &SqlitePool, rows: &[Row]) {
    ensure_test_space(pool).await;
    for row in rows {
        seed_glob_page(pool, row).await;
    }
}

fn glob_filter(pattern: &str, exclude: bool) -> ListPagesWithMetadataFilter {
    ListPagesWithMetadataFilter {
        sort: PageSort::default(),
        space_id: TEST_SPACE_ID.to_string(),
        filters: vec![FilterPrimitive::PathGlob {
            pattern: pattern.to_string(),
            exclude,
        }],
    }
}

/// Every valid scenario: the set of page ids the real query returns for the
/// `PathGlob` filter must equal the fixture's `expectedMatchingIds`.
#[tokio::test]
async fn pages_path_glob_conformance_matching() {
    let vectors = load_vectors();

    for scenario in &vectors.scenarios {
        let (pool, _dir) = test_pool().await;
        seed_all(&pool, &vectors.rows).await;

        let resp = list_pages_with_metadata_inner(
            &pool,
            glob_filter(&scenario.pattern, scenario.exclude),
            None,
            Some(50),
        )
        .await
        .unwrap_or_else(|e| panic!("scenario `{}` errored: {e:?}", scenario.name));

        let mut got: Vec<String> = resp.items.iter().map(|p| p.id.to_string()).collect();
        got.sort();
        let mut want = scenario.expected_matching_ids.clone();
        want.sort();
        assert_eq!(
            got, want,
            "matching-id mismatch for scenario `{}` (pattern {:?}, exclude {})",
            scenario.name, scenario.pattern, scenario.exclude
        );
    }
}

/// Every invalid pattern must make the query fail with an `InvalidGlob:`
/// validation error (the contract the mock mirrors by dropping all rows).
#[tokio::test]
async fn pages_path_glob_conformance_rejects_invalid() {
    let vectors = load_vectors();

    for bad in &vectors.invalid {
        let (pool, _dir) = test_pool().await;
        seed_all(&pool, &vectors.rows).await;

        let err =
            list_pages_with_metadata_inner(&pool, glob_filter(&bad.pattern, false), None, Some(50))
                .await
                .expect_err(&format!(
                    "invalid pattern `{}` ({}) must be rejected",
                    bad.pattern, bad.name
                ));
        let dbg = format!("{err:?}");
        assert!(
            dbg.contains("InvalidGlob"),
            "invalid pattern `{}` ({}) must surface the InvalidGlob prefix; got {dbg}",
            bad.pattern,
            bad.name
        );
    }
}
