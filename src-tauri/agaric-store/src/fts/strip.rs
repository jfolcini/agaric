//! Regex patterns and stripping functions for FTS indexing.
//!
//! Contains the regex patterns for markdown formatting and reference resolution,
//! plus the `strip_for_fts_with_maps` (sync, pre-loaded maps) function used to
//! convert raw block content to the text the editor shows, for FTS indexing.

use regex::Regex;
use sqlx::SqlitePool;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::LazyLock;

use agaric_core::error::AppError;

// ---------------------------------------------------------------------------
// Regex patterns for stripping
// ---------------------------------------------------------------------------

// Hardcoded regex patterns — compilation cannot fail for these constant strings.

/// Combined alternation of the four inline-formatting patterns
/// (bold, italic, strikethrough, highlight) in one compiled regex. Code
/// never reaches it: [`mask_shown_spans`] takes every backtick first.
///
/// One alternation is one compiled regex and one pass per iteration, plus a
/// single `to_string` at the end via [`strip_inline_markup`], which loops
/// until the result is stable to strip nested formatting
/// (e.g. `**bold *italic***` → `bold italic`).
///
/// Group numbering — exactly one group matches per match position:
/// 1. bold inner `**(...)**`
/// 2. italic inner `*(...)*`
/// 3. strikethrough inner `~~(...)~~`
/// 4. highlight inner `==(...)==`
///
/// Order matters: bold (`**`) must precede italic (`*`) so the regex
/// engine's leftmost-first alternation prefers the longer delimiter at
/// any given position. Strike and highlight have disjoint delimiters so
/// their relative order is irrelevant.
///
/// Strike and highlight need a non-space next to each delimiter: the editor
/// stores a space-flanked `~~` or `==` bare because it cannot be a mark
/// (#5160 N12), so `a == b and c == d` is a comparison, indexed as written.
static MARKUP_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\*\*(.+?)\*\*|\*(.+?)\*|~~(\S(?:.*?\S)?)~~|==(\S(?:.*?\S)?)==")
        .expect("invalid combined markup regex")
});

