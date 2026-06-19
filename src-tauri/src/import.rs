//! Logseq/Markdown import parser.
//!
//! Parses indented markdown into a flat list of blocks with parent/child
//! relationships determined by indentation level.

use regex::Regex;
use serde::Serialize;
use specta::Type;
use std::sync::LazyLock;

/// Maximum block-tree depth permitted by the import parser.  Blocks
/// nested below this level are flattened to this depth and a warning is
/// emitted.  This is a deliberately conservative, import-specific limit:
/// it sits well under the recursive-CTE depth bound of `depth < 100`
/// enforced throughout the materialiser (Invariant #9; see AGENTS.md
/// "Recursive CTEs over `blocks`").  It is *not* the same value as the
/// CTE bound — clamping imports far earlier keeps real-world documents
/// shallow and prevents pathologically deep imports from approaching
/// query-time recursion limits.
const MAX_IMPORT_DEPTH: usize = 20;

/// A parsed block from the import.
#[derive(Debug, Clone)]
pub struct ParsedBlock {
    pub content: String,
    pub depth: usize,
    pub properties: Vec<(String, String)>,
}

/// Result of parsing a markdown file.
#[derive(Debug, Clone, Serialize, Type)]
pub struct ImportResult {
    pub page_title: String,
    pub blocks_created: i64,
    pub properties_set: i64,
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

/// Streaming progress payload for a single `import_markdown` call (#128,
/// PEND-38 / PEND-06 Tier 3).
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
        // Best-effort: a dropped channel must not fail the import.
        let _ = self.send(update);
    }
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

    // Normalize line endings BEFORE any other parsing. The frontmatter strip
    // below uses `find("\n---")`, which is fragile against CRLF (works only
    // because `\n---` is a substring of `\r\n---`) and outright broken for
    // CR-only files (classic Mac), where no `\n` exists at all and the entire
    // frontmatter would otherwise be retained as block content. Doing this
    // first also lets `body.lines()` and the indent calculation see clean
    // lines without stray `\r` characters. (L-9)
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

    let lines: Vec<&str> = normalized.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();

        // Skip empty lines
        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        // Calculate indentation (number of leading spaces / 2)
        let indent = line.len() - trimmed.len();
        let depth = indent / 2;

        // Check if this is a list item (- prefix)
        if let Some(text) = trimmed.strip_prefix("- ") {
            // Strip ((uuid)) block references -> plain text
            let cleaned = strip_block_refs(text);

            blocks.push(ParsedBlock {
                content: cleaned,
                depth,
                properties: Vec::new(),
            });
        } else if let Some((key_candidate, value)) = trimmed
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
            let cleaned = strip_block_refs(trimmed);
            if !cleaned.is_empty() {
                if !last.content.is_empty() {
                    last.content.push('\n');
                }
                last.content.push_str(&cleaned);
            }
        } else {
            // Non-list, non-property line with no preceding block (file starts
            // with bare text) -- treat as a standalone depth-0 content block.
            let cleaned = strip_block_refs(trimmed);
            blocks.push(ParsedBlock {
                content: cleaned,
                depth,
                properties: Vec::new(),
            });
        }

        i += 1;
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
fn strip_frontmatter(
    normalized: &str,
    frontmatter: &mut Vec<(String, String)>,
    warnings: &mut Vec<String>,
) -> String {
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
            return normalized[consumed..].to_string();
        }
        return normalized.to_string();
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
        if trimmed_rest.starts_with("---")
            && let Some(consumed) = parse_fence(trimmed_rest, frontmatter, warnings)
        {
            // Reassemble: heading line + the body after the fence.
            let after_fence = &trimmed_rest[consumed..];
            let mut out = String::with_capacity(heading.len() + after_fence.len());
            out.push_str(heading);
            out.push_str(after_fence);
            return out;
        }
    }

    normalized.to_string()
}

