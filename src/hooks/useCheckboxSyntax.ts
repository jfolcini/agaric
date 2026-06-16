/**
 * Checkbox-syntax handler — invoked when the user types `[x]` / `[ ]` inline
 * and the editor converts it into a TODO/DONE state change.
 *
 * Extracted from `useBlockSlashCommands` so the main orchestrator stays
 * focused on slash-command dispatch. Mirrors the TODO/DONE logic from the
 * `/todo` and `/done` slash commands, including the F-37 dependency warning
 * on completion.
 */

import type { TFunction } from 'i18next'
import { useCallback, useRef } from 'react'
import type { StoreApi } from 'zustand'

import { notify } from '@/lib/notify'

import { logger } from '../lib/logger'
import { getProperty, setTodoState as setTodoStateCmd } from '../lib/tauri'
import type { PageBlockState } from '../stores/page-blocks'
import { useUndoStore } from '../stores/undo'

export interface UseCheckboxSyntaxParams {
  focusedBlockId: string | null
  rootParentId: string | null
  pageStore: StoreApi<PageBlockState>
  t: TFunction
}

export type CheckboxSyntaxHandler = (state: 'TODO' | 'DONE') => void

export function useCheckboxSyntax({
  focusedBlockId,
  rootParentId,
  pageStore,
  t,
}: UseCheckboxSyntaxParams): CheckboxSyntaxHandler {
  // Re-entrancy guard: prevents a rapid double-invocation on the same block
  // from queueing two in-flight `setTodoStateCmd` calls, whose error-path
  // rollbacks would both restore the (now stale) `priorTodoState` snapshot.
  const inProgress = useRef(false)

  return useCallback(
    (state: 'TODO' | 'DONE') => {
      if (!focusedBlockId) return
      if (inProgress.current) return
      inProgress.current = true
      // FE-H-7: snapshot prior todo_state so the optimistic mutation can be
      // reverted if `setTodoStateCmd` rejects.
      const priorTodoState = pageStore.getState().blocksById.get(focusedBlockId)?.todo_state ?? null
      setTodoStateCmd(focusedBlockId, state)
        .then(() => {
          if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
          // F-37: warn when completing a task that has unresolved dependencies.
          // PEND-35 Tier 2.4c — single-key PK lookup; the check only
          // needs the `blocked_by` row, not the full vocabulary.
          if (state === 'DONE') {
            getProperty(focusedBlockId, 'blocked_by')
              .then((row) => {
                const hasBlockedBy = row != null && row.value_ref != null
                if (hasBlockedBy) {
                  notify.warning(t('dependency.dependencyWarning'), { id: 'dependency-warning' })
                }
              })
              .catch((err) => {
                logger.warn('useCheckboxSyntax', 'checkbox dependency check failed', undefined, err)
              })
          }
        })
        .catch((err) => {
          logger.error('useCheckboxSyntax', 'setTodoState failed', { focusedBlockId, state }, err)
          notify.error(t('blockTree.setTaskStateFailed'))
          // FE-H-7: revert the optimistic mutation so UI state stays in sync
          // with the backend after a rejected `setTodoStateCmd`.
          pageStore.setState((s) => ({
            blocks: s.blocks.map((b) =>
              b.id === focusedBlockId ? { ...b, todo_state: priorTodoState } : b,
            ),
          }))
        })
        .finally(() => {
          // Reset the re-entrancy guard once the in-flight call settles so a
          // subsequent checkbox toggle on the same block is allowed.
          inProgress.current = false
        })
      pageStore.setState((s) => ({
        blocks: s.blocks.map((b) => (b.id === focusedBlockId ? { ...b, todo_state: state } : b)),
      }))
    },
    [focusedBlockId, rootParentId, t, pageStore],
  )
}
