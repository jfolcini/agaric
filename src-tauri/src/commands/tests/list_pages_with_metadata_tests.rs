//! PEND-56 Phase 1 — tests for `list_pages_with_metadata_inner`.
//!
//! Covers: the four metadata columns, all five sort modes, cursor
//! pagination across modes, the has-property bitmask, space filtering,
//! and limit-clamp validation.

#![cfg(test)]

use sqlx::SqlitePool;

use crate::commands::pages::{
    compose_list_pages_with_metadata_sql, list_pages_with_metadata_inner,
    ListPagesWithMetadataFilter, PageSort, PageWithMetadataRow,
};
use crate::commands::tests::common::{
    assign_to_space, ensure_test_space, ensure_test_space_b, insert_block, test_pool,
    TEST_SPACE_B_ID, TEST_SPACE_ID,
};
use crate::filters::{FilterPrimitive, LastEditedSpec, PropertyPredicate, PropertyValue};

// ── Fixture builders ──────────────────────────────────────────────────────

/// Seed a page with the given id and content into [`TEST_SPACE_ID`].
///
/// PEND-56b — also seeds the `pages_cache` row that the materializer
/// would write in production. The IPC reads
/// `pc.{inbound_link_count, child_block_count}` from this row via a
/// LEFT JOIN; without it the IPC would return 0 for both counts.
async fn seed_page(pool: &SqlitePool, id: &str, content: &str) {
    insert_block(pool, id, "page", content, None, Some(0)).await;
    assign_to_space(pool, id, TEST_SPACE_ID).await;
    sqlx::query(
        "INSERT OR IGNORE INTO pages_cache \
             (page_id, title, updated_at, inbound_link_count, child_block_count) \
         VALUES (?, ?, 1735689600000, 0, 0)",
    )
    .bind(id)
    .bind(content)
    .execute(pool)
    .await
    .unwrap();
}

/// PEND-56b — refresh `pages_cache.{inbound_link_count, child_block_count}`
/// for the given page from the canonical SELECT, mirroring what the
/// materializer maintains in production. Used by `seed_link` /
/// `seed_child` so the test fixtures see the same materialised values
/// the IPC reads after the refactor. Mirrors the CURRENT inbound shape
/// (migration 0070 / `recompute_pages_cache_counts_for_pages`): the
/// source block is joined and same-page / self / deleted-source / orphan
/// edges are excluded (PEND-58d D2).
async fn refresh_page_cache_counts(pool: &SqlitePool, page_id: &str) {
    sqlx::query(
        "UPDATE pages_cache \
         SET inbound_link_count = ( \
                 SELECT COUNT(DISTINCT bl.source_id) \
                 FROM block_links AS bl \
                 INNER JOIN blocks AS descendant ON bl.target_id = descendant.id \
                 INNER JOIN blocks AS src ON src.id = bl.source_id \
                 WHERE descendant.page_id = ? \
                   AND descendant.deleted_at IS NULL \
                   AND src.deleted_at IS NULL \
                   AND src.page_id IS NOT NULL \
                   AND src.page_id != ? \
             ), \
             child_block_count = ( \
                 SELECT COUNT(*) \
                 FROM blocks AS descendant \
                 WHERE descendant.page_id = ? \
                   AND descendant.deleted_at IS NULL \
                   AND descendant.id != ? \
             ) \
         WHERE page_id = ?",
    )
    .bind(page_id) // inbound: descendant.page_id
    .bind(page_id) // inbound: src.page_id !=
    .bind(page_id) // child: descendant.page_id
    .bind(page_id) // child: descendant.id !=
    .bind(page_id) // WHERE page_id =
    .execute(pool)
    .await
    .unwrap();
}

/// Seed an op_log row stamped with the given timestamp.
///
/// Review Round 1 — robustness reviewer flagged the prior version
/// reaching for the `_op_log_mutation_allowed` bypass with a misspelled
/// column name (`key` vs the actual `token`, see migration 0036). The
/// op_log immutability triggers guard UPDATE / DELETE only — INSERT is
/// unguarded — so the bypass dance was both wrong and unnecessary.
async fn seed_op_log(pool: &SqlitePool, block_id: &str, created_at: &str) {
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
    .bind(created_at)
    .bind(block_id)
    .execute(pool)
    .await
    .unwrap();
}

/// Seed an inbound link FROM `source` TO `target`.
///
/// PEND-56b — also refreshes `pages_cache.inbound_link_count` for the
/// owning page of the target (which may be the target itself, if it
/// is a page) so the IPC's materialised read sees the new link.
async fn seed_link(pool: &SqlitePool, source: &str, target: &str) {
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(source)
        .bind(target)
        .execute(pool)
        .await
        .unwrap();
    // Resolve the owning page of the target (target.page_id) and
    // refresh that page's cached counts. If the target row doesn't
    // exist (rare in these tests but harmless), the lookup is None
    // and we skip the refresh.
    if let Some((Some(p),)) =
        sqlx::query_as::<_, (Option<String>,)>("SELECT page_id FROM blocks WHERE id = ?")
            .bind(target)
            .fetch_optional(pool)
            .await
            .unwrap()
    {
        refresh_page_cache_counts(pool, &p).await;
    }
}

/// Seed a child content block under `parent_page`.
///
/// PEND-56b — also refreshes `pages_cache.child_block_count` for the
/// parent so the IPC's materialised read sees the new child.
async fn seed_child(pool: &SqlitePool, child_id: &str, parent_page: &str, content: &str) {
    insert_block(
        pool,
        child_id,
        "content",
        content,
        Some(parent_page),
        Some(0),
    )
    .await;
    // Override page_id to point at parent (insert_block stamps to parent which is the page).
    sqlx::query("UPDATE blocks SET page_id = ? WHERE id = ?")
        .bind(parent_page)
        .bind(child_id)
        .execute(pool)
        .await
        .unwrap();
    refresh_page_cache_counts(pool, parent_page).await;
}

/// Seed a tag association on a block.
async fn seed_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    // Tag block (so the FK is satisfied).
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'tag', ?, NULL, NULL, ?)",
    )
    .bind(tag_id)
    .bind(tag_id)
    .bind(tag_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}

/// PEND-58b — seed a `block_properties(key, value_text)` row directly so a
/// `HasProperty { op: Eq, value: Text }` filter can match. Mirrors the
/// direct-write approach used by `assign_to_space` (the read layer reads
/// `block_properties` regardless of how the row landed).
async fn seed_prop_text(pool: &SqlitePool, block_id: &str, key: &str, value: &str) {
    sqlx::query("INSERT INTO block_properties (block_id, key, value_text) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .unwrap();
}

/// PEND-58d T-B4 — seed a `block_properties(key, value_ref)` row so a
/// `HasProperty { Eq/Ne { Ref } }` filter (compiled against `value_ref`)
/// can match. The `value_ref → blocks(id)` FK is enforced (PRAGMA
/// foreign_keys = ON in `init_pool`) and migration 0062's CHECK requires
/// exactly one value column, so we first ensure the referenced target
/// block exists, then insert a `value_ref`-only property row.
async fn seed_prop_ref(pool: &SqlitePool, block_id: &str, key: &str, ref_id: &str) {
    sqlx::query(
        "INSERT OR IGNORE INTO blocks (id, block_type, content, parent_id, position, page_id) \
         VALUES (?, 'page', 'RefTarget', NULL, NULL, ?)",
    )
    .bind(ref_id)
    .bind(ref_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, ?, ?)")
        .bind(block_id)
        .bind(key)
        .bind(ref_id)
        .execute(pool)
        .await
        .unwrap();
}

/// PEND-58d — set the fixed `blocks.priority` column on a page block so a
/// `Priority { priority }` filter (compiled to `b.priority = ?`) can
/// match. Mirrors migration 0012's fixed-field shape.
async fn seed_priority(pool: &SqlitePool, block_id: &str, priority: &str) {
    sqlx::query("UPDATE blocks SET priority = ? WHERE id = ?")
        .bind(priority)
        .bind(block_id)
        .execute(pool)
        .await
        .unwrap();
}

fn filter(sort: PageSort) -> ListPagesWithMetadataFilter {
    ListPagesWithMetadataFilter {
        sort,
        space_id: TEST_SPACE_ID.to_string(),
        filters: Vec::new(),
    }
}

/// PEND-58 — `filter()` plus a compound-filter primitive set.
fn filter_with(sort: PageSort, filters: Vec<FilterPrimitive>) -> ListPagesWithMetadataFilter {
    ListPagesWithMetadataFilter {
        sort,
        space_id: TEST_SPACE_ID.to_string(),
        filters,
    }
}

// ── Happy-path: shape ─────────────────────────────────────────────────────

#[tokio::test]
async fn list_pages_with_metadata_returns_pages_in_space_with_metadata_columns() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "Alpha").await;
    seed_page(&pool, "01PAGE000000000000000000B1", "Beta").await;
    seed_op_log(&pool, "01PAGE000000000000000000A1", "2026-01-01T00:00:00Z").await;
    seed_op_log(&pool, "01PAGE000000000000000000B1", "2026-02-01T00:00:00Z").await;

    let resp =
        list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(50))
            .await
            .expect("happy-path IPC must succeed");

    assert_eq!(resp.items.len(), 2);
    let alpha = resp
        .items
        .iter()
        .find(|p| p.id == "01PAGE000000000000000000A1")
        .unwrap();
    assert_eq!(alpha.content.as_deref(), Some("Alpha"));
    assert_eq!(
        alpha.last_modified_at.as_deref(),
        Some("2026-01-01T00:00:00Z")
    );
    assert_eq!(alpha.inbound_link_count, 0);
    assert_eq!(alpha.child_block_count, 0);
    assert!(!alpha.flags.has_tags);
    assert!(!alpha.flags.has_todo);
    assert!(!alpha.flags.has_scheduled);
    assert!(!alpha.flags.has_due);
}

// ── Sort: alphabetical ────────────────────────────────────────────────────

#[tokio::test]
async fn alphabetical_sort_returns_pages_in_content_order_case_insensitive() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    // Out-of-order insert + mixed case to verify NOCASE.
    seed_page(&pool, "01PAGE000000000000000000Z1", "zeta").await;
    seed_page(&pool, "01PAGE000000000000000000A1", "Alpha").await;
    seed_page(&pool, "01PAGE000000000000000000B1", "BETA").await;

    let resp =
        list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(50))
            .await
            .unwrap();
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(contents, vec!["Alpha", "BETA", "zeta"]);
}

// ── Sort: recently_modified ───────────────────────────────────────────────

#[tokio::test]
async fn recently_modified_sort_returns_pages_by_op_log_max_desc() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "Old").await;
    seed_page(&pool, "01PAGE000000000000000000B1", "Newest").await;
    seed_page(&pool, "01PAGE000000000000000000C1", "Middle").await;
    seed_op_log(&pool, "01PAGE000000000000000000A1", "2026-01-01T00:00:00Z").await;
    seed_op_log(&pool, "01PAGE000000000000000000B1", "2026-05-01T00:00:00Z").await;
    seed_op_log(&pool, "01PAGE000000000000000000C1", "2026-03-01T00:00:00Z").await;

    let resp =
        list_pages_with_metadata_inner(&pool, filter(PageSort::RecentlyModified), None, Some(50))
            .await
            .unwrap();
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(contents, vec!["Newest", "Middle", "Old"]);
}

// ── Sort: most_linked ─────────────────────────────────────────────────────

