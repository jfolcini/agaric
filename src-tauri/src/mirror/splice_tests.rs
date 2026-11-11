//! [`splice`] over hand-written files: what a write keeps of a file's own
//! bytes, and when it writes the render whole.

use proptest::prelude::*;

use super::*;

fn id(n: usize) -> String {
    format!("01J00000000000000000000{n:03}")
}

/// `lines`, each with the id of the block it starts, `None` for none.
fn text(lines: &[(&str, Option<usize>)]) -> (String, Vec<Option<String>>) {
    let text = lines.iter().map(|(line, _)| *line).collect::<Vec<_>>();
    let ids = lines.iter().map(|(_, n)| n.map(id)).collect();
    (text.join("\n"), ids)
}

fn spliced(old: &[(&str, Option<usize>)], new: &[(&str, Option<usize>)]) -> String {
    let (old, old_ids) = text(old);
    let (new, new_ids) = text(new);
    splice(&old, &old_ids, &new, &new_ids).0
}

#[test]
fn a_block_the_render_did_not_change_keeps_its_bytes() {
    let old = [("* one", Some(1)), ("* two", Some(2)), ("* three", Some(3))];
    let new = [("- one", Some(1)), ("- TWO", Some(2)), ("- three", Some(3))];
    assert_eq!(spliced(&old, &new), "* one\n- TWO\n* three");
}

#[test]
fn an_unchanged_page_writes_its_file_as_it_is() {
    let old = [
        ("* one", Some(1)),
        ("    * two", Some(2)),
        ("", None),
        ("para", Some(3)),
    ];
    let new = [
        ("- one", Some(1)),
        ("  - two", Some(2)),
        ("", None),
        ("para", Some(3)),
    ];
    assert_eq!(spliced(&old, &new), "* one\n    * two\n\npara");
}

#[test]
fn an_anchor_added_or_dropped_takes_the_renders_line() {
    let target = id(2);
    let anchored = format!("- two ^{target}");
    let old = [("* one", Some(1)), ("* two", Some(2))];
    let new = [("- one", Some(1)), (anchored.as_str(), Some(2))];
    assert_eq!(spliced(&old, &new), format!("* one\n{anchored}"));

    let old = [("* one", Some(1)), (anchored.as_str(), Some(2))];
    let new = [("- one", Some(1)), ("- two", Some(2))];
    assert_eq!(spliced(&old, &new), "* one\n- two");
}

#[test]
fn blocks_follow_the_renders_order_with_their_own_bytes() {
    let old = [("* one", Some(1)), ("* two", Some(2))];
    let new = [("- two", Some(2)), ("- one", Some(1))];
    assert_eq!(spliced(&old, &new), "* two\n* one");
}

#[test]
fn a_block_the_file_does_not_hold_and_one_it_lost_follow_the_render() {
    let old = [("* one", Some(1)), ("* gone", Some(9))];
    let new = [("- one", Some(1)), ("- new", Some(4))];
    assert_eq!(spliced(&old, &new), "* one\n- new");
}

#[test]
fn a_renumbered_item_takes_the_renders_number() {
    let old = [("1) one", Some(1)), ("2) two", Some(2))];
    let new = [
        ("1. zero", Some(3)),
        ("2. one", Some(1)),
        ("3. two", Some(2)),
    ];
    assert_eq!(spliced(&old, &new), "1. zero\n2. one\n3. two");
}

#[test]
fn a_splice_that_would_read_otherwise_is_the_render() {
    // `- c` kept at two columns is no child of the new `10. P`, whose text
    // starts at four.
    let old = [("- p", Some(1)), ("  - c", Some(2))];
    let new = [("10. P", Some(1)), ("    - c", Some(2))];
    assert_eq!(spliced(&old, &new), "10. P\n    - c");
}

#[test]
fn front_matter_that_reads_the_same_keeps_its_bytes() {
    let old = [
        ("---", None),
        ("status: \"done\"", None),
        ("---", None),
        ("* one", Some(1)),
    ];
    let new = [
        ("---", None),
        ("status: done", None),
        ("---", None),
        ("- ONE", Some(1)),
    ];
    assert_eq!(spliced(&old, &new), "---\nstatus: \"done\"\n---\n- ONE");

    let changed = [
        ("---", None),
        ("status: open", None),
        ("---", None),
        ("- one", Some(1)),
    ];
    assert_eq!(spliced(&old, &changed), "---\nstatus: open\n---\n* one");
}

#[test]
fn ids_that_are_not_one_per_line_write_the_render() {
    let (new, new_ids) = text(&[("- one", Some(1))]);
    let out = splice("* one\n", &[Some(id(1))], &new, &new_ids);
    assert_eq!(out, (new, new_ids));
}

proptest! {
    /// Every block the render did not change keeps the file's line, and the
    /// result reads as the render.
    #[test]
    fn untouched_lines_keep_their_bytes(
        blocks in prop::collection::vec(("[a-z]{1,8}( [a-z]{1,8}){0,3}", any::<bool>(), any::<bool>()), 1..12),
    ) {
        let mut old = Vec::new();
        let mut new = Vec::new();
        let mut expected = Vec::new();
        for (i, (content, star, changed)) in blocks.iter().enumerate() {
            let own = format!("{} {content}", if *star { "*" } else { "-" });
            let rendered = if *changed { format!("- {content} x") } else { format!("- {content}") };
            expected.push(if *changed { rendered.clone() } else { own.clone() });
            old.push((own, Some(id(i))));
            new.push((rendered, Some(id(i))));
        }
        let as_refs = |v: &[(String, Option<String>)]| -> (String, Vec<Option<String>>) {
            (v.iter().map(|(l, _)| l.as_str()).collect::<Vec<_>>().join("\n"), v.iter().map(|(_, i)| i.clone()).collect())
        };
        let (old_text, old_ids) = as_refs(&old);
        let (new_text, new_ids) = as_refs(&new);
        let (out, out_ids) = splice(&old_text, &old_ids, &new_text, &new_ids);
        prop_assert_eq!(&out, &expected.join("\n"));
        let written = Laid::of(&out, &out_ids).expect("one id per line");
        let render = Laid::of(&new_text, &new_ids).expect("one id per line");
        prop_assert!(written.reads_as(&render));
    }
}
