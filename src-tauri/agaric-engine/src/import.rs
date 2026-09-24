//! Logseq/Markdown import parser.
//!
//! Parses indented markdown into a flat list of blocks with parent/child
//! relationships determined by indentation level.

use agaric_core::ulid::BlockId;
use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::LazyLock;

/// Maximum block-tree depth permitted by the import parser.  Blocks
/// nested below this level are flattened to this depth and a warning is
/// emitted.  This is a deliberately conservative, import-specific limit
/// that leaves room for the page-root offset the apply path adds.
///
/// #1918 — this MUST be `MAX_BLOCK_DEPTH - 1`, NOT `MAX_BLOCK_DEPTH`. The
/// apply path nests every imported block UNDER the created page block: an
/// import-depth-`D` block lands at absolute tree depth `D + 1` (the page is
/// the depth-0 root). `create_block_in_tx` enforces `parent_depth + 1 <=
/// MAX_BLOCK_DEPTH` (the app's `domain::block_ops` create path, against the
/// shared `agaric_store::block_descendants::MAX_BLOCK_DEPTH`), so a block clamped to import-depth
/// `MAX_BLOCK_DEPTH` would land at absolute depth `MAX_BLOCK_DEPTH + 1` and
/// be REJECTED — defeating the clamp's whole purpose (making deep imports
/// safe) and previously `?`-aborting the entire chunk. Clamping one level
/// shallower keeps the clamped block (plus the page-root offset) at-or-below
/// the create-path bound. The value still sits far under the recursive-CTE
/// depth bound of `depth < 100` enforced throughout the materialiser
/// (Invariant #9; see AGENTS.md "Recursive CTEs over `blocks`").
#[allow(clippy::cast_possible_truncation)] // MAX_BLOCK_DEPTH is a small positive constant; the cast cannot truncate.
const MAX_IMPORT_DEPTH: usize = (agaric_store::block_descendants::MAX_BLOCK_DEPTH as usize) - 1;

/// A parsed block from the import.
#[derive(Debug, Clone)]
pub struct ParsedBlock {
    pub content: String,
    pub depth: usize,
    pub properties: Vec<(String, String)>,
    /// #1924 — `true` when the block's source line(s) fell inside a fenced
    /// ```` ``` ```` code region. Set MINIMALLY: the parser does not change
    /// how blocks are split, it only flags blocks born inside a fence so the
    /// inline-tag pre-pass (`collect_inbound_tag_names` / `rewrite_inbound_tags`
    /// in `commands::pages::markdown`) can SKIP them, keeping `#tag`-looking
    /// text inside a code fence literal. Full code-fence import handling
    /// (preserving the fence delimiters, language hints, and verbatim
    /// multi-line bodies) is deliberately OUT of scope here and tracked as
    /// separate work; this flag is the smallest hook the tag-safety acceptance
    /// test needs.
    pub is_code: bool,
    /// #2510 — the raw Obsidian block-anchor id (WITHOUT the leading `^`)
    /// when this block's assembled content ended in a trailing `^block-id`
    /// marker, stripped out of `content` by the post-parse pass
    /// `extract_block_anchors` (private, so not linked). `None` for the
    /// overwhelming majority of
    /// blocks (no trailing marker, or the marker sits on a code line).
    /// Consumed by `commands::pages::markdown` to resolve an
    /// Obsidian `[[Page#^block-id]]` / `[[#^block-id]]` wiki-link to the
    /// OWNING block (a real Agaric `((ULID))` block-ref) instead of only the
    /// page (#1282's fallback).
    pub block_anchor: Option<String>,
}

/// Outcome of importing one markdown file: the created page plus aggregate
/// counts and any non-fatal diagnostics, returned by
/// `agaric_lib::commands::pages::markdown::import_markdown_with_progress` and
/// surfaced to the import UI.
#[derive(Debug, Clone, Serialize, Type)]
pub struct ImportResult {
    /// Title of the page block the import created (derived from the filename
    /// or the file's leading heading).
    pub page_title: String,
    /// Number of content blocks made durable by the import.
    pub blocks_created: u64,
    /// Number of page-level properties stamped onto the created page (e.g.
    /// from YAML frontmatter).
    pub properties_set: u64,
    /// Non-fatal diagnostics collected while importing. Carries both soft
    /// parse warnings (e.g. depth clamping, stripped `((block-ref))` tokens,
    /// ambiguous wiki-links left as plain text) and per-item skip notices
    /// (e.g. a frontmatter ref property that could not resolve to a page).
    /// Empty on a fully clean import. Surfaced to the user and logged at
    /// `warn!` on completion so a lossy import is never silent.
    pub warnings: Vec<String>,
}

/// Output of [`parse_logseq_markdown`]: parsed blocks plus any warnings
/// generated during parsing (e.g. depth clamping).
#[derive(Debug, Clone)]
pub struct ParseOutput {
    pub blocks: Vec<ParsedBlock>,
    /// Page-level properties parsed from a leading YAML frontmatter block
    /// (#1432). These are the scalar `key: value` pairs Agaric's own
    /// markdown export emits between the leading `---` fences, ready to be
    /// stamped onto the imported page block as page properties (mirroring
    /// the export → import round-trip). Internal/reserved keys
    /// (see `FRONTMATTER_RESERVED_KEYS`) are filtered out here so they are
    /// never re-imported. Empty when the file has no frontmatter.
    pub frontmatter: Vec<(String, String)>,
    /// For frontmatter keys whose value arrived as a genuine multi-item YAML
    /// sequence — an inline flow sequence (`key: [a, "b, c"]`) or a
    /// block-style sequence (`key:` / `- item` lines) — the exact parsed
    /// items, in order, BEFORE they are comma-joined into the `frontmatter`
    /// scalar above (#2829). `frontmatter`'s joined form is lossy when an
    /// item itself contains a literal comma (`["Beta, Inc"]` and `["a",
    /// "b"]` both join to `"Beta, Inc, a, b"`-shaped strings that a naive
    /// re-split on every comma cannot tell apart); consumers that need exact
    /// item boundaries — e.g. the `aliases`/`tags` import interception —
    /// must read the key here instead of re-splitting the scalar. A key with
    /// no entry here either has no frontmatter value or arrived as a plain
    /// (non-sequence) scalar.
    pub frontmatter_list_items: std::collections::HashMap<String, Vec<String>>,
    pub warnings: Vec<String>,
}

/// Internal/system-managed property keys that the markdown exporter
/// deliberately strips from the YAML frontmatter
/// (`export_page_markdown_inner`, #384). The import path filters the same
/// keys so a round-tripped file can never re-import a space-membership,
/// template, or lifecycle marker as a user-visible page property.
///
/// Mostly mirrors the `NOT IN (...)` list in the exporter's frontmatter query,
/// with ONE deliberate divergence (#2722): the exporter also excludes
/// `aliases`/`tags` from its `block_properties` scan, but they are NOT filtered
/// here — they must reach the importer's frontmatter apply loop so it can
/// INTERCEPT them and write real `page_aliases` rows / `block_tags`
/// associations. Filtering them here (like the reserved keys) would silently
/// drop the semantic round-trip, so they are handled by interception, not
/// exclusion.
///
/// DRIFT WARNING (#3797) — this key set is duplicated in FOUR places and
/// nothing checks them against each other. Change one, change all four:
///   1. here — `FRONTMATTER_RESERVED_KEYS` (Rust);
///   2. `INLINE_PROPERTY_RESERVED_KEYS` in `src/lib/inline-property-parse.ts`
///      (TypeScript, the inline `key:: value` parser);
///   3. the page-property `key NOT IN (…)` in `export_page_markdown_inner`
///      (`src-tauri/src/commands/pages/markdown.rs`);
///   4. the descendant-property `key NOT IN (…)` in that same function.
///
/// Sites 3 and 4 are literal SQL, so grepping for either constant name will
/// NOT find them.
const FRONTMATTER_RESERVED_KEYS: &[&str] = &[
    "space",
    "is_space",
    "created_at",
    "completed_at",
    "repeat",
    "repeat-until",
    "repeat-count",
    "repeat-seq",
    "repeat-origin",
    "template",
];

/// The `block_properties` key under which a block's list style is stored
/// (#4552). Mirrors `LIST_STYLE_KEY` in `src/lib/list-style.ts`.
///
/// Deliberately NOT a member of `FRONTMATTER_RESERVED_KEYS`: the exporter
/// suppresses the `listStyle:: …` property LINE (because the emitted `- ` /
/// `N. ` marker already carries it), but a hand-written or pasted
/// `listStyle:: bullet` line must still import as an ordinary property. See
/// the asymmetry comment on the exporter's two `key NOT IN (…)` lists in
/// `agaric_lib::commands::pages::markdown::export_page_markdown_inner`.
pub const LIST_STYLE_KEY: &str = "listStyle";

/// The `listStyle` value a `- ` marker implies (mirrors `STORED_LIST_STYLES`
/// in `src/lib/list-style.ts`).
pub const LIST_STYLE_BULLET: &str = "bullet";

/// The `listStyle` value an `N. ` marker implies.
pub const LIST_STYLE_ORDERED: &str = "ordered";

/// #4552 slice 4 — split a leading markdown list marker off a block's text,
/// returning the [`LIST_STYLE_BULLET`] / [`LIST_STYLE_ORDERED`] value it
/// implies and the remaining text.
///
/// The grammar is exactly what the exporter emits: `-` / `- text` for a
/// bullet, and `<digits>.` / `<digits>. text` for an ordered item. The literal
/// ORDINAL is discarded — numbering is positional on export and re-derived
/// from sibling order, never stored (`docs/architecture/list-ergonomics.md`),
/// so `3.` and `1.` both import as plain `ordered`.
///
/// Returns `None` when `text` opens no marker.
fn split_list_marker(text: &str) -> Option<(&'static str, &str)> {
    if text == "-" {
        return Some((LIST_STYLE_BULLET, ""));
    }
    if let Some(rest) = text.strip_prefix("- ") {
        return Some((LIST_STYLE_BULLET, rest));
    }
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    // `digits` counts ASCII bytes from the start, so it is always a char
    // boundary.
    let after = &text[digits..];
    if after == "." {
        return Some((LIST_STYLE_ORDERED, ""));
    }
    if let Some(rest) = after.strip_prefix(". ") {
        return Some((LIST_STYLE_ORDERED, rest));
    }
    None
}

/// #4552 slice 4 — `true` when the exporter must backslash-escape `text` (a
/// block's FIRST line) so it does not re-import as a list marker.
///
/// A `listStyle: none` block whose content literally begins with `- ` or
/// `1. ` is indistinguishable, once written after the outline bullet, from a
/// styled block — `- - foo` would mean both "plain block whose text is `- foo`"
/// and "bullet block whose text is `foo`". The exporter therefore writes
/// `- \- foo`, and [`split_block_list_marker`] reverses it.
///
/// The predicate looks PAST a leading run of backslashes so the escape is
/// injective: `\- foo` (a literal backslash-dash the user typed) is itself
/// escaped, to `\\- foo`, and one backslash is removed on the way back in.
/// Without that, `- foo` and `\- foo` would both export as `- \- foo`.
pub fn needs_list_marker_escape(text: &str) -> bool {
    split_list_marker(text.trim_start_matches('\\')).is_some()
}

/// #4552 slice 4 — classify a block line's text (already stripped of the
/// outline `- ` bullet) into its [`LIST_STYLE_KEY`] value and its bare text.
///
/// Reverses [`needs_list_marker_escape`]'s escape first: a leading `\` whose
/// payload would otherwise read as a marker is an EXPORTER escape and is
/// removed, yielding a style-less block whose text keeps its literal marker.
/// Only then is a real marker consumed. An ordinary line beginning with `\`
/// (a LaTeX command, say) is left verbatim, exactly as the continuation-line
/// un-escape (#2716) does.
pub fn split_block_list_marker(text: &str) -> (Option<&'static str>, &str) {
    if let Some(rest) = text.strip_prefix('\\')
        && needs_list_marker_escape(rest)
    {
        return (None, rest);
    }
    match split_list_marker(text) {
        Some((style, rest)) => (Some(style), rest),
        None => (None, text),
    }
}

/// The `todo_state` each Source-mode checkbox stands for (#5140). The alphabet
/// is the frontend's (`TASK_MARKER_TO_STATE` in `src/lib/task-states.ts`); the
/// first character listed for a state is the one the renderer writes.
const TASK_MARKERS: [(char, &str); 5] = [
    (' ', "TODO"),
    ('x', "DONE"),
    ('X', "DONE"),
    ('/', "DOING"),
    ('-', "CANCELLED"),
];

/// The checkbox character Source mode writes for `todo_state`, or `None` for a
/// state outside the alphabet, which stays a `todo_state::` property line.
pub fn task_marker_for(todo_state: &str) -> Option<char> {
    TASK_MARKERS
        .iter()
        .find(|(_, state)| *state == todo_state)
        .map(|(marker, _)| *marker)
}

/// Split a leading `[c] ` checkbox, or a bare `[c]` that is the whole text, off
/// `text`, returning the `todo_state` it stands for and the rest.
fn split_task_marker(text: &str) -> Option<(&'static str, &str)> {
    let mut chars = text.strip_prefix('[')?.chars();
    let marker = chars.next()?;
    let after = chars.as_str().strip_prefix(']')?;
    let &(_, state) = TASK_MARKERS.iter().find(|(c, _)| *c == marker)?;
    if after.is_empty() {
        return Some((state, after));
    }
    after.strip_prefix(' ').map(|rest| (state, rest))
}

/// `true` when Source mode must backslash-escape `text`, the first line of a
/// block that writes no checkbox, so it does not read back as one. It looks
/// past a leading run of backslashes, as [`needs_list_marker_escape`] does, so
/// the escape is injective.
pub fn needs_task_marker_escape(text: &str) -> bool {
    split_task_marker(text.trim_start_matches('\\')).is_some()
}

/// Source mode's checkbox counterpart of [`split_block_list_marker`], applied
/// to the text after the list marker: the `todo_state` a checkbox stands for,
/// and the text with the checkbox, or one escape, removed.
fn split_block_task_marker(text: &str) -> (Option<&'static str>, &str) {
    if let Some(rest) = text.strip_prefix('\\')
        && needs_task_marker_escape(rest)
    {
        return (None, rest);
    }
    match split_task_marker(text) {
        Some((state, rest)) => (Some(state), rest),
        None => (None, text),
    }
}

/// A source buffer's anchor line: `^` and a ULID, alone on the line.
static ANCHOR_LINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\^[0-9A-HJKMNP-TV-Z]{26}$").expect("invalid anchor-line regex"));

/// `true` when Source mode must backslash-escape `line`, a code line, so it
/// does not read back as the anchor line that ends its block's fence. It looks
/// past leading whitespace and backslashes, as [`needs_list_marker_escape`]
/// does, so the escape is injective.
pub fn needs_anchor_line_escape(line: &str) -> bool {
    ANCHOR_LINE_RE.is_match(line.trim_start_matches(|c: char| c.is_whitespace() || c == '\\'))
}

/// A source code line with the escape [`needs_anchor_line_escape`] asks for,
/// if any, removed.
fn unescape_code_line(text: &str) -> &str {
    text.strip_prefix('\\')
        .filter(|rest| needs_anchor_line_escape(rest))
        .unwrap_or(text)
}

/// A bullet's text split into its markers and the block's own text: the
/// `listStyle` its list marker implies and, in Source mode, the `todo_state`
/// of the checkbox after it.
fn split_bullet_markers(
    text: &str,
    mode: ParseMode,
) -> (Option<&'static str>, Option<&'static str>, &str) {
    let (list_style, text) = split_block_list_marker(text);
    match mode {
        ParseMode::Import => (list_style, None, text),
        ParseMode::Source => {
            let (todo_state, text) = split_block_task_marker(text);
            (list_style, todo_state, text)
        }
    }
}

/// `true` when `line` is a code-fence delimiter: backticks opening the line
/// itself or the body of its `- ` bullet. The exporter tracks fences with this
/// same probe, applied to each line as written, so the two sides agree on
/// where code starts and ends.
///
/// Opening a fence, a bullet counts when the text it imports as starts with
/// the backticks, so a list-styled code block (`- - ```sh`, `- 1. ```sh`)
/// opens one too. Inside a fence the list marker is not looked past: a marker
/// only ever precedes a block's first line, so ```` - - ``` ```` there is code.
pub fn is_fence_delimiter(line: &str, fence_open: bool) -> bool {
    fence_delimiter(line, fence_open, ParseMode::Import)
}

/// [`is_fence_delimiter`] for a Source-mode buffer, where a bullet's first line
/// may carry a checkbox before its text: a task whose content is a code block
/// opens its fence on that line.
pub fn is_source_fence_delimiter(line: &str, fence_open: bool) -> bool {
    fence_delimiter(line, fence_open, ParseMode::Source)
}

fn fence_delimiter(line: &str, fence_open: bool, mode: ParseMode) -> bool {
    let trimmed = line.trim_start();
    let Some(body) = trimmed.strip_prefix("- ") else {
        return trimmed.starts_with("```");
    };
    if fence_open {
        body.starts_with("```")
    } else {
        split_bullet_markers(body, mode).2.starts_with("```")
    }
}

/// Streaming progress payload for a single `import_markdown` call (#128).
///
/// Carried over a Tauri `Channel<ImportProgressUpdate>` so a long import
/// can render a per-block progress bar instead of a bare spinner. The
/// enum is `Serialize` + `Type` only (no `Deserialize`) — like
/// `sync_events::SyncProgressUpdate`, it is a one-way
/// backend→frontend payload. Frontend consumers switch on `kind` and read
/// the variant-specific fields.
///
/// Emission contract (see `import_markdown_inner`): exactly one
/// [`Started`](ImportProgressUpdate::Started) before any block is written,
/// one [`Progress`](ImportProgressUpdate::Progress) per block created, and
/// exactly one [`Complete`](ImportProgressUpdate::Complete) — but ONLY
/// after the enclosing transaction commits. A failed import emits
/// `Started` + zero-or-more `Progress` and then NO `Complete` (the command
/// returns `Err`), so a consumer that never sees `Complete` must treat the
/// import as failed.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportProgressUpdate {
    /// Emitted once, before the first block is created. `blocks_total` is
    /// the parser's block count, so the UI can render a determinate bar
    /// from the very first event. May be 0 for an empty / headings-only
    /// file.
    Started {
        /// Title derived from the filename (or the fallback).
        page_title: String,
        /// Total blocks the parser produced for this file.
        blocks_total: u64,
    },
    /// Emitted after each block is created inside the transaction.
    /// `blocks_done` counts up to `blocks_total`.
    Progress { blocks_done: u64, blocks_total: u64 },
    /// Emitted once, AFTER the transaction commits successfully. Mirrors
    /// the returned [`ImportResult`] counts so a consumer can render the
    /// final state from the channel alone.
    Complete {
        page_title: String,
        blocks_created: u64,
        properties_set: u64,
    },
}

// NOTE: the `ImportProgressSink` trait and its `tauri::ipc::Channel<…>`
// production impl stay in the `agaric` app crate (`crate::import`, an app-side
// shim that re-exports this module). The trait is a Tauri-integration seam, not
// part of the query-free parser — no function here consumes it — and keeping
// its `impl … for tauri::ipc::Channel` app-side avoids giving `agaric-engine` a
// `tauri` dependency (orphan rule: the trait is app-local there). See
// `src-tauri/src/import.rs`.

/// A single referenced sibling file carried over IPC for an attachment-aware
/// import (#1925).
///
/// The frontend (PR 2) pre-scans the picked Logseq/Obsidian vault, collects ONLY
/// the files actually referenced by the markdown being imported (image embeds,
/// `assets/...` refs, etc.), reads each into a browser `ArrayBuffer`, and sends
/// the `{ path, bytes }` pairs alongside the markdown `content`. The backend
/// matches each in-content attachment ref against this list, ingests the matched
/// bytes as a fresh attachment owned by the referencing block (a repeated ref
/// within one block ingests once; cross-block/cross-page asset dedup is deferred
/// to #1993), and rewrites the ref to the canonical `attachment:<id>` form.
///
/// `path` is the file's path RELATIVE to the vault root (the browser
/// `webkitRelativePath` minus the top folder, or whatever the FE chooses), using
/// `/` separators — e.g. `assets/diagram.png` or `images/screenshots/a.png`.
/// It is matched against an in-content ref first by relative-path equality, then
/// by basename (see `match_vault_file`).
///
/// This is an IPC **input**, so it needs `Deserialize` (unlike the
/// backend→frontend [`ImportProgressUpdate`], which is `Serialize`-only).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VaultFile {
    /// Vault-root-relative path, `/`-separated (e.g. `assets/img.png`).
    pub path: String,
    /// Raw file bytes.
    pub bytes: Vec<u8>,
}

/// One attachment reference detected in a block's content (#1925).
///
/// Produced by [`detect_attachment_refs`]. The importer uses `original_ref` (the
/// exact URL/path token as it appears in the source, e.g. `assets/img.png` or
/// `![[diagram.png]]`'s inner `diagram.png`) to match against the supplied
/// [`VaultFile`] list, and `alt` to preserve the alt text when rewriting to
/// `![alt](attachment:<id>)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRef {
    /// The alt text to preserve in the rewritten `![alt](attachment:<id>)`.
    /// Empty for Obsidian embeds `![[file]]` (which carry no alt) and for
    /// markdown images with an empty `![]` label.
    pub alt: String,
    /// The raw reference path/URL exactly as it appears in the source content,
    /// used to match a [`VaultFile`] and to locate the token for rewriting.
    pub original_ref: String,
    /// The full matched token in the source (`![[diagram.png]]` or
    /// `![alt](assets/img.png)`), so the rewrite can replace it byte-for-byte.
    pub full_match: String,
}

/// Obsidian embed `![[file.png]]` — group 1 is the inner ref (path or basename,
/// any run of chars that is neither `]`, `|`, nor newline; the optional `|alt`
/// display-text suffix that Obsidian allows is dropped). Non-greedy.
static OBSIDIAN_EMBED_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"!\[\[([^\]\|\n]+?)(?:\|[^\]\n]*)?\]\]").expect("invalid obsidian-embed regex")
});

/// Standard markdown image `![alt](url)` — group 1 is the alt text (may be
/// empty), group 2 is the URL/path (any run that is neither `)` nor whitespace
/// nor newline). Mirrors the editor's `![alt](url)` serializer shape so a
/// rewritten ref round-trips. The `[^\)\s\n]` URL class excludes whitespace so a
/// title suffix `![a](url "t")` is not swept into the path (the title is left
/// untouched, treated as not-a-vault-file).
static MARKDOWN_IMAGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"!\[([^\]\n]*)\]\(([^\)\s\n]+)\)").expect("invalid markdown-image regex")
});

