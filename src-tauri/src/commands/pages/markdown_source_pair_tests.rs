//! [`pair_unanchored_lines`] over hand-written texts and generated edits
//! (#6277 G4). A block here is `(text, id, anchored)`: a text is written one
//! block per paragraph or `- ` item, a blank line between, and its line ids
//! carry only the anchored blocks' ids, as a file's anchors give them.

use proptest::prelude::*;

use super::*;

type Page = Vec<(String, usize, bool)>;

fn id(n: usize) -> String {
    format!("01J00000000000000000000{n:03}")
}

/// The text of `blocks` and its line ids: every block's when `all`, else the
/// anchored ones'.
fn write(blocks: &[(String, usize, bool)], all: bool) -> (String, Vec<Option<String>>) {
    let mut text = Vec::new();
    let mut ids = Vec::new();
    for (i, (content, n, anchored)) in blocks.iter().enumerate() {
        if i > 0 {
            text.push(String::new());
            ids.push(None);
        }
        text.push(content.clone());
        ids.push((all || *anchored).then(|| id(*n)));
    }
    (text.join("\n"), ids)
}

/// The id given to each block of `edited`, paired against `base`.
fn paired(base: &[(String, usize, bool)], edited: &[(String, usize, bool)]) -> Vec<Option<String>> {
    let (base_text, base_ids) = write(base, true);
    let (text, ids) = write(edited, false);
    let out = pair_unanchored_lines(&base_text, &base_ids, &text, &ids);
    (0..edited.len()).map(|i| out[2 * i].clone()).collect()
}

fn blocks(spec: &[(&str, usize, bool)]) -> Page {
    spec.iter()
        .map(|&(text, n, anchored)| (text.to_owned(), n, anchored))
        .collect()
}

fn ids(of: &[Option<usize>]) -> Vec<Option<String>> {
    of.iter().map(|n| n.map(id)).collect()
}

#[test]
fn an_edit_between_unchanged_blocks_keeps_its_id() {
    let base = blocks(&[("one", 1, false), ("two", 2, false), ("three", 3, false)]);
    let edited = blocks(&[("one", 0, false), ("TWO", 0, false), ("three", 0, false)]);
    assert_eq!(paired(&base, &edited), ids(&[Some(1), Some(2), Some(3)]));
}

#[test]
fn a_moved_block_keeps_its_id() {
    let base = blocks(&[("one", 1, false), ("two", 2, false), ("three", 3, false)]);
    let edited = blocks(&[("three", 0, false), ("one", 0, false), ("two", 0, false)]);
    assert_eq!(paired(&base, &edited), ids(&[Some(3), Some(1), Some(2)]));
}

#[test]
fn a_block_nested_under_its_neighbour_keeps_its_id() {
    let base = blocks(&[("three", 3, false), ("- one", 1, false), ("two", 2, false)]);
    let (base_text, base_ids) = write(&base, true);
    let text = "- one\n  + two\n\nthree";
    let out = pair_unanchored_lines(&base_text, &base_ids, text, &[None, None, None, None]);
    assert_eq!(out, vec![Some(id(1)), Some(id(2)), None, Some(id(3))]);
}

#[test]
fn an_inserted_block_is_new_and_its_neighbours_keep_theirs() {
    let base = blocks(&[("one", 1, false), ("two", 2, false)]);
    let edited = blocks(&[("one", 0, false), ("new", 0, false), ("two", 0, false)]);
    assert_eq!(paired(&base, &edited), ids(&[Some(1), None, Some(2)]));
}

#[test]
fn a_run_replaced_by_a_longer_one_is_new() {
    let base = blocks(&[("one", 1, false), ("two", 2, false), ("three", 3, false)]);
    let edited = blocks(&[
        ("one", 0, false),
        ("2a", 0, false),
        ("2b", 0, false),
        ("three", 0, false),
    ]);
    assert_eq!(paired(&base, &edited), ids(&[Some(1), None, None, Some(3)]));
}

#[test]
fn a_run_replaced_by_a_shorter_one_is_new() {
    let base = blocks(&[
        ("one", 1, false),
        ("two", 2, false),
        ("three", 3, false),
        ("four", 4, false),
    ]);
    let edited = blocks(&[("one", 0, false), ("TWO", 0, false), ("four", 0, false)]);
    assert_eq!(paired(&base, &edited), ids(&[Some(1), None, Some(4)]));
}

#[test]
fn an_anchored_block_is_an_unchanged_neighbour() {
    // "one" is edited and "three" dropped; the anchored "two" between them
    // bounds the edit as an unanchored neighbour would.
    let base = blocks(&[("one", 1, false), ("two", 2, false), ("three", 3, false)]);
    let edited = blocks(&[("ONE", 0, false), ("two", 2, true)]);
    assert_eq!(paired(&base, &edited), ids(&[Some(1), Some(2)]));
}

#[test]
fn an_anchor_the_base_never_had_takes_no_blocks_place() {
    let base = blocks(&[("one", 1, false)]);
    let edited = blocks(&[("copied", 9, true), ("ONE", 0, false)]);
    assert_eq!(paired(&base, &edited), ids(&[Some(9), Some(1)]));
}

