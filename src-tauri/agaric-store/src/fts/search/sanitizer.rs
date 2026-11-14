//! Query sanitizer: turns a raw user query into a safe FTS5 MATCH
//! expression, supporting a whitelisted subset of FTS5 operators and the
//! trigram length filter.

use agaric_core::error::AppError;

use super::constants::MAX_QUERY_LEN;
use super::tokenizer::{QueryToken, tokenize_query};

/// Sanitize a raw user query for safe use in an FTS5 MATCH expression.
///
/// Supports a subset of FTS5 search operators so that users can write
/// queries like `"exact phrase"`, `cats NOT dogs`, or `cats OR dogs`.
///
/// ## Rules
///
/// 1. **Quoted phrases** — matched `"..."` in the input are kept as a single
///    FTS5 phrase token (internal `"` escaped by doubling). A phrase under 3
///    characters emits no trigram, so it follows rule 4.
/// 2. **`NOT` operator** — preserved as the bare keyword when followed by at
///    least one more token. FTS5 `NOT` is a *binary* operator (`A NOT B`):
///    a standalone leading `NOT term` (no left operand) is an FTS5 syntax
///    error, surfaced as `AppError::Validation` by [`search_fts`]. We do not
///    rewrite it — `NOT` is meaningful only between two operands.
/// 3. **`OR` / `AND` operators** — preserved as bare keywords when they appear
///    between two other tokens.
/// 4. **Trigram length filter (I-Search-2)** — non-operator word tokens
///    shorter than 3 characters are left out of the expression. The FTS5
///    table uses the trigram tokenizer (migration `0006_fts5_trigram.sql`,
///    `tokenize = 'trigram case_sensitive 0'`); tokens with fewer than 3
///    characters cannot match anything in the index, so retaining them
///    would only AND-collapse the whole query to zero hits. The search
///    paths match them by substring instead (`parse_query`). The
///    operator-keyword whitelist below is the single exception.
/// 5. **Everything else** — wrapped in `"..."` with internal `"` escaped.
///
/// Operator detection is case-insensitive (`not` → `NOT`, `or` → `OR`).
///
/// ## Trigram-filter operator whitelist
///
/// `OR` (2 chars) and `AND` / `NOT` (3 chars) bypass the length filter
/// when they appear in a valid operator position. They are FTS5 syntax,
/// not search terms, so the trigram minimum does not apply. Outside an
/// operator position the same tokens are treated as ordinary words and
/// `OR` is dropped (2 chars), while `AND` / `NOT` survive on length
/// alone.
///
/// ## Safety
///
/// Every non-operator token is always double-quoted, preventing injection of
/// FTS5 syntax such as `NEAR`, `*`, column filters (`col:`), or grouping
/// parentheses.
///
/// [`search_fts`]: super::cursor::search_fts
#[must_use]
// #2945 — widened `pub(crate)` → `pub` so the libFuzzer `fts_strip` harness
// (src-tauri/fuzz/fuzz_targets/fts_strip.rs) can reach this via the
// `agaric_store::fts::sanitize_fts_query` re-export.
pub fn sanitize_fts_query(query: &str) -> String {
    parse_query(query).match_expr
}

/// Trigram tokenizer minimum match length — see migration
/// `0006_fts5_trigram.sql` (`tokenize = 'trigram case_sensitive 0'`).
const TRIGRAM_MIN_LEN: usize = 3;

/// A search query split by what can answer it.
pub(in crate::fts) struct ParsedQuery {
    /// The FTS5 MATCH expression over the terms the trigram index holds;
    /// empty when the query has none.
    pub(in crate::fts) match_expr: String,
    /// The terms under [`TRIGRAM_MIN_LEN`] characters, which the index cannot
    /// hold: each is a required substring of `blocks.content` (#6752).
    pub(in crate::fts) short_terms: Vec<String>,
    /// Every term as typed, for highlighting.
    pub(in crate::fts) terms: Vec<String>,
}

