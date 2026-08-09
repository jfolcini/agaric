//! Word-level two-way diff for undo/redo history display.
//!
//! Uses the `similar` crate's `TextDiff::from_words()` to produce
//! `DiffSpan` items with `{Equal, Delete, Insert}` tags.

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
    use proptest::prelude::*;

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
        assert!(
            tags.contains(&DiffTag::Insert),
            "should have an Insert span"
        );
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
    fn decomposed_combining_marks_pinned_behaviour() {
        // Decomposed (NFD) input — `e\u{0301}` is the base
        // letter `e` followed by U+0301 COMBINING ACUTE ACCENT, which
        // renders as `é` but is *not* the same scalar sequence as the
        // precomposed `é` (U+00E9). The `similar` crate does not
        // normalize — it diffs raw unicode scalars — so this test
        // pins the current behaviour: identical decomposed input
        // round-trips as all-Equal, and the reconstruction (Equal +
        // Insert spans) recovers the `new` side exactly.
        let decomposed = "cafe\u{0301} latte";
        let precomposed = "café latte";

        // Identity: identical decomposed input → all Equal spans, and
        // the concatenation reproduces the original byte sequence.
        let identity = compute_word_diff(decomposed, decomposed);
        assert!(
            identity.iter().all(|s| s.tag == DiffTag::Equal),
            "identical decomposed input should produce only Equal spans, got {identity:?}",
        );
        let joined: String = identity.iter().map(|s| s.value.as_str()).collect();
        assert_eq!(joined, decomposed);

        // Cross-form: decomposed vs precomposed — the diff treats them
        // as distinct words (Delete + Insert for the accented word),
        // and reconstructing from non-Delete spans yields the `new`
        // side exactly.  Mirrors `unicode_characters_handled_correctly`.
        let cross = compute_word_diff(decomposed, precomposed);
        let reconstructed: String = cross
            .iter()
            .filter(|s| s.tag != DiffTag::Delete)
            .map(|s| s.value.as_str())
            .collect();
        assert_eq!(reconstructed, precomposed);
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

    // ── insta snapshot tests — the exact DiffSpan sequence (#3457) ────────
    //
    // WHY a snapshot rather than more assertions: every hand-written test
    // above checks a *projection* of the output — "some Delete span contains
    // `world`", "the non-Delete spans rebuild `new`" — and the proptests
    // below check reconstruction invariants that hold for ANY segmentation.
    // None of them pins the segmentation itself: how many spans come back,
    // where the boundaries fall, or whether the trailing space travels with
    // the word or arrives as its own span.
    //
    // That sequence is the contract. `DiffSpan { tag, value }` is `Serialize`
    // + `specta::Type`, so the list crosses IPC verbatim and the undo/redo
    // history view renders one element per span. A `similar` upgrade that
    // re-tokenises, or a change to `compute_word_diff`'s mapping, would
    // repaint that view while every assertion in this module still passed.
    //
    // Re-blessing one of these snapshots therefore means "the rendered
    // history diff changed shape" — look at the history view, do not just
    // `cargo insta accept`.
    //
    // Determinism: every case is a pair of literal strings. No timestamps,
    // ULIDs, hashes or map iteration is involved, so nothing needs redacting.
    #[test]
    fn snapshot_word_diff_span_sequences() {
        let cases: [(&str, &str, &str); 6] = [
            // Pure insertion of an interior run.
            ("insert", "hello world", "hello brave new world"),
            // Pure deletion of an interior run.
            ("delete", "hello brave new world", "hello world"),
            // Replacement of two separated interior words — the case
            // `multi_word_diff_preserves_order` only checks by rebuilding.
            (
                "replace",
                "The quick brown fox jumps",
                "The slow brown cat jumps",
            ),
            // Whole-side insert / delete: one side empty.
            ("insert_from_empty", "", "hello world"),
            ("delete_to_empty", "hello world", ""),
            // Unicode boundary: NFD (`e` + U+0301 COMBINING ACUTE ACCENT)
            // against NFC (`é`). `similar` does not normalise, so the
            // accented word is a Delete/Insert pair — the segmentation
            // `decomposed_combining_marks_pinned_behaviour` only reaches
            // indirectly, via reconstruction. The Delete and Insert values
            // in that snapshot look IDENTICAL (`café` / `café`) because the
            // two encodings render the same; they differ by scalar, which is
            // the whole point. A future `similar` that normalised would
            // collapse the pair into a single Equal span and redden this.
            (
                "unicode_combining_boundary",
                "cafe\u{0301} latte",
                "café latte",
            ),
        ];
        for (name, old, new) in cases {
            insta::assert_yaml_snapshot!(format!("word_diff_{name}"), compute_word_diff(old, new));
        }
    }

    // Word-diff reconstruction invariants. The spans from
    // `compute_word_diff` must losslessly reconstruct both inputs — dropping
    // the Delete spans yields `new`, dropping the Insert spans yields `old` —
    // generalizing the hand-pinned example cases into universal properties.
    const COMBINING_ALPHABET: &[&str] = &[
        "a", "z", " ", "\n", "e", "\u{0301}", "é", "ñ", "中", "😀", "\u{0300}",
    ];

    proptest! {
        #[test]
        fn word_diff_reconstructs_new_side(old in any::<String>(), new in any::<String>()) {
            let spans = compute_word_diff(&old, &new);
            let rebuilt: String = spans
                .iter()
                .filter(|s| s.tag != DiffTag::Delete)
                .map(|s| s.value.as_str())
                .collect();
            prop_assert_eq!(rebuilt, new);
        }

        #[test]
        fn word_diff_reconstructs_old_side(old in any::<String>(), new in any::<String>()) {
            let spans = compute_word_diff(&old, &new);
            let rebuilt: String = spans
                .iter()
                .filter(|s| s.tag != DiffTag::Insert)
                .map(|s| s.value.as_str())
                .collect();
            prop_assert_eq!(rebuilt, old);
        }

        #[test]
        fn word_diff_reconstructs_with_combining_marks(
            old in prop::collection::vec(prop::sample::select(COMBINING_ALPHABET.to_vec()), 0..24),
            new in prop::collection::vec(prop::sample::select(COMBINING_ALPHABET.to_vec()), 0..24),
        ) {
            let old: String = old.concat();
            let new: String = new.concat();
            let spans = compute_word_diff(&old, &new);
            let rebuilt_new: String = spans
                .iter()
                .filter(|s| s.tag != DiffTag::Delete)
                .map(|s| s.value.as_str())
                .collect();
            let rebuilt_old: String = spans
                .iter()
                .filter(|s| s.tag != DiffTag::Insert)
                .map(|s| s.value.as_str())
                .collect();
            prop_assert_eq!(rebuilt_new, new);
            prop_assert_eq!(rebuilt_old, old);
        }
    }
}
