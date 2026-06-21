//! Conformance tests for the Pages `Tag` + `HasProperty` filter primitives
//! (#1908, slice 2 / increment c), driven by the SHARED golden fixture
//! `conformance/pages-metadata/tag-property.vectors.json`.
//!
//! The SAME fixture is asserted by the tauri-mock TS reimplementation
//! (`src/lib/tauri-mock/__tests__/tag-property-conformance.test.ts`, driving
//! `metaRowMatchesFilter` / `hasPropertyMatches`). This side drives the REAL
//! query path — `list_pages_with_metadata_inner` with an AND-composed
//! `FilterPrimitive` list, which compiles each primitive to SQL in
//! `src-tauri/src/filters/primitive.rs` (`compile_tag` /
//! `compile_has_property`). If backend semantics change, regenerate the fixture
//! from THIS Rust side; the mock test then fails until `handlers.ts` is
//! realigned. See `conformance/pages-metadata/README.md`.
//!
//! Scope: `Tag` plus the FULL `HasProperty` predicate matrix — `Exists`,
//! `NotExists`, `Eq`, `Ne`, `Lt`, `Gt`, `Lte`, `Gte`, `Contains`, `StartsWith`
//! — across all four value types (`Text`/`Ref`/`Num`/`Date`), plus
//! AND-composition. The ordered/LIKE predicates were added in #1913.

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
}

#[derive(Deserialize)]
struct Row {
    id: String,
    title: String,
    tags: Vec<String>,
    properties: Vec<PropSeed>,
}

#[derive(Deserialize)]
struct PropSeed {
    key: String,
    value: PropVal,
}

/// Fixture property value, mirroring the wire `PropertyValue` shape
/// (`{ "type": "Text"|"Ref"|"Num"|"Date", "value": … }`). Drives which
/// `block_properties` column the seed writes, per `property_value_column`.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum PropVal {
    Text { value: String },
    Ref { value: String },
    Num { value: f64 },
    Date { value: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    name: String,
    /// The wire `FilterPrimitive` list, deserialized straight from the fixture
    /// (internally tagged on `type`, the same shape the IPC carries).
    filters: Vec<FilterPrimitive>,
    expected_matching_ids: Vec<String>,
}

fn load_vectors() -> Vectors {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../conformance/pages-metadata/tag-property.vectors.json"
    ))
    .expect("read fixture");
    serde_json::from_str(&raw).expect("parse fixture")
}

/// Seed one fixture row as a page in [`TEST_SPACE_ID`]:
/// - the page block + space assignment (so the base space-scoped SELECT sees
///   it);
/// - a `pages_cache` row so the base LEFT JOIN behaves like the (a) test (the
///   counts are irrelevant to `Tag`/`HasProperty` but keep the join populated);
/// - `block_tags` rows (read by `compile_tag`'s `b.id IN (SELECT block_id FROM
///   block_tags WHERE tag_id = ?)`). Each `tag_id` is FK → `blocks(id)`, so the
///   tag block is inserted (`block_type='tag'`) first;
/// - `block_properties` rows (read by `compile_has_property`). A `Ref` value's
///   target is FK → `blocks(id)`, so it is inserted first; the value is written
///   to `value_ref` (Ref) or `value_text` (Text), matching
///   `property_value_column`.
async fn seed_tag_property_page(pool: &SqlitePool, row: &Row) {
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

    for tag in &row.tags {
        // `block_tags.tag_id` is FK → blocks(id) (a `block_type='tag'` block).
        sqlx::query(
            "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'tag', ?, NULL, NULL, ?)",
        )
        .bind(tag)
        .bind(tag)
        .bind(tag)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(&row.id)
            .bind(tag)
            .execute(pool)
            .await
            .unwrap();
    }

    for prop in &row.properties {
        match &prop.value {
            PropVal::Ref { value } => {
                // `block_properties.value_ref` is FK → blocks(id); insert the
                // target page first.
                sqlx::query(
                    "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
                     VALUES (?, 'page', 'RefTarget', NULL, NULL, ?)",
                )
                .bind(value)
                .bind(value)
                .execute(pool)
                .await
                .unwrap();
                sqlx::query(
                    "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, ?, ?)",
                )
                .bind(&row.id)
                .bind(&prop.key)
                .bind(value)
                .execute(pool)
                .await
                .unwrap();
            }
            PropVal::Text { value } => {
                sqlx::query(
                    "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)",
                )
                .bind(&row.id)
                .bind(&prop.key)
                .bind(value)
                .execute(pool)
                .await
                .unwrap();
            }
            PropVal::Num { value } => {
                sqlx::query(
                    "INSERT INTO block_properties (block_id, key, value_num) VALUES (?, ?, ?)",
                )
                .bind(&row.id)
                .bind(&prop.key)
                .bind(value)
                .execute(pool)
                .await
                .unwrap();
            }
            PropVal::Date { value } => {
                sqlx::query(
                    "INSERT INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
                )
                .bind(&row.id)
                .bind(&prop.key)
                .bind(value)
                .execute(pool)
                .await
                .unwrap();
            }
        }
    }
}

async fn seed_all(pool: &SqlitePool, rows: &[Row]) {
    ensure_test_space(pool).await;
    for row in rows {
        seed_tag_property_page(pool, row).await;
    }
}

fn filter_for(scenario: &Scenario) -> ListPagesWithMetadataFilter {
    ListPagesWithMetadataFilter {
        sort: PageSort::default(),
        space_id: TEST_SPACE_ID.to_string(),
        filters: scenario.filters.clone(),
    }
}

/// Every scenario: the set of page ids the real query returns for the
/// AND-composed primitive list must equal the fixture's `expectedMatchingIds`.
#[tokio::test]
async fn pages_tag_property_conformance_matching() {
    let vectors = load_vectors();

    for scenario in &vectors.scenarios {
        let (pool, _dir) = test_pool().await;
        seed_all(&pool, &vectors.rows).await;

        let resp = list_pages_with_metadata_inner(&pool, filter_for(scenario), None, Some(50))
            .await
            .unwrap_or_else(|e| panic!("scenario `{}` errored: {e:?}", scenario.name));

        let mut got: Vec<String> = resp.items.iter().map(|p| p.id.to_string()).collect();
        got.sort();
        let mut want = scenario.expected_matching_ids.clone();
        want.sort();
        assert_eq!(
            got, want,
            "matching-id mismatch for scenario `{}`",
            scenario.name
        );
    }
}
