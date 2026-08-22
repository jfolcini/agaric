/**
 * The resolve-store block title — one owner, one shape.
 *
 * #4228 — three call sites feed block content into the shared resolve
 * store (`@/stores/resolve`) as a block id's `title`:
 *   - `searchBlockRefs` in `@/components/block-tree/use-block-resolve.ts`
 *   - `fetchAndCacheLinks` in `@/components/block-tree/use-block-link-resolve.ts`
 *   - `handleNavigate` in `@/components/block-tree/use-block-navigate-to-link.ts`
 *
 * Before this module existed each one computed its own value — full raw
 * content, `.slice(0, 60)`, `.slice(0, 60)` — so `batchSet` / `set`'s
 * diff-on-value guard (`@/stores/resolve.ts`) saw three different byte
 * strings for the same id and treated whichever write landed last as "the"
 * title, bumping `version` (and re-rendering every version-subscribed
 * consumer) every time the seeders disagreed. The two block-ref renderers
 * (`renderBlockRef` and the TipTap `BlockRef` NodeView,
 * `@/editor/extensions/block-ref.ts`) then EACH re-derived their own
 * first-line/cap from whatever landed in the cache, so the same stored
 * title could also render two different ways depending which renderer read
 * it — and a title whose first line was empty (content starting with
 * `"\n"`) rendered as a blank chip, because neither renderer applied the
 * placeholder substitution the picker row already had (#4190/#4222).
 *
 * This module is the single owner of what the stored title IS. All three
 * seed call sites above call {@link normalizeBlockRefTitle} and write its
 * result verbatim; both renderers render the stored value verbatim — there
 * is no per-renderer split/cap left to disagree with the seed or with each
 * other.
 */

import { t as translate } from '@/lib/i18n'

/**
 * The cap `renderBlockRef` used to enforce locally before #4228 (and the
 * length the two `.slice(0, 60)` seeders already agreed on independently).
 * Kept as the shared constant so the seed and any future consumer stay in
 * sync by construction instead of by two functions carrying the same
 * magic number.
 */
const TITLE_MAX_LEN = 60

/**
 * #4153/#4190 — shared "what does the user see for this title"
 * normalisation: a `null` or whitespace-only value (untrimmed content can
 * still hold real text around the whitespace, e.g. `'  foo  '`, so this is
 * a TRIMMED-empty test, not `=== ''`) becomes the localized "Untitled"
 * placeholder; anything else passes through unchanged.
 */
export function untitledOr(title: string | null): string {
  return title === null || title.trim() === '' ? translate('block.untitled') : title
}

/**
 * First line of `content`, Untitled-substituted if that first line is
 * blank or `content` is null. Content starting with `"\n"` — a real block
 * with real text on its second line — has an EMPTY first line, so this
 * (deliberately, per the #4228 issue and the `((` picker row it already
 * matches) resolves to "Untitled", not to the second line's text: a chip
 * shows one line, and there's no non-blank candidate on that line.
 */
export function blockFirstLineOr(content: string | null): string {
  // Split on \n and strip a trailing \r: CRLF content would otherwise leave
  // the carriage return on the stored title, and since #4228 that title is
  // PERSISTED and read by every consumer — including the aria-label a screen
  // reader announces — rather than feeding one picker label.
  return untitledOr(content?.split('\n')[0]?.replace(/\r$/, '') ?? null)
}

/**
 * `s.slice(0, n)` cuts on a UTF-16 CODE UNIT boundary, so when index `n-1`
 * lands on the HIGH half of a surrogate pair (any astral character — emoji,
 * most CJK extension ideographs, musical symbols) the slice keeps an
 * unpaired high surrogate. That is not a rendering nicety: an unpaired
 * surrogate is not valid Unicode, serialises to U+FFFD (`EF BF BD`), and
 * shows the user a literal replacement box at the end of the title.
 *
 * Before #4228 this only ever existed transiently, recomputed per render
 * inside `renderBlockRef`. Now the capped string is what gets STORED, so
 * one bad cut is persisted and re-read by every consumer of the title —
 * the chip, its hover tooltip, the deleted `aria-label`, `BlockZoomBar`'s
 * breadcrumb, `resolveBlockDisplay`'s query-result row. Drop the orphan.
 *
 * Deliberately narrow: this repairs an INVALID string, it does not attempt
 * grapheme-cluster segmentation. A cut through a combining mark or a ZWJ
 * emoji sequence still degrades the glyph, but the result is valid Unicode
 * and renders as readable text, so it stays out of scope here (and out of
 * `Intl.Segmenter`, which would change the cap's meaning from code units
 * to graphemes and with it every stored title's length).
 */
function sliceWithoutOrphanSurrogate(s: string, end: number): string {
  const cut = s.slice(0, end)
  const last = cut.charCodeAt(cut.length - 1)
  // 0xD800–0xDBFF is the high-surrogate range; a high surrogate at the very
  // end of the cut means its low half was left behind on the other side.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/**
 * The canonical resolve-store block title: first line only, Untitled-
 * substituted, capped to {@link TITLE_MAX_LEN} chars. Apply this ONCE at
 * every seed call site — see the module docblock above for why "once, at
 * the seed" (not at render) is load-bearing.
 */
export function normalizeBlockRefTitle(content: string | null): string {
  const firstLine = blockFirstLineOr(content)
  return firstLine.length > TITLE_MAX_LEN
    ? `${sliceWithoutOrphanSurrogate(firstLine, TITLE_MAX_LEN - 3)}...`
    : firstLine
}