#[tokio::test]
async fn most_linked_sort_counts_distinct_inbound_sources() {
    // Review Round 1 (robustness) — `inbound_link_count` is
    // `COUNT(DISTINCT source_id)`, NOT `COUNT(*)`. One source linking to
    // both the page AND its descendant counts as one. This test would
    // have failed against the prior (incorrect) `COUNT(*)` semantics.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "Popular").await;
    seed_page(&pool, "01PAGE000000000000000000B1", "Loner").await;
    seed_page(&pool, "01PAGE000000000000000000C1", "SourcePage").await;
    seed_page(&pool, "01PAGE000000000000000000D1", "OtherSource").await;
    // SourcePage links INTO Popular (page) AND its descendant. With
    // DISTINCT, this is 1, not 2.
    seed_child(
        &pool,
        "01CHILD0000000000000000A2",
        "01PAGE000000000000000000A1",
        "descendant",
    )
    .await;
    seed_link(
        &pool,
        "01PAGE000000000000000000C1",
        "01PAGE000000000000000000A1",
    )
    .await;
    seed_link(
        &pool,
        "01PAGE000000000000000000C1",
        "01CHILD0000000000000000A2",
    )
    .await;
    // OtherSource → Popular: a second distinct source, so total = 2.
    seed_link(
        &pool,
        "01PAGE000000000000000000D1",
        "01PAGE000000000000000000A1",
    )
    .await;

    let resp = list_pages_with_metadata_inner(&pool, filter(PageSort::MostLinked), None, Some(50))
        .await
        .unwrap();
    let popular = resp
        .items
        .iter()
        .find(|p| p.content.as_deref() == Some("Popular"))
        .unwrap();
    let loner = resp
        .items
        .iter()
        .find(|p| p.content.as_deref() == Some("Loner"))
        .unwrap();
    // SourcePage + OtherSource each link to Popular's subtree = 2 distinct sources.
    // The pre-DISTINCT bug would have reported 3 (two from SourcePage, one from OtherSource).
    assert_eq!(popular.inbound_link_count, 2);
    assert_eq!(loner.inbound_link_count, 0);
    // Ordering: Popular first (highest count), Loner / SourcePage at tail.
    assert_eq!(resp.items[0].content.as_deref(), Some("Popular"));
}

// ── Sort: biggest ─────────────────────────────────────────────────────────

#[tokio::test]
async fn biggest_sort_counts_descendant_blocks() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "Empty").await;
    seed_page(&pool, "01PAGE000000000000000000B1", "Big").await;
    for i in 0..5 {
        seed_child(
            &pool,
            &format!("01CHILD000000000000000B{i:02}"),
            "01PAGE000000000000000000B1",
            "x",
        )
        .await;
    }

    let resp = list_pages_with_metadata_inner(&pool, filter(PageSort::MostContent), None, Some(50))
        .await
        .unwrap();
    let big = resp
        .items
        .iter()
        .find(|p| p.content.as_deref() == Some("Big"))
        .unwrap();
    let empty = resp
        .items
        .iter()
        .find(|p| p.content.as_deref() == Some("Empty"))
        .unwrap();
    assert_eq!(big.child_block_count, 5);
    assert_eq!(empty.child_block_count, 0);
    assert_eq!(resp.items[0].content.as_deref(), Some("Big"));
}

// ── Sort: ulid ────────────────────────────────────────────────────────────

#[tokio::test]
async fn ulid_sort_returns_pages_in_id_ascending() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000Z1", "Z").await;
    seed_page(&pool, "01PAGE000000000000000000A1", "A").await;
    seed_page(&pool, "01PAGE000000000000000000M1", "M").await;

    let resp = list_pages_with_metadata_inner(&pool, filter(PageSort::Default), None, Some(50))
        .await
        .unwrap();
    let ids: Vec<&str> = resp.items.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "01PAGE000000000000000000A1",
            "01PAGE000000000000000000M1",
            "01PAGE000000000000000000Z1",
        ]
    );
}

// ── Cursor pagination ─────────────────────────────────────────────────────

#[tokio::test]
async fn cursor_pagination_returns_subsequent_pages_alphabetical() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    for (i, name) in ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]
        .iter()
        .enumerate()
    {
        seed_page(&pool, &format!("01PAGE0000000000000000P{i:02}"), name).await;
    }

    // First page: limit 2.
    let page1 =
        list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(2))
            .await
            .unwrap();
    assert_eq!(page1.items.len(), 2);
    assert!(page1.has_more);
    assert!(page1.next_cursor.is_some());
    let contents1: Vec<&str> = page1
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(contents1, vec!["Alpha", "Beta"]);

    // Second page.
    let page2 = list_pages_with_metadata_inner(
        &pool,
        filter(PageSort::Alphabetical),
        page1.next_cursor.clone(),
        Some(2),
    )
    .await
    .unwrap();
    let contents2: Vec<&str> = page2
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(contents2, vec!["Delta", "Epsilon"]);
    // After Alpha/Beta/Delta/Epsilon = 4 of 5; Gamma is missing. Recount.
    // Actually: alphabetical = Alpha < Beta < Delta < Epsilon < Gamma; so
    // page 2 should be [Delta, Epsilon] and page 3 should be [Gamma].
    assert!(page2.has_more);

    // Third page.
    let page3 = list_pages_with_metadata_inner(
        &pool,
        filter(PageSort::Alphabetical),
        page2.next_cursor.clone(),
        Some(2),
    )
    .await
    .unwrap();
    let contents3: Vec<&str> = page3
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(contents3, vec!["Gamma"]);
    assert!(!page3.has_more);
    assert!(page3.next_cursor.is_none());
}

#[tokio::test]
async fn cursor_pagination_subsequent_pages_most_linked() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    // 4 pages with descending link counts: 3, 2, 1, 0.
    for (i, links) in [3, 2, 1, 0].iter().enumerate() {
        let pid = format!("01PAGE0000000000000000P{i:02}");
        seed_page(&pool, &pid, &format!("Page{i}")).await;
        for j in 0..*links {
            let src = format!("01SRC000000000000000000{i}{j:02}");
            seed_page(&pool, &src, "src").await;
            seed_link(&pool, &src, &pid).await;
        }
    }

    let page1 = list_pages_with_metadata_inner(&pool, filter(PageSort::MostLinked), None, Some(2))
        .await
        .unwrap();
    assert_eq!(page1.items.len(), 2);
    assert_eq!(page1.items[0].inbound_link_count, 3);
    assert_eq!(page1.items[1].inbound_link_count, 2);
    assert!(page1.has_more);

    let page2 = list_pages_with_metadata_inner(
        &pool,
        filter(PageSort::MostLinked),
        page1.next_cursor,
        Some(2),
    )
    .await
    .unwrap();
    // page2 ordering: 1, 0, then the seeded "src" pages also have 0 links each.
    // We only assert the top two by link count are page2[0]=1, page2[1]=0.
    assert_eq!(page2.items[0].inbound_link_count, 1);
}

// ── has_property_flags bitmask ────────────────────────────────────────────

#[tokio::test]
async fn has_property_flags_reflects_tags_todo_scheduled_due() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "TaggedPage").await;
    seed_tag(
        &pool,
        "01PAGE000000000000000000A1",
        "01TAG000000000000000000T1",
    )
    .await;

    seed_page(&pool, "01PAGE000000000000000000B1", "TodoPage").await;
    seed_child(
        &pool,
        "01CHILD0000000000000000B1",
        "01PAGE000000000000000000B1",
        "task",
    )
    .await;
    sqlx::query("UPDATE blocks SET todo_state = 'TODO' WHERE id = ?")
        .bind("01CHILD0000000000000000B1")
        .execute(&pool)
        .await
        .unwrap();

    seed_page(&pool, "01PAGE000000000000000000C1", "ScheduledPage").await;
    seed_child(
        &pool,
        "01CHILD0000000000000000C1",
        "01PAGE000000000000000000C1",
        "evt",
    )
    .await;
    sqlx::query("UPDATE blocks SET scheduled_date = '2026-05-01' WHERE id = ?")
        .bind("01CHILD0000000000000000C1")
        .execute(&pool)
        .await
        .unwrap();

    seed_page(&pool, "01PAGE000000000000000000D1", "DuePage").await;
    seed_child(
        &pool,
        "01CHILD0000000000000000D1",
        "01PAGE000000000000000000D1",
        "deadline",
    )
    .await;
    sqlx::query("UPDATE blocks SET due_date = '2026-05-15' WHERE id = ?")
        .bind("01CHILD0000000000000000D1")
        .execute(&pool)
        .await
        .unwrap();

    seed_page(&pool, "01PAGE000000000000000000E1", "Empty").await;

    let resp = list_pages_with_metadata_inner(&pool, filter(PageSort::Default), None, Some(50))
        .await
        .unwrap();
    let by_id: std::collections::HashMap<&str, &PageWithMetadataRow> =
        resp.items.iter().map(|p| (p.id.as_str(), p)).collect();

    assert!(by_id["01PAGE000000000000000000A1"].flags.has_tags);
    assert!(by_id["01PAGE000000000000000000B1"].flags.has_todo);
    assert!(by_id["01PAGE000000000000000000C1"].flags.has_scheduled);
    assert!(by_id["01PAGE000000000000000000D1"].flags.has_due);
    let empty = &by_id["01PAGE000000000000000000E1"];
    assert!(!empty.flags.has_tags);
    assert!(!empty.flags.has_todo);
    assert!(!empty.flags.has_scheduled);
    assert!(!empty.flags.has_due);
}

// ── Space filter ──────────────────────────────────────────────────────────

#[tokio::test]
async fn space_filter_excludes_pages_in_other_space() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "InA").await;
    insert_block(
        &pool,
        "01PAGE000000000000000000B1",
        "page",
        "InB",
        None,
        Some(0),
    )
    .await;
    assign_to_space(&pool, "01PAGE000000000000000000B1", TEST_SPACE_B_ID).await;

    let resp =
        list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(50))
            .await
            .unwrap();
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert!(
        contents.contains(&"InA"),
        "space A page must appear: {contents:?}"
    );
    assert!(
        !contents.contains(&"InB"),
        "space B page must NOT appear: {contents:?}"
    );
}

// ── Validation: limit clamp ───────────────────────────────────────────────

#[tokio::test]
async fn limit_out_of_range_returns_validation_error() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let err = list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(0))
        .await
        .expect_err("limit=0 must reject");
    assert!(
        format!("{err}").contains("limit must be in"),
        "expected limit clamp error, got: {err}"
    );

    let err =
        list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(101))
            .await
            .expect_err("limit=101 must reject");
    assert!(
        format!("{err}").contains("limit must be in"),
        "expected limit clamp error, got: {err}"
    );
}

// ── Cursor sort-mode discriminator (Review Round 1 — three reviewers) ─────

#[tokio::test]
async fn cursor_from_different_sort_mode_returns_requires_refresh() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    for (i, name) in ["Alpha", "Beta", "Gamma"].iter().enumerate() {
        seed_page(&pool, &format!("01PAGE0000000000000000P{i:02}"), name).await;
    }
    // Page 1 with alphabetical to get a real cursor.
    let page1 =
        list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(2))
            .await
            .unwrap();
    let alpha_cursor = page1.next_cursor.expect("page1 has a cursor");

    // Replay against MostLinked — must reject with RequiresRefresh.
    let err = list_pages_with_metadata_inner(
        &pool,
        filter(PageSort::MostLinked),
        Some(alpha_cursor.clone()),
        Some(2),
    )
    .await
    .expect_err("cursor sort-mode mismatch must reject");
    assert!(
        format!("{err}").contains("RequiresRefresh"),
        "validation must carry RequiresRefresh prefix; got: {err}"
    );

    // Same cursor against the same sort it was issued for — must succeed.
    let _ = list_pages_with_metadata_inner(
        &pool,
        filter(PageSort::Alphabetical),
        Some(alpha_cursor),
        Some(2),
    )
    .await
    .expect("same-sort replay must succeed");
}

