import type { BlockRow } from '@/lib/bindings'
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
 * Resolve the display title and page title for a block row.
 *
 * Centralises the title-resolution logic shared by QueryResultList and
 * QueryResultTable so the two components stay in sync.
 *
 * When `resolveBlockTitle` returns the cache-miss fallback (`[[ULID...]]`),
 * we fall back to the block's own content. The resolve store only preloads
 * pages + tags + links from the current page — query results often include
 * blocks from other pages that are never populated, so the cache miss is
 * The normal case for cross-page query results.
 */
export function resolveBlockDisplay(
  block: BlockRow,
  pageTitles: Map<string, string>,
  resolveBlockTitle?: ((id: string) => string) | undefined,
): { title: string; pageTitle: string | undefined } {
  const resolved = resolveBlockTitle ? resolveBlockTitle(block.id) : ''
  const contentFallback = truncateContent(block.content, 80)
  const title = resolved && !CACHE_MISS_FALLBACK_PATTERN.test(resolved) ? resolved : contentFallback

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
