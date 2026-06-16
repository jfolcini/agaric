//! Regex patterns and stripping functions for FTS indexing.
//!
//! Contains the regex patterns for markdown formatting and reference resolution,
//! plus the `strip_for_fts_with_maps` (sync, pre-loaded maps) function used to
//! convert raw block content to plain text for FTS indexing.

use regex::Regex;
use sqlx::SqlitePool;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::error::AppError;

// ---------------------------------------------------------------------------
// Regex patterns for stripping
// ---------------------------------------------------------------------------

// Hardcoded regex patterns — compilation cannot fail for these constant strings.

/// PEND-25 L6: combined alternation of the five inline-formatting patterns
/// (bold, italic, code, strikethrough, highlight) in one compiled regex.
///
/// The previous implementation chained five sequential
/// `Regex::replace_all(...).to_string()` calls — five regex compilations,
/// five passes, four intermediate `String` allocations even when the input
/// had no markup at all. This single alternation collapses the five into
/// one compiled regex and one pass per iteration, plus a single `to_string`
/// at the end via [`strip_inline_markup`] that loops until the result is
/// stable to preserve the nested-formatting semantics of the old chain
/// (e.g. `**bold *italic***` → `bold italic`).
///
/// Group numbering — exactly one group matches per match position:
/// 1. bold inner `**(...)**`
/// 2. italic inner `*(...)*`
/// 3. inline-code inner `` `(...)` ``
/// 4. strikethrough inner `~~(...)~~`
/// 5. highlight inner `==(...)==`
///
/// Order matters: bold (`**`) must precede italic (`*`) so the regex
/// engine's leftmost-first alternation prefers the longer delimiter at
/// any given position. The remaining three (code/strike/highlight) have
/// disjoint delimiters so their relative order is irrelevant.
static MARKUP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|~~(.+?)~~|==(.+?)==")
        .expect("invalid combined markup regex")
});

/// Strip inline markup (bold/italic/code/strike/highlight) from `content`.
///
/// Applies [`MARKUP_RE`] iteratively until the result no longer changes,
/// which preserves the semantics of the previous five sequential
/// `replace_all` passes for nested cases like `**bold *italic***`. Each
/// iteration only modifies the string when a match is found
/// (`replace_all` returns `Cow::Borrowed` on no-match), so plain-text
/// input runs the regex exactly once and never allocates.
///
/// Iteration is bounded: every replacement strictly shrinks the input
/// (the captured group is always shorter than its surrounding
/// delimiters), so the loop terminates in at most `O(content.len())`
/// iterations. In practice 1-2 iterations cover every realistic
/// nesting depth.
fn strip_inline_markup(content: &str) -> String {
    let mut current: Cow<'_, str> = Cow::Borrowed(content);
    loop {
        let next = MARKUP_RE.replace_all(&current, |caps: &regex::Captures<'_>| {
            // Exactly one of groups 1-5 matched; return its inner text.
            for i in 1..=5 {
                if let Some(m) = caps.get(i) {
                    return m.as_str().to_owned();
                }
            }
            String::new()
        });
        // No more matches → the regex returns Cow::Borrowed and the
        // pointer/len match `current`. Break to avoid an infinite loop.
        if next.as_ref() == current.as_ref() {
            break;
        }
        current = Cow::Owned(next.into_owned());
    }
    current.into_owned()
}

// MAINT-148e — `TAG_REF_RE` and `PAGE_LINK_RE` were canonicalised in
// `cache::mod` so the cache-rebuild and FTS-strip paths share a single
// regex compilation. The re-exports below preserve this module's public
// names (`crate::fts::TAG_REF_RE` / `crate::fts::PAGE_LINK_RE`) for
// downstream consumers (e.g. `commands::pages::resolve_ulids_for_export`).

/// Matches tag references: `#[ULID]`. Re-exports the canonical regex
/// owned by `crate::cache`.
pub(crate) use crate::cache::TAG_REF_RE;

/// Matches page links: `[[ULID]]`. Re-exports the canonical regex
/// owned by `crate::cache`.
pub(crate) use crate::cache::PAGE_LINK_RE;

// ---------------------------------------------------------------------------
// Strip functions
// ---------------------------------------------------------------------------

/// Strip markdown and resolve references using pre-loaded maps (sync, for batch rebuild).
///
/// `tag_names` maps tag block_id → tag name (content).
/// `page_titles` maps page block_id → page title (content).
/// `block_id` is threaded through solely so [`cap_indexed_text`] can name the
/// offending block in its truncation warning (#1321). It does not affect the
/// stripped output.
pub(crate) fn strip_for_fts_with_maps(
    block_id: &str,
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
) -> String {
    // PEND-25 L6: single combined alternation regex iterated to a fixed
    // point, replaces five sequential `replace_all().to_string()` calls.
    let mut result = strip_inline_markup(content);

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

    // PEND-73 B3 — NFC-normalise the stripped output before it enters
    // the FTS index. macOS volume content tends to land NFD (filename
    // decomposition; copy-paste from Safari can preserve NFD); an NFC
    // query (the default for typed input on most platforms) would
    // otherwise miss NFD-indexed content. The pair to this is the
    // query-time NFC normalisation in `sanitize_fts_query`.
    //
    // #435 — cap the per-block indexed text. `fts_blocks` is a STANDALONE
    // trigram FTS5 table (migration `0006`): it stores `stripped` in a shadow
    // content table AND a trigram index (~3x), so each block's indexed text is
    // duplicated and expanded. Normal blocks are a few KB; a pathological
    // pasted multi-MB block would otherwise be fully trigram-indexed and bloat
    // the index out of proportion on memory-constrained mobile. The cap bounds
    // any single block's contribution — search over its first
    // `FTS_MAX_INDEXED_BYTES` still works, only the tail is unindexed.
    cap_indexed_text(block_id, nfc_normalise(&result))
}

