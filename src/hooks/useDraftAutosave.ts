import { useEffect, useRef } from 'react'

import { isPoolBusy, retryOnPoolBusy } from '@/lib/app-error'
import { logger } from '@/lib/logger'
import { deleteDraft, flushDraft, saveDraft } from '@/lib/tauri'

/**
 * Autosave hook for block draft content.
 *
 * Debounces `saveDraft` calls with a 2-second interval while the user is
 * typing. The persisted draft row is flushed (written as an `edit_block` op
 * and removed from the drafts table) ONLY when `blockId` changes to another
 * block or the component unmounts while still focused — never per keystroke
 * (#715: the flush effect is keyed on `blockId` alone, so content changes
 * while the same block stays focused can never trigger a flush; an older
 * persisted draft row is simply superseded by later `saveDraft` writes).
 *
 * Blur is deliberately NOT a flush path: when `blockId` goes to null the
 * caller's blur handler (`useEditorBlur`) has already saved the editor
 * content via `edit_block` and called `discardDraft()`, so flushing here
 * would race that delete and could resurrect stale content as an op.
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

  // Effect A — debounced saveDraft. Re-runs on every content change (i.e.
  // every keystroke); its cleanup ONLY clears the pending timer. It must
  // never flush: flushing here would fire one write-lock-acquiring
  // `flush_draft` IPC per keystroke (#715).
  useEffect(() => {
    if (!blockId || !content) return

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
    }
  }, [blockId, content])

  // Effect B — flush on block change / unmount only. Keyed on `blockId`
  // alone so content changes can never re-trigger it (#715).
  //
  // The cleanup distinguishes its three trigger paths via `blockIdRef`,
  // which the render-phase assignment above has already updated to the
  // NEXT value by the time a re-render-driven cleanup runs:
  // - blur (`blockId` → null): ref is null → skip. `useEditorBlur` has
  //   already saved via `edit_block` and called `discardDraft()`.
  // - block switch (`blockId` → other id): ref is non-null → flush the
  //   OLD block (the closure-captured `blockId`).
  // - unmount while focused: no re-render happened, ref still holds this
  //   `blockId` → flush it. (Unmount while blurred never registers a
  //   cleanup — the effect early-returns on null.)
  useEffect(() => {
    if (!blockId) return
    return () => {
      if (blockIdRef.current === null) return
      retryOnPoolBusy(() => flushDraft(blockId)).catch((err: unknown) => {
        logger.warn('useDraftAutosave', 'flushDraft failed', { blockId }, err)
      })
    }
  }, [blockId])

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
