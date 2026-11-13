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
/// survive, the one already in `current` first.
#[must_use]
pub fn rebase_edit(base: &str, to_text: &str, current: &str) -> Option<String> {
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
}