/// #435 — hard cap on per-block FTS-indexed text (bytes). Headroom against a
/// pathological pasted block dominating the standalone trigram index; well
/// above any normal block (a few KB), so only multi-MB outliers are truncated.
/// Any reasonable value works — it bounds the worst case, it is not a measured
/// optimum. (Migration `0006`'s "negligible (<100k blocks)" framing predates
/// this and cannot be edited — migrations are append-only / checksummed.)
const FTS_MAX_INDEXED_BYTES: usize = 128 * 1024;

/// Truncate `s` to at most [`FTS_MAX_INDEXED_BYTES`] on a UTF-8 char boundary.
///
/// #1321 — the cap was previously silent: a multi-MB block was truncated with no
/// log, flag, or signal, so search over the unindexed tail simply missed with no
/// trace of why. Emit a `tracing::warn!` (naming `block_id` and the original vs
/// indexed byte counts) before truncating so the loss is at least observable.
fn cap_indexed_text(block_id: &str, mut s: String) -> String {
    if s.len() <= FTS_MAX_INDEXED_BYTES {
        return s;
    }
    let mut end = FTS_MAX_INDEXED_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    tracing::warn!(
        block_id = block_id,
        original_bytes = s.len(),
        indexed_bytes = end,
        "FTS index truncated: block text exceeds FTS_MAX_INDEXED_BYTES; search over the tail will silently miss"
    );
    s.truncate(end);
    s
}

/// PEND-73 B3 — NFC normalisation helper. Allocates a fresh `String`
/// because `unicode-normalization` returns an iterator; we collect
/// once at the FTS boundary (index-write or query-sanitise). The
/// common case (input already NFC) still re-allocates; the cost is
/// a per-string walk that is dominated by the SQL bind that
/// follows.
pub(crate) fn nfc_normalise(input: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    input.nfc().collect()
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
         WHERE block_type = 'tag' AND deleted_at IS NULL"
    )
    .fetch_all(pool)
    .await?;
    let tag_names: HashMap<String, String> = tag_rows
        .into_iter()
        .filter_map(|r| r.content.map(|c| (r.id, c)))
        .collect();

    let page_rows = sqlx::query!(
        "SELECT id, content FROM blocks \
         WHERE block_type = 'page' AND deleted_at IS NULL"
    )
    .fetch_all(pool)
    .await?;
    let page_titles: HashMap<String, String> = page_rows
        .into_iter()
        .filter_map(|r| r.content.map(|c| (r.id, c)))
        .collect();

    Ok((tag_names, page_titles))
}

/// Load tag-name and page-title maps scoped to ONLY the references that
/// appear in `block_id`'s own content.
///
/// Audit #418 — the per-block `UpdateFtsBlock` path previously called
/// [`load_ref_maps`], which scans every `page` and `tag` block in the vault
/// into a `HashMap` on *every single edited block* (O(pages + tags) per
/// edit). A block only references the handful of tags/pages in its own
/// content, so this extracts those ids (via [`TAG_REF_RE`] / [`PAGE_LINK_RE`],
/// the same patterns `strip_for_fts_with_maps` resolves) and fetches only
/// those rows with the same `deleted_at IS NULL` filter `load_ref_maps`
/// applies — turning two full-table scans into two bounded `id IN (…)` seeks.
///
/// The returned maps plug into [`strip_for_fts_with_maps`] unchanged, so NFC
/// normalisation and conflict-row filtering are preserved. Extracting the ids
/// from the raw content (before markup stripping) yields a superset of the
/// refs the strip pass resolves — markup stripping never removes a `#[ULID]`
/// / `[[ULID]]` token — and a superset is harmless (unused map entries are
/// never looked up).
pub(crate) async fn load_ref_maps_for_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<(HashMap<String, String>, HashMap<String, String>), AppError> {
    let content: Option<String> =
        sqlx::query_scalar!("SELECT content FROM blocks WHERE id = ?", block_id)
            .fetch_optional(pool)
            .await?
            .flatten();
    let Some(content) = content else {
        return Ok((HashMap::new(), HashMap::new()));
    };

    let tag_ids: Vec<String> = TAG_REF_RE
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();
    let tag_names: HashMap<String, String> = if tag_ids.is_empty() {
        HashMap::new()
    } else {
        let ids_json = serde_json::to_string(&tag_ids)?;
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, content FROM blocks \
             WHERE id IN (SELECT value FROM json_each(?1)) \
             AND block_type = 'tag' AND deleted_at IS NULL",
        )
        .bind(&ids_json)
        .fetch_all(pool)
        .await?
        .into_iter()
        .filter_map(|(id, content)| content.map(|c| (id, c)))
        .collect()
    };

    let page_ids: Vec<String> = PAGE_LINK_RE
        .captures_iter(&content)
        .map(|cap| cap[1].to_string())
        .collect();
    let page_titles: HashMap<String, String> = if page_ids.is_empty() {
        HashMap::new()
    } else {
        let ids_json = serde_json::to_string(&page_ids)?;
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT id, content FROM blocks \
             WHERE id IN (SELECT value FROM json_each(?1)) \
             AND block_type = 'page' AND deleted_at IS NULL",
        )
        .bind(&ids_json)
        .fetch_all(pool)
        .await?
        .into_iter()
        .filter_map(|(id, content)| content.map(|c| (id, c)))
        .collect()
    };

    Ok((tag_names, page_titles))
}
