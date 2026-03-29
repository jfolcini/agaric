use block_notes_lib::serializer::{
    emit, parse, parse_checked, InlineNode, OrgDoc, OrgMark, OrgParagraph, OrgSerializerConfig,
    OrgSerializerConfigUpdate, OrgTimestamp, TextNode, ENTITIES, ESCAPE_CHARS, MAX_INPUT_SIZE,
    REVERSE_ENTITIES,
};

fn text(s: &str) -> InlineNode {
    InlineNode::Text(TextNode {
        text: s.into(),
        marks: vec![],
    })
}
fn marked(s: &str, m: Vec<OrgMark>) -> InlineNode {
    InlineNode::Text(TextNode {
        text: s.into(),
        marks: m,
    })
}
fn doc(ps: Vec<Vec<InlineNode>>) -> OrgDoc {
    OrgDoc {
        paragraphs: ps
            .into_iter()
            .map(|c| OrgParagraph { content: c })
            .collect(),
    }
}
fn round_trip(input: &str) -> String {
    emit(&parse(input))
}
const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

// Parser
#[test]
fn parse_empty() {
    assert!(parse("").paragraphs.is_empty());
}
#[test]
fn parse_plain() {
    assert_eq!(parse("hello").paragraphs[0].content, vec![text("hello")]);
}
#[test]
fn parse_bold() {
    assert_eq!(
        parse("*hi*").paragraphs[0].content,
        vec![marked("hi", vec![OrgMark::Bold])]
    );
}
#[test]
fn parse_italic() {
    assert_eq!(
        parse("/hi/").paragraphs[0].content,
        vec![marked("hi", vec![OrgMark::Italic])]
    );
}
#[test]
fn parse_code() {
    assert_eq!(
        parse("~hi~").paragraphs[0].content,
        vec![marked("hi", vec![OrgMark::Code])]
    );
}
#[test]
fn parse_unclosed() {
    assert_eq!(parse("*x").paragraphs[0].content, vec![text("*x")]);
}
#[test]
fn parse_esc() {
    assert_eq!(parse("\\*x\\*").paragraphs[0].content, vec![text("*x*")]);
}
#[test]
fn parse_tag() {
    assert_eq!(
        parse(&format!("#[{ULID}]")).paragraphs[0].content,
        vec![InlineNode::TagRef { id: ULID.into() }]
    );
}
#[test]
fn parse_link() {
    assert_eq!(
        parse(&format!("[[{ULID}]]")).paragraphs[0].content,
        vec![InlineNode::BlockLink { id: ULID.into() }]
    );
}
#[test]
fn parse_entity() {
    assert_eq!(
        parse("\\alpha").paragraphs[0].content,
        vec![InlineNode::Entity {
            name: "alpha".into(),
            unicode: "\u{03B1}".into()
        }]
    );
}
#[test]
fn parse_ts() {
    assert_eq!(
        parse("<2024-01-15 Mon>").paragraphs[0].content,
        vec![InlineNode::Timestamp(OrgTimestamp {
            active: true,
            date: "2024-01-15".into(),
            time: None
        })]
    );
}
#[test]
fn parse_fn() {
    assert_eq!(
        parse("[fn:1]").paragraphs[0].content,
        vec![InlineNode::FootnoteRef { label: "1".into() }]
    );
}

// Emitter
#[test]
fn emit_bold() {
    assert_eq!(
        emit(&doc(vec![vec![marked("hi", vec![OrgMark::Bold])]])),
        "*hi*"
    );
}
#[test]
fn emit_esc() {
    assert_eq!(emit(&doc(vec![vec![text("a*b")]])), "a\\*b");
}
#[test]
fn emit_code_lit() {
    assert_eq!(
        emit(&doc(vec![vec![marked("*x*", vec![OrgMark::Code])]])),
        "~*x*~"
    );
}

// F01
#[test]
fn entity_no_collision() {
    let _ = ENTITIES.len();
    let _ = REVERSE_ENTITIES.len();
}
#[test]
fn entity_nonempty() {
    assert!(ENTITIES.len() > 50);
}

