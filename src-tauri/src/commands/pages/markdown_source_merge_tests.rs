//! [`merge_outlines`] over hand-written outlines, one per row of its table, and
//! over generated ones (#5140). In an outline here `^X` is the anchor of block
//! X, a ULID ending in `X`; a bullet without one is new in the buffer.

use proptest::prelude::*;

use super::*;

const ANCHOR_PREFIX: &str = "01J0000000000000000000000";

/// `outline` with each ` ^X` spelled out as a ULID.
fn expand(outline: &str) -> String {
    outline
        .lines()
        .map(|line| match line.rsplit_once(" ^") {
            Some((text, letter)) if letter.chars().count() == 1 => {
                format!("{text} ^{ANCHOR_PREFIX}{letter}\n")
            }
            _ => format!("{line}\n"),
        })
        .collect()
}

fn parse(outline: &str) -> Vec<import::ParsedBlock> {
    import::parse_source_outline(&expand(outline)).blocks
}

/// `blocks` one per line: the bullet at its depth, line breaks in its content
/// as `\n`, its anchor as its letter, then its properties.
fn show(blocks: &[import::ParsedBlock]) -> String {
    blocks
        .iter()
        .map(|block| {
            let mut line = format!(
                "{}- {}",
                "  ".repeat(block.depth),
                block.content.replace('\n', "\\n")
            );
            if let Some(anchor) = &block.block_anchor {
                line.push_str(" ^");
                line.push_str(anchor.strip_prefix(ANCHOR_PREFIX).unwrap_or(anchor));
            }
            for (key, value) in &block.properties {
                line.push_str(&format!(" {key}:: {value}"));
            }
            line.push('\n');
            line
        })
        .collect()
}

/// The merge of the three outlines, shown, and its warnings.
fn merge(base: &str, current: &str, mine: &str) -> (String, Vec<String>) {
    let mut warnings = Vec::new();
    let merged = merge_outlines(parse(base), &parse(current), parse(mine), &mut warnings).unwrap();
    (show(&merged), warnings)
}

const NONE: &[&str] = &[];

#[test]
fn each_sides_edit_of_a_different_block_lands() {
    let base = "- a ^A\n- b ^B\n";
    assert_eq!(
        merge(base, "- a2 ^A\n- b ^B\n", "- a ^A\n- b2 ^B\n"),
        (
            "- a2 ^A\n- b2 ^B\n".into(),
            NONE.iter().map(ToString::to_string).collect()
        )
    );
    assert_eq!(
        merge(base, "- a2 ^A\n- b ^B\n", "- a2 ^A\n- b ^B\n").0,
        "- a2 ^A\n- b ^B\n",
        "the same edit on both sides is one edit"
    );
}

/// A block changed differently on each side is kept twice: the buffer's
/// version, as a new block, directly before the page's. So is one the page
/// added after the base was read that the buffer also holds, changed.
#[test]
fn a_block_changed_both_ways_is_kept_twice() {
    let (merged, warnings) = merge("- a ^A\n- b ^B\n", "- a2 ^A\n- b ^B\n", "- a3 ^A\n- b ^B\n");
    assert_eq!(merged, "- a3\n- a2 ^A\n- b ^B\n");
    assert_eq!(
        warnings,
        ["'a2' was changed here and on the page; both versions kept"]
    );
    assert_eq!(merge("", "- a ^A\n", "- a ^A\n").0, "- a ^A\n");
    let (merged, warnings) = merge("", "- a ^A\n", "- a2 ^A\n");
    assert_eq!(merged, "- a2\n- a ^A\n");
    assert_eq!(warnings.len(), 1);
}

/// A delete on one side stands against no change on the other, and gives way,
/// with a warning, to an edit: the buffer's edit comes back as a new block, the
/// page's keeps its block.
#[test]
fn a_delete_gives_way_to_the_other_sides_edit() {
    let base = "- a ^A\n- b ^B\n";
    assert_eq!(
        merge(base, "- b ^B\n", base),
        ("- b ^B\n".into(), Vec::new())
    );
    assert_eq!(
        merge(base, base, "- b ^B\n"),
        ("- b ^B\n".into(), Vec::new())
    );
    assert_eq!(
        merge(base, "- b ^B\n", "- a2 ^A\n- b ^B\n"),
        (
            "- a2\n- b ^B\n".into(),
            vec!["'a2' was deleted on the page; saved as a new block".to_owned()]
        )
    );
    assert_eq!(
        merge(base, "- a2 ^A\n- b ^B\n", "- b ^B\n"),
        (
            "- a2 ^A\n- b ^B\n".into(),
            vec!["'a2' changed on the page; your delete was not applied".to_owned()]
        )
    );
}

