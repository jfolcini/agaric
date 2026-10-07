/**
 * useBlockReschedule — typed wrappers around setDueDate / setScheduledDate.
 *
 * Centralizes the per-block reschedule IPC calls so consumers don't
 * call the generated bindings directly. Each callback wraps the IPC
 * with structured logger.warn on failure (no silent .catch()) and
 * re-throws so callers retain their existing error handling.
 *
 * Closes the last hook-wrap row. Pairs with usePropertySave
 * and useBatchAttachments. The `reschedule()` method (added in the
 * Final pass) folds the duplicated "decide due vs
 * scheduled, then setX" pattern that previously lived in
 * `BlockListItem` and `RescheduleDropZone` into one place — both
 * consumers used to call `getBlock(blockId)` to inspect
 * `due_date`/`scheduled_date`, then dispatch to the appropriate
 * setter, with identical fall-back semantics on `getBlock` failure
 * (default to setDueDate). The shared logic now owns that decision
 * and exposes it as a single async call.
 */

import { useCallback } from 'react'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { forEachPageStore, storeOwnsBlock } from '@/stores/page-blocks'

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
   * can branch their toast / announce copy. On success the written
   * field is patched into every mounted page store that owns the block.
   * Throws if the underlying setter fails, leaving those stores untouched.
   */
  reschedule: (blockId: string, date: string) => Promise<RescheduleResult>
}

// Date chips read the native date column from the page store, and no
// `block:properties-changed` target writes native columns back into it (#5288).
function patchOwningPageStores(blockId: string, field: RescheduleField, date: string): void {
  forEachPageStore((_pageId, store) => {
    if (!storeOwnsBlock(store, blockId)) return
    store.setState((s) => ({
      blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, [field]: date } : b)),
    }))
  })
}

export function useBlockReschedule(): UseBlockRescheduleReturn {
  const setDue = useCallback(async (blockId: string, date: string | null) => {
    try {
      unwrap(await commands.setDueDate(blockId, date))
    } catch (err) {
      logger.warn('useBlockReschedule', 'setDueDate failed', { blockId, date }, err)
      throw err
    }
  }, [])

  const setScheduled = useCallback(async (blockId: string, date: string | null) => {
    try {
      unwrap(await commands.setScheduledDate(blockId, date))
    } catch (err) {
      logger.warn('useBlockReschedule', 'setScheduledDate failed', { blockId, date }, err)
      throw err
    }
  }, [])

  const reschedule = useCallback(
    async (blockId: string, date: string): Promise<RescheduleResult> => {
      let useScheduledDate = false
      try {
        const block = unwrap(await commands.getBlock(blockId))
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
      const field: RescheduleField = useScheduledDate ? 'scheduled_date' : 'due_date'
      if (useScheduledDate) await setScheduled(blockId, date)
      else await setDue(blockId, date)
      patchOwningPageStores(blockId, field, date)
      return { field }
    },
    [setDue, setScheduled],
  )

  return { setDueDate: setDue, setScheduledDate: setScheduled, reschedule }
}
