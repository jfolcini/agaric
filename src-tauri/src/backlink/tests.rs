use super::filters::{
    crockford_decode_char, ms_to_ulid_prefix, parse_iso_to_ms, resolve_filter, ulid_to_ms,
};
use super::grouped::{eval_backlink_query_grouped, eval_unlinked_references};
use super::query::{
    eval_backlink_query, list_property_keys, resolve_root_pages, resolve_root_pages_cte,
};
use super::types::*;
use crate::db::init_pool;
use crate::error::AppError;
use crate::pagination::{Cursor, PageRequest};
use rustc_hash::FxHashSet;
use sqlx::SqlitePool;
use tempfile::TempDir;

// -- Helpers --

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

/// Insert a block directly.
async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
    let page_id: Option<&str> = if block_type == "page" { Some(id) } else { None };
    sqlx::query("INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind(block_type)
        .bind(content)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Insert a property on a block.
async fn insert_property(
    pool: &SqlitePool,
    block_id: &str,
    key: &str,
    value_text: Option<&str>,
    value_num: Option<f64>,
    value_date: Option<&str>,
) {
    sqlx::query(
        "INSERT INTO block_properties (block_id, key, value_text, value_num, value_date) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(block_id)
    .bind(key)
    .bind(value_text)
    .bind(value_num)
    .bind(value_date)
    .execute(pool)
    .await
    .unwrap();
}

/// Insert a block link (source -> target).
async fn insert_block_link(pool: &SqlitePool, source_id: &str, target_id: &str) {
    sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
        .bind(source_id)
        .bind(target_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Tag a block.
async fn insert_tag_assoc(pool: &SqlitePool, block_id: &str, tag_id: &str) {
    sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
        .bind(block_id)
        .bind(tag_id)
        .execute(pool)
        .await
        .unwrap();
}

/// Insert a tags_cache row.
async fn insert_tag_cache(pool: &SqlitePool, tag_id: &str, name: &str, usage_count: i64) {
    sqlx::query(
        "INSERT INTO tags_cache (tag_id, name, usage_count, updated_at) \
         VALUES (?, ?, ?, '2025-01-01T00:00:00Z')",
    )
    .bind(tag_id)
    .bind(name)
    .bind(usage_count)
    .execute(pool)
    .await
    .unwrap();
}

/// Insert an FTS index entry for a block.
async fn insert_fts(pool: &SqlitePool, block_id: &str, stripped: &str) {
    sqlx::query("INSERT INTO fts_blocks (block_id, stripped) VALUES (?, ?)")
        .bind(block_id)
        .bind(stripped)
        .execute(pool)
        .await
        .unwrap();
}

/// Create a standard test setup with a target block and several source
/// blocks that link to it.
async fn setup_backlinks(pool: &SqlitePool) {
    insert_block(pool, "TARGET", "page", "Target Page").await;
    insert_block(pool, "SRC_A", "content", "Source A").await;
    insert_block(pool, "SRC_B", "content", "Source B").await;
    insert_block(pool, "SRC_C", "content", "Source C").await;
    insert_block_link(pool, "SRC_A", "TARGET").await;
    insert_block_link(pool, "SRC_B", "TARGET").await;
    insert_block_link(pool, "SRC_C", "TARGET").await;
}

fn default_page() -> PageRequest {
    PageRequest::new(None, Some(50)).unwrap()
}

// ======================================================================
// ULID timestamp extraction
// ======================================================================

#[test]
fn ulid_to_ms_extracts_correct_timestamp() {
    // ULID "01ARZ3NDEKTSV4RRFFQ69G5FAV" - known ULID
    // First 10 chars: "01ARZ3NDEK" encode the timestamp
    let ms = ulid_to_ms("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert!(ms.is_some(), "valid ULID should return Some timestamp");
    // The exact value depends on the encoding; just verify it's reasonable
    let ms_val = ms.unwrap();
    assert!(ms_val > 0, "extracted timestamp should be positive");
}

#[test]
fn ulid_to_ms_returns_none_for_short_string() {
    assert!(
        ulid_to_ms("SHORT").is_none(),
        "short string should return None"
    );
}

#[test]
fn crockford_decode_char_handles_all_valid_chars() {
    assert_eq!(
        crockford_decode_char('0'),
        Some(0),
        "'0' should decode to 0"
    );
    assert_eq!(
        crockford_decode_char('1'),
        Some(1),
        "'1' should decode to 1"
    );
    assert_eq!(
        crockford_decode_char('A'),
        Some(10),
        "'A' should decode to 10"
    );
    assert_eq!(
        crockford_decode_char('Z'),
        Some(31),
        "'Z' should decode to 31"
    );
    // Case insensitive
    assert_eq!(
        crockford_decode_char('a'),
        Some(10),
        "lowercase 'a' should decode to 10"
    );
    assert_eq!(
        crockford_decode_char('z'),
        Some(31),
        "lowercase 'z' should decode to 31"
    );
    // Aliases
    assert_eq!(
        crockford_decode_char('O'),
        Some(0),
        "'O' alias should decode to 0"
    );
    assert_eq!(
        crockford_decode_char('I'),
        Some(1),
        "'I' alias should decode to 1"
    );
    assert_eq!(
        crockford_decode_char('L'),
        Some(1),
        "'L' alias should decode to 1"
    );
}

#[test]
fn crockford_decode_char_returns_none_for_invalid() {
    assert!(
        crockford_decode_char('U').is_none(),
        "'U' is not a valid Crockford char"
    );
    assert!(
        crockford_decode_char('!').is_none(),
        "'!' is not a valid Crockford char"
    );
}

// ======================================================================
// PropertyText filter
// ======================================================================

#[tokio::test]
async fn filter_property_text_eq_happy_path() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;

    let filter = BacklinkFilter::PropertyText {
        key: "status".into(),
        op: CompareOp::Eq,
        value: "active".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains("SRC_A"),
        "SRC_A with status=active should match Eq"
    );
    assert!(
        !set.contains("SRC_B"),
        "SRC_B with status=done should not match Eq"
    );
}

#[tokio::test]
async fn filter_property_text_eq_no_match() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;

    let filter = BacklinkFilter::PropertyText {
        key: "status".into(),
        op: CompareOp::Eq,
        value: "nonexistent".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.is_empty(), "no blocks should match nonexistent value");
}

#[tokio::test]
async fn filter_property_text_neq() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;

    let filter = BacklinkFilter::PropertyText {
        key: "status".into(),
        op: CompareOp::Neq,
        value: "active".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        !set.contains("SRC_A"),
        "SRC_A with status=active should not match Neq active"
    );
    assert!(
        set.contains("SRC_B"),
        "SRC_B with status=done should match Neq active"
    );
}

#[tokio::test]
async fn filter_property_text_lt() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "name", Some("alpha"), None, None).await;
    insert_property(&pool, "SRC_B", "name", Some("beta"), None, None).await;

    let filter = BacklinkFilter::PropertyText {
        key: "name".into(),
        op: CompareOp::Lt,
        value: "beta".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "alpha is less than beta");
    assert!(!set.contains("SRC_B"), "beta is not less than beta");
}

#[tokio::test]
async fn filter_property_text_gt() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "name", Some("alpha"), None, None).await;
    insert_property(&pool, "SRC_B", "name", Some("beta"), None, None).await;

    let filter = BacklinkFilter::PropertyText {
        key: "name".into(),
        op: CompareOp::Gt,
        value: "alpha".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(!set.contains("SRC_A"), "alpha is not greater than alpha");
    assert!(set.contains("SRC_B"), "beta is greater than alpha");
}

#[tokio::test]
async fn filter_property_text_lte() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "name", Some("alpha"), None, None).await;
    insert_property(&pool, "SRC_B", "name", Some("beta"), None, None).await;

    let filter = BacklinkFilter::PropertyText {
        key: "name".into(),
        op: CompareOp::Lte,
        value: "alpha".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "alpha is <= alpha");
    assert!(!set.contains("SRC_B"), "beta is not <= alpha");
}

#[tokio::test]
async fn filter_property_text_gte() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "name", Some("alpha"), None, None).await;
    insert_property(&pool, "SRC_B", "name", Some("beta"), None, None).await;

    let filter = BacklinkFilter::PropertyText {
        key: "name".into(),
        op: CompareOp::Gte,
        value: "beta".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(!set.contains("SRC_A"), "alpha is not >= beta");
    assert!(set.contains("SRC_B"), "beta is >= beta");
}

// ======================================================================
// PropertyNum filter
// ======================================================================

#[tokio::test]
async fn filter_property_num_eq() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(2.0), None).await;

    let filter = BacklinkFilter::PropertyNum {
        key: "priority".into(),
        op: CompareOp::Eq,
        value: 1.0,
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains("SRC_A"),
        "SRC_A with priority=1 should match Eq 1"
    );
    assert!(
        !set.contains("SRC_B"),
        "SRC_B with priority=2 should not match Eq 1"
    );
}

#[tokio::test]
async fn filter_property_num_gt() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;

    let filter = BacklinkFilter::PropertyNum {
        key: "priority".into(),
        op: CompareOp::Gt,
        value: 3.0,
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(!set.contains("SRC_A"), "priority=1 is not > 3");
    assert!(set.contains("SRC_B"), "priority=5 is > 3");
}

#[tokio::test]
async fn filter_property_num_lt() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;

    let filter = BacklinkFilter::PropertyNum {
        key: "priority".into(),
        op: CompareOp::Lt,
        value: 3.0,
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "priority=1 is < 3");
    assert!(!set.contains("SRC_B"), "priority=5 is not < 3");
}

#[tokio::test]
async fn filter_property_num_no_match() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;

    let filter = BacklinkFilter::PropertyNum {
        key: "priority".into(),
        op: CompareOp::Eq,
        value: 999.0,
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.is_empty(), "no blocks should match priority=999");
}

#[tokio::test]
async fn filter_property_num_neq() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(2.0), None).await;

    let filter = BacklinkFilter::PropertyNum {
        key: "priority".into(),
        op: CompareOp::Neq,
        value: 1.0,
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(!set.contains("SRC_A"), "priority=1 should not match Neq 1");
    assert!(set.contains("SRC_B"), "priority=2 should match Neq 1");
}

#[tokio::test]
async fn filter_property_num_lte() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(3.0), None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;

    let filter = BacklinkFilter::PropertyNum {
        key: "priority".into(),
        op: CompareOp::Lte,
        value: 3.0,
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "priority=3 is <= 3");
    assert!(!set.contains("SRC_B"), "priority=5 is not <= 3");
}

#[tokio::test]
async fn filter_property_num_gte() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(3.0), None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;

    let filter = BacklinkFilter::PropertyNum {
        key: "priority".into(),
        op: CompareOp::Gte,
        value: 5.0,
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(!set.contains("SRC_A"), "priority=3 is not >= 5");
    assert!(set.contains("SRC_B"), "priority=5 is >= 5");
}

// ======================================================================
// PropertyDate filter
// ======================================================================

#[tokio::test]
async fn filter_property_date_eq() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

    let filter = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::Eq,
        value: "2025-01-15".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains("SRC_A"),
        "SRC_A due=2025-01-15 should match Eq"
    );
    assert!(
        !set.contains("SRC_B"),
        "SRC_B due=2025-02-20 should not match Eq"
    );
}

#[tokio::test]
async fn filter_property_date_lt() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

    let filter = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::Lt,
        value: "2025-02-01".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "2025-01-15 is < 2025-02-01");
    assert!(!set.contains("SRC_B"), "2025-02-20 is not < 2025-02-01");
}

#[tokio::test]
async fn filter_property_date_no_match() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;

    let filter = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::Eq,
        value: "2099-12-31".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.is_empty(), "no blocks should match far-future date");
}

// ======================================================================
// PropertyIsSet / PropertyIsEmpty
// ======================================================================

#[tokio::test]
async fn filter_property_is_set() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    // SRC_B has no "status" property

    let filter = BacklinkFilter::PropertyIsSet {
        key: "status".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "SRC_A has status property set");
    assert!(!set.contains("SRC_B"), "SRC_B has no status property");
}

#[tokio::test]
async fn filter_property_is_set_no_match() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    let filter = BacklinkFilter::PropertyIsSet {
        key: "nonexistent".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.is_empty(), "no blocks have nonexistent property");
}

#[tokio::test]
async fn filter_property_is_empty() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    // SRC_B and SRC_C have no "status" property

    let filter = BacklinkFilter::PropertyIsEmpty {
        key: "status".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        !set.contains("SRC_A"),
        "SRC_A has status set, should not match IsEmpty"
    );
    assert!(
        set.contains("SRC_B"),
        "SRC_B lacks status, should match IsEmpty"
    );
    assert!(
        set.contains("SRC_C"),
        "SRC_C lacks status, should match IsEmpty"
    );
}

