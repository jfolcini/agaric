/**
 * The resolve-store title — one owner, one shape.
 *
 * #4228 — the shared resolve store (`@/stores/resolve`) holds ONE
 * `{ title, deleted }` per `${spaceId}::${ulid}`, and `set` / `batchSet`
 * diff on the title's BYTES. So every writer that can reach the same id has
 * to compute the same string, or the last writer wins, `version` bumps, and
 * every version-subscribed consumer re-renders — for a value that did not
 * really change. Three successive reviews of #4239 each found one more
 * writer that had drifted, so the enumeration is written down here and
 * pinned by a test (`resolve-store-title-seed-parity.test.ts`, which reads
 * this source tree and fails on an unregistered writer).
 *
 * ## The invariant
 *
 * `block_type` decides the shape, and {@link resolveStoreTitle} is the ONLY
 * place that decision is made:
 *
 *   - `content` → {@link normalizeBlockRefTitle}: first line, Untitled-
 *     substituted, capped to {@link TITLE_MAX_LEN}. A block ref is a chip;
 *     a chip shows one short line.
 *   - `page` / `tag` → {@link untitledOr}: Untitled-substituted and
 *     otherwise VERBATIM — un-split and un-capped.
 *
 * The page/tag arm is not symmetry for its own sake. `batch_resolve`,
 * `get_block` and `search_blocks` all return `b.content` for EVERY block
 * type, so a page's namespaced path (`Eng/Platform/Observability`) and a
 * tag's name arrive at these writers too. `renderBlockLink` then runs
 * `getPageDisplayName(title, 'leaf')` over the stored value: cap it and the
 * leaf is wrong, or — if the cut lands before the last `/` — a NAMESPACE
 * SEGMENT renders as the page name; split it at the seed and the `title=`
 * attribute that exists to keep the full path available carries a partial
 * one. And `preload` writes page/tag titles verbatim under the same key, so
 * any capping or splitting writer churns against it on every sync.
 *
 * ## The writers (all of them)
 *
 * Seed writers — title comes from a FETCHED row, so the gate applies:
 *   1. `searchBlockRefs`      `@/components/block-tree/use-block-resolve.ts`
 *   2. `fetchAndCacheLinks`   `@/components/block-tree/use-block-link-resolve.ts`
 *   3. `handleNavigate`       `@/components/block-tree/use-block-navigate-to-link.ts`
 *   4. `storeTitle`           `@/hooks/useBacklinkResolution.ts` (see the gap below)
 *   5. `runPreloadScan`       `@/stores/resolve.ts` — pages + tags only
 *   6. `populatePageResolveCache` / the `searchTags` fill
 *                             `@/components/block-tree/use-block-resolve.ts` — pages / tags
 *   7. the unlinked-refs pre-warm `@/components/backlinks/UnlinkedReferences.tsx` — pages
 *   8. the trash restore hint `@/components/TrashView.tsx` — pages + tags
 *
 * Echo writers — the title is a value the caller just WROTE to the backend
 * (create / rename / delete), not a value it read back, so there is nothing
 * to normalise: it is non-blank by construction and already the exact bytes
 * a later `preload` will re-fetch. `TagList`, `useBlockTags`,
 * `useRichContentCallbacks`, `paste-internalize`, `page-rename`,
 * `usePageDeleteAction`, `onCreatePage` / `onCreateTag`, the journal /
 * date-picker page seeds, and the three `createPageInSpace(…, 'Untitled')`
 * new-page paths (`App.tsx`, `useAppKeyboardShortcuts.ts`,
 * `palette-commands.ts` — whose `'Untitled'` is the PERSISTED content, so it
 * must stay that untranslated literal to match what `preload` reads back).
 *
 * ## The one gap that is NOT closed (#4238)
 *
 * `useBacklinkResolution`'s `storeTitle` deliberately writes the `[[id…]]`
 * broken-link shape — NOT the Untitled placeholder — for a row the backend
 * returned with a `null`/empty title. `resolveBlockDisplay`
 * (`@/lib/query-result-utils.ts`) pattern-matches that exact shape as its
 * "nothing real is cached" signal, so replacing it with "Untitled" would
 * make a nameless row look resolved. Everything ELSE about that writer is
 * on the invariant (a whitespace-only page title now becomes "Untitled"
 * there like everywhere else); the residual divergence is TWO cells, not one,
 * and both are `title === null || title === ''`:
 *
 *   - a NON-TAG row keeps `[[<id>...]]` (the cache-miss signal above), where
 *     every other writer puts "Untitled";
 *   - a TAG row keeps `#<id>...`, where `fetchAndCacheLinks`, `preload`'s tag
 *     half and the `searchTags` fill all put "Untitled" under the same key.
 *
 * #4238 tracks both. The matrix's `deviates` hook pins each cell, so they are
 * tested — an earlier version of this paragraph said "exactly one cell" and
 * undercounted, which in a docblock whose whole point is an honest
 * enumeration is the one mistake that matters. Practical impact of the tag
 * cell is near zero (a blank tag name should not exist), but the count is the
 * count. The docblock this replaced claimed outright parity, which did not
 * hold at all; this paragraph is what actually holds.
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

/**
 * THE gate. Every resolve-store seed writer calls exactly this — the
 * `block_type === 'content'` test lives here and nowhere else, so a writer
 * cannot half-apply it and a new writer has one function to reach for. See
 * the module docblock for the invariant it encodes and for the full writer
 * enumeration this is applied at.
 *
 * `blockType` is typed as a loose string because that is what the bindings
 * hand back (`BlockRow.block_type: string`, `ResolvedBlock.block_type:
 * string`) — the closed `content | tag | page` domain is enforced by the
 * backend's `0005_block_type_check.sql`, not by the TS type. The test is
 * deliberately `=== 'content'` rather than `!== 'page' && !== 'tag'`:
 * capping a page path is the harm this exists to prevent, so an
 * unrecognised type must fall to the verbatim arm, not to the capping one.
 */
export function resolveStoreTitle(
  blockType: string | null | undefined,
  content: string | null,
): string {
  return blockType === 'content' ? normalizeBlockRefTitle(content) : untitledOr(content)
}
