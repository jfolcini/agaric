import type { BlockRow } from './tauri'
import { truncateContent } from './text-utils'

/**
 * Resolve the display title and page title for a block row.
 *
 * Centralises the title-resolution logic shared by QueryResultList and
 * QueryResultTable so the two components stay in sync.
 */
export function resolveBlockDisplay(
  block: BlockRow,
  pageTitles: Map<string, string>,
  resolveBlockTitle?: ((id: string) => string) | undefined,
): { title: string; pageTitle: string | undefined } {
  const title = resolveBlockTitle
    ? resolveBlockTitle(block.id) || truncateContent(block.content, 80)
    : truncateContent(block.content, 80)

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
