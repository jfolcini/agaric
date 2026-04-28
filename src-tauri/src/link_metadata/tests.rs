//! Unit tests for `link_metadata`: HTML parsing, URL helpers, and DB ops.

use super::html_parser::{detect_auth_required, parse_description, parse_favicon, parse_title};
use super::html_parser::{extract_domain, extract_origin, resolve_url, truncate_str};
use super::{cleanup_stale, clear_auth_flag, get_cached, upsert, LinkMetadata};
use crate::db::init_pool;
use crate::now_rfc3339;
use sqlx::SqlitePool;
use std::path::PathBuf;
use tempfile::TempDir;

async fn test_pool() -> (SqlitePool, TempDir) {
    let dir = TempDir::new().unwrap();
    let db_path: PathBuf = dir.path().join("test.db");
    let pool = init_pool(&db_path).await.unwrap();
    (pool, dir)
}

// ======================================================================
// parse_title tests
// ======================================================================

#[test]
fn parse_title_from_title_tag() {
    let html = "<html><head><title>Hello World</title></head></html>";
    assert_eq!(
        parse_title(html),
        Some("Hello World".to_string()),
        "should extract title from <title> tag"
    );
}

#[test]
fn parse_title_from_og_title() {
    let html = r#"<html><head><meta property="og:title" content="OG Title"></head></html>"#;
    assert_eq!(
        parse_title(html),
        Some("OG Title".to_string()),
        "should extract title from og:title meta"
    );
}

#[test]
fn parse_title_og_title_preferred_over_title_tag() {
    let html = r#"<html><head>
        <title>Tag Title</title>
        <meta property="og:title" content="OG Title">
    </head></html>"#;
    assert_eq!(
        parse_title(html),
        Some("OG Title".to_string()),
        "og:title should be preferred over <title> tag"
    );
}

#[test]
fn parse_title_missing_returns_none() {
    let html = "<html><head></head><body>No title</body></html>";
    assert_eq!(
        parse_title(html),
        None,
        "should return None when no title found"
    );
}

#[test]
fn parse_title_empty_returns_none() {
    let html = "<html><head><title>   </title></head></html>";
    assert_eq!(
        parse_title(html),
        None,
        "should return None for whitespace-only title"
    );
}

#[test]
fn parse_title_trims_whitespace() {
    let html = "<html><head><title>  Spaced  </title></head></html>";
    assert_eq!(
        parse_title(html),
        Some("Spaced".to_string()),
        "should trim whitespace from title"
    );
}

#[test]
fn parse_title_truncates_to_500_chars() {
    let long_title = "a".repeat(600);
    let html = format!("<html><head><title>{long_title}</title></head></html>");
    let result = parse_title(&html).unwrap();
    assert_eq!(result.len(), 500, "should truncate title to 500 chars");
}

#[test]
fn parse_title_decodes_html_entities() {
    let html = "<html><head><title>Tom &amp; Jerry</title></head></html>";
    assert_eq!(
        parse_title(html),
        Some("Tom & Jerry".to_string()),
        "should decode HTML entities in title"
    );
}

/// I-Search-16: regression test pinning the current over-decoding of
/// chained / double-escaped HTML entities.
///
/// The input `Tom &amp;lt; Jerry` is the HTML encoding of the literal
/// four-character text `Tom &lt; Jerry` (i.e. the user wants the
/// literal `&lt;` to render). A correct single-pass decoder would
/// produce `Tom &lt; Jerry`. Our chained `replace` pipeline first
/// rewrites `&amp;` → `&`, producing `Tom &lt; Jerry`, then re-scans
/// and rewrites `&lt;` → `<`, collapsing the result to `Tom < Jerry`.
///
/// This test fails the moment we land a single-pass decoder
/// (`html-escape` / `htmlescape` crate or a hand-rolled scanner), at
/// which point the assertion should be updated to expect the correct
/// `Tom &lt; Jerry`. See `decode_html_entities`'s docstring and
/// REVIEW-LATER.md item I-Search-16.
#[test]
fn parse_title_chained_entity_known_limitation() {
    let html = "<html><head><title>Tom &amp;lt; Jerry</title></head></html>";
    assert_eq!(
        parse_title(html),
        Some("Tom < Jerry".to_string()),
        "current chained-replace decoder over-decodes `&amp;lt;` to `<`; \
         a single-pass decoder would yield `Tom &lt; Jerry` (I-Search-16)"
    );
}

