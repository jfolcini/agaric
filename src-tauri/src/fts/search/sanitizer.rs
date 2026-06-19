//! Query sanitizer: turns a raw user query into a safe FTS5 MATCH
//! expression, supporting a whitelisted subset of FTS5 operators and the
//! trigram length filter.

use super::tokenizer::{QueryToken, tokenize_query};

/// Sanitize a raw user query for safe use in an FTS5 MATCH expression.
///
/// Supports a subset of FTS5 search operators so that users can write
/// queries like `"exact phrase"`, `cats NOT dogs`, or `cats OR dogs`.
///
/// ## Rules
///
/// 1. **Quoted phrases** — matched `"..."` in the input are kept as a single
///    FTS5 phrase token (internal `"` escaped by doubling). Quoted phrases
///    are *not* subject to the trigram length filter — the user explicitly
///    asked for them.
/// 2. **`NOT` operator** — preserved as the bare keyword when followed by at
///    least one more token. FTS5 `NOT` is a *binary* operator (`A NOT B`):
///    a standalone leading `NOT term` (no left operand) is an FTS5 syntax
///    error, surfaced as `AppError::Validation` by [`search_fts`]. We do not
///    rewrite it — `NOT` is meaningful only between two operands.
/// 3. **`OR` / `AND` operators** — preserved as bare keywords when they appear
///    between two other tokens.
/// 4. **Trigram length filter (I-Search-2)** — non-operator word tokens
///    shorter than 3 characters are dropped. The FTS5 table uses the
///    trigram tokenizer (migration `0006_fts5_trigram.sql`,
///    `tokenize = 'trigram case_sensitive 0'`); tokens with fewer than 3
///    characters cannot match anything in the index, so retaining them
///    would only AND-collapse the whole query to zero hits. The
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
pub(crate) fn sanitize_fts_query(query: &str) -> String {
    /// Trigram tokenizer minimum match length — see migration
    /// `0006_fts5_trigram.sql` (`tokenize = 'trigram case_sensitive 0'`).
    const TRIGRAM_MIN_LEN: usize = 3;
    // PEND-73 B3 — NFC-normalise the query before tokenisation so an
    // NFC query reaches the NFC-normalised FTS index emitted by
    // `strip_for_fts_with_maps`. Without this, NFD content (macOS
    // pastes, NFD-encoded filenames embedded in titles) becomes
    // invisible to NFC queries.
    let normalised = crate::fts::strip::nfc_normalise(query);
    let tokens = tokenize_query(&normalised);
    let len = tokens.len();
    let mut output_parts: Vec<String> = Vec::new();

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
                // #673 — a quoted phrase shorter than a trigram ("ab") emits
                // ZERO trigram tokens, so its `MATCH` clause returns no rows
                // and AND-collapses the whole query to nothing — the exact
                // silent failure the bare-word length filter exists to
                // prevent. The explicit-quoting "intent" bypass does not
                // rescue a phrase the index physically cannot represent, so
                // we drop it (with a warning) rather than letting it zero out
                // the query. `chars().count()` counts unicode scalars so a
                // 2-char CJK phrase is measured as 2.
                if trimmed.chars().count() < TRIGRAM_MIN_LEN {
                    tracing::warn!(
                        phrase = %trimmed,
                        "fts: dropping sub-trigram quoted phrase (< {TRIGRAM_MIN_LEN} chars); \
                         the trigram index cannot match it"
                    );
                    continue;
                }
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
                    // I-Search-2: drop sub-trigram tokens. `word.chars().count()`
                    // counts unicode scalars (so a 2-character CJK token is
                    // measured as 2, not by byte length).
                    if word.chars().count() < TRIGRAM_MIN_LEN {
                        continue;
                    }
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

    output_parts.join(" ")
}
