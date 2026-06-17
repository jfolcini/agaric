/**
 * Shared declarations for the markdown serialize/parse pair.
 *
 * This module exists so any helper, regex, or constant that needs to be
 * shared between `markdown-serialize.ts` and `markdown-parse.ts` has a
 * canonical home — without forcing either half to import the other.
 */

/** Word char per CommonMark flanking (Unicode letters + numbers). */
export const WORD_CHAR_RE = /[\p{L}\p{N}]/u
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

// -- Bare-URL autolink (#1441) ------------------------------------------------

/**
 * Schemes recognized for bare-URL autolinking on import/paste. Kept to the
 * web schemes the paste affordance accepts (`isValidHttpUrl` in
 * `extensions/external-link.ts` only allows http/https), so import and paste
 * agree on what becomes a link.
 */
const AUTOLINK_SCHEME_RE = /^https?:\/\//i

/**
 * Characters that, when trailing a bare URL, are trimmed off the link and left
 * as literal text. Two groups:
 *
 * - GFM sentence punctuation (`.,;:!?'"`) — the `.` ending a sentence
 *   (`see https://x.com.`) reads as prose, not part of the URL.
 * - This editor's inline-mark / block delimiters (`*` `_` `~` `=` `` ` `` `|`
 *   `]`) — a URL that abuts closing markup (`**https://x.com**`,
 *   ``https://x.com` ``) must NOT swallow the delimiter into its href, or the
 *   surrounding mark span (bold/strike/highlight/code/table/link-label) never
 *   closes and is reverted to literal text (#1441 regression: the bare-URL body
 *   only hard-stops at whitespace and `<`, so without trimming these the URL
 *   greedily eats trailing `**`/`` ` ``/etc.). Only a TRAILING run is trimmed,
 *   so interior delimiters (`…/Foo_(bar)`, `…/a*b`) are preserved, matching GFM.
 *
 * A trailing `)` is handled separately (balanced-paren aware) so
 * `https://en.wikipedia.org/wiki/Foo_(bar)` keeps its closing paren.
 */
const TRAILING_TRIM_RE = /[.,;:!?'"*_~=`|\]]/

/**
 * Scan a bare `http(s)://…` URL starting at `src[pos]`. Returns the exclusive
 * end index of the URL (after GFM trailing-punctuation trimming) or -1 if no
 * URL begins at `pos`.
 *
 * Boundary rules (a reasonable subset of GFM autolink):
 * - Must start with `http://` or `https://` (case-insensitive).
 * - The URL body runs up to the first whitespace, `<` (so a `<…>`
 *   angle-autolink's closing bracket terminates the body), or `\` (the escape
 *   char — never part of a bare URL).
 * - Trailing `.,;:!?'"` (sentence punctuation) and `*_~=`|]` (this editor's
 *   inline-mark / block delimiters) are trimmed off the tail (see
 *   `TRAILING_TRIM_RE`), so a URL abutting closing markup does not swallow it.
 * - A trailing `)` is trimmed only when the URL contains more `)` than `(`
 *   (unbalanced) — Wikipedia-style parenthesized paths keep their paren.
 *
 * Left-boundary checks (e.g. not autolinking `ahttps://…`) are the caller's
 * responsibility, since they depend on the surrounding parse context.
 */
export function scanBareUrl(src: string, pos: number): number {
  if (!AUTOLINK_SCHEME_RE.test(src.slice(pos, pos + 8))) return -1
  // Advance to the end of the URL body. Hard stops: whitespace, `<` (a
  // `<…>` angle-autolink's closing context), and `\` (the Markdown escape
  // char — a bare URL never contains one, and stopping here keeps a URL that
  // abuts a backslash-escaped delimiter, e.g. the serializer's `https://x.com\|`
  // for a trimmed trailing `|`, from re-globbing the `\…` into the href on
  // reparse, which would break serialize∘parse idempotence).
  let end = pos
  while (end < src.length) {
    const c = src[end] as string
    if (WS_RE.test(c) || c === '<' || c === '\\') break
    end++
  }
  // Reject a bare scheme with no host (`https://` then a boundary).
  const schemeEnd = src.slice(pos, end).toLowerCase().indexOf('://') + 3 + pos
  if (end <= schemeEnd) return -1

  // GFM trailing-punctuation trim (iterative: `https://x.com).` drops both).
  let trimmed = true
  while (trimmed && end > schemeEnd) {
    trimmed = false
    const last = src[end - 1] as string
    if (TRAILING_TRIM_RE.test(last)) {
      end--
      trimmed = true
      continue
    }
    if (last === ')') {
      const body = src.slice(pos, end)
      const opens = (body.match(/\(/g) ?? []).length
      const closes = (body.match(/\)/g) ?? []).length
      if (closes > opens) {
        end--
        trimmed = true
      }
    }
  }
  return end > schemeEnd ? end : -1
}

/**
 * True when `url` is exactly a bare-autolinkable URL — i.e. `scanBareUrl`
 * consumes the whole string with no trailing trim. The serializer uses this to
 * decide whether a link whose text === href can be emitted as a bare URL
 * (lossless, GFM) rather than `[url](url)` (#1441).
 */
export function isAutolinkableUrl(url: string): boolean {
  return scanBareUrl(url, 0) === url.length
}
