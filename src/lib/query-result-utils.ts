import type { BlockRow } from '@/lib/bindings'
import { untitledOr } from '@/lib/block-title'
import { truncateContent } from '@/lib/text-utils'

/**
 * Detects the `[[ULID...]]` cache-miss fallback a `resolveBlockTitle` can
 * hand back for an id it has no real title for.
 *
 * It reaches this function two ways, and both have to keep producing this
 * exact shape or the content fallback below silently stops firing:
 *
 *   - RETURNED by the resolver on a miss — `useBlockResolve`'s
 *     `resolveBlockTitle` (`@/components/block-tree/use-block-resolve.ts`),
 *     `useResolveStore.resolveTitle` (`@/stores/resolve.ts`), and
 *     `useBacklinkResolution.resolveBlockTitle` (`@/hooks/...`) each fall
 *     back to it when the composite key is absent from the cache.
 *   - STORED in the cache as a placeholder, so the resolver "hits" and
 *     returns it: `fetchAndCacheLinks`' unreturned-target branch
 *     (`@/components/block-tree/use-block-link-resolve.ts`) writes it for a
 *     foreign-space / unknown id, and `useBacklinkResolution`'s `storeTitle`
 *     writes it for a resolved-but-blank non-tag row — deliberately NOT
 *     routed through `normalizeBlockRefTitle`, which would turn it into
 *     "Untitled" and make a nameless row look resolved here.
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
