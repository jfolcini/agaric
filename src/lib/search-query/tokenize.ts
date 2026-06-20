/**
 * Tokeniser for the inline search filter syntax.
 *
 * Walks the input one character at a time and emits raw lexical
 * tokens. The classifier (`classify.ts`) is responsible for mapping
 * each raw token to a `FilterToken` (or to free-text).
 *
 * Quoting / boolean operator behaviour started as a port of
 * `src-tauri/src/fts/search.rs::tokenize_query` (so the parser doesn't
 * Accidentally pre-process FTS5 syntax), but deliberately diverges
 * on the closing-quote rule: this tokeniser is boundary-aware (a quote
 * only closes at a token boundary) because it drives chip projection +
 * caret autocomplete, whereas the Rust `tokenize_query` closes on the
 * first `"` (it only builds the FTS5 query string). The two roles differ,
 * so the divergence is intentional — do not "re-sync" them.
 */

/** A raw lexical token. */
export type RawToken =
  | { kind: 'word'; text: string; span: [number, number] }
  | { kind: 'quoted'; text: string; span: [number, number] }

/**
 * Split `input` into whitespace-delimited words and `"…"`-quoted
 * phrases. Whitespace is dropped; everything else is preserved.
 *
 * - A `"` at a token boundary opens a quoted phrase that extends until
 *   the next `"` (verbatim, including any internal whitespace). If no
 *   closing quote is found, the open quote is treated as part of the
 *   word that follows.
 * - A `"` mid-word (e.g. `prop:key="value with spaces"`) opens a
 *   phrase that extends across whitespace until a matching `"` at a
 *   token boundary — that lets prefix-glued quoted values survive as a
 *   single word for the classifier to parse (#152). If no matching
 *   close exists, the `"` is kept as a literal and the word ends at
 *   the next whitespace (e.g. `say"hello` still tokenises as one word).
 *
 * Spans are `[startCol, endCol)` over the original input in UTF-16
 * code units (compatible with `string.length`). The quote characters
 * are INCLUDED in the span of a `quoted` token so chip projection can
 * faithfully re-insert them on serialise.
 */
export function tokenize(input: string): RawToken[] {
  const tokens: RawToken[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    const ch = input[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    const start = i
    if (ch === '"') {
      // Find a *closing* `"` that sits at a token boundary
      // (followed by whitespace or end-of-input). A `"` glued to more
      // text (e.g. `"a"b`) is not a clean phrase close, so we keep
      // scanning; if none qualifies, fall through to word-handling so
      // the stray quote degrades to a word instead of fragmenting the
      // rest of the query into a phantom phrase.
      const close = findCloseAtBoundary(input, i)
      if (close !== -1) {
        tokens.push({
          kind: 'quoted',
          text: input.slice(i, close + 1),
          span: [start, close + 1],
        })
        i = close + 1
        continue
      }
      // Unmatched quote — degrade to word.
    }
    // Word: consume until whitespace. A mid-word `"` (#152) opens an
    // embedded phrase that extends through whitespace until a matching
    // `"` at a token boundary, so `prop:key="v with spaces"` survives
    // as a single word.
    while (i < n) {
      const c = input[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break
      if (c === '"' && i > start) {
        const close = findCloseAtBoundary(input, i)
        if (close !== -1) {
          i = close + 1
          continue
        }
      }
      i++
    }
    tokens.push({ kind: 'word', text: input.slice(start, i), span: [start, i] })
  }
  return tokens
}

/**
 * Given an opening `"` at index `open`, find the index of a matching
 * close `"` that sits at a token boundary (followed by whitespace or
 * end-of-input). Returns `-1` if no qualifying close exists.
 */
function findCloseAtBoundary(input: string, open: number): number {
  let close = input.indexOf('"', open + 1)
  while (close !== -1) {
    const after = input[close + 1]
    if (
      after === undefined ||
      after === ' ' ||
      after === '\t' ||
      after === '\n' ||
      after === '\r'
    ) {
      return close
    }
    close = input.indexOf('"', close + 1)
  }
  return -1
}
