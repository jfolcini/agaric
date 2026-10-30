//! The Document dialect of Edit as Markdown's buffer (#5691 G1): a plain block
//! is its own paragraph, a list block carries its marker, a task is `- [ ] x`.
//! `Dialect::Document` renders a page and `import::parse_document_outline` and
//! `import::parse_document_text` must read it back as that tree, or a save with
//! no edits would not be a no-op. A clipboard copy (`render_clipboard_source`)
//! is written in the dialect too, and must read back as a paste
//! (`import::parse_pasted_text`) reads it, as the same tree less the anchors
//! (#6190). The render→read proptests are the oracle, over [`super`]'s
//! generator.
//!
//! One normalisation: a block with both a task state and a list style is
//! written as a task, which has no list style (D3), so it reads back without
//! one ([`as_document`]). The text with ids beside it has the exceptions
//! [`document_text_carries`] names. The writer escapes every line that would
//! start a block of its own (D1 as amended), so the render→read proptests
//! cannot see the reader start one; [`typed_rows`] read text typed with no
//! blank line.

use proptest::prelude::*;
use serde_json::{Value, json};

use super::*;

fn plain(level: usize, content: &str) -> BlockSpec {
    BlockSpec {
        level,
        content: content.to_string(),
        todo_state: None,
        priority: None,
        scheduled_date: None,
        due_date: None,
        list_style: None,
        properties: BTreeMap::new(),
    }
}

fn styled(level: usize, content: &str, style: &'static str) -> BlockSpec {
    BlockSpec {
        list_style: Some(style),
        ..plain(level, content)
    }
}

fn task(level: usize, content: &str, state: &str) -> BlockSpec {
    BlockSpec {
        todo_state: Some(state.to_string()),
        ..plain(level, content)
    }
}

/// What each block reads back as from a Document buffer: a task has no list
/// style (D3).
fn as_document(mut expected: Vec<Expected>) -> Vec<Expected> {
    for (.., properties) in &mut expected {
        if properties.contains_key("todo_state") {
            properties.remove("listStyle");
        }
    }
    expected
}

/// A line a Document buffer reads as a block of its own wherever it stands
/// (D1 as amended): a heading, a fence or a thematic break, with text after
/// it or not, now and then after a backslash or shaped like a break but not
/// one.
fn arb_own_block_line() -> impl Strategy<Value = String> {
    const SHAPES: [&str; 13] = [
        "# ", "## ", "######", "```", "```sh", "~~~", "---", "***", "___", "----", "--- ", "\\## ",
        "\\---",
    ];
    let rest = prop_oneof![2 => Just(String::new()), 1 => arb_prose()];
    (proptest::sample::select(&SHAPES[..]), rest).prop_map(|(shape, rest)| format!("{shape}{rest}"))
}

/// [`arb_block`] whose content mixes in [`arb_own_block_line`]s: at its start,
/// a heading or a break the block's other lines follow, and after its first
/// line, a line the writer must escape to keep it in the block.
fn arb_document_block() -> impl Strategy<Value = BlockSpec> {
    let segment = prop_oneof![
        4 => arb_line().prop_map(|line| vec![line]),
        1 => Just(vec![String::new()]),
        1 => arb_fence(),
        2 => arb_own_block_line().prop_map(|line| vec![line]),
    ];
    let content = prop::collection::vec(segment, 0..4).prop_map(|lines| lines.concat().join("\n"));
    (arb_block(), content).prop_map(|(block, content)| BlockSpec { content, ..block })
}

/// A forest of [`arb_document_block`]s led by one of the dialect's hard shapes
/// (§ g.4): a plain block under a list block, which only `+` carries (D4), a
/// first block opening with `---` and a second one, whose line would close the
/// front matter the first opened, or an empty plain block, which only `\`
/// carries (D4).
fn arb_document_forest() -> impl Strategy<Value = Vec<BlockSpec>> {
    let lead = (arb_block(), arb_block(), 0..3, "-{3,4}[a-z ]{0,3}").prop_map(
        |(parent, child, shape, rule)| {
            let child = BlockSpec {
                level: 0,
                list_style: None,
                todo_state: None,
                ..child
            };
            match shape {
                0 => vec![
                    BlockSpec {
                        level: 0,
                        list_style: Some("bullet"),
                        ..parent
                    },
                    BlockSpec { level: 1, ..child },
                ],
                1 => vec![
                    BlockSpec {
                        content: rule.clone(),
                        ..child.clone()
                    },
                    BlockSpec {
                        content: rule,
                        ..child
                    },
                ],
                _ => vec![BlockSpec {
                    content: String::new(),
                    ..child
                }],
            }
        },
    );
    (lead, arb_forest_of(arb_document_block())).prop_map(|(mut lead, forest)| {
        lead.extend(forest);
        lead
    })
}

