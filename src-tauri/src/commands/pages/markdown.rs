//! Markdown export / import command handlers (#644 split).
//!
//! `export_page_markdown`, `import_markdown` and their `*_inner` cores plus
//! the progress-streaming import variant and the ULID-resolution helper.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{CommandTx, ReadPool, WriteCtx};
use crate::import::ImportProgressSink;
use crate::materializer::Materializer;
use agaric_core::error::AppError;
use agaric_core::ulid::{BlockId, PageId};
use agaric_engine::import;
use agaric_engine::import::{ImportProgressUpdate, ImportResult, VaultFile};
use agaric_store::pagination::{BlockRow, Cursor, NULL_POSITION_SENTINEL, PageRequest};
use agaric_store::space::SpaceId;

use super::super::*;

/// #662 — minimum number of content blocks written into one import chunk
/// before the import is allowed to flush (commit + release the writer
/// lock) at the next top-level (depth-0) subtree boundary.
///
/// Tuning rationale (see #662): a hard *cap* on import size was rejected
/// because it would break legitimate large imports, and the verified bug
/// is the writer-lock *hold time*, not the row count. A chunk size of 500
/// keeps the common case — the import benches exercise 100 / 1000 / 5000
/// blocks — single-transaction at 100 blocks (preserving the original
/// whole-import atomicity for typical files) while splitting a 5000-block
/// import into ~10 chunks, so the writer lock is released ~10 times mid-
/// import instead of being held throughout. It is a `usize` because it is
/// compared against the per-chunk `chunk_blocks` counter.
///
/// Note this is a *floor*, not a cap: a chunk may exceed it when a single
/// top-level subtree is itself larger than the floor — the subtree is
/// never split, so correctness (no half-written subtree) always wins over
/// the size target.
///
/// `pub(crate)` so chunk-boundary tests can size a multi-chunk import
/// relative to the threshold instead of hardcoding the number.
///
/// #1921 — chunking bounds only the writer-lock *hold time* (it commits +
/// releases the lock periodically); it does NOT bound the per-block
/// sibling-reproject cost incurred when each block is created. That reproject
/// cost is a separate concern tracked on its own and is unaffected by this
/// threshold.
pub const IMPORT_CHUNK_BLOCKS: usize = 500;

/// #2724 — aggregate attachment-budget check for one import.
///
/// Factored out of [`import_markdown_with_progress`] so the caps can be
/// unit-tested against fabricated `(file_count, total_bytes)` pairs WITHOUT
/// allocating gigabytes of `VaultFile` bytes. Returns a clear
/// [`AppError::validation`] when the file COUNT or the aggregate BYTE total
/// exceeds its cap, and `Ok(())` when within budget. `total_bytes` is
/// pre-summed by the caller (as `u64`, to avoid any `usize as i64` wrap on a
/// pathological length). The count check runs first so a huge-count / tiny-byte
/// payload is rejected on the cheaper predicate.
fn check_attachment_budget(file_count: usize, total_bytes: u64) -> Result<(), AppError> {
    if file_count > crate::commands::MAX_ATTACHMENT_FILE_COUNT {
        return Err(AppError::validation(format!(
            "import references {file_count} attachment files, exceeding the maximum of {} \
             per import",
            crate::commands::MAX_ATTACHMENT_FILE_COUNT
        )));
    }
    let cap = crate::commands::MAX_TOTAL_ATTACHMENT_BYTES as u64;
    if total_bytes > cap {
        return Err(AppError::validation(format!(
            "import attachments total {total_bytes} bytes across {file_count} files, exceeding \
             the maximum aggregate of {cap} bytes"
        )));
    }
    Ok(())
}

/// Matches a HUMAN-readable wiki-link token `[[Page Name]]` on import (#1446
/// Part B). The inner capture is the page NAME (any run of characters that is
/// neither `]` nor a newline, non-greedy so `[[A]] [[B]]` matches twice). A
/// token whose body is a canonical 26-char Crockford-base32 ULID is left
/// untouched (it is already an internal `[[ULID]]` ref) — the resolver checks
/// the captured body against [`agaric_store::cache::PAGE_LINK_RE`] before rewriting.
///
/// #1920 — this regex (`\[\[([^\]\n]+?)\]\]`) is the one source of the inbound
/// wiki-link grammar. Import and paste ([`paste_blocks_inner`], #1484) both
/// resolve through it: `[[Page]]` → ULID, create-if-missing, ambiguous
/// duplicate titles stay plain text. `page_link_re_parity_*` pins it over the
/// fixture `conformance/reference-tokens.vectors.json`.
static HUMAN_PAGE_LINK_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"\[\[([^\]\n]+?)\]\]").expect("invalid human page-link regex")
});

/// Matches a HUMAN-readable bare/nested/hyphenated inline tag `#tag` on import
/// (#1924). Group 1 is the leading boundary char (or empty at line start);
/// group 2 is the tag NAME — a run of `[\p{L}\p{N}_]` then
/// `[\p{L}\p{N}\p{M}_/-]*` (Unicode letters/digits/underscore plus combining
/// marks, with `/` and `-` allowed after the first char for nested +
/// hyphenated tags).
///
/// The leading boundary `(^|[^\p{L}\p{N}\p{M}_&\[])` prevents matching
/// `# heading` (the `#` is followed by a space, not a name char), `word#frag`
/// (the `#` is preceded by a word char), and `a#b`. Because the name's FIRST
/// char must be a word char and a canonical `#[ULID]` ref's next char is `[`
/// (not a word char), this regex never matches an already-internal `#[ULID]`
/// token — so canonical refs survive untouched. `&` and `[` are not
/// boundaries either (#5160 N1): `it&#39;s` is an HTML entity and `[#A]` a
/// Logseq priority. The regex is only half the rule; [`is_tag_name`] and
/// [`tag_guard_spans`] are the other half, and every reader applies all three.
///
/// #3367 — the three classes are NOT interchangeable, and the asymmetry is the
/// whole fix. `\p{M}` belongs in the BOUNDARY class and in the name's
/// CONTINUATION class, because a combining mark is part of the grapheme cluster
/// its base char starts: without it the name run stopped at the base letter, so
/// `#café` in NFD (`caf` + `e` + U+0301) minted a tag `cafe` and stranded the
/// acute in the surrounding prose, and `café#tag` in NFD read that acute as a
/// word boundary and spliced a tag into the middle of a word that plain
/// `cafe#tag` is protected from. Not an NFD-only curiosity: Devanagari, Arabic
/// and Hebrew have no precomposed forms at all, so `#हिन्दी` was truncated to
/// `#ह` in ordinary text.
///
/// `\p{M}` deliberately stays OUT of the name's FIRST-char class. A `#`
/// followed directly by a combining mark is itself a grapheme cluster (the mark
/// renders on the `#`), so consuming the `#` as a sigil and the mark as the
/// name's first char would split THAT cluster — the same defect, mirrored. A
/// tag name must start on a base character; marks may only follow one. That
/// also keeps this regex aligned with `neutralize_ref_name` in
/// `inline_query_md.rs`, whose "is this `#` tag-initial?" test is likewise a
/// base-character test.
///
/// `pub(super)` so the sibling `inline_query_md` test that asserts a
/// neutralized ref name cannot re-parse as a tag consumes THIS definition
/// instead of a hand-copied literal — a copy is exactly what let the two drift
/// (#3367).
pub(super) static HUMAN_TAG_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(^|[^\p{L}\p{N}\p{M}_&\[])#([\p{L}\p{N}_][\p{L}\p{N}\p{M}_/-]*)")
            .expect("invalid human inline-tag regex")
    });

/// A bare URL (`scheme://` up to whitespace) or a markdown link destination
/// (`](…)`): a `#` inside either is a fragment, never a tag, and the text is
/// left byte for byte (#5160 N1).
static TAG_GUARD_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"[A-Za-z][A-Za-z0-9+.-]*://\S+|\]\([^)\n]*\)")
        .expect("invalid tag guard regex")
});

/// Whether `#name` names a tag: the name holds a non-digit, so `#42` and `#1`
/// stay text (#5160 N1). The vectors in `reference-tokens.vectors.json` pin
/// it for the mock too.
fn is_tag_name(name: &str) -> bool {
    name.chars().any(|c| !c.is_numeric())
}

/// The byte ranges of `content` no tag token may start in: inline-code spans
/// and the URLs and link destinations of [`TAG_GUARD_RE`].
fn tag_guard_spans(content: &str) -> Vec<(usize, usize)> {
    let mut spans = import::inline_code_spans(content);
    spans.extend(
        TAG_GUARD_RE
            .find_iter(content)
            .map(|m| (m.start(), m.end())),
    );
    spans
}

/// Whether the token at byte `pos` is escaped: an odd run of backslashes
/// before it makes it text, an even run is literal backslashes before a
/// token (#5160 N3).
fn is_escaped(content: &str, pos: usize) -> bool {
    content.as_bytes()[..pos]
        .iter()
        .rev()
        .take_while(|&&b| b == b'\\')
        .count()
        % 2
        == 1
}

/// Whether the `[[…]]` match starting at `start` is a page-link token: outside
/// inline code, not the `#[[tag]]` or `![[embed]]` form, and not escaped.
fn page_link_is_token(content: &str, start: usize, code_spans: &[(usize, usize)]) -> bool {
    !is_in_span(start, code_spans)
        && !content[..start].ends_with(['#', '!'])
        && !is_escaped(content, start)
}

/// Whether the bare `#name` whose name group is `name_m` is a tag token in
/// `content`: its `#` is outside every guarded span and every `[[…]]` token
/// (#2567/#3598: a `#` inside a wiki-link is its anchor or part of its name),
/// it is not escaped, and the name is one.
fn bare_tag_is_token(
    content: &str,
    name_m: regex::Match<'_>,
    guards: &[(usize, usize)],
    link_spans: &[(usize, usize)],
) -> bool {
    let hash_pos = name_m.start() - 1;
    !is_in_span(hash_pos, guards)
        && !is_in_span(hash_pos, link_spans)
        && !is_escaped(content, hash_pos)
        && is_tag_name(name_m.as_str())
}

/// Matches a HUMAN-readable multi-word inline tag `#[[Tag With Space]]` on
/// import (#1950). A `#` immediately followed by a `[[...]]` body. Group 1 is
/// the inner tag name (any run that is neither `]` nor a newline, non-greedy).
/// Distinct from a bare `[[Page]]` wiki-link by the leading `#` — the wiki-link
/// pre-pass skips any `[[...]]` immediately preceded by `#` (see
/// `collect_inbound_page_link_bodies` / `rewrite_inbound_page_links`) so a
/// `#[[...]]` becomes a TAG here, never a page.
static HUMAN_MULTIWORD_TAG_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"#\[\[([^\]\n]+?)\]\]").expect("invalid human multi-word-tag regex")
});

/// Map an import path (basename or folder-relative path) to the namespaced
/// page TITLE (#1446 Part B — folder → namespace, the inverse of the
/// namespaced export). Strips a trailing `.md`, normalises `\` to `/`, drops
/// empty segments, and rejoins with `/` so `Project/Backend/API.md` →
/// `Project/Backend/API`. Returns an empty string when nothing usable remains
/// (the caller falls back to a default title).
pub fn folder_path_to_namespace_title(path: &str) -> String {
    let without_ext = path.strip_suffix(".md").unwrap_or(path);
    without_ext
        .replace('\\', "/")
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// #1282 (Obsidian slice) — split an Obsidian-style wiki-link target on its
/// FIRST `#` into the base page name and an optional sub-anchor. Obsidian links
/// may address a heading (`[[Page#Heading]]`) or a block id
/// (`[[Page#^blockId]]`) INSIDE a page; the importer resolves only the base
/// PAGE (the `#…` sub-anchor is not yet a navigable target — Obsidian
/// block/heading targeting is a deferred follow-up), so it strips the anchor
/// here and resolves/creates `page` exactly like a plain `[[page]]`.
///
/// Returns `(base, Some(anchor))` when a `#` is present — `base` is the text
/// before the first `#` with leading/trailing whitespace TRIMMED (matching the
/// existing page-name handling), and `anchor` is the raw text after the first
/// `#` (which may itself begin with `^` for a block id, or contain further
/// `#`). Returns `(name_trimmed, None)` when there is no `#` — a plain
/// `[[Page]]` link, byte-for-byte the pre-#1282 behaviour so Logseq / plain
/// Markdown (whose page links carry no `#`) are unaffected. An anchor-only link
/// like `[[#heading]]` yields an EMPTY base; the caller MUST treat that as "no
/// page target" and leave the token literal (it must never create an
/// empty-titled page).
fn split_wikilink_anchor(name: &str) -> (&str, Option<&str>) {
    match name.split_once('#') {
        Some((base, anchor)) => (base.trim(), Some(anchor)),
        None => (name.trim(), None),
    }
}

/// The ways a wiki-link body reads as a name and a label, in the order the
/// name pass tries them (#5160 D9, D10 exact title first): the whole body with
/// no label, then each prefix ending before a `|`, longest first, labelled
/// with the text after that `|`. Names and labels are trimmed, and an empty
/// label is none. The last reading splits on the first `|`; its name is what
/// [`split_wikilink_anchor`] then reads, so `A#B|label` anchors `A#B`.
fn link_body_readings(body: &str) -> Vec<(&str, Option<&str>)> {
    let mut readings = vec![(body.trim(), None)];
    for (at, _) in body.rmatch_indices('|') {
        let label = body[at + 1..].trim();
        readings.push((body[..at].trim(), Some(label).filter(|l| !l.is_empty())));
    }
    readings
}

/// How a wiki-link body reads (#5160 D10): the first of its
/// [`link_body_readings`] whose name names a page in `matches`, else the split
/// on its first `|`, which the name pass resolves or creates. `None` when a
/// reading's name ties: the link stays text.
fn read_link_body<'a>(body: &'a str, matches: &LinkMatches) -> Option<(&'a str, Option<&'a str>)> {
    let readings = link_body_readings(body);
    let (first_split, longer) = readings.split_last().expect("the whole body is a reading");
    for &(name, label) in longer {
        match matches.find_name(name) {
            Some(LinkMatch::Unique(_)) => return Some((name, label)),
            Some(LinkMatch::Ambiguous) => return None,
            None => {}
        }
    }
    Some(*first_split)
}

/// Write the stored link to `ulid`: labelled unless the label is empty or the
/// target's own title, which the link shows anyway and follows through renames
/// (#5160 D9).
fn stored_page_link(ulid: &str, label: Option<&str>, title: Option<&str>) -> String {
    match label.filter(|l| Some(*l) != title) {
        Some(label) => format!("[[{ulid}|{label}]]"),
        None => format!("[[{ulid}]]"),
    }
}

/// #2510 — true when a wiki-link sub-anchor (the text after the first `#`, as
/// returned by [`split_wikilink_anchor`]) is an Obsidian BLOCK anchor
/// (`^block-id`) rather than a heading anchor. Obsidian marks a block
/// reference with a leading `^`; the id after it must be non-empty (a bare
/// `^` with nothing following is not a valid block id and is left to fall
/// through to the existing heading-anchor / dropped-anchor handling).
fn obsidian_block_anchor_id(anchor: &str) -> Option<&str> {
    anchor.strip_prefix('^').filter(|id| !id.is_empty())
}

/// #2567 — extract the heading TEXT from a block whose (first line of) content
/// is a Markdown/Obsidian ATX heading (`# Heading` … `###### Heading`). Returns
/// the trimmed heading label WITHOUT the leading `#` run when the block's first
/// line is a valid ATX heading (1–6 `#` followed by whitespace and non-empty
/// text), else `None`. Only the FIRST line is inspected: a heading block may
/// carry soft-wrapped continuation body (#682), but the heading is always its
/// first line. A `#tag`-style token (no space after the `#`) is deliberately
/// NOT a heading. Used to build the per-document heading-anchor map so an
/// Obsidian `[[Page#Heading]]` / `[[#Heading]]` wiki-link can resolve to the
/// block that renders that heading (mirroring the `^block-id` path for #2510).
fn obsidian_heading_text(content: &str) -> Option<&str> {
    let first_line = content.lines().next()?;
    let trimmed = first_line.trim_start();
    let after_hashes = trimmed.trim_start_matches('#');
    let hash_count = trimmed.len() - after_hashes.len();
    if hash_count == 0 || hash_count > 6 {
        return None;
    }
    // ATX requires whitespace between the `#` run and the heading text; this is
    // what separates a `## Heading` from a `#tag`.
    let rest = after_hashes.strip_prefix([' ', '\t'])?;
    let text = rest.trim();
    if text.is_empty() {
        return None;
    }
    Some(text)
}

/// #2567 — normalize an Obsidian heading label for anchor matching. Obsidian
/// `[[Page#Some Heading]]` links match the heading TEXT; matching is made robust
/// to incidental whitespace/case differences by trimming, collapsing internal
/// whitespace runs to a single space, and lowercasing. Used to key BOTH the
/// per-document heading map (from each heading block's text) and the lookup
/// (from a wiki-link's `#…` sub-anchor) so they compare equal.
fn normalize_heading_anchor(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// #2567 — a deferred Obsidian heading-anchor wiki-link (`[[Page#Heading]]` /
/// `[[#Heading]]`) awaiting resolution in the post-block-creation pass, once
/// every heading block has a real ULID. `norm` is the NORMALIZED heading label
/// (`normalize_heading_anchor`) to look up in the per-document heading map;
/// `empty_base` records whether the link was the anchor-only `[[#Heading]]`
/// form, so an UNRESOLVED link restores the correct #1282 fallback: an empty
/// base is left literal with a "no page target" warning, while an explicit
/// self-title base (`[[Self#Heading]]`) degrades to a page link + the aggregate
/// dropped-anchor warning.
struct PendingHeading {
    norm: String,
    empty_base: bool,
}

/// Collect the DISTINCT trimmed bodies of the human-readable `[[Page Name]]`
/// links across every parsed block's content (#1446 Part B), Logseq's
/// `[label]([[Page]])` read as `[[Page|label]]`. A body holding a `|` is read
/// later, once the pages it may name are known (#5160 D10). A token whose body
/// is already a canonical `[[ULID]]` ref is skipped (it needs no resolution).
/// Used to drive the create-if-missing pre-pass before the block-write loop,
/// so each distinct name is resolved/created exactly once regardless of how
/// many blocks cite it.
///
/// #3605 — a link inside CODE is literal text and resolves to nothing. A
/// `is_code` block (born inside a ```` ``` ```` fence) is skipped wholesale and
/// inline-code spans are skipped within a block, exactly as
/// `collect_inbound_tag_names` already does for `#tag`. Before this, the same
/// fenced block whose `#tag`s were left alone still had its `[[Page]]` links
/// resolved AND rewritten — so a snippet documenting the wiki-link syntax both
/// minted a page nobody asked for and came back with a raw ULID pasted into
/// the code.
fn collect_inbound_page_link_bodies(blocks: &[import::ParsedBlock]) -> Vec<String> {
    use std::collections::BTreeSet;
    let mut bodies: BTreeSet<String> = BTreeSet::new();
    for block in blocks {
        if block.is_code {
            continue;
        }
        // #1921 — skip the regex scan for link-free blocks (the common case).
        if !block.content.contains("[[") {
            continue;
        }
        let content = rewrite_logseq_labelled_links(&block.content);
        let code_spans = import::inline_code_spans(&content);
        for cap in HUMAN_PAGE_LINK_RE.captures_iter(&content) {
            let whole = cap.get(0).expect("group 0 always present");
            // #3605 — inside an inline-code span: literal, never resolved.
            // #1950 — a `[[...]]` immediately preceded by `#` is the multi-word
            // tag form `#[[Tag With Space]]`, NOT a page link. Leave it for the
            // tag pre-pass: do not collect it as a page name (so no page is
            // created) and the matching rewrite guard below leaves the token in
            // place for the tag rewrite. The check is byte-safe — a `#` is a
            // single ASCII byte, so `[..start]` ending with `'#'` is exact.
            // #1925 — a `[[...]]` immediately preceded by `!` is an Obsidian
            // EMBED `![[file]]` (an attachment ref), NOT a page link. Skip it
            // here so no page is created and the embed token survives intact for
            // the attachment detection/ingest pass.
            if !page_link_is_token(&content, whole.start(), &code_spans) {
                continue;
            }
            let body = cap[1].trim();
            // Skip canonical `[[ULID]]` bodies — they are already internal refs.
            if body.is_empty() || agaric_store::cache::PAGE_LINK_RE.is_match(&cap[0]) {
                continue;
            }
            bodies.insert(body.to_string());
        }
    }
    bodies.into_iter().collect()
}

/// Logseq's labelled link, `[label]([[Page]])`: group 1 the label, group 2
/// the link body (#5160 D9).
static LOGSEQ_LABELLED_LINK_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\[([^\]\n]*)\]\(\[\[([^\]\n]+?)\]\]\)")
            .expect("invalid labelled link regex")
    });

/// `content` with each Logseq `[label]([[Page]])` outside code written as
/// `[[Page|label]]`, the one labelled form the name pass reads (#5160 D9). The
/// link body goes over whole, so a page titled `A | B` is still its reading.
fn rewrite_logseq_labelled_links(content: &str) -> std::borrow::Cow<'_, str> {
    if !content.contains("]([[") {
        return std::borrow::Cow::Borrowed(content);
    }
    let code_spans = import::inline_code_spans(content);
    LOGSEQ_LABELLED_LINK_RE.replace_all(content, |caps: &regex::Captures<'_>| {
        let m = caps.get(0).expect("group 0 always present");
        if !page_link_is_token(content, m.start(), &code_spans) {
            return m.as_str().to_string();
        }
        let name = caps[2].trim();
        match caps[1].trim() {
            "" => format!("[[{name}]]"),
            label => format!("[[{name}|{label}]]"),
        }
    })
}

/// Rewrite human-readable `[[Page Name]]` tokens in `content` to internal
/// `[[ULID]]` refs through `links` (#1446 Part B): each body's reading, then
/// the reading's name's page. A body with no reading, or whose name has no page
/// (unresolvable / ambiguous duplicate title / creation failure), is left as
/// its original plain-text token — nothing is dropped.
/// Canonical `[[ULID]]` tokens already in the content are left untouched.
/// Code blocks (`is_code`) are handled by the CALLER (skipped before this
/// runs); inline-code spans are skipped here (#3605) — the exact split
/// `rewrite_inbound_tags` uses.
///
/// A `[[Page|label]]` keeps its label as `[[ULID|label]]` unless the label is
/// the target's title in `titles` (#5160 D9). Logseq's `[label]([[Page]])` is
/// normalised to that token first, whether or not `Page` resolves, so one that
/// stays text stays as `[[Page|label]]`.
fn rewrite_inbound_page_links(
    content: &str,
    links: &PageLinks,
    titles: &HashMap<String, String>,
) -> String {
    // #1921 fast-path: a block with no `[[` can carry no wiki-link, so skip the
    // regex scan + capture/replace work entirely. Behaviour is identical for
    // link-free blocks (the regex would have matched nothing and returned the
    // content unchanged anyway).
    if !content.contains("[[") {
        return content.to_string();
    }
    let content = rewrite_logseq_labelled_links(content);
    let code_spans = import::inline_code_spans(&content);
    HUMAN_PAGE_LINK_RE
        .replace_all(&content, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("group 0 always present");
            let whole = m.as_str();
            // IDENTICAL guard to `collect_inbound_page_link_bodies`: a link
            // inside an inline-code span (#3605), the `#[[Tag]]` multi-word tag
            // form (#1950), the `![[file]]` embed (#1925) and an escaped token
            // stay byte-identical.
            if !page_link_is_token(&content, m.start(), &code_spans) {
                return whole.to_string();
            }
            // Already an internal `[[ULID]]` ref — keep verbatim.
            if agaric_store::cache::PAGE_LINK_RE.is_match(whole) {
                return whole.to_string();
            }
            let Some((name, label)) = links.readings.get(caps[1].trim()) else {
                return whole.to_string();
            };
            match links.ids.get(name) {
                Some(ulid) => {
                    stored_page_link(ulid, label.as_deref(), titles.get(ulid).map(String::as_str))
                }
                None => whole.to_string(),
            }
        })
        .into_owned()
}

/// `true` when byte offset `pos` falls inside any of the half-open `spans`.
fn is_in_span(pos: usize, spans: &[(usize, usize)]) -> bool {
    spans.iter().any(|&(s, e)| pos >= s && pos < e)
}

/// #3598 — byte ranges of `content` covered by a HUMAN wiki-link token
/// (`[[...]]`, per [`HUMAN_PAGE_LINK_RE`]), delimiters included.
///
/// A `#` INSIDE such a token is part of the link, never an inline tag: it is
/// either an Obsidian heading anchor (`[[#Heading]]`, `[[Page#Heading]]`) or a
/// literal `#` in a page NAME (`[[Project #alpha]]`). Collecting it would mint a
/// spurious tag and rewriting it would corrupt the token into
/// `[[Project #[ULID]]]`. Both tag passes therefore skip any bare-tag match
/// whose `#` falls in one of these ranges.
///
/// ORDERING: these offsets are valid ONLY for the string they were computed
/// from. `rewrite_inbound_tags` MUST recompute them after its multi-word pass,
/// which changes token lengths and therefore shifts every later offset.
fn human_page_link_spans(content: &str) -> Vec<(usize, usize)> {
    // #1921-style fast path: no `[[` means no wiki-link token at all.
    if !content.contains("[[") {
        return Vec::new();
    }
    HUMAN_PAGE_LINK_RE
        .find_iter(content)
        .map(|m| (m.start(), m.end()))
        .collect()
}

/// Collect the DISTINCT human-readable inline-tag names referenced across every
/// TAG-ELIGIBLE block's content (#1924/#1950), in both forms:
///   * bare/nested/hyphenated `#tag` (`HUMAN_TAG_RE`, group 2 is the name), and
///   * multi-word `#[[Tag With Space]]` (`HUMAN_MULTIWORD_TAG_RE`, group 1).
///
/// #3599 — CANONICAL RULE, for import and paste alike: a `#tag` inside a
/// PROTECTED span is never resolved and never rewritten. The protected spans
/// are (a) fenced code — a block flagged `is_code` is skipped entirely here,
/// (b) inline-code spans (`` `...` ``) within a non-code block, and (c) the body
/// of a `[[...]]` wiki-link token (see [`human_page_link_spans`]). "Never
/// resolved" is the load-bearing half: skipping in COLLECTION as well as in the
/// rewrite is what keeps a protected name from creating a tag it never links.
/// Canonical `#[ULID]` refs never match `HUMAN_TAG_RE` (the char after `#` is
/// `[`, not a name char), so they are not collected. The multi-word form is
/// scanned FIRST and its byte ranges are excluded from the bare scan so a
/// `#[[a b]]` is not also double-counted as a bare `#a`-style fragment (it
/// cannot be — `[` is not a name char — but the ordering keeps the rewrite and
/// collect passes symmetric).
///
/// Used to drive the resolve-or-create tag pre-pass before the block-write loop,
/// so each distinct name is resolved/created exactly once.
fn collect_inbound_tag_names(blocks: &[import::ParsedBlock]) -> Vec<String> {
    use std::collections::BTreeSet;
    let mut names: BTreeSet<String> = BTreeSet::new();
    for block in blocks {
        if block.is_code {
            continue;
        }
        if !block.content.contains('#') {
            continue;
        }
        // Read as the page pass rewrites it (#5160 D9): a `#tag` in a Logseq
        // `[label]([[Page]])` label lands inside `[[Page|label]]`, where the tag
        // rewrite leaves it, so collecting it would mint a tag nothing links.
        let content = rewrite_logseq_labelled_links(&block.content);
        let guards = tag_guard_spans(&content);
        let link_spans = human_page_link_spans(&content);
        // Multi-word `#[[...]]` first.
        for cap in HUMAN_MULTIWORD_TAG_RE.captures_iter(&content) {
            let whole = cap.get(0).expect("group 0 always present");
            if is_in_span(whole.start(), &guards) || is_escaped(&content, whole.start()) {
                continue;
            }
            let name = cap[1].trim();
            if !name.is_empty() {
                names.insert(name.to_string());
            }
        }
        // Bare `#tag`. The `#` is at `name_match.start() - 1` (group 1 is the
        // boundary char, which may be empty at line start).
        for cap in HUMAN_TAG_RE.captures_iter(&content) {
            let name_m = cap.get(2).expect("name group present");
            if bare_tag_is_token(&content, name_m, &guards, &link_spans) {
                names.insert(name_m.as_str().to_string());
            }
        }
    }
    names.into_iter().collect()
}

/// Rewrite human-readable inline tags in `content` to internal `#[ULID]` refs
/// using the resolved `name → ULID` map (#1924/#1950). Both `#tag` and
/// `#[[Tag With Space]]` forms become `#[ULID]`. A name absent from the map
/// (creation failure) keeps its original literal token — nothing is dropped.
/// Code blocks (`is_code`) are handled by the CALLER (skipped before this runs);
/// inline-code spans are skipped here. Canonical `#[ULID]` refs are never
/// touched (they don't match the human regexes).
fn rewrite_inbound_tags(content: &str, resolved: &HashMap<String, String>) -> String {
    if !content.contains('#') {
        return content.to_string();
    }
    let guards = tag_guard_spans(content);
    // Pass 1: multi-word `#[[name]]` → `#[ULID]`.
    let after_multi = HUMAN_MULTIWORD_TAG_RE.replace_all(content, |caps: &regex::Captures<'_>| {
        let m = caps.get(0).expect("group 0 present");
        let whole = m.as_str();
        if is_in_span(m.start(), &guards) || is_escaped(content, m.start()) {
            return whole.to_string();
        }
        let name = caps[1].trim();
        match resolved.get(name) {
            Some(ulid) => format!("#[{ulid}]"),
            None => whole.to_string(),
        }
    });

    // Pass 2: bare `#tag` → `<boundary>#[ULID]`. The boundary char (group 1)
    // is preserved verbatim so the leading separator is not consumed. BOTH span
    // sets are recomputed against `after_multi` because pass 1 shifts byte
    // offsets: a `#[[name]]` → `#[ULID]` rewrite changes the token's length, so
    // reusing spans computed over `content` would mis-align — and for the
    // wiki-link spans that mis-alignment is not merely defensive. `#[[a b]]
    // [[Project #alpha]]` shifts the link 10 bytes right, moving `#alpha`
    // clean out of the stale span and back into the corrupting rewrite (#3598).
    let guards2 = tag_guard_spans(&after_multi);
    let link_spans2 = human_page_link_spans(&after_multi);
    HUMAN_TAG_RE
        .replace_all(&after_multi, |caps: &regex::Captures<'_>| {
            let boundary = caps.get(1).map_or("", |m| m.as_str());
            let name_m = caps.get(2).expect("name group present");
            let name = name_m.as_str();
            // IDENTICAL guard to `collect_inbound_tag_names`.
            if !bare_tag_is_token(&after_multi, name_m, &guards2, &link_spans2) {
                return format!("{boundary}#{name}");
            }
            match resolved.get(name) {
                Some(ulid) => format!("{boundary}#[{ulid}]"),
                None => format!("{boundary}#{name}"),
            }
        })
        .into_owned()
}

/// Replace `#[ULID]` with `#tagname`, `[[ULID]]` with `[[Page Title]]`, and
/// `((ULID))` block references with a human-readable, roundtrip-safe Obsidian
/// block-anchor wiki-link (#2963), preserving all other markdown formatting.
///
/// `block_refs` maps a referenced block ULID to the exact token to emit in
/// place of `((ULID))` — precomputed by the caller (which has the target's
/// page + title in scope): a same-page target yields an anchor-only
/// `[[#^ULID]]` link (which the importer resolves back to a real block ref via
/// the #2510 intra-note anchor pass — see `export_page_markdown_inner`), a
/// cross-page target yields `[[Target Page#^ULID]]`. A `((ULID))` whose target
/// is missing from the map (deleted / dangling) is NOT left as a raw ULID: it
/// degrades to a clearly-marked, human-readable `(unresolved block reference)`
/// literal that survives re-import as plain text (the raw `((ULID))` would come
/// back as a dangling ref).
fn resolve_ulids_for_export(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
    block_refs: &HashMap<String, String>,
) -> String {
    let result = humanise_tag_and_page_refs(content, tag_names, page_titles);

    // #2963 — Replace ((ULID)) block references with the precomputed
    // human-readable, roundtrip-safe token (same-page `[[#^ULID]]` /
    // cross-page `[[Page#^ULID]]`), falling back to a clearly-marked literal
    // for a dangling target rather than leaking an opaque `((ULID))` that no
    // external tool renders and that the importer would strip on re-import.
    agaric_store::cache::BLOCK_REF_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let ulid = &caps[1];
            block_refs
                .get(ulid)
                .cloned()
                .unwrap_or_else(|| "(unresolved block reference)".to_string())
        })
        .into_owned()
}

/// Replace `#[ULID]` with `#tagname` and `[[ULID]]` with `[[Page Title]]`; an
/// id missing from its map stays raw, and so does an escaped `\#[ULID]` or
/// `\[[ULID]]`, after which no name reads back as the ref (#5160 N3).
fn humanise_tag_and_page_refs(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
) -> String {
    // #1920 — `agaric_store::cache` is the canonical definition site for both regexes;
    // `agaric_store::fts::strip` imports them for FTS stripping. Reference the
    // canonical cache path here rather than going through `fts`.
    use agaric_store::cache::{PAGE_LINK_RE, TAG_REF_RE};

    // Replace #[ULID] → #tagname, or `#[[name]]` when the bare form would not
    // read back as the same tag (#5160 N8): `#deep work` stops at the space,
    // `#C++` at the `+`, `#v1.2` at the `.`, `#42` is not a tag at all, and
    // `[#work]` or `#works` reads the neighbours as part of the token. The
    // text written so far is the reader's left context, so two refs in a row
    // are judged as they come out, not as they went in.
    let mut result = String::with_capacity(content.len());
    let mut last = 0;
    for caps in TAG_REF_RE.captures_iter(content) {
        let m = caps.get(0).expect("group 0 always present");
        result.push_str(&content[last..m.start()]);
        match tag_names
            .get(&caps[1])
            .filter(|_| !is_escaped(content, m.start()))
        {
            Some(name) if tag_reads_back_bare(&result, name, &content[m.end()..]) => {
                result.push('#');
                result.push_str(name);
            }
            Some(name) => {
                result.push_str("#[[");
                result.push_str(name);
                result.push_str("]]");
            }
            None => result.push_str(m.as_str()),
        }
        last = m.end();
    }
    result.push_str(&content[last..]);

    // Replace [[ULID]] → [[Page Title]], a label riding along (#5160 D9)
    PAGE_LINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let m = caps.get(0).expect("group 0 always present");
            if is_escaped(&result, m.start()) {
                return m.as_str().to_owned();
            }
            let ulid = &caps[1];
            let target = page_titles.get(ulid).map_or(ulid, String::as_str);
            match agaric_store::cache::page_link_label(caps) {
                Some(label) => format!("[[{target}|{label}]]"),
                None => format!("[[{target}]]"),
            }
        })
        .into_owned()
}

