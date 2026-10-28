//! The Document dialect of Edit as Markdown's buffer (#5691 G1): a plain block
//! is its own paragraph, a list block carries its marker, a task is `- [ ] x`.
//! `Dialect::Document` renders a page and `import::parse_document_outline` and
//! `import::parse_document_text` must read it back as that tree, or a save with
//! no edits would not be a no-op. The render→read proptests are the oracle,
//! over [`super`]'s generator.
//!
//! One normalisation: a block with both a task state and a list style is
//! written as a task, which has no list style (D3), so it reads back without
//! one ([`as_document`]). The text with ids beside it has the exceptions
//! [`document_text_carries`] names.

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

/// [`arb_forest`] led by one of the dialect's hard shapes (§ g.4): a plain
/// block under a list block, which only `+` carries (D4), a first block opening
/// with `---` and a second one, whose line would close the front matter the
/// first opened, or an empty plain block, which only `\` carries (D4).
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
    (lead, arb_forest()).prop_map(|(mut lead, forest)| {
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
            "4: a block's lines stay together, a line that would start a block escaped",
            vec![
                plain(0, "line one\nline two\n- not a bullet\nkey:: v"),
                styled(0, "item\n## not a heading", "bullet"),
            ],
            "line one\nline two\n\\- not a bullet\n\\key:: v\n\n- item\n  \\## not a heading\n",
        ),
        (
            "5: a fence keeps its blank lines and its markup",
            vec![plain(0, "intro\n```sh\necho\n\n- x\n```\nafter")],
            "intro\n```sh\necho\n\n- x\n```\nafter\n",
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
    ]
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
/// each line of the text carries. Rust authors it (`CONFORMANCE_UPDATE=1`)
/// from the rows above, which assert it; the editor's reader asserts it too.
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
    let vectors = json!({
        "description": "#5691 — Edit as Markdown's Document dialect, one case per hard case of the \
            line-split format: the tree, each block under its id, the text a page holding it is \
            written as, and the id each line of that text carries. Authored by \
            `markdown_document_tests.rs` with CONFORMANCE_UPDATE=1; never hand-edit.",
        "cases": cases,
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
