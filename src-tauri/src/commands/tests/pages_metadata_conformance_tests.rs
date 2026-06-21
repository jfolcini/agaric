//! Conformance tests for `list_pages_with_metadata` sort + cursor
//! semantics (#1886, slice 1), driven by the SHARED golden fixture
//! `conformance/pages-metadata/sort-cursor.vectors.json`.
//!
//! The SAME fixture is asserted by the tauri-mock TS reimplementation
//! (`src/lib/tauri-mock/__tests__/sort-cursor-conformance.test.ts`). If
//! backend semantics change, regenerate the fixture from THIS Rust side;
//! the mock test then fails until `handlers.ts` is realigned. See
//! `conformance/pages-metadata/README.md`.
//!
//! Slice 1 covers the four WIRE sorts (default, recently-modified,
//! most-linked, most-content) for ordering, real cursor round-trip
//! pagination (no dupes/drops), and the per-sort cursor discriminator.

#![cfg(test)]

use serde::Deserialize;
use sqlx::SqlitePool;

use crate::commands::pages::metadata::sort_discriminator;
use crate::commands::pages::{
    ListPagesWithMetadataFilter, PageSort, list_pages_with_metadata_inner,
};
use crate::commands::tests::common::{
    TEST_SPACE_ID, assign_to_space, ensure_test_space, insert_block, test_pool,
};

// ── Fixture model ─────────────────────────────────────────────────────────
//
// serde ignores unknown top-level keys (`$schema` / `$comment`) by default,
// so we do NOT use `deny_unknown_fields`.

#[derive(Deserialize)]
struct Vectors {
    rows: Vec<Row>,
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: String,
    content: String,
    last_modified_at: String,
    inbound_link_count: i64,
    child_block_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    #[allow(dead_code)]
    name: String,
    sort: String,
    expected_order: Vec<String>,
    expected_cursor_after_first: ExpectedCursor,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedCursor {
    #[allow(dead_code)]
    id: String,
    position: i64,
    #[allow(dead_code)]
    #[serde(default)]
    seq: Option<i64>,
}

/// Load the shared golden fixture from the repo's `conformance/` dir at
/// runtime (relative to `CARGO_MANIFEST_DIR` = `src-tauri`).
fn load_vectors() -> Vectors {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../conformance/pages-metadata/sort-cursor.vectors.json"
    ))
    .expect("read fixture");
    serde_json::from_str(&raw).expect("parse fixture")
}

/// Seed one fixture row as a page in [`TEST_SPACE_ID`], writing the
/// materialised `pages_cache` counts DIRECTLY (so MostLinked / MostContent
/// read the fixture's declared counts via the LEFT JOIN) and an `op_log`
/// row stamped with `lastModifiedAt` (so RecentlyModified's
/// `MAX(op_log.created_at)` subquery sees the fixture's timestamp).
///
/// Mirrors the sibling `list_pages_with_metadata_tests::{seed_page,
/// seed_op_log}` SQL shapes against the current schema.
async fn seed_conf_page(pool: &SqlitePool, row: &Row) {
    insert_block(pool, &row.id, "page", &row.content, None, Some(0)).await;
    assign_to_space(pool, &row.id, TEST_SPACE_ID).await;
    sqlx::query(
        "INSERT OR IGNORE INTO pages_cache \
             (page_id, title, updated_at, inbound_link_count, child_block_count) \
         VALUES (?, ?, 1735689600000, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.content)
    .bind(row.inbound_link_count)
    .bind(row.child_block_count)
    .execute(pool)
    .await
    .unwrap();
    // #109 Phase 2: `op_log.created_at` is INTEGER epoch-ms. The fixture
    // expresses timestamps as RFC 3339; parse to epoch-ms (exact, monotonic).
    let created_at_ms = chrono::DateTime::parse_from_rfc3339(&row.last_modified_at)
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

/// Parse the WIRE sort string (e.g. `"recently-modified"`) into [`PageSort`]
/// via serde, exercising the SAME kebab-case mapping the IPC uses on the
/// wire — so a rename of either side trips this test.
fn parse_sort(wire: &str) -> PageSort {
    serde_json::from_str(&format!("\"{wire}\"")).expect("sort enum")
}

/// Drive every scenario in the shared fixture: ordering, cursor round-trip,
/// and the per-sort cursor discriminator. Each scenario gets a FRESH pool so
/// the seeded data is isolated.
#[tokio::test]
async fn pages_metadata_conformance_sort_and_cursor() {
    let vectors = load_vectors();

    for scenario in &vectors.scenarios {
        let sort = parse_sort(&scenario.sort);

        // Fresh, isolated DB per scenario.
        let (pool, _dir) = test_pool().await;
        ensure_test_space(&pool).await;
        for row in &vectors.rows {
            seed_conf_page(&pool, row).await;
        }

        let filter = ListPagesWithMetadataFilter {
            sort,
            space_id: TEST_SPACE_ID.to_string(),
            filters: vec![],
        };

        // 1. Ordering — single page large enough to hold every row.
        let resp = list_pages_with_metadata_inner(&pool, filter.clone(), None, Some(50))
            .await
            .unwrap();
        let order: Vec<String> = resp.items.iter().map(|p| p.id.to_string()).collect();
        assert_eq!(
            order, scenario.expected_order,
            "ordering mismatch for scenario `{}` (sort {:?})",
            scenario.name, sort
        );

        // 2. Cursor round-trip — page one-at-a-time, following the REAL
        //    encoded `next_cursor` until it is None. The collected sequence
        //    must equal the full expected order (no dupes, no drops).
        let mut paged: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page =
                list_pages_with_metadata_inner(&pool, filter.clone(), cursor.clone(), Some(1))
                    .await
                    .unwrap();
            paged.extend(page.items.iter().map(|p| p.id.to_string()));
            match page.next_cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }
        assert_eq!(
            paged, scenario.expected_order,
            "cursor round-trip mismatch for scenario `{}` (sort {:?})",
            scenario.name, sort
        );

        // 3. Discriminator — the `position` slot stamped into every cursor
        //    for this sort must match the fixture's expected value.
        assert_eq!(
            sort_discriminator(sort),
            scenario.expected_cursor_after_first.position,
            "discriminator mismatch for scenario `{}` (sort {:?})",
            scenario.name,
            sort
        );
    }
}
