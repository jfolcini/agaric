//! [`shown_text`] against the string-only strip it replaced (#6795), kept as
//! the oracle for the text it shows.

use super::*;
use proptest::prelude::*;

/// The strip as it was before it carried an origin map: [`shown_text`]'s
/// text must equal it for every input.
fn oracle_shown_text(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
    block_titles: &HashMap<String, String>,
) -> String {
    let mut pieces = Vec::new();
    let masked = oracle_mask_shown_spans(content, block_titles, &mut pieces);
    let result = oracle_strip_inline_markup(&masked);
    let result = TAG_REF_RE.replace_all(&result, |caps: &regex::Captures| {
        let name = tag_names.get(&caps[1]).cloned().unwrap_or_default();
        oracle_piece(&mut pieces, name)
    });
    let result = PAGE_LINK_RE.replace_all(&result, |caps: &regex::Captures| {
        match crate::cache::page_link_label(caps) {
            Some(label) => label.to_string(),
            None => {
                let title = page_titles.get(&caps[1]).cloned().unwrap_or_default();
                oracle_piece(&mut pieces, title)
            }
        }
    });
    PIECE_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let index = caps[1].parse::<usize>().ok();
            index.and_then(|i| pieces.get(i)).map_or("", String::as_str)
        })
        .into_owned()
}

fn oracle_strip_inline_markup(content: &str) -> String {
    let mut current = content.to_owned();
    loop {
        let next = MARKUP_RE.replace_all(&current, |caps: &regex::Captures<'_>| {
            for i in 1..=4 {
                if let Some(m) = caps.get(i) {
                    return m.as_str().to_owned();
                }
            }
            String::new()
        });
        if next.as_ref() == current {
            break;
        }
        current = next.into_owned();
    }
    current
}

fn oracle_piece(pieces: &mut Vec<String>, shown: String) -> String {
    pieces.push(shown);
    format!("{PIECE_OPEN}{}{PIECE_CLOSE}", pieces.len() - 1)
}

fn oracle_mask_shown_spans(
    content: &str,
    block_titles: &HashMap<String, String>,
    pieces: &mut Vec<String>,
) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(ch) = rest.chars().next() {
        if let Some(after) = rest.strip_prefix("\\|") {
            out.push('|');
            rest = after;
            continue;
        }
        let at_line_start = rest.len() == content.len() || out.ends_with('\n');
        let span = match ch {
            '~' if at_line_start => {
                tilde_fence(rest).map(|(code, len)| (rest.get(code).unwrap().to_owned(), len))
            }
            '`' => {
                let (code, len) = code_span(rest);
                Some((rest.get(code).unwrap().to_owned(), len))
            }
            '\\' => rest
                .chars()
                .nth(1)
                .filter(|&next| is_escapable(next))
                .map(|next| (next.to_string(), 1 + next.len_utf8())),
            '(' => BLOCK_REF_AT_RE.captures(rest).map(|caps| {
                let title = block_titles.get(&caps[1]).cloned().unwrap_or_default();
                (title, caps[0].len())
            }),
            PIECE_OPEN => Some((PIECE_OPEN.to_string(), PIECE_OPEN.len_utf8())),
            _ => None,
        };
        let len = match span {
            Some((shown, len)) => {
                out.push_str(&oracle_piece(pieces, shown));
                len
            }
            None => {
                out.push(ch);
                ch.len_utf8()
            }
        };
        rest = rest.get(len..).unwrap();
    }
    out
}

const KNOWN: &str = "01HQKNWN00000000000000KN01";

/// Content built from the fragments every pass reacts to.
fn content() -> impl Strategy<Value = String> {
    let fragment = prop::sample::select(vec![
        "a",
        "B",
        " ",
        "\n",
        "é",
        "日",
        "🙂",
        "*",
        "**",
        "~",
        "~~",
        "~~~",
        "=",
        "==",
        "`",
        "```",
        "\\",
        "\\|",
        "\\*",
        "|",
        "[",
        "]",
        "(",
        ")",
        "#",
        "\u{E002}",
        "\u{E003}",
        "0",
        "#[01HQKNWN00000000000000KN01]",
        "#[01HQUNKN00000000000000UK01]",
        "[[01HQKNWN00000000000000KN01]]",
        "[[01HQUNKN00000000000000UK01]]",
        "[[01HQKNWN00000000000000KN01|la*b*el]]",
        "[[01HQKNWN00000000000000KN01\\|x]]",
        "((01HQKNWN00000000000000KN01))",
        "((01HQUNKN00000000000000UK01))",
    ]);
    prop::collection::vec(fragment, 0..24).prop_map(|fragments| fragments.concat())
}

fn maps() -> RefMaps {
    let named = |name: &str| HashMap::from([(KNOWN.to_owned(), name.to_owned())]);
    (named("Tag *x*"), named("Page `t`"), named("Block **b**"))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn shown_text_shows_what_the_string_only_strip_showed(content in content()) {
        let (tags, pages, blocks) = maps();
        let shown = shown_text(&content, &tags, &pages, &blocks);
        prop_assert_eq!(&shown.text, &oracle_shown_text(&content, &tags, &pages, &blocks));
        prop_assert_eq!(shown.origin.len(), shown.text.len());
    }
}
