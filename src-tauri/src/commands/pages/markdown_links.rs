//! The link and tag text helpers the export, paste and import paths share:
//! the human link and tag regexes (`HUMAN_PAGE_LINK_RE`, `HUMAN_TAG_RE`),
//! [`collect_inbound_page_link_bodies`], [`rewrite_inbound_page_links`],
//! [`collect_inbound_tag_names`], [`rewrite_inbound_tags`],
//! [`humanise_tag_and_page_refs`] and [`NameSnapshot`].

use super::*;

/// Matches a HUMAN-readable wiki-link token `[[Page Name]]` on import (#1446
/// Part B). The inner capture is the page NAME (any run of characters that is
/// neither `]` nor a newline, non-greedy so `[[A]] [[B]]` matches twice). A
/// token whose body is a canonical 26-char Crockford-base32 ULID is left
/// untouched (it is already an internal `[[ULID]]` ref) — the resolver checks
/// the captured body against [`agaric_store::cache::PAGE_LINK_RE`] before rewriting.
///
/// #1920 — this regex (`\[\[([^\]\n]+?)\]\]`) is the one source of the inbound
/// wiki-link grammar. Import and paste ([`paste_blocks_inner`], #1484) both
/// resolve through it: `[[Page]]` → ULID, create-if-missing, a title several
/// pages share links the lowest id (#6278). `page_link_re_parity_*` pins it
/// over the fixture `conformance/reference-tokens.vectors.json`.
pub(super) static HUMAN_PAGE_LINK_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\[\[([^\]\n]+?)\]\]").expect("invalid human page-link regex")
    });

/// Matches a HUMAN-readable bare/nested/hyphenated inline tag `#tag` on import
/// (#1924). Group 1 is the whitespace before the `#` (empty at the start of the
/// text); group 2 is the tag NAME — a run of `[\p{L}\p{N}_]` then
/// `[\p{L}\p{N}\p{M}_/-]*` (Unicode letters/digits/underscore plus combining
/// marks, with `/` and `-` allowed after the first char for nested +
/// hyphenated tags).
///
/// A tag starts the text or follows whitespace, as in Obsidian (#5160
/// follow-up 7a): `(#tag)`, `"#tag`, `a#b`, `it&#39;s`, `[#A]`,
/// `x.com/#install` and `\#tag` are text. `# heading` is not a tag either (a
/// space follows the `#`), and neither is a canonical `#[ULID]` ref (a `[`
/// does), so canonical refs survive untouched. The regex is only half the
/// rule; [`is_tag_name`] and [`tag_guard_spans`] are the other half, and every
/// reader applies all three.
///
/// #3367 — `\p{M}` belongs in the name's CONTINUATION class, because a
/// combining mark is part of the grapheme cluster its base char starts:
/// without it `#café` in NFD (`caf` + `e` + U+0301) minted a tag `cafe` and
/// stranded the acute, and `#हिन्दी` (Devanagari has no precomposed forms) was
/// truncated to `#ह`. It deliberately stays OUT of the FIRST-char class: a `#`
/// followed directly by a mark is itself one grapheme cluster (the mark
/// renders on the `#`), so a tag name must start on a base character. That
/// also keeps this regex aligned with `neutralize_ref_name` in
/// `inline_query_md.rs`, whose "is this `#` tag-initial?" test is likewise a
/// base-character test.
///
/// `pub(super)` so the sibling `inline_query_md` test that asserts a
/// neutralized ref name cannot re-parse as a tag consumes THIS definition
/// instead of a hand-copied literal — a copy is exactly what let the two drift
/// (#3367).
pub(in crate::commands::pages) static HUMAN_TAG_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(^|\p{White_Space})#([\p{L}\p{N}_][\p{L}\p{N}\p{M}_/-]*)")
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
pub(super) fn is_tag_name(name: &str) -> bool {
    name.chars().any(|c| !c.is_numeric())
}

/// The byte ranges of `content` no tag token may start in: inline-code spans
/// and the URLs and link destinations of [`TAG_GUARD_RE`].
pub(super) fn tag_guard_spans(content: &str) -> Vec<(usize, usize)> {
    let mut spans = import::inline_code_spans(content);
    spans.extend(
        TAG_GUARD_RE
            .find_iter(content)
            .map(|m| (m.start(), m.end())),
    );
    spans
}

