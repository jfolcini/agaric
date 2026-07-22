/**
 * useDebouncedContentCommit — #2600
 *
 * Commit the focused block's content to the op log on a short IDLE DEBOUNCE
 * (in addition to blur), so concurrent edits to *different regions* of the
 * same block interleave through the `LoroText` char-CRDT and merge — instead
 * of the whole in-session window collapsing to the documented block-granularity
 * "later blur wins" boundary. The gap #2600 closes is commit CADENCE, not
 * engine capability: the engine already applies each `edit_block` op as a
 * character-level diff-splice.
 *
 * The commit dispatches the SAME `edit(blockId, markdown)` store action blur
 * uses, so there is **no data-model change** (invariant-safe).
 *
 * ## Selection safety
 *
 * The roving editor is uncontrolled after mount: a store `content` change never
 * re-feeds it (EditableBlock's mount effect keys on `[isFocused, blockId]`, not
 * on `content`), so this commit re-renders the wrapper but leaves the
 * ProseMirror document and caret untouched. And it fires from a timer, NOT
 * synchronously inside a ProseMirror `dispatch`, so it cannot trip the #1489
 * "setState inside dispatch → DOMObserver → dispatch" re-render loop.
 *
 * ## No double-commit
 *
 * After a DURABLE commit it rebases the editor's delta baseline via
 * `markCommitted(md)`, so the eventual blur `unmount()` and the next debounce
 * tick compute their delta against the committed text. Without this, blur would
 * re-serialize the whole block against the mount-time baseline and commit a
 * redundant duplicate op (and a duplicate undo entry).
 *
 * The rebase happens ONLY on success, never optimistically: if the commit fails
 * (or the block is blurred while the IPC is in flight), the baseline is left
 * untouched so the blur `unmount()` still sees a delta and re-commits the text —
 * the tail typing is never lost. The cost is a benign duplicate near-empty op in
 * the rare in-flight-blur window (its diff-splice is empty; the undo entry
 * coalesces by block key).
 *
 * ## Undo granularity
 *
 * Each commit is one `edit_block` op. The `edit` reducer threads a per-block
 * coalesce key into the undo store so a block's debounced commits + its final
 * blur commit fold into ONE undo entry — Ctrl+Z still reverts a block edit as a
 * single action (no undo regression). See `page-blocks-reducers.ts` +
 * `undo.ts`.
 *
 * ## Op-log volume
 *
 * The trailing debounce collapses a typing burst into at most one op per idle
 * pause; the backend diff-splice keeps each op's payload minimal.
 *
 * ## Export flush (#2969)
 *
 * While focused, this hook registers its commit as an awaitable "flush now"
 * callback in `active-draft-flush.ts` — the minimal bridge that lets export
 * entry points outside the editor's component subtree (PageHeader's
 * copy-to-clipboard export, `exportGraphAsZip`) force the focused block's
 * pending debounced content out before reading a page's markdown. See that
 * module's doc comment for the scope note (content-commit path only, not
 * checkbox/split/property — those stay blur-only).
 */

import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { registerActiveDraftFlush } from '@/lib/active-draft-flush'
import { parseInlineProperties } from '@/lib/inline-property-parse'
import { logger } from '@/lib/logger'

/** Trailing idle-debounce window (ms) before a mid-typing content commit. */
export const CONTENT_COMMIT_DEBOUNCE_MS = 700

export function useDebouncedContentCommit(params: {
  isFocused: boolean
  blockId: string
  rovingEditorRef: RefObject<RovingEditorHandle>
  edit: (blockId: string, content: string) => Promise<boolean>
}): {
  /**
   * #2938 — (re)arm the trailing content-commit debounce. Called from the
   * editor's `update` change signal (via EditableBlock) on every keystroke.
   * Cheap: it only resets a timer — no serialize, no React state. The commit
   * re-reads the authoritative markdown from the live editor at fire time.
   */
  schedule: () => void
} {
  const { isFocused, blockId, rovingEditorRef, edit } = params
  // Read the latest `isFocused` inside the identity-stable `schedule` without
  // rebuilding it every render (which would churn EditableBlock's registration).
  const isFocusedRef = useRef(isFocused)
  isFocusedRef.current = isFocused

  // Extracted so both the debounce timer AND the export "flush now" bridge
  // (#2969) share exactly one commit implementation.
  const commitNow = useCallback(async (): Promise<void> => {
    const re = rovingEditorRef.current
    // Stale-fire guard: the active block may have switched between schedule
    // and fire (block→block focus move).
    if (!re || re.activeBlockId !== blockId) return
    const md = re.getMarkdown()
    if (md === null) return
    // Nothing new since the last commit (or since mount) — skip.
    if (md === re.originalMarkdown) return
    // #2675 — defer to the flush parser while the block contains inline
    // `key:: value` property lines. The save-time parser in `useBlockFlush`
    // only runs when blur's `unmount()` reports a delta; committing here would
    // rebase the baseline (`markCommitted`) so a user who pauses >the debounce
    // window before blurring would get a null delta at flush and the property
    // line would silently stay literal with nothing written. Skipping keeps
    // the baseline unrebased — blur re-commits through the property-aware
    // flush path. Cost: mid-typing CRDT commits pause only while a parseable
    // property line is present in the block.
    if (parseInlineProperties(md).length > 0) return

    try {
      const ok = await edit(blockId, md)
      // Rebase the delta baseline ONLY after a durable commit, and only if
      // the editor is still mounted on this block. On failure — or if the
      // block was blurred while the IPC was in flight — leave the baseline
      // untouched so the blur `unmount()` re-commits `md` (the tail is never
      // lost); the worst case is a benign duplicate near-empty op.
      if (!ok) return
      const cur = rovingEditorRef.current
      if (cur && cur.activeBlockId === blockId) cur.markCommitted(md)
    } catch (err) {
      logger.warn('editor', 'debounced content commit failed', { blockId }, err)
    }
  }, [blockId, edit, rovingEditorRef])

  const debounced = useDebouncedCallback(() => {
    void commitNow()
  }, CONTENT_COMMIT_DEBOUNCE_MS)

  // #2938 — the change signal arms the trailing debounce imperatively (no
  // React state, no per-keystroke serialize). The value passed to `schedule`
  // is unused: `commitNow` re-reads the authoritative markdown from the live
  // editor at fire time. `debounced.schedule` resets the timer internally, so
  // a typing burst collapses into ONE trailing commit per idle pause.
  const schedule = useCallback(() => {
    // Ignore stray signals while unfocused: the blur handler's unmount-commit
    // owns any tail typing, and the effect below has already cancelled the timer.
    if (!isFocusedRef.current) return
    debounced.schedule('')
  }, [debounced])

  useEffect(() => {
    if (!isFocused) {
      // Blur (isFocused → false) cancels the pending tick; the blur handler's
      // own unmount-commit covers any tail typed since the last tick.
      debounced.cancel()
      return
    }
    // #2969 — expose "flush this block's pending debounced commit right now"
    // to export entry points outside the editor's component subtree. Cancel
    // the pending timer first so a stale trailing tick can't race the
    // immediate commit and re-send stale content afterward.
    return registerActiveDraftFlush(blockId, async () => {
      debounced.cancel()
      await commitNow()
    })
  }, [isFocused, blockId, debounced, commitNow])

  return { schedule }
}
