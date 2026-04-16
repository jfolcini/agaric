/**
 * ConflictListItem — a single conflict item card.
 *
 * Renders the type-specific conflict content (via ConflictTypeRenderer),
 * the keep/discard action buttons, the expand/collapse toggle, metadata,
 * and the selection checkbox.
 *
 * Extracted from ConflictList.tsx for testability (#651-R3).
 */

import { Check, ExternalLink, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronToggle } from '@/components/ui/chevron-toggle'
import { formatTimestamp, truncateId, ulidToDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { BlockRow } from '../lib/tauri'
import { ConflictTypeRenderer } from './ConflictTypeRenderer'

/** Determine the conflict type from backend metadata. */
export function inferConflictType(
  block: BlockRow,
  _original?: BlockRow,
): 'Text' | 'Property' | 'Move' {
  if (block.conflict_type === 'Property') return 'Property'
  if (block.conflict_type === 'Move') return 'Move'
  return 'Text'
}

/** Badge color class by conflict type. */
function conflictTypeBadgeClass(type: 'Text' | 'Property' | 'Move'): string {
  switch (type) {
    case 'Text':
      return 'bg-conflict-text text-conflict-text-foreground border-border'
    case 'Property':
      return 'bg-status-active text-status-active-foreground border-border'
    case 'Move':
      return 'bg-conflict-move text-conflict-move-foreground border-border'
  }
}

/** Resolve the display timestamp for a conflict block from its ULID. */
function getConflictTimestamp(block: BlockRow): string {
  const ulidDate = ulidToDate(block.id)
  if (ulidDate) return formatTimestamp(ulidDate.toISOString(), 'relative')
  return 'Unknown'
}

export interface ConflictListItemProps {
  block: BlockRow
  original: BlockRow | undefined
  isExpanded: boolean
  isSelected: boolean
  deviceName: string | undefined
  onToggleExpanded: (id: string) => void
  onToggleSelected: (id: string) => void
  onKeep: (block: BlockRow) => void
  onDiscard: (blockId: string) => void
  onViewOriginal: (parentId: string, title: string) => void
}

export function ConflictListItem({
  block,
  original,
  isExpanded,
  isSelected,
  deviceName,
  onToggleExpanded,
  onToggleSelected,
  onKeep,
  onDiscard,
  onViewOriginal,
}: ConflictListItemProps): React.ReactElement {
  const { t } = useTranslation()
  const conflictType = inferConflictType(block, original)

  return (
    <li
      className="conflict-item flex items-start justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50 active:bg-accent/70"
      data-testid="conflict-item"
    >
      <label
        className="flex items-center shrink-0 mr-2"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === ' ') e.stopPropagation()
        }}
      >
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggleSelected(block.id)}
          aria-label={t('conflict.selectConflictLabel', { id: truncateId(block.id) })}
          className="h-4 w-4 rounded border-muted-foreground/50 [@media(pointer:coarse)]:size-11"
        />
      </label>
      <button
        type="button"
        className="conflict-item-content flex min-w-0 flex-col gap-1 text-left flex-1 cursor-pointer bg-transparent border-none p-0"
        onClick={() => onToggleExpanded(block.id)}
        aria-expanded={isExpanded}
        aria-label={isExpanded ? t('conflict.collapse') : t('conflict.expand')}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <ChevronToggle isExpanded={isExpanded} size="md" />
          <Badge variant="secondary" className="conflict-item-type shrink-0">
            {block.block_type}
          </Badge>
          <Badge
            variant="outline"
            className={cn('conflict-type-badge shrink-0', conflictTypeBadgeClass(conflictType))}
            aria-label={t(`conflict.type${conflictType}`)}
          >
            {conflictType}
          </Badge>
        </div>
        <div className="conflict-metadata flex items-center gap-2 text-xs text-muted-foreground">
          <span className="conflict-source-id font-mono" title={block.id}>
            ID: {truncateId(block.id)}
          </span>
          <span className="conflict-timestamp">{getConflictTimestamp(block)}</span>
          {deviceName != null && (
            <span className="conflict-device" title={t('conflicts.sourceDevice')}>
              From: {deviceName}
            </span>
          )}
        </div>
        <ConflictTypeRenderer
          conflictType={conflictType}
          block={block}
          original={original}
          isExpanded={isExpanded}
        />
      </button>
      <div className="conflict-item-actions flex items-center gap-2 ml-2 shrink-0 flex-wrap">
        {block.parent_id && (
          <Button
            variant="ghost"
            size="sm"
            className="conflict-view-original-btn"
            aria-label={t('conflict.viewOriginalLabel', { id: truncateId(block.id) })}
            onClick={() => onViewOriginal(block.parent_id as string, block.content ?? 'Untitled')}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View original
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="conflict-keep-btn touch-target"
          data-testid="conflict-keep-btn"
          onClick={() => onKeep(block)}
          aria-label={t('conflict.keepIncomingLabel', { id: truncateId(block.id) })}
        >
          <Check className="h-3.5 w-3.5" />
          {t('conflict.keepLabel')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          className="conflict-discard-btn touch-target"
          data-testid="conflict-discard-btn"
          onClick={() => onDiscard(block.id)}
          aria-label={t('conflict.discardConflictLabel', { id: truncateId(block.id) })}
        >
          <X className="h-3.5 w-3.5" />
          {t('conflict.discardLabel')}
        </Button>
      </div>
    </li>
  )
}
