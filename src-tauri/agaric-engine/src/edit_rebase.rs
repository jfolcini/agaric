//! Rebase of an edit written against text the block no longer holds.
//!
//! An `edit_block` carries the editor's whole text. An editor that has not
//! seen a peer's edit sends text without it, and the engine's diff against
//! the current text then deletes the peer's edit (`apply_edit_via_diff_splice`).
//! Given the text the editor started from, the editor's change is replayed on
//! the current text instead.

/// The one splice that turns `old` into `new`: the bytes of `old` between its
/// longest common prefix and suffix with `new`, and what replaces them.
fn splice<'a>(old: &str, new: &'a str) -> (usize, usize, &'a str) {
    let prefix: usize = old
        .chars()
        .zip(new.chars())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .sum();
    // The prefix is the same bytes in both, so it ends on a char boundary of each.
    let suffix: usize = old[prefix..]
        .chars()
        .rev()
        .zip(new[prefix..].chars().rev())
        .take_while(|(a, b)| a == b)
        .map(|(a, _)| a.len_utf8())
        .sum();
    (prefix, old.len() - suffix, &new[prefix..new.len() - suffix])
}

/// `to_text` as the editor would have written it had it started from
/// `current` instead of `base`, or `None` when its change and the change
/// `base → current` touch the same text.
///
/// Each change is one splice of `base`. Two insertions at the same point both
/// survive, the one already in `current` first; an edit `current` already
/// holds is not made again (the editor's own commit, landed before an
/// earlier one sent from `base`).
#[must_use]
pub fn rebase_edit(base: &str, to_text: &str, current: &str) -> Option<String> {
    if to_text == current {
        return Some(to_text.to_owned());
    }
    let (start, end, typed) = splice(base, to_text);
    let (their_start, their_end, theirs) = splice(base, current);
    // Where the editor's range of `base` sits in `current`.
    let (start, end) = if their_end <= start {
        let shifted = |at: usize| at - their_end + their_start + theirs.len();
        (shifted(start), shifted(end))
    } else if end <= their_start {
        (start, end)
    } else {
        return None;
    };
    Some([current.get(..start)?, typed, current.get(end..)?].concat())
}

#[cfg(test)]
mod tests {
    use super::rebase_edit;
    use proptest::prelude::*;

    #[test]
    fn an_edit_after_the_peers_keeps_both() {
        assert_eq!(
            rebase_edit("Hello world", "Hello WORLD", "HELLO world").as_deref(),
            Some("HELLO WORLD")
        );
    }

    #[test]
    fn an_edit_before_the_peers_keeps_both() {
        assert_eq!(
            rebase_edit("Hello world", "HELLO world", "Hello WORLD").as_deref(),
            Some("HELLO WORLD")
        );
    }

    #[test]
    fn the_peers_change_of_length_shifts_the_edit() {
        assert_eq!(
            rebase_edit("Buy milk", "Buy milk today", "URGENT: Buy milk").as_deref(),
            Some("URGENT: Buy milk today")
        );
        assert_eq!(
            rebase_edit("one two three", "one two", "two three").as_deref(),
            Some("two")
        );
    }

    #[test]
    fn two_insertions_at_one_point_both_survive_the_peers_first() {
        assert_eq!(
            rebase_edit("Buy milk", "Buy milk today", "Buy milk and eggs").as_deref(),
            Some("Buy milk and eggs today")
        );
    }

    #[test]
    fn an_insertion_at_the_edge_of_the_edit_is_kept() {
        // The editor replaced "lo", the peer inserted right after it.
        assert_eq!(
            rebase_edit("Hello world", "Help world", "Hello, world").as_deref(),
            Some("Help, world")
        );
        // The editor deleted everything the peer appended to.
        assert_eq!(rebase_edit("abc", "", "abcd").as_deref(), Some("d"));
    }

    #[test]
    fn overlapping_edits_are_not_rebased() {
        assert_eq!(
            rebase_edit("Hello world", "Help world", "HELLO world"),
            None
        );
        assert_eq!(
            rebase_edit("Hello world", "Hello", "Hello brave world"),
            None
        );
    }