/// Whether `#name`, written between `before` and `after`, reads back as the
/// tag `name` on every text surface: its `#` follows a boundary, the whole
/// name is one bare-tag match that the next char does not extend, and it is a
/// tag name.
fn tag_reads_back_bare(before: &str, name: &str, after: &str) -> bool {
    let probe: String = before
        .chars()
        .next_back()
        .into_iter()
        .chain(format!("#{name}").chars())
        .chain(after.chars().next())
        .collect();
    is_tag_name(name)
        && HUMAN_TAG_RE
            .captures(&probe)
            .is_some_and(|caps| caps.get(2).is_some_and(|m| m.as_str() == name))
}

/// `content` with its tag and page ids replaced by names, when the importer
/// would resolve every name back to the id it replaced; `None` when there is
/// no name to write or one would not come back, and the block goes out raw.
///
/// The check runs the importer's own name collection and rewrite over the
/// named text, with `is_code` as the parser will read the block; only the
/// resolution comes from `names` instead of the database, and nothing is
/// created. A name can be unique and still not come back: `[[Foo|Bar]]` reads
/// as the page `Foo|Bar` when one exists (#5160 D10), and `#v1.2` as the tag
/// `v1`.
fn humanise_refs_for_source(
    content: &str,
    is_code: bool,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
    names: &NameSnapshot,
) -> Option<String> {
    let named = humanise_tag_and_page_refs(content, tag_names, page_titles);
    if named == content {
        return None;
    }
    let block = import::ParsedBlock {
        content: named,
        depth: 0,
        properties: Vec::new(),
        is_code,
        block_anchor: None,
        task_markers: Vec::new(),
    };
    let blocks = std::slice::from_ref(&block);
    let page_links = names.page_links(collect_inbound_page_link_bodies(blocks));
    let tags = names.tags(collect_inbound_tag_names(blocks));
    let internalised = rewrite_block_content_for_import(&block, &page_links, page_titles, &tags);
    (internalised == content).then_some(block.content)
}

/// The in-space names the importer resolves against, as its snapshots read
/// them: the pages every reading of the link bodies the render writes may name
/// (`snapshot_page_link_matches`), and each normalised tag name with its
/// smallest-id tag (`snapshot_tags_by_norm`, #1990).
#[derive(Default)]
struct NameSnapshot {
    pages: LinkMatches,
    tag_id_by_norm: HashMap<String, String>,
}

impl NameSnapshot {
    /// What the importer's page-link pass would make of each link body
    /// without creating a page: its reading ([`read_link_body`]), when the
    /// name read is the one in-space page with exactly that title. The render
    /// writes titles, and an exact title wins before any case or alias match
    /// (N4), so nothing else can claim the name.
    fn page_links(&self, bodies: impl IntoIterator<Item = String>) -> PageLinks {
        let mut links = PageLinks::default();
        for body in bodies {
            let Some((name, label)) = read_link_body(&body, &self.pages) else {
                continue;
            };
            if let Some([id]) = self.pages.exact.get(name).map(Vec::as_slice) {
                links.ids.insert(name.to_string(), id.clone());
                let reading = (name.to_string(), label.map(str::to_string));
                links.readings.insert(body, reading);
            }
        }
        links
    }

    /// What the importer's tag pass would map each name to without creating
    /// a tag: the winner for its normalised name.
    fn tags(&self, names: Vec<String>) -> HashMap<String, String> {
        names
            .into_iter()
            .filter_map(|name| {
                let norm = agaric_core::tag_norm::normalize_tag_name(&name);
                let id = self.tag_id_by_norm.get(&norm)?.clone();
                Some((name, id))
            })
            .collect()
    }
}

/// #2963 — append an Obsidian `^<block-ulid>` block-anchor marker to a block's
/// resolved export content when that block is the TARGET of a same-page
/// `((ULID))` reference elsewhere in the export.
///
/// The marker lands at the very end of the block's content — its last line —
/// which is exactly where the importer's `strip_block_anchor_marker` reads it
/// back into `ParsedBlock::block_anchor`, so the matching `[[#^<ULID>]]` link
/// (emitted by [`resolve_ulids_for_export`]) resolves to a real `((<new
/// ULID>))` block reference on re-import. A block that is not a same-page ref
/// target is returned unchanged. The marker id is the block's own ULID, which
/// satisfies the importer's `^[A-Za-z0-9-]+` anchor grammar and is guaranteed
/// unique, so it is a stable document-local key linking the reference to its
/// target.
fn stamp_block_anchor_marker(
    resolved: String,
    block_id: &str,
    same_page_ref_targets: &std::collections::HashSet<String>,
) -> String {
    if !same_page_ref_targets.contains(block_id) {
        return resolved;
    }
    append_block_anchor(&resolved, block_id)
}

/// `resolved` with the `^<block_id>` marker at its end. A block ending on a
/// fence line gets the marker on a line of its own: on the fence line the
/// importer reads it as code and never strips it.
fn append_block_anchor(resolved: &str, block_id: &str) -> String {
    let last_line = resolved
        .rsplit_once('\n')
        .map_or(resolved, |(_, line)| line);
    let ends_on_closing_fence = import::fence_run(last_line.trim_start()).is_some();
    let separator = if ends_on_closing_fence { '\n' } else { ' ' };
    format!("{resolved}{separator}^{block_id}")
}

/// One projected `block_properties` row destined for the exported YAML
/// frontmatter (#384). A row stores its value in exactly one of the typed
/// columns; the emit loop in [`export_page_markdown_inner`] picks the populated
/// one. Lifted to module scope (#1920) from the function body for readability.
struct FrontmatterRow {
    key: String,
    value_text: Option<String>,
    value_date: Option<String>,
    value_num: Option<f64>,
    value_ref: Option<String>,
    value_bool: Option<i64>,
}

/// Render a [`FrontmatterRow`]'s single populated value column as plain text
/// (#2962). Shared by the page-frontmatter emit loop and the descendant
/// `key:: value` property emit loop in [`export_page_markdown_inner`] so both
/// paths resolve a `block_properties` row identically.
///
/// Precedence: date, then text, then ref (resolved to a page title via
/// `ref_titles`, falling back to the raw ULID when unresolved), then numeric,
/// then bool. A `block_properties` row stores its value in exactly one
/// column (enforced by the `exactly_one_value` CHECK), so at most one branch
/// ever fires; the ordering is a defensive fallback, not a real precedence
/// rule.
fn frontmatter_row_value(prop: &FrontmatterRow, ref_titles: &HashMap<String, String>) -> String {
    if let Some(d) = prop.value_date.as_deref() {
        d.to_string()
    } else if let Some(t) = prop.value_text.as_deref() {
        t.to_string()
    } else if let Some(rf) = prop.value_ref.as_deref().filter(|s| !s.is_empty()) {
        ref_titles
            .get(rf)
            .cloned()
            .unwrap_or_else(|| rf.to_string())
    } else if let Some(n) = prop.value_num {
        // Render integers without a trailing ".0"; keep fractional values
        // as-is. `{n}` on an f64 already emits "3" for 3.0 in Rust's default
        // float formatting, so no lossy `as i64` cast is needed.
        format!("{n}")
    } else if let Some(b) = prop.value_bool {
        if b != 0 {
            "true".to_string()
        } else {
            "false".to_string()
        }
    } else {
        String::new()
    }
}

/// Everything [`export_page_markdown_inner`] reads from the database, resolved
/// under the single #660 snapshot transaction before any rendering starts.
///
/// A struct rather than a dozen parameters: the split of this function (#4639)
/// separates "read the vault" from "render the markdown", and the seam between
/// them is exactly this set. Grouping it also keeps the ordering guarantee
/// visible — every field is read inside one `BEGIN DEFERRED` snapshot, so the
/// renderer cannot observe a half-updated vault.
struct PageExportData {
    page: BlockRow,
    descendants: Vec<BlockRow>,
    attachments_by_block: HashMap<String, Vec<(String, String)>>,
    tag_names: HashMap<String, String>,
    page_titles: HashMap<String, String>,
    block_ref_replacement: HashMap<String, String>,
    same_page_ref_targets: HashSet<String>,
    descendant_properties: HashMap<String, Vec<FrontmatterRow>>,
    list_styles: HashMap<String, String>,
    ref_titles: HashMap<String, String>,
    properties: Vec<FrontmatterRow>,
    aliases: Vec<String>,
    tag_names_fm: Vec<String>,
    /// Read by source mode only, to decide which names it may write.
    name_snapshot: NameSnapshot,
}

/// What a page is read for, which decides what [`load_page_export_data`]
/// reads beyond the block tree, its references and its blocks' properties.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PageRead {
    /// An export: the attachments, the page's own properties, aliases and
    /// tags, and the titles of ref-typed property values.
    Export,
    /// Source mode, the clipboard and a source save: the names a block may be
    /// written with.
    Source,
    /// A duplicate, which writes every id raw: nothing more.
    Duplicate,
}

/// The renderings of a page's block tree. In every one a task's state is a
/// checkbox after the bullet (#5160 D6), or a `todo_state::` line for a state
/// outside the checkbox alphabet. `Export` writes a file for other tools: ids
/// become names and links, and only a block a same-page ref points at carries
/// an anchor. `Source` writes the buffer source mode edits (#5140), which
/// `import::parse_source_outline` reads back as exactly this tree: every block
/// carries its `^ID`, and ids stay raw unless a name reads back to the same
/// id. `Clipboard` is `Source` for text that leaves the app: a block carries
/// its `^ID` only when it would not read back without it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum RenderMode {
    Export,
    Source,
    Clipboard,
}

/// Emits one block as `<indent>- <content>` — the *exact* shape
/// `import::parse_logseq_markdown` reconstructs, deriving block identity from
/// the `- ` prefix and nesting depth from leading-spaces / 2 (#1916).
///
/// Below the bullet: the reserved-column task metadata, the block's custom
/// `key:: value` properties, and, in an export, its non-inline attachments,
/// each indented one level further. The orphan safety net renders a stray
/// through this same path at depth 0, so a stray and a walked block cannot
/// drift apart.
fn render_block(
    output: &mut String,
    block: &BlockRow,
    depth: usize,
    data: &PageExportData,
    list_ordinals: &HashMap<String, usize>,
    mode: RenderMode,
) {
    let PageExportData {
        attachments_by_block,
        descendant_properties,
        list_styles,
        ref_titles,
        ..
    } = data;
    let id = block.id.clone().into_string();
    let indent = "  ".repeat(depth);
    let content = block.content.as_deref().unwrap_or("");
    let list_marker = list_marker_for(&id, list_styles, list_ordinals);
    let task_marker = task_marker(block);
    match mode {
        RenderMode::Export => {
            let resolved = export_block_text(content, &id, data);
            push_block_bullet(output, &indent, &list_marker, &task_marker, &resolved, mode);
        }
        RenderMode::Source | RenderMode::Clipboard => {
            push_source_bullet(
                output,
                block,
                &indent,
                &list_marker,
                &task_marker,
                data,
                mode,
            );
        }
    }

    // #1916 — task metadata (TODO/DONE state, priority, scheduled/due
    // dates) lives in the reserved `blocks` columns, not in
    // `block_properties`, so it is invisible to the content render above.
    // Emit each populated column as a `key:: value` property line indented
    // one level under the bullet — the EXACT form the importer's property
    // parser reads back (`parse_logseq_markdown` attaches a `key:: value`
    // line to its owning block, and the apply path routes the reserved
    // keys `todo_state` / `priority` / `due_date` / `scheduled_date` into
    // their columns via `typed_property_args_for_string_value`). No new
    // syntax is invented — these are ordinary Logseq property lines. A state
    // already written as a checkbox is not written twice.
    let prop_indent = "  ".repeat(depth + 1);
    let todo_state = block
        .todo_state
        .as_deref()
        .filter(|_| task_marker.is_empty());
    for (key, value) in [
        ("todo_state", todo_state),
        ("priority", block.priority.as_deref()),
        ("scheduled_date", block.scheduled_date.as_deref()),
        ("due_date", block.due_date.as_deref()),
    ] {
        if let Some(v) = value.filter(|s| !s.is_empty()) {
            output.push_str(&format!("{prop_indent}{key}:: {v}\n"));
        }
    }

    // #2962 — custom `block_properties` on this block (anything NOT one
    // of the 4 reserved `blocks` columns above) round-trip the same way:
    // one `key:: value` line per property, indented one level under the
    // bullet. This is the exact shape `parse_logseq_markdown` reads back
    // into `block.properties` (see the reserved-column comment above) —
    // no new syntax, just the previously-missing emission for the
    // escape-hatch custom-property case. `descendant_properties` was
    // batch-read once for the whole subtree, so this is a HashMap lookup,
    // not a per-block query. Source mode writes a ref-typed value as its raw
    // id, which is what the value is.
    let no_titles = HashMap::new();
    let ref_titles = match mode {
        RenderMode::Export => ref_titles,
        RenderMode::Source | RenderMode::Clipboard => &no_titles,
    };
    if let Some(props) = descendant_properties.get(&id) {
        for prop in props {
            let value = frontmatter_row_value(prop, ref_titles);
            output.push_str(&format!("{prop_indent}{}:: {value}\n", prop.key));
        }
    }

    // #2961 — emit a link line for each block-scoped (non-inline)
    // attachment, nested one level under this block's bullet. Skips any
    // attachment whose id already appears as an `attachment:<id>` token
    // in `content` — that's an inline image, already rendered above by
    // `resolve_ulids_for_export`/`push_block_bullet` — so only
    // genuine file attachments (PDFs/docs/images with no inline token)
    // get a line here. Source mode has no attachment lines: attachments
    // have their own UI.
    if mode == RenderMode::Export
        && let Some(atts) = attachments_by_block.get(&id)
    {
        for (att_id, filename) in atts {
            if content.contains(&format!("attachment:{att_id}")) {
                continue;
            }
            let label = attachment_link_label(filename);
            output.push_str(&format!("{prop_indent}- [{label}](attachment:{att_id})\n"));
        }
    }
}

/// The checkbox a bullet writes for the block's task state: none for a state
/// outside the checkbox alphabet, which stays a `todo_state::` line.
fn task_marker(block: &BlockRow) -> String {
    block
        .todo_state
        .as_deref()
        .and_then(import::task_marker_for)
        .map(|marker| format!("[{marker}] "))
        .unwrap_or_default()
}

/// A block's content as an export writes it: tag, page and block ids resolved
/// to names and links, inline queries made readable, and an anchor when a
/// same-page ref points at the block.
fn export_block_text(content: &str, id: &str, data: &PageExportData) -> String {
    let resolved = resolve_ulids_for_export(
        content,
        &data.tag_names,
        &data.page_titles,
        &data.block_ref_replacement,
    );
    // #2968 — rewrite structured `{{query v2:…}}` payloads to the readable,
    // roundtrip-safe `v2n:` names form (resolving embedded tag/page ULIDs).
    let resolved = super::inline_query_md::rewrite_inline_queries_for_export(
        &resolved,
        &data.tag_names,
        &data.page_titles,
    );
    stamp_block_anchor_marker(resolved, id, &data.same_page_ref_targets)
}

/// A block's bullet as source mode writes it, with its own `^ID`, or as the
/// clipboard does.
///
/// Whether a name may replace an id depends on whether the parser will read
/// the block as code, which the bullet's fence tracking decides; so the raw
/// bullet is written first, and rewritten with names when they read back.
fn push_source_bullet(
    output: &mut String,
    block: &BlockRow,
    indent: &str,
    list_marker: &str,
    task_marker: &str,
    data: &PageExportData,
    mode: RenderMode,
) {
    let id = block.id.as_str();
    let content = block.content.as_deref().unwrap_or("");
    let push = if mode == RenderMode::Clipboard {
        push_clipboard_bullet
    } else {
        push_anchored_source_bullet
    };
    let start = output.len();
    let is_code = push(output, indent, list_marker, task_marker, content, id);
    let Some(named) = humanise_refs_for_source(
        content,
        is_code,
        &data.tag_names,
        &data.page_titles,
        &data.name_snapshot,
    ) else {
        return;
    };
    output.truncate(start);
    push(output, indent, list_marker, task_marker, &named, id);
}

/// `content` as a source bullet without its `^id`, unless the bullet needs it
/// to read back: when the block leaves a fence open, which the anchor line
/// ends, or when the bullet alone reads back as other content, as one ending
/// in ` ^word` or in a blank line does. Returns whether any line is code.
fn push_clipboard_bullet(
    output: &mut String,
    indent: &str,
    list_marker: &str,
    task_marker: &str,
    content: &str,
    id: &str,
) -> bool {
    let start = output.len();
    let code = push_block_bullet(
        output,
        indent,
        list_marker,
        task_marker,
        content,
        RenderMode::Source,
    );
    let read_back = import::parse_source_outline(&output[start..]).blocks;
    if !code.open && matches!(read_back.as_slice(), [block] if block.content == content) {
        return code.any;
    }
    output.truncate(start);
    push_anchored_source_bullet(output, indent, list_marker, task_marker, content, id)
}

/// `content` as a source bullet with `^id` at the end of its last line or,
/// when that line is code, on a line of its own, which the parser reads as
/// the end of any fence the block leaves open. Returns whether any line is
/// code.
fn push_anchored_source_bullet(
    output: &mut String,
    indent: &str,
    list_marker: &str,
    task_marker: &str,
    content: &str,
    id: &str,
) -> bool {
    let start = output.len();
    // Written with the marker, not appended to: the marker can change the last
    // line's escape (`key::` becomes the property line `key:: ^ID`). Whether
    // the last line is code does not depend on the marker, since fences are
    // told by their prefix.
    let code = push_block_bullet(
        output,
        indent,
        list_marker,
        task_marker,
        &format!("{content} ^{id}"),
        RenderMode::Source,
    );
    if !code.last {
        return code.any;
    }
    output.truncate(start);
    let code = push_block_bullet(
        output,
        indent,
        list_marker,
        task_marker,
        content,
        RenderMode::Source,
    );
    output.push_str(&format!("{indent}  ^{id}\n"));
    code.any
}

/// The `---` YAML frontmatter block, emitted only when the page carries
/// properties, aliases or tags.
fn render_frontmatter(output: &mut String, data: &PageExportData) {
    let PageExportData {
        properties,
        aliases,
        tag_names_fm,
        ref_titles,
        ..
    } = data;
    // Frontmatter (if properties, aliases, or tags exist)
    //
    // (#1433) `aliases`/`tags` are emitted as YAML *flow sequences*
    // (`[a, b]`). An item is emitted *bare* only when it is unambiguously a
    // plain string in flow context — i.e. it does not look like a YAML
    // scalar token (`true`/`null`/a number/etc.), does not start with a YAML
    // indicator, has no surrounding whitespace, and contains no
    // flow-significant or control characters. Anything else is emitted as a
    // YAML double-quoted scalar with `\`, `"` and all control characters
    // (`\n`, `\t`, `\r`, and `\xNN` for the rest) escaped, which is valid for
    // *any* string. Legacy scalar property values keep their verbatim
    // emission below. #1920 — the emit helpers now live in `markdown_yaml`
    // (symmetric with the import-side `strip_yaml_quotes`).
    use super::markdown_yaml::{yaml_flow_sequence, yaml_scalar_emit};

    if !properties.is_empty() || !aliases.is_empty() || !tag_names_fm.is_empty() {
        output.push_str("---\n");
        if !aliases.is_empty() {
            output.push_str(&format!("aliases: {}\n", yaml_flow_sequence(aliases)));
        }
        if !tag_names_fm.is_empty() {
            output.push_str(&format!("tags: {}\n", yaml_flow_sequence(tag_names_fm)));
        }
        for prop in properties {
            let value = frontmatter_row_value(prop, ref_titles);
            // #2715 — route the scalar through the YAML emit helper so a value
            // carrying a newline, a leading `---`, quotes, or other
            // YAML-significant content is quoted / block-scalar-encoded instead
            // of written verbatim (which could inject keys or break out of the
            // frontmatter fence). `yaml_scalar_emit` is symmetric with the
            // import-side `parse_frontmatter` re-parse.
            output.push_str(&yaml_scalar_emit(&prop.key, &value));
        }
        output.push_str("---\n\n");
    }
}

/// The page block's own non-inline attachments, which neither render loop
/// below reaches (#2991).
fn render_page_attachments(output: &mut String, page_id: &str, data: &PageExportData) {
    let PageExportData {
        page,
        attachments_by_block,
        ..
    } = data;
    // #2991 — emit the PAGE block's own non-inline attachments.
    //
    // `attachments_by_block` was batch-fetched above (2b) for the page id
    // AND every descendant, but neither render loop below iterates the page
    // block itself: the DFS loop only walks `descendants`, and the orphan
    // safety net only walks entries of `descendants` not reached by the DFS.
    // An attachment attached directly to the page/title block (rather than
    // to one of its descendant blocks) was therefore fetched but never
    // emitted — silently dropped from the export, the same data-loss class
    // #2961 fixed for descendant blocks, just for the root block.
    //
    // Dedup mirrors the DFS/orphan loops EXACTLY: an attachment id already
    // present as an `attachment:<id>` token in the page's own `content` (an
    // inline image) is skipped here so it isn't double-emitted — it was
    // already rendered inline as part of the `# {title}` line above.
    //
    // Emitted at depth 0 (no indent), right after frontmatter and before the
    // descendant bullets: these lines aren't nested under any bullet (the
    // page has none — its content is the `# Title` heading), so they sit at
    // the same top level as the first-level descendant bullets below.
    if let Some(atts) = attachments_by_block.get(page_id) {
        let page_content = page.content.as_deref().unwrap_or("");
        for (att_id, filename) in atts {
            if page_content.contains(&format!("attachment:{att_id}")) {
                continue;
            }
            let label = attachment_link_label(filename);
            output.push_str(&format!("- [{label}](attachment:{att_id})\n"));
        }
    }
}

/// CRITICAL: `descendants` is ordered FLAT by `(position, id)` over the
/// keyset — `position` is the *sibling* slot (dense within a parent), so
/// two blocks under different parents can share a position and the global
/// order does NOT guarantee parent-before-child (e.g. a child whose id
/// sorts before its parent's). Emitting in that flat order would both
/// mis-compute depth AND, worse, present a child bullet before its parent
/// bullet, which the importer's document-order parent-stack would
/// mis-reparent. So we re-order the subtree into DFS pre-order here:
/// build `parent_id -> children` (children sorted by `(position, id)`,
/// matching the read order), then walk depth-first from the page root.
/// This guarantees every parent precedes its children and yields the
/// correct depth for indentation.
fn group_children_by_parent<'a>(
    page_id: &str,
    descendants: &'a [BlockRow],
) -> HashMap<String, Vec<&'a BlockRow>> {
    let mut children_by_parent: HashMap<String, Vec<&BlockRow>> = HashMap::new();
    for block in descendants {
        let parent_key = block
            .parent_id
            .as_ref()
            .map_or_else(|| page_id.to_string(), |p| p.clone().into_string());
        children_by_parent
            .entry(parent_key)
            .or_default()
            .push(block);
    }
    for children in children_by_parent.values_mut() {
        // The read query already orders by `(COALESCE(position, sentinel),
        // id)`; preserve that sibling order within each parent.
        children.sort_by(|a, b| {
            let pa = a.position.unwrap_or(NULL_POSITION_SENTINEL);
            let pb = b.position.unwrap_or(NULL_POSITION_SENTINEL);
            pa.cmp(&pb)
                .then_with(|| a.id.clone().into_string().cmp(&b.id.clone().into_string()))
        });
    }
    children_by_parent
}

/// Render the resolved export data as markdown. Pure — no database access, so
/// the whole document is built from one consistent snapshot (#660).
///
/// Split out of `export_page_markdown_inner` (#4639); behaviour-preserving,
/// with the export tests as the oracle.
fn render_page_markdown(page_id: &str, data: &PageExportData) -> String {
    let page = &data.page;
    let mut output = String::new();

    // Title
    //
    // #2991 — `page.content` is cloned (not moved) here because the page
    // block's own non-inline attachments (emitted just below, after
    // frontmatter) need the raw content string for the same inline-token
    // dedup check the descendant loops use.
    let title = page
        .content
        .clone()
        .unwrap_or_else(|| "Untitled".to_string());
    output.push_str(&format!("# {title}\n\n"));

    render_frontmatter(&mut output, data);
    render_page_attachments(&mut output, page_id, data);
    render_block_tree(&mut output, page_id, data, RenderMode::Export);
    output
}

/// The page as the one markdown buffer source mode edits (#5140): its block
/// tree alone. The title, frontmatter and page attachments have their own UIs.
fn render_page_source(data: &PageExportData) -> String {
    render_page_source_ids(data).0
}

/// [`render_page_source`], with the ids of the blocks it holds in order.
fn render_page_source_ids(data: &PageExportData) -> (String, Vec<String>) {
    let mut output = String::new();
    let ids = render_block_tree(&mut output, data.page.id.as_str(), data, RenderMode::Source);
    (output, ids)
}

/// Every descendant of `page_id`, depth-first in sibling order, each through
/// [`render_block`]. Returns the ids it rendered, in render order.
fn render_block_tree(
    output: &mut String,
    page_id: &str,
    data: &PageExportData,
    mode: RenderMode,
) -> Vec<String> {
    let children_by_parent = group_children_by_parent(page_id, &data.descendants);
    // #4552 slice 4 — positional ordinals for `ordered` blocks. Computed HERE,
    // once `children_by_parent` is grouped and sibling-sorted, because an
    // ordinal is a function of a block's NEIGHBOURS, which only this assembler
    // knows (`markdown-serialize.ts` sees one block in isolation). Nothing
    // numeric is stored: the number is re-derived on every export, so a
    // reorder renumbers and a hand-written `3.` / `7.` normalises on the first
    // round trip.
    let list_ordinals = compute_list_ordinals(&children_by_parent, &data.list_styles);
    let roots = children_by_parent
        .get(page_id)
        .map_or(&[][..], Vec::as_slice);
    let mut rendered = render_subtrees(
        output,
        roots,
        &children_by_parent,
        &list_ordinals,
        data,
        mode,
    );
    let visited: HashSet<String> = rendered.iter().cloned().collect();

    // Safety net: any descendant NOT reachable by DFS from the page root
    // (e.g. an orphan whose `parent_id` points outside this subtree while its
    // denormalised `page_id` still names this page) would otherwise be
    // silently dropped — the pre-fix flat loop emitted every descendant. Emit
    // such strays at depth 0 in the read order so the export stays lossless.
    for block in &data.descendants {
        let id = block.id.clone().into_string();
        if visited.contains(&id) {
            continue;
        }
        render_block(output, block, 0, data, &list_ordinals, mode);
        rendered.push(id);
    }
    rendered
}

/// `roots` at depth 0 and everything under them, depth-first in sibling
/// order, each through [`render_block`]. Returns the ids it rendered, in
/// render order.
fn render_subtrees<'a>(
    output: &mut String,
    roots: &[&'a BlockRow],
    children_by_parent: &HashMap<String, Vec<&'a BlockRow>>,
    list_ordinals: &HashMap<String, usize>,
    data: &PageExportData,
    mode: RenderMode,
) -> Vec<String> {
    // Iterative DFS pre-order. A visited set guards against a pathological
    // parent cycle (a block whose ancestor chain loops back) so export can
    // never infinite-loop on corrupt data.
    let mut visited: HashSet<String> = HashSet::new();
    let mut rendered = Vec::new();
    // Stack of (block, depth), pushed in reverse so siblings pop in order.
    let mut stack: Vec<(&BlockRow, usize)> = roots.iter().rev().map(|b| (*b, 0)).collect();
    while let Some((block, depth)) = stack.pop() {
        let id = block.id.clone().into_string();
        if !visited.insert(id.clone()) {
            continue;
        }
        render_block(output, block, depth, data, list_ordinals, mode);
        rendered.push(id.clone());

        // Push this block's children (reversed so they pop in sibling order)
        // at depth + 1.
        if let Some(kids) = children_by_parent.get(&id) {
            for kid in kids.iter().rev() {
                stack.push((kid, depth + 1));
            }
        }
    }
    rendered
}

/// `root` and its subtree as source mode writes them, `root` at depth 0: every
/// block with its `^ID`, which ends a fence the block leaves open and keeps a
/// trailing ` ^word` in its content from reading back as an anchor. A page
/// nested under `root` is not here: `descendants` stops at a nested page.
/// Returns the buffer and the ids it holds, in order.
fn render_subtree_source(data: &PageExportData, root: &BlockRow) -> (String, Vec<String>) {
    let children_by_parent = group_children_by_parent(data.page.id.as_str(), &data.descendants);
    let list_ordinals = compute_list_ordinals(&children_by_parent, &data.list_styles);
    let mut output = String::new();
    let ids = render_subtrees(
        &mut output,
        &[root],
        &children_by_parent,
        &list_ordinals,
        data,
        RenderMode::Source,
    );
    (output, ids)
}

/// Step 1 of the export read half: the page row, refused unless it is an
/// undeleted `page` block.
async fn load_page_row(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<BlockRow, AppError> {
    // 1. Get the page
    //
    // Filter `deleted_at IS NULL` (mirrors `get_active_block_inner`)
    // so a soft-deleted page surfaces as `NotFound` instead of exporting
    // as `# Title\n\n` with no descendants. The descendant walk below
    // already filters `deleted_at IS NULL`, so prior to this fix the page
    // row itself was the only row that could leak. Inlined here (rather
    // than calling `get_active_block_inner`, which takes `&SqlitePool`)
    // so the page read shares the #660 snapshot tx with the walk below.
    let page = sqlx::query_as!(
        BlockRow,
        r#"SELECT id as "id!: agaric_core::ulid::BlockId", block_type, content,
                parent_id as "parent_id: agaric_core::ulid::BlockId", position,
                deleted_at, todo_state, priority, due_date, scheduled_date,
                page_id as "page_id: agaric_core::ulid::BlockId"
           FROM blocks
           WHERE id = ? AND deleted_at IS NULL"#,
        page_id,
    )
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("block '{page_id}'")))?;
    if page.block_type != "page" {
        return Err(AppError::validation("not a page".into()));
    }
    Ok(page)
}

/// Step 2: every undeleted descendant of `page_id`, in render order.
async fn load_descendants(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<Vec<BlockRow>, AppError> {
    // 2. Walk the full descendant subtree, cursor-paginated over the
    //    `(position, id)` keyset on the denormalised `page_id` column.
    //    Loops through every page of results — `next_cursor = None`
    //    ends the walk. Pre-fix this used `list_children` with a hard
    //    `limit = 1000` direct-children cap and silently dropped every
    // Descendant beyond it.
    //
    //    Page size of 200 matches `MAX_PAGE_SIZE` in the pagination
    //    layer; the `+ 1` fetch-limit + `truncate` shape mirrors
    //    `pagination::build_page_response`. `Cursor` and `PageRequest`
    //    are reused from `agaric_store::pagination` as the single source of
    //    truth for keyset cursor encoding (versioning, base64).
    const DESCENDANT_PAGE_SIZE: i64 = 200;
    let mut descendants: Vec<BlockRow> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let req = PageRequest::new(cursor, Some(DESCENDANT_PAGE_SIZE))?;
        let fetch_limit = req.limit + 1;
        let (cursor_flag, cursor_pos, cursor_id): (Option<i64>, i64, &str) =
            match req.after.as_ref() {
                Some(c) => (Some(1), c.position.unwrap_or(NULL_POSITION_SENTINEL), &c.id),
                None => (None, 0, ""),
            };

        // Mirrors `get_page_inner`'s subtree walk: keyset on
        // `(COALESCE(position, sentinel), id)` over `page_id = ?1`, with
        // the page row itself (`id = ?1`) excluded.
        let rows = sqlx::query_as!(
            BlockRow,
            r#"SELECT id as "id!: agaric_core::ulid::BlockId", block_type, content,
                    parent_id as "parent_id: agaric_core::ulid::BlockId", position,
                    deleted_at,
                     todo_state, priority, due_date, scheduled_date,
                    page_id as "page_id: agaric_core::ulid::BlockId"
             FROM blocks
             WHERE page_id = ?1
               AND id != ?1
               AND deleted_at IS NULL
               AND (?2 IS NULL OR (
                    COALESCE(position, ?6) > ?3
                    OR (COALESCE(position, ?6) = ?3 AND id > ?4)))
             ORDER BY COALESCE(position, ?6) ASC, id ASC
             LIMIT ?5"#,
            page_id,                // ?1
            cursor_flag,            // ?2
            cursor_pos,             // ?3
            cursor_id,              // ?4
            fetch_limit,            // ?5
            NULL_POSITION_SENTINEL, // ?6
        )
        .fetch_all(&mut *conn)
        .await?;

        let limit_usize = usize::try_from(req.limit).unwrap_or(usize::MAX);
        let has_more = rows.len() > limit_usize;
        let mut page_rows = rows;
        if has_more {
            page_rows.truncate(limit_usize);
        }

        let next_cursor = if has_more {
            let last = page_rows.last().expect("has_more implies non-empty");
            let cur = Cursor {
                id: last.id.clone().into_string(),
                position: Some(last.position.unwrap_or(NULL_POSITION_SENTINEL)),
                deleted_at: None,
                seq: None,
                rank: None,
            };
            Some(cur.encode()?)
        } else {
            None
        };

        descendants.extend(page_rows);
        match next_cursor {
            None => break,
            Some(s) => cursor = Some(s),
        }
    }
    Ok(descendants)
}

