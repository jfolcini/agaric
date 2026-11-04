//! The mirror's path mapping: the ZIP export's cases, the cut, the collision
//! fold, and the proptests that every page gets a path of its own below its
//! space folder and that a clean title's path reads back as the title.

use std::path::{Component, Path};

use proptest::prelude::*;

use super::*;
use crate::commands::pages::folder_path_to_namespace_title;

fn page(id: &str, space_id: &str, title: &str) -> PageEntry {
    PageEntry {
        id: id.to_owned(),
        space_id: space_id.to_owned(),
        title: title.to_owned(),
    }
}

/// The paths of `titles`, each a page of one space named `Notes`, its id
/// `01P<n>` padded, in that order.
fn paths_of(titles: &[&str]) -> Vec<String> {
    let spaces = [("01SPACE".to_owned(), "Notes".to_owned())];
    let pages: Vec<PageEntry> = titles
        .iter()
        .enumerate()
        .map(|(n, title)| page(&format!("01P{n:023}"), "01SPACE", title))
        .collect();
    let paths = layout(&spaces, &pages);
    pages.iter().map(|p| paths[&p.id].clone()).collect()
}

#[test]
fn a_reserved_character_becomes_an_underscore() {
    assert_eq!(
        sanitize_segment(r#"a\b:c*d?e"f<g>h|i"#),
        "a_b_c_d_e_f_g_h_i"
    );
    assert_eq!(
        sanitize_segment("tab\there"),
        "tab_here",
        "a control character too"
    );
}

#[test]
fn a_windows_device_name_is_escaped_whatever_its_case_and_extension() {
    assert_eq!(sanitize_segment("CON"), "CON_");
    assert_eq!(sanitize_segment("con.txt"), "con_.txt");
    assert_eq!(sanitize_segment("Lpt9"), "Lpt9_");
    assert_eq!(
        sanitize_segment("CONSOLE"),
        "CONSOLE",
        "only the exact name"
    );
}

#[test]
fn a_segment_of_dots_or_nothing_is_untitled() {
    for segment in ["", " ", ".", "..", "...", ". .", "  .. "] {
        assert_eq!(sanitize_segment(segment), "Untitled", "{segment:?}");
    }
    assert_eq!(
        sanitize_segment("Notes. "),
        "Notes",
        "trailing dots and spaces go"
    );
    assert_eq!(sanitize_segment("...a"), "...a", "leading dots stay");
}

#[test]
fn an_absolute_or_traversing_title_stays_below_its_space() {
    assert_eq!(title_path("/etc/x"), "Untitled/etc/x");
    assert_eq!(
        title_path("../../etc/passwd"),
        "Untitled/Untitled/etc/passwd"
    );
    assert_eq!(title_path("a//b"), "a/Untitled/b");
}

#[test]
fn a_namespace_is_a_folder_per_segment() {
    assert_eq!(title_path("Project/Backend/API"), "Project/Backend/API");
    assert_eq!(
        space_folder("Work/Home"),
        "Work_Home",
        "a space has no namespaces"
    );
}

#[test]
fn a_long_cjk_segment_is_cut_on_a_char_boundary() {
    let title = "漢".repeat(100);
    let cut = sanitize_segment(&title);
    assert_eq!(
        cut,
        "漢".repeat(66),
        "66 three-byte chars are 198 bytes, 67 would be 201"
    );
    assert_eq!(cut.len(), 198);
}

#[test]
fn case_and_nfc_variants_collide_and_the_lowest_id_keeps_the_name() {
    let paths = paths_of(&["API", "api", "ＡＰＩ", "caf\u{e9}", "cafe\u{301}"]);
    assert_eq!(
        paths,
        [
            "Notes/API.md",
            "Notes/api_01P00000.md",
            "Notes/ＡＰＩ.md",
            "Notes/caf\u{e9}.md",
            "Notes/cafe\u{301}_01P00000.md",
        ],
        "fullwidth is its own name; a case or NFD twin takes its id"
    );
}

#[test]
fn a_twin_whose_id_suffix_is_taken_gets_a_counter() {
    let paths = paths_of(&["x", "X", "x"]);
    assert_eq!(
        paths,
        ["Notes/x.md", "Notes/X_01P00000.md", "Notes/x_01P00000-2.md"],
        "ids 1 and 2 share their first 8 characters"
    );
}

#[test]
fn space_folders_are_disambiguated_in_space_id_order() {
    let spaces = [
        ("01SPACEB".to_owned(), "notes".to_owned()),
        ("01SPACEA".to_owned(), "Notes".to_owned()),
    ];
    let pages = [page("01PA", "01SPACEA", "a"), page("01PB", "01SPACEB", "b")];
    let paths = layout(&spaces, &pages);
    assert_eq!(paths["01PA"], "Notes/a.md");
    assert_eq!(paths["01PB"], "notes_01SPACEB/b.md");
}

#[test]
fn a_page_of_no_listed_space_gets_no_path() {
    let spaces = [("01SPACE".to_owned(), "Notes".to_owned())];
    let paths = layout(&spaces, &[page("01P", "01OTHER", "a")]);
    assert!(paths.is_empty(), "{paths:?}");
}

/// A title of words that may differ only by case, by NFC or by a character
/// the sanitizer replaces, in namespaces, or nothing at all.
fn arb_title() -> impl Strategy<Value = String> {
    let word = prop_oneof![
        "[aAbB]{1,3}",
        Just("caf\u{e9}".to_owned()),
        Just("cafe\u{301}".to_owned()),
        Just("CAF\u{c9}".to_owned()),
        Just("con".to_owned()),
        Just("..".to_owned()),
        "[a:?* .]{0,3}",
        Just("漢".repeat(80)),
    ];
    prop::collection::vec(word, 1..4).prop_map(|words| words.join("/"))
}

/// Clean segments: what `folder_path_to_namespace_title` reads back as they
/// were written.
fn arb_clean_title() -> impl Strategy<Value = String> {
    let segment = "[A-Za-z0-9][A-Za-z0-9 _-]{0,8}[A-Za-z0-9]".prop_filter("not a device", |s| {
        !RESERVED_DEVICE_NAMES.iter().any(|d| {
            s.split('.')
                .next()
                .is_some_and(|b| b.eq_ignore_ascii_case(d))
        })
    });
    prop::collection::vec(segment, 1..4).prop_map(|segments| segments.join("/"))
}

proptest! {
    /// No two pages of a space share a file, under the fold of a
    /// case-insensitive, normalization-insensitive file system.
    #[test]
    fn every_page_of_a_space_gets_a_file_of_its_own(titles in prop::collection::vec(arb_title(), 0..12)) {
        let titles: Vec<&str> = titles.iter().map(String::as_str).collect();
        let paths = paths_of(&titles);
        let folded: HashSet<String> = paths
            .iter()
            .map(|p| agaric_core::text_utils::nfc_normalise(&p.to_lowercase()))
            .collect();
        prop_assert_eq!(folded.len(), paths.len(), "{:?}", paths);
    }

    /// Every path is relative and stays below its space folder: no empty,
    /// `.`, `..` or absolute component, and no segment past the cut and its
    /// suffix.
    #[test]
    fn every_path_stays_below_the_root(titles in prop::collection::vec(arb_title(), 1..6)) {
        let titles: Vec<&str> = titles.iter().map(String::as_str).collect();
        for path in paths_of(&titles) {
            prop_assert!(
                Path::new(&path).components().all(|c| matches!(c, Component::Normal(_))),
                "{}", path
            );
            for segment in path.split('/') {
                prop_assert!(!segment.is_empty() && segment.trim_end_matches('.') == segment, "{}", path);
                prop_assert!(segment.len() <= MAX_SEGMENT_BYTES + 16, "{}", path);
            }
        }
    }

    /// A clean title's path reads back as the title, as a folder import reads
    /// it.
    #[test]
    fn a_clean_titles_path_reads_back_as_the_title(title in arb_clean_title()) {
        let path = format!("{}.md", title_path(&title));
        prop_assert_eq!(folder_path_to_namespace_title(&path), title);
    }
}