/// `true` when `reference` is one this import must NOT try to ingest as a vault
/// attachment (#1925): an absolute URL (`http://`, `https://`, `data:`), a
/// protocol-relative `//host` URL, or an already-canonical `attachment:<id>`
/// ref. Such refs are left verbatim in the content.
fn is_skippable_attachment_ref(reference: &str) -> bool {
    let r = reference.trim();
    r.starts_with("http://")
        || r.starts_with("https://")
        || r.starts_with("data:")
        || r.starts_with("//")
        || r.starts_with("attachment:")
}

/// Detect attachment references in one block's `content` (#1925).
///
/// Handles three inbound shapes, mirroring the tag/wiki-link detection style in
/// `commands::pages::markdown`:
///   * Obsidian embed — `![[file.png]]` (optional `|display` suffix dropped),
///   * standard markdown image — `![alt](relative/path.png)`,
///   * Logseq/relative asset paths captured by the markdown-image form above
///     (`![alt](assets/...)`).
///
/// SKIPS, leaving the token verbatim:
///   * absolute / protocol-relative URLs and `data:` URIs,
///   * already-canonical `attachment:<id>` refs,
///   * any ref inside an inline-code span (`` `...` ``); the CALLER skips whole
///     `is_code` fenced blocks before calling this (mirroring the #1924
///     inline-tag pre-pass), so this function need not re-check `is_code`.
///
/// Returns every Obsidian embed first (in source order), then every markdown
/// image (in source order) — **not** overall source order (#3675). The embed
/// scan runs to completion over the whole document before the image scan
/// starts and nothing sorts afterwards, so an image that appears *before* an
/// embed still comes back second.
///
/// That grouping is a scan artefact rather than a contract, and this docstring
/// used to promise plain source order instead. The promise was the wrong half:
/// nothing depends on the ordering. The sole production caller
/// (`commands::pages::markdown::insert_blocks`) forwards the refs to an
/// order-independent read-count tally (`ingest_read_counts`, which folds them
/// into a `HashMap`) and to a rewrite that replaces each ref's OWN
/// [`AttachmentRef::full_match`] token via `str::replacen`, so which row is
/// visited first cannot change the rewritten content. [`AttachmentRef`] also
/// carries no source offset, so a caller could not re-sort by position even if
/// it wanted to. Pinned by `tests_attachment_ref_order_3675` at the bottom of
/// this file — do not start relying on the order without first making it a real
/// contract (merge the two scans, or sort by match start).
///
/// The inline-code skip reuses the same single-backtick pairing the importer's
/// #1924 helpers use.
pub fn detect_attachment_refs(content: &str, code_spans: &[(usize, usize)]) -> Vec<AttachmentRef> {
    let in_code = |pos: usize| code_spans.iter().any(|&(s, e)| pos >= s && pos < e);
    let mut refs: Vec<AttachmentRef> = Vec::new();

    // Obsidian embeds first. Their `![[...]]` shape cannot also match the
    // markdown-image regex (which requires `(` after `]`), so the two scans do
    // not double-count.
    for cap in OBSIDIAN_EMBED_RE.captures_iter(content) {
        let whole = cap.get(0).expect("group 0 present");
        if in_code(whole.start()) {
            continue;
        }
        let inner = cap[1].trim();
        if inner.is_empty() || is_skippable_attachment_ref(inner) {
            continue;
        }
        refs.push(AttachmentRef {
            alt: String::new(),
            original_ref: inner.to_string(),
            full_match: whole.as_str().to_string(),
        });
    }

    // Standard markdown images.
    for cap in MARKDOWN_IMAGE_RE.captures_iter(content) {
        let whole = cap.get(0).expect("group 0 present");
        if in_code(whole.start()) {
            continue;
        }
        let url = cap[2].trim();
        if url.is_empty() || is_skippable_attachment_ref(url) {
            continue;
        }
        refs.push(AttachmentRef {
            alt: cap[1].to_string(),
            original_ref: url.to_string(),
            full_match: whole.as_str().to_string(),
        });
    }

    refs
}

/// Match one detected attachment `reference` against the supplied vault files
/// (#1925), returning the index of the chosen [`VaultFile`] or `None`.
///
/// Rule (documented, deterministic):
///   1. **Relative-path equality** first — the ref's normalized path (`\`→`/`,
///      leading `./` stripped) equals a vault file's normalized `path`. This is
///      the precise match (e.g. `assets/img.png` → the file at `assets/img.png`).
///   2. **Basename fallback** — the ref's final path segment equals a vault
///      file's final segment (e.g. Obsidian's `![[img.png]]` carries only the
///      basename). On multiple basename matches the FIRST in `vault_files` order
///      is chosen (deterministic) and `ambiguous` is set so the caller can warn.
///
/// Returns `(index, ambiguous)`. `ambiguous` is only ever `true` for the
/// basename-fallback path with >1 candidate; an exact path match is never
/// ambiguous.
pub fn match_vault_file(reference: &str, vault_files: &[VaultFile]) -> Option<(usize, bool)> {
    fn norm(p: &str) -> String {
        let p = p.replace('\\', "/");
        p.strip_prefix("./").unwrap_or(&p).to_string()
    }
    fn basename(p: &str) -> &str {
        p.rsplit('/').next().unwrap_or(p)
    }

    let want = norm(reference);
    // 1. Exact relative-path equality.
    if let Some(i) = vault_files.iter().position(|f| norm(&f.path) == want) {
        return Some((i, false));
    }
    // 2. Basename fallback.
    let want_base = basename(&want);
    let candidates: Vec<usize> = vault_files
        .iter()
        .enumerate()
        .filter(|(_, f)| basename(&norm(&f.path)) == want_base)
        .map(|(i, _)| i)
        .collect();
    match candidates.as_slice() {
        [] => None,
        [single] => Some((*single, false)),
        [first, ..] => Some((*first, true)),
    }
}

/// Byte ranges of `content` that lie inside an inline-code span
/// (`` `...` ``). A left-to-right scan that pairs backticks: the text between
/// a backtick and the next backtick is a code span, and the backticks
/// themselves are included in the range.
///
/// This is the SINGLE definition for the whole workspace (#3264). Two
/// consumers read the same spans off the same block content during one
/// `import_markdown` call:
/// - [`detect_attachment_refs`] here in the engine, which skips attachment
///   refs that fall inside a span;
/// - the app-side #1924 inline-tag / human-page-link pre-pass in
///   `commands::pages::markdown`, which leaves a `#tag` inside `` `code` ``
///   literal rather than rewriting it to `#[ULID]`.
///
/// Those two used to hold statement-identical private copies. Because both
/// copies carried the caveat below, the first fix to either one would have
/// desynchronised them — within a single imported block a backtick-delimited
/// region would be code for one pass (attachments skipped) and not code for
/// the other (`#tag` rewritten), silently corrupting the block. Keeping one
/// definition is what makes that failure unrepresentable, so do not re-inline
/// a local copy on either side.
///
/// Deliberately minimal: it does not implement the full CommonMark
/// backtick-run-length matching rule (a span opened by N backticks closes only
/// on a run of exactly N); single-backtick pairing is sufficient for the
/// import safety net and matches the spirit of the fenced-code (`is_code`)
/// handling. If that is ever tightened, it is tightened here, once, for both
/// consumers at the same time.
pub fn inline_code_spans(content: &str) -> Vec<(usize, usize)> {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut open: Option<usize> = None;
    for (i, b) in content.bytes().enumerate() {
        if b == b'`' {
            match open {
                None => open = Some(i),
                Some(start) => {
                    spans.push((start, i + 1));
                    open = None;
                }
            }
        }
    }
    spans
}

/// Guess an attachment MIME type from a filename/path extension (#1925).
///
/// Covers the common vault asset types (images, pdf, plain text, json). Falls
/// back to `application/octet-stream` for unknown extensions — the caller then
/// skips+warns because the attachment MIME allow-list rejects it (matching the
/// `add_attachment_with_bytes_inner` validation), so an unrecognized asset never
/// silently lands with a wrong type.
pub fn guess_attachment_mime(path: &str) -> String {
    let ext = path
        .rsplit('.')
        .next()
        .filter(|e| !e.contains('/'))
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "txt" | "md" | "csv" | "log" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Parse Logseq-style indented markdown into a list of blocks with depth.
///
/// Each line starting with `- ` (after optional indentation) is a block.
/// Indentation determines depth (2 spaces = 1 level).
///
/// **Continuation lines** (#682): a non-list, non-property line that is
/// indented under a preceding bullet is treated as a continuation of that
/// bullet — its text is appended (newline-joined) to the owning block's
/// content rather than spawned as a separate block. This matches Logseq,
/// which stores soft-wrapped / multi-line bullet bodies as a single block.
/// A non-list line with no preceding block (file starts with bare text)
/// still becomes its own depth-0 content block.
///
/// **Property lines** (#682): a `key:: value` line attaches to the nearest
/// preceding block whose depth is *less than or equal to* the property
/// line's own indentation depth — i.e. the block that indentation says owns
/// it — rather than blindly to the most-recently-pushed block. Logseq emits
/// property lines indented one level under (or level with) their owner, so a
/// property nested under a grandchild no longer mis-attaches to an unrelated
/// later sibling. If no such ancestor exists the property is dropped and a
/// warning is recorded (mirroring the depth-clamp warning counter).
///
/// `((uuid))` references are converted to plain text.
pub fn parse_logseq_markdown(content: &str) -> ParseOutput {
    // Normalize line endings BEFORE any other parsing. The frontmatter strip
    // below uses `find("\n---")`, which is fragile against CRLF (works only
    // because `\n---` is a substring of `\r\n---`) and outright broken for
    // CR-only files (classic Mac), where no `\n` exists at all and the entire
    // frontmatter would otherwise be retained as block content. Doing this
    // first also lets `body.lines()` and the indent calculation see clean
    // Lines without stray `\r` characters.
    let normalized_eol = content.replace("\r\n", "\n").replace('\r', "\n");

    // Normalize tabs to 2 spaces for consistent indentation parsing
    let normalized = normalized_eol.replace('\t', "  ");

    // Capture + parse a leading YAML frontmatter block (#1432). The exporter
    // (`export_page_markdown_inner`) emits page properties as scalar
    // `key: value` lines between a `---` fence pair, but the importer
    // historically *discarded* the whole block — an export↔import asymmetry.
    // We now strip the block AND parse it into `(key, value)` pairs that the
    // apply path stamps back onto the page block.
    //
    // The fence may appear in two positions:
    //   1. At the very top of the file (the conventional Markdown / Logseq
    //      frontmatter position), or
    //   2. Immediately after a leading `# Heading` line — the exact shape
    //      Agaric's own export emits (`# Title\n\n---\n…\n---\n\n`). Without
    //      this case Agaric's export would NOT round-trip, defeating the
    //      whole point of #1432.
    // In case 2 the heading line is preserved in `body` (it becomes a
    // depth-0 content block exactly as before); only the fenced block is
    // excised. An unclosed `---` is treated as plain content (no
    // frontmatter), matching the prior strip behaviour.
    let mut frontmatter_warnings: Vec<String> = Vec::new();
    let mut frontmatter: Vec<(String, String)> = Vec::new();
    let mut frontmatter_list_items: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let normalized = strip_frontmatter(
        &normalized,
        &mut frontmatter,
        &mut frontmatter_list_items,
        &mut frontmatter_warnings,
    );

    let mut warnings = frontmatter_warnings;
    let blocks = parse_outline(&normalized, ParseMode::Import, true, &mut warnings);

    ParseOutput {
        blocks,
        frontmatter,
        frontmatter_list_items,
        warnings,
    }
}

/// Parse a source-mode buffer (#5140) back into the blocks it was rendered
/// from. Where [`parse_logseq_markdown`] normalises a file from another tool,
/// this keeps what the renderer wrote: `((ULID))` refs, spacing, a block's
/// interior blank lines and the indentation of its continuation lines. It also
/// reads a checkbox after the list marker as the block's `todo_state`. A buffer
/// has no frontmatter, so none is looked for. Nor is a block nested past the
/// import depth limit flattened: a save refuses it where an import would
/// reshape it.
pub fn parse_source_outline(content: &str) -> ParseOutput {
    source_outline(content, false)
}

/// [`parse_source_outline`], flattening blocks past [`MAX_IMPORT_DEPTH`] as an
/// import does when `clamp`.
fn source_outline(content: &str, clamp: bool) -> ParseOutput {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let mut warnings = Vec::new();
    let blocks = parse_outline(&normalized, ParseMode::Source, clamp, &mut warnings);
    ParseOutput {
        blocks,
        frontmatter: Vec::new(),
        frontmatter_list_items: std::collections::HashMap::new(),
        warnings,
    }
}

/// Clipboard text as blocks (#5140). Text whose first non-blank line is a
/// bullet is an outline, read as a source buffer is but flattened past the
/// import depth limit as an import is, and with a trailing ` ^word` that is
/// not a block id kept as text. Any other text is one
/// block per non-blank line, the line less its indentation, nested by that
/// indentation, with nothing on it read as a marker or a property.
pub fn parse_pasted_text(text: &str) -> Vec<ParsedBlock> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let first_line = text
        .lines()
        .map(str::trim_start)
        .find(|line| !line.is_empty());
    if first_line.is_some_and(is_bullet_line) {
        let mut blocks = source_outline(&text, true).blocks;
        blocks.iter_mut().for_each(restore_text_anchor);
        return blocks;
    }
    text.lines()
        .filter(|line| !line.trim_start().is_empty())
        .map(|line| pasted_block(line.trim_start().to_string(), indent_columns(line) / 2))
        .collect()
}

/// A pasted block holding `content` as it comes, at `depth`. Like an imported
/// block, it is code when a line of it is a fence line.
pub fn pasted_block(content: String, depth: usize) -> ParsedBlock {
    ParsedBlock {
        is_code: content.lines().any(|line| is_fence_delimiter(line, false)),
        content,
        depth,
        properties: Vec::new(),
        block_anchor: None,
    }
}

/// The two readings of the outline grammar. Import normalises a file written
/// by another tool; Source reads back the buffer source mode renders and must
/// return exactly the tree it was rendered from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ParseMode {
    Import,
    Source,
}

/// The block scan both modes share: lines into blocks, then anchors, then the
/// depth clamp when `clamp`, appending one warning per lossy transform to
/// `warnings`.
fn parse_outline(
    normalized: &str,
    mode: ParseMode,
    clamp: bool,
    warnings: &mut Vec<String>,
) -> Vec<ParsedBlock> {
    let (mut blocks, ends_in_code, mut lossy) = parse_block_lines(normalized, mode);
    extract_block_anchors(&mut blocks, &ends_in_code, mode);
    if clamp {
        lossy.clamped = clamp_block_depths(&mut blocks);
    }
    lossy.push_warnings(warnings);
    blocks
}

/// Counts of the lossy / silently-corrected transforms [`parse_block_lines`]
/// and the post-passes applied to a file. Each non-zero counter becomes one
/// aggregate line in [`ParseOutput::warnings`] so a reshaped import is
/// diagnosable rather than silent.
#[derive(Default)]
struct LossyCounts {
    /// Blocks nested deeper than [`MAX_IMPORT_DEPTH`] and flattened to it.
    clamped: usize,
    /// #682 — property lines that could not be attached to any owning
    /// ancestor block and were dropped.
    orphan_property: usize,
    /// #1568 — body-property lines whose key is reserved/exporter-managed
    /// (`FRONTMATTER_RESERVED_KEYS`, e.g. `space`). Such keys are
    /// column-backed / lifecycle-managed and would make `set_property_in_tx`
    /// return a Validation error, aborting the whole import chunk. We filter
    /// them here — exactly as the frontmatter path does (`parse_frontmatter`)
    /// — so a hand-crafted/untrusted body bullet like `space:: X` is skipped
    /// instead of failing an otherwise-valid import.
    reserved_property: usize,
    /// #1933 — `((uuid))` block references removed from content. Block-ref
    /// stripping is a lossy transform (the reference target vanishes) held to
    /// a lower observability bar than the other lossy transforms here;
    /// counting it surfaces an aggregate warning so an import that drops
    /// block-refs is diagnosable from the returned warnings / logs.
    stripped_refs: usize,
    /// #2725 — `- `-prefixed lines that appeared STRICTLY INSIDE an open
    /// fenced code block and were therefore folded into the owning block's
    /// content instead of (mis)spawning a new block.
    fence_split_avoided: usize,
}

impl LossyCounts {
    /// Append one aggregate warning per non-zero counter, in the order the
    /// import summary has always listed them.
    fn push_warnings(&self, warnings: &mut Vec<String>) {
        let Self {
            clamped,
            orphan_property,
            reserved_property,
            stripped_refs,
            fence_split_avoided,
        } = *self;
        if clamped > 0 {
            warnings.push(format!(
                "{clamped} block(s) exceeded maximum depth of {MAX_IMPORT_DEPTH} and were flattened"
            ));
        }
        if orphan_property > 0 {
            warnings.push(format!(
                "{orphan_property} property line(s) had no owning block at or above their \
                 indentation and were dropped"
            ));
        }
        if reserved_property > 0 {
            warnings.push(format!(
                "{reserved_property} reserved/exporter-managed property line(s) (e.g. `space`) \
                 were skipped during import"
            ));
        }
        if stripped_refs > 0 {
            warnings.push(format!(
                "{stripped_refs} ((block-ref)) reference(s) were stripped from imported \
                 content and could not be preserved"
            ));
        }
        if fence_split_avoided > 0 {
            warnings.push(format!(
                "{fence_split_avoided} list-like line(s) inside a code fence were kept as \
                 literal code content instead of new blocks"
            ));
        }
    }
}

/// A bullet line: `- text`, or the bare `-` empty bullet Logseq/Obsidian emit
/// for an empty list item.
fn is_bullet_line(trimmed: &str) -> bool {
    trimmed == "-" || trimmed.starts_with("- ")
}

/// Document-global fenced-code state for the line scan (#1924). An
/// [`is_fence_delimiter`] line toggles the fence, and the delimiter line plus
/// every line until the closing delimiter is treated as code. This is
/// intentionally a single-fence-char (`` ` ``) heuristic — full code-fence
/// import handling (tilde fences, language hints, indented fences, verbatim
/// preservation) is separate, out-of-scope work.
#[derive(Default)]
struct FenceState {
    open: bool,
    /// #2866: depth of the block that opened the currently-open fence (if
    /// any). The fence flag is document-global, so a block whose content
    /// contains an ODD number of fence delimiters (an unbalanced/unterminated
    /// fence) would otherwise leave the fence open past the end of that block
    /// and swallow the next sibling into it. This depth lets the scan detect
    /// that boundary — see [`FenceState::close_unbalanced_at`].
    open_depth: Option<usize>,
}

impl FenceState {
    /// #2866 — recover from an unbalanced fence at a sibling boundary: the
    /// fence is still open from an earlier, unterminated delimiter and the
    /// line is a NEW bullet at or above the depth of the block that opened it. That
    /// means we have left the owning block's scope, so the fence must have
    /// been meant to close by the end of that block — force it closed here so
    /// the sibling spawns its own block instead of being folded into the
    /// never-closed fence. Only applies to non-delimiter lines; a genuine
    /// closing delimiter is handled by [`FenceState::toggle`].
    ///
    /// `rest` is the scan's own line iterator, cloned so this can peek — see
    /// the ambiguity note inside.
    fn close_unbalanced_at(&mut self, trimmed: &str, depth: usize, rest: std::str::Lines<'_>) {
        let Some(open_depth) = self.open_depth else {
            return;
        };
        if !self.open
            || is_fence_delimiter(trimmed, self.open)
            || !is_bullet_line(trimmed)
            || depth > open_depth
        {
            return;
        }
        // Regression guard against #2725: a bullet-shaped line at (or above)
        // the fence-opener's own depth is genuinely ambiguous on its own — it
        // could be the sibling bullet #2866 needs to recover at (the fence
        // never really closes), OR it could be literal fence CONTENT that just
        // happens to look bullet-shaped, with the fence properly closing on
        // the very next line (e.g. a pasted snippet whose last line is
        // `- interior`, immediately followed by the closing fence:
        // `- ```\n- interior\n``` `). Those two shapes are indistinguishable
        // from this line alone.
        //
        // Resolve the ambiguity with a single-line peek: if the next non-blank
        // line is a BARE closing delimiter (no `- ` prefix), that's an
        // UNAMBIGUOUS signal the fence closes right here — a bare
        // ```` ``` ```` can only ever be a continuation/close of an
        // already-open fence, never the start of a new bullet — so treat the
        // current line as fence content and do NOT recover. A BULLETED
        // delimiter (`- ``` `) on the next line is NOT treated as unambiguous:
        // it could just as easily be opening a brand-new sibling code block
        // (the exact shape #2866 was filed over, see the multi-code-block
        // regression test below), so recovery still fires in that case.
        // Anything else on the next line (or EOF) also falls through to
        // recovery, matching the pre-existing (unrefined) behaviour.
        let next_is_unambiguous_close = rest
            .map(str::trim_start)
            .find(|next| !next.is_empty())
            .is_some_and(|next| next.starts_with("```"));
        if !next_is_unambiguous_close {
            self.open = false;
            self.open_depth = None;
        }
    }

    /// Toggle over a fence-delimiter line. Opening a fence records the depth
    /// of the block that owns it (for the unbalanced-fence recovery above): a
    /// delimiter that opens a bullet (`- ```rust`) owns that bullet's own
    /// depth; a bare ```` ``` ```` continuation line belongs to the
    /// most-recently-pushed block instead.
    fn toggle(&mut self, trimmed: &str, depth: usize, last_block: Option<&ParsedBlock>) {
        self.open_depth = if self.open {
            None
        } else if is_bullet_line(trimmed) {
            Some(depth)
        } else {
            Some(last_block.map_or(depth, |b| b.depth))
        };
        self.open = !self.open;
    }
}