/// Step 2b: block-scoped attachments for the page and its descendants,
/// grouped by owning block.
async fn load_attachments(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    descendants: &[BlockRow],
) -> Result<HashMap<String, Vec<(String, String)>>, AppError> {
    // 2b. (#2961) Batch-fetch block-scoped attachments for the page block
    //     and every descendant, grouped by owning `block_id`.
    //
    //     `attachments` has no "inline" flag: an inline image leaves BOTH a
    //     row here AND a `![filename](attachment:<id>)` token in the owning
    //     block's `content` (same id); a non-image file (or an image
    //     dropped with no editor open) leaves ONLY a row. The render loop
    //     below dedups on that token — via a plain substring check against
    //     `attachment:<id>`, which is reliable because ULIDs are unique —
    //     so inline images aren't double-emitted while block-file
    //     attachments (previously invisible in export) get a link line.
    //
    //     Mirrors `list_attachments_batch_inner`'s `json_each(?)` batching
    //     and the tag/page-reference batching just below: one query for
    //     the whole subtree instead of one per block. Run through the
    //     #660 snapshot tx (`&mut *conn`), before `tx.commit()`, so it
    //     observes the same consistent read as the rest of the export.
    let mut attachment_block_ids: Vec<String> = Vec::with_capacity(descendants.len() + 1);
    attachment_block_ids.push(page_id.to_string());
    for block in descendants {
        attachment_block_ids.push(block.id.clone().into_string());
    }
    let attachment_ids_json = serde_json::to_string(&attachment_block_ids)?;
    let attachment_rows = sqlx::query!(
        r#"SELECT id, block_id, filename FROM attachments
           WHERE block_id IN (SELECT value FROM json_each(?1))
           ORDER BY created_at ASC, id ASC"#,
        attachment_ids_json,
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut attachments_by_block: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for r in attachment_rows {
        attachments_by_block
            .entry(r.block_id)
            .or_default()
            .push((r.id, r.filename));
    }
    Ok(attachments_by_block)
}

/// The `#[…]`, `[[…]]` and `((…))` tokens found in a page's descendants,
/// resolved to the names and links the renderer emits.
struct PageReferences {
    tag_names: HashMap<String, String>,
    page_titles: HashMap<String, String>,
    block_ref_replacement: HashMap<String, String>,
    same_page_ref_targets: HashSet<String>,
}

/// The `#[…]` / `[[…]]` targets and the `((…))` targets a page's descendants
/// mention, deduped. Two sets because they resolve against different things:
/// a tag/page link names its own block, a block reference names its block's
/// PAGE.
fn collect_reference_ulids(descendants: &[BlockRow]) -> (HashSet<String>, HashSet<String>) {
    // #1920 — canonical path (`agaric_store::cache` defines these; `agaric_store::fts::strip`
    // imports them for its own use).
    use agaric_store::cache::{BLOCK_REF_RE, PAGE_LINK_RE, TAG_REF_RE};

    // 3. Batch-resolve tag/page references: regex-extract the union of
    //    `#[ULID]` and `[[ULID]]` tokens from descendant content, then
    //    issue ONE `json_each(?)` query for the deduped ULID set.
    //    Pre-fix two full-table scans loaded every non-deleted tag /
    // Page in the vault on each export.
    //
    //    The block_type discriminator is applied in Rust rather than in
    //    SQL: the union query returns `(id, block_type, content)` and
    //    the loop fans rows into `tag_names` / `page_titles` per type,
    //    preserving the existing maps' semantics (tags drop NULL
    //    content; pages substitute `"Untitled"`).
    //
    //    #2963 — `((ULID))` block references are collected into a SEPARATE set
    //    (`block_ref_ulids`): unlike a tag / page link they can target a block
    //    of ANY type, and export resolves them against the target's PAGE (title
    //    + same-page-vs-cross-page classification), not the block-type fan-out
    //    used for tags/pages — so they need their own query below.
    let mut ulid_set: HashSet<String> = HashSet::new();
    let mut block_ref_ulids: HashSet<String> = HashSet::new();
    for block in descendants {
        if let Some(content) = block.content.as_deref() {
            for cap in TAG_REF_RE.captures_iter(content) {
                ulid_set.insert(cap[1].to_string());
            }
            for cap in PAGE_LINK_RE.captures_iter(content) {
                ulid_set.insert(cap[1].to_string());
            }
            for cap in BLOCK_REF_RE.captures_iter(content) {
                block_ref_ulids.insert(cap[1].to_string());
            }
            // #2968 — also load the tag/page ULIDs embedded inside a structured
            // `{{query v2:…}}` payload (invisible to the plaintext-token regexes
            // above) so they resolve to names in the readable export below.
            super::inline_query_md::collect_export_ref_ulids(content, &mut ulid_set);
        }
    }
    (ulid_set, block_ref_ulids)
}

/// Step 3: one `json_each(?)` query for the whole deduped tag/page target set,
/// fanned into the two maps by block type.
async fn resolve_tag_and_page_names(
    conn: &mut sqlx::SqliteConnection,
    ulid_set: HashSet<String>,
) -> Result<(HashMap<String, String>, HashMap<String, String>), AppError> {
    let mut tag_names: HashMap<String, String> = HashMap::new();
    let mut page_titles: HashMap<String, String> = HashMap::new();
    if !ulid_set.is_empty() {
        let ulids: Vec<String> = ulid_set.into_iter().collect();
        // sqlx requires `String` (NOT `Vec<String>`) for `json_each(?)`
        // binds — encode the set as a JSON array text and bind that.
        let ids_json = serde_json::to_string(&ulids)?;
        let rows = sqlx::query!(
            r#"SELECT id, block_type, content FROM blocks
               WHERE id IN (SELECT value FROM json_each(?1))
                 AND deleted_at IS NULL"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        for r in rows {
            match r.block_type.as_str() {
                "tag" => {
                    if let Some(c) = r.content {
                        tag_names.insert(r.id, c);
                    }
                }
                "page" => {
                    page_titles.insert(r.id, r.content.unwrap_or_else(|| "Untitled".to_string()));
                }
                _ => {}
            }
        }
    }
    Ok((tag_names, page_titles))
}

/// Step 3b: resolve `((ULID))` targets to a roundtrip-safe link, and record
/// which of them live on THIS page and so need an `^<ULID>` anchor marker.
async fn resolve_block_refs(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    block_ref_ulids: HashSet<String>,
) -> Result<(HashMap<String, String>, HashSet<String>), AppError> {
    // 3b. (#2963) Resolve `((ULID))` block references to a human-readable,
    //     roundtrip-safe token, and record which TARGET blocks (those on THIS
    //     page) must carry an Obsidian `^<ULID>` block-anchor marker on their
    //     own exported line so the emitted `[[#^<ULID>]]` link re-imports back
    //     to a real block reference.
    //
    //     For each referenced target we need its owning PAGE (to classify
    //     same-page vs cross-page and, when cross-page, to name it). One
    //     `json_each(?)` query joins each target block to its page block:
    //       * target on THIS page  → emit an anchor-only `[[#^<ULID>]]` link.
    //         The importer's #2510 intra-note anchor pass rewrites it back to a
    //         real `((<new ULID>))` block ref (base is empty ⇒ implicitly this
    //         page), and the `^<ULID>` marker we stamp on the target's line
    //         (see the emit loop) is what that pass matches on. This is the
    //         only form that ROUNDTRIPS to a block ref.
    //       * target on ANOTHER page → emit `[[<Target Page>#^<ULID>]]`. This
    //         renders as a block link in Obsidian, but the importer's
    //         block-anchor resolution is INTRA-NOTE only (a cross-note base
    //         falls through to the #1282 dropped-anchor path), so on re-import
    //         it degrades to a plain page link + a warning rather than a block
    //         ref. Still strictly better than the opaque `((ULID))` (which no
    //         external tool renders and which the importer strips entirely).
    //       * target missing / deleted → absent from the map; the resolver
    //         emits a `(unresolved block reference)` literal (never a raw ULID).
    let mut block_ref_replacement: HashMap<String, String> = HashMap::new();
    let mut same_page_ref_targets: HashSet<String> = HashSet::new();
    if !block_ref_ulids.is_empty() {
        let ulids: Vec<String> = block_ref_ulids.into_iter().collect();
        let ids_json = serde_json::to_string(&ulids)?;
        let rows = sqlx::query!(
            r#"SELECT b.id AS "id!", b.page_id AS "page_id?", p.content AS "page_title?"
               FROM blocks b
               LEFT JOIN blocks p ON p.id = b.page_id
               WHERE b.id IN (SELECT value FROM json_each(?1))
                 AND b.deleted_at IS NULL"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        for r in rows {
            // A target whose denormalised `page_id` equals the page being
            // exported is same-page: anchor-only link + it will get a marker.
            if r.page_id.as_deref() == Some(page_id) {
                same_page_ref_targets.insert(r.id.clone());
                block_ref_replacement.insert(r.id.clone(), format!("[[#^{}]]", r.id));
            } else {
                // Cross-page (or a target with no page, e.g. a page block):
                // name the target's page (fallback "Untitled") so the link is
                // human-readable.
                let title = r.page_title.unwrap_or_else(|| "Untitled".to_string());
                block_ref_replacement.insert(r.id.clone(), format!("[[{title}#^{}]]", r.id));
            }
        }
    }
    Ok((block_ref_replacement, same_page_ref_targets))
}

/// Steps 3 and 3b: one batched lookup per token flavour over the whole subtree.
async fn resolve_references(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    descendants: &[BlockRow],
) -> Result<PageReferences, AppError> {
    let (ulid_set, block_ref_ulids) = collect_reference_ulids(descendants);
    let (tag_names, page_titles) = resolve_tag_and_page_names(conn, ulid_set).await?;
    let (block_ref_replacement, same_page_ref_targets) =
        resolve_block_refs(conn, page_id, block_ref_ulids).await?;
    Ok(PageReferences {
        tag_names,
        page_titles,
        block_ref_replacement,
        same_page_ref_targets,
    })
}

/// Step 4: the page's own frontmatter properties.
async fn load_page_properties(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<Vec<FrontmatterRow>, AppError> {
    // 4. Get page properties for frontmatter.
    //
    // #384: exclude internal/system-managed keys so they don't leak into the
    // exported frontmatter. The explicit list is required because
    // `op::is_builtin_property_key` does NOT cover `space` / `is_space` /
    // `template` (those are space-membership + template markers, not
    // builtin lifecycle keys). The list below is the union of those three
    // plus the lifecycle keys from `is_builtin_property_key` that get
    // stored in `block_properties` (the reserved-column keys —
    // todo_state/priority/due_date/scheduled_date — live on the `blocks`
    // table, never in `block_properties`, so they never appear here).
    //
    // #384: also project value_ref and value_num so numeric and
    // page-reference properties render instead of silently dropping to
    // empty (the old query only selected value_text + value_date).
    //
    // DRIFT WARNING (#3797) — the `key NOT IN (…)` list below is duplicated in
    // FOUR places and nothing checks them against each other. Change one,
    // change all four: (1) here; (2) the descendant-property query further
    // down this function; (3) `FRONTMATTER_RESERVED_KEYS` in
    // `agaric-engine/src/import.rs`; (4) `INLINE_PROPERTY_RESERVED_KEYS` in
    // `src/lib/inline-property-parse.ts`. Copies (1) and (2) are literal SQL,
    // so grepping for either constant name will NOT find them.
    //
    // ASYMMETRY (#4552 slice 4) — `listStyle` is added to the two EXPORT
    // copies (this one and the descendant-property query below) and
    // DELIBERATELY NOT to the two import/parse copies
    // (`FRONTMATTER_RESERVED_KEYS`, `INLINE_PROPERTY_RESERVED_KEYS`). The four
    // copies are not one set with four spellings; they answer two different
    // questions, and `listStyle` answers them differently:
    //
    //   * EXPORT ("may this key be written as a `key:: value` line?") — NO.
    //     A styled block already exports its list-ness as the `- ` / `N. `
    //     marker emitted by the descendant walk below. Emitting the property
    //     line as well would render the marker twice on re-import (once as
    //     structure, once as a visible property row).
    //   * IMPORT ("must this key be refused when it appears in a file?") — NO,
    //     it must be accepted. `listStyle` is an ordinary user-settable
    //     `select` property (migration 0103): typing `listStyle:: bullet`
    //     inline, or hand-writing it in a markdown file, must keep working.
    //     The reserved keys are excluded there because they are column-backed
    //     or lifecycle-managed and would FAIL `set_property_in_tx`;
    //     `listStyle` has no such constraint.
    //
    // So this is an export-only suppression of a REDUNDANT line, not a
    // reservation of the key — and adding `listStyle` to the other two copies
    // would be a regression, not a consistency fix.
    // `src/lib/__tests__/inline-property-parse.test.ts` pins its absence from
    // `INLINE_PROPERTY_RESERVED_KEYS` so a later "add it everywhere" edit
    // fails loudly.
    let property_rows = sqlx::query!(
        r#"SELECT key AS "key!", value_text, value_date, value_num, value_ref,
                  value_bool AS "value_bool: i64"
           FROM block_properties
           WHERE block_id = ?1
             AND key NOT IN (
                'space', 'is_space', 'created_at', 'completed_at',
                'repeat-seq', 'repeat-origin', 'template', 'listStyle'
             )"#,
        page_id,
    )
    .fetch_all(&mut *conn)
    .await?;

    let properties: Vec<FrontmatterRow> = property_rows
        .into_iter()
        // #2722 — never emit a `block_properties` row named `aliases`/`tags` as
        // a property line: those keys are emitted as frontmatter from their OWN
        // sources (`page_aliases` rows / `block_tags` associations, read in step
        // 4b below). A page carrying a legacy stale `aliases`/`tags` TEXT
        // property (left by a pre-#2722 re-import) would otherwise DOUBLE-emit
        // the key (a duplicate YAML key). Filtered in Rust — not the SQL `NOT
        // IN` — so the query string (and its offline `.sqlx` entry) is
        // unchanged. New imports intercept both keys and never create such rows,
        // so this is the belt-and-braces guard for pre-existing data.
        .filter(|r| r.key != "aliases" && r.key != "tags")
        .map(|r| FrontmatterRow {
            key: r.key,
            value_text: r.value_text,
            value_date: r.value_date,
            value_num: r.value_num,
            value_ref: r.value_ref,
            value_bool: r.value_bool,
        })
        .collect();
    Ok(properties)
}

/// Step 4a's two maps: `key:: value` rows per descendant, and the list-style
/// marker each descendant renders with.
struct DescendantProperties {
    properties: HashMap<String, Vec<FrontmatterRow>>,
    list_styles: HashMap<String, String>,
}

/// Step 4a: both maps in one pass over the subtree.
async fn load_descendant_properties(
    conn: &mut sqlx::SqliteConnection,
    descendants: &[BlockRow],
) -> Result<DescendantProperties, AppError> {
    // 4a. (#2962) Batch-read `block_properties` for EVERY descendant block in
    // ONE query — mirrors the page-property batch read directly above — so
    // custom `key:: value` properties on descendant blocks round-trip
    // through export instead of being silently dropped (pre-fix, only the 4
    // reserved `blocks` columns were emitted per descendant; any custom
    // `block_properties` row was invisible to the exporter even though
    // import faithfully parses and persists it).
    //
    // The exclusion list is identical to the page-property query above: the
    // import parser (`FRONTMATTER_RESERVED_KEYS` in
    // `agaric-engine::import::parse_logseq_markdown`) filters this exact key
    // set from EVERY block's body `key:: value` lines — page AND
    // descendant alike — before it ever reaches `block_properties`, so no
    // descendant row can carry one of these keys. The `NOT IN` here is
    // therefore belt-and-braces symmetry with the page query, not new
    // behavior. The recurrence rule (`repeat`, `repeat-until`,
    // `repeat-count`) is emitted, so a duplicate, a copy and an export keep a
    // repeating task repeating (#5160 P4); `repeat-seq` and `repeat-origin`
    // describe one occurrence and stay out.
    //
    // The 4 reserved `blocks` columns (todo_state/priority/scheduled_date/
    // due_date) need no exclusion here: migration 0088's `key_not_reserved`
    // CHECK constraint forbids them from ever landing in `block_properties`
    // at all, so they simply cannot appear in these rows. They continue to
    // be emitted from the `blocks` columns in the descendant walk below,
    // exactly as before.
    //
    // DRIFT WARNING (#3797) — the `key NOT IN (…)` list below is duplicated in
    // FOUR places and nothing checks them against each other. Change one,
    // change all four: (1) here; (2) the page-property query above; (3)
    // `FRONTMATTER_RESERVED_KEYS` in `agaric-engine/src/import.rs`; (4)
    // `INLINE_PROPERTY_RESERVED_KEYS` in `src/lib/inline-property-parse.ts`.
    // Copies (1) and (2) are literal SQL, so grepping for either constant name
    // will NOT find them.
    //
    // #4552 slice 4 — `listStyle` is excluded HERE (and in the page query
    // above) but NOT from the two import-side copies; the full rationale for
    // that deliberate asymmetry is on the page-property query above. In short:
    // the descendant walk below emits this block's list-ness as a `- ` / `N. `
    // MARKER, so a `listStyle:: ordered` line here would be a duplicate
    // rendering of the same fact — while an inline / hand-written
    // `listStyle:: bullet` must still IMPORT, which is why the import copies
    // are left alone. This one is NOT belt-and-braces symmetry with the import
    // filter: it is load-bearing, because the importer does write `listStyle`
    // rows.
    let descendant_ids: Vec<String> = descendants
        .iter()
        .map(|b| b.id.clone().into_string())
        .collect();
    let mut descendant_properties: HashMap<String, Vec<FrontmatterRow>> = HashMap::new();
    // #4552 slice 4 — `listStyle` per descendant, read SEPARATELY because the
    // query above now excludes it (see the asymmetry comment there). It is not
    // a `key:: value` property line in the export; it is the input to the
    // `- ` / `N. ` MARKER the descendant walk emits, so it needs its own map
    // rather than a row in `descendant_properties`. Only the `value_text`
    // column is read: `listStyle` is a `select`-typed definition (migration
    // 0103) whose values are the plain strings `bullet` / `ordered`.
    let mut list_styles: HashMap<String, String> = HashMap::new();
    if !descendant_ids.is_empty() {
        let ids_json = serde_json::to_string(&descendant_ids)?;
        let style_rows = sqlx::query!(
            r#"SELECT block_id AS "block_id!", value_text
               FROM block_properties
               WHERE block_id IN (SELECT value FROM json_each(?1))
                 AND key = 'listStyle'"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        for r in style_rows {
            // Absent / unrecognised means `none` — mirrors `asListStyle` in
            // `src/lib/list-style.ts`, so a stray row never emits a marker the
            // renderer would not draw.
            if let Some(v) = r.value_text.filter(|v| v == "bullet" || v == "ordered") {
                list_styles.insert(r.block_id, v);
            }
        }
        let rows = sqlx::query!(
            r#"SELECT block_id AS "block_id!", key AS "key!", value_text, value_date,
                      value_num, value_ref, value_bool AS "value_bool: i64"
               FROM block_properties
               WHERE block_id IN (SELECT value FROM json_each(?1))
                 AND key NOT IN (
                    'space', 'is_space', 'created_at', 'completed_at',
                    'repeat-seq', 'repeat-origin', 'template', 'listStyle'
                 )
               ORDER BY block_id ASC, key ASC"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        for r in rows {
            descendant_properties
                .entry(r.block_id)
                .or_default()
                .push(FrontmatterRow {
                    key: r.key,
                    value_text: r.value_text,
                    value_date: r.value_date,
                    value_num: r.value_num,
                    value_ref: r.value_ref,
                    value_bool: r.value_bool,
                });
        }
    }

    Ok(DescendantProperties {
        properties: descendant_properties,
        list_styles,
    })
}

/// Resolves every `value_ref` reached by the page's and its descendants'
/// properties to a page title.
async fn resolve_property_ref_titles(
    conn: &mut sqlx::SqliteConnection,
    page_properties: &[FrontmatterRow],
    descendant_properties: &HashMap<String, Vec<FrontmatterRow>>,
) -> Result<HashMap<String, String>, AppError> {
    // Resolve value_ref ULIDs to page titles where possible. Unresolved
    // refs (target missing/deleted) fall back to the raw ULID so the value
    // never renders empty. Covers BOTH the page's own properties and every
    // descendant block's properties in the single batched lookup below.
    let mut ref_ids: HashSet<String> = HashSet::new();
    for r in page_properties {
        if let Some(rf) = r.value_ref.as_deref()
            && !rf.is_empty()
        {
            ref_ids.insert(rf.to_string());
        }
    }
    for rows in descendant_properties.values() {
        for r in rows {
            if let Some(rf) = r.value_ref.as_deref()
                && !rf.is_empty()
            {
                ref_ids.insert(rf.to_string());
            }
        }
    }
    let mut ref_titles: HashMap<String, String> = HashMap::new();
    if !ref_ids.is_empty() {
        let ids: Vec<String> = ref_ids.into_iter().collect();
        let ids_json = serde_json::to_string(&ids)?;
        let rows = sqlx::query!(
            r#"SELECT id, content FROM blocks
               WHERE id IN (SELECT value FROM json_each(?1))
                 AND deleted_at IS NULL"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        for r in rows {
            if let Some(c) = r.content {
                ref_titles.insert(r.id, c);
            }
        }
    }
    Ok(ref_titles)
}

/// Step 4b: the page's aliases and tag names, both frontmatter-only.
async fn load_frontmatter_lists(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<(Vec<String>, Vec<String>), AppError> {
    // 4b. (#1433) Read the page's aliases and tag names for frontmatter.
    //
    // Aliases come straight from `page_aliases`, sorted alphabetically so
    // the exported sequence is deterministic (mirrors
    // `get_page_aliases_inner`'s `ORDER BY alias`). Read through the #660
    // snapshot tx so they observe the same consistent state as the rest of
    // the export.
    let aliases: Vec<String> = sqlx::query_scalar!(
        "SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias",
        page_id,
    )
    .fetch_all(&mut *conn)
    .await?;

    // Tags are the tag blocks explicitly associated with the page block via
    // `block_tags`; the human-readable NAME is the tag block's `content`.
    // We emit names (not ULIDs). NULL-content tag blocks are skipped, and
    // the results are ordered by name (NOCASE, matching the `tags_cache`
    // UNIQUE index collation) then id for a stable, reproducible sequence.
    let tag_names_fm: Vec<String> = sqlx::query_scalar!(
        r#"SELECT t.content AS "content!"
             FROM block_tags bt
             JOIN blocks t ON t.id = bt.tag_id
            WHERE bt.block_id = ?1
              AND t.block_type = 'tag'
              AND t.deleted_at IS NULL
              AND t.content IS NOT NULL
            ORDER BY t.content COLLATE NOCASE ASC, t.id ASC"#,
        page_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok((aliases, tag_names_fm))
}

/// Export a page and its full descendant subtree as a Markdown string with
/// human-readable tag/page references and optional YAML frontmatter.
///
/// 1. Emits `# Page Title`
/// 2. If the page has properties, emits a `---` YAML frontmatter block
/// 3. For each descendant block — direct children **and** transitively
///    nested blocks — ordered by `(position, id)` over the keyset,
///    resolves `#[ULID]` and `[[ULID]]` references to their human-readable
///    names, preserving all markdown formatting.
///
/// The descendant walk is cursor-paginated through the denormalized
/// `page_id` column (`idx_blocks_page_id`) and accumulates every page of
/// rows into a single `Vec<BlockRow>` — there is no silent truncation.
/// Tag and page reference targets are resolved with one batched
/// `json_each(?)` query: pre-fix the function loaded *every*
/// non-deleted tag and page in the vault on every export.
///
/// # Errors
///
/// - [`AppError::Validation`] — `page_id` does not refer to a `page` block
/// - [`AppError::NotFound`] — block not found
#[instrument(skip(pool), err)]
pub async fn export_page_markdown_inner(
    pool: &SqlitePool,
    page_id: &str,
) -> Result<String, AppError> {
    // Validate ULID format upfront so malformed inputs surface
    // `AppError::Ulid` rather than the imprecise `AppError::NotFound`
    // that the SQL `WHERE id = ?` lookup would otherwise produce.
    BlockId::from_string(page_id)?;

    // #660 — open ONE read transaction and run every read below through
    // it so the entire export observes a single, consistent WAL
    // snapshot. Pre-fix the keyset descendant walk issued N independent
    // `fetch_all(pool)` calls, each taking its own snapshot; a
    // concurrent edit/move/delete landing between two pages of the
    // keyset could skip or duplicate blocks in the exported markdown.
    // `pool.begin()` opens a `BEGIN DEFERRED` transaction (read-only —
    // every statement here is a SELECT, so no writer lock is taken);
    // SQLite pins the snapshot at the first read and holds it until the
    // tx drops. The page-row lookup, descendant walk, reference
    // resolution and property reads all execute against `&mut *tx`, so
    // they cannot interleave with a concurrent writer's commit.
    let mut tx = pool.begin().await?;
    let data = load_page_export_data(&mut tx, page_id, PageRead::Export).await?;

    // #660 — all reads are done; release the snapshot tx. A read-only
    // `BEGIN DEFERRED` tx takes no writer lock, so the `commit` here is
    // effectively a rollback (nothing was written); committing rather
    // than letting the tx drop makes the snapshot-release point explicit
    // and returns the connection to the pool promptly.
    tx.commit().await?;

    // 5. Render. The read half above is the only thing that touches the
    //    database; everything below is a pure function of what it resolved
    //    (#4639).
    Ok(render_page_markdown(page_id, &data))
}

/// The page's source-mode markdown buffer (#5140): its block tree as
/// `render_page_source` writes it. The page and tag names it may write are
/// resolved in the same read snapshot as the content.
///
/// # Errors
///
/// As [`export_page_markdown_inner`].
#[instrument(skip(pool), err)]
pub async fn get_page_source_inner(pool: &SqlitePool, page_id: &str) -> Result<String, AppError> {
    BlockId::from_string(page_id)?;
    let mut tx = pool.begin().await?;
    let data = load_page_export_data(&mut tx, page_id, PageRead::Source).await?;
    tx.commit().await?;
    Ok(render_page_source(&data))
}

/// The blocks `block_ids` names as the clipboard carries them (#5140): the
/// page's source buffer for just those blocks, each with its subtree unless
/// `with_children` is false, in document order, and with a `^ID` only where a
/// block needs one to read back. The page is the first live content block's;
/// an id that is not a live content block of that page is skipped, and so is
/// one under another selected block, which carries it. Nothing to copy is `""`.
///
/// # Errors
///
/// - [`AppError::Validation`] — more ids than one batch takes, or a copied
///   block holds a property value with a line break, which would paste back
///   as other content
#[instrument(skip(pool, block_ids), err)]
pub async fn get_blocks_source_inner(
    pool: &SqlitePool,
    block_ids: Vec<BlockId>,
    with_children: bool,
) -> Result<String, AppError> {
    crate::commands::ensure_batch_within_cap("block_ids", block_ids.len())?;
    let ids: Vec<String> = block_ids.into_iter().map(BlockId::into_string).collect();
    let ids_json = serde_json::to_string(&ids)?;
    let mut tx = pool.begin().await?;
    let page_id = sqlx::query_scalar!(
        r#"SELECT b.page_id AS "page_id!: String"
             FROM json_each(?1) je
             JOIN blocks b ON b.id = je.value
            WHERE b.deleted_at IS NULL
              AND b.block_type = 'content'
              AND b.page_id IS NOT NULL
            ORDER BY je.key
            LIMIT 1"#,
        ids_json,
    )
    .fetch_optional(&mut *tx)
    .await?;
    let Some(page_id) = page_id else {
        return Ok(String::new());
    };
    let data = load_page_export_data(&mut tx, &page_id, PageRead::Source).await?;
    tx.commit().await?;
    render_clipboard_source(&data, &ids, with_children)
}

/// The selected blocks of `data`'s page no other selected block holds, in
/// document order, each at depth 0, with its subtree when `with_children`.
/// Refused when a rendered block holds a property value with a line break:
/// its `key:: value` line would read back as content or another block.
fn render_clipboard_source(
    data: &PageExportData,
    selected: &[String],
    with_children: bool,
) -> Result<String, AppError> {
    let children_by_parent = group_children_by_parent(data.page.id.as_str(), &data.descendants);
    let list_ordinals = compute_list_ordinals(&children_by_parent, &data.list_styles);
    let selected: HashSet<&str> = selected.iter().map(String::as_str).collect();
    let mut roots = Vec::new();
    let mut stack: Vec<&BlockRow> = children_by_parent
        .get(data.page.id.as_str())
        .map_or(Vec::new(), |kids| kids.iter().rev().copied().collect());
    while let Some(block) = stack.pop() {
        if selected.contains(block.id.as_str()) {
            roots.push(block);
        } else if let Some(kids) = children_by_parent.get(block.id.as_str()) {
            stack.extend(kids.iter().rev());
        }
    }
    let no_children = HashMap::new();
    let children = if with_children {
        &children_by_parent
    } else {
        &no_children
    };
    let mut output = String::new();
    let rendered = render_subtrees(
        &mut output,
        &roots,
        children,
        &list_ordinals,
        data,
        RenderMode::Clipboard,
    );
    let no_titles = HashMap::new();
    let multiline = rendered.iter().find(|id| {
        data.descendant_properties.get(*id).is_some_and(|props| {
            props
                .iter()
                .any(|prop| frontmatter_row_value(prop, &no_titles).contains(['\n', '\r']))
        })
    });
    if let Some(id) = multiline {
        return Err(AppError::validation(format!(
            "block '{id}' holds a property value with a line break, which copy cannot carry"
        )));
    }
    Ok(output)
}

/// Copy a content block and its content subtree to right after the original
/// (#5140), as one transaction and so one undo. The subtree is rendered as a
/// source buffer and parsed back, so the copy carries what that buffer
/// carries: content verbatim with its raw refs, the list marker, the task
/// state, priority and dates, and the custom properties. A nested page is not
/// copied. Returns every created row, the root copy first, then its
/// descendants depth-first.
///
/// # Errors
///
/// - [`AppError::Ulid`] — `block_id` is not a ULID
/// - [`AppError::NotFound`] — no block has that id
/// - [`AppError::Validation`] — the block is soft-deleted or not a content
///   block, a copied value doesn't read back from the source grammar (a
///   property value with a line break), the copy would append more ops than
///   one undo reverts, or a copied block would be nested past
///   `MAX_BLOCK_DEPTH`
#[instrument(skip(pool, device_id, materializer), err)]
pub async fn duplicate_block_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    block_id: BlockId,
) -> Result<Vec<BlockRow>, AppError> {
    let block_id = BlockId::from_string(block_id.into_string())?;
    let mut tx = CommandTx::begin_immediate(pool, "duplicate_block").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let root = agaric_engine::block_ops::fetch_live_block_in_tx(&mut tx, block_id.as_str()).await?;
    if root.block_type != "content" {
        return Err(AppError::validation(format!(
            "only a content block can be duplicated, not a '{}'",
            root.block_type
        )));
    }
    let page_id = root
        .page_id
        .clone()
        .ok_or_else(|| AppError::validation(format!("block '{block_id}' is on no page")))?;
    let data = load_page_export_data(&mut tx, page_id.as_str(), PageRead::Duplicate).await?;
    let (source, ids) = render_subtree_source(&data, &root);
    let parsed = import::parse_source_outline(&source);
    // A value the grammar cannot carry, such as a property value with a line
    // break, reads back as extra text or an extra block: refuse, never write a
    // mangled copy.
    let anchors = parsed.blocks.iter().map(|b| b.block_anchor.as_deref());
    if !anchors.eq(ids.iter().map(|id| Some(id.as_str()))) {
        return Err(AppError::validation(format!(
            "block '{block_id}' holds a value Duplicate cannot copy"
        )));
    }
    let lines = PropertyLines::load(&mut tx, PropertyWrite::Copy).await?;
    let parent_id = root.parent_id.map(BlockId::into_string);
    let siblings =
        super::super::blocks::move_ops::ordered_live_children(&mut tx, parent_id.as_deref())
            .await?;
    let index = siblings
        .iter()
        .position(|id| id == block_id.as_str())
        .map(|slot| i64::try_from(slot + 1).expect("a Vec index fits in i64"));
    // Boxed: inline, the copy loop's future makes this one too large for the
    // stack (`clippy::large_futures`).
    let created = Box::pin(create_parsed_blocks(
        &mut tx,
        materializer,
        device_id,
        parent_id,
        index,
        &parsed.blocks,
        &lines,
    ))
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    Ok(created)
}

/// What a paste carries: clipboard text, or blocks already split.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PasteInput {
    Text { text: String },
    Blocks { blocks: Vec<PastedBlock> },
}

/// One pasted block: its content verbatim and its depth under the paste.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct PastedBlock {
    pub content: String,
    pub depth: u32,
}

impl PasteInput {
    /// The blocks the input holds. After text (#5160 D4) the first of an HTML
    /// paste's blocks is the text it was pasted as, so its `- [ ] ` checkbox
    /// stays text as a plain item's `- ` does.
    fn into_blocks(self, after_text: bool) -> Vec<import::ParsedBlock> {
        match self {
            Self::Text { text } => import::parse_pasted_text(&text),
            Self::Blocks { blocks } => blocks
                .into_iter()
                .enumerate()
                .map(|(at, block)| {
                    let depth = block.depth as usize;
                    if at == 0 && after_text {
                        import::verbatim_block(block.content, depth)
                    } else {
                        import::pasted_block(block.content, depth)
                    }
                })
                .collect(),
        }
    }
}

/// Reply of [`paste_blocks`], in the envelope [`CreatedBlocks`] uses.
#[derive(Debug, Clone, Serialize, Type)]
pub struct PastedBlocks {
    /// The pages and tags the paste created, then the pasted blocks in
    /// document order.
    pub blocks: Vec<BlockRow>,
    /// Each property line the paste kept as text and each name it left as
    /// text, named (#5160 D11).
    pub warnings: Vec<String>,
}

/// A paste into the anchor block's text (#5160 D4): its content before and
/// after the cursor, with any selection already cut out.
#[derive(Debug, Clone, Deserialize, Type)]
pub struct PasteSplice {
    pub before: String,
    pub after: String,
}

impl PasteSplice {
    /// Join the pasted blocks into the anchor's text as a text editor does:
    /// the text before the cursor starts the first block, the text after it
    /// ends the last. After text, the first block joins as the text it was
    /// pasted as ([`pasted_as_text`]), so the anchor stays what it is. After
    /// a last block that is code, the text after the cursor is a block of its
    /// own at its depth, so the fence keeps its closing line.
    fn join(self, blocks: &mut Vec<import::ParsedBlock>) {
        let Self { before, after } = self;
        if let Some(first) = blocks.first_mut()
            && !before.is_empty()
        {
            first.content = pasted_as_text(first, before.ends_with('\n'));
            first.properties.clear();
        }
        match blocks.last_mut() {
            Some(last) if last.is_code && !after.is_empty() => {
                let depth = last.depth;
                blocks.push(import::verbatim_block(after, depth));
            }
            Some(last) => last.content.push_str(&after),
            None => {}
        }
        if let Some(first) = blocks.first_mut() {
            first.content.insert_str(0, &before);
        }
    }
}

/// `block` as the text it was pasted as, for a paste after text (#5160 D4):
/// the list marker and checkbox the parse read into properties back before
/// its text, and its other properties back as `key:: value` lines, as Source
/// mode writes them. Text that `starts_line` is escaped as Source mode escapes
/// a first line, so no marker in it is read back.
fn pasted_as_text(block: &import::ParsedBlock, starts_line: bool) -> String {
    // The last value of a key is the one a paste writes.
    let mut properties: Vec<(&str, &str)> = Vec::new();
    for (key, value) in &block.properties {
        properties.retain(|(k, _)| k != key);
        properties.push((key.as_str(), value.as_str()));
    }
    let mut marker = |key: &str, write: fn(&str) -> Option<String>| {
        let at = properties.iter().position(|(k, _)| *k == key)?;
        let marker = write(properties[at].1)?;
        properties.remove(at);
        Some(marker)
    };
    let list = marker(import::LIST_STYLE_KEY, |style| match style {
        import::LIST_STYLE_BULLET => Some("- ".to_owned()),
        import::LIST_STYLE_ORDERED => Some("1. ".to_owned()),
        _ => None,
    });
    let task = marker("todo_state", |state| {
        import::task_marker_for(state).map(|c| format!("[{c}] "))
    });
    let markers = format!("{}{}", list.unwrap_or_default(), task.unwrap_or_default());
    let mut text = if block.content.is_empty() {
        markers.trim_end().to_owned()
    } else {
        markers + &block.content
    };
    if starts_line && first_line_needs_escape(&text, "", "", RenderMode::Source) {
        text.insert(0, '\\');
    }
    for (key, value) in properties {
        text.push_str(&format!("\n{key}:: {value}"));
    }
    text
}

/// Paste `input` right after the anchor block (#5140), as one transaction and
/// so one undo. Text is read by [`import::parse_pasted_text`]; each of
/// `blocks` is one block as it comes. A page link or tag written as a name is
/// resolved in the anchor's space as an import resolves it, creating the page
/// or tag when no name there matches; ids and block refs stay as written, and
/// an `^anchor` in the text never pairs with a block. The top-level blocks
/// land in order right after the anchor among its siblings, each deeper one
/// under its parsed parent, with its task state, priority, dates, list style
/// and properties. Returns the pages and tags the names created, then the
/// pasted blocks in document order.
///
/// With a `splice`, the paste goes into the anchor's text (#5160 D4). The
/// anchor becomes the first block, `before` + its content, and keeps its id,
/// place, other properties and children: with nothing before the cursor, as
/// at the start of a plain paragraph, it takes the first block's properties;
/// after text it takes the block as the text it was pasted as. A heading's or
/// a quote's marker is text before the cursor, so such a block keeps its type
/// and takes the first line as text. The first block's children follow the
/// anchor's own; `after` ends the last block, or follows a last block that is
/// code as a block of its own. The anchor is then the first pasted block
/// returned. The names in `before` and `after` are left as they are.
///
/// A property line a definition refuses stays text at the end of its block,
/// and a name that ties between two pages stays text; the reply's warnings
/// name each (#5160 D11).
///
/// # Errors
///
/// - [`AppError::Ulid`] — `anchor_block_id` is not a ULID
/// - [`AppError::NotFound`] — no block has that id
/// - [`AppError::Validation`] — the input holds no block, the anchor is
///   soft-deleted or not a content block, the paste would append more ops
///   than one undo reverts, or a block would be nested past `MAX_BLOCK_DEPTH`
#[instrument(skip(pool, device_id, materializer, input, splice), err)]
pub async fn paste_blocks_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    anchor_block_id: BlockId,
    input: PasteInput,
    splice: Option<PasteSplice>,
) -> Result<PastedBlocks, AppError> {
    let anchor_id = BlockId::from_string(anchor_block_id.into_string())?;
    let mut blocks = input.into_blocks(splice.as_ref().is_some_and(|s| !s.before.is_empty()));
    if blocks.is_empty() {
        return Err(AppError::validation("there is nothing to paste".into()));
    }
    let mut tx = CommandTx::begin_immediate(pool, "paste_blocks").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort).
    tx.arm_engine_rollback(materializer.loro_state());
    let anchor =
        agaric_engine::block_ops::fetch_live_block_in_tx(&mut tx, anchor_id.as_str()).await?;
    if anchor.block_type != "content" {
        return Err(AppError::validation(format!(
            "blocks can only be pasted after a content block, not a '{}'",
            anchor.block_type
        )));
    }
    let (lines, mut warnings) = read_pasted_properties(&mut tx, &anchor, &mut blocks).await?;
    // Both passes are boxed for the reason `duplicate_block_inner` gives.
    let (mut tx, mut created) = Box::pin(resolve_pasted_names(
        tx,
        materializer,
        device_id,
        &anchor,
        &mut blocks,
        &mut warnings,
    ))
    .await?;
    let parent_id = anchor.parent_id.map(BlockId::into_string);
    let siblings =
        super::super::blocks::move_ops::ordered_live_children(&mut tx, parent_id.as_deref())
            .await?;
    let index = siblings
        .iter()
        .position(|id| id == anchor_id.as_str())
        .map(|slot| i64::try_from(slot + 1).expect("a Vec index fits in i64"));
    let spliced = match splice {
        Some(splice) => {
            splice.join(&mut blocks);
            let into = Box::pin(splice_into_anchor(
                &mut tx,
                materializer,
                &lines,
                device_id,
                &anchor_id,
                &blocks,
            ));
            into.await?
        }
        None => Vec::new(),
    };
    let pasted = Box::pin(create_parsed_blocks(
        &mut tx,
        materializer,
        device_id,
        parent_id,
        index,
        &blocks[spliced.len()..],
        &lines,
    ))
    .await?;
    tx.commit_and_dispatch(materializer).await?;
    created.extend(spliced);
    created.extend(pasted);
    Ok(PastedBlocks {
        blocks: created,
        warnings,
    })
}

