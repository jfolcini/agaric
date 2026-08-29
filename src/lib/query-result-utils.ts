import type { BlockRow } from '@/lib/bindings'
import { untitledOr } from '@/lib/block-title'
import { truncateContent } from '@/lib/text-utils'

/**
 * Detects the `[[ULID...]]` cache-miss fallback a `resolveBlockTitle` can
 * hand back for an id it has no real title for.
 *
 * Since #4238 there is exactly ONE producer of this shape, and it is a
 * DISPLAY label derived from `ResolveEntry.resolved` (`@/stores/resolve`)
 * rather than a string any writer stores as a row's title:
 * `unresolvedBlockLabel` (`@/lib/block-title`), returned by
 * `useBlockResolve`'s `resolveBlockTitle`
 * (`@/components/block-tree/use-block-resolve.ts`),
 * `useResolveStore.resolveTitle` (`@/stores/resolve.ts`) and
 * `useBacklinkResolution.resolveBlockTitle` (`@/hooks/...`) for an id that is
 * absent from the cache OR present with `resolved: false` — the
 * `fetchAndCacheLinks` unreturned-target placeholder. The two are deliberately
 * indistinguishable here: both mean "the backend never handed us this row".
 *
 * Before #4238 there was a second producer, and it is why this pattern was
 * fragile: `useBacklinkResolution` STORED this shape as the title of a
 * resolved-but-BLANK row, purely so that this test would keep firing for it.
 * The title was therefore answering two questions at once, and blank was the
 * input on which they disagreed — that row is resolved, it just has no name.
 * It now stores "Untitled" like its three sibling writers, and reaches the
 * fallback below through {@link isSyntheticTitle}'s placeholder arm instead.
 * Keep this pattern in step with `unresolvedBlockLabel`'s shape (both are
 * anchored on its 8-of-26-character id prefix); nothing else may emit it.
 */
const CACHE_MISS_FALLBACK_PATTERN = /^\[\[[0-9A-Z]{1,12}\.{3}\]\]$/

/**
 * Whether `resolved` is a SYNTHETIC label — a stand-in the resolver produced
 * because it had no real title — rather than a block's actual text.
 *
 * #4239 — this used to test only {@link CACHE_MISS_FALLBACK_PATTERN}, which
 * was complete while the seeders stored raw content. Since #4228 moved
 * normalisation to the seed, `normalizeBlockRefTitle` also SUBSTITUTES the
 * "Untitled" placeholder — for blank content, and (deliberately, because a
 * chip shows one line) for content whose FIRST line is blank, i.e. anything
 * starting with `"\n"`. Those rows resolve to a real cache hit carrying a
 * placeholder, so the cache-miss test no longer recognised them and a query
 * row that used to show the block's own text showed "Untitled" instead.
 *
 * That is a genuine cross-surface consequence of the seed move, and it is
 * NOT acceptable here: a query row is not a chip. It has its own 80-char
 * budget, no one-line constraint, and its whole job is to show enough of the
 * block to identify it — showing "Untitled" for a block with real text on
 * line 2 loses the only information the row carries. The chip still shows
 * "Untitled" for the same block, which is correct FOR A CHIP; the two
 * surfaces are allowed to differ because they read the same stored title
 * with different budgets. Treating the placeholder as synthetic restores the
 * pre-#4228 row for both shapes without reintroducing a second normaliser.
 *
 * A page genuinely TITLED "Untitled" is unaffected: its content fallback
 * truncates to the same word.
 */
function isSyntheticTitle(resolved: string): boolean {
  return CACHE_MISS_FALLBACK_PATTERN.test(resolved) || resolved === untitledOr(null)
}

/**
 * Resolve the display title and page title for a block row.
 *
 * Centralises the title-resolution logic shared by QueryResultList and
 * QueryResultTable so the two components stay in sync.
 *
 * When `resolveBlockTitle` hands back a synthetic label (see
 * {@link isSyntheticTitle} — the `[[ULID...]]` cache-miss fallback, or the
 * "Untitled" placeholder a seeder stored), we fall back to the block's own
 * content. The resolve store only preloads pages + tags + links from the
 * current page — query results often include blocks from other pages that
 * are never populated, so the cache miss is the normal case for cross-page
 * query results.
 *
 * # The 80-char budget applies to the FALLBACK, not to a cache hit
 *
 * `truncateContent(…, 80)` bounds the fallback. A cache HIT is rendered
 * verbatim, and since #4228 a stored title is already capped at 60 (57 +
 * ellipsis, first line only) — so a resolved content block renders at most
 * 60 here, not 80. That is a real narrowing for rows whose target happened
 * to be seeded: before #4228 `useBacklinkResolution` stored raw content, so
 * such a row rendered the full 80.
 *
 * It is the cost of the store having ONE title rather than one per surface,
 * which is what #4228 bought. A row that wants more than the stored title
 * would have to re-read the block — a different design, and still an open
 * trade-off: #4238 settled who OWNS the title (and moved the cache-miss
 * signal off it), not how wide it is. Stated here because the budget in the
 * line below is otherwise read as the row's, and it is not.
 *
 * # A null-content page or tag renders the empty marker HERE only
 *
 * `preload` stores such a row as "Untitled", which `isSyntheticTitle` now
 * classes synthetic, so it takes the fallback and `truncateContent(null, 80)`
 * yields the empty marker — while every other surface shows the placeholder.
 * Pinned by test, so it is a decision rather than a surprise; it agrees with
 * the UNCACHED blank row, which already rendered the marker.
 */
export function resolveBlockDisplay(
  block: BlockRow,
  pageTitles: Map<string, string>,
  resolveBlockTitle?: ((id: string) => string) | undefined,
): { title: string; pageTitle: string | undefined } {
  const resolved = resolveBlockTitle ? resolveBlockTitle(block.id) : ''
  const contentFallback = truncateContent(block.content, 80)
  const title = resolved && !isSyntheticTitle(resolved) ? resolved : contentFallback

  const pageTitle = block.page_id ? pageTitles.get(block.page_id) : undefined

  return { title, pageTitle }
}

/**
 * Navigate to the parent page of a block, if the block has a page_id and an
 * onNavigate callback is provided.
 */
export function handleBlockNavigation(
  block: BlockRow,
  onNavigate?: ((pageId: string) => void) | undefined,
): void {
  if (block.page_id && onNavigate) {
    onNavigate(block.page_id)
  }
}
