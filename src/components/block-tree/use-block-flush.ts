/**
 * useBlockFlush — owns the "flush in-flight editor changes" callback.
 *
 * Extracted from BlockTree.tsx as part of the Phase 3 structural carve-out.
 * The callback:
 *
 *   1. Reads the currently-active editor handle via `rovingEditorRef`.
 *   2. Unmounts it (captures the latest content via `handle.unmount()`).
 *   3. Runs the shared post-unmount decision chain (`runUnmountFlush`, #3278):
 *      split (multi-block content) → checkbox marker fold → inline
 *      `key:: value` properties → plain edit. This chain is SHARED with
 *      `useEditorBlur` Step 5 and `persistUnmount` in EditableBlock so a
 *      block's content is classified identically regardless of which of the
 *      three unmount triggers fired.
 *   4. On the split branch, publishes the in-flight split (#2914
 *      `pendingSplits`) so `handleEnterSave` can await it instead of racing
 *      a parallel `createBelow`.
 *
 * The hook is intentionally thin (a single `useCallback`) and the returned
 * function preserves the previous `() => string | null` signature so the
 * many consumers in BlockTree (DnD, keyboard, zoom-change effect, container
 * pointer-down, etc.) stay drop-in.
 *
 * Why a hook rather than a free function?
 *   The body reads from a mutable `rovingEditorRef` and calls store actions
 *   (`edit`, `splitBlock`) that originate from a closure over the per-page
 *   store. Keeping the `useCallback` here means BlockTree no longer has to
 *   declare its dependency array inline — and any future addition of a new
 *   side effect (logging, telemetry, etc.) lives next to the rest of the
 *   flush logic.
 */

import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import { useCallback } from 'react'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { runUnmountFlush } from '@/lib/unmount-flush'
import type { usePageBlockStoreApi } from '@/stores/page-blocks'

type TFn = TFunction

// #2914 — cross-callback handoff of an in-flight multi-block split.
//
// When `handleFlush` takes the SPLIT path it fires `splitBlock`, which is
// async and creates the trailing sibling blocks via its own chained
// `createBelow` calls. `handleEnterSave` used to fire that split UNAWAITED and
// then immediately `createBelow()` an empty Enter block — two sibling-creation
// sequences racing on overlapping pre-await snapshots (each computed
// `siblingSlot` from its own stale view). `splitInProgress` only guards
// re-entrant `splitBlock`, not the concurrent `createBelow`.
//
// This module-level registry (keyed by block id, mirroring the `bumpFlushSeq`/
// `readFlushSeq` flush-token coordination in inline-property-commit.ts) lets
// `handleFlush` publish the in-flight split so `handleEnterSave` can AWAIT it
// and focus the last block it produced, instead of racing a parallel create.
// The published promise resolves to the id of the LAST block the split created
// (for focus placement), or `null` if the split failed.
const pendingSplits = new Map<string, Promise<string | null>>()

function setPendingSplit(blockId: string, promise: Promise<string | null>): void {
  pendingSplits.set(blockId, promise)
  // Self-clean once the split settles so a flush NOT driven by Enter (blur,
  // indent, DnD — nobody consumes) can't strand a stale entry that a later
  // Enter on the same block would await. Guard on identity so a newer split
  // that replaced this entry is not clobbered.
  void promise.finally(() => {
    if (pendingSplits.get(blockId) === promise) pendingSplits.delete(blockId)
  })
}

/**
 * Consume (and remove) the in-flight split published for `blockId` by the most
 * recent `handleFlush` SPLIT path, or `null` if the last flush did not split.
 * `handleEnterSave` calls this synchronously right after `handleFlush()` and,
 * when non-null, awaits it (and focuses the resolved last-created block)
 * instead of racing its own `createBelow` — see #2914.
 */
export function consumePendingSplit(blockId: string): Promise<string | null> | null {
  const promise = pendingSplits.get(blockId)
  if (promise === undefined) return null
  pendingSplits.delete(blockId)
  return promise
}