// ======================================================================
// parse_favicon tests
// ======================================================================

#[test]
fn parse_favicon_from_link_rel_icon() {
    let html = r#"<html><head><link rel="icon" href="/img/favicon.png"></head></html>"#;
    assert_eq!(
        parse_favicon(html, "https://example.com/page"),
        Some("https://example.com/img/favicon.png".to_string()),
        "should extract favicon from link rel icon"
    );
}

#[test]
fn parse_favicon_from_shortcut_icon() {
    let html = r#"<html><head><link rel="shortcut icon" href="/favicon.ico"></head></html>"#;
    assert_eq!(
        parse_favicon(html, "https://example.com/page"),
        Some("https://example.com/favicon.ico".to_string()),
        "should extract favicon from shortcut icon"
    );
}

#[test]
fn parse_favicon_absolute_url() {
    let html =
        r#"<html><head><link rel="icon" href="https://cdn.example.com/icon.png"></head></html>"#;
    assert_eq!(
        parse_favicon(html, "https://example.com/page"),
        Some("https://cdn.example.com/icon.png".to_string()),
        "should keep absolute favicon URL unchanged"
    );
}

#[test]
fn parse_favicon_relative_url_resolution() {
    let html = r#"<html><head><link rel="icon" href="images/icon.png"></head></html>"#;
    assert_eq!(
        parse_favicon(html, "https://example.com/path/page"),
        Some("https://example.com/path/images/icon.png".to_string()),
        "should resolve relative favicon URL against base"
    );
}

#[test]
fn parse_favicon_fallback_to_favicon_ico() {
    let html = "<html><head></head></html>";
    assert_eq!(
        parse_favicon(html, "https://example.com/page"),
        Some("https://example.com/favicon.ico".to_string()),
        "should fall back to /favicon.ico when no link tag found"
    );
}

#[test]
fn parse_favicon_protocol_relative() {
    let html = r#"<html><head><link rel="icon" href="//cdn.example.com/icon.png"></head></html>"#;
    assert_eq!(
        parse_favicon(html, "https://example.com/page"),
        Some("https://cdn.example.com/icon.png".to_string()),
        "should resolve protocol-relative favicon URL"
    );
}

// ======================================================================
// parse_description tests
// ======================================================================

#[test]
fn parse_description_from_meta_name() {
    let html = r#"<html><head><meta name="description" content="A nice page"></head></html>"#;
    assert_eq!(
        parse_description(html),
        Some("A nice page".to_string()),
        "should extract description from meta name"
    );
}

#[test]
fn parse_description_from_og_description() {
    let html = r#"<html><head><meta property="og:description" content="OG desc"></head></html>"#;
    assert_eq!(
        parse_description(html),
        Some("OG desc".to_string()),
        "should extract description from og:description"
    );
}

#[test]
fn parse_description_og_preferred_over_meta_name() {
    let html = r#"<html><head>
        <meta name="description" content="Plain desc">
        <meta property="og:description" content="OG desc">
    </head></html>"#;
    assert_eq!(
        parse_description(html),
        Some("OG desc".to_string()),
        "og:description should be preferred over meta name"
    );
}

#[test]
fn parse_description_missing_returns_none() {
    let html = "<html><head></head></html>";
    assert_eq!(
        parse_description(html),
        None,
        "should return None when no description found"
    );
}

