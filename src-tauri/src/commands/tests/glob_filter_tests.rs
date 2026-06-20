//! integration tests for the inline filter syntax's
//! page-name glob filtering pipeline.
//!
//! These tests exercise the full chain: `SearchFilter.include_page_globs`
//! / `exclude_page_globs` → `fts::glob_filter::prepare_globs` →
//! `fts::search_fts`'s SQL composition → SQLite `GLOB` evaluation.
//!
//! The fixtures populate `pages_cache.title` directly (the materializer
//! does the same in production); the FTS index is populated against
//! block content for each row so `search_blocks` actually returns
//! matching rows.

use crate::commands::queries::{SearchFilter, search_blocks_inner};
use crate::db::init_pool;
use sqlx::SqlitePool;
use tempfile::TempDir;

async fn pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let p = init_pool(dir.path().join("test.db").as_path())
        .await
        .unwrap();
    (p, dir)
}

/// Insert a page + a content block in that page + an FTS row, plus a
/// `pages_cache.title` row so the glob filter has something to match.
async fn seed_page_with_block(
    pool: &SqlitePool,
    page_id: &str,
    page_title: &str,
    content_block_id: &str,
    content: &str,
) {
    // Page block — page_id == id by §5.3 invariant.
    sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) VALUES (?, 'page', ?, NULL, NULL, ?)")
        .bind(page_id)
        .bind(page_title)
        .bind(page_id)
        .execute(pool).await.unwrap();
    // Content block under the page.
    sqlx::query("INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) VALUES (?, 'content', ?, ?, 0, ?)")
        .bind(content_block_id)
        .bind(content)
        .bind(page_id)
        .bind(page_id)
        .execute(pool).await.unwrap();
    // Page cache.
    sqlx::query(
        "INSERT INTO pages_cache (page_id, title, updated_at) VALUES (?, ?, 1704067200000)",
    )
    .bind(page_id)
    .bind(page_title)
    .execute(pool)
    .await
    .unwrap();
    // FTS rows — content block must be findable via FTS5.
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind(content_block_id)
        .bind(content)
        .execute(pool)
        .await
        .unwrap();
    // Also index the page block so page-title hits work.
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind(page_id)
        .bind(page_title)
        .execute(pool)
        .await
        .unwrap();
}

const P_JOURNAL_25: &str = "01HQPGJN25000000000000P001";
const P_JOURNAL_26: &str = "01HQPGJN26000000000000P002";
const P_ARCHIVE: &str = "01HQPGAR00000000000000P003";
const P_MEETING: &str = "01HQPGMT00000000000000P004";
const B_JOURNAL_25: &str = "01HQBLJN25000000000000B001";
const B_JOURNAL_26: &str = "01HQBLJN26000000000000B002";
const B_ARCHIVE: &str = "01HQBLAR00000000000000B003";
const B_MEETING: &str = "01HQBLMT00000000000000B004";

async fn seed_corpus(pool: &SqlitePool) {
    seed_page_with_block(
        pool,
        P_JOURNAL_25,
        "Journal/2025-12-31",
        B_JOURNAL_25,
        "alpha shared",
    )
    .await;
    seed_page_with_block(
        pool,
        P_JOURNAL_26,
        "Journal/2026-05-17",
        B_JOURNAL_26,
        "alpha shared",
    )
    .await;
    seed_page_with_block(
        pool,
        P_ARCHIVE,
        "Archive/2024-thoughts",
        B_ARCHIVE,
        "alpha shared",
    )
    .await;
    seed_page_with_block(pool, P_MEETING, "Meeting Notes", B_MEETING, "alpha shared").await;
}

#[tokio::test]
async fn empty_include_and_exclude_returns_all_matches() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter::default(),
        None,
    )
    .await
    .unwrap();
    // 4 content blocks + 0 page-title hits because none contain "alpha".
    assert_eq!(resp.items.len(), 4, "got {} items", resp.items.len());
}

#[tokio::test]
async fn include_glob_prefix_anchored() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            include_page_globs: vec!["Journal/*".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let page_ids: Vec<_> = resp
        .items
        .iter()
        .filter_map(|r| r.page_id.clone())
        .collect();
    assert!(
        page_ids
            .iter()
            .all(|p| p == P_JOURNAL_25 || p == P_JOURNAL_26),
        "expected only Journal hits, got {page_ids:?}"
    );
    assert_eq!(resp.items.len(), 2);
}

#[tokio::test]
async fn include_glob_case_insensitive() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    // Same as above but lowercase prefix — must match "Journal/2025-…".
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            include_page_globs: vec!["journal/*".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(resp.items.len(), 2);
}

#[tokio::test]
async fn include_glob_substring_default() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    // Bare token with no `*` — wraps to `*meeting*` and matches "Meeting Notes".
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            include_page_globs: vec!["meeting".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(resp.items.len(), 1);
    assert_eq!(resp.items[0].page_id.as_deref(), Some(P_MEETING));
}

#[tokio::test]
async fn brace_expansion_unions() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            include_page_globs: vec!["{Journal,Archive}/*".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    // Journal/2025-…, Journal/2026-…, Archive/2024-thoughts.
    assert_eq!(resp.items.len(), 3);
}

#[tokio::test]
async fn comma_separated_unions() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            include_page_globs: vec!["Journal/*,Meeting*".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(resp.items.len(), 3);
}

#[tokio::test]
async fn include_and_exclude_compose_with_and_intersection() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            include_page_globs: vec!["Journal/*".into()],
            exclude_page_globs: vec!["*2025*".into()],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    let page_ids: Vec<_> = resp
        .items
        .iter()
        .filter_map(|r| r.page_id.clone())
        .collect();
    assert_eq!(resp.items.len(), 1);
    assert_eq!(page_ids[0], P_JOURNAL_26);
}

#[tokio::test]
async fn brace_nesting_returns_validation_error() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let result = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            include_page_globs: vec!["{a,{b,c}}".into()],
            ..Default::default()
        },
        None,
    )
    .await;
    let err = result.unwrap_err();
    let msg = format!("{err:?}");
    assert!(
        msg.contains("InvalidGlob") && msg.contains("brace nesting"),
        "got {msg}"
    );
}

#[tokio::test]
async fn unbalanced_bracket_returns_validation_error() {
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    let result = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            include_page_globs: vec!["[unclosed".into()],
            ..Default::default()
        },
        None,
    )
    .await;
    let err = result.unwrap_err();
    let msg = format!("{err:?}");
    assert!(
        msg.contains("InvalidGlob") && msg.contains("unbalanced bracket"),
        "got {msg}"
    );
}

#[tokio::test]
async fn legacy_tag_and_filter_still_works() {
    // Regression: extending `SearchFilter` with the new glob fields
    // must not change the behaviour of an unrelated filter.
    let (pool, _dir) = pool().await;
    seed_corpus(&pool).await;
    // Use empty tag_ids — the pre- default; should return all
    // alpha hits without filtering.
    let resp = search_blocks_inner(
        &pool,
        "alpha".into(),
        None,
        Some(50),
        SearchFilter {
            tag_ids: vec![],
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(resp.items.len(), 4);
}
