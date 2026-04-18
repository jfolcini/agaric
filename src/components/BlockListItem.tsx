/**
 * BlockListItem — shared presentational component for rendering a block
 * in list views (DuePanel, DonePanel, AgendaResults).
 *
 * Renders a clickable `<li>` with a consistent layout:
 *   [metadata slot] → [truncated content] → [page breadcrumb]
 *
 * The `metadata` slot accepts arbitrary React nodes (icons, priority
 * badges, date chips) so each consumer can inject context-specific
 * elements without duplicating the surrounding structure.
 */

import { CalendarDays } from 'lucide-react'
import type React from 'react'
import { memo, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import { logger } from '../lib/logger'
import { getBlock, setDueDate, setScheduledDate } from '../lib/tauri'
import { PageLink } from './PageLink'
import { renderRichContent } from './StaticBlock'
import { Calendar } from './ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export interface BlockListItemProps {
  /** Block content text — truncated via CSS line-clamp. */
  content: string | null
  /** Max characters before truncation. Default 120. */
  contentMaxLength?: number
  /** Fallback text when content is null/empty. Default "(empty)". */
  emptyContentFallback?: string
  /** Nodes rendered before the content text (icons, badges, chips). */
  metadata?: React.ReactNode
  /** Page ID for the breadcrumb. Hidden when nullish. */
  pageId?: string | null
  /** Page title shown in breadcrumb. */
  pageTitle?: string
  /** Arrow text before page title (e.g. "→"). Default "→". */
  breadcrumbArrow?: string
  /** Render breadcrumb title as a PageLink (true) or plain text (false). Default true. */
  breadcrumbAsLink?: boolean
  /** Click handler for the list item. */
  onClick?: () => void
  /** Keyboard handler for the list item. */
  onKeyDown?: (e: React.KeyboardEvent) => void
  /** Additional CSS classes appended to the `<li>`. */
  className?: string
  /** Additional CSS classes for the content `<span>`. */
  contentClassName?: string
  /** Additional CSS classes for the breadcrumb `<span>`. */
  breadcrumbClassName?: string
  /** data-testid for the `<li>`. */
  testId?: string
  /** Block ID — when provided, enables native HTML5 drag for rescheduling (F-32). */
  blockId?: string
  /** Callback fired after rescheduling a block via the touch calendar popover. */
  onReschedule?: (blockId: string, newDate: string) => void
  /** Whether this item is focused via keyboard navigation. */
  isFocused?: boolean
}

function formatDateISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function BlockListItemInner({
  content,
  contentMaxLength: _contentMaxLength = 120,
  emptyContentFallback = '(empty)',
  metadata,
  pageId,
  pageTitle = '',
  breadcrumbArrow = '\u2192',
  breadcrumbAsLink = true,
  onClick,
  onKeyDown,
  className,
  contentClassName,
  breadcrumbClassName,
  testId,
  blockId,
  onReschedule,
  isFocused,
}: BlockListItemProps): React.ReactElement {
  const { t } = useTranslation()
  const callbacks = useRichContentCallbacks()
  const [popoverOpen, setPopoverOpen] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: callbacks are non-interactive and stable — only content drives the rendered output
  const richContent = useMemo(
    () => (content ? renderRichContent(content, { interactive: false, ...callbacks }) : null),
    [content],
  )

  const handleDateSelect = useCallback(
    async (date: Date | undefined) => {
      if (!date || !blockId) return
      const dateStr = formatDateISO(date)
      setPopoverOpen(false)
      if (onReschedule) {
        onReschedule(blockId, dateStr)
        return
      }
      try {
        let useScheduledDate = false
        try {
          const block = await getBlock(blockId)
          if (block.scheduled_date && !block.due_date) {
            useScheduledDate = true
          }
        } catch (err) {
          logger.warn('BlockListItem', 'Failed to fetch block', { blockId }, err)
        }
        if (useScheduledDate) {
          await setScheduledDate(blockId, dateStr)
        } else {
          await setDueDate(blockId, dateStr)
        }
        toast.success(t('journal.rescheduled', { date: dateStr }))
      } catch {
        toast.error(t('journal.rescheduleFailed'))
      }
    },
    [blockId, onReschedule, t],
  )

  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 cursor-pointer transition-colors',
        // Touch: ensure 44px minimum height so embedded pills (priority, date chip)
        // with touch-device padding don't get clipped at the bottom (UX-195).
        '[@media(pointer:coarse)]:min-h-11',
        blockId && 'cursor-grab',
        isFocused && 'ring-2 ring-ring/50 bg-accent/30',
        className,
      )}
      data-testid={testId}
      data-block-list-item
      id={testId || blockId ? `block-item-${blockId}` : undefined}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: li needs tabIndex for keyboard navigation
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      draggable={!!blockId}
      onDragStart={(e) => {
        if (blockId) {
          e.dataTransfer.setData('application/x-block-reschedule', blockId)
          e.dataTransfer.effectAllowed = 'move'
        }
      }}
    >
      {/* Metadata slot: icons, badges, chips */}
      {metadata}

      {/* Block content — full content by default; callers opt into line-clamp
          via contentClassName="line-clamp-2" when a truncated preview is needed
          (e.g. SearchPanel). Agenda shows full content (UX-197). */}
      <span className={cn('text-sm min-w-0 flex-1', contentClassName)}>
        {richContent ?? emptyContentFallback}
      </span>

      {/* Source page breadcrumb */}
      {pageId && (
        <span
          className={cn('text-xs text-muted-foreground truncate max-w-[40%]', breadcrumbClassName)}
        >
          {breadcrumbArrow}{' '}
          {breadcrumbAsLink ? <PageLink pageId={pageId} title={pageTitle} /> : pageTitle}
        </span>
      )}

      {/* Reschedule button — visible on touch devices */}
      {blockId && (
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="reschedule-btn hidden [@media(pointer:coarse)]:inline-flex shrink-0 items-center justify-center rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors touch-target"
              aria-label={t('block.reschedule')}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              data-testid="reschedule-btn"
            >
              <CalendarDays className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-auto p-0"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Calendar mode="single" onSelect={handleDateSelect} data-testid="reschedule-calendar" />
          </PopoverContent>
        </Popover>
      )}
    </li>
  )
}

export const BlockListItem = memo(BlockListItemInner)
BlockListItem.displayName = 'BlockListItem'