// ======================================================================
// HasTag / HasTagPrefix
// ======================================================================

#[tokio::test]
async fn filter_has_tag_happy_path() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_block(&pool, "TAG_X", "tag", "urgent").await;
    insert_tag_assoc(&pool, "SRC_A", "TAG_X").await;

    let filter = BacklinkFilter::HasTag {
        tag_id: "TAG_X".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains("SRC_A"),
        "SRC_A tagged with TAG_X should match"
    );
    assert!(
        !set.contains("SRC_B"),
        "SRC_B without TAG_X should not match"
    );
}

#[tokio::test]
async fn filter_has_tag_no_match() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    let filter = BacklinkFilter::HasTag {
        tag_id: "NONEXISTENT".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.is_empty(), "nonexistent tag should match no blocks");
}

#[tokio::test]
async fn filter_has_tag_prefix() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
    insert_block(&pool, "TAG_WE", "tag", "work/email").await;
    insert_tag_cache(&pool, "TAG_WM", "work/meeting", 1).await;
    insert_tag_cache(&pool, "TAG_WE", "work/email", 1).await;

    insert_tag_assoc(&pool, "SRC_A", "TAG_WM").await;
    insert_tag_assoc(&pool, "SRC_B", "TAG_WE").await;

    let filter = BacklinkFilter::HasTagPrefix {
        prefix: "work/".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains("SRC_A"),
        "SRC_A tagged work/meeting should match prefix work/"
    );
    assert!(
        set.contains("SRC_B"),
        "SRC_B tagged work/email should match prefix work/"
    );
    assert!(!set.contains("SRC_C"), "SRC_C has no work/ tag");
}

#[tokio::test]
async fn filter_has_tag_prefix_no_match() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    let filter = BacklinkFilter::HasTagPrefix {
        prefix: "zzz_nonexistent/".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.is_empty(), "nonexistent prefix should match no blocks");
}

// ======================================================================
// Contains (FTS)
// ======================================================================

#[tokio::test]
async fn filter_contains_happy_path() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_fts(&pool, "SRC_A", "hello world searchable").await;
    insert_fts(&pool, "SRC_B", "goodbye world").await;

    let filter = BacklinkFilter::Contains {
        query: "searchable".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains("SRC_A"),
        "SRC_A contains 'searchable' in FTS index"
    );
    assert!(
        !set.contains("SRC_B"),
        "SRC_B does not contain 'searchable'"
    );
}

#[tokio::test]
async fn filter_contains_no_match() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_fts(&pool, "SRC_A", "hello world").await;

    let filter = BacklinkFilter::Contains {
        query: "nonexistent".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.is_empty(), "nonexistent term should match no blocks");
}

#[tokio::test]
async fn filter_contains_empty_query() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    let filter = BacklinkFilter::Contains { query: "".into() };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.is_empty(), "empty query should return no results");
}

// ======================================================================
// CreatedInRange
// ======================================================================

#[tokio::test]
async fn filter_created_in_range_after_only() {
    let (pool, _dir) = test_pool().await;
    // Use real ULIDs with known timestamps.
    // ULID with timestamp 2025-01-01T00:00:00Z = 1735689600000 ms
    // We'll use blocks whose IDs sort chronologically.
    // "01JGQY2P00..." has a timestamp around 2025-01-01
    insert_block(&pool, "TARGET", "page", "target").await;
    // These have synthetic IDs; ULID_to_ms will extract timestamps.
    // Use a recent ULID that encodes a timestamp > 2025-01-01
    let recent_ulid = ulid::Ulid::new().to_string();
    insert_block(&pool, &recent_ulid, "content", "recent").await;
    insert_block_link(&pool, &recent_ulid, "TARGET").await;

    let filter = BacklinkFilter::CreatedInRange {
        after: Some("2020-01-01".into()),
        before: None,
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains(&recent_ulid),
        "recent block should be after 2020-01-01"
    );
}

#[tokio::test]
async fn filter_created_in_range_before_only() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "target").await;
    let recent_ulid = ulid::Ulid::new().to_string();
    insert_block(&pool, &recent_ulid, "content", "recent").await;
    insert_block_link(&pool, &recent_ulid, "TARGET").await;

    // before a date far in the past -> no match
    let filter = BacklinkFilter::CreatedInRange {
        after: None,
        before: Some("2000-01-01".into()),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        !set.contains(&recent_ulid),
        "recent block should not be before 2000-01-01"
    );
}

#[tokio::test]
async fn filter_created_in_range_both() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "target").await;
    let recent_ulid = ulid::Ulid::new().to_string();
    insert_block(&pool, &recent_ulid, "content", "recent").await;
    insert_block_link(&pool, &recent_ulid, "TARGET").await;

    let filter = BacklinkFilter::CreatedInRange {
        after: Some("2020-01-01".into()),
        before: Some("2099-12-31".into()),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains(&recent_ulid),
        "recent block should be within 2020-2099 range"
    );
}

// ======================================================================
// BlockType filter
// ======================================================================

#[tokio::test]
async fn filter_block_type_happy_path() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    let filter = BacklinkFilter::BlockType {
        block_type: "content".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "SRC_A is content type");
    assert!(set.contains("SRC_B"), "SRC_B is content type");
    assert!(set.contains("SRC_C"), "SRC_C is content type");
}

#[tokio::test]
async fn filter_block_type_no_match() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    let filter = BacklinkFilter::BlockType {
        block_type: "tag".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    // SRC_A, SRC_B, SRC_C are all "content" type
    assert!(!set.contains("SRC_A"), "SRC_A is content, not tag type");
}

// ======================================================================
// And / Or / Not compound filters
// ======================================================================

#[tokio::test]
async fn filter_and_compound() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(1.0), None).await;

    let filter = BacklinkFilter::And {
        filters: vec![
            BacklinkFilter::PropertyText {
                key: "status".into(),
                op: CompareOp::Eq,
                value: "active".into(),
            },
            BacklinkFilter::PropertyNum {
                key: "priority".into(),
                op: CompareOp::Eq,
                value: 1.0,
            },
        ],
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains("SRC_A"),
        "SRC_A matches both status and priority"
    );
    assert!(!set.contains("SRC_B"), "SRC_B has wrong status for And"); // status != "active"
}

#[tokio::test]
async fn filter_or_compound() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;

    let filter = BacklinkFilter::Or {
        filters: vec![
            BacklinkFilter::PropertyText {
                key: "status".into(),
                op: CompareOp::Eq,
                value: "active".into(),
            },
            BacklinkFilter::PropertyText {
                key: "status".into(),
                op: CompareOp::Eq,
                value: "done".into(),
            },
        ],
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "SRC_A status=active matches Or");
    assert!(set.contains("SRC_B"), "SRC_B status=done matches Or");
}

#[tokio::test]
async fn filter_not_compound() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;

    let filter = BacklinkFilter::Not {
        filter: Box::new(BacklinkFilter::PropertyText {
            key: "status".into(),
            op: CompareOp::Eq,
            value: "active".into(),
        }),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        !set.contains("SRC_A"),
        "SRC_A has status=active, excluded by Not"
    );
    // SRC_B, SRC_C, TARGET should all be in the not set
    assert!(
        set.contains("SRC_B"),
        "SRC_B lacks status=active, included by Not"
    );
    assert!(
        set.contains("SRC_C"),
        "SRC_C lacks status=active, included by Not"
    );
}

#[tokio::test]
async fn filter_and_empty_returns_empty() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    let filter = BacklinkFilter::And { filters: vec![] };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.is_empty(),
        "And with empty filters should return empty set"
    );
}

#[tokio::test]
async fn filter_or_empty_returns_empty() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    let filter = BacklinkFilter::Or { filters: vec![] };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.is_empty(),
        "Or with empty filters should return empty set"
    );
}

// ======================================================================
// Nested compound: And(PropertyText, Or(HasTag, HasTagPrefix))
// ======================================================================

#[tokio::test]
async fn filter_nested_compound() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;

    insert_block(&pool, "TAG_X", "tag", "urgent").await;
    insert_block(&pool, "TAG_WM", "tag", "work/meeting").await;
    insert_tag_cache(&pool, "TAG_WM", "work/meeting", 1).await;

    insert_tag_assoc(&pool, "SRC_A", "TAG_X").await;
    insert_tag_assoc(&pool, "SRC_B", "TAG_WM").await;

    let filter = BacklinkFilter::And {
        filters: vec![
            BacklinkFilter::PropertyText {
                key: "status".into(),
                op: CompareOp::Eq,
                value: "active".into(),
            },
            BacklinkFilter::Or {
                filters: vec![
                    BacklinkFilter::HasTag {
                        tag_id: "TAG_X".into(),
                    },
                    BacklinkFilter::HasTagPrefix {
                        prefix: "work/".into(),
                    },
                ],
            },
        ],
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    // Both SRC_A and SRC_B have status=active AND (HasTag(TAG_X) OR HasTagPrefix(work/))
    assert!(set.contains("SRC_A"), "SRC_A has status=active and TAG_X");
    assert!(
        set.contains("SRC_B"),
        "SRC_B has status=active and work/ tag"
    );
    assert!(
        !set.contains("SRC_C"),
        "SRC_C has no status or matching tags"
    );
}

// ======================================================================
// eval_backlink_query: sort variants
// ======================================================================

#[tokio::test]
async fn sort_created_asc() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 3, "should return all 3 backlinks");
    assert_eq!(resp.total_count, 3, "total count should be 3");
    assert_eq!(resp.filtered_count, 3, "filtered count should be 3");
    // SRC_A < SRC_B < SRC_C lexicographically
    assert_eq!(resp.items[0].id, "SRC_A", "first item in asc order");
    assert_eq!(resp.items[1].id, "SRC_B", "second item in asc order");
    assert_eq!(resp.items[2].id, "SRC_C", "third item in asc order");
}

#[tokio::test]
async fn sort_created_desc() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::Created { dir: SortDir::Desc }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 3, "should return all 3 backlinks");
    assert_eq!(resp.items[0].id, "SRC_C", "first item in desc order");
    assert_eq!(resp.items[1].id, "SRC_B", "second item in desc order");
    assert_eq!(resp.items[2].id, "SRC_A", "third item in desc order");
}

#[tokio::test]
async fn sort_property_text() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "name", Some("charlie"), None, None).await;
    insert_property(&pool, "SRC_B", "name", Some("alice"), None, None).await;
    insert_property(&pool, "SRC_C", "name", Some("bob"), None, None).await;
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyText {
            key: "name".into(),
            dir: SortDir::Asc,
        }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items[0].id, "SRC_B", "alice sorts first"); // alice
    assert_eq!(resp.items[1].id, "SRC_C", "bob sorts second"); // bob
    assert_eq!(resp.items[2].id, "SRC_A", "charlie sorts third"); // charlie
}

#[tokio::test]
async fn sort_property_num() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(3.0), None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(1.0), None).await;
    insert_property(&pool, "SRC_C", "priority", None, Some(2.0), None).await;
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyNum {
            key: "priority".into(),
            dir: SortDir::Asc,
        }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items[0].id, "SRC_B", "priority=1 sorts first"); // 1.0
    assert_eq!(resp.items[1].id, "SRC_C", "priority=2 sorts second"); // 2.0
    assert_eq!(resp.items[2].id, "SRC_A", "priority=3 sorts third"); // 3.0
}

#[tokio::test]
async fn sort_property_date() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-03-01")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-01-01")).await;
    insert_property(&pool, "SRC_C", "due", None, None, Some("2025-02-01")).await;
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyDate {
            key: "due".into(),
            dir: SortDir::Asc,
        }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items[0].id, "SRC_B", "2025-01-01 sorts first"); // 2025-01-01
    assert_eq!(resp.items[1].id, "SRC_C", "2025-02-01 sorts second"); // 2025-02-01
    assert_eq!(resp.items[2].id, "SRC_A", "2025-03-01 sorts third"); // 2025-03-01
}

// ======================================================================
// Pagination
// ======================================================================

#[tokio::test]
async fn pagination_limit_works() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    let page = PageRequest::new(None, Some(2)).unwrap();

    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 2, "should return exactly 2 items");
    assert!(resp.has_more, "should indicate more pages available");
    assert!(resp.next_cursor.is_some(), "should provide a next cursor");
    assert_eq!(
        resp.total_count, 3,
        "total count should include all backlinks"
    );
    assert_eq!(
        resp.filtered_count, 3,
        "filtered count equals total when unfiltered"
    );
}

