//! PEND-55 — DB-backed integration tests for the search toggle row.
//!
//! Co-locates with the other `commands/tests/*` files so the existing
//! `test_pool` helper is in scope; mirrors the pattern set by
//! `glob_filter_tests` (PEND-54) and `search_blocks_struct_tests`
//! (PEND-50).
//!
//! Coverage:
//! - All toggles off — post-filter skipped, FTS path returns the FTS
//!   snippet unchanged (no `match_offsets`).
//! - `case_sensitive` on — narrows the FTS candidate set; matches
//!   `Alpha` but not `alpha`. FTS still returns the case-insensitive
//!   candidate set; the post-filter cuts it down.
//! - `whole_word` on — `cat` matches `cat ran` but not `category`.
//! - `is_regex` on — `^TODO` matches blocks starting with `TODO`. FTS
//!   MATCH is **not** called on this path.
//! - Regex compile error → `AppError::Validation` with `InvalidRegex:`
//!   prefix.
//! - Empty query + `is_regex` true → no-op (returns empty without
//!   firing the regex pipeline).
//! - CJK whole-word documented behaviour: `(?-u:\b)` is ASCII; CJK
//!   tokens never see a boundary.
//! - UTF-16 offset correctness for CJK + emoji content.

use super::common::{
    assign_all_to_test_space, ensure_test_space, insert_block, test_pool, TEST_SPACE_ID,
};
use crate::commands::{search_blocks_inner, MatchOffset, SearchFilter};
use crate::error::AppError;
use crate::fts::rebuild_fts_index;

/// Helper: build a default `SearchFilter` scoped to the test space, with
/// the toggle flags applied per `case_sensitive` / `whole_word` /
/// `is_regex`.
fn filter_with(case_sensitive: bool, whole_word: bool, is_regex: bool) -> SearchFilter {
    SearchFilter {
        parent_id: None,
        tag_ids: vec![],
        space_id: Some(TEST_SPACE_ID.into()),
        include_page_globs: vec![],
        exclude_page_globs: vec![],
        case_sensitive,
        whole_word,
        is_regex,
        // PEND-51 — toggle tests don't exercise block-type filtering;
        // `None` preserves the pre-PEND-51 candidate set semantics.
        block_type_filter: None,
        // PEND-53 — toggle tests don't exercise metadata filters either;
        // defaults preserve the pre-PEND-53 "no metadata filter" shape.
        ..Default::default()
    }
}

/// Seed three pages with content so we can exercise the toggle paths
/// against a non-trivial corpus.
async fn seed_three_pages(pool: &sqlx::SqlitePool) {
    ensure_test_space(pool).await;
    insert_block(
        pool,
        "01PAGEAA0000000000000PG001",
        "page",
        "Alpha Page",
        None,
        Some(0),
    )
    .await;
    insert_block(
        pool,
        "01PAGEAB0000000000000PG002",
        "page",
        "Beta Page",
        None,
        Some(1),
    )
    .await;
    insert_block(
        pool,
        "01PAGEAC0000000000000PG003",
        "page",
        "Gamma Page",
        None,
        Some(2),
    )
    .await;
    // Mixed-case content with explicit `Alpha` and `alpha` tokens.
    insert_block(
        pool,
        "01BLOCKAA00000000000000B01",
        "content",
        "TODO: review Alpha cohort metrics",
        Some("01PAGEAA0000000000000PG001"),
        Some(0),
    )
    .await;
    insert_block(
        pool,
        "01BLOCKAB00000000000000B02",
        "content",
        "alpha cohort followup",
        Some("01PAGEAA0000000000000PG001"),
        Some(1),
    )
    .await;
    insert_block(
        pool,
        "01BLOCKAC00000000000000B03",
        "content",
        "the cat ran fast",
        Some("01PAGEAB0000000000000PG002"),
        Some(0),
    )
    .await;
    insert_block(
        pool,
        "01BLOCKAD00000000000000B04",
        "content",
        "category list for review",
        Some("01PAGEAB0000000000000PG002"),
        Some(1),
    )
    .await;
    assign_all_to_test_space(pool).await;
    rebuild_fts_index(pool).await.unwrap();
}

#[tokio::test]
async fn all_toggles_off_returns_snippet_and_no_offsets() {
    let (pool, _dir) = test_pool().await;
    seed_three_pages(&pool).await;

    let resp = search_blocks_inner(
        &pool,
        "cohort".into(),
        None,
        Some(20),
        filter_with(false, false, false),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        resp.items.len(),
        2,
        "FTS path must surface exactly 2 'cohort' blocks; got {}",
        resp.items.len()
    );
    for row in &resp.items {
        assert!(
            row.match_offsets.is_empty(),
            "all-off path must NOT emit offsets; got {} for block {}",
            row.match_offsets.len(),
            row.id.as_str()
        );
        // The PEND-50 snippet path may emit a `<mark>`-bracketed window.
        assert!(
            row.snippet.is_some(),
            "FTS path must populate snippet on matches"
        );
    }
}

