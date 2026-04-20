import type { BlockRow } from './tauri'
import { truncateContent } from './text-utils'

/** Detects the `[[ULID...]]` cache-miss fallback emitted by useBlockResolve. */
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
 * the normal case for cross-page query results (TEST-1f).
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
