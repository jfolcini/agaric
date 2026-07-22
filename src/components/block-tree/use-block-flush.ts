/**
 * useBlockFlush — owns the "flush in-flight editor changes" callback.
 *
 * Extracted from BlockTree.tsx as part of the Phase 3 structural carve-out.
 * The callback:
 *
 *   1. Reads the currently-active editor handle via `rovingEditorRef`.
 *   2. Unmounts it (captures the latest content via `handle.unmount()`).
 *   3. If the content parses to a multi-block document (e.g. pasted markdown
 *      with headings, code blocks, or list items) — splits via `splitBlock`.
 *   4. Otherwise checks for inline checkbox markdown (`[ ]` / `[x]`); when
 *      present, persists the todo state via the thin command and saves the
 *      cleaned content.
 *   5. Otherwise parses inline `key:: value` property lines (#2675 — the
 *      `::` picker's documented "pick a key, type its value, it commits"
 *      flow). Each parsed property is written via the typed property API and
 *      its line is stripped from the committed content ONLY after the write
 *      succeeds; a rejected write leaves the line literal so nothing is lost.
 *   6. Otherwise saves the changed content via `edit`.
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

import { parse } from '@/editor/markdown-serializer'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { processCheckboxSyntax } from '@/lib/block-utils'
import { bumpFlushSeq, commitInlineProperties, readFlushSeq } from '@/lib/inline-property-commit'
import { parseInlineProperties } from '@/lib/inline-property-parse'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { setTodoState as setTodoStateCmd } from '@/lib/tauri'
import type { usePageBlockStoreApi } from '@/stores/page-blocks'
import { useUndoStore } from '@/stores/undo'

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
  /** i18n translator. */
  t: TFn
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
  t,
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
      // Use the parser to detect multi-block content (headings, code blocks, etc.)
      // A single code block or heading with newlines should NOT split.
      const doc = parse(changed)
      const blockCount = doc.content?.length ?? 0
      if (blockCount > 1) {
        // Invalidate any in-flight async flush (checkbox/property) on this
        // block: this sync commit is newer and owns the final content, so a
        // late-resolving stale run must bail instead of clobbering the split.
        bumpFlushSeq(blockId)
        // #2914 — snapshot the pre-split block ids so, once the split resolves,
        // the trailing blocks it created (the only new ids) are identifiable;
        // publish the in-flight split + its last-created block for
        // `handleEnterSave` to await instead of racing a parallel createBelow.
        const beforeIds = new Set(pageStore.getState().blocks.map((b) => b.id))
        setPendingSplit(
          blockId,
          splitBlock(blockId, changed).then((ok) => {
            if (!ok) return null
            let lastNew: string | null = null
            for (const b of pageStore.getState().blocks) {
              if (!beforeIds.has(b.id)) lastNew = b.id
            }
            return lastNew
          }),
        )
      } else {
        // Check for checkbox markdown syntax before saving
        const { cleanContent, todoState } = processCheckboxSyntax(changed)
        if (todoState) {
          // #1074 — coordinate the two effects. Previously this fired
          // `set_todo_state` and, regardless of its outcome, optimistically
          // wrote `todo_state` (with no rollback) AND stripped the marker via
          // `edit(blockId, cleanContent)`. On a rejected state write that left
          // the task state silently and unrecoverably lost (marker gone, state
          // never committed). Now we AWAIT the state write and only strip the
          // marker + apply the optimistic `todo_state` AFTER it resolves; on
          // rejection we keep the marker (persist `changed`, not `cleanContent`)
          // so the box stays re-parseable, and write no optimistic state. The
          // callback stays sync (`() => string | null`) via this fire-and-track
          // async IIFE — mirroring the store's own async/rollback idioms.
          // #1591 — guard against a rapid second flush on the same block
          // clobbering this one. Bump + capture the block's token now; the
          // post-await re-check bails if a newer flush superseded this run.
          const mySeq = bumpFlushSeq(blockId)
          void (async () => {
            try {
              const echo = await setTodoStateCmd(blockId, todoState)
              // A newer flush on this block superseded us while the IPC was in
              // flight — bail without applying so we don't clobber it. The
              // newer run owns the block's final content + todo_state.
              if (readFlushSeq(blockId) !== mySeq) return
              // Adopt the backend echo for `todo_state` the way `edit()` adopts
              // the content echo (#753): the optimistic write below records the
              // state we SENT; prefer the canonical value the backend returned
              // to avoid drift. Fall back to the sent state if the echo omits it.
              const settledState =
                typeof echo?.todo_state === 'string' ? echo.todo_state : todoState
              pageStore.setState((s) => ({
                blocks: s.blocks.map((b) =>
                  b.id === blockId ? { ...b, todo_state: settledState } : b,
                ),
              }))
              // Strip the marker only now that the state is committed.
              edit(blockId, cleanContent)
              if (rootParentId) useUndoStore.getState().onNewAction(rootParentId)
            } catch (err: unknown) {
              // A newer flush on this block superseded us — don't clobber it
              // with this stale run's raw content, but still surface the error.
              if (readFlushSeq(blockId) !== mySeq) {
                logger.error(
                  'BlockTree',
                  'Failed to set task state from checkbox syntax (superseded)',
                  { blockId },
                  err,
                )
                notify.error(t('blockTree.setTaskStateFailed'))
                return
              }
              // State write failed — do NOT strip the marker. Persist the raw
              // content (with the `- [ ] `/`- [x] ` marker intact) so the task
              // state stays recoverable, and write no optimistic `todo_state`
              // (nothing to roll back since we deferred it past the await).
              edit(blockId, changed)
              logger.error(
                'BlockTree',
                'Failed to set task state from checkbox syntax',
                {
                  blockId,
                },
                err,
              )
              notify.error(t('blockTree.setTaskStateFailed'))
            }
          })()
        } else {
          // #2675 — inline `key:: value` property lines. Parse per the
          // import.rs rules (valid key alphabet, non-empty value, reserved
          // keys skipped, code fences ignored — see inline-property-parse.ts)
          // and commit each parsed property via the typed property API in
          // `commitInlineProperties` (shared with the blur / programmatic
          // unmount save paths). A property line is stripped from the
          // committed content ONLY after its write succeeds; a rejected write
          // (select-membership, unparseable number, backend error, …) leaves
          // the line literal so the typed text is never lost. Same
          // fire-and-track async + sequence-token guard as the checkbox path.
          const inlineProps = parseInlineProperties(changed)
          if (inlineProps.length > 0) {
            const mySeq = bumpFlushSeq(blockId)
            void commitInlineProperties({
              blockId,
              content: changed,
              inlineProps,
              mySeq,
              edit,
              rootParentId,
            })
          } else {
            // Invalidate any in-flight async flush (checkbox/property) on
            // this block — same reasoning as the split branch above: without
            // the bump, a stale run's post-await `edit()` would clobber this
            // newer sync commit (blur → quick refocus → retype → blur race).
            bumpFlushSeq(blockId)
            edit(blockId, changed)
          }
        }
      }
    }
    return changed
  }, [edit, splitBlock, rootParentId, t, pageStore, rovingEditorRef])
}