/// Scan already-normalized, frontmatter-free markdown into blocks, collecting
/// the lossy-transform counters [`parse_logseq_markdown`] turns into warnings.
///
/// Alongside each block it returns whether the block's last content line was
/// code, which decides whether a trailing `^id` on it is an anchor
/// ([`extract_block_anchors`]).
fn parse_block_lines(
    normalized: &str,
    mode: ParseMode,
) -> (Vec<ParsedBlock>, Vec<bool>, LossyCounts) {
    let mut blocks: Vec<ParsedBlock> = Vec::new();
    let mut ends_in_code: Vec<bool> = Vec::new();
    let mut lossy = LossyCounts::default();
    let mut fence = FenceState::default();
    // Source mode keeps a block's interior blank lines. Whether a blank line is
    // interior is known only at the next non-blank line: a continuation line
    // takes the run, a bullet or property line drops it.
    let mut blank_run: Vec<&str> = Vec::new();
    // The column the last block's text starts at: after a bullet's `- `, or
    // where a bare line of text starts.
    let mut text_column = 0;
    // #1921 — iterate `normalized.lines()` directly instead of collecting into
    // a `Vec<&str>`. The scan only ever reads the CURRENT line in document
    // order, so a streaming iterator is a drop-in that avoids the intermediate
    // allocation.
    // #2866 (review follow-up) — `lines()` (`Lines<'_>`) is `Clone`, so a
    // manual `while let` over it (instead of a `for` loop) lets the boundary
    // check below CLONE the iterator to peek one line ahead without consuming
    // it. This is a read-only peek: the cloned iterator is discarded after the
    // check, so the outer loop's position and every other line's processing is
    // completely unaffected.
    let mut lines_iter = normalized.lines();
    while let Some(line) = lines_iter.next() {
        let trimmed = line.trim_start();

        if trimmed.is_empty() {
            if mode == ParseMode::Source {
                blank_run.push(line);
            }
            continue;
        }

        // Calculate indentation (leading columns / 2). Computed ahead of the
        // fence handling (#2866) so `depth` is available to it.
        let depth = indent_columns(line) / 2;

        fence.close_unbalanced_at(trimmed, depth, lines_iter.clone());
        // A source buffer writes the anchor of a block that ends in code on a
        // line of its own, so a fence the block leaves open ends there instead
        // of swallowing the lines after it.
        if mode == ParseMode::Source && fence.open && ANCHOR_LINE_RE.is_match(trimmed) {
            fence = FenceState::default();
        }
        // Probed after the recovery, which may have just closed the fence.
        let is_fence_delim = fence_delimiter(trimmed, fence.open, mode);

        // The delimiter line is itself part of the code region (`line_is_code`
        // is true on both the opening and closing fence), and every line
        // strictly inside a fence is code. Computed BEFORE classification so
        // the block this line lands in (or appends to) can be marked.
        let line_is_code = fence.open || is_fence_delim;
        if is_fence_delim {
            fence.toggle(trimmed, depth, blocks.last());
        }

        // #2725 — a `- `-prefixed line STRICTLY INSIDE an open code fence
        // (i.e. not itself a fence delimiter) is literal code content, NOT a
        // new list item. `line_is_code` is also true on the fence-DELIMITER
        // line (`- ```rust` opens the code block's own bullet), so guarding on
        // `line_is_code` would wrongly swallow that opening bullet; guard on
        // `in_code_body` instead — true only for lines between (not on) the
        // delimiters. Such a line falls through to the continuation branch
        // (folded into the fenced block's content), mirroring the
        // already-guarded property branch below.
        // A source buffer writes code this way itself, so there it is no
        // reshaping to report.
        let in_code_body = fence.open && !is_fence_delim;
        if in_code_body && is_bullet_line(trimmed) && mode == ParseMode::Import {
            lossy.fence_split_avoided += 1;
        }

        // Check if this is a list item (- prefix). #1917: a bare `-` with no
        // trailing space is an EMPTY bullet (Logseq/Obsidian emit these for an
        // empty list item) — it must spawn its own empty block, not fold into
        // the previous block's content as a continuation line. Handle both the
        // `- text` and the bare `-` forms here.
        let bullet_text = if in_code_body {
            None
        } else if trimmed == "-" {
            Some("")
        } else {
            trimmed.strip_prefix("- ")
        };
        if let Some(text) = bullet_text {
            lossy.stripped_refs += push_bullet_block(&mut blocks, text, depth, line_is_code, mode);
            ends_in_code.push(line_is_code);
            text_column = (depth + 1) * 2;
        } else if !line_is_code
            && let Some((key_candidate, value)) = property_line(trimmed, &blocks, depth, mode)
        {
            attach_property_line(&mut blocks, key_candidate, value, depth, &mut lossy);
        } else if let Some(last) = blocks.last_mut() {
            match mode {
                ParseMode::Import => {
                    lossy.stripped_refs +=
                        append_continuation_line(last, line, line_is_code, text_column);
                }
                ParseMode::Source => append_source_line(last, &blank_run, line, line_is_code),
            }
            ends_in_code[blocks.len() - 1] = line_is_code;
        } else {
            lossy.stripped_refs += push_text_block(&mut blocks, trimmed, depth, line_is_code, mode);
            ends_in_code.push(line_is_code);
            text_column = depth * 2;
        }
        blank_run.clear();
    }

    (blocks, ends_in_code, lossy)
}

/// Push a `- text` bullet as a new block: the leading list marker (if any)
/// becomes a `listStyle` property (#4552), in Source mode a checkbox after it
/// becomes `todo_state`, and on import `((uuid))` block references are
/// stripped to plain text. Returns how many references were stripped.
fn push_bullet_block(
    blocks: &mut Vec<ParsedBlock>,
    text: &str,
    depth: usize,
    line_is_code: bool,
    mode: ParseMode,
) -> usize {
    // #4552 slice 4 — a SECOND list marker right after the outline bullet is
    // the block's `listStyle`, not its content: the exporter writes `- - foo` /
    // `- 1. foo` for a `bullet` / `ordered` block and `- \- foo` for a plain
    // block whose text merely begins with a marker. Consume the marker into a
    // property row and keep `blocks.content` bare — the marker is a
    // document-assembly concern, not a block-content one. The literal ordinal
    // is discarded; export re-derives it positionally.
    let (list_style, todo_state, text) = split_bullet_markers(text, mode);
    let mut properties: Vec<(String, String)> = Vec::new();
    if let Some(style) = list_style {
        properties.push((LIST_STYLE_KEY.to_string(), style.to_string()));
    }
    if let Some(state) = todo_state {
        properties.push(("todo_state".to_string(), state.to_string()));
    }
    let (cleaned, removed) = clean_text(text, mode, line_is_code);
    blocks.push(ParsedBlock {
        content: cleaned,
        depth,
        // A body `listStyle:: value` line further down the file is
        // appended AFTER this seed and therefore wins — an explicit
        // property line overrides the marker, not the other way round.
        properties,
        is_code: line_is_code,
        block_anchor: None,
    });
    removed
}

/// Push a line no block precedes (a file that starts with bare text) as a
/// block of its own. Returns how many references were stripped from it.
fn push_text_block(
    blocks: &mut Vec<ParsedBlock>,
    trimmed: &str,
    depth: usize,
    line_is_code: bool,
    mode: ParseMode,
) -> usize {
    let (cleaned, removed) = clean_text(trimmed, mode, line_is_code);
    blocks.push(ParsedBlock {
        content: cleaned,
        depth,
        properties: Vec::new(),
        is_code: line_is_code,
        block_anchor: None,
    });
    removed
}

/// A line's text as its block keeps it, and how many `((uuid))` references
/// were stripped: an import normalises prose ([`strip_block_refs_counted`]);
/// code, and a source buffer, keep it as written.
fn clean_text(text: &str, mode: ParseMode, line_is_code: bool) -> (String, usize) {
    match mode {
        ParseMode::Import if !line_is_code => strip_block_refs_counted(text),
        ParseMode::Import | ParseMode::Source => (text.to_string(), 0),
    }
}

/// The key and value of `trimmed` when it is a `key:: value` line `mode` reads
/// as a property: the key is one `op::validate_set_property` accepts
/// (`^[A-Za-z0-9_-]{1,64}$`, I-Core-10), so a `:: ` mid-sentence is content.
/// In Source mode a line the save would not store — a reserved key, or no
/// block at or above its indentation — is what the user typed: content. An
/// import reads it as a property and drops it with a warning.
fn property_line<'a>(
    trimmed: &'a str,
    blocks: &[ParsedBlock],
    depth: usize,
    mode: ParseMode,
) -> Option<(&'a str, &'a str)> {
    let (key, value) = trimmed
        .split_once(":: ")
        .filter(|(key, _)| is_property_key(key.trim()))?;
    let stored = !FRONTMATTER_RESERVED_KEYS.contains(&key.trim())
        && blocks.iter().any(|block| block.depth <= depth);
    (mode == ParseMode::Import || stored).then_some((key, value))
}

/// Attach a `key:: value` body property to the block that *indentation* says
/// owns it, rather than to the most-recently-pushed block (#682): Logseq emits
/// a property line indented one level under (or level with) its owning bullet,
/// so the owner is the nearest preceding block whose depth is <= the property
/// line's depth. Scanning in reverse over the document-ordered `blocks` finds
/// that nearest ancestor; a property nested under a grandchild therefore no
/// longer mis-attaches to an unrelated later sibling. Reserved keys and
/// properties with no owning ancestor are dropped and counted in `lossy`
/// ([`property_line`] hands an import such a line, never a source buffer).
fn attach_property_line(
    blocks: &mut [ParsedBlock],
    key_candidate: &str,
    value: &str,
    depth: usize,
    lossy: &mut LossyCounts,
) {
    let key = key_candidate.trim().to_string();
    let value = value.trim().to_string();
    // #1568: skip reserved/exporter-managed keys before attaching them to an
    // owning block. Filtering here matches the frontmatter round-trip
    // semantics: a reserved body property is dropped, never written, and the
    // surrounding good content imports.
    if FRONTMATTER_RESERVED_KEYS.contains(&key.as_str()) {
        tracing::debug!(
            key = %key,
            "skipping reserved/column-backed body property during import (#1568)"
        );
        lossy.reserved_property += 1;
        return;
    }
    match blocks.iter_mut().rev().find(|b| b.depth <= depth) {
        Some(owner) => owner.properties.push((key, value)),
        // No ancestor at or above this indentation (e.g. a property line
        // indented deeper than any preceding bullet, or before any bullet at
        // all). Lossy — surface it via a warning counter rather than swallow
        // it silently.
        None => lossy.orphan_property += 1,
    }
}

/// Fold a continuation line into the block it belongs to (#682): a non-list,
/// non-property line that follows a bullet is the soft-wrapped / multi-line
/// body of that bullet, appended (newline-joined) to the owning block's
/// content instead of spawning a separate block, matching how Logseq stores
/// multi-line bullet bodies. Returns how many `((uuid))` references were
/// stripped from it. A code line is kept as written, less the indentation up
/// to `text_column`, where its block's text starts.
fn append_continuation_line(
    last: &mut ParsedBlock,
    line: &str,
    line_is_code: bool,
    text_column: usize,
) -> usize {
    let (cleaned, removed) = if line_is_code {
        (dedent(line, text_column).to_string(), 0)
    } else {
        strip_block_refs_counted(unescape_continuation(line.trim_start(), false))
    };
    // #1924 — a continuation line inside a fence makes the owning block code
    // (e.g. the fenced body lines that follow a `- ```rust` bullet, and the
    // closing ```` ``` ```` delimiter line). Once a block is flagged code it
    // stays code.
    if line_is_code {
        last.is_code = true;
    }
    if !cleaned.is_empty() {
        if !last.content.is_empty() {
            last.content.push('\n');
        }
        last.content.push_str(&cleaned);
    }
    removed
}

/// A source buffer's continuation line (#5140): only its bullet's own
/// indentation, `(depth + 1) * 2` spaces, is removed, so code keeps its
/// indentation and prose its spacing. The blank lines before it are interior
/// to the block and are kept the same way.
fn append_source_line(last: &mut ParsedBlock, blank_run: &[&str], line: &str, line_is_code: bool) {
    let width = (last.depth + 1) * 2;
    for blank in blank_run {
        last.content.push('\n');
        last.content.push_str(dedent(blank, width));
    }
    last.content.push('\n');
    let text = dedent(line, width);
    last.content.push_str(if line_is_code {
        unescape_code_line(text)
    } else {
        unescape_continuation(text, false)
    });
    if line_is_code {
        last.is_code = true;
    }
}

/// `line` less up to `width` columns of leading spaces and tabs.
fn dedent(line: &str, width: usize) -> &str {
    let mut columns = 0;
    let mut cut = 0;
    for byte in line.bytes() {
        columns += match byte {
            b' ' => 1,
            b'\t' => 2,
            _ => break,
        };
        if columns > width {
            break;
        }
        cut += 1;
    }
    &line[cut..]
}

/// The columns `line`'s indentation spans. A tab counts as two, one level, so
/// a hand-typed tab-indented outline nests; an import has already turned its
/// tabs into two spaces each.
fn indent_columns(line: &str) -> usize {
    let indent = &line[..line.len() - line.trim_start().len()];
    indent.len() + indent.matches('\t').count()
}

/// A continuation line's text with the exporter's escape, if any, removed.
fn unescape_continuation(text: &str, line_is_code: bool) -> &str {
    // #2716 — reverse the exporter's continuation-line escape: a NON-code
    // continuation line the exporter had to guard (it opens a bullet or matches
    // `key:: value`) was emitted with a single leading `\` so it would land
    // HERE (folded) instead of spawning a block / property. Strip that one
    // backslash — but ONLY when the escaped payload really is such an
    // ambiguous line, so an ordinary continuation line that legitimately begins
    // with `\` (e.g. a LaTeX command) is preserved verbatim. Skipped inside a
    // code fence (`line_is_code`): code is emitted verbatim and must keep its
    // backslashes intact.
    if !line_is_code
        && let Some(rest) = text.strip_prefix('\\')
        && {
            // The exporter escapes based on the line's TRIMMED shape
            // (`content_line_is_ambiguous`) and anchors the `\` BEFORE the
            // continuation line's own leading whitespace, so an INDENTED
            // ambiguous line reaches here as `\<ws><token>` (`  - sub` → wire
            // `  \  - sub`, `trimmed` = `\  - sub`). Match the same TRIMMED
            // shape — otherwise the untrimmed `rest.starts_with("- ")` misses
            // it and the `\` leaks into the folded content as a spurious
            // character. (On import, interior indentation itself is still
            // normalised away downstream by `strip_block_refs_counted`'s trim,
            // exactly as it is for a non-ambiguous indented continuation line;
            // the point of the un-escape is only to strip the escape marker,
            // never to inject one.) Further backslashes are looked past too, as the exporter
            // does, so a line written as `\- x` comes back with its backslash.
            let body = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '\\');
            is_bullet_line(body) || line_is_property_shaped(body)
        }
    {
        rest
    } else {
        text
    }
}

/// #2510 — strip a trailing Obsidian block-anchor marker (`^block-id`) off
/// each block's now-FULLY-assembled content, recording it in
/// [`ParsedBlock::block_anchor`]. Runs as a POST-pass over the scanned blocks
/// (not inline during the line-by-line scan) because the marker sits at the
/// end of the WHOLE block, and a block's content is only fully assembled once
/// every continuation line (#682) has been appended to it. A block whose last
/// content line was code is skipped: a `^something` on a fence line or inside
/// a fence is code, not an Obsidian anchor. That is why the exporter puts a
/// code block's anchor on its own line after the closing fence.
fn extract_block_anchors(blocks: &mut [ParsedBlock], ends_in_code: &[bool], mode: ParseMode) {
    for (block, &ends_in_code) in blocks.iter_mut().zip(ends_in_code) {
        if ends_in_code {
            continue;
        }
        let strip = match mode {
            ParseMode::Import => strip_block_anchor_marker,
            ParseMode::Source => strip_written_anchor_marker,
        };
        if let (stripped, Some(anchor)) = strip(&block.content) {
            block.content = stripped;
            block.block_anchor = Some(anchor);
        }
    }
}

/// Put a trailing ` ^word` whose word is not a block id back into the block's
/// text: it names no block, so it is what the user wrote. The parse took the
/// whitespace around it, so a tab or line break before it comes back as a
/// space, and whitespace after it is lost.
pub fn restore_text_anchor(block: &mut ParsedBlock) {
    let Some(word) = block
        .block_anchor
        .take_if(|word| BlockId::from_string(word.as_str()).is_err())
    else {
        return;
    };
    let separator = if block.content.is_empty() { "" } else { " " };
    block.content = format!("{}{separator}^{word}", block.content);
}

/// Clamp depth to [`MAX_IMPORT_DEPTH`] (flattening deeper blocks) and return
/// how many blocks were clamped.
fn clamp_block_depths(blocks: &mut [ParsedBlock]) -> usize {
    let mut clamped = 0;
    for block in blocks {
        if block.depth > MAX_IMPORT_DEPTH {
            block.depth = MAX_IMPORT_DEPTH;
            clamped += 1;
        }
    }
    clamped
}

/// Excise a leading YAML frontmatter block from already-EOL-normalized
/// markdown and parse it into page-property pairs (#1432).
///
/// Returns the markdown with the fenced block removed; `frontmatter`,
/// `list_items` (#2829 — real item boundaries for sequence-valued keys) and
/// `warnings` are appended in place. Two fence positions are accepted (see
/// the call site): the very top of the file, or immediately after a single
/// leading `# Heading` line (Agaric's own export shape). In the latter case
/// the heading line is left in the returned body. An unterminated fence is
/// treated as plain content (returns the input unchanged, no properties).
fn strip_frontmatter<'a>(
    normalized: &'a str,
    frontmatter: &mut Vec<(String, String)>,
    list_items: &mut std::collections::HashMap<String, Vec<String>>,
    warnings: &mut Vec<String>,
) -> std::borrow::Cow<'a, str> {
    use std::borrow::Cow;
    // Helper: given a slice that begins exactly at an opening `---` fence,
    // parse the fenced block and return the byte length consumed (through the
    // closing `\n---` and its line), or `None` if there is no closing fence.
    let parse_fence = |slice: &str,
                       frontmatter: &mut Vec<(String, String)>,
                       list_items: &mut std::collections::HashMap<String, Vec<String>>,
                       warnings: &mut Vec<String>|
     -> Option<usize> {
        let after_open = slice.strip_prefix("---")?;
        let end = after_open.find("\n---")?; // index within `after_open`
        let yaml = &after_open[..end];
        frontmatter.extend(parse_frontmatter(yaml, list_items, warnings));
        // Consume through the closing fence line. `end + 4` skips the
        // `\n---`; then advance past the rest of the closing line (to its
        // newline, inclusive) so the heading/body that follows starts clean.
        let consumed_in_after = end + 4;
        let tail = &after_open[consumed_in_after..];
        let line_end = tail.find('\n').map_or(tail.len(), |n| n + 1);
        // 3 = len("---") opening fence we stripped.
        Some(3 + consumed_in_after + line_end)
    };

    // Case 1: fence at the very top of the file.
    if normalized.starts_with("---") {
        if let Some(consumed) = parse_fence(normalized, frontmatter, list_items, warnings) {
            return Cow::Owned(normalized[consumed..].to_string());
        }
        return Cow::Borrowed(normalized);
    }

    // Case 2: a single leading `# Heading` line, then (optionally blank
    // lines) the fence — Agaric's export shape. Find the heading line, scan
    // past blank lines, and if a fence opens there, excise it while keeping
    // the heading line + any following body.
    if normalized.starts_with("# ") {
        let heading_end = normalized.find('\n').map_or(normalized.len(), |n| n + 1);
        let (heading, rest) = normalized.split_at(heading_end);
        // Skip blank lines between the heading and a possible fence. The
        // blank lines between heading and fence (and any after the fence) are
        // immaterial — the line-based parser skips blanks.
        let trimmed_rest = rest.trim_start_matches('\n');
        if trimmed_rest.starts_with("---") {
            // #1917 — parse the candidate fence into SCRATCH buffers first.
            // A legitimate Logseq/Obsidian note can begin with an ATX heading
            // (`# Something`) of genuine content, then later carry a `---…---`
            // pair that is a thematic break / section divider, not page
            // frontmatter. Excising that pair as "frontmatter" would silently
            // delete content. We only treat the fenced block as frontmatter if
            // it yields at least one valid `key: value` pair — the exact shape
            // Agaric's own export always emits when it writes frontmatter (it
            // never emits an empty fence). A `---…---` pair containing no
            // scalar pairs is left in place as content.
            let mut scratch_fm: Vec<(String, String)> = Vec::new();
            let mut scratch_list_items: std::collections::HashMap<String, Vec<String>> =
                std::collections::HashMap::new();
            let mut scratch_warn: Vec<String> = Vec::new();
            if let Some(consumed) = parse_fence(
                trimmed_rest,
                &mut scratch_fm,
                &mut scratch_list_items,
                &mut scratch_warn,
            ) && !scratch_fm.is_empty()
            {
                frontmatter.extend(scratch_fm);
                list_items.extend(scratch_list_items);
                warnings.extend(scratch_warn);
                // Reassemble: heading line + the body after the fence.
                let after_fence = &trimmed_rest[consumed..];
                let mut out = String::with_capacity(heading.len() + after_fence.len());
                out.push_str(heading);
                out.push_str(after_fence);
                return Cow::Owned(out);
            }
        }
    }

    Cow::Borrowed(normalized)
}

/// Parse a YAML inline flow sequence (`[a, b, "c, d"]`) into its individual
/// items, IN ORDER (#1917, item boundaries preserved for #2829). Items are
/// split on top-level commas (commas inside a quoted item do NOT split), each
/// item is trimmed and unquoted via [`strip_yaml_quotes`], and empty items
/// are dropped.
///
/// Callers that only need the canonical display/round-trip scalar (the same
/// shape an exported `aliases: a, b` would carry) join the returned items
/// with `", "` themselves — but a caller that needs the REAL item boundaries
/// (e.g. to write one row per alias/tag) must use the returned `Vec`
/// directly rather than re-splitting the joined scalar on `,`, which cannot
/// distinguish an item containing a literal comma (`"Beta, Inc"`) from two
/// separate items (`"Beta"`, `"Inc"`).
fn parse_flow_sequence_items(raw: &str) -> Vec<String> {
    let inner = raw
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(raw);
    let mut items: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quote: Option<char> = None;
    let mut prev_backslash = false;
    for c in inner.chars() {
        match in_quote {
            Some(q) => {
                current.push(c);
                if c == q && !(q == '"' && prev_backslash) {
                    in_quote = None;
                }
                prev_backslash = q == '"' && c == '\\' && !prev_backslash;
            }
            None => match c {
                '"' | '\'' => {
                    in_quote = Some(c);
                    current.push(c);
                    prev_backslash = false;
                }
                ',' => {
                    let item = strip_yaml_quotes(current.trim());
                    if !item.is_empty() {
                        items.push(item.to_string());
                    }
                    current.clear();
                }
                _ => current.push(c),
            },
        }
    }
    let item = strip_yaml_quotes(current.trim());
    if !item.is_empty() {
        items.push(item.to_string());
    }
    items
}

/// One open YAML block scalar (#1590). When a key line ends with a `|` / `>`
/// indicator, the subsequent MORE-INDENTED lines are continuation content
/// belonging to that key — valid YAML, NOT invalid top-level lines. They are
/// captured here, joined into a single scalar value, and committed on the
/// first line that dedents out of the block (or at end of input) by
/// [`commit_block`]. Lifted to module scope (de-nested from
/// [`parse_frontmatter`]) for readability; kept private to this module.
struct BlockScalar {
    key: String,
    folded: bool,
    /// Indentation (in spaces) of the key line that opened the block.
    /// Continuation lines must be indented MORE than this.
    key_indent: usize,
    /// Indentation of the first continuation line — the block's content
    /// indentation, stripped uniformly from each captured line.
    content_indent: Option<usize>,
    lines: Vec<String>,
}