/// Whether the `[[…]]` match starting at `start` is a page-link token: outside
/// inline code, not the `#[[tag]]` or `![[embed]]` form, and not escaped.
pub(super) fn page_link_is_token(
    content: &str,
    start: usize,
    code_spans: &[(usize, usize)],
) -> bool {
    !is_in_span(start, code_spans)
        && !content[..start].ends_with(['#', '!'])
        && !is_escaped(content, start)
}

/// Whether the bare `#name` whose name group is `name_m` is a tag token: its
/// `#` is outside every guarded span and every `[[…]]` token (#2567/#3598: a
/// `#` inside a wiki-link is its anchor or part of its name), and the name is
/// one. A backslash is no boundary, so an escaped `\#name` never matches.
fn bare_tag_is_token(
    name_m: regex::Match<'_>,
    guards: &[(usize, usize)],
    link_spans: &[(usize, usize)],
) -> bool {
    let hash_pos = name_m.start() - 1;
    !is_in_span(hash_pos, guards)
        && !is_in_span(hash_pos, link_spans)
        && is_tag_name(name_m.as_str())
}

/// Matches a HUMAN-readable multi-word inline tag `#[[Tag With Space]]` on
/// import (#1950). A `#` immediately followed by a `[[...]]` body. Group 1 is
/// the inner tag name (any run that is neither `]` nor a newline, non-greedy).
/// Distinct from a bare `[[Page]]` wiki-link by the leading `#` — the wiki-link
/// pre-pass skips any `[[...]]` immediately preceded by `#` (see
/// `collect_inbound_page_link_bodies` / `rewrite_inbound_page_links`) so a
/// `#[[...]]` becomes a TAG here, never a page.
pub(super) static HUMAN_MULTIWORD_TAG_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| {
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
/// (`[[Page#^blockId]]`) INSIDE a page; the name pass resolves/creates the base
/// `page` exactly like a plain `[[page]]`, then links the block the anchor
/// names when it finds one (#2510, #2567, #5160 D10).
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
pub(super) fn split_wikilink_anchor(name: &str) -> (&str, Option<&str>) {
    match name.split_once('#') {
        Some((base, anchor)) => (base.trim(), Some(anchor)),
        None => (name.trim(), None),
    }
}

/// The ways a wiki-link body reads as a name and a label, in the order the
/// name pass tries them (#5160 D9, D10): the whole body with no label, then
/// each prefix ending before a `|`, longest first, labelled with the text after
/// that `|`. Names and labels are trimmed, and an empty label is none. The last
/// reading splits on the first `|`; its name is what [`split_wikilink_anchor`]
/// then reads, so `A#B|label` anchors `A#B`.
pub(super) fn link_body_readings(body: &str) -> Vec<(&str, Option<&str>)> {
    let mut readings = vec![(body.trim(), None)];
    for (at, _) in body.rmatch_indices('|') {
        let label = body[at + 1..].trim();
        readings.push((body[..at].trim(), Some(label).filter(|l| !l.is_empty())));
    }
    readings
}

/// How a wiki-link body reads (#5160 D10): the first of its
/// [`link_body_readings`] whose name names a page in `matches`, else the split
/// on its first `|`, which the name pass resolves or creates.
pub(super) fn read_link_body<'a>(
    body: &'a str,
    matches: &LinkMatches,
) -> (&'a str, Option<&'a str>) {
    let readings = link_body_readings(body);
    let (first_split, longer) = readings.split_last().expect("the whole body is a reading");
    *longer
        .iter()
        .find(|(name, _)| matches.find_name(name).is_some())
        .unwrap_or(first_split)
}