/// A move to another parent is a change a delete gives way to, as an edit is:
/// a block the buffer moved that the page deleted comes back as a new block,
/// and one the page moved that the buffer deleted stays, each with a warning.
/// A reorder under the same parent is not.
#[test]
fn a_delete_gives_way_to_the_other_sides_move() {
    let base = "- a ^A\n- b ^B\n";
    assert_eq!(
        merge(base, "- a ^A\n", "- a ^A\n  - b ^B\n"),
        (
            "- a ^A\n  - b\n".into(),
            vec!["'b' was deleted on the page; saved as a new block".to_owned()]
        ),
        "the buffer moved b, the page deleted it"
    );
    assert_eq!(
        merge(base, "- a ^A\n  - b ^B\n", "- a ^A\n"),
        (
            "- a ^A\n  - b ^B\n".into(),
            vec!["'b' changed on the page; your delete was not applied".to_owned()]
        ),
        "the page moved b, the buffer deleted it"
    );
    assert_eq!(
        merge(base, "- b ^B\n- a ^A\n", "- a ^A\n"),
        ("- a ^A\n".into(), Vec::new()),
        "the page reordered b, the buffer deleted it"
    );
}

/// Two blocks inserted after the same one are both kept, the buffer's first.
#[test]
fn inserts_after_the_same_block_are_both_kept() {
    assert_eq!(
        merge(
            "- a ^A\n- b ^B\n",
            "- a ^A\n- x ^X\n- b ^B\n",
            "- a ^A\n- y\n- b ^B\n"
        ),
        ("- a ^A\n- y\n- x ^X\n- b ^B\n".into(), Vec::new())
    );
}

/// The side that reordered a parent's children sets their order; the other
/// side's edits ride along. Both reordering them differently keeps the
/// buffer's order and says so.
#[test]
fn the_side_that_reordered_sets_the_order() {
    let base = "- a ^A\n- b ^B\n";
    assert_eq!(
        merge(base, "- b ^B\n- a ^A\n", "- a2 ^A\n- b ^B\n"),
        ("- b ^B\n- a2 ^A\n".into(), Vec::new()),
        "the page reordered"
    );
    assert_eq!(
        merge(base, "- a2 ^A\n- b ^B\n", "- b ^B\n- a ^A\n"),
        ("- b ^B\n- a2 ^A\n".into(), Vec::new()),
        "the buffer reordered"
    );
    assert_eq!(
        merge(
            "- a ^A\n- b ^B\n- c ^C\n",
            "- b ^B\n- a ^A\n- c ^C\n",
            "- a ^A\n- c ^C\n- b ^B\n"
        ),
        (
            "- a ^A\n- c ^C\n- b ^B\n".into(),
            vec![
                "the page's blocks were reordered here and on the page; your order kept".to_owned()
            ]
        )
    );
}

/// A block each side moved under a different parent stays where the page put
/// it; so does the second of two blocks each side nested under the other.
#[test]
fn a_block_moved_both_ways_keeps_the_pages_parent() {
    assert_eq!(
        merge(
            "- a ^A\n- b ^B\n- c ^C\n",
            "- a ^A\n  - c ^C\n- b ^B\n",
            "- a ^A\n- b ^B\n  - c ^C\n"
        ),
        (
            "- a ^A\n  - c ^C\n- b ^B\n".into(),
            vec!["'c' was moved here and on the page; the page's place kept".to_owned()]
        )
    );
    assert_eq!(
        merge(
            "- a ^A\n- b ^B\n",
            "- b ^B\n  - a ^A\n",
            "- a ^A\n  - b ^B\n"
        ),
        (
            "- b ^B\n  - a ^A\n".into(),
            vec!["'b' was moved here and on the page; the page's place kept".to_owned()]
        ),
        "a cycle: the page's nesting stands, and both blocks are kept"
    );
}

