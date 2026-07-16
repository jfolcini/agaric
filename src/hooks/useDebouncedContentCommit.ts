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
 */

import { useEffect } from 'react'
import type { RefObject } from 'react'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { logger } from '@/lib/logger'

/** Trailing idle-debounce window (ms) before a mid-typing content commit. */
export const CONTENT_COMMIT_DEBOUNCE_MS = 700

export function useDebouncedContentCommit(params: {
  isFocused: boolean
  blockId: string
  /**
   * The rAF-coalesced live markdown from EditableBlock; used only as the
   * change SIGNAL that reschedules the debounce. The commit re-reads the
   * authoritative markdown from the editor at fire time.
   */
  liveContent: string
  rovingEditorRef: RefObject<RovingEditorHandle>
  edit: (blockId: string, content: string) => Promise<boolean>
}): void {
  const { isFocused, blockId, liveContent, rovingEditorRef, edit } = params

  const debounced = useDebouncedCallback(() => {
    const re = rovingEditorRef.current
    // Stale-fire guard: the active block may have switched between schedule
    // and fire (block→block focus move).
    if (!re || re.activeBlockId !== blockId) return
    const md = re.getMarkdown()
    if (md === null) return
    // Nothing new since the last commit (or since mount) — skip.
    if (md === re.originalMarkdown) return

    edit(blockId, md)
      .then((ok) => {
        // Rebase the delta baseline ONLY after a durable commit, and only if
        // the editor is still mounted on this block. On failure — or if the
        // block was blurred while the IPC was in flight — leave the baseline
        // untouched so the blur `unmount()` re-commits `md` (the tail is never
        // lost); the worst case is a benign duplicate near-empty op.
        if (!ok) return
        const cur = rovingEditorRef.current
        if (cur && cur.activeBlockId === blockId) cur.markCommitted(md)
      })
      .catch((err) => {
        logger.warn('editor', 'debounced content commit failed', { blockId }, err)
      })
  }, CONTENT_COMMIT_DEBOUNCE_MS)

  useEffect(() => {
    if (!isFocused) {
      // Blur (isFocused → false) cancels the pending tick; the blur handler's
      // own unmount-commit covers any tail typed since the last tick.
      debounced.cancel()
      return
    }
    // Reschedule on every liveContent change while focused. `schedule` resets
    // the timer internally, so a typing burst collapses into ONE trailing
    // commit per idle pause. (Deliberately no cleanup-cancel: cancelling on
    // each keystroke-driven change would defeat the trailing debounce.)
    debounced.schedule(liveContent)
  }, [isFocused, blockId, liveContent, debounced])
}
