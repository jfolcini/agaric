//! The key the Pages view's Alphabetical sort orders by (#5371).
//!
//! SQLite's `COLLATE NOCASE` folds ASCII only, so `Émile` sorted after
//! `Zebra`. The key is computed here and stored in
//! `pages_cache.title_sort_key`, whose `BINARY` (UTF-8 byte) order is the sort
//! order. The tauri-mock mirrors it in `titleSortKey`
//! (`src/lib/tauri-mock/handlers/shared.ts`); change both together.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

/// The title NFKD-decomposed, combining marks stripped, then lowercased:
/// `Émile` → `emile`, `ﬁle` → `file`.
pub fn title_sort_key(title: &str) -> String {
    title
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .collect::<String>()
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::title_sort_key;

    /// The tauri-mock's `titleSortKey` shares only the first four titles here,
    /// through `sort-cursor.vectors.json`; every other case is pinned on this
    /// side only.
    #[test]
    fn pinned_known_values() {
        for (title, key) in [
            ("Émile", "emile"),
            ("ángel", "angel"),
            ("Zebra", "zebra"),
            ("zeta", "zeta"),
            ("e\u{0301}cole", "ecole"),
            ("\u{FB01}le", "file"),
            ("\u{FF21}BC", "abc"),
            ("\u{0130}stanbul", "istanbul"),
            ("ΣΊΣΥΦΟΣ", "σισυφος"),
            ("Straße", "straße"),
            ("", ""),
        ] {
            assert_eq!(title_sort_key(title), key, "key of {title:?}");
        }
    }

    /// The reason the key exists: byte order over the keys puts accented
    /// titles with their base letter, where byte order over the titles
    /// (`NOCASE` included) puts them after `z`.
    #[test]
    fn accented_titles_sort_with_their_base_letter() {
        let mut titles = ["Zebra", "zeta", "Émile", "ángel", "apple"];
        titles.sort_by_key(|t| title_sort_key(t));
        assert_eq!(titles, ["ángel", "apple", "Émile", "Zebra", "zeta"]);
    }
}
