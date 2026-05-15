/**
 * HistoryItemCore --- shared visual elements for a history row.
 *
 * Renders the op-type badge, timestamp, device id, content preview, and
 * optional diff-toggle button. Reused by both the top-level
 * `HistoryListItem` (the global history grid row) and `BlockHistoryItem`
 * (the per-block history sheet row).
 *
 * Extracted from the monolithic `HistoryListItem.tsx` per the Phase 3b
 * design-system-maintainability plan (`pending/design-system-maintainability-2026-05-09.md`).
 * The orchestrator (`HistoryListItem.tsx`) keeps re-exporting `opIcon`,
 * `HistoryItemCore` and `HistoryItemCoreProps` so external consumers see
 * no surface change.
 */

import type { LucideIcon } from 'lucide-react'
import {
  ArrowRight,
  Circle,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Tag,
  Trash2,
} from 'lucide-react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useRichContentCallbacks, useTagClickHandler } from '../../hooks/useRichContentCallbacks'
import { formatTimestamp } from '../../lib/format'
import { getPayloadRawContent, getPropertyPayload } from '../../lib/history-utils'
import { formatPropertyName } from '../../lib/property-utils'
import type { HistoryEntry } from '../../lib/tauri'
import { renderRichContent } from '../RichContentRenderer'

// ---------------------------------------------------------------------------
// Badge colour mapping
// ---------------------------------------------------------------------------

function opBadgeClasses(opType: string): string {
  if (opType.startsWith('create') || opType.startsWith('restore')) {
    return 'bg-op-create text-op-create-foreground'
  }
  if (opType.startsWith('edit')) {
    return 'bg-op-edit text-op-edit-foreground'
  }
  if (opType.startsWith('delete') || opType.startsWith('purge')) {
    return 'bg-destructive/10 text-destructive'
  }
  if (opType.startsWith('move')) {
    return 'bg-op-move text-op-move-foreground'
  }
  if (
    opType.startsWith('tag') ||
    opType.startsWith('property') ||
    opType === 'set_property' ||
    opType === 'delete_property'
  ) {
    return 'bg-op-tag text-op-tag-foreground'
  }
  if (opType.startsWith('attachment') || opType === 'add_attachment') {
    return 'bg-muted text-muted-foreground'
  }
  return 'bg-secondary text-secondary-foreground'
}

// ---------------------------------------------------------------------------
// Badge icon mapping
// ---------------------------------------------------------------------------

export function opIcon(opType: string): LucideIcon {
  if (opType.startsWith('restore')) return RotateCcw
  if (opType.startsWith('create')) return Plus
  if (opType.startsWith('edit')) return Pencil
  if (opType.startsWith('move')) return ArrowRight
  if (opType === 'add_tag' || opType === 'remove_tag') return Tag
  if (opType === 'set_property' || opType === 'delete_property') return Settings
  if (opType === 'add_attachment' || opType === 'delete_attachment') return Paperclip
  if (opType.startsWith('delete') || opType.startsWith('purge')) return Trash2
  return Circle
}

// ---------------------------------------------------------------------------
// HistoryItemCore — shared visual elements
// ---------------------------------------------------------------------------

export interface HistoryItemCoreProps {
  entry: HistoryEntry
  /** When omitted, the diff-toggle button is hidden (PEND-17 Part B —
   *  `BlockHistoryItem` drives expansion from the row click instead). */
  isExpanded?: boolean
  isLoadingDiff?: boolean
  onToggleDiff?: (entry: HistoryEntry) => void
}

export function HistoryItemCore({
  entry,
  isExpanded,
  isLoadingDiff,
  onToggleDiff,
}: HistoryItemCoreProps): React.ReactElement {
  const { t } = useTranslation()
  const rawContent = getPayloadRawContent(entry)
  const propPayload = getPropertyPayload(entry)
  const richCallbacks = useRichContentCallbacks()
  const onTagClick = useTagClickHandler()

  return (
    <>
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        {/* Op type badge */}
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              'history-item-type shrink-0 border-transparent',
              opBadgeClasses(entry.op_type),
            )}
            data-testid="history-type-badge"
          >
            {(() => {
              const IconComponent = opIcon(entry.op_type)
              return <IconComponent className="h-3 w-3 mr-1" />
            })()}
            {entry.op_type}
          </Badge>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="history-item-time text-xs text-muted-foreground w-fit">
                  {formatTimestamp(entry.created_at, 'relative')}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <p>{formatTimestamp(entry.created_at, 'full')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <span className="text-xs text-muted-foreground"> · </span>
          <span className="history-item-device text-xs text-muted-foreground">
            dev:{entry.device_id.slice(0, 8)}
          </span>
        </div>
        {/* Content preview */}
        {propPayload && (
          <span className="history-item-preview text-sm line-clamp-2">
            {formatPropertyName(propPayload.key)}
            {propPayload.value != null && ` → ${propPayload.value}`}
          </span>
        )}
        {!propPayload && rawContent && (
          <span className="history-item-preview text-sm line-clamp-2">
            {renderRichContent(rawContent, {
              interactive: true,
              onTagClick,
              ...richCallbacks,
            })}
          </span>
        )}
      </div>
      {/* Diff toggle — only when the parent supplies an `onToggleDiff`
          handler. PEND-17 Part B `BlockHistoryItem` omits it and drives
          expansion from the whole-row click target instead. */}
      {entry.op_type === 'edit_block' && onToggleDiff && (
        <Button
          variant="ghost"
          size="sm"
          className="diff-toggle-btn shrink-0 px-2"
          onClick={(e) => {
            e.stopPropagation()
            onToggleDiff(entry)
          }}
        >
          <ChevronToggle
            isExpanded={isExpanded ?? false}
            loading={isLoadingDiff ?? false}
            size="md"
          />
          {t('history.diffButton')}
        </Button>
      )}
    </>
  )
}
