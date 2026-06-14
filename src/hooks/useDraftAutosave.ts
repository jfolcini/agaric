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
  // #770 gap 2 — the latest live editor content, mirrored into a ref so
  // Effect B's unmount-while-focused cleanup can persist the most recent
  // keystrokes BEFORE flushing. Without this, only the ≤2 s-stale debounced
  // `saveDraft` row is flushed and any typing since the last debounce tick is
  // lost on an unmount (page switch / journal day remount).
  const contentRef = useRef(content)
  contentRef.current = content
  // #770 gap 3 — track the (blockId, content) Effect A last observed so it can
  // distinguish a genuine "user cleared the text" transition (same block,
  // non-empty → empty) from a block that merely STARTED empty (fresh focus /
  // refocus, or a switch landing on an empty block). Updated INSIDE Effect A
  // (never during render) so it stays consistent with that effect's run
  // cadence and out of any dependency array.
  const lastSeenRef = useRef<{ blockId: string | null; content: string }>({ blockId, content })
  const versionRef = useRef(0)
  // #1065 — per-block "discarded" markers. Set synchronously by
  // `discardDraft`, consulted by Effect B's cleanup to skip the flush, and
  // cleared by Effect A on a genuine fresh save (so a later real edit is not
  // suppressed).
  const discardedRef = useRef<Set<string>>(new Set())

  /**
   * Discard the current block's draft: cancel any pending save, mark the
   * block discarded (#1065), and fire `deleteDraft`. Defined ahead of the
   * effects so Effect A's empty-content path (#770 gap 3) can reuse it.
   *
   * Takes the target id explicitly so the empty-content path can discard the
   * block it observed in render (rather than `blockIdRef.current`, which is
   * already correct here but kept explicit for clarity at the two call sites).
   */
  const discardDraftFor = (id: string) => {
    versionRef.current++ // invalidate any pending save
    if (timerRef.current) clearTimeout(timerRef.current)
    // #1065 — mark this block discarded so Effect B's cleanup skips the
    // flush even if an unmount coincides with blur (blockIdRef still set).
    discardedRef.current.add(id)
    retryOnPoolBusy(() => deleteDraft(id)).catch((err: unknown) => {
      logger.warn('useDraftAutosave', 'deleteDraft failed during discard', { blockId: id }, err)
    })
  }

  // Effect A — debounced saveDraft. Re-runs on every content change (i.e.
  // every keystroke); its cleanup ONLY clears the pending timer. It must
  // never flush: flushing here would fire one write-lock-acquiring
  // `flush_draft` IPC per keystroke (#715).
  useEffect(() => {
    // Snapshot what the previous Effect A run observed, then record this run's
    // (blockId, content) for the next one. Done first so every early-return
    // path below still advances the marker.
    const lastSeen = lastSeenRef.current
    lastSeenRef.current = { blockId, content }

    if (!blockId) return

    // #770 gap 3 — emptying a block's text must NOT leave the previous draft
    // row behind. The early-return on empty content used to strand a stale
    // row that a hard kill would resurrect as old text at boot
    // (`flush_all_drafts` → `edit_block`). User intent on emptying is "this
    // block is now blank", so treat a genuine clear as a discard: drop the row
    // and mark the block discarded so the unmount flush is suppressed too.
    if (!content) {
      // Discard ONLY on a genuine clear: the SAME block went from non-empty
      // to empty. A block that merely STARTED empty (fresh focus / refocus, or
      // a block→block switch landing on an empty block) must not discard —
      // there is no user-authored row to drop, and firing a discard there
      // would set the #1065 marker and wrongly suppress a later unmount flush
      // (regressing #715's refocus test).
      const userCleared = lastSeen.blockId === blockId && lastSeen.content !== ''
      if (userCleared) discardDraftFor(blockId)
      return
    }

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
      // #770 gap 2 — final save of the latest live content before the flush,
      // scoped to the UNMOUNT-WHILE-FOCUSED path only.
      //
      // Effect B fires its cleanup on two paths: a block switch (a re-render
      // moved `blockId` to another id) and an unmount while focused (no
      // re-render — `blockIdRef.current` still equals this closure's
      // `blockId`). `contentRef.current` mirrors the CURRENT render's content,
      // so on a block switch it has ALREADY advanced to the NEW block's text;
      // saving it into the OLD block's draft row here would corrupt the old
      // block (it would be flushed as `edit_block(oldBlock, newBlockText)`).
      // The block-switch path's flush must therefore read the existing stored
      // row untouched — the editor content for the old block was already
      // persisted by `useEditorBlur`/`persistUnmount`'s `edit_block` on the
      // way out. We only do the final save when `blockIdRef.current === blockId`
      // (the unmount path), where `contentRef.current` genuinely is this
      // block's latest live content.
      //
      // On the unmount path the debounced `saveDraft` row may be up to ~2 s
      // behind the editor, so we persist `contentRef.current` AND ensure it
      // lands in `block_drafts` BEFORE `flush_draft_inner`'s `BEGIN IMMEDIATE`
      // reads the row. The write pool is `max_connections(2)`, NOT a single
      // serialized writer, and Tauri v2 spawns each command as an independent
      // async task, so firing `saveDraft` and `flushDraft` as two un-awaited
      // calls does NOT guarantee the save's INSERT runs before the flush's
      // `BEGIN IMMEDIATE` acquires the write lock — e.g. if `saveDraft` is in
      // its `pool_busy` backoff while `flushDraft` grabs the free connection,
      // the flush reads the OLD row. So we CHAIN: only dispatch the flush once
      // the save's IPC promise has resolved (the autocommit INSERT committed).
      //
      // Empty content is handled by Effect A's discard path (#770 gap 3) —
      // which sets the discarded marker, so we never reach here with empty
      // content for that block.
      const isUnmountWhileFocused = blockIdRef.current === blockId
      const latest = contentRef.current
      const ensureSaved =
        isUnmountWhileFocused && latest
          ? retryOnPoolBusy(() => saveDraft(blockId, latest)).catch((err: unknown) => {
              logger.warn(
                'useDraftAutosave',
                'final saveDraft before flush failed',
                { blockId },
                err,
              )
            })
          : Promise.resolve()
      void ensureSaved.then(() =>
        retryOnPoolBusy(() => flushDraft(blockId)).catch((err: unknown) => {
          logger.warn('useDraftAutosave', 'flushDraft failed', { blockId }, err)
        }),
      )
    }
  }, [blockId])

  /** Call after a successful normal save to discard the draft without flushing. */
  const discardDraft = () => {
    if (blockIdRef.current) discardDraftFor(blockIdRef.current)
  }

  return { discardDraft }
}
