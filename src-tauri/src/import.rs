//! Logseq/Markdown import parser.
//!
//! Parses indented markdown into a flat list of blocks with parent/child
//! relationships determined by indentation level.

use regex::Regex;
use serde::Serialize;
use specta::Type;
use std::sync::LazyLock;

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

    // Normalize tabs to 2 spaces for consistent indentation parsing
    let normalized = content.replace('\t', "  ");

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
        } else if trimmed.contains(":: ") {
            // Property line: `key:: value`
            if let Some((key, value)) = trimmed.split_once(":: ") {
                let key = key.trim().to_string();
                let value = value.trim().to_string();
                // Attach to the last block at or above this depth
                if let Some(last) = blocks.last_mut() {
                    last.properties.push((key, value));
                }
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

    // Clamp depth to 20 (flatten deeper blocks) and track how many were clamped
    let mut clamped_count: usize = 0;
    for block in &mut blocks {
        if block.depth > 20 {
            block.depth = 20;
            clamped_count += 1;
        }
    }

    let mut warnings = Vec::new();
    if clamped_count > 0 {
        warnings.push(format!(
            "{clamped_count} block(s) exceeded maximum depth of 20 and were flattened"
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
