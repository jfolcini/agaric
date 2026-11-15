/**
 * The pieces of classification both readings of a query share: the flat one
 * (`classify.ts`) and the OR grammar (`or-query.ts`). Kept apart from both so
 * neither imports the other's module.
 */

import { t } from '@/lib/i18n'
import { looksLikeUnknownPrefix, recognise } from '@/lib/search-query/registry'
import type { RawToken } from '@/lib/search-query/tokenize'
import type { FilterToken } from '@/lib/search-query/types'

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
  // A `#` word is never an unknown `key:`, so one that is no tag is free text.
  if (tok.text.startsWith('#') && tok.text.length > 1) return recognise(`tag:${tok.text}`, tok.span)
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