fn parse_frontmatter(yaml: &str, warnings: &mut Vec<String>) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut skipped_array = 0usize;
    let mut skipped_invalid = 0usize;

    // Block-scalar state. When a key line ends with a `|` / `>` indicator
    // (#1590), the subsequent MORE-INDENTED lines are continuation content
    // belonging to that key — valid YAML, NOT invalid top-level lines. We
    // capture them, join into a single scalar value, and commit on the first
    // line that dedents out of the block (or at end of input).
    struct BlockScalar {
        key: String,
        folded: bool,
        chomp_strip: bool,
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
    fn indent_of(raw: &str) -> usize {
        raw.chars().take_while(|c| *c == ' ' || *c == '\t').count()
    }

    let mut block: Option<BlockScalar> = None;

    // Commit a finished block scalar into `pairs` (de-dup aware), joining its
    // captured continuation lines. Literal (`|`) joins with newlines; folded
    // (`>`) joins with spaces. Chomping `-` strips the trailing newline (we
    // never append one, so `-` vs clip/keep only matters for an explicit
    // final newline, which we omit either way — the captured text is the
    // value). Returns nothing; mutates the shared collections.
    macro_rules! commit_block {
        ($b:expr) => {{
            let b = $b;
            let joined = if b.folded {
                b.lines.join(" ")
            } else {
                b.lines.join("\n")
            };
            // Chomping is accepted/parsed; the joined value carries no
            // trailing newline regardless, so `chomp_strip` is recorded for
            // completeness without altering the (newline-free) result.
            let _ = b.chomp_strip;
            if seen.insert(b.key.clone()) {
                pairs.push((b.key, joined));
            } else {
                warnings.push(format!(
                    "frontmatter key '{}' appears more than once; keeping the first value",
                    b.key
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
            let raw_indent = indent_of(raw);
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
                        .map(|(i, _)| i)
                        .unwrap_or(raw.len())..]
                        .to_string()
                } else {
                    String::new()
                };
                b.lines.push(stripped);
                continue;
            }
            // Dedent: the block is finished. Commit it, then fall through to
            // process `raw` as an ordinary frontmatter line.
            commit_block!(block.take().expect("block present"));
        }

        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // A bare `- item` line is a YAML sequence element belonging to a
        // preceding `key:` with no inline value — block-style arrays are
        // #1433 scope. Parse-and-ignore with a warning.
        if line.starts_with("- ") || line == "-" {
            skipped_array += 1;
            continue;
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
                chomp_strip: spec.chomp_strip,
                key_indent: indent_of(raw),
                content_indent: None,
                lines: Vec::new(),
            });
            continue;
        }
        let value = strip_yaml_quotes(value_trimmed);
        // Inline array/flow-collection syntax (`[a, b]` / `{a: b}`): out of
        // scope (#1433). Parse-and-ignore with a warning rather than import
        // the literal bracketed text as a scalar.
        if (value.starts_with('[') && value.ends_with(']'))
            || (value.starts_with('{') && value.ends_with('}'))
        {
            skipped_array += 1;
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
        commit_block!(b);
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
    /// `true` when the strip chomping indicator (`-`) is present.
    chomp_strip: bool,
}

/// Recognise a YAML block-scalar indicator as the inline value of a `key:`
/// line. Accepts `|`, `>`, optionally followed (in either order, per the YAML
/// spec) by a chomping indicator (`-`/`+`) and/or a single indentation digit
/// (`1`–`9`), e.g. `|`, `>-`, `|+`, `|2`, `>2-`. A trailing line comment
/// (`# …`) is tolerated. Returns `None` for any other value (a normal scalar).
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
    let mut chomp_strip = false;
    for c in chars {
        match c {
            '-' => chomp_strip = true,
            '+' => {}         // keep chomping — accepted, no effect here
            '1'..='9' => {}   // explicit indentation indicator — accepted
            _ => return None, // anything else: not a block-scalar header
        }
    }
    Some(BlockScalarSpec {
        folded,
        chomp_strip,
    })
}

/// Strip a single layer of matching surrounding quotes (`"…"` or `'…'`)
/// from a frontmatter scalar value. YAML quoting is preserved on export
/// only when a value needs it; Agaric's exporter currently emits bare
/// scalars, but accepting quoted values keeps the importer tolerant of
/// hand-edited / third-party frontmatter without pulling in a YAML crate.
fn strip_yaml_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

/// Matches `((uuid))` block references.
static BLOCK_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(\([^)]*\)\)").expect("invalid block ref regex"));

/// Matches two or more consecutive spaces.
static MULTI_SPACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"  +").expect("invalid multi-space regex"));

/// Strip `((uuid))` block references, replacing with their inner text or removing them.
fn strip_block_refs(text: &str) -> String {
    let result = BLOCK_REF_RE.replace_all(text, "");
    MULTI_SPACE_RE.replace_all(result.trim(), " ").to_string()
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
    fn parse_block_refs_stripped() {
        let output = parse_logseq_markdown("- See ((abc-123)) here");
        assert_eq!(output.blocks[0].content, "See here");
    }

    #[test]
    fn parse_empty_content() {
        let output = parse_logseq_markdown("");
        assert!(output.blocks.is_empty());
    }

    #[test]
    fn parse_depth_clamped_at_20() {
        let deep = format!("{}- Deep block", "  ".repeat(25));
        let output = parse_logseq_markdown(&deep);
        assert_eq!(output.blocks[0].depth, 20);
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
    #[test]
    fn parse_frontmatter_array_value_is_ignored_with_warning_1432() {
        let mut warns: Vec<String> = Vec::new();
        let pairs = parse_frontmatter("tags: [a, b]\ncategory: notes", &mut warns);
        assert_eq!(
            pairs,
            vec![("category".to_string(), "notes".to_string())],
            "the array line must be ignored; only the scalar survives; got {pairs:?}"
        );
        assert!(
            warns.iter().any(|w| w.contains("array/collection syntax")),
            "an array-syntax warning must be emitted; got {warns:?}"
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

        // All deep blocks should be clamped to 20
        for block in &output.blocks[1..] {
            assert_eq!(block.depth, 20, "block depth should be clamped to 20");
        }

        // Warnings should contain a depth-clamping message
        assert_eq!(output.warnings.len(), 1, "should have exactly one warning");
        assert!(
            output.warnings[0]
                .contains("3 block(s) exceeded maximum depth of 20 and were flattened"),
            "warning message should describe clamped blocks, got: {}",
            output.warnings[0]
        );
    }
}

/// L-9 — Line-ending normalization in front of the YAML
/// frontmatter strip. The strip uses `find("\n---")`, so CRLF and lone-CR
/// inputs must be normalized to LF first. Tests live in their own module
/// (per the L-9 review note) to keep the regression surface explicit.
#[cfg(test)]
mod tests_l9 {
    use super::*;

    #[test]
    fn crlf_frontmatter_is_stripped() {
        // Exact fixture from the L-9 review note.
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
        // TEST-50: single fixture mixing all three styles (CRLF, LF, lone
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