    #[test]
    fn multi_byte_text_is_cut_on_char_boundaries() {
        assert_eq!(
            rebase_edit("añb 日本語 x", "añb 日本語 y", "éñb 日本語 x").as_deref(),
            Some("éñb 日本語 y")
        );
        // "é" and "è" share their first byte: the splice must not start inside it.
        assert_eq!(
            rebase_edit("é 😀 fin", "è 😀 fin", "é 😀 fin!").as_deref(),
            Some("è 😀 fin!")
        );
        assert_eq!(rebase_edit("日本語", "日語", "日x語"), None);
        // "😀" and "😁" share their first UTF-16 unit: counted in units the
        // peer's deletion would reach past the insertion, and nothing merge.
        assert_eq!(rebase_edit("😀😁", "😀x😁", "😁").as_deref(), Some("x😁"));
    }

    #[test]
    fn a_base_the_block_still_holds_changes_nothing() {
        assert_eq!(
            rebase_edit("Hello world", "Hello there", "Hello world").as_deref(),
            Some("Hello there")
        );
        assert_eq!(rebase_edit("", "typed", "").as_deref(), Some("typed"));
    }

    #[test]
    fn an_editor_that_changed_nothing_takes_the_current_text() {
        assert_eq!(
            rebase_edit("Hello world", "Hello world", "HELLO world").as_deref(),
            Some("HELLO world")
        );
    }

    /// Chars that share UTF-8 lead bytes, combine with their neighbour, or
    /// repeat, so prefixes and suffixes meet inside clusters and multi-byte chars.
    fn text() -> impl Strategy<Value = String> {
        let chars = [
            'a', 'b', 'é', 'è', '日', '😀', '😁', '\u{301}', '\u{200D}', 'א',
        ];
        proptest::collection::vec(proptest::sample::select(chars.to_vec()), 0..8)
            .prop_map(|chars| chars.into_iter().collect())
    }

    /// One edit of a text of distinct chars: the range `[start, end)` and its
    /// replacement, drawn from chars the text does not hold, so each edit is
    /// the only splice that makes it.
    fn edit(len: usize, chars: &'static [char]) -> impl Strategy<Value = (usize, usize, String)> {
        (
            0..=len,
            0..=len,
            proptest::collection::vec(proptest::sample::select(chars), 0..3),
        )
            .prop_map(|(a, b, typed)| (a.min(b), a.max(b), typed.into_iter().collect()))
            .prop_filter(
                "an edit changes something",
                |(start, end, typed): &(usize, usize, String)| start < end || !typed.is_empty(),
            )
    }

    /// `rebase_edit` counted in `char`s, as the browser mock counts
    /// (`src/lib/tauri-mock/edit-rebase.ts`).
    fn rebase_by_chars(base: &str, to_text: &str, current: &str) -> Option<String> {
        fn splice(old: &[char], new: &[char]) -> (usize, usize, Vec<char>) {
            let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
            let suffix = old[prefix..]
                .iter()
                .rev()
                .zip(new[prefix..].iter().rev())
                .take_while(|(a, b)| a == b)
                .count();
            (
                prefix,
                old.len() - suffix,
                new[prefix..new.len() - suffix].to_vec(),
            )
        }
        if to_text == current {
            return Some(to_text.to_owned());
        }
        let chars = |text: &str| text.chars().collect::<Vec<_>>();
        let (base, current) = (chars(base), chars(current));
        let (start, end, typed) = splice(&base, &chars(to_text));
        let (their_start, their_end, theirs) = splice(&base, &current);
        let (start, end) = if their_end <= start {
            let grown = their_start + theirs.len();
            (start + grown - their_end, end + grown - their_end)
        } else if end <= their_start {
            (start, end)
        } else {
            return None;
        };
        Some(
            current[..start]
                .iter()
                .chain(&typed)
                .chain(&current[end..])
                .collect(),
        )
    }