#[tokio::test]
async fn legacy_cursor_without_discriminator_returns_requires_refresh() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "A").await;

    // A cursor lacking the position-slot discriminator (e.g. one
    // emitted by `list_blocks` or a pre-PEND-56 client) must be
    // rejected with RequiresRefresh.
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    let legacy_json = r#"{"id":"01PAGE000000000000000000A1"}"#;
    let legacy_cursor = URL_SAFE_NO_PAD.encode(legacy_json);
    let err = list_pages_with_metadata_inner(
        &pool,
        filter(PageSort::Alphabetical),
        Some(legacy_cursor),
        Some(2),
    )
    .await
    .expect_err("legacy cursor without discriminator must reject");
    assert!(
        format!("{err}").contains("RequiresRefresh"),
        "validation must carry RequiresRefresh prefix; got: {err}"
    );
}

// ── NULL last_modified_at via COALESCE sentinel (Review Round 1) ──────────

#[tokio::test]
async fn recently_modified_includes_pages_without_op_log_at_tail() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "WithOpLog").await;
    seed_page(&pool, "01PAGE000000000000000000B1", "NoOpLog").await;
    seed_op_log(&pool, "01PAGE000000000000000000A1", "2026-05-01T00:00:00Z").await;

    let resp =
        list_pages_with_metadata_inner(&pool, filter(PageSort::RecentlyModified), None, Some(50))
            .await
            .unwrap();
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    // The COALESCE sentinel ('0001-01-01...') sorts before any real ISO
    // date in DESC order → no-op-log page sorts to the tail (still
    // present, just last).
    assert_eq!(contents, vec!["WithOpLog", "NoOpLog"]);
}

#[tokio::test]
async fn recently_modified_paginates_through_no_op_log_pages() {
    // Review Round 1 — Maintainability HIGH #2 regression test.
    // The pre-COALESCE keyset dropped no-op-log pages from every
    // cursor page after page 1 (NULL comparisons returned NULL → false).
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    for (i, name) in ["A", "B", "C", "D", "E"].iter().enumerate() {
        seed_page(&pool, &format!("01PAGE0000000000000000P{i:02}"), name).await;
    }
    // Only the first two have op_log entries; the other 3 are NULL.
    seed_op_log(&pool, "01PAGE0000000000000000P00", "2026-05-01T00:00:00Z").await;
    seed_op_log(&pool, "01PAGE0000000000000000P01", "2026-04-01T00:00:00Z").await;

    let page1 =
        list_pages_with_metadata_inner(&pool, filter(PageSort::RecentlyModified), None, Some(2))
            .await
            .unwrap();
    assert_eq!(page1.items.len(), 2);
    let contents1: Vec<&str> = page1
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(contents1, vec!["A", "B"]);

    let page2 = list_pages_with_metadata_inner(
        &pool,
        filter(PageSort::RecentlyModified),
        page1.next_cursor,
        Some(2),
    )
    .await
    .unwrap();
    let contents2: Vec<&str> = page2
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    // C and D — the no-op-log pages — must appear, NOT be silently dropped.
    assert_eq!(contents2, vec!["C", "D"]);
}

// ── Soft-deleted pages excluded ───────────────────────────────────────────

#[tokio::test]
async fn soft_deleted_pages_excluded_from_results() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "Live").await;
    seed_page(&pool, "01PAGE000000000000000000B1", "Deleted").await;
    sqlx::query("UPDATE blocks SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?")
        .bind("01PAGE000000000000000000B1")
        .execute(&pool)
        .await
        .unwrap();

    let resp =
        list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(50))
            .await
            .unwrap();
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(contents, vec!["Live"]);
}

// ── PEND-56b — EXPLAIN QUERY PLAN snapshot tests ──────────────────────────
//
// The whole point of materialising `inbound_link_count` /
// `child_block_count` into `pages_cache` is that the `MostLinked` /
// `MostContent` ORDER BY no longer scans `block_links`. These tests
// assert that contract directly: run `EXPLAIN QUERY PLAN` on the same
// SQL the IPC emits and check the plan mentions `pages_cache` and
// does NOT mention `block_links`. If a future change accidentally
// re-introduces the correlated subquery (or drops the LEFT JOIN), one
// of these asserts fires before users see the regression.
//
// Note: we don't snapshot the full plan string (SQLite is allowed to
// reword "SCAN" vs "SEARCH USING INDEX" across patch versions). We
// assert presence/absence of the table-name tokens that encode the
// contract.

/// PEND-58e E9 — run `EXPLAIN QUERY PLAN` against the **real** SQL the IPC
/// emits for `(sort, filters)` (first page, no cursor) and return the plan
/// as a single newline-joined string.
///
/// Previously this ran EXPLAIN on a hand-rebuilt copy of the SELECT, so a plan
/// regression in the IPC's actual query would NOT be caught. We now compose
/// the IPC's real statement via [`compose_list_pages_with_metadata_sql`]
/// (the same `const PAGES_METADATA_BASE_SELECT` + `compile_pages_filters` +
/// keyset path the IPC runs) and EXPLAIN that — so any drift in the live
/// query plan trips the asserts.
///
/// The composed SQL uses named placeholders: `?1` = space_id, then the
/// compiled filter binds (`?2 ..`), then a trailing `?N` for the LIMIT. We
/// bind the supplied `filter_binds_text` (in compiled order) for the filter
/// placeholders and the limit last.
async fn explain_query_plan_for_filter(
    pool: &SqlitePool,
    filter: &ListPagesWithMetadataFilter,
    filter_binds_text: &[&str],
) -> String {
    let composed = compose_list_pages_with_metadata_sql(filter, 51)
        .expect("compose real IPC SQL must succeed");
    let sql = format!("EXPLAIN QUERY PLAN {composed}");
    // Bind ?1 = space_id, then each compiled filter bind in order, then the
    // trailing LIMIT placeholder — matching the IPC's bind order.
    let mut query = sqlx::query_as::<_, (i64, i64, i64, String)>(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(&filter.space_id);
    for b in filter_binds_text {
        query = query.bind(*b);
    }
    query = query.bind(51_i64);
    let rows = query.fetch_all(pool).await.unwrap();
    rows.into_iter()
        .map(|(_, _, _, detail)| detail)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Convenience wrapper for the no-filter MostLinked / MostContent plan
/// snapshots: composes the real IPC SQL for the given sort with an empty
/// filter set and runs EXPLAIN on it.
async fn explain_query_plan_for(pool: &SqlitePool, sort: PageSort) -> String {
    assert!(
        matches!(sort, PageSort::MostLinked | PageSort::MostContent),
        "plan snapshot only meaningful for MostLinked / MostContent"
    );
    explain_query_plan_for_filter(pool, &filter(sort), &[]).await
}

#[tokio::test]
async fn most_linked_query_plan_uses_pages_cache_not_block_links() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    // Seed enough rows that SQLite picks a real plan (it sometimes
    // collapses on empty tables).
    for i in 0..10 {
        seed_page(
            &pool,
            &format!("01PAGE0000000000000000P{i:02}"),
            &format!("p{i}"),
        )
        .await;
    }
    let plan = explain_query_plan_for(&pool, PageSort::MostLinked).await;
    eprintln!("[PEND-56b EXPLAIN MostLinked]\n{plan}");
    assert!(
        plan.to_lowercase().contains("pages_cache"),
        "MostLinked plan must reference pages_cache; got:\n{plan}"
    );
    assert!(
        !plan.to_lowercase().contains("block_links"),
        "MostLinked plan must NOT scan block_links (PEND-56b regression); got:\n{plan}"
    );
}

// ── PEND-58e E11 — perf-gate bulk seeders ─────────────────────────────────
//
// The original gates seeded TRIVIAL data: `most_linked` seeded ZERO links
// (so the `MostLinked` ORDER BY ran over an all-zero materialised column —
// every row tied, no real skew to sort) and `recently_modified` seeded
// exactly ONE op_log row per page (so the per-page `MAX(created_at)`
// subquery short-circuited on a single index probe). Those numbers
// flattered the gate. These bulk seeders build REALISTIC fixtures:
//   - skewed inbound-link counts (a handful of "hub" pages with many
//     inbound links, a long tail with few/none) so the `MostLinked` sort
//     does real comparison work over a non-degenerate column, and
//   - multiple op_log rows per page (deep history) so the per-page
//     `MAX(created_at)` subquery actually aggregates over an index range
//     instead of returning the only row.
// Both are multi-row INSERTs (chunked under SQLite's ~999-param cap) so the
// 20k-scale seed stays under a few seconds — the per-call
// `refresh_page_cache_counts` subquery in `seed_link` would be O(n²) here.

/// Bulk-seed realistic inbound-link skew across `page_ids`, then refresh
/// every page's `pages_cache.inbound_link_count` in ONE pass.
///
/// For each page we add one "body" content block (the realistic authoring
/// surface — links live in the body, not on the title row). Then we wire
/// inbound links into a Zipf-ish skew: page `i` receives roughly
/// `max(0, hubs - i)` inbound edges from *other* pages' body blocks (so the
/// edges survive the same-page / self / deleted-source exclusion), giving a
/// few hubs with hundreds of inbound links and a long sparse tail.
async fn bulk_seed_link_skew(pool: &SqlitePool, page_ids: &[String]) {
    let n = page_ids.len();
    // 1. One body block per page (multi-row INSERT, chunked).
    //    block_type='content', page_id = its page.
    let body_id = |i: usize| format!("01BODY{:020}", i);
    {
        // 6 columns/row → cap chunk at 150 rows (900 params < 999).
        for chunk in (0..n).collect::<Vec<_>>().chunks(150) {
            let mut sql = String::from(
                "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) VALUES ",
            );
            let mut first = true;
            for _ in chunk {
                if !first {
                    sql.push(',');
                }
                first = false;
                sql.push_str("(?, 'content', 'body', ?, 0, ?)");
            }
            let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
            for &i in chunk {
                q = q.bind(body_id(i)).bind(&page_ids[i]).bind(&page_ids[i]);
            }
            q.execute(pool).await.unwrap();
        }
    }
    // 2. Skewed inbound edges: target page `t` gets edges from the body
    //    blocks of the first `deg(t)` *other* pages. `deg` is a steep ramp
    //    so a small number of hub pages dominate.
    let hubs = 50usize.min(n);
    let mut edges: Vec<(usize, usize)> = Vec::new(); // (source_body_idx, target_page_idx)
    for t in 0..n {
        // Hub pages (low index) get many inbound; the tail gets 0–1.
        let deg = if t < hubs {
            hubs - t
        } else {
            usize::from(t % 7 == 0)
        };
        for s in 0..deg {
            // Source is another page's body (skip same page).
            let src = if s >= t { s + 1 } else { s };
            if src < n {
                edges.push((src, t));
            }
        }
    }
    // 2 columns/row → cap chunk at 400 rows (800 params).
    for chunk in edges.chunks(400) {
        let mut sql = String::from("INSERT INTO block_links (source_id, target_id) VALUES ");
        let mut first = true;
        for _ in chunk {
            if !first {
                sql.push(',');
            }
            first = false;
            sql.push_str("(?, ?)");
        }
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for &(s, t) in chunk {
            // Edge: source body block → target page block (inbound to target).
            q = q.bind(body_id(s)).bind(&page_ids[t]);
        }
        q.execute(pool).await.unwrap();
    }
    // 3. ONE bulk refresh of every page's materialised inbound count
    //    (mirrors `refresh_page_cache_counts`' inbound SELECT, run set-wide
    //    instead of per-page). Same-page / self / deleted-source / orphan
    //    edges are excluded (PEND-58d D2 / migration 0070).
    sqlx::query(
        "UPDATE pages_cache \
         SET inbound_link_count = ( \
                 SELECT COUNT(DISTINCT bl.source_id) \
                 FROM block_links AS bl \
                 INNER JOIN blocks AS descendant ON bl.target_id = descendant.id \
                 INNER JOIN blocks AS src ON src.id = bl.source_id \
                 WHERE descendant.page_id = pages_cache.page_id \
                   AND descendant.deleted_at IS NULL \
                   AND src.deleted_at IS NULL \
                   AND src.page_id IS NOT NULL \
                   AND src.page_id != pages_cache.page_id \
             )",
    )
    .execute(pool)
    .await
    .unwrap();
}

/// Bulk-seed `depth` op_log rows per page (realistic history) via chunked
/// multi-row INSERTs, so the per-page `MAX(op_log.created_at)` subquery
/// aggregates over a real index range instead of short-circuiting on the
/// single row the old gate seeded.
async fn bulk_seed_op_log_depth(pool: &SqlitePool, page_ids: &[String], depth: usize) {
    // Determine the starting seq once, then assign sequential seqs locally
    // (a per-row `(SELECT MAX(seq)+1 …)` subquery would be O(n²)).
    let mut seq: i64 = sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(seq), 0) FROM op_log")
        .fetch_one(pool)
        .await
        .unwrap();
    // 7 columns/row → cap chunk at 120 rows (840 params).
    let mut batch: Vec<(i64, String, String)> = Vec::new(); // (seq, created_at, block_id)
    for (i, pid) in page_ids.iter().enumerate() {
        for d in 0..depth {
            seq += 1;
            // Spread timestamps so the MAX picks a non-trivial latest row.
            let created_at = format!(
                "2026-{:02}-{:02}T{:02}:00:00Z",
                (d % 12) + 1,
                (i % 28) + 1,
                d % 24
            );
            batch.push((seq, created_at, pid.clone()));
        }
    }
    for chunk in batch.chunks(120) {
        let mut sql = String::from(
            "INSERT INTO op_log (seq, device_id, op_type, payload, created_at, hash, block_id) VALUES ",
        );
        let mut first = true;
        for _ in chunk {
            if !first {
                sql.push(',');
            }
            first = false;
            sql.push_str("(?, 'test-device', 'CreateBlock', '{}', ?, 'deadbeef', ?)");
        }
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for (s, ts, bid) in chunk {
            q = q.bind(*s).bind(ts).bind(bid);
        }
        q.execute(pool).await.unwrap();
    }
}

