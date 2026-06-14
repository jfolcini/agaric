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
 * #1065 — `discardDraft` ALSO records the block id in a synchronous
 * `discardedRef` set. Effect B's cleanup consults that set and skips the
 * flush for any discarded block, regardless of whether the cleanup is driven
 * by a re-render-to-null (blur) or by a bare unmount that coincides with blur
 * while `isFocused` is still true (so `blockIdRef` still holds the id). This
 * closes the window where a coinciding unmount could flush the ~2s-stale
 * debounced draft as the LATEST `edit_block` op while `discardDraft`'s
 * `deleteDraft` is still backing off on `pool_busy` — a silent content
 * regression. (The version counter alone is insufficient here: it is also
 * bumped by every normal save cycle.) Effect A clears the marker on a genuine
 * fresh save, so a real edit made after a discard is not suppressed.
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
  // #1065 — per-block "discarded" markers. Set synchronously by
  // `discardDraft`, consulted by Effect B's cleanup to skip the flush, and
  // cleared by Effect A on a genuine fresh save (so a later real edit is not
  // suppressed).
  const discardedRef = useRef<Set<string>>(new Set())

  // Effect A — debounced saveDraft. Re-runs on every content change (i.e.
  // every keystroke); its cleanup ONLY clears the pending timer. It must
  // never flush: flushing here would fire one write-lock-acquiring
  // `flush_draft` IPC per keystroke (#715).
  useEffect(() => {
    if (!blockId || !content) return

    const capturedVersion = ++versionRef.current

    timerRef.current = setTimeout(() => {
      if (versionRef.current !== capturedVersion) return // stale — discardDraft was called
      // #1065 — a genuine fresh save for this block clears any prior
      // "discarded" marker so a real edit made after a discard can flush.
      discardedRef.current.delete(blockId)
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
  //
  // #1065 — additionally skip the flush when this block was discarded
  // (`discardedRef.current.has(blockId)`). This covers the unmount-coincides-
  // with-blur case where `blockIdRef` still holds the id, which the
  // null-ref check above would NOT catch — preventing the stale draft from
  // racing `discardDraft`'s in-flight `deleteDraft`.
  useEffect(() => {
    if (!blockId) return
    // Capture the discarded-marker Set up front: it is mutated in place
    // (add/delete) and never reassigned, so the cleanup observes the latest
    // membership without reading `discardedRef.current` directly at teardown.
    const discarded = discardedRef.current
    return () => {
      if (blockIdRef.current === null) return
      if (discarded.has(blockId)) return
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
      // #1065 — mark this block discarded so Effect B's cleanup skips the
      // flush even if an unmount coincides with blur (blockIdRef still set).
      discardedRef.current.add(id)
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
