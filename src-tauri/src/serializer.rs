//! Org-mode serializer: round-trip conversion between Org markup and a typed
//! document model.
//!
//! # Architecture
//!
//! ```text
//!   Org text --> org_parser::parse() --> OrgDoc --> org_emitter::emit() --> Org text
//! ```
//!
//! # Review findings addressed
//!
//! | Finding | Status | Notes |
//! |---------|--------|-------|
//! | **F01** | Fixed  | Entity map checked for uniqueness at init time. |
//! | **F02** | Fixed  | `OrgSerializerConfig::reconfigure` merges fields instead of replacing. |
//! | **F03-F05** | Fixed | Timestamps and footnotes parsed/emitted. Unsupported constructs documented in org_parser. |
//! | **F06** | Documented | Unicode normalization is a known Phase 1 limitation. |
//! | **F07** | Fixed | `parse_checked` enforces a 1 MiB input size limit. |
//! | **F08** | Fixed | Parser and emitter share `ESCAPE_CHARS` -- single source of truth. |
//! | **F09** | Tested | Round-trip tests for all escape sequences. |
//! | **F10** | Tested | Entity uniqueness assertion. |
//! | **F11** | Tested | Large-input size guard test. |
//! | **F12** | Tested | Unicode edge cases: combining characters, ZWJ sequences, etc. |

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::error::AppError;

// Re-exports
pub use crate::org_emitter::emit;
pub use crate::org_parser::parse;

// ---------------------------------------------------------------------------
// Size limit (F07)
// ---------------------------------------------------------------------------

/// Maximum input size for `parse_checked`, in bytes.
pub const MAX_INPUT_SIZE: usize = 1024 * 1024; // 1 MiB

/// Parse Org text with a size guard (F07).
pub fn parse_checked(org: &str) -> Result<OrgDoc, AppError> {
    if org.len() > MAX_INPUT_SIZE {
        return Err(AppError::Validation(format!(
            "Input size {} bytes exceeds maximum of {} bytes",
            org.len(),
            MAX_INPUT_SIZE
        )));
    }
    Ok(parse(org))
}

// ---------------------------------------------------------------------------
// Escape characters -- single source of truth (F08)
// ---------------------------------------------------------------------------

