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
 *   5. Otherwise saves the changed content via `edit`.
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

import { notify } from '@/lib/notify'

import { parse } from '../../editor/markdown-serializer'
import type { RovingEditorHandle } from '../../editor/use-roving-editor'
import { processCheckboxSyntax } from '../../lib/block-utils'
import { logger } from '../../lib/logger'
import { setTodoState as setTodoStateCmd } from '../../lib/tauri'
import type { usePageBlockStoreApi } from '../../stores/page-blocks'
import { useUndoStore } from '../../stores/undo'

type TFn = TFunction

export interface UseBlockFlushParams {
  /** Ref to the latest editor handle. Populated by BlockTree after
   *  `useRovingEditor` is created. May be null on first render. */
  rovingEditorRef: RefObject<RovingEditorHandle | null>
  /** Store action: persist a content edit for a single block. */
  edit: (blockId: string, content: string) => void
  /** Store action: split a single block into multiple at the given content. */
  splitBlock: (blockId: string, content: string) => void
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
        splitBlock(blockId, changed)
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
          void (async () => {
            try {
              const echo = await setTodoStateCmd(blockId, todoState)
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
          edit(blockId, changed)
        }
      }
    }
    return changed
  }, [edit, splitBlock, rootParentId, t, pageStore, rovingEditorRef])
}
