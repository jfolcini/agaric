/**
 * Moving a board card (#6542): the one write that gives a block the value of
 * the column it goes to, and the two ways to take it back. The write joins the
 * undo stack of the block's page, so that page's own undo reverses it, and the
 * toast's Undo reverses it from the board.
 */

import type { BoardColumn } from '@/components/AdvancedQuery/board-columns'
import { reloadChangedPageStores } from '@/hooks/useSyncEvents'
import { performPageUndo } from '@/hooks/useUndoShortcuts'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { BlockRow, OpRef } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { queryClient } from '@/lib/query-client'
import { latestUndoEntry, type UndoStackEntry, useUndoStore } from '@/stores/undo'

/** Every column re-reads: the card's old and new columns, and their counts and summaries. */
function refetchColumns(): void {
  void queryClient.invalidateQueries({ queryKey: ['advancedQuery'] })
}

/** Give the block the column's value: its task state, or its select property. */
async function writeValue(blockId: string, column: BoardColumn): Promise<OpRef[]> {
  const { propertyKey, value = null } = column
  if (propertyKey === undefined) return unwrap(await commands.setTodoState(blockId, value)).op_refs
  if (value === null) return unwrap(await commands.deleteProperty(blockId, propertyKey)).op_refs
  return unwrap(
    await commands.setProperty(blockId, propertyKey, {
      value_text: value,
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    }),
  ).op_refs
}

async function undoMove(
  pageId: string | null,
  refs: OpRef[],
  entry: UndoStackEntry | undefined,
): Promise<void> {
  if (pageId !== null && entry !== undefined && latestUndoEntry(pageId) === entry) {
    await performPageUndo(pageId)
  } else {
    // A later change sits above the move on its page's stack. Reversing the
    // move's own ops appends ops that stack does not hold, so it starts over.
    try {
      unwrap(await commands.undoOps(refs.toReversed()))
      notify(t('undo.undoneMessage'), { duration: 1500 })
    } catch (err) {
      logger.warn('board-move', 'undoing a card move failed', { pageId }, err)
      notify.error(t('undo.undoFailedMessage'))
      return
    }
    if (pageId !== null) {
      useUndoStore.getState().reanchorAfterRemoteOps(pageId)
      reloadChangedPageStores([pageId], { reanchorUndo: false })
    }
  }
  refetchColumns()
}

/**
 * Move `block` to `column` (the one with no value clears it) and say so in a
 * toast that names the column by `columnLabel`.
 */
export async function moveCard(
  block: BlockRow,
  column: BoardColumn,
  columnLabel: string,
): Promise<void> {
  let refs: OpRef[]
  try {
    refs = await writeValue(block.id, column)
  } catch (err) {
    logger.warn('board-move', 'moving a card failed', { blockId: block.id, column: column.id }, err)
    notify.error(t('advancedQuery.board.moveFailed'))
    return
  }
  const pageId = block.page_id
  let entry: UndoStackEntry | undefined
  if (pageId !== null && refs.length > 0) {
    useUndoStore.getState().onNewAction(pageId, refs, undefined, { merge: false })
    entry = latestUndoEntry(pageId)
    reloadChangedPageStores([pageId], { reanchorUndo: false })
  }
  refetchColumns()
  notify(t('advancedQuery.board.moved', { column: columnLabel }), {
    // A write that appended nothing has nothing to take back.
    ...(refs.length > 0 && {
      action: {
        label: t('action.undo'),
        onClick: () => void undoMove(pageId, refs, entry),
      },
    }),
  })
}
