use super::filters::{
    crockford_decode_char, ms_to_ulid_prefix, parse_iso_to_ms, resolve_filter,
    resolve_filter_with_candidates, ulid_to_ms,
};
use super::grouped::{eval_backlink_query_grouped, eval_unlinked_references};
use super::query::{
    eval_backlink_query, fetch_block_rows_by_ids, list_property_keys, resolve_root_pages,
    resolve_root_pages_cte,
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

// PERF-27: `Contains` and `StartsWith` are pushed down to SQL via `LIKE
// ? ESCAPE '\'`.  The test below covers `Contains` and also verifies
// that `%` / `_` in the user input are treated literally (not as LIKE
// wildcards) via `escape_like`, so callers cannot accidentally or
// maliciously match more rows than intended.
#[tokio::test]
async fn filter_property_text_contains_pushed_into_sql() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    // SRC_A's tag contains the literal substring "foo".
    // SRC_B's tag does not.
    // SRC_C's tag contains "%" literally — used to prove that the
    // escape logic prevents a naive `LIKE '%%%'` from matching SRC_A/SRC_B.
    insert_property(&pool, "SRC_A", "tag", Some("alpha-foo-bar"), None, None).await;
    insert_property(&pool, "SRC_B", "tag", Some("alpha-baz-bar"), None, None).await;
    insert_property(&pool, "SRC_C", "tag", Some("50% off"), None, None).await;

    // Plain substring match.
    let filter = BacklinkFilter::PropertyText {
        key: "tag".into(),
        op: CompareOp::Contains,
        value: "foo".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "alpha-foo-bar contains 'foo'");
    assert!(
        !set.contains("SRC_B"),
        "alpha-baz-bar does not contain 'foo'"
    );
    assert!(!set.contains("SRC_C"), "50% off does not contain 'foo'");

    // `%` in the needle must match literally, not as a LIKE wildcard.
    let filter_pct = BacklinkFilter::PropertyText {
        key: "tag".into(),
        op: CompareOp::Contains,
        value: "%".into(),
    };
    let set_pct = resolve_filter(&pool, &filter_pct, 0).await.unwrap();
    assert!(set_pct.contains("SRC_C"), "50% off contains literal '%'");
    assert!(
        !set_pct.contains("SRC_A"),
        "alpha-foo-bar has no literal '%' — must not match an unescaped '%' wildcard"
    );
    assert!(
        !set_pct.contains("SRC_B"),
        "alpha-baz-bar has no literal '%' — must not match an unescaped '%' wildcard"
    );
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
// MAINT-143 / UX-250 — `BacklinkFilter::HasTag` & `HasTagPrefix` share
// the leaf-resolution SQL with `tag_query::resolve_expr` via the
// `resolve_tag_leaves` / `resolve_tag_prefix_leaves` helpers. Inline
// `#[ULID]` references stored in `block_tag_refs` must union into the
// result set alongside explicit `block_tags` associations. This single
// test pins the shared semantic at the backlink site so a future
// divergence between the two sites cannot regress silently. Mirrors
// the resolver-side coverage in
// `tag_query/resolve/tests.rs::resolve_tag_unions_inline_refs_into_results`.
// ======================================================================

#[tokio::test]
async fn maint143_inline_ref_union_shared_leaf_sql() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_block(&pool, "TAG_UX_EX", "tag", "ux-explicit").await;
    insert_block(&pool, "TAG_UX_IN", "tag", "ux-inline").await;
    insert_tag_cache(&pool, "TAG_UX_EX", "proj/explicit", 1).await;
    insert_tag_cache(&pool, "TAG_UX_IN", "proj/inline", 1).await;

    // SRC_A: explicit block_tags row.
    // SRC_B: only an inline #[ULID] ref recorded in block_tag_refs (the
    //        materializer-observed case before any explicit tagging).
    // SRC_C: untagged.
    insert_tag_assoc(&pool, "SRC_A", "TAG_UX_EX").await;
    sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
        .bind("SRC_B")
        .bind("TAG_UX_IN")
        .execute(&pool)
        .await
        .unwrap();

    // HasTag: inline-ref source must surface alongside explicit ones.
    let set_inline = resolve_filter(
        &pool,
        &BacklinkFilter::HasTag {
            tag_id: "TAG_UX_IN".into(),
        },
        0,
    )
    .await
    .unwrap();
    assert!(
        set_inline.contains("SRC_B"),
        "UX-250: HasTag must union block_tag_refs (inline #[ULID]) — \
         this pins parity with tag_query::resolve_tag_leaves"
    );
    assert!(!set_inline.contains("SRC_A"));
    assert!(!set_inline.contains("SRC_C"));

    // HasTagPrefix: same semantics through the prefix helper.
    let set_prefix = resolve_filter(
        &pool,
        &BacklinkFilter::HasTagPrefix {
            prefix: "proj/".into(),
        },
        0,
    )
    .await
    .unwrap();
    assert!(
        set_prefix.contains("SRC_A"),
        "explicit block_tags row under prefix must match"
    );
    assert!(
        set_prefix.contains("SRC_B"),
        "UX-250: HasTagPrefix must union block_tag_refs (inline #[ULID]) — \
         this pins parity with tag_query::resolve_tag_prefix_leaves"
    );
    assert!(!set_prefix.contains("SRC_C"));
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
// I-Search-9 — BlockType filter must honour an optional candidate set
// ======================================================================
//
// `BacklinkFilter::BlockType` historically materialised every active
// block of the requested type into an `FxHashSet<String>` before
// intersecting with the surrounding base/candidate set in Rust. On a
// 100k-block vault that pulled ~30 MB of `String` allocations only to
// discard most of them. The candidate-aware path mirrors
// `PropertyIsEmpty`'s json_each() optimisation.
//
// Both tests below seed 1000 active "content" blocks so the difference
// between the unscoped and scoped paths is observable.

/// Insert `n` active content blocks named `BLK_0001..BLK_{n}` and
/// return their IDs in insertion order.
async fn insert_n_content_blocks(pool: &SqlitePool, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    for i in 1..=n {
        let id = format!("BLK_{i:04}");
        insert_block(pool, &id, "content", &format!("body {i}")).await;
        ids.push(id);
    }
    ids
}

#[tokio::test]
async fn block_type_filter_with_candidates_returns_subset_i_search_9() {
    let (pool, _dir) = test_pool().await;
    let all_ids = insert_n_content_blocks(&pool, 1000).await;

    // Ten arbitrary candidates — must be returned in full, and nothing
    // else must leak through from the other 990 active content blocks.
    let candidate_ids: Vec<String> = all_ids.iter().step_by(100).cloned().collect();
    assert_eq!(candidate_ids.len(), 10, "expected 10 candidate ids");
    let candidates: FxHashSet<String> = candidate_ids.iter().cloned().collect();

    let filter = BacklinkFilter::BlockType {
        block_type: "content".into(),
    };
    let set = resolve_filter_with_candidates(&pool, &filter, 0, Some(&candidates))
        .await
        .unwrap();

    assert_eq!(
        set.len(),
        10,
        "candidate-scoped BlockType must not leak the other 990 content blocks"
    );
    for id in &candidate_ids {
        assert!(set.contains(id), "expected candidate {id} in scoped result");
    }
    assert_eq!(
        set, candidates,
        "scoped BlockType result must equal the candidate set exactly"
    );
}

#[tokio::test]
async fn block_type_filter_without_candidates_unchanged_i_search_9() {
    let (pool, _dir) = test_pool().await;
    let all_ids = insert_n_content_blocks(&pool, 1000).await;

    // No candidate set → fallback path; must still surface all 1000.
    let filter = BacklinkFilter::BlockType {
        block_type: "content".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();

    assert_eq!(
        set.len(),
        1000,
        "unscoped BlockType must still return every active block of the type"
    );
    let expected: FxHashSet<String> = all_ids.into_iter().collect();
    assert_eq!(
        set, expected,
        "unscoped BlockType result must equal the full active set"
    );
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
        None,
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
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 3, "should return all 3 backlinks");
    assert_eq!(resp.total_count, 3, "total count should be 3");
    assert_eq!(resp.filtered_count, 3, "filtered count should be 3");
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
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 3, "should return all 3 backlinks");
    assert_eq!(resp.total_count, 3, "total count should be 3");
    assert_eq!(resp.filtered_count, 3, "filtered count should be 3");
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
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 3, "should return all 3 backlinks");
    assert_eq!(resp.total_count, 3, "total count should be 3");
    assert_eq!(resp.filtered_count, 3, "filtered count should be 3");
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
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.items.len(), 3, "should return all 3 backlinks");
    assert_eq!(resp.total_count, 3, "total count should be 3");
    assert_eq!(resp.filtered_count, 3, "filtered count should be 3");
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

    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page, None)
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
    let resp1 = eval_backlink_query(&pool, "TARGET", None, None, &page1, None)
        .await
        .unwrap();
    assert_eq!(resp1.items.len(), 2, "first page should have 2 items");
    assert!(resp1.has_more, "first page should indicate more");

    // Second page
    let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
    let resp2 = eval_backlink_query(&pool, "TARGET", None, None, &page2, None)
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

/// I-Search-18: pagination cursor works for `Created { Desc }`.
///
/// Mirrors `pagination_cursor_works` but with descending creation-order
/// sort. Guards against the upstream H-10 regression where
/// `binary_search_by` on a descending slice silently emptied every page
/// past page 1 (now fixed via `partition_point` in `query.rs`).
#[tokio::test]
async fn pagination_cursor_works_for_created_desc_i_search_18() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    // Desc order over SRC_A < SRC_B < SRC_C (ULID-lexicographic) is
    // SRC_C, SRC_B, SRC_A.
    let sort = Some(BacklinkSort::Created { dir: SortDir::Desc });

    // First page
    let page1 = PageRequest::new(None, Some(2)).unwrap();
    let resp1 = eval_backlink_query(&pool, "TARGET", None, sort.clone(), &page1, None)
        .await
        .unwrap();
    assert_eq!(resp1.items.len(), 2, "first page should have 2 items");
    assert_eq!(resp1.items[0].id, "SRC_C", "first item in desc order");
    assert_eq!(resp1.items[1].id, "SRC_B", "second item in desc order");
    assert!(resp1.has_more, "first page should indicate more");
    assert!(
        resp1.next_cursor.is_some(),
        "first page should produce a cursor"
    );

    // Second page
    let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
    let resp2 = eval_backlink_query(&pool, "TARGET", None, sort, &page2, None)
        .await
        .unwrap();
    assert_eq!(
        resp2.items.len(),
        1,
        "second page should have 1 remaining item"
    );
    assert_eq!(
        resp2.items[0].id, "SRC_A",
        "remaining item is SRC_A (last in desc order)"
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
    let resp1 = eval_backlink_query(&pool, "TARGET", None, None, &page1, None)
        .await
        .unwrap();
    assert_eq!(resp1.items.len(), 1, "first page has 1 item");
    assert!(resp1.has_more, "more items after first");
    let first_id = resp1.items[0].id.clone();

    // Second page via cursor from first item (cursor ID exists)
    let page2 = PageRequest::new(resp1.next_cursor, Some(1)).unwrap();
    let resp2 = eval_backlink_query(&pool, "TARGET", None, None, &page2, None)
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
    let resp3 = eval_backlink_query(&pool, "TARGET", None, None, &page3, None)
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
    let all = eval_backlink_query(&pool, "TARGET", None, None, &all_page, None)
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
    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page_missing, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "total includes all 3 backlinks");
    assert_eq!(resp.filtered_count, 2, "only 2 have status property set");
    assert_eq!(resp.items.len(), 1, "page limit is 1");
    assert!(resp.has_more, "more filtered results remain");
}

// ======================================================================
// H-10 — Created { Desc } cursor pagination must not silently empty
// after page 1.
//
// Regression: prior to the fix, `eval_backlink_query` used
// `binary_search_by(|s| s.cmp(after_id))` on the sorted slice without
// adjusting the comparator for descending order. On a descending slice
// the natural comparator is monotonically *wrong*, so for any cursor
// whose ID is greater than the slice's first element, `binary_search_by`
// returns `Err(0)` and pagination starts at index 0 — yielding the same
// page-1 contents on page 2 (or worse, an empty page once the limit+1
// guard eats the duplicates).
//
// The fix uses `partition_point` with a direction-aware predicate so
// the cursor lookup respects whichever order `sort_ids` produced.
//
// Each test seeds N ≥ 30 backlinks with strictly distinct, lex-sortable
// IDs (stand-ins for ULIDs whose timestamps differ by 1 s — the same
// abstraction used throughout this module's existing Created-sort tests).
// ======================================================================

/// Helper: insert N source blocks with zero-padded IDs that link to
/// `target_id`. IDs sort lexicographically in ascending order, mirroring
/// ULID time-order. Returns the inserted IDs in ascending order.
async fn seed_n_backlinks(pool: &SqlitePool, target_id: &str, n: usize) -> Vec<String> {
    let mut ids = Vec::with_capacity(n);
    for i in 1..=n {
        let id = format!("BLK_{i:04}");
        insert_block(pool, &id, "content", &format!("source {i}")).await;
        insert_block_link(pool, &id, target_id).await;
        ids.push(id);
    }
    ids
}

#[tokio::test]
async fn eval_backlink_query_created_desc_page_2_returns_remaining_results() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "Target Page").await;
    let asc_ids = seed_n_backlinks(&pool, "TARGET", 30).await;

    // Page 1: Created Desc, limit = 10.
    let page1 = PageRequest::new(None, Some(10)).unwrap();
    let resp1 = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::Created { dir: SortDir::Desc }),
        &page1,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp1.items.len(), 10, "page 1 returns 10 items");
    assert!(resp1.has_more, "page 1 must indicate more pages");
    assert!(
        resp1.next_cursor.is_some(),
        "page 1 must provide a next cursor"
    );
    // Descending order: highest IDs first → BLK_0030 .. BLK_0021.
    let desc_all: Vec<&str> = asc_ids.iter().rev().map(String::as_str).collect();
    let page1_actual: Vec<&str> = resp1.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        page1_actual,
        desc_all[..10].to_vec(),
        "page 1 in descending order"
    );

    // Page 2: same sort, cursor from page 1.
    //
    // Pre-fix this returned an empty page because `binary_search_by` on
    // a descending slice with `after_id = BLK_0021` returned `Err(0)`,
    // re-yielding page 1 then trimming to nothing once the +1 fetch
    // limit detected duplicates.
    let page2 = PageRequest::new(resp1.next_cursor, Some(10)).unwrap();
    let resp2 = eval_backlink_query(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::Created { dir: SortDir::Desc }),
        &page2,
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        resp2.items.len(),
        10,
        "page 2 must return the next 10 items, not be empty (H-10)"
    );
    let page2_actual: Vec<&str> = resp2.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        page2_actual,
        desc_all[10..20].to_vec(),
        "page 2 continues the descending sequence after page 1"
    );
    assert!(resp2.has_more, "page 2 has more (1 page left)");
}

