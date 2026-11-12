/**
 * useTaskStateCycle — moves a task in a list row (Due panel, Agenda) to its
 * next state, the step a click on a block's checkbox takes (#6544). The row's
 * list refetches on the property-change event the write emits.
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { announce } from '@/lib/announcer'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { reportIpcError } from '@/lib/report-ipc-error'
import { nextTaskState, TASK_STATE_LABEL_KEYS } from '@/lib/task-states'

/** Returns `(blockId, current) => …`, which never rejects: a refused write is reported. */
export function useTaskStateCycle(): (blockId: string, current: string) => Promise<void> {
  const { t } = useTranslation()
  return useCallback(
    async (blockId: string, current: string) => {
      const next = nextTaskState(current)
      try {
        unwrap(await commands.setTodoState(blockId, next))
        announce(t('announce.taskState', { state: next ? t(TASK_STATE_LABEL_KEYS[next]) : 'none' }))
      } catch (err) {
        reportIpcError('useTaskStateCycle', 'blockTree.setTaskStateFailed', err, t, {
          blockId,
          next,
        })
      }
    },
    [t],
  )
}