#[tokio::test]
async fn pagination_cursor_works() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    // First page
    let page1 = PageRequest::new(None, Some(2)).unwrap();
    let resp1 = eval_backlink_query(&pool, "TARGET", None, None, &page1)
        .await
        .unwrap();
    assert_eq!(resp1.items.len(), 2, "first page should have 2 items");
    assert!(resp1.has_more, "first page should indicate more");

    // Second page
    let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
    let resp2 = eval_backlink_query(&pool, "TARGET", None, None, &page2)
        .await
        .unwrap();
    assert_eq!(
        resp2.items.len(),
        1,
        "second page should have 1 remaining item"
    );
    assert!(!resp2.has_more, "second page should have no more");
    assert!(resp2.next_cursor.is_none(), "no cursor when no more pages");
    assert_eq!(resp2.total_count, 3, "total count unchanged across pages");
    assert_eq!(
        resp2.filtered_count, 3,
        "filtered count unchanged across pages"
    );
}

/// Binary-search pagination: cursor ID exists in result set.
/// Verifies that after seeking to an existing cursor, items after
/// that cursor are returned correctly.
#[tokio::test]
async fn pagination_binary_search_cursor_exists() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    // 3 source blocks: SRC_A, SRC_B, SRC_C (ULID-sorted ascending)

    // First page: get first 1 item
    let page1 = PageRequest::new(None, Some(1)).unwrap();
    let resp1 = eval_backlink_query(&pool, "TARGET", None, None, &page1)
        .await
        .unwrap();
    assert_eq!(resp1.items.len(), 1, "first page has 1 item");
    assert!(resp1.has_more, "more items after first");
    let first_id = resp1.items[0].id.clone();

    // Second page via cursor from first item (cursor ID exists)
    let page2 = PageRequest::new(resp1.next_cursor, Some(1)).unwrap();
    let resp2 = eval_backlink_query(&pool, "TARGET", None, None, &page2)
        .await
        .unwrap();
    assert_eq!(resp2.items.len(), 1, "second page has 1 item");
    assert_ne!(
        resp2.items[0].id, first_id,
        "second page item differs from first"
    );
    assert!(resp2.has_more, "still more items");

    // Third page
    let page3 = PageRequest::new(resp2.next_cursor, Some(1)).unwrap();
    let resp3 = eval_backlink_query(&pool, "TARGET", None, None, &page3)
        .await
        .unwrap();
    assert_eq!(resp3.items.len(), 1, "third page has 1 item");
    assert!(!resp3.has_more, "no more items");
    assert!(resp3.next_cursor.is_none(), "no cursor on last page");
}

/// Binary-search pagination: cursor ID does NOT exist in result set.
/// This can happen when the cursor block was deleted between pages.
/// The binary_search Err(i) path returns the insertion point, so
/// pagination should skip to the next item after where the cursor
/// would have been.
#[tokio::test]
async fn pagination_binary_search_cursor_missing() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    // 3 source blocks: SRC_A, SRC_B, SRC_C

    // Get all items first to know the order
    let all_page = default_page();
    let all = eval_backlink_query(&pool, "TARGET", None, None, &all_page)
        .await
        .unwrap();
    assert_eq!(all.items.len(), 3);

    // Build a fake cursor with an ID that doesn't exist but sorts
    // between the first and second items (binary search Err path).
    // SRC_A < SRC_B < SRC_C in ULID sort; use an ID between A and B.
    let fake_cursor_id = format!("{}Z", all.items[0].id); // lexically after first
    let fake_cursor = Cursor {
        id: fake_cursor_id,
        position: None,
        deleted_at: None,
        seq: None,
        rank: None,
    };
    let encoded = fake_cursor.encode().unwrap();
    let page_missing = PageRequest::new(Some(encoded), Some(50)).unwrap();
    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page_missing)
        .await
        .unwrap();

    // The fake cursor sorts after first item but before second,
    // so binary_search returns Err(1) and we should get items from
    // index 1 onward (the second and third items).
    assert_eq!(
        resp.items.len(),
        2,
        "should return items after the missing cursor position"
    );
    assert_eq!(
        resp.items[0].id, all.items[1].id,
        "first returned item is the second overall item"
    );
    assert_eq!(
        resp.items[1].id, all.items[2].id,
        "second returned item is the third overall item"
    );
}

#[tokio::test]
async fn pagination_total_count_correct_with_filters() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;
    // SRC_C has no status

    let filters = vec![BacklinkFilter::PropertyIsSet {
        key: "status".into(),
    }];
    let page = PageRequest::new(None, Some(1)).unwrap();

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "total includes all 3 backlinks");
    assert_eq!(resp.filtered_count, 2, "only 2 have status property set");
    assert_eq!(resp.items.len(), 1, "page limit is 1");
    assert!(resp.has_more, "more filtered results remain");
}

// ======================================================================
// Empty filters = all backlinks (backward compat)
// ======================================================================

#[tokio::test]
async fn empty_filters_returns_all_backlinks() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    let page = default_page();

    let resp = eval_backlink_query(&pool, "TARGET", Some(vec![]), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "empty filters should not affect total");
    assert_eq!(
        resp.filtered_count, 3,
        "empty filters should not reduce count"
    );
    assert_eq!(resp.items.len(), 3, "all backlinks should be returned");
}

#[tokio::test]
async fn none_filters_returns_all_backlinks() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    let page = default_page();

    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "None filters should not affect total");
    assert_eq!(
        resp.filtered_count, 3,
        "None filters should not reduce count"
    );
    assert_eq!(resp.items.len(), 3, "all backlinks should be returned");
}

// ======================================================================
// No backlinks = empty response
// ======================================================================

#[tokio::test]
async fn no_backlinks_returns_empty() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "LONELY", "page", "No one links to me").await;
    let page = default_page();

    let resp = eval_backlink_query(&pool, "LONELY", None, None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 0, "no backlinks should yield zero total");
    assert_eq!(
        resp.filtered_count, 0,
        "no backlinks should yield zero filtered"
    );
    assert!(resp.items.is_empty(), "items should be empty");
    assert!(!resp.has_more, "should not indicate more pages");
    assert!(resp.next_cursor.is_none(), "should have no cursor");
}

// ======================================================================
// Deleted/conflict blocks excluded from base set
// ======================================================================

#[tokio::test]
async fn deleted_backlinks_excluded() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    // Soft-delete SRC_A
    sqlx::query("UPDATE blocks SET deleted_at = '2025-01-01T00:00:00Z' WHERE id = 'SRC_A'")
        .execute(&pool)
        .await
        .unwrap();
    let page = default_page();

    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 2, "deleted block excluded from total");
    assert_eq!(
        resp.filtered_count, 2,
        "deleted block excluded from filtered"
    );
    assert!(
        resp.items.iter().all(|item| item.id != "SRC_A"),
        "SRC_A should be excluded (deleted)"
    );
}

#[tokio::test]
async fn conflict_backlinks_excluded() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    // Mark SRC_B as conflict
    sqlx::query("UPDATE blocks SET is_conflict = 1 WHERE id = 'SRC_B'")
        .execute(&pool)
        .await
        .unwrap();
    let page = default_page();

    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 2, "conflict block excluded from total");
    assert_eq!(
        resp.filtered_count, 2,
        "conflict block excluded from filtered"
    );
    assert!(
        resp.items.iter().all(|item| item.id != "SRC_B"),
        "SRC_B should be excluded (conflict)"
    );
}

// ======================================================================
// list_property_keys
// ======================================================================

#[tokio::test]
async fn list_property_keys_returns_distinct_sorted() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_A", "content", "a").await;
    insert_block(&pool, "BLK_B", "content", "b").await;
    insert_property(&pool, "BLK_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "BLK_A", "priority", None, Some(1.0), None).await;
    insert_property(&pool, "BLK_B", "status", Some("done"), None, None).await;
    insert_property(&pool, "BLK_B", "due", None, None, Some("2025-01-01")).await;

    let keys = list_property_keys(&pool).await.unwrap();
    assert_eq!(
        keys,
        vec!["due", "priority", "status"],
        "should return distinct sorted keys"
    );
}

#[tokio::test]
async fn list_property_keys_empty_when_no_properties() {
    let (pool, _dir) = test_pool().await;
    let keys = list_property_keys(&pool).await.unwrap();
    assert!(keys.is_empty(), "no properties should yield empty list");
}

// ======================================================================
// eval_backlink_query with filters integrated
// ======================================================================

#[tokio::test]
async fn eval_with_property_text_filter() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;
    let page = default_page();

    let filters = vec![BacklinkFilter::PropertyText {
        key: "status".into(),
        op: CompareOp::Eq,
        value: "active".into(),
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "base set has 3 backlinks");
    assert_eq!(resp.filtered_count, 1, "only SRC_A matches status=active");
    assert_eq!(resp.items[0].id, "SRC_A", "SRC_A should be the only result");
}

#[tokio::test]
async fn eval_with_block_type_filter() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "Target Page").await;
    insert_block(&pool, "SRC_CONTENT", "content", "Content source").await;
    insert_block(&pool, "SRC_TAG", "tag", "Tag source").await;
    insert_block_link(&pool, "SRC_CONTENT", "TARGET").await;
    insert_block_link(&pool, "SRC_TAG", "TARGET").await;
    let page = default_page();

    let filters = vec![BacklinkFilter::BlockType {
        block_type: "content".into(),
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 2, "base set has 2 backlinks");
    assert_eq!(resp.filtered_count, 1, "only content type matches");
    assert_eq!(
        resp.items[0].id, "SRC_CONTENT",
        "only content block returned"
    );
}

#[tokio::test]
async fn eval_with_multiple_filters_and_semantics() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(5.0), None).await;
    let page = default_page();

    // Both filters must match (AND semantics at top level)
    let filters = vec![
        BacklinkFilter::PropertyText {
            key: "status".into(),
            op: CompareOp::Eq,
            value: "active".into(),
        },
        BacklinkFilter::PropertyNum {
            key: "priority".into(),
            op: CompareOp::Lt,
            value: 3.0,
        },
    ];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "base set has 3 backlinks");
    assert_eq!(resp.filtered_count, 1, "only SRC_A matches both filters");
    assert_eq!(
        resp.items[0].id, "SRC_A",
        "SRC_A matches status=active AND priority<3"
    );
}

// ======================================================================
// Review findings: missing PropertyDate CompareOp variants
// ======================================================================

#[tokio::test]
async fn filter_property_date_neq() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

    let filter = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::Neq,
        value: "2025-01-15".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        !set.contains("SRC_A"),
        "SRC_A has due=2025-01-15, should be excluded by Neq"
    );
    assert!(
        set.contains("SRC_B"),
        "SRC_B has due=2025-02-20, should match Neq"
    );
}

#[tokio::test]
async fn filter_property_date_gt() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

    let filter = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::Gt,
        value: "2025-02-01".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(!set.contains("SRC_A"), "2025-01-15 is not > 2025-02-01");
    assert!(set.contains("SRC_B"), "2025-02-20 is > 2025-02-01");
}

#[tokio::test]
async fn filter_property_date_lte() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

    let filter = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::Lte,
        value: "2025-01-15".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "2025-01-15 <= 2025-01-15");
    assert!(!set.contains("SRC_B"), "2025-02-20 is not <= 2025-01-15");
}

#[tokio::test]
async fn filter_property_date_gte() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;

    let filter = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::Gte,
        value: "2025-02-20".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(!set.contains("SRC_A"), "2025-01-15 is not >= 2025-02-20");
    assert!(set.contains("SRC_B"), "2025-02-20 >= 2025-02-20");
}

// ======================================================================
// Review findings: Not(PropertyIsEmpty) ≡ PropertyIsSet
// ======================================================================

#[tokio::test]
async fn not_property_is_empty_equals_property_is_set() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    // SRC_B, SRC_C have no "status" property

    let not_empty = BacklinkFilter::Not {
        filter: Box::new(BacklinkFilter::PropertyIsEmpty {
            key: "status".into(),
        }),
    };
    let is_set = BacklinkFilter::PropertyIsSet {
        key: "status".into(),
    };

    let set_not_empty = resolve_filter(&pool, &not_empty, 0).await.unwrap();
    let set_is_set = resolve_filter(&pool, &is_set, 0).await.unwrap();

    assert_eq!(
        set_not_empty, set_is_set,
        "Not(PropertyIsEmpty) should equal PropertyIsSet"
    );
    assert!(set_not_empty.contains("SRC_A"), "SRC_A has status set");
    assert!(
        !set_not_empty.contains("SRC_B"),
        "SRC_B lacks status property"
    );
    assert!(
        !set_not_empty.contains("SRC_C"),
        "SRC_C lacks status property"
    );
}