/// PEND-56b — perf gate. Seeds a 20k-page fixture and times the
/// `MostLinked` first-page query. The plan-snapshot tests above
/// assert the *shape* of the query plan; this test asserts the
/// *latency* delivered by that shape on the actual SQLite engine
/// at the size that motivated the migration (Round 2 review
/// measured the prior implementation at **335 ms @ 20k pages**).
///
/// PEND-58e E11 — the fixture now seeds REALISTIC inbound-link skew (a few
/// hub pages with hundreds of inbound links, a long sparse tail) via
/// [`bulk_seed_link_skew`] instead of the original all-zero column, so the
/// `MostLinked` ORDER BY does genuine comparison work over a non-degenerate
/// materialised column rather than sorting an all-tied set.
///
/// Recorded in the SESSION-LOG as the "after" number. `#[ignore]`'d
/// so CI doesn't pay for 20k-row seeding on every run — invoke via
/// `cargo nextest run --run-ignored=only most_linked_perf_gate_20k_pages`.
#[ignore]
#[tokio::test]
async fn most_linked_perf_gate_20k_pages() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let n = 20_000;
    let seed_start = std::time::Instant::now();
    let mut page_ids: Vec<String> = Vec::with_capacity(n);
    for i in 0..n {
        let pid = format!("01PAGE{:020}", i);
        seed_page(&pool, &pid, &format!("p{i}")).await;
        page_ids.push(pid);
    }
    // Realistic inbound-link skew (PEND-58e E11) — multiple links per hub
    // page, refreshed into the materialised count in one pass.
    bulk_seed_link_skew(&pool, &page_ids).await;
    let seed_ms = seed_start.elapsed().as_millis();
    eprintln!("[PEND-56b PERF] seeded {n} pages (+skewed links) in {seed_ms} ms");

    // Warm up (3×).
    for _ in 0..3 {
        let _ = list_pages_with_metadata_inner(&pool, filter(PageSort::MostLinked), None, Some(50))
            .await
            .unwrap();
    }
    // Measure (median of 5 samples).
    let mut samples: Vec<u128> = Vec::with_capacity(5);
    for _ in 0..5 {
        let start = std::time::Instant::now();
        let _ = list_pages_with_metadata_inner(&pool, filter(PageSort::MostLinked), None, Some(50))
            .await
            .unwrap();
        samples.push(start.elapsed().as_millis());
    }
    samples.sort();
    let median_ms = samples[samples.len() / 2];
    eprintln!("[PEND-56b PERF] MostLinked @ 20k pages: samples={samples:?} median={median_ms} ms");
    // Soft assertion — PEND-56b's acceptance criterion is "under
    // 50 ms" (vs the prior 335 ms cliff). We allow 100 ms here to
    // absorb CI noise; if a future change pushes past 100 ms, the
    // assert fires as an early warning.
    assert!(
        median_ms < 100,
        "MostLinked @ 20k pages exceeded 100 ms budget: median={median_ms} ms (samples={samples:?})"
    );
}

/// PEND-58d D5 — perf gate for the `RecentlyModified` sort. Sibling of
/// `most_linked_perf_gate_20k_pages`, but for the UN-materialised sort:
/// `RecentlyModified` computes `MAX(op_log.created_at)` per page across
/// the space (correlated subquery, served by `idx_op_log_block_id`)
/// *before* the LIMIT, so it is the sort most exposed to per-row aggregate
/// cost. This seeds the same 20k-page fixture with REALISTIC op-log depth
/// (multiple rows per page) and times the first-page query.
///
/// PEND-58e E11 — the original gate seeded exactly ONE op_log row per page,
/// so the per-page `MAX(created_at)` subquery short-circuited on a single
/// index probe (no real aggregation). This now seeds several op_log rows
/// per page via [`bulk_seed_op_log_depth`] so the subquery aggregates over
/// a genuine index range — the cost the deferred `pages_cache.last_edited_at`
/// materialisation would remove.
///
/// `#[ignore]`'d so CI doesn't pay for 20k-row seeding on every run —
/// invoke via
/// `cargo nextest run --run-ignored=only recently_modified_perf_gate_20k_pages`.
/// The ceiling is documented on `PageSort::RecentlyModified`; if a future
/// change pushes this past the budget, materialising
/// `pages_cache.last_edited_at` is the deferred remedy.
#[ignore]
#[tokio::test]
async fn recently_modified_perf_gate_20k_pages() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let n = 20_000;
    let seed_start = std::time::Instant::now();
    let mut page_ids: Vec<String> = Vec::with_capacity(n);
    for i in 0..n {
        let pid = format!("01PAGE{:020}", i);
        seed_page(&pool, &pid, &format!("p{i}")).await;
        page_ids.push(pid);
    }
    // Realistic op-log depth (PEND-58e E11): several rows per page so the
    // per-page MAX(created_at) subquery aggregates over an index range
    // rather than short-circuiting on a single row.
    let op_log_depth = 8;
    bulk_seed_op_log_depth(&pool, &page_ids, op_log_depth).await;
    let seed_ms = seed_start.elapsed().as_millis();
    eprintln!(
        "[PEND-58d PERF] seeded {n} pages (+{op_log_depth} op_log rows each) in {seed_ms} ms"
    );

    // Warm up (3×).
    for _ in 0..3 {
        let _ = list_pages_with_metadata_inner(
            &pool,
            filter(PageSort::RecentlyModified),
            None,
            Some(50),
        )
        .await
        .unwrap();
    }
    // Measure (median of 5 samples).
    let mut samples: Vec<u128> = Vec::with_capacity(5);
    for _ in 0..5 {
        let start = std::time::Instant::now();
        let _ = list_pages_with_metadata_inner(
            &pool,
            filter(PageSort::RecentlyModified),
            None,
            Some(50),
        )
        .await
        .unwrap();
        samples.push(start.elapsed().as_millis());
    }
    samples.sort();
    let median_ms = samples[samples.len() / 2];
    eprintln!(
        "[PEND-58d PERF] RecentlyModified @ 20k pages: samples={samples:?} median={median_ms} ms"
    );
    // Soft assertion — the un-materialised correlated MAX subquery is the
    // motivation for the deferred `pages_cache.last_edited_at` work. We
    // allow 250 ms here (more headroom than MostLinked's materialised 100 ms
    // budget, since this path pays the per-row aggregate); if a future
    // change pushes past it, the assert fires as an early warning that the
    // deferred materialisation should be revisited.
    assert!(
        median_ms < 250,
        "RecentlyModified @ 20k pages exceeded 250 ms budget: median={median_ms} ms (samples={samples:?})"
    );
}

