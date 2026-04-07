import { useEffect, useRef } from 'react'

import { logger } from '@/lib/logger'
import { deleteDraft, flushDraft, saveDraft } from '@/lib/tauri'

/**
 * Autosave hook for block draft content.
 *
 * Debounces `saveDraft` calls with a 2-second interval while the user is
 * typing. On blur / unmount the pending draft is flushed (written as an
 * `edit_block` op and removed from the drafts table).
 *
 * Call `discardDraft()` after a successful normal save to remove the draft
 * row without flushing it as an op.
 *
 * A version counter prevents the race condition where a previously-dispatched
 * `saveDraft` completes after `discardDraft` has already deleted the draft.
 */
export function useDraftAutosave(blockId: string | null, content: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blockIdRef = useRef(blockId)
  blockIdRef.current = blockId
  const versionRef = useRef(0)

  useEffect(() => {
    if (!blockId || !content) return

    if (timerRef.current) clearTimeout(timerRef.current)

    const capturedVersion = ++versionRef.current

    timerRef.current = setTimeout(() => {
      if (versionRef.current !== capturedVersion) return // stale — discardDraft was called
      saveDraft(blockId, content).catch((err: unknown) => {
        logger.warn('useDraftAutosave', 'saveDraft failed', { blockId, error: String(err) })
      })
    }, 2000)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (blockIdRef.current) {
        flushDraft(blockIdRef.current).catch((err: unknown) => {
          logger.warn('useDraftAutosave', 'flushDraft failed', {
            blockId: blockIdRef.current ?? '',
            error: String(err),
          })
        })
      }
    }
  }, [blockId, content])

  /** Call after a successful normal save to discard the draft without flushing. */
  const discardDraft = () => {
    versionRef.current++ // invalidate any pending save
    if (timerRef.current) clearTimeout(timerRef.current)
    if (blockIdRef.current) {
      deleteDraft(blockIdRef.current).catch(() => {})
    }
  }

  return { discardDraft }
}
