//! Word-level two-way diff for undo/redo history display.
//!
//! Uses the `similar` crate's `TextDiff::from_words()` to produce
//! `DiffSpan` items with `{Equal, Delete, Insert}` tags.  Independent
//! from the line-level `diffy` merge path used by sync.

use serde::Serialize;
use similar::{ChangeTag, TextDiff};

/// Tag indicating what happened to a span of text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
pub enum DiffTag {
    Equal,
    Delete,
    Insert,
}

/// A contiguous span of text with a diff tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct DiffSpan {
    pub tag: DiffTag,
    pub value: String,
}

/// Compute a word-level diff between `old` and `new`, returning an
/// ordered list of [`DiffSpan`]s.
pub fn compute_word_diff(old: &str, new: &str) -> Vec<DiffSpan> {
    let diff = TextDiff::from_words(old, new);
    diff.iter_all_changes()
        .map(|change| DiffSpan {
            tag: match change.tag() {
                ChangeTag::Equal => DiffTag::Equal,
                ChangeTag::Delete => DiffTag::Delete,
                ChangeTag::Insert => DiffTag::Insert,
            },
            value: change.to_string_lossy().into_owned(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_text_returns_single_equal_span() {
        let spans = compute_word_diff("hello world", "hello world");
        assert!(
            spans.iter().all(|s| s.tag == DiffTag::Equal),
            "all spans should be Equal for identical text"
        );
        let joined: String = spans.iter().map(|s| s.value.as_str()).collect();
        assert_eq!(joined, "hello world");
    }

    #[test]
    fn single_word_change() {
        let spans = compute_word_diff("hello world", "hello universe");
        let tags: Vec<DiffTag> = spans.iter().map(|s| s.tag).collect();
        assert!(tags.contains(&DiffTag::Delete), "should have a Delete span");
        assert!(tags.contains(&DiffTag::Insert), "should have an Insert span");
        // The deleted word should be "world" and inserted should be "universe"
        let deleted: Vec<&str> = spans
            .iter()
            .filter(|s| s.tag == DiffTag::Delete)
            .map(|s| s.value.as_str())
            .collect();
        let inserted: Vec<&str> = spans
            .iter()
            .filter(|s| s.tag == DiffTag::Insert)
            .map(|s| s.value.as_str())
            .collect();
        assert!(deleted.iter().any(|d| d.contains("world")));
        assert!(inserted.iter().any(|i| i.contains("universe")));
    }

    #[test]
    fn empty_to_text() {
        let spans = compute_word_diff("", "hello world");
        assert!(
            spans.iter().all(|s| s.tag == DiffTag::Insert),
            "all spans should be Insert when old is empty"
        );
    }

    #[test]
    fn text_to_empty() {
        let spans = compute_word_diff("hello world", "");
        assert!(
            spans.iter().all(|s| s.tag == DiffTag::Delete),
            "all spans should be Delete when new is empty"
        );
    }

    #[test]
    fn both_empty() {
        let spans = compute_word_diff("", "");
        assert!(spans.is_empty(), "both empty should produce no spans");
    }

    #[test]
    fn multi_word_diff_preserves_order() {
        let old = "The quick brown fox jumps";
        let new = "The slow brown cat jumps";
        let spans = compute_word_diff(old, new);
        // Reconstruct: equal parts + inserts should form new text
        let reconstructed: String = spans
            .iter()
            .filter(|s| s.tag != DiffTag::Delete)
            .map(|s| s.value.as_str())
            .collect();
        assert_eq!(reconstructed, new);
    }

    #[test]
    fn unicode_characters_handled_correctly() {
        let spans = compute_word_diff("café latte", "naïve latte");
        let reconstructed: String = spans
            .iter()
            .filter(|s| s.tag != DiffTag::Delete)
            .map(|s| s.value.as_str())
            .collect();
        assert_eq!(reconstructed, "naïve latte");
    }

    #[test]
    fn markdown_content_with_tags() {
        let old = "Buy milk #[01HQRS] and eggs";
        let new = "Buy butter #[01HQRS] and cheese";
        let spans = compute_word_diff(old, new);
        let deleted: String = spans
            .iter()
            .filter(|s| s.tag == DiffTag::Delete)
            .map(|s| s.value.as_str())
            .collect();
        let inserted: String = spans
            .iter()
            .filter(|s| s.tag == DiffTag::Insert)
            .map(|s| s.value.as_str())
            .collect();
        assert!(deleted.contains("milk"), "should detect 'milk' as deleted");
        assert!(deleted.contains("eggs"), "should detect 'eggs' as deleted");
        assert!(
            inserted.contains("butter"),
            "should detect 'butter' as inserted"
        );
        assert!(
            inserted.contains("cheese"),
            "should detect 'cheese' as inserted"
        );
    }
}