/// Strip inline markup (bold/italic/strike/highlight) from `content`.
///
/// Applies [`MARKUP_RE`] iteratively until the result no longer changes,
/// which strips nested cases like `**bold *italic***`. Each
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
            // Exactly one of groups 1-4 matched; return its inner text.
            for i in 1..=4 {
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

// `TAG_REF_RE` and `PAGE_LINK_RE` were canonicalised in
// `cache::mod` so the cache-rebuild and FTS-strip paths share a single
// regex compilation. They are imported here for this module's own strip
// functions (below); `commands::pages` references the canonical
// `crate::cache` path directly (#1920), so they are not re-exported at
// the `fts` level.

/// Matches tag references: `#[ULID]`. Re-exports the canonical regex
/// owned by `crate::cache`.
pub(crate) use crate::cache::TAG_REF_RE;

/// Matches page links: `[[ULID]]`. Re-exports the canonical regex
/// owned by `crate::cache`.
pub(crate) use crate::cache::PAGE_LINK_RE;

/// Matches block references: `((ULID))`. Re-exports the canonical regex
/// owned by `crate::cache`.
pub(crate) use crate::cache::BLOCK_REF_RE;

/// Tag names, page titles and block-ref first lines, each keyed by block id:
/// what [`strip_for_fts_with_maps`] resolves `#[ULID]`, `[[ULID]]` and
/// `((ULID))` to.
pub type RefMaps = (
    HashMap<String, String>,
    HashMap<String, String>,
    HashMap<String, String>,
);

// ---------------------------------------------------------------------------
// Strip functions
// ---------------------------------------------------------------------------

/// The text the editor shows for `content`, for the index (#6277 B3).
///
/// First `mask_shown_spans` takes code, backslash escapes and `((ULID))`
/// block refs out of reach; then markup is stripped, `#[ULID]` resolves to
/// its tag's name and `[[ULID]]` to its label, else its page's title; then
/// the masked spans come back.
///
/// `tag_names` maps tag block_id → tag name (content).
/// `page_titles` maps page block_id → page title (content).
/// `block_titles` maps block_id → first line (`load_block_ref_titles`).
/// A token whose target is not in its map strips to `""`.
/// `block_id` is threaded through solely so `cap_indexed_text` can name the
/// offending block in its truncation warning (#1321). It does not affect the
/// stripped output.
// #2945 — widened `pub(crate)` → `pub` so the libFuzzer `fts_strip` harness
// (src-tauri/fuzz/fuzz_targets/fts_strip.rs) can name this directly as
// `agaric_store::fts::strip::strip_for_fts_with_maps`.
pub fn strip_for_fts_with_maps(
    block_id: &str,
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
    block_titles: &HashMap<String, String>,
) -> String {
    let mut pieces = Vec::new();
    let masked = mask_shown_spans(content, block_titles, &mut pieces);
    let result = strip_inline_markup(&masked);

    // A resolved name is a piece too, so every placeholder in the text is
    // one this strip wrote.
    let result = TAG_REF_RE.replace_all(&result, |caps: &regex::Captures| {
        let name = tag_names.get(&caps[1]).cloned().unwrap_or_default();
        piece(&mut pieces, name)
    });

    // A labelled link shows its label (#5160 D9), else the page's title.
    let result = PAGE_LINK_RE.replace_all(&result, |caps: &regex::Captures| {
        match crate::cache::page_link_label(caps) {
            Some(label) => label.to_string(),
            None => {
                let title = page_titles.get(&caps[1]).cloned().unwrap_or_default();
                piece(&mut pieces, title)
            }
        }
    });
    let result = PIECE_RE.replace_all(&result, |caps: &regex::Captures| {
        let index = caps[1].parse::<usize>().ok();
        index.and_then(|i| pieces.get(i)).map_or("", String::as_str)
    });

    // NFC-normalise the stripped output before it enters
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

/// Opens and closes a placeholder, `\u{E002}<index>\u{E003}`, that stands for
/// `pieces[index]` while the markup and reference passes run. U+E000 and
/// U+E001 are the snippet highlight sentinels (`search::SNIPPET_HL_OPEN`).
const PIECE_OPEN: char = '\u{E002}';
const PIECE_CLOSE: char = '\u{E003}';

static PIECE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("\u{E002}([0-9]+)\u{E003}").expect("invalid piece regex"));

/// [`BLOCK_REF_RE`] anchored at the scan position.
static BLOCK_REF_AT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("^(?:{})", BLOCK_REF_RE.as_str())).expect("invalid block-ref regex")
});

/// Store `shown` and return the placeholder that stands for it.
fn piece(pieces: &mut Vec<String>, shown: String) -> String {
    pieces.push(shown);
    format!("{PIECE_OPEN}{}{PIECE_CLOSE}", pieces.len() - 1)
}

/// `content` with each span whose shown text no later pass may touch replaced
/// by a placeholder for that text, scanned left to right in the editor's
/// order (`parseLine`, `src/editor/markdown-parse/parser.ts`): code
/// ([`code_span`]), then a backslash escape, then a `((ULID))` block ref,
/// shown as its target's first line. A placeholder opener already in the text
/// is a piece too, so it cannot be read as one.
fn mask_shown_spans(
    content: &str,
    block_titles: &HashMap<String, String>,
    pieces: &mut Vec<String>,
) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(ch) = rest.chars().next() {
        let span = match ch {
            '`' => Some(code_span(rest)),
            '\\' => rest[1..]
                .chars()
                .next()
                .filter(|&next| is_escapable(next))
                .map(|next| (next.to_string(), 2)),
            '(' => BLOCK_REF_AT_RE.captures(rest).map(|caps| {
                let title = block_titles.get(&caps[1]).cloned().unwrap_or_default();
                (title, caps[0].len())
            }),
            PIECE_OPEN => Some((PIECE_OPEN.to_string(), PIECE_OPEN.len_utf8())),
            _ => None,
        };
        let len = match span {
            Some((shown, len)) => {
                out.push_str(&piece(pieces, shown));
                len
            }
            None => {
                out.push(ch);
                ch.len_utf8()
            }
        };
        rest = &rest[len..];
    }
    out
}