/// Leading-space count of a raw (untrimmed) line. Tabs are treated as a
/// single column; frontmatter is space-indented in practice (the exporter
/// emits spaces), and this is only used for relative indent comparisons.
fn frontmatter_indent_of(raw: &str) -> usize {
    raw.chars().take_while(|c| *c == ' ' || *c == '\t').count()
}

/// Commit a finished block scalar into `pairs` (de-dup aware), joining its
/// captured continuation lines. Literal (`|`) joins with newlines; folded
/// (`>`) joins with spaces. Chomping (`-`/`+`) is accepted at parse time but
/// has no effect on the joined value: it is never given a trailing newline
/// (we never append one), so clip/keep/strip all yield the same newline-free
/// text. De-dup keeps the FIRST value and warns byte-for-byte identically to
/// the scalar / sequence paths.
fn commit_block(
    b: BlockScalar,
    pairs: &mut Vec<(String, String)>,
    seen: &mut std::collections::HashSet<String>,
    warnings: &mut Vec<String>,
) {
    let joined = if b.folded {
        b.lines.join(" ")
    } else {
        b.lines.join("\n")
    };
    if seen.insert(b.key.clone()) {
        pairs.push((b.key, joined));
    } else {
        warnings.push(format!(
            "frontmatter key '{}' appears more than once; keeping the first value",
            b.key
        ));
    }
}

/// One open YAML block-style sequence (#1917): a `key:` line with no inline
/// value, followed by `- item` lines. Items are collected here and committed
/// as a single comma-joined scalar — the same canonical representation the
/// inline flow-sequence (`[a, b]`) path produces — so block-style and flow
/// `aliases:`/`tags:` both round-trip through single-value property storage.
struct PendingSeq {
    key: String,
    items: Vec<String>,
}

/// State threaded through the [`parse_frontmatter`] line scan: the parsed
/// pairs plus the de-dup set, the two skip counters, and whichever multi-line
/// construct (block scalar, block sequence) is currently open. Grouped into
/// one value so each step of the scan is a method instead of a free function
/// taking eight `&mut` arguments.
struct FrontmatterScan<'a> {
    pairs: Vec<(String, String)>,
    seen: std::collections::HashSet<String>,
    list_items: &'a mut std::collections::HashMap<String, Vec<String>>,
    warnings: &'a mut Vec<String>,
    block: Option<BlockScalar>,
    pending_seq: Option<PendingSeq>,
    skipped_array: usize,
    skipped_invalid: usize,
}

impl<'a> FrontmatterScan<'a> {
    fn new(
        list_items: &'a mut std::collections::HashMap<String, Vec<String>>,
        warnings: &'a mut Vec<String>,
    ) -> Self {
        Self {
            pairs: Vec::new(),
            seen: std::collections::HashSet::new(),
            list_items,
            warnings,
            block: None,
            pending_seq: None,
            skipped_array: 0,
            skipped_invalid: 0,
        }
    }

    /// Commit a finished block-style sequence into `pairs` (de-dup aware),
    /// joining its items into a comma-separated scalar. A sequence with no
    /// items (`key:` with nothing following) commits as an empty scalar,
    /// matching the prior `key:` (empty value) behaviour. The unjoined items
    /// are ALSO recorded into `list_items` (#2829) so a consumer needing exact
    /// item boundaries (an item may itself contain a literal comma) doesn't
    /// have to re-split the lossy joined scalar.
    fn commit_seq(&mut self, seq: PendingSeq) {
        let joined = seq.items.join(", ");
        if self.seen.insert(seq.key.clone()) {
            if !seq.items.is_empty() {
                self.list_items.insert(seq.key.clone(), seq.items);
            }
            self.pairs.push((seq.key, joined));
        } else {
            self.warnings.push(format!(
                "frontmatter key '{}' appears more than once; keeping the first value",
                seq.key
            ));
        }
    }

    /// While a block scalar is open, a MORE-INDENTED (or blank) line is
    /// continuation content and must NOT be mis-counted as invalid: capture it
    /// and report `true`. A line indented at-or-below the opening key ends the
    /// block — it is committed here and `false` is reported so the caller
    /// re-processes the line as an ordinary frontmatter line.
    fn absorb_block_scalar_line(&mut self, raw: &str) -> bool {
        let Some(b) = self.block.as_mut() else {
            return false;
        };
        let raw_indent = frontmatter_indent_of(raw);
        let is_blank = raw.trim().is_empty();
        // Blank lines inside a block are part of the scalar (a blank line
        // is only a terminator at-or-below the key indent — but a blank
        // line carries no indent, so treat it as continuation while the
        // block is open).
        if is_blank || raw_indent > b.key_indent {
            let content_indent = *b.content_indent.get_or_insert(raw_indent);
            // Strip the uniform block indentation; never panic on a line
            // that is shorter than the content indent (blank lines).
            let stripped = if raw.len() >= content_indent {
                raw[raw
                    .char_indices()
                    .nth(content_indent)
                    .map_or(raw.len(), |(i, _)| i)..]
                    .to_string()
            } else {
                String::new()
            };
            b.lines.push(stripped);
            return true;
        }
        let finished = self.block.take().expect("block present");
        commit_block(finished, &mut self.pairs, &mut self.seen, self.warnings);
        false
    }

    /// Append a `- item` block-sequence element to the open sequence, so
    /// block-style `aliases:` / `tags:` round-trip exactly as the inline
    /// `[a, b]` form does. A `- item` with NO open sequence (a stray bullet)
    /// is parse-and-ignored with a warning. A bare `-` (empty element) is a
    /// no-op element.
    fn absorb_sequence_item(&mut self, line: &str) {
        let Some(seq) = self.pending_seq.as_mut() else {
            self.skipped_array += 1;
            return;
        };
        let item = strip_yaml_quotes(line.strip_prefix("- ").unwrap_or("").trim());
        if !item.is_empty() {
            seq.items.push(item.to_string());
        }
    }

    /// Parse one ordinary frontmatter line — a `key: value` scalar, a
    /// block-scalar header, a flow sequence/mapping, or the `key:` that opens
    /// a block sequence. `raw` is the untrimmed line, needed for the
    /// block-scalar key indent.
    fn parse_entry_line(&mut self, line: &str, raw: &str) {
        let Some((key_raw, value_raw)) = line.split_once(':') else {
            // No colon: not a `key: value` scalar (e.g. a stray scalar or
            // malformed line). Surface it rather than silently swallow.
            self.skipped_invalid += 1;
            return;
        };
        let key = key_raw.trim();
        if !is_property_key(key) {
            self.skipped_invalid += 1;
            return;
        }
        if FRONTMATTER_RESERVED_KEYS.contains(&key) {
            // Exporter-managed key — silently filtered (it is never meant
            // to round-trip as a user property).
            return;
        }
        let value_trimmed = value_raw.trim();
        // Block-scalar indicator (#1590): `key: |`, `key: >`, with optional
        // chomping (`-`/`+`) and/or a one-digit indentation indicator, e.g.
        // `|-`, `>+`, `|2`, `>2-`. The subsequent more-indented lines are the
        // value and must not be mis-counted as invalid. Open a block instead
        // of treating the (empty) inline value as a scalar.
        if let Some(spec) = parse_block_scalar_indicator(value_trimmed) {
            self.block = Some(BlockScalar {
                key: key.to_string(),
                folded: spec.folded,
                key_indent: frontmatter_indent_of(raw),
                content_indent: None,
                lines: Vec::new(),
            });
            return;
        }
        // Inline flow-sequence syntax (`[a, b]`) — #1917. The exporter writes
        // `aliases: [..]` / `tags: [..]` as YAML flow sequences, so dropping
        // them (the pre-fix behaviour) silently lost every exported alias/tag
        // on re-import. Committed exactly like a block-style sequence: the
        // items join into a single canonical scalar (`a, b`) — the SAME shape
        // a re-export of the resulting text property would emit — so the value
        // round-trips through the existing single-value property storage
        // (`set_property_in_tx` stamps one row per key; duplicate keys would
        // collapse under its INSERT-OR-REPLACE, so multiple pairs are NOT a
        // viable representation — one joined value is). A flow MAPPING
        // (`{a: b}`) has no single sensible scalar projection and stays
        // skipped-with-warning.
        if value_trimmed.starts_with('[') && value_trimmed.ends_with(']') {
            self.commit_seq(PendingSeq {
                key: key.to_string(),
                items: parse_flow_sequence_items(value_trimmed),
            });
            return;
        }
        if value_trimmed.starts_with('{') && value_trimmed.ends_with('}') {
            self.skipped_array += 1;
            return;
        }

        let value = strip_yaml_quotes(value_trimmed);
        // An empty inline value (`key:`) may be the header of a block-style
        // sequence whose `- item` elements follow on subsequent lines (#1917).
        // Open a pending sequence keyed on this line; `absorb_sequence_item`
        // appends to it, and the next non-sequence line (or end of input)
        // commits it. A `key:` with no following `- item` lines commits as an
        // empty scalar (unchanged behaviour).
        if value.is_empty() {
            self.pending_seq = Some(PendingSeq {
                key: key.to_string(),
                items: Vec::new(),
            });
            return;
        }
        if !self.seen.insert(key.to_string()) {
            self.warnings.push(format!(
                "frontmatter key '{key}' appears more than once; keeping the first value"
            ));
            return;
        }
        self.pairs.push((key.to_string(), value.to_string()));
    }

    /// Flush whatever is still open at end of input, append the aggregate
    /// skip warnings, and yield the parsed pairs.
    fn finish(mut self) -> Vec<(String, String)> {
        if let Some(b) = self.block.take() {
            commit_block(b, &mut self.pairs, &mut self.seen, self.warnings);
        }
        if let Some(seq) = self.pending_seq.take() {
            self.commit_seq(seq);
        }
        let (skipped_array, skipped_invalid) = (self.skipped_array, self.skipped_invalid);
        if skipped_array > 0 {
            self.warnings.push(format!(
                "{skipped_array} frontmatter line(s) used array/collection syntax \
                 (not yet supported) and were ignored"
            ));
        }
        if skipped_invalid > 0 {
            self.warnings.push(format!(
                "{skipped_invalid} frontmatter line(s) were not a valid `key: value` scalar \
                 and were ignored"
            ));
        }
        self.pairs
    }
}

/// Parse a leading YAML frontmatter block into page-property pairs (#1432).
///
/// This is a deliberately HAND-ROLLED parser over a fixed YAML *subset* — not
/// a general YAML implementation — chosen to avoid pulling in a YAML crate for
/// the narrow round-trip the exporter produces. The supported (parsed) grammar
/// is frozen as:
///   * top-level `key: value` scalars (split on the FIRST `:` only);
///   * single- or double-quoted scalar values (one matching layer stripped);
///   * inline flow sequences `key: [a, b]` (joined to a comma-separated
///     scalar; quoted items split on top-level commas only);
///   * block-style sequences (`key:` then `- item` lines, joined identically);
///   * block scalars `key: |` / `key: >` with optional chomping (`-`/`+`) and
///     a one-digit indent indicator (`|2`, `>2-`, …) — literal blocks join
///     with newlines, folded blocks with spaces.
///
/// Explicitly REJECTED shapes are parse-and-warn (counted, never crash, never
/// imported): stray block-sequence items `- item` with no owning `key:`,
/// inline flow MAPPINGS `{a: b}`, nested maps, and anchors/aliases (`&a`/`*a`,
/// which fail the `key: value` scalar test). Reserved/exporter-managed keys
/// (see [`FRONTMATTER_RESERVED_KEYS`]) are silently filtered. Duplicate keys
/// keep the FIRST value and warn.
fn parse_frontmatter(
    yaml: &str,
    list_items: &mut std::collections::HashMap<String, Vec<String>>,
    warnings: &mut Vec<String>,
) -> Vec<(String, String)> {
    let mut scan = FrontmatterScan::new(list_items, warnings);
    for raw in yaml.lines() {
        if scan.absorb_block_scalar_line(raw) {
            continue;
        }
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // A bare `- item` line is a YAML block-sequence element belonging to a
        // preceding `key:` with no inline value (#1917).
        if line.starts_with("- ") || line == "-" {
            scan.absorb_sequence_item(line);
            continue;
        }
        // Any non-sequence line ends an open block-style sequence: commit it
        // before processing this line as an ordinary frontmatter entry.
        if let Some(seq) = scan.pending_seq.take() {
            scan.commit_seq(seq);
        }
        scan.parse_entry_line(line, raw);
    }
    scan.finish()
}

/// Parsed YAML block-scalar header (#1590): the `|` / `>` indicator after a
/// `key:`, with optional chomping and indentation indicators.
struct BlockScalarSpec {
    /// `true` for a folded block (`>`); `false` for a literal block (`|`).
    folded: bool,
}

/// Recognise a YAML block-scalar indicator as the inline value of a `key:`
/// line. Accepts `|`, `>`, optionally followed (in either order, per the YAML
/// spec) by a chomping indicator (`-`/`+`) and/or a single indentation digit
/// (`1`–`9`), e.g. `|`, `>-`, `|+`, `|2`, `>2-`. A trailing line comment
/// (`# …`) is tolerated. Returns `None` for any other value (a normal scalar).
///
/// The chomping indicator is ACCEPTED (so `|-`/`>+`/`|2` still parse as block
/// scalars) but DISCARDED: the captured value is always joined without a
/// trailing newline, so clip/keep/strip would yield identical text — there is
/// nothing for the bool to influence.
fn parse_block_scalar_indicator(value: &str) -> Option<BlockScalarSpec> {
    // Drop a trailing comment so `| # literal block` still parses.
    let head = match value.split_once('#') {
        Some((before, _)) => before.trim_end(),
        None => value,
    };
    let mut chars = head.chars();
    let folded = match chars.next()? {
        '|' => false,
        '>' => true,
        _ => return None,
    };
    for c in chars {
        match c {
            '-' | '+' => {}   // chomping indicator — accepted, discarded
            '1'..='9' => {}   // explicit indentation indicator — accepted
            _ => return None, // anything else: not a block-scalar header
        }
    }
    Some(BlockScalarSpec { folded })
}

/// Strip a single layer of matching surrounding quotes from a frontmatter
/// scalar — defined in `commands::pages::markdown_yaml` so the
/// import-side parser and the export-side emitter share one definition (#1920,
/// the symmetric counterpart of `yaml_flow_item`'s quoting).
use agaric_core::text_utils::strip_yaml_quotes;

/// A Logseq block reference: `((` a uuid `))`. Its target is not in the
/// imported vault, so it is stripped; any other `((…))` is the user's text.
static LOGSEQ_BLOCK_REF_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\(\([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\)\)")
        .expect("invalid block-ref regex")
});

/// Strip each `((uuid))` block reference outside an inline code span, with the
/// one space its removal leaves doubled, and trim the line; other spacing is
/// the user's. Returns the text and how many references were removed (#1933),
/// which the import surfaces as an aggregate warning: the reference target is
/// dropped, so the strip must not be silent.
fn strip_block_refs_counted(text: &str) -> (String, usize) {
    if !text.contains("((") {
        return (text.trim().to_string(), 0);
    }
    let code_spans = inline_code_spans(text);
    let mut kept = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut removed = 0;
    for found in LOGSEQ_BLOCK_REF_RE.find_iter(text) {
        if code_spans
            .iter()
            .any(|&(start, end)| found.start() >= start && found.start() < end)
        {
            continue;
        }
        kept.push_str(&text[cursor..found.start()]);
        cursor = found.end();
        removed += 1;
        if kept.ends_with(' ') && text[cursor..].starts_with(' ') {
            cursor += 1;
        }
    }
    kept.push_str(&text[cursor..]);
    (kept.trim().to_string(), removed)
}

/// #2510 — matches a trailing Obsidian block-anchor marker: a `^` followed by
/// one-or-more `[A-Za-z0-9-]` characters (the issue's own grammar,
/// `^[A-Za-z0-9-]+`), separated from the preceding text by at least one space
/// (or standing alone, for a block whose content IS just the marker), anchored
/// to the ABSOLUTE END of the string so it only ever matches a genuine
/// trailing marker — never a mid-sentence caret (`x^2`, no preceding space) or
/// one followed by more text. This is deliberately NOT gated behind a
/// dialect flag (Logseq vs. Obsidian) — see [`strip_block_anchor_marker`]'s
/// doc comment for the accepted, documented false-positive tradeoff.
static OBSIDIAN_BLOCK_ANCHOR_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:^|\s)\^([A-Za-z0-9-]+)\s*$").expect("invalid block-anchor regex")
});

/// #2510 — split a trailing Obsidian block-anchor marker (`^block-id`) off an
/// already fully-assembled block content string. Returns `(content, None)`
/// unchanged when no marker is present at the absolute end of `content`, or
/// `(content_with_marker_and_its_leading_whitespace_removed, Some(id))`
/// (`id` WITHOUT the `^`) when one is found.
///
/// Pure / independently testable, mirroring `split_wikilink_anchor` in
/// `commands::pages::markdown`. Deliberately minimal, exactly like that
/// sibling helper: no dialect flag gates the strip (design decision deferred
/// per the #2510 issue notes — a dedicated "Import Obsidian vault" affordance
/// is a separate, larger follow-up), so a bare `some text ^tag`-style line in
/// Logseq / plain-Markdown content (rare, but legal outside Obsidian) is
/// ALSO stripped here — the same accepted tradeoff #1282 documents for a page
/// title that legitimately contains `#` (e.g. `[[C# Notes]]`).
fn strip_block_anchor_marker(content: &str) -> (String, Option<String>) {
    match strip_written_anchor_marker(content) {
        (stripped, Some(id)) => (stripped.trim_end().to_string(), Some(id)),
        unmarked => unmarked,
    }
}

/// [`strip_block_anchor_marker`] for a source buffer, which removes only the
/// matched separator and marker: the renderer wrote exactly one separator, so
/// whitespace the block itself ends with is content.
fn strip_written_anchor_marker(content: &str) -> (String, Option<String>) {
    match OBSIDIAN_BLOCK_ANCHOR_RE.captures(content) {
        Some(caps) => {
            let whole = caps.get(0).expect("group 0 always present");
            (
                content[..whole.start()].to_string(),
                Some(caps[1].to_string()),
            )
        }
        None => (content.to_string(), None),
    }
}