/// Whether the text with ids beside it carries `spec` exactly. A block that
/// leaves a fence open is ended by the next line carrying an id, and only its
/// anchor line ended it before its property lines or its own last blank line.
fn document_text_carries(spec: &BlockSpec) -> bool {
    let checkbox = spec.todo_state.as_deref().and_then(import::task_marker_for);
    let (list_marker, task_marker) = match (checkbox, &spec.todo_state, spec.list_style) {
        (Some(c), ..) => ("- ", format!("[{c}] ")),
        (None, None, Some("bullet")) => ("- ", String::new()),
        (None, None, Some(_)) => ("1. ", String::new()),
        _ => ("", String::new()),
    };
    let open = push_block_bullet(
        &mut String::new(),
        "",
        list_marker,
        &task_marker,
        &spec.content,
        RenderMode::Document,
    )
    .open;
    let ends_blank = spec
        .content
        .rsplit_once('\n')
        .is_some_and(|(_, last)| last.trim().is_empty());
    let property_lines = (spec.todo_state.is_some() && checkbox.is_none())
        || spec.priority.is_some()
        || spec.scheduled_date.is_some()
        || spec.due_date.is_some()
        || !spec.properties.is_empty();
    !(open && (ends_blank || property_lines))
}

/// `text` read by the ids `line_ids` gives its lines, each block under the id
/// of the line it starts on.
fn read_by_ids(text: &str, line_ids: &[Option<String>]) -> import::ParseOutput {
    let id_lines = (1..=line_ids.len())
        .filter(|&line| line_ids[line - 1].is_some())
        .collect();
    let mut parsed = import::parse_document_text(text, &id_lines);
    for block in &mut parsed.blocks {
        let line = block.line.expect("a buffer's block has a line");
        block.block_anchor.clone_from(&line_ids[line - 1]);
    }
    parsed
}

/// A page with no properties reads back with none, and nothing refused: no
/// block's line opened front matter or read as a page property.
fn check_no_page_properties(md: &str, parsed: &import::ParseOutput) -> Result<(), TestCaseError> {
    prop_assert!(parsed.frontmatter.is_empty(), "md:\n{}", md);
    prop_assert_eq!(&parsed.frontmatter_refusal, &None, "md:\n{}", md);
    Ok(())
}

/// `block`, read back, as the spec [`build_page`] stores: the task columns,
/// the list style and the other properties as text rows, in the order read.
fn spec_of(block: &import::ParsedBlock) -> BlockSpec {
    let mut spec = plain(block.depth, &block.content);
    for (key, value) in &block.properties {
        let value = value.clone();
        match key.as_str() {
            "todo_state" => spec.todo_state = Some(value),
            "priority" => spec.priority = Some(value),
            "scheduled_date" => spec.scheduled_date = Some(value),
            "due_date" => spec.due_date = Some(value),
            "listStyle" => {
                spec.list_style = ["bullet", "ordered"]
                    .into_iter()
                    .find(|style| value == *style);
            }
            _ => {
                spec.properties.insert(key.clone(), (value, false));
            }
        }
    }
    spec
}