/// A block under a parent the merge drops goes to the nearest kept ancestor,
/// or the page.
#[test]
fn a_block_under_a_dropped_parent_is_lifted() {
    let base = "- p ^P\n  - x ^X\n";
    assert_eq!(
        merge(base, "", "- p ^P\n  - x ^X\n  - y\n"),
        ("- y\n".into(), Vec::new())
    );
    assert_eq!(
        merge(base, "", "- p ^P\n  - x2 ^X\n"),
        (
            "- x2\n".into(),
            vec!["'x2' was deleted on the page; saved as a new block".to_owned()]
        )
    );
    assert_eq!(
        merge(
            "- g ^G\n  - p ^P\n    - x ^X\n",
            "- g ^G\n",
            "- g ^G\n  - p ^P\n    - x2 ^X\n"
        )
        .0,
        "- g ^G\n  - x2\n"
    );
}

/// Properties merge by key like content, and one key changed both ways is a
/// conflict. Content edited both ways merges line by line where the edited
/// lines are apart.
#[test]
fn properties_and_lines_merge_field_by_field() {
    assert_eq!(
        merge("- a ^A\n", "- a ^A\n  k:: v\n", "- a2 ^A\n"),
        ("- a2 ^A k:: v\n".into(), Vec::new())
    );
    assert_eq!(
        merge(
            "- a ^A\n  k:: v\n",
            "- a ^A\n  k:: v1\n",
            "- a ^A\n  k:: v2\n"
        )
        .0,
        "- a k:: v2\n- a ^A k:: v1\n"
    );
    assert_eq!(
        merge(
            "- a\n  b\n  c ^A\n",
            "- A\n  b\n  c ^A\n",
            "- a\n  b\n  C ^A\n"
        ),
        ("- A\\nb\\nC ^A\n".into(), Vec::new())
    );
}

#[test]
fn an_anchor_written_twice_in_the_buffer_is_refused() {
    let mut warnings = Vec::new();
    let result = merge_outlines(
        parse("- a ^A\n"),
        &parse("- a ^A\n"),
        parse("- a ^A\n- a ^A\n"),
        &mut warnings,
    );
    assert!(
        matches!(result, Err(AppError::Validation { .. })),
        "got {result:?}"
    );
}

/// A generated block: its anchor, none for a bullet new in the buffer.
#[derive(Clone, Debug)]
struct Spec {
    anchor: Option<char>,
    content: String,
    depth: usize,
}

fn outline(specs: &[Spec]) -> String {
    specs
        .iter()
        .map(|spec| {
            let anchor = spec.anchor.map(|a| format!(" ^{a}")).unwrap_or_default();
            format!("{}- {}{anchor}\n", "  ".repeat(spec.depth), spec.content)
        })
        .collect()
}

/// `levels` clamped to one below the block before, so each depth is the
/// block's depth in the tree.
fn nest(specs: &mut [Spec], levels: &[usize]) {
    let mut previous: Option<usize> = None;
    for (spec, &level) in specs.iter_mut().zip(levels) {
        spec.depth = previous.map_or(0, |p| level.min(p + 1));
        previous = Some(spec.depth);
    }
}

fn arb_levels(n: usize) -> impl Strategy<Value = Vec<usize>> {
    prop::collection::vec(0usize..=3, n)
}

/// Up to six anchored blocks.
fn arb_base() -> impl Strategy<Value = Vec<Spec>> {
    (0usize..=6).prop_flat_map(|n| {
        arb_levels(n).prop_map(move |levels| {
            let mut specs: Vec<Spec> = "ABCDEF"
                .chars()
                .take(n)
                .enumerate()
                .map(|(i, anchor)| Spec {
                    anchor: Some(anchor),
                    content: format!("block {i}"),
                    depth: 0,
                })
                .collect();
            nest(&mut specs, &levels);
            specs
        })
    })
}

