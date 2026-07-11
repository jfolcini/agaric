//! Bibliography (BibTeX / CSL-JSON) import parser (#1454 tier a).
//!
//! Pure parsing only — no sqlx, no IO. Both formats parse into the same
//! [`BibEntry`] shape plus a list of non-fatal warnings; the command layer
//! (`commands::pages::bibliography`) turns entries into reference pages with
//! typed properties.
//!
//! # BibTeX subset (deliberately hand-rolled)
//!
//! Like the YAML-subset frontmatter parser in `import.rs`, this is a
//! HAND-ROLLED parser over a fixed BibTeX *subset* — not a general BibTeX/TeX
//! implementation — chosen to avoid pulling in a bibliography crate for the
//! narrow import path. Strict about what it accepts; everything it skips is a
//! warning, never a silent drop. The supported (parsed) grammar is frozen as:
//!
//!   * `@type{key, field = value, ...}` entries (brace-delimited bodies only;
//!     the parenthesised `@type(...)` form is skip-and-warn);
//!   * field values delimited by balanced braces (`{...}`, one outer layer
//!     stripped, nesting-aware), double quotes (`"..."`), or a bare number;
//!   * mapped fields: `title`, `author` (split on top-level ` and `), `year`
//!     (integer), `doi`, `url`, `journal`, `abstract` — every other field is
//!     ignored with one per-entry warning listing the ignored names;
//!   * LaTeX decoding of ONLY `\{`, `\}`, `\&`, `\%`, `--`/`---` (en/em
//!     dash), and common pure-ASCII accent forms (`\'e`, `{\"o}`, `\c{c}`,
//!     `\ss`, `\o`, `\ae`, `\aa`, …) — any other `\command` is kept literal
//!     with one warning per entry.
//!
//! Explicitly REJECTED shapes are parse-and-warn (skipped, never crash):
//! `@comment` / `@preamble` / `@string` directives (NO macro expansion), bare
//! non-numeric field values (undefined-macro references), `#` string
//! concatenation, entries missing a citation key, and non-brace entry bodies.
//! Structural errors — unbalanced braces / an unterminated quoted value, i.e.
//! input we cannot resync past — fail the parse with a
//! [`AppError::Validation`] carrying the entry's starting line.
//!
//! # CSL-JSON subset
//!
//! A top-level JSON array of entry objects (a single top-level object is
//! accepted as a one-entry array). Mapped keys: `id`, `type`, `title`,
//! `author` (objects with `family` / `given` / `literal`),
//! `issued.date-parts[0][0]` → year, `DOI`, `URL`, `container-title` →
//! journal, `abstract`. Unknown keys are ignored with one per-entry warning
//! listing them. Invalid JSON fails the parse with `AppError::Validation`
//! (serde's message carries line/column info).

use crate::error::AppError;

/// One parsed bibliography entry, format-independent.
#[derive(Debug, Clone, PartialEq)]
pub struct BibEntry {
    /// The citation key (`@article{KEY, ...}` / CSL `id`). Never empty —
    /// key-less entries are skipped at parse time with a warning.
    pub citation_key: String,
    /// Lower-cased BibTeX entry type (`article`, `book`, …) or the CSL
    /// `type` string (`article-journal`, …). `misc` when CSL omits it.
    pub entry_type: String,
    pub title: Option<String>,
    /// Author display strings in source order. BibTeX keeps the source form
    /// (`Family, Given` or `Given Family`, LaTeX-decoded); CSL renders
    /// `family, given` (or the `literal` name verbatim).
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub doi: Option<String>,
    pub url: Option<String>,
    /// BibTeX `journal` / CSL `container-title`.
    pub journal: Option<String>,
    /// BibTeX `abstract` / CSL `abstract`. Named `abstract_text` because
    /// `abstract` is a reserved Rust keyword.
    pub abstract_text: Option<String>,
}

impl BibEntry {
    fn empty(citation_key: String, entry_type: String) -> Self {
        Self {
            citation_key,
            entry_type,
            title: None,
            authors: Vec::new(),
            year: None,
            doi: None,
            url: None,
            journal: None,
            abstract_text: None,
        }
    }

    /// Family name of the FIRST author, for the "{family} {year}" citation
    /// display name. `Family, Given` forms take the text before the first
    /// comma (so multi-word families like `de la Cruz, Maria` survive);
    /// `Given Family` forms take the last whitespace-separated token.
    pub fn first_author_family(&self) -> Option<String> {
        let first = self.authors.first()?;
        let family = match first.split_once(',') {
            Some((family, _given)) => family.trim(),
            None => first.split_whitespace().last().unwrap_or(""),
        };
        if family.is_empty() {
            None
        } else {
            Some(family.to_string())
        }
    }
}

/// Parse output: entries in source order plus non-fatal diagnostics.
#[derive(Debug, Clone, Default)]
pub struct BibParseOutput {
    pub entries: Vec<BibEntry>,
    pub warnings: Vec<String>,
}

/// Bibliography wire formats accepted by `import_bibliography`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BibliographyFormat {
    Bibtex,
    CslJson,
}

/// Auto-detect the format from the first non-whitespace character:
/// `@` → BibTeX, `[` or `{` → CSL-JSON. Anything else (including an
/// empty/whitespace-only file) is a Validation error telling the caller to
/// pass the format explicitly.
pub fn detect_bibliography_format(content: &str) -> Result<BibliographyFormat, AppError> {
    match content.trim_start().chars().next() {
        None => Err(AppError::validation(
            "bibliography file is empty".to_string(),
        )),
        Some('@') => Ok(BibliographyFormat::Bibtex),
        Some('[' | '{') => Ok(BibliographyFormat::CslJson),
        Some(c) => Err(AppError::validation(format!(
            "cannot auto-detect bibliography format from leading character '{c}' \
             (expected '@' for BibTeX or '[' / '{{' for CSL-JSON); \
             pass format = 'bibtex' or 'csl-json' explicitly"
        ))),
    }
}

