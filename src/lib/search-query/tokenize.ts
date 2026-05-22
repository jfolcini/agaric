/**
 * PEND-54 — Tokeniser for the inline search filter syntax.
 *
 * Walks the input one character at a time and emits raw lexical
 * tokens. The classifier (`classify.ts`) is responsible for mapping
 * each raw token to a `FilterToken` (or to free-text).
 *
 * Quoting / boolean operator behaviour is preserved verbatim from
 * `src-tauri/src/fts/search.rs::tokenize_query` so the parser doesn't
 * accidentally pre-process FTS5 syntax.
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
 * - Quotes inside a word (e.g. `say"hello`) are kept as part of the
 *   word — they do not start a new phrase.
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
      // DSL-1 — find a *closing* `"` that sits at a token boundary
      // (followed by whitespace or end-of-input). A `"` glued to more
      // text (e.g. `"a"b`) is not a clean phrase close, so we keep
      // scanning; if none qualifies, fall through to word-handling so
      // the stray quote degrades to a word instead of fragmenting the
      // rest of the query into a phantom phrase.
      let close = input.indexOf('"', i + 1)
      while (close !== -1) {
        const after = input[close + 1]
        if (
          after === undefined ||
          after === ' ' ||
          after === '\t' ||
          after === '\n' ||
          after === '\r'
        ) {
          break
        }
        close = input.indexOf('"', close + 1)
      }
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
    // Word: consume until whitespace.
    while (i < n) {
      const c = input[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break
      i++
    }
    tokens.push({ kind: 'word', text: input.slice(start, i), span: [start, i] })
  }
  return tokens
}
