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

import { t } from '@/lib/i18n'
import { classifyOr } from '@/lib/search-query/or-query'
import { ensureRegistered } from '@/lib/search-query/register'
import { looksLikeUnknownPrefix, recognise } from '@/lib/search-query/registry'
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

/** Whether `tok` is the word `OR`, in any case. */
export function isOrWord(tok: RawToken): boolean {
  return tok.kind === 'word' && tok.text.toUpperCase() === 'OR'
}

/** The filter a word is, or `null` for a word of free text. */
export function classifyWord(tok: Extract<RawToken, { kind: 'word' }>): FilterToken | null {
  // A word whose `"` never closed is free text, never a chip: serialise
  // moves free text after the chips, where a boundary `"` would close
  // the chip's quote and swallow everything in between.
  if (tok.unclosedQuote) return null
  const matched = recognise(tok.text, tok.span)
  if (matched) return matched
  // Bare `#tag` alias: the `tag:` recogniser, so `#"my tag"` peels its
  // quotes exactly as `tag:#"my tag"` does and serialises back to it.
  if (tok.text.startsWith('#') && tok.text.length > 1) {
    const tag = recognise(`tag:${tok.text}`, tok.span)
    if (tag) return tag
  }
  // Token shaped like `xxx:yyy` but unregistered → invalid chip.
  // `looksLikeUnknownPrefix` returns null for `key://…`
  // (pasted URLs), so those fall through to free-text instead of
  // being consumed as an invalid chip and silently dropped.
  const unk = looksLikeUnknownPrefix(tok.text)
  if (unk) {
    return {
      kind: 'invalid',
      source: tok.text,
      error: `unknown filter key '${unk.key}:'`,
      span: tok.span,
    }
  }
  return null
}

/**
 * Only the LAST due:/scheduled: token of the filters at `indices` (one AND
 * run) applies (see astToFilterProjection's "last wins"). Flag the earlier,
 * shadowed tokens as invalid so the rendered chips agree with the
 * effective query instead of showing filters that silently don't apply.
 */
export function flagShadowedDates(
  filters: FilterToken[],
  input: string,
  indices: Iterable<number>,
): void {
  const run = [...indices]
  for (const kind of ['due', 'scheduled'] as const) {
    const last = run.findLast((i) => filters[i]?.kind === kind)
    for (const i of run) {
      const f = filters[i]
      if (f?.kind !== kind || i === last) continue
      filters[i] = {
        kind: 'invalid',
        source: input.slice(f.span[0], f.span[1]),
        error: `shadowed by a later ${kind}: — only the last ${kind}: filter applies`,
        span: f.span,
      }
    }
  }
}

/**
 * The backend widens every tag of a flat query at once
 * (`tags_match_inline_and_inherited`), so beside an `under:` a `tag:` chip
 * would silently match inherited tags too. Flag it instead.
 */
export function flagTagBesideUnder(filters: FilterToken[], input: string): void {
  if (!filters.some((f) => f.kind === 'under')) return
  filters.forEach((f, i) => {
    if (f.kind !== 'tag') return
    filters[i] = {
      kind: 'invalid',
      source: input.slice(f.span[0], f.span[1]),
      error: t('searchQuery.tagBesideUnder'),
      span: f.span,
    }
  })
}

/**
 * Reconstruct the free-text by removing the consumed (filter) spans from
 * `input`, then collapsing runs of whitespace — but ONLY outside quoted
 * phrases.
 *
 * Whitespace inside a `"…"` quoted span is preserved verbatim
 * because a quoted phrase is meant to match exactly; a global
 * `.replace(/\s+/g, ' ')` would silently rewrite the phrase. We walk the
 * surviving (non-consumed) text segment-by-segment against `input`,
 * collapsing only the segments that lie outside any quoted span.
 */
export function buildFreeText(
  input: string,
  consumed: Array<[number, number]>,
  quoted: Array<[number, number]>,
): string {
  // Sort defensively — the tokeniser emits in order, but don't rely on it.
  const consumedOrdered = [...consumed].toSorted((a, b) => a[0] - b[0])
  const quotedOrdered = [...quoted].toSorted((a, b) => a[0] - b[0])

  // First pass: strip the consumed (filter) spans, building the surviving
  // text AND mapping each quoted span into the *output* coordinate space so
  // the collapse pass below knows which output ranges to leave verbatim.
  let stripped = ''
  const quotedOut: Array<[number, number]> = []
  let qi = 0
  let cursor = 0

  // Append input[from, to) to `stripped`, recording any quoted spans that
  // fall in that range as output-coordinate ranges.
  const append = (from: number, to: number) => {
    while (qi < quotedOrdered.length && (quotedOrdered[qi]?.[1] ?? 0) <= from) {
      qi++
    }
    let q = quotedOrdered[qi]
    while (q && q[0] < to) {
      const qs = Math.max(q[0], from)
      const qe = Math.min(q[1], to)
      const base = stripped.length + (qs - from)
      quotedOut.push([base, base + (qe - qs)])
      if (q[1] <= to) {
        qi++
        q = quotedOrdered[qi]
      } else {
        break
      }
    }
    stripped += input.slice(from, to)
  }

  for (const [s, e] of consumedOrdered) {
    if (s > cursor) append(cursor, s)
    cursor = Math.max(cursor, e)
  }
  if (cursor < input.length) append(cursor, input.length)

  // Second pass: collapse runs of whitespace, but copy quoted ranges
  // Verbatim so intra-phrase whitespace survives.
  let out = ''
  let pos = 0
  for (const [qs, qe] of quotedOut) {
    out += stripped.slice(pos, qs).replace(/\s+/g, ' ')
    out += stripped.slice(qs, qe)
    pos = qe
  }
  out += stripped.slice(pos).replace(/\s+/g, ' ')

  return out.trim()
}