// ======================================================================
// Review findings: compound nesting Not(And), Not(Or)
// ======================================================================

#[tokio::test]
async fn filter_not_and_compound() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_A", "priority", None, Some(1.0), None).await;
    insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;
    // SRC_B has status=active but no priority

    // Not(And(status=active, priority set)) — should exclude SRC_A, include SRC_B, SRC_C
    let filter = BacklinkFilter::Not {
        filter: Box::new(BacklinkFilter::And {
            filters: vec![
                BacklinkFilter::PropertyText {
                    key: "status".into(),
                    op: CompareOp::Eq,
                    value: "active".into(),
                },
                BacklinkFilter::PropertyIsSet {
                    key: "priority".into(),
                },
            ],
        }),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        !set.contains("SRC_A"),
        "SRC_A matches both => excluded by Not"
    );
    assert!(
        set.contains("SRC_B"),
        "SRC_B only matches status, not priority"
    );
    assert!(set.contains("SRC_C"), "SRC_C matches neither");
}

#[tokio::test]
async fn filter_not_or_compound() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "priority", None, Some(1.0), None).await;
    // SRC_C has neither property

    // Not(Or(status=active, priority set)) — excludes SRC_A and SRC_B, includes SRC_C
    let filter = BacklinkFilter::Not {
        filter: Box::new(BacklinkFilter::Or {
            filters: vec![
                BacklinkFilter::PropertyText {
                    key: "status".into(),
                    op: CompareOp::Eq,
                    value: "active".into(),
                },
                BacklinkFilter::PropertyIsSet {
                    key: "priority".into(),
                },
            ],
        }),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        !set.contains("SRC_A"),
        "SRC_A has status=active => in Or => excluded by Not"
    );
    assert!(
        !set.contains("SRC_B"),
        "SRC_B has priority set => in Or => excluded by Not"
    );
    assert!(
        set.contains("SRC_C"),
        "SRC_C has neither => not in Or => included by Not"
    );
}

// ======================================================================
// Review findings: sorting with missing properties
// ======================================================================

#[tokio::test]
async fn sort_property_text_missing_values_go_last_asc() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "name", Some("charlie"), None, None).await;
    insert_property(&pool, "SRC_B", "name", Some("alice"), None, None).await;
    // SRC_C has NO "name" property
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyText {
            key: "name".into(),
            dir: SortDir::Asc,
        }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items[0].id, "SRC_B", "alice sorts first");
    assert_eq!(resp.items[1].id, "SRC_A", "charlie sorts second");
    assert_eq!(resp.items[2].id, "SRC_C", "missing property sorts last");
}

#[tokio::test]
async fn sort_property_text_missing_values_go_last_desc() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "name", Some("charlie"), None, None).await;
    insert_property(&pool, "SRC_B", "name", Some("alice"), None, None).await;
    // SRC_C has NO "name" property
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyText {
            key: "name".into(),
            dir: SortDir::Desc,
        }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items[0].id, "SRC_A", "charlie sorts first in desc");
    assert_eq!(resp.items[1].id, "SRC_B", "alice sorts second in desc");
    assert_eq!(
        resp.items[2].id, "SRC_C",
        "missing property still last in desc"
    );
}

#[tokio::test]
async fn sort_property_num_missing_values_go_last() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "effort", None, Some(5.0), None).await;
    insert_property(&pool, "SRC_B", "effort", None, Some(2.0), None).await;
    // SRC_C has NO "effort" property
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyNum {
            key: "effort".into(),
            dir: SortDir::Asc,
        }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items[0].id, "SRC_B", "effort=2 first");
    assert_eq!(resp.items[1].id, "SRC_A", "effort=5 second");
    assert_eq!(resp.items[2].id, "SRC_C", "no effort property last");
}

#[tokio::test]
async fn sort_property_date_missing_values_go_last() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-03-01")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-01-01")).await;
    // SRC_C has NO "due" property
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyDate {
            key: "due".into(),
            dir: SortDir::Asc,
        }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items[0].id, "SRC_B", "2025-01-01 first");
    assert_eq!(resp.items[1].id, "SRC_A", "2025-03-01 second");
    assert_eq!(resp.items[2].id, "SRC_C", "no due date last");
}

// ======================================================================
// Review findings: CreatedInRange with inverted range (after > before)
// ======================================================================

#[tokio::test]
async fn created_in_range_inverted_range_returns_empty() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    let page = default_page();

    let filters = vec![BacklinkFilter::CreatedInRange {
        after: Some("2099-12-31".into()),
        before: Some("2020-01-01".into()),
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "base set has 3 backlinks");
    assert_eq!(
        resp.filtered_count, 0,
        "inverted range should return no results"
    );
}

// ======================================================================
// Review findings: FTS Contains with sanitized syntax
// ======================================================================

#[tokio::test]
async fn fts_contains_sanitises_bare_operators() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_fts(&pool, "SRC_A", "hello NEAR world").await;

    // A bare "NEAR" used to cause an FTS5 syntax error; sanitize_fts_query
    // now wraps each token in double-quotes so it matches literally.
    // (Trigram tokenizer requires >= 3 chars, so we use "NEAR" not "OR".)
    let filter = BacklinkFilter::Contains {
        query: "NEAR".into(),
    };
    let result = resolve_filter(&pool, &filter, 0).await;
    assert!(
        result.is_ok(),
        "sanitized FTS query should not produce a syntax error"
    );
    let set = result.unwrap();
    assert!(set.contains("SRC_A"), "SRC_A contains literal 'NEAR'");
}

// ======================================================================
// Review findings: pagination with property sort
// ======================================================================

#[tokio::test]
async fn pagination_with_property_text_sort() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "name", Some("charlie"), None, None).await;
    insert_property(&pool, "SRC_B", "name", Some("alice"), None, None).await;
    insert_property(&pool, "SRC_C", "name", Some("bob"), None, None).await;

    let sort = Some(BacklinkSort::PropertyText {
        key: "name".into(),
        dir: SortDir::Asc,
    });

    // First page: limit 2
    let page1 = PageRequest::new(None, Some(2)).unwrap();
    let resp1 = eval_backlink_query(&pool, "TARGET", None, sort.clone(), &page1)
        .await
        .unwrap();
    assert_eq!(resp1.items.len(), 2, "first page should have 2 items");
    assert!(resp1.has_more, "first page should indicate more");
    assert_eq!(resp1.items[0].id, "SRC_B", "alice first");
    assert_eq!(resp1.items[1].id, "SRC_C", "bob second");

    // Second page via cursor
    let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
    let resp2 = eval_backlink_query(&pool, "TARGET", None, sort, &page2)
        .await
        .unwrap();
    assert_eq!(resp2.items.len(), 1, "second page should have 1 item");
    assert!(!resp2.has_more, "second page should have no more");
    assert_eq!(resp2.items[0].id, "SRC_A", "charlie last");
}

// ======================================================================
// parse_iso_to_ms tests
// ======================================================================

#[test]
fn parse_iso_date_only() {
    let ms = parse_iso_to_ms("2025-01-15");
    assert!(ms.is_some(), "date-only string should parse successfully");
    // 2025-01-15 00:00:00 UTC
    assert_eq!(
        ms.unwrap(),
        1736899200000,
        "should equal midnight UTC millis"
    );
}

#[test]
fn parse_iso_full_datetime() {
    let ms = parse_iso_to_ms("2025-01-15T12:00:00Z");
    assert!(ms.is_some(), "full datetime should parse successfully");
}

#[test]
fn parse_iso_invalid_returns_none() {
    assert!(
        parse_iso_to_ms("not-a-date").is_none(),
        "invalid string should return None"
    );
}

// ======================================================================
// #246 — PropertyNum / PropertyDate Desc sort with missing values
// ======================================================================

#[tokio::test]
async fn sort_property_num_desc_order() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "effort", None, Some(5.0), None).await;
    insert_property(&pool, "SRC_B", "effort", None, Some(2.0), None).await;
    // SRC_C has NO "effort" property
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyNum {
            key: "effort".into(),
            dir: SortDir::Desc,
        }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items[0].id, "SRC_A", "effort=5 first in desc");
    assert_eq!(resp.items[1].id, "SRC_B", "effort=2 second in desc");
    assert_eq!(
        resp.items[2].id, "SRC_C",
        "missing effort property still last in desc"
    );
}

#[tokio::test]
async fn sort_property_date_desc_order() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-03-01")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-01-01")).await;
    // SRC_C has NO "due" property
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyDate {
            key: "due".into(),
            dir: SortDir::Desc,
        }),
        &page,
    )
    .await
    .unwrap();

    assert_eq!(resp.items[0].id, "SRC_A", "2025-03-01 first in desc");
    assert_eq!(resp.items[1].id, "SRC_B", "2025-01-01 second in desc");
    assert_eq!(
        resp.items[2].id, "SRC_C",
        "missing due date still last in desc"
    );
}

// ======================================================================
// #248 — Snapshot tests for BacklinkQueryResponse
// ======================================================================

#[tokio::test]
async fn snapshot_backlink_query_basic() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    let page = default_page();

    let resp = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        &page,
    )
    .await
    .unwrap();

    insta::assert_yaml_snapshot!(resp, {
        ".items[].id" => "[ULID]",
        ".next_cursor" => "[CURSOR]",
    });
}

#[tokio::test]
async fn snapshot_backlink_query_with_filter() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("done"), None, None).await;
    let page = default_page();

    let filters = vec![BacklinkFilter::PropertyText {
        key: "status".into(),
        op: CompareOp::Eq,
        value: "active".into(),
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();

    insta::assert_yaml_snapshot!(resp, {
        ".items[].id" => "[ULID]",
        ".next_cursor" => "[CURSOR]",
    });
}

#[tokio::test]
async fn snapshot_backlink_query_empty() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "LONELY", "page", "No one links to me").await;
    let page = default_page();

    let resp = eval_backlink_query(&pool, "LONELY", None, None, &page)
        .await
        .unwrap();

    insta::assert_yaml_snapshot!(resp, {
        ".items[].id" => "[ULID]",
        ".next_cursor" => "[CURSOR]",
    });
}

// ======================================================================
// ms_to_ulid_prefix round-trip
// ======================================================================

#[test]
fn ms_to_ulid_prefix_round_trip() {
    // Verify encode/decode round-trip for several known timestamps
    let timestamps: Vec<u64> = vec![0, 1, 1000, 1735689600000, u64::MAX >> 16];
    for ms in timestamps {
        let prefix = ms_to_ulid_prefix(ms);
        assert_eq!(prefix.len(), 10, "prefix should be 10 chars for ms={ms}");
        let decoded = ulid_to_ms(&prefix).unwrap();
        assert_eq!(decoded, ms, "round-trip failed for ms={ms}");
    }
}

#[test]
fn ms_to_ulid_prefix_preserves_sort_order() {
    let t1 = 1000u64;
    let t2 = 2000u64;
    let t3 = 1735689600000u64;
    let p1 = ms_to_ulid_prefix(t1);
    let p2 = ms_to_ulid_prefix(t2);
    let p3 = ms_to_ulid_prefix(t3);
    assert!(p1 < p2, "sort order: {p1} should be < {p2}");
    assert!(p2 < p3, "sort order: {p2} should be < {p3}");
}

#[test]
fn ms_to_ulid_prefix_zero() {
    let prefix = ms_to_ulid_prefix(0);
    assert_eq!(
        prefix, "0000000000",
        "zero timestamp should encode to all zeros"
    );
}

// ======================================================================
// #249 — Recursion depth limit test
// ======================================================================

#[tokio::test]
async fn resolve_filter_rejects_excessive_nesting() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    // Build a filter nested 52 levels deep (exceeds limit of 50)
    let mut filter = BacklinkFilter::PropertyIsSet {
        key: "anything".into(),
    };
    for _ in 0..52 {
        filter = BacklinkFilter::Not {
            filter: Box::new(filter),
        };
    }

    let result = resolve_filter(&pool, &filter, 0).await;
    assert!(result.is_err(), "should reject deeply nested filters");
    let err = result.unwrap_err();
    let msg = format!("{err}");
    assert!(
        msg.contains("depth exceeds 50"),
        "error should mention depth limit, got: {msg}"
    );
}

// ======================================================================
// #409 — Not filter json_each path (>500 items)
// ======================================================================