/// I-Core-10: matches the same alphabet that `op::validate_set_property`
/// enforces — `^[A-Za-z0-9_-]{1,64}$`. Used by the Logseq markdown property
/// parser to discriminate true `key:: value` lines from free-form content
/// that happens to contain `:: ` (URLs, narrative prose, etc.).
fn is_property_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// #2716 — `true` when `line` matches the `key:: value` property shape (a
/// `:: `-separated pair whose LHS is a valid [`is_property_key`]). Used by the
/// continuation-branch un-escape to recognise a property-shaped line the
/// exporter backslash-escaped, symmetric with the export-side
/// `markdown_yaml::content_line_is_ambiguous`.
fn line_is_property_shaped(line: &str) -> bool {
    line.split_once(":: ")
        .is_some_and(|(k, _)| is_property_key(k.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two Logseq block ids, the only `((…))` body an import strips.
    const UUID_A: &str = "7f3a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
    const UUID_B: &str = "650F0A1B-2C3D-4E5F-8091-A2B3C4D5E6F7";

    #[test]
    fn parse_simple_list() {
        let output = parse_logseq_markdown("- Block 1\n- Block 2");
        assert_eq!(output.blocks.len(), 2);
        assert_eq!(output.blocks[0].content, "Block 1");
        assert_eq!(output.blocks[0].depth, 0);
        assert_eq!(output.blocks[1].content, "Block 2");
        assert!(
            output.blocks.iter().all(|b| !b.is_code),
            "plain blocks must not be flagged as code"
        );
    }

    /// #1924 — a fenced ```` ``` ```` code region flags every block born
    /// inside it (and the delimiter-bearing blocks) as `is_code`, while blocks
    /// outside the fence stay non-code. This is the hook the inline-tag pre-pass
    /// uses to keep a `#tag` inside a code fence literal.
    #[test]
    fn parse_marks_fenced_blocks_as_code_1924() {
        // A bulleted fence: `- ```rust` opens, body + closing fence are
        // continuation lines that fold into the same block.
        let md = "- before\n- ```rust\n  let x = \"#notatag\";\n  ```\n- after";
        let output = parse_logseq_markdown(md);
        // before / fenced-bullet / after.
        assert_eq!(output.blocks.len(), 3, "blocks: {:?}", output.blocks);
        assert!(!output.blocks[0].is_code, "`before` is not code");
        assert!(
            output.blocks[1].is_code,
            "the ```` ``` ````-opened bullet (and its folded body) is code"
        );
        assert!(!output.blocks[2].is_code, "`after` is not code");
    }

    /// #1924 — a non-bulleted fence: the `#tag` text inside the fence is folded
    /// into the preceding block as a continuation line, and that block is
    /// flagged code, so the tag pre-pass will skip it.
    #[test]
    fn parse_bare_fence_marks_owning_block_code_1924() {
        let md = "- intro\n```\n#shouldstayliteral\n```";
        let output = parse_logseq_markdown(md);
        assert!(
            output.blocks.iter().any(|b| b.is_code),
            "a block covering the fenced region must be flagged code: {:?}",
            output.blocks
        );
    }

    /// #2866 (review follow-up) — a BARE (non-bulleted) fence opened at the
    /// very start of the document, before any block has been pushed, must
    /// not panic. The owner-depth computation falls back to
    /// `blocks.last().map(...).unwrap_or(depth)` specifically to cover this
    /// `blocks.is_empty()` case; a doc-starting unterminated bare fence must
    /// still parse into a single code block with no sibling recovery
    /// possible (no block exists yet to compare depth against).
    #[test]
    fn parse_doc_starting_bare_unterminated_fence_does_not_panic_2866() {
        let md = "```\nunclosed";
        let output = parse_logseq_markdown(md);

        assert_eq!(output.blocks.len(), 1, "got {:?}", output.blocks);
        assert_eq!(output.blocks[0].content, "```\nunclosed");
        assert!(output.blocks[0].is_code);
    }

    /// #2866 — an odd number of ```` ``` ```` delimiters inside a block (an
    /// unbalanced/unterminated fence) must NOT leave the importer's
    /// document-global [`FenceState`] open past the end of that block: the
    /// next sibling bullet must still spawn its own block instead of being
    /// folded into the never-closed fence. Mirrors the issue's repro shape
    /// (`["```\nunclosed", "normal"]`).
    #[test]
    fn parse_unbalanced_fence_does_not_swallow_sibling_block_2866() {
        let md = "- ```\n  unclosed\n- normal";
        let output = parse_logseq_markdown(md);

        assert_eq!(
            output.blocks.len(),
            2,
            "an unterminated fence must not bleed into the next sibling; got {:?}",
            output.blocks
        );
        assert_eq!(output.blocks[0].content, "```\nunclosed");
        assert!(
            output.blocks[0].is_code,
            "the unterminated-fence block itself is still code"
        );
        assert_eq!(output.blocks[1].content, "normal");
        assert!(
            !output.blocks[1].is_code,
            "the sibling after the unterminated fence must NOT be marked code: {:?}",
            output.blocks[1]
        );
    }

    /// #2866 (guard) — the fix for the unbalanced-fence case above must NOT
    /// regress #2725: a BALANCED fence containing `- `-prefixed lines still
    /// folds into a single code block, and a normal sibling bullet AFTER a
    /// properly-closed fence still spawns its own block as usual.
    #[test]
    fn parse_balanced_fence_with_list_lines_still_folds_and_sibling_still_spawns_2866() {
        let md = "- ```\n  - not a real bullet\n  ```\n- after";
        let output = parse_logseq_markdown(md);

        assert_eq!(
            output.blocks.len(),
            2,
            "a balanced fence stays one block, followed by its own sibling; got {:?}",
            output.blocks
        );
        assert_eq!(output.blocks[0].content, "```\n- not a real bullet\n```");
        assert!(output.blocks[0].is_code);
        assert_eq!(output.blocks[1].content, "after");
        assert!(!output.blocks[1].is_code);
    }

    /// #2866 (review follow-up, highest-risk case) — an interior `- `-prefixed
    /// line at the SAME depth as the fence-opening bullet, immediately
    /// followed by the closing delimiter, must still fold into ONE balanced
    /// code block instead of being mistaken for the #2866 sibling-recovery
    /// boundary. Without the unambiguous-bare-close peek this false-positives
    /// (splits the balanced fence into two blocks) because a same-depth
    /// bullet-shaped line is locally indistinguishable from a genuine
    /// never-closed-fence sibling.
    #[test]
    fn parse_balanced_fence_with_same_depth_interior_bullet_still_folds_2866() {
        let md = "- ```\n- interior\n```";
        let output = parse_logseq_markdown(md);

        assert_eq!(
            output.blocks.len(),
            1,
            "a balanced fence whose interior bullet-shaped line is immediately \
             followed by the closing delimiter must stay ONE block; got {:?}",
            output.blocks
        );
        assert_eq!(output.blocks[0].content, "```\n- interior\n```");
        assert!(output.blocks[0].is_code);
    }

    /// #2866 (review follow-up) — non-regression: two SEPARATE fenced code
    /// blocks as siblings (a very common real-document shape) must NOT be
    /// merged together just because the first sibling's `- ` bullet is
    /// immediately followed, several lines later, by ANOTHER bulleted fence
    /// delimiter that opens a brand-new sibling's own code block. A bulleted
    /// delimiter (`- ``` `) is ambiguous (unlike a bare ```` ``` ````) and
    /// must NOT be treated as an unambiguous close of the FIRST fence, or
    /// this would re-fold the original #2866 bug (the intervening sibling
    /// bullet bleeding into the first, never-closed fence).
    #[test]
    fn parse_two_sibling_code_blocks_stay_separate_2866() {
        let md = "- ```\n  unclosed\n- normal bullet\n- ```\n  another codeblock\n  ```";
        let output = parse_logseq_markdown(md);

        assert_eq!(
            output.blocks.len(),
            3,
            "an unterminated fence, a plain sibling, and a SEPARATE balanced \
             fence must remain three distinct blocks; got {:?}",
            output.blocks
        );
        assert_eq!(output.blocks[0].content, "```\nunclosed");
        assert!(output.blocks[0].is_code);
        assert_eq!(output.blocks[1].content, "normal bullet");
        assert!(!output.blocks[1].is_code);
        assert_eq!(output.blocks[2].content, "```\nanother codeblock\n```");
        assert!(output.blocks[2].is_code);
    }

    /// #2866 (review follow-up) — an unterminated fence opened at depth 2:
    /// a sibling bullet at the SAME depth (2) or SHALLOWER (1, an
    /// ancestor-level bullet) both correctly signal "we've left the owning
    /// block's scope" and recover (spawn their own block, not code). A
    /// bullet-shaped line DEEPER than the opener (3) is ambiguous — it could
    /// be a genuine child bullet or literal fence content — and the parser
    /// resolves that ambiguity by folding it into the still-open fence as
    /// code content, consistent with #2725's "prefer swallowing ambiguous
    /// content over guessing wrong" bias.
    #[test]
    fn parse_unterminated_fence_depth_boundary_variants_2866() {
        let equal = parse_logseq_markdown("    - ```\n      unclosed\n    - sibling");
        assert_eq!(equal.blocks.len(), 2, "equal depth: {:?}", equal.blocks);
        assert!(!equal.blocks[1].is_code);
        assert_eq!(equal.blocks[1].content, "sibling");

        let shallower = parse_logseq_markdown("    - ```\n      unclosed\n  - shallower");
        assert_eq!(
            shallower.blocks.len(),
            2,
            "shallower depth: {:?}",
            shallower.blocks
        );
        assert!(!shallower.blocks[1].is_code);
        assert_eq!(shallower.blocks[1].content, "shallower");

        let deeper = parse_logseq_markdown("    - ```\n      unclosed\n      - deeper");
        assert_eq!(
            deeper.blocks.len(),
            1,
            "deeper bullet under an unterminated fence is ambiguous and must \
             fold as code content, not spawn its own block: {:?}",
            deeper.blocks
        );
        assert!(deeper.blocks[0].is_code);
        assert_eq!(deeper.blocks[0].content, "```\nunclosed\n- deeper");
    }

    /// #2725 — a fenced code block whose body contains list-like (`- item`) and
    /// property-like (`key:: value`) lines must parse as ONE block: those lines
    /// are literal code content, folded into the fenced block (not split into
    /// new blocks / properties). The corrected fold is surfaced via a warning.
    #[test]
    fn parse_fenced_code_with_list_and_property_lines_stays_one_block_2725() {
        // The exact shape the exporter emits for a block whose content is a
        // fenced code sample: the opening fence is the bullet, the interior
        // list/property lines + closing fence are continuation lines.
        let md = "- ```\n  - not a real bullet\n  key:: not a real property\n  ```";
        let output = parse_logseq_markdown(md);

        assert_eq!(
            output.blocks.len(),
            1,
            "the whole fenced code block must be ONE block; got {:?}",
            output.blocks
        );
        let block = &output.blocks[0];
        assert!(block.is_code, "the fenced block must be flagged code");
        assert_eq!(
            block.content, "```\n- not a real bullet\nkey:: not a real property\n```",
            "interior list/property lines must survive verbatim inside the block content"
        );
        assert!(
            block.properties.is_empty(),
            "the `key:: value` line inside the fence must NOT become a property; got {:?}",
            block.properties
        );
        assert!(
            output
                .warnings
                .iter()
                .any(|w| w.contains("code fence") && w.contains("literal code")),
            "the fold must be surfaced via a warning; got {:?}",
            output.warnings
        );
    }

    /// #2716 — an INDENTED continuation line that is ALSO ambiguous (an indented
    /// bullet `  - sub`, a bare indented dash `  -`, or an indented property
    /// `  key:: v`) must have its exporter escape `\` STRIPPED, not leaked into
    /// content. The exporter anchors the `\` before the line's own indentation
    /// (wire form `  \  - sub`), so the un-escape matches the TRIMMED shape.
    /// (Interior indentation is separately normalised away by the importer's
    /// long-standing `strip_block_refs_counted` trim, exactly as it is for a
    /// non-ambiguous indented continuation line — the regression this pins is
    /// the SPURIOUS `\`, not the indent.)
    #[test]
    fn parse_unescapes_indented_ambiguous_continuation_2716() {
        // Wire form the exporter emits for a block whose content is
        // "intro\n  - sub" (cont-indent `  `, escape `\`, then the raw line).
        // The `\` must NOT survive; before the fix the folded line was
        // "\ - sub" (escape leaked, double space collapsed).
        let bullet = parse_logseq_markdown("- intro\n  \\  - sub");
        assert_eq!(bullet.blocks.len(), 1);
        assert_eq!(bullet.blocks[0].content, "intro\n- sub");
        assert!(!bullet.blocks[0].content.contains('\\'));

        // Indented bare dash.
        let dash = parse_logseq_markdown("- intro\n  \\  -");
        assert_eq!(dash.blocks.len(), 1);
        assert_eq!(dash.blocks[0].content, "intro\n-");

        // Indented property-shaped line stays literal content (NOT a property),
        // with no leaked `\`.
        let prop = parse_logseq_markdown("- intro\n  \\  key:: v");
        assert_eq!(prop.blocks.len(), 1);
        assert_eq!(prop.blocks[0].content, "intro\nkey:: v");
        assert!(prop.blocks[0].properties.is_empty());

        // A NON-ambiguous line that legitimately begins with `\` keeps its
        // backslash (no spurious un-escape).
        let latex = parse_logseq_markdown("- intro\n  \\alpha");
        assert_eq!(latex.blocks[0].content, "intro\n\\alpha");
    }

    #[test]
    fn parse_nested_list() {
        let output = parse_logseq_markdown("- Parent\n  - Child\n    - Grandchild");
        assert_eq!(output.blocks.len(), 3);
        assert_eq!(output.blocks[0].depth, 0);
        assert_eq!(output.blocks[1].depth, 1);
        assert_eq!(output.blocks[2].depth, 2);
    }

    #[test]
    fn parse_properties() {
        let output = parse_logseq_markdown("- Task\n  priority:: high");
        assert_eq!(output.blocks.len(), 1);
        assert_eq!(output.blocks[0].properties.len(), 1);
        assert_eq!(
            output.blocks[0].properties[0],
            ("priority".into(), "high".into())
        );
    }

    #[test]
    fn parse_skips_reserved_body_property_space_1568() {
        // #1568: a body bullet carrying a reserved/column-backed key
        // (`space::`) must be SKIPPED — never emitted as a block property —
        // mirroring the frontmatter filter. Emitting it would make
        // `set_property_in_tx` return a Validation error (`space` requires a
        // value_ref) that `?`-aborts the entire import chunk. The surrounding
        // good content and a non-reserved body property (`mykey::`) must still
        // import correctly.
        let md = "\
- A real note
  space:: MySpace
  mykey:: bar
- Another block";
        let output = parse_logseq_markdown(md);

        // Both content blocks survive.
        assert_eq!(output.blocks.len(), 2, "good content must be preserved");
        assert_eq!(output.blocks[0].content, "A real note");
        assert_eq!(output.blocks[1].content, "Another block");

        // The reserved `space` key is filtered out; only `mykey` remains.
        assert_eq!(
            output.blocks[0].properties,
            vec![("mykey".to_string(), "bar".to_string())],
            "reserved `space` must be skipped, non-reserved `mykey` kept"
        );
        assert!(
            !output.blocks[0]
                .properties
                .iter()
                .any(|(k, _)| k == "space"),
            "reserved `space` property must NOT be written"
        );

        // The skip is surfaced as a warning (mirrors orphan/clamp counters).
        assert!(
            output
                .warnings
                .iter()
                .any(|w| w.contains("reserved") && w.contains("skipped")),
            "skipped reserved property should be surfaced via warnings: {:?}",
            output.warnings
        );
    }

    #[test]
    fn parse_skips_multiple_reserved_body_properties_1568() {
        // A second reserved/exporter-managed key (`template`, a lifecycle
        // marker in `FRONTMATTER_RESERVED_KEYS`) is likewise skipped, while the
        // importable reserved date/state keys (`priority`) are preserved —
        // matching frontmatter semantics exactly.
        let md = "\
- Task
  space:: Work
  template:: t1
  priority:: high";
        let output = parse_logseq_markdown(md);

        assert_eq!(output.blocks.len(), 1);
        // `priority` is column-routable on import (typed args) and stays;
        // `space` and `template` are filtered.
        assert_eq!(
            output.blocks[0].properties,
            vec![("priority".to_string(), "high".to_string())],
            "only the importable reserved key survives; space/template filtered"
        );
    }

    #[test]
    fn parse_block_refs_stripped() {
        let output = parse_logseq_markdown(&format!("- See (({UUID_A})) here"));
        assert_eq!(output.blocks[0].content, "See here");
    }

    /// Only a Logseq `((uuid))` is a block ref: an inline code span and prose
    /// parentheses are text, and no space but the ref's own is collapsed.
    #[test]
    fn an_import_strips_only_a_logseq_uuid_ref_outside_code() {
        let output = parse_logseq_markdown(&format!(
            "- code `f((x))`  and ((inaudible)) then (({UUID_A})) end\n"
        ));
        assert_eq!(
            output.blocks[0].content,
            "code `f((x))`  and ((inaudible)) then end"
        );
        assert_eq!(
            output.warnings,
            [
                "1 ((block-ref)) reference(s) were stripped from imported content and could not \
              be preserved"
            ]
        );
    }

    /// An import keeps a fenced code line as written, less its bullet's
    /// indentation: no `((…))` strip and no space collapse, so an export of
    /// indented code imports byte for byte.
    #[test]
    fn an_import_keeps_fenced_code_lines_as_written() {
        let output = parse_logseq_markdown(
            "- script\n  ```python\n  if x:\n      y  =  1\n      print((a, b))\n  ```\n",
        );
        assert_eq!(output.blocks.len(), 1, "{:?}", output.blocks);
        assert_eq!(
            output.blocks[0].content,
            "script\n```python\nif x:\n    y  =  1\n    print((a, b))\n```"
        );
        assert!(output.warnings.is_empty(), "{:?}", output.warnings);
    }

    /// Code under a line of bare text, a README's shape, keeps its
    /// indentation too: that block's text starts at the line's own column.
    #[test]
    fn an_import_keeps_code_under_bare_text_as_written() {
        let output = parse_logseq_markdown("# Notes\n```yaml\na:\n  b: 1\n```\n");
        assert_eq!(output.blocks.len(), 1, "{:?}", output.blocks);
        assert_eq!(
            output.blocks[0].content,
            "# Notes\n```yaml\na:\n  b: 1\n```"
        );
    }

    /// #1933: block-ref stripping is a lossy transform and must surface an
    /// aggregate warning carrying the count of references dropped, mirroring
    /// the depth-clamp / orphan-property counters. The count covers list
    /// items, continuation lines, and bare content lines.
    #[test]
    fn parse_block_refs_stripped_counts_and_warns_1933() {
        let md = format!(
            "\
- See (({UUID_A})) and (({UUID_B})) here
  continuation with (({UUID_A}))
bare line (({UUID_B})) too"
        );
        let output = parse_logseq_markdown(&md);
        // Four refs total: two on the bullet, one on the continuation, one on
        // the bare content line.
        let warning = output
            .warnings
            .iter()
            .find(|w| w.contains("((block-ref))"))
            .unwrap_or_else(|| {
                panic!(
                    "a block-ref-stripped warning must be emitted; got {:?}",
                    output.warnings
                )
            });
        assert!(
            warning.contains("4 ((block-ref)) reference(s) were stripped"),
            "warning must carry the count of stripped refs; got {warning:?}"
        );
    }

    /// #1933: content with no block references must NOT emit a block-ref
    /// warning (the counter only fires on an actual lossy strip).
    #[test]
    fn parse_no_block_refs_no_warning_1933() {
        let output = parse_logseq_markdown("- A plain block\n- Another plain block");
        assert!(
            !output.warnings.iter().any(|w| w.contains("((block-ref))")),
            "no block-ref warning when nothing was stripped; got {:?}",
            output.warnings
        );
    }

    #[test]
    fn parse_empty_content() {
        let output = parse_logseq_markdown("");
        assert!(output.blocks.is_empty());
    }

    /// #2510 — `strip_block_anchor_marker` strips a TRAILING `^block-id`
    /// marker (Obsidian's block-anchor grammar) off already-assembled block
    /// content, requires the marker to be preceded by whitespace (or stand
    /// alone), and leaves ordinary content — including a mid-sentence caret
    /// with no preceding space — untouched.
    #[test]
    fn strip_block_anchor_marker_strips_trailing_marker_2510() {
        // No marker at all.
        assert_eq!(
            strip_block_anchor_marker("plain text"),
            ("plain text".to_string(), None)
        );
        // A trailing marker separated by one space.
        assert_eq!(
            strip_block_anchor_marker("Some block text ^block123"),
            ("Some block text".to_string(), Some("block123".to_string()))
        );
        // Hyphenated id (Obsidian allows `-` in a user-chosen block id).
        assert_eq!(
            strip_block_anchor_marker("Body ^my-block-id"),
            ("Body".to_string(), Some("my-block-id".to_string()))
        );
        // Multiple leading spaces before the marker collapse away too.
        assert_eq!(
            strip_block_anchor_marker("Body   ^b1"),
            ("Body".to_string(), Some("b1".to_string()))
        );
        // The marker is the WHOLE content (no preceding text).
        assert_eq!(
            strip_block_anchor_marker("^onlyanchor"),
            (String::new(), Some("onlyanchor".to_string()))
        );
        // A caret with NO preceding whitespace (`x^2`) is not a marker — the
        // `(?:^|\s)` alternative requires either start-of-string or a space.
        assert_eq!(
            strip_block_anchor_marker("compute x^2"),
            ("compute x^2".to_string(), None)
        );
        // A caret followed by more text is not a TRAILING marker.
        assert_eq!(
            strip_block_anchor_marker("see ^abc and more"),
            ("see ^abc and more".to_string(), None)
        );
        // Only the LAST `^token` at the absolute end counts; an earlier
        // mid-line caret survives untouched.
        assert_eq!(
            strip_block_anchor_marker("a ^b c ^final"),
            ("a ^b c".to_string(), Some("final".to_string()))
        );
    }

    /// #2510 — `parse_logseq_markdown` strips a bullet's trailing block-anchor
    /// marker into `ParsedBlock::block_anchor`, leaves a block with no marker
    /// at `None`, applies to a multi-line (#682 continuation) block only at
    /// its FINAL assembled line, and leaves a `^tag` inside a fenced sample
    /// literal.
    #[test]
    fn parse_logseq_markdown_extracts_block_anchor_2510() {
        let md = "\
- A block with an anchor ^my-anchor
- A block with no anchor
- A multi-line block
  continuation line ^cont-anchor
- ```
  code fence ending ^notananchor
  ```";
        let output = parse_logseq_markdown(md);

        assert_eq!(output.blocks[0].content, "A block with an anchor");
        assert_eq!(output.blocks[0].block_anchor, Some("my-anchor".to_string()));

        assert_eq!(output.blocks[1].content, "A block with no anchor");
        assert_eq!(output.blocks[1].block_anchor, None);

        assert_eq!(
            output.blocks[2].content,
            "A multi-line block\ncontinuation line"
        );
        assert_eq!(
            output.blocks[2].block_anchor,
            Some("cont-anchor".to_string())
        );

        // The fenced block is `is_code` and must NOT have its trailing
        // `^notananchor`-looking text stripped.
        let code_block = &output.blocks[3];
        assert!(code_block.is_code, "the fenced block must be flagged code");
        assert!(
            code_block.content.contains("^notananchor"),
            "a code block's trailing caret must survive untouched; got {:?}",
            code_block.content
        );
        assert_eq!(code_block.block_anchor, None);
    }

    /// A code block's anchor is read only from a line outside the fence, which
    /// is where the exporter puts it. On the closing fence itself, or inside a
    /// fence that never closes, a trailing `^id` is code.
    #[test]
    fn a_code_block_anchor_is_read_only_outside_the_fence() {
        let out = parse_logseq_markdown("- ```sh\n  echo hi\n  ```\n  ^abc");
        assert_eq!(out.blocks[0].content, "```sh\necho hi\n```");
        assert_eq!(out.blocks[0].block_anchor.as_deref(), Some("abc"));

        for md in ["- ```sh\n  echo hi\n  ``` ^abc", "- ```sh\n  echo hi ^abc"] {
            let out = parse_logseq_markdown(md);
            assert_eq!(out.blocks[0].block_anchor, None, "{md:?}");
            assert!(out.blocks[0].content.ends_with(" ^abc"), "{md:?}");
        }
    }

    /// `strip_block_refs_counted` trims the line, strips each `((uuid))` with
    /// the one space its removal doubles, and touches no other spacing.
    #[test]
    fn strip_block_refs_collapses_only_the_seam_a_strip_opens() {
        assert_eq!(
            strip_block_refs_counted("  plain text  "),
            ("plain text".to_string(), 0),
            "trim only"
        );
        assert_eq!(
            strip_block_refs_counted(&format!("a (({UUID_A})) b")),
            ("a b".to_string(), 1),
            "the seam keeps one space"
        );
        assert_eq!(
            strip_block_refs_counted("a    b   c"),
            ("a    b   c".to_string(), 0),
            "the user's spacing is kept"
        );
        assert_eq!(
            strip_block_refs_counted(&format!("x  (({UUID_A}))  y (({UUID_B})) z")),
            ("x   y z".to_string(), 2),
            "each seam loses one space, whatever the run around it"
        );
        assert_eq!(
            strip_block_refs_counted(&format!("(({UUID_A}))")),
            (String::new(), 1),
            "a bare ref line strips to empty"
        );
        assert_eq!(
            strip_block_refs_counted(&format!("`(({UUID_A}))` ((not a uuid)) x")),
            (format!("`(({UUID_A}))` ((not a uuid)) x"), 0),
            "a ref in an inline code span and a non-uuid body are text"
        );
    }

    #[test]
    fn parse_depth_clamped_at_max_import_depth() {
        // #1918 — the clamp target is MAX_BLOCK_DEPTH - 1 (19), not 20, so the
        // clamped block plus the page-root offset stays at-or-below the
        // create-path MAX_BLOCK_DEPTH bound.
        let deep = format!("{}- Deep block", "  ".repeat(25));
        let output = parse_logseq_markdown(&deep);
        assert_eq!(output.blocks[0].depth, MAX_IMPORT_DEPTH);
        assert_eq!(MAX_IMPORT_DEPTH, 19, "clamp must leave room for page root");
    }

    /// #1917 — a bare `-` (empty bullet, no trailing space) is its OWN empty
    /// block, not folded into the preceding block as a continuation line.
    #[test]
    fn parse_bare_dash_is_empty_block_not_continuation_1917() {
        let output = parse_logseq_markdown("- First\n-\n- Third");
        assert_eq!(
            output.blocks.len(),
            3,
            "bare `-` must spawn its own empty block; got {:?}",
            output.blocks
        );
        assert_eq!(output.blocks[0].content, "First");
        assert_eq!(output.blocks[1].content, "", "bare `-` block is empty");
        assert_eq!(output.blocks[2].content, "Third");
    }

    /// #1917 — a leading `# Heading` of genuine content followed by a
    /// `---…---` thematic-break pair that is NOT page frontmatter (no
    /// `key: value` scalars) must be preserved as content, not excised.
    #[test]
    fn import_thematic_break_after_heading_is_not_treated_as_frontmatter_1917() {
        let md = "# Real Heading\n\n---\njust a divider line\n---\n\n- Body block";
        let output = parse_logseq_markdown(md);
        // No frontmatter should have been parsed out of the divider section.
        assert!(
            output.frontmatter.is_empty(),
            "a thematic-break section must not be parsed as frontmatter; got {:?}",
            output.frontmatter
        );
        // The heading and divider text must survive as content blocks.
        let all: String = output
            .blocks
            .iter()
            .map(|b| b.content.as_str())
            .collect::<Vec<_>>()
            .join("|");
        assert!(
            all.contains("Real Heading") && all.contains("just a divider line"),
            "heading + divider content must be preserved; got blocks {:?}",
            output.blocks
        );
    }

    /// #1917 — the inverse: a real `# Title` + frontmatter fence (the Agaric
    /// export shape, with at least one `key: value`) IS still excised and
    /// parsed.
    #[test]
    fn import_real_frontmatter_after_heading_still_parsed_1917() {
        let md = "# My Page\n\n---\naliases: [Foo, Bar]\n---\n\n- Body";
        let output = parse_logseq_markdown(md);
        assert_eq!(
            output.frontmatter,
            vec![("aliases".to_string(), "Foo, Bar".to_string())],
            "a real frontmatter fence must still parse; got {:?}",
            output.frontmatter
        );
    }

    #[test]
    fn parse_tab_indentation_normalized() {
        let output = parse_logseq_markdown("- Parent\n\t- Child\n\t\t- Grandchild");
        assert_eq!(output.blocks.len(), 3);
        assert_eq!(output.blocks[0].depth, 0);
        assert_eq!(output.blocks[1].depth, 1);
        assert_eq!(output.blocks[2].depth, 2);
    }

    #[test]
    fn parse_yaml_frontmatter_stripped() {
        let output =
            parse_logseq_markdown("---\ntitle: Test Page\ntags: [a, b]\n---\n- Block 1\n- Block 2");
        assert_eq!(output.blocks.len(), 2);
        assert_eq!(output.blocks[0].content, "Block 1");
        assert_eq!(output.blocks[1].content, "Block 2");
    }

    #[test]
    fn parse_yaml_frontmatter_unclosed_treated_as_content() {
        let output = parse_logseq_markdown("---\n- This is content");
        // No closing ---, so the --- line is skipped (empty after trim)
        // and "- This is content" is parsed normally
        assert!(!output.blocks.is_empty());
    }

    /// I-Core-10: a non-list line containing `:: ` mid-sentence (e.g. a URL or
    /// narrative prose) must NOT be misclassified as a property line.  Pre-fix
    /// behaviour fed `https://example.com/foo :: bar` into `split_once(":: ")`
    /// and produced an arbitrary key/value pair attached to the previous
    /// block.  Post-fix the LHS must match `validate_set_property`'s alphabet
    /// (`^[A-Za-z0-9_-]{1,64}$`); otherwise the line falls through to the
    /// content-block branch.
    #[test]
    fn parse_url_bearing_line_is_content_not_property_i_core_10() {
        let output =
            parse_logseq_markdown("- Block 1\n  See https://example.com/foo :: bar for context");
        // #682: the indented free-form follow-up is a CONTINUATION of Block 1,
        // so it joins Block 1's content (single block) — but the key
        // invariant of I-Core-10 still holds: it must NOT become a property.
        assert_eq!(
            output.blocks.len(),
            1,
            "URL-bearing continuation line must join Block 1, not spawn a \
             block or become a property; got {:?}",
            output.blocks
        );
        assert!(
            output.blocks[0].properties.is_empty(),
            "Block 1 must have no properties; got {:?}",
            output.blocks[0].properties
        );
        assert!(
            output.blocks[0].content.contains("Block 1"),
            "original bullet text must survive; got {:?}",
            output.blocks[0].content
        );
        assert!(
            output.blocks[0].content.contains("https://example.com/foo"),
            "URL-bearing line must round-trip as content; got {:?}",
            output.blocks[0].content
        );
    }

    /// I-Core-10: prose-style `Some text :: notes` lines (no list prefix, no
    /// valid key alphabet) must also fall through to the content-block branch.
    #[test]
    fn parse_prose_with_double_colon_is_content_i_core_10() {
        let output = parse_logseq_markdown("- Parent\n  Some text :: notes :: more");
        // #682: indented prose joins Parent as a continuation line; the
        // I-Core-10 invariant (it must not be parsed as a property) holds.
        assert_eq!(
            output.blocks.len(),
            1,
            "free-form continuation line must join Parent, not spawn a block; got {:?}",
            output.blocks
        );
        assert!(
            output.blocks[0].properties.is_empty(),
            "Parent must have no properties; got {:?}",
            output.blocks[0].properties
        );
        assert_eq!(
            output.blocks[0].content, "Parent\nSome text :: notes :: more",
            "continuation text must be newline-joined onto Parent; got {:?}",
            output.blocks[0].content
        );
    }

    /// I-Core-10: keys longer than 64 chars are rejected by
    /// `validate_set_property` and must therefore also be rejected by the
    /// import discriminator (otherwise the import succeeds but the resulting
    /// `set_property` op fails downstream).
    #[test]
    fn parse_oversized_key_is_content_i_core_10() {
        let long_key = "a".repeat(65);
        let line = format!("- Parent\n  {long_key}:: value");
        let output = parse_logseq_markdown(&line);
        // #682: the oversized-key line is not a valid property, so it falls
        // through to the continuation branch and joins Parent (single block).
        assert_eq!(
            output.blocks.len(),
            1,
            "oversized key must become content (joined as continuation)"
        );
        assert!(
            output.blocks[0].properties.is_empty(),
            "Parent must have no property when key is >64 chars"
        );
        assert!(
            output.blocks[0].content.contains(&long_key),
            "oversized-key text must round-trip as continuation content"
        );
    }

    /// I-Core-10: regression coverage that the canonical `key:: value` shape
    /// (the one `parse_properties` already exercises) still works after the
    /// stricter discriminator.  All three keys here match the post-fix
    /// alphabet.
    #[test]
    fn parse_property_canonical_shape_still_works_i_core_10() {
        let output = parse_logseq_markdown(
            "- Task\n  priority:: high\n  due:: 2025-01-01\n  my_key-1:: anything",
        );
        assert_eq!(output.blocks.len(), 1);
        assert_eq!(output.blocks[0].properties.len(), 3);
        assert_eq!(
            output.blocks[0].properties[0],
            ("priority".into(), "high".into())
        );
        assert_eq!(
            output.blocks[0].properties[1],
            ("due".into(), "2025-01-01".into())
        );
        assert_eq!(
            output.blocks[0].properties[2],
            ("my_key-1".into(), "anything".into())
        );
    }

    /// #682: an indented non-bullet line following a bullet is a continuation
    /// of that bullet's body and must JOIN the same block (newline-joined),
    /// not be split into a separate block.
    #[test]
    fn parse_continuation_line_joins_bullet_682() {
        let output = parse_logseq_markdown("- First line of bullet\n  second line of same bullet");
        assert_eq!(
            output.blocks.len(),
            1,
            "continuation line must join the bullet, not spawn a new block; got {:?}",
            output.blocks
        );
        assert_eq!(
            output.blocks[0].content,
            "First line of bullet\nsecond line of same bullet"
        );
        assert_eq!(output.blocks[0].depth, 0);
    }

    /// #682: multiple continuation lines all join the one owning bullet, and a
    /// following bullet starts a fresh block.
    #[test]
    fn parse_multiple_continuation_lines_join_then_next_bullet_682() {
        let output =
            parse_logseq_markdown("- Bullet A\n  cont one\n  cont two\n- Bullet B\n  cont three");
        assert_eq!(output.blocks.len(), 2, "got {:?}", output.blocks);
        assert_eq!(output.blocks[0].content, "Bullet A\ncont one\ncont two");
        assert_eq!(output.blocks[1].content, "Bullet B\ncont three");
    }

    /// #682: a `key:: value` line nested under a grandchild must attach to the
    /// block that indentation says owns it (the nearest preceding block at or
    /// above the property's depth), NOT to the most-recently-pushed block.
    #[test]
    fn parse_nested_property_attaches_to_indentation_owner_682() {
        // Parent(0) > Child(1) > Grandchild(2), then a property indented at
        // depth 1 (`    ` = 4 spaces under Grandchild's body would own
        // Grandchild; here we indent at depth 1 so the Child owns it). Then a
        // later sibling Child2 must NOT receive it.
        let output = parse_logseq_markdown(
            "- Parent\n  - Child\n    - Grandchild\n    owner:: gc\n  - Child2",
        );
        // 4 bullets, no extra blocks (the property line is not a block).
        assert_eq!(output.blocks.len(), 4, "got {:?}", output.blocks);
        assert_eq!(output.blocks[0].content, "Parent");
        assert_eq!(output.blocks[1].content, "Child");
        assert_eq!(output.blocks[2].content, "Grandchild");
        assert_eq!(output.blocks[3].content, "Child2");
        // The property at depth 2 (`    ` = 4 spaces) owns the nearest block
        // with depth <= 2, which is Grandchild (depth 2) — NOT Child2.
        assert_eq!(
            output.blocks[2].properties,
            vec![("owner".to_string(), "gc".to_string())],
            "property must attach to the indentation owner (Grandchild); got {:?}",
            output.blocks,
        );
        assert!(
            output.blocks[3].properties.is_empty(),
            "later sibling Child2 must NOT receive the nested property; got {:?}",
            output.blocks[3].properties,
        );
    }

    /// #682: a property indented at a parent's level attaches to the parent,
    /// not to a deeper-but-more-recent descendant. This is the precise
    /// "attach by recency vs indentation" regression: before the fix the
    /// property would land on the most-recently-pushed (deeper) block.
    #[test]
    fn parse_property_attaches_to_shallow_owner_not_recent_deep_682() {
        // Parent(0) > Child(1), then a property at depth 0 must own Parent,
        // even though Child was pushed most recently.
        let output = parse_logseq_markdown("- Parent\n  - Child\nstatus:: done");
        assert_eq!(output.blocks.len(), 2, "got {:?}", output.blocks);
        assert_eq!(
            output.blocks[0].properties,
            vec![("status".to_string(), "done".to_string())],
            "depth-0 property must attach to Parent; got {:?}",
            output.blocks,
        );
        assert!(
            output.blocks[1].properties.is_empty(),
            "Child must NOT receive the depth-0 property; got {:?}",
            output.blocks[1].properties,
        );
    }

    /// #682: a property line with no preceding block at or above its
    /// indentation is dropped and surfaced via a warning counter (mirroring
    /// the depth-clamp warning).
    #[test]
    fn parse_orphan_property_before_any_block_warns_682() {
        let output = parse_logseq_markdown("orphan:: value\n- First bullet");
        // "orphan:: value" is a valid property shape but has no preceding
        // block, so it is dropped (not turned into a block) and warned about.
        assert_eq!(output.blocks.len(), 1, "got {:?}", output.blocks);
        assert_eq!(output.blocks[0].content, "First bullet");
        assert!(
            output.blocks[0].properties.is_empty(),
            "the orphan property must not leak onto a later block; got {:?}",
            output.blocks[0].properties,
        );
        assert!(
            output
                .warnings
                .iter()
                .any(|w| w.contains("property line(s) had no owning block")),
            "an orphan-property warning must be emitted; got {:?}",
            output.warnings,
        );
    }

    // ------------------------------------------------------------------
    // #1432 — direct unit tests for `parse_frontmatter` / `strip_frontmatter`
    // (the line-based YAML scalar parser + the two-position fence excisor).
    // These exercise the helpers directly rather than through the whole
    // `parse_logseq_markdown` pipeline, pinning the edge cases the round-trip
    // tests don't reach.
    // ------------------------------------------------------------------

    /// The fence may appear immediately after a leading `# Heading` line
    /// (Agaric's own export shape). The heading must survive in the body and
    /// the fenced scalars must be parsed out.
    #[test]
    fn strip_frontmatter_after_heading_excises_fence_keeps_heading_1432() {
        let mut fm: Vec<(String, String)> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let mut warns: Vec<String> = Vec::new();
        let body = strip_frontmatter(
            "# My Title\n\n---\ncategory: notes\n---\n\n- body\n",
            &mut fm,
            &mut list_items,
            &mut warns,
        );
        assert_eq!(fm, vec![("category".to_string(), "notes".to_string())]);
        assert!(
            body.starts_with("# My Title"),
            "heading line must be preserved in the body; got {body:?}"
        );
        assert!(
            body.contains("- body"),
            "post-fence body must survive; got {body:?}"
        );
        assert!(
            !body.contains("category:"),
            "the fenced frontmatter must be excised from the body; got {body:?}"
        );
    }

    /// A value containing a colon (URL, `HH:MM` time, …) must split on the
    /// FIRST `:` only — the rest of the value (further colons included) is
    /// kept verbatim.
    #[test]
    fn parse_frontmatter_value_with_colon_splits_on_first_only_1432() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter(
            "homepage: https://example.com/path\nstart: 09:00",
            &mut list_items,
            &mut warns,
        );
        assert_eq!(
            pairs,
            vec![
                (
                    "homepage".to_string(),
                    "https://example.com/path".to_string()
                ),
                ("start".to_string(), "09:00".to_string()),
            ],
            "value colons must be preserved (split on first `:` only); got {pairs:?}"
        );
        assert!(
            warns.is_empty(),
            "valid scalars must not warn; got {warns:?}"
        );
    }

    /// A single layer of matching surrounding quotes is stripped from the
    /// value (both `"…"` and `'…'`).
    #[test]
    fn parse_frontmatter_quoted_value_is_unquoted_1432() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter(
            "title: \"Quoted Value\"\nalias: 'single quoted'",
            &mut list_items,
            &mut warns,
        );
        assert_eq!(
            pairs,
            vec![
                ("title".to_string(), "Quoted Value".to_string()),
                ("alias".to_string(), "single quoted".to_string()),
            ],
            "a single layer of matching quotes must be stripped; got {pairs:?}"
        );
    }

    /// An unclosed `---` fence is treated as plain content: no frontmatter is
    /// parsed and the input body is returned unchanged.
    #[test]
    fn strip_frontmatter_unclosed_fence_is_content_1432() {
        let mut fm: Vec<(String, String)> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let mut warns: Vec<String> = Vec::new();
        let input = "---\ncategory: notes\n- a bullet with no closing fence";
        let body = strip_frontmatter(input, &mut fm, &mut list_items, &mut warns);
        assert!(
            fm.is_empty(),
            "an unclosed fence must yield no frontmatter; got {fm:?}"
        );
        assert_eq!(
            body, input,
            "an unclosed fence must return the input unchanged; got {body:?}"
        );
    }

    /// An inline array value (`tags: [a, b]`) is parse-and-ignored (#1433
    /// scope) with a warning — it must NOT be imported as a literal text
    /// scalar, and must not crash.
    /// #1917 — inline flow sequences (`[a, b]`) are now PRESERVED as a single
    /// comma-joined scalar (the exporter writes `aliases`/`tags` as flow
    /// sequences, so dropping them lost every exported alias/tag on re-import).
    /// A flow MAPPING (`{..}`) has no scalar projection and stays
    /// skipped-with-warning.
    #[test]
    fn parse_frontmatter_flow_sequence_is_preserved_as_joined_scalar_1917() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter("tags: [a, b]\ncategory: notes", &mut list_items, &mut warns);
        assert_eq!(
            pairs,
            vec![
                ("tags".to_string(), "a, b".to_string()),
                ("category".to_string(), "notes".to_string()),
            ],
            "a flow sequence must be preserved as a comma-joined scalar; got {pairs:?}"
        );
        assert_eq!(
            list_items.get("tags"),
            Some(&vec!["a".to_string(), "b".to_string()]),
            "the real item boundaries must also be recorded; got {list_items:?}"
        );
        assert!(
            warns.is_empty(),
            "preserving a flow sequence must not warn; got {warns:?}"
        );
    }

    /// #1917 — a flow sequence whose items are quoted (and contain a comma
    /// inside the quotes) is split only on top-level commas and unquoted.
    /// #2829 — the REAL (unjoined) item boundaries are recorded in
    /// `list_items`, so a quoted item's inner comma (`"Beta, Inc"`) is
    /// distinguishable from two separate items even though the legacy
    /// `pairs` scalar joins them identically.
    #[test]
    fn parse_frontmatter_flow_sequence_quoted_items_split_top_level_only_1917() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter(
            r#"aliases: [Alpha, "Beta, Inc", Gamma]"#,
            &mut list_items,
            &mut warns,
        );
        assert_eq!(
            pairs,
            vec![("aliases".to_string(), "Alpha, Beta, Inc, Gamma".to_string())],
            "quoted items must not split on their inner comma; got {pairs:?}"
        );
        assert_eq!(
            list_items.get("aliases"),
            Some(&vec![
                "Alpha".to_string(),
                "Beta, Inc".to_string(),
                "Gamma".to_string(),
            ]),
            "list_items must preserve the 3 REAL items, quoted comma intact; got {list_items:?}"
        );
    }

    /// #1917 — block-style sequences (`key:` then `- item` lines) round-trip
    /// identically to the inline flow form.
    #[test]
    fn parse_frontmatter_block_sequence_is_preserved_as_joined_scalar_1917() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter(
            "aliases:\n  - First\n  - Second\ncategory: notes",
            &mut list_items,
            &mut warns,
        );
        assert_eq!(
            pairs,
            vec![
                ("aliases".to_string(), "First, Second".to_string()),
                ("category".to_string(), "notes".to_string()),
            ],
            "a block-style sequence must be preserved as a comma-joined scalar; got {pairs:?}"
        );
        assert_eq!(
            list_items.get("aliases"),
            Some(&vec!["First".to_string(), "Second".to_string()]),
            "block-style sequence items must also be recorded; got {list_items:?}"
        );
        assert!(
            warns.is_empty(),
            "preserving a block sequence must not warn; got {warns:?}"
        );
    }

    /// #1917 — a flow MAPPING (`{a: b}`) is still skipped with a warning (no
    /// sensible scalar projection).
    #[test]
    fn parse_frontmatter_flow_mapping_is_ignored_with_warning_1917() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter("meta: {a: 1}\ncategory: notes", &mut list_items, &mut warns);
        assert_eq!(
            pairs,
            vec![("category".to_string(), "notes".to_string())],
            "a flow mapping must be ignored; only the scalar survives; got {pairs:?}"
        );
        assert!(
            warns.iter().any(|w| w.contains("array/collection syntax")),
            "a mapping-syntax warning must be emitted; got {warns:?}"
        );
    }

    /// #1590 — a `key: |` literal block scalar with indented continuation
    /// lines parses without incrementing `skipped_invalid`, and the joined
    /// (newline-separated) value is captured.
    #[test]
    fn parse_frontmatter_literal_block_scalar_captured_no_invalid_1590() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter(
            "summary: |\n  first line\n  second line\ncategory: notes",
            &mut list_items,
            &mut warns,
        );
        assert_eq!(
            pairs,
            vec![
                ("summary".to_string(), "first line\nsecond line".to_string()),
                ("category".to_string(), "notes".to_string()),
            ],
            "a literal block scalar must be captured (newline-joined) and the \
             trailing scalar must still parse; got {pairs:?}"
        );
        assert!(
            warns.is_empty(),
            "block-scalar continuations must not warn as invalid; got {warns:?}"
        );
    }

    /// #1590 — a `key: >` folded block scalar joins continuation lines with
    /// spaces and does not warn.
    #[test]
    fn parse_frontmatter_folded_block_scalar_captured_no_invalid_1590() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter(
            "desc: >\n  one\n  two\n  three",
            &mut list_items,
            &mut warns,
        );
        assert_eq!(
            pairs,
            vec![("desc".to_string(), "one two three".to_string())],
            "a folded block scalar must be space-joined; got {pairs:?}"
        );
        assert!(
            warns.is_empty(),
            "folded block-scalar continuations must not warn; got {warns:?}"
        );
    }

    /// #1590 — chomping indicators (`|-`, `>+`) on the block header are
    /// accepted: the continuation lines are still consumed without warning.
    #[test]
    fn parse_frontmatter_block_scalar_chomping_indicators_1590() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter(
            "lit: |-\n  alpha\n  beta\nfold: >+\n  gamma\n  delta",
            &mut list_items,
            &mut warns,
        );
        assert_eq!(
            pairs,
            vec![
                ("lit".to_string(), "alpha\nbeta".to_string()),
                ("fold".to_string(), "gamma delta".to_string()),
            ],
            "chomping indicators must be parsed and the blocks captured; got {pairs:?}"
        );
        assert!(
            warns.is_empty(),
            "chomping-indicator block scalars must not warn; got {warns:?}"
        );
    }

    /// #1590 — a genuinely invalid line (non-indented, no colon, not a
    /// continuation of any block) is STILL counted as `skipped_invalid` and
    /// surfaced via the aggregate warning.
    #[test]
    fn parse_frontmatter_invalid_non_indented_line_still_warns_1590() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter(
            "category: notes\nthis is not yaml",
            &mut list_items,
            &mut warns,
        );
        assert_eq!(
            pairs,
            vec![("category".to_string(), "notes".to_string())],
            "the scalar must parse; the stray line must be dropped; got {pairs:?}"
        );
        assert!(
            warns
                .iter()
                .any(|w| w.contains("were not a valid `key: value` scalar")),
            "a non-indented no-colon line must still be counted invalid; got {warns:?}"
        );
    }

    /// #1590 — normal `key: value` scalars are unaffected by the block-scalar
    /// handling (no false block detection, no warnings).
    #[test]
    fn parse_frontmatter_plain_scalars_unaffected_by_block_handling_1590() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter("title: Hello\nstatus: draft", &mut list_items, &mut warns);
        assert_eq!(
            pairs,
            vec![
                ("title".to_string(), "Hello".to_string()),
                ("status".to_string(), "draft".to_string()),
            ],
            "plain scalars must be unaffected; got {pairs:?}"
        );
        assert!(
            warns.is_empty(),
            "plain scalars must not warn; got {warns:?}"
        );
    }

    #[test]
    fn parse_depth_clamping_emits_warning() {
        // Build markdown with 3 blocks exceeding depth 20
        let mut lines = vec!["- Root".to_string()];
        for i in 0..3 {
            lines.push(format!("{}- Deep block {i}", "  ".repeat(25)));
        }
        let content = lines.join("\n");
        let output = parse_logseq_markdown(&content);

        // All deep blocks should be clamped to MAX_IMPORT_DEPTH (#1918: 19)
        for block in &output.blocks[1..] {
            assert_eq!(
                block.depth, MAX_IMPORT_DEPTH,
                "block depth should be clamped to MAX_IMPORT_DEPTH"
            );
        }

        // Warnings should contain a depth-clamping message
        assert_eq!(output.warnings.len(), 1, "should have exactly one warning");
        assert!(
            output.warnings[0].contains(&format!(
                "3 block(s) exceeded maximum depth of {MAX_IMPORT_DEPTH} and were flattened"
            )),
            "warning message should describe clamped blocks, got: {}",
            output.warnings[0]
        );
    }

    // ------------------------------------------------------------------
    // #1922 — additive coverage for previously-untested import-path
    // behaviors. These PIN current behavior (no production change); a
    // regression that alters them now fails CI.
    // ------------------------------------------------------------------

    /// #1922 (`no-frontmatter-duplicate-key-warning-test`) — the SCALAR
    /// de-dup path: a repeated plain-scalar key keeps the FIRST value and
    /// emits an "appears more than once" warning (import.rs scalar path).
    #[test]
    fn parse_frontmatter_duplicate_scalar_key_keeps_first_and_warns_1922() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter("title: A\ntitle: B", &mut list_items, &mut warns);
        assert_eq!(
            pairs,
            vec![("title".to_string(), "A".to_string())],
            "a duplicate scalar key must keep the FIRST value; got {pairs:?}"
        );
        assert_eq!(
            warns.len(),
            1,
            "exactly one duplicate-key warning expected; got {warns:?}"
        );
        assert!(
            warns[0].contains("appears more than once")
                && warns[0].contains("keeping the first value"),
            "warning must name the keep-first de-dup semantics; got {warns:?}"
        );
    }

    /// #1922 (`no-frontmatter-duplicate-key-warning-test`) — the
    /// BLOCK-SCALAR de-dup path (`commit_block!`): a duplicate block-scalar
    /// key (`note: |` twice) keeps the first captured value and warns.
    #[test]
    fn parse_frontmatter_duplicate_block_scalar_key_keeps_first_and_warns_1922() {
        let mut warns: Vec<String> = Vec::new();
        let mut list_items: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        let pairs = parse_frontmatter("note: |\n  x\nnote: |\n  y", &mut list_items, &mut warns);
        assert_eq!(
            pairs,
            vec![("note".to_string(), "x".to_string())],
            "a duplicate block-scalar key must keep the FIRST captured value; got {pairs:?}"
        );
        assert_eq!(
            warns.len(),
            1,
            "exactly one duplicate-key warning expected; got {warns:?}"
        );
        assert!(
            warns[0].contains("appears more than once")
                && warns[0].contains("keeping the first value"),
            "block-scalar duplicate must warn with keep-first semantics; got {warns:?}"
        );
    }

    /// #1922 (`no-direct-helper-unit-tests`) — `parse_block_scalar_indicator`
    /// edge cases asserted at the HELPER level (the existing _1590 tests only
    /// hit it indirectly): folded vs literal flag, the indent-digit form
    /// (`|2`), order-independence (`>2-`), trailing-comment tolerance
    /// (`| # literal`), and rejection of non-block-scalar values. #1920 — the
    /// chomping indicator is still ACCEPTED (`|-`/`>+`/`>2-` parse) but no
    /// longer stored, so we assert acceptance via `Some(..)`, not a bool.
    #[test]
    fn parse_block_scalar_indicator_edge_cases_1922() {
        // Literal `|` -> folded == false.
        let lit = parse_block_scalar_indicator("|").expect("`|` is a block scalar");
        assert!(!lit.folded, "`|` is literal (not folded)");
        // Folded `>` -> folded == true.
        let fold = parse_block_scalar_indicator(">").expect("`>` is a block scalar");
        assert!(fold.folded, "`>` is folded");
        // Strip chomping `|-` -> still accepted, literal.
        let strip = parse_block_scalar_indicator("|-").expect("`|-` is a block scalar");
        assert!(!strip.folded);
        // Keep chomping `>+` -> still accepted, folded.
        let keep = parse_block_scalar_indicator(">+").expect("`>+` is a block scalar");
        assert!(keep.folded);
        // Indent digit `|2` -> accepted, literal.
        let indent = parse_block_scalar_indicator("|2").expect("`|2` is a block scalar");
        assert!(!indent.folded);
        // Order-independent `>2-` -> still accepted, folded.
        let mixed = parse_block_scalar_indicator(">2-").expect("`>2-` is a block scalar");
        assert!(mixed.folded);
        // Trailing comment tolerated: `| # literal block`.
        let commented =
            parse_block_scalar_indicator("| # literal block").expect("trailing comment tolerated");
        assert!(!commented.folded);
        // Rejections: not a block-scalar header -> None.
        assert!(
            parse_block_scalar_indicator("x").is_none(),
            "`x` is a plain scalar, not a block header"
        );
        assert!(
            parse_block_scalar_indicator("|x").is_none(),
            "`|x` carries garbage after the indicator"
        );
        assert!(
            parse_block_scalar_indicator("||").is_none(),
            "`||` is not a valid block-scalar header"
        );
        assert!(
            parse_block_scalar_indicator("").is_none(),
            "an empty value is not a block-scalar header"
        );
    }

    // ── insta snapshot tests — import output shapes (#3459) ──────────────
    //
    // WHY: `parse_logseq_markdown` returns a wide, nested structure, and the
    // ~60 tests above each pin one or two fields of one or two elements of
    // it (`output.blocks[1].content`, `output.warnings.len()`). That is
    // exactly the shape where a change lands unnoticed: a new `ParsedBlock`
    // field, a re-ordered warning, a block boundary that moves by one line —
    // all leave every existing assertion green. The snapshots below make the
    // WHOLE parse product the assertion, for three representative documents.
    //
    // EXHAUSTIVENESS: the mirrors below destructure `ParseOutput`,
    // `ParsedBlock` and `AttachmentRef` WITHOUT a `..` rest pattern, so
    // adding a field to any of them fails to COMPILE here rather than
    // silently escaping the snapshot. If a build breaks on one of these,
    // add the field to the mirror — do not add `..`.
    //
    // DETERMINISM: `frontmatter_list_items` is a `HashMap`, whose iteration
    // order is not stable, so it is collected into a `BTreeMap` before
    // snapshotting. Everything else is a literal drawn from the input
    // document — no timestamps, ULIDs or hashes — so nothing needs
    // redacting.

    /// Serializable mirror of [`ParseOutput`]. See the module note above on
    /// why this destructures exhaustively and sorts the `HashMap`.
    fn parse_output_shape(md: &str) -> serde_json::Value {
        let ParseOutput {
            blocks,
            frontmatter,
            frontmatter_list_items,
            warnings,
        } = parse_logseq_markdown(md);
        let blocks: Vec<serde_json::Value> = blocks
            .into_iter()
            .map(|block| {
                let ParsedBlock {
                    content,
                    depth,
                    properties,
                    is_code,
                    block_anchor,
                } = block;
                serde_json::json!({
                    "content": content,
                    "depth": depth,
                    "properties": properties,
                    "is_code": is_code,
                    "block_anchor": block_anchor,
                })
            })
            .collect();
        let frontmatter_list_items: std::collections::BTreeMap<String, Vec<String>> =
            frontmatter_list_items.into_iter().collect();
        serde_json::json!({
            "blocks": blocks,
            "frontmatter": frontmatter,
            "frontmatter_list_items": frontmatter_list_items,
            "warnings": warnings,
        })
    }

    /// A well-formed multi-block document: YAML frontmatter carrying both a
    /// plain scalar and a flow sequence, three levels of nesting, a block
    /// property, a trailing Obsidian `^anchor` marker, and a fenced code
    /// region. Pins the block segmentation, the depths, where the property
    /// attaches, and which blocks are flagged `is_code`.
    #[test]
    fn snapshot_parse_output_multi_block_document() {
        let md = concat!(
            "---\n",
            "title: Quarterly Review\n",
            "aliases: [Q3, \"Review, Q3\"]\n",
            "---\n",
            "- Top level block\n",
            "  status:: open\n",
            "  - Nested child\n",
            "    - Grandchild ^anchor-1\n",
            "- ```rust\n",
            "  let tag = \"#notatag\";\n",
            "  ```\n",
            "- Trailing block\n",
        );
        insta::assert_yaml_snapshot!(parse_output_shape(md));
    }

    /// Malformed / partial input — the case a hand-written assertion tends
    /// to under-specify because the interesting output is the WARNING list
    /// and the salvaged blocks, not one field. An unclosed frontmatter
    /// fence (must survive as content rather than be excised), a bare `-`
    /// empty bullet, and nesting past `MAX_IMPORT_DEPTH` (clamped, with a
    /// warning). Pins both what survives and what the user is told.
    #[test]
    fn snapshot_parse_output_malformed_input() {
        let md = format!(
            "---\ntitle: Never closed\n- First\n-\n{}- Way too deep\n",
            "  ".repeat(25)
        );
        insta::assert_yaml_snapshot!(parse_output_shape(&md));
    }

    /// The attachment side of an import: [`detect_attachment_refs`] over a
    /// document mixing a markdown image, an Obsidian embed, an
    /// inline-code-quoted ref (skipped), an empty-alt image, a remote URL
    /// and an already-canonical `attachment:` ref. `full_match` is what the
    /// rewrite pass replaces byte-for-byte, so its exact spelling — and
    /// which refs are omitted entirely — is the contract.
    ///
    /// The pinned ORDER is scan order, not source order: `detect_attachment_refs`
    /// runs the Obsidian-embed scan to completion before the markdown-image
    /// scan and never sorts, so the `![[embedded.pdf]]` embed leads even
    /// though `![diagram](…)` appears first in the document. Its docstring
    /// says "returns the refs in source order", which this snapshot shows is
    /// only true for single-syntax documents. Pinned as observed behaviour —
    /// if the ordering is later made genuinely source-ordered, this snapshot
    /// is the place that says so out loud.
    #[test]
    fn snapshot_detect_attachment_refs_document() {
        let content = concat!(
            "![diagram](assets/diagram.png) and ![[embedded.pdf]] ",
            "plus `![incode](assets/skip.png)` and ",
            "![](assets/no-alt.jpg) and ![remote](https://example.com/x.png) ",
            "and ![done](attachment:already-canonical)"
        );
        let refs: Vec<serde_json::Value> =
            detect_attachment_refs(content, &inline_code_spans(content))
                .into_iter()
                .map(|r| {
                    let AttachmentRef {
                        alt,
                        original_ref,
                        full_match,
                    } = r;
                    serde_json::json!({
                        "alt": alt,
                        "original_ref": original_ref,
                        "full_match": full_match,
                    })
                })
                .collect();
        insta::assert_yaml_snapshot!(refs);
    }

    /// The [`ImportResult`] IPC envelope. `ImportResult` is `Serialize +
    /// Type`: it is the value the import command returns to the frontend,
    /// which renders `page_title` in the completion toast and `warnings` in
    /// the lossy-import list. A renamed or retyped field here is a breaking
    /// frontend change, not a formatting change — re-blessing this snapshot
    /// means the TypeScript side (`bindings.ts` and its consumers) has to
    /// move in the same PR.
    #[test]
    fn snapshot_import_result_wire_shape() {
        let result = ImportResult {
            page_title: "Quarterly Review".into(),
            blocks_created: 12,
            properties_set: 3,
            warnings: vec![
                "1 block(s) exceeded maximum depth of 19 and were flattened".into(),
                "stripped 2 unresolvable ((block-ref)) token(s)".into(),
            ],
        };
        insta::assert_yaml_snapshot!(result);
    }

    /// The [`ImportProgressUpdate`] channel payload — an internally-tagged
    /// (`kind`, `snake_case`) enum the frontend switches on to drive the
    /// determinate progress bar. The tag STRINGS are the contract: a variant
    /// rename makes the bar silently stop updating rather than fail loudly,
    /// so the discriminant is pinned per variant.
    #[test]
    fn snapshot_import_progress_update_wire_shapes() {
        let cases = [
            (
                "started",
                ImportProgressUpdate::Started {
                    page_title: "Quarterly Review".into(),
                    blocks_total: 12,
                },
            ),
            (
                "progress",
                ImportProgressUpdate::Progress {
                    blocks_done: 7,
                    blocks_total: 12,
                },
            ),
            (
                "complete",
                ImportProgressUpdate::Complete {
                    page_title: "Quarterly Review".into(),
                    blocks_created: 12,
                    properties_set: 3,
                },
            ),
        ];
        for (name, update) in cases {
            insta::assert_yaml_snapshot!(format!("import_progress_{name}"), update);
        }
    }
}

