import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { isPoolBusy, retryOnPoolBusy, unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'

/** Trailing debounce for the per-keystroke `saveDraft` cadence. */
const DRAFT_DEBOUNCE_MS = 2000

/**
 * Max-latency cap on the trailing debounce (finding: continuous typing resets
 * the timer on every keystroke, so an uninterrupted run never persisted a
 * draft row and a webview kill lost the whole run). Once a save has been
 * pending longer than this, it fires immediately instead of re-arming.
 */
const DRAFT_MAX_LATENCY_MS = 5000

/**
 * Autosave hook for block draft content.
 *
 * #2938 — driven by a change SIGNAL (`onContentChange`, called from the
 * editor's `update` event via EditableBlock), NOT by a per-frame mirrored
 * `liveContent` prop. The signal only (re)arms timers; the block's markdown is
 * serialized ON DEMAND from the live roving editor (`rovingEditorRef`) at
 * debounce-fire time and at every flush (unmount, background/close). This
 * removes the per-keystroke serialize + React commit that taxed typing latency.
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
export function useDraftAutosave(
  blockId: string | null,
  rovingEditorRef: RefObject<RovingEditorHandle>,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const blockIdRef = useRef(blockId)
  blockIdRef.current = blockId
  // #2938 — serialize the live editor ON DEMAND (only at debounce-fire / flush
  // time), instead of consuming a per-frame mirrored `liveContent`. `readLive`
  // reads the authoritative markdown from whatever the roving editor currently
  // holds; callers guard block identity so a cross-block read never lands under
  // the wrong id. `isEditorEmpty` is a CHEAP structural check (no serialize)
  // used for the clear-detection transition (#770 gap 3).
  const readLive = useCallback(
    (): string => rovingEditorRef.current?.getMarkdown() ?? '',
    [rovingEditorRef],
  )
  const isEditorEmpty = useCallback(
    (): boolean => rovingEditorRef.current?.editor?.isEmpty ?? true,
    [rovingEditorRef],
  )
  // #770 gap 3 — whether this block has been observed holding non-empty content
  // during the current focus session, so `onContentChange` can distinguish a
  // genuine "user cleared the text" transition (non-empty → empty) from a block
  // that merely STARTED empty (fresh focus / refocus, or a switch landing on an
  // empty block). Reset on every block change by the reset effect below.
  const hadContentRef = useRef(false)
  const versionRef = useRef(0)
  // #1065 — per-block "discarded" markers. Set synchronously by
  // `discardDraft`, consulted by Effect B's cleanup to skip the flush, and
  // cleared by Effect A on a genuine fresh save (so a later real edit is not
  // suppressed).
  const discardedRef = useRef<Set<string>>(new Set())
  // Max-latency cap (see DRAFT_MAX_LATENCY_MS) — when the current continuous
  // typing run first armed a (since-reset) debounce timer; null when no save
  // is pending.
  const pendingSinceRef = useRef<number | null>(null)

  /**
   * Discard the current block's draft: cancel any pending save, mark the
   * block discarded (#1065), and fire `deleteDraft`. Defined ahead of the
   * effects so Effect A's empty-content path (#770 gap 3) can reuse it.
   *
   * Takes the target id explicitly so the empty-content path can discard the
   * block it observed in render (rather than `blockIdRef.current`, which is
   * already correct here but kept explicit for clarity at the two call sites).
   *
   * Findings 2/48 — when the caller dispatched a save during this discard
   * (blur's `edit_block`), it passes the save's outcome promise (`edit`
   * resolves `false` on failure, never rejects). The cancel + #1065 marker
   * stay synchronous, but the row DELETE is deferred until the outcome
   * resolves true: deleting concurrently with the in-flight IPC destroyed
   * both copies of the typed text when the save failed (store rollback +
   * hard row DELETE, nothing left for boot-time `flush_all_drafts`). On
   * failure the row is kept and the exact failed content is re-saved so
   * recovery works even when no debounce tick ever wrote a row.
   */
  const discardDraftFor = (
    id: string,
    saveOutcome?: Promise<boolean | void>,
    failedContent?: string,
  ) => {
    versionRef.current++ // invalidate any pending save
    if (timerRef.current) clearTimeout(timerRef.current)
    pendingSinceRef.current = null
    // #1065 — mark this block discarded so Effect B's cleanup skips the
    // flush even if an unmount coincides with blur (blockIdRef still set).
    discardedRef.current.add(id)
    if (!saveOutcome) {
      retryOnPoolBusy(() => commands.deleteDraft(id).then(unwrap)).catch((err: unknown) => {
        logger.warn('useDraftAutosave', 'deleteDraft failed during discard', { blockId: id }, err)
      })
      return
    }
    const capturedVersion = versionRef.current
    void saveOutcome
      .catch((err: unknown) => {
        // Store actions resolve false rather than reject; treat an escaped
        // rejection as a failed save (keep the row — the safe direction).
        logger.warn(
          'useDraftAutosave',
          'save outcome rejected during discard',
          { blockId: id },
          err,
        )
        return false as const
      })
      .then((ok) => {
        // Newer activity (a fresh debounced save after a refocus) supersedes
        // this discard — deleting now could destroy the newer draft row.
        if (versionRef.current !== capturedVersion) return
        if (ok === false) {
          logger.warn('useDraftAutosave', 'save failed — keeping draft row for recovery', {
            blockId: id,
          })
          if (failedContent) {
            retryOnPoolBusy(() => commands.saveDraft(id, failedContent).then(unwrap)).catch(
              (err: unknown) => {
                logger.warn(
                  'useDraftAutosave',
                  'draft re-save after failed save failed',
                  { blockId: id },
                  err,
                )
              },
            )
          }
          return
        }
        retryOnPoolBusy(() => commands.deleteDraft(id).then(unwrap)).catch((err: unknown) => {
          logger.warn('useDraftAutosave', 'deleteDraft failed during discard', { blockId: id }, err)
        })
      })
  }
  // Mirror `discardDraftFor` into a ref so the memoized `onContentChange` can
  // call the latest version without listing it as a dep (which would churn its
  // identity every render and force EditableBlock to re-register the signal).
  // `discardDraftFor` only touches refs + stable imports, so this is safe.
  const discardDraftForRef = useRef(discardDraftFor)
  discardDraftForRef.current = discardDraftFor

  // #2938 — the debounced-saveDraft driver, formerly "Effect A" (keyed on
  // `[blockId, content]`), is now imperative: `onContentChange` is called from
  // the editor's `update` change SIGNAL (via EditableBlock) on every keystroke.
  // It only (re)arms a timer — NO per-keystroke serialize, NO React commit. The
  // actual markdown is serialized ON DEMAND (`readLive`) when the timer fires.
  //
  // It must never flush: flushing here would fire one write-lock-acquiring
  // `flush_draft` IPC per keystroke (#715).
  const onContentChange = useCallback(() => {
    const id = blockIdRef.current
    if (!id) return

    // #770 gap 3 — emptying a block's text must NOT leave the previous draft
    // row behind (a hard kill would resurrect it as old text at boot via
    // `flush_all_drafts` → `edit_block`). Detect the clear via the CHEAP
    // structural `isEditorEmpty` check (no serialize) so this stays off the
    // per-keystroke hot path.
    if (isEditorEmpty()) {
      // Discard ONLY on a genuine clear: this block was observed non-empty and
      // is now empty. A block that merely STARTED empty (fresh focus / refocus,
      // or a switch landing on an empty block) must not discard — there is no
      // user-authored row to drop, and firing a discard there would set the
      // #1065 marker and wrongly suppress a later unmount flush (regressing
      // #715's refocus test). `discardDraftFor` cancels the pending timer and
      // resets the max-latency clock.
      if (hadContentRef.current) {
        hadContentRef.current = false
        discardDraftForRef.current(id)
      } else {
        // Nothing to persist; drop any pending save for the now-empty block.
        if (timerRef.current) clearTimeout(timerRef.current)
        pendingSinceRef.current = null
      }
      return
    }
    hadContentRef.current = true

    const capturedVersion = ++versionRef.current

    // Max-latency cap: a trailing debounce alone never fires during
    // continuous typing (every keystroke resets it). Once a save has been
    // pending longer than DRAFT_MAX_LATENCY_MS, fire immediately instead of
    // re-arming — so a webview kill mid-run loses at most the cap window.
    if (pendingSinceRef.current === null) pendingSinceRef.current = Date.now()
    const overdue = Date.now() - pendingSinceRef.current >= DRAFT_MAX_LATENCY_MS

    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(
      () => {
        if (versionRef.current !== capturedVersion) return // stale — discardDraft was called
        pendingSinceRef.current = null
        // #2938 — serialize the live editor at FIRE time. Guard block identity:
        // if the roving editor switched away between arming and firing, the
        // live doc holds another block's content — skip rather than persist it
        // under `id` (blur/persistUnmount own the outgoing block's save).
        const re = rovingEditorRef.current
        if (!re || re.activeBlockId !== id) return
        const md = readLive()
        if (!md) return
        // #1065 — a genuine fresh save for this block clears any prior
        // "discarded" marker so a real edit made after a discard can flush.
        discardedRef.current.delete(id)
        retryOnPoolBusy(() => commands.saveDraft(id, md).then(unwrap), {
          onRetry: (attempt) => {
            logger.debug('useDraftAutosave', 'retrying saveDraft (pool_busy)', {
              blockId: id,
              attempt,
            })
          },
        }).catch((err: unknown) => {
          // After exhausting the pool_busy retries the helper bubbles the
          // last error untouched, so `database` / exhausted `pool_busy`
          // both land here. Keep the existing log-only behaviour (autosave
          // is best-effort; the user retries by typing one more char).
          const label = isPoolBusy(err)
            ? 'saveDraft exhausted pool_busy retries'
            : 'saveDraft failed'
          logger.warn('useDraftAutosave', label, { blockId: id }, err)
        })
      },
      overdue ? 0 : DRAFT_DEBOUNCE_MS,
    )
  }, [isEditorEmpty, readLive, rovingEditorRef])

  // #2938 — per-block reset. A block change (or unmount) starts a fresh typing
  // run for the max-latency cap and clear-detection, and cancels any pending
  // debounce so it never fires against a superseded block. (Formerly folded
  // into Effect A's per-render bookkeeping + cleanup.)
  useEffect(() => {
    pendingSinceRef.current = null
    hadContentRef.current = false
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [blockId])

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
      // `blockId`). #2938 — on a block switch the roving editor has ALREADY
      // re-mounted the NEW block, so serializing it here (`readLive()`) would
      // yield the NEW block's text and corrupt the OLD block's row (flushing it
      // as `edit_block(oldBlock, newBlockText)`). The block-switch path's flush
      // must therefore read the existing stored row untouched — the editor
      // content for the old block was already persisted by
      // `useEditorBlur`/`persistUnmount`'s `edit_block` on the way out. We only
      // do the final live-serialize save when `blockIdRef.current === blockId`
      // (the unmount path), where the editor genuinely still holds this block's
      // latest content.
      //
      // On the unmount path the debounced `saveDraft` row may be up to ~2 s
      // behind the editor, so we persist the LATEST live content AND ensure it
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
      // #2938 — the "latest live content" is now serialized ON DEMAND from the
      // roving editor at THIS cleanup moment (children unmount before their
      // ancestor that owns `useEditor`, so the editor is still alive here),
      // rather than read from a per-frame mirrored ref. Restricted to the
      // unmount-while-focused path (`blockIdRef.current === blockId`): there the
      // editor still holds THIS block's document. On a block switch `blockIdRef`
      // has already advanced and the editor may hold the NEW block's doc, so we
      // must flush the OLD block's stored row untouched (reading the live editor
      // would corrupt it as `edit_block(oldBlock, newBlockText)`).
      //
      // Empty content is handled by `onContentChange`'s discard path (#770 gap
      // 3) — which sets the discarded marker, so we never reach here with empty
      // content for that block (and `readLive()` returning '' also short-circuits
      // the save below).
      const isUnmountWhileFocused = blockIdRef.current === blockId
      const latest = isUnmountWhileFocused ? readLive() : ''
      const ensureSaved = latest
        ? retryOnPoolBusy(() => commands.saveDraft(blockId, latest).then(unwrap)).catch(
            (err: unknown) => {
              logger.warn(
                'useDraftAutosave',
                'final saveDraft before flush failed',
                { blockId },
                err,
              )
            },
          )
        : Promise.resolve()
      void ensureSaved.then(() =>
        retryOnPoolBusy(() => commands.flushDraft(blockId).then(unwrap)).catch((err: unknown) => {
          logger.warn('useDraftAutosave', 'flushDraft failed', { blockId }, err)
        }),
      )
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- #715/#770 gap 2: keyed on `blockId` ALONE so content changes can never re-trigger the flush. `readLive` is referentially stable (memoized on the stable `rovingEditorRef`), so listing it would not change re-run behavior; it is serialized on demand at cleanup time.
  }, [blockId])

  // Effect C — background/close flush of the live content. The debounced
  // draft row is the ONLY crash/kill safety net, and a trailing debounce
  // means it can be missing (continuous typing — Effect A's cleanup resets
  // the timer on every keystroke) or ~2s stale at the moment the OS
  // backgrounds-then-kills the webview (mobile) or the window is torn down.
  // While a block is focused, persist the latest live content the moment the
  // page is hidden (visibilitychange) or unloading (pagehide) so boot-time
  // `flush_all_drafts` can recover it. Fire-and-forget: the process may die
  // at any moment, and the IPC completes on the Rust side once dispatched.
  useEffect(() => {
    if (!blockId) return
    const persistLatest = () => {
      // #2938 — serialize the live editor ON DEMAND at the moment the page is
      // hidden / unloading. Guard block identity: only persist when the roving
      // editor is still mounted on THIS block, otherwise the live document
      // belongs to another block and would be saved under the wrong id.
      const re = rovingEditorRef.current
      if (!re || re.activeBlockId !== blockId) return
      const latest = readLive()
      if (!latest) return
      retryOnPoolBusy(() => commands.saveDraft(blockId, latest).then(unwrap)).catch(
        (err: unknown) => {
          logger.warn('useDraftAutosave', 'background flush saveDraft failed', { blockId }, err)
        },
      )
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persistLatest()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', persistLatest)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', persistLatest)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- keyed on `blockId` ALONE; `rovingEditorRef` (stable ref) and `readLive` (memoized on it) are read on demand inside `persistLatest` and are referentially stable, so listing them would not change re-run behavior.
  }, [blockId])

  /**
   * Call after a normal save to discard the draft without flushing. Pass the
   * save's outcome promise (and the content it saved) to defer the row
   * DELETE until the save committed — see {@link discardDraftFor}.
   */
  const discardDraft = (saveOutcome?: Promise<boolean | void>, failedContent?: string) => {
    if (blockIdRef.current) discardDraftFor(blockIdRef.current, saveOutcome, failedContent)
  }

  return { discardDraft, onContentChange }
}