proptest! {
    /// Render → read is the tree, anchors included, but for [`as_document`].
    #[test]
    fn a_document_reads_back_as_the_tree_it_was_rendered_from(forest in arb_document_forest()) {
        let (data, expected) = build_page(&forest);
        let (md, _) = Dialect::Document.render(&data);
        let parsed = import::parse_document_outline(&md);
        check_no_page_properties(&md, &parsed)?;
        check_read_back(&md, &parsed.blocks, &as_document(expected), true)?;
    }

    /// The buffer less its anchors holds one id entry per line, and read by
    /// those ids is the tree, for every block the text carries.
    #[test]
    fn a_document_read_by_its_line_ids_is_the_tree_it_was_rendered_from(
        forest in arb_document_forest()
            .prop_filter("the text carries it", |forest| forest.iter().all(document_text_carries))
    ) {
        let (data, expected) = build_page(&forest);
        let (text, line_ids) = anchor_free_as(&Dialect::Document.render(&data).0, Dialect::Document);
        prop_assert_eq!(text.split('\n').count(), line_ids.len(), "text:\n{}", text);
        let parsed = read_by_ids(&text, &line_ids);
        check_no_page_properties(&text, &parsed)?;
        check_read_back(&text, &parsed.blocks, &as_document(expected), true)?;
    }

    /// A copy of every block, so each root carries its subtree, pastes back
    /// as the tree, but for [`as_document`] (#6190).
    #[test]
    fn a_clipboard_copy_pastes_back_as_the_tree_it_was_rendered_from(
        forest in arb_document_forest()
    ) {
        let (data, expected) = build_page(&forest);
        let ids: Vec<String> = expected.iter().map(|(_, _, id, _)| id.clone()).collect();
        let md = render_clipboard_source(&data, &ids, true);
        check_read_back(&md, &import::parse_pasted_text(&md), &as_document(expected), false)?;
    }

    /// Render → read → render writes the same bytes.
    #[test]
    fn a_document_renders_its_own_reading_as_the_same_text(forest in arb_document_forest()) {
        let (data, _) = build_page(&forest);
        let (md, _) = Dialect::Document.render(&data);
        let read: Vec<BlockSpec> =
            import::parse_document_outline(&md).blocks.iter().map(spec_of).collect();
        let (again, _) = Dialect::Document.render(&build_page(&read).0);
        prop_assert_eq!(again, md);
    }
}

