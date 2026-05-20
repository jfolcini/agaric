//! PEND-56 Phase 1 — tests for `list_pages_with_metadata_inner`.
//!
//! Covers: the four metadata columns, all five sort modes, cursor
//! pagination across modes, the has-property bitmask, space filtering,
//! and limit-clamp validation.

#![cfg(test)]

use sqlx::SqlitePool;

use crate::commands::pages::{
    list_pages_with_metadata_inner, ListPagesWithMetadataFilter, PageSort, PageWithMetadataRow,
};
use crate::commands::tests::common::{
    assign_to_space, ensure_test_space, ensure_test_space_b, insert_block, test_pool,
    TEST_SPACE_B_ID, TEST_SPACE_ID,
};

// ── Fixture builders ──────────────────────────────────────────────────────

/// Seed a page with the given id and content into [`TEST_SPACE_ID`].
async fn seed_page(pool: &SqlitePool, id: &str, content: &str) {
    insert_block(pool, id, "page", content, None, Some(0)).await;
    assign_to_space(pool, id, TEST_SPACE_ID).await;
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
async fn seed_link(pool: &SqlitePool, source: &str, target: &str) {
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(source)
        .bind(target)
        .execute(pool)
        .await
        .unwrap();
}

/// Seed a child content block under `parent_page`.
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

fn filter(sort: PageSort) -> ListPagesWithMetadataFilter {
    ListPagesWithMetadataFilter {
        sort,
        space_id: TEST_SPACE_ID.to_string(),
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