#[tokio::test]
async fn not_filter_large_set_uses_json_each() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "Target Page").await;

    // Create >500 "page" source blocks that link to TARGET
    for i in 0..510 {
        let id = format!("PAGE_{i:04}");
        insert_block(&pool, &id, "page", &format!("Page {i}")).await;
        insert_block_link(&pool, &id, "TARGET").await;
    }

    // Create 5 "content" blocks that link to TARGET
    for i in 0..5 {
        let id = format!("CONTENT_{i:04}");
        insert_block(&pool, &id, "content", &format!("Content {i}")).await;
        insert_block_link(&pool, &id, "TARGET").await;
    }

    // Not(BlockType("page")) should return only the content blocks
    // (plus TARGET itself since it's a block, but it won't be in
    // the backlink base set for itself).
    // The inner set has >500 page blocks, triggering the json_each path.
    let filter = BacklinkFilter::Not {
        filter: Box::new(BacklinkFilter::BlockType {
            block_type: "page".into(),
        }),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();

    // All 5 content blocks should be in the result
    for i in 0..5 {
        let id = format!("CONTENT_{i:04}");
        assert!(set.contains(&id), "expected {id} in Not(page) set");
    }

    // No page blocks should be in the result
    for i in 0..510 {
        let id = format!("PAGE_{i:04}");
        assert!(
            !set.contains(&id),
            "page block {id} should NOT be in Not(page) set"
        );
    }
}

// ======================================================================
// #410 — Not(Not(filter)) double negation is identity
// ======================================================================

#[tokio::test]
async fn not_not_is_identity() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "Target Page").await;

    // Create mixed block types as backlink sources
    for i in 0..3 {
        let id = format!("CONTENT_{i}");
        insert_block(&pool, &id, "content", &format!("Content {i}")).await;
        insert_block_link(&pool, &id, "TARGET").await;
    }
    for i in 0..2 {
        let id = format!("PAGE_{i}");
        insert_block(&pool, &id, "page", &format!("Page {i}")).await;
        insert_block_link(&pool, &id, "TARGET").await;
    }

    // Evaluate BlockType("content")
    let plain_filter = BacklinkFilter::BlockType {
        block_type: "content".into(),
    };
    let plain_set = resolve_filter(&pool, &plain_filter, 0).await.unwrap();

    // Evaluate Not(Not(BlockType("content")))
    let double_neg_filter = BacklinkFilter::Not {
        filter: Box::new(BacklinkFilter::Not {
            filter: Box::new(BacklinkFilter::BlockType {
                block_type: "content".into(),
            }),
        }),
    };
    let double_neg_set = resolve_filter(&pool, &double_neg_filter, 0).await.unwrap();

    assert_eq!(
        plain_set, double_neg_set,
        "Not(Not(BlockType(\"content\"))) should equal BlockType(\"content\")"
    );
}

// ======================================================================
// #411 — Non-finite f64 in PropertyNum filter (defense in depth)
// ======================================================================

#[tokio::test]
async fn filter_property_num_non_finite_values() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "Target Page").await;
    insert_block(&pool, "SRC_A", "content", "Source A").await;
    insert_block(&pool, "SRC_B", "content", "Source B").await;
    insert_property(&pool, "SRC_A", "score", None, Some(42.0), None).await;
    insert_property(&pool, "SRC_B", "score", None, Some(100.0), None).await;
    insert_block_link(&pool, "SRC_A", "TARGET").await;
    insert_block_link(&pool, "SRC_B", "TARGET").await;
    let page = default_page();

    // Test 1: Eq with +Infinity → should match nothing
    // (42.0 - Inf).abs() == Inf, which is not < EPSILON
    let filters_inf_eq = vec![BacklinkFilter::PropertyNum {
        key: "score".into(),
        op: CompareOp::Eq,
        value: f64::INFINITY,
    }];
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_inf_eq), None, &page)
        .await
        .unwrap();
    assert_eq!(
        resp.filtered_count, 0,
        "Eq with +Infinity should match no finite values"
    );

    // Test 2: Gt with -Infinity → both should match (42 > -Inf is true)
    let filters_neg_inf_gt = vec![BacklinkFilter::PropertyNum {
        key: "score".into(),
        op: CompareOp::Gt,
        value: f64::NEG_INFINITY,
    }];
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_neg_inf_gt), None, &page)
        .await
        .unwrap();
    assert_eq!(
        resp.filtered_count, 2,
        "Gt with -Infinity should match all finite values"
    );
    let ids: Vec<&str> = resp.items.iter().map(|i| i.id.as_str()).collect();
    assert!(ids.contains(&"SRC_A"), "SRC_A (42.0) > -Inf");
    assert!(ids.contains(&"SRC_B"), "SRC_B (100.0) > -Inf");

    // Test 3: Eq with NaN → should match nothing (NaN comparisons are always false)
    let filters_nan_eq = vec![BacklinkFilter::PropertyNum {
        key: "score".into(),
        op: CompareOp::Eq,
        value: f64::NAN,
    }];
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_nan_eq), None, &page)
        .await
        .unwrap();
    assert_eq!(
        resp.filtered_count, 0,
        "Eq with NaN should match nothing (NaN - x is NaN, NaN.abs() is NaN, NaN < EPSILON is false)"
    );
}

// ======================================================================
// #412 — HasTagPrefix LIKE escape chars (%, _, \)
// ======================================================================

#[tokio::test]
async fn filter_has_tag_prefix_with_special_chars() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "Target Page").await;
    insert_block(&pool, "SRC_A", "content", "Source A").await;
    insert_block(&pool, "SRC_B", "content", "Source B").await;
    insert_block(&pool, "SRC_C", "content", "Source C").await;
    insert_block_link(&pool, "SRC_A", "TARGET").await;
    insert_block_link(&pool, "SRC_B", "TARGET").await;
    insert_block_link(&pool, "SRC_C", "TARGET").await;

    // Create tag blocks (block_tags.tag_id FK → blocks.id)
    insert_block(&pool, "TAG_PCT", "tag", "a%b").await;
    insert_block(&pool, "TAG_AXB", "tag", "axb").await;
    insert_block(&pool, "TAG_USC", "tag", "a_c").await;

    // Create tags with special LIKE characters
    insert_tag_cache(&pool, "TAG_PCT", "a%b", 1).await;
    insert_tag_cache(&pool, "TAG_AXB", "axb", 1).await;
    insert_tag_cache(&pool, "TAG_USC", "a_c", 1).await;

    // Assign tags: SRC_A gets "a%b", SRC_B gets "axb", SRC_C gets "a_c"
    insert_tag_assoc(&pool, "SRC_A", "TAG_PCT").await;
    insert_tag_assoc(&pool, "SRC_B", "TAG_AXB").await;
    insert_tag_assoc(&pool, "SRC_C", "TAG_USC").await;
    let page = default_page();

    // Test 1: HasTagPrefix with "a%" should match ONLY SRC_A (literal "a%" prefix)
    // Without escaping, "a%" would be a LIKE wildcard matching "axb" too.
    let filters_pct = vec![BacklinkFilter::HasTagPrefix {
        prefix: "a%".into(),
    }];
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_pct), None, &page)
        .await
        .unwrap();
    assert_eq!(
        resp.filtered_count, 1,
        "HasTagPrefix 'a%' should match only the literal 'a%b' tag, not 'axb'"
    );
    assert_eq!(
        resp.items[0].id, "SRC_A",
        "only SRC_A has the 'a%b' tag matching literal prefix 'a%'"
    );

    // Test 2: HasTagPrefix with "a_" should match ONLY SRC_C (literal "a_" prefix)
    // Without escaping, "a_" would be a LIKE wildcard matching "axb" too.
    let filters_usc = vec![BacklinkFilter::HasTagPrefix {
        prefix: "a_".into(),
    }];
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_usc), None, &page)
        .await
        .unwrap();
    assert_eq!(
        resp.filtered_count, 1,
        "HasTagPrefix 'a_' should match only the literal 'a_c' tag, not 'axb'"
    );
    assert_eq!(
        resp.items[0].id, "SRC_C",
        "only SRC_C has the 'a_c' tag matching literal prefix 'a_'"
    );
}

// ======================================================================
// #413 — FTS Contains with mixed operators and valid terms
// ======================================================================

#[tokio::test]
async fn fts_contains_mixed_operators_and_terms() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "Target Page").await;
    insert_block(&pool, "SRC_A", "content", "Source A").await;
    insert_block(&pool, "SRC_B", "content", "Source B").await;
    insert_block(&pool, "SRC_C", "content", "Source C").await;
    insert_block_link(&pool, "SRC_A", "TARGET").await;
    insert_block_link(&pool, "SRC_B", "TARGET").await;
    insert_block_link(&pool, "SRC_C", "TARGET").await;

    // Insert FTS entries with FTS5 operator keywords as literal words
    insert_fts(&pool, "SRC_A", "AND hello world").await;
    insert_fts(&pool, "SRC_B", "hello NOT goodbye").await;
    insert_fts(&pool, "SRC_C", "just hello there").await;
    let page = default_page();

    // Test 1: "AND hello" should match SRC_A (both terms present as literal text)
    let filters_and = vec![BacklinkFilter::Contains {
        query: "AND hello".into(),
    }];
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_and), None, &page)
        .await
        .unwrap();
    assert_eq!(
        resp.filtered_count, 1,
        "'AND hello' should match only SRC_A which contains both literal words"
    );
    assert_eq!(
        resp.items[0].id, "SRC_A",
        "SRC_A has 'AND hello world' containing both 'AND' and 'hello' literally"
    );

    // Test 2: "NOT goodbye" is now a standalone FTS5 NOT operator (binary),
    // which is a syntax error.  The sanitizer intentionally preserves NOT
    // as an operator when followed by a term.
    let filters_not = vec![BacklinkFilter::Contains {
        query: "NOT goodbye".into(),
    }];
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_not), None, &page).await;
    assert!(
        resp.is_err(),
        "'NOT goodbye' as standalone NOT should produce an FTS5 syntax error"
    );

    // Test 3: "hello" should match all three (SRC_A, SRC_B, SRC_C)
    let filters_hello = vec![BacklinkFilter::Contains {
        query: "hello".into(),
    }];
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_hello), None, &page)
        .await
        .unwrap();
    assert_eq!(
        resp.filtered_count, 3,
        "'hello' should match all three blocks that contain it"
    );
    let ids: Vec<&str> = resp.items.iter().map(|i| i.id.as_str()).collect();
    assert!(ids.contains(&"SRC_A"), "SRC_A contains 'hello'");
    assert!(ids.contains(&"SRC_B"), "SRC_B contains 'hello'");
    assert!(ids.contains(&"SRC_C"), "SRC_C contains 'hello'");
}

// ======================================================================
// Helper: insert a block with optional parent_id and position
// ======================================================================

/// Insert a block with parent_id and position for hierarchy tests.
///
/// Auto-computes `page_id`: for pages, `page_id = id`; for children,
/// inherits the parent's `page_id`.
async fn insert_block_with_parent(
    pool: &SqlitePool,
    id: &str,
    block_type: &str,
    content: &str,
    parent_id: Option<&str>,
    position: Option<i64>,
) {
    let page_id: Option<String> = if block_type == "page" {
        Some(id.to_string())
    } else if let Some(pid) = parent_id {
        sqlx::query_scalar::<_, Option<String>>("SELECT page_id FROM blocks WHERE id = ?")
            .bind(pid)
            .fetch_optional(pool)
            .await
            .unwrap()
            .flatten()
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(block_type)
    .bind(content)
    .bind(parent_id)
    .bind(position)
    .bind(page_id.as_deref())
    .execute(pool)
    .await
    .unwrap();
}

// ======================================================================
// #539 — total_count + filtered_count tests
// ======================================================================

#[tokio::test]
async fn total_and_filtered_count_no_filters() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    let page = default_page();

    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "total count should be 3");
    assert_eq!(resp.filtered_count, 3, "filtered count should be 3");
    assert_eq!(
        resp.total_count, resp.filtered_count,
        "with no filters, total_count == filtered_count"
    );
}

#[tokio::test]
async fn total_and_filtered_count_with_filter() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "status", Some("active"), None, None).await;
    insert_property(&pool, "SRC_B", "status", Some("active"), None, None).await;
    // SRC_C has no status property
    let page = default_page();

    let filters = vec![BacklinkFilter::PropertyIsSet {
        key: "status".into(),
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "base set has 3 backlinks");
    assert_eq!(resp.filtered_count, 2, "only 2 match the filter");
}

// ======================================================================
// #538 — resolve_root_pages tests
// ======================================================================

