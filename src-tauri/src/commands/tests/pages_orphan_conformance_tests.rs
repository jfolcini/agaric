//! Conformance tests for the Pages `Orphan` filter primitive (#1908,
//! slice 2 / increment b), driven by the SHARED golden fixture
//! `conformance/pages-metadata/orphan.vectors.json`.
//!
//! The SAME fixture is asserted by the tauri-mock TS reimplementation
//! (`src/lib/tauri-mock/__tests__/orphan-conformance.test.ts`, driving
//! `metaRowMatchesFilter`). This side drives the REAL query path —
//! `list_pages_with_metadata_inner` with an AND-composed `FilterPrimitive`
//! list, which compiles each primitive to SQL in
//! `src-tauri/src/filters/primitive.rs` (`compile_orphan`). If backend
//! semantics change, regenerate the fixture from THIS Rust side; the mock
//! test then fails until `handlers.ts` is realigned. See
//! `conformance/pages-metadata/README.md`.
//!
//! Scope: the `Orphan` primitive — a page is an Orphan iff its materialised
//! `pages_cache.inbound_link_count` is 0 AND it has NO outbound `block_links`
//! edge to a block on a DIFFERENT page (`src.page_id = b.id AND
//! tgt.page_id != b.id`). The fixture spans the 2×2 of {inbound 0 / >0} ×
//! {hasOutboundLink true/false} and pairs `Orphan` against the looser
//! `HasNoInboundLinks` sibling.

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

/// Sentinel OUTBOUND-link target page. Seeded once (a `page` block) but NEVER
/// assigned to the test space, so it cannot appear in the result set or
/// pollute scenarios. Its `page_id` is itself (insert_block stamps pages →
/// self), which differs from every row id, so the `tgt.page_id != b.id`
/// clause in `compile_orphan` fires and the linking page is excluded from
/// `Orphan` while still matching `HasNoInboundLinks` (inbound-only).
const OUTBOUND_TARGET_ID: &str = "01ORPHTARGET000000000000000";

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
    inbound_link_count: i64,
    has_outbound_link: bool,
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
        "/../conformance/pages-metadata/orphan.vectors.json"
    ))
    .expect("read fixture");
    serde_json::from_str(&raw).expect("parse fixture")
}

/// Seed one fixture row as a page in [`TEST_SPACE_ID`]:
/// - `pages_cache` carries the materialised `inbound_link_count` (read via the
///   LEFT JOIN by `Orphan` / `HasNoInboundLinks`); `child_block_count` is 0;
/// - when `has_outbound_link` is true, a `block_links` edge whose source is
///   THIS page block and whose target is the off-space sentinel
///   [`OUTBOUND_TARGET_ID`] is inserted, so the page-wide `NOT EXISTS`
///   outbound clause in `compile_orphan` matches (`src.page_id = b.id`,
///   `tgt.page_id != b.id`) and the page is excluded from `Orphan`.
async fn seed_orphan_page(pool: &SqlitePool, row: &Row) {
    insert_block(pool, &row.id, "page", &row.title, None, Some(0)).await;
    assign_to_space(pool, &row.id, TEST_SPACE_ID).await;
    sqlx::query(
        "INSERT OR IGNORE INTO pages_cache \
             (page_id, title, updated_at, inbound_link_count, child_block_count) \
         VALUES (?, ?, 1735689600000, ?, 0)",
    )
    .bind(&row.id)
    .bind(&row.title)
    .bind(row.inbound_link_count)
    .execute(pool)
    .await
    .unwrap();
    if row.has_outbound_link {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(&row.id)
            .bind(OUTBOUND_TARGET_ID)
            .execute(pool)
            .await
            .unwrap();
    }
}

async fn seed_all(pool: &SqlitePool, rows: &[Row]) {
    ensure_test_space(pool).await;
    // Sentinel outbound-link target: a `page` block deliberately NOT assigned
    // to the test space. Seeded once so every `has_outbound_link` edge has a
    // valid FK target whose `page_id` differs from every row id.
    insert_block(pool, OUTBOUND_TARGET_ID, "page", "OutTarget", None, Some(0)).await;
    for row in rows {
        seed_orphan_page(pool, row).await;
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
async fn pages_orphan_conformance_matching() {
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