/// Read the property lines of `blocks`, pasted after `anchor`, in its space
/// (#5160 D11, D13): each key canonical, and each value a definition refuses
/// kept as text, named in the returned warnings.
async fn read_pasted_properties(
    tx: &mut CommandTx,
    anchor: &BlockRow,
    blocks: &mut [import::ParsedBlock],
) -> Result<(PropertyLines, Vec<String>), AppError> {
    let space = agaric_store::space::resolve_block_space(&mut ***tx, &anchor.id).await?;
    let mut lines = PropertyLines::load(tx, PropertyWrite::Paste).await?;
    lines
        .resolve_refs(tx, space.as_ref().map(SpaceId::as_str), blocks)
        .await?;
    let mut warnings = Vec::new();
    lines.keep_refused_as_text(blocks, &mut warnings);
    Ok((lines, warnings))
}

/// Write the first of `blocks` into the anchor (#5160 D4): its content and
/// properties, with the task stamps its state change implies, and its children
/// after the anchor's own. Returns the anchor, then those children: one row for
/// each block it took.
async fn splice_into_anchor(
    tx: &mut CommandTx,
    materializer: &Materializer,
    lines: &PropertyLines,
    device_id: &str,
    anchor_id: &BlockId,
    blocks: &[import::ParsedBlock],
) -> Result<Vec<BlockRow>, AppError> {
    let (first, rest) = blocks.split_first().expect("a paste holds a block");
    let id = anchor_id.as_str();
    let loro = materializer.loro_state();
    let prior = super::super::properties::resolve_prior_task_states_batch(
        tx,
        std::slice::from_ref(anchor_id),
    )
    .await?
    .remove(id)
    .unwrap_or_default();
    let anchor = super::super::blocks::crud::edit_block_in_tx(
        tx,
        loro,
        device_id,
        id.to_owned(),
        first.content.clone(),
    )
    .await?;
    apply_block_properties(tx, materializer, device_id, id, &first.properties, lines).await?;
    if let Some(state) = parsed_todo_state(first) {
        super::super::properties::write_todo_timestamp_transitions_in_tx(
            tx,
            loro,
            device_id,
            id,
            &prior,
            Some(state),
        )
        .await?;
    }
    crate::commands::ensure_batch_within_cap("ops", tx.pending_len())?;
    let children = rest.iter().take_while(|b| b.depth > first.depth).count();
    let mut rows = vec![anchor];
    rows.extend(
        Box::pin(create_parsed_blocks(
            tx,
            materializer,
            device_id,
            Some(id.to_owned()),
            None,
            &rest[..children],
            lines,
        ))
        .await?,
    );
    Ok(rows)
}

/// Resolve the page links and tags `blocks` write as names in `anchor`'s
/// space, creating what no name there matches, and write each block's content
/// with their ids. Returns the pages and tags created; a name left as text is
/// named in `warnings`. With no space, every name stays text.
async fn resolve_pasted_names(
    mut tx: CommandTx,
    materializer: &Materializer,
    device_id: &str,
    anchor: &BlockRow,
    blocks: &mut [import::ParsedBlock],
    warnings: &mut Vec<String>,
) -> Result<(CommandTx, Vec<BlockRow>), AppError> {
    let Some(space) = agaric_store::space::resolve_block_space(&mut **tx, &anchor.id).await? else {
        return Ok((tx, Vec::new()));
    };
    let mut names = NameCtx {
        materializer,
        device_id,
        space_id: space.as_str(),
        page_id: anchor.page_id.as_ref().map_or("", BlockId::as_str),
        warnings,
        created: Vec::new(),
    };
    let (tx, links) = resolve_inbound_page_links(&mut names, tx, blocks).await?;
    let (tx, _, tag_tokens, _) = resolve_inbound_tags(&mut names, tx, blocks).await?;
    for block in blocks.iter_mut() {
        block.content =
            rewrite_block_content_for_import(block, &links.page_links, &links.titles, &tag_tokens);
    }
    Ok((tx, names.created))
}

/// The `todo_state` a parsed block carries, from its checkbox or a property
/// line.
fn parsed_todo_state(block: &import::ParsedBlock) -> Option<&str> {
    block
        .properties
        .iter()
        .rev()
        .find(|(key, _)| key == "todo_state")
        .map(|(_, value)| value.as_str())
}

/// Create parsed blocks: the k-th depth-0 block at `index + k` among
/// `parent_id`'s children, each deeper block appended under its parsed parent.
/// A block's properties and task stamp are written right after it, so its ops
/// stay together in the log. Refused, and so rolled back, the moment the
/// transaction holds more ops than one undo reverts.
async fn create_parsed_blocks(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    parent_id: Option<String>,
    index: Option<i64>,
    blocks: &[import::ParsedBlock],
    lines: &PropertyLines,
) -> Result<Vec<BlockRow>, AppError> {
    let mut created = Vec::with_capacity(blocks.len());
    let mut open: Vec<(usize, String)> = Vec::new();
    let mut top_level: i64 = 0;
    for block in blocks {
        while open.last().is_some_and(|(depth, _)| *depth >= block.depth) {
            open.pop();
        }
        let (parent, slot) = if let Some((_, id)) = open.last() {
            (Some(id.clone()), None)
        } else {
            let slot = index.map(|i| i.saturating_add(top_level));
            top_level += 1;
            (parent_id.clone(), slot)
        };
        let (row, op) = create_block_in_tx(
            tx,
            materializer.loro_state(),
            device_id,
            "content".into(),
            block.content.clone(),
            parent,
            slot,
            None,
        )
        .await?;
        tx.enqueue_background(op);
        let id = row.id.clone().into_string();
        apply_block_properties(tx, materializer, device_id, &id, &block.properties, lines).await?;
        if let Some(state) = parsed_todo_state(block) {
            super::super::properties::write_todo_timestamp_transitions_in_tx(
                tx,
                materializer.loro_state(),
                device_id,
                &id,
                &super::super::properties::PriorTaskState::default(),
                Some(state),
            )
            .await?;
        }
        crate::commands::ensure_batch_within_cap("ops", tx.pending_len())?;
        open.push((block.depth, id));
        created.push(row);
    }
    Ok(created)
}

/// Steps 1-4b: every read the page is rendered from, through the caller's
/// snapshot. What `read` does not need is left empty.
async fn load_page_export_data(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    read: PageRead,
) -> Result<PageExportData, AppError> {
    let export = read == PageRead::Export;
    let page = load_page_row(conn, page_id).await?;
    let descendants = load_descendants(conn, page_id).await?;
    let attachments_by_block = if export {
        load_attachments(conn, page_id, &descendants).await?
    } else {
        HashMap::new()
    };
    let refs = resolve_references(conn, page_id, &descendants).await?;
    let properties = if export {
        load_page_properties(conn, page_id).await?
    } else {
        Vec::new()
    };
    let descendant = load_descendant_properties(conn, &descendants).await?;
    let ref_titles = if export {
        resolve_property_ref_titles(conn, &properties, &descendant.properties).await?
    } else {
        HashMap::new()
    };
    let (aliases, tag_names_fm) = if export {
        load_frontmatter_lists(conn, page_id).await?
    } else {
        (Vec::new(), Vec::new())
    };
    let name_snapshot = if read == PageRead::Source {
        load_name_snapshot(conn, &page.id, &descendants, &refs.page_titles).await?
    } else {
        NameSnapshot::default()
    };
    Ok(PageExportData {
        page,
        descendants,
        attachments_by_block,
        tag_names: refs.tag_names,
        page_titles: refs.page_titles,
        block_ref_replacement: refs.block_ref_replacement,
        same_page_ref_targets: refs.same_page_ref_targets,
        descendant_properties: descendant.properties,
        list_styles: descendant.list_styles,
        ref_titles,
        properties,
        aliases,
        tag_names_fm,
        name_snapshot,
    })
}

/// What the importer would resolve the page's referenced names against: its
/// space's pages the link bodies the render writes may name, and its space's
/// tags. A page in no space gets the empty snapshot, so every name stays raw.
async fn load_name_snapshot(
    conn: &mut sqlx::SqliteConnection,
    page_id: &BlockId,
    descendants: &[BlockRow],
    page_titles: &HashMap<String, String>,
) -> Result<NameSnapshot, AppError> {
    let Some(space) = agaric_store::space::resolve_block_space(&mut *conn, page_id).await? else {
        return Ok(NameSnapshot::default());
    };
    let bodies = rendered_link_bodies(descendants, page_titles);
    Ok(NameSnapshot {
        pages: snapshot_page_link_matches(conn, space.as_str(), &bodies).await?,
        tag_id_by_norm: snapshot_tags_by_norm(conn, space.as_str()).await?,
    })
}

/// The link bodies the render writes for `descendants`: each linked page's
/// title, with the link's label.
fn rendered_link_bodies(
    descendants: &[BlockRow],
    page_titles: &HashMap<String, String>,
) -> Vec<String> {
    use agaric_store::cache::{PAGE_LINK_RE, page_link_label};
    let contents = descendants.iter().filter_map(|b| b.content.as_deref());
    contents
        .flat_map(|content| PAGE_LINK_RE.captures_iter(content))
        .filter_map(|caps| {
            let title = page_titles.get(&caps[1])?;
            Some(match page_link_label(&caps) {
                Some(label) => format!("{title}|{label}"),
                None => title.clone(),
            })
        })
        .collect()
}

/// #2961 — sanitize an attachment's `filename` for use as markdown link
/// TEXT (the `[label]` half of `[label](attachment:<id>)`).
///
/// Strips `[`, `]`, `\r` and `\n`: unescaped brackets would prematurely
/// close the link's label span and a raw newline would break the single-line
/// bullet the importer expects. This is purely cosmetic — the `attachment:
/// <id>` URL (not the label) is what the ZIP-export resolver and re-import
/// match on, so a mangled label can never misroute the attachment's bytes.
fn attachment_link_label(filename: &str) -> String {
    filename
        .chars()
        .filter(|c| !matches!(c, '[' | ']' | '\r' | '\n'))
        .collect()
}

/// #4552 slice 4 — derive each `ordered` block's POSITIONAL ordinal from its
/// sibling group.
///
/// A run of consecutive `ordered` same-parent siblings numbers `1, 2, 3, …`;
/// ANY non-`ordered` sibling (a `bullet`, or a plain block) ends the run, so
/// the next `ordered` sibling restarts at `1`. This is the same rule as
/// `computeListOrdinals` (`src/lib/list-ordinals.ts`), so the exported number
/// matches the one the editor draws, and it matches CommonMark, where a
/// changed marker type starts a new list.
///
/// `children_by_parent`'s vectors are already sibling-sorted by
/// `(position, id)` — the same order the DFS emits them in — so a single pass
/// per group is enough. Blocks with no entry in the returned map are not
/// `ordered` and take no number.
fn compute_list_ordinals(
    children_by_parent: &HashMap<String, Vec<&BlockRow>>,
    list_styles: &HashMap<String, String>,
) -> HashMap<String, usize> {
    let mut ordinals: HashMap<String, usize> = HashMap::new();
    for children in children_by_parent.values() {
        let mut run: usize = 0;
        for child in children {
            let id = child.id.clone().into_string();
            if list_styles.get(&id).map(String::as_str) == Some("ordered") {
                run += 1;
                ordinals.insert(id, run);
            } else {
                run = 0;
            }
        }
    }
    ordinals
}

/// #4552 slice 4 — the markdown list marker a block's `listStyle` projects to,
/// written between the outline bullet and the block's text.
///
/// `"- "` for `bullet` (the canonical bullet char, matching
/// `serializeBulletList`), `"<n>. "` for `ordered` (the positional ordinal
/// from [`compute_list_ordinals`], never a stored number), and `""` for a
/// block with no `listStyle` row — `none` is the absence of the property and
/// is never written.
fn list_marker_for(
    id: &str,
    list_styles: &HashMap<String, String>,
    ordinals: &HashMap<String, usize>,
) -> String {
    match list_styles.get(id).map(String::as_str) {
        Some("bullet") => "- ".to_string(),
        // An `ordered` block always has an ordinal (it is in exactly one
        // sibling group, and every `ordered` member of a group is numbered);
        // the `1` fallback keeps a marker on the line rather than silently
        // dropping the block's list-ness if that ever stops holding.
        Some("ordered") => format!("{}. ", ordinals.get(id).copied().unwrap_or(1)),
        _ => String::new(),
    }
}

/// #2716 — append a block's (already ULID-resolved) `content` as a Logseq
/// bullet. The first line is written after the `- ` marker; every subsequent
/// line is a CONTINUATION line indented two spaces under the bullet (never
/// re-prefixed with `- `), which `import::parse_logseq_markdown` folds back
/// into the same block. A continuation line that would otherwise be read as
/// something else — a bullet of any marker, a heading or a `key:: value`
/// property ([`import::continuation_line_is_ambiguous`]), and in an export a
/// planning line ([`import::needs_planning_line_escape`]) — is
/// backslash-escaped so the importer's continuation branch keeps it literal
/// (and reverses the escape).
///
/// Lines inside a fenced code block (```` ``` ```` or `~~~`, closed by a run of
/// the same character at least as long) are emitted verbatim: the importer
/// reads them as code without an escape, and code must not gain stray
/// backslashes. The one exception is source mode's
/// [`import::needs_anchor_line_escape`], for a code line the parser would read
/// as a line that ends the fence.
///
/// #4552 slice 4 — `list_marker` (from [`list_marker_for`]) is the block's
/// `listStyle` marker, written between the outline `- ` and the first line:
/// `""`, `"- "`, or `"<n>. "`. `task_marker` (`"[x] "`, or `""`) follows it
/// in every mode (#5160 D6). A first line that would itself read as a marker the
/// block does not write is backslash-escaped ([`first_line_needs_escape`]),
/// the first-line analogue of the continuation-line escape above.
///
/// Returns which lines are code, as the parser's fence tracking will see them.
fn push_block_bullet(
    output: &mut String,
    indent: &str,
    list_marker: &str,
    task_marker: &str,
    resolved: &str,
    mode: RenderMode,
) -> CodeLines {
    let fence_opener = match mode {
        RenderMode::Export => import::fence_opener,
        RenderMode::Source | RenderMode::Clipboard => import::source_fence_opener,
    };

    let mut lines = resolved.split('\n');
    let first = lines.next().unwrap_or("");
    let line_start = output.len();
    output.push_str(indent);
    output.push_str("- ");
    let markers = format!("{list_marker}{task_marker}");
    if first.is_empty() {
        // An EMPTY first line after a marker: emit the bare marker (`- -`,
        // `- 1.`, `- [ ]`) rather than a line with trailing whitespace. Both
        // forms re-import identically, but only this one is a byte-level
        // fixpoint.
        output.push_str(markers.trim_end());
    } else {
        output.push_str(&markers);
        if first_line_needs_escape(first, list_marker, task_marker, mode) {
            output.push('\\');
        }
        output.push_str(first);
    }
    // Fences are tracked over each line as written, escape and marker
    // included, with the importer's own probes: an escaped ```` \- ``` ```` opens
    // no fence there, so it must open none here either.
    let mut in_fence = fence_opener(&output[line_start..]);
    let mut code = CodeLines {
        any: in_fence.is_some(),
        last: in_fence.is_some(),
        open: false,
    };
    output.push('\n');

    let cont_indent = format!("{indent}  ");
    for line in lines {
        let line_start = output.len();
        output.push_str(&cont_indent);
        let needs_escape = if in_fence.is_some() {
            mode != RenderMode::Export && import::needs_anchor_line_escape(line)
        } else {
            import::continuation_line_is_ambiguous(line)
                || (mode == RenderMode::Export && import::needs_planning_line_escape(line))
        };
        if needs_escape {
            output.push('\\');
        }
        output.push_str(line);
        let written = &output[line_start..];
        code.last = if let Some(fence) = in_fence {
            if import::closes_fence(written, fence) {
                in_fence = None;
            }
            true
        } else {
            in_fence = import::fence_opener(written);
            in_fence.is_some()
        };
        code.any |= code.last;
        output.push('\n');
    }
    code.open = in_fence.is_some();
    code
}

/// Which lines of a written bullet the parser reads as code, and whether the
/// bullet leaves a fence open.
struct CodeLines {
    any: bool,
    last: bool,
    open: bool,
}

/// `true` when a block's first line needs a leading `\` to read back as text
/// rather than as a marker the block does not write.
///
/// #4552 slice 4 — a block with no `listStyle` whose first line itself OPENS a
/// list marker must be escaped: unescaped, `- - foo` would re-import as a
/// `bullet` block whose text is `foo` instead of a plain block whose text is
/// `- foo`. `\- ` / `\1. ` is the same escape shape the TS serializer uses for
/// a paragraph (`docs/architecture/list-ergonomics.md`), and
/// `import::split_block_list_marker` reverses it. A checkbox is escaped the
/// same way, after any list marker, since every parser reads one (#5160 D6);
/// after a checkbox no further marker is read. An export also escapes a first
/// line an import would read as a Logseq/Org task keyword or priority cookie
/// (D7, `import::needs_task_syntax_escape`), after a checkbox too, so
/// Export → Import keeps a block whose text starts with `TODO`; the buffer and
/// the clipboard read neither, so they write no such escape.
fn first_line_needs_escape(
    first: &str,
    list_marker: &str,
    task_marker: &str,
    mode: RenderMode,
) -> bool {
    let task_syntax = mode == RenderMode::Export && import::needs_task_syntax_escape(first);
    if !task_marker.is_empty() {
        return task_syntax;
    }
    (list_marker.is_empty() && import::needs_list_marker_escape(first))
        || import::needs_task_marker_escape(first)
        || task_syntax
}

/// #2724 — count how many attachment INGEST ATTEMPTS will read each vault file,
/// keyed by its index in `vault_files`. The result drives the move-vs-clone
/// decision in the ingest loop: an index whose count is exactly `1` is read by a
/// single possible ingest attempt, so its bytes may be MOVED out
/// (`std::mem::take`) instead of cloned; any index with count `> 1` is always
/// cloned so a later attempt never reads a moved-away (emptied) buffer.
///
/// The count is the number of ref OCCURRENCES that resolve to the file, NOT the
/// number of *distinct* refs — a ref repeated within one block counts once PER
/// occurrence. This matters because the per-block `block_ingested` cache only
/// suppresses a re-ingest AFTER a *successful* first ingest; if the first
/// attempt fails transiently (e.g. `PoolTimedOut`) the second occurrence
/// re-enters the ingest path. Counting occurrences (not distinct refs) keeps
/// such a twice-in-one-block file at count `2`, so it is cloned and the retry
/// still sees full bytes — never a 0-byte buffer left behind by a `mem::take`.
///
/// `match_vault_file` keys on `path`/basename (never bytes), so this pre-pass is
/// stable even as the ingest loop later empties `bytes` via `mem::take`.
pub fn ingest_read_counts(
    pending_attachments: &[(String, Vec<import::AttachmentRef>)],
    vault_files: &[VaultFile],
) -> HashMap<usize, usize> {
    let mut counts: HashMap<usize, usize> = HashMap::new();
    for (_block_id, refs) in pending_attachments {
        for att in refs {
            if let Some((idx, _ambiguous)) =
                import::match_vault_file(&att.original_ref, vault_files)
            {
                *counts.entry(idx).or_insert(0) += 1;
            }
        }
    }
    counts
}

/// Import a Logseq-style markdown file as a page with block hierarchy.
///
/// Creates a page from the filename (or first heading), then creates
/// blocks following the indentation hierarchy. Properties are set via
/// SetProperty ops. Returns import statistics.
///
/// #662 — Chunked, atomic-subtree semantics (relaxes the original
/// single-transaction contract). The import is split into a sequence of
/// `BEGIN IMMEDIATE` transactions so the single SQLite writer lock is
/// acquired and released per chunk rather than held for the whole
/// (unbounded) import — interleaved writes and the UI can proceed between
/// chunks. See [`import_markdown_with_progress`] for the full chunk-
/// boundary and partial-import contract. A failure anywhere still surfaces
/// as `Err(AppError)`; `result.warnings` is reserved for non-transactional
/// parse diagnostics from [`import::parse_logseq_markdown`] (e.g. depth
/// clamping). Savepoint-based partial recovery was considered and rejected
/// as too invasive for the available signal.
#[instrument(
    skip(pool, device_id, materializer, content, app_data_dir, vault_files),
    err
)]
#[allow(clippy::too_many_arguments)]
pub async fn import_markdown_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &std::path::Path,
    content: String,
    filename: Option<String>,
    space_id: String,
    // #1925 — referenced sibling files' bytes. `None`/empty ⇒ exactly the
    // pre-#1925 behaviour (no attachment ingest).
    vault_files: Option<Vec<VaultFile>>,
) -> Result<ImportResult, AppError> {
    // Progress-free path (MCP tools, sync replay, scripted imports, tests
    // / benches). The Tauri command calls
    // [`import_markdown_with_progress`] with a live channel sink instead.
    import_markdown_with_progress(
        pool,
        device_id,
        materializer,
        app_data_dir,
        content,
        filename,
        space_id,
        vault_files,
        None,
    )
    .await
}

/// Progress-streaming core of [`import_markdown_inner`] (#128).
///
/// # #662 — chunked writer-lock release
///
/// The import is written as a *sequence* of `BEGIN IMMEDIATE`
/// transactions (chunks) instead of one transaction spanning the whole
/// file. Each chunk acquires the single SQLite writer lock, commits, and
/// releases it; between chunks the lock is free, so a multi-MB import no
/// longer blocks every other write (or the UI) for its full duration.
///
/// ## Chunk boundaries — never split a subtree
///
/// A chunk is only ever closed at a **top-level (depth-0) subtree
/// boundary**: blocks accumulate into the open transaction and the chunk
/// is flushed (committed) only once it holds at least
/// [`IMPORT_CHUNK_BLOCKS`] blocks *and* the next parsed block starts a new
/// depth-0 subtree. Consequently a parent block and every one of its
/// descendants always land in the **same** transaction — a child is never
/// committed without its parent, and a parent is never committed missing
/// any of its (parsed) children. The page block + its `space` property are
/// written in the first chunk together with the first subtree(s).
///
/// Cross-chunk parent references are sound: a block's `parent_id` may point
/// at a block committed in an *earlier* chunk (e.g. the page itself, or a
/// preceding top-level subtree's root is never a parent of a later one), and
/// `create_block_in_tx`'s `WHERE id = ? AND deleted_at IS NULL` parent check
/// sees the committed row.
///
/// ## Partial-import semantics
///
/// If the import is interrupted mid-way (process crash, or an in-tx error
/// that rolls back the *current* chunk), the visible, durable state is the
/// page plus a **prefix of its complete top-level subtrees** — every
/// committed subtree is whole and navigable, and no half-written subtree,
/// orphaned child, or parent-missing-children state is ever exposed. This
/// Relaxes the original "all-or-nothing for the whole file" contract
/// to "all-or-nothing per chunk" (a deliberate trade for the lock-hold fix
/// — see #662). Imports small enough to fit in a single chunk (the common
/// case, `<= IMPORT_CHUNK_BLOCKS` blocks) keep the original whole-import
/// atomicity: there is exactly one chunk, so a mid-import error rolls back
/// everything including the page.
///
/// ## Op-log / materializer correctness
///
/// Each chunk's ops still go through the normal `append_local_op_in_tx`
/// path inside the chunk's transaction and are dispatched (in FIFO order)
/// by that chunk's `commit_and_dispatch` only *after* the chunk commits —
/// identical to the single-transaction path, just repeated per chunk.
/// Global op ordering is preserved because chunks commit strictly in
/// sequence (the next chunk's `BEGIN IMMEDIATE` cannot start until the
/// previous chunk has committed and released the lock).
///
/// ## Progress events
///
/// When `progress` is `Some`, the function emits:
///
///   1. one [`ImportProgressUpdate::Started`] before any block is written,
///   2. one [`ImportProgressUpdate::Progress`] after each block create,
///   3. one [`ImportProgressUpdate::Complete`] **after the final chunk
///      commits** — never before, so a `Complete` event always implies the
///      whole import is durable.
///
/// On any error the function returns `Err` before reaching the `Complete`
/// emit, so a consumer that sees `Started` but no `Complete` must treat the
/// import as failed (possibly partially-applied per the chunk semantics
/// above). Sends are best-effort (see [`ImportProgressSink`]).
// #1934 — declare identifying span fields up front so the import span can be
// filtered/grouped by target space and size. `content`, `progress`, and the
// heavy handles are `skip`-ped; `space_id` is recorded here (it is an arg)
// while `blocks_total` is derived inside and back-filled via
// `Span::current().record(...)` once known.
//
// #3317 — `page_title` used to be a third span field here. It is user content:
// the title is derived from the imported filename, so it is a real name (often
// a real vault path) out of the user's notes. A span attribute has NO redaction
// boundary in front of it — `agaric_observability::exporter::format_span`
// writes attributes verbatim into `traces/*.log`, and the opt-in OTLP exporter
// ships them to the collector — while SECURITY.md promises spans carry "opaque
// ids / counts / enums / durations / booleans only, never note content". The
// title is still logged as a `tracing::info!` FIELD below, where the
// bug-report redactor's deny-by-default pass covers it in both `agaric.log`
// (JSON path) and `otel-logs/` (key=value path). Enforced by
// `commands::observability::tests::span_fields_stay_on_the_pii_allowlist`.
#[instrument(
    skip(pool, device_id, materializer, content, progress, app_data_dir, vault_files),
    fields(blocks_total = tracing::field::Empty, space = %space_id),
    err
)]
#[allow(clippy::too_many_arguments)]
pub async fn import_markdown_with_progress(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    app_data_dir: &std::path::Path,
    content: String,
    filename: Option<String>,
    space_id: String,
    // #1925 — referenced sibling files' bytes. `None`/empty ⇒ no attachment
    // ingest (exact pre-#1925 behaviour).
    vault_files: Option<Vec<VaultFile>>,
    progress: Option<&dyn ImportProgressSink>,
) -> Result<ImportResult, AppError> {
    // #1934 — wall-clock measurement of the whole import so duration is
    // observable in the field. Paired with the completion summary log below.
    let started_at = std::time::Instant::now();

    // Normalize ULID to uppercase per AGENTS.md
    // invariant #8. Mirrors `create_page_in_space_inner` so a raw String
    // arg from MCP tools / sync replay / scripted imports can never land
    // a page whose `space` ref disagrees with the case-sensitive
    // `block_properties.value_ref` lookup downstream.
    let space_id = space_id.to_ascii_uppercase();

    let (mut parse_output, page_title) =
        parse_import_payload(&content, filename, vault_files.as_deref())?;
    let blocks_total = parse_output.blocks.len() as u64;
    announce_import_start(
        progress,
        &page_title,
        blocks_total,
        &space_id,
        parse_output.warnings.len(),
    );

    let (mut tx, page_id) = create_import_page(
        pool,
        materializer,
        device_id,
        &space_id,
        &page_title,
        &mut parse_output.warnings,
    )
    .await?;
    let mut lines = PropertyLines::load(&mut tx, PropertyWrite::Import).await?;
    lines
        .resolve_refs(&mut tx, Some(&space_id), &parse_output.blocks)
        .await?;
    lines.keep_refused_as_text(&mut parse_output.blocks, &mut parse_output.warnings);

    let mut counters = ImportCounters::default();
    // Bundle the read-only handles + derived identity + the running `warnings`
    // list that every phase appends to, so the phase helpers below take one
    // `&mut ImportCtx` instead of a long, repeated argument list. `warnings` is
    // seeded from the parser's diagnostics (`std::mem::take` leaves the parsed
    // struct otherwise intact so its other fields are still read by the phases).
    let mut ctx = ImportCtx {
        pool,
        device_id,
        materializer,
        app_data_dir,
        progress,
        started_at,
        space_id,
        page_id,
        page_title,
        blocks_total,
        lines,
        warnings: std::mem::take(&mut parse_output.warnings),
    };

    let (tx, refs) = resolve_document_refs(&mut ctx, tx, &parse_output, &mut counters).await?;

    // #2724 — the post-commit ingest (`ingest_attachments`) takes ownership of
    // these files so it can MOVE each single-attempt file's bytes out
    // (`std::mem::take`) on its last ingest instead of cloning them.
    let vault_files: Vec<VaultFile> = vault_files.unwrap_or_default();

    // #662 — chunked block insertion.
    let (created_block_ids, pending_attachments) = insert_blocks(
        &mut ctx,
        tx,
        &parse_output,
        &refs,
        &vault_files,
        &mut counters,
    )
    .await?;

    // #2510 / #2567 — post-commit anchor resolution + block-ref rewrite.
    resolve_anchor_links(&mut ctx, &parse_output, &created_block_ids, &refs).await;

    // #1925 — post-commit attachment ingest + content rewrite.
    ingest_attachments(&mut ctx, vault_files, pending_attachments).await;

    // #128 / #1932 / #1934 — completion event + diagnostics/telemetry logging.
    Ok(finish(ctx, &counters))
}

