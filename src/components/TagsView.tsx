/**
 * TagsView — the `tags` sidebar view: the tag browser (`TagList`).
 *
 * Extracted from the inline `tags` branch of `ViewDispatcher` (#1649) so the
 * router delegates to a single view component like every other case. Blocks
 * are filtered by tag in Search (`tag:` / `under:` / `not-tag:`, joined by
 * `OR`), not here.
 */

import type { ReactElement } from 'react'

import { TagList } from '@/components/TagList'

export interface TagsViewProps {
  /** Open a tag's page when a tag is clicked in the list. */
  onTagClick: (tagId: string, tagName: string) => void
}

export function TagsView({ onTagClick }: TagsViewProps): ReactElement {
  return (
    <div className="mx-auto w-full max-w-list">
      <TagList onTagClick={onTagClick} />
    </div>
  )
}