/// The hard cases of § g.3, by row, as D1–D4 settle them: each tree and the
/// text it is written as.
fn document_rows() -> Vec<(&'static str, Vec<BlockSpec>, &'static str)> {
    let with_properties = BlockSpec {
        priority: Some("1".into()),
        properties: BTreeMap::from([("k".into(), ("v".into(), false))]),
        ..plain(0, "a")
    };
    vec![
        (
            "1: a plain block is its own line",
            vec![plain(0, "text")],
            "text\n",
        ),
        (
            "2: a heading owns nothing; its child is indented after a blank line",
            vec![plain(0, "## Findings"), plain(1, "**Bold** text")],
            "## Findings\n\n  **Bold** text\n",
        ),
        (
            "3: a list block carries its marker, numbered by position; a task is `- [ ]`",
            vec![
                styled(0, "a", "bullet"),
                styled(0, "b", "ordered"),
                styled(0, "c", "ordered"),
                task(0, "d", "TODO"),
            ],
            "- a\n1. b\n2. c\n- [ ] d\n",
        ),
        (
            "3: an empty list block is its marker",
            vec![
                styled(0, "", "bullet"),
                styled(0, "", "ordered"),
                task(0, "", "TODO"),
            ],
            "- \n1. \n- [ ] \n",
        ),
        (
            "3: a task with a list style is a task, which ends a numbered run (D3)",
            vec![
                BlockSpec {
                    list_style: Some("ordered"),
                    ..task(0, "a", "TODO")
                },
                styled(0, "b", "ordered"),
            ],
            "- [ ] a\n1. b\n",
        ),
        (
            "3: past nine items the marker is wider, and so is the column of what sits under it",
            (1..=10)
                .map(|n| styled(0, if n == 10 { "ten\nmore" } else { "i" }, "ordered"))
                .chain([plain(1, "child")])
                .collect(),
            "1. i\n2. i\n3. i\n4. i\n5. i\n6. i\n7. i\n8. i\n9. i\n10. ten\n    more\n    + child\n",
        ),
        (
            "4: a block's lines stay together, a line that would start a block escaped",
            vec![
                plain(0, "line one\nline two\n- not a bullet\nkey:: v"),
                styled(0, "item\n## not a heading", "bullet"),
            ],
            "line one\nline two\n\\- not a bullet\n\\key:: v\n\n- item\n  \\## not a heading\n",
        ),
        (
            "5: a fence keeps its blank lines and its markup, and the lines after it continue it",
            vec![plain(0, "```sh\necho\n\n- x\n```\nafter")],
            "```sh\necho\n\n- x\n```\nafter\n",
        ),
        (
            "6: a table and a quote are one block each",
            vec![plain(0, "| a | b |\n| - | - |"), plain(0, "> a\n> b")],
            "| a | b |\n| - | - |\n\n> a\n> b\n",
        ),
        (
            "7: a paragraph under a paragraph is indented after a blank line",
            vec![
                plain(0, "parent"),
                plain(1, "child"),
                plain(2, "grandchild"),
            ],
            "parent\n\n  child\n\n    grandchild\n",
        ),
        (
            "8: a list under a paragraph is indented after a blank line",
            vec![
                plain(0, "para"),
                styled(1, "a", "bullet"),
                styled(1, "b", "bullet"),
            ],
            "para\n\n  - a\n  - b\n",
        ),
        (
            "9: a blank line separates blocks, but not neighbouring list lines",
            vec![
                plain(0, "a"),
                styled(0, "b", "bullet"),
                styled(1, "c", "ordered"),
                plain(0, "d"),
            ],
            "a\n\n- b\n  1. c\n\nd\n",
        ),
        (
            "10: a plain block under a list block or a task is a `+` item",
            vec![
                styled(0, "a", "ordered"),
                plain(1, "b"),
                plain(2, "c"),
                task(0, "d", "TODO"),
                plain(1, "e"),
            ],
            "1. a\n   + b\n     + c\n- [ ] d\n  + e\n",
        ),
        (
            "11: property lines sit under their block at its text column",
            vec![
                with_properties,
                BlockSpec {
                    due_date: Some("2026-01-02".into()),
                    ..styled(0, "b", "ordered")
                },
            ],
            "a\n  priority:: 1\n  k:: v\n\n1. b\n   due_date:: 2026-01-02\n",
        ),
        (
            "12: each checkbox is its state; another state is a line, never a bullet",
            vec![
                task(0, "a", "DONE"),
                task(0, "b", "DOING"),
                task(0, "c", "CANCELLED"),
                BlockSpec {
                    list_style: Some("bullet"),
                    ..task(0, "d", "WAITING")
                },
            ],
            "- [x] a\n- [/] b\n- [-] c\n\nd\n  todo_state:: WAITING\n",
        ),
        (
            "13: text shaped like markup opening a bare line is escaped",
            vec![
                plain(0, "- x"),
                plain(0, "* x"),
                plain(0, "+ x"),
                plain(0, "1. x"),
                plain(0, "1) x"),
                plain(0, "key:: v"),
                plain(0, "  x"),
                plain(0, "\\- x"),
                plain(0, "[ ] x"),
            ],
            "\\- x\n\n\\* x\n\n\\+ x\n\n\\1. x\n\n\\1) x\n\n\\key:: v\n\n\\  x\n\n\\\\- x\n\n[ ] x\n",
        ),
        (
            "13: a checkbox opening a list block's or a `+` item's text is escaped",
            vec![styled(0, "[ ] x", "bullet"), plain(1, "[x] y")],
            "- \\[ ] x\n  + \\[x] y\n",
        ),
        (
            "13: a first block opening with `---` is a `+` item, not front matter",
            vec![plain(0, "---"), plain(0, "---")],
            "+ ---\n\n---\n",
        ),
        (
            "14: an empty plain block and an interior blank line are a `\\` line",
            vec![plain(0, ""), plain(0, "a\n\nb\n")],
            "\\\n\na\n\\\nb\n\\\n",
        ),
        (
            "15: headings stay flat",
            vec![
                plain(0, "# H"),
                plain(0, "para"),
                plain(0, "## H2"),
                styled(0, "x", "bullet"),
            ],
            "# H\n\npara\n\n## H2\n\n- x\n",
        ),
        (
            "19: a list style on a heading keeps its marker",
            vec![styled(0, "## x", "bullet")],
            "- ## x\n",
        ),
        (
            "D1: a paragraph and the heading under it are two blocks",
            vec![plain(0, "para"), plain(0, "## Heading")],
            "para\n\n## Heading\n",
        ),
        (
            "D1: a heading is a block of one line, and the text under it the next block",
            vec![plain(0, "## Heading"), plain(0, "text")],
            "## Heading\n\ntext\n",
        ),
        (
            "D1: a paragraph and the fence under it are two blocks",
            vec![plain(0, "intro:"), plain(0, "```sh\nls\n```")],
            "intro:\n\n```sh\nls\n```\n",
        ),
        (
            "D1: a thematic break between paragraphs is a block of its own",
            vec![plain(0, "para"), plain(0, "---"), plain(0, "after")],
            "para\n\n---\n\nafter\n",
        ),
        (
            "D1: a heading line in a paragraph's text is escaped",
            vec![plain(0, "para\n## x")],
            "para\n\\## x\n",
        ),
        (
            "D1: a fence line in a paragraph's text is escaped, so no line after it is code",
            vec![plain(0, "intro:\n```sh\n- x\n```")],
            "intro:\n\\```sh\n\\- x\n\\```\n",
        ),
        (
            "D1: a thematic break in a paragraph's text is escaped, not read as a setext underline",
            vec![plain(0, "para\n---\n***")],
            "para\n\\---\n\\***\n",
        ),
        (
            "D1: a code block's lines are its own, a heading's and a break's too",
            vec![plain(0, "```\n## x\n---\n```")],
            "```\n## x\n---\n```\n",
        ),
        (
            "D1: a heading or a break with a line after it, as a hard break makes, is escaped",
            vec![
                plain(0, "## Heading\\\nsecond line"),
                plain(0, "---\nafter"),
            ],
            "\\## Heading\\\nsecond line\n\n\\---\nafter\n",
        ),
        (
            "D1: a backslash before a heading or a break opening a bare line is escaped too",
            vec![plain(0, "\\## x"), plain(0, "\\---")],
            "\\\\## x\n\n\\\\---\n",
        ),
        (
            "D1: the escape of a heading, fence or break line in a paragraph's text goes before its indent",
            vec![plain(0, "para\n  ## x\n  ```sh\n  ---")],
            "para\n\\  ## x\n\\  ```sh\n\\  ---\n",
        ),
        (
            "D1: a backslash before a heading, a fence or a break in a paragraph's text is escaped again",
            vec![plain(0, "para\n\\## x\n\\```sh\n\\---")],
            "para\n\\\\## x\n\\\\```sh\n\\\\---\n",
        ),
        (
            "D1: dashes before a multi-byte character, and a hash or dashes after one, are text",
            vec![plain(0, "para"), plain(0, "---é\n---é\né## x\n😀---")],
            "para\n\n---é\n---é\né## x\n😀---\n",
        ),
        (
            "D1: a break followed by a Unicode space is still a break, as the reader trims it",
            vec![plain(0, "para\n---\u{a0}")],
            "para\n\\---\u{a0}\n",
        ),
    ]
}