/// Guard the payload, parse it, and derive the page title.
///
/// #2724 — the AGGREGATE attachment budget is enforced ONCE here, at the command
/// boundary, before any parsing or ingest. `vault_files` arrives over IPC with
/// every referenced file's full bytes resident in memory and is retained for the
/// whole chunked import; the per-file `MAX_ATTACHMENT_SIZE` guard (applied later,
/// per ingest) does NOTHING to bound the aggregate. An over-budget payload is
/// rejected up front — a clear error, no partial write and no ingest attempted —
/// rather than letting a multi-hundred-MB `Vec` push the process toward OOM.
/// `None`/empty ⇒ the whole check is a no-op, so the pre-#2724 no-attachment
/// path is byte-for-byte unchanged. (The frontend `DataTab` should pre-check the
/// same budget for a nicer UX, but THIS backend cap is the load-bearing guard —
/// it protects the MCP / test / scripted paths that never touch the frontend.)
///
/// #1446 Part B — the title comes from the filename (folder → namespace). The
/// caller may pass either a bare basename (`API.md`) or a relative path within
/// the imported folder/vault (`Project/Backend/API.md`, e.g. a browser
/// `webkitRelativePath`). We strip the `.md` extension and keep the
/// `/`-delimited path AS the namespaced page title, the inverse of the
/// namespaced export (Part A). Backslash separators (Windows-authored paths) are
/// normalised to `/` first, and empty path segments (leading/trailing or doubled
/// separators) are dropped so a stray slash never yields a blank namespace.
fn parse_import_payload(
    content: &str,
    filename: Option<String>,
    vault_files: Option<&[VaultFile]>,
) -> Result<(import::ParseOutput, String), AppError> {
    if let Some(files) = vault_files {
        // Sum as u64 to avoid any `usize as i64` wrap on a pathological length.
        let total_bytes: u64 = files.iter().map(|f| f.bytes.len() as u64).sum();
        check_attachment_budget(files.len(), total_bytes)?;
    }
    let page_title = filename
        .map(|f| folder_path_to_namespace_title(&f))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Imported Page".to_string());
    // Agaric's own export writes the title as a leading `# Title` line, which
    // would otherwise come back as a block repeating it (#5160 S6).
    let mut parse_output =
        import::parse_logseq_markdown(import::strip_title_heading(content, &page_title));
    // A folder import (its path has a folder) links its notes by relative path
    // (#5160 N10); a lone file has no vault to be relative to.
    if let Some(dir) = page_title.rsplit_once('/').map(|(dir, _)| dir) {
        for block in parse_output.blocks.iter_mut().filter(|b| !b.is_code) {
            block.content = rewrite_relative_md_links(&block.content, dir);
        }
    }
    Ok((parse_output, page_title))
}

/// A markdown link `[text](dest)`: group 1 the text, group 2 the destination.
static MD_LINK_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"\[([^\]\n]*)\]\(([^)\s\n]+)\)").expect("invalid markdown link regex")
});

/// `content` with each link to a relative `.md` file, percent-decoded and
/// resolved against `dir` (the linking file's folder), written as a
/// `[[title]]` link to the page that file imports as (#5160 N10), with the
/// link text as its label when it is not that title (D9). External links,
/// links to other file types, images and links in code are untouched.
fn rewrite_relative_md_links(content: &str, dir: &str) -> String {
    if !content.contains("](") {
        return content.to_string();
    }
    let code_spans = import::inline_code_spans(content);
    MD_LINK_RE
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("group 0 always present");
            let whole = m.as_str();
            if is_in_span(m.start(), &code_spans) || content[..m.start()].ends_with('!') {
                return whole.to_string();
            }
            match relative_md_link_title(&caps[2], dir) {
                Some(title) => match caps[1].trim() {
                    "" => format!("[[{title}]]"),
                    text if text == title => format!("[[{title}]]"),
                    text => format!("[[{title}|{text}]]"),
                },
                None => whole.to_string(),
            }
        })
        .into_owned()
}

/// The page title a relative `.md` link destination imports as, resolved
/// against `dir`, whose first folder is the vault's: `Other%20note.md` from
/// `vault/notes` is `vault/notes/Other note`, and `../Top.md` is `vault/Top`.
/// `None` for a URL, an absolute path, another file type or a path that climbs
/// out of the vault.
fn relative_md_link_title(dest: &str, dir: &str) -> Option<String> {
    let dest = percent_decode(dest).replace('\\', "/");
    if dest.contains("://") || dest.starts_with('/') || !dest.to_ascii_lowercase().ends_with(".md")
    {
        return None;
    }
    let stem = &dest[..dest.len() - ".md".len()];
    let mut segments: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for segment in stem.split('/') {
        match segment {
            "" | "." => {}
            ".." if segments.len() > 1 => {
                segments.pop();
            }
            ".." => return None,
            _ => segments.push(segment),
        }
    }
    Some(folder_path_to_namespace_title(&segments.join("/"))).filter(|t| !t.is_empty())
}

/// `%XX` escapes decoded to their bytes, read as UTF-8; anything else, and a
/// malformed escape, stays as written.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).filter(|_| bytes[i] == b'%');
        if let Some(byte) =
            hex.and_then(|h| u8::from_str_radix(std::str::from_utf8(h).ok()?, 16).ok())
        {
            out.push(byte);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// #128 / #1932 / #1934 — announce the import before the transaction opens.
///
/// The `Started` event carries the parser's block count so the UI can render a
/// determinate progress bar from the first event; if the import later fails, the
/// consumer sees no `Complete` and treats it as failed. The same count back-fills
/// the identifying span field, so every event emitted within this span (and the
/// `err` line on failure) carries it — #3317 removed the `page_title` back-fill;
/// see the note on `import_markdown_with_progress`'s `#[instrument]` attribute.
/// The start log line uses structured fields (not interpolation) to match the
/// codebase logging baseline (e.g. `materializer/consumer.rs`); until #1932 the
/// entire backend import path emitted nothing on the happy path, leaving a
/// completed/partial import invisible in `agaric.log`.
fn announce_import_start(
    progress: Option<&dyn ImportProgressSink>,
    page_title: &str,
    blocks_total: u64,
    space_id: &str,
    parse_warnings: usize,
) {
    let span = tracing::Span::current();
    span.record("blocks_total", blocks_total);

    tracing::info!(
        page = %page_title,
        blocks_total,
        space = %space_id,
        parse_warnings,
        "import: starting markdown import"
    );

    if let Some(sink) = progress {
        sink.emit(ImportProgressUpdate::Started {
            page_title: page_title.to_string(),
            blocks_total,
        });
    }
}

/// Open the import's first chunk and create the page it writes into, or adopt
/// the empty same-title page an earlier file's link created (#5160 D12),
/// returning the transaction and the page's ULID.
///
/// --- Chunked IMMEDIATE transactions (#662) --- `CommandTx` couples commit +
/// post-commit dispatch; op records enqueue per chunk and drain in FIFO order on
/// that chunk's commit. Pre-#662 this was a *single* IMMEDIATE transaction
/// spanning the whole (unbounded) import, so a multi-MB file held the single
/// SQLite writer lock — blocking every other write + the UI — for its entire
/// duration. The transaction is now flushed at top-level (depth-0) subtree
/// boundaries once it has accumulated at least `IMPORT_CHUNK_BLOCKS` blocks,
/// releasing and re-acquiring the writer lock between chunks so interleaved
/// writes can proceed. See `import_markdown_with_progress`'s doc comment for the
/// chunk-boundary + partial-import contract.
///
/// `space_id` is validated INSIDE the tx, identically to
/// `create_page_in_space_inner`: the target must exist as a live, non-conflict
/// block carrying `is_space = 'true'`, which inside the tx is TOCTOU-safe
/// against a concurrent delete. Rejecting here means the import never partially
/// writes a page + blocks before failing — the early `?` rolls the whole
/// transaction back. The page's own `space` ref is stamped straight after it is
/// created, so ops are emitted in the order (create-page → set-space) and a sync
/// peer materializes them in the same order, never observing a page without its
/// space property in steady state.
async fn create_import_page(
    pool: &SqlitePool,
    materializer: &Materializer,
    device_id: &str,
    space_id: &str,
    page_title: &str,
    warnings: &mut Vec<String>,
) -> Result<(CommandTx, String), AppError> {
    let mut tx = CommandTx::begin_immediate(pool, "import_markdown").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort). Re-armed per
    // chunk when the block loop reopens the transaction.
    tx.arm_engine_rollback(materializer.loro_state());

    crate::commands::spaces::require_live_space_in_tx(&mut tx, space_id).await?;

    // #5160 D12 — a unique page of this title with no blocks (the placeholder
    // a `[[link]]` in an earlier file created) is adopted, so the links to it
    // resolve. The title exact or case-folded, never an alias: an alias names
    // a page of another title. A page with content is never touched.
    let title = [page_title.to_string()];
    let matches = snapshot_page_link_matches(&mut tx, space_id, &title).await?;
    let same_title = matches
        .exact
        .get(page_title)
        .or_else(|| matches.folded.get(&page_title.to_ascii_lowercase()));
    match same_title.map(Vec::as_slice) {
        Some([id]) if !page_has_blocks(&mut tx, id).await? => {
            return Ok((tx, id.clone()));
        }
        Some(_) => warnings.push(format!(
            "a page titled '{page_title}' already exists in this space; the file was imported as \
             a new page"
        )),
        None => {}
    }

    let (page, page_op) = create_block_in_tx(
        &mut tx,
        materializer.loro_state(),
        device_id,
        "page".into(),
        page_title.to_string(),
        None,
        None,
        // #2849 PR2: server-generated id.
        None,
    )
    .await?;
    tx.enqueue_background(page_op);
    let page_id = page.id.clone().into_string();
    stamp_space_property(&mut tx, materializer, device_id, page_id.clone(), space_id).await?;
    Ok((tx, page_id))
}

/// Whether `page_id` has a live child block.
async fn page_has_blocks(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<bool, AppError> {
    let has = sqlx::query_scalar!(
        r#"SELECT EXISTS(
               SELECT 1 FROM blocks WHERE parent_id = ?1 AND deleted_at IS NULL
           ) AS "has!: bool""#,
        page_id,
    )
    .fetch_one(&mut *conn)
    .await?;
    Ok(has)
}

/// Everything the block loop and the post-commit anchor phase need to rewrite a
/// document's inbound references to this vault's ids.
struct DocumentRefs {
    links: InboundLinks,
    /// Original inline-tag token → tag ULID.
    tag_tokens: HashMap<String, String>,
    /// #2510 — Obsidian block-anchor id → the INDEX (into `parse_output.blocks`)
    /// of the block whose trailing `^block-id` marker the parser stripped (see
    /// `ParsedBlock::block_anchor`).
    anchor_to_block_index: HashMap<String, usize>,
    /// #2567 — normalized heading text → INDEX (into `parse_output.blocks`) of
    /// the FIRST block whose content is that ATX heading.
    heading_to_block_index: HashMap<String, usize>,
}

/// #2510 — map each Obsidian `^block-id` marker to the index of the block that
/// carried it, ready for the post-commit anchor pass to turn into a real ULID.
/// A duplicate anchor id within one document (a user/Obsidian authoring mistake)
/// last-write-wins, matching a plain map insert — not worth a dedicated
/// ambiguity warning.
fn index_block_anchors(blocks: &[import::ParsedBlock]) -> HashMap<String, usize> {
    blocks
        .iter()
        .enumerate()
        .filter_map(|(idx, b)| b.block_anchor.as_ref().map(|a| (a.clone(), idx)))
        .collect()
}

/// #2567 — map each normalized ATX heading label to the index of the block that
/// is that heading. COLLISION RULE: first occurrence wins (`or_insert`), so a
/// repeated heading label always targets its first occurrence in document order.
/// Obsidian's own `heading`, `heading-1`, … numeric-suffix disambiguation is
/// intentionally NOT mirrored (kept simple and deterministic; documented here
/// and in the issue). `is_code` blocks are skipped — a `# comment` inside a
/// fenced code sample is not a heading.
fn index_headings(blocks: &[import::ParsedBlock]) -> HashMap<String, usize> {
    let mut map: HashMap<String, usize> = HashMap::new();
    for (idx, b) in blocks.iter().enumerate() {
        if b.is_code {
            continue;
        }
        if let Some(text) = obsidian_heading_text(&b.content) {
            map.entry(normalize_heading_anchor(text)).or_insert(idx);
        }
    }
    map
}

/// The import's pre-commit phases: page-level frontmatter, then the wiki-link
/// and inline-tag resolve-or-create pre-passes, then the frontmatter tags. They
/// all run in the FIRST chunk's transaction, so everything they create shares
/// the page's atomic write, before the block loop opens any new chunk.
async fn resolve_document_refs(
    ctx: &mut ImportCtx<'_>,
    tx: CommandTx,
    parse_output: &import::ParseOutput,
    counters: &mut ImportCounters,
) -> Result<(CommandTx, DocumentRefs), AppError> {
    // #1432 — leading YAML frontmatter → page-level properties.
    let tx = apply_frontmatter_properties(ctx, tx, parse_output, counters).await?;

    // #1446 Part B / #1921 — inbound `[[Page Name]]` wiki-link resolution pre-pass.
    let (tx, links) =
        resolve_inbound_page_links(&mut ctx.name_ctx(), tx, &parse_output.blocks).await?;

    // #1924 / #1950 — inbound inline-tag resolution pre-pass.
    let (tx, mut resolved_tag_norm, tag_tokens, existing_tag_by_norm) =
        resolve_inbound_tags(&mut ctx.name_ctx(), tx, &parse_output.blocks).await?;

    // #2722 — frontmatter `tags:` → real page→tag associations.
    let tx = apply_frontmatter_tags(
        ctx,
        tx,
        parse_output,
        &mut resolved_tag_norm,
        &existing_tag_by_norm,
    )
    .await?;

    Ok((
        tx,
        DocumentRefs {
            links,
            tag_tokens,
            anchor_to_block_index: index_block_anchors(&parse_output.blocks),
            heading_to_block_index: index_headings(&parse_output.blocks),
        },
    ))
}

/// #2928 — shared state for the `import_markdown_with_progress` phase helpers
/// below. Bundles the read-only handles, the derived page identity, and the
/// running `warnings` list that each phase appends to, so the decomposed phase
/// functions take a single `&mut ImportCtx` instead of re-threading a long
/// argument list. The chunked transaction (`CommandTx`) is deliberately NOT a
/// field: it borrows `pool` (also held here), which would make the struct
/// self-referential, so it is threaded through the pre-commit phases by value
/// instead.
struct ImportCtx<'a> {
    pool: &'a SqlitePool,
    device_id: &'a str,
    materializer: &'a Materializer,
    app_data_dir: &'a std::path::Path,
    progress: Option<&'a dyn ImportProgressSink>,
    started_at: std::time::Instant,
    space_id: String,
    page_id: String,
    page_title: String,
    blocks_total: u64,
    /// How the file's property lines read against the definitions.
    lines: PropertyLines,
    /// Parse-time + apply-time diagnostics, accumulated across every phase and
    /// returned in the final [`ImportResult`].
    warnings: Vec<String>,
}

impl ImportCtx<'_> {
    /// The name passes' view of this import: its page, in its space.
    fn name_ctx(&mut self) -> NameCtx<'_> {
        NameCtx {
            materializer: self.materializer,
            device_id: self.device_id,
            space_id: &self.space_id,
            page_id: &self.page_id,
            warnings: &mut self.warnings,
            created: Vec::new(),
        }
    }
}

/// What the name passes ([`resolve_inbound_page_links`],
/// [`resolve_inbound_tags`]) need to resolve names in one space, creating a
/// page or tag no name there matches: import and paste each build one.
struct NameCtx<'a> {
    materializer: &'a Materializer,
    device_id: &'a str,
    space_id: &'a str,
    /// The page the names are written into: a link to it with a `#` anchor
    /// points into the text being written, not at the page.
    page_id: &'a str,
    warnings: &'a mut Vec<String>,
    /// The pages and tags the passes created, in creation order.
    created: Vec<BlockRow>,
}

/// The running totals an import accumulates across its phases (`properties_set`
/// in the frontmatter apply and the block loop, `blocks_created` /
/// `chunks_committed` in the block loop) and reports in the final
/// [`ImportResult`].
// Not `Copy`: every user takes it by `&mut`, and a helper silently taking it
// by value would drop the increments.
#[derive(Default)]
struct ImportCounters {
    blocks_created: u64,
    properties_set: u64,
    chunks_committed: u64,
}

/// Stamp the reserved `space` ref property on a block the import just created,
/// queueing its op for post-commit dispatch.
///
/// Every block an import mints — the page itself, a create-if-missing wiki-link
/// page, a resolve-or-create tag — must carry it: a tag with no space resolves
/// to NO space and the cross-space gate in `reindex_block_tag_refs` then drops
/// the inline `#[ULID]` ref, and a page without it is not a member of the
/// import's space.
async fn stamp_space_property(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    block_id: String,
    space_id: &str,
) -> Result<(), AppError> {
    let (_block, space_op) = set_property_in_tx(
        &mut *tx,
        materializer.loro_state(),
        device_id,
        block_id,
        "space",
        None,
        None,
        None,
        Some(space_id.to_string()),
        None,
    )
    .await?;
    tx.enqueue_background(space_op);
    Ok(())
}

/// #2722 — write the frontmatter `aliases:` items as real `page_aliases` rows in
/// the import's own transaction.
///
/// Mirrors `set_page_aliases_inner`'s `INSERT OR IGNORE` (byte-identical SQL, so
/// its offline `.sqlx` entry is reused) but shares the import's atomic write.
/// `page_aliases` is its own table outside the op log (#110), so a direct insert
/// here is the established pattern, and `INSERT OR IGNORE` keeps re-import
/// idempotent (alias is globally UNIQUE NOCASE).
///
/// `own` (ASCII-folded to mirror the NOCASE index) holds the aliases the page
/// already has — an adopted page (D12) may hold some — and those this call just
/// wrote, so a repeat of either (`[Solo, Solo]`) is a benign no-op rather than
/// a spurious collision warning. Any OTHER 0-row insert means the alias is held
/// by a DIFFERENT page — a never-silent degradation, surfaced as a warning.
async fn apply_frontmatter_aliases(
    tx: &mut CommandTx,
    page_id: &str,
    aliases: Vec<&str>,
    warnings: &mut Vec<String>,
) -> Result<(), AppError> {
    // Byte-identical to `get_page_aliases_inner`'s, so its `.sqlx` entry is reused.
    let mut own: std::collections::HashSet<String> = sqlx::query_scalar!(
        "SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias",
        page_id,
    )
    .fetch_all(&mut ***tx)
    .await?
    .into_iter()
    .map(|alias| alias.to_ascii_lowercase())
    .collect();
    for alias in aliases {
        let res = sqlx::query!(
            "INSERT OR IGNORE INTO page_aliases (page_id, alias) VALUES (?1, ?2)",
            page_id,
            alias,
        )
        .execute(&mut ***tx)
        .await?;
        if res.rows_affected() > 0 {
            own.insert(alias.to_ascii_lowercase());
        } else if !own.contains(&alias.to_ascii_lowercase()) {
            warnings.push(format!(
                "alias '{alias}' is already used by another page; not applied to \
                 the imported page"
            ));
        }
    }
    Ok(())
}

/// A `ref`-declared frontmatter value's typed property arguments, or `None`
/// when the property must be skipped with a warning.
///
/// The value arrives as the resolved target *title* (that is what
/// `export_page_markdown_inner` emits), so it is reverse-resolved to a live
/// page/tag block id. Resolution is SAME-SPACE-SCOPED (`AND space_id = ?`): a
/// title that collides with a page/tag in a DIFFERENT space must NOT resolve
/// here, or the foreign block id would flow into `set_property_in_tx` →
/// `validate_ref_property_cross_space`, which hard-rejects with
/// `AppError::Validation` and rolls back the entire import. With no same-space
/// match the value can be persisted neither as a `ref` (no live target) nor as
/// `text` (the typed def would reject text), so the single property is skipped
/// with the human-readable title surfaced in the warning.
async fn frontmatter_ref_args(
    tx: &mut CommandTx,
    space_id: &str,
    key: &str,
    value: &str,
    warnings: &mut Vec<String>,
) -> Result<Option<agaric_engine::block_ops::TypedPropertyArgs>, AppError> {
    let resolved: Option<String> = sqlx::query_scalar!(
        r#"SELECT id FROM blocks
                       WHERE content = ?
                         AND block_type IN ('page', 'tag')
                         AND deleted_at IS NULL
                         AND space_id = ?
                       ORDER BY id ASC
                       LIMIT 1"#,
        value,
        space_id,
    )
    .fetch_optional(&mut ***tx)
    .await?;
    let Some(id) = resolved else {
        // #1933 — per-occurrence diagnostic for this lossy skip.
        tracing::debug!(
            key = %key,
            value = %value,
            "import: frontmatter ref property could not resolve; skipped (#1933)"
        );
        warnings.push(format!(
            "frontmatter ref property '{key}' could not resolve target \
             '{value}' to a page in this space; skipped"
        ));
        return Ok(None);
    };
    Ok(Some((None, None, None, Some(id), None)))
}

/// #1432 — apply the leading YAML frontmatter as page-level properties. Returns
/// the (possibly moved-through) transaction.
///
/// A key names the reserved key or definition it folds to (#5160 D13), and a
/// value its definition refuses is skipped with a warning naming it (D11):
/// front matter has no block to keep it in as text.
async fn apply_frontmatter_properties(
    ctx: &mut ImportCtx<'_>,
    mut tx: CommandTx,
    parse_output: &import::ParseOutput,
    counters: &mut ImportCounters,
) -> Result<CommandTx, AppError> {
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let space_id = ctx.space_id.clone();
    let page_id = ctx.page_id.clone();
    let lines = &ctx.lines;
    let warnings = &mut ctx.warnings;
    // #1432 — apply the leading YAML frontmatter as PAGE-level properties,
    // closing the export↔import asymmetry: `export_page_markdown_inner`
    // already emits page properties as frontmatter, but the importer used to
    // discard them. The parser (`import::parse_logseq_markdown`) has already
    // filtered the exporter's internal/reserved keys and validated each key
    // against the `^[A-Za-z0-9_-]{1,64}$` alphabet, so every pair here is a
    // user-visible scalar safe to stamp onto the page. These properties are
    // written into the FIRST chunk (alongside the page + space property),
    // before the block loop opens any new chunk, so they share the page's
    // atomic write.
    for (key, value) in &parse_output.frontmatter {
        // #2722 — `aliases` and `tags` are SEMANTIC frontmatter keys the
        // exporter emits from the `page_aliases` table and `block_tags`
        // associations (NOT from `block_properties`). The pre-#2722 importer
        // had no special-casing, so it stamped them as inert TEXT properties
        // named `aliases`/`tags` — silently killing alias resolution/search
        // and tag filtering on re-import. Intercept both here so neither is
        // ever persisted as a misleading text property:
        //   * `aliases` → real `page_aliases` rows, written below in THIS tx;
        //   * `tags`    → real `block_tags` associations, written by the
        //     dedicated frontmatter-tag pre-pass further down (it needs the
        //     tag resolve-or-create machinery, which is set up after the
        //     wiki-link pre-pass).
        if key.as_str() == "aliases" {
            apply_frontmatter_aliases(
                &mut tx,
                &page_id,
                frontmatter_items(parse_output, key, value),
                warnings,
            )
            .await?;
            continue;
        }
        if key.as_str() == "tags" {
            // Handled by the frontmatter-tag pre-pass below (resolve-or-create
            // the tag block + write a real `block_tags` association). Skip it
            // here so it is never stamped as a misleading text property.
            continue;
        }
        let key = lines.canonical_key(key);
        // #1921 (B1) — the declaration read once for the whole import. A key
        // with no `property_definitions` row stays undeclared (`None`).
        let declaration = lines.declaration(&key);
        let args = if declaration.as_ref().is_some_and(|d| d.value_type == "ref") {
            let args = frontmatter_ref_args(&mut tx, &space_id, &key, value, warnings).await?;
            let Some(args) = args else {
                continue;
            };
            args
        } else {
            match lines.read(&key, value) {
                Ok(args) => args,
                Err(reason) => {
                    warnings.push(format!(
                        "front matter `{key}: {value}` was skipped: {reason}"
                    ));
                    continue;
                }
            }
        };
        let (value_text, value_num, value_date, value_ref, value_bool) = args;
        let (_page_block, prop_op) = agaric_engine::block_ops::set_property_in_tx_with_declaration(
            &mut tx,
            materializer.loro_state(),
            device_id,
            page_id.clone(),
            &key,
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool,
            declaration,
        )
        .await?;
        counters.properties_set += 1;
        tx.enqueue_background(prop_op);
    }
    Ok(tx)
}

/// What the wiki-link bodies and inline-query page names of a text resolve to
/// (#5160 D9, D10).
#[derive(Default)]
struct PageLinks {
    /// Each trimmed link body's reading: the name it links and its label. A
    /// body with none stays text.
    readings: HashMap<String, (String, Option<String>)>,
    /// Each name's page: the names the readings give and the inline queries
    /// hold.
    ids: HashMap<String, String>,
}

impl PageLinks {
    /// Add what `from` holds for the link `bodies` and the query `names`.
    fn extend_from(
        &mut self,
        from: &Self,
        bodies: &std::collections::BTreeSet<String>,
        names: &std::collections::BTreeSet<String>,
    ) {
        let readings = bodies
            .iter()
            .filter_map(|body| Some((body, from.readings.get(body)?)));
        for (body, reading) in readings {
            self.readings.insert(body.clone(), reading.clone());
            if let Some(id) = from.ids.get(&reading.0) {
                self.ids.insert(reading.0.clone(), id.clone());
            }
        }
        for name in names {
            if let Some(id) = from.ids.get(name) {
                self.ids.insert(name.clone(), id.clone());
            }
        }
    }
}

/// The wiki-link state one import document's pre-pass produces: the resolved
/// page links the rewrite reads, plus the same-document block- and
/// heading-anchor tokens whose target block does not exist yet and so are
/// resolved in the post-commit anchor phase.
#[derive(Default)]
struct InboundLinks {
    page_links: PageLinks,
    /// Each resolved page's title by id, so a label equal to it is not stored
    /// (#5160 D9).
    titles: HashMap<String, String>,
    pending_block_anchors: HashMap<String, String>,
    pending_heading_anchors: HashMap<String, PendingHeading>,
}

impl InboundLinks {
    /// Record `id`'s title: the snapshot's, or `created_as` for a page this
    /// pass created.
    fn remember_title(&mut self, id: &str, matches: &LinkMatches, created_as: &str) {
        let title = matches.titles.get(id).map_or(created_as, String::as_str);
        self.titles.insert(id.to_string(), title.to_string());
    }

    fn defer_anchor(&mut self, name: String, deferred: DeferredAnchor) {
        match deferred {
            DeferredAnchor::Block(block_id) => {
                self.pending_block_anchors.insert(name, block_id);
            }
            DeferredAnchor::Heading(heading) => {
                self.pending_heading_anchors.insert(name, heading);
            }
        }
    }
}

/// #2510 / #2567 — the deferred resolution a same-document `#…` sub-anchor
/// needs. A block's ULID is not known until it is created in the write loop, so
/// the token is left literal here and rewritten to a real `((block ULID))` ref —
/// or to a link to the importing page, mirroring #1282's dropped-anchor
/// fallback — once every block of the document exists.
enum DeferredAnchor {
    Block(String),
    Heading(PendingHeading),
}

fn deferred_anchor(
    anchor: &str,
    block_anchor_id: Option<&str>,
    empty_base: bool,
) -> DeferredAnchor {
    match block_anchor_id {
        Some(block_id) => DeferredAnchor::Block(block_id.to_string()),
        None => DeferredAnchor::Heading(PendingHeading {
            norm: normalize_heading_anchor(anchor),
            empty_base,
        }),
    }
}

/// The in-space pages a set of link names may resolve to, read once for the
/// whole pass (#2200: one query per map, never one per name). Each map keeps
/// at most the two smallest ids per key (`ORDER BY id ASC`), since only "one"
/// or "more" drives the branch. The importing page (created in this tx) is
/// visible, so a self-reference resolves to it.
#[derive(Default)]
struct LinkMatches {
    /// Exact title → ids.
    exact: HashMap<String, Vec<String>>,
    /// Title folded as SQLite's `NOCASE` folds it (ASCII letters) → ids.
    folded: HashMap<String, Vec<String>>,
    /// Alias folded the same way → page ids; `page_aliases.alias` is unique
    /// `NOCASE`, so at most one.
    aliases: HashMap<String, Vec<String>>,
    /// Every matched page's title by id.
    titles: HashMap<String, String>,
}

/// One rule's answer for a name: the page it names, or that two pages tie.
enum LinkMatch {
    Unique(String),
    Ambiguous,
}

impl LinkMatches {
    fn push(map: &mut HashMap<String, Vec<String>>, key: String, id: String) {
        let ids = map.entry(key).or_default();
        if ids.len() < 2 {
            ids.push(id);
        }
    }

    /// The page a link's `name` names (#5160 D10): the page titled with the
    /// whole name, else, when an anchor holding no `|` follows its first `#`,
    /// the page its base names. A `|` after the `#` starts a label, so it
    /// never makes an anchor.
    fn find_name(&self, name: &str) -> Option<LinkMatch> {
        let (base, anchor) = split_wikilink_anchor(name);
        let anchored = !base.is_empty() && anchor.is_some_and(|a| !a.contains('|'));
        self.find(name)
            .or_else(|| anchored.then(|| self.find(base)).flatten())
    }

    /// The page `name` resolves to (#5160 N4): the exact title, else a unique
    /// case-insensitive title, else a unique alias, else none. A case tie is
    /// never guessed. Titles are compared whole, namespace included.
    fn find(&self, name: &str) -> Option<LinkMatch> {
        let folded = name.to_ascii_lowercase();
        [
            self.exact.get(name),
            self.folded.get(&folded),
            self.aliases.get(&folded),
        ]
        .into_iter()
        .find_map(|ids| match ids.map(Vec::as_slice) {
            None | Some([]) => None,
            Some([single]) => Some(LinkMatch::Unique(single.clone())),
            Some(_) => Some(LinkMatch::Ambiguous),
        })
    }
}

/// The names [`LinkMatches`] looks up for `link_names` (#5160 D10): the name
/// of each of their [`link_body_readings`], so a title holding a `|` or a `#`
/// wins first, and each anchor-stripped base. An anchor-only link like
/// `[[#heading]]` has an empty base and looks up nothing.
fn link_lookup_names(link_names: &[String]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for (name, _) in link_names.iter().flat_map(|body| link_body_readings(body)) {
        let (base, anchor) = split_wikilink_anchor(name);
        if base.is_empty() {
            continue;
        }
        if anchor.is_some() {
            set.insert(name.to_string());
        }
        set.insert(base.to_string());
    }
    set.into_iter().collect()
}

/// Read the [`LinkMatches`] for `link_names` in `space_id`: the live pages
/// whose title matches a name `NOCASE` (which covers the exact matches), then
/// the live pages one of the names is an alias of.
async fn snapshot_page_link_matches(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    link_names: &[String],
) -> Result<LinkMatches, AppError> {
    let lookup_names = link_lookup_names(link_names);
    let mut matches = LinkMatches::default();
    if lookup_names.is_empty() {
        return Ok(matches);
    }
    let names_json = serde_json::to_string(&lookup_names)?;
    let rows = sqlx::query!(
        r#"SELECT id AS "id!", content AS "content!"
               FROM blocks
               WHERE block_type = 'page'
                 AND deleted_at IS NULL
                 AND space_id = ?1
                 AND content COLLATE NOCASE IN (SELECT value FROM json_each(?2))
               ORDER BY id ASC"#,
        space_id,
        names_json,
    )
    .fetch_all(&mut *conn)
    .await?;
    for r in rows {
        LinkMatches::push(
            &mut matches.folded,
            r.content.to_ascii_lowercase(),
            r.id.clone(),
        );
        matches.titles.insert(r.id.clone(), r.content.clone());
        LinkMatches::push(&mut matches.exact, r.content, r.id);
    }
    let rows = sqlx::query!(
        r#"SELECT a.page_id AS "page_id!", a.alias AS "alias!", b.content AS "title?"
               FROM page_aliases a
               JOIN blocks b ON b.id = a.page_id
               WHERE b.block_type = 'page'
                 AND b.deleted_at IS NULL
                 AND b.space_id = ?1
                 AND a.alias COLLATE NOCASE IN (SELECT value FROM json_each(?2))
               ORDER BY a.page_id ASC"#,
        space_id,
        names_json,
    )
    .fetch_all(&mut *conn)
    .await?;
    for r in rows {
        if let Some(title) = r.title {
            matches.titles.insert(r.page_id.clone(), title);
        }
        LinkMatches::push(
            &mut matches.aliases,
            r.alias.to_ascii_lowercase(),
            r.page_id,
        );
    }
    Ok(matches)
}

/// Resolve one wiki-link BASE name to a page ULID, creating the page when the
/// snapshot holds no match. `None` means the name is ambiguous (two or more
/// same-space pages carry that title): never guess which was meant — the token
/// is left as plain text and a non-fatal warning surfaces the loss.
///
/// `resolved_base_links` remembers this pass's own resolutions so two distinct
/// tokens sharing one base (`[[Page#h1]]`, `[[Page#h2]]`) resolve to the SAME
/// page and create it AT MOST once.
async fn resolve_or_create_link_target(
    ctx: &mut NameCtx<'_>,
    tx: &mut CommandTx,
    base: String,
    name: &str,
    link_matches: &LinkMatches,
    resolved_base_links: &mut HashMap<String, String>,
) -> Result<Option<String>, AppError> {
    if let Some(ulid) = resolved_base_links.get(&base) {
        return Ok(Some(ulid.clone()));
    }
    match link_matches.find(&base) {
        Some(LinkMatch::Unique(single)) => {
            resolved_base_links.insert(base, single.clone());
            Ok(Some(single))
        }
        None => {
            // Create the missing target page inside this chunk's tx, then
            // stamp its `space` ref (mirrors the importing page), so the new
            // page is a first-class member of the import's space.
            let (new_page, new_page_op) = create_block_in_tx(
                &mut *tx,
                ctx.materializer.loro_state(),
                ctx.device_id,
                "page".into(),
                base.clone(),
                None,
                None,
                // #2849 PR2: server-generated id.
                None,
            )
            .await?;
            tx.enqueue_background(new_page_op);
            let new_page_id = new_page.id.clone().into_string();
            stamp_space_property(
                tx,
                ctx.materializer,
                ctx.device_id,
                new_page_id.clone(),
                ctx.space_id,
            )
            .await?;
            ctx.created.push(new_page);
            resolved_base_links.insert(base, new_page_id.clone());
            Ok(Some(new_page_id))
        }
        Some(LinkMatch::Ambiguous) => {
            warn_ambiguous_link(ctx, name);
            Ok(None)
        }
    }
}

