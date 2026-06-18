/**
 * TrashRowItem — single trashed-block row for TrashView's listbox.
 *
 * Renders the checkbox, type/descendant badges, content + relative
 * deletion timestamp + breadcrumb, and the inline restore/purge
 * action buttons. Stays pure-presentational: all state and handlers
 * are passed in from the orchestrator. Sibling extracted from
 * TrashView.tsx for MAINT-128.
 */

import { RotateCcw } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

import type { RichContentCallbacks } from '../../hooks/useRichContentCallbacks'
import { formatRelativeTime } from '../../lib/format-relative-time'
import type { BlockRow } from '../../lib/tauri'
import { renderRichContent } from '../RichContentRenderer'

interface TrashRowItemProps {
  block: BlockRow
  isSelected: boolean
  isFocused: boolean
  parentLabel: string | null
  descendantCount: number
  callbacks: RichContentCallbacks
  onTagClick: (tagId: string) => void
  onRowClick: (id: string, e: React.MouseEvent) => void
  onToggleSelection: (id: string) => void
  onRestore: (block: BlockRow) => void
  onRequestPurge: (id: string) => void
  /**
   * #740 — virtualization hooks. The list is windowed via
   * `@tanstack/react-virtual`, so the row's own `role="row"` element must
   * BE the positioned + measured node (a wrapper div between the
   * `role="grid"` viewport and this row would break `aria-required-parent`).
   * `rowRef` is the virtualizer's `measureElement`, `dataIndex` is the
   * virtual index it reads, and `style` carries the absolute-position
   * transform. All optional so non-virtualized callers stay unchanged.
   */
  rowRef?: (el: HTMLDivElement | null) => void
  dataIndex?: number
  style?: React.CSSProperties
}

export function TrashRowItem({
  block,
  isSelected,
  isFocused,
  parentLabel,
  descendantCount,
  callbacks,
  onTagClick,
  onRowClick,
  onToggleSelection,
  onRestore,
  onRequestPurge,
  rowRef,
  dataIndex,
  style,
}: TrashRowItemProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div
      key={block.id}
      id={`trash-item-${block.id}`}
      ref={rowRef}
      data-index={dataIndex}
      style={style}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- row in a CSS-grid aria grid (flex layout); a <tr> requires table ancestry and would break the flexbox layout
      role="row"
      aria-selected={isSelected}
      data-trash-item
      className={cn(
        'trash-item flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 rounded-lg border bg-card p-4 transition-colors cursor-pointer',
        isSelected ? 'bg-accent/50 border-accent' : 'hover:bg-accent/50 active:bg-accent/70',
        isFocused && 'ring-2 ring-inset ring-ring/50 bg-accent/30',
      )}
      data-testid="trash-item"
      onClick={(e) => onRowClick(block.id, e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggleSelection(block.id)
        }
      }}
      tabIndex={isFocused ? 0 : -1}
    >
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell in a CSS-grid aria grid; <td> requires table ancestry and breaks the flex layout */}
      <div role="gridcell" className="trash-item-content flex min-w-0 items-center gap-3 flex-wrap">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelection(block.id)}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 shrink-0 rounded border-border [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6"
          aria-label={t('trash.selectItemLabel', {
            content: block.content ?? t('trash.emptyContent'),
          })}
          data-testid="trash-item-checkbox"
          tabIndex={-1}
        />
        <Badge tone="secondary" className="trash-item-type shrink-0">
          {block.block_type}
        </Badge>
        {descendantCount > 0 && (
          <Badge
            tone="outline"
            className="trash-item-batch-count shrink-0 whitespace-nowrap"
            data-testid="trash-descendant-badge"
          >
            {t('trash.itemsInBatch', { count: descendantCount })}
          </Badge>
        )}
        <div className="flex flex-col min-w-0">
          <span className="trash-item-text text-sm truncate">
            {block.content
              ? renderRichContent(block.content, {
                  interactive: true,
                  onTagClick,
                  ...callbacks,
                })
              : t('trash.emptyContent')}
          </span>
          <span className="trash-item-date text-xs text-muted-foreground">
            {t('trash.deletedPrefix')}{' '}
            {block.deleted_at ? formatRelativeTime(block.deleted_at, t) : ''}
          </span>
          {parentLabel && (
            <span
              className="trash-item-breadcrumb text-xs text-muted-foreground"
              data-testid="trash-item-breadcrumb"
            >
              {t('trash.fromPage', { page: parentLabel })}
            </span>
          )}
        </div>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/interactive-supports-focus -- gridcell focus is delegated to inner action buttons */}
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- gridcell in a CSS-grid aria grid; <td> requires table ancestry and breaks the flex layout
        role="gridcell"
        className="trash-item-actions flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="trash-restore-btn [@media(pointer:coarse)]:h-10"
              data-testid="trash-restore-btn"
              onClick={() => onRestore(block)}
              tabIndex={-1}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('trash.restoreButton')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('trash.restoreTooltip')}</p>
          </TooltipContent>
        </Tooltip>
        {/* UX-342 — Tooltip on the destructive Purge button so users
            understand "Purge" means permanent deletion. Mirrors the
            Restore button's Tooltip structure above. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="destructive"
              size="sm"
              className="trash-purge-btn [@media(pointer:coarse)]:h-10"
              data-testid="trash-purge-btn"
              onClick={() => onRequestPurge(block.id)}
              tabIndex={-1}
            >
              {t('trash.purgeButton')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('trash.purgeTooltip')}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
