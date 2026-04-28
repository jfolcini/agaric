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
/// emitted.  The cap matches the recursive-CTE depth bound enforced
/// throughout the materialiser (see AGENTS.md "Recursive CTEs over
/// `blocks`") and prevents pathologically deep imports from triggering
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
    pub warnings: Vec<String>,
}

/// Parse Logseq-style indented markdown into a list of blocks with depth.
///
/// Each line starting with `- ` (after optional indentation) is a block.
/// Indentation determines depth (2 spaces = 1 level).
/// Lines with `key:: value` pattern (no `- ` prefix, indented under a block)
/// are treated as properties of the preceding block.
/// `((uuid))` references are converted to plain text.
pub fn parse_logseq_markdown(content: &str) -> ParseOutput {
    let mut blocks: Vec<ParsedBlock> = Vec::new();

    // Normalize line endings BEFORE any other parsing. The frontmatter strip
    // below uses `find("\n---")`, which is fragile against CRLF (works only
    // because `\n---` is a substring of `\r\n---`) and outright broken for
    // CR-only files (classic Mac), where no `\n` exists at all and the entire
    // frontmatter would otherwise be retained as block content. Doing this
    // first also lets `body.lines()` and the indent calculation see clean
    // lines without stray `\r` characters. (REVIEW-LATER L-9)
    let normalized_eol = content.replace("\r\n", "\n").replace('\r', "\n");

    // Normalize tabs to 2 spaces for consistent indentation parsing
    let normalized = normalized_eol.replace('\t', "  ");

    // Skip YAML frontmatter (--- delimited block at start of file)
    let body = if let Some(stripped) = normalized.strip_prefix("---") {
        if let Some(end) = stripped.find("\n---") {
            &stripped[end + 4..] // skip past closing ---
        } else {
            &normalized // no closing ---, treat as content
        }
    } else {
        &normalized
    };

    let lines: Vec<&str> = body.lines().collect();
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
            // Attach to the last block at or above this depth
            if let Some(last) = blocks.last_mut() {
                last.properties.push((key, value));
            }
        } else {
            // Non-list, non-property line -- treat as a content block
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

    let mut warnings = Vec::new();
    if clamped_count > 0 {
        warnings.push(format!(
            "{clamped_count} block(s) exceeded maximum depth of {MAX_IMPORT_DEPTH} and were flattened"
        ));
    }

    ParseOutput { blocks, warnings }
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
        // Block 1 plus the free-form follow-up — TWO blocks total, ZERO
        // properties on Block 1.
        assert_eq!(
            output.blocks.len(),
            2,
            "URL-bearing line must become its own content block, not a \
             property of Block 1; got {:?}",
            output.blocks
        );
        assert_eq!(output.blocks[0].content, "Block 1");
        assert!(
            output.blocks[0].properties.is_empty(),
            "Block 1 must have no properties; got {:?}",
            output.blocks[0].properties
        );
        assert!(
            output.blocks[1].content.contains("https://example.com/foo"),
            "URL-bearing line must round-trip as content; got {:?}",
            output.blocks[1].content
        );
    }

    /// I-Core-10: prose-style `Some text :: notes` lines (no list prefix, no
    /// valid key alphabet) must also fall through to the content-block branch.
    #[test]
    fn parse_prose_with_double_colon_is_content_i_core_10() {
        let output = parse_logseq_markdown("- Parent\n  Some text :: notes :: more");
        assert_eq!(
            output.blocks.len(),
            2,
            "free-form line must become its own content block; got {:?}",
            output.blocks
        );
        assert_eq!(output.blocks[0].content, "Parent");
        assert!(
            output.blocks[0].properties.is_empty(),
            "Parent must have no properties; got {:?}",
            output.blocks[0].properties
        );
        assert_eq!(output.blocks[1].content, "Some text :: notes :: more");
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
        assert_eq!(output.blocks.len(), 2, "oversized key must become content");
        assert!(
            output.blocks[0].properties.is_empty(),
            "Parent must have no property when key is >64 chars"
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

/// REVIEW-LATER L-9 — Line-ending normalization in front of the YAML
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