/// #1933 — per-occurrence diagnostic for the lossy transform an ambiguous name
/// takes: the `[[Name]]` link is left as plain text.
fn warn_ambiguous_link(ctx: &mut NameCtx<'_>, name: &str) {
    tracing::debug!(
        name = %name,
        "import: ambiguous wiki-link left as plain text (#1933)"
    );
    ctx.warnings.push(format!(
        "wiki-link '[[{name}]]' matches multiple pages in this space; left as plain text"
    ));
}

/// Resolve every collected wiki-link token against the pre-loop snapshot,
/// creating missing target pages in this chunk's transaction.
///
/// #1282 — a token may carry a `#…` sub-anchor (`[[Page#Heading]]`,
/// `[[Page#^blockId]]`) addressing a heading/block INSIDE the target page. A
/// page titled with the whole token wins first (#5160 D10: `[[C# Notes]]` is
/// that page, not `C`). Otherwise only the BASE page is resolved: the returned
/// map stays keyed on the ORIGINAL full token (so the rewrite still matches
/// `[[Page#Heading]]` and swaps in `[[<ULID>]]`). A sub-anchor that points
/// INTO the document being imported is deferred instead (see
/// [`DeferredAnchor`]); a CROSS-note anchor (the base resolves to a DIFFERENT,
/// already-existing page) falls through to the #1282 dropped-anchor page-link
/// behaviour.
async fn resolve_link_names(
    ctx: &mut NameCtx<'_>,
    mut tx: CommandTx,
    link_names: Vec<String>,
    link_matches: &LinkMatches,
) -> Result<(CommandTx, InboundLinks), AppError> {
    let page_id = ctx.page_id;
    let mut links = InboundLinks::default();
    let mut resolved_base_links: HashMap<String, String> = HashMap::new();
    // #1282 — count of DISTINCT full tokens whose `#…` sub-anchor was dropped to
    // resolve to the base page. Surfaced as one aggregate warning (mirroring the
    // block-ref-strip warning) so the lossy anchor drop is diagnosable.
    let mut dropped_anchor_count: usize = 0;
    for name in link_names {
        let (base, anchor) = split_wikilink_anchor(&name);
        // #2510 — the `^block-id` sub-anchor id, when this is an Obsidian
        // BLOCK anchor (as opposed to a heading anchor).
        let block_anchor_id = anchor.and_then(obsidian_block_anchor_id);
        if let Some(anchor) = anchor
            && base.is_empty()
        {
            // An anchor-only link (`[[#^blockId]]` / `[[#Heading]]`): the
            // implicit target page IS the page being imported. On an
            // UNRESOLVED heading the deferred pass restores #1282's "no page
            // target" literal behaviour (`empty_base = true`).
            let deferred = deferred_anchor(anchor, block_anchor_id, true);
            links.defer_anchor(name, deferred);
            continue;
        }
        if anchor.is_some() {
            // #5160 D10 — a page titled with the whole token wins.
            match link_matches.find(name.trim()) {
                Some(LinkMatch::Unique(id)) => {
                    links.remember_title(&id, link_matches, name.trim());
                    links.page_links.ids.insert(name, id);
                    continue;
                }
                Some(LinkMatch::Ambiguous) => {
                    warn_ambiguous_link(ctx, &name);
                    continue;
                }
                None => {}
            }
        }
        let Some(resolved_ulid) = resolve_or_create_link_target(
            ctx,
            &mut tx,
            base.to_string(),
            &name,
            link_matches,
            &mut resolved_base_links,
        )
        .await?
        else {
            continue;
        };
        links.remember_title(&resolved_ulid, link_matches, base);

        if let Some(anchor) = anchor
            && resolved_ulid == page_id
        {
            // An explicit self-title anchor (`[[SelfTitle#^blockId]]` /
            // `[[SelfTitle#Heading]]`): same-document, so defer it exactly like
            // the anchor-only case. An unresolved heading falls back to a page
            // link + the aggregate dropped-anchor warning (`empty_base =
            // false`), matching #1282's existing self/page-base behaviour.
            let deferred = deferred_anchor(anchor, block_anchor_id, false);
            links.defer_anchor(name, deferred);
            continue;
        }

        if anchor.is_some() {
            dropped_anchor_count += 1;
        }
        links.page_links.ids.insert(name, resolved_ulid);
    }
    if dropped_anchor_count > 0 {
        // #1282 — aggregate warning for the lossy anchor drop (mirrors the
        // block-ref-strip warning style). The links still resolve to the page;
        // only the `#heading` / cross-note `#^blockId` sub-anchor targeting is
        // not applied.
        ctx.warnings.push(format!(
            "{dropped_anchor_count} wikilink block/heading anchors were dropped; links resolve to \
             the page (Obsidian block-anchor targeting is not yet supported)"
        ));
    }
    Ok((tx, links))
}

/// #1446 Part B / #1921 — resolve inbound `[[Page Name]]` wiki-links to internal
/// `[[ULID]]` refs (create-if-missing), returning the transaction, the
/// resolved-link map used by the block loop, and the deferred same-document
/// block/heading-anchor maps resolved in the post-commit anchor phase.
///
/// This is a PRE-PASS over the whole parsed document so each distinct name is
/// resolved/created exactly once (a name cited by N blocks creates at most one
/// page), and so the created pages share the FIRST chunk's atomic write
/// alongside the importing page itself (before the block loop opens a new
/// chunk).
///
/// Resolution is [`LinkMatches::find`]'s rule (#5160 N4), scoped to the name
/// context's space: the exact title, else a unique case-insensitive title,
/// else a unique alias, else the page is created; a tie is left as plain
/// text with a warning.
///
/// A name we cannot resolve or create is simply absent from the map, so the
/// rewrite leaves its original `[[Name]]` token untouched — nothing is lost.
async fn resolve_inbound_page_links(
    ctx: &mut NameCtx<'_>,
    tx: CommandTx,
    blocks: &[import::ParsedBlock],
) -> Result<(CommandTx, InboundLinks), AppError> {
    // #2968 — also resolve/create the PAGE names referenced by structured
    // `{{query v2n:…}}` inline queries, so a query's page/structural refs remap
    // to this vault's page ids (create-if-missing) on re-import, exactly like an
    // inbound `[[Page]]` link.
    let query_names = super::inline_query_md::query_page_names(blocks);
    resolve_page_refs(
        ctx,
        tx,
        collect_inbound_page_link_bodies(blocks),
        query_names,
    )
    .await
}

/// Resolve wiki-link `bodies` and inline-query page `names` against one
/// snapshot of the pages they may name: each body reads by [`read_link_body`]
/// (#5160 D10), and the names read and `names` resolve by
/// [`resolve_link_names`], so only a name no page matches is created. A body
/// whose reading ties stays text, with a warning.
async fn resolve_page_refs(
    ctx: &mut NameCtx<'_>,
    mut tx: CommandTx,
    bodies: Vec<String>,
    names: Vec<String>,
) -> Result<(CommandTx, InboundLinks), AppError> {
    let lookup: Vec<String> = bodies.iter().chain(&names).cloned().collect();
    let matches = snapshot_page_link_matches(&mut tx, ctx.space_id, &lookup).await?;
    let mut readings = HashMap::new();
    let mut read_names = std::collections::BTreeSet::new();
    for body in bodies {
        match read_link_body(&body, &matches) {
            None => warn_ambiguous_link(ctx, &body),
            Some(("", _)) => {}
            Some((name, label)) => {
                read_names.insert(name.to_string());
                let reading = (name.to_string(), label.map(str::to_string));
                readings.insert(body, reading);
            }
        }
    }
    let names = read_names.into_iter().chain(names).collect();
    let (tx, mut links) = resolve_link_names(ctx, tx, names, &matches).await?;
    links.page_links.readings = readings;
    Ok((tx, links))
}

/// #1990 — snapshot the in-space live tag blocks ONCE, indexed by normalized
/// name → smallest-id winner, instead of re-scanning every in-space tag per
/// token. The resolve pass only CREATES tags (never mutates existing tag
/// content), so a single pre-loop snapshot stays valid; within-pass creations
/// are tracked by the caller. SQLite cannot apply `normalize_tag_name`
/// (NFC → Unicode lowercase → NFC) and NOCASE folds only ASCII A–Z, so we fold
/// in Rust here to catch every case-variant the Loro engine (which keys by
/// `normalize_tag_name`) already merges. Tag count is bounded by the user's
/// vocabulary, so the snapshot is cheap.
async fn snapshot_tags_by_norm(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
) -> Result<HashMap<String, String>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT id, content FROM blocks
               WHERE block_type = 'tag'
                 AND deleted_at IS NULL
                 AND content IS NOT NULL
                 AND space_id = ?1
               ORDER BY id ASC"#,
        space_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut map: HashMap<String, String> = HashMap::new();
    for r in rows {
        if let Some(c) = r.content {
            // `or_insert` keeps the FIRST (smallest-id, since ORDER BY id
            // ASC) row per normalized name — the tags-cache winner.
            map.entry(agaric_core::tag_norm::normalize_tag_name(&c))
                .or_insert(r.id);
        }
    }
    Ok(map)
}

/// The resolved tag state [`resolve_tag_names`] returns with the
/// transaction: by normalised name, by token, and the pre-pass snapshot.
type ResolvedTags = (
    CommandTx,
    HashMap<String, String>,
    HashMap<String, String>,
    HashMap<String, String>,
);

/// #1924 / #1950 — resolve inbound inline tags (`#tag`, `#[[Tag With Space]]`)
/// to `#[ULID]` refs (resolve-or-create), returning the transaction plus the
/// per-pass tag state reused by the block loop and the frontmatter-tag pass.
async fn resolve_inbound_tags(
    ctx: &mut NameCtx<'_>,
    tx: CommandTx,
    blocks: &[import::ParsedBlock],
) -> Result<ResolvedTags, AppError> {
    // #2968 — also resolve/create the TAG names referenced by structured
    // `{{query v2n:…}}` inline queries so a query's tag refs remap to this
    // vault's tag ids (create-if-missing) on re-import, exactly like an inbound
    // `#tag`.
    let tag_token_names: Vec<String> = collect_inbound_tag_names(blocks)
        .into_iter()
        .chain(super::inline_query_md::query_tag_names(blocks))
        .collect();
    resolve_tag_names(ctx, tx, tag_token_names).await
}

/// [`resolve_inbound_tags`] for names already collected.
async fn resolve_tag_names(
    ctx: &mut NameCtx<'_>,
    mut tx: CommandTx,
    tag_token_names: Vec<String>,
) -> Result<ResolvedTags, AppError> {
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let space_id = ctx.space_id;
    // #1924 / #1950 — resolve inbound inline tags (`#tag` and `#[[Tag With
    // Space]]`) to internal `#[ULID]` refs, creating any missing tag block
    // (resolve-or-create). This mirrors the wiki-link pre-pass above: resolve a
    // tag by its NORMALIZED name
    // (`tag_norm::normalize_tag_name` — the engine's tag identity key) else
    // create a new `block_type='tag'` block whose content is the display name,
    // and return its ULID. NO explicit `block_tags` association is written:
    // typing/pasting `#tag` in the editor creates an INLINE ref (materialized
    // into `block_tag_refs` from the `#[ULID]` content by the `CreateBlock`
    // dispatch's `ReindexBlockTagRefs` task — identical to how `[[ULID]]` page
    // links materialize `block_links`), not a `block_tags` row.
    //
    // The pre-pass runs in this (first) chunk's tx so created tags share its
    // atomic write. `resolved_tag_norm` keys on the normalized name so `#Foo`
    // and `#foo` converge to ONE tag; `resolved_tag_tokens` keys on the
    // ORIGINAL token name so the per-block rewrite can map each literal token
    // back to its ULID. A creation failure degrades gracefully: the token is
    // absent from `resolved_tag_tokens`, so the rewrite leaves it literal and a
    // warning is recorded (mirroring the page-link degrade behavior).
    //
    // FRONTMATTER `tags:` is intentionally NOT processed here — converting a
    // frontmatter `tags:` array into tag links is blocked on #1917 typed arrays
    // and is out of scope for #1924/#1950.
    let mut resolved_tag_norm: HashMap<String, String> = HashMap::new();
    let mut resolved_tag_tokens: HashMap<String, String> = HashMap::new();
    let existing_tag_by_norm = snapshot_tags_by_norm(&mut tx, space_id).await?;
    for token_name in tag_token_names {
        let norm = agaric_core::tag_norm::normalize_tag_name(&token_name);

        // Already resolved/created in this pass (case/dedup convergence).
        if let Some(ulid) = resolved_tag_norm.get(&norm) {
            resolved_tag_tokens.insert(token_name, ulid.clone());
            continue;
        }

        // Reuse an EXISTING in-space tag whose normalized name matches, from the
        // pre-loop snapshot (smallest-id winner, mirroring the tags-cache). Tags
        // are space-scoped: a same-name tag in ANOTHER space must NOT be reused —
        // the cross-space gate in `reindex_block_tag_refs` would then drop the
        // inline `#[ULID]` ref and silently fail to attach — so the snapshot is
        // already filtered to `space_id`, and a new in-space tag is created
        // below when there is no match.
        if let Some(id) = existing_tag_by_norm.get(&norm) {
            resolved_tag_norm.insert(norm, id.clone());
            resolved_tag_tokens.insert(token_name, id.clone());
            continue;
        }

        // Create the missing tag block inside this chunk's tx. On failure,
        // degrade: warn and leave the token literal (it is simply absent from
        // `resolved_tag_tokens`).
        match create_block_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            "tag".into(),
            token_name.clone(),
            None,
            None,
            // #2849 PR2: server-generated id.
            None,
        )
        .await
        {
            Ok((new_tag, new_tag_op)) => {
                tx.enqueue_background(new_tag_op);
                let new_tag_id = new_tag.id.clone().into_string();
                stamp_space_property(
                    &mut tx,
                    materializer,
                    device_id,
                    new_tag_id.clone(),
                    space_id,
                )
                .await?;
                ctx.created.push(new_tag);
                resolved_tag_norm.insert(norm, new_tag_id.clone());
                resolved_tag_tokens.insert(token_name, new_tag_id);
            }
            Err(e) => {
                tracing::warn!(
                    name = %token_name,
                    error = %e,
                    "import: tag create failed; leaving token as plain text (#1924)"
                );
                ctx.warnings.push(format!(
                    "tag '#{token_name}' could not be created; left as plain text"
                ));
            }
        }
    }
    Ok((
        tx,
        resolved_tag_norm,
        resolved_tag_tokens,
        existing_tag_by_norm,
    ))
}

/// The individual items of a frontmatter list value.
///
/// #2829 — the comma-joined scalar in `frontmatter` is lossy for an item that
/// itself contains a literal comma, so the REAL parsed item boundaries from
/// `frontmatter_list_items` win whenever the key arrived as a genuine YAML
/// sequence; a plain unbracketed scalar (no boundary info available) falls back
/// to the legacy comma-split.
fn frontmatter_items<'a>(
    parse_output: &'a import::ParseOutput,
    key: &str,
    value: &'a str,
) -> Vec<&'a str> {
    if let Some(items) = parse_output.frontmatter_list_items.get(key) {
        items.iter().map(String::as_str).collect()
    } else {
        value
            .split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .collect()
    }
}

/// #2722 — write the real page→tag association via the shared tag-apply helper
/// (op-log `AddTag` + engine projection), queueing the op for post-commit
/// dispatch. An association that already exists is an idempotent no-op
/// (`Ok(None)`). A cross-space rejection is impossible here (page and tag share
/// the import's space), but degrades to a warning rather than aborting the
/// durable import if it ever occurs.
async fn associate_page_tag(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    page_id: &str,
    tag_id: &str,
    tag_name: &str,
    warnings: &mut Vec<String>,
) {
    let payload = agaric_store::op::OpPayload::AddTag(agaric_store::op::AddTagPayload {
        block_id: BlockId::from_trusted(page_id),
        tag_id: BlockId::from_trusted(tag_id),
    });
    match crate::commands::tags::apply_tag_to_block_in_tx(
        &mut *tx,
        materializer.loro_state(),
        device_id,
        page_id,
        tag_id,
        payload,
    )
    .await
    {
        Ok(Some(op_record)) => tx.enqueue_background(op_record),
        Ok(None) => { /* association already exists — idempotent */ }
        Err(e) => {
            tracing::warn!(
                name = %tag_name,
                error = %e,
                "import: frontmatter tag association failed; skipped (#2722)"
            );
            warnings.push(format!(
                "page tag '{tag_name}' could not be associated ({e})"
            ));
        }
    }
}

/// Resolve one frontmatter tag NAME to a tag block id, REUSING the inline-tag
/// pre-pass state (`resolved_tag_norm` for this-pass creations,
/// `existing_tag_by_norm` for in-space matches) so a name appearing BOTH inline
/// and in frontmatter converges to ONE tag block, and creating the tag when
/// neither has it. `None` degrades: the create failed, so the caller skips this
/// tag's association with a warning already recorded.
async fn resolve_or_create_frontmatter_tag(
    ctx: &mut ImportCtx<'_>,
    tx: &mut CommandTx,
    tag_name: &str,
    resolved_tag_norm: &mut HashMap<String, String>,
    existing_tag_by_norm: &HashMap<String, String>,
) -> Result<Option<String>, AppError> {
    let norm = agaric_core::tag_norm::normalize_tag_name(tag_name);
    if let Some(id) = resolved_tag_norm.get(&norm) {
        return Ok(Some(id.clone()));
    }
    if let Some(id) = existing_tag_by_norm.get(&norm) {
        let id = id.clone();
        resolved_tag_norm.insert(norm, id.clone());
        return Ok(Some(id));
    }
    // Create the missing tag block + stamp its space (mirrors the inline-tag
    // pre-pass and the importing page). On failure, degrade: warn and skip this
    // tag's association.
    match create_block_in_tx(
        &mut *tx,
        ctx.materializer.loro_state(),
        ctx.device_id,
        "tag".into(),
        tag_name.to_string(),
        None,
        None,
        // #2849 PR2: server-generated id.
        None,
    )
    .await
    {
        Ok((new_tag, new_tag_op)) => {
            tx.enqueue_background(new_tag_op);
            let new_tag_id = new_tag.id.clone().into_string();
            stamp_space_property(
                tx,
                ctx.materializer,
                ctx.device_id,
                new_tag_id.clone(),
                &ctx.space_id,
            )
            .await?;
            resolved_tag_norm.insert(norm, new_tag_id.clone());
            Ok(Some(new_tag_id))
        }
        Err(e) => {
            tracing::warn!(
                name = %tag_name,
                error = %e,
                "import: frontmatter tag create failed; association skipped (#2722)"
            );
            ctx.warnings.push(format!(
                "page tag '{tag_name}' could not be created; not applied"
            ));
            Ok(None)
        }
    }
}

/// #2722 — apply page-level frontmatter `tags:` as real `block_tags`
/// associations, reusing the inline-tag pre-pass state. Returns the transaction.
async fn apply_frontmatter_tags(
    ctx: &mut ImportCtx<'_>,
    mut tx: CommandTx,
    parse_output: &import::ParseOutput,
    resolved_tag_norm: &mut HashMap<String, String>,
    existing_tag_by_norm: &HashMap<String, String>,
) -> Result<CommandTx, AppError> {
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let page_id = ctx.page_id.clone();
    // #2722 — apply page-level frontmatter `tags:` as REAL `block_tags`
    // associations on the imported page, instead of the inert text property the
    // pre-#2722 importer stamped (which silently disabled tag filtering on
    // re-import). The historical blocker cited in #1924/#1950 was #1917 (typed
    // arrays could not be parsed); that is RESOLVED — the exported `[a, b]` flow
    // sequence now arrives as a comma-joined scalar via `parse_frontmatter`
    // (see the frontmatter parser), so the value is available here.
    //
    // Runs in the FIRST chunk's tx (before the block loop opens any new chunk),
    // sharing the page's atomic write. The page's `space_id` was materialised
    // in-tx by the `space` property set above (`set_property_in_tx` routes the
    // reserved `space` key through the projection's `UPDATE blocks SET
    // space_id`), and every tag we reuse/create is space-scoped to the SAME
    // space, so the helper's cross-space guard passes without adoption.
    if let Some((_k, tags_value)) = parse_output
        .frontmatter
        .iter()
        .find(|(k, _)| k.as_str() == "tags")
    {
        for tag_name in frontmatter_items(parse_output, "tags", tags_value) {
            let tag_id = resolve_or_create_frontmatter_tag(
                ctx,
                &mut tx,
                tag_name,
                resolved_tag_norm,
                existing_tag_by_norm,
            )
            .await?;
            let Some(tag_id) = tag_id else {
                continue;
            };
            associate_page_tag(
                &mut tx,
                materializer,
                device_id,
                &page_id,
                &tag_id,
                tag_name,
                &mut ctx.warnings,
            )
            .await;
        }
    }
    Ok(tx)
}

/// #662 — commit the open import chunk (draining its op queue in FIFO order,
/// releasing the writer lock) and open a fresh one. A commit failure here aborts
/// the import; chunks already committed survive (documented partial-import
/// semantics).
///
/// #1934 — the failure log carries import context (which chunk, how many blocks
/// were durable when the abort happened) instead of a bare `Database error: …`.
/// The error itself is routed through `AppError::from(sqlx::Error)` so the IPC
/// `kind` discrimination is preserved (a writer-busy `PoolTimedOut` stays
/// `pool_busy`, a `Conflict` stays `conflict`); flattening to `Internal` would
/// have collapsed every commit failure to one kind and lost the frontend's
/// retry affordance.
async fn commit_chunk_and_reopen(
    tx: CommandTx,
    materializer: &Materializer,
    pool: &SqlitePool,
    page_title: &str,
    counters: &mut ImportCounters,
) -> Result<CommandTx, AppError> {
    let (chunks_committed, blocks_created) = (counters.chunks_committed, counters.blocks_created);
    tx.commit_and_dispatch(materializer).await.map_err(|e| {
        tracing::error!(
            page = %page_title,
            chunks_committed,
            blocks_created,
            error = %e,
            "import: chunk commit failed; committed chunks remain durable"
        );
        AppError::from(e)
    })?;
    counters.chunks_committed += 1;
    // #1932 (OBS-LOG-05) — per-chunk durability signal so a partial
    // import is observable in the log.
    tracing::debug!(
        page = %page_title,
        chunks_committed = counters.chunks_committed,
        blocks_created,
        "import: chunk committed (writer lock released)"
    );
    let mut tx = CommandTx::begin_immediate(pool, "import_markdown").await?;
    // #2604 — re-arm rollback for the new per-chunk tx.
    tx.arm_engine_rollback(materializer.loro_state());
    Ok(tx)
}

/// Commit + dispatch the final chunk's queued ops in FIFO order, releasing the
/// writer lock.
///
/// #1934 — a final-commit failure carries import context (block count / chunks
/// already durable) in an `error!` log. The error is routed through
/// `AppError::from(sqlx::Error)` so the IPC `kind` is preserved (e.g. a
/// writer-busy `PoolTimedOut` stays `pool_busy`); flattening to `Internal` would
/// have collapsed the discrimination the frontend relies on.
async fn commit_final_chunk(
    tx: CommandTx,
    materializer: &Materializer,
    page_title: &str,
    counters: &ImportCounters,
) -> Result<(), AppError> {
    let (chunks_committed, blocks_created) = (counters.chunks_committed, counters.blocks_created);
    tx.commit_and_dispatch(materializer).await.map_err(|e| {
        tracing::error!(
            page = %page_title,
            chunks_committed,
            blocks_created,
            error = %e,
            "import: final chunk commit failed"
        );
        AppError::from(e)
    })?;
    Ok(())
}

/// The block a parsed block at `depth` hangs off: pop the stack until it holds a
/// parent shallower than `depth`, falling back to the imported page itself.
///
/// The stack survives chunk flushes unchanged — every id in it refers to a block
/// committed in this or an earlier chunk, so `create_block_in_tx`'s in-tx parent
/// check (which reads committed rows) resolves cross-chunk parents fine.
fn parent_for_depth(
    parent_stack: &mut Vec<(usize, String)>,
    depth: usize,
    page_id: &str,
) -> String {
    while parent_stack.len() > 1 && parent_stack.last().is_some_and(|(d, _)| *d >= depth) {
        parent_stack.pop();
    }
    parent_stack
        .last()
        .map_or_else(|| page_id.to_string(), |(_, id)| id.clone())
}

/// One parsed block's content in its stored form: inline queries first, then
/// inbound wiki-links, then inbound inline tags.
///
/// #2968 — a readable `{{query v2n:… names …}}` payload is converted back to the
/// canonical stored `{{query v2:…ULIDs…}}` form, remapping embedded tag/page
/// names to THIS vault's ids via the same resolve maps. It runs before the
/// `[[Page]]` / `#tag` rewrites so the resulting base64url token is inert for
/// them (its alphabet has no `[[` / `#[` sequences).
///
/// #3605 — a code block's `[[Page]]` and `#tag` text is literal, so both
/// rewrites skip it wholesale (inline-code spans within a non-code block are
/// skipped inside `rewrite_inbound_tags`). Leaving the link rewrite eager meant
/// the SAME block kept its `#tag`s verbatim while its wiki-links were swapped
/// for ULIDs — an inconsistency inside one importer, not just across the two
/// implementations. The page-link rewrite runs first and leaves a `#[[...]]`
/// token in place (its `#`-prefix guard), so the tag rewrite is the sole owner
/// of that token.
fn rewrite_block_content_for_import(
    block: &import::ParsedBlock,
    page_links: &PageLinks,
    page_titles: &HashMap<String, String>,
    resolved_tag_tokens: &HashMap<String, String>,
) -> String {
    let content = super::inline_query_md::rewrite_inline_queries_for_import(
        &block.content,
        &page_links.ids,
        resolved_tag_tokens,
    );
    if block.is_code {
        return content;
    }
    let content = rewrite_inbound_page_links(&content, page_links, page_titles);
    rewrite_inbound_tags(&content, resolved_tag_tokens)
}

/// #1925 — the attachment refs in one block's (already tag/link-rewritten)
/// content, to be ingested + rewritten AFTER the import tx commits. A code block
/// keeps its `![[...]]` / `![](...)` text literal (mirroring the inline-tag
/// skip), and with no supplied vault files detection is a no-op.
fn detect_import_attachment_refs(
    content: &str,
    is_code: bool,
    vault_files: &[VaultFile],
) -> Vec<import::AttachmentRef> {
    if vault_files.is_empty() || is_code {
        return Vec::new();
    }
    let spans = import::inline_code_spans(content);
    import::detect_attachment_refs(content, &spans)
}