/// Parse `content` as `format` into entries + warnings.
pub fn parse_bibliography(
    content: &str,
    format: BibliographyFormat,
) -> Result<BibParseOutput, AppError> {
    if content.trim().is_empty() {
        return Err(AppError::validation(
            "bibliography file is empty".to_string(),
        ));
    }
    match format {
        BibliographyFormat::Bibtex => parse_bibtex(content),
        BibliographyFormat::CslJson => parse_csl_json(content),
    }
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

/// 1-based line number of char index `pos` (used only on warning/error
/// paths, so the O(pos) count is fine).
fn line_at(chars: &[char], pos: usize) -> usize {
    chars[..pos.min(chars.len())]
        .iter()
        .filter(|c| **c == '\n')
        .count()
        + 1
}

fn skip_ws(chars: &[char], pos: &mut usize) {
    while *pos < chars.len() && chars[*pos].is_whitespace() {
        *pos += 1;
    }
}

/// The Validation error for an entry body that never closes. Carries the
/// entry's starting line so the user can find the offending `@type{`.
fn unbalanced_error(etype: &str, key: &str, at_line: usize) -> AppError {
    let key_part = if key.is_empty() {
        String::new()
    } else {
        format!("{key}, ")
    };
    AppError::validation(format!(
        "unbalanced braces in BibTeX entry '@{etype}{{{key_part}...' starting at line {at_line}: \
         reached end of input while still inside the entry"
    ))
}

/// Skip a balanced `{...}` group. `pos` must point AT the opening `{`;
/// on success it points just past the matching `}`. `\{` / `\}` escapes do
/// not affect nesting. EOF inside the group → Validation error.
fn skip_balanced(
    chars: &[char],
    pos: &mut usize,
    etype: &str,
    key: &str,
    at_line: usize,
) -> Result<(), AppError> {
    debug_assert_eq!(chars.get(*pos), Some(&'{'));
    let mut depth = 0usize;
    while *pos < chars.len() {
        match chars[*pos] {
            '\\' => {
                // Escaped char (e.g. `\{`): consume both, never counts
                // toward nesting.
                *pos += 2;
                continue;
            }
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    *pos += 1;
                    return Ok(());
                }
            }
            _ => {}
        }
        *pos += 1;
    }
    Err(unbalanced_error(etype, key, at_line))
}

/// One `field = value` part: a real string, or an unexpandable macro name.
enum ValuePart {
    Text(String),
    Macro(String),
}

/// Parse a single value part: `{...}` (one outer brace layer stripped),
/// `"..."`, a bare number, or a bare identifier (→ [`ValuePart::Macro`],
/// since `@string` expansion is unsupported).
fn parse_value_part(
    chars: &[char],
    pos: &mut usize,
    etype: &str,
    key: &str,
    at_line: usize,
) -> Result<ValuePart, AppError> {
    match chars.get(*pos) {
        Some('{') => {
            let mut depth = 1usize;
            *pos += 1;
            let mut out = String::new();
            while *pos < chars.len() {
                let c = chars[*pos];
                match c {
                    '\\' => {
                        out.push('\\');
                        if let Some(next) = chars.get(*pos + 1) {
                            out.push(*next);
                        }
                        *pos += 2;
                        continue;
                    }
                    '{' => {
                        depth += 1;
                        out.push(c);
                    }
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            *pos += 1;
                            return Ok(ValuePart::Text(out));
                        }
                        out.push(c);
                    }
                    _ => out.push(c),
                }
                *pos += 1;
            }
            Err(unbalanced_error(etype, key, at_line))
        }
        Some('"') => {
            *pos += 1;
            let mut out = String::new();
            // Brace-nesting aware: a `"` inside braces (`"{"}..."`-style TeX
            // trickery) does not terminate the value.
            let mut depth = 0usize;
            while *pos < chars.len() {
                let c = chars[*pos];
                match c {
                    '\\' => {
                        out.push('\\');
                        if let Some(next) = chars.get(*pos + 1) {
                            out.push(*next);
                        }
                        *pos += 2;
                        continue;
                    }
                    '{' => {
                        depth += 1;
                        out.push(c);
                    }
                    '}' => {
                        depth = depth.saturating_sub(1);
                        out.push(c);
                    }
                    '"' if depth == 0 => {
                        *pos += 1;
                        return Ok(ValuePart::Text(out));
                    }
                    _ => out.push(c),
                }
                *pos += 1;
            }
            Err(AppError::validation(format!(
                "unterminated quoted value in BibTeX entry '@{etype}{{{key}, ...' \
                 starting at line {at_line}"
            )))
        }
        _ => {
            // Bare token: number or (unsupported) macro name.
            let start = *pos;
            while *pos < chars.len()
                && !chars[*pos].is_whitespace()
                && !matches!(chars[*pos], ',' | '}' | '#')
            {
                *pos += 1;
            }
            let token: String = chars[start..*pos].iter().collect();
            if token.chars().all(|c| c.is_ascii_digit()) && !token.is_empty() {
                Ok(ValuePart::Text(token))
            } else {
                Ok(ValuePart::Macro(token))
            }
        }
    }
}

