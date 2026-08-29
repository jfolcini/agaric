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
 *   4. `storeTitle`           `@/hooks/useBacklinkResolution.ts`
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
 * ## The blank cells, and where the cache-miss signal lives now (#4238)
 *
 * Until #4238 the enumeration above had an exception: `useBacklinkResolution`
 * wrote `[[<id>...]]` (or `#<id>...` for a tag) instead of "Untitled" for a
 * row the backend RETURNED with a `null`/empty title. That was not sloppiness
 * — the `[[id…]]` shape was a SIGNAL. `resolveBlockDisplay`
 * (`@/lib/query-result-utils.ts`) pattern-matches it as "nothing real is
 * cached", so normalising that one writer would have made a nameless row look
 * resolved. The title was doing two jobs — *what to show the user* and
 * *whether this row is resolved* — and the two disagree for exactly one
 * input: a row that resolved successfully and is genuinely blank. One string
 * cannot say both.
 *
 * So the second job moved off the string. `ResolveEntry` (`@/stores/resolve`)
 * now carries a `resolved` boolean alongside `deleted`, and the title is
 * PURELY presentational: every seed writer above normalises unconditionally,
 * blank included, so all four writers that can reach a `content` id
 * (`searchBlockRefs`, `fetchAndCacheLinks`, `handleNavigate`, the
 * `useBacklinkResolution` seed) produce byte-identical bytes for the same row.
 *
 * `resolved: false` is written by exactly one place — `fetchAndCacheLinks`'
 * unreturned-target branch, for an id `batch_resolve` did not hand back at all
 * (foreign-space or genuinely unknown). {@link unresolvedBlockLabel} /
 * {@link unresolvedTagLabel} are what a surface shows for such an id, and the
 * store's `resolveTitle` derives them from the FLAG rather than from whatever
 * string is sitting in `title` — so a stored title can never again be mistaken
 * for a resolution verdict.
 *
 * Why not reuse `deleted`? Because `deleted: true` is a legitimate state for a
 * fully RESOLVED row (a soft-deleted block that `batch_resolve` returns with
 * its real title), so folding the two together would put every trashed block's
 * chip back on the `[[id…]]` label — the same two-meanings-in-one-field
 * mistake, one field over.
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

/**
 * How much of a ULID the unresolved labels below show. 8 of 26 characters:
 * enough to tell two broken chips apart in a bug report, short enough to sit
 * inside a chip. The value is shared so the labels and
 * `CACHE_MISS_FALLBACK_PATTERN` (`@/lib/query-result-utils`) cannot drift.
 */
const UNRESOLVED_ID_CHARS = 8

/**
 * The label a surface shows for a block id nothing is resolved for — either
 * absent from the resolve cache entirely, or present with `resolved: false`
 * (the `fetchAndCacheLinks` unreturned-target placeholder).
 *
 * #4238 — this is a DISPLAY label derived from the entry's `resolved` flag,
 * not a value any seed writer stores as a row's title. That inversion is the
 * whole point: before #4238 the same string was persisted as the title of a
 * resolved-but-blank row, which is what made "is this resolved" unanswerable
 * without guessing at bytes. Six copies of the `slice(0, 8)` literal used to
 * be spelled out across the store, the two block-tree resolve hooks and the
 * backlink hook; they are this function now, so a change of shape reaches
 * every surface at once (and `resolveBlockDisplay`'s pattern, which must keep
 * matching it, is documented against this).
 */
export function unresolvedBlockLabel(id: string): string {
  return `[[${id.slice(0, UNRESOLVED_ID_CHARS)}...]]`
}

/** {@link unresolvedBlockLabel}'s tag-shaped sibling, for a `#[ULID]` target. */
export function unresolvedTagLabel(id: string): string {
  return `#${id.slice(0, UNRESOLVED_ID_CHARS)}...`
}