/// Write the stored link to `ulid`: labelled unless the label is empty or the
/// target's own title, which the link shows anyway and follows through renames
/// (#5160 D9).
pub(super) fn stored_page_link(ulid: &str, label: Option<&str>, title: Option<&str>) -> String {
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
pub(super) fn obsidian_block_anchor_id(anchor: &str) -> Option<&str> {
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
pub(super) fn obsidian_heading_text(content: &str) -> Option<&str> {
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
pub(super) fn normalize_heading_anchor(s: &str) -> String {
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
pub(super) struct PendingHeading {
    pub(super) norm: String,
    pub(super) empty_base: bool,
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
pub(super) fn collect_inbound_page_link_bodies(blocks: &[import::ParsedBlock]) -> Vec<String> {
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
/// (unresolvable / creation failure), is left as its original plain-text
/// token — nothing is dropped.
/// Canonical `[[ULID]]` tokens already in the content are left untouched.
/// Code blocks (`is_code`) are handled by the CALLER (skipped before this
/// runs); inline-code spans are skipped here (#3605) — the exact split
/// `rewrite_inbound_tags` uses.
///
/// A `[[Page|label]]` keeps its label as `[[ULID|label]]` unless the label is
/// the target's title in `titles` (#5160 D9). Logseq's `[label]([[Page]])` is
/// normalised to that token first, whether or not `Page` resolves, so one that
/// stays text stays as `[[Page|label]]`. A name with a block in `links` is a
/// `((ULID))` ref, which has no label (D10).
pub(super) fn rewrite_inbound_page_links(
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
            if let Some(block) = links.blocks.get(name) {
                return format!("(({block}))");
            }
            match links.ids.get(name) {
                Some(ulid) => {
                    let title = titles.get(ulid).map(String::as_str);
                    // A deferred anchor rides with the page: `[[ULID#anchor]]`.
                    let target = links
                        .deferred
                        .get(name)
                        .map_or_else(|| ulid.clone(), |anchor| format!("{ulid}#{anchor}"));
                    stored_page_link(&target, label.as_deref(), title)
                }
                None => whole.to_string(),
            }
        })
        .into_owned()
}

/// A link a folder import leaves for [`link_import_anchors_inner`]:
/// `[[ULID#anchor]]` or `[[ULID#anchor|label]]`, an anchor into the page
/// `ULID` that named none of its blocks when the link was imported. Group 1 is
/// the page, 2 the anchor and 3 the label.
pub(super) static DEFERRED_LINK_RE: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| {
        regex::Regex::new(r"\[\[([0-9A-Z]{26})#([^\]|\n]+)(?:\|([^\]\n]*))?\]\]")
            .expect("invalid deferred link regex")
    });

/// Whether `content` holds a reference [`link_import_anchors_inner`] links: a
/// [`DEFERRED_LINK_RE`] link or a Logseq `((uuid))`.
pub(super) fn holds_deferred_ref(content: &str) -> bool {
    DEFERRED_LINK_RE.is_match(content) || import::holds_logseq_ref(content)
}

/// `true` when byte offset `pos` falls inside any of the half-open `spans`.
pub(super) fn is_in_span(pos: usize, spans: &[(usize, usize)]) -> bool {
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
pub(super) fn collect_inbound_tag_names(blocks: &[import::ParsedBlock]) -> Vec<String> {
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
            if bare_tag_is_token(name_m, &guards, &link_spans) {
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
pub(super) fn rewrite_inbound_tags(content: &str, resolved: &HashMap<String, String>) -> String {
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
            if !bare_tag_is_token(name_m, &guards2, &link_spans2) {
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
/// back as a dangling ref). A block that is one embed is then written as
/// Obsidian's ([`as_obsidian_embed`]): `![[Page]]`, `![[Page#^ULID]]`.
pub(super) fn resolve_ulids_for_export(
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
    let named = agaric_store::cache::BLOCK_REF_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let ulid = &caps[1];
            block_refs
                .get(ulid)
                .cloned()
                .unwrap_or_else(|| "(unresolved block reference)".to_string())
        })
        .into_owned();
    if named == content {
        named
    } else {
        as_obsidian_embed(named)
    }
}

/// `named`, a block's text with its names written, as Obsidian's embed
/// `![[target]]` when it is one embed block `{{embed [[target]]}}` that the
/// embed reader ([`import::rewrite_obsidian_note_embeds`]) reads back as
/// `named` (#6277 F1); else `named`. An embed among other text, or one whose
/// target would read as a file, a label or other text, stays as it is.
pub(super) fn as_obsidian_embed(named: String) -> String {
    let Some(target) = named
        .strip_prefix("{{embed [[")
        .and_then(|rest| rest.strip_suffix("]]}}"))
    else {
        return named;
    };
    let embed = format!("![[{target}]]");
    if import::rewrite_obsidian_note_embeds(&embed, import::embed_names_note) == named {
        embed
    } else {
        named
    }
}

/// Replace `#[ULID]` with `#tagname` and `[[ULID]]` with `[[Page Title]]`; an
/// id missing from its map stays raw, and so does an escaped `\#[ULID]` or
/// `\[[ULID]]`, after which no name reads back as the ref (#5160 N3).
pub(super) fn humanise_tag_and_page_refs(
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
pub(super) fn tag_reads_back_bare(before: &str, name: &str, after: &str) -> bool {
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

/// `content` with its tag and page ids replaced by names and its block refs by
/// Obsidian block links ([`name_block_refs`]), when the importer would resolve
/// every name back to the id it replaced; `None` when there is no name to
/// write or one would not come back, and the block goes out raw.
///
/// The check runs the importer's own name collection and rewrite over the
/// named text, with `is_code` as the parser will read the block; only the
/// resolution comes from `names` instead of the database, and nothing is
/// created. A name can be the page's own and still not come back: `[[Foo|Bar]]`
/// reads as the page `Foo|Bar` when one exists (#5160 D10), and `#v1.2` as the
/// tag `v1`. A block that is one embed whose name reads back is written as
/// Obsidian's `![[Page]]`, `![[Page#^id]]` or `![[#^id]]` ([`as_obsidian_embed`]).
pub(super) fn humanise_refs_for_source(
    content: &str,
    is_code: bool,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
    names: &NameSnapshot,
    own_page: bool,
) -> Option<String> {
    let named = humanise_tag_and_page_refs(content, tag_names, page_titles);
    let named = name_block_refs(&named, &names.pages, own_page);
    if named == content {
        return None;
    }
    let block = import::ParsedBlock {
        content: named,
        depth: 0,
        properties: Vec::new(),
        is_code,
        block_anchor: None,
        line: None,
    };
    let blocks = std::slice::from_ref(&block);
    let page_links = names.page_links(collect_inbound_page_link_bodies(blocks));
    let tags = names.tags(collect_inbound_tag_names(blocks));
    let internalised = rewrite_block_content_for_import(&block, &page_links, page_titles, &tags);
    // A save reads a block's `![[target]]` back as its embed before its names
    // (`normalize_foreign_forms`), and a code block's as text.
    (internalised == content).then(|| {
        if is_code {
            block.content
        } else {
            as_obsidian_embed(block.content)
        }
    })
}

/// `content` with each `((ULID))` whose block `names` holds written as the
/// Obsidian block link a save reads back (#6277 F2): `[[#^ULID]]` for a block
/// of [`LinkMatches::own_page`] when `own_page`, the text being that page's,
/// else `[[Title#^ULID]]` naming its page. A ref whose block `names` does not
/// hold, as one to another space, a deleted block or a page, and an escaped
/// one stay raw; [`humanise_refs_for_source`] checks the rest read back.
fn name_block_refs(content: &str, names: &LinkMatches, own_page: bool) -> String {
    agaric_store::cache::BLOCK_REF_RE
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("group 0 always present");
            let id = &caps[1];
            let page = names
                .blocks
                .get(id)
                .filter(|_| !is_escaped(content, m.start()));
            match page {
                Some(page) if own_page && names.own_page.as_ref() == Some(page) => {
                    format!("[[#^{id}]]")
                }
                Some(page) => names
                    .titles
                    .get(page)
                    .map_or_else(|| m.as_str().to_owned(), |t| format!("[[{t}#^{id}]]")),
                None => m.as_str().to_owned(),
            }
        })
        .into_owned()
}

/// The in-space names the importer resolves against, as its snapshots read
/// them: the pages every reading of the link bodies the render writes may name
/// (`snapshot_page_link_matches`), and each normalised tag name with its
/// smallest-id tag (`snapshot_tags_by_norm`, #1990).
#[derive(Default)]
pub(super) struct NameSnapshot {
    pub(super) pages: LinkMatches,
    pub(super) tag_id_by_norm: HashMap<String, String>,
}

impl NameSnapshot {
    /// What the importer's page-link pass would make of each link body
    /// without creating a page: its reading ([`read_link_body`]) and the page
    /// the name read names, the lowest id holding it (#6278), or the block its
    /// `^id` anchor names there ([`LinkMatches::anchored_block`], #6277 F2).
    pub(super) fn page_links(&self, bodies: impl IntoIterator<Item = String>) -> PageLinks {
        let mut links = PageLinks::default();
        for body in bodies {
            let (name, label) = read_link_body(&body, &self.pages);
            if let Some(id) = self.pages.find(name) {
                links.ids.insert(name.to_string(), id.to_string());
            } else if let Some((page, block)) = self.pages.anchored_block(name) {
                links.ids.insert(name.to_string(), page.to_string());
                links.blocks.insert(name.to_string(), block.to_string());
            } else {
                continue;
            }
            let reading = (name.to_string(), label.map(str::to_string));
            links.readings.insert(body, reading);
        }
        links
    }

    /// What the importer's tag pass would map each name to without creating
    /// a tag: the winner for its normalised name.
    pub(super) fn tags(&self, names: Vec<String>) -> HashMap<String, String> {
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