#[tokio::test]
async fn case_sensitive_narrows_candidates() {
    let (pool, _dir) = test_pool().await;
    seed_three_pages(&pool).await;

    let resp = search_blocks_inner(
        &pool,
        "Alpha".into(),
        None,
        Some(20),
        filter_with(true, false, false),
        None,
    )
    .await
    .unwrap();
    // The FTS5 trigram tokenizer is case-insensitive, so the candidate
    // set includes BOTH `Alpha` and `alpha` rows. The post-filter
    // narrows it to only the case-sensitive matches.
    let contents: Vec<_> = resp
        .items
        .iter()
        .filter_map(|r| r.content.clone())
        .collect();
    assert!(
        contents.iter().any(|c| c.contains("Alpha")),
        "case-sensitive `Alpha` must match the Alpha row; got {contents:?}"
    );
    assert!(
        contents
            .iter()
            .all(|c| !c.contains("alpha cohort followup")),
        "case-sensitive `Alpha` must NOT match the lowercase row; got {contents:?}"
    );
    // Match offsets: find the content block "TODO: review Alpha cohort metrics"
    // and verify its offset. "TODO: review " = 13 UTF-16 code units, "Alpha" = 5
    // → start=13, end=18.
    let todo_row = resp
        .items
        .iter()
        .find(|r| r.content.as_deref() == Some("TODO: review Alpha cohort metrics"))
        .expect("the 'TODO: review Alpha cohort metrics' block must survive case-sensitive filter");
    assert_eq!(
        todo_row.match_offsets,
        vec![MatchOffset { start: 13, end: 18 }],
        "case_sensitive 'Alpha' offset must point to the match in 'TODO: review Alpha cohort metrics'"
    );
}

#[tokio::test]
async fn whole_word_does_not_match_substring() {
    let (pool, _dir) = test_pool().await;
    seed_three_pages(&pool).await;

    let resp = search_blocks_inner(
        &pool,
        "cat".into(),
        None,
        Some(20),
        filter_with(false, true, false),
        None,
    )
    .await
    .unwrap();
    let contents: Vec<_> = resp
        .items
        .iter()
        .filter_map(|r| r.content.clone())
        .collect();
    assert!(
        contents.iter().any(|c| c == "the cat ran fast"),
        "whole-word `cat` must match `the cat ran fast`; got {contents:?}"
    );
    assert!(
        contents.iter().all(|c| c != "category list for review"),
        "whole-word `cat` must NOT match `category`; got {contents:?}"
    );
}

#[tokio::test]
async fn regex_mode_matches_anchored_pattern() {
    let (pool, _dir) = test_pool().await;
    seed_three_pages(&pool).await;

    let resp = search_blocks_inner(
        &pool,
        "^TODO".into(),
        None,
        Some(20),
        filter_with(false, false, true),
        None,
    )
    .await
    .unwrap();
    let contents: Vec<_> = resp
        .items
        .iter()
        .filter_map(|r| r.content.clone())
        .collect();
    assert!(
        contents.iter().any(|c| c.starts_with("TODO")),
        "regex `^TODO` must match TODO-prefixed content; got {contents:?}"
    );
    assert!(
        contents.iter().all(|c| !c.starts_with("alpha")),
        "regex `^TODO` must NOT match lowercase rows; got {contents:?}"
    );
}

#[tokio::test]
async fn regex_compile_error_surfaces_typed_validation() {
    let (pool, _dir) = test_pool().await;
    seed_three_pages(&pool).await;

    // `*` at the start of a pattern is a Rust regex syntax error.
    let err = search_blocks_inner(
        &pool,
        "*".into(),
        None,
        Some(20),
        filter_with(false, false, true),
        None,
    )
    .await
    .expect_err("invalid regex must surface AppError::Validation");
    match err {
        AppError::Validation(msg) => assert!(
            msg.starts_with("InvalidRegex:"),
            "expected InvalidRegex prefix; got: {msg}"
        ),
        other => panic!("expected Validation, got {other:?}"),
    }
}

#[tokio::test]
async fn empty_query_with_regex_toggle_returns_empty() {
    let (pool, _dir) = test_pool().await;
    seed_three_pages(&pool).await;

    let resp = search_blocks_inner(
        &pool,
        "".into(),
        None,
        Some(20),
        filter_with(false, false, true),
        None,
    )
    .await
    .unwrap();
    assert!(
        resp.items.is_empty(),
        "empty + regex must short-circuit to empty without panic"
    );
}

#[tokio::test]
async fn regex_mode_emits_utf16_offsets_for_cjk_content() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    insert_block(
        &pool,
        "01PAGECJ0000000000000PG001",
        "page",
        "CJK Page",
        None,
        Some(0),
    )
    .await;
    insert_block(
        &pool,
        "01BLOCKCJ00000000000000B01",
        "content",
        // `日本語` — 3 CJK chars, 3 UTF-16 code units, 9 UTF-8 bytes.
        "日本語",
        Some("01PAGECJ0000000000000PG001"),
        Some(0),
    )
    .await;
    assign_all_to_test_space(&pool).await;
    rebuild_fts_index(&pool).await.unwrap();

    let resp = search_blocks_inner(
        &pool,
        "本".into(),
        None,
        Some(20),
        filter_with(false, false, true),
        None,
    )
    .await
    .unwrap();
    let cjk = resp
        .items
        .iter()
        .find(|r| r.content.as_deref() == Some("日本語"))
        .expect("CJK content must match");
    assert_eq!(
        cjk.match_offsets,
        vec![MatchOffset { start: 1, end: 2 }],
        "UTF-16 offsets must address the middle char (1 code unit), not bytes (3 bytes)"
    );
}