/// PEND-58e E11 — perf gate for a FILTERED query at scale. The existing
/// gates time the *unfiltered* sort paths; none exercised the compound-filter
/// fragment (`compile_pages_filters`) at 20k pages. This one does, and it
/// deliberately combines the now-expensive `Orphan` primitive (cost tier 3 —
/// its outbound half is a 3-table correlated `NOT EXISTS`, the costliest
/// Pages clause) with a cheap index-backed `Tag` clause (cost tier 0). The
/// cost-ordering reorders `[Orphan, Tag]` → `[Tag, Orphan]` so SQLite narrows
/// the row set with the indexed Tag clause BEFORE running the correlated
/// outbound subquery — exactly the win the re-rank buys. The fixture seeds
/// realistic link skew so `Orphan`'s inbound/outbound terms have real edges
/// to test, plus a tag on a subset of pages so the Tag clause pre-narrows.
///
/// `#[ignore]`'d so CI doesn't pay for 20k-row seeding on every run —
/// invoke via
/// `cargo nextest run --run-ignored=only filtered_query_perf_gate_20k_pages`.
#[ignore]
#[tokio::test]
async fn filtered_query_perf_gate_20k_pages() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let n = 20_000;
    let tag = "01TAG0000000000000000PERF1";
    let seed_start = std::time::Instant::now();
    let mut page_ids: Vec<String> = Vec::with_capacity(n);
    for i in 0..n {
        let pid = format!("01PAGE{:020}", i);
        seed_page(&pool, &pid, &format!("p{i}")).await;
        page_ids.push(pid);
    }
    // Realistic inbound/outbound link skew so Orphan's NOT-EXISTS / inbound
    // terms have genuine edges to evaluate (not an all-empty short-circuit).
    bulk_seed_link_skew(&pool, &page_ids).await;
    // Tag roughly 1-in-10 pages so the index-backed Tag clause pre-narrows
    // the set the correlated Orphan subquery then runs over.
    for (i, pid) in page_ids.iter().enumerate() {
        if i % 10 == 0 {
            seed_tag(&pool, pid, tag).await;
        }
    }
    let seed_ms = seed_start.elapsed().as_millis();
    eprintln!("[PEND-58e PERF] seeded {n} pages (+skewed links, +tags) in {seed_ms} ms");

    let make_filter = || {
        // Request order is Orphan-first to prove the cost-reorder floats the
        // cheap Tag clause ahead of the expensive correlated Orphan term.
        filter_with(
            PageSort::Alphabetical,
            vec![
                FilterPrimitive::Orphan,
                FilterPrimitive::Tag {
                    tag: tag.to_string(),
                },
            ],
        )
    };

    // Warm up (3×).
    for _ in 0..3 {
        let _ = list_pages_with_metadata_inner(&pool, make_filter(), None, Some(50))
            .await
            .unwrap();
    }
    // Measure (median of 5 samples).
    let mut samples: Vec<u128> = Vec::with_capacity(5);
    for _ in 0..5 {
        let start = std::time::Instant::now();
        let _ = list_pages_with_metadata_inner(&pool, make_filter(), None, Some(50))
            .await
            .unwrap();
        samples.push(start.elapsed().as_millis());
    }
    samples.sort();
    let median_ms = samples[samples.len() / 2];
    eprintln!(
        "[PEND-58e PERF] Orphan+Tag filtered @ 20k pages: samples={samples:?} median={median_ms} ms"
    );
    // Soft assertion — the filtered path also computes a `total_count` COUNT
    // over the same predicates on the first page (PEND-58d D6), so the budget
    // covers both the fetch and the count. With the Tag clause pre-narrowing,
    // the correlated Orphan subquery runs over a small subset; 250 ms allows
    // CI noise. If a future change pushes past it, the cost ordering or an
    // `outbound_link_count` materialisation should be revisited.
    assert!(
        median_ms < 250,
        "Orphan+Tag filtered @ 20k pages exceeded 250 ms budget: median={median_ms} ms (samples={samples:?})"
    );
}

#[tokio::test]
async fn most_content_query_plan_uses_pages_cache_not_blocks_subquery() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    for i in 0..10 {
        seed_page(
            &pool,
            &format!("01PAGE0000000000000000Q{i:02}"),
            &format!("q{i}"),
        )
        .await;
    }
    let plan = explain_query_plan_for(&pool, PageSort::MostContent).await;
    assert!(
        plan.to_lowercase().contains("pages_cache"),
        "MostContent plan must reference pages_cache; got:\n{plan}"
    );
    // PEND-58e E9 — this now plans the IPC's REAL SQL, which legitimately
    // carries correlated scalar subqueries for the per-row METADATA columns
    // (`last_modified_at` over op_log, plus the four `has_*` EXISTS flags
    // over block_tags / blocks). What the materialised-count contract forbids
    // is the *sort key* `child_block_count` being recomputed via a
    // correlated `COUNT(*) FROM blocks` aggregate (the pre-PEND-56b shape).
    // So we pin the correlated-subquery COUNT to exactly the known metadata
    // aggregates (5): last_modified_at + has_tags + has_todo + has_scheduled
    // + has_due. If a regression reverts the sort key to a per-row count, a
    // 6th correlated subquery appears and this assert fires. The materialised
    // path also means `block_links` is never scanned for the count.
    let correlated = plan
        .to_uppercase()
        .matches("CORRELATED SCALAR SUBQUERY")
        .count();
    assert_eq!(
        correlated, 5,
        "MostContent plan must carry ONLY the 5 metadata correlated subqueries \
         (last_modified_at + 4 has_* flags) — a 6th means the child_block_count \
         sort key regressed to a per-row COUNT (PEND-56b); got:\n{plan}"
    );
    assert!(
        !plan.to_lowercase().contains("block_links"),
        "MostContent plan must NOT scan block_links; got:\n{plan}"
    );
}

#[tokio::test]
async fn filtered_query_plan_explains_real_composed_ipc_sql() {
    // PEND-58e E9 — assert the EXPLAIN harness now plans the IPC's REAL
    // composed SQL (base SELECT + compiled compound-filter fragment +
    // keyset), not a hand-rebuilt copy. We compose a Tag-filtered query and
    // EXPLAIN it; the plan must reference `block_tags` (proving the compiled
    // `compile_tag` fragment was actually spliced into the planned statement)
    // and still ride `pages_cache` via the LEFT JOIN. If the IPC's real SQL
    // ever stops emitting the filter fragment, this plan loses the
    // `block_tags` token and the assert fires.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let tag = "01TAG000000000000000000T1";
    for i in 0..10 {
        let pid = format!("01PAGE0000000000000000T{i:02}");
        seed_page(&pool, &pid, &format!("t{i}")).await;
        if i % 2 == 0 {
            seed_tag(&pool, &pid, tag).await;
        }
    }
    let f = filter_with(
        PageSort::MostLinked,
        vec![FilterPrimitive::Tag {
            tag: tag.to_string(),
        }],
    );
    // ?1 = space_id, ?2 = tag id (the single compiled filter bind), ?3 = LIMIT.
    let plan = explain_query_plan_for_filter(&pool, &f, &[tag]).await;
    assert!(
        plan.to_lowercase().contains("block_tags"),
        "filtered plan must reference block_tags (the spliced compile_tag \
         fragment); got:\n{plan}"
    );
    assert!(
        plan.to_lowercase().contains("pages_cache"),
        "filtered plan must still reference pages_cache via the LEFT JOIN; got:\n{plan}"
    );
}

// ── PEND-58 Phase 3 — compound filters ────────────────────────────────────
//
// These exercise `ListPagesWithMetadataFilter.filters`: the allowed-keys
// gate, cost-ordered AND-join, and the bind-threading that splices each
// primitive's `?` placeholders between the `?1 = space_id` bind and the
// keyset binds.

#[tokio::test]
async fn filter_stub_returns_only_pages_under_threshold() {
    // `Stub` = page has = 0 non-deleted descendants
    // (`COALESCE(pc.child_block_count, 0) = 0`). Seed a page with 0
    // children (stub) and one with 4 children (not a stub).
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000S1", "StubPage").await;
    seed_page(&pool, "01PAGE000000000000000000F1", "FullPage").await;
    for i in 0..4 {
        seed_child(
            &pool,
            &format!("01CHILD000000000000000F{i:02}"),
            "01PAGE000000000000000000F1",
            "x",
        )
        .await;
    }

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(PageSort::Alphabetical, vec![FilterPrimitive::Stub]),
        None,
        Some(50),
    )
    .await
    .expect("stub filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["StubPage"],
        "only the page with 0 non-deleted descendants must pass the Stub filter"
    );
}

#[tokio::test]
async fn filter_stub_and_tag_compose_with_and_semantics() {
    // Stub + Tag must return the INTERSECTION: a page that is both a stub
    // AND carries the tag.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let tag = "01TAG000000000000000000T1";
    // Stub + tagged → passes both.
    seed_page(&pool, "01PAGE00000000000000000AA1", "StubTagged").await;
    seed_tag(&pool, "01PAGE00000000000000000AA1", tag).await;
    // Stub but untagged → fails the Tag clause.
    seed_page(&pool, "01PAGE00000000000000000BB1", "StubUntagged").await;
    // Tagged but NOT a stub (4 children) → fails the Stub clause.
    seed_page(&pool, "01PAGE00000000000000000CC1", "FullTagged").await;
    seed_tag(&pool, "01PAGE00000000000000000CC1", tag).await;
    for i in 0..4 {
        seed_child(
            &pool,
            &format!("01CHILD000000000000000C{i:02}"),
            "01PAGE00000000000000000CC1",
            "x",
        )
        .await;
    }

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![
                FilterPrimitive::Stub,
                FilterPrimitive::Tag {
                    tag: tag.to_string(),
                },
            ],
        ),
        None,
        Some(50),
    )
    .await
    .expect("compound filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["StubTagged"],
        "only the page satisfying BOTH primitives must pass"
    );
}

#[tokio::test]
async fn filter_priority_and_tag_compose_correctly_despite_cost_reorder() {
    // PEND-58d T-B5 — `compile_pages_filters` stable-sorts the request
    // primitives by `cost_hint` (Tag is 0, Priority is 1), so a request of
    // `[Priority, Tag]` is REORDERED to Tag-first and each fragment's
    // anonymous `?` is renumbered to an explicit `?N`. This test guards
    // that the renumbering keeps each bind aligned with ITS clause: a
    // misalignment (e.g. the priority string bound where Tag's tag_id is
    // expected, or vice-versa) would change which pages match.
    //
    // The fixture is built so a swap is observable: exactly one page
    // satisfies BOTH the tag AND priority A; the other two each satisfy
    // only one side. Correct AND-narrowing returns only the both-page.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let tag = "01TAG000000000000000000T1";

    // Tagged but priority B → matches Tag, fails Priority A.
    seed_page(&pool, "01PAGE00000000000000000AA1", "TaggedPriB").await;
    seed_tag(&pool, "01PAGE00000000000000000AA1", tag).await;
    seed_priority(&pool, "01PAGE00000000000000000AA1", "B").await;

    // Priority A but a DIFFERENT tag → matches Priority, fails Tag.
    seed_page(&pool, "01PAGE00000000000000000BB1", "PriAOtherTag").await;
    seed_tag(
        &pool,
        "01PAGE00000000000000000BB1",
        "01TAG000000000000000000T2",
    )
    .await;
    seed_priority(&pool, "01PAGE00000000000000000BB1", "A").await;

    // BOTH the target tag AND priority A → the only correct match.
    seed_page(&pool, "01PAGE00000000000000000CC1", "TaggedPriA").await;
    seed_tag(&pool, "01PAGE00000000000000000CC1", tag).await;
    seed_priority(&pool, "01PAGE00000000000000000CC1", "A").await;

    // Request order is Priority (cost 1) THEN Tag (cost 0); the compiler
    // reorders to Tag-first and renumbers the binds.
    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![
                FilterPrimitive::Priority {
                    priority: "A".to_string(),
                },
                FilterPrimitive::Tag {
                    tag: tag.to_string(),
                },
            ],
        ),
        None,
        Some(50),
    )
    .await
    .expect("compound Priority+Tag filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["TaggedPriA"],
        "only the page matching BOTH tag and priority A must pass — \
         the cost-reorder must renumber binds without crossing clauses"
    );
}

#[tokio::test]
async fn filter_plus_cursor_paginates_without_dupes_or_drops() {
    // Filter + sort + cursor: paginate a filtered set across the keyset
    // boundary. All 5 pages are stubs (0 children); a 6th non-stub page is
    // seeded to prove the filter excludes it from EVERY page.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    for (i, name) in ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]
        .iter()
        .enumerate()
    {
        seed_page(&pool, &format!("01PAGE0000000000000000P{i:02}"), name).await;
    }
    // A non-stub page that must NEVER appear in the filtered result set.
    seed_page(&pool, "01PAGE000000000000000000F1", "FullPage").await;
    for i in 0..4 {
        seed_child(
            &pool,
            &format!("01CHILD000000000000000F{i:02}"),
            "01PAGE000000000000000000F1",
            "x",
        )
        .await;
    }

    // Page through the filtered set 2-at-a-time and collect everything.
    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = list_pages_with_metadata_inner(
            &pool,
            filter_with(PageSort::Alphabetical, vec![FilterPrimitive::Stub]),
            cursor.clone(),
            Some(2),
        )
        .await
        .expect("filtered cursor page must succeed");
        for item in &page.items {
            seen.push(item.content.clone().unwrap_or_default());
        }
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
        assert!(cursor.is_some(), "has_more pages must carry a cursor");
    }

    // No dupes, no drops: exactly the 5 stub pages in alphabetical order.
    assert_eq!(
        seen,
        vec!["Alpha", "Beta", "Delta", "Epsilon", "Gamma"],
        "filtered pagination must return each stub once, FullPage never"
    );
    assert!(
        !seen.iter().any(|c| c == "FullPage"),
        "the non-stub page must be excluded from every page"
    );
}

