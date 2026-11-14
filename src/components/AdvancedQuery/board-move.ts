/**
 * One write of a block's value from a query view, and the two ways to take it
 * back: moving a board card (#6542) and committing a query table cell (#6743).
 * The write joins the undo stack of the block's page, so that page's own undo
 * reverses it, and the toast's Undo reverses it from the view.
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

/** A task state when `propertyKey` is absent, else that property; no `value` clears it. */
export type BlockValueTarget = Pick<BoardColumn, 'propertyKey' | 'value'>

/** Every board column and inline query re-reads: rows, counts and summaries. */
function refetchQueries(): void {
  void queryClient.invalidateQueries({ queryKey: ['advancedQuery'] })
  void queryClient.invalidateQueries({ queryKey: ['queryExecution'] })
}

async function writeValue(blockId: string, target: BlockValueTarget): Promise<OpRef[]> {
  const { propertyKey, value = null } = target
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

async function undoWrite(
  pageId: string | null,
  refs: OpRef[],
  entry: UndoStackEntry | undefined,
): Promise<void> {
  if (pageId !== null && entry !== undefined && latestUndoEntry(pageId) === entry) {
    await performPageUndo(pageId)
  } else {
    // A later change sits above the write on its page's stack. Reversing the
    // write's own ops appends ops that stack does not hold, so it starts over.
    try {
      unwrap(await commands.undoOps(refs.toReversed()))
      notify(t('undo.undoneMessage'), { duration: 1500 })
    } catch (err) {
      logger.warn('board-move', 'undoing a value write failed', { pageId }, err)
      notify.error(t('undo.undoFailedMessage'))
      return
    }
    if (pageId !== null) {
      useUndoStore.getState().reanchorAfterRemoteOps(pageId)
      reloadChangedPageStores([pageId], { reanchorUndo: false })
    }
  }
  refetchQueries()
}

/**
 * After a write of `block` that appended `refs`: put it on the page's undo
 * stack, re-read the queries, and say `message` in a toast that offers Undo.
 */
export function recordBlockWrite(block: BlockRow, refs: OpRef[], message: string): void {
  const pageId = block.page_id
  let entry: UndoStackEntry | undefined
  if (pageId !== null && refs.length > 0) {
    useUndoStore.getState().onNewAction(pageId, refs, undefined, { merge: false })
    entry = latestUndoEntry(pageId)
    reloadChangedPageStores([pageId], { reanchorUndo: false })
  }
  refetchQueries()
  notify(message, {
    // A write that appended nothing has nothing to take back.
    ...(refs.length > 0 && {
      action: {
        label: t('action.undo'),
        onClick: () => void undoWrite(pageId, refs, entry),
      },
    }),
  })
}

/** Give `block` the target's value, then `recordBlockWrite`; a failure is the `failed` toast. */
export async function writeBlockValue(
  block: BlockRow,
  target: BlockValueTarget,
  toasts: { done: string; failed: string },
): Promise<void> {
  let refs: OpRef[]
  try {
    refs = await writeValue(block.id, target)
  } catch (err) {
    logger.warn('board-move', 'writing a block value failed', { blockId: block.id, target }, err)
    notify.error(toasts.failed)
    return
  }
  recordBlockWrite(block, refs, toasts.done)
}

/**
 * Move `block` to `column` (the one with no value clears it) and say so in a
 * toast that names the column by `columnLabel`.
 */
export function moveCard(block: BlockRow, column: BoardColumn, columnLabel: string): Promise<void> {
  return writeBlockValue(block, column, {
    done: t('advancedQuery.board.moved', { column: columnLabel }),
    failed: t('advancedQuery.board.moveFailed'),
  })
}
