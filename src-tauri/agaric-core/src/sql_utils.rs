//! SQL utility helpers shared across modules.
//!
//! Hosts small, general-purpose SQL helpers (LIKE-pattern escaping, etc.)
//! used by multiple query modules (`backlink`, `tag_query`, ...). Keeping
//! them in one canonical location avoids copy-paste duplication when the
//! escape rules need to change.

/// Escape special LIKE pattern characters (`%`, `_`, `\`) so user-supplied
/// strings are matched literally.
///
/// Use with ``ESCAPE '\'`` in the SQL `LIKE` clause, e.g.:
///
/// ```text
/// WHERE name LIKE ?1 ESCAPE '\'
/// ```
// Widened from `pub(crate)` to `pub` when this module moved into
// `agaric-core` (#2621): consumers (`backlink`, `tag_query`, …) now live in
// the dependent `agaric` crate and reach it via `crate::sql_utils::escape_like`
// (a re-export of `agaric_core::sql_utils::escape_like`).
#[must_use]
pub fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::escape_like;

    #[test]
    fn escape_like_leaves_plain_text_unchanged() {
        assert_eq!(escape_like("work/meeting"), "work/meeting");
    }

    #[test]
    fn escape_like_escapes_percent() {
        assert_eq!(escape_like("100%"), "100\\%");
    }

    #[test]
    fn escape_like_escapes_underscore() {
        assert_eq!(escape_like("a_b"), "a\\_b");
    }

    #[test]
    fn escape_like_escapes_backslash() {
        assert_eq!(escape_like("a\\b"), "a\\\\b");
    }

    #[test]
    fn escape_like_escapes_all_special_chars() {
        assert_eq!(escape_like("%_\\"), "\\%\\_\\\\");
    }

    #[test]
    fn escape_like_preserves_empty_string() {
        assert_eq!(escape_like(""), "");
    }
}
