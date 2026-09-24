//! Source mode (#5140): `render_page_source` writes a page's block tree as one
//! markdown buffer, and `import::parse_source_outline` must read it back as
//! exactly that tree, or a save with no edits would not be a no-op. A
//! clipboard copy (`render_clipboard_source`) must read back as a paste
//! (`import::parse_pasted_text`) reads it, as the same tree less the anchors.
//!
//! The render→parse proptests are the oracle. Known source-mode limits, which
//! their generator excludes:
//! - a `\r` in content (line splitting takes it as a line ending);
//! - a custom property value with surrounding whitespace or a newline (a
//!   `key:: value` line is one trimmed line).

use std::collections::BTreeMap;

use proptest::prelude::*;

use super::*;

#[path = "markdown_source_apply_tests.rs"]
mod apply;

const PAGE: &str = "01J0000000000000000000PAGE";

/// The ids content refs point at. Every one has a name, so the renderer tries
/// to write names, and with no snapshot to check them against must not.
const REF_IDS: [&str; 3] = [
    "01J00000000000000000000RF1",
    "01J00000000000000000000RF2",
    "01J00000000000000000000RF3",
];

fn row(id: &str, parent: &str, position: i64, content: &str) -> BlockRow {
    BlockRow {
        id: BlockId::test_id(id),
        block_type: "content".into(),
        content: Some(content.into()),
        parent_id: Some(BlockId::test_id(parent)),
        position: Some(position),
        deleted_at: None,
        todo_state: None,
        priority: None,
        due_date: None,
        scheduled_date: None,
        page_id: Some(BlockId::test_id(PAGE)),
    }
}

fn page_data(descendants: Vec<BlockRow>) -> PageExportData {
    let mut page = row(PAGE, PAGE, 0, "Title");
    page.block_type = "page".into();
    page.parent_id = None;
    PageExportData {
        page,
        descendants,
        attachments_by_block: HashMap::new(),
        tag_names: HashMap::new(),
        page_titles: HashMap::new(),
        block_ref_replacement: HashMap::new(),
        same_page_ref_targets: HashSet::new(),
        descendant_properties: HashMap::new(),
        list_styles: HashMap::new(),
        ref_titles: HashMap::new(),
        properties: Vec::new(),
        aliases: Vec::new(),
        tag_names_fm: Vec::new(),
        name_snapshot: NameSnapshot::default(),
    }
}

fn text_property(key: &str, value: &str) -> FrontmatterRow {
    FrontmatterRow {
        key: key.into(),
        value_text: Some(value.into()),
        value_date: None,
        value_num: None,
        value_ref: None,
        value_bool: None,
    }
}

fn ref_property(key: &str, target: &str) -> FrontmatterRow {
    FrontmatterRow {
        value_text: None,
        value_ref: Some(target.into()),
        ..text_property(key, "")
    }
}

// ── generator ───────────────────────────────────────────────────────────────

fn arb_ref_id() -> impl Strategy<Value = &'static str> {
    proptest::sample::select(&REF_IDS[..])
}

/// One word of prose. No backtick, so a fence only ever comes from
/// [`arb_fence`].
fn arb_word() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-z0-9]{1,5}",
        "[a-z0-9#:^.()/*\\[\\]\\\\-]{1,5}",
        arb_ref_id().prop_map(|id| format!("[[{id}]]")),
        arb_ref_id().prop_map(|id| format!("#[{id}]")),
        arb_ref_id().prop_map(|id| format!("(({id}))")),
        "\\^[a-z0-9]{1,4}",
    ]
}

/// Words joined by single and double spaces, sometimes with a trailing space.
fn arb_prose() -> impl Strategy<Value = String> {
    let gap = prop_oneof![Just(" "), Just("  ")];
    (
        prop::collection::vec((arb_word(), gap), 0..4),
        any::<bool>(),
    )
        .prop_map(|(words, trailing)| {
            let mut line = String::new();
            for (i, (word, gap)) in words.into_iter().enumerate() {
                if i > 0 {
                    line.push_str(gap);
                }
                line.push_str(&word);
            }
            if trailing && !line.is_empty() {
                line.push(' ');
            }
            line
        })
}