/// Parse a BibTeX file into entries + warnings. See the module docs for the
/// exact supported subset.
pub fn parse_bibtex(content: &str) -> Result<BibParseOutput, AppError> {
    let chars: Vec<char> = content.chars().collect();
    let len = chars.len();
    let mut pos = 0usize;
    let mut entries: Vec<BibEntry> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // Incremental line counter for entry-start lines. `line_scan_pos` only ever
    // advances (entry `@`s are encountered in increasing `pos` order), so each
    // char is scanned for newlines at most once and the whole parse stays
    // O(n). A per-entry `line_at(&chars, pos)` here rescanned `[0..pos]` every
    // entry — O(n·entries), quadratic for the many-small-entries case a large
    // academic export hits (the same O(n²) class fixed in
    // `split_bibtex_authors`).
    let mut line_scan_pos = 0usize;
    let mut cur_line = 1usize;

    while pos < len {
        // Text between entries is a comment by BibTeX convention — skip to
        // the next '@' silently.
        if chars[pos] != '@' {
            pos += 1;
            continue;
        }
        while line_scan_pos < pos {
            if chars[line_scan_pos] == '\n' {
                cur_line += 1;
            }
            line_scan_pos += 1;
        }
        let at_line = cur_line;
        pos += 1;

        // Entry type identifier.
        let type_start = pos;
        while pos < len && chars[pos].is_ascii_alphabetic() {
            pos += 1;
        }
        let etype: String = chars[type_start..pos]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        if etype.is_empty() {
            warnings.push(format!(
                "stray '@' at line {at_line} is not followed by an entry type; ignored"
            ));
            continue;
        }
        skip_ws(&chars, &mut pos);

        // Unsupported directives: skip the whole balanced group with a
        // warning. NO macro expansion is performed (`@string` definitions
        // are not remembered).
        if matches!(etype.as_str(), "comment" | "preamble" | "string") {
            if chars.get(pos) == Some(&'{') {
                skip_balanced(&chars, &mut pos, &etype, "", at_line)?;
            }
            // A brace-less `@comment ...` comments out the rest of the line
            // only; resync at the next '@' naturally.
            warnings.push(format!(
                "'@{etype}' directive at line {at_line} is not supported and was skipped \
                 (no macro expansion)"
            ));
            continue;
        }

        if chars.get(pos) != Some(&'{') {
            // Includes the parenthesised `@type(...)` form — outside the
            // documented subset. Resync at the next '@'.
            warnings.push(format!(
                "entry '@{etype}' at line {at_line}: expected '{{' after the entry type; \
                 entry skipped"
            ));
            continue;
        }
        pos += 1; // consume '{'
        skip_ws(&chars, &mut pos);

        // Citation key: up to the first ',' (or '}' for a field-less entry).
        let key_start = pos;
        while pos < len
            && !matches!(chars[pos], ',' | '}' | '{' | '=')
            && !chars[pos].is_whitespace()
        {
            pos += 1;
        }
        let key: String = chars[key_start..pos].iter().collect();
        skip_ws(&chars, &mut pos);

        if key.is_empty() || !matches!(chars.get(pos), Some(',' | '}')) {
            warnings.push(format!(
                "entry '@{etype}' at line {at_line} has a missing or malformed citation key; \
                 entry skipped"
            ));
            // Skip the remainder of this entry's balanced body (we are at
            // depth 1 — rewind conceptually by scanning until it closes).
            skip_entry_remainder(&chars, &mut pos, &etype, &key, at_line)?;
            continue;
        }

        let mut entry = BibEntry::empty(key.clone(), etype.clone());
        let mut ignored_fields: Vec<String> = Vec::new();
        let mut seen_fields: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut latex_kept_literal = false;
        let mut aborted = false;

        // Field loop. Entered with `pos` at ',' or '}'.
        loop {
            skip_ws(&chars, &mut pos);
            match chars.get(pos) {
                None => return Err(unbalanced_error(&etype, &key, at_line)),
                Some('}') => {
                    pos += 1;
                    break;
                }
                Some(',') => {
                    pos += 1;
                    continue;
                }
                Some(_) => {}
            }

            // Field name up to '='.
            let fstart = pos;
            while pos < len && !matches!(chars[pos], '=' | ',' | '}') {
                pos += 1;
            }
            if pos >= len {
                return Err(unbalanced_error(&etype, &key, at_line));
            }
            if chars[pos] != '=' {
                warnings.push(format!(
                    "entry '{key}': malformed field near line {}; rest of entry skipped",
                    line_at(&chars, fstart)
                ));
                skip_entry_remainder(&chars, &mut pos, &etype, &key, at_line)?;
                aborted = true;
                break;
            }
            let fname: String = chars[fstart..pos]
                .iter()
                .collect::<String>()
                .trim()
                .to_ascii_lowercase();
            pos += 1; // consume '='
            skip_ws(&chars, &mut pos);

            // Value, possibly a `part # part # ...` concatenation.
            let mut parts: Vec<ValuePart> = Vec::new();
            loop {
                parts.push(parse_value_part(&chars, &mut pos, &etype, &key, at_line)?);
                skip_ws(&chars, &mut pos);
                if chars.get(pos) == Some(&'#') {
                    pos += 1;
                    skip_ws(&chars, &mut pos);
                    continue;
                }
                break;
            }

            let value: Option<String> = if parts.len() > 1 {
                warnings.push(format!(
                    "entry '{key}': field '{fname}' uses '#' string concatenation \
                     (not supported); field skipped"
                ));
                None
            } else {
                match parts.into_iter().next() {
                    Some(ValuePart::Text(s)) => Some(s),
                    Some(ValuePart::Macro(m)) => {
                        warnings.push(format!(
                            "entry '{key}': field '{fname}' references the string macro '{m}' \
                             (no macro expansion); field skipped"
                        ));
                        None
                    }
                    None => None,
                }
            };
            let Some(raw_value) = value else { continue };

            if !seen_fields.insert(fname.clone()) {
                warnings.push(format!(
                    "entry '{key}': field '{fname}' appears more than once; \
                     keeping the first value"
                ));
                continue;
            }

            apply_bibtex_field(
                &mut entry,
                &fname,
                &raw_value,
                &mut ignored_fields,
                &mut latex_kept_literal,
                &mut warnings,
            );
        }
        if aborted {
            // Malformed mid-entry: keep whatever fields parsed before the
            // malformation (the entry is still identifiable by its key).
        }
        if !ignored_fields.is_empty() {
            warnings.push(format!(
                "entry '{key}': ignored unsupported field(s): {}",
                ignored_fields.join(", ")
            ));
        }
        if latex_kept_literal {
            warnings.push(format!(
                "entry '{key}': unrecognized LaTeX markup was kept literal"
            ));
        }
        entries.push(entry);
    }

    Ok(BibParseOutput { entries, warnings })
}