#[test]
fn a_block_moved_and_edited_at_once_is_new() {
    let base = blocks(&[
        ("one", 1, false),
        ("two", 2, false),
        ("three", 3, false),
        ("four", 4, false),
    ]);
    let edited = blocks(&[
        ("one", 0, false),
        ("three", 0, false),
        ("four", 0, false),
        ("TWO", 0, false),
    ]);
    assert_eq!(
        paired(&base, &edited),
        ids(&[Some(1), Some(3), Some(4), None])
    );
}

#[test]
fn a_copy_of_a_block_is_new() {
    let base = blocks(&[("one", 1, false), ("two", 2, false)]);
    let edited = blocks(&[("one", 0, false), ("two", 0, false), ("one", 0, false)]);
    assert_eq!(paired(&base, &edited), ids(&[Some(1), Some(2), None]));
}

#[test]
fn an_anchored_id_is_kept_and_not_paired_again() {
    // The second "one" matches the base block by text, but the anchor already
    // holds that block's id.
    let base = blocks(&[("one", 1, false)]);
    let edited = blocks(&[("one", 1, true), ("one", 0, false)]);
    assert_eq!(paired(&base, &edited), ids(&[Some(1), None]));
}

/// Up to 12 blocks, each a paragraph or a `- ` item, with unique words, some
/// anchored.
fn arb_page() -> impl Strategy<Value = Page> {
    prop::collection::vec((any::<bool>(), any::<bool>()), 0..12).prop_map(|kinds| {
        kinds
            .into_iter()
            .enumerate()
            .map(|(n, (item, anchored))| {
                let marker = if item { "- " } else { "" };
                (format!("{marker}block {n}"), n, anchored)
            })
            .collect()
    })
}

/// `page` with some blocks edited in place: an edited unanchored block's text
/// is new, so only its place says which block it was.
fn arb_edited() -> impl Strategy<Value = (Page, Page)> {
    arb_page().prop_flat_map(|page| {
        let n = page.len();
        (Just(page), prop::collection::vec(any::<bool>(), n)).prop_map(|(page, edits)| {
            let edited = page
                .iter()
                .zip(edits)
                .map(|((text, n, anchored), edit)| {
                    let text = if edit {
                        format!("{text} edited")
                    } else {
                        text.clone()
                    };
                    (text, *n, *anchored)
                })
                .collect();
            (page, edited)
        })
    })
}

fn arb_moved() -> impl Strategy<Value = (Page, Page)> {
    arb_page().prop_flat_map(|page| {
        let moved = Just(page.clone()).prop_shuffle();
        (Just(page), moved)
    })
}

/// Any change: blocks dropped, edited, added and reordered.
fn arb_changed() -> impl Strategy<Value = (Page, Page)> {
    arb_page().prop_flat_map(|page| {
        let n = page.len();
        (
            Just(page),
            prop::collection::vec((0..3_u8, any::<bool>()), n),
            prop::collection::vec(0..20_usize, 0..4),
        )
            .prop_flat_map(|(page, fates, added)| {
                let mut edited: Page = page
                    .iter()
                    .zip(fates)
                    .filter_map(|((text, n, anchored), (fate, copy))| match fate {
                        0 => None,
                        1 => Some((format!("{text} edited"), *n, *anchored)),
                        // A copy of an existing text in place of this one.
                        _ if copy => Some(("block 0".to_owned(), *n, *anchored)),
                        _ => Some((text.clone(), *n, *anchored)),
                    })
                    .collect();
                for (k, at) in added.into_iter().enumerate() {
                    let at = at % (edited.len() + 1);
                    edited.insert(at, (format!("added {k}"), 100 + k, false));
                }
                (Just(page), Just(edited).prop_shuffle())
            })
    })
}

proptest! {
    #[test]
    fn edits_in_place_keep_every_id((page, edited) in arb_edited()) {
        let expected: Vec<Option<String>> = edited.iter().map(|(_, n, _)| Some(id(*n))).collect();
        prop_assert_eq!(paired(&page, &edited), expected);
    }

    #[test]
    fn moves_keep_every_id((page, moved) in arb_moved()) {
        let expected: Vec<Option<String>> = moved.iter().map(|(_, n, _)| Some(id(*n))).collect();
        prop_assert_eq!(paired(&page, &moved), expected);
    }

    #[test]
    fn any_change_keeps_every_anchored_id_and_gives_each_id_once(
        (page, edited) in arb_changed()
    ) {
        let out = paired(&page, &edited);
        for ((_, n, anchored), got) in edited.iter().zip(&out) {
            if *anchored {
                prop_assert_eq!(got, &Some(id(*n)));
            }
        }
        let given: Vec<&String> = out.iter().flatten().collect();
        let unique: HashSet<&String> = given.iter().copied().collect();
        prop_assert_eq!(given.len(), unique.len(), "an id given twice: {:?}", out);
        let known: HashSet<String> = page.iter().map(|(_, n, _)| id(*n)).collect();
        for got in &given {
            prop_assert!(known.contains(*got), "an id the page never had: {}", got);
        }
    }
}
