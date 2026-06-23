//! Logseq/Markdown import parser.
//!
//! Parses indented markdown into a flat list of blocks with parent/child
//! relationships determined by indentation level.

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
/// MAX_BLOCK_DEPTH` (`block_ops.rs`), so a block clamped to import-depth
/// `MAX_BLOCK_DEPTH` would land at absolute depth `MAX_BLOCK_DEPTH + 1` and
/// be REJECTED — defeating the clamp's whole purpose (making deep imports
/// safe) and previously `?`-aborting the entire chunk. Clamping one level
/// shallower keeps the clamped block (plus the page-root offset) at-or-below
/// the create-path bound. The value still sits far under the recursive-CTE
/// depth bound of `depth < 100` enforced throughout the materialiser
/// (Invariant #9; see AGENTS.md "Recursive CTEs over `blocks`").
#[allow(clippy::cast_possible_truncation)] // MAX_BLOCK_DEPTH is a small positive constant; the cast cannot truncate.
const MAX_IMPORT_DEPTH: usize = (crate::domain::block_ops::MAX_BLOCK_DEPTH as usize) - 1;

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
}

/// Outcome of importing one markdown file: the created page plus aggregate
/// counts and any non-fatal diagnostics, returned by
/// [`import_markdown_with_progress`] and surfaced to the import UI.
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
    /// (see [`FRONTMATTER_RESERVED_KEYS`]) are filtered out here so they are
    /// never re-imported. Empty when the file has no frontmatter.
    pub frontmatter: Vec<(String, String)>,
    pub warnings: Vec<String>,
}

/// Internal/system-managed property keys that the markdown exporter
/// deliberately strips from the YAML frontmatter
/// (`export_page_markdown_inner`, #384). The import path filters the same
/// keys so a round-tripped file can never re-import a space-membership,
/// template, or lifecycle marker as a user-visible page property. Kept in
/// sync with the `NOT IN (...)` list in the exporter's frontmatter query.
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

/// Streaming progress payload for a single `import_markdown` call (#128).
///
/// Carried over a Tauri `Channel<ImportProgressUpdate>` so a long import
/// can render a per-block progress bar instead of a bare spinner. The
/// enum is `Serialize` + `Type` only (no `Deserialize`) — like
/// [`crate::sync_events::SyncProgressUpdate`], it is a one-way
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

/// Sink for [`ImportProgressUpdate`] events, decoupling the import command
/// from Tauri so tests can capture the emitted stream without an
/// `AppHandle` (mirrors `sync_events::SyncEventSink`).
///
/// Implemented for `tauri::ipc::Channel<ImportProgressUpdate>` (the
/// production path) and for a test recorder. Sends are best-effort: a
/// failed send (e.g. the frontend dropped the channel) is swallowed — a
/// dead progress channel must never abort an otherwise-valid import.
pub trait ImportProgressSink: Send + Sync {
    fn emit(&self, update: ImportProgressUpdate);
}

impl ImportProgressSink for tauri::ipc::Channel<ImportProgressUpdate> {
    fn emit(&self, update: ImportProgressUpdate) {
        // Best-effort: a dropped channel must not fail the import. #1932 —
        // but record the failure at debug so a frozen progress bar can be
        // distinguished from a hung import ("progress channel dead" vs
        // "import stuck") when triaging from the log.
        if let Err(e) = self.send(update) {
            tracing::debug!(
                error = %e,
                "import: progress channel send failed (frontend likely dropped it)"
            );
        }
    }
}

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
/// Returns the refs in source order. The inline-code skip reuses the same
/// single-backtick pairing the importer's #1924 helpers use.
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

