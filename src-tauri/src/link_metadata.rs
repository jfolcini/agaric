//! UX-165: Link metadata fetching and caching.
//!
//! Fetches `<title>`, favicon URL, and description from external URLs,
//! stores them in a local SQLite cache (`link_metadata` table) that is
//! NOT synced between devices. Each device fetches independently.

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::now_rfc3339;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Type)]
pub struct LinkMetadata {
    pub url: String,
    pub title: Option<String>,
    pub favicon_url: Option<String>,
    pub description: Option<String>,
    pub fetched_at: String,
    pub auth_required: bool,
}

// ---------------------------------------------------------------------------
// HTML Parsing (pure functions, no IO)
// ---------------------------------------------------------------------------

/// Extract a page title from HTML.
///
/// Prefers `<meta property="og:title" content="...">` over `<title>...</title>`.
/// Returns `None` if neither is found. Result is trimmed and capped at 500 chars.
pub fn parse_title(html: &str) -> Option<String> {
    let og_title = extract_meta_content(html, "og:title");
    let title_tag = extract_title_tag(html);

    let raw = og_title.or(title_tag)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_str(trimmed, 500).to_string())
}

/// Extract favicon URL from HTML.
///
/// Looks for `<link rel="icon" href="...">` or `<link rel="shortcut icon" href="...">`.
/// Resolves relative URLs against `base_url`. Falls back to `{origin}/favicon.ico`.
pub fn parse_favicon(html: &str, base_url: &str) -> Option<String> {
    let href = extract_link_icon_href(html);

    if let Some(href) = href {
        let resolved = resolve_url(base_url, &href);
        return Some(resolved);
    }

    // Fallback: {origin}/favicon.ico
    extract_origin(base_url).map(|origin| format!("{origin}/favicon.ico"))
}

/// Extract description from HTML.
///
/// Prefers `<meta property="og:description" content="...">` over
/// `<meta name="description" content="...">`. Capped at 300 chars.
pub fn parse_description(html: &str) -> Option<String> {
    let og_desc = extract_meta_content(html, "og:description");
    let meta_desc = extract_meta_name_content(html, "description");

    let raw = og_desc.or(meta_desc)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_str(trimmed, 300).to_string())
}

// ---------------------------------------------------------------------------
// Auth detection
// ---------------------------------------------------------------------------

/// Heuristically detect whether a URL requires authentication.
pub fn detect_auth_required(status: u16, original_url: &str, final_url: &str, body: &str) -> bool {
    // 401/403 status
    if status == 401 || status == 403 {
        return true;
    }

    let original_domain = extract_domain(original_url).unwrap_or_default();
    let final_domain = extract_domain(final_url).unwrap_or_default();

    // Redirect to different domain + password input or login-related action/path
    if !original_domain.is_empty() && !final_domain.is_empty() && original_domain != final_domain {
        let body_lower = body.to_lowercase();
        if body_lower.contains("<input type=\"password\"")
            || body_lower.contains("<input type='password'")
        {
            return true;
        }
        // Check for login-related form actions or URL paths
        if body_lower.contains("action=\"/login")
            || body_lower.contains("action='/login")
            || body_lower.contains("action=\"/auth")
            || body_lower.contains("action='/auth")
            || body_lower.contains("action=\"/signin")
            || body_lower.contains("action='/signin")
            || body_lower.contains("action=\"/sso")
            || body_lower.contains("action='/sso")
        {
            return true;
        }
    }

    // Body < 5KB + meta http-equiv="refresh" pointing to different domain
    if body.len() < 5 * 1024 {
        let body_lower = body.to_lowercase();
        if body_lower.contains("<meta http-equiv=\"refresh\"")
            || body_lower.contains("<meta http-equiv='refresh'")
            || body_lower.contains("<meta http-equiv=refresh")
        {
            // Check if the refresh URL points to a different domain
            if let Some(refresh_url) = extract_meta_refresh_url(body) {
                let refresh_domain = extract_domain(&refresh_url).unwrap_or_default();
                if !refresh_domain.is_empty()
                    && !original_domain.is_empty()
                    && refresh_domain != original_domain
                {
                    return true;
                }
            }
        }
    }

    // Title contains auth-related keywords (case-insensitive)
    if let Some(title) = parse_title(body) {
        let title_lower = title.to_lowercase();
        if title_lower.contains("sign in")
            || title_lower.contains("log in")
            || title_lower.contains("login")
            || title_lower.contains("authenticate")
            || title_lower.contains("sso")
            || title_lower.contains("access denied")
        {
            return true;
        }
    }

    false
}