/// Text typed with no blank line between blocks (D1 as amended): each text and
/// the tree it reads as. A heading, a fence or a thematic break starts a block
/// of its own wherever it stands, under a list item's text too, and a list
/// item still interrupts a paragraph.
fn typed_rows() -> Vec<(&'static str, &'static str, Vec<BlockSpec>)> {
    vec![
        (
            "a heading typed under a paragraph starts its own block",
            "para\n## Heading",
            vec![plain(0, "para"), plain(0, "## Heading")],
        ),
        (
            "the line typed under a heading starts its own block",
            "## Heading\ntext",
            vec![plain(0, "## Heading"), plain(0, "text")],
        ),
        (
            "a fence typed under a paragraph starts its own block",
            "intro:\n```sh\nls\n```",
            vec![plain(0, "intro:"), plain(0, "```sh\nls\n```")],
        ),
        (
            "a thematic break typed under a paragraph is its own block, not a setext underline",
            "para\n---\nafter",
            vec![plain(0, "para"), plain(0, "---"), plain(0, "after")],
        ),
        (
            "under a list item's text, a heading, a fence and a break start blocks of their own",
            "- a\n## H\n- b\n  ```\n  x\n  ```\n- c\n  ***",
            vec![
                styled(0, "a", "bullet"),
                plain(0, "## H"),
                styled(0, "b", "bullet"),
                plain(1, "```\nx\n```"),
                styled(0, "c", "bullet"),
                plain(1, "***"),
            ],
        ),
        (
            "a list item still interrupts a paragraph",
            "para\n- a",
            vec![plain(0, "para"), styled(0, "a", "bullet")],
        ),
    ]
}

/// Text pasted from outside (#6190): each text and the tree a paste reads it
/// as. A paste reads the dialect as it reads any text from outside: no page
/// properties, a `key::` with no value is text, a fence ends with the list
/// item holding it, and a trailing `^word` that is no block id is text.
fn pasted_rows() -> Vec<(&'static str, &'static str, Vec<BlockSpec>)> {
    let with_key = |spec: BlockSpec| BlockSpec {
        properties: BTreeMap::from([("key".to_string(), ("v".to_string(), false))]),
        ..spec
    };
    vec![
        (
            "D2: `-` and `*` make bulleted blocks and `1.` a numbered one; D4: `+` a plain child",
            "- a\n* b\n1. c\n   + d\n",
            vec![
                styled(0, "a", "bullet"),
                styled(0, "b", "bullet"),
                styled(0, "c", "ordered"),
                plain(1, "d"),
            ],
        ),
        (
            "D3: a task has no list style, and its property lines are its own",
            "- [ ] t\n  key:: v\n1. [x] u\n",
            vec![with_key(task(0, "t", "TODO")), task(0, "u", "DONE")],
        ),
        (
            "front matter is no page's: a break, a paragraph and a break",
            "---\ntitle: x\n---\n",
            vec![plain(0, "---"), plain(0, "title: x"), plain(0, "---")],
        ),
        (
            "a property line before any block is text",
            "key:: v\n\npara\n",
            vec![plain(0, "key:: v"), plain(0, "para")],
        ),
        (
            "a property line with no value is text",
            "- a\n  note::\n",
            vec![styled(0, "a\nnote::", "bullet")],
        ),
        (
            "a fence ends with the list item holding it",
            "- ```\n  code\nafter\n\nnext\n",
            vec![styled(0, "```\ncode\nafter", "bullet"), plain(0, "next")],
        ),
        (
            "a trailing `^word` that is no block id is text, and a block id, in either case, is not",
            "a ^word\n\nb ^01J0000000000000000000000B\n\nc ^01j0000000000000000000000c\n",
            vec![plain(0, "a ^word"), plain(0, "b"), plain(0, "c")],
        ),
    ]
}