#[test]
fn parse_description_truncates_to_300_chars() {
    let long_desc = "b".repeat(400);
    let html =
        format!(r#"<html><head><meta name="description" content="{long_desc}"></head></html>"#);
    let result = parse_description(&html).unwrap();
    assert_eq!(
        result.len(),
        300,
        "should truncate description to 300 chars"
    );
}

// ======================================================================
// truncate_str tests (L-91)
//
// `truncate_str` must truncate by `char` count, not byte count. The old
// implementation used `s.len() <= max_chars` (a byte comparison) and a
// byte-indexed `is_char_boundary` walk-back, which over-truncated CJK
// (3 bytes/char) and emoji (4 bytes/char) input by ~3x and ~4x
// respectively. These tests pin the new char-based contract.
// ======================================================================

#[test]
fn truncate_str_ascii_shorter_than_max() {
    // Input shorter than the limit is returned unchanged.
    assert_eq!(truncate_str("hello", 10), "hello");
}

#[test]
fn truncate_str_ascii_exact_max() {
    // Input exactly at the limit is returned unchanged (the (max+1)th
    // char does not exist, so `char_indices().nth(max_chars)` is None).
    assert_eq!(truncate_str("hello", 5), "hello");
}

#[test]
fn truncate_str_ascii_longer_than_max() {
    // ASCII: bytes == chars, so the result is exactly `max_chars` bytes.
    let out = truncate_str("hello world", 5);
    assert_eq!(out, "hello");
    assert_eq!(out.len(), 5);
    assert_eq!(out.chars().count(), 5);
}

#[test]
fn truncate_str_cjk_within_max_chars_returns_full() {
    // 5 CJK characters = 15 bytes in UTF-8. With max_chars=10, the new
    // (char-based) contract returns the full string. The old byte-based
    // implementation incorrectly trimmed it (15 > 10).
    let s = "你好世界！"; // 5 chars, 15 bytes
    assert_eq!(s.chars().count(), 5);
    assert_eq!(s.len(), 15);
    let out = truncate_str(s, 10);
    assert_eq!(out, s, "5-char CJK input must survive max_chars=10");
    assert_eq!(out.chars().count(), 5);
}

#[test]
fn truncate_str_cjk_exceeds_max_chars() {
    // 5 CJK chars truncated to 3 chars: result is 3 chars / 9 bytes,
    // and remains a valid UTF-8 slice (truncation lands on a char
    // boundary because `char_indices()` only yields boundaries).
    let s = "你好世界！"; // 5 chars
    let out = truncate_str(s, 3);
    assert_eq!(out.chars().count(), 3);
    assert_eq!(out.len(), 9, "3 CJK chars = 9 bytes");
    assert_eq!(out, "你好世");
}

#[test]
fn truncate_str_mixed_ascii_and_emoji() {
    // "Hi 👋👋👋" = 'H', 'i', ' ', '👋', '👋', '👋' (6 chars).
    // Each 👋 is U+1F44B → 4 bytes in UTF-8.
    // max_chars=4 must yield "Hi 👋" (4 chars, 3 ASCII bytes + 4 emoji
    // bytes = 7 bytes), not a mid-codepoint slice.
    let s = "Hi 👋👋👋";
    assert_eq!(s.chars().count(), 6);
    let out = truncate_str(s, 4);
    assert_eq!(out.chars().count(), 4);
    assert_eq!(out, "Hi 👋");
    // Sanity: confirm the slice is on a UTF-8 boundary (str::is_char_boundary
    // is implicit in any successful &str slice — but we check end-of-slice
    // here to make the contract explicit).
    assert!(s.is_char_boundary(out.len()));
}

#[test]
fn truncate_str_empty_string() {
    // Empty input returns empty regardless of max_chars.
    assert_eq!(truncate_str("", 10), "");
}

#[test]
fn truncate_str_zero_max_chars() {
    // max_chars=0: `char_indices().nth(0)` is the byte index of the
    // first character (0), so we slice `&s[..0]` = "".
    assert_eq!(truncate_str("hello", 0), "");
    assert_eq!(truncate_str("你好", 0), "");
}

// ======================================================================
// detect_auth_required tests
// ======================================================================

#[test]
fn detect_auth_401_status() {
    assert!(
        detect_auth_required(401, "https://example.com", "https://example.com", ""),
        "401 status should indicate auth required"
    );
}

#[test]
fn detect_auth_403_status() {
    assert!(
        detect_auth_required(403, "https://example.com", "https://example.com", ""),
        "403 status should indicate auth required"
    );
}

#[test]
fn detect_auth_redirect_different_domain_with_password() {
    let body = r#"<html><body><form><input type="password" name="pass"></form></body></html>"#;
    assert!(
        detect_auth_required(
            200,
            "https://app.example.com",
            "https://login.example.org",
            body
        ),
        "redirect to different domain with password input should indicate auth"
    );
}

#[test]
fn detect_auth_redirect_same_domain_with_password_not_auth() {
    let body = r#"<html><body><form><input type="password" name="pass"></form></body></html>"#;
    assert!(
        !detect_auth_required(200, "https://example.com", "https://example.com", body),
        "same domain with password input should NOT indicate auth"
    );
}

#[test]
fn detect_auth_small_page_meta_refresh_different_domain() {
    let body = r#"<html><head><meta http-equiv="refresh" content="0;url=https://sso.example.org/login"><title>Redirecting</title></head></html>"#;
    assert!(
        detect_auth_required(
            200,
            "https://app.example.com",
            "https://app.example.com",
            body
        ),
        "small page with meta refresh to different domain should indicate auth"
    );
}

#[test]
fn detect_auth_title_sign_in() {
    let body = "<html><head><title>Sign in to your account</title></head></html>";
    assert!(
        detect_auth_required(200, "https://example.com", "https://example.com", body),
        "title with 'Sign in' should indicate auth"
    );
}

#[test]
fn detect_auth_title_log_in() {
    let body = "<html><head><title>Log in</title></head></html>";
    assert!(
        detect_auth_required(200, "https://example.com", "https://example.com", body),
        "title with 'Log in' should indicate auth"
    );
}

#[test]
fn detect_auth_title_access_denied() {
    let body = "<html><head><title>Access Denied</title></head></html>";
    assert!(
        detect_auth_required(200, "https://example.com", "https://example.com", body),
        "title with 'Access Denied' should indicate auth"
    );
}

#[test]
fn detect_auth_normal_page_returns_false() {
    let body = "<html><head><title>My Blog Post</title></head><body><p>Content</p></body></html>";
    assert!(
        !detect_auth_required(200, "https://example.com", "https://example.com", body),
        "normal page should not indicate auth"
    );
}

// ======================================================================
// DB operations tests
// ======================================================================

#[tokio::test]
async fn upsert_and_get_cached_round_trip() {
    let (pool, _dir) = test_pool().await;

    let meta = LinkMetadata {
        url: "https://example.com".to_string(),
        title: Some("Example".to_string()),
        favicon_url: Some("https://example.com/favicon.ico".to_string()),
        description: Some("An example page".to_string()),
        fetched_at: "2025-01-15T12:00:00.000Z".to_string(),
        auth_required: false,
    };

    upsert(&pool, &meta).await.unwrap();

    let cached = get_cached(&pool, "https://example.com")
        .await
        .unwrap()
        .expect("should find cached metadata");

    assert_eq!(cached.url, "https://example.com", "URL should match");
    assert_eq!(
        cached.title.as_deref(),
        Some("Example"),
        "title should match"
    );
    assert_eq!(
        cached.favicon_url.as_deref(),
        Some("https://example.com/favicon.ico"),
        "favicon should match"
    );
    assert_eq!(
        cached.description.as_deref(),
        Some("An example page"),
        "description should match"
    );
    assert_eq!(
        cached.fetched_at, "2025-01-15T12:00:00.000Z",
        "fetched_at should match"
    );
    assert!(!cached.auth_required, "auth_required should be false");
}

#[tokio::test]
async fn get_cached_returns_none_for_missing_url() {
    let (pool, _dir) = test_pool().await;

    let cached = get_cached(&pool, "https://nonexistent.example.com")
        .await
        .unwrap();

    assert!(cached.is_none(), "should return None for missing URL");
}

#[tokio::test]
async fn upsert_replaces_existing_entry() {
    let (pool, _dir) = test_pool().await;

    let meta1 = LinkMetadata {
        url: "https://example.com".to_string(),
        title: Some("Old Title".to_string()),
        favicon_url: None,
        description: None,
        fetched_at: "2025-01-15T12:00:00.000Z".to_string(),
        auth_required: false,
    };
    upsert(&pool, &meta1).await.unwrap();

    let meta2 = LinkMetadata {
        url: "https://example.com".to_string(),
        title: Some("New Title".to_string()),
        favicon_url: Some("https://example.com/icon.png".to_string()),
        description: Some("Updated description".to_string()),
        fetched_at: "2025-01-16T12:00:00.000Z".to_string(),
        auth_required: true,
    };
    upsert(&pool, &meta2).await.unwrap();

    let cached = get_cached(&pool, "https://example.com")
        .await
        .unwrap()
        .expect("should find updated metadata");

    assert_eq!(
        cached.title.as_deref(),
        Some("New Title"),
        "title should be updated"
    );
    assert!(
        cached.auth_required,
        "auth_required should be updated to true"
    );
}

#[tokio::test]
async fn cleanup_stale_removes_old_non_auth_entries() {
    let (pool, _dir) = test_pool().await;

    // Insert an old entry (60 days ago)
    let old_ts = (chrono::Utc::now() - chrono::Duration::days(60))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let old_meta = LinkMetadata {
        url: "https://old.example.com".to_string(),
        title: Some("Old".to_string()),
        favicon_url: None,
        description: None,
        fetched_at: old_ts,
        auth_required: false,
    };
    upsert(&pool, &old_meta).await.unwrap();

    // Insert a fresh entry
    let fresh_meta = LinkMetadata {
        url: "https://fresh.example.com".to_string(),
        title: Some("Fresh".to_string()),
        favicon_url: None,
        description: None,
        fetched_at: now_rfc3339(),
        auth_required: false,
    };
    upsert(&pool, &fresh_meta).await.unwrap();

    // Insert an old auth entry (should NOT be cleaned up)
    let old_auth_ts = (chrono::Utc::now() - chrono::Duration::days(60))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let old_auth = LinkMetadata {
        url: "https://auth.example.com".to_string(),
        title: Some("Auth".to_string()),
        favicon_url: None,
        description: None,
        fetched_at: old_auth_ts,
        auth_required: true,
    };
    upsert(&pool, &old_auth).await.unwrap();

    let deleted = cleanup_stale(&pool, 30).await.unwrap();
    assert_eq!(deleted, 1, "should delete exactly 1 stale non-auth entry");

    // Verify which entries remain
    let old_gone = get_cached(&pool, "https://old.example.com").await.unwrap();
    assert!(old_gone.is_none(), "old non-auth entry should be deleted");

    let fresh_still = get_cached(&pool, "https://fresh.example.com")
        .await
        .unwrap();
    assert!(fresh_still.is_some(), "fresh entry should still exist");

    let auth_still = get_cached(&pool, "https://auth.example.com").await.unwrap();
    assert!(auth_still.is_some(), "old auth entry should still exist");
}

#[tokio::test]
async fn clear_auth_flag_resets_flag() {
    let (pool, _dir) = test_pool().await;

    let meta = LinkMetadata {
        url: "https://auth.example.com".to_string(),
        title: Some("Auth Page".to_string()),
        favicon_url: None,
        description: None,
        fetched_at: "2025-01-15T12:00:00.000Z".to_string(),
        auth_required: true,
    };
    upsert(&pool, &meta).await.unwrap();

    clear_auth_flag(&pool, "https://auth.example.com")
        .await
        .unwrap();

    let cached = get_cached(&pool, "https://auth.example.com")
        .await
        .unwrap()
        .expect("should find metadata after clearing auth flag");

    assert!(
        !cached.auth_required,
        "auth_required should be false after clear"
    );
    assert_ne!(
        cached.fetched_at, "2025-01-15T12:00:00.000Z",
        "fetched_at should be updated after clearing auth flag"
    );
}

#[tokio::test]
async fn upsert_with_auth_required_true() {
    let (pool, _dir) = test_pool().await;

    let meta = LinkMetadata {
        url: "https://private.example.com".to_string(),
        title: None,
        favicon_url: None,
        description: None,
        fetched_at: "2025-01-15T12:00:00.000Z".to_string(),
        auth_required: true,
    };
    upsert(&pool, &meta).await.unwrap();

    let cached = get_cached(&pool, "https://private.example.com")
        .await
        .unwrap()
        .expect("should find auth metadata");

    assert!(cached.auth_required, "auth_required should be true");
}

// ======================================================================
// Internal helper tests
// ======================================================================

#[test]
fn extract_origin_parses_correctly() {
    assert_eq!(
        extract_origin("https://example.com/path/page"),
        Some("https://example.com".to_string()),
        "should extract origin from URL"
    );
    assert_eq!(
        extract_origin("http://localhost:3000/page"),
        Some("http://localhost:3000".to_string()),
        "should include port in origin"
    );
}

#[test]
fn extract_domain_strips_port() {
    assert_eq!(
        extract_domain("https://example.com:443/page"),
        Some("example.com".to_string()),
        "should strip port from domain"
    );
    assert_eq!(
        extract_domain("https://example.com/page"),
        Some("example.com".to_string()),
        "should extract domain without port"
    );
}

// L-96: `extract_origin` / `extract_domain` must drop `user:pwd@` so
// cached favicon URLs and tracing output never carry credentials.

#[test]
fn extract_origin_strips_userinfo() {
    assert_eq!(
        extract_origin("https://user:pwd@host.com/page"),
        Some("https://host.com".to_string()),
        "userinfo must not appear in the returned origin"
    );
}

#[test]
fn extract_domain_strips_userinfo() {
    assert_eq!(
        extract_domain("https://user:pwd@host.com/page"),
        Some("host.com".to_string()),
        "userinfo must not appear in the returned domain"
    );
}

#[test]
fn extract_origin_handles_no_userinfo() {
    assert_eq!(
        extract_origin("https://host.com/page"),
        Some("https://host.com".to_string()),
        "regression: URLs without userinfo must round-trip unchanged"
    );
}

#[test]
fn extract_domain_handles_no_userinfo() {
    assert_eq!(
        extract_domain("https://host.com/page"),
        Some("host.com".to_string()),
        "regression: URLs without userinfo must round-trip unchanged"
    );
}

#[test]
fn extract_origin_handles_at_in_path() {
    // The `@` is in the path component, not the authority — it must
    // NOT be misread as a userinfo separator.
    assert_eq!(
        extract_origin("https://host.com/path@frag"),
        Some("https://host.com".to_string()),
        "an `@` after the first `/` belongs to the path, not the userinfo"
    );
}

#[test]
fn extract_origin_handles_user_only_no_password() {
    assert_eq!(
        extract_origin("https://user@host.com/"),
        Some("https://host.com".to_string()),
        "username-only userinfo must also be stripped"
    );
}

#[test]
fn extract_origin_preserves_port_when_stripping_userinfo() {
    // Port must survive userinfo stripping, and the rfind(':') used
    // to locate the port colon must not land inside the userinfo.
    assert_eq!(
        extract_origin("https://user:pwd@host.com:8443/page"),
        Some("https://host.com:8443".to_string()),
        "port must be preserved when userinfo is stripped"
    );
}

#[test]
fn extract_domain_preserves_no_port_when_stripping_userinfo() {
    // After userinfo strip, the port-strip block must still see
    // a clean `host:port` and produce a port-free domain.
    assert_eq!(
        extract_domain("https://user:pwd@host.com:8443/page"),
        Some("host.com".to_string()),
        "userinfo + port must both be stripped from the domain"
    );
}

#[test]
fn extract_origin_handles_multiple_at_in_userinfo() {
    // RFC 3986 disallows unencoded `@` in userinfo, but some lenient
    // parsers / pasted URLs include them. `rfind('@')` must select the
    // rightmost `@` so the host is not truncated.
    assert_eq!(
        extract_origin("https://us@er:pwd@host.com/"),
        Some("https://host.com".to_string()),
        "rightmost `@` in the authority delimits userinfo from host"
    );
}

#[test]
fn extract_origin_handles_empty_userinfo() {
    assert_eq!(
        extract_origin("https://@host.com/"),
        Some("https://host.com".to_string()),
        "an empty userinfo (leading `@`) must still strip cleanly"
    );
}

#[test]
fn resolve_url_handles_all_forms() {
    assert_eq!(
        resolve_url("https://example.com/page", "https://other.com/icon.png"),
        "https://other.com/icon.png",
        "absolute URL should be unchanged"
    );
    assert_eq!(
        resolve_url("https://example.com/page", "//cdn.example.com/icon.png"),
        "https://cdn.example.com/icon.png",
        "protocol-relative should inherit scheme"
    );
    assert_eq!(
        resolve_url("https://example.com/page", "/img/icon.png"),
        "https://example.com/img/icon.png",
        "root-relative should resolve against origin"
    );
    assert_eq!(
        resolve_url("https://example.com/path/page", "icon.png"),
        "https://example.com/path/icon.png",
        "relative should resolve against base directory"
    );
}