// ---------------------------------------------------------------------------
// HTTP fetching
// ---------------------------------------------------------------------------

/// Maximum response body size (512 KB).
const MAX_BODY_SIZE: usize = 512 * 1024;

/// Fetch metadata for a URL by downloading the page and parsing HTML.
pub async fn fetch_metadata(url: &str) -> Result<LinkMetadata, AppError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent("Agaric/1.0")
        .build()
        .map_err(|e| AppError::InvalidOperation(format!("HTTP client error: {e}")))?;

    let response =
        client.get(url).send().await.map_err(|e| {
            AppError::InvalidOperation(format!("Network error fetching {url}: {e}"))
        })?;

    let status = response.status().as_u16();
    let final_url = response.url().to_string();

    // Check Content-Type — only fetch text/html
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_lowercase();

    let mime_type = content_type.split(';').next().unwrap_or("");

    if !mime_type.contains("text/html")
        && !mime_type.contains("text/xhtml")
        && !mime_type.contains("application/xhtml")
    {
        // Not HTML — return minimal metadata with no parsed fields
        return Ok(LinkMetadata {
            url: url.to_string(),
            title: None,
            favicon_url: parse_favicon("", url),
            description: None,
            fetched_at: now_rfc3339(),
            auth_required: status == 401 || status == 403,
        });
    }

    // Read body with size limit
    let body = read_body_limited(response, MAX_BODY_SIZE)
        .await
        .map_err(|e| {
            AppError::InvalidOperation(format!("Network error reading body from {url}: {e}"))
        })?;

    let title = parse_title(&body);
    let favicon_url = parse_favicon(&body, url);
    let description = parse_description(&body);
    let auth_required = detect_auth_required(status, url, &final_url, &body);

    Ok(LinkMetadata {
        url: url.to_string(),
        title,
        favicon_url,
        description,
        fetched_at: now_rfc3339(),
        auth_required,
    })
}

/// Read a response body up to `max_bytes`, discarding excess.
async fn read_body_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, reqwest::Error> {
    let bytes = response.bytes().await?;
    let truncated = if bytes.len() > max_bytes {
        &bytes[..max_bytes]
    } else {
        &bytes
    };
    Ok(String::from_utf8_lossy(truncated).into_owned())
}

// ---------------------------------------------------------------------------
// DB operations (runtime queries, NOT compile-time macros)
// ---------------------------------------------------------------------------

/// Retrieve cached metadata for a URL.
pub async fn get_cached(pool: &SqlitePool, url: &str) -> Result<Option<LinkMetadata>, AppError> {
    let row = sqlx::query_as::<_, LinkMetadataRow>(
        "SELECT url, title, favicon_url, description, fetched_at, auth_required \
         FROM link_metadata WHERE url = ?",
    )
    .bind(url)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(Into::into))
}

