//! Conformance tests for `list_pages_with_metadata` sort + cursor
//! semantics (#1886, #5371), driven by the SHARED golden fixture
//! `conformance/pages-metadata/sort-cursor.vectors.json`.
//!
//! The SAME fixture is asserted by the tauri-mock TS reimplementation
//! (`src/lib/tauri-mock/__tests__/sort-cursor-conformance.test.ts`). If
//! backend semantics change, regenerate the fixture from THIS Rust side;
//! the mock test then fails until the mock is realigned. See
//! `conformance/pages-metadata/README.md`.
//!
//! Every wire sort: ordering, real cursor round-trip pagination (no
//! dupes/drops), and the whole first cursor (discriminator and key slot).

use serde::Deserialize;
use sqlx::SqlitePool;

use agaric_lib::commands::pages::{
    ListPagesWithMetadataFilter, PageSort, list_pages_with_metadata_inner,
};
use agaric_lib::commands::tests::common::{
    TEST_SPACE_ID, assign_to_space, ensure_test_space, insert_block, test_pool,
};
use agaric_store::pagination::Cursor;

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
    #[serde(default)]
    opened_at: Option<String>,
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
    id: String,
    position: i64,
    #[serde(default)]
    deleted_at: Option<String>,
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

/// RFC 3339 → epoch-ms, exact.
fn epoch_ms(rfc3339: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .expect("rfc3339")
        .timestamp_millis()
}

/// Seed one fixture row as a page in [`TEST_SPACE_ID`], writing its
/// `pages_cache` row DIRECTLY: the counts, the title sort key, and
/// `last_edited_ms` = `lastModifiedAt`; and its `page_opens` row when it
/// carries `openedAt`.
async fn seed_conf_page(pool: &SqlitePool, row: &Row) {
    insert_block(pool, &row.id, "page", &row.content, None, Some(0)).await;
    assign_to_space(pool, &row.id, TEST_SPACE_ID).await;
    sqlx::query(
        "INSERT INTO pages_cache \
             (page_id, title, title_sort_key, last_edited_ms, updated_at, \
              inbound_link_count, child_block_count, space_id) \
         VALUES (?, ?, ?, ?, 1735689600000, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.content)
    .bind(agaric_core::title_sort::title_sort_key(&row.content))
    .bind(epoch_ms(&row.last_modified_at))
    .bind(row.inbound_link_count)
    .bind(row.child_block_count)
    .bind(TEST_SPACE_ID)
    .execute(pool)
    .await
    .unwrap();
    if let Some(opened_at) = &row.opened_at {
        sqlx::query("INSERT INTO page_opens (page_id, opened_ms) VALUES (?, ?)")
            .bind(&row.id)
            .bind(epoch_ms(opened_at))
            .execute(pool)
            .await
            .unwrap();
    }
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

        // 3. The first cursor — its discriminator and its key slot.
        let first = list_pages_with_metadata_inner(&pool, filter.clone(), None, Some(1))
            .await
            .unwrap();
        let cursor = Cursor::decode(&first.next_cursor.expect("a next cursor")).unwrap();
        let expected = &scenario.expected_cursor_after_first;
        assert_eq!(
            (
                cursor.id.as_str(),
                cursor.position,
                cursor.deleted_at.as_deref(),
                cursor.seq
            ),
            (
                expected.id.as_str(),
                Some(expected.position),
                expected.deleted_at.as_deref(),
                expected.seq
            ),
            "first cursor mismatch for scenario `{}` (sort {:?})",
            scenario.name,
            sort
        );
    }
}