/// Create one imported block inside the current chunk's transaction, queueing
/// its op for post-commit dispatch and returning its ULID.
///
/// #1918 — a SINGLE problematic block degrades gracefully (`Ok(None)`:
/// skip-and-warn) rather than `?`-aborting the whole chunk/import. Two
/// RECOVERABLE per-block validation conditions are skipped:
///
///   1. The block would exceed `MAX_BLOCK_DEPTH` (a deeply-nested import block
///      whose absolute depth lands over the create-path bound — the depth clamp
///      now leaves page-root headroom, but a residual over-deep block must
///      still skip, not abort).
///   2. The block's content exceeds `MAX_CONTENT_LENGTH` (a single huge block
///      must not strand the rest of the import).
///
/// Both are surfaced by `create_block_in_tx` as `AppError::Validation` with a
/// STABLE message, AND both checks run BEFORE any write inside it, so on
/// rejection the chunk transaction is still clean and the import continues. We
/// match ONLY those two messages: every other error (`AppError::Database` /
/// pool / connection / a NotFound parent / any other Validation) still
/// propagates and aborts as before — this is not a blanket catch-all.
async fn create_import_block(
    ctx: &mut ImportCtx<'_>,
    tx: &mut CommandTx,
    content: String,
    parent_id: String,
    depth: usize,
) -> Result<Option<String>, AppError> {
    let create_result = create_block_in_tx(
        &mut *tx,
        ctx.materializer.loro_state(),
        ctx.device_id,
        "content".into(),
        content,
        Some(parent_id),
        None,
        // #2849 PR2: server-generated id.
        None,
    )
    .await;
    match create_result {
        Ok((new_block, block_op)) => {
            tx.enqueue_background(block_op);
            Ok(Some(new_block.id.clone().into_string()))
        }
        Err(AppError::Validation { message: msg, .. })
            if msg.contains("maximum nesting depth")
                || (msg.contains("content length") && msg.contains("exceeds maximum")) =>
        {
            tracing::warn!(
                page = %ctx.page_title,
                depth,
                reason = %msg,
                "import: skipping block that failed a recoverable validation check (#1918)"
            );
            ctx.warnings.push(format!(
                "1 block skipped during import (recoverable validation failure: {msg})"
            ));
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// Whose property values [`apply_block_properties`] writes, which decides
/// how [`PropertyLines`] reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PropertyWrite {
    /// An imported file: a value its definition refuses stays text in the
    /// block, with a warning (#5160 D11).
    Import,
    /// Duplicate re-stores values a block already held, from a source render:
    /// a `ref`-declared value is the raw id, and options the key has since
    /// retired or narrowed must not make the copy fail.
    Copy,
    /// Pasted text, read as an import reads a file (D11).
    Paste,
    /// A source-mode save writes what the user typed: a value its definition
    /// refuses refuses the save, naming the line.
    Edit,
}

/// Set one block's properties, each under its canonical key, in the same
/// transaction as the block itself — an import never splits a block and its
/// properties across a chunk boundary (they are written before the next
/// depth-0 flush check). Returns how many it set.
///
/// Each value is typed by its key's declared `value_type` (#2982): a
/// number-, boolean- or date-typed custom property imports into the column it
/// exported from, a `ref`-declared one as the block its id or title names, and
/// the reserved date keys as `value_date` (#623). `lines` read the definitions
/// once for the whole surface; a line they refuse is an error here, which only
/// a source save reaches: an import and a paste keep such a line as text first
/// ([`PropertyLines::keep_refused_as_text`]).
async fn apply_block_properties(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    block_id: &str,
    properties: &[(String, String)],
    lines: &PropertyLines,
) -> Result<u64, AppError> {
    let mut set: u64 = 0;
    for (key, value) in properties {
        let (value_text, value_num, value_date, value_ref, value_bool) =
            lines.read(key, value).map_err(|reason| {
                AppError::validation(format!("`{key}:: {value}` cannot be saved: {reason}"))
            })?;
        let (_block, prop_op) = agaric_engine::block_ops::set_property_in_tx_with_declaration(
            tx,
            materializer.loro_state(),
            device_id,
            block_id.to_string(),
            key,
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool,
            lines.declaration(key),
        )
        .await?;
        set += 1;
        tx.enqueue_background(prop_op);
    }
    Ok(set)
}

/// The `priority` an import stores for `value`: an Org priority letter, which
/// the parser writes for `[#A]`–`[#C]` (#5160 D7), is the first, second or
/// third option of the `priority` definition (`options`, its JSON list), or of
/// the seeded defaults when the definition is gone, so a Logseq `[#A]` is what
/// `Ctrl+Shift+1` sets. Any other value, and a letter the options do not
/// reach, is what was written.
fn import_priority_value(value: &str, options: Option<&str>) -> String {
    let Some(position) = ["A", "B", "C"].iter().position(|letter| *letter == value) else {
        return value.to_string();
    };
    let declared: Option<Vec<String>> = options.and_then(|json| serde_json::from_str(json).ok());
    let option = match declared {
        Some(declared) => declared.get(position).cloned(),
        None => super::super::properties::PRIORITY_FALLBACK_DEFAULTS
            .get(position)
            .map(|option| (*option).to_string()),
    };
    option.unwrap_or_else(|| value.to_string())
}

/// #662 — chunked block-insertion loop + final commit. Accumulates into the
/// running counters and returns the per-block-index created ULIDs plus the
/// pending attachment refs consumed by the post-commit phases. Consumes `tx` (it
/// commits the final chunk).
#[allow(clippy::type_complexity)]
async fn insert_blocks(
    ctx: &mut ImportCtx<'_>,
    mut tx: CommandTx,
    parse_output: &import::ParseOutput,
    refs: &DocumentRefs,
    vault_files: &[VaultFile],
    counters: &mut ImportCounters,
) -> Result<
    (
        Vec<Option<String>>,
        Vec<(String, Vec<import::AttachmentRef>)>,
    ),
    AppError,
> {
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let pool = ctx.pool;
    let page_id = ctx.page_id.clone();
    let page_title = ctx.page_title.clone();
    let blocks_total = ctx.blocks_total;
    let progress = ctx.progress;
    // #662 — number of blocks written into the *current* chunk's
    // transaction. Reset to 0 each time a chunk is flushed. A new chunk is
    // only opened at a top-level (depth-0) subtree boundary, so a chunk
    // never splits a subtree (parent + all descendants commit together).
    let mut chunk_blocks: usize = 0;
    // #1925 — attachment refs detected per committed content block, collected
    // DURING the block loop but ingested AFTER the import writer tx fully
    // commits (see the post-commit phase below). Each entry is (block_id,
    // detected refs in that block's content). The block content is written with
    // its ORIGINAL refs here; the post-commit phase ingests the matched bytes
    // and edits the block content to the canonical `attachment:<id>` form. This
    // sequencing is what avoids the deadlock: `add_attachment_with_bytes_inner`
    // is pool-based and opens its OWN writer tx, which would deadlock against
    // the held `import_markdown` IMMEDIATE tx — so NO attachment ingest runs
    // while any import chunk tx is open. `vault_files` empty/None ⇒ this stays
    // empty and the whole phase is a no-op.
    let mut pending_attachments: Vec<(String, Vec<import::AttachmentRef>)> = Vec::new();
    let mut parent_stack: Vec<(usize, String)> = vec![(0, page_id.clone())];
    // #2510 — index-aligned with `parse_output.blocks`: the created ULID of
    // each block, or `None` for one skipped by the #1918 recoverable-failure
    // path. Used by the block-anchor resolution pass after this loop to map
    // an anchor's owning `ParsedBlock` INDEX (`anchor_to_block_index`) to the
    // actual block it became.
    let mut created_block_ids: Vec<Option<String>> = vec![None; parse_output.blocks.len()];

    for (block_index, block) in parse_output.blocks.iter().enumerate() {
        // #662 — chunk-boundary flush. We may only break the import into a
        // new transaction at a top-level (depth-0) block: that guarantees
        // the chunk just closed holds whole subtrees (a parent and all its
        // descendants), never a half-written one. Flush when the open
        // chunk has reached the size threshold AND this block starts a new
        // depth-0 subtree. The page + space property written above count
        // toward neither threshold; `chunk_blocks` tracks content blocks.
        if block.depth == 0 && chunk_blocks >= IMPORT_CHUNK_BLOCKS {
            tx = commit_chunk_and_reopen(tx, materializer, pool, &page_title, counters).await?;
            chunk_blocks = 0;
        }

        let parent_id = parent_for_depth(&mut parent_stack, block.depth, &page_id);
        let content = rewrite_block_content_for_import(
            block,
            &refs.links.page_links,
            &refs.links.titles,
            &refs.tag_tokens,
        );
        let detected_attachment_refs =
            detect_import_attachment_refs(&content, block.is_code, vault_files);

        // The parent stack is NOT pushed for a #1918-skipped block, so any of
        // its children re-parent onto the nearest surviving ancestor (matching
        // the depth-clamp flattening semantics).
        let Some(new_block_id) =
            create_import_block(ctx, &mut tx, content, parent_id, block.depth).await?
        else {
            continue;
        };
        counters.blocks_created += 1;
        chunk_blocks += 1;
        // #2510 — record this ParsedBlock's created ULID by its original
        // document index, for the block-anchor resolution pass below.
        created_block_ids[block_index] = Some(new_block_id.clone());
        parent_stack.push((block.depth, new_block_id.clone()));

        // #1925 — record this block's detected attachment refs against its now
        // committed-pending id. Ingested + rewritten in the post-commit phase.
        if !detected_attachment_refs.is_empty() {
            pending_attachments.push((new_block_id.clone(), detected_attachment_refs));
        }

        // #128 — per-block progress tick. Emitted inside the loop so a
        // large file shows forward motion; the rows are not yet committed
        // (the `Complete` event after `commit_and_dispatch` is the
        // durability signal).
        if let Some(sink) = progress {
            sink.emit(ImportProgressUpdate::Progress {
                blocks_done: counters.blocks_created,
                blocks_total,
            });
        }

        counters.properties_set += apply_block_properties(
            &mut tx,
            materializer,
            device_id,
            &new_block_id,
            &block.properties,
            &ctx.lines,
        )
        .await?;
    }

    commit_final_chunk(tx, materializer, &page_title, counters).await?;
    Ok((created_block_ids, pending_attachments))
}

/// #2510 / #2567 — what one document's deferred anchor links resolved to, so
/// each outcome can surface its own diagnostic once, in aggregate.
#[derive(Default)]
struct AnchorOutcomes {
    resolved_block_refs: usize,
    unresolved_block_anchors: usize,
    resolved_heading_refs: usize,
    unresolved_headings: usize,
    unresolved_empty_base_headings: std::collections::BTreeSet<String>,
    /// Labels on links that became block refs, which have no label (#5160 D9).
    dropped_labels: usize,
}

/// The block's CURRENT (durable, tag/link-rewritten) content, or `None` when the
/// block vanished (concurrent delete) or could not be read. This phase runs
/// AFTER the import committed, so a transient read error warns and skips rather
/// than turning a durable import into a hard failure.
async fn fetch_anchor_block_content(
    pool: &SqlitePool,
    block_id: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match sqlx::query_scalar!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row.flatten(),
        Err(e) => {
            tracing::warn!(
                block_id = %block_id,
                error = %e,
                "import: block-anchor content re-fetch failed (#2510)"
            );
            warnings.push(format!(
                "block '{block_id}' block-anchor link(s) could not be resolved \
                 (content re-fetch failed: {e})"
            ));
            None
        }
    }
}

/// Rewrite one block's deferred anchor tokens, returning the new content when
/// anything was patched.
///
/// The PRECISE match is re-run here via the same `HUMAN_PAGE_LINK_RE` the
/// initial rewrite pass uses, against the block's CURRENT content — this avoids
/// any literal-substring drift between the captured map key (`caps[1].trim()`)
/// and the token's actual on-disk bytes.
///
///   * #2510 — the anchor id matches a `^block-id` marker recorded on one of
///     this document's OWN blocks, and that block was actually created →
///     rewrite every occurrence of the token to a real Agaric block-ref
///     `((<block ULID>))`.
///   * #2567 — a heading anchor resolves its normalized label to the owning
///     block's ULID, rewriting to the SAME block-ref form so navigation
///     (scroll/focus-to-block) is reused verbatim.
///   * otherwise (marker not found anywhere in this document, or its owning
///     block was skipped) → fall back to a link to THIS page, mirroring #1282's
///     dropped-anchor fallback. The one exception is an anchor-only
///     `[[#Heading]]` that matched no heading: it is left LITERAL with a
///     per-token "no page target" warning, exactly as before #2567.
fn rewrite_anchor_tokens(
    current_content: &str,
    page_id: &str,
    created_block_ids: &[Option<String>],
    refs: &DocumentRefs,
    outcomes: &mut AnchorOutcomes,
) -> Option<String> {
    let mut any_patched = false;
    let new_content = HUMAN_PAGE_LINK_RE
        .replace_all(current_content, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("group 0 always present");
            let whole = m.as_str();
            // Same guards as `rewrite_inbound_page_links`: skip the
            // `#[[Tag]]` / `![[embed]]` forms and any already-internal
            // `[[ULID]]` ref.
            if current_content[..m.start()].ends_with('#')
                || current_content[..m.start()].ends_with('!')
            {
                return whole.to_string();
            }
            if agaric_store::cache::PAGE_LINK_RE.is_match(whole) {
                return whole.to_string();
            }
            // A block ref has no label form, so a label is dropped with it
            // (#5160 D9); the page-link fallback keeps it.
            let Some((name, label)) = refs.links.page_links.readings.get(caps[1].trim()) else {
                return whole.to_string();
            };
            let label = label.as_deref();
            let mut block_ref = |target_id: String| {
                outcomes.dropped_labels += usize::from(label.is_some());
                format!("(({target_id}))")
            };
            if let Some(anchor) = refs.links.pending_block_anchors.get(name) {
                any_patched = true;
                if let Some(target_id) = refs
                    .anchor_to_block_index
                    .get(anchor)
                    .and_then(|&target_idx| created_block_ids.get(target_idx).cloned().flatten())
                {
                    outcomes.resolved_block_refs += 1;
                    block_ref(target_id)
                } else {
                    outcomes.unresolved_block_anchors += 1;
                    stored_page_link(page_id, label, None)
                }
            } else if let Some(pending) = refs.links.pending_heading_anchors.get(name) {
                if let Some(target_id) = refs
                    .heading_to_block_index
                    .get(&pending.norm)
                    .and_then(|&target_idx| created_block_ids.get(target_idx).cloned().flatten())
                {
                    any_patched = true;
                    outcomes.resolved_heading_refs += 1;
                    block_ref(target_id)
                } else if pending.empty_base {
                    outcomes.unresolved_empty_base_headings.insert(name.clone());
                    whole.to_string()
                } else {
                    any_patched = true;
                    outcomes.unresolved_headings += 1;
                    stored_page_link(page_id, label, None)
                }
            } else {
                whole.to_string()
            }
        })
        .into_owned();
    any_patched.then_some(new_content)
}

/// Surface each anchor-resolution outcome once, in aggregate.
fn push_anchor_warnings(warnings: &mut Vec<String>, outcomes: &AnchorOutcomes) {
    if outcomes.resolved_block_refs > 0 {
        tracing::debug!(
            resolved_block_ref_count = outcomes.resolved_block_refs,
            "import: Obsidian block-anchor wiki-link(s) resolved to a block-ref (#2510)"
        );
    }
    if outcomes.unresolved_block_anchors > 0 {
        // #2510 — mirrors #1282's dropped-anchor aggregate warning: the
        // block-anchor marker was not found anywhere in this document
        // (or its owning block was skipped), so the link fell back to a
        // page link to this page instead of a block-ref.
        let unresolved_block_anchor_count = outcomes.unresolved_block_anchors;
        warnings.push(format!(
            "{unresolved_block_anchor_count} wikilink block-anchor(s) (`#^blockId`) could not \
             be matched to a block in this document; left as a page link (Obsidian \
             cross-note block-anchor targeting is not yet supported)"
        ));
    }
    if outcomes.resolved_heading_refs > 0 {
        tracing::debug!(
            resolved_heading_ref_count = outcomes.resolved_heading_refs,
            "import: Obsidian heading-anchor wiki-link(s) resolved to a block-ref (#2567)"
        );
    }
    if outcomes.unresolved_headings > 0 {
        // #2567 — mirrors the block-anchor aggregate warning: an explicit
        // self-title heading link matched no heading in this document, so it
        // fell back to a page link instead of a block-ref.
        let unresolved_heading_count = outcomes.unresolved_headings;
        warnings.push(format!(
            "{unresolved_heading_count} wikilink heading-anchor(s) (`#Heading`) could not be \
             matched to a heading in this document; left as a page link (Obsidian cross-note \
             heading targeting is not yet supported)"
        ));
    }
    for name in &outcomes.unresolved_empty_base_headings {
        // #1282 — an anchor-only `[[#Heading]]` with no matching heading is
        // left literal; surface the same per-occurrence "no page target"
        // diagnostic the pre-#2567 pre-pass emitted, so behavior (and the
        // #1282 test) is unchanged for the unresolved case.
        warnings.push(format!(
            "wiki-link '[[{name}]]' has no page target (intra-note anchor); left as plain text"
        ));
    }
    if outcomes.dropped_labels > 0 {
        warnings.push(format!(
            "{} link label(s) were dropped: a block reference carries no label",
            outcomes.dropped_labels
        ));
    }
}

/// #2510 / #2567 — post-commit resolution of deferred same-document block- and
/// heading-anchor wiki-links to real `((block ULID))` refs (with the #1282
/// page-link fallback). Warn-and-continue only; never aborts the durable import.
///
/// Runs HERE, AFTER the import writer tx has fully committed (mirrors the #1925
/// attachment phase below, for the same reason: `edit_block_inner` is pool-based
/// and opens its OWN writer tx, which would deadlock against the still-held
/// import tx). Every block in this document now has its final ULID (or `None`,
/// if skipped by #1918), so a deferred `[[Page#^blockId]]` / `[[#^blockId]]`
/// token — left LITERAL in its owning block's content by the pre-pass — can
/// finally be resolved.
async fn resolve_anchor_links(
    ctx: &mut ImportCtx<'_>,
    parse_output: &import::ParseOutput,
    created_block_ids: &[Option<String>],
    refs: &DocumentRefs,
) {
    if refs.links.pending_block_anchors.is_empty() && refs.links.pending_heading_anchors.is_empty()
    {
        return;
    }
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let pool = ctx.pool;
    let page_id = ctx.page_id.clone();
    let mut outcomes = AnchorOutcomes::default();

    for (block_index, block) in parse_output.blocks.iter().enumerate() {
        // A cheap in-memory pre-filter over the ORIGINAL parsed content (`[[`
        // presence) so only blocks that could possibly carry a pending token are
        // re-fetched from the database.
        if !block.content.contains("[[") {
            continue;
        }
        let Some(Some(container_id)) = created_block_ids.get(block_index) else {
            // The containing block itself was skipped (#1918) — nothing
            // to patch.
            continue;
        };
        let Some(current_content) =
            fetch_anchor_block_content(pool, container_id, &mut ctx.warnings).await
        else {
            continue;
        };
        if !current_content.contains("[[") {
            continue;
        }
        let Some(new_content) = rewrite_anchor_tokens(
            &current_content,
            &page_id,
            created_block_ids,
            refs,
            &mut outcomes,
        ) else {
            continue;
        };

        if let Err(e) = crate::commands::blocks::crud::edit_block_inner(
            pool,
            device_id,
            materializer,
            BlockId::from_trusted(container_id),
            new_content,
        )
        .await
        {
            tracing::warn!(
                block_id = %container_id,
                error = %e,
                "import: block-anchor rewrite failed (#2510)"
            );
            ctx.warnings.push(format!(
                "block '{container_id}' block-anchor link(s) could not be rewritten ({e})"
            ));
        }
    }

    push_anchor_warnings(&mut ctx.warnings, &outcomes);
}

/// The path-derived fields and byte length one vault file ingests with.
///
/// #2724 — read in a SHORT immutable borrow of the file so the `std::mem::take`
/// that follows is not blocked by a live `&vf` spanning the whole ingest.
fn vault_file_ingest_fields(vf: &VaultFile) -> (String, String, i64) {
    let filename = vf
        .path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&vf.path)
        .to_string();
    let mime_type = import::guess_attachment_mime(&vf.path);
    // `i64::try_from` avoids the `usize as i64` wrap; a length
    // that doesn't fit i64 is by definition over the limit.
    let size_bytes = i64::try_from(vf.bytes.len()).unwrap_or(i64::MAX);
    (filename, mime_type, size_bytes)
}

/// #2724 — MOVE the bytes out for a single-ATTEMPT file so the buffer is freed
/// right after ingest instead of cloned (a transient per-file doubling).
/// `ingest_counts[idx] == 1` proves no other ingest attempt — including a retry
/// of a transiently failed first attempt within this block — will read this
/// file, so the move is safe. `remove` flips it out of the single-attempt set
/// and `moved_out` records the empty buffer. Any file with count > 1 always
/// clones, exactly as before.
///
/// `None` means the bytes were already moved out: under a correct count that is
/// unreachable, but refusing to ingest an emptied buffer guarantees it is NEVER
/// re-ingested as a 0-byte attachment.
fn take_or_clone_bytes(
    vault_files: &mut [VaultFile],
    idx: usize,
    ingest_counts: &mut HashMap<usize, usize>,
    moved_out: &mut std::collections::HashSet<usize>,
) -> Option<Vec<u8>> {
    if ingest_counts.get(&idx).copied() == Some(1) {
        ingest_counts.remove(&idx);
        moved_out.insert(idx);
        return Some(std::mem::take(&mut vault_files[idx].bytes));
    }
    if moved_out.contains(&idx) {
        return None;
    }
    Some(vault_files[idx].bytes.clone())
}

/// The vault-file index one attachment ref resolves to. A ref matching nothing
/// is left as-is, and one matching several files by basename uses the first —
/// both warn rather than failing the already-durable import.
fn match_ref_to_vault_file(
    att: &import::AttachmentRef,
    vault_files: &[VaultFile],
    warnings: &mut Vec<String>,
) -> Option<usize> {
    let Some((idx, ambiguous)) = import::match_vault_file(&att.original_ref, vault_files) else {
        warnings.push(format!(
            "referenced attachment '{}' was not found among the imported \
             vault files; left as-is",
            att.original_ref
        ));
        return None;
    };
    if ambiguous {
        warnings.push(format!(
            "attachment ref '{}' matched multiple vault files by basename; \
             used the first match",
            att.original_ref
        ));
    }
    Some(idx)
}

/// Ingest every attachment ref detected in ONE content block, returning the
/// `(ref, attachment id)` pairs its content rewrite needs.
///
/// ROW OWNERSHIP: a FRESH attachment row per owning block (matching the editor's
/// `add_attachment_with_bytes_inner`; identical bytes may still share a
/// content-addressed blob). The ONLY row-level dedup is within a single block:
/// the same `original_ref` appearing multiple times in ONE block ingests once
/// and both rewrites share that id — safe because the duplicates share the same
/// owning block and thus the same CASCADE lifetime. Cross-page/cross-block asset
/// dedup is intentionally DEFERRED: it needs attachment refcounting/GC the schema
/// lacks (`attachments.block_id` is `ON DELETE CASCADE` and not space-scoped, so
/// reusing one row across blocks would dangle peers when the owner block is
/// deleted, and cross-space peers would never receive the `AddAttachment` op).
///
/// Warnings (not-found, oversized, disallowed mime, ingest failure) leave the
/// original ref in place and never abort the already-durable import.
async fn ingest_block_attachments(
    ctx: &mut ImportCtx<'_>,
    vault_files: &mut [VaultFile],
    ingest_counts: &mut HashMap<usize, usize>,
    moved_out: &mut std::collections::HashSet<usize>,
    block_id: &str,
    refs: &[import::AttachmentRef],
) -> Vec<(import::AttachmentRef, String)> {
    // Per-BLOCK cache: original_ref → resolved `attachment:<id>` for
    // refs already ingested for THIS block. NOT carried across blocks.
    let mut block_ingested: HashMap<String, String> = HashMap::new();
    let mut block_rewrites: Vec<(import::AttachmentRef, String)> = Vec::new();

    for att in refs {
        // Already ingested for this block (same original ref string).
        if let Some(attachment_id) = block_ingested.get(&att.original_ref) {
            block_rewrites.push((att.clone(), attachment_id.clone()));
            continue;
        }

        let Some(idx) = match_ref_to_vault_file(att, vault_files, &mut ctx.warnings) else {
            continue;
        };
        let (filename, mime_type, size_bytes) = vault_file_ingest_fields(&vault_files[idx]);

        // Size guard (mirrors the attachment ingest's 50 MB limit). On
        // an oversized file: warn + skip (leave the original ref). This
        // `continue` fires BEFORE the move/clone below, so a size-skipped
        // file's bytes are never taken.
        if size_bytes > crate::commands::MAX_ATTACHMENT_SIZE {
            ctx.warnings.push(format!(
                "attachment '{}' ({size_bytes} bytes) exceeds the maximum size; skipped",
                att.original_ref,
            ));
            continue;
        }

        let Some(bytes) = take_or_clone_bytes(vault_files, idx, ingest_counts, moved_out) else {
            ctx.warnings.push(format!(
                "attachment '{}' could not be re-imported (source bytes already \
                 consumed by a prior ingest); left as-is",
                att.original_ref
            ));
            continue;
        };

        // Fresh ingest, owned by this content block. A failure
        // (disallowed mime, write error, transient DB error, etc.)
        // degrades to warn+skip so a single bad asset never fails the
        // (already durable) import.
        let attachment_id = match crate::commands::attachments::add_attachment_with_bytes_inner(
            ctx.pool,
            ctx.device_id,
            ctx.materializer,
            ctx.app_data_dir,
            BlockId::from_trusted(block_id),
            filename,
            mime_type,
            bytes,
        )
        .await
        {
            Ok(row) => row.id.into_string(),
            Err(e) => {
                tracing::warn!(
                    reference = %att.original_ref,
                    error = %e,
                    "import: attachment ingest failed; leaving original ref (#1925)"
                );
                ctx.warnings.push(format!(
                    "attachment '{}' could not be imported ({e}); left as-is",
                    att.original_ref
                ));
                continue;
            }
        };

        block_ingested.insert(att.original_ref.clone(), attachment_id.clone());
        block_rewrites.push((att.clone(), attachment_id));
    }
    block_rewrites
}

/// Rewrite one block's content: each matched ref's full token (`![[file]]` /
/// `![alt](path)`) → canonical `![alt](attachment:<id>)`, preserving the
/// original alt text. The CURRENT content is fetched first (it is the durable,
/// tag/link-rewritten version) and tokens are replaced in it.
///
/// A transient DB read error, a vanished block, or a failed edit must NOT abort
/// the (already durable) import — each warns and skips instead.
async fn rewrite_block_attachment_refs(
    ctx: &mut ImportCtx<'_>,
    block_id: &str,
    block_rewrites: &[(import::AttachmentRef, String)],
) {
    let pool = ctx.pool;
    let current: Option<String> = match sqlx::query_scalar!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row.flatten(),
        Err(e) => {
            tracing::warn!(
                block_id = %block_id,
                error = %e,
                "import: attachment-ref content re-fetch failed (#1925)"
            );
            ctx.warnings.push(format!(
                "block '{block_id}' attachment refs could not be rewritten \
                 (content re-fetch failed: {e})"
            ));
            return;
        }
    };
    let Some(mut new_content) = current else {
        // Block vanished (concurrent delete) — nothing to rewrite.
        return;
    };
    for (att, attachment_id) in block_rewrites {
        let canonical = format!("![{}](attachment:{})", att.alt, attachment_id);
        new_content = new_content.replacen(&att.full_match, &canonical, 1);
    }

    // Edit via the normal in-tx content-update path (opens its own
    // writer tx — safe now the import tx is committed).
    if let Err(e) = crate::commands::blocks::crud::edit_block_inner(
        pool,
        ctx.device_id,
        ctx.materializer,
        BlockId::from_trusted(block_id),
        new_content,
    )
    .await
    {
        tracing::warn!(
            block_id = %block_id,
            error = %e,
            "import: attachment-ref content rewrite failed (#1925)"
        );
        ctx.warnings.push(format!(
            "block '{block_id}' attachment refs could not be rewritten ({e})"
        ));
    }
}

/// #1925 — post-commit attachment ingest + content rewrite. Takes ownership of
/// `vault_files` so single-attempt files' bytes can be moved out. Warn-and-
/// continue only; never aborts the durable import.
///
/// Runs HERE, AFTER the import writer tx has fully committed and released the
/// writer lock, so it never overlaps the held IMMEDIATE tx.
/// `add_attachment_with_bytes_inner` and `edit_block_inner` are both pool-based
/// (each opens its OWN `BEGIN IMMEDIATE` tx); running them inside the import tx
/// would deadlock on the single SQLite writer lock — sequencing them strictly
/// after the final commit is what makes this safe.
///
/// OWNERSHIP: each attachment is owned by the CONTENT block it appears in (the
/// block's `block_id` FK), matching editor semantics — an attachment's lifecycle
/// follows its owning block (delete the block, the attachment GCs). The block
/// already exists + is committed (durable) by the time we ingest, so the FK is
/// satisfied and the rewrite is a normal `edit_block_inner`.
async fn ingest_attachments(
    ctx: &mut ImportCtx<'_>,
    mut vault_files: Vec<VaultFile>,
    pending_attachments: Vec<(String, Vec<import::AttachmentRef>)>,
) {
    if pending_attachments.is_empty() {
        return;
    }
    // #2724 — count how many INGEST ATTEMPTS will read each vault file so a
    // SINGLE-ATTEMPT file (the overwhelming common case) can have its bytes
    // MOVED out at ingest instead of cloned.
    let mut ingest_counts = ingest_read_counts(&pending_attachments, &vault_files);
    // Defence-in-depth for the move/clone decision: an index whose bytes were
    // taken (moved) is recorded here so the clone arm can never re-ingest an
    // emptied buffer as a 0-byte attachment, even if the count above were ever
    // wrong. Under a correct `ingest_counts` this set is never consulted on a
    // reachable path, but it makes "a moved buffer is never re-ingested" total.
    let mut moved_out: std::collections::HashSet<usize> = std::collections::HashSet::new();

    for (block_id, refs) in &pending_attachments {
        let block_rewrites = ingest_block_attachments(
            ctx,
            &mut vault_files,
            &mut ingest_counts,
            &mut moved_out,
            block_id,
            refs,
        )
        .await;
        if block_rewrites.is_empty() {
            continue;
        }
        rewrite_block_attachment_refs(ctx, block_id, &block_rewrites).await;
    }
}

/// #128 / #1932 / #1934 — emit the `Complete` progress event, log the collected
/// diagnostics + completion telemetry, and build the returned [`ImportResult`].
fn finish(ctx: ImportCtx<'_>, counters: &ImportCounters) -> ImportResult {
    let &ImportCounters {
        blocks_created,
        properties_set,
        chunks_committed,
    } = counters;
    let ImportCtx {
        progress,
        page_title,
        warnings,
        started_at,
        ..
    } = ctx;
    // #128 — `Complete` is emitted only after the final chunk commits, so
    // a consumer can treat it as the "whole import is durable" signal.
    // Mirrors the returned `ImportResult` counts.
    if let Some(sink) = progress {
        sink.emit(ImportProgressUpdate::Complete {
            page_title: page_title.clone(),
            blocks_created,
            properties_set,
        });
    }

    // #1932 (OBS-LOG-02) — log every collected diagnostic at WARN. Until now
    // warnings lived only in the returned struct (frontend toast), so once the
    // import dialog was dismissed there was no record that, e.g., blocks were
    // flattened or a property/block-ref was dropped. Logging them makes every
    // silently-skipped item recoverable from `agaric.log`.
    if !warnings.is_empty() {
        tracing::warn!(
            page = %page_title,
            count = warnings.len(),
            warnings = ?warnings,
            "import produced parse/apply diagnostics"
        );
    }

    // #1932 / #1934 — completion summary line with the final counts and the
    // measured elapsed time, so a completed import is no longer invisible in
    // logs and its duration/size are observable in the field.
    let elapsed_ms = started_at.elapsed().as_millis();
    tracing::info!(
        page = %page_title,
        blocks_created,
        properties_set,
        warnings = warnings.len(),
        chunks_committed = chunks_committed + 1,
        elapsed_ms,
        "import: completed markdown import"
    );

    ImportResult {
        page_title,
        blocks_created,
        properties_set,
        warnings,
    }
}