/// `base` after one side's edits: some blocks dropped, the rest in a new
/// order at new depths, some with `tag` added to their content, and up to
/// three new blocks anchored from `anchors`, or, when `unanchored`, sometimes
/// with no anchor, as the buffer's new bullets have none.
fn arb_side(
    base: Vec<Spec>,
    tag: &'static str,
    anchors: &'static str,
    unanchored: bool,
) -> impl Strategy<Value = Vec<Spec>> {
    let n = base.len();
    (
        prop::collection::vec(any::<bool>(), n),
        Just((0..n).collect::<Vec<usize>>()).prop_shuffle(),
        prop::collection::vec(any::<bool>(), n),
        prop::collection::vec((0..=n, any::<bool>()), 0..=3),
        arb_levels(n + 3),
    )
        .prop_map(move |(keep, order, edit, inserts, levels)| {
            let mut specs: Vec<Spec> = order
                .iter()
                .filter(|&&i| keep[i])
                .map(|&i| {
                    let mut spec = base[i].clone();
                    if edit[i] {
                        spec.content = format!("{} {tag}", spec.content);
                    }
                    spec
                })
                .collect();
            for (k, (at, anchored)) in inserts.into_iter().enumerate() {
                let anchor = (anchored || !unanchored).then(|| anchors.chars().nth(k).unwrap());
                let spec = Spec {
                    anchor,
                    content: format!("new {tag}{k}"),
                    depth: 0,
                };
                specs.insert(at.min(specs.len()), spec);
            }
            nest(&mut specs, &levels);
            specs
        })
}

/// A base, the page's version of it, and the buffer's.
fn arb_three(unanchored_mine: bool) -> impl Strategy<Value = (Vec<Spec>, Vec<Spec>, Vec<Spec>)> {
    arb_base().prop_flat_map(move |base| {
        (
            Just(base.clone()),
            arb_side(base.clone(), "c", "PQR", false),
            arb_side(base, "m", "VWX", unanchored_mine),
        )
    })
}

/// Whether `spec` is new to, or changed from, `base`.
fn changed(base: &[Spec], spec: &Spec) -> bool {
    !base
        .iter()
        .any(|b| b.anchor == spec.anchor && b.content == spec.content)
}

fn contents(blocks: &[import::ParsedBlock]) -> Vec<String> {
    let mut contents: Vec<String> = blocks.iter().map(|b| b.content.clone()).collect();
    contents.sort();
    contents
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    #[test]
    fn an_unchanged_buffer_saves_the_page_as_it_is((b, x, _) in arb_three(true)) {
        let (merged, warnings) = merge(&outline(&b), &outline(&x), &outline(&b));
        prop_assert_eq!(merged, show(&parse(&outline(&x))));
        prop_assert_eq!(warnings, Vec::<String>::new());
    }

    #[test]
    fn an_unchanged_page_saves_the_buffer_as_it_is((b, _, y) in arb_three(true)) {
        let (merged, warnings) = merge(&outline(&b), &outline(&b), &outline(&y));
        prop_assert_eq!(merged, show(&parse(&outline(&y))));
        prop_assert_eq!(warnings, Vec::<String>::new());
    }

    #[test]
    fn the_same_changes_on_both_sides_save_once((b, x, _) in arb_three(false)) {
        let (merged, warnings) = merge(&outline(&b), &outline(&x), &outline(&x));
        prop_assert_eq!(merged, show(&parse(&outline(&x))));
        prop_assert_eq!(warnings, Vec::<String>::new());
    }

    /// Each anchor at most once, and every block either side added or
    /// changed is in the result with that side's content.
    #[test]
    fn no_anchor_twice_and_no_change_lost((b, x, y) in arb_three(true)) {
        let mut warnings = Vec::new();
        let merged = merge_outlines(
            parse(&outline(&b)),
            &parse(&outline(&x)),
            parse(&outline(&y)),
            &mut warnings,
        ).unwrap();
        let anchors: Vec<&String> = merged.iter().filter_map(|m| m.block_anchor.as_ref()).collect();
        let distinct: HashSet<&&String> = anchors.iter().collect();
        prop_assert_eq!(anchors.len(), distinct.len(), "anchors: {:?}", anchors);
        let contents = contents(&merged);
        for spec in x.iter().chain(&y).filter(|spec| changed(&b, spec)) {
            prop_assert!(
                contents.contains(&spec.content),
                "'{}' is lost from {:?}\nbase:\n{}page:\n{}buffer:\n{}",
                spec.content, contents, outline(&b), outline(&x), outline(&y)
            );
        }
    }

    #[test]
    fn swapping_the_sides_keeps_the_same_blocks((b, x, y) in arb_three(false)) {
        let both = |current: &[Spec], mine: &[Spec]| {
            let mut warnings = Vec::new();
            let merged = merge_outlines(
                parse(&outline(&b)),
                &parse(&outline(current)),
                parse(&outline(mine)),
                &mut warnings,
            ).unwrap();
            contents(&merged)
        };
        prop_assert_eq!(both(&x, &y), both(&y, &x));
    }
}