/// Line-ending normalization in front of the YAML
/// frontmatter strip. The strip uses `find("\n---")`, so CRLF and lone-CR
/// inputs must be normalized to LF first. Tests live in their own module
/// (per the review note) to keep the regression surface explicit.
#[cfg(test)]
mod tests_l9 {
    use super::*;

    #[test]
    fn crlf_frontmatter_is_stripped() {
        // Exact fixture from the review note.
        let output = parse_logseq_markdown("---\r\ntitle: hello\r\n---\r\nbody");
        assert_eq!(
            output.blocks.len(),
            1,
            "frontmatter should be stripped, got blocks: {:?}",
            output.blocks
        );
        assert_eq!(output.blocks[0].content, "body");
        for block in &output.blocks {
            assert!(
                !block.content.contains("title:"),
                "frontmatter key leaked into block content: {:?}",
                block.content
            );
        }
    }

    #[test]
    fn cr_only_frontmatter_is_stripped() {
        // Classic-Mac line endings (lone `\r`). Without the normalization
        // step `find("\n---")` would never match and the entire frontmatter
        // would survive as block content.
        let output = parse_logseq_markdown("---\rtitle: hello\r---\rbody");
        assert_eq!(
            output.blocks.len(),
            1,
            "frontmatter should be stripped, got blocks: {:?}",
            output.blocks
        );
        assert_eq!(output.blocks[0].content, "body");
        for block in &output.blocks {
            assert!(
                !block.content.contains("title:"),
                "frontmatter key leaked into block content: {:?}",
                block.content
            );
        }
    }