#[tokio::test]
async fn filter_search_only_primitive_rejected_via_allowed_keys_gate() {
    // A Search-only primitive (`Regex`) is not in the Pages allow-list;
    // the backend must reject it with AppError::Validation even though the
    // frontend would never send it (defence-in-depth).
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "A").await;

    let err = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::Regex {
                pattern: "foo".to_string(),
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect_err("Search-only primitive must be rejected on the Pages surface");
    assert!(
        format!("{err}").contains("InvalidFilter"),
        "rejection must carry the InvalidFilter prefix; got: {err}"
    );
}

#[tokio::test]
async fn empty_filters_vec_matches_unfiltered_behaviour() {
    // Regression guard: an empty `filters` vec must reproduce today's
    // unfiltered result set exactly.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "Alpha").await;
    seed_page(&pool, "01PAGE000000000000000000B1", "Beta").await;

    let unfiltered =
        list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(50))
            .await
            .unwrap();
    let empty_filtered = list_pages_with_metadata_inner(
        &pool,
        filter_with(PageSort::Alphabetical, Vec::new()),
        None,
        Some(50),
    )
    .await
    .unwrap();

    let a: Vec<&str> = unfiltered
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    let b: Vec<&str> = empty_filtered
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(a, b, "empty filters must equal the unfiltered result set");
    assert_eq!(a, vec!["Alpha", "Beta"]);
}

// ── PEND-58b — review-remediation backend tests ───────────────────────────

#[tokio::test]
async fn filter_stub_excludes_pages_with_one_or_two_children() {
    // PEND-58b P2-E — boundary coverage. `Stub` is `child_block_count = 0`
    // (NOT the Phase-1 `< 3` threshold), so a page with exactly 1 or 2
    // non-deleted children must be EXCLUDED. Seed a 0-child stub, a
    // 1-child page, and a 2-child page; only the 0-child page passes.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE0000000000000000ST0", "ZeroChild").await;
    seed_page(&pool, "01PAGE0000000000000000ST1", "OneChild").await;
    seed_child(
        &pool,
        "01CHILD000000000000000ST10",
        "01PAGE0000000000000000ST1",
        "x",
    )
    .await;
    seed_page(&pool, "01PAGE0000000000000000ST2", "TwoChild").await;
    for i in 0..2 {
        seed_child(
            &pool,
            &format!("01CHILD000000000000000T2{i}"),
            "01PAGE0000000000000000ST2",
            "x",
        )
        .await;
    }

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(PageSort::Alphabetical, vec![FilterPrimitive::Stub]),
        None,
        Some(50),
    )
    .await
    .expect("stub filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["ZeroChild"],
        "Stub (= 0 non-deleted descendants) must exclude the 1- and 2-child pages"
    );
}

#[tokio::test]
async fn filter_orphan_excludes_pages_whose_descendant_links_out() {
    // PEND-58b P0-A — `Orphan`'s outbound `NOT EXISTS` must be scoped
    // page-wide (every non-deleted block authored a link), not just the
    // page-block (title) row. Seed:
    //   (a) a true orphan — no links either direction;
    //   (b) a page whose DESCENDANT block authors an outbound edge.
    // (b) must be EXCLUDED by `Orphan` (it links out) but still INCLUDED
    // by `HasNoInboundLinks` (the looser sibling, which ignores outbound).
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    // (a) true orphan.
    seed_page(&pool, "01PAGE000000000000000ORPH", "TrueOrphan").await;

    // (b) page with a descendant that links out to an unrelated target.
    seed_page(&pool, "01PAGE000000000000000LNKR", "BodyLinker").await;
    seed_child(
        &pool,
        "01CHILD0000000000000LNKR01",
        "01PAGE000000000000000LNKR",
        "links elsewhere",
    )
    .await;
    // A standalone target page elsewhere (also keeps the FK happy). The
    // outbound edge is FROM the descendant body block.
    seed_page(&pool, "01PAGE000000000000000TGTX", "Target").await;
    seed_link(
        &pool,
        "01CHILD0000000000000LNKR01",
        "01PAGE000000000000000TGTX",
    )
    .await;

    // Orphan: must return ONLY the true orphan (BodyLinker links out).
    let orphan_resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(PageSort::Alphabetical, vec![FilterPrimitive::Orphan]),
        None,
        Some(50),
    )
    .await
    .expect("orphan filter must succeed");
    let orphan_contents: Vec<&str> = orphan_resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        orphan_contents,
        vec!["TrueOrphan"],
        "Orphan must EXCLUDE a page whose descendant authors an outbound link"
    );

    // HasNoInboundLinks: looser — ignores outbound, so BOTH the orphan
    // and the body-linker pass (neither has inbound links). Target has an
    // inbound link, so it is excluded.
    let hnil_resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::HasNoInboundLinks],
        ),
        None,
        Some(50),
    )
    .await
    .expect("has-no-inbound-links filter must succeed");
    let mut hnil_contents: Vec<&str> = hnil_resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    hnil_contents.sort_unstable();
    assert_eq!(
        hnil_contents,
        vec!["BodyLinker", "TrueOrphan"],
        "HasNoInboundLinks must INCLUDE the body-linker (it has no inbound links)"
    );
}

#[tokio::test]
async fn filter_orphan_ignores_same_page_and_deleted_target_outbound_edges() {
    // PEND-58d D19 — the Orphan outbound `NOT EXISTS` now joins the link's
    // TARGET block and excludes same-page edges (`tgt.page_id != b.id`) and
    // deleted targets (`tgt.deleted_at IS NULL`), mirroring the inbound D2
    // fix. So:
    //   (a) a page whose only outbound edge points to ANOTHER block on the
    //       SAME page (internal navigation) is STILL an orphan;
    //   (b) a page whose only outbound edge points to a soft-DELETED target
    //       is STILL an orphan (the edge no longer reaches a live block).
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    // (a) page with a same-page edge between two of its own descendants.
    seed_page(&pool, "01PAGE000000000000000SAME", "SamePageLink").await;
    seed_child(
        &pool,
        "01CHILD0000000000000SAME01",
        "01PAGE000000000000000SAME",
        "src block",
    )
    .await;
    seed_child(
        &pool,
        "01CHILD0000000000000SAME02",
        "01PAGE000000000000000SAME",
        "tgt block",
    )
    .await;
    seed_link(
        &pool,
        "01CHILD0000000000000SAME01",
        "01CHILD0000000000000SAME02",
    )
    .await;

    // (b) page whose descendant links to a target that is then soft-deleted.
    seed_page(&pool, "01PAGE000000000000000XDEL", "DeletedTargetLink").await;
    seed_child(
        &pool,
        "01CHILD0000000000000XDEL01",
        "01PAGE000000000000000XDEL",
        "linker",
    )
    .await;
    seed_page(&pool, "01PAGE000000000000000GONE", "GoneTarget").await;
    seed_link(
        &pool,
        "01CHILD0000000000000XDEL01",
        "01PAGE000000000000000GONE",
    )
    .await;
    // Soft-delete the target page so the outbound edge no longer reaches a
    // live block.
    sqlx::query("UPDATE blocks SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = ?")
        .bind("01PAGE000000000000000GONE")
        .execute(&pool)
        .await
        .unwrap();

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(PageSort::Alphabetical, vec![FilterPrimitive::Orphan]),
        None,
        Some(50),
    )
    .await
    .expect("orphan filter must succeed");
    let mut contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    contents.sort_unstable();
    // Both pages remain orphans; the soft-deleted GoneTarget is excluded
    // because it has been deleted (the IPC drops deleted pages anyway).
    assert_eq!(
        contents,
        vec!["DeletedTargetLink", "SamePageLink"],
        "Orphan must ignore same-page and deleted-target outbound edges (D19)"
    );
}

#[tokio::test]
async fn total_count_reflects_full_space_unfiltered_and_reduces_under_filter() {
    // PEND-58b P1-D — the metadata path must return a real `total_count`
    // (was `None`, silently dropping the "X of Y" header chip). Unfiltered
    // it counts the whole space; with an active filter it reduces to the
    // matching subset, mirroring the count-alongside-fetch contract.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    // 3 stubs + 1 non-stub (4 children) = 4 pages in the space.
    seed_page(&pool, "01PAGE0000000000000000C01", "Aaa").await;
    seed_page(&pool, "01PAGE0000000000000000C02", "Bbb").await;
    seed_page(&pool, "01PAGE0000000000000000C03", "Ccc").await;
    seed_page(&pool, "01PAGE0000000000000000C04", "Ddd").await;
    for i in 0..4 {
        seed_child(
            &pool,
            &format!("01CHILD000000000000000D{i:02}"),
            "01PAGE0000000000000000C04",
            "x",
        )
        .await;
    }

    // Unfiltered: total_count == 4 (the whole space), even with a small
    // page limit that truncates `items`.
    let unfiltered = list_pages_with_metadata_inner(
        &pool,
        filter(PageSort::Alphabetical),
        None,
        Some(2), // smaller than the space so items != total
    )
    .await
    .unwrap();
    assert_eq!(
        unfiltered.total_count,
        Some(4),
        "unfiltered total_count must count the whole space (not the page slice)"
    );
    assert_eq!(unfiltered.items.len(), 2, "the page limit truncates items");

    // Filtered: Stub reduces the count to the 3 zero-child pages.
    let filtered = list_pages_with_metadata_inner(
        &pool,
        filter_with(PageSort::Alphabetical, vec![FilterPrimitive::Stub]),
        None,
        Some(50),
    )
    .await
    .unwrap();
    assert_eq!(
        filtered.total_count,
        Some(3),
        "filtered total_count must reduce to the matching subset"
    );
    assert_eq!(filtered.items.len(), 3);
}

// ── PEND-58d T-B4 — HasProperty end-to-end (every predicate × value) ──────
//
// Before D8 + D26 only `Eq + Text` ran end-to-end; the Ref combos compiled
// to `unsupported()` and were rejected. These tests exercise the full
// predicate matrix through the IPC against seeded `block_properties` rows
// (both `value_text` and `value_ref`), asserting each narrows correctly.