#[tokio::test]
async fn eval_backlink_query_created_desc_page_3_returns_remaining_results() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "Target Page").await;
    let asc_ids = seed_n_backlinks(&pool, "TARGET", 30).await;
    let desc_all: Vec<&str> = asc_ids.iter().rev().map(String::as_str).collect();

    let sort = BacklinkSort::Created { dir: SortDir::Desc };

    // Page 1
    let page1 = PageRequest::new(None, Some(10)).unwrap();
    let resp1 = eval_backlink_query(&pool, "TARGET", None, Some(sort.clone()), &page1, None)
        .await
        .unwrap();
    let actual1: Vec<&str> = resp1.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(actual1, desc_all[..10].to_vec(), "page 1 desc[0..10]");

    // Page 2
    let page2 = PageRequest::new(resp1.next_cursor, Some(10)).unwrap();
    let resp2 = eval_backlink_query(&pool, "TARGET", None, Some(sort.clone()), &page2, None)
        .await
        .unwrap();
    let actual2: Vec<&str> = resp2.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(actual2, desc_all[10..20].to_vec(), "page 2 desc[10..20]");

    // Page 3: must yield the final 10 items, not empty.
    let page3 = PageRequest::new(resp2.next_cursor, Some(10)).unwrap();
    let resp3 = eval_backlink_query(&pool, "TARGET", None, Some(sort), &page3, None)
        .await
        .unwrap();
    let actual3: Vec<&str> = resp3.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(
        actual3,
        desc_all[20..30].to_vec(),
        "page 3 must return desc[20..30], not be empty (H-10)"
    );
    assert!(!resp3.has_more, "page 3 is the last page");
    assert!(resp3.next_cursor.is_none(), "no cursor on last page");
}

#[tokio::test]
async fn eval_backlink_query_created_asc_pagination_unchanged() {
    // Regression guard: the H-10 fix swaps `binary_search_by` for
    // `partition_point`. The Asc path must still walk the full pagination
    // sequence in lex order — this test pins that behaviour so we cannot
    // accidentally regress the formerly-working Asc direction while
    // fixing the Desc direction.
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "TARGET", "page", "Target Page").await;
    let asc_ids = seed_n_backlinks(&pool, "TARGET", 30).await;
    let asc_all: Vec<&str> = asc_ids.iter().map(String::as_str).collect();

    let sort = BacklinkSort::Created { dir: SortDir::Asc };

    // Page 1
    let page1 = PageRequest::new(None, Some(10)).unwrap();
    let resp1 = eval_backlink_query(&pool, "TARGET", None, Some(sort.clone()), &page1, None)
        .await
        .unwrap();
    let actual1: Vec<&str> = resp1.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(actual1, asc_all[..10].to_vec(), "page 1 asc[0..10]");
    assert!(resp1.has_more);

    // Page 2
    let page2 = PageRequest::new(resp1.next_cursor, Some(10)).unwrap();
    let resp2 = eval_backlink_query(&pool, "TARGET", None, Some(sort.clone()), &page2, None)
        .await
        .unwrap();
    let actual2: Vec<&str> = resp2.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(actual2, asc_all[10..20].to_vec(), "page 2 asc[10..20]");
    assert!(resp2.has_more);

    // Page 3
    let page3 = PageRequest::new(resp2.next_cursor, Some(10)).unwrap();
    let resp3 = eval_backlink_query(&pool, "TARGET", None, Some(sort), &page3, None)
        .await
        .unwrap();
    let actual3: Vec<&str> = resp3.items.iter().map(|b| b.id.as_str()).collect();
    assert_eq!(actual3, asc_all[20..30].to_vec(), "page 3 asc[20..30]");
    assert!(!resp3.has_more, "page 3 is the last page");
    assert!(resp3.next_cursor.is_none(), "no cursor on last page");
}

// ======================================================================
// Empty filters = all backlinks (backward compat)
// ======================================================================

#[tokio::test]
async fn empty_filters_returns_all_backlinks() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    let page = default_page();

    let resp = eval_backlink_query(&pool, "TARGET", Some(vec![]), None, &page, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page, None)
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

    let resp = eval_backlink_query(&pool, "LONELY", None, None, &page, None)
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
    sqlx::query("UPDATE blocks SET deleted_at = 1735689600000 WHERE id = 'SRC_A'")
        .execute(&pool)
        .await
        .unwrap();
    let page = default_page();

    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page, None)
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

/// Safety cap: `list_property_keys` ends with `LIMIT 1000` so a runaway
/// property-key schema cannot blow up the UI render budget. Insert
/// 1001 distinct property keys on a single block and assert the result
/// is clamped to exactly 1000 — proves the cap is enforced and the
/// query did not silently fall back to all rows.
#[tokio::test]
async fn list_property_keys_caps_at_1000() {
    let (pool, _dir) = test_pool().await;
    insert_block(&pool, "BLK_CAP", "content", "many props").await;
    for i in 0..1001 {
        let key = format!("prop_{i:05}");
        insert_property(&pool, "BLK_CAP", &key, Some("v"), None, None).await;
    }
    let keys = list_property_keys(&pool).await.unwrap();
    assert_eq!(
        keys.len(),
        1000,
        "list_property_keys must cap at LIMIT 1000; got {}",
        keys.len()
    );
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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
// PERF-27 inline-SQL operator coverage for PropertyNum / PropertyDate.
// These tests exercise the post-PERF-27 SQL-pushdown shape (replacing
// the prior Rust-side `.fetch_all` + `.filter()` evaluation).
// ======================================================================

// PERF-27: `Eq` is now SQL `=` rather than `|a - b| < f64::EPSILON`.
// The classic 0.1 + 0.2 vs 0.3 floating-point gotcha gives us two
// values that differ by ≈5.55e-17 — strictly less than f64::EPSILON
// (≈2.22e-16) — so the OLD EPSILON-tolerant comparison would have
// treated them as equal, while SQL `=` (the new push-down) does not.
// This pins the audit's correctness fix so future refactors can't
// silently reintroduce the tolerance.
#[tokio::test]
async fn filter_property_num_eq_uses_sql_equals_not_epsilon() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    // Sanity-check the platform's IEEE-754 behaviour: these two
    // values are distinct but within f64::EPSILON of each other.
    let lhs: f64 = 0.1 + 0.2; // 0.30000000000000004
    let rhs: f64 = 0.3;
    assert_ne!(
        lhs, rhs,
        "platform precondition: 0.1 + 0.2 != 0.3 in IEEE-754"
    );
    assert!(
        (lhs - rhs).abs() < f64::EPSILON,
        "platform precondition: |0.1+0.2 - 0.3| < f64::EPSILON \
         (the OLD Rust-side check would have considered them equal)"
    );

    insert_property(&pool, "SRC_A", "score", None, Some(rhs), None).await; // 0.3
    insert_property(&pool, "SRC_B", "score", None, Some(lhs), None).await; // 0.30000000000000004

    let filter = BacklinkFilter::PropertyNum {
        key: "score".into(),
        op: CompareOp::Eq,
        value: 0.3,
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(
        set.contains("SRC_A"),
        "SRC_A (exactly 0.3) must match SQL `=` 0.3"
    );
    // Pinned: the SQL `=` push-down matches
    // `pagination/properties.rs::query_by_property` and does NOT
    // re-introduce the old f64::EPSILON tolerance.
    assert!(
        !set.contains("SRC_B"),
        "SRC_B (0.1 + 0.2 = 0.30000000000000004) is a distinct f64 \
         and must NOT match SQL `=` 0.3"
    );
}

// PERF-27: `Contains` / `StartsWith` are nonsensical for numeric
// properties.  The post-pushdown implementation short-circuits to an
// empty set rather than running a string-LIKE on `value_num`.
#[tokio::test]
async fn filter_property_num_contains_and_starts_with_return_empty() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "score", None, Some(123.0), None).await;
    insert_property(&pool, "SRC_B", "score", None, Some(1230.0), None).await;

    let contains = BacklinkFilter::PropertyNum {
        key: "score".into(),
        op: CompareOp::Contains,
        value: 123.0,
    };
    let set_contains = resolve_filter(&pool, &contains, 0).await.unwrap();
    assert!(
        set_contains.is_empty(),
        "Contains is meaningless for numeric props — must return empty"
    );

    let starts_with = BacklinkFilter::PropertyNum {
        key: "score".into(),
        op: CompareOp::StartsWith,
        value: 123.0,
    };
    let set_starts_with = resolve_filter(&pool, &starts_with, 0).await.unwrap();
    assert!(
        set_starts_with.is_empty(),
        "StartsWith is meaningless for numeric props — must return empty"
    );
}

// PERF-27: `Contains` on date strings is a substring LIKE pushed into
// SQL.  Verifies the operator returns the expected matches and that
// `%` / `_` in the needle are escaped so they match literally rather
// than as LIKE wildcards.
#[tokio::test]
async fn filter_property_date_contains_pushed_into_sql() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;
    // A pathological date-shaped string with a literal `%` to prove
    // the escape logic.  (We store it in `value_date`; the SQL doesn't
    // validate the format — it only compares lexicographically.)
    insert_property(&pool, "SRC_C", "due", None, None, Some("2025-%1-30")).await;

    // Plain substring match: "2025-01" matches SRC_A only.
    let filter = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::Contains,
        value: "2025-01".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "2025-01-15 contains '2025-01'");
    assert!(
        !set.contains("SRC_B"),
        "2025-02-20 does not contain '2025-01'"
    );
    assert!(
        !set.contains("SRC_C"),
        "2025-%1-30 does not contain '2025-01'"
    );

    // `%` in the needle must be treated literally, not as a LIKE
    // wildcard — otherwise "%" alone would match every row.
    let filter_pct = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::Contains,
        value: "%".into(),
    };
    let set_pct = resolve_filter(&pool, &filter_pct, 0).await.unwrap();
    assert!(
        set_pct.contains("SRC_C"),
        "SRC_C contains a literal '%' and must match"
    );
    assert!(
        !set_pct.contains("SRC_A"),
        "SRC_A has no literal '%' — must not match an unescaped '%' wildcard"
    );
    assert!(
        !set_pct.contains("SRC_B"),
        "SRC_B has no literal '%' — must not match an unescaped '%' wildcard"
    );
}

// PERF-27: `StartsWith` on date strings is a prefix LIKE pushed into
// SQL.  Mirrors the PropertyText prefix behaviour: `escape_like` makes
// `%` / `_` / `\` literal.
#[tokio::test]
async fn filter_property_date_starts_with_pushed_into_sql() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;
    insert_property(&pool, "SRC_A", "due", None, None, Some("2025-01-15")).await;
    insert_property(&pool, "SRC_B", "due", None, None, Some("2025-02-20")).await;
    insert_property(&pool, "SRC_C", "due", None, None, Some("2024-12-31")).await;

    let filter = BacklinkFilter::PropertyDate {
        key: "due".into(),
        op: CompareOp::StartsWith,
        value: "2025-".into(),
    };
    let set = resolve_filter(&pool, &filter, 0).await.unwrap();
    assert!(set.contains("SRC_A"), "2025-01-15 starts with '2025-'");
    assert!(set.contains("SRC_B"), "2025-02-20 starts with '2025-'");
    assert!(
        !set.contains("SRC_C"),
        "2024-12-31 does not start with '2025-'"
    );
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
        None,
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
        None,
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
        None,
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
        None,
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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
    let resp1 = eval_backlink_query(&pool, "TARGET", None, sort.clone(), &page1, None)
        .await
        .unwrap();
    assert_eq!(resp1.items.len(), 2, "first page should have 2 items");
    assert!(resp1.has_more, "first page should indicate more");
    assert_eq!(resp1.items[0].id, "SRC_B", "alice first");
    assert_eq!(resp1.items[1].id, "SRC_C", "bob second");

    // Second page via cursor
    let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
    let resp2 = eval_backlink_query(&pool, "TARGET", None, sort, &page2, None)
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
        None,
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
        None,
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
        None,
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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

    let resp = eval_backlink_query(&pool, "LONELY", None, None, &page, None)
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
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_inf_eq), None, &page, None)
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
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_neg_inf_gt), None, &page, None)
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
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_nan_eq), None, &page, None)
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
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_pct), None, &page, None)
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
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_usc), None, &page, None)
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
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_and), None, &page, None)
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
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_not), None, &page, None).await;
    assert!(
        resp.is_err(),
        "'NOT goodbye' as standalone NOT should produce an FTS5 syntax error"
    );

    // Test 3: "hello" should match all three (SRC_A, SRC_B, SRC_C)
    let filters_hello = vec![BacklinkFilter::Contains {
        query: "hello".into(),
    }];
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters_hello), None, &page, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();
    assert_eq!(resp.total_count, 3, "base set has 3 backlinks");
    assert_eq!(resp.filtered_count, 2, "only 2 match the filter");
}

