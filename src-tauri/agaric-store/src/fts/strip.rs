//! Regex patterns and stripping functions for FTS indexing.
//!
//! Contains the regex patterns for markdown formatting and reference resolution,
//! plus the `strip_for_fts_with_maps` (sync, pre-loaded maps) function used to
//! convert raw block content to the text the editor shows, for FTS indexing.

use regex::Regex;
use sqlx::SqlitePool;
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
/// Applies [`MARKUP_RE`] until nothing matches, which strips nested cases
/// like `**bold *italic***`. Plain-text input runs the regex exactly once
/// and is returned as is.
///
/// Iteration is bounded: every replacement strictly shrinks the input
/// (the captured group is always shorter than its surrounding
/// delimiters), so the loop terminates in at most `O(content.len())`
/// iterations. In practice 1-2 iterations cover every realistic
/// nesting depth.
fn strip_inline_markup(content: Shown) -> Shown {
    let mut current = content;
    // Exactly one of groups 1-4 matched; its inner text stays.
    while let Some(next) = current.replace_all(&MARKUP_RE, |caps, _| {
        Replacement::Group((1..=4).find(|&i| caps.get(i).is_some()).unwrap_or(0))
    }) {
        current = next;
    }
    current
}

/// Text the strip produced and, for each of its bytes, the byte range of the
/// raw content that byte shows, so a match in the shown text maps back to
/// the raw content the frontend renders. A byte copied from the content maps
/// to itself; a resolved name (a tag's, a page's, a block ref's first line)
/// has no raw counterpart and maps to the whole token it replaced. Every pass
/// keeps the order of the text, so the ranges never go backwards.
#[derive(Debug, Clone, Default)]
pub(crate) struct Shown {
    pub(crate) text: String,
    origin: Vec<(usize, usize)>,
}

/// What a [`Shown::replace_all`] match becomes.
enum Replacement<'a> {
    /// The capture group's text, which keeps its own origin.
    Group(usize),
    /// New text, which shows the whole match.
    Text(String),
    /// A piece, which keeps the origin it was stored with.
    Piece(&'a Shown),
}

impl Shown {
    /// `text`, a resolved name that shows the raw range `span`.
    fn resolved(text: &str, span: (usize, usize)) -> Shown {
        let mut shown = Shown::default();
        shown.push_str(text, span);
        shown
    }

    fn push_str(&mut self, s: &str, origin: (usize, usize)) {
        self.text.push_str(s);
        self.origin.extend(std::iter::repeat_n(origin, s.len()));
    }

    /// Push `s`, the content's text at byte `at`.
    fn push_verbatim(&mut self, s: &str, at: usize) {
        self.text.push_str(s);
        self.origin.extend((at..at + s.len()).map(|b| (b, b + 1)));
    }

    /// Push `from` over `range`. Callers take `range` from regex matches on
    /// `from.text` (a match, or the gap between two), so it lands on char
    /// boundaries; a range that does not pushes nothing.
    fn push_slice(&mut self, from: &Shown, range: std::ops::Range<usize>) {
        let Some(text) = from.text.get(range.clone()) else {
            return;
        };
        self.text.push_str(text);
        self.origin.extend_from_slice(&from.origin[range]);
    }

    /// The raw-content byte range `range` of the shown text shows. Both ends
    /// land on the content's char boundaries when `range`'s do.
    pub(crate) fn raw_range(&self, range: std::ops::Range<usize>) -> (usize, usize) {
        let origin = &self.origin[range];
        match (origin.first(), origin.last()) {
            (Some(first), Some(last)) => (first.0, last.1),
            _ => (0, 0),
        }
    }