/// Inline-code-span byte ranges in `content` (`` `...` ``), used by
/// [`detect_attachment_refs`] to skip refs inside inline code. Single-backtick
/// pairing — the same minimal rule the #1924 inline-tag helpers use. Lifted
/// here so the importer can compute spans once per block and reuse them.
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
    let mut blocks: Vec<ParsedBlock> = Vec::new();
    // #682: count property lines that could not be attached to any owning
    // ancestor block, mirroring the depth-clamp `clamped_count` pattern so the
    // lossy case is surfaced in `warnings` rather than silently swallowed.
    let mut orphan_property_count: usize = 0;
    // #1568: count body-property lines whose key is a reserved/exporter-managed
    // key (`FRONTMATTER_RESERVED_KEYS`, e.g. `space`). Such keys are
    // column-backed / lifecycle-managed and would make `set_property_in_tx`
    // return a Validation error, aborting the whole import chunk. We filter them
    // here — exactly as the frontmatter path does (`parse_frontmatter`) — so a
    // hand-crafted/untrusted body bullet like `space:: X` is skipped instead of
    // failing an otherwise-valid import.
    let mut reserved_property_count: usize = 0;
    // #1933: count `((uuid))` block references removed from content. Block-ref
    // stripping is a lossy transform (the reference target vanishes) held to a
    // lower observability bar than the other lossy transforms in this function;
    // counting it here surfaces an aggregate warning so an import that drops
    // block-refs is diagnosable from the returned warnings / logs.
    let mut stripped_block_ref_count: usize = 0;

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
    let normalized = strip_frontmatter(&normalized, &mut frontmatter, &mut frontmatter_warnings);

    // #1921 — iterate `normalized.lines()` directly instead of collecting into
    // a `Vec<&str>`. The parse loop only ever reads the CURRENT line in
    // document order (no random indexing / lookahead), so a streaming iterator
    // is a drop-in that avoids the intermediate allocation.
    // #1924 — MINIMAL fenced-code tracking. We do NOT change how blocks are
    // split; we only flag blocks born inside a ```` ``` ````-fenced region so
    // the inline-tag pre-pass skips them (a `#tag` inside a code fence must
    // stay literal). A line whose trimmed text begins with three or more
    // backticks is a fence delimiter; it toggles `in_fence`. The delimiter line
    // and every line until the closing delimiter are treated as code. This is
    // intentionally a single-fence-char (`` ` ``) heuristic — full code-fence
    // import handling (tilde fences, language hints, indented fences, verbatim
    // preservation) is separate, out-of-scope work.
    let mut in_fence = false;
    for line in normalized.lines() {
        let trimmed = line.trim_start();

        // Skip empty lines
        if trimmed.is_empty() {
            continue;
        }

        // #1924 — fence-delimiter detection + toggle. The delimiter line is
        // itself part of the code region (`line_is_code` is true on both the
        // opening and closing fence), and every line strictly inside a fence is
        // code. Computed BEFORE classification so the block this line lands in
        // (or appends to) can be marked.
        // A fence delimiter may appear either standalone (a bare ```` ``` ````
        // continuation line) OR as the body of a list bullet (`- ```rust`), so
        // probe both shapes: strip a leading `- ` bullet marker before the
        // backtick test.
        let fence_probe = trimmed.strip_prefix("- ").unwrap_or(trimmed);
        let is_fence_delim = fence_probe.starts_with("```");
        let line_is_code = in_fence || is_fence_delim;
        if is_fence_delim {
            in_fence = !in_fence;
        }

        // Calculate indentation (number of leading spaces / 2)
        let indent = line.len() - trimmed.len();
        let depth = indent / 2;

        // Check if this is a list item (- prefix). #1917: a bare `-` with no
        // trailing space is an EMPTY bullet (Logseq/Obsidian emit these for an
        // empty list item) — it must spawn its own empty block, not fold into
        // the previous block's content as a continuation line. Handle both the
        // `- text` and the bare `-` forms here.
        if trimmed == "-" {
            blocks.push(ParsedBlock {
                content: String::new(),
                depth,
                properties: Vec::new(),
                is_code: line_is_code,
            });
        } else if let Some(text) = trimmed.strip_prefix("- ") {
            // Strip ((uuid)) block references -> plain text
            let (cleaned, removed) = strip_block_refs_counted(text);
            stripped_block_ref_count += removed;

            blocks.push(ParsedBlock {
                content: cleaned,
                depth,
                properties: Vec::new(),
                is_code: line_is_code,
            });
        } else if !line_is_code
            && let Some((key_candidate, value)) = trimmed
                .split_once(":: ")
                .filter(|(k, _)| is_property_key(k.trim()))
        {
            // Property line: `key:: value` — but only if the LHS matches the
            // same alphabet that `op::validate_set_property` enforces
            // (`^[A-Za-z0-9_-]{1,64}$`). I-Core-10: a free-form line
            // containing `:: ` mid-sentence (e.g. URL-bearing notes from
            // Logseq) would otherwise be misclassified and produce arbitrary
            // key/value pairs. The stricter discriminator falls through to
            // the content-block branch when the LHS is not a valid key.
            let key = key_candidate.trim().to_string();
            let value = value.trim().to_string();
            // #1568: skip reserved/exporter-managed keys before attaching them
            // to an owning block. These mirror the frontmatter filter
            // (`FRONTMATTER_RESERVED_KEYS`): `space` is column-backed and
            // requires a `value_ref`, so a body bullet `space:: X` (text value,
            // no ref) makes `set_property_in_tx` return a Validation error that
            // `?`-aborts the entire import chunk. Filtering here matches the
            // frontmatter round-trip semantics: a reserved body property is
            // dropped, never written, and the surrounding good content imports.
            if FRONTMATTER_RESERVED_KEYS.contains(&key.as_str()) {
                tracing::debug!(
                    key = %key,
                    "skipping reserved/column-backed body property during import (#1568)"
                );
                reserved_property_count += 1;
                continue;
            }
            // #682: attach to the block that *indentation* says owns this
            // property, not just the most-recently-pushed block. Logseq emits
            // a property line indented one level under (or level with) its
            // owning bullet, so the owner is the nearest preceding block whose
            // depth is <= the property line's depth. Scanning in reverse over
            // the document-ordered `blocks` finds that nearest ancestor; a
            // property nested under a grandchild therefore no longer
            // mis-attaches to an unrelated later sibling.
            match blocks.iter_mut().rev().find(|b| b.depth <= depth) {
                Some(owner) => owner.properties.push((key, value)),
                None => {
                    // No ancestor at or above this indentation (e.g. a
                    // property line indented deeper than any preceding bullet,
                    // or before any bullet at all). Lossy — surface it via a
                    // warning counter rather than swallow it silently.
                    orphan_property_count += 1;
                }
            }
        } else if let Some(last) = blocks.last_mut() {
            // #682: continuation line — a non-list, non-property line that
            // follows a bullet is the soft-wrapped / multi-line body of that
            // bullet. Append it (newline-joined) to the owning block's content
            // instead of spawning a separate block, matching how Logseq stores
            // multi-line bullet bodies.
            let (cleaned, removed) = strip_block_refs_counted(trimmed);
            stripped_block_ref_count += removed;
            // #1924 — a continuation line inside a fence makes the owning block
            // code (e.g. the fenced body lines that follow a `- ```rust` bullet,
            // and the closing ```` ``` ```` delimiter line). Once a block is
            // flagged code it stays code.
            if line_is_code {
                last.is_code = true;
            }
            if !cleaned.is_empty() {
                if !last.content.is_empty() {
                    last.content.push('\n');
                }
                last.content.push_str(&cleaned);
            }
        } else {
            // Non-list, non-property line with no preceding block (file starts
            // with bare text) -- treat as a standalone depth-0 content block.
            let (cleaned, removed) = strip_block_refs_counted(trimmed);
            stripped_block_ref_count += removed;
            blocks.push(ParsedBlock {
                content: cleaned,
                depth,
                properties: Vec::new(),
                is_code: line_is_code,
            });
        }
    }

    // Clamp depth to MAX_IMPORT_DEPTH (flatten deeper blocks) and track
    // how many were clamped.
    let mut clamped_count: usize = 0;
    for block in &mut blocks {
        if block.depth > MAX_IMPORT_DEPTH {
            block.depth = MAX_IMPORT_DEPTH;
            clamped_count += 1;
        }
    }

    let mut warnings = frontmatter_warnings;
    if clamped_count > 0 {
        warnings.push(format!(
            "{clamped_count} block(s) exceeded maximum depth of {MAX_IMPORT_DEPTH} and were flattened"
        ));
    }
    if orphan_property_count > 0 {
        warnings.push(format!(
            "{orphan_property_count} property line(s) had no owning block at or above their \
             indentation and were dropped"
        ));
    }
    if reserved_property_count > 0 {
        warnings.push(format!(
            "{reserved_property_count} reserved/exporter-managed property line(s) (e.g. `space`) \
             were skipped during import"
        ));
    }
    if stripped_block_ref_count > 0 {
        // #1933: block-ref stripping is data-lossy (the `((uuid))` target is
        // removed). Surface an aggregate warning so the drop is recoverable
        // from the returned warnings / the import summary log, not silent.
        warnings.push(format!(
            "{stripped_block_ref_count} ((block-ref)) reference(s) were stripped from imported \
             content and could not be preserved"
        ));
    }

    ParseOutput {
        blocks,
        frontmatter,
        warnings,
    }
}