    #[test]
    fn crlf_frontmatter_with_list_blocks() {
        // CRLF variant of the existing `parse_yaml_frontmatter_stripped`
        // case in the main `tests` module.
        let output = parse_logseq_markdown(
            "---\r\ntitle: Test Page\r\ntags: [a, b]\r\n---\r\n- Block 1\r\n- Block 2",
        );
        assert_eq!(output.blocks.len(), 2);
        assert_eq!(output.blocks[0].content, "Block 1");
        assert_eq!(output.blocks[1].content, "Block 2");
    }

    #[test]
    fn mixed_line_endings_match_lf_only() {
        // A file with all three styles: CRLF, LF, and lone CR. After
        // normalization the parser should produce the same blocks (content,
        // depth, properties) and the same warnings as the equivalent LF-only
        // fixture.
        let mixed = "- Block A\r\n  - Child A\n- Block B\r  - Child B";
        let lf_only = "- Block A\n  - Child A\n- Block B\n  - Child B";

        let mixed_out = parse_logseq_markdown(mixed);
        let lf_out = parse_logseq_markdown(lf_only);

        assert_eq!(
            mixed_out.blocks.len(),
            lf_out.blocks.len(),
            "mixed line endings should yield the same block count as LF-only; \
             mixed: {:?}, lf: {:?}",
            mixed_out.blocks,
            lf_out.blocks
        );
        assert_eq!(mixed_out.blocks.len(), 4);
        for (m, l) in mixed_out.blocks.iter().zip(lf_out.blocks.iter()) {
            assert_eq!(m.content, l.content);
            assert_eq!(m.depth, l.depth);
            assert_eq!(m.properties, l.properties);
        }
        assert_eq!(mixed_out.warnings, lf_out.warnings);
    }

    #[test]
    fn lf_frontmatter_still_stripped_after_normalization() {
        // Regression guard: the existing `parse_yaml_frontmatter_stripped`
        // fixture must keep passing after line-ending normalization is added.
        let output =
            parse_logseq_markdown("---\ntitle: Test Page\ntags: [a, b]\n---\n- Block 1\n- Block 2");
        assert_eq!(output.blocks.len(), 2);
        assert_eq!(output.blocks[0].content, "Block 1");
        assert_eq!(output.blocks[1].content, "Block 2");
    }

    #[test]
    fn mixed_line_endings_frontmatter_is_stripped() {
        // Single fixture mixing all three styles (CRLF, LF, lone
        // CR) within the same file — including across the frontmatter
        // boundary.  Exercises the same normalization the CRLF-only and
        // CR-only frontmatter tests above check, but with the styles
        // interleaved (the worst case in the wild: a hand-edited file
        // saved by multiple tools across platforms).
        let output = parse_logseq_markdown(
            "---\r\ntitle: hello\ntags: [a, b]\r---\r\n- Block 1\n- Block 2\r- Block 3",
        );
        assert_eq!(
            output.blocks.len(),
            3,
            "frontmatter should be stripped and three list blocks should remain, got: {:?}",
            output.blocks,
        );
        assert_eq!(output.blocks[0].content, "Block 1");
        assert_eq!(output.blocks[1].content, "Block 2");
        assert_eq!(output.blocks[2].content, "Block 3");
        for block in &output.blocks {
            assert!(
                !block.content.contains("title:"),
                "frontmatter key leaked into block content: {:?}",
                block.content,
            );
            assert!(
                !block.content.contains('\r'),
                "raw CR should not survive normalization in block content: {:?}",
                block.content,
            );
        }
    }
}

// ===========================================================================
// Property-based tests (proptest) — #2590
// ===========================================================================
//
// The Markdown/Obsidian importer parses fully arbitrary user files (a picked
// vault folder, an Obsidian export, ENEX/JEX notes composed into Markdown), so
// `parse_logseq_markdown` is a raw-input boundary. The example-based tests above
// pin specific shapes; this proptest asserts the *structural contract* holds for
// arbitrary input: the parser never panics, always clamps `depth` to
// `MAX_IMPORT_DEPTH`, and only ever emits a non-empty, caret-free block anchor.
// (The libFuzzer `import_parse` target in `src-tauri/fuzz` drives the same entry
// point over the raw byte space; proptest generates VALID-ish Markdown shapes,
// libFuzzer the truncated/garbage boundary — the two are complementary.)
#[cfg(test)]
mod parse_proptest {
    use super::{MAX_IMPORT_DEPTH, parse_logseq_markdown};
    use proptest::prelude::*;

    /// One line of plausible Logseq/Obsidian Markdown: an indented bullet, a
    /// `key:: value` property, a trailing `^block-id` anchor, a fence, or an
    /// arbitrary text line. Joined with `\n` this exercises the block splitter,
    /// the depth clamp, the property parser, and the anchor stripper.
    fn arb_md_line() -> impl Strategy<Value = String> {
        prop_oneof![
            (0usize..12, "[a-zA-Z0-9 #\\[\\]()^:-]{0,40}").prop_map(|(indent, text)| format!(
                "{}- {}",
                "  ".repeat(indent),
                text
            )),
            ("[a-z-]{1,10}", "[a-zA-Z0-9 ]{0,20}").prop_map(|(k, v)| format!("{k}:: {v}")),
            "[a-zA-Z0-9 ]{0,30} \\^[A-Za-z0-9-]{1,12}".prop_map(|s: String| s),
            "[a-zA-Z0-9 #:\\[\\]()^-]{0,40}".prop_map(|s: String| s),
            Just("```".to_string()),
        ]
    }

    fn arb_markdown() -> impl Strategy<Value = String> {
        proptest::collection::vec(arb_md_line(), 0..25).prop_map(|lines| lines.join("\n"))
    }

    proptest! {
        /// `parse_logseq_markdown` never panics and always upholds its
        /// structural invariants on arbitrary Markdown-ish input.
        #[test]
        fn parse_logseq_markdown_upholds_invariants(input in arb_markdown()) {
            let output = parse_logseq_markdown(&input);
            for block in &output.blocks {
                prop_assert!(
                    block.depth <= MAX_IMPORT_DEPTH,
                    "block depth {} exceeds the import clamp {}",
                    block.depth,
                    MAX_IMPORT_DEPTH,
                );
                if let Some(anchor) = &block.block_anchor {
                    prop_assert!(!anchor.is_empty(), "a block anchor, when present, is never empty");
                    prop_assert!(
                        !anchor.contains('^'),
                        "the leading caret is stripped from a block anchor, got {anchor:?}",
                    );
                }
            }
        }

        /// Also fuzz the truly-arbitrary-string boundary (not just Markdown-ish
        /// input): any UTF-8 string must parse without panicking.
        #[test]
        fn parse_logseq_markdown_never_panics_on_arbitrary_text(input in ".*") {
            let _ = parse_logseq_markdown(&input);
        }
    }
}

/// #3675 — the ordering [`detect_attachment_refs`] actually returns.
///
/// Its docstring promised plain source order, which the two-pass scan does not
/// deliver: the Obsidian-embed sweep runs to completion before the
/// markdown-image sweep and nothing sorts afterwards. The caller survey on the
/// issue found no consumer of the ordering — `insert_blocks` feeds the refs to
/// a `HashMap` tally and to a `str::replacen` rewrite keyed on each ref's own
/// `full_match`, and [`AttachmentRef`] carries no source offset — so the
/// DOCSTRING was corrected and the scan order left alone.
///
/// These tests pin the behaviour the corrected docstring now describes, so the
/// two halves cannot drift apart again silently. Own module (like `tests_l9`
/// above) to keep the regression surface explicit.
#[cfg(test)]
mod tests_attachment_ref_order_3675 {
    use super::detect_attachment_refs;

    /// The issue's own fixture: the markdown image is FIRST in the source and
    /// still comes back second.
    #[test]
    fn embed_precedes_image_even_when_the_image_comes_first_in_source() {
        let refs = detect_attachment_refs("![](images/a.png)\n![[b.png]]", &[]);
        let got: Vec<&str> = refs.iter().map(|r| r.original_ref.as_str()).collect();
        assert_eq!(
            got,
            vec!["b.png", "images/a.png"],
            "embeds are collected before images; this is NOT source order (#3675)"
        );
    }

    /// Within each scan the order *is* source order — the grouping is the only
    /// departure, which is what the docstring now says.
    #[test]
    fn each_scan_is_internally_in_source_order() {
        let refs = detect_attachment_refs("![](i1.png) ![[e1.png]] ![](i2.png) ![[e2.png]]", &[]);
        let got: Vec<&str> = refs.iter().map(|r| r.original_ref.as_str()).collect();
        assert_eq!(
            got,
            vec!["e1.png", "e2.png", "i1.png", "i2.png"],
            "both embeds (in source order) then both images (in source order)"
        );
    }
}

