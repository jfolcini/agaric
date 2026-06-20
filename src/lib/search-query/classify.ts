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
    // `looksLikeUnknownPrefix` returns null for `key://…`
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

  // Only the LAST due:/scheduled: token reaches the backend
  // (see astToFilterProjection's "last wins"). Flag the earlier,
  // shadowed tokens as invalid so the rendered chips agree with the
  // effective query instead of showing filters that silently don't apply.
  for (const kind of ['due', 'scheduled'] as const) {
    const indices: number[] = []
    for (let i = 0; i < filters.length; i++) {
      if (filters[i]?.kind === kind) indices.push(i)
    }
    if (indices.length > 1) {
      for (const i of indices.slice(0, -1)) {
        const shadowed = filters[i]
        if (!shadowed) continue
        filters[i] = {
          kind: 'invalid',
          source: input.slice(shadowed.span[0], shadowed.span[1]),
          error: `shadowed by a later ${kind}: — only the last ${kind}: filter applies`,
          span: shadowed.span,
        }
      }
    }
  }

  const freeText = buildFreeText(input, consumedSpans, quotedSpans)
  return { filters, freeText }
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
function buildFreeText(
  input: string,
  consumed: Array<[number, number]>,
  quoted: Array<[number, number]>,
): string {
  // Sort defensively — the tokeniser emits in order, but don't rely on it.
  const consumedOrdered = [...consumed].sort((a, b) => a[0] - b[0])
  const quotedOrdered = [...quoted].sort((a, b) => a[0] - b[0])

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
    if (qs > pos) out += stripped.slice(pos, qs).replace(/\s+/g, ' ')
    out += stripped.slice(qs, qe)
    pos = qe
  }
  if (pos < stripped.length) out += stripped.slice(pos).replace(/\s+/g, ' ')

  return out.trim()
}
