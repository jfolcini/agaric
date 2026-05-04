/**
 * Checkbox-syntax handler — invoked when the user types `[x]` / `[ ]` inline
 * and the editor converts it into a TODO/DONE state change.
 *
 * Extracted from `useBlockSlashCommands` so the main orchestrator stays
 * focused on slash-command dispatch. Mirrors the TODO/DONE logic from the
 * `/todo` and `/done` slash commands, including the F-37 dependency warning
 * on completion.
 */

import { useCallback } from 'react'
import { toast } from 'sonner'
import type { StoreApi } from 'zustand'
import { logger } from '../lib/logger'
import { getProperties, setTodoState as setTodoStateCmd } from '../lib/tauri'
import type { PageBlockState } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'

export interface UseCheckboxSyntaxParams {
  focusedBlockId: string | null
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  // biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
  t: (...args: any[]) => any
}

export type CheckboxSyntaxHandler = (state: 'TODO' | 'DONE') => void

export function useCheckboxSyntax({
  focusedBlockId,
  rootParentId,
  pageStore,
  t,
}: UseCheckboxSyntaxParams): CheckboxSyntaxHandler {
  return useCallback(
    (state: 'TODO' | 'DONE') => {
      if (!focusedBlockId) return
      // FE-H-7: snapshot prior todo_state so the optimistic mutation can be
      // reverted if `setTodoStateCmd` rejects.
      const priorTodoState = pageStore.getState().blocksById.get(focusedBlockId)?.todo_state ?? null
      setTodoStateCmd(focusedBlockId, state)
        .then(() => {
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          // F-37: warn when completing a task that has unresolved dependencies
          if (state === 'DONE') {
            getProperties(focusedBlockId)
              .then((props) => {
                const hasBlockedBy = props.some(
                  (p) => p.key === 'blocked_by' && p.value_ref != null,
                )
                if (hasBlockedBy) {
                  toast.warning(t('dependency.dependencyWarning'))
                }
              })
              .catch((err) => {
                logger.warn('useCheckboxSyntax', 'checkbox dependency check failed', undefined, err)
              })
          }
        })
        .catch((err) => {
          logger.error('useCheckboxSyntax', 'setTodoState failed', { focusedBlockId, state }, err)
          toast.error(t('blockTree.setTaskStateFailed'))
          // FE-H-7: revert the optimistic mutation so UI state stays in sync
          // with the backend after a rejected `setTodoStateCmd`.
          pageStore.setState((s) => ({
            blocks: s.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, todo_state: priorTodoState } : b,
            ),
          }))
        })
      pageStore.setState((s) => ({
        blocks: s.blocks.map((b) => (b.id === focusedBlockId ? { ...b, todo_state: state } : b)),
      }))
    },
    [focusedBlockId, rootParentId, t, pageStore],
  )
}
