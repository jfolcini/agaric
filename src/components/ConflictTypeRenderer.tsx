/**
 * ConflictTypeRenderer — type-specific rendering for conflict content.
 *
 * Renders the content area of a conflict item based on its type:
 * - Property conflicts show a diff of changed metadata fields.
 * - Move conflicts show parent/position changes.
 * - Text conflicts (and fallbacks) show Current:/Incoming: content.
 *
 * Extracted from ConflictList.tsx for testability (#651-R3).
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'
import { truncateId } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { BlockRow } from '../lib/tauri'
import { renderRichContent } from './StaticBlock'

export interface ConflictTypeRendererProps {
  conflictType: 'Text' | 'Property' | 'Move'
  block: BlockRow
  original: BlockRow | undefined
  isExpanded: boolean
}

export function ConflictTypeRenderer({
  conflictType,
  block,
  original,
  isExpanded,
}: ConflictTypeRendererProps): React.ReactElement | null {
  const { t } = useTranslation()
  if (conflictType === 'Property' && original) {
    const diffs: React.ReactNode[] = []
    if (block.todo_state !== original.todo_state) {
      diffs.push(
        <div key="state">
          State: <span className="text-muted-foreground">{original.todo_state ?? '(none)'}</span>
          {' \u2192 '}
          <span className="font-medium">{block.todo_state ?? '(none)'}</span>
        </div>,
      )
    }
    if (block.priority !== original.priority) {
      diffs.push(
        <div key="priority">
          Priority: <span className="text-muted-foreground">{original.priority ?? '(none)'}</span>
          {' \u2192 '}
          <span className="font-medium">{block.priority ?? '(none)'}</span>
        </div>,
      )
    }
    if (block.due_date !== original.due_date) {
      diffs.push(
        <div key="due">
          Due: <span className="text-muted-foreground">{original.due_date ?? '(none)'}</span>
          {' \u2192 '}
          <span className="font-medium">{block.due_date ?? '(none)'}</span>
        </div>,
      )
    }
    if (block.scheduled_date !== original.scheduled_date) {
      diffs.push(
        <div key="sched">
          Scheduled:{' '}
          <span className="text-muted-foreground">{original.scheduled_date ?? '(none)'}</span>
          {' \u2192 '}
          <span className="font-medium">{block.scheduled_date ?? '(none)'}</span>
        </div>,
      )
    }
    if (block.content !== original.content) {
      diffs.push(<div key="content">Content also changed</div>)
    }
    if (diffs.length > 0) {
      return (
        <div className="conflict-property-diff text-sm">
          <span className="font-medium text-op-edit-foreground">Property changes</span>
          <div className="mt-1 space-y-0.5 text-xs">{diffs}</div>
        </div>
      )
    }
    // Fall through to text rendering if no diffs detected
  }

  if (conflictType === 'Move' && original) {
    return (
      <div className="conflict-move-diff text-sm">
        <span className="font-medium text-conflict-move-foreground">Move conflict</span>
        <div className="mt-1 space-y-0.5 text-xs">
          {block.parent_id !== original.parent_id && (
            <div>
              Parent:{' '}
              <span className="font-mono text-muted-foreground">
                {truncateId(original.parent_id ?? '?')}
              </span>
              {' \u2192 '}
              <span className="font-mono font-medium">{truncateId(block.parent_id ?? '?')}</span>
            </div>
          )}
          {block.position !== original.position && (
            <div>
              Position: {original.position ?? '?'} \u2192 {block.position ?? '?'}
            </div>
          )}
        </div>
      </div>
    )
  }

  // Default: Text conflict (or fallback)
  return (
    <>
      <div
        className={cn(
          'conflict-original text-sm',
          isExpanded ? 'max-h-40 overflow-y-auto' : 'truncate',
        )}
      >
        <span className="font-medium text-muted-foreground">Current:</span>{' '}
        {original ? (
          original.content ? (
            <span>{renderRichContent(original.content, { interactive: false })}</span>
          ) : (
            t('conflict.emptyContent')
          )
        ) : (
          t('conflict.originalNotAvailable')
        )}
      </div>
      <div
        className={cn(
          'conflict-incoming text-sm',
          isExpanded ? 'max-h-40 overflow-y-auto' : 'truncate',
        )}
      >
        <span className="font-medium">Incoming:</span>{' '}
        <span className="conflict-item-text">
          {block.content
            ? renderRichContent(block.content, { interactive: false })
            : t('conflict.emptyContent')}
        </span>
      </div>
    </>
  )
}
