/**
 * useBlockReschedule — typed wrappers around setDueDate / setScheduledDate.
 *
 * Centralizes the per-block reschedule IPC calls so consumers don't
 * import directly from `src/lib/tauri`. Each callback wraps the IPC
 * with structured logger.warn on failure (no silent .catch()) and
 * re-throws so callers retain their existing error handling.
 *
 * MAINT-131 — closes the last hook-wrap row. Pairs with usePropertySave
 * and useBatchAttachments.
 */

import { useCallback } from 'react'
import { logger } from '../lib/logger'
import { setDueDate, setScheduledDate } from '../lib/tauri'

export interface UseBlockRescheduleReturn {
  /** Set or clear (date=null) the due_date property for a block. Throws on failure (callers should handle). */
  setDueDate: (blockId: string, date: string | null) => Promise<void>
  /** Set or clear (date=null) the scheduled_date property for a block. Throws on failure. */
  setScheduledDate: (blockId: string, date: string | null) => Promise<void>
}

export function useBlockReschedule(): UseBlockRescheduleReturn {
  const setDue = useCallback(async (blockId: string, date: string | null) => {
    try {
      await setDueDate(blockId, date)
    } catch (err) {
      logger.warn('useBlockReschedule', 'setDueDate failed', { blockId, date }, err)
      throw err
    }
  }, [])

  const setScheduled = useCallback(async (blockId: string, date: string | null) => {
    try {
      await setScheduledDate(blockId, date)
    } catch (err) {
      logger.warn('useBlockReschedule', 'setScheduledDate failed', { blockId, date }, err)
      throw err
    }
  }, [])

  return { setDueDate: setDue, setScheduledDate: setScheduled }
}
