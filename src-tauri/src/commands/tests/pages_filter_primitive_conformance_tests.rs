//! Conformance tests for the Pages filter-primitive evaluation (#1908,
//! slice 2 / increment a), driven by the SHARED golden fixture
//! `conformance/pages-metadata/filters.vectors.json`.
//!
//! The SAME fixture is asserted by the tauri-mock TS reimplementation
//! (`src/lib/tauri-mock/__tests__/filter-primitive-conformance.test.ts`,
//! driving `metaRowMatchesFilter`). This side drives the REAL query path —
//! `list_pages_with_metadata_inner` with an AND-composed `FilterPrimitive`
//! list, which compiles each primitive to SQL in
//! `src-tauri/src/filters/primitive.rs`. If backend semantics change,
//! regenerate the fixture from THIS Rust side; the mock test then fails until
//! `handlers.ts` is realigned. See `conformance/pages-metadata/README.md`.
//!
//! Scope: the PURE-over-row primitives evaluable without global mock state —
//! `Stub`, `HasNoInboundLinks`, `Priority`, `LastEdited`(`Range`) — plus
//! AND-composition. `Rolling`/`OlderThan` are excluded (clock-relative, so a
//! golden fixture cannot pin them); `Orphan` and `Tag`/`HasProperty` are
//! separate #1908 increments.

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
#[serde(rename_all = "camelCase")]
struct Row {
    id: String,
    title: String,
    child_block_count: i64,
    inbound_link_count: i64,
    priority: Option<String>,
    last_modified_at: Option<String>,
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
        "/../conformance/pages-metadata/filters.vectors.json"
    ))
    .expect("read fixture");
    serde_json::from_str(&raw).expect("parse fixture")
}

/// Seed one fixture row as a page in [`TEST_SPACE_ID`]:
/// - `pages_cache` carries the materialised `inbound_link_count` /
///   `child_block_count` (read via the LEFT JOIN by `HasNoInboundLinks` /
///   `Stub`);
/// - `blocks.priority` is stamped when present (read directly by `Priority`);
/// - an `op_log` row stamped with `lastModifiedAt` is inserted only when
///   non-null, so `LastEdited`'s `MAX(op_log.created_at)` subquery yields NULL
///   for a null fixture timestamp (the Range bound then excludes it).
async fn seed_filter_page(pool: &SqlitePool, row: &Row) {
    insert_block(pool, &row.id, "page", &row.title, None, Some(0)).await;
    assign_to_space(pool, &row.id, TEST_SPACE_ID).await;
    if let Some(priority) = &row.priority {
        sqlx::query("UPDATE blocks SET priority = ? WHERE id = ?")
            .bind(priority)
            .bind(&row.id)
            .execute(pool)
            .await
            .unwrap();
    }
    sqlx::query(
        "INSERT OR IGNORE INTO pages_cache \
             (page_id, title, updated_at, inbound_link_count, child_block_count) \
         VALUES (?, ?, 1735689600000, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.title)
    .bind(row.inbound_link_count)
    .bind(row.child_block_count)
    .execute(pool)
    .await
    .unwrap();
    if let Some(last_modified_at) = &row.last_modified_at {
        // #109 Phase 2: `op_log.created_at` is INTEGER epoch-ms. The fixture
        // expresses timestamps as RFC 3339; parse to epoch-ms.
        let created_at_ms = chrono::DateTime::parse_from_rfc3339(last_modified_at)
            .expect("rfc3339")
            .timestamp_millis();
        sqlx::query(
            "INSERT INTO op_log (seq, device_id, op_type, payload, created_at, hash, block_id) \
             VALUES (\
                 (SELECT COALESCE(MAX(seq), 0) + 1 FROM op_log), \
                 'test-device', \
                 'CreateBlock', \
                 '{}', \
                 ?, \
                 'deadbeef', \
                 ?\
             )",
        )
        .bind(created_at_ms)
        .bind(&row.id)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn seed_all(pool: &SqlitePool, rows: &[Row]) {
    ensure_test_space(pool).await;
    for row in rows {
        seed_filter_page(pool, row).await;
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
async fn pages_filter_primitive_conformance_matching() {
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
