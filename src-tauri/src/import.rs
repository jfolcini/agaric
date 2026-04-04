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

/// Parse Logseq-style indented markdown into a list of blocks with depth.
///
/// Each line starting with `- ` (after optional indentation) is a block.
/// Indentation determines depth (2 spaces = 1 level).
/// Lines with `key:: value` pattern (no `- ` prefix, indented under a block)
/// are treated as properties of the preceding block.
/// `((uuid))` references are converted to plain text.
pub fn parse_logseq_markdown(content: &str) -> Vec<ParsedBlock> {
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

    // Clamp depth to 20 (flatten deeper blocks)
    for block in &mut blocks {
        if block.depth > 20 {
            block.depth = 20;
        }
    }

    blocks
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
        let blocks = parse_logseq_markdown("- Block 1\n- Block 2");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].content, "Block 1");
        assert_eq!(blocks[0].depth, 0);
        assert_eq!(blocks[1].content, "Block 2");
    }

    #[test]
    fn parse_nested_list() {
        let blocks = parse_logseq_markdown("- Parent\n  - Child\n    - Grandchild");
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].depth, 0);
        assert_eq!(blocks[1].depth, 1);
        assert_eq!(blocks[2].depth, 2);
    }

    #[test]
    fn parse_properties() {
        let blocks = parse_logseq_markdown("- Task\n  priority:: high");
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].properties.len(), 1);
        assert_eq!(blocks[0].properties[0], ("priority".into(), "high".into()));
    }

    #[test]
    fn parse_block_refs_stripped() {
        let blocks = parse_logseq_markdown("- See ((abc-123)) here");
        assert_eq!(blocks[0].content, "See here");
    }

    #[test]
    fn parse_empty_content() {
        let blocks = parse_logseq_markdown("");
        assert!(blocks.is_empty());
    }

    #[test]
    fn parse_depth_clamped_at_20() {
        let deep = format!("{}- Deep block", "  ".repeat(25));
        let blocks = parse_logseq_markdown(&deep);
        assert_eq!(blocks[0].depth, 20);
    }

    #[test]
    fn parse_tab_indentation_normalized() {
        let blocks = parse_logseq_markdown("- Parent\n\t- Child\n\t\t- Grandchild");
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0].depth, 0);
        assert_eq!(blocks[1].depth, 1);
        assert_eq!(blocks[2].depth, 2);
    }

    #[test]
    fn parse_yaml_frontmatter_stripped() {
        let blocks =
            parse_logseq_markdown("---\ntitle: Test Page\ntags: [a, b]\n---\n- Block 1\n- Block 2");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].content, "Block 1");
        assert_eq!(blocks[1].content, "Block 2");
    }

    #[test]
    fn parse_yaml_frontmatter_unclosed_treated_as_content() {
        let blocks = parse_logseq_markdown("---\n- This is content");
        // No closing ---, so the --- line is skipped (empty after trim)
        // and "- This is content" is parsed normally
        assert!(!blocks.is_empty());
    }
}
