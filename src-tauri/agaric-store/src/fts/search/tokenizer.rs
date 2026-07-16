//! Query tokenizer: splits a raw query string into quoted phrases and
//! whitespace-delimited words, the input shape consumed by the sanitizer.

/// Token types produced by [`tokenize_query`].
pub(super) enum QueryToken {
    /// A double-quoted phrase (content between matched quotes, without the
    /// surrounding quote characters).
    QuotedPhrase(String),
    /// A single unquoted word (whitespace-delimited).
    Word(String),
}

/// Tokenize a raw query string, respecting double-quoted phrases.
///
/// A `"` that appears at the start of a new token (i.e. after whitespace or at
/// the beginning of the string) opens a quoted phrase that extends until the
/// next `"`.  If no closing quote is found, the content is split on whitespace
/// and emitted as individual [`QueryToken::Word`] tokens (graceful fallback for
/// unmatched quotes).
///
/// Quotes that appear *inside* an unquoted word (e.g. `say"hello`) are kept as
/// part of the word — they do **not** start a new quoted phrase.
pub(super) fn tokenize_query(input: &str) -> Vec<QueryToken> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(&ch) = chars.peek() {
        if ch.is_whitespace() {
            chars.next();
            continue;
        }

        if ch == '"' {
            // Opening quote at token boundary — start a quoted phrase.
            chars.next(); // consume opening "
            let mut phrase = String::new();
            let mut found_close = false;

            while let Some(&inner) = chars.peek() {
                if inner == '"' {
                    chars.next(); // consume closing "
                    found_close = true;
                    break;
                }
                phrase.push(inner);
                chars.next();
            }

            if found_close {
                tokens.push(QueryToken::QuotedPhrase(phrase));
            } else {
                // Unmatched quote — treat contents as individual words.
                for word in phrase.split_whitespace() {
                    tokens.push(QueryToken::Word(word.to_string()));
                }
            }
        } else {
            // Unquoted word — read until whitespace.
            let mut word = String::new();
            while let Some(&wch) = chars.peek() {
                if wch.is_whitespace() {
                    break;
                }
                word.push(wch);
                chars.next();
            }
            if !word.is_empty() {
                tokens.push(QueryToken::Word(word));
            }
        }
    }

    tokens
}
