//! PEND-54 — page-name glob filter parsing and expansion.
//!
//! The frontend ships raw glob entries (`include_page_globs`,
//! `exclude_page_globs`) on the `SearchFilter` struct. This module
//! parses each entry into one or more SQL-ready `GLOB` patterns and
//! validates them; mismatched brackets, nested braces, and escape
//! sequences are surfaced as typed `AppError::Validation` errors with
//! an `InvalidGlob:` prefix the frontend keys on.
//!
//! Brace expansion is bounded: each input entry may not produce more
//! than [`EXPANSION_CAP`] expanded patterns (the plan caps at ~64 to
//! match the frontend mirror in `src/lib/search-query/glob-validate.ts`).
//!
//! Comma-separated values inside one entry are split first, then each
//! sub-entry is brace-expanded. Whitespace-only sub-entries are
//! silently dropped.

use crate::error::AppError;

/// Cap on the total number of patterns produced from a single brace
/// expansion. Mirrors the frontend `EXPANSION_CAP` so the chip
/// preview count matches what the backend actually queries.
pub const EXPANSION_CAP: usize = 64;

/// Maximum length (in bytes) of a single trimmed sub-entry. Defends
/// against the frontend (or a hand-rolled IPC caller) shipping a
/// many-megabyte pattern that SQLite would then bind verbatim. The
/// cap is intentionally generous — real glob entries are short — and
/// is enforced AFTER the comma split + trim so individual sub-entries
/// inside a comma-separated list are each measured.
pub const MAX_GLOB_LEN: usize = 1024;

/// Parse a list of raw glob entries into the final SQL pattern list.
///
/// Each entry is:
///   1. Trimmed.
///   2. Split on `,` into sub-entries (whitespace-only dropped).
///   3. Validated (unbalanced bracket / nested brace / escape → error).
///   4. Brace-expanded (cartesian, capped at `EXPANSION_CAP`).
///   5. Bare-token substring-wrapped (no `*`/`?`/`[` → `*…*`).
///   6. Lowercased so the SQL `LOWER(title) GLOB ?` clause matches
///      case-insensitively.
///
/// An empty input list yields an empty result (the caller short-
/// circuits the IN clause when the result is empty).
pub fn prepare_globs(entries: &[String]) -> Result<Vec<String>, AppError> {
    let mut out: Vec<String> = Vec::new();
    for entry in entries {
        for raw in split_top_level_commas(entry) {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.len() > MAX_GLOB_LEN {
                return Err(AppError::Validation(format!(
                    "InvalidGlob: pattern length {} exceeds cap {MAX_GLOB_LEN}",
                    trimmed.len()
                )));
            }
            validate(trimmed)?;
            let mut expanded = expand_braces(trimmed)?;
            if expanded.is_empty() {
                expanded.push(trimmed.to_string());
            }
            for pat in expanded {
                let with_substring = wrap_substring(&pat);
                out.push(with_substring.to_lowercase());
            }
            if out.len() > EXPANSION_CAP {
                return Err(AppError::Validation(format!(
                    "InvalidGlob: expansion exceeded {EXPANSION_CAP} patterns"
                )));
            }
        }
    }
    Ok(out)
}

/// Split `input` on top-level commas only — commas inside a `{...}`
/// group are part of the brace alternative list and must not split
/// the entry into separate globs.
fn split_top_level_commas(input: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    let mut depth: i32 = 0;
    let mut last = 0usize;
    for (i, ch) in input.char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                out.push(&input[last..i]);
                last = i + 1;
            }
            _ => {}
        }
    }
    out.push(&input[last..]);
    out
}

/// Validate the cheap structural rules.
fn validate(input: &str) -> Result<(), AppError> {
    let mut bracket_depth: i32 = 0;
    let mut brace_depth: i32 = 0;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(&next) = chars.peek() {
                if matches!(next, '{' | '}' | '[' | ']') {
                    return Err(AppError::Validation(
                        "InvalidGlob: escapes not supported".into(),
                    ));
                }
            }
            continue;
        }
        match ch {
            '[' => bracket_depth += 1,
            ']' => {
                if bracket_depth == 0 {
                    return Err(AppError::Validation(
                        "InvalidGlob: unbalanced bracket".into(),
                    ));
                }
                bracket_depth -= 1;
            }
            '{' => {
                brace_depth += 1;
                if brace_depth > 1 {
                    return Err(AppError::Validation(
                        "InvalidGlob: brace nesting not supported".into(),
                    ));
                }
            }
            '}' => {
                if brace_depth == 0 {
                    return Err(AppError::Validation("InvalidGlob: unbalanced brace".into()));
                }
                brace_depth -= 1;
            }
            _ => {}
        }
    }
    if bracket_depth != 0 {
        return Err(AppError::Validation(
            "InvalidGlob: unbalanced bracket".into(),
        ));
    }
    if brace_depth != 0 {
        return Err(AppError::Validation("InvalidGlob: unbalanced brace".into()));
    }
    Ok(())
}