/// Each pasted text reads as its tree.
#[test]
fn a_paste_reads_each_pasted_text_as_its_tree() {
    for (name, text, forest) in pasted_rows() {
        let (_, expected) = build_page(&forest);
        let result = check_read_back(
            text,
            &import::parse_pasted_text(text),
            &as_document(expected),
            false,
        );
        assert!(result.is_ok(), "{name}: {result:?}");
    }
}

/// Each typed text reads as its tree.
#[test]
fn a_heading_a_fence_or_a_break_typed_under_text_starts_its_own_block() {
    for (name, typed, forest) in typed_rows() {
        let (_, expected) = build_page(&forest);
        let read = import::parse_document_outline(typed);
        let result = check_no_page_properties(typed, &read)
            .and_then(|()| check_read_back(typed, &read.blocks, &as_document(expected), false));
        assert!(result.is_ok(), "{name}: {result:?}");
    }
}

/// Each row's tree is written as its text, and that text, read by its line
/// ids, is the tree, each block under its own id.
#[test]
fn each_hard_case_is_written_as_its_row_and_read_back() {
    for (name, forest, written) in document_rows() {
        let (data, expected) = build_page(&forest);
        let (text, line_ids) =
            anchor_free_as(&Dialect::Document.render(&data).0, Dialect::Document);
        assert_eq!(text, written, "{name}");
        let read = read_by_ids(&text, &line_ids);
        let result = check_no_page_properties(&text, &read)
            .and_then(|()| check_read_back(&text, &read.blocks, &as_document(expected), true));
        assert!(result.is_ok(), "{name}: {result:?}");
    }
}

/// `conformance/document-lines.vectors.json`: each row as the tree it reads
/// back as, every block under its id, the text it is written as and the id
/// each line of the text carries, and each typed or pasted text with the tree
/// it reads as. Rust authors it (`CONFORMANCE_UPDATE=1`) from the rows above, which
/// assert it; the editor's reader asserts it too.
#[test]
fn the_document_lines_vectors_are_the_rows() {
    let cases: Vec<Value> = document_rows()
        .into_iter()
        .map(|(name, forest, _)| {
            let (data, expected) = build_page(&forest);
            let (text, line_ids) =
                anchor_free_as(&Dialect::Document.render(&data).0, Dialect::Document);
            let tree: Vec<Value> = as_document(expected)
                .into_iter()
                .map(|(depth, content, id, properties)| {
                    json!({ "id": id, "depth": depth, "content": content, "properties": properties })
                })
                .collect();
            json!({ "name": name, "tree": tree, "text": text, "lineIds": line_ids })
        })
        .collect();
    let read = |rows: Vec<(&str, &str, Vec<BlockSpec>)>| -> Vec<Value> {
        rows.into_iter()
            .map(|(name, text, forest)| {
                let tree: Vec<Value> = as_document(build_page(&forest).1)
                    .into_iter()
                    .map(|(depth, content, _, properties)| {
                        json!({ "depth": depth, "content": content, "properties": properties })
                    })
                    .collect();
                json!({ "name": name, "tree": tree, "text": text })
            })
            .collect()
    };
    let typed = read(typed_rows());
    let pasted = read(pasted_rows());
    let vectors = json!({
        "description": "#5691 — Edit as Markdown's Document dialect, one case per hard case of the \
            line-split format: the tree, each block under its id, the text a page holding it is \
            written as, and the id each line of that text carries; under `typed`, text typed \
            with no blank line between blocks and the tree it reads as, ids aside; and under \
            `pasted`, text pasted from outside and the tree a paste reads it as (#6190). \
            Authored by `markdown_document_tests.rs` with CONFORMANCE_UPDATE=1; never hand-edit.",
        "cases": cases,
        "typed": typed,
        "pasted": pasted,
    });
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../conformance/document-lines.vectors.json"
    );
    if std::env::var("CONFORMANCE_UPDATE").as_deref() == Ok("1") {
        let mut out = serde_json::to_string_pretty(&vectors).expect("vectors serialise");
        out.push('\n');
        std::fs::write(path, out).expect("write the document-lines vectors");
        return;
    }
    let written: Value = serde_json::from_str(
        &std::fs::read_to_string(path).expect("read the document-lines vectors"),
    )
    .expect("the document-lines vectors are JSON");
    assert_eq!(
        written, vectors,
        "the vectors drifted from the rows: re-author with CONFORMANCE_UPDATE=1"
    );
}