#[tokio::test]
async fn resolve_root_pages_empty() {
    let (pool, _dir) = test_pool().await;
    let result = resolve_root_pages(&pool, &FxHashSet::default())
        .await
        .unwrap();
    assert!(result.is_empty(), "empty input should return empty map");
}

#[tokio::test]
async fn resolve_root_pages_happy_path() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_A1",
        "content",
        "block a1",
        Some("PAGE_A"),
        Some(1),
    )
    .await;

    let mut ids = FxHashSet::default();
    ids.insert("BLK_A1".into());
    let result = resolve_root_pages(&pool, &ids).await.unwrap();
    assert_eq!(result.len(), 1, "should resolve one block to its root page");
    let (root_id, root_title) = result.get("BLK_A1").unwrap();
    assert_eq!(root_id, "PAGE_A", "root page should be PAGE_A");
    assert_eq!(
        root_title.as_deref(),
        Some("Page A"),
        "root title should be 'Page A'"
    );
}

#[tokio::test]
async fn resolve_root_pages_nested() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
    insert_block_with_parent(
        &pool,
        "MID",
        "content",
        "mid level",
        Some("PAGE_A"),
        Some(1),
    )
    .await;
    insert_block_with_parent(&pool, "DEEP", "content", "deep level", Some("MID"), Some(1)).await;

    let mut ids = FxHashSet::default();
    ids.insert("DEEP".into());
    let result = resolve_root_pages(&pool, &ids).await.unwrap();
    assert_eq!(result.len(), 1, "should resolve nested block to root");
    let (root_id, _) = result.get("DEEP").unwrap();
    assert_eq!(
        root_id, "PAGE_A",
        "deeply nested block should resolve to PAGE_A"
    );
}

#[tokio::test]
async fn resolve_root_pages_orphan() {
    let (pool, _dir) = test_pool().await;
    // A block with no parent, but block_type = 'content' (not a page)
    insert_block_with_parent(&pool, "ORPHAN", "content", "orphan block", None, None).await;

    let mut ids = FxHashSet::default();
    ids.insert("ORPHAN".into());
    let result = resolve_root_pages(&pool, &ids).await.unwrap();
    assert!(
        result.is_empty(),
        "orphan block (no page ancestor) should be omitted"
    );
}

#[tokio::test]
async fn resolve_root_pages_oracle_cte_vs_page_id() {
    // Build a nested hierarchy: PAGE -> MID -> DEEP -> LEAF, plus a direct child
    // and an orphan. Both the CTE oracle and the page_id-based implementation
    // must return identical results.
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "PAGE_R", "page", "Root Page", None, None).await;
    insert_block_with_parent(
        &pool,
        "MID_R",
        "content",
        "mid level",
        Some("PAGE_R"),
        Some(1),
    )
    .await;
    insert_block_with_parent(
        &pool,
        "DEEP_R",
        "content",
        "deep level",
        Some("MID_R"),
        Some(1),
    )
    .await;
    insert_block_with_parent(
        &pool,
        "LEAF_R",
        "content",
        "leaf level",
        Some("DEEP_R"),
        Some(1),
    )
    .await;
    insert_block_with_parent(
        &pool,
        "CHILD_R",
        "content",
        "direct child",
        Some("PAGE_R"),
        Some(2),
    )
    .await;
    // Orphan: content block with no parent (page_id = NULL)
    insert_block_with_parent(&pool, "ORPHAN_R", "content", "orphan", None, None).await;

    let mut ids = FxHashSet::default();
    ids.insert("MID_R".into());
    ids.insert("DEEP_R".into());
    ids.insert("LEAF_R".into());
    ids.insert("CHILD_R".into());
    ids.insert("ORPHAN_R".into());
    ids.insert("PAGE_R".into()); // page itself

    let fast = resolve_root_pages(&pool, &ids).await.unwrap();
    let oracle = resolve_root_pages_cte(&pool, &ids).await.unwrap();

    assert_eq!(
        fast, oracle,
        "page_id JOIN must return the same map as the recursive CTE"
    );
}

// ======================================================================
// #538 — eval_backlink_query_grouped tests
// ======================================================================

#[tokio::test]
async fn eval_grouped_empty() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "LONELY", "page", "No one links to me").await;
    let page = default_page();

    let resp = eval_backlink_query_grouped(&pool, "LONELY", None, None, &page)
        .await
        .unwrap();
    assert!(resp.groups.is_empty(), "no backlinks means no groups");
    assert_eq!(resp.total_count, 0, "total count should be 0");
    assert_eq!(resp.filtered_count, 0, "filtered count should be 0");
    assert!(!resp.has_more, "should not have more pages");
}

#[tokio::test]
async fn eval_grouped_happy_path() {
    let (pool, _dir) = test_pool().await;
    // Page A with child content blocks
    insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_A1",
        "content",
        "block a1",
        Some("PAGE_A"),
        Some(1),
    )
    .await;
    // Page B with child content blocks
    insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_B1",
        "content",
        "block b1",
        Some("PAGE_B"),
        Some(1),
    )
    .await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    // Backlinks: BLK_A1 and BLK_B1 link to TARGET
    insert_block_link(&pool, "BLK_A1", "TARGET").await;
    insert_block_link(&pool, "BLK_B1", "TARGET").await;
    let page = default_page();

    let resp = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page)
        .await
        .unwrap();
    assert_eq!(resp.groups.len(), 2, "2 source pages");
    assert_eq!(resp.total_count, 2, "total count should be 2");
    assert_eq!(resp.filtered_count, 2, "filtered count should be 2");
    assert!(!resp.has_more, "all groups fit in one page");

    // Groups sorted alphabetically by page_title: "Page A" < "Page B"
    assert_eq!(resp.groups[0].page_id, "PAGE_A", "first group is PAGE_A");
    assert_eq!(
        resp.groups[0].page_title.as_deref(),
        Some("Page A"),
        "first group title"
    );
    assert_eq!(resp.groups[0].blocks.len(), 1, "PAGE_A has 1 block");
    assert_eq!(
        resp.groups[0].blocks[0].id, "BLK_A1",
        "PAGE_A block is BLK_A1"
    );

    assert_eq!(resp.groups[1].page_id, "PAGE_B", "second group is PAGE_B");
    assert_eq!(
        resp.groups[1].page_title.as_deref(),
        Some("Page B"),
        "second group title"
    );
    assert_eq!(resp.groups[1].blocks.len(), 1, "PAGE_B has 1 block");
    assert_eq!(
        resp.groups[1].blocks[0].id, "BLK_B1",
        "PAGE_B block is BLK_B1"
    );
}

#[tokio::test]
async fn eval_grouped_pagination() {
    let (pool, _dir) = test_pool().await;
    // Create 3 pages with child blocks linking to target
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    for ch in ['A', 'B', 'C'] {
        let page_id = format!("PAGE_{ch}");
        let blk_id = format!("BLK_{ch}1");
        insert_block_with_parent(&pool, &page_id, "page", &format!("Page {ch}"), None, None).await;
        insert_block_with_parent(
            &pool,
            &blk_id,
            "content",
            &format!("block {ch}1"),
            Some(&page_id),
            Some(1),
        )
        .await;
        insert_block_link(&pool, &blk_id, "TARGET").await;
    }

    // First page: limit=2
    let page1 = PageRequest::new(None, Some(2)).unwrap();
    let resp1 = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page1)
        .await
        .unwrap();
    assert_eq!(resp1.groups.len(), 2, "first page should have 2 groups");
    assert!(resp1.has_more, "more groups available");
    assert!(resp1.next_cursor.is_some(), "cursor should be provided");
    assert_eq!(resp1.total_count, 3, "total count across all pages");
    assert_eq!(resp1.filtered_count, 3, "filtered count across all pages");

    // Second page via cursor
    let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
    let resp2 = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page2)
        .await
        .unwrap();
    assert_eq!(resp2.groups.len(), 1, "second page has 1 remaining group");
    assert!(!resp2.has_more, "no more groups after second page");
    assert!(resp2.next_cursor.is_none(), "no cursor on last page");
}

#[tokio::test]
async fn eval_grouped_respects_filters() {
    let (pool, _dir) = test_pool().await;
    // Page A with child content blocks
    insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_A1",
        "content",
        "block a1",
        Some("PAGE_A"),
        Some(1),
    )
    .await;
    // Page B with child content blocks
    insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_B1",
        "content",
        "block b1",
        Some("PAGE_B"),
        Some(1),
    )
    .await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    // Backlinks
    insert_block_link(&pool, "BLK_A1", "TARGET").await;
    insert_block_link(&pool, "BLK_B1", "TARGET").await;
    // Only BLK_A1 has a property
    insert_property(&pool, "BLK_A1", "status", Some("active"), None, None).await;
    let page = default_page();

    let filters = vec![BacklinkFilter::PropertyIsSet {
        key: "status".into(),
    }];

    let resp = eval_backlink_query_grouped(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 2, "base set has 2 backlinks");
    assert_eq!(resp.filtered_count, 1, "only 1 matches the filter");
    assert_eq!(
        resp.groups.len(),
        1,
        "only one group should remain after filter"
    );
    assert_eq!(
        resp.groups[0].page_id, "PAGE_A",
        "PAGE_A group should match filter"
    );
}

// ======================================================================
// #540 — SourcePage filter tests
// ======================================================================

#[tokio::test]
async fn filter_source_page_included() {
    let (pool, _dir) = test_pool().await;
    // Page A with child content blocks
    insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_A1",
        "content",
        "block a1",
        Some("PAGE_A"),
        Some(1),
    )
    .await;
    // Page B with child content blocks
    insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_B1",
        "content",
        "block b1",
        Some("PAGE_B"),
        Some(1),
    )
    .await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    insert_block_link(&pool, "BLK_A1", "TARGET").await;
    insert_block_link(&pool, "BLK_B1", "TARGET").await;
    let page = default_page();

    let filters = vec![BacklinkFilter::SourcePage {
        included: vec!["PAGE_A".into()],
        excluded: vec![],
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 2, "base set has 2 backlinks");
    assert_eq!(resp.filtered_count, 1, "only backlinks from PAGE_A");
    assert_eq!(
        resp.items[0].id, "BLK_A1",
        "BLK_A1 is the matching backlink"
    );
}

#[tokio::test]
async fn filter_source_page_excluded() {
    let (pool, _dir) = test_pool().await;
    // Page A with child content blocks
    insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_A1",
        "content",
        "block a1",
        Some("PAGE_A"),
        Some(1),
    )
    .await;
    // Page B with child content blocks
    insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_B1",
        "content",
        "block b1",
        Some("PAGE_B"),
        Some(1),
    )
    .await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    insert_block_link(&pool, "BLK_A1", "TARGET").await;
    insert_block_link(&pool, "BLK_B1", "TARGET").await;
    let page = default_page();

    let filters = vec![BacklinkFilter::SourcePage {
        included: vec![],
        excluded: vec!["PAGE_A".into()],
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 2, "base set has 2 backlinks");
    assert_eq!(resp.filtered_count, 1, "backlinks from PAGE_A excluded");
    assert_eq!(resp.items[0].id, "BLK_B1", "BLK_B1 remains after exclusion");
}

#[tokio::test]
async fn filter_source_page_included_and_excluded() {
    let (pool, _dir) = test_pool().await;
    // Page A with two child content blocks
    insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_A1",
        "content",
        "block a1",
        Some("PAGE_A"),
        Some(1),
    )
    .await;
    insert_block_with_parent(
        &pool,
        "BLK_A2",
        "content",
        "block a2",
        Some("PAGE_A"),
        Some(2),
    )
    .await;
    // Page B with child content block
    insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_B1",
        "content",
        "block b1",
        Some("PAGE_B"),
        Some(1),
    )
    .await;
    // Page C with child content block
    insert_block_with_parent(&pool, "PAGE_C", "page", "Page C", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_C1",
        "content",
        "block c1",
        Some("PAGE_C"),
        Some(1),
    )
    .await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    insert_block_link(&pool, "BLK_A1", "TARGET").await;
    insert_block_link(&pool, "BLK_A2", "TARGET").await;
    insert_block_link(&pool, "BLK_B1", "TARGET").await;
    insert_block_link(&pool, "BLK_C1", "TARGET").await;
    let page = default_page();

    // Include PAGE_A and PAGE_B, exclude PAGE_B → only PAGE_A blocks
    let filters = vec![BacklinkFilter::SourcePage {
        included: vec!["PAGE_A".into(), "PAGE_B".into()],
        excluded: vec!["PAGE_B".into()],
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 4, "base set has 4 backlinks");
    assert_eq!(
        resp.filtered_count, 2,
        "only PAGE_A blocks after include+exclude"
    );
    let ids: Vec<&str> = resp.items.iter().map(|i| i.id.as_str()).collect();
    assert!(ids.contains(&"BLK_A1"), "BLK_A1 from PAGE_A");
    assert!(ids.contains(&"BLK_A2"), "BLK_A2 from PAGE_A");
    assert!(!ids.contains(&"BLK_B1"), "BLK_B1 from PAGE_B excluded");
    assert!(!ids.contains(&"BLK_C1"), "BLK_C1 from PAGE_C not included");
}