/// Insert or replace cached metadata for a URL.
pub async fn upsert(pool: &SqlitePool, meta: &LinkMetadata) -> Result<(), AppError> {
    let auth_flag: i32 = if meta.auth_required { 1 } else { 0 };
    sqlx::query(
        "INSERT OR REPLACE INTO link_metadata \
         (url, title, favicon_url, description, fetched_at, auth_required) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&meta.url)
    .bind(&meta.title)
    .bind(&meta.favicon_url)
    .bind(&meta.description)
    .bind(&meta.fetched_at)
    .bind(auth_flag)
    .execute(pool)
    .await?;

    Ok(())
}

/// Clear the `auth_required` flag for a URL and update `fetched_at` to now.
pub async fn clear_auth_flag(pool: &SqlitePool, url: &str) -> Result<(), AppError> {
    let now = now_rfc3339();
    sqlx::query("UPDATE link_metadata SET auth_required = 0, fetched_at = ? WHERE url = ?")
        .bind(&now)
        .bind(url)
        .execute(pool)
        .await?;

    Ok(())
}

/// Delete stale non-auth entries older than `max_age_days`.
/// Returns the number of rows deleted.
pub async fn cleanup_stale(pool: &SqlitePool, max_age_days: u32) -> Result<u64, AppError> {
    let cutoff = chrono::Utc::now() - chrono::Duration::days(i64::from(max_age_days));
    let cutoff_str = cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    let result =
        sqlx::query("DELETE FROM link_metadata WHERE auth_required = 0 AND fetched_at < ?")
            .bind(&cutoff_str)
            .execute(pool)
            .await?;

    Ok(result.rows_affected())
}

// ---------------------------------------------------------------------------
// Internal DB row type
// ---------------------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
struct LinkMetadataRow {
    url: String,
    title: Option<String>,
    favicon_url: Option<String>,
    description: Option<String>,
    fetched_at: String,
    auth_required: i32,
}

impl From<LinkMetadataRow> for LinkMetadata {
    fn from(row: LinkMetadataRow) -> Self {
        Self {
            url: row.url,
            title: row.title,
            favicon_url: row.favicon_url,
            description: row.description,
            fetched_at: row.fetched_at,
            auth_required: row.auth_required != 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Internal parsing helpers
// ---------------------------------------------------------------------------

/// Extract content from `<title>...</title>`.
fn extract_title_tag(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let after_tag = lower[start..].find('>')?;
    let content_start = start + after_tag + 1;
    let end = lower[content_start..].find("</title>")?;
    let content = &html[content_start..content_start + end];
    let decoded = decode_html_entities(content);
    if decoded.trim().is_empty() {
        None
    } else {
        Some(decoded)
    }
}

/// Extract content attribute from `<meta property="name" content="...">`.
fn extract_meta_content(html: &str, property: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let prop_pattern = format!("property=\"{property}\"");
    let prop_pattern_single = format!("property='{property}'");

    // Search for all <meta tags and find one with the right property
    let mut search_pos = 0;
    while let Some(meta_start) = lower[search_pos..].find("<meta ") {
        let abs_start = search_pos + meta_start;
        let tag_end = match lower[abs_start..].find('>') {
            Some(e) => abs_start + e,
            None => break,
        };
        let tag = &lower[abs_start..=tag_end];

        if tag.contains(&prop_pattern) || tag.contains(&prop_pattern_single) {
            // Extract content attribute from original case HTML
            let orig_tag = &html[abs_start..=tag_end];
            if let Some(content) = extract_attribute_value(orig_tag, "content") {
                let decoded = decode_html_entities(&content);
                return Some(decoded);
            }
        }
        search_pos = tag_end + 1;
    }
    None
}

/// Extract content from `<meta name="name" content="...">`.
fn extract_meta_name_content(html: &str, name: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let name_pattern = format!("name=\"{name}\"");
    let name_pattern_single = format!("name='{name}'");

    let mut search_pos = 0;
    while let Some(meta_start) = lower[search_pos..].find("<meta ") {
        let abs_start = search_pos + meta_start;
        let tag_end = match lower[abs_start..].find('>') {
            Some(e) => abs_start + e,
            None => break,
        };
        let tag = &lower[abs_start..=tag_end];

        if tag.contains(&name_pattern) || tag.contains(&name_pattern_single) {
            let orig_tag = &html[abs_start..=tag_end];
            if let Some(content) = extract_attribute_value(orig_tag, "content") {
                let decoded = decode_html_entities(&content);
                return Some(decoded);
            }
        }
        search_pos = tag_end + 1;
    }
    None
}

/// Extract href from `<link rel="icon" href="...">` or `<link rel="shortcut icon" href="...">`.
fn extract_link_icon_href(html: &str) -> Option<String> {
    let lower = html.to_lowercase();

    let mut search_pos = 0;
    while let Some(link_start) = lower[search_pos..].find("<link ") {
        let abs_start = search_pos + link_start;
        let tag_end = match lower[abs_start..].find('>') {
            Some(e) => abs_start + e,
            None => break,
        };
        let tag = &lower[abs_start..=tag_end];

        // Check for rel="icon" or rel="shortcut icon"
        if tag.contains("rel=\"icon\"")
            || tag.contains("rel='icon'")
            || tag.contains("rel=\"shortcut icon\"")
            || tag.contains("rel='shortcut icon'")
        {
            let orig_tag = &html[abs_start..=tag_end];
            if let Some(href) = extract_attribute_value(orig_tag, "href") {
                return Some(href);
            }
        }
        search_pos = tag_end + 1;
    }
    None
}

/// Extract an attribute value from an HTML tag string.
/// Handles both double and single quoted values.
fn extract_attribute_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let dq_pattern = format!("{attr}=\"");
    let sq_pattern = format!("{attr}='");

    if let Some(pos) = lower.find(&dq_pattern) {
        let val_start = pos + dq_pattern.len();
        if let Some(val_end) = tag[val_start..].find('"') {
            return Some(tag[val_start..val_start + val_end].to_string());
        }
    }
    if let Some(pos) = lower.find(&sq_pattern) {
        let val_start = pos + sq_pattern.len();
        if let Some(val_end) = tag[val_start..].find('\'') {
            return Some(tag[val_start..val_start + val_end].to_string());
        }
    }
    None
}

/// Extract the URL from a `<meta http-equiv="refresh" content="0;url=...">` tag.
fn extract_meta_refresh_url(html: &str) -> Option<String> {
    let lower = html.to_lowercase();

    let mut search_pos = 0;
    while let Some(meta_start) = lower[search_pos..].find("<meta ") {
        let abs_start = search_pos + meta_start;
        let tag_end = match lower[abs_start..].find('>') {
            Some(e) => abs_start + e,
            None => break,
        };
        let tag = &lower[abs_start..=tag_end];

        if tag.contains("http-equiv=\"refresh\"")
            || tag.contains("http-equiv='refresh'")
            || tag.contains("http-equiv=refresh")
        {
            let orig_tag = &html[abs_start..=tag_end];
            if let Some(content) = extract_attribute_value(orig_tag, "content") {
                // Parse content="0;url=https://..." or content="0; url=https://..."
                let content_lower = content.to_lowercase();
                if let Some(url_pos) = content_lower.find("url=") {
                    let url = content[url_pos + 4..].trim().to_string();
                    return Some(url);
                }
            }
        }
        search_pos = tag_end + 1;
    }
    None
}

/// Extract origin (scheme + host + port) from a URL.
fn extract_origin(url: &str) -> Option<String> {
    // Find scheme
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    // Find end of host (first / or end of string)
    let host_end = rest.find('/').unwrap_or(rest.len());
    let host = &rest[..host_end];
    if host.is_empty() {
        return None;
    }
    Some(format!("{}://{}", &url[..scheme_end], host))
}

/// Extract domain from a URL (strips port).
fn extract_domain(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    let host = &rest[..host_end];
    // Strip port if present
    let domain = if let Some(colon) = host.rfind(':') {
        // Check if everything after colon is digits (port)
        if host[colon + 1..].chars().all(|c| c.is_ascii_digit()) {
            &host[..colon]
        } else {
            host
        }
    } else {
        host
    };
    if domain.is_empty() {
        None
    } else {
        Some(domain.to_lowercase())
    }
}

/// Resolve a potentially relative URL against a base URL.
fn resolve_url(base: &str, href: &str) -> String {
    // Already absolute
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    // Protocol-relative
    if href.starts_with("//") {
        let scheme = if base.starts_with("https") {
            "https:"
        } else {
            "http:"
        };
        return format!("{scheme}{href}");
    }
    // Root-relative
    if href.starts_with('/') {
        if let Some(origin) = extract_origin(base) {
            return format!("{origin}{href}");
        }
        return href.to_string();
    }
    // Relative path — resolve against base directory
    if let Some(last_slash) = base.rfind('/') {
        format!("{}/{href}", &base[..last_slash])
    } else {
        href.to_string()
    }
}

/// Decode common HTML entities.
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/")
        .replace("&nbsp;", " ")
}

/// Truncate a string to at most `max_chars` characters.
fn truncate_str(s: &str, max_chars: usize) -> &str {
    if s.len() <= max_chars {
        return s;
    }
    // Find a char boundary at or before max_chars
    let mut end = max_chars;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use crate::db::init_pool;

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
        let html = r#"<html><head><link rel="icon" href="https://cdn.example.com/icon.png"></head></html>"#;
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
        let html =
            r#"<html><head><link rel="icon" href="//cdn.example.com/icon.png"></head></html>"#;
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
        let html =
            r#"<html><head><meta property="og:description" content="OG desc"></head></html>"#;
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
        let body =
            "<html><head><title>My Blog Post</title></head><body><p>Content</p></body></html>";
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
}
