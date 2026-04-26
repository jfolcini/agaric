//! Pure HTML parsing and URL resolution for link metadata.
//!
//! All functions are pure: no I/O, no DB access, no `async`. They operate
//! on `&str` inputs and return owned strings or `Option<String>`.

// ---------------------------------------------------------------------------
// Public API (re-exported from `link_metadata::mod`)
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
// Internal helpers (visible to sibling `tests` module for direct testing)
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
pub(super) fn extract_origin(url: &str) -> Option<String> {
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
pub(super) fn extract_domain(url: &str) -> Option<String> {
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
pub(super) fn resolve_url(base: &str, href: &str) -> String {
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
///
/// **Known limitation (I-Search-16):** this is a chained `replace`
/// pipeline, not a single-pass decoder. Inputs that contain entity
/// escapes which themselves decode into another entity sequence
/// (chained / double-escaped entities, e.g. `&amp;lt;` — which is the
/// HTML encoding of the literal four-character text `&lt;`) are
/// **over-decoded**: `&amp;lt;` collapses to `<` because the first
/// `replace` produces `&lt;`, which the next `replace` then decodes
/// again.
///
/// The proper fix is a single decode pass that consumes the source
/// left-to-right and emits the decoded char without re-scanning. Either
/// the `html-escape` or `htmlescape` crate would implement that
/// correctly; neither is currently a dependency of this crate (checked
/// `src-tauri/Cargo.toml`), so we accept the limitation. Real-world
/// `<title>` tags very rarely contain double-escaped entities, and the
/// failure mode is benign (slightly mangled title text, never a panic
/// or security issue).
///
/// See REVIEW-LATER.md item I-Search-16 for the full discussion. The
/// regression test `parse_title_chained_entity_known_limitation` in
/// `link_metadata/tests.rs` pins the current over-decoding behaviour so
/// that a future fix is recognised the moment it lands (the test will
/// start failing and need to be updated).
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