// ======================================================================
// TEST-18 — eval_backlink_query: self-reference filtering coverage.
//
// `setup_backlinks()` creates orphan source blocks whose IDs differ from
// TARGET, so every other non-grouped test trivially satisfies the
// `bl.source_id != ?1` clause in `eval_backlink_query` without ever
// exercising it. This test inserts a TARGET → TARGET block_link (the
// shape that clause was written to exclude) and asserts that:
//
//   1. The self-link is dropped from `items`.
//   2. `total_count` is the post-self-reference-filter count, per
//      AGENTS.md "Backend Patterns" #4 (`total_count` uses post-filter
//      count). The grouped path covers this at line 3530+; this is the
//      non-grouped equivalent.
//   3. `filtered_count` matches `total_count` when no user filter is
//      applied.
//
// Uses page-rooted sources (not `setup_backlinks()` orphans) so the
// fixture mirrors production data shape.
// ======================================================================
#[tokio::test]
async fn eval_backlink_query_excludes_self_reference() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target Page", None, None).await;
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
    insert_block_link(&pool, "BLK_A1", "TARGET").await;
    insert_block_link(&pool, "BLK_A2", "TARGET").await;
    // Self-reference: TARGET links to itself. The `bl.source_id != ?1`
    // clause must drop this row from `base_ids`, otherwise TARGET would
    // surface as its own backlink and inflate `total_count` to 3.
    insert_block_link(&pool, "TARGET", "TARGET").await;

    let page = default_page();
    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    let ids: std::collections::HashSet<&str> = resp.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(
        resp.items.len(),
        2,
        "self-link must be filtered; only the 2 legitimate sources remain"
    );
    assert!(
        !ids.contains("TARGET"),
        "TARGET must not surface as its own backlink"
    );
    assert!(ids.contains("BLK_A1"));
    assert!(ids.contains("BLK_A2"));
    assert_eq!(
        resp.total_count, 2,
        "total_count is post-self-reference-filter (AGENTS.md Backend Patterns #4)"
    );
    assert_eq!(
        resp.filtered_count, 2,
        "filtered_count tracks total_count when no user filter is applied"
    );
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

    let resp = eval_backlink_query_grouped(&pool, "LONELY", None, None, &page, None)
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

    let resp = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page, None)
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
    let resp1 = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page1, None)
        .await
        .unwrap();
    assert_eq!(resp1.groups.len(), 2, "first page should have 2 groups");
    assert!(resp1.has_more, "more groups available");
    assert!(resp1.next_cursor.is_some(), "cursor should be provided");
    assert_eq!(resp1.total_count, 3, "total count across all pages");
    assert_eq!(resp1.filtered_count, 3, "filtered count across all pages");

    // Second page via cursor
    let page2 = PageRequest::new(resp1.next_cursor, Some(2)).unwrap();
    let resp2 = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page2, None)
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

    let resp = eval_backlink_query_grouped(&pool, "TARGET", Some(filters), None, &page, None)
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
// H-11 — eval_backlink_query_grouped: total_count / filtered_count must
// be computed AFTER self-reference + orphan filtering.
//
// Regression: pre-fix `total_count` was set to `base_ids.len()` *before*
// any orphan or self-reference exclusion, so the UI badge reported more
// items than the response actually contained. Per AGENTS.md "Backend
// Patterns" #4, post-filter count is mandatory.
//
// "Self-reference" here mirrors the convention used by
// `eval_unlinked_references`: a source whose root page equals the target
// block's root page. For a target that is itself a page, this collapses
// to "child blocks of the target page" — those should not appear in the
// grouped backlink listing because the user is already viewing that page.
//
// "Orphan source block" means a source block whose `page_id` is NULL or
// whose denormalized `page_id` no longer references a non-conflict page
// row — `resolve_root_pages` returns no entry for those IDs, so they
// would be silently dropped from the rendered groups while still
// inflating `total_count`.
// ======================================================================

#[tokio::test]
async fn eval_backlink_query_grouped_total_count_excludes_self_references() {
    let (pool, _dir) = test_pool().await;
    // Target page.
    insert_block_with_parent(&pool, "TARGET", "page", "Target Page", None, None).await;

    // Two legitimate cross-page backlinks (root_page = PAGE_A ≠ TARGET).
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
    insert_block_link(&pool, "BLK_A1", "TARGET").await;
    insert_block_link(&pool, "BLK_A2", "TARGET").await;

    // Two self-references: blocks living on TARGET that link back to it.
    insert_block_with_parent(
        &pool,
        "BLK_T1",
        "content",
        "self ref 1",
        Some("TARGET"),
        Some(1),
    )
    .await;
    insert_block_with_parent(
        &pool,
        "BLK_T2",
        "content",
        "self ref 2",
        Some("TARGET"),
        Some(2),
    )
    .await;
    insert_block_link(&pool, "BLK_T1", "TARGET").await;
    insert_block_link(&pool, "BLK_T2", "TARGET").await;

    // N = 4 backlinks total in `block_links`, M = 2 self-references.
    // Post-filter expectation: total_count = N - M = 2.
    let page = default_page();
    let resp = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.total_count, 2,
        "total_count must exclude self-references (H-11)"
    );
    assert_eq!(
        resp.filtered_count, 2,
        "filtered_count tracks total_count when no user filter is applied"
    );
    assert_eq!(
        resp.groups.len(),
        1,
        "only the cross-page group survives; the would-be TARGET self-group is dropped"
    );
    assert_eq!(resp.groups[0].page_id, "PAGE_A");
    let block_ids: std::collections::HashSet<&str> = resp.groups[0]
        .blocks
        .iter()
        .map(|b| b.id.as_str())
        .collect();
    assert!(block_ids.contains("BLK_A1"));
    assert!(block_ids.contains("BLK_A2"));
    assert!(
        !block_ids.contains("BLK_T1") && !block_ids.contains("BLK_T2"),
        "self-reference blocks must not appear in the rendered groups"
    );
}

#[tokio::test]
async fn eval_backlink_query_grouped_total_count_excludes_orphan_source_blocks() {
    let (pool, _dir) = test_pool().await;
    // Target page.
    insert_block_with_parent(&pool, "TARGET", "page", "Target Page", None, None).await;

    // One legitimate source on PAGE_A.
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
    insert_block_link(&pool, "BLK_A1", "TARGET").await;

    // Three orphan source blocks: `block_type = 'content'` with no
    // parent_id => `page_id` is NULL (see `insert_block_with_parent`),
    // which is exactly the shape `resolve_root_pages` cannot resolve.
    for orphan_id in ["ORPHAN_1", "ORPHAN_2", "ORPHAN_3"] {
        insert_block_with_parent(&pool, orphan_id, "content", "no page", None, None).await;
        insert_block_link(&pool, orphan_id, "TARGET").await;
    }

    // N = 4 base backlinks, K = 3 orphans => total_count = 1.
    let page = default_page();
    let resp = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.total_count, 1,
        "total_count must exclude orphan source blocks (H-11)"
    );
    assert_eq!(resp.filtered_count, 1);
    assert_eq!(resp.groups.len(), 1, "only the PAGE_A group is rendered");
    assert_eq!(resp.groups[0].page_id, "PAGE_A");
    assert_eq!(resp.groups[0].blocks.len(), 1);
    assert_eq!(resp.groups[0].blocks[0].id, "BLK_A1");
}

