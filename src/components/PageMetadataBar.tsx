/**
 * PageMetadataBar — collapsible metadata footer for the page editor.
 *
 * Displays word count, block count, and created date (extracted from the
 * page block's ULID). Collapsed by default; toggled via click.
 */

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CollapsiblePanelHeader } from '@/components/CollapsiblePanelHeader'
import { ulidToDate } from '../lib/format'
import type { FlatBlock } from '../lib/tree-utils'

/** Count total words across all blocks by splitting content on whitespace. */
export function countWords(blocks: FlatBlock[]): number {
  let total = 0
  for (const block of blocks) {
    const content = block.content
    if (!content) continue
    const trimmed = content.trim()
    if (trimmed.length === 0) continue
    total += trimmed.split(/\s+/).length
  }
  return total
}

export interface PageMetadataBarProps {
  blocks: FlatBlock[]
  pageId: string
}

export function PageMetadataBar({ blocks, pageId }: PageMetadataBarProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(true)

  const wordCount = useMemo(() => countWords(blocks), [blocks])
  const blockCount = blocks.length

  const createdDate = useMemo(() => {
    const date = ulidToDate(pageId)
    if (!date) return null
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }, [pageId])

  const handleToggle = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  return (
    <div className="page-metadata-bar">
      <CollapsiblePanelHeader isCollapsed={collapsed} onToggle={handleToggle}>
        {t('metadata.label')}
      </CollapsiblePanelHeader>

      {!collapsed && (
        <div className="px-2 py-1 text-xs text-muted-foreground" data-testid="metadata-content">
          {t('metadata.wordCount', { count: wordCount })}
          {' · '}
          {t('metadata.blockCount', { count: blockCount })}
          {createdDate && (
            <>
              {' · '}
              {t('metadata.created', { date: createdDate })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