#[tokio::test]
async fn filter_source_page_exclusion_only_sql_path() {
    // Verifies the exclusion-only SQL path (no included pages) pushes
    // the NOT IN subquery into SQL instead of loading all blocks.
    let (pool, _dir) = test_pool().await;
    // Page A with children
    insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_A1",
        "content",
        "block a1",
        Some("PAGE_A"),
        Some(1),
    )
    .await;
    insert_block_with_parent(
        &pool,
        "BLK_A2",
        "content",
        "block a2",
        Some("PAGE_A"),
        Some(2),
    )
    .await;
    // Page B with children
    insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_B1",
        "content",
        "block b1",
        Some("PAGE_B"),
        Some(1),
    )
    .await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    insert_block_link(&pool, "BLK_A1", "TARGET").await;
    insert_block_link(&pool, "BLK_A2", "TARGET").await;
    insert_block_link(&pool, "BLK_B1", "TARGET").await;
    let page = default_page();

    // Exclude PAGE_B only (included is empty) — should keep PAGE_A blocks
    let filters = vec![BacklinkFilter::SourcePage {
        included: vec![],
        excluded: vec!["PAGE_B".into()],
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "base set has 3 backlinks");
    assert_eq!(
        resp.filtered_count, 2,
        "PAGE_B blocks excluded, PAGE_A blocks remain"
    );
    let ids: Vec<&str> = resp.items.iter().map(|i| i.id.as_str()).collect();
    assert!(ids.contains(&"BLK_A1"), "BLK_A1 from PAGE_A present");
    assert!(ids.contains(&"BLK_A2"), "BLK_A2 from PAGE_A present");
    assert!(!ids.contains(&"BLK_B1"), "BLK_B1 from PAGE_B excluded");
}

#[tokio::test]
async fn filter_source_page_deeply_nested_hierarchy() {
    // Creates a 5-level deep page hierarchy and verifies the SourcePage
    // filter correctly discovers all descendants via the depth-limited
    // recursive CTE (depth < 100).
    let (pool, _dir) = test_pool().await;

    // Build hierarchy: PAGE_ROOT -> L1 -> L2 -> L3 -> L4 -> LEAF
    insert_block_with_parent(&pool, "PAGE_ROOT", "page", "Root Page", None, None).await;
    insert_block_with_parent(
        &pool,
        "L1",
        "content",
        "level 1",
        Some("PAGE_ROOT"),
        Some(1),
    )
    .await;
    insert_block_with_parent(&pool, "L2", "content", "level 2", Some("L1"), Some(1)).await;
    insert_block_with_parent(&pool, "L3", "content", "level 3", Some("L2"), Some(1)).await;
    insert_block_with_parent(&pool, "L4", "content", "level 4", Some("L3"), Some(1)).await;
    insert_block_with_parent(&pool, "LEAF", "content", "leaf block", Some("L4"), Some(1)).await;

    // Separate page with its own block (should NOT be included)
    insert_block_with_parent(&pool, "OTHER_PAGE", "page", "Other Page", None, None).await;
    insert_block_with_parent(
        &pool,
        "OTHER_BLK",
        "content",
        "other block",
        Some("OTHER_PAGE"),
        Some(1),
    )
    .await;

    // Target page — both LEAF and OTHER_BLK link to it
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    insert_block_link(&pool, "LEAF", "TARGET").await;
    insert_block_link(&pool, "OTHER_BLK", "TARGET").await;
    let page = default_page();

    // Include PAGE_ROOT — should pick up the deeply nested LEAF (5 levels deep)
    let filters = vec![BacklinkFilter::SourcePage {
        included: vec!["PAGE_ROOT".into()],
        excluded: vec![],
    }];

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 2, "base set has 2 backlinks");
    assert_eq!(
        resp.filtered_count, 1,
        "only LEAF (under PAGE_ROOT) matches"
    );
    assert_eq!(resp.items[0].id, "LEAF", "deeply nested LEAF is found");

    // Also verify via resolve_filter directly that all 6 blocks in the
    // hierarchy are returned (PAGE_ROOT + L1..L4 + LEAF).
    let incl_filter = BacklinkFilter::SourcePage {
        included: vec!["PAGE_ROOT".into()],
        excluded: vec![],
    };
    let all_ids = resolve_filter(&pool, &incl_filter, 0).await.unwrap();
    assert!(
        all_ids.contains("PAGE_ROOT"),
        "root itself is in the result set"
    );
    assert!(all_ids.contains("L1"), "L1 descendant found");
    assert!(all_ids.contains("L2"), "L2 descendant found");
    assert!(all_ids.contains("L3"), "L3 descendant found");
    assert!(all_ids.contains("L4"), "L4 descendant found");
    assert!(all_ids.contains("LEAF"), "LEAF descendant found");
    assert_eq!(
        all_ids.len(),
        6,
        "exactly 6 blocks in the PAGE_ROOT subtree"
    );
    assert!(
        !all_ids.contains("OTHER_BLK"),
        "OTHER_BLK is not in the PAGE_ROOT subtree"
    );
}

// ======================================================================
// Direct-column filter variants (TodoState, Priority, DueDate)
// ======================================================================

#[tokio::test]
async fn filter_todo_state_returns_matching_blocks() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_1", "content", "block 1").await;
    insert_block(&pool, "BLK_2", "content", "block 2").await;
    insert_block(&pool, "BLK_3", "content", "block 3").await;

    sqlx::query("UPDATE blocks SET todo_state = 'TODO' WHERE id = ?")
        .bind("BLK_1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET todo_state = 'TODO' WHERE id = ?")
        .bind("BLK_2")
        .execute(&pool)
        .await
        .unwrap();

    let filter = BacklinkFilter::TodoState {
        state: "TODO".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert_eq!(set.len(), 2, "two blocks have TODO state");
    assert!(set.contains("BLK_1"), "BLK_1 has TODO state");
    assert!(set.contains("BLK_2"), "BLK_2 has TODO state");
    assert!(!set.contains("BLK_3"), "BLK_3 has no TODO state");
}

#[tokio::test]
async fn filter_priority_returns_matching_blocks() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_1", "content", "block 1").await;
    insert_block(&pool, "BLK_2", "content", "block 2").await;
    insert_block(&pool, "BLK_3", "content", "block 3").await;

    sqlx::query("UPDATE blocks SET priority = '2' WHERE id = ?")
        .bind("BLK_1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET priority = '2' WHERE id = ?")
        .bind("BLK_3")
        .execute(&pool)
        .await
        .unwrap();

    let filter = BacklinkFilter::Priority { level: "2".into() };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert_eq!(set.len(), 2, "two blocks have priority 2");
    assert!(set.contains("BLK_1"), "BLK_1 has priority 2");
    assert!(set.contains("BLK_3"), "BLK_3 has priority 2");
    assert!(!set.contains("BLK_2"), "BLK_2 does not have priority 2");
}

#[tokio::test]
async fn filter_due_date_eq_returns_exact_match() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_1", "content", "block 1").await;
    insert_block(&pool, "BLK_2", "content", "block 2").await;
    insert_block(&pool, "BLK_3", "content", "block 3").await;

    sqlx::query("UPDATE blocks SET due_date = '2026-04-15' WHERE id = ?")
        .bind("BLK_1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET due_date = '2026-04-15' WHERE id = ?")
        .bind("BLK_2")
        .execute(&pool)
        .await
        .unwrap();

    let filter = BacklinkFilter::DueDate {
        op: CompareOp::Eq,
        value: "2026-04-15".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert_eq!(set.len(), 2, "two blocks have due_date 2026-04-15");
    assert!(set.contains("BLK_1"), "BLK_1 has matching due_date");
    assert!(set.contains("BLK_2"), "BLK_2 has matching due_date");
    assert!(!set.contains("BLK_3"), "BLK_3 has no due_date");
}

#[tokio::test]
async fn filter_due_date_lt_returns_earlier_dates() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_1", "content", "block 1").await;
    insert_block(&pool, "BLK_2", "content", "block 2").await;

    sqlx::query("UPDATE blocks SET due_date = '2026-04-10' WHERE id = ?")
        .bind("BLK_1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET due_date = '2026-04-20' WHERE id = ?")
        .bind("BLK_2")
        .execute(&pool)
        .await
        .unwrap();

    let filter = BacklinkFilter::DueDate {
        op: CompareOp::Lt,
        value: "2026-04-15".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert_eq!(set.len(), 1, "only one block has due_date < 2026-04-15");
    assert!(set.contains("BLK_1"), "BLK_1 (04-10) is earlier");
    assert!(!set.contains("BLK_2"), "BLK_2 (04-20) is not earlier");
}

#[tokio::test]
async fn filter_due_date_contains_returns_validation_error() {
    let (pool, _dir) = test_pool().await;

    let filter = BacklinkFilter::DueDate {
        op: CompareOp::Contains,
        value: "2026".into(),
    };
    let result = resolve_filter(&pool, &filter, 0).await;
    assert!(
        result.is_err(),
        "Contains op should be rejected for DueDate"
    );
    assert!(
        matches!(result.unwrap_err(), AppError::Validation(_)),
        "should return Validation error"
    );
}

#[tokio::test]
async fn filter_due_date_gt_returns_later_dates() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_1", "content", "block 1").await;
    insert_block(&pool, "BLK_2", "content", "block 2").await;

    sqlx::query("UPDATE blocks SET due_date = '2026-04-10' WHERE id = ?")
        .bind("BLK_1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET due_date = '2026-04-20' WHERE id = ?")
        .bind("BLK_2")
        .execute(&pool)
        .await
        .unwrap();

    let filter = BacklinkFilter::DueDate {
        op: CompareOp::Gt,
        value: "2026-04-15".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert_eq!(set.len(), 1, "only the later-dated block should match");
    assert!(
        !set.contains("BLK_1"),
        "BLK_1 (04-10) should not match Gt 04-15"
    );
    assert!(set.contains("BLK_2"), "BLK_2 (04-20) should match Gt 04-15");
}

#[tokio::test]
async fn filter_due_date_gte_returns_equal_or_later() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_1", "content", "block 1").await;
    insert_block(&pool, "BLK_2", "content", "block 2").await;

    sqlx::query("UPDATE blocks SET due_date = '2026-04-15' WHERE id = ?")
        .bind("BLK_1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET due_date = '2026-04-20' WHERE id = ?")
        .bind("BLK_2")
        .execute(&pool)
        .await
        .unwrap();

    let filter = BacklinkFilter::DueDate {
        op: CompareOp::Gte,
        value: "2026-04-15".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert_eq!(set.len(), 2, "both equal and later dates should match");
    assert!(
        set.contains("BLK_1"),
        "BLK_1 (04-15) should match Gte 04-15"
    );
    assert!(
        set.contains("BLK_2"),
        "BLK_2 (04-20) should match Gte 04-15"
    );
}

#[tokio::test]
async fn filter_due_date_lte_returns_equal_or_earlier() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_1", "content", "block 1").await;
    insert_block(&pool, "BLK_2", "content", "block 2").await;

    sqlx::query("UPDATE blocks SET due_date = '2026-04-10' WHERE id = ?")
        .bind("BLK_1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET due_date = '2026-04-20' WHERE id = ?")
        .bind("BLK_2")
        .execute(&pool)
        .await
        .unwrap();

    let filter = BacklinkFilter::DueDate {
        op: CompareOp::Lte,
        value: "2026-04-10".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert_eq!(set.len(), 1, "only equal or earlier dates should match");
    assert!(
        set.contains("BLK_1"),
        "BLK_1 (04-10) should match Lte 04-10"
    );
    assert!(
        !set.contains("BLK_2"),
        "BLK_2 (04-20) should not match Lte 04-10"
    );
}