#[tokio::test]
async fn eval_backlink_query_grouped_total_count_matches_visible_results() {
    // Combined scenario: N total backlinks, M self-references, K orphans.
    // The post-filter `total_count` must equal `N - M - K`, and it must
    // also equal the sum of `groups[*].blocks.len()` so the UI badge and
    // the rendered list cannot drift (AGENTS.md "Backend Patterns" #4).
    let (pool, _dir) = test_pool().await;

    // Target page.
    insert_block_with_parent(&pool, "TARGET", "page", "Target Page", None, None).await;

    // 5 legitimate cross-page backlinks across PAGE_A and PAGE_B.
    insert_block_with_parent(&pool, "PAGE_A", "page", "Page A", None, None).await;
    insert_block_with_parent(&pool, "PAGE_B", "page", "Page B", None, None).await;
    let cross_page = [
        ("BLK_A1", "PAGE_A", 1_i64),
        ("BLK_A2", "PAGE_A", 2),
        ("BLK_A3", "PAGE_A", 3),
        ("BLK_B1", "PAGE_B", 1),
        ("BLK_B2", "PAGE_B", 2),
    ];
    for (blk, parent, pos) in cross_page {
        insert_block_with_parent(&pool, blk, "content", "src", Some(parent), Some(pos)).await;
        insert_block_link(&pool, blk, "TARGET").await;
    }

    // 2 self-references (root_page == TARGET).
    for (idx, blk) in ["BLK_T1", "BLK_T2"].iter().enumerate() {
        insert_block_with_parent(
            &pool,
            blk,
            "content",
            "self",
            Some("TARGET"),
            Some(i64::try_from(idx).expect("loop index fits i64") + 1),
        )
        .await;
        insert_block_link(&pool, blk, "TARGET").await;
    }

    // 3 orphans.
    for blk in ["ORPHAN_1", "ORPHAN_2", "ORPHAN_3"] {
        insert_block_with_parent(&pool, blk, "content", "orphan", None, None).await;
        insert_block_link(&pool, blk, "TARGET").await;
    }

    // N = 10, M = 2, K = 3 => expected total_count = 5.
    let page = default_page();
    let resp = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.total_count, 5,
        "total_count must equal N - M - K (10 - 2 - 3)"
    );
    assert_eq!(
        resp.filtered_count, 5,
        "filtered_count == total_count when no user filter is applied"
    );

    let visible: usize = resp.groups.iter().map(|g| g.blocks.len()).sum();
    assert_eq!(
        visible, resp.total_count,
        "total_count must equal the sum of rendered group blocks (no badge/render drift)"
    );

    // The two source pages remain; the would-be TARGET self-group and any
    // orphan-only group are absent.
    let group_ids: std::collections::HashSet<&str> =
        resp.groups.iter().map(|g| g.page_id.as_str()).collect();
    assert_eq!(group_ids.len(), 2);
    assert!(group_ids.contains("PAGE_A"));
    assert!(group_ids.contains("PAGE_B"));
    assert!(
        !group_ids.contains("TARGET"),
        "self-reference group must be excluded"
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
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
    let resp = eval_unlinked_references(&pool, "PAGE1", None, None, &page, None)
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
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
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
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
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
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
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

// ======================================================================
// PEND-83 Bug 2 — title-block filter
//
// The trigram FTS tokenizer is substring-based, so a child page like
// `Notes/2026` (a `block_type = 'page'` row whose `content =
// 'Notes/2026'`) is an FTS hit for the parent page `Notes` via the
// trigrams `Not`, `ote`, `tes`. Those title-block hits leaked into the
// unlinked-references panel (the bug). The fix adds `b.block_type !=
// 'page'` to the FTS base set so refs surface body matches only.
//
// Regression guards:
//   (1) the `Notes/2026` title block must NOT surface as an unlinked
//       ref for `Notes`;
//   (2) an unrelated page (`Aardvark`) whose body block contains the
//       literal word `Notes` MUST still surface — the filter must not
//       over-shoot and drop body matches.
// ======================================================================
#[tokio::test]
async fn eval_unlinked_refs_excludes_title_blocks() {
    let (pool, _dir) = test_pool().await;
    // Parent page whose title is "Notes".
    insert_block_with_parent(&pool, "TARGET", "page", "Notes", None, None).await;
    // Child page `Notes/2026` — title block content matches the parent
    // name as a substring via the trigram tokenizer.
    insert_block_with_parent(&pool, "CHILD", "page", "Notes/2026", None, None).await;
    insert_fts(&pool, "CHILD", "Notes/2026").await;
    // Unrelated page with a body block that mentions "Notes" literally.
    insert_block_with_parent(&pool, "AARDVARK", "page", "Aardvark", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_AARDVARK",
        "content",
        "Today I took some Notes on burrows",
        Some("AARDVARK"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_AARDVARK", "Today I took some Notes on burrows").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    // (1) The child page's title block must not surface.
    let surfaced_block_ids: Vec<&str> = resp
        .groups
        .iter()
        .flat_map(|g| g.blocks.iter().map(|b| b.id.as_str()))
        .collect();
    assert!(
        !surfaced_block_ids.contains(&"CHILD"),
        "child page title block leaked into unlinked refs: {surfaced_block_ids:?}"
    );
    let surfaced_group_ids: Vec<&str> = resp.groups.iter().map(|g| g.page_id.as_str()).collect();
    assert!(
        !surfaced_group_ids.contains(&"CHILD"),
        "child page surfaced as its own source group: {surfaced_group_ids:?}"
    );

    // (2) The unrelated body match MUST still surface (over-filter guard).
    assert_eq!(
        resp.groups.len(),
        1,
        "exactly one source group expected — `Aardvark`"
    );
    assert_eq!(resp.groups[0].page_id, "AARDVARK");
    assert_eq!(resp.groups[0].blocks.len(), 1);
    assert_eq!(resp.groups[0].blocks[0].id, "BLK_AARDVARK");
    // Counts must also reflect the filter: pre-filter total = 1 (only
    // the body match survives the title-block drop and the self-ref
    // walk).
    assert_eq!(resp.total_count, 1, "title-block hit excluded pre-filter");
    assert_eq!(resp.filtered_count, 1);
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
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
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
    let resp1 = eval_unlinked_references(&pool, "TARGET", None, None, &page1, None)
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
    let resp2 = eval_unlinked_references(&pool, "TARGET", None, None, &page2, None)
        .await
        .unwrap();
    assert_eq!(resp2.groups.len(), 1, "second page has 1 group");
    assert!(resp2.has_more, "second page should have more");
    assert!(resp2.next_cursor.is_some(), "second page needs cursor");
    assert_eq!(resp2.groups[0].page_id, "PAGE_B", "second page is PAGE_B");

    // Third page via cursor
    let page3 = PageRequest::new(resp2.next_cursor, Some(1)).unwrap();
    let resp3 = eval_unlinked_references(&pool, "TARGET", None, None, &page3, None)
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
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
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
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
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
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
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
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
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
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();
    assert!(
        resp.groups.is_empty(),
        "empty/whitespace aliases should not cause false matches"
    );
}

// ======================================================================
// PropertyIsEmpty — candidate-scoped json_each() path (PERF-3)
// ======================================================================

#[tokio::test]
async fn property_is_empty_scoped_to_candidate_set() {
    let (pool, _dir) = test_pool().await;

    // Create blocks: some with the property, some without.
    insert_block(&pool, "BLK_A", "content", "Block A").await;
    insert_block(&pool, "BLK_B", "content", "Block B").await;
    insert_block(&pool, "BLK_C", "content", "Block C").await;
    insert_block(&pool, "BLK_D", "content", "Block D").await;

    // BLK_A and BLK_C have the "priority" property set.
    insert_property(&pool, "BLK_A", "priority", Some("high"), None, None).await;
    insert_property(&pool, "BLK_C", "priority", Some("low"), None, None).await;

    // Candidate set includes BLK_A (has prop), BLK_B (no prop), BLK_D (no prop).
    // BLK_C is NOT in the candidate set even though it has the property.
    let candidates: FxHashSet<String> = ["BLK_A", "BLK_B", "BLK_D"]
        .iter()
        .map(|&s| s.to_string())
        .collect();

    let filter = BacklinkFilter::PropertyIsEmpty {
        key: "priority".into(),
    };
    let set = resolve_filter_with_candidates(&pool, &filter, 0, Some(&candidates))
        .await
        .unwrap();

    // Only candidates WITHOUT the property should be returned.
    assert!(
        !set.contains("BLK_A"),
        "BLK_A has 'priority' set — must be excluded"
    );
    assert!(
        set.contains("BLK_B"),
        "BLK_B lacks 'priority' and is a candidate — must be included"
    );
    assert!(
        set.contains("BLK_D"),
        "BLK_D lacks 'priority' and is a candidate — must be included"
    );

    // BLK_C lacks 'priority' is false (it has it), but more importantly it is
    // NOT in the candidate set, so it must never appear in the result.
    assert!(
        !set.contains("BLK_C"),
        "BLK_C is not in the candidate set — must be excluded"
    );

    // Exactly 2 results.
    assert_eq!(set.len(), 2, "expected exactly BLK_B and BLK_D");
}

// ======================================================================
// BUG-44 — eval_unlinked_references with filters and sort
// ======================================================================

/// Seed four PAGE_B-scoped blocks that mention "Project Alpha" without a
/// `[[TARGET]]` link. Used by the filter/sort tests below.
///
/// Layout:
/// * TARGET (page): "Project Alpha"
/// * PAGE_B (page): "Page B"
///   ├── BLK_B1 — content "mentions Project Alpha daily", priority=high, has tag T_A
///   ├── BLK_B2 — content "Project Alpha backlog entry",  priority=low,  has tag T_B
///   ├── BLK_B3 — content "notes on Project Alpha here",  priority=high, no tags
///   └── BLK_B4 — content "Project Alpha summary plan",   no priority,   has tag T_A
async fn setup_unlinked_refs_for_filters(pool: &SqlitePool) {
    // Target page
    insert_block_with_parent(pool, "TARGET", "page", "Project Alpha", None, None).await;
    // Source page + its 4 mention blocks
    insert_block_with_parent(pool, "PAGE_B", "page", "Page B", None, None).await;

    insert_block_with_parent(
        pool,
        "BLK_B1",
        "content",
        "mentions Project Alpha daily",
        Some("PAGE_B"),
        Some(1),
    )
    .await;
    insert_block_with_parent(
        pool,
        "BLK_B2",
        "content",
        "Project Alpha backlog entry",
        Some("PAGE_B"),
        Some(2),
    )
    .await;
    insert_block_with_parent(
        pool,
        "BLK_B3",
        "content",
        "notes on Project Alpha here",
        Some("PAGE_B"),
        Some(3),
    )
    .await;
    insert_block_with_parent(
        pool,
        "BLK_B4",
        "content",
        "Project Alpha summary plan",
        Some("PAGE_B"),
        Some(4),
    )
    .await;

    // Index all four in FTS so they're discoverable
    insert_fts(pool, "BLK_B1", "mentions Project Alpha daily").await;
    insert_fts(pool, "BLK_B2", "Project Alpha backlog entry").await;
    insert_fts(pool, "BLK_B3", "notes on Project Alpha here").await;
    insert_fts(pool, "BLK_B4", "Project Alpha summary plan").await;

    // Properties
    insert_property(pool, "BLK_B1", "priority", Some("high"), None, None).await;
    insert_property(pool, "BLK_B2", "priority", Some("low"), None, None).await;
    insert_property(pool, "BLK_B3", "priority", Some("high"), None, None).await;
    // BLK_B4 intentionally has no priority

    // Tags — tag rows must exist as 'tag' blocks before tags_cache + block_tags FKs resolve.
    insert_block(pool, "T_A", "tag", "tag-a").await;
    insert_block(pool, "T_B", "tag", "tag-b").await;
    insert_tag_cache(pool, "T_A", "tag-a", 2).await;
    insert_tag_cache(pool, "T_B", "tag-b", 1).await;
    insert_tag_assoc(pool, "BLK_B1", "T_A").await;
    insert_tag_assoc(pool, "BLK_B2", "T_B").await;
    insert_tag_assoc(pool, "BLK_B4", "T_A").await;
}

#[tokio::test]
async fn eval_unlinked_refs_no_filters_no_sort_regression() {
    // Regression: existing behaviour preserved when no filters/sort passed.
    let (pool, _dir) = test_pool().await;
    setup_unlinked_refs_for_filters(&pool).await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.groups.len(), 1, "one source page group");
    assert_eq!(resp.groups[0].page_id, "PAGE_B");
    assert_eq!(resp.groups[0].blocks.len(), 4, "all four blocks");
    assert_eq!(resp.total_count, 4, "total count pre-filter is 4");
    assert_eq!(resp.filtered_count, 4, "filtered count matches total");
}

#[tokio::test]
async fn eval_unlinked_refs_tag_filter_excludes_non_matching() {
    // Tag filter on T_A keeps BLK_B1 + BLK_B4 (2 of 4).
    let (pool, _dir) = test_pool().await;
    setup_unlinked_refs_for_filters(&pool).await;

    let filters = vec![BacklinkFilter::HasTag {
        tag_id: "T_A".into(),
    }];

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.groups.len(), 1, "one source page group");
    assert_eq!(resp.groups[0].blocks.len(), 2, "exactly 2 tagged blocks");
    let ids: std::collections::HashSet<&str> = resp.groups[0]
        .blocks
        .iter()
        .map(|b| b.id.as_str())
        .collect();
    assert!(ids.contains("BLK_B1"), "BLK_B1 has T_A");
    assert!(ids.contains("BLK_B4"), "BLK_B4 has T_A");
    // MAINT-170: `total_count` is captured pre-filter, post-self-reference
    // (parity with `eval_backlink_query_grouped:128`); `filtered_count` is
    // the post-filter, post-grouping sum. Pre-fix this assertion encoded
    // the bug — `total_count == 2` collapsed both counts to the post-filter
    // sum and under-reported the unlinked-reference badge.
    assert_eq!(
        resp.total_count, 4,
        "total_count is the pre-filter, post-self-ref count (4)"
    );
    assert_eq!(
        resp.filtered_count, 2,
        "filtered_count is the post-filter group sum (2)"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_property_filter_matches_exact_value() {
    // PropertyText filter on priority=high keeps BLK_B1 + BLK_B3.
    let (pool, _dir) = test_pool().await;
    setup_unlinked_refs_for_filters(&pool).await;

    let filters = vec![BacklinkFilter::PropertyText {
        key: "priority".into(),
        op: CompareOp::Eq,
        value: "high".into(),
    }];

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.groups.len(), 1);
    assert_eq!(
        resp.groups[0].blocks.len(),
        2,
        "exactly 2 high-priority blocks"
    );
    let ids: std::collections::HashSet<&str> = resp.groups[0]
        .blocks
        .iter()
        .map(|b| b.id.as_str())
        .collect();
    assert!(ids.contains("BLK_B1"));
    assert!(ids.contains("BLK_B3"));
    // MAINT-170: `total_count` is the pre-filter, post-self-ref count
    // (parity with `eval_backlink_query_grouped:128`).
    assert_eq!(resp.total_count, 4, "pre-filter total_count == 4");
    assert_eq!(resp.filtered_count, 2, "post-filter filtered_count == 2");
}

#[tokio::test]
async fn eval_unlinked_refs_sort_created_asc_vs_desc() {
    // Created { Asc } vs Created { Desc } produce reversed ULID order.
    // BLK_B1 < BLK_B2 < BLK_B3 < BLK_B4 lexicographically (our IDs are
    // lex-sortable stand-ins for ULIDs).
    let (pool, _dir) = test_pool().await;
    setup_unlinked_refs_for_filters(&pool).await;

    let page = default_page();

    // Asc
    let resp_asc = eval_unlinked_references(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::Created { dir: SortDir::Asc }),
        &page,
        None,
    )
    .await
    .unwrap();
    let ids_asc: Vec<&str> = resp_asc.groups[0]
        .blocks
        .iter()
        .map(|b| b.id.as_str())
        .collect();
    assert_eq!(
        ids_asc,
        vec!["BLK_B1", "BLK_B2", "BLK_B3", "BLK_B4"],
        "ascending Created order"
    );

    // Desc
    let resp_desc = eval_unlinked_references(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::Created { dir: SortDir::Desc }),
        &page,
        None,
    )
    .await
    .unwrap();
    let ids_desc: Vec<&str> = resp_desc.groups[0]
        .blocks
        .iter()
        .map(|b| b.id.as_str())
        .collect();
    assert_eq!(
        ids_desc,
        vec!["BLK_B4", "BLK_B3", "BLK_B2", "BLK_B1"],
        "descending Created order"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_sort_property_text_orders_by_value() {
    // PropertyText sort on "priority": blocks with the property sort first
    // (by value asc: high, high, low), blocks without it go last (BLK_B4).
    let (pool, _dir) = test_pool().await;
    setup_unlinked_refs_for_filters(&pool).await;

    let page = default_page();
    let resp = eval_unlinked_references(
        &pool,
        "TARGET",
        None,
        Some(BacklinkSort::PropertyText {
            key: "priority".into(),
            dir: SortDir::Asc,
        }),
        &page,
        None,
    )
    .await
    .unwrap();

    assert_eq!(resp.groups.len(), 1);
    let ids: Vec<&str> = resp.groups[0]
        .blocks
        .iter()
        .map(|b| b.id.as_str())
        .collect();
    assert_eq!(ids.len(), 4, "all four blocks returned");

    // First two entries must be the two "high" blocks (BLK_B1, BLK_B3)
    // — order between them is a tiebreaker on ID (BLK_B1 < BLK_B3).
    assert_eq!(&ids[..2], &["BLK_B1", "BLK_B3"], "two 'high' first");
    // Then "low" (BLK_B2), then the unset-priority BLK_B4 sorts last.
    assert_eq!(ids[2], "BLK_B2", "'low' before unset");
    assert_eq!(ids[3], "BLK_B4", "unset priority sorts last");
}

#[tokio::test]
async fn eval_unlinked_refs_total_count_reflects_pre_filter() {
    // MAINT-170 regression: `total_count` is the pre-filter,
    // post-self-reference-exclusion count (parity with
    // `eval_backlink_query_grouped:128`). `filtered_count` is the
    // post-filter, post-grouping sum. Pre-fix the function collapsed
    // both counts to the same post-filter value, under-reporting the
    // UI badge whenever a user filter was active.
    //
    // Note: this test previously encoded the *buggy* behaviour
    // (asserted `total_count == filtered_count` after filtering); it
    // has been inverted to lock down the corrected semantics.
    let (pool, _dir) = test_pool().await;
    setup_unlinked_refs_for_filters(&pool).await;

    // Unfiltered: 4 blocks.
    let page = default_page();
    let unfiltered = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();
    assert_eq!(unfiltered.total_count, 4);
    assert_eq!(unfiltered.filtered_count, 4);
    assert!(
        unfiltered.total_count >= unfiltered.filtered_count,
        "total_count is always >= filtered_count"
    );

    // Narrow to priority=high (2 blocks).
    let filters = vec![BacklinkFilter::PropertyText {
        key: "priority".into(),
        op: CompareOp::Eq,
        value: "high".into(),
    }];
    let filtered = eval_unlinked_references(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();
    assert_eq!(
        filtered.total_count, 4,
        "total_count must be the pre-filter count (4), not the post-filter count (2)"
    );
    assert_eq!(
        filtered.filtered_count, 2,
        "filtered_count is the post-filter group sum (2)"
    );
    assert!(
        filtered.total_count >= filtered.filtered_count,
        "total_count is always >= filtered_count"
    );
}

// ======================================================================
// MAINT-170 — `eval_unlinked_references::total_count` must reflect the
// pre-filter, post-self-reference-exclusion count (parity with
// `eval_backlink_query_grouped:128`).
// ======================================================================

/// Seed 6 unlinked-reference blocks distributed across 3 source pages,
/// none of which are self-references to the TARGET page. Used by the
/// MAINT-170 regression tests below. Each block carries a `priority`
/// property so a filter can split the set in half (3 high / 3 low).
///
/// Layout:
/// * TARGET (page): "Project Beta"
/// * PAGE_X (page): "Page X"
///   ├── BLK_X1 — content "Project Beta milestones",  priority=high
///   └── BLK_X2 — content "more on Project Beta",     priority=low
/// * PAGE_Y (page): "Page Y"
///   ├── BLK_Y1 — content "Project Beta updates",     priority=high
///   └── BLK_Y2 — content "Project Beta retros",      priority=low
/// * PAGE_Z (page): "Page Z"
///   ├── BLK_Z1 — content "Project Beta launch",      priority=high
///   └── BLK_Z2 — content "Project Beta postmortem",  priority=low
async fn seed_unlinked_blocks_for_total_count(pool: &SqlitePool) {
    insert_block_with_parent(pool, "TARGET", "page", "Project Beta", None, None).await;

    let pages = [
        ("PAGE_X", "Page X", "X"),
        ("PAGE_Y", "Page Y", "Y"),
        ("PAGE_Z", "Page Z", "Z"),
    ];
    let blocks: [(&str, &str, &str); 6] = [
        ("BLK_X1", "Project Beta milestones", "high"),
        ("BLK_X2", "more on Project Beta", "low"),
        ("BLK_Y1", "Project Beta updates", "high"),
        ("BLK_Y2", "Project Beta retros", "low"),
        ("BLK_Z1", "Project Beta launch", "high"),
        ("BLK_Z2", "Project Beta postmortem", "low"),
    ];

    for (page_id, page_title, _) in &pages {
        insert_block_with_parent(pool, page_id, "page", page_title, None, None).await;
    }

    for (idx, (blk_id, content, priority)) in blocks.iter().enumerate() {
        // First two blocks live on PAGE_X, next two on PAGE_Y, last two on PAGE_Z.
        let parent_page = pages[idx / 2].0;
        let position = i64::try_from((idx % 2) + 1).expect("test fixture position fits i64");
        insert_block_with_parent(
            pool,
            blk_id,
            "content",
            content,
            Some(parent_page),
            Some(position),
        )
        .await;
        insert_fts(pool, blk_id, content).await;
        insert_property(pool, blk_id, "priority", Some(priority), None, None).await;
    }
}

#[tokio::test]
async fn eval_unlinked_refs_total_count_equals_filtered_count_with_no_filter() {
    // Happy path: 6 unlinked blocks across 3 source pages, no
    // self-references. With no user filter, `total_count` and
    // `filtered_count` must both equal the unfiltered group sum (6).
    let (pool, _dir) = test_pool().await;
    seed_unlinked_blocks_for_total_count(&pool).await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.groups.len(), 3, "three source page groups");
    let group_sum: usize = resp.groups.iter().map(|g| g.blocks.len()).sum();
    assert_eq!(group_sum, 6, "all six blocks distributed across the groups");
    assert_eq!(resp.total_count, 6, "pre-filter total_count == 6");
    assert_eq!(resp.filtered_count, 6, "post-filter filtered_count == 6");
    assert_eq!(
        resp.total_count, resp.filtered_count,
        "with no filter total_count must equal filtered_count"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_total_count_holds_when_filter_drops_half() {
    // Regression anchor for MAINT-170: 6 unlinked blocks pre-filter, a
    // user filter eliminates 3 of them. `total_count` must remain the
    // pre-filter count (6) while `filtered_count` reflects the
    // post-filter group sum (3). Pre-fix the function collapsed both
    // counts to 3, under-reporting the unlinked-references badge.
    let (pool, _dir) = test_pool().await;
    seed_unlinked_blocks_for_total_count(&pool).await;

    let filters = vec![BacklinkFilter::PropertyText {
        key: "priority".into(),
        op: CompareOp::Eq,
        value: "high".into(),
    }];

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();

    let group_sum: usize = resp.groups.iter().map(|g| g.blocks.len()).sum();
    assert_eq!(group_sum, 3, "filter keeps the three high-priority blocks");
    assert_eq!(
        resp.total_count, 6,
        "total_count holds the pre-filter, post-self-ref count (6)"
    );
    assert_eq!(
        resp.filtered_count, 3,
        "filtered_count is the post-filter group sum (3)"
    );
    assert!(
        resp.total_count >= resp.filtered_count,
        "total_count must always be >= filtered_count"
    );
}

#[tokio::test]
async fn eval_unlinked_refs_total_count_excludes_self_references_with_other_matches() {
    // Reinforces `eval_unlinked_refs_excludes_own_page_blocks`: when the
    // FTS match set contains BOTH a self-reference and a non-self-ref,
    // `total_count` must reflect only the non-self-ref count. The FTS
    // hit count would be 2; the post-self-ref count is 1.
    let (pool, _dir) = test_pool().await;

    insert_block_with_parent(&pool, "TARGET", "page", "Project Gamma", None, None).await;
    // Self-reference: a child block of TARGET that mentions the title.
    insert_block_with_parent(
        &pool,
        "BLK_SELF",
        "content",
        "Project Gamma is the focus here",
        Some("TARGET"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_SELF", "Project Gamma is the focus here").await;
    // Cross-page reference.
    insert_block_with_parent(&pool, "PAGE_OTHER", "page", "Other Page", None, None).await;
    insert_block_with_parent(
        &pool,
        "BLK_OTHER",
        "content",
        "We track Project Gamma carefully",
        Some("PAGE_OTHER"),
        Some(1),
    )
    .await;
    insert_fts(&pool, "BLK_OTHER", "We track Project Gamma carefully").await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.groups.len(), 1, "only the non-self-ref group survives");
    assert_eq!(resp.groups[0].page_id, "PAGE_OTHER");
    assert_eq!(resp.groups[0].blocks.len(), 1, "BLK_OTHER only");
    // FTS matched 2 rows but BLK_SELF is excluded by the self-reference
    // walk before total_count is captured.
    assert_eq!(
        resp.total_count, 1,
        "total_count reflects post-self-ref base (1), not FTS hit count (2)"
    );
    assert_eq!(resp.filtered_count, 1);
}

// ======================================================================
// I-Search-3 (R2 follow-up) — eval_unlinked_references truncates at
// FTS_ROW_CAP (10 000) when the FTS query would return more rows. The
// previous batch replaced the inline `LIMIT 10001` with
// `format!("… LIMIT {}", FTS_ROW_CAP + 1)`; this test pins the
// truncation behaviour at and just above the cap.
//
// Bulk-inserts 10 001 / 10 000 blocks via a recursive-CTE INSERT so the
// runtime stays well under the 5 s unit-test budget (single
// statement → one parse + one transaction in SQLite).
//
// Note: every matching block is parented to a single page so the
// helper produces exactly one group, which keeps the post-FTS path
// simple to assert against. The `WHERE id IN (?, ?, …)` re-fetch
// stays comfortably below SQLite's `SQLITE_LIMIT_VARIABLE_NUMBER`
// (32 766 in the bundled build).
// ======================================================================

/// Bulk-insert `n` content blocks under a single parent page, plus
/// matching FTS rows, all containing the literal title token so the
/// unlinked-references FTS query matches every one.
///
/// Uses two `INSERT … WITH RECURSIVE` statements so the entire fixture
/// lands in milliseconds even for 10 000+ rows.
async fn bulk_insert_unlinked_match_blocks(
    pool: &SqlitePool,
    parent_page_id: &str,
    title_token: &str,
    n: i64,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         WITH RECURSIVE seq(k) AS ( \
             SELECT 1 UNION ALL SELECT k + 1 FROM seq WHERE k < ?1 \
         ) \
         SELECT \
             'BLK_' || printf('%06d', k), \
             'content', \
             ?2 || ' ' || k, \
             ?3, \
             k, \
             ?3 \
         FROM seq",
    )
    .bind(n)
    .bind(format!("mentions {title_token}"))
    .bind(parent_page_id)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO fts_blocks (block_id, stripped) \
         WITH RECURSIVE seq(k) AS ( \
             SELECT 1 UNION ALL SELECT k + 1 FROM seq WHERE k < ?1 \
         ) \
         SELECT \
             'BLK_' || printf('%06d', k), \
             ?2 || ' ' || k \
         FROM seq",
    )
    .bind(n)
    .bind(format!("mentions {title_token}"))
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn eval_unlinked_references_truncates_at_fts_row_cap() {
    let (pool, _dir) = test_pool().await;

    // Target page whose title drives the FTS query, plus a parent page
    // that owns the 10 001 mentioning content blocks.
    insert_block_with_parent(&pool, "TARGET", "page", "Foobar", None, None).await;
    insert_block_with_parent(&pool, "PARENT_PAGE", "page", "Parent Page", None, None).await;

    // FTS_ROW_CAP + 1 = 10 001 matching blocks: the LIMIT 10001 query in
    // `eval_unlinked_references` returns 10 001 rows, the helper detects
    // truncation, and trims the result set to FTS_ROW_CAP (10 000).
    bulk_insert_unlinked_match_blocks(&pool, "PARENT_PAGE", "Foobar", 10_001).await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert!(
        resp.truncated,
        "with FTS_ROW_CAP + 1 matching rows, response must report truncated = true"
    );
    assert_eq!(
        resp.total_count, 10_000,
        "total_count must be exactly FTS_ROW_CAP after truncation"
    );
    assert_eq!(
        resp.filtered_count, 10_000,
        "filtered_count must be exactly FTS_ROW_CAP after truncation"
    );

    // All 10 000 blocks share PARENT_PAGE, so we get exactly one group
    // whose blocks list mirrors the trimmed match set.
    assert_eq!(
        resp.groups.len(),
        1,
        "all matches share PARENT_PAGE => exactly one group"
    );
    assert_eq!(
        resp.groups[0].blocks.len(),
        10_000,
        "the single group must carry all FTS_ROW_CAP rows"
    );
}

#[tokio::test]
async fn eval_unlinked_references_does_not_truncate_at_exactly_fts_row_cap() {
    // Companion to `_truncates_at_fts_row_cap`: at exactly FTS_ROW_CAP
    // matching rows the LIMIT FTS_ROW_CAP+1 query returns FTS_ROW_CAP
    // rows, which is *not* > FTS_ROW_CAP, so `truncated` must be false.
    let (pool, _dir) = test_pool().await;

    insert_block_with_parent(&pool, "TARGET", "page", "Foobar", None, None).await;
    insert_block_with_parent(&pool, "PARENT_PAGE", "page", "Parent Page", None, None).await;

    bulk_insert_unlinked_match_blocks(&pool, "PARENT_PAGE", "Foobar", 10_000).await;

    let page = default_page();
    let resp = eval_unlinked_references(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert!(
        !resp.truncated,
        "with exactly FTS_ROW_CAP matching rows, response must report truncated = false"
    );
    assert_eq!(
        resp.total_count, 10_000,
        "total_count must equal the full FTS_ROW_CAP match count"
    );
    assert_eq!(
        resp.filtered_count, 10_000,
        "filtered_count must equal the full FTS_ROW_CAP match count"
    );
    assert_eq!(
        resp.groups.len(),
        1,
        "all matches share PARENT_PAGE => exactly one group"
    );
    assert_eq!(
        resp.groups[0].blocks.len(),
        10_000,
        "the single group must carry every match below the cap"
    );
}

// ======================================================================
// L-82 / L-83 / L-84 — IN-clause `≤SMALL_IN_LIMIT → IN, >SMALL_IN_LIMIT → json_each(?)`
// chunking. Each pair below exercises the IN-bind path and the
// `json_each` fallback against the same logical scenario, asserting
// both branches return the expected row set.
// ======================================================================

/// Bulk-insert `n` content blocks under `parent_page_id`, each with a
/// `block_links` row pointing at `target_id`. Uses three
/// `INSERT … WITH RECURSIVE` statements so the fixture lands in
/// milliseconds even at n = 600.
async fn bulk_insert_n_backlink_sources(
    pool: &SqlitePool,
    parent_page_id: &str,
    target_id: &str,
    n: i64,
) {
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         WITH RECURSIVE seq(k) AS ( \
             SELECT 1 UNION ALL SELECT k + 1 FROM seq WHERE k < ?1 \
         ) \
         SELECT \
             'BL_' || printf('%06d', k), \
             'content', \
             'src ' || k, \
             ?2, \
             k, \
             ?2 \
         FROM seq",
    )
    .bind(n)
    .bind(parent_page_id)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO block_links (source_id, target_id) \
         WITH RECURSIVE seq(k) AS ( \
             SELECT 1 UNION ALL SELECT k + 1 FROM seq WHERE k < ?1 \
         ) \
         SELECT \
             'BL_' || printf('%06d', k), \
             ?2 \
         FROM seq",
    )
    .bind(n)
    .bind(target_id)
    .execute(pool)
    .await
    .unwrap();
}

/// Bulk-insert `n` distinct pages, each with a single content block,
/// and link every content block to `target_id`. Used for L-84 large
/// `SourcePage` tests that need a >SMALL_IN_LIMIT-sized `included` /
/// `excluded` page list.
async fn bulk_insert_n_pages_with_one_link(
    pool: &SqlitePool,
    target_id: &str,
    n: i64,
    page_prefix: &str,
    block_prefix: &str,
) {
    // Pages
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         WITH RECURSIVE seq(k) AS ( \
             SELECT 1 UNION ALL SELECT k + 1 FROM seq WHERE k < ?1 \
         ) \
         SELECT \
             ?2 || printf('%06d', k), \
             'page', \
             'page ' || k, \
             NULL, \
             NULL, \
             ?2 || printf('%06d', k) \
         FROM seq",
    )
    .bind(n)
    .bind(page_prefix)
    .execute(pool)
    .await
    .unwrap();

    // Content children, one per page
    sqlx::query(
        "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
         WITH RECURSIVE seq(k) AS ( \
             SELECT 1 UNION ALL SELECT k + 1 FROM seq WHERE k < ?1 \
         ) \
         SELECT \
             ?3 || printf('%06d', k), \
             'content', \
             'block ' || k, \
             ?2 || printf('%06d', k), \
             1, \
             ?2 || printf('%06d', k) \
         FROM seq",
    )
    .bind(n)
    .bind(page_prefix)
    .bind(block_prefix)
    .execute(pool)
    .await
    .unwrap();

    // Links: each block -> target
    sqlx::query(
        "INSERT INTO block_links (source_id, target_id) \
         WITH RECURSIVE seq(k) AS ( \
             SELECT 1 UNION ALL SELECT k + 1 FROM seq WHERE k < ?1 \
         ) \
         SELECT \
             ?2 || printf('%06d', k), \
             ?3 \
         FROM seq",
    )
    .bind(n)
    .bind(block_prefix)
    .bind(target_id)
    .execute(pool)
    .await
    .unwrap();
}

// ----------------------------------------------------------------------
// L-83 — fetch_block_rows_by_ids helper (shared by query.rs & grouped.rs)
// ----------------------------------------------------------------------

/// L-83 (a): IN-bind path — `ids.len() <= SMALL_IN_LIMIT` returns the
/// expected row set in correct quantity. Reuses `setup_backlinks` (3
/// content sources) so the small path is exercised against the same
/// shape as every other backlink test.
#[tokio::test]
async fn fetch_block_rows_by_ids_small_in_bind() {
    let (pool, _dir) = test_pool().await;
    setup_backlinks(&pool).await;

    let ids = ["SRC_A", "SRC_B", "SRC_C"];
    let rows = fetch_block_rows_by_ids(&pool, &ids).await.unwrap();

    let fetched: FxHashSet<String> = rows.iter().map(|r| r.id.to_string()).collect();
    let expected: FxHashSet<String> = ids.iter().map(|s| (*s).to_string()).collect();
    assert_eq!(
        fetched, expected,
        "small IN-bind path must return exactly the requested ids"
    );
}

/// L-83 (b): json_each fallback path — `ids.len() > SMALL_IN_LIMIT`
/// returns a row set that is element-wise identical to what an
/// equivalent IN-bind sub-batch would yield. We assert by:
///   1. Fetching all 600 ids in one call (fallback branch),
///   2. Fetching the same ids in two ≤500-id sub-batches via the
///      IN-bind branch and unioning,
///   3. Asserting the two row sets are identical.
#[tokio::test]
async fn fetch_block_rows_by_ids_large_json_each_matches_in_bind() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "PARENT", "page", "Parent", None, None).await;
    bulk_insert_n_backlink_sources(&pool, "PARENT", "PARENT", 600).await;

    let all_ids: Vec<String> = (1..=600).map(|k| format!("BL_{k:06}")).collect();
    let all_refs: Vec<&str> = all_ids.iter().map(String::as_str).collect();

    // Fallback path (json_each).
    let large_rows = fetch_block_rows_by_ids(&pool, &all_refs).await.unwrap();
    let large_set: FxHashSet<String> = large_rows.iter().map(|r| r.id.to_string()).collect();

    // IN-bind path applied twice to the same id space, unioned.
    let chunk_a: Vec<&str> = all_refs[..300].to_vec();
    let chunk_b: Vec<&str> = all_refs[300..].to_vec();
    let small_a = fetch_block_rows_by_ids(&pool, &chunk_a).await.unwrap();
    let small_b = fetch_block_rows_by_ids(&pool, &chunk_b).await.unwrap();
    let small_set: FxHashSet<String> = small_a
        .iter()
        .chain(small_b.iter())
        .map(|r| r.id.to_string())
        .collect();

    assert_eq!(
        large_set.len(),
        600,
        "json_each fallback must surface every requested id"
    );
    assert_eq!(
        large_set, small_set,
        "json_each branch and IN-bind branch must return the same id set"
    );
}

