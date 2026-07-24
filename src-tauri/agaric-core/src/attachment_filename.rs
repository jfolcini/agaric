//! Peer-supplied attachment filename sanitization (#3029).
//!
//! Defense-in-depth sibling of the app crate's `validate_attachment_filename`
//! (#2989). That validator REJECTS a traversal-shaped display filename at the
//! LOCAL origination commands (`add_attachment_inner` / `rename_attachment_inner`),
//! stopping this device from ever putting a bad name into its own op-log.
//!
//! This sanitizer covers the hostile-PEER surface the origination guard cannot
//! reach: the sync/replay APPLY path
//! (`agaric_engine::apply::apply_add_attachment_tx` /
//! `apply_rename_attachment_tx`) and the `db::recovery` replay loop both write
//! a *peer's* filename straight into the `attachments.filename` row with no
//! check. A hard reject there is not an option — a single hostile op would
//! wedge the whole replay pipeline (a DoS that blocks a legitimate user from
//! restoring their DB) — so instead we SANITIZE on store: a `../../evil.sh`
//! name is neutralized to a single, separator-free filename component and
//! replay continues.
//!
//! `attachments.filename` is a DISPLAY name only — the on-disk bytes always
//! live at the backend-generated `fs_path` (`attachments/<ULID>`) — but
//! consumers join `filename` onto a base dir to build a portable, human-
//! readable path (the graph-export ZIP's `assets/<filename>`, future on-disk
//! export / reveal-in-folder), so a traversal-shaped value is a latent
//! Zip-Slip / path-traversal primitive. Sanitizing at store time closes it.

/// Maximum byte length of a stored attachment display filename. Mirrors the
/// cap enforced by the app crate's origination-side
/// `validate_attachment_filename` (#2989).
pub const MAX_ATTACHMENT_FILENAME_BYTES: usize = 255;

/// Fallback name used when sanitization strips a filename down to nothing
/// representable (empty, all-dots, or all-separator/control input).
const SANITIZED_FALLBACK: &str = "attachment";

/// Sanitize a peer-supplied attachment display filename into a value that is
/// always a single, safe path component.
///
/// Mirrors the policy of the origination-side `validate_attachment_filename`
/// (#2989) but SANITIZES instead of rejecting (see the module docs for why a
/// reject would be a replay-pipeline DoS):
///
/// * path separators (`/` and `\`) → `_` — the core traversal vector once the
///   name is joined to a base dir. Both separators are handled regardless of
///   build platform so the same op sanitizes IDENTICALLY on every device (a
///   cross-platform-synced DB must converge).
/// * control characters (NUL, newlines, …) → `_` — a path-truncation /
///   injection vector, never valid in a real filename.
/// * surrounding whitespace, plus trailing dots and spaces, are trimmed.
///   Windows silently strips trailing dots/spaces from a path component, which
///   can turn `". ."` / `".. ."` back into `..` (a #2989-review edge) — so
///   they are stripped here.
/// * a name that is now empty or consists solely of dots (`.`, `..`, `...`)
///   resolves to a current/parent-directory component → replaced with the
///   [`SANITIZED_FALLBACK`] name.
/// * the result is capped to [`MAX_ATTACHMENT_FILENAME_BYTES`] on a UTF-8 char
///   boundary (and re-cleaned in case the cut re-exposed a trailing dot).
///
/// The returned name never contains a path separator, never begins a path
/// escape, and is never empty. Well-formed names (`report 2024.pdf`,
/// `my.file.pdf`, `résumé.pdf`) pass through unchanged.
pub fn sanitize_attachment_filename(filename: &str) -> String {
    // Replace anything that lets the name span directory levels or inject /
    // truncate a path once joined to a base dir.
    let replaced: String = filename
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();

    let safe = collapse_to_safe_component(&replaced);

    // Cap length on a char boundary so we never split a code point.
    if safe.len() <= MAX_ATTACHMENT_FILENAME_BYTES {
        return safe;
    }
    let mut cut = MAX_ATTACHMENT_FILENAME_BYTES;
    while cut > 0 && !safe.is_char_boundary(cut) {
        cut -= 1;
    }
    // Truncation could re-expose a trailing dot/space or empty the name — clean
    // the truncated head again so the cap can never revive an unsafe shape.
    collapse_to_safe_component(&safe[..cut])
}