/// Excise a leading YAML frontmatter block from already-EOL-normalized
/// markdown and parse it into page-property pairs (#1432).
///
/// Returns the markdown with the fenced block removed; `frontmatter` and
/// `warnings` are appended in place. Two fence positions are accepted (see
/// the call site): the very top of the file, or immediately after a single
/// leading `# Heading` line (Agaric's own export shape). In the latter case
/// the heading line is left in the returned body. An unterminated fence is
/// treated as plain content (returns the input unchanged, no properties).
fn strip_frontmatter<'a>(
    normalized: &'a str,
    frontmatter: &mut Vec<(String, String)>,
    warnings: &mut Vec<String>,
) -> std::borrow::Cow<'a, str> {
    use std::borrow::Cow;
    // Helper: given a slice that begins exactly at an opening `---` fence,
    // parse the fenced block and return the byte length consumed (through the
    // closing `\n---` and its line), or `None` if there is no closing fence.
    let parse_fence = |slice: &str,
                       frontmatter: &mut Vec<(String, String)>,
                       warnings: &mut Vec<String>|
     -> Option<usize> {
        let after_open = slice.strip_prefix("---")?;
        let end = after_open.find("\n---")?; // index within `after_open`
        let yaml = &after_open[..end];
        frontmatter.extend(parse_frontmatter(yaml, warnings));
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
        if let Some(consumed) = parse_fence(normalized, frontmatter, warnings) {
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
            let mut scratch_warn: Vec<String> = Vec::new();
            if let Some(consumed) = parse_fence(trimmed_rest, &mut scratch_fm, &mut scratch_warn)
                && !scratch_fm.is_empty()
            {
                frontmatter.extend(scratch_fm);
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

/// Parse a YAML inline flow sequence (`[a, b, "c, d"]`) into a single
/// comma-joined scalar (#1917). Items are split on top-level commas (commas
/// inside a quoted item do NOT split), each item is trimmed and unquoted via
/// [`strip_yaml_quotes`], and empty items are dropped. The result is the
/// canonical scalar form an exported `aliases: a, b` would carry, so a value
/// parsed here round-trips identically whether it arrived as a flow sequence
/// or as a plain scalar.
fn parse_flow_sequence(raw: &str) -> String {
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
    items.join(", ")
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
fn parse_frontmatter(yaml: &str, warnings: &mut Vec<String>) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut skipped_array = 0usize;
    let mut skipped_invalid = 0usize;

    let mut block: Option<BlockScalar> = None;

    // Block-style sequence state (#1917): a `key:` line with no inline value
    // followed by `- item` lines. Items are collected here and committed as a
    // single comma-joined scalar — the same canonical representation the
    // inline flow-sequence (`[a, b]`) path produces — so block-style and flow
    // `aliases:`/`tags:` both round-trip through single-value property storage.
    struct PendingSeq {
        key: String,
        items: Vec<String>,
    }
    let mut pending_seq: Option<PendingSeq> = None;

    // Commit a finished block-style sequence into `pairs` (de-dup aware),
    // joining its items into a comma-separated scalar. A sequence with no items
    // (`key:` with nothing following) commits as an empty scalar, matching the
    // prior `key:` (empty value) behaviour.
    macro_rules! commit_seq {
        ($s:expr) => {{
            let s = $s;
            let joined = s.items.join(", ");
            if seen.insert(s.key.clone()) {
                pairs.push((s.key, joined));
            } else {
                warnings.push(format!(
                    "frontmatter key '{}' appears more than once; keeping the first value",
                    s.key
                ));
            }
        }};
    }

    for raw in yaml.lines() {
        // While a block scalar is open, a MORE-INDENTED (or blank) line is
        // continuation content and must NOT be mis-counted as invalid. A line
        // indented at-or-below the opening key ends the block; it is then
        // re-processed as a normal frontmatter line below.
        if let Some(b) = block.as_mut() {
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
                continue;
            }
            // Dedent: the block is finished. Commit it, then fall through to
            // process `raw` as an ordinary frontmatter line.
            commit_block(
                block.take().expect("block present"),
                &mut pairs,
                &mut seen,
                warnings,
            );
        }

        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // A bare `- item` line is a YAML block-sequence element belonging to a
        // preceding `key:` with no inline value (#1917). If a sequence is open
        // (the preceding line was `key:`), append the item to it so block-style
        // `aliases:` / `tags:` round-trip exactly as the inline `[a, b]` form
        // does. A `- item` with NO open sequence (a stray bullet) is still
        // parse-and-ignored with a warning. A bare `-` (empty element) is a
        // no-op element.
        if line.starts_with("- ") || line == "-" {
            if let Some(seq) = pending_seq.as_mut() {
                let item = strip_yaml_quotes(line.strip_prefix("- ").unwrap_or("").trim());
                if !item.is_empty() {
                    seq.items.push(item.to_string());
                }
            } else {
                skipped_array += 1;
            }
            continue;
        }
        // Any non-sequence line ends an open block-style sequence: commit it
        // before processing this line as an ordinary frontmatter entry.
        if let Some(seq) = pending_seq.take() {
            commit_seq!(seq);
        }
        let Some((key_raw, value_raw)) = line.split_once(':') else {
            // No colon: not a `key: value` scalar (e.g. a stray scalar or
            // malformed line). Surface it rather than silently swallow.
            skipped_invalid += 1;
            continue;
        };
        let key = key_raw.trim();
        if !is_property_key(key) {
            skipped_invalid += 1;
            continue;
        }
        if FRONTMATTER_RESERVED_KEYS.contains(&key) {
            // Exporter-managed key — silently filtered (it is never meant
            // to round-trip as a user property).
            continue;
        }
        let value_trimmed = value_raw.trim();
        // Block-scalar indicator (#1590): `key: |`, `key: >`, with optional
        // chomping (`-`/`+`) and/or a one-digit indentation indicator, e.g.
        // `|-`, `>+`, `|2`, `>2-`. The subsequent more-indented lines are the
        // value and must not be mis-counted as invalid. Open a block instead
        // of treating the (empty) inline value as a scalar.
        if let Some(spec) = parse_block_scalar_indicator(value_trimmed) {
            block = Some(BlockScalar {
                key: key.to_string(),
                folded: spec.folded,
                key_indent: frontmatter_indent_of(raw),
                content_indent: None,
                lines: Vec::new(),
            });
            continue;
        }
        // Inline flow-sequence syntax (`[a, b]`) — #1917. The exporter writes
        // `aliases: [..]` / `tags: [..]` as YAML flow sequences, so dropping
        // them (the pre-fix behaviour) silently lost every exported alias/tag
        // on re-import. Parse the flow items and join them into a single
        // canonical scalar (`a, b`) — the SAME shape a re-export of the
        // resulting text property would emit — so the value round-trips
        // through the existing single-value property storage
        // (`set_property_in_tx` stamps one row per key; duplicate keys would
        // collapse under its INSERT-OR-REPLACE, so multiple pairs are NOT a
        // viable representation — one joined value is). A flow MAPPING
        // (`{a: b}`) has no single sensible scalar projection and stays
        // skipped-with-warning.
        if value_trimmed.starts_with('[') && value_trimmed.ends_with(']') {
            let joined = parse_flow_sequence(value_trimmed);
            if !seen.insert(key.to_string()) {
                warnings.push(format!(
                    "frontmatter key '{key}' appears more than once; keeping the first value"
                ));
                continue;
            }
            pairs.push((key.to_string(), joined));
            continue;
        }
        if value_trimmed.starts_with('{') && value_trimmed.ends_with('}') {
            skipped_array += 1;
            continue;
        }

        let value = strip_yaml_quotes(value_trimmed);
        // An empty inline value (`key:`) may be the header of a block-style
        // sequence whose `- item` elements follow on subsequent lines (#1917).
        // Open a pending sequence keyed on this line; the `- item` branch above
        // appends to it, and the next non-sequence line (or end of input)
        // commits it. A `key:` with no following `- item` lines commits as an
        // empty scalar (unchanged behaviour).
        if value.is_empty() {
            // Flush any sequence already open for a *different* key first.
            if let Some(seq) = pending_seq.take() {
                commit_seq!(seq);
            }
            pending_seq = Some(PendingSeq {
                key: key.to_string(),
                items: Vec::new(),
            });
            continue;
        }
        if !seen.insert(key.to_string()) {
            warnings.push(format!(
                "frontmatter key '{key}' appears more than once; keeping the first value"
            ));
            continue;
        }
        pairs.push((key.to_string(), value.to_string()));
    }

    // Flush a block scalar still open at end of input.
    if let Some(b) = block.take() {
        commit_block(b, &mut pairs, &mut seen, warnings);
    }
    // Flush a block-style sequence still open at end of input.
    if let Some(seq) = pending_seq.take() {
        commit_seq!(seq);
    }

    if skipped_array > 0 {
        warnings.push(format!(
            "{skipped_array} frontmatter line(s) used array/collection syntax \
             (not yet supported) and were ignored"
        ));
    }
    if skipped_invalid > 0 {
        warnings.push(format!(
            "{skipped_invalid} frontmatter line(s) were not a valid `key: value` scalar \
             and were ignored"
        ));
    }
    pairs
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
/// scalar — defined in [`crate::commands::pages::markdown_yaml`] so the
/// import-side parser and the export-side emitter share one definition (#1920,
/// the symmetric counterpart of `yaml_flow_item`'s quoting).
use crate::commands::pages::markdown_yaml::strip_yaml_quotes;

/// Matches any `((...))` parenthetical token for stripping to plain text.
///
/// This is INTENTIONALLY broad — `\(\([^)]*\)\)` strips arbitrary Logseq
/// `((uuid))` AND `((free text))` tokens — and deliberately DIFFERS from the
/// canonical 26-char-ULID-scoped block-ref pattern used elsewhere
/// (`crate::cache` / `crate::fts`). The import path wants to remove every
/// `((...))` reference (the target block does not exist in the imported vault),
/// so it does not constrain the body to a ULID.
static PARENTHETICAL_REF_STRIP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\([^)]*\)\)").expect("invalid parenthetical-ref regex"));

/// Matches two or more consecutive spaces.
static MULTI_SPACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"  +").expect("invalid multi-space regex"));