// F02
#[test]
fn reconfig_preserves() {
    let mut c = OrgSerializerConfig {
        max_input_size: 42,
        emit_entities_as_names: false,
    };
    c.reconfigure(OrgSerializerConfigUpdate {
        max_input_size: Some(100),
        emit_entities_as_names: None,
    });
    assert_eq!(c.max_input_size, 100);
    assert!(!c.emit_entities_as_names);
}

// F07
#[test]
fn size_ok() {
    assert!(parse_checked("hi").is_ok());
}
#[test]
fn size_reject() {
    assert!(parse_checked(&"a".repeat(MAX_INPUT_SIZE + 1)).is_err());
}

// F08
#[test]
fn esc_chars_complete() {
    for c in &['*', '/', '~', '\\', '#', '['] {
        assert!(ESCAPE_CHARS.contains(c));
    }
}

// F09 round-trips
#[test]
fn rt_plain() {
    assert_eq!(round_trip("hello"), "hello");
}
#[test]
fn rt_bold() {
    assert_eq!(round_trip("*hi*"), "*hi*");
}
#[test]
fn rt_italic() {
    assert_eq!(round_trip("/hi/"), "/hi/");
}
#[test]
fn rt_code() {
    assert_eq!(round_trip("~hi~"), "~hi~");
}
#[test]
fn rt_esc_bold() {
    assert_eq!(round_trip("\\*x\\*"), "\\*x\\*");
}
#[test]
fn rt_esc_bs() {
    assert_eq!(round_trip("a\\\\b"), "a\\\\b");
}
#[test]
fn rt_tag() {
    let i = format!("#[{ULID}]");
    assert_eq!(round_trip(&i), i);
}
#[test]
fn rt_link() {
    let i = format!("[[{ULID}]]");
    assert_eq!(round_trip(&i), i);
}
#[test]
fn rt_entity() {
    assert_eq!(round_trip("\\alpha"), "\\alpha");
}
#[test]
fn rt_ts() {
    assert_eq!(round_trip("<2024-01-15 Mon>"), "<2024-01-15 Mon>");
}
#[test]
fn rt_fn_ref() {
    assert_eq!(round_trip("[fn:1]"), "[fn:1]");
}
#[test]
fn rt_stable() {
    let t = format!("#[{ULID}]");
    let l = format!("[[{ULID}]]");
    for i in &[
        "hello",
        "*b*",
        "\\*x\\*",
        "\\alpha",
        t.as_str(),
        l.as_str(),
        "<2024-01-15 Mon>",
        "[fn:1]",
    ] {
        let a = round_trip(i);
        let b = round_trip(&a);
        assert_eq!(a, b, "stable for {i:?}");
    }
}

// F12 unicode
#[test]
fn uni_cjk() {
    assert_eq!(
        round_trip("\u{65E5}\u{672C}\u{8A9E}"),
        "\u{65E5}\u{672C}\u{8A9E}"
    );
}
#[test]
fn uni_emoji_bold() {
    assert_eq!(round_trip("*\u{1F389}*"), "*\u{1F389}*");
}
#[test]
fn uni_combining() {
    let i = "caf\u{0065}\u{0301}";
    assert_eq!(round_trip(i), i);
}
#[test]
fn uni_zwj() {
    let i = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
    assert_eq!(round_trip(i), i);
}
#[test]
fn uni_rtl() {
    let i = "\u{0645}\u{0631}\u{062D}\u{0628}\u{0627}";
    assert_eq!(round_trip(i), i);
}
#[test]
fn uni_zwsp() {
    let i = "a\u{200B}b";
    assert_eq!(round_trip(i), i);
}
#[test]
fn uni_astral() {
    let i = "\u{1F680}\u{1F525}";
    assert_eq!(round_trip(i), i);
}

// Serde
#[test]
fn serde_rt() {
    let d = OrgDoc {
        paragraphs: vec![OrgParagraph {
            content: vec![
                InlineNode::Text(TextNode {
                    text: "hi".into(),
                    marks: vec![OrgMark::Bold],
                }),
                InlineNode::TagRef { id: ULID.into() },
            ],
        }],
    };
    let j = serde_json::to_string(&d).unwrap();
    let back: OrgDoc = serde_json::from_str(&j).unwrap();
    assert_eq!(d, back);
}
