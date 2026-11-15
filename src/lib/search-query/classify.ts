/**
 * Classifier: raw tokens → `SearchQueryAST`.
 *
 * Each raw token is asked to match a registered prefix (`tag:`,
 * `path:`, `not-path:` for this plan; will add more). Bare
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

import {
  buildFreeText,
  classifyWord,
  flagShadowedDates,
  flagTagBesideUnder,
  isOrWord,
} from '@/lib/search-query/classify-word'
import { classifyOr } from '@/lib/search-query/or-query'
import { ensureRegistered } from '@/lib/search-query/register'
import { type RawToken, tokenize } from '@/lib/search-query/tokenize'
import type { FilterToken, SearchQueryAST } from '@/lib/search-query/types'

/**
 * Parse a full search query string into the AST.
 *
 * Side-effect-free. Cheap enough for `useMemo(parse, [query])` on
 * every keystroke.
 */
export function parse(input: string): SearchQueryAST {
  ensureRegistered()
  // `OR` and parentheses are grammar only in a query holding the word `OR`
  // (any case, as FTS5 reads it); every other query parses as it always has.
  const grouped = tokenize(input, true)
  if (grouped.some(isOrWord)) return classifyOr(grouped, input)
  return classify(tokenize(input), input)
}

/**
 * Lower-level entry: classify a pre-tokenised stream.
 *
 * `classify` is exported and directly callable, so unlike `parse` it does not
 * get to assume its `tokens` came from `tokenize`. Token spans that run past
 * `input.length` are therefore TOLERATED, not trusted: `buildFreeText`'s
 * `if (cursor < input.length)` guard in `buildFreeText` is what stops an out-of-range
 * consumed span from calling `append(from, to)` with `from > to`, which would
 * invert the quoted-span arithmetic and duplicate the free-text tail. Do not
 * "tighten" or drop that guard — it is a defensive contract, pinned by the
 * "does not duplicate the tail when a consumed span runs past the end of the
 * input" test, whose fixture looks contrived precisely because `tokenize` can
 * never emit it.
 */
export function classify(tokens: RawToken[], input: string): SearchQueryAST {
  const filters: FilterToken[] = []
  // Track the spans we "consumed" as filters so we can reconstruct
  // free-text by stripping them out of the original input.
  const consumedSpans: Array<[number, number]> = []
  // Track quoted phrase spans so the free-text whitespace
  // collapse can skip over them. A quoted phrase is matched exactly,
  // so internal runs of whitespace MUST survive verbatim.
  const quotedSpans: Array<[number, number]> = []

  for (const tok of tokens) {
    if (tok.kind === 'quoted') {
      // Quoted phrases pass through to free-text verbatim.
      quotedSpans.push(tok.span)
      continue
    }
    const matched = classifyWord(tok)
    if (matched) {
      filters.push(matched)
      consumedSpans.push(tok.span)
    }
    // Everything else is free-text.
  }

  flagShadowedDates(filters, input, filters.keys())
  flagTagBesideUnder(filters, input)

  const freeText = buildFreeText(input, consumedSpans, quotedSpans)
  return { filters, freeText }
}
