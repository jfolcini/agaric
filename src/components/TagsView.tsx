/**
 * TagsView — the `tags` sidebar view.
 *
 * Composes the tag browser (`TagList`) with the tag-filter panel
 * (`TagFilterPanel`), separated by a labelled section divider. Extracted
 * from the inline `tags` branch of `ViewDispatcher` (#1649) so the router
 * delegates to a single view component like every other case, and so the
 * section label flows through i18n rather than a hardcoded literal.
 */

import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { TagFilterPanel } from '@/components/filters/TagFilterPanel'
import { TagList } from '@/components/TagList'
import { Separator } from '@/components/ui/separator'

export interface TagsViewProps {
  /** Open a tag's page when a tag is clicked in the list. */
  onTagClick: (tagId: string, tagName: string) => void
}

export function TagsView({ onTagClick }: TagsViewProps): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="space-y-8">
      <TagList onTagClick={onTagClick} />
      <div className="flex items-center gap-4">
        <Separator className="flex-1" />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('tagFilter.sectionLabel')}
        </span>
        <Separator className="flex-1" />
      </div>
      <TagFilterPanel />
    </div>
  )
}