/// After a malformed key/field, consume the rest of the CURRENT entry body
/// (we are inside it at brace depth 1) so parsing resyncs at the entry's
/// closing `}`. EOF before it closes → the standard unbalanced-braces error.
fn skip_entry_remainder(
    chars: &[char],
    pos: &mut usize,
    etype: &str,
    key: &str,
    at_line: usize,
) -> Result<(), AppError> {
    let mut depth = 1usize;
    while *pos < chars.len() {
        match chars[*pos] {
            '\\' => {
                *pos += 2;
                continue;
            }
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    *pos += 1;
                    return Ok(());
                }
            }
            _ => {}
        }
        *pos += 1;
    }
    Err(unbalanced_error(etype, key, at_line))
}

/// Route one supported BibTeX field into the entry (decoding LaTeX), or
/// record it as ignored.
fn apply_bibtex_field(
    entry: &mut BibEntry,
    fname: &str,
    raw_value: &str,
    ignored_fields: &mut Vec<String>,
    latex_kept_literal: &mut bool,
    warnings: &mut Vec<String>,
) {
    match fname {
        "title" => entry.title = Some(decode_latex(raw_value, latex_kept_literal)),
        "author" => entry.authors = split_bibtex_authors(raw_value, latex_kept_literal),
        "year" => {
            let decoded = decode_latex(raw_value, latex_kept_literal);
            match decoded.trim().parse::<i64>() {
                Ok(y) => entry.year = Some(y),
                Err(_) => warnings.push(format!(
                    "entry '{}': year '{}' is not an integer; ignored",
                    entry.citation_key,
                    decoded.trim()
                )),
            }
        }
        // DOIs/URLs are machine identifiers — no LaTeX decoding beyond
        // whitespace trimming (a `\_`-escaped DOI is left as authored and
        // flagged by the literal-markup warning if it contains `\`).
        "doi" => entry.doi = Some(raw_value.trim().to_string()),
        "url" => entry.url = Some(raw_value.trim().to_string()),
        "journal" => entry.journal = Some(decode_latex(raw_value, latex_kept_literal)),
        "abstract" => entry.abstract_text = Some(decode_latex(raw_value, latex_kept_literal)),
        other => ignored_fields.push(other.to_string()),
    }
}

/// Split a BibTeX `author` field on top-level ` and ` separators (case-
/// insensitive, brace-nesting aware so `{Smith and Sons}` stays one name),
/// LaTeX-decoding and whitespace-collapsing each name.
fn split_bibtex_authors(raw: &str, latex_kept_literal: &mut bool) -> Vec<String> {
    let chars: Vec<char> = raw.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' => {
                current.push('\\');
                if let Some(next) = chars.get(i + 1) {
                    current.push(*next);
                }
                i += 2;
                continue;
            }
            '{' => {
                depth += 1;
                current.push(c);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                current.push(c);
            }
            c if depth == 0 && c.is_whitespace() => {
                // Possible ` and ` separator: peek the next word.
                let mut j = i;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                let word: String = chars[j..]
                    .iter()
                    .take_while(|ch| ch.is_ascii_alphabetic())
                    .collect();
                let after = j + word.chars().count();
                let word_is_and = word.eq_ignore_ascii_case("and")
                    && chars.get(after).is_none_or(|ch| ch.is_whitespace());
                if word_is_and {
                    parts.push(current.clone());
                    current.clear();
                    i = after;
                    continue;
                }
                // Collapse the whole whitespace run to a single space and jump
                // to its end. Advancing by ONE char here instead would re-scan
                // the same run on every iteration (the inner peek above rescans
                // from `i` to the run's end each time) — O(n^2) on a long
                // whitespace run in an `author` field, a pathological-input
                // hang. The final `split_whitespace().join(" ")` normalizes
                // runs to single spaces regardless, so collapsing here is
                // behavior-preserving.
                current.push(' ');
                i = j;
                continue;
            }
            _ => current.push(c),
        }
        i += 1;
    }
    parts.push(current);

    parts
        .into_iter()
        .map(|p| {
            let decoded = decode_latex(&p, latex_kept_literal);
            decoded.split_whitespace().collect::<Vec<_>>().join(" ")
        })
        // Rejoin the ", Given" half onto "Family" (split_whitespace joined
        // with single spaces already normalises `Doe ,  Jane`? no — commas
        // stay attached to their token, which is what we want).
        .filter(|p| !p.is_empty())
        .collect()
}

// ---------------------------------------------------------------------------
// LaTeX subset decoding
// ---------------------------------------------------------------------------