/// A prose line, often opening with something the grammar reads as a marker,
/// an escape or a property.
fn arb_line() -> impl Strategy<Value = String> {
    const PREFIXES: [&str; 13] = [
        "", "- ", "-", "1. ", "[ ] ", "[x] ", "[/] ", "[-] ", "\\", "\\- ", "\\[ ] ", " ", "  ",
    ];
    prop_oneof![
        4 => (proptest::sample::select(&PREFIXES[..]), arb_prose())
            .prop_map(|(prefix, prose)| format!("{prefix}{prose}")),
        1 => ("[a-z][a-z_-]{0,5}", arb_prose()).prop_map(|(key, value)| format!("{key}:: {value}")),
    ]
}

/// A fenced code block, sometimes left open: its body holds blank lines,
/// indentation, and lines that outside a fence would be a bullet or a
/// property, or that read as an anchor line.
fn arb_fence() -> impl Strategy<Value = Vec<String>> {
    let body_line = prop_oneof![
        Just(String::new()),
        " {0,6}[a-z(){};=]{1,6}",
        Just("- x".to_string()),
        Just("key:: v".to_string()),
        Just("[ ] x".to_string()),
        Just("\\- x".to_string()),
        r" ?\\{0,2}\^01J0000000000000000000ANCH",
    ];
    let lang = prop_oneof![Just(""), Just("sh")];
    (lang, prop::collection::vec(body_line, 0..4), any::<bool>()).prop_map(
        |(lang, body, closed)| {
            let mut lines = vec![format!("```{lang}")];
            lines.extend(body);
            if closed {
                lines.push("```".to_string());
            }
            lines
        },
    )
}

fn arb_content() -> impl Strategy<Value = String> {
    let segment = prop_oneof![
        4 => arb_line().prop_map(|line| vec![line]),
        1 => Just(vec![String::new()]),
        1 => arb_fence(),
    ];
    prop::collection::vec(segment, 0..4).prop_map(|segments| segments.concat().join("\n"))
}

fn arb_todo_state() -> impl Strategy<Value = Option<String>> {
    prop_oneof![
        Just(None),
        proptest::sample::select(&["TODO", "DONE", "DOING", "CANCELLED"][..])
            .prop_map(|state| Some(state.to_string())),
        "[A-Za-z]{1,8}"
            .prop_filter("a state outside the checkbox alphabet", |state| {
                import::task_marker_for(state).is_none()
            })
            .prop_map(Some),
    ]
}

/// A custom property value, trimmed and single-line by construction: text, or
/// a ref, which source mode writes as the raw id even though it has a title.
fn arb_property_value() -> impl Strategy<Value = (String, bool)> {
    prop_oneof![
        "[a-z0-9]([a-z0-9 :#^.-]{0,8}[a-z0-9])?".prop_map(|text| (text, false)),
        arb_ref_id().prop_map(|id| (id.to_string(), true)),
    ]
}

fn arb_property_key() -> impl Strategy<Value = String> {
    const RESERVED: [&str; 14] = [
        "space",
        "is_space",
        "created_at",
        "completed_at",
        "repeat",
        "repeat-until",
        "repeat-count",
        "repeat-seq",
        "repeat-origin",
        "template",
        "todo_state",
        "priority",
        "due_date",
        "scheduled_date",
    ];
    "[a-z][a-z0-9_-]{0,6}".prop_filter("a non-reserved key", |key| {
        !RESERVED.contains(&key.as_str())
    })
}

#[derive(Debug, Clone)]
struct BlockSpec {
    level: usize,
    content: String,
    todo_state: Option<String>,
    priority: Option<String>,
    scheduled_date: Option<String>,
    due_date: Option<String>,
    list_style: Option<&'static str>,
    properties: BTreeMap<String, (String, bool)>,
}