/// Cartesian brace expansion. Mirrors the frontend implementation.
fn expand_braces(input: &str) -> Result<Vec<String>, AppError> {
    if !input.contains('{') {
        return Ok(vec![input.to_string()]);
    }
    enum Segment {
        Literal(String),
        Alts(Vec<String>),
    }
    let mut segments: Vec<Segment> = Vec::new();
    let mut buf = String::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if ch == '{' {
            if !buf.is_empty() {
                segments.push(Segment::Literal(std::mem::take(&mut buf)));
            }
            // Find matching `}`. Already validated as un-nested.
            let close = input[i + 1..].find('}');
            let Some(rel) = close else {
                // Unbalanced — should have been caught by `validate`.
                return Err(AppError::Validation("InvalidGlob: unbalanced brace".into()));
            };
            let end = i + 1 + rel;
            let inner = &input[i + 1..end];
            let alts: Vec<String> = inner
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            segments.push(Segment::Alts(if alts.is_empty() {
                vec![String::new()]
            } else {
                alts
            }));
            i = end + 1;
        } else {
            buf.push(ch);
            i += 1;
        }
    }
    if !buf.is_empty() {
        segments.push(Segment::Literal(buf));
    }

    let mut results: Vec<String> = vec![String::new()];
    for seg in segments {
        let mut next: Vec<String> = Vec::new();
        match seg {
            Segment::Literal(s) => {
                for r in &results {
                    next.push(format!("{r}{s}"));
                }
            }
            Segment::Alts(alts) => {
                for r in &results {
                    for a in &alts {
                        next.push(format!("{r}{a}"));
                        if next.len() > EXPANSION_CAP {
                            break;
                        }
                    }
                    if next.len() > EXPANSION_CAP {
                        break;
                    }
                }
            }
        }
        results = next;
        if results.len() > EXPANSION_CAP {
            results.truncate(EXPANSION_CAP);
            break;
        }
    }
    Ok(results)
}

/// If the pattern has no glob metacharacters, wrap with `*…*` for a
/// case-insensitive substring match (the VSCode-style default).
fn wrap_substring(input: &str) -> String {
    if input.chars().any(|c| c == '*' || c == '?' || c == '[') {
        input.to_string()
    } else {
        format!("*{input}*")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_yields_empty_output() {
        let out = prepare_globs(&[]).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn plain_glob_passes_through_lowercased() {
        let out = prepare_globs(&["Journal/*".to_string()]).unwrap();
        assert_eq!(out, vec!["journal/*"]);
    }

    #[test]
    fn bare_token_wraps_with_substring() {
        let out = prepare_globs(&["Journal".to_string()]).unwrap();
        assert_eq!(out, vec!["*journal*"]);
    }

    #[test]
    fn comma_separated_entries_expand() {
        let out = prepare_globs(&["Journal/*,Notes/*".to_string()]).unwrap();
        assert_eq!(out, vec!["journal/*", "notes/*"]);
    }

    #[test]
    fn brace_expansion_works() {
        let out = prepare_globs(&["{Journal,Archive}/*".to_string()]).unwrap();
        assert_eq!(out, vec!["journal/*", "archive/*"]);
    }

    #[test]
    fn cartesian_brace_expansion_works() {
        let out = prepare_globs(&["{a,b}/{c,d}".to_string()]).unwrap();
        // brace expansion → ['a/c','a/d','b/c','b/d']; substring wrap
        // for items without metas; lowercased.
        assert_eq!(out, vec!["*a/c*", "*a/d*", "*b/c*", "*b/d*"]);
    }

    #[test]
    fn brace_nesting_rejected() {
        let err = prepare_globs(&["{a,{b,c}}".to_string()]).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("brace nesting"), "got {msg}");
    }

    #[test]
    fn unbalanced_bracket_rejected() {
        let err = prepare_globs(&["[abc".to_string()]).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("unbalanced bracket"), "got {msg}");
    }

    #[test]
    fn unbalanced_closing_brace_rejected() {
        let err = prepare_globs(&["a}b".to_string()]).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("unbalanced brace"), "got {msg}");
    }

    #[test]
    fn whitespace_only_entries_dropped() {
        let out = prepare_globs(&["  ,  ".to_string()]).unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn over_length_pattern_rejected() {
        let big = "a".repeat(MAX_GLOB_LEN + 1);
        let err = prepare_globs(&[big]).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("pattern length"), "got {msg}");
        assert!(msg.contains(&MAX_GLOB_LEN.to_string()), "got {msg}");
    }

    #[test]
    fn at_length_pattern_accepted() {
        // Boundary: exactly MAX_GLOB_LEN bytes is fine.
        let at = "a".repeat(MAX_GLOB_LEN);
        let out = prepare_globs(&[at]).unwrap();
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn expansion_cap_enforced() {
        // 4 ^ 5 = 1024 patterns; the cap truncates to 64. We accept
        // either truncation or an `InvalidGlob: expansion exceeded`
        // error as a valid response (both are defensible — the plan
        // names 64 as the documented limit).
        let result = prepare_globs(&["{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}".to_string()]);
        match result {
            Ok(out) => assert!(out.len() <= EXPANSION_CAP, "got {} patterns", out.len()),
            Err(err) => {
                let msg = format!("{err:?}");
                assert!(
                    msg.contains("expansion exceeded") || msg.contains("64"),
                    "got {msg}"
                );
            }
        }
    }
}
