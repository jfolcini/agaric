/**
 * PageMetadataBar — collapsible metadata footer for the page editor.
 *
 * Displays word count, block count, and created date (extracted from the
 * page block's ULID). Collapsed by default; toggled via click.
 */

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { cn } from '@/lib/utils'
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
      <button
        type="button"
        onClick={handleToggle}
        className={cn(
          'flex items-center gap-1 rounded-md px-2 py-1',
          'text-xs text-muted-foreground',
          'hover:bg-accent/50 active:bg-accent/70 transition-colors',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
        )}
        aria-expanded={!collapsed}
        aria-label={t('metadata.toggleLabel')}
      >
        <ChevronToggle isExpanded={!collapsed} size="sm" />
        <span>{t('metadata.label')}</span>
      </button>

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