fn arb_block() -> impl Strategy<Value = BlockSpec> {
    let date = || proptest::option::of("2026-0[1-9]-[12][0-9]");
    (
        0usize..=4,
        arb_content(),
        arb_todo_state(),
        proptest::option::of("[1-3]"),
        date(),
        date(),
        proptest::sample::select(&[None, Some("bullet"), Some("ordered")][..]),
        prop::collection::btree_map(arb_property_key(), arb_property_value(), 0..=3),
    )
        .prop_map(
            |(
                level,
                content,
                todo_state,
                priority,
                scheduled_date,
                due_date,
                list_style,
                properties,
            )| {
                BlockSpec {
                    level,
                    content,
                    todo_state,
                    priority,
                    scheduled_date,
                    due_date,
                    list_style,
                    properties,
                }
            },
        )
}

/// A forest in depth-first order: each block at most one level below the one
/// before it.
fn arb_forest() -> impl Strategy<Value = Vec<BlockSpec>> {
    prop::collection::vec(arb_block(), 0..8).prop_map(|mut blocks| {
        let mut previous: Option<usize> = None;
        for block in &mut blocks {
            block.level = previous.map_or(0, |p| block.level.min(p + 1));
            previous = Some(block.level);
        }
        blocks
    })
}

/// What one block must read back as: its depth, content, anchor, and the
/// last-wins property map.
type Expected = (usize, String, String, BTreeMap<String, String>);

/// The page data for `forest` and, in the same depth-first order, what each
/// block must read back as.
fn build_page(forest: &[BlockSpec]) -> (PageExportData, Vec<Expected>) {
    let mut descendants = Vec::new();
    let mut expected = Vec::new();
    let mut list_styles = HashMap::new();
    let mut properties = HashMap::new();
    let mut ancestors: Vec<String> = Vec::new();
    let mut child_count: HashMap<String, i64> = HashMap::new();
    for (i, spec) in forest.iter().enumerate() {
        let id = format!("01J{i:023}");
        ancestors.truncate(spec.level);
        let parent = ancestors.last().map_or(PAGE.to_string(), Clone::clone);
        let position = child_count.entry(parent.clone()).or_insert(0);
        *position += 1;
        let mut block = row(&id, &parent, *position, &spec.content);
        block.todo_state.clone_from(&spec.todo_state);
        block.priority.clone_from(&spec.priority);
        block.scheduled_date.clone_from(&spec.scheduled_date);
        block.due_date.clone_from(&spec.due_date);
        descendants.push(block);
        ancestors.push(id.clone());

        let mut expected_properties = BTreeMap::new();
        if let Some(style) = spec.list_style {
            list_styles.insert(id.clone(), style.to_string());
            expected_properties.insert("listStyle".to_string(), style.to_string());
        }
        for (key, value) in [
            ("todo_state", &spec.todo_state),
            ("priority", &spec.priority),
            ("scheduled_date", &spec.scheduled_date),
            ("due_date", &spec.due_date),
        ] {
            if let Some(value) = value {
                expected_properties.insert(key.to_string(), value.clone());
            }
        }
        let rows: Vec<FrontmatterRow> = spec
            .properties
            .iter()
            .map(|(key, (value, is_ref))| {
                expected_properties.insert(key.clone(), value.clone());
                if *is_ref {
                    ref_property(key, value)
                } else {
                    text_property(key, value)
                }
            })
            .collect();
        properties.insert(id.clone(), rows);
        expected.push((spec.level, spec.content.clone(), id, expected_properties));
    }
    let mut data = page_data(descendants);
    data.list_styles = list_styles;
    data.descendant_properties = properties;
    for (n, id) in REF_IDS.iter().enumerate() {
        data.page_titles.insert(id.to_string(), format!("Page {n}"));
        data.tag_names.insert(id.to_string(), format!("tag{n}"));
        data.ref_titles.insert(id.to_string(), format!("Page {n}"));
    }
    (data, expected)
}