export interface UseBlockFlushParams {
  /** Ref to the latest editor handle. Populated by BlockTree after
   *  `useRovingEditor` is created. May be null on first render. */
  rovingEditorRef: RefObject<RovingEditorHandle | null>
  /** Store action: persist a content edit for a single block. */
  edit: (blockId: string, content: string) => void
  /**
   * Store action: split a single block into multiple at the given content.
   * Resolves `true` only when the split fully committed (see the reducer's
   * resolve-`false` contract). #2914 — the returned promise is what
   * `handleEnterSave` awaits via `consumePendingSplit` so it does not race a
   * parallel `createBelow` against the split's own createBelow chain.
   */
  splitBlock: (blockId: string, content: string) => Promise<boolean>
  /** Current page root parent — used to nudge the undo log on todo flips. */
  rootParentId: string | null
  /** Page store API (used to write the optimistic `todo_state` update). */
  pageStore: ReturnType<typeof usePageBlockStoreApi>
  /**
   * i18n translator.
   *
   * @deprecated Unused since #3278. The checkbox-fold error toast moved into
   * the shared `commitCheckboxState` (inline-property-commit.ts), which — like
   * its sibling `commitInlineProperties` — reaches for the `i18n` singleton
   * rather than an injected translator, because the shared chain is called
   * from non-React code paths too. Production text is unchanged: BlockTree's
   * `t` comes from a default-namespace `useTranslation()` on the same `i18n`
   * instance. Kept (optional) only so BlockTree's call site does not have to
   * change in this refactor; drop both together in a follow-up.
   */
  t?: TFn
}

/**
 * Returns the stable `handleFlush` callback. Mirrors the previous inline
 * implementation 1:1 — see the file-level docstring for the algorithm.
 */
export function useBlockFlush({
  rovingEditorRef,
  edit,
  splitBlock,
  rootParentId,
  pageStore,
}: UseBlockFlushParams): () => string | null {
  // Per-block sequence token — `bumpFlushSeq` / `readFlushSeq` from
  // inline-property-commit.ts. Each flush that takes a detached async path
  // (checkbox #1591, inline properties #2675) bumps the block's token before
  // awaiting the IPC. After the await, the async run re-reads the token: if a
  // newer flush on the SAME block has bumped it in the meantime, the stale run
  // bails BEFORE touching the store or calling `edit()`, so a late-resolving
  // edit cannot clobber a newer one. SHARED across the checkbox and property
  // paths (mutual supersession) AND with the blur/programmatic-unmount save
  // paths in EditableBlock/useEditorBlur, which commit the same blocks — see
  // the inline-property-commit module docstring.

  return useCallback((): string | null => {
    const handle = rovingEditorRef.current
    if (!handle?.activeBlockId) return null
    const blockId = handle.activeBlockId // capture BEFORE unmount nullifies it
    const changed = handle.unmount()
    if (changed !== null) {
      // #2914 — snapshot the pre-split block ids right before `splitBlock`
      // lands, so the trailing blocks it creates (the only new ids) are
      // identifiable once it resolves.
      let beforeIds = new Set<string>()
      const result = runUnmountFlush({
        blockId,
        changed,
        edit,
        splitBlock,
        rootParentId,
        pageStore,
        onWillSplit: () => {
          beforeIds = new Set(pageStore.getState().blocks.map((b) => b.id))
        },
      })
      if (result.kind === 'split') {
        // Publish the in-flight split + its last-created block for
        // `handleEnterSave` (via `consumePendingSplit`) to await instead of
        // racing a parallel createBelow.
        setPendingSplit(
          blockId,
          Promise.resolve(result.outcome).then((ok) => {
            if (!ok) return null
            let lastNew: string | null = null
            for (const b of pageStore.getState().blocks) {
              if (!beforeIds.has(b.id)) lastNew = b.id
            }
            return lastNew
          }),
        )
      }
    }
    return changed
  }, [edit, splitBlock, rootParentId, pageStore, rovingEditorRef])
}
