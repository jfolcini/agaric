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
use crate::error::validation_code::{INVALID_GLOB, prefixed};

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
///   6. ASCII-lowercased (`to_ascii_lowercase`) so it folds identically to
///      the SQL `LOWER(title) GLOB ?` clause (SQLite's `LOWER` is ASCII-only).
///      Matching is therefore case-insensitive for ASCII and exact for
///      non-ASCII letters — symmetric on both sides (#381).
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
                return Err(AppError::Validation(prefixed(
                    INVALID_GLOB,
                    &format!(
                        "pattern length {} exceeds cap {MAX_GLOB_LEN}",
                        trimmed.len()
                    ),
                )));
            }
            validate(trimmed)?;
            let mut expanded = expand_braces(trimmed)?;
            if expanded.is_empty() {
                expanded.push(trimmed.to_string());
            }
            for pat in expanded {
                let with_substring = wrap_substring(&pat);
                // #381: fold with `to_ascii_lowercase`, NOT `to_lowercase`.
                // The column side is SQLite's `LOWER(title)`, which folds
                // ASCII A–Z only (no ICU compiled in). Rust's full-Unicode
                // `to_lowercase` folded the PATTERN's accented/Cyrillic/Greek
                // letters while `LOWER(title)` left the column's unchanged, so
                // a title with an uppercase non-ASCII letter (e.g. `CAFÉ`)
                // could never match. ASCII-only folding on both sides is
                // symmetric: case-insensitive for ASCII, exact-match for
                // non-ASCII (predictable), instead of silently unmatched.
                out.push(with_substring.to_ascii_lowercase());
            }
            if out.len() > EXPANSION_CAP {
                return Err(AppError::Validation(prefixed(
                    INVALID_GLOB,
                    &format!("expansion exceeded {EXPANSION_CAP} patterns"),
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
            if let Some(&next) = chars.peek()
                && matches!(next, '{' | '}' | '[' | ']')
            {
                return Err(AppError::Validation(prefixed(
                    INVALID_GLOB,
                    "escapes not supported",
                )));
            }
            continue;
        }
        match ch {
            '[' => bracket_depth += 1,
            ']' => {
                if bracket_depth == 0 {
                    return Err(AppError::Validation(prefixed(
                        INVALID_GLOB,
                        "unbalanced bracket",
                    )));
                }
                bracket_depth -= 1;
            }
            '{' => {
                brace_depth += 1;
                if brace_depth > 1 {
                    return Err(AppError::Validation(prefixed(
                        INVALID_GLOB,
                        "brace nesting not supported",
                    )));
                }
            }
            '}' => {
                if brace_depth == 0 {
                    return Err(AppError::Validation(prefixed(
                        INVALID_GLOB,
                        "unbalanced brace",
                    )));
                }
                brace_depth -= 1;
            }
            _ => {}
        }
    }
    if bracket_depth != 0 {
        return Err(AppError::Validation(prefixed(
            INVALID_GLOB,
            "unbalanced bracket",
        )));
    }
    if brace_depth != 0 {
        return Err(AppError::Validation(prefixed(
            INVALID_GLOB,
            "unbalanced brace",
        )));
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
    // #624: drive the cursor with `char_indices` so non-ASCII literals stay
    // intact. The old `bytes[i] as char` reinterpreted each UTF-8 byte as a
    // Latin-1 code point, so a brace pattern with non-ASCII text (`Café{1,2}`)
    // mojibake'd (`é` → `Ã©`) and the expanded GLOBs silently never matched a
    // title. `{`/`}` are ASCII (1 byte each), so the slice arithmetic below
    // stays byte-correct on absolute byte offsets `i`/`end`.
    let mut chars = input.char_indices().peekable();
    while let Some((i, ch)) = chars.next() {
        if ch == '{' {
            if !buf.is_empty() {
                segments.push(Segment::Literal(std::mem::take(&mut buf)));
            }
            // Find matching `}`. Already validated as un-nested.
            let close = input[i + 1..].find('}');
            let Some(rel) = close else {
                // Unbalanced — should have been caught by `validate`.
                return Err(AppError::Validation(prefixed(
                    INVALID_GLOB,
                    "unbalanced brace",
                )));
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
            // Skip the cursor past the consumed `{...}` group, i.e. every char
            // whose byte offset is `<= end` (the closing `}` at byte `end`).
            while let Some(&(j, _)) = chars.peek() {
                if j <= end {
                    chars.next();
                } else {
                    break;
                }
            }
        } else {
            buf.push(ch);
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
                    if next.len() > EXPANSION_CAP {
                        break;
                    }
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
    fn ascii_fold_preserves_non_ascii_case_381() {
        // #381: fold ASCII only (to match SQLite's ASCII-only LOWER on the
        // column side). An uppercase accented letter is left as-is — `É`
        // stays `É` — exactly as `LOWER(title)` leaves it, so `CAFÉ` matches.
        // Full-Unicode `to_lowercase` would fold the PATTERN's `É`→`é` while
        // the column kept `É`, silently unmatching the title.
        let out = prepare_globs(&["CAFÉ".to_string()]).unwrap();
        assert_eq!(
            out,
            vec!["*cafÉ*"],
            "ASCII letters fold (C→c); non-ASCII case is preserved (É stays É)"
        );
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
    fn brace_expansion_preserves_non_ascii_literals_624() {
        // #624: the old `bytes[i] as char` cursor reinterpreted each UTF-8
        // byte of `é` as Latin-1, mojibake-ing the literal (`Café` → `CafÃ©`).
        // The expanded GLOBs then re-encoded as 4 garbage bytes and silently
        // never matched a title. char_indices keeps the literal intact: ASCII
        // folds (C→c), the non-ASCII `é` is preserved verbatim (matches #381).
        let out = prepare_globs(&["Café{1,2}".to_string()]).unwrap();
        assert_eq!(
            out,
            vec!["*café1*", "*café2*"],
            "non-ASCII brace literal must round-trip, not mojibake"
        );
        // Each expanded pattern must remain valid UTF-8 containing the intact
        // `é` (0xC3 0xA9), never the mojibake `Ã©` (0xC3 0x83 0xC2 0xA9).
        for pat in &out {
            assert!(pat.contains('é'), "expected intact 'é' in {pat:?}");
            assert!(!pat.contains('Ã'), "mojibake leaked into {pat:?}");
        }
    }

    #[test]
    fn every_glob_emit_site_uses_the_shared_invalid_glob_prefix_1061() {
        // #1061 — every glob validation error must carry the shared
        // `InvalidGlob:` prefix sourced from `error::validation_code`, not a
        // hand-spelled literal. Each tuple drives one distinct emit site.
        let expect = format!("{INVALID_GLOB}: ");
        let cases: &[&str] = &[
            &"a".repeat(MAX_GLOB_LEN + 1), // pattern length cap (line ~58)
            "\\{",                         // escapes not supported (~123)
            "abc]",                        // unbalanced closing bracket (~133)
            "{a,{b}}",                     // brace nesting (~142)
            "a}b",                         // unbalanced closing brace (~148)
            "[abc",                        // unbalanced bracket post-loop (~157)
            "{abc",                        // unbalanced brace post-loop (~161)
        ];
        for input in cases {
            let err = prepare_globs(&[(*input).to_string()]).unwrap_err();
            let AppError::Validation(msg) = err else {
                panic!("expected AppError::Validation for {input:?}, got {err:?}");
            };
            assert!(
                msg.starts_with(&expect),
                "emit site for {input:?} must start with {expect:?}; got {msg:?}",
            );
        }
        // The expansion-overflow site (~82) is only reachable via a heavy
        // brace product; assert it too when it errors rather than truncates.
        if let Err(AppError::Validation(msg)) =
            prepare_globs(&["{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}{a,b,c,d}".to_string()])
        {
            assert!(msg.starts_with(&expect), "expansion-overflow msg: {msg:?}");
        }
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

    #[test]
    fn literal_segment_after_large_alts_stays_capped() {
        // #1599: a `Literal` segment trailing a wide `{...}` group must keep
        // the result `<= EXPANSION_CAP`. Note the prior `Alts` segment already
        // truncates `results` to exactly the cap, so the `Literal` branch runs
        // over a `<= cap` working set and produces exactly one entry per
        // input — its in-loop `break` is defensive symmetry with `Alts` and is
        // not the load-bearing cap here (the post-segment truncate is). This
        // test pins the end-to-end invariant: the cap holds across a
        // Literal-after-Alts boundary.
        let alts: String = (0..EXPANSION_CAP + 10)
            .map(|i| format!("a{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let pattern = format!("{{{alts}}}/x");
        let out = expand_braces(&pattern).unwrap();
        // The Alts segment truncates to exactly the cap; the Literal suffix is
        // 1:1, so the width must be exactly EXPANSION_CAP, not merely `<=`.
        assert_eq!(
            out.len(),
            EXPANSION_CAP,
            "literal-after-alts must stay at the cap, got {}",
            out.len()
        );
    }

    #[test]
    fn under_cap_literal_pattern_expands_unchanged() {
        // A pattern with a literal segment that stays under the cap must
        // expand exactly as before — the new guard only fires above the cap.
        let out = expand_braces("{a,b}suffix").unwrap();
        assert_eq!(out, vec!["asuffix".to_string(), "bsuffix".to_string()]);
    }
}