/// `parsed` is `expected` block by block, anchors included when `anchored`.
fn check_read_back(
    md: &str,
    parsed: &[import::ParsedBlock],
    expected: &[Expected],
    anchored: bool,
) -> Result<(), TestCaseError> {
    prop_assert_eq!(parsed.len(), expected.len(), "md:\n{}", md);
    for (block, (depth, content, id, properties)) in parsed.iter().zip(expected) {
        prop_assert_eq!(block.depth, *depth, "md:\n{}", md);
        prop_assert_eq!(&block.content, content, "md:\n{}", md);
        if anchored {
            prop_assert_eq!(
                block.block_anchor.as_deref(),
                Some(id.as_str()),
                "md:\n{}",
                md
            );
        }
        let read_back: BTreeMap<String, String> = block.properties.iter().cloned().collect();
        prop_assert_eq!(&read_back, properties, "md:\n{}", md);
    }
    Ok(())
}

proptest! {
    #[test]
    fn a_source_buffer_reads_back_as_the_tree_it_was_rendered_from(forest in arb_forest()) {
        let (data, expected) = build_page(&forest);
        let md = render_page_source(&data);
        check_read_back(&md, &import::parse_source_outline(&md).blocks, &expected, true)?;
    }

    /// Every block selected, so each root carries its subtree.
    #[test]
    fn a_clipboard_copy_pastes_back_as_the_tree_it_was_rendered_from(forest in arb_forest()) {
        let (data, expected) = build_page(&forest);
        let ids: Vec<String> = expected.iter().map(|(_, _, id, _)| id.clone()).collect();
        let md = render_clipboard_source(&data, &ids, true).unwrap();
        check_read_back(&md, &import::parse_pasted_text(&md), &expected, false)?;
    }
}

// ── fixtures ────────────────────────────────────────────────────────────────

/// One small page in source mode: list styles, tasks, properties, a code
/// block, nesting and a raw block ref.
#[test]
fn source_buffer_snapshot() {
    const LIST: &str = "01J0000000000000000000000A";
    const MILK: &str = "01J0000000000000000000000B";
    const EGGS: &str = "01J0000000000000000000000C";
    const CODE: &str = "01J0000000000000000000000D";
    const SEE: &str = "01J0000000000000000000000E";
    let mut eggs = row(EGGS, LIST, 2, "eggs");
    eggs.todo_state = Some("TODO".into());
    let mut see = row(SEE, PAGE, 3, &format!("See (({CODE})) first"));
    see.todo_state = Some("DONE".into());
    see.priority = Some("1".into());
    let mut data = page_data(vec![
        row(LIST, PAGE, 1, "Groceries"),
        row(MILK, LIST, 1, "milk"),
        eggs,
        row(CODE, PAGE, 2, "```sh\necho hi\n```"),
        see,
    ]);
    data.list_styles = [(LIST, "bullet"), (MILK, "ordered"), (EGGS, "ordered")]
        .into_iter()
        .map(|(id, style)| (id.to_string(), style.to_string()))
        .collect();
    data.descendant_properties
        .insert(CODE.to_string(), vec![text_property("lang", "sh")]);
    // An export writes this as a line under `milk`; the buffer has none.
    data.attachments_by_block.insert(
        MILK.to_string(),
        vec![("01J0000000000000000000ATT1".into(), "receipt.pdf".into())],
    );
    insta::assert_snapshot!(render_page_source(&data));
}

/// A block that leaves its fence open gets its anchor on a line of its own,
/// which ends the fence before the child.
#[test]
fn an_open_fence_ends_at_its_blocks_anchor_line() {
    const A: &str = "01J0000000000000000000000A";
    const B: &str = "01J0000000000000000000000B";
    let data = page_data(vec![row(A, PAGE, 1, "````"), row(B, A, 1, "B")]);
    assert_eq!(
        render_page_source(&data),
        format!("- ````\n  ^{A}\n  - B ^{B}\n")
    );
}