/// Trim surrounding whitespace and trailing dots/spaces, then substitute the
/// fallback name if the result is empty or all-dots. Shared by the initial
/// pass and the post-truncation re-clean so both apply the identical policy.
fn collapse_to_safe_component(s: &str) -> String {
    let trimmed = s.trim().trim_end_matches(['.', ' ']).trim_end();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '.') {
        SANITIZED_FALLBACK.to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sanitized name must never be usable as a traversal / injection
    /// primitive: no path separators, not a bare `.`/`..`, never empty.
    fn assert_safe(name: &str) {
        assert!(!name.contains('/'), "{name:?} still contains '/'");
        assert!(!name.contains('\\'), "{name:?} still contains '\\'");
        assert!(!name.is_empty(), "sanitized name must not be empty");
        assert_ne!(name, ".", "sanitized name must not be a bare '.'");
        assert_ne!(name, "..", "sanitized name must not be a bare '..'");
        assert!(
            !name.chars().all(|c| c == '.'),
            "{name:?} must not be all-dots"
        );
        assert!(
            name.len() <= MAX_ATTACHMENT_FILENAME_BYTES,
            "{name:?} exceeds the byte cap"
        );
        assert!(
            !name.chars().any(char::is_control),
            "{name:?} still contains a control char"
        );
    }

    #[test]
    fn posix_traversal_is_neutralized() {
        let out = sanitize_attachment_filename("../../evil.sh");
        assert_safe(&out);
        // Separators collapse; the `..` are no longer chained by a separator.
        assert_eq!(out, ".._.._evil.sh");
    }

    #[test]
    fn windows_traversal_is_neutralized() {
        let out = sanitize_attachment_filename("..\\..\\evil.sh");
        assert_safe(&out);
        assert_eq!(out, ".._.._evil.sh");
    }

    #[test]
    fn absolute_path_is_neutralized() {
        let out = sanitize_attachment_filename("/etc/passwd");
        assert_safe(&out);
        assert_eq!(out, "_etc_passwd");
    }

    #[test]
    fn interior_separator_is_neutralized() {
        let out = sanitize_attachment_filename("sub/dir/x.png");
        assert_safe(&out);
        assert_eq!(out, "sub_dir_x.png");
    }

    #[test]
    fn dot_names_collapse_to_fallback() {
        for bad in [".", "..", "...", "   ", ""] {
            let out = sanitize_attachment_filename(bad);
            assert_safe(&out);
            assert_eq!(out, SANITIZED_FALLBACK, "{bad:?} must map to fallback");
        }
    }

    #[test]
    fn interior_space_dot_edge_collapses_to_fallback() {
        // `". ."` / `".. ."` would normalize back to `..` under Windows
        // trailing dot/space stripping — must not survive (#2989 review edge).
        for bad in [". .", ".. .", ". . .", ".."] {
            let out = sanitize_attachment_filename(bad);
            assert_safe(&out);
            assert_eq!(out, SANITIZED_FALLBACK, "{bad:?} must map to fallback");
        }
    }

    #[test]
    fn control_chars_are_stripped() {
        let out = sanitize_attachment_filename("evil\0\n.sh");
        assert_safe(&out);
        assert_eq!(out, "evil__.sh");
    }

    #[test]
    fn over_length_name_is_capped_on_char_boundary() {
        // Multi-byte tail to prove we never split a code point at the cap.
        let name = format!("{}é.pdf", "a".repeat(300));
        let out = sanitize_attachment_filename(&name);
        assert_safe(&out);
        assert!(out.len() <= MAX_ATTACHMENT_FILENAME_BYTES);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn well_formed_names_pass_through_unchanged() {
        for good in ["report 2024.pdf", "my.file.pdf", "résumé.pdf", "photo.png"] {
            assert_eq!(sanitize_attachment_filename(good), good, "{good:?}");
        }
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        assert_eq!(
            sanitize_attachment_filename("  spaced name.pdf  "),
            "spaced name.pdf"
        );
    }
}
