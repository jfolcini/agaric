import { useEffect, useRef } from 'react'

import { isPoolBusy, retryOnPoolBusy } from '@/lib/app-error'
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
 *
 * Issue #106 — every IPC call here is wrapped in {@link retryOnPoolBusy}.
 * The sqlx connection pool can transiently return `pool_busy` under load
 * (every write holds a connection for the duration of its
 * transaction); a short backoff lets autosave ride out that blip
 * silently rather than logging a misleading "saveDraft failed" warning
 * on every key release.
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
      retryOnPoolBusy(() => saveDraft(blockId, content), {
        onRetry: (attempt) => {
          logger.debug('useDraftAutosave', 'retrying saveDraft (pool_busy)', {
            blockId,
            attempt,
          })
        },
      }).catch((err: unknown) => {
        // After exhausting the pool_busy retries the helper bubbles the
        // last error untouched, so `database` / exhausted `pool_busy`
        // both land here. Keep the existing log-only behaviour (autosave
        // is best-effort; the user retries by typing one more char).
        const label = isPoolBusy(err) ? 'saveDraft exhausted pool_busy retries' : 'saveDraft failed'
        logger.warn('useDraftAutosave', label, { blockId }, err)
      })
    }, 2000)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (blockIdRef.current) {
        const id = blockIdRef.current
        retryOnPoolBusy(() => flushDraft(id)).catch((err: unknown) => {
          logger.warn(
            'useDraftAutosave',
            'flushDraft failed',
            {
              blockId: id ?? '',
            },
            err,
          )
        })
      }
    }
  }, [blockId, content])

  /** Call after a successful normal save to discard the draft without flushing. */
  const discardDraft = () => {
    versionRef.current++ // invalidate any pending save
    if (timerRef.current) clearTimeout(timerRef.current)
    if (blockIdRef.current) {
      const id = blockIdRef.current
      retryOnPoolBusy(() => deleteDraft(id)).catch((err: unknown) => {
        logger.warn(
          'useDraftAutosave',
          'deleteDraft failed during discard',
          {
            blockId: id ?? '',
          },
          err,
        )
      })
    }
  }

  return { discardDraft }
}