/// A copy writes no `^ID` a block reads back without, so a plain subtree has
/// none.
#[test]
fn a_clipboard_copy_of_a_plain_subtree_has_no_anchor() {
    const A: &str = "01J0000000000000000000000A";
    const B: &str = "01J0000000000000000000000B";
    const C: &str = "01J0000000000000000000000C";
    let mut child = row(B, A, 1, "child");
    child.todo_state = Some("DONE".into());
    let data = page_data(vec![
        row(A, PAGE, 1, "parent\nsecond line"),
        child,
        row(C, PAGE, 2, "sibling"),
    ]);
    assert_eq!(
        render_clipboard_source(&data, &[A.into(), C.into()], true).unwrap(),
        "- parent\n  second line\n  - [x] child\n- sibling\n"
    );
}

/// The blocks that would read back as something else without their `^ID`
/// keep it: one leaving a fence open, whose anchor line ends the fence before
/// its child, one ending in ` ^word`, and one ending in a blank line.
#[test]
fn a_clipboard_copy_keeps_the_anchors_blocks_need_to_read_back() {
    const A: &str = "01J0000000000000000000000A";
    const B: &str = "01J0000000000000000000000B";
    const C: &str = "01J0000000000000000000000C";
    const D: &str = "01J0000000000000000000000D";
    let data = page_data(vec![
        row(A, PAGE, 1, "````"),
        row(B, A, 1, "B"),
        row(C, PAGE, 2, "ends in ^word"),
        row(D, PAGE, 3, "ends in a blank line\n"),
    ]);
    let ids = [A.into(), C.into(), D.into()];
    assert_eq!(
        render_clipboard_source(&data, &ids, true).unwrap(),
        format!("- ````\n  ^{A}\n  - B\n- ends in ^word ^{C}\n- ends in a blank line\n   ^{D}\n")
    );
}

/// `key::` is text, and with the anchor after it would be a property line.
#[test]
fn a_last_line_the_anchor_makes_property_shaped_reads_back_as_text() {
    const A: &str = "01J0000000000000000000000A";
    let md = render_page_source(&page_data(vec![row(A, PAGE, 1, "a\nkey::")]));
    let block = &import::parse_source_outline(&md).blocks[0];
    assert_eq!(block.content, "a\nkey::", "md:\n{md}");
    assert_eq!(block.block_anchor.as_deref(), Some(A), "md:\n{md}");
    assert!(block.properties.is_empty(), "md:\n{md}");
}

const PROJECT: &str = "01J00000000000000000PAGEP1";
const OTHER_PROJECT: &str = "01J00000000000000000PAGEP2";
const C_SHARP: &str = "01J00000000000000000PAGEP3";
const ELSEWHERE: &str = "01J00000000000000000PAGEP4";
const IN_SPACE_ELSEWHERE: &str = "01J00000000000000000PAGEP5";
const WORK: &str = "01J000000000000000000TAGT1";
const DEEP_WORK: &str = "01J000000000000000000TAGT2";
const WORK_LOSER: &str = "01J000000000000000000TAGT3";
const BLOCK: &str = "01J0000000000000000000000A";

/// `content` as a one-block page in source mode, with every ref above named
/// and `names` as what the importer would resolve against.
fn source_with_names(content: &str, pages: &[(&str, &[&str])], tags: &[(&str, &str)]) -> String {
    render_page_source(&data_with_names(content, pages, tags))
}