/// Tauri command: export a page as Markdown. Delegates to [`export_page_markdown_inner`].
#[tauri::command]
#[specta::specta]
pub async fn export_page_markdown(
    read_pool: State<'_, ReadPool>,
    page_id: PageId,
) -> Result<String, AppError> {
    export_page_markdown_inner(&read_pool.0, page_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: render a page as its source-mode markdown buffer. Delegates to [`get_page_source_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_page_source(
    read_pool: State<'_, ReadPool>,
    page_id: PageId,
) -> Result<String, AppError> {
    get_page_source_inner(&read_pool.0, page_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: render blocks as clipboard markdown. Delegates to
/// [`get_blocks_source_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_blocks_source(
    read_pool: State<'_, ReadPool>,
    block_ids: Vec<BlockId>,
    with_children: bool,
) -> Result<String, AppError> {
    get_blocks_source_inner(&read_pool.0, block_ids, with_children)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: duplicate a block and its content subtree right after the
/// original. Delegates to [`duplicate_block_inner`].
#[tauri::command]
#[specta::specta]
pub async fn duplicate_block(
    ctx: State<'_, WriteCtx>,
    block_id: BlockId,
) -> Result<WithOps<CreatedBlocks>, AppError> {
    capture_op_refs(async {
        duplicate_block_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), block_id)
            .await
            .map(|blocks| CreatedBlocks { blocks })
    })
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: paste clipboard text or structured blocks right after the
/// anchor block, or into its text with a `splice`. Delegates to
/// [`paste_blocks_inner`].
#[tauri::command]
#[specta::specta]
pub async fn paste_blocks(
    ctx: State<'_, WriteCtx>,
    anchor_block_id: BlockId,
    input: PasteInput,
    splice: Option<PasteSplice>,
) -> Result<WithOps<PastedBlocks>, AppError> {
    capture_op_refs(paste_blocks_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        anchor_block_id,
        input,
        splice,
    ))
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: import a Logseq-style markdown file as a page with
/// block hierarchy. Delegates to [`import_markdown_with_progress`].
///
/// `space_id` is required. The imported page is
/// stamped with `space = ?space_id` inside the same transaction as the
/// `CreateBlock` op, so an imported page can never exist in the op log
/// Without its space property (invariant). Validation against a
/// live space block happens TOCTOU-safe inside the same transaction.
///
/// #128 — `progress` streams per-block import
/// progress to the frontend. The frontend always supplies a
/// `Channel<ImportProgressUpdate>` (mirroring `start_sync`); sends are
/// best-effort, so a dropped channel never aborts the import.
#[tauri::command]
#[specta::specta]
pub async fn import_markdown(
    app: tauri::AppHandle,
    content: String,
    filename: Option<String>,
    space_id: SpaceId,
    // #1925 — referenced vault files' bytes. `None`/omitted ⇒ no attachment
    // ingest (the pre-#1925 behaviour). PR 2 wires the frontend picker to
    // pre-scan + supply only the referenced siblings.
    vault_files: Option<Vec<VaultFile>>,
    progress: tauri::ipc::Channel<ImportProgressUpdate>,
    ctx: State<'_, WriteCtx>,
) -> Result<ImportResult, AppError> {
    // b2 (#2248): required-target-space commands take the `SpaceId` newtype at
    // the wire boundary. The lenient `Deserialize` only uppercases, so reject a
    // malformed id here rather than letting a never-matching filter reach the
    // in-transaction space-existence check with an opaque error.
    space_id.validate_shape()?;
    // #3334 — the `app_paths` seam: imported vault files' bytes must land in
    // the same directory this process opened `notes.db` in.
    let app_data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    import_markdown_with_progress(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        &app_data_dir,
        content,
        filename,
        space_id.into_string(),
        vault_files,
        Some(&progress),
    )
    .await
    .map_err(sanitize_internal_error)
}

#[path = "markdown_properties.rs"]
mod property_lines;
use property_lines::PropertyLines;

#[path = "markdown_source_apply.rs"]
mod source_apply;
pub use source_apply::*;

#[cfg(test)]
#[path = "markdown_source_tests.rs"]
mod source_tests;

#[cfg(test)]
mod tests {
    use super::*;

    /// #2724 — the aggregate attachment-budget check rejects an over-cap file
    /// COUNT or aggregate BYTE total and accepts anything within budget,
    /// including the exact boundary. Exercised against fabricated numbers so
    /// the byte cap is verified WITHOUT allocating hundreds of MB.
    #[test]
    fn check_attachment_budget_enforces_caps_2724() {
        let byte_cap = crate::commands::MAX_TOTAL_ATTACHMENT_BYTES as u64;
        let count_cap = crate::commands::MAX_ATTACHMENT_FILE_COUNT;

        // Comfortably within both budgets.
        assert!(check_attachment_budget(3, 10 * 1024 * 1024).is_ok());
        // Empty payload is fine.
        assert!(check_attachment_budget(0, 0).is_ok());

        // Boundaries are inclusive (`> cap` rejects, `== cap` allows).
        assert!(check_attachment_budget(count_cap, 0).is_ok());
        assert!(check_attachment_budget(1, byte_cap).is_ok());

        // File count over the cap → Err.
        assert!(matches!(
            check_attachment_budget(count_cap + 1, 0),
            Err(AppError::Validation { .. })
        ));
        // Aggregate bytes over the cap → Err (fabricated total, no allocation).
        assert!(matches!(
            check_attachment_budget(1, byte_cap + 1),
            Err(AppError::Validation { .. })
        ));
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ReferenceTokenVectors {
        page_resolutions: HashMap<String, String>,
        tag_resolutions: HashMap<String, String>,
        humanize_cases: Vec<HumanizeTagCase>,
        code_fence_cases: Vec<CodeFenceCase>,
        cases: Vec<ReferenceTokenCase>,
        name_rule_cases: Vec<NameRuleCase>,
    }

    /// #5160 — what the name pass of import, paste and source mode does with
    /// one block of text. The page names are the titles it looks up or
    /// creates: the whole link text when a page of that title exists, else
    /// the text before its first `#`. A row that still differs from the
    /// decided grammar carries its finding id, and
    /// `reference-tokens-conformance.test.ts` pins how the editor reads
    /// `transformed` and that the mock's scanner asks for the same names.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct NameRuleCase {
        name: String,
        input: String,
        requested_page_names: Vec<String>,
        requested_tag_names: Vec<String>,
        transformed: String,
    }

    /// #3599 — a PARSER-DRIVEN vector. `cases` supplies `is_code` itself, so it
    /// cannot pin how the parser decides it. These vectors feed the raw text to
    /// `parse_logseq_markdown` and compare the SET of page and tag names the
    /// resolvers are asked to create. Rewrite output is not compared, because
    /// the parser rewrites block content (stripping bullets and indentation);
    /// the `cases` corpus and the unit tests pin that half.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CodeFenceCase {
        name: String,
        input: String,
        /// #3605 — the page-link resolver's side effects, on the same footing
        /// as the tag ones. `default` so a vector that omits it asserts ZERO
        /// page requests, which is the truth for every vector predating it.
        #[serde(default)]
        requested_page_names: Vec<String>,
        requested_tag_names: Vec<String>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct HumanizeTagCase {
        name: String,
        tag_ulid: String,
        tag_name: String,
        expected: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ReferenceTokenCase {
        name: String,
        input: String,
        /// #3599 — drive the vector through the CODE-BLOCK path: fenced code is
        /// protected at BLOCK granularity, as a block the parser flagged
        /// `is_code`.
        #[serde(default)]
        is_code: bool,
        expected: ReferenceTokenExpected,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ReferenceTokenExpected {
        page_captures: Vec<String>,
        multiword_tag_captures: Vec<String>,
        requested_page_names: Vec<String>,
        requested_tag_names: Vec<String>,
        transformed: String,
    }

    /// #1920/#3261 — the regexes, collectors, and rewriters import and paste
    /// share, pinned over one golden fixture. This pins the prefix-sensitive
    /// distinction between `[[page]]`, `#[[tag]]`,
    /// and `![[embed]]`, as well as canonical-ULID exclusion and final output.
    #[test]
    fn page_link_re_parity_boundaries_1920() {
        let vectors: ReferenceTokenVectors = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../conformance/reference-tokens.vectors.json"
        )))
        .expect("reference-token conformance fixture must be valid JSON");

        for vector in &vectors.humanize_cases {
            let tag_names = HashMap::from([(vector.tag_ulid.clone(), vector.tag_name.clone())]);
            let transformed = resolve_ulids_for_export(
                &format!("#[{}]", vector.tag_ulid),
                &tag_names,
                &HashMap::new(),
                &HashMap::new(),
            );
            assert_eq!(
                transformed, vector.expected,
                "humanized tag for {:?}",
                vector.name
            );
        }

        // #3599 — the code-fence mechanism vectors, driven through the REAL
        // importer parser so the fixture never has to be told what is code.
        for vector in &vectors.code_fence_cases {
            let parsed = import::parse_logseq_markdown(&vector.input);
            assert!(
                !parsed.blocks.is_empty(),
                "code-fence vector {:?} parsed to no blocks — the assertion below \
                 would be vacuous",
                vector.name
            );
            // #3605 — the page-link resolver is held to the same contract as
            // the tag one: a link inside a protected code range is never even
            // looked up, so no page is created for it.
            let requested_pages = requested_page_names(&parsed.blocks);
            assert_eq!(
                requested_pages.len(),
                vector.requested_page_names.len(),
                "code-fence requested page count for {:?}: {requested_pages:?}",
                vector.name
            );
            assert_eq!(
                requested_pages
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<String>>(),
                vector
                    .requested_page_names
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<String>>(),
                "code-fence requested page names for {:?}",
                vector.name
            );
            let requested = collect_inbound_tag_names(&parsed.blocks);
            assert_eq!(
                requested.len(),
                vector.requested_tag_names.len(),
                "code-fence requested tag count for {:?}: {requested:?}",
                vector.name
            );
            assert_eq!(
                requested
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<String>>(),
                vector
                    .requested_tag_names
                    .iter()
                    .cloned()
                    .collect::<std::collections::BTreeSet<String>>(),
                "code-fence requested tag names for {:?}",
                vector.name
            );
        }

        for vector in vectors.cases {
            // #3599 — `isCode` is a routing hint the fixture supplies, so pin it
            // to what the REAL parser says: an unchecked hint would let a vector
            // assert each side against its own expectations instead of a shared
            // truth. (A future vector whose text parses to MIXED flags trips
            // this and must move to `codeFenceCases`, which needs no hint.)
            let parsed = import::parse_logseq_markdown(&vector.input);
            assert!(
                !parsed.blocks.is_empty(),
                "vector {:?} parsed to no blocks",
                vector.name
            );
            assert!(
                parsed.blocks.iter().all(|b| b.is_code == vector.is_code),
                "fixture isCode={} disagrees with the importer for {:?}: {:?}",
                vector.is_code,
                vector.name,
                parsed
                    .blocks
                    .iter()
                    .map(|b| (b.content.clone(), b.is_code))
                    .collect::<Vec<_>>()
            );

            let page_captures: Vec<String> = HUMAN_PAGE_LINK_RE
                .captures_iter(&vector.input)
                .map(|c| c[1].to_string())
                .collect();
            assert_eq!(
                page_captures, vector.expected.page_captures,
                "page captures for {:?}",
                vector.name
            );

            let multiword_tag_captures: Vec<String> = HUMAN_MULTIWORD_TAG_RE
                .captures_iter(&vector.input)
                .map(|c| c[1].to_string())
                .collect();
            assert_eq!(
                multiword_tag_captures, vector.expected.multiword_tag_captures,
                "multi-word tag captures for {:?}",
                vector.name
            );

            let blocks = vec![import::ParsedBlock {
                content: vector.input.clone(),
                depth: 0,
                properties: Vec::new(),
                is_code: vector.is_code,
                block_anchor: None,
                task_markers: Vec::new(),
            }];
            // #3599 — the contract is the SET of distinct names each side asks
            // its resolver for, not an encounter order. Rust collects through a
            // sorted `BTreeSet` and the frontend resolves in first-occurrence
            // order; asserting the ordered vectors only ever passed because the
            // two coincided. Compare as sets, plus the count so a duplicate
            // request (an extra create-if-missing round trip) still fails.
            let as_set = |names: &[String]| -> std::collections::BTreeSet<String> {
                names.iter().cloned().collect()
            };
            let requested_pages = requested_page_names(&blocks);
            assert_eq!(
                requested_pages.len(),
                vector.expected.requested_page_names.len(),
                "requested page name count for {:?}: {requested_pages:?}",
                vector.name
            );
            assert_eq!(
                as_set(&requested_pages),
                as_set(&vector.expected.requested_page_names),
                "requested page names for {:?}",
                vector.name
            );
            let requested_tags = collect_inbound_tag_names(&blocks);
            assert_eq!(
                requested_tags.len(),
                vector.expected.requested_tag_names.len(),
                "requested tag name count for {:?}: {requested_tags:?}",
                vector.name
            );
            assert_eq!(
                as_set(&requested_tags),
                as_set(&vector.expected.requested_tag_names),
                "requested tag names for {:?}",
                vector.name
            );

            let with_pages = rewrite_inbound_page_links(
                &vector.input,
                &page_links_for(&vector.input, &vectors.page_resolutions),
                &invert(&vectors.page_resolutions),
            );
            // Mirror the production caller (`import_markdown`): the tag rewrite
            // is skipped outright for an `is_code` block.
            let transformed = if vector.is_code {
                with_pages
            } else {
                rewrite_inbound_tags(&with_pages, &vectors.tag_resolutions)
            };
            assert_eq!(
                transformed, vector.expected.transformed,
                "transformed reference tokens for {:?}",
                vector.name
            );
        }
    }

    /// #5160 — the name rules each text surface applies, with the names
    /// resolved from the fixture's maps as `resolve_link_names` keys them: by
    /// the whole name a body reads as, to the page the whole title names (D10)
    /// or else its base names.
    #[test]
    fn name_rule_vectors_pin_the_name_pass() {
        let vectors: ReferenceTokenVectors = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../conformance/reference-tokens.vectors.json"
        )))
        .expect("reference-token conformance fixture must be valid JSON");
        let as_set = |names: &[String]| -> std::collections::BTreeSet<String> {
            names.iter().cloned().collect()
        };
        for vector in &vectors.name_rule_cases {
            let parsed = import::parse_logseq_markdown(&vector.input);
            assert_eq!(parsed.blocks.len(), 1, "{:?}", vector.name);
            let block = &parsed.blocks[0];
            assert_eq!(
                block.content, vector.input,
                "the importer rewrote {:?}, so the row is not about names",
                vector.name
            );
            let blocks = std::slice::from_ref(block);

            let mut page_names = std::collections::BTreeSet::new();
            let mut page_links = page_links_for(&block.content, &vectors.page_resolutions);
            for (name, _) in page_links.readings.values() {
                let (base, anchor) = split_wikilink_anchor(name);
                let title = if anchor.is_some() && vectors.page_resolutions.contains_key(name) {
                    name
                } else {
                    base
                };
                if let Some(id) = vectors.page_resolutions.get(title) {
                    page_links.ids.insert(name.clone(), id.clone());
                }
                page_names.insert(title.to_string());
            }
            assert_eq!(
                page_names,
                as_set(&vector.requested_page_names),
                "requested pages for {:?}",
                vector.name
            );
            assert_eq!(
                as_set(&collect_inbound_tag_names(blocks)),
                as_set(&vector.requested_tag_names),
                "requested tags for {:?}",
                vector.name
            );
            assert_eq!(
                rewrite_block_content_for_import(
                    block,
                    &page_links,
                    &invert(&vectors.page_resolutions),
                    &vectors.tag_resolutions
                ),
                vector.transformed,
                "stored content for {:?}",
                vector.name
            );
        }
    }

    /// The fixture's `title → id` map as `id → title`, the shape the rewrite
    /// reads titles in.
    fn invert(names: &HashMap<String, String>) -> HashMap<String, String> {
        names.iter().map(|(k, v)| (v.clone(), k.clone())).collect()
    }

    /// The names the name pass asks for when no page holds a longer reading
    /// of a body: each body's split on its first `|` (#5160 D10).
    fn requested_page_names(blocks: &[import::ParsedBlock]) -> Vec<String> {
        let names: std::collections::BTreeSet<String> = collect_inbound_page_link_bodies(blocks)
            .iter()
            .filter_map(|body| link_body_readings(body).last().map(|(n, _)| n.to_string()))
            .filter(|name| !name.is_empty())
            .collect();
        names.into_iter().collect()
    }

    /// Page links in which each of `pages`' titles (`title → id`) reads as
    /// itself and links its page.
    fn links_to(pages: &HashMap<String, String>) -> PageLinks {
        PageLinks {
            readings: pages
                .keys()
                .map(|title| (title.clone(), (title.clone(), None)))
                .collect(),
            ids: pages.clone(),
        }
    }

    /// The fixture's pages, `title → id`, as the name pass's snapshot holds
    /// them.
    fn fixture_matches(pages: &HashMap<String, String>) -> LinkMatches {
        let mut matches = LinkMatches::default();
        for (title, id) in pages {
            LinkMatches::push(&mut matches.folded, title.to_ascii_lowercase(), id.clone());
            LinkMatches::push(&mut matches.exact, title.clone(), id.clone());
        }
        matches
    }

    /// What the name pass makes of the links in `content` when `pages`
    /// (`title → id`) are the space's pages: each body read against them, and
    /// each title's page.
    fn page_links_for(content: &str, pages: &HashMap<String, String>) -> PageLinks {
        let block = import::ParsedBlock {
            content: content.to_string(),
            depth: 0,
            properties: Vec::new(),
            is_code: false,
            block_anchor: None,
            task_markers: Vec::new(),
        };
        let matches = fixture_matches(pages);
        let mut links = PageLinks {
            ids: pages.clone(),
            ..PageLinks::default()
        };
        for body in collect_inbound_page_link_bodies(std::slice::from_ref(&block)) {
            if let Some((name, label)) = read_link_body(&body, &matches) {
                let reading = (name.to_string(), label.map(str::to_string));
                links.readings.insert(body, reading);
            }
        }
        links
    }

    /// #5160 D9, D10 — a link body reads whole, then as each prefix before a
    /// `|`, longest first, labelled with the rest; the last reading splits on
    /// the first `|`, and its name is what the anchor split then reads.
    #[test]
    fn a_link_body_reads_whole_then_before_each_pipe() {
        assert_eq!(link_body_readings(" Page "), [("Page", None)]);
        assert_eq!(
            link_body_readings(" A | B | c "),
            [
                ("A | B | c", None),
                ("A | B", Some("c")),
                ("A", Some("B | c"))
            ]
        );
        assert_eq!(
            link_body_readings("Page|"),
            [("Page|", None), ("Page", None)]
        );
        assert_eq!(
            split_wikilink_anchor(link_body_readings("A#B|see")[1].0),
            ("A", Some("B"))
        );
    }

    /// #5160 D10 — the first reading that names a page wins, a `|` after a
    /// `#` starts the label, a tie leaves the body as text, and with no page
    /// the body splits on its first `|`.
    #[test]
    fn a_link_body_reads_as_the_longest_name_a_page_has() {
        let pages = HashMap::from([
            (
                "A | B".to_string(),
                "01ARZ3NDEKTSV4RRFFQ69G5FAV".to_string(),
            ),
            (
                "X | Y".to_string(),
                "01ARZ3NDEKTSV4RRFFQ69G5FB0".to_string(),
            ),
            (
                "x | y".to_string(),
                "01ARZ3NDEKTSV4RRFFQ69G5FB1".to_string(),
            ),
        ]);
        let matches = fixture_matches(&pages);
        let read = |body| read_link_body(body, &matches);
        assert_eq!(read("A | B"), Some(("A | B", None)));
        assert_eq!(read("a | b|see"), Some(("a | b", Some("see"))));
        assert_eq!(read("A | B#Heading"), Some(("A | B#Heading", None)));
        assert_eq!(read("A | B#Heading|x"), Some(("A | B#Heading", Some("x"))));
        assert_eq!(read("A#x | B"), Some(("A#x", Some("B"))));
        assert_eq!(read("C | D"), Some(("C", Some("D"))));
        assert_eq!(read("X | y|see"), None);
        assert_eq!(read("X | Y|see"), Some(("X | Y", Some("see"))));
    }

    /// #5160 D9 — the stored token keeps a label unless it is the target's
    /// title, and the writers put it back on the title.
    #[test]
    fn a_label_is_stored_unless_it_is_the_title_and_written_back() {
        const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        assert_eq!(
            stored_page_link(ULID, Some("plan"), Some("Plan")),
            format!("[[{ULID}|plan]]")
        );
        assert_eq!(
            stored_page_link(ULID, Some("Plan"), Some("Plan")),
            format!("[[{ULID}]]")
        );
        assert_eq!(stored_page_link(ULID, None, None), format!("[[{ULID}]]"));
        let pages = HashMap::from([("Plan".to_string(), ULID.to_string())]);
        let titles = invert(&pages);
        let content = "[[Plan|the plan]] [[Plan|Plan]] [the plan]([[Plan]]) `[x]([[Plan]])` [[Plan|see #x|y]]";
        assert_eq!(
            rewrite_inbound_page_links(content, &page_links_for(content, &pages), &titles),
            format!(
                "[[{ULID}|the plan]] [[{ULID}]] [[{ULID}|the plan]] `[x]([[Plan]])` [[{ULID}|see #x|y]]"
            )
        );
        let named = humanise_tag_and_page_refs(
            &format!("[[{ULID}|the plan]] [[{ULID}]] [[{ULID}|]]"),
            &HashMap::new(),
            &titles,
        );
        assert_eq!(named, "[[Plan|the plan]] [[Plan]] [[Plan]]");
        let unknown = format!("[[{ULID}|x]]");
        assert_eq!(
            humanise_tag_and_page_refs(&unknown, &HashMap::new(), &HashMap::new()),
            unknown
        );
    }

    /// #5160 N3 — an odd run of backslashes escapes the token, an even run is
    /// literal backslashes before a token.
    #[test]
    fn an_odd_backslash_run_escapes_the_token() {
        assert!(is_escaped(r"\#tag", 1));
        assert!(!is_escaped(r"\\#tag", 2));
        assert!(is_escaped(r"a \\\[[P]]", 5));
        assert!(!is_escaped("#tag", 0));
    }

    /// #5160 N1/N8 — a tag name needs a non-digit, and a name is written bare
    /// only when the bare form reads back whole.
    #[test]
    fn a_tag_name_needs_a_non_digit_and_reads_back_bare_only_when_whole() {
        assert!(!is_tag_name("42"));
        assert!(is_tag_name("v1"));
        assert!(is_tag_name("2024-plan"));
        assert!(tag_reads_back_bare("", "v1", ""));
        assert!(tag_reads_back_bare("see ", "cafe\u{301}/sub", " now"));
        for name in ["42", "C++", "v1.2", "Q&A", "deep work", "a\u{85}b"] {
            assert!(!tag_reads_back_bare("", name, ""), "{name:?}");
        }
    }

    /// #5160 N8 — a tag written where a bare `#name` would not read back as
    /// that tag (after a `[` or a word char, or before a name char) is
    /// bracketed; what was written just before it is what the reader sees.
    #[test]
    fn a_tag_next_to_a_non_boundary_is_bracketed() {
        const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let tags = HashMap::from([(ULID.to_string(), "work".to_string())]);
        let content = format!("[#[{ULID}]] #[{ULID}] #[{ULID}]#[{ULID}] #[{ULID}]s x#[{ULID}]");
        let named = humanise_tag_and_page_refs(&content, &tags, &HashMap::new());
        assert_eq!(
            named,
            "[#[[work]]] #work #work#[[work]] #[[work]]s x#[[work]]"
        );
        assert_eq!(
            rewrite_inbound_tags(
                &named,
                &HashMap::from([("work".to_string(), ULID.to_string())])
            ),
            content,
            "every written tag reads back as the one it named"
        );
    }

    /// #5160 N1 — a `#` inside a bare URL or a link destination is a fragment.
    #[test]
    fn a_hash_inside_a_url_or_link_destination_is_guarded() {
        let content = "see https://docs.rs/x/#install and [d](https://x.dev/#s) `#c` #real";
        let guards = tag_guard_spans(content);
        for probe in ["#install", "#s", "#c"] {
            let pos = content.find(probe).unwrap();
            assert!(is_in_span(pos, &guards), "{probe} is guarded");
        }
        assert!(!is_in_span(content.find("#real").unwrap(), &guards));
    }

    /// #5160 D10 — the whole token of an anchored link is looked up as well as
    /// its base; an anchor-only link looks up nothing.
    #[test]
    fn link_lookup_names_add_the_whole_anchored_token() {
        let names = ["C# Notes".to_string(), "Page".into(), "#heading".into()];
        assert_eq!(link_lookup_names(&names), ["C", "C# Notes", "Page"]);
    }

    /// #5160 N10 — a relative `.md` destination, percent-decoded and resolved
    /// against the linking file's folder, names the page that file imports as.
    #[test]
    fn a_relative_md_link_names_the_page_its_file_imports_as() {
        assert_eq!(percent_decode("Other%20note.md"), "Other note.md");
        assert_eq!(percent_decode("caf%C3%A9 %zz%2"), "café %zz%2");
        assert_eq!(
            relative_md_link_title("Other%20note.md", "vault").as_deref(),
            Some("vault/Other note")
        );
        assert_eq!(
            relative_md_link_title("sub/Other note.MD", "").as_deref(),
            Some("sub/Other note")
        );
        assert_eq!(
            relative_md_link_title("../Top.md", "vault/notes").as_deref(),
            Some("vault/Top")
        );
        assert_eq!(
            relative_md_link_title("../../Top.md", "vault/a/b").as_deref(),
            Some("vault/Top")
        );
        assert_eq!(
            relative_md_link_title("../../Out.md", "vault/a"),
            None,
            "the vault's root is its first folder"
        );
        for dest in [
            "../Out.md",
            "../../Out.md",
            "https://x.dev/a.md",
            "/abs.md",
            "img.png",
            "a.md/",
        ] {
            assert_eq!(relative_md_link_title(dest, "vault"), None, "{dest}");
        }
        assert_eq!(
            rewrite_relative_md_links(
                "[t](Other.md) ![i](pic.md) `[c](Code.md)` [w](https://x/a.md) [](A.md) [v/A](A.md)",
                "v"
            ),
            "[[v/Other|t]] ![i](pic.md) `[c](Code.md)` [w](https://x/a.md) [[v/A]] [[v/A]]",
            "the link text is the label unless empty or the title (#5160 D9)"
        );
    }

    /// #1282 (Obsidian slice) — `split_wikilink_anchor` splits a wiki-link
    /// target on its FIRST `#` into `(base, Some(anchor))`, trims the base,
    /// yields `(name, None)` when there is no `#`, and reports an EMPTY base for
    /// an anchor-only link (`[[#heading]]`) so the caller leaves it literal.
    #[test]
    fn split_wikilink_anchor_splits_on_first_hash_1282() {
        // Base only (no `#`) — plain `[[Page]]`, unchanged pre-#1282 behaviour.
        assert_eq!(split_wikilink_anchor("Page"), ("Page", None));
        assert_eq!(
            split_wikilink_anchor("Project/Backend/API"),
            ("Project/Backend/API", None)
        );
        // Base + heading anchor.
        assert_eq!(
            split_wikilink_anchor("Target#Some Heading"),
            ("Target", Some("Some Heading"))
        );
        // Base + `^block` id anchor (the `^` stays part of the anchor).
        assert_eq!(
            split_wikilink_anchor("Target#^block123"),
            ("Target", Some("^block123"))
        );
        // Empty base — anchor-only intra-note link: "no page target".
        assert_eq!(split_wikilink_anchor("#heading"), ("", Some("heading")));
        // Multiple `#` — split on the FIRST; the rest is the anchor verbatim.
        assert_eq!(split_wikilink_anchor("Page#a#b"), ("Page", Some("a#b")));
        // Base whitespace is trimmed (matching the existing page-name handling).
        assert_eq!(split_wikilink_anchor(" Page #h1"), ("Page", Some("h1")));
    }

    /// #2510 — `obsidian_block_anchor_id` recognizes a `^`-prefixed sub-anchor
    /// as an Obsidian BLOCK anchor and returns the id (without the `^`);
    /// returns `None` for a heading anchor (no `^`) or a bare `^` with
    /// nothing after it (not a valid block id).
    #[test]
    fn obsidian_block_anchor_id_recognizes_caret_prefix_2510() {
        assert_eq!(obsidian_block_anchor_id("^block123"), Some("block123"));
        assert_eq!(
            obsidian_block_anchor_id("^my-block-id"),
            Some("my-block-id")
        );
        // Heading anchor — no leading `^`.
        assert_eq!(obsidian_block_anchor_id("Some Heading"), None);
        // A bare `^` with nothing after it is not a valid block id.
        assert_eq!(obsidian_block_anchor_id("^"), None);
    }

    /// #2567 — `obsidian_heading_text` recognizes a block whose first line is an
    /// ATX heading (1–6 `#` + whitespace + text) and returns the trimmed label;
    /// a `#tag` (no space), an over-deep `#######`, an empty heading, and plain
    /// text all return `None`. Only the first line is inspected.
    #[test]
    fn obsidian_heading_text_recognizes_atx_headings_2567() {
        assert_eq!(obsidian_heading_text("# Heading"), Some("Heading"));
        assert_eq!(obsidian_heading_text("###### Deep"), Some("Deep"));
        assert_eq!(obsidian_heading_text("##   Padded  "), Some("Padded"));
        // Multi-line heading block: only the first line is the heading.
        assert_eq!(
            obsidian_heading_text("## My Heading\nbody line"),
            Some("My Heading")
        );
        // `#tag` — no space after the `#` run — is NOT a heading.
        assert_eq!(obsidian_heading_text("#tag"), None);
        // Seven `#` exceeds ATX's max depth of 6.
        assert_eq!(obsidian_heading_text("####### Nope"), None);
        // A `#` run with no following text is not a heading.
        assert_eq!(obsidian_heading_text("## "), None);
        // Plain content is not a heading.
        assert_eq!(obsidian_heading_text("just text"), None);
    }

    /// #2567 — `normalize_heading_anchor` trims, collapses internal whitespace,
    /// and lowercases so a heading block's label and a wiki-link's `#…`
    /// sub-anchor compare equal despite incidental case/whitespace differences.
    #[test]
    fn normalize_heading_anchor_collapses_case_and_whitespace_2567() {
        assert_eq!(normalize_heading_anchor("  My  Heading "), "my heading");
        assert_eq!(
            normalize_heading_anchor("My Heading"),
            normalize_heading_anchor("my   heading")
        );
        assert_eq!(normalize_heading_anchor("A\tB"), "a b");
    }

    /// #2567 — the inline-tag pass must NOT treat a `[[#Heading]]` wikilink
    /// heading anchor as a tag: no tag name is collected and the token is left
    /// verbatim by the rewrite, so the heading-anchor resolution pass can match
    /// it. A genuine `#tag` elsewhere in the same block is still collected.
    #[test]
    fn tag_pass_skips_wikilink_heading_anchor_2567() {
        let blocks = vec![import::ParsedBlock {
            content: "See [[#My Heading]] and a #realtag".to_string(),
            depth: 0,
            properties: Vec::new(),
            is_code: false,
            block_anchor: None,
            task_markers: Vec::new(),
        }];
        // Only the genuine `#realtag` is collected; the `#My` inside `[[…]]` is
        // NOT (it is a heading anchor, not a tag).
        let names = collect_inbound_tag_names(&blocks);
        assert_eq!(names, vec!["realtag".to_string()], "got {names:?}");

        // Rewrite: the `[[#My Heading]]` token survives untouched; the real tag
        // is rewritten to its `#[ULID]` ref.
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "realtag".to_string(),
            "01TAG00000000000000000TAG0".to_string(),
        );
        let out = rewrite_inbound_tags(&blocks[0].content, &resolved);
        assert_eq!(
            out, "See [[#My Heading]] and a #[01TAG00000000000000000TAG0]",
            "the `[[#Heading]]` anchor must be left intact for heading resolution; got {out:?}"
        );
    }

    /// #3598 — a bare `#tag` inside an UNRESOLVED human wiki link is part of the
    /// page NAME, not a tag. It must be skipped by BOTH the collector (no
    /// spurious tag is created) and the rewriter (the token stays
    /// byte-identical, instead of being corrupted into `[[Project #[ULID]]]`).
    /// Falsifies the collector and the rewriter independently: `alpha` is in the
    /// resolved map, so a leak shows up in the output as well as in the names.
    #[test]
    fn tag_pass_skips_bare_tag_inside_unresolved_wiki_link_3598() {
        let blocks = vec![import::ParsedBlock {
            content: "[[Project #alpha]] #real".to_string(),
            depth: 0,
            properties: Vec::new(),
            is_code: false,
            block_anchor: None,
            task_markers: Vec::new(),
        }];
        let names = collect_inbound_tag_names(&blocks);
        assert_eq!(
            names,
            vec!["real".to_string()],
            "only the tag OUTSIDE the wiki link may be collected; got {names:?}"
        );

        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "alpha".to_string(),
            "01TAG0000000000000000ALFA0".to_string(),
        );
        resolved.insert("real".to_string(), "01TAG00000000000000000TAG0".to_string());
        let out = rewrite_inbound_tags(&blocks[0].content, &resolved);
        assert_eq!(
            out, "[[Project #alpha]] #[01TAG00000000000000000TAG0]",
            "the unresolved wiki link must stay byte-identical; got {out:?}"
        );
    }

    /// #3598 — the wiki-link span guard in `rewrite_inbound_tags` pass 2 must be
    /// computed against the POST-multi-word-rewrite string. `#[[Tag With Space]]`
    /// (19 bytes) collapses to `#[ULID]` (29 bytes), sliding the following
    /// `[[Project #alpha]]` ten bytes to the right; spans computed over the
    /// original content would no longer cover `#alpha`, and the rewrite would
    /// corrupt the link exactly as it did before the fix.
    #[test]
    fn tag_rewrite_recomputes_wiki_link_spans_after_multiword_pass_3598() {
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "Tag With Space".to_string(),
            "01TAG0000000000000000MW000".to_string(),
        );
        resolved.insert(
            "alpha".to_string(),
            "01TAG0000000000000000ALFA0".to_string(),
        );
        resolved.insert("real".to_string(), "01TAG00000000000000000TAG0".to_string());
        let out = rewrite_inbound_tags("#[[Tag With Space]] [[Project #alpha]] #real", &resolved);
        assert_eq!(
            out, "#[01TAG0000000000000000MW000] [[Project #alpha]] #[01TAG00000000000000000TAG0]",
            "stale spans from before the multi-word rewrite must not expose `#alpha`; got {out:?}"
        );
    }

    /// #3599 — a bare `#tag` inside a MULTI-WORD tag name (`#[[Alpha #b]]`) is
    /// part of that name: the collector must not create a stray tag `b` for it,
    /// even when the rendered output would not show one. Both
    /// the resolved and the unresolved multi-word name are pinned, because only
    /// the unresolved one also exercises the rewriter.
    #[test]
    fn tag_pass_does_not_leak_bare_tag_inside_multiword_tag_name_3599() {
        let blocks = vec![
            import::ParsedBlock {
                content: "#[[Alpha #b]]".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: false,
                block_anchor: None,
                task_markers: Vec::new(),
            },
            import::ParsedBlock {
                content: "#[[Unknown #b]] #real".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: false,
                block_anchor: None,
                task_markers: Vec::new(),
            },
        ];
        let names = collect_inbound_tag_names(&blocks);
        assert_eq!(
            names,
            vec![
                "Alpha #b".to_string(),
                "Unknown #b".to_string(),
                "real".to_string()
            ],
            "the inner `#b` is part of the multi-word tag NAME, never its own tag; got {names:?}"
        );

        // Unresolved multi-word name: pass 1 leaves the token, so pass 2 sees the
        // inner `#b` and must still leave it alone even though `b` resolves.
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert("b".to_string(), "01TAG00000000000000000BEE0".to_string());
        resolved.insert("real".to_string(), "01TAG00000000000000000TAG0".to_string());
        let out = rewrite_inbound_tags(&blocks[1].content, &resolved);
        assert_eq!(
            out, "#[[Unknown #b]] #[01TAG00000000000000000TAG0]",
            "the unresolved multi-word tag token must stay byte-identical; got {out:?}"
        );
    }

    /// #1950 — the page-link collect/rewrite guard skips a `[[...]]` that is
    /// immediately preceded by `#` (the `#[[Tag]]` multi-word tag form), so it
    /// is neither collected as a page name nor rewritten as a page ref. A plain
    /// `[[...]]` (no `#`) is still collected/rewritten as a page.
    #[test]
    fn page_link_guard_skips_hash_prefixed_brackets_1950() {
        let blocks = vec![import::ParsedBlock {
            content: "a #[[Tag With Space]] and [[Real Page]]".to_string(),
            depth: 0,
            properties: Vec::new(),
            is_code: false,
            block_anchor: None,
            task_markers: Vec::new(),
        }];
        // Only the un-prefixed `[[Real Page]]` is collected as a page name.
        let names = collect_inbound_page_link_bodies(&blocks);
        assert_eq!(names, vec!["Real Page".to_string()], "got {names:?}");

        // Rewrite: the `#[[Tag With Space]]` token survives untouched; the page
        // link is rewritten to its ULID.
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "Real Page".to_string(),
            "01PAGE0000000000000000PAGE".to_string(),
        );
        let out =
            rewrite_inbound_page_links(&blocks[0].content, &links_to(&resolved), &HashMap::new());
        assert_eq!(
            out, "a #[[Tag With Space]] and [[01PAGE0000000000000000PAGE]]",
            "the `#[[...]]` must be left for the tag pass; got {out:?}"
        );
    }

    /// #1924 — `collect_inbound_tag_names` gathers both bare and multi-word
    /// tags, skips `is_code` blocks entirely, skips inline-code spans, ignores
    /// `# heading`, and never collects a canonical `#[ULID]` ref.
    #[test]
    fn collect_inbound_tag_names_covers_forms_and_skips_1924() {
        let ulid = "01TAG00000000000000000TAG0";
        let blocks = vec![
            import::ParsedBlock {
                content: format!(
                    "see #projectx and #[[my tag]] not # heading nor `#incode` nor #[{ulid}]"
                ),
                depth: 0,
                properties: Vec::new(),
                is_code: false,
                block_anchor: None,
                task_markers: Vec::new(),
            },
            import::ParsedBlock {
                content: "fenced #shouldskip".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: true,
                block_anchor: None,
                task_markers: Vec::new(),
            },
        ];
        let names = collect_inbound_tag_names(&blocks);
        assert_eq!(
            names,
            vec!["my tag".to_string(), "projectx".to_string()],
            "bare + multi-word collected; heading/inline-code/canonical/code-block skipped; \
             got {names:?}"
        );
    }

    /// #1924 — `rewrite_inbound_tags` rewrites resolved tokens to `#[ULID]`,
    /// leaves unresolved tokens literal, and never touches a `#[ULID]` already
    /// present.
    #[test]
    fn rewrite_inbound_tags_rewrites_and_degrades_1924() {
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "known".to_string(),
            "01KNOWN000000000000000TAG0".to_string(),
        );
        resolved.insert(
            "my tag".to_string(),
            "01MULTI000000000000000TAG0".to_string(),
        );
        let out = rewrite_inbound_tags("a #known b #[[my tag]] c #unknown d", &resolved);
        assert_eq!(
            out, "a #[01KNOWN000000000000000TAG0] b #[01MULTI000000000000000TAG0] c #unknown d",
            "resolved tokens rewrite; unknown stays literal; got {out:?}"
        );
    }

    /// #1921 — a block with no `[[` is returned UNCHANGED by
    /// `rewrite_inbound_page_links` (the fast path), with no allocation-visible
    /// difference in the result.
    #[test]
    fn rewrite_inbound_page_links_fast_path_returns_unchanged_1921() {
        let resolved: HashMap<String, String> = HashMap::new();
        let content = "a plain block with no wiki link, just #tag-ish text";
        assert_eq!(
            rewrite_inbound_page_links(content, &links_to(&resolved), &HashMap::new()),
            content,
            "a link-free block must be returned unchanged"
        );
        // And a block WITH a link still rewrites via the resolved map.
        let mut resolved2: HashMap<String, String> = HashMap::new();
        resolved2.insert("Target".to_string(), "01ABC".to_string());
        assert_eq!(
            rewrite_inbound_page_links(
                "see [[Target]] here",
                &links_to(&resolved2),
                &HashMap::new()
            ),
            "see [[01ABC]] here",
            "a resolved name must be rewritten to its ULID ref"
        );
    }

    /// #3605 — a `[[Page]]` inside a protected code range is literal on the
    /// IMPORTER side too: never collected (so never created) and never
    /// rewritten. The fenced half is a `is_code` block, the inline half an
    /// `inline_code_spans` range — the same two mechanisms `#tag` has used
    /// since #3598/#3599.
    #[test]
    fn page_links_inside_code_are_literal_3605() {
        let blocks = vec![
            import::ParsedBlock {
                content: "```\nlink syntax: [[Fenced Page]]\n```".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: true,
                block_anchor: None,
                task_markers: Vec::new(),
            },
            import::ParsedBlock {
                content: "see `[[Quoted Page]]` vs [[Live Page]]".to_string(),
                depth: 0,
                properties: Vec::new(),
                is_code: false,
                block_anchor: None,
                task_markers: Vec::new(),
            },
        ];

        let names = collect_inbound_page_link_bodies(&blocks);
        assert_eq!(
            names,
            vec!["Live Page".to_string()],
            "only the link outside any code range may be resolved/created; got {names:?}"
        );

        // The rewrite half. `Quoted Page` and `Fenced Page` are BOTH in the
        // resolved map, so a byte-identical result proves the guard rather than
        // an unresolvable name falling back to its own token.
        let mut resolved: HashMap<String, String> = HashMap::new();
        resolved.insert(
            "Quoted Page".to_string(),
            "01QUOTED0000000000000PAGE0".to_string(),
        );
        resolved.insert(
            "Fenced Page".to_string(),
            "01FENCED0000000000000PAGE0".to_string(),
        );
        resolved.insert(
            "Live Page".to_string(),
            "01LIVE00000000000000PAGE00".to_string(),
        );

        let out =
            rewrite_inbound_page_links(&blocks[1].content, &links_to(&resolved), &HashMap::new());
        assert_eq!(
            out, "see `[[Quoted Page]]` vs [[01LIVE00000000000000PAGE00]]",
            "the inline-code link must stay byte-identical while its neighbour rewrites; \
             got {out:?}"
        );
    }

    /// #3605 — the `is_code` half of the guard lives at the CALL SITE (as it
    /// does for tags), so pin it through the real importer: a fenced block
    /// whose `#tag`s the importer already leaves literal must keep its
    /// `[[Page]]` text literal too.
    #[test]
    fn parsed_code_block_page_links_are_not_collected_3605() {
        let parsed =
            import::parse_logseq_markdown("- ```\n  see [[Fenced Page]] #fencedtag\n  ```");
        assert!(
            parsed.blocks.iter().any(|b| b.is_code),
            "the vector must actually produce a code block: {:?}",
            parsed.blocks
        );
        assert!(
            collect_inbound_page_link_bodies(&parsed.blocks).is_empty(),
            "a fenced block must ask for no page: {:?}",
            collect_inbound_page_link_bodies(&parsed.blocks)
        );
        assert!(
            collect_inbound_tag_names(&parsed.blocks).is_empty(),
            "…and no tag either, which was already true — the two must agree"
        );
    }
}
