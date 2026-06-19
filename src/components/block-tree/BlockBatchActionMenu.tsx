/**
 * BlockBatchActionMenu — batch operations toolbar for multi-selected blocks.
 *
 * Renders a sticky toolbar when blocks are selected with:
 *   - Count of selected blocks
 *   - TODO state buttons (Clear / TODO / DOING / DONE)
 *   - Delete button with confirmation dialog
 *   - Clear selection button
 *
 * Extracted from BlockTree.tsx for file organization (F-22). Renamed from
 * `BlockContextMenu` to disambiguate from the floating long-press / right-click
 * menu in `src/components/BlockContextMenu.tsx`.
 */

import { Signal, Trash2, X } from 'lucide-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog'
import { Button } from '../ui/button'

interface BlockBatchActionMenuProps {
  selectedBlockIds: string[]
  batchInProgress: boolean
  batchDeleteConfirm: boolean
  onBatchSetTodo: (state: string | null) => void
  /**
   * #1734 — cycle priority across the whole selection. Mirrors the bulk
   * priority path already in the right-click context menu so the discoverable
   * toolbar doesn't teach a lower capability ceiling. Optional: omitted callers
   * (e.g. tests / surfaces without a priority handler) simply hide the button.
   */
  onBatchSetPriority?: (() => void) | undefined
  onBatchDelete: () => void
  onSetBatchDeleteConfirm: (open: boolean) => void
  onClearSelection: () => void
}

export function BlockBatchActionMenu({
  selectedBlockIds,
  batchInProgress,
  batchDeleteConfirm,
  onBatchSetTodo,
  onBatchSetPriority,
  onBatchDelete,
  onSetBatchDeleteConfirm,
  onClearSelection,
}: BlockBatchActionMenuProps): React.ReactElement | null {
  const { t } = useTranslation()
  if (selectedBlockIds.length === 0) return null

  return (
    <>
      <div
        className="batch-toolbar sticky top-0 z-10 flex items-center gap-2 rounded-lg border bg-background/95 backdrop-blur px-3 py-2 mb-2 shadow-(--shadow-resting)"
        data-testid="batch-toolbar"
      >
        <span className="text-sm font-medium tabular-nums">
          {selectedBlockIds.length} {t('blockContext.selected')}
        </span>

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          {[
            { state: null as string | null, label: t('blockContext.clear') },
            { state: 'TODO', label: t('blockContext.todoLabel') },
            { state: 'DOING', label: t('blockContext.doingLabel') },
            { state: 'DONE', label: t('blockContext.doneLabel') },
          ].map(({ state, label }) => (
            <Button
              key={label}
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={batchInProgress}
              onClick={() => onBatchSetTodo(state)}
            >
              {label}
            </Button>
          ))}
        </div>

        {/* #1734 — Priority parity with the bulk context menu: cycle priority
            across the whole selection from the discoverable toolbar. */}
        {onBatchSetPriority ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={batchInProgress}
            onClick={() => onBatchSetPriority()}
          >
            <Signal className="h-3.5 w-3.5 mr-1" />
            {t('contextMenu.cyclePrioritySelected')}
          </Button>
        ) : null}

        <Button
          variant="destructive"
          size="sm"
          disabled={batchInProgress}
          onClick={() => onSetBatchDeleteConfirm(true)}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          {t('blockContext.delete')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => onClearSelection()}
          aria-label={t('history.clearSelectionButton')}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <AlertDialog open={batchDeleteConfirm} onOpenChange={onSetBatchDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('blockContext.deleteConfirmTitle', { count: selectedBlockIds.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('blockContext.deleteConfirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('dialog.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={onBatchDelete}>
              {t('blockContext.deleteConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