/// A one-block page holding `content`, with every ref above named and `names`
/// as what the importer would resolve against.
fn data_with_names(
    content: &str,
    pages: &[(&str, &[&str])],
    tags: &[(&str, &str)],
) -> PageExportData {
    let mut data = page_data(vec![row(BLOCK, PAGE, 1, content)]);
    data.page_titles = [
        (PROJECT, "Project"),
        (C_SHARP, "C# Notes"),
        (ELSEWHERE, "Elsewhere"),
    ]
    .into_iter()
    .map(|(id, title)| (id.to_string(), title.to_string()))
    .collect();
    data.tag_names = [
        (WORK, "work"),
        (DEEP_WORK, "deep work"),
        (WORK_LOSER, "Work"),
    ]
    .into_iter()
    .map(|(id, name)| (id.to_string(), name.to_string()))
    .collect();
    data.name_snapshot = NameSnapshot {
        page_ids_by_title: pages
            .iter()
            .map(|(title, ids)| {
                (
                    title.to_string(),
                    ids.iter().map(ToString::to_string).collect(),
                )
            })
            .collect(),
        tag_id_by_norm: tags
            .iter()
            .map(|(norm, id)| (norm.to_string(), id.to_string()))
            .collect(),
    };
    data
}

#[test]
fn a_name_that_reads_back_to_its_id_is_written() {
    let md = source_with_names(
        &format!("see [[{PROJECT}]] #[{WORK}] #[{DEEP_WORK}]"),
        &[("Project", &[PROJECT])],
        &[("work", WORK), ("deep work", DEEP_WORK)],
    );
    assert_eq!(
        md,
        format!("- see [[Project]] #work #[[deep work]] ^{BLOCK}\n")
    );
}

#[test]
fn a_title_two_pages_share_stays_raw() {
    let content = format!("see [[{PROJECT}]]");
    let md = source_with_names(&content, &[("Project", &[PROJECT, OTHER_PROJECT])], &[]);
    assert_eq!(md, format!("- {content} ^{BLOCK}\n"));
}

/// The linked page is in another space, and this space has its own page of
/// that title: the name is unique here and still names a different page.
#[test]
fn a_title_from_another_space_stays_raw() {
    let content = format!("see [[{ELSEWHERE}]]");
    let md = source_with_names(&content, &[("Elsewhere", &[IN_SPACE_ELSEWHERE])], &[]);
    assert_eq!(md, format!("- {content} ^{BLOCK}\n"));
}

/// `[[C# Notes]]` reads back as a link to `C` with an anchor. The block's other
/// link would read back fine, and still goes out raw with it.
#[test]
fn a_title_with_a_hash_stays_raw_and_so_does_its_block() {
    let content = format!("[[{PROJECT}]] and [[{C_SHARP}]]");
    let md = source_with_names(
        &content,
        &[("Project", &[PROJECT]), ("C# Notes", &[C_SHARP])],
        &[],
    );
    assert_eq!(md, format!("- {content} ^{BLOCK}\n"));
}

/// `Work` and `work` normalise alike, and the importer resolves both to the
/// smallest-id tag (#1990), which is not this one.
#[test]
fn a_tag_that_is_not_the_winner_for_its_name_stays_raw() {
    let content = format!("#[{WORK_LOSER}]");
    let md = source_with_names(&content, &[], &[("work", WORK)]);
    assert_eq!(md, format!("- {content} ^{BLOCK}\n"));
}

#[test]
fn a_name_inside_code_stays_raw() {
    let pages: &[(&str, &[&str])] = &[("Project", &[PROJECT])];
    // Four backticks pair up as inline-code spans among themselves, so only
    // the fence keeps the link raw.
    let fenced = format!("````\n[[{PROJECT}]]\n````");
    assert_eq!(
        source_with_names(&fenced, pages, &[]),
        format!("- ````\n  [[{PROJECT}]]\n  ````\n  ^{BLOCK}\n")
    );
    let data = data_with_names(&fenced, pages, &[]);
    assert_eq!(
        render_clipboard_source(&data, &[BLOCK.into()], true).unwrap(),
        format!("- ````\n  [[{PROJECT}]]\n  ````\n"),
        "a copy"
    );
    let inline = format!("`[[{PROJECT}]]`");
    assert_eq!(
        source_with_names(&inline, pages, &[]),
        format!("- {inline} ^{BLOCK}\n")
    );
}
