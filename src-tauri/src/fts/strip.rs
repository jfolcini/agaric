//! Regex patterns and stripping functions for FTS indexing.
//!
//! Contains the regex patterns for markdown formatting and reference resolution,
//! plus the `strip_for_fts` (async, DB-backed) and `strip_for_fts_with_maps`
//! (sync, pre-loaded maps) functions used to convert raw block content to plain
//! text for FTS indexing.

use regex::Regex;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Regex patterns for stripping
// ---------------------------------------------------------------------------

// Hardcoded regex patterns — compilation cannot fail for these constant strings.

/// Matches bold markdown: `**text**`
static BOLD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\*(.+?)\*\*").expect("invalid bold regex"));

/// Matches italic markdown: `*text*` (processed AFTER bold)
static ITALIC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*(.+?)\*").expect("invalid italic regex"));

/// Matches inline code: `` `text` ``
static CODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"`(.+?)`").expect("invalid code regex"));

/// Matches strikethrough markdown: `~~text~~`
static STRIKE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"~~(.+?)~~").expect("invalid strikethrough regex"));

/// Matches highlight markdown: `==text==`
static HIGHLIGHT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"==(.+?)==").expect("invalid highlight regex"));

/// Matches tag references: `#[ULID]`
pub(crate) static TAG_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#\[([0-9A-Z]{26})\]").expect("invalid tag ref regex"));

/// Matches page links: `[[ULID]]`
pub(crate) static PAGE_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([0-9A-Z]{26})\]\]").expect("invalid page link regex"));

// ---------------------------------------------------------------------------
// Strip functions
// ---------------------------------------------------------------------------

/// Strip markdown and resolve references using DB lookups.
///
/// 1. Remove bold `**text**` → `text`
/// 2. Remove italic `*text*` → `text` (after bold)
/// 3. Remove inline code `` `text` `` → `text`
/// 4. Replace `#[ULID]` → tag name (or empty string)
/// 5. Replace `[[ULID]]` → page title (or empty string)
/// 6. Unescape backslash sequences: `\*` → `*`, `` \` `` → `` ` ``
pub async fn strip_for_fts(content: &str, pool: &SqlitePool) -> Result<String, AppError> {
    // Steps 1-3: Remove markdown formatting
    let mut result = BOLD_RE.replace_all(content, "$1").to_string();
    result = ITALIC_RE.replace_all(&result, "$1").to_string();
    result = CODE_RE.replace_all(&result, "$1").to_string();
    result = STRIKE_RE.replace_all(&result, "$1").to_string();
    result = HIGHLIGHT_RE.replace_all(&result, "$1").to_string();

    // Step 4: Batch-fetch tag names and replace
    let tag_ids: Vec<String> = TAG_REF_RE
        .captures_iter(&result)
        .map(|cap| cap[1].to_string())
        .collect();

    if !tag_ids.is_empty() {
        let ids_json = serde_json::to_string(&tag_ids)?;
        // Filter `is_conflict = 0` so single-block reindex matches the full
        // rebuild path (`load_ref_maps`). Without this, a `RemoveConflict`
        // resolution would leave conflict-tag content in `fts_blocks` until
        // the next full rebuild. (M-61)
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, content FROM blocks \
             WHERE id IN (SELECT value FROM json_each(?1)) \
             AND block_type = 'tag' AND deleted_at IS NULL AND is_conflict = 0",
        )
        .bind(&ids_json)
        .fetch_all(pool)
        .await?;
        let tag_names: HashMap<String, String> = rows
            .into_iter()
            .filter_map(|(id, content)| content.map(|c| (id, c)))
            .collect();
        result = TAG_REF_RE
            .replace_all(&result, |caps: &regex::Captures| {
                let ulid = &caps[1];
                tag_names.get(ulid).cloned().unwrap_or_default()
            })
            .to_string();
    }

    // Step 5: Batch-fetch page titles and replace
    let page_ids: Vec<String> = PAGE_LINK_RE
        .captures_iter(&result)
        .map(|cap| cap[1].to_string())
        .collect();

    if !page_ids.is_empty() {
        let ids_json = serde_json::to_string(&page_ids)?;
        // Filter `is_conflict = 0` to match the full rebuild path
        // (`load_ref_maps`). See the tag-lookup comment above. (M-61)
        let rows = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, content FROM blocks \
             WHERE id IN (SELECT value FROM json_each(?1)) \
             AND block_type = 'page' AND deleted_at IS NULL AND is_conflict = 0",
        )
        .bind(&ids_json)
        .fetch_all(pool)
        .await?;
        let page_titles: HashMap<String, String> = rows
            .into_iter()
            .filter_map(|(id, content)| content.map(|c| (id, c)))
            .collect();
        result = PAGE_LINK_RE
            .replace_all(&result, |caps: &regex::Captures| {
                let ulid = &caps[1];
                page_titles.get(ulid).cloned().unwrap_or_default()
            })
            .to_string();
    }

    // Step 6: Unescape backslash sequences (\* -> *, \` -> `, \~ -> ~, \= -> =)
    result = result
        .replace("\\*", "*")
        .replace("\\`", "`")
        .replace("\\~", "~")
        .replace("\\=", "=");

    Ok(result)
}

/// Strip markdown and resolve references using pre-loaded maps (sync, for batch rebuild).
///
/// `tag_names` maps tag block_id → tag name (content).
/// `page_titles` maps page block_id → page title (content).
pub(crate) fn strip_for_fts_with_maps(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
) -> String {
    // Steps 1-3: Remove markdown formatting
    let mut result = BOLD_RE.replace_all(content, "$1").to_string();
    result = ITALIC_RE.replace_all(&result, "$1").to_string();
    result = CODE_RE.replace_all(&result, "$1").to_string();
    result = STRIKE_RE.replace_all(&result, "$1").to_string();
    result = HIGHLIGHT_RE.replace_all(&result, "$1").to_string();

    // Step 4: Replace tag references
    result = TAG_REF_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let ulid = &caps[1];
            tag_names.get(ulid).cloned().unwrap_or_default()
        })
        .to_string();

    // Step 5: Replace page links
    result = PAGE_LINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let ulid = &caps[1];
            page_titles.get(ulid).cloned().unwrap_or_default()
        })
        .to_string();

    // Step 6: Unescape backslash sequences (\* -> *, \` -> `, \~ -> ~, \= -> =)
    result = result
        .replace("\\*", "*")
        .replace("\\`", "`")
        .replace("\\~", "~")
        .replace("\\=", "=");

    result
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Load tag name map and page title map for batch FTS processing.
///
/// Returns `(tag_names, page_titles)` HashMaps mapping block_id → content
/// for all active (non-deleted, non-conflict) tag and page blocks.
pub(crate) async fn load_ref_maps(
    pool: &SqlitePool,
) -> Result<(HashMap<String, String>, HashMap<String, String>), AppError> {
    let tag_rows = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE block_type = 'tag' AND deleted_at IS NULL AND is_conflict = 0"
    )
    .fetch_all(pool)
    .await?;
    let tag_names: HashMap<String, String> = tag_rows
        .into_iter()
        .filter_map(|r| r.content.map(|c| (r.id, c)))
        .collect();

    let page_rows = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE block_type = 'page' AND deleted_at IS NULL AND is_conflict = 0"
    )
    .fetch_all(pool)
    .await?;
    let page_titles: HashMap<String, String> = page_rows
        .into_iter()
        .filter_map(|r| r.content.map(|c| (r.id, c)))
        .collect();

    Ok((tag_names, page_titles))
}
