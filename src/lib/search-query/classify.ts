/**
 * PEND-54 — Classifier: raw tokens → `SearchQueryAST`.
 *
 * Each raw token is asked to match a registered prefix (`tag:`,
 * `path:`, `not-path:` for this plan; PEND-53 will add more). Bare
 * `#tag` is recognised as the tag alias.
 *
 * Tokens we don't recognise fall through to free-text and are
 * concatenated (preserving their original whitespace where possible)
 * into the FTS5 query string.
 *
 * The classifier is deterministic — same input string always yields
 * the same AST. The chip key (`tokenKey` in `./types.ts`) is
 * stable across input edits in the middle of the query.
 */

import { ensureRegistered } from './register'
import { looksLikeUnknownPrefix, recognise } from './registry'
import { type RawToken, tokenize } from './tokenize'
import type { FilterToken, SearchQueryAST } from './types'

/**
 * Parse a full search query string into the AST.
 *
 * Side-effect-free. Cheap enough for `useMemo(parse, [query])` on
 * every keystroke.
 */
export function parse(input: string): SearchQueryAST {
  ensureRegistered()
  const raw = tokenize(input)
  return classify(raw, input)
}

/** Lower-level entry: classify a pre-tokenised stream. */
export function classify(tokens: RawToken[], input: string): SearchQueryAST {
  const filters: FilterToken[] = []
  // Track the spans we "consumed" as filters so we can reconstruct
  // free-text by stripping them out of the original input.
  const consumedSpans: Array<[number, number]> = []

  for (const tok of tokens) {
    if (tok.kind === 'quoted') {
      // Quoted phrases pass through to free-text verbatim.
      continue
    }
    const matched = recognise(tok.text, tok.span)
    if (matched) {
      filters.push(matched)
      consumedSpans.push(tok.span)
      continue
    }
    // Bare `#tag` alias.
    if (tok.text.startsWith('#') && tok.text.length > 1) {
      const value = tok.text.slice(1)
      filters.push({ kind: 'tag', value, span: tok.span })
      consumedSpans.push(tok.span)
      continue
    }
    // Token shaped like `xxx:yyy` but unregistered → invalid chip.
    // DSL-10: `looksLikeUnknownPrefix` returns null for `key://…`
    // (pasted URLs), so those fall through to free-text below instead of
    // being consumed as an invalid chip and silently dropped.
    const unk = looksLikeUnknownPrefix(tok.text)
    if (unk) {
      filters.push({
        kind: 'invalid',
        source: tok.text,
        error: `unknown filter key '${unk.key}:'`,
        span: tok.span,
      })
      consumedSpans.push(tok.span)
    }
    // Everything else is free-text.
  }

  const freeText = stripSpans(input, consumedSpans).trim().replace(/\s+/g, ' ')
  return { filters, freeText }
}

/** Remove the given spans from `input` and return the surviving text. */
function stripSpans(input: string, spans: Array<[number, number]>): string {
  if (spans.length === 0) return input
  // Sort by start ascending — the tokeniser already emits in order,
  // but be defensive.
  const ordered = [...spans].sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  for (const [s, e] of ordered) {
    if (s > cursor) out += input.slice(cursor, s)
    cursor = e
  }
  if (cursor < input.length) out += input.slice(cursor)
  return out
}