    /// `regex::Regex::replace_all` that carries the origin along; `None`
    /// when nothing matched. `replace` gets each match's captures and the
    /// raw range the match shows.
    fn replace_all<'p>(
        &self,
        re: &Regex,
        mut replace: impl FnMut(&regex::Captures<'_>, (usize, usize)) -> Replacement<'p>,
    ) -> Option<Shown> {
        let mut out: Option<Shown> = None;
        let mut last = 0;
        for caps in re.captures_iter(&self.text) {
            let Some(whole) = caps.get(0) else { continue };
            let out = out.get_or_insert_with(|| Shown {
                text: String::with_capacity(self.text.len()),
                origin: Vec::with_capacity(self.origin.len()),
            });
            out.push_slice(self, last..whole.start());
            let span = self.raw_range(whole.range());
            match replace(&caps, span) {
                Replacement::Group(i) => {
                    if let Some(group) = caps.get(i) {
                        out.push_slice(self, group.range());
                    }
                }
                Replacement::Text(text) => out.push_str(&text, span),
                Replacement::Piece(piece) => out.push_slice(piece, 0..piece.text.len()),
            }
            last = whole.end();
        }
        let mut out = out?;
        out.push_slice(self, last..self.text.len());
        Some(out)
    }
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
    let result = shown_text(content, tag_names, page_titles, block_titles).text;

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

/// The text the editor shows for `content`, mapped back to `content`: what
/// [`strip_for_fts_with_maps`] indexes, before NFC and the cap. Highlighting
/// matches this text and maps each match back (#6795).
pub(crate) fn shown_text(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
    block_titles: &HashMap<String, String>,
) -> Shown {
    let mut pieces = Vec::new();
    let masked = mask_shown_spans(content, block_titles, &mut pieces);
    let result = strip_inline_markup(masked);

    // A resolved name is a piece too, so every placeholder in the text is
    // one this strip wrote.
    let result = result
        .replace_all(&TAG_REF_RE, |caps, span| {
            let name = tag_names.get(&caps[1]).map_or("", String::as_str);
            Replacement::Text(piece(&mut pieces, Shown::resolved(name, span)))
        })
        .unwrap_or(result);

    // A labelled link shows its label (#5160 D9), else the page's title.
    let result = result
        .replace_all(&PAGE_LINK_RE, |caps, span| {
            if crate::cache::page_link_label(caps).is_some() {
                return Replacement::Group(2);
            }
            let title = page_titles.get(&caps[1]).map_or("", String::as_str);
            Replacement::Text(piece(&mut pieces, Shown::resolved(title, span)))
        })
        .unwrap_or(result);
    result
        .replace_all(&PIECE_RE, |caps, _| {
            let index = caps[1].parse::<usize>().ok();
            index
                .and_then(|i| pieces.get(i))
                .map_or(Replacement::Text(String::new()), Replacement::Piece)
        })
        .unwrap_or(result)
}

/// Store `shown` and return the placeholder that stands for it.
fn piece(pieces: &mut Vec<Shown>, shown: Shown) -> String {
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
    pieces: &mut Vec<Shown>,
) -> Shown {
    let mut out = Shown {
        text: String::with_capacity(content.len()),
        origin: Vec::with_capacity(content.len()),
    };
    let mut at = 0;
    while let Some(rest) = content.get(at..) {
        let Some(ch) = rest.chars().next() else {
            break;
        };
        // An escaped pipe shows as `|` and stays bare, so the page-link pass
        // reads a table cell's `[[ULID\|label]]` as the editor's table reader
        // does, label pipes included.
        if rest.starts_with("\\|") {
            out.push_verbatim("|", at + 1);
            at += 2;
            continue;
        }
        let at_line_start = at == 0 || out.text.ends_with('\n');
        let verbatim = |range: std::ops::Range<usize>, len: usize| {
            let mut shown = Shown::default();
            shown.push_verbatim(rest.get(range.clone())?, at + range.start);
            Some((shown, len))
        };
        let span = match ch {
            '~' if at_line_start => tilde_fence(rest).and_then(|(code, len)| verbatim(code, len)),
            '`' => {
                let (code, len) = code_span(rest);
                verbatim(code, len)
            }
            '\\' => rest
                .chars()
                .nth(1)
                .filter(|&next| is_escapable(next))
                .and_then(|next| verbatim(1..1 + next.len_utf8(), 1 + next.len_utf8())),
            '(' => BLOCK_REF_AT_RE.captures(rest).map(|caps| {
                let len = caps[0].len();
                let title = block_titles.get(&caps[1]).map_or("", String::as_str);
                (Shown::resolved(title, (at, at + len)), len)
            }),
            PIECE_OPEN => verbatim(0..PIECE_OPEN.len_utf8(), PIECE_OPEN.len_utf8()),
            _ => None,
        };
        let len = match span {
            Some((shown, len)) => {
                out.push_str(&piece(pieces, shown), (at, at + len));
                len
            }
            None => {
                out.push_verbatim(ch.encode_utf8(&mut [0; 4]), at);
                ch.len_utf8()
            }
        };
        at += len;
    }
    out
}

/// The range of `rest` holding the code a tilde fence at its start, which
/// starts a line, opens, and the bytes the fence takes, as `parseCodeBlock`
/// reads it: a run of three or more `~` closed by a line holding only a run
/// at least as long, plus whitespace. With no closer the fence runs to the
/// end. `None` for a run too short to open one.
fn tilde_fence(rest: &str) -> Option<(std::ops::Range<usize>, usize)> {
    let open = rest.len() - rest.trim_start_matches('~').len();
    if open < 3 {
        return None;
    }
    let mut line_start = rest.find('\n').map_or(rest.len() + 1, |at| at + 1);
    for line in rest.split('\n').skip(1) {
        let after_run = line.trim_start_matches('~');
        if line.len() - after_run.len() >= open && after_run.trim().is_empty() {
            return Some((open..line_start, line_start + line.len()));
        }
        line_start += line.len() + 1;
    }
    Some((open..rest.len(), rest.len()))
}

/// The range of `rest` holding the code a backtick run at its start opens,
/// and the bytes the span takes, as the editor reads it: the next run of
/// exactly as many backticks closes it, on the same line for a code span
/// (`scanCodeSpan` sees one line) and on any later line for a fence of three
/// or more. With no closer, the rest of the line is literal, backticks
/// included.
fn code_span(rest: &str) -> (std::ops::Range<usize>, usize) {
    // Backticks and `\n` are ASCII, so their byte offsets are char boundaries.
    let bytes = rest.as_bytes();
    let run_at = |at: usize| bytes.iter().skip(at).take_while(|&&b| b == b'`').count();
    let open = run_at(0);
    let line_end = rest.find('\n').unwrap_or(rest.len());
    let limit = if open >= 3 { rest.len() } else { line_end };
    let mut at = open;
    while let Some(found) = bytes.iter().take(limit).skip(at).position(|&b| b == b'`') {
        let close_at = at + found;
        let close = run_at(close_at);
        if close == open {
            return (open..close_at, close_at + close);
        }
        at = close_at + close;
    }
    (0..line_end, line_end)
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
    load_ref_maps_for_contents(pool, &[content.as_str()]).await
}

/// [`load_ref_maps_for_block`] for the references in each of `contents`.
pub(crate) async fn load_ref_maps_for_contents(
    pool: &SqlitePool,
    contents: &[&str],
) -> Result<RefMaps, AppError> {
    let tag_ids: Vec<&str> = contents
        .iter()
        .flat_map(|content| TAG_REF_RE.captures_iter(content))
        .map(|cap| cap.extract::<1>().1[0])
        .collect();
    let tag_names = load_live_contents(pool, &tag_ids, "tag").await?;
    let page_ids: Vec<&str> = contents
        .iter()
        .flat_map(|content| PAGE_LINK_RE.captures_iter(content))
        .filter_map(|cap| cap.get(1).map(|id| id.as_str()))
        .collect();
    let page_titles = load_live_contents(pool, &page_ids, "page").await?;
    let block_titles = load_block_ref_titles(pool, contents.iter().copied()).await?;
    Ok((tag_names, page_titles, block_titles))
}

/// The content of each live `block_type` block among `ids`, by id.
async fn load_live_contents(
    pool: &SqlitePool,
    ids: &[&str],
    block_type: &str,
) -> Result<HashMap<String, String>, AppError> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids_json = serde_json::to_string(ids)?;
    Ok(sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, content FROM blocks \
         WHERE id IN (SELECT value FROM json_each(?1)) \
         AND block_type = ?2 AND deleted_at IS NULL",
    )
    .bind(&ids_json)
    .bind(block_type)
    .fetch_all(pool)
    .await?
    .into_iter()
    .filter_map(|(id, content)| content.map(|c| (id, c)))
    .collect())
}

#[cfg(test)]
#[path = "strip_tests.rs"]
mod tests;