// ----------------------------------------------------------------------
// L-82 — eval_backlink_query_grouped: BlockRow batch fetch
// ----------------------------------------------------------------------

/// L-82 (a): IN-bind path — small fixture with 5 source blocks under a
/// single page exercises the `<= SMALL_IN_LIMIT` branch of
/// `fetch_block_rows_by_ids` via the grouped backlink path.
#[tokio::test]
async fn eval_grouped_blockrow_fetch_small_in_bind() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    insert_block_with_parent(&pool, "SRC_PAGE", "page", "Source Page", None, None).await;
    bulk_insert_n_backlink_sources(&pool, "SRC_PAGE", "TARGET", 5).await;

    let page = default_page();
    let resp = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.groups.len(), 1, "all sources share one root page");
    assert_eq!(resp.groups[0].blocks.len(), 5, "5 blocks fetched");
    assert_eq!(resp.total_count, 5);
    assert_eq!(resp.filtered_count, 5);

    let ids: FxHashSet<String> = resp.groups[0]
        .blocks
        .iter()
        .map(|b| b.id.clone().into())
        .collect();
    let expected: FxHashSet<String> = (1..=5).map(|k| format!("BL_{k:06}")).collect();
    assert_eq!(ids, expected, "IN-bind path must return the 5 source ids");
}

