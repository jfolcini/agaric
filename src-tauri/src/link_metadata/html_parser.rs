//! Pure HTML parsing and URL resolution for link metadata.
//!
//! All functions are pure: no I/O, no DB access, no `async`. They operate
//! on `&str` inputs and return owned strings or `Option<String>`.

// ---------------------------------------------------------------------------
// Auth-detection heuristics (MAINT-152(c))
// ---------------------------------------------------------------------------
//
// `detect_auth_required` scans the response body for two ladders of fingerprints
// that strongly suggest a login wall: form action paths and title keywords.
// Both ladders used to be hand-unrolled `if … || …` chains; they are now
// data-driven so adding a new heuristic (e.g. `/oauth`, "verify your email")
// is a one-line array push rather than a control-flow edit.

/// Path roots seen on form `action="…"` attributes that indicate the form
/// posts to a login / auth flow. Each base is checked against both the
/// double-quoted (`action="/login`) and single-quoted (`action='/login`)
/// forms inline below.
const AUTH_FORM_ACTION_BASES: &[&str] = &["/login", "/auth", "/signin", "/sso"];

/// Keywords that, when present in a `<title>`, strongly suggest the page
/// is a login wall. Compared against the lowercased title.
const AUTH_TITLE_KEYWORDS: &[&str] = &[
    "sign in",
    "log in",
    "login",
    "authenticate",
    "sso",
    "access denied",
];

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
        // Check for login-related form actions or URL paths.
        // MAINT-152(c): driven by `AUTH_FORM_ACTION_BASES`; each base is
        // matched against both the `"` and `'` quote variants so the
        // heuristic survives templating engines that pick either style.
        if AUTH_FORM_ACTION_BASES.iter().any(|base| {
            body_lower.contains(&format!("action=\"{base}"))
                || body_lower.contains(&format!("action='{base}"))
        }) {
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

    // Title contains auth-related keywords (case-insensitive).
    // MAINT-152(c): driven by `AUTH_TITLE_KEYWORDS` so a new keyword is a
    // one-line array push.
    if let Some(title) = parse_title(body) {
        let title_lower = title.to_lowercase();
        if AUTH_TITLE_KEYWORDS
            .iter()
            .any(|kw| title_lower.contains(kw))
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

/// MAINT-152(f) / 08-MISC-010 — iterate every `<tag …>` element in `html`,
/// calling `f` with the **lowercased** element string (suitable for
/// predicate matching) and the **original-case** element string (suitable
/// for attribute-value extraction). The first `Some(value)` returned by
/// `f` short-circuits and is returned; otherwise `None` once no further
/// `tag_open` literal occurs.
///
/// `tag_open` is the literal opening sequence (e.g. `"<meta "`, `"<link "`)
/// — note the trailing space, which avoids matching `<meta-foo>` etc.
///
/// Behaviour preserved from the previous hand-rolled callers: an unclosed
/// `<tag` (no `>` follows) breaks the scan rather than continuing past it
/// (the find-loop would otherwise spin on the same start). Real-world
/// HTML rarely hits this; mostly-broken HTML produces `None`, which is
/// the right outcome for callers (downstream falls back to defaults).
fn find_first_tag<F, T>(html: &str, tag_open: &str, mut f: F) -> Option<T>
where
    F: FnMut(&str, &str) -> Option<T>,
{
    let lower = html.to_lowercase();
    let mut search_pos = 0;
    while let Some(rel_start) = lower[search_pos..].find(tag_open) {
        let abs_start = search_pos + rel_start;
        let tag_end = match lower[abs_start..].find('>') {
            Some(e) => abs_start + e,
            None => break,
        };
        let tag_lower = &lower[abs_start..=tag_end];
        let tag_orig = &html[abs_start..=tag_end];
        if let Some(v) = f(tag_lower, tag_orig) {
            return Some(v);
        }
        search_pos = tag_end + 1;
    }
    None
}

/// Extract content attribute from `<meta property="name" content="...">`.
fn extract_meta_content(html: &str, property: &str) -> Option<String> {
    let prop_pattern = format!("property=\"{property}\"");
    let prop_pattern_single = format!("property='{property}'");
    find_first_tag(html, "<meta ", |tag_lower, tag_orig| {
        if tag_lower.contains(&prop_pattern) || tag_lower.contains(&prop_pattern_single) {
            extract_attribute_value(tag_orig, "content").map(|c| decode_html_entities(&c))
        } else {
            None
        }
    })
}

/// Extract content from `<meta name="name" content="...">`.
fn extract_meta_name_content(html: &str, name: &str) -> Option<String> {
    let name_pattern = format!("name=\"{name}\"");
    let name_pattern_single = format!("name='{name}'");
    find_first_tag(html, "<meta ", |tag_lower, tag_orig| {
        if tag_lower.contains(&name_pattern) || tag_lower.contains(&name_pattern_single) {
            extract_attribute_value(tag_orig, "content").map(|c| decode_html_entities(&c))
        } else {
            None
        }
    })
}

/// Extract href from `<link rel="icon" href="...">` or `<link rel="shortcut icon" href="...">`.
fn extract_link_icon_href(html: &str) -> Option<String> {
    find_first_tag(html, "<link ", |tag_lower, tag_orig| {
        if tag_lower.contains("rel=\"icon\"")
            || tag_lower.contains("rel='icon'")
            || tag_lower.contains("rel=\"shortcut icon\"")
            || tag_lower.contains("rel='shortcut icon'")
        {
            extract_attribute_value(tag_orig, "href")
        } else {
            None
        }
    })
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
///
/// Made `pub(super)` so the sibling `tests` module
/// (`link_metadata/tests.rs`) can exercise the I-Search-8 quote-stripping
/// regression directly without having to drive a full HTTP fetch.
pub(super) fn extract_meta_refresh_url(html: &str) -> Option<String> {
    find_first_tag(html, "<meta ", |tag_lower, tag_orig| {
        if tag_lower.contains("http-equiv=\"refresh\"")
            || tag_lower.contains("http-equiv='refresh'")
            || tag_lower.contains("http-equiv=refresh")
        {
            // Parse content="0;url=https://..." or content="0; url=https://..."
            let content = extract_attribute_value(tag_orig, "content")?;
            let content_lower = content.to_lowercase();
            let url_pos = content_lower.find("url=")?;
            // I-Search-8: some servers wrap the URL inside quotes within the
            // `content` attribute (e.g. `content="0;url='https://example.com'"`).
            // The outer trim() left the inner quotes; strip them so downstream
            // `extract_domain` and `detect_auth_required` see a clean URL.
            let url = content[url_pos + 4..].trim();
            let url = url
                .trim_start_matches(['\'', '"'])
                .trim_end_matches(['\'', '"']);
            Some(url.to_string())
        } else {
            None
        }
    })
}

/// Strip the userinfo (`user:pwd@`) prefix from a URL authority slice.
///
/// L-96: `extract_origin` / `extract_domain` previously preserved
/// userinfo, surfacing the user's own credentials in cached
/// `link_metadata.favicon_url` rows and tracing output. This helper
/// removes them at the parse step before any caller can persist them.
///
/// The authority proper ends at the first `/`, `?`, or `#`. Userinfo,
/// if present, is everything before the rightmost `@` in that
/// authority slice — splitting on the path/query/fragment delimiters
/// first ensures an `@` that lives in the path (e.g.
/// `https://host/path@frag`) is **not** treated as userinfo.
fn strip_userinfo(authority: &str) -> &str {
    let authority_end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
    let auth_part = &authority[..authority_end];
    if let Some(at_pos) = auth_part.rfind('@') {
        &authority[at_pos + 1..]
    } else {
        authority
    }
}

/// Extract origin (scheme + host + port) from a URL.
pub(super) fn extract_origin(url: &str) -> Option<String> {
    // Find scheme
    let scheme_end = url.find("://")?;
    let rest = &url[scheme_end + 3..];
    // Find end of host (first / or end of string)
    let host_end = rest.find('/').unwrap_or(rest.len());
    let host = &rest[..host_end];
    // L-96: drop any `user:pwd@` so cached favicon URLs and traces
    // never carry the user's credentials.
    let host = strip_userinfo(host);
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
    // L-96: drop any `user:pwd@` before port-stripping so the rfind(':')
    // lookup below cannot land inside the userinfo and so the returned
    // domain never carries credentials.
    let host = strip_userinfo(host);
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

/// Truncate a string to at most `max_chars` Unicode scalar values
/// (`char`s), not bytes. Multibyte input (CJK, emoji) is preserved
/// at the documented character count.
///
/// Made `pub(super)` so the sibling `tests` module (`link_metadata/tests.rs`)
/// can reach it directly without going through `parse_title` /
/// `parse_description` (those wrap it but also do trimming + entity
/// decoding, which would obscure char-counting bugs).
pub(super) fn truncate_str(s: &str, max_chars: usize) -> &str {
    // `char_indices().nth(max_chars)` yields the byte index of the
    // (`max_chars` + 1)th `char` — i.e. the byte position immediately
    // after exactly `max_chars` chars. If the input has fewer chars
    // than `max_chars`, `nth` returns `None` and the input is returned
    // unchanged. Slicing on that byte index always lands on a UTF-8
    // boundary, so this never panics on multibyte input.
    match s.char_indices().nth(max_chars) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    }
}