/// Whether the short term at `i` is a plain AND-ed operand. Beside an `OR` or
/// after a `NOT` it is not: a required substring cannot express either, and
/// requiring the term would invert `cats NOT ab`, so there it is left out.
fn short_term_stands_alone(tokens: &[QueryToken], i: usize) -> bool {
    let is_word = |at: Option<usize>, op: &str| {
        at.and_then(|at| tokens.get(at))
            .is_some_and(|t| matches!(t, QueryToken::Word(w) if w.eq_ignore_ascii_case(op)))
    };
    !is_word(i.checked_sub(1), "OR")
        && !is_word(Some(i + 1), "OR")
        && !is_word(i.checked_sub(1), "NOT")
}

/// Record a short term once: a repeat would only repeat its SQL predicate.
fn push_short_term(short_terms: &mut Vec<String>, terms: &mut Vec<String>, term: &str) {
    if !short_terms.iter().any(|seen| seen == term) {
        short_terms.push(term.to_owned());
        terms.push(term.to_owned());
    }
}

/// Split a raw query into its trigram MATCH expression and its short terms.
/// [`sanitize_fts_query`] documents the expression's rules.
pub(in crate::fts) fn parse_query(query: &str) -> ParsedQuery {
    // NFC-normalise the query before tokenisation so an
    // NFC query reaches the NFC-normalised FTS index emitted by
    // `strip_for_fts_with_maps`. Without this, NFD content (macOS
    // pastes, NFD-encoded filenames embedded in titles) becomes
    // invisible to NFC queries.
    let normalised = crate::fts::strip::nfc_normalise(query);
    let tokens = tokenize_query(&normalised);
    let len = tokens.len();
    let mut output_parts: Vec<String> = Vec::new();
    let mut short_terms: Vec<String> = Vec::new();
    let mut terms: Vec<String> = Vec::new();

    for (i, token) in tokens.iter().enumerate() {
        match token {
            QueryToken::QuotedPhrase(phrase) => {
                // User-quoted phrases bypass the trigram length filter —
                // the explicit quoting signals intent.
                // Skip empty or whitespace-only phrases: `""` would pass
                // the post-loop `sanitized.is_empty()` guard unchanged but
                // is a syntax error in FTS5 MATCH.
                let trimmed = phrase.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // #673 — a phrase under a trigram emits no trigram token, so
                // its MATCH clause would AND-collapse the query to nothing.
                // `chars().count()` counts unicode scalars, so a 2-char CJK
                // phrase is measured as 2.
                if trimmed.chars().count() < TRIGRAM_MIN_LEN {
                    if short_term_stands_alone(&tokens, i) {
                        push_short_term(&mut short_terms, &mut terms, trimmed);
                    }
                    continue;
                }
                terms.push(phrase.clone());
                let escaped = phrase.replace('"', "\"\"");
                output_parts.push(format!("\"{escaped}\""));
            }
            QueryToken::Word(word) => {
                let upper = word.to_uppercase();
                let is_operator = match upper.as_str() {
                    // NOT requires a following token.
                    "NOT" => i + 1 < len,
                    // OR / AND require a preceding output and a following token.
                    "OR" | "AND" => !output_parts.is_empty() && i + 1 < len,
                    _ => false,
                };

                if is_operator {
                    // Whitelisted operator — bypass the trigram length filter.
                    output_parts.push(upper);
                } else {
                    // I-Search-2: `chars().count()` counts unicode scalars
                    // (so a 2-character CJK token is measured as 2, not by
                    // byte length). A bare `or` outside an operator position
                    // stays dropped; quote it to search for it.
                    if word.chars().count() < TRIGRAM_MIN_LEN {
                        if upper != "OR" && short_term_stands_alone(&tokens, i) {
                            push_short_term(&mut short_terms, &mut terms, word);
                        }
                        continue;
                    }
                    terms.push(word.clone());
                    let escaped = word.replace('"', "\"\"");
                    output_parts.push(format!("\"{escaped}\""));
                }
            }
        }
    }

    // R5 (#347) — second pass: drop dangling boolean operators.
    //
    // The first pass decides operator-vs-literal from *token positions*
    // (`NOT` is an operator when a token follows it). But the operand it
    // was counting on may then be dropped by the trigram length filter:
    // e.g. `cats NOT ab` → `cats` is kept, `NOT` passes its position
    // check (a token follows), then `ab` (2 chars) is dropped — leaving
    // `"cats" NOT`, a bare trailing operator that FTS5 rejects with a
    // syntax error on otherwise-benign input.
    //
    // A bare operator is an emitted part equal exactly to `OR` / `AND` /
    // `NOT` (a quoted literal like `"NOT"` is a search term, not an
    // operator, and must be preserved). We drop any bare operator left
    // without the right-hand operand it requires:
    //   * a trailing bare operator (`cats NOT ab` → `"cats" NOT`), and
    //   * a bare operator immediately followed by another bare operator
    //     (`cats OR ab NOT dogs` → `"cats" OR NOT "dogs"`): the first of
    //     the adjacent pair has no operand on its right, so it is the one
    //     dropped, leaving the trailing operator's operand intact.
    // We do NOT drop a *leading* bare operator: the first pass only ever
    // emits a leading bare `NOT` (OR/AND require a preceding emitted
    // operand to be promoted). #669 — this leading `NOT term` is NOT a
    // valid form: FTS5 `NOT` is binary (`A NOT B`), so a leading bare
    // `NOT` produces an FTS5 syntax error that `search_fts` maps to
    // `AppError::Validation` (pinned by `fts/tests.rs`). We deliberately
    // preserve it rather than silently dropping the `NOT` (which would
    // invert the user's intent — searching FOR `term` they asked to
    // exclude) or quoting it (which would search for the literal word
    // "not"). Surfacing a clear validation error is the contract.
    // Iterate to a fixpoint so a run collapses fully.
    let is_bare_op = |s: &str| matches!(s, "OR" | "AND" | "NOT");
    loop {
        let before = output_parts.len();
        // Drop trailing bare operators (no right operand).
        while output_parts.last().is_some_and(|s| is_bare_op(s)) {
            output_parts.pop();
        }
        // Drop the earlier of an adjacent bare-operator pair — it is the
        // one missing its right operand. Removing the earlier element
        // lets the survivor re-check its new neighbour next pass.
        if let Some(idx) = output_parts
            .windows(2)
            .position(|w| is_bare_op(&w[0]) && is_bare_op(&w[1]))
        {
            output_parts.remove(idx);
        }
        if output_parts.len() == before {
            break;
        }
    }

    ParsedQuery {
        match_expr: output_parts.join(" "),
        short_terms,
        terms,
    }
}

/// Parse a raw user query for the FTS entry points, or `None` when it asks
/// for nothing — an empty MATCH is an FTS5 syntax error, so each entry point
/// short-circuits to its own empty result instead.
///
/// The length cap runs before the NFC-normalise + tokenise walk, mirroring the
/// regex path's `MAX_PATTERN_LEN`.
pub(super) fn prepare_query(query: &str) -> Result<Option<ParsedQuery>, AppError> {
    // Not redundant with the parsed-empty check below: it is what keeps a
    // blank query past `MAX_QUERY_LEN` an empty page rather than a validation error.
    if query.trim().is_empty() {
        return Ok(None);
    }
    if query.len() > MAX_QUERY_LEN {
        return Err(AppError::validation(format!(
            "search query is too long ({} bytes); maximum is {MAX_QUERY_LEN} bytes",
            query.len()
        )));
    }
    let parsed = parse_query(query);
    Ok((!parsed.match_expr.is_empty() || !parsed.short_terms.is_empty()).then_some(parsed))
}