/// The code a backtick run at the start of `rest` opens, and the bytes it
/// takes, as `scanCodeSpan` reads it: the next run of exactly as many
/// backticks closes it, across lines too, so a fence is one span. With no
/// closer, the rest of the line is literal, backticks included.
fn code_span(rest: &str) -> (String, usize) {
    let run_at = |at: usize| rest[at..].len() - rest[at..].trim_start_matches('`').len();
    let open = run_at(0);
    let mut at = open;
    while let Some(found) = rest[at..].find('`') {
        let close_at = at + found;
        let close = run_at(close_at);
        if close == open {
            return (rest[open..close_at].to_owned(), close_at + close);
        }
        at = close_at + close;
    }
    let line_end = rest.find('\n').unwrap_or(rest.len());
    (rest[..line_end].to_owned(), line_end)
}

/// The chars a backslash escapes, as the editor's `isEscapableChar` reads
/// them: ASCII punctuation, a digit, a space or a tab.
fn is_escapable(c: char) -> bool {
    c.is_ascii_punctuation() || c.is_ascii_digit() || c == ' ' || c == '\t'
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

// NFC normalisation helper moved into `agaric-core` (#2621). Re-exported
// here so existing `crate::fts::strip::nfc_normalise` call sites (this
// module, `fts::search::sanitizer`, `fts::toggle_filter`) resolve unchanged.
pub(crate) use agaric_core::text_utils::nfc_normalise;

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

/// The first line of each block a `((ULID))` in `contents` names: the text its
/// chip shows, whole, without a trailing `\r` (#6277 B3). There is no
/// `deleted_at` filter, so a soft-deleted target keeps its title as the chip
/// does and its delete or restore owes its referrers nothing. A purged or
/// missing target has no entry and strips to `""`.
///
/// One `json_each` query of primary-key seeks for the whole batch; the SQL
/// cuts the first line, so no body leaves the database.
pub(crate) async fn load_block_ref_titles<'a, 'e, E>(
    executor: E,
    contents: impl IntoIterator<Item = &'a str>,
) -> Result<HashMap<String, String>, AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let ids: Vec<&str> = contents
        .into_iter()
        .flat_map(|content| BLOCK_REF_RE.captures_iter(content))
        .map(|cap| cap.extract::<1>().1[0])
        .collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids_json = serde_json::to_string(&ids)?;
    let rows = sqlx::query!(
        r#"SELECT id AS "id!",
                  substr(content, 1, instr(content || char(10), char(10)) - 1)
                      AS "first_line!: String"
           FROM blocks
           WHERE id IN (SELECT value FROM json_each(?)) AND content IS NOT NULL"#,
        ids_json
    )
    .fetch_all(executor)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let mut first_line = row.first_line;
            if first_line.ends_with('\r') {
                first_line.pop();
            }
            (row.id, first_line)
        })
        .collect())
}

/// Tag names, page titles and block-ref first lines scoped to ONLY the
/// references that appear in `block_id`'s own content.
///
/// Audit #418 — the per-block `UpdateFtsBlock` path previously called
/// `load_ref_maps`, which scans every `page` and `tag` block in the vault
/// into a `HashMap` on *every single edited block* (O(pages + tags) per
/// edit). A block only references the handful of tags/pages in its own
/// content, so this extracts those ids (via [`TAG_REF_RE`] / [`PAGE_LINK_RE`],
/// the same patterns `strip_for_fts_with_maps` resolves) and fetches only
/// those rows with the same `deleted_at IS NULL` filter `load_ref_maps`
/// applies — turning two full-table scans into two bounded `id IN (…)` seeks.
/// The block refs go through `load_block_ref_titles`.
///
/// The returned maps plug into [`strip_for_fts_with_maps`] unchanged, so NFC
/// normalisation and conflict-row filtering are preserved. Extracting the ids
/// from the raw content (before markup stripping) yields a superset of the
/// refs the strip pass resolves — a token inside code or behind an escape is
/// fetched and never looked up — and a superset is harmless.
pub async fn load_ref_maps_for_block(
    pool: &SqlitePool,
    block_id: &str,
) -> Result<RefMaps, AppError> {
    let content: Option<String> =
        sqlx::query_scalar!("SELECT content FROM blocks WHERE id = ?", block_id)
            .fetch_optional(pool)
            .await?
            .flatten();
    let Some(content) = content else {
        return Ok((HashMap::new(), HashMap::new(), HashMap::new()));
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

    let block_titles = load_block_ref_titles(pool, [content.as_str()]).await?;
    Ok((tag_names, page_titles, block_titles))
}