    /// `base` with one range replaced, the replacement drawn from the chars
    /// `base` is made of, so an edit can extend a prefix or suffix it meets.
    fn edited(base: &str) -> impl Strategy<Value = String> + use<> {
        let base: Vec<char> = base.chars().collect();
        (0..=base.len(), 0..=base.len(), text()).prop_map(move |(a, b, typed)| {
            let (head, tail) = (&base[..a.min(b)], &base[a.max(b)..]);
            head.iter()
                .copied()
                .chain(typed.chars())
                .chain(tail.iter().copied())
                .collect()
        })
    }

    fn apply(base: &[char], (start, end, typed): &(usize, usize, String)) -> String {
        let (head, tail) = (base[..*start].iter(), base[*end..].iter());
        head.copied()
            .chain(typed.chars())
            .chain(tail.copied())
            .collect()
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4096))]

        #[test]
        fn a_base_the_block_still_holds_gives_the_text_sent(base in text(), sent in text()) {
            prop_assert_eq!(rebase_edit(&base, &sent, &base), Some(sent));
        }

        #[test]
        fn an_unchanged_editor_gives_the_current_text(base in text(), current in text()) {
            prop_assert_eq!(rebase_edit(&base, &base, &current), Some(current));
        }

        /// An edit the block already holds (its own commit, landed first) is not made twice.
        #[test]
        fn an_edit_the_block_holds_is_written_once(base in text(), sent in text()) {
            prop_assert_eq!(rebase_edit(&base, &sent, &sent), Some(sent));
        }

        /// Merging mine onto theirs gives what merging theirs onto mine gives,
        /// but for two insertions at one point, whose order says whose came first.
        #[test]
        fn the_merge_is_the_same_from_either_side(base in text(), sent in text(), current in text()) {
            let mine = super::splice(&base, &sent);
            let theirs = super::splice(&base, &current);
            let tie = mine.0 == mine.1 && (theirs.0, theirs.1) == (mine.0, mine.1) && sent != current;
            let (onto_current, onto_sent) =
                (rebase_edit(&base, &sent, &current), rebase_edit(&base, &current, &sent));
            prop_assert_eq!(onto_current.is_some(), onto_sent.is_some());
            if !tie {
                prop_assert_eq!(onto_current, onto_sent);
            }
        }

        /// Byte offsets cut where `char` offsets do: the mock, which counts
        /// code points, writes the same text.
        #[test]
        fn bytes_and_chars_give_the_same_text(
            (base, sent, current) in text().prop_flat_map(|base| {
                let (sent, current) = (edited(&base), edited(&base));
                (Just(base), sent, current)
            })
        ) {
            prop_assert_eq!(
                rebase_edit(&base, &sent, &current),
                rebase_by_chars(&base, &sent, &current)
            );
        }

        /// Two edits of a text of distinct chars: apart, both are in the
        /// result; sharing a char, or one inserting inside the other's range,
        /// nothing is merged.
        #[test]
        fn apart_edits_both_land_and_overlapping_ones_are_refused(
            (base, mine, theirs) in proptest::sample::subsequence(
                vec!['a', 'b', 'c', 'é', 'ñ', '日', '本', '😀', 'א', 'Ω'],
                0..=10,
            )
            .prop_flat_map(|base| {
                let len = base.len();
                (Just(base), edit(len, &['X', '🙂', 'ß']), edit(len, &['P', '🎉', 'ç']))
            })
        ) {
            let (sent, current) = (apply(&base, &mine), apply(&base, &theirs));
            let base_text: String = base.iter().collect();
            let theirs_first = theirs.1 <= mine.0;
            let expected = if sent == current {
                Some(sent.clone())
            } else if theirs_first || mine.1 <= theirs.0 {
                let (first, second) = if theirs_first { (&theirs, &mine) } else { (&mine, &theirs) };
                let chars = |from: usize, to: usize| base[from..to].iter().collect::<String>();
                Some(format!(
                    "{}{}{}{}{}",
                    chars(0, first.0),
                    first.2,
                    chars(first.1, second.0),
                    second.2,
                    chars(second.1, base.len())
                ))
            } else {
                None
            };
            prop_assert_eq!(rebase_edit(&base_text, &sent, &current), expected);
        }
    }
}