/// Duplicate through a Document buffer against the Source buffer it replaced
/// (#6190), on a real pool. Part B deletes this with `Dialect::Source`.
mod duplicate {
    use super::*;
    use crate::commands::tests::common::{
        DEV, TEST_SPACE_ID, create_test_property_def, ensure_test_space, mark_block_as_space,
        settle, test_pool,
    };
    use crate::commands::{
        create_block_inner, create_page_in_space_inner, set_due_date_inner, set_priority_inner,
        set_property_inner, set_scheduled_date_inner, set_todo_state_inner,
    };

    async fn child(
        pool: &SqlitePool,
        mat: &Materializer,
        parent: &BlockId,
        content: &str,
    ) -> BlockId {
        create_block_inner(
            pool,
            DEV,
            mat,
            "content".into(),
            content.into(),
            Some(parent.clone()),
            None,
        )
        .await
        .unwrap()
        .id
    }

    async fn set(
        pool: &SqlitePool,
        mat: &Materializer,
        block: &BlockId,
        key: &str,
        text: Option<&str>,
        reference: Option<&BlockId>,
    ) {
        set_property_inner(
            pool,
            DEV,
            mat,
            block.as_str().into(),
            key.into(),
            text.map(Into::into),
            None,
            None,
            reference.map(|id| id.as_str().to_owned()),
            None,
            None,
        )
        .await
        .unwrap();
    }

    /// A copied row as the copy stores it, ids aside: the index of its parent
    /// among the rows, its content, its task columns, its property rows, and
    /// which task stamps it carries, whose dates are the clock's.
    type Shape = (Option<usize>, Option<String>, Vec<String>);

    /// A property row: its key, then its text, number, ref and date values.
    type PropertyRow = (
        String,
        Option<String>,
        Option<f64>,
        Option<String>,
        Option<String>,
    );

    async fn shapes(pool: &SqlitePool, rows: &[BlockRow]) -> Vec<Shape> {
        let mut out = Vec::new();
        for row in rows {
            let parent = rows
                .iter()
                .position(|r| Some(&r.id) == row.parent_id.as_ref());
            let (todo, priority, scheduled, due): (
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
            ) = sqlx::query_as(
                "SELECT todo_state, priority, scheduled_date, due_date FROM blocks WHERE id = ?",
            )
            .bind(row.id.as_str())
            .fetch_one(pool)
            .await
            .unwrap();
            let mut storage = vec![format!(
                "todo={todo:?} priority={priority:?} scheduled={scheduled:?} due={due:?}"
            )];
            let props: Vec<PropertyRow> = sqlx::query_as(
                "SELECT key, value_text, value_num, value_ref, \
                            CASE WHEN key IN ('created_at', 'completed_at') THEN NULL \
                                 ELSE value_date END \
                     FROM block_properties WHERE block_id = ? ORDER BY key",
            )
            .bind(row.id.as_str())
            .fetch_all(pool)
            .await
            .unwrap();
            for (key, text, num, reference, date) in props {
                storage.push(format!(
                    "{key} text={text:?} num={num:?} ref={reference:?} date={date:?}"
                ));
            }
            out.push((parent, row.content.clone(), storage));
        }
        out
    }

    /// What a Source copy reads as through a Document buffer: a task has no
    /// list style (D3).
    fn as_document(mut shapes: Vec<Shape>) -> Vec<Shape> {
        for (_, _, storage) in &mut shapes {
            if !storage[0].starts_with("todo=None") {
                storage.retain(|row| !row.starts_with("listStyle "));
            }
        }
        shapes
    }