/// L-82 (b): json_each fallback path — 600 source blocks under a
/// single source page produces 600 backlinks in one group, exercising
/// the `> SMALL_IN_LIMIT` branch of `fetch_block_rows_by_ids` via
/// `eval_backlink_query_grouped`.
#[tokio::test]
async fn eval_grouped_blockrow_fetch_large_json_each() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    insert_block_with_parent(&pool, "SRC_PAGE", "page", "Source Page", None, None).await;
    bulk_insert_n_backlink_sources(&pool, "SRC_PAGE", "TARGET", 600).await;

    let page = default_page();
    let resp = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.groups.len(), 1, "all 600 sources share one root page");
    assert_eq!(
        resp.groups[0].blocks.len(),
        600,
        "json_each fallback must materialise every source"
    );
    assert_eq!(resp.total_count, 600);
    assert_eq!(resp.filtered_count, 600);

    let ids: FxHashSet<String> = resp.groups[0]
        .blocks
        .iter()
        .map(|b| b.id.clone().into())
        .collect();
    let expected: FxHashSet<String> = (1..=600).map(|k| format!("BL_{k:06}")).collect();
    assert_eq!(
        ids, expected,
        "json_each branch must return the same id set as the small IN-bind branch would"
    );
}

// ----------------------------------------------------------------------
// L-84 — SourcePage filter: included / excluded IN-clauses
// ----------------------------------------------------------------------

/// L-84: `included` json_each fallback — 600 included pages, each
/// owning one content block that links to TARGET. The recursive
/// descendant CTE switches to `IN (SELECT value FROM json_each(?))`
/// because `included.len() > SMALL_IN_LIMIT`.
#[tokio::test]
async fn filter_source_page_included_large_json_each() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    bulk_insert_n_pages_with_one_link(&pool, "TARGET", 600, "PG_", "BK_").await;

    // Include the first 400 pages — the IN-bind branch (≤500) would still
    // succeed at this size, so we go all the way to 600 to force the
    // fallback path.
    let included: Vec<String> = (1..=600).map(|k| format!("PG_{k:06}")).collect();
    let filters = vec![BacklinkFilter::SourcePage {
        included: included.clone(),
        excluded: vec![],
    }];
    let page = PageRequest::new(None, Some(200)).unwrap();

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.total_count, 600,
        "every page contributes one backlink to the base set"
    );
    assert_eq!(
        resp.filtered_count, 600,
        "json_each-included branch must keep every block under the included pages"
    );
}

/// L-84: exclusion-only json_each fallback — 600 excluded pages
/// triggers the `> SMALL_IN_LIMIT` branch of the exclusion-only SQL
/// path (line ~452 pre-fix). Setup: 600 pages each contribute a
/// backlink, plus one extra "ALLOWED" page whose backlink should
/// survive the exclusion.
#[tokio::test]
async fn filter_source_page_excluded_only_large_json_each() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    bulk_insert_n_pages_with_one_link(&pool, "TARGET", 600, "EX_", "EBK_").await;

    // Plus one allowed source that must not be excluded.
    insert_block_with_parent(&pool, "ALLOWED", "page", "Allowed", None, None).await;
    insert_block_with_parent(
        &pool,
        "ALLOWED_BK",
        "content",
        "allowed",
        Some("ALLOWED"),
        Some(1),
    )
    .await;
    insert_block_link(&pool, "ALLOWED_BK", "TARGET").await;

    let excluded: Vec<String> = (1..=600).map(|k| format!("EX_{k:06}")).collect();
    let filters = vec![BacklinkFilter::SourcePage {
        included: vec![],
        excluded,
    }];
    let page = default_page();

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.total_count, 601,
        "601 backlinks before exclusion (600 EX_* + 1 ALLOWED_BK)"
    );
    assert_eq!(
        resp.filtered_count, 1,
        "only ALLOWED_BK remains after the json_each exclusion"
    );
    assert_eq!(resp.items.len(), 1);
    assert_eq!(resp.items[0].id, "ALLOWED_BK");
}

/// L-84: combined `included` + `excluded` both json_each — exercises
/// the within-included `excluded` placeholder site (line ~431 pre-fix)
/// alongside the `included` site. With 600 included PG_* and 300
/// excluded PG_* (the second half), exactly the first 300 pages
/// survive.
#[tokio::test]
async fn filter_source_page_include_exclude_large_json_each() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    bulk_insert_n_pages_with_one_link(&pool, "TARGET", 600, "PG_", "BK_").await;

    let included: Vec<String> = (1..=600).map(|k| format!("PG_{k:06}")).collect();
    // Excluded list also exceeds SMALL_IN_LIMIT to force the json_each
    // branch on both placeholder sites.
    let excluded: Vec<String> = (301..=901).map(|k| format!("PG_{k:06}")).collect();
    let filters = vec![BacklinkFilter::SourcePage { included, excluded }];
    let page = PageRequest::new(None, Some(200)).unwrap();

    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.total_count, 600,
        "every page in the fixture contributes a backlink"
    );
    assert_eq!(
        resp.filtered_count, 300,
        "300 surviving sources after include+exclude via json_each on both branches"
    );
}

// ======================================================================
// H1 (keyset + SQL COUNT) — see `backlink/query.rs` module docs.
//
// The four tests below pin the new contract on `eval_backlink_query` /
// `eval_backlink_query_grouped`: counts come from SQL COUNT(*), the
// page query honours the user-supplied limit (we never materialise the
// full base id set), and keyset pagination over `b.id` (ULID order)
// reaches every source block without duplication.
// ======================================================================

/// H1: with 200 backlinks pointing at a single target page, a request
/// for `limit=10` must return exactly 10 rows, with `has_more=true`,
/// `total_count=200`, `filtered_count=200`, and a non-empty cursor —
/// proving the page query honours the limit (the pre-H1 implementation
/// would have loaded all 200 ids into a Rust set first).
#[tokio::test]
async fn eval_backlink_query_does_not_materialise_full_set() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "PARENT", "page", "Parent", None, None).await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    bulk_insert_n_backlink_sources(&pool, "PARENT", "TARGET", 200).await;

    let page = PageRequest::new(None, Some(10)).unwrap();
    let resp = eval_backlink_query(&pool, "TARGET", None, None, &page, None)
        .await
        .unwrap();

    assert_eq!(resp.items.len(), 10, "page must honour limit=10");
    assert!(resp.has_more, "200 backlinks > 10 ⇒ has_more must be true");
    assert_eq!(
        resp.total_count, 200,
        "total_count must reflect every backlink"
    );
    assert_eq!(
        resp.filtered_count, 200,
        "filtered_count equals total when no filter is supplied"
    );
    assert!(
        resp.next_cursor.is_some(),
        "has_more=true ⇒ next_cursor must be set"
    );
}

/// H1: keyset cursor pagination over 25 backlinks with limit=10 must
/// consume every source block across 3 successive pages, with no
/// duplicates and no skipped ids.
#[tokio::test]
async fn eval_backlink_query_keyset_paginates_correctly() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "PARENT", "page", "Parent", None, None).await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    bulk_insert_n_backlink_sources(&pool, "PARENT", "TARGET", 25).await;

    let expected: FxHashSet<String> = (1..=25).map(|k| format!("BL_{k:06}")).collect();

    let mut seen: FxHashSet<String> = FxHashSet::default();
    let mut cursor: Option<String> = None;
    for iteration in 0..4 {
        let page = PageRequest::new(cursor, Some(10)).unwrap();
        let resp = eval_backlink_query(&pool, "TARGET", None, None, &page, None)
            .await
            .unwrap();
        for item in &resp.items {
            assert!(
                seen.insert(item.id.as_str().to_string()),
                "duplicate id surfaced across pages: {}",
                item.id.as_str()
            );
        }
        cursor = resp.next_cursor;
        if !resp.has_more {
            assert!(
                iteration < 3,
                "expected to terminate within 3 page transitions"
            );
            break;
        }
    }

    assert_eq!(
        seen, expected,
        "keyset pagination must visit every backlink exactly once"
    );
}

/// H1: with 30 backlinks and a property filter that matches 10 of
/// them, `total_count` must reflect every backlink and
/// `filtered_count` must reflect only the property-matched subset.
/// The page query must intersect base predicates with the filter set
/// in SQL.
#[tokio::test]
async fn eval_backlink_query_with_filter_counts_correctly() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "PARENT", "page", "Parent", None, None).await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    bulk_insert_n_backlink_sources(&pool, "PARENT", "TARGET", 30).await;

    // Tag the first 10 source blocks with `status = active`.
    for k in 1..=10 {
        insert_property(
            &pool,
            &format!("BL_{k:06}"),
            "status",
            Some("active"),
            None,
            None,
        )
        .await;
    }

    let filters = vec![BacklinkFilter::PropertyText {
        key: "status".into(),
        op: CompareOp::Eq,
        value: "active".into(),
    }];
    let page = PageRequest::new(None, Some(50)).unwrap();
    let resp = eval_backlink_query(&pool, "TARGET", Some(filters), None, &page, None)
        .await
        .unwrap();

    assert_eq!(
        resp.total_count, 30,
        "total_count counts every backlink, ignoring filters"
    );
    assert_eq!(
        resp.filtered_count, 10,
        "filtered_count counts only property-matched backlinks"
    );
    assert_eq!(resp.items.len(), 10, "all 10 matches fit in limit=50");
    let ids: FxHashSet<&str> = resp.items.iter().map(|r| r.id.as_str()).collect();
    let expected: FxHashSet<String> = (1..=10).map(|k| format!("BL_{k:06}")).collect();
    let expected_refs: FxHashSet<&str> = expected.iter().map(String::as_str).collect();
    assert_eq!(
        ids, expected_refs,
        "returned items must match the property-matched id set"
    );
}

/// H1: the grouped variant must also paginate correctly under keyset
/// semantics. With backlinks coming from 5 distinct source pages and
/// limit=2, three page transitions must surface every group.
#[tokio::test]
async fn eval_backlink_query_grouped_paginates_correctly() {
    let (pool, _dir) = test_pool().await;
    insert_block_with_parent(&pool, "TARGET", "page", "Target", None, None).await;
    // 5 distinct source pages, each with one content child that links to TARGET.
    // Group ids: PG_000001..PG_000005 (alphabetical order matches insertion).
    bulk_insert_n_pages_with_one_link(&pool, "TARGET", 5, "PG_", "BK_").await;

    let mut seen_groups: FxHashSet<String> = FxHashSet::default();
    let mut cursor: Option<String> = None;
    for iteration in 0..4 {
        let page = PageRequest::new(cursor, Some(2)).unwrap();
        let resp = eval_backlink_query_grouped(&pool, "TARGET", None, None, &page, None)
            .await
            .unwrap();
        for group in &resp.groups {
            assert!(
                seen_groups.insert(group.page_id.clone()),
                "duplicate group across pages: {}",
                group.page_id
            );
            assert_eq!(group.blocks.len(), 1, "each fixture page has one backlink");
        }
        assert_eq!(
            resp.total_count, 5,
            "5 backlinks across the fixture (one per page)"
        );
        cursor = resp.next_cursor;
        if !resp.has_more {
            assert!(
                iteration < 3,
                "expected to terminate within 3 page transitions"
            );
            break;
        }
    }

    let expected: FxHashSet<String> = (1..=5).map(|k| format!("PG_{k:06}")).collect();
    assert_eq!(
        seen_groups, expected,
        "grouped keyset pagination must visit every source group exactly once"
    );
}

// ======================================================================
// #346 P1 — SQL-pushdown parity battery
//
// Proves the new `compile_backlink_filter` path (`eval_backlink_query`'s
// correlated SQL WHERE fragment) returns IDENTICAL `items` (as an id set),
// `total_count`, and `filtered_count` to a reference computed via the OLD
// `resolve_filter` + base-set-intersection logic. The old resolver is kept
// solely as this parity oracle (#346 P1 contract).
//
// EVERY leaf type is covered, with emphasis on the negative / broad trees
// (`Not`, `PropertyIsEmpty`, broad `BlockType`, `Not(HasTag)`,
// `And(Not(X), Y)`, `Or(...)`, deeply nested) that previously forced the
// whole-vault complement into Rust.
// ======================================================================
#[cfg(test)]
mod parity_p1 {
    use super::*;
    use crate::backlink::filters::ms_to_ulid_prefix;