/// Strip `((uuid))` block references, reporting how many `((uuid))` block
/// references it removed (#1933). Block-reference stripping is a lossy
/// transform — the reference target is silently dropped — so the import path
/// needs a count to surface an aggregate diagnostic, mirroring the
/// depth-clamp / orphan-property counters. Returns the cleaned text and the
/// number of references removed from this line.
fn strip_block_refs_counted(text: &str) -> (String, usize) {
    // #1921 fast-path: most imported lines carry no `((...))` token, so skip
    // the parenthetical regex entirely when the marker is absent. `find_iter`
    // / `replace_all` only run when a `((` substring is actually present.
    let removed = if text.contains("((") {
        PARENTHETICAL_REF_STRIP_RE.find_iter(text).count()
    } else {
        0
    };
    if removed > 0 {
        // Per-occurrence diagnostic so a stalled or lossy import is
        // traceable line-by-line at debug level; the aggregate warning
        // (assembled by `parse_logseq_markdown`) is the operator-facing
        // summary.
        tracing::debug!(
            removed,
            "stripping ((block-ref)) token(s) from imported line (#1933)"
        );
    }
    // Only run the strip regex when a ref was actually found; otherwise the
    // text is unchanged and we keep a borrow to avoid an allocation.
    let result: std::borrow::Cow<'_, str> = if removed > 0 {
        PARENTHETICAL_REF_STRIP_RE.replace_all(text, "")
    } else {
        std::borrow::Cow::Borrowed(text)
    };
    // Preserve the exact original semantics: trim first, then collapse runs of
    // 2+ spaces. #1921 fast-path: skip the multi-space regex + `to_string`
    // allocation when the trimmed text has no double-space run.
    let trimmed = result.trim();
    let collapsed = if trimmed.contains("  ") {
        MULTI_SPACE_RE.replace_all(trimmed, " ").to_string()
    } else {
        trimmed.to_string()
    };
    (collapsed, removed)
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let output = parse_logseq_markdown("- See ((abc-123)) here");
        assert_eq!(output.blocks[0].content, "See here");
    }

    /// #1933: block-ref stripping is a lossy transform and must surface an
    /// aggregate warning carrying the count of references dropped, mirroring
    /// the depth-clamp / orphan-property counters. The count covers list
    /// items, continuation lines, and bare content lines.
    #[test]
    fn parse_block_refs_stripped_counts_and_warns_1933() {
        let md = "\
- See ((abc-123)) and ((def-456)) here
  continuation with ((ghi-789))
bare line ((jkl-012)) too";
        let output = parse_logseq_markdown(md);
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

    /// #1921 — `strip_block_refs_counted` fast-paths must preserve EXACT
    /// output (trim + 2+-space collapse) across all four input shapes:
    /// no-refs-no-doublespace (both fast paths), refs-only, double-spaces-only,
    /// and both together.
    #[test]
    fn strip_block_refs_fast_paths_preserve_output_1921() {
        // (a) No refs, no double space — both fast paths taken. Trimmed only.
        let (out, removed) = strip_block_refs_counted("  plain text  ");
        assert_eq!(out, "plain text", "trim only; no regex work");
        assert_eq!(removed, 0);

        // (b) Refs only (no double space introduced after strip + trim).
        let (out, removed) = strip_block_refs_counted("a ((ref)) b");
        assert_eq!(out, "a  b".replace("  ", " "), "refs stripped");
        assert_eq!(out, "a b", "single space collapse from the gap");
        assert_eq!(removed, 1);

        // (c) Double spaces only (no refs) — first fast path skips the
        // parenthetical regex, the collapse regex still runs.
        let (out, removed) = strip_block_refs_counted("a    b   c");
        assert_eq!(out, "a b c", "runs of spaces collapse to one");
        assert_eq!(removed, 0);

        // (d) Both refs and double spaces.
        let (out, removed) = strip_block_refs_counted("x  ((r1))  y ((r2)) z");
        assert_eq!(out, "x y z", "refs removed and spaces collapsed");
        assert_eq!(removed, 2);

        // (e) A token-only line collapses to empty after trim.
        let (out, removed) = strip_block_refs_counted("((only))");
        assert_eq!(out, "", "a bare ref line strips to empty");
        assert_eq!(removed, 1);
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
        let mut warns: Vec<String> = Vec::new();
        let body = strip_frontmatter(
            "# My Title\n\n---\ncategory: notes\n---\n\n- body\n",
            &mut fm,
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
        let pairs = parse_frontmatter(
            "homepage: https://example.com/path\nstart: 09:00",
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
        let pairs = parse_frontmatter(
            "title: \"Quoted Value\"\nalias: 'single quoted'",
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
        let mut warns: Vec<String> = Vec::new();
        let input = "---\ncategory: notes\n- a bullet with no closing fence";
        let body = strip_frontmatter(input, &mut fm, &mut warns);
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
        let pairs = parse_frontmatter("tags: [a, b]\ncategory: notes", &mut warns);
        assert_eq!(
            pairs,
            vec![
                ("tags".to_string(), "a, b".to_string()),
                ("category".to_string(), "notes".to_string()),
            ],
            "a flow sequence must be preserved as a comma-joined scalar; got {pairs:?}"
        );
        assert!(
            warns.is_empty(),
            "preserving a flow sequence must not warn; got {warns:?}"
        );
    }

    /// #1917 — a flow sequence whose items are quoted (and contain a comma
    /// inside the quotes) is split only on top-level commas and unquoted.
    #[test]
    fn parse_frontmatter_flow_sequence_quoted_items_split_top_level_only_1917() {
        let mut warns: Vec<String> = Vec::new();
        let pairs = parse_frontmatter(r#"aliases: [Alpha, "Beta, Inc", Gamma]"#, &mut warns);
        assert_eq!(
            pairs,
            vec![("aliases".to_string(), "Alpha, Beta, Inc, Gamma".to_string())],
            "quoted items must not split on their inner comma; got {pairs:?}"
        );
    }

    /// #1917 — block-style sequences (`key:` then `- item` lines) round-trip
    /// identically to the inline flow form.
    #[test]
    fn parse_frontmatter_block_sequence_is_preserved_as_joined_scalar_1917() {
        let mut warns: Vec<String> = Vec::new();
        let pairs = parse_frontmatter(
            "aliases:\n  - First\n  - Second\ncategory: notes",
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
        let pairs = parse_frontmatter("meta: {a: 1}\ncategory: notes", &mut warns);
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
        let pairs = parse_frontmatter(
            "summary: |\n  first line\n  second line\ncategory: notes",
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
        let pairs = parse_frontmatter("desc: >\n  one\n  two\n  three", &mut warns);
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
        let pairs = parse_frontmatter(
            "lit: |-\n  alpha\n  beta\nfold: >+\n  gamma\n  delta",
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
        let pairs = parse_frontmatter("category: notes\nthis is not yaml", &mut warns);
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
        let pairs = parse_frontmatter("title: Hello\nstatus: draft", &mut warns);
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
        let pairs = parse_frontmatter("title: A\ntitle: B", &mut warns);
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
        let pairs = parse_frontmatter("note: |\n  x\nnote: |\n  y", &mut warns);
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

    /// #1922 (`no-direct-helper-unit-tests`) — `strip_yaml_quotes` only
    /// strips when BOTH ends match the SAME quote char. Pins the edge cases:
    /// matched pair stripped, mismatched/single/too-short left verbatim,
    /// empty-quoted collapses to empty.
    #[test]
    fn strip_yaml_quotes_edge_cases_1922() {
        // Matched double / single quotes: one layer removed.
        assert_eq!(strip_yaml_quotes("\"abc\""), "abc");
        assert_eq!(strip_yaml_quotes("'abc'"), "abc");
        // Empty quoted string -> empty.
        assert_eq!(strip_yaml_quotes("\"\""), "");
        assert_eq!(strip_yaml_quotes("''"), "");
        // Mismatched quote chars: NOT stripped (both ends must match).
        assert_eq!(strip_yaml_quotes("\"abc'"), "\"abc'");
        assert_eq!(strip_yaml_quotes("'abc\""), "'abc\"");
        // A single leading/trailing quote with no closing partner: untouched.
        assert_eq!(strip_yaml_quotes("\"abc"), "\"abc");
        assert_eq!(strip_yaml_quotes("abc\""), "abc\"");
        // 1-char string (len < 2): never stripped, even a lone quote.
        assert_eq!(strip_yaml_quotes("\""), "\"");
        assert_eq!(strip_yaml_quotes("x"), "x");
        // No quotes at all: returned verbatim.
        assert_eq!(strip_yaml_quotes("plain"), "plain");
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
