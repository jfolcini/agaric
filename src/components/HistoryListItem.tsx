/**
 * HistoryListItem --- a single row in the history list.
 *
 * Shows op type badge, timestamp, content summary, word-level diff for edits,
 * and selection checkbox. Supports click/shift-click selection.
 *
 * Extracted from HistoryView for testability.
 */

import type { LucideIcon } from 'lucide-react'
import {
  ArrowRight,
  Circle,
  Lock,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  Tag,
  Trash2,
} from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import { formatTimestamp } from '../lib/format'
import { getPayloadRawContent, getPropertyPayload } from '../lib/history-utils'
import { formatPropertyName } from '../lib/property-utils'
import type { DiffSpan, HistoryEntry } from '../lib/tauri'
import { DiffDisplay } from './DiffDisplay'
import { renderRichContent } from './StaticBlock'

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
// Props
// ---------------------------------------------------------------------------

export interface HistoryListItemProps {
  entry: HistoryEntry
  index: number
  isSelected: boolean
  isFocused: boolean
  isNonReversible: boolean
  isExpanded: boolean
  isLoadingDiff: boolean
  diffSpans: DiffSpan[] | undefined
  onRowClick: (index: number, e: React.MouseEvent) => void
  onToggleSelection: (index: number) => void
  onToggleDiff: (entry: HistoryEntry) => void
  onRestoreToHere: (entry: HistoryEntry) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryListItem({
  entry,
  index,
  isSelected,
  isFocused,
  isNonReversible,
  isExpanded,
  isLoadingDiff,
  diffSpans,
  onRowClick,
  onToggleSelection,
  onToggleDiff,
  onRestoreToHere,
}: HistoryListItemProps): React.ReactElement {
  const { t } = useTranslation()
  const rawContent = getPayloadRawContent(entry)
  const propPayload = getPropertyPayload(entry)
  const richCallbacks = useRichContentCallbacks()

  return (
    <div
      data-history-item
      data-testid={`history-item-${index}`}
      role="option"
      aria-selected={isSelected}
      className={cn(
        'history-item flex flex-col gap-2 rounded-lg border p-4 cursor-pointer transition-colors',
        isSelected ? 'bg-accent/50 border-accent' : 'bg-card hover:bg-accent/30',
        isFocused && 'ring-2 ring-ring',
        isNonReversible && 'opacity-50',
      )}
      onClick={(e) => onRowClick(index, e)}
      onKeyDown={(e) => {
        if (e.key === ' ') {
          e.preventDefault()
          onToggleSelection(index)
        }
      }}
      tabIndex={isFocused ? 0 : -1}
      aria-disabled={isNonReversible || undefined}
    >
      <div className="flex items-center gap-3 w-full">
        {/* Checkbox */}
        <input
          type="checkbox"
          checked={isSelected}
          disabled={isNonReversible}
          onChange={() => onToggleSelection(index)}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4 shrink-0 rounded border-border [@media(pointer:coarse)]:size-11"
          aria-label={t('history.selectOperationLabel', {
            opType: entry.op_type,
            seq: entry.seq,
          })}
        />

        {/* Op type badge */}
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

        {/* Content preview + timestamp */}
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          {propPayload && (
            <span className="history-item-preview text-sm line-clamp-2">
              {formatPropertyName(propPayload.key)}
              {propPayload.value != null && ` → ${propPayload.value}`}
            </span>
          )}
          {!propPayload && rawContent && (
            <span className="history-item-preview text-sm line-clamp-2">
              {renderRichContent(rawContent, {
                interactive: false,
                ...richCallbacks,
              })}
            </span>
          )}
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
          <span className="text-xs text-muted-foreground/60"> · </span>
          <span className="history-item-device text-xs text-muted-foreground/60">
            dev:{entry.device_id.slice(0, 8)}
          </span>
        </div>

        {/* Diff toggle for edit_block entries */}
        {entry.op_type === 'edit_block' && (
          <Button
            variant="ghost"
            size="sm"
            className="diff-toggle-btn shrink-0 px-2"
            onClick={(e) => {
              e.stopPropagation()
              onToggleDiff(entry)
            }}
          >
            <ChevronToggle isExpanded={isExpanded} loading={isLoadingDiff} size="md" />
            {t('history.diffButton')}
          </Button>
        )}

        {/* Restore to here button — only for reversible ops */}
        {!isNonReversible && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="restore-to-here-btn shrink-0 px-2"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRestoreToHere(entry)
                  }}
                  aria-label={t('history.restoreToHereLabel')}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('history.restoreToHereTooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* Lock icon for non-reversible ops */}
        {isNonReversible && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-label={t('history.nonReversibleLabel')}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p>{t('history.nonReversibleTooltip')}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      {isExpanded && diffSpans != null && (
        // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation prevents parent row selection when clicking diff
        <div
          className="diff-container mt-2 w-full"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <DiffDisplay spans={diffSpans} />
        </div>
      )}
    </div>
  )
}