#[tokio::test]
async fn has_property_exists_narrows_to_pages_carrying_the_key() {
    // T-B4 — `HasProperty { Exists }` keeps only pages with a row for the
    // key, regardless of value.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE0000000000000000HP01", "HasKind").await;
    seed_prop_text(&pool, "01PAGE0000000000000000HP01", "kind", "note").await;
    seed_page(&pool, "01PAGE0000000000000000HP02", "NoKind").await;

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::HasProperty {
                key: "kind".to_string(),
                predicate: PropertyPredicate::Exists,
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("Exists filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["HasKind"],
        "Exists must keep only the page carrying the `kind` key"
    );
}

#[tokio::test]
async fn has_property_not_exists_narrows_to_pages_missing_the_key() {
    // T-B4 — `HasProperty { NotExists }` keeps only pages with NO row for
    // the key.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE0000000000000000NE01", "HasKind").await;
    seed_prop_text(&pool, "01PAGE0000000000000000NE01", "kind", "note").await;
    seed_page(&pool, "01PAGE0000000000000000NE02", "NoKind").await;

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::HasProperty {
                key: "kind".to_string(),
                predicate: PropertyPredicate::NotExists,
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("NotExists filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["NoKind"],
        "NotExists must keep only the page missing the `kind` key"
    );
}

#[tokio::test]
async fn has_property_ne_text_excludes_matching_value() {
    // T-B4 — `HasProperty { Ne { Text } }` keeps pages that do NOT carry a
    // `(key, value_text)` row matching the operand. A page with the key set
    // to a different value (or no row at all) passes.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE0000000000000000NT01", "DraftPage").await;
    seed_prop_text(&pool, "01PAGE0000000000000000NT01", "status", "draft").await;
    seed_page(&pool, "01PAGE0000000000000000NT02", "DonePage").await;
    seed_prop_text(&pool, "01PAGE0000000000000000NT02", "status", "done").await;
    seed_page(&pool, "01PAGE0000000000000000NT03", "NoStatus").await;

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::HasProperty {
                key: "status".to_string(),
                predicate: PropertyPredicate::Ne {
                    value: PropertyValue::Text {
                        value: "draft".to_string(),
                    },
                },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("Ne+Text filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["DonePage", "NoStatus"],
        "Ne(status=draft) must exclude the draft page, keep the rest"
    );
}

#[tokio::test]
async fn has_property_eq_ref_narrows_to_matching_value_ref() {
    // T-B4 (D26) — `HasProperty { Eq { Ref } }` compares `value_ref` (the
    // previously-rejected combo). Keeps only pages whose `(key, value_ref)`
    // row matches the operand.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let target = "01REFTARGET00000000000001";
    seed_page(&pool, "01PAGE0000000000000000ER01", "Linked").await;
    seed_prop_ref(&pool, "01PAGE0000000000000000ER01", "parent", target).await;
    seed_page(&pool, "01PAGE0000000000000000ER02", "OtherParent").await;
    seed_prop_ref(
        &pool,
        "01PAGE0000000000000000ER02",
        "parent",
        "01REFTARGET00000000000002",
    )
    .await;
    seed_page(&pool, "01PAGE0000000000000000ER03", "NoParent").await;

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::HasProperty {
                key: "parent".to_string(),
                predicate: PropertyPredicate::Eq {
                    value: PropertyValue::Ref {
                        value: target.to_string(),
                    },
                },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("Eq+Ref filter must succeed (D26)");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["Linked"],
        "Eq(parent=ref) must keep only the page whose value_ref matches"
    );
}

#[tokio::test]
async fn has_property_ne_ref_excludes_matching_value_ref() {
    // T-B4 (D26) — `HasProperty { Ne { Ref } }` keeps pages that do NOT
    // carry a `(key, value_ref)` row matching the operand.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let target = "01REFTARGET00000000000001";
    seed_page(&pool, "01PAGE0000000000000000NR01", "Linked").await;
    seed_prop_ref(&pool, "01PAGE0000000000000000NR01", "parent", target).await;
    seed_page(&pool, "01PAGE0000000000000000NR02", "OtherParent").await;
    seed_prop_ref(
        &pool,
        "01PAGE0000000000000000NR02",
        "parent",
        "01REFTARGET00000000000002",
    )
    .await;
    seed_page(&pool, "01PAGE0000000000000000NR03", "NoParent").await;

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::HasProperty {
                key: "parent".to_string(),
                predicate: PropertyPredicate::Ne {
                    value: PropertyValue::Ref {
                        value: target.to_string(),
                    },
                },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("Ne+Ref filter must succeed (D26)");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["NoParent", "OtherParent"],
        "Ne(parent=ref) must exclude the page whose value_ref matches, keep the rest"
    );
}

#[tokio::test]
async fn all_search_only_primitives_rejected_on_pages_surface() {
    // PEND-58b P2-C — parameterized over ALL FOUR search-only primitives
    // (the prior test covered only `Regex`). Each must be rejected by the
    // Pages allowed-keys gate with the `InvalidFilter` prefix.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "A").await;

    let search_only = [
        FilterPrimitive::Regex {
            pattern: "foo".to_string(),
        },
        FilterPrimitive::CaseSensitive { enabled: true },
        FilterPrimitive::WholeWord { enabled: true },
        FilterPrimitive::Snippet {
            spec: crate::filters::primitive::SnippetSpec {
                max_tokens: 5,
                left_marker: "<".to_string(),
                right_marker: ">".to_string(),
            },
        },
    ];

    for prim in search_only {
        let label = prim.allowed_key();
        let result = list_pages_with_metadata_inner(
            &pool,
            filter_with(PageSort::Alphabetical, vec![prim]),
            None,
            Some(50),
        )
        .await;
        assert!(
            result.is_err(),
            "search-only primitive `{label}` must be rejected on the Pages surface"
        );
        let err = result.unwrap_err();
        assert!(
            matches!(err, crate::error::AppError::Validation(_)),
            "`{label}` rejection must be AppError::Validation; got: {err:?}"
        );
        assert!(
            format!("{err}").contains("InvalidFilter"),
            "`{label}` rejection must carry the InvalidFilter prefix; got: {err}"
        );
    }
}

#[tokio::test]
async fn filter_tag_plus_cursor_paginates_without_dupes_or_drops() {
    // PEND-58b P1-E — the only filter+cursor test used `Stub` (zero binds,
    // so `base = 1` and the offset arithmetic was never exercised). This
    // pages a BIND-CARRYING filter (`Tag`, 1 bind ⇒ `base = 2`) across a
    // cursor at limit = 2, asserting no dupes/drops over the keyset
    // boundary. Strengthened by combining a 2-bind `HasProperty { op: Eq }`
    // with `RecentlyModified` (the keyset with the most placeholders + the
    // null sentinel), covering the highest-offset bind path.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    let tag = "01TAG000000000000000000T1";
    // 4 tagged pages that ALSO carry prop `kind = note` (2-bind filter).
    let names = ["Aa", "Bb", "Cc", "Dd"];
    for (i, name) in names.iter().enumerate() {
        let pid = format!("01PAGE0000000000000000TC{i}");
        seed_page(&pool, &pid, name).await;
        seed_tag(&pool, &pid, tag).await;
        seed_prop_text(&pool, &pid, "kind", "note").await;
        // Distinct op_log timestamps so RecentlyModified is deterministic.
        seed_op_log(&pool, &pid, &format!("2026-0{}-01T00:00:00Z", i + 1)).await;
    }
    // An untagged page that must NEVER appear in the filtered result set.
    seed_page(&pool, "01PAGE0000000000000000TCX", "Excluded").await;
    seed_prop_text(&pool, "01PAGE0000000000000000TCX", "kind", "note").await;

    let filters = vec![
        FilterPrimitive::Tag {
            tag: tag.to_string(),
        },
        FilterPrimitive::HasProperty {
            key: "kind".to_string(),
            predicate: PropertyPredicate::Eq {
                value: PropertyValue::Text {
                    value: "note".to_string(),
                },
            },
        },
    ];

    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = list_pages_with_metadata_inner(
            &pool,
            filter_with(PageSort::RecentlyModified, filters.clone()),
            cursor.clone(),
            Some(2),
        )
        .await
        .expect("bind-carrying filtered cursor page must succeed");
        for item in &page.items {
            seen.push(item.content.clone().unwrap_or_default());
        }
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
        assert!(cursor.is_some(), "has_more pages must carry a cursor");
    }

    seen.sort_unstable();
    assert_eq!(
        seen,
        vec!["Aa", "Bb", "Cc", "Dd"],
        "bind-carrying filtered pagination must return each tagged page once, Excluded never"
    );
}

// ── PEND-58d T-B2 — LastEdited end-to-end against seeded op_log ────────────
//
// Exercises all three `LastEditedSpec` variants against real `op_log`
// rows, plus the PEND-58d D7 "no-op-log ⇒ epoch" rule. The dates are
// pinned far enough apart (one "recent" page stamped ~now, one "old" page
// stamped years ago) that the rolling-window comparisons are deterministic
// regardless of when the suite runs.

/// A timestamp for "recently edited" — `datetime('now', '-1 day')`, i.e.
/// inside any rolling window of 2+ days. Computed in SQLite so it tracks
/// the same clock the filter's `datetime('now', ?)` uses.
async fn now_minus_days_iso(pool: &SqlitePool, days: i64) -> String {
    sqlx::query_scalar::<_, String>("SELECT strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', ?))")
        .bind(format!("-{days} days"))
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn last_edited_rolling_includes_recent_excludes_old_and_no_op_log() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE0000000000000000RC1", "Recent").await;
    seed_page(&pool, "01PAGE0000000000000000OLD", "Old").await;
    seed_page(&pool, "01PAGE0000000000000000NOL", "NoOpLog").await;
    // Recent: 1 day ago (inside a 7-day window).
    let recent_ts = now_minus_days_iso(&pool, 1).await;
    seed_op_log(&pool, "01PAGE0000000000000000RC1", &recent_ts).await;
    // Old: 100 days ago (outside a 7-day window).
    let old_ts = now_minus_days_iso(&pool, 100).await;
    seed_op_log(&pool, "01PAGE0000000000000000OLD", &old_ts).await;
    // NoOpLog: deliberately no op_log row.

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::LastEdited {
                spec: LastEditedSpec::Rolling { days: 7 },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("rolling filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["Recent"],
        "Rolling{{7}} must include only the recently-edited page; \
         the old page AND the no-op-log page (epoch sentinel) are excluded"
    );
}

#[tokio::test]
async fn last_edited_older_than_is_the_inverse_of_rolling() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE0000000000000000RC1", "Recent").await;
    seed_page(&pool, "01PAGE0000000000000000OLD", "Old").await;
    seed_page(&pool, "01PAGE0000000000000000NOL", "NoOpLog").await;
    let recent_ts = now_minus_days_iso(&pool, 1).await;
    seed_op_log(&pool, "01PAGE0000000000000000RC1", &recent_ts).await;
    let old_ts = now_minus_days_iso(&pool, 100).await;
    seed_op_log(&pool, "01PAGE0000000000000000OLD", &old_ts).await;

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::LastEdited {
                spec: LastEditedSpec::OlderThan { days: 7 },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("older-than filter must succeed");
    let mut contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    contents.sort_unstable();
    // OlderThan{7} is the inverse of Rolling{7}: the old page AND the
    // no-op-log page (epoch sentinel sorts before now-7d) are included; the
    // recent page is excluded. This is the D7 symmetry — under the prior
    // asymmetry the no-op-log page would have been (correctly) included by
    // OlderThan but (incorrectly) excluded by Rolling.
    assert_eq!(
        contents,
        vec!["NoOpLog", "Old"],
        "OlderThan{{7}} must include the old + no-op-log pages, exclude the recent one"
    );
}

#[tokio::test]
async fn last_edited_range_bounds_inclusive() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE0000000000000000IN1", "InRange").await;
    seed_page(&pool, "01PAGE0000000000000000BEF", "BeforeRange").await;
    seed_page(&pool, "01PAGE0000000000000000AFT", "AfterRange").await;
    seed_page(&pool, "01PAGE0000000000000000NOL", "NoOpLog").await;
    seed_op_log(&pool, "01PAGE0000000000000000IN1", "2026-02-15T00:00:00Z").await;
    seed_op_log(&pool, "01PAGE0000000000000000BEF", "2026-01-01T00:00:00Z").await;
    seed_op_log(&pool, "01PAGE0000000000000000AFT", "2026-04-01T00:00:00Z").await;
    // NoOpLog: epoch sentinel ⇒ below the range start ⇒ excluded.

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::LastEdited {
                spec: LastEditedSpec::Range {
                    start: "2026-02-01T00:00:00Z".to_string(),
                    end: "2026-03-01T00:00:00Z".to_string(),
                },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("range filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["InRange"],
        "Range must include only the page inside [start, end]; \
         before/after/no-op-log pages are excluded"
    );
}

// ── PEND-58d D15 — LastEdited Range date validation ───────────────────────

#[tokio::test]
async fn last_edited_range_rejects_malformed_and_empty_dates() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "A").await;

    // A malformed date must be rejected with the InvalidDateFilter prefix,
    // NOT silently return zero rows (the D15 bug).
    let bad = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::LastEdited {
                spec: LastEditedSpec::Range {
                    start: "2026-13-99".to_string(),
                    end: "2026-03-01".to_string(),
                },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect_err("malformed range date must be rejected");
    assert!(
        matches!(bad, crate::error::AppError::Validation(_)),
        "malformed date must be AppError::Validation; got: {bad:?}"
    );
    assert!(
        format!("{bad}").contains("InvalidDateFilter:"),
        "rejection must carry the InvalidDateFilter prefix; got: {bad}"
    );

    // An empty bound must also be rejected.
    let empty = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::LastEdited {
                spec: LastEditedSpec::Range {
                    start: "".to_string(),
                    end: "2026-03-01".to_string(),
                },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect_err("empty range start must be rejected");
    assert!(
        format!("{empty}").contains("InvalidDateFilter:"),
        "empty start must carry the InvalidDateFilter prefix; got: {empty}"
    );
}

#[tokio::test]
async fn last_edited_range_accepts_bare_calendar_date() {
    // The validator accepts a bare `YYYY-MM-DD` (the FE may emit a calendar
    // date rather than a full RFC 3339 timestamp). A valid bare date must
    // compile + execute (it compares lexically against the ISO timestamps).
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE0000000000000000IN1", "InRange").await;
    seed_op_log(&pool, "01PAGE0000000000000000IN1", "2026-02-15T00:00:00Z").await;

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::LastEdited {
                spec: LastEditedSpec::Range {
                    start: "2026-02-01".to_string(),
                    end: "2026-03-01".to_string(),
                },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("bare calendar-date range must compile and execute");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(contents, vec!["InRange"]);
}

#[tokio::test]
async fn last_edited_range_bare_end_date_includes_whole_end_day() {
    // PEND-58e E3 — a bare `YYYY-MM-DD` `end` bound must include edits made
    // during the DAYTIME of the end day, not just at its midnight boundary.
    // Before the fix, a non-midnight edit on the end day
    // (`2026-03-01T09:00:00.123Z`) was bound against a verbatim
    // `'2026-03-01'` upper bound and lexically EXCLUDED (`'…T09:…' > '…01'`),
    // silently dropping the page. The fix extends a bare end bound to the
    // end of that calendar day (`T23:59:59.999Z`).
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    // Edited at 09:00 on the END day — must be INCLUDED.
    seed_page(&pool, "01PAGE0000000000000000EDY", "EndDayDaytime").await;
    seed_op_log(
        &pool,
        "01PAGE0000000000000000EDY",
        "2026-03-01T09:00:00.123Z",
    )
    .await;
    // Edited just after the end day — must be EXCLUDED (proves the bound is
    // not over-extended past the end day).
    seed_page(&pool, "01PAGE0000000000000000NXT", "NextDay").await;
    seed_op_log(
        &pool,
        "01PAGE0000000000000000NXT",
        "2026-03-02T00:00:00.000Z",
    )
    .await;
    // Edited at 09:00 on the START day — must be INCLUDED (start lower bound
    // is already correct; this guards against a regression there).
    seed_page(&pool, "01PAGE0000000000000000STD", "StartDayDaytime").await;
    seed_op_log(
        &pool,
        "01PAGE0000000000000000STD",
        "2026-02-01T09:00:00.000Z",
    )
    .await;

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::LastEdited {
                spec: LastEditedSpec::Range {
                    start: "2026-02-01".to_string(),
                    end: "2026-03-01".to_string(),
                },
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("bare end-date range must compile and execute");
    let mut contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    contents.sort_unstable();
    assert_eq!(
        contents,
        vec!["EndDayDaytime", "StartDayDaytime"],
        "a bare end-date range must include daytime edits on BOTH the start \
         and end day, while excluding edits on the following day"
    );
}

// ── PEND-58d T-B3 — Space + Priority IPC narrowing ────────────────────────

#[tokio::test]
async fn filter_priority_narrows_to_matching_priority() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    seed_page(&pool, "01PAGE000000000000000HiP1", "HighPri").await;
    seed_priority(&pool, "01PAGE000000000000000HiP1", "A").await;
    seed_page(&pool, "01PAGE000000000000000LoP1", "LowPri").await;
    seed_priority(&pool, "01PAGE000000000000000LoP1", "B").await;
    seed_page(&pool, "01PAGE000000000000000NoP1", "NoPri").await;

    let resp = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::Priority {
                priority: "A".to_string(),
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("priority filter must succeed");
    let contents: Vec<&str> = resp
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        contents,
        vec!["HighPri"],
        "Priority A must narrow to only the page with priority A"
    );
}

#[tokio::test]
async fn filter_space_matching_request_scope_is_a_noop_narrowing() {
    // The IPC ALWAYS scopes to `filter.space_id` (the implicit space
    // scope). A `Space` filter naming that SAME space is therefore a no-op
    // narrowing — it composes (AND) with the implicit scope and returns
    // the full in-space set; a `Space` filter naming a DIFFERENT space
    // intersects to the empty set. This covers both compositions (T-B3).
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    seed_page(&pool, "01PAGE000000000000000000A1", "Alpha").await;
    seed_page(&pool, "01PAGE000000000000000000B1", "Beta").await;

    // Space filter == the request space ⇒ no-op narrowing, full set.
    let same = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::Space {
                space_id: TEST_SPACE_ID.to_string(),
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("space==request filter must succeed");
    let same_contents: Vec<&str> = same
        .items
        .iter()
        .filter_map(|p| p.content.as_deref())
        .collect();
    assert_eq!(
        same_contents,
        vec!["Alpha", "Beta"],
        "Space filter naming the request space is a no-op; full in-space set returns"
    );

    // Space filter == a DIFFERENT space ⇒ intersect to empty.
    let other = list_pages_with_metadata_inner(
        &pool,
        filter_with(
            PageSort::Alphabetical,
            vec![FilterPrimitive::Space {
                space_id: TEST_SPACE_B_ID.to_string(),
            }],
        ),
        None,
        Some(50),
    )
    .await
    .expect("space==other filter must succeed");
    assert!(
        other.items.is_empty(),
        "Space filter naming a different space must intersect the implicit scope to empty; got: {:?}",
        other
            .items
            .iter()
            .filter_map(|p| p.content.as_deref())
            .collect::<Vec<_>>()
    );
}

// ── PEND-58d D6 — total_count gated to the first page ─────────────────────

#[tokio::test]
async fn total_count_present_on_first_page_and_none_on_cursor_page() {
    // D6 — the COUNT is recomputed on every load-more page in the prior
    // shape. It must run only on the FIRST page (cursor None): `Some(n)`
    // there, `None` on every subsequent cursor page (the FE retains the
    // first total). The total does not change as the user pages through the
    // same filtered set, so recomputing it is wasted work.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    for (i, name) in ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]
        .iter()
        .enumerate()
    {
        seed_page(&pool, &format!("01PAGE0000000000000000P{i:02}"), name).await;
    }

    // First page: limit 2 of 5 ⇒ total_count == Some(5), has_more.
    let page1 =
        list_pages_with_metadata_inner(&pool, filter(PageSort::Alphabetical), None, Some(2))
            .await
            .unwrap();
    assert_eq!(
        page1.total_count,
        Some(5),
        "first page must carry the full filtered total"
    );
    assert!(page1.has_more, "5 pages at limit 2 must have more");
    let cursor = page1.next_cursor.expect("first page must carry a cursor");

    // Cursor (load-more) page: total_count must be None — the COUNT is gated
    // off on cursor pages.
    let page2 = list_pages_with_metadata_inner(
        &pool,
        filter(PageSort::Alphabetical),
        Some(cursor),
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(
        page2.total_count, None,
        "cursor (load-more) page must NOT recompute total_count (D6 gate)"
    );
}

// ── PEND-58d T-B7 — per-mode cursor discriminator round-trip ──────────────

#[tokio::test]
async fn every_sort_mode_cursor_round_trips_and_rejects_cross_mode() {
    // T-B7 — the prior coverage exercised only one pair (Alphabetical vs
    // MostLinked) plus the legacy-None arm. This asserts that EACH sort
    // mode's cursor (a) replays successfully against the same mode, and
    // (b) is rejected with RequiresRefresh against a DIFFERENT mode. The
    // discriminator is per-mode (`sort_discriminator`), so a mismatch must
    // never silently succeed.
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    // Seed enough pages (with op_log + a link + a child) that every mode
    // has a real first page and can issue a cursor.
    for (i, name) in ["Aa", "Bb", "Cc", "Dd", "Ee"].iter().enumerate() {
        let pid = format!("01PAGE0000000000000000T{i:02}");
        seed_page(&pool, &pid, name).await;
        seed_op_log(&pool, &pid, &format!("2026-0{}-01T00:00:00Z", i + 1)).await;
        seed_child(&pool, &format!("01CHILD000000000000000T{i:02}"), &pid, "x").await;
    }
    // Give one page an inbound link so MostLinked has a non-degenerate key.
    seed_link(
        &pool,
        "01PAGE0000000000000000T01",
        "01PAGE0000000000000000T00",
    )
    .await;

    let all_modes = [
        PageSort::Alphabetical,
        PageSort::RecentlyModified,
        PageSort::MostLinked,
        PageSort::MostContent,
        PageSort::Default,
    ];

    for sort in all_modes {
        // First page at limit 2 of 5 ⇒ a real cursor.
        let page1 = list_pages_with_metadata_inner(&pool, filter(sort), None, Some(2))
            .await
            .unwrap_or_else(|e| panic!("{sort:?} first page must succeed: {e}"));
        let cursor = page1
            .next_cursor
            .unwrap_or_else(|| panic!("{sort:?} first page must carry a cursor"));

        // (a) Same-mode replay must succeed.
        list_pages_with_metadata_inner(&pool, filter(sort), Some(cursor.clone()), Some(2))
            .await
            .unwrap_or_else(|e| panic!("{sort:?} same-mode replay must succeed: {e}"));

        // (b) Replay against EVERY other mode must reject with
        // RequiresRefresh (the discriminator mismatch).
        for other in all_modes {
            if other == sort {
                continue;
            }
            let err =
                list_pages_with_metadata_inner(&pool, filter(other), Some(cursor.clone()), Some(2))
                    .await
                    .expect_err(&format!(
                        "{sort:?} cursor replayed against {other:?} must reject, not succeed"
                    ));
            assert!(
                format!("{err}").contains("RequiresRefresh"),
                "{sort:?}→{other:?} mismatch must carry RequiresRefresh; got: {err}"
            );
        }
    }
}