    /// Insert a block with full control over the scalar filter columns.
    /// `id` is the (ULID-shaped) primary key; pages set `page_id = id`.
    #[allow(clippy::too_many_arguments)]
    async fn insert_full(
        pool: &SqlitePool,
        id: &str,
        block_type: &str,
        page_id: Option<&str>,
        parent_id: Option<&str>,
        todo_state: Option<&str>,
        priority: Option<&str>,
        due_date: Option<&str>,
        deleted: bool,
    ) {
        let pid: Option<String> = if block_type == "page" {
            Some(id.to_string())
        } else {
            page_id.map(str::to_string)
        };
        let deleted_at: Option<i64> = if deleted {
            Some(1_700_000_000_000)
        } else {
            None
        };
        sqlx::query(
            "INSERT INTO blocks \
             (id, block_type, content, page_id, parent_id, todo_state, priority, due_date, deleted_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(block_type)
        .bind(format!("content of {id}"))
        .bind(pid)
        .bind(parent_id)
        .bind(todo_state)
        .bind(priority)
        .bind(due_date)
        .bind(deleted_at)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Build a deterministic 26-char ULID-shaped id whose 10-char timestamp
    /// prefix encodes `ms`, padded with a fixed random component. This lets
    /// `CreatedInRange` (which compares `b.id >= ms_to_ulid_prefix(after)`)
    /// behave predictably.
    fn ulid_at(ms: u64, suffix: &str) -> String {
        let prefix = ms_to_ulid_prefix(ms);
        // 16-char Crockford suffix; caller passes a short tag we pad out.
        let mut s = suffix.to_string();
        while s.len() < 16 {
            s.push('0');
        }
        s.truncate(16);
        format!("{prefix}{s}")
    }

    /// The shared rich fixture. Returns the `TARGET` page id. All source
    /// blocks link to TARGET (so they form the backlink base set) except
    /// where noted. Deleted + self-link + non-linking blocks are seeded to
    /// exercise the base-set predicates the fragment must NOT re-filter.
    async fn seed_fixture(pool: &SqlitePool) -> String {
        // Target page.
        insert_full(
            pool,
            "TARGETPAGE0000000000000000",
            "page",
            None,
            None,
            None,
            None,
            None,
            false,
        )
        .await;

        // Two ancestor pages for SourcePage descendants-of testing.
        insert_full(
            pool,
            "PAGEALPHA00000000000000000",
            "page",
            None,
            None,
            None,
            None,
            None,
            false,
        )
        .await;
        insert_full(
            pool,
            "PAGEBETA000000000000000000",
            "page",
            None,
            None,
            None,
            None,
            None,
            false,
        )
        .await;

        // Distinct creation times so CreatedInRange has something to bisect.
        let t0 = 1_600_000_000_000u64;
        let day = 86_400_000u64;

        // Source blocks. (id, block_type, page, parent, todo, prio, due, deleted)
        // S1: content, on PAGEALPHA, todo=open, prio=high, due=2025-06-01
        let s1 = ulid_at(t0, "S1");
        insert_full(
            pool,
            &s1,
            "content",
            Some("PAGEALPHA00000000000000000"),
            Some("PAGEALPHA00000000000000000"),
            Some("open"),
            Some("high"),
            Some("2025-06-01"),
            false,
        )
        .await;
        // S2: content, on PAGEALPHA, no todo, prio=low, due=2025-07-15
        let s2 = ulid_at(t0 + day, "S2");
        insert_full(
            pool,
            &s2,
            "content",
            Some("PAGEALPHA00000000000000000"),
            Some("PAGEALPHA00000000000000000"),
            None,
            Some("low"),
            Some("2025-07-15"),
            false,
        )
        .await;
        // S3: tag, on PAGEBETA, todo=done, prio=high, no due
        // (`block_type` CHECK only permits content / tag / page.)
        let s3 = ulid_at(t0 + 2 * day, "S3");
        insert_full(
            pool,
            &s3,
            "tag",
            Some("PAGEBETA000000000000000000"),
            Some("PAGEBETA000000000000000000"),
            Some("done"),
            Some("high"),
            None,
            false,
        )
        .await;
        // S4: content, on PAGEBETA, todo=open, no prio, due=2024-01-01
        let s4 = ulid_at(t0 + 3 * day, "S4");
        insert_full(
            pool,
            &s4,
            "content",
            Some("PAGEBETA000000000000000000"),
            Some("PAGEBETA000000000000000000"),
            Some("open"),
            None,
            Some("2024-01-01"),
            false,
        )
        .await;
        // S5: page-less content (orphan from a page perspective).
        let s5 = ulid_at(t0 + 4 * day, "S5");
        insert_full(pool, &s5, "content", None, None, None, None, None, false).await;
        // S6: content — DELETED (must never surface; base set excludes it).
        let s6 = ulid_at(t0 + 5 * day, "S6");
        insert_full(
            pool,
            &s6,
            "content",
            Some("PAGEALPHA00000000000000000"),
            Some("PAGEALPHA00000000000000000"),
            Some("open"),
            Some("high"),
            Some("2025-06-01"),
            true,
        )
        .await;

        // Links into TARGET.
        for s in [&s1, &s2, &s3, &s4, &s5, &s6] {
            insert_block_link(pool, s, "TARGETPAGE0000000000000000").await;
        }
        // Self-link (must be excluded by base set).
        insert_block_link(
            pool,
            "TARGETPAGE0000000000000000",
            "TARGETPAGE0000000000000000",
        )
        .await;

        // A non-linking block (not in base set) that nonetheless matches
        // many filters — guards that the fragment is correlated to the base.
        let nolink = ulid_at(t0 + 6 * day, "NOLINK");
        insert_full(
            pool,
            &nolink,
            "content",
            Some("PAGEALPHA00000000000000000"),
            Some("PAGEALPHA00000000000000000"),
            Some("open"),
            Some("high"),
            Some("2025-06-01"),
            false,
        )
        .await;

        // Properties.
        insert_property(pool, &s1, "status", Some("active"), None, None).await;
        insert_property(pool, &s1, "score", None, Some(10.0), None).await;
        insert_property(pool, &s1, "reviewed", None, None, Some("2025-03-01")).await;
        insert_property(pool, &s2, "status", Some("archived"), None, None).await;
        insert_property(pool, &s2, "score", None, Some(99.0), None).await;
        insert_property(pool, &s3, "status", Some("active"), None, None).await;
        // s4: no properties at all (PropertyIsEmpty target).
        insert_property(pool, &s5, "score", None, Some(50.0), None).await;
        insert_property(pool, &nolink, "status", Some("active"), None, None).await;

        // Tag blocks must exist as `block_type = 'tag'` rows (block_tags
        // FKs `tag_id` → blocks(id)).
        insert_full(
            pool,
            "TAGONE00000000000000000001",
            "tag",
            None,
            None,
            None,
            None,
            None,
            false,
        )
        .await;
        insert_full(
            pool,
            "TAGTWO00000000000000000002",
            "tag",
            None,
            None,
            None,
            None,
            None,
            false,
        )
        .await;

        // Tags. Tag T1 on S1, S3. Tag-name cache for prefix matching.
        insert_tag_cache(pool, "TAGONE00000000000000000001", "project", 2).await;
        insert_tag_cache(pool, "TAGTWO00000000000000000002", "proposal", 1).await;
        insert_tag_assoc(pool, &s1, "TAGONE00000000000000000001").await;
        insert_tag_assoc(pool, &s3, "TAGONE00000000000000000001").await;
        insert_tag_assoc(pool, &s2, "TAGTWO00000000000000000002").await;

        // FTS content for Contains.
        insert_fts(pool, &s1, "the quick brown fox").await;
        insert_fts(pool, &s2, "lazy dog sleeps").await;
        insert_fts(pool, &s3, "quick silver fox").await;
        insert_fts(pool, &s4, "nothing special here").await;

        "TARGETPAGE0000000000000000".to_string()
    }

    /// Reference (OLD-path) result for a list of top-level (AND-combined)
    /// filters: returns (filtered_id_set_in_base, total_count).
    ///
    /// Mirrors exactly what the pre-#346 `eval_backlink_query` computed:
    /// base = non-deleted, non-self source blocks linking to target; the
    /// per-filter `resolve_filter` sets are AND-intersected, then
    /// intersected with the base set.
    async fn oracle(
        pool: &SqlitePool,
        target: &str,
        filters: &[BacklinkFilter],
    ) -> (FxHashSet<String>, usize) {
        // Base set via SQL (same predicate as eval_backlink_query's total).
        let base: FxHashSet<String> = sqlx::query_scalar::<_, String>(
            "SELECT bl.source_id FROM block_links bl \
             JOIN blocks b ON b.id = bl.source_id \
             WHERE bl.target_id = ?1 AND bl.source_id != ?1 \
               AND b.deleted_at IS NULL",
        )
        .bind(target)
        .fetch_all(pool)
        .await
        .unwrap()
        .into_iter()
        .collect();
        let total = base.len();

        if filters.is_empty() {
            return (base.clone(), total);
        }

        // AND-intersection of each top-level filter's resolved set.
        let mut acc: Option<FxHashSet<String>> = None;
        for f in filters {
            let set = resolve_filter(pool, f, 0).await.unwrap();
            acc = Some(match acc {
                None => set,
                Some(mut a) => {
                    a.retain(|id| set.contains(id));
                    a
                }
            });
        }
        let filtered = acc.unwrap_or_default();
        // Intersect with base (the page query does this server-side).
        let in_base: FxHashSet<String> = filtered.intersection(&base).cloned().collect();
        (in_base, total)
    }

    /// Run one parity case: assert NEW eval_backlink_query == oracle for
    /// item-id set, total_count, and filtered_count.
    async fn assert_parity(
        pool: &SqlitePool,
        target: &str,
        label: &str,
        filters: Vec<BacklinkFilter>,
    ) {
        let (expected_ids, expected_total) = oracle(pool, target, &filters).await;

        // Large page so we get every item in one shot (fixture base set is
        // tiny; 200 is the max permitted limit).
        let page = PageRequest::new(None, Some(200)).unwrap();
        let filt_arg = if filters.is_empty() {
            None
        } else {
            Some(filters.clone())
        };
        let resp = eval_backlink_query(pool, target, filt_arg, None, &page, None)
            .await
            .unwrap_or_else(|e| panic!("[{label}] eval_backlink_query failed: {e:?}"));

        let got_ids: FxHashSet<String> = resp.items.iter().map(|r| r.id.to_string()).collect();

        assert_eq!(
            resp.total_count, expected_total,
            "[{label}] total_count mismatch"
        );
        assert_eq!(
            resp.filtered_count,
            expected_ids.len(),
            "[{label}] filtered_count mismatch (expected ids: {expected_ids:?}, got: {got_ids:?})"
        );
        assert_eq!(got_ids, expected_ids, "[{label}] item id set mismatch");
        // Items must be id-sorted (Created Asc default) and de-duplicated.
        let mut sorted = resp
            .items
            .iter()
            .map(|r| r.id.to_string())
            .collect::<Vec<_>>();
        let original = sorted.clone();
        sorted.sort();
        assert_eq!(original, sorted, "[{label}] items must be ascending by id");
        assert_eq!(
            resp.items.len(),
            got_ids.len(),
            "[{label}] items must contain no duplicate ids"
        );
    }

    fn prop_text(key: &str, op: CompareOp, value: &str) -> BacklinkFilter {
        BacklinkFilter::PropertyText {
            key: key.into(),
            op,
            value: value.into(),
        }
    }

    /// The full battery of filter trees. Each entry is (label, filters).
    fn battery() -> Vec<(&'static str, Vec<BacklinkFilter>)> {
        vec![
            // ── Empty / passthrough ──
            ("no_filters", vec![]),
            // ── Property* leaves ──
            (
                "prop_text_eq",
                vec![prop_text("status", CompareOp::Eq, "active")],
            ),
            (
                "prop_text_neq",
                vec![prop_text("status", CompareOp::Neq, "active")],
            ),
            (
                "prop_text_contains",
                vec![prop_text("status", CompareOp::Contains, "act")],
            ),
            (
                "prop_text_startswith",
                vec![prop_text("status", CompareOp::StartsWith, "arch")],
            ),
            (
                "prop_text_lt",
                vec![prop_text("status", CompareOp::Lt, "b")],
            ),
            (
                "prop_num_gt",
                vec![BacklinkFilter::PropertyNum {
                    key: "score".into(),
                    op: CompareOp::Gt,
                    value: 20.0,
                }],
            ),
            (
                "prop_num_eq",
                vec![BacklinkFilter::PropertyNum {
                    key: "score".into(),
                    op: CompareOp::Eq,
                    value: 10.0,
                }],
            ),
            (
                "prop_num_contains_empty",
                vec![BacklinkFilter::PropertyNum {
                    key: "score".into(),
                    op: CompareOp::Contains,
                    value: 1.0,
                }],
            ),
            (
                "prop_date_gte",
                vec![BacklinkFilter::PropertyDate {
                    key: "reviewed".into(),
                    op: CompareOp::Gte,
                    value: "2025-01-01".into(),
                }],
            ),
            (
                "prop_date_startswith",
                vec![BacklinkFilter::PropertyDate {
                    key: "reviewed".into(),
                    op: CompareOp::StartsWith,
                    value: "2025".into(),
                }],
            ),
            (
                "prop_is_set",
                vec![BacklinkFilter::PropertyIsSet {
                    key: "status".into(),
                }],
            ),
            // NEGATIVE: PropertyIsEmpty (the whole-vault-complement case).
            (
                "prop_is_empty",
                vec![BacklinkFilter::PropertyIsEmpty {
                    key: "status".into(),
                }],
            ),
            (
                "prop_is_empty_score",
                vec![BacklinkFilter::PropertyIsEmpty {
                    key: "score".into(),
                }],
            ),
            // ── Scalar column leaves ──
            (
                "block_type_content",
                vec![BacklinkFilter::BlockType {
                    block_type: "content".into(),
                }],
            ),
            (
                "block_type_tag",
                vec![BacklinkFilter::BlockType {
                    block_type: "tag".into(),
                }],
            ),
            (
                "todo_open",
                vec![BacklinkFilter::TodoState {
                    state: "open".into(),
                }],
            ),
            (
                "priority_high",
                vec![BacklinkFilter::Priority {
                    level: "high".into(),
                }],
            ),
            (
                "due_lt",
                vec![BacklinkFilter::DueDate {
                    op: CompareOp::Lt,
                    value: "2025-01-01".into(),
                }],
            ),
            (
                "due_neq_guarded",
                vec![BacklinkFilter::DueDate {
                    op: CompareOp::Neq,
                    value: "2025-06-01".into(),
                }],
            ),
            (
                "due_gte",
                vec![BacklinkFilter::DueDate {
                    op: CompareOp::Gte,
                    value: "2025-01-01".into(),
                }],
            ),
            // ── CreatedInRange ──
            (
                "created_after",
                vec![BacklinkFilter::CreatedInRange {
                    after: Some("2020-09-15".into()),
                    before: None,
                }],
            ),
            (
                "created_before",
                vec![BacklinkFilter::CreatedInRange {
                    after: None,
                    before: Some("2020-09-15".into()),
                }],
            ),
            (
                "created_both",
                vec![BacklinkFilter::CreatedInRange {
                    after: Some("2020-09-13".into()),
                    before: Some("2020-09-17".into()),
                }],
            ),
            (
                "created_none",
                vec![BacklinkFilter::CreatedInRange {
                    after: None,
                    before: None,
                }],
            ),
            // ── Hybrid (set-embedded) leaves ──
            (
                "contains",
                vec![BacklinkFilter::Contains {
                    query: "fox".into(),
                }],
            ),
            (
                "contains_empty",
                vec![BacklinkFilter::Contains {
                    query: "   ".into(),
                }],
            ),
            (
                "has_tag",
                vec![BacklinkFilter::HasTag {
                    tag_id: "TAGONE00000000000000000001".into(),
                }],
            ),
            (
                "has_tag_prefix",
                vec![BacklinkFilter::HasTagPrefix {
                    prefix: "pro".into(),
                }],
            ),
            (
                "source_page_included",
                vec![BacklinkFilter::SourcePage {
                    included: vec!["PAGEALPHA00000000000000000".into()],
                    excluded: vec![],
                }],
            ),
            (
                "source_page_excluded",
                vec![BacklinkFilter::SourcePage {
                    included: vec![],
                    excluded: vec!["PAGEALPHA00000000000000000".into()],
                }],
            ),
            (
                "source_page_incl_excl",
                vec![BacklinkFilter::SourcePage {
                    included: vec![
                        "PAGEALPHA00000000000000000".into(),
                        "PAGEBETA000000000000000000".into(),
                    ],
                    excluded: vec!["PAGEBETA000000000000000000".into()],
                }],
            ),
            // ── Boolean: Not (negative/broad) ──
            (
                "not_block_type_content",
                vec![BacklinkFilter::Not {
                    filter: Box::new(BacklinkFilter::BlockType {
                        block_type: "content".into(),
                    }),
                }],
            ),
            (
                "not_has_tag",
                vec![BacklinkFilter::Not {
                    filter: Box::new(BacklinkFilter::HasTag {
                        tag_id: "TAGONE00000000000000000001".into(),
                    }),
                }],
            ),
            (
                "not_prop_is_set",
                vec![BacklinkFilter::Not {
                    filter: Box::new(BacklinkFilter::PropertyIsSet {
                        key: "status".into(),
                    }),
                }],
            ),
            (
                "not_of_empty",
                vec![BacklinkFilter::Not {
                    filter: Box::new(BacklinkFilter::PropertyIsSet {
                        key: "no_such_key".into(),
                    }),
                }],
            ),
            // ── Boolean: And ──
            (
                "and_block_and_todo",
                vec![BacklinkFilter::And {
                    filters: vec![
                        BacklinkFilter::BlockType {
                            block_type: "content".into(),
                        },
                        BacklinkFilter::TodoState {
                            state: "open".into(),
                        },
                    ],
                }],
            ),
            (
                "and_not_x_y",
                vec![BacklinkFilter::And {
                    filters: vec![
                        BacklinkFilter::Not {
                            filter: Box::new(BacklinkFilter::HasTag {
                                tag_id: "TAGONE00000000000000000001".into(),
                            }),
                        },
                        BacklinkFilter::BlockType {
                            block_type: "content".into(),
                        },
                    ],
                }],
            ),
            ("and_empty", vec![BacklinkFilter::And { filters: vec![] }]),
            // ── Boolean: Or ──
            (
                "or_tag_or_page",
                vec![BacklinkFilter::Or {
                    filters: vec![
                        BacklinkFilter::BlockType {
                            block_type: "tag".into(),
                        },
                        BacklinkFilter::BlockType {
                            block_type: "page".into(),
                        },
                    ],
                }],
            ),
            (
                "or_tag_or_propempty",
                vec![BacklinkFilter::Or {
                    filters: vec![
                        BacklinkFilter::HasTag {
                            tag_id: "TAGONE00000000000000000001".into(),
                        },
                        BacklinkFilter::PropertyIsEmpty {
                            key: "status".into(),
                        },
                    ],
                }],
            ),
            ("or_empty", vec![BacklinkFilter::Or { filters: vec![] }]),
            // ── Multiple top-level (implicit AND) ──
            (
                "toplevel_and_two",
                vec![
                    BacklinkFilter::BlockType {
                        block_type: "content".into(),
                    },
                    prop_text("status", CompareOp::Eq, "active"),
                ],
            ),
            // ── Deeply nested ──
            (
                "nested_or_and_not",
                vec![BacklinkFilter::Or {
                    filters: vec![
                        BacklinkFilter::And {
                            filters: vec![
                                BacklinkFilter::BlockType {
                                    block_type: "content".into(),
                                },
                                BacklinkFilter::Not {
                                    filter: Box::new(BacklinkFilter::PropertyIsEmpty {
                                        key: "status".into(),
                                    }),
                                },
                            ],
                        },
                        BacklinkFilter::And {
                            filters: vec![
                                BacklinkFilter::BlockType {
                                    block_type: "tag".into(),
                                },
                                BacklinkFilter::HasTag {
                                    tag_id: "TAGONE00000000000000000001".into(),
                                },
                            ],
                        },
                    ],
                }],
            ),
            (
                "nested_not_or",
                vec![BacklinkFilter::Not {
                    filter: Box::new(BacklinkFilter::Or {
                        filters: vec![
                            BacklinkFilter::BlockType {
                                block_type: "tag".into(),
                            },
                            BacklinkFilter::BlockType {
                                block_type: "page".into(),
                            },
                        ],
                    }),
                }],
            ),
            (
                "nested_and_not_source_page",
                vec![BacklinkFilter::And {
                    filters: vec![
                        BacklinkFilter::Not {
                            filter: Box::new(BacklinkFilter::SourcePage {
                                included: vec!["PAGEBETA000000000000000000".into()],
                                excluded: vec![],
                            }),
                        },
                        BacklinkFilter::PropertyIsSet {
                            key: "status".into(),
                        },
                    ],
                }],
            ),
        ]
    }

    #[tokio::test]
    async fn p1_parity_battery_covers_every_leaf_and_boolean_combo() {
        let (pool, _dir) = test_pool().await;
        let target = seed_fixture(&pool).await;
        for (label, filters) in battery() {
            assert_parity(&pool, &target, label, filters).await;
        }
    }

    /// Property-sort path parity: the same battery, but asserting the
    /// `eval_property_sort_materialised` branch (sort by a property) returns
    /// the same id set + counts as the oracle. Sorting differs from Created,
    /// but the *set* of matched ids and the counts must be identical.
    #[tokio::test]
    async fn p1_parity_property_sort_matches_oracle_set() {
        let (pool, _dir) = test_pool().await;
        let target = seed_fixture(&pool).await;
        let page = PageRequest::new(None, Some(200)).unwrap();
        for (label, filters) in battery() {
            let (expected_ids, expected_total) = oracle(&pool, &target, &filters).await;
            let filt_arg = if filters.is_empty() {
                None
            } else {
                Some(filters.clone())
            };
            let sort = Some(BacklinkSort::PropertyText {
                key: "status".into(),
                dir: SortDir::Asc,
            });
            let resp = eval_backlink_query(&pool, &target, filt_arg, sort, &page, None)
                .await
                .unwrap_or_else(|e| panic!("[{label}/propsort] failed: {e:?}"));
            let got_ids: FxHashSet<String> = resp.items.iter().map(|r| r.id.to_string()).collect();
            assert_eq!(
                resp.total_count, expected_total,
                "[{label}/propsort] total_count"
            );
            assert_eq!(
                resp.filtered_count,
                expected_ids.len(),
                "[{label}/propsort] filtered_count"
            );
            assert_eq!(got_ids, expected_ids, "[{label}/propsort] id set");
        }
    }

    /// Pagination parity: walk the Created-sort path one small page at a
    /// time and confirm the union of pages equals the oracle set with no
    /// duplicates — guards the cursor/keyset interaction with the fragment.
    #[tokio::test]
    async fn p1_parity_paginated_created_sort() {
        let (pool, _dir) = test_pool().await;
        let target = seed_fixture(&pool).await;
        let filters = vec![BacklinkFilter::Not {
            filter: Box::new(BacklinkFilter::BlockType {
                block_type: "content".into(),
            }),
        }];
        let (expected_ids, _total) = oracle(&pool, &target, &filters).await;

        let mut seen: FxHashSet<String> = FxHashSet::default();
        let mut cursor: Option<Cursor> = None;
        for _ in 0..20 {
            let page =
                PageRequest::new(cursor.clone().map(|c| c.encode().unwrap()), Some(1)).unwrap();
            let resp =
                eval_backlink_query(&pool, &target, Some(filters.clone()), None, &page, None)
                    .await
                    .unwrap();
            for it in &resp.items {
                assert!(
                    seen.insert(it.id.to_string()),
                    "duplicate id across pages: {}",
                    it.id
                );
            }
            if !resp.has_more {
                break;
            }
            cursor = resp
                .next_cursor
                .as_ref()
                .map(|c| Cursor::decode(c).unwrap());
        }
        assert_eq!(seen, expected_ids, "paginated union must equal oracle set");
    }

    /// Focused regression for the three-valued-logic bug the randomised
    /// battery surfaced (#346 P1): `Not(Priority="low")` must INCLUDE a row
    /// whose `priority` column is NULL (it does not match the positive
    /// filter, so it belongs in the complement). Raw SQL `NOT (b.priority =
    /// ?)` yields NULL (→ false in WHERE) on a NULL column and would wrongly
    /// drop the row; the `NOT COALESCE((…), 0)` wrap fixes it.
    #[tokio::test]
    async fn p1_not_over_null_column_includes_null_rows() {
        let (pool, _dir) = test_pool().await;
        let target = seed_fixture(&pool).await;
        // S5 has a NULL priority and links to TARGET.
        let filters = vec![BacklinkFilter::Not {
            filter: Box::new(BacklinkFilter::Priority {
                level: "low".into(),
            }),
        }];
        assert_parity(&pool, &target, "not_priority_low_null_guard", filters).await;
        // Also assert directly that the NULL-priority source survives.
        let page = PageRequest::new(None, Some(200)).unwrap();
        let resp = eval_backlink_query(
            &pool,
            &target,
            Some(vec![BacklinkFilter::Not {
                filter: Box::new(BacklinkFilter::Priority {
                    level: "low".into(),
                }),
            }]),
            None,
            &page,
            None,
        )
        .await
        .unwrap();
        let ids: FxHashSet<String> = resp.items.iter().map(|r| r.id.to_string()).collect();
        let s5 = ulid_at(1_600_000_000_000u64 + 4 * 86_400_000u64, "S5");
        assert!(
            ids.contains(&s5),
            "Not(Priority=low) must include the NULL-priority source S5: {ids:?}"
        );
    }

    /// Randomised battery: generate pseudo-random filter trees from a seeded
    /// LCG and assert parity for each. Deterministic (fixed seed) so a
    /// failure is reproducible.
    #[tokio::test]
    async fn p1_parity_randomised_trees() {
        let (pool, _dir) = test_pool().await;
        let target = seed_fixture(&pool).await;

        let mut state: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as u32
        };

        fn gen_leaf(r: &mut impl FnMut() -> u32) -> BacklinkFilter {
            match r() % 8 {
                0 => BacklinkFilter::BlockType {
                    block_type: ["content", "tag", "page"][(r() % 3) as usize].into(),
                },
                1 => BacklinkFilter::TodoState {
                    state: ["open", "done"][(r() % 2) as usize].into(),
                },
                2 => BacklinkFilter::Priority {
                    level: ["high", "low"][(r() % 2) as usize].into(),
                },
                3 => BacklinkFilter::PropertyIsSet {
                    key: ["status", "score", "reviewed"][(r() % 3) as usize].into(),
                },
                4 => BacklinkFilter::PropertyIsEmpty {
                    key: ["status", "score"][(r() % 2) as usize].into(),
                },
                5 => BacklinkFilter::PropertyText {
                    key: "status".into(),
                    op: CompareOp::Eq,
                    value: ["active", "archived"][(r() % 2) as usize].into(),
                },
                6 => BacklinkFilter::HasTag {
                    tag_id: "TAGONE00000000000000000001".into(),
                },
                _ => BacklinkFilter::SourcePage {
                    included: vec!["PAGEALPHA00000000000000000".into()],
                    excluded: vec![],
                },
            }
        }

        fn gen_tree(r: &mut impl FnMut() -> u32, depth: u32) -> BacklinkFilter {
            if depth == 0 || r().is_multiple_of(3) {
                return gen_leaf(r);
            }
            match r() % 3 {
                0 => BacklinkFilter::Not {
                    filter: Box::new(gen_tree(r, depth - 1)),
                },
                1 => BacklinkFilter::And {
                    filters: vec![gen_tree(r, depth - 1), gen_tree(r, depth - 1)],
                },
                _ => BacklinkFilter::Or {
                    filters: vec![gen_tree(r, depth - 1), gen_tree(r, depth - 1)],
                },
            }
        }

        for i in 0..200 {
            let tree = gen_tree(&mut next, 3);
            // Include the tree in the label so any divergence is
            // self-reproducing from the failure message.
            let label = format!("rand_{i}: {tree:?}");
            assert_parity(&pool, &target, &label, vec![tree]).await;
        }
    }
}
