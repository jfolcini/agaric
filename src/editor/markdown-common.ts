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
 * Uppercase ULID (26 chars) — the payload shape of the `#[ULID]`, `[[ULID]]`
 * and `((ULID))` ref tokens. Shared: the parser recognizes the tokens with it
 * (`tryConsumeToken`), and the serializer uses it to escape a LITERAL
 * `((ULID))` in text so it cannot resurrect as a live block_ref on reparse.
 */
export const ULID_RE = /^[0-9A-Z]{26}$/

/**
 * Indentation of ONE list-nesting level (#1513). Shared because the two halves
 * must agree exactly: the serializer prefixes every non-leading child of a list
 * item with it, and the parser recognizes a nested block by it and dedents by
 * exactly ONE level of it per recursion step. Two spaces is the `- ` marker
 * width.
 *
 * The dedent is measured from the ITEM'S OWN MARKER, not from column 0:
 * `collectListItem` (`markdown-parse/parser.ts`) strips
 * `leadingIndent(markerLine) + LIST_NEST_INDENT.length` columns, which is 2 for
 * our own output but 3 or 5 for a foreign marker carrying 1 or 3 spaces of the
 * CommonMark marker-indent tolerance (`MAX_MARKER_INDENT`) — i.e. the content
 * column, not a whole multiple of this width. Measuring from column 0 instead
 * would make a sibling of an over-indented list (`  - a` / `  - b`) look like a
 * child of its own sibling.
 *
 * The width is also the THRESHOLD: a line indented by less than one whole level
 * is NOT nested content, it is a sibling block whose own text happens to start
 * with a space (#4019). Treating any non-zero indent as nesting re-parented
 * such a paragraph into the preceding item and re-emitted it at this width, so
 * serialize→parse→serialize drifted from one space to two.
 */
export const LIST_NEST_INDENT = '  '

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
 * A missing neighbor (the run touches the start or end of `src`) is a hard
 * boundary: start-of-line counts as "not a word char" and end-of-line as
 * whitespace, so a run at end-of-line cannot open.
 *
 * This is the PARSER's rule, evaluated on a full line. The serializer cannot
 * use it — it escapes one text NODE at a time and does not know the line — so
 * it has its own, deliberately coarser rule: `underscoreNeedsEscape`.
 */
export function underscoreRunFlank(
  src: string,
  pos: number,
): { canOpen: boolean; canClose: boolean } {
  const { before, after } = underscoreRunEdges(src, pos)
  const beforeWord = before !== null && WORD_CHAR_RE.test(before)
  const afterWord = after !== null && WORD_CHAR_RE.test(after)
  const beforeWs = before === null || WS_RE.test(before)
  const afterWs = after === null || WS_RE.test(after)
  return { canOpen: !beforeWord && !afterWs, canClose: !beforeWs && !afterWord }
}

/** The chars flanking the contiguous `_` run containing `pos` (`null` at an edge). */
function underscoreRunEdges(
  src: string,
  pos: number,
): { before: string | null; after: string | null } {
  let start = pos
  while (start > 0 && src[start - 1] === '_') start--
  let end = pos
  while (end < src.length && src[end] === '_') end++
  return {
    before: start > 0 ? (src[start - 1] as string) : null,
    after: end < src.length ? (src[end] as string) : null,
  }
}

/**
 * The SERIALIZER's escape rule for the `_` run containing `pos` of a single
 * text node's text (#710-1): escape unless the run is INTRAWORD, i.e. has a
 * word char on both sides. `snake_case` and `a__b__c` stay readable; everything
 * else gets `\_`.
 *
 * Why not `underscoreRunFlank` (#4049). The serializer escapes per NODE, but
 * the parser decides per LINE, and the round trip moves text between the two:
 *
 *  - `collectListItem` absorbs a two-space-indented sibling paragraph into the
 *    preceding list item and re-emits it DEDENTED, so a leading `_` goes from
 *    "preceded by a space" to "at the start of the node";
 *  - a table cell TRIMS its edge whitespace, so a trailing `_ ` becomes `_`;
 *  - a hardBreak inside a table cell degrades to a space and the neighbouring
 *    text nodes coalesce, so `text('_') · hardBreak · text('a')` becomes the
 *    single node `_ a`;
 *  - a node edge abuts the previous/next node's mark delimiter, which is
 *    punctuation, not the whitespace an edge looks like in isolation.
 *
 * A rule that distinguishes whitespace from a string edge, or an edge from
 * punctuation, therefore gives DIFFERENT verdicts for the same rendered line
 * before and after a round trip — the serialize→parse→serialize fixpoint
 * breaks and the stored document grows or loses a backslash on every
 * open/close cycle. Word-ness is the only property all four transformations
 * preserve: whitespace, string edges and punctuation are all "not a word
 * char", so this rule is invariant under every one of them.
 *
 * The rule is strictly STRONGER than the parser's, and the PROOF is the one
 * line of algebra below — nothing here rests on enumeration. This rule escapes
 * iff `!(word(before) && word(after))`; `canOpen` requires `!word(before)` and
 * `canClose` requires `!word(after)`, so `canOpen || canClose` implies
 * `!word(before) || !word(after)`, which is exactly the escape condition.
 * Hence every run the parser could treat as a delimiter is escaped and no
 * emphasis delimiter can leak into stored text. The neighbour table in
 * `markdown-serializer.test.ts` ("escapes a superset of what the parser can
 * treat as a delimiter") only SAMPLES that implication on a handful of
 * neighbour chars — it is a check on the algebra, not a completeness
 * guarantee, so re-derive the implication above when touching either rule.
 *
 * The rule over-escapes only the whitespace-on-both-sides case
 * (`a _ b` → `a \_ b`), which is lossless. `underscoreRunFlank` is the exact
 * rule and stays the parser's.
 *
 * ONE-TIME CONTENT MIGRATION. Existing stored notes containing a
 * whitespace-flanked `_` were written under the old serializer rule, which left
 * it bare; they serialize differently now, so `computeContentDelta` emits a
 * rewrite for each of them on the first open/blur after this ships. That is a
 * real bulk diff over existing content, but it happens exactly once and is
 * lossless: `\_` reparses to `_` and re-escapes to `\_`, so the second
 * serialize is byte-identical and the note never rewrites again. Pinned by
 * "a pre-existing `a _ b` note migrates ONCE, then is byte-stable" in
 * `markdown-serializer.test.ts`.
 */
export function underscoreNeedsEscape(src: string, pos: number): boolean {
  const { before, after } = underscoreRunEdges(src, pos)
  const beforeWord = before !== null && WORD_CHAR_RE.test(before)
  const afterWord = after !== null && WORD_CHAR_RE.test(after)
  return !(beforeWord && afterWord)
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