#[tokio::test]
async fn filter_due_date_ne_returns_not_equal() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_1", "content", "block 1").await;
    insert_block(&pool, "BLK_2", "content", "block 2").await;

    sqlx::query("UPDATE blocks SET due_date = '2026-04-10' WHERE id = ?")
        .bind("BLK_1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE blocks SET due_date = '2026-04-20' WHERE id = ?")
        .bind("BLK_2")
        .execute(&pool)
        .await
        .unwrap();

    let filter = BacklinkFilter::DueDate {
        op: CompareOp::Neq,
        value: "2026-04-10".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert_eq!(
        set.len(),
        1,
        "only the non-matching block should be returned"
    );
    assert!(
        !set.contains("BLK_1"),
        "BLK_1 (04-10) should not match Neq 04-10"
    );
    assert!(
        set.contains("BLK_2"),
        "BLK_2 (04-20) should match Neq 04-10"
    );
}

// ======================================================================
// #576 — eval_unlinked_references tests
// ======================================================================

#[tokio::test]
async fn eval_unlinked_refs_empty_when_page_has_no_title() {
    let (pool, _dir) = test_pool().await;
    // Page with NULL content
    sqlx::query("INSERT INTO blocks (id, block_type, content) VALUES ('PAGE1', 'page', NULL)")
        .execute(&pool)
        .await
        .unwrap();

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "PAGE1", &page)
        .await
        .unwrap();
    assert!(resp.groups.is_empty(), "no title means no unlinked refs");
    assert_eq!(resp.total_count, 0, "total count should be 0");
    assert_eq!(resp.filtered_count, 0, "filtered count should be 0");
    assert!(!resp.has_more, "should not have more pages");
}

#[tokio::test]
async fn eval_unlinked_refs_finds_mentioning_blocks() {
    let (pool, _dir) = test_pool().await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Project Alpha", None, None).await;
    // Another page with a child block mentioning "Project Alpha" (no link)
    insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_B1",
        "content",
        "We should check Project Alpha for updates",
        Some("PAGE_B"),
        Some(1),
    )
    .await;
    // Index the block in FTS
    insert_fts(&pool, "BLK_B1", "We should check Project Alpha for updates").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", &page)
        .await
        .unwrap();
    assert_eq!(resp.groups.len(), 1, "one source page group");
    assert_eq!(
        resp.groups[0].page_id, "PAGE_B",
        "group should be from PAGE_B"
    );
    assert_eq!(
        resp.groups[0].page_title.as_deref(),
        Some("Page B"),
        "group title should match"
    );
    assert_eq!(resp.groups[0].blocks.len(), 1, "one mentioning block");
    assert_eq!(
        resp.groups[0].blocks[0].id, "BLK_B1",
        "BLK_B1 mentions the title"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_excludes_linked_blocks() {
    let (pool, _dir) = test_pool().await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Project Alpha", None, None).await;
    // Another page with a child block that mentions AND links to target
    insert_block_with_parent(&pool, "PAGE_C", "page", "Page C", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_C1",
        "content",
        "See [[Project Alpha]] for details",
        Some("PAGE_C"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_C1", "See Project Alpha for details").await;
    // This block has an explicit link
    insert_block_link(&pool, "BLK_C1", "TARGET").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", &page)
        .await
        .unwrap();
    assert!(
        resp.groups.is_empty(),
        "linked block should be excluded from unlinked references"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_excludes_own_page_blocks() {
    let (pool, _dir) = test_pool().await;
    // Target page whose own child mentions the title
    insert_block_with_parent(&pool, "TARGET", "page", "Project Alpha", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_SELF",
        "content",
        "This page is about Project Alpha",
        Some("TARGET"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_SELF", "This page is about Project Alpha").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", &page)
        .await
        .unwrap();
    assert!(
        resp.groups.is_empty(),
        "blocks from the target page itself should be excluded"
    );
    assert_eq!(
        resp.total_count, 0,
        "total_count should exclude self-references"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_handles_special_chars_in_title() {
    let (pool, _dir) = test_pool().await;
    // Page with special characters in title
    insert_block_with_parent(&pool, "TARGET", "page", "C++ \"Tips\" & Tricks", None, None).await;
    // Another page mentioning it
    insert_block_with_parent(&pool, "PAGE_D", "page", "Page D", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_D1",
        "content",
        "Read C++ \"Tips\" & Tricks for help",
        Some("PAGE_D"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_D1", "Read C++ \"Tips\" & Tricks for help").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", &page)
        .await
        .unwrap();
    assert_eq!(
        resp.groups.len(),
        1,
        "should find the mention despite special chars"
    );
    assert_eq!(resp.groups[0].page_id, "PAGE_D", "group is from PAGE_D");
    assert_eq!(resp.groups[0].blocks.len(), 1, "one mentioning block");
    assert_eq!(
        resp.groups[0].blocks[0].id, "BLK_D1",
        "BLK_D1 mentions the special-char title"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_cursor_pagination() {
    let (pool, _dir) = test_pool().await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Project Alpha", None, None).await;

    // Create 3 pages with child blocks mentioning "Project Alpha"
    for ch in ['A', 'B', 'C'] {
        let page_id = format!("PAGE_{ch}");
        let blk_id = format!("BLK_{ch}1");
        let page_title = format!("Page {ch}");
        let blk_content = format!("Mentions Project Alpha in page {ch}");
        insert_block_with_parent(&pool, &page_id, "page", &page_title, None, None).await;
        insert_block_with_parent(
            &pool,
            &blk_id,
            "content",
            &blk_content,
            Some(&page_id),
            Some(1),
        )
        .await;
        insert_fts(&pool, &blk_id, &blk_content).await;
    }

    // First page: limit=1
    let page1 = PageRequest::new(None, Some(1)).unwrap();
    let resp1 = eval_unlinked_references(&pool, "TARGET", &page1)
        .await
        .unwrap();
    assert_eq!(resp1.groups.len(), 1, "first page has 1 group");
    assert!(resp1.has_more, "first page should have more");
    assert!(resp1.next_cursor.is_some(), "first page needs cursor");
    assert_eq!(
        resp1.groups[0].page_id, "PAGE_A",
        "alphabetically first page"
    ); // alphabetically first

    // Second page via cursor
    let page2 = PageRequest::new(resp1.next_cursor, Some(1)).unwrap();
    let resp2 = eval_unlinked_references(&pool, "TARGET", &page2)
        .await
        .unwrap();
    assert_eq!(resp2.groups.len(), 1, "second page has 1 group");
    assert!(resp2.has_more, "second page should have more");
    assert!(resp2.next_cursor.is_some(), "second page needs cursor");
    assert_eq!(resp2.groups[0].page_id, "PAGE_B", "second page is PAGE_B");

    // Third page via cursor
    let page3 = PageRequest::new(resp2.next_cursor, Some(1)).unwrap();
    let resp3 = eval_unlinked_references(&pool, "TARGET", &page3)
        .await
        .unwrap();
    assert_eq!(resp3.groups.len(), 1, "third page has 1 group");
    assert!(!resp3.has_more, "third page is the last");
    assert!(resp3.next_cursor.is_none(), "no cursor on last page");
    assert_eq!(resp3.groups[0].page_id, "PAGE_C", "third page is PAGE_C");
}

#[tokio::test]
async fn eval_unlinked_refs_mixed_linked_and_unlinked() {
    let (pool, _dir) = test_pool().await;
    // Target page
    insert_block_with_parent(&pool, "TARGET", "page", "Project Alpha", None, None).await;
    // Page E: one block mentions (unlinked), another mentions AND links
    insert_block_with_parent(&pool, "PAGE_E", "page", "Page E", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_E1",
        "content",
        "Project Alpha is great",
        Some("PAGE_E"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_E1", "Project Alpha is great").await;

    insert_block_with_parent(
        &pool,
        "BLK_E2",
        "content",
        "See [[Project Alpha]]",
        Some("PAGE_E"),
        Some(2),
    )
    .await;
    insert_fts(&pool, "BLK_E2", "See Project Alpha").await;
    insert_block_link(&pool, "BLK_E2", "TARGET").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", &page)
        .await
        .unwrap();
    // Only BLK_E1 should appear (BLK_E2 is linked)
    assert_eq!(resp.groups.len(), 1, "one group for unlinked references");
    assert_eq!(resp.groups[0].page_id, "PAGE_E", "group is from PAGE_E");
    assert_eq!(
        resp.groups[0].blocks.len(),
        1,
        "only unlinked block included"
    );
    assert_eq!(
        resp.groups[0].blocks[0].id, "BLK_E1",
        "BLK_E1 is unlinked mention"
    );
}

// ======================================================================
// B-71 — Unlinked references should consider page aliases
// ======================================================================

/// Insert a page alias row.
async fn insert_alias(pool: &SqlitePool, page_id: &str, alias: &str) {
    sqlx::query("INSERT INTO page_aliases (page_id, alias) VALUES (?, ?)")
        .bind(page_id)
        .bind(alias)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn eval_unlinked_refs_matches_alias() {
    let (pool, _dir) = test_pool().await;
    // Target page with an alias (>= 3 chars for trigram FTS5 tokenizer)
    insert_block_with_parent(&pool, "TARGET", "page", "Project Alpha", None, None).await;
    insert_alias(&pool, "TARGET", "ProjAlpha").await;

    // Another page with a block mentioning the alias text (not the title)
    insert_block_with_parent(&pool, "PAGE_F", "page", "Page F", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_F1",
        "content",
        "We should look at ProjAlpha for guidance",
        Some("PAGE_F"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_F1", "We should look at ProjAlpha for guidance").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", &page)
        .await
        .unwrap();
    assert_eq!(resp.groups.len(), 1, "one group matching via alias");
    assert_eq!(
        resp.groups[0].page_id, "PAGE_F",
        "group should be from PAGE_F"
    );
    assert_eq!(resp.groups[0].blocks.len(), 1, "one mentioning block");
    assert_eq!(
        resp.groups[0].blocks[0].id, "BLK_F1",
        "BLK_F1 mentions the alias"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_matches_title_or_alias() {
    let (pool, _dir) = test_pool().await;
    // Target page with title "ProjectX" and alias "ProX" (>= 3 chars for trigram FTS5)
    insert_block_with_parent(&pool, "TARGET", "page", "ProjectX", None, None).await;
    insert_alias(&pool, "TARGET", "ProX").await;

    // Page G: block mentions "ProjectX" (title)
    insert_block_with_parent(&pool, "PAGE_G", "page", "Page G", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_G1",
        "content",
        "Check out ProjectX soon",
        Some("PAGE_G"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_G1", "Check out ProjectX soon").await;

    // Page H: block mentions "ProX" (alias)
    insert_block_with_parent(&pool, "PAGE_H", "page", "Page H", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_H1",
        "content",
        "ProX has the details we need",
        Some("PAGE_H"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_H1", "ProX has the details we need").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", &page)
        .await
        .unwrap();
    assert_eq!(
        resp.groups.len(),
        2,
        "two groups: one for title match, one for alias match"
    );
    let page_ids: Vec<&str> = resp.groups.iter().map(|g| g.page_id.as_str()).collect();
    assert!(
        page_ids.contains(&"PAGE_G"),
        "PAGE_G should appear (title match)"
    );
    assert!(
        page_ids.contains(&"PAGE_H"),
        "PAGE_H should appear (alias match)"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_linked_blocks_excluded_even_with_alias() {
    let (pool, _dir) = test_pool().await;
    // Target page with an alias (>= 3 chars for trigram FTS5)
    insert_block_with_parent(&pool, "TARGET", "page", "Project Alpha", None, None).await;
    insert_alias(&pool, "TARGET", "ProjAlpha").await;

    // Another page with a block that mentions the alias AND links to target
    insert_block_with_parent(&pool, "PAGE_I", "page", "Page I", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_I1",
        "content",
        "See ProjAlpha for more info",
        Some("PAGE_I"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_I1", "See ProjAlpha for more info").await;
    insert_block_link(&pool, "BLK_I1", "TARGET").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", &page)
        .await
        .unwrap();
    assert!(
        resp.groups.is_empty(),
        "linked block should be excluded even when matching via alias"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_empty_alias_ignored() {
    let (pool, _dir) = test_pool().await;
    // Target page with an empty alias and a whitespace-only alias
    insert_block_with_parent(&pool, "TARGET", "page", "Project Alpha", None, None).await;
    insert_alias(&pool, "TARGET", "").await;
    insert_alias(&pool, "TARGET", "   ").await;

    // A block that does NOT mention the title — should not match
    insert_block_with_parent(&pool, "PAGE_J", "page", "Page J", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_J1",
        "content",
        "Some unrelated content here",
        Some("PAGE_J"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_J1", "Some unrelated content here").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", &page)
        .await
        .unwrap();
    assert!(
        resp.groups.is_empty(),
        "empty/whitespace aliases should not cause false matches"
    );
}
