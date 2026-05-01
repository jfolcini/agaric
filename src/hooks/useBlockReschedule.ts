/**
 * useBlockReschedule — typed wrappers around setDueDate / setScheduledDate.
 *
 * Centralizes the per-block reschedule IPC calls so consumers don't
 * import directly from `src/lib/tauri`. Each callback wraps the IPC
 * with structured logger.warn on failure (no silent .catch()) and
 * re-throws so callers retain their existing error handling.
 *
 * MAINT-131 — closes the last hook-wrap row. Pairs with usePropertySave
 * and useBatchAttachments. The `reschedule()` method (added in the
 * MAINT-131 final pass) folds the duplicated "decide due vs
 * scheduled, then setX" pattern that previously lived in
 * `BlockListItem` and `RescheduleDropZone` into one place — both
 * consumers used to call `getBlock(blockId)` to inspect
 * `due_date`/`scheduled_date`, then dispatch to the appropriate
 * setter, with identical fall-back semantics on `getBlock` failure
 * (default to setDueDate). The shared logic now owns that decision
 * and exposes it as a single async call.
 */

import { useCallback } from 'react'
import { logger } from '../lib/logger'
import { getBlock, setDueDate, setScheduledDate } from '../lib/tauri'

export type RescheduleField = 'due_date' | 'scheduled_date'

export interface RescheduleResult {
  /** Which date field was actually written. Callers can use this to render the right confirmation copy. */
  field: RescheduleField
}

export interface UseBlockRescheduleReturn {
  /** Set or clear (date=null) the due_date property for a block. Throws on failure (callers should handle). */
  setDueDate: (blockId: string, date: string | null) => Promise<void>
  /** Set or clear (date=null) the scheduled_date property for a block. Throws on failure. */
  setScheduledDate: (blockId: string, date: string | null) => Promise<void>
  /**
   * Reschedule a block to `date`, picking the field based on the
   * block's current shape:
   *
   *   - if the block has `scheduled_date` set AND `due_date` unset →
   *     write `scheduled_date`;
   *   - otherwise → write `due_date`.
   *
   * On `getBlock` failure (block not found, IPC drop, …) the lookup
   * is logged at `warn` level and we fall back to `due_date`. The
   * returned `field` reflects the field actually written so callers
   * can branch their toast / announce copy. Throws if the underlying
   * setter fails.
   */
  reschedule: (blockId: string, date: string) => Promise<RescheduleResult>
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

  const reschedule = useCallback(
    async (blockId: string, date: string): Promise<RescheduleResult> => {
      let useScheduledDate = false
      try {
        const block = await getBlock(blockId)
        if (block.scheduled_date && !block.due_date) {
          useScheduledDate = true
        }
      } catch (err) {
        logger.warn(
          'useBlockReschedule',
          'reschedule getBlock lookup failed; falling back to setDueDate',
          { blockId },
          err,
        )
      }
      if (useScheduledDate) {
        await setScheduled(blockId, date)
        return { field: 'scheduled_date' }
      }
      await setDue(blockId, date)
      return { field: 'due_date' }
    },
    [setDue, setScheduled],
  )

  return { setDueDate: setDue, setScheduledDate: setScheduled, reschedule }
}