/// #4552 slice 4 — the importer half of the `listStyle` markdown round trip.
///
/// The exporter writes a block's list-ness as a marker BETWEEN the outline
/// bullet and the text (`- - foo`, `- 1. foo`), and backslash-escapes a plain
/// block whose text merely looks like one (`- \- foo`). These tests pin the
/// consuming half: the marker becomes a `listStyle` property and leaves
/// `blocks.content` bare, the escape is reversed, and the literal ordinal is
/// discarded.
#[cfg(test)]
mod tests_list_style_4552 {
    use super::{
        LIST_STYLE_BULLET, LIST_STYLE_KEY, LIST_STYLE_ORDERED, needs_list_marker_escape,
        parse_logseq_markdown, split_block_list_marker,
    };

    /// The `listStyle` value a parsed block carries, or `None` for a plain one.
    fn style_of(block: &super::ParsedBlock) -> Option<&str> {
        block
            .properties
            .iter()
            .find(|(k, _)| k == LIST_STYLE_KEY)
            .map(|(_, v)| v.as_str())
    }

    /// A bullet / ordered marker is consumed into the property and never left
    /// in the content. Non-tautological: pre-fix `content` was `"- Buy milk"`
    /// and `properties` was empty.
    #[test]
    fn marker_becomes_a_property_and_leaves_content_bare() {
        let out = parse_logseq_markdown("- - Buy milk\n- 1. Step one\n- Plain prose\n");
        let blocks = &out.blocks;
        assert_eq!(blocks.len(), 3, "three blocks; got {blocks:?}");

        assert_eq!(blocks[0].content, "Buy milk");
        assert_eq!(style_of(&blocks[0]), Some(LIST_STYLE_BULLET));

        assert_eq!(blocks[1].content, "Step one");
        assert_eq!(style_of(&blocks[1]), Some(LIST_STYLE_ORDERED));

        assert_eq!(blocks[2].content, "Plain prose");
        assert_eq!(style_of(&blocks[2]), None, "a plain block stays plain");
    }

    /// The literal ordinal is DISCARDED — `3.` / `7.` / `1.` all import as the
    /// same `ordered` style, which is what makes a non-canonical file
    /// normalise to `1. 2. 3.` on the first export.
    #[test]
    fn ordinals_are_never_stored() {
        let out = parse_logseq_markdown("- 3. a\n- 7. b\n- 1. c\n- 12. d\n");
        for (block, text) in out.blocks.iter().zip(["a", "b", "c", "d"]) {
            assert_eq!(block.content, text);
            assert_eq!(style_of(block), Some(LIST_STYLE_ORDERED));
        }
        for block in &out.blocks {
            assert!(
                !block
                    .content
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_digit()),
                "no literal ordinal may survive into content: {:?}",
                block.content
            );
        }
    }

    /// A marker-less block whose text merely BEGINS with a marker arrives
    /// backslash-escaped and must come back as plain text — a paragraph, not a
    /// list. This is the import half of acceptance criterion 11.
    #[test]
    fn exporter_escape_is_reversed_into_plain_text() {
        let out = parse_logseq_markdown("- \\- not a list\n- \\1. also not a list\n");
        assert_eq!(out.blocks[0].content, "- not a list");
        assert_eq!(style_of(&out.blocks[0]), None);
        assert_eq!(out.blocks[1].content, "1. also not a list");
        assert_eq!(style_of(&out.blocks[1]), None);
    }

    /// A leading backslash that does NOT guard a marker is ordinary content
    /// (a LaTeX command, say) and keeps its backslash — the same discipline
    /// the #2716 continuation-line un-escape follows.
    #[test]
    fn a_non_guarding_backslash_is_preserved() {
        let out = parse_logseq_markdown("- \\alpha + \\beta\n");
        assert_eq!(out.blocks[0].content, "\\alpha + \\beta");
        assert_eq!(style_of(&out.blocks[0]), None);
    }

    /// The escape/un-escape pair is INJECTIVE: `escape` then `split` is the
    /// identity for every shape, including text that already starts with
    /// backslashes. Without the "look past the backslash run" rule in
    /// `needs_list_marker_escape`, `- foo` and `\- foo` would both export as
    /// `\- foo` and collapse to one value on the way back.
    #[test]
    fn escape_then_unescape_is_the_identity() {
        for text in [
            "- foo",
            "-",
            "1. foo",
            "12.",
            "\\- foo",
            "\\\\- foo",
            "\\1. foo",
            "\\alpha",
            "plain prose",
            "",
            "-nospace",
            "1.nospace",
            "2026. was a year",
        ] {
            let wire = if needs_list_marker_escape(text) {
                format!("\\{text}")
            } else {
                text.to_string()
            };
            let (style, back) = split_block_list_marker(&wire);
            assert_eq!(
                (style, back),
                (None, text),
                "escape/un-escape must round-trip {text:?} (wire {wire:?})"
            );
        }
    }

    /// A marker is recognised only in the exact shapes the exporter emits;
    /// `-nospace` / `1.nospace` are ordinary text, so they are neither
    /// escaped nor consumed.
    #[test]
    fn marker_grammar_boundaries() {
        assert_eq!(
            split_block_list_marker("-nospace"),
            (None, "-nospace"),
            "a dash with no following space is not a marker"
        );
        assert_eq!(split_block_list_marker("1.nospace"), (None, "1.nospace"));
        assert_eq!(
            split_block_list_marker("-"),
            (Some(LIST_STYLE_BULLET), ""),
            "a bare dash is an EMPTY bullet block"
        );
        assert_eq!(
            split_block_list_marker("7."),
            (Some(LIST_STYLE_ORDERED), "")
        );
        assert!(!needs_list_marker_escape("-nospace"));
        assert!(!needs_list_marker_escape("plain"));
        assert!(needs_list_marker_escape("- x"));
        assert!(needs_list_marker_escape("9. x"));
    }

    /// An explicit body `listStyle:: …` line still imports, and WINS over the
    /// marker — the property line is appended after the marker-derived seed,
    /// so the apply loop's last write is the explicit one. This is the
    /// behaviour the deliberate exclusion-list asymmetry exists to preserve
    /// (`listStyle` is export-suppressed but never import-reserved).
    #[test]
    fn an_explicit_property_line_still_imports_and_wins() {
        let out = parse_logseq_markdown("- - Buy milk\n  listStyle:: ordered\n");
        let props = &out.blocks[0].properties;
        assert_eq!(
            props.last(),
            Some(&(LIST_STYLE_KEY.to_string(), LIST_STYLE_ORDERED.to_string())),
            "the explicit line must be applied last; got {props:?}"
        );
    }

    /// Marker consumption must not fire inside a fenced code block: a `- x`
    /// line in a code sample is literal code (#2725) and never reaches the
    /// bullet branch at all.
    #[test]
    fn a_bullet_inside_a_code_fence_is_not_a_marker() {
        let out = parse_logseq_markdown("- ```sh\n  - not a list item\n  ```\n");
        assert_eq!(
            out.blocks.len(),
            1,
            "one fenced block; got {:?}",
            out.blocks
        );
        assert_eq!(style_of(&out.blocks[0]), None);
        assert!(
            out.blocks[0].content.contains("- not a list item"),
            "fenced content stays verbatim; got {:?}",
            out.blocks[0].content
        );
    }

    /// A list-styled block whose content is a code block opens the fence just
    /// as a plain one does, so the `- x` inside it stays code instead of
    /// becoming a child block.
    #[test]
    fn a_list_styled_fence_opens_a_code_block() {
        for (md, style) in [
            ("- - ```sh\n  - x\n  ```\n", LIST_STYLE_BULLET),
            ("- 1. ```sh\n  - x\n  ```\n", LIST_STYLE_ORDERED),
        ] {
            let out = parse_logseq_markdown(md);
            assert_eq!(out.blocks.len(), 1, "{md:?}: got {:?}", out.blocks);
            let block = &out.blocks[0];
            assert_eq!(block.content, "```sh\n- x\n```", "{md:?}");
            assert_eq!(style_of(block), Some(style), "{md:?}");
            assert!(block.is_code, "{md:?}");
        }
    }
}

/// #5140 — the source-mode reading of the outline grammar. The app crate's
/// render→parse proptest is the oracle for the whole buffer; these pin each
/// rule on its own.
#[cfg(test)]
mod tests_source_outline_5140 {
    use super::{
        needs_task_marker_escape, parse_logseq_markdown, parse_source_outline,
        split_block_task_marker, split_task_marker, task_marker_for,
    };

    fn todo_state_of(block: &super::ParsedBlock) -> Option<&str> {
        block
            .properties
            .iter()
            .rev()
            .find(|(k, _)| k == "todo_state")
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn block_refs_and_spacing_are_kept() {
        let out = parse_source_outline("- a  ((01ARZ3NDEKTSV4RRFFQ69G5FAV))  b  ^X1\n");
        assert_eq!(
            out.blocks[0].content,
            "a  ((01ARZ3NDEKTSV4RRFFQ69G5FAV))  b "
        );
        assert_eq!(out.blocks[0].block_anchor.as_deref(), Some("X1"));
    }

    #[test]
    fn interior_blank_lines_are_kept_and_trailing_ones_dropped() {
        let out = parse_source_outline("- a\n\n    \n  b\n  b2\n\n- c\n  key:: v\n\n");
        let contents: Vec<&str> = out.blocks.iter().map(|b| b.content.as_str()).collect();
        assert_eq!(contents, ["a\n\n  \nb\nb2", "c"]);
    }

    /// A continuation line loses exactly its bullet's indentation, so a code
    /// line keeps its own.
    #[test]
    fn a_continuation_line_loses_only_its_bullet_indentation() {
        let out = parse_source_outline("- ```\n      indented\n  ```\n  - x\n       y\n");
        assert_eq!(out.blocks[0].content, "```\n    indented\n```");
        assert_eq!(out.blocks[1].content, "x\n   y");
    }

    #[test]
    fn an_empty_first_line_keeps_its_newline() {
        let out = parse_source_outline("- \n  b\n");
        assert_eq!(out.blocks[0].content, "\nb");
    }

    #[test]
    fn a_checkbox_is_read_as_todo_state() {
        for (md, state, content) in [
            ("- [ ] a", "TODO", "a"),
            ("- [x] a", "DONE", "a"),
            ("- [X] a", "DONE", "a"),
            ("- [/] a", "DOING", "a"),
            ("- [-] a", "CANCELLED", "a"),
            ("- [ ]", "TODO", ""),
        ] {
            let block = &parse_source_outline(md).blocks[0];
            assert_eq!(todo_state_of(block), Some(state), "{md:?}");
            assert_eq!(block.content, content, "{md:?}");
        }
    }

    /// The checkbox follows the list marker; before it, it is text.
    #[test]
    fn a_checkbox_follows_the_list_marker() {
        let block = &parse_source_outline("- 1. [x] a").blocks[0];
        assert_eq!(
            block.properties,
            [
                ("listStyle".to_string(), "ordered".to_string()),
                ("todo_state".to_string(), "DONE".to_string()),
            ]
        );
        assert_eq!(block.content, "a");

        let block = &parse_source_outline("- [x] 1. a").blocks[0];
        assert_eq!(todo_state_of(block), Some("DONE"));
        assert_eq!(block.content, "1. a");
    }

    #[test]
    fn an_explicit_todo_state_line_wins_over_the_checkbox() {
        let block = &parse_source_outline("- [ ] a\n  todo_state:: WAITING\n").blocks[0];
        assert_eq!(todo_state_of(block), Some("WAITING"));
    }

    /// A checkbox is read only at the start of a bullet's first line.
    #[test]
    fn a_checkbox_in_code_or_a_continuation_line_is_text() {
        let out = parse_source_outline("- ```\n  - [ ] a\n  ```\n- b\n  [x] c\n");
        assert_eq!(out.blocks.len(), 2, "{:?}", out.blocks);
        assert_eq!(out.blocks[0].content, "```\n- [ ] a\n```");
        assert_eq!(out.blocks[1].content, "b\n[x] c");
        assert!(out.blocks.iter().all(|b| todo_state_of(b).is_none()));
    }

    /// A task whose content is a code block opens its fence on the bullet
    /// line, so the `- x` inside stays code.
    #[test]
    fn a_task_whose_content_is_code_opens_its_fence() {
        let out = parse_source_outline("- [ ] ```sh\n  - x\n  ```\n  ^A1\n");
        assert_eq!(out.blocks.len(), 1, "{:?}", out.blocks);
        let block = &out.blocks[0];
        assert_eq!(block.content, "```sh\n- x\n```");
        assert_eq!(block.block_anchor.as_deref(), Some("A1"));
        assert_eq!(todo_state_of(block), Some("TODO"));
        assert!(block.is_code);
    }

    /// A bullet-shaped line in code is how the render writes it, so a source
    /// buffer reports no reshaping where an import of the same text does.
    #[test]
    fn a_bullet_shaped_code_line_is_reported_only_on_import() {
        let md = "- ```\n  - x\n  ```\n";
        let source = parse_source_outline(md).warnings;
        assert!(source.is_empty(), "a source buffer: {source:?}");
        let import = parse_logseq_markdown(md).warnings;
        assert_eq!(import.len(), 1, "an import: {import:?}");
    }

    const ID_A: &str = "01J0000000000000000000000A";
    const ID_B: &str = "01J0000000000000000000000B";

    /// A block that leaves its fence open has its anchor on a line of its own,
    /// which ends the fence: the child after it is a block.
    #[test]
    fn an_anchor_line_ends_an_open_fence() {
        let out = parse_source_outline(&format!("- ````\n  ^{ID_A}\n  - B ^{ID_B}\n"));
        assert_eq!(out.blocks.len(), 2, "{:?}", out.blocks);
        assert_eq!(out.blocks[0].content, "````");
        assert_eq!(out.blocks[0].block_anchor.as_deref(), Some(ID_A));
        assert_eq!(out.blocks[1].depth, 1);
        assert_eq!(out.blocks[1].content, "B");
        assert_eq!(out.blocks[1].block_anchor.as_deref(), Some(ID_B));
    }

    #[test]
    fn a_property_line_after_an_open_fence_is_a_property() {
        let out = parse_source_outline(&format!("- ```sh\n  echo\n  ^{ID_A}\n  lang:: sh\n"));
        assert_eq!(out.blocks.len(), 1, "{:?}", out.blocks);
        let block = &out.blocks[0];
        assert_eq!(block.content, "```sh\necho");
        assert_eq!(block.block_anchor.as_deref(), Some(ID_A));
        assert_eq!(block.properties, [("lang".to_string(), "sh".to_string())]);
    }

    /// An escaped anchor-shaped code line is code: it loses its escape and
    /// leaves the fence open, so the `- x` after it is code too.
    #[test]
    fn an_escaped_anchor_line_is_code() {
        let out = parse_source_outline(&format!("- ```\n  \\^{ID_B}\n  - x\n  ^{ID_A}\n"));
        assert_eq!(out.blocks.len(), 1, "{:?}", out.blocks);
        assert_eq!(out.blocks[0].content, format!("```\n^{ID_B}\n- x"));
        assert_eq!(out.blocks[0].block_anchor.as_deref(), Some(ID_A));
    }

    /// A property line the save would not store — a reserved key, or one with
    /// no block at or above its indentation — is what the user typed: content.
    /// An import still drops both, with a warning.
    #[test]
    fn a_reserved_or_orphan_property_line_is_text() {
        let out = parse_source_outline("alias:: foo\n- a\n  repeat:: +1w\n  key:: v\n");
        let shapes: Vec<(&str, &[(String, String)])> = out
            .blocks
            .iter()
            .map(|b| (b.content.as_str(), b.properties.as_slice()))
            .collect();
        assert_eq!(
            shapes,
            [
                ("alias:: foo", &[][..]),
                (
                    "a\nrepeat:: +1w",
                    &[("key".to_string(), "v".to_string())][..]
                ),
            ]
        );
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);

        let orphan = parse_source_outline("  - a\nkey:: v\n");
        assert_eq!(orphan.blocks[0].content, "a\nkey:: v");
        assert!(orphan.blocks[0].properties.is_empty());
        assert!(orphan.warnings.is_empty(), "{:?}", orphan.warnings);

        let import = parse_logseq_markdown("alias:: foo\n- a\n  repeat:: +1w\n");
        assert_eq!(import.blocks[0].content, "a");
        assert_eq!(import.warnings.len(), 2, "{:?}", import.warnings);
    }

    /// The checkbox is source mode's alone: an imported file's `[ ]` is text.
    #[test]
    fn an_import_reads_no_checkbox() {
        let block = &parse_logseq_markdown("- [ ] a").blocks[0];
        assert_eq!(block.content, "[ ] a");
        assert!(block.properties.is_empty());
    }

    #[test]
    fn task_marker_escape_then_unescape_is_the_identity() {
        for text in [
            "[ ] a",
            "[x]",
            "[X] a",
            "[-] a",
            "\\[ ] a",
            "\\\\[/] a",
            "[?] a",
            "[ ]x",
            "plain",
            "",
            "\\",
            "\\alpha",
        ] {
            let wire = if needs_task_marker_escape(text) {
                format!("\\{text}")
            } else {
                text.to_string()
            };
            assert_eq!(
                split_block_task_marker(&wire),
                (None, text),
                "wire {wire:?}"
            );
        }
    }

    #[test]
    fn checkbox_grammar_boundaries() {
        for text in ["[ ]x", "[?] a", "[] a", "[ ", "[xx] a", " [ ] a"] {
            assert_eq!(split_task_marker(text), None, "{text:?}");
            assert!(!needs_task_marker_escape(text), "{text:?}");
        }
        assert_eq!(split_task_marker("[ ] "), Some(("TODO", "")));
        assert_eq!(split_task_marker("[/]"), Some(("DOING", "")));
        let written: Vec<Option<char>> = ["TODO", "DONE", "DOING", "CANCELLED", "WAITING"]
            .into_iter()
            .map(task_marker_for)
            .collect();
        assert_eq!(written, [Some(' '), Some('x'), Some('/'), Some('-'), None]);
    }
}

#[cfg(test)]
mod tests_pasted_text_5140 {
    use super::{MAX_IMPORT_DEPTH, parse_pasted_text, parse_source_outline, pasted_block};

    /// `(depth, content, properties)` of a block.
    type Shape = (usize, String, Vec<(String, String)>);

    fn shape(text: &str) -> Vec<Shape> {
        parse_pasted_text(text)
            .into_iter()
            .map(|b| (b.depth, b.content, b.properties))
            .collect()
    }

    #[test]
    fn text_opening_with_a_bullet_is_an_outline() {
        assert_eq!(
            shape("\n\n- [x] a\n  more\n  - b\n    key:: v\n"),
            [
                (
                    0,
                    "a\nmore".to_string(),
                    vec![("todo_state".to_string(), "DONE".to_string())]
                ),
                (
                    1,
                    "b".to_string(),
                    vec![("key".to_string(), "v".to_string())]
                ),
            ]
        );
    }

    /// Nothing on a plain line is a marker or a property, and each keeps its
    /// indentation as its depth, a tab counting as one level.
    #[test]
    fn other_text_is_one_block_per_line_nested_by_indentation() {
        assert_eq!(
            shape("first\n  - second\n\n\t[x] third\n    key:: v\r\n"),
            [
                (0, "first".to_string(), vec![]),
                (1, "- second".to_string(), vec![]),
                (1, "[x] third".to_string(), vec![]),
                (2, "key:: v".to_string(), vec![]),
            ]
        );
    }

    /// A continuation line loses its bullet's indentation in columns, so a
    /// tab past it is content.
    #[test]
    fn a_tab_indented_outline_nests() {
        assert_eq!(
            shape("- a\n\t- b\n\t\t- c\n\t\t  more\n\t\t\t\tdeeper\n"),
            [
                (0, "a".to_string(), vec![]),
                (1, "b".to_string(), vec![]),
                (2, "c\nmore\n\tdeeper".to_string(), vec![]),
            ]
        );
    }

    /// A tab inside a code line is the code's own: only the bullet's
    /// indentation, written in spaces, is removed.
    #[test]
    fn a_tab_after_the_bullet_indentation_is_content() {
        let out = parse_source_outline("- ```\n  \tindented\n  ```\n");
        assert_eq!(out.blocks[0].content, "```\n\tindented\n```");
    }

    /// A chain of bullets one level past the import depth limit.
    fn chain_past_the_depth_limit() -> String {
        (0..=MAX_IMPORT_DEPTH + 1)
            .map(|depth| format!("{}- b{depth}\n", "  ".repeat(depth)))
            .collect()
    }

    /// A source buffer is saved, not imported: a block too deep is refused by
    /// the write, so the parse keeps its depth.
    #[test]
    fn a_source_buffer_keeps_a_depth_past_the_import_limit() {
        let out = parse_source_outline(&chain_past_the_depth_limit());
        assert_eq!(
            out.blocks.last().map(|b| b.depth),
            Some(MAX_IMPORT_DEPTH + 1),
            "the deepest block keeps its depth"
        );
        assert!(
            out.warnings.is_empty(),
            "nothing was flattened: {:?}",
            out.warnings
        );
    }

    /// Pasted text is flattened past the limit, as an import is.
    #[test]
    fn a_pasted_outline_is_flattened_past_the_import_limit() {
        let blocks = parse_pasted_text(&chain_past_the_depth_limit());
        assert_eq!(
            blocks.last().map(|b| b.depth),
            Some(MAX_IMPORT_DEPTH),
            "the deepest block is flattened to the limit"
        );
    }

    #[test]
    fn empty_or_blank_text_is_no_block() {
        assert!(parse_pasted_text("").is_empty());
        assert!(parse_pasted_text(" \n\t\n").is_empty());
    }

    /// A trailing ` ^word` that is not a block id is text; one that is a block
    /// id is dropped, so a paste never pairs with a block.
    #[test]
    fn a_trailing_caret_word_is_kept_and_a_block_id_dropped() {
        let blocks = parse_pasted_text("- press ^C\n- copied ^01ARZ3NDEKTSV4RRFFQ69G5FAV\n");
        let contents: Vec<&str> = blocks.iter().map(|b| b.content.as_str()).collect();
        assert_eq!(contents, ["press ^C", "copied"]);
    }

    #[test]
    fn a_pasted_block_with_a_fence_line_is_code() {
        assert!(pasted_block("```js\nx".to_string(), 0).is_code);
        assert!(pasted_block("a\n  ```".to_string(), 0).is_code);
        assert!(!pasted_block("a `b` c".to_string(), 0).is_code);
    }
}