/// Decode the documented LaTeX subset (module docs): `\{ \} \& \%`, en/em
/// dashes, and common pure-ASCII accent forms. Anything else that looks like
/// LaTeX (`\command`) is kept literal and flips `had_unknown` so the caller
/// can warn once per entry.
fn decode_latex(s: &str, had_unknown: &mut bool) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '-' => {
                let mut j = i;
                while j < chars.len() && chars[j] == '-' {
                    j += 1;
                }
                match j - i {
                    2 => out.push('\u{2013}'), // en dash
                    3 => out.push('\u{2014}'), // em dash
                    n => {
                        for _ in 0..n {
                            out.push('-');
                        }
                    }
                }
                i = j;
            }
            '\\' => {
                if let Some((decoded, consumed)) = decode_latex_escape(&chars[i..]) {
                    out.push(decoded);
                    i += consumed;
                } else {
                    *had_unknown = true;
                    out.push('\\');
                    i += 1;
                }
            }
            '{' => {
                // Braced accent group `{\'e}` / `{\ss}` — decode; any other
                // brace (e.g. case protection `{DNA}`) is kept literal.
                if chars.get(i + 1) == Some(&'\\')
                    && let Some((decoded, consumed)) = decode_latex_escape(&chars[i + 1..])
                    && chars.get(i + 1 + consumed) == Some(&'}')
                {
                    out.push(decoded);
                    i += consumed + 2;
                } else {
                    out.push('{');
                    i += 1;
                }
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

/// Decode one escape starting at `\` (slice[0]). Returns the decoded char
/// and the number of chars consumed, or `None` when the command is outside
/// the supported subset.
fn decode_latex_escape(slice: &[char]) -> Option<(char, usize)> {
    debug_assert_eq!(slice.first(), Some(&'\\'));
    let next = *slice.get(1)?;
    // Literal escapes.
    if matches!(next, '{' | '}' | '&' | '%') {
        return Some((next, 2));
    }
    // Accent marks: \'e, \'{e}, \`e, \^e, \"o, \~n (and capitals).
    if matches!(next, '\'' | '`' | '^' | '"' | '~') {
        if let Some(&arg) = slice.get(2)
            && arg.is_ascii_alphabetic()
            && let Some(decoded) = accented(next, arg)
        {
            return Some((decoded, 3));
        }
        if slice.get(2) == Some(&'{')
            && let Some(&arg) = slice.get(3)
            && slice.get(4) == Some(&'}')
            && let Some(decoded) = accented(next, arg)
        {
            return Some((decoded, 5));
        }
        return None;
    }
    // Word commands: \ss, \o, \O, \ae, \AE, \aa, \AA, and \c{c} (cedilla).
    if next.is_ascii_alphabetic() {
        let word: String = slice[1..]
            .iter()
            .take_while(|c| c.is_ascii_alphabetic())
            .collect();
        let word_len = word.chars().count();
        // Cedilla: \c{c} / \c{C}.
        if word == "c"
            && slice.get(2) == Some(&'{')
            && slice.get(4) == Some(&'}')
            && let Some(&arg) = slice.get(3)
        {
            let decoded = match arg {
                'c' => 'ç',
                'C' => 'Ç',
                _ => return None,
            };
            return Some((decoded, 5));
        }
        let decoded = match word.as_str() {
            "ss" => 'ß',
            "o" => 'ø',
            "O" => 'Ø',
            "ae" => 'æ',
            "AE" => 'Æ',
            "aa" => 'å',
            "AA" => 'Å',
            "l" => 'ł',
            "L" => 'Ł',
            _ => return None,
        };
        // The command must be delimited (end of input, `{}`, whitespace, or
        // any non-letter) — `\oderint` is NOT `\o` + `derint`.
        match slice.get(1 + word_len) {
            None => Some((decoded, 1 + word_len)),
            Some(c) if !c.is_ascii_alphabetic() => {
                // A following `{}` is an explicit delimiter — consume it.
                if *c == '{' && slice.get(2 + word_len) == Some(&'}') {
                    Some((decoded, 3 + word_len))
                } else {
                    Some((decoded, 1 + word_len))
                }
            }
            Some(_) => None,
        }
    } else {
        None
    }
}

/// Pure-ASCII accent lookup: mark × base letter → precomposed char.
fn accented(mark: char, base: char) -> Option<char> {
    let table: &[(char, &str, &str)] = &[
        ('\'', "aeiouyAEIOUYcnsz", "áéíóúýÁÉÍÓÚÝćńśź"),
        ('`', "aeiouAEIOU", "àèìòùÀÈÌÒÙ"),
        ('^', "aeiouAEIOU", "âêîôûÂÊÎÔÛ"),
        ('"', "aeiouyAEIOU", "äëïöüÿÄËÏÖÜ"),
        ('~', "anoANO", "ãñõÃÑÕ"),
    ];
    for (m, bases, decoded) in table {
        if *m == mark
            && let Some(idx) = bases.chars().position(|b| b == base)
        {
            return decoded.chars().nth(idx);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// CSL-JSON
// ---------------------------------------------------------------------------

/// CSL-JSON keys mapped into [`BibEntry`]; everything else is ignored with a
/// per-entry warning.
const CSL_KNOWN_KEYS: &[&str] = &[
    "id",
    "type",
    "title",
    "author",
    "issued",
    "DOI",
    "URL",
    "container-title",
    "abstract",
];

/// Parse a CSL-JSON array (or single object) into entries + warnings.
pub fn parse_csl_json(content: &str) -> Result<BibParseOutput, AppError> {
    let value: serde_json::Value = serde_json::from_str(content)
        .map_err(|e| AppError::validation(format!("invalid CSL-JSON: {e}")))?;
    let items: Vec<serde_json::Value> = match value {
        serde_json::Value::Array(items) => items,
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => {
            return Err(AppError::validation(
                "CSL-JSON must be an array of entry objects".to_string(),
            ));
        }
    };

    let mut entries: Vec<BibEntry> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for (idx, item) in items.iter().enumerate() {
        let ordinal = idx + 1;
        let Some(obj) = item.as_object() else {
            warnings.push(format!(
                "CSL-JSON entry #{ordinal} is not an object; skipped"
            ));
            continue;
        };
        // `id` may be a string or a number per the CSL-JSON schema.
        let citation_key = match obj.get("id") {
            Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
            Some(serde_json::Value::Number(n)) => n.to_string(),
            _ => {
                warnings.push(format!(
                    "CSL-JSON entry #{ordinal} has no usable 'id' (citation key); skipped"
                ));
                continue;
            }
        };
        let entry_type = obj
            .get("type")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("misc")
            .trim()
            .to_string();

        let mut entry = BibEntry::empty(citation_key.clone(), entry_type);
        entry.title = obj
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string());
        entry.doi = obj
            .get("DOI")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string());
        entry.url = obj
            .get("URL")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string());
        entry.journal = obj
            .get("container-title")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string());
        entry.abstract_text = obj
            .get("abstract")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string());

        // author: [{family, given} | {literal}]
        if let Some(authors) = obj.get("author") {
            match authors.as_array() {
                Some(list) => {
                    for author in list {
                        let Some(a) = author.as_object() else {
                            warnings.push(format!(
                                "entry '{citation_key}': author element is not an object; skipped"
                            ));
                            continue;
                        };
                        let family = a.get("family").and_then(|v| v.as_str()).unwrap_or("");
                        let given = a.get("given").and_then(|v| v.as_str()).unwrap_or("");
                        let literal = a.get("literal").and_then(|v| v.as_str()).unwrap_or("");
                        let display = match (family.trim(), given.trim(), literal.trim()) {
                            ("", "", "") => {
                                warnings.push(format!(
                                    "entry '{citation_key}': author with no family/given/literal \
                                     name; skipped"
                                ));
                                continue;
                            }
                            ("", "", lit) => lit.to_string(),
                            (family_name, "", _) => family_name.to_string(),
                            ("", given_name, _) => given_name.to_string(),
                            (family_name, given_name, _) => format!("{family_name}, {given_name}"),
                        };
                        entry.authors.push(display);
                    }
                }
                None => warnings.push(format!(
                    "entry '{citation_key}': 'author' is not an array; ignored"
                )),
            }
        }

        // issued.date-parts[0][0] → year (number or numeric string).
        if let Some(issued) = obj.get("issued") {
            let year = issued
                .get("date-parts")
                .and_then(|dp| dp.get(0))
                .and_then(|first| first.get(0))
                .and_then(|y| match y {
                    serde_json::Value::Number(n) => n.as_i64(),
                    serde_json::Value::String(s) => s.trim().parse::<i64>().ok(),
                    _ => None,
                });
            match year {
                Some(y) => entry.year = Some(y),
                None => warnings.push(format!(
                    "entry '{citation_key}': 'issued' has no usable date-parts year; ignored"
                )),
            }
        }

        let ignored: Vec<String> = obj
            .keys()
            .filter(|k| !CSL_KNOWN_KEYS.contains(&k.as_str()))
            .cloned()
            .collect();
        if !ignored.is_empty() {
            warnings.push(format!(
                "entry '{citation_key}': ignored unsupported field(s): {}",
                ignored.join(", ")
            ));
        }

        entries.push(entry);
    }

    Ok(BibParseOutput { entries, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(s: &str) -> (String, bool) {
        let mut unknown = false;
        let out = decode_latex(s, &mut unknown);
        (out, unknown)
    }

    // -- format detection ---------------------------------------------------

    #[test]
    fn detect_format_bibtex_csl_and_errors() {
        assert_eq!(
            detect_bibliography_format("  @article{a,}").unwrap(),
            BibliographyFormat::Bibtex
        );
        assert_eq!(
            detect_bibliography_format("\n[{\"id\":\"a\"}]").unwrap(),
            BibliographyFormat::CslJson
        );
        assert_eq!(
            detect_bibliography_format("{\"id\":\"a\"}").unwrap(),
            BibliographyFormat::CslJson
        );
        let empty = detect_bibliography_format("   \n\t ").unwrap_err();
        assert!(
            empty.to_string().contains("empty"),
            "empty input must say so: {empty}"
        );
        let other = detect_bibliography_format("hello").unwrap_err();
        assert!(
            other.to_string().contains("auto-detect"),
            "undetectable input must ask for an explicit format: {other}"
        );
    }

    // -- BibTeX happy path ----------------------------------------------------

    #[test]
    fn bibtex_parses_all_mapped_fields() {
        let src = r#"
@article{doe2020,
  title   = {A {Nested} Study of --- Things},
  author  = {Doe, Jane and Smith, John},
  year    = {2020},
  doi     = {10.1000/xyz},
  url     = "https://example.org/paper",
  journal = {Journal of Tests},
  abstract = {We test \& verify 100\% of cases.},
}
"#;
        let out = parse_bibtex(src).unwrap();
        assert_eq!(out.entries.len(), 1, "warnings: {:?}", out.warnings);
        let e = &out.entries[0];
        assert_eq!(e.citation_key, "doe2020");
        assert_eq!(e.entry_type, "article");
        assert_eq!(
            e.title.as_deref(),
            Some("A {Nested} Study of \u{2014} Things")
        );
        assert_eq!(e.authors, vec!["Doe, Jane", "Smith, John"]);
        assert_eq!(e.year, Some(2020));
        assert_eq!(e.doi.as_deref(), Some("10.1000/xyz"));
        assert_eq!(e.url.as_deref(), Some("https://example.org/paper"));
        assert_eq!(e.journal.as_deref(), Some("Journal of Tests"));
        assert_eq!(
            e.abstract_text.as_deref(),
            Some("We test & verify 100% of cases.")
        );
        assert!(
            out.warnings.is_empty(),
            "clean input must produce no warnings: {:?}",
            out.warnings
        );
    }

    #[test]
    fn bibtex_bare_number_year_and_quoted_values() {
        let src = "@book{k1, year = 1999, title = \"Bare and Quoted\"}";
        let out = parse_bibtex(src).unwrap();
        assert_eq!(out.entries[0].year, Some(1999));
        assert_eq!(out.entries[0].title.as_deref(), Some("Bare and Quoted"));
    }

    #[test]
    fn bibtex_ignored_fields_warn_once_per_entry() {
        let src = "@article{k1, title={T}, volume={12}, pages={1--2}}";
        let out = parse_bibtex(src).unwrap();
        assert_eq!(out.entries.len(), 1);
        let w = out
            .warnings
            .iter()
            .find(|w| w.contains("ignored unsupported field(s)"))
            .expect("must warn about ignored fields");
        assert!(w.contains("volume") && w.contains("pages"), "{w}");
    }

    #[test]
    fn bibtex_directives_skipped_with_warning() {
        let src = "@string{jt = {Journal}}\n@comment{ignore me {nested}}\n@preamble{\"x\"}\n@misc{k1, title={T}}";
        let out = parse_bibtex(src).unwrap();
        assert_eq!(out.entries.len(), 1);
        assert_eq!(out.entries[0].citation_key, "k1");
        for d in ["@string", "@comment", "@preamble"] {
            assert!(
                out.warnings.iter().any(|w| w.contains(d)),
                "missing {d} warning in {:?}",
                out.warnings
            );
        }
    }

    #[test]
    fn bibtex_macro_reference_and_concatenation_skip_field() {
        let src = "@article{k1, journal = jt, title = {A} # {B}}";
        let out = parse_bibtex(src).unwrap();
        let e = &out.entries[0];
        assert_eq!(e.journal, None, "macro ref must not become a value");
        assert_eq!(e.title, None, "concatenated value must be skipped");
        assert!(
            out.warnings.iter().any(|w| w.contains("macro 'jt'")),
            "{:?}",
            out.warnings
        );
        assert!(
            out.warnings.iter().any(|w| w.contains("concatenation")),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn bibtex_missing_citation_key_skips_entry_with_warning() {
        let src = "@article{, title={No Key}}\n@misc{good, title={Ok}}";
        let out = parse_bibtex(src).unwrap();
        assert_eq!(out.entries.len(), 1);
        assert_eq!(out.entries[0].citation_key, "good");
        assert!(
            out.warnings
                .iter()
                .any(|w| w.contains("missing or malformed citation key")),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn bibtex_unbalanced_braces_is_validation_error_with_line() {
        let src = "@misc{ok, title={fine}}\n\n@article{bad,\n  title = {never closed\n";
        let err = parse_bibtex(src).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("unbalanced braces"), "{msg}");
        assert!(msg.contains("line 3"), "must carry the entry's line: {msg}");
    }

    #[test]
    fn bibtex_unterminated_quote_is_validation_error() {
        let src = "@article{bad, title = \"never closed}";
        let err = parse_bibtex(src).unwrap_err();
        assert!(err.to_string().contains("unterminated quoted value"));
    }

    #[test]
    fn bibtex_duplicate_field_keeps_first_and_warns() {
        let src = "@article{k1, title={First}, title={Second}}";
        let out = parse_bibtex(src).unwrap();
        assert_eq!(out.entries[0].title.as_deref(), Some("First"));
        assert!(
            out.warnings.iter().any(|w| w.contains("more than once")),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn bibtex_fieldless_entry_and_intertext_comments() {
        let src = "This bibliography has commentary.\n@misc{lonely}\nTrailing prose.";
        let out = parse_bibtex(src).unwrap();
        assert_eq!(out.entries.len(), 1);
        assert_eq!(out.entries[0].citation_key, "lonely");
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
    }

    // -- author splitting -----------------------------------------------------

    #[test]
    fn bibtex_author_split_is_brace_aware_and_case_insensitive() {
        let mut unknown = false;
        let authors = split_bibtex_authors(
            "{Smith and Sons} AND Doe, Jane and van Beethoven, Ludwig",
            &mut unknown,
        );
        assert_eq!(
            authors,
            vec!["{Smith and Sons}", "Doe, Jane", "van Beethoven, Ludwig"]
        );
    }

    #[test]
    fn first_author_family_prefers_comma_form() {
        let mut e = BibEntry::empty("k".into(), "misc".into());
        e.authors = vec!["van der Berg, Anna".into()];
        assert_eq!(e.first_author_family().as_deref(), Some("van der Berg"));
        e.authors = vec!["Jane Doe".into()];
        assert_eq!(e.first_author_family().as_deref(), Some("Doe"));
        e.authors = vec![];
        assert_eq!(e.first_author_family(), None);
    }

    // -- LaTeX decoding -------------------------------------------------------

    #[test]
    fn latex_decodes_documented_subset() {
        assert_eq!(decode(r"\{x\}"), ("{x}".into(), false));
        assert_eq!(decode(r"A \& B, 100\%"), ("A & B, 100%".into(), false));
        assert_eq!(
            decode("pp. 1--2 --- yes"),
            ("pp. 1\u{2013}2 \u{2014} yes".into(), false)
        );
        assert_eq!(decode(r"Beno\^{i}t"), ("Benoît".into(), false));
        assert_eq!(
            decode(r#"G{\"o}del and \'etude"#),
            ("Gödel and étude".into(), false)
        );
        assert_eq!(decode(r"Fran\c{c}ois"), ("François".into(), false));
        assert_eq!(decode(r"Gau{\ss}"), ("Gauß".into(), false));
        assert_eq!(decode(r"\o{}rsted \ae"), ("ørsted æ".into(), false));
    }

    #[test]
    fn latex_unknown_commands_kept_literal_and_flagged() {
        let (out, unknown) = decode(r"\textbf{Bold} \alpha");
        assert!(unknown, "unknown commands must be flagged");
        assert_eq!(out, r"\textbf{Bold} \alpha");
        // Case-protection braces stay literal without flagging.
        let (out, unknown) = decode("{DNA} sequencing");
        assert!(!unknown);
        assert_eq!(out, "{DNA} sequencing");
    }

    // -- CSL-JSON ---------------------------------------------------------------

    #[test]
    fn csl_json_parses_mapped_fields() {
        let src = r#"[
          {
            "id": "doe2020",
            "type": "article-journal",
            "title": "A Study",
            "author": [
              {"family": "Doe", "given": "Jane"},
              {"literal": "The Consortium"}
            ],
            "issued": {"date-parts": [[2020, 4, 1]]},
            "DOI": "10.1000/xyz",
            "URL": "https://example.org",
            "container-title": "Journal of Tests",
            "abstract": "We test things.",
            "volume": "12"
          }
        ]"#;
        let out = parse_csl_json(src).unwrap();
        assert_eq!(out.entries.len(), 1);
        let e = &out.entries[0];
        assert_eq!(e.citation_key, "doe2020");
        assert_eq!(e.entry_type, "article-journal");
        assert_eq!(e.title.as_deref(), Some("A Study"));
        assert_eq!(e.authors, vec!["Doe, Jane", "The Consortium"]);
        assert_eq!(e.year, Some(2020));
        assert_eq!(e.doi.as_deref(), Some("10.1000/xyz"));
        assert_eq!(e.url.as_deref(), Some("https://example.org"));
        assert_eq!(e.journal.as_deref(), Some("Journal of Tests"));
        assert_eq!(e.abstract_text.as_deref(), Some("We test things."));
        assert!(
            out.warnings.iter().any(|w| w.contains("volume")),
            "unknown keys must be listed: {:?}",
            out.warnings
        );
    }

    #[test]
    fn csl_json_single_object_numeric_id_and_string_year() {
        let src = r#"{"id": 42, "issued": {"date-parts": [["1999"]]}}"#;
        let out = parse_csl_json(src).unwrap();
        assert_eq!(out.entries[0].citation_key, "42");
        assert_eq!(out.entries[0].entry_type, "misc");
        assert_eq!(out.entries[0].year, Some(1999));
    }

    #[test]
    fn csl_json_missing_id_skips_entry_with_warning() {
        let src = r#"[{"title": "No Id"}, {"id": "ok"}]"#;
        let out = parse_csl_json(src).unwrap();
        assert_eq!(out.entries.len(), 1);
        assert_eq!(out.entries[0].citation_key, "ok");
        assert!(
            out.warnings.iter().any(|w| w.contains("no usable 'id'")),
            "{:?}",
            out.warnings
        );
    }

    #[test]
    fn csl_json_invalid_json_is_validation_error() {
        let err = parse_csl_json("[{\"id\": ").unwrap_err();
        assert!(err.to_string().contains("invalid CSL-JSON"), "{err}");
        let err = parse_csl_json("\"just a string\"").unwrap_err();
        assert!(err.to_string().contains("array"), "{err}");
    }

    #[test]
    fn parse_bibliography_rejects_empty_content() {
        let err = parse_bibliography("   ", BibliographyFormat::Bibtex).unwrap_err();
        assert!(err.to_string().contains("empty"), "{err}");
    }

    // -- adversarial / mangled input (must never panic or hang) --------------

    #[test]
    fn bibtex_mangled_inputs_never_panic() {
        // Every entry must resolve to either Ok(..) or Err(Validation) — never
        // a panic (arithmetic overflow, slice OOB) and never a non-terminating
        // loop. Covers the resync-hard cases called out in review: unbalanced
        // braces at EOF, a quote inside braces, `@{`, missing citation key,
        // deep nesting, CRLF, and a trailing backslash mid-escape at EOF.
        let cases = [
            "",
            "@",
            "@@@@",
            "@{",
            "@{}",
            "@article",
            "@article{",
            "@article{}",
            "@article{,}",
            "@article{key",
            "@article{key,",
            "@article{key, title",
            "@article{key, title=",
            "@article{key, title={",
            "@article{key, title={}",
            "@article{key, title=}",
            "@article{key, title=,}",
            "@article{, title={x}}",
            "@article{key, title={{{{{{{{{{deep",
            "@article{key, title={{{nested}}} }",
            "@article{key, title=\"quote {inside} braces\"}",
            "@article{key, title=\"never closed",
            "@article{key, title={quote \" inside braces}}",
            "@string{x = {y}}\r\n@article{k, title={t}}\r\n",
            "@article{key, author={a and and b and }, year={x}}",
            "@article{key, title={ends with backslash \\",
            "@article{key, author={\\",
            "\\",
            "@comment",
            "@preamble(",
            "@article(paren, title={x})",
            "@article{k, doi = 10.1/x # junk}",
            "@article{k1, title={a}}@article{k1, title={b}}",
        ];
        for src in cases {
            // BibTeX path.
            let _ = parse_bibtex(src);
            // Auto-detect + generic entry — also must not panic on either arm.
            if let Ok(fmt) = detect_bibliography_format(src) {
                let _ = parse_bibliography(src, fmt);
            }
        }
    }

    #[test]
    fn bibtex_large_whitespace_author_is_linear_not_quadratic() {
        // Regression guard for the O(n^2) whitespace-run rescan in
        // `split_bibtex_authors`: a long run of spaces in an `author` value
        // used to rescan the run once per char. 1 MB of spaces would take tens
        // of seconds under the old code; linear scanning finishes instantly.
        let mut src = String::from("@article{k, author={");
        src.push_str(&" ".repeat(1_000_000));
        src.push_str("Doe, Jane}, year={2020}}");
        let out = parse_bibtex(&src).expect("must parse without hanging");
        assert_eq!(out.entries.len(), 1);
        // Leading whitespace collapses; the single real name survives.
        assert_eq!(out.entries[0].authors, vec!["Doe, Jane"]);
    }

    #[test]
    fn bibtex_large_single_entry_parses_linearly() {
        // A ~4 MB single entry (large abstract) must parse in one pass without
        // a quadratic scan. `line_at` is only called on warning/error paths,
        // so the happy path stays O(n).
        let mut src = String::from("@article{big, abstract={");
        src.push_str(&"lorem ipsum dolor ".repeat(250_000)); // ~4.5 MB
        src.push_str("}}");
        let out = parse_bibtex(&src).expect("large entry must parse");
        assert_eq!(out.entries.len(), 1);
        assert!(out.entries[0].abstract_text.is_some());
    }

    #[test]
    fn bibtex_many_small_entries_is_linear_not_quadratic() {
        // Regression guard for the O(n·entries) entry-start line count: the
        // per-entry `line_at(&chars, pos)` rescanned `[0..pos]` every entry, so
        // a large academic export (many small entries) took Σpos ≈ O(n²) — tens
        // of seconds at 10k entries. The incremental `line_scan_pos`/`cur_line`
        // counter keeps it linear. 20k minimal entries (~1 MB) must parse fast.
        let mut src = String::with_capacity(1_100_000);
        for i in 0..20_000 {
            // Spread entries across lines so newline counting is exercised.
            src.push_str(&format!(
                "@article{{k{i},\n title={{T{i}}},\n year={{2020}}}}\n"
            ));
        }
        let out = parse_bibtex(&src).expect("many small entries must parse");
        assert_eq!(out.entries.len(), 20_000);
        // Spot-check that entry-start line tracking stayed correct after the
        // switch from full rescans to the incremental counter: the last entry's
        // title survived and keys are distinct.
        assert_eq!(out.entries[0].citation_key, "k0");
        assert_eq!(out.entries[19_999].citation_key, "k19999");
        assert_eq!(out.entries[19_999].title.as_deref(), Some("T19999"));
    }
}
