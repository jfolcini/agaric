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
import { ScrollArea } from '@/components/ui/scroll-area'
import { truncateId } from '@/lib/format'
import { useRichContentCallbacks } from '../hooks/useRichContentCallbacks'
import type { BlockRow } from '../lib/tauri'
import { renderRichContent } from './StaticBlock'

export interface ConflictTypeRendererProps {
  conflictType: 'Text' | 'Property' | 'Move'
  block: BlockRow
  original: BlockRow | undefined
  isExpanded: boolean
}

// ---------------------------------------------------------------------------
// Helpers — per-field property diff rows
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
type TFunc = (...args: any[]) => any

interface FieldDiff {
  key: string
  labelKey: string
  prev: string | null | undefined
  next: string | null | undefined
}

/** Collect diffs for all mutable metadata fields on a property conflict. */
function collectPropertyDiffs(block: BlockRow, original: BlockRow): FieldDiff[] {
  const diffs: FieldDiff[] = []
  if (block.todo_state !== original.todo_state) {
    diffs.push({
      key: 'state',
      labelKey: 'conflict.propertyState',
      prev: original.todo_state,
      next: block.todo_state,
    })
  }
  if (block.priority !== original.priority) {
    diffs.push({
      key: 'priority',
      labelKey: 'conflict.propertyPriority',
      prev: original.priority,
      next: block.priority,
    })
  }
  if (block.due_date !== original.due_date) {
    diffs.push({
      key: 'due',
      labelKey: 'conflict.propertyDue',
      prev: original.due_date,
      next: block.due_date,
    })
  }
  if (block.scheduled_date !== original.scheduled_date) {
    diffs.push({
      key: 'sched',
      labelKey: 'conflict.propertyScheduled',
      prev: original.scheduled_date,
      next: block.scheduled_date,
    })
  }
  return diffs
}

function PropertyDiffRow({ diff, t }: { diff: FieldDiff; t: TFunc }): React.ReactElement {
  return (
    <div key={diff.key}>
      {t(diff.labelKey)}
      <span className="text-muted-foreground">{diff.prev ?? '(none)'}</span>
      {' \u2192 '}
      <span className="font-medium">{diff.next ?? '(none)'}</span>
    </div>
  )
}

/** Render property conflict diff list. Caller must ensure `diffs` is non-empty. */
function PropertyConflictDiff({
  diffs,
  contentChanged,
  t,
}: {
  diffs: FieldDiff[]
  contentChanged: boolean
  t: TFunc
}): React.ReactElement {
  return (
    <div className="conflict-property-diff text-sm">
      <span className="font-medium text-op-edit-foreground">{t('conflict.propertyChanges')}</span>
      <div className="mt-1 space-y-0.5 text-xs">
        {diffs.map((d) => (
          <PropertyDiffRow key={d.key} diff={d} t={t} />
        ))}
        {contentChanged && <div key="content">{t('conflict.contentAlsoChanged')}</div>}
      </div>
    </div>
  )
}

/** Render move-conflict diff (parent and/or position changes). */
function MoveConflictDiff({
  block,
  original,
  t,
}: {
  block: BlockRow
  original: BlockRow
  t: TFunc
}): React.ReactElement {
  return (
    <div className="conflict-move-diff text-sm">
      <span className="font-medium text-conflict-move-foreground">
        {t('conflict.moveConflictHeader')}
      </span>
      <div className="mt-1 space-y-0.5 text-xs">
        {block.parent_id !== original.parent_id && (
          <div>
            {t('conflict.moveParent')}{' '}
            <span className="font-mono text-muted-foreground">
              {truncateId(original.parent_id ?? '?')}
            </span>
            {' \u2192 '}
            <span className="font-mono font-medium">{truncateId(block.parent_id ?? '?')}</span>
          </div>
        )}
        {block.position !== original.position && (
          <div>
            {t('conflict.movePosition')}
            {original.position ?? '?'} \u2192 {block.position ?? '?'}
          </div>
        )}
      </div>
    </div>
  )
}

/** Render default text conflict (Current:/Incoming:). */
function TextConflictView({
  block,
  original,
  isExpanded,
  t,
  callbacks,
}: {
  block: BlockRow
  original: BlockRow | undefined
  isExpanded: boolean
  t: TFunc
  callbacks: ReturnType<typeof useRichContentCallbacks>
}): React.ReactElement {
  const originalContent = (
    <>
      <span className="font-medium text-muted-foreground">{t('conflict.currentLabel')}</span>{' '}
      {original ? (
        original.content ? (
          <span>{renderRichContent(original.content, { interactive: false, ...callbacks })}</span>
        ) : (
          t('conflict.emptyContent')
        )
      ) : (
        t('conflict.originalNotAvailable')
      )}
    </>
  )

  const incomingContent = (
    <>
      <span className="font-medium">{t('conflict.incomingLabel')}</span>{' '}
      <span className="conflict-item-text">
        {block.content
          ? renderRichContent(block.content, { interactive: false, ...callbacks })
          : t('conflict.emptyContent')}
      </span>
    </>
  )

  return (
    <>
      {isExpanded ? (
        <ScrollArea className="conflict-original text-sm max-h-40">{originalContent}</ScrollArea>
      ) : (
        <div className="conflict-original text-sm truncate">{originalContent}</div>
      )}
      {isExpanded ? (
        <ScrollArea className="conflict-incoming text-sm max-h-40">{incomingContent}</ScrollArea>
      ) : (
        <div className="conflict-incoming text-sm truncate">{incomingContent}</div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ConflictTypeRenderer({
  conflictType,
  block,
  original,
  isExpanded,
}: ConflictTypeRendererProps): React.ReactElement | null {
  const { t } = useTranslation()
  const callbacks = useRichContentCallbacks()

  if (conflictType === 'Property' && original) {
    const diffs = collectPropertyDiffs(block, original)
    if (diffs.length > 0) {
      return (
        <PropertyConflictDiff
          diffs={diffs}
          contentChanged={block.content !== original.content}
          t={t}
        />
      )
    }
    // Fall through to text rendering if no diffs detected
  }

  if (conflictType === 'Move' && original) {
    return <MoveConflictDiff block={block} original={original} t={t} />
  }

  return (
    <TextConflictView
      block={block}
      original={original}
      isExpanded={isExpanded}
      t={t}
      callbacks={callbacks}
    />
  )
}