    /// The copy keeps each block's content, nesting, list style, task state,
    /// stamps, task columns and properties as the Source buffer kept them: a
    /// plain block, a bulleted one with a plain child, a numbered run, an empty
    /// block, a task in each state and one outside the checkbox set, a heading,
    /// a code block, a two-line paragraph, refs and typed properties. The one
    /// difference is D3's: a block holding a task state and a list style is
    /// copied as a task without the style.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_document_duplicate_copies_what_a_source_duplicate_copied() {
        let (pool, _dir) = test_pool().await;
        let mat = Materializer::new(pool.clone());
        ensure_test_space(&pool).await;
        mark_block_as_space(&pool, TEST_SPACE_ID).await;
        let page =
            create_page_in_space_inner(&pool, DEV, &mat, None, "Dup".into(), TEST_SPACE_ID.into())
                .await
                .unwrap();
        create_test_property_def(&pool, "reviewer".into(), "ref".into(), None)
            .await
            .unwrap();
        let target = child(&pool, &mat, &page, "the reviewer").await;
        let root = child(&pool, &mat, &page, "root").await;
        child(&pool, &mat, &root, "plain").await;
        let bulleted = child(&pool, &mat, &root, "bulleted").await;
        set(&pool, &mat, &bulleted, "listStyle", Some("bullet"), None).await;
        child(&pool, &mat, &bulleted, "plain under a bullet").await;
        for content in ["first", "second"] {
            let numbered = child(&pool, &mat, &root, content).await;
            set(&pool, &mat, &numbered, "listStyle", Some("ordered"), None).await;
        }
        child(&pool, &mat, &root, "").await;
        for state in ["TODO", "DONE", "DOING", "CANCELLED"] {
            let task = child(&pool, &mat, &root, &state.to_lowercase()).await;
            set_todo_state_inner(&pool, DEV, &mat, task.as_str().into(), Some(state.into()))
                .await
                .unwrap();
        }
        // A state from before the task states were fixed (#5841), which no
        // command writes now.
        let waiting = child(&pool, &mat, &root, "waiting").await;
        sqlx::query("UPDATE blocks SET todo_state = 'WAITING' WHERE id = ?")
            .bind(waiting.as_str())
            .execute(&pool)
            .await
            .unwrap();
        let legacy = child(&pool, &mat, &root, "a bulleted task").await;
        set_todo_state_inner(
            &pool,
            DEV,
            &mat,
            legacy.as_str().into(),
            Some("TODO".into()),
        )
        .await
        .unwrap();
        set(&pool, &mat, &legacy, "listStyle", Some("bullet"), None).await;
        child(&pool, &mat, &root, "## heading").await;
        child(&pool, &mat, &root, "```sh\necho hi\n```").await;
        child(&pool, &mat, &root, "line one\nline two").await;
        let refs = child(
            &pool,
            &mat,
            &root,
            &format!("see [[{page}]] and (({target}))"),
        )
        .await;
        set(&pool, &mat, &refs, "reviewer", None, Some(&target)).await;
        set(&pool, &mat, &refs, "note", Some("free text"), None).await;
        let id = || refs.as_str().into();
        set_priority_inner(&pool, DEV, &mat, id(), Some("2".into()))
            .await
            .unwrap();
        set_scheduled_date_inner(&pool, DEV, &mat, id(), Some("2026-02-01".into()))
            .await
            .unwrap();
        set_due_date_inner(&pool, DEV, &mat, id(), Some("2026-03-01".into()))
            .await
            .unwrap();
        settle(&mat).await;

        let document = duplicate_block_as(&pool, DEV, &mat, root.clone(), Dialect::Document)
            .await
            .unwrap();
        settle(&mat).await;
        let source = duplicate_block_as(&pool, DEV, &mat, root.clone(), Dialect::Source)
            .await
            .unwrap();
        settle(&mat).await;

        let document = shapes(&pool, &document).await;
        assert_eq!(
            document.len(),
            17,
            "the root and its 16 blocks: {document:#?}"
        );
        assert_eq!(
            document,
            as_document(shapes(&pool, &source).await),
            "the Document copy is the Source copy, but for D3"
        );
        let task = document
            .iter()
            .find(|(_, content, _)| content.as_deref() == Some("a bulleted task"))
            .expect("the bulleted task is copied");
        assert_eq!(
            task.2[..2],
            [
                r#"todo=Some("TODO") priority=None scheduled=None due=None"#.to_owned(),
                "created_at text=None num=None ref=None date=None".to_owned(),
            ],
            "a bulleted task is copied as a task, stamped, without its list style (D3)"
        );
        assert_eq!(task.2.len(), 2, "and nothing more: {task:?}");
        mat.shutdown();
    }
}
