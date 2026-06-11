/**
 * Shared declarations for the markdown serialize/parse pair.
 *
 * This module exists so any helper, regex, or constant that needs to be
 * shared between `markdown-serialize.ts` and `markdown-parse.ts` has a
 * canonical home — without forcing either half to import the other.
 */

/** Word char per CommonMark flanking (Unicode letters + numbers). */
const WORD_CHAR_RE = /[\p{L}\p{N}]/u
const WS_RE = /\s/

/**
 * CommonMark-aligned flanking test for the contiguous `_` run containing
 * position `pos` of `src`. The flanking chars are taken from the FULL run in
 * both directions — `pos` may sit mid-run — so the rule always sees the run's
 * outer edges, never an inner `_`.
 *
 * The run can OPEN only when the char immediately before it is not a word
 * char AND the char after the run is not whitespace. It can CLOSE only when
 * the char before is not whitespace AND the char after is not a word char.
 * A run that is neither — e.g. `_`/`__` flanked by word chars on both sides
 * (`snake_case`, `a__b__c`) — is literal text.
 *
 * `edges` controls how a missing neighbor (run touching the start/end of
 * `src`) is treated:
 *
 * - `'line'` — `src` is a full line: a missing neighbor is a hard boundary
 *   (line start counts as "not a word char", line end as "absent": a run at
 *   end-of-line cannot open). Used by the parser.
 * - `'unknown'` — `src` is a single text NODE that may be concatenated with
 *   neighboring marked nodes: a missing neighbor could be anything, so
 *   assume whichever value makes the run a delimiter (pessimistic). Used by
 *   the serializer's escape decision (#710-1) so a `_` at a node edge is
 *   escaped rather than risking re-parse as emphasis after concatenation.
 */
export function underscoreRunFlank(
  src: string,
  pos: number,
  edges: 'line' | 'unknown' = 'line',
): { canOpen: boolean; canClose: boolean } {
  let start = pos
  while (start > 0 && src[start - 1] === '_') start--
  let end = pos
  while (end < src.length && src[end] === '_') end++
  const before = start > 0 ? (src[start - 1] as string) : null
  const after = end < src.length ? (src[end] as string) : null
  if (edges === 'unknown') {
    const canOpen =
      (before === null || !WORD_CHAR_RE.test(before)) && (after === null || !WS_RE.test(after))
    const canClose =
      (before === null || !WS_RE.test(before)) && (after === null || !WORD_CHAR_RE.test(after))
    return { canOpen, canClose }
  }
  const beforeWord = before !== null && WORD_CHAR_RE.test(before)
  const afterWord = after !== null && WORD_CHAR_RE.test(after)
  const beforeWs = before === null || WS_RE.test(before)
  const afterWs = after === null || WS_RE.test(after)
  const canOpen = !beforeWord && after !== null && !afterWs
  const canClose = before !== null && !beforeWs && !afterWord
  return { canOpen, canClose }
}