/// Characters that can be escaped with a leading backslash in Org text.
///
/// **Invariant:** both `org_parser` and `org_emitter` MUST use this exact set.
pub const ESCAPE_CHARS: &[char] = &['*', '/', '~', '\\', '#', '['];

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgDoc {
    pub paragraphs: Vec<OrgParagraph>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgParagraph {
    pub content: Vec<InlineNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum InlineNode {
    Text(TextNode),
    TagRef { id: String },
    BlockLink { id: String },
    Entity { name: String, unicode: String },
    Timestamp(OrgTimestamp),
    FootnoteRef { label: String },
    HardBreak,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextNode {
    pub text: String,
    pub marks: Vec<OrgMark>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum OrgMark {
    Bold,
    Italic,
    Code,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrgTimestamp {
    pub active: bool,
    pub date: String,
    pub time: Option<String>,
}

// ---------------------------------------------------------------------------
// Configuration (F02)
// ---------------------------------------------------------------------------

/// # WARNING (F02)
///
/// In TipTap/ProseMirror, calling `state.reconfigure({})` with a partial
/// config **replaces** the extension list, dropping ALL plugins.
/// This Rust-side config avoids that trap: `reconfigure` performs a
/// **merge**, not a replacement.
#[derive(Debug, Clone)]
pub struct OrgSerializerConfig {
    pub max_input_size: usize,
    pub emit_entities_as_names: bool,
}

impl Default for OrgSerializerConfig {
    fn default() -> Self {
        Self {
            max_input_size: MAX_INPUT_SIZE,
            emit_entities_as_names: true,
        }
    }
}

impl OrgSerializerConfig {
    /// Merge updated fields into the current config, preserving existing values
    /// for any field not explicitly set.
    ///
    /// # F02 WARNING
    ///
    /// This intentionally uses Option-based merging. Unlike TipTap's
    /// `state.reconfigure({})` which **replaces** the entire config (dropping
    /// plugins), this method only overwrites fields that are `Some`.
    pub fn reconfigure(&mut self, update: OrgSerializerConfigUpdate) {
        if let Some(max) = update.max_input_size {
            self.max_input_size = max;
        }
        if let Some(emit) = update.emit_entities_as_names {
            self.emit_entities_as_names = emit;
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct OrgSerializerConfigUpdate {
    pub max_input_size: Option<usize>,
    pub emit_entities_as_names: Option<bool>,
}

// ---------------------------------------------------------------------------
// Entity map (F01)
// ---------------------------------------------------------------------------

pub static ENTITIES: LazyLock<FxHashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let pairs: &[(&str, &str)] = &[
        ("alpha", "\u{03B1}"),
        ("beta", "\u{03B2}"),
        ("gamma", "\u{03B3}"),
        ("delta", "\u{03B4}"),
        ("epsilon", "\u{03B5}"),
        ("zeta", "\u{03B6}"),
        ("eta", "\u{03B7}"),
        ("theta", "\u{03B8}"),
        ("iota", "\u{03B9}"),
        ("kappa", "\u{03BA}"),
        ("lambda", "\u{03BB}"),
        ("mu", "\u{03BC}"),
        ("nu", "\u{03BD}"),
        ("xi", "\u{03BE}"),
        ("omicron", "\u{03BF}"),
        ("pi", "\u{03C0}"),
        ("rho", "\u{03C1}"),
        ("sigma", "\u{03C3}"),
        ("tau", "\u{03C4}"),
        ("upsilon", "\u{03C5}"),
        ("phi", "\u{03C6}"),
        ("chi", "\u{03C7}"),
        ("psi", "\u{03C8}"),
        ("omega", "\u{03C9}"),
        ("Alpha", "\u{0391}"),
        ("Beta", "\u{0392}"),
        ("Gamma", "\u{0393}"),
        ("Delta", "\u{0394}"),
        ("Epsilon", "\u{0395}"),
        ("Zeta", "\u{0396}"),
        ("Eta", "\u{0397}"),
        ("Theta", "\u{0398}"),
        ("Iota", "\u{0399}"),
        ("Kappa", "\u{039A}"),
        ("Lambda", "\u{039B}"),
        ("Mu", "\u{039C}"),
        ("Nu", "\u{039D}"),
        ("Xi", "\u{039E}"),
        ("Omicron", "\u{039F}"),
        ("Pi", "\u{03A0}"),
        ("Rho", "\u{03A1}"),
        ("Sigma", "\u{03A3}"),
        ("Tau", "\u{03A4}"),
        ("Upsilon", "\u{03A5}"),
        ("Phi", "\u{03A6}"),
        ("Chi", "\u{03A7}"),
        ("Psi", "\u{03A8}"),
        ("Omega", "\u{03A9}"),
        ("infty", "\u{221E}"),
        ("pm", "\u{00B1}"),
        ("times", "\u{00D7}"),
        ("div", "\u{00F7}"),
        ("ne", "\u{2260}"),
        ("le", "\u{2264}"),
        ("ge", "\u{2265}"),
        ("approx", "\u{2248}"),
        ("sum", "\u{2211}"),
        ("prod", "\u{220F}"),
        ("int", "\u{222B}"),
        ("sqrt", "\u{221A}"),
        ("partial", "\u{2202}"),
        ("nabla", "\u{2207}"),
        ("forall", "\u{2200}"),
        ("exists", "\u{2203}"),
        ("empty", "\u{2205}"),
        ("isin", "\u{2208}"),
        ("notin", "\u{2209}"),
        ("subset", "\u{2282}"),
        ("supset", "\u{2283}"),
        ("cup", "\u{222A}"),
        ("cap", "\u{2229}"),
        ("to", "\u{2192}"),
        ("gets", "\u{2190}"),
        ("uparrow", "\u{2191}"),
        ("downarrow", "\u{2193}"),
        ("leftrightarrow", "\u{2194}"),
        ("Rightarrow", "\u{21D2}"),
        ("Leftarrow", "\u{21D0}"),
        ("Leftrightarrow", "\u{21D4}"),
        ("mdash", "\u{2014}"),
        ("ndash", "\u{2013}"),
        ("laquo", "\u{00AB}"),
        ("raquo", "\u{00BB}"),
        ("lsquo", "\u{2018}"),
        ("rsquo", "\u{2019}"),
        ("ldquo", "\u{201C}"),
        ("rdquo", "\u{201D}"),
        ("hellip", "\u{2026}"),
        ("dag", "\u{2020}"),
        ("ddag", "\u{2021}"),
        ("sect", "\u{00A7}"),
        ("para", "\u{00B6}"),
        ("copy", "\u{00A9}"),
        ("reg", "\u{00AE}"),
        ("trade", "\u{2122}"),
        ("deg", "\u{00B0}"),
        ("micro", "\u{00B5}"),
        ("cent", "\u{00A2}"),
        ("pound", "\u{00A3}"),
        ("euro", "\u{20AC}"),
        ("yen", "\u{00A5}"),
    ];
    let mut map = FxHashMap::with_capacity_and_hasher(pairs.len(), Default::default());
    for &(name, unicode) in pairs {
        let prev = map.insert(name, unicode);
        assert!(
            prev.is_none(),
            "ENTITY MAP COLLISION: duplicate key '{name}'"
        );
    }
    map
});

pub static REVERSE_ENTITIES: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut map = HashMap::with_capacity(ENTITIES.len());
    for (&name, &unicode) in ENTITIES.iter() {
        let prev = map.insert(unicode, name);
        assert!(prev.is_none(),
            "REVERSE ENTITY MAP COLLISION: duplicate unicode '{unicode}' (names: '{prev:?}' and '{name}')");
    }
    map
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE_ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    fn round_trip(input: &str) -> String {
        emit(&parse(input))
    }

    // F01 -- Entity map collision check
    #[test]
    fn entity_map_no_key_collisions() {
        let _ = ENTITIES.len();
    }
    #[test]
    fn entity_map_no_value_collisions() {
        let _ = REVERSE_ENTITIES.len();
    }
    #[test]
    fn entity_map_roundtrip() {
        for (&name, &unicode) in ENTITIES.iter() {
            assert_eq!(REVERSE_ENTITIES.get(unicode), Some(&name));
        }
    }
    #[test]
    fn entity_map_nonempty() {
        assert!(ENTITIES.len() > 50);
    }

    // F02 -- reconfigure
    #[test]
    fn reconfigure_preserves_unset() {
        let mut c = OrgSerializerConfig {
            max_input_size: 42,
            emit_entities_as_names: false,
        };
        c.reconfigure(OrgSerializerConfigUpdate {
            max_input_size: Some(100),
            emit_entities_as_names: None,
        });
        assert_eq!(c.max_input_size, 100);
        assert!(!c.emit_entities_as_names);
    }
    #[test]
    fn reconfigure_empty_noop() {
        let orig = OrgSerializerConfig::default();
        let mut c = orig.clone();
        c.reconfigure(OrgSerializerConfigUpdate::default());
        assert_eq!(c.max_input_size, orig.max_input_size);
    }

    // F07 -- Size guard
    #[test]
    fn parse_checked_ok() {
        assert!(parse_checked("hello").is_ok());
    }
    #[test]
    fn parse_checked_at_limit() {
        assert!(parse_checked(&"a".repeat(MAX_INPUT_SIZE)).is_ok());
    }
    #[test]
    fn parse_checked_over_limit() {
        assert!(parse_checked(&"a".repeat(MAX_INPUT_SIZE + 1)).is_err());
    }

    // F08 -- Escape chars
    #[test]
    fn escape_chars_complete() {
        for c in &['*', '/', '~', '\\', '#', '['] {
            assert!(ESCAPE_CHARS.contains(c));
        }
    }

    // F09 -- Round-trip tests
    #[test]
    fn rt_plain() {
        assert_eq!(round_trip("hello world"), "hello world");
    }
    #[test]
    fn rt_bold() {
        assert_eq!(round_trip("*hello*"), "*hello*");
    }
    #[test]
    fn rt_italic() {
        assert_eq!(round_trip("/hello/"), "/hello/");
    }
    #[test]
    fn rt_code() {
        assert_eq!(round_trip("~hello~"), "~hello~");
    }
    #[test]
    fn rt_esc_bold() {
        assert_eq!(round_trip("\\*x\\*"), "\\*x\\*");
    }
    #[test]
    fn rt_esc_italic() {
        assert_eq!(round_trip("\\/x\\/"), "\\/x\\/");
    }
    #[test]
    fn rt_esc_code() {
        assert_eq!(round_trip("\\~x\\~"), "\\~x\\~");
    }
    #[test]
    fn rt_esc_backslash() {
        assert_eq!(round_trip("a\\\\b"), "a\\\\b");
    }
    #[test]
    fn rt_esc_hash() {
        assert_eq!(round_trip("\\#[fake]"), "\\#[fake]");
    }
    #[test]
    fn rt_esc_bracket() {
        assert_eq!(round_trip("\\[[fake]]"), "\\[[fake]]");
    }
    #[test]
    fn rt_tag_ref() {
        let i = format!("#[{FIXTURE_ULID}]");
        assert_eq!(round_trip(&i), i);
    }
    #[test]
    fn rt_block_link() {
        let i = format!("[[{FIXTURE_ULID}]]");
        assert_eq!(round_trip(&i), i);
    }
    #[test]
    fn rt_entity() {
        assert_eq!(round_trip("\\alpha"), "\\alpha");
    }
    #[test]
    fn rt_timestamp() {
        assert_eq!(round_trip("<2024-01-15 Mon>"), "<2024-01-15 Mon>");
    }
    #[test]
    fn rt_footnote() {
        assert_eq!(round_trip("[fn:1]"), "[fn:1]");
    }
    #[test]
    fn rt_multi_para() {
        assert_eq!(round_trip("a\nb\nc"), "a\nb\nc");
    }
    #[test]
    fn rt_empty() {
        assert_eq!(round_trip(""), "");
    }
    #[test]
    fn rt_stable_fixed_point() {
        let tag = format!("#[{FIXTURE_ULID}]");
        let link = format!("[[{FIXTURE_ULID}]]");
        for input in &[
            "hello",
            "*b*",
            "\\*x\\*",
            "\\alpha",
            tag.as_str(),
            link.as_str(),
            "<2024-01-15 Mon>",
            "[fn:1]",
            "a\\\\b",
            "\\#[f]",
            "\\[[f]]",
        ] {
            let once = round_trip(input);
            let twice = round_trip(&once);
            assert_eq!(once, twice, "fixed point for {input:?}");
        }
    }

    // F12 -- Unicode edge cases
    #[test]
    fn uni_combining() {
        let i = "caf\u{0065}\u{0301}";
        assert_eq!(round_trip(i), i);
    }
    #[test]
    fn uni_precomposed() {
        let i = "caf\u{00E9}";
        assert_eq!(round_trip(i), i);
    }
    #[test]
    fn uni_zwj() {
        let i = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
        assert_eq!(round_trip(i), i);
    }
    #[test]
    fn uni_cjk() {
        assert_eq!(
            round_trip("\u{65E5}\u{672C}\u{8A9E}"),
            "\u{65E5}\u{672C}\u{8A9E}"
        );
    }
    #[test]
    fn uni_emoji_bold() {
        assert_eq!(round_trip("*\u{1F389}*"), "*\u{1F389}*");
    }
    #[test]
    fn uni_rtl() {
        let i = "\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}";
        assert_eq!(round_trip(i), i);
    }
    #[test]
    fn uni_mixed() {
        assert_eq!(
            round_trip("Hello \u{043C}\u{0438}\u{0440}"),
            "Hello \u{043C}\u{0438}\u{0440}"
        );
    }
    #[test]
    fn uni_zwsp() {
        let i = "a\u{200B}b";
        assert_eq!(round_trip(i), i);
    }
    #[test]
    fn uni_combining_bold() {
        let i = "*cafe\u{0301}*";
        assert_eq!(round_trip(i), i);
    }
    #[test]
    fn uni_astral() {
        let i = "\u{1F680}\u{1F525}\u{1F4A1}";
        assert_eq!(round_trip(i), i);
    }

    // Serde
    #[test]
    fn doc_serde_roundtrip() {
        let d = OrgDoc {
            paragraphs: vec![OrgParagraph {
                content: vec![
                    InlineNode::Text(TextNode {
                        text: "hi".into(),
                        marks: vec![OrgMark::Bold],
                    }),
                    InlineNode::TagRef {
                        id: FIXTURE_ULID.into(),
                    },
                ],
            }],
        };
        let j = serde_json::to_string(&d).unwrap();
        let back: OrgDoc = serde_json::from_str(&j).unwrap();
        assert_eq!(d, back);
    }
}
